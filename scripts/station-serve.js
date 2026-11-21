#!/usr/bin/env node
/* scripts/station-serve.js — THE PUBLIC FRONT DOOR for a hosted station.

   Loopback stays the product's default: this process starts the real engine exactly as `npm start` does
   (sidecar/index.js on 127.0.0.1) and then opens a door in front of it on $PORT, which is the one thing a
   container platform exposes. Nothing about the engine's threat model changes:

     - the engine still listens on 127.0.0.1 only, so the Host pin and the loopback Origin check still see a
       loopback request (the door rewrites Host/Origin to 127.0.0.1:$ENGINE_PORT before forwarding);
     - the engine still requires its per-launch x-vultron-token on every /api route — this door does not
       impersonate the page, it only forwards an operator's request to it.

   There is no login: the door admits every request that reaches $PORT. A hosted station is the owner's agent
   with the owner's keys, so host one only where anyone who has the URL is meant to have that access, or put
   an authenticating proxy of your own in front of it.

   Streams both ways (agent runs are SSE), and tunnels WebSocket upgrades, so the station behaves like it does
   on the desktop. */
'use strict';
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const EDGE_PORT = Number(process.env.PORT) || 8080;
const ENGINE_PORT = Number(process.env.VULTRON_ENGINE_PORT) || 8787;
const ENGINE_HOST = '127.0.0.1';

/* Headers for the hop to the engine: present the request the way the engine expects to see it — a browser
   talking to its own loopback station. Keeping the page's Origin would make every POST (runs, saves) look
   cross-origin and the engine would rightly refuse it. */
function upstreamHeaders(headers) {
  const out = Object.assign({}, headers);
  delete out['proxy-authorization'];
  delete out.cookie;
  out.host = ENGINE_HOST + ':' + ENGINE_PORT;
  if (out.origin) out.origin = 'http://' + ENGINE_HOST + ':' + ENGINE_PORT;
  out['x-forwarded-proto'] = 'https';
  return out;
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 128 });

const server = http.createServer((req, res) => {
  const up = http.request({
    host: ENGINE_HOST, port: ENGINE_PORT, method: req.method, path: req.url,
    headers: upstreamHeaders(req.headers), agent
  }, upRes => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);                     // streams: an agent run is SSE and must not be buffered
  });
  up.on('error', err => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('station engine unreachable: ' + err.message + '\n');
  });
  req.pipe(up);
});

/* WebSocket upgrades (the terminal). Forward everything; the engine applies its own gate to the socket. */
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(ENGINE_PORT, ENGINE_HOST, () => {
    const headers = upstreamHeaders(req.headers);
    const lines = [req.method + ' ' + req.url + ' HTTP/1.1'];
    Object.keys(headers).forEach(k => {
      const v = headers[k];
      if (Array.isArray(v)) v.forEach(one => lines.push(k + ': ' + one));
      else if (v != null) lines.push(k + ': ' + v);
    });
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

// A run is a long-lived stream; never let Node's default request ceiling cut it.
server.requestTimeout = 0;
server.headersTimeout = 120000;
server.keepAliveTimeout = 65000;

function probe() {
  return new Promise(resolve => {
    const r = http.get({ host: ENGINE_HOST, port: ENGINE_PORT, path: '/api/health', timeout: 2000 }, res => {
      res.resume(); resolve(res.statusCode === 200);
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let engineChild = null;
let doorClosing = false;

/* Fly stop, suspend-fallback, and deploy send SIGTERM to PID 1. The engine is the process that holds the
   workspace lock and the child shells; it already drains those on SIGTERM (about 3s). Forward the signal
   and leave when it does. Re-raising SIGTERM at this process does not exit — a handler is installed — so
   Fly would wait out kill_timeout and SIGKILL, skipping that drain. */
function shutdown(sig) {
  if (doorClosing) return;
  doorClosing = true;
  console.error('[station] ' + sig + ' — closing the door');
  try { server.close(); } catch (_) {}
  const child = engineChild;
  if (child && child.exitCode == null && child.signalCode == null) {
    try { child.kill(sig); } catch (_) { process.exit(0); return; }
    const giveUp = setTimeout(() => process.exit(0), 8000);
    if (giveUp.unref) giveUp.unref();
    return;
  }
  process.exit(0);
}

(async () => {
  const engine = spawn(process.execPath, [path.join(__dirname, '..', 'sidecar', 'index.js')], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, {
      VULTRON_PORT: String(ENGINE_PORT),
      VULTRON_BIND_HOST: ENGINE_HOST      // loopback, always: the door is the only public surface
    })
  });
  engineChild = engine;
  engine.on('exit', (code, signal) => {
    console.error('[station] engine exited (' + (code == null ? signal : code) + ') — closing the door with it');
    if (doorClosing) process.exit(0);
    process.exit(code == null ? 1 : code);
  });

  let up = false;
  for (let i = 0; i < 120; i++) { if (await probe()) { up = true; break; } await sleep(500); }
  if (!up) {
    console.error('[station] ✗ the engine never answered /api/health — not opening the door');
    try { engine.kill('SIGTERM'); } catch (_) {}
    process.exit(1);
  }
  server.listen(EDGE_PORT, '0.0.0.0', () => {
    console.log('\n[station] hosted station ready');
    console.log('  door      http://0.0.0.0:' + EDGE_PORT + ' (open — no login)');
    console.log('  engine    http://' + ENGINE_HOST + ':' + ENGINE_PORT + ' (loopback only, token-gated)');
    console.log('  health    /api/health (for the platform check)\n');
  });
})();

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
