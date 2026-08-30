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

# ---------- Build stage: compile whisper.cpp's whisper-server binary ----------
# Speech-to-text for Telegram voice messages (see
# src/lib/telegram-bridge.ts's transcribeVoice/notifyTelegram) — Ollama has
# no audio-input model support at all, this is a wholly separate local
# service. Built from source (rather than trusting a third-party prebuilt
# image) so the final stage below only needs the one compiled binary, no
# build toolchain.
FROM debian:bookworm-slim AS whisper-builder
RUN apt-get update \
 && apt-get install -y --no-install-recommends git cmake build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# Pinned to the exact version this integration was built and live-tested
# against (see PLAN/session notes) — bump deliberately, not implicitly.
RUN git clone --branch v1.9.2 --depth 1 https://github.com/ggml-org/whisper.cpp.git .
# GGML_NATIVE=OFF: auto-detected -march flags can mismatch the fp16 NEON
# intrinsics ggml's CPU backend uses on some GCC/aarch64 combinations inside
# Docker (seen live: "target specific option mismatch" on vfmaq_f16),
# because native detection reads the *build* machine's features, not a
# fixed target. That alone still left AVX2/FMA/F16C compiled in on x86_64
# (ggml's own defaults, independent of NATIVE), which ghcr.io's arbitrary
# CI/self-hosted pull targets aren't guaranteed to have — disabled
# explicitly so the binary only requires baseline x86-64 (SSE2). (A
# same-machine x86_64-under-QEMU run of the AVX2 build hit "Illegal
# instruction" and, even after this change, still crashed in a way ptrace
# itself couldn't diagnose inside that nested emulation — inconclusive on
# its own, but this flag set is the strictly-more-portable choice either
# way, so kept regardless of the ambiguous local result. Confirm via the
# actual docker-publish.yml CI run, which builds linux/amd64 on real
# hardware.) Not the hot path (occasional voice-message transcription), so
# the portability is worth more than the SIMD speedup.
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_SDL2=OFF -DGGML_NATIVE=OFF \
      -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF \
 && cmake --build build --config Release -j --target whisper-server

# ---------- Runtime stage: base Ollama image + UI ----------
FROM ollama/ollama:latest AS final
WORKDIR /app

# Install Node.js (no build tools needed – no native modules anymore),
# ffmpeg (converts Telegram's OGG/Opus voice notes to the WAV whisper-server
# expects — src/lib/whisper.ts) and poppler-utils, whose `pdftotext` extracts
# text from a PDF document sent via Telegram (src/lib/document-extract.ts).
RUN apt-get clean \
 && apt-get update \
 && for i in 1 2 3; do apt-get install -y --fix-missing curl ffmpeg poppler-utils && break || sleep 5; done \
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

# instrumentation.ts (starts the scheduler and Telegram bridge — see
# instrumentation.ts's own doc comment) is NOT included by Next's standalone
# output tracing: it only copies instrumentation.ts's raw *source* into
# .next/standalone/instrumentation.ts, never the actually-compiled
# .next/server/instrumentation.js the runtime needs to load it, nor that
# compiled file's own Turbopack-split runtime chunk(s) under
# .next/server/chunks/ (build now defaults to Turbopack, which splits
# instrumentation.js's dependencies into a separate numbered chunk file that
# isn't traced as a dependency of any page/route, so the standalone copy
# skips it too). Without this, Next silently swallows the resulting
# MODULE_NOT_FOUND (see next/dist/server/next-server.js's
# loadInstrumentationModule) and instrumentation.ts's register() never runs
# at all in the deployed container — no error, no log line, nothing —
# meaning the scheduler and Telegram bridge silently never start. Confirmed
# live: a `getMe`-valid, correctly-configured Telegram bot did genuinely
# nothing when messaged, and reproduced+fixed locally by running the actual
# standalone `node server.js` output directly instead of only ever testing
# via `next dev` (which loads instrumentation differently and never hit
# this). Copying the whole chunks/ directory (not just the one missing
# chunk) is deliberate — which chunk(s) instrumentation.js's dependencies
# land in is a Turbopack build-output implementation detail, not something
# to hardcode and have silently break again on a Next.js/Turbopack update.
COPY --from=builder /build/ollama-ui/.next/server/instrumentation.js ./.next/server/instrumentation.js
COPY --from=builder /build/ollama-ui/.next/server/chunks ./.next/server/chunks

# Copy package.json, pnpm-lock.yaml and pnpm-workspace.yaml (has the
# dependency "overrides") for dependency management
COPY --from=builder /build/ollama-ui/package.json ./
COPY --from=builder /build/ollama-ui/pnpm-lock.yaml ./
COPY --from=builder /build/ollama-ui/pnpm-workspace.yaml ./

# Install production dependencies (pure JS only, no native modules to compile)
RUN HUSKY=0 pnpm install --prod --frozen-lockfile --ignore-scripts
# (No local models.json needed; catalog fetched at runtime from remote repository)

# whisper-server binary + its shared libs (all live alongside it in the
# build output — resolved via relative rpath, confirmed with `ldd` against
# this exact layout, so they must stay in the same directory together).
COPY --from=whisper-builder /build/build/bin/ /app/whisper-server/

# Multilingual model (~465MB — NOT one of the `.en`-suffixed variants,
# which can only transcribe English; see WHISPER_MODEL_URL to swap for a
# smaller/larger one, e.g. ggml-base.bin for a lighter image or
# ggml-medium.bin for better accuracy at the cost of more RAM/CPU per
# transcription).
ARG WHISPER_MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
RUN mkdir -p /app/whisper-models \
 && curl -fsSL "$WHISPER_MODEL_URL" -o /app/whisper-models/model.bin

# Optional: default env (can be overridden). Use internal service host.
ENV OLLAMA_HOST="http://localhost:11434" \
    NODE_ENV=production \
    PORT=3000 \
    OLLAMA_LISTEN="0.0.0.0:11434" \
    WHISPER_HOST="http://localhost:8790"

# Start script to run Ollama, whisper-server (if present) and the Next.js UI.
COPY <<'EOF' /app/start.sh
#!/usr/bin/env bash
set -euo pipefail

# Start Ollama server in background (listens on 11434 by default)
echo "[start] launching ollama server on ${OLLAMA_LISTEN:-0.0.0.0:11434}" >&2
OLLAMA_HOST="${OLLAMA_LISTEN:-0.0.0.0:11434}" ollama serve &
OLLAMA_PID=$!

# Speech-to-text for Telegram voice messages — optional, only used if
# TELEGRAM_BOT_TOKEN is also set (see src/lib/telegram-bridge.ts). Binds to
# 127.0.0.1 only: it's for this container's own Next.js process to call,
# never meant to be reachable from outside. `-l auto` auto-detects the
# spoken language per message instead of assuming one.
WHISPER_PORT="${WHISPER_HOST##*:}"
if [ -x /app/whisper-server/whisper-server ] && [ -f /app/whisper-models/model.bin ]; then
  echo "[start] launching whisper-server on 127.0.0.1:${WHISPER_PORT}" >&2
  # The binary's shared libs (libwhisper/libggml*) live alongside it in the
  # same directory rather than a system lib path — confirmed live that the
  # dynamic linker doesn't find them there on its own ("cannot open shared
  # object file") without this.
  LD_LIBRARY_PATH="/app/whisper-server:${LD_LIBRARY_PATH:-}" \
    /app/whisper-server/whisper-server \
    -m /app/whisper-models/model.bin --host 127.0.0.1 --port "${WHISPER_PORT}" -l auto &
else
  echo "[start] whisper-server binary/model not found, skipping (voice messages will be declined)" >&2
fi

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
