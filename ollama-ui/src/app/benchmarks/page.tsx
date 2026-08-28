import { BenchmarkPanel } from '@/components/benchmark-panel';

export default function BenchmarksPage() {
  return (
    <div className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-10 py-14">
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
          Speed history
        </span>
        <h1 className="text-2xl font-bold tracking-tight text-gradient-hero">Benchmarks</h1>
        <p className="text-xs text-white/40 max-w-2xl">
          How fast each installed model actually runs on this hardware, over time — every real chat
          reply logs a data point automatically, or run a fixed-prompt comparison across all
          installed models on demand.
        </p>
      </div>
      <BenchmarkPanel />
    </div>
  );
}
