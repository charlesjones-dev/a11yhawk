import { describe, expect, it } from 'vitest';

import { ScanError, scan } from './index.js';

describe('scan input validation', () => {
  it('rejects a malformed URL before any browser work', async () => {
    const error = await scan('not-a-url').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScanError);
    expect((error as ScanError).code).toBe('invalid-url');
    expect((error as ScanError).retryable).toBe(false);
  });

  it('rejects a configuration with neither LLM nor Lighthouse', async () => {
    const error = await scan('https://example.com', { lighthouse: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScanError);
    expect((error as ScanError).code).toBe('invalid-options');
  });

  it('rejects non-http(s) protocols even with allowPrivateNetworks', async () => {
    const error = await scan('ftp://internal.host/file', { allowPrivateNetworks: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScanError);
    expect((error as ScanError).code).toBe('invalid-url');
  });
});
