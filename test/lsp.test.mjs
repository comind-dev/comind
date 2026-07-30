// The LSP layer replaced mcp-language-server. Two facts have to stay separate
// everywhere: a PLUGIN is installed, and the SERVER BINARY it wraps is present.
// Collapsing them reports a working layer that silently produces no diagnostics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  applyLspPlugins,
  detectLspLanguages,
  lspLanguages,
  lspPluginId,
  lspStatus,
  serverManual,
} from '../lib/lsp.mjs';
import { loadVersions } from '../lib/platform.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const V = loadVersions();
const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), p));

test('all twelve official LSP plugins are declared, none invented', () => {
  // These ids are what `claude plugin install` receives. A typo is a 404 for the
  // whole language, and nothing in a normal run would surface it.
  const expected = [
    'typescript-lsp', 'pyright-lsp', 'gopls-lsp', 'rust-analyzer-lsp',
    'csharp-lsp', 'jdtls-lsp', 'php-lsp', 'clangd-lsp',
    'kotlin-lsp', 'swift-lsp', 'lua-lsp', 'ruby-lsp',
  ];
  const got = lspLanguages(V).map((l) => V.lsp.languages[l].plugin);
  assert.deepEqual([...got].sort(), [...expected].sort());
});

test('plugin ids carry the marketplace qualifier', () => {
  assert.equal(lspPluginId(V, 'go'), 'gopls-lsp@claude-plugins-official');
  assert.equal(lspPluginId(V, 'nope'), null);
});

test('the npm-installable servers report their PINNED install command', () => {
  // TypeScript and Python are the two whose server CoMind installs itself, so
  // their remediation must name the pin — not a bare package name that would
  // resolve `latest` and break the reproducibility guarantee.
  assert.match(serverManual(V, 'typescript'), /typescript@\d/);
  assert.match(serverManual(V, 'typescript'), /typescript-language-server@\d/);
  assert.match(serverManual(V, 'python'), /pyright@\d/);

  // Toolchain-installed servers name that ecosystem's own command instead.
  assert.match(serverManual(V, 'go'), /^go install /);
  assert.match(serverManual(V, 'rust'), /^rustup component add /);
});

test('no LSP entry asks CoMind to install a language toolchain', () => {
  // The rule that keeps this layer honest: CoMind installs plugins and npm
  // packages. It never installs Go, a JDK, or rustup — those are machine-wide
  // and `comind uninstall` could never take them back.
  for (const lang of lspLanguages(V)) {
    const m = serverManual(V, lang) || '';
    assert.ok(
      !/(apt|apt-get|brew|dnf|yum|pacman|apk|choco|winget)\s+install/.test(m),
      `${lang}: remediation must not be an OS package-manager install (${m})`,
    );
    assert.ok(!/\bsudo\b/.test(m), `${lang}: remediation must never require sudo (${m})`);
  }
});

test('detection is per-language and does not leak across languages', () => {
  const repo = tmp('comind-lsp-det-');
  writeFileSync(path.join(repo, 'go.mod'), 'module x\n');
  const got = detectLspLanguages(repo, V);
  assert.deepEqual(got.map((d) => d.lang), ['go']);
  assert.equal(got[0].via, 'marker');
  rmSync(repo, { recursive: true, force: true });
});

test('lspStatus separates plugin presence from server presence', () => {
  const repo = tmp('comind-lsp-status-');
  writeFileSync(path.join(repo, 'Cargo.toml'), '[package]\n');
  // No claude CLI passed: plugin state is UNKNOWN, which is not the same as
  // "not installed" — conflating them would reinstall on every single run.
  const rows = lspStatus(repo, V, null);
  const rust = rows.find((r) => r.lang === 'rust');
  assert.equal(rust.detected, true);
  assert.equal(rust.installed, null, 'no CLI means unknown, never false');
  assert.equal(rust.serverBin, 'rust-analyzer');
  assert.equal(typeof rust.serverPresent, 'boolean', 'the binary probe is independent of the CLI');
  rmSync(repo, { recursive: true, force: true });
});

test('applyLspPlugins never spawns anything without a claude CLI', () => {
  const res = applyLspPlugins(['go', 'rust'], V, { claudeBin: null });
  assert.equal(res.length, 2);
  for (const r of res) {
    assert.equal(r.status, 'skipped');
    assert.match(r.manual, /^claude plugin install \S+-lsp@/);
  }
});

test('an unknown language is reported, not silently skipped', () => {
  const [res] = applyLspPlugins(['cobol'], V, { claudeBin: null });
  assert.equal(res.status, 'unknown-language');
});

test('mcp-language-server and .mcp.json are gone from the shipped package', () => {
  // The replacement is only real if the old layer cannot come back: a leftover
  // template or spec is how a Go prerequisite reappears in a fresh install.
  assert.equal(existsSync(path.join(PKG, 'lib', 'mcp.mjs')), false);
  assert.equal(existsSync(path.join(PKG, 'templates', 'mcp.template.json')), false);
  assert.equal(V.tools['mcp-language-server'], undefined, 'the pin must be gone from versions.json');
});

// --- rtk lives outside every repo, which is why there is no trust store ------

test('the rtk binary and download cache live outside the repo', async () => {
  const { comindPaths } = await import('../lib/platform.mjs');
  const p = comindPaths('/some/repo');

  // The whole point: a cloned repo cannot place a binary that CoMind executes.
  // While these were at .comind/bin and .comind/cache, `comind doctor` — which is
  // documented as read-only — would run a planted rtk, and a SHA-256 trust store
  // existed solely to decide whether that was safe. Moving them removes the
  // attack rather than guarding it.
  assert.ok(!p.bin.startsWith('/some/repo'), `bin must not be inside the repo: ${p.bin}`);
  assert.ok(!p.cache.startsWith('/some/repo'), `cache must not be inside the repo: ${p.cache}`);
  assert.ok(p.state.startsWith('/some/repo'), 'session state is per-repo and stays put');
  assert.ok(p.manifest.startsWith('/some/repo'), 'the committed contract stays in the repo');
});

test('no trust store survives — the mechanism it guarded is gone', () => {
  assert.equal(existsSync(path.join(PKG, 'lib', 'trust.mjs')), false);
  for (const rel of ['lib/install-tools.mjs', 'lib/doctor.mjs', 'bin/comind.js']) {
    const src = readFileSync(path.join(PKG, rel), 'utf8');
    assert.ok(!src.includes('trustedWhich'), `${rel} still resolves rtk through the deleted trust store`);
  }
});
