---
tags: [dependencies, security, npm-audit, versioning]
related: [[releases-and-publishing]], [[llm-providers]]
created: 2026-07-20
last-updated: 2026-10-08
pinned: false
scope: ['package.json', 'package-lock.json']
---

# Dependency Audits

Accepted `npm audit` findings and rules for handling them in this repo.

## Key Rules

- Never run `npm audit fix --force` here: its only "fix" is downgrading `lighthouse` 13.x to 12.6.1, a breaking downgrade. Plain `npm audit fix` is a no-op for the known findings.
- Accepted (2026-07-20): 17 moderate findings with one root cause: `lighthouse@13.4.0 -> @sentry/node@9.x -> @opentelemetry/core@1.30.1`, GHSA-8988-4f7v-96qf (unbounded memory allocation in W3C Baggage propagation). Exposure is negligible: Sentry inside Lighthouse is opt-in error reporting this engine never enables, so the vulnerable OTel path is not exercised.
- The acceptance clears when Lighthouse ships `@sentry/node` >= 10.54. After any Lighthouse bump, re-check with `npm ls @opentelemetry/core`.
- Do not add an npm `overrides` entry forcing a newer `@sentry/node`: it jumps a major version against Lighthouse's declared range, untested.
- Pick runtime dependency ranges whose lowest version is at least 3 days old (check `npm view <pkg> time`), since consumers may enforce a minimum release age; use a newer one only when the user approves it. A caret range on 0.x pins the minor (`^0.131.0` is 0.131.x only).
- Before adding a runtime dependency, count its transitive packages with a throwaway install (`npm install <pkg> --ignore-scripts` in a temp dir, then `npm ls --all`) and justify it in the PR and CHANGELOG: a low dependency count is a product feature here.
- Before bumping `@anthropic-ai/sdk`, read `node_modules/@anthropic-ai/sdk/CHANGELOG.md` and re-check the SDK internals the engine relies on (see [[llm-providers]]).

## Related

- [[releases-and-publishing]]
- [[llm-providers]]
