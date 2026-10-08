/**
 * Core public types for the A11yHawk scan engine.
 *
 * The result interfaces (StructuredScanOutput and friends) are intentionally
 * shape-identical to AccessHawk's persisted scan format so hosts can adopt
 * the engine without a data migration. Keep changes additive.
 */

/** Custom request header forwarded to the scanned page. Values are plain text. */
export type ScanHeaderType = 'cookie' | 'authorization' | 'header';

export interface ScanHeader {
  type: ScanHeaderType;
  key: string;
  value: string;
}

/** Who pays for the LLM call. The OSS engine always reports 'user' (BYOK). */
export type CostType = 'service' | 'user';

/**
 * LLM provider. 'openrouter' is the OpenAI-compatible client (OpenRouter by default, or
 * any OpenAI-compatible `baseUrl`); 'anthropic' calls the Claude API directly.
 */
export type LlmProvider = 'openrouter' | 'anthropic';

/** Anthropic `output_config.effort` level. */
export type LlmEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Token prices for one model, in USD per million tokens. The Claude API reports no dollar
 * cost, so the engine estimates it from these.
 */
export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  /** Default 0.1 x inputPer1M. */
  cacheReadPer1M?: number;
  /** Default 1.25 x inputPer1M (the 5-minute cache write rate). */
  cacheWritePer1M?: number;
}

/** Token usage and cost information captured from the LLM provider. */
export interface ScanUsage {
  /** Input tokens. For Anthropic this includes cache reads and cache writes. */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Cost in USD (0 when the provider does not report cost). Anthropic cost is estimated
   * from `llm.pricing`, and is 0 when a model that ran has no entry there.
   */
  cost: number;
  costType: CostType;
  /** The model the scan requested. */
  modelId: string;
  /** Input tokens read from the prompt cache. */
  cachedTokens?: number;
  /** Input tokens written to the prompt cache (Anthropic). */
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Provider that ran the scan. */
  provider?: LlmProvider;
  /** The model that actually answered (Anthropic). Differs from `modelId` after a refusal fallback. */
  servedModelId?: string;
}

/**
 * Individual accessibility issue found during a scan.
 * Resolution-tracking fields are always initialized to their empty defaults by
 * the engine; they exist so downstream dashboards can track remediation
 * without changing the shape.
 */
export interface AccessibilityIssue {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  wcagCriteria: string;
  wcagLevel: 'A' | 'AA' | 'AAA';
  location: string;
  patternDetected: string;
  codeContext: string | null;
  impact: string;
  userImpact: string;
  recommendation: string;
  fixPriority: 'Immediate' | 'High Priority' | 'Medium Priority' | 'Low Priority';
  remediation: string;
  resolved: boolean;
  resolvedAt: Date | null;
  resolvedNote: string | null;
  resolvedByUserId: string | null;
  resolvedByDisplayName: string | null;
}

export interface PassedCheck {
  criteria: string;
  description: string;
}

/** WCAG criteria coverage information. */
export interface WCAGCoverage {
  criteriaId: string;
  name: string;
  level: 'A' | 'AA' | 'AAA';
  /**
   * True when the scan found no issues for this criterion, including criteria
   * that do not apply to the page or cannot be judged from it. Not a statement
   * that the page conforms to the criterion.
   */
  passed: boolean;
  /** Issue IDs if failed. */
  issues?: string[];
}

/** Summary statistics for scan results. */
export interface ScanStatistics {
  totalIssues: number;
  criticalIssues: number;
  highIssues: number;
  mediumIssues: number;
  lowIssues: number;
  resolvedIssues: number;
  unresolvedIssues: number;
}

/**
 * Structured scan output - the machine-readable source of truth for a scan.
 */
export interface StructuredScanOutput {
  /**
   * Percent of checked WCAG criteria with no issues found (0-100), recomputed
   * from wcagCoverage. In Lighthouse-only mode it is the Lighthouse
   * accessibility score instead, since coverage there lists failures only.
   */
  overallScore: number;
  url: string;
  /** ISO timestamp of the scan. */
  scanDate: string;
  /** WCAG standard used (e.g., "WCAG 2.1 - AA"). */
  standard: string;
  statistics: ScanStatistics;
  wcagCoverage: WCAGCoverage[];
  issues: AccessibilityIssue[];
  passedChecks: PassedCheck[];
  metadata?: {
    pageTitle?: string;
    scanDuration?: number;
    userAgent?: string;
    [key: string]: unknown;
  };
  /**
   * WCAG criteria Lighthouse found issues under, for cross-referencing with AI
   * findings. Also includes the related criteria of best-practice audits (such
   * as 1.3.1 and 2.4.1 for a missing main landmark), which have no criterion
   * of their own.
   */
  lighthouseWcagCriteria?: string[];
}

/** LLM generation parameters. */
export interface GenerationParams {
  /** OpenRouter only: current Claude models reject non-default sampling values. */
  temperature?: number;
  /** OpenRouter only. */
  topP?: number;
  /** OpenRouter only: the Claude API has no frequency penalty. */
  frequencyPenalty?: number;
  maxTokens?: number;
  /** Anthropic only: sent as `output_config.effort`, and left out of the request when unset. */
  effort?: LlmEffort;
}

export type WcagVersion = '2.0' | '2.1' | '2.2';
export type WcagLevel = 'A' | 'AA' | 'AAA';
