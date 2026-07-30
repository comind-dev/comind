// The interactive git informer.
//
// Printed at the end of every run. The COMMIT list is computed from real disk
// state — `git status --porcelain` intersected with CoMind's managed paths — so
// it can never claim a file exists that doesn't, or miss one gsd-core created.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { run, which, FIX, PLATFORM_KEY } from './platform.mjs';
import { MODE } from './detect.mjs';

/** Paths CoMind is responsible for, with why each one belongs in Git. */
export const MANAGED_COMMIT_PATHS = [
  ['.comind/manifest.json', 'contract: pinned versions + enabled layers'],
  ['.planning/', 'GSD specs, phases, roadmap, config'],
  ['.ai-memory/', 'derived Obsidian vault (markdown only)'],
  ['.claude/settings.json', 'gate hook + project-scope plugin declaration'],
  ['.claude/hooks/', 'comind-gate.mjs'],
  ['.claude/skills/', 'caveman-gsd profile'],
  ['.claude/commands/', 'GSD + CoMind slash commands'],
  ['.claude/agents/', 'GSD subagent definitions'],
  ['.claude/gsd-core/', 'the GSD engine the committed gsd-* commands invoke'],
  // gsd-core's engine does `require('../../../scripts/…')` from
  // gsd-core/bin/lib/, so scripts/ is not an optional extra — without it
  // gsd-tools.cjs throws MODULE_NOT_FOUND and every gsd-* command is dead.
  ['.claude/scripts/', 'helper scripts gsd-core/bin requires by relative path'],
  // Pins CommonJS for gsd-core's .js hooks. In a repo whose own package.json
  // says "type":"module" they otherwise throw "require is not defined in ES
  // module scope" — the same failure that killed the file-copy fallback.
  ['.claude/package.json', 'marks .claude/ CommonJS so gsd-core\'s .js hooks load'],
  ['.claude/gsd-file-manifest.json', "gsd-core's install stamp — JOIN reads it and never reinstalls"],
  ['.gitignore', 'comind managed block'],
  ['.gitattributes', 'eol=lf + the graph.json union merge driver'],
  ['graphify-out/graph.json', 'the queryable graph — a clone can query without rebuilding'],
  ['graphify-out/GRAPH_REPORT.md', 'graph highlights (also mirrored into the vault)'],
  ['graphify-out/manifest.json', "graphify's extraction record — without it a clone re-extracts everything"],
  ['graphify-out/.graphify_labels.json', 'LLM-generated community names — re-earning these costs API calls'],
  ['graphify-out/.graphify_analysis.json', 'cohesion + god nodes for the viz'],
];

export const NEVER_COMMIT_PATHS = [
  ['.comind/state/', 'session counters + gate bypass log'],
  ['graphify-out/graph.html', 'free local render of graph.json — /comind-sync rebuilds it'],
  ['graphify-out/cache/', 'extraction cache — large, and worthless on another machine'],
  ['graphify-out/cost.json', "this machine's API spend"],
  ['.claude/settings.local.json', "gsd-core hooks — contain this machine's absolute node path"],
  ['.claude/gsd-install-state.json', "gsd-core's migration log — stamped with this machine's clock"],
];

/**
 * Layers that live outside the repo entirely. Each developer's own setup run
 * installs these; nothing about them is committed, so the informer names them
 * explicitly rather than leaving a teammate wondering why RTK.md isn't in Git.
 */
export const MACHINE_LOCAL_LAYERS = [
  ['comind itself', 'Claude Code plugin cache (or ~/.claude/comind/pkg on the fallback)'],
  ['rtk binary', '~/.claude/comind/bin (shared by every repo on this machine)'],
  ['rtk hook + RTK.md', '~/.claude/settings.json and ~/.claude/RTK.md (rtk init -g)'],
  ['caveman plugin', 'Claude Code plugin cache'],
  ['LSP plugins', 'Claude Code plugin cache (per language)'],
  ['typescript-language-server, pyright', 'global npm prefix'],
  ['graphify', 'uv tool / pip site-packages'],
];

/**
 * Porcelain status lines, or null when this isn't a git repo.
 *
 * Parsed by regex, not fixed offsets. Porcelain v1 writes a 2-column status
 * (` M path` for an unstaged modification), but run() trims its output, so the
 * FIRST line loses its leading space and a slice(3) then ate the first
 * character of the path — `.comind/x` became `comind/x`, which no managed-path
 * check could ever match.
 */
export function parsePorcelain(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Z?!]{1,2})\s+(.+)$/))
    .filter(Boolean)
    .map((m) => ({ code: m[1], file: m[2].replace(/^"|"$/g, '') }));
}

function porcelain(repoRoot) {
  const git = which('git');
  if (!git) return null;
  const res = run(git, ['status', '--porcelain'], { cwd: repoRoot, timeout: 30_000 });
  if (!res.ok) return null;
  return parsePorcelain(res.stdout);
}

function pad(s, n) {
  return String(s).length >= n ? String(s) : String(s) + ' '.repeat(n - String(s).length);
}

/**
 * Render the informer. Returns the string rather than printing, so the slash
 * command and the CLI can present it however they need.
 */
export function renderInformer({ repoRoot, mode, versions, results, drift = [], vault }) {
  const L = [];
  const status = porcelain(repoRoot);
  const pinLine = Object.entries(versions.tools)
    .map(([k, v]) => `${k} ${v.version}`)
    .join(' · ');

  L.push('');
  L.push('='.repeat(72));
  L.push(`  COMIND SETUP COMPLETE — mode: ${mode} — platform: ${PLATFORM_KEY}`);
  L.push('='.repeat(72));
  L.push('');
  L.push('  Pinned:');
  for (const chunk of chunkWords(pinLine, 62)) L.push(`    ${chunk}`);
  L.push('');

  // --- layer report ---
  L.push('  LAYERS');
  for (const r of results) {
    const icon =
      r.status === 'ok' || r.status === 'already-pinned'
        ? 'ok  '
        : r.status === 'skipped'
          ? 'skip'
          : r.status === 'version-drift' || r.status === 'present-unverified'
            ? 'warn'
            : r.status.startsWith('would')
              ? 'plan'
              : 'FAIL';
    const detail = r.reason || r.version || r.note || '';
    L.push(`    [${icon}] ${pad(r.name, 22)} ${detail}`);
    if (r.manual && r.status !== 'ok' && r.status !== 'already-pinned') {
      L.push(`           ↳ run by hand: ${r.manual}`);
    }
  }
  L.push('');

  if (drift.length) {
    // On FIRST INIT (and any dry run) nothing is installed yet, so "drift" would
    // be a misleading label — there is no committed manifest to drift from.
    const firstInit = mode === MODE.FIRST_INIT;
    L.push(firstInit ? '  NOT YET AT PINNED VERSIONS' : '  VERSION DRIFT vs the pinned contract');
    for (const d of drift) {
      const got = d.kind === 'unverifiable' ? 'present (version not probeable)' : (d.got ?? '(none)');
      L.push(`    ${pad(d.tool, 26)} pinned ${pad(d.want, 10)} installed ${got}`);
    }
    L.push(
      firstInit
        ? `    Expected before the first real run. \`${FIX.setup}\` converges these.`
        : `    Re-run \`${FIX.setup}\` to converge, or bump versions.json deliberately.`,
    );
    L.push('');
  }

  if (vault?.ok && vault.stats) {
    const s = vault.stats;
    L.push(
      `  VAULT  ${s.notes} notes — ${s.phases} phase(s), ${s.specs} spec(s), ` +
        `${s.decisions} decision(s), graph: ${s.graph ? 'yes' : 'not built'}`,
    );
    L.push('');
  } else if (vault && !vault.ok) {
    L.push(`  VAULT  skipped — ${vault.reason}`);
    L.push('');
  }

  // --- the git informer proper ---
  if (mode === MODE.JOIN) {
    L.push('  GIT — nothing to commit');
    L.push('');
    L.push('    You joined an existing CoMind repo. Only machine-local files were');
    L.push('    written, so tracked files are untouched. Verify with:');
    L.push('');
    L.push('      git status --porcelain      # expected: no comind paths listed');
    L.push('');
    // Only MODIFIED tracked files matter here. An untracked path cannot change
    // the shared contract until someone adds it, and flagging `??` entries turns
    // a normal working tree into a false alarm.
    const dirty = (status || []).filter((s) => isManaged(s.file) && s.code !== '??');
    if (dirty.length) {
      L.push('    These tracked, shared paths are locally MODIFIED. JOIN writes no');
      L.push('    tracked file, so the edits predate this run or came from another');
      L.push('    tool. Do not commit them unless you mean to change the team contract:');
      for (const d of dirty) L.push(`      ${d.code}  ${d.file}`);
      L.push('');
    }
  } else {
    const present = MANAGED_COMMIT_PATHS.filter(([p]) => existsSync(path.join(repoRoot, p)));
    const absent = MANAGED_COMMIT_PATHS.filter(([p]) => !existsSync(path.join(repoRoot, p)));

    L.push('  GIT — COMMIT THESE (preserves team-wide continuity)');
    L.push('');
    for (const [p, why] of present) L.push(`    ${pad(p, 36)} ${why}`);
    if (absent.length) {
      L.push('');
      L.push('    Not on disk yet (created by a later step — re-run after):');
      for (const [p, why] of absent) L.push(`    ${pad(p, 36)} ${why}`);
    }
    L.push('');
    L.push('  GIT — NEVER COMMIT (machine-local, regenerated on clone)');
    L.push('');
    for (const [p, why] of NEVER_COMMIT_PATHS) L.push(`    ${pad(p, 36)} ${why}`);
    L.push('');
    L.push('    Already covered by the comind managed block in .gitignore.');
    L.push('');
    L.push('  NOT IN THE REPO AT ALL (installed per developer by /comind-init)');
    L.push('');
    for (const [what, where] of MACHINE_LOCAL_LAYERS) L.push(`    ${pad(what, 34)} ${where}`);
    L.push('');
    L.push('  NEXT');
    L.push('');
    if (present.length) {
      L.push(`      git add ${present.map(([p]) => p).join(' ')}`);
      L.push('      git commit -m "chore: init CoMind — shared AI context"');
    }
    L.push('');
    // Two steps, not one: stage 1 installs CoMind but configures nothing, so a
    // teammate told only to run it ends up with the slash commands and no tools.
    L.push('    Then every teammate, once:');
    L.push(`      ${FIX.stage1}      install CoMind itself`);
    L.push('      /comind-init              configures their machine only');
    L.push('    JOIN is auto-detected; no tracked file is touched.');
    L.push('');
  }

  if (status === null) {
    L.push('  NOTE  not a git repository — run `git init` to share this setup.');
    L.push('');
  }
  L.push('='.repeat(72));
  L.push('');
  return L.join('\n');
}

function isManaged(file) {
  const f = file.split(path.sep).join('/');
  return MANAGED_COMMIT_PATHS.some(([p]) => f === p || f.startsWith(p.replace(/\/$/, '/')));
}

function chunkWords(text, width) {
  const words = text.split(' ');
  const out = [];
  let line = '';
  for (const w of words) {
    if ((line + w).length > width) {
      out.push(line.trim());
      line = '';
    }
    line += `${w} `;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}
