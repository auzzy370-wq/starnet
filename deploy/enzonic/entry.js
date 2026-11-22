#!/usr/bin/env node
/* deploy/enzonic/entry.js — paste this file's contents over /index.js in the Enzonic server's File Manager.

   The egg runs exactly one file, /home/container/index.js, with `node`:
       export PORT=${SERVER_PORT}; ... node index.js
   and it keeps /home/container as the app's home. So this shim does the three things that have to happen
   before the station can run, then gets out of the way:

     1. clone the branch once into ./starnet (re-cloned if it is missing or broken),
     2. make sure node-pty has a compiled binary (the terminal; see boot.js for why npm 12 needs a nudge),
     3. hand over to deploy/enzonic/boot.js, which owns the data dir, password, port and the engine.

   It also appends to /home/container/boot.log, because the panel's console is the only other window into the
   process and a log file survives restarts and can be read from the File Manager.
*/
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');

const LOG = path.join(__dirname, 'boot.log');
const log = m => fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + m + '\n');
const DIR = path.join(__dirname, 'starnet');
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

// Self-check from inside the box: an allocation port is not reachable from most of the internet, so the only
// reliable proof the door answers is a request from here. Result goes to boot.log.
const probe = p => new Promise((res, rej) => {
  const q = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 5000 }, r => { r.resume(); res(r.statusCode); });
  q.on('error', rej);
  q.on('timeout', () => { q.destroy(); rej(new Error('timeout')); });
});
(async () => {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    try {
      const health = await probe('/api/health');
      const door = await probe('/');
      log('CHECK /api/health=' + health + ' /(no auth)=' + door);
      if (health === 200) return;
    } catch (e) { if (i % 5 === 0) log('waiting: ' + e.message); }
  }
  log('CHECK gave up');
})();

setInterval(() => {}, 3600000); // stay alive so the container does not consider the app exited
