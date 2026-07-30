# .ai-memory: the shared brain

**Everything here is generated. Do not edit it.**

This is a derived Obsidian vault, built from `.planning/`. It exists so that any developer, or any
AI session, can read the team's accumulated context without re-deriving it, and so Obsidian's graph
view works over the project's own specs.

## Open it

Obsidian → *Open folder as vault* → select `.ai-memory/`. Wikilinks resolve, backlinks work, and the
graph view is populated. `.obsidian/app.json` is committed so it opens the same way for everyone;
per-user UI state is gitignored.

Start at `INDEX.md`.

## Layout

| Folder | Source | Contents |
| --- | --- | --- |
| `INDEX.md` | all | Entry point: active phases, specs, graph, contract |
| `phases/` | `.planning/phases/<NN>-<slug>/` | One note per phase, all its documents merged |
| `specs/` | `.planning/*.md` | PROJECT, REQUIREMENTS, ROADMAP, STATE, CONTEXT |
| `graph/` | `.planning/graphs/GRAPH_REPORT.md` | God nodes, surprising connections, questions |
| `decisions/` | `.planning/decisions/` | ADR-style notes |
| `discussions/` | `.planning/discussions/` | Discussion output |
| `research/` | `.planning/research/` | Research notes |

Each source root keeps its own folder, so two files sharing a name (`decisions/api.md` and
`research/api.md`) can't overwrite each other.

Scratch notes are left out. A `.planning/` file named `*.local.md` never reaches this vault, not
even as inlined text inside a merged phase note.

## Why it is committed

The vault travels with the repo, so a fresh clone has the shared context immediately, with no tool
run and no API cost. It's markdown only. `graph.json`, HTML and SVG are deliberately excluded, which
is what keeps this directory readable in Obsidian and free of binary clutter in Git.

## Editing

To change anything here, edit the source under `.planning/` and run:

```
/comind-sync
```

Direct writes are blocked by the `comind-gate` PreToolUse hook: absolutely for the editing tools
(Edit/Write/MultiEdit/NotebookEdit), and for shell commands whose write verb or redirection aims at
this directory. Your change would be silently overwritten on the next sync either way.

Regeneration only rewrites files whose content actually changed, and prunes notes whose source
disappeared. A note you add by hand has no CoMind stamp, so it's left alone.
