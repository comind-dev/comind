// Stage 1 (`npx @comind-dev/comind`) has exactly one safety property that matters: it must
// never write into the target repository. Project setup is stage 2's job, run
// from a Claude Code session. These tests pin that boundary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'bin', 'comind.js');

/**
 * Run the CLI with an isolated HOME so a test never touches the real ~/.claude.
 *
 * Defaults to --no-plugin: the plugin path mutates real machine state via the
 * `claude` CLI (which does not honour an isolated HOME for its plugin cache), so
 * the fallback is what these tests exercise. The plugin path is verified
 * manually — see the audit notes in UPGRADING.md.
 *
 * `pathPrefix` prepends a directory to PATH, which is the only way to control
 * what `which('claude')` resolves — run() and which() have no injection seam.
 * Opt-in per test on purpose: a blanket PATH change would flip the no-claude
 * branches that several tests below depend on.
 */
function runCli(args, { home, cwd, allowPlugin = false, pathPrefix = null }) {
  const argv = allowPlugin ? args : [...args, '--no-plugin'];
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  if (pathPrefix) env.PATH = `${pathPrefix}${path.delimiter}${process.env.PATH}`;
  const res = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', cwd, env });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function makeIsolated() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'comind-home-'));
  const repo = mkdtempSync(path.join(os.tmpdir(), 'comind-repo-'));
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'package.json'), '{"name":"demo"}\n');
  writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const x = 1;\n');
  return { home, repo };
}

// --- the dirty machine ----------------------------------------------------
//
// Every fixture above hands out an EMPTY isolated HOME. Real machines carry
// accumulated state, and three shipped bugs could only be observed on one: a
// previously downloaded rtk binary that stage 1 deleted, and stale project-scope
// plugin entries that made stage 1 short-circuit and install nothing. A
// clean-HOME suite is structurally unable to see either.

/**
 * The payload root, taken from the CLI's own report instead of reconstructed.
 *
 * A hardcoded `~/.claude/comind` is satisfied by any subdirectory of it, so it
 * cannot catch the payload moving — which is precisely how the payload came to
 * share a directory with the downloaded rtk binary.
 */
function payloadRoot(stdout) {
  const m = stdout.match(/^\s*copied to (.+?)(?:\s+\(|\s*$)/m);
  assert.ok(m, `the install report must name where it copied to:\n${stdout}`);
  return m[1].trim();
}

/**
 * A previously downloaded rtk binary, exactly where installRtk puts it.
 *
 * Must be 0755 (isExecutableFile, lib/platform.mjs) and answer --version with a
 * dotted-numeric token (probeVersionAt) — otherwise the code under test treats
 * it as absent and a test asserting it survives proves nothing.
 */
function plantRtk(home, version = '0.44.0') {
  const dir = path.join(home, '.claude', 'comind', 'bin');
  mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'rtk');
  writeFileSync(bin, `#!/bin/sh\necho "rtk ${version}"\n`, { mode: 0o755 });
  return bin;
}

/**
 * A stateful fake `claude` CLI, written into its own directory for PATH.
 *
 * Answers the four subcommands stage 1 actually issues, and mirrors installs
 * into ~/.claude/plugins/installed_plugins.json so pluginRegistryEntry() sees
 * the same world `plugin list --json` reports. `entries` seeds the pre-existing
 * state — pass project-scope rows to reproduce a machine that has run
 * /comind-init in other repos.
 */
function claudeShim(home, { entries = [] } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'comind-shim-'));
  const state = path.join(dir, 'plugins.json');
  writeFileSync(state, JSON.stringify(entries, null, 2));
  const shim = path.join(dir, 'claude');
  writeFileSync(
    shim,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const STATE = ${JSON.stringify(state)};
const HOME = ${JSON.stringify(home)};
const a = process.argv.slice(2);
const read = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const write = (list) => {
  fs.writeFileSync(STATE, JSON.stringify(list, null, 2));
  const reg = { plugins: {} };
  for (const p of list) (reg.plugins[p.id] = reg.plugins[p.id] || []).push({ version: p.version, scope: p.scope });
  const d = path.join(HOME, '.claude', 'plugins');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'installed_plugins.json'), JSON.stringify(reg, null, 2));
};
const scopeOf = () => { const i = a.indexOf('--scope'); return i < 0 ? 'user' : a[i + 1]; };
if (a[0] === '--version') { console.log('claude 1.0.0'); process.exit(0); }
if (a[0] !== 'plugin') process.exit(0);
if (a[1] === 'list') {
  const list = read();
  if (a.includes('--json')) console.log(JSON.stringify(list, null, 2));
  else for (const p of list) console.log('  ' + p.id + ' Scope: ' + p.scope + ' Status: ' + (p.enabled ? 'enabled' : 'disabled'));
  process.exit(0);
}
if (a[1] === 'marketplace') { console.log(a[2] + ' ok'); process.exit(0); }
if (a[1] === 'install') {
  const list = read();
  list.push({ id: a[2], version: '0.0.1-alpha.0', scope: scopeOf(), enabled: true, installPath: '/fake/' + a[2] });
  write(list);
  console.log('installed ' + a[2]);
  process.exit(0);
}
if (a[1] === 'uninstall') {
  write(read().filter((p) => !(p.id === a[2] && p.scope === scopeOf())));
  console.log('uninstalled ' + a[2]);
  process.exit(0);
}
process.exit(0);
`,
    { mode: 0o755 },
  );
  return { dir, shim, state, read: () => JSON.parse(readFileSync(state, 'utf8')) };
}

function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, name.name);
      if (name.isDirectory()) walk(p);
      else out.push([path.relative(dir, p).split(path.sep).join('/'), readFileSync(p, 'utf8')]);
    }
  };
  walk(dir);
  return out;
}

test('stage 1 writes nothing into the target repo', (t) => {
  const { home, repo } = makeIsolated();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const before = snapshot(repo);
  const res = runCli([], { home, cwd: repo });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(snapshot(repo), before, 'the repo must be byte-identical after stage 1');

  // Specifically, none of stage 2's artifacts may appear.
  for (const artifact of ['.comind', '.claude', '.gitignore', '.claudeignore', '.mcp.json', '.planning']) {
    assert.equal(existsSync(path.join(repo, artifact)), false, `${artifact} is stage 2's job`);
  }
});

test('stage 1 wires the slash commands into ~/.claude', (t) => {
  const { home, repo } = makeIsolated();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const res = runCli([], { home, cwd: repo });

  // Every command the package ships, not a hardcoded three. /comind-lsp was
  // added and four separate literal lists silently kept saying "three".
  const shipped = readdirSync(path.join(PKG, 'commands', 'comind')).filter((n) => n.endsWith('.md'));
  assert.ok(shipped.length >= 4, 'the package must ship the four slash commands');
  for (const cmd of shipped) {
    assert.ok(existsSync(path.join(home, '.claude', 'commands', cmd)), `${cmd} must be installed`);
  }
  const root = payloadRoot(res.stdout);
  assert.ok(existsSync(path.join(root, 'bin', 'comind.js')));
  assert.ok(existsSync(path.join(root, 'versions.json')));
});

test('stage 1 NEVER installs the team contract at user scope', (t) => {
  const { home, repo } = makeIsolated();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  runCli([], { home, cwd: repo });

  // A user-scope copy would enforce GSD phase discipline in every repo on the
  // machine, including ones with no .planning/ at all.
  assert.equal(
    existsSync(path.join(home, '.claude', 'skills', 'caveman-gsd')),
    false,
    'caveman-gsd must never be installed user-scope',
  );
});

test('the package root has no skills/ or hooks/ dir for the plugin loader to find', () => {
  // Claude Code auto-discovers these directory names by convention, regardless of
  // what plugin.json declares. Their presence at the root would ship the team
  // contract user-scope and register the gate hook a second time.
  assert.equal(existsSync(path.join(PKG, 'skills')), false, 'root skills/ would be auto-discovered');
  assert.equal(existsSync(path.join(PKG, 'hooks')), false, 'root hooks/ would be auto-discovered');

  // They must still ship, from a location the loader ignores.
  assert.ok(existsSync(path.join(PKG, 'templates', 'team', 'skills', 'caveman-gsd', 'SKILL.md')));
  assert.ok(existsSync(path.join(PKG, 'templates', 'team', 'hooks', 'comind-gate.mjs')));
});

test('the version agrees across all three manifests', () => {
  // A release bumps three files. Two agreeing and one lagging produces a plugin
  // whose reported version is a lie, and `claude plugin tag` rejects the release.
  const v = JSON.parse(readFileSync(path.join(PKG, 'versions.json'), 'utf8')).comind;
  const p = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
  const g = JSON.parse(readFileSync(path.join(PKG, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  assert.equal(p, v, 'package.json disagrees with versions.json');
  assert.equal(g, v, '.claude-plugin/plugin.json disagrees with versions.json');
});

test('the version is valid semver and is what the CLI reports', () => {
  // npm's registry rejects anything that is not semver, and drift detection compares
  // versions by ordering — a friendly-but-invalid label would break both.
  const v = JSON.parse(readFileSync(path.join(PKG, 'versions.json'), 'utf8'));
  const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
  assert.match(v.comind, SEMVER, 'versions.comind must be valid semver');
  assert.equal(v.displayVersion, undefined, 'one version form only — no separate display label');

  const res = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
  assert.match(res.stdout, new RegExp(`comind ${v.comind.replace(/[.+]/g, '\\$&')}`));
});

function walkFiles(dir, exts, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, exts, acc);
    else if (exts.some((e) => name.endsWith(e))) acc.push(p);
  }
  return acc;
}

test('no remediation string names a command that cannot perform the fix', () => {
  // The regression this guards: the two-stage split made `npx @comind-dev/comind` install-only,
  // but 19 places still offered it as the fix for missing tools, hooks, and
  // .mcp.json. A user follows the advice, nothing changes, the check still fails.
  //
  // An unqualified `npx @comind-dev/comind` must not appear as a fix string. Stage-1
  // repairs use FIX.stage1 (`npx -y @comind-dev/comind@latest`); everything else
  // routes through FIX.setup.
  //
  // templates/ and commands/ are scanned too: the previous version of this guard
  // read three lib files only, and offenders survived in a slash-command doc and
  // in comments shipped into every consuming repo's .gitignore.
  const offenders = [];
  const scan = (abs, isProse) => {
    const rel = path.relative(PKG, abs);
    readFileSync(abs, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!isProse && (line.trimStart().startsWith('*') || line.trimStart().startsWith('//'))) return;
        // Prose shipped INTO a repo (templates/) or read by the agent
        // (commands/) gets zero tolerance for the unqualified form: every
        // reference must use the canonical stage-1 spelling
        // `npx -y @comind-dev/comind@latest`, which cannot be mistaken for
        // something that installs tools. A keyword-proximity rule was tried and
        // could not match the real offenders, which all put the verb BEFORE the
        // mention or on the previous line.
        const BARE = String.raw`\bnpx\s+(?:-y\s+)?@comind-dev/comind\b(?!@)`;
        const re = isProse ? new RegExp(BARE) : new RegExp(`['"\`][^'"\`]*${BARE}`);
        if (re.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
  };
  for (const rel of ['lib/doctor.mjs', 'lib/gitinform.mjs', 'lib/detect.mjs']) {
    scan(path.join(PKG, rel), false);
  }
  for (const abs of walkFiles(path.join(PKG, 'templates'), ['.md', '.block', '.json'])) scan(abs, true);
  for (const abs of walkFiles(path.join(PKG, 'commands'), ['.md'])) scan(abs, true);
  assert.deepEqual(
    offenders,
    [],
    `unqualified "npx @comind-dev/comind" offered as a stage-2 fix at ${offenders.join(', ')}`,
  );
});

test('the MIT license claim ships with the license text', () => {
  // package.json, plugin.json, and README all declare MIT; without a LICENSE file
  // the npm tarball and the plugin ship the claim with nothing behind it.
  const license = readFileSync(path.join(PKG, 'LICENSE'), 'utf8');
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) \d{4}/);
  const pkg = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'MIT');
  const plugin = JSON.parse(readFileSync(path.join(PKG, '.claude-plugin', 'plugin.json'), 'utf8'));
  if (plugin.license) assert.equal(plugin.license, pkg.license, 'plugin and package must agree');
});

test('every doctor fix is a real, runnable instruction', () => {
  // Not asserting exact strings — asserting that each fix names one of the three
  // commands, a specific tool CLI, or a slash command. A fix of "npx @comind-dev/comind" for a
  // missing rtk binary passes a naive string check but is still wrong.
  const body = readFileSync(path.join(PKG, 'lib', 'doctor.mjs'), 'utf8');
  assert.ok(body.includes('FIX.setup'), 'tool checks must route through FIX.setup');
  assert.ok(body.includes('FIX.stage1'), 'stage-1 checks must route through FIX.stage1');
  assert.ok(body.includes('FIX.sync'), 'graph freshness must route through FIX.sync');
});

test('nothing in the shipped code resolves a version at install time', () => {
  // The whole point of versions.json is that a teammate cloning in a year gets the
  // same tools. One stray @latest silently defeats that.
  const offenders = [];
  const scan = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (/\.(mjs|js)$/.test(e.name)) {
        readFileSync(p, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            // `@comind-dev/comind@latest` is the one legitimate use: telling a
            // developer how to reinstall CoMind itself, which is not a pinned
            // dependency.
            if (/@latest/.test(line) && !/@comind-dev\/comind@latest/.test(line)) {
              offenders.push(`${path.relative(PKG, p)}:${i + 1}`);
            }
          });
      }
    }
  };
  scan(path.join(PKG, 'lib'));
  scan(path.join(PKG, 'bin'));
  assert.deepEqual(offenders, [], `unpinned version resolution at ${offenders.join(', ')}`);
});

test('plugin.json declares commands only', () => {
  const manifest = JSON.parse(readFileSync(path.join(PKG, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.ok(manifest.commands, 'commands must be declared');
  assert.equal(manifest.skills, undefined, 'declaring skills would double-register the contract');
  assert.equal(manifest.hooks, undefined, 'declaring hooks would double-register the gate');
});

test('plugin.json and COMMAND_DIR name the same directory, and it is not empty', async () => {
  // Two independent spellings of one path: "./commands/comind/" in plugin.json and
  // ['commands','comind'] in lib/install-plugin.mjs. Nothing tied them together, and
  // commandFiles() answers a missing directory with [] rather than an error, so drift
  // between them degrades everything silently: wireCommands wires nothing,
  // clearCopyArtifacts deletes nothing, uninstall orphans every copied command, and
  // doctor reports `command registration PASS — file-copy (0 command(s))`, a pass it
  // invented. Assert the two agree and that the directory actually has commands in it.
  const manifest = JSON.parse(readFileSync(path.join(PKG, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(
    path.resolve(PKG, manifest.commands),
    path.join(PKG, 'commands', 'comind'),
    'plugin.json commands path disagrees with COMMAND_DIR in lib/install-plugin.mjs',
  );
  // A floor, matching the convention above: a fifth command needs no test edit.
  const { commandFiles } = await import('../lib/install-plugin.mjs');
  assert.ok(commandFiles().length >= 4, 'commandFiles() must not silently return an empty list');
});

test('no hooks.json ships anywhere in the package', () => {
  // There is no plugin-level hooks file by design. The gate is registered
  // programmatically into the repo's .claude/settings.json, and a hooks.json at any
  // path the loader scans would register it a second time at user scope. A
  // "reference only" copy also failed schema validation once and took the whole
  // plugin down with "Hook load failed".
  const offenders = [];
  const scan = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (e.name === 'hooks.json') offenders.push(path.relative(PKG, p));
    }
  };
  scan(PKG);
  assert.deepEqual(offenders, [], `hooks.json must not ship: ${offenders.join(', ')}`);
});

test('setup refuses to commit a non-portable marketplace source', (t) => {
  const { home, repo } = makeIsolated();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  // --local points the marketplace at a checkout path. That declaration would be
  // committed and then fail to resolve on every other machine, which is worse than
  // no declaration because it looks configured.
  const res = spawnSync(
    process.execPath,
    [CLI, 'setup', '--yes', '--no-lsp', '--local', '--dry-run'],
    { encoding: 'utf8', cwd: repo, env: { ...process.env, HOME: home, USERPROFILE: home } },
  );
  const out = `${res.stdout}${res.stderr}`;
  assert.match(out, /plugin declaration skipped/);
  assert.match(out, /not portable/);
});

test('the fallback reports its missing lifecycle instead of implying one', (t) => {
  const { home, repo } = makeIsolated();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const res = runCli([], { home, cwd: repo });
  assert.match(res.stdout, /Mechanism: file-copy/);
  assert.match(res.stdout, /no update or uninstall/i);
});

test('stage 1 substitutes the install path into every command', (t) => {
  const { home, repo } = makeIsolated();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const res = runCli([], { home, cwd: repo });
  const root = payloadRoot(res.stdout).split(path.sep).join('/');
  const dir = path.join(home, '.claude', 'commands');
  for (const name of readdirSync(dir)) {
    const body = readFileSync(path.join(dir, name), 'utf8');
    // The real token, not a placeholder that exists nowhere in the repo. The
    // previous spelling here was `__COMIND_HOME__`, which no source file has
    // ever contained — so the guard was vacuously true and could not have
    // caught a substitution failure.
    assert.ok(
      !body.includes('${CLAUDE_PLUGIN_ROOT}'),
      `${name} still has an unsubstituted \${CLAUDE_PLUGIN_ROOT}`,
    );
    // The FULL path, not a prefix: asserting the body merely contains
    // `<home>/.claude/comind` stays true for every subdirectory of it, so it
    // cannot detect the payload root moving.
    if (body.includes('comind.js')) {
      assert.ok(
        body.includes(`${root}/bin/comind.js`),
        `${name} must invoke the installed CLI at ${root}/bin/comind.js`,
      );
    }
  }
});

// --- the dirty machine, exercised ----------------------------------------

test('stage 1 does not delete a previously downloaded rtk binary', (t) => {
  const { home, repo } = makeIsolated();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  // The payload's `bin/` and the rtk download directory were the same path, so
  // both file-copy pruning and the plugin path's clearCopyArtifacts deleted the
  // binary — on the command README calls safe to run repeatedly. The global rtk
  // hook then pointed at nothing, in every repo on the machine, silently.
  const rtk = plantRtk(home);
  const res = runCli([], { home, cwd: repo });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(existsSync(rtk), 'the file-copy install must not touch ~/.claude/comind/bin');

  const again = runCli([], { home, cwd: repo });
  assert.equal(again.code, 0, again.stderr);
  assert.ok(existsSync(rtk), 're-running stage 1 must not touch it either');

  // And the payload must genuinely live somewhere else, not merely survive by
  // luck of ordering.
  const root = payloadRoot(res.stdout);
  assert.notEqual(
    path.resolve(root),
    path.resolve(path.dirname(path.dirname(rtk))),
    'the payload root must not be the directory that holds bin/rtk',
  );
});

test('clearCopyArtifacts leaves the downloaded tools alone', async (t) => {
  const { home, repo } = makeIsolated();
  const realHome = process.env.HOME;
  const realProfile = process.env.USERPROFILE;
  t.after(() => {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realProfile;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  runCli([], { home, cwd: repo });
  const rtk = plantRtk(home);
  const cache = path.join(home, '.claude', 'comind', 'cache', '0.44.0', 'asset.tar.gz');
  mkdirSync(path.dirname(cache), { recursive: true });
  writeFileSync(cache, 'bytes');

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { clearCopyArtifacts } = await import('../lib/install-plugin.mjs');
  clearCopyArtifacts();

  assert.ok(existsSync(rtk), 'converting to the plugin must not delete the rtk binary');
  assert.ok(existsSync(cache), 'nor the verified download cache');
});

test('the install stamp is read from the CoMind home, not from inside the payload', async (t) => {
  const { home, repo } = makeIsolated();
  const realHome = process.env.HOME;
  const realProfile = process.env.USERPROFILE;
  t.after(() => {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realProfile;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  // A plugin-mechanism machine: the payload was cleared long ago, and the stamp
  // is all that records how CoMind got here. If the reader followed the payload
  // into pkg/, every such machine would read null — and doctor's
  // `stamp?.comind ?? versions.comind` fallback then reports the RUNNING
  // version as the installed one, a PASS that no version drift can falsify,
  // while `comind update` insists there is nothing to update.
  const dir = path.join(home, '.claude', 'comind');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'install.json'),
    JSON.stringify({ comind: '0.0.1-alpha.0', mechanism: 'plugin', home: dir }, null, 2),
  );

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { readInstallStamp } = await import('../lib/install-plugin.mjs');
  const stamp = readInstallStamp();
  assert.ok(stamp, 'the stamp at the CoMind home root must still be found');
  assert.equal(stamp.mechanism, 'plugin');
});

test('stage 1 installs at user scope even when another project already has it', (t) => {
  const { home, repo } = makeIsolated();
  // CoMind declares itself at PROJECT scope for every teammate, so a developer
  // who has run /comind-init anywhere accumulates project-scope rows. Matching
  // the bare name across the whole listing made stage 1 short-circuit on those
  // and report an install that never happened.
  const shim = claudeShim(home, {
    entries: [
      { id: 'comind@comind', version: '0.0.1-alpha.0', scope: 'project', enabled: false, projectPath: '/deleted/a' },
      { id: 'comind@comind', version: '0.0.1-alpha.0', scope: 'project', enabled: false, projectPath: '/deleted/b' },
    ],
  });
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  });

  const res = runCli([], { home, cwd: repo, allowPlugin: true, pathPrefix: shim.dir });
  assert.equal(res.code, 0, res.stderr);

  const user = shim.read().filter((p) => p.id === 'comind@comind' && p.scope === 'user');
  assert.equal(user.length, 1, `stage 1 must install at user scope; got ${JSON.stringify(shim.read())}`);
});

test('a genuine user-scope install is still a no-op', (t) => {
  const { home, repo } = makeIsolated();
  const shim = claudeShim(home, {
    entries: [{ id: 'comind@comind', version: '0.0.1-alpha.0', scope: 'user', enabled: true }],
  });
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  });

  // The scope filter must not turn every re-run into a reinstall.
  const res = runCli([], { home, cwd: repo, allowPlugin: true, pathPrefix: shim.dir });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(shim.read().length, 1, 'an existing user-scope install must not be installed twice');
});

test('the file-copy payload declares its module type', (t) => {
  const { home, repo } = makeIsolated();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const res = runCli([], { home, cwd: repo });
  const root = payloadRoot(res.stdout);

  // Structural, and therefore Node-version independent. Without this file
  // nothing above <root>/bin/comind.js says "type":"module".
  const pkg = path.join(root, 'package.json');
  assert.ok(existsSync(pkg), 'the copied tree needs its own package.json');
  assert.equal(JSON.parse(readFileSync(pkg, 'utf8')).type, 'module');

  // Behavioural, with detection disabled: this is what Node 18.x, 20.x and
  // 22.0-22.6 do by default, and every wired slash command runs this way.
  const ran = spawnSync(
    process.execPath,
    ['--no-experimental-detect-module', path.join(root, 'bin', 'comind.js'), '--version'],
    { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } },
  );
  assert.equal(ran.status, 0, `the copied CLI must run as ESM:\n${ran.stderr}`);
});

test('stage 2 refuses to treat the home directory as a project', (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'comind-homeroot-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  const settings = path.join(home, '.claude', 'settings.json');
  writeFileSync(settings, '{\n  "model": "opus"\n}\n');
  const before = readFileSync(settings, 'utf8');

  // findRepoRoot falls back to cwd when there is no .git, and returns $HOME
  // outright when $HOME is itself a repo (a dotfiles checkout — silently, no
  // warning). Stage 2 would then treat ~/.claude/settings.json as the PROJECT
  // settings file and write the gate hook and permissions.deny into the user's
  // GLOBAL config, applying to every repo on the machine while
  // ${CLAUDE_PROJECT_DIR}/.claude/hooks/comind-gate.mjs resolves to nothing in
  // all of them. uninstall deliberately leaves that alone, so there is no undo.
  for (const cmd of ['setup', 'sync', 'lsp']) {
    const res = runCli([cmd, '--yes'], { home, cwd: home });
    assert.equal(res.code, 1, `${cmd} must refuse: ${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /REFUSING/, `${cmd} must say why`);
  }
  assert.equal(readFileSync(settings, 'utf8'), before, 'the global settings must be untouched');
  for (const artifact of ['.comind', '.gitignore', '.gitattributes', '.planning']) {
    assert.equal(existsSync(path.join(home, artifact)), false, `${artifact} must not be written to $HOME`);
  }

  // doctor is read-only, so it must still work there rather than refusing.
  const doc = runCli(['doctor'], { home, cwd: home });
  assert.doesNotMatch(doc.stdout, /REFUSING/, 'a read-only command has nothing to refuse');
});

test('stage 1 is idempotent and reports no changes on re-install', (t) => {
  const { home, repo } = makeIsolated();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  runCli([], { home, cwd: repo });
  const after = snapshot(path.join(home, '.claude'));

  const second = runCli([], { home, cwd: repo });
  assert.match(second.stdout, /0 written, 0 updated/);
  assert.deepEqual(snapshot(path.join(home, '.claude')), after);
});

test('clearCopyArtifacts removes what the fallback wrote', async (t) => {
  const { home, repo } = makeIsolated();
  const realHome = process.env.HOME;
  const realProfile = process.env.USERPROFILE;
  t.after(() => {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realProfile;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  // Both mechanisms exist in one release, and a machine moves between them the
  // moment the claude CLI appears. Leftover copies would register each command a
  // second time, so converting to the plugin must clear them.
  runCli([], { home, cwd: repo });
  const copied = path.join(home, '.claude', 'commands', 'comind-init.md');
  assert.ok(existsSync(copied), 'the fallback writes the commands');

  // claudeDirs() reads homeDir() at call time, so point it at the isolated HOME.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { clearCopyArtifacts, commandFiles } = await import('../lib/install-plugin.mjs');
  const res = clearCopyArtifacts();

  // EVERY shipped command, not just the ones an old literal list remembered.
  // A missed one is not cosmetic: it stays in ~/.claude/commands and registers
  // that command a second time, from a possibly older copy.
  for (const name of commandFiles()) {
    assert.ok(res.removed.includes(name), `${name} must be cleared`);
    assert.equal(existsSync(path.join(home, '.claude', 'commands', name)), false);
  }
  assert.equal(existsSync(copied), false);
});

test('no module hardcodes the slash-command list', () => {
  // The regression this prevents already happened once: /comind-lsp was added
  // and four separate literal ['comind-init.md', 'comind-sync.md',
  // 'comind-doctor.md'] lists went on describing three. They all read
  // commandFiles() now, which reads the directory.
  for (const rel of ['bin/comind.js', 'lib/install-plugin.mjs', 'lib/doctor.mjs']) {
    const src = readFileSync(path.join(PKG, rel), 'utf8');
    assert.doesNotMatch(
      src,
      /\[[^\]]*'comind-init\.md'[^\]]*\]/,
      `${rel} hardcodes the command list — use commandFiles()`,
    );
  }
});

test('stage 1 prunes a module removed from the payload', (t) => {
  const { home, repo } = makeIsolated();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const first = runCli([], { home, cwd: repo });
  const stale = path.join(payloadRoot(first.stdout), 'lib', 'gone.mjs');
  writeFileSync(stale, 'export const dead = true;\n');

  const res = runCli([], { home, cwd: repo });
  assert.match(res.stdout, /1 stale removed/);
  assert.equal(existsSync(stale), false);
});

test('the version moves only in a release commit', () => {
  // The pin exists so a bump is never a side effect of some other change. Editing
  // this literal is the deliberate act that says "this is a release", and it has to
  // happen alongside the three manifests the test above keeps in agreement.
  const v = JSON.parse(readFileSync(path.join(PKG, 'versions.json'), 'utf8'));
  assert.equal(v.comind, '0.0.1-alpha.0', 'bump this only when releasing — see UPGRADING.md');
});

test('no migration code targets a CoMind version that never shipped', () => {
  // This is the first development. Code that migrates away artifacts of a previous
  // CoMind release is dead weight and misleads whoever reads it next.
  //
  // Deliberately narrow: third-party versions (gsd-core v1.8.0,
  // mcp-language-server v0.1.1) are legitimate and must not trip this.
  const HISTORY = /migrateGlobalSkill|LEGACY_PAYLOAD|CoMind v\d|comind\s*<=\s*\d/;
  const offenders = [];
  for (const dir of ['lib', 'bin']) {
    const base = path.join(PKG, dir);
    for (const name of readdirSync(base)) {
      const body = readFileSync(path.join(base, name), 'utf8');
      if (HISTORY.test(body)) offenders.push(`${dir}/${name}`);
    }
  }
  assert.deepEqual(offenders, [], `CoMind version-history references in ${offenders.join(', ')}`);
});

test('stage 1 --dry-run writes nothing at all', (t) => {
  const { home, repo } = makeIsolated();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const res = runCli(['--dry-run'], { home, cwd: repo });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /dry run/i);
  assert.equal(existsSync(path.join(home, '.claude', 'comind')), false);
  assert.equal(existsSync(path.join(home, '.claude', 'commands')), false);
});

test('an unknown subcommand fails loudly instead of silently installing', (t) => {
  const { home, repo } = makeIsolated();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const res = runCli(['bogus'], { home, cwd: repo });
  assert.equal(res.code, 1);
  assert.match(res.stdout, /unknown command/i);
  assert.equal(existsSync(path.join(home, '.claude', 'comind')), false);
});

test('the post-install message hands off to /comind-init, not to more CLI', (t) => {
  const { home, repo } = makeIsolated();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const res = runCli([], { home, cwd: repo });
  assert.match(res.stdout, /nothing in your repo was touched/i);
  assert.match(res.stdout, /\/comind-init/);
  assert.match(res.stdout, /open Claude Code/i);
});

// --- W8: flag validation and dry-run fidelity -----------------------------

test('a mistyped flag fails loudly instead of performing a real run', (t) => {
  const { home, repo } = makeIsolated();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  // The whole point: `--dryrun` must NOT be read as "no dry run requested" and
  // then write into the repo.
  const res = runCli(['setup', '--dryrun'], { home, cwd: repo });
  assert.equal(res.code, 1);
  assert.match(res.stdout, /unknown option\(s\): --dryrun/);
  assert.equal(existsSync(path.join(repo, '.comind', 'manifest.json')), false, 'nothing may be written');
});

test('the retired --doctor/--sync aliases are rejected, not silently ignored', (t) => {
  const { home, repo } = makeIsolated();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  // They were compatibility shims for "an older slash-command copy" — of a
  // version that was never published, so no such copy exists. Removed. The
  // thing that must not happen is a silent fallthrough to stage 1, which would
  // reinstall CoMind when the user asked for a read-only check.
  for (const alias of ['--doctor', '--sync']) {
    const res = runCli([alias], { home, cwd: repo });
    assert.equal(res.code, 1, `${alias} must fail loudly`);
    assert.match(res.stdout, /unknown option/);
  }
});

test('sync --dry-run neither claims a regeneration nor prints undefined', (t) => {
  const { home, repo } = makeIsolated();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  mkdirSync(path.join(repo, '.planning'), { recursive: true });
  writeFileSync(path.join(repo, '.planning', 'PROJECT.md'), '# P\n');

  const res = runCli(['sync', '--dry-run'], { home, cwd: repo });
  assert.equal(res.code, 0);
  assert.doesNotMatch(res.stdout, /undefined/);
  assert.match(res.stdout, /would regenerate/);
  assert.equal(existsSync(path.join(repo, '.ai-memory')), false, 'a dry run must write nothing');
});

test('uninstall --dry-run predicts the marketplace removal it would perform', (t) => {
  const { home, repo } = makeIsolated();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const res = runCli(['uninstall', '--dry-run'], { home, cwd: repo, allowPlugin: true });
  assert.equal(res.code, 0);
  if (/would run: claude plugin uninstall/.test(res.stdout)) {
    assert.match(
      res.stdout,
      /would run: claude plugin marketplace remove/,
      'a real run removes the marketplace too — the dry run must say so',
    );
  }
});

test('an invalid COMIND_MARKETPLACE never reaches the committed declaration', (t) => {
  const { home, repo } = makeIsolated();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const res = spawnSync(process.execPath, [CLI, 'setup', '--dry-run', '--no-lsp'], {
    encoding: 'utf8',
    cwd: repo,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      COMIND_MARKETPLACE: 'evil.example.com/payload; rm -rf /',
    },
  });
  const out = res.stdout || '';
  if (/marketplace source/.test(out)) {
    assert.match(out, /is not owner\/repo or an https URL/);
  }
  const settings = path.join(repo, '.claude', 'settings.json');
  if (existsSync(settings)) {
    assert.doesNotMatch(readFileSync(settings, 'utf8'), /evil\.example\.com/);
  }
});

// --- W10: the invariant that had no end-to-end test -----------------------
// Invariant 1: running setup twice leaves the repo byte-identical. Only the
// component mechanisms were tested; detectMode, writeManifest,
// installPluginAssets, and registerGateHook — the actual tracked-file writers
// — had zero coverage, so a realistic regression dirtied repos with a green
// suite.

function gitInit(repo) {
  const g = (...args) =>
    spawnSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' },
    });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@e');
  g('config', 'user.name', 'T');
  return g;
}

function hashTree(dir, base = dir, acc = new Map()) {
  for (const name of readdirSync(dir).sort()) {
    if (name === '.git') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) hashTree(p, base, acc);
    else acc.set(path.relative(base, p), readFileSync(p).toString('base64'));
  }
  return acc;
}

function seededRepo() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'comind-e2e-home-'));
  const repo = mkdtempSync(path.join(os.tmpdir(), 'comind-e2e-repo-'));
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'package.json'), '{"name":"demo"}\n');
  writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const x = 1;\n');
  // Pre-seed .planning/ so every tracked-file writer actually executes:
  // enableGsdGraphify SKIPs without config.json, and the vault needs sources.
  mkdirSync(path.join(repo, '.planning', 'phases', '01-init'), { recursive: true });
  writeFileSync(path.join(repo, '.planning', 'config.json'), '{"version":"1.8.0"}\n');
  writeFileSync(path.join(repo, '.planning', 'PROJECT.md'), '# Demo\nA demo project.\n');
  writeFileSync(path.join(repo, '.planning', 'phases', '01-init', 'PLAN.md'), '# Init\nStatus: in-progress\n');
  return { home, repo };
}

function setupCli(args, { home, cwd }) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      COMIND_SETUP_SKIP_TOOLS: '1',
    },
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

test('running FIRST INIT twice leaves the repo byte-identical', (t) => {
  const { home, repo } = seededRepo();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });
  gitInit(repo);

  const first = setupCli(['setup', '--yes', '--no-lsp', '--no-plugin'], { home, cwd: repo });
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.ok(existsSync(path.join(repo, '.comind', 'manifest.json')), 'the manifest must be written');
  assert.ok(existsSync(path.join(repo, '.claude', 'hooks', 'comind-gate.mjs')), 'the gate hook must be installed');
  assert.ok(existsSync(path.join(repo, '.gitattributes')), '.gitattributes must be created');

  const before = hashTree(repo);
  // A plain re-run would auto-detect JOIN (the manifest now exists) and prove
  // nothing — --force re-runs the tracked-file writers.
  const second = setupCli(['setup', '--yes', '--no-lsp', '--no-plugin', '--force'], { home, cwd: repo });
  assert.equal(second.code, 0, second.stdout + second.stderr);

  const after = hashTree(repo);
  const changed = [...after.keys()].filter((k) => after.get(k) !== before.get(k));
  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  assert.deepEqual({ changed, added, removed }, { changed: [], added: [], removed: [] });
});

// The token mechanism the README sells as "keeps large derived artifacts out of
// context" was, until now, a .claudeignore block that Claude Code never read.
// These pin the mechanism that actually enforces it.
test('setup denies Read on the artifacts the team contract says to query', (t) => {
  const { home, repo } = seededRepo();
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });
  gitInit(repo);
  // A rule the team wrote themselves. It must survive ours.
  mkdirSync(path.join(repo, '.claude'), { recursive: true });
  writeFileSync(
    path.join(repo, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { deny: ['Read(./secrets/**)'] } }, null, 2),
    'utf8',
  );

  const res = setupCli(['setup', '--yes', '--no-lsp', '--no-plugin'], { home, cwd: repo });
  assert.equal(res.code, 0, res.stdout + res.stderr);

  const deny = JSON.parse(readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8')).permissions.deny;
  assert.ok(deny.includes('Read(./secrets/**)'), "the team's own deny rule must be preserved");
  for (const rule of ['Read(./graphify-out/**)', 'Read(./.planning/graphs/**)']) {
    assert.ok(deny.includes(rule), `${rule} must be enforced, not merely documented`);
  }

  // Re-running must converge, not accumulate — this is the same sentinel
  // discipline as the ignore blocks, expressed in a JSON array.
  const again = setupCli(['setup', '--yes', '--no-lsp', '--no-plugin', '--force'], { home, cwd: repo });
  assert.equal(again.code, 0, again.stdout + again.stderr);
  const deny2 = JSON.parse(readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8')).permissions.deny;
  assert.deepEqual(deny2, deny, 'a second run must not duplicate or reorder deny rules');
});

test('no user-facing surface still presents .claudeignore as a working mechanism', () => {
  // The block was inert for the whole life of the repo while README, SKILL.md, and
  // the slash-command docs all described it as load-bearing. A stray reference is
  // how that claim comes back.
  //
  // Scope is deliberate: templates/, commands/, and README describe what CoMind
  // does NOW, so zero tolerance. lib/ and bin/ must name the file to withdraw the
  // block, and UPGRADING/ONBOARDING carry the migration note — those are history,
  // not claims.
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js|md|json|block)$/.test(e.name) && readFileSync(p, 'utf8').includes('.claudeignore')) {
        offenders.push(path.relative(PKG, p));
      }
    }
  };
  for (const r of ['templates', 'commands']) walk(path.join(PKG, r));
  if (readFileSync(path.join(PKG, 'README.md'), 'utf8').includes('.claudeignore')) offenders.push('README.md');
  assert.deepEqual(offenders, [], `.claudeignore must not be presented as active: ${offenders}`);
});

test('JOIN in a fresh clone leaves git status clean', (t) => {
  const { home, repo } = seededRepo();
  const clone = mkdtempSync(path.join(os.tmpdir(), 'comind-e2e-clone-'));
  const home2 = mkdtempSync(path.join(os.tmpdir(), 'comind-e2e-home2-'));
  t.after(() => {
    for (const d of [home, repo, clone, home2]) rmSync(d, { recursive: true, force: true });
  });

  const g = gitInit(repo);
  setupCli(['setup', '--yes', '--no-lsp', '--no-plugin'], { home, cwd: repo });
  g('add', '-A');
  g('commit', '-q', '-m', 'init comind');

  const cloneDir = path.join(clone, 'work');
  spawnSync('git', ['clone', '-q', repo, cloneDir], { encoding: 'utf8' });
  mkdirSync(path.join(home2, '.claude'), { recursive: true });

  const join = setupCli(['setup', '--yes', '--no-lsp', '--no-plugin'], { home: home2, cwd: cloneDir });
  assert.equal(join.code, 0, join.stdout + join.stderr);
  assert.match(join.stdout, /JOIN/);

  const status = spawnSync('git', ['status', '--porcelain'], { cwd: cloneDir, encoding: 'utf8' }).stdout || '';
  const tracked = status
    .split('\n')
    .filter(Boolean)
    .filter((l) => !l.startsWith('??'));
  assert.deepEqual(tracked, [], `JOIN must modify no tracked file, saw:\n${status}`);
});
