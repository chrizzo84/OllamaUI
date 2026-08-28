'use client';
import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';

// A live clock showing the SERVER's current time — not the browser's. Most
// relevant for Scheduled Tasks (/schedule): "8:00" there means 8:00 on the
// server's own clock/timezone, which can quietly differ from the browser's
// if the app is self-hosted somewhere else. Fetches the server's time once,
// then ticks locally from that offset instead of polling every second.
export function ServerClock() {
  const [offsetMs, setOffsetMs] = useState<number | null>(null);
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/server-time', { cache: 'no-store' });
        if (!r.ok || cancelled) return;
        const j = await r.json();
        if (cancelled || typeof j.epochMs !== 'number') return;
        setOffsetMs(j.epochMs - Date.now());
        setTimeZone(typeof j.timeZone === 'string' ? j.timeZone : null);
      } catch {
        /* footer clock is a nice-to-have — fail silently */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (offsetMs === null) return;
    const tick = () => setNow(Date.now() + offsetMs);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [offsetMs]);

  if (now === null) return null;

  const date = new Date(now);
  const time = date.toLocaleTimeString('en-GB'); // HH:MM:SS, 24h
  const weekday = date.toLocaleDateString('en-US', { weekday: 'short' });

  return (
    <span
      className="inline-flex items-center gap-1 font-mono text-white/40"
      title={`Server clock${timeZone ? ` (${timeZone})` : ''} — used to interpret Scheduled Task times`}
    >
      <Clock className="h-3 w-3" aria-hidden="true" />
      Server: {weekday} {time}
    </span>
  );
}
