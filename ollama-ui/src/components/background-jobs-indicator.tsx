'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useSessionsStore } from '@/store/sessions';
import { useToastStore } from '@/store/toast';

interface JobSummary {
  id: string;
  sessionId: string;
  column: 'A' | 'B';
  model: string;
  status: 'running' | 'done' | 'error' | 'aborted';
  createdAt: number;
}

const POLL_MS = 4000;
// Prepended to the tab title while something finished and the tab wasn't
// focused to see it — no Notification API needed (and it's blocked on
// non-HTTPS origins anyway), just a plain, permission-free visual cue.
const TITLE_PREFIX = '✓ Fertig — ';

// Global "N generating" indicator + completion toasts, visible from any page
// (mounted once in app-sidebar.tsx) — not just the chat page a given job
// happens to belong to. Polls GET /api/chat/jobs (the job registry from
// src/lib/generation-jobs.ts) rather than opening a stream, since this only
// needs a coarse "is anything running" view, not live token deltas.
export function BackgroundJobsIndicator() {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [open, setOpen] = useState(false);
  const knownRef = useRef<Map<string, JobSummary>>(new Map());
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const router = useRouter();
  const pushToast = useToastStore((s) => s.push);

  // Restore the real tab title once the user actually looks at the tab again.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible' && document.title.startsWith(TITLE_PREFIX)) {
        document.title = document.title.slice(TITLE_PREFIX.length);
      }
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      let incoming: JobSummary[];
      try {
        const r = await fetch('/api/chat/jobs', { cache: 'no-store' });
        if (!r.ok || cancelled) return;
        const data = (await r.json()) as { jobs?: JobSummary[] };
        incoming = Array.isArray(data.jobs) ? data.jobs : [];
      } catch {
        return; // next poll retries
      }
      if (cancelled) return;

      // A job that was 'running' last poll and now shows a terminal status
      // just finished — notify, unless it belongs to the session the user
      // is already looking at (useColumnChat's own live view already
      // covers that case; a second toast would just be noise).
      const activeSessionId = useSessionsStore.getState().activeId;
      for (const [id, prev] of knownRef.current) {
        if (prev.status !== 'running') continue;
        const now = incoming.find((j) => j.id === id);
        if (!now || now.status === 'running' || now.sessionId === activeSessionId) continue;
        const session = useSessionsStore.getState().sessions.find((s) => s.id === now.sessionId);
        pushToast({
          type: now.status === 'error' ? 'error' : 'success',
          title: now.status === 'error' ? 'Antwort fehlgeschlagen' : 'Antwort fertig',
          message: session?.title || 'Chat',
        });
        if (document.visibilityState !== 'visible' && !document.title.startsWith(TITLE_PREFIX)) {
          document.title = TITLE_PREFIX + document.title;
        }
      }

      knownRef.current = new Map(incoming.map((j) => [j.id, j]));
      setJobs(incoming.filter((j) => j.status === 'running'));
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pushToast]);

  if (jobs.length === 0) return null;

  function jumpTo(sessionId: string) {
    useSessionsStore.getState().setActive(sessionId);
    setOpen(false);
    router.push('/chat');
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-full border border-[rgb(var(--accent-glow)/0.35)] bg-[rgb(var(--accent-glow)/0.12)] px-2.5 py-1 text-[11px] font-medium text-white/80 hover:bg-[rgb(var(--accent-glow)/0.2)] transition"
        title={`${jobs.length} response${jobs.length === 1 ? '' : 's'} generating`}
      >
        <Loader2 className="h-3 w-3 animate-spin text-[rgb(var(--accent-glow))]" />
        {jobs.length} generating
      </button>
      {open && (
        <div
          ref={popoverRef}
          className="absolute left-0 top-full z-50 mt-2 flex min-w-[220px] flex-col gap-1 rounded-lg border border-white/15 bg-[#1a1f2e]/95 p-2 shadow-2xl backdrop-blur-xl"
          role="dialog"
          aria-label="Generating responses"
        >
          {jobs.map((j) => {
            const session = useSessionsStore.getState().sessions.find((s) => s.id === j.sessionId);
            return (
              <button
                key={j.id}
                type="button"
                onClick={() => jumpTo(j.sessionId)}
                className="rounded-md px-2 py-1.5 text-left text-xs text-white/70 transition hover:bg-white/10 hover:text-white"
              >
                <div className="truncate">{session?.title || 'Chat'}</div>
                <div className="font-mono text-[10px] text-white/40">
                  {j.model}
                  {j.column === 'B' ? ' · column B' : ''}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
