import { SchedulePanel } from '@/components/schedule-panel';

export default function SchedulePage() {
  return (
    <div className="relative mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-8 px-10 py-14">
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
          Recurring prompts
        </span>
        <h1 className="text-2xl font-bold tracking-tight text-gradient-hero">Scheduled Tasks</h1>
        <p className="text-xs text-white/40 max-w-2xl">
          Runs a prompt automatically at a set time — no browser tab needs to be open. Each run
          creates a new chat session with the model&apos;s reply; the sidebar&apos;s background-job
          indicator picks it up like any other reply.
        </p>
      </div>
      <SchedulePanel />
    </div>
  );
}
