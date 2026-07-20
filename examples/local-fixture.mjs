/**
 * Self-contained demo: serves a deliberately inaccessible page on localhost,
 * scans it in Lighthouse-only mode (no API key needed), and writes a
 * standalone HTML report you can open in a browser.
 *
 * Run: node examples/local-fixture.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderHtmlReport, scan } from 'a11yhawk';

const brokenPage = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
  <img src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==">
  <input type="text">
  <p style="color:#888;background:#999;">Low contrast paragraph text.</p>
  <a href="/nowhere"></a>
  <button></button>
  <main><h1>Deliberately broken fixture page</h1></main>
</body>
</html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(brokenPage);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
console.log(`Serving fixture at ${url}`);

try {
  const report = await scan(url, {
    // localhost is a private target; the SSRF guard blocks it unless opted in
    allowPrivateNetworks: true,
    onProgress: (e) => console.log(`  [${e.stage}] ${e.message}`),
  });

  console.log(`\nScore: ${report.structured.overallScore}/100`);
  console.log(`Issues: ${report.structured.issues.length}`);
  for (const issue of report.structured.issues) {
    console.log(`  - [${issue.severity}] ${issue.title} (WCAG ${issue.wcagCriteria})`);
  }

  const outDir = join(dirname(fileURLToPath(import.meta.url)), 'output');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'local-fixture-report.html');
  writeFileSync(outFile, renderHtmlReport(report));
  console.log(`\nHTML report written to ${outFile} - open it in a browser.`);
} finally {
  server.close();
}
