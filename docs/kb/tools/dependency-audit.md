---
tags: [dependencies, security, npm-audit]
related: [[releases-and-publishing]]
created: 2026-07-20
last-updated: 2026-07-20
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

## Related

- [[releases-and-publishing]]
