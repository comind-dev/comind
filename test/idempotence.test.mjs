// Idempotence is the property the whole design rests on: a teammate must be able
// to run `npx @comind-dev/comind` repeatedly without dirtying the repo. These tests pin the
// mechanism that guarantees it — sentinel-block patching — plus the git-semantics
// of the generated ignore rules and the LSP detection table.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { patchBlock, removeBlock, applyIgnores, conflictingIgnores, BEGIN, END } from '../lib/ignores.mjs';
import { generateVault } from '../lib/vault.mjs';
import { loadVersions } from '../lib/platform.mjs';
import { detectLanguages, detectMode, manifestProvenance, MODE } from '../lib/detect.mjs';
import { detectLspLanguages, lspLanguages } from '../lib/lsp.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSIONS = loadVersions();
const BLOCK = readFileSync(path.join(PKG, 'templates', 'gitignore.block'), 'utf8');
const V = { version: VERSIONS.comind };

function tmp(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- retirement: .claudeignore was inert config and has to be withdrawn -------

test('removeBlock strips our block and keeps every line the developer wrote', () => {
  const user = 'my-own-rule/\n*.tmp\n';
  const withBlock = patchBlock(user, 'graphify-out/\n', V).content;
  assert.ok(withBlock.includes(BEGIN));

  const stripped = removeBlock(withBlock);
  assert.equal(stripped.action, 'stripped');
  assert.ok(stripped.changed);
  assert.ok(!stripped.content.includes(BEGIN) && !stripped.content.includes(END));
  for (const line of ['my-own-rule/', '*.tmp']) {
    assert.ok(stripped.content.includes(line), `must preserve ${line}`);
  }
  // Withdrawing twice is a no-op, so a re-run never rewrites the file.
  assert.equal(removeBlock(stripped.content).changed, false);
});

test('removeBlock empties a file that held nothing but our block', () => {
  const onlyBlock = patchBlock('', 'graphify-out/\n', V).content;
  const res = removeBlock(onlyBlock);
  assert.equal(res.action, 'emptied', 'caller deletes the file rather than leaving a blank one');
  assert.equal(res.content, '');
});

test('applyIgnores withdraws a legacy .claudeignore block and deletes an emptied file', () => {
  const repo = tmp('comind-retire-');
  // Older installs wrote this file; Claude Code reads no such thing.
  writeFileSync(path.join(repo, '.claudeignore'), patchBlock('', 'graphify-out/\n', V).content, 'utf8');

  const first = applyIgnores(repo, V);
  const ci = first.find((r) => r.file === '.claudeignore');
  assert.ok(ci?.changed, '.claudeignore must be reported as changed');
  assert.equal(existsSync(path.join(repo, '.claudeignore')), false, 'an emptied .claudeignore is removed');

  // Second run must not re-report a file that is already gone.
  const second = applyIgnores(repo, V);
  assert.equal(second.find((r) => r.file === '.claudeignore'), undefined);
  rmSync(repo, { recursive: true, force: true });
});

test('.claudeignore is never written again, and no template survives for it', () => {
  const repo = tmp('comind-noci-');
  applyIgnores(repo, V);
  assert.equal(existsSync(path.join(repo, '.claudeignore')), false);
  assert.equal(
    existsSync(path.join(PKG, 'templates', 'claudeignore.block')),
    false,
    'the template must be gone — a live template is how inert config comes back',
  );
  rmSync(repo, { recursive: true, force: true });
});

test('patchBlock appends once, then is a no-op', () => {
  const user = 'node_modules/\n*.log\n';
  const first = patchBlock(user, BLOCK, V);
  assert.equal(first.action, 'appended');
  assert.ok(first.changed);
  assert.ok(first.content.startsWith(user), 'user lines must be preserved');

  const second = patchBlock(first.content, BLOCK, V);
  assert.equal(second.changed, false, 'second application must not change anything');
  assert.equal(second.content, first.content);
});

test('patchBlock leaves exactly one sentinel pair', () => {
  let content = '';
  for (let i = 0; i < 5; i++) content = patchBlock(content, BLOCK, V).content;
  const begins = content.split(BEGIN).length - 1;
  const ends = content.split(END).length - 1;
  assert.equal(begins, 1);
  assert.equal(ends, 1);
});

test('patchBlock preserves lines a developer adds after the block', () => {
  const first = patchBlock('node_modules/\n', BLOCK, V).content;
  const withTail = `${first}\n# mine\nsecret.env\n`;
  const again = patchBlock(withTail, BLOCK, V);
  assert.match(again.content, /# mine/);
  assert.match(again.content, /secret\.env/);
});

test('patchBlock preserves CRLF line endings', () => {
  const crlf = 'node_modules/\r\n*.log\r\n';
  const out = patchBlock(crlf, BLOCK, V).content;
  assert.ok(out.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(out), 'must not introduce bare LF into a CRLF file');
});

test('patchBlock refuses to guess when a sentinel is unmatched', () => {
  const broken = `node_modules/\n${BEGIN}\nhand edited\n`;
  const out = patchBlock(broken, BLOCK, V);
  assert.equal(out.action, 'error');
  assert.equal(out.changed, false);
  assert.match(out.error, /unmatched/i);
});

test('generated .gitignore keeps the shared brain and drops local state', (t) => {
  const repo = tmp('comind-ignore-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (git('init', '-q').status !== 0) return t.skip('git unavailable');

  // A hostile host repo: ignores all dotfiles AND .planning outright.
  writeFileSync(path.join(repo, '.gitignore'), '.*\n.planning/\n');
  writeFileSync(
    path.join(repo, '.gitignore'),
    patchBlock(readFileSync(path.join(repo, '.gitignore'), 'utf8'), BLOCK, V).content,
  );

  const ignored = (rel) => git('check-ignore', '-q', rel).status === 0;

  for (const keep of [
    '.planning/PROJECT.md',
    '.planning/phases/01-x/PLAN.md',
    '.ai-memory/INDEX.md',
    '.comind/manifest.json',
    '.claude/hooks/comind-gate.mjs',
    '.claude/settings.json',
    // graphify ships graphify-out/ to be committed. graph.json is what makes
    // `/gsd-graphify query` answerable on a fresh clone; without it a teammate
    // has to pay for a full extraction before asking the graph anything.
    'graphify-out/graph.json',
    'graphify-out/GRAPH_REPORT.md',
    // Dotfiles, and the host repo above ignores `.*` — so these prove both that
    // the negations are present AND that gitignore's `*` matches a leading dot.
    // .graphify_labels.json is LLM output: `graphify export html` reads the
    // community names only from this sidecar, never from the `community_name`
    // attribute graph.json also carries.
    'graphify-out/.graphify_labels.json',
    'graphify-out/.graphify_analysis.json',
    // The GSD engine. A clone without it gets gsd-* slash commands pointing at
    // nothing, and JOIN will not reinstall — gsd-core writes committed files, so
    // only FIRST INIT may run it. .gsd-runtime additionally starts with a dot,
    // so the host's `.*` rule matches it and only `!.claude/gsd-core/**` (last
    // matching pattern wins) rescues it.
    '.claude/gsd-core/VERSION',
    '.claude/gsd-core/bin/gsd-tools.cjs',
    '.claude/gsd-core/.gsd-runtime',
    '.claude/gsd-file-manifest.json',
    // The engine does require('../../../scripts/...') from gsd-core/bin/lib,
    // and .claude/package.json is what makes its .js hooks load in a repo whose
    // own package.json is type:module.
    '.claude/scripts/fix-slash-commands.cjs',
    '.claude/package.json',
  ]) {
    assert.equal(ignored(keep), false, `${keep} must stay tracked`);
  }
  for (const drop of [
    '.comind/state/s.json',
    '.planning/notes.local.md',
    '.claude/settings.local.json',
    // Not committed because re-rendering is free and unmetered — and because a
    // multi-MB artifact that changes wholesale on every build has no merge
    // driver behind it, unlike graph.json.
    'graphify-out/graph.html',
    'graphify-out/cost.json',
    'graphify-out/cache/chunk-0.json',
    'graphify-out/memory/result.json',
    'graphify-out/.graphify_python',
  ]) {
    assert.equal(ignored(drop), true, `${drop} must be ignored`);
  }

  // The rtk binary and the download cache are no longer inside the repo at all,
  // so there is nothing here to ignore — and nothing a clone could plant for
  // CoMind to execute. Assert the paths stay absent rather than merely ignored.
  const block = readFileSync(path.join(repo, '.gitignore'), 'utf8');
  assert.ok(!block.includes('.comind/bin'), '.comind/bin must not exist to be ignored');
  assert.ok(!block.includes('.comind/cache'), '.comind/cache must not exist to be ignored');
});

test('the block survives a host repo that ignores .claude/* directly', (t) => {
  const repo = tmp('comind-ignore-claude-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (git('init', '-q').status !== 0) return t.skip('git unavailable');

  // `.claude/*` is a far more common spelling than `.*`, and it behaves
  // differently: it matches the CHILDREN, so every child needs its own negation.
  // The fixture above uses `.*`, which never matched .claude/gsd-core at all —
  // so it could not have caught the missing negations.
  writeFileSync(path.join(repo, '.gitignore'), '.claude/*\n');
  writeFileSync(
    path.join(repo, '.gitignore'),
    patchBlock(readFileSync(path.join(repo, '.gitignore'), 'utf8'), BLOCK, V).content,
  );
  const ignored = (rel) => git('check-ignore', '-q', rel).status === 0;

  for (const keep of [
    '.claude/settings.json',
    '.claude/hooks/comind-gate.mjs',
    '.claude/skills/caveman-gsd/SKILL.md',
    '.claude/commands/gsd-workflow.md',
    '.claude/agents/gsd-planner.md',
    '.claude/gsd-core/VERSION',
    '.claude/gsd-core/bin/gsd-tools.cjs',
    '.claude/gsd-file-manifest.json',
    '.claude/scripts/fix-slash-commands.cjs',
    '.claude/package.json',
  ]) {
    assert.equal(ignored(keep), false, `${keep} must stay tracked`);
  }
  for (const drop of ['.claude/settings.local.json', '.claude/gsd-install-state.json']) {
    assert.equal(ignored(drop), true, `${drop} is machine-local and must stay ignored`);
  }
});

test('gitignored *.local.md never reaches the vault, as a note or as inlined text', (t) => {
  const repo = tmp('comind-vault-local-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  // `.planning/**/*.local.md` is ignored by CoMind's own managed block, under
  // "Scratch notes a developer wants kept out of the shared brain". The vault
  // filtered on `.md` and republished them into `.ai-memory/`, which the same
  // block force-includes — so withheld content became committed and permanent,
  // and the vault stopped being a function of committed sources, which dirties
  // every teammate's tree on sync.
  mkdirSync(path.join(repo, '.planning', 'phases', '01-a'), { recursive: true });
  mkdirSync(path.join(repo, '.planning', 'decisions'), { recursive: true });
  writeFileSync(path.join(repo, '.planning', 'PROJECT.md'), '# P\n');
  writeFileSync(path.join(repo, '.planning', 'phases', '01-a', 'PLAN.md'), '# A\nStatus: done\n');
  writeFileSync(
    path.join(repo, '.planning', 'phases', '01-a', 'NOTES.local.md'),
    '# scratch\nSECRET-PHASE-SCRATCH\nStatus: in-progress\n',
  );
  writeFileSync(
    path.join(repo, '.planning', 'decisions', 'private.local.md'),
    '# private\nSECRET-DECISION-SCRATCH\n',
  );
  writeFileSync(path.join(repo, '.planning', 'decisions', 'shared.md'), '# shared\nkeep me\n');

  const res = generateVault(repo, VERSIONS);
  assert.ok(res.ok);

  const all = snapshotDir(path.join(repo, '.ai-memory'));
  const blob = all.map(([, body]) => body).join('\n');

  // No note of its own...
  assert.ok(
    !all.some(([p]) => p.toLowerCase().includes('.local')),
    `no .local note may exist: ${all.map(([p]) => p).join(', ')}`,
  );
  // ...and, the part a per-file filter would have missed, no inlined BODY
  // either: buildPhases merges every document's text into one phase note.
  assert.ok(!blob.includes('SECRET-PHASE-SCRATCH'), 'a phase note inlined a gitignored document');
  assert.ok(!blob.includes('SECRET-DECISION-SCRATCH'), 'a decision note leaked');
  // The filename must not survive in `documents:` frontmatter either.
  assert.ok(!blob.includes('NOTES.local.md'), 'the frontmatter names a gitignored file');

  // The shared siblings are untouched — this is a filter, not a blanket skip.
  assert.ok(blob.includes('keep me'));
  assert.ok(all.some(([p]) => p.endsWith('phases/01-a.md')), 'the phase note must still exist');

  // The phase's status came from PLAN.md, not from the scratch note that also
  // declared one.
  const phase = all.find(([p]) => p.endsWith('phases/01-a.md'))[1];
  assert.match(phase, /status: done/);
});

test('a phase holding only scratch notes produces no vault note at all', (t) => {
  const repo = tmp('comind-vault-onlylocal-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  mkdirSync(path.join(repo, '.planning', 'phases', '02-scratch'), { recursive: true });
  writeFileSync(path.join(repo, '.planning', 'PROJECT.md'), '# P\n');
  writeFileSync(path.join(repo, '.planning', 'phases', '02-scratch', 'x.local.md'), '# x\n');

  const res = generateVault(repo, VERSIONS);
  assert.ok(res.ok);
  assert.equal(res.stats.phases, 0, 'a phase with no shared document is not a phase');
  const all = snapshotDir(path.join(repo, '.ai-memory'));
  assert.ok(!all.some(([p]) => p.includes('02-scratch')));
  // And INDEX must not link to the note that was never written.
  const index = all.find(([p]) => p === 'INDEX.md')[1];
  assert.ok(!index.includes('02-scratch'), 'INDEX links a phase note that does not exist');
});

test('doctor, the gate, and the vault apply ONE shared-spec rule', async () => {
  // doctor.mjs has claimed "a test asserts the two agree" for a while; there was
  // no such test. The gate is copied into consuming repos and cannot import
  // from lib/, so the duplication is structural and only a test can hold it
  // together. If they drift, doctor reports PASS while the gate still blocks.
  const { isSharedSpec: doctorRule } = await import('../lib/doctor.mjs');
  const { isSharedSpec: gateRule } = await import(
    path.join(PKG, 'templates', 'team', 'hooks', 'comind-gate.mjs')
  );
  const { isSharedDoc: vaultRule } = await import('../lib/vault.mjs');

  for (const name of [
    'PLAN.md',
    'SUMMARY.MD',
    'notes.local.md',
    'NOTES.LOCAL.MD',
    'weird.local.md.md',
    '.local.md',
    'plan.txt',
    'README',
    'local.md',
  ]) {
    const d = doctorRule(name);
    assert.equal(gateRule(name), d, `gate disagrees with doctor about ${name}`);
    assert.equal(vaultRule(name), d, `vault disagrees with doctor about ${name}`);
  }

  // And the rule itself is what we think it is.
  assert.equal(doctorRule('PLAN.md'), true);
  assert.equal(doctorRule('NOTES.local.md'), false);
  assert.equal(doctorRule('local.md'), true, 'only the .local.md SUFFIX is scratch');
});

test('vault is markdown-only, deterministic, and prunes stale notes', (t) => {
  const repo = tmp('comind-vault-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  mkdirSync(path.join(repo, '.planning', 'phases', '01-a'), { recursive: true });
  mkdirSync(path.join(repo, '.planning', 'phases', '02-b'), { recursive: true });
  mkdirSync(path.join(repo, '.planning', 'graphs'), { recursive: true });
  writeFileSync(path.join(repo, '.planning', 'PROJECT.md'), '# P\nSee [roadmap](ROADMAP.md).\n');
  writeFileSync(path.join(repo, '.planning', 'ROADMAP.md'), '# R\n');
  writeFileSync(path.join(repo, '.planning', 'phases', '01-a', 'PLAN.md'), '# A\nStatus: done\n');
  writeFileSync(path.join(repo, '.planning', 'phases', '02-b', 'PLAN.md'), '# B\nStatus: in-progress\n');
  writeFileSync(
    path.join(repo, '.planning', 'graphs', 'GRAPH_REPORT.md'),
    '# G\n## God Nodes\n- X\n## Suggested Questions\n- Q?\n',
  );
  // Binary-ish artifacts that must never reach the vault.
  writeFileSync(path.join(repo, '.planning', 'graphs', 'graph.json'), '{"big":true}');
  writeFileSync(path.join(repo, '.planning', 'graphs', 'graph.html'), '<html/>');

  const first = generateVault(repo, VERSIONS, { mode: 'init' });
  assert.ok(first.ok);
  assert.equal(first.stats.phases, 2);

  // The last heading in a report must still become a note (no regex \Z bug).
  const graphDir = path.join(repo, '.ai-memory', 'graph');
  assert.ok(readFileSync(path.join(graphDir, 'Suggested Questions.md'), 'utf8').includes('Q?'));

  // Wikilink conversion.
  const project = readFileSync(path.join(repo, '.ai-memory', 'specs', 'PROJECT.md'), 'utf8');
  assert.match(project, /\[\[ROADMAP\]\]/);

  // Deterministic: regenerating writes identical content.
  const snapshot = snapshotDir(path.join(repo, '.ai-memory'));
  generateVault(repo, VERSIONS, { mode: 'sync' });
  assert.deepEqual(snapshotDir(path.join(repo, '.ai-memory')), snapshot);

  // Markdown only.
  const nonMd = snapshot.filter(([p]) => !p.endsWith('.md') && !p.includes('.obsidian'));
  assert.deepEqual(nonMd, [], 'no non-markdown files may reach the vault');

  // Pruning removes a generated note whose source vanished, but not a hand-added one.
  rmSync(path.join(repo, '.planning', 'phases', '02-b'), { recursive: true, force: true });
  writeFileSync(path.join(repo, '.ai-memory', 'phases', 'mine.md'), '# hand written\n');
  const second = generateVault(repo, VERSIONS, { mode: 'sync' });
  assert.ok(second.removed.some((f) => f.endsWith('02-b.md')));
  assert.ok(snapshotDir(path.join(repo, '.ai-memory')).some(([p]) => p.endsWith('mine.md')));
});

test('vault reports a clear reason when the repo is not onboarded', (t) => {
  const repo = tmp('comind-vault2-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const res = generateVault(repo, VERSIONS, {});
  assert.equal(res.ok, false);
  assert.match(res.reason, /\.planning/);
});

test('detectLanguages sees untracked sources, not just committed ones', (t) => {
  const repo = tmp('comind-lang-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  assert.deepEqual(
    Object.values(detectLanguages(repo)).filter(Boolean),
    [],
    'an empty repo detects no language at all',
  );

  mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'deep', 'a.py'), 'x = 1\n');
  assert.equal(detectLanguages(repo).python, true, 'must find an uncommitted .py');

  writeFileSync(path.join(repo, 'src', 'b.ts'), 'export const x = 1;\n');
  assert.equal(detectLanguages(repo).typescript, true);
});

test('every LSP language is detectable, by marker and by source extension', () => {
  // Twelve plugins means twelve chances for a table typo to make a language
  // permanently undetectable — and a silently undetectable language is a plugin
  // that never installs and a doctor row that never appears.
  for (const lang of lspLanguages(VERSIONS)) {
    const spec = VERSIONS.lsp.languages[lang];
    assert.ok(spec.plugin?.endsWith('-lsp'), `${lang}: plugin name must be an official *-lsp id`);
    assert.ok(spec.server?.bin, `${lang}: a plugin wraps a server binary — name it, so doctor can probe it`);
    assert.ok(spec.markers?.length || spec.exts?.length, `${lang}: needs at least one detection signal`);

    for (const marker of spec.markers || []) {
      const repo = tmp(`comind-det-${lang}-`);
      writeFileSync(path.join(repo, marker), '\n');
      const got = detectLspLanguages(repo, VERSIONS).map((d) => d.lang);
      assert.ok(got.includes(lang), `${lang}: marker ${marker} must detect it (got ${got})`);
      rmSync(repo, { recursive: true, force: true });
    }
    for (const ext of spec.exts || []) {
      const repo = tmp(`comind-detx-${lang}-`);
      mkdirSync(path.join(repo, 'src'), { recursive: true });
      writeFileSync(path.join(repo, 'src', `f${ext}`), '\n');
      const got = detectLspLanguages(repo, VERSIONS).map((d) => d.lang);
      assert.ok(got.includes(lang), `${lang}: source ${ext} must detect it (got ${got})`);
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('a marker beats a stray source file — one vendored .go is not a Go repo', () => {
  // Every installed plugin costs always-on context in every session, so
  // over-detection is the expensive failure, not under-detection.
  const repo = tmp('comind-vendored-');
  writeFileSync(path.join(repo, 'pyproject.toml'), '[project]\n');
  mkdirSync(path.join(repo, 'node_modules', 'x'), { recursive: true });
  writeFileSync(path.join(repo, 'node_modules', 'x', 'vendored.go'), 'package x\n');

  const got = detectLspLanguages(repo, VERSIONS).map((d) => d.lang);
  assert.ok(got.includes('python'), 'the real language must be found');
  assert.ok(!got.includes('go'), 'a .go file inside node_modules must not install the Go plugin');
  rmSync(repo, { recursive: true, force: true });
});

test('detectLanguages does not descend into node_modules', (t) => {
  const repo = tmp('comind-lang2-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(path.join(repo, 'node_modules', 'pkg', 'x.py'), 'x = 1\n');
  assert.equal(detectLanguages(repo).python, false);
});

/** Sorted [relativePath, content] pairs — the basis of the determinism assertions. */
function snapshotDir(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) snapshotDir(p, base, acc);
    else acc.push([path.relative(base, p).split(path.sep).join('/'), readFileSync(p, 'utf8')]);
  }
  return acc;
}

// --- W7: vault correctness ------------------------------------------------

test('same-named notes in different source roots do not collide', (t) => {
  const repo = tmp('comind-vault-collide-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  for (const root of ['decisions', 'discussions', 'research']) {
    mkdirSync(path.join(repo, '.planning', root), { recursive: true });
    writeFileSync(path.join(repo, '.planning', root, 'api.md'), `# API\ncontent from ${root}\n`);
  }

  const res = generateVault(repo, VERSIONS, { mode: 'init' });
  assert.ok(res.ok);
  for (const root of ['decisions', 'discussions', 'research']) {
    const note = readFileSync(path.join(repo, '.ai-memory', root, 'api.md'), 'utf8');
    assert.match(note, new RegExp(`content from ${root}`), `${root}/api.md must keep its own content`);
  }

  // INDEX must disambiguate: three notes named `api`, so bare [[api]] is wrong.
  const index = readFileSync(path.join(repo, '.ai-memory', 'INDEX.md'), 'utf8');
  assert.match(index, /\[\[decisions\/api\|api\]\]/);
  assert.match(index, /\[\[research\/api\|api\]\]/);
});

test('a title containing a colon produces valid YAML frontmatter', (t) => {
  const repo = tmp('comind-vault-yaml-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  mkdirSync(path.join(repo, '.planning'), { recursive: true });
  writeFileSync(path.join(repo, '.planning', 'PROJECT.md'), '# Phase 3: Cleanup #hard\nbody\n');

  generateVault(repo, VERSIONS, { mode: 'init' });
  const note = readFileSync(path.join(repo, '.ai-memory', 'specs', 'PROJECT.md'), 'utf8');
  const fm = note.split('---')[1];
  // The value must be quoted, so the whole properties block still parses.
  assert.match(fm, /title: '.*Phase 3: Cleanup/);
  for (const line of fm.trim().split('\n')) {
    if (!line.includes(':') || line.trim().startsWith('- ')) continue;
    const value = line.slice(line.indexOf(':') + 1).trim();
    assert.ok(
      !/: /.test(value) || /^['"]/.test(value),
      `unquoted YAML value would break the properties block: ${line}`,
    );
  }
});

test('CRLF sources produce LF notes, so regeneration is byte-stable across platforms', (t) => {
  const repo = tmp('comind-vault-eol-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  mkdirSync(path.join(repo, '.planning'), { recursive: true });
  writeFileSync(path.join(repo, '.planning', 'PROJECT.md'), '# P\r\nline one\r\nline two\r\n');

  generateVault(repo, VERSIONS, { mode: 'init' });
  const file = path.join(repo, '.ai-memory', 'specs', 'PROJECT.md');
  const note = readFileSync(file, 'utf8');
  assert.ok(!note.includes('\r'), 'no CR may survive into a committed note');

  const before = readFileSync(file);
  generateVault(repo, VERSIONS, { mode: 'sync' });
  assert.ok(readFileSync(file).equals(before), 'a second run must be byte-identical');
});

test('a case-only rename does not delete the note just generated', (t) => {
  const repo = tmp('comind-vault-case-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  mkdirSync(path.join(repo, '.planning', 'decisions'), { recursive: true });
  writeFileSync(path.join(repo, '.planning', 'decisions', 'Choice.md'), '# Choice\nfirst\n');
  generateVault(repo, VERSIONS, { mode: 'init' });

  // Rename the source with only a case change and regenerate.
  rmSync(path.join(repo, '.planning', 'decisions', 'Choice.md'));
  writeFileSync(path.join(repo, '.planning', 'decisions', 'choice.md'), '# Choice\nsecond\n');
  const res = generateVault(repo, VERSIONS, { mode: 'sync' });

  const notes = snapshotDir(path.join(repo, '.ai-memory', 'decisions')).map(([p]) => p);
  assert.ok(notes.length >= 1, 'the regenerated note must survive the prune');
  const kept = readFileSync(path.join(repo, '.ai-memory', 'decisions', notes[0]), 'utf8');
  assert.match(kept, /second/, 'the surviving note must be the freshly generated one');
  assert.equal(res.removed.filter((f) => /choice\.md$/i.test(f)).length, 0);
});

test('the vault README is installed, not dead documentation', (t) => {
  const repo = tmp('comind-vault-readme-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  mkdirSync(path.join(repo, '.planning'), { recursive: true });
  writeFileSync(path.join(repo, '.planning', 'PROJECT.md'), '# P\n');
  generateVault(repo, VERSIONS, { mode: 'init' });

  const readme = readFileSync(path.join(repo, '.ai-memory', 'README.md'), 'utf8');
  assert.match(readme, /the shared brain/);
  assert.match(readme, /Start at `INDEX.md`/);
});

// --- W9: sentinel-block robustness ----------------------------------------

test('duplicate managed blocks are collapsed into one', () => {
  const one = patchBlock('', 'a\nb\n', V).content;
  // Simulate a merge resolved by keeping both sides.
  const doubled = `${one}\nkeep-me\n${one}`;
  const res = patchBlock(doubled, 'a\nb\n', V);

  assert.equal(res.action, 'deduplicated');
  const begins = res.content.split(BEGIN).length - 1;
  assert.equal(begins, 1, 'exactly one managed block may survive');
  assert.match(res.content, /keep-me/, 'content between the blocks must be preserved');
});

test('line endings outside the managed block are never rewritten', () => {
  // A mixed-EOL file: the developer's own lines must come back byte-identical.
  const existing = 'first\r\nsecond\nthird\r\n';
  const res = patchBlock(existing, 'x\n', V);

  assert.ok(res.content.startsWith('first\r\nsecond\nthird'), 'pre-existing lines keep their own endings');
  assert.match(res.content, /x/);

  // And a second run is a no-op.
  const again = patchBlock(res.content, 'x\n', V);
  assert.equal(again.changed, false, 'patching twice must be idempotent');
});

test('a host repo ignoring .claude is reported, not silently overridden', () => {
  assert.deepEqual(conflictingIgnores('node_modules/\n.claude/\n'), ['.claude/']);
  assert.deepEqual(conflictingIgnores('node_modules/\n.*\n'), ['.*']);
  assert.deepEqual(conflictingIgnores('node_modules/\ndist/\n'), []);
});

test('.gitattributes is created as a managed file, scoped to markdown', (t) => {
  const repo = tmp('comind-attrs-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const results = applyIgnores(repo, { version: VERSIONS.comind });
  const attrs = results.find((r) => r.file === '.gitattributes');
  assert.ok(attrs, 'gitinform lists .gitattributes as managed — a step must create it');

  const body = readFileSync(path.join(repo, '.gitattributes'), 'utf8');
  assert.match(body, /\.ai-memory\/\*\*\/\*\.md text eol=lf/);
  // Scoped to *.md: forcing text semantics on a PDF under .planning/ corrupts it.
  assert.doesNotMatch(body, /^\.planning\/\*\* text/m);
});

// --- fix-verification round -------------------------------------------------

test('detectMode: an UNCOMMITTED manifest keeps FIRST INIT; a committed one is JOIN', (t) => {
  // Keying JOIN on the manifest merely EXISTING made the first developer's own
  // second run a JOIN, so the documented flow (setup -> /gsd-onboard -> re-run
  // setup so graphify and the vault pick up .planning/) silently stopped
  // converging and a failed gsd-core install could never be retried.
  const repo = tmp('comind-mode-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) =>
    spawnSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' },
    });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@e');
  git('config', 'user.name', 'T');

  assert.equal(detectMode(repo).mode, MODE.FIRST_INIT, 'no manifest at all');

  mkdirSync(path.join(repo, '.comind'), { recursive: true });
  writeFileSync(path.join(repo, '.comind', 'manifest.json'), '{"comind":"0.0.1-alpha.0"}\n');
  assert.equal(detectMode(repo).mode, MODE.FIRST_INIT, 'this machine wrote it, not a teammate');

  git('add', '-f', '.comind/manifest.json');
  git('commit', '-q', '-m', 'commit the contract');
  assert.equal(detectMode(repo).mode, MODE.JOIN, 'once committed it is a real JOIN');
});

test('conflictingIgnores matches every spelling that actually ignores .claude', () => {
  for (const rule of ['.claude/', '/.claude/', '.claude/*', '.claude/**', '**/.claude/', '.*']) {
    assert.deepEqual(conflictingIgnores(`node_modules/\n${rule}\n`), [rule], `must flag ${rule}`);
  }
  assert.deepEqual(conflictingIgnores('node_modules/\ndist/\n'), []);
  // Negations are not ignore rules.
  assert.deepEqual(conflictingIgnores('!.claude/\n'), []);
  // A rule BELOW the managed block is the developer's deliberate last word —
  // git's last-match-wins makes it effective, so it is not being overridden.
  const withBlock = patchBlock('node_modules/\n', 'x\n', V).content;
  assert.deepEqual(conflictingIgnores(`${withBlock}\n.claude/\n`), []);
});

test('a stamped note at the vault ROOT is pruned like any other generated note', (t) => {
  const repo = tmp('comind-vault-root-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(path.join(repo, '.planning'), { recursive: true });
  writeFileSync(path.join(repo, '.planning', 'PROJECT.md'), '# P\n');
  generateVault(repo, VERSIONS, { mode: 'init' });

  // A stamped leftover from an older layout at the vault root.
  const stale = path.join(repo, '.ai-memory', 'OLD-LAYOUT.md');
  writeFileSync(stale, '<!-- generated by comind; edit .planning/ instead -->\n\n# stale\n');
  // ...and a hand-written note, which must survive.
  const mine = path.join(repo, '.ai-memory', 'my-notes.md');
  writeFileSync(mine, '# mine\n');

  const res = generateVault(repo, VERSIONS, { mode: 'sync' });
  assert.ok(res.removed.some((f) => f.endsWith('OLD-LAYOUT.md')), 'stale generated note must be pruned');
  assert.ok(existsSync(mine), 'a hand-added note must be left alone');
  assert.ok(existsSync(path.join(repo, '.ai-memory', 'README.md')), 'the current README must survive');
});

test('INDEX wikilinks are folder-qualified so same-named notes stay unambiguous', (t) => {
  const repo = tmp('comind-vault-links-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(path.join(repo, '.planning', 'phases', 'api'), { recursive: true });
  mkdirSync(path.join(repo, '.planning', 'decisions'), { recursive: true });
  writeFileSync(path.join(repo, '.planning', 'phases', 'api', 'PLAN.md'), '# api\n');
  writeFileSync(path.join(repo, '.planning', 'decisions', 'api.md'), '# api\n');

  generateVault(repo, VERSIONS, { mode: 'init' });
  const index = readFileSync(path.join(repo, '.ai-memory', 'INDEX.md'), 'utf8');
  // Inside a table cell the alias pipe must be BACKSLASH-escaped, or GFM and
  // Obsidian split the row into an extra column.
  assert.match(index, /\[\[phases\/api\\\|api\]\]/);
  assert.match(index, /\[\[decisions\/api\|api\]\]/);
  assert.doesNotMatch(index, /\[\[api\]\]/, 'a bare [[api]] would resolve to whichever note Obsidian guesses');
});

test('markdown links resolve to the same wikilink regardless of separator', (t) => {
  const repo = tmp('comind-vault-sep-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(path.join(repo, '.planning'), { recursive: true });
  // A Windows developer's backslash link must produce the same bytes as a
  // POSIX one, or the two commit different vaults from the same source.
  writeFileSync(path.join(repo, '.planning', 'PROJECT.md'), '# P\nSee [r](..\\decisions\\api.md) and [s](../decisions/api.md).\n');
  generateVault(repo, VERSIONS, { mode: 'init' });
  const note = readFileSync(path.join(repo, '.ai-memory', 'specs', 'PROJECT.md'), 'utf8');
  assert.match(note, /\[\[api\|r\]\]/);
  assert.match(note, /\[\[api\|s\]\]/);
});

test('mode detection is safe when git refuses to answer', (t) => {
  // A clone in a bind mount / root-owned checkout makes git exit 128 on
  // everything ("dubious ownership"). Reading that as "not committed" turned a
  // real JOIN into a FIRST INIT that rewrites the team's tracked files.
  const repo = tmp('comind-mode-git-');
  const shimDir = tmp('comind-mode-shim-');
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
  });
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  mkdirSync(path.join(repo, '.comind'), { recursive: true });
  writeFileSync(path.join(repo, '.comind', 'manifest.json'), '{"comind":"0.0.1-alpha.0"}\n');

  const shim = path.join(shimDir, 'git');
  writeFileSync(shim, '#!/bin/sh\necho "fatal: detected dubious ownership" >&2\nexit 128\n', { mode: 0o755 });

  const res = spawnSync(
    process.execPath,
    ['-e', `import('${path.join(PKG, 'lib', 'detect.mjs')}').then(m => console.log(m.detectMode(${JSON.stringify(repo)}).mode))`],
    { encoding: 'utf8', env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` } },
  );
  assert.match(res.stdout, /JOIN/, 'an unanswerable git must resolve to the mode that writes nothing');
});

test('provenance: no repo is local, HEAD decides otherwise, staging is not committing', (t) => {
  const repo = tmp('comind-prov-');
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(path.join(repo, '.comind'), { recursive: true });
  writeFileSync(path.join(repo, '.comind', 'manifest.json'), '{}\n');
  assert.equal(manifestProvenance(repo), 'local', 'no .git at all: nobody could have committed it');

  const git = (...args) =>
    spawnSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' },
    });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@e');
  git('config', 'user.name', 'T');
  assert.equal(manifestProvenance(repo), 'local', 'fresh repo, nothing committed');

  git('add', '-f', '.comind/manifest.json');
  assert.equal(manifestProvenance(repo), 'local', 'staged is not committed — the first dev stages before committing');

  git('commit', '-q', '-m', 'c');
  assert.equal(manifestProvenance(repo), 'committed');
});
