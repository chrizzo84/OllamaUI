import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getScheduledTask, updateScheduledTask, deleteScheduledTask } from '@/lib/db';
import { computeNextRunAt } from '@/lib/scheduler';

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  prompt: z.string().min(1).max(4000).optional(),
  model: z.string().min(1).optional(),
  timeOfDay: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected "HH:MM"')
    .optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  toolsEnabled: z.boolean().optional(),
  memoryEnabled: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

function toApiShape(r: NonNullable<ReturnType<typeof getScheduledTask>>) {
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

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const existing = getScheduledTask(id);
  if (!existing) return new Response('Not Found', { status: 404 });
  const body = await req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return new Response('Bad Request', { status: 400 });

  // The schedule itself changed — the previously computed next_run_at no
  // longer corresponds to it, so recompute from now.
  const scheduleChanged =
    parsed.data.timeOfDay !== undefined || parsed.data.daysOfWeek !== undefined;
  const nextRunAt = scheduleChanged
    ? computeNextRunAt(
        parsed.data.timeOfDay ?? existing.timeOfDay,
        parsed.data.daysOfWeek ?? existing.daysOfWeek,
        new Date(),
      )
    : undefined;

  const row = updateScheduledTask(id, {
    ...parsed.data,
    ...(nextRunAt !== undefined ? { nextRunAt } : {}),
  });
  if (!row) return new Response('Not Found', { status: 404 });
  return Response.json(toApiShape(row));
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const existing = getScheduledTask(id);
  if (!existing) return new Response('Not Found', { status: 404 });
  deleteScheduledTask(id);
  return new Response(null, { status: 204 });
}
