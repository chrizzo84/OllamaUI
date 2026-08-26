// In-memory registry for chat-generation jobs, so a running Ollama call is no
// longer tied to the HTTP connection that started it. This app runs as a
// single long-lived Node process (`next build --standalone` + `node
// server.js`), not serverless, so a module-level Map is a valid singleton for
// the process's lifetime — no queue/worker/Redis needed.
//
// Deliberately generic: no knowledge of Ollama's wire format or the sessions
// DB. See src/lib/chat-persistence.ts for the domain-specific completion
// logic, and src/app/api/chat/route.ts for the actual generation loop.

export type JobStatus = 'running' | 'done' | 'error' | 'aborted';

export interface Job {
  id: string; // == the assistant message id the client already generated
  sessionId: string;
  column: 'A' | 'B';
  model: string;
  status: JobStatus;
  abortController: AbortController;
  createdAt: number;
  // Opaque to this module — the caller (route.ts) decides the shape (content/
  // thinking/trace/stats). Kept up to date so a fresh subscriber (a newly
  // opened tab reconnecting to an in-progress job) can catch up instantly
  // instead of waiting for the next live delta.
  snapshot: unknown;
}

type Listener = (event: unknown) => void;

const jobs = new Map<string, Job>();
const subscribers = new Map<string, Set<Listener>>();

// Long enough for a racing DELETE (Stop) or a slow final read to still find
// the job after it settles; short enough not to leak memory over a long
// uptime given jobs are created continuously.
const JOB_RETENTION_MS = 30_000;

export function createJob(
  id: string,
  meta: { sessionId: string; column: 'A' | 'B'; model: string },
): Job {
  const job: Job = {
    id,
    sessionId: meta.sessionId,
    column: meta.column,
    model: meta.model,
    status: 'running',
    abortController: new AbortController(),
    createdAt: Date.now(),
    snapshot: null,
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export interface JobSummary {
  id: string;
  sessionId: string;
  column: 'A' | 'B';
  model: string;
  status: JobStatus;
  createdAt: number;
}

// Plain, JSON-serializable view of every job currently in the registry
// (running, plus recently finished ones still within the retention window) —
// used by GET /api/chat/jobs for a global "N generating" indicator. Omits
// `abortController` (not serializable) and `snapshot` (potentially large,
// and not needed for a listing — see GET /api/chat/jobs/[id] for that).
export function listJobs(): JobSummary[] {
  return [...jobs.values()].map((j) => ({
    id: j.id,
    sessionId: j.sessionId,
    column: j.column,
    model: j.model,
    status: j.status,
    createdAt: j.createdAt,
  }));
}

export function updateSnapshot(id: string, snapshot: unknown): void {
  const job = jobs.get(id);
  if (job) job.snapshot = snapshot;
}

// Only ever called from the explicit Stop endpoint. Never call this from a
// stream's `cancel()` handler — a client disconnecting (tab closed) must NOT
// abort the job, that's the entire point of this module.
export function abortJob(id: string): void {
  jobs.get(id)?.abortController.abort();
}

export function subscribe(id: string, listener: Listener): () => void {
  let set = subscribers.get(id);
  if (!set) {
    set = new Set();
    subscribers.set(id, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) subscribers.delete(id);
  };
}

export function publish(id: string, event: unknown): void {
  const set = subscribers.get(id);
  if (!set || set.size === 0) return;
  for (const listener of set) listener(event);
}

export function settleJob(id: string, status: Exclude<JobStatus, 'running'>): void {
  const job = jobs.get(id);
  if (!job) return;
  job.status = status;
  setTimeout(() => {
    jobs.delete(id);
    subscribers.delete(id);
  }, JOB_RETENTION_MS);
}

// Wires a job's events to a fresh NDJSON ReadableStream: emits a catch-up
// snapshot first (if any), then tails live events, closing the stream when a
// `{streamEnd:true}` control event comes through (see route.ts's
// finishDone/finishError). Shared by the initial POST /api/chat response and
// the GET /api/chat/jobs/[id] reconnect endpoint — both attach a browser tab
// to a job the exact same way, they just differ in whether the job already
// existed. Returns null if the job is unknown (already evicted or never
// existed) — the caller should 404 in that case.
export function createJobEventStream(id: string): ReadableStream<Uint8Array> | null {
  const job = jobs.get(id);
  if (!job) return null;
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  return new ReadableStream({
    start(controller) {
      function write(event: unknown): boolean {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
          return true;
        } catch {
          return false;
        }
      }
      if (job!.snapshot != null) write({ snapshot: job!.snapshot });
      if (job!.status !== 'running') {
        // Already finished (possibly just now, within the retention window)
        // — nothing more will ever publish, so there's nothing to subscribe
        // to. The snapshot above (if any) is already the final state.
        write({ streamEnd: true });
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        return;
      }
      unsubscribe = subscribe(id, (event) => {
        if (!write(event)) {
          unsubscribe?.();
          return;
        }
        const e = event as { streamEnd?: boolean };
        if (e.streamEnd === true) {
          unsubscribe?.();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      });
    },
    cancel() {
      // Client disconnected — only stop forwarding, never touch the job
      // itself (see abortJob's own doc comment for why).
      unsubscribe?.();
    },
  });
}
