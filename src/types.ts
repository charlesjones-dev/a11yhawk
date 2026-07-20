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

/** Token usage and cost information captured from the LLM provider. */
export interface ScanUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Cost in USD (0 when the provider does not report cost). */
  cost: number;
  costType: CostType;
  modelId: string;
  cachedTokens?: number;
  reasoningTokens?: number;
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
  /** Overall accessibility score (0-100). */
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
  /** WCAG criteria detected by Lighthouse (for cross-referencing with AI findings). */
  lighthouseWcagCriteria?: string[];
}

/** LLM generation parameters. */
export interface GenerationParams {
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  maxTokens?: number;
}

export type WcagVersion = '2.0' | '2.1' | '2.2';
export type WcagLevel = 'A' | 'AA' | 'AAA';
