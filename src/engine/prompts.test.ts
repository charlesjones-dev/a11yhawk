import { describe, expect, it } from 'vitest';

import type { LighthouseIssue } from './lighthouse.js';
import type { LogContext, Logger } from '../logger/index.js';
import { buildJsonScanPrompt } from './prompts.js';

/** Fake logger that captures every call so tests can assert log routing. */
function createCapturingLogger(): Logger & { calls: { level: string; message: string; context?: LogContext }[] } {
  const calls: { level: string; message: string; context?: LogContext }[] = [];
  const logger = {
    calls,
    debug(message: string, context?: LogContext) {
      calls.push({ level: 'debug', message, context });
    },
    info(message: string, context?: LogContext) {
      calls.push({ level: 'info', message, context });
    },
    warn(message: string, context?: LogContext) {
      calls.push({ level: 'warn', message, context });
    },
    error(message: string, context?: LogContext) {
      calls.push({ level: 'error', message, context });
    },
    child() {
      return logger;
    },
    async flush() {},
  };
  return logger;
}

function makeLighthouseIssue(): LighthouseIssue {
  return {
    auditId: 'image-alt',
    title: 'Images do not have alt text',
    description: 'Informative elements should aim for short, descriptive alternate text.',
    wcagCriteria: '1.1.1',
    severity: 'critical',
    elements: [
      {
        selector: 'img.hero',
        snippet: '<img class="hero" src="hero.png">',
        explanation: 'Element does not have an alt attribute',
        nodeLabel: 'hero image',
      },
    ],
    displayValue: '1 element',
  };
}

describe('buildJsonScanPrompt logging', () => {
  it('routes the Lighthouse context optimization log through the injected logger', async () => {
    const logger = createCapturingLogger();

    await buildJsonScanPrompt(
      'https://example.com',
      null,
      '<html><body><img src="hero.png"></body></html>',
      'WCAG 2.2 - AA',
      [makeLighthouseIssue()],
      1,
      logger,
    );

    const optimizationLogs = logger.calls.filter((c) => c.message === 'Lighthouse context optimization');
    expect(optimizationLogs).toHaveLength(1);
    expect(optimizationLogs[0]?.level).toBe('info');
    expect(optimizationLogs[0]?.context).toMatchObject({ issueCount: 1 });
    expect(optimizationLogs[0]?.context).toHaveProperty('compactTokens');
    expect(optimizationLogs[0]?.context).toHaveProperty('tokensSaved');
  });

  it('routes the token budget warning through the injected logger', async () => {
    const logger = createCapturingLogger();
    // Enough issues that even the compact format exceeds the 1000-token budget.
    const issues = Array.from({ length: 100 }, () => makeLighthouseIssue());

    await buildJsonScanPrompt('https://example.com', null, '<html></html>', 'WCAG 2.2 - AA', issues, 1, logger);

    const warnings = logger.calls.filter((c) => c.message === 'Lighthouse data exceeds token budget');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.level).toBe('warn');
  });

  it('does not fail without an injected logger', async () => {
    await expect(
      buildJsonScanPrompt('https://example.com', null, '<html></html>', 'WCAG 2.2 - AA', [makeLighthouseIssue()], 1),
    ).resolves.toContain('Lighthouse Pre-Scan');
  });
});
