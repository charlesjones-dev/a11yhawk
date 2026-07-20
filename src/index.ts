/**
 * A11yHawk: open-source, self-hostable web accessibility scan engine.
 *
 * Playwright page capture, Lighthouse accessibility audits, and BYOK LLM
 * analysis producing structured WCAG reports. See the README for usage.
 */
export { A11yHawkEngine, DEFAULT_MODEL, ScanError, scan } from './engine/scan.js';
export type {
  EngineOptions,
  OneShotScanOptions,
  ScanErrorCode,
  ScanLlmOptions,
  ScanOptions,
  ScanProgressEvent,
  ScanReport,
  ScanStage,
} from './engine/scan.js';
export type {
  AccessibilityIssue,
  CostType,
  GenerationParams,
  PassedCheck,
  ScanHeader,
  ScanHeaderType,
  ScanStatistics,
  ScanUsage,
  StructuredScanOutput,
  WCAGCoverage,
  WcagLevel,
  WcagVersion,
} from './types.js';
export type { PageAnalysisResult } from './engine/playwright.js';
export type {
  LighthouseIssue,
  LighthouseIssueElement,
  LighthouseIssuesSummary,
  LighthouseTransformedResult,
} from './engine/lighthouse.js';
export { renderHtmlReport } from './engine/html-report.js';
export { createLogger } from './logger/index.js';
export type { Logger } from './logger/index.js';
