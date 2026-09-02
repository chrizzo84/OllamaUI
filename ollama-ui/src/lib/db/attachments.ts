// Uploaded files: metadata in SQLite, bytes on disk.
import { db, dbInstance, writeAttachment, sniffImageMime, uploadsDir } from './connection';
import path from 'path';
import fs from 'fs';

// --- Attachments ---

export interface AttachmentRow {
  id: string;
  mime: string;
  byteSize: number;
  createdAt: number;
}

// Stores bytes and returns the content-addressed id. Re-storing identical
// bytes is a no-op that returns the same id.
export function saveAttachment(bytes: Buffer, mime?: string): AttachmentRow {
  const resolvedMime = mime && mime !== 'application/octet-stream' ? mime : sniffImageMime(bytes);
  const { id } = writeAttachment(dbInstance(), bytes, resolvedMime);
  return { id, mime: resolvedMime, byteSize: bytes.length, createdAt: Date.now() };
}

export function getAttachmentMeta(id: string): AttachmentRow | undefined {
  const r = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as
    { id: string; mime: string; byte_size: number; created_at: number } | undefined;
  return r ? { id: r.id, mime: r.mime, byteSize: r.byte_size, createdAt: r.created_at } : undefined;
}

export function readAttachment(id: string): Buffer | null {
  // Ids are SHA-256 hex and are validated as such before touching the
  // filesystem: an id is the only user-controlled part of the path, and
  // without this check a crafted "../../.." would read arbitrary files.
  if (!/^[0-9a-f]{64}$/.test(id)) return null;
  const file = path.join(uploadsDir, id);
  if (!fs.existsSync(file)) return null;
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

// Base64 for the ids given, in order, skipping any that can't be read —
// this is what turns stored attachments back into Ollama's inline `images`
// wire format at request time.
export function attachmentsAsBase64(ids: string[] | undefined): string[] {
  if (!ids?.length) return [];
  const out: string[] = [];
  for (const id of ids) {
    const bytes = readAttachment(id);
    if (bytes) out.push(bytes.toString('base64'));
  }
  return out;
}
