// Sentinel-block patching for .gitignore and .gitattributes, plus withdrawal of
// the retired .claudeignore block.
//
// This is the idempotence core. Every managed line lives between two sentinels.
// Re-running REPLACES the block; anything a developer wrote outside it is never
// touched. Two consecutive runs must produce byte-identical files.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PKG_ROOT } from './platform.mjs';

export const BEGIN = '# >>> comind managed >>>';
export const END = '# <<< comind managed <<<';

/** Detect the dominant line ending, used only for the block WE write. */
function detectEol(text) {
  if (!text) return '\n';
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}

function normalize(text) {
  return text.replace(/\r\n/g, '\n');
}

/** Every [begin, end] sentinel span in the file, in order. */
function findBlocks(src) {
  const spans = [];
  let from = 0;
  for (;;) {
    const b = src.indexOf(BEGIN, from);
    if (b === -1) break;
    const e = src.indexOf(END, b + BEGIN.length);
    if (e === -1) return { spans, unmatched: BEGIN };
    spans.push([b, e + END.length]);
    from = e + END.length;
  }
  // An END with no BEGIN before it is the other half of a hand edit.
  const strayEnd = src.indexOf(END, from);
  if (strayEnd !== -1) return { spans, unmatched: END };
  return { spans, unmatched: null };
}

/**
 * Replace (or append) the managed block.
 * Returns { changed, content, action } and never writes — caller decides,
 * so --dry-run shares the exact same code path as a real run.
 *
 * Content OUTSIDE the block is preserved byte for byte, including its own line
 * endings: a mixed-EOL file used to have every minority line rewritten, which
 * contradicts this module's promise and shows up as noise in a teammate's diff.
 */
export function patchBlock(existing, blockBody, { version }) {
  const eol = detectEol(existing);
  const src = existing || '';

  const header = `${BEGIN}  (comind ${version} — do not edit inside this block)`;
  const blockLf = [header, ...normalize(blockBody).trimEnd().split('\n'), END].join('\n');
  const block = eol === '\r\n' ? blockLf.replace(/\n/g, '\r\n') : blockLf;

  const { spans, unmatched } = findBlocks(src);

  if (unmatched) {
    // Half a sentinel pair means someone edited by hand. Refuse rather than
    // guess at boundaries and eat their lines.
    return {
      changed: false,
      content: existing,
      action: 'error',
      error: `Found an unmatched comind sentinel. Remove the stray "${unmatched}" line and re-run.`,
    };
  }

  let out;
  let action;

  if (spans.length) {
    // Collapse ALL managed blocks into one. A merge resolved by keeping both
    // sides leaves duplicates, and replacing only the first left the stale
    // second block in place forever, silently.
    let result = src.slice(0, spans[0][0]) + block;
    let cursor = spans[0][1];
    for (const [b, e] of spans.slice(1)) {
      result += src.slice(cursor, b);
      cursor = e;
    }
    out = result + src.slice(cursor);
    action = spans.length > 1 ? 'deduplicated' : 'replaced';
  } else {
    const base = src.replace(/[\r\n\s]+$/, '');
    const sep = eol === '\r\n' ? '\r\n\r\n' : '\n\n';
    out = base.length ? `${base}${sep}${block}${eol}` : `${block}${eol}`;
    action = 'appended';
  }

  if (!out.endsWith('\n')) out += eol;
  return { changed: out !== existing, content: out, action };
}

/**
 * Strip every managed block, leaving the developer's own lines untouched.
 *
 * Needed because a managed file can be RETIRED, not just updated: `.claudeignore`
 * was written and committed for months before we established that Claude Code
 * has no such mechanism, so the block has to be withdrawn from repos that already
 * carry it rather than left behind as config that reads like it does something.
 */
export function removeBlock(existing) {
  const src = existing || '';
  const { spans, unmatched } = findBlocks(src);

  if (unmatched) {
    return {
      changed: false,
      content: existing,
      action: 'error',
      error: `Found an unmatched comind sentinel. Remove the stray "${unmatched}" line and re-run.`,
    };
  }
  if (!spans.length) return { changed: false, content: existing, action: 'absent' };

  let out = '';
  let cursor = 0;
  for (const [b, e] of spans) {
    out += src.slice(cursor, b);
    cursor = e;
  }
  out += src.slice(cursor);

  // Only our block was ever in here — leave no empty file behind.
  if (!out.trim()) return { changed: true, content: '', action: 'emptied' };

  // Collapse the blank-line pair `patchBlock` inserted when it appended.
  out = out.replace(/\n{3,}/g, '\n\n').replace(/\r\n(\r\n){2,}/g, '\r\n\r\n');
  if (!out.endsWith('\n')) out += detectEol(src);
  return { changed: out !== existing, content: out, action: 'stripped' };
}

/**
 * Does the host repo already ignore a path our managed block force-includes?
 *
 * The block negates `.claude/` so the committed team settings survive, which
 * silently overrides a deliberate host rule. Overriding is correct — the files
 * must be committed for CoMind to work — but doing it without saying so is not.
 */
export function conflictingIgnores(existing) {
  const hits = [];
  for (const raw of normalize(existing || '').split('\n')) {
    // The sentinel check must come FIRST: both sentinels start with '#', so a
    // comment skip above it made the stop unreachable and rules a developer
    // wrote BELOW the managed block (where git's last-match-wins makes theirs
    // the effective rule) were misreported as overridden.
    if (raw.includes(BEGIN) || raw.includes(END)) break;
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    // Match every spelling that actually ignores .claude, not just the literal
    // ones: `/.claude/` (root-anchored, the common template form),
    // `.claude/*`, `.claude/**`, `**/.claude/`, and the catch-all `.*`.
    if (
      /^\.\*$/.test(line) ||
      /^(\*\*\/)?\/?\.claude(\/(\*{1,2})?)?$/.test(line) ||
      // Specific files inside .claude that the managed block re-includes.
      /^(\*\*\/)?\/?\.claude\/(settings\.json|hooks(\/(\*{1,2})?)?|skills(\/(\*{1,2})?)?)$/.test(line)
    ) {
      hits.push(line);
    }
  }
  return hits;
}

function loadTemplate(name) {
  return readFileSync(path.join(PKG_ROOT, 'templates', name), 'utf8');
}

/**
 * Apply both ignore files. `dryRun` returns the plan without writing.
 * Missing files are created — a repo with no .gitignore is common.
 */
export function applyIgnores(repoRoot, { version, dryRun = false }) {
  const targets = [
    { file: '.gitignore', template: 'gitignore.block' },
    // Managed like the ignore files so the path gitinform lists as a committed
    // artifact actually gets created — it never was, so the informer promised
    // a file no step would ever write.
    { file: '.gitattributes', template: 'gitattributes.block' },
    // Retired: Claude Code reads no `.claudeignore`. What that block described is
    // now enforced through `permissions.deny` in .claude/settings.json, which the
    // tool actually honours. Repos set up before this still carry the block, so
    // withdraw it instead of leaving inert config that reads as load-bearing.
    { file: '.claudeignore', retire: true },
  ];

  const results = [];
  for (const { file, template, retire } of targets) {
    const abs = path.join(repoRoot, file);
    if (retire && !existsSync(abs)) continue;
    const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    const res = retire ? removeBlock(existing) : patchBlock(existing, loadTemplate(template), { version });

    if (retire) {
      if (res.action === 'error') {
        results.push({ file, ...res });
        continue;
      }
      if (res.action === 'absent') continue;
      if (res.changed && !dryRun) {
        if (res.action === 'emptied') rmSync(abs, { force: true });
        else writeFileSync(abs, res.content, 'utf8');
      }
      const verb = res.action === 'emptied' ? 'removed (obsolete)' : 'managed block withdrawn';
      results.push({ file, changed: res.changed, action: dryRun ? `would be ${verb}` : verb, overrides: [] });
      continue;
    }

    if (res.action === 'error') {
      results.push({ file, ...res });
      continue;
    }
    // Surface, rather than silently win, when our negations override a rule the
    // host repo deliberately wrote.
    const overrides = file === '.gitignore' ? conflictingIgnores(existing) : [];
    if (res.changed && !dryRun) writeFileSync(abs, res.content, 'utf8');
    // An explicit map, not a suffix strip — `'replaced'.replace(/ed$/, '')` yields
    // "would replac".
    const FUTURE = {
      appended: 'would append',
      replaced: 'would replace',
      deduplicated: 'would collapse duplicate blocks',
    };
    const action = !res.changed ? 'up-to-date' : dryRun ? FUTURE[res.action] || `would ${res.action}` : res.action;
    results.push({ file, changed: res.changed, action, overrides });
  }
  return results;
}
