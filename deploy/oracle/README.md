# Hosting a Vultron station on Oracle Cloud Always Free

This runs the real app — UI, agent engine, terminal, saves — as one always-on station behind a password door,
for $0 of compute. It needs a VM rather than a serverless platform because the engine is a single long-lived
process holding a workspace on disk, spawning tools, and streaming runs over SSE.

**What you get:** `https://<your-ip>.sslip.io`, HTTP Basic (user `vultron`), data on a persistent Docker volume.

## 1. Create the instance (OCI console)

1. Sign up at [cloud.oracle.com](https://cloud.oracle.com) — a card is required for identity verification and
   is not charged on the Always Free tier. Pick a **home region**; Always Free shapes only exist there.
2. Compute → Instances → **Create instance**.
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** Ampere → `VM.Standard.A1.Flex` — Always Free currently allows **2 OCPU / 12 GB** total
     (Oracle reduced this from 4/24 in August 2026). 2 OCPU / 12 GB is more than the station needs.
   - **Boot volume:** 50 GB is plenty (200 GB is the free ceiling).
   - **Networking:** assign a public IPv4 address.
3. If creation fails with **"out of host capacity"**, that is a shape shortage, not your account: try another
   availability domain, or retry later. A1 capacity comes and goes.
4. **Open the ports** — this step is separate from the firewall inside the VM, and skipping it is the usual
   reason the site never comes up:

   Networking → Virtual Cloud Networks → your VCN → Security Lists → Default Security List → Add Ingress Rules

   | Source | IP protocol | Destination port |
   | --- | --- | --- |
   | `0.0.0.0/0` | TCP | `80` |
   | `0.0.0.0/0` | TCP | `443` |

   Leave SSH (22) as it is.

## 2. Run the bootstrap

SSH in (`ssh ubuntu@<public-ip>`) and run:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone -b feat/harness-backend https://github.com/auzzy370-wq/starnet.git vultron
cd vultron
sudo deploy/oracle/setup.sh
```

The script installs Docker, opens 80/443 in the instance firewall, generates the station password, builds the
image (a few minutes on ARM) and starts Caddy + the station. It prints the URL when the certificate is live.

Your password is in `deploy/oracle/.env` (mode 600) — copy it to your password manager. That file and the
`station_data` volume are the two things worth backing up.

## 3. First login

Open the URL, log in as `vultron` with that password, and add model provider keys in the app. They are stored
on the instance, never in the image.

## Re-running, stopping, backing up

```bash
cd ~/vultron
sudo docker compose -f deploy/oracle/docker-compose.yml up -d --build   # after a git pull
sudo docker compose -f deploy/oracle/docker-compose.yml down            # stop (volume survives)
sudo docker compose -f deploy/oracle/docker-compose.yml logs -f station # logs

# backup the workspace, chats, saves and spend ledger
sudo docker run --rm \
  -v vultron-station_station_data:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/station-$(date +%F).tgz -C /data .
```

## Caveats

- **Single tenant.** One Basic password, no accounts, no per-visitor isolation. Anyone with the link and the
  password drives your station with your provider keys. Do not post it publicly; set a spend cap in the app.
- **ARM image.** The Dockerfile rebuilds `node-pty` but skips the voice stack's `onnxruntime` binaries, so
  TTS is likely unavailable, and browser automation needs Chromium that this image does not install. Chat,
  tools, terminal, files and saves are the supported surface.
- **Idle reclamation.** Oracle may reclaim an Always Free instance that stays under 20% CPU, network and
  (A1 only) memory for 7 days. A station you actually use stays above that; it is not a good place to park
  the only copy of anything.
- **No domain needed.** `.sslip.io` resolves back to the IP, so Let's Encrypt issues a real certificate. A
  certificate is tied to the hostname, so if the instance's public IP changes, re-run the script to update
  `VULTRON_HOST` and Caddy will reissue.
- **This is a side path.** The product is local-first; the container path is the newest code on this branch.
