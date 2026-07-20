/**
 * CI gating pattern: fail the build when the accessibility score drops below
 * a threshold. Lighthouse-only, so it is fast and free; add an llm block for
 * AI-backed gating.
 *
 * Run: node examples/ci-gate.mjs https://example.com 80
 * Exit codes: 0 pass, 1 below threshold, 2 scan error.
 */
import { scan, ScanError } from 'a11yhawk';

const url = process.argv[2] ?? 'https://example.com';
const minScore = Number(process.argv[3] ?? 80);

try {
  const report = await scan(url);
  const score = report.structured.overallScore;
  if (score < minScore) {
    console.error(`FAIL: score ${score} is below threshold ${minScore} (${report.structured.issues.length} issues)`);
    process.exit(1);
  }
  console.log(`PASS: score ${score} >= ${minScore}`);
} catch (error) {
  if (error instanceof ScanError) {
    console.error(`Scan error [${error.code}]: ${error.message}`);
    process.exit(2);
  }
  throw error;
}
