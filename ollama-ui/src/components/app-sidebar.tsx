'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  MessagesSquare,
  Package,
  Layers,
  Settings,
  Plus,
  Search,
  Pencil,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Activity,
  Gauge,
} from 'lucide-react';
import { useSessionsStore } from '@/store/sessions';
import { HostIndicator } from './header-brand';
import { BackgroundJobsIndicator } from './background-jobs-indicator';

const COLLAPSE_KEY = 'ollama_ui_sidebar_collapsed';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  match: (p: string) => boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard, match: (p) => p === '/' },
  {
    href: '/chat',
    label: 'Chat',
    icon: MessagesSquare,
    match: (p) => p.startsWith('/chat') || p.startsWith('/playground'),
  },
  { href: '/models', label: 'Models', icon: Package, match: (p) => p.startsWith('/models') },
  {
    href: '/running',
    label: 'Running',
    icon: Activity,
    match: (p) => p.startsWith('/running'),
  },
  { href: '/lamas', label: 'Profiles', icon: Layers, match: (p) => p.startsWith('/lamas') },
  {
    href: '/benchmarks',
    label: 'Benchmarks',
    icon: Gauge,
    match: (p) => p.startsWith('/benchmarks'),
  },
  { href: '/settings', label: 'Settings', icon: Settings, match: (p) => p.startsWith('/settings') },
];

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function AppSidebar() {
  const pathname = usePathname();
  const onChatRoute = pathname.startsWith('/chat') || pathname.startsWith('/playground');
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (raw !== null) setCollapsed(raw === '1');
    } catch {
      /* ignore */
    }
  }, []);
  function toggleCollapsed() {
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  const sessions = useSessionsStore((s) => s.sessions);
  const activeId = useSessionsStore((s) => s.activeId);
  const hydrate = useSessionsStore((s) => s.hydrate);
  const createSession = useSessionsStore((s) => s.create);
  const renameSession = useSessionsStore((s) => s.rename);
  const removeSession = useSessionsStore((s) => s.remove);
  const setActive = useSessionsStore((s) => s.setActive);

  const [search, setSearch] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  interface SearchResult {
    id: string;
    snippet: string;
    matchField: 'title' | 'message';
  }
  // Tagged with the query it answers, rather than reset to null whenever the
  // query changes — so the effect below never needs to call setState
  // synchronously in its own body (only from the debounced fetch callback,
  // which is the pattern used elsewhere in this codebase). Stale results
  // from a previous query are simply ignored below once `search` moves on.
  const [searchResults, setSearchResults] = useState<{
    query: string;
    results: SearchResult[];
  } | null>(null);
  useEffect(() => {
    const q = search.trim();
    // Search covers message content too — the lightweight session list here
    // doesn't carry message bodies (see src/store/sessions.ts), so that has
    // to go through the server.
    if (!q) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/sessions/search?q=${encodeURIComponent(q)}`, {
          cache: 'no-store',
        });
        if (!r.ok || cancelled) return;
        const j = await r.json();
        if (!cancelled) {
          setSearchResults({ query: q, results: Array.isArray(j.results) ? j.results : [] });
        }
      } catch {
        /* keep whatever results we already had */
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search]);

  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const currentResults =
    searchResults && searchResults.query === search.trim() ? searchResults.results : null;
  const snippetById = new Map((currentResults ?? []).map((r) => [r.id, r]));
  const filtered = (() => {
    const q = search.trim();
    if (!q) return sorted;
    if (currentResults) {
      // Server results are authoritative once loaded — cover title AND
      // message content, ranked by recency same as the default list.
      const ids = new Set(currentResults.map((r) => r.id));
      return sorted.filter((s) => ids.has(s.id));
    }
    // Debounced request still in flight — instant title-only filtering so
    // the list doesn't flash empty while typing.
    return sorted.filter((s) => s.title.toLowerCase().includes(q.toLowerCase()));
  })();

  return (
    <aside
      className={`glass-panel flex flex-col border-r shrink-0 transition-[width] duration-200 ${
        collapsed ? 'w-[60px]' : 'w-[264px]'
      }`}
    >
      <div className="flex items-center gap-2.5 px-3 py-3 border-b border-white/[0.07]">
        <div
          className="h-7 w-7 rounded-lg flex items-center justify-center text-sm shrink-0 border border-white/10 bg-gradient-to-br from-[rgb(var(--accent-glow)/0.85)] to-[rgb(var(--accent-glow)/0.45)] shadow-[0_0_14px_-2px_rgb(var(--accent-glow)/0.55)]"
          aria-hidden="true"
        >
          🦙
        </div>
        {!collapsed && (
          <span className="text-[13px] font-semibold tracking-tight whitespace-nowrap">
            Ollama UI
          </span>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="ml-auto text-white/35 hover:text-white/85 transition p-1 rounded-md hover:bg-white/5"
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </button>
      </div>

      {/* Primary navigation */}
      <nav className="flex flex-col gap-1 px-2 py-2.5 border-b border-white/[0.07]">
        {NAV_ITEMS.map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              className={`group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium transition-all duration-150 ${
                active
                  ? 'bg-[rgb(var(--accent-glow)/0.13)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]'
                  : 'text-white/50 hover:bg-white/[0.05] hover:text-white/90'
              } ${collapsed ? 'justify-center px-0' : ''}`}
            >
              {active && !collapsed && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-[3px] rounded-full bg-[rgb(var(--accent-glow))] shadow-[0_0_8px_rgb(var(--accent-glow)/0.8)]" />
              )}
              <Icon
                className={`h-4 w-4 shrink-0 transition-colors ${
                  active
                    ? 'text-[rgb(var(--accent-glow))]'
                    : 'text-white/40 group-hover:text-white/70'
                }`}
              />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Host status */}
      <div
        className={`border-b border-white/[0.07] px-3 py-2.5 ${collapsed ? 'flex justify-center' : ''}`}
      >
        {collapsed ? (
          <span className="relative flex h-1.5 w-1.5">
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]"></span>
          </span>
        ) : (
          <div className="flex flex-col gap-2">
            <HostIndicator />
            <BackgroundJobsIndicator />
          </div>
        )}
      </div>

      {onChatRoute && (
        <>
          <div className="px-2 pt-2.5">
            <button
              type="button"
              onClick={() => createSession(null)}
              className={`w-full flex items-center gap-2 rounded-lg border border-[rgb(var(--accent-glow)/0.3)] bg-[rgb(var(--accent-glow)/0.08)] px-2.5 py-2 text-[11px] font-medium text-white/70 hover:text-white hover:bg-[rgb(var(--accent-glow)/0.16)] hover:border-[rgb(var(--accent-glow)/0.5)] hover:shadow-[0_0_16px_-4px_rgb(var(--accent-glow)/0.5)] transition-all ${
                collapsed ? 'justify-center px-0' : ''
              }`}
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              {!collapsed && <span>New chat</span>}
            </button>
          </div>

          {!collapsed && (
            <div className="px-3 pt-3">
              <span className="section-label">Sessions</span>
              <div className="relative mt-1.5">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-white/30 pointer-events-none" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search titles & messages…"
                  className="w-full text-xs bg-white/[0.06] border border-white/10 rounded-lg pl-7 pr-2 py-1.5 text-white placeholder:text-white/25 focus:outline-none focus:border-[rgb(var(--accent-glow)/0.5)] focus:bg-white/[0.08] transition-colors"
                />
              </div>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 flex flex-col gap-0.5">
            {filtered.map((sess) => {
              const active = sess.id === activeId;
              const editing = editingId === sess.id;
              return (
                <div
                  key={sess.id}
                  className={`group rounded-lg px-2 py-1.5 transition ${
                    active
                      ? 'bg-[rgb(var(--accent-glow)/0.12)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                      : 'text-white/60 hover:bg-white/[0.05] hover:text-white/85'
                  }`}
                >
                  {editing ? (
                    <input
                      autoFocus
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onBlur={() => {
                        if (editingTitle.trim()) renameSession(sess.id, editingTitle.trim());
                        setEditingId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      className="w-full text-xs bg-white/10 border border-white/15 rounded px-1.5 py-0.5 text-white focus:outline-none"
                    />
                  ) : collapsed ? (
                    <button
                      type="button"
                      onClick={() => setActive(sess.id)}
                      title={sess.title}
                      className="w-full flex justify-center"
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          active
                            ? 'bg-[rgb(var(--accent-glow))] shadow-[0_0_6px_rgb(var(--accent-glow)/0.8)]'
                            : 'bg-white/25'
                        }`}
                      />
                    </button>
                  ) : (
                    <div className="flex items-start gap-1">
                      <button
                        type="button"
                        onClick={() => setActive(sess.id)}
                        className="flex-1 min-w-0 text-left"
                      >
                        <div className="text-xs truncate flex items-center gap-1.5">
                          <span className="truncate">{sess.title}</span>
                        </div>
                        {snippetById.get(sess.id)?.matchField === 'message' ? (
                          <div className="text-[10px] text-white/35 mt-0.5 truncate italic">
                            “{snippetById.get(sess.id)!.snippet}”
                          </div>
                        ) : (
                          <div className="text-[10px] text-white/30 font-mono mt-0.5">
                            {formatRelative(sess.updatedAt)}
                          </div>
                        )}
                      </button>
                      <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(sess.id);
                            setEditingTitle(sess.title);
                          }}
                          title="Rename"
                          className="text-white/30 hover:text-white/80 p-1 rounded hover:bg-white/10 transition"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (deleteConfirm === sess.id) {
                              removeSession(sess.id);
                              setDeleteConfirm(null);
                            } else {
                              setDeleteConfirm(sess.id);
                              setTimeout(() => setDeleteConfirm(null), 4000);
                            }
                          }}
                          title={deleteConfirm === sess.id ? 'Click to confirm' : 'Delete'}
                          className={`p-1 rounded transition ${
                            deleteConfirm === sess.id
                              ? 'text-red-300 bg-red-500/15'
                              : 'text-white/30 hover:text-red-300 hover:bg-white/10'
                          }`}
                        >
                          {deleteConfirm === sess.id ? (
                            <span className="text-[10px] font-bold leading-none px-0.5">?</span>
                          ) : (
                            <X className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {filtered.length === 0 && !collapsed && (
              <div className="text-[11px] text-white/30 px-2 py-1">No sessions.</div>
            )}
          </div>

          {!collapsed && (
            <div className="border-t border-white/[0.07] px-3 py-2 text-[10px] font-mono text-white/30">
              {sessions.length} session{sessions.length === 1 ? '' : 's'}
            </div>
          )}
        </>
      )}

      {!onChatRoute && <div className="flex-1" />}

      {!collapsed && (
        <div className="border-t border-white/[0.07] px-3 py-2 text-[10px] text-white/25 font-mono">
          ⌘K — command palette
        </div>
      )}
    </aside>
  );
}
