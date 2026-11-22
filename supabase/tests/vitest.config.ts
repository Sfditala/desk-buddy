import { defineConfig } from 'vitest/config';

// Integration tests against a LOCAL Supabase stack only (`npx supabase start`).
export default defineConfig({
  test: {
    include: ['*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    globalSetup: './global-setup.ts',
  },
});
