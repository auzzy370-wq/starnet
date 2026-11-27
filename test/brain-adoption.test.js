/* node test/brain-adoption.test.js — a sign-in the STATION holds becomes the brain that runs.

   2026-11-27 user report, from a phone: the station showed "No model is connected yet — add a provider key"
   with the raw "no API key set" while SETTINGS said GROK SIGNED IN. Two mechanisms, both locked here by
   executing the REAL harness.js functions in a sandbox:

     · A device-code sign-in (Grok / ChatGPT / Kimi) is stored on the STATION. The provider pick lives in
       THIS browser's localStorage — so a phone, a second browser or a cleared cache booted on the default
       keyed provider and refused every run, though the sign-in was live. When the pick cannot run from here
       and a sign-in can, it takes over (with a model from its own catalog, because a model slug belongs to
       its provider). A pick that CAN run is never touched, and a station-held key still counts as "can run".
     · The chat() pre-flight checked ONLY this browser's storage, so a station whose /api/providers said the
       provider was ready (it keeps its own copy of every key — #89) still threw "no API key set". */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const harness = read('frontend', 'app', 'harness.js');
const appjs = read('frontend', 'app', 'app.js');
const station = read('frontend', 'app', 'stationui.js');

const FROM = '  /* A RUN DOES NOT NEED A KEY IN THIS WINDOW WHEN THE STATION HOLDS ONE';
const TO = '  /* #89 THE STATION KEEPS A COPY.';
const i0 = harness.indexOf(FROM), i1 = harness.indexOf(TO, i0 + 1);
A.ok(i0 >= 0 && i1 > i0, 'harness.js still has the adoption block');
const block = harness.slice(i0, i1);

const registry = require('../frontend/app/provider-registry.js');
const CATALOG = { grok: ['grok-4.3', 'grok-4'], codex: ['gpt-5.5-codex', 'gpt-5.5'], kimi: ['kimi-for-coding', 'k3'] };

function world(opts) {
  opts = opts || {};
  const state = {
    prov: opts.prov || 'openrouter',
    model: opts.model || 'anthropic/claude-sonnet-5',
    keys: opts.keys || {}, ready: opts.ready || {}, sets: [], fetches: 0
  };
  const scope = {
    JSON, Promise, Array, String, Object, Math, Error,
    normalizeProviderId: p => registry.normalizeProviderId(p || '', ''),
    getKey: p => state.keys[p] || '',
    readiness: p => ({ unattendedReady: !!state.ready[p] }),
    getProv: () => state.prov,
    setProv: p => { state.prov = p; state.sets.push(p); },
    getModel: () => state.model,
    setModel: m => { state.model = m; },
    fetch: async url => {
      state.fetches++;
      if (opts.fetchThrows) throw new TypeError('Failed to fetch');
      const ids = CATALOG[String(url).split('/')[3]] || [];
      return { ok: true, json: async () => ({ default: ids[ids.length - 1], models: ids.map(id => ({ id })) }) };
    }
  };
  scope.SK = { providers: { registry } };
  const api = vm.runInNewContext(block + '\n({ runnableFromHere, adoptSignedInProvider })', scope);
  return { api, state };
}

(async () => {
  /* ---- what "can run from here" means ---- */
  {
    const w = world({ ready: { grok: true } });
    A.ok(w.api.runnableFromHere('grok'), 'a station-held sign-in makes its provider runnable');
    A.ok(!w.api.runnableFromHere('openrouter'), 'a keyed provider with no key anywhere is not runnable');
    const k = world({ keys: { openrouter: 'sk-or-1' } });
    A.ok(k.api.runnableFromHere('openrouter'), 'this browser’s own key is a credential');
    A.ok(!k.api.runnableFromHere(''), 'no provider is not runnable');
  }

  /* ---- the reported case: phone boots on openrouter, Grok is signed in ---- */
  {
    const w = world({ ready: { grok: true } });
    const r = await w.api.adoptSignedInProvider();
    A.eq(r, { provider: 'grok', model: 'grok-4', changed: true }, 'a fresh browser adopts the live Grok sign-in');
    A.eq(w.state.prov, 'grok', 'the pick is persisted for this browser (Harness.setProv)');
    A.eq(w.state.model, 'grok-4', 'the model comes from the sign-in’s own catalog (a foreign slug is not sent to xAI)');
  }

  /* ---- a brain that CAN run is never switched out from under the Commander ---- */
  {
    const w = world({ keys: { openrouter: 'sk-or-1' }, ready: { grok: true } });
    A.eq(await w.api.adoptSignedInProvider(), { provider: 'openrouter', changed: false }, 'a page-held key keeps the pick');
    A.eq(w.state.prov, 'openrouter', 'no silent switch');
    A.eq(w.state.fetches, 0, 'and no catalog fetch at all');
  }
  {
    // #89: the station keeps its own copy of a saved key, so "the station can run it" is enough
    const w = world({ ready: { openrouter: true, grok: true } });
    A.eq((await w.api.adoptSignedInProvider()).changed, false, 'a station-held key is a working brain — the sign-in does not outrank it');
  }

  /* ---- nothing to adopt: today’s honest behaviour is unchanged ---- */
  {
    const w = world({});
    A.eq(await w.api.adoptSignedInProvider(), { provider: 'openrouter', changed: false }, 'no live sign-in, no adoption');
    A.eq(w.state.prov, 'openrouter', 'the pick is left alone');
  }

  /* ---- the card that was just signed in wins over the default order ---- */
  {
    const w = world({ ready: { grok: true, codex: true } });
    A.eq((await w.api.adoptSignedInProvider('codex')).provider, 'codex', 'the provider signed in on the card is preferred');
    const g = world({ ready: { grok: true, codex: true } });
    A.eq((await g.api.adoptSignedInProvider('grok')).provider, 'grok', 'and so is Grok when its card was the one');
  }

  /* ---- an already-valid model slug is left exactly as the Commander had it ---- */
  {
    const w = world({ ready: { grok: true }, model: 'grok-4' });
    await w.api.adoptSignedInProvider();
    A.eq(w.state.model, 'grok-4', 'a slug from the provider’s catalog is not replaced');
  }

  /* ---- a catalog that cannot be read never blocks the adoption (the sign-in is still the best brain) ---- */
  {
    const w = world({ ready: { grok: true }, fetchThrows: true });
    const r = await w.api.adoptSignedInProvider();
    A.eq(r, { provider: 'grok', model: 'anthropic/claude-sonnet-5', changed: true }, 'an unreachable catalog still adopts the sign-in');
    A.eq(w.state.model, 'anthropic/claude-sonnet-5', 'and does not invent a model');
  }

  /* ---- the two call sites and the honest guard ---- */
  A.ok(/!key && !runnableFromHere\(provider\)\) throw new Error\('no API key set'\)/.test(harness),
    'chat() only refuses a keyless page when the station cannot run the provider either');
  A.ok(/runnableFromHere, adoptSignedInProvider,/.test(harness), 'Harness exports both helpers');
  A.ok(/Harness\.adoptSignedInProvider\(\)/.test(appjs) && /saved\.agent\.provider = adopted\.provider/.test(appjs)
    && /saved\.agent\.model = adopted\.model/.test(appjs),
    'boot adopts before the resume decision and writes the provider AND its model into the station’s own truth');
  A.ok(/Harness\.adoptSignedInProvider\(pid\)/.test(station) && /App\.agentConfig\.setModel\(App\.heroId\(\), r\.model, r\.provider\)/.test(station),
    'a card sign-in that completed adopts the provider it just connected, model pin included');

  A.report('brain adoption');
})();
