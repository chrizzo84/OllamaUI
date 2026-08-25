'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Gauge, RotateCcw } from 'lucide-react';
import { usePrefsStore } from '@/store/prefs';
import { DEFAULT_MIN_NUM_CTX } from '@/lib/utils';

const MIN_CTX = 2048;
const STEP = 1024;
const PRESETS = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
const POPOVER_WIDTH = 320; // w-80
const VIEWPORT_MARGIN = 8;

function formatTokens(n: number): string {
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024}K`;
  if (n >= 1000) return `${Math.round(n / 100) / 10}K`;
  return String(n);
}

/**
 * Per-model context-window (num_ctx) slider. The range is capped at the
 * model's architectural maximum (from /api/tags). An unset override means
 * the Ollama server default applies (usually 4096).
 *
 * The popover renders in a portal on document.body: the chat panel is an
 * overflow-hidden glass card, so an in-place absolute popover would get
 * clipped at the panel edge.
 */
export function NumCtxControl({
  model,
  maxContext,
}: {
  model: string;
  maxContext: number | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const numCtx = usePrefsStore((s) => (model ? s.numCtxByModel[model] : undefined));
  const setNumCtxForModel = usePrefsStore((s) => s.setNumCtxForModel);
  const hydrate = usePrefsStore((s) => s.hydrate);
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Position the portal popover under the trigger, clamped to the viewport.
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const left = Math.max(
        VIEWPORT_MARGIN,
        Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN),
      );
      setPos({ top: rect.bottom + 8, left });
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!model || !maxContext || maxContext <= MIN_CTX) return null;

  const active = numCtx != null;
  // Mirrors the fallback the app actually sends when there's no override
  // (see DEFAULT_MIN_NUM_CTX / chat-panel.tsx) — never exceeds the model max.
  const defaultValue = Math.min(DEFAULT_MIN_NUM_CTX, maxContext);
  const sliderValue = numCtx ?? defaultValue;
  const presets = PRESETS.filter((p) => p <= maxContext);
  if (presets[presets.length - 1] !== maxContext) presets.push(maxContext);

  const popover =
    open && pos ? (
      <div
        ref={popoverRef}
        style={{ position: 'fixed', top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
        className="z-[110] rounded-xl border border-white/10 bg-[#0e1220]/95 backdrop-blur-xl shadow-[0_16px_48px_-16px_rgba(0,0,0,0.8)] p-4 flex flex-col gap-3 anim-modal-in"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="section-label">
            <Gauge />
            Context window
          </span>
          <span className="font-mono text-[10px] text-white/35 truncate" title={model}>
            {model}
          </span>
        </div>

        <div className="flex items-baseline justify-between">
          <span className="text-xl font-semibold tabular-nums text-white/90">
            {formatTokens(sliderValue)}
            <span className="ml-1 text-[10px] font-normal text-white/35">tokens</span>
          </span>
          <span className="text-[10px] font-mono text-white/35">
            max {formatTokens(maxContext)}
          </span>
        </div>

        <input
          type="range"
          min={MIN_CTX}
          max={maxContext}
          step={STEP}
          value={sliderValue}
          onChange={(e) => setNumCtxForModel(model, Number(e.target.value))}
          className="w-full accent-[var(--accent)] cursor-pointer"
          aria-label="Context window in tokens"
        />

        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setNumCtxForModel(model, p)}
              className={`rounded-md border px-2 py-1 text-[10px] font-mono transition ${
                sliderValue === p
                  ? 'border-[rgb(var(--accent-glow)/0.5)] bg-[rgb(var(--accent-glow)/0.18)] text-white'
                  : 'border-white/10 bg-white/5 text-white/50 hover:text-white/85 hover:border-white/25'
              }`}
            >
              {p === maxContext ? `Max (${formatTokens(p)})` : formatTokens(p)}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setNumCtxForModel(model, null)}
            disabled={!active}
            className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-mono text-white/50 hover:text-white/85 hover:border-white/25 transition disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
            title={`Remove the override and use the app default (${formatTokens(defaultValue)})`}
          >
            <RotateCcw className="h-2.5 w-2.5" /> Default
          </button>
        </div>

        <p className="text-[10px] leading-relaxed text-white/35">
          Applies from the next message — Ollama reloads the model with the new window. Larger
          windows need significantly more (V)RAM. Without an override this app defaults to{' '}
          {formatTokens(defaultValue)} (Ollama&apos;s own server default is often just 4K).
        </p>
      </div>
    ) : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`cap-pill transition-colors ${
          active
            ? 'border-[rgb(var(--accent-glow)/0.35)] bg-[rgb(var(--accent-glow)/0.12)] text-white/80'
            : 'border-white/15 bg-white/5 text-white/45 hover:text-white/70 hover:border-white/30'
        }`}
        title={
          active
            ? `Context window override for ${model}: ${sliderValue} tokens (sent as num_ctx). Model maximum: ${maxContext}.`
            : `Context window (num_ctx) for ${model}: ${defaultValue} tokens (app default — click to override). Model maximum: ${maxContext}.`
        }
      >
        <Gauge className="h-3 w-3" />
        num_ctx {formatTokens(sliderValue)}
      </button>
      {popover && createPortal(popover, document.body)}
    </>
  );
}
