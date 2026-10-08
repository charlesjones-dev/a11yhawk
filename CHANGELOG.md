# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Pre-1.0 versioning.** While a11yhawk is in `0.x`, the public API is still stabilizing: breaking changes may ride minor version bumps (for example `0.1.0` to `0.2.0`) up until `1.0.0`. Patch releases (`0.1.0` to `0.1.1`) stay backward compatible. If you depend on the API surface, pin a minor range. `1.0.0` ships once the API has stabilized against real adoption.

## [0.4.0] - 2026-10-08

This release contains breaking behavior changes. No exported function, option name, error code, or result type changed shape, but an `llm.baseUrl` on a private network is now refused, LLM error messages changed, and the server can answer `503`. Read Breaking changes before upgrading.

### Breaking changes

- **`llm.baseUrl` must be a public address unless private networks are allowed.** An endpoint on a private, loopback, or link-local address, such as a local Ollama at `http://localhost:11434/v1`, now fails the scan with a non-retryable `invalid-options` error before any browser work, and the LLM client refuses any connection, redirect hop included, that lands on one. To use a local endpoint, set `allowPrivateNetworks: true` (CLI `--allow-private`, server `A11YHAWK_ALLOW_PRIVATE=true`); that also permits private scan targets. The default OpenRouter endpoint is unaffected.
- **LLM HTTP errors report the status only.** A non-2xx reply other than 401 or 429 now fails with `LLM request failed with HTTP <status>.` instead of the provider's message, which is still logged. The 401 and 429 messages are unchanged. Code that matched provider error text in `ScanError.message` needs updating.
- **Server: `POST /scans` can answer `400` for `llm.baseUrl` and `503` when full.** A submitted `llm.baseUrl` on a private network is rejected with `400 invalid-request` unless the server sets `A11YHAWK_ALLOW_PRIVATE`. Once 100 scans are waiting, new submissions get `503 queue-full` until the queue drains.

### Security

- **The LLM endpoint could be pointed at internal services.** `llm.baseUrl` reached the OpenAI SDK unchecked, and server mode accepts it from request bodies, so any client of `a11yhawk serve` (unauthenticated unless `A11YHAWK_AUTH_TOKEN` is set) could make the server POST to any internal host, port, and path with a bearer token of its choosing, then read non-2xx response bodies back through `GET /scans/:id`. The endpoint now gets the scan target's SSRF posture at submission, at scan start, and on every connection, and provider error bodies are no longer returned.
- **Stored XSS in the HTML report through provider token counts.** `usage.promptTokens`, `completionTokens`, and `totalTokens` were copied from the provider response without a type check and rendered without escaping, so an endpoint that replied with a string ran script in the report, including on the server's origin. Usage counters are now numbers only (anything else becomes `0`, or is omitted for the optional cached and reasoning counts), the report escapes them, and the server sends `report.html` with a `Content-Security-Policy` that lets only the report's own inline script run, plus `X-Content-Type-Options: nosniff`.
- **HTML sanitizing could stall the process.** Several `sanitizeHtml` patterns took quadratic time on page-controlled input: 50 KB of whitespace took about three minutes, and raw text full of unclosed `<script>`, `<!--`, or `<title>` openers took seconds per few hundred KB. Each run blocked the event loop for every concurrent scan and, in server mode, the HTTP listener. Every pattern now runs in linear time, and the output is unchanged. LLM mode only; Lighthouse-only scans never sanitize HTML.
- **The server's job queue was unbounded.** Queued jobs are never swept, so a client could submit scans faster than they ran and grow memory without limit. The queue now holds at most 100 waiting scans, and `/healthz` reports the limit as `queueLimit`.

## [0.3.0] - 2026-10-06

This release contains breaking behavior changes. No exported function, option name, error code, or result type changed shape (`StructuredScanOutput` and the other result types only gained doc comments), but custom header handling, report text, and some structured data values changed in ways existing integrations can notice. Read Breaking changes before upgrading.

### Breaking changes

- **Custom headers no longer reach other origins.** `headers` entries of type `header` and `authorization` are sent only to requests whose origin (scheme, host, and port) matches the scan URL. A page that calls an API on another origin, including a sibling subdomain (`api.example.com` from `app.example.com`), the `www`/bare variant, or `http` instead of `https`, now makes those calls without the custom headers or bearer token. Pass the URL the page finally lands on; there is no option to widen the scope.
- **`Cookie` header entries become scoped cookies.** A `header` entry named `Cookie` (including CLI `--header "Cookie: a=1"`) was sent as a raw header on every request to every host. It is now split into cookies set for the scan URL, which the browser sends only to that host and to paths under the scan URL's directory: scanning `/app/dashboard` covers `/app/`, not `/api/`. `cookie` entries have always been scoped this way.
- **Report text changed.** Headings, table columns, and labels in the markdown and HTML reports changed (see Changed). Code that parses `report.markdown` or the HTML report by heading text, emoji, or the old "Status" and "Priority" columns needs updating. The markdown criteria table still has five columns in the same order.
- **Structured data values changed.**
  - `LighthouseIssue.wcagCriteria` is corrected for many audits and is `"unknown"` for best-practice audits, which now get `minor` severity, so `summary.bySeverity` counts shift.
  - `lighthouseWcagCriteria` no longer contains `"unknown"` and now includes the related criteria of best-practice audits.
  - In Lighthouse-only mode, `issues[].wcagCriteria` can be `"Best practice"` or `"Outside WCAG <version> Level <level>: <criterion>"` (those issues are `low` severity), and `wcagCoverage` lists only criteria in the requested version and level. Code that expects `wcagCriteria` to start with a criterion number must handle these values.
- **Scores can shift.** WCAG 2.1 and 2.2 Level AAA scans now assess 78 and 86 criteria (was 76 and 84), and the prompt no longer pushes the model to fail site-level criteria or to reach an issue count, so LLM-mode `overallScore` values may rise compared with earlier scans of the same page. Review `--fail-below` thresholds and score history comparisons. The Lighthouse-only score is unchanged.

### Security

- **Custom scan headers are scoped to the scan target's origin.** Header and bearer-token entries were set as context-wide `extraHTTPHeaders`, so the browser sent them with every request the scanned page made, including third-party scripts, CDNs, and analytics. A context route now adds them only to requests whose origin (scheme, host, and port) matches the scan URL; subdomains and the `www`/bare variant do not match. The annotation pass stays scoped to the original scan URL even when the page redirected elsewhere. Cookie entries are still set as cookies for the scan URL, and a `Cookie` header entry is now converted to cookies the same way, because Playwright drops `Cookie` from route header overrides. The SSRF request guard is unchanged and still decides every request. Residual gap: Playwright re-sends a request's headers on its redirect hops, so a same-origin URL that redirects to another origin still delivers them to the redirect target. WebSocket handshakes are not routed and do not receive custom headers.

### Changed

- **Reports describe what was checked and what was found, never a compliance outcome.** In the markdown report, "WCAG AA Compliance 80% (40/50 criteria)" is now "Criteria with no issues found 40 of 50 (80%)", "WCAG Compliance Matrix" is now "WCAG criteria checked", and the "Expected Impact" lines that projected compliance percentages are gone from the remediation roadmap. The introduction and summary sentences are rewritten as plain statements of what the scan found, the AI analysis line no longer names A11yHawk (hosts show the report under their own name), and emoji are replaced with text. Every report now ends with a note that it covers one page and is not a compliance certification. The HTML report labels criteria "No issues found" or "Issues found" instead of "Passed" or "Failed".
- **Criteria table severity.** The markdown table's Priority column said High for every failing criterion. It is now "Highest severity", taken from the most severe issue mapped to the criterion.
- **Lighthouse-only reports** no longer show an "AI Analysis" heading or a share of criteria with no issues (Lighthouse lists failing audits only), and list failed criteria with their WCAG names and levels instead of Level A for all of them. Lighthouse runs the same audits for every standard, so a finding under a criterion outside the requested version and level (2.5.8 is WCAG 2.2 only; 2.4.9 is AAA) is now a low-severity issue labeled, for example, "Outside WCAG 2.1 Level AA: 2.5.8 Target Size (Minimum)", not a failed criterion.
- **LLM prompt.** The model is told not to fail 2.4.5 Multiple Ways, 2.4.8 Location, 2.4.1 Bypass Blocks, or 3.3.5 Help without evidence on the page, to report a missing `<main>` landmark as a low-severity best practice, and to avoid compliance claims and filler in issue text. The issue-count quotas ("if you find fewer than 5 issues, you are likely missing problems") are gone, and the target size and focus contrast guidance now cites the right criteria (2.5.8 at AA, 2.5.5 at AAA, 1.4.11 for focus indicator contrast).

### Fixed

- **WCAG 2.1 criteria list.** 2.2.6 Timeouts and 2.3.3 Animation from Interactions (both AAA) were missing, so WCAG 2.1 and 2.2 Level AAA scans assessed 76 and 84 criteria instead of 78 and 86. A test now pins the per-version, per-level counts to W3C's.
- **Lighthouse audit mapping.** Checked against the axe-core 4.12 rule tags and corrected, for example `video-caption` to 1.2.2 (was 2.2.2), `target-size` to 2.5.8 (was 2.5.5), `frame-title` to 4.1.2 (was 1.1.1), and `label-content-name-mismatch` to 2.5.3 (was 2.4.6); audits Lighthouse runs but the map lacked, such as `link-in-text-block` and `td-has-header`, are added. Audits axe tags best-practice, such as `landmark-one-main`, `heading-order`, and `tabindex`, no longer claim a WCAG criterion and get minor severity, so Lighthouse-only reports list them as low-severity best practice instead of a failed criterion (or an `unknown` coverage row).
- **Lighthouse cross-reference.** Best-practice audits have no WCAG criterion, so they never matched an AI finding: a report could show 0 Lighthouse-confirmed issues while Lighthouse flagged the same missing `<main>` landmark the model reported. Matching now also uses each best-practice audit's related criteria (1.3.1 and 2.4.1 for a missing main landmark), and `lighthouseWcagCriteria` no longer contains `"unknown"`.

## [0.2.1] - 2026-09-07

### Fixed

- **Browser connections after long uptime.** Set an explicit 30-second timeout when connecting to Chromium. This avoids Playwright 1.57's default deadline expiring after approximately 24.9 days of process uptime, which caused scans to fail immediately with `browserType.connect: Timeout undefinedms exceeded`.

### Added

- **Long-uptime browser regression test.** An opt-in test uses real Chromium with a simulated 28-day process clock. Run it with `A11YHAWK_BROWSER_TEST=1 npx vitest run src/engine/playwright.integration.test.ts` after installing Playwright Chromium.

## [0.2.0] - 2026-07-29

Additive release aimed at library consumers running bulk scans. No breaking changes: `scan()`, `A11yHawkEngine`, `ScanReport`, option names, and error codes are all unchanged, and omitting the new options behaves exactly like `0.1.4` (the only visible difference is the new `lighthouseVersion` field on `report.lighthouse`).

### Added

- **Lighthouse performance category.** `ScanOptions.lighthouse` now also accepts an object: `lighthouse: { categories: ['accessibility', 'performance'] }` runs both categories from a single Lighthouse subprocess and a single page load (the boolean form keeps working; `true` ≡ `{ categories: ['accessibility'] }`). Results land additively on `report.lighthouse.performance` as a typed `LighthousePerformanceResult`: category score (0-100 or `null` when uncomputable), FCP/LCP/CLS/TBT/Speed Index metrics, and the top savings-bearing opportunities (audit id, title, estimated ms/bytes; sorted, capped at 10). Works with or without an LLM key. `categories` must include `'accessibility'` (it is the analysis source for the structured report); a bad list throws the existing `invalid-options` code, and run failures keep surfacing as `lighthouse-failed`. `StructuredScanOutput` is untouched.
- **Performance runs are serialized engine-wide.** Runs that include the performance category execute one at a time regardless of `setConcurrency(n)`, because parallel traces contend for CPU and skew metrics. Performance runs also get a 60s Lighthouse timeout (accessibility-only runs keep 30s).
- **`ScanOptions.screenshot`.** `screenshot: false` skips screenshot capture entirely (capture, tiling, annotation, and the pre-capture scroll), so bulk Lighthouse-only crawls hold no image buffers per scan; `report.screenshot` and `report.annotatedScreenshot` come back `null`. Lighthouse-only mode only: combining it with `llm` throws `invalid-options` since the LLM analysis needs the screenshot.
- **`report.lighthouse.lighthouseVersion`.** The Lighthouse version that produced the result, for downstream report provenance.
- **`lighthouse: { includeRaw: true }`.** Opt-in escape hatch attaching the raw Lighthouse result as `report.lighthouse.raw` for audits the engine does not map, trimmed of screenshot payloads and localization tables so it stays bulk-safe.
- **Server passthrough.** `a11yhawk serve` accepts the new `options.lighthouse` object form and `options.screenshot` through its strict allowlist; invalid category lists are rejected with `400` at submission time.
- **Bulk-mode soak test.** Opt-in regression test (`A11YHAWK_SOAK=1 A11YHAWK_SOAK_SCANS=1000 NODE_OPTIONS=--expose-gc npx vitest run src/engine/scan.soak.test.ts`) running sequential Lighthouse-only scans on one warm engine against a local fixture server, asserting flat memory and stable handle counts.

### Fixed

- **Lighthouse timeout kill escalation.** A timed-out Lighthouse subprocess that ignores `SIGTERM` is now `SIGKILL`ed after a 5s grace period, so long-lived hosts cannot accumulate zombie audit processes.

## [0.1.4] - 2026-07-21

### Added

- **Lighthouse audit duration on the report.** `ScanReport.lighthouse.summary.lighthouseDurationMs` now carries the measured Lighthouse audit duration (the same value the engine already logged), so hosts can record per-audit timing programmatically instead of inferring it from wall clocks. Additive; the field is optional on the type for compatibility with previously persisted results. ([#2](https://github.com/charlesjones-dev/a11yhawk/issues/2))

### Fixed

- **Per-scan logger bypass.** The "Lighthouse context optimization" stats line (and the token-budget warning) in the prompt builder logged through a module-level default logger, dropping the host's injected logger context. Both now flow through the `ScanOptions.logger` → `EngineOptions.logger` → default chain like every other per-scan log line. ([#1](https://github.com/charlesjones-dev/a11yhawk/issues/1))

## [0.1.3] - 2026-07-20

### Changed

- **`doctor` fix hint.** When Chromium is missing, `a11yhawk doctor` now prints a version-pinned `npx playwright@<version> install chromium` command matching its bundled Playwright, instead of the unpinned form. Outside a project, unpinned `npx playwright install` resolves the registry's latest Playwright and downloads browser builds the package cannot use.
- **README.** Playwright install commands that run outside a project install (Requirements, the run-without-installing quickstart, the CI example, and the For AI agents section) are now version-pinned for the same reason. In-project commands stay unpinned, since there npx correctly resolves the bundled Playwright.

## [0.1.2] - 2026-07-20

Documentation-only release. No engine, API, or CLI changes.

### Changed

- **README.** The "How it works" diagram is a plain-text vertical pipeline again. The Mermaid version added in `0.1.1` renders on GitHub but not on npmjs.com, where it showed as raw Mermaid source; text renders identically on both.

## [0.1.1] - 2026-07-20

Documentation-only release. No engine, API, or CLI changes.

### Changed

- **README.** The "How it works" pipeline diagram is now a vertical Mermaid flowchart instead of an ASCII sketch, so it renders as a real diagram on GitHub and npm. It carries `accTitle` / `accDescr`, which means the rendered SVG is described for screen reader users rather than being an unlabeled graphic.

## [0.1.0] - 2026-07-20

First functional release. The scan engine, its library API, the CLI, server mode, and the Docker image all land here; `0.0.1` and `0.0.2` were name-reserving stubs that only threw on import.

### Added

- **Scan engine.** Single-URL WCAG accessibility pipeline: URL validation, Playwright page capture (full-page screenshot, accessibility tree, sanitized HTML), Lighthouse accessibility audit, and optional bring-your-own-key LLM analysis. Scores and statistics are recomputed by the engine from the actual findings, never trusted from the model.
- **Lighthouse-only mode.** Omit the `llm` block for a deterministic, no-API-key scan that finishes in seconds. LLM mode adds full-page AI analysis against every WCAG criterion for the version and level you select.
- **SSRF request guard, default-on.** Scheme checks, per-request DNS resolution, redirect-hop detection, blocked service workers, and refusal of private / loopback / link-local targets, with scan URLs re-validated at scan time. `allowPrivateNetworks` opts in to scanning internal hosts without disabling the rest of the guard.
- **Reports.** Structured JSON (the machine-readable source of truth), a human-readable markdown report, and a single self-contained HTML report (inline CSS/JS, screenshots as data URIs, itself WCAG AA accessible) via `renderHtmlReport`. Issues are annotated onto a copy of the screenshot with severity-colored boxes.
- **Library API.** The `scan()` one-shot helper, the reusable `A11yHawkEngine` (keeps the browser warm across scans), `renderHtmlReport()`, and a `ScanError` taxonomy carrying a `code` and a `retryable` flag so queue-based hosts can map failures onto their retry semantics. Full TypeScript types shipped.
- **CLI.** `npx a11yhawk <url>` with output formats (`json`, `md`, `html`), `--no-llm`, WCAG version/level flags, repeatable `--header`, `--allow-private`, `--stdout`, and `--fail-below <score>` for CI gating (exit `1` below the threshold). `a11yhawk doctor` verifies the Chromium install, Lighthouse CLI resolution, and key configuration.
- **Server mode + Docker.** `a11yhawk serve` exposes a small in-memory HTTP job API (`POST /scans`, `GET /scans/:id`, `GET /scans/:id/report.html`, `GET /healthz`) with optional bearer-token auth. Published as a Docker image with the browser and system dependencies baked in.
- **Examples.** Runnable scripts for a local fixture scan, a Lighthouse-only scan, a full AI scan, and a CI gate, plus a copy-paste GitHub Actions job template.

## 0.0.2 - 2026-07-19

### Added

- Name-reserving stub published to npm to claim the `a11yhawk` package name and prove the account, 2FA, and publish flow. Importing the package threw a "stub, not functional yet" error.

## 0.0.1 - 2026-07-19

### Added

- Initial name-reserving stub. Published to npm and unpublished the same day (metadata correction); superseded by `0.0.2`. Per npm policy the version number remains permanently unusable.

[0.2.0]: https://github.com/charlesjones-dev/a11yhawk/releases/tag/v0.2.0
[0.1.4]: https://github.com/charlesjones-dev/a11yhawk/releases/tag/v0.1.4
[0.1.3]: https://github.com/charlesjones-dev/a11yhawk/releases/tag/v0.1.3
[0.1.2]: https://github.com/charlesjones-dev/a11yhawk/releases/tag/v0.1.2
[0.1.1]: https://github.com/charlesjones-dev/a11yhawk/releases/tag/v0.1.1
[0.1.0]: https://github.com/charlesjones-dev/a11yhawk/releases/tag/v0.1.0
