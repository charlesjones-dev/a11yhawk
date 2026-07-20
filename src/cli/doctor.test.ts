import { afterEach, describe, expect, it, vi } from 'vitest';

import { runDoctor } from './doctor.js';

/** Capture everything runDoctor writes to stdout during a call. */
async function captureDoctor(env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  let output = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    output += String(chunk);
    return true;
  });
  try {
    const code = await runDoctor(env);
    return { code, output };
  } finally {
    spy.mockRestore();
  }
}

describe('runDoctor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports all four checks and returns a valid exit code', async () => {
    const { code, output } = await captureDoctor({});
    expect(output).toContain('Node.js >= 20');
    expect(output).toContain('Playwright Chromium');
    expect(output).toContain('Lighthouse CLI');
    expect(output).toContain('LLM API key');
    // Node is guaranteed >= 20 in the test runner, so its check must pass.
    expect(output).toMatch(/\[ok\] Node\.js >= 20/);
    expect([0, 3]).toContain(code);
  });

  it('treats the API key as informational, never as a failure', async () => {
    const withKey = await captureDoctor({ A11YHAWK_API_KEY: 'sk-test' });
    expect(withKey.output).toContain('configured (LLM analysis available)');

    const withoutKey = await captureDoctor({});
    expect(withoutKey.output).toContain('not set (Lighthouse-only mode)');
    // The two runs differ only in key presence, so their exit codes must match:
    // the key never changes readiness.
    expect(withKey.code).toBe(withoutKey.code);
  });
});
