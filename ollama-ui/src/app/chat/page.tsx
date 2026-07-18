'use client';
import { ChatPanel } from '@/components/chat-panel';

export default function ChatPage() {
  return (
    <main className="mx-auto flex h-full w-full max-w-7xl flex-col px-6 py-6 overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <ChatPanel />
      </div>
    </main>
  );
}
