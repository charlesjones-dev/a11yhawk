---
tags: [release, npm, publishing, ghcr, versioning]
related: [[github-actions]]
created: 2026-07-20
last-updated: 2026-07-20
pinned: false
scope: ['.github/workflows/**', 'Dockerfile', 'CHANGELOG.md']
---

# Releases and Publishing

Operational lessons for publishing a11yhawk to npm and GHCR, learned during the 0.0.x/0.1.0 releases. CLAUDE.md's Releases section covers the mechanics (tag-triggered workflow, provenance, Dockerfile/Playwright coupling); this article covers the traps.

## Key Rules

- When replacing a bad published version, publish the corrected version FIRST, then unpublish the bad one. Unpublishing a package's only version removes the entire package and locks the name against republishing for 24 hours.
- Unpublished version numbers are burned permanently by npm policy. `a11yhawk@0.0.1` can never be reused (published and unpublished 2026-07-19).
- Manual `npm publish` with security-key 2FA requires a real TTY for the browser auth flow. Non-TTY shells (including Claude Code's bash and the `!` prefix) fail with EOTP; the user must run it in their own terminal.
- The npm trusted-publisher config's "Environment name" field must exactly match the workflow's `environment:` declaration. Our `release.yml` declares none, so the field must stay blank; setting it breaks the OIDC handshake.
- After a first GHCR push, verify anonymous pullability with `docker manifest inspect ghcr.io/charlesjones-dev/a11yhawk:<tag>`. Packages pushed via `GITHUB_TOKEN` can default to private; ours came up public, but verify rather than assume.
- `arethetypeswrong` reports `CJSResolvesToESM` for this package. That is the intentional ESM-only posture (documented in the README), not a defect. `publint` should stay fully clean.

## Related

- [[github-actions]]
