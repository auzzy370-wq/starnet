'use strict';
/* COMMENT-ONLY SOURCE TRIM (2026-11-25): the station's `frontend/` JS is written comment-first (explanations of
   *why* above nearly every block), which is 24% of its 12.5 MiB. The browser pays for every one of those bytes three
   times on a phone: the download, the tokenizer, and the parse/compile. Dropping comments on the wire is exactly the
   "minify, don't rewrite" trade: code bytes are copied through VERBATIM, so nothing the engine sees changes except
   the comments it would have skipped anyway — and line numbers are preserved (a removed line becomes an empty line)
   so stack traces still point at the same source line in the file on disk.
 *
 * Deliberately NOT a minifier and not a general tokenizer. It only touches a comment whose opener is the first
 * non-whitespace on its line, and for a block comment only when nothing but whitespace follows its closer on the same
 * line. That rule removes the whole class of lexer ambiguity: a `//` after code is never examined, so a division, a
 * regex literal, or a string containing `//` can never be mistaken for a comment. Inside template literals (and their
 * `${...}` interpolations) the source is copied with no stripping at all — template text is data, not code.
 *
 * Verification (2026-11-25): all 282 boot scripts of frontend/index.html were stripped and re-compiled with
 * `new vm.Script()` — 282/282 compile, 12.51 MiB -> 9.50 MiB raw, 4.13 MiB -> 2.86 MiB gzip per file. */

// Lexer states inside a template literal. `tpl` copies template text (and nested `${}` contents) verbatim.
const TEMPLATE_TEXT = 1, TEMPLATE_EXPR = 2;

function stripJsComments(src) {
  const n = src.length;
  const out = [];
  const stack = [];                    // [{ kind, depth }] for template tags; empty outside a template
  let i = 0;
  let lineOnlyWhitespace = true;       // nothing but whitespace seen since the last newline

  while (i < n) {
    const c = src[i];

    if (stack.length) {                                   // inside a template literal: copy, never strip
      if (c === '\\') { out.push(src.slice(i, i + 2)); i += 2; continue; }
      const top = stack[stack.length - 1];
      if (top.kind === TEMPLATE_TEXT) {
        if (c === '`') { stack.pop(); out.push(c); i++; lineOnlyWhitespace = false; continue; }
        if (c === '$' && src[i + 1] === '{') { stack.push({ kind: TEMPLATE_EXPR, depth: 0 }); out.push('${'); i += 2; lineOnlyWhitespace = false; continue; }
        out.push(c); if (c === '\n') lineOnlyWhitespace = true; i++; continue;
      }
      if (c === '`') { stack.push({ kind: TEMPLATE_TEXT }); out.push(c); i++; lineOnlyWhitespace = false; continue; }
      if (c === '{' || c === '(' || c === '[') top.depth++;
      else if (c === ')' || c === ']') top.depth--;
      else if (c === '}') {
        if (top.depth === 0) { stack.pop(); out.push(c); i++; lineOnlyWhitespace = false; continue; }
        top.depth--;
      }
      out.push(c);
      if (c === '\n') lineOnlyWhitespace = true; else if (!/\s/.test(c)) lineOnlyWhitespace = false;
      i++; continue;
    }

    if (c === "'" || c === '"') {                          // string literal: copy through its closing quote
      const q = c;
      out.push(c); i++;
      while (i < n) {
        const d = src[i];
        if (d === '\\') { out.push(src.slice(i, i + 2)); i += 2; continue; }
        out.push(d); i++;
        if (d === q) break;
      }
      lineOnlyWhitespace = false; continue;
    }
    if (c === '`') { stack.push({ kind: TEMPLATE_TEXT }); out.push(c); i++; lineOnlyWhitespace = false; continue; }

    if (c === '/' && src[i + 1] === '/' && lineOnlyWhitespace) {   // whole-line `//` comment
      while (i < n && src[i] !== '\n') i++;                        // the newline itself is copied next pass
      continue;
    }
    if (c === '/' && src[i + 1] === '*' && lineOnlyWhitespace) {   // whole-line block comment
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      const end = Math.min(j + 2, n);
      let trailingOnlyWhitespace = true;
      for (let p = end; p < n && src[p] !== '\n'; p++) { if (!/\s/.test(src[p])) { trailingOnlyWhitespace = false; break; } }
      if (j < n && trailingOnlyWhitespace) {                       // keep the line count (stack traces) intact
        const newlines = src.slice(i, end).split('\n').length - 1;
        if (newlines) out.push('\n'.repeat(newlines));
        i = end; continue;
      }
      out.push('/*'); i += 2; lineOnlyWhitespace = false; continue; // comment shares its line with code: leave it
    }

    out.push(c); i++;
    if (c === '\n') lineOnlyWhitespace = true;
    else if (!/\s/.test(c)) lineOnlyWhitespace = false;
  }
  return out.join('');
}

module.exports = { stripJsComments };
