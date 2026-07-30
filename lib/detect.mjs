// FIRST INIT vs JOIN detection, and the committed manifest contract.
//
// FIRST INIT — no .comind/manifest.json in the repo. This developer is the one
//   bootstrapping the shared brain: scaffold everything, write tracked files.
// JOIN      — a teammate already committed a manifest. Install machine-local
//   runtimes only and touch NO tracked file, so `git status` stays clean.

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { run, comindPaths, which, loadVersions, satisfies } from './platform.mjs';
import { detectLspLanguages, lspLanguages } from './lsp.mjs';

export const MODE = {
  FIRST_INIT: 'FIRST INIT',
  JOIN: 'JOIN',
};

/** Walk up from `start` to find the git root; fall back to `start`. */
export function findRepoRoot(start = process.cwd()) {
  const git = which('git');
  if (git) {
    const res = run(git, ['rev-parse', '--show-toplevel'], { cwd: start, timeout: 15_000 });
    if (res.ok && res.stdout) return path.resolve(res.stdout);
  }
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

export function isGitRepo(repoRoot) {
  return existsSync(path.join(repoRoot, '.git'));
}

export function readManifest(repoRoot) {
  const { manifest } = comindPaths(repoRoot);
  if (!existsSync(manifest)) return null;
  try {
    return JSON.parse(readFileSync(manifest, 'utf8'));
  } catch {
    // A corrupt manifest must not be silently treated as "no manifest" — that
    // would send a joining developer down the bootstrap path and dirty the repo.
    return { __corrupt: true };
  }
}

/**
 * Decide the mode. `force` pins it explicitly for recovery
 * (`--join` / `--force` on the CLI).
 */
/**
 * Where did the manifest come from: a teammate's commit, or this machine?
 *
 * JOIN means "someone else set this up and committed it". Keying on the file
 * merely existing made the first developer's own second run a JOIN. But the
 * inverse error is worse: reading "git said no" as "not committed" turns a real
 * clone into a FIRST INIT that rewrites the team's tracked files, which is
 * exactly what git does in a bind-mounted or root-owned checkout ("detected
 * dubious ownership", exit 128).
 *
 * So three answers, and `unknown` resolves toward the safe side (JOIN):
 *   committed — present in HEAD. A teammate's.
 *   local     — this machine wrote it (or there is no repo, so nobody could
 *               have committed anything).
 *   unknown   — there IS a repo but git will not answer. Never assume it is
 *               ours; JOIN writes no tracked file, so guessing JOIN is free.
 *
 * HEAD, not the index: `git ls-files` matches a staged-but-uncommitted file,
 * and staging before committing is exactly what the first developer does.
 */
export function manifestProvenance(repoRoot) {
  const git = which('git');
  // No repo at all: there are no tracked files and no teammates.
  if (!isGitRepo(repoRoot)) return 'local';
  if (!git) return 'unknown';

  const inHead = run(git, ['cat-file', '-e', 'HEAD:.comind/manifest.json'], {
    cwd: repoRoot,
    timeout: 30_000,
  });
  if (inHead.ok) return 'committed';

  // Distinguish "not in HEAD" (a fresh repo, or our own uncommitted file) from
  // "git refuses to operate here" — only the first means the manifest is ours.
  const usable = run(git, ['rev-parse', '--git-dir'], { cwd: repoRoot, timeout: 30_000 });
  return usable.ok ? 'local' : 'unknown';
}

export function detectMode(repoRoot, force = null) {
  const manifest = readManifest(repoRoot);
  if (force === 'join') return { mode: MODE.JOIN, manifest, forced: true };
  if (force === 'first') return { mode: MODE.FIRST_INIT, manifest, forced: true };

  if (manifest && manifest.__corrupt) {
    return {
      mode: MODE.JOIN,
      manifest,
      corrupt: true,
      note: '.comind/manifest.json is unreadable. Treating as JOIN to avoid dirtying tracked files. Re-run with --force to rebuild it.',
    };
  }
  if (!manifest) return { mode: MODE.FIRST_INIT, manifest, forced: false };

  const provenance = manifestProvenance(repoRoot);
  if (provenance === 'committed') return { mode: MODE.JOIN, manifest, forced: false };
  if (provenance === 'unknown') {
    return {
      mode: MODE.JOIN,
      manifest,
      forced: false,
      note: 'git could not be queried in this repository, so whether .comind/manifest.json is a teammate\'s commit is unknown. Treating as JOIN, which touches no tracked file. Re-run with --force if this machine really is doing the first init.',
    };
  }
  return {
    mode: MODE.FIRST_INIT,
    manifest,
    forced: false,
    note: '.comind/manifest.json exists but is not committed — continuing FIRST INIT (this machine wrote it). Commit it, and every later run here and for teammates is JOIN.',
  };
}

/**
 * Which languages this repo contains, as a flat boolean map.
 *
 * One detection table, in versions.json, shared with the LSP layer — two
 * independent notions of "this repo is TypeScript" would drift, and the LSP
 * plugin set has to agree with the npm servers CoMind installs.
 */
export function detectLanguages(repoRoot, versions = loadVersions()) {
  const out = {};
  for (const lang of lspLanguages(versions)) out[lang] = false;
  for (const { lang } of detectLspLanguages(repoRoot, versions)) out[lang] = true;
  return out;
}

/**
 * Compare what is installed against the pinned manifest.
 * Returns a list of drift records — never mutates anything.
 */
export function diffVersions(pinned, installed) {
  const drift = [];
  for (const [name, spec] of Object.entries(pinned.tools)) {
    const got = installed[name] ?? null;
    if (got === null) {
      drift.push({ tool: name, want: spec.version, got: null, kind: 'missing' });
    } else if (got === 'unknown') {
      // Present, but the tool exposes no probeable version. Neither a match nor
      // a mismatch — reporting it either way would be a guess.
      drift.push({ tool: name, want: spec.version, got: 'unknown', kind: 'unverifiable' });
    } else if (!satisfies(got, spec)) {
      // A floor-policy tool NEWER than the pin is not drift: it satisfies the
      // contract. Reporting it would train developers to ignore the drift block.
      drift.push({ tool: name, want: spec.version, got, kind: 'mismatch' });
    }
  }
  return drift;
}

/** Write the committed contract. FIRST INIT only. */
export function writeManifest(repoRoot, { versions, layers, languages }) {
  const { base, manifest } = comindPaths(repoRoot);
  mkdirSync(base, { recursive: true });

  // Deterministic key order so re-running produces no diff.
  const body = {
    comind: versions.comind,
    vaultSchema: versions.vaultSchema,
    tools: Object.fromEntries(
      Object.keys(versions.tools)
        .sort()
        .map((k) => [k, versions.tools[k].version]),
    ),
    layers: Object.fromEntries(Object.keys(layers).sort().map((k) => [k, layers[k]])),
    // Every detected language, sorted — the LSP layer is no longer TS/Python only,
    // and a manifest that recorded two of twelve would misreport the team's repo.
    languages: Object.fromEntries(
      Object.keys(languages).sort().map((k) => [k, !!languages[k]]),
    ),
    _note: 'Committed contract. A teammate installs CoMind (npx -y comind@latest) then runs /comind-init, and gets exactly these versions. Do not hand-edit — bump versions.json and re-run setup.',
  };
  writeFileSync(manifest, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return manifest;
}
