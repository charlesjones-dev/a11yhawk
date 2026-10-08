import { describe, expect, it } from 'vitest';
import {
  buildLighthouseCliArgs,
  extractPerformanceFromLhr,
  isBestPracticeAudit,
  lighthouseCrossReferenceCriteria,
  LighthouseAuditError,
  LighthouseService,
  transformLighthouseToIssues,
  transformToCompactFormat,
  trimLhrForOutput,
  type LighthouseA11yResult,
  type LighthouseIssue,
  type LighthousePerformanceResult,
} from './lighthouse.js';

function makeAuditResult(): LighthouseA11yResult {
  return {
    score: 85,
    category: {
      score: 0.85,
      title: 'Accessibility',
      description: '',
      auditRefs: [{ id: 'image-alt', weight: 10 }],
    },
    audits: {
      'image-alt': {
        id: 'image-alt',
        title: 'Images do not have alt text',
        description: 'Informative elements should aim for short, descriptive alternate text.',
        score: 0,
        scoreDisplayMode: 'binary',
        items: [{ selector: 'img.hero' }],
      },
    },
    timing: { total: 9430 },
    finalUrl: 'https://example.com/',
    lighthouseVersion: '12.0.0',
    fetchTime: '2026-07-21T00:00:00.000Z',
  };
}

describe('transformLighthouseToIssues', () => {
  it('exposes the audit duration on the summary', () => {
    const result = transformLighthouseToIssues(makeAuditResult());
    expect(result.summary.lighthouseDurationMs).toBe(9430);
  });

  it('keeps summary statistics consistent with the transformed issues', () => {
    const result = transformLighthouseToIssues(makeAuditResult());
    expect(result.summary.totalIssues).toBe(result.issues.length);
    expect(result.summary.lighthouseScore).toBe(85);
    expect(result.issues[0]?.auditId).toBe('image-alt');
  });

  it('carries the Lighthouse version and omits performance/raw unless set', () => {
    const result = transformLighthouseToIssues(makeAuditResult());
    expect(result.lighthouseVersion).toBe('12.0.0');
    expect(result).not.toHaveProperty('performance');
    expect(result).not.toHaveProperty('raw');
  });

  it('passes performance and raw through when the audit produced them', () => {
    const performance: LighthousePerformanceResult = {
      score: 73,
      metrics: { firstContentfulPaintMs: 1200 },
      opportunities: [],
    };
    const raw = { lighthouseVersion: '12.0.0' };
    const result = transformLighthouseToIssues({ ...makeAuditResult(), performance, raw });
    expect(result.performance).toEqual(performance);
    expect(result.raw).toEqual(raw);
  });
});

/** Run one failing audit through the transform and return the resulting issue. */
function transformSingleAudit(auditId: string): LighthouseIssue {
  const result = makeAuditResult();
  result.audits = {
    [auditId]: {
      id: auditId,
      title: auditId,
      description: '',
      score: 0,
      scoreDisplayMode: 'binary',
      items: [{ selector: 'body' }],
    },
  };
  const issue = transformLighthouseToIssues(result).issues[0];
  if (!issue) throw new Error(`no issue for ${auditId}`);
  return issue;
}

describe('Lighthouse audit to WCAG mapping', () => {
  // Expected values are the WCAG tags on the axe-core 4.12 rule behind each audit.
  it.each([
    ['video-caption', '1.2.2'],
    ['frame-title', '4.1.2'],
    ['target-size', '2.5.8'],
    ['label-content-name-mismatch', '2.5.3'],
    ['identical-links-same-purpose', '2.4.9'],
    ['form-field-multiple-labels', '3.3.2'],
    ['link-in-text-block', '1.4.1'],
    ['aria-required-children', '1.3.1'],
  ])('maps %s to %s', (auditId, criterion) => {
    expect(transformSingleAudit(auditId).wcagCriteria).toBe(criterion);
  });

  it('maps best-practice audits to no criterion and minor severity', () => {
    for (const auditId of ['landmark-one-main', 'heading-order', 'tabindex', 'skip-link']) {
      expect(isBestPracticeAudit(auditId)).toBe(true);
      expect(transformSingleAudit(auditId)).toMatchObject({ wcagCriteria: 'unknown', severity: 'minor' });
    }
    expect(isBestPracticeAudit('image-alt')).toBe(false);
  });

  it('tells the model which audits are best practice', () => {
    const compact = transformToCompactFormat([
      transformSingleAudit('landmark-one-main'),
      transformSingleAudit('image-alt'),
    ]);
    expect(compact.map((c) => c.wcag)).toEqual(['best-practice', '1.1.1']);
  });

  it('cross-references best-practice audits through their related criteria, never "unknown"', () => {
    const criteria = lighthouseCrossReferenceCriteria([
      transformSingleAudit('landmark-one-main'),
      transformSingleAudit('color-contrast'),
      { ...transformSingleAudit('image-alt'), auditId: 'some-future-audit', wcagCriteria: 'unknown' },
    ]);
    expect(criteria.sort()).toEqual(['1.3.1', '1.4.3', '2.4.1']);
  });
});

describe('buildLighthouseCliArgs', () => {
  it('puts all categories on a single --only-categories flag (one run, one page load)', () => {
    const args = buildLighthouseCliArgs('https://example.com/', ['accessibility', 'performance'], 9222);
    expect(args.filter((a) => a.startsWith('--only-categories='))).toEqual([
      '--only-categories=accessibility,performance',
    ]);
    expect(args).toContain('--port=9222');
    expect(args.some((a) => a.startsWith('--chrome-flags='))).toBe(false);
  });

  it('defaults to accessibility-only args', () => {
    expect(buildLighthouseCliArgs('https://example.com/', ['accessibility'], 9222)).toEqual([
      'https://example.com/',
      '--output=json',
      '--output-path=stdout',
      '--only-categories=accessibility',
      '--quiet',
      '--no-enable-error-reporting',
      '--port=9222',
    ]);
  });

  it('falls back to launching Chrome with container flags when no CDP port is given', () => {
    const args = buildLighthouseCliArgs('https://example.com/', ['accessibility']);
    expect(args.some((a) => a.startsWith('--chrome-flags='))).toBe(true);
    expect(args.some((a) => a.startsWith('--port='))).toBe(false);
  });
});

function makePerfLhr(): Record<string, unknown> {
  return {
    categories: {
      performance: {
        score: 0.734,
        auditRefs: [
          { id: 'first-contentful-paint' },
          { id: 'largest-contentful-paint' },
          { id: 'cumulative-layout-shift' },
          { id: 'total-blocking-time' },
          { id: 'speed-index' },
          { id: 'render-blocking-resources' },
          { id: 'unused-css-rules' },
          { id: 'legacy-javascript' },
          { id: 'no-savings-audit' },
          { id: 'passing-audit' },
          { id: 'informative-audit' },
        ],
      },
    },
    audits: {
      'first-contentful-paint': { score: 0.9, numericValue: 1234.56 },
      'largest-contentful-paint': { score: 0.8, numericValue: 2500.4 },
      'cumulative-layout-shift': { score: 1, numericValue: 0.12345 },
      'total-blocking-time': { score: 0.7, numericValue: 150.2 },
      'speed-index': { score: 0.85, numericValue: 3210.9 },
      'render-blocking-resources': {
        score: 0.4,
        title: 'Eliminate render-blocking resources',
        details: { overallSavingsMs: 450.3, overallSavingsBytes: 12800.7 },
      },
      'unused-css-rules': {
        score: 0.5,
        title: 'Reduce unused CSS',
        details: { overallSavingsBytes: 40960 },
      },
      // Newer insight-style audit: per-metric savings instead of an overall figure.
      'legacy-javascript': { score: 0, title: 'Avoid legacy JavaScript', metricSavings: { FCP: 900.4, LCP: 150 } },
      'no-savings-audit': { score: 0.3, title: 'Failing but no estimate' },
      'passing-audit': { score: 1, title: 'Passing', details: { overallSavingsMs: 999 } },
      'informative-audit': { score: null, title: 'Informative' },
    },
  };
}

describe('extractPerformanceFromLhr', () => {
  it('extracts the category score and the five key metrics', () => {
    const perf = extractPerformanceFromLhr(makePerfLhr());
    expect(perf.score).toBe(73);
    expect(perf.metrics).toEqual({
      firstContentfulPaintMs: 1235,
      largestContentfulPaintMs: 2500,
      cumulativeLayoutShift: 0.123,
      totalBlockingTimeMs: 150,
      speedIndexMs: 3211,
    });
  });

  it('collects only savings-bearing failing audits as opportunities, sorted by time savings', () => {
    const perf = extractPerformanceFromLhr(makePerfLhr());
    expect(perf.opportunities).toEqual([
      { auditId: 'legacy-javascript', title: 'Avoid legacy JavaScript', estimatedSavingsMs: 900 },
      {
        auditId: 'render-blocking-resources',
        title: 'Eliminate render-blocking resources',
        estimatedSavingsMs: 450,
        estimatedSavingsBytes: 12801,
      },
      { auditId: 'unused-css-rules', title: 'Reduce unused CSS', estimatedSavingsBytes: 40960 },
    ]);
  });

  it('caps opportunities at 10', () => {
    const auditRefs = Array.from({ length: 12 }, (_, i) => ({ id: `op-${i}` }));
    const audits = Object.fromEntries(
      auditRefs.map((ref, i) => [ref.id, { score: 0, title: ref.id, details: { overallSavingsMs: (i + 1) * 100 } }]),
    );
    const perf = extractPerformanceFromLhr({ categories: { performance: { score: 0.5, auditRefs } }, audits });
    expect(perf.opportunities).toHaveLength(10);
    expect(perf.opportunities[0]?.estimatedSavingsMs).toBe(1200);
  });

  it('reports a null score when Lighthouse could not compute one', () => {
    const lhr = makePerfLhr();
    (lhr.categories as { performance: { score: number | null } }).performance.score = null;
    expect(extractPerformanceFromLhr(lhr).score).toBeNull();
  });

  it('throws LighthouseAuditError when the performance category is missing', () => {
    expect(() => extractPerformanceFromLhr({ categories: { accessibility: {} }, audits: {} })).toThrow(
      LighthouseAuditError,
    );
  });
});

describe('trimLhrForOutput', () => {
  it('strips screenshot payloads and localization tables without mutating the input', () => {
    const lhr: Record<string, unknown> = {
      lighthouseVersion: '13.4.0',
      fullPageScreenshot: { data: 'base64...' },
      i18n: { icuMessagePaths: {} },
      audits: {
        'screenshot-thumbnails': { details: { items: [] } },
        'final-screenshot': { details: {} },
        'color-contrast': { score: 1 },
      },
    };
    const trimmed = trimLhrForOutput(lhr);
    expect(trimmed).not.toHaveProperty('fullPageScreenshot');
    expect(trimmed).not.toHaveProperty('i18n');
    expect(trimmed.audits).not.toHaveProperty('screenshot-thumbnails');
    expect(trimmed.audits).not.toHaveProperty('final-screenshot');
    expect(trimmed.audits).toHaveProperty('color-contrast');
    expect(trimmed.lighthouseVersion).toBe('13.4.0');
    // The original LHR is untouched.
    expect(lhr).toHaveProperty('fullPageScreenshot');
    expect(lhr.audits).toHaveProperty('screenshot-thumbnails');
  });
});

describe('LighthouseService.runAudit', () => {
  /** Patch the private subprocess runner with a gated fake. */
  function gatedService(): {
    service: LighthouseService;
    entered: string[];
    release: (result?: unknown) => void;
    fail: (error: Error) => void;
  } {
    const service = new LighthouseService();
    const entered: string[] = [];
    const gates: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
    (service as unknown as { executeAudit: (url: string) => Promise<unknown> }).executeAudit = (url: string) =>
      new Promise((resolve, reject) => {
        entered.push(url);
        gates.push({ resolve, reject });
      });
    return {
      service,
      entered,
      release: (result = {}) => gates.shift()?.resolve(result),
      fail: (error) => gates.shift()?.reject(error),
    };
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('rejects runs that omit the accessibility category', async () => {
    const service = new LighthouseService();
    await expect(service.runAudit('https://example.com/', { categories: ['performance'] })).rejects.toThrow(
      LighthouseAuditError,
    );
  });

  it('serializes runs that include the performance category', async () => {
    const { service, entered, release } = gatedService();
    const categories = ['accessibility', 'performance'] as const;
    const first = service.runAudit('https://a.example/', { categories });
    const second = service.runAudit('https://b.example/', { categories });

    await tick();
    expect(entered).toEqual(['https://a.example/']);

    release();
    await first;
    await tick();
    expect(entered).toEqual(['https://a.example/', 'https://b.example/']);
    release();
    await second;
  });

  it('keeps serializing after a failed performance run', async () => {
    const { service, entered, release, fail } = gatedService();
    const categories = ['accessibility', 'performance'] as const;
    const first = service.runAudit('https://a.example/', { categories });
    const second = service.runAudit('https://b.example/', { categories });

    await tick();
    fail(new LighthouseAuditError('boom'));
    await expect(first).rejects.toThrow('boom');

    await tick();
    expect(entered).toEqual(['https://a.example/', 'https://b.example/']);
    release();
    await second;
  });

  it('does not serialize accessibility-only runs', async () => {
    const { service, entered, release } = gatedService();
    const first = service.runAudit('https://a.example/');
    const second = service.runAudit('https://b.example/');

    await tick();
    expect(entered).toEqual(['https://a.example/', 'https://b.example/']);
    release();
    release();
    await Promise.all([first, second]);
  });
});
