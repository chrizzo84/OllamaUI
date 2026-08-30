'use client';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { useThemeStore } from '@/store/theme';
import { usePrefsStore } from '@/store/prefs';
import { useToolsStore, useAnyToolEnabled } from '@/store/tools';
import { TOOL_KEYS, TOOL_LABELS } from '@/lib/tool-settings';
import { useMemoryStore } from '@/store/memory';
import { useTelegramSettingsStore } from '@/store/telegram';
import { useEffect } from 'react';
import { LocalStorageInfo } from '@/components/local-storage-info';
import { HostManagerPanel } from '@/components/host-manager-panel';
import { MemoryPanel } from '@/components/memory-panel';

export default function SettingsPage() {
  const theme = useThemeStore((s) => s.theme);
  const hydratePrefs = usePrefsStore((s) => s.hydrate);
  const requireDeleteConfirm = usePrefsStore((s) => s.requireDeleteConfirm);
  const setRequireDeleteConfirm = usePrefsStore((s) => s.setRequireDeleteConfirm);
  const autoRefreshModelsSeconds = usePrefsStore((s) => s.autoRefreshModelsSeconds);
  const setAutoRefreshModelsSeconds = usePrefsStore((s) => s.setAutoRefreshModelsSeconds);
  const autoCompactEnabled = usePrefsStore((s) => s.autoCompactEnabled);
  const setAutoCompactEnabled = usePrefsStore((s) => s.setAutoCompactEnabled);
  const autoCompactThresholdPct = usePrefsStore((s) => s.autoCompactThresholdPct);
  const setAutoCompactThresholdPct = usePrefsStore((s) => s.setAutoCompactThresholdPct);
  const hydrateTools = useToolsStore((s) => s.hydrate);
  const toolToggles = useToolsStore((s) => s);
  const setToolEnabled = useToolsStore((s) => s.setToolEnabled);
  const anyToolEnabled = useAnyToolEnabled();
  const searxngTemplate = useToolsStore((s) => s.searxngTemplate);
  const setSearxngTemplate = useToolsStore((s) => s.setSearxngTemplate);
  const hydrateMemory = useMemoryStore((s) => s.hydrate);
  const memoryEnabled = useMemoryStore((s) => s.memoryEnabled);
  const setMemoryEnabled = useMemoryStore((s) => s.setMemoryEnabled);
  const hydrateTelegramSettings = useTelegramSettingsStore((s) => s.hydrate);
  const notifyScheduledTasks = useTelegramSettingsStore((s) => s.notifyScheduledTasks);
  const setNotifyScheduledTasks = useTelegramSettingsStore((s) => s.setNotifyScheduledTasks);

  useEffect(() => {
    hydratePrefs();
    hydrateTools();
    hydrateMemory();
    hydrateTelegramSettings();
  }, [hydratePrefs, hydrateTools, hydrateMemory, hydrateTelegramSettings]);

  return (
    <div className="p-6 flex flex-col gap-8 max-w-3xl mx-auto items-center">
      <div className="w-full flex flex-col gap-8">
        <div>
          <span className="block text-center text-[10px] font-mono uppercase tracking-wider text-white/30 mb-1">
            Preferences
          </span>
          <h2 className="text-3xl font-bold tracking-tight text-gradient-hero text-center mb-4">
            Settings
          </h2>
        </div>
        <section className="glass-card p-5 flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white/90 mb-1">Ollama Host</h2>
            <p className="text-xs text-white/50 mb-4">
              Add and activate the Ollama server this app talks to. Nothing else works — models,
              chat, everything — until a host is added here and marked active (the green dot).
            </p>
            <HostManagerPanel />
          </div>
        </section>
        <section className="glass-card p-5 flex flex-col gap-8">
          <div>
            <h3 className="text-lg font-semibold text-white/90 mb-1">Theme</h3>
            <p className="text-xs text-white/50 mb-3">
              Select an interface theme. Your current choice (
              <span className="font-medium text-white/80">{theme}</span>) is stored in localStorage
              and restored on reload.
            </p>
            <ThemeSwitcher />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white/90 mb-1">Models</h3>
            <div className="flex flex-col gap-3 text-xs text-white/60">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="accent-indigo-500"
                  checked={requireDeleteConfirm}
                  onChange={(e) => setRequireDeleteConfirm(e.target.checked)}
                />
                <span>Require confirmation before model deletion</span>
              </label>
              <div className="text-[11px] text-white/40 ml-6">
                When enabled, deleting a model requires a second click (“Sure?”) to confirm.
                Disabling allows immediate deletion with a single click.
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <label className="flex items-center gap-2">
                  <span>Auto refresh interval (seconds)</span>
                  <input
                    type="number"
                    min={0}
                    step={5}
                    value={autoRefreshModelsSeconds}
                    onChange={(e) => setAutoRefreshModelsSeconds(Number(e.target.value) || 0)}
                    className="w-20 rounded bg-white/5 border border-white/15 px-2 py-1 text-[11px]"
                  />
                </label>
                <span className="text-white/30">0 disables</span>
              </div>
            </div>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white/90 mb-1">Context</h3>
            <div className="flex flex-col gap-3 text-xs text-white/60">
              <div className="flex items-center gap-3 flex-wrap">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="accent-indigo-500"
                    checked={autoCompactEnabled}
                    onChange={(e) => setAutoCompactEnabled(e.target.checked)}
                  />
                  <span>Auto-compact context</span>
                </label>
                <select
                  value={autoCompactThresholdPct}
                  onChange={(e) => setAutoCompactThresholdPct(Number(e.target.value))}
                  disabled={!autoCompactEnabled}
                  className="rounded bg-white/5 border border-white/15 px-2 py-1 text-[11px] text-white disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none"
                >
                  {[60, 70, 80, 90].map((pct) => (
                    <option key={pct} value={pct} className="bg-neutral-900">
                      at {pct}%
                    </option>
                  ))}
                </select>
              </div>
              <div className="text-[11px] text-white/40">
                When a reply pushes context usage above the threshold, older history is
                automatically summarized (same as the Compact button in Chat).
              </div>
            </div>
          </div>
        </section>
        <section className="glass-card p-5 flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white/90 mb-1">Tools</h2>
            <p className="text-xs text-white/50 mb-3">
              Lets tool-capable models call functions during chat, in Telegram, and in scheduled
              tasks — on by default, turn off individually as needed. The selected model must also
              advertise <code className="text-white/70">tools</code> support (checked automatically)
              for any of this to have an effect.
            </p>
            <div className="flex flex-col gap-2 mb-3">
              {TOOL_KEYS.map((key) => (
                <label key={key} className="flex items-start gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="accent-cyan-500 mt-0.5"
                    checked={toolToggles[key]}
                    onChange={(e) => setToolEnabled(key, e.target.checked)}
                  />
                  <span className="flex flex-col">
                    <span className="text-xs text-white/70">{TOOL_LABELS[key].title}</span>
                    <span className="text-[10px] text-white/40">
                      {TOOL_LABELS[key].description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {toolToggles.webSearch && (
              <div className="flex flex-col gap-2 ml-6">
                <label
                  className="text-[11px] font-medium text-cyan-200/80"
                  htmlFor="searxng-template"
                >
                  SearXNG endpoint template
                </label>
                <input
                  id="searxng-template"
                  value={searxngTemplate}
                  onChange={(e) => setSearxngTemplate(e.target.value)}
                  placeholder="http://localhost:8080/search?q=<query>&format=json"
                  className="rounded-md border border-white/15 bg-white/10 px-2 py-1.5 text-xs text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-cyan-500/60 max-w-md"
                />
                <span className="text-[10px] text-white/40 max-w-md">
                  Must contain the literal <code>&lt;query&gt;</code> placeholder. Leave empty to
                  use the server-side default (env var <code>SEARXNG_HOST</code> or{' '}
                  <code>http://localhost:8080</code>).
                </span>
              </div>
            )}
            {!anyToolEnabled && (
              <p className="text-[10px] text-amber-300/70 mt-1">
                All tools are off — the assistant can still chat normally, just without calling any
                of these.
              </p>
            )}
          </div>
        </section>
        <section className="glass-card p-5 flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white/90 mb-1">Memory</h2>
            <p className="text-xs text-white/50 mb-3">
              Lets the assistant save short, durable facts about you during a chat (via the{' '}
              <code className="text-white/70">remember_fact</code> tool) and recalls them
              automatically in future conversations — no need to re-explain preferences or ongoing
              projects every time. On by default; a specific chat can still turn it off via the
              memory pill next to the composer.
            </p>
            <label className="flex items-center gap-2 cursor-pointer select-none mb-4">
              <input
                type="checkbox"
                className="accent-violet-500"
                checked={memoryEnabled}
                onChange={(e) => setMemoryEnabled(e.target.checked)}
              />
              <span className="text-xs text-white/70">Enable memory globally</span>
            </label>
            <MemoryPanel />
          </div>
        </section>
        <section className="glass-card p-5 flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white/90 mb-1">Telegram</h2>
            <p className="text-xs text-white/50 mb-3">
              The Telegram bridge itself is set up via environment variables (
              <code className="text-white/70">TELEGRAM_BOT_TOKEN</code>, not here — see the README).
              This only controls whether a fired scheduled task or reminder also pushes its result
              to Telegram, on top of always landing in a new chat session either way. Has no effect
              if the bridge isn&apos;t configured.
            </p>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                className="accent-sky-500"
                checked={notifyScheduledTasks}
                onChange={(e) => setNotifyScheduledTasks(e.target.checked)}
              />
              <span className="text-xs text-white/70">
                Push scheduled task/reminder results to Telegram
              </span>
            </label>
          </div>
        </section>
        <section className="glass-card p-5 flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white/90 mb-1">Infos</h2>
          </div>
          <div>
            <h3 className="text-base font-semibold text-white/80 mb-1">LocalStorage (readonly)</h3>
            <p className="text-xs text-white/50 mb-3">
              All Ollama UI settings currently stored in your browser.
            </p>
            <LocalStorageInfo />
          </div>
          <div>
            <h3 className="text-base font-semibold text-white/80 mb-1">Data Storage</h3>
            <p className="text-xs text-white/50 mb-2">
              Server-side data (profiles, hosts, chat sessions) is stored in a single SQLite
              database file (<code className="text-white/70">data/app.db</code>), via Node&apos;s
              built-in <code className="text-white/70">node:sqlite</code> module.
            </p>
            <p className="text-xs text-white/40 bg-white/5 border border-white/10 rounded px-3 py-2">
              <strong>Note:</strong> An earlier revision used the third-party{' '}
              <code>better-sqlite3</code> package, which failed to compile as a native module across
              Docker/multi-platform builds and was briefly replaced with plain JSON files. Since{' '}
              <code>node:sqlite</code> ships inside Node itself (Node ≥ 22.5, no native compile
              step), that problem no longer applies.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
