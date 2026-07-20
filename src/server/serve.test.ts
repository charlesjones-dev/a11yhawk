import { afterEach, describe, expect, it } from 'vitest';

import { ScanError } from '../engine/scan.js';
import type { EngineOptions, ScanOptions, ScanReport } from '../engine/scan.js';
import type { Logger } from '../logger/index.js';
import type { StructuredScanOutput } from '../types.js';
import { createA11yHawkServer } from './serve.js';
import type { A11yHawkServer, A11yHawkServerConfig, EngineFactory } from './serve.js';

// --- fixtures ----------------------------------------------------------------

/** Minimal JPEG magic bytes so the server sniffs image/jpeg for the data URI. */
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

/** No-op logger so a failing scan test does not spam the reporter. */
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
    scanDate: '2026-07-20T00:00:00.000Z',
    standard: 'WCAG 2.1 - AA',
    statistics: {
      totalIssues: 1,
      criticalIssues: 0,
      highIssues: 1,
      mediumIssues: 0,
      lowIssues: 0,
      resolvedIssues: 0,
      unresolvedIssues: 1,
    },
    wcagCoverage: [],
    issues: [
      {
        id: 'issue-1',
        title: 'Form control has no label',
        severity: 'high',
        wcagCriteria: '3.3.2',
        wcagLevel: 'A',
        location: 'form input',
        patternDetected: 'label',
        codeContext: null,
        impact: 'impact',
        userImpact: 'user impact',
        recommendation: 'add a label',
        fixPriority: 'High Priority',
        remediation: 'add <label>',
        resolved: false,
        resolvedAt: null,
        resolvedNote: null,
        resolvedByUserId: null,
        resolvedByDisplayName: null,
      },
    ],
    passedChecks: [],
    metadata: { pageTitle: 'Example' },
  };
}

function makeReport(): ScanReport {
  return {
    structured: makeStructured(),
    markdown: '# report',
    screenshot: FAKE_JPEG,
    annotatedScreenshot: null,
    lighthouse: {
      issues: [],
      summary: {
        totalIssues: 0,
        bySeverity: { critical: 0, serious: 0, moderate: 0, minor: 0 },
        totalElements: 0,
        lighthouseScore: 78,
      },
    },
    usage: null,
    finalUrl: 'https://example.com',
    durationMs: 1234,
  };
}

// --- fake engine + harness ---------------------------------------------------

type ScanImpl = (url: string, options: ScanOptions) => Promise<ScanReport>;

interface FakeEngine {
  factory: EngineFactory;
  engineOptions: EngineOptions | null;
  scanCalls: Array<{ url: string; options: ScanOptions }>;
}

function makeFakeEngine(scanImpl: ScanImpl): FakeEngine {
  const fake: FakeEngine = {
    factory: () => ({ scan, setConcurrency() {}, close }),
    engineOptions: null,
    scanCalls: [],
  };
  async function scan(url: string, options: ScanOptions): Promise<ScanReport> {
    fake.scanCalls.push({ url, options });
    return scanImpl(url, options);
  }
  async function close(): Promise<void> {}
  fake.factory = (opts) => {
    fake.engineOptions = opts;
    return { scan, setConcurrency() {}, close };
  };
  return fake;
}

/** The success path most tests use: emit one progress event, then complete. */
const successScan: ScanImpl = async (_url, options) => {
  options.onProgress?.({ stage: 'capturing', message: 'capturing page', timestamp: Date.now() });
  return makeReport();
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const openServers: A11yHawkServer[] = [];

async function startServer(
  scanImpl: ScanImpl,
  config: Partial<A11yHawkServerConfig> = {},
): Promise<{ base: string; fake: FakeEngine; server: A11yHawkServer }> {
  const fake = makeFakeEngine(scanImpl);
  const server = createA11yHawkServer({ engineFactory: fake.factory, logger: silentLogger, ...config });
  openServers.push(server);
  const { port } = await server.listen(0);
  return { base: `http://127.0.0.1:${port}`, fake, server };
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((s) => s.close()));
});

interface JobResponse {
  id: string;
  status: string;
  createdAt: string;
  progress: Array<{ stage: string; message: string }>;
  report?: {
    structured: StructuredScanOutput;
    screenshot: string | null;
    markdown: string;
  };
  error?: { code: string; message: string; retryable: boolean };
}

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function postScan(base: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}/scans`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) });
}

async function pollUntil(
  base: string,
  id: string,
  predicate: (job: JobResponse) => boolean,
  token?: string,
): Promise<JobResponse> {
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/scans/${id}`, { headers });
    const job = (await res.json()) as JobResponse;
    if (predicate(job)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out polling job ${id}`);
}

// --- tests -------------------------------------------------------------------

describe('createA11yHawkServer', () => {
  it('accepts a scan, runs it, and returns the report with progress events', async () => {
    const { base } = await startServer(successScan);

    const created = await postScan(base, { url: 'https://example.com' });
    expect(created.status).toBe(202);
    const { id } = (await created.json()) as { id: string };
    expect(id).toBeTruthy();

    const job = await pollUntil(base, id, (j) => j.status === 'completed');
    expect(job.report?.structured.overallScore).toBe(80);
    expect(job.report?.structured.issues[0]?.title).toBe('Form control has no label');
    // Buffers are serialized as base64 data URIs, never raw bytes.
    expect(job.report?.screenshot).toMatch(/^data:image\/jpeg;base64,/);
    expect(job.progress.some((p) => p.stage === 'capturing')).toBe(true);
  });

  it('surfaces a failed scan with its code and retryable flag', async () => {
    const failing: ScanImpl = async () => {
      throw new ScanError('llm-auth', 'API key invalid', false);
    };
    const { base } = await startServer(failing);

    const { id } = (await (
      await postScan(base, { url: 'https://example.com', options: { llm: { apiKey: 'k' } } })
    ).json()) as {
      id: string;
    };
    const job = await pollUntil(base, id, (j) => j.status === 'failed');
    expect(job.error).toEqual({ code: 'llm-auth', message: 'API key invalid', retryable: false });
    expect(job.report).toBeUndefined();
  });

  it('serves report.html only after the scan completes', async () => {
    const gate = deferred<void>();
    const gatedScan: ScanImpl = async () => {
      await gate.promise;
      return makeReport();
    };
    const { base } = await startServer(gatedScan);

    const { id } = (await (await postScan(base, { url: 'https://example.com' })).json()) as { id: string };

    const early = await fetch(`${base}/scans/${id}/report.html`);
    expect(early.status).toBe(404);

    gate.resolve();
    await pollUntil(base, id, (j) => j.status === 'completed');

    const ready = await fetch(`${base}/scans/${id}/report.html`);
    expect(ready.status).toBe(200);
    expect(ready.headers.get('content-type')).toMatch(/text\/html/);
    expect(await ready.text()).toContain('<!doctype html>');
  });

  it('reports job counts on /healthz', async () => {
    const gate = deferred<void>();
    const gatedScan: ScanImpl = async () => {
      await gate.promise;
      return makeReport();
    };
    const { base } = await startServer(gatedScan, { concurrency: 1 });

    const first = (await (await postScan(base, { url: 'https://example.com/a' })).json()) as { id: string };
    await postScan(base, { url: 'https://example.com/b' });

    const busy = (await (await fetch(`${base}/healthz`)).json()) as {
      status: string;
      uptimeSec: number;
      jobs: { queued: number; running: number; completed: number; failed: number };
    };
    expect(busy.status).toBe('ok');
    expect(typeof busy.uptimeSec).toBe('number');
    // Concurrency 1: one scan runs, the second waits in the FIFO queue.
    expect(busy.jobs.running).toBe(1);
    expect(busy.jobs.queued).toBe(1);

    gate.resolve();
    await pollUntil(base, first.id, (j) => j.status === 'completed');
    const done = await (async (): Promise<{ jobs: { completed: number } }> => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const h = (await (await fetch(`${base}/healthz`)).json()) as { jobs: { completed: number } };
        if (h.jobs.completed === 2) return h;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('scans did not both complete');
    })();
    expect(done.jobs.completed).toBe(2);
  });

  it('requires a bearer token when configured, but leaves /healthz open', async () => {
    const { base } = await startServer(successScan, { authToken: 'sekret' });

    // /healthz stays open with no auth.
    expect((await fetch(`${base}/healthz`)).status).toBe(200);

    // No token, wrong token -> 401.
    expect((await fetch(`${base}/scans/anything`)).status).toBe(401);
    expect((await postScan(base, { url: 'https://example.com' })).status).toBe(401);
    expect((await postScan(base, { url: 'https://example.com' }, 'nope')).status).toBe(401);

    // Correct token -> accepted.
    const created = await postScan(base, { url: 'https://example.com' }, 'sekret');
    expect(created.status).toBe(202);
  });

  it('never lets a request body widen the SSRF posture', async () => {
    const { base, fake } = await startServer(successScan, { allowPrivateNetworks: false });

    const created = await postScan(base, {
      url: 'https://example.com',
      options: { allowPrivateNetworks: true, browser: { disableSandbox: true } },
    });
    expect(created.status).toBe(202);
    const { id } = (await created.json()) as { id: string };
    await pollUntil(base, id, (j) => j.status === 'completed');

    // The engine was constructed with the server posture, not the request's.
    expect(fake.engineOptions?.allowPrivateNetworks).toBe(false);
    // The stripped fields never reached the scan options either.
    const scanOptions = fake.scanCalls[0]?.options as Record<string, unknown> | undefined;
    expect(scanOptions).toBeDefined();
    expect(scanOptions).not.toHaveProperty('allowPrivateNetworks');
    expect(scanOptions).not.toHaveProperty('browser');
  });

  it('passes the API key to the engine but never echoes it in responses', async () => {
    const secret = 'sk-super-secret-key-value';
    const { base, fake } = await startServer(successScan);

    const created = await postScan(base, { url: 'https://example.com', options: { llm: { apiKey: secret } } });
    const { id } = (await created.json()) as { id: string };

    const raw = await (await fetch(`${base}/scans/${id}`)).text();
    await pollUntil(base, id, (j) => j.status === 'completed');
    const rawDone = await (await fetch(`${base}/scans/${id}`)).text();

    // The engine actually received the key...
    expect(fake.scanCalls[0]?.options.llm?.apiKey).toBe(secret);
    // ...but it appears in no GET response body, at any stage.
    expect(raw).not.toContain(secret);
    expect(rawDone).not.toContain(secret);
  });

  it('rejects an oversized request body with 413', async () => {
    const { base } = await startServer(successScan);
    const huge = { url: `https://example.com/${'a'.repeat(70_000)}` };
    const res = await postScan(base, huge);
    expect(res.status).toBe(413);
  });

  it('rejects unknown top-level fields and unknown routes', async () => {
    const { base } = await startServer(successScan);

    const badField = await postScan(base, { url: 'https://example.com', nope: true });
    expect(badField.status).toBe(400);

    const missingUrl = await postScan(base, { options: {} });
    expect(missingUrl.status).toBe(400);

    const unknownRoute = await fetch(`${base}/does-not-exist`);
    expect(unknownRoute.status).toBe(404);

    // Method mismatch on a known route.
    const wrongMethod = await fetch(`${base}/scans`, { method: 'GET' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('POST');
  });
});
