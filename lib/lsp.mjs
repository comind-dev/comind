// The LSP layer: Anthropic's first-party language-server plugins.
//
// CoMind installs the PLUGIN and probes the SERVER. It does not install
// language toolchains — detection keys on go.mod, Cargo.toml, Gemfile and the
// like, which exist because someone built the project with that toolchain, so
// the toolchain is present by construction and its own install command is the
// right one to print. Installing Go or a JDK on a developer's machine would be
// the one thing CoMind could never uninstall.
//
// A plugin wraps a server binary; it never ships one. `present` therefore means
// two independent things and both are reported separately.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { run, which } from './platform.mjs';
import { claudePluginVersion } from './install-plugin.mjs';

/** Language keys in a stable display order (most common first). */
export function lspLanguages(versions) {
  return Object.keys(versions.lsp?.languages || {});
}

export function lspSpec(versions, lang) {
  return versions.lsp?.languages?.[lang] || null;
}

/** Fully-qualified plugin id, e.g. `gopls-lsp@claude-plugins-official`. */
export function lspPluginId(versions, lang) {
  const spec = lspSpec(versions, lang);
  return spec ? `${spec.plugin}@${versions.lsp.marketplace}` : null;
}

const SCAN_SKIP = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build',
  'target', '.comind', '.ai-memory', 'graphify-out', '.next', 'vendor',
]);

/**
 * Bounded search for a file with one of `exts`.
 *
 * Depth- and budget-capped so a monorepo stays cheap. `git ls-files` is not used:
 * it sees TRACKED files only, so a repo whose sources are not committed yet would
 * be misdetected and would flip languages after its first commit.
 */
function hasSourceExt(root, exts, maxDepth = 4, budget = 4000) {
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > maxDepth || seen >= budget) return false;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    const dirs = [];
    for (const e of entries) {
      if (++seen >= budget) return false;
      if (e.isDirectory()) {
        if (!SCAN_SKIP.has(e.name)) dirs.push(path.join(dir, e.name));
      } else if (exts.some((ext) => e.name.endsWith(ext))) {
        return true;
      }
    }
    return dirs.some((d) => walk(d, depth + 1));
  };
  return walk(root, 0);
}

/**
 * Which languages this repo actually contains.
 *
 * A marker file is decisive; a loose extension match is the fallback. That order
 * matters — one vendored .go file in a Python service must not install the Go
 * layer, and every installed plugin costs always-on context in every session,
 * which is the exact thing CoMind exists to reduce.
 */
export function detectLspLanguages(repoRoot, versions) {
  const out = [];
  for (const lang of lspLanguages(versions)) {
    const spec = lspSpec(versions, lang);
    const byMarker = (spec.markers || []).some((m) => existsSync(path.join(repoRoot, m)));
    const detected = byMarker || hasSourceExt(repoRoot, spec.exts || []);
    if (detected) out.push({ lang, via: byMarker ? 'marker' : 'sources' });
  }
  return out;
}

/**
 * Is the server binary this plugin wraps actually on PATH?
 *
 * pyright ships `pyright-langserver` but does not always answer --version under
 * that name, so an alternate binary is accepted where the spec declares one.
 */
export function serverPresent(versions, lang) {
  const spec = lspSpec(versions, lang);
  if (!spec?.server?.bin) return null;
  return !!(which(spec.server.bin) || (spec.server.altBin && which(spec.server.altBin)));
}

/**
 * The one line a developer runs when the server binary is missing.
 * npm-installable servers are pinned in versions.tools and CoMind installs them
 * itself, so those report the pinned command rather than a bare package name.
 */
export function serverManual(versions, lang) {
  const spec = lspSpec(versions, lang);
  if (!spec?.server) return null;
  if (spec.server.tools?.length) {
    const pinned = spec.server.tools.map((t) => `${versions.tools[t].pkg}@${versions.tools[t].version}`);
    return `npm i -g ${pinned.join(' ')}`;
  }
  return spec.server.manual || null;
}

/**
 * Full state for every language, for both `/comind-lsp` and doctor.
 * Read-only: it spawns `claude plugin list` at most once.
 */
export function lspStatus(repoRoot, versions, claudeBin = which('claude')) {
  const detected = new Map(detectLspLanguages(repoRoot, versions).map((d) => [d.lang, d.via]));
  return lspLanguages(versions).map((lang) => {
    const spec = lspSpec(versions, lang);
    return {
      lang,
      plugin: spec.plugin,
      pluginId: lspPluginId(versions, lang),
      detected: detected.has(lang),
      detectedVia: detected.get(lang) || null,
      // null (not false) when there is no claude CLI to ask — "unknown" and
      // "absent" are different states and conflating them made an installed
      // plugin look missing, which would reinstall it on every run.
      installed: claudeBin ? claudePluginVersion(spec.plugin, claudeBin) !== null : null,
      serverBin: spec.server?.bin || null,
      serverPresent: serverPresent(versions, lang),
      manual: serverManual(versions, lang),
    };
  });
}

/**
 * Install (or remove) the plugins for `langs`. Returns one record per language.
 *
 * Never throws and never installs a toolchain — a missing server binary is
 * reported, not fixed, because fixing it means installing a language runtime.
 */
export function applyLspPlugins(
  langs,
  versions,
  // Default parameter, NOT `claudeBin ?? which('claude')`: `??` falls through on
  // an explicit null, so "there is no CLI" resolved to the real one and this
  // spawned `claude plugin list` in a context that had asserted it would not.
  { remove = false, dryRun = false, log, claudeBin = which('claude') } = {},
) {
  const claude = claudeBin;
  const verb = remove ? 'uninstall' : 'install';
  const out = [];

  for (const lang of langs) {
    const spec = lspSpec(versions, lang);
    if (!spec) {
      out.push({ lang, status: 'unknown-language', reason: `no such LSP language: ${lang}` });
      continue;
    }
    const id = lspPluginId(versions, lang);
    if (!claude) {
      out.push({ lang, plugin: spec.plugin, status: 'skipped', reason: 'claude CLI not on PATH', manual: `claude plugin ${verb} ${id}` });
      continue;
    }

    const present = claudePluginVersion(spec.plugin, claude) !== null;
    if (present === !remove) {
      out.push({ lang, plugin: spec.plugin, status: remove ? 'not-installed' : 'already-installed' });
      continue;
    }
    if (dryRun) {
      out.push({ lang, plugin: spec.plugin, status: remove ? 'would-remove' : 'would-install' });
      continue;
    }

    // Qualified id first, bare name second.
    //
    // `plugin@marketplace` pins WHICH marketplace, but only resolves if that
    // marketplace is configured on this machine, and `claude plugin marketplace
    // list` does not show the official one as configured. The bare name resolves
    // from every available marketplace, which is how an auto-registered official
    // marketplace is reachable. Guessing either way would 404 the whole layer for
    // every user, so try the precise form and fall back to the general one.
    let res = run(claude, ['plugin', verb, id], { timeout: 300_000 });
    if (!res.ok && /marketplace|not found|unknown/i.test(`${res.stdout}${res.stderr}`)) {
      const bare = run(claude, ['plugin', verb, spec.plugin], { timeout: 300_000 });
      if (bare.ok) log?.(`  ${spec.plugin}: resolved without a marketplace qualifier`);
      res = bare.ok ? bare : res;
    }
    if (!res.ok && !/already|not installed/i.test(`${res.stdout}${res.stderr}`)) {
      out.push({
        lang,
        plugin: spec.plugin,
        status: 'failed',
        reason: (res.stderr || res.stdout || `exit ${res.code}`).slice(-200),
        manual: `claude plugin ${verb} ${id}`,
      });
      continue;
    }
    log?.(`  ${spec.plugin} ${remove ? 'removed' : 'installed'}`);
    const rec = { lang, plugin: spec.plugin, status: remove ? 'removed' : 'installed' };
    // Naming the missing binary at install time is the whole difference between
    // a working layer and a plugin that silently produces no diagnostics.
    if (!remove && serverPresent(versions, lang) === false) {
      rec.serverMissing = spec.server.bin;
      rec.manual = serverManual(versions, lang);
    }
    out.push(rec);
  }
  return out;
}
