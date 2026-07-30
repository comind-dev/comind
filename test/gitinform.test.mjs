// The git informer is the last thing a developer reads, and the only instruction
// they are likely to act on. Wrong content here means someone commits a machine-
// local file into the shared contract, or is told to run a command that does not do
// what the line says.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

import {
  parsePorcelain,
  renderInformer,
  MANAGED_COMMIT_PATHS,
  NEVER_COMMIT_PATHS,
  MACHINE_LOCAL_LAYERS,
} from '../lib/gitinform.mjs';
import { MODE } from '../lib/detect.mjs';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { loadVersions, FIX } from '../lib/platform.mjs';

const versions = loadVersions();

function tmp() {
  return mkdtempSync(path.join(os.tmpdir(), 'comind-gi-'));
}

/** A repo with the tracked CoMind artifacts on disk. */
function seededRepo() {
  const repo = tmp();
  mkdirSync(path.join(repo, '.comind'), { recursive: true });
  mkdirSync(path.join(repo, '.planning', 'phases'), { recursive: true });
  mkdirSync(path.join(repo, '.ai-memory'), { recursive: true });
  mkdirSync(path.join(repo, '.claude', 'hooks'), { recursive: true });
  writeFileSync(path.join(repo, '.comind', 'manifest.json'), '{}');
  writeFileSync(path.join(repo, '.gitignore'), 'x\n');
  return repo;
}

const okResults = [
  { name: 'rtk', status: 'ok', version: '0.44.0' },
  { name: 'gsd-core', status: 'ok', version: '1.8.0' },
];

test('FIRST INIT lists what to commit and gives a git add line', (t) => {
  const repo = seededRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const out = renderInformer({ repoRoot: repo, mode: MODE.FIRST_INIT, versions, results: okResults });

  assert.match(out, /COMMIT THESE/);
  assert.match(out, /git add /);
  assert.match(out, /\.comind\/manifest\.json/);
  assert.match(out, /NEVER COMMIT/);
  // The paths that must never be staged have to actually appear under that heading.
  for (const [p] of NEVER_COMMIT_PATHS) assert.ok(out.includes(p), `${p} must be listed`);
});

test('FIRST INIT separates paths that do not exist yet', (t) => {
  const repo = seededRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const out = renderInformer({ repoRoot: repo, mode: MODE.FIRST_INIT, versions, results: okResults });
  // .claudeignore was never created in this fixture, so it must not be presented as
  // stageable — a `git add` of a nonexistent path fails and confuses the user.
  const addLine = out.split('\n').find((l) => l.trim().startsWith('git add ')) || '';
  assert.ok(!addLine.includes('.claudeignore'), 'absent paths must stay out of the git add line');
  assert.match(out, /Not on disk yet/);
});

test('JOIN never prints a commit list', (t) => {
  const repo = seededRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const out = renderInformer({ repoRoot: repo, mode: MODE.JOIN, versions, results: okResults });

  assert.match(out, /nothing to commit/);
  assert.ok(!out.includes('COMMIT THESE'), 'a joining developer must not be told to commit');
  assert.ok(!/^\s*git add /m.test(out), 'no git add line on JOIN');
  assert.match(out, /git status --porcelain/, 'JOIN verifies cleanliness instead');
});

test('the teammate instruction names both stages, not just the install', (t) => {
  const repo = seededRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const out = renderInformer({ repoRoot: repo, mode: MODE.FIRST_INIT, versions, results: okResults });

  // Telling a teammate only to run stage 1 leaves them with slash commands and no
  // tools — the exact wrong-command class of bug this informer once had.
  assert.match(out, /\/comind-init/);
  assert.match(out, /install CoMind itself/);
});

test('drift is labelled as "not yet installed" on FIRST INIT, not as drift', (t) => {
  const repo = seededRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const drift = [{ tool: 'rtk', want: '0.44.0', got: null, kind: 'missing' }];
  const first = renderInformer({ repoRoot: repo, mode: MODE.FIRST_INIT, versions, results: okResults, drift });
  const join = renderInformer({ repoRoot: repo, mode: MODE.JOIN, versions, results: okResults, drift });

  assert.match(first, /NOT YET AT PINNED VERSIONS/);
  assert.ok(!first.includes('VERSION DRIFT'), 'there is no contract to drift from before the first run');
  assert.match(join, /VERSION DRIFT/);
});

test('drift remediation names setup, which is what actually converges versions', (t) => {
  const repo = seededRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const drift = [{ tool: 'rtk', want: '0.44.0', got: '0.40.0', kind: 'mismatch' }];
  const out = renderInformer({ repoRoot: repo, mode: MODE.JOIN, versions, results: okResults, drift });
  assert.ok(out.includes(FIX.setup), 'must name the command that installs pinned tools');
});

test('a failed layer surfaces its manual command', (t) => {
  const repo = seededRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const out = renderInformer({
    repoRoot: repo,
    mode: MODE.FIRST_INIT,
    versions,
    results: [{ name: 'rtk', status: 'failed', reason: 'download blocked', manual: 'cargo install rtk' }],
  });

  assert.match(out, /\[FAIL\] rtk/);
  assert.match(out, /run by hand: cargo install rtk/);
});

test('a skipped layer explains itself rather than looking broken', (t) => {
  const repo = seededRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const out = renderInformer({
    repoRoot: repo,
    mode: MODE.FIRST_INIT,
    versions,
    results: [{ name: 'lsp-plugins', status: 'skipped', reason: 'no supported language detected', manual: 'comind lsp go' }],
  });

  assert.match(out, /\[skip\] lsp-plugins/);
  assert.match(out, /no supported language detected/);
});

test('a non-git repo is reported rather than silently rendering an empty git section', (t) => {
  const repo = seededRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const out = renderInformer({ repoRoot: repo, mode: MODE.JOIN, versions, results: okResults });
  assert.match(out, /not a git repository/);
});

test('JOIN flags a modified tracked path but ignores untracked noise', (t) => {
  // The previous version of this test ran against a NON-git fixture, so the
  // branch it names — the isManaged + '??' filter — was never executed at all.
  const repo = seededRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const git = (...args) =>
    spawnSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@e',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@e',
      },
    });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@e');
  git('config', 'user.name', 'T');
  // A tracked file INSIDE .planning/ matters: git collapses a wholly-untracked
  // directory to a single `?? .planning/` entry, and the untracked-noise
  // assertion below would then pass no matter what the filter does.
  writeFileSync(path.join(repo, '.planning', 'PROJECT.md'), '# seed\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');

  // A MODIFIED tracked managed path must be flagged...
  writeFileSync(path.join(repo, '.comind', 'manifest.json'), '{"tampered":true}\n');
  // ...an UNTRACKED file must not: it cannot change the shared contract until
  // someone adds it, and flagging it turns a normal tree into a false alarm.
  writeFileSync(path.join(repo, '.planning', 'scratch-notes.md'), 'local scratch\n');

  const out = renderInformer({ repoRoot: repo, mode: MODE.JOIN, versions, results: okResults });
  assert.doesNotMatch(out, /not a git repository/, 'the fixture must be a real git repo');
  assert.match(out, /\.comind\/manifest\.json/, 'a modified tracked managed path must be flagged');
  assert.doesNotMatch(out, /scratch-notes/, 'untracked noise must not be flagged');
  // Prove the fixture can actually exercise the filter: git must be reporting
  // the untracked file as its own '??' entry under a managed path.
  const porcelain = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout;
  assert.match(porcelain, /\?\? \.planning\/scratch-notes\.md/, 'fixture must produce a ?? entry to filter');
});

test('the vault summary renders, and absence is stated not hidden', (t) => {
  const repo = seededRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const withVault = renderInformer({
    repoRoot: repo,
    mode: MODE.FIRST_INIT,
    versions,
    results: okResults,
    vault: { ok: true, stats: { notes: 12, phases: 2, specs: 3, decisions: 1, graph: true } },
  });
  assert.match(withVault, /VAULT {2}12 notes/);

  const noVault = renderInformer({
    repoRoot: repo,
    mode: MODE.FIRST_INIT,
    versions,
    results: okResults,
    vault: { ok: false, reason: '.planning/ not found' },
  });
  assert.match(noVault, /VAULT {2}skipped — \.planning\/ not found/);
});

test('every pinned tool appears in the header', (t) => {
  const repo = seededRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const out = renderInformer({ repoRoot: repo, mode: MODE.FIRST_INIT, versions, results: okResults });
  for (const [name, spec] of Object.entries(versions.tools)) {
    assert.ok(out.includes(name), `${name} missing from the pinned header`);
    assert.ok(out.includes(spec.version), `${spec.version} missing for ${name}`);
  }
});

test('the three path lists do not contradict each other', () => {
  // A path claimed as both committed and machine-local would be a direct
  // instruction to corrupt the shared contract.
  const commit = new Set(MANAGED_COMMIT_PATHS.map(([p]) => p));
  for (const [p] of NEVER_COMMIT_PATHS) {
    assert.equal(commit.has(p), false, `${p} is listed as both commit and never-commit`);
  }
  assert.ok(MACHINE_LOCAL_LAYERS.length > 0);
});

test('porcelain parsing survives the leading space run() trims off the first line', () => {
  // ` M .comind/manifest.json` loses its leading space to run()'s trim, so a
  // fixed slice(3) ate the '.' and the path never matched a managed path.
  const trimmed = 'M .comind/manifest.json\n?? scratch.md\n D .planning/PROJECT.md';
  assert.deepEqual(parsePorcelain(trimmed), [
    { code: 'M', file: '.comind/manifest.json' },
    { code: '??', file: 'scratch.md' },
    { code: 'D', file: '.planning/PROJECT.md' },
  ]);

  // And the untrimmed form parses identically.
  assert.deepEqual(parsePorcelain(' M .comind/manifest.json'), [
    { code: 'M', file: '.comind/manifest.json' },
  ]);
  assert.deepEqual(parsePorcelain('MM src/a.ts'), [{ code: 'MM', file: 'src/a.ts' }]);
  assert.deepEqual(parsePorcelain(''), []);
});

test('every graphify path the ignore block un-ignores is one the informer names', () => {
  // The informer prints a literal `git add <list>`, so a file that is committable
  // but absent from MANAGED_COMMIT_PATHS is one a developer following the printed
  // command never stages. graphify-out/manifest.json was exactly that: negated in
  // gitignore.block, named nowhere, silently untracked forever.
  const block = readFileSync(path.join(PKG, 'templates', 'gitignore.block'), 'utf8');
  const unignored = block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('!graphify-out/'))
    .map((l) => l.slice(1));
  assert.ok(unignored.length >= 5, 'the graphify commit set must be spelled out, not blanket');

  const named = new Set(MANAGED_COMMIT_PATHS.map(([p]) => p));
  for (const p of unignored) {
    assert.ok(named.has(p), `${p} is committable but the informer never tells anyone to add it`);
  }

  // And the converse: nothing the informer claims under graphify-out/ may be
  // ignored, or the printed `git add` fails on a path git refuses to stage.
  const claimed = [...named].filter((p) => p.startsWith('graphify-out/'));
  for (const p of claimed) {
    assert.ok(unignored.includes(p), `${p} is advertised as committed but the block ignores it`);
  }
});

test('the committed set covers everything gsd-core requires at runtime', () => {
  // The invariant that matters is NOT "the block and the informer agree" — they
  // agreed while both were missing the same paths. It is "a clone can run the
  // engine". These are the real top-level entries `npx @opengsd/gsd-core@1.8.0
  // --claude --local` writes into .claude/, and the ones the engine loads by
  // relative path from gsd-core/bin/lib:
  //
  //   require('../../../scripts/fix-slash-commands.cjs')      command-roster.cjs:9
  //   require('../../../scripts/gen-capability-registry.cjs') capability-loader.cjs:458
  //
  // Committing gsd-core/ without scripts/ is worse than committing neither:
  // .claude/gsd-core/VERSION makes readGsdVersion() report 1.8.0, so JOIN calls
  // it already-pinned and doctor prints PASS over an engine that throws
  // MODULE_NOT_FOUND on load.
  const required = ['.claude/gsd-core/', '.claude/scripts/', '.claude/package.json'];
  const named = new Set(MANAGED_COMMIT_PATHS.map(([p]) => p));
  for (const p of required) {
    assert.ok(named.has(p), `${p} is required to run gsd-core but is never staged`);
  }

  // Machine-local gsd-core state must be named on the other side, or a
  // developer stages a file stamped with their own clock.
  const never = new Set(NEVER_COMMIT_PATHS.map(([p]) => p));
  for (const p of ['.claude/settings.local.json', '.claude/gsd-install-state.json']) {
    assert.ok(never.has(p), `${p} is machine-local and must be named as never-commit`);
    assert.ok(!named.has(p), `${p} must not also be in the commit list`);
  }
});

test('the ignore block and the informer agree about .claude/ too', () => {
  // The check above is prefixed to graphify-out/, so the same class of bug was
  // free to reappear anywhere else — and did: gsd-core installs a whole engine
  // under .claude/gsd-core/ plus .claude/gsd-file-manifest.json, and neither the
  // block nor the informer mentioned them. A clone got gsd-* commands pointing
  // at nothing, JOIN would not reinstall (gsd-core writes committed files, so
  // only FIRST INIT may run it), and the gate demanded /gsd-workflow plan — a
  // command that could not run.
  const block = readFileSync(path.join(PKG, 'templates', 'gitignore.block'), 'utf8');
  const unignored = block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('!.claude/'))
    .map((l) => l.slice(1))
    // The block negates both `!.claude/hooks/` and `!.claude/hooks/**`; the
    // informer names the directory once.
    .map((l) => l.replace(/\*\*$/, ''))
    // `!.claude/` itself is the container that lets git descend, not a path
    // anyone commits.
    .filter((l) => l !== '.claude/');

  const named = new Set(MANAGED_COMMIT_PATHS.map(([p]) => p));
  for (const p of new Set(unignored)) {
    assert.ok(named.has(p), `${p} is committable but the informer never tells anyone to add it`);
  }

  const claimed = [...named].filter((p) => p.startsWith('.claude/'));
  for (const p of claimed) {
    assert.ok(
      unignored.includes(p),
      `${p} is advertised as committed but the block never un-ignores it`,
    );
  }
});
