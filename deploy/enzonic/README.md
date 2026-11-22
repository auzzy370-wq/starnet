# Running a Vultron station on Enzonic Cloud

Enzonic's free tier is **2 GB RAM, 200% CPU, 10 GB SSD, online 24/7** — a persistent process with a real
filesystem, which is what the station needs. No Docker, no card.

Use **Cloud**, not **Enzonic Deploy**: Deploy builds static/framework output and scales functions to zero, so
the engine (a long-lived process holding a workspace on disk) and its SSE runs would not survive. Cloud runs
one process that stays up.

## Size it honestly

The station is not small. Measured on this repo:

| | |
| --- | --- |
| App files (`sidecar`, `scripts`, `frontend`, `shared`, `bin`) | ~1.38 GB — almost all of it `frontend/assets` |
| Dependencies (`npm ci`) | ~873 MB — ~754 MB of that is the voice stack |
| Git checkout + history | ~1.9 GB |

Plan for **≥5 GB of free disk** and **2 GB RAM**. A 512 MB / 2.5 GB server does not fit and will fill up
mid-clone.

## Panel fields

| Field | Value |
| --- | --- |
| Egg / template | `node.js generic` |
| Region | USA or Spain |
| `GIT_ADDRESS` | `https://github.com/auzzy370-wq/starnet.git` |
| `BRANCH` | `feat/harness-backend` |
| `MAIN_FILE` | `deploy/enzonic/boot.js` |

`MAIN_FILE` matters: this egg launches a **JavaScript** file with `node`, so the entry point is
`deploy/enzonic/boot.js`, not the shell wrapper. `start.sh` is the same thing for when you are in the panel
console — `bash deploy/enzonic/start.sh` — and does nothing except exec `boot.js`.

On first boot `boot.js` installs dependencies (~1 minute), generates the site password into
`~/vultron-data/station-password`, and hands the process to `scripts/station-serve.js`.

## Logging in

Open the server's URL from the panel and log in as `vultron`. The password is in
`~/vultron-data/station-password` — read it in the panel's file manager, or `cat` it in the console. Then add
model provider keys in the app; they live on the server, never in the repo.

## Updating

Pull in the panel console (or re-clone) and restart. `~/vultron-data` is untouched, so chats, saves and the
spend ledger survive.

## Caveats

- **Voice is unavailable.** The install skips package scripts (the voice stack's `onnxruntime-node` fetch
  404s on Linux) and rebuilds only `node-pty`, which the terminal needs. Chat, tools, terminal, files, saves
  and everything browser-independent work; TTS does not.
- **Single tenant.** One Basic password in front of the engine, no accounts. Anyone with the URL and the
  password drives your station with your provider keys — set a spend cap in the app.
- **The door is the security boundary.** `scripts/station-serve.js` refuses to start without
  `VULTRON_SITE_PASSWORD`; `/api/health` is the only unauthenticated path, for the platform's health check.
- **Restart the whole server, not just the script.** The engine holds a workspace claim; stopping only the
  parent process leaves it behind and the next boot refuses with `WORKSPACE_BUSY`. A panel restart kills the
  container, which is fine.
- **Backups.** Copy `~/vultron-data` (file manager, SFTP, or the panel's backup feature). That directory plus
  the password is the whole station state.
