// The Windows spawn path (CVE-2024-27980: patched Node throws EINVAL on
// spawning .cmd/.bat with shell:false) cannot execute on POSIX CI, so the
// command-line builder is pure and tested here on every OS.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { which, whichExts, winQuote, winCommandLine, run, IS_WINDOWS, compareVersions, satisfies, loadVersions } from '../lib/platform.mjs';

test('winQuote passes plain tokens bare and quotes the rest', () => {
  assert.equal(winQuote('--version'), '--version');
  assert.equal(winQuote('@opengsd/gsd-core@1.8.0'), '@opengsd/gsd-core@1.8.0');
  assert.equal(winQuote('C:\\Users\\dev\\my repo'), '"C:\\Users\\dev\\my repo"');
  assert.equal(winQuote('a&b'), '"a&b"');
});

test('winQuote refuses tokens that defeat cmd.exe quoting', () => {
  // % expands even inside double quotes; " and newlines break the token apart.
  assert.throws(() => winQuote('%PATH%'));
  assert.throws(() => winQuote('say "hi"'));
  assert.throws(() => winQuote('a\nb'));
});

test('winCommandLine builds one quoted line for a shim', () => {
  assert.equal(
    winCommandLine('C:\\Program Files\\nodejs\\npx.cmd', ['-y', '@opengsd/gsd-core@1.8.0', '--claude']),
    '"C:\\Program Files\\nodejs\\npx.cmd" -y @opengsd/gsd-core@1.8.0 --claude',
  );
});

test('whichExts probes the bare name on Windows only for extension-carrying lookups', () => {
  // `which('npm')` must NOT probe the bare name: Node ships an extensionless
  // POSIX sh script `npm` next to npm.cmd, and cmd.exe cannot execute it.
  assert.deepEqual(whichExts('npm', true, '.COM;.EXE;.BAT;.CMD'), ['.COM', '.EXE', '.BAT', '.CMD']);
  assert.deepEqual(whichExts('npm.cmd', true, '.COM;.EXE;.BAT;.CMD'), ['', '.COM', '.EXE', '.BAT', '.CMD']);
  assert.deepEqual(whichExts('npm.CMD', true, '.com;.exe;.bat;.cmd'), ['', '.com', '.exe', '.bat', '.cmd']);
  assert.deepEqual(whichExts('npm', false), ['']);
});

test('which skips directories and non-executable files, keeps searching', { skip: IS_WINDOWS }, () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'comind-which-'));
  try {
    const decoyDir = path.join(tmp, 'decoy');
    const plainDir = path.join(tmp, 'plain');
    const realDir = path.join(tmp, 'real');
    for (const d of [decoyDir, plainDir, realDir]) mkdirSync(d, { recursive: true });

    // A directory named like the binary, then a chmod-less file, then the real one.
    mkdirSync(path.join(decoyDir, 'mytool'));
    writeFileSync(path.join(plainDir, 'mytool'), '#!/bin/sh\n', { mode: 0o644 });
    writeFileSync(path.join(realDir, 'mytool'), '#!/bin/sh\necho ok\n', { mode: 0o755 });

    assert.equal(which('mytool', [decoyDir, plainDir, realDir]), path.join(realDir, 'mytool'));
    assert.equal(which('mytool', [decoyDir, plainDir]), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('run returns an error result instead of throwing', () => {
  const res = run(path.join(os.tmpdir(), 'comind-definitely-missing-binary'), ['--version'], {
    timeout: 5_000,
  });
  assert.equal(res.ok, false);
  assert.ok(res.error, 'spawn failure must surface in .error');
});

// --- pin policy: exact where divergence corrupts the repo, floor elsewhere ---

test('compareVersions orders numerically, and a pre-release sorts below release', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('0.9.28', '0.10.0') < 0, true, '10 > 9 numerically, not as a string');
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0, 'a leading v is not a difference');
  assert.equal(compareVersions('1.2.3', '1.2') > 0, true);
  assert.equal(compareVersions('1.0.0-alpha.0', '1.0.0') < 0, true);
});

test('satisfies: floor accepts newer, exact does not', () => {
  const floor = { version: '0.9.28', policy: 'floor' };
  const exact = { version: '0.44.0', policy: 'exact' };

  assert.equal(satisfies('0.9.28', floor), true);
  assert.equal(satisfies('0.9.30', floor), true, 'a newer machine-local tool still satisfies');
  assert.equal(satisfies('0.9.27', floor), false, 'below the floor is not acceptable');

  assert.equal(satisfies('0.44.0', exact), true);
  assert.equal(satisfies('0.45.0', exact), false, 'exact means exact — newer is still drift');

  // No policy means exact: a tool added without one must not silently float.
  assert.equal(satisfies('0.45.0', { version: '0.44.0' }), false);

  // 'unknown' is what a probe returns when a binary answers no --version.
  // Treating it as satisfied would make that layer's drift invisible.
  assert.equal(satisfies('unknown', floor), false);
  assert.equal(satisfies(null, floor), false);
});

test('the tools that write shared state are pinned exactly', () => {
  // The rule: pin what lands in git or runs as a binary; float what is
  // machine-local and derived. rtk is executed, gsd-core writes COMMITTED files,
  // caveman installs hooks into ~/.claude — divergence there corrupts the team's
  // repo, not just one developer's machine.
  const V = loadVersions();
  for (const name of ['rtk', 'gsd-core', 'caveman']) {
    assert.equal(V.tools[name].policy, 'exact', `${name} must stay pinned exactly`);
  }
  for (const name of ['graphifyy', 'typescript', 'typescript-language-server', 'pyright']) {
    assert.equal(V.tools[name].policy, 'floor', `${name} is machine-local and should float`);
  }
});
