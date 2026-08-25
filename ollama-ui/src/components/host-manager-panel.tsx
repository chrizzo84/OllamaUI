'use client';
import { useEffect, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToastStore } from '@/store/toast';

interface HostRowUI {
  id: string;
  url: string;
  label?: string | null;
  active: number;
}

interface Props {
  onActivated?: (url: string | null) => void;
}

// The actual add/list/edit/activate logic for Ollama hosts, shared between
// the header's HostManagerModal (a popup) and the Settings page (embedded
// inline) — see host-manager-modal.tsx for the modal wrapper.
export function HostManagerPanel({ onActivated }: Props) {
  const [hosts, setHosts] = useState<HostRowUI[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addUrl, setAddUrl] = useState('');
  const [addLabel, setAddLabel] = useState('');
  const [addErr, setAddErr] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testLatency, setTestLatency] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState('');
  const [editLabel, setEditLabel] = useState('');
  const [editErr, setEditErr] = useState<string | null>(null);
  const pushToast = useToastStore((s) => s.push);

  useEffect(() => {
    load();
    function onActiveChange() {
      load();
    }
    window.addEventListener('active-host-changed', onActiveChange as EventListener);
    return () => window.removeEventListener('active-host-changed', onActiveChange as EventListener);
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/hosts', { cache: 'no-store' });
      if (!r.ok) throw new Error('Failed to load hosts');
      const j = await r.json();
      if (Array.isArray(j.hosts)) {
        setHosts(j.hosts as HostRowUI[]);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }

  function validate(raw: string): string | null {
    const v = raw.trim();
    if (!v) return 'URL required';
    try {
      const u = new URL(v);
      if (!/^https?:$/.test(u.protocol)) return 'Must use http/https';
      return null;
    } catch {
      return 'Invalid URL';
    }
  }

  async function test(url: string) {
    setTesting(true);
    setTestLatency(null);
    try {
      const start = performance.now();
      const r = await fetch('/api/hosts/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) setTestLatency(j.latency ?? Math.round(performance.now() - start));
      else setAddErr(j.error || 'Test failed');
    } catch (e: unknown) {
      setAddErr(e instanceof Error ? e.message : 'Network error');
    } finally {
      setTesting(false);
    }
  }

  async function addHost(e: React.FormEvent) {
    e.preventDefault();
    const err = validate(addUrl);
    setAddErr(err);
    if (err) return;
    const payload: { url: string; label?: string } = { url: addUrl.trim() };
    if (addLabel.trim()) payload.label = addLabel.trim();
    const hadNoActiveHost = !hosts.some((h) => h.active);
    let r: Response;
    try {
      r = await fetch('/api/hosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Network error';
      setAddErr(msg);
      pushToast({ type: 'error', message: `Failed to add host: ${msg}` });
      return;
    }
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      setAddUrl('');
      setAddLabel('');
      setAddErr(null);
      setTestLatency(null);
      await load();
      // A freshly added host is otherwise inert (grey dot, nothing else in
      // the app works) until someone remembers to also click activate — so
      // if this is the first / only host configured, activate it right away.
      if (hadNoActiveHost && j?.host?.id) {
        await activate(j.host.id);
        pushToast({ type: 'success', message: 'Host added and activated.' });
      } else {
        pushToast({ type: 'success', message: 'Host added.' });
      }
    } else {
      try {
        const j = await r.json();
        const msg = j.error || 'Add failed';
        setAddErr(msg);
        pushToast({ type: 'error', message: `Failed to add host: ${msg}` });
      } catch {
        setAddErr('Add failed');
        pushToast({ type: 'error', message: 'Failed to add host.' });
      }
    }
  }

  async function activate(id: string) {
    let r: Response;
    try {
      r = await fetch('/api/hosts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
    } catch (e: unknown) {
      pushToast({
        type: 'error',
        message: `Failed to activate host: ${e instanceof Error ? e.message : 'Network error'}`,
      });
      return;
    }
    if (r.ok) {
      const activeHost = hosts.find((h) => h.id === id);
      await load();
      if (activeHost && onActivated) onActivated(activeHost.url);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('active-host-changed', {
            detail: { id, url: activeHost?.url || null },
          }),
        );
      }
    } else {
      const j = await r.json().catch(() => ({}));
      pushToast({ type: 'error', message: j.error || 'Failed to activate host.' });
    }
  }

  async function remove(id: string) {
    const u = new URL('/api/hosts', window.location.origin);
    u.searchParams.set('id', id);
    const r = await fetch(u.toString(), { method: 'DELETE' });
    if (r.ok) {
      await load();
      window.dispatchEvent(new CustomEvent('active-host-changed'));
    } else {
      const j = await r.json().catch(() => ({}));
      pushToast({ type: 'error', message: j.error || 'Failed to remove host.' });
    }
  }

  function beginEdit(h: HostRowUI) {
    setEditingId(h.id);
    setEditUrl(h.url);
    setEditLabel(h.label || '');
    setEditErr(null);
  }
  function cancelEdit() {
    setEditingId(null);
    setEditUrl('');
    setEditLabel('');
    setEditErr(null);
  }
  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    const err = validate(editUrl);
    setEditErr(err);
    if (err) return;
    const payload: { id: string; action: 'update'; url: string; label?: string } = {
      id: editingId,
      action: 'update',
      url: editUrl.trim(),
    };
    if (editLabel.trim()) payload.label = editLabel.trim();
    else payload.label = '';
    const r = await fetch('/api/hosts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (r.ok) {
      cancelEdit();
      await load();
    } else {
      try {
        const j = await r.json();
        setEditErr(j.error || 'Update failed');
      } catch {
        setEditErr('Update failed');
      }
    }
  }

  const active = hosts.find((h) => h.active);

  return (
    <div className="flex flex-col md:flex-row gap-8">
      <div className="md:w-1/2 flex flex-col gap-4">
        <form
          onSubmit={addHost}
          className="flex flex-col gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] p-4"
        >
          <div className="text-xs font-medium uppercase tracking-wide text-white/50">Add Host</div>
          <input
            value={addUrl}
            onChange={(e) => setAddUrl(e.target.value)}
            className="w-full rounded-lg bg-black/25 border border-white/10 px-2.5 py-1.5 text-xs font-mono text-white/80 placeholder:text-white/25 transition-colors focus:outline-none focus:border-[rgb(var(--accent-glow)/0.5)] focus:ring-1 focus:ring-[rgb(var(--accent-glow)/0.3)]"
            placeholder="https://host:11434"
          />
          <input
            value={addLabel}
            onChange={(e) => setAddLabel(e.target.value)}
            className="w-full rounded-lg bg-black/25 border border-white/10 px-2.5 py-1.5 text-xs text-white/80 placeholder:text-white/25 transition-colors focus:outline-none focus:border-[rgb(var(--accent-glow)/0.5)] focus:ring-1 focus:ring-[rgb(var(--accent-glow)/0.3)]"
            placeholder="Label (optional)"
          />
          {addErr && <div className="text-[10px] text-red-300">{addErr}</div>}
          <div className="flex gap-2">
            <Button size="sm" variant="primary" type="submit" disabled={testing}>
              Add
            </Button>
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={testing || !addUrl.trim()}
              onClick={() => test(addUrl.trim())}
            >
              {testing ? 'Testing…' : testLatency != null ? `${testLatency}ms` : 'Test'}
            </Button>
          </div>
        </form>
        <div className="flex-1 min-h-[220px] rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 flex flex-col gap-3">
          <div className="text-xs font-medium uppercase tracking-wide text-white/50 flex items-center justify-between">
            <span>Hosts</span>
            {loading && <span className="text-[10px] text-white/30 animate-pulse">Loading…</span>}
          </div>
          {error && <div className="text-[10px] text-red-300">{error}</div>}
          <ul className="flex flex-col gap-2">
            {hosts.map((h) => (
              <li
                key={h.id}
                className={`group rounded-lg border px-3 py-2 flex flex-col gap-1 transition bg-white/5 border-white/10 hover:border-white/25 ${h.active ? 'ring-1 ring-[rgb(var(--accent-glow)/0.45)] bg-[rgb(var(--accent-glow)/0.1)]' : ''}`}
              >
                {editingId === h.id ? (
                  <form onSubmit={saveEdit} className="flex flex-col gap-2">
                    <input
                      autoFocus
                      className="w-full rounded-lg bg-black/25 border border-white/10 px-2.5 py-1.5 text-[11px] font-mono transition-colors focus:outline-none focus:border-[rgb(var(--accent-glow)/0.5)]"
                      value={editUrl}
                      onChange={(e) => setEditUrl(e.target.value)}
                      placeholder="URL"
                    />
                    <input
                      className="w-full rounded-lg bg-black/25 border border-white/10 px-2.5 py-1.5 text-[11px] transition-colors focus:outline-none focus:border-[rgb(var(--accent-glow)/0.5)]"
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      placeholder="Label"
                    />
                    {editErr && <div className="text-[10px] text-red-300">{editErr}</div>}
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" type="submit">
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" type="button" onClick={cancelEdit}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => activate(h.id)}
                        className={`rounded px-2 py-0.5 text-[10px] font-mono border transition ${h.active ? 'bg-green-500/20 border-green-400/40 text-green-200' : 'bg-white/5 border-white/10 text-white/60 hover:text-white hover:border-white/25'}`}
                        title={h.active ? 'Active host' : 'Activate host'}
                      >
                        {h.active ? '●' : '○'}
                      </button>
                      <div className="truncate font-mono text-[11px] text-white/80" title={h.url}>
                        {h.url}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-white/40">
                      <span className="truncate" title={h.label || ''}>
                        {h.label || '—'}
                      </span>
                      <div className="ml-auto flex gap-1 opacity-0 group-hover:opacity-100 transition">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-5 px-1 text-[10px]"
                          onClick={() => beginEdit(h)}
                          title="Edit"
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-5 px-1 text-[10px] text-red-300 hover:text-red-200"
                          onClick={() => remove(h.id)}
                          title="Delete"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </li>
            ))}
            {hosts.length === 0 && !loading && (
              <li className="text-[11px] text-white/40">No hosts defined.</li>
            )}
          </ul>
        </div>
      </div>
      <div className="md:flex-1 flex flex-col gap-4">
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 text-xs text-white/60 leading-relaxed">
          <p className="mb-2 font-semibold text-white/80">Quick Switch</p>
          <p>
            Select one of your configured hosts in the list on the left. The green dot marks the
            active target used for model operations & chat streaming.
          </p>
          {active && (
            <div className="mt-3 text-[11px] text-white/50">
              Active: <span className="font-mono text-white/80">{active.url}</span>
              {active.label && <span className="ml-2 opacity-70">({active.label})</span>}
            </div>
          )}
          <p className="mt-4">
            All changes are persisted server-side. Switching dispatches a global{' '}
            <code className="bg-white/5 px-1 rounded">active-host-changed</code> event to update
            open views.
          </p>
        </div>
        <div className="text-[10px] text-white/30 mt-auto flex justify-between">
          <span>{hosts.length} host(s)</span>
        </div>
      </div>
    </div>
  );
}
