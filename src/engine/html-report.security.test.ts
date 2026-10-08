/**
 * Security regression tests for the HTML report: provider usage counters are escaped like
 * every other interpolated value, and the CSP served with the report allows exactly the
 * report's own inline script.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { StructuredScanOutput } from '../types.js';
import { HTML_REPORT_CSP, renderHtmlReport } from './html-report.js';
import type { ScanReport } from './scan.js';

const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PAYLOAD = '<img src=x onerror="alert(document.domain)">';

function structured(): StructuredScanOutput {
  return {
    overallScore: 80,
    url: 'https://example.com/',
    scanDate: '2026-10-07T00:00:00.000Z',
    standard: 'WCAG 2.1 - AA',
    statistics: {
      totalIssues: 0,
      criticalIssues: 0,
      highIssues: 0,
      mediumIssues: 0,
      lowIssues: 0,
      resolvedIssues: 0,
      unresolvedIssues: 0,
    },
    wcagCoverage: [],
    issues: [],
    passedChecks: [],
    metadata: { pageTitle: 'Example' },
  };
}

function report(overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    structured: structured(),
    markdown: '',
    screenshot: FAKE_JPEG,
    annotatedScreenshot: null,
    lighthouse: null,
    usage: null,
    finalUrl: 'https://example.com/',
    durationMs: 10,
    ...overrides,
  };
}

describe('HTML report usage counters', () => {
  for (const field of ['promptTokens', 'completionTokens', 'totalTokens'] as const) {
    it(`escapes usage.${field}`, () => {
      // Typed as number, but a hostile provider could send a string.
      const usage = {
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
        cost: 0,
        costType: 'user' as const,
        modelId: 'm',
      };
      (usage as Record<string, unknown>)[field] = PAYLOAD;

      const html = renderHtmlReport(report({ usage }));

      expect(html).not.toContain(PAYLOAD);
      expect(html).toContain('&lt;img src=x onerror=&quot;alert(document.domain)&quot;&gt;');
    });
  }
});

describe('HTML_REPORT_CSP', () => {
  it("allows the report's inline script by its exact hash", () => {
    const html = renderHtmlReport(report());
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
    expect(scripts).toHaveLength(1);

    const hash = createHash('sha256')
      .update(scripts[0] ?? '')
      .digest('base64');
    expect(HTML_REPORT_CSP).toContain(`script-src 'sha256-${hash}'`);
    expect(HTML_REPORT_CSP).toContain("default-src 'none'");
  });
});
