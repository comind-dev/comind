// The pinned install paths: rtk, its global hook, caveman, gsd-core, graphify,
// GSD's graphify opt-in, and the npm-installable LSP servers.
//
// Contract for every installer here:
//   1. Skip when the installed version already equals the pin (idempotence).
//   2. Never throw — return a status record. One dead layer must not abort setup.
//   3. Never resolve `latest`. Every version comes from versions.json.
//   4. Report what a developer must run by hand when a layer is skipped.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  PLATFORM_KEY,
  comindPaths,
  homeDir,
  isExecutableFile,
  isMuslLinux,
  npmCmd,
  npxCmd,
  probeVersion,
  probeVersionAt,
  run,
  satisfies,
  which,
} from './platform.mjs';
import { installFromGithubRelease } from './fetch-verify.mjs';
import { claudePluginVersion } from './install-plugin.mjs';

const OK = (name, version, note) => ({ name, status: 'ok', version, note });
const SKIP = (name, reason, manual) => ({ name, status: 'skipped', reason, manual });
const FAIL = (name, reason, manual) => ({ name, status: 'failed', reason, manual });
const CACHED = (name, version) => ({ name, status: 'already-pinned', version });
const MANUAL_EXPORT = 'graphify export html';
// A layer that is present but not at (or not provably at) the pin. Neither ok
// nor failed: setup completed, the report must not pretend the pin held.
const DRIFT = (name, version, reason) => ({ name, status: 'version-drift', version, reason });

// --- RTK ------------------------------------------------------------------

export async function installRtk(ctx) {
  const { versions, repoRoot, log, dryRun } = ctx;
  const spec = versions.tools.rtk;
  const { bin, cache } = comindPaths(repoRoot);
  // Injectable for tests, like fetchImpl one layer down.
  const installRelease = ctx.installRelease ?? installFromGithubRelease;

  // Already correct, either in CoMind's own bin dir or on the developer's PATH.
  // That directory is under ~/.claude, outside every repo, so no clone can plant
  // a binary here and nothing needs to decide whether executing it is safe.
  const local = probeVersionAt(which('rtk', [bin]));
  if (satisfies(local, spec)) return CACHED('rtk', local);

  if (dryRun) return { name: 'rtk', status: 'would-install', version: spec.version };

  let res;
  if (PLATFORM_KEY === 'linux-arm64' && isMuslLinux()) {
    // Upstream ships no musl arm64 build; the pinned linux-arm64 asset is
    // glibc-linked and cannot execute here. Reporting it "installed" anyway
    // was worse than skipping straight to the source build.
    res = { ok: false, kind: 'no-asset', reason: 'the pinned linux-arm64 asset is glibc-linked and this system is musl' };
  } else {
    res = await installRelease({
      spec,
      platformKey: PLATFORM_KEY,
      destDir: bin,
      cacheDir: cache,
      log,
    });
  }
  if (res.ok) return OK('rtk', res.version, `→ ${res.binPath}`);

  // ONLY a missing prebuilt asset may fall through to a source build. Every
  // other kind is a refusal or an environment fault; in particular a checksum
  // mismatch must surface as the verification failure it is, not be silently
  // converted into "no asset for this platform" and built over.
  if (res.kind !== 'no-asset') {
    return FAIL('rtk', res.reason, res.fallback || spec.fallback);
  }
  const cargo = which('cargo');
  if (cargo && spec.fallback) {
    log?.(`  ${res.reason} — building from source with cargo`);
    const args = spec.fallback.split(/\s+/).slice(1);
    const built = run(cargo, args, { timeout: 900_000 });
    if (built.ok) {
      const v = probeVersion('rtk', ['--version']);
      return OK('rtk', v || spec.version, 'built with cargo');
    }
    return FAIL('rtk', `cargo build failed: ${built.stderr.slice(-300)}`, spec.fallback);
  }
  return FAIL('rtk', res.reason, res.fallback || spec.fallback);
}

/**
 * Read RTK's own report of whether its hook is registered.
 *
 * `rtk init --show` prints a status block whose Hook line reads either
 * `[ok] Hook: ...` or `[--] Hook: not found`. Parse that line specifically —
 * a loose /hook/ test matches the word inside "Hook: not found" and yields a
 * false positive, reporting success when nothing is installed.
 */
export function rtkHookInstalled(rtk, cwd) {
  const shown = run(rtk, ['init', '--show'], { cwd, timeout: 30_000 });
  if (!shown.ok) return { known: false, installed: false, raw: shown.stdout };
  return { known: true, ...parseRtkShow(shown.stdout), raw: shown.stdout };
}

/**
 * The parsing rule, separated from the process spawn so it can be tested against
 * RTK's real output text rather than a stubbed return value.
 *
 * Exported so tests exercise this rule directly. A test that re-implements it
 * would pass while the shipped parser was wrong.
 */
export function parseRtkShow(stdout) {
  const line = String(stdout || '')
    .split(/\r?\n/)
    .find((l) => /\bHook\s*:/i.test(l)) || '';
  const installed = line.length > 0 && !/not\s+found|not\s+configured|not\s+installed/i.test(line);
  return { installed, line: line.trim() };
}

// --- the registered hook command ------------------------------------------
//
// `rtk init -g` registers the BARE command `rtk hook claude`. That is only
// portable if rtk is on PATH — and installRtk downloads rtk into
// ~/.claude/comind/bin precisely WHEN IT IS NOT, a directory nothing ever adds
// to PATH. So for every developer who needed the download, Claude Code has been
// running a command that exits 127 on every Bash call, while doctor reported
// PASS twice: both checks resolved rtk through `which('rtk', [bin])`, the same
// lookup that hides the problem. A checker that shares its resolver with the
// thing it checks cannot fail.
//
// The functions below are pure so they can be tested without a real
// ~/.claude/settings.json, and so the rewrite rule is one readable thing rather
// than something inferred from a JSON walk.

export function globalSettingsPath() {
  return path.join(homeDir(), '.claude', 'settings.json');
}

/** Parsed ~/.claude/settings.json, or null when absent or unreadable. */
export function readGlobalSettings(file = globalSettingsPath()) {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Split a shell command string into its leading token and the rest.
 *
 * One extractor for every helper below, because they must agree about where the
 * program name ends. An earlier version matched `(?:.*[/\\])?rtk` inline, and
 * `.*` crosses spaces: `node /srv/rtk hook run` matched, so absolutizing it
 * would have eaten another tool's interpreter and rewritten its hook.
 * An unquoted token cannot contain whitespace; a quoted one can.
 */
export function splitLeadingToken(command) {
  const s = String(command ?? '');
  const m = s.match(/^(\s*)(?:"([^"]*)"|'([^']*)'|(\S+))/);
  if (!m) return null;
  return { token: m[2] ?? m[3] ?? m[4] ?? '', rest: s.slice(m[0].length) };
}

/** Does this command string invoke rtk's hook, however its path is spelled? */
export function isRtkHookCommand(command) {
  const p = splitLeadingToken(command);
  if (!p || !p.token) return false;
  // The BASENAME of the leading token, so `rtkfoo` and `node /srv/rtk` are not
  // rtk, but `/opt/rtk`, `rtk.exe` and `"C:\tools\rtk.exe"` are.
  return /(?:^|[/\\])rtk(?:\.exe)?$/i.test(p.token) && /^\s+hook\b/i.test(p.rest);
}

/**
 * EVERY registered rtk hook command, in document order.
 *
 * Plural because the writer rewrites all of them: returning only the first
 * meant doctor could pass on a healthy entry while a second, broken one sat
 * underneath it, and uninstall's guard could miss a pinned entry it had itself
 * created.
 */
export function registeredRtkCommands(settings) {
  const groups = settings?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return [];
  const out = [];
  for (const group of groups) {
    for (const h of Array.isArray(group?.hooks) ? group.hooks : []) {
      if (isRtkHookCommand(h?.command)) out.push(String(h.command));
    }
  }
  return out;
}

/** The first registered rtk hook command, or null. */
export function registeredRtkCommand(settings) {
  return registeredRtkCommands(settings)[0] ?? null;
}

/**
 * Rewrite only the LEADING token to `rtkPath`, quoted.
 *
 * Leading token only: everything after it (`hook claude`) is rtk's own
 * vocabulary, and hardcoding it here would make CoMind the owner of a literal
 * that belongs to another tool. Quoted because hooks[].command is a shell
 * string — an unquoted /Users/Some Name/... splits into two words and silently
 * never runs, which is strictly worse than the bare name it replaced.
 */
export function absolutizeRtkCommand(command, rtkPath) {
  const p = splitLeadingToken(command);
  if (!p) return String(command);
  return `"${rtkPath.split(path.sep).join('/')}"${p.rest}`;
}

/** The inverse, for uninstall: put rtk's own bare spelling back. */
export function bareRtkCommand(command) {
  const p = splitLeadingToken(command);
  if (!p) return String(command);
  return `rtk${p.rest}`;
}

/**
 * Will the SHELL find and be able to RUN what this command names?
 *
 * Deliberately does not consult CoMind's private bin dir — that is the whole
 * point. Claude Code runs the hook with the user's PATH, so only the user's
 * PATH can answer. Executability, not mere existence: a directory or a file
 * without the exec bit is exactly as unrunnable as a missing one.
 */
export function rtkCommandResolves(command) {
  const p = splitLeadingToken(command);
  if (!p || !p.token) return false;
  if (/[/\\]/.test(p.token)) return isExecutableFile(p.token);
  return !!which(p.token);
}

/** Write the rewritten command back, preserving every other key. */
function patchRtkCommand(settings, file, rewrite) {
  let changed = false;
  for (const group of settings.hooks.PreToolUse) {
    for (const h of Array.isArray(group?.hooks) ? group.hooks : []) {
      if (!isRtkHookCommand(h?.command)) continue;
      const next = rewrite(String(h.command));
      if (next !== h.command) {
        h.command = next;
        changed = true;
      }
    }
  }
  if (changed) writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return changed;
}

/**
 * Point the registered rtk hook at an absolute path. Idempotent; returns what
 * happened so callers can report it.
 */
export function pinRtkHookPath(rtkPath, file = globalSettingsPath()) {
  const settings = readGlobalSettings(file);
  const command = registeredRtkCommand(settings);
  if (!command) return { changed: false, reason: 'no rtk hook registered' };
  if (rtkCommandResolves(command)) return { changed: false, reason: 'already resolvable', command };
  const changed = patchRtkCommand(settings, file, (c) => absolutizeRtkCommand(c, rtkPath));
  return { changed, command: registeredRtkCommand(readGlobalSettings(file)) };
}

/**
 * Undo the pin at uninstall time — WITHOUT leaving a hook that cannot run.
 *
 * Restoring rtk's bare spelling is only correct if a bare `rtk` still resolves.
 * On the machine that needed the pin in the first place it does not: CoMind
 * downloaded rtk into its own directory precisely BECAUSE rtk was not on PATH,
 * and uninstall is about to delete that directory. Reverting there would swap
 * one unrunnable command for another and leave a machine-wide PreToolUse hook
 * failing on every Bash call, in every repo — the exact state doctor reports as
 * FAIL, produced by the command meant to clean up.
 *
 * So: revert if a real `rtk` survives on PATH, otherwise remove the entry
 * outright. Removing is the honest end state — CoMind registered that hook, and
 * nothing is left for it to point at. rtk's other global artifacts (RTK.md, the
 * CLAUDE.md patch) stay rtk's business, still printed for the developer.
 */
export function unpinRtkHookPath(file = globalSettingsPath()) {
  const settings = readGlobalSettings(file);
  if (!registeredRtkCommands(settings).length) {
    return { changed: false, action: 'none', reason: 'no rtk hook registered' };
  }
  if (which('rtk')) {
    const changed = patchRtkCommand(settings, file, bareRtkCommand);
    return { changed, action: 'reverted', command: registeredRtkCommand(readGlobalSettings(file)) };
  }
  const changed = removeRtkHook(settings, file);
  return { changed, action: 'removed' };
}

/** Drop every rtk hook entry, pruning any group left with no hooks. */
function removeRtkHook(settings, file) {
  let changed = false;
  for (const group of settings.hooks.PreToolUse) {
    if (!Array.isArray(group?.hooks)) continue;
    const kept = group.hooks.filter((h) => !isRtkHookCommand(h?.command));
    if (kept.length !== group.hooks.length) {
      group.hooks = kept;
      changed = true;
    }
  }
  // A matcher group with no hooks left is dead weight; anything else in the
  // array (the CoMind gate, another tool's hook) is untouched.
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
    (g) => !Array.isArray(g?.hooks) || g.hooks.length > 0,
  );
  if (changed) writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return changed;
}

/**
 * Register RTK's PreToolUse rewrite hook.
 *
 * `-g` is REQUIRED, not a choice: `rtk init` without it only injects prose into
 * a local CLAUDE.md and installs no hook at all — RTK itself prints
 * "Run: rtk init -g --auto-patch" in that case. So the hook lands in
 * ~/.claude/settings.json and RTK is a MACHINE-LOCAL layer: every developer runs
 * it, nothing about it is committed. Matcher is `Bash` only, which is what keeps
 * it disjoint from CoMind's Edit/Write gate.
 *
 * Registered-ness is decided by reading settings.json, NOT by `rtk init --show`.
 * rtk's report answers "did I write a hook", which stays true while the command
 * it wrote resolves to nothing. The question that matters is whether Claude Code
 * can run it.
 */
export function initRtkHook(ctx) {
  const { repoRoot, log, dryRun } = ctx;
  const { bin } = comindPaths(repoRoot);
  const manual = 'rtk init -g --auto-patch';
  const rtk = which('rtk', [bin]);
  if (!rtk) return SKIP('rtk-hook', 'rtk binary unavailable', manual);

  const registered = registeredRtkCommand(readGlobalSettings());
  if (registered && rtkCommandResolves(registered)) {
    return CACHED('rtk-hook', 'registered (global)');
  }
  if (dryRun) {
    return { name: 'rtk-hook', status: registered ? 'would-repair' : 'would-install' };
  }

  // Repair before install: a hook is already there, it just names something the
  // shell cannot find. Re-running `rtk init` would not fix that.
  if (registered) {
    const pinned = pinRtkHookPath(rtk);
    if (pinned.changed) {
      log?.(`  rtk hook repointed at ${rtk} (it named a binary not on PATH)`);
      return OK('rtk-hook', 'registered (global)', 'per-developer; nothing to commit');
    }
    return FAIL('rtk-hook', `registered command does not resolve: ${registered}`, manual);
  }

  const res = run(rtk, ['init', '-g', '--auto-patch'], { cwd: repoRoot, timeout: 60_000 });
  if (!res.ok) return FAIL('rtk-hook', res.stderr.slice(-300) || `exit ${res.code}`, manual);

  const after = registeredRtkCommand(readGlobalSettings());
  if (!after) {
    const shown = rtkHookInstalled(rtk, repoRoot);
    return FAIL('rtk-hook', `rtk reported: ${shown.line || 'hook still not registered'}`, manual);
  }
  // rtk registers the bare name. That is correct only when rtk is on PATH, and
  // it is not when CoMind downloaded it into its own bin dir.
  pinRtkHookPath(rtk);
  log?.('  rtk rewrite hook registered in ~/.claude/settings.json (machine-local)');
  return OK('rtk-hook', 'registered (global)', 'per-developer; nothing to commit');
}

// --- Caveman --------------------------------------------------------------

/** The pinned install command. Exported so the docs and tests read one source. */
export function cavemanInstallSpec(spec) {
  return `npx -y github:${spec.repo}#${spec.ref}`;
}

/**
 * Install caveman AT THE PIN.
 *
 * `npx github:owner/repo#<commit>` is the primary path because it is the only
 * one that pins. Caveman's own bin/install.js self-pins from the ref it was
 * fetched at (PINNED_REF) and SHA-256-verifies every hook it downloads against
 * the integrity manifest published there — stronger verification than gsd-core
 * or graphify get.
 *
 * `claude plugin install` is the fallback, not the default: it accepts no
 * version, so choosing it as the primary path meant caveman was the one layer
 * CoMind could never pin, which is where the `version-drift` status came from.
 */
export function installCaveman(ctx) {
  const { versions, repoRoot, log, dryRun } = ctx;
  const spec = versions.tools.caveman;
  const pinnedInstall = cavemanInstallSpec(spec);
  const claude = which('claude');

  // Presence is read through the plugin registry either way — caveman installs
  // itself AS a Claude Code plugin regardless of which route put it there.
  const present = claude ? claudePluginVersion(spec.plugin, claude) : null;
  if (present !== null) return cavemanResult(present, spec);

  if (dryRun) return { name: 'caveman', status: 'would-install', version: spec.version };

  // Resolved to an absolute path, never spawned by bare name. `run` inherits
  // cwd from the caller — a repo — and a bare name is looked up relative to the
  // current directory before PATH on some platforms, which would let a clone
  // ship the executable CoMind runs. Every other spawn here already does this.
  const npx = which(npxCmd()) || which('npx');
  if (npx) {
    // No shell: the ref is a hex SHA and the package spec has no metacharacters,
    // so this needs no quoting on any platform.
    const res = run(npx, ['-y', `github:${spec.repo}#${spec.ref}`], {
      cwd: repoRoot,
      timeout: 600_000,
    });
    if (res.ok) {
      log?.(`  caveman ${spec.refTag} installed from the pinned commit (${spec.ref.slice(0, 7)})`);
      return cavemanResult(claude ? (claudePluginVersion(spec.plugin, claude) ?? spec.version) : spec.version, spec);
    }
    log?.(`  pinned install failed (${(res.stderr || res.stdout).slice(-160)}) — trying the plugin marketplace`);
  }

  // Fallback: unpinned by construction. Say so rather than reporting a pin held.
  if (!claude) {
    return SKIP('caveman', 'no npx and no claude CLI on PATH', pinnedInstall);
  }
  const added = run(claude, ['plugin', 'marketplace', 'add', spec.marketplace], { timeout: 120_000 });
  if (!added.ok && !/already/i.test(`${added.stdout}${added.stderr}`)) {
    return FAIL('caveman', `marketplace add failed: ${added.stderr.slice(-200)}`, pinnedInstall);
  }
  const installed = run(claude, ['plugin', 'install', spec.plugin], { timeout: 180_000 });
  if (!installed.ok && !/already/i.test(`${installed.stdout}${installed.stderr}`)) {
    return FAIL('caveman', installed.stderr.slice(-200) || `exit ${installed.code}`, pinnedInstall);
  }
  log?.('  caveman installed via the plugin marketplace — UNPINNED (the marketplace takes no version)');
  return cavemanResult(claudePluginVersion(spec.plugin, claude) ?? 'unknown', spec);
}

function cavemanResult(actual, spec) {
  if (satisfies(actual, spec)) return CACHED('caveman', actual);
  return DRIFT(
    'caveman',
    actual,
    `installed ${actual}, pin is ${spec.version} — reinstall at the pin with: ${cavemanInstallSpec(spec)}`,
  );
}

// --- GSD Core -------------------------------------------------------------

export function installGsdCore(ctx) {
  const { versions, repoRoot, log, dryRun } = ctx;
  const spec = versions.tools['gsd-core'];
  const pinned = `${spec.pkg}@${spec.version}`;
  const manual = `npx -y ${pinned} ${spec.installArgs.join(' ')}`;

  // The version stamp alone is the idempotence signal. Do not gate this on a
  // directory heuristic: gsd-core writes commands as flat `.claude/commands/gsd-*.md`
  // (no `gsd/` subdir), and `.planning/` only appears after /gsd-onboard, so a layout
  // guess would never fire and every run would reinstall.
  const recorded = readGsdVersion(repoRoot);
  if (satisfies(recorded, spec)) return CACHED('gsd-core', recorded);

  if (!which('node')) return SKIP('gsd-core', 'node unavailable', manual);
  const npx = which(npxCmd()) || which('npx');
  if (!npx) return SKIP('gsd-core', 'npx unavailable', manual);
  if (dryRun) return { name: 'gsd-core', status: 'would-install', version: spec.version };

  const res = run(npx, ['-y', pinned, ...spec.installArgs], {
    cwd: repoRoot,
    timeout: 600_000,
  });
  if (!res.ok) {
    const tail = `${res.stderr}\n${res.stdout}`.slice(-400);
    return FAIL('gsd-core', tail || `exit ${res.code}`, manual);
  }
  log?.('  GSD Core installed (project-local). Run /gsd-onboard next.');
  return OK('gsd-core', spec.version);
}

/**
 * JOIN's read-only counterpart to installGsdCore.
 *
 * The gsd-core install is a set of COMMITTED team files (.claude/gsd-*), so a
 * joiner must never rewrite it: a version-drifted comind re-running the
 * installer here would dirty tracked files on a machine whose contract is
 * "touch NO tracked file". Drift is reported for the team to resolve instead.
 */
export function reportGsdDrift(ctx) {
  const { versions, repoRoot } = ctx;
  const spec = versions.tools['gsd-core'];
  const recorded = readGsdVersion(repoRoot);
  if (satisfies(recorded, spec)) return CACHED('gsd-core', recorded);
  if (!recorded) {
    return SKIP(
      'gsd-core',
      'no committed install found in this repo',
      `ask whoever ran FIRST INIT to run \`comind setup\` and commit .claude/gsd-* (pin ${spec.version})`,
    );
  }
  return SKIP(
    'gsd-core',
    `repo pins ${recorded}, this comind pins ${spec.version} — JOIN never rewrites committed files`,
    'align comind versions across the team; FIRST INIT owns the committed install',
  );
}

/**
 * Read gsd-core's installed version.
 *
 * The plain-text `.claude/gsd-core/VERSION` and the `version` field of
 * `.claude/gsd-file-manifest.json` are the reliable stamps (verified against a real
 * v1.8.0 install). This matters for idempotence: when the probe returns null the
 * installer re-runs, gsd-core rewrites its manifest with a fresh timestamp, and a
 * second setup dirties the repo.
 */
export function readGsdVersion(repoRoot) {
  const plain = path.join(repoRoot, '.claude', 'gsd-core', 'VERSION');
  if (existsSync(plain)) {
    try {
      const v = readFileSync(plain, 'utf8').trim();
      if (v) return v;
    } catch {
      /* fall through */
    }
  }
  const jsonFiles = [
    path.join(repoRoot, '.claude', 'gsd-file-manifest.json'),
    path.join(repoRoot, '.planning', 'config.json'),
  ];
  for (const file of jsonFiles) {
    if (!existsSync(file)) continue;
    try {
      const json = JSON.parse(readFileSync(file, 'utf8'));
      const v = json.version || json.gsd_version || json.gsdCoreVersion;
      if (v) return String(v);
    } catch {
      /* try next */
    }
  }
  return null;
}

// --- graphify -------------------------------------------------------------

export function installGraphify(ctx) {
  const { versions, log, dryRun } = ctx;
  const spec = versions.tools.graphifyy;
  const pinned = `${spec.pkg}==${spec.version}`;
  const manual = `uv tool install ${pinned}   # or: python3 -m pip install ${pinned}`;

  const current = probeVersion(spec.binName, ['--version']);
  if (satisfies(current, spec)) return CACHED('graphifyy', current);

  if (dryRun) return { name: 'graphifyy', status: 'would-install', version: spec.version };

  const uv = which('uv');
  if (uv) {
    const res = run(uv, ['tool', 'install', '--force', pinned], { timeout: 600_000 });
    if (res.ok) {
      log?.('  graphify installed via uv');
      return OK('graphifyy', spec.version);
    }
  }

  const py = which('python3') || which('python');
  if (!py) return SKIP('graphifyy', 'no uv and no python3 on PATH', manual);

  let res = run(py, ['-m', 'pip', 'install', pinned], { timeout: 600_000 });
  if (!res.ok) {
    // PEP 668 externally-managed environments need the explicit override.
    res = run(py, ['-m', 'pip', 'install', '--break-system-packages', pinned], { timeout: 600_000 });
  }
  if (!res.ok) return FAIL('graphifyy', res.stderr.slice(-300) || `exit ${res.code}`, manual);
  log?.('  graphify installed via pip');
  return OK('graphifyy', spec.version);
}

/**
 * Register graphify's union merge driver for graph.json.
 *
 * The committed .gitattributes claims `merge=graphify`; the driver body it names
 * is git config, which is per-machine and cannot travel in the repo. Only half
 * the mechanism is shareable, so this runs on JOIN too — a teammate missing it
 * gets "unknown merge driver" and a raw conflict on a file nobody can hand-merge.
 *
 * Registered by path, not by name: `graphify merge-driver` on PATH is enough
 * only while PATH is right at merge time, and git runs the driver through a
 * shell, so the quoting matters on any profile path containing a space.
 */
export function registerGraphMergeDriver(ctx) {
  const { repoRoot, dryRun, versions } = ctx;
  const name = 'graph-merge-driver';

  if (!existsSync(path.join(repoRoot, '.git'))) {
    return SKIP(name, 'not a git repository', null);
  }

  const bin = which(versions.tools.graphifyy.binName);
  // Falling back to the bare launcher keeps the driver registered on a machine
  // where graphify is not installed YET: it resolves at merge time instead of
  // install time, which is the only failure mode we can still recover from.
  const driver = `${bin ? `"${bin}"` : 'graphify'} merge-driver %O %A %B`;
  const manual = `git config merge.graphify.driver '${driver}'`;

  // Absolute path, not the bare name: `run` has no cwd of its own and inherits
  // the repo the developer invoked CoMind from. Resolving a bare name can
  // consult the current directory ahead of PATH, which would let a cloned repo
  // decide what executable CoMind runs — including on the read-only probe
  // below, which happens before the dry-run gate.
  const git = which('git');
  if (!git) return SKIP(name, 'git not on PATH', manual);

  const existing = run(git, ['-C', repoRoot, 'config', '--get', 'merge.graphify.driver']);
  if (existing.ok && existing.stdout === driver) return CACHED(name, 'registered');
  if (dryRun) return { name, status: 'would-register', detail: driver };

  for (const [key, value] of [
    ['merge.graphify.name', 'graphify graph.json union merge'],
    ['merge.graphify.driver', driver],
  ]) {
    const res = run(git, ['-C', repoRoot, 'config', key, value]);
    if (!res.ok) return FAIL(name, res.stderr.slice(-200) || `exit ${res.code}`, manual);
  }
  return OK(name, 'registered', 'graph.json conflicts union-merge');
}

/**
 * Re-render graphify-out/graph.html from the committed graph.
 *
 * graph.html is the one graphify output CoMind deliberately does not commit: it
 * is large, it churns wholesale on every build, and no merge driver covers it.
 * That is only defensible because regenerating it is free — `graphify export
 * html` reads graph.json and the two committed sidecars and calls the renderer,
 * with no model call anywhere in the path. So a clone gets it here instead.
 *
 * Every failure is a SKIP. The vault is what /comind-sync exists to produce; a
 * missing viewer must not fail the command that rebuilt the team's brain.
 */
export function renderGraphHtml(ctx) {
  const { repoRoot, dryRun, versions } = ctx;
  const name = 'graph-html';
  const outDir = path.join(repoRoot, 'graphify-out');

  if (!existsSync(path.join(outDir, 'graph.json'))) {
    return SKIP(name, 'no graphify-out/graph.json — run /gsd-graphify build', null);
  }
  const bin = which(versions.tools.graphifyy.binName);
  if (!bin) return SKIP(name, 'graphify not on PATH', MANUAL_EXPORT);
  if (dryRun) return { name, status: 'would-render' };

  const res = run(bin, ['export', 'html'], { cwd: repoRoot, timeout: 300_000 });
  if (!res.ok) return SKIP(name, res.stderr.slice(-200) || `exit ${res.code}`, MANUAL_EXPORT);
  return OK(name, null, 'graphify-out/graph.html re-rendered');
}

/**
 * Turn on GSD's native graphify integration.
 *
 * CoMind does not re-wire graphify: gsd-core already ships /gsd-graphify and
 * writes to .planning/graphs/. We only flip the opt-in flag, via a JSON
 * round-trip that preserves every key we don't own so gsd-core upgrades that
 * add config keys are not clobbered.
 */
export function enableGsdGraphify(ctx) {
  const { repoRoot, dryRun } = ctx;
  const cfgPath = path.join(repoRoot, '.planning', 'config.json');
  if (!existsSync(cfgPath)) {
    return SKIP(
      'graphify-config',
      '.planning/config.json absent — run /gsd-onboard first',
      'set graphify.enabled = true in .planning/config.json',
    );
  }

  let cfg;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (err) {
    return FAIL('graphify-config', `unparseable config.json: ${err.message}`);
  }

  const before = JSON.stringify(cfg);
  cfg.graphify = { ...(cfg.graphify || {}) };
  if (cfg.graphify.enabled !== true) cfg.graphify.enabled = true;
  if (cfg.graphify.build_timeout == null) cfg.graphify.build_timeout = 600;

  if (JSON.stringify(cfg) === before) return CACHED('graphify-config', 'enabled');
  if (dryRun) return { name: 'graphify-config', status: 'would-update' };

  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return OK('graphify-config', 'enabled', 'graphify.enabled = true');
}

// --- LSP servers ----------------------------------------------------------

export function installLspServers(ctx) {
  const { versions, languages, log, dryRun } = ctx;
  const wanted = [];
  if (languages.typescript) {
    wanted.push(versions.tools.typescript, versions.tools['typescript-language-server']);
  }
  if (languages.python) wanted.push(versions.tools.pyright);

  if (!wanted.length) {
    return SKIP('lsp-servers', 'no TypeScript or Python sources detected', null);
  }

  const pinnedArgs = wanted.map((s) => `${s.pkg}@${s.version}`);
  const manual = `npm i -g ${pinnedArgs.join(' ')}`;

  // Every spec here must declare binName, because that is how the installed version
  // is probed. Treating a missing one as "assume not installed" would make the layer
  // never skip — a global `npm install -g` on every setup. Fail loudly instead.
  const undeclared = wanted.filter((s) => !s.binName);
  if (undeclared.length) {
    return FAIL(
      'lsp-servers',
      `versions.json is missing binName for: ${undeclared.map((s) => s.pkg).join(', ')}`,
      manual,
    );
  }

  // pyright's langserver binary does not always answer --version; without the
  // `pyright` fallback (which the drift probe already uses) the layer could
  // never report already-pinned and npm install -g re-ran on every setup.
  const probeSpec = (spec) =>
    probeVersion(spec.binName, ['--version']) ||
    (spec.binName === 'pyright-langserver' ? probeVersion('pyright', ['--version']) : null);
  const missing = wanted.filter((spec) => !satisfies(probeSpec(spec), spec));
  if (!missing.length) {
    return CACHED('lsp-servers', wanted.map((s) => s.version).join(', '));
  }

  const npm = which(npmCmd()) || which('npm');
  if (!npm) return SKIP('lsp-servers', 'npm unavailable', manual);
  if (dryRun) return { name: 'lsp-servers', status: 'would-install', version: pinnedArgs.join(' ') };

  const res = run(npm, ['install', '-g', ...pinnedArgs], { timeout: 900_000 });
  if (!res.ok) return FAIL('lsp-servers', res.stderr.slice(-300) || `exit ${res.code}`, manual);
  log?.(`  installed ${pinnedArgs.join(', ')}`);
  return OK('lsp-servers', pinnedArgs.join(', '));
}

/**
 * Ensure the repo-local and machine-local CoMind dirs exist.
 * Only `.comind/{,state}` is inside the repo; bin/ and cache/ are under ~/.claude.
 */
export function ensureComindDirs(repoRoot, dryRun = false) {
  const p = comindPaths(repoRoot);
  if (dryRun) return p;
  for (const dir of [p.base, p.state, p.bin, p.cache]) mkdirSync(dir, { recursive: true });
  return p;
}
