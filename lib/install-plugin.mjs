// Stage 1: `npx comind` — INSTALL ONLY.
//
// This stage must not touch the target repository at all. It makes the slash
// commands available to Claude Code and stops. All project setup happens later,
// in a Claude Code session, via /comind-init.
//
// Two mechanisms, in priority order:
//
//   1. PLUGIN (primary). `claude plugin marketplace add` + `claude plugin install`.
//      This is how Claude Code expects extensions to be distributed, and it is
//      what gives CoMind uninstall, update, enable/disable, a version registry,
//      namespaced commands, and `claude plugin details` token accounting. None of
//      that can be hand-rolled correctly.
//
//   2. FILE COPY (fallback). Only when the `claude` CLI is absent. Copies the
//      package to ~/.claude/comind/ and writes the commands into
//      ~/.claude/commands/, substituting ${CLAUDE_PLUGIN_ROOT} for the real path.
//      No lifecycle — `doctor` reports this so the asymmetry is visible.
//
// The caveman-gsd skill is deliberately installed by NEITHER. It is a per-repo
// contract that references .planning/phases/, so it is project-scoped: `comind
// setup` writes it into the repo's .claude/skills/ and it is committed. A
// user-scope copy would enforce GSD phase discipline in repos that have no
// .planning/ at all.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { PKG_ROOT, homeDir, comindHome, which, run, IS_WINDOWS } from './platform.mjs';

/**
 * Everything the installed copy needs in order to run `comind setup`.
 *
 * Note the absence of top-level `skills/` and `hooks/`. Claude Code
 * auto-discovers those directories by CONVENTION when it loads a plugin —
 * independently of what plugin.json declares — so a `skills/caveman-gsd/` here
 * would ship the team contract at user scope no matter what the manifest says,
 * and a `hooks/hooks.json` would be loaded and schema-validated as plugin hooks.
 * Both live under templates/team/ instead, from where `comind setup` copies them
 * into the repo as project-scoped, committed files.
 *
 * package.json is NOT optional dressing. Without it nothing above
 * <root>/bin/comind.js declares "type":"module", so Node walks to the
 * filesystem root, finds no package.json, and loads an ESM file as CommonJS —
 * `SyntaxError: Cannot use import statement outside a module` on 18.x, 20.x and
 * 22.0-22.6, all inside our declared engines. Every wired slash command,
 * doctor included, dies. Only module-syntax detection (default from 22.7) hides
 * it, which is why the suite never caught it.
 */
const PAYLOAD = ['bin', 'lib', 'commands', 'templates', 'versions.json', 'package.json'];

const PLUGIN_TOKEN = '${CLAUDE_PLUGIN_ROOT}';

const COMMAND_DIR = ['commands', 'comind'];

/**
 * The slash commands this package ships, read from disk.
 *
 * Never a literal list. Four separate hardcoded copies of "init, sync, doctor"
 * existed and every one of them silently missed `/comind-lsp` when it was added:
 * the file-copy cleanup left a stale duplicate behind, `uninstall` orphaned it,
 * doctor under-reported the shadowing, and the install report named three
 * commands while wiring four.
 */
export function commandFiles(root = PKG_ROOT) {
  const dir = path.join(root, ...COMMAND_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .sort();
}

/** The same set as `/name` slugs, for display. */
export function commandNames(root = PKG_ROOT) {
  return commandFiles(root).map((n) => `/${n.replace(/\.md$/, '')}`);
}

export const MECHANISM = { PLUGIN: 'plugin', COPY: 'file-copy' };

/**
 * Where the file-copy payload lives. A SUBDIRECTORY of comindHome(), never
 * comindHome() itself.
 *
 * PAYLOAD contains 'bin', and comindPaths().bin is where the rtk binary is
 * downloaded. When this returned comindHome(), those were the same directory:
 * clearCopyArtifacts() rm -rf'd it on every successful plugin install (including
 * the already-installed no-op), and installViaCopy's pruneExtras deleted rtk as
 * an entry not present in the shipped bin/. So `npx comind`, documented as safe
 * to run repeatedly, destroyed the downloaded binary and left the global rtk
 * hook pointing at nothing.
 */
export function installRoot() {
  return path.join(comindHome(), 'pkg');
}

/**
 * The install stamp, which stays at the ROOT of comindHome() rather than moving
 * with the payload.
 *
 * Deliberate: the stamp records which mechanism installed CoMind, and
 * clearCopyArtifacts keeps it precisely so that record survives the payload
 * being cleared. Moving it under pkg/ would also make every already-installed
 * machine read null, and doctor's `stamp?.comind ?? versions.comind` fallback
 * would then substitute the RUNNING version for the installed one — a PASS that
 * no version drift could ever falsify.
 */
export function stampFile() {
  return path.join(comindHome(), 'install.json');
}

export function claudeDirs() {
  const base = path.join(homeDir(), '.claude');
  return {
    base,
    commands: path.join(base, 'commands'),
    skills: path.join(base, 'skills'),
  };
}

/**
 * Where the marketplace should be added from.
 *
 * Prefers the published GitHub repo. Falls back to this checkout's own path when
 * the package is unpublished or the developer is testing locally — `marketplace
 * add` accepts "a URL, path, or GitHub repo", which is what makes the plugin path
 * verifiable before release.
 */
export function marketplaceSource(versions, { local = false } = {}) {
  const dist = versions.distribution;
  if (local) return PKG_ROOT;
  return process.env.COMIND_MARKETPLACE || dist.marketplace;
}

// --- Mechanism 1: the plugin system --------------------------------------

/**
 * Presence only, from the plain `claude plugin list` text.
 *
 * INTERNAL — the fallback for CLIs too old to answer `--json`. Every caller
 * outside this module wants claudePluginVersion(), because presence says
 * nothing about the version: `claude plugin install` cannot pin one. This was
 * exported for a while and the export is what let three call sites report the
 * PIN on mere presence, making plugin-layer drift undetectable.
 *
 * Returns false when the CLI is absent, which is indistinguishable from "not
 * installed" — the reason claudePluginVersion returns null instead.
 */
function pluginPresent(pluginId, claudeBin) {
  if (!claudeBin) return false;
  const res = run(claudeBin, ['plugin', 'list'], { timeout: 60_000 });
  if (!res.ok) return false;
  // Match the bare name: `plugin list` prints `comind@comind`, but the same plugin
  // from a differently-named marketplace is still installed.
  const name = pluginId.split('@')[0];
  return new RegExp(`\\b${name}\\b`).test(res.stdout);
}

const pluginName = (id) => String(id ?? '').split('@')[0];
const entryName = (p) => pluginName(p?.name ?? p?.id ?? '');

/**
 * The `claude plugin list --json` entries, or null when the CLI cannot answer
 * in that form.
 *
 * null is NOT an empty list. "I could not tell" and "nothing is installed" lead
 * to opposite decisions, and collapsing them is how a machine ends up believing
 * an install exists that does not.
 */
function pluginEntries(claudeBin) {
  if (!claudeBin) return null;
  const res = run(claudeBin, ['plugin', 'list', '--json'], { timeout: 60_000 });
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout);
    const list = Array.isArray(parsed) ? parsed : parsed?.plugins;
    if (!Array.isArray(list)) return null;
    // Only trust the listing when at least one element exposes an identifier.
    // A CLI that keys the name differently would otherwise make every plugin
    // report as missing, and setup reinstall it forever.
    if (list.length && !list.some((p) => p?.name != null || p?.id != null)) return null;
    return list;
  } catch {
    return null;
  }
}

/**
 * Is this plugin installed AT `scope`? true / false / null for "cannot tell".
 *
 * The scope is the entire question. `claude plugin list` enumerates
 * project-scoped plugins belonging to OTHER projects, and CoMind installs
 * itself at project scope for every teammate (declareProjectPlugin), so a name
 * match somewhere in that output says nothing about whether a user-scope
 * install exists. Matching the bare name against the whole listing turned
 * `npx comind` into a silent no-op on any machine that had ever run
 * /comind-init in some other repo: it reported success, cleared the file-copy
 * artifacts, and stamped a plugin install that was not there.
 */
function pluginInstalledAt(pluginId, scope, claudeBin) {
  const list = pluginEntries(claudeBin);
  if (list == null) return null;
  const matches = list.filter((p) => entryName(p) === pluginName(pluginId));
  if (!matches.length) return false;
  // A listing that names the plugin but not its scope cannot answer this.
  if (matches.some((p) => p?.scope == null)) return null;
  return matches.some((p) => p.scope === scope);
}

/**
 * The ACTUALLY installed version of a plugin, from `claude plugin list --json`.
 *
 * `claude plugin install` cannot pin a version — it resolves whatever the
 * marketplace currently serves — so this is the only honest source. Reporting
 * the pinned version on mere presence made drift for plugin layers
 * undetectable in three separate places.
 *
 * Returns the version string, 'unknown' when the plugin is installed but the
 * registry exposes no version, or null when it is not installed (or the CLI
 * is absent).
 */
export function claudePluginVersion(pluginId, claudeBin = which('claude')) {
  if (!claudeBin) return null;
  const list = pluginEntries(claudeBin);
  if (list != null) {
    const match = list.find((p) => entryName(p) === pluginName(pluginId));
    return match ? String(match.version ?? match.manifest?.version ?? 'unknown') : null;
  }
  // Older CLIs without --json: presence is all we can establish.
  return pluginPresent(pluginId, claudeBin) ? 'unknown' : null;
}

/**
 * Install via `claude plugin`. Returns { ok, version, reason }.
 * Never throws — a failure here falls through to the copy fallback.
 */
export function installViaPlugin(versions, { scope = 'user', local = false, log } = {}) {
  const claude = which('claude');
  const dist = versions.distribution;
  if (!claude) return { ok: false, reason: 'claude CLI not on PATH' };

  // `=== true` on purpose: pluginInstalledAt returns null when it could not
  // settle the question, and falling through then costs one idempotent
  // `plugin install` (already handled as success below) instead of skipping the
  // install entirely and reporting one that never happened.
  if (scope === 'user' && pluginInstalledAt(dist.plugin, 'user', claude) === true) {
    return { ok: true, already: true, mechanism: MECHANISM.PLUGIN };
  }

  const source = marketplaceSource(versions, { local });
  const added = run(claude, ['plugin', 'marketplace', 'add', source, '--scope', scope], {
    timeout: 180_000,
  });
  const addedOk = added.ok || /already|exists/i.test(`${added.stdout}${added.stderr}`);
  if (!addedOk) {
    return {
      ok: false,
      reason: `marketplace add ${source} failed: ${(added.stderr || added.stdout).slice(-200)}`,
    };
  }

  const installed = run(claude, ['plugin', 'install', dist.plugin, '--scope', scope], {
    timeout: 300_000,
  });
  const installedOk = installed.ok || /already/i.test(`${installed.stdout}${installed.stderr}`);
  if (!installedOk) {
    return {
      ok: false,
      reason: `plugin install ${dist.plugin} failed: ${(installed.stderr || installed.stdout).slice(-200)}`,
    };
  }

  log?.(`  plugin ${dist.plugin} installed (scope: ${scope}, source: ${source})`);
  return { ok: true, mechanism: MECHANISM.PLUGIN, scope, source };
}

/**
 * Read the version the plugin registry recorded, for doctor and drift checks.
 *
 * Scope-filtered for the same reason pluginInstalledAt is: taking entries[0]
 * blind returned a project-scope record from an unrelated repo, which doctor
 * then reported as a user-scope stage-1 install.
 */
export function pluginRegistryEntry(versions, { scope = null } = {}) {
  const file = path.join(homeDir(), '.claude', 'plugins', 'installed_plugins.json');
  if (!existsSync(file)) return null;
  try {
    const reg = JSON.parse(readFileSync(file, 'utf8'));
    const entries = reg.plugins?.[versions.distribution.plugin];
    if (!Array.isArray(entries) || !entries.length) return null;
    if (scope) return entries.find((e) => e?.scope === scope) ?? null;
    // No scope requested: prefer user, but ANY scope still means plugin-managed.
    //
    // Filtering to user-only here was wrong in the other direction. A teammate
    // who clones a CoMind repo gets the project-scope declaration and never runs
    // stage 1 at all — a path ONBOARDING blesses explicitly — and reporting that
    // as "no install found / file-copy install — no update or uninstall" is
    // false twice over. The scope-strict question belongs to installViaPlugin,
    // which asks pluginInstalledAt instead.
    const preferred = entries.find((e) => e?.scope === 'user') ?? entries[0];
    return { ...preferred, scope: preferred?.scope ?? null };
  } catch {
    return null;
  }
}

// --- Mechanism 2: the file-copy fallback ---------------------------------

/** Recursive copy that only writes changed files, so re-installing is a no-op. */
function copyTree(src, dest, stats) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src).sort()) {
      copyTree(path.join(src, name), path.join(dest, name), stats);
    }
    return;
  }
  const body = readFileSync(src);
  if (existsSync(dest)) {
    const prev = readFileSync(dest);
    if (prev.equals(body)) {
      stats.unchanged++;
      return;
    }
    stats.updated++;
  } else {
    stats.written++;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, body);
}

/**
 * Delete anything in `dest` that no longer exists in `src`.
 * Copy-then-prune rather than wipe-then-copy: wiping makes every file report as
 * newly written, which hides whether an upgrade actually changed anything.
 */
function pruneExtras(src, dest) {
  let removed = 0;
  for (const name of readdirSync(dest)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (!existsSync(s)) {
      rmSync(d, { recursive: true, force: true });
      removed++;
      continue;
    }
    if (statSync(d).isDirectory() && statSync(s).isDirectory()) {
      removed += pruneExtras(s, d);
    }
  }
  return removed;
}

/**
 * Write the slash commands into ~/.claude/commands/, substituting the plugin
 * root token with the real install path. The source files use
 * ${CLAUDE_PLUGIN_ROOT} so they run as-is under the plugin path; this rewrite is
 * what makes the same files work without a plugin host.
 */
function wireCommands(target, stats) {
  const { commands } = claudeDirs();
  mkdirSync(commands, { recursive: true });
  const srcDir = path.join(target, ...COMMAND_DIR);

  const installed = [];
  for (const name of commandFiles(target)) {
    const body = readFileSync(path.join(srcDir, name), 'utf8').replaceAll(
      PLUGIN_TOKEN,
      target.split(path.sep).join('/'),
    );
    const dest = path.join(commands, name);
    const prev = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
    if (prev === body) stats.unchanged++;
    else {
      writeFileSync(dest, body, 'utf8');
      prev == null ? stats.written++ : stats.updated++;
    }
    installed.push(`/${name.replace(/\.md$/, '')}`);
  }
  return installed;
}

export function installViaCopy(versions, { log } = {}) {
  const target = installRoot();
  const stats = { written: 0, updated: 0, unchanged: 0, removed: 0 };

  mkdirSync(target, { recursive: true });
  for (const entry of PAYLOAD) {
    const src = path.join(PKG_ROOT, entry);
    if (!existsSync(src)) continue;
    copyTree(src, path.join(target, entry), stats);
  }
  for (const entry of PAYLOAD) {
    const src = path.join(PKG_ROOT, entry);
    const dest = path.join(target, entry);
    if (!existsSync(dest) || !statSync(dest).isDirectory()) continue;
    stats.removed += pruneExtras(src, dest);
  }

  if (!IS_WINDOWS) {
    // chmodSync, not a `chmod` spawn: run() swallows a failure, so a bare-name
    // lookup that resolved to the wrong thing (or to nothing) would leave the
    // copied CLI non-executable and say nothing about it.
    for (const rel of ['bin/comind.js', 'bin/comind-init.sh']) {
      const f = path.join(target, rel);
      if (existsSync(f)) chmodSync(f, 0o755);
    }
  }

  const commands = wireCommands(target, stats);
  writeStamp(target, versions, MECHANISM.COPY);
  log?.(`  copied to ${target} (no plugin lifecycle — see \`comind doctor\`)`);
  return { ok: true, mechanism: MECHANISM.COPY, target, commands, stats };
}

// --- Shared --------------------------------------------------------------

/** Record what was installed and how, so doctor can report the mechanism. */
function writeStamp(target, versions, mechanism) {
  mkdirSync(comindHome(), { recursive: true });
  const stamp = {
    comind: versions.comind,
    mechanism,
    installedFrom: PKG_ROOT.split(path.sep).join('/'),
    home: target.split(path.sep).join('/'),
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
  };
  const file = stampFile();
  if (existsSync(file)) {
    try {
      const prev = JSON.parse(readFileSync(file, 'utf8'));
      if (prev.comind === stamp.comind && prev.home === stamp.home && prev.mechanism === mechanism) {
        return file;
      }
    } catch {
      /* rewrite */
    }
  }
  writeFileSync(file, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
  return file;
}

export function readInstallStamp() {
  const file = stampFile();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { __corrupt: true };
  }
}

/**
 * Clear the file-copy artifacts when a managed plugin install takes over.
 *
 * Not a version migration — the two install mechanisms coexist in one release, and
 * a machine can move between them the moment the `claude` CLI becomes available.
 * The plugin host then serves the commands, so any copies left in
 * ~/.claude/commands/ would register each command a second time.
 */
export function clearCopyArtifacts({ dryRun = false } = {}) {
  const { commands } = claudeDirs();
  const removed = [];
  for (const name of commandFiles()) {
    const f = path.join(commands, name);
    if (!existsSync(f)) continue;
    if (!dryRun) rmSync(f, { force: true });
    removed.push(name);
  }
  // Keep install.json so the mechanism stays recorded for doctor; drop the payload.
  const home = installRoot();
  for (const entry of PAYLOAD) {
    const p = path.join(home, entry);
    if (!existsSync(p)) continue;
    if (!dryRun) rmSync(p, { recursive: true, force: true });
    removed.push(entry);
  }
  return { removed };
}

/** What clearCopyArtifacts would delete — used by the dry run to predict it. */
export function listCopyArtifacts() {
  return clearCopyArtifacts({ dryRun: true }).removed;
}

/**
 * Run stage 1: plugin first, copy as fallback.
 * Writes nothing outside ~/.claude. `dryRun` writes nothing at all.
 */
export function installPlugin(versions, { dryRun = false, log, local = false, forceCopy = false } = {}) {
  const target = installRoot();

  if (dryRun) {
    const claude = which('claude');
    const willPlugin = !forceCopy && !!claude;
    // Predict what the REAL run does, including the side effects it performs
    // beyond the install itself. The old report claimed a marketplace source
    // even when the predicted mechanism was file-copy (which copies from this
    // package), and mentioned neither the artifact cleanup nor the stamp.
    const copyArtifacts = willPlugin ? listCopyArtifacts() : [];
    return {
      ok: true,
      dryRun: true,
      mechanism: willPlugin ? MECHANISM.PLUGIN : MECHANISM.COPY,
      target,
      source: willPlugin ? marketplaceSource(versions, { local }) : PKG_ROOT,
      commands: commandNames(),
      wouldClear: copyArtifacts,
      // Both mechanisms write the stamp — installViaCopy does it too, so
      // gating this on the plugin path under-reported the file-copy run.
      // stampFile(), not target/install.json: the stamp deliberately stays at the
      // CoMind home root while the payload lives under pkg/, so predicting the
      // payload path here named a file the real run never writes.
      wouldWriteStamp: stampFile(),
      stats: { written: 0, updated: 0, unchanged: 0, removed: 0 },
    };
  }

  if (!forceCopy) {
    const viaPlugin = installViaPlugin(versions, { scope: 'user', local, log });
    if (viaPlugin.ok) {
      // The plugin host serves the commands now, so any file-copy leftovers from a
      // previous run on this machine would register each one a second time.
      const cleared = clearCopyArtifacts();
      if (cleared.removed.length) {
        log?.(`  cleared ${cleared.removed.length} file-copy artifact(s) — the plugin serves the commands`);
      }
      // Stamp so doctor can report the mechanism without shelling out to the CLI.
      writeStamp(target, versions, MECHANISM.PLUGIN);
      return {
        ok: true,
        mechanism: MECHANISM.PLUGIN,
        already: viaPlugin.already,
        source: viaPlugin.source,
        registry: pluginRegistryEntry(versions),
        commands: commandNames(),
        cleared,
        stats: { written: 0, updated: 0, unchanged: 0, removed: 0 },
      };
    }
    log?.(`  plugin path unavailable — ${viaPlugin.reason}`);
    log?.('  falling back to a file copy (no update/uninstall via claude plugin)');
  }

  const copied = installViaCopy(versions, { log });
  return { ...copied, fallbackReason: forceCopy ? 'forced' : 'plugin path unavailable' };
}

/** Post-install guidance. Stage 1 ends by handing off to stage 2. */
export function renderInstallNextSteps(report, versions) {
  const L = [];
  const viaPlugin = report.mechanism === MECHANISM.PLUGIN;
  L.push('');
  L.push('='.repeat(72));
  L.push(`  COMIND ${versions.comind} INSTALLED — nothing in your repo was touched`);
  L.push('='.repeat(72));
  L.push('');
  L.push(`  Mechanism: ${report.mechanism}${report.already ? ' (already present)' : ''}`);
  if (viaPlugin) {
    L.push(`  Plugin:    ${versions.distribution.plugin}`);
    if (report.source) L.push(`  Source:    ${report.source}`);
    if (report.registry?.version) L.push(`  Version:   ${report.registry.version}`);
    L.push('  Lifecycle: claude plugin update|uninstall|disable comind@comind');
  } else {
    L.push(`  Home:      ${report.target}`);
    L.push(
      `  Files:     ${report.stats.written} written, ${report.stats.updated} updated, ` +
        `${report.stats.unchanged} unchanged` +
        (report.stats.removed ? `, ${report.stats.removed} stale removed` : ''),
    );
    L.push('  Lifecycle: none — no update or uninstall via `claude plugin`.');
    L.push(
      report.fallbackReason === 'forced'
        ? '             Forced with --no-plugin. Drop that flag to get a managed install.'
        : `             Reason: ${report.fallbackReason || 'plugin path unavailable'}.`,
    );
    if (report.fallbackReason !== 'forced') {
      L.push('             Re-run `npx comind` once the claude CLI is on PATH to');
      L.push('             convert this into a managed plugin install.');
    }
  }
  L.push(`  Commands:  ${report.commands.join('  ')}`);
  L.push('');
  if (report.cleared?.removed?.length) {
    L.push(`  CLEARED   ${report.cleared.removed.length} file-copy artifact(s) from a previous run on`);
    L.push('            this machine. The plugin serves the commands now.');
    L.push('');
  }
  L.push('  This step only made CoMind available to Claude Code. No tools were');
  L.push('  installed, no repo files were written, nothing was configured.');
  L.push('');
  L.push('  NEXT — set up a project');
  L.push('');
  L.push('    1. cd into the repo you want CoMind to manage');
  L.push('    2. open Claude Code there');
  L.push('    3. run:  /comind-init');
  L.push('');
  L.push('  /comind-init does the whole setup: installs the pinned tools, wires the');
  L.push('  hooks and LSP, runs GSD onboarding, builds the knowledge graph, generates');
  L.push('  the Obsidian vault, and tells you exactly what to commit.');
  L.push('');
  L.push('  Joining a repo a teammate already set up? If they committed the project-');
  L.push('  scope plugin declaration, /comind-init is already available — just run it.');
  L.push('  It detects JOIN and only configures your machine.');
  L.push('');
  L.push('='.repeat(72));
  L.push('');
  return L.join('\n');
}
