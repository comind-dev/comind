// The download → verify → extract chain. This module produces an executable that
// lands on PATH, so it is the one place where a silent failure is dangerous rather
// than merely annoying. It shipped with zero tests; these pin the parts that
// matter.
//
// No network: `installFromGithubRelease` takes an injectable `fetchImpl`, so the
// whole chain runs against buffers built in-process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, existsSync, rmSync, writeFileSync, statSync, lstatSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

import {
  parseChecksums,
  sha256,
  extractTarGzInProcess,
  isContained,
  inspectArchive,
  installFromGithubRelease,
} from '../lib/fetch-verify.mjs';
import { which } from '../lib/platform.mjs';

function tmp(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- tar fixture builder --------------------------------------------------
// A real ustar header so the reader is exercised against the format it will
// actually meet, not a mock.

function tarHeader(name, size) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('000644 \0', 100, 'utf8'); // mode
  h.write('000000 \0', 108, 'utf8'); // uid
  h.write('000000 \0', 116, 'utf8'); // gid
  h.write(`${size.toString(8).padStart(11, '0')} `, 124, 'utf8');
  h.write(`${(0).toString(8).padStart(11, '0')} `, 136, 'utf8'); // mtime
  h.write('        ', 148, 'utf8'); // checksum placeholder
  h.write('0', 156, 'utf8'); // typeflag: regular file
  h.write('ustar\0', 257, 'utf8');
  h.write('00', 263, 'utf8');

  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
  return h;
}

function makeTarGz(entries) {
  const blocks = [];
  for (const [name, body] of entries) {
    const data = Buffer.from(body, 'utf8');
    blocks.push(tarHeader(name, data.length));
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    blocks.push(padded);
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks terminate
  return zlib.gzipSync(Buffer.concat(blocks));
}

// --- parseChecksums -------------------------------------------------------

test('parseChecksums reads the GNU coreutils format', () => {
  const h = 'a'.repeat(64);
  const m = parseChecksums(`${h}  rtk-x86_64-apple-darwin.tar.gz\n`);
  assert.equal(m.get('rtk-x86_64-apple-darwin.tar.gz'), h);
});

test('parseChecksums reads the BSD format', () => {
  const h = 'b'.repeat(64);
  const m = parseChecksums(`SHA256 (rtk.zip) = ${h.toUpperCase()}\n`);
  assert.equal(m.get('rtk.zip'), h, 'must normalize to lowercase');
});

test('parseChecksums handles binary-mode asterisks and path prefixes', () => {
  const h = 'c'.repeat(64);
  const m = parseChecksums(`${h} *dist/rtk.tar.gz\n`);
  assert.equal(m.get('rtk.tar.gz'), h, 'keyed by basename');
});

test('parseChecksums ignores comments, blanks, and malformed lines', () => {
  const h = 'd'.repeat(64);
  const m = parseChecksums(['# a comment', '', 'not a checksum line at all', 'deadbeef short', `${h}  ok.tar.gz`].join('\n'));
  assert.equal(m.size, 1);
  assert.equal(m.get('ok.tar.gz'), h);
});

// --- containment ----------------------------------------------------------

test('isContained accepts children and rejects escapes and sibling prefixes', () => {
  const root = path.resolve('/tmp/dest');
  assert.equal(isContained(path.join(root, 'rtk'), root), true);
  assert.equal(isContained(root, root), true);
  assert.equal(isContained(path.resolve('/tmp/dest/../evil'), root), false);
  // `/tmp/destroy` starts with `/tmp/dest` as a string but is not inside it.
  assert.equal(isContained(path.resolve('/tmp/destroy/x'), root), false);
});

// --- in-process extraction ------------------------------------------------

test('extractTarGzInProcess writes the archive contents', (t) => {
  const dest = tmp('cv-x-');
  t.after(() => rmSync(dest, { recursive: true, force: true }));

  const written = extractTarGzInProcess(makeTarGz([['rtk', 'binary-bytes']]), dest);
  assert.equal(written.length, 1);
  assert.deepEqual(readdirSync(dest), ['rtk']);
  assert.equal(readFileSync(path.join(dest, 'rtk'), 'utf8'), 'binary-bytes');
});

test('extractTarGzInProcess flattens a nested path', (t) => {
  const dest = tmp('cv-n-');
  t.after(() => rmSync(dest, { recursive: true, force: true }));

  // Real release archives sometimes nest the binary a level down.
  extractTarGzInProcess(makeTarGz([['rtk-1.2.3/rtk', 'x']]), dest);
  assert.deepEqual(readdirSync(dest), ['rtk'], 'must be hoisted to the top level');
});

test('extractTarGzInProcess neutralizes a path-traversal entry', (t) => {
  const dest = tmp('cv-t-');
  const parent = path.dirname(dest);
  t.after(() => {
    rmSync(dest, { recursive: true, force: true });
    rmSync(path.join(parent, 'pwned'), { force: true });
  });

  extractTarGzInProcess(makeTarGz([['../../pwned', 'evil'], ['rtk', 'good']]), dest);

  assert.equal(existsSync(path.join(parent, 'pwned')), false, 'must not escape destDir');
  assert.ok(existsSync(path.join(dest, 'pwned')), 'flattened into destDir instead');
  assert.ok(existsSync(path.join(dest, 'rtk')), 'the real entry still extracts');
});

test('extractTarGzInProcess rejects a non-gzip buffer', (t) => {
  const dest = tmp('cv-b-');
  t.after(() => rmSync(dest, { recursive: true, force: true }));
  assert.throws(() => extractTarGzInProcess(Buffer.from('not gzip'), dest));
});

// --- pre-flight archive validation ---------------------------------------

// Whether to skip is decided by probing for `tar` INDEPENDENTLY, never by
// reading inspectArchive's own answer: `if (!res.listable) skip()` is circular —
// a bug that made every archive report unlistable would silently skip the test
// written to catch it.
const HAS_TAR = !!which('tar');

test('inspectArchive flags a traversal entry in a real archive', (t) => {
  if (!HAS_TAR) return t.skip('system tar unavailable');
  const dir = tmp('cv-u-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const archive = path.join(dir, 'evil.tar.gz');
  writeFileSync(archive, makeTarGz([['../escape', 'x']]));

  const res = inspectArchive(archive);
  assert.equal(res.listable, true);
  assert.match(res.unsafe, /escape/);
});

test('inspectArchive reports a clean archive distinctly from an unlistable one', (t) => {
  if (!HAS_TAR) return t.skip('system tar unavailable');
  const dir = tmp('cv-c-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const archive = path.join(dir, 'ok.tar.gz');
  writeFileSync(archive, makeTarGz([['rtk', 'x']]));

  const res = inspectArchive(archive);
  // `unsafe: null` alone is ambiguous — it is also what an UNLISTABLE archive
  // returns, and the caller must REFUSE those rather than extract. That is why
  // the thin findUnsafeEntry() wrapper, which threw `listable` away, is gone.
  assert.deepEqual(res, { listable: true, unsafe: null });
});

test('inspectArchive refuses to call a nonexistent archive safe', () => {
  if (!HAS_TAR) return;
  const res = inspectArchive(path.join(tmp('cv-n-'), 'missing.tar.gz'));
  assert.equal(res.listable, false, 'a failed listing is not a clean bill of health');
});

// --- the full chain, offline ----------------------------------------------

function fixtureSpec(assetName = 'rtk-test.tar.gz') {
  return {
    version: '9.9.9',
    repo: 'example/rtk',
    tagPrefix: 'v',
    verify: 'checksums.txt',
    assets: { 'test-arch': assetName },
    binName: 'rtk',
    fallback: 'cargo install --git https://example/rtk --tag v9.9.9',
  };
}

/** A fetchImpl serving one archive and a matching checksums.txt. */
function serve(archive, { checksum } = {}) {
  const sums = `${checksum ?? sha256(archive)}  rtk-test.tar.gz\n`;
  return async (url) => {
    if (url.endsWith('checksums.txt')) return Buffer.from(sums, 'utf8');
    if (url.endsWith('rtk-test.tar.gz')) return archive;
    throw new Error(`unexpected url ${url}`);
  };
}

test('installFromGithubRelease verifies, extracts, and returns the binary path', async (t) => {
  const destDir = tmp('cv-d-');
  const cacheDir = tmp('cv-cache-');
  t.after(() => {
    rmSync(destDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  const archive = makeTarGz([['rtk', 'the-binary']]);
  const res = await installFromGithubRelease({
    spec: fixtureSpec(),
    platformKey: 'test-arch',
    destDir,
    cacheDir,
    fetchImpl: serve(archive),
  });

  assert.equal(res.ok, true, res.reason);
  assert.equal(res.version, '9.9.9');
  assert.equal(path.basename(res.binPath), 'rtk');
  assert.equal(readFileSync(res.binPath, 'utf8'), 'the-binary');

  if (process.platform !== 'win32') {
    assert.ok(statSync(res.binPath).mode & 0o111, 'must be executable');
  }
});

test('installFromGithubRelease REFUSES a checksum mismatch', async (t) => {
  const destDir = tmp('cv-m-');
  const cacheDir = tmp('cv-mc-');
  t.after(() => {
    rmSync(destDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  const archive = makeTarGz([['rtk', 'tampered']]);
  const res = await installFromGithubRelease({
    spec: fixtureSpec(),
    platformKey: 'test-arch',
    destDir,
    cacheDir,
    fetchImpl: serve(archive, { checksum: 'f'.repeat(64) }),
  });

  assert.equal(res.ok, false);
  assert.match(res.reason, /SHA-256 mismatch/);
  assert.equal(existsSync(path.join(destDir, 'rtk')), false, 'nothing may be written on mismatch');
});

test('installFromGithubRelease refuses when the asset is absent from checksums.txt', async (t) => {
  const destDir = tmp('cv-a-');
  const cacheDir = tmp('cv-ac-');
  t.after(() => {
    rmSync(destDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  const archive = makeTarGz([['rtk', 'x']]);
  const res = await installFromGithubRelease({
    spec: fixtureSpec(),
    platformKey: 'test-arch',
    destDir,
    cacheDir,
    fetchImpl: async (url) =>
      url.endsWith('checksums.txt') ? Buffer.from(`${'a'.repeat(64)}  other-file.tar.gz\n`) : archive,
  });

  assert.equal(res.ok, false);
  assert.match(res.reason, /absent from checksums\.txt/);
});

test('installFromGithubRelease reports the cargo fallback when no asset matches the platform', async () => {
  const res = await installFromGithubRelease({
    spec: fixtureSpec(),
    platformKey: 'sparc-solaris',
    destDir: os.tmpdir(),
    cacheDir: os.tmpdir(),
    fetchImpl: async () => {
      throw new Error('must not fetch');
    },
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /No prebuilt/);
  assert.match(res.fallback, /cargo install/);
});

test('installFromGithubRelease surfaces a download failure without throwing', async (t) => {
  const destDir = tmp('cv-f-');
  const cacheDir = tmp('cv-fc-');
  t.after(() => {
    rmSync(destDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  const res = await installFromGithubRelease({
    spec: fixtureSpec(),
    platformKey: 'test-arch',
    destDir,
    cacheDir,
    fetchImpl: async () => {
      throw new Error('HTTP 404 for asset');
    },
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /Download failed/);
});

test('installFromGithubRelease fails when the archive lacks the expected binary', async (t) => {
  const destDir = tmp('cv-w-');
  const cacheDir = tmp('cv-wc-');
  t.after(() => {
    rmSync(destDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  const archive = makeTarGz([['README.md', 'docs only']]);
  const res = await installFromGithubRelease({
    spec: fixtureSpec(),
    platformKey: 'test-arch',
    destDir,
    cacheDir,
    fetchImpl: serve(archive),
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /found no rtk/);
});

// --- W3: truncation, symlinks, failure kinds, versioned cache --------------

function tarHeaderTyped(name, size, typeflag, linkname = '') {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('000644 \0', 100, 'utf8');
  h.write('000000 \0', 108, 'utf8');
  h.write('000000 \0', 116, 'utf8');
  h.write(`${size.toString(8).padStart(11, '0')} `, 124, 'utf8');
  h.write(`${(0).toString(8).padStart(11, '0')} `, 136, 'utf8');
  h.write('        ', 148, 'utf8');
  h.write(typeflag, 156, 'utf8');
  h.write(linkname.slice(0, 100), 157, 'utf8');
  h.write('ustar\0', 257, 'utf8');
  h.write('00', 263, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
  return h;
}

test('extractTarGzInProcess refuses a truncated tar instead of writing a short binary', (t) => {
  const dest = tmp('cv-trunc-');
  t.after(() => rmSync(dest, { recursive: true, force: true }));

  // Header declares 5000 bytes; only 512 follow. subarray would silently clamp.
  const truncated = zlib.gzipSync(Buffer.concat([tarHeaderTyped('rtk', 5000, '0'), Buffer.alloc(512)]));
  assert.throws(() => extractTarGzInProcess(truncated, dest), /truncated tar/);
  assert.equal(existsSync(path.join(dest, 'rtk')), false);
});

test('extractTarGzInProcess never extracts a symlink entry', (t) => {
  const dest = tmp('cv-sym-');
  t.after(() => rmSync(dest, { recursive: true, force: true }));

  const archive = zlib.gzipSync(
    Buffer.concat([tarHeaderTyped('rtk', 0, '2', '/etc/passwd'), Buffer.alloc(1024)]),
  );
  const written = extractTarGzInProcess(archive, dest);
  assert.deepEqual(written, []);
  assert.equal(existsSync(path.join(dest, 'rtk')), false);
});

test('failure kinds are classified so callers can gate the source-build fallback', async (t) => {
  const destDir = tmp('cv-k-');
  const cacheDir = tmp('cv-kc-');
  t.after(() => {
    rmSync(destDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });
  const archive = makeTarGz([['rtk', 'bytes']]);
  const call = (over) =>
    installFromGithubRelease({
      spec: fixtureSpec(),
      platformKey: 'test-arch',
      destDir,
      cacheDir,
      ...over,
    });

  const noAsset = await call({ platformKey: 'sparc-solaris', fetchImpl: async () => archive });
  assert.equal(noAsset.kind, 'no-asset');

  const down = await call({
    fetchImpl: async () => {
      throw new Error('HTTP 404');
    },
  });
  assert.equal(down.kind, 'download-failed');

  const missing = await call({
    fetchImpl: async (url) =>
      url.endsWith('checksums.txt') ? Buffer.from(`${'a'.repeat(64)}  other.tar.gz\n`) : archive,
  });
  assert.equal(missing.kind, 'checksum-missing');

  rmSync(cacheDir, { recursive: true, force: true });
  const mism = await call({ fetchImpl: serve(archive, { checksum: 'f'.repeat(64) }) });
  assert.equal(mism.kind, 'checksum-mismatch');
  assert.match(mism.reason, /possible tampering/);

  rmSync(cacheDir, { recursive: true, force: true });
  const nobin = await call({ fetchImpl: serve(makeTarGz([['README.md', 'x']])) });
  assert.equal(nobin.kind, 'extract-failed');
});

test('the cache is version-keyed and includes checksums, so rollback works offline', async (t) => {
  const destDir = tmp('cv-vc-');
  const cacheDir = tmp('cv-vcc-');
  t.after(() => {
    rmSync(destDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  const archive = makeTarGz([['rtk', 'v9-bytes']]);
  const first = await installFromGithubRelease({
    spec: fixtureSpec(),
    platformKey: 'test-arch',
    destDir,
    cacheDir,
    fetchImpl: serve(archive),
  });
  assert.equal(first.ok, true, first.reason);
  assert.ok(existsSync(path.join(cacheDir, '9.9.9', 'rtk-test.tar.gz')), 'archive cached under version');
  assert.ok(existsSync(path.join(cacheDir, '9.9.9', 'checksums.txt')), 'checksums cached under version');

  // Roll back with the network gone: everything must come from the cache.
  const offline = await installFromGithubRelease({
    spec: fixtureSpec(),
    platformKey: 'test-arch',
    destDir,
    cacheDir,
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(offline.ok, true, offline.reason);
  assert.equal(readFileSync(offline.binPath, 'utf8'), 'v9-bytes');
});

test('a corrupt cached archive is purged and re-downloaded once, not called tampering', async (t) => {
  const destDir = tmp('cv-cc-');
  const cacheDir = tmp('cv-ccc-');
  t.after(() => {
    rmSync(destDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  const good = makeTarGz([['rtk', 'good-bytes']]);
  const verDir = path.join(cacheDir, '9.9.9');
  mkdirSync(verDir, { recursive: true });
  writeFileSync(path.join(verDir, 'rtk-test.tar.gz'), 'garbage from a half-finished write');
  writeFileSync(path.join(verDir, 'checksums.txt'), `${sha256(good)}  rtk-test.tar.gz\n`);

  let fetches = 0;
  const res = await installFromGithubRelease({
    spec: fixtureSpec(),
    platformKey: 'test-arch',
    destDir,
    cacheDir,
    fetchImpl: async (url) => {
      fetches++;
      return serve(good)(url);
    },
  });
  assert.equal(res.ok, true, res.reason);
  assert.equal(readFileSync(res.binPath, 'utf8'), 'good-bytes');
  assert.ok(fetches >= 1, 'must have re-downloaded after purging the corrupt cache');
  assert.equal(
    readFileSync(path.join(verDir, 'rtk-test.tar.gz')).equals(good),
    true,
    'cache must hold the verified bytes afterwards',
  );
});

test('a broken cached checksums file does not destroy the valid cached archive', async (t) => {
  const destDir = tmp('cv-keep-');
  const cacheDir = tmp('cv-keepc-');
  t.after(() => {
    rmSync(destDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  const archive = makeTarGz([['rtk', 'verified-bytes']]);
  const verDir = path.join(cacheDir, '9.9.9');
  mkdirSync(verDir, { recursive: true });
  writeFileSync(path.join(verDir, 'rtk-test.tar.gz'), archive);
  writeFileSync(path.join(verDir, 'checksums.txt'), 'truncated-'); // no entry for the asset

  // Offline: the archive is the only verified copy in existence.
  const res = await installFromGithubRelease({
    spec: fixtureSpec(),
    platformKey: 'test-arch',
    destDir,
    cacheDir,
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(res.ok, false, 'without checksums it must refuse to install');
  assert.ok(
    readFileSync(path.join(verDir, 'rtk-test.tar.gz')).equals(archive),
    'the archive must survive — only the unusable checksums file may be purged',
  );
});

test('extraction never writes through a planted symlink', (t) => {
  const dest = tmp('cv-symw-');
  const outside = tmp('cv-outside-');
  t.after(() => {
    rmSync(dest, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const victim = path.join(outside, 'victim.txt');
  writeFileSync(victim, 'original');
  symlinkSync(victim, path.join(dest, 'rtk'));

  extractTarGzInProcess(makeTarGz([['rtk', 'archive-bytes']]), dest);
  assert.equal(readFileSync(victim, 'utf8'), 'original', 'the symlink target must be untouched');
  assert.equal(readFileSync(path.join(dest, 'rtk'), 'utf8'), 'archive-bytes');
  assert.equal(lstatSync(path.join(dest, 'rtk')).isSymbolicLink(), false);
});
