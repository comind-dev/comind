// /comind-doctor — verify each layer independently and report measured savings.
//
// Every check is read-only and independent: one broken layer still reports on
// the other four. Versions are compared against versions.json, never assumed.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  comindPaths,
  probeVersion,
  probeVersionAt,
  run,
  versionsMatch,
  satisfies,
  which,
  homeDir,
  FIX,
  PLATFORM_KEY,
} from './platform.mjs';
import {
  rtkHookInstalled,
  readGsdVersion,
  readGlobalSettings,
  registeredRtkCommand,
  registeredRtkCommands,
  rtkCommandResolves,
  isRtkHookCommand,
} from './install-tools.mjs';
import { lspStatus } from './lsp.mjs';
import { readManifest, detectLanguages } from './detect.mjs';
import {
  readInstallStamp,
  pluginRegistryEntry,
  claudePluginVersion,
  commandFiles,
  MECHANISM,
} from './install-plugin.mjs';

const PASS = 'pass';
const WARN = 'warn';
const FAILED = 'fail';

function check(name, status, detail, fix) {
  return { name, status, detail, fix };
}

export function runDoctor(repoRoot, versions, { metrics = false } = {}) {
  const { bin, state } = comindPaths(repoRoot);
  const languages = detectLanguages(repoRoot);
  const checks = [];
  const installed = {};

  // --- Stage 1: is CoMind itself installed, current, and managed? ---
  const stamp = readInstallStamp();
  const registry = pluginRegistryEntry(versions);
  const managed = stamp?.mechanism === MECHANISM.PLUGIN || !!registry;

  if (!stamp && !registry) {
    checks.push(
      check(
        'comind installed (stage 1)',
        WARN,
        'no install found — slash commands may be stale or absent',
        FIX.stage1,
      ),
    );
  } else if (stamp?.__corrupt) {
    checks.push(check('comind installed (stage 1)', WARN, 'install.json unreadable', FIX.stage1));
  } else if (stamp && !versionsMatch(stamp.comind, versions.comind)) {
    checks.push(
      check(
        'comind installed (stage 1)',
        WARN,
        `installed ${stamp.comind}, running ${versions.comind}`,
        managed ? 'comind update' : FIX.stage1,
      ),
    );
  } else {
    checks.push(
      check(
        'comind installed (stage 1)',
        PASS,
        `${stamp?.comind ?? versions.comind} via ${managed ? 'plugin' : 'file-copy'}${
          registry?.version ? ` (${registry.version})` : ''
        }`,
      ),
    );
  }

  // The file-copy fallback has no update or uninstall path. That asymmetry must be
  // visible rather than silently accepted — it is the whole reason the plugin
  // system is the primary mechanism.
  checks.push(
    managed
      ? check('comind lifecycle', PASS, 'plugin-managed — update/uninstall/disable available')
      : check(
          'comind lifecycle',
          WARN,
          'file-copy install — no update or uninstall via claude plugin',
          which('claude')
            ? `${FIX.stage1}    (the claude CLI is available now; this converts to a managed install)`
            : `install the claude CLI, then re-run: ${FIX.stage1}`,
        ),
  );

  // The team contract is project-scoped by design. A user-scope copy would apply
  // this repo's phase discipline to every repo on the machine, including ones with
  // no .planning/ — so its presence is a defect however it got there.
  const leakedSkill = path.join(homeDir(), '.claude', 'skills', 'caveman-gsd');
  checks.push(
    existsSync(leakedSkill)
      ? check(
          'skill scope',
          FAILED,
          'caveman-gsd is installed user-scope — it applies to unrelated repos',
          'remove ~/.claude/skills/caveman-gsd — the contract belongs in the repo',
        )
      : check('skill scope', PASS, 'project-scoped only'),
  );

  // Duplicate command registration: when the plugin is managing the commands, a
  // file-copy leftover registers each of them a second time.
  const copiedCommands = commandFiles().filter((n) =>
    existsSync(path.join(homeDir(), '.claude', 'commands', n)),
  );
  checks.push(
    managed && copiedCommands.length
      ? check(
          'command registration',
          FAILED,
          `${copiedCommands.length} file-copy command(s) shadow the plugin's: ${copiedCommands.join(', ')}`,
          `${FIX.stage1}    (clears the file-copy artifacts)`,
        )
      : check(
          'command registration',
          PASS,
          managed ? 'served by the plugin only' : `file-copy (${copiedCommands.length} command(s))`,
        ),
  );

  // --- RTK ---
  // `bin` is ~/.claude/comind/bin, outside every repo, so doctor executing what
  // it resolves here cannot run something a clone planted. That is why there is
  // no trust check on this path — the location removes the risk instead.
  const rtk = which('rtk', [bin]);
  const rtkVer = probeVersionAt(rtk);
  installed.rtk = rtkVer;
  checks.push(
    rtkVer
      ? satisfies(rtkVer, versions.tools.rtk)
        ? check('rtk binary', PASS, rtkVer)
        : check('rtk binary', WARN, `${rtkVer} (pinned ${versions.tools.rtk.version})`, FIX.setup)
      : check('rtk binary', FAILED, 'not found', FIX.setup),
  );

  if (rtk) {
    // Ask what CLAUDE CODE will run, not what rtk believes it wrote.
    //
    // `rtk init --show` answers "is a hook registered", which stays [ok] while
    // the command it registered resolves to nothing — and `which('rtk', [bin])`
    // above finds the binary in CoMind's private directory, which is not on the
    // user's PATH. Both checks therefore passed on machines where the hook had
    // never once executed. Resolving the registered command WITHOUT extraPaths
    // is the only question whose answer differs from the installer's.
    // EVERY registered entry, not just the first: a healthy one sitting above a
    // broken one would otherwise report PASS while Claude Code ran both.
    const registered = registeredRtkCommands(readGlobalSettings());
    const broken = registered.filter((c) => !rtkCommandResolves(c));
    checks.push(
      !registered.length
        ? check(
            'rtk rewrite hook',
            FAILED,
            rtkHookInstalled(rtk, repoRoot).line || 'not registered',
            'rtk init -g --auto-patch    (-g is required; without it no hook is installed)',
          )
        : broken.length
          ? check(
              'rtk rewrite hook',
              FAILED,
              `registered as \`${broken[0]}\`, which is not on PATH — every Bash call exits 127`,
              FIX.setup,
            )
          : check(
              'rtk rewrite hook',
              PASS,
              registered.length > 1
                ? `registered globally (${registered.length} entries — rtk runs once per Bash call for each)`
                : 'registered globally (machine-local layer)',
            ),
    );
  } else {
    checks.push(check('rtk rewrite hook', FAILED, 'rtk unavailable', FIX.setup));
  }

  // --- Caveman ---
  const claude = which('claude');
  if (claude) {
    // The ACTUAL version, not the pin echoed on presence: plugin installs
    // cannot be version-pinned, so presence proves nothing about the version.
    const spec = versions.tools.caveman;
    const actual = claudePluginVersion(spec.plugin, claude);
    if (actual === null) {
      checks.push(
        check(
          'caveman plugin',
          FAILED,
          'not installed',
          `claude plugin marketplace add ${spec.marketplace} && claude plugin install ${spec.plugin}`,
        ),
      );
    } else if (actual !== 'unknown' && String(actual).replace(/^v/, '') === String(spec.version).replace(/^v/, '')) {
      checks.push(check('caveman plugin', PASS, `installed (${actual})`));
    } else {
      checks.push(
        check(
          'caveman plugin',
          WARN,
          `installed (${actual}), pin is ${spec.version} — plugins cannot be version-pinned at install time`,
        ),
      );
    }
    installed.caveman = actual;
  } else {
    checks.push(check('caveman plugin', WARN, 'claude CLI not on PATH — cannot verify'));
  }

  // --- GSD Core ---
  // Two independent facts: is gsd-core installed, and has this repo been
  // onboarded. Conflating them reports a FAIL on a perfectly good install.
  const planning = path.join(repoRoot, '.planning');
  const gsdVer = readGsdVersion(repoRoot);
  installed['gsd-core'] = gsdVer;
  checks.push(
    !gsdVer
      ? check('gsd-core installed', FAILED, 'no version stamp found', FIX.setup)
      : satisfies(gsdVer, versions.tools['gsd-core'])
        ? check('gsd-core installed', PASS, gsdVer)
        : check(
            'gsd-core installed',
            WARN,
            `${gsdVer} (pinned ${versions.tools['gsd-core'].version})`,
            FIX.setup,
          ),
  );
  checks.push(
    existsSync(planning)
      ? check('repo onboarded', PASS, '.planning/ present')
      : check('repo onboarded', WARN, '.planning/ absent — no shared specs yet', '/gsd-onboard'),
  );

  // Must match the gate's rule EXACTLY, or doctor reports PASS while the gate
  // still blocks — a bare directory does not satisfy the gate, so counting dirents
  // would be wrong. The gate is standalone (copied into consuming repos, so it
  // cannot import from lib/); the duplication is deliberate and a test asserts the
  // two agree.
  const phases = countActivePhases(planning);
  checks.push(
    phases.length > 0
      ? check('active phases', PASS, `${phases.length} phase(s) with a spec: ${phases.join(', ')}`)
      : check('active phases', WARN, 'none — bulk edits will be gated', '/gsd-workflow discuss'),
  );

  // --- graphify ---
  const gVer = probeVersion(versions.tools.graphifyy.binName, ['--version']);
  installed.graphifyy = gVer;
  checks.push(
    gVer
      ? satisfies(gVer, versions.tools.graphifyy)
        ? check('graphify', PASS, gVer)
        : check('graphify', WARN, `${gVer} (pinned ${versions.tools.graphifyy.version})`, FIX.setup)
      : check('graphify', FAILED, 'not found', FIX.setup),
  );

  const cfgPath = path.join(planning, 'config.json');
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      checks.push(
        cfg?.graphify?.enabled === true
          ? check('graphify enabled in GSD', PASS, 'graphify.enabled = true')
          : check('graphify enabled in GSD', FAILED, 'disabled', FIX.setup),
      );
    } catch {
      checks.push(check('graphify enabled in GSD', FAILED, 'config.json unparseable'));
    }
  } else {
    checks.push(check('graphify enabled in GSD', WARN, 'no .planning/config.json yet', '/gsd-onboard'));
  }

  const graphReport = [
    path.join(planning, 'graphs', 'GRAPH_REPORT.md'),
    path.join(repoRoot, 'graphify-out', 'GRAPH_REPORT.md'),
  ].find((p) => existsSync(p));
  checks.push(
    graphReport
      ? check('knowledge graph built', PASS, path.relative(repoRoot, graphReport))
      : check('knowledge graph built', WARN, 'no graph yet', FIX.sync),
  );

  // --- LSP: plugin present, and the server binary it wraps ---
  //
  // Two independent facts. A plugin wraps a server binary but never ships one,
  // so "installed" alone would report a working layer that silently produces no
  // diagnostics. CoMind installs no language toolchain, so a missing binary is
  // reported with the one line that fixes it, never fixed here.
  for (const row of lspStatus(repoRoot, versions)) {
    if (!row.detected && !row.installed) continue;
    const label = `lsp:${row.lang}`;
    if (row.installed === null) {
      checks.push(check(label, WARN, 'claude CLI absent — plugin state unknown', FIX.setup));
    } else if (!row.installed) {
      checks.push(check(label, WARN, `${row.plugin} not installed`, `comind lsp ${row.lang}`));
    } else if (row.serverPresent === false) {
      checks.push(check(label, WARN, `${row.plugin} installed, ${row.serverBin} not on PATH`, row.manual));
    } else {
      checks.push(check(label, PASS, `${row.plugin} + ${row.serverBin}`));
    }
  }

  for (const [key, langKey] of [
    ['typescript-language-server', 'typescript'],
    ['pyright', 'python'],
  ]) {
    if (!languages[langKey]) continue;
    const spec = versions.tools[key];
    const v = probeVersion(spec.binName, ['--version']) ||
      (spec.binName === 'pyright-langserver' ? probeVersion('pyright', ['--version']) : null);
    installed[key] = v;
    checks.push(
      v
        ? satisfies(v, spec)
          ? check(key, PASS, v)
          : check(key, WARN, `${v} (pinned ${spec.version})`, FIX.setup)
        : check(key, FAILED, 'not found', `npm i -g ${spec.pkg}@${spec.version}`),
    );
  }
  if (languages.typescript) installed.typescript = probeVersion('tsc', ['--version']);

  // --- hooks: assert RTK and CoMind do not collide ---
  checks.push(checkHookLayout(repoRoot));

  // --- manifest drift ---
  const manifest = readManifest(repoRoot);
  const driftRows = [];
  if (manifest && !manifest.__corrupt) {
    for (const [tool, want] of Object.entries(manifest.tools || {})) {
      const pinnedNow = versions.tools[tool]?.version;
      if (pinnedNow && !versionsMatch(want, pinnedNow)) {
        driftRows.push({ tool, manifest: want, package: pinnedNow });
      }
    }
    checks.push(
      driftRows.length
        ? check(
            'manifest vs package pins',
            WARN,
            driftRows.map((d) => `${d.tool}: repo ${d.manifest} vs comind ${d.package}`).join('; '),
            'align versions.json with the committed manifest, or bump both',
          )
        : check('manifest vs package pins', PASS, `comind ${manifest.comind}`),
    );
  } else {
    checks.push(check('manifest vs package pins', WARN, 'no committed manifest yet'));
  }

  const result = { platform: PLATFORM_KEY, checks, installed, languages };
  if (metrics) result.metrics = collectMetrics(repoRoot, bin, state);
  return result;
}

/**
 * Phase directories that actually contain a spec document.
 *
 * Mirrors `activePhases()` in templates/team/hooks/comind-gate.mjs. Keep the two
 * identical: a directory alone does not satisfy the gate, so counting bare dirents
 * here would tell a developer they are fine while every bulk edit is still
 * refused.
 */
/**
 * The shared-spec rule, in one place on this side of the boundary.
 *
 * Must stay byte-equivalent to the gate's `isSharedSpec` and the vault's
 * `isSharedDoc`. The gate is standalone — it is copied into consuming repos and
 * cannot import from lib/ — so the duplication is structural, and the test that
 * asserts all three agree is what keeps it honest.
 */
export function isSharedSpec(name) {
  const lower = String(name).toLowerCase();
  return lower.endsWith('.md') && !lower.endsWith('.local.md');
}

export function countActivePhases(planningDir) {
  const dir = path.join(planningDir, 'phases');
  if (!existsSync(dir)) return [];
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      if (!statSync(p).isDirectory()) continue;
      // `.local.md` is gitignored scratch, so it is not a SHARED spec. The gate
      // exists to require work be visible to the rest of the team; a file no
      // teammate will ever receive cannot satisfy it. Kept identical to the
      // gate's rule and to the vault's — see the test that pins all three.
      if (readdirSync(p).some((f) => isSharedSpec(f))) out.push(name);
    } catch {
      // Unreadable entry — skip, exactly as the gate does.
    }
  }
  return out;
}

/**
 * Report the merged PreToolUse layout across all three files that carry hooks,
 * so a human can see what actually runs on an Edit.
 *
 * Overlapping matchers are NOT flagged as a problem: Claude Code runs every
 * matching hook, and gsd-core deliberately registers `Bash|Edit|Write|MultiEdit`
 * for its own workflow guard. The thing worth checking is that CoMind's gate is
 * present and that RTK's Bash hook exists somewhere.
 */
function checkHookLayout(repoRoot) {
  const sources = [
    ['.claude/settings.json', path.join(repoRoot, '.claude', 'settings.json')],
    ['.claude/settings.local.json', path.join(repoRoot, '.claude', 'settings.local.json')],
    ['~/.claude/settings.json', path.join(homeDir(), '.claude', 'settings.json')],
  ];

  const entries = [];
  let bad = null;
  for (const [label, file] of sources) {
    if (!existsSync(file)) continue;
    try {
      const json = JSON.parse(readFileSync(file, 'utf8'));
      for (const h of json.hooks?.PreToolUse || []) {
        entries.push({ label, matcher: h.matcher || '(all)', body: JSON.stringify(h) });
      }
    } catch {
      bad = label;
    }
  }
  if (bad) return check('hook layout', FAILED, `${bad} is invalid JSON`);
  if (!entries.length) return check('hook layout', WARN, 'no PreToolUse hooks found anywhere');

  const hasGate = entries.some((e) => /comind-gate/.test(e.body));
  // Same predicate the installer and the repair path use, so a quoted absolute
  // path still counts as rtk's hook. A literal /rtk hook/ stopped matching the
  // moment the command was absolutized.
  const hasRtk = entries.some((e) => isRtkHookCommand(e.body) || /["']?\s*hook claude/.test(e.body));
  const summary = `${entries.length} PreToolUse hook(s) — gate: ${hasGate ? 'yes' : 'NO'}, rtk: ${
    hasRtk ? 'yes' : 'NO'
  } · ${entries.map((e) => `${e.matcher}@${e.label.replace('.claude/', '')}`).join(' | ')}`;

  if (!hasGate) {
    return check('hook layout', FAILED, summary, 'comind setup --force   (re-registers the gate)');
  }
  if (!hasRtk) {
    return check('hook layout', WARN, summary, 'rtk init -g --auto-patch');
  }
  return check('hook layout', PASS, summary);
}

/**
 * Measured savings only. RTK reports real numbers; anything we cannot measure is
 * reported as unmeasured rather than estimated.
 */
function collectMetrics(repoRoot, bin, stateDir) {
  const out = { rtk: null, gate: null, unmeasured: [] };

  const rtk = which('rtk', [bin]);
  if (rtk) {
    const res = run(rtk, ['gain', '--format', 'json'], { cwd: repoRoot, timeout: 60_000 });
    if (res.ok && res.stdout) {
      try {
        out.rtk = JSON.parse(res.stdout);
      } catch {
        out.rtk = { raw: res.stdout.slice(0, 2000) };
      }
    } else {
      out.unmeasured.push('rtk gain returned no data (run some commands first)');
    }
  } else {
    out.unmeasured.push('rtk not installed');
  }

  const bypass = path.join(stateDir, 'bypass.log');
  out.gate = {
    bypasses: existsSync(bypass) ? readFileSync(bypass, 'utf8').split(/\r?\n/).filter(Boolean).length : 0,
  };

  out.unmeasured.push('caveman output savings: measured by its own benchmark, not by comind');
  out.unmeasured.push('graph-vs-grep input savings: depends on query mix; not instrumented');
  return out;
}

export function renderDoctor(result) {
  const L = [];
  const order = { fail: 0, warn: 1, pass: 2 };
  L.push('');
  L.push(`COMIND DOCTOR — ${result.platform}`);
  L.push('-'.repeat(72));
  for (const c of [...result.checks].sort((a, b) => order[a.status] - order[b.status])) {
    const tag = c.status === PASS ? 'PASS' : c.status === WARN ? 'WARN' : 'FAIL';
    L.push(`  [${tag}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    if (c.fix && c.status !== PASS) L.push(`         fix: ${c.fix}`);
  }
  const fails = result.checks.filter((c) => c.status === FAILED).length;
  const warns = result.checks.filter((c) => c.status === WARN).length;
  L.push('-'.repeat(72));
  L.push(`  ${result.checks.length - fails - warns} pass · ${warns} warn · ${fails} fail`);

  if (result.metrics) {
    L.push('');
    L.push('MEASURED SAVINGS');
    if (result.metrics.rtk) {
      L.push(`  rtk: ${JSON.stringify(result.metrics.rtk).slice(0, 600)}`);
    }
    L.push(`  gate bypasses logged: ${result.metrics.gate.bypasses}`);
    for (const u of result.metrics.unmeasured) L.push(`  unmeasured: ${u}`);
  }
  L.push('');
  return L.join('\n');
}
