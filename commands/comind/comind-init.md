---
name: comind-init
description: Set up CoMind in this repo. Auto-detects first-time setup vs joining a teammate's repo, installs every pinned tool, wires hooks and LSP, runs GSD onboarding, builds the knowledge graph, generates the Obsidian vault, and prints exactly what to commit.
---

# /comind-init

**This command owns the entire setup.** Stage 1 (`npx -y comind@latest`) only made CoMind available to Claude
Code — it deliberately touched nothing. Everything real happens here, because onboarding needs
a reasoning agent: mapping the codebase and capturing project intent cannot be done by a shell
script.

Run every step in order. Do not skip. Keep output dense — the caveman-gsd profile applies.

## Step 1 — Mechanics

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/comind.js" setup --yes
```

This installs the pinned tools (rtk, caveman, gsd-core, graphify, LSP servers), registers the
gate hook and the `permissions.deny` rules that keep derived artifacts out of context, writes
the `.gitignore` / `.gitattributes` managed blocks, installs the LSP plugins for the languages
this repo contains, and writes `.comind/manifest.json`.

Read the mode line it prints and branch:

- **FIRST INIT** — no committed manifest. You are bootstrapping the shared brain. Continue.
- **JOIN** — a teammate already set this repo up. Your machine is now configured and no tracked
  file was touched. **Skip to Step 5.** Do not onboard, do not rebuild the graph, do not
  regenerate the vault — those are committed artifacts that already exist.

Report every layer marked `skip` or `FAIL` with the exact `run by hand` line it printed. Never
continue silently past a failure.

## Step 2 — GSD onboarding (FIRST INIT only)

Ask GSD itself which entry point fits this repo rather than guessing:

```bash
node .claude/gsd-core/bin/gsd-tools.cjs init onboard
```

Read `next_action.command` from that JSON and run it:

- `/gsd-new-project` — greenfield, no existing code or planning docs
- `/gsd-onboard` — brownfield; routes through codebase mapping and optional doc ingest
- `/gsd-ingest-docs` — existing ADRs/PRDs/SPECs to bootstrap from

If the tool is unavailable, fall back to: `/gsd-onboard` for a repo with code, `/gsd-new-project`
for an empty one.

**Let GSD drive its own questions. Do not answer on the developer's behalf** — a PROJECT.md
written from your assumptions is exactly the context rot CoMind exists to prevent. If the
developer is not present to answer, stop here and say so rather than inventing intent.

## Step 3 — Finish configuration (FIRST INIT only)

`.planning/` now exists, which unlocks two steps that could not run before it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/comind.js" setup --yes
```

`setup` is idempotent, so re-running is cheap and does only the newly-possible work: enabling
`graphify.enabled: true` in `.planning/config.json` and picking up the phase layout. Confirm the
`graphify-config` layer now reports `ok`, not `skip`.

## Step 4 — Build the graph and the vault (FIRST INIT only)

```
/gsd-graphify build
```

Runs graphify inline into `.planning/graphs/`. Minutes on a large repo — that is the
`graphify.build_timeout` setup configured. If it reports graphify is disabled, Step 3 did not
take; check `.planning/config.json`.

Then generate the Obsidian vault:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/comind.js" sync
```

Verify no binary clutter reaches Git:

```bash
find .ai-memory -type f -not -name '*.md' -not -path '*/.obsidian/*'
```

Expected: no output.

## Step 5 — Verify

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/comind.js" doctor
```

Report the pass/warn/fail counts, then every non-pass check with its printed fix.

An LSP plugin installed without its server binary produces no diagnostics — say that plainly
rather than calling it fine, and relay the one command `/comind-lsp` prints. Do not offer to
install a language toolchain.

## Step 6 — The git informer

`setup` already printed the commit block. Relay it verbatim; that path list is computed from
real disk state, so do not paraphrase or reorder it.

**Do not run `git add` or `git commit` yourself.** Staging the shared contract is the
developer's call. Print the command and stop.

On JOIN, confirm cleanliness instead:

```bash
git status --porcelain
```

Any CoMind path modified here on JOIN is a bug — report it, don't commit it.

## Step 7 — What changed about working here

Three lines, no more:

- Bulk edits now need a spec in `.planning/phases/` — the gate hook enforces it.
- Ask the graph before grepping: `/gsd-graphify query "..."`.
- After pulling teammates' changes: `/comind-sync`.

## If `${CLAUDE_PLUGIN_ROOT}` does not resolve

Installed as a plugin, Claude Code expands that variable. On the file-copy fallback (no `claude`
CLI at install time) it is substituted with an absolute path. If it reaches the shell literally,
neither happened — re-run stage 1:

```bash
npx -y comind@latest
```

Then check which mechanism installed it:

```bash
claude plugin list | grep comind
```
