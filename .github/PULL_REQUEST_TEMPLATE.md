## What and why

<!-- What does this change do, and what problem does it solve? Link any related issue. -->

## Checklist

- [ ] `npm run verify` passes locally (lint, typecheck, tests, build).
- [ ] Tests added or updated for behavior changes.

## Security-sensitive changes

Changes to the **request guard**, **URL validator**, or **Lighthouse spawn** get extra scrutiny and **must not weaken the default security posture**: the SSRF guard stays default-on, `allowPrivateNetworks` stays `false` by default, and the Lighthouse spawn stays `shell: false`. If this PR touches any of them, describe the change and explain why it is safe.

<!-- If none of the above applies, you can leave this section as-is. -->
