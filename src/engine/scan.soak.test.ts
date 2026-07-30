/**
 * Bulk-mode soak / resource-leak regression test.
 *
 * Runs many sequential Lighthouse-only scans with screenshots disabled
 * against a local fixture server, all on one warm A11yHawkEngine, and
 * asserts that Node-side memory and active resource handles stay flat.
 * This is the regression guard for hosts that crawl thousands of pages
 * per engine instance.
 *
 * Opt-in (real Chromium + Lighthouse subprocess per scan, minutes of wall
 * clock), so the default `npm run verify` skips it:
 *
 *   A11YHAWK_SOAK=1 NODE_OPTIONS=--expose-gc npx vitest run src/engine/scan.soak.test.ts
 *
 * Tuning:
 *   A11YHAWK_SOAK_SCANS  number of sequential scans (default 25; use 1000
 *                        for a full soak)
 *   A11YHAWK_SOAK_PERF   set to 1 to include the performance category
 *
 * Without --expose-gc the memory assertion still runs but with a much
 * looser bound, since V8 may simply not have collected yet.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { A11yHawkEngine } from './scan.js';
import type { ScanOptions } from './scan.js';

const SOAK_ENABLED = process.env.A11YHAWK_SOAK === '1';
const SCAN_COUNT = Math.max(10, Number.parseInt(process.env.A11YHAWK_SOAK_SCANS ?? '', 10) || 25);
const INCLUDE_PERFORMANCE = process.env.A11YHAWK_SOAK_PERF === '1';

// Median-of-first-window vs median-of-last-window growth bounds. A per-scan
// leak of even ~1 MB blows past these within the default 25 scans.
const WINDOW = 5;
const MAX_GROWTH_BYTES = globalThis.gc ? 32 * 1024 * 1024 : 150 * 1024 * 1024;
// Handles are compared after the engine closes; allow a little slack for
// runner-internal churn (sockets in TIME_WAIT, inspector, etc.).
const MAX_EXTRA_HANDLES = 5;

const FIXTURE_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Soak fixture</title></head>
<body>
  <img src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==">
  <input type="text">
  <p style="color:#888;background:#999;">Low contrast paragraph text.</p>
  <a href="/nowhere"></a>
  <button></button>
  <main><h1>Deliberately broken soak fixture page</h1></main>
</body>
</html>`;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Progress telemetry. Vitest swallows console.log; write to stderr directly. */
function soakLog(message: string): void {
  process.stderr.write(`soak: ${message}\n`);
}

/** heapUsed + external covers both JS objects and Buffer allocations. */
function sampleMemory(): number {
  globalThis.gc?.();
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.external;
}

describe.runIf(SOAK_ENABLED)('bulk-mode soak (sequential scans on one engine)', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(FIXTURE_PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (address === null || typeof address !== 'object') throw new Error('fixture server failed to bind');
    url = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it(
    `keeps memory and handles flat across ${SCAN_COUNT} sequential scans`,
    { timeout: SCAN_COUNT * 60_000 },
    async () => {
      const engine = new A11yHawkEngine({ allowPrivateNetworks: true });
      const scanOptions: ScanOptions = {
        screenshot: false,
        ...(INCLUDE_PERFORMANCE ? { lighthouse: { categories: ['accessibility', 'performance'] } } : {}),
      };

      const baselineHandles = process.getActiveResourcesInfo().length;
      const samples: number[] = [];

      try {
        for (let i = 0; i < SCAN_COUNT; i++) {
          const report = await engine.scan(url, scanOptions);

          // Sanity: the scan produced findings and honored screenshot: false.
          expect(report.structured.issues.length).toBeGreaterThan(0);
          expect(report.screenshot).toBeNull();
          expect(report.annotatedScreenshot).toBeNull();
          if (INCLUDE_PERFORMANCE) {
            expect(report.lighthouse?.performance).toBeDefined();
          }

          samples.push(sampleMemory());
          if ((i + 1) % 10 === 0 || i + 1 === SCAN_COUNT) {
            const mb = (samples[samples.length - 1] ?? 0) / 1024 / 1024;
            soakLog(`${i + 1}/${SCAN_COUNT} scans, heap+external ${mb.toFixed(1)} MB`);
          }
        }
      } finally {
        await engine.close();
      }

      // Memory: compare early-window vs late-window medians, skipping the
      // first scan (module lazy-loads and JIT warmup land there).
      const early = median(samples.slice(1, 1 + WINDOW));
      const late = median(samples.slice(-WINDOW));
      const growth = late - early;
      soakLog(
        `memory early ${(early / 1024 / 1024).toFixed(1)} MB -> late ${(late / 1024 / 1024).toFixed(1)} MB ` +
          `(growth ${(growth / 1024 / 1024).toFixed(1)} MB, bound ${(MAX_GROWTH_BYTES / 1024 / 1024).toFixed(0)} MB)`,
      );
      expect(growth).toBeLessThan(MAX_GROWTH_BYTES);

      // Engine internals: the browser fully shut down and no scan state
      // survived the loop.
      const playwright = (
        engine as unknown as {
          playwright: {
            browser: unknown;
            browserServer: unknown;
            cdpPort: unknown;
            browserRefCount: number;
            activeAnalyses: number;
            waitingQueue: unknown[];
          };
        }
      ).playwright;
      expect(playwright.browser).toBeNull();
      expect(playwright.browserServer).toBeNull();
      expect(playwright.cdpPort).toBeNull();
      expect(playwright.browserRefCount).toBe(0);
      expect(playwright.activeAnalyses).toBe(0);
      expect(playwright.waitingQueue).toHaveLength(0);

      // Handles: after close(), give in-flight teardown a beat, then compare
      // against the pre-scan baseline (child processes, sockets, timers).
      await new Promise((resolve) => setTimeout(resolve, 250));
      const finalHandles = process.getActiveResourcesInfo().length;
      soakLog(`active resources baseline ${baselineHandles} -> final ${finalHandles}`);
      expect(finalHandles).toBeLessThanOrEqual(baselineHandles + MAX_EXTRA_HANDLES);
    },
  );
});
