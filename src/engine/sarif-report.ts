/**
 * SARIF 2.1.0 report renderer.
 *
 * Turns a ScanReport into a SARIF log, the format CI systems and code scanning
 * tools read. Each issue becomes one result, and each WCAG success criterion
 * becomes one rule, so a criterion keeps the same rule id from scan to scan.
 * The result message carries the failing element and the suggested fix, so a
 * developer can act on a finding without opening the HTML report.
 *
 * Every result points at the scanned page URL, because a scan sees rendered
 * HTML and does not know which source file produced it.
 */
import { createHash } from 'node:crypto';

import type { AccessibilityIssue } from '../types.js';
import { readVersion, REPO_URL } from './html-report.js';
import { findWcagCriterion } from './prompts.js';
import type { ScanReport } from './scan.js';

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';

type SarifLevel = 'error' | 'warning' | 'note';

const LEVEL_FROM_SEVERITY: Record<AccessibilityIssue['severity'], SarifLevel> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'note',
};

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  help: { text: string };
  defaultConfiguration: { level: SarifLevel };
  properties: { tags: string[] };
}

/** A value from a stored or hand-built report as trimmed text, '' when absent. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The rule for an issue's wcagCriteria text. The text can be "1.1.1",
 * "1.1.1 Non-text Content", "Best practice", or "Outside WCAG 2.1 Level AA:
 * 1.4.6 Contrast (Enhanced)", so the first x.y.z number names the criterion.
 */
function ruleFor(wcagCriteria: string): SarifRule {
  const criterion = findWcagCriterion(/\b\d+\.\d+\.\d+\b/.exec(wcagCriteria)?.[0] ?? '');
  if (criterion !== undefined) {
    const label = `WCAG ${criterion.id} ${criterion.title} (Level ${criterion.level})`;
    return {
      id: `wcag/${criterion.id}`,
      name: criterion.title,
      shortDescription: { text: label },
      fullDescription: { text: `The page fails WCAG success criterion ${label}.` },
      help: { text: `${label}. Each result names the failing element and gives a suggested fix.` },
      defaultConfiguration: { level: 'warning' },
      properties: { tags: ['accessibility', 'wcag', `wcag-${criterion.level.toLowerCase()}`] },
    };
  }
  if (/^best practice/i.test(wcagCriteria)) {
    return {
      id: 'best-practice',
      name: 'Accessibility best practice',
      shortDescription: { text: 'Accessibility best practice' },
      fullDescription: { text: 'The page breaks an accessibility best practice that no WCAG criterion covers.' },
      help: { text: 'Accessibility best practice. Each result names the failing element and gives a suggested fix.' },
      defaultConfiguration: { level: 'note' },
      properties: { tags: ['accessibility', 'best-practice'] },
    };
  }
  return {
    id: 'unmapped',
    name: 'Accessibility issue',
    shortDescription: { text: 'Accessibility issue without a known WCAG criterion' },
    fullDescription: { text: 'The scan found an accessibility issue that it did not map to a WCAG criterion.' },
    help: { text: 'Accessibility issue. Each result names the failing element and gives a suggested fix.' },
    defaultConfiguration: { level: 'warning' },
    properties: { tags: ['accessibility'] },
  };
}

/** The result message: a one-sentence summary first, then the details on their own lines. */
function messageFor(issue: AccessibilityIssue): string {
  const title = text(issue.title) || 'Accessibility issue';
  const recommendation = text(issue.recommendation);
  const remediation = text(issue.remediation);
  const lines = [/[.!?]$/.test(title) ? title : `${title}.`];
  const location = text(issue.location);
  if (location) lines.push(`Location: ${location}`);
  const criteria = text(issue.wcagCriteria);
  if (criteria) lines.push(`WCAG: ${criteria}${issue.wcagLevel ? ` (Level ${issue.wcagLevel})` : ''}`);
  // Lighthouse-only issues copy one audit description into several fields, so print each text once.
  const impact = text(issue.userImpact) || text(issue.impact);
  if (impact && impact !== recommendation) lines.push(`Impact: ${impact}`);
  if (recommendation) lines.push(`Recommendation: ${recommendation}`);
  const code = text(issue.codeContext);
  if (code) lines.push('Element:', code);
  if (remediation && remediation !== recommendation) lines.push('Suggested fix:', remediation);
  return lines.join('\n');
}

/**
 * Render a scan as a SARIF 2.1.0 log (a JSON string). Issues marked resolved
 * are included with an external suppression, so tools show them as dismissed.
 */
export function renderSarifReport(input: ScanReport): string {
  const structured = input.structured;
  const issues: AccessibilityIssue[] = Array.isArray(structured.issues) ? structured.issues : [];
  const url = text(structured.url);

  const rules: SarifRule[] = [];
  const ruleIndex = new Map<string, number>();
  const results = issues.map((issue) => {
    const rule = ruleFor(text(issue.wcagCriteria));
    let index = ruleIndex.get(rule.id);
    if (index === undefined) {
      index = rules.push(rule) - 1;
      ruleIndex.set(rule.id, index);
    }
    const location = text(issue.location);
    const fingerprint = createHash('sha256')
      .update([rule.id, url, location, text(issue.codeContext)].join('\0'))
      .digest('hex')
      .slice(0, 32);

    return {
      ruleId: rule.id,
      ruleIndex: index,
      level: Object.hasOwn(LEVEL_FROM_SEVERITY, issue.severity) ? LEVEL_FROM_SEVERITY[issue.severity] : 'warning',
      message: { text: messageFor(issue) },
      locations: [
        {
          physicalLocation: { artifactLocation: { uri: url } },
          ...(location ? { logicalLocations: [{ fullyQualifiedName: location, kind: 'element' }] } : {}),
        },
      ],
      partialFingerprints: { primaryLocationLineHash: fingerprint },
      ...(issue.resolved === true
        ? {
            suppressions: [
              { kind: 'external', ...(text(issue.resolvedNote) ? { justification: text(issue.resolvedNote) } : {}) },
            ],
          }
        : {}),
      properties: {
        issueId: text(issue.id),
        severity: issue.severity,
        fixPriority: issue.fixPriority,
        wcagCriteria: text(issue.wcagCriteria),
      },
    };
  });

  const version = readVersion();
  const log = {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'A11yHawk',
            informationUri: REPO_URL,
            ...(version ? { version, semanticVersion: version } : {}),
            rules,
          },
        },
        results,
        properties: {
          url,
          standard: structured.standard,
          scanDate: structured.scanDate,
          overallScore: structured.overallScore,
        },
      },
    ],
  };
  return `${JSON.stringify(log, null, 2)}\n`;
}
