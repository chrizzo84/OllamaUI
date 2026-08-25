'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Server, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { HostManagerPanel } from '@/components/host-manager-panel';

interface Props {
  open: boolean;
  onClose: () => void;
  onActivated?: (url: string | null) => void;
}

export function HostManagerModal({ open, onClose, onActivated }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    if (open) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Avoid SSR issues & only render when portal target available
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!open || !mounted) return null;

  const content = (
    <div className="fixed inset-0 z-[100] flex items-start justify-center p-6 overflow-y-auto">
      <div
        className="anim-backdrop-in absolute inset-0 bg-black/65 backdrop-blur-md"
        onClick={onClose}
      />
      <div
        className="anim-modal-in relative w-full max-w-3xl rounded-2xl border border-white/10 bg-[#0e1220]/95 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.8),0_0_40px_-12px_rgb(var(--accent-glow)/0.25)] backdrop-blur-xl p-6 flex flex-col gap-6"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid h-9 w-9 place-items-center rounded-xl border border-[rgb(var(--accent-glow)/0.3)] bg-[rgb(var(--accent-glow)/0.12)] text-[rgb(var(--accent-glow))]">
              <Server className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-gradient-hero">
                Manage Ollama Hosts
              </h2>
              <p className="text-xs text-white/40 mt-1">
                Switch, add, test or edit remote Ollama endpoints.
              </p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close" title="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <HostManagerPanel onActivated={onActivated} />
        <div className="text-[10px] text-white/30 -mt-2">ESC to close</div>
      </div>
    </div>
  );
  return createPortal(content, document.body);
}
