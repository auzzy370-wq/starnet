/* frontend/app/mobile.js — PHONE INPUT: the station canvas takes touch.

   world.js binds the camera to MOUSE events only (mousedown/mousemove/mouseup/wheel). On a touch screen
   none of those fire, so the Commander can see the station but cannot move it: no pan, no zoom, and a
   single-finger drag scrolls the page instead. This module translates real touch gestures into the exact
   events world.js already handles, so the camera code stays the single owner of pan/zoom state:

     one finger drag   -> mousedown / mousemove / mouseup   (world.js pans past its 4px click threshold)
     two finger pinch  -> wheel at the pinch midpoint      (world.js: scale *= exp(-deltaY * 0.0015))
     two finger drag   -> mousemove with both fingers down (world.js pans; the pinch also feeds zoom)

   Tap-to-interact is untouched: world.js only treats a press as a pan once it travels, so props, bays and
   boards still take a plain tap, and the browser's synthetic click still arrives because we never
   preventDefault a gesture that did not move.

   Also marks body.is-phone for css/mobile.css so the phone layout only applies where it is wanted. */

(function () {
  'use strict';

  const PHONE_MQ = '(max-width: 720px)';
  let mq = null;
  try { mq = window.matchMedia(PHONE_MQ); } catch (_) { mq = null; }

  function syncPhoneClass() {
    const on = !!(mq && mq.matches);
    try { document.body.classList.toggle('is-phone', on); } catch (_) {}
  }
  syncPhoneClass();
  if (mq) {
    if (mq.addEventListener) mq.addEventListener('change', syncPhoneClass);
    else if (mq.addListener) mq.addListener(syncPhoneClass);
  }

  const cv = document.getElementById('stage');
  if (!cv) return;

  /* The browser must not claim these gestures: no scroll, no double-tap zoom, no rubber-banding over the map. */
  try { cv.style.touchAction = 'none'; } catch (_) {}

  const mouse = (type, x, y, buttons) => {
    cv.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, button: 0, buttons: buttons == null ? 1 : buttons
    }));
  };

  /* One wheel notch of 0 deltaY is one zoom step as world.js defines it: scale *= exp(-deltaY * 0.0015).
     A pinch from distance d0 to d1 asks for a factor of d1/d0, so deltaY = -ln(factor) / 0.0015. */
  const pinchWheel = (x, y, factor) => {
    const deltaY = -Math.log(factor) / 0.0015;
    cv.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, deltaY: deltaY, deltaMode: 0
    }));
  };

  let dragging = false;      // a synthetic mouse press is down
  let last = null;           // {x, y} of the last single-finger point
  let pinch = null;          // {d0, x, y} start distance + midpoint
  let moved = 0;             // cumulative travel, so a tap stays a tap

  function pointOf(t) { return { x: t.clientX, y: t.clientY }; }
  function distance(a, b) { return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
  function midpoint(a, b) { return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }; }

  cv.addEventListener('touchstart', ev => {
    if (ev.touches.length === 1) {
      const p = pointOf(ev.touches[0]);
      dragging = true; moved = 0; last = p; pinch = null;
      mouse('mousedown', p.x, p.y);
      return;
    }
    if (ev.touches.length === 2) {
      // hand the camera from a pan to a pinch: close the synthetic press first so world.js is not
      // mid-drag when the zoom events arrive (its wheel handler releases any drag lock anyway).
      if (dragging) { const p = last || pointOf(ev.touches[0]); mouse('mouseup', p.x, p.y, 0); dragging = false; last = null; }
      const m = midpoint(ev.touches[0], ev.touches[1]);
      pinch = { d0: Math.max(1, distance(ev.touches[0], ev.touches[1])), x: m.x, y: m.y };
      ev.preventDefault();
    }
  }, { passive: false });

  cv.addEventListener('touchmove', ev => {
    if (ev.touches.length === 2 && pinch) {
      const d = Math.max(1, distance(ev.touches[0], ev.touches[1]));
      const m = midpoint(ev.touches[0], ev.touches[1]);
      const factor = d / pinch.d0;
      if (Math.abs(factor - 1) > 0.01) {
        pinchWheel(m.x, m.y, factor);
        pinch.d0 = d;                 // incremental: each move asks for the change since the last frame
        pinch.x = m.x; pinch.y = m.y;
      }
      ev.preventDefault();
      return;
    }
    if (ev.touches.length === 1 && dragging) {
      const p = pointOf(ev.touches[0]);
      if (last) moved += Math.hypot(p.x - last.x, p.y - last.y);
      last = p;
      mouse('mousemove', p.x, p.y);
      // a drag that actually moves the map must not also scroll the page under it
      if (moved > 6) ev.preventDefault();
    }
  }, { passive: false });

  function endTouch(ev) {
    if (ev.touches && ev.touches.length >= 1) {
      // one finger lifted from a pinch: resume a pan from the remaining finger
      if (dragging) { const p = last || pointOf(ev.touches[0]); mouse('mouseup', p.x, p.y, 0); }
      const p = pointOf(ev.touches[0]);
      dragging = true; last = p; pinch = null;
      mouse('mousedown', p.x, p.y);
      return;
    }
    if (dragging) { const p = last || { x: 0, y: 0 }; mouse('mouseup', p.x, p.y, 0); }
    dragging = false; last = null; pinch = null;
  }
  cv.addEventListener('touchend', endTouch, { passive: true });
  cv.addEventListener('touchcancel', ev => {
    if (dragging) { const p = last || { x: 0, y: 0 }; mouse('mouseup', p.x, p.y, 0); }
    dragging = false; last = null; pinch = null;
  }, { passive: true });
})();
