# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run verify        # The full gate: lint + typecheck + test + build. Must pass before any PR/release.
npm run test:run      # All tests once
npx vitest run src/engine/sanitizers.test.ts   # Single test file
npm run build         # tsc -p tsconfig.build.json (excludes tests from dist/)
npm run format        # Prettier write (format:check runs in CI)
npx playwright install chromium                # One-time browser download; needed for any real scan
```

Examples (`examples/*.mjs`) import the package by its own name, which resolves through `exports` to `dist/`, so run `npm run build` before `node examples/local-fixture.mjs`. That fixture demo is the fastest full-pipeline smoke test: no API key, no external network.

When checking test or verify results in scripts, check the process exit code, not printed pass counts.

## What this is

A11yHawk is a self-hostable web accessibility scan engine: Playwright page capture + Lighthouse audit + optional BYOK LLM analysis, producing structured JSON, markdown, and a self-contained HTML report. One core engine with three thin consumption modes: library (`src/index.ts` exports), CLI (`src/cli/`), and HTTP server (`src/server/`).

It was extracted from the private `accesshawk-nuxt` monorepo's worker (expected as a sibling checkout at `../accesshawk-nuxt`); this repo is now the source of truth for the pipeline, and the AccessHawk worker will eventually consume this package. That drives a hard compatibility contract: the result interfaces in `src/types.ts` (`StructuredScanOutput`, `AccessibilityIssue`, etc.) are intentionally shape-identical to AccessHawk's persisted scan format. Keep changes to them additive.

`docs/` is deliberately gitignored except for `docs/kb/` (`.gitignore`: `docs/*` then `!docs/kb/`). The ignored part holds local planning docs (including the AccessHawk integration prompt) that reference the private monorepo and must not be published; `docs/kb/` is the tracked knowledge base and is committed normally. Never put private-monorepo details in `docs/kb/`.

## Architecture

`src/engine/scan.ts` is the orchestrator. `A11yHawkEngine.scan()` runs: validate URL -> Playwright capture (`playwright.ts`: screenshot tiled to the LLM provider's image limits, CDP accessibility tree, HTML) -> Lighthouse audit (`lighthouse.ts`: subprocess, accessibility-only, reuses the browser via CDP port) -> LLM analysis (`llm.ts` + `prompts.ts`: OpenAI SDK against any OpenAI-compatible endpoint, OpenRouter default) -> parse and recompute -> markdown (`markdown-generator.ts`) -> screenshot annotation (`annotator.ts`).

Mode split: when `ScanOptions.llm` is present, Lighthouse failure is non-blocking (findings just enrich the prompt); when omitted (Lighthouse-only mode), Lighthouse is the sole analysis source and its failure is fatal, with `buildStructuredFromLighthouse` mapping severities (critical/serious/moderate/minor -> critical/high/medium/low). Annotation failure never fails a scan.

Options are split by lifetime: `EngineOptions` (browser posture: `allowPrivateNetworks`, sandbox, logger) are fixed at engine construction; `ScanOptions` vary per scan. The one-shot `scan()` accepts both. All failures are `ScanError` with a `code` and a `retryable` flag so queue-based hosts can map onto retry semantics.

`PlaywrightService` keeps one browser warm, recycles it after N pages, and bounds concurrency with a promise queue; the pipeline explicitly nulls large buffers (tiles, HTML, a11y tree) between steps. Do not hold references to them across step boundaries.

## Security invariants (do not weaken)

- **The engine never reads `process.env`.** Env is read only in `src/cli/` (`A11YHAWK_*` fallbacks), `src/server/serve.ts` (`runServe` only), and the logger. Everything else takes explicit options.
- **SSRF request guard** (`engine/request-guard.ts`): installed on the browser context, per-request DNS re-checks, redirect-hop detection, service workers blocked. `allowPrivateNetworks` widens accepted addresses but never disables the rest. In server mode it is env-only; request bodies pass a strict allowlist that strips it (`sanitize*` in `serve.ts`), and submitted API keys are redacted from the job store and never echoed.
- **Lighthouse subprocess** (`engine/lighthouse.ts`): always `shell: false` with argv arrays; the scan URL is attacker-controlled and must never reach a shell. The CLI path is resolved via `createRequire` from the installed `lighthouse` package, never a relative `node_modules/.bin` path (breaks under pnpm/npx and is a hijack risk). Residual known gap: Lighthouse drives its own navigation outside the request guard; the target is re-validated immediately before the run.
- **LLM errors** (`engine/llm.ts`): messages are sanitized to strip API keys, and the raw provider error is deliberately NOT chained as `cause` (the `eslint-disable preserve-caught-error` comments there are intentional; do not "fix" them).
- **HTML report** (`engine/html-report.ts`): every interpolated value goes through `escapeHtml`; scanned-page content is untrusted and must not be able to inject markup into its own report. The report must itself pass accessibility checks (WCAG AA contrast, landmarks, keyboard operability).
- Scores and statistics are always recomputed from the actual issues/coverage in `parseStructuredOutput`, never trusted from the model.

Changes to `request-guard.ts`, `url-validator.ts`, or the Lighthouse spawn get extra scrutiny per the PR template.

## Conventions

- ESM-only, TypeScript strict with `noUncheckedIndexedAccess`, `NodeNext` resolution (imports use `.js` extensions). Tests are colocated `*.test.ts`; `tsconfig.build.json` keeps them out of `dist/`.
- Branding: "A11yHawk" in prose, UI strings, and docs; lowercase `a11yhawk` for the package name, commands, URLs, and technical identifiers. The `a11yhawk:resolved:` localStorage key in the HTML report is a persistence contract; never rename it.
- The default LLM model lives in `DEFAULT_MODEL` (`engine/scan.ts`).

## Releases

Pushing a `v*` tag triggers `.github/workflows/release.yml`: verify -> npm publish via trusted publishing (OIDC + provenance, no tokens anywhere) -> Docker image to GHCR. The Dockerfile's base image tag must match the installed `playwright` version. `prepublishOnly` runs the full verify. While 0.x, breaking API changes may ride minor bumps (documented in CHANGELOG.md); 1.0.0 is reserved until the API has stabilized against real adoption.

## Development Principles

Follow SOLID, DRY, KISS, and YAGNI in all code changes:

### SOLID

- **Single Responsibility**: Each `src/engine/` module owns exactly one pipeline stage (capture, guard, audit, LLM, parse, report, annotate). `engine/scan.ts` is the only orchestrator; never add cross-stage coordination inside a stage module.
- **Open/Closed**: Add capabilities as new modules the way `html-report.ts`, `src/cli/`, and `src/server/` were added - consuming the engine's public surface, not modifying engine internals.
- **Liskov Substitution**: Anything satisfying `EngineLike` (`src/server/serve.ts`) must behave like `A11yHawkEngine`; test fakes included.
- **Interface Segregation**: Keep the `EngineOptions` / `ScanOptions` split (construction-time posture vs per-scan settings). Don't grow either into a catch-all options bag; a new option belongs to exactly one lifetime.
- **Dependency Inversion**: Depend on `Logger` and the types in `src/types.ts`, not concrete implementations. The server depends on `EngineLike`, never on the concrete engine class directly.

### DRY / Code Reuse

- `src/types.ts` is the single home for public data shapes; never re-declare them locally.
- WCAG reference data lives only in the `engine/prompts.ts` criteria tables and `engine/wcag/`; never inline criterion lists elsewhere.
- Cross-cutting helpers (severity mappings, `escapeHtml`, URL validation) are imported from their owning module, never copied.

### KISS / Simplicity

- The near-zero dependency count is a product feature (corporate vetting). CLI parsing is `node:util` `parseArgs`, the server is bare `node:http`; adding any runtime dependency needs strong justification.
- Prefer plain types over clever generics; three similar lines beat a premature abstraction.

### YAGNI / Scope Discipline

- Only implement what is requested or on the README roadmap when scheduled. Suggesting extras is fine; ask before building them.
- Do not add options without a real consumer (a per-scan `timeouts` option was deliberately cut from v1 for exactly this reason).

## Knowledge Base

Topic-specific knowledge is stored in `docs/kb/` and loaded contextually based on the table below.

**How to use the "When to Load" column:**

1. **Pinned entries** (`Always (pinned)`): Load at the start of every conversation.
2. **Scope patterns** (backtick-wrapped globs like `src/api/**`): Load when the files you are editing or creating match any of the listed glob patterns.
3. **Keywords** (after the `—` dash): Load when the current task involves these topics, even if no file path matches.
4. **When uncertain**: Read `docs/kb/_index.md` (pinned) for article summaries and scope patterns to help decide.

**Loading notifications**: When you load a KB file, briefly notify the user so they know what context is being applied. Example: `📖 Loading KB: api-conventions.md`. Keep notifications to a single line per file.

When a KB file's frontmatter contains `related: [[other-file]]` cross-references, also read the related file(s) for full context.

| Topic                 | File                                     | When to Load                                                                         |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------ |
| Dependency Audits     | docs/kb/tools/dependency-audit.md        | `package.json`, `package-lock.json` — audit, vulnerabilities, dependencies, security |
| GitHub Actions        | docs/kb/tools/github-actions.md          | `.github/workflows/**` — ci, actions, debugging                                      |
| Global Learnings      | docs/kb/_global-learnings.md             | Always (pinned)                                                                      |
| KB Index              | docs/kb/_index.md                        | Always (pinned)                                                                      |
| Releases & Publishing | docs/kb/tools/releases-and-publishing.md | `.github/workflows/**`, `Dockerfile` — release, publish, npm, ghcr, versioning       |

<!-- kb-auto: enabled -->

> **Auto-capture enabled**: At the end of each conversation, or when significant institutional knowledge, corrections, or best practices have been shared, proactively offer to run `/kb-learn` to capture learnings. Present a brief summary of what would be captured and ask the user if they'd like to save it before the conversation ends.

## PR and Commit Hygiene

<!-- workflow-rules:id=pr-scope-current-session -->

### PR/commit descriptions cover only current-session changes

- Describe ONLY what changed in the commits authored in the current session. Do not describe prior commits on the branch, even if the PR will include them. If the branch carries unrelated prior commits, mention that in one line ("Branch also carries N prior commits not from this session") and stop — do not summarize them.

<!-- /workflow-rules:id=pr-scope-current-session -->

<!-- workflow-rules:id=no-fabricated-test-plans -->

### Don't invent test plans

- Do not invent test plans, checklists, or verification steps that were not actually performed. If no testing was done, omit the test plan section entirely, or write a single line like "Not tested locally" with one sentence on what would need verification.

<!-- /workflow-rules:id=no-fabricated-test-plans -->

<!-- workflow-rules:id=no-speculative-deploy-steps -->

### Don't add speculative deploy/rollout steps

- Do not add speculative deploy, rollout, or post-merge steps unless asked.

<!-- /workflow-rules:id=no-speculative-deploy-steps -->

<!-- workflow-rules:id=short-pr-bodies -->

### Keep PR bodies short

- Keep PR bodies short. A 1-3 bullet summary of the actual diff is usually enough. No filler sections, no headers for the sake of structure.

<!-- /workflow-rules:id=short-pr-bodies -->

<!-- workflow-rules:id=scoped-commit-messages -->

### Scope commit messages to the diff

- Commit messages: describe what the diff does, not surrounding context, future plans, or unrelated work.

<!-- /workflow-rules:id=scoped-commit-messages -->

<!-- workflow-rules:id=no-generated-by-footers -->

### Don't add "Generated with Claude Code" footers

- Never add boilerplate footers (e.g. "Generated with Claude Code") to PR bodies or commit messages unless explicitly requested.

<!-- /workflow-rules:id=no-generated-by-footers -->

## Scope Discipline

<!-- workflow-rules:id=no-unrequested-features -->

### Don't add features beyond what was requested

- Don't add features, refactor, or introduce abstractions beyond what the task requires. A bug fix doesn't need surrounding cleanup; a one-shot operation doesn't need a helper.

<!-- /workflow-rules:id=no-unrequested-features -->

<!-- workflow-rules:id=confirm-risky-actions -->

### Confirm before risky or shared-state actions

- For destructive, hard-to-reverse, or shared-state actions (force pushes, branch deletes, dependency removal, posting to chat platforms), confirm with the user before acting unless explicitly authorized in advance.

<!-- /workflow-rules:id=confirm-risky-actions -->

## Communication Style

<!-- workflow-rules:id=no-internal-narration -->

### Don't narrate internal deliberation

- Don't narrate internal deliberation in user-facing text. State results and decisions directly. Brief sentence-level updates are fine; running commentary is not.

<!-- /workflow-rules:id=no-internal-narration -->

<!-- workflow-rules:id=match-response-to-task -->

### Match response length to task complexity

- Match response length to the task. A simple question gets a direct answer, not headers and sections.

<!-- /workflow-rules:id=match-response-to-task -->
