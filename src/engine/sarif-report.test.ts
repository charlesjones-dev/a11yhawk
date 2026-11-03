import { describe, expect, it } from 'vitest';

import type { AccessibilityIssue, StructuredScanOutput } from '../types.js';
import type { ScanReport } from './scan.js';
import { renderSarifReport } from './sarif-report.js';

function makeIssue(overrides: Partial<AccessibilityIssue>): AccessibilityIssue {
  return {
    id: 'A-001',
    title: 'Image missing alt text',
    severity: 'critical',
    wcagCriteria: '1.1.1 Non-text Content',
    wcagLevel: 'A',
    location: 'main > img.logo',
    patternDetected: 'image-alt',
    codeContext: '<img class="logo" src="/logo.png">',
    impact: 'The image has no text alternative.',
    userImpact: 'Blind users cannot tell what the logo represents.',
    recommendation: 'Add a descriptive alt attribute.',
    fixPriority: 'Immediate',
    remediation: '<img class="logo" src="/logo.png" alt="Acme home">',
    resolved: false,
    resolvedAt: null,
    resolvedNote: null,
    resolvedByUserId: null,
    resolvedByDisplayName: null,
    ...overrides,
  };
}

function makeReport(issues: AccessibilityIssue[]): ScanReport {
  const structured: StructuredScanOutput = {
    overallScore: 62,
    url: 'https://example.com/pricing',
    scanDate: '2026-07-19T14:30:00.000Z',
    standard: 'WCAG 2.1 - AA',
    statistics: {
      totalIssues: issues.length,
      criticalIssues: 0,
      highIssues: 0,
      mediumIssues: 0,
      lowIssues: 0,
      resolvedIssues: 0,
      unresolvedIssues: issues.length,
    },
    wcagCoverage: [],
    issues,
    passedChecks: [],
  };
  return {
    structured,
    markdown: '',
    screenshot: null,
    annotatedScreenshot: null,
    lighthouse: null,
    usage: null,
    finalUrl: structured.url,
    durationMs: 1,
  };
}

interface SarifRun {
  tool: { driver: { name: string; rules: Array<{ id: string; shortDescription: { text: string } }> } };
  results: Array<{
    ruleId: string;
    ruleIndex: number;
    level: string;
    message: { text: string };
    locations: Array<{
      physicalLocation: { artifactLocation: { uri: string } };
      logicalLocations?: Array<{ fullyQualifiedName: string }>;
    }>;
    partialFingerprints: { primaryLocationLineHash: string };
    suppressions?: Array<{ kind: string; justification?: string }>;
  }>;
}

function render(issues: AccessibilityIssue[]): { version: string; $schema: string; runs: SarifRun[] } {
  return JSON.parse(renderSarifReport(makeReport(issues))) as { version: string; $schema: string; runs: SarifRun[] };
}

function firstRun(issues: AccessibilityIssue[]): SarifRun {
  const run = render(issues).runs[0];
  if (run === undefined) throw new Error('no run');
  return run;
}

describe('renderSarifReport', () => {
  it('writes a SARIF 2.1.0 log with one A11yHawk run', () => {
    const log = render([makeIssue({})]);
    expect(log.version).toBe('2.1.0');
    expect(log.$schema).toContain('sarif-2.1.0');
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0]?.tool.driver.name).toBe('A11yHawk');
  });

  it('makes one rule per WCAG criterion and points results at it', () => {
    const run = firstRun([
      makeIssue({ id: 'A-001' }),
      makeIssue({ id: 'A-002', wcagCriteria: '1.4.3', severity: 'medium' }),
      makeIssue({ id: 'A-003', location: 'footer img' }),
    ]);
    expect(run.tool.driver.rules.map((r) => r.id)).toEqual(['wcag/1.1.1', 'wcag/1.4.3']);
    expect(run.tool.driver.rules[1]?.shortDescription.text).toBe('WCAG 1.4.3 Contrast (Minimum) (Level AA)');
    expect(run.results.map((r) => [r.ruleId, r.ruleIndex])).toEqual([
      ['wcag/1.1.1', 0],
      ['wcag/1.4.3', 1],
      ['wcag/1.1.1', 0],
    ]);
  });

  it('maps best-practice, out-of-standard and unknown criteria', () => {
    const run = firstRun([
      makeIssue({ wcagCriteria: 'Best practice' }),
      makeIssue({ wcagCriteria: 'Outside WCAG 2.1 Level AA: 1.4.6 Contrast (Enhanced)' }),
      makeIssue({ wcagCriteria: 'unknown' }),
    ]);
    expect(run.results.map((r) => r.ruleId)).toEqual(['best-practice', 'wcag/1.4.6', 'unmapped']);
  });

  it('maps severity to SARIF levels', () => {
    const run = firstRun((['critical', 'high', 'medium', 'low'] as const).map((severity) => makeIssue({ severity })));
    expect(run.results.map((r) => r.level)).toEqual(['error', 'error', 'warning', 'note']);
  });

  it('puts the location, element and suggested fix in the message', () => {
    const result = firstRun([makeIssue({})]).results[0];
    const message = result?.message.text ?? '';
    expect(message.split('\n')[0]).toBe('Image missing alt text.');
    expect(message).toContain('Location: main > img.logo');
    expect(message).toContain('WCAG: 1.1.1 Non-text Content (Level A)');
    expect(message).toContain('Element:\n<img class="logo" src="/logo.png">');
    expect(message).toContain('Suggested fix:\n<img class="logo" src="/logo.png" alt="Acme home">');
    expect(result?.locations[0]?.physicalLocation.artifactLocation.uri).toBe('https://example.com/pricing');
    expect(result?.locations[0]?.logicalLocations?.[0]?.fullyQualifiedName).toBe('main > img.logo');
  });

  it('prints a Lighthouse-only fix once when it repeats the recommendation', () => {
    const message =
      firstRun([
        makeIssue({
          recommendation: 'Give images alt text.',
          remediation: 'Give images alt text.',
          userImpact: 'Give images alt text.',
        }),
      ]).results[0]?.message.text ?? '';
    expect(message.match(/Give images alt text\./g)).toHaveLength(1);
    expect(message).not.toContain('Suggested fix');
  });

  it('gives the same issue the same fingerprint and different issues different ones', () => {
    const [a, b, c] = firstRun([
      makeIssue({}),
      makeIssue({ id: 'A-009' }),
      makeIssue({ location: 'footer img' }),
    ]).results;
    expect(a?.partialFingerprints.primaryLocationLineHash).toBe(b?.partialFingerprints.primaryLocationLineHash);
    expect(a?.partialFingerprints.primaryLocationLineHash).not.toBe(c?.partialFingerprints.primaryLocationLineHash);
  });

  it('marks resolved issues as suppressed', () => {
    const [open, resolved] = firstRun([
      makeIssue({}),
      makeIssue({ resolved: true, resolvedNote: 'Decorative image' }),
    ]).results;
    expect(open?.suppressions).toBeUndefined();
    expect(resolved?.suppressions).toEqual([{ kind: 'external', justification: 'Decorative image' }]);
  });

  it('tolerates a stored report with missing issues and fields', () => {
    const report = makeReport([]);
    (report.structured as { issues?: unknown }).issues = undefined;
    expect(JSON.parse(renderSarifReport(report)).runs[0].results).toEqual([]);

    const sparse = makeIssue({});
    (sparse as unknown as Record<string, unknown>).title = undefined;
    (sparse as unknown as Record<string, unknown>).severity = 'urgent';
    const result = firstRun([sparse]).results[0];
    expect(result?.message.text.split('\n')[0]).toBe('Accessibility issue.');
    expect(result?.level).toBe('warning');
  });
});
