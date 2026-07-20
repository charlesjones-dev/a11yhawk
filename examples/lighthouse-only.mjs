/**
 * Free deterministic scan of any public URL (no API key needed).
 *
 * Run: node examples/lighthouse-only.mjs https://example.com
 */
import { scan } from 'a11yhawk';

const url = process.argv[2] ?? 'https://example.com';
console.log(`Scanning ${url} (Lighthouse-only)...`);

const report = await scan(url, {
  onProgress: (e) => console.error(`  [${e.stage}] ${e.message}`),
});

console.log(`\nScore: ${report.structured.overallScore}/100 in ${(report.durationMs / 1000).toFixed(1)}s`);
console.log(`Final URL: ${report.finalUrl}`);
const { criticalIssues, highIssues, mediumIssues, lowIssues } = report.structured.statistics;
console.log(`Issues: ${criticalIssues} critical, ${highIssues} high, ${mediumIssues} medium, ${lowIssues} low`);
for (const issue of report.structured.issues) {
  console.log(`  - [${issue.severity}] ${issue.title} (WCAG ${issue.wcagCriteria})`);
}
