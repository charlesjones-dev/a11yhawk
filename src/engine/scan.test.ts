import { describe, expect, it } from 'vitest';

import type { LighthouseIssue, LighthouseTransformedResult } from './lighthouse.js';
import { buildStructuredFromLighthouse } from './scan.js';

function makeIssue(auditId: string, wcagCriteria: string, severity: LighthouseIssue['severity']): LighthouseIssue {
  return {
    auditId,
    title: `${auditId} title`,
    description: `${auditId} description`,
    wcagCriteria,
    severity,
    elements: [{ selector: 'body', snippet: '<body>' }],
  };
}

function makeLighthouse(issues: LighthouseIssue[]): LighthouseTransformedResult {
  return {
    issues,
    summary: {
      totalIssues: issues.length,
      bySeverity: { critical: 0, serious: issues.length, moderate: 0, minor: 0 },
      totalElements: issues.length,
      lighthouseScore: 88,
    },
  };
}

describe('buildStructuredFromLighthouse', () => {
  const structured = buildStructuredFromLighthouse(
    makeLighthouse([
      makeIssue('color-contrast', '1.4.3', 'serious'),
      makeIssue('landmark-one-main', 'unknown', 'minor'),
    ]),
    'https://example.com/',
    '2.2',
    'AA',
    'Example Domain',
  );

  it('lists failed criteria with their real WCAG name and level', () => {
    expect(structured.wcagCoverage).toEqual([
      {
        criteriaId: '1.4.3',
        name: 'Contrast (Minimum)',
        level: 'AA',
        passed: false,
        issues: ['lh-color-contrast-1'],
      },
    ]);
    expect(structured.issues[0]).toMatchObject({ wcagCriteria: '1.4.3', wcagLevel: 'AA', severity: 'high' });
  });

  it('reports best-practice audits as best practice, not as a failed criterion', () => {
    expect(structured.issues[1]).toMatchObject({
      wcagCriteria: 'Best practice',
      severity: 'low',
      fixPriority: 'Low Priority',
    });
    expect(structured.wcagCoverage.map((c) => c.criteriaId)).not.toContain('unknown');
  });

  it('keeps criteria outside the requested standard out of coverage and reports them as low', () => {
    const lighthouse = makeLighthouse([
      makeIssue('color-contrast', '1.4.3', 'serious'),
      makeIssue('target-size', '2.5.8', 'serious'),
      makeIssue('identical-links-same-purpose', '2.4.9', 'serious'),
    ]);

    const wcag21 = buildStructuredFromLighthouse(lighthouse, 'https://example.com/', '2.1', 'AA', 'Example Domain');
    expect(wcag21.standard).toBe('WCAG 2.1 - AA');
    expect(wcag21.wcagCoverage.map((c) => c.criteriaId)).toEqual(['1.4.3']);
    expect(wcag21.issues[1]).toMatchObject({
      wcagCriteria: 'Outside WCAG 2.1 Level AA: 2.5.8 Target Size (Minimum)',
      severity: 'low',
      fixPriority: 'Low Priority',
    });
    expect(wcag21.issues[2]).toMatchObject({
      wcagCriteria: 'Outside WCAG 2.1 Level AA: 2.4.9 Link Purpose (Link Only)',
      severity: 'low',
    });

    const wcag22 = buildStructuredFromLighthouse(lighthouse, 'https://example.com/', '2.2', 'AA', 'Example Domain');
    expect(wcag22.wcagCoverage.map((c) => c.criteriaId)).toEqual(['1.4.3', '2.5.8']);
    expect(wcag22.issues[1]).toMatchObject({ wcagCriteria: '2.5.8', severity: 'high' });
  });

  it('exposes cross-reference criteria without "unknown"', () => {
    expect(structured.lighthouseWcagCriteria?.sort()).toEqual(['1.3.1', '1.4.3', '2.4.1']);
  });
});
