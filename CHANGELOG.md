# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Pre-1.0 versioning.** While a11yhawk is in `0.x`, the public API is still stabilizing: breaking changes may ride minor version bumps (for example `0.1.0` to `0.2.0`) up until `1.0.0`. Patch releases (`0.1.0` to `0.1.1`) stay backward compatible. If you depend on the API surface, pin a minor range. `1.0.0` ships once the API has stabilized against real adoption.

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

[0.1.0]: https://github.com/charlesjones-dev/a11yhawk/releases/tag/v0.1.0
