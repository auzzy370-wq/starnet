/* frontend/app/insecure-origin.js — the one repair a page served over PLAIN HTTP needs.

   A hosted station is reached at http://<host>:<allocation port>, and a browser calls that origin insecure
   (window.isSecureContext === false). Some APIs are [SecureContext]-only, so there they are ABSENT rather than broken:
   crypto.randomUUID, the async copy API, Web Locks, the media-capture API and crypto.subtle. bootguard.js already
   knows this (it does not read randomUUID's absence as an old engine), but nothing provided it, so the two callers that
   are not typeof-guarded threw: group-chat.js (its uid()) and widgets.js (a placed widget's id). Both are ordinary work
   the Master would expect to succeed.

   So this replaces exactly what can be replaced FAITHFULLY — crypto.randomUUID, on crypto.getRandomValues, which an
   insecure origin does have. Everything else is deliberately left alone:
     - the async copy API: js/util.js U.copyText is the ONE copy owner (see test/clipboard-ack.census.test.js) and
       already falls back to a selection when it is absent;
     - media capture, crypto.subtle (guarded in workstreams.js), Web Locks, service workers: faking any of those would
       turn a visible "this needs https" into a silent wrong answer. Their callers degrade on absence as designed.

   The browser's "Not secure" badge is likewise real, and this file cannot remove it: only a TLS front end can.
*/
(function () {
  'use strict';
  var root = typeof window !== 'undefined' ? window : null;
  if (!root || root.isSecureContext !== false) return;   // secure origin: the real implementation, never shadowed
  try {
    var c = root.crypto;
    if (c && typeof c.randomUUID !== 'function' && typeof c.getRandomValues === 'function') {
      c.randomUUID = function randomUUID() {
        var b = new Uint8Array(16);
        c.getRandomValues(b);
        b[6] = (b[6] & 0x0f) | 0x40;    // version 4
        b[8] = (b[8] & 0x3f) | 0x80;    // RFC 4122 variant
        var h = [];
        for (var i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
        return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') + '-' +
          h.slice(8, 10).join('') + '-' + h.slice(10).join('');
      };
    }
  } catch (_) { /* a frozen crypto object: the guarded callers keep their own fallbacks */ }
})();
