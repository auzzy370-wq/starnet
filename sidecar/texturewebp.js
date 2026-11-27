'use strict';
/* THE PICTURES, AT A TENTH OF THE WEIGHT (2026-11-27).
   A cold load of the station fetched 154 MB of texture: the industrial albedos are ~1200x1300 RGBA PNGs of ~3 MB each,
   and the renderer asks for seventy-odd of them. PNG is the wrong container for a photographic albedo — the same pixels
   as lossy WebP (q82, alpha kept at q100) measured 51.0 MB -> 5.0 MB on the seventeen biggest files, a 90% cut, with no
   change to the frontend at all: the browser picks by Content-Type, so /assets/industrial/wall.png can answer image/webp.

   Encoded once per source file and kept on disk (`.webp-cache/`), so a restart re-encodes nothing and a repeat load is
   the same size. sharp is an ACCELERATOR: not installed, or the encode fails, and the PNG is served exactly as before.
   Small files are left alone — a few KB of sprite has nothing to gain and a lot of pixel-exactness to lose. */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const MIN_BYTES = 512 * 1024;     // below this a PNG is already cheap; never worth touching

let sharp = null;
let loadTried = false;
function load() {
  if (loadTried) return sharp;
  loadTried = true;
  try { sharp = require('sharp'); } catch (e) { sharp = null; }
  return sharp;
}

function acceptsWebp(req) {
  const accept = String((req && req.headers && req.headers['accept']) || '');
  return /(^|,|\s)image\/webp\b/i.test(accept);
}

let cacheDirMemo = null;
function cacheDir() {
  if (cacheDirMemo) return cacheDirMemo;
  cacheDirMemo = path.join(path.resolve(__dirname, '..'), '.webp-cache');
  try { fs.mkdirSync(cacheDirMemo, { recursive: true }); } catch (e) { /* the read below just misses */ }
  return cacheDirMemo;
}

/* The WebP for a file, or null. `st` is the png's stat: it is part of the cache key, so an edited texture re-encodes
   and the old child is never served. */
async function webpFor(abs, st) {
  const es = load();
  if (!es) return null;
  const key = crypto.createHash('sha1')
    .update(abs + ':' + st.size + ':' + Math.round(st.mtimeMs)).digest('hex') + '.webp';
  const file = path.join(cacheDir(), key);
  try {
    const hit = await fsp.readFile(file);
    if (hit && hit.length) return hit;
  } catch (e) { /* not encoded yet */ }
  try {
    const buf = await es(abs).webp({ quality: 82, alphaQuality: 100, effort: 4 }).toBuffer();
    if (!buf || !buf.length) return null;
    const tmp = file + '.' + process.pid + '.tmp';
    try { await fsp.writeFile(tmp, buf); await fsp.rename(tmp, file); } catch (e) { /* a cache miss next time */ }
    return buf;
  } catch (e) { return null; }   // an unreadable or odd PNG keeps the original bytes
}

/* Would this file be worth (and allowed) a WebP? Cheap checks only, no I/O. */
function eligible(abs, st, ext, req) {
  if (ext !== '.png' || !st || !st.isFile() || st.size < MIN_BYTES) return false;
  if (String(abs).indexOf(path.sep + 'assets' + path.sep) < 0) return false;
  return acceptsWebp(req);
}

module.exports = { webpFor, eligible, acceptsWebp, MIN_BYTES };
