# CoMind: Collaborative Mind

> **0.0.1-alpha.0 is on npm as `@comind-dev/comind`, and it's an alpha.** The install contract and
> the `.ai-memory/` vault schema can still change between alphas, so expect to re-run `/comind-init`
> after an upgrade. [ONBOARDING.md](ONBOARDING.md) is the step-by-step version, including
> [how to upgrade](ONBOARDING.md#upgrading-comind). There's also a
> [site](https://comind-dev.github.io/comind/) if you want the short version first.

CoMind wires five compression and discipline layers into a repo you already have, then tells you
exactly which files to commit so the whole team works from one shared context.

## Two stages, on purpose

```bash
npx @comind-dev/comind   # stage 1: install CoMind. Your repo is not touched.
```

```
/comind-init        # stage 2: set up the project. Run inside Claude Code.
```

> Working from a clone instead of the registry? `node bin/comind.js --local` replaces stage 1 and
> adds the checkout as a local marketplace. Everything after that is the same.

**Stage 1 installs nothing but CoMind itself.** It registers CoMind as a Claude Code plugin, which
is what gets you `claude plugin update / uninstall / disable / details` and a real version
registry. Four slash commands show up, costing roughly 200 always-on tokens. It installs no tools,
and nothing in your repo or your config changes.

If the `claude` CLI isn't on PATH, stage 1 falls back to copying into `~/.claude/comind/pkg/`. That
works. It also has no update or uninstall path, and `comind doctor` tells you so rather than
pretending otherwise.

**Stage 2 does all the real work.** It runs inside a Claude Code session because project setup
needs a reasoning agent: GSD onboarding maps the codebase with subagents and asks you what the
project is actually for. A shell script can do neither. And a `.planning/` written from a script's
assumptions is precisely the context rot CoMind exists to prevent.

Stage 2 works out on its own whether you're bootstrapping the repo or joining one a teammate
already set up, and does the right thing either way.

Setting up for the first time, or joining a repo that already has CoMind?
[ONBOARDING.md](ONBOARDING.md) walks through both paths step by step.

## The problem

Put three developers on one repo with Claude Code and you get three private contexts that drift
apart from day one. Every session re-derives the same architecture facts. Verbose tool output eats
the budget. Nothing survives the session: no shared spec memory, no deterministic verification,
nothing compressed.

## The five layers

| Layer | Tool | What it does |
| --- | --- | --- |
| Input compression | [RTK](https://github.com/rtk-ai/rtk) | Rewrites Bash calls (`git status` → `rtk git status`) so verbose output is filtered *before* it reaches context |
| Output compression | [Caveman](https://github.com/JuliusBrussee/caveman) | Cuts Claude's own output tokens |
| Phase discipline | [GSD Core](https://github.com/open-gsd/gsd-core) | Discuss → Plan → Execute → Verify → Ship, with heavy work in fresh-context subagents |
| Shared memory | graphify + `.ai-memory/` | A queryable knowledge graph, exported as a Git-tracked Obsidian vault |
| Verification | [Anthropic's LSP plugins](https://claude.com/plugins/typescript-lsp) | Real language-server diagnostics for the languages this repo has, not inference |

CoMind is glue. It reimplements none of these: it installs them at pinned versions, wires them so
they compose instead of colliding, and manages the Git layout.

**One of these five is enforced. The other four are instructions.** The gate hook and the
`permissions.deny` rules are the only parts Claude Code cannot ignore. Phase discipline, retrieval
order and verification order all live in `caveman-gsd/SKILL.md`, and they work only if the model
follows them. Worth knowing before you rely on any of it.

## What gets installed where

The split is the whole design, and it's why stage 1 is safe to run again and again on any machine.

**Committed. The shared brain, identical for everyone.**

```
.comind/manifest.json    pinned versions + enabled layers (the contract)
.planning/               GSD specs, phases, roadmap, config
.ai-memory/              derived Obsidian vault, markdown only
.claude/settings.json    gate hook + permissions.deny + plugin declaration
.claude/hooks/           comind-gate.mjs
.claude/skills/          the caveman-gsd team contract
.claude/commands/        GSD + CoMind slash commands
.claude/agents/          GSD subagent definitions
.claude/gsd-core/        the GSD engine those commands invoke
.claude/scripts/         gsd-core's helper scripts, required by that engine
.claude/package.json     gsd-core's CommonJS marker for those scripts
.claude/gsd-file-manifest.json  gsd-core's install stamp; JOIN reads it and skips reinstalling
.gitignore .gitattributes  comind-managed blocks

graphify-out/graph.json               the queryable graph
graphify-out/GRAPH_REPORT.md          highlights, god nodes, open questions
graphify-out/manifest.json            graphify's extraction record, keeping a clone's build incremental
graphify-out/.graphify_labels.json    LLM-generated community names
graphify-out/.graphify_analysis.json  cohesion + god-node data
```

Graphify ships `graphify-out/` expecting it to be committed, and CoMind follows that. A clone with
no `graph.json` can't answer `/gsd-graphify query` at all; it has to pay for a full extraction
first. The two dotfile sidecars are model output, and re-earning them costs API calls. Committed
doesn't mean readable, though. `permissions.deny` still refuses all five, so they reach context
only through a graph query.

`graph.json` is regenerated wholesale on every build, so the managed `.gitattributes` hands it to
graphify's union merge driver. The driver *body* is machine-local git config and can't be
committed, which is why `comind setup` registers it on every machine, JOIN included.

**Machine-local. Regenerated per developer, never committed.**

```
.comind/state/                session counters, gate bypass log
graphify-out/graph.html       free local re-render; /comind-sync rebuilds it
graphify-out/cache/           extraction cache: large, and useless on another machine
graphify-out/cost.json        this machine's API spend
.claude/settings.local.json   gsd-core hooks (they embed absolute node paths)
.claude/gsd-install-state.json  gsd-core's per-machine install log
.planning/**/*.local.md       scratch notes: gitignored, and never copied into the vault
```

**Outside the repo entirely. Installed per developer.**

```
plugin cache                  CoMind itself, the four slash commands, and the LSP plugins
~/.claude/settings.json       RTK's Bash rewrite hook
~/.claude/RTK.md              RTK's compression contract
~/.claude/comind/pkg/         CoMind itself, on the file-copy fallback only
~/.claude/comind/bin/         the platform's rtk binary, shared by every repo
~/.claude/comind/cache/       verified download cache, keyed by version
```

Notice what's missing from that list: `caveman-gsd`. The team contract is project-scoped and
committed, so it governs only repos that actually have a `.planning/`. A user-scope copy would push
GSD phase discipline onto every repo on the machine, and `comind doctor` fails if it finds one.

`.claude/settings.json` carries a project-scope plugin declaration (`extraKnownMarketplaces` plus
`enabledPlugins`), so a teammate who clones the repo gets `/comind-init` without ever running
`npx`.

## Commands

Slash commands are the intended interface, all inside Claude Code:

| Command | Use |
| --- | --- |
| `/comind-init` | Set up or join a repo. Owns the whole flow: tools → hooks → GSD onboarding → graph → vault → git informer. |
| `/comind-sync` | After a pull or a shipped phase. Rebuilds the graph, regenerates the vault. |
| `/comind-lsp` | Show which language-server plugins this repo needs; install or remove them. |
| `/comind-doctor` | Verify all five layers and report version drift. Read-only. |

Autocomplete will show you `/comind:comind-init`. Claude Code namespaces every plugin command as
`<plugin>:<command>`, and CoMind's files carry the name too, so the word lands twice. `/comind-init`
is the shorthand, and it's what this documentation uses throughout. That's deliberate rather than
lazy: it's also the exact name you get on the file-copy fallback, where the commands are written
into `~/.claude/commands/` as plain user-scope files with no namespace to prefix them. One string,
both install paths.

The CLI underneath, which the slash commands invoke:

| Command | Stage |
| --- | --- |
| `npx @comind-dev/comind` | 1: install CoMind as a plugin, wire slash commands. Repo-safe. |
| `comind setup` | 2: the mechanical half. Tools, hooks, ignores, LSP plugins, manifest. |
| `comind lsp` | Show LSP status; install or remove a language's plugin. |
| `comind sync` | Regenerate `.ai-memory/`. |
| `comind doctor` | Verify layers; `--metrics` for measured savings. |
| `comind update` | Update CoMind itself (plugin installs only). |
| `comind uninstall` | Remove CoMind. Prints, but never runs, the removal commands for RTK, caveman and GSD. |

Add `--dry-run` to any of them to see every action without a single write. `--local` installs from
a checkout instead of the marketplace, and `--no-plugin` forces the fallback.

You can run `comind setup` by hand if you want. `/comind-init` is the supported path though, since
it's the only one that can also drive onboarding and the graph build.

## Versions are pinned where it matters

`versions.json` is the single source of truth, and every tool declares how tightly it's held:

- **exact** for rtk, gsd-core and caveman. Drift there corrupts the *shared* repo. rtk is a binary
  CoMind executes, gsd-core writes committed files, caveman installs hooks into `~/.claude`.
- **floor (`>=`)** for graphify and the LSP servers. Machine-local, derived output. Nobody's repo
  changes because a teammate has a newer graphify.

Nothing resolves `latest` at install time either way. RTK comes from its GitHub release and is
verified against that release's own `checksums.txt`. Caveman installs from a pinned **commit**
(`npx github:JuliusBrussee/caveman#<sha>`) because tags move and its releases are not immutable.
[UPGRADING.md](UPGRADING.md) has the details.

## Platforms

Node ≥18 is the only hard prerequisite. All the logic lives in `bin/comind.js` and uses Node
built-ins only; `bin/comind-init.sh` and `bin/comind-init.ps1` are two-line wrappers.

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Status | supported, tested | supported, tested | **not yet, see below** |
| rtk binary | arm64 / x64 prebuilt | x64 prebuilt (musl); arm64 prebuilt (glibc). musl arm64 builds from source via cargo | |
| Entry point | `npx @comind-dev/comind` | `npx @comind-dev/comind` | |
| Hooks | `node …mjs` | `node …mjs` | |

**Windows is not supported yet.** The code carries win32 paths throughout (PATHEXT resolution,
`.cmd` shim spawning, drive-letter handling) and its pure logic is unit-tested, but CoMind has
never been run end to end on a real Windows host. Treat it as unverified. It may work; if it
doesn't, that's expected rather than a surprise. Making it a tested platform is planned and not
done. Bug reports from anyone trying it are welcome.

Optional layers degrade instead of failing. A language whose server binary is missing still gets
its plugin installed, and CoMind prints the one line that installs the binary. It never installs a
language toolchain, because those are machine-wide and `comind uninstall` could not undo them.

## How the hooks coexist

Two PreToolUse hooks with different jobs:

- **RTK** matches `Bash` and *rewrites* commands for compression. Global, per developer.
- **CoMind** matches `Edit|Write|MultiEdit|NotebookEdit|Bash` and *gates* them, allowing or denying
  but never rewriting. Committed.

Both see `Bash`, and that's fine: CoMind only inspects the command to stop a shell write into the
derived `.ai-memory/` vault, and never modifies it.

gsd-core registers guards of its own. Overlap doesn't matter, because Claude Code runs every
matching hook. `/comind-doctor` dumps the merged layout so you can see what actually fires.

## The gate

CoMind's hook enforces two rules.

1. **`.ai-memory/` is read-only.** It's derived from `.planning/`, so a direct edit would only be
   overwritten. Absolute for the editing tools. Shell writes get caught heuristically, by spotting
   a redirect or a write verb aimed at that path.
2. **Bulk edits need a spec.** Past 5 distinct files in a session with nothing in
   `.planning/phases/`, the edit is blocked. Single-file fixes always pass, and writes into
   `.planning/` are always exempt, since that's the fix the rule is asking for.

Escape hatch: `COMIND_GATE=off`, logged to `.comind/state/bypass.log`. Or raise the limit with
`COMIND_BULK_THRESHOLD`.

## Token reduction

Four mechanisms compound, and they are not equally strong:

| Mechanism | Kind |
| --- | --- |
| `permissions.deny` on the four derived paths (`graphify-out/`, `.planning/graphs/`, `.comind/state/`, `.ai-memory/.obsidian/`) | **enforced**: Claude Code refuses the read |
| RTK rewrites Bash calls before they run | **enforced**: a PreToolUse hook |
| Caveman shortens responses | prompt |
| Graph queries replace grep sweeps | prompt (`caveman-gsd` SKILL.md §3) |

`comind doctor --metrics` reports **measured** savings from `rtk gain` and spells out what isn't
instrumented. CoMind doesn't claim a combined figure it can't measure, and the two prompt-level
mechanisms aren't measured at all.

## Development

There's no `.planning/`, no `.ai-memory/` and no `.claude/` in this repo; `.gitignore` says as much
at the top. Test against scratch repos instead:

```bash
node --test test/*.test.mjs           # gate rules, idempotence, git semantics, vault, install, extraction
node bin/comind.js --local            # install from this checkout via a local marketplace
node bin/comind.js setup --dry-run    # plan a project setup without writing
node bin/comind.js uninstall          # remove plugin + marketplace + fallback artifacts
```

### Versioning

**The version moves only in a release commit.** `0.0.1-alpha.0` is what's on npm. Ordinary changes
don't bump it, and a bump is not a side effect of anything: `test/install.test.mjs` pins the current
number, so releasing means editing that test on purpose.

One form, everywhere: `versions.json` `comind`, `package.json`, `plugin.json`, the committed
manifest, install stamps, and every rendered line. It has to stay valid semver, because npm's
registry rejects anything else and drift detection compares versions by ordering. Tests enforce the
semver shape, the freeze, and agreement across all three manifests.

Release steps are in [UPGRADING.md](UPGRADING.md#releasing).

Three invariants to protect:

1. **Idempotence.** Two consecutive runs leave the repo byte-identical. Managed regions of
   `.gitignore` and `.gitattributes` are replaced between sentinels rather than appended twice, and
   the `permissions.deny` set converges instead of accumulating.
2. **Stage 1 never writes into a repo.** Asserted by snapshot comparison, plus an explicit check
   that every stage-2 artifact is absent.
3. **No top-level `skills/` or `hooks/` directory.** Claude Code auto-discovers those names by
   convention when loading a plugin, *regardless of `plugin.json`*, so their presence at the root
   would ship the team contract user-scope and double-register the gate hook. Both live under
   `templates/team/`, and a test fails if either reappears at the root.

## License

MIT
