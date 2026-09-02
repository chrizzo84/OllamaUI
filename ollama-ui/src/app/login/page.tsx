'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Lock } from 'lucide-react';

/*
The password gate's only screen. Rendered as a fixed full-viewport overlay
rather than inside the normal page frame: the root layout always mounts the
sidebar (with session list, host indicator and command palette), and none of
that should be visible — or fetching — to someone who hasn't authenticated
yet.
*/
function LoginForm() {
  const params = useSearchParams();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only ever a path from our own middleware, but re-validated here so a
  // hand-crafted ?next=https://evil.example can't turn the login into an
  // open redirect.
  const rawNext = params.get('next') || '/';
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Login failed');
        setPassword('');
        return;
      }
      // A full navigation, not router.push: every cached RSC payload in
      // this tab was fetched while unauthenticated.
      window.location.href = next;
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background p-6">
      <form onSubmit={submit} className="glass-card w-full max-w-sm p-6 flex flex-col gap-5">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/5 border border-white/10">
            <Lock className="h-5 w-5 text-white/70" aria-hidden />
          </span>
          <h1 className="text-xl font-semibold text-white/90">Ollama UI</h1>
          <p className="text-xs text-white/50">This instance is password protected.</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="password" className="text-xs font-medium text-white/60">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-10 rounded-lg bg-white/5 border border-white/10 px-3 text-sm text-white/90 outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20"
          />
        </div>

        {error && (
          <p role="alert" className="text-xs text-rose-300 bg-rose-500/10 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        <Button type="submit" loading={busy} disabled={!password}>
          Sign in
        </Button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary to keep the route statically
  // renderable.
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
