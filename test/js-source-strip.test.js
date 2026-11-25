/* node test/js-source-strip.test.js — the delivery layer's comment trim may only ever remove comments.

   sidecar/jssource.js runs over every .js the station serves (frontend/ is 12.5 MiB of comment-first source, and a
   fifth of it is prose). It is a delivery transform, not a build step: what it emits must mean exactly what the file
   on disk means. So this suite pins the two ways that can go wrong —

     · it removes something that is NOT a comment (a `//` inside a string, a URL, a regex, a template's text), which
       silently changes behaviour instead of failing loudly, and
     · it changes the line layout, so a stack trace from the station points at the wrong source line.

   — and then makes the claim that actually matters on a real tree: every script frontend/index.html boots COMPILES
   after stripping. That loop is the regression test for a lexer change; the cases above say why it should.

   Run: node test/js-source-strip.test.js */

'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const { stripJsComments } = require('../sidecar/jssource.js');

const lines = s => s.split('\n');
const lineOf = (s, needle) => lines(s).findIndex(l => l.includes(needle));

/* ---------- 1. whole-line comments go; everything after code stays ---------- */

A.eq(stripJsComments('// gone\nconst keep = 1;\n'), '\nconst keep = 1;\n',
  'a line comment that starts its line is removed, the code line under it is not');
A.eq(stripJsComments('const keep = 1; // trailing stays\n'), 'const keep = 1; // trailing stays\n',
  'a trailing // comment is left alone — that is the one place a lexer could mistake division for a regex');
A.eq(stripJsComments('// a comment with "quotes", `backticks` and \'apostrophes\'\nconst ok = 1;\n'), '\nconst ok = 1;\n',
  'quotes inside a removed comment never open a string');
A.eq(stripJsComments('/* ` */\nconst ok = 1;\n'), '\nconst ok = 1;\n',
  'a backtick inside a removed block comment never opens a template');
A.eq(stripJsComments('/*\n * why\n */\nconst keep = 2;\n'), '\n\n\nconst keep = 2;\n',
  'a block comment on its own lines is removed and its newlines survive it');
A.eq(stripJsComments('const a = 1; /* inline */\n'), 'const a = 1; /* inline */\n',
  'a block comment that shares a line with code is kept — removing it could join two tokens');

/* ---------- 2. strings are data ---------- */

const str = 'const a = "http://x//y";\nconst b = \'/* not a comment */\';\nconst c = "it\\\'s // fine";\n';
A.eq(stripJsComments(str), str, 'comment markers inside string literals are data, escaped quotes included');

/* ---------- 3. template literals are data (text and ${} both) ---------- */

const tpl = 'const t = `\n  // template text, not a comment\n  /* nor this */\n  ${a /* untouched */ + 1}\n`;\n';
A.eq(stripJsComments(tpl), tpl, 'template text and its ${} interpolation are copied verbatim');

const nested = 'const n = `x ${`y ${z} // still template`} // tail`;\n';
A.eq(stripJsComments(nested), nested, 'nested templates inside an interpolation keep their text');

const after = 'const t = `x`;\n// gone\nconst u = 2;\n';
A.eq(stripJsComments(after), 'const t = `x`;\n\nconst u = 2;\n',
  'a template closing does not swallow the comment on the line after it');

/* ---------- 4. regex literals are data ---------- */

const re = 'const re = /a\\/\\/b/g;\nconst re2 = /\\/*x/;\nconst q = a / b; // trailing\n';
A.eq(stripJsComments(re), re, 'a regex containing // or /* is not a comment, and division keeps its trailing comment');

/* ---------- 5. line numbers survive (stack traces point at the real line) ---------- */

const numbered = '// one\n// two\nconst mark = 3;\n/*\n three\n*/\nconst afterward = 4;\n';
const stripped = stripJsComments(numbered);
A.eq(lines(stripped).length, lines(numbered).length, 'the stripped file has the same number of lines');
A.eq(lineOf(stripped, 'const mark'), 2, 'code after two removed line comments keeps its line number');
A.eq(lineOf(stripped, 'const afterward'), 6, 'code after a removed block comment keeps its line number');
A.eq(stripJsComments(stripped), stripped, 'stripping twice changes nothing (idempotent)');

/* ---------- 6. every boot script still compiles, and the trim actually pays ---------- */

const html = fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]);
A.ok(scripts.length > 200, 'index.html boots the station as many separate scripts (' + scripts.length + ')');

// /shared/specialties.js is served from the repo's shared/ tree, everything else from frontend/
const resolve = (src) => {
  const clean = src.replace(/^\/+/, '');
  const inFrontend = path.join(ROOT, 'frontend', clean);
  return fs.existsSync(inFrontend) ? inFrontend : path.join(ROOT, clean);
};

let rawBytes = 0, strippedBytes = 0;
const uncompilable = [], lineDrift = [], missing = [];
for (const src of scripts) {
  const file = resolve(src);
  if (!fs.existsSync(file)) { missing.push(src); continue; }
  const raw = fs.readFileSync(file, 'utf8');
  const out = stripJsComments(raw);
  rawBytes += Buffer.byteLength(raw);
  strippedBytes += Buffer.byteLength(out);
  if (lines(out).length !== lines(raw).length) lineDrift.push(src);
  try { new vm.Script(out, { filename: src }); }
  catch (e) { uncompilable.push(src + ': ' + e.message); }
}
A.eq(missing.length, 0, 'every script index.html names exists on disk: ' + missing.join(', '));
A.eq(lineDrift.length, 0, 'no boot script loses a line: ' + lineDrift.slice(0, 5).join(', '));
A.eq(uncompilable.length, 0, 'every boot script still compiles after stripping: ' + uncompilable.slice(0, 3).join(' | '));
A.ok(strippedBytes < rawBytes * 0.9,
  'stripping actually shrinks the boot set (' + rawBytes + ' -> ' + strippedBytes + ' bytes)');

A.report('js source strip');
