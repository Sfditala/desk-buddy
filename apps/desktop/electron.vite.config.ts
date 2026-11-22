import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/**
 * Dev only: Vite injects CSS through <style> tags and uses a websocket for HMR, which the
 * production CSP forbids. Production keeps the strict policy (also sent as a header by the
 * app:// protocol handler, which is the one that actually applies).
 */
function devCsp(): Plugin {
  return {
    name: 'desk-buddy:dev-csp',
    apply: 'serve',
    transformIndexHtml: (html: string) =>
      html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
  };
}

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ['@desk-buddy/core'] },
      rolldownOptions: { input: { index: resolve(import.meta.dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    // Sandboxed preloads cannot load ESM or node_modules: bundle everything into one CJS file.
    build: {
      externalizeDeps: { exclude: ['zod'] },
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [devCsp()],
    build: {
      assetsInlineLimit: 0,
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') },
      },
    },
  },
});
