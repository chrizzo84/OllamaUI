

<p align="center">
  <img src="./ollama-ui/public/ollama-ui.ico" alt="Ollama UI Icon" width="80" />
</p>

<h1 align="center">🦙 Ollama UI 🦙</h1>


<p align="center">
  <b>Modern, reactive web interface for exploring Ollama models, browsing a scraped public catalog, pulling variants with streaming progress, and managing locally installed models.</b>
</p>


## Table of Contents

1. [Features](#1-features-)
2. [Repository Layout](#2-repository-layout-)
3. [Prerequisites](#3-prerequisites-)
4. [Quick Start (UI Only)](#4-quick-start-ui-only-)
5. [Host Resolution Logic](#5-host-resolution-logic-)
6. [API Routes Overview](#6-api-routes-overview-)
7. [Frontend Architecture](#7-frontend-architecture-)
8. [Python Scraper](#8-python-scraper-)
9. [Development Workflow](#9-development-workflow-)
10. [Deployment](#10-deployment-)
11. [Troubleshooting](#11-troubleshooting-)
12. [Roadmap / Ideas](#12-roadmap--ideas-)
13. [Contributing](#13-contributing-)
14. [License](#14-license-)
15. [At A Glance](#15-at-a-glance-)
16. [Disclaimer / Infos](#16-disclaimer--infos-)

## 1. Features ✨


- 🦙 Browse locally installed Ollama models (name, size, digest, modified date)
- ⏬ Pull / re-pull models (streamed NDJSON progress with derived percentage)
- 🗑️ Delete installed models
- 🌎 Searchable remote model catalog (slug, name & capabilities filtering)
- 🧩 Expandable variant lists with size info and one‑click pull
- 🔒 Global pull lock (avoids concurrent overwriting / race conditions)
- 🏠 Host configuration (cookie + header + env fallback resolution)
- 🎨 Consistent gradient UI theme + custom scrollbars
- 🔔 Toast notifications (success / error / info)
- ⚡️ Lightweight state management with Zustand & React Query caching
- 🐍 Python scraper (separate directory) to periodically refresh the catalog JSON

---


## 2. Repository Layout 🗂️

```
ollama-ui/        # Next.js (App Router) application
	src/app/        # Pages & API routes
	src/lib/        # Environment + utility helpers
	src/store/      # Zustand stores (pull logs, toast, etc.)
	models.json     # Scraped catalog file (copied/updated manually)
Scraper/          # Python async scraper producing models.json
```

You run / build only inside `ollama-ui/`. The Python scraper is optional and only needed when you want to regenerate the catalog file.

---


## 3. Prerequisites 🛠️

- Node.js 18.18+ or 20+ (recommended LTS)
- pnpm (preferred) OR npm / yarn / bun
- Python 3.11+ (only if you run the scraper)
- A reachable Ollama server (local or remote) exposing its HTTP API (`/api/pull`, `/api/tags`, etc.)

---


## 4. Quick Start (UI Only) 🚦

```bash
cd ollama-ui
pnpm install          # or npm install / yarn
pnpm dev              # start dev server on http://localhost:3000
```

Open http://localhost:3000

If you already have an Ollama instance running locally at the default fallback (see below) the Installed Models list should populate. Otherwise set the host in the UI or via environment.

---


## 5. Host Resolution Logic 🌐

Order of precedence (first valid wins):
1. Request header: `x-ollama-host`
2. Browser cookie: `ollama_host` (set via the Host form)
3. Environment: `OLLAMA_HOST` or `NEXT_PUBLIC_OLLAMA_HOST`
4. Hardcoded fallback in `src/lib/env.ts`

Validation enforces a full `http://` or `https://` URL.

### Set via UI
Use the Host box on the Models page, enter full URL (e.g. `http://localhost:11434`) and press “Set host”. Cookie persists for 7 days.

### Set via Env
Create `.env.local` in `ollama-ui/`:
```
OLLAMA_HOST=http://localhost:11434
```

Restart dev server.

### Override Per Request
Send a custom header (useful for testing):
```
curl -H "x-ollama-host: http://other-host:11434" http://localhost:3000/api/models
```

---


## 6. API Routes Overview 📡

Base path: `/api`

| Route | Method | Purpose | Notes |
|-------|--------|---------|-------|
| `/api/models` | GET | List installed models + tags | Wraps Ollama `/api/tags` (server side implementation not shown here) |
| `/api/models/pull` | POST | Stream pull of a model or model:variant | Returns NDJSON, enriches lines with `percentage` when possible |
| `/api/models/delete` | POST | Remove a model | Body: `{ model: "name" }` |
| `/api/models/catalog` | GET | Filtered catalog from `models.json` | Query: `q`, `limit` (0 = all) |
| `/api/config/ollama-host` | GET/POST | Get or set resolved host | POST body: `{ host: string }` |
| Other routes (`chat`, `stream`, `lamas`, `ps`, `tools/*`) | — | Additional functionality (not all documented yet) | Future docs TBD |

### Pull Streaming Contract
`/api/models/pull` emits newline‑delimited JSON objects. Each line may contain:
```
{ status, digest?, total?, completed?, percentage? }
```
If `total` & `completed` exist but `percentage` is missing, the proxy computes and injects it.

Client logic (React) merges these events into a progress bar; a final `{ done: true }` is appended.

---


## 7. Frontend Architecture 🏗️

- **Next.js App Router**: Server + edge runtime mixing (pull uses Edge for low latency, catalog read uses Node for FS access).
- **React Query**: Data caching & stale control for models and catalog.
- **Zustand Stores**: Lightweight stores for pull logs & toast queue.
- **Streaming**: Manual `ReadableStream` consumption with incremental parsing of NDJSON lines.
- **Styling**: Tailwind CSS (v4) + custom gradients + scrollbar styling (WebKit + Firefox).
- **Components**: Reusable `<Button />` with variants (`primary`, `outline`, `danger`, etc.).

State highlights:
- `anyPullActive` prevents concurrent pulls.
- `expandedVariants[slug]` toggles full variant list per model.
- Progress derived from last event for the active model.

---


## 8. Python Scraper 🐍

Location: `Scraper/`

Purpose: Crawl public model pages, produce `models.json` with:
- `scraped_at`
- For each model: `slug`, `name`, `pulls`, `pulls_text`, `capabilities[]`, `blurb`, `description`, `tags_count`, `variants[]` (each variant: tag, size, size_text, context tokens, input tokens)

### Run
```bash
cd Scraper
python -m venv .venv && source .venv/bin/activate   # one time
pip install -r requirements.txt
python ollama_scraper.py           # full scrape
python ollama_scraper.py --limit 50  # first 50 models for quick test
```

Output: `out/models.json`. Copy or move that file into `ollama-ui/models.json` (overwrite existing) so the catalog endpoint serves it.

### Schedule (Optional)
Use `cron` or a CI workflow to periodically update the file. Example cron entry (daily at 02:30):
```
30 2 * * * /usr/bin/bash -lc 'cd /path/to/repo/Scraper && source .venv/bin/activate && python ollama_scraper.py && cp out/models.json ../ollama-ui/models.json'
```

---


## 9. Development Workflow 🧑‍💻

Common scripts:
```bash
pnpm dev     # start dev w/ Turbopack
pnpm build   # production build
pnpm start   # run built app
pnpm lint    # eslint (uses flat config)
pnpm format  # prettier write
```

After updating `models.json`, no restart is strictly required (catalog route reads file each request) but browser cache is bypassed anyway (`cache: 'no-store'`). Just refresh.

---


## 10. Deployment 🚀

You can deploy like any standard Next.js app (Vercel, Docker, etc.). Requirements:
- Ensure `models.json` is present in the build output (it is read at runtime, so keep it in project root of the app).
- Provide `OLLAMA_HOST` environment variable or rely on user-set cookie.
- If deploying serverless, note: the catalog route uses Node runtime (filesystem). Ensure hosting platform supports reading that static file at runtime.

### Docker (Combined Ollama + UI)

This repository now includes a multi‑stage `Dockerfile` at repo root that:
1. Builds the Next.js app (standalone) with Node 20.
2. Uses the official `ollama/ollama:latest` image as the final base.
3. Copies the standalone server + static assets + `models.json`.
4. Starts both Ollama (`ollama serve`) and the UI (`node server.js`) via `start.sh`.

Build & run:
```bash
docker build -t ollama-ui:latest .
docker run --rm -p 11434:11434 -p 3000:3000 ollama-ui:latest
```

Then open http://localhost:3000 (UI) and Ollama API at http://localhost:11434.

#### Docker Volumes: Persist Models & Database

To persist Ollama models and the UI database outside the container, mount host directories as volumes:

```bash
docker run --rm -p 11434:11434 -p 3000:3000 \
	-v /path/to/ollama-models:/root/.ollama \
	-v /path/to/ollama-ui-data:/app/data \
	ollama-ui:latest
```

- `/root/.ollama`: stores all pulled Ollama models (can be reused across containers/updates)
- `/app/data`: stores the SQLite database (`app.db`) for UI state (profiles, logs, etc.)

**Docker Compose Example:**
```yaml
services:
	ollama-ui:
		image: ollama-ui:latest
		build: .
		ports:
			- "11434:11434"
			- "3000:3000"
		volumes:
			- /path/to/ollama-models:/root/.ollama
			- /path/to/ollama-ui-data:/app/data
volumes: {}
```

Override default host the UI uses:
```bash
docker run --rm -e OLLAMA_HOST=http://localhost:11434 -p 11434:11434 -p 3000:3000 ollama-ui:latest
```

#### Prebuilt Images (Combined Ollama + UI)

You can use prebuilt images from GitHub Container Registry (GHCR):

- [ghcr.io/chrizzo84/ollamaui](https://github.com/chrizzo84/OllamaUI/pkgs/container/ollamaui)

Pull and run:
```bash
docker pull ghcr.io/chrizzo84/ollamaui:latest
docker run --rm -p 11434:11434 -p 3000:3000 ghcr.io/chrizzo84/ollamaui:latest
```

If you want to disable the bundled Ollama server and point only to an external one, you can adapt `start.sh` to skip `ollama serve` and only run `node server.js`.

#### GPU Passthrough

Ollama can leverage GPUs inside the same container. Usage differs by platform:

**NVIDIA (Linux)**
Prerequisites: Install the NVIDIA Container Toolkit on the host.
```bash
docker run --rm \
	--gpus=all \
	-p 11434:11434 -p 3000:3000 \
	-v ollama_models:/root/.ollama \
	ollama-ui:latest
```
Limit GPU visibility (e.g. only GPU 0):
```bash
docker run --rm --gpus 'device=0' -p 11434:11434 -p 3000:3000 ollama-ui:latest
```

**Docker Compose Example** (`docker-compose.yml` at repo root):
```yaml
services:
	ollama-ui:
		image: ollama-ui:latest
		build: .
		ports:
			- "11434:11434"
			- "3000:3000"
		volumes:
			- ollama_models:/root/.ollama
		deploy:
			resources:
				reservations:
					devices:
						- capabilities: [gpu]
		environment:
			- OLLAMA_HOST=http://localhost:11434
volumes:
	ollama_models:
```

**Apple Silicon (Metal)**
Metal acceleration is available natively when running Ollama directly on macOS. Docker GPU passthrough for Metal is not currently supported in the same way; prefer running Ollama on the host and pointing the container UI to it:
```bash
docker run --rm -e OLLAMA_HOST=http://host.docker.internal:11434 -p 3000:3000 ollama-ui:latest
```

**AMD ROCm**
If your base image / host supports ROCm and `ollama/ollama` adds ROCm builds in future, you would expose the devices similarly (e.g. `--device=/dev/dri`); consult upstream Ollama documentation.

Verify GPU usage after starting:
```bash
docker exec -it <container> ollama ps
```
Or on host: `nvidia-smi` (NVIDIA) while a model runs.

---


## 11. Troubleshooting 🕵️‍♂️

| Symptom | Cause | Fix |
|---------|-------|-----|
| Installed list empty | Wrong host / unreachable Ollama | Set correct host; test `curl <host>/api/tags` |
| Pull stuck at 0% | Upstream not streaming `completed/total` yet | Wait; incomplete events still appear in log |
| Host not persisting | Cookies blocked | Allow site cookies or set via env variable |

---


## 12. Roadmap / Ideas 🗺️

- Persist catalog search & expansion state (localStorage)
- Per-variant progress indicator (when layers known)
- Multi-pull queue (sequential)
- Download speed & ETA estimation
- Dark/light theme toggle
- Keyboard shortcuts (focus search, abort pull)

---


## 13. Contributing 🤝

1. Fork & clone
2. Create a branch: `feat/my-feature`
3. Run `pnpm dev` and implement
4. Ensure lint passes: `pnpm lint`
5. Open PR with description & screenshots

---


## 14. License 📜

Distributed under the MIT License. See the `LICENSE` file for full text.

---


## 15. At A Glance 👀

| Stack | Key Tools |
|-------|-----------|
| Framework | Next.js App Router (Edge + Node runtime) |
| Data | React Query, NDJSON streaming |
| State | Zustand |
| Styling | Tailwind CSS v4, custom gradients, motion via Framer Motion |
| Backend Integrations | Ollama HTTP API |
| Scraping | Python (httpx, BeautifulSoup, tenacity) |

---

<p align="center">
  🚀 Happy hacking! Pull, explore, iterate. 🦙
</p>


## 16. Disclaimer / Infos

<details>
<summary><strong>⚡️ Disclaimer: Vibe Coding & Copilot ⚡️</strong></summary>

<p>
<em>
🚀 This app was created exclusively through <strong>Vibe Coding</strong> – basically just as a test of GPT-5 via GitHub Copilot.<br>
🤖 The code is more or less unreviewed, spontaneous, and full of AI magic.<br>
🐛 If you find bugs, feel free to keep them or just continue developing with the vibe.<br>
<br>
<strong>⚠️ Use at your own risk – but with maximum fun! 🎉</strong>
</em>
</p>
</details>

---
---

<details>
<summary><strong>🔧 Docker Native Module Challenge: better-sqlite3 ⚡️</strong></summary>

<p>
<em>
<strong>The Challenge:</strong> Native module <code>better-sqlite3</code> failed in Docker with "invalid ELF header" error<br>
<strong>The Problem:</strong> Architecture mismatch between build environment (macOS ARM64) and runtime (Linux ARM64)<br>
<strong>Failed Solutions:</strong> Standard <code>pnpm rebuild</code>, copying pre-built modules, multi-stage builds<br>
<br>
<strong>✅ The Solution:</strong> Manual runtime compilation using <code>node-gyp</code> with full build dependencies<br>
<strong>🤖 AI Collaboration:</strong> Problem solved through iterative debugging with <strong>Claude 3.5 Sonnet</strong><br>
<strong>⚠️ Note:</strong> Unfortunately, GPT-4 and GPT-5 couldn't solve this complex native module compilation issue<br>
<br>
<strong>Key Learning:</strong> Native modules require careful architecture-specific compilation in containerized environments 🐋
</em>
</p>

```dockerfile
# The winning approach: Manual node-gyp compilation at runtime
RUN cd /app/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && \
    npm install node-gyp -g && \
    node-gyp configure --module_name=better_sqlite3 --module_path=./build && \
    node-gyp build
```

</details>



---





