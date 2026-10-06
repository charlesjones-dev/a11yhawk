import { describe, expect, it } from 'vitest';

import type { AccessibilityIssue, StructuredScanOutput } from '../types.js';
import type { LighthouseIssue, LighthouseTransformedResult } from './lighthouse.js';
import { generateMarkdownFromStructured } from './markdown-generator.js';

function makeIssue(overrides: Partial<AccessibilityIssue>): AccessibilityIssue {
  return {
    id: 'A-001',
    title: 'Issue',
    severity: 'medium',
    wcagCriteria: '1.1.1 Non-text Content',
    wcagLevel: 'A',
    location: 'img.hero',
    patternDetected: 'img without alt',
    codeContext: null,
    impact: 'Fails WCAG 1.1.1 (Level A)',
    userImpact: 'Screen reader users get no description.',
    recommendation: 'Add alt text.',
    fixPriority: 'Medium Priority',
    remediation: '<img alt="Team photo">',
    resolved: false,
    resolvedAt: null,
    resolvedNote: null,
    resolvedByUserId: null,
    resolvedByDisplayName: null,
    ...overrides,
  };
}

function makeStructured(overrides: Partial<StructuredScanOutput> = {}): StructuredScanOutput {
  const issues = overrides.issues ?? [];
  return {
    overallScore: 75,
    url: 'https://example.com/',
    scanDate: '2026-10-06T12:00:00.000Z',
    standard: 'WCAG 2.2 Level AA',
    statistics: {
      totalIssues: issues.length,
      criticalIssues: issues.filter((i) => i.severity === 'critical').length,
      highIssues: issues.filter((i) => i.severity === 'high').length,
      mediumIssues: issues.filter((i) => i.severity === 'medium').length,
      lowIssues: issues.filter((i) => i.severity === 'low').length,
      resolvedIssues: 0,
      unresolvedIssues: issues.length,
    },
    wcagCoverage: [],
    passedChecks: [],
    metadata: { pageTitle: 'Example Domain' },
    ...overrides,
    issues,
  };
}

function makeLighthouse(issues: LighthouseIssue[]): LighthouseTransformedResult {
  return {
    issues,
    summary: {
      totalIssues: issues.length,
      bySeverity: { critical: 0, serious: issues.length, moderate: 0, minor: 0 },
      totalElements: 0,
      lighthouseScore: 91,
    },
  };
}

const LANDMARK_ONE_MAIN: LighthouseIssue = {
  auditId: 'landmark-one-main',
  title: 'Document does not have a main landmark.',
  description: 'One main landmark helps screen reader users navigate a web page.',
  wcagCriteria: 'unknown',
  severity: 'minor',
  elements: [],
};

// A mixed-severity scan touching every report section.
const MIXED = makeStructured({
  issues: [
    makeIssue({ id: 'A-001', severity: 'critical', fixPriority: 'Immediate', title: 'Image missing alt text' }),
    makeIssue({ id: 'A-002', severity: 'high', fixPriority: 'High Priority', title: 'Low contrast text' }),
    makeIssue({ id: 'A-003', severity: 'medium', fixPriority: 'Medium Priority', title: 'Vague link text' }),
    makeIssue({ id: 'A-004', severity: 'low', fixPriority: 'Low Priority', title: 'Redundant title attribute' }),
  ],
  wcagCoverage: [
    { criteriaId: '1.1.1', name: 'Non-text Content', level: 'A', passed: false, issues: ['A-003', 'A-001'] },
    { criteriaId: '1.4.3', name: 'Contrast (Minimum)', level: 'AA', passed: false, issues: ['A-002'] },
    { criteriaId: '2.4.2', name: 'Page Titled', level: 'A', passed: true },
    { criteriaId: '2.4.4', name: 'Link Purpose (In Context)', level: 'A', passed: false, issues: ['A-003'] },
  ],
  passedChecks: [{ criteria: '2.4.2 Page Titled', description: 'Page has a descriptive title element' }],
});

describe('generateMarkdownFromStructured report text', () => {
  it('makes no compliance claims outside the one disclaimer', () => {
    const markdown = generateMarkdownFromStructured(MIXED, { lighthouseResult: makeLighthouse([LANDMARK_ONE_MAIN]) });

    expect(markdown.match(/complian/gi)).toEqual(['complian']);
    expect(markdown).toContain('It is not a compliance certification.');
    expect(markdown).not.toMatch(/Expected Impact|conforman|fully compliant|baseline/i);
  });

  it('uses no emoji, em dashes, or A11yHawk branding in the report body', () => {
    const markdown = generateMarkdownFromStructured(MIXED, { lighthouseResult: makeLighthouse([LANDMARK_ONE_MAIN]) });

    expect(markdown).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(markdown).not.toContain('—');
    expect(markdown).not.toContain('A11yHawk');
  });

  it('describes the criteria results without a compliance percentage', () => {
    const markdown = generateMarkdownFromStructured(MIXED);

    expect(markdown).toContain('| **Criteria with no issues found** | 1 of 4 (25%) |');
    expect(markdown).toContain('## WCAG criteria checked');
    expect(markdown).toContain('1 of 4 checked criteria had no issues found.');
  });

  it('derives each failing criterion severity from its most severe linked issue', () => {
    const markdown = generateMarkdownFromStructured(MIXED);

    expect(markdown).toContain('| Criterion | Title | Result | Issues | Highest severity |');
    expect(markdown).toMatch(/Non-text Content \| Issues found \| A-003, A-001 \| Critical \|/);
    expect(markdown).toMatch(/Contrast \(Minimum\) \| Issues found \| A-002 \| High \|/);
    expect(markdown).toMatch(/Page Titled \| No issues found \| - \| - \|/);
    expect(markdown).toMatch(/Link Purpose \(In Context\) \| Issues found \| A-003 \| Medium \|/);
  });

  it('keeps the remediation roadmap free of projected outcomes', () => {
    const markdown = generateMarkdownFromStructured(MIXED);

    expect(markdown).toContain('### Phase 1: Critical Accessibility Barriers');
    expect(markdown).toContain('- [ ] Image missing alt text (A-001)');
    expect(markdown).not.toMatch(/Achieve|Address \d+%/);
  });

  it('reports no issues without claiming the page is accessible', () => {
    const markdown = generateMarkdownFromStructured(makeStructured());

    expect(markdown).toContain(
      'This scan found no issues. Automated and AI checks cover only part of WCAG, so also test with a keyboard and a screen reader.',
    );
    expect(markdown).not.toMatch(/excellent|best practices|Basic page structure is present/i);
  });

  it('uses correct grammar for one and several critical issues', () => {
    const one = generateMarkdownFromStructured(
      makeStructured({ issues: [makeIssue({ severity: 'critical', fixPriority: 'Immediate' })] }),
    );
    expect(one).toContain(
      'This scan found **1 critical issue** that can prevent some people with disabilities from using parts of the page.',
    );

    const two = generateMarkdownFromStructured(
      makeStructured({
        issues: [
          makeIssue({ id: 'A-001', severity: 'critical', fixPriority: 'Immediate' }),
          makeIssue({ id: 'A-002', severity: 'critical', fixPriority: 'Immediate' }),
        ],
      }),
    );
    expect(two).toContain('This scan found **2 critical issues** that can prevent');
  });

  it('describes the AI review neutrally', () => {
    const withLighthouse = generateMarkdownFromStructured(MIXED, {
      lighthouseResult: makeLighthouse([LANDMARK_ONE_MAIN]),
    });
    expect(withLighthouse).toContain(
      '*An AI model reviewed the page screenshot, accessibility tree, HTML and Lighthouse results.*',
    );

    const withoutLighthouse = generateMarkdownFromStructured(MIXED);
    expect(withoutLighthouse).toContain('*An AI model reviewed the page screenshot, accessibility tree and HTML.*');
  });
});

describe('generateMarkdownFromStructured Lighthouse cross-reference', () => {
  it('matches a best-practice Lighthouse audit to the AI issue filed under its related criterion', () => {
    const structured = makeStructured({
      issues: [
        makeIssue({
          id: 'A-001',
          title: 'Page has no main landmark',
          severity: 'low',
          fixPriority: 'Low Priority',
          wcagCriteria: '1.3.1 Info and Relationships (best practice)',
        }),
        makeIssue({ id: 'A-002', wcagCriteria: '1.4.3 Contrast (Minimum)', wcagLevel: 'AA' }),
      ],
    });
    const markdown = generateMarkdownFromStructured(structured, {
      lighthouseResult: makeLighthouse([LANDMARK_ONE_MAIN]),
    });

    expect(markdown).toContain('| Same criterion flagged by Lighthouse | 1 issue |');
    expect(markdown).toContain('| Not flagged by Lighthouse | 1 issue |');
    expect(markdown).toContain('> *Lighthouse also reported an issue related to 1.3.1.*');
  });

  it('labels best-practice audits and shows Lighthouse severity as text', () => {
    const markdown = generateMarkdownFromStructured(MIXED, { lighthouseResult: makeLighthouse([LANDMARK_ONE_MAIN]) });

    expect(markdown).toContain('| landmark-one-main | Best practice | Minor | - |');
  });
});

describe('generateMarkdownFromStructured in Lighthouse-only mode', () => {
  const structured = makeStructured({
    issues: [makeIssue({ id: 'lh-color-contrast-1', severity: 'high', fixPriority: 'High Priority' })],
    wcagCoverage: [
      { criteriaId: '1.4.3', name: 'Contrast (Minimum)', level: 'AA', passed: false, issues: ['lh-color-contrast-1'] },
    ],
    metadata: { pageTitle: 'Example Domain', engineMode: 'lighthouse-only' },
  });

  it('does not describe an AI review or a share of criteria without issues', () => {
    const markdown = generateMarkdownFromStructured(structured);

    expect(markdown).not.toMatch(/\bAI\b/);
    expect(markdown).toContain('## Results');
    expect(markdown).not.toContain('Criteria with no issues found');
    expect(markdown).toContain('## WCAG criteria with issues found');
    expect(markdown).toContain('This report covers one page and lists what automated checks found.');
  });
});
