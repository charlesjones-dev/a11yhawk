/**
 * HTTP server mode ("a11yhawk serve").
 *
 * A deliberately small HTTP layer over the scan engine, built on bare
 * `node:http` with no framework and no new dependencies. It exposes:
 *
 *   POST /scans               enqueue a scan          -> 202 { id }
 *   GET  /scans/:id           poll status + report
 *   GET  /scans/:id/report.html   rendered HTML report (404 until completed)
 *   GET  /healthz             liveness + job counts (never requires auth)
 *
 * Design constraints that matter:
 * - One shared A11yHawkEngine for the process so the browser stays warm across
 *   scans. Concurrency is bounded by a FIFO queue; overflow scans wait.
 * - The job store is in memory with TTL eviction. Restarts lose jobs; that is
 *   intended and documented. Persistence is the host's concern.
 * - Security posture (allowPrivateNetworks, sandbox) is set once from server
 *   config and can never be influenced by a request body. Request options are
 *   passed through a strict allowlist; unknown/dangerous fields are stripped.
 * - The engine never reads process.env. runServe assembles all env/argv config
 *   here and hands an explicit config to createA11yHawkServer, which also
 *   accepts an engine factory so tests can inject a fake engine.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { renderHtmlReport } from '../engine/html-report.js';
import { A11yHawkEngine, ScanError } from '../engine/scan.js';
import type { EngineOptions, ScanOptions, ScanProgressEvent, ScanReport } from '../engine/scan.js';
import { createLogger } from '../logger/index.js';
import type { Logger } from '../logger/index.js';
import type { GenerationParams, ScanHeader, ScanHeaderType, WcagLevel, WcagVersion } from '../types.js';

/** Maximum accepted request body. Scan requests are tiny; anything larger is rejected. */
const MAX_BODY_BYTES = 64 * 1024;

/** Placeholder written over a stored API key once a scan starts. */
const REDACTED = '[redacted]';

/** How often the background sweep runs to evict expired jobs. */
const SWEEP_INTERVAL_MS = 60_000;

/** Job lifecycle states surfaced to clients. */
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

/**
 * The subset of A11yHawkEngine the server depends on. Declaring it as an
 * interface lets tests inject a fake engine (with scan/setConcurrency/close)
 * without a browser.
 */
export interface EngineLike {
  scan(url: string, options: ScanOptions): Promise<ScanReport>;
  setConcurrency(concurrency: number): void;
  close(): Promise<void>;
}

/** Builds the shared engine from server-level options. Overridable in tests. */
export type EngineFactory = (options: EngineOptions) => EngineLike;

/** Explicit configuration for createA11yHawkServer. No env is read here. */
export interface A11yHawkServerConfig {
  /** Max concurrent scans; clamped to 1-10. Default 2. */
  concurrency?: number;
  /** Seconds a terminal job is retained before eviction. Default 3600. */
  jobTtlSeconds?: number;
  /** When set, every endpoint except /healthz requires `Bearer <token>`. */
  authToken?: string;
  /** Server-level SSRF posture. Never settable from a request body. Default false. */
  allowPrivateNetworks?: boolean;
  /** Launch Chromium with --no-sandbox (some container hosts require it). Default false. */
  disableSandbox?: boolean;
  /** Inject a fake engine in tests. Defaults to a real A11yHawkEngine. */
  engineFactory?: EngineFactory;
  logger?: Logger;
}

/** A running server handle. */
export interface A11yHawkServer {
  /** The underlying node:http server (exposed for advanced use/tests). */
  readonly httpServer: Server;
  /** Bind and start listening. Resolves with the actually-bound port. */
  listen(port: number): Promise<{ port: number }>;
  /** Stop accepting connections, sweep timers, and close the engine/browser. */
  close(): Promise<void>;
}

interface Job {
  id: string;
  status: JobStatus;
  createdAt: number;
  url: string;
  /** Sanitized scan options. The API key is redacted once the scan starts. */
  options: ScanOptions;
  progress: ScanProgressEvent[];
  report?: ScanReport;
  error?: { code: string; message: string; retryable: boolean };
  /** Epoch ms after which a terminal job may be evicted; null while active. */
  evictAt: number | null;
}

const WCAG_VERSIONS: readonly WcagVersion[] = ['2.0', '2.1', '2.2'];
const WCAG_LEVELS: readonly WcagLevel[] = ['A', 'AA', 'AAA'];
const HEADER_TYPES: readonly ScanHeaderType[] = ['cookie', 'authorization', 'header'];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Sniff PNG vs JPEG from magic bytes and build a base64 data URI. */
function bufferToDataUri(buffer: Buffer): string {
  const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const mime = isJpeg ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

// --- request option sanitization ---------------------------------------------

type SanitizeResult<T> = { ok: true; value: T } | { ok: false; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeGenerationParams(raw: unknown): SanitizeResult<GenerationParams> {
  if (!isPlainObject(raw)) return { ok: false, message: 'llm.generationParams must be an object.' };
  const out: GenerationParams = {};
  for (const key of ['temperature', 'topP', 'frequencyPenalty', 'maxTokens'] as const) {
    const val = raw[key];
    if (val === undefined) continue;
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      return { ok: false, message: `llm.generationParams.${key} must be a finite number.` };
    }
    out[key] = val;
  }
  return { ok: true, value: out };
}

function sanitizeLlm(raw: unknown): SanitizeResult<ScanOptions['llm']> {
  if (!isPlainObject(raw)) return { ok: false, message: 'options.llm must be an object.' };
  if (typeof raw.apiKey !== 'string' || raw.apiKey.trim() === '') {
    return { ok: false, message: 'options.llm.apiKey must be a non-empty string.' };
  }
  // Strict allowlist: only apiKey, model, baseUrl, generationParams are
  // accepted. httpReferer/appTitle/debug and anything else are dropped.
  const llm: NonNullable<ScanOptions['llm']> = { apiKey: raw.apiKey };
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string') return { ok: false, message: 'options.llm.model must be a string.' };
    llm.model = raw.model;
  }
  if (raw.baseUrl !== undefined) {
    if (typeof raw.baseUrl !== 'string') return { ok: false, message: 'options.llm.baseUrl must be a string.' };
    llm.baseUrl = raw.baseUrl;
  }
  if (raw.generationParams !== undefined) {
    const gp = sanitizeGenerationParams(raw.generationParams);
    if (!gp.ok) return gp;
    llm.generationParams = gp.value;
  }
  return { ok: true, value: llm };
}

function sanitizeHeaders(raw: unknown): SanitizeResult<ScanHeader[]> {
  if (!Array.isArray(raw)) return { ok: false, message: 'options.headers must be an array.' };
  const headers: ScanHeader[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) return { ok: false, message: 'Each header must be an object.' };
    const { type, key, value } = entry;
    if (typeof type !== 'string' || !HEADER_TYPES.includes(type as ScanHeaderType)) {
      return { ok: false, message: `header.type must be one of: ${HEADER_TYPES.join(', ')}.` };
    }
    if (typeof key !== 'string' || typeof value !== 'string') {
      return { ok: false, message: 'header.key and header.value must be strings.' };
    }
    headers.push({ type: type as ScanHeaderType, key, value });
  }
  return { ok: true, value: headers };
}

/**
 * Build a ScanOptions from an untrusted request `options` object. Only the
 * documented fields are accepted; everything else (allowPrivateNetworks,
 * browser, logger, onProgress, ...) is silently stripped. Security-critical:
 * a request must not be able to widen the server's SSRF posture.
 */
function sanitizeOptions(raw: unknown): SanitizeResult<ScanOptions> {
  if (!isPlainObject(raw)) return { ok: false, message: '"options" must be an object.' };
  const out: ScanOptions = {};

  if (raw.wcagVersion !== undefined) {
    if (typeof raw.wcagVersion !== 'string' || !WCAG_VERSIONS.includes(raw.wcagVersion as WcagVersion)) {
      return { ok: false, message: `options.wcagVersion must be one of: ${WCAG_VERSIONS.join(', ')}.` };
    }
    out.wcagVersion = raw.wcagVersion as WcagVersion;
  }
  if (raw.wcagLevel !== undefined) {
    if (typeof raw.wcagLevel !== 'string' || !WCAG_LEVELS.includes(raw.wcagLevel as WcagLevel)) {
      return { ok: false, message: `options.wcagLevel must be one of: ${WCAG_LEVELS.join(', ')}.` };
    }
    out.wcagLevel = raw.wcagLevel as WcagLevel;
  }
  if (raw.lighthouse !== undefined) {
    if (typeof raw.lighthouse !== 'boolean') return { ok: false, message: 'options.lighthouse must be a boolean.' };
    out.lighthouse = raw.lighthouse;
  }
  if (raw.annotate !== undefined) {
    if (typeof raw.annotate !== 'boolean') return { ok: false, message: 'options.annotate must be a boolean.' };
    out.annotate = raw.annotate;
  }
  if (raw.headers !== undefined) {
    const h = sanitizeHeaders(raw.headers);
    if (!h.ok) return h;
    out.headers = h.value;
  }
  if (raw.llm !== undefined) {
    const l = sanitizeLlm(raw.llm);
    if (!l.ok) return l;
    out.llm = l.value;
  }
  return { ok: true, value: out };
}

function sanitizeCreateRequest(input: unknown): SanitizeResult<{ url: string; options: ScanOptions }> {
  if (!isPlainObject(input)) return { ok: false, message: 'Request body must be a JSON object.' };
  const allowedTop = new Set(['url', 'options']);
  const unknown = Object.keys(input).filter((k) => !allowedTop.has(k));
  if (unknown.length > 0) {
    return { ok: false, message: `Unknown field(s): ${unknown.join(', ')}. Allowed: url, options.` };
  }
  if (typeof input.url !== 'string' || input.url.trim() === '') {
    return { ok: false, message: 'A non-empty "url" string is required.' };
  }
  let options: ScanOptions = {};
  if (input.options !== undefined) {
    const opt = sanitizeOptions(input.options);
    if (!opt.ok) return opt;
    options = opt.value;
  }
  return { ok: true, value: { url: input.url, options } };
}

// --- HTTP helpers ------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function send405(res: ServerResponse, allow: string): void {
  const body = JSON.stringify({ error: { code: 'method-not-allowed', message: `Only ${allow} is allowed here.` } });
  res.writeHead(405, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    allow,
  });
  res.end(body);
}

type BodyResult = { ok: true; body: string } | { ok: false; tooLarge: true };

/**
 * Read the request body. Past `limit` bytes we stop buffering (so memory stays
 * bounded) but keep draining to end, then report tooLarge. Draining rather than
 * destroying the socket lets the 413 response flush cleanly to the client.
 */
function readBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Discard what we buffered and stop buffering; keep consuming to 'end'.
        over = true;
        chunks = [];
        return;
      }
      if (!over) chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(over ? { ok: false, tooLarge: true } : { ok: true, body: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', reject);
  });
}

// --- server ------------------------------------------------------------------

/**
 * Create a server from explicit config. Reads no environment; runServe does
 * that and calls in here. Returns a handle you can listen()/close().
 */
export function createA11yHawkServer(config: A11yHawkServerConfig): A11yHawkServer {
  const logger = config.logger ?? createLogger();
  const concurrency = clamp(Math.trunc(config.concurrency ?? 2), 1, 10);
  const ttlMs = Math.max(0, (config.jobTtlSeconds ?? 3600) * 1000);
  const allowPrivateNetworks = config.allowPrivateNetworks ?? false;
  const disableSandbox = config.disableSandbox ?? false;
  const authHash = config.authToken ? sha256(config.authToken) : null;

  const engineFactory: EngineFactory = config.engineFactory ?? ((opts) => new A11yHawkEngine(opts));
  const engine = engineFactory({
    allowPrivateNetworks,
    browser: { disableSandbox },
    logger,
  });
  engine.setConcurrency(concurrency);

  const startedAt = Date.now();
  const jobs = new Map<string, Job>();
  const queue: string[] = [];
  let running = 0;

  function sweep(): void {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.evictAt !== null && now >= job.evictAt) jobs.delete(id);
    }
  }

  async function runJob(job: Job): Promise<void> {
    job.status = 'running';
    // Hand the engine a private copy of the options carrying the real API key,
    // then redact the stored copy so the key cannot survive in the job record
    // past dispatch. Cloning llm keeps the live key isolated from the redaction.
    const liveOptions: ScanOptions = {
      ...job.options,
      ...(job.options.llm ? { llm: { ...job.options.llm } } : {}),
      onProgress: (event) => {
        job.progress.push(event);
      },
    };
    if (job.options.llm) job.options.llm.apiKey = REDACTED;

    try {
      job.report = await engine.scan(job.url, liveOptions);
      job.status = 'completed';
    } catch (error) {
      const scanError = error instanceof ScanError ? error : null;
      job.error = {
        code: scanError?.code ?? 'internal',
        message: error instanceof Error ? error.message : String(error),
        retryable: scanError?.retryable ?? false,
      };
      job.status = 'failed';
      logger.warn('Scan job failed', { jobId: job.id, code: job.error.code, retryable: job.error.retryable });
    } finally {
      job.evictAt = Date.now() + ttlMs;
    }
  }

  function pump(): void {
    while (running < concurrency && queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) break;
      const job = jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      running += 1;
      void runJob(job).finally(() => {
        running -= 1;
        pump();
      });
    }
  }

  function serializeReport(report: ScanReport): Record<string, unknown> {
    return {
      structured: report.structured,
      markdown: report.markdown,
      // Buffers are not JSON-serializable; expose them as base64 data URIs.
      screenshot: report.screenshot ? bufferToDataUri(report.screenshot) : null,
      annotatedScreenshot: report.annotatedScreenshot ? bufferToDataUri(report.annotatedScreenshot) : null,
      lighthouse: report.lighthouse,
      usage: report.usage,
      finalUrl: report.finalUrl,
      durationMs: report.durationMs,
    };
  }

  function serializeJob(job: Job): Record<string, unknown> {
    const base: Record<string, unknown> = {
      id: job.id,
      status: job.status,
      createdAt: new Date(job.createdAt).toISOString(),
      progress: job.progress,
    };
    if (job.status === 'completed' && job.report) base.report = serializeReport(job.report);
    if (job.status === 'failed' && job.error) base.error = job.error;
    return base;
  }

  function isAuthorized(req: IncomingMessage): boolean {
    if (authHash === null) return true;
    const header = req.headers['authorization'];
    if (typeof header !== 'string') return false;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    const token = match?.[1];
    if (!token) return false;
    // Constant-time comparison over fixed-length hashes so neither the token
    // value nor its length leaks through timing.
    return timingSafeEqual(sha256(token), authHash);
  }

  async function handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const bodyResult = await readBody(req, MAX_BODY_BYTES);
    if (!bodyResult.ok) {
      sendError(res, 413, 'payload-too-large', 'Request body exceeds the 64 KB limit.');
      return;
    }
    let parsed: unknown;
    try {
      parsed = bodyResult.body.trim() === '' ? undefined : JSON.parse(bodyResult.body);
    } catch {
      sendError(res, 400, 'invalid-json', 'Request body must be valid JSON.');
      return;
    }
    const sanitized = sanitizeCreateRequest(parsed);
    if (!sanitized.ok) {
      sendError(res, 400, 'invalid-request', sanitized.message);
      return;
    }
    const id = randomUUID();
    const job: Job = {
      id,
      status: 'queued',
      createdAt: Date.now(),
      url: sanitized.value.url,
      options: sanitized.value.options,
      progress: [],
      evictAt: null,
    };
    jobs.set(id, job);
    queue.push(id);
    pump();
    sendJson(res, 202, { id });
  }

  function handleGetScan(id: string, res: ServerResponse): void {
    sweep();
    const job = jobs.get(id);
    if (!job) {
      sendError(res, 404, 'not-found', 'No scan with that id (it may have expired).');
      return;
    }
    sendJson(res, 200, serializeJob(job));
  }

  function handleReportHtml(id: string, res: ServerResponse): void {
    sweep();
    const job = jobs.get(id);
    if (!job || job.status !== 'completed' || !job.report) {
      sendError(res, 404, 'not-found', 'No completed report for that id yet.');
      return;
    }
    const html = renderHtmlReport(job.report);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
    });
    res.end(html);
  }

  function handleHealth(res: ServerResponse): void {
    const counts = { queued: 0, running: 0, completed: 0, failed: 0 };
    for (const job of jobs.values()) counts[job.status] += 1;
    sendJson(res, 200, {
      status: 'ok',
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      jobs: counts,
    });
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      sendError(res, 400, 'invalid-request', 'Malformed request URL.');
      return;
    }
    const method = req.method ?? 'GET';

    // Health is always open, even when a token is configured.
    if (pathname === '/healthz') {
      if (method !== 'GET') return send405(res, 'GET');
      handleHealth(res);
      return;
    }

    if (authHash !== null && !isAuthorized(req)) {
      sendError(res, 401, 'unauthorized', 'A valid "Authorization: Bearer <token>" header is required.');
      return;
    }

    if (pathname === '/scans') {
      if (method !== 'POST') return send405(res, 'POST');
      await handleCreate(req, res);
      return;
    }

    const reportMatch = /^\/scans\/([^/]+)\/report\.html$/.exec(pathname);
    if (reportMatch?.[1]) {
      if (method !== 'GET') return send405(res, 'GET');
      handleReportHtml(decodeURIComponent(reportMatch[1]), res);
      return;
    }

    const scanMatch = /^\/scans\/([^/]+)$/.exec(pathname);
    if (scanMatch?.[1]) {
      if (method !== 'GET') return send405(res, 'GET');
      handleGetScan(decodeURIComponent(scanMatch[1]), res);
      return;
    }

    sendError(res, 404, 'not-found', 'Unknown route.');
  }

  const httpServer = createServer((req, res) => {
    handler(req, res).catch((error: unknown) => {
      logger.error('Unhandled server error', { errorMessage: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) sendError(res, 500, 'internal', 'Internal server error.');
      else res.end();
    });
  });

  const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  return {
    httpServer,
    listen(port: number): Promise<{ port: number }> {
      return new Promise((resolve) => {
        httpServer.listen(port, () => {
          const address = httpServer.address();
          const boundPort = address !== null && typeof address === 'object' ? address.port : port;
          resolve({ port: boundPort });
        });
      });
    },
    async close(): Promise<void> {
      clearInterval(sweepTimer);
      // Drop idle keep-alive sockets so close() resolves promptly.
      httpServer.closeIdleConnections?.();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      await engine.close();
    },
  };
}

// --- CLI entry ---------------------------------------------------------------

function parseIntEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse an optional `--port <n>` or `--port=<n>` from argv. */
function parsePortArg(argv: string[]): number | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') {
      const next = argv[i + 1];
      const n = next !== undefined ? Number.parseInt(next, 10) : NaN;
      if (Number.isFinite(n)) return n;
    } else if (arg?.startsWith('--port=')) {
      const n = Number.parseInt(arg.slice('--port='.length), 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

/**
 * `a11yhawk serve` entry point. Assembles config from argv and environment
 * (the only place env is read), starts the server, and blocks until a
 * SIGINT/SIGTERM triggers graceful shutdown.
 */
export async function runServe(argv: string[]): Promise<void> {
  const logger = createLogger();
  // argv wins over env for the port; env falls back A11YHAWK_PORT -> PORT -> 4000.
  const port = parsePortArg(argv) ?? parseIntEnv(process.env.A11YHAWK_PORT) ?? parseIntEnv(process.env.PORT) ?? 4000;

  const config: A11yHawkServerConfig = {
    concurrency: parseIntEnv(process.env.A11YHAWK_CONCURRENCY) ?? 2,
    jobTtlSeconds: parseIntEnv(process.env.A11YHAWK_JOB_TTL_SECONDS) ?? 3600,
    authToken: process.env.A11YHAWK_AUTH_TOKEN?.trim() || undefined,
    allowPrivateNetworks: process.env.A11YHAWK_ALLOW_PRIVATE === 'true',
    disableSandbox: process.env.A11YHAWK_DISABLE_SANDBOX === 'true',
    logger,
  };

  const server = createA11yHawkServer(config);
  const { port: boundPort } = await server.listen(port);
  logger.info('a11yhawk serve listening', {
    port: boundPort,
    concurrency: clamp(config.concurrency ?? 2, 1, 10),
    authRequired: Boolean(config.authToken),
    allowPrivateNetworks: config.allowPrivateNetworks ?? false,
  });

  await new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (closing) return;
      closing = true;
      logger.info('Shutting down', { signal });
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      server
        .close()
        .catch((error: unknown) => {
          logger.error('Error during shutdown', {
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(resolve);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
