# Knowledge base

This is the project's team knowledge base. Claude Code loads it on its own; the ai-knowledge plugin adds the `/kb-*` commands that write and maintain it.

- `.claude/rules/kb/` holds articles Claude Code loads by itself. An article with `paths` frontmatter loads when Claude reads or edits a matching file. One without `paths`, such as `_global-learnings.md`, loads in every session. `_index.md` lists every article that isn't pinned, with its keywords, so Claude can also read one when a task matches.
- `.claude/kb/` holds on-demand articles, which Claude reads when a task matches their line in `_index.md`, plus this README and `_log.md`.

Keep secrets out of every article: this folder is committed and shared.

Commands: `/kb-add`, `/kb-learn`, `/kb-discover`, `/kb-query`, `/kb-prune`.
