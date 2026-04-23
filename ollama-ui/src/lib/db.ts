/**
 * Persistent storage via JSON files in /data/.
 *
 * Note: better-sqlite3 was removed due to native-module compilation issues in
 * Docker/multi-platform environments. Data is now stored as plain JSON files
 * (data/lamas.json and data/hosts.json). All previously exported functions
 * maintain the same signature for drop-in compatibility.
 */
import { safeUuid } from '@/lib/utils';
import path from 'path';
import fs from 'fs';

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const lamasFile = path.join(dataDir, 'lamas.json');
const hostsFile = path.join(dataDir, 'hosts.json');

// --- Generic JSON store helpers ---

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(file: string, data: T): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

// --- Lamas ---

export interface LamaRow {
  id: string;
  name: string;
  prompt: string;
  tags: string; // json array string
  updated_at: number;
}

function readLamas(): LamaRow[] {
  return readJson<LamaRow[]>(lamasFile, []);
}

function writeLamas(rows: LamaRow[]): void {
  writeJson(lamasFile, rows);
}

export function listLamas(): LamaRow[] {
  return readLamas().sort((a, b) => b.updated_at - a.updated_at);
}

export function getLama(id: string): LamaRow | undefined {
  return readLamas().find((r) => r.id === id);
}

export function createLama(data: {
  id: string;
  name: string;
  prompt?: string;
  tags?: string[];
}): LamaRow {
  const now = Date.now();
  const row: LamaRow = {
    id: data.id,
    name: data.name || 'Untitled',
    prompt: data.prompt || '',
    tags: JSON.stringify(data.tags || []),
    updated_at: now,
  };
  const rows = readLamas();
  rows.push(row);
  writeLamas(rows);
  return row;
}

export function updateLama(
  id: string,
  patch: { name?: string; prompt?: string; tags?: string[] },
): LamaRow | undefined {
  const rows = readLamas();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return undefined;
  const existing = rows[idx];
  const updated: LamaRow = {
    ...existing,
    name: patch.name ?? existing.name,
    prompt: patch.prompt ?? existing.prompt,
    tags: JSON.stringify(patch.tags ?? JSON.parse(existing.tags)),
    updated_at: Date.now(),
  };
  rows[idx] = updated;
  writeLamas(rows);
  return updated;
}

export function deleteLama(id: string): void {
  writeLamas(readLamas().filter((r) => r.id !== id));
}

export function importLamas(
  list: Array<{ name?: string; prompt?: string; tags?: string[] }>,
): string[] {
  const rows = readLamas();
  const now = Date.now();
  const ids: string[] = [];
  for (const raw of list) {
    const id = safeUuid();
    rows.push({
      id,
      name: raw.name?.trim() || 'Import',
      prompt: raw.prompt || '',
      tags: JSON.stringify((raw.tags || []).slice(0, 20)),
      updated_at: now,
    });
    ids.push(id);
  }
  writeLamas(rows);
  return ids;
}

// --- Hosts ---

export interface HostRow {
  id: string;
  url: string;
  label?: string | null;
  created_at: number;
  last_used_at: number;
  active: number; // 0/1
}

function readHosts(): HostRow[] {
  return readJson<HostRow[]>(hostsFile, []);
}

function writeHosts(rows: HostRow[]): void {
  writeJson(hostsFile, rows);
}

export function listHosts(): HostRow[] {
  return readHosts().sort((a, b) => {
    if (b.active !== a.active) return b.active - a.active;
    if (b.last_used_at !== a.last_used_at) return b.last_used_at - a.last_used_at;
    return b.created_at - a.created_at;
  });
}

export function getActiveHost(): HostRow | undefined {
  return readHosts().find((h) => h.active === 1);
}

export function addHost(url: string, label?: string): HostRow {
  const rows = readHosts();
  const existing = rows.find((h) => h.url === url);
  const now = Date.now();
  if (existing) {
    if (label && label !== existing.label) {
      existing.label = label;
      writeHosts(rows);
    }
    return existing;
  }
  const row: HostRow = {
    id: safeUuid(),
    url,
    label: label || null,
    created_at: now,
    last_used_at: now,
    active: 0,
  };
  rows.push(row);
  writeHosts(rows);
  return row;
}

export function activateHost(id: string): HostRow | undefined {
  const rows = readHosts();
  const target = rows.find((h) => h.id === id);
  if (!target) return undefined;
  const now = Date.now();
  for (const h of rows) {
    h.active = h.id === id ? 1 : 0;
    if (h.id === id) h.last_used_at = now;
  }
  writeHosts(rows);
  return rows.find((h) => h.id === id);
}

export function deleteHost(id: string): void {
  const rows = readHosts();
  const target = rows.find((h) => h.id === id);
  if (!target) return;
  const remaining = rows.filter((h) => h.id !== id);
  if (target.active && remaining.length > 0) {
    const next = [...remaining].sort((a, b) => b.last_used_at - a.last_used_at)[0];
    next.active = 1;
    next.last_used_at = Date.now();
  }
  writeHosts(remaining);
}

export function updateHost(
  id: string,
  patch: { url?: string; label?: string },
): HostRow | undefined {
  const rows = readHosts();
  const idx = rows.findIndex((h) => h.id === id);
  if (idx === -1) return undefined;
  const existing = rows[idx];
  const nextUrl = patch.url?.trim() || existing.url;
  const nextLabel = (patch.label === undefined ? existing.label : patch.label) || null;
  if (nextUrl !== existing.url) {
    const conflict = rows.find((h) => h.url === nextUrl && h.id !== id);
    if (conflict) throw new Error('URL already exists');
  }
  rows[idx] = { ...existing, url: nextUrl, label: nextLabel };
  writeHosts(rows);
  return rows[idx];
}
