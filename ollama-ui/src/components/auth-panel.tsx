'use client';
// Settings → Access. Shows whether the password gate is actually on and
// offers a sign-out. When it's off, this is the only place in the UI that
// says so — an unprotected instance otherwise looks identical to a
// protected one, which is exactly how it stays unprotected by accident.
import { useEffect, useState } from 'react';
import { LogOut, ShieldCheck, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function AuthPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/status', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setEnabled(d?.auth?.enabled === true);
      })
      .catch(() => {
        if (!cancelled) setEnabled(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch('/api/auth/login', { method: 'DELETE' });
      window.location.href = '/login';
    } catch {
      setSigningOut(false);
    }
  }

  if (enabled === null) {
    return <div className="text-xs text-white/40">Checking…</div>;
  }

  if (!enabled) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden />
        <div className="text-xs text-white/70">
          <p className="font-medium text-amber-200">No password set</p>
          <p className="mt-1 text-white/50">
            Anyone who can reach this port can read your chats and memories, and pull or delete
            models. Set <code className="font-mono text-white/70">APP_PASSWORD</code> in{' '}
            <code className="font-mono text-white/70">.env.local</code> (or the container
            environment) and restart to turn on the login screen.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden />
        <div className="text-xs text-white/70">
          <p className="font-medium text-emerald-200">Password protected</p>
          <p className="mt-1 text-white/50">
            Every page and API route requires the password. Sessions last 30 days.
          </p>
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={signOut} loading={signingOut}>
        <LogOut className="mr-1.5 h-3.5 w-3.5" aria-hidden />
        Sign out
      </Button>
    </div>
  );
}
