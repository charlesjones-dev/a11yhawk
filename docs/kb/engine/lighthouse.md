---
tags: [lighthouse, performance, bulk-mode]
related: []
created: 2026-07-29
last-updated: 2026-07-29
pinned: false
scope: ['src/engine/lighthouse.ts', 'src/engine/scan.ts']
---

# Lighthouse Stage & Bulk Mode

Design decisions behind the Lighthouse category/performance surface (v0.2.0) and bulk-scanning behavior. Most of these are deliberate constraints; do not "fix" them without revisiting the rationale.

## Key Rules

- Lighthouse savings estimates come in two formats and extraction must handle both: legacy opportunity audits report `details.overallSavingsMs` / `details.overallSavingsBytes`; Lighthouse 13 insight audits instead report per-metric `metricSavings` (e.g. `{ FCP: 900, LCP: 150 }`), of which `extractPerformanceFromLhr` takes the max as the headline ms figure.
- LHR size is dominated by `fullPageScreenshot`, the `screenshot-thumbnails` / `final-screenshot` audits, and `i18n`. `trimLhrForOutput` strips exactly these before `includeRaw` attaches the LHR to a report (trimmed ≈ 112 KB vs multi-MB raw); keep the trim if new payload-heavy fields appear in future Lighthouse versions.
- Performance-category runs are deliberately serialized inside `LighthouseService` (the `performanceRunChain` promise chain), regardless of `setConcurrency(n)`: parallel traces on one machine contend for CPU and skew FCP/LCP/TBT. Do not remove the serialization for throughput. Perf runs also get a 60s timeout floor vs the 30s accessibility-only default.
- `lighthouse.categories` must include `'accessibility'` by design: it is the analysis source for the structured report (and the sole source in Lighthouse-only mode). The rule lives once in `resolveLighthouseConfig` (`scan.ts`), which the server sanitizer imports so a bad list 400s at request time instead of failing the job later. Keep that single home.
- `screenshot: false` is valid only in Lighthouse-only mode and throws `invalid-options` with `llm`: the prompt builder in `prompts.ts` hardcodes a "Visual Analysis (Screenshot)" section that assumes a screenshot exists. Allowing text-only LLM scans would need deliberate prompt changes first.
- Browser lifecycle reality: `PlaywrightService` closes Chromium whenever the scan refcount hits 0, so purely sequential scans relaunch the browser every scan. That is deliberate (returns Chromium's native memory to the OS between scans); only overlapping scans share a warm browser. Bulk consumers wanting a warm browser must overlap scans, not just reuse the engine.
- Performance results stay off `StructuredScanOutput` (they live on `report.lighthouse.performance`): the structured shape is the AccessHawk persistence contract and remains accessibility-only.
- A timed-out Lighthouse child gets SIGTERM, then SIGKILL after a 5s grace period (`KILL_GRACE_MS`); without the escalation, long-lived hosts accumulated the risk of zombie audit subprocesses.
