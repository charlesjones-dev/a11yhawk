# Knowledge Base

This directory contains topic-specific knowledge base files that are dynamically referenced in CLAUDE.md.

## Structure

KB articles are organized in category folders. Special files (prefixed with `_`) live at the root:

```
docs/kb/
  _global-learnings.md   # Cross-cutting rules (pinned, always loaded)
  _index.md              # Auto-generated page catalog with summaries
  _log.md                # Chronological operation log
  README.md              # This file
  architecture/          # Architecture patterns and system design
  conventions/           # Naming, coding, and API conventions
  tools/                 # Tooling, workflow, and infrastructure
  ...                    # Other categories as needed
```

Category folders are created as needed based on article content. Articles can also be flat at the root for small KBs:

## Frontmatter Schema

Every KB file MUST include YAML frontmatter. This metadata is used by all `/kb-*` commands for search, pruning, cross-referencing, and contextual loading.

```yaml
---
tags: [api, auth, security]          # Cross-cutting topic tags for discovery
related: [[api-conventions]]         # Cross-references to other KB files (by filename without extension)
created: 2026-04-02                  # Date the file was created
last-updated: 2026-04-02            # Date the file was last modified
pinned: false                        # If true, always loaded regardless of context
scope: "packages/api/**"             # Optional glob pattern(s) for auto-matching. String or array of strings.
---
```

### Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `tags` | Yes | Array of lowercase tags for cross-cutting discovery. Used by `/kb-search`. |
| `related` | No | Array of `[[filename]]` references to other KB files. When one file is loaded, related files may also be consulted. |
| `created` | Yes | ISO date (YYYY-MM-DD) when the file was first created. |
| `last-updated` | Yes | ISO date (YYYY-MM-DD) when the file was last modified. Updated automatically by KB commands. |
| `pinned` | No | Boolean. When `true`, this file is always loaded at the start of every conversation. Default: `false`. Use sparingly. |
| `scope` | No | Glob pattern(s) matching file paths where this knowledge applies. Can be a single string (`"src/api/**"`) or an array of strings (`["src/api/**", "*.controller.ts"]`). These patterns are surfaced in the CLAUDE.md table's "When to Load" column for efficient context matching. |

## File Format

Each KB file should follow this structure:

```markdown
---
tags: [topic-tag]
related: [[other-kb-file]]
created: YYYY-MM-DD
last-updated: YYYY-MM-DD
pinned: false
scope: []                            # String or array of glob patterns for auto-matching
---

# Topic Name

Brief description of what this KB covers and when it applies.

## Key Rules

- Rule or learning (concise, actionable, imperative voice)
- Another rule or learning

## Context

Any additional context that helps Claude Code apply these rules correctly.

## Related

- [[other-kb-file]]
```

**Important**: The `## Related` section at the bottom mirrors the `related` frontmatter field using `[[wiki-links]]` in the body text. This enables Obsidian graph view and link navigation (Obsidian does not parse frontmatter values as navigable links). Both the frontmatter and body section must be kept in sync. Omit the `## Related` section if there are no related files.

## Usage

KB files are referenced in CLAUDE.md's Knowledge Base table. Claude Code reads the relevant KB files when working on matching areas of the codebase.

### Commands

- `/kb-learn` - Analyze the current conversation and extract learnings to KB files
- `/kb-add` - Quickly add a learning or rule with interactive location picker
- `/kb-import` - Register existing KB files in CLAUDE.md (adds missing frontmatter)
- `/kb-ingest` - Ingest specific markdown files from anywhere in the project into the KB
- `/kb-harvest` - Harvest knowledge from external sources: sibling repos, directories, files, or web URLs
- `/kb-discover` - Analyze source code to extract implicit knowledge into KB articles
- `/kb-absorb` - Migrate existing CLAUDE.md sections and docs/ content into the KB
- `/kb-remove` - Remove a KB file and its CLAUDE.md reference
- `/kb-list` - List all registered KB files with status, tags, dates, and cross-references
- `/kb-load` - Manually load a KB file into the current conversation by name, topic, or tag
- `/kb-search` - Search across KB files by keyword, topic, or tag (`tag:security`)
- `/kb-prune` - Interactive cleanup: stale refs, duplicates, merges, frontmatter health
- `/kb-query` - Query the KB and synthesize answers (optionally filed back as articles)
- `/kb-auto` - Toggle automatic knowledge capture at end of conversations
- `/kb-organize` - Reorganize flat KB files into category folders
- `/kb-upgrade` - Upgrade KB to latest practices (Obsidian compat, structured loading, preamble)
