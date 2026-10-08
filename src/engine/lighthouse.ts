/**
 * Lighthouse Service for accessibility and performance audits
 *
 * This service wraps Google Lighthouse to run category-scoped audits against
 * a page using an existing Chrome DevTools Protocol (CDP) connection. All
 * requested categories run in a single subprocess and a single page load.
 */
// Note: lighthouse is imported dynamically to avoid blocking module initialization
// The lighthouse package is large (~50MB) and can cause ESM/CJS issues with static imports
import type { Logger } from '../logger/index.js';
import { createLogger } from '../logger/index.js';
import { chromium } from 'playwright';

const defaultLogger = createLogger({ serviceName: 'worker' });

// Default timeout for Lighthouse audits (30 seconds)
const DEFAULT_AUDIT_TIMEOUT_MS = 30000;

// Performance runs collect and process a trace on top of the page load, so
// they get a higher timeout floor regardless of the constructor timeout.
const PERFORMANCE_AUDIT_TIMEOUT_MS = 60000;

// Grace period after SIGTERM before a timed-out Lighthouse child is SIGKILLed.
const KILL_GRACE_MS = 5000;

// Opportunities are capped so bulk consumers get a stable, bounded payload.
const MAX_PERFORMANCE_OPPORTUNITIES = 10;

/**
 * Lighthouse accessibility audit item details
 */
export interface LighthouseA11yAuditItem {
  /** Selector or identifier for the element */
  selector?: string;
  /** HTML snippet of the element */
  snippet?: string;
  /** Explanation of the issue */
  explanation?: string;
  /** Node label for accessibility tree */
  nodeLabel?: string;
  /** Bound rect for element position */
  boundingRect?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
    width: number;
    height: number;
  };
}

/**
 * Lighthouse accessibility audit result
 */
export interface LighthouseA11yAudit {
  /** Audit identifier (e.g., 'color-contrast', 'image-alt') */
  id: string;
  /** Human-readable title */
  title: string;
  /** Detailed description of the audit */
  description: string;
  /** Audit score (0-1, null if not applicable) */
  score: number | null;
  /** Score display mode (binary, numeric, informative, etc.) */
  scoreDisplayMode: string;
  /** Display value for the audit result */
  displayValue?: string;
  /** Detailed items that failed the audit */
  items?: LighthouseA11yAuditItem[];
  /** Number of items affected */
  numericValue?: number;
  /** Warning messages if any */
  warnings?: string[];
}

/**
 * Lighthouse accessibility category result
 */
export interface LighthouseA11yCategory {
  /** Category score (0-1) */
  score: number | null;
  /** Category title */
  title: string;
  /** Category description */
  description: string;
  /** Manual checks not automated */
  manualDescription?: string;
  /** Audit references in this category */
  auditRefs: Array<{
    id: string;
    weight: number;
    group?: string;
    acronym?: string;
    relevantAudits?: string[];
  }>;
}

/**
 * Lighthouse categories the engine can run. Every requested category is
 * audited in one subprocess run / one page load. The accessibility category
 * is always required: it is the engine's analysis source in Lighthouse-only
 * mode and the basis of the structured report.
 */
export type LighthouseCategory = 'accessibility' | 'performance';

/** Runtime companion to LighthouseCategory for validating untyped input. */
export const LIGHTHOUSE_CATEGORY_VALUES: readonly LighthouseCategory[] = ['accessibility', 'performance'];

/**
 * Key page-load metrics from the Lighthouse performance category. All timing
 * values are milliseconds; cumulativeLayoutShift is the unitless CLS score.
 * Each field is optional because Lighthouse omits metrics it could not
 * measure (for example on pages that never paint).
 */
export interface LighthousePerformanceMetrics {
  /** First Contentful Paint in milliseconds. */
  firstContentfulPaintMs?: number;
  /** Largest Contentful Paint in milliseconds. */
  largestContentfulPaintMs?: number;
  /** Cumulative Layout Shift (unitless, rounded to 3 decimals). */
  cumulativeLayoutShift?: number;
  /** Total Blocking Time in milliseconds. */
  totalBlockingTimeMs?: number;
  /** Speed Index in milliseconds. */
  speedIndexMs?: number;
}

/** A failing performance audit with an estimated improvement. */
export interface LighthousePerformanceOpportunity {
  /** Lighthouse audit ID (e.g. "render-blocking-resources"). */
  auditId: string;
  /** Human-readable audit title. */
  title: string;
  /** Estimated load-time savings in milliseconds, when Lighthouse reports one. */
  estimatedSavingsMs?: number;
  /** Estimated transfer savings in bytes, when Lighthouse reports one. */
  estimatedSavingsBytes?: number;
}

/**
 * Typed summary of the Lighthouse performance category. Produced from the
 * same run (same page load) as the accessibility audit.
 */
export interface LighthousePerformanceResult {
  /**
   * Performance category score (0-100), or null when Lighthouse could not
   * compute one (metrics may still be partially present).
   */
  score: number | null;
  metrics: LighthousePerformanceMetrics;
  /**
   * Failing audits with an estimated ms/bytes improvement, sorted by
   * estimated time savings (largest first), capped at 10 entries.
   */
  opportunities: LighthousePerformanceOpportunity[];
}

/**
 * Main Lighthouse accessibility audit result
 */
export interface LighthouseA11yResult {
  /** Overall accessibility score (0-100) */
  score: number;
  /** Category details */
  category: LighthouseA11yCategory;
  /** Individual audit results */
  audits: Record<string, LighthouseA11yAudit>;
  /** Audit timing information */
  timing: {
    /** Total audit duration in milliseconds */
    total: number;
  };
  /** URL that was audited */
  finalUrl: string;
  /** Lighthouse version used */
  lighthouseVersion: string;
  /** Fetch time of the audit */
  fetchTime: string;
  /** Performance summary, set when the performance category was requested. */
  performance?: LighthousePerformanceResult;
  /** Trimmed raw Lighthouse result (LHR), set when includeRaw was requested. */
  raw?: Record<string, unknown>;
}

/**
 * Error thrown when Lighthouse audit fails
 */
export class LighthouseAuditError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'LighthouseAuditError';
  }
}

// Chrome flags for when Lighthouse launches its own Chrome (no CDP port),
// optimized for containerized environments (Railway, Docker). These reduce
// memory usage and prevent "Browser tab has unexpectedly crashed" errors.
// Note: --no-sandbox is required on Railway as it doesn't support user
// namespaces. Security is mitigated by: non-root user, container isolation,
// ephemeral containers.
const CONTAINER_CHROME_FLAGS = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  // Memory optimization
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-translate',
  '--mute-audio',
  '--no-first-run',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-features=TranslateUI,AudioServiceOutOfProcess',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  // Additional memory/stability flags
  '--disable-software-rasterizer',
  '--disable-backgrounding-occluded-windows',
  '--disable-field-trial-config',
  '--disable-back-forward-cache',
];

/**
 * Build the Lighthouse CLI argv for one audit run. All requested categories
 * ride a single `--only-categories` flag, so they share one subprocess and
 * one page load. Pure; exported for tests.
 */
export function buildLighthouseCliArgs(
  url: string,
  categories: readonly LighthouseCategory[],
  cdpPort?: number,
): string[] {
  const args = [
    url,
    '--output=json',
    '--output-path=stdout',
    `--only-categories=${categories.join(',')}`,
    '--quiet',
    // Pin Sentry error reporting off. Without the flag, Lighthouse reads a consent cached
    // by any earlier interactive `lighthouse` run on the machine and may upload errors.
    '--no-enable-error-reporting',
  ];
  if (cdpPort) {
    // Connect to the existing Playwright browser instead of launching a new
    // Chrome. This saves memory by reusing the browser instance.
    args.push(`--port=${cdpPort}`);
  } else {
    args.push(`--chrome-flags=${CONTAINER_CHROME_FLAGS.join(' ')}`);
  }
  return args;
}

// Environment variables the Lighthouse child inherits. Everything else in the host's
// environment (API keys, tokens, NODE_OPTIONS preloads) stays out of the third-party tree.
// With --port Lighthouse makes no network requests of its own, so proxy and CA settings
// are not needed.
const LIGHTHOUSE_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'LANG',
  'LC_ALL',
];

/** Build the Lighthouse child's environment from the allowlist. Pure; exported for tests. */
export function buildLighthouseEnv(parentEnv: NodeJS.ProcessEnv, chromePath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of LIGHTHOUSE_ENV_ALLOWLIST) {
    const value = parentEnv[key];
    if (value !== undefined) env[key] = value;
  }
  env.CHROME_PATH = chromePath;
  return env;
}

/** Per-run options for a Lighthouse audit. */
export interface LighthouseRunOptions {
  /** CDP port of an already-running Chromium to reuse (from PlaywrightService). */
  cdpPort?: number;
  /**
   * Categories to audit in the single subprocess run. Must include
   * 'accessibility'. Default ['accessibility'].
   */
  categories?: readonly LighthouseCategory[];
  /** Attach a trimmed raw LHR to the result (see trimLhrForOutput). Default false. */
  includeRaw?: boolean;
}

/**
 * Service for running Lighthouse audits
 */
export class LighthouseService {
  private readonly timeoutMs: number;

  /**
   * Serializes runs that include the performance category. Parallel
   * performance traces on one machine contend for CPU and skew FCP/LCP/TBT,
   * so they run one at a time regardless of the engine's concurrency
   * setting. Accessibility-only runs are unaffected.
   */
  private performanceRunChain: Promise<void> = Promise.resolve();

  constructor(timeoutMs: number = DEFAULT_AUDIT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Run an accessibility-only Lighthouse audit. Kept as a stable alias for
   * pre-categories callers; equivalent to runAudit with default categories.
   */
  async runAccessibilityAudit(url: string, cdpPort?: number, jobLogger?: Logger): Promise<LighthouseA11yResult> {
    return this.runAudit(url, { cdpPort }, jobLogger);
  }

  /**
   * Run a Lighthouse audit for the requested categories in one subprocess
   * run / one page load.
   *
   * @param url - The URL to audit
   * @param options - CDP port, categories, raw-result opt-in
   * @param jobLogger - Optional logger for job-specific logging
   * @returns Lighthouse audit result (accessibility always present;
   *   `performance` set when that category was requested)
   * @throws LighthouseAuditError if the audit fails or times out
   */
  async runAudit(url: string, options: LighthouseRunOptions = {}, jobLogger?: Logger): Promise<LighthouseA11yResult> {
    const categories: readonly LighthouseCategory[] =
      options.categories && options.categories.length > 0 ? options.categories : ['accessibility'];
    if (!categories.includes('accessibility')) {
      throw new LighthouseAuditError('Lighthouse runs must include the accessibility category');
    }

    if (!categories.includes('performance')) {
      return this.executeAudit(url, categories, options, jobLogger);
    }

    // Queue behind any in-flight performance run (see performanceRunChain).
    const run = this.performanceRunChain.then(() => this.executeAudit(url, categories, options, jobLogger));
    this.performanceRunChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async executeAudit(
    url: string,
    categories: readonly LighthouseCategory[],
    options: LighthouseRunOptions,
    jobLogger?: Logger,
  ): Promise<LighthouseA11yResult> {
    const log = jobLogger || defaultLogger;
    const startTime = Date.now();
    const cdpPort = options.cdpPort;
    // A performance trace needs more headroom than a DOM-only accessibility
    // pass; raise the floor rather than exposing a per-scan timeout option.
    const timeoutMs = categories.includes('performance')
      ? Math.max(this.timeoutMs, PERFORMANCE_AUDIT_TIMEOUT_MS)
      : this.timeoutMs;

    log.info('Lighthouse audit starting', { url, categories: categories.join(','), timeoutMs, cdpPort });

    // Run Lighthouse as CLI subprocess - more reliable than importing the module
    // which has ESM/CJS issues and can hang during dynamic imports
    const { spawn } = await import('child_process');
    const { dirname, join } = await import('path');
    const { createRequire } = await import('module');

    // Resolve the actual Lighthouse CLI entry inside the installed `lighthouse` package.
    // Resolving `node_modules/.bin/lighthouse` relative to CWD is fragile: it breaks under
    // pnpm layouts, nested node_modules, and npx installs where the shim may not exist at
    // that path. Instead resolve the package's own package.json, read its `bin` mapping to
    // find the CLI entry, and join it to the package directory.
    const require = createRequire(import.meta.url);
    const lighthousePkgPath = require.resolve('lighthouse/package.json');
    const lighthousePkg = require(lighthousePkgPath) as { bin?: string | Record<string, string> };
    const lighthouseBin = typeof lighthousePkg.bin === 'string' ? lighthousePkg.bin : lighthousePkg.bin?.lighthouse;
    if (!lighthouseBin) {
      throw new LighthouseAuditError('Could not resolve the Lighthouse CLI entry from its package.json bin field');
    }
    const lighthouseCli = join(dirname(lighthousePkgPath), lighthouseBin);

    // Get Playwright's Chromium path - this ensures Lighthouse uses the same Chrome
    // that Playwright installed, avoiding "CHROME_PATH not set" errors on Railway
    const chromePath = chromium.executablePath();
    log.debug('Running Lighthouse CLI', { node: process.execPath, cli: lighthouseCli, chromePath, cdpPort });

    const lhr = await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
      const args = buildLighthouseCliArgs(url, categories, cdpPort);
      if (cdpPort) {
        log.debug('Connecting to existing Chrome via CDP', { cdpPort });
      }

      // Log memory before spawning Chrome
      const memBefore = process.memoryUsage();
      log.debug('Memory before Lighthouse', {
        heapUsedMb: Math.round(memBefore.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(memBefore.heapTotal / 1024 / 1024),
        rssMb: Math.round(memBefore.rss / 1024 / 1024),
        externalMb: Math.round(memBefore.external / 1024 / 1024),
      });

      // Log the full command for debugging
      log.debug('Lighthouse spawn command', {
        node: process.execPath,
        cli: lighthouseCli,
        args: args.join(' '),
        chromePath,
      });

      // SECURITY: Never spawn with `shell: true`. The scan URL is user-controlled and is
      // passed as an argument to the Lighthouse CLI; running through a shell would let
      // metacharacters (`;`, `|`, `&`, `$(...)`) in the URL execute arbitrary commands on
      // the worker. We invoke the current Node binary (process.execPath) with the resolved
      // CLI script as the first argv element and the rest passed as an array, so every
      // element is delivered as a literal argument and is never re-parsed by a shell.
      const child = spawn(process.execPath, [lighthouseCli, ...args], {
        shell: false,
        timeout: timeoutMs,
        env: buildLighthouseEnv(process.env, chromePath),
      });

      const pid = child.pid;
      log.debug('Lighthouse process spawned', { pid });

      let stdout = '';
      let stderr = '';
      let stderrLines: string[] = [];

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        // Collect stderr lines for debugging (limit to last 20 lines)
        const newLines = chunk.split('\n').filter((line) => line.trim());
        stderrLines.push(...newLines);
        if (stderrLines.length > 20) {
          stderrLines = stderrLines.slice(-20);
        }
      });

      child.on('error', (error: Error) => {
        log.error('Lighthouse process error', { pid, errorMessage: error.message });
        reject(new LighthouseAuditError(`Lighthouse process error: ${error.message}`));
      });

      child.on('close', (code: number | null, signal: string | null) => {
        // Clear timeout since process exited
        clearTimeout(timeoutHandle);

        const memAfter = process.memoryUsage();
        log.debug('Lighthouse process exited', {
          pid,
          code,
          signal,
          stderrLineCount: stderrLines.length,
          stdoutLength: stdout.length,
          heapUsedMb: Math.round(memAfter.heapUsed / 1024 / 1024),
          rssMb: Math.round(memAfter.rss / 1024 / 1024),
        });

        // Log stderr lines for debugging
        if (stderrLines.length > 0) {
          log.debug('Lighthouse stderr (last lines)', { lines: stderrLines.slice(-5) });
        }

        // Try to parse JSON output even if exit code is non-zero
        // Lighthouse sometimes crashes during cleanup AFTER producing valid results
        if (stdout.length > 0) {
          try {
            const result = JSON.parse(stdout);
            // Check if we got a valid Lighthouse result with categories
            if (result.categories?.accessibility) {
              if (code !== 0) {
                // Info level since Chrome crash during cleanup is expected on Railway
                log.info('Lighthouse completed with late crash - using valid results', {
                  code,
                });
              }
              resolvePromise(result);
              return;
            }
          } catch (parseError) {
            // JSON parsing failed, fall through to error handling
            log.debug('Could not parse Lighthouse stdout as JSON', {
              parseError: String(parseError),
              stdoutPreview: stdout.substring(0, 200),
            });
          }
        }

        // If we get here, we don't have valid results
        if (code !== 0) {
          reject(new LighthouseAuditError(`Lighthouse exited with code ${code}: ${stderr}`));
        } else {
          reject(new LighthouseAuditError('Lighthouse produced no valid output'));
        }
      });

      // Handle timeout
      const timeoutHandle = setTimeout(() => {
        log.warn('Lighthouse timeout - killing process', { pid, timeoutMs });
        child.kill('SIGTERM');
        // A child stuck in trace processing can ignore SIGTERM; escalate so a
        // long-lived host never accumulates zombie Lighthouse processes.
        const killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            log.warn('Lighthouse ignored SIGTERM - sending SIGKILL', { pid });
            child.kill('SIGKILL');
          }
        }, KILL_GRACE_MS);
        killTimer.unref();
        child.once('exit', () => clearTimeout(killTimer));
        reject(new LighthouseAuditError(`Lighthouse audit timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const duration = Date.now() - startTime;
    log.debug('Lighthouse CLI completed', { durationMs: duration });

    // Type assertion for lhr structure
    const lhrCategories = lhr.categories as Record<string, unknown> | undefined;
    const accessibilityCategory = lhrCategories?.accessibility as
      | {
          score: number | null;
          title: string;
          description?: string;
          manualDescription?: string;
          auditRefs: Array<{ id: string; weight: number; group?: string; acronym?: string; relevantAudits?: string[] }>;
        }
      | undefined;

    if (!accessibilityCategory) {
      throw new LighthouseAuditError('Accessibility category not found in Lighthouse results');
    }

    // Extract relevant audits
    const audits: Record<string, LighthouseA11yAudit> = {};
    const lhrAudits = lhr.audits as Record<string, Record<string, unknown>> | undefined;

    // Get audit refs from the accessibility category
    const auditRefs = accessibilityCategory.auditRefs || [];

    for (const ref of auditRefs) {
      const audit = lhrAudits?.[ref.id];
      if (audit) {
        const auditResult: LighthouseA11yAudit = {
          id: audit.id as string,
          title: audit.title as string,
          description: (audit.description as string) || '',
          score: audit.score as number | null,
          scoreDisplayMode: audit.scoreDisplayMode as string,
          displayValue: audit.displayValue as string | undefined,
          numericValue: audit.numericValue as number | undefined,
          warnings: audit.warnings as string[] | undefined,
        };

        // Extract items from details if present (for failing audits)
        const details = audit.details as { items?: Array<Record<string, unknown>> } | undefined;
        if (details && Array.isArray(details.items)) {
          auditResult.items = details.items.map((item: Record<string, unknown>) => ({
            selector: item.selector as string | undefined,
            snippet: item.snippet as string | undefined,
            explanation: item.explanation as string | undefined,
            nodeLabel: item.nodeLabel as string | undefined,
            boundingRect: item.boundingRect as LighthouseA11yAuditItem['boundingRect'],
          }));
        }

        audits[audit.id as string] = auditResult;
      }
    }

    // Calculate score (Lighthouse scores are 0-1, convert to 0-100)
    const score = Math.round((accessibilityCategory.score || 0) * 100);

    const result: LighthouseA11yResult = {
      score,
      category: {
        score: accessibilityCategory.score,
        title: accessibilityCategory.title,
        description: accessibilityCategory.description || '',
        manualDescription: accessibilityCategory.manualDescription,
        auditRefs: auditRefs.map((ref) => ({
          id: ref.id,
          weight: ref.weight,
          group: ref.group,
          acronym: ref.acronym,
          relevantAudits: ref.relevantAudits,
        })),
      },
      audits,
      timing: {
        total: duration,
      },
      finalUrl: (lhr.finalDisplayedUrl as string) || url,
      lighthouseVersion: (lhr.lighthouseVersion as string) || 'unknown',
      fetchTime: (lhr.fetchTime as string) || new Date().toISOString(),
    };

    if (categories.includes('performance')) {
      result.performance = extractPerformanceFromLhr(lhr);
    }
    if (options.includeRaw) {
      result.raw = trimLhrForOutput(lhr);
    }

    // Count passing and failing audits
    const auditValues = Object.values(audits);
    const passingAudits = auditValues.filter((a) => a.score === 1).length;
    const failingAudits = auditValues.filter((a) => a.score !== null && a.score < 1).length;
    const notApplicable = auditValues.filter((a) => a.score === null).length;

    log.info('Lighthouse audit complete', {
      durationMs: duration,
      score,
      totalAudits: auditValues.length,
      passing: passingAudits,
      failing: failingAudits,
      notApplicable,
      finalUrl: result.finalUrl,
      ...(result.performance ? { performanceScore: result.performance.score } : {}),
    });

    return result;
  }
}

// Export a singleton instance
export const lighthouseService = new LighthouseService();

// Metric audits whose numericValue feeds LighthousePerformanceMetrics. These
// audit ids have been stable across Lighthouse major versions.
const PERFORMANCE_METRIC_AUDITS: ReadonlyArray<
  readonly [auditId: string, key: keyof LighthousePerformanceMetrics, unit: 'ms' | 'unitless']
> = [
  ['first-contentful-paint', 'firstContentfulPaintMs', 'ms'],
  ['largest-contentful-paint', 'largestContentfulPaintMs', 'ms'],
  ['cumulative-layout-shift', 'cumulativeLayoutShift', 'unitless'],
  ['total-blocking-time', 'totalBlockingTimeMs', 'ms'],
  ['speed-index', 'speedIndexMs', 'ms'],
];

/**
 * Extract the typed performance summary from a raw Lighthouse result (LHR).
 *
 * Opportunities are the failing performance audits that carry an estimated
 * improvement: legacy opportunity audits report `details.overallSavingsMs` /
 * `details.overallSavingsBytes`; newer insight audits report per-metric
 * `metricSavings`, of which the largest becomes the headline ms estimate.
 *
 * @throws LighthouseAuditError when the LHR has no performance category
 */
export function extractPerformanceFromLhr(lhr: Record<string, unknown>): LighthousePerformanceResult {
  const categories = lhr.categories as Record<string, unknown> | undefined;
  const perfCategory = categories?.performance as
    { score?: number | null; auditRefs?: Array<{ id: string }> } | undefined;
  if (!perfCategory) {
    throw new LighthouseAuditError('Performance category not found in Lighthouse results');
  }

  const audits = lhr.audits as Record<string, Record<string, unknown>> | undefined;

  const metrics: LighthousePerformanceMetrics = {};
  for (const [auditId, key, unit] of PERFORMANCE_METRIC_AUDITS) {
    const numericValue = audits?.[auditId]?.numericValue;
    if (typeof numericValue !== 'number' || !Number.isFinite(numericValue)) continue;
    metrics[key] = unit === 'ms' ? Math.round(numericValue) : Math.round(numericValue * 1000) / 1000;
  }

  const opportunities: LighthousePerformanceOpportunity[] = [];
  for (const ref of perfCategory.auditRefs ?? []) {
    const audit = audits?.[ref.id];
    if (!audit) continue;
    // score >= 1 is passing; null is informative/not-applicable.
    if (typeof audit.score !== 'number' || audit.score >= 1) continue;

    const details = audit.details as Record<string, unknown> | undefined;
    const rawSavingsMs = details?.overallSavingsMs;
    let estimatedSavingsMs =
      typeof rawSavingsMs === 'number' && rawSavingsMs > 0 ? Math.round(rawSavingsMs) : undefined;
    if (estimatedSavingsMs === undefined) {
      const metricSavings = audit.metricSavings as Record<string, unknown> | undefined;
      const savings = Object.values(metricSavings ?? {}).filter((v): v is number => typeof v === 'number' && v > 0);
      if (savings.length > 0) estimatedSavingsMs = Math.round(Math.max(...savings));
    }
    const rawSavingsBytes = details?.overallSavingsBytes;
    const estimatedSavingsBytes =
      typeof rawSavingsBytes === 'number' && rawSavingsBytes > 0 ? Math.round(rawSavingsBytes) : undefined;

    if (estimatedSavingsMs === undefined && estimatedSavingsBytes === undefined) continue;
    opportunities.push({
      auditId: ref.id,
      title: typeof audit.title === 'string' ? audit.title : ref.id,
      ...(estimatedSavingsMs !== undefined ? { estimatedSavingsMs } : {}),
      ...(estimatedSavingsBytes !== undefined ? { estimatedSavingsBytes } : {}),
    });
  }
  opportunities.sort(
    (a, b) =>
      (b.estimatedSavingsMs ?? 0) - (a.estimatedSavingsMs ?? 0) ||
      (b.estimatedSavingsBytes ?? 0) - (a.estimatedSavingsBytes ?? 0),
  );

  return {
    score: typeof perfCategory.score === 'number' ? Math.round(perfCategory.score * 100) : null,
    metrics,
    opportunities: opportunities.slice(0, MAX_PERFORMANCE_OPPORTUNITIES),
  };
}

// Audits whose details carry base64 screenshot payloads (megabytes each).
const SCREENSHOT_AUDIT_IDS = ['screenshot-thumbnails', 'final-screenshot'];

/**
 * Trim an LHR for inclusion in a report: drop the full-page screenshot
 * artifact, screenshot-carrying audits, and localization tables. They
 * dominate LHR size without adding audit signal, and keeping them would make
 * `includeRaw` unsafe for bulk scanning. Does not mutate the input.
 */
export function trimLhrForOutput(lhr: Record<string, unknown>): Record<string, unknown> {
  const trimmed: Record<string, unknown> = { ...lhr };
  delete trimmed.fullPageScreenshot;
  delete trimmed.i18n;
  const audits = lhr.audits;
  if (typeof audits === 'object' && audits !== null && !Array.isArray(audits)) {
    const auditsCopy: Record<string, unknown> = { ...(audits as Record<string, unknown>) };
    for (const id of SCREENSHOT_AUDIT_IDS) delete auditsCopy[id];
    trimmed.audits = auditsCopy;
  }
  return trimmed;
}

// ============================================================================
// Compact Format for LLM Context Optimization
// ============================================================================

/**
 * Compact format for LLM consumption - minimizes token usage
 *
 * This format strips out verbose fields like HTML snippets, explanations,
 * and node labels to reduce context size while preserving essential information.
 */
export interface CompactLighthouseIssue {
  /** Lighthouse audit ID (e.g., "image-alt") */
  audit: string;
  /** WCAG success criterion (e.g., "1.1.1"), "best-practice", or "unknown" */
  wcag: string;
  /** Severity level */
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  /** Total elements affected */
  count: number;
  /** CSS selectors (max 5 per audit) */
  selectors: string[];
}

/**
 * Transform full Lighthouse issues to compact format for LLM consumption
 *
 * This reduces token usage by:
 * - Removing HTML snippets (LLM already has full HTML)
 * - Removing explanations (LLM can infer from audit type)
 * - Removing node labels (selectors are sufficient)
 * - Limiting to 5 selectors per audit type
 * - Using abbreviated field names
 *
 * @param issues - Full Lighthouse issues from transformLighthouseToIssues
 * @returns Compact issues suitable for LLM prompt inclusion
 */
export function transformToCompactFormat(issues: LighthouseIssue[]): CompactLighthouseIssue[] {
  return issues.map((issue) => ({
    audit: issue.auditId,
    wcag: isBestPracticeAudit(issue.auditId) ? 'best-practice' : issue.wcagCriteria,
    severity: issue.severity,
    count: issue.elements.length,
    selectors: issue.elements
      .slice(0, 5) // Limit to 5 selectors per audit
      .map((e) => e.selector)
      .filter((s): s is string => Boolean(s) && s !== '[unknown element]'),
  }));
}

/**
 * Estimate token count for a data structure
 *
 * Uses a simple heuristic: ~4 characters per token (rough average for mixed content)
 * This is intentionally conservative to avoid underestimating.
 *
 * @param data - Any JSON-serializable data
 * @returns Estimated token count
 */
export function estimateTokenCount(data: unknown): number {
  const json = JSON.stringify(data);
  // ~4 characters per token is a reasonable heuristic for mixed JSON content
  return Math.ceil(json.length / 4);
}

// ============================================================================
// Result Transformation Types and Functions
// ============================================================================

/**
 * Element that failed a Lighthouse accessibility audit
 */
export interface LighthouseIssueElement {
  /** CSS selector for the element */
  selector: string;
  /** HTML snippet of the element */
  snippet?: string;
  /** Why this element failed the audit */
  explanation?: string;
  /** Human-readable label for the element */
  nodeLabel?: string;
  /** Bounding rect from Lighthouse (pixel coordinates on page) */
  boundingRect?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
    width: number;
    height: number;
  };
}

/**
 * Transformed Lighthouse issue for LLM consumption
 */
export interface LighthouseIssue {
  /** Lighthouse audit ID (e.g., "image-alt") */
  auditId: string;
  /** Human-readable title (e.g., "Images do not have alt text") */
  title: string;
  /** Brief description of the issue */
  description: string;
  /** WCAG success criterion (e.g., "1.1.1"), or "unknown" for audits with none (including best-practice audits) */
  wcagCriteria: string;
  /** Issue severity level */
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  /** Elements that failed this audit */
  elements: LighthouseIssueElement[];
  /** Display value from Lighthouse (e.g., "5 elements") */
  displayValue?: string;
}

/**
 * Summary statistics for transformed Lighthouse results
 */
export interface LighthouseIssuesSummary {
  /** Total number of issues found */
  totalIssues: number;
  /** Count by severity level */
  bySeverity: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
  };
  /** Total elements affected across all issues */
  totalElements: number;
  /** Original Lighthouse accessibility score (0-100) */
  lighthouseScore: number;
  /**
   * Duration of the Lighthouse audit in milliseconds. Always set by the
   * engine; optional so results persisted before this field existed still
   * satisfy the shape.
   */
  lighthouseDurationMs?: number;
}

/**
 * Complete transformed result including issues and summary
 */
export interface LighthouseTransformedResult {
  /** List of accessibility issues */
  issues: LighthouseIssue[];
  /** Summary statistics */
  summary: LighthouseIssuesSummary;
  /**
   * Lighthouse version that produced the result (provenance for downstream
   * reports). Optional so results persisted before this field existed still
   * satisfy the shape.
   */
  lighthouseVersion?: string;
  /**
   * Performance category summary. Present only when the scan requested the
   * performance category (ScanOptions.lighthouse.categories).
   */
  performance?: LighthousePerformanceResult;
  /**
   * Trimmed raw Lighthouse result (screenshot payloads and localization
   * tables removed). Present only when requested via includeRaw.
   */
  raw?: Record<string, unknown>;
}

/**
 * Lighthouse accessibility audit ID -> WCAG success criterion, taken from the
 * WCAG tags on the axe-core rule behind each audit (Lighthouse 13, axe-core
 * 4.12). Where axe tags several criteria, the first relevant one is kept.
 * Audits axe tags best-practice have no criterion and are listed in
 * BEST_PRACTICE_RELATED_CRITERIA instead. Unlisted audits map to 'unknown'.
 */
const AUDIT_TO_WCAG: Record<string, string> = {
  // WCAG 1.1.1 - Non-text Content
  'image-alt': '1.1.1',
  'input-image-alt': '1.1.1',
  'object-alt': '1.1.1',
  'svg-img-alt': '1.1.1',
  'aria-meter-name': '1.1.1',
  'aria-progressbar-name': '1.1.1',

  // WCAG 1.2.2 - Captions (Prerecorded)
  'video-caption': '1.2.2',

  // WCAG 1.3.1 - Info and Relationships
  list: '1.3.1',
  listitem: '1.3.1',
  'definition-list': '1.3.1',
  dlitem: '1.3.1',
  'th-has-data-cells': '1.3.1',
  'td-has-header': '1.3.1',
  'td-headers-attr': '1.3.1',
  'table-fake-caption': '1.3.1',
  'aria-required-children': '1.3.1',
  'aria-required-parent': '1.3.1',

  // WCAG 1.3.5 - Identify Input Purpose
  'autocomplete-valid': '1.3.5',

  // WCAG 1.4.1 - Use of Color
  'link-in-text-block': '1.4.1',

  // WCAG 1.4.3 - Contrast (Minimum)
  'color-contrast': '1.4.3',

  // WCAG 1.4.4 - Resize Text
  'meta-viewport': '1.4.4',

  // WCAG 2.2.1 - Timing Adjustable
  'meta-refresh': '2.2.1',

  // WCAG 2.4.1 - Bypass Blocks
  bypass: '2.4.1',

  // WCAG 2.4.2 - Page Titled
  'document-title': '2.4.2',

  // WCAG 2.4.4 - Link Purpose (In Context)
  'link-name': '2.4.4',

  // WCAG 2.4.9 - Link Purpose (Link Only)
  'identical-links-same-purpose': '2.4.9',

  // WCAG 2.5.3 - Label in Name
  'label-content-name-mismatch': '2.5.3',

  // WCAG 2.5.8 - Target Size (Minimum)
  'target-size': '2.5.8',

  // WCAG 3.1.1 - Language of Page
  'html-has-lang': '3.1.1',
  'html-lang-valid': '3.1.1',
  'html-xml-lang-mismatch': '3.1.1',

  // WCAG 3.1.2 - Language of Parts
  'valid-lang': '3.1.2',

  // WCAG 3.3.2 - Labels or Instructions
  'form-field-multiple-labels': '3.3.2',

  // WCAG 4.1.2 - Name, Role, Value
  'aria-allowed-attr': '4.1.2',
  'aria-command-name': '4.1.2',
  'aria-conditional-attr': '4.1.2',
  'aria-deprecated-role': '4.1.2',
  'aria-hidden-body': '4.1.2',
  'aria-hidden-focus': '4.1.2',
  'aria-input-field-name': '4.1.2',
  'aria-prohibited-attr': '4.1.2',
  'aria-required-attr': '4.1.2',
  'aria-roles': '4.1.2',
  'aria-toggle-field-name': '4.1.2',
  'aria-tooltip-name': '4.1.2',
  'aria-valid-attr-value': '4.1.2',
  'aria-valid-attr': '4.1.2',
  'button-name': '4.1.2',
  'duplicate-id-aria': '4.1.2',
  'frame-title': '4.1.2',
  'input-button-name': '4.1.2',
  label: '4.1.2',
  'select-name': '4.1.2',
};

/**
 * Audits axe-core tags best-practice. They have no WCAG criterion of their own
 * and are never reported as WCAG failures. Each lists the criteria the same
 * problem is usually filed under (a missing <main> is typically reported
 * against 1.3.1 or 2.4.1), used only to cross-reference AI findings with
 * Lighthouse.
 */
const BEST_PRACTICE_RELATED_CRITERIA: Record<string, string[]> = {
  accesskeys: [],
  'aria-allowed-role': ['4.1.2'],
  'aria-dialog-name': ['4.1.2'],
  'aria-text': ['4.1.2'],
  'aria-treeitem-name': ['4.1.2'],
  'empty-heading': ['1.3.1', '2.4.6'],
  'heading-order': ['1.3.1'],
  'image-redundant-alt': ['1.1.1'],
  'landmark-one-main': ['1.3.1', '2.4.1'],
  'presentation-role-conflict': ['4.1.2'],
  'skip-link': ['2.4.1'],
  tabindex: ['2.4.3'],
  'table-duplicate-name': ['1.3.1'],
};

/** True when axe-core tags the audit best-practice (no WCAG criterion of its own). */
export function isBestPracticeAudit(auditId: string): boolean {
  return Object.hasOwn(BEST_PRACTICE_RELATED_CRITERIA, auditId);
}

/**
 * WCAG criteria to cross-reference AI findings against: every mapped criterion
 * Lighthouse found issues under, plus the related criteria of best-practice
 * audits. Never contains 'unknown'.
 */
export function lighthouseCrossReferenceCriteria(issues: LighthouseIssue[]): string[] {
  const criteria = new Set<string>();
  for (const issue of issues) {
    if (issue.wcagCriteria !== 'unknown') criteria.add(issue.wcagCriteria);
    for (const related of BEST_PRACTICE_RELATED_CRITERIA[issue.auditId] ?? []) criteria.add(related);
  }
  return [...criteria];
}

/**
 * Map Lighthouse score to severity level
 *
 * @param score - Lighthouse audit score (0-1, or null if not applicable)
 * @param auditId - The audit ID for special severity handling
 * @returns Severity level
 */
function mapSeverity(score: number | null, auditId?: string): 'critical' | 'serious' | 'moderate' | 'minor' {
  // Best-practice audits are not WCAG failures
  if (auditId && isBestPracticeAudit(auditId)) {
    return 'minor';
  }

  // Some audits are inherently more critical
  const criticalAudits = ['aria-hidden-body', 'html-has-lang', 'document-title', 'bypass'];
  const seriousAudits = ['color-contrast', 'image-alt', 'button-name', 'link-name', 'label'];

  if (score === null) {
    return 'moderate';
  }

  // Score of 0 means complete failure
  if (score === 0) {
    if (auditId && criticalAudits.includes(auditId)) {
      return 'critical';
    }
    if (auditId && seriousAudits.includes(auditId)) {
      return 'serious';
    }
    return 'serious';
  }

  // Partial failure (some elements passed, some failed)
  if (score < 0.5) {
    return 'moderate';
  }

  return 'minor';
}

/**
 * Format selector from Lighthouse item
 *
 * Lighthouse can provide selector as a string or nested object
 * @param item - Lighthouse audit item
 * @returns Formatted CSS selector string
 */
function formatSelector(item: LighthouseA11yAuditItem): string {
  if (item.selector) {
    return item.selector;
  }

  // Fallback to nodeLabel if no selector
  if (item.nodeLabel) {
    return `[label: ${item.nodeLabel}]`;
  }

  return '[unknown element]';
}

/**
 * Transform Lighthouse accessibility audit results into a standardized issue format
 *
 * This function processes Lighthouse results and extracts failing audits
 * into a format suitable for LLM consumption and further analysis.
 *
 * @param result - Lighthouse accessibility audit result
 * @returns Transformed result with issues and summary statistics
 */
export function transformLighthouseToIssues(result: LighthouseA11yResult): LighthouseTransformedResult {
  const issues: LighthouseIssue[] = [];

  // Process each audit
  for (const [auditId, audit] of Object.entries(result.audits)) {
    // Skip passing audits (score === 1) and not applicable audits (score === null with no items)
    if (audit.score === 1) {
      continue;
    }

    // Skip informative audits that don't indicate failures
    if (audit.scoreDisplayMode === 'informative' || audit.scoreDisplayMode === 'manual') {
      continue;
    }

    // Skip audits with null score and no failing items
    if (audit.score === null && (!audit.items || audit.items.length === 0)) {
      continue;
    }

    // Extract elements from the audit items
    const elements: LighthouseIssueElement[] = [];

    if (audit.items && audit.items.length > 0) {
      for (const item of audit.items) {
        elements.push({
          selector: formatSelector(item),
          snippet: item.snippet,
          explanation: item.explanation,
          nodeLabel: item.nodeLabel,
          boundingRect: item.boundingRect,
        });
      }
    }

    // Only include audits that have failing elements or a failing score
    if (elements.length === 0 && audit.score === null) {
      continue;
    }

    // Create the issue
    const issue: LighthouseIssue = {
      auditId,
      title: audit.title,
      description: audit.description,
      wcagCriteria: AUDIT_TO_WCAG[auditId] || 'unknown',
      severity: mapSeverity(audit.score, auditId),
      elements,
      displayValue: audit.displayValue,
    };

    issues.push(issue);
  }

  // Sort issues by severity (critical first, then serious, moderate, minor)
  const severityOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  // Calculate summary statistics
  const summary: LighthouseIssuesSummary = {
    totalIssues: issues.length,
    bySeverity: {
      critical: issues.filter((i) => i.severity === 'critical').length,
      serious: issues.filter((i) => i.severity === 'serious').length,
      moderate: issues.filter((i) => i.severity === 'moderate').length,
      minor: issues.filter((i) => i.severity === 'minor').length,
    },
    totalElements: issues.reduce((sum, issue) => sum + issue.elements.length, 0),
    lighthouseScore: result.score,
    lighthouseDurationMs: result.timing.total,
  };

  return {
    issues,
    summary,
    lighthouseVersion: result.lighthouseVersion,
    ...(result.performance ? { performance: result.performance } : {}),
    ...(result.raw ? { raw: result.raw } : {}),
  };
}
