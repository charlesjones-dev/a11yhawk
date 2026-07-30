---
tags: [index, meta]
created: 2026-07-20
last-updated: 2026-07-29
pinned: true
---

# Knowledge Base Index

Auto-generated catalog of all KB articles. Updated by `/kb-*` commands. Read this file first to find relevant pages before drilling into individual articles.

## All Pages

| Page | Summary | Tags | Scope | Last Updated |
|------|---------|------|-------|-------------|
| [[_global-learnings]] | Cross-cutting rules that apply everywhere | global, cross-cutting | _(pinned)_ | 2026-07-20 |
| [[engine/lighthouse]] | Lighthouse stage design decisions (v0.2.0): dual savings formats, LHR trim, deliberate perf-run serialization, accessibility-required rule, screenshot:false constraint, browser lifecycle | lighthouse, performance, bulk-mode | `src/engine/lighthouse.ts`, `src/engine/scan.ts` | 2026-07-29 |
| [[tools/dependency-audit]] | Accepted npm audit findings (lighthouse -> Sentry -> OTel, GHSA-8988-4f7v-96qf) and the `audit fix --force` downgrade trap | dependencies, security, npm-audit | `package.json`, `package-lock.json` | 2026-07-20 |
| [[tools/github-actions]] | Platform-incident symptoms (phantom BuildFailed, dropped pushes) and gh CLI polling patterns | ci, github-actions, debugging | `.github/workflows/**` | 2026-07-20 |
| [[tools/releases-and-publishing]] | npm unpublish ordering and 24h name lock, security-key TTY requirement, trusted-publisher environment matching, GHCR visibility check, intentional attw ESM warning | release, npm, publishing, ghcr, versioning | `.github/workflows/**`, `Dockerfile`, `CHANGELOG.md` | 2026-07-20 |
| [[tools/vitest]] | Vitest v4 swallows console.log from passing tests (use process.stderr.write), opt-in soak-test pattern via describe.runIf, soak invocation and time budget | testing, vitest, soak | `**/*.test.ts`, `vitest.config.ts` | 2026-07-29 |
