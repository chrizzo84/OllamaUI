'use client';
import { ChatPanel } from '@/components/chat-panel';

export default function Home() {
  return (
  <main className="mx-auto flex h-[calc(100vh-56px)] w-full max-w-5xl flex-col px-6 py-10 gap-6 overflow-hidden">
      <header className="mb-2">
  <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-white via-white/80 to-white/40 bg-clip-text text-transparent">
          Chat
        </h1>
      </header>
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <ChatPanel />
      </div>
    </main>
  );
}
