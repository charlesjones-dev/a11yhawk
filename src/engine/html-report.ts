/**
 * Self-contained HTML report renderer.
 *
 * Turns a ScanReport into a single .html document string with everything
 * inlined: one <style>, one <script>, screenshots as base64 data URIs, and a
 * system font stack. It makes zero network requests and renders correctly from
 * file://, so the output attaches cleanly to CI artifacts, emails, and tickets.
 *
 * Two properties are load-bearing and deliberate:
 * - Security: every value taken from the scanned page (issue titles, code
 *   context, URLs, selectors) is untrusted and is escaped with escapeHtml before
 *   it reaches the document. A scanned page must not be able to inject markup
 *   into the report about itself.
 * - Accessibility: this file is produced by an accessibility scanner, so the
 *   report is itself built to WCAG AA (semantic landmarks, one h1, keyboard
 *   operability, verified contrast, reduced-motion support). Color pairs in the
 *   dark theme were checked against 4.5:1 (body) and 3:1 (large/graphic).
 */
import { readFileSync } from 'node:fs';

import type { AccessibilityIssue, PassedCheck, StructuredScanOutput, WCAGCoverage } from '../types.js';
import type { ScanReport } from './scan.js';

/** GitHub repository shown in the footer credit (the only non-page external link). */
const REPO_URL = 'https://github.com/charlesjones-dev/a11yhawk';

/** Presentation metadata per issue severity. `rank` orders the default sort. */
const SEVERITY_META: Record<AccessibilityIssue['severity'], { label: string; rank: number }> = {
  critical: { label: 'Critical', rank: 0 },
  high: { label: 'High', rank: 1 },
  medium: { label: 'Medium', rank: 2 },
  low: { label: 'Low', rank: 3 },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Escape a value for safe interpolation into HTML text or a double/single
 * quoted attribute. Ampersand must be replaced first. Used without exception on
 * every interpolated report value; see the module security note.
 */
function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** True only for http(s) URLs. Anything else is rendered as text, never linked. */
function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** Package version for the footer, read at runtime. Empty string if unavailable. */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

/** Sniff the image type from magic bytes and build a base64 data URI. */
function toDataUri(buffer: Buffer): string {
  let mime = 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    mime = 'image/jpeg';
  }
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/** Overall-score band: color + label, matching the ring color thresholds. */
function scoreBand(score: number): { varName: string; label: string } {
  if (score >= 90) return { varName: '--good', label: 'Good' };
  if (score >= 70) return { varName: '--medium', label: 'Fair' };
  if (score >= 50) return { varName: '--high', label: 'Needs work' };
  return { varName: '--critical', label: 'Critical' };
}

/** Human-readable UTC scan date, computed in UTC so output is timezone-stable. */
function formatScanDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const month = MONTHS[d.getUTCMonth()] ?? '';
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${month} ${day}, ${year} at ${hh}:${mm} UTC`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes} m ${String(seconds).padStart(2, '0')} s`;
}

function formatCost(cost: number): string {
  if (cost <= 0) return '$0.00';
  return cost < 1 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

/** A single definition row (label + value) used across the config and issue detail. */
function field(label: string, valueHtml: string): string {
  return `<div class="field"><dt>${escapeHtml(label)}</dt><dd>${valueHtml}</dd></div>`;
}

function renderHeader(structured: StructuredScanOutput, title: string, version: string, engineMode: string): string {
  const url = structured.url;
  const urlCell = isHttpUrl(url)
    ? `<a href="${escapeHtml(url)}" rel="noreferrer noopener">${escapeHtml(url)}</a>`
    : `<span class="mono">${escapeHtml(url)}</span>`;
  const fine = version ? `A11yHawk v${escapeHtml(version)} &middot; ${escapeHtml(engineMode)}` : escapeHtml(engineMode);

  return `<header class="wrap">
      <div class="brand" aria-hidden="true">a11y<b>hawk</b></div>
      <p class="eyebrow">Accessibility scan report</p>
      <h1 class="report-title">${escapeHtml(title)}</h1>
      <div class="card config-card">
        <h2 class="visually-hidden">Scan configuration</h2>
        <dl class="config-grid">
          ${field('Scanned URL', urlCell)}
          ${field('Model', `<span class="mono">${escapeHtml(engineMode === 'Lighthouse only' ? 'Lighthouse only' : engineMode)}</span>`)}
          ${field('Standard', escapeHtml(structured.standard))}
          ${field('Scan date', escapeHtml(formatScanDate(structured.scanDate)))}
        </dl>
        <p class="fine-print">${fine}</p>
      </div>
    </header>`;
}

function renderScorePanel(report: ScanReport): string {
  const structured = report.structured;
  const score = Math.max(0, Math.min(100, Math.round(structured.overallScore)));
  const band = scoreBand(score);
  const stats = structured.statistics;

  // Static SVG ring: no JS, no animation, so it is deterministic and prints.
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - score / 100);
  const ringLabel = `Overall accessibility score ${score} out of 100, rated ${band.label.toLowerCase()}`;

  const lhScore = report.lighthouse ? Math.round(report.lighthouse.summary.lighthouseScore) : null;
  const lhBadge =
    lhScore !== null
      ? `<span class="lh-badge" role="img" aria-label="Lighthouse score ${lhScore} out of 100">
            <span aria-hidden="true"><em>LH</em>${lhScore}</span>
          </span>`
      : '';

  const tiles = (['critical', 'high', 'medium', 'low'] as const)
    .map((sev) => {
      const count =
        sev === 'critical'
          ? stats.criticalIssues
          : sev === 'high'
            ? stats.highIssues
            : sev === 'medium'
              ? stats.mediumIssues
              : stats.lowIssues;
      return `<div class="tile tile-${sev}">
            <span class="tile-count mono">${count}</span>
            <span class="tile-label">${SEVERITY_META[sev].label}</span>
          </div>`;
    })
    .join('\n          ');

  const total = structured.issues.length;
  const progress =
    total > 0
      ? `<div class="progress-wrap">
            <div
              id="progress"
              class="progress"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="${total}"
              aria-valuenow="0"
              aria-label="Issues marked resolved"
            >
              <div id="progress-fill" class="progress-fill"></div>
            </div>
            <p id="progress-text" class="progress-text mono">0 of ${total} resolved</p>
          </div>`
      : '';

  return `<section class="wrap section" aria-labelledby="score-h">
      <p class="eyebrow">Result</p>
      <h2 id="score-h" class="section-title">Score summary</h2>
      <div class="card score-card">
        <div class="ring-wrap">
          <div class="ring" role="img" aria-label="${escapeHtml(ringLabel)}">
            <svg viewBox="0 0 128 128" width="176" height="176" focusable="false" aria-hidden="true">
              <circle class="ring-track" cx="64" cy="64" r="${radius}" fill="none" stroke-width="12" />
              <circle
                class="ring-arc"
                cx="64"
                cy="64"
                r="${radius}"
                fill="none"
                stroke-width="12"
                stroke-linecap="round"
                stroke="var(${band.varName})"
                stroke-dasharray="${circumference.toFixed(2)}"
                stroke-dashoffset="${offset.toFixed(2)}"
                transform="rotate(-90 64 64)"
              />
            </svg>
            <div class="ring-center" aria-hidden="true">
              <span class="score-num mono" style="color: var(${band.varName})">${score}</span>
              <span class="score-den mono">/ 100</span>
              <span class="score-band">${escapeHtml(band.label)}</span>
            </div>
          </div>
          ${lhBadge}
        </div>
        <div class="breakdown">
          <div class="tiles">
          ${tiles}
          </div>
          ${progress}
        </div>
      </div>
    </section>`;
}

function renderIssueBody(issue: AccessibilityIssue): string {
  const rows: string[] = [];
  if (issue.location) rows.push(field('Location', `<span class="mono">${escapeHtml(issue.location)}</span>`));
  if (issue.patternDetected)
    rows.push(field('Pattern detected', `<span class="mono">${escapeHtml(issue.patternDetected)}</span>`));
  if (issue.codeContext)
    rows.push(field('Code context', `<pre class="code"><code>${escapeHtml(issue.codeContext)}</code></pre>`));
  if (issue.impact) rows.push(field('Impact', escapeHtml(issue.impact)));
  if (issue.userImpact) rows.push(field('User impact', escapeHtml(issue.userImpact)));
  if (issue.recommendation) rows.push(field('Recommendation', escapeHtml(issue.recommendation)));
  if (issue.remediation) rows.push(field('Remediation', escapeHtml(issue.remediation)));
  if (issue.fixPriority)
    rows.push(field('Fix priority', `<span class="priority">${escapeHtml(issue.fixPriority)}</span>`));
  return `<div class="issue-body"><dl>${rows.join('')}</dl></div>`;
}

function renderIssue(issue: AccessibilityIssue, index: number, coverageName: Map<string, string>): string {
  const meta = SEVERITY_META[issue.severity];
  const criterion = issue.wcagCriteria.trim();
  const name = coverageName.get(criterion);
  const chipText = name && !criterion.includes(name) ? `${criterion} ${name}` : criterion;
  const chip = criterion
    ? `<span class="wcag-chip">${escapeHtml(chipText)}<span class="wcag-level">${escapeHtml(issue.wcagLevel)}</span></span>`
    : '';

  return `<details
        class="issue"
        data-id="${escapeHtml(issue.id)}"
        data-rank="${meta.rank}"
        data-wcag="${escapeHtml(criterion)}"
        data-index="${index}"
      >
        <summary class="issue-summary">
          <span class="chevron" aria-hidden="true"></span>
          <span class="sev-badge sev-${issue.severity}">${meta.label}</span>
          <span class="issue-title">${escapeHtml(issue.title)}</span>
          ${chip}
          <label class="resolve">
            <input
              type="checkbox"
              class="js-resolve"
              data-id="${escapeHtml(issue.id)}"
              aria-label="Mark &quot;${escapeHtml(issue.title)}&quot; as resolved"
            />
            <span aria-hidden="true">Resolved</span>
          </label>
        </summary>
        ${renderIssueBody(issue)}
      </details>`;
}

function renderIssues(structured: StructuredScanOutput): string {
  const coverageName = new Map<string, string>();
  for (const c of structured.wcagCoverage) {
    if (c.criteriaId && c.name) coverageName.set(c.criteriaId, c.name);
  }

  if (structured.issues.length === 0) {
    return `<section class="wrap section" aria-labelledby="issues-h">
      <p class="eyebrow">Findings</p>
      <h2 id="issues-h" class="section-title">Issues</h2>
      <div class="card empty-state">
        <p class="empty-title">No accessibility issues detected</p>
        <p class="fine-print">Nothing was flagged by this scan. Manual testing is still recommended for full WCAG conformance.</p>
      </div>
    </section>`;
  }

  // Render pre-sorted by severity rank (stable) so the default "Severity" sort
  // matches the initial DOM order; the client script re-sorts on demand.
  const sorted = structured.issues
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => {
      const rankDelta = SEVERITY_META[a.issue.severity].rank - SEVERITY_META[b.issue.severity].rank;
      return rankDelta !== 0 ? rankDelta : a.index - b.index;
    });

  const rows = sorted.map(({ issue }, position) => renderIssue(issue, position, coverageName)).join('\n      ');

  return `<section class="wrap section" aria-labelledby="issues-h">
      <div class="section-head">
        <div>
          <p class="eyebrow">Findings</p>
          <h2 id="issues-h" class="section-title">Issues <span class="count-pill">${structured.issues.length}</span></h2>
        </div>
        <div class="sort-control">
          <label for="sort">Sort by</label>
          <select id="sort" aria-label="Sort issues">
            <option value="severity">Severity</option>
            <option value="wcag">WCAG criterion</option>
          </select>
        </div>
      </div>
      <div id="issue-list" class="issue-list">
      ${rows}
      </div>
    </section>`;
}

function renderScreenshot(report: ScanReport): string {
  const buffer = report.annotatedScreenshot ?? report.screenshot;
  if (!buffer) return '';
  const annotated = report.annotatedScreenshot !== null;
  const url = report.structured.url;
  const alt = annotated ? `Screenshot of ${url} with detected accessibility issues outlined` : `Screenshot of ${url}`;
  const note = annotated
    ? 'Colored boxes mark where detected issues appear on the captured page.'
    : 'Full-page capture of the scanned page.';

  return `<section class="wrap section" aria-labelledby="shot-h">
      <p class="eyebrow">Evidence</p>
      <h2 id="shot-h" class="section-title">${annotated ? 'Annotated screenshot' : 'Page screenshot'}</h2>
      <div class="card shot-card">
        <img class="shot" src="${toDataUri(buffer)}" alt="${escapeHtml(alt)}" loading="lazy" />
        <p class="fine-print">${escapeHtml(note)}</p>
      </div>
    </section>`;
}

function renderPassedCheck(check: PassedCheck): string {
  return `<li><span class="mono passed-crit">${escapeHtml(check.criteria)}</span> ${escapeHtml(check.description)}</li>`;
}

function renderCoverageRow(row: WCAGCoverage): string {
  const status = row.passed
    ? '<span class="status status-pass">Passed</span>'
    : '<span class="status status-fail">Failed</span>';
  return `<tr>
              <td class="mono">${escapeHtml(row.criteriaId)}</td>
              <td>${escapeHtml(row.name)}</td>
              <td>${escapeHtml(row.level)}</td>
              <td>${status}</td>
            </tr>`;
}

function renderReference(structured: StructuredScanOutput): string {
  const hasPassed = structured.passedChecks.length > 0;
  const hasCoverage = structured.wcagCoverage.length > 0;
  if (!hasPassed && !hasCoverage) return '';

  const passed = hasPassed
    ? `<details class="fold">
          <summary>Passed checks <span class="count-pill">${structured.passedChecks.length}</span></summary>
          <ul class="passed-list">
            ${structured.passedChecks.map(renderPassedCheck).join('\n            ')}
          </ul>
        </details>`
    : '';

  const coverage = hasCoverage
    ? `<details class="fold">
          <summary>WCAG coverage <span class="count-pill">${structured.wcagCoverage.length}</span></summary>
          <div class="table-scroll">
            <table class="coverage">
              <caption class="visually-hidden">WCAG criteria coverage</caption>
              <thead>
                <tr>
                  <th scope="col">Criterion</th>
                  <th scope="col">Name</th>
                  <th scope="col">Level</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
            ${structured.wcagCoverage.map(renderCoverageRow).join('\n            ')}
              </tbody>
            </table>
          </div>
        </details>`
    : '';

  return `<section class="wrap section" aria-labelledby="ref-h">
      <p class="eyebrow">Reference</p>
      <h2 id="ref-h" class="section-title">Passed checks and WCAG coverage</h2>
      ${passed}
      ${coverage}
    </section>`;
}

function renderFooter(report: ScanReport, version: string): string {
  const stats: string[] = [
    `<div class="fstat"><span class="fstat-label">Scan duration</span><span class="fstat-val mono">${escapeHtml(formatDuration(report.durationMs))}</span></div>`,
  ];

  const usage = report.usage;
  if (usage) {
    stats.push(
      `<div class="fstat"><span class="fstat-label">Tokens (in / out)</span><span class="fstat-val mono">${usage.promptTokens.toLocaleString('en-US')} / ${usage.completionTokens.toLocaleString('en-US')}</span></div>`,
      `<div class="fstat"><span class="fstat-label">Total tokens</span><span class="fstat-val mono">${usage.totalTokens.toLocaleString('en-US')}</span></div>`,
      `<div class="fstat"><span class="fstat-label">Estimated cost</span><span class="fstat-val mono">${escapeHtml(formatCost(usage.cost))}</span></div>`,
    );
  }

  const credit = version
    ? `Generated by <a href="${REPO_URL}" rel="noreferrer noopener">A11yHawk</a> v${escapeHtml(version)}`
    : `Generated by <a href="${REPO_URL}" rel="noreferrer noopener">A11yHawk</a>`;

  return `<footer class="wrap site-footer">
      <div class="footer-stats">
        ${stats.join('\n        ')}
      </div>
      <p class="footer-credit">${credit}</p>
    </footer>`;
}

/**
 * Render a ScanReport into one complete, self-contained HTML document.
 *
 * The returned string is a full document (with doctype) that embeds all styles,
 * scripts, and images inline and makes no network requests. Every value drawn
 * from the scanned page is escaped before interpolation.
 */
export function renderHtmlReport(report: ScanReport, options?: { title?: string }): string {
  const structured = report.structured;
  const version = readVersion();
  const engineMode = report.usage?.modelId ?? 'Lighthouse only';
  const title = options?.title ?? structured.metadata?.pageTitle ?? structured.url;
  const docTitle = `${title} - A11yHawk accessibility report`;
  // Client-side resolution tracking is namespaced per scan so two reports do not
  // share state; the key is exposed as a data attribute rather than injected
  // into the script, keeping all page-derived strings out of the JS context.
  const scanKey = `${structured.url}|${structured.scanDate}`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta name="generator" content="A11yHawk" />
    <title>${escapeHtml(docTitle)}</title>
    <style>${STYLES}</style>
  </head>
  <body data-scan-key="${escapeHtml(scanKey)}">
    <a class="skip-link" href="#main">Skip to report</a>
    ${renderHeader(structured, title, version, engineMode)}
    <main id="main">
      ${renderScorePanel(report)}
      ${renderIssues(structured)}
      ${renderScreenshot(report)}
      ${renderReference(structured)}
    </main>
    ${renderFooter(report, version)}
    <script>${SCRIPT}</script>
  </body>
</html>
`;
}

const STYLES = `
:root {
  --bg: #16130e;
  --card: #211c15;
  --tile: #2b251b;
  --pre: #12100b;
  --border: #3b3427;
  --ring-track: #332c20;
  --ink: #f4eedf;
  --ink-2: #cbc0a8;
  --ink-3: #aba088;
  --accent: #f2a24e;
  --accent-dim: rgba(242, 162, 78, 0.45);
  --good: #5bc48d;
  --medium: #e6c64f;
  --high: #f08a3d;
  --critical: #f0706f;
  --low: #78adf0;
  --badge-ink: #16130e;
  --radius: 10px;
  --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, 'SF Mono', 'Cascadia Code', 'Roboto Mono', Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 16px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.wrap { width: 100%; max-width: 880px; margin: 0 auto; padding: 0 24px; }
.mono { font-family: var(--mono); }
a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
.skip-link {
  position: absolute; left: 12px; top: -48px; z-index: 10;
  background: var(--card); color: var(--ink); padding: 10px 16px; border-radius: 8px;
  border: 1px solid var(--border); text-decoration: none; transition: top 0.15s ease;
}
.skip-link:focus { top: 12px; }

.card {
  position: relative;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 24px;
}
/* Signature: corner brackets framing every card (top-left + bottom-right). */
.card::before, .card::after {
  content: ''; position: absolute; width: 14px; height: 14px;
  border-color: var(--accent-dim); border-style: solid; border-width: 0; pointer-events: none;
}
.card::before { top: 7px; left: 7px; border-top-width: 2px; border-left-width: 2px; }
.card::after { bottom: 7px; right: 7px; border-bottom-width: 2px; border-right-width: 2px; }

.eyebrow {
  font-family: var(--mono);
  font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--accent); margin: 0 0 6px;
}
.section-title { font-size: 22px; font-weight: 650; letter-spacing: -0.01em; margin: 0 0 16px; }
.section { padding-top: 40px; }
.section-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.section-head .section-title { margin: 0; }
.count-pill {
  font-family: var(--mono); font-size: 14px; color: var(--ink-2);
  background: var(--tile); border: 1px solid var(--border); border-radius: 999px;
  padding: 1px 10px; margin-left: 6px; vertical-align: middle;
}
.fine-print { color: var(--ink-3); font-size: 13px; margin: 12px 0 0; }

/* Header */
header.wrap { padding-top: 56px; }
.brand { font-family: var(--mono); font-weight: 600; letter-spacing: 0.04em; color: var(--ink-2); font-size: 14px; }
.brand b { color: var(--accent); font-weight: 700; }
.report-title { font-size: 30px; line-height: 1.2; font-weight: 700; letter-spacing: -0.02em; margin: 4px 0 24px; overflow-wrap: anywhere; }
.config-card { padding: 20px 24px; }
.config-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 32px; margin: 0; }
.field { margin: 0; }
dt { font-family: var(--mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); margin: 0 0 3px; }
dd { margin: 0; color: var(--ink); overflow-wrap: anywhere; }
.config-grid dd a { overflow-wrap: anywhere; }

/* Score panel */
.score-card { display: flex; gap: 32px; align-items: center; flex-wrap: wrap; }
.ring-wrap { position: relative; width: 176px; height: 176px; flex: 0 0 auto; }
.ring-track { stroke: var(--ring-track); }
.ring-center {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; line-height: 1;
}
.score-num { font-size: 46px; font-weight: 700; letter-spacing: -0.03em; }
.score-den { font-size: 14px; color: var(--ink-3); margin-top: 2px; }
.score-band { font-size: 12px; color: var(--ink-2); text-transform: uppercase; letter-spacing: 0.1em; margin-top: 6px; }
.lh-badge {
  position: absolute; top: -2px; right: -6px;
  background: var(--tile); border: 1px solid var(--border); border-radius: 999px;
  width: 52px; height: 52px; display: flex; align-items: center; justify-content: center;
  text-align: center; font-family: var(--mono); font-size: 15px; font-weight: 600; color: var(--ink);
}
.lh-badge em { display: block; font-style: normal; font-size: 9px; letter-spacing: 0.08em; color: var(--accent); }
.breakdown { flex: 1 1 300px; min-width: 260px; }
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.tile {
  background: var(--tile); border: 1px solid var(--border); border-radius: 8px;
  padding: 14px 10px 12px; text-align: center; border-top: 3px solid var(--border);
}
.tile-count { display: block; font-size: 26px; font-weight: 700; line-height: 1; }
.tile-label { display: block; font-size: 12px; color: var(--ink-2); margin-top: 6px; }
.tile-critical { border-top-color: var(--critical); } .tile-critical .tile-count { color: var(--critical); }
.tile-high { border-top-color: var(--high); } .tile-high .tile-count { color: var(--high); }
.tile-medium { border-top-color: var(--medium); } .tile-medium .tile-count { color: var(--medium); }
.tile-low { border-top-color: var(--low); } .tile-low .tile-count { color: var(--low); }
.progress-wrap { margin-top: 18px; }
.progress {
  height: 8px; background: var(--tile); border: 1px solid var(--border);
  border-radius: 999px; overflow: hidden;
}
.progress-fill { height: 100%; width: 0; background: var(--good); border-radius: 999px; transition: width 0.25s ease; }
.progress-text { font-size: 12px; color: var(--ink-2); margin: 8px 0 0; }

/* Issues */
.sort-control { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-2); }
.sort-control label { font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--accent); }
.sort-control select {
  background: var(--tile); color: var(--ink); border: 1px solid var(--border);
  border-radius: 8px; padding: 6px 10px; font: inherit; font-size: 13px;
}
.issue-list { display: flex; flex-direction: column; gap: 10px; }
.issue { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.issue-summary {
  display: flex; align-items: center; gap: 12px; padding: 14px 18px; cursor: pointer;
  list-style: none; user-select: none;
}
.issue-summary::-webkit-details-marker { display: none; }
.chevron {
  flex: 0 0 auto; width: 8px; height: 8px; border-right: 2px solid var(--ink-3);
  border-bottom: 2px solid var(--ink-3); transform: rotate(-45deg); transition: transform 0.2s ease;
}
.issue[open] .chevron { transform: rotate(45deg); }
.sev-badge {
  flex: 0 0 auto; font-family: var(--mono); font-size: 11px; font-weight: 700;
  letter-spacing: 0.06em; text-transform: uppercase; color: var(--badge-ink);
  border-radius: 6px; padding: 3px 9px;
}
.sev-critical { background: var(--critical); } .sev-high { background: var(--high); }
.sev-medium { background: var(--medium); } .sev-low { background: var(--low); }
.issue-title { flex: 1 1 auto; font-weight: 550; min-width: 0; }
.wcag-chip {
  flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--mono); font-size: 12px; color: var(--ink-2);
  background: var(--tile); border: 1px solid var(--border); border-radius: 6px; padding: 3px 8px;
}
.wcag-level { color: var(--accent); font-weight: 700; }
.resolve {
  flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--ink-2); cursor: pointer; white-space: nowrap;
}
.resolve input { width: 16px; height: 16px; accent-color: var(--good); cursor: pointer; }
.issue.is-resolved .issue-title { text-decoration: line-through; color: var(--ink-3); }
.issue.is-resolved .issue-summary { opacity: 0.62; }
.issue-body { padding: 4px 18px 20px; border-top: 1px solid var(--border); }
.issue-body dl { display: grid; gap: 14px; margin: 16px 0 0; }
.issue-body dt { color: var(--accent); }
.issue-body dd { color: var(--ink-2); }
.priority { font-family: var(--mono); font-size: 13px; color: var(--ink); }
pre.code {
  background: var(--pre); border: 1px solid var(--border); border-radius: 8px;
  padding: 12px 14px; margin: 0; overflow-x: auto; font-family: var(--mono);
  font-size: 13px; line-height: 1.5; color: var(--ink);
}
pre.code code { font-family: inherit; }

/* Screenshot */
.shot-card { padding: 16px; }
.shot { display: block; width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--border); }

/* Reference */
.fold { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 10px; }
.fold > summary {
  cursor: pointer; padding: 14px 18px; font-weight: 600; list-style: none;
  display: flex; align-items: center; gap: 8px;
}
.fold > summary::-webkit-details-marker { display: none; }
.fold > summary::before {
  content: ''; width: 8px; height: 8px; border-right: 2px solid var(--ink-3);
  border-bottom: 2px solid var(--ink-3); transform: rotate(-45deg); transition: transform 0.2s ease;
}
.fold[open] > summary::before { transform: rotate(45deg); }
.passed-list { margin: 0; padding: 4px 18px 18px 36px; color: var(--ink-2); }
.passed-list li { margin: 6px 0; }
.passed-crit { color: var(--good); margin-right: 6px; }
.table-scroll { overflow-x: auto; padding: 0 4px 4px; }
table.coverage { width: 100%; border-collapse: collapse; font-size: 14px; }
table.coverage th, table.coverage td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); }
table.coverage th { font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); }
table.coverage td { color: var(--ink-2); }
.status { font-family: var(--mono); font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 6px; color: var(--badge-ink); }
.status-pass { background: var(--good); }
.status-fail { background: var(--critical); }

/* Empty state */
.empty-state { text-align: center; padding: 40px 24px; }
.empty-title { font-size: 18px; font-weight: 650; color: var(--good); margin: 0; }

/* Footer */
.site-footer { margin-top: 56px; padding-top: 28px; padding-bottom: 56px; border-top: 1px solid var(--border); }
.footer-stats { display: flex; flex-wrap: wrap; gap: 12px 40px; }
.fstat { display: flex; flex-direction: column; gap: 3px; }
.fstat-label { font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--accent); }
.fstat-val { font-size: 16px; color: var(--ink); }
.footer-credit { color: var(--ink-3); font-size: 13px; margin: 22px 0 0; }

@media (max-width: 620px) {
  .config-grid { grid-template-columns: 1fr; }
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .score-card { justify-content: center; }
  .section-head { flex-direction: column; align-items: flex-start; }
  .report-title { font-size: 25px; }
  /* Stack the summary: chevron + badge, then the title, then chip + checkbox. */
  .issue-summary { flex-wrap: wrap; row-gap: 8px; }
  .issue-title { flex-basis: 100%; }
  .resolve { margin-left: auto; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
}
`;

const SCRIPT = `
(function () {
  var root = document.querySelector('[data-scan-key]');
  if (!root) return;
  var storeKey = 'a11yhawk:resolved:' + root.getAttribute('data-scan-key');
  var list = document.getElementById('issue-list');
  var boxes = Array.prototype.slice.call(document.querySelectorAll('.js-resolve'));
  var total = boxes.length;

  function load() {
    try {
      var raw = window.localStorage.getItem(storeKey);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }
  function save(ids) {
    try {
      window.localStorage.setItem(storeKey, JSON.stringify(ids));
    } catch (e) {
      /* storage may be blocked on file://; resolution state is best-effort */
    }
  }
  function apply(box) {
    var row = box.closest('.issue');
    if (row) row.classList.toggle('is-resolved', box.checked);
  }
  function update() {
    var done = boxes.filter(function (b) { return b.checked; });
    var pct = total ? Math.round((done.length / total) * 100) : 0;
    var fill = document.getElementById('progress-fill');
    var text = document.getElementById('progress-text');
    var bar = document.getElementById('progress');
    if (fill) fill.style.width = pct + '%';
    if (text) text.textContent = done.length + ' of ' + total + ' resolved';
    if (bar) bar.setAttribute('aria-valuenow', String(done.length));
  }

  var saved = load();
  boxes.forEach(function (box) {
    if (saved.indexOf(box.getAttribute('data-id')) !== -1) box.checked = true;
    apply(box);
    box.addEventListener('change', function () {
      apply(box);
      save(boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.getAttribute('data-id'); }));
      update();
    });
  });
  // Keep clicks on the resolve control from toggling the issue disclosure.
  Array.prototype.slice.call(document.querySelectorAll('.resolve')).forEach(function (el) {
    el.addEventListener('click', function (e) { e.stopPropagation(); });
  });
  update();

  var sort = document.getElementById('sort');
  if (sort && list) {
    sort.addEventListener('change', function () {
      var rows = Array.prototype.slice.call(list.querySelectorAll('.issue'));
      rows.sort(function (a, b) {
        if (sort.value === 'wcag') {
          return (a.getAttribute('data-wcag') || '~').localeCompare(b.getAttribute('data-wcag') || '~', undefined, { numeric: true });
        }
        return (Number(a.getAttribute('data-rank')) - Number(b.getAttribute('data-rank'))) ||
          (Number(a.getAttribute('data-index')) - Number(b.getAttribute('data-index')));
      });
      rows.forEach(function (r) { list.appendChild(r); });
    });
  }
})();
`;
