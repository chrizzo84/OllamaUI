# ---------- Build stage: compile Next.js app ----------
FROM node:20-bullseye-slim AS builder
WORKDIR /build

# Install pnpm (preferred) – fallback to npm if desired
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy only package manifests first for better caching
COPY ollama-ui/package.json ollama-ui/pnpm-lock.yaml ./ollama-ui/
WORKDIR /build/ollama-ui
RUN pnpm install --frozen-lockfile

# Copy full source
COPY ollama-ui .

# Build (standalone output for minimal runtime footprint)
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---------- Runtime stage: base Ollama image + UI ----------
FROM ollama/ollama:latest AS final
WORKDIR /app

# Copy Node runtime from an official Node image (compatible glibc build)
COPY --from=node:20-bullseye-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:20-bullseye-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx || true

# Copy standalone build output
# .next/standalone contains server.js + minimal node_modules; .next/static & public needed for assets
COPY --from=builder /build/ollama-ui/.next/standalone ./
COPY --from=builder /build/ollama-ui/.next/static ./.next/static
COPY --from=builder /build/ollama-ui/public ./public
# (No local models.json needed; catalog fetched at runtime from remote repository)

# Optional: default env (can be overridden). Use internal service host.
ENV OLLAMA_HOST="http://localhost:11434" \
    NODE_ENV=production \
    PORT=3000

# Start script to run both Ollama server and Next.js UI.
COPY <<'EOF' /app/start.sh
#!/usr/bin/env bash
set -euo pipefail

# Start Ollama server in background (listens on 11434 by default)
echo "[start] launching ollama server" >&2
ollama serve &
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
