# Running a Vultron station on Enzonic Cloud (free tier)

Enzonic's free tier is 2 GB RAM, 200% CPU, 10 GB SSD, online 24/7 — a persistent process with a real
filesystem, which is what the station needs. No Docker, no card.

Use **Cloud**, not **Enzonic Deploy**: Deploy builds static/framework output and scales functions to zero, so
the engine (a long-lived process holding a workspace on disk) and its SSE runs would not survive. Cloud runs
one process that stays up.

## Panel fields

| Field | Value |
| --- | --- |
| Egg / template | `node.js generic` |
| Region | USA or Spain |
| Git repository | `https://github.com/auzzy370-wq/starnet.git` |
| Branch | `feat/harness-backend` |
| Startup command | `bash deploy/enzonic/start.sh` |

The repo is ~1.9 GB with history; if the panel lets you edit the clone command, `--depth 1` makes the first
boot much faster.

`start.sh` installs dependencies on first boot (~1 minute; `node_modules` is ~970 MB), generates the site
password into `~/vultron-data/station-password`, and execs the station on `$SERVER_PORT`.

## Logging in

Open the server's URL from the panel and log in as `vultron`. The password is in
`~/vultron-data/station-password` — read it in the panel's file manager, or `cat` it in the console. Then add
model provider keys in the app; they are stored on the server, never in the repo.

## Updating

Git pull in the panel console (or re-clone) and restart. `~/vultron-data` is untouched, so chats, saves and
the spend ledger survive.

## Caveats

- **2 GB RAM.** The voice stack's ONNX binaries are not installed (see the `--ignore-scripts` note in
  `start.sh`), so TTS is unavailable. Chat, tools, terminal, files, saves and browser-independent work are.
- **Single tenant.** One Basic password in front of the engine, no accounts. Anyone with the URL and the
  password drives your station with your provider keys — set a spend cap in the app.
- **The door is the security boundary.** `scripts/station-serve.js` refuses to start without
  `VULTRON_SITE_PASSWORD`; `/api/health` is the only unauthenticated path, for the platform's check.
- **Backups.** Copy `~/vultron-data` (file manager, SFTP, or the panel's backup feature). That directory plus
  the password is the whole station state.
