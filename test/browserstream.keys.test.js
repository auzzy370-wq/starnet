/* node test/browserstream.keys.test.js — keyboard into the live BROWSER picture (frontend/app/browserstream.js).
   Release review 2026-09-30:
     - AltGr characters (@ { } € on German/French keyboards) arrive as Ctrl+Alt on Windows and were never sent as text,
       so an email address could not be typed into a sign-in page;
     - the picture captured Tab/Esc even while an agent drove (every key refused anyway): a keyboard trap;
     - F6 / Ctrl+L leave the page for the address bar, like any browser. */
'use strict';
const A = require('./_assert.js');
const BrowserStream = require('../frontend/app/browserstream.js');

function target() {
  const ls = {};
  return { ls, addEventListener: (ev, fn) => { (ls[ev] = ls[ev] || []).push(fn); }, focus: () => {},
    fire(ev, e) { (ls[ev] || []).forEach(fn => fn(e)); } };
}
function key(k, o) {
  o = o || {};
  const e = { key: k, code: o.code || '', keyCode: 0, ctrlKey: !!o.ctrl, altKey: !!o.alt, metaKey: false, shiftKey: !!o.shift,
    prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; },
    getModifierState: m => (m === 'AltGraph' ? !!o.altGraph : false) };
  return e;
}

(async () => {
  const vp = target(), img = target();
  const sent = [];
  let can = true, left = 0;
  const s = BrowserStream.create({ vp, img,
    poll: () => new Promise(() => {}),   // the picture never matters here
    send: evs => { sent.push(...evs); return Promise.resolve({ status: 200 }); },
    canType: () => can, onLeave: () => { left++; } });
  s.start();
  const lastDown = () => sent.filter(e => e.type === 'key' && e.action === 'down').slice(-1)[0];
  const tick = () => new Promise(r => setTimeout(r, 5));

  vp.fire('keydown', key('a')); await tick();
  A.eq(lastDown().text, 'a', 'a plain key is text');
  vp.fire('keydown', key('@', { ctrl: true, alt: true, altGraph: true, code: 'KeyQ' })); await tick();
  A.eq(lastDown().text, '@', 'AltGr+Q on a German keyboard sends "@" as TEXT');
  A.eq(lastDown().modifiers & 3, 0, '…without Ctrl/Alt modifiers (or the page would treat it as a shortcut)');
  vp.fire('keydown', key('€', { ctrl: true, alt: true, code: 'KeyE' })); await tick();
  A.eq(lastDown().text, '€', 'Ctrl+Alt reporting a symbol (no AltGraph state) is still text');
  vp.fire('keydown', key('@', { alt: true, code: 'KeyL' })); await tick();
  A.eq(lastDown().text, '@', 'macOS Option+L on a German Mac sends "@" as TEXT');
  A.eq(lastDown().modifiers & 1, 0, '…without the Option modifier');
  vp.fire('keydown', key('å', { alt: true, code: 'KeyA' })); await tick();
  A.eq(lastDown().text, 'å', 'Option+A (US Mac) types å');
  vp.fire('keydown', key('c', { ctrl: true, alt: true })); await tick();
  A.eq(lastDown().text, undefined, 'a real Ctrl+Alt+letter shortcut stays a key, not text');

  const tab = key('Tab'); vp.fire('keydown', tab); await tick();
  A.ok(tab.prevented && tab.stopped, 'while you can type, Tab goes to the page (sign-in forms need it)');
  can = false;
  const n = sent.length;
  const tab2 = key('Tab'); vp.fire('keydown', tab2);
  const esc = key('Escape'); vp.fire('keydown', esc); await tick();
  A.ok(!tab2.prevented && !tab2.stopped && !esc.prevented && !esc.stopped, 'while an agent drives, Tab and Esc are NOT trapped — they move on in the station');
  A.eq(sent.length, n, '…and nothing is sent');
  const f6 = key('F6'); vp.fire('keydown', f6);
  const ctrlL = key('l', { ctrl: true }); vp.fire('keydown', ctrlL);
  A.eq(left, 2, 'F6 and Ctrl+L leave the page for the address bar');
  can = true;
  const f6b = key('F6'); vp.fire('keydown', f6b);
  A.eq(left, 3, '…even while you are typing in the page');
  s.stop();

  /* A PHONE (2026-11-27, "can't type in browser when on phone"): its keyboard only appears for a real text field, so the
     picture carries one. Tapping focuses it, and what it receives is sent as text — once, never twice. */
  {
    const vp2 = target(), img2 = target();
    const kbd = target();
    kbd.value = '';
    let focused = 0; kbd.focus = () => { focused++; };
    const out = [];
    const s2 = BrowserStream.create({ vp: vp2, img: img2, kbd,
      poll: () => new Promise(() => {}),
      send: evs => { out.push(...evs); return Promise.resolve({ status: 200 }); } });
    s2.start();
    vp2.fire('pointerdown', key(''));
    A.eq(focused, 1, 'a tap on the picture focuses the text field (that is what raises a phone keyboard)');
    kbd.value = 'hello';
    kbd.fire('input', {});
    await tick();
    A.eq(out.filter(e => e.type === 'text').map(e => e.text).join(''), 'hello', 'what the phone keyboard types reaches the page as text');
    A.eq(kbd.value, '', '…and the field is emptied, so the next letter is not a repeat of the last');
    kbd.value = 'x';
    kbd.fire('input', {}); await tick();
    A.eq(out.filter(e => e.type === 'text').length, 2, 'each input event sends its own text once');
    s2.stop();
  }
  /* A CLICK ON A DESKTOP (reported 2026-11-27: "the browser is slow and I can't click anywhere and type"). One
     gesture is one request (it used to be move, press and release as three round trips); it maps through the picture
     into the page's own 1440x900 space; and a picture whose stream stopped no longer eats the click — the click brings
     it back. */
  {
    const vp3 = target(), img3 = target();
    img3.setAttribute = () => {};
    img3.getBoundingClientRect = () => ({ left: 0, top: 0, width: 720, height: 450 });
    img3.naturalWidth = 1440; img3.naturalHeight = 900;
    const calls = []; let polls = 0;
    const s3 = BrowserStream.create({ vp: vp3, img: img3,
      poll: () => { polls++; return polls === 1 ? Promise.resolve({ status: 200, body: { ok: true, frame: { seq: 1, mime: 'image/jpeg', width: 1440, height: 900, data: 'x' } } }) : new Promise(() => {}); },
      send: evs => { calls.push(evs.slice()); return Promise.resolve({ status: 200 }); } });
    s3.start();
    await tick(); await tick();
    const md = { clientX: 360, clientY: 225, button: 0, detail: 1, preventDefault() {} };
    img3.fire('mousedown', md); await tick();
    A.eq(calls.length, 1, 'a click is ONE request, not one per event');
    A.eq(calls[0].map(e => e.type + ':' + e.action).join(','), 'mouse:move,mouse:down', 'the move and the press go together');
    A.eq(calls[0][1].x + ',' + calls[0][1].y, '720,450', 'the middle of the picture is the middle of the 1440x900 page');
    img3.fire('mouseup', md); await tick();
    A.eq(calls.length, 2, 'the release follows in its own request');
    s3.stop();
    const before = polls;
    img3.fire('mousedown', md); await tick();
    A.ok(polls > before, 'a click on a picture whose stream stopped brings the stream back');
    A.eq(calls.length, 3, '…and that click is still sent instead of being thrown away');
    s3.stop();
  }
  /* A CLICK THAT MEETS A BUSY STATION IS SENT AGAIN (measured 2026-11-27: a cold station page answers bursts of requests
     with 429, which is "busy" — the station did nothing yet, so the same batch is safe to repeat; anything else is a
     real answer and must never be repeated, or one click becomes two). */
  {
    const vp4 = target(), img4 = target();
    img4.setAttribute = () => {};
    img4.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1440, height: 900 });
    img4.naturalWidth = 1440; img4.naturalHeight = 900;
    let n = 0; const sent = [];
    const s4 = BrowserStream.create({ vp: vp4, img: img4,
      poll: () => (++n === 1 ? Promise.resolve({ status: 200, body: { ok: true, frame: { seq: 1, mime: 'image/jpeg', width: 1440, height: 900, data: 'x' } } }) : new Promise(() => {})),
      send: evs => { sent.push(evs.map(e => e.type + ':' + e.action).join(',')); return Promise.resolve({ status: sent.length === 1 ? 429 : 200 }); } });
    s4.start();
    await tick(); await tick();
    img4.fire('mousedown', { clientX: 10, clientY: 10, button: 0, detail: 1, preventDefault() {} });
    await new Promise(r => setTimeout(r, 450));
    A.eq(sent.length, 2, 'a click the station answered as busy (429) is sent again');
    A.eq(sent[1], 'mouse:move,mouse:down', '…with the same events, not a new gesture');
    s4.stop();
  }
  A.report('browserstream.keys.test');
})().catch(e => { console.log('FAIL: browserstream.keys.test threw — ' + (e && e.stack || e)); process.exit(1); });
