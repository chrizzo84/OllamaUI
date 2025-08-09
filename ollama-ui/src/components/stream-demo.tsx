'use client';
import React from 'react';
import { Button } from '@/components/ui/button';

export const StreamDemo: React.FC = () => {
  const [lines, setLines] = React.useState<string[]>([]);
  const [active, setActive] = React.useState(false);

  const start = React.useCallback(() => {
    setLines([]);
    setActive(true);
    const evtSource = new EventSource('/api/stream');

    evtSource.onmessage = (e) => {
      if (e.data === '[END]') {
        evtSource.close();
        setActive(false);
        return;
      }
      setLines((prev) => [...prev, e.data]);
    };

    evtSource.onerror = () => {
      evtSource.close();
      setActive(false);
    };
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button onClick={start} disabled={active} variant={active ? 'secondary' : 'primary'}>
          {active ? 'Streaming…' : 'Start Stream'}
        </Button>
        <span className="text-xs text-white/50">Demo: SSE Word-by-Word</span>
      </div>
      <div className="min-h-32 rounded-md border border-white/10 bg-white/5 p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap">
        {lines.length === 0 ? (
          <span className="text-white/30">(noch nichts gestreamt)</span>
        ) : (
          lines.join(' ')
        )}
      </div>
    </div>
  );
};
