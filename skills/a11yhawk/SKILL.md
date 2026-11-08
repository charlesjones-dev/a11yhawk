---
name: a11yhawk
description: Run WCAG accessibility scans of web pages with a11yhawk, the open-source, self-hostable scan engine (Playwright capture, Lighthouse audits, optional bring-your-own-key LLM analysis). Use when asked to audit a URL, page, localhost app or staging site for accessibility (a11y) or WCAG 2.0, 2.1 or 2.2 issues, to add an accessibility check or score gate to CI, to produce accessibility reports (JSON, markdown, HTML, SARIF), or to use the a11yhawk CLI (npx a11yhawk), its doctor or serve commands, or its Node.js library (scan, A11yHawkEngine). Lighthouse-only scans need no API key.
license: Apache-2.0
compatibility: Requires Node.js 20 or later, network access to the scanned page, and a one-time Playwright Chromium download. LLM mode also needs an OpenRouter, OpenAI-compatible or Anthropic API key.
metadata:
  homepage: https://github.com/charlesjones-dev/a11yhawk
  package: a11yhawk
---

# A11yHawk

A11yHawk scans one web page at a time for accessibility problems. It loads the page in a real Chromium browser, runs Lighthouse's accessibility audits, and can optionally send the screenshot, accessibility tree and sanitized HTML to an LLM for a full WCAG review. It runs on the user's own machine or CI runner. It has no accounts and no telemetry.

Use it three ways: the CLI (`npx a11yhawk`), the Node.js library (`import { scan } from 'a11yhawk'`), or a small HTTP server (`a11yhawk serve`).

## Choose a mode first

| Mode            | When                                                          | Needs                  | Time and cost                               |
| --------------- | ------------------------------------------------------------- | ---------------------- | ------------------------------------------- |
| Lighthouse-only | Default. Quick checks, CI gates, bulk scans, no key available | Nothing beyond Node    | Seconds, free                               |
| LLM-assisted    | The user wants a full WCAG review with remediation guidance   | The user's own LLM key | 1-5+ minutes per page, provider token costs |

- **Lighthouse-only needs no API key.** It is deterministic and runs whenever no key is set. Start here unless the user asks for an AI review or already has a key configured.
- **LLM mode** turns on in the CLI when an API key is present (`--api-key` or `A11YHAWK_API_KEY`) and `--no-llm` is absent. Two providers exist:
  - `openrouter` (default): an OpenRouter key, or any OpenAI-compatible endpoint through `--base-url`.
  - `anthropic`: an Anthropic API key, calling the Claude API directly (`--provider anthropic`).
- The user brings and pays for the key. Ask before you start an LLM scan on their key, because each scan costs tokens.
- Prefer the `A11YHAWK_API_KEY` environment variable over `--api-key`, so the key stays out of shell history and logs. Never print, log or commit a key.

## Set up

```sh
npx a11yhawk doctor
```

`doctor` checks Node.js, Playwright's Chromium and the Lighthouse CLI. If Chromium is missing, it prints the exact version-pinned `npx playwright@<version> install chromium` command. Run that command. Use the printed version, because an unpinned `npx playwright` outside a project fetches a browser build that a11yhawk cannot use. Inside a project that has `a11yhawk` installed, `npx playwright install chromium` is fine. `doctor` exits `0` when a Lighthouse-only scan can run and `3` when it cannot.

For library use: `npm install a11yhawk`. The package is ESM-only, so use `import`, not `require`.

## CLI

```sh
# Lighthouse-only scan. Writes reports to ./a11yhawk-output/<timestamp>/
npx a11yhawk https://example.com

# Add the self-contained HTML report and SARIF
npx a11yhawk https://example.com --format json,md,html,sarif --output a11y-report

# Structured JSON on stdout (progress goes to stderr)
npx a11yhawk https://example.com --stdout > report.json

# LLM-assisted scan through OpenRouter (key from the environment)
A11YHAWK_API_KEY=... npx a11yhawk https://example.com --wcag 2.2 --level AA

# LLM-assisted scan through the Claude API
A11YHAWK_API_KEY=... npx a11yhawk https://example.com --provider anthropic

# Force Lighthouse-only even when a key is set
npx a11yhawk https://example.com --no-llm
```

Commands: `a11yhawk <url> [options]` (scan, the default), `a11yhawk serve [options]`, `a11yhawk doctor`, `a11yhawk --help`, `a11yhawk --version`. Run `npx a11yhawk --help` for the full flag list of the installed version.

Main scan flags:

| Flag                     | Default                         | Purpose                                                   |
| ------------------------ | ------------------------------- | --------------------------------------------------------- |
| `--provider <name>`      | `openrouter`                    | `openrouter` or `anthropic` (env `A11YHAWK_PROVIDER`)     |
| `--model <id>`           | depends on the provider         | LLM model id (env `A11YHAWK_MODEL`)                       |
| `--api-key <key>`        | none                            | Enables LLM mode (env `A11YHAWK_API_KEY`)                 |
| `--base-url <url>`       | the provider's public endpoint  | OpenAI-compatible endpoint (env `A11YHAWK_BASE_URL`)      |
| `--no-llm`               | off                             | Lighthouse-only even with a key                           |
| `--wcag <2.0\|2.1\|2.2>` | `2.1`                           | WCAG version                                              |
| `--level <A\|AA\|AAA>`   | `AA`                            | Conformance level                                         |
| `--header "Name: value"` | none                            | Request header or cookie for the target page, repeatable  |
| `--format <list>`        | `json,md`                       | Any of `json`, `md`, `html`, `sarif`                      |
| `--output <dir>`         | `./a11yhawk-output/<timestamp>` | Report directory                                          |
| `--stdout`               | off                             | Print structured JSON to stdout and write no files        |
| `--open`                 | off                             | Open `report.html` after the scan (implies `html`)        |
| `--fail-below <score>`   | none                            | Exit `1` when the overall score is below `<score>`        |
| `--allow-private`        | off                             | Allow localhost and private-network targets and endpoints |
| `--no-annotate`          | off                             | Skip the annotated screenshot                             |
| `--no-lighthouse`        | off                             | Skip Lighthouse (LLM mode only)                           |
| `--quiet` / `--verbose`  | off                             | Errors only / debug logging                               |

Exit codes: `0` success, `1` score below `--fail-below`, `2` scan error (`[code] message` on stderr), `3` configuration error or a `doctor` blocker.

### Scan localhost or a private host

The engine refuses private, loopback and link-local targets by default (SSRF protection). To scan a local dev server or an internal staging site, pass `--allow-private` (library: `{ allowPrivateNetworks: true }`). A local LLM endpoint such as Ollama needs the same flag. Use it only for targets the user controls.

Pages behind a login: pass the cookie or auth header with `--header`. The engine sends headers only to the scan URL's origin, so use the URL the page finally lands on.

### CI gate

Install a11yhawk in the job first, so the unpinned Chromium install resolves the Playwright version that a11yhawk uses. In a repo that already lists `a11yhawk` in its dev dependencies, `npm ci` does the same.

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
      - run: npm install --no-save a11yhawk
      - run: npx playwright install --with-deps chromium
      # Ubuntu runners block the user namespaces that Chromium's sandbox needs.
      - run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
      - name: Accessibility gate
        run: npx a11yhawk https://your-site.example --fail-below 90 --format json,html,sarif --output a11y-report
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: a11y-report
          path: a11y-report/
```

For an AI-backed gate, add the key from a CI secret as the `A11YHAWK_API_KEY` environment variable on the scan step. `report.sarif` can go to code-scanning tools.

## Library

```js
import { writeFileSync } from 'node:fs';
import { renderHtmlReport, renderSarifReport, scan } from 'a11yhawk';

// Lighthouse-only: no key needed
const report = await scan('https://example.com');

// LLM-assisted (OpenRouter key by default; add provider: 'anthropic' for an Anthropic key)
const full = await scan('https://example.com', {
  llm: { apiKey: process.env.OPENROUTER_API_KEY },
  wcagVersion: '2.2',
  wcagLevel: 'AA',
  onProgress: (e) => console.error(`[${e.stage}] ${e.message}`),
});

writeFileSync('report.json', JSON.stringify(full.structured, null, 2));
writeFileSync('report.md', full.markdown);
writeFileSync('report.html', renderHtmlReport(full));
writeFileSync('report.sarif', renderSarifReport(full));
```

- The library never reads environment variables. Pass every setting, including the key, as an option.
- `scan(url, options)` launches and closes the browser for you. For many pages, hold one `A11yHawkEngine` so the browser stays warm, and always close it:

```js
import { A11yHawkEngine } from 'a11yhawk';

const engine = new A11yHawkEngine(); // EngineOptions, such as { allowPrivateNetworks: true }
try {
  for (const url of urls) {
    const report = await engine.scan(url, { screenshot: false }); // ScanOptions per scan
  }
} finally {
  await engine.close();
}
```

- `screenshot: false` keeps memory flat in bulk Lighthouse-only scans. It cannot combine with `llm`.
- `lighthouse: { categories: ['accessibility', 'performance'] }` adds Lighthouse performance metrics to `report.lighthouse.performance` from the same page load. `'accessibility'` must stay in the list.
- Every failure is a `ScanError` with `.code` and `.retryable`. Retry only when `error.retryable` is true. A non-retryable error fails the same way on every retry, so report it instead of looping.

The package ships full TypeScript types. Read `node_modules/a11yhawk/dist/index.d.ts` for every option and result field.

## Server mode

`a11yhawk serve` runs an HTTP service on port 4000 (change it with `--port <n>` or `A11YHAWK_PORT`). Use it when another service needs to submit scans. It keeps jobs in memory only.

- `POST /scans` with `{ "url": "...", "options": { ... } }` returns `202 { id }`.
- Poll `GET /scans/:id` until `status` is `completed` or `failed`.
- `GET /scans/:id/report.html` returns the HTML report.
- `GET /healthz` reports liveness.
- Set `A11YHAWK_AUTH_TOKEN` to require `Authorization: Bearer <token>` on every endpoint except `/healthz`.

A request body can never enable private-network scanning. Only the `A11YHAWK_ALLOW_PRIVATE` environment variable can. A Docker image is published at `ghcr.io/charlesjones-dev/a11yhawk`. See the repository README for its run command and Chromium sandbox notes.

## Read the results

`report.structured` is the source of truth. The other outputs render the same data.

- `overallScore` (0-100): in LLM mode, the percent of checked WCAG criteria with no issues found. In Lighthouse-only mode, the Lighthouse accessibility score. The engine computes it. It never trusts a score from the model.
- `issues[]`: each issue has `severity` (`critical`, `high`, `medium` or `low`), `wcagCriteria`, `title`, `location`, `codeContext`, `userImpact`, `recommendation` and `remediation`. Fix critical and high issues first.
- `statistics`: issue counts by severity.
- `wcagCoverage[]`: the criteria the scan checked. `passed: true` means the scan found no issue there. It does not mean the page conforms to that criterion.
- `report.lighthouse`: Lighthouse findings mapped to WCAG. These come from deterministic audits that the model cannot change.

When you report results to the user:

- Lead with the score, the counts by severity, and the top issues with their WCAG criteria and fixes.
- Say which mode ran. A Lighthouse-only scan covers only the automated checks, so suggest LLM mode or manual testing for a fuller review.
- Never claim WCAG conformance or legal compliance from a scan. Automated and AI checks cover only part of WCAG, and the reports say so.
- For pages the user does not control, check LLM findings against `report.lighthouse`. Page content can try to steer the model.
- One scan covers one URL. To audit a site, scan each key page and template.

## A11yHawk or hosted AccessHawk

Use A11yHawk (this skill) when the scan should run locally, in CI, or on infrastructure the user owns, with their own LLM key.

[AccessHawk](https://accesshawk.ai) is the hosted product built on this engine. It adds scheduling, scan history, dashboards, teams and a managed API. If the user has an AccessHawk account and wants to work through it, install its separate skill:

```sh
npx skills add joneslabs-llc/agent-skills --skill accesshawk
```

This skill does not cover the hosted AccessHawk API.
