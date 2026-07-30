// The pinned installers. Only the pure, filesystem-level logic is tested here —
// the parts that actually shell out to npm/go/claude are integration surface.
//
// What matters is the DECISION logic, because that is where the real bugs were:
// a version probe that returned null made setup reinstall gsd-core forever, and a
// loose regex made an uninstalled RTK hook report as present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { readGsdVersion, enableGsdGraphify, rtkHookInstalled, parseRtkShow, installRtk, reportGsdDrift, cavemanInstallSpec, registerGraphMergeDriver, renderGraphHtml, isRtkHookCommand, registeredRtkCommand, absolutizeRtkCommand, bareRtkCommand, rtkCommandResolves, pinRtkHookPath, unpinRtkHookPath, readGlobalSettings } from '../lib/install-tools.mjs';
import { loadVersions, which } from '../lib/platform.mjs';
import { spawnSync } from 'node:child_process';

const PKG = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function tmp() {
  return mkdtempSync(path.join(os.tmpdir(), 'comind-it-'));
}

// --- readGsdVersion -------------------------------------------------------
// Getting this wrong breaks idempotence: a null result makes the installer re-run
// gsd-core, which rewrites its manifest with a fresh timestamp and dirties the repo.

test('readGsdVersion reads the plain VERSION file', (t) => {
  const repo = tmp();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  mkdirSync(path.join(repo, '.claude', 'gsd-core'), { recursive: true });
  writeFileSync(path.join(repo, '.claude', 'gsd-core', 'VERSION'), '1.8.0');
  assert.equal(readGsdVersion(repo), '1.8.0');
});

test('readGsdVersion trims trailing whitespace from VERSION', (t) => {
  const repo = tmp();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  mkdirSync(path.join(repo, '.claude', 'gsd-core'), { recursive: true });
  writeFileSync(path.join(repo, '.claude', 'gsd-core', 'VERSION'), '1.8.0\n');
  assert.equal(readGsdVersion(repo), '1.8.0', 'a stray newline must not defeat the comparison');
});

test('readGsdVersion falls back to the file manifest', (t) => {
  const repo = tmp();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  mkdirSync(path.join(repo, '.claude'), { recursive: true });
  writeFileSync(
    path.join(repo, '.claude', 'gsd-file-manifest.json'),
    JSON.stringify({ version: '1.8.0', timestamp: 'whenever' }),
  );
  assert.equal(readGsdVersion(repo), '1.8.0');
});

test('readGsdVersion returns null when nothing is installed', (t) => {
  const repo = tmp();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  assert.equal(readGsdVersion(repo), null);
});

test('readGsdVersion survives unparseable JSON', (t) => {
  const repo = tmp();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  mkdirSync(path.join(repo, '.claude'), { recursive: true });
  writeFileSync(path.join(repo, '.claude', 'gsd-file-manifest.json'), '{ not json');
  assert.equal(readGsdVersion(repo), null, 'must not throw');
});

test('readGsdVersion does not depend on .planning/ existing', (t) => {
  const repo = tmp();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  // gsd-core is installed long before /gsd-onboard creates .planning/. Gating the
  // probe on that directory is what made every setup reinstall it.
  mkdirSync(path.join(repo, '.claude', 'gsd-core'), { recursive: true });
  writeFileSync(path.join(repo, '.claude', 'gsd-core', 'VERSION'), '1.8.0');
  assert.equal(readGsdVersion(repo), '1.8.0');
});

// --- rtkHookInstalled -----------------------------------------------------
// The exact false positive that shipped: a loose /hook/ test matches the word
// inside "Hook: not found" and reports success when nothing is installed.

// Verbatim `rtk init --show` output, captured from rtk 0.44.0.
const RTK_SHOW_ABSENT = `rtk Configuration:

[--] Hook: not found
[--] RTK.md: not found
[--] Global (~/.claude/CLAUDE.md): exists but rtk not configured
[--] Local (./CLAUDE.md): not found
[warn] settings.json: exists but RTK hook not configured
    Run: rtk init -g --auto-patch
`;

const RTK_SHOW_PRESENT = `rtk Configuration:

[ok] Hook: rtk hook claude (native binary command)
[ok] RTK.md: /Users/x/.claude/RTK.md (slim mode)
[ok] Global (~/.claude/CLAUDE.md): @RTK.md reference
[--] Local (./CLAUDE.md): not found
`;

test('parseRtkShow reports NOT installed when rtk says "Hook: not found"', () => {
  // The original bug: a loose /hook/ test matches the word inside "Hook: not
  // found" and reports success while no hook exists at all.
  const res = parseRtkShow(RTK_SHOW_ABSENT);
  assert.equal(res.installed, false);
  assert.match(res.line, /not found/);
});

test('parseRtkShow reports installed when the hook is registered', () => {
  const res = parseRtkShow(RTK_SHOW_PRESENT);
  assert.equal(res.installed, true);
  assert.match(res.line, /rtk hook claude/);
});

test('parseRtkShow rejects every "absent" phrasing, and empty output', () => {
  for (const stdout of [
    '[--] Hook: not found',
    '[warn] Hook: exists but RTK hook not configured',
    '[--] Hook: not installed',
    '',
    'no hook line at all',
  ]) {
    assert.equal(parseRtkShow(stdout).installed, false, JSON.stringify(stdout));
  }
});

test('rtkHookInstalled reports unknown rather than installed when rtk cannot run', () => {
  // Failing open here would claim the hook is present on a machine without rtk.
  const res = rtkHookInstalled(path.join(os.tmpdir(), 'definitely-not-rtk'), process.cwd());
  assert.equal(res.known, false);
  assert.equal(res.installed, false);
});

// --- the REGISTERED hook command ------------------------------------------
//
// rtk registers the bare command `rtk hook claude`. installRtk downloads rtk
// into ~/.claude/comind/bin exactly when rtk is NOT on PATH, and nothing puts
// that directory on PATH — so the registered command exited 127 on every Bash
// call while doctor reported PASS, because both doctor checks resolved rtk
// through which('rtk', [bin]), the same lookup that hides the problem.

function settingsWith(command) {
  return { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] } };
}

test('isRtkHookCommand recognises rtk however its path is spelled', () => {
  for (const c of [
    'rtk hook claude',
    'rtk.exe hook claude',
    '"/Users/a b/.claude/comind/bin/rtk" hook claude',
    "'/opt/rtk' hook claude",
    '/usr/local/bin/rtk hook claude',
    'C:\\tools\\rtk.exe hook claude',
  ]) {
    assert.equal(isRtkHookCommand(c), true, c);
  }
  // Must not claim someone else's hook. `rtkfoo` is a different binary, and
  // `comind-gate` sharing the PreToolUse array must never be rewritten.
  for (const c of ['rtkfoo hook claude', 'node .claude/hooks/comind-gate.mjs', 'rtk gain', '', null]) {
    assert.equal(isRtkHookCommand(c), false, JSON.stringify(c));
  }
});

test('registeredRtkCommand finds the hook among unrelated entries, or reports none', () => {
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node gate.mjs' }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] },
      ],
    },
  };
  assert.equal(registeredRtkCommand(settings), 'rtk hook claude');
  assert.equal(registeredRtkCommand({ hooks: { PreToolUse: [] } }), null);
  assert.equal(registeredRtkCommand({ hooks: {} }), null);
  assert.equal(registeredRtkCommand(null), null);
  // A malformed PreToolUse must not throw — a crash here would abort setup.
  assert.equal(registeredRtkCommand({ hooks: { PreToolUse: 'nonsense' } }), null);
});

test('absolutizeRtkCommand quotes the path and rewrites only the leading token', () => {
  const out = absolutizeRtkCommand('rtk hook claude', '/Users/Some Name/.claude/comind/bin/rtk');
  // Quoted: hooks[].command is a shell string, and an unquoted path with a
  // space splits into two words and silently never runs — strictly worse than
  // the bare name it replaced.
  assert.equal(out, '"/Users/Some Name/.claude/comind/bin/rtk" hook claude');
  // `hook claude` is rtk's own vocabulary, not ours to hardcode.
  assert.equal(
    absolutizeRtkCommand('rtk hook claude --verbose', '/opt/rtk'),
    '"/opt/rtk" hook claude --verbose',
  );
  // Idempotent: repointing an already-absolutised command replaces the path.
  assert.equal(absolutizeRtkCommand(out, '/opt/rtk'), '"/opt/rtk" hook claude');
});

test('bareRtkCommand is the exact inverse, so uninstall can undo just our edit', () => {
  const original = 'rtk hook claude';
  const pinned = absolutizeRtkCommand(original, '/Users/x/.claude/comind/bin/rtk');
  assert.equal(bareRtkCommand(pinned), original);
  assert.equal(bareRtkCommand(original), original, 'reverting an untouched command is a no-op');
});

test('rtkCommandResolves asks the PATH the SHELL will use, not CoMind\'s bin dir', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'rtk');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  assert.equal(rtkCommandResolves(`"${bin}" hook claude`), true);
  assert.equal(rtkCommandResolves(`${bin} hook claude`), true);
  assert.equal(
    rtkCommandResolves(`"${path.join(dir, 'gone')}" hook claude`),
    false,
    'an absolute path that does not exist cannot be resolvable',
  );
  // The bug in one line: rtk sitting in a private directory does NOT make the
  // bare name runnable, and this must not consult that directory to decide.
  assert.equal(rtkCommandResolves('definitely-not-a-real-binary-xyz hook claude'), false);
});

test('pinRtkHookPath repoints an unresolvable hook and preserves every other key', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rtk = path.join(dir, 'rtk');
  writeFileSync(rtk, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const file = path.join(dir, 'settings.json');
  const before = {
    ...settingsWith('rtk hook claude'),
    extraKnownMarketplaces: { keep: 'me' },
    effortLevel: 'high',
  };
  before.hooks.PreToolUse.push({
    matcher: 'Edit|Write',
    hooks: [{ type: 'command', command: 'node .claude/hooks/comind-gate.mjs' }],
  });
  writeFileSync(file, JSON.stringify(before, null, 2));

  const res = pinRtkHookPath(rtk, file);
  assert.equal(res.changed, true);

  const after = readGlobalSettings(file);
  assert.equal(registeredRtkCommand(after), `"${rtk}" hook claude`);
  assert.deepEqual(after.extraKnownMarketplaces, { keep: 'me' }, 'unrelated keys must survive');
  assert.equal(after.effortLevel, 'high');
  assert.equal(
    after.hooks.PreToolUse[1].hooks[0].command,
    'node .claude/hooks/comind-gate.mjs',
    "another tool's hook in the same array must not be rewritten",
  );

  // Idempotent: the command now resolves, so a second call changes nothing.
  assert.equal(pinRtkHookPath(rtk, file).changed, false);
  assert.deepEqual(readGlobalSettings(file), after);

  // Uninstall cleans up without leaving anything unrunnable behind, and touches
  // nothing else. Which branch it takes depends on whether a real rtk survives
  // on PATH — assert on the OUTCOME both branches must guarantee.
  const res2 = unpinRtkHookPath(file);
  assert.equal(res2.changed, true);
  const after2 = readGlobalSettings(file);
  const left = registeredRtkCommand(after2);
  assert.ok(
    left === null || rtkCommandResolves(left),
    `uninstall must not leave an unrunnable rtk hook; left ${JSON.stringify(left)}`,
  );
  assert.deepEqual(after2.extraKnownMarketplaces, { keep: 'me' }, 'unrelated keys must survive');
  assert.equal(
    after2.hooks.PreToolUse.at(-1).hooks[0].command,
    'node .claude/hooks/comind-gate.mjs',
    "another tool's hook must survive uninstall",
  );
});

test('uninstall REMOVES the rtk hook when no rtk survives on PATH', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rtk = path.join(dir, 'rtk');
  writeFileSync(rtk, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  // This is the machine the pin exists for: rtk lives ONLY in CoMind's private
  // directory, which uninstall is about to delete. Reverting to the bare `rtk`
  // there swaps one unrunnable command for another and leaves a machine-wide
  // PreToolUse hook failing on every Bash call in every repo — precisely the
  // state doctor reports as FAIL, produced by the cleanup command.
  const file = path.join(dir, 'settings.json');
  const before = settingsWith('rtk hook claude');
  before.hooks.PreToolUse.push({
    matcher: 'Edit|Write',
    hooks: [{ type: 'command', command: 'node .claude/hooks/comind-gate.mjs' }],
  });
  writeFileSync(file, JSON.stringify(before, null, 2));
  pinRtkHookPath(rtk, file);
  assert.equal(registeredRtkCommand(readGlobalSettings(file)), `"${rtk}" hook claude`);

  rmSync(rtk, { force: true }); // uninstall deletes the binary
  const res = unpinRtkHookPath(file);

  const after = readGlobalSettings(file);
  if (which('rtk')) {
    // A machine that has its own rtk: the bare name is right again.
    assert.equal(res.action, 'reverted');
    assert.equal(registeredRtkCommand(after), 'rtk hook claude');
  } else {
    assert.equal(res.action, 'removed');
    assert.equal(registeredRtkCommand(after), null, 'no dangling rtk hook may remain');
    // The empty Bash group is pruned, but the gate hook is untouched.
    assert.equal(after.hooks.PreToolUse.length, 1);
    assert.equal(after.hooks.PreToolUse[0].hooks[0].command, 'node .claude/hooks/comind-gate.mjs');
  }
});

test('isRtkHookCommand does not claim another tool that merely mentions rtk', () => {
  // `(?:.*[/\\])?rtk` crossed spaces, so `node /srv/rtk hook run` matched and
  // absolutizing it would have eaten the interpreter and rewritten a foreign
  // tool's hook command in the user's global settings.
  for (const c of [
    'node /srv/rtk hook run',
    'sudo rtk hook claude',
    'sh -c "rtk hook claude"',
    'rtkfoo hook claude',
    '/usr/bin/rtkx hook claude',
  ]) {
    assert.equal(isRtkHookCommand(c), false, c);
  }
  for (const c of ['rtk hook claude', '"/opt/my rtk/rtk" hook claude', 'C:\\t\\rtk.exe hook x']) {
    assert.equal(isRtkHookCommand(c), true, c);
  }
});

test('rtkCommandResolves requires an EXECUTABLE, not merely a path that exists', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const notExec = path.join(dir, 'rtk');
  writeFileSync(notExec, 'not executable\n', { mode: 0o644 });
  assert.equal(rtkCommandResolves(`"${notExec}" hook claude`), false, 'no exec bit means unrunnable');

  const asDir = path.join(dir, 'sub');
  mkdirSync(path.join(asDir, 'rtk'), { recursive: true });
  assert.equal(rtkCommandResolves(`"${path.join(asDir, 'rtk')}" hook claude`), false, 'a directory is not a program');
});

test('pinRtkHookPath leaves a hook that already resolves alone', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rtk = path.join(dir, 'rtk');
  writeFileSync(rtk, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  // A developer whose rtk IS on PATH gets the bare name, which is correct and
  // portable. Rewriting it would hardcode this machine's layout for no reason.
  const file = path.join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify(settingsWith(`"${rtk}" hook claude`), null, 2));
  const res = pinRtkHookPath(path.join(dir, 'other-rtk'), file);
  assert.equal(res.changed, false);
  assert.match(res.reason, /already resolvable/);
});

test('doctor FAILS on a registered hook command the shell cannot find', async (t) => {
  // The whole bug, end to end. This machine is the one every rtk downloader
  // ends up on: the binary sits in CoMind's private bin dir (so
  // which('rtk',[bin]) finds it) while the REGISTERED command is the bare name
  // (so Claude Code cannot). Doctor used to print PASS for both rows because
  // both resolved rtk the same way the installer did.
  const home = mkdtempSync(path.join(os.tmpdir(), 'comind-doc-home-'));
  const repo = tmp();
  const realHome = process.env.HOME;
  const realProfile = process.env.USERPROFILE;
  t.after(() => {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realProfile;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const bin = path.join(home, '.claude', 'comind', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'rtk'), '#!/bin/sh\necho "rtk 0.44.0"\n', { mode: 0o755 });
  writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify(settingsWith('rtk hook claude'), null, 2),
  );

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { runDoctor } = await import('../lib/doctor.mjs');
  const res = runDoctor(repo, loadVersions());

  const binRow = res.checks.find((c) => c.name === 'rtk binary');
  const hookRow = res.checks.find((c) => c.name === 'rtk rewrite hook');
  assert.equal(binRow.status, 'pass', 'the binary really is there — that part was never the lie');
  assert.equal(hookRow.status, 'fail', 'the command Claude Code runs resolves to nothing');
  assert.match(hookRow.detail, /not on PATH/);
});

test('the hook helpers never throw on a missing or corrupt settings.json', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = path.join(dir, 'nope.json');
  const corrupt = path.join(dir, 'corrupt.json');
  writeFileSync(corrupt, '{ not json at all');

  // Setup must survive both. Throwing here aborts the whole run over a file
  // CoMind does not own.
  for (const f of [missing, corrupt]) {
    assert.equal(readGlobalSettings(f), null);
    assert.equal(pinRtkHookPath('/opt/rtk', f).changed, false);
    assert.equal(unpinRtkHookPath(f).changed, false);
  }
});

// --- enableGsdGraphify ----------------------------------------------------

test('enableGsdGraphify flips the flag and preserves unknown keys', (t) => {
  const repo = tmp();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  mkdirSync(path.join(repo, '.planning'), { recursive: true });
  const cfg = path.join(repo, '.planning', 'config.json');
  // A key CoMind knows nothing about. A future gsd-core release will add these,
  // and clobbering them would silently break the user's config.
  writeFileSync(cfg, JSON.stringify({ response_language: 'en', some_future_key: { a: 1 } }, null, 2));

  const res = enableGsdGraphify({ repoRoot: repo, dryRun: false });
  assert.equal(res.status, 'ok');

  const after = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.equal(after.graphify.enabled, true);
  assert.equal(typeof after.graphify.build_timeout, 'number');
  assert.equal(after.response_language, 'en', 'unknown keys must survive');
  assert.deepEqual(after.some_future_key, { a: 1 });
});

test('enableGsdGraphify is idempotent', (t) => {
  const repo = tmp();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  mkdirSync(path.join(repo, '.planning'), { recursive: true });
  const cfg = path.join(repo, '.planning', 'config.json');
  writeFileSync(cfg, JSON.stringify({}));

  enableGsdGraphify({ repoRoot: repo, dryRun: false });
  const first = readFileSync(cfg, 'utf8');
  const second = enableGsdGraphify({ repoRoot: repo, dryRun: false });
  assert.equal(second.status, 'already-pinned');
  assert.equal(readFileSync(cfg, 'utf8'), first, 'a second run must not rewrite the file');
});

test('enableGsdGraphify does not invent a config file', (t) => {
  const repo = tmp();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const res = enableGsdGraphify({ repoRoot: repo, dryRun: false });
  assert.equal(res.status, 'skipped');
  assert.match(res.reason, /config\.json absent/);
});

test('enableGsdGraphify refuses to overwrite unparseable config', (t) => {
  const repo = tmp();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  mkdirSync(path.join(repo, '.planning'), { recursive: true });
  const cfg = path.join(repo, '.planning', 'config.json');
  writeFileSync(cfg, '{ not json');

  const res = enableGsdGraphify({ repoRoot: repo, dryRun: false });
  assert.equal(res.status, 'failed');
  assert.equal(readFileSync(cfg, 'utf8'), '{ not json', 'the file must be left alone');
});

test('enableGsdGraphify writes nothing on a dry run', (t) => {
  const repo = tmp();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  mkdirSync(path.join(repo, '.planning'), { recursive: true });
  const cfg = path.join(repo, '.planning', 'config.json');
  writeFileSync(cfg, '{}');

  const res = enableGsdGraphify({ repoRoot: repo, dryRun: true });
  assert.equal(res.status, 'would-update');
  assert.equal(readFileSync(cfg, 'utf8'), '{}');
});

// --- the pin contract the LSP layer depends on ---------------------------

test('every LSP-layer spec declares a binName', () => {
  // `typescript` had none, so its installed version could not be probed, the layer
  // was permanently "missing", and `npm install -g` ran on every single setup.
  const v = loadVersions();
  for (const key of ['typescript', 'typescript-language-server', 'pyright']) {
    assert.ok(v.tools[key].binName, `${key} must declare binName so its version can be probed`);
  }
});

// --- W3: the source-build fallback is gated on WHY the release install failed

function rtkCtx(installRelease, repo) {
  return {
    versions: {
      tools: {
        rtk: {
          version: '9.9.9-test',
          repo: 'example/rtk',
          binName: 'rtk',
          fallback: 'cargo install --git https://example/rtk --tag v9.9.9-test',
          assets: { 'test-arch': 'rtk-test.tar.gz' },
          verify: 'checksums.txt',
        },
      },
    },
    repoRoot: repo,
    log: null,
    dryRun: false,
    installRelease,
  };
}

test('installRtk FAILS on a checksum mismatch instead of building over it with cargo', async (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'ct-rtk-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const res = await installRtk(
    rtkCtx(async () => ({
      ok: false,
      kind: 'checksum-mismatch',
      reason: 'SHA-256 mismatch for freshly downloaded rtk-test.tar.gz — possible tampering, refusing to install.',
    }), repo),
  );
  assert.equal(res.status, 'failed');
  assert.match(res.reason, /possible tampering/, 'the verification refusal must survive, not be relabeled');
});

test('installRtk surfaces unsafe-archive and download failures as failures too', async (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'ct-rtk2-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  for (const kind of ['unsafe-archive', 'download-failed', 'extract-failed', 'checksum-missing']) {
    const res = await installRtk(rtkCtx(async () => ({ ok: false, kind, reason: `reason: ${kind}` }), repo));
    assert.equal(res.status, 'failed', kind);
    assert.match(res.reason, new RegExp(kind), 'the real reason must be reported');
  }
});

// --- W2: JOIN's read-only gsd-core drift report ---------------------------

test('reportGsdDrift never installs: pinned match is cached, drift and absence are skips', (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'ct-drift-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const versions = { tools: { 'gsd-core': { version: '1.8.0', pkg: '@opengsd/gsd-core' } } };

  assert.equal(reportGsdDrift({ versions, repoRoot: repo }).status, 'skipped', 'no committed install');

  mkdirSync(path.join(repo, '.claude', 'gsd-core'), { recursive: true });
  writeFileSync(path.join(repo, '.claude', 'gsd-core', 'VERSION'), '1.8.0\n');
  assert.equal(reportGsdDrift({ versions, repoRoot: repo }).status, 'already-pinned');

  writeFileSync(path.join(repo, '.claude', 'gsd-core', 'VERSION'), '1.7.0\n');
  const drifted = reportGsdDrift({ versions, repoRoot: repo });
  assert.equal(drifted.status, 'skipped');
  assert.match(drifted.reason, /JOIN never rewrites/);
});

// --- caveman: the pin is the commit, not the tag ---------------------------

test('caveman installs from a pinned commit, never a floating ref', () => {
  const spec = loadVersions().tools.caveman;

  // A 40-hex commit, not a tag. Git tags are movable and the v1.9.1 release
  // reports "immutable": false, so pinning the tag is a weaker promise than it
  // looks — and this is a package that installs hooks into ~/.claude.
  assert.match(spec.ref, /^[0-9a-f]{40}$/, 'ref must be a full commit SHA');

  const cmd = cavemanInstallSpec(spec);
  assert.match(cmd, /^npx -y github:JuliusBrussee\/caveman#[0-9a-f]{40}$/);

  // The exact bug this replaces: the old fallback fetched install.sh FROM the
  // v1.9.1 tag, but that script ends `exec npx -y github:JuliusBrussee/caveman`
  // with NO ref, which npm resolves to the default branch. A "pinned" fallback
  // that installs main is worse than an honestly unpinned one.
  assert.ok(!/github:[^#\s]+(\s|$)/.test(cmd), 'a package spec with no #ref resolves to the default branch');
});

test('no shipped file installs caveman from an unpinned github spec', () => {
  const offenders = [];
  for (const rel of ['lib/install-tools.mjs', 'versions.json', 'README.md', 'UPGRADING.md', 'ONBOARDING.md']) {
    const abs = path.join(PKG, rel);
    for (const line of readFileSync(abs, 'utf8').split('\n')) {
      // `github:owner/repo` with no `#` is the unpinned form.
      if (/github:JuliusBrussee\/caveman(?!#)/.test(line)) offenders.push(`${rel}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `unpinned caveman spec: ${offenders.join(' | ')}`);
});

// --- graph.json union merge driver ----------------------------------------
// The committed .gitattributes claims `merge=graphify`. The driver body it names
// is git config — per-machine, uncommittable. Shipping the claim without
// registering the body is worse than shipping neither: git reports an unknown
// driver and hands the developer a raw conflict in a generated megabyte of JSON.

const V = loadVersions();

test('registerGraphMergeDriver writes both config keys and is idempotent', (t) => {
  const repo = tmp();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  if (git('init', '-q').status !== 0) return t.skip('git unavailable');

  const first = registerGraphMergeDriver({ repoRoot: repo, versions: V, dryRun: false });
  assert.equal(first.status, 'ok');

  const driver = git('config', '--get', 'merge.graphify.driver').stdout.trim();
  assert.match(driver, /merge-driver %O %A %B$/, 'git substitutes %O/%A/%B — they must survive verbatim');
  assert.match(git('config', '--get', 'merge.graphify.name').stdout, /union merge/);

  // Second run must not rewrite config. Setup is run repeatedly by design.
  assert.equal(registerGraphMergeDriver({ repoRoot: repo, versions: V, dryRun: false }).status, 'already-pinned');
});

test('registerGraphMergeDriver quotes the interpreter path and never throws off-git', (t) => {
  const repo = tmp();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  // No .git: JOIN runs this too, and a non-repo must degrade, not crash.
  assert.equal(registerGraphMergeDriver({ repoRoot: repo, versions: V, dryRun: false }).status, 'skipped');

  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  if (git('init', '-q').status !== 0) return t.skip('git unavailable');
  const dry = registerGraphMergeDriver({ repoRoot: repo, versions: V, dryRun: true });
  assert.equal(dry.status, 'would-register');
  assert.equal(git('config', '--get', 'merge.graphify.driver').status, 1, 'a dry run must write nothing');
  // git runs the driver through a shell. An unquoted resolved path containing a
  // space would split into two words and the driver would silently never run.
  if (dry.detail.startsWith('"')) assert.match(dry.detail, /^"[^"]+" merge-driver /);
});

test('our .gitattributes line satisfies graphify\'s own duplicate check', () => {
  // Ported from graphify v8 hooks.py::_has_merge_attr. `graphify hook install`
  // appends its own line unless this predicate already matches, so a spelling
  // drift here means every developer who runs it gets a second, conflicting entry.
  const hasMergeAttr = (content) =>
    content.split('\n').some((raw) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return false;
      const fields = line.split(/\s+/);
      return fields[0].endsWith('graph.json') && fields.slice(1).includes('merge=graphify');
    });

  const block = readFileSync(path.join(PKG, 'templates', 'gitattributes.block'), 'utf8');
  assert.ok(hasMergeAttr(block), 'graphify would append a duplicate merge attribute');
});

test('renderGraphHtml skips cleanly when there is no graph to render', (t) => {
  const repo = tmp();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  // /comind-sync calls this AFTER regenerating the vault. A repo that never ran
  // graphify must not turn a successful sync into a failure.
  const res = renderGraphHtml({ repoRoot: repo, versions: V, dryRun: false });
  assert.equal(res.status, 'skipped');
  assert.match(res.reason, /graph\.json/);

  mkdirSync(path.join(repo, 'graphify-out'), { recursive: true });
  writeFileSync(path.join(repo, 'graphify-out', 'graph.json'), '{"nodes":[],"links":[]}\n');
  const dry = renderGraphHtml({ repoRoot: repo, versions: V, dryRun: true });
  // graphify may or may not be installed on the machine running this suite;
  // either answer is valid, a throw or an 'ok' that wrote nothing is not.
  assert.ok(['would-render', 'skipped'].includes(dry.status), `unexpected: ${dry.status}`);
});

test('the committed graph set is stated once, and the two lists cannot overlap', async () => {
  const { MANAGED_COMMIT_PATHS, NEVER_COMMIT_PATHS } = await import('../lib/gitinform.mjs');
  const managed = MANAGED_COMMIT_PATHS.map(([p]) => p);
  const never = NEVER_COMMIT_PATHS.map(([p]) => p);

  // graphify-out/ used to be listed wholesale as never-committed while upstream
  // ships it to be committed. The informer is what a developer reads to decide
  // what to `git add`, so a path may never appear in both lists.
  for (const p of managed) {
    assert.ok(!never.includes(p), `${p} is claimed as both committed and never-committed`);
  }
  assert.ok(managed.includes('graphify-out/graph.json'));
  assert.ok(managed.includes('graphify-out/.graphify_labels.json'), 'the LLM output must be committed');
  assert.ok(never.includes('graphify-out/graph.html'));
  assert.ok(!never.includes('graphify-out/'), 'the blanket exclusion must not come back');
});
