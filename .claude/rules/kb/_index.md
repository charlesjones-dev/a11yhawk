---
tags: [index, meta]
created: 2026-10-12
last-updated: 2026-10-12
---

# Knowledge base

This project keeps team knowledge in `.claude/rules/kb/` and `.claude/kb/`. Pinned articles in `.claude/rules/kb/` load in every session. The articles listed below don't:

- When a task involves an article's keywords, read it before you start, unless it's already in your context, and say so in one line: `📖 Reading KB: tools/deployment.md`.
- An article marked "loads with" also loads by itself when you read or edit a file matching those globs. Claude Code adds it as a system reminder that begins `Contents of` followed by the article's path under `.claude/rules/kb/`. The first time each one arrives that way, tell the user on its own line in your reply, even though it came from a system reminder: `📖 Loaded KB: conventions/api.md` (the path after `.claude/rules/kb/`). Pinned articles get no notice.
- If an article's Related section lists others that bear on the task, read those too.

## Articles

- `.claude/rules/kb/engine/lighthouse.md`: Lighthouse stage design decisions (v0.2.0): dual savings formats, LHR trim, deliberate perf-run serialization, accessibility-required rule, screenshot:false constraint, browser lifecycle (lighthouse, performance, bulk-mode; loads with src/engine/lighthouse.ts, src/engine/scan.ts)
- `.claude/rules/kb/engine/llm-providers.md`: LLM stage providers (v0.7.0): OpenRouter contract, Anthropic SDK env isolation, guarded fetch, header-only SDK timeout, fallback usage iterations, billing error shapes, tile size, test and live-check patterns (llm, anthropic, openrouter, sdk, ssrf, pricing; loads with src/engine/llm.ts, src/engine/llm*.test.ts, src/engine/request-guard.ts)
- `.claude/rules/kb/tools/dependency-audit.md`: accepted npm audit findings (lighthouse -> Sentry -> OTel), the `audit fix --force` downgrade trap, 3-day release-age rule for new ranges, transitive-count check (dependencies, security, npm-audit, versioning, audit, vulnerabilities; loads with package.json, package-lock.json)
- `.claude/rules/kb/tools/github-actions.md`: platform-incident symptoms (phantom BuildFailed, dropped pushes) and gh CLI polling patterns (ci, github-actions, debugging, actions; loads with .github/workflows/**)
- `.claude/rules/kb/tools/releases-and-publishing.md`: npm unpublish ordering and 24h name lock, trusted-publisher environment matching, GHCR visibility check, intentional attw ESM warning (release, npm, publishing, ghcr, versioning, publish; loads with .github/workflows/**, Dockerfile, CHANGELOG.md)
- `.claude/rules/kb/tools/vitest.md`: Vitest v4 swallows console.log from passing tests, opt-in soak-test pattern via describe.runIf, soak invocation and time budget (testing, vitest, soak; loads with **/*.test.ts, vitest.config.ts)
