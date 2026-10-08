---
tags: [testing, vitest, soak]
related: [[llm-providers]]
created: 2026-07-29
last-updated: 2026-10-08
pinned: false
scope: ['**/*.test.ts', 'vitest.config.ts']
---

# Vitest

Gotchas and patterns for this repo's Vitest (v4) test suite, including the opt-in soak test.

## Key Rules

- Vitest v4 swallows `console.log` output from passing tests, even with `--silent=false`. Test telemetry that must reach the person running the test (progress lines, measured numbers) needs `process.stderr.write` instead. This bit the soak test's memory/handle telemetry, which passed silently three times before the numbers became visible.
- Pattern for opt-in long-running tests: gate the suite with `describe.runIf(process.env.FLAG === '1')` in a colocated `*.soak.test.ts` file. The default `npm run verify` reports it as skipped at zero cost, and the existing `src/**/*.test.ts` exclude in `tsconfig.build.json` keeps it out of `dist/` with no extra config.
- The bulk-mode soak test is run with `A11YHAWK_SOAK=1 A11YHAWK_SOAK_SCANS=1000 NODE_OPTIONS=--expose-gc npx vitest run src/engine/scan.soak.test.ts` (tune the scan count; `A11YHAWK_SOAK_PERF=1` adds the performance category). Without `--expose-gc` it still runs but falls back to a much looser memory bound, since V8 may simply not have collected yet.
- Budget roughly 10-15s of wall clock per soak scan (browser relaunch + settle waits + Lighthouse subprocess); a 1,000-scan soak is a multi-hour run.

## Related

- [[llm-providers]]
