#!/usr/bin/env node
/* scripts/station-serve.js — THE PUBLIC FRONT DOOR for a hosted station.

   Loopback stays the product's default: this process starts the real engine exactly as `npm start` does
   (sidecar/index.js on 127.0.0.1) and then puts a password-gated HTTP door in front of it on $PORT, which is
   the one thing a container platform exposes. Nothing about the engine's threat model changes:

     - the engine still listens on 127.0.0.1 only, so the Host pin and the loopback Origin check still see a
       loopback request (the door rewrites Host/Origin to 127.0.0.1:$ENGINE_PORT before forwarding);
     - the engine still requires its per-launch x-vultron-token on every /api route — this door does not
       impersonate the page, it only lets an authenticated operator reach it;
     - /api/health is the sole unauthenticated path, because the platform's health check cannot carry Basic auth.

   Fail closed: with no VULTRON_SITE_PASSWORD there is no door. A public station that hands its master token
   to whoever finds the URL is not a hosted version of this product, it is an open proxy to the owner's agent.

   Streams both ways (agent runs are SSE), and tunnels WebSocket upgrades, so the station behaves like it does
   on the desktop. */
'use strict';
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const EDGE_PORT = Number(process.env.PORT) || 8080;
const ENGINE_PORT = Number(process.env.VULTRON_ENGINE_PORT) || 8787;
const ENGINE_HOST = '127.0.0.1';
const SITE_USER = String(process.env.VULTRON_SITE_USER || 'vultron').trim() || 'vultron';
const SITE_PASSWORD = String(process.env.VULTRON_SITE_PASSWORD || '');
/* Explicit opt-out for a station the owner does not want gated. The default stays closed on purpose: an
   unlocked station is the owner's agent, with the owner's provider keys, for whoever finds the URL. */
const OPEN_ACCESS = process.env.VULTRON_ALLOW_UNAUTHENTICATED === '1';
const OPEN_PATHS = new Set(['/api/health']);   // the platform health check — nothing else is open

if (!SITE_PASSWORD && !OPEN_ACCESS) {
  console.error('\n[station] ✗ VULTRON_SITE_PASSWORD is not set.');
  console.error('  A hosted station is the owner\'s agent with the owner\'s keys: the door stays shut rather than');
  console.error('  serving that to anyone who finds the URL. Set it (12+ characters) and start again.\n');
  process.exit(78);   // EX_CONFIG
}
if (!OPEN_ACCESS && SITE_PASSWORD.length < 12) {
  console.error('[station] ! VULTRON_SITE_PASSWORD is shorter than 12 characters — this door faces the internet.');
}

function safeEq(a, b) {
  const x = Buffer.from(String(a == null ? '' : a), 'utf8');
  const y = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (_) { return false; }
}

/* Constant-time on BOTH halves: no early return that would leak which field was wrong. */
function authorized(req) {
  const header = String((req.headers && req.headers.authorization) || '');
  if (header.indexOf('Basic ') !== 0) return false;
  let decoded = '';
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch (_) { return false; }
  const at = decoded.indexOf(':');
  if (at < 0) return false;
  const userOk = safeEq(decoded.slice(0, at), SITE_USER) & 1;
  const passOk = safeEq(decoded.slice(at + 1), SITE_PASSWORD) & 1;
  return (userOk & passOk) === 1;
}

function pathOf(url) { const u = String(url || ''); const i = u.indexOf('?'); return i < 0 ? u : u.slice(0, i); }

/* Headers for the hop to the engine: drop the door's own credentials, and present the request the way the
   engine expects to see it — a browser talking to its own loopback station. Keeping the page's Origin would
   make every POST (runs, saves) look cross-origin and the engine would rightly refuse it. */
function upstreamHeaders(headers) {
  const out = Object.assign({}, headers);
  delete out.authorization;
  delete out['proxy-authorization'];
  delete out.cookie;
  out.host = ENGINE_HOST + ':' + ENGINE_PORT;
  if (out.origin) out.origin = 'http://' + ENGINE_HOST + ':' + ENGINE_PORT;
  out['x-forwarded-proto'] = 'https';
  return out;
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 128 });

const server = http.createServer((req, res) => {
  if (!OPEN_ACCESS && !OPEN_PATHS.has(pathOf(req.url)) && !authorized(req)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="vultron", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    return res.end('authentication required\n');
  }
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

/* WebSocket upgrades (the terminal). The browser does not reliably replay Basic credentials on a WS
   handshake, so a handshake is admitted with either the door's credentials or the page's own station
   token — the engine then applies its own gate to the socket. */
server.on('upgrade', (req, socket, head) => {
  if (!OPEN_ACCESS && !authorized(req) && !req.headers['x-vultron-token']) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return socket.destroy();
  }
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

(async () => {
  const engine = spawn(process.execPath, [path.join(__dirname, '..', 'sidecar', 'index.js')], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, {
      VULTRON_PORT: String(ENGINE_PORT),
      VULTRON_BIND_HOST: ENGINE_HOST      // loopback, always: the door is the only public surface
    })
  });
  engine.on('exit', (code, signal) => {
    console.error('[station] engine exited (' + (code == null ? signal : code) + ') — closing the door with it');
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
    console.log('  door      http://0.0.0.0:' + EDGE_PORT + (OPEN_ACCESS
      ? ' (OPEN — no password: anyone with this URL drives this station)'
      : ' (HTTP Basic, user "' + SITE_USER + '")'));
    console.log('  engine    http://' + ENGINE_HOST + ':' + ENGINE_PORT + ' (loopback only, token-gated)');
    console.log('  health    /api/health (unauthenticated, for the platform check)\n');
  });
})();

const shutdown = sig => { try { server.close(); } catch (_) {} process.kill(process.pid, sig); };
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
