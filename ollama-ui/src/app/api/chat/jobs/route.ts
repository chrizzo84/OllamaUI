import { listJobs } from '@/lib/generation-jobs';

// Must be nodejs, not edge — see src/app/api/chat/jobs/[id]/route.ts for why.
export const runtime = 'nodejs';

// GET /api/chat/jobs — lists every generation job currently in the registry
// (running, plus recently finished ones still within the retention window).
// Powers a global "N generating" indicator that's visible from any page, not
// just the chat page the job happens to belong to.
export async function GET() {
  return Response.json({ jobs: listJobs() });
}
