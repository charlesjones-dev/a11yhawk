import { describe, expect, it } from 'vitest';

import { ScanError, scan } from './index.js';
import type { LighthouseCategory } from './index.js';

/** Run scan() expecting a pre-browser rejection and return the ScanError. */
async function scanError(...args: Parameters<typeof scan>): Promise<ScanError> {
  const error = await scan(...args).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ScanError);
  return error as ScanError;
}

describe('scan input validation', () => {
  it('rejects a malformed URL before any browser work', async () => {
    const error = await scanError('not-a-url');
    expect(error.code).toBe('invalid-url');
    expect(error.retryable).toBe(false);
  });

  it('rejects a configuration with neither LLM nor Lighthouse', async () => {
    const error = await scanError('https://example.com', { lighthouse: false });
    expect(error.code).toBe('invalid-options');
  });

  it('rejects non-http(s) protocols even with allowPrivateNetworks', async () => {
    const error = await scanError('ftp://internal.host/file', { allowPrivateNetworks: true });
    expect(error.code).toBe('invalid-url');
  });

  it('rejects an empty lighthouse.categories list', async () => {
    const error = await scanError('https://example.com', { lighthouse: { categories: [] } });
    expect(error.code).toBe('invalid-options');
    expect(error.retryable).toBe(false);
  });

  it('rejects lighthouse categories that omit accessibility', async () => {
    const error = await scanError('https://example.com', { lighthouse: { categories: ['performance'] } });
    expect(error.code).toBe('invalid-options');
    expect(error.message).toContain('accessibility');
  });

  it('rejects unknown lighthouse categories', async () => {
    const categories = ['accessibility', 'seo'] as LighthouseCategory[];
    const error = await scanError('https://example.com', { lighthouse: { categories } });
    expect(error.code).toBe('invalid-options');
    expect(error.message).toContain('seo');
  });

  it('rejects screenshot: false in LLM mode', async () => {
    const error = await scanError('https://example.com', { llm: { apiKey: 'test-key' }, screenshot: false });
    expect(error.code).toBe('invalid-options');
    expect(error.retryable).toBe(false);
  });
});
