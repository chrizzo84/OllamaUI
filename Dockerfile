# ---------- Build stage: compile Next.js app ----------
FROM node:24-bullseye-slim AS builder
WORKDIR /build

# Enable corepack; the exact pnpm version comes from package.json's
# "packageManager" field once it's copied in below. Pinning to @latest here
# instead would drift from the lockfile's pnpm version over time and can
# make --frozen-lockfile reject an otherwise-valid lockfile (overrides are
# hashed differently across pnpm majors).
RUN corepack enable

# Copy only package manifests first for better caching
COPY ollama-ui/package.json ollama-ui/pnpm-lock.yaml ollama-ui/pnpm-workspace.yaml ./ollama-ui/
WORKDIR /build/ollama-ui

# Install dependencies (pure JS + node:sqlite built into Node itself — no
# native modules, so no build toolchain or rebuild step needed here)
RUN pnpm install --frozen-lockfile

# Copy full source
COPY ollama-ui .

# Build (standalone output for minimal runtime footprint)
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---------- Runtime stage: base Ollama image + UI ----------
FROM ollama/ollama:latest AS final
WORKDIR /app

# Install Node.js (no build tools needed – no native modules anymore)
RUN apt-get clean \
 && apt-get update \
 && for i in 1 2 3; do apt-get install -y --fix-missing curl && break || sleep 5; done \
 && rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs

# Install pnpm
RUN npm install -g pnpm

# Copy standalone build output
# .next/standalone contains server.js + minimal node_modules; .next/static & public needed for assets
COPY --from=builder /build/ollama-ui/.next/standalone ./
COPY --from=builder /build/ollama-ui/.next/static ./.next/static
COPY --from=builder /build/ollama-ui/public ./public

# Copy package.json, pnpm-lock.yaml and pnpm-workspace.yaml (has the
# dependency "overrides") for dependency management
COPY --from=builder /build/ollama-ui/package.json ./
COPY --from=builder /build/ollama-ui/pnpm-lock.yaml ./
COPY --from=builder /build/ollama-ui/pnpm-workspace.yaml ./

# Install production dependencies (pure JS only, no native modules to compile)
RUN HUSKY=0 pnpm install --prod --frozen-lockfile --ignore-scripts
# (No local models.json needed; catalog fetched at runtime from remote repository)

# Optional: default env (can be overridden). Use internal service host.
ENV OLLAMA_HOST="http://localhost:11434" \
    NODE_ENV=production \
    PORT=3000 \
    OLLAMA_LISTEN="0.0.0.0:11434"

# Start script to run both Ollama server and Next.js UI.
COPY <<'EOF' /app/start.sh
#!/usr/bin/env bash
set -euo pipefail

# Start Ollama server in background (listens on 11434 by default)
echo "[start] launching ollama server on ${OLLAMA_LISTEN:-0.0.0.0:11434}" >&2
OLLAMA_HOST="${OLLAMA_LISTEN:-0.0.0.0:11434}" ollama serve &
OLLAMA_PID=$!

# Wait a little so initial state is ready
sleep 2

# Launch Next.js standalone server
if [ -f server.js ]; then
  echo "[start] launching Next.js UI on port ${PORT}" >&2
  exec node server.js
else
  echo "[error] server.js not found in /app. Did the build step succeed?" >&2
  kill ${OLLAMA_PID} || true
  exit 1
fi
EOF

RUN chmod +x /app/start.sh

# Expose Ollama + UI ports
EXPOSE 11434 3000

# Healthcheck: simple TCP check on UI port (customize if needed)
HEALTHCHECK --interval=30s --timeout=5s --retries=5 CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/3000 && echo -e "GET / HTTP/1.0\n\n" >&3 && grep -q "200" <(sleep 1; cat <&3)'

ENTRYPOINT ["/app/start.sh"]
