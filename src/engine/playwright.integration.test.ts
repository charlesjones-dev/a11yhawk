import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlaywrightService } from './playwright.js';

// Real Chromium is required: A11YHAWK_BROWSER_TEST=1 npx vitest run src/engine/playwright.integration.test.ts
describe.runIf(process.env.A11YHAWK_BROWSER_TEST === '1')('browser connection after long uptime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('connects after the process has been running for more than 2^31 milliseconds', async () => {
    const now = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => now() + 28 * 24 * 60 * 60 * 1000);
    const service = new PlaywrightService();

    try {
      await service.initialize();
      expect(service.getCDPPort()).toBeGreaterThan(0);
    } finally {
      await service.cleanup();
    }
  }, 60_000);
});
