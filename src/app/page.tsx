'use client';
import { Button } from '@/components/ui/button';
import { StreamDemo } from '@/components/stream-demo';
import { motion } from 'framer-motion';

export default function Home() {
  return (
    <div className="relative mx-auto flex min-h-[calc(100vh-0rem)] w-full max-w-6xl flex-col gap-20 px-12 py-24">
      <section className="flex flex-col gap-12">
        <div className="max-w-3xl space-y-6">
          <h1 className="text-6xl font-bold tracking-tight bg-gradient-to-br from-white via-white/90 to-white/60 bg-clip-text text-transparent">
            Build a Fancy & Cool Desktop Experience
          </h1>
          <p className="text-lg text-white/70 leading-relaxed">
            Opinionated starter: React Query, Zustand, Tailwind v4 tokens, animated components &
            structured design system primitives. Ready for rapid iteration.
          </p>
          <div className="flex gap-4">
            <Button size="lg">Get Started</Button>
            <Button variant="outline" size="lg">
              Components
            </Button>
          </div>
        </div>
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, ease: 'easeOut' }}
          className="relative mt-4 grid min-h-64 w-full place-items-center overflow-hidden rounded-2xl border border-white/10 bg-white/5 p-10 backdrop-blur-md shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_4px_30px_-10px_rgba(0,0,0,0.6)]"
        >
          <div className="pointer-events-none select-none text-center">
            <p className="text-sm uppercase tracking-[0.25em] text-white/40">Preview</p>
            <h2 className="mt-4 text-2xl font-semibold text-white/90">
              Animated Surface Placeholder
            </h2>
            <p className="mt-2 text-white/60 max-w-md mx-auto">
              Replace this with core feature modules, data visualizations or interactive panels.
            </p>
          </div>
          <motion.div
            aria-hidden
            className="absolute -inset-40 opacity-40 [mask-image:radial-gradient(circle_at_center,white,transparent_70%)]"
            animate={{ rotate: 360 }}
            transition={{ duration: 40, repeat: Infinity, ease: 'linear' }}
            style={{
              background:
                'conic-gradient(from 0deg, rgba(99,102,241,0.35), rgba(168,85,247,0.35), rgba(236,72,153,0.35), rgba(99,102,241,0.35))',
            }}
          />
        </motion.div>
        <div className="mt-4">
          <StreamDemo />
        </div>
      </section>
      <footer className="mt-auto flex items-center justify-between border-t border-white/10 pt-6 text-xs text-white/40">
        <span>© {new Date().getFullYear()} Ollama UI</span>
        <span>Desktop-first Prototype</span>
      </footer>
    </div>
  );
}
