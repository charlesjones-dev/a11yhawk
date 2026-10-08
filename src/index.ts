/**
 * A11yHawk: open-source, self-hostable web accessibility scan engine.
 *
 * Playwright page capture, Lighthouse accessibility audits, and BYOK LLM
 * analysis producing structured WCAG reports. See the README for usage.
 */
export { A11yHawkEngine, DEFAULT_ANTHROPIC_MODEL, DEFAULT_MODEL, ScanError, scan } from './engine/scan.js';
export type {
  EngineOptions,
  OneShotScanOptions,
  ScanErrorCode,
  ScanLighthouseOptions,
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
  LlmEffort,
  LlmProvider,
  ModelPricing,
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
  LighthouseCategory,
  LighthouseIssue,
  LighthouseIssueElement,
  LighthouseIssuesSummary,
  LighthousePerformanceMetrics,
  LighthousePerformanceOpportunity,
  LighthousePerformanceResult,
  LighthouseTransformedResult,
} from './engine/lighthouse.js';
export { renderHtmlReport } from './engine/html-report.js';
export { createLogger } from './logger/index.js';
export type { Logger } from './logger/index.js';
