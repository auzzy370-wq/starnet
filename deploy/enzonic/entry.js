#!/usr/bin/env node
/* deploy/enzonic/entry.js — paste this file's contents over /index.js in the Enzonic server's File Manager.

   The egg runs exactly one file, /home/container/index.js, with `node`:
       export PORT=${SERVER_PORT}; ... node index.js
   and it keeps /home/container as the app's home. So this shim does the things that have to happen before the
   station can run, then gets out of the way:

     1. clone the branch once into ./starnet (re-cloned if it is missing or broken),
     2. pull on later boots, so a restart is a deploy,
     3. make sure node-pty has a compiled binary (the terminal; see boot.js for why npm 12 needs a nudge),
     4. hand over to deploy/enzonic/boot.js, which owns the data dir, password, port and the engine,
     5. replay the browser's own boot requests from inside the box, because an allocation port cannot be
        reached from most of the internet and `/api/save` is where a hosted station actually breaks.

   It appends to /home/container/boot.log, readable in the File Manager.
*/
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');

const LOG = path.join(__dirname, 'boot.log');
const log = m => fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + m + '\n');
const DIR = path.join(__dirname, 'starnet');
const PW_FILE = path.join(__dirname, 'vultron-data', 'station-password');
const OPEN = fs.existsSync(path.join(__dirname, 'vultron-data', 'OPEN-ACCESS'));
const fd = fs.openSync(LOG, 'a');
const PORT = process.env.PORT || process.env.SERVER_PORT || 8080;
const BRANCH = process.env.VULTRON_BRANCH || 'feat/harness-backend';
const REPO = process.env.VULTRON_REPO || 'https://github.com/auzzy370-wq/starnet.git';

if (!fs.existsSync(path.join(DIR, 'deploy', 'enzonic', 'boot.js'))) {
  if (fs.existsSync(DIR)) { log('removing a partial clone'); fs.rmSync(DIR, { recursive: true, force: true }); }
  log('cloning ' + BRANCH + ' (depth 1)');
  const r = spawnSync('git', ['clone', '--depth', '1', '--branch', BRANCH, REPO, DIR], { stdio: ['ignore', fd, fd] });
  log('clone exit ' + r.status);
  if (r.status !== 0) process.exit(1);
}

// Update path: a restart pulls the branch rather than re-cloning 3.6 GB. Failures are logged and ignored —
// running the previous commit beats refusing to boot.
if (process.env.VULTRON_PULL !== '0') {
  const r = spawnSync('git', ['-C', DIR, 'pull', '--ff-only', 'origin', BRANCH], { stdio: ['ignore', fd, fd] });
  log('pull exit ' + r.status);
}

const ptyCandidates = [
  path.join(DIR, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'),
  path.join(DIR, 'node_modules', 'node-pty', 'build', 'Debug', 'pty.node'),
  path.join(DIR, 'node_modules', 'node-pty', 'prebuilds', process.platform + '-' + process.arch, 'pty.node'),
];
if (!ptyCandidates.some(fs.existsSync)) {
  const nv = (spawnSync('npm', ['-v']).stdout || '').toString().trim();
  const major = parseInt(nv.split('.')[0], 10) || 0;
  const args = ['rebuild', 'node-pty', '--foreground-scripts'].concat(major >= 12 ? ['--dangerously-allow-all-scripts'] : []);
  log('native terminal module absent — npm ' + args.join(' '));
  const r = spawnSync('npm', args, { cwd: DIR, stdio: ['ignore', fd, fd] });
  log('rebuild exit ' + r.status);
}

log('starting the station on port ' + PORT);
const child = spawn(process.execPath, [path.join(DIR, 'deploy', 'enzonic', 'boot.js')], { cwd: DIR, stdio: ['ignore', fd, fd], env: process.env });
child.on('exit', (code, sig) => log('station exited ' + (sig || code)));

/* ---- from here on: prove the app works from inside the box -------------------------------------------- */
const get = (p, headers) => new Promise((res, rej) => {
  const q = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 12000, headers: headers || {} }, r => {
    let body = '';
    r.setEncoding('utf8');
    r.on('data', d => { if (body.length < 500000) body += d; });
    r.on('end', () => res({ status: r.statusCode, body }));
  });
  q.on('error', rej);
  q.on('timeout', () => { q.destroy(); rej(new Error('timeout')); });
});

/* POST, waiting for the whole answer. `/api/run` streams, so this collects the stream rather than parsing events: the
   self-test below reads its SHAPE (did a tool get called, did it ask for approval, did it error), never its prose. */
const post = (p, payload, headers, timeoutMs) => new Promise((res, rej) => {
  const body = JSON.stringify(payload || {});
  let out = '';
  let settled = false;
  let q = null;
  const finish = v => { if (settled) return; settled = true; clearTimeout(deadline); res(v); };
  /* A hard wall-clock deadline, not a socket-idle timeout: `/api/run` streams, and a stream that sends keepalives never
     goes idle, so a socket timeout would wait forever. Whatever arrived by the deadline is enough to judge the shape. */
  const deadline = setTimeout(() => { if (q) q.destroy(); finish({ status: 'deadline', body: out, partial: true }); }, timeoutMs || 60000);
  q = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers || {}) }, r => {
    r.setEncoding('utf8');
    r.on('data', d => { if (out.length < 400000) out += d; });
    r.on('end', () => finish({ status: r.statusCode, body: out }));
  });
  q.on('error', e => { if (settled) return; settled = true; clearTimeout(deadline); rej(e); });
  q.end(body);
});
const open = post;

/* ONE-OFF DIAGNOSTIC. A file beside the station's state asks for it, and it is deleted after the answer is written, so a
   normal boot pays nothing. Used to settle a question about a provider without a shell on the box. */
async function selftest(token) {
  const trigger = path.join(__dirname, 'vultron-data', 'selftest.json');
  if (!fs.existsSync(trigger)) return;
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(trigger, 'utf8')) || {}; } catch (_) { cfg = {}; }
  try {
    await require(path.join(DIR, 'deploy', 'enzonic', 'selftest.js'))({ log, post, open, token, cfg, dataDir: path.join(__dirname, 'vultron-data') });
  } catch (e) { log('SELFTEST crashed ' + e.message); }
  fs.rmSync(trigger, { force: true });
}

/* The page's real boot sequence, in order: load the document, take the per-launch station key out of it, then
   use that key on /api/save (header x-vultron-token, same origin). If any step fails the app shows SAVE-NET
   and the station looks dead even though it is running — so every boot records what each step actually did. */
async function flow() {
  const page = await get('/');
  const m = page.body.match(/__VULTRON_API_TOKEN__=("(?:[^"\\]|\\.)*")/);
  const token = m ? JSON.parse(m[1]) : '';
  const withheld = /__VULTRON_TOKEN_WITHHELD__/.test(page.body);
  log('FLOW page=' + page.status + ' bytes=' + page.body.length + ' token=' + (token ? token.length + ' chars' : 'MISSING') + (withheld ? ' WITHHELD' : ''));
  const t0 = Date.now();
  let save;
  try { save = await get('/api/save', token ? { 'x-vultron-token': token } : {}); }
  catch (e) { log('FLOW /api/save failed after ' + (Date.now() - t0) + 'ms — ' + e.message); return ''; }
  log('FLOW /api/save=' + save.status + ' in ' + (Date.now() - t0) + 'ms ' + JSON.stringify(save.body.slice(0, 160)));
  const bare = await get('/api/save').catch(e => ({ status: 'error ' + e.message }));
  log('FLOW /api/save without token=' + bare.status);
  /* The page's REAL pull carries ?agent= (frontend/app/cloudsave.js) and runs under a timeout, so a station can answer a
     bare /api/save in 13 ms and still park the gate on SAVE-NET. Measure the URL the gate actually uses. */
  const t1 = Date.now();
  const pull = await get('/api/save?agent=agent', token ? { 'x-vultron-token': token } : {}).catch(e => ({ status: 'error ' + e.message, body: '' }));
  log('FLOW /api/save?agent=agent=' + pull.status + ' in ' + (Date.now() - t1) + 'ms ' + JSON.stringify(String(pull.body || '').slice(0, 80)));
  // Proves the box is serving the COMMITTED frontend, not an older checkout: this marker only exists in the
  // build that self-heals the save gate after a restart.
  const js = await get('/app/app.js').catch(e => ({ status: 'error', body: '' }));
  log('FLOW app.js=' + js.status + ' selfHeal=' + /vultron\.gate\.selfheal/.test(js.body));
  return token;
}

(async () => {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    try {
      const health = await get('/api/health');
      const door = await get('/');
      if (OPEN) {
        log('CHECK /api/health=' + health.status + ' /(open, no password)=' + door.status);
        if (health.status === 200 && door.status === 200) {
          const t = await flow().catch(e => { log('FLOW error ' + e.message); return ''; });
          await selftest(t).catch(e => log('SELFTEST error ' + e.message));
          return;
        }
        continue;
      }
      const auth = 'Basic ' + Buffer.from((process.env.VULTRON_SITE_USER || 'vultron') + ':' + fs.readFileSync(PW_FILE, 'utf8').trim()).toString('base64');
      const authed = await get('/', { authorization: auth });
      log('CHECK /api/health=' + health.status + ' /(no auth)=' + door.status + ' /(auth)=' + authed.status);
      if (health.status === 200 && authed.status === 200) {
        const t = await flow().catch(e => { log('FLOW error ' + e.message); return ''; });
        await selftest(t).catch(e => log('SELFTEST error ' + e.message));
        return;
      }
    } catch (e) { if (i % 5 === 0) log('waiting: ' + e.message); }
  }
  log('CHECK gave up');
})();

setInterval(() => {}, 3600000); // stay alive so the container does not consider the app exited
