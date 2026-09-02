// Recurring prompts and one-off reminders.
import { db } from './connection';
import { safeUuid } from '@/lib/utils';

// --- Scheduled tasks (recurring prompts, driven by src/lib/scheduler.ts) ---

export interface ScheduledTaskRow {
  id: string;
  name: string;
  prompt: string;
  model: string;
  timeOfDay: string; // 'HH:MM', server-local time — unused when recurring is false
  daysOfWeek: number[]; // JS Date.getDay() convention, 0 = Sunday — unused when recurring is false
  // false = one-off reminder (create_reminder tool, see generation-runner.ts):
  // fires once at nextRunAt, then the row is deleted rather than getting a
  // new nextRunAt. true = the normal recurring task created via /schedule.
  recurring: boolean;
  toolsEnabled: boolean;
  memoryEnabled: boolean;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRunSessionId: string | null;
  created_at: number;
  updated_at: number;
}

interface ScheduledTaskDbRow {
  id: string;
  name: string;
  prompt: string;
  model: string;
  time_of_day: string;
  days_of_week: string;
  recurring: number;
  tools_enabled: number;
  memory_enabled: number;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_session_id: string | null;
  created_at: number;
  updated_at: number;
}

function rowToScheduledTask(r: ScheduledTaskDbRow): ScheduledTaskRow {
  let daysOfWeek: number[];
  try {
    daysOfWeek = JSON.parse(r.days_of_week);
  } catch {
    daysOfWeek = [0, 1, 2, 3, 4, 5, 6];
  }
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    model: r.model,
    timeOfDay: r.time_of_day,
    daysOfWeek,
    recurring: !!r.recurring,
    toolsEnabled: !!r.tools_enabled,
    memoryEnabled: !!r.memory_enabled,
    enabled: !!r.enabled,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastRunSessionId: r.last_run_session_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function listScheduledTasks(): ScheduledTaskRow[] {
  const rows = db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all();
  return (rows as unknown as ScheduledTaskDbRow[]).map(rowToScheduledTask);
}

export function getScheduledTask(id: string): ScheduledTaskRow | undefined {
  const r = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    ScheduledTaskDbRow | undefined;
  return r ? rowToScheduledTask(r) : undefined;
}

export function createScheduledTask(data: {
  name: string;
  prompt: string;
  model: string;
  timeOfDay: string;
  daysOfWeek: number[];
  recurring?: boolean; // defaults true — the manual /schedule form only ever creates recurring tasks
  toolsEnabled: boolean;
  memoryEnabled: boolean;
  nextRunAt: number;
}): ScheduledTaskRow {
  const now = Date.now();
  const row: ScheduledTaskRow = {
    id: safeUuid(),
    name: data.name,
    prompt: data.prompt,
    model: data.model,
    timeOfDay: data.timeOfDay,
    daysOfWeek: data.daysOfWeek,
    recurring: data.recurring ?? true,
    toolsEnabled: data.toolsEnabled,
    memoryEnabled: data.memoryEnabled,
    enabled: true,
    nextRunAt: data.nextRunAt,
    lastRunAt: null,
    lastRunSessionId: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO scheduled_tasks
      (id, name, prompt, model, time_of_day, days_of_week, recurring, tools_enabled, memory_enabled, enabled, next_run_at, last_run_at, last_run_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.name,
    row.prompt,
    row.model,
    row.timeOfDay,
    JSON.stringify(row.daysOfWeek),
    row.recurring ? 1 : 0,
    row.toolsEnabled ? 1 : 0,
    row.memoryEnabled ? 1 : 0,
    row.enabled ? 1 : 0,
    row.nextRunAt,
    row.lastRunAt,
    row.lastRunSessionId,
    row.created_at,
    row.updated_at,
  );
  return row;
}

export function updateScheduledTask(
  id: string,
  patch: Partial<
    Pick<
      ScheduledTaskRow,
      | 'name'
      | 'prompt'
      | 'model'
      | 'timeOfDay'
      | 'daysOfWeek'
      | 'recurring'
      | 'toolsEnabled'
      | 'memoryEnabled'
      | 'enabled'
      | 'nextRunAt'
      | 'lastRunAt'
      | 'lastRunSessionId'
    >
  >,
): ScheduledTaskRow | undefined {
  const existing = getScheduledTask(id);
  if (!existing) return undefined;
  const updated: ScheduledTaskRow = { ...existing, ...patch, updated_at: Date.now() };
  db.prepare(
    `UPDATE scheduled_tasks SET
      name=?, prompt=?, model=?, time_of_day=?, days_of_week=?, recurring=?, tools_enabled=?, memory_enabled=?,
      enabled=?, next_run_at=?, last_run_at=?, last_run_session_id=?, updated_at=?
      WHERE id=?`,
  ).run(
    updated.name,
    updated.prompt,
    updated.model,
    updated.timeOfDay,
    JSON.stringify(updated.daysOfWeek),
    updated.recurring ? 1 : 0,
    updated.toolsEnabled ? 1 : 0,
    updated.memoryEnabled ? 1 : 0,
    updated.enabled ? 1 : 0,
    updated.nextRunAt,
    updated.lastRunAt,
    updated.lastRunSessionId,
    updated.updated_at,
    id,
  );
  return updated;
}

export function deleteScheduledTask(id: string): void {
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}
