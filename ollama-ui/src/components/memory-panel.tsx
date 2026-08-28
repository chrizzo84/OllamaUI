'use client';
import { useEffect, useState } from 'react';
import { Trash2, Plus } from 'lucide-react';

interface MemoryItem {
  id: string;
  content: string;
  sourceSessionId: string | null;
  createdAt: number;
}

// Lists/manages the facts stored via the remember_fact tool (see
// src/app/api/chat/route.ts) or added manually here — the "what does it
// actually remember about me" transparency + control surface for the memory
// feature. Fetched on mount only; deletions/additions update local state
// directly instead of polling, since this list only changes from user
// action or from a chat the user is actively looking at (where the trace
// already shows "Saved to memory: ..." — see ToolLine in chat-column.tsx).
export function MemoryPanel() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [newFact, setNewFact] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/memories', { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled) setItems(Array.isArray(j.items) ? j.items : []);
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleAdd() {
    const content = newFact.trim();
    if (!content || adding) return;
    setAdding(true);
    try {
      const r = await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (r.ok) {
        const item = await r.json();
        setItems((prev) => [item, ...prev]);
        setNewFact('');
      }
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
    fetch(`/api/memories?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {
      /* ignore */
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <input
          value={newFact}
          onChange={(e) => setNewFact(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd();
          }}
          placeholder="Add a fact manually (e.g. “I prefer concise answers”)"
          className="flex-1 rounded-md border border-white/15 bg-white/10 px-2 py-1.5 text-xs text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-violet-500/60"
        />
        <button
          type="button"
          onClick={handleAdd}
          disabled={!newFact.trim() || adding}
          className="p-1.5 rounded-md border border-violet-500/25 bg-violet-500/10 text-violet-200/80 hover:bg-violet-500/20 transition disabled:opacity-40 disabled:cursor-not-allowed"
          title="Add fact"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {loading ? (
        <div className="text-[11px] text-white/30">Loading…</div>
      ) : items.length === 0 ? (
        <div className="text-[11px] text-white/30">
          Nothing remembered yet — it fills in as you chat, or add something above.
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
          {items.map((item) => (
            <li
              key={item.id}
              className="group flex items-start gap-2 rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/70"
            >
              <span className="flex-1">{item.content}</span>
              <button
                type="button"
                onClick={() => handleDelete(item.id)}
                title="Forget this"
                className="p-0.5 rounded text-white/25 opacity-0 group-hover:opacity-100 hover:text-red-300 transition shrink-0"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
