#!/usr/bin/env node
/* deploy/enzonic/boot.js — entry point for an Enzonic Cloud "node.js generic" app.

   Point the panel's MAIN_FILE (or `node deploy/enzonic/boot.js`) at this file. It exists because that egg
   launches a JavaScript file with `node`, not a shell script — and the station needs a little setup first:

     - somewhere to keep state that a restart or a re-clone will not wipe ($HOME/vultron-data),
     - a site password, generated once and reused, so a restart does not lock you out,
     - the port the platform handed us ($SERVER_PORT),
     - dependencies installed (node-pty rebuilt, since install scripts are skipped).

   Then it hands the process to scripts/station-serve.js, which is the station's real front door: the engine
   on loopback and a password door on $PORT. Nothing here is Enzonic-specific on purpose — same layout on any
   box that runs a node process.
*/
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
process.chdir(ROOT);

const DATA = process.env.VULTRON_DATA_DIR || path.join(process.env.HOME || '/home/container', 'vultron-data');
const WORKSPACES = path.join(DATA, 'workspaces');
const PASS_FILE = path.join(DATA, 'station-password');
const PORT = process.env.SERVER_PORT || process.env.PORT || '8080';

fs.mkdirSync(WORKSPACES, { recursive: true });

if (!fs.existsSync(PASS_FILE) || fs.statSync(PASS_FILE).size === 0) {
  // base64url: no shell quoting hazards, no characters that break an HTTP Basic header
  fs.writeFileSync(PASS_FILE, crypto.randomBytes(24).toString('base64url'), { mode: 0o600 });
  console.log('[enzonic] generated the site password at ' + PASS_FILE);
}

const env = Object.assign({}, process.env, {
  HOME: DATA,
  VULTRON_WORKSPACES: WORKSPACES,
  VULTRON_SITE_USER: process.env.VULTRON_SITE_USER || 'vultron',
  VULTRON_SITE_PASSWORD: fs.readFileSync(PASS_FILE, 'utf8').trim(),
  NODE_ENV: 'production',
  PORT
});

// Install once. The lockfile marker npm writes is the cheapest reliable "are the deps here" test — a plain
// node_modules check would miss a partial install left behind by a failed boot.
if (!fs.existsSync(path.join(ROOT, 'node_modules', '.package-lock.json'))) {
  console.log('[enzonic] installing dependencies — first boot takes about a minute');
  for (const args of [['ci', '--ignore-scripts', '--no-audit', '--no-fund'], ['rebuild', 'node-pty', '--no-audit', '--no-fund']]) {
    const r = spawnSync('npm', args, { cwd: ROOT, stdio: 'inherit', env });
    if (r.status !== 0) {
      console.error('[enzonic] npm ' + args.join(' ') + ' failed (' + (r.status === null ? r.error && r.error.message : r.status) + ')');
      process.exit(1);
    }
  }
}

console.log('[enzonic] data      ' + DATA);
console.log('[enzonic] password  ' + PASS_FILE + '   (user is ' + env.VULTRON_SITE_USER + ')');
console.log('[enzonic] port      ' + PORT);

const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'station-serve.js')], { stdio: 'inherit', env });

// The panel stops a server by signalling the main process; the station's engine is a child of it, so a
// pass-through keeps the shutdown ordered instead of orphaning the engine while it holds the workspace claim.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (child.exitCode === null) child.kill(sig);
  });
}
child.on('exit', (code, signal) => {
  console.log('[enzonic] station exited (' + (signal || code) + ')');
  process.exit(code == null ? 1 : code);
});
