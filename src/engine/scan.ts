/**
 * Scan pipeline orchestrator.
 *
 * Runs a single URL through: validate -> Playwright capture -> Lighthouse
 * audit -> LLM analysis -> parse/recompute -> markdown -> annotate, and
 * returns everything as buffers and data. No queue, no database, no object
 * storage: persistence is the caller's concern.
 *
 * Two modes:
 * - LLM mode (options.llm present): full AI analysis, Lighthouse findings
 *   feed the prompt when available (Lighthouse failure is non-blocking).
 * - Lighthouse-only mode (options.llm absent): deterministic audit, no API
 *   key needed; the structured report is built from Lighthouse findings and
 *   Lighthouse failure is fatal because it is the only analysis source.
 */
import { createLogger, type Logger } from '../logger/index.js';
import type {
  AccessibilityIssue,
  GenerationParams,
  ScanHeader,
  ScanUsage,
  StructuredScanOutput,
  WcagLevel,
  WcagVersion,
} from '../types.js';
import { annotateScreenshot } from './annotator.js';
import {
  isBestPracticeAudit,
  LIGHTHOUSE_CATEGORY_VALUES,
  lighthouseCrossReferenceCriteria,
  lighthouseService,
  transformLighthouseToIssues,
  type LighthouseCategory,
  type LighthouseIssue,
  type LighthouseTransformedResult,
} from './lighthouse.js';
import { LLMService } from './llm.js';
import { generateMarkdownFromStructured } from './markdown-generator.js';
import { PlaywrightService } from './playwright.js';
import { buildJsonScanPrompt, findWcagCriterion, getWcagCriteria, SCAN_JSON_SYSTEM_PROMPT } from './prompts.js';
import { BlockedRequestError, checkRequestTarget } from './request-guard.js';
import { validateUrl } from './url-validator.js';

/**
 * Default LLM model (OpenRouter id). Always overridable via options.llm.model.
 */
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5';

const DEFAULT_GENERATION_PARAMS: Required<GenerationParams> = {
  temperature: 0.2,
  topP: 0.95,
  frequencyPenalty: 0,
  maxTokens: 64000,
};

export type ScanErrorCode =
  | 'invalid-options'
  | 'invalid-url'
  | 'blocked-request'
  | 'capture-failed'
  | 'lighthouse-failed'
  | 'llm-auth'
  | 'llm-rate-limit'
  | 'llm-failed'
  | 'llm-malformed';

/**
 * Error thrown by the scan pipeline. `retryable` tells queue-based hosts
 * whether re-running the same job could succeed (transient failure) or is
 * pointless (bad input, auth, malformed output).
 */
export class ScanError extends Error {
  readonly code: ScanErrorCode;
  readonly retryable: boolean;

  constructor(code: ScanErrorCode, message: string, retryable: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ScanError';
    this.code = code;
    this.retryable = retryable;
  }
}

export type ScanStage =
  'validating' | 'capturing' | 'auditing' | 'analyzing' | 'processing' | 'annotating' | 'complete' | 'failed';

export interface ScanProgressEvent {
  stage: ScanStage;
  message: string;
  timestamp: number;
  /** Base64 JPEG preview, sent once during 'capturing'. */
  screenshot?: string;
}

export interface ScanLlmOptions {
  /** API key for an OpenAI-compatible endpoint (OpenRouter by default). */
  apiKey: string;
  /** Model id, e.g. an OpenRouter id. Defaults to DEFAULT_MODEL. */
  model?: string;
  /** OpenAI-compatible endpoint base URL. Defaults to OpenRouter. */
  baseUrl?: string;
  httpReferer?: string;
  appTitle?: string;
  generationParams?: GenerationParams;
  /** Verbose prompt/response logging. */
  debug?: boolean;
}

/** Object form of ScanOptions.lighthouse for configuring the audit. */
export interface ScanLighthouseOptions {
  /**
   * Lighthouse categories to run, all from a single subprocess run and a
   * single page load. Must include 'accessibility': it is the analysis
   * source for the structured report. Default ['accessibility'].
   */
  categories?: LighthouseCategory[];
  /**
   * Attach the trimmed raw Lighthouse result (screenshot payloads and
   * localization tables removed) to report.lighthouse.raw, for audits the
   * engine does not map. Default false.
   */
  includeRaw?: boolean;
}

export interface ScanOptions {
  /** Omit entirely for Lighthouse-only mode (no API key required). */
  llm?: ScanLlmOptions;
  /** Default '2.1'. */
  wcagVersion?: WcagVersion;
  /** Default 'AA'. */
  wcagLevel?: WcagLevel;
  /** Custom request headers forwarded to the scanned page (plain values). */
  headers?: ScanHeader[];
  /**
   * Run the Lighthouse audit. Pass an object to select categories or opt in
   * to the raw result; `true` and `{}` both mean the accessibility-only
   * default. Default true.
   */
  lighthouse?: boolean | ScanLighthouseOptions;
  /**
   * Capture the full-page screenshot. Disable in Lighthouse-only mode for
   * bulk scanning: capture, tiling, and annotation are skipped and
   * report.screenshot / report.annotatedScreenshot are null, keeping memory
   * flat across thousands of sequential scans. Cannot be disabled in LLM
   * mode, where the screenshot feeds the visual analysis. Default true.
   */
  screenshot?: boolean;
  /** Draw issue bounding boxes on a copy of the screenshot. Default true. */
  annotate?: boolean;
  onProgress?: (event: ScanProgressEvent) => void;
  logger?: Logger;
}

export interface EngineOptions {
  /**
   * Permit scanning targets on private/loopback networks. Default false.
   * The SSRF request guard stays active either way; this only widens which
   * resolved addresses it accepts. Leave false when scan URLs come from
   * untrusted users.
   */
  allowPrivateNetworks?: boolean;
  browser?: {
    /** Launch Chromium with --no-sandbox (required on some container hosts). */
    disableSandbox?: boolean;
    debug?: boolean;
  };
  logger?: Logger;
}

export type OneShotScanOptions = ScanOptions & EngineOptions;

export interface ScanReport {
  structured: StructuredScanOutput;
  markdown: string;
  /** Full-page JPEG screenshot. */
  screenshot: Buffer | null;
  /** Screenshot with severity-colored issue boxes, when annotation ran. */
  annotatedScreenshot: Buffer | null;
  lighthouse: LighthouseTransformedResult | null;
  /** Token usage and cost. Null in Lighthouse-only mode. */
  usage: ScanUsage | null;
  /** Guard-validated post-redirect URL that was actually analyzed. */
  finalUrl: string;
  durationMs: number;
}

const SEVERITY_FROM_LIGHTHOUSE: Record<LighthouseIssue['severity'], AccessibilityIssue['severity']> = {
  critical: 'critical',
  serious: 'high',
  moderate: 'medium',
  minor: 'low',
};

const FIX_PRIORITY_FROM_SEVERITY: Record<AccessibilityIssue['severity'], AccessibilityIssue['fixPriority']> = {
  critical: 'Immediate',
  high: 'High Priority',
  medium: 'Medium Priority',
  low: 'Low Priority',
};

/** Fill engine-owned defaults the LLM does not (and should not) produce. */
function normalizeIssue(issue: Partial<AccessibilityIssue>, index: number): AccessibilityIssue {
  return {
    id: issue.id || `issue-${index + 1}`,
    title: issue.title || 'Untitled issue',
    severity: issue.severity || 'medium',
    wcagCriteria: issue.wcagCriteria || '',
    wcagLevel: issue.wcagLevel || 'A',
    location: issue.location || '',
    patternDetected: issue.patternDetected || '',
    codeContext: issue.codeContext ?? null,
    impact: issue.impact || '',
    userImpact: issue.userImpact || '',
    recommendation: issue.recommendation || '',
    fixPriority: issue.fixPriority || FIX_PRIORITY_FROM_SEVERITY[issue.severity || 'medium'],
    remediation: issue.remediation || '',
    resolved: false,
    resolvedAt: null,
    resolvedNote: null,
    resolvedByUserId: null,
    resolvedByDisplayName: null,
  };
}

/** Resolved per-scan Lighthouse settings; null when the audit is disabled. */
interface ResolvedLighthouseConfig {
  categories: LighthouseCategory[];
  includeRaw: boolean;
}

/**
 * Normalize ScanOptions.lighthouse (boolean | object) into run settings.
 * Throws invalid-options on a bad category list so misconfiguration fails
 * before any browser work. Exported for the server's request sanitizer,
 * which applies the same rule at request time; not part of the public API.
 */
export function resolveLighthouseConfig(option: ScanOptions['lighthouse']): ResolvedLighthouseConfig | null {
  if (option === false) return null;
  if (option === undefined || option === true) {
    return { categories: ['accessibility'], includeRaw: false };
  }

  // Validate as plain strings: JS callers can pass anything at runtime.
  const known = LIGHTHOUSE_CATEGORY_VALUES as readonly string[];
  const categories = [...new Set<string>(option.categories ?? ['accessibility'])];
  if (categories.length === 0) {
    throw new ScanError(
      'invalid-options',
      "lighthouse.categories must not be empty. Omit it (or pass ['accessibility']) for the default audit.",
      false,
    );
  }
  const unknown = categories.filter((c) => !known.includes(c));
  if (unknown.length > 0) {
    throw new ScanError(
      'invalid-options',
      `Unknown lighthouse categories: ${unknown.join(', ')}. Supported: ${LIGHTHOUSE_CATEGORY_VALUES.join(', ')}.`,
      false,
    );
  }
  if (!categories.includes('accessibility')) {
    throw new ScanError(
      'invalid-options',
      "lighthouse.categories must include 'accessibility': it is the analysis source for the structured report.",
      false,
    );
  }
  // Canonical order keeps the subprocess argv deterministic.
  categories.sort((a, b) => known.indexOf(a) - known.indexOf(b));
  return { categories: categories as LighthouseCategory[], includeRaw: option.includeRaw === true };
}

/**
 * Reject an `llm.baseUrl` that is not http(s) or that points at a private, loopback, or
 * link-local host, unless private networks are allowed. The endpoint receives the API key
 * and the scan data, so a caller-chosen URL could otherwise turn the engine into a proxy
 * onto internal services. Throws invalid-options. Exported for the server's request
 * sanitizer, which applies the same rule at request time; not part of the public API.
 */
export async function assertLlmBaseUrlAllowed(baseUrl: string, allowPrivateNetworks: boolean): Promise<void> {
  const verdict = await checkRequestTarget(baseUrl, { allowPrivateNetworks });
  if (!verdict.allowed) {
    // Deliberately generic: the verdict can name the private address a hostname resolves
    // to, and a server client must not be able to map internal DNS names this way.
    throw new ScanError(
      'invalid-options',
      'llm.baseUrl is not allowed: it must be an http(s) URL on a public address unless private networks are allowed.',
      false,
    );
  }
}

/** The `standard` string recorded on a scan, e.g. "WCAG 2.1 - AA". */
function formatStandard(wcagVersion: WcagVersion, wcagLevel: WcagLevel): string {
  return `WCAG ${wcagVersion} - ${wcagLevel}`;
}

/**
 * Build a structured report from Lighthouse findings alone (no-LLM mode).
 * Exported for tests; not part of the public API.
 */
export function buildStructuredFromLighthouse(
  lighthouse: LighthouseTransformedResult,
  url: string,
  wcagVersion: WcagVersion,
  wcagLevel: WcagLevel,
  pageTitle: string,
): StructuredScanOutput {
  // Criteria in the requested version and level. Lighthouse runs the same
  // audits for every standard, so some map to criteria outside it (2.5.8 is
  // WCAG 2.2 only; 2.4.9 is AAA).
  const requested = new Map(getWcagCriteria(wcagVersion, wcagLevel).map((c) => [c.id, c]));

  const issues = lighthouse.issues.map((lhIssue, i) => {
    const element = lhIssue.elements[0];
    const criterion = findWcagCriterion(lhIssue.wcagCriteria);
    // Best-practice audits and criteria outside the requested standard are not
    // failures of that standard: report them as low, never as a failed criterion.
    let wcagCriteria = lhIssue.wcagCriteria;
    let severity = SEVERITY_FROM_LIGHTHOUSE[lhIssue.severity];
    if (isBestPracticeAudit(lhIssue.auditId)) {
      wcagCriteria = 'Best practice';
    } else if (criterion && !requested.has(criterion.id)) {
      wcagCriteria = `Outside WCAG ${wcagVersion} Level ${wcagLevel}: ${criterion.id} ${criterion.title}`;
      severity = 'low';
    }
    return normalizeIssue(
      {
        id: `lh-${lhIssue.auditId}-${i + 1}`,
        title: lhIssue.title,
        severity,
        wcagCriteria,
        wcagLevel: criterion?.level,
        location: element?.selector || '',
        patternDetected: lhIssue.auditId,
        codeContext: element?.snippet ?? null,
        impact: lhIssue.description,
        userImpact: element?.explanation || lhIssue.description,
        recommendation: lhIssue.description,
        remediation: lhIssue.description,
        fixPriority: FIX_PRIORITY_FROM_SEVERITY[severity],
      },
      i,
    );
  });

  const failedCriteria = new Map<string, string[]>();
  for (const issue of issues) {
    if (!requested.has(issue.wcagCriteria)) continue; // best practice, outside the standard, or unmapped
    const ids = failedCriteria.get(issue.wcagCriteria) ?? [];
    ids.push(issue.id);
    failedCriteria.set(issue.wcagCriteria, ids);
  }

  return {
    overallScore: lighthouse.summary.lighthouseScore ?? 0,
    url,
    scanDate: new Date().toISOString(),
    standard: formatStandard(wcagVersion, wcagLevel),
    statistics: {
      totalIssues: issues.length,
      criticalIssues: issues.filter((i) => i.severity === 'critical').length,
      highIssues: issues.filter((i) => i.severity === 'high').length,
      mediumIssues: issues.filter((i) => i.severity === 'medium').length,
      lowIssues: issues.filter((i) => i.severity === 'low').length,
      resolvedIssues: 0,
      unresolvedIssues: issues.length,
    },
    // Lighthouse only observes failures; it cannot attest that other criteria
    // passed, so coverage lists failed criteria only.
    wcagCoverage: [...failedCriteria.entries()].map(([criteriaId, issueIds]) => {
      const criterion = requested.get(criteriaId);
      return {
        criteriaId,
        name: criterion?.title ?? criteriaId,
        level: criterion?.level ?? 'A',
        passed: false,
        issues: issueIds,
      };
    }),
    issues,
    passedChecks: [],
    metadata: { pageTitle, engineMode: 'lighthouse-only' },
    lighthouseWcagCriteria: lighthouseCrossReferenceCriteria(lighthouse.issues),
  };
}

/**
 * Reusable scan engine. Construction is cheap; the browser launches lazily on
 * the first scan and is recycled across scans, so hosts running many scans
 * should hold one engine instance rather than calling the one-shot scan().
 */
export class A11yHawkEngine {
  private readonly playwright: PlaywrightService;
  private readonly logger: Logger;
  private readonly allowPrivateNetworks: boolean;

  constructor(options: EngineOptions = {}) {
    this.allowPrivateNetworks = options.allowPrivateNetworks ?? false;
    this.logger = options.logger ?? createLogger();
    this.playwright = new PlaywrightService({
      allowPrivateNetworks: this.allowPrivateNetworks,
      disableSandbox: options.browser?.disableSandbox ?? false,
      debug: options.browser?.debug ?? false,
    });
  }

  /** Maximum concurrent page analyses (1-10). */
  setConcurrency(concurrency: number): void {
    this.playwright.setConcurrency(concurrency);
  }

  /** Shut down the browser. The engine can be reused; the next scan relaunches. */
  async close(): Promise<void> {
    await this.playwright.cleanup();
  }

  async scan(url: string, options: ScanOptions = {}): Promise<ScanReport> {
    const startTime = Date.now();
    const log = options.logger ?? this.logger;
    const llmMode = options.llm !== undefined;
    // Throws invalid-options on a bad category list, before any browser work.
    const lighthouseConfig = resolveLighthouseConfig(options.lighthouse);
    const captureScreenshot = options.screenshot !== false;
    const wcagVersion = options.wcagVersion ?? '2.1';
    const wcagLevel = options.wcagLevel ?? 'AA';
    // Format is parsed by the prompt builder; keep "WCAG <version> - <level>".
    const standard = formatStandard(wcagVersion, wcagLevel);

    const emit = (stage: ScanStage, message: string, screenshot?: string): void => {
      try {
        options.onProgress?.({ stage, message, timestamp: Date.now(), ...(screenshot ? { screenshot } : {}) });
      } catch (callbackError) {
        log.warn('onProgress callback threw; continuing scan', {
          errorMessage: callbackError instanceof Error ? callbackError.message : String(callbackError),
        });
      }
    };

    if (!llmMode && lighthouseConfig === null) {
      throw new ScanError(
        'invalid-options',
        'Nothing to run: provide options.llm for AI analysis or leave lighthouse enabled.',
        false,
      );
    }

    if (llmMode && !captureScreenshot) {
      throw new ScanError(
        'invalid-options',
        'screenshot: false requires Lighthouse-only mode: the LLM analysis needs the screenshot for visual checks.',
        false,
      );
    }

    let browserAcquired = false;
    try {
      // Validate at scan time, not just enqueue time: a low-TTL DNS record can
      // be re-pointed at an internal address between validation and execution
      // (DNS rebinding). With allowPrivateNetworks the structural checks still
      // run via the request guard; here we only require a well-formed http(s)
      // URL.
      emit('validating', 'Validating URL...');
      if (this.allowPrivateNetworks) {
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new ScanError('invalid-url', `Invalid URL: ${url}`, false);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new ScanError('invalid-url', `Unsupported protocol: ${parsed.protocol}`, false);
        }
      } else {
        const validation = await validateUrl(url);
        if (!validation.valid) {
          throw new ScanError('invalid-url', `Scan URL failed security validation: ${validation.error}`, false);
        }
      }
      // Checked before any browser work so a refused endpoint fails fast and is not
      // retried. LLMService's guarded agent re-checks every connection at request time.
      if (options.llm?.baseUrl !== undefined) {
        await assertLlmBaseUrlAllowed(options.llm.baseUrl, this.allowPrivateNetworks);
      }

      // Capture phase. The browser is shared across capture, the Lighthouse
      // audit (reconnects via CDP port), and annotation; released in finally.
      emit('capturing', 'Launching browser...');
      await this.playwright.acquireBrowser(log);
      browserAcquired = true;

      const modelForTiling = options.llm?.model ?? DEFAULT_MODEL;
      const pageData = await this.playwright
        .analyzePage(
          url,
          modelForTiling,
          (message) => emit('capturing', message),
          (screenshot) => emit('capturing', 'Screenshot captured', screenshot),
          options.headers,
          log,
          { captureScreenshot },
        )
        .catch((error: unknown) => {
          // A blocked navigation or redirect is an attack or misconfiguration,
          // not a transient failure.
          if (error instanceof BlockedRequestError) {
            throw new ScanError('blocked-request', error.message, false, { cause: error });
          }
          throw new ScanError(
            'capture-failed',
            `Page capture failed: ${error instanceof Error ? error.message : String(error)}`,
            true,
            { cause: error },
          );
        });

      // Lighthouse audit phase. Non-blocking in LLM mode, fatal in
      // Lighthouse-only mode where it is the sole analysis source.
      let lighthouseResult: LighthouseTransformedResult | null = null;
      if (lighthouseConfig) {
        emit(
          'auditing',
          lighthouseConfig.categories.includes('performance')
            ? 'Running Lighthouse accessibility + performance audit...'
            : 'Running Lighthouse accessibility audit...',
        );
        try {
          const cdpPort = this.playwright.getCDPPort() ?? undefined;

          // Lighthouse navigates outside the Playwright request guard (it
          // drives its own browser target), so audit the guard-validated final
          // URL and re-validate it immediately before the run to narrow the
          // DNS-rebinding window. Skipped when private networks are allowed.
          const lighthouseTarget = pageData.finalUrl || url;
          if (!this.allowPrivateNetworks) {
            const targetValidation = await validateUrl(lighthouseTarget);
            if (!targetValidation.valid) {
              throw new Error(`Lighthouse target failed security re-validation: ${targetValidation.error}`);
            }
          }

          const rawResult = await lighthouseService.runAudit(
            lighthouseTarget,
            { cdpPort, categories: lighthouseConfig.categories, includeRaw: lighthouseConfig.includeRaw },
            log,
          );
          lighthouseResult = transformLighthouseToIssues(rawResult);
          log.info('Lighthouse audit complete', {
            issueCount: lighthouseResult.issues.length,
            lighthouseScore: lighthouseResult.summary.lighthouseScore,
            durationMs: rawResult.timing.total,
          });
        } catch (lighthouseError) {
          const errorMessage = lighthouseError instanceof Error ? lighthouseError.message : String(lighthouseError);
          if (!llmMode) {
            throw new ScanError('lighthouse-failed', `Lighthouse audit failed: ${errorMessage}`, true, {
              cause: lighthouseError,
            });
          }
          log.warn('Lighthouse audit failed, continuing with LLM-only analysis', { errorMessage });
        }
      }

      // Analysis phase: LLM or Lighthouse-only.
      let structuredData: StructuredScanOutput;
      let usage: ScanUsage | null = null;

      if (llmMode && options.llm) {
        const llm = options.llm;
        const model = llm.model ?? DEFAULT_MODEL;
        emit('analyzing', `Analyzing with ${model}...`);

        const userPrompt = await buildJsonScanPrompt(
          url,
          pageData.accessibilityTree,
          pageData.html,
          standard,
          lighthouseResult?.issues,
          pageData.screenshotTiles?.length,
          log,
        );

        const llmService = new LLMService({
          baseUrl: llm.baseUrl,
          httpReferer: llm.httpReferer,
          appTitle: llm.appTitle,
          debug: llm.debug,
          allowPrivateNetworks: this.allowPrivateNetworks,
        });

        const generationParams = llm.generationParams
          ? { ...DEFAULT_GENERATION_PARAMS, ...llm.generationParams }
          : undefined;

        emit('analyzing', `Sending scan data to ${model} (this may take several minutes)...`);
        const scanResult = await llmService
          .generateScan(
            userPrompt,
            SCAN_JSON_SYSTEM_PROMPT,
            model,
            llm.apiKey,
            pageData.screenshotTiles,
            log,
            generationParams,
          )
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            if (/api key invalid|401|unauthorized/i.test(message)) {
              throw new ScanError('llm-auth', message, false, { cause: error });
            }
            if (/rate limit|429/i.test(message)) {
              throw new ScanError('llm-rate-limit', message, false, { cause: error });
            }
            throw new ScanError('llm-failed', `LLM analysis failed: ${message}`, true, { cause: error });
          });

        // Clear large captures no longer needed after the LLM call; combined
        // they can hold 10-30 MB. The screenshot buffer stays: it is part of
        // the returned report.
        pageData.screenshotTiles = [];
        pageData.html = '';
        pageData.accessibilityTree = null as unknown as typeof pageData.accessibilityTree;

        if (scanResult.usage) {
          usage = {
            promptTokens: scanResult.usage.promptTokens,
            completionTokens: scanResult.usage.completionTokens,
            totalTokens: scanResult.usage.totalTokens,
            cost: scanResult.usage.cost,
            costType: 'user',
            modelId: scanResult.usage.modelId,
            cachedTokens: scanResult.usage.cachedTokens,
            reasoningTokens: scanResult.usage.reasoningTokens,
          };
        }

        emit('processing', 'Processing scan results...');
        structuredData = this.parseStructuredOutput(scanResult.content, lighthouseResult, log);
      } else {
        // Lighthouse-only mode. lighthouseResult is guaranteed here: the audit
        // either succeeded or threw ScanError above.
        emit('processing', 'Processing Lighthouse results...');
        structuredData = buildStructuredFromLighthouse(
          lighthouseResult as LighthouseTransformedResult,
          url,
          wcagVersion,
          wcagLevel,
          pageData.title,
        );
        pageData.screenshotTiles = [];
        pageData.html = '';
        pageData.accessibilityTree = null as unknown as typeof pageData.accessibilityTree;
      }

      const markdown = generateMarkdownFromStructured(structuredData, { lighthouseResult });

      // Annotation phase (non-blocking: failure never breaks the scan).
      let annotatedBuffer: Buffer | null = null;
      if (options.annotate !== false && pageData.screenshotBuffer && structuredData.issues.length > 0) {
        try {
          emit('annotating', 'Highlighting issues on screenshot...');
          const annotationResult = await annotateScreenshot({
            screenshotBuffer: pageData.screenshotBuffer,
            issues: structuredData.issues,
            // Re-navigate to the guard-validated final URL so annotation does
            // not re-walk the original redirect chain.
            url: pageData.finalUrl || url,
            playwrightService: this.playwright,
            customHeaders: options.headers,
            // Headers stay scoped to the origin the caller asked to scan, even
            // when the page redirected elsewhere.
            headerScopeUrl: url,
            jobLogger: log,
          });
          annotatedBuffer = annotationResult.annotatedBuffer;
          log.info('Screenshot annotation complete', {
            annotationCount: annotationResult.annotationCount,
            unresolvedCount: annotationResult.unresolvedCount,
            durationMs: annotationResult.durationMs,
          });
        } catch (annotationError) {
          log.warn('Screenshot annotation failed, continuing with original', {
            errorMessage: annotationError instanceof Error ? annotationError.message : String(annotationError),
          });
        }
      }

      const durationMs = Date.now() - startTime;
      emit('complete', 'Scan complete');
      return {
        structured: structuredData,
        markdown,
        screenshot: pageData.screenshotBuffer ?? null,
        annotatedScreenshot: annotatedBuffer,
        lighthouse: lighthouseResult,
        usage,
        finalUrl: pageData.finalUrl || url,
        durationMs,
      };
    } catch (error) {
      const scanError =
        error instanceof ScanError
          ? error
          : new ScanError('capture-failed', error instanceof Error ? error.message : String(error), true, {
              cause: error,
            });
      emit('failed', scanError.message);
      throw scanError;
    } finally {
      if (browserAcquired) {
        await this.playwright.releaseBrowser(log);
      }
    }
  }

  /**
   * Parse the LLM's JSON response and enforce internal consistency. The LLM
   * may return an arbitrary score or severity counts; both are recomputed
   * from the data it actually produced.
   */
  private parseStructuredOutput(
    content: string,
    lighthouseResult: LighthouseTransformedResult | null,
    log: Logger,
  ): StructuredScanOutput {
    try {
      let cleanJson = content.trim();
      if (cleanJson.startsWith('```json')) {
        cleanJson = cleanJson.replace(/^```json\s*\n/, '').replace(/\n```\s*$/, '');
      } else if (cleanJson.startsWith('```')) {
        cleanJson = cleanJson.replace(/^```\s*\n/, '').replace(/\n```\s*$/, '');
      }

      const firstBrace = cleanJson.indexOf('{');
      const lastBrace = cleanJson.lastIndexOf('}');
      if (firstBrace === -1 || lastBrace === -1) {
        throw new Error('No JSON object found in LLM response');
      }
      cleanJson = cleanJson.substring(firstBrace, lastBrace + 1);

      const structuredData = JSON.parse(cleanJson) as StructuredScanOutput;
      if (!structuredData.url || !structuredData.issues || !structuredData.statistics) {
        throw new Error('Invalid structured data: missing required fields');
      }

      structuredData.issues = structuredData.issues.map((issue, i) => normalizeIssue(issue, i));

      // Recalculate overallScore from wcagCoverage so the score always matches
      // the share of checked criteria with no issues found.
      if (structuredData.wcagCoverage && structuredData.wcagCoverage.length > 0) {
        const passedCriteria = structuredData.wcagCoverage.filter((c) => c.passed).length;
        structuredData.overallScore = Math.round((passedCriteria / structuredData.wcagCoverage.length) * 100);
      }

      // Recalculate statistics from the actual issues array.
      const issues = structuredData.issues;
      structuredData.statistics = {
        totalIssues: issues.length,
        criticalIssues: issues.filter((i) => i.severity === 'critical').length,
        highIssues: issues.filter((i) => i.severity === 'high').length,
        mediumIssues: issues.filter((i) => i.severity === 'medium').length,
        lowIssues: issues.filter((i) => i.severity === 'low').length,
        resolvedIssues: 0,
        unresolvedIssues: issues.length,
      };

      // Lighthouse criteria for cross-referencing with AI findings.
      if (lighthouseResult?.issues && lighthouseResult.issues.length > 0) {
        structuredData.lighthouseWcagCriteria = lighthouseCrossReferenceCriteria(lighthouseResult.issues);
      }

      log.info('Parsed structured scan data', {
        issueCount: structuredData.issues.length,
        overallScore: structuredData.overallScore,
      });
      return structuredData;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error('Failed to parse LLM JSON response', {
        errorMessage,
        rawOutputPreview: content.substring(0, 500),
      });
      throw new ScanError(
        'llm-malformed',
        `Failed to parse LLM response as JSON: ${errorMessage}. The model may not support JSON output properly.`,
        false,
        { cause: error },
      );
    }
  }
}

/**
 * One-shot convenience: constructs an engine, scans, and shuts the browser
 * down. For repeated scans hold an A11yHawkEngine instead.
 */
export async function scan(url: string, options: OneShotScanOptions = {}): Promise<ScanReport> {
  const engine = new A11yHawkEngine(options);
  try {
    return await engine.scan(url, options);
  } finally {
    await engine.close();
  }
}
