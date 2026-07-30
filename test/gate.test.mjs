// The gate hook is the one component that can block a developer mid-session, so
// its behaviour is pinned by tests. Rule 1 must never be bypassable; every other
// path must fail open.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, symlinkSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const GATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'team', 'hooks', 'comind-gate.mjs');

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'comind-gate-'));
  copyFileSync(GATE, path.join(dir, 'gate.mjs'));
  mkdirSync(path.join(dir, '.git'), { recursive: true });
  mkdirSync(path.join(dir, '.ai-memory'), { recursive: true });
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, '.planning', 'phases'), { recursive: true });
  return dir;
}

function fire(repo, payload, env = {}) {
  const res = spawnSync(process.execPath, [GATE], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, COMIND_GATE: '', ...env },
  });
  return { code: res.status, stderr: res.stderr || '' };
}

const edit = (file, session = 's') => ({
  tool_name: 'Edit',
  tool_input: { file_path: file },
  session_id: session,
});

test('rule 1: blocks writes into the derived vault', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  for (const p of [
    '.ai-memory/x.md',
    '.ai-memory/graph/deep/n.md',
    '.\\.ai-memory\\x.md', // Windows-style path arriving on any platform
    'src/../.ai-memory/z.md', // traversal
    path.join(repo, '.ai-memory', 'abs.md'), // absolute
  ]) {
    const r = fire(repo, { tool_name: 'Write', tool_input: { file_path: p }, session_id: 'r1' });
    assert.equal(r.code, 2, `expected deny for ${p}`);
    assert.match(r.stderr, /derived/i);
  }
});

test('rule 1: applies to MultiEdit when any target is in the vault', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const r = fire(repo, {
    tool_name: 'MultiEdit',
    tool_input: { edits: [{ file_path: 'src/a.ts' }, { file_path: '.ai-memory/INDEX.md' }] },
    session_id: 'multi',
  });
  assert.equal(r.code, 2);
});

test('rule 1 is not bypassable by COMIND_GATE=off', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const r = fire(repo, { tool_name: 'Write', tool_input: { file_path: '.ai-memory/x.md' } }, { COMIND_GATE: 'off' });
  assert.equal(r.code, 2);
});

test('rule 2: allows edits up to the threshold, denies past it without a spec', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  for (let i = 1; i <= 5; i++) {
    assert.equal(fire(repo, edit(`src/f${i}.ts`, 'bulk')).code, 0, `file ${i} should pass`);
  }
  const r = fire(repo, edit('src/f6.ts', 'bulk'));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /bulk edit blocked/i);
  assert.match(r.stderr, /gsd-workflow/);
});

test('rule 2: an active phase with a spec document satisfies the gate', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  for (let i = 1; i <= 6; i++) fire(repo, edit(`src/g${i}.ts`, 'withspec'));
  assert.equal(fire(repo, edit('src/g7.ts', 'withspec')).code, 2, 'gated before the spec exists');

  const phase = path.join(repo, '.planning', 'phases', '01-foundation');
  mkdirSync(phase, { recursive: true });
  writeFileSync(path.join(phase, '01-PLAN.md'), '# Plan\n');

  assert.equal(fire(repo, edit('src/g8.ts', 'withspec')).code, 0, 'allowed once a spec exists');
});

test('rule 2: an empty phase directory does not satisfy the gate', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(path.join(repo, '.planning', 'phases', '02-empty'), { recursive: true });
  for (let i = 1; i <= 6; i++) fire(repo, edit(`src/h${i}.ts`, 'empty'));
  assert.equal(fire(repo, edit('src/h7.ts', 'empty')).code, 2);
});

test('rule 3: COMIND_GATE=off bypasses the bulk gate and logs it', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  for (let i = 1; i <= 6; i++) fire(repo, edit(`src/i${i}.ts`, 'byp'));
  assert.equal(fire(repo, edit('src/i7.ts', 'byp'), { COMIND_GATE: 'off' }).code, 0);

  const log = path.join(repo, '.comind', 'state', 'bypass.log');
  assert.ok(existsSync(log), 'bypass must be logged');
  assert.match(readFileSync(log, 'utf8'), /src\/i7\.ts/);
});

test('COMIND_BULK_THRESHOLD raises the limit', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  for (let i = 1; i <= 9; i++) {
    assert.equal(fire(repo, edit(`src/j${i}.ts`, 'thr'), { COMIND_BULK_THRESHOLD: '50' }).code, 0);
  }
});

test('fails open on anything it does not understand', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  assert.equal(fire(repo, '').code, 0, 'empty stdin');
  assert.equal(fire(repo, 'not json at all').code, 0, 'unparseable payload');
  assert.equal(fire(repo, { tool_name: 'Bash', tool_input: { command: 'ls' } }).code, 0, 'non-edit tool');
  assert.equal(fire(repo, { tool_name: 'Edit', tool_input: {} }).code, 0, 'no target path');
  assert.equal(fire(repo, { foo: 'bar' }).code, 0, 'unknown shape');
});

// --- W6: planning exemption, Bash coverage, threshold 0 -------------------

const bash = (command, session = 's') => ({
  tool_name: 'Bash',
  tool_input: { command },
  session_id: session,
});

test('rule 2 exempts writes into .planning/ — the remediation it demands', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  // Blow past the threshold on ordinary files first.
  for (let i = 0; i < 7; i++) fire(repo, edit(path.join(repo, 'src', `f${i}.ts`), 'plan-sess'));
  const blocked = fire(repo, edit(path.join(repo, 'src', 'more.ts'), 'plan-sess'));
  assert.equal(blocked.code, 2, 'bulk edit must be gated once the threshold is passed');

  // Creating the phase spec the deny message asks for must NOT be blocked.
  const spec = path.join(repo, '.planning', 'phases', '01-work', 'SPEC.md');
  const res = fire(repo, { tool_name: 'Write', tool_input: { file_path: spec }, session_id: 'plan-sess' });
  assert.equal(res.code, 0, 'writing the phase spec must never be gated by the rule that demands it');
});

test('rule 1 covers Bash writes but lets reads through', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  // Denied: the write verb / redirect aims at the vault.
  for (const cmd of [
    'echo hacked > .ai-memory/INDEX.md',
    'echo x >> .ai-memory/notes/a.md',
    'rm -rf .ai-memory/decisions',
    'cp /tmp/evil.md .ai-memory/evil.md',
    'sed -i s/a/b/ .ai-memory/INDEX.md',
    'tee .ai-memory/INDEX.md < /tmp/x',
  ]) {
    assert.equal(fire(repo, bash(cmd)).code, 2, `must deny: ${cmd}`);
  }

  // Allowed: reads, and writes that merely mention the vault while targeting
  // something else. Ambiguity fails open by design.
  for (const cmd of [
    'cat .ai-memory/INDEX.md',
    'grep -r foo .ai-memory/ > /tmp/out',
    'rm /tmp/scratch.txt && cat .ai-memory/INDEX.md',
    'ls -la .ai-memory/',
    'echo .ai-memory/INDEX.md',
    'git add .ai-memory',
  ]) {
    assert.equal(fire(repo, bash(cmd)).code, 0, `must allow: ${cmd}`);
  }
});

test('COMIND_BULK_THRESHOLD=0 is honoured, not silently replaced by the default', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  // Threshold 0 with no active phase: the very first edit is bulk.
  const res = fire(repo, edit(path.join(repo, 'src', 'a.ts'), 'zero-sess'), {
    COMIND_BULK_THRESHOLD: '0',
  });
  assert.equal(res.code, 2, 'the strictest setting of the knob must be reachable');
  assert.match(res.stderr, /bulk edit blocked/);
});

test('bashWritesVault is targeted, not co-occurrence based', async () => {
  const { bashWritesVault } = await import('../templates/team/hooks/comind-gate.mjs');
  assert.equal(bashWritesVault('printf x > .ai-memory/a.md'), true);
  assert.equal(bashWritesVault('grep -r x .ai-memory/ > /tmp/out'), false);
  assert.equal(bashWritesVault('rm tmp.txt && cat .ai-memory/INDEX.md'), false);
  assert.equal(bashWritesVault('rm tmp.txt && rm .ai-memory/INDEX.md'), true);
  assert.equal(bashWritesVault(''), false);
});

// --- fix-verification round: gate regressions found by the skeptics ---------

test('the gate still fires when the project path contains a symlink', (t) => {
  // import.meta.url is realpath-resolved by Node's ESM loader while argv[1]
  // keeps the literal path, so a naive comparison made isMain false and the
  // WHOLE gate silently no-oped (exit 0) on any symlinked path — including
  // macOS /tmp -> /private/tmp.
  const repo = makeRepo();
  const linkRoot = mkdtempSync(path.join(os.tmpdir(), 'comind-gate-link-'));
  const link = path.join(linkRoot, 'via-symlink');
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(linkRoot, { recursive: true, force: true });
  });
  symlinkSync(repo, link);

  const res = spawnSync(process.execPath, [path.join(link, 'gate.mjs')], {
    input: JSON.stringify(edit(path.join(link, '.ai-memory', 'x.md'))),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: link, COMIND_GATE: '' },
  });
  assert.equal(res.status, 2, 'rule 1 must still deny through a symlinked invocation path');
});

test('bashWritesVault catches wrapped and indirect writes without denying reads', async () => {
  const { bashWritesVault } = await import('../templates/team/hooks/comind-gate.mjs');
  for (const cmd of [
    'bash -c "rm -rf .ai-memory"',
    "sh -c 'rm -rf .ai-memory/decisions'",
    'echo x >| .ai-memory/f.md',
    "find .ai-memory -name '*.md' -delete",
    'ls .ai-memory | xargs rm',
    'env FOO=1 rm .ai-memory/a.md',
    'dd if=/dev/zero of=.ai-memory/INDEX.md',
  ]) {
    assert.equal(bashWritesVault(cmd), true, `must deny: ${cmd}`);
  }
  for (const cmd of [
    'dd if=.ai-memory/INDEX.md of=/tmp/copy.md',
    'bash -c "cat .ai-memory/INDEX.md"',
    'grep -r foo .ai-memory/ > /tmp/out',
    'git add .ai-memory',
  ]) {
    assert.equal(bashWritesVault(cmd), false, `must allow: ${cmd}`);
  }
});

test('concurrent gate invocations do not lose edits from the session counter', (t) => {
  // A read-modify-write of a JSON array dropped updates when Claude Code fired
  // parallel tool calls, stalling the counter so rule 2 never tripped.
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const procs = Array.from({ length: 8 }, (_, i) =>
    spawnSync(process.execPath, [GATE], {
      input: JSON.stringify(edit(path.join(repo, 'src', `p${i}.ts`), 'race')),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo, COMIND_GATE: '', COMIND_BULK_THRESHOLD: '999' },
    }),
  );
  assert.ok(procs.every((p) => p.status === 0));

  const stateDir = path.join(repo, '.comind', 'state');
  const file = readdirSync(stateDir).find((f) => f.startsWith('session-'));
  const recorded = new Set(
    readFileSync(path.join(stateDir, file), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean),
  );
  assert.equal(recorded.size, 8, `all 8 distinct files must survive, saw ${recorded.size}`);
});

test('a write in one command is never attributed to a vault path in another', async () => {
  const { bashWritesVault } = await import('../templates/team/hooks/comind-gate.mjs');
  // `xargs rm` consumes stdin from ITS pipeline, not from a later `&&` command.
  assert.equal(bashWritesVault('git ls-files -d | xargs rm && cat .ai-memory/INDEX.md'), false);
  assert.equal(bashWritesVault('ls .ai-memory | xargs rm'), true);
  // Separated flag values must not shift the verb out of view.
  assert.equal(bashWritesVault('grep -rl x .ai-memory/ | xargs -n 1 rm'), true);
  assert.equal(bashWritesVault('nice -n 10 rm -rf .ai-memory'), true);
});

test('find exclusions are not read as delete targets', async () => {
  const { bashWritesVault } = await import('../templates/team/hooks/comind-gate.mjs');
  // The canonical "clean everywhere EXCEPT the vault" idiom must pass.
  assert.equal(bashWritesVault("find . -path '*/.ai-memory/*' -prune -o -name '*.bak' -delete"), false);
  assert.equal(bashWritesVault("find . -not -path './.ai-memory/*' -name '*.orig' -delete"), false);
  // ...while deleting INSIDE the vault is still denied.
  assert.equal(bashWritesVault("find .ai-memory -name '*.md' -delete"), true);
});
