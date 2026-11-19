# Vultron station — the real app (UI + agent engine) in one container.
#
# This is a hosted station, not a static site: the process serves the UI AND the 400-odd /api routes behind
# it. That is exactly why it cannot run on Vercel's serverless runtime — it needs a long-lived process, a
# writable disk for the workspace, and child processes.
#
#   docker build -t vultron-station .
#   docker run --rm -p 8080:8080 -v station:/data vultron-station
#
# then open http://127.0.0.1:8080 — no login.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# node-pty is a native addon (the terminal); the rest of the tree installs cleanly without scripts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# --ignore-scripts: kokoro-js -> onnxruntime-node tries to fetch a CUDA tarball that 404s on Linux x64 and
# fails the whole install. The voice stack loads lazily, so the station runs without those binaries.
RUN npm ci --ignore-scripts --no-audit --no-fund && npm rebuild node-pty --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOME=/data \
    PORT=8080 \
    VULTRON_WORKSPACES=/data/workspaces
WORKDIR /app
RUN mkdir -p /data/workspaces
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "scripts/station-serve.js"]
