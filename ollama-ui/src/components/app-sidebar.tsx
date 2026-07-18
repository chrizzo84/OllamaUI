'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSessionsStore } from '@/store/sessions';
import { HostIndicator } from './header-brand';

const COLLAPSE_KEY = 'ollama_ui_sidebar_collapsed';

interface NavItem {
  href: string;
  label: string;
  icon: string;
  match: (p: string) => boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: '◧', match: (p) => p === '/' },
  {
    href: '/chat',
    label: 'Chat',
    icon: '💬',
    match: (p) => p.startsWith('/chat') || p.startsWith('/playground'),
  },
  { href: '/models', label: 'Models', icon: '📦', match: (p) => p.startsWith('/models') },
  { href: '/lamas', label: 'Profiles', icon: '🗂️', match: (p) => p.startsWith('/lamas') },
  { href: '/settings', label: 'Settings', icon: '⚙️', match: (p) => p.startsWith('/settings') },
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

  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const filtered = sorted.filter((s) => {
    if (!search.trim()) return true;
    return s.title.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <aside
      className={`flex flex-col border-r border-white/10 bg-white/[0.03] shrink-0 transition-[width] ${
        collapsed ? 'w-[56px]' : 'w-[260px]'
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-3 border-b border-white/10">
        <div className="h-6 w-6 rounded-md bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center text-xs shrink-0">
          🦙
        </div>
        {!collapsed && <span className="text-[13px] font-semibold tracking-tight">Ollama UI</span>}
        <button
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="ml-auto text-white/40 hover:text-white/80 transition text-xs"
        >
          {collapsed ? '›' : '‹'}
        </button>
      </div>

      {/* Primary navigation */}
      <nav className="flex flex-col gap-0.5 px-2 py-2 border-b border-white/10">
        {NAV_ITEMS.map((item) => {
          const active = item.match(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition ${
                active
                  ? 'bg-indigo-500/15 text-white'
                  : 'text-white/55 hover:bg-white/5 hover:text-white/85'
              } ${collapsed ? 'justify-center' : ''}`}
            >
              <span className="w-4 text-center shrink-0">{item.icon}</span>
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Host status */}
      <div
        className={`border-b border-white/10 px-3 py-2.5 ${collapsed ? 'flex justify-center' : ''}`}
      >
        {collapsed ? (
          <span className="relative flex h-1.5 w-1.5">
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
          </span>
        ) : (
          <HostIndicator />
        )}
      </div>

      {onChatRoute && (
        <>
          <div className="px-2 pt-2">
            <button
              type="button"
              onClick={() => createSession(null)}
              className={`w-full flex items-center gap-2 rounded-md border border-dashed border-white/15 px-2 py-1.5 text-[11px] text-white/40 hover:text-white/80 hover:border-white/30 transition ${
                collapsed ? 'justify-center' : ''
              }`}
            >
              <span>＋</span>
              {!collapsed && <span>New chat</span>}
            </button>
          </div>

          {!collapsed && (
            <div className="px-3 pt-2">
              <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
                Sessions
              </span>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
                className="mt-1.5 w-full text-xs bg-white/10 border border-white/15 rounded px-2 py-1 text-white focus:outline-none"
              />
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 flex flex-col gap-0.5">
            {filtered.map((sess) => {
              const active = sess.id === activeId;
              const editing = editingId === sess.id;
              return (
                <div
                  key={sess.id}
                  className={`group rounded-md px-2 py-1.5 transition ${
                    active
                      ? 'bg-indigo-500/15 text-white'
                      : 'text-white/60 hover:bg-white/5 hover:text-white/85'
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
                      <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" />
                    </button>
                  ) : (
                    <div className="flex items-start gap-1">
                      <button
                        type="button"
                        onClick={() => setActive(sess.id)}
                        className="flex-1 min-w-0 text-left"
                      >
                        <div className="text-xs truncate flex items-center gap-1.5">
                          {sess.titleStatus === 'pending' ? (
                            <span className="text-white/40 italic animate-pulse">
                              Generating title…
                            </span>
                          ) : (
                            <span className="truncate">{sess.title}</span>
                          )}
                        </div>
                        <div className="text-[10px] text-white/30 font-mono mt-0.5">
                          {formatRelative(sess.updatedAt)}
                        </div>
                      </button>
                      <div className="hidden group-hover:flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(sess.id);
                            setEditingTitle(sess.title);
                          }}
                          title="Rename"
                          className="text-white/30 hover:text-white/70 text-[11px] px-1"
                        >
                          ✎
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
                          className={`text-[11px] px-1 ${
                            deleteConfirm === sess.id
                              ? 'text-red-300'
                              : 'text-white/30 hover:text-red-300'
                          }`}
                        >
                          {deleteConfirm === sess.id ? '?' : '✕'}
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
            <div className="border-t border-white/10 px-3 py-2 text-[10px] font-mono text-white/30">
              {sessions.length} session{sessions.length === 1 ? '' : 's'}
            </div>
          )}
        </>
      )}

      {!onChatRoute && <div className="flex-1" />}
    </aside>
  );
}
