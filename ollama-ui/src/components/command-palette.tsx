'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import {
  Search,
  LayoutDashboard,
  MessagesSquare,
  Package,
  Layers,
  Settings,
  Plus,
  Server,
  Palette,
} from 'lucide-react';
import { useSessionsStore } from '@/store/sessions';
import { useThemeStore, type ThemeName } from '@/store/theme';

interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => void;
}

// Keep labels in sync with theme-switcher.tsx.
const THEME_LABELS: { value: ThemeName; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'dark-green', label: 'Dark Green' },
  { value: 'neon', label: 'Neon Purple' },
  { value: 'neon-orange', label: 'Neon Orange' },
  { value: 'neon-red', label: 'Neon Red' },
  { value: 'neon-blue', label: 'Neon Blue' },
];

const PAGES: { href: string; label: string; icon: PaletteAction['icon'] }[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/chat', label: 'Chat', icon: MessagesSquare },
  { href: '/models', label: 'Models', icon: Package },
  { href: '/lamas', label: 'Profiles', icon: Layers },
  { href: '/settings', label: 'Settings', icon: Settings },
];

/**
 * Global ⌘K / Ctrl+K command palette. Renders in a portal on document.body
 * (fixed overlay, not scoped to any page layout).
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const router = useRouter();

  const sessions = useSessionsStore((s) => s.sessions);
  const setActiveSession = useSessionsStore((s) => s.setActive);
  const createSession = useSessionsStore((s) => s.create);
  const hydrateSessions = useSessionsStore((s) => s.hydrate);
  const setTheme = useThemeStore((s) => s.setTheme);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (open) hydrateSessions();
  }, [open, hydrateSessions]);

  // Global shortcut: toggle on Cmd/Ctrl+K from anywhere, including inputs.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [open]);

  function close() {
    setOpen(false);
  }

  const actions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = [];

    for (const page of PAGES) {
      list.push({
        id: `page:${page.href}`,
        label: `Go to ${page.label}`,
        hint: 'Page',
        icon: page.icon,
        run: () => {
          router.push(page.href);
          close();
        },
      });
    }

    list.push({
      id: 'session:new',
      label: 'New chat',
      hint: 'Session',
      icon: Plus,
      run: () => {
        void createSession(null);
        router.push('/chat');
        close();
      },
    });
    for (const s of sessions) {
      list.push({
        id: `session:${s.id}`,
        label: `Switch to: ${s.title}`,
        hint: 'Session',
        icon: MessagesSquare,
        run: () => {
          setActiveSession(s.id);
          router.push('/chat');
          close();
        },
      });
    }

    list.push({
      id: 'action:host-manager',
      label: 'Manage Ollama hosts',
      hint: 'Action',
      icon: Server,
      run: () => {
        router.push('/');
        // The host manager is opened by the sidebar's HostIndicator, which
        // listens for this event but may not be mounted yet right after a
        // navigation — give it a moment.
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('open-host-manager'));
        }, 300);
        close();
      },
    });

    for (const t of THEME_LABELS) {
      list.push({
        id: `theme:${t.value}`,
        label: `Theme: ${t.label}`,
        hint: 'Theme',
        icon: Palette,
        run: () => {
          setTheme(t.value);
          close();
        },
      });
    }

    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => a.label.toLowerCase().includes(q));
  }, [actions, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  function onKeyDownInput(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (filtered.length ? (i + 1) % filtered.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const action = filtered[activeIndex];
      if (action) action.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  if (!mounted || !open) return null;

  const content = (
    <div className="fixed inset-0 z-[120] flex items-start justify-center p-6">
      <div
        className="anim-backdrop-in absolute inset-0 bg-black/65 backdrop-blur-md"
        onClick={close}
      />
      <div
        className="anim-modal-in relative mt-[15vh] w-full max-w-lg rounded-2xl border border-white/10 bg-[#0e1220]/95 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.8),0_0_40px_-12px_rgb(var(--accent-glow)/0.25)] backdrop-blur-xl overflow-hidden flex flex-col"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.07]">
          <Search className="h-4 w-4 text-white/35 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDownInput}
            placeholder="Type a command…"
            className="flex-1 bg-transparent text-sm text-white placeholder:text-white/30 focus:outline-none"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-2 flex flex-col gap-0.5">
          {filtered.length === 0 && (
            <div className="text-white/30 text-xs px-3 py-4 text-center">No matching commands</div>
          )}
          {filtered.map((a, idx) => {
            const Icon = a.icon;
            const active = idx === activeIndex;
            return (
              <button
                key={a.id}
                ref={(el) => {
                  itemRefs.current[idx] = el;
                }}
                type="button"
                onClick={a.run}
                onMouseEnter={() => setActiveIndex(idx)}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs transition ${
                  active
                    ? 'bg-[rgb(var(--accent-glow)/0.13)] text-white'
                    : 'text-white/60 hover:bg-white/[0.05] hover:text-white/85'
                }`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-white/40" />
                <span className="flex-1 truncate">{a.label}</span>
                {a.hint && (
                  <span className="cap-pill border-white/10 bg-white/5 text-white/35 shrink-0">
                    {a.hint}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between px-4 py-2 border-t border-white/[0.07] text-[10px] text-white/30 font-mono">
          <span>↑↓ navigate · ↵ select · esc close</span>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
