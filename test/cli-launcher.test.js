'use strict';
/* test/cli-launcher.test.js — bin/vultron (the macOS/Linux launcher) finds the app's OWN node in each platform's bundle:
   one folder up (a portable layout), Vultron.app/Contents/MacOS/node from Contents/Resources/bin, and usr/bin/node from a
   Linux package's usr/lib/Vultron/bin — else node on PATH. Each layout is built in a temp folder with a stub node that
   says which one ran. Needs a POSIX sh (Git for Windows ships one); without it the test says so and passes. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const A = require('./_assert.js');

const SRC = path.join(__dirname, '..', 'bin', 'vultron');
const probe = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' });
if (probe.error || probe.stdout.trim() !== 'ok') {
  console.log('cli-launcher.test: no POSIX sh on this machine — skipped');
  process.exit(0);
}
A.ok(!/\r/.test(fs.readFileSync(SRC, 'utf8')), 'the launcher has LF line endings (a CR breaks sh on macOS)');
/* …and keeps them in EVERY checkout: a Windows build runner with core.autocrlf=true would otherwise write it CRLF into
   the installer, and Git Bash (which finds this extensionless file on PATH first) dies on "$'\r': command not found". */
{
  const ca = spawnSync('git', ['check-attr', 'eol', '--', 'bin/vultron'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  if (ca.status === 0) A.eq(String(ca.stdout).trim(), 'bin/vultron: eol: lf', '.gitattributes pins bin/vultron to LF whatever core.autocrlf says');
  else console.log('cli-launcher.test: not a git checkout — the .gitattributes check skipped');
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vultron-launcher-'));
const layouts = {
  mac: ['Vultron.app/Contents/Resources/bin', 'Vultron.app/Contents/MacOS/node'],
  linux: ['usr/lib/Vultron/bin', 'usr/bin/node'],
  flat: ['Vultron/bin', 'Vultron/node']
};
try {
  for (const [name, [bin, node]] of Object.entries(layouts)) {
    const b = path.join(root, name, bin), n = path.join(root, name, node);
    fs.mkdirSync(b, { recursive: true }); fs.mkdirSync(path.dirname(n), { recursive: true });
    fs.copyFileSync(SRC, path.join(b, 'vultron'));
    fs.writeFileSync(path.join(b, 'vultron.js'), '');
    fs.writeFileSync(n, '#!/bin/sh\necho "' + name + ' node: $(basename "$1") $2"\n'); fs.chmodSync(n, 0o755);
    const r = spawnSync('sh', [path.join(b, 'vultron'), '--version'], { encoding: 'utf8' });
    A.eq((r.stdout || '').trim(), name + ' node: vultron.js --version', name + ': the launcher runs the bundle\'s own node, arguments passed through' + (r.stderr ? ' (' + r.stderr.trim() + ')' : ''));
  }
  /* THROUGH A LINK — the way a terminal actually reaches it on a Mac: sidecar/cli-link.js puts a SYMLINK at
     ~/.local/bin/vultron → Vultron.app/Contents/Resources/bin/vultron, and a PATH lookup hands the launcher the LINK's
     path as $0. The launcher must follow it to the bundle (an absolute link, a relative one, and a link to a link), or
     it looks for node beside ~/.local/bin and dies with "node: not found". Real `ln -s` on macOS/Linux; on Windows Git's
     sh makes MSYS symlinks (winsymlinks:sys — no admin rights needed), which `[ -h ]` and readlink see the same way. */
  const mac = path.join(root, 'mac', layouts.mac[0], 'vultron');
  const home = path.join(root, 'home', '.local', 'bin');
  fs.mkdirSync(home, { recursive: true });
  const links = [
    ['absolute link', 'vultron', mac],
    ['relative link', 'vultron-rel', path.relative(home, mac).split(path.sep).join('/')],
    ['link to a link', 'vultron-chain', 'vultron']
  ];
  const lnEnv = Object.assign({}, process.env, { MSYS: 'winsymlinks:sys' });
  let linked = 0;
  for (const [what, name, target] of links) {
    const ln = spawnSync('sh', ['-c', 'cd "$1" && ln -s "$2" "$3" && [ -h "$3" ]', 'sh', home, target, name], { encoding: 'utf8', env: lnEnv });
    if (ln.status !== 0) { console.log('cli-launcher.test: cannot make a symlink here (' + what + ') — that case skipped: ' + String(ln.stderr || '').trim()); continue; }
    linked++;
    const r = spawnSync('sh', [path.join(home, name), '-p', 'hi'], { encoding: 'utf8' });
    A.eq((r.stdout || '').trim(), 'mac node: vultron.js -p', what + ' in ~/.local/bin: the launcher follows it to the app bundle and runs ITS node' + (r.stderr ? ' (' + r.stderr.trim() + ')' : ''));
  }
  if (!linked) console.log('cli-launcher.test: no symlinks on this machine — the link cases were skipped');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
A.report('cli-launcher.test');
