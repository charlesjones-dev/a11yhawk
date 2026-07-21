import { describe, expect, it } from 'vitest';
import { transformLighthouseToIssues, type LighthouseA11yResult } from './lighthouse.js';

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
});
