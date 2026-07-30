// Pinned binary acquisition: download → SHA-256 verify → extract.
//
// No package manager is required on any platform. Given a pinned release tag we
// fetch the exact asset for this OS/arch, verify it against the release's own
// checksums.txt, and extract into ~/.claude/comind/bin/. That is what makes the
// pin real: Homebrew, apt, and cargo all resolve versions their own way.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  readdirSync,
  lstatSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import zlib from 'node:zlib';
import { IS_WINDOWS, run, which } from './platform.mjs';

const MAX_REDIRECTS = 5;

/** GET a URL into a Buffer, following redirects. Rejects on non-200. */
export function download(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'comind-installer',
          Accept: '*/*',
        },
        timeout: 120_000,
      },
      (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          const next = new URL(headers.location, url).toString();
          return download(next, redirectsLeft - 1).then(resolve, reject);
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Timeout fetching ${url}`)));
    req.on('error', reject);
  });
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Parse a `sha256  filename` style checksums file into a map.
 * Handles both two-space (coreutils) and single-space separators, and the
 * BSD `SHA256 (file) = hash` form.
 */
export function parseChecksums(text) {
  const map = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const bsd = line.match(/^SHA256\s*\((.+?)\)\s*=\s*([0-9a-f]{64})$/i);
    if (bsd) {
      map.set(path.basename(bsd[1]), bsd[2].toLowerCase());
      continue;
    }
    const gnu = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (gnu) map.set(path.basename(gnu[2].trim()), gnu[1].toLowerCase());
  }
  return map;
}

// --- Minimal pure-JS tar reader -------------------------------------------
// Only the fields CoMind needs: regular files and their paths. Keeps the
// common macOS/Linux .tar.gz path free of any external tool.

function readTar(buf) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    // Two consecutive zero blocks terminate the archive.
    if (header.every((b) => b === 0)) break;

    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);
    // GNU/POSIX long-name prefix.
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const fullName = prefix ? `${prefix}/${name}` : name;

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    // subarray silently clamps past the buffer end, which would turn a
    // truncated stream inside a valid gzip wrapper into a short binary that
    // gets chmod +x and reported as installed. Refuse instead.
    if (dataEnd > buf.length) {
      throw new Error(`truncated tar: ${fullName} declares ${size} bytes past end of archive`);
    }
    // Regular files only — symlinks, hardlinks, and devices are never wanted
    // in a binary release and are exactly what escapes a target directory.
    if (typeFlag === '0' || typeFlag === '\0') {
      entries.push({ name: fullName, data: buf.subarray(dataStart, dataEnd) });
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/**
 * Extract a .tar.gz buffer in-process. Returns written file paths.
 *
 * Flattening to `basename` serves two purposes: release archives sometimes nest
 * the binary a level deep, and it structurally neutralizes any `../` traversal
 * entry — a crafted archive cannot address a path outside destDir at all.
 */
export function extractTarGzInProcess(buf, destDir) {
  const tar = zlib.gunzipSync(buf);
  const written = [];
  mkdirSync(destDir, { recursive: true });
  for (const entry of readTar(tar)) {
    const base = path.basename(entry.name);
    if (!base || base === '.' || base === '..') continue;
    const target = path.join(destDir, base);
    // Belt and braces: assert containment even though basename guarantees it.
    if (!isContained(target, destDir)) continue;
    // Unlink first: writeFileSync FOLLOWS an existing symlink, so a planted
    // link at destDir/<name> would send the archive bytes to its target
    // anywhere on disk. Removing it makes the write land where we chose.
    rmSync(target, { force: true });
    writeFileSync(target, entry.data);
    written.push(target);
  }
  return written;
}

/** True when `target` resolves inside `dir`. Used to gate every extracted path. */
export function isContained(target, dir) {
  const root = path.resolve(dir);
  const abs = path.resolve(target);
  return abs === root || abs.startsWith(root + path.sep);
}

/**
 * Inspect an archive BEFORE handing it to an external extractor.
 *
 * This has to be a pre-flight check, not a post-hoc scan: a file written outside
 * destDir is by definition not inside destDir, so walking destDir afterwards can
 * never find it. `tar -tf` lists entries without extracting (and bsdtar reads zip
 * too), so validate the manifest first.
 *
 * Returns { listable, unsafe }. `listable: false` (no tar, or the listing
 * failed) means the archive CANNOT be validated — callers must refuse to hand
 * it to an external extractor, not shrug and extract anyway.
 */
export function inspectArchive(archivePath) {
  const tar = which('tar');
  if (!tar) return { listable: false, unsafe: null };
  const res = run(tar, ['-tf', archivePath], { timeout: 60_000 });
  if (!res.ok) return { listable: false, unsafe: null };
  for (const raw of res.stdout.split(/\r?\n/)) {
    const name = raw.trim();
    if (!name) continue;
    if (path.isAbsolute(name) || /^([A-Za-z]:)?[\\/]/.test(name)) return { listable: true, unsafe: name };
    if (name.split(/[\\/]/).includes('..')) return { listable: true, unsafe: name };
  }
  return { listable: true, unsafe: null };
}

/** Extract via the system `tar` (macOS, Linux, and Windows 10+ bsdtar). */
function extractWithSystemTar(archivePath, destDir) {
  const tar = which('tar');
  if (!tar) return null;
  const res = run(tar, ['-xf', archivePath, '-C', destDir], { timeout: 120_000 });
  return res.ok ? res : null;
}

/** Windows fallback for .zip when tar.exe is absent (pre-1803). */
function extractWithPowerShell(archivePath, destDir) {
  const ps = which('powershell') || which('pwsh');
  if (!ps) return null;
  const res = run(
    ps,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ],
    { timeout: 120_000 },
  );
  return res.ok ? res : null;
}

/**
 * Recursively collect regular files, used to locate the binary after extraction.
 * lstat, never stat: a symlinked directory would walk OUT of destDir, a
 * dangling symlink would throw, and a symlink returned here would later be
 * followed by the hoist's writeFileSync. Symlinks are skipped wholesale.
 */
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, acc);
    else if (st.isFile()) acc.push(p);
  }
  return acc;
}

/**
 * Acquire a pinned GitHub release asset.
 *
 * Returns { ok, binPath, version, method } or { ok:false, kind, reason } —
 * never throws, so one failed layer cannot abort the whole setup. `kind` is
 * load-bearing for callers: only 'no-asset' may route to a source-build
 * fallback; 'checksum-mismatch' is a verification refusal that must FAIL, not
 * be silently retried elsewhere.
 *
 *   kind: 'no-asset' | 'download-failed' | 'checksum-missing' |
 *         'checksum-mismatch' | 'unsafe-archive' | 'extract-failed'
 */
export async function installFromGithubRelease({
  spec,
  platformKey,
  destDir,
  cacheDir,
  log,
  // Injectable so the download → verify → extract chain can be tested without a
  // network. Defaults to the real implementation, so production behaviour is
  // unchanged; this is the one code path that produces an executable, and it was
  // previously untestable end to end.
  fetchImpl = download,
}) {
  const asset = spec.assets?.[platformKey];
  if (!asset) {
    return {
      ok: false,
      kind: 'no-asset',
      reason: `No prebuilt ${spec.repo} asset for ${platformKey}.`,
      fallback: spec.fallback,
    };
  }

  const tag = `${spec.tagPrefix || ''}${spec.version}`;
  const base = `https://github.com/${spec.repo}/releases/download/${tag}`;
  mkdirSync(destDir, { recursive: true });
  // The cache is keyed by version: a version-less path made every upgrade
  // overwrite the previous archive, so the documented offline rollback always
  // ended in a checksum mismatch. checksums.txt is cached alongside for the
  // same reason — rollback must not need the network at all.
  const verDir = path.join(cacheDir, spec.version);
  mkdirSync(verDir, { recursive: true });
  const archivePath = path.join(verDir, asset);
  const sumsPath = spec.verify ? path.join(verDir, spec.verify) : null;

  let buf = null;
  // Two attempts: the first may serve from cache; if verification fails on
  // cached bytes that is a corrupt/stale cache, not tampering — purge and
  // re-download once. Tamper wording is reserved for fresh downloads.
  for (let attempt = 0; attempt < 2; attempt++) {
    const wantCache = attempt === 0;
    let archiveFromCache = false;
    let sumsFromCache = false;

    if (wantCache && existsSync(archivePath)) {
      buf = readFileSync(archivePath);
      archiveFromCache = true;
      log?.(`  cached ${asset}`);
    } else {
      log?.(`  downloading ${asset} (${tag})`);
      try {
        buf = await fetchImpl(`${base}/${asset}`);
      } catch (err) {
        return {
          ok: false,
          kind: 'download-failed',
          reason: `Download failed: ${err.message}`,
          fallback: spec.fallback,
        };
      }
    }

    if (!spec.verify) break;

    let sumsText;
    if (wantCache && existsSync(sumsPath)) {
      sumsText = readFileSync(sumsPath, 'utf8');
      sumsFromCache = true;
    } else {
      try {
        sumsText = (await fetchImpl(`${base}/${spec.verify}`)).toString('utf8');
      } catch (err) {
        return { ok: false, kind: 'download-failed', reason: `Could not fetch ${spec.verify}: ${err.message}` };
      }
      writeFileSync(sumsPath, sumsText);
    }

    const want = parseChecksums(sumsText).get(asset);
    const got = sha256(buf);
    if (want && want === got) {
      log?.(`  sha256 verified`);
      break;
    }
    if (archiveFromCache || sumsFromCache) {
      // Purge only the part that is actually IMPLICATED, not everything that
      // happened to come from the cache. `!want` means the checksums file is
      // unusable and says nothing about the archive — deleting the archive
      // there destroys the verified copy that makes offline rollback possible.
      // A real hash mismatch is the opposite: the checksums are fine and the
      // archive is the bad one.
      if (!want) {
        log?.(`  cached ${spec.verify} has no entry for ${asset} — refetching it`);
        if (sumsFromCache) rmSync(sumsPath, { force: true });
      } else {
        log?.(`  cached ${asset} failed verification — refetching it`);
        if (archiveFromCache) rmSync(archivePath, { force: true });
      }
      continue;
    }
    if (!want) {
      return {
        ok: false,
        kind: 'checksum-missing',
        reason: `${asset} is absent from ${spec.verify} — refusing to install unverified.`,
      };
    }
    return {
      ok: false,
      kind: 'checksum-mismatch',
      reason: `SHA-256 mismatch for freshly downloaded ${asset} — possible tampering, refusing to install.\n    want ${want}\n    got  ${got}`,
    };
  }

  writeFileSync(archivePath, buf);

  // The in-process reader is PREFERRED for tar.gz, not a fallback. It flattens to
  // basename and takes regular files only, so neither a traversal entry nor a
  // symlink can address anything outside destDir; the external extractors honour
  // archive-internal paths and rely on their own defaults to refuse `..`.
  const isZip = asset.endsWith('.zip');
  let extracted = null;

  // Files written by THIS extraction. The hoist must only ever consider these:
  // picking any same-named file under destDir would let a pre-existing nested
  // `bin/rtk` — left by an older archive that nested its binary — overwrite the
  // freshly verified one with bytes nothing in this run ever checked.
  let extractedFiles = null;
  let stagingDir = null;

  if (!isZip) {
    try {
      extractedFiles = extractTarGzInProcess(buf, destDir);
      extracted = { ok: true, via: 'in-process' };
    } catch (err) {
      // Malformed gzip or an exotic tar variant — fall through to system tar.
      log?.(`  in-process extraction failed (${err.message}); trying system tar`);
    }
  }

  if (!extracted) {
    // Validate before extracting, not after — see inspectArchive. An archive
    // that cannot be listed gets refused outright: handing it to an external
    // extractor unvalidated is exactly the hole the pre-flight exists to close.
    const inspected = inspectArchive(archivePath);
    if (!inspected.listable) {
      return {
        ok: false,
        kind: 'unsafe-archive',
        reason: `Cannot list ${asset} to validate it before extraction (is \`tar\` installed? Windows 10 1803+ ships it) — refusing to extract unvalidated. Alternative: ${spec.fallback}`,
      };
    }
    if (inspected.unsafe) {
      return {
        ok: false,
        kind: 'unsafe-archive',
        reason: `${asset} contains an unsafe path (${inspected.unsafe}) that would escape the target directory — refusing to install.`,
      };
    }
    // Extract into a FRESH staging directory, never straight into destDir:
    // the external extractors do not report what they wrote, so extracting
    // in place would leave the hoist unable to tell this archive's files from
    // whatever was already there.
    const staging = path.join(destDir, '.comind-extract');
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    extracted =
      extractWithSystemTar(archivePath, staging) ||
      (isZip && IS_WINDOWS ? extractWithPowerShell(archivePath, staging) : null);
    if (extracted) {
      extractedFiles = walk(staging);
      stagingDir = staging;
    } else {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  if (!extracted) {
    return {
      ok: false,
      kind: 'extract-failed',
      reason: `Could not extract ${asset}. Install \`tar\` (Windows 10 1803+ ships it) or use: ${spec.fallback}`,
    };
  }

  const wantBin = IS_WINDOWS ? `${spec.binName}.exe` : spec.binName;
  // The external extractors do not report what they wrote, so for those the walk
  // is unavoidable — but it runs against the fresh staging directory created
  // above, so nothing pre-existing in destDir can win.
  const candidates = extractedFiles ?? [];
  const found = candidates.find((f) => path.basename(f) === wantBin);
  if (!found) {
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
    return { ok: false, kind: 'extract-failed', reason: `Extracted ${asset} but found no ${wantBin} inside.` };
  }

  // Nested archives leave the binary a level down; hoist it so PATH works.
  // walk() returns real files only, and any pre-existing entry at the final
  // path (e.g. a planted symlink) is removed before the write so nothing is
  // ever written THROUGH a link.
  const finalPath = path.join(destDir, wantBin);
  if (found !== finalPath) {
    if (!isContained(found, destDir)) {
      if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
      return { ok: false, kind: 'extract-failed', reason: `Extracted ${wantBin} landed outside the target directory — refusing.` };
    }
    rmSync(finalPath, { force: true });
    writeFileSync(finalPath, readFileSync(found));
  }
  if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
  if (!IS_WINDOWS) chmodSync(finalPath, 0o755);

  return { ok: true, binPath: finalPath, version: spec.version, method: 'github-release' };
}
