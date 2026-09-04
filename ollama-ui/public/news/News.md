Chronological list of notable changes to Ollama UI.

## 2026-09-04

- **Web search no longer fails silently** — every failure mode of a SearXNG request (unreachable host, HTTP error, a reply that isn't JSON) was caught and turned into `null`, so `web_search` returned a perfectly successful-looking `{results: [], total: 0}`. That is indistinguishable from "the web genuinely has nothing on this", and a model handed an empty result set answers from memory instead — confidently, often with invented figures, while the chat shows a tool call that apparently worked. Found while investigating a model that seemed to refuse tool calls: the search backend on the configured port was a different service entirely, answering `200 OK` with HTML. When every page of a search fails the tool now reports an error naming the reason and the host, and a partial failure returns the results that did arrive plus a `warnings` list. The "not JSON" case says so explicitly, because a SearXNG without its `json` output format enabled is the single most common way to get here. Search terms are kept out of the message — only the host is named.
- **Tool calls split across stream chunks are no longer dropped** — the streaming reader assigned each chunk's `tool_calls` over the previous ones instead of appending, so a turn whose calls arrived in more than one chunk kept only the last batch. Ollama currently sends them together for the models tested here, which is why this never surfaced; it was a silent data loss waiting for a model/template combination that splits them.
- **The model can see the tool calls its own earlier replies made** — only a reply's final text is persisted as a message; the calls themselves live in that message's trace and were dropped when the history went back upstream. The model was therefore shown a conversation in which it had apparently answered every "look this up" without ever touching a tool, which is precedent to skip the tool next time and answer from memory. The stored trace is now expanded back into the assistant/`tool` message pair it came from, with results capped so a long chat can't be flooded by replays. Applies to the web chat, Telegram and scheduled tasks alike, since all three run through the same engine.
- **Tests** — 403 now, up from 395. The two that asserted web search's old silent-failure behaviour were rewritten to the new contract, and the trace replay has its own suite.

## 2026-09-02

- **Automatic database backups**
  - A snapshot is written to `data/backups/` immediately before the one-way messages migration below — and if one **cannot** be written (full disk, read-only volume), the migration is **refused** rather than run unprotected. The database is left exactly as it was and the migration simply runs on the next start once the problem is fixed. Aborting is the point: a one-way migration with no way back is precisely the situation worth failing loudly over.
  - Plus a routine snapshot on the first start of each day, for the slower kind of data loss — a mis-clicked "delete session", a scheduled task that went wrong overnight, filesystem corruption. That one is best-effort and never blocks startup.
  - Taken with SQLite's `VACUUM INTO`, not a file copy: a copy of a live database can miss whatever is still in the write-ahead log, or catch a write mid-flight. The result is consistent and already compacted.
  - Newest 7 kept (`OLLAMA_UI_BACKUP_KEEP`), the once-a-day rule keeps a container crash loop from filling that with seven snapshots from the same minute. `OLLAMA_UI_BACKUP_DISABLED=1` turns it off. **Settings → Status** shows the count and when the newest was taken, because a backup nobody can see is one nobody trusts — and "no snapshots are being written" is otherwise invisible until you need one.
- **Optional password gate**
  - Set `APP_PASSWORD` and every page and API route requires a login; unset it and nothing changes, so an existing localhost-only install is untouched. Before this, anyone who could reach the port could read every chat and stored memory, and pull or delete models — fine bound to localhost, not fine for the Docker image or anything reachable from the rest of the network.
  - Sessions are a 30-day HMAC-signed, `HttpOnly` cookie (Web Crypto, no dependency); the token is never readable from JavaScript. Login attempts are rate-limited per IP. `AUTH_SECRET` is optional and keeps sessions alive across a password change; by default the key is derived from the password, so changing it signs everyone out.
  - **Settings → Access** shows whether the gate is on and offers a sign-out — an unprotected instance otherwise looks identical to a protected one, which is how it stays unprotected by accident.
  - Caught while verifying this end-to-end rather than trusting a green build: Turbopack compiles `src/proxy.ts` and even lists it in the build summary, but does **not** wire it into an `output: standalone` server — every request bypassed it and the gate was silently a no-op. `pnpm build` now pins `next build --webpack`.
- **Two server-side request forgery holes closed**
  - The `x-ollama-host` request header let any caller point the server at an arbitrary URL and read the response back through the chat and model routes. Nothing in the app ever sent it — the host comes from the Host Manager — so it was removed outright, along with the unused `/api/config/ollama-host` route and its cookie.
  - `x-searxng-endpoint-template` did the same thing for web search. The value was already stored server-side (Settings → Tools), so the header was duplicating state as well as widening the attack surface. Reading the stored setting also fixed a real bug: a configured SearXNG endpoint was being ignored entirely for Telegram messages and scheduled tasks, which had no header to carry it.
- **Attach documents in the web chat** — PDF, text, Markdown, CSV, JSON and source files. The extraction already existed but only Telegram could reach it, so you could summarize a PDF from your phone and not from the app the PDF was sitting next to. Files are extracted the moment you pick them, so one that can't be read fails right there instead of silently going nowhere at send time.
- **Branching conversations** — Regenerate and editing a message no longer delete what they replace. The new version is stored beside the old one, and a `‹ 2 / 3 ›` switcher on the message moves between them, restoring that branch's whole continuation rather than truncating at the switch point. Regenerate was quietly risky to press before: a reply you preferred was gone the moment you were curious whether another try would be better.
- **MCP client** — connect Model Context Protocol servers (stdio or HTTP) under **Settings → MCP Servers** and their tools show up alongside the built-in ones in every chat, in Telegram and in scheduled tasks, with no code change. Tools were hard-coded before, so adding one meant editing `generation-runner.ts` and redeploying. The settings list connects on read and shows what each server actually advertises right now — "did my config work?" is the only question that page exists to answer. Tools are namespaced (`mcp__server__tool`) so two servers can't shadow each other or a built-in. A server that's down contributes nothing and says why, rather than costing you the reply.
- **Evaluations** — a new page: save the prompts you actually use, run them across several models sequentially, and score the answers side by side with tokens/second shown alongside. The existing benchmark answers "which model is fastest"; the question you have when picking a local model is "which is better at my work", and no fixed prompt can answer that. Runs outlive the tab that started them and fill in row by row.
- **Messages moved out of the session blob**
  - Every message used to live in one JSON blob per session, so appending a token's worth of state rewrote the whole conversation, the sidebar deserialized every message of every session just to show a count, and search scanned all of it in memory.
  - Messages now have their own table, search runs against a SQLite FTS5 index, and the sidebar uses one grouped `COUNT`.
  - Attached images moved out of that blob too, onto disk, content-addressed by SHA-256 (so the same screenshot attached twice is stored once) and served from `/api/attachments/<id>` where the browser can cache them. On the development database this took `app.db` from **8.9 MB to 160 KB**, with 3.3 MB of images now in `data/uploads/`. The migration runs once, automatically, on first start — behind the mandatory snapshot described above, so it is recoverable.
  - Images are now labelled with their real type. The old inline path assumed `image/png` for everything, so every JPEG was mislabelled; the type is sniffed from the file's magic bytes and served correctly.
  - Deleting a message pair goes through its own endpoint that removes just that message and what followed from it. It used to work by sending the remaining history back from the browser, which was fine while there was one linear history — with branches it would have silently taken every branch the tab couldn't see.
  - `OLLAMA_UI_DATA_DIR` moves the database and uploads somewhere else — useful for a Docker volume.
- **Tests, and a bug they found** — the project had none; there are now 371, run in CI alongside lint and typecheck on every push. Writing them turned up a real defect in the calculator tool: `-2^2` returned `4` instead of `-4`, because unary minus was folded into the base before exponentiation. A silently wrong number is the worst possible failure for a tool whose entire purpose is to stop the model doing arithmetic in its head.
- **Refactors** — `db.ts` (2,064 lines) split into `src/lib/db/` with one module per entity behind the same import path; the Telegram bridge (1,172 lines) split into transport, commands, session and model-capability modules; the chat panel's voice input and attachment handling extracted into hooks. Also deleted: a leftover SSE demo component and its route that nothing referenced.

## 2026-08-30

- **Telegram Bridge (opt-in)**
  - Chat with the app from your phone via a Telegram bot — messages go through the same tool-calling/memory engine as the web UI, running as a background long-poll worker (no public port needed, no webhook to secure).
  - Locked to a single Telegram user: every incoming update is checked against `TELEGRAM_ALLOWED_USER_ID` (Telegram sets this server-side per message, so it can't be spoofed by a client); anything else is silently dropped, no reply sent. The bot token only authenticates this server to Telegram's API — it doesn't gate who can message the bot, so the id check is the actual access control.
  - Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID` and `TELEGRAM_MODEL` in `.env.local` to enable it; leaving them unset keeps the bridge off entirely.
  - While a reply is generating, Telegram's native "typing…" indicator stays on and a status message tracks what's happening (which tool is running, or that the model is queued behind another request) instead of silence until the final answer lands.
  - Replies render as real Telegram formatting (bold, lists, code) via `telegramify-markdown` instead of showing raw `**`/`` ` `` characters, with a plain-text fallback if a particular reply can't be converted cleanly.
  - The single ongoing Telegram conversation auto-compacts once it passes 16 messages — older history gets summarized into a dense note (last 4 messages kept verbatim), same mechanism as the web UI's Compact button, so it never silently overflows the model's context window. A short "🗜️ Compacted…" note marks when this happens.
  - Send a photo (with or without a caption) and it's downloaded and passed to the model just like an Attach-button image in the web UI. Uses a separate `TELEGRAM_VISION_MODEL` for that message if set (checked against Ollama's reported model capabilities first) — `TELEGRAM_MODEL` doesn't have to be vision-capable itself; if it already reports vision support (some do), photos work with no extra env var at all.
  - Slash commands, registered with Telegram so they autocomplete: `/info` (current model + its capabilities, read live from Ollama), `/tasks` (scheduled tasks/reminders, added below), `/new` (starts a fresh conversation — the old one stays in the web UI's session list), `/help`. Commands are intercepted before ever reaching the model — instant, deterministic replies instead of an unreliable generation call (this also fixed `/start` previously being sent through as ordinary chat text and getting an odd literal reply).
  - When a one-off reminder (`create_reminder`) fires, the model no longer sees `create_reminder`/`remember_fact` in its own tool list — without that, a small model firing its own reminder could mistake "deliver this now" for a fresh request and call the tool again instead of just replying (seen live in testing).
  - Scheduled tasks and reminders now push their result to Telegram as soon as they fire (if the bridge is configured), not just into a new chat session nobody's told about until they open the app — the entire point of a reminder set while away.
  - Reminders set from Telegram now use the message's own send time as "now" (in local, server-timezone form) instead of relying on `get_current_date` at generation time, which — after a cold model load — could be a minute or more after the message actually arrived, silently shifting a relative time like "in 2 minutes". Live testing also caught a model claiming "reminder set" without ever calling `create_reminder` (or after every attempt failed validation) — a schedule-shaped request now gets its result verified against the actual tool-call trace, with one automatic corrective retry and an honest warning if that still doesn't produce a real, successful call. The same verification now also runs on the web chat (a warning is appended instead of a retry there, since the reply has usually already streamed to the browser by the time it's checked).
  - New `create_recurring_task` tool — ask for something like "every weekday at 8, check the weather" from chat (Telegram or the web UI) and it's scheduled directly, same effect as adding it on the Scheduled page. `create_reminder` stays for a single one-off moment; the schedule-verification above covers both.
  - Voice messages: send one and it's transcribed via a local `whisper.cpp` server (OGG/Opus → WAV via `ffmpeg`, then Whisper) and handled exactly like a typed message — same tool-calling, reminders, everything. Opt-in via `WHISPER_HOST`; the combined Docker image now builds and bundles `whisper-server` + a multilingual model automatically, no separate setup needed there. Ollama itself has no speech-to-text support at all, so this is a second, fully local service alongside it, not a hosted API.
  - The bundled `whisper-server`'s CPU requirements are now pinned to a portable baseline (no AVX2/FMA/F16C) instead of ggml's default — those aren't guaranteed on every machine `ghcr.io`'s image gets pulled onto, and the build isn't performance-critical (occasional voice transcription, not the model inference hot path).
  - README now covers setting `TELEGRAM_*`/`WHISPER_HOST` on Docker/Unraid specifically (container environment variables, not `.env.local` — that file is dev-only and was previously the only documented way).
  - New `list_scheduled_tasks` and `cancel_scheduled_task` tools, plus a `/tasks` slash command — ask "what's scheduled?" or "cancel the daily weather task" from chat (Telegram or web) instead of opening the Scheduled page; `/tasks` gives the same list instantly with no model call. Cancelling matches by id or by a name/substring, and asks you to be more specific if more than one task matches.
  - Send a document (PDF, plain text, or code) to the Telegram bridge and it's read and handed to the model as context — attach one with a caption to ask something specific about it, or with no caption to get a summary. PDFs are read via `pdftotext`; text/code files are decoded directly. No new env var needed.
  - Fixed a real, live-caught bug: asked "what's scheduled?", the model could skip `list_scheduled_tasks` entirely and confabulate a convincing-looking table of recurring tasks that never existed, with made-up times, echoing names mentioned earlier in the conversation. A list-shaped question now gets its reply fully replaced with the real, deterministic list whenever the model didn't actually call the tool — worse than an unconfirmed action (a warning wouldn't be enough), this is misinformation about your own data, so it's overridden outright rather than just flagged.
  - Fixed a second bug found while verifying the first: the corrected reply above was reaching Telegram correctly, but the _original_, hallucinated reply was still what got saved into the session history, since the correction ran after the message was already persisted. The corrected content is now re-persisted too, so what's saved always matches what was actually sent.
  - Fixed a third bug: cancelling a task successfully on the first try could still trigger a spurious "couldn't confirm that was scheduled" warning, because the schedule-verification check only recognized the two `create_*` tools, not `cancel_scheduled_task`. It now counts a successful cancel as success too.
  - `/tasks` (and a plain-language "what's scheduled?" that gets the verified list) now shows a ❌ Cancel button under each task — tap it and it's gone instantly, no need to type a cancel request. The message updates itself in place rather than posting a new one each time, and the buttons disappear once nothing's left scheduled.
  - The polling loop is more resilient: a `getUpdates` failure now backs off exponentially (5s up to a capped 60s) instead of a flat 5s retry forever, sends a "✅ Reconnected" notice once it recovers from 3+ failures in a row, and the whole loop now auto-restarts after 5s if it ever crashes outright — previously that would've silently ended the bridge until the next full server restart, with just one easy-to-miss log line marking it.
  - The Telegram bridge's one persistent conversation is now marked in the web UI's session list — a small blue paper-plane icon next to its title (and the collapsed-sidebar dot) — so it isn't mistaken for an ordinary web chat while scrolling the list. An already-existing conversation from before this shipped gets the marker retroactively, no manual fix-up needed.
- **Settings → Status Panel**
  - New **Status** section at the top of Settings: a live reachability check for the three external services this app depends on — Ollama, the Whisper voice server, and the Telegram bridge — each with a colored dot (configured & reachable, configured but unreachable, or not configured at all) and a short detail line (host, latency, model count, or the actual error).
  - The Telegram row does a real `getMe` call against the configured token, not just "is an env var set" — a bot token that's been rotated in @BotFather (or simply mistyped in the container's env) but never updated shows up immediately as an invalid-token error here, instead of the bot just silently doing nothing forever with no error anywhere. Also surfaces the poll loop's live health (last successful poll, consecutive failures) from the resilience work above.
  - Built directly out of a real debugging session: redeployed the container, messaged the bot, nothing happened, and there was genuinely no way to tell why without digging through container logs by hand.
  - Fixed a bug caught while building this: the live poll-loop health state was kept as a plain module-level variable, but Next.js can load `telegram-bridge.ts` into more than one separate module instance (the one instrumentation.ts starts polling with, and the one a route handler like the new status endpoint imports) — so the status panel showed "never started" even while the bridge was actively receiving messages. Moved onto `globalThis`, the same fix this file already used for its own duplicate-start guard.
- **Fixed: scheduler and Telegram bridge never actually started in the built Docker image**
  - The real bug the Status panel above was built to chase down: a fully correctly configured, valid-token Telegram bot did genuinely nothing when messaged in the deployed container — no error, no log line, nothing. Root cause: Next's standalone build output (`output: 'standalone'`) doesn't include `instrumentation.ts` in its dependency tracing — it copies the raw _source_ file into the image for reference, but never the actual _compiled_ `instrumentation.js` the runtime loads, nor that compiled file's own Turbopack-split runtime chunk (Next 16 defaults to Turbopack for the production build too, not just dev). Next silently swallows the resulting "module not found" and simply never calls `register()` — meaning the scheduler and Telegram bridge silently never started in _any_ previously published Docker image, regardless of how correct the container's env vars were. Every test of these features so far in this project happened against `next dev`, which loads instrumentation differently and never hit this.
  - Reproduced by running the actual standalone `node server.js` output directly (rather than only ever testing via `next dev`), then fixed by explicitly copying the compiled `instrumentation.js` and the full `.next/server/chunks/` directory into the final image — see the Dockerfile's comment at that step for the full trace. If you're on an existing deployment, pulling the next published image (or rebuilding) picks this up automatically; no config changes needed.
- **Voice Input in the Web UI**
  - New Voice button next to Attach in the composer: records with the browser's own microphone (`MediaRecorder`), transcribes via the same local `whisper.cpp` server Telegram voice messages use, and fills the result into the input box for you to review/edit before sending — unlike Telegram, nothing here auto-sends, since there's a visible composer to catch a misheard transcription first.
  - New `POST /api/transcribe` endpoint backing it; the actual conversion/transcription logic moved into a shared `src/lib/whisper.ts` so the Telegram bridge and this endpoint aren't duplicating it.
- **Individually Toggleable Tools**
  - Settings → Tools previously had one master on/off switch; now every tool (web search, current date, weather, calculator, create reminder, create recurring task, list scheduled tasks, cancel scheduled task) has its own toggle, all on by default. Turning one off applies everywhere it could run — web chat, Telegram, and scheduled tasks — not just the page you toggled it from.
  - Also fixed: the master switch actually defaulted to **off**, so a fresh install's web chat couldn't use any tools until someone found the Settings toggle — confusing since Telegram (which always forced tools on regardless of this setting) worked fine the whole time. Default is now on, consistently, everywhere.
- **New Settings → Telegram Toggle**
  - "Push scheduled task/reminder results to Telegram" — on by default, separate from whether the bridge itself is configured. Every background run always lands in a new web UI session either way; this only controls the extra Telegram push, for when the notification volume from frequent tasks gets more than you want without giving up Telegram entirely.

## 2026-08-28

- **Reminders From Chat, Server Clock in the Footer**
  - New `create_reminder` tool: ask for something like "remind me tomorrow at 9 to call the dentist" and the model schedules it itself, right from the conversation — no need to open the Scheduled page. It fires once at the exact time, delivers the reminder as a new chat message, and then quietly removes itself; the Scheduled list shows it with a "reminder" badge in the meantime so you can still see or cancel it.
  - The footer now shows a small live server clock. Scheduled Tasks and reminders both use the _server's_ local time, which can quietly differ from your browser's — this makes that explicit instead of leaving it to guesswork.
- **Scheduled Tasks**
  - New **Scheduled** page: set up recurring prompts ("check the weather every morning at 8", "summarize the news every weekday evening") that run automatically at a set time and days of the week — no browser tab needs to be open, no external cron required. Each run creates a new chat session with the model's real reply (tools and memory both available, on by default), and the existing "N generating" badge/toast picks it up like any other background reply, so you're notified the same way.
  - Runs entirely server-side via a background scheduler started once when the app boots; a task survives app restarts (missed runs simply catch up on the next check) and multiple tasks firing at the same time run safely alongside each other.
- **Weather & Calculator Tools**
  - New `get_weather` tool: real, structured multi-day forecasts (temperature, precipitation, conditions) via Open-Meteo — no API key needed. Replaces relying on `web_search` for weather questions, which could return vague search snippets instead of an actual forecast, or the model announcing it would search and never following through.
  - New `calculator` tool: evaluates arithmetic expressions (`+ - * / % ^`, parentheses) reliably instead of the model doing math in its head. Both tools use the existing "Tools" toggle in Settings — no new switch to find.
- **Persistent Memory**
  - The assistant can now save short, durable facts about you during a chat (a `remember_fact` tool — "remember that I prefer concise answers", "remember I'm working on X") and automatically recalls them in future, separate conversations — no more re-explaining preferences or ongoing projects every time. On by default; manage what's stored (view/delete/add facts manually) under Settings → Memory.
  - A 🧠 pill next to the composer shows whether memory is active and lets you turn it off for just the current chat, without touching the global setting — useful for a one-off conversation you don't want influencing future replies.
  - When the assistant saves something, it shows up inline in the chat trace ("Saved to memory: ...") instead of happening silently.
- **Model Benchmark History**
  - New **Benchmarks** page: every real chat reply now logs its speed (tokens/sec) automatically, building a trend history per model over time. A **Run benchmark now** button additionally sends the same fixed prompt to every installed model, one at a time, for a direct, apples-to-apples comparison — shown alongside the organic chat data, kept clearly labeled apart from it.
- **Chat Stayed Smooth in Long Conversations**
  - Fixed the chat UI getting progressively sluggish the longer a conversation ran and the longer a reply got. While a reply streamed in, every single token was re-rendering every other message in the conversation (not just the one actually changing) and re-parsing the entire accumulated reply text from scratch on every token — both costs scaled with how much was already in the chat. Message rendering is now properly isolated per message, and markdown parsing is decoupled from the raw token rate, so streaming stays smooth regardless of how long the conversation or the reply already is. No behavior changes — same streaming, reasoning traces, tool calls, editing, and Compare mode as before.

## 2026-08-27

- **True Parallel Chats**
  - Sending a message in one chat no longer blocks sending in another. Previously, starting a reply in one session and then switching to a different session left the composer thinking it was still busy — generation state (loading/streaming indicators, Stop) was tracked once for the whole app instead of per session, so a reply running in the background in session A made session B look stuck too. The server already ran generation jobs fully independently; the client just couldn't keep up. Now each session (and each Compare column) tracks its own state, so switching sessions and firing off another chat while one is still generating works as expected.
  - Added a heads-up "Waiting on Ollama — N other request(s) already running for this model" indicator for the case where a second parallel chat has to wait its turn, instead of a stale "Loading model…" or an unexplained silent pause. Whether it actually runs alongside the other one depends on the Ollama server's own `OLLAMA_NUM_PARALLEL` setting and available VRAM — this app has no control over that, the indicator is just an honest "something else is using this model right now".
  - Fixed a hard failure ("Ollama did not respond within 180s (timed out)") that could hit a perfectly healthy chat simply because it was queued behind another parallel request to the same model — completely normal under Ollama's own concurrency limits, previously misreported as an error. The connection timeout now only starts counting once a reply has actually begun streaming; the wait for that first response is no longer time-limited at all.

- **Session Titles No Longer Depend on the Model**
  - A session's title is now derived directly from your first message (trimmed/truncated, no extra model call) instead of a separate background request asking the model to summarize the exchange. It appears instantly instead of after the reply finishes, and can no longer fail, hang, or show a stuck "Generating title…" because Ollama was busy with something else.

- **Math Formulas Now Render Properly**
  - Chat replies containing LaTeX math (`$$...$$` block or `$...$` inline — common when a model explains a formula) used to come through as raw, unreadable text. Now rendered properly via KaTeX, matching the current theme.

- **Edit & Resend**
  - Hover a message you sent to edit it in place. Saving removes that message and everything after it in that column, then resends the edited text — the same "rewind and continue differently" model as Regenerate, just with your own wording changed instead of asking the model to try again.

- **Search Now Covers Message Content, Not Just Titles**
  - The sidebar search already existed for session titles; it now also searches inside the messages themselves (new `GET /api/sessions/search`), showing a short snippet of the matching text when the hit isn't in the title.

- **Export a Conversation**
  - New **Export** button next to Compact — downloads the current session as a readable Markdown file. In Compare mode, both columns are included under their own headings.

- **Image Attachments for Vision Models**
  - An **Attach** button in the composer lets you add one or more images to a message for vision-capable models (e.g. `minicpm-v`, `gemma4`, `ornith-1.5`) — shown only once the selected model (or, in Compare mode, either model) actually advertises vision support, so it doesn't show up as a dead button for text-only models. Attached images preview as thumbnails (removable before sending) and render inline in the conversation afterwards.
  - Model capability badges up top (next to "thinking"/"tools") now also show a **vision** badge when the selected model supports it.

## 2026-08-26

- **Chat Generation Survives Closing the Tab**
  - Sending a message no longer ties the model's response to your browser connection. Generation now runs as a server-side job — close the tab, and it keeps going and saves normally; reopen it (or open a different tab or device on the network) and it picks the live response back up where it left off, including reasoning and tool-call traces.
  - **Stop** now actually cancels generation server-side instead of just hiding it in your tab.
  - A small "N generating" badge in the sidebar (visible on every page, not just Chat) shows what's still running; click it to jump straight to any of them. A toast pops up when a background reply finishes elsewhere, and the browser tab title flashes if you're not currently looking at it — no notification permissions or HTTPS required.

- **Unsupported Tool-Call Cleanup**
  - Some model fine-tunes emit a plain-text pseudo tool-call syntax for tools this app never declared, which used to stream through as raw, ugly tag soup. It's now detected live (shown as a clean "cleaning up…" indicator while streaming) and rendered as a normal, readable code block once the message finishes.
  - Every code block in chat now has its own hover **Copy** button, not just a whole-message copy.

- **Chat Composer & Layout Fixes**
  - A context-usage progress bar now sits right above the message box (in addition to the small badge up top), so you can see at a glance how full the context window is without hunting for it.
  - Fixed: while a model was still loading into memory, the chat showed the same "🦙 Thinking…" animation as actual reasoning — misleading, since the model hadn't started yet. It now clearly says "Loading model… Ns" until the first real token/thought arrives.
  - Fixed: the chat page was capped at a fixed max-width instead of filling the browser window, and — separately — message text itself was stuck at a ~65-character column width no matter how wide the window was (the `@tailwindcss/typography` plugin was never actually activated; a hand-rolled CSS fallback silently overrode the app's own `max-w-none`). Both now fill the available width properly.
  - Fixed: **Compact** could silently replace older chat history with a near-empty, garbage summary if the model returned a degenerate response (seen in practice: a single stray character) — now validated and rejected with a clear error instead of quietly losing context.

- **Dependency Security**
  - Patched 23 JS dependency advisories (Next.js middleware bypass/SSRF/DoS fixes among them) and an XXE advisory in the Python scraper's `lxml` dependency.

## 2026-08-25

- **Running Models Page**
  - New `/running` page — a live `ollama ps` equivalent showing every currently loaded model: CPU/GPU memory split (with a visual bar), effective context window, quantization/parameter-size/family badges, and a live countdown to when Ollama will auto-unload it.
  - Summary cards at the top total loaded models, VRAM in use and system RAM in use. One-click **Unload** button per model (reuses the existing stop/unload endpoint); the list auto-refreshes every 4 seconds. Reachable from the sidebar and the ⌘K command palette.

- **Chat Reliability Fixes**
  - Fixed a tool-calling bug where the model could silently lose its final answer: after exhausting the tool-call budget, a model's last tool request was dropped without ever letting it answer in plain text. The final iteration now omits tools entirely, forcing a real answer instead.
  - Session saves (send / regenerate / delete / compact) are now written in strict order per session — a slow, stale save can no longer land after a newer one and silently revert a chat to an earlier state after reload.
  - Errors during streaming now keep their real message instead of collapsing into a generic "[Chat error]"; failures are also logged to the console for easier debugging.
  - Added timeouts to the chat, auto-compact, title-generation and web-search requests, so a hung Ollama host or SearXNG instance can no longer leave a spinner running forever.

## 2026-07-19

- **Command Palette (⌘K / Ctrl+K)**
  - A global overlay (in the style of VS Code / Raycast) for jumping around the app fast: page navigation, switching or creating chat sessions, opening the host manager, and switching color themes — all searchable from one box.
  - Full keyboard navigation (↑↓ to move, ↵ to run, Esc to close); a small "⌘K" hint sits at the bottom of the sidebar.

- **Auto-Compact Context**
  - New "Auto-compact context" toggle in Settings → Context, with a threshold (60/70/80/90%).
  - Once a reply pushes the real runtime context usage above the threshold, older history is automatically summarized — same mechanism as the manual Compact button, including the 15-second Undo. Off by default; a 30-second cooldown prevents back-to-back auto-compactions.

- **Message Actions — Copy, Regenerate, Delete**
  - Every chat message now shows a small action bar on hover: copy the text to the clipboard, regenerate the last assistant reply (re-runs the same question through the model), or delete a question/answer pair.
  - Regenerate and delete are available per column in Compare mode without touching the other column, and are disabled while a reply is streaming.

- **Modern Glass Redesign (theme-adaptive)**
  - New ambient background: a slowly drifting aurora glow driven by the active theme's accent color, over a deep-space base with a subtle blueprint grid — every one of the 5 color themes gets matching ambience automatically.
  - App-wide glass design system: translucent cards with gradient hairline borders, hover lift + accent glow, gradient hero titles, and staggered entrance animations (respects `prefers-reduced-motion`).
  - Sidebar rebuilt with proper Lucide icons (emojis retired), accent-colored active states with a glowing indicator bar, and a refreshed logo.
  - Chat console polish: accent-tinted user bubbles, icon-based reasoning/tool trace lines, restyled composer, segmented Single/Compare control with accent glow.
  - Toasts got type icons and a slide-in animation; the host manager modal got entrance animations, accent styling and icon buttons. Scrollbars and text selection follow the theme accent too.

- **Dashboard Charts Rebuilt**
  - Model sizes now render as a sorted horizontal bar chart (long model names finally readable), colored with the live theme accent — switching themes recolors the chart instantly.
  - The size-share pie became a doughnut with a colorblind-safe, validated 8-color palette; beyond 7 models the rest folds into a neutral "Other" slice. Tooltips show real GB/MB values and percentages.

- **Context Compaction**
  - New **Compact** button in the chat composer: older messages are summarized by the model itself into a dense context note (facts, decisions and open questions survive; filler doesn't). The last 4 messages stay verbatim.
  - The summary appears as a collapsible "Compacted context" card in the conversation and replaces the old history in what gets sent to the model — with a 15-second Undo.
  - Works per column in Compare mode, each with its own model.

- **Honest Context Window Display**
  - The context badge previously showed the model's _architectural maximum_ from the registry (e.g. 262K) — but Ollama actually runs models with its server default (`num_ctx`, usually 4096) unless told otherwise, silently truncating anything beyond it.
  - The badge now shows the **real runtime window** reported by `/api/ps` once the model is loaded (e.g. `1.2K/4K ctx`); before that it shows `≤262.1K ctx` with an explanatory tooltip. The amber near-full warning now refers to the real limit.

- **Per-Model Context Slider (num_ctx)**
  - New gauge pill next to the context badge opens a slider ranging from 2K up to the selected model's maximum, with quick presets (4K/8K/16K/… /Max) and a reset to server default.
  - The chosen window is persisted per model, sent as `options.num_ctx` with every chat request _and_ during context compaction, and Ollama reloads the model with the new window on the next message.

## 2026-07-18

- **Chat "Console" Redesign**
  - Chat page rebuilt around a collapsible sidebar for sessions/profiles instead of an inline dropdown that used to push the conversation down every time it was opened.
  - Reasoning and tool calls now render as a single chronological trace (think → call a tool → think more → answer) instead of two disconnected blocks.
  - Playground has been merged into Chat as a "Compare" toggle — two columns sharing one composer, running through the exact same pipeline as normal chat, so tool-calling, reasoning and the new Stop button work in Compare mode too.
  - Added a Stop button to cancel an in-progress generation, and real upstream error messages instead of a generic "[Chat error]".
  - Fixed a bug where a thinking model's reasoning text got duplicated at the end of every response.

- **Tool-Calling: Web Search & Current Date**
  - Tool-capable models can now call `web_search` (via a self-hosted SearXNG instance) and `get_current_date` mid-conversation to answer with up-to-date information.
  - Configured once under Settings → Tools (master switch + SearXNG endpoint template) and applies to every chat; the app checks each model's capabilities automatically so the toggle warns you if the selected model doesn't support tools.

- **Whole-App "Console" Redesign**
  - The top navigation bar is gone, replaced by a single collapsible sidebar handling navigation (Dashboard / Chat / Models / Profiles / Settings), host status, and — only while on the Chat page — the session list.
  - Models, Dashboard, Settings and Profiles pages restyled to match: consistent glass panels, mono labels, pill-style badges.

- **Real, Persisted Chat Sessions**
  - Chat sessions are now actual saved conversations, not just a profile switch — full history (including reasoning/tool traces) survives a page reload.
  - Each session gets a short title automatically generated after the first exchange ("Generating title…" until it's ready); rename or delete a session directly from the sidebar.
  - A session remembers its own model(s), Compare on/off state, and an optional persona.

- **Personas**
  - The persona (system prompt) picker moved next to the model selector in the chat top bar — pick one per session, or "No persona" to disable.
  - Ships with four ready-made personas: **Research Analyst** (searches the web first, cites sources), **Code Reviewer** (terse, correctness-first), **Creative Writing Partner** (matches your voice instead of imposing one), and **Reiseplaner** (looks up current recommendations for a place you name, always checks today's date first instead of guessing the year).

- **Persistence moved to SQLite**
  - All server-side data (hosts, personas, sessions, tool settings) now lives in a single SQLite file (`data/app.db`) via Node's built-in `node:sqlite` — no native module to compile, so none of the earlier Docker cross-platform build issues apply.
  - Requires Node ≥ 22.5. `pnpm dev` now runs without `--turbopack` (a current Turbopack limitation with `node:sqlite`); production builds already used webpack and are unaffected.

- **Token & Context Stats**
  - Every reply now shows tokens generated and tokens/sec underneath it.
  - A context-window badge sits next to the model picker and turns amber once a conversation gets close to filling it.

## 2026-01-08

- **Stop / Unload Models**
  - Added ability to stop/unload loaded models directly from the navbar
  - New "🧠 X loaded" badge in header shows count of currently loaded models
  - Click badge to open popover with all loaded models and stop buttons
  - Displays Ollama version info in popover header
  - Feature requires Ollama v0.1.33+ (version check included)
    ![Loaded Models Popover](loaded_models.png)

## 2025-11-05

- **Playground View**
  - Added a new Playground view for experimenting with different models and prompts.
  - You can select any installed model, adjust parameters, and see the results in real-time.
  - You can send messages to both models at same time.
    ![Playground](playground.png)

## 2025-08-13 - 2025-08-16

- **Theme & UI Consistency**
  - Added possibility to choose theme
    - Now some themes are available Default (the one you already know), Dark Green, Neon Organge, .... You will see.
      ![Theme](theme.png)
  - Added Settings view
    - Theme Chooser
    - All relevant localStorage settings are shown readonly in the settings view (client-only, hydration-safe).
    - Last selected model per host is now persisted in localStorage and restored automatically.
    - "Delete Confirmations Settings" - When enabled, deleting a model requires a second click (“Sure?”) to confirm. Disabling allows immediate deletion with a single click.
  - Some Bug fixes
  - Removed autoreload from models view as it is not necessary.

- **Quality of Life**
  - Settings and Infos sections are now visually separated and clearly labeled.
  - UI and settings layout further streamlined for clarity and consistency.

- **Fix Issues**
  - CSS issues in docker image, white background and I can't see anything. #3 - Fixed, standard is now dark. (maybe will add other themes later).

## 2025-08-12

- **Chat View**
  - Added indicator which models are loaded in Ollama (api/ps)
    ![Loaded Models](ollama_loaded.png)

- **Dashboard Integration:**
  - Added a new Dashboard view combining model statistics, interactive charts, and release notes in one place.
  - Visualizations include bar and pie charts for model sizes and distribution.
  - Model stats update automatically when switching hosts.
    ![Dashboard](dashboard.png)
  - Release notes/news are now shown directly in the dashboard; the separate News page and menu entry have been removed.
  - UI and navigation streamlined for easier access to all features.
    ![News](news.png)
- **Navigation Restoration:**
  - Chat view is now available again at `/chat` with a dedicated navigation link.
  - Dashboard remains the start page and first in the menu.

- **Host Manager & Indicator:**
  - Host Manager modal accessible from header (gear icon) with add/edit/delete/test & activation.
    ![Host indicator](host_man1.png)
    When now clicking on "Gear-Button" you will get modal for host settings:
    ![Host Manager Modal](host_man2.png)
    Here you can switch between host, add new hosts and so on.
  - Enhanced host indicator (full URL + label tooltip, status & latency display).
  - Inline host management removed from Models view; centralized management in header.

- **Build & Workflow:**
  - Improved Docker build workflow logic (conditional builds based on relevant changes & base image digest) earlier in development cycle.

## 2025-08-11

- Initial refactors preparing for modal-based host switching.

## 2025-08-10 / 2025-08-09

- Added multi‑host management (save, edit, activate, delete) persisted in SQLite.
- Removed legacy cookie + fallback host resolution; now a host must be explicitly added & activated (or provided via header / env on server routes).
- Added global Active Host indicator (header badge) with connectivity & latency test (click to retest).
- Introduced Add Host modal with inline URL validation & connectivity Test button.
- Added inline edit for saved hosts (URL & label) with conflict detection.
- Added host connectivity test API: `POST /api/hosts/test`.
- Added capability filters (Embedding / Vision / Tools / Thinking) + clear button to catalog view.
- Improved catalog display: "Showing X of Y models" with proper total fallback logic.
- Grouped search, filters, limit selector into cohesive panel; improved layout order (Pull box now directly under catalog header).
- Added progress bar & NDJSON parsing improvements for model pull (percentage derivation if missing upstream).
- Added defensive JSON parsing & error handling across host/model routes; uniform 428 response when no host configured.
- Added nightly Docker build schedule (02:30 UTC) to CI workflow.
- Implemented Add Host modal connectivity test ("Ollama is running" or fallback to /api/tags) with timeout.
- Introduced Release Notes, Disclaimer sections in README.
- Active host header badge now updates instantly after activating a host (custom `active-host-changed` event dispatch from Models view).
- Replaced remaining `any` usages with typed interfaces (Hosts API) to satisfy ESLint `@typescript-eslint/no-explicit-any` rule.

### Earlier Changes

- Initial feature set: installed models list, pull & delete, remote catalog browsing with variants, toasts, streaming chat endpoint, Python scraper integration, Docker build (combined Ollama + UI), gradient UI theme.
