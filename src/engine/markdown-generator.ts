import type { StructuredScanOutput, AccessibilityIssue } from '../types.js';
import type { LighthouseTransformedResult, LighthouseIssue } from './lighthouse.js';

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

  // Introduction paragraph
  sections.push(generateIntroduction(data));
  sections.push('---\n');

  // Build a set of WCAG criteria that Lighthouse detected for cross-referencing
  const lighthouseWcagCriteria = new Set<string>();
  if (options?.lighthouseResult) {
    for (const lhIssue of options.lighthouseResult.issues) {
      if (lhIssue.wcagCriteria && lhIssue.wcagCriteria !== 'unknown') {
        lighthouseWcagCriteria.add(lhIssue.wcagCriteria);
      }
    }
  }

  // Calculate how many AI issues overlap with Lighthouse vs are AI-only discoveries
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

  // AI Analysis section
  const stats = data.statistics;
  const passedCriteria = data.wcagCoverage.filter((c) => c.passed).length;
  const totalCriteria = data.wcagCoverage.length;
  const compliancePercent = totalCriteria > 0 ? Math.round((passedCriteria / totalCriteria) * 100) : 0;

  sections.push('## AI Analysis\n');

  if (options?.lighthouseResult && options.lighthouseResult.issues.length > 0) {
    // Show comparison when Lighthouse data is available
    sections.push(
      `*A11yHawk AI analyzed the page screenshot, accessibility tree, and HTML to provide comprehensive coverage beyond automated testing.*\n`,
    );
    sections.push('| Metric | Value |');
    sections.push('|--------|-------|');
    sections.push(`| **Total Issues Found** | ${stats.totalIssues} |`);
    sections.push(
      `| 🔍 Lighthouse-confirmed | ${aiIssueStats.lighthouseConfirmed} issue${aiIssueStats.lighthouseConfirmed !== 1 ? 's' : ''} |`,
    );
    sections.push(`| ✨ AI-only discoveries | ${aiIssueStats.aiOnly} issue${aiIssueStats.aiOnly !== 1 ? 's' : ''} |`);
    sections.push(
      `| **Severity Breakdown** | ${stats.criticalIssues} critical • ${stats.highIssues} high • ${stats.mediumIssues} medium • ${stats.lowIssues} low |`,
    );
    sections.push(
      `| **WCAG ${level} Compliance** | ${compliancePercent}% (${passedCriteria}/${totalCriteria} criteria) |`,
    );
    sections.push(`| **Overall Score** | **${data.overallScore}/100** |`);
    sections.push('');
  } else {
    // Simpler view when no Lighthouse data
    sections.push('| Metric | Value |');
    sections.push('|--------|-------|');
    sections.push(`| **Total Issues Found** | ${stats.totalIssues} |`);
    sections.push(
      `| **Severity Breakdown** | ${stats.criticalIssues} critical • ${stats.highIssues} high • ${stats.mediumIssues} medium • ${stats.lowIssues} low |`,
    );
    sections.push(
      `| **WCAG ${level} Compliance** | ${compliancePercent}% (${passedCriteria}/${totalCriteria} criteria) |`,
    );
    sections.push(`| **Overall Score** | **${data.overallScore}/100** |`);
    sections.push('');
  }

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

  // WCAG Compliance Matrix
  sections.push('## WCAG Compliance Matrix\n');
  sections.push(generateComplianceTable(data.wcagCoverage));
  sections.push(
    `**Overall WCAG Level ${level} Compliance**: ${compliancePercent}% (${passedCriteria}/${totalCriteria} criteria fully compliant)\n`,
  );
  sections.push('---\n');

  // Technical Recommendations
  sections.push('## Technical Recommendations\n');
  sections.push(generateRecommendations(data.issues));
  sections.push('---\n');

  // Remediation Roadmap
  sections.push('## Accessibility Remediation Roadmap\n');
  sections.push(generateRemediationRoadmap(data.issues, level));
  sections.push('---\n');

  // Summary
  sections.push('## Summary\n');
  sections.push(generateSummary(data));
  sections.push(
    `By addressing the critical and high-priority issues first, this page can achieve functional accessibility for the majority of users with disabilities. Focus on the Phase 1 and Phase 2 items in the remediation roadmap above.`,
  );

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
function generateIntroduction(data: StructuredScanOutput): string {
  const stats = data.statistics;
  const total = stats.totalIssues;
  const critical = stats.criticalIssues;
  const high = stats.highIssues;

  if (total === 0) {
    return 'This page demonstrates excellent accessibility with no significant issues detected. The page follows WCAG best practices and provides a good foundation for users with disabilities.\n';
  }

  if (critical > 0) {
    const userGroups = ['screen reader users', 'keyboard users', 'users with visual impairments'];
    return `This page has **${critical} critical barrier${critical !== 1 ? 's' : ''}** that prevent access for users with disabilities. These issues significantly impact ${userGroups.slice(0, 2).join(' and ')}, making core functionality inaccessible. Immediate remediation is recommended to achieve baseline accessibility.\n`;
  }

  if (high > 0) {
    return `Overall, this page demonstrates some accessibility foundations but has ${high} high-priority issue${high !== 1 ? 's' : ''} that significantly impair usability. With targeted fixes to address these concerns, the page could achieve solid WCAG compliance.\n`;
  }

  return `This page has a solid accessibility foundation with only minor issues detected. The main concerns are medium and low priority items that, when addressed, will enhance the experience for all users.\n`;
}

/**
 * Format a single issue in markdown
 */
function formatIssue(issue: AccessibilityIssue, lighthouseWcagCriteria?: Set<string>): string {
  const lines: string[] = [];

  // Check if this issue was also detected by Lighthouse
  // Extract criterion number from wcagCriteria (e.g., "1.4.3" from "1.4.3 Contrast (Minimum)")
  const criterionMatch = issue.wcagCriteria.match(/^(\d+\.\d+\.\d+)/);
  const criterionNumber = criterionMatch ? criterionMatch[1] : null;
  const isLighthouseDetected = criterionNumber && lighthouseWcagCriteria?.has(criterionNumber);

  // Add Lighthouse badge to title if detected
  const lighthouseBadge = isLighthouseDetected ? ' 🔍' : '';
  lines.push(`#### ${issue.id}: ${issue.title}${lighthouseBadge}\n`);

  // Add Lighthouse detection note
  if (isLighthouseDetected) {
    lines.push(`> 🔍 *Also detected by Lighthouse automated audit*\n`);
  }

  lines.push(`- **Location**: ${issue.location}`);
  lines.push(`- **WCAG Criterion**: ${issue.wcagCriteria} (Level ${issue.wcagLevel})`);
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
 * Generate WCAG compliance table
 */
function generateComplianceTable(wcagCoverage: StructuredScanOutput['wcagCoverage']): string {
  const lines: string[] = [];

  lines.push('| Criterion | Title | Status | Issues | Priority |');
  lines.push('|-----------|-------|--------|--------|----------|');

  wcagCoverage.forEach((criterion) => {
    const status = criterion.passed ? '✅ Pass' : '❌ Fail';
    const issues = criterion.passed
      ? 'No issues found'
      : criterion.issues && criterion.issues.length > 0
        ? criterion.issues.join(', ')
        : 'Issues detected';

    // Determine priority based on whether there are issues
    const priority = criterion.passed ? '-' : determinePriorityFromIssues(criterion.issues || []);

    // Create link to W3C documentation
    const criteriaLink = `[**${criterion.criteriaId}**](https://www.w3.org/WAI/WCAG22/Understanding/${getCriteriaSlug(criterion.name)}.html)`;

    lines.push(`| ${criteriaLink} | ${criterion.name} | ${status} | ${issues} | ${priority} |`);
  });

  lines.push('');
  return lines.join('\n');
}

/**
 * Determine priority level from issue IDs
 */
function determinePriorityFromIssues(issueIds: string[]): string {
  if (issueIds.length === 0) return '-';
  // For simplicity, we'll return a generic priority
  // In a real implementation, you'd look up the actual issues
  return 'High';
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
function generateRemediationRoadmap(issues: AccessibilityIssue[], level: string): string {
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
    const criticalPercent = Math.round((immediate.length / issues.length) * 100);
    lines.push(
      `\n**Expected Impact**: Address ${criticalPercent}% of accessibility barriers, achieve baseline WCAG Level A compliance\n`,
    );
  }

  // Phase 2: High Priority
  if (highPriority.length > 0) {
    lines.push('### Phase 2: High Priority Improvements\n');
    highPriority.forEach((issue) => {
      lines.push(`- [ ] ${issue.title} (${issue.id})`);
    });
    const highPercent = Math.round(((immediate.length + highPriority.length) / issues.length) * 100);
    lines.push(
      `\n**Expected Impact**: Achieve ${highPercent}% WCAG Level ${level} compliance, improve usability for screen reader users\n`,
    );
  }

  // Phase 3: Medium Priority
  if (mediumPriority.length > 0) {
    lines.push('### Phase 3: Medium Priority Enhancements\n');
    mediumPriority.forEach((issue) => {
      lines.push(`- [ ] ${issue.title} (${issue.id})`);
    });
    lines.push(`\n**Expected Impact**: Achieve 95%+ WCAG Level ${level} compliance, enhance mobile accessibility\n`);
  }

  return lines.join('\n');
}

/**
 * Generate summary section
 */
function generateSummary(data: StructuredScanOutput): string {
  const lines: string[] = [];

  // What's Working Well (from passed checks)
  lines.push("**What's Working Well**:");
  if (data.passedChecks.length > 0) {
    data.passedChecks.slice(0, 3).forEach((check) => {
      lines.push(`- ${check.description}`);
    });
  } else {
    lines.push('- Basic page structure is present');
  }
  lines.push('');

  // Priority Fixes (top 3 issues by priority)
  lines.push('**Priority Fixes**:');
  const priorityIssues = [
    ...data.issues.filter((i) => i.fixPriority === 'Immediate'),
    ...data.issues.filter((i) => i.fixPriority === 'High Priority'),
    ...data.issues.filter((i) => i.fixPriority === 'Medium Priority'),
  ].slice(0, 3);

  if (priorityIssues.length > 0) {
    priorityIssues.forEach((issue) => {
      lines.push(`- ${issue.title} (${issue.id})`);
    });
  } else {
    lines.push('- Continue monitoring for accessibility best practices');
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Capitalize first letter of a string
 */
function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Calculate AI issue statistics (Lighthouse-confirmed vs AI-only)
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
    const severityEmoji = getSeverityEmoji(issue.severity);
    const elementCount = issue.elements.length;
    const elementsDisplay = elementCount > 0 ? `${elementCount} element${elementCount !== 1 ? 's' : ''}` : '-';

    // Truncate description if too long
    const shortDesc = truncateText(issue.title, 60);

    // Link WCAG criteria to W3C Understanding docs (more reliable than Chrome docs)
    const wcagLink =
      issue.wcagCriteria !== 'unknown'
        ? `[${issue.wcagCriteria}](https://www.w3.org/WAI/WCAG22/Understanding/${getWcagSlug(issue.wcagCriteria)})`
        : issue.wcagCriteria;

    lines.push(
      `| ${issue.auditId} | ${wcagLink} | ${severityEmoji} ${capitalizeFirst(issue.severity)} | ${elementsDisplay} | ${shortDesc} |`,
    );
  });

  lines.push('');
  return lines.join('\n');
}

/**
 * Get emoji for severity level
 */
function getSeverityEmoji(severity: string): string {
  switch (severity) {
    case 'critical':
      return '🔴';
    case 'serious':
      return '🟠';
    case 'moderate':
      return '🟡';
    case 'minor':
      return '🟢';
    default:
      return '⚪';
  }
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
