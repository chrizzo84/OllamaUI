import { NextRequest } from 'next/server';
import { z } from 'zod';
import { listScheduledTasks, createScheduledTask } from '@/lib/db';
import { computeNextRunAt } from '@/lib/scheduler';

const createSchema = z.object({
  name: z.string().min(1).max(200),
  prompt: z.string().min(1).max(4000),
  model: z.string().min(1),
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected "HH:MM"'),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
  toolsEnabled: z.boolean().optional(),
  memoryEnabled: z.boolean().optional(),
});

function toApiShape(r: ReturnType<typeof createScheduledTask>) {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    model: r.model,
    timeOfDay: r.timeOfDay,
    daysOfWeek: r.daysOfWeek,
    recurring: r.recurring,
    toolsEnabled: r.toolsEnabled,
    memoryEnabled: r.memoryEnabled,
    enabled: r.enabled,
    nextRunAt: r.nextRunAt,
    lastRunAt: r.lastRunAt,
    lastRunSessionId: r.lastRunSessionId,
    updatedAt: r.updated_at,
  };
}

export async function GET() {
  return Response.json({ items: listScheduledTasks().map(toApiShape) });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return new Response('Bad Request', { status: 400 });
  const nextRunAt = computeNextRunAt(parsed.data.timeOfDay, parsed.data.daysOfWeek, new Date());
  const row = createScheduledTask({
    name: parsed.data.name,
    prompt: parsed.data.prompt,
    model: parsed.data.model,
    timeOfDay: parsed.data.timeOfDay,
    daysOfWeek: parsed.data.daysOfWeek,
    recurring: true, // this form only ever creates recurring tasks — one-offs come from create_reminder
    toolsEnabled: parsed.data.toolsEnabled ?? true,
    memoryEnabled: parsed.data.memoryEnabled ?? true,
    nextRunAt,
  });
  return Response.json(toApiShape(row));
}
