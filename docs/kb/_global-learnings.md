---
tags: [global, cross-cutting]
related: []
created: 2026-07-20
last-updated: 2026-07-20
pinned: true
---

# Global Learnings

Cross-cutting rules and insights that apply across the entire project.

## Key Rules

- Never name a zsh shell variable `status`; it is a read-only builtin and the assignment kills the script ("read-only variable: status"). This bit both an inline script and a background Monitor loop in one session. Use `st` or `code` instead.
- Check process exit codes, not printed output. `cmd 2>&1 | tail; echo $?` reports tail's exit status, not cmd's; a failing `npm run verify` was masked this way once. Use zsh's `$pipestatus[1]`, or run the command unpiped and capture `$?` directly.
- CI's `format:check` (Prettier) gates every committed file, including CLAUDE.md and markdown docs. Run `npm run format` after editing any markdown before committing; an unformatted CLAUDE.md (unaligned tables, missing blank lines around HTML comments) failed CI once.
