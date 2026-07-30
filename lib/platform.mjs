// Platform detection, tool probing, and child-process spawning.
// Every OS-specific decision in CoMind lives here. Node built-ins only.

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const IS_WINDOWS = process.platform === 'win32';
export const PLATFORM_KEY = `${process.platform}-${process.arch}`;

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Read the pinned version manifest. The only place versions come from. */
export function loadVersions() {
  return JSON.parse(readFileSync(path.join(PKG_ROOT, 'versions.json'), 'utf8'));
}

/**
 * The remediation commands, as a single source of truth.
 *
 * The two-stage split makes this distinction load-bearing: `npx @comind-dev/comind` installs
 * CoMind itself and nothing else, so naming it as the fix for a missing rtk binary
 * or an unbuilt graph would send the user in a loop — they run it, nothing
 * changes, and the same check fails again. Keep every remediation string here
 * rather than inline, so the wrong one cannot be written by accident.
 *
 *   stage1 — installs CoMind. Wires the slash commands. Touches no repo.
 *   setup  — installs the pinned tools, hooks, LSP config, ignore blocks.
 *   sync   — rebuilds the knowledge graph and the .ai-memory vault.
 */
export const FIX = {
  stage1: 'npx -y @comind-dev/comind@latest',
  setup: '/comind-init   (or: comind setup)',
  sync: '/comind-sync',
};

/**
 * Extension candidates for `which`, pure for testability.
 *
 * On Windows the bare name is probed only when it already carries a PATHEXT
 * extension (so `which('npm.cmd')` can succeed). Probing it otherwise would
 * resolve the extensionless POSIX sh scripts Node ships right next to
 * npm.cmd/npx.cmd — files cmd.exe cannot execute.
 */
export function whichExts(cmd, isWindows = IS_WINDOWS, pathext = process.env.PATHEXT) {
  if (!isWindows) return [''];
  const exts = (pathext || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const carriesExt = exts.some((e) => cmd.toUpperCase().endsWith(e.toUpperCase()));
  return carriesExt ? ['', ...exts] : exts;
}

export function isExecutableFile(p) {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    // Real PATH resolution skips non-executable entries and keeps searching;
    // Windows has no exec bit, the extension is the permission.
    return IS_WINDOWS || (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Resolve a command to an absolute path, honouring Windows' PATHEXT.
 * Only regular, executable files count — a directory or a chmod-less leftover
 * named like the binary must not shadow a working one later in PATH.
 * Returns null when not found. Never throws.
 */
export function which(cmd, extraPaths = []) {
  const pathVar = process.env.PATH || process.env.Path || '';
  const dirs = [...extraPaths, ...pathVar.split(path.delimiter)].filter(Boolean);
  const exts = whichExts(cmd);

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Quote one token for a cmd.exe command line. Tokens that could defeat the
 * quoting are rejected outright: `"` and newlines break the token apart, and
 * `%` expands environment variables even inside double quotes. No CoMind call
 * site produces them, so hitting this is an upstream bug, not input to
 * accommodate.
 */
export function winQuote(token) {
  const s = String(token);
  if (/["%\r\n]/.test(s)) {
    throw new Error(`refusing to quote for cmd.exe: ${JSON.stringify(s)}`);
  }
  return /^[A-Za-z0-9._\\/:=@+-]+$/.test(s) ? s : `"${s}"`;
}

/**
 * The single command line used to run a `.cmd`/`.bat` shim through cmd.exe.
 * Pure, so the Windows spawn path is unit-testable on any OS.
 */
export function winCommandLine(cmd, args = []) {
  return [cmd, ...args].map(winQuote).join(' ');
}

/**
 * Run a command and capture output. Never throws; always returns a result object.
 *
 * `shell` is false so paths with spaces are safe — except for Windows
 * `.cmd`/`.bat` shims: patched Node (CVE-2024-27980, ≥18.20.1/20.12.1/21.7.2)
 * refuses those with shell:false, throwing EINVAL synchronously. Shims go
 * through cmd.exe as one explicitly quoted command line instead.
 */
export function run(cmd, args = [], opts = {}) {
  try {
    const isShim = IS_WINDOWS && /\.(cmd|bat)$/i.test(cmd);
    const res = spawnSync(isShim ? winCommandLine(cmd, args) : cmd, isShim ? [] : args, {
      encoding: 'utf8',
      shell: isShim,
      windowsHide: true,
      timeout: opts.timeout ?? 300_000,
      cwd: opts.cwd ?? process.cwd(),
      // Non-TTY stdin: installers that would prompt fall back to defaults or fail
      // fast instead of hanging a scripted run.
      stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.env || {}) },
    });
    return {
      ok: res.status === 0,
      code: res.status,
      stdout: (res.stdout || '').trim(),
      stderr: (res.stderr || '').trim(),
      error: res.error || null,
    };
  } catch (err) {
    return { ok: false, code: null, stdout: '', stderr: '', error: err };
  }
}

/** `npx` is a .cmd shim on Windows; naming it lets run() route it via cmd.exe. */
export function npxCmd() {
  return IS_WINDOWS ? 'npx.cmd' : 'npx';
}
export function npmCmd() {
  return IS_WINDOWS ? 'npm.cmd' : 'npm';
}

/**
 * Probe a tool's version. Returns a normalized semver-ish string or null.
 * Version output is wildly inconsistent across tools, so pull the first
 * dotted-numeric token rather than trusting any single format.
 */
export function probeVersion(cmd, args = ['--version'], extraPaths = []) {
  return probeVersionAt(which(cmd, extraPaths), args);
}

/** probeVersion for an already-resolved binary path. */
export function probeVersionAt(binPath, args = ['--version']) {
  if (!binPath) return null;
  const res = run(binPath, args, { timeout: 20_000 });
  const text = `${res.stdout}\n${res.stderr}`;
  const m = text.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/);
  return m ? m[1] : null;
}

/** Strip a leading `v` so `v0.1.1` and `0.1.1` compare equal. */
export function normalizeVersion(v) {
  return v ? String(v).trim().replace(/^v/, '') : null;
}

export function versionsMatch(a, b) {
  const na = normalizeVersion(a);
  const nb = normalizeVersion(b);
  return !!na && !!nb && na === nb;
}

/** Numeric semver comparison. Pre-release suffixes sort below their release. */
export function compareVersions(a, b) {
  const parts = (v) => {
    const [core, pre] = String(normalizeVersion(v) || '').split('-');
    return [core.split('.').map((n) => parseInt(n, 10) || 0), pre || null];
  };
  const [pa, prea] = parts(a);
  const [pb, preb] = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (prea === preb) return 0;
  if (prea && !preb) return -1;
  if (!prea && preb) return 1;
  return prea < preb ? -1 : 1;
}

/**
 * Is `installed` acceptable for `spec`?
 *
 * Pinning is not one decision; it is one per tool, and they have different
 * answers. `policy: "exact"` is for anything whose divergence corrupts the
 * shared repo — rtk is a binary CoMind executes, gsd-core writes COMMITTED
 * files, caveman installs hooks into ~/.claude. `policy: "floor"` is for
 * machine-local tools whose output is derived: nobody's repo changes because a
 * teammate has a newer graphify.
 *
 * The floor still answers "is this already installed?", which is the load-
 * bearing half — without some predicate every setup reinstalls, and a gsd-core
 * reinstall rewrites its manifest with a fresh timestamp, so a second run
 * dirties the repo and the byte-identical invariant dies.
 */
export function satisfies(installed, spec) {
  if (!installed) return false;
  if (installed === 'unknown') return false;
  return (spec?.policy ?? 'exact') === 'floor'
    ? compareVersions(installed, spec.version) >= 0
    : versionsMatch(installed, spec.version);
}

/**
 * The one directory CoMind owns under the user's home.
 *
 * THE single literal. It used to be spelled independently here and in
 * install-plugin.mjs, and the two spellings drifted into overlapping
 * subdirectories: the stage-1 payload's `bin/` landed on the same path as the
 * downloaded rtk binary, so every `npx @comind-dev/comind` deleted rtk as a stale artifact.
 * Neither file was wrong when read alone, which is exactly why file-by-file
 * review never found it. Anything that needs a path under here derives it from
 * this function.
 */
export function comindHome() {
  return path.join(os.homedir(), '.claude', 'comind');
}

/** Where CoMind keeps machine-local, gitignored state inside a consuming repo. */
export function comindPaths(repoRoot) {
  const base = path.join(repoRoot, '.comind');
  // bin/ and cache/ live OUTSIDE the repo, under the user's home.
  //
  // They used to sit at .comind/bin and .comind/cache — inside the working tree,
  // where a cloned repo could ship a binary CoMind would then execute. That
  // needed a whole SHA-256 trust store to make safe. Putting the binary where no
  // repo can write it removes the attack instead of guarding it, and a machine
  // with five CoMind repos now downloads rtk once rather than five times.
  const home = comindHome();
  return {
    base,
    manifest: path.join(base, 'manifest.json'),
    state: path.join(base, 'state'),
    bin: path.join(home, 'bin'),
    cache: path.join(home, 'cache'),
    home,
  };
}

export function homeDir() {
  return os.homedir();
}

/**
 * True on musl-libc Linux (Alpine and friends). Node's process report carries
 * `glibcVersionRuntime` only when linked against glibc, which is the one
 * dependable signal that doesn't involve shelling out to ldd.
 */
export function isMuslLinux() {
  if (process.platform !== 'linux') return false;
  try {
    return !process.report?.getReport?.()?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

// NOTE: path containment lives in templates/team/hooks/comind-gate.mjs, not here.
// The gate is copied into consuming repos and cannot import from lib/, so it
// carries its own canon()/isInside(). A second copy here served nothing but the
// illusion of a shared helper.
