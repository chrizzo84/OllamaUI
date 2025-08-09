'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface LamaDto {
  id: string;
  name: string;
  prompt: string;
  tags: string[];
  updatedAt: number;
}

async function fetchLamas(): Promise<LamaDto[]> {
  const r = await fetch('/api/lamas', { cache: 'no-store' });
  if (!r.ok) throw new Error('Load failed');
  const j = await r.json();
  return j.items as LamaDto[];
}

export default function LamaAdminPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['lamas'], queryFn: fetchLamas });
  const createMut = useMutation({
    mutationFn: async (payload: { name: string; prompt?: string; tags?: string[] }) => {
      const r = await fetch('/api/lamas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error('Create failed');
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lamas'] }),
  });
  const updateMut = useMutation({
    mutationFn: async (payload: {
      id: string;
      name?: string;
      prompt?: string;
      tags?: string[];
    }) => {
      const r = await fetch('/api/lamas', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error('Update failed');
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lamas'] }),
  });
  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch('/api/lamas?id=' + encodeURIComponent(id), { method: 'DELETE' });
      if (!r.ok && r.status !== 204) throw new Error('Delete failed');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lamas'] }),
  });

  const [newName, setNewName] = useState('');
  const [newPrompt, setNewPrompt] = useState('');

  return (
    <div className="mx-auto max-w-5xl px-8 py-12 flex flex-col gap-8">
      <header>
        <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white via-white/80 to-white/40 bg-clip-text text-transparent">
          Manage Profiles
        </h1>
        <p className="text-white/50 text-sm mt-2">System prompts centrally stored in SQLite.</p>
      </header>
      <section className="flex flex-col gap-4 p-4 rounded-lg border border-white/10 bg-white/5">
        <h2 className="text-sm font-semibold text-white/80">New Profile</h2>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Name"
          className="text-sm bg-white/10 border border-white/15 rounded px-3 py-2 text-white focus:outline-none"
        />
        <textarea
          value={newPrompt}
          onChange={(e) => setNewPrompt(e.target.value)}
          placeholder="Prompt"
          className="min-h-[100px] text-sm bg-white/10 border border-white/15 rounded px-3 py-2 text-white focus:outline-none"
        />
        <Button
          onClick={() => {
            if (!newName.trim()) return;
            createMut.mutate({ name: newName.trim(), prompt: newPrompt });
            setNewName('');
            setNewPrompt('');
          }}
          disabled={createMut.isPending}
        >
          Create
        </Button>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-white/80">Existing Profiles</h2>
        {isLoading && <div className="text-white/40 text-sm">Loading…</div>}
        <div className="grid gap-4">
          {data?.map((l) => (
            <LamaItem key={l.id} lama={l} onUpdate={updateMut.mutate} onDelete={deleteMut.mutate} />
          ))}
          {data && data.length === 0 && (
            <div className="text-white/40 text-sm">No profiles yet.</div>
          )}
        </div>
      </section>
    </div>
  );
}

function LamaItem({
  lama,
  onUpdate,
  onDelete,
}: {
  lama: LamaDto;
  onUpdate: (p: { id: string; name?: string; prompt?: string; tags?: string[] }) => void;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState(lama.name);
  const [prompt, setPrompt] = useState(lama.prompt);
  const [editing, setEditing] = useState(false);
  const dirty = name !== lama.name || prompt !== lama.prompt;
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {editing ? (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="text-sm bg-white/10 border border-white/15 rounded px-2 py-1 text-white focus:outline-none flex-1"
          />
        ) : (
          <div className="font-medium text-white/80 flex-1">{lama.name}</div>
        )}
        <span className="text-[10px] text-white/30">
          {new Date(lama.updatedAt).toLocaleTimeString()}
        </span>
      </div>
      {editing ? (
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="min-h-[80px] text-xs bg-white/10 border border-white/15 rounded px-2 py-1 text-white focus:outline-none"
        />
      ) : (
        <div className="text-xs text-white/70 whitespace-pre-wrap leading-relaxed max-h-40 overflow-auto">
          {lama.prompt || <span className="opacity-40">(empty)</span>}
        </div>
      )}
      <div className="flex gap-2 mt-1">
        {!editing && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        {editing && (
          <>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                if (dirty) onUpdate({ id: lama.id, name, prompt });
                setEditing(false);
              }}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setName(lama.name);
                setPrompt(lama.prompt);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </>
        )}
        <Button size="sm" variant="danger" onClick={() => onDelete(lama.id)}>
          Delete
        </Button>
      </div>
    </div>
  );
}
