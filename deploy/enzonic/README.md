# Running a Vultron station on Enzonic Cloud

This is the path the station actually runs on: **Quiet Valley**, an Enzonic Cloud server (node egg, 4 GB RAM,
15 GB SSD, `na-one.enzonic.com:26656`) — one persistent process, no Docker.

Use **Cloud**, not **Enzonic Deploy**: Deploy builds static/framework output and scales functions to zero, so
the engine (a long-lived process holding a workspace on disk) and its SSE runs would not survive.

## How the box is wired

The egg launches exactly one file, `node /home/container/index.js`, after running `npm install` against
`/home/container/package.json`. Its git/startup variables (`GIT_ADDRESS`, `BRANCH`, `MAIN_FILE`) are **not
editable through the panel's client API** — every write method answers `405` — so the deploy does not use them.
Instead, [entry.js](entry.js) is pasted over `/index.js` in the panel's File Manager.

`entry.js` then, on every boot:

| Step | Why |
| --- | --- |
| `git clone --depth 1` into `./starnet` | the branch is ~3.6 GB of working tree; depth 1 avoids another ~1.9 GB of history |
| `git pull --ff-only` on later boots | restart = deploy; `VULTRON_PULL=0` disables it |
| rebuild `node-pty` if the binary is missing | npm 12 silently skips undeclared install scripts and reports success (see below) |
| exec `deploy/enzonic/boot.js` | which owns the data dir, password and port, then starts `scripts/station-serve.js` |
| self-check `/api/health` and `/` | an allocation port is not reachable from most of the internet, so the proof has to come from inside the box |

Everything is appended to `/home/container/boot.log`, readable in the File Manager.

Leave `/home/container/package.json` as the egg created it. If you copy the station's own `package.json` to the
root, the egg's install step will try to install the entire dependency tree there on every boot.

## Size it honestly

| | |
| --- | --- |
| App files (`sidecar`, `scripts`, `frontend`, `shared`, `bin`) | ~1.38 GB — almost all of it `frontend/assets` |
| Dependencies (`npm ci`) | ~873 MB — ~754 MB of that is the voice stack |
| Git checkout, depth 1 | ~3.6 GB of tree plus the pack |

Plan for **≥8 GB of disk** and **2 GB RAM**. A 512 MB / 2.5 GB server does not fit and fills up mid-clone.

## Logging in

`http://na-one.enzonic.com:26656` — user `vultron`, password in `~/vultron-data/station-password` (File
Manager). Change it by editing that file and restarting; `boot.js` reads it fresh on every boot. Then add model
provider keys in the app; they live on the server, never in the repo.

## Turning the password off

Create an empty file at `~/vultron-data/OPEN-ACCESS` (File Manager → New File) and restart. `boot.js` passes
`VULTRON_ALLOW_UNAUTHENTICATED=1` when it exists, the door stops checking credentials, and the startup log says
`(OPEN — no password: anyone with this URL drives this station)`. Delete the file and restart to put the
password back; `~/vultron-data/station-password` is still there.

This is **this deployment's** setting, not the product's default: `scripts/station-serve.js` still refuses to
start without a password unless that flag is explicitly set. With the door open, anyone who has the URL — an
allocation port that is publicly reachable — reaches the engine with your provider keys and your workspace.

## Two things that bit us on the real box

- **The terminal was silently dead.** npm 12 blocks install scripts not declared in `package.json`
  (`allowScripts`) and still exits 0, so `npm rebuild node-pty` reported success while producing no `pty.node`.
  Both `boot.js` and `entry.js` now check for the binary itself and rebuild with
  `--dangerously-allow-all-scripts`. Without it the station boots and looks fine, but every terminal is dead.
- **`version.git.attempt` noise.** `git describe`'s dirty check has a 15 s timeout and the 49k-file tree can
  exceed it, so the log shows a few failopen retries at startup. Harmless — it only affects the version string.

## Updating

Panel → Restart. `entry.js` pulls the branch; `~/vultron-data` is untouched, so chats, saves and the spend
ledger survive. For a clean slate, delete `/home/container/starnet` and restart — it re-clones.

## Caveats

- **TTS is unlikely.** The voice stack's `onnxruntime-node` binaries are not installed (install scripts are
  skipped), though the free Edge voice passed its startup check on the box.
- **Single tenant.** One Basic password in front of the engine, no accounts. Anyone with the URL and the
  password drives your station with your provider keys — set a spend cap in the app.
- **The door is the security boundary.** `scripts/station-serve.js` refuses to start without
  `VULTRON_SITE_PASSWORD`; `/api/health` is the only unauthenticated path.
- **Backups.** Copy `~/vultron-data` (File Manager, SFTP, or the panel's backup feature — the server has 4
  backup slots). That directory plus the password is the whole station state.
