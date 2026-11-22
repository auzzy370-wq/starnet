#!/usr/bin/env node
/* deploy/enzonic/tunnel.js — a free Cloudflare quick tunnel in front of the station's door.

   WHY. A hosted station is reached at http://<host>:<allocation port>, which every browser calls insecure: it shows
   "Not secure" and withholds the [SecureContext] APIs — the microphone above all, plus crypto.subtle and Web Locks.
   Enzonic offers no TLS on an allocation port (443 does not answer; the panel API has no proxy option), and Cloudflare's
   proxy will not forward to a non-standard origin port, so the one thing that can put a certificate in front of this
   port is a tunnel that dials OUT from the box. A quick tunnel needs no account and no token.

   WHAT IT DOES. Fetches cloudflared once (into the container's home, NOT the repo — a `git pull` must never touch a
   40 MB binary), runs `cloudflared tunnel --url http://127.0.0.1:<door>`, reads the https hostname out of its output, and
   writes it to two places that survive a log clear: $HOME/tunnel-url.txt and a `TUNNEL <url>` line in boot.log.

   WHAT IT IS NOT. A quick tunnel's hostname is minted per launch, so it CHANGES ON EVERY RESTART — it is a way to be
   secure today, not a permanent address. A named tunnel with a token from a Cloudflare account gives a stable hostname;
   set VULTRON_TUNNEL_TOKEN to run that instead of the quick tunnel. `VULTRON_TUNNEL=0` turns this off entirely.

   The station's door is what the tunnel points at, so the door's own peer rules and the engine's Host pin see the same
   loopback request they see from a browser on the box: the tunnel adds a certificate, nothing else.
*/
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');

const HOME_DIR = path.resolve(__dirname, '..', '..', '..');       // /home/container on the host
const BIN = path.join(HOME_DIR, 'cloudflared');
const URL_FILE = path.join(HOME_DIR, 'tunnel-url.txt');
const DOWNLOAD = {
  'linux-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
  'linux-arm64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64'
};

/* GitHub answers the release URL with a redirect to the object store, so follow a few hops by hand. */
function download(url, dest, hops) {
  return new Promise((resolve, reject) => {
    if ((hops || 0) > 6) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'vultron-tunnel' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, (hops || 0) + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('download answered ' + res.statusCode)); }
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => { try { fs.renameSync(tmp, dest); resolve(fs.statSync(dest).size); } catch (e) { reject(e); } }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

module.exports = function start({ log, port, env }) {
  const say = m => { try { log('TUNNEL ' + m); } catch (_) {} };
  try {
    if (String((env || process.env).VULTRON_TUNNEL || '') === '0') { say('disabled by VULTRON_TUNNEL=0'); return; }
    const token = String((env || process.env).VULTRON_TUNNEL_TOKEN || '').trim();
    const target = 'http://127.0.0.1:' + port;

    const run = () => {
      // http2 keeps this to TCP 443: a container that blocks UDP must not lose the tunnel to QUIC.
      const args = token
        ? ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run', '--token', token]
        : ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', target];
      const child = spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let found = '';
      const scan = buf => {
        const text = String(buf || '');
        const m = /https:\/\/[a-z0-9][a-z0-9-]*\.(?:trycloudflare\.com|cfargotunnel\.com)/i.exec(text);
        if (m && !found) {
          found = m[0];
          try { fs.writeFileSync(URL_FILE, found + '\n'); } catch (_) {}
          say('https:// ready -> ' + found + '   (a quick tunnel hostname is minted per launch)');
          say('mic + every secure-context API now work at that address; the http:// one keeps working too');
        }
      };
      child.stdout.on('data', scan);
      child.stderr.on('data', d => { scan(d); const t = String(d); if (/ERR|error|failed/i.test(t)) say('log: ' + t.trim().slice(0, 200)); });
      child.on('exit', (code, sig) => say('cloudflared exited (' + (sig || code) + ')'));
      child.on('error', e => say('cloudflared could not start: ' + e.message));
      say('started ' + (token ? 'named' : 'quick') + ' tunnel for ' + target);
    };

    if (fs.existsSync(BIN)) { say('using ' + BIN + ' (' + fs.statSync(BIN).size + ' bytes)'); return run(); }
    const url = DOWNLOAD[process.platform + '-' + process.arch];
    if (!url) { say('no cloudflared build for ' + process.platform + '-' + process.arch); return; }
    say('fetching cloudflared for ' + process.platform + '-' + process.arch + ' — first launch only');
    download(url, BIN).then(size => {
      try { fs.chmodSync(BIN, 0o755); } catch (_) {}
      say('cloudflared downloaded (' + size + ' bytes)');
      run();
    }, e => say('download failed: ' + e.message));
  } catch (e) {
    say('could not start: ' + e.message);
  }
};
