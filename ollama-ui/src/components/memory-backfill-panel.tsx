'use client';
/**
 * Reading past conversations for facts nobody collected at the time.
 *
 * The extractor only started running today, so every conversation before it
 * is unexamined — and that is where the durable facts usually are, since
 * people explain their setup once, early, and never repeat it.
 *
 * Deliberately a button rather than something that happens by itself: the
 * run occupies the same GPU the user chats with, for one model call per
 * message, and starting that unannounced would be felt as the machine
 * getting slow for no visible reason. The night shift can have the timer
 * later — this is the same job with a person deciding when.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToastStore } from '@/store/toast';
import { History, Square, RotateCcw, AlertTriangle } from 'lucide-react';

interface Progress {
  status: 'idle' | 'running' | 'done' | 'stopped' | 'error';
  processed: number;
  total: number;
  found: number;
  duplicates: number;
  messages: number;
  currentStartedAt: number | null;
  error: string | null;
  model: string | null;
  remaining: number;
  remainingConversations: number;
  scanned: number;
}

export function MemoryBackfill({ onFinished }: { onFinished: () => void }) {
  const pushToast = useToastStore((s) => s.push);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [starting, setStarting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  // Re-rendered once a second while a call is out, so the elapsed counter
  // below actually moves — see why that matters at its render site.
  const [, tick] = useState(0);
  const wasRunning = useRef(false);

  const poll = useCallback(async () => {
    try {
      const r = await fetch('/api/memories/backfill', { cache: 'no-store' });
      if (r.ok) setProgress(await r.json());
    } catch {
      /* the panel just stops updating */
    }
  }, []);

  useEffect(() => {
    poll();
    (async () => {
      const r = await fetch('/api/models', { cache: 'no-store' });
      if (!r.ok) return;
      const data = await r.json();
      const list = ((data.models ?? data.items ?? []) as { name?: string }[])
        .map((m) => m.name)
        .filter((n): n is string => !!n);
      setModels(list);
      setModel((current) => current || list[0] || '');
    })();
  }, [poll]);

  // Only polls while something is running — an idle panel has nothing to ask
  // about, and this sits on a page people leave open.
  useEffect(() => {
    if (progress?.status !== 'running') {
      if (wasRunning.current) {
        wasRunning.current = false;
        onFinished();
      }
      return;
    }
    wasRunning.current = true;
    const id = setInterval(poll, 1500);
    const ticker = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      clearInterval(id);
      clearInterval(ticker);
    };
  }, [progress?.status, poll, onFinished]);

  async function start() {
    if (!model) return;
    setStarting(true);
    try {
      const r = await fetch('/api/memories/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (r.status === 428) {
        pushToast({ type: 'error', message: 'Kein aktiver Ollama-Host konfiguriert.' });
        return;
      }
      if (!r.ok) throw new Error('Start fehlgeschlagen');
      setProgress(await r.json());
    } catch {
      pushToast({ type: 'error', message: 'Konnte den Durchlauf nicht starten.' });
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    await fetch('/api/memories/backfill', { method: 'DELETE' }).catch(() => {});
    poll();
  }

  /**
   * Forgets which messages were already examined, so everything can be read
   * again. Two clicks, because it means paying for the whole history in model
   * time a second time.
   */
  async function reset() {
    if (!confirmReset) {
      setConfirmReset(true);
      setTimeout(() => setConfirmReset(false), 5000);
      return;
    }
    setConfirmReset(false);
    try {
      const r = await fetch('/api/memories/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reset: true }),
      });
      if (!r.ok) throw new Error();
      setProgress(await r.json());
      pushToast({ type: 'success', message: 'Alle Gespräche gelten wieder als ungelesen.' });
    } catch {
      pushToast({ type: 'error', message: 'Konnte nicht zurückgesetzt werden.' });
    }
  }

  if (!progress) return null;
  const running = progress.status === 'running';
  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  // Nothing to do and nothing done: don't offer a button that would be a
  // no-op, but do say why it isn't there.
  if (!running && progress.remaining === 0 && progress.scanned === 0) return null;

  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white/80">
            <History className="h-3.5 w-3.5" />
            Frühere Gespräche auswerten
          </h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-white/40">
            {running
              ? `Läuft mit ${progress.model} — ein Modellaufruf pro Gespräch, das belegt die GPU.`
              : progress.remaining > 0
                ? `${progress.remainingConversations} Gespräch${progress.remainingConversations === 1 ? '' : 'e'} mit ${progress.remaining} ungeprüften Nachrichten. Jedes wird als Ganzes gelesen — ein Modellaufruf pro Gespräch. Gefundenes landet oben zur Prüfung.`
                : `Alle ${progress.scanned} Nachrichten sind ausgewertet — jedes Gespräch wurde einmal gelesen.`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!running && progress.remaining > 0 && (
            <>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-xs text-white/70 focus:outline-none"
                title="Modell, das die Fakten herausliest"
              >
                {models.map((m) => (
                  <option key={m} value={m} className="bg-neutral-900">
                    {m}
                  </option>
                ))}
              </select>
              <Button size="sm" onClick={start} loading={starting} disabled={!model}>
                Durchgehen
              </Button>
            </>
          )}
          {/*
          A pass that read everything and found nothing looks identical to one
          that never really ran — and until a moment ago it could be exactly
          that. Offering the re-read here is what turns "alle ausgewertet, 0
          gefunden" from a dead end into something a person can question.
          */}
          {!running && progress.scanned > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={reset}
              title="Vergisst, welche Nachrichten schon gelesen wurden — danach kann die Historie neu ausgewertet werden, z.B. mit einem stärkeren Modell."
            >
              <RotateCcw className="h-3 w-3" />
              {confirmReset ? 'Wirklich?' : 'Nochmal lesen'}
            </Button>
          )}
          {running && (
            <Button size="sm" variant="outline" onClick={stop}>
              <Square className="h-3 w-3" /> Anhalten
            </Button>
          )}
        </div>
      </div>

      {/*
      Shown on its own and outside the progress block below, because a run
      whose very first call fails has processed nothing — and that block only
      renders once something has been processed, which hid exactly the
      failures worth seeing.
      */}
      {progress.status === 'error' && progress.error && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-red-200/80">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Abgebrochen: {progress.error}
            <span className="block text-red-200/50">
              Die betroffenen Gespräche bleiben ungelesen und werden beim nächsten Durchlauf erneut
              versucht. Häufigste Ursache: das gewählte Modell kann keine Tools aufrufen.
            </span>
          </span>
        </div>
      )}

      {(running || progress.processed > 0) && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full bg-[rgb(var(--accent-glow))] transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono text-white/35">
            <span>
              {progress.processed} / {progress.total} Gespräche
            </span>
            {progress.messages > 0 && <span>{progress.messages} Nachrichten</span>}
            <span className="text-[rgb(var(--accent-glow))]">{progress.found} gefunden</span>
            {progress.duplicates > 0 && <span>{progress.duplicates} schon bekannt</span>}
            {/*
            A model reading a long transcript is a minute of silence. Without
            an elapsed count next to it, that minute is indistinguishable
            from a hung run — which is the complaint that started this.
            */}
            {running && progress.currentStartedAt && (
              <span className="text-white/50">
                liest seit{' '}
                {Math.max(0, Math.round((Date.now() - progress.currentStartedAt) / 1000))}s
              </span>
            )}
            {progress.status === 'stopped' && <span className="text-white/50">angehalten</span>}
          </div>
        </div>
      )}
    </section>
  );
}
