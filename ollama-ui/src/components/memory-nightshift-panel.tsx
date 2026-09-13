'use client';
/**
 * The memory's maintenance pass, as something you can see and steer.
 *
 * It reads new conversations, offers merges for facts that overlap, and lets
 * old episodic facts age out — unattended, at night, on a machine that is
 * otherwise idle. That is the riskiest thing this app does, so the panel
 * leads with what it *did* rather than with its settings: the last runs and
 * their counts, then the schedule.
 *
 * Off by default. Nothing starts editing the memory overnight because a
 * version was installed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToastStore } from '@/store/toast';
import { Moon, Square, AlertTriangle } from 'lucide-react';

interface Run {
  id: string;
  trigger: 'schedule' | 'manual';
  status: 'running' | 'done' | 'stopped' | 'error';
  model: string | null;
  startedAt: number;
  finishedAt: number | null;
  conversationsRead: number;
  factsFound: number;
  mergesProposed: number;
  archived: number;
  error: string | null;
}

interface State {
  settings: {
    enabled: boolean;
    timeOfDay: string;
    model: string;
    conversationLimit: number;
    decayDays: number;
  };
  running: boolean;
  step: 'starting' | 'reading' | 'merging' | 'archiving' | null;
  reading: {
    processed: number;
    total: number;
    found: number;
    currentStartedAt: number | null;
  } | null;
  pendingConversations: number;
  runs: Run[];
}

/** The step names, in the language the rest of the panel is written in. */
const STEP_LABEL: Record<NonNullable<State['step']>, string> = {
  starting: 'startet',
  reading: 'liest neue Gespräche',
  merging: 'sucht nach Überschneidungen',
  archiving: 'räumt alte Ereignisse weg',
};

function when(ms: number): string {
  const diff = Date.now() - ms;
  const day = Math.floor(diff / 86_400_000);
  if (day > 1) return `vor ${day} Tagen`;
  const hour = Math.floor(diff / 3_600_000);
  if (hour >= 1) return `vor ${hour} h`;
  const min = Math.floor(diff / 60_000);
  return min >= 1 ? `vor ${min} min` : 'gerade eben';
}

export function MemoryNightShift({ onFinished }: { onFinished: () => void }) {
  const pushToast = useToastStore((s) => s.push);
  const [state, setState] = useState<State | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [, tick] = useState(0);
  const wasRunning = useRef(false);

  const poll = useCallback(async () => {
    try {
      const r = await fetch('/api/memories/nightshift', { cache: 'no-store' });
      if (r.ok) setState(await r.json());
    } catch {
      /* the panel simply stops updating */
    }
  }, []);

  useEffect(() => {
    poll();
    (async () => {
      const r = await fetch('/api/models', { cache: 'no-store' });
      if (!r.ok) return;
      const data = await r.json();
      setModels(
        ((data.models ?? data.items ?? []) as { name?: string }[])
          .map((m) => m.name)
          .filter((n): n is string => !!n),
      );
    })();
  }, [poll]);

  /*
  Polled while idle too, just slowly.

  The night shift is the one job here that starts without anybody pressing
  anything. Polling only while `running` meant the panel could never see a
  run begin: it learned about a 03:30 pass only if the page happened to be
  reloaded while it was still going, so from the outside the feature looked
  inert while the Ollama log showed it working. Twenty seconds is cheap —
  three SQLite reads — and it is the difference between a panel that reports
  and one that has to be asked.
  */
  useEffect(() => {
    if (!state?.running) {
      if (wasRunning.current) {
        wasRunning.current = false;
        onFinished();
      }
      const idle = setInterval(poll, 20_000);
      return () => clearInterval(idle);
    }
    wasRunning.current = true;
    const id = setInterval(poll, 2000);
    const ticker = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      clearInterval(id);
      clearInterval(ticker);
    };
  }, [state?.running, poll, onFinished]);

  async function save(patch: Record<string, unknown>, run = false) {
    setSaving(true);
    try {
      const r = await fetch('/api/memories/nightshift', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...patch, run }),
      });
      if (r.status === 428) {
        pushToast({ type: 'error', message: 'Kein aktiver Ollama-Host konfiguriert.' });
        return;
      }
      if (r.status === 400) {
        pushToast({ type: 'error', message: 'Kein Modell ausgewählt.' });
        return;
      }
      if (!r.ok) throw new Error();
      setState(await r.json());
    } catch {
      pushToast({ type: 'error', message: 'Konnte nicht gespeichert werden.' });
    } finally {
      setSaving(false);
    }
  }

  if (!state) return null;
  const { settings, runs } = state;
  const last = runs[0];

  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white/80">
            <Moon className="h-3.5 w-3.5" />
            Nachtschicht
          </h2>
          <p className="mt-0.5 max-w-2xl text-[11px] leading-relaxed text-white/40">
            Liest nachts neue Gespräche, schlägt Zusammenfassungen für überlappende Fakten vor und
            lässt alte Ereignis-Fakten ins Archiv wandern. Sie <em>schlägt vor</em> — alles
            Gefundene landet als Entwurf zur Prüfung, nichts wird ungefragt gültig.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state.running ? (
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await fetch('/api/memories/nightshift', { method: 'DELETE' }).catch(() => {});
                poll();
              }}
            >
              <Square className="h-3 w-3" /> Anhalten
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => save({}, true)} loading={saving}>
              Jetzt laufen lassen
            </Button>
          )}
        </div>
      </div>

      {state.running && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[rgb(var(--accent-glow)/0.3)] bg-[rgb(var(--accent-glow)/0.06)] px-3 py-2 text-xs text-white/70">
          <span className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[rgb(var(--accent-glow)/0.6)]" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[rgb(var(--accent-glow))]" />
            </span>
            {state.step ? STEP_LABEL[state.step] : 'läuft'}
          </span>
          {state.reading && (
            <span className="font-mono text-[10px] text-white/45">
              {state.reading.processed} / {state.reading.total} Gespräche · {state.reading.found}{' '}
              gefunden
              {state.reading.currentStartedAt
                ? ` · liest seit ${Math.max(0, Math.round((Date.now() - state.reading.currentStartedAt) / 1000))}s`
                : ''}
            </span>
          )}
        </div>
      )}

      {/*
      An enabled schedule with no model never runs and says nothing about it —
      the tick just returns. Silence is the wrong answer to a switch someone
      deliberately turned on.
      */}
      {settings.enabled && !settings.model && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-amber-200/80">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Nachts automatisch ist an, aber es ist kein Modell gewählt — so läuft nichts.
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
        <label className="flex cursor-pointer select-none items-center gap-2">
          <input
            type="checkbox"
            className="accent-violet-500"
            checked={settings.enabled}
            onChange={(e) => save({ enabled: e.target.checked })}
          />
          <span className="text-white/70">Nachts automatisch</span>
        </label>
        <label className="flex items-center gap-2 text-white/45">
          um
          <input
            type="time"
            value={settings.timeOfDay}
            onChange={(e) => save({ timeOfDay: e.target.value })}
            className="rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-white/70 focus:outline-none"
          />
        </label>
        <label className="flex items-center gap-2 text-white/45">
          mit
          <select
            value={settings.model}
            onChange={(e) => save({ model: e.target.value })}
            className="rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-white/70 focus:outline-none"
          >
            <option value="" className="bg-neutral-900">
              (Modell wählen)
            </option>
            {models.map((m) => (
              <option key={m} value={m} className="bg-neutral-900">
                {m}
              </option>
            ))}
          </select>
        </label>
        <label
          className="flex items-center gap-2 text-white/45"
          title="Ereignis-Fakten, die so lange niemand abgerufen hat, wandern ins Archiv. Identität, Vorlieben und Angepinntes sind davon nie betroffen."
        >
          Archiv nach
          <input
            type="number"
            min={7}
            max={3650}
            value={settings.decayDays}
            onChange={(e) => save({ decayDays: Number(e.target.value) })}
            className="w-16 rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-white/70 focus:outline-none"
          />
          Tagen
        </label>
        {state.pendingConversations > 0 && (
          <span className="text-white/30">{state.pendingConversations} Gespräche warten</span>
        )}
      </div>

      {/* What it did, before what it is set to do — the record is the part
          that earns the trust. */}
      {runs.length > 0 && (
        <div className="mt-4 border-t border-white/5 pt-3">
          <div className="mb-2 text-[10px] font-mono uppercase tracking-wider text-white/30">
            Letzte Durchläufe
          </div>
          <ul className="flex flex-col gap-1.5">
            {runs.slice(0, 5).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                <span
                  className={
                    r.status === 'error'
                      ? 'text-red-400/80'
                      : r.status === 'stopped'
                        ? 'text-white/40'
                        : 'text-emerald-400/70'
                  }
                >
                  {r.status === 'done'
                    ? 'fertig'
                    : r.status === 'error'
                      ? 'Fehler'
                      : r.status === 'stopped'
                        ? 'angehalten'
                        : 'läuft'}
                </span>
                <span className="text-white/35">{when(r.startedAt)}</span>
                <span className="text-white/30">
                  {r.trigger === 'schedule' ? 'automatisch' : 'von Hand'}
                </span>
                <span className="text-white/50">
                  {r.conversationsRead} Gespräche · {r.factsFound} Fakten · {r.mergesProposed}{' '}
                  Zusammenfassungen · {r.archived} archiviert
                </span>
                {r.error && <span className="text-red-400/70">{r.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!runs.length && !state.running && (
        <p className="mt-3 text-[11px] text-white/30">Noch nie gelaufen.</p>
      )}
      {last?.status === 'done' && last.factsFound + last.mergesProposed > 0 && (
        <p className="mt-2 text-[11px] text-amber-200/60">
          Der letzte Durchlauf hat {last.factsFound + last.mergesProposed} Entwürfe hinterlassen —
          oben zur Prüfung.
        </p>
      )}
    </section>
  );
}
