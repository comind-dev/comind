#!/usr/bin/env node
// CoMind gate — PreToolUse on Edit|Write|MultiEdit|NotebookEdit|Bash.
//
// GATING ONLY. RTK owns command REWRITING via its own native Bash hook; this
// hook never rewrites a command, it only allows or denies.
//
// Three rules, cheapest first:
//   1. .ai-memory/ is derived — refuse writes.
//      Absolute for the editing tools. For Bash it is a heuristic: a write verb
//      or redirection aimed at .ai-memory/ is denied, reads pass, and anything
//      ambiguous is allowed (see bashWritesVault).
//   2. Bulk editing requires an active spec in .planning/phases/. Writes INTO
//      .planning/ are exempt — that is the remediation this rule demands.
//   3. COMIND_GATE=off bypasses rule 2 only, and logs the bypass.
//
// Node, not shell, so it runs unchanged on cmd, PowerShell, and any Unix shell.
// Fails OPEN on any internal error: a broken gate must never brick a session.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  appendFileSync,
  statSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DEFAULT_THRESHOLD = 5;
const IS_WINDOWS = process.platform === 'win32';
const CASE_INSENSITIVE = IS_WINDOWS || process.platform === 'darwin';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    // Never hang the session waiting on stdin.
    setTimeout(() => resolve(data), 4000);
  });
}

function deny(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function allow() {
  process.exit(0);
}

/**
 * Normalize for comparison; case-fold only where the filesystem does.
 *
 * Backslashes are folded to `/` on every platform, not just Windows. An agent
 * may emit a Windows-style path while the hook runs on POSIX, where `\` is a
 * legal filename character and would otherwise slip past the guard. A file
 * genuinely named `a\b.md` on Linux is vanishingly rare, and erring toward
 * denying a write into the derived vault is the safe direction.
 */
function canon(p, root) {
  if (!p) return '';
  let unified = String(p).replace(/\\/g, '/');
  // A drive-relative absolute path (`/repo/file` written as `\repo\file` on
  // Windows) has no drive letter, so it could never match the drive-lettered
  // vault root — and rule 1 was bypassable by writing the path that way.
  // Anchor it to the cwd's drive, which is what Windows itself resolves it to.
  if (IS_WINDOWS && /^\/(?![/])/.test(unified)) {
    const drive = path.resolve(root).slice(0, 2);
    if (/^[A-Za-z]:$/.test(drive)) unified = `${drive}${unified}`;
  }
  const abs = path.posix.isAbsolute(unified) || path.isAbsolute(unified)
    ? unified
    : path.resolve(root, unified).replace(/\\/g, '/');
  const n = path.posix.normalize(abs);
  return CASE_INSENSITIVE ? n.toLowerCase() : n;
}

function isInside(child, parentAbs, root) {
  const c = canon(child, root);
  const p = canon(parentAbs, root);
  return c === p || c.startsWith(`${p}/`);
}

/** Every file path a single tool call would touch. */
function targetPaths(input) {
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) out.push(v);
  };
  push(input?.file_path);
  push(input?.notebook_path);
  push(input?.path);
  if (Array.isArray(input?.edits)) for (const e of input.edits) push(e?.file_path);
  if (Array.isArray(input?.files)) for (const f of input.files) push(typeof f === 'string' ? f : f?.file_path);
  return out;
}

// Commands whose FIRST argument-position paths are written to. `sed -i` and
// `tee` are included; `cp`/`mv`/`rsync`/`install` write their LAST path.
const WRITE_LAST_ARG = new Set(['cp', 'mv', 'rsync', 'install', 'ln']);
const WRITE_ANY_ARG = new Set([
  'rm', 'rmdir', 'tee', 'touch', 'mkdir', 'truncate', 'shred', 'chmod', 'chown', 'dd',
]);
// Wrappers that take a command to run: inspect what they wrap, not the wrapper.
const COMMAND_WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'env', 'nohup', 'time', 'xargs', 'nice']);

/**
 * Does this Bash command WRITE into the vault?
 *
 * Deliberately conservative and targeted: the verb or redirection must aim AT
 * a .ai-memory/ path, not merely appear in the same command line. A read like
 * `grep -r x .ai-memory/ > /tmp/out` redirects elsewhere and must pass, and
 * `rm tmp.txt && cat .ai-memory/INDEX.md` writes elsewhere and must pass.
 * Anything this cannot parse is allowed — the gate fails open by design, and
 * the editing tools (where the real risk is) are covered absolutely.
 */
export function bashWritesVault(command, vaultRe = /(^|[\s'"])[^\s'"|;&]*\.ai-memory(\/|$|['"\s])/) {
  const cmd = String(command || '');
  // The `=` is deliberately NOT a token-start character: `dd if=.ai-memory/x`
  // is a READ of the vault, and treating key=value args as targets denied it.
  const aims = (s) => vaultRe.test(` ${s} `);

  // Strip quotes around a wrapped command body so `bash -c "rm -rf .ai-memory"`
  // is analysed rather than skipped — the wrapper itself writes nothing.
  const unquote = (s) => s.replace(/^(['"])([\s\S]*)\1$/, '$2');

  // Two levels, because they mean different things. `;`/`&&`/`||`/newline
  // separate INDEPENDENT commands — a write in one must never be attributed to
  // a path in another. `|` only separates stages of ONE pipeline, and xargs
  // consumes its stdin from earlier stages, so the pipeline is the unit there.
  // (`>|` is a single noclobber redirect operator, not a pipe.)
  const normalized = cmd.replace(/>\|/g, '>');
  for (const pipeline of normalized.split(/\|\||&&|[;\n]/)) {
    if (!pipeline.trim()) continue;
    for (const segment of pipeline.split('|')) {
      const seg = segment.trim();
      if (!seg) continue;

      // Redirection: `> path`, `>> path`, `1> path`. The TARGET must be the vault.
      for (const m of seg.matchAll(/\d*>>?\s*([^\s;|&]+)/g)) {
        if (aims(unquote(m[1]))) return true;
      }

      const tokens = seg.match(/(?:[^\s'"]|'[^']*'|"[^"]*")+/g) || [];
      if (!tokens.length) continue;
      // Skip env assignments and sudo-style prefixes to find the real verb.
      let i = 0;
      while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || tokens[i] === 'sudo')) i++;
      let verb = (tokens[i] || '').split('/').pop();

      // A wrapper's real verb is further along (`bash -c "…"`, `xargs rm`,
      // `env FOO=1 rm`). Recurse into the wrapped body once.
      if (COMMAND_WRAPPERS.has(verb)) {
        const rest = tokens.slice(i + 1);
        const words = rest.filter((t) => !t.startsWith('-')).map(unquote);
        const body = words.join(' ');
        // sh -c takes a quoted script; the rest take a command line.
        if (body && body !== seg && bashWritesVault(body, vaultRe)) return true;
        // xargs/nice-style wrappers put their own flags (and separated flag
        // VALUES like `-n 1`) before the real verb, so scan every word for it
        // rather than trusting a position. xargs takes its paths from stdin —
        // i.e. from earlier stages of THIS pipeline, hence `pipeline`, never the
        // whole command line, which would leak across `&&`.
        if (words.some((w) => {
          const inner = w.split('/').pop();
          return WRITE_ANY_ARG.has(inner) || WRITE_LAST_ARG.has(inner);
        }) && aims(pipeline)) {
          return true;
        }
        continue;
      }

      const args = tokens.slice(i + 1).filter((t) => !t.startsWith('-')).map(unquote);
      if (!verb) continue;

      // dd names its direction explicitly: only `of=` is written. `if=` is a
      // read, and flagging it denied a legitimate copy OUT of the vault.
      if (verb === 'dd') {
        if (args.some((a) => a.startsWith('of=') && aims(a.slice(3)))) return true;
        continue;
      }
      if (WRITE_ANY_ARG.has(verb) && args.some(aims)) return true;
      if (WRITE_LAST_ARG.has(verb) && args.length && aims(args[args.length - 1])) return true;
      // `sed -i ... file`, `python -c ... ` are only flagged for the explicit
      // in-place edit form; everything else is left to fail open.
      if (verb === 'sed' && /(^|\s)-i\b/.test(seg) && args.some(aims)) return true;
      // `find <roots> ... -delete` / `-exec rm` rewrites or removes in place.
      // Only the ROOTS count: a vault path appearing later is an -path/-not/-prune
      // EXCLUSION, and `find . -path '*/.ai-memory/*' -prune -o -name '*.bak'
      // -delete` is the canonical way to clean everywhere EXCEPT the vault.
      if (verb === 'find' && /(^|\s)(-delete|-exec\s+(rm|truncate|tee|sed)\b)/.test(seg)) {
        const roots = [];
        for (const t of tokens.slice(i + 1)) {
          if (t.startsWith('-')) break;
          roots.push(unquote(t));
        }
        if (roots.some(aims)) return true;
      }
    }
  }
  return false;
}

function projectRoot() {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (fromEnv && existsSync(fromEnv)) return path.resolve(fromEnv);
  let dir = process.cwd();
  for (;;) {
    if (existsSync(path.join(dir, '.git')) || existsSync(path.join(dir, '.comind'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/** Count phase directories that actually contain a spec document. */
// Exported so the package's tests can assert this stays IDENTICAL in effect to
// doctor's countActivePhases — the gate is standalone (it cannot import from
// lib/), so the logic is deliberately duplicated and the test is the tether.
/**
 * A phase document that counts as a SHARED spec.
 *
 * `.planning/**\/*.local.md` is gitignored scratch. This gate exists to require
 * that bulk work be visible to the rest of the team, so a file no teammate will
 * ever receive cannot satisfy it.
 *
 * Duplicated from lib/doctor.mjs on purpose — this file is copied into
 * consuming repos and cannot import from lib/. A test asserts the two agree;
 * if they drift, doctor reports PASS while the gate still blocks.
 */
export function isSharedSpec(name) {
  const lower = String(name).toLowerCase();
  return lower.endsWith('.md') && !lower.endsWith('.local.md');
}

export function activePhases(root) {
  const dir = path.join(root, '.planning', 'phases');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    try {
      if (!statSync(p).isDirectory()) continue;
      if (readdirSync(p).some((f) => isSharedSpec(f))) out.push(name);
    } catch {
      // Unreadable entry — ignore rather than fail the gate.
    }
  }
  return out;
}

const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Drop state files older than a week.
 *
 * One file per session accumulates forever otherwise. Bounded and cheap: a single
 * readdir on a directory that holds at most a few days of sessions. Never throws —
 * failing to tidy up must not block an edit.
 */
function pruneStaleState(dir, now) {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('session-')) continue;
      const f = path.join(dir, name);
      try {
        if (now - statSync(f).mtimeMs > STATE_TTL_MS) rmSync(f, { force: true });
      } catch {
        // Racing another session's cleanup — ignore.
      }
    }
  } catch {
    // No state dir yet.
  }
}

function sessionFile(root, sessionId) {
  const dir = path.join(root, '.comind', 'state');
  mkdirSync(dir, { recursive: true });
  pruneStaleState(dir, Date.now());

  // Without a session id, fall back to something per-invocation-tree rather than a
  // shared literal: a single `no-session` file made unrelated sessions share one
  // counter, so one developer's bulk edit could gate another's next single edit.
  const id = sessionId || `pid-${process.ppid || process.pid}`;
  const safe = String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  // .log, not .json: the format is one canonical path per line (append-only).
  return path.join(dir, `session-${safe}.log`);
}

/**
 * Record the files this session has edited; return the distinct count.
 *
 * APPEND-ONLY, one canonical path per line. A read-modify-write of a JSON
 * array loses updates when Claude Code fires several tool calls in one turn:
 * two hook processes read the same snapshot and the second write erases the
 * first's file, so the counter stalls and rule 2 never trips. A single
 * appendFileSync of a short line is atomic under O_APPEND, so concurrent
 * writers interleave instead of clobbering. Dedup happens on read.
 */
function trackEdits(root, sessionId, files) {
  const file = sessionFile(root, sessionId);
  const seen = new Set();
  if (existsSync(file)) {
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const p = line.trim();
        if (p) seen.add(p);
      }
    } catch {
      // Unreadable state is an optimization loss, never a reason to block.
    }
  }
  const fresh = [];
  for (const f of files) {
    const c = canon(f, root);
    if (!seen.has(c)) {
      seen.add(c);
      fresh.push(c);
    }
  }
  if (fresh.length) {
    try {
      appendFileSync(file, `${fresh.join('\n')}\n`, 'utf8');
    } catch {
      // State is an optimization; a read-only .comind must not block edits.
    }
  }
  return seen.size;
}

function logBypass(root, reason) {
  try {
    const dir = path.join(root, '.comind', 'state');
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'bypass.log'), `${new Date().toISOString()}\t${reason}\n`, 'utf8');
  } catch {
    // Non-fatal.
  }
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) allow();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    allow(); // Unrecognized payload shape — fail open.
  }

  const toolName = payload.tool_name || payload.toolName || '';
  const input = payload.tool_input || payload.toolInput || payload.input || {};
  const sessionId = payload.session_id || payload.sessionId || process.env.CLAUDE_SESSION_ID;

  const isEditTool = /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(toolName);
  const isBash = toolName === 'Bash';
  if (!isEditTool && !isBash) allow();

  const root = projectRoot();

  // --- Rule 1 for Bash: a shell write into the vault is the same violation.
  // Rule 2 never applies to Bash — it counts files edited via the edit tools.
  if (isBash) {
    const command = input?.command || '';
    if (bashWritesVault(command)) {
      deny(
        [
          'CoMind: .ai-memory/ is a DERIVED vault and must not be written directly.',
          `  blocked: ${String(command).slice(0, 200)}`,
          '',
          '  It is regenerated from .planning/ and your change would be overwritten.',
          '  Edit the matching file under .planning/, then run /comind-sync.',
        ].join('\n'),
      );
    }
    allow();
  }

  const files = targetPaths(input);
  if (!files.length) allow();

  // --- Rule 1: derived path. Absolute for the editing tools. ---
  const vault = path.join(root, '.ai-memory');
  const offender = files.find((f) => isInside(f, vault, root));
  if (offender) {
    deny(
      [
        'CoMind: .ai-memory/ is a DERIVED vault and must not be edited directly.',
        `  blocked: ${offender}`,
        '',
        '  It is regenerated from .planning/ and your change would be overwritten.',
        '  Edit the source instead, then regenerate:',
        '',
        '    1. edit the matching file under .planning/',
        '    2. run /comind-sync',
      ].join('\n'),
    );
  }

  // --- Rule 3: escape hatch (checked before rule 2 so it can skip it) ---
  if (String(process.env.COMIND_GATE || '').toLowerCase() === 'off') {
    logBypass(root, `${toolName} ${files.join(',')}`);
    allow();
  }

  // --- Rule 2: bulk editing requires a spec ---
  // Writing the phase spec is the remediation this rule prescribes, so writes
  // into .planning/ are exempt: gating them made the deny message impossible
  // to act on.
  const planning = path.join(root, '.planning');
  if (files.every((f) => isInside(f, planning, root))) allow();

  // `|| DEFAULT` treated an explicit 0 as unset, making the strictest setting
  // of the knob unreachable.
  const raw2 = process.env.COMIND_BULK_THRESHOLD;
  const parsed = raw2 == null || raw2 === '' ? NaN : Number(raw2);
  const threshold = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_THRESHOLD;
  const distinct = trackEdits(root, sessionId, files);
  if (distinct <= threshold) allow();

  const phases = activePhases(root);
  if (phases.length) allow();

  deny(
    [
      `CoMind: bulk edit blocked — ${distinct} files touched this session with no spec.`,
      '',
      '  .planning/phases/ has no phase document, so this work is unplanned and',
      '  invisible to the rest of the team. The GSD loop exists to prevent exactly',
      '  this kind of context loss.',
      '',
      '  Do one of these:',
      '    /gsd-workflow discuss     capture the decisions first',
      '    /gsd-workflow plan        produce .planning/phases/<NN>-<slug>/',
      '',
      `  Deliberate one-off? Set COMIND_GATE=off for this session (logged), or raise`,
      `  COMIND_BULK_THRESHOLD (currently ${threshold}).`,
    ].join('\n'),
  );
}

// Run only when executed as the hook script — the exports above must stay
// importable by tests without draining stdin or exiting the process.
//
// Compare REALPATHS, not raw URLs: Node's ESM loader resolves import.meta.url
// through symlinks while process.argv[1] keeps the literal invocation path, so
// any symlinked component in the project path (macOS /tmp -> /private/tmp, or
// a ~/code -> /Volumes/... link) made this false and silently disabled the
// entire gate while still exiting 0.
function invokedAsScript() {
  const arg = process.argv[1];
  if (!arg) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(arg) === realpathSync(self);
  } catch {
    return path.resolve(arg) === path.resolve(self);
  }
}

if (invokedAsScript()) {
  main().catch(() => {
    // Fail open, always.
    process.exit(0);
  });
}
