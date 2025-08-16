'use client';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { useThemeStore } from '@/store/theme';
import { usePrefsStore } from '@/store/prefs';
import { useEffect, useState } from 'react';
import { LocalStorageInfo } from '@/components/local-storage-info';

export default function SettingsPage() {
  const theme = useThemeStore((s) => s.theme);
  const hydratePrefs = usePrefsStore((s) => s.hydrate);
  const requireDeleteConfirm = usePrefsStore((s) => s.requireDeleteConfirm);
  const setRequireDeleteConfirm = usePrefsStore((s) => s.setRequireDeleteConfirm);
  const autoRefreshModelsSeconds = usePrefsStore((s) => s.autoRefreshModelsSeconds);
  const setAutoRefreshModelsSeconds = usePrefsStore((s) => s.setAutoRefreshModelsSeconds);
  const searxngUrl = usePrefsStore((s) => s.searxngUrl);
  const setSearxngUrl = usePrefsStore((s) => s.setSearxngUrl);
  const searchLimit = usePrefsStore((s) => s.searchLimit);
  const setSearchLimit = usePrefsStore((s) => s.setSearchLimit);
  const [activeHost, setActiveHost] = useState<string | null>(null);

  useEffect(() => {
    hydratePrefs();
  }, [hydratePrefs]);

  useEffect(() => {
    async function loadHost() {
      try {
        const r = await fetch('/api/hosts');
        if (!r.ok) return;
        const j = await r.json();
        type Host = { url: string; active: boolean };
        const active = Array.isArray(j.hosts) ? (j.hosts as Host[]).find((h) => !!h.active) : null;
        setActiveHost(active?.url || null);
      } catch {
        /* ignore */
      }
    }
    loadHost();
    function onActive() {
      loadHost();
    }
    window.addEventListener('active-host-changed', onActive as EventListener);
    return () => window.removeEventListener('active-host-changed', onActive as EventListener);
  }, []);
  return (
    <div className="p-6 flex flex-col gap-8 max-w-3xl mx-auto items-center">
      <div className="w-full flex flex-col gap-8">
        <section className="rounded-xl border border-white/10 bg-white/5 p-5 flex flex-col gap-8">
          <div>
            <h2 className="text-3xl font-bold tracking-tight bg-gradient-to-br from-white via-white/80 to-white/30 bg-clip-text text-transparent text-center mb-4">
              Settings
            </h2>
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
            <h3 className="text-lg font-semibold text-white/90 mb-1">Web Search</h3>
            <div className="flex flex-col gap-3 text-xs text-white/60">
              <div className="flex items-center gap-2 flex-wrap">
                <label className="flex items-center gap-2">
                  <span>SearXNG Instance URL</span>
                  <input
                    type="text"
                    value={searxngUrl}
                    onChange={(e) => setSearxngUrl(e.target.value)}
                    placeholder="https://searx.example.com"
                    className="w-80 rounded bg-white/5 border border-white/15 px-2 py-1 text-[11px]"
                  />
                </label>
              </div>
              <div className="text-[11px] text-white/40 ml-2">
                The base URL of your self-hosted or a public SearXNG instance. This will be used for
                the Web Search tool, e.g. https://searx.space.
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <label className="flex items-center gap-2">
                  <span>Search results</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={searchLimit}
                    onChange={(e) => setSearchLimit(Number(e.target.value) || 0)}
                    className="w-20 rounded bg-white/5 border border-white/15 px-2 py-1 text-[11px]"
                  />
                </label>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={async () => {
                    const url = new URL(searxngUrl);
                    url.pathname =
                      (url.pathname.endsWith('/') ? url.pathname : url.pathname + '/') + 'search';
                    url.searchParams.append('q', 'test');
                    url.searchParams.append('format', 'json');
                    window.open(url, '_blank');
                  }}
                  disabled={!searxngUrl}
                  className="px-3 py-1.5 text-xs rounded-md bg-white/10 hover:bg-white/20 disabled:opacity-50"
                >
                  Test Search
                </button>
              </div>
            </div>
          </div>
        </section>
        <section className="rounded-xl border border-white/10 bg-white/5 p-5 flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white/90 mb-1">Infos</h2>
          </div>
          <div>
            <h3 className="text-base font-semibold text-white/80 mb-1">Host</h3>
            <p className="text-xs text-white/50 mb-3">
              Currently active Ollama endpoint used for operations.
            </p>
            <div className="text-xs font-mono text-white/70">
              <span>{activeHost ? activeHost : '— (none)'}</span>
            </div>
          </div>
          <div>
            <h3 className="text-base font-semibold text-white/80 mb-1">LocalStorage (readonly)</h3>
            <p className="text-xs text-white/50 mb-3">
              All Ollama UI settings currently stored in your browser.
            </p>
            <LocalStorageInfo />
          </div>
        </section>
      </div>
    </div>
  );
}
