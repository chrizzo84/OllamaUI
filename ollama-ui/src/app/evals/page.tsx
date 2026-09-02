import { EvalPanel } from '@/components/eval-panel';

export default function EvalsPage() {
  return (
    <div className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-10 py-14">
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
          Model comparison
        </span>
        <h1 className="text-2xl font-bold tracking-tight text-gradient-hero">Evaluations</h1>
        <p className="max-w-2xl text-xs text-white/40">
          Save the prompts you actually use, run them across several models at once, and score the
          answers side by side. Benchmarks tell you which model is fastest; this tells you which one
          is better at your work — and shows the speed alongside it, so the trade-off is visible in
          one place.
        </p>
      </div>
      <EvalPanel />
    </div>
  );
}
