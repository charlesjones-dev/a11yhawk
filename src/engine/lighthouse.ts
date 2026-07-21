/**
 * Lighthouse Service for accessibility audits
 *
 * This service wraps Google Lighthouse to run accessibility-only audits
 * against a page using an existing Chrome DevTools Protocol (CDP) connection.
 */
// Note: lighthouse is imported dynamically to avoid blocking module initialization
// The lighthouse package is large (~50MB) and can cause ESM/CJS issues with static imports
import type { Logger } from '../logger/index.js';
import { createLogger } from '../logger/index.js';
import { chromium } from 'playwright';

const defaultLogger = createLogger({ serviceName: 'worker' });

// Default timeout for Lighthouse audits (30 seconds)
const DEFAULT_AUDIT_TIMEOUT_MS = 30000;

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

/**
 * Service for running Lighthouse accessibility audits
 */
export class LighthouseService {
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = DEFAULT_AUDIT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Run an accessibility-only Lighthouse audit
   *
   * @param url - The URL to audit
   * @param cdpPort - Chrome DevTools Protocol port from Playwright browser
   * @param jobLogger - Optional logger for job-specific logging
   * @returns Lighthouse accessibility audit result
   * @throws LighthouseAuditError if the audit fails or times out
   */
  async runAccessibilityAudit(url: string, cdpPort?: number, jobLogger?: Logger): Promise<LighthouseA11yResult> {
    const log = jobLogger || defaultLogger;
    const startTime = Date.now();

    log.info('Lighthouse accessibility audit starting', { url, timeoutMs: this.timeoutMs, cdpPort });

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
      const args = [url, '--output=json', '--output-path=stdout', '--only-categories=accessibility', '--quiet'];

      // If CDP port is provided, connect to existing Playwright browser instead of launching new Chrome
      // This saves memory by reusing the browser instance
      if (cdpPort) {
        args.push(`--port=${cdpPort}`);
        log.debug('Connecting to existing Chrome via CDP', { cdpPort });
      } else {
        // Chrome flags optimized for containerized environments (Railway, Docker)
        // These reduce memory usage and prevent "Browser tab has unexpectedly crashed" errors
        // Note: --no-sandbox is required on Railway as it doesn't support user namespaces.
        // Security is mitigated by: non-root user, container isolation, ephemeral containers.
        const chromeFlags = [
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
        ].join(' ');

        args.push(`--chrome-flags=${chromeFlags}`);
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
        timeout: this.timeoutMs,
        env: {
          ...process.env,
          CHROME_PATH: chromePath,
        },
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
        log.warn('Lighthouse timeout - killing process', { pid, timeoutMs: this.timeoutMs });
        child.kill('SIGTERM');
        reject(new LighthouseAuditError(`Lighthouse audit timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });

    const duration = Date.now() - startTime;
    log.debug('Lighthouse CLI completed', { durationMs: duration });

    // Type assertion for lhr structure
    const categories = lhr.categories as Record<string, unknown> | undefined;
    const accessibilityCategory = categories?.accessibility as
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

    // Count passing and failing audits
    const auditValues = Object.values(audits);
    const passingAudits = auditValues.filter((a) => a.score === 1).length;
    const failingAudits = auditValues.filter((a) => a.score !== null && a.score < 1).length;
    const notApplicable = auditValues.filter((a) => a.score === null).length;

    log.info('Lighthouse accessibility audit complete', {
      durationMs: duration,
      score,
      totalAudits: auditValues.length,
      passing: passingAudits,
      failing: failingAudits,
      notApplicable,
      finalUrl: result.finalUrl,
    });

    return result;
  }
}

// Export a singleton instance
export const lighthouseService = new LighthouseService();

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
  /** WCAG success criterion (e.g., "1.1.1") */
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
    wcag: issue.wcagCriteria,
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
  /** WCAG success criterion (e.g., "1.1.1") */
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
}

/**
 * Mapping of Lighthouse audit IDs to WCAG 2.1 success criteria
 *
 * Based on Lighthouse accessibility audit documentation:
 * https://developer.chrome.com/docs/lighthouse/accessibility/
 */
const AUDIT_TO_WCAG: Record<string, string> = {
  // WCAG 1.1.1 - Non-text Content
  'image-alt': '1.1.1',
  'input-image-alt': '1.1.1',
  'object-alt': '1.1.1',
  'frame-title': '1.1.1',
  'area-alt': '1.1.1',
  'role-img-alt': '1.1.1',
  'svg-img-alt': '1.1.1',

  // WCAG 1.3.1 - Info and Relationships
  list: '1.3.1',
  listitem: '1.3.1',
  'definition-list': '1.3.1',
  dlitem: '1.3.1',
  'th-has-data-cells': '1.3.1',
  'td-headers-attr': '1.3.1',
  'table-fake-caption': '1.3.1',
  'heading-order': '1.3.1',
  'empty-heading': '1.3.1',
  'form-field-multiple-labels': '1.3.1',

  // WCAG 1.3.2 - Meaningful Sequence
  'logical-tab-order': '1.3.2',

  // WCAG 1.3.4 - Orientation
  'orientation-lock': '1.3.4',

  // WCAG 1.3.5 - Identify Input Purpose
  'autocomplete-valid': '1.3.5',

  // WCAG 1.4.1 - Use of Color
  'use-of-color': '1.4.1',

  // WCAG 1.4.3 - Contrast (Minimum)
  'color-contrast': '1.4.3',

  // WCAG 1.4.4 - Resize Text
  'meta-viewport': '1.4.4',

  // WCAG 1.4.10 - Reflow
  'content-width': '1.4.10',

  // WCAG 1.4.11 - Non-text Contrast
  'non-text-contrast': '1.4.11',

  // WCAG 1.4.12 - Text Spacing
  'text-spacing': '1.4.12',

  // WCAG 2.1.1 - Keyboard
  accesskeys: '2.1.1',
  'keyboard-focusable': '2.1.1',

  // WCAG 2.1.4 - Character Key Shortcuts
  'no-character-key-shortcuts': '2.1.4',

  // WCAG 2.2.1 - Timing Adjustable
  'meta-refresh': '2.2.1',

  // WCAG 2.2.2 - Pause, Stop, Hide
  'video-caption': '2.2.2',

  // WCAG 2.4.1 - Bypass Blocks
  bypass: '2.4.1',

  // WCAG 2.4.2 - Page Titled
  'document-title': '2.4.2',

  // WCAG 2.4.3 - Focus Order
  tabindex: '2.4.3',
  'focus-order': '2.4.3',

  // WCAG 2.4.4 - Link Purpose (In Context)
  'link-name': '2.4.4',
  'identical-links-same-purpose': '2.4.4',

  // WCAG 2.4.6 - Headings and Labels
  'label-content-name-mismatch': '2.4.6',

  // WCAG 2.4.7 - Focus Visible
  'focus-visible': '2.4.7',

  // WCAG 2.5.3 - Label in Name
  'label-in-name': '2.5.3',

  // WCAG 2.5.5 - Target Size
  'target-size': '2.5.5',

  // WCAG 3.1.1 - Language of Page
  'html-has-lang': '3.1.1',
  'html-lang-valid': '3.1.1',

  // WCAG 3.1.2 - Language of Parts
  'valid-lang': '3.1.2',

  // WCAG 4.1.1 - Parsing
  'duplicate-id-active': '4.1.1',
  'duplicate-id-aria': '4.1.1',
  'duplicate-id': '4.1.1',

  // WCAG 4.1.2 - Name, Role, Value
  'aria-allowed-attr': '4.1.2',
  'aria-allowed-role': '4.1.2',
  'aria-command-name': '4.1.2',
  'aria-dialog-name': '4.1.2',
  'aria-hidden-body': '4.1.2',
  'aria-hidden-focus': '4.1.2',
  'aria-input-field-name': '4.1.2',
  'aria-meter-name': '4.1.2',
  'aria-progressbar-name': '4.1.2',
  'aria-required-attr': '4.1.2',
  'aria-required-children': '4.1.2',
  'aria-required-parent': '4.1.2',
  'aria-roles': '4.1.2',
  'aria-text': '4.1.2',
  'aria-toggle-field-name': '4.1.2',
  'aria-tooltip-name': '4.1.2',
  'aria-treeitem-name': '4.1.2',
  'aria-valid-attr-value': '4.1.2',
  'aria-valid-attr': '4.1.2',
  'button-name': '4.1.2',
  label: '4.1.2',
  'select-name': '4.1.2',
  'input-button-name': '4.1.2',

  // WCAG 4.1.3 - Status Messages
  'aria-live': '4.1.3',
};

/**
 * Map Lighthouse score to severity level
 *
 * @param score - Lighthouse audit score (0-1, or null if not applicable)
 * @param auditId - The audit ID for special severity handling
 * @returns Severity level
 */
function mapSeverity(score: number | null, auditId?: string): 'critical' | 'serious' | 'moderate' | 'minor' {
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
  };
}
