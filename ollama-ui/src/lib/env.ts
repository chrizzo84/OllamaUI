import { z } from 'zod';
import type { NextRequest } from 'next/server';

// Default host (legacy fallback). Will only be used if explicitly requested via getDefaultOllamaHost().
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

// Edge resolver no longer supports cookie fallback; header only.
export function resolveOllamaHost(req?: NextRequest): string | null {
  const header = req?.headers.get('x-ollama-host');
  if (header) {
    const v = validateHost(header);
    if (v) return v;
  }
  return null;
}
