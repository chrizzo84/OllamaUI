/*
Automatic SQLite snapshots.

Two things this protects against, which are different problems:

  1. A one-way migration. Moving messages out of the per-session JSON blob
     drops the old column afterwards, deliberately, so there is exactly one
     source of truth — and that step cannot be undone. A snapshot is taken
     immediately before, and if it CANNOT be taken the migration is refused
     rather than run unprotected (see backupBeforeMigration).
  2. Everything else that eats data slowly: a mis-clicked "delete session", a
     scheduled task that went wrong overnight, filesystem corruption. That's
     what the periodic snapshot on startup is for.

Snapshots are taken with `VACUUM INTO`, not a file copy. A copy of a live
SQLite database can miss whatever is still in the write-ahead log, and can
catch a write mid-flight; VACUUM INTO produces a consistent, already-compact
database file from inside the engine.
*/
import type { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';

// Only skipped when someone deliberately opts out (a read-only volume, or an
// external backup system already covering this).
export function backupsDisabled(): boolean {
  return process.env.OLLAMA_UI_BACKUP_DISABLED === '1';
}

// How many snapshots to keep. Enough to cover "I noticed a few days later",
// bounded so a small personal database can't quietly fill a disk.
function keepCount(): number {
  const raw = Number(process.env.OLLAMA_UI_BACKUP_KEEP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 7;
}

/*
Minimum gap between periodic snapshots. Without it, every dev-server restart
(or every container restart in a crash loop) would take one, and the retained
set would be seven snapshots from the same minute — which protects against
nothing.
*/
const PERIODIC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface BackupInfo {
  file: string;
  createdAt: number;
  byteSize: number;
}

function backupDir(dataDir: string): string {
  return path.join(dataDir, 'backups');
}

// Snapshot filenames carry a sortable timestamp and the reason they were
// taken, so the pre-migration one is identifiable at a glance among the
// routine dailies.
const BACKUP_FILE_RE = /^app-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-z0-9-]+\.db$/;

export function listBackups(dataDir: string): BackupInfo[] {
  const dir = backupDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  const out: BackupInfo[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!BACKUP_FILE_RE.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      out.push({ file: full, createdAt: stat.mtimeMs, byteSize: stat.size });
    } catch {
      /* vanished between readdir and stat — ignore */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

function timestampForFilename(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace(/:/g, '-');
}

/*
Writes one snapshot and returns its path. Throws on failure — callers decide
whether that is fatal (it is, before a one-way migration) or not (it isn't
for the periodic one).
*/
function writeSnapshot(instance: DatabaseSync, dataDir: string, reason: string): string {
  const dir = backupDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  /*
  Filenames are only precise to the second, which keeps them readable. Two
  snapshots within the same second would collide, and VACUUM INTO refuses to
  overwrite — so a free name is found rather than silently returning the
  existing file and skipping the snapshot the caller asked for.
  */
  const stamp = timestampForFilename(new Date());
  let target = path.join(dir, `app-${stamp}-${reason}.db`);
  for (let n = 2; fs.existsSync(target); n++) {
    target = path.join(dir, `app-${stamp}-${reason}-${n}.db`);
  }
  // The path is interpolated rather than bound because VACUUM INTO does not
  // accept a bound parameter. `reason` is a caller-supplied literal and the
  // timestamp is generated, so nothing here comes from user input; the quote
  // escaping is belt-and-braces.
  instance.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return target;
}

// Deletes the oldest snapshots beyond the retention count. Best-effort: a
// file that can't be removed is left alone rather than failing a backup that
// otherwise succeeded.
function prune(dataDir: string): void {
  const keep = keepCount();
  for (const old of listBackups(dataDir).slice(keep)) {
    try {
      fs.rmSync(old.file);
    } catch {
      /* ignore */
    }
  }
}

/*
Mandatory snapshot before a migration that cannot be undone.

Failure here is fatal on purpose. The alternative — running a one-way
migration with no way back because the disk was full — is exactly the
situation this exists to prevent. Aborting leaves the database untouched and
the migration still pending, so it simply runs on the next start once the
problem is fixed.
*/
export function backupBeforeMigration(
  instance: DatabaseSync,
  dataDir: string,
  reason: string,
): string | null {
  if (backupsDisabled()) {
    console.warn(
      `[db] OLLAMA_UI_BACKUP_DISABLED=1 — running the "${reason}" migration without a snapshot.`,
    );
    return null;
  }
  let file: string;
  try {
    file = writeSnapshot(instance, dataDir, reason);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Refusing to run the one-way "${reason}" migration: could not write a database backup first (${message}). ` +
        `Free up space or fix permissions on ${backupDir(dataDir)} and restart — your data has not been touched. ` +
        `Set OLLAMA_UI_BACKUP_DISABLED=1 to proceed without one.`,
    );
  }
  console.log(`[db] backed up to ${file} before the "${reason}" migration`);
  prune(dataDir);
  return file;
}

/*
Routine snapshot on startup, at most once per PERIODIC_INTERVAL_MS.

Best-effort by design: this one is insurance, not a precondition, and a
failure to write it must never stop the app from starting. It is logged so
the failure is still visible.
*/
export function backupPeriodically(instance: DatabaseSync, dataDir: string): void {
  if (backupsDisabled()) return;
  const newest = listBackups(dataDir)[0];
  if (newest && Date.now() - newest.createdAt < PERIODIC_INTERVAL_MS) return;
  try {
    console.log(`[db] backed up to ${writeSnapshot(instance, dataDir, 'daily')}`);
    prune(dataDir);
  } catch (e) {
    console.error('[db] periodic backup failed:', e instanceof Error ? e.message : e);
  }
}
