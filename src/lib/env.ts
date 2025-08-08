import { z } from 'zod';

const schema = z.object({
  OLLAMA_HOST: z.string().url().default('http://192.168.188.57:11434'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;
export function getEnv(): Env {
  if (cached) return cached;
  const raw = {
    OLLAMA_HOST: process.env.OLLAMA_HOST,
  };
  const parsed = schema.parse(raw);
  cached = parsed;
  return parsed;
}
