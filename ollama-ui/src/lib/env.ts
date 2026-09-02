import { z } from 'zod';

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
