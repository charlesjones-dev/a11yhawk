import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScanHeader } from '../types.js';
import { PlaywrightService } from './playwright.js';
import { BlockedRequestError } from './request-guard.js';

// Real Chromium is required: A11YHAWK_BROWSER_TEST=1 npx vitest run src/engine/playwright.integration.test.ts
describe.runIf(process.env.A11YHAWK_BROWSER_TEST === '1')('browser connection after long uptime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('connects after the process has been running for more than 2^31 milliseconds', async () => {
    const now = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => now() + 28 * 24 * 60 * 60 * 1000);
    const service = new PlaywrightService();

    try {
      await service.initialize();
      expect(service.getCDPPort()).toBeGreaterThan(0);
    } finally {
      await service.cleanup();
    }
  }, 60_000);
});

interface RecordingServer {
  server: Server;
  port: number;
  /** Request headers received, keyed by request path. */
  requests: Map<string, IncomingHttpHeaders>;
}

async function startServer(handler: (path: string) => { type: string; body: string }): Promise<RecordingServer> {
  const requests = new Map<string, IncomingHttpHeaders>();
  const server = createServer((req, res) => {
    const path = req.url ?? '/';
    requests.set(path, req.headers);
    const { type, body } = handler(path);
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

describe.runIf(process.env.A11YHAWK_BROWSER_TEST === '1')('custom scan headers', () => {
  // The scan target is 127.0.0.1:<port>; the "third party" is localhost:<other port>,
  // a different origin and a different cookie host.
  let target: RecordingServer;
  let thirdParty: RecordingServer;

  const headers: ScanHeader[] = [
    { type: 'authorization', key: 'Authorization', value: 'secret-token' },
    { type: 'header', key: 'X-Api-Key', value: 'secret-key' },
    { type: 'cookie', key: 'session', value: 'secret-session' },
  ];

  function expectNoSecrets(received: IncomingHttpHeaders | undefined): void {
    expect(received).toBeDefined();
    expect(received?.authorization).toBeUndefined();
    expect(received?.['x-api-key']).toBeUndefined();
    expect(received?.cookie ?? '').not.toContain('secret-session');
  }

  beforeAll(async () => {
    thirdParty = await startServer((path) =>
      path.endsWith('.js') ? { type: 'text/javascript', body: '' } : { type: 'text/html', body: '<p>third party</p>' },
    );
    const thirdPartyOrigin = `http://localhost:${thirdParty.port}`;
    target = await startServer((path) =>
      path === '/'
        ? {
            type: 'text/html',
            body: `<!doctype html><html lang="en"><head><title>Header scope</title>
              <script src="${thirdPartyOrigin}/analytics.js"></script></head>
              <body><main><h1>Header scope</h1>
              <script src="/app.js"></script>
              <iframe title="widget" src="${thirdPartyOrigin}/widget"></iframe>
              </main></body></html>`,
          }
        : { type: 'text/javascript', body: '' },
    );
  });

  afterAll(async () => {
    await new Promise((resolve) => target.server.close(resolve));
    await new Promise((resolve) => thirdParty.server.close(resolve));
  });

  it('sends headers and cookies to the scan target only, never to third-party requests', async () => {
    const service = new PlaywrightService({ allowPrivateNetworks: true });
    try {
      await service.analyzePage(
        `http://127.0.0.1:${target.port}/`,
        'test/model',
        undefined,
        undefined,
        headers,
        undefined,
        { captureScreenshot: false },
      );
    } finally {
      await service.cleanup();
    }

    for (const path of ['/', '/app.js']) {
      const received = target.requests.get(path);
      expect(received?.authorization).toBe('Bearer secret-token');
      expect(received?.['x-api-key']).toBe('secret-key');
      expect(received?.cookie).toContain('session=secret-session');
    }

    expectNoSecrets(thirdParty.requests.get('/analytics.js'));
    expectNoSecrets(thirdParty.requests.get('/widget'));
  }, 60_000);

  it('keeps the annotation pass scoped to the original scan origin when the final URL is elsewhere', async () => {
    const service = new PlaywrightService({ allowPrivateNetworks: true });
    try {
      await service.initialize();
      await service.resolveElementBoundingBoxes(
        `http://localhost:${thirdParty.port}/landing`,
        ['p'],
        headers,
        undefined,
        `http://127.0.0.1:${target.port}/`,
      );
    } finally {
      await service.cleanup();
    }

    expectNoSecrets(thirdParty.requests.get('/landing'));
  }, 60_000);

  it('leaves the SSRF request guard in charge when headers are installed', async () => {
    const service = new PlaywrightService();
    try {
      await expect(
        service.analyzePage(
          `http://127.0.0.1:${target.port}/blocked`,
          'test/model',
          undefined,
          undefined,
          headers,
          undefined,
          { captureScreenshot: false },
        ),
      ).rejects.toThrow(BlockedRequestError);
    } finally {
      await service.cleanup();
    }

    expect(target.requests.has('/blocked')).toBe(false);
  }, 60_000);
});
