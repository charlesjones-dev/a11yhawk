import { describe, expect, it } from 'vitest';

import type { StructuredScanOutput } from '../types.js';
import { renderHtmlReport } from './html-report.js';
import type { LighthouseTransformedResult } from './lighthouse.js';
import type { ScanReport } from './scan.js';

// Injection payloads. A scanned page controls issue titles and code snippets,
// so these must never reach the document unescaped.
const TITLE_XSS = '<img src=x onerror=alert(1)>';
const CODE_XSS = '<script>alert(1)</script>';

const PINNED_DATE = '2026-07-19T14:30:00.000Z';

// Minimal valid JPEG header so the renderer sniffs image/jpeg from magic bytes.
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

function makeStructured(): StructuredScanOutput {
  const base = {
    resolved: false,
    resolvedAt: null,
    resolvedNote: null,
    resolvedByUserId: null,
    resolvedByDisplayName: null,
  };
  return {
    overallScore: 62,
    url: 'https://example.com/pricing',
    scanDate: PINNED_DATE,
    standard: 'WCAG 2.1 - AA',
    statistics: {
      totalIssues: 3,
      criticalIssues: 1,
      highIssues: 1,
      mediumIssues: 1,
      lowIssues: 0,
      resolvedIssues: 0,
      unresolvedIssues: 3,
    },
    wcagCoverage: [
      { criteriaId: '1.1.1', name: 'Non-text Content', level: 'A', passed: false, issues: ['issue-1'] },
      { criteriaId: '1.4.3', name: 'Contrast (Minimum)', level: 'AA', passed: true },
      { criteriaId: '2.4.4', name: 'Link Purpose (In Context)', level: 'A', passed: false, issues: ['issue-3'] },
    ],
    issues: [
      {
        ...base,
        id: 'issue-1',
        title: `Image missing alt text ${TITLE_XSS}`,
        severity: 'critical',
        wcagCriteria: '1.1.1',
        wcagLevel: 'A',
        location: 'main > img.logo',
        patternDetected: 'image-alt',
        codeContext: `<img class="logo" src="/logo.png">${CODE_XSS}`,
        impact: 'Screen reader users receive no description of this image.',
        userImpact: 'Blind users cannot tell what the logo represents.',
        recommendation: 'Add a descriptive alt attribute.',
        fixPriority: 'Immediate',
        remediation: 'Set alt="Acme Corp home" on the logo image.',
      },
      {
        ...base,
        id: 'issue-2',
        title: 'Form control has no label',
        severity: 'high',
        wcagCriteria: '3.3.2',
        wcagLevel: 'A',
        location: 'form#search input[type=text]',
        patternDetected: 'label',
        codeContext: '<input type="text" name="q">',
        impact: 'The search field is announced only as "edit text".',
        userImpact: 'Users relying on assistive tech cannot identify the field.',
        recommendation: 'Associate a visible label with the input.',
        fixPriority: 'High Priority',
        remediation: 'Add <label for="q">Search</label>.',
      },
      {
        ...base,
        id: 'issue-3',
        title: 'Ambiguous link text',
        severity: 'medium',
        wcagCriteria: '2.4.4',
        wcagLevel: 'A',
        location: 'footer a.more',
        patternDetected: 'link-name',
        codeContext: null,
        impact: 'Links labeled "click here" lack context out of flow.',
        userImpact: 'Screen reader users navigating by links get no destination cue.',
        recommendation: 'Use descriptive link text.',
        fixPriority: 'Medium Priority',
        remediation: 'Replace "click here" with the destination name.',
      },
    ],
    passedChecks: [{ criteria: '1.4.3', description: 'Text meets minimum contrast requirements.' }],
    metadata: { pageTitle: 'Pricing - Example' },
    lighthouseWcagCriteria: ['1.1.1'],
  };
}

function makeLighthouse(): LighthouseTransformedResult {
  return {
    issues: [],
    summary: {
      totalIssues: 0,
      bySeverity: { critical: 0, serious: 0, moderate: 0, minor: 0 },
      totalElements: 0,
      lighthouseScore: 78,
    },
  };
}

function makeReport(overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    structured: makeStructured(),
    markdown: '# report',
    screenshot: null,
    annotatedScreenshot: FAKE_JPEG,
    lighthouse: makeLighthouse(),
    usage: {
      promptTokens: 12345,
      completionTokens: 6789,
      totalTokens: 19134,
      cost: 0.0123,
      costType: 'user',
      modelId: 'anthropic/claude-sonnet-4.5',
    },
    finalUrl: 'https://example.com/pricing',
    durationMs: 8300,
    ...overrides,
  };
}

/** Collect every http(s) URL that a browser would actually fetch (href/src). */
function externalResourceUrls(html: string): string[] {
  const urls: string[] = [];
  const re = /(?:href|src)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const value = match[1] ?? '';
    if (/^https?:\/\//i.test(value)) urls.push(value);
  }
  return urls;
}

describe('renderHtmlReport', () => {
  it('escapes untrusted issue content and never emits the raw injection strings', () => {
    const html = renderHtmlReport(makeReport());

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain(TITLE_XSS);
    expect(html).not.toContain(CODE_XSS);
  });

  it('loads no external resources beyond the scanned URL and the repo link', () => {
    const html = renderHtmlReport(makeReport());

    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).not.toContain('<img src="http');

    const urls = externalResourceUrls(html).sort();
    expect(urls).toEqual(['https://example.com/pricing', 'https://github.com/charlesjones-dev/a11yhawk'].sort());
  });

  it('produces an accessible document shell', () => {
    const html = renderHtmlReport(makeReport());

    expect(html).toMatch(/<html lang="en"/);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<main\b/);
    expect(html).toMatch(/<header\b/);
    expect(html).toMatch(/<footer\b/);
  });

  it('renders the score, severity counts, and issue titles', () => {
    const html = renderHtmlReport(makeReport());

    expect(html).toContain('>62<');
    expect(html).toContain('Lighthouse score 78 out of 100');

    // Severity counts come straight from statistics, per tile. Anchor on the
    // class attribute so the match is the tile element, not the CSS rule.
    const critCount = /class="tile tile-critical">\s*<span class="tile-count mono">(\d+)</.exec(html)?.[1];
    const lowCount = /class="tile tile-low">\s*<span class="tile-count mono">(\d+)</.exec(html)?.[1];
    expect(critCount).toBe('1');
    expect(lowCount).toBe('0');

    expect(html).toContain('Image missing alt text');
    expect(html).toContain('Form control has no label');
    expect(html).toContain('Ambiguous link text');
  });

  it('embeds a screenshot as a base64 data URI when a buffer is present', () => {
    const html = renderHtmlReport(makeReport());
    expect(html).toContain('data:image/jpeg;base64,');
  });

  it('omits the screenshot section when neither buffer is present', () => {
    const html = renderHtmlReport(makeReport({ screenshot: null, annotatedScreenshot: null }));
    expect(html).not.toContain('data:image/jpeg;base64,');
    expect(html).not.toContain('Annotated screenshot');
    expect(html).not.toContain('Page screenshot');
  });

  it('uses the Lighthouse-only label when there is no LLM usage', () => {
    const html = renderHtmlReport(makeReport({ usage: null, lighthouse: makeLighthouse() }));
    expect(html).toContain('Lighthouse only');
  });

  it('matches the snapshot for a fixed fixture', () => {
    const html = renderHtmlReport(makeReport());
    // Version is read from package.json at runtime; normalize it so version
    // bumps do not churn the snapshot.
    const normalized = html.replace(/v\d+\.\d+\.\d+/g, 'vX.Y.Z');
    expect(normalized).toMatchSnapshot();
  });
});
