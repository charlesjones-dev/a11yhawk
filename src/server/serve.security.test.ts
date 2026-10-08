/**
 * Security regression tests for `a11yhawk serve`, exercised in-process: the node:http
 * request listener is invoked directly with stream-backed fake req/res objects. The
 * sanitizers, job store, queue, serializers, and HTML rendering are the real code; the
 * engine and DNS are faked.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLookup = vi.hoisted(() => vi.fn());
vi.mock('dns/promises', () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

import type { ScanOptions, ScanReport } from '../engine/scan.js';
import type { Logger } from '../logger/index.js';
import type { StructuredScanOutput } from '../types.js';
import { createA11yHawkServer } from './serve.js';
import type { A11yHawkServer, A11yHawkServerConfig, EngineFactory } from './serve.js';

const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
  async flush() {},
};

function makeStructured(): StructuredScanOutput {
  return {
    overallScore: 80,
    url: 'https://example.com',
    scanDate: '2026-10-07T00:00:00.000Z',
    standard: 'WCAG 2.1 - AA',
    statistics: {
      totalIssues: 0,
      criticalIssues: 0,
      highIssues: 0,
      mediumIssues: 0,
      lowIssues: 0,
      resolvedIssues: 0,
      unresolvedIssues: 0,
    },
    wcagCoverage: [],
    issues: [],
    passedChecks: [],
    metadata: { pageTitle: 'Example' },
  };
}

function makeReport(overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    structured: makeStructured(),
    markdown: '# report',
    screenshot: FAKE_JPEG,
    annotatedScreenshot: null,
    lighthouse: null,
    usage: null,
    finalUrl: 'https://example.com',
    durationMs: 1234,
    ...overrides,
  };
}

interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface Harness {
  scanCalls: Array<{ url: string; options: ScanOptions }>;
  call(method: string, path: string, body?: unknown): Promise<FakeResponse>;
}

const open: A11yHawkServer[] = [];

function harness(
  scanImpl: (url: string, options: ScanOptions) => Promise<ScanReport>,
  config: Partial<A11yHawkServerConfig> = {},
): Harness {
  const scanCalls: Harness['scanCalls'] = [];
  const factory: EngineFactory = () => ({
    async scan(url, options) {
      scanCalls.push({ url, options });
      return scanImpl(url, options);
    },
    setConcurrency() {},
    async close() {},
  });
  const server = createA11yHawkServer({ engineFactory: factory, logger: silentLogger, ...config });
  open.push(server);
  const listener = server.httpServer.listeners('request')[0] as (req: IncomingMessage, res: ServerResponse) => void;

  return {
    scanCalls,
    call(method, path, body) {
      const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
      const req = Readable.from(raw) as unknown as IncomingMessage;
      Object.assign(req, { method, url: path, headers: { 'content-type': 'application/json' } });
      return new Promise((resolve) => {
        let status = 0;
        let headers: Record<string, string> = {};
        const res: {
          headersSent: boolean;
          writeHead(code: number, h?: Record<string, string | number>): unknown;
          end(chunk?: string | Buffer): void;
        } = {
          headersSent: false,
          writeHead(code, h) {
            status = code;
            headers = Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
            this.headersSent = true;
            return this;
          },
          end(chunk) {
            resolve({ status, headers, body: chunk ? chunk.toString() : '' });
          },
        };
        listener(req, res as unknown as ServerResponse);
      });
    },
  };
}

beforeEach(() => {
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

afterEach(async () => {
  // The server never listened; close() rejects with ERR_SERVER_NOT_RUNNING, which is fine here.
  await Promise.all(open.splice(0).map((s) => s.close().catch(() => undefined)));
});

async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('POST /scans llm.baseUrl guard', () => {
  it('rejects a link-local baseUrl at submission time', async () => {
    const h = harness(async () => makeReport());
    const res = await h.call('POST', '/scans', {
      url: 'https://example.com',
      options: { llm: { apiKey: 'k', baseUrl: 'http://169.254.169.254/latest/meta-data/?' } },
    });
    await settle();

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'invalid-request' } });
    expect(h.scanCalls).toHaveLength(0);
  });

  it('rejects a baseUrl whose hostname resolves to a private address', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    const h = harness(async () => makeReport());
    const res = await h.call('POST', '/scans', {
      url: 'https://example.com',
      options: { llm: { apiKey: 'k', baseUrl: 'https://llm.internal.example/v1' } },
    });

    expect(res.status).toBe(400);
  });

  it('accepts a public baseUrl', async () => {
    const h = harness(async () => makeReport());
    const res = await h.call('POST', '/scans', {
      url: 'https://example.com',
      options: { llm: { apiKey: 'k', baseUrl: 'https://llm.example.com/v1' } },
    });

    expect(res.status).toBe(202);
  });

  it('accepts a private baseUrl when the server allows private networks', async () => {
    const h = harness(async () => makeReport(), { allowPrivateNetworks: true });
    const res = await h.call('POST', '/scans', {
      url: 'https://example.com',
      options: { llm: { apiKey: 'k', baseUrl: 'http://localhost:11434/v1' } },
    });

    expect(res.status).toBe(202);
  });
});

describe('POST /scans queue cap', () => {
  it('answers 503 once 100 scans are waiting', async () => {
    // The engine never completes: two jobs run, the rest queue.
    const h = harness(() => new Promise<ScanReport>(() => {}), { concurrency: 2 });

    const statuses: number[] = [];
    let rejected: FakeResponse | undefined;
    for (let i = 0; i < 110; i += 1) {
      const res = await h.call('POST', '/scans', { url: 'https://example.com' });
      statuses.push(res.status);
      if (res.status !== 202) rejected ??= res;
    }

    expect(statuses.filter((s) => s === 202)).toHaveLength(102);
    expect(rejected?.status).toBe(503);
    expect(JSON.parse(rejected?.body ?? '{}')).toMatchObject({ error: { code: 'queue-full' } });

    const health = JSON.parse((await h.call('GET', '/healthz')).body) as Record<string, unknown>;
    expect(health).toMatchObject({ jobs: { queued: 100, running: 2 }, queueLimit: 100 });
  });
});

describe('GET /scans/:id/report.html', () => {
  const PAYLOAD = '<img src=x onerror="alert(document.domain)">';

  async function renderedReport(): Promise<FakeResponse> {
    const h = harness(async () =>
      makeReport({
        // Typed as number; a hostile provider could still have sent a string.
        usage: {
          promptTokens: PAYLOAD as unknown as number,
          completionTokens: 2,
          totalTokens: 3,
          cost: 0,
          costType: 'user',
          modelId: 'any/model',
        },
      }),
    );
    const created = await h.call('POST', '/scans', { url: 'https://example.com', options: { llm: { apiKey: 'k' } } });
    const { id } = JSON.parse(created.body) as { id: string };
    await settle();
    return h.call('GET', `/scans/${id}/report.html`);
  }

  it('escapes provider usage counters', async () => {
    const res = await renderedReport();

    expect(res.status).toBe(200);
    expect(res.body).not.toContain(PAYLOAD);
  });

  it('is served with a Content-Security-Policy and nosniff', async () => {
    const res = await renderedReport();

    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toMatch(/script-src 'sha256-[A-Za-z0-9+/]+=*'/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
