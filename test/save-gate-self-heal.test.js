'use strict';
/* node test/save-gate-self-heal.test.js — the save gate must recover from a station restart on its own.

   A restarted engine mints a new per-launch key, and an open page still carries the old one, so its save pull
   is refused for as long as that document lives. Before this, the gate only reloaded on a DEFINITIVE answer —
   which a stale-key page can never reach — so a hosted station sat on SAVE-NET until somebody reloaded by hand.

   What has to stay true, and is pinned here:
     - a stale-key ('forbidden') or dropped ('unreachable') answer self-heals by reloading when the door answers,
     - it is rate-limited and bounded, so a genuinely broken station cannot become a reload loop,
     - it NEVER reloads when the station is still down, when the save is genuinely unreadable, or under the
       desktop shell (which owns restarts itself).
*/
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const A = require('./_assert.js');
const { fnBody } = A;

const appSrc = fs.readFileSync('frontend/app/app.js', 'utf8');
const source = fnBody(appSrc, 'function showSaveUnreachableGate');
const escAlias = (/^  const esc = [^\n]*;$/m.exec(appSrc) || [])[0];
A.ok(escAlias && escAlias.includes('U.esc('), 'app.js still defines the module-level esc alias over the one U.esc owner');
const tick = () => new Promise(r => setImmediate(r));

function boot({ reason = 'forbidden', door = true, desktop = false, clock = { now: 1_000_000 } } = {}) {
  const nodes = new Map();
  const el = id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', innerHTML: '', hidden: false, disabled: false, onclick: null }); return nodes.get(id); };
  const store = new Map();
  const seen = { reloads: 0 };
  const ctx = {
    el, gateActive: false, World: { stop() {} }, SFX: { click() {} },
    tauriCore: () => (desktop ? { invoke() {} } : null), show() {},
    setInterval: () => 1, clearInterval() {}, setTimeout() {},
    Save: { load: () => null },
    location: { reload() { seen.reloads++; } },
    Date: { now: () => clock.now },
    sessionStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    fetch: async () => { if (!door) throw new Error('door down'); return { ok: true }; },
    Harness: { engineState: async () => ({ reason: '' }) },
    CloudSave: { reconcile: async () => ({ unknown: true, reason }), isUnknownSentinel: r => !!r && r.unknown === true },
    Diag: { copy(o) { o.onDone(true, 'fixture'); } }
  };
  require('./helpers/frontend-esc.js').installEsc(ctx);
  vm.runInNewContext(escAlias + '\n' + source + ';showSaveUnreachableGate("' + reason + '")', ctx);
  const retry = async () => { el('btn-unreachable-retry').onclick(); await tick(); await tick(); };
  return { ctx, el, retry, seen, clock, store };
}

(async () => {
  // 1. a restarted station: stale key, door answering → the page reloads itself
  const live = boot({ reason: 'forbidden' });
  await tick();
  await live.retry();
  assert.equal(live.seen.reloads, 1, 'a stale key with a live door reloads the page instead of stranding it');
  assert.match(live.el('unreachable-status').textContent, /reloading to pick up its new key/, 'the status says what it is doing');

  // 2. rate limit: the same second cannot reload again (no loop from a fast retry)
  await live.retry();
  assert.equal(live.seen.reloads, 1, 'a second attempt inside the gap window does not reload again');

  // 3. next window → one more, and the budget is counted in sessionStorage (survives the reload)
  live.clock.now += 16000;
  await live.retry();
  assert.equal(live.seen.reloads, 2, 'after the gap a further attempt reloads once');
  assert.equal(JSON.parse(live.store.get('vultron.gate.selfheal')).n, 2, 'the reload budget persists across the reload');

  // 4. bounded: it stops, and leaves the manual controls
  for (let i = 0; i < 8; i++) { live.clock.now += 16000; await live.retry(); }
  assert.equal(live.seen.reloads, 6, 'self-heal gives up after its budget instead of reloading forever');
  assert.equal(live.el('btn-unreachable-retry').disabled, false, 'the manual retry stays available after the budget is spent');

  // 5. a station that is still down must NOT reload (nothing to pick up; the 5s retry is the honest path)
  const down = boot({ reason: 'unreachable', door: false });
  await tick();
  await down.retry();
  assert.equal(down.seen.reloads, 0, 'no reload while the door is not answering');

  // 6. a genuinely unreadable save must NOT reload (reloading cannot heal a station file)
  const unreadable = boot({ reason: 'unreadable' });
  await tick();
  await unreadable.retry();
  assert.equal(unreadable.seen.reloads, 0, 'SAVE-READ keeps the retry, never a reload loop');

  // 7. desktop: the shell owns restarts, the gate must never reload under it
  const desktop = boot({ reason: 'forbidden', desktop: true });
  await tick();
  await desktop.retry();
  assert.equal(desktop.seen.reloads, 0, 'the desktop shell keeps its RESTART STATION SERVICE exit');

  // 8. a working station clears the budget so a later restart starts fresh
  const recovered = boot({ reason: 'forbidden' });
  await tick();
  await recovered.retry();
  assert.equal(recovered.seen.reloads, 1, 'first stale-key attempt reloads');
  recovered.ctx.CloudSave.isUnknownSentinel = () => false;      // the pull now proves a real save
  recovered.ctx.CloudSave.reconcile = async () => ({ schema: 'vultron.save' });
  recovered.clock.now += 16000;
  await recovered.retry();
  assert.equal(recovered.seen.reloads, 2, 'a definitive answer still reloads into the station');
  assert.equal(recovered.store.has('vultron.gate.selfheal'), false, 'and clears the reload budget for the next restart');

  A.report('save gate self-heal: reload on a restarted station, bounded, never while down or under the shell');
})().catch(e => { console.error(e); process.exitCode = 1; });
