---
name: comind-lsp
description: Show which language-server plugins this repo needs, which are installed, and whether their server binaries are present. With no argument it asks what to install; with a language it installs that one directly.
---

# /comind-lsp

Anthropic ships first-party LSP plugins for 12 languages. CoMind installs the ones this
repo actually needs — every installed plugin costs always-on context in every session, so
installing twelve into a Python repo is exactly the waste CoMind exists to prevent.

## With an argument — install directly

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/comind.js" lsp $ARGUMENTS
```

`$ARGUMENTS` is one or more of: `typescript python go rust csharp java php c kotlin swift
lua ruby`. Add `--remove` to uninstall instead.

## With no argument — report, then ask

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/comind.js" lsp --json
```

Render the result as a short table — language, whether it is in this repo, whether the
plugin is installed, whether the server binary is on PATH. Then ask **one** question:

> Detected `<languages>`. Install `<the missing plugins>`?

Only offer languages where `detected` is true and `installed` is false. If there are none,
say `LSP current.` and stop — do not list the other ten.

On yes, run the install form above with the agreed languages.

## Step 3 — the server binary

A plugin wraps a language server; it does not ship one. When the CLI reports
`<binary> is not on PATH`, relay the exact command it printed and stop there.

**Do not install language toolchains.** CoMind installs Go, JDKs, and rustup for nobody —
they are machine-wide, they outlive CoMind, and `comind uninstall` could never take them
back. Detection keys on `go.mod`, `Cargo.toml`, `Gemfile` and the like, so the toolchain is
almost always already present and only the server binary is missing.

## Notes

- Run `/reload-plugins` after an install for the plugin to activate.
- Plugin installs are **machine-local**. They are not recorded in `.comind/manifest.json`,
  so running this never dirties a tracked file — a joiner can use it freely.
- `/comind-doctor` reports the same state as part of the full check.
