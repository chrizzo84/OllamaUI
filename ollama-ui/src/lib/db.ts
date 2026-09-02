/**
 * The database API, as one import surface.
 *
 * The implementation is split by entity under src/lib/db/ — connection.ts
 * owns the file, the schema and the migrations; every other module holds the
 * queries for one thing. Everything is re-exported here so callers keep
 * writing `from '@/lib/db'` and never have to track which module a given
 * function lives in.
 */
export * from './db/connection';
export * from './db/lamas';
export * from './db/hosts';
export * from './db/sessions';
export * from './db/attachments';
export * from './db/messages';
export * from './db/evals';
export * from './db/search';
export * from './db/settings';
export * from './db/memories';
export * from './db/benchmarks';
export * from './db/scheduled-tasks';
