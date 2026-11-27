'use strict';
/* THE BOOT SET, AS FEWER REQUESTS (2026-11-27).
   index.html asks for ~330 separate files, and over a quick tunnel that is one round trip per file. This module reads
   the page's own script/link tags IN DOCUMENT ORDER and concatenates them.

   ORDER IS THE WHOLE PROBLEM. The page mixes strict files with a handful that are sloppy or that ask
   document.currentScript which element is running. Those cannot go into a bundle (a bundle is strict or sloppy as a
   whole, and inside a bundle currentScript answers "the bundle"). Putting one big bundle at the first strict file's
   position would run every strict file BEFORE the sloppy files that used to sit between them — measured in jsdom as a
   real breakage (a strict file reading a helper an earlier sloppy file had not defined yet). So the set is cut into
   runs: one bundle per contiguous run of strict files, each bundle emitted exactly where its first file was, and the
   files in between left as individual tags. Same order, same strictness, same globals, a fraction of the requests.

   A bundle that does not PARSE is never served: the caller falls back to the untouched page. */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const vm = require('node:vm');

const STRICT_PROLOGUE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(?:'use strict'|"use strict")/;

function bootLinks(html) {
  const js = [], css = [], seenJs = new Set(), seenCss = new Set();
  for (const m of String(html || '').matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)) {
    const rel = m[1].split('?')[0].replace(/^\/+/, '');
    if (!/\.js$/i.test(rel) || seenJs.has(rel)) continue;
    seenJs.add(rel); js.push(rel);
  }
  for (const m of String(html || '').matchAll(/<link\b[^>]*\bhref="([^"]+)"[^>]*>/g)) {
    const rel = m[1].split('?')[0].replace(/^\/+/, '');
    if (!/\.css$/i.test(rel) || seenCss.has(rel)) continue;
    seenCss.add(rel); css.push(rel);
  }
  return { js, css };
}

/* Why a file cannot join a bundle. `null` means it can. */
function whyApart(rel, src) {
  if (/document\.currentScript/.test(src)) return 'currentScript';
  if (!STRICT_PROLOGUE.test(src)) return 'sloppy';
  return null;
}

async function buildBootBundle(opts) {
  const frontendDir = path.resolve((opts && opts.frontendDir) || 'frontend');
  const strip = (opts && opts.stripJsComments) || ((s) => s);
  let html = opts && opts.indexHtml;
  if (html == null) html = await fsp.readFile(path.join(frontendDir, 'index.html'), 'utf8');
  const { js, css } = bootLinks(html);

  const runs = [], apart = [], jsSet = new Set(), cssSet = new Set();
  let open = null;
  for (const rel of js) {
    const abs = path.resolve(frontendDir, rel);
    let src = null, why = null;
    if (abs.indexOf(frontendDir + path.sep) !== 0) why = 'outside';
    else { try { src = await fsp.readFile(abs, 'utf8'); } catch (e) { why = 'absent'; } }
    if (!why && src != null) why = whyApart(rel, src);
    if (why) { apart.push({ rel, why }); open = null; continue; }   // a run ENDS at anything left behind
    if (!open) { open = { urls: [], parts: [] }; runs.push(open); }
    open.urls.push(rel);
    open.parts.push('/* ' + rel + ' */\n' + strip(src));
    jsSet.add(rel);
  }

  const bundles = runs.map((run, index) => {
    const text = "'use strict';\n" + run.parts.join('\n;\n') + '\n';
    let error = null;
    try { new vm.Script(text, { filename: 'boot-bundle-' + index + '.js' }); } catch (e) { error = e; }
    return { index, urls: run.urls, text, error };
  });

  const cssParts = [];
  for (const rel of css) {
    const abs = path.resolve(frontendDir, rel);
    if (abs.indexOf(frontendDir + path.sep) !== 0) { apart.push({ rel, why: 'outside' }); continue; }
    try { cssParts.push('/* ' + rel + ' */\n' + await fsp.readFile(abs, 'utf8')); cssSet.add(rel); }
    catch (e) { apart.push({ rel, why: 'absent' }); }
  }

  const error = bundles.find((b) => b.error) || null;
  return {
    bundles, cssText: cssParts.join('\n'), jsSet, cssSet, apart,
    error: error && error.error, jsCount: jsSet.size, cssCount: cssSet.size,
    jsBytes: bundles.reduce((s, b) => s + b.text.length, 0)
  };
}

/* Rewrite the page's own tags: each run's tags collapse into one tag at the position of its FIRST file, so every
   remaining tag keeps its exact place relative to the bundles. A set that failed to parse is never referenced. */
function applyBootBundle(html, set, version, urls) {
  if (!set || set.error || !set.bundles || !set.bundles.length) return html;
  const q = '?v=' + version;
  const byUrl = new Map();
  for (const b of set.bundles) for (const u of b.urls) byUrl.set(u, b);
  const emitted = new Set();
  let out = String(html).replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (tag, u) => {
    const rel = String(u).split('?')[0].replace(/^\/+/, '');
    const b = byUrl.get(rel);
    if (!b) return tag;
    if (emitted.has(b.index)) return '';
    emitted.add(b.index);
    const src = (urls && urls.jsFor) ? urls.jsFor(b.index) : ('/__boot.' + b.index + '.js');
    return '<script src="' + src + q + '"></script>';
  });
  if (set.cssSet && set.cssSet.size) {
    const cssUrl = (urls && urls.css) || '/__boot.css';
    let cssDone = false;
    out = out.replace(/<link\b[^>]*\bhref="([^"]+)"[^>]*>/g, (tag, u) => {
      const rel = String(u).split('?')[0].replace(/^\/+/, '');
      if (!set.cssSet.has(rel)) return tag;
      if (cssDone) return '';
      cssDone = true;
      return '<link rel="stylesheet" href="' + cssUrl + q + '">';
    });
  }
  return out;
}

module.exports = { buildBootBundle, applyBootBundle, bootLinks, STRICT_PROLOGUE };
