# Onboarding

> **0.0.1-alpha.0, an alpha in active development.** The commands below work against the published
> package. To run a local checkout instead, swap `npx -y comind@latest` for
> `node <checkout>/bin/comind.js --local`.

There are two paths. Read the one that describes you and skip the other.

| You are… | Path | Time |
| --- | --- | --- |
| First person putting CoMind on a repo. No `.comind/manifest.json` in git. | [Path A](#path-a-first-developer) | 15 to 30 min, mostly answering GSD's questions |
| Joining a repo that already has CoMind. `.comind/manifest.json` is committed. | [Path B](#path-b-joining-an-existing-comind-repo) | About 5 min, no questions |

Not sure? Run this in the repo:

```bash
test -f .comind/manifest.json && echo "Path B: already set up" || echo "Path A: you're first"
```

---

## Prerequisites

**Required.** CoMind stops without these:

| | Why |
| --- | --- |
| Node ≥ 18 | Everything runs on Node built-ins. Nothing else is a hard dependency. |
| git | CoMind's whole point is sharing context through your repo. |
| macOS or Linux | **Windows is not supported yet.** The win32 code paths exist and are unit-tested, but CoMind has never been run end to end on a real Windows host. |

**Per-layer.** Missing one skips that layer and prints the fix. It never fails the whole setup:

| | Enables | Without it |
| --- | --- | --- |
| `claude` CLI | Managed plugin install, Caveman | File-copy fallback with no update or uninstall; no output compression |
| `python3` or `uv` | graphify | No knowledge graph, so architecture questions fall back to grep |
| a language server binary | that language's LSP plugin | Plugin installs, but produces no diagnostics. `/comind-lsp` names the fix |

Check what you have:

```bash
node --version && git --version
command -v claude python3 uv go
```

---

## Path A: first developer

You're creating the shared brain. Everything you do here gets committed, so the rest of the team
inherits it.

### 1. Install CoMind (stage 1)

This touches **nothing** in your repo. It only makes CoMind available to Claude Code.

```bash
npx -y comind@latest
```

Expected: `COMIND 0.0.1-alpha.0 INSTALLED — nothing in your repo was touched`, and
`Mechanism: plugin`. If it says `Mechanism: file-copy`, the `claude` CLI wasn't found. That works,
but you get no `update` or `uninstall`, and `comind doctor` will keep reminding you.

Verify:

```bash
claude plugin list | grep comind      # Status: ✔ enabled
```

### 2. Set up the project (stage 2)

```bash
cd /path/to/your/repo
claude                                # open Claude Code here
```

Then, in the session:

```
/comind-init
```

**Everything real happens here**, and it has to. GSD onboarding maps your codebase with subagents
and asks what the project is for. A shell script can't do that, and a `.planning/` written from
guesses is exactly the context rot CoMind exists to prevent.

`/comind-init` will:

1. Run `comind setup`, which installs the pinned tools, registers the gate hook, writes the
   `.gitignore` and `.gitattributes` managed blocks along with the `permissions.deny` rules,
   generates the LSP plugins for this repo's languages, and writes the manifest.
2. Ask GSD which entry point fits, then run it: `/gsd-onboard` for existing code,
   `/gsd-new-project` for greenfield, `/gsd-ingest-docs` if you already have ADRs or PRDs.
3. Re-run `setup` to enable graphify now that `.planning/` exists.
4. Build the graph (`/gsd-graphify build`) and generate the `.ai-memory/` vault.
5. Run `comind doctor`.
6. Print exactly what to commit.

**Answer GSD's questions yourself.** Claude is told not to answer on your behalf. If you're not in
a position to answer, stop and come back. A fabricated `PROJECT.md` poisons every session after it.

### 3. Commit the shared brain

`/comind-init` prints the list, computed from real disk state, naming each managed path rather than
a blanket directory. It looks like:

```bash
git add .comind/manifest.json .planning/ .ai-memory/ \
        .claude/settings.json .claude/hooks/ .claude/skills/ .claude/commands/ \
        .claude/agents/ .claude/gsd-core/ .claude/scripts/ .claude/package.json \
        .claude/gsd-file-manifest.json .gitignore .gitattributes \
        graphify-out/graph.json graphify-out/GRAPH_REPORT.md graphify-out/manifest.json \
        graphify-out/.graphify_labels.json graphify-out/.graphify_analysis.json
git commit -m "chore: init CoMind - shared AI context"
```

CoMind will not stage or commit for you. That's your call.

### 4. Tell your team

Point them at [Path B](#path-b-joining-an-existing-comind-repo). Three things change about working
in the repo:

- Bulk edits need a spec in `.planning/phases/`, and a hook enforces it.
- Ask the graph before grepping: `/gsd-graphify query "..."`.
- After pulling: `/comind-sync`.

---

## Path B: joining an existing CoMind repo

The repo already has the shared brain. You need the tools on **your** machine and nothing else.
Your setup must leave every tracked file untouched.

### 1. Install CoMind (stage 1)

```bash
npx -y comind@latest
```

> **You may not need this step.** If the first developer committed the project-scope plugin
> declaration in `.claude/settings.json`, `/comind-init` is already available after you clone. Try
> it first; come back here only if the command is missing.

### 2. Run the same command

```bash
cd /path/to/the/repo
claude
```

```
/comind-init
```

It detects **JOIN** and does only machine-local work: installs the pinned tools, regenerates the
LSP plugins for this repo's languages, registers RTK's global hook. It will **not** run GSD
onboarding, rebuild the graph, or regenerate the vault. Those are committed artifacts that already
exist.

### 3. Confirm you changed nothing

```bash
git status --porcelain
```

**Expected: empty.** If a CoMind path shows as modified here, that's a bug. Report it rather than
committing it.

### 4. Read yourself in

```bash
open .ai-memory/INDEX.md          # or: Obsidian → Open folder as vault → .ai-memory/
```

Start at `INDEX.md`: active phases, specs, graph highlights. This is why the vault is committed.
You get the team's accumulated context with no tool run and no API cost.

Then verify:

```
/comind-doctor
```

A warning on an `lsp:<language>` row means the server binary that plugin wraps isn't on PATH, and
`/comind-lsp` prints the one command that installs it. Everything else should pass.

---

## What lives where

The split is the design. It's why `/comind-init` is safe to run repeatedly and why joining doesn't
dirty the repo.

**Committed. Identical for everyone.**

```
.comind/manifest.json    the contract: pinned versions + enabled layers
.planning/               GSD specs, phases, roadmap, config  ← the only writable truth
.ai-memory/              derived Obsidian vault, markdown only
.claude/settings.json    gate hook (+ plugin declaration, once published)
.claude/hooks/           comind-gate.mjs
.claude/skills/          the caveman-gsd team contract
.claude/commands/        GSD + CoMind slash commands
.claude/agents/          GSD subagent definitions
.claude/gsd-core/        the GSD engine those commands invoke; without it they do nothing
.claude/scripts/         helper scripts that engine requires by relative path
.claude/package.json     marks .claude/ CommonJS so gsd-core's hooks load
.claude/gsd-file-manifest.json  gsd-core's install stamp

.gitignore .gitattributes  managed blocks

graphify-out/graph.json               the queryable graph: you can query on clone,
graphify-out/GRAPH_REPORT.md          without paying to rebuild it
graphify-out/manifest.json            graphify's extraction record, keeping your build incremental
graphify-out/.graphify_labels.json    LLM-generated community names
graphify-out/.graphify_analysis.json  cohesion + god-node data
```

**Machine-local. Regenerated per developer, never committed.**

```
.comind/state/                session counters, gate bypass log
graphify-out/graph.html       re-rendered by /comind-sync, free and offline
graphify-out/cache/           extraction cache: large, useless on another machine
graphify-out/cost.json        your API spend
.claude/settings.local.json   gsd-core hooks, which embed your absolute node path
.claude/gsd-install-state.json  gsd-core's install log, stamped with your clock
.planning/**/*.local.md       scratch notes: gitignored, and never copied into the vault
```

Name a planning file `*.local.md` and it stays yours. Git ignores it, the vault won't republish it,
and it doesn't count as a spec for the bulk-edit gate.

Your rtk binary isn't in that list because it isn't in the repo at all. See the next section.

**Outside the repo. Installed per developer.**

```
plugin cache             CoMind itself, incl. its four slash commands
~/.claude/settings.json  RTK's Bash rewrite hook (matcher: Bash)
~/.claude/RTK.md         RTK's compression contract
~/.claude/comind/pkg/    CoMind itself, on the file-copy fallback only
~/.claude/comind/bin/    the rtk binary, shared by every CoMind repo on this machine
~/.claude/comind/cache/  verified download cache, keyed by version
```

The team contract is **not** in that last list, on purpose. It's project-scoped, so it governs only
repos that actually have a `.planning/`.

---

## Daily workflow

| When | Do |
| --- | --- |
| Starting a feature | `/gsd-workflow discuss` → `/gsd-workflow plan` |
| "How does X work?" | `/gsd-graphify query "how does X work"`, **before** any grep |
| After `git pull` | `/comind-sync` |
| Finished a phase | `/gsd-workflow verify` → `/gsd-workflow ship` |
| Something feels off | `/comind-doctor` |

---

## What will block you, and why

Two rules, enforced by a `PreToolUse` hook.

**1. `.ai-memory/` is read-only.** It's generated from `.planning/`, so a direct edit gets
overwritten on the next sync. Edit the source, then `/comind-sync`. This one is absolute for the
editing tools and `COMIND_GATE=off` does not lift it. Shell writes are caught heuristically: a
redirect or write verb aimed at that path is denied, reads pass.

**2. Bulk edits need a spec.** Past 5 distinct files in one session with nothing in
`.planning/phases/`, edits are blocked. Single-file fixes and typos always pass, and writes into
`.planning/` are exempt, because creating the spec is exactly what this rule asks you to do.

```bash
COMIND_GATE=off claude              # bypass rule 2 (logged to .comind/state/bypass.log)
COMIND_BULK_THRESHOLD=15 claude     # or raise the limit
```

The gate exists because unplanned bulk work is invisible to everyone else on the repo. If you find
yourself reaching for the bypass often, that's a signal the phase granularity is wrong, not that
the gate is.

**RTK also rewrites your Bash commands** (`git status` becomes `rtk git status`) to compress output
before it reaches context. Two consequences worth knowing:

- Don't add `| head` or `--quiet` to work around verbosity. RTK already handled it, and your pipe
  defeats its filters.
- RTK only intercepts **Bash**. `Read`, `Grep` and `Glob` bypass it, so use `rtk read`, `rtk grep`
  or `rtk find` when you want filtering there.

---

## Troubleshooting

`/comind-doctor` first, always. Every check is independent, so one broken layer still reports on
the rest. The exact count varies, since it grows a row per language this repo actually uses.

| Check fails | What you actually lost | Fix |
| --- | --- | --- |
| `comind installed (stage 1)` | Slash commands stale or absent | re-run stage 1 |
| `comind lifecycle`, WARN | File-copy install: no update or uninstall | install the `claude` CLI, re-run stage 1 |
| `skill scope`, FAIL | The contract is user-scope, applying to unrelated repos | remove it by hand: `rm -rf ~/.claude/skills/caveman-gsd` |
| `command registration`, FAIL | Hand-copied commands shadow the plugin's | re-run stage 1 (it clears them) |
| `rtk binary` / `rtk rewrite hook` | Tool output compression. Bash results hit context raw | `rtk init -g --auto-patch` |
| `caveman plugin` | Output compression. Responses run long | `claude plugin install caveman@caveman` |
| `gsd-core installed` | Phase discipline | re-run `/comind-init` |
| `repo onboarded`, WARN | No shared specs yet | `/gsd-onboard` |
| `active phases`, WARN | Bulk edits gated with nothing able to satisfy the gate | `/gsd-workflow discuss` |
| `graphify` / `knowledge graph built` | Graph-first retrieval; every question falls back to grep | `/comind-sync` |
| `lsp:<lang>`, WARN | That language's plugin is missing, or its server binary is | `/comind-lsp` |
| `manifest vs package pins`, WARN | Your CoMind and the repo's contract disagree | **the repo wins**: install the version the manifest names |

That last one matters. Never drag the team onto new tool versions by upgrading locally. Bumping the
shared contract is a reviewed commit, and [UPGRADING.md](UPGRADING.md) covers it.

### `${CLAUDE_PLUGIN_ROOT}` appears literally in a command

Neither install path resolved. Re-run stage 1, then `claude plugin list | grep comind`.

### `/comind-init` isn't available

Restart Claude Code. Plugins load at session start.

---

## Removing CoMind

```bash
npx -y comind@latest uninstall
```

That removes CoMind: the plugin, its marketplace entry, and any fallback artifacts. It **prints but
does not run** the removal commands for RTK, Caveman and GSD, because deleting another tool's
global state isn't CoMind's call.

Your repo files are left alone. `.planning/`, `.ai-memory/` and the hooks are committed team
artifacts, so remove them with git if you mean to.

---

## Contributing to CoMind itself

If you're working on the CoMind tool rather than using it in a project, see the Development section
of [README.md](README.md) and test against scratch repos.
