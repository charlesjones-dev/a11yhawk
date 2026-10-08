/**
 * Security regression tests through the real A11yHawkEngine.scan() pipeline, with the
 * browser stage, the LLM transport, and DNS mocked in-process (no network, no browser,
 * no Lighthouse).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  usage: null as null | Record<string, unknown>,
  analyzePageCalls: 0,
}));

vi.mock('dns/promises', () => ({
  resolve4: async () => ['93.184.216.34'],
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
      return {
        title: 'Page',
        screenshotBuffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        screenshotTiles: ['AAAA'],
        accessibilityTree: { role: 'WebArea', children: [] },
        html: '<html><body><p>page</p></body></html>',
        finalUrl: 'https://scan-target.test/',
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
      return {
        content: JSON.stringify({
          overallScore: 100,
          url: 'https://scan-target.test/',
          scanDate: '2026-10-07T00:00:00.000Z',
          standard: 'WCAG 2.1 Level AA',
          issues: [],
          statistics: {},
          wcagCoverage: [],
          passedChecks: [],
        }),
        usage: state.usage,
      };
    }
  },
}));

import type { Logger } from '../logger/index.js';
import { renderHtmlReport } from './html-report.js';
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
