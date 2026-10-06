import type { StructuredScanOutput, AccessibilityIssue } from '../types.js';
import type { LighthouseTransformedResult, LighthouseIssue } from './lighthouse.js';
import { isBestPracticeAudit, lighthouseCrossReferenceCriteria } from './lighthouse.js';

const SEVERITY_RANK: Record<AccessibilityIssue['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Options for markdown generation
 */
export interface MarkdownGeneratorOptions {
  /** Lighthouse audit results (optional) */
  lighthouseResult?: LighthouseTransformedResult | null;
}

/**
 * Transforms structured JSON scan output into the markdown format
 * that users currently see in the scan viewer.
 */
export function generateMarkdownFromStructured(data: StructuredScanOutput, options?: MarkdownGeneratorOptions): string {
  const sections: string[] = [];

  // Extract site name from URL or page title
  const siteName = extractSiteName(data.url, data.metadata?.pageTitle);

  // Parse standard to get version and level
  const [version, level] = parseStandard(data.standard);

  // Format date
  const formattedDate = formatScanDate(data.scanDate);

  // Header section
  sections.push(`## Accessibility Report: ${siteName}\n`);
  sections.push(`*Scanned ${data.url} on ${formattedDate} • WCAG ${version} Level ${level}*\n`);

  // Lighthouse-only scans have no AI review, and their WCAG coverage lists only
  // the criteria Lighthouse found issues under (it cannot vouch for the rest).
  const lighthouseOnly = data.metadata?.engineMode === 'lighthouse-only';
  const checksLabel = lighthouseOnly ? 'automated checks' : 'automated and AI checks';

  // Introduction paragraph
  sections.push(generateIntroduction(data, checksLabel));
  sections.push('---\n');

  // WCAG criteria Lighthouse found issues under (plus the related criteria of
  // best-practice audits), for cross-referencing with AI findings. Lighthouse-only
  // findings all come from Lighthouse, so there is nothing to cross-reference.
  const lighthouseWcagCriteria = new Set(
    options?.lighthouseResult && !lighthouseOnly
      ? lighthouseCrossReferenceCriteria(options.lighthouseResult.issues)
      : [],
  );

  // Calculate how many AI issues share a criterion with a Lighthouse finding
  const aiIssueStats = calculateAiIssueStats(data.issues, lighthouseWcagCriteria);

  // Lighthouse Automated Audit section (if available)
  if (options?.lighthouseResult && options.lighthouseResult.issues.length > 0) {
    sections.push('## Lighthouse Audit\n');
    sections.push(
      `*Google Lighthouse automated scan detected **${options.lighthouseResult.issues.length} issue${options.lighthouseResult.issues.length !== 1 ? 's' : ''}** (Score: ${options.lighthouseResult.summary.lighthouseScore}/100)*\n`,
    );
    sections.push(generateLighthouseTable(options.lighthouseResult.issues));
    sections.push('---\n');
  }

  // Results section
  const stats = data.statistics;
  const criteriaWithoutIssues = data.wcagCoverage.filter((c) => c.passed).length;
  const totalCriteria = data.wcagCoverage.length;
  const criteriaWithoutIssuesPercent =
    totalCriteria > 0 ? Math.round((criteriaWithoutIssues / totalCriteria) * 100) : 0;
  const hasLighthouseIssues = Boolean(options?.lighthouseResult && options.lighthouseResult.issues.length > 0);

  sections.push(lighthouseOnly ? '## Results\n' : '## AI Analysis\n');

  if (!lighthouseOnly) {
    sections.push(
      hasLighthouseIssues
        ? '*An AI model reviewed the page screenshot, accessibility tree, HTML and Lighthouse results.*\n'
        : '*An AI model reviewed the page screenshot, accessibility tree and HTML.*\n',
    );
  }
  sections.push('| Metric | Value |');
  sections.push('|--------|-------|');
  sections.push(`| **Total Issues Found** | ${stats.totalIssues} |`);
  if (!lighthouseOnly && hasLighthouseIssues) {
    sections.push(
      `| Same criterion flagged by Lighthouse | ${aiIssueStats.lighthouseConfirmed} issue${aiIssueStats.lighthouseConfirmed !== 1 ? 's' : ''} |`,
    );
    sections.push(
      `| Not flagged by Lighthouse | ${aiIssueStats.aiOnly} issue${aiIssueStats.aiOnly !== 1 ? 's' : ''} |`,
    );
  }
  sections.push(
    `| **Severity Breakdown** | ${stats.criticalIssues} critical • ${stats.highIssues} high • ${stats.mediumIssues} medium • ${stats.lowIssues} low |`,
  );
  if (!lighthouseOnly) {
    sections.push(
      `| **Criteria with no issues found** | ${criteriaWithoutIssues} of ${totalCriteria} (${criteriaWithoutIssuesPercent}%) |`,
    );
  }
  sections.push(`| **Overall Score** | **${data.overallScore}/100** |`);
  sections.push('');

  sections.push('---\n');

  // Accessibility Findings section
  sections.push('## Accessibility Findings\n');

  // Group issues by severity
  const criticalIssues = data.issues.filter((i) => i.severity === 'critical');
  const highIssues = data.issues.filter((i) => i.severity === 'high');
  const mediumIssues = data.issues.filter((i) => i.severity === 'medium');
  const lowIssues = data.issues.filter((i) => i.severity === 'low');

  // Critical Severity Findings
  if (criticalIssues.length > 0) {
    sections.push('### Critical Severity Findings\n');
    criticalIssues.forEach((issue) => {
      sections.push(formatIssue(issue, lighthouseWcagCriteria));
    });
  }

  // High Severity Findings
  if (highIssues.length > 0) {
    sections.push('### High Severity Findings\n');
    highIssues.forEach((issue) => {
      sections.push(formatIssue(issue, lighthouseWcagCriteria));
    });
  }

  // Medium Severity Findings
  if (mediumIssues.length > 0) {
    sections.push('### Medium Severity Findings\n');
    mediumIssues.forEach((issue) => {
      sections.push(formatIssue(issue, lighthouseWcagCriteria));
    });
  }

  // Low Severity Findings
  if (lowIssues.length > 0) {
    sections.push('### Low Severity Findings\n');
    lowIssues.forEach((issue) => {
      sections.push(formatIssue(issue, lighthouseWcagCriteria));
    });
  }

  sections.push('---\n');

  // WCAG criteria table
  if (lighthouseOnly) {
    sections.push('## WCAG criteria with issues found\n');
    if (data.wcagCoverage.length > 0) {
      sections.push(generateCriteriaTable(data.wcagCoverage, data.issues));
      sections.push(
        'Lighthouse reports only failing audits, so this table lists only the criteria where it found issues.\n',
      );
    } else {
      sections.push('Lighthouse found no issues under a WCAG criterion.\n');
    }
  } else {
    sections.push('## WCAG criteria checked\n');
    sections.push(generateCriteriaTable(data.wcagCoverage, data.issues));
    sections.push(`${criteriaWithoutIssues} of ${totalCriteria} checked criteria had no issues found.\n`);
  }
  sections.push('---\n');

  // Technical Recommendations
  sections.push('## Technical Recommendations\n');
  sections.push(generateRecommendations(data.issues));
  sections.push('---\n');

  // Remediation Roadmap
  sections.push('## Accessibility Remediation Roadmap\n');
  sections.push(generateRemediationRoadmap(data.issues));
  sections.push('---\n');

  // Summary
  sections.push('## Summary\n');
  sections.push(generateSummary(data));
  sections.push(generateClosing(data, checksLabel));

  return sections.join('\n');
}

/**
 * Extract a clean site name from URL or page title
 */
function extractSiteName(url: string, pageTitle?: string): string {
  if (pageTitle) {
    // Remove common suffixes and clean up title
    const cleanTitle = pageTitle
      .replace(/\s*[-–|]\s*.*/g, '') // Remove everything after dash, pipe, etc.
      .trim();
    if (cleanTitle) return cleanTitle;
  }

  // Fall back to domain name
  try {
    const urlObj = new URL(url);
    let domain = urlObj.hostname.replace(/^www\./, '');

    // Capitalize first letter
    domain = domain.charAt(0).toUpperCase() + domain.slice(1);

    return domain;
  } catch {
    return 'Website';
  }
}

/**
 * Parse standard string to extract version and level
 */
function parseStandard(standard: string): [string, string] {
  const match = standard.match(/WCAG\s+(\d+\.\d+)\s+Level\s+(A{1,3})/i);
  if (match) {
    return [match[1] ?? '2.2', match[2] ?? 'AA'];
  }
  return ['2.2', 'AA']; // Default fallback
}

/**
 * Format ISO date to readable format
 */
function formatScanDate(isoDate: string): string {
  try {
    const date = new Date(isoDate);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }
}

/**
 * Generate an introduction paragraph based on scan statistics
 */
function generateIntroduction(data: StructuredScanOutput, checksLabel: string): string {
  const stats = data.statistics;
  const total = stats.totalIssues;
  const critical = stats.criticalIssues;
  const high = stats.highIssues;

  if (total === 0) {
    return `This scan found no issues. ${capitalizeFirst(checksLabel)} cover only part of WCAG, so also test with a keyboard and a screen reader.\n`;
  }

  if (critical > 0) {
    return `This scan found **${critical} critical issue${critical !== 1 ? 's' : ''}** that can prevent some people with disabilities from using parts of the page.\n`;
  }

  if (high > 0) {
    return `This scan found no critical issues and **${high} high-severity issue${high !== 1 ? 's' : ''}** that can make parts of the page hard to use for people with disabilities.\n`;
  }

  return total === 1
    ? 'This scan found 1 issue, which is not critical or high severity.\n'
    : `This scan found ${total} issues, none of them critical or high severity.\n`;
}

/**
 * Format a single issue in markdown
 */
function formatIssue(issue: AccessibilityIssue, lighthouseWcagCriteria?: Set<string>): string {
  const lines: string[] = [];

  // Check if Lighthouse found an issue under the same criterion
  // Extract criterion number from wcagCriteria (e.g., "1.4.3" from "1.4.3 Contrast (Minimum)")
  const criterionMatch = issue.wcagCriteria.match(/^(\d+\.\d+\.\d+)/);
  const criterionNumber = criterionMatch ? criterionMatch[1] : null;
  const isLighthouseDetected = criterionNumber && lighthouseWcagCriteria?.has(criterionNumber);

  lines.push(`#### ${issue.id}: ${issue.title}\n`);

  if (isLighthouseDetected) {
    lines.push(`> *Lighthouse also reported an issue related to ${criterionNumber}.*\n`);
  }

  lines.push(`- **Location**: ${issue.location}`);
  // The level belongs to a criterion; best-practice items without one show no level
  lines.push(
    criterionNumber
      ? `- **WCAG Criterion**: ${issue.wcagCriteria} (Level ${issue.wcagLevel})`
      : `- **WCAG Criterion**: ${issue.wcagCriteria}`,
  );
  lines.push(`- **Severity**: ${capitalizeFirst(issue.severity)}`);
  lines.push(`- **Pattern Detected**: ${issue.patternDetected}`);

  // Code Context
  if (issue.codeContext) {
    lines.push(`- **Code Context**:`);
    lines.push('```html');
    lines.push(issue.codeContext);
    lines.push('```');
  } else {
    lines.push(
      `- **Code Context**: N/A - Issue detected visually; specific code location not identified in provided HTML`,
    );
  }

  lines.push(`- **Impact**: ${issue.impact}`);
  lines.push(`- **User Impact**: ${issue.userImpact}`);
  lines.push(`- **Recommendation**: ${issue.recommendation}`);
  lines.push(`- **Fix Priority**: ${issue.fixPriority}\n`);

  // Remediation
  lines.push('**Remediation**:');
  lines.push('```html');
  lines.push(issue.remediation);
  lines.push('```\n');

  return lines.join('\n');
}

/**
 * Generate the WCAG criteria table: what was checked and what was found per criterion
 */
function generateCriteriaTable(
  wcagCoverage: StructuredScanOutput['wcagCoverage'],
  issues: AccessibilityIssue[],
): string {
  const lines: string[] = [];
  const issuesById = new Map(issues.map((issue) => [issue.id, issue]));

  lines.push('| Criterion | Title | Result | Issues | Highest severity |');
  lines.push('|-----------|-------|--------|--------|------------------|');

  wcagCoverage.forEach((criterion) => {
    const result = criterion.passed ? 'No issues found' : 'Issues found';
    const issueIds = criterion.passed ? [] : (criterion.issues ?? []);
    const issuesCell = issueIds.length > 0 ? issueIds.join(', ') : '-';

    // Highest severity among the issues mapped to this criterion
    const linked = issueIds
      .map((id) => issuesById.get(id))
      .filter((issue): issue is AccessibilityIssue => issue !== undefined);
    const highest = linked.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0];
    const severity = highest ? capitalizeFirst(highest.severity) : '-';

    // Create link to W3C documentation
    const criteriaLink = `[**${criterion.criteriaId}**](https://www.w3.org/WAI/WCAG22/Understanding/${getCriteriaSlug(criterion.name)}.html)`;

    lines.push(`| ${criteriaLink} | ${criterion.name} | ${result} | ${issuesCell} | ${severity} |`);
  });

  lines.push('');
  return lines.join('\n');
}

/**
 * Convert criterion name to W3C URL slug
 */
function getCriteriaSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Generate technical recommendations section
 */
function generateRecommendations(issues: AccessibilityIssue[]): string {
  const lines: string[] = [];

  // Group by priority
  const immediate = issues.filter((i) => i.fixPriority === 'Immediate');
  const highPriority = issues.filter((i) => i.fixPriority === 'High Priority');
  const mediumPriority = issues.filter((i) => i.fixPriority === 'Medium Priority');

  if (immediate.length > 0) {
    lines.push('### Immediate Accessibility Fixes (Critical Priority)\n');
    immediate.forEach((issue, index) => {
      lines.push(`${index + 1}. **${issue.title}** (${issue.id}): ${issue.recommendation}`);
    });
    lines.push('');
  }

  if (highPriority.length > 0) {
    lines.push('### High Priority Accessibility Enhancements\n');
    highPriority.forEach((issue, index) => {
      lines.push(`${index + 1}. **${issue.title}** (${issue.id}): ${issue.recommendation}`);
    });
    lines.push('');
  }

  if (mediumPriority.length > 0) {
    lines.push('### Medium Priority Improvements\n');
    mediumPriority.forEach((issue, index) => {
      lines.push(`${index + 1}. **${issue.title}** (${issue.id}): ${issue.recommendation}`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate remediation roadmap section
 */
function generateRemediationRoadmap(issues: AccessibilityIssue[]): string {
  const lines: string[] = [];

  // Group by priority
  const immediate = issues.filter((i) => i.fixPriority === 'Immediate');
  const highPriority = issues.filter((i) => i.fixPriority === 'High Priority');
  const mediumPriority = issues.filter((i) => i.fixPriority === 'Medium Priority');

  // Phase 1: Critical
  if (immediate.length > 0) {
    lines.push('### Phase 1: Critical Accessibility Barriers\n');
    immediate.forEach((issue) => {
      lines.push(`- [ ] ${issue.title} (${issue.id})`);
    });
    lines.push('');
  }

  // Phase 2: High Priority
  if (highPriority.length > 0) {
    lines.push('### Phase 2: High Priority Improvements\n');
    highPriority.forEach((issue) => {
      lines.push(`- [ ] ${issue.title} (${issue.id})`);
    });
    lines.push('');
  }

  // Phase 3: Medium Priority
  if (mediumPriority.length > 0) {
    lines.push('### Phase 3: Medium Priority Enhancements\n');
    mediumPriority.forEach((issue) => {
      lines.push(`- [ ] ${issue.title} (${issue.id})`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate summary section
 */
function generateSummary(data: StructuredScanOutput): string {
  const lines: string[] = [];

  // What's Working Well (from passed checks)
  if (data.passedChecks.length > 0) {
    lines.push("**What's Working Well**:");
    data.passedChecks.slice(0, 3).forEach((check) => {
      lines.push(`- ${check.description}`);
    });
    lines.push('');
  }

  // Priority Fixes (top 3 issues by priority)
  const priorityIssues = [
    ...data.issues.filter((i) => i.fixPriority === 'Immediate'),
    ...data.issues.filter((i) => i.fixPriority === 'High Priority'),
    ...data.issues.filter((i) => i.fixPriority === 'Medium Priority'),
  ].slice(0, 3);

  if (priorityIssues.length > 0) {
    lines.push('**Priority Fixes**:');
    priorityIssues.forEach((issue) => {
      lines.push(`- ${issue.title} (${issue.id})`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Closing paragraph: the next step, and what this report does and does not establish
 */
function generateClosing(data: StructuredScanOutput, checksLabel: string): string {
  const scope = `This report covers one page and lists what ${checksLabel} found. It is not a compliance certification.`;
  if (data.issues.length === 0) return scope;
  const nextStep =
    data.issues.length === 1
      ? 'Fix the issue above, then scan again to confirm the fix.'
      : 'Fix the issues above, starting with the most severe, then scan again to confirm the fixes.';
  return `${nextStep} ${scope} ${capitalizeFirst(checksLabel)} cover only part of WCAG, so also test with a keyboard and a screen reader.`;
}

/**
 * Capitalize first letter of a string
 */
function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Count AI issues whose criterion Lighthouse also found an issue under, and the rest
 */
function calculateAiIssueStats(
  issues: AccessibilityIssue[],
  lighthouseWcagCriteria: Set<string>,
): { lighthouseConfirmed: number; aiOnly: number } {
  let lighthouseConfirmed = 0;
  let aiOnly = 0;

  for (const issue of issues) {
    // Extract criterion number from wcagCriteria (e.g., "1.4.3" from "1.4.3 Contrast (Minimum)")
    const criterionMatch = issue.wcagCriteria.match(/^(\d+\.\d+\.\d+)/);
    const criterionNumber = criterionMatch ? criterionMatch[1] : null;

    if (criterionNumber && lighthouseWcagCriteria.has(criterionNumber)) {
      lighthouseConfirmed++;
    } else {
      aiOnly++;
    }
  }

  return { lighthouseConfirmed, aiOnly };
}

/**
 * Generate Lighthouse findings table
 */
function generateLighthouseTable(issues: LighthouseIssue[]): string {
  const lines: string[] = [];

  lines.push('| Issue | WCAG | Severity | Elements | Description |');
  lines.push('|-------|------|----------|----------|-------------|');

  issues.forEach((issue) => {
    const elementCount = issue.elements.length;
    const elementsDisplay = elementCount > 0 ? `${elementCount} element${elementCount !== 1 ? 's' : ''}` : '-';

    // Truncate description if too long
    const shortDesc = truncateText(issue.title, 60);

    // Link WCAG criteria to W3C Understanding docs (more reliable than Chrome docs)
    const wcagLink =
      issue.wcagCriteria !== 'unknown'
        ? `[${issue.wcagCriteria}](https://www.w3.org/WAI/WCAG22/Understanding/${getWcagSlug(issue.wcagCriteria)})`
        : isBestPracticeAudit(issue.auditId)
          ? 'Best practice'
          : 'Not mapped';

    lines.push(
      `| ${issue.auditId} | ${wcagLink} | ${capitalizeFirst(issue.severity)} | ${elementsDisplay} | ${shortDesc} |`,
    );
  });

  lines.push('');
  return lines.join('\n');
}

/**
 * Truncate text with ellipsis if too long
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Map WCAG success criterion number to W3C Understanding doc slug
 */
const WCAG_CRITERION_SLUGS: Record<string, string> = {
  '1.1.1': 'non-text-content',
  '1.2.1': 'audio-only-and-video-only-prerecorded',
  '1.2.2': 'captions-prerecorded',
  '1.2.3': 'audio-description-or-media-alternative-prerecorded',
  '1.2.4': 'captions-live',
  '1.2.5': 'audio-description-prerecorded',
  '1.3.1': 'info-and-relationships',
  '1.3.2': 'meaningful-sequence',
  '1.3.3': 'sensory-characteristics',
  '1.3.4': 'orientation',
  '1.3.5': 'identify-input-purpose',
  '1.4.1': 'use-of-color',
  '1.4.2': 'audio-control',
  '1.4.3': 'contrast-minimum',
  '1.4.4': 'resize-text',
  '1.4.5': 'images-of-text',
  '1.4.10': 'reflow',
  '1.4.11': 'non-text-contrast',
  '1.4.12': 'text-spacing',
  '1.4.13': 'content-on-hover-or-focus',
  '2.1.1': 'keyboard',
  '2.1.2': 'no-keyboard-trap',
  '2.1.4': 'character-key-shortcuts',
  '2.2.1': 'timing-adjustable',
  '2.2.2': 'pause-stop-hide',
  '2.3.1': 'three-flashes-or-below-threshold',
  '2.4.1': 'bypass-blocks',
  '2.4.2': 'page-titled',
  '2.4.3': 'focus-order',
  '2.4.4': 'link-purpose-in-context',
  '2.4.5': 'multiple-ways',
  '2.4.6': 'headings-and-labels',
  '2.4.7': 'focus-visible',
  '2.4.11': 'focus-not-obscured-minimum',
  '2.5.1': 'pointer-gestures',
  '2.5.2': 'pointer-cancellation',
  '2.5.3': 'label-in-name',
  '2.5.4': 'motion-actuation',
  '2.5.5': 'target-size-enhanced',
  '2.5.7': 'dragging-movements',
  '2.5.8': 'target-size-minimum',
  '3.1.1': 'language-of-page',
  '3.1.2': 'language-of-parts',
  '3.2.1': 'on-focus',
  '3.2.2': 'on-input',
  '3.2.3': 'consistent-navigation',
  '3.2.4': 'consistent-identification',
  '3.2.6': 'consistent-help',
  '3.3.1': 'error-identification',
  '3.3.2': 'labels-or-instructions',
  '3.3.3': 'error-suggestion',
  '3.3.4': 'error-prevention-legal-financial-data',
  '3.3.7': 'redundant-entry',
  '3.3.8': 'accessible-authentication-minimum',
  '4.1.1': 'parsing',
  '4.1.2': 'name-role-value',
  '4.1.3': 'status-messages',
};

function getWcagSlug(criterion: string): string {
  return WCAG_CRITERION_SLUGS[criterion] || criterion.replace(/\./g, '-');
}
