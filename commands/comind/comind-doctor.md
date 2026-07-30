---
name: comind-doctor
description: Verify every CoMind layer independently and report version drift against the pinned manifest. Read-only. Use --metrics for measured token savings.
---

# /comind-doctor

Read-only. Changes nothing. Use it when something feels off, after a `git pull` that touched
`.comind/manifest.json`, or before blaming a tool.

## Step 1 — Run it

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/comind.js" doctor
```

Add `--metrics` when the user asks about savings, and `--json` when you need to reason over
the result rather than show it.

## Step 2 — Report honestly

Give the pass/warn/fail line, then every non-pass check with the fix the doctor printed.

Do not soften a FAIL into a warning. Do not report "all good" when a layer is missing —
name the layer and what capability is lost:

| Failing layer | What is actually lost |
| --- | --- |
| `rtk binary` / `rtk rewrite hook` | Tool output compression. Bash results hit context raw. |
| `caveman plugin` | Output compression. Responses run long. |
| `gsd-core` / `active phases` | Phase discipline. Bulk edits are gated with nothing to satisfy the gate. |
| `graphify` / `knowledge graph built` | Graph-first retrieval. Every architecture question falls back to grep. |
| `lsp:<language>` | Semantic verification for that language. Type claims become inference, not fact. |
| a server binary missing | The plugin is installed but produces no diagnostics. `/comind-lsp` names the fix. |
| `hook layout` | RTK and CoMind hooks may be colliding. |

## Step 3 — Interpret drift specifically

**`manifest vs package pins` WARN** — the repo's committed contract and the CoMind version
this developer is running disagree. The repo wins: tell them to install the version the
manifest names rather than upgrading the repo unilaterally. Upgrading the shared contract is
a deliberate, committed change (see `UPGRADING.md`).

**A tool version WARN** — locally installed version differs from the pin. `/comind-init` (stage 2)
converges it. Stage 1 (`npx -y comind@latest`) installs CoMind only and no tools, so it cannot fix
this. If it recurs, something else on the machine is managing that tool (Homebrew, a global npm
install) and should be removed.

**`lsp:<lang>` WARN with "not on PATH"** — the plugin is installed but the language server it
wraps is missing, so it produces no diagnostics. Relay the exact command shown. CoMind installs
no language toolchains, so do not offer to install Go, a JDK, or rustup.

## Step 4 — Metrics, if asked

With `--metrics`, report only what was measured:

- `rtk` numbers come from `rtk gain` — real, cumulative, per-machine.
- Gate bypasses are a count from `.comind/state/bypass.log`.
- Everything under `unmeasured:` is exactly that. Caveman's output savings and graph-vs-grep
  input savings are **not** instrumented by CoMind.

Never present the combined reduction target as an achieved number. Report measured figures
and name what is unmeasured.
