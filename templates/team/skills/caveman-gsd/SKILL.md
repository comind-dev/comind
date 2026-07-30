---
name: caveman-gsd
description: "The CoMind team contract for THIS repository. Enforces the dense Caveman output profile, the GSD phase loop (no bulk edits without a spec in .planning/phases/), graph-first retrieval over grep, and LSP-verified claims over inferred ones. Applies to every question about this repo's code, architecture, or plan."
---

# CoMind Team Contract

Applies to every response in this repository.

**This skill is project-scoped on purpose.** It lives in `.claude/skills/` and is
committed, so the whole team shares one pinned contract and it never governs a repo
that has no `.planning/`. It is never installed user-wide — a copy in
`~/.claude/skills/` would apply these rules to every repo on the machine, so
`comind doctor` fails if it finds one.

The Caveman plugin owns global tone; this owns the repo's rules and reinforces
tone in scope.

## 1. Output profile — dense, telegraphic

Drop:
- Preambles. No "I'll help you with that", "Great question", "Let me analyze".
- Wrapper sentences. No "Here is the code:" before a block. No "Hope this helps".
- Hedging. No "it seems", "perhaps", "you might want to consider". State it or verify it.
- Recaps. Do not summarize what you just did when the diff already shows it.
- Restating the question back at the user.

Do:
- Fragments over sentences. `Cache miss. Key collides on tenant_id.`
- Code first, causality second. Show the change, then one line of why.
- One claim per line. No paragraph padding around a two-word answer.
- Name the file and line: `src/auth/session.ts:42`. Never "the auth file".
- If the answer is a command, output the command. Nothing else.

Verbosity floor: never compress away a real risk, a data-loss warning, or a
failing test. Terse is the goal; incomplete is not.

## 2. Phase loop — mandatory

Discuss → Plan → Execute → Verify → Ship. One phase at a time.

Before any multi-file feature work, a spec must exist at
`.planning/phases/<NN>-<slug>/`. If none does, do not start editing. Say so in
one line and name the command:

```
No spec. Run /gsd-workflow discuss, then /gsd-workflow plan.
```

The `comind-gate` PreToolUse hook enforces this at the 6th distinct file in a
session. Do not try to route around it — no chunking edits into batches, no
`COMIND_GATE=off` unless the user explicitly asks. The gate exists because
unplanned work is invisible to the other developers on this repo.

Single-file fixes, typos, and one-line changes need no spec. Use judgment; the
rule targets bulk feature work, not every keystroke.

Heavy work belongs in fresh-context subagents (`/gsd-plan-phase`,
`/gsd-execute-phase`). Keep the main session lean — that is the whole point of
the loop.

## 3. Retrieval order — graph before grep

For any question about architecture, call graphs, data flow, or "how does X
work", follow this order and stop at the first that answers:

1. `/gsd-graphify query "<question>"` — the knowledge graph. Cheapest, and it
   sees cross-file relationships a grep cannot.
2. `.ai-memory/INDEX.md` → the linked note. The shared brain, already summarized.
3. `.planning/STATE.md` for where the team currently is.
4. Only then Grep/Glob/Read the source.

A broad Grep sweep as the first move is a mistake in this repo. The graph and the
vault exist so that sweep is unnecessary.

`graphify-out/` and `.planning/graphs/` are denied to the Read tool via
`permissions.deny` in `.claude/settings.json`, so this is enforced, not advice:
a direct read of `graph.json` is refused. Query it.

## 4. Verification — deterministic, not inferred

Claims about types, symbols, references, or whether code compiles come from a
language server, never from reading and reasoning.

Anthropic's language-server plugins are installed for the languages this repo
actually contains (`/comind-lsp` shows which). Use their go-to-definition,
find-references, diagnostics, and rename tools. "This looks type-safe" is not a
claim you may make from reading. Check it.

A plugin wraps a server binary but does not ship one. If diagnostics are empty,
run `/comind-lsp` — a missing server binary is the usual cause, and it names the
one command that installs it. Say so in one line and fall back to `tsc --noEmit`
or `pyright` through RTK. Do not silently switch to inference.

## 5. Derived paths — never hand-edit

| Path | Owner | Rule |
| --- | --- | --- |
| `.planning/` | GSD Core | Writable truth. Edit here. |
| `.ai-memory/` | CoMind | Derived. Edit `.planning/`, then `/comind-sync`. |
| `.planning/graphs/` | graphify | Derived. Rebuild, never edit. |
| `.claude/settings.local.json` | gsd-core | Machine-local — embeds absolute node paths. Never commit. |
| `.comind/manifest.json` | CoMind | Pinned contract. Bump versions.json, don't hand-edit. |

Writes under `.ai-memory/` are blocked by the gate: absolutely via the editing tools, and
heuristically for shell writes (a redirect or write verb aimed at that path).

## 6. Tool output is already compressed

RTK rewrites Bash commands transparently — `git status` becomes `rtk git status`
before it runs. Its hook is registered globally in `~/.claude/settings.json`
(matcher `Bash`), installed per developer by `/comind-init`, so it is not in this
repo and there is nothing about it to commit. Consequences:

- Do not add `| head`, `| tail`, or `--quiet` to work around verbosity. RTK
  already handled it, and your pipe defeats its filters.
- RTK only intercepts **Bash**. `Read`, `Grep`, and `Glob` bypass it. When you
  need compact output from those, use `rtk read`, `rtk grep`, or `rtk find`.
- Truncated-looking output is usually RTK working. Do not re-run raw to "see
  everything" unless the compressed form genuinely lacks what you need.

## 7. Token budget is a shared resource

Several developers work this repo in parallel. Context you waste is context the
next session cannot use.

- Answer from the graph or the vault before reading files.
- Do not re-read a file you just edited to confirm the edit landed.
- Do not restate a plan the user already approved.
- Prefer one targeted read over three exploratory ones.
