---
name: comind-sync
description: Rebuild the knowledge graph incrementally and regenerate the .ai-memory Obsidian vault from .planning. Run after pulling teammates' changes or finishing a phase.
---

# /comind-sync

The routine command. Run it after `git pull`, after shipping a phase, or whenever
`.ai-memory/` looks stale.

## Step 1 — Incremental graph rebuild

```
/gsd-graphify build
```

Incremental: only new and changed files are re-extracted. If it reports the graph is fresh,
skip to Step 2 without rebuilding.

Check freshness first when unsure:

```
/gsd-graphify status
```

## Step 2 — Regenerate the vault

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/comind.js" sync
```

This rewrites `.ai-memory/` from `.planning/`, writing only files whose content actually
changed and pruning notes whose source disappeared. Hand-added notes without CoMind's
generated stamp are left alone.

## Step 3 — Report the diff

```bash
git status --porcelain .ai-memory .planning
```

Summarize in at most three lines: how many notes changed, which phases moved status, whether
the graph grew. If nothing changed, say `Vault current.` and stop.

## Step 4 — Surface what the graph learned

If the rebuild added communities or god nodes, name the single most interesting new
connection and offer to trace it:

```
/gsd-graphify query "<the question that crosses the most community boundaries>"
```

One offer. Do not list every suggested question.

## Notes

- Never hand-edit `.ai-memory/` — the gate hook blocks it, without bypass.
- `graphify-out/` and `.planning/graphs/*.json` stay out of context. Query, don't read.
  They are committed so a clone can query them, which is not the same as readable:
  `permissions.deny` refuses them either way.
- Sync re-renders `graphify-out/graph.html` from the committed graph. That is a local
  render with no model call — it is why the HTML is the one graph artifact not committed.
  A report that it was skipped is informational; the vault still regenerated.
- If `sync` reports `.planning/ not found`, this repo has not been set up: run `/comind-init`.
