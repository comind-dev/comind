#!/usr/bin/env node
// CoMind installer.
//
// Node built-ins only, zero npm dependencies, so `npx comind` needs no install
// step. The .sh and .ps1 files next to this one are two-line wrappers that exec
// straight into here.
//
// macOS and Linux are tested. The win32 paths exist and their pure logic is
// unit-tested, but nothing here has ever run on a real Windows host — do not
// read the presence of a win32 branch as evidence that it works.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  PKG_ROOT,
  PLATFORM_KEY,
  loadVersions,
  comindPaths,
  comindHome,
  homeDir,
  which,
  probeVersion,
  probeVersionAt,
  run,
  FIX,
} from '../lib/platform.mjs';
import {
  MODE,
  detectMode,
  detectLanguages,
  findRepoRoot,
  isGitRepo,
  writeManifest,
  diffVersions,
} from '../lib/detect.mjs';
import { applyIgnores } from '../lib/ignores.mjs';
import { generateVault } from '../lib/vault.mjs';
import { renderInformer } from '../lib/gitinform.mjs';
import { runDoctor, renderDoctor } from '../lib/doctor.mjs';
import {
  installPlugin,
  renderInstallNextSteps,
  claudeDirs,
  commandFiles,
  readInstallStamp,
  claudePluginVersion,
  MECHANISM,
} from '../lib/install-plugin.mjs';
import { applyLspPlugins, detectLspLanguages, lspLanguages, lspStatus } from '../lib/lsp.mjs';
import {
  ensureComindDirs,
  enableGsdGraphify,
  registerGraphMergeDriver,
  renderGraphHtml,
  initRtkHook,
  installCaveman,
  installGraphify,
  installGsdCore,
  installLspServers,
  installRtk,
  readGsdVersion,
  reportGsdDrift,
  readGlobalSettings,
  registeredRtkCommands,
  unpinRtkHookPath,
} from '../lib/install-tools.mjs';

const HELP = `
comind — Collaborative Mind. Team-shared AI context for Claude Code.

CoMind installs in two stages, on purpose:

  STAGE 1  npx comind          Installs CoMind itself. Touches nothing in your
                               repo. Makes /comind-init available in Claude Code.

  STAGE 2  /comind-init        Sets up a project. Run it inside a Claude Code
                               session, in the repo you want managed. This is
                               where every tool, hook, and file actually lands.

Project setup is stage 2 because it needs a reasoning agent: GSD onboarding maps
the codebase with subagents and asks you about intent. A shell script cannot do
that, and a half-written .planning/ is worse than none.

COMMANDS
  (default)       Stage 1. Install CoMind as a Claude Code plugin and wire its
                  slash commands. Repo-safe. Falls back to a file copy in
                  ~/.claude/comind when the claude CLI is unavailable.
  setup           Stage 2 mechanics. Invoked by /comind-init — installs the
                  pinned tools, hooks, LSP config, ignore blocks, and manifest.
  sync            Regenerate .ai-memory/ from .planning/. Invoked by /comind-sync.
  doctor          Verify every layer and report version drift. Read-only.
  lsp             Show LSP language status; install/remove language plugins.
                  Invoked by /comind-lsp.
  update          Update CoMind itself (plugin installs only).
  uninstall       Remove CoMind. Prints, but does not run, the removal commands
                  for RTK, caveman, and GSD — those are not CoMind's to delete.

OPTIONS
  --dry-run       Show every action without writing anything
  --metrics       With doctor: include measured token savings
  --join          Force JOIN mode (machine-local setup only)
  --force         Force FIRST INIT even if a manifest exists
  --no-lsp        Skip the LSP layer entirely
  --lsp=<langs>   Comma-separated languages for setup/lsp (e.g. --lsp=go,rust).
                  Omit to use what this repo actually contains.
  --remove        With lsp: uninstall the named language plugins
  --local         Install from this checkout instead of the published marketplace
  --no-plugin     Force the file-copy fallback (for testing the degraded path)
  --yes           Non-interactive; assume yes
  --json          Machine-readable output
  -h, --help      This text
  -v, --version   The comind version and every pinned tool version

THE FIVE LAYERS (all wired by stage 2)
  RTK          compresses verbose tool output before it reaches context
  Caveman      compresses Claude's own output
  GSD Core     enforces Discuss -> Plan -> Execute -> Verify -> Ship
  graphify     builds a queryable knowledge graph (via GSD's /gsd-graphify)
  LSP          deterministic verification via Anthropic's language-server
               plugins — 12 languages, installed only for what this repo has
`;

const SUBCOMMANDS = new Set(['install', 'setup', 'sync', 'doctor', 'uninstall', 'update', 'lsp']);

/**
 * Every flag the CLI accepts.
 *
 * A typo used to be silently ignored, so `comind setup --dryrun` performed a
 * REAL setup — writing into the repo the user was trying to preview. Unknown
 * positionals already failed loudly; unknown flags now do too.
 */
const KNOWN_FLAGS = new Set([
  '-h', '--help', '-v', '--version',
  '--dry-run', '--metrics', '--join', '--force', '--no-lsp',
  '--yes', '-y', '--json', '--local', '--no-plugin',
  '--remove',
]);

/** `--lsp=go,rust` — value-carrying, so it cannot live in the plain flag set. */
const LSP_FLAG = /^--lsp=(.*)$/;

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('-')));
  const positional = argv.filter((a) => !a.startsWith('-'));
  const cmd = SUBCOMMANDS.has(positional[0]) ? positional[0] : null;
  const lspFlag = [...flags].map((f) => f.match(LSP_FLAG)).find(Boolean);
  const unknownFlags = [...flags].filter((f) => !KNOWN_FLAGS.has(f) && !LSP_FLAG.test(f));

  return {
    unknownFlags,
    // No subcommand means stage 1.
    command: cmd || 'install',
    unknown: !cmd && positional.length > 0 ? positional[0] : null,
    help: flags.has('-h') || flags.has('--help'),
    version: flags.has('-v') || flags.has('--version'),
    dryRun: flags.has('--dry-run'),
    metrics: flags.has('--metrics'),
    join: flags.has('--join'),
    force: flags.has('--force'),
    noLsp: flags.has('--no-lsp'),
    yes: flags.has('--yes') || flags.has('-y'),
    json: flags.has('--json'),
    // Install from this checkout instead of the published marketplace. Needed
    // before publication, and how the plugin path gets verified in tests.
    local: flags.has('--local'),
    forceCopy: flags.has('--no-plugin'),
    remove: flags.has('--remove'),
    // `--lsp=` present but empty means "none", which is not the same as absent
    // (absent = use detection). null vs [] has to survive parsing.
    lspLangs: lspFlag ? lspFlag[1].split(',').map((x) => x.trim()).filter(Boolean) : null,
    // Bare positionals after `lsp`: `comind lsp go rust`.
    args: positional.slice(1),
  };
}

const log = (msg = '') => process.stdout.write(`${msg}\n`);

/**
 * Do two paths name the same directory?
 *
 * realpath, not resolve: on macOS /var is a symlink to /private/var, so
 * process.cwd() (already resolved by the OS) and $HOME (whatever the user's env
 * says) can spell the same directory differently. A string compare would then
 * miss the case this exists to catch. Falls back to a plain compare when either
 * path does not exist.
 */
function samePath(a, b) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const versions = loadVersions();

  if (opts.help) {
    log(HELP);
    return 0;
  }
  if (opts.version) {
    if (opts.json) log(JSON.stringify(versions, null, 2));
    else {
      log(`comind ${versions.comind}  (${PLATFORM_KEY})`);
      for (const [name, spec] of Object.entries(versions.tools)) {
        log(`  ${name.padEnd(28)} ${spec.version}  [${spec.source}]`);
      }
    }
    return 0;
  }

  if (opts.unknown) {
    log(`comind: unknown command "${opts.unknown}". Try: comind --help`);
    return 1;
  }

  if (opts.unknownFlags.length) {
    // Never proceed: a mistyped --dry-run would otherwise write for real.
    log(`comind: unknown option(s): ${opts.unknownFlags.join(' ')}. Try: comind --help`);
    return 1;
  }

  // --- STAGE 1: install only. Must not touch the target repo. ---
  if (opts.command === 'install') {
    const report = installPlugin(versions, {
      dryRun: opts.dryRun,
      log,
      local: opts.local,
      forceCopy: opts.forceCopy,
    });
    if (opts.json) {
      log(JSON.stringify(report, null, 2));
      return 0;
    }
    if (opts.dryRun) {
      log('');
      log(`comind ${versions.comind} — stage 1 install (dry run)`);
      log(`  mechanism:  ${report.mechanism}`);
      log(`  source:     ${report.source}`);
      log(`  commands:   ${report.commands.join('  ')}`);
      if (report.wouldClear?.length) {
        log(`  would clear: ${report.wouldClear.join('  ')}  (file-copy leftovers)`);
      }
      if (report.wouldWriteStamp) log(`  would write: ${report.wouldWriteStamp}`);
      log('  skill:      NOT installed globally — project-scoped by `comind setup`');
      log('  target repo: untouched (stage 1 never writes outside ~/.claude)');
      log('');
      return 0;
    }
    log(renderInstallNextSteps(report, versions));
    return report.ok ? 0 : 1;
  }

  if (opts.command === 'uninstall') {
    return uninstall(versions, opts, log);
  }

  if (opts.command === 'update') {
    return update(versions, opts, log);
  }

  const repoRoot = findRepoRoot(process.cwd());

  // $HOME is not a project.
  //
  // findRepoRoot falls back to cwd when there is no .git, and returns $HOME
  // outright when $HOME is itself a repo (a dotfiles checkout — common, and it
  // produces no warning at all). Stage 2 would then treat ~/.claude/settings.json
  // as the PROJECT settings file: the gate hook and permissions.deny would be
  // written into the user's GLOBAL Claude Code config, applying to every repo on
  // the machine, with ${CLAUDE_PROJECT_DIR}/.claude/hooks/comind-gate.mjs
  // resolving to nothing in all of them. `uninstall` deliberately leaves
  // .claude/hooks/ and the settings entry alone, so there would be no undo.
  //
  // Checked here rather than inside setup because `lsp` writes .mcp.json and the
  // LSP plugin declarations into the same place.
  const WRITES_PROJECT_FILES = new Set(['setup', 'sync', 'lsp']);
  if (WRITES_PROJECT_FILES.has(opts.command) && samePath(repoRoot, homeDir())) {
    log('');
    log(`  REFUSING: this resolved your home directory as the project root (${repoRoot}).`);
    log('');
    log('  CoMind would write the gate hook and the permissions.deny rules into');
    log('  ~/.claude/settings.json — your GLOBAL Claude Code config — where they');
    log('  would apply to every repo on this machine and point at a hook file that');
    log('  does not exist in any of them.');
    log('');
    log('  cd into the project you want managed and run this there.');
    log('');
    return 1;
  }

  if (opts.command === 'doctor') {
    const result = runDoctor(repoRoot, versions, { metrics: opts.metrics });
    log(opts.json ? JSON.stringify(result, null, 2) : renderDoctor(result));
    return result.checks.some((c) => c.status === 'fail') ? 1 : 0;
  }

  if (opts.command === 'lsp') {
    return cmdLsp(repoRoot, versions, opts);
  }

  if (opts.command === 'sync') {
    const vault = generateVault(repoRoot, versions, { dryRun: opts.dryRun });
    if (!vault.ok) {
      log(`comind: ${vault.reason}`);
      return 1;
    }
    if (vault.dryRun) {
      // The dry run writes nothing, so it must not claim a regeneration
      // happened — and stats.notes does not exist on this path.
      log(`comind: would regenerate .ai-memory/ from .planning/ (nothing written)`);
      return 0;
    }
    log(
      `comind: .ai-memory/ regenerated — ${vault.stats.notes} note(s), ` +
        `${vault.removed.length} stale note(s) pruned`,
    );
    // graph.html is the one graphify output that is not committed, on the
    // grounds that re-rendering it is free. That only holds if something
    // actually re-renders it.
    const html = renderGraphHtml({ repoRoot, versions, dryRun: false });
    if (html.status === 'ok') log(`comind: ${html.note}`);
    else if (html.status === 'skipped') log(`comind: graph.html not rendered — ${html.reason}`);
    return 0;
  }

  // --- STAGE 2: `comind setup`, invoked by /comind-init ---
  const forced = opts.join ? 'join' : opts.force ? 'first' : null;
  const { mode, manifest, note } = detectMode(repoRoot, forced);
  const languages = detectLanguages(repoRoot);

  log('');
  log(`comind ${versions.comind} — ${mode}${opts.dryRun ? ' (dry run)' : ''}`);
  log(`  repo:      ${repoRoot}`);
  log(`  platform:  ${PLATFORM_KEY}`);
  log(
    // Every detected language, not the two the LSP layer used to support. This
    // line drives the developer's expectation of which plugins will install, so
    // reporting "none detected" for a Go repo was worse than saying nothing.
    `  languages: ${Object.keys(languages).filter((l) => languages[l]).join(', ') || 'none detected'}`,
  );
  if (note) log(`  note:      ${note}`);
  if (!isGitRepo(repoRoot)) {
    log('  warning:   not a git repository — run `git init` to share this setup');
  }
  log('');

  const ctx = {
    versions,
    repoRoot,
    languages,
    mode,
    log,
    dryRun: opts.dryRun,
    noLsp: opts.noLsp,
    yes: opts.yes,
  };

  ensureComindDirs(repoRoot, opts.dryRun);

  // --- prerequisites ---
  const prereqs = checkPrereqs();
  for (const p of prereqs) {
    if (!p.ok && p.required) {
      log(`comind: missing required prerequisite: ${p.name} — ${p.fix}`);
      return 1;
    }
  }
  const missingOptional = prereqs.filter((p) => !p.ok && !p.required);
  if (missingOptional.length) {
    log('  optional prerequisites missing (affected layers will be skipped, not failed):');
    for (const p of missingOptional) log(`    ${p.name.padEnd(10)} ${p.fix}`);
    log('');
  }

  // --- pinned tools ---
  // COMIND_SETUP_SKIP_TOOLS skips only the network/toolchain installers, so the
  // tracked-file writers below still run. It exists for the end-to-end
  // idempotence test, which must exercise the real setup path without
  // downloading anything. It never skips a step that writes a repo file.
  const skipTools = process.env.COMIND_SETUP_SKIP_TOOLS === '1';
  const SKIPPED = (name) => ({ name, status: 'skipped', reason: 'COMIND_SETUP_SKIP_TOOLS=1' });

  log(skipTools ? 'installing pinned tools (skipped: COMIND_SETUP_SKIP_TOOLS=1)' : 'installing pinned tools');
  const results = [];
  if (skipTools) {
    for (const name of ['rtk', 'rtk-hook', 'caveman', 'gsd-core', 'graphifyy']) results.push(SKIPPED(name));
    if (!opts.noLsp) for (const name of ['lsp-servers', 'lsp-plugins']) results.push(SKIPPED(name));
  } else {
    results.push(await installRtk(ctx));
    results.push(initRtkHook(ctx));
    results.push(installCaveman(ctx));
    // gsd-core lands in committed files (.claude/gsd-*, .planning/config.json),
    // so only FIRST INIT may write it. JOIN's contract is "touch NO tracked
    // file" — a version-drifted joiner reinstalling here used to rewrite the
    // team's committed install before the drift warning ever printed.
    if (mode === MODE.FIRST_INIT) {
      results.push(installGsdCore(ctx));
    } else {
      results.push(reportGsdDrift(ctx));
    }
    results.push(installGraphify(ctx));
    if (!opts.noLsp) {
      results.push(installLspServers(ctx));
      results.push(setupLspPlugins(ctx, opts));
    }
  }
  // A tracked-file write, not an install — it must run even when tools are
  // skipped, or the idempotence test would not cover it.
  if (mode === MODE.FIRST_INIT) results.push(enableGsdGraphify(ctx));
  // Machine-local git config, so JOIN runs it too: the committed .gitattributes
  // names a merge driver that only exists once each developer registers it.
  // No network and no tracked file, which is why COMIND_SETUP_SKIP_TOOLS
  // does not gate it.
  results.push(registerGraphMergeDriver(ctx));
  log('');

  // --- tracked repo files: FIRST INIT only ---
  let vault = null;
  if (mode === MODE.FIRST_INIT) {
    const ignores = applyIgnores(repoRoot, { version: versions.comind, dryRun: opts.dryRun });
    for (const r of ignores) {
      if (r.action === 'error') log(`  ${r.file}: ${r.error}`);
      else log(`  ${r.file.padEnd(16)} ${r.action}`);
      if (r.overrides?.length) {
        log(`      note: this repo ignores ${r.overrides.join(', ')} — the managed block`);
        log('      re-includes .claude/ so the committed team settings, hook, and skill');
        log('      travel with the repo. Remove the block to keep them ignored.');
      }
    }

    // Order matters: the plugin CLI and registerGateHook both write
    // .claude/settings.json, and the hook registration re-reads the file, so the
    // CLI's write must land first or it gets clobbered.
    declareProjectPlugin(versions, repoRoot, opts, log);
    installPluginAssets(repoRoot, opts.dryRun, log);

    vault = generateVault(repoRoot, versions, { dryRun: opts.dryRun });

    if (!opts.dryRun) {
      const layers = {
        rtk: results.find((r) => r.name === 'rtk')?.status !== 'failed',
        caveman: results.find((r) => r.name === 'caveman')?.status !== 'failed',
        gsd: results.find((r) => r.name === 'gsd-core')?.status !== 'failed',
        graphify: results.find((r) => r.name === 'graphifyy')?.status !== 'failed',
        lsp: !opts.noLsp && results.find((r) => r.name === 'lsp-plugins')?.status !== 'failed',
      };
      writeManifest(repoRoot, { versions, layers, languages });
      log('  .comind/manifest.json written');
    }
  } else {
    // JOIN: report drift only. Never write a tracked file.
    vault = existsSync(path.join(repoRoot, '.ai-memory'))
      ? { ok: true, stats: null }
      : { ok: false, reason: 'vault absent — ask whoever ran FIRST INIT to commit .ai-memory/' };
  }

  // --- drift ---
  const installed = probeInstalled(repoRoot, versions, languages, { noLsp: opts.noLsp });
  const drift = diffVersions(versions, installed);

  if (mode === MODE.JOIN && manifest && !manifest.__corrupt) {
    for (const [tool, want] of Object.entries(manifest.tools || {})) {
      const pinnedNow = versions.tools[tool]?.version;
      if (pinnedNow && String(want).replace(/^v/, '') !== String(pinnedNow).replace(/^v/, '')) {
        log(
          `  contract drift: repo pins ${tool} ${want}, this comind pins ${pinnedNow}. ` +
            `Install comind@${manifest.comind} to match your team.`,
        );
      }
    }
  }

  log(renderInformer({ repoRoot, mode, versions, results, drift, vault }));

  if (mode === MODE.FIRST_INIT && !existsSync(path.join(repoRoot, '.planning'))) {
    log('  Run /gsd-onboard inside Claude Code to create .planning/, then re-run');
    log(`  \`${FIX.setup}\` so the vault and graphify config pick it up.`);
    log('');
  }

  return results.some((r) => r.status === 'failed') ? 1 : 0;
}

/**
 * Remove CoMind itself.
 *
 * Deliberately narrow: it removes what CoMind installed for CoMind. It does NOT
 * remove RTK's global hook, the caveman plugin, or a repo's committed .planning/
 * — those belong to other tools or to the team, and silently deleting them would
 * be a far worse surprise than one extra line of output. They are printed for the
 * developer to run if they want.
 */
function uninstall(versions, opts, log) {
  const claude = which('claude');
  // comindHome(), not installRoot(): the payload is only one subdirectory of
  // it. The rtk binary and the download cache under bin/ and cache/ are CoMind's
  // own artifacts — CoMind put them there — so leaving them behind would strand
  // them with nothing left that knows how to remove them. rtk's GLOBAL state
  // (its hook, ~/.claude/RTK.md) is a different matter and stays print-only
  // below.
  const home = comindHome();
  const repoRoot = findRepoRoot(process.cwd());
  const { commands } = claudeDirs();
  const removed = [];
  const failures = [];

  log('');
  log(`comind ${versions.comind} — uninstall${opts.dryRun ? ' (dry run)' : ''}`);
  log('');

  if (claude) {
    // `user` and `local` only. PROJECT scope lives in the repo's committed
    // .claude/settings.json — removing it here would modify a tracked team file
    // while this same command promises "repo files stay as they are". It is
    // reported below for the developer to decide.
    for (const scope of ['user', 'local']) {
      if (opts.dryRun) {
        log(`  would run: claude plugin uninstall ${versions.distribution.plugin} --scope ${scope}`);
        continue;
      }
      const res = run(claude, ['plugin', 'uninstall', versions.distribution.plugin, '--scope', scope], {
        cwd: repoRoot,
        timeout: 120_000,
      });
      if (res.ok) {
        log(`  plugin removed (scope: ${scope})`);
        removed.push(`plugin:${scope}`);
      } else if (!/not installed|no such|not found/i.test(`${res.stdout}${res.stderr}`)) {
        // A swallowed failure reported success while the plugin was still there.
        log(`  plugin removal FAILED (scope: ${scope}): ${(res.stderr || res.stdout).slice(-200)}`);
        failures.push(`plugin:${scope}`);
      }
    }
    // Removing the plugin leaves its marketplace registered, which keeps a dead
    // source in settings.json and makes `marketplace list` misleading.
    for (const scope of ['user', 'local']) {
      if (opts.dryRun) {
        log(
          `  would run: claude plugin marketplace remove ${versions.distribution.marketplaceName} --scope ${scope}`,
        );
        continue;
      }
      const res = run(
        claude,
        ['plugin', 'marketplace', 'remove', versions.distribution.marketplaceName, '--scope', scope],
        { cwd: repoRoot, timeout: 60_000 },
      );
      if (res.ok) {
        log(`  marketplace removed (scope: ${scope})`);
        removed.push(`marketplace:${scope}`);
      } else if (!/not installed|no such|not found|unknown/i.test(`${res.stdout}${res.stderr}`)) {
        log(`  marketplace removal FAILED (scope: ${scope}): ${(res.stderr || res.stdout).slice(-200)}`);
        failures.push(`marketplace:${scope}`);
      }
    }
  } else {
    log('  claude CLI absent — skipping plugin removal');
  }

  // Fallback-install artifacts.
  for (const name of commandFiles()) {
    const f = path.join(commands, name);
    if (!existsSync(f)) continue;
    if (!opts.dryRun) rmSync(f, { force: true });
    log(`  ${opts.dryRun ? 'would remove' : 'removed'} ~/.claude/commands/${name}`);
    removed.push(name);
  }
  // BEFORE the directory goes: setup repoints rtk's global hook at the binary
  // inside `home`, so deleting it first would leave a machine-wide PreToolUse
  // hook naming a file that no longer exists — every Bash call, every repo.
  // CoMind reverts exactly the edit it made and nothing else; removing the hook
  // itself stays rtk's business, printed below.
  // Any registered rtk hook matters, not only one naming our directory: after
  // this run the binary inside `home` is gone, so a hook that resolves ONLY
  // through it is about to break whatever it says.
  const registered = registeredRtkCommands(readGlobalSettings());
  if (registered.length) {
    // Does a real rtk survive elsewhere on PATH? If so the bare name is right
    // again. If not, restoring `rtk` would just swap one unrunnable command for
    // another and leave a machine-wide hook failing on every Bash call — which
    // is what this whole block exists to prevent.
    const survives = !!which('rtk');
    const verb = survives ? 'restore' : 'remove';
    if (opts.dryRun) {
      log(`  would ${verb} the rtk hook in ~/.claude/settings.json`);
    } else {
      try {
        const res = unpinRtkHookPath();
        log(
          res.action === 'removed'
            ? '  removed the rtk hook from ~/.claude/settings.json (no rtk left on PATH to run it)'
            : '  restored the rtk hook command to `rtk` in ~/.claude/settings.json',
        );
      } catch (err) {
        log(`  FAILED to ${verb} the rtk hook: ${err.message}`);
        failures.push('rtk hook command');
      }
    }
  }

  // Only proceed to delete once the hook no longer points into it.
  if (existsSync(home) && !failures.includes('rtk hook command')) {
    if (!opts.dryRun) rmSync(home, { recursive: true, force: true });
    log(`  ${opts.dryRun ? 'would remove' : 'removed'} ${home}`);
    removed.push('home');
  }
  log('');
  log('  NOT removed — these are not CoMind\'s to delete. Run them yourself if you want:');
  log('');
  // The project-scope declaration is a committed, shared file. Surfacing the
  // command is honest; running it silently would contradict the promise below.
  if (projectDeclarationPresent(repoRoot, versions)) {
    log(`    claude plugin uninstall ${versions.distribution.plugin} --scope project`);
    log('                                                 ^ edits the COMMITTED .claude/settings.json');
  }
  log('    rtk init -g --uninstall                      RTK hook + ~/.claude/RTK.md');
  log(`    claude plugin uninstall ${versions.tools.caveman.plugin}            caveman output profile`);
  log(
    `    npx -y ${versions.tools['gsd-core'].pkg}@${versions.tools['gsd-core'].version} --uninstall  GSD Core in this repo`,
  );
  log('');
  log('  Repo files stay as they are — .planning/, .ai-memory/, .claude/hooks/,');
  log('  .claude/skills/, .claude/gsd-core/, and the managed .gitignore blocks are');
  log('  committed team artifacts. Delete them with git if you really mean to.');
  log('');
  if (!removed.length && !failures.length) log('  Nothing was installed.');
  if (failures.length) {
    log(`  INCOMPLETE — ${failures.join(', ')} could not be removed (see errors above).`);
    log('');
    return 1;
  }
  log('');
  return 0;
}

/** Is CoMind declared at project scope in the repo's committed settings? */
function projectDeclarationPresent(repoRoot, versions) {
  const file = path.join(repoRoot, '.claude', 'settings.json');
  if (!existsSync(file)) return false;
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return !!s.enabledPlugins?.[versions.distribution.plugin];
  } catch {
    return false;
  }
}

/** Update CoMind. Honest about the fallback path having no update mechanism. */
function update(versions, opts, log) {
  const claude = which('claude');
  const stamp = readInstallStamp();
  const viaPlugin = stamp?.mechanism === MECHANISM.PLUGIN;

  log('');
  log(`comind — update (installed: ${stamp?.comind ?? 'unknown'}, running: ${versions.comind})`);
  log('');

  if (viaPlugin && claude) {
    if (opts.dryRun) {
      log(`  would run: claude plugin update ${versions.distribution.plugin}`);
      return 0;
    }
    const res = run(claude, ['plugin', 'update', versions.distribution.plugin], { timeout: 300_000 });
    log(res.ok ? '  plugin updated — restart Claude Code to apply' : `  update failed: ${res.stderr.slice(-200)}`);
    log('');
    return res.ok ? 0 : 1;
  }

  // Three distinct situations used to print the same false sentence ("this
  // machine has the file-copy install"), including for teammates who got
  // CoMind from the committed project-scope declaration and never ran stage 1.
  if (viaPlugin && !claude) {
    log('  Installed as a plugin, but the claude CLI is not on PATH, so it cannot be');
    log('  updated from here. Install the CLI, or update from inside Claude Code:');
    log('');
    log(`    claude plugin update ${versions.distribution.plugin}`);
  } else if (stamp?.__corrupt) {
    log('  ~/.claude/comind/install.json is unreadable, so the install mechanism');
    log('  cannot be determined. Re-run stage 1 to rewrite it:');
    log('');
    log(`    ${FIX.stage1}`);
  } else if (!stamp) {
    log('  No stage-1 install stamp on this machine. That is normal if CoMind came');
    log("  from the repo's committed project-scope declaration — in that case the");
    log('  version follows the repo, and there is nothing to update here.');
    log('');
    log(`  To install CoMind for yourself (all repos):  ${FIX.stage1}`);
  } else {
    log('  This machine has the file-copy install, which has no update mechanism.');
    log('  Re-run stage 1 to refresh it, and to convert to a managed plugin install');
    log('  if the claude CLI is now available:');
    log('');
    log(`    ${FIX.stage1}`);
  }
  log('');
  log('  Tool versions are pinned separately in versions.json — see UPGRADING.md.');
  log('');
  return 0;
}

/**
 * Declare CoMind at PROJECT scope so the shared brain carries its own tooling.
 *
 * This writes extraKnownMarketplaces + enabledPlugins into .claude/settings.json,
 * which is committed. A teammate then clones, opens Claude Code, and /comind-init
 * is already there — no `npx` step for anyone but the first developer.
 *
 * Must run BEFORE registerGateHook: both edit .claude/settings.json, and the hook
 * registration re-reads the file, so the plugin CLI's write has to land first.
 */
function declareProjectPlugin(versions, repoRoot, opts, logFn) {
  const claude = which('claude');
  if (!claude) {
    logFn('  .claude/settings.json                    plugin declaration skipped (no claude CLI)');
    return { ok: false, reason: 'claude CLI absent' };
  }
  const override = process.env.COMIND_MARKETPLACE;
  const source = opts.local ? PKG_ROOT : override || versions.distribution.marketplace;

  // This declaration gets COMMITTED, so the source has to be resolvable on every
  // teammate's machine. A local checkout path would be recorded verbatim and then
  // fail to resolve for everyone else — worse than no declaration at all, because
  // it looks configured.
  // Resolve against repoRoot, not process.cwd(): `marketplace add` runs with
  // cwd=repoRoot, so a repo-relative path that does not exist from the current
  // directory would pass this guard and still resolve locally when added.
  if (path.isAbsolute(source) || existsSync(source) || existsSync(path.resolve(repoRoot, source))) {
    logFn(`  .claude/settings.json                    plugin declaration skipped (source "${source}"`);
    logFn('                                           is a local path — not portable to teammates)');
    return { ok: false, reason: 'non-portable marketplace source' };
  }

  // An env var flowing unvalidated into a COMMITTED plugin source is a supply
  // chain redirection for everyone who later clones. Only the two shapes the
  // plugin CLI actually accepts are allowed through.
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(source) && !/^https:\/\/[^\s]+$/.test(source)) {
    logFn(`  .claude/settings.json                    plugin declaration skipped — marketplace source`);
    logFn(`                                           "${source}" is not owner/repo or an https URL`);
    return { ok: false, reason: 'invalid marketplace source' };
  }
  if (override) {
    // Never bake in a source silently: the user must see what was recorded.
    logFn(`  .claude/settings.json                    marketplace source from COMIND_MARKETPLACE: ${source}`);
  }

  const settingsFile = path.join(repoRoot, '.claude', 'settings.json');
  if (existsSync(settingsFile)) {
    try {
      const s = JSON.parse(readFileSync(settingsFile, 'utf8'));
      if (s.enabledPlugins?.[versions.distribution.plugin]) {
        logFn('  .claude/settings.json                    plugin declaration up-to-date');
        return { ok: true, already: true };
      }
    } catch {
      /* fall through and let the CLI try */
    }
  }
  if (opts.dryRun) {
    logFn('  .claude/settings.json                    would declare plugin at project scope');
    return { ok: true, dryRun: true };
  }

  const added = run(claude, ['plugin', 'marketplace', 'add', source, '--scope', 'project'], {
    cwd: repoRoot,
    timeout: 180_000,
  });
  if (!added.ok && !/already|exists/i.test(`${added.stdout}${added.stderr}`)) {
    logFn(`  .claude/settings.json                    marketplace add failed: ${(added.stderr || added.stdout).slice(-120)}`);
    return { ok: false, reason: 'marketplace add failed' };
  }
  const inst = run(claude, ['plugin', 'install', versions.distribution.plugin, '--scope', 'project'], {
    cwd: repoRoot,
    timeout: 300_000,
  });
  if (!inst.ok && !/already/i.test(`${inst.stdout}${inst.stderr}`)) {
    logFn(`  .claude/settings.json                    plugin install failed: ${(inst.stderr || inst.stdout).slice(-120)}`);
    return { ok: false, reason: 'plugin install failed' };
  }
  // Name the source that was baked in — this is what every teammate will fetch.
  logFn(`  .claude/settings.json                    plugin declared at project scope from ${source} (commit it)`);
  return { ok: true, source };
}

function checkPrereqs() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  return [
    {
      name: 'node>=18',
      ok: nodeMajor >= 18,
      required: true,
      fix: `found node ${process.versions.node}; install Node 18 or newer`,
    },
    { name: 'git', ok: !!which('git'), required: true, fix: 'install git' },
    {
      name: 'python3',
      ok: !!(which('python3') || which('python') || which('uv')),
      required: false,
      fix: 'needed for graphify — install Python 3 or uv',
    },
    {
      name: 'claude',
      ok: !!which('claude'),
      required: false,
      fix: 'needed to install the caveman and LSP plugins — https://claude.com/claude-code',
    },
    {
      name: 'tar',
      ok: !!which('tar'),
      required: false,
      fix: 'used to extract the rtk archive (Windows 10 1803+ ships tar.exe); a pure-JS fallback covers .tar.gz',
    },
  ];
}

/**
 * `comind lsp` — status with no arguments, install/remove with them.
 *
 * The QUESTION lives in /comind-lsp, which runs inside a Claude Code session and
 * can actually ask. This stays non-interactive on purpose: JOIN, CI, and the
 * test harness all invoke it, and a prompt here would hang all three.
 */
function cmdLsp(repoRoot, versions, opts) {
  const wanted = opts.lspLangs ?? opts.args;
  const status = lspStatus(repoRoot, versions);

  // No arguments: report and stop. /comind-lsp renders this and asks.
  if (!wanted.length) {
    if (opts.json) {
      log(JSON.stringify({ languages: status }, null, 2));
      return 0;
    }
    log('');
    log(`comind lsp — ${repoRoot}`);
    log('');
    const w = Math.max(...status.map((r) => r.lang.length));
    for (const r of status) {
      // The server binary is only reported for languages that are actually in
      // play. Printing `gopls MISSING` in a Python repo is alarming noise about
      // a tool nobody here needs.
      const relevant = r.detected || r.installed;
      const marks = [
        r.detected ? 'in repo' : '       ',
        r.installed === null ? 'plugin ?' : r.installed ? 'plugin ✓' : 'plugin ·',
        !relevant || r.serverPresent === null ? '' : r.serverPresent ? `${r.serverBin} ✓` : `${r.serverBin} MISSING`,
      ];
      log(`  ${r.lang.padEnd(w)}  ${marks.join('  ')}`.trimEnd());
    }
    const suggest = status.filter((r) => r.detected && r.installed === false).map((r) => r.lang);
    log('');
    if (suggest.length) log(`  install:  comind lsp ${suggest.join(' ')}`);
    else log('  every detected language already has its plugin.');
    for (const r of status) {
      if (r.installed && r.serverPresent === false) {
        log(`  ${r.plugin} is installed but ${r.serverBin} is not on PATH — ${r.manual}`);
      }
    }
    log('');
    return 0;
  }

  const known = new Set(lspLanguages(versions));
  const bad = wanted.filter((l) => !known.has(l));
  if (bad.length) {
    log(`comind: unknown language(s): ${bad.join(', ')}`);
    log(`  known: ${[...known].join(', ')}`);
    return 1;
  }

  const results = applyLspPlugins(wanted, versions, { remove: opts.remove, dryRun: opts.dryRun, log });
  for (const r of results) {
    log(`  ${r.lang.padEnd(12)} ${r.status}${r.reason ? ` — ${r.reason}` : ''}`);
    if (r.serverMissing) {
      log(`      ${r.serverMissing} is not on PATH — the plugin produces no diagnostics until it is:`);
      log(`      ${r.manual}`);
    }
    if (r.manual && !r.serverMissing && r.status !== 'installed') log(`      run by hand: ${r.manual}`);
  }
  if (!opts.remove && !opts.dryRun) log('  run /reload-plugins inside Claude Code to activate');
  return results.some((r) => r.status === 'failed') ? 1 : 0;
}

/**
 * The LSP plugin layer during `setup`.
 *
 * Only detected languages, because every installed plugin costs always-on
 * context in every session — installing twelve into a Python repo is the exact
 * waste CoMind exists to prevent. `--lsp=` overrides detection.
 */
function setupLspPlugins(ctx, opts) {
  const { repoRoot, versions, log: logFn, dryRun } = ctx;
  const langs = opts.lspLangs ?? detectLspLanguages(repoRoot, versions).map((d) => d.lang);
  if (!langs.length) {
    return { name: 'lsp-plugins', status: 'skipped', reason: 'no supported language detected in this repo' };
  }
  const results = applyLspPlugins(langs, versions, { dryRun, log: logFn });
  const failed = results.filter((r) => r.status === 'failed');
  const missing = results.filter((r) => r.serverMissing);
  for (const r of missing) {
    logFn?.(`  ${r.plugin}: ${r.serverMissing} not on PATH — ${r.manual}`);
  }
  if (failed.length) {
    return {
      name: 'lsp-plugins',
      status: 'failed',
      reason: failed.map((r) => `${r.plugin}: ${r.reason}`).join('; '),
      manual: `comind lsp ${failed.map((r) => r.lang).join(' ')}`,
    };
  }
  return {
    name: 'lsp-plugins',
    status: 'ok',
    version: langs.join(', '),
    note: missing.length ? `${missing.length} server binary/binaries missing — see above` : undefined,
  };
}

/**
 * Probe what is actually installed, for the drift report.
 *
 * Anything CoMind deliberately did not attempt — an LSP layer under `--no-lsp`,
 * or a language this repo doesn't use — reports the pinned value rather than
 * `null`. Reporting "drift" for a layer we chose to skip is noise that trains
 * developers to ignore the drift block.
 */
function probeInstalled(repoRoot, versions, languages, { noLsp = false } = {}) {
  const { bin } = comindPaths(repoRoot);
  const pinned = (name) => versions.tools[name].version;
  const out = {};

  out.rtk = probeVersionAt(which('rtk', [bin]));
  out.graphifyy = probeVersion(versions.tools.graphifyy.binName, ['--version']);

  // The ACTUAL plugin version, never the pin echoed back: plugins cannot be
  // version-pinned at install time, so presence says nothing about the version.
  out.caveman = claudePluginVersion(versions.tools.caveman.plugin);

  // The version stamp, not the presence of .planning/ — gsd-core is installed
  // well before /gsd-onboard creates .planning/.
  out['gsd-core'] = readGsdVersion(repoRoot);

  const skipTs = noLsp || !languages.typescript;
  const skipPy = noLsp || !languages.python;
  out.typescript = skipTs ? pinned('typescript') : probeVersion('tsc', ['--version']);
  out['typescript-language-server'] = skipTs
    ? pinned('typescript-language-server')
    : probeVersion('typescript-language-server', ['--version']);
  out.pyright = skipPy
    ? pinned('pyright')
    : probeVersion('pyright-langserver', ['--version']) || probeVersion('pyright', ['--version']);
  return out;
}

/**
 * Copy the gate hook and team skill into the repo so they are committed and
 * every teammate gets them from Git rather than from a plugin install.
 * Writing only on change keeps a second run a true no-op.
 */
function installPluginAssets(repoRoot, dryRun, logFn) {
  // Sourced from templates/team/, not from a top-level skills//hooks/ — those
  // directory names are auto-discovered by the plugin loader and would register
  // the contract at user scope. See PAYLOAD in lib/install-plugin.mjs.
  const jobs = [
    ['templates/team/hooks/comind-gate.mjs', '.claude/hooks/comind-gate.mjs'],
    ['templates/team/skills/caveman-gsd/SKILL.md', '.claude/skills/caveman-gsd/SKILL.md'],
  ];
  for (const [from, to] of jobs) {
    const src = path.join(PKG_ROOT, from);
    if (!existsSync(src)) continue;
    const dest = path.join(repoRoot, to);
    const content = readFileSync(src, 'utf8');
    const prev = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
    if (prev === content) {
      logFn(`  ${to.padEnd(40)} up-to-date`);
      continue;
    }
    if (!dryRun) {
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, content, 'utf8');
    }
    logFn(`  ${to.padEnd(40)} ${dryRun ? (prev ? 'would update' : 'would write') : prev ? 'updated' : 'written'}`);
  }
  registerGateHook(repoRoot, dryRun, logFn);
}

/**
 * Paths CoMind derives and the team contract says to query rather than read.
 *
 * `permissions.deny` is the only mechanism Claude Code actually honours for
 * this. The retired `.claudeignore` block listed roughly the same paths and was
 * read by nothing, so the rule it described was never once enforced.
 *
 * Deliberately narrow. It covers what CoMind itself generates — not node_modules,
 * lockfiles, or build trees. Those are generic hygiene, they were only ever
 * advisory in the old block, and `deny` BLOCKS rather than de-prioritises: a repo
 * where Claude cannot read a lockfile to answer a dependency question is worse
 * than one that reads it occasionally.
 */
const DENY_RULES = [
  'Read(./graphify-out/**)',
  'Read(./.planning/graphs/**)',
  'Read(./.comind/state/**)',
  'Read(./.ai-memory/.obsidian/**)',
];

/** Prefixes that identify a deny entry as ours, so the set converges on re-run. */
const DENY_OWNED = /^Read\(\.\/(graphify-out\/|\.planning\/graphs\/|\.comind\/state\/|\.ai-memory\/\.obsidian\/)/;

/**
 * Merge CoMind's deny rules into settings.permissions.deny.
 *
 * Entries we own are recomputed from DENY_RULES; everything else the team wrote
 * is preserved untouched. Mutates `settings` and returns nothing — the caller
 * owns the single read/write cycle, because two functions writing this file
 * independently is how the plugin declaration and the gate hook once clobbered
 * each other.
 */
function mergeDenyRules(settings, logFn) {
  if (settings.permissions == null) settings.permissions = {};
  if (typeof settings.permissions !== 'object' || Array.isArray(settings.permissions)) {
    logFn('  .claude/settings.json has a non-object `permissions` — skipping deny rules');
    return;
  }
  if (settings.permissions.deny != null && !Array.isArray(settings.permissions.deny)) {
    logFn('  .claude/settings.json has a non-array permissions.deny — skipping deny rules');
    return;
  }
  const existing = settings.permissions.deny || [];
  const theirs = existing.filter((r) => typeof r !== 'string' || !DENY_OWNED.test(r));
  settings.permissions.deny = [...theirs, ...DENY_RULES];
}

/**
 * Register CoMind's gate as its own PreToolUse entry matching Edit/Write only.
 * RTK's Bash entry is left untouched — the two matchers are disjoint by design.
 *
 * Also owns permissions.deny, in the same read/write cycle.
 */
function registerGateHook(repoRoot, dryRun, logFn) {
  const file = path.join(repoRoot, '.claude', 'settings.json');
  let settings = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      logFn('  .claude/settings.json is invalid JSON — skipping gate registration');
      return;
    }
  }

  // Every shape has to be checked, not just PreToolUse: a settings file that is
  // a number, or whose `hooks` is a string, threw an unhandled TypeError out of
  // here AFTER the ignore blocks and plugin assets were already written.
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    logFn('  .claude/settings.json is not a JSON object — skipping gate registration');
    return;
  }
  if (settings.hooks == null) settings.hooks = {};
  if (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    logFn('  .claude/settings.json has a non-object `hooks` — skipping gate registration');
    return;
  }
  if (settings.hooks.PreToolUse != null && !Array.isArray(settings.hooks.PreToolUse)) {
    logFn('  .claude/settings.json has a non-array hooks.PreToolUse — skipping gate registration');
    return;
  }
  const pre = (settings.hooks.PreToolUse = settings.hooks.PreToolUse || []);

  // Bash is included so a shell write into .ai-memory/ is caught too; the gate
  // only ever allows or denies, so it never collides with RTK's rewrite hook.
  const MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash';
  // ${CLAUDE_PROJECT_DIR} (braces) is the documented placeholder Claude Code
  // substitutes itself. The bare $VAR form only expands under a POSIX shell,
  // so on native Windows the path never resolved and the gate silently never
  // ran — including rule 1.
  const COMMAND = 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/comind-gate.mjs"';

  const existingIdx = pre.findIndex((h) => JSON.stringify(h).includes('comind-gate'));
  const entry = {
    matcher: MATCHER,
    hooks: [{ type: 'command', command: COMMAND, timeout: 10 }],
  };

  const before = JSON.stringify(settings);
  if (existingIdx === -1) pre.push(entry);
  else pre[existingIdx] = entry;
  mergeDenyRules(settings, logFn);

  const next = `${JSON.stringify(settings, null, 2)}\n`;
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (next === prev || JSON.stringify(settings) === before) {
    logFn('  .claude/settings.json                    gate hook + deny rules up-to-date');
    return;
  }
  if (!dryRun) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, next, 'utf8');
  }
  const verb = existingIdx === -1 ? 'registered' : 'updated';
  logFn(`  .claude/settings.json                    gate hook ${dryRun ? `would be ${verb}` : verb}`);
  logFn(`  .claude/settings.json                    ${DENY_RULES.length} deny rules ${dryRun ? 'would be applied' : 'applied'}`);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`comind: ${err?.stack || err}\n`);
    process.exit(1);
  });
