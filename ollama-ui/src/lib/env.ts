import { z } from 'zod';
import type { NextRequest } from 'next/server';

// Default host (fallback) can be overridden by env vars or runtime cookie/header
const DEFAULT_FALLBACK = 'http://192.168.188.57:11434';

const hostSchema = z
  .string()
  .url()
  .refine((s) => /^(http|https):\/\//.test(s), 'Must start with http/https');

export function getDefaultOllamaHost(): string {
  return process.env.OLLAMA_HOST || process.env.NEXT_PUBLIC_OLLAMA_HOST || DEFAULT_FALLBACK;
}

export function validateHost(host: string): string | null {
  const parsed = hostSchema.safeParse(host.trim());
  return parsed.success ? parsed.data : null;
}

export function resolveOllamaHost(req?: NextRequest): string {
  // Priority: header > cookie > env > fallback
  const header = req?.headers.get('x-ollama-host');
  if (header) {
    const v = validateHost(header);
    if (v) return v;
  }
  const cookieStore =
    req && typeof req === 'object' && 'cookies' in req
      ? (req as { cookies?: { get?: (n: string) => { value?: string } } }).cookies
      : undefined;
  const cookie = cookieStore?.get?.('ollama_host')?.value as string | undefined;
  if (cookie) {
    const v = validateHost(cookie);
    if (v) return v;
  }
  return getDefaultOllamaHost();
}
