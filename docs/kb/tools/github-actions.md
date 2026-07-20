---
tags: [ci, github-actions, debugging]
related: [[releases-and-publishing]]
created: 2026-07-20
last-updated: 2026-07-20
pinned: false
scope: ['.github/workflows/**']
---

# GitHub Actions Debugging

Lessons from debugging this repo's first CI runs, which happened to coincide with a GitHub Actions platform incident.

## Key Rules

- A `startup_failure` run attached to a phantom workflow named "BuildFailed" (state `deleted`, matching no real workflow id), or pushes that produce no run at all while workflows show as registered and active, are GitHub-side symptoms. Check https://www.githubstatus.com/api/v2/summary.json before debugging workflow config.
- Push events dropped during an Actions incident are never replayed after recovery. Re-trigger with a new push (empty commit is fine).
- `gh run list` immediately after a push can return nothing; poll for the run id (matching the head SHA) before calling `gh run watch`. Startup-failure runs cannot be re-run via `gh run rerun`, and the check-suite rerequest API returns 404 for Actions suites.

## Related

- [[releases-and-publishing]]
