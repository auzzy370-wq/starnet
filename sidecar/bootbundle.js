'use strict';
/* THE BOOT SET, AS A FEW REQUESTS (2026-11-27).
   index.html asks for ~330 separate files. Over a quick tunnel that is one round trip per file, and each small
   response pays its own compression header — so the first load cost seconds of latency rather than seconds of
   transfer. This module reads the page's own script/link tags IN DOCUMENT ORDER and concatenates them.

   What it refuses to touch, because concatenation would change behaviour:
     · sloppy files  — a bundle is strict or sloppy as a whole. Putting a file that is sloppy today into a strict
                       bundle would turn implicit globals into ReferenceErrors, so those stay individual tags.
     · document.currentScript — inside a bundle that answers "which element is running", and the answer would be the
                       bundle, not the file. Those stay individual tags too.
     · anything outside the frontend root, and anything unreadable.

   Every included file already begins with 'use strict', and the bundle states it once at the top, so each file runs
   exactly as strictly as it does on its own today. Order is preserved, so cross-file globals resolve as before.
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

/* Cross-file top-level declarations are legal across separate classic scripts (var/function land on the global
   object) but a `const`/`let`/`class` at top level goes into the shared global lexical scope — so a duplicate is
   already a SyntaxError on the page today, and the same duplicate would be a SyntaxError in the bundle. That is why
   a parse check is enough to catch the whole class: vm.Script parses exactly like a classic script. */
async function buildBootBundle(opts) {
  const frontendDir = path.resolve((opts && opts.frontendDir) || 'frontend');
  const strip = (opts && opts.stripJsComments) || ((s) => s);
  let html = opts && opts.indexHtml;
  if (html == null) html = await fsp.readFile(path.join(frontendDir, 'index.html'), 'utf8');
  const { js, css } = bootLinks(html);

  const jsSet = new Set(), cssSet = new Set(), apart = [], jsParts = [], cssParts = [];
  for (const rel of js) {
    const abs = path.resolve(frontendDir, rel);
    if (abs.indexOf(frontendDir + path.sep) !== 0) { apart.push({ rel, why: 'outside' }); continue; }
    let src;
    try { src = await fsp.readFile(abs, 'utf8'); } catch (e) { apart.push({ rel, why: 'absent' }); continue; }
    if (/document\.currentScript/.test(src)) { apart.push({ rel, why: 'currentScript' }); continue; }
    if (!STRICT_PROLOGUE.test(src)) { apart.push({ rel, why: 'sloppy' }); continue; }
    jsParts.push('/* ' + rel + ' */\n' + strip(src));
    jsSet.add(rel);
  }
  for (const rel of css) {
    const abs = path.resolve(frontendDir, rel);
    if (abs.indexOf(frontendDir + path.sep) !== 0) { apart.push({ rel, why: 'outside' }); continue; }
    try { cssParts.push('/* ' + rel + ' */\n' + await fsp.readFile(abs, 'utf8')); cssSet.add(rel); }
    catch (e) { apart.push({ rel, why: 'absent' }); }
  }

  const jsText = jsParts.length ? "'use strict';\n" + jsParts.join('\n;\n') + '\n' : '';
  const cssText = cssParts.join('\n');
  let error = null;
  if (jsText) { try { new vm.Script(jsText, { filename: 'boot-bundle.js' }); } catch (e) { error = e; } }
  return { jsText, cssText, jsSet, cssSet, apart, error, jsCount: jsSet.size, cssCount: cssSet.size };
}

/* Rewrite the page's own tags: the bundled files collapse into one tag at the position of the FIRST one, so the
   remaining (unbundled) tags keep their exact order around them. A bundle that failed to parse is never referenced. */
function applyBootBundle(html, bundle, version, urls) {
  if (!bundle || bundle.error || !bundle.jsSet || !bundle.jsSet.size) return html;
  const q = '?v=' + version;
  const jsUrl = (urls && urls.js) || '/__boot.js';
  const cssUrl = (urls && urls.css) || '/__boot.css';
  let jsDone = false, cssDone = false;
  let out = String(html).replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (tag, u) => {
    const rel = String(u).split('?')[0].replace(/^\/+/, '');
    if (!bundle.jsSet.has(rel)) return tag;
    if (jsDone) return '';
    jsDone = true;
    return '<script src="' + jsUrl + q + '"></script>';
  });
  if (bundle.cssSet && bundle.cssSet.size) {
    out = out.replace(/<link\b[^>]*\bhref="([^"]+)"[^>]*>/g, (tag, u) => {
      const rel = String(u).split('?')[0].replace(/^\/+/, '');
      if (!bundle.cssSet.has(rel)) return tag;
      if (cssDone) return '';
      cssDone = true;
      return '<link rel="stylesheet" href="' + cssUrl + q + '">';
    });
  }
  return out;
}

module.exports = { buildBootBundle, applyBootBundle, bootLinks, STRICT_PROLOGUE };
