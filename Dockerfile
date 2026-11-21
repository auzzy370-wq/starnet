# Vultron station — the real app (UI + agent engine) in one container, for Fly.io.
#
# Long-lived process, writable disk, child processes (shells, the terminal's node-pty). Fly mounts the
# station_data volume on /data (see fly.toml); that mount hides this image's /data, and the engine creates
# VULTRON_WORKSPACES on boot. A local run without a volume still has /data from the image.
#
#   docker build -t vultron-station .
#   docker run --rm -p 8080:8080 -e PORT=8080 vultron-station
#
# then open http://127.0.0.1:8080 — no login. Fly's proxy calls the same /api/health path.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# node-pty is a native addon (the terminal); the rest of the tree installs cleanly without scripts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# --omit=dev: the desktop CLI and the offline canvas package are not loaded by the station.
# --ignore-scripts: kokoro-js -> onnxruntime-node tries to fetch a CUDA tarball that 404s on Linux x64 and
# fails the whole install. The voice stack loads lazily, so the station runs without those binaries.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm rebuild node-pty --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOME=/data \
    PORT=8080 \
    VULTRON_WORKSPACES=/data/workspaces
WORKDIR /app
# tini is PID 1 so shells and pty children get reaped. Fly does not add an init of its own.
# No python3 or unzip here: the engine's browser auto-install treats a missing tool as non-fatal,
# and a downloaded Chrome would not fit the 512MB machine this image is sized for.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data/workspaces
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["node", "scripts/station-serve.js"]
