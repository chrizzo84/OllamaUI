<h1 align="center">Ollama UI</h1>

Modern, reactive web interface for exploring Ollama models, browsing a scraped public catalog, pulling variants with streaming progress, and managing locally installed models.

---

## 1. Features

- Browse locally installed Ollama models (name, size, digest, modified date)
- Pull / re-pull models (streamed NDJSON progress with derived percentage)
- Delete installed models
- Searchable remote model catalog (slug, name & capabilities filtering)
- Expandable variant lists with size info and one‑click pull
- Global pull lock (avoids concurrent overwriting / race conditions)
- Host configuration (cookie + header + env fallback resolution)
- Consistent gradient UI theme + custom scrollbars
- Toast notifications (success / error / info)
- Lightweight state management with Zustand & React Query caching
- Python scraper (separate directory) to periodically refresh the catalog JSON

---

## 2. Repository Layout

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

## 3. Prerequisites

- Node.js 18.18+ or 20+ (recommended LTS)
- pnpm (preferred) OR npm / yarn / bun
- Python 3.11+ (only if you run the scraper)
- A reachable Ollama server (local or remote) exposing its HTTP API (`/api/pull`, `/api/tags`, etc.)

---

## 4. Quick Start (UI Only)

```bash
cd ollama-ui
pnpm install          # or npm install / yarn
pnpm dev              # start dev server on http://localhost:3000
```

Open http://localhost:3000

If you already have an Ollama instance running locally at the default fallback (see below) the Installed Models list should populate. Otherwise set the host in the UI or via environment.

---

## 5. Host Resolution Logic

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

## 6. API Routes Overview

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

## 7. Frontend Architecture

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

## 8. Python Scraper

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

## 9. Development Workflow

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

## 10. Deployment

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

Persist Ollama models by mounting its data directory (inside the base image it is usually `/root/.ollama`):
```bash
docker run --rm -p 11434:11434 -p 3000:3000 \
	-v ollama_models:/root/.ollama \
	ollama-ui:latest
```

Override default host the UI uses:
```bash
docker run --rm -e OLLAMA_HOST=http://localhost:11434 -p 11434:11434 -p 3000:3000 ollama-ui:latest
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

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Installed list empty | Wrong host / unreachable Ollama | Set correct host; test `curl <host>/api/tags` |
| Pull stuck at 0% | Upstream not streaming `completed/total` yet | Wait; incomplete events still appear in log |
| Catalog empty | `models.json` missing or empty | Place a valid file at `ollama-ui/models.json` |
| 500 on catalog route | JSON parse error | Validate JSON (run `jq . models.json`) |
| Host not persisting | Cookies blocked | Allow site cookies or set via env variable |

---

## 12. Roadmap / Ideas

- Persist catalog search & expansion state (localStorage)
- Per-variant progress indicator (when layers known)
- Multi-pull queue (sequential)
- Download speed & ETA estimation
- Dark/light theme toggle
- Keyboard shortcuts (focus search, abort pull)

---

## 13. Contributing

1. Fork & clone
2. Create a branch: `feat/my-feature`
3. Run `pnpm dev` and implement
4. Ensure lint passes: `pnpm lint`
5. Open PR with description & screenshots

---

## 14. License

Distributed under the MIT License. See the `LICENSE` file for full text.

---

## 15. At A Glance

| Stack | Key Tools |
|-------|-----------|
| Framework | Next.js App Router (Edge + Node runtime) |
| Data | React Query, NDJSON streaming |
| State | Zustand |
| Styling | Tailwind CSS v4, custom gradients, motion via Framer Motion |
| Backend Integrations | Ollama HTTP API |
| Scraping | Python (httpx, BeautifulSoup, tenacity) |

---

Happy hacking! Pull, explore, iterate.
