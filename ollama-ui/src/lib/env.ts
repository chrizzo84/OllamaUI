import { z } from 'zod';

// Default host (legacy fallback). Will only be used if explicitly requested via getDefaultOllamaHost().
// A loopback default: the app is configured through the Host Manager, and
// falling back to a specific machine's address would both fail for everyone
// else and put someone's network layout in a public repository.
const DEFAULT_FALLBACK = 'http://127.0.0.1:11434';

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
