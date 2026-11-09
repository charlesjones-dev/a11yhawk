/**
 * Security regression tests through the real A11yHawkEngine.scan() pipeline, with the
 * browser stage, the LLM transport, and DNS mocked in-process (no network, no browser,
 * no Lighthouse).
 */
// Model output as a prompt-injected page would steer it: perfect score, no coverage.
const DEFAULT_CONTENT = JSON.stringify({
  overallScore: 100,
  url: 'https://scan-target.test/',
  scanDate: '2026-10-07T00:00:00.000Z',
  standard: 'WCAG 2.1 Level AA',
  issues: [],
  statistics: {},
  wcagCoverage: [],
  passedChecks: [],
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  usage: null as null | Record<string, unknown>,
  analyzePageCalls: 0,
  content: '',
  aRecords: ['93.184.216.34'],
  filteredRequests: [] as Array<{ host: string; reason: string }>,
  captureError: null as null | Error,
}));

vi.mock('dns/promises', () => ({
  resolve4: async () => state.aRecords,
  resolve6: async () => {
    throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
  },
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));

vi.mock('./playwright.js', () => ({
  PlaywrightService: class {
    setConcurrency() {}
    async acquireBrowser() {}
    async releaseBrowser() {}
    async cleanup() {}
    getCDPPort() {
      return null;
    }
    async analyzePage() {
      state.analyzePageCalls += 1;
      if (state.captureError) throw state.captureError;
      return {
        title: 'Page',
        screenshotBuffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        screenshotTiles: ['AAAA'],
        accessibilityTree: { role: 'WebArea', children: [] },
        html: '<html><body><p>page</p></body></html>',
        finalUrl: 'https://scan-target.test/',
        filteredRequests: state.filteredRequests,
      };
    }
    async resolveElementBoundingBoxes() {
      return new Map();
    }
  },
}));

vi.mock('./llm.js', () => ({
  LLMService: class {
    async generateScan() {
      return { content: state.content, usage: state.usage };
    }
  },
}));

import { failsThreshold } from '../cli/main.js';
import type { Logger } from '../logger/index.js';
import { renderHtmlReport } from './html-report.js';
import { BlockedRequestError } from './request-guard.js';
import { A11yHawkEngine, ScanError } from './scan.js';

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
  async flush() {},
};

const SCAN_URL = 'https://scan-target.test/';

beforeEach(() => {
  state.usage = null;
  state.analyzePageCalls = 0;
  state.content = DEFAULT_CONTENT;
  state.aRecords = ['93.184.216.34'];
  state.filteredRequests = [];
  state.captureError = null;
});

describe('llm.baseUrl guard', () => {
  it('rejects a link-local baseUrl with a non-retryable invalid-options error before any browser work', async () => {
    const engine = new A11yHawkEngine({ logger: silent });

    const error = await engine
      .scan(SCAN_URL, {
        lighthouse: false,
        llm: { apiKey: 'k', baseUrl: 'http://169.254.169.254/latest/meta-data/?' },
        logger: silent,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScanError);
    expect((error as ScanError).code).toBe('invalid-options');
    expect((error as ScanError).retryable).toBe(false);
    expect(state.analyzePageCalls).toBe(0);
  });

  it('accepts a private baseUrl when the engine allows private networks', async () => {
    const engine = new A11yHawkEngine({ logger: silent, allowPrivateNetworks: true });

    const report = await engine.scan(SCAN_URL, {
      lighthouse: false,
      annotate: false,
      llm: { apiKey: 'k', baseUrl: 'http://localhost:11434/v1' },
      logger: silent,
    });

    expect(report.structured.url).toBe(SCAN_URL);
  });
});

describe('provider usage in the HTML report', () => {
  it('escapes a string prompt_tokens value end to end', async () => {
    const PAYLOAD = '<img src=x onerror="alert(document.domain)">';
    state.usage = { promptTokens: PAYLOAD, completionTokens: 2, totalTokens: 3, cost: 0, modelId: 'any/model' };
    const engine = new A11yHawkEngine({ logger: silent });

    const report = await engine.scan(SCAN_URL, {
      lighthouse: false,
      annotate: false,
      llm: { apiKey: 'k' },
      logger: silent,
    });

    expect(renderHtmlReport(report)).not.toContain(PAYLOAD);
  });
});

describe('model output is not trusted', () => {
  function issue(id: string, severity: string): Record<string, unknown> {
    return {
      id,
      title: `Issue ${id}`,
      severity,
      wcagCriteria: '2.1.2',
      wcagLevel: 'A',
      location: 'body',
      patternDetected: 'keyboard trap',
      codeContext: null,
      impact: 'x',
      userImpact: 'x',
      recommendation: 'x',
      fixPriority: 'Immediate',
      remediation: 'x',
    };
  }

  function modelOutput(overrides: Record<string, unknown>): string {
    return JSON.stringify({
      overallScore: 100,
      url: SCAN_URL,
      scanDate: '2026-10-07T00:00:00.000Z',
      standard: 'WCAG 2.1 Level AA',
      statistics: { totalIssues: 0, criticalIssues: 0, highIssues: 0, mediumIssues: 0, lowIssues: 0 },
      wcagCoverage: [],
      issues: [issue('A-001', 'critical'), issue('A-002', 'critical'), issue('A-003', 'high')],
      passedChecks: [],
      ...overrides,
    });
  }

  async function runScan(content: string) {
    state.content = content;
    const engine = new A11yHawkEngine({ logger: silent });
    return engine.scan(SCAN_URL, { lighthouse: false, annotate: false, llm: { apiKey: 'k' }, logger: silent });
  }

  it('scores 0 when the model returns an empty wcagCoverage, so the CI gate fails', async () => {
    const report = await runScan(modelOutput({}));
    expect(report.structured.statistics.criticalIssues).toBe(2);
    expect(report.structured.overallScore).toBe(0);
    expect(failsThreshold(report.structured.overallScore, 90)).toBe(true);
  });

  it('scores 0 when the model omits wcagCoverage and passedChecks, and still renders', async () => {
    const parsed = JSON.parse(modelOutput({})) as Record<string, unknown>;
    delete parsed.wcagCoverage;
    delete parsed.passedChecks;
    const report = await runScan(JSON.stringify(parsed));
    expect(report.structured.overallScore).toBe(0);
    expect(report.structured.wcagCoverage).toEqual([]);
    expect(report.structured.passedChecks).toEqual([]);
    expect(() => renderHtmlReport(report)).not.toThrow();
  });

  it('recomputes a non-numeric overallScore from coverage', async () => {
    const report = await runScan(
      modelOutput({
        overallScore: 'n/a',
        wcagCoverage: [
          { criteriaId: '1.1.1', name: 'Non-text Content', level: 'A', passed: true },
          { criteriaId: '2.1.2', name: 'No Keyboard Trap', level: 'A', passed: false, issues: ['A-001'] },
          // Only a real boolean counts as passed.
          { criteriaId: '2.4.2', name: 'Page Titled', level: 'A', passed: 'true' },
          { criteriaId: '3.1.1', name: 'Language of Page', level: 'A', passed: true },
        ],
      }),
    );
    expect(report.structured.overallScore).toBe(50);
  });

  it('validates issue severity, level, and priority against their sets', async () => {
    const report = await runScan(
      modelOutput({
        issues: [
          { ...issue('A-001', 'blocker'), wcagLevel: 'AAAA', fixPriority: 'whenever' },
          { ...issue('A-002', 'Critical'), wcagLevel: 'aa' },
          { ...issue('A-003', 'high'), fixPriority: ' low priority ' },
        ],
      }),
    );
    const [first, second, third] = report.structured.issues;
    expect(first).toMatchObject({ severity: 'medium', wcagLevel: 'A', fixPriority: 'Medium Priority' });
    expect(second).toMatchObject({ severity: 'critical', wcagLevel: 'AA' });
    expect(third).toMatchObject({ severity: 'high', fixPriority: 'Low Priority' });
    const stats = report.structured.statistics;
    expect(stats.criticalIssues + stats.highIssues + stats.mediumIssues + stats.lowIssues).toBe(stats.totalIssues);
    expect(() => renderHtmlReport(report)).not.toThrow();
  });

  it('coerces non-string issue fields and drops non-object issues', async () => {
    const report = await runScan(
      modelOutput({ issues: [null, 'text', { ...issue('A-001', 'low'), title: { html: '<b>' }, wcagCriteria: 212 }] }),
    );
    expect(report.structured.issues).toHaveLength(1);
    expect(report.structured.issues[0]).toMatchObject({ title: 'Untitled issue', wcagCriteria: '' });
    expect(() => renderHtmlReport(report)).not.toThrow();
  });

  it('keeps only typed metadata fields', async () => {
    const report = await runScan(
      modelOutput({
        metadata: { pageTitle: { text: 'Home' }, engineMode: 'lighthouse-only', scanDuration: 'x', userAgent: 'UA' },
      }),
    );
    expect(report.structured.metadata).toEqual({ userAgent: 'UA' });
    expect(() => renderHtmlReport(report)).not.toThrow();
  });

  it('keeps a string page title', async () => {
    const report = await runScan(modelOutput({ metadata: { pageTitle: 'Home', scanDuration: 12 } }));
    expect(report.structured.metadata).toEqual({ pageTitle: 'Home', scanDuration: 12 });
  });

  it('keeps the scanned URL as structured.url rather than the model-supplied one', async () => {
    const report = await runScan(modelOutput({ url: 'https://attacker.test/phish' }));
    expect(report.structured.url).toBe(SCAN_URL);
  });
});

describe('scan URL validation errors', () => {
  it('does not name the private address a hostname resolves to', async () => {
    state.aRecords = ['10.20.30.40'];
    const engine = new A11yHawkEngine({ logger: silent });

    const error = await engine
      .scan('https://intranet.test/', { lighthouse: false, llm: { apiKey: 'k' }, logger: silent })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScanError);
    expect((error as ScanError).code).toBe('invalid-url');
    expect((error as ScanError).message).not.toContain('10.20.30.40');
    expect(state.analyzePageCalls).toBe(0);
  });
});

describe('request filter', () => {
  it('refuses a filtered scan URL with a non-retryable blocked-by-filter error before any browser work', async () => {
    const seen: string[] = [];
    const engine = new A11yHawkEngine({
      logger: silent,
      requestFilter: (url) => {
        seen.push(url.hostname);
        return { allowed: false, reason: 'listed by threat feed' };
      },
    });

    const error = await engine
      .scan(SCAN_URL, { lighthouse: false, llm: { apiKey: 'k' }, logger: silent })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScanError);
    expect((error as ScanError).code).toBe('blocked-by-filter');
    expect((error as ScanError).retryable).toBe(false);
    expect((error as ScanError).message).toContain('listed by threat feed');
    expect(seen).toEqual(['scan-target.test']);
    expect(state.analyzePageCalls).toBe(0);
  });

  it('treats a throwing filter as a refusal', async () => {
    const engine = new A11yHawkEngine({
      logger: silent,
      requestFilter: () => {
        throw new Error('lookup down');
      },
    });

    const error = await engine
      .scan(SCAN_URL, { lighthouse: false, llm: { apiKey: 'k' }, logger: silent })
      .catch((e: unknown) => e);

    expect((error as ScanError).code).toBe('blocked-by-filter');
    expect(state.analyzePageCalls).toBe(0);
  });

  it('does not run the filter on a scan URL the SSRF check refused', async () => {
    state.aRecords = ['10.20.30.40'];
    let calls = 0;
    const engine = new A11yHawkEngine({
      logger: silent,
      requestFilter: () => {
        calls += 1;
        return { allowed: true };
      },
    });

    const error = await engine
      .scan('https://intranet.test/', { lighthouse: false, llm: { apiKey: 'k' }, logger: silent })
      .catch((e: unknown) => e);

    expect((error as ScanError).code).toBe('invalid-url');
    expect(calls).toBe(0);
  });

  it('maps a filtered main-page block during capture to blocked-by-filter', async () => {
    state.captureError = new BlockedRequestError('Request to https://bad.test/ was blocked by the request filter: x', {
      filtered: true,
    });
    const engine = new A11yHawkEngine({ logger: silent, requestFilter: () => ({ allowed: true }) });

    const error = await engine
      .scan(SCAN_URL, { lighthouse: false, llm: { apiKey: 'k' }, logger: silent })
      .catch((e: unknown) => e);

    expect((error as ScanError).code).toBe('blocked-by-filter');
    expect((error as ScanError).retryable).toBe(false);
  });

  it('keeps blocked-request for an SSRF block during capture', async () => {
    state.captureError = new BlockedRequestError('Request to http://10.0.0.1/ was blocked for security reasons: x');
    const engine = new A11yHawkEngine({ logger: silent });

    const error = await engine
      .scan(SCAN_URL, { lighthouse: false, llm: { apiKey: 'k' }, logger: silent })
      .catch((e: unknown) => e);

    expect((error as ScanError).code).toBe('blocked-request');
  });

  it('lists the hosts the filter refused during capture in the report', async () => {
    state.filteredRequests = [{ host: 'cdn.bad.test', reason: 'listed by threat feed' }];
    const engine = new A11yHawkEngine({ logger: silent, requestFilter: () => ({ allowed: true }) });

    const report = await engine.scan(SCAN_URL, {
      lighthouse: false,
      annotate: false,
      llm: { apiKey: 'k' },
      logger: silent,
    });

    expect(report.filteredRequests).toEqual([{ host: 'cdn.bad.test', reason: 'listed by threat feed' }]);
  });
});
