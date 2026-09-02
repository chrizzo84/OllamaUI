<p align="center">
  <img src="./ollama-ui/public/ollama-ui.ico" alt="Ollama UI Icon" width="80" />
</p>

<h1 align="center">🦙 Ollama UI 🦙</h1>

<p align="center">
  <b>Modern, reactive web interface for exploring Ollama models, browsing a scraped public catalog, pulling variants with streaming progress, and managing locally installed models.</b>
</p>

<p align="center">
	<em>What exactly is this? You’ll find a short, visual explanation in <a href="./what_is/WHAT_IS.md"><code>what_is/WHAT_IS.md</code></a> (incl. Screenshots). 👈</em>
</p>

## Table of Contents

1. [Features](#1-features-)
2. [Repository Layout](#2-repository-layout-)
3. [Prerequisites](#3-prerequisites-)
4. [Quick Start (UI Only)](#4-quick-start-ui-only-)
5. [Host Resolution Logic](#5-host-resolution-logic-)
   5b. [Access Control](#5b-access-control-)
   5c. [Backups](#5c-backups-)
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
17. [Release Notes](#17-release-notes)

## 1. Features ✨

- 🦙 Browse locally installed Ollama models (name, size, digest, modified date)
- ⏬ Pull / re-pull models (streamed NDJSON progress with derived percentage)
- 🗑️ Delete installed models
- 🌎 Searchable remote model catalog (slug, name & capabilities filtering)
- 🧩 Expandable variant lists with size info and one‑click pull
- 🔒 Global pull lock (avoids concurrent overwriting / race conditions)
- 🏠 Host configuration (cookie + header + env fallback resolution)
- 💬 Chat console with persisted sessions, personas, reasoning/tool-call traces, and a Compare mode to run two models side by side
- 🔌 Chat generation survives closing the tab — runs as a server-side job, reconnect from any tab/device to pick a live reply back up; a global "N generating" badge, toast and tab-title flash tell you when a background reply finishes
- 🛠️ Tool-calling for capable models — `web_search` via SearXNG, `get_current_date`, `get_weather` via Open-Meteo, `calculator`, `create_reminder`, `create_recurring_task`, `list_scheduled_tasks`, `cancel_scheduled_task`, plus `remember_fact` (memory, its own settings section). Each individually toggleable under Settings → Tools, all on by default; a tool turned off there stays off everywhere — web chat, Telegram, scheduled tasks
- 🧠 Persistent memory — the assistant saves durable facts about you and recalls them automatically in future chats; on by default, toggle globally or per-chat
- ⏰ Scheduled tasks — recurring prompts that run automatically at a set time/days, no tab needed; each run lands as a new session with the usual background-job notification. One-off reminders can also be set directly from chat ("remind me tomorrow at 9...") via `create_reminder`; a footer clock shows the server's own time since schedules run on it
- 📱 Telegram bridge (opt-in) — chat with the app from your phone through a Telegram bot, using the same tool-calling/memory engine as the web UI, including sending photos to a vision model, voice messages (transcribed via a local `whisper.cpp` server), documents (PDF/text/code — attach one to summarize or ask about it), tap-to-cancel buttons on `/tasks`, and `/info`/`/tasks`/`/new`/`/help` slash commands. Locked to a single allowlisted Telegram user id; set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID` and `TELEGRAM_MODEL` in `.env.local` to enable it (unset = bridge stays off), plus `TELEGRAM_VISION_MODEL` for photos and `WHISPER_HOST` for voice messages — the combined Docker image bundles `whisper-server` + a model automatically, so `WHISPER_HOST` there just defaults to it. Scheduled tasks and reminders push their result to Telegram too, not just into a new chat session, so they still reach you with no tab open — toggle this specifically under Settings → Telegram (on by default, independent of the bridge's own configuration). The polling loop backs off exponentially on a Telegram-side outage and auto-restarts if it ever crashes, with a "reconnected" notice once it recovers. The bridge's one persistent conversation is marked in the web UI's session list with a small paper-plane icon so it's not mistaken for an ordinary web chat
- 🔁 `create_recurring_task`, `list_scheduled_tasks`, `cancel_scheduled_task` tools — manage scheduled tasks and reminders entirely from chat (Telegram or web), no need to open the Scheduled page; in Telegram, `/tasks` also offers a tap-to-cancel button per task. Every schedule-related claim (created, cancelled, or listed) gets verified against the actual tool-call trace instead of trusting the model's own "done" claim — a fabricated _list_ is replaced outright with the real data rather than just flagged, since it's misinformation about your own data, not just an unconfirmed action
- 💾 Automatic database backups — a snapshot is taken before the one-way messages migration (and the migration is _refused_ if one can't be written), plus a daily one on startup, kept 7 deep in `data/backups/`. Taken with SQLite's `VACUUM INTO`, so they're consistent rather than a copy of a file being written to. Settings → Status shows when the last one happened
- 🔒 Optional password gate — set `APP_PASSWORD` and every page and API route requires a login (30-day session cookie, HMAC-signed, `HttpOnly`). Unset = off, so an existing localhost-only install is unaffected. Settings → Access shows which state you're in and warns when the instance is open
- 📎 Attach documents in the web chat — PDF, text, Markdown, CSV, JSON and source files are extracted to text server-side the moment you pick them (a file that can't be read fails right there, not at send time) and go into the message as readable context. Same extraction the Telegram bridge already used
- 🌿 Branching conversations — Regenerate and editing a message no longer delete what they replace: the new version is stored beside the old one and a `‹ 2 / 3 ›` switcher on the message moves between them, restoring that branch's whole continuation
- 🔌 MCP client — connect Model Context Protocol servers (stdio or HTTP) under Settings → MCP Servers and their tools appear alongside the built-in ones in every chat, in Telegram and in scheduled tasks, with no code change. The list shows what each server actually advertises right now, so a misconfiguration is visible immediately
- 🧪 Evaluations — save the prompts you actually use, run them across several models sequentially, and score the answers side by side with tokens/second shown alongside. Benchmarks tell you which model is fastest; this tells you which is better at your work
- 🗄️ Per-message storage with SQLite FTS5 search — messages live in their own table instead of one JSON blob per session, attachments are stored on disk and content-addressed, and search runs against a real full-text index rather than scanning every conversation in memory
- 🩺 Settings → Status panel — live reachability check for Ollama, the Whisper voice server and the Telegram bridge in one place, including a real Telegram `getMe` call so a revoked/rotated bot token (which otherwise fails silently forever) shows up immediately instead of only as "nothing happens" when you message the bot
- 📈 Model benchmark history — every real chat logs its speed automatically, plus an on-demand fixed-prompt benchmark across all installed models, with a trend chart
- 🗜️ Context compaction — summarize older chat history into a dense context note via the model itself (with undo)
- 📏 Honest context-window badge (real runtime `num_ctx` from `/api/ps`, not the model's theoretical max) + per-model context slider up to the model's maximum
- 🖥️ Running Models page — live `ollama ps` view with CPU/GPU memory split, context window, auto-unload countdown and one-click unload
- 🎨 Theme-adaptive glass UI — 5 accent themes driving an ambient aurora background, glass cards, charts and scrollbars
- 📊 Dashboard with model stats and accessible, colorblind-safe charts
- 🔔 Toast notifications (success / error / info)
- ⚡️ Lightweight state management with Zustand & React Query caching, with per-message memoization and deferred markdown parsing so streaming stays smooth in long conversations
- 🐍 Python scraper (separate directory) to periodically refresh the catalog JSON

---

## 2. Repository Layout 🗂️

```
ollama-ui/        # Next.js (App Router) application
	src/app/        # Pages & API routes
	src/proxy.ts    # Password gate (Next 16's renamed middleware)
	src/lib/        # Server logic: generation, tools, MCP, Telegram, ...
	src/lib/db/     # SQLite: connection.ts owns schema+migrations,
	                #   one module per entity, re-exported by src/lib/db.ts
	src/hooks/      # Client hooks (chat column, attachments, voice input)
	src/store/      # Zustand stores (pull logs, toast, etc.)
	models.json     # Scraped catalog file (copied/updated manually)
	data/           # SQLite database, uploads and backups (gitignored)
Scraper/          # Python async scraper producing models.json
```

`data/` can be moved with `OLLAMA_UI_DATA_DIR` (useful for a Docker volume, and
what the tests use to stay away from the real database).

You run / build only inside `ollama-ui/`. The Python scraper is optional and only needed when you want to regenerate the catalog file.

---

## 3. Prerequisites 🛠️

- Node.js 22.5+ (required for the built-in `node:sqlite` module used for persistence)
- pnpm (preferred) OR npm / yarn / bun
- Python 3.11+ (only if you run the scraper)
- A reachable Ollama server (local or remote) exposing its HTTP API (`/api/pull`, `/api/tags`, etc.)

Optional, per feature — each is unnecessary until you use the feature it backs:

| For                                       | Needs                                                    | Install                                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Attaching **PDFs** (web chat or Telegram) | `pdftotext` from poppler-utils                           | macOS `brew install poppler`, Debian/Ubuntu `apt install poppler-utils`. Bundled in the Docker image. Text/Markdown/CSV/code files need nothing |
| **Voice** messages                        | a running `whisper.cpp` server (`WHISPER_HOST`)          | Bundled in the combined Docker image; see §10                                                                                                   |
| **Web search** tool                       | a SearXNG instance (`SEARXNG_HOST`, or Settings → Tools) | Self-hosted; the tool degrades to no results without it                                                                                         |
| **MCP servers**                           | whatever the server itself needs (often `npx`)           | Configured under Settings → MCP Servers                                                                                                         |

---

## 4. Quick Start (UI Only) 🚦

```bash
cd ollama-ui
pnpm install          # or npm install / yarn
pnpm dev              # start dev server on http://localhost:3000
```

Open http://localhost:3000

If you already have an Ollama instance running locally at the default fallback (see below) the Installed Models list should populate. Otherwise set the host in the UI or via environment.

Nothing works until a host is added and activated — do that first, under
**Settings → Ollama Host**. **Settings → Status** will tell you whether it is
actually reachable.

### Upgrading an existing install

Just start it. Chat messages move out of the per-session JSON blob into their
own table on first start, and inline base64 images move to `data/uploads/` —
automatically, once, reclaiming the freed space (`VACUUM`).

**A snapshot of the database is taken immediately before that migration**, into
`data/backups/`, and if one cannot be written the migration is refused rather
than run unprotected — see [Backups](#backups). So the old advice to copy
`app.db` by hand is no longer necessary; it does no harm if you prefer to
anyway.

Two things are worth setting while you're there: `APP_PASSWORD` (see §5b) if the
instance is reachable from anywhere but localhost, and `pdftotext` (see §3) if
you want to attach PDFs.

---

## 5. Host Resolution Logic 🌐

The active host from the `hosts` table is the only source. Add and activate
it under **Settings → Ollama Host** (the green dot marks the active one);
it's stored server-side, so it's the same host for every browser and for the
Telegram bridge and scheduler, which have no request to read a header from.

Validation enforces a full `http://` or `https://` URL.

> An `x-ollama-host` request header used to override this. Nothing in the app
> ever sent one — the host is chosen in the Host Manager — and all it actually
> did was let any request that reached the server point it at an arbitrary URL
> and read the response back through the chat and model routes. It was removed
> along with the unused `/api/config/ollama-host` route and its cookie.

### Environment

`OLLAMA_HOST` / `NEXT_PUBLIC_OLLAMA_HOST` are only read by
`getDefaultOllamaHost()` — they seed a suggestion, they don't override the
configured host.

---

## 5b. Access Control 🔒

By default the app is **unauthenticated**: anyone who can reach the port can
read your chats and memories, pull and delete models, and drive your Ollama
host. That's fine bound to localhost, and not fine the moment it's reachable
from anywhere else — which is the normal case for the Docker image and the
whole point of the Telegram bridge.

Set a password to turn on the gate:

```bash
# ollama-ui/.env.local  (or the container environment)
APP_PASSWORD=something-long-and-not-guessable
```

With it set, `src/proxy.ts` requires a valid session for every page and every
API route; a browser is redirected to `/login`, an API call gets a `401`.
Sessions last 30 days and live in an HMAC-signed, `HttpOnly` cookie — the
token is never readable from JavaScript. Login attempts are rate-limited per
IP. Leave `APP_PASSWORD` unset and nothing changes from before.

`AUTH_SECRET` is optional: the signing key is derived from the password by
default, so changing the password signs everyone out. Set `AUTH_SECRET`
explicitly if you'd rather sessions survive a password change.

**Settings → Access** shows which state the instance is in, and offers a sign-out.

> ⚠️ **Build requirement:** the password gate lives in `src/proxy.ts`
> (Next 16's renamed middleware). Turbopack compiles it and even lists it in
> the build summary, but does **not** wire it into an `output: standalone`
> server — every request then bypasses it and the gate is silently a no-op.
> `pnpm build` therefore pins `next build --webpack`. Don't run
> `next build` directly without that flag.

---

## 5c. Backups 💾

The database is snapshotted automatically into `data/backups/`. Two triggers,
for two different problems:

| When                                       | Why                                                                                                                                        | On failure                                                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Immediately before a **one-way migration** | The messages migration drops the old column afterwards, deliberately, so there is exactly one source of truth — that step cannot be undone | **Fatal.** The migration is refused, the database is left exactly as it was, and the app reports why. Fix the disk/permissions and restart; the migration simply runs then |
| **Daily**, on the first start of a new day | The slow kind of data loss: a mis-clicked "delete session", a scheduled task that went wrong overnight, filesystem corruption              | Logged and ignored — insurance should never stop the app from starting                                                                                                     |

Snapshots are taken with SQLite's `VACUUM INTO`, not a file copy: a copy of a
live database can miss whatever is still in the write-ahead log, or catch a
write mid-flight. The result is a consistent, already-compact `.db` file.

The newest **7** are kept; older ones are pruned. The restart-in-a-crash-loop
case is handled by the once-a-day rule, so the retained set is never seven
snapshots from the same minute.

**Settings → Status** shows the snapshot count, when the newest was taken and
where they live — an automatic backup nobody can see is one nobody trusts, and
the failure that matters (a read-only volume, so nothing is ever written) is
invisible by definition until you need one.

### Restoring

A snapshot is an ordinary SQLite database. Stop the app, then:

```bash
cd ollama-ui/data
cp app.db app.db.broken            # keep the bad one, just in case
cp backups/app-<timestamp>-<reason>.db app.db
rm -f app.db-wal app.db-shm        # stale journal from the replaced database
```

Start the app again. Note that `data/uploads/` is **not** in the snapshot —
attachments are content-addressed files that are only ever added, never
rewritten, so an older database paired with the current uploads directory is
consistent. Back that directory up separately if you want the images too.

### Settings

| Variable                    | Default | Effect                                                                                                                                                      |
| --------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OLLAMA_UI_BACKUP_KEEP`     | `7`     | How many snapshots to retain                                                                                                                                |
| `OLLAMA_UI_BACKUP_DISABLED` | unset   | `1` turns snapshots off entirely, including the pre-migration one. Only sensible with a read-only volume or an external backup system already covering this |

---

## 6. API Routes Overview 📡

Base path: `/api`

| Route                                                     | Method         | Purpose                                           | Notes                                                                |
| --------------------------------------------------------- | -------------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| `/api/models`                                             | GET            | List installed models + tags                      | Wraps Ollama `/api/tags` (server side implementation not shown here) |
| `/api/models/pull`                                        | POST           | Stream pull of a model or model:variant           | Returns NDJSON, enriches lines with `percentage` when possible       |
| `/api/models/delete`                                      | POST           | Remove a model                                    | Body: `{ model: "name" }`                                            |
| `/api/models/catalog`                                     | GET            | Filtered catalog from `models.json`               | Query: `q`, `limit` (0 = all)                                        |
| `/api/auth/login`                                         | POST/DELETE    | Sign in / sign out                                | Only route reachable without a session                               |
| `/api/attachments/[id]`                                   | GET            | Serve an uploaded file                            | Content-addressed (SHA-256), immutable, cached                       |
| `/api/documents/extract`                                  | POST           | Extract text from an uploaded document            | `multipart/form-data`, field `file`; PDF via `pdftotext`             |
| `/api/sessions/search`                                    | GET            | Full-text search over titles and messages         | Backed by SQLite FTS5                                                |
| `/api/sessions/[id]/branch`                               | POST           | Switch to another version of a message            | Body: `{ messageId }`                                                |
| `/api/sessions/[id]/messages/[messageId]`                 | DELETE         | Delete a message and its subtree                  | Leaves sibling branches intact                                       |
| `/api/settings/mcp`                                       | GET/PUT        | Configured MCP servers                            | GET connects and reports each server's live tools                    |
| `/api/evals/sets`                                         | GET/PUT/DELETE | Saved prompt sets                                 |                                                                      |
| `/api/evals/runs`                                         | GET/POST       | Start and list evaluation runs                    | POST returns immediately; the run outlives the request               |
| `/api/evals/runs/[id]`                                    | GET            | One run with results so far                       | Poll while `status` is `running`                                     |
| `/api/evals/results`                                      | PATCH          | Score one answer                                  | Body: `{ id, rating }`; `null` clears                                |
| Other routes (`chat`, `lamas`, `ps`, `status`, `tools/*`) | —              | Additional functionality (not all documented yet) | Future docs TBD                                                      |

Every route above is behind the password gate when `APP_PASSWORD` is set — see
[Access Control](#5b-access-control-).

### Pull Streaming Contract

`/api/models/pull` emits newline‑delimited JSON objects. Each line may contain:

```
{ status, digest?, total?, completed?, percentage? }
```

If `total` & `completed` exist but `percentage` is missing, the proxy computes and injects it.

Client logic (React) merges these events into a progress bar; a final `{ done: true }` is appended.

---

## 7. Frontend Architecture 🏗️

- **Next.js App Router**: mostly the Node runtime — anything touching the database (which is most of it) cannot run on Edge, since `node:sqlite` isn't available there. `src/proxy.ts` gates every request when a password is configured.
- **React Query**: Data caching & stale control for models and catalog.
- **Zustand Stores**: Lightweight stores for chat messages, sessions, pull logs & toast queue.
- **Hooks**: `use-column-chat` (one chat column's generation lifecycle, including reconnecting to a job started in another tab), `use-attachments` (images + documents in the composer), `use-voice-input` (record → transcribe → fill the composer).
- **Streaming**: Manual `ReadableStream` consumption with incremental parsing of NDJSON lines (`src/lib/chat-stream.ts`).
- **Styling**: Tailwind CSS (v4) + theme-adaptive glass design system (accent-driven aurora background, glass cards, scrollbars) with 5 color themes.
- **Components**: Reusable `<Button />` with variants (`primary`, `outline`, `danger`, etc.).

State highlights:

- `anyPullActive` prevents concurrent pulls.
- `expandedVariants[slug]` toggles full variant list per model.
- Progress derived from last event for the active model.

### Where a chat message actually lives

Worth knowing before changing anything in this area, because the ownership
moved and the old shape is the intuitive-but-wrong one:

1. The browser POSTs to `/api/chat` with the user message and an empty
   assistant placeholder.
2. **The server writes both to the database before contacting Ollama**, then
   runs the generation as a detached job and writes the final content itself.
   That is what lets a reply survive closing the tab.
3. The browser therefore does **not** PATCH the conversation back. A
   full-history write means "this is the conversation now" and would delete
   every branch the tab cannot see — it is used only where that is genuinely
   intended (compaction, undo, clearing).
4. History is a tree, not a list: each message has a `parent_id`, and the
   session points at the active leaf per column. A conversation with no
   branches is just a tree where every node has one child.

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
pnpm dev        # start dev server (webpack, not Turbopack — see below)
pnpm build      # production build (next build --webpack)
pnpm start      # run built app
pnpm lint       # eslint (uses flat config)
pnpm typecheck  # tsc --noEmit
pnpm test       # vitest run
pnpm test:watch # vitest in watch mode
pnpm format     # prettier write
```

**Why webpack, not Turbopack.** Two independent reasons, both of which fail
quietly rather than loudly:

- `next dev --turbopack` cannot load `node:sqlite` at all (see the note at the
  top of `src/lib/db/connection.ts`).
- Turbopack does not wire `src/proxy.ts` into an `output: standalone` build, so
  the password gate silently stops running. `pnpm build` pins `--webpack` for
  exactly this reason.

### Tests

`pnpm test` runs the unit suite (Vitest, node environment, no jsdom) — 391
tests over the pure logic and the database layer. The database tests run
against a real SQLite file in a temp directory (`OLLAMA_UI_DATA_DIR`), never
`data/`, because what's worth testing there — the FTS triggers, the branch
walk, attachment content-addressing — is SQLite's behaviour, not something a
mock would exercise. The MCP tests spawn an actual MCP server process.

Lint, typecheck and tests all run in CI on every push and pull request.

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
2. Compiles `whisper.cpp`'s `whisper-server` from source in its own stage (speech-to-text for Telegram voice messages — Ollama has no audio-input support of its own) and downloads a multilingual model (~465MB; override with `--build-arg WHISPER_MODEL_URL=...` for a smaller/larger one, e.g. `ggml-base.bin` or `ggml-medium.bin` — avoid the `.en`-suffixed variants unless you only ever speak English to it).
3. Uses the official `ollama/ollama:latest` image as the final base.
4. Copies the standalone server + static assets + the compiled `whisper-server` + its model, plus the compiled `instrumentation.js` (and the server chunk(s) it depends on) explicitly — Next's standalone output tracing doesn't include these on its own, which silently prevented the scheduler and Telegram bridge from ever starting in the built image (no error anywhere — confirmed live, see instrumentation.ts's own doc comment and the Dockerfile's comment at this COPY step for the full story).
5. Starts Ollama (`ollama serve`), `whisper-server` (bound to `127.0.0.1` only — internal, never exposed) and the UI (`node server.js`) via `start.sh`.
6. Also installs `ffmpeg` (audio conversion for voice messages) and `poppler-utils` (`pdftotext`, for reading PDF documents sent to the Telegram bridge) via apt-get in the final image.

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

#### Telegram Bridge & Voice Transcription (Docker / Unraid)

`.env.local` (used elsewhere in this doc) only applies to `pnpm dev` — it's never baked into the image or read inside a container. In Docker, set the same variable names as regular container environment variables instead:

```bash
docker run --rm -p 11434:11434 -p 3000:3000 \
	-v /path/to/ollama-models:/root/.ollama \
	-v /path/to/ollama-ui-data:/app/data \
	-e TELEGRAM_BOT_TOKEN=your-bot-token \
	-e TELEGRAM_ALLOWED_USER_ID=your-telegram-user-id \
	-e TELEGRAM_MODEL=llama3.1:8b \
	ollama-ui:latest
```

Same idea in Docker Compose — add them under `environment:` (or `env_file:` pointing at a local file kept out of version control, so the token isn't sitting in `docker-compose.yml` itself):

```yaml
services:
	ollama-ui:
		image: ollama-ui:latest
		environment:
			- TELEGRAM_BOT_TOKEN=your-bot-token
			- TELEGRAM_ALLOWED_USER_ID=your-telegram-user-id
			- TELEGRAM_MODEL=llama3.1:8b
```

**Password protection in Docker**: set `APP_PASSWORD` as a container
environment variable exactly like `OLLAMA_HOST`. This matters more here than
for a local `pnpm dev` — a container is usually reachable from the rest of the
network, and without it every chat, memory and model operation is open to
anyone who can reach the port. Optionally add `AUTH_SECRET` to keep sessions
valid across a password change, and `OLLAMA_UI_DATA_DIR` to point the database
and uploads at a mounted volume.

**Backups in Docker**: snapshots land in `data/backups/` inside the container,
so they only survive a container rebuild if `data/` is a **mounted volume** —
which it should be anyway, since the database lives there. `OLLAMA_UI_BACKUP_KEEP`
and `OLLAMA_UI_BACKUP_DISABLED` are ordinary environment variables like the rest.

**On Unraid**: edit the container → _Add another Path, Port, Variable_ → type **Variable**, with `TELEGRAM_BOT_TOKEN` etc. as Key and the value as Value — no file involved, same as any other env var on that screen (this is also how `OLLAMA_HOST` gets set on Unraid).

Optional additions, same mechanism: `TELEGRAM_VISION_MODEL` (photos, only if `TELEGRAM_MODEL` itself doesn't already report vision support) and `TELEGRAM_MODEL`'s tool-calling requirement carries over unchanged. Voice messages need nothing extra in the combined image — `WHISPER_HOST` already defaults to the bundled `whisper-server` (`http://localhost:8790`, see the Dockerfile section above); only set it yourself to point at a different/external Whisper server instead.

The bot token is a credential like any other — treat it the same way you'd treat `OLLAMA_HOST` credentials or a database password: not in `docker-compose.yml` committed to a repo, not pasted into shell history you'll publish, etc. If it ever leaks, revoke/regenerate it via [@BotFather](https://t.me/BotFather) (`/revoke` or `/token`) — that's cheap and immediate.

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

| Symptom                                                  | Cause                                                                         | Fix                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installed list empty                                     | Wrong host / unreachable Ollama                                               | Set correct host; test `curl <host>/api/tags`. **Settings → Status** reports this directly                                                                                                                                                |
| Pull stuck at 0%                                         | Upstream not streaming `completed/total` yet                                  | Wait; incomplete events still appear in log                                                                                                                                                                                               |
| Host not persisting                                      | —                                                                             | Hosts are stored server-side in the `hosts` table, not in a cookie. If one doesn't stick, check that `data/` is writable (and, in Docker, that it's a mounted volume rather than container-local)                                         |
| Login page never appears, everything is open             | Built with Turbopack                                                          | `pnpm build` must run `next build --webpack`. Turbopack does not wire `src/proxy.ts` into a standalone build, so the gate silently does nothing. Verify with `curl -o /dev/null -w '%{http_code}' <host>/api/sessions` — it must be `401` |
| Password set but you're signed out constantly            | `APP_PASSWORD` changed                                                        | The signing key is derived from the password, so changing it invalidates every session. Set `AUTH_SECRET` explicitly if sessions should survive a password change                                                                         |
| `401` on every API call from an open tab                 | Session expired (30 days)                                                     | Reload; the browser is redirected to `/login`                                                                                                                                                                                             |
| "PDF text extraction needs poppler-utils"                | `pdftotext` not installed                                                     | See §3. Text/Markdown/CSV/code attachments work without it                                                                                                                                                                                |
| An MCP server shows an error under Settings              | Command not found, wrong args, or the server crashed on start                 | The message is the server's own. Its stderr is also logged to the app's console prefixed `[mcp:<id>]`. Other servers keep working                                                                                                         |
| Model tools missing in Telegram or a scheduled task      | A tool is turned off globally                                                 | Settings → Tools applies everywhere, not just the web chat                                                                                                                                                                                |
| App won't start: "Refusing to run the one-way migration" | The pre-migration snapshot couldn't be written (full disk, read-only `data/`) | Intentional — your data is untouched and the migration is still pending. Free space or fix permissions on `data/backups/` and restart. `OLLAMA_UI_BACKUP_DISABLED=1` proceeds without one                                                 |
| Settings → Status says no snapshots                      | Backups disabled, or `data/` not writable                                     | Check `OLLAMA_UI_BACKUP_DISABLED` and that `data/` is a writable volume                                                                                                                                                                   |
| `next dev` fails on `node:sqlite`                        | Turbopack                                                                     | Use `pnpm dev` (webpack). Turbopack cannot load `node:sqlite` at all                                                                                                                                                                      |

---

## 12. Roadmap / Ideas 🗺️

- Persist catalog search & expansion state (localStorage)
- Per-variant progress indicator (when layers known)
- Multi-pull queue (sequential)
- Download speed & ETA estimation
- Keyboard shortcuts (focus search, abort pull)
- RAG over a local folder — embeddings via Ollama's `/api/embed`, alongside the
  existing memory feature
- Modelfile editor — build a model from a base + system prompt + parameters, so
  a persona can become a real Ollama model usable outside this app
- MCP: resources and prompts (only tools are implemented today)

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

| Stack                | Key Tools                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Framework            | Next.js App Router (Node runtime; webpack build, see §9)                                                                      |
| Backups              | `VACUUM INTO` snapshots in `data/backups/`, pre-migration + daily, 7 retained                                                 |
| Persistence          | SQLite via `node:sqlite` — messages, sessions, memories, evals; FTS5 full-text search; attachments on disk, content-addressed |
| Auth                 | Optional single-user password gate in `src/proxy.ts`, Web Crypto HMAC sessions                                                |
| Data                 | React Query, NDJSON streaming                                                                                                 |
| State                | Zustand                                                                                                                       |
| Styling              | Tailwind CSS v4, theme-adaptive glass design system, motion via Framer Motion                                                 |
| Backend Integrations | Ollama HTTP API, MCP (stdio + HTTP), SearXNG, Open-Meteo, whisper.cpp, Telegram Bot API                                       |
| Testing              | Vitest (391 unit tests), run in CI with lint + typecheck                                                                      |
| Scraping             | Python (httpx, BeautifulSoup, tenacity)                                                                                       |

---

<p align="center">
  🚀 Happy hacking! Pull, explore, iterate. 🦙
</p>

## 16. Disclaimer / Infos

<details>
<summary><strong>⚡️ Disclaimer: Vibe Coding & Copilot ⚡️</strong></summary>

---

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

**Update:** `better-sqlite3` was later dropped entirely (briefly replaced with plain JSON files,
then with Node's own built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) module,
available from Node 22.5+). Since it ships inside the Node binary itself, there's no native
addon to compile per platform anymore — the whole class of problem above no longer applies.

</details>

---

### 17. Release Notes

See the latest changes and release notes [here](./ollama-ui/public/news/News.md)
