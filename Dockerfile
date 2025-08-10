# ---------- Build stage: compile Next.js app ----------
FROM node:20-bullseye-slim AS builder
WORKDIR /build

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm (preferred) – fallback to npm if desired
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy only package manifests first for better caching
COPY ollama-ui/package.json ollama-ui/pnpm-lock.yaml ./ollama-ui/
WORKDIR /build/ollama-ui

# Install dependencies and rebuild native modules for the container architecture
RUN pnpm install --frozen-lockfile
RUN pnpm rebuild better-sqlite3

# Copy full source
COPY ollama-ui .

# Build (standalone output for minimal runtime footprint)
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---------- Runtime stage: base Ollama image + UI ----------
FROM ollama/ollama:latest AS final
WORKDIR /app

# Install Node.js and build dependencies for potential native module rebuilding
RUN apt-get update && apt-get install -y \
    curl \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs

# Install pnpm
RUN npm install -g pnpm

# Copy standalone build output
# .next/standalone contains server.js + minimal node_modules; .next/static & public needed for assets
COPY --from=builder /build/ollama-ui/.next/standalone ./
COPY --from=builder /build/ollama-ui/.next/static ./.next/static
COPY --from=builder /build/ollama-ui/public ./public

# Copy package.json and pnpm-lock.yaml for dependency management
COPY --from=builder /build/ollama-ui/package.json ./
COPY --from=builder /build/ollama-ui/pnpm-lock.yaml ./

# Install only production dependencies and rebuild native modules for the runtime environment
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
# Manually build better-sqlite3 using node-gyp
RUN cd /app/node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3 && \
    npm install node-gyp -g && \
    node-gyp configure --module_name=better_sqlite3 --module_path=./build && \
    node-gyp build
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
