'use strict';
/* SOMETHING THE PHONE DOES NOT HAVE TO DOWNLOAD (2026-11-27).
   The boot set is 9.7 MB of source and 2.78 MB of it over the wire with gzip, which is the last thing between a cold
   load and "instant". esbuild's transform — per file, no bundling, and top-level names left alone because a classic
   script's top level IS the global scope — takes out whitespace, redundant syntax and nested local names: measured
   2.78 MB -> 1.81 MB gzip for the JS and 0.39 MB -> 0.18 MB for the CSS.

   esbuild is an ACCELERATOR, never a requirement: if it is not installed, every call returns null and the boot set is
   served exactly as it was before this module existed. Nothing here can fail a boot. */
let esbuild = null;
let loadTried = false;

function load() {
  if (loadTried) return esbuild;
  loadTried = true;
  try { esbuild = require('esbuild'); } catch (e) { esbuild = null; }
  return esbuild;
}

/* A minifier for the boot set, or null. `js(text)` / `css(text)` return the smaller source, or null when esbuild is
   missing or refuses the text — a caller that gets null keeps what it already had. */
function makeMinifier() {
  const es = load();
  if (!es || typeof es.transformSync !== 'function') return null;
  const run = (text, loader) => {
    if (!text) return null;
    try {
      const out = es.transformSync(text, { minify: true, loader, legalComments: 'none' });
      return out && out.code ? out.code : null;
    } catch (e) { return null; }
  };
  return { js: (text) => run(text, 'js'), css: (text) => run(text, 'css'), name: 'esbuild-' + (es.version || '?') };
}

module.exports = { makeMinifier };
