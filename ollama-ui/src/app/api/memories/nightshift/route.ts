/**
 * The memory's maintenance pass: its settings, its history, and starting or
 * stopping one by hand.
 *
 * Scheduled runs are driven by the scheduler's existing minute tick (see
 * src/lib/scheduler.ts) — this route exists so the schedule can be
 * configured, a run can be triggered without waiting for the night, and what
 * past runs did can be read back. That last part is not optional: a job that
 * edits the memory while nobody watches is only acceptable if it leaves a
 * record.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';
import { listMaintenanceRuns, setSetting, countUnscannedConversations } from '@/lib/db';
import {
  getNightShiftSettings,
  runNightShift,
  stopNightShift,
  isNightShiftRunning,
  currentNightShiftStep,
  NIGHT_SHIFT_SETTINGS_KEY,
  DEFAULT_NIGHT_SHIFT,
} from '@/lib/memory-nightshift';

export const runtime = 'nodejs';

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  timeOfDay: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  model: z.string().max(200).optional(),
  conversationLimit: z.number().int().min(1).max(500).optional(),
  decayDays: z.number().int().min(7).max(3650).optional(),
});

function state() {
  return {
    settings: getNightShiftSettings(),
    running: isNightShiftRunning(),
    step: currentNightShiftStep(),
    pendingConversations: countUnscannedConversations(),
    runs: listMaintenanceRuns(10),
  };
}

export async function GET() {
  return Response.json(state());
}

/** Saves settings, and — with `{ run: true }` — starts a pass right now. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { run?: boolean } & Record<string, unknown>;
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) return new Response('Bad Request', { status: 400 });

  const next = { ...getNightShiftSettings(), ...parsed.data };
  setSetting(NIGHT_SHIFT_SETTINGS_KEY, next);

  if (body.run) {
    const base = resolveOllamaHostServer();
    if (!base) {
      return Response.json(
        { error: 'No active Ollama host configured', code: 'NO_HOST' },
        { status: 428 },
      );
    }
    const model = next.model || DEFAULT_NIGHT_SHIFT.model || process.env.TELEGRAM_MODEL || '';
    if (!model) {
      return Response.json({ error: 'No model selected', code: 'NO_MODEL' }, { status: 400 });
    }
    // Detached: a pass is minutes of model time and must outlive this request.
    void runNightShift({ base, model, trigger: 'manual', settings: next });
  }
  return Response.json(state());
}

export async function DELETE() {
  const stopped = stopNightShift();
  return Response.json({ ...state(), stopped });
}
