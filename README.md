# A11yHawk

[![npm version](https://img.shields.io/npm/v/a11yhawk)](https://www.npmjs.com/package/a11yhawk)
[![CI](https://github.com/charlesjones-dev/a11yhawk/actions/workflows/ci.yml/badge.svg)](https://github.com/charlesjones-dev/a11yhawk/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

Open-source, self-hostable web accessibility scan engine. A11yHawk loads a page in a real browser, runs deterministic Lighthouse accessibility audits, and (optionally) has an LLM of your choice analyze the full page context - screenshot, accessibility tree, and sanitized HTML - against every WCAG criterion for the version and level you select. The result is a structured JSON report, a human-readable markdown report, a self-contained HTML report page, and an annotated screenshot with issues boxed on the page.

Runs entirely on your own infrastructure. No accounts, no telemetry, no phone-home; the only network traffic is the page you scan and the LLM endpoint you configure (and none at all in Lighthouse-only mode beyond the page itself).

> **Status: pre-1.0.** The library API, CLI, and HTTP server mode are functional and tested. The API may change between minor versions until 1.0; see the [CHANGELOG](./CHANGELOG.md).

## How it works

```text
  validate URL
       |
       v
  Playwright capture
  (screenshot, a11y tree, HTML)
       |
       v
  Lighthouse audit
  (deterministic, accessibility-only)
       |
       v
  LLM analysis
  (BYOK, optional; skipped in Lighthouse-only mode)
       |
       v
  parse and score
  (always recomputed by the engine)
       |
       v
  reports
  (JSON, markdown, HTML, annotated screenshot)
```

- **Playwright capture**: full-page screenshot (tiled to your LLM provider's image limits), Chrome DevTools accessibility tree, and HTML sanitized down to its accessibility-relevant structure.
- **Lighthouse**: accessibility-category audits in a subprocess, reusing the same browser over CDP. Findings are mapped to WCAG criteria and fed into the LLM prompt for cross-referencing.
- **LLM analysis** (optional): the model receives the screenshot tiles, compact accessibility tree, sanitized HTML, Lighthouse findings, and a condensed matrix of every WCAG criterion for your chosen version + level, and returns structured issues with remediation guidance. Scores and statistics are recomputed by the engine from the actual findings, never trusted from the model.
- **Lighthouse-only mode**: omit the LLM config and you get a deterministic, no-API-key scan in a few seconds.

## Requirements

- Node.js >= 20 (ESM-only package; use `import`)
- Chromium for Playwright (one-time): `npx playwright install chromium` from a project with a11yhawk installed, or `npx playwright@1.57.0 install chromium` from anywhere else (browser downloads are pinned per Playwright version, and an unpinned `npx playwright` outside a project resolves the registry's latest)
- For LLM mode: an API key for [OpenRouter](https://openrouter.ai/) or any OpenAI-compatible endpoint. You bring your own key and pay your own token costs; A11yHawk adds nothing on top.

## Install

```sh
npm install a11yhawk
npx playwright install chromium
```

## Quick start

Lighthouse-only (no API key needed):

```js
import { scan } from 'a11yhawk';

const report = await scan('https://example.com');
console.log(report.structured.overallScore, report.structured.issues.length);
```

Full AI analysis:

```js
import { scan } from 'a11yhawk';

const report = await scan('https://example.com', {
  llm: { apiKey: process.env.OPENROUTER_API_KEY },
  wcagVersion: '2.2',
  wcagLevel: 'AA',
  onProgress: (e) => console.error(`[${e.stage}] ${e.message}`),
});
```

Write the reports:

```js
import { writeFileSync } from 'node:fs';
import { renderHtmlReport, scan } from 'a11yhawk';

const report = await scan('https://example.com', { llm: { apiKey: process.env.OPENROUTER_API_KEY } });

writeFileSync('report.json', JSON.stringify(report.structured, null, 2));
writeFileSync('report.md', report.markdown);
writeFileSync('report.html', renderHtmlReport(report)); // self-contained, opens from file://
if (report.annotatedScreenshot) writeFileSync('annotated.jpg', report.annotatedScreenshot);
```

Scanning many pages? Hold an engine so the browser stays warm across scans:

```js
import { A11yHawkEngine } from 'a11yhawk';

const engine = new A11yHawkEngine();
try {
  for (const url of urls) {
    const report = await engine.scan(url, { llm: { apiKey } });
    // persist report however you like
  }
} finally {
  await engine.close();
}
```

## API

### `scan(url, options?)` / `engine.scan(url, options?)`

One-shot `scan()` accepts `ScanOptions & EngineOptions` and manages the browser lifecycle for you. `A11yHawkEngine` takes `EngineOptions` in its constructor and `ScanOptions` per scan; it also exposes `setConcurrency(n)` (max concurrent page analyses, 1-10) and `close()` (shuts the browser down; the engine relaunches it on the next scan).

**ScanOptions**

| Option                 | Type                             | Default                        | Notes                                                                                        |
| ---------------------- | -------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `llm`                  | `ScanLlmOptions`                 | omitted                        | Omit entirely for Lighthouse-only mode                                                       |
| `llm.apiKey`           | `string`                         | required in LLM mode           | Key for the configured endpoint                                                              |
| `llm.model`            | `string`                         | `anthropic/claude-sonnet-5`    | Any model id your endpoint accepts                                                           |
| `llm.baseUrl`          | `string`                         | `https://openrouter.ai/api/v1` | Any OpenAI-compatible endpoint                                                               |
| `llm.generationParams` | `GenerationParams`               | engine defaults                | temperature, topP, frequencyPenalty, maxTokens                                               |
| `llm.debug`            | `boolean`                        | `false`                        | Verbose prompt/response logging                                                              |
| `wcagVersion`          | `'2.0' \| '2.1' \| '2.2'`        | `'2.1'`                        |                                                                                              |
| `wcagLevel`            | `'A' \| 'AA' \| 'AAA'`           | `'AA'`                         |                                                                                              |
| `headers`              | `ScanHeader[]`                   | none                           | Custom request headers (cookies, auth) sent to the page                                      |
| `lighthouse`           | `boolean`                        | `true`                         | Disable to skip the Lighthouse audit (LLM mode only)                                         |
| `annotate`             | `boolean`                        | `true`                         | Draw severity-colored boxes on a copy of the screenshot                                      |
| `onProgress`           | `(e: ScanProgressEvent) => void` | none                           | Stages: validating, capturing, auditing, analyzing, processing, annotating, complete, failed |
| `logger`               | `Logger`                         | console logger                 | Bring your own structured logger                                                             |

**EngineOptions**

| Option                   | Type      | Default        | Notes                                                   |
| ------------------------ | --------- | -------------- | ------------------------------------------------------- |
| `allowPrivateNetworks`   | `boolean` | `false`        | See [Security](#security) before enabling               |
| `browser.disableSandbox` | `boolean` | `false`        | Chromium `--no-sandbox`, needed on some container hosts |
| `browser.debug`          | `boolean` | `false`        | Extra capture diagnostics                               |
| `logger`                 | `Logger`  | console logger |                                                         |

**ScanReport**

| Field                 | Type                                  | Notes                                                                                                      |
| --------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `structured`          | `StructuredScanOutput`                | Machine-readable source of truth: score, statistics, WCAG coverage, issues with remediation, passed checks |
| `markdown`            | `string`                              | Human-readable report                                                                                      |
| `screenshot`          | `Buffer \| null`                      | Full-page JPEG                                                                                             |
| `annotatedScreenshot` | `Buffer \| null`                      | Issues boxed on the page, when annotation resolved any selectors                                           |
| `lighthouse`          | `LighthouseTransformedResult \| null` | Raw-ish Lighthouse findings mapped to WCAG                                                                 |
| `usage`               | `ScanUsage \| null`                   | Tokens + cost in USD; `null` in Lighthouse-only mode                                                       |
| `finalUrl`            | `string`                              | Guard-validated post-redirect URL that was actually analyzed                                               |
| `durationMs`          | `number`                              |                                                                                                            |

Use `renderHtmlReport(report)` to turn any `ScanReport` into a single self-contained HTML document (inline CSS/JS, images as data URIs, renders from `file://`, itself WCAG AA accessible).

### Error handling

Every pipeline failure throws a `ScanError` with a `code` and a `retryable` flag, so queue-based hosts can map failures onto their retry semantics:

| Code                | Retryable | Meaning                                                              |
| ------------------- | --------- | -------------------------------------------------------------------- |
| `invalid-options`   | no        | Contradictory configuration (e.g. no LLM and Lighthouse disabled)    |
| `invalid-url`       | no        | URL failed validation (malformed, non-http(s), or blocked target)    |
| `blocked-request`   | no        | The SSRF guard blocked a navigation or redirect                      |
| `capture-failed`    | yes       | Browser navigation/capture failure (often transient)                 |
| `lighthouse-failed` | yes       | Lighthouse failed in Lighthouse-only mode (non-blocking in LLM mode) |
| `llm-auth`          | no        | API key invalid or expired                                           |
| `llm-rate-limit`    | no        | Endpoint rate limit hit                                              |
| `llm-failed`        | yes       | Other LLM call failure                                               |
| `llm-malformed`     | no        | Model response was not parseable as the expected JSON                |

```js
import { ScanError, scan } from 'a11yhawk';

try {
  await scan(url, options);
} catch (error) {
  if (error instanceof ScanError && error.retryable) requeue(url);
  else reportPermanentFailure(error);
}
```

## CLI

<!-- CLI-DOCS:START -->

Run it without installing anything:

```sh
# Free Lighthouse-only scan; reports written to ./a11yhawk-output/<timestamp>/
npx a11yhawk https://example.com

# Full AI analysis (bring your own OpenRouter-compatible key)
npx a11yhawk https://example.com --api-key sk-...

# One-time Chromium download if you have never used Playwright on this machine.
# The version pin matters here: outside a project, an unpinned `npx playwright`
# resolves the registry's latest, whose browser builds a11yhawk cannot use.
# `npx a11yhawk doctor` prints the exact command when Chromium is missing.
npx playwright@1.57.0 install chromium
```

The default command scans a single URL and writes `report.json` and `report.md` (add `html` for the self-contained HTML report), plus `screenshot.jpg` and `annotated.jpg` when available. LLM mode turns on automatically when an API key is present (flag or env) and `--no-llm` is absent; otherwise the scan runs Lighthouse-only, which needs no key and finishes in seconds.

### Commands

| Command                    | Description                                           |
| -------------------------- | ----------------------------------------------------- |
| `a11yhawk <url> [options]` | Scan a URL (default command)                          |
| `a11yhawk serve [options]` | Run the HTTP server (see [Server mode](#server-mode)) |
| `a11yhawk doctor`          | Verify Chromium, Lighthouse, and key configuration    |
| `a11yhawk --help`          | Show usage                                            |
| `a11yhawk --version`       | Print the version                                     |

### Scan options

| Flag                     | Default                         | Description                                                              |
| ------------------------ | ------------------------------- | ------------------------------------------------------------------------ |
| `--model <id>`           | `anthropic/claude-sonnet-5`     | LLM model id (env: `A11YHAWK_MODEL`)                                     |
| `--api-key <key>`        | none                            | LLM API key; presence enables LLM mode (env: `A11YHAWK_API_KEY`)         |
| `--base-url <url>`       | `https://openrouter.ai/api/v1`  | OpenAI-compatible endpoint (env: `A11YHAWK_BASE_URL`)                    |
| `--no-llm`               | off                             | Force Lighthouse-only mode even if a key is set                          |
| `--wcag <2.0\|2.1\|2.2>` | `2.1`                           | WCAG version                                                             |
| `--level <A\|AA\|AAA>`   | `AA`                            | Conformance level                                                        |
| `--header "Name: value"` | none                            | Custom request header; repeatable                                        |
| `--format <list>`        | `json,md`                       | Comma-separated output formats: `json`, `md`, `html`                     |
| `--output <dir>`         | `./a11yhawk-output/<timestamp>` | Directory for report files and screenshots                               |
| `--stdout`               | off                             | Print structured JSON to stdout instead of writing files                 |
| `--open`                 | off                             | Open `report.html` after writing (implies `html` in `--format`)          |
| `--fail-below <score>`   | none                            | Exit 1 when the overall score is below `<score>` (CI gate)               |
| `--allow-private`        | off                             | Permit scanning private/internal targets (env: `A11YHAWK_ALLOW_PRIVATE`) |
| `--no-annotate`          | off                             | Skip screenshot annotation                                               |
| `--no-lighthouse`        | off                             | Skip the Lighthouse audit (LLM mode only)                                |
| `--quiet`                | off                             | Errors only                                                              |
| `--verbose`              | off                             | Debug logging                                                            |

Progress is streamed to stderr as `[stage] message`; report data goes to stdout only under `--stdout`, so `a11yhawk <url> --stdout > report.json` pipes cleanly. `--stdout` writes no files, so it takes precedence over `--open`.

### Environment variables

The CLI reads these as fallbacks; an explicit flag always wins. The library itself never reads the environment.

| Variable                   | Equivalent flag   | Notes                                                                       |
| -------------------------- | ----------------- | --------------------------------------------------------------------------- |
| `A11YHAWK_API_KEY`         | `--api-key`       | Enables LLM mode when set                                                   |
| `A11YHAWK_MODEL`           | `--model`         | LLM model id                                                                |
| `A11YHAWK_BASE_URL`        | `--base-url`      | OpenAI-compatible endpoint                                                  |
| `A11YHAWK_ALLOW_PRIVATE`   | `--allow-private` | Set to `true` to permit private/internal targets                            |
| `A11YHAWK_DISABLE_SANDBOX` | (none)            | Set to `true` to launch Chromium with `--no-sandbox` (some container hosts) |

### Exit codes

| Code | Meaning                                                                      |
| ---- | ---------------------------------------------------------------------------- |
| `0`  | Success                                                                      |
| `1`  | Scan succeeded but the score was below `--fail-below`                        |
| `2`  | Scan error (a `ScanError`; its `[code] message` is printed to stderr)        |
| `3`  | Configuration error (bad flag, contradictory options, or a `doctor` blocker) |

### `doctor`

`a11yhawk doctor` verifies that a scan can run at all: Node.js >= 20, a usable Playwright Chromium (it prints the version-pinned `npx playwright@<version> install chromium` command matching its bundled Playwright when that is what is missing), and a resolvable Lighthouse CLI. It also reports whether an API key is configured, which is informational only since Lighthouse-only mode needs none. It exits `0` when Lighthouse-only scanning is possible and `3` otherwise, so it doubles as a CI preflight.

### CI example

```yaml
# .github/workflows/a11y.yml
name: Accessibility
on: [push]
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npx playwright@1.57.0 install --with-deps chromium
      - name: Accessibility gate
        run: npx a11yhawk https://your-site.example --fail-below 90 --format json,html --output a11y-report
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: a11y-report
          path: a11y-report/
```

Add `--api-key ${{ secrets.OPENROUTER_API_KEY }}` for full AI analysis. The job fails when the score drops below 90 and always uploads the report as a CI artifact.

<!-- CLI-DOCS:END -->

## Server mode

<!-- SERVE-DOCS:START -->

`a11yhawk serve` runs a small HTTP service over the same engine, with one warm browser shared across scans. Jobs live in memory: there is no database, and a restart drops every job and report. Persistence is the host's concern by design.

### Running it

```sh
# From an install, or a clone after `npm run build`
a11yhawk serve                       # listens on :4000

# Docker (browser + system deps baked in; the recommended path).
# Images are published to GHCR with each tagged release.
docker run --rm -p 4000:4000 ghcr.io/charlesjones-dev/a11yhawk:latest

# Docker Compose (see examples/docker-compose.yml)
docker compose -f examples/docker-compose.yml up
```

### Endpoints

| Method and path              | Description                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `POST /scans`                | Enqueue a scan. Body `{ "url": "...", "options": { ... } }`. Returns `202 { id }`. |
| `GET /scans/:id`             | Job status, plus the report once completed or an error once failed.                |
| `GET /scans/:id/report.html` | The rendered HTML report. `404` until the scan completes.                          |
| `GET /healthz`               | Liveness, uptime, and job counts. Never requires auth.                             |

Enqueue a scan and poll it to completion:

```sh
# Lighthouse-only scan (no API key needed)
id=$(curl -s localhost:4000/scans \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}' | jq -r .id)

# Poll until .status is "completed" or "failed"
curl -s localhost:4000/scans/$id | jq '{status, score: .report.structured.overallScore}'

# Save the HTML report once it is ready
curl -s localhost:4000/scans/$id/report.html -o report.html
```

The `options` object accepts only `llm { apiKey, model, baseUrl, generationParams }`, `wcagVersion`, `wcagLevel`, `headers`, `lighthouse`, and `annotate`; any other field is ignored. In the JSON report, screenshots come back as base64 `data:` URIs rather than raw bytes, and a submitted `llm.apiKey` is never echoed back in any response.

### Configuration

Every setting is an environment variable, read only by the server layer (never the library):

| Variable                    | Default | Purpose                                                                              |
| --------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `A11YHAWK_PORT` (or `PORT`) | `4000`  | Listen port. `serve --port <n>` overrides both.                                      |
| `A11YHAWK_AUTH_TOKEN`       | (unset) | When set, every endpoint except `/healthz` requires `Authorization: Bearer <token>`. |
| `A11YHAWK_CONCURRENCY`      | `2`     | Max concurrent scans (clamped 1-10). Extra scans queue FIFO.                         |
| `A11YHAWK_JOB_TTL_SECONDS`  | `3600`  | How long a finished job is retained before eviction.                                 |
| `A11YHAWK_ALLOW_PRIVATE`    | `false` | Permit scanning private/internal targets (see the note below).                       |
| `A11YHAWK_DISABLE_SANDBOX`  | `false` | Launch Chromium with `--no-sandbox`; some container hosts require it.                |

### Server security note

`allowPrivateNetworks` is a server-level posture, set only by `A11YHAWK_ALLOW_PRIVATE`. A request body can never turn it on: that field, along with `browser` and `logger`, is stripped from submitted options. Leave it off anywhere scan URLs come from people you do not trust, and put network-layer egress rules around the server when it is multi-tenant. See the Security section below for the residual Lighthouse SSRF caveat that applies to every mode.

<!-- SERVE-DOCS:END -->

## Security

A11yHawk is designed to be safe to embed in services where scan URLs come from untrusted users, and honest about its residual risks.

- **SSRF request guard, default-on.** Every request the scanned page makes is validated at the browser context level: scheme checks, per-request DNS resolution with no cached allow-verdicts, redirect-hop detection, service workers blocked, private/loopback/link-local targets refused. Scan URLs are re-validated at scan time (not just submission time) to narrow DNS-rebinding windows.
- **`allowPrivateNetworks: true`** exists because scanning your own internal apps is a primary self-hosting use case. It only widens which resolved addresses the guard accepts; every other protection stays active. Leave it `false` anywhere scan URLs come from people you don't trust.
- **Known residual risk**: Lighthouse drives its own browser navigation, outside the Playwright request guard. The engine re-validates the audit target immediately before the run, but network-layer egress filtering is the only complete mitigation. If you run A11yHawk multi-tenant, put egress rules around it.
- **Subprocess hygiene**: the Lighthouse CLI is spawned with `shell: false` and argv arrays; the attacker-controllable URL is never interpreted by a shell.
- **Key handling**: API keys arrive as options, are never logged, and error messages from the LLM layer are sanitized so keys cannot leak through error chains.
- **Report output**: everything interpolated into the HTML report is entity-escaped, so a malicious scanned page cannot inject markup or script into its own report.
- **No telemetry.** Nothing is collected, nothing phones home.

Found a vulnerability? Please open a GitHub security advisory rather than a public issue.

## For AI agents

Everything above applies; this section is deliberately compact and exact.

- Package: `a11yhawk` (npm). ESM only. Node >= 20. Requires Chromium: `npx playwright@1.57.0 install chromium` (pin matches the bundled Playwright; unpinned is fine only inside a project that has a11yhawk installed).
- Exports: `scan`, `A11yHawkEngine`, `renderHtmlReport`, `ScanError`, `createLogger`, `DEFAULT_MODEL`, plus all types (`ScanOptions`, `EngineOptions`, `ScanReport`, `StructuredScanOutput`, `AccessibilityIssue`, ...). Full `.d.ts` shipped.
- Minimal complete program:

```js
import { scan } from 'a11yhawk';
const report = await scan('https://example.com'); // Lighthouse-only, no key needed
// report.structured.overallScore: number 0-100
// report.structured.issues: Array<{ severity: 'critical'|'high'|'medium'|'low', wcagCriteria: string, title: string, remediation: string, ... }>
```

- LLM mode: add `{ llm: { apiKey } }`; key is an OpenRouter key unless `llm.baseUrl` points elsewhere. Expect 1-5+ minutes and provider token costs per scan in LLM mode; Lighthouse-only takes seconds and is free.
- Scanning localhost or private hosts requires `{ allowPrivateNetworks: true }`.
- All failures are `ScanError` with `.code` (see table above) and `.retryable`. Non-retryable codes will fail identically on retry; do not loop on them.
- CI gating pattern: run a scan, compare `report.structured.overallScore` to your threshold, exit non-zero below it. Or use the CLI's built-in gate: `npx a11yhawk <url> --fail-below 80`.
- Shelling out instead of importing: `npx a11yhawk <url> --stdout` prints the structured JSON to stdout (progress goes to stderr). Exit codes: 0 success, 1 below `--fail-below`, 2 scan error, 3 configuration error. `npx a11yhawk doctor` preflights the environment.
- A self-hostable HTTP mode exists (`a11yhawk serve`, `POST /scans` then poll `GET /scans/:id`); see Server mode above.

## Examples

Runnable scripts live in [`examples/`](./examples/). They import `a11yhawk` by package name (Node resolves the package's own name from inside the repo), so every script is byte-for-byte what you would write in your own project.

From a clone:

```sh
npm install
npx playwright install chromium   # one-time browser download
npm run build                     # examples resolve 'a11yhawk' to the local dist/ build
```

Then:

```sh
# Self-contained demo: serves a deliberately broken page locally, scans it,
# writes an HTML report to examples/output/. No API key, no external network.
node examples/local-fixture.mjs

# Free Lighthouse-only scan of any public URL, summary to stdout
node examples/lighthouse-only.mjs https://your-site.example

# Full AI analysis: writes report.json / report.md / report.html + screenshots
# to examples/output/. Takes minutes and costs tokens on your key.
OPENROUTER_API_KEY=sk-... node examples/full-scan.mjs https://your-site.example

# CI gate: exit 0 if score >= threshold, 1 below it, 2 on scan error
node examples/ci-gate.mjs https://your-site.example 80
```

`full-scan.mjs` also honors `A11YHAWK_MODEL` to override the default model. If you copy a script into your own project, replace the build step with `npm install a11yhawk`; nothing else changes.

The directory also holds two deployment templates: `docker-compose.yml` (server mode as a container) and `github-action.yml` (a copy-paste CI job gating on `--fail-below`).

## Output formats

- **`structured`** (JSON): overall score (0-100, recomputed from WCAG coverage), per-severity statistics, WCAG coverage with pass/fail per criterion, issues with location/selector, code context, impact, and remediation, passed checks. Stable shape; treat as the source of truth.
- **`markdown`**: the same content as a readable report.
- **HTML** (via `renderHtmlReport`): a single dark-theme file with score ring, severity breakdown, sortable/collapsible issues with client-side resolve tracking (localStorage), and the annotated screenshot. Attach it to CI artifacts, tickets, or email; it has zero external dependencies.

## Roadmap

- **GitHub Action** wrapper.
- SARIF and JUnit output formats.

## Contributing

Contributions welcome. Setup:

```sh
git clone https://github.com/charlesjones-dev/a11yhawk
cd a11yhawk
npm install
npx playwright install chromium
npm run verify   # lint + typecheck + tests + build; must pass before a PR
```

| Script             | What it does                                 |
| ------------------ | -------------------------------------------- |
| `npm run verify`   | The full gate: lint, typecheck, tests, build |
| `npm test`         | Vitest in watch mode                         |
| `npm run test:run` | Tests once                                   |
| `npm run format`   | Prettier write                               |

Conventions: TypeScript strict (including `noUncheckedIndexedAccess`), ESM only, tests colocated as `*.test.ts` next to the module they cover. The request guard, URL validator, and Lighthouse spawn are security-sensitive; changes there get extra scrutiny and must not weaken defaults. Please keep PRs focused and include tests for behavior changes.

## Relationship to AccessHawk

A11yHawk is the open-source engine behind [AccessHawk](https://accesshawk.ai), extracted and maintained by the same author. The hosted product adds scheduling, history, dashboards, teams, and a managed API around this engine; the engine itself - capture, audits, AI analysis, and reports - is all here, and running it on your own infrastructure is the point.

## License

Apache-2.0. Copyright Charles Jones.
