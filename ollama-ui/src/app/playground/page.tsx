'use client';
import { useState } from 'react';
import { SingleChatView } from '@/components/single-chat-view';
import { usePlaygroundStore } from '@/store/playground';
import { Button } from '@/components/ui/button';

export default function PlaygroundPage() {
  const {
    messagesA,
    modelA,
    loadingA,
    temperatureA,
    seedA,
    messagesB,
    modelB,
    loadingB,
    temperatureB,
    seedB,
    setModel,
    setOptions,
    send,
    clear,
  } = usePlaygroundStore();

  const [sharedInput, setSharedInput] = useState('');

  const handleSendToBoth = () => {
    if (!sharedInput.trim()) return;
    if (modelA) {
      send('A', sharedInput);
    }
    if (modelB) {
      send('B', sharedInput);
    }
    setSharedInput('');
  };

  return (
    <main className="mx-auto flex h-[calc(100vh-56px)] w-full max-w-7xl flex-col px-6 py-10 gap-6 overflow-hidden">
      <div className="flex-1 flex gap-4 min-h-0 overflow-hidden">
        <div className="flex-1 flex flex-col border rounded-lg">
          <SingleChatView
            messages={messagesA}
            model={modelA}
            onModelChange={(m) => setModel('A', m)}
            onSend={(p) => send('A', p)}
            loading={loadingA}
            clear={() => clear('A')}
            temperature={temperatureA}
            seed={seedA}
            onOptionsChange={(opts) => setOptions('A', opts)}
          />
        </div>
        <div className="flex-1 flex flex-col border rounded-lg">
          <SingleChatView
            messages={messagesB}
            model={modelB}
            onModelChange={(m) => setModel('B', m)}
            onSend={(p) => send('B', p)}
            loading={loadingB}
            clear={() => clear('B')}
            temperature={temperatureB}
            seed={seedB}
            onOptionsChange={(opts) => setOptions('B', opts)}
          />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <textarea
          value={sharedInput}
          onChange={(e) => setSharedInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSendToBoth();
            }
          }}
          placeholder="Type a message to send to both models..."
          className="min-h-[80px] rounded-md border border-white/15 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
        />
        <div className="flex gap-2">
          <Button
            onClick={handleSendToBoth}
            size="sm"
            disabled={!sharedInput.trim() || (!modelA && !modelB) || loadingA || loadingB}
            loading={loadingA || loadingB}
          >
            Send to Both
          </Button>
        </div>
      </div>
    </main>
  );
}
