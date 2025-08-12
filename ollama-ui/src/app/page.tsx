'use client';
import { ChatPanel } from '@/components/chat-panel';

export default function Home() {
  return (
    <main className="mx-auto flex h-[calc(100vh-56px)] w-full max-w-5xl flex-col px-6 py-10 gap-6 overflow-hidden">
      {/* Removed explicit Chat heading per request */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <ChatPanel />
      </div>
    </main>
  );
}
