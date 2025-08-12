'use client';
import { ChatPanel } from '@/components/chat-panel';
import { ChatModelList } from '@/components/chat-model-list';

export default function ChatPage() {
  return (
    <main className="mx-auto flex h-[calc(100vh-56px)] w-full max-w-5xl flex-col px-6 py-10 gap-6 overflow-hidden">
      <ChatModelList />
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <ChatPanel />
      </div>
    </main>
  );
}
