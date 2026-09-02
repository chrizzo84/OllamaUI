import { defineConfig } from 'vitest/config';
import path from 'node:path';

/*
Unit tests for the pure-logic modules under src/lib (and the pure helpers in
src/store). Deliberately node-environment only: none of what's covered here
touches the DOM, and keeping jsdom out of the dependency tree keeps `pnpm
test` fast enough to run on every commit.

Anything that reaches the database goes through the fakes in
src/test/fake-db.ts rather than opening a real SQLite file — see the note
there for why a test must never let src/lib/db.ts initialize for real.
*/
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The scheduler/reminder tests pin a fixed clock; a stray real timer
    // leaking between files would make them order-dependent.
    restoreMocks: true,
    unstubEnvs: true,
  },
});
