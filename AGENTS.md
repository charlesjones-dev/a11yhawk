<!-- ai-knowledge:start -->

## Team knowledge base

This project keeps its team knowledge base in `.claude/`. Claude Code loads it by itself. Other agents, read it like this:

- At the start of a task, read `.claude/rules/kb/_index.md`, plus every article under `.claude/rules/kb/` whose frontmatter has no `paths` (such as `_global-learnings.md`).
- Before you read or change a file, check the `paths` globs in the frontmatter of the other articles under `.claude/rules/kb/`, and read each article whose globs match that file.
- When a task matches a line in `_index.md`, read the article that line names.

Follow these articles the way you follow the rest of this file.
<!-- ai-knowledge:end -->
