#!/usr/bin/env node
/* deploy/enzonic/selftest.js — one box-side answer to one question: can the configured model provider actually run an
   agent turn with tool calling?

   The station runs on an allocation port that cannot be reached from outside, and this image has no shell (the panel
   client API has no console-read), so the only place a check like this can run is inside the boot chain. entry.js calls
   it only while ~/vultron-data/selftest.json exists and deletes that file afterwards, so a normal boot pays nothing.

   Three layers, cheapest first, each one enough to call the provider unfit on its own:

     1. STATION  — the station's own probe, with the page's token, so the endpoint it resolves comes from the same
                   providerRuntimeBaseUrl() the agent loop uses (not from anything this file believes).
     2. TOOLS    — one chat request carrying a function schema. An OpenAI-compatible endpoint that ignores or refuses
                   `tools` returns prose instead of tool_calls, and every agent turn ends there.
     3. TURN     — a real POST /api/run, streamed, logged as a shape rather than a transcript.

   The verdict is written to boot.log (readable in the panel's File Manager) and nothing else. Keys are never logged.
*/
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TOOLS = [{
  type: 'function',
  function: {
    name: 'fs_list',
    description: 'List the names of files in a directory on the station.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory to list' } }, required: ['path'] }
  }
}];

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n);

/* The station's environment is the one boot.js built: providers.env merged under the real environment. entry.js's own
   process.env does not have those values, so read the same file here, with the same precedence (environment wins). */
function stationEnv(dataDir) {
  const env = Object.assign({}, process.env);
  const file = path.join(dataDir, 'providers.env');
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (/^[A-Z][A-Z0-9_]*$/.test(k) && v && env[k] === undefined) env[k] = v;
  }
  return env;
}

module.exports = async function selftest({ log, post, open, token, cfg, dataDir }) {
  const say = m => log('SELFTEST ' + m);
  const env = stationEnv(dataDir);
  const model = String((cfg && cfg.model) || 'openai');
  const provider = String((cfg && cfg.provider) || 'custom');
  const prompt = String((cfg && cfg.prompt) || 'Use the fs_list tool to list the files in the current directory, then say what you found in one line.');
  const auth = token ? { 'x-vultron-token': token } : {};

  /* 1 — the station's own view of the provider it would use for an agent turn. */
  try {
    const probed = await post('/api/providers/probe', { provider }, auth, 60000);
    let b = null; try { b = JSON.parse(probed.body); } catch (_) {}
    const models = b && (b.models || b.modelCount || (Array.isArray(b.catalog) ? b.catalog : null));
    say('probe provider=' + provider + ' http=' + probed.status + ' ok=' + !!(b && b.ok !== false)
      + ' models=' + (Array.isArray(models) ? models.length : (models == null ? 'n/a' : models))
      + (b && b.error ? ' error="' + clip(b.error, 180) + '"' : ''));
  } catch (e) {
    say('probe provider=' + provider + ' FAILED ' + e.message);
  }

  /* 2 — tool calling, asked of the endpoint the station resolved, with the station's key rules (CUSTOM is keyless). */
  const base = String(env.CUSTOM_OPENAI_BASE_URL || env.OPENAI_COMPATIBLE_BASE_URL || '').replace(/\/+$/, '');
  if (!base) { say('tools SKIPPED — no CUSTOM_OPENAI_BASE_URL reached the station'); return { toolsOk: false }; }
  const key = env.CUSTOM_OPENAI_KEY || env.OPENAI_COMPATIBLE_KEY || '';
  let toolsOk = false;
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, key ? { Authorization: 'Bearer ' + key } : {}),
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'List the files in the current directory.' }], tools: TOOLS, tool_choice: 'auto', max_tokens: 200 }),
      signal: AbortSignal.timeout(60000)
    });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (_) {}
    const msg = j && j.choices && j.choices[0] && j.choices[0].message;
    const calls = (msg && Array.isArray(msg.tool_calls)) ? msg.tool_calls : [];
    toolsOk = r.ok && calls.length > 0;
    say('tools endpoint=' + base + ' model=' + model + ' http=' + r.status + ' tool_calls=' + calls.length
      + (calls.length ? ' name=' + clip(calls[0].function && calls[0].function.name, 40) + ' args=' + clip(calls[0].function && calls[0].function.arguments, 140) : '')
      + (!toolsOk ? ' body="' + clip(text, 240) + '"' : ''));
  } catch (e) {
    say('tools FAILED ' + e.message);
  }
  if (!toolsOk) { say('VERDICT tools=no — an agent turn cannot run here'); return { toolsOk: false }; }

  /* 3 — a real agent turn through the station, so the answer is not an inference about the adapter. */
  try {
    const run = await open('/api/run', { provider, model, messages: [{ role: 'user', content: prompt }], agentId: 'agent' }, auth, 150000);
    const body = run.body || '';
    say('turn http=' + run.status + ' bytes=' + body.length
      + ' tool=' + /tool/i.test(body) + ' approval=' + /approv/i.test(body) + ' saidError=' + /"error"|error:/i.test(body)
      + ' head="' + clip(body, 300) + '"');
  } catch (e) {
    say('turn FAILED ' + e.message);
  }
  return { toolsOk: true };
};
