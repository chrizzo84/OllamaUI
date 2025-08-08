'use client';
import { useEffect } from 'react';
import { useToastStore } from '@/store/toast';
import { cn } from '@/lib/utils';

export function Toaster() {
  const { toasts, dismiss } = useToastStore();

  useEffect(() => {
    const timers = toasts.map((t) =>
      setTimeout(() => dismiss(t.id), t.type === 'error' ? 8000 : 5000),
    );
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [toasts, dismiss]);

  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-50 flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto w-full max-w-sm overflow-hidden rounded-lg border p-4 shadow backdrop-blur-md transition',
            t.type === 'error' && 'border-red-500/30 bg-red-500/15 text-red-100',
            t.type === 'success' && 'border-emerald-500/30 bg-emerald-500/15 text-emerald-100',
            (!t.type || t.type === 'info') && 'border-white/15 bg-white/10 text-white/80',
          )}
          role="status"
        >
          <div className="flex items-start gap-3">
            <div className="flex-1">
              {t.title && <p className="text-sm font-semibold mb-1 leading-none">{t.title}</p>}
              <p className="text-xs leading-relaxed whitespace-pre-wrap">{t.message}</p>
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="text-xs rounded-md px-2 py-1 bg-white/10 hover:bg-white/20"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
