import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  minify: true,
  sourcemap: false,
  dts: true,
  // Keep external dependencies external (not bundled)
  external: [
    '@modelcontextprotocol/sdk',
    '@mozilla/readability',
    'jsdom',
    'turndown',
    'zod',
  ],
});
