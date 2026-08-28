'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Pencil, Trash2, X, Check } from 'lucide-react';
import { useSessionsStore } from '@/store/sessions';

interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  model: string;
  timeOfDay: string;
  daysOfWeek: number[];
  toolsEnabled: boolean;
  memoryEnabled: boolean;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRunSessionId: string | null;
  updatedAt: number;
}

interface ModelTag {
  name: string;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_DAYS = [0, 1, 2, 3, 4, 5, 6];

function formatWhen(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

interface FormState {
  name: string;
  prompt: string;
  model: string;
  timeOfDay: string;
  daysOfWeek: number[];
  toolsEnabled: boolean;
  memoryEnabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  prompt: '',
  model: '',
  timeOfDay: '08:00',
  daysOfWeek: DEFAULT_DAYS,
  toolsEnabled: true,
  memoryEnabled: true,
};

export function SchedulePanel() {
  const router = useRouter();
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [models, setModels] = useState<ModelTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null); // null = creating new
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await fetch('/api/scheduled-tasks', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        setTasks(Array.isArray(j.items) ? j.items : []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    fetch('/api/models', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((j) => setModels(Array.isArray(j.models) ? j.models : []))
      .catch(() => {});
  }, []);

  function startCreate() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, model: models[0]?.name ?? '' });
    setError(null);
    setShowForm(true);
  }

  function startEdit(task: ScheduledTask) {
    setEditingId(task.id);
    setForm({
      name: task.name,
      prompt: task.prompt,
      model: task.model,
      timeOfDay: task.timeOfDay,
      daysOfWeek: task.daysOfWeek,
      toolsEnabled: task.toolsEnabled,
      memoryEnabled: task.memoryEnabled,
    });
    setError(null);
    setShowForm(true);
  }

  function toggleDay(day: number) {
    setForm((f) => ({
      ...f,
      daysOfWeek: f.daysOfWeek.includes(day)
        ? f.daysOfWeek.filter((d) => d !== day)
        : [...f.daysOfWeek, day].sort(),
    }));
  }

  async function handleSave() {
    if (!form.name.trim() || !form.prompt.trim() || !form.model || form.daysOfWeek.length === 0) {
      setError('Name, prompt, model and at least one day are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const url = editingId ? `/api/scheduled-tasks/${editingId}` : '/api/scheduled-tasks';
      const r = await fetch(url, {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!r.ok) {
        setError('Failed to save task.');
        return;
      }
      setShowForm(false);
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    await fetch(`/api/scheduled-tasks/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  async function openSession(sessionId: string) {
    // Scheduled-task sessions are created server-side (src/lib/scheduler.ts),
    // not via this store's own create() action, so the sidebar's session
    // list may not know about them yet — force a fresh fetch in that case
    // rather than navigating to a session the sidebar can't show.
    if (!useSessionsStore.getState().sessions.some((s) => s.id === sessionId)) {
      useSessionsStore.setState({ hydrated: false });
      await useSessionsStore.getState().hydrate();
    }
    useSessionsStore.getState().setActive(sessionId);
    router.push('/chat');
  }

  async function handleToggleEnabled(task: ScheduledTask) {
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, enabled: !t.enabled } : t)));
    await fetch(`/api/scheduled-tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !task.enabled }),
    }).catch(() => {});
  }

  return (
    <div className="flex flex-col gap-5">
      {!showForm && (
        <button
          type="button"
          onClick={startCreate}
          className="self-start inline-flex items-center gap-1.5 rounded-md border border-[rgb(var(--accent-glow)/0.3)] bg-[rgb(var(--accent-glow)/0.12)] px-3 py-1.5 text-xs text-white/85 hover:bg-[rgb(var(--accent-glow)/0.2)] transition"
        >
          <Plus className="h-3.5 w-3.5" /> New scheduled task
        </button>
      )}

      {showForm && (
        <div className="glass-card p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white/85">
              {editingId ? 'Edit task' : 'New task'}
            </h2>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="p-1 rounded text-white/40 hover:text-white/80 hover:bg-white/10 transition"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Name, e.g. “Morning weather”"
            className="rounded-md border border-white/15 bg-white/10 px-2.5 py-1.5 text-xs text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[rgb(var(--accent-glow)/0.5)]"
          />
          <textarea
            value={form.prompt}
            onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
            placeholder="Prompt, e.g. “Check the weather forecast for Paris for the next 3 days.”"
            className="min-h-[70px] rounded-md border border-white/15 bg-white/10 px-2.5 py-1.5 text-xs text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[rgb(var(--accent-glow)/0.5)]"
          />
          <div className="flex items-center gap-3 flex-wrap">
            <select
              value={form.model}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              className="rounded-md border border-white/15 bg-white/10 px-2.5 py-1.5 text-xs text-white focus:outline-none"
            >
              <option value="" disabled>
                Select model
              </option>
              {models.map((m) => (
                <option key={m.name} value={m.name} className="bg-neutral-900">
                  {m.name}
                </option>
              ))}
            </select>
            <input
              type="time"
              value={form.timeOfDay}
              onChange={(e) => setForm((f) => ({ ...f, timeOfDay: e.target.value }))}
              className="rounded-md border border-white/15 bg-white/10 px-2.5 py-1.5 text-xs text-white focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {DAY_LABELS.map((label, day) => (
              <button
                key={day}
                type="button"
                onClick={() => toggleDay(day)}
                className={`px-2 py-1 rounded-md text-[10px] font-mono transition ${
                  form.daysOfWeek.includes(day)
                    ? 'bg-[rgb(var(--accent-glow)/0.25)] text-white border border-[rgb(var(--accent-glow)/0.4)]'
                    : 'bg-white/5 text-white/35 border border-white/10 hover:text-white/60'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-4 text-xs text-white/60">
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                className="accent-cyan-500"
                checked={form.toolsEnabled}
                onChange={(e) => setForm((f) => ({ ...f, toolsEnabled: e.target.checked }))}
              />
              Tools (web search, weather, calculator)
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                className="accent-violet-500"
                checked={form.memoryEnabled}
                onChange={(e) => setForm((f) => ({ ...f, memoryEnabled: e.target.checked }))}
              />
              Memory
            </label>
          </div>
          {error && <div className="text-[11px] text-amber-300/80">{error}</div>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-md bg-[rgb(var(--accent-glow)/0.2)] px-3 py-1.5 text-xs text-white hover:bg-[rgb(var(--accent-glow)/0.3)] transition disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" /> {editingId ? 'Save' : 'Create'}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-md px-3 py-1.5 text-xs text-white/50 hover:text-white/80 hover:bg-white/10 transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-xs text-white/30">Loading…</div>
      ) : tasks.length === 0 ? (
        <div className="text-xs text-white/30">No scheduled tasks yet.</div>
      ) : (
        <ul className="flex flex-col gap-3">
          {tasks.map((task) => (
            <li key={task.id} className="glass-card p-4 flex flex-col gap-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-white/90 truncate">{task.name}</h3>
                    {!task.enabled && (
                      <span className="cap-pill border-white/15 bg-white/5 text-white/40 !text-[10px]">
                        paused
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-white/45 mt-0.5 line-clamp-2">{task.prompt}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleToggleEnabled(task)}
                    title={task.enabled ? 'Pause' : 'Resume'}
                    className="p-1.5 rounded text-white/40 hover:text-white/80 hover:bg-white/10 transition"
                  >
                    {task.enabled ? (
                      <span className="text-[10px] font-mono">⏸</span>
                    ) : (
                      <span className="text-[10px] font-mono">▶</span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => startEdit(task)}
                    title="Edit"
                    className="p-1.5 rounded text-white/40 hover:text-white/80 hover:bg-white/10 transition"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(task.id)}
                    title="Delete"
                    className="p-1.5 rounded text-white/40 hover:text-red-300 hover:bg-white/10 transition"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                <span className="cap-pill border-white/15 bg-white/5 text-white/50 !text-[10px] font-mono">
                  {task.model}
                </span>
                <span className="cap-pill border-white/15 bg-white/5 text-white/50 !text-[10px] font-mono">
                  {task.timeOfDay}
                </span>
                <span className="cap-pill border-white/15 bg-white/5 text-white/50 !text-[10px]">
                  {task.daysOfWeek.length === 7
                    ? 'daily'
                    : task.daysOfWeek.map((d) => DAY_LABELS[d]).join(' ')}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-white/40">
                <span>Next: {formatWhen(task.nextRunAt)}</span>
                <span>
                  Last: {formatWhen(task.lastRunAt)}
                  {task.lastRunSessionId && (
                    <>
                      {' — '}
                      <button
                        type="button"
                        onClick={() => openSession(task.lastRunSessionId!)}
                        className="text-[rgb(var(--accent-glow)/0.9)] hover:underline"
                      >
                        view
                      </button>
                    </>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
