import { describe, expect, it } from 'vitest';

import type { LighthouseIssue } from './lighthouse.js';
import type { LogContext, Logger } from '../logger/index.js';
import { buildJsonScanPrompt, getWcagCriteria, SCAN_JSON_SYSTEM_PROMPT } from './prompts.js';

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

describe('WCAG criteria tables', () => {
  // Success criterion counts per W3C: WCAG 2.0 has 61, 2.1 adds 17 (78), and
  // 2.2 adds 9 and removes the obsolete 4.1.1 Parsing (86).
  it.each([
    ['2.0', { A: 25, AA: 38, AAA: 61 }],
    ['2.1', { A: 30, AA: 50, AAA: 78 }],
    ['2.2', { A: 31, AA: 55, AAA: 86 }],
  ] as const)('WCAG %s has the W3C criterion counts per level', (version, counts) => {
    expect(getWcagCriteria(version, 'A')).toHaveLength(counts.A);
    expect(getWcagCriteria(version, 'AA')).toHaveLength(counts.AA);
    expect(getWcagCriteria(version, 'AAA')).toHaveLength(counts.AAA);
  });

  it('lists each criterion once per version', () => {
    for (const version of ['2.0', '2.1', '2.2']) {
      const ids = getWcagCriteria(version, 'AAA').map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('includes the WCAG 2.1 AAA additions and drops 4.1.1 from 2.2 only', () => {
    const ids21 = getWcagCriteria('2.1', 'AAA').map((c) => c.id);
    expect(ids21).toEqual(expect.arrayContaining(['2.2.6', '2.3.3', '4.1.1']));

    const ids22 = getWcagCriteria('2.2', 'AAA').map((c) => c.id);
    expect(ids22).toEqual(expect.arrayContaining(['2.2.6', '2.3.3']));
    expect(ids22).not.toContain('4.1.1');
  });
});

describe('SCAN_JSON_SYSTEM_PROMPT guidance', () => {
  it('keeps single-page scans from failing site-level criteria without evidence', () => {
    for (const criterion of ['2.4.5 Multiple Ways', '2.4.8 Location', '2.4.1 Bypass Blocks', '3.3.5 Help']) {
      expect(SCAN_JSON_SYSTEM_PROMPT).toContain(criterion);
    }
    expect(SCAN_JSON_SYSTEM_PROMPT).toContain('set passed: true with no issues');
  });

  it('treats a missing main landmark as a low best practice item', () => {
    expect(SCAN_JSON_SYSTEM_PROMPT).toContain('A missing <main> landmark on its own is a best practice item');
    expect(SCAN_JSON_SYSTEM_PROMPT).toContain('"1.3.1 Info and Relationships (best practice)"');
  });

  it('asks for plain report language without compliance claims', () => {
    expect(SCAN_JSON_SYSTEM_PROMPT).toContain(
      'Never state or predict that the page or site is compliant, conformant, or accessible',
    );
    expect(SCAN_JSON_SYSTEM_PROMPT).not.toContain('WCAG compliance impact');
  });
});
