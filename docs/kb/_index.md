---
tags: [index, meta]
created: 2026-07-20
last-updated: 2026-10-08
pinned: true
---

# Knowledge Base Index

Auto-generated catalog of all KB articles. Updated by `/kb-*` commands. Read this file first to find relevant pages before drilling into individual articles.

## All Pages

| Page | Summary | Tags | Scope | Last Updated |
|------|---------|------|-------|-------------|
| [[_global-learnings]] | Cross-cutting rules that apply everywhere | global, cross-cutting | _(pinned)_ | 2026-10-08 |
| [[engine/lighthouse]] | Lighthouse stage design decisions (v0.2.0): dual savings formats, LHR trim, deliberate perf-run serialization, accessibility-required rule, screenshot:false constraint, browser lifecycle | lighthouse, performance, bulk-mode | `src/engine/lighthouse.ts`, `src/engine/scan.ts` | 2026-07-29 |
| [[engine/llm-providers]] | LLM stage providers (v0.7.0): OpenRouter contract, Anthropic SDK env isolation (`ANTHROPIC_CUSTOM_HEADERS`), guarded fetch, header-only SDK timeout, fallback usage iterations, billing error shapes, tile size, test and live-check patterns | llm, anthropic, openrouter, sdk, ssrf, pricing | `src/engine/llm.ts`, `src/engine/llm*.test.ts`, `src/engine/request-guard.ts` | 2026-10-08 |
| [[tools/dependency-audit]] | Accepted npm audit findings (lighthouse -> Sentry -> OTel, GHSA-8988-4f7v-96qf), the `audit fix --force` downgrade trap, 3-day release-age rule for new ranges, transitive-count check | dependencies, security, npm-audit, versioning | `package.json`, `package-lock.json` | 2026-10-08 |
| [[tools/github-actions]] | Platform-incident symptoms (phantom BuildFailed, dropped pushes) and gh CLI polling patterns | ci, github-actions, debugging | `.github/workflows/**` | 2026-07-20 |
| [[tools/releases-and-publishing]] | npm unpublish ordering and 24h name lock, trusted-publisher environment matching, GHCR visibility check, intentional attw ESM warning | release, npm, publishing, ghcr, versioning | `.github/workflows/**`, `Dockerfile`, `CHANGELOG.md` | 2026-10-08 |
| [[tools/vitest]] | Vitest v4 swallows console.log from passing tests (use process.stderr.write), opt-in soak-test pattern via describe.runIf, soak invocation and time budget | testing, vitest, soak | `**/*.test.ts`, `vitest.config.ts` | 2026-10-08 |
