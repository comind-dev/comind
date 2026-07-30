# Upgrading the pinned tools

CoMind pins every tool it installs. Nothing resolves `latest` at install time, so a teammate
cloning in six months gets the versions you have today. The cost of that guarantee is that upgrades
are manual. Here's the procedure.

**Pinning is one decision per tool, not one decision for all of them.** Each entry in
`versions.json` carries a `policy`:

| policy | tools | why |
| --- | --- | --- |
| `exact` | rtk, gsd-core, caveman | Divergence corrupts the SHARED repo. rtk is a binary CoMind executes. gsd-core writes committed files, so two developers on different versions fight over tracked files. caveman installs hooks into `~/.claude`. |
| `floor` (`>=`) | graphifyy, typescript, typescript-language-server, pyright | Machine-local, derived output. Nobody's repo changes because a teammate has a newer graphify, and an exact pin there is a treadmill that buys nothing. |

A missing `policy` means `exact`, so a tool added without one cannot silently start floating.

The floor still answers *"is this already installed?"*, which is the load-bearing half. Without some
version predicate every setup reinstalls, and a gsd-core reinstall rewrites its manifest with a
fresh timestamp. A second run would dirty the repo and the byte-identical invariant would die.

> **CoMind's own version moves only in a release commit.** `0.0.1-alpha.0` is what's published, and
> a test pins that number, so a bump is always deliberate. Most of this document is about the tools
> CoMind installs rather than about CoMind itself; the release runbook is at the bottom, under
> [Releasing](#releasing).

## The two contracts

| File | Scope | Who owns it |
| --- | --- | --- |
| `versions.json` | The CoMind package | Maintainers. |
| `.comind/manifest.json` | A consuming repo | The team. Committed. Records what that repo pins. |

When they disagree, **the repo's manifest wins**, and `comind doctor` reports the mismatch. A single
developer must never drag the team onto new tool versions by changing their local checkout. That's
a reviewed commit, not a side effect of someone's setup run.

## Upgrading a tool

1. **Find the new version.** Query the source of truth rather than guessing:

   ```bash
   # GitHub releases (rtk, caveman)
   curl -s https://api.github.com/repos/rtk-ai/rtk/releases/latest | grep '"tag_name"'

   # npm (gsd-core, typescript, typescript-language-server, pyright)
   npm view @opengsd/gsd-core version

   # PyPI (graphifyy)
   curl -s https://pypi.org/pypi/graphifyy/json | python3 -c 'import json,sys;print(json.load(sys.stdin)["info"]["version"])'
   ```

2. **Edit `versions.json`.** One tool at a time. For `rtk`, also confirm the asset filenames under
   `assets` still match the release. Upstream has renamed target triples before, and a stale name
   degrades to "no prebuilt asset" rather than failing loudly.

   Every tool in the LSP layer **must** declare `binName`. That's how its installed version gets
   probed. Without it the layer can never report "already pinned", and a global `npm install -g`
   runs on every setup.

3. **Verify:**

   ```bash
   node bin/comind.js --version          # every pin reads back correctly
   node bin/comind.js setup --dry-run    # no writes, full plan
   node bin/comind.js setup --yes && git status --porcelain > /tmp/a
   node bin/comind.js setup --yes && git status --porcelain > /tmp/b
   diff /tmp/a /tmp/b                    # empty: setup is idempotent
   node bin/comind.js doctor             # all layers report the new version
   node --test test/*.test.mjs
   ```

4. **Check for behavioural drift.** A version number that reads back correctly proves very little:

   - **rtk.** Re-read `rtk init --help`. `-g` is required for the hook; without it nothing is
     installed. If the flags change, `initRtkHook` in `lib/install-tools.mjs` needs updating, and so
     does `parseRtkShow` if the `--show` output format moves.
   - **gsd-core.** This one moves fast. Confirm `.planning/` still holds `config.json`, `phases/`
     and `graphs/`, and that `--claude --local` still works non-interactively. A layout change
     breaks `lib/vault.mjs` and the gate's phase detection.
   - **caveman.** Bump `ref` to the new tag's COMMIT SHA, never the tag:
     `curl -s https://api.github.com/repos/JuliusBrussee/caveman/commits/<tag> | grep -m1 '"sha"'`.
     Tags are movable, the releases report `"immutable": false`, and this package installs hooks
     into `~/.claude`. Caveman's own `bin/install.js` self-pins from the ref it was fetched at and
     SHA-256-verifies each hook against the manifest published there, so pinning the commit is what
     makes that verification mean anything.
   - **LSP plugins.** Not pinnable, since Claude Code plugin installs take no version. Confirm the
     official plugin ids still resolve:
     `claude plugin install typescript-lsp@claude-plugins-official`. If Anthropic adds a language,
     add a row to `versions.json` → `lsp.languages`. Detection, install, doctor and `/comind-lsp`
     are all driven from that one table.
   - **graphifyy.** Confirm `/gsd-graphify` still drives it. CoMind never calls graphify directly.

5. **Commit.** Every consuming repo's `comind doctor` now reports drift, which is each team's signal
   to converge deliberately.

## Upgrading a consuming repo

One developer does this, and it's a reviewed commit like any other:

```bash
node bin/comind.js setup --yes --force
node bin/comind.js doctor
git add .comind/manifest.json .claude/ .gitignore .gitattributes
git commit -m "chore: upgrade pinned tools"
```

`--force` re-runs FIRST INIT so the manifest and hook registrations get rewritten. Teammates then
run `/comind-init`, which detects JOIN and converges their machines.

To go back, `git revert` the commit and have each developer re-run `/comind-init`. The download
cache is keyed by version, and `~/.claude/comind/cache/<version>/` holds both the archive and the
`checksums.txt` it was verified against, so rolling back to a version this machine installed before
needs no network. The cache lives outside every repo, which means one machine with five CoMind
repos downloads each version once. A cached archive that fails verification is purged and re-fetched
once rather than reported as tampering.

## Retired: `.claudeignore`

CoMind used to write a managed block into `.claudeignore`, and the docs sold it as one of the four
token mechanisms. **Claude Code reads no such file.** There is no `.claudeignore` support in the
product, so that block never once excluded anything. The equivalent rule now lives in
`permissions.deny` in the committed `.claude/settings.json`, which Claude Code does honour:

```json
{ "permissions": { "deny": ["Read(./graphify-out/**)", "Read(./.planning/graphs/**)"] } }
```

`deny` is stronger than an ignore. It refuses the read outright, which is what
`caveman-gsd/SKILL.md` §3 always claimed ("never read `graph.json`, query it").

**What you'll see on the next `comind setup`:** the managed block is withdrawn from
`.claudeignore`, and if the file held nothing else it's deleted. Anything you wrote in it yourself
is preserved. Commit the removal along with the updated `.claude/settings.json`.

The deny set is scoped to what CoMind derives. It deliberately does **not** deny `node_modules/`,
lockfiles or build trees. The old block listed them, but `deny` blocks rather than de-prioritises,
and a repo where Claude cannot read a lockfile to answer a dependency question is worse off than
one that reads it occasionally.

## Pins that need attention

**LSP plugins are not pinnable.** `claude plugin install` takes no version. The plugins are
Anthropic-verified and auto-update, which is acceptable for a first-party wrapper. What actually
determines diagnostics is the *server binary*, and for TypeScript and Python that stays pinned in
`tools`. The other ten languages use whatever server the developer's toolchain provides, and
`comind doctor` reports which are present.

**Replaced: `mcp-language-server`.** It was source-only (zero release binaries at v0.1.0 and
v0.1.1), required a Go toolchain most JS and Python developers don't have, and couldn't report its
own version, so drift for that layer was structurally invisible. Anthropic's first-party LSP plugins
cover 12 languages with no toolchain needed to install them. `.mcp.json` is gone with it, and a test
asserts neither the module, the template, nor the pin can come back.

**Name collisions, and don't "fix" these.** npm `rtk` is an unrelated release tool and npm `caveman`
is a JS templating engine. CoMind installs RTK from its GitHub release and Caveman as a Claude Code
plugin, deliberately. crates.io also carries an unrelated `rtk` (Rust Type Kit).

## What the checksum actually guarantees

`comind setup` prints `sha256 verified` when it installs the rtk binary. Be precise about what that
buys, because it's easy to read as more than it is.

`checksums.txt` is fetched from **the same GitHub release** as the asset. So the check detects a
corrupted download, a truncated transfer, and CDN-level tampering with the archive alone. It does
**not** detect a malicious or compromised release: whoever can replace the asset can replace the
checksum file in the same breath. There's no signature verification and no independent trust anchor.

Two things bound the risk. The release **tag is pinned**, so a later malicious release is never
picked up silently, and moving to it is an explicit `versions.json` edit. And the archive is
validated before extraction: the in-process reader flattens entries to their basename, and
`inspectArchive` refuses an archive whose listing contains an absolute path or `..`, or that cannot
be listed at all, before any external extractor sees it.

If you need a stronger guarantee, pin a commit rather than a tag and verify the checksum
out-of-band against a value you obtained yourself.

## Releasing

CoMind ships through two channels at once, and they are independent. **npm** carries the CLI, which
is what `npx -y comind@latest` runs. **The GitHub repo itself is the plugin marketplace**, read
straight from `.claude-plugin/marketplace.json` on the default branch. There is no plugin registry
to publish to, which has one consequence worth internalising: the marketplace side of a release is
just a push, so the repo has to be public and the default branch has to be the version you mean.

Bump the version in **three** places, which must agree: `versions.json` (`comind`),
`package.json`, and `.claude-plugin/plugin.json`. A test enforces the agreement, and a second test
pins the current number, so the bump also means editing `test/install.test.mjs`. That is on purpose.
A version should never move as a side effect.

Keep it valid semver. npm's registry refuses anything else, and an `alpha-vX.Y.Z` style string is
not semver. Prereleases are fine: verified that `claude plugin` accepts `0.0.1-alpha.0` and reports
it as-is.

```bash
npm test                         # green, and prepublishOnly runs it again
claude plugin validate .         # manifests parse and agree
npm publish --dry-run            # read the file list it prints, then the exit code
npm publish                      # no --tag: the alpha becomes `latest`
git tag -a v0.0.1-alpha.0 -m 'v0.0.1-alpha.0' && git push --tags
```

`npm publish` takes **no `--tag`** deliberately. `npx -y comind@latest` is baked into
`lib/platform.mjs` (`FIX.stage1`), into the committed manifest note in `lib/detect.mjs`, and into
three command docs, so publishing under `--tag alpha` would leave `comind@latest` unresolvable and
break every one of those strings. If you ever do want `latest` held back for a stable line, change
those five strings first.

Then verify the published artifact rather than trusting the upload:

```bash
env -i HOME=$(mktemp -d) PATH="$PATH" npx -y comind@latest --version
claude plugin marketplace add oneamitj/comind
claude plugin install comind@comind
claude plugin list               # Status ✔ enabled
claude plugin details comind     # Commands = the 4 in commands/comind/; Hooks = 0
```

The clean `HOME` matters. A machine that already has CoMind installed will report success no matter
what got published.

Hooks must read **0**. The gate is project-scoped and copied into the consuming repo, never shipped
as a plugin hook. The command count comes from the directory, so adding a fifth command needs no
code change: `commandFiles()` is the only list.
