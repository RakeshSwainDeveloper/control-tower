import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Isolation tests share one database; run serially so one test's tenant
    // context can never bleed into another's assertions.
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  resolve: {
    // Alias the workspace packages straight to TypeScript source.
    //
    // Deliberately NOT `resolve.conditions: ['development', ...]`: overriding
    // the global condition list changes how every CommonJS dependency resolves
    // too, and `pg` -> `pg-pool` then arrives as an ESM namespace object,
    // producing "Class extends value [object Module] is not a constructor".
    // An alias touches only our own packages and leaves node_modules alone.
    alias: {
      '@ct/contracts': resolve(here, '../../packages/contracts/src/index.ts'),
      '@ct/db': resolve(here, '../../packages/db/src/index.ts'),
    },
  },
});
