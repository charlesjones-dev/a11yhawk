/**
 * Full AI analysis of a URL. Writes JSON, markdown, HTML report, and
 * screenshots to examples/output/.
 *
 * Requires OPENROUTER_API_KEY in the environment (or adjust llm.baseUrl for
 * any OpenAI-compatible endpoint). LLM scans take minutes and cost tokens.
 *
 * Run: OPENROUTER_API_KEY=sk-... node examples/full-scan.mjs https://example.com
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_MODEL, renderHtmlReport, scan, ScanError } from 'a11yhawk';

const url = process.argv[2] ?? 'https://example.com';
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('Set OPENROUTER_API_KEY to run this example.');
  process.exit(3);
}

console.log(`Scanning ${url} with ${process.env.A11YHAWK_MODEL ?? DEFAULT_MODEL}...`);

try {
  const report = await scan(url, {
    llm: {
      apiKey,
      model: process.env.A11YHAWK_MODEL, // undefined falls back to DEFAULT_MODEL
    },
    wcagVersion: '2.2',
    wcagLevel: 'AA',
    onProgress: (e) => console.error(`  [${e.stage}] ${e.message}`),
  });

  const outDir = join(dirname(fileURLToPath(import.meta.url)), 'output');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report.structured, null, 2));
  writeFileSync(join(outDir, 'report.md'), report.markdown);
  writeFileSync(join(outDir, 'report.html'), renderHtmlReport(report));
  if (report.screenshot) writeFileSync(join(outDir, 'screenshot.jpg'), report.screenshot);
  if (report.annotatedScreenshot) writeFileSync(join(outDir, 'annotated.jpg'), report.annotatedScreenshot);

  console.log(`\nScore: ${report.structured.overallScore}/100`);
  console.log(`Issues: ${report.structured.issues.length}, passed checks: ${report.structured.passedChecks.length}`);
  if (report.usage) {
    console.log(
      `Tokens: ${report.usage.totalTokens}, cost: $${report.usage.cost.toFixed(4)} (${report.usage.modelId})`,
    );
  }
  console.log(`Reports written to ${outDir}`);
} catch (error) {
  if (error instanceof ScanError) {
    console.error(`Scan failed [${error.code}] retryable=${error.retryable}: ${error.message}`);
    process.exit(2);
  }
  throw error;
}
