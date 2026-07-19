'use client';
import { useEffect } from 'react';
import { CircleCheck, CircleAlert, Info, X } from 'lucide-react';
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
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => {
        const isError = t.type === 'error';
        const isSuccess = t.type === 'success';
        return (
          <div
            key={t.id}
            className={cn(
              'anim-toast-in pointer-events-auto w-full max-w-sm overflow-hidden rounded-xl border p-3.5 shadow-[0_12px_36px_-12px_rgba(0,0,0,0.7)] backdrop-blur-xl transition bg-[#0d1020]/90',
              isError && 'border-red-500/35',
              isSuccess && 'border-emerald-500/35',
              !isError && !isSuccess && 'border-white/15',
            )}
            role="status"
          >
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  'mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border',
                  isError && 'border-red-500/30 bg-red-500/15 text-red-300',
                  isSuccess && 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
                  !isError &&
                    !isSuccess &&
                    'border-[rgb(var(--accent-glow)/0.3)] bg-[rgb(var(--accent-glow)/0.12)] text-[rgb(var(--accent-glow))]',
                )}
              >
                {isError ? (
                  <CircleAlert className="h-3.5 w-3.5" />
                ) : isSuccess ? (
                  <CircleCheck className="h-3.5 w-3.5" />
                ) : (
                  <Info className="h-3.5 w-3.5" />
                )}
              </span>
              <div className="flex-1 min-w-0">
                {t.title && (
                  <p className="text-sm font-semibold mb-1 leading-none text-white/90">{t.title}</p>
                )}
                <p
                  className={cn(
                    'text-xs leading-relaxed whitespace-pre-wrap',
                    isError && 'text-red-100/85',
                    isSuccess && 'text-emerald-100/85',
                    !isError && !isSuccess && 'text-white/70',
                  )}
                >
                  {t.message}
                </p>
              </div>
              <button
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
                className="shrink-0 rounded-md p-1 text-white/40 hover:text-white/90 hover:bg-white/10 transition"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
