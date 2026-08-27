import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// No framework: the interface is plain DOM in TypeScript classes. Vite is here
// for bundling, the dev server and its proxy onto the API.
export default defineConfig({
  root: 'src/client',
  publicDir: resolve(__dirname, 'src/client/static'),
  resolve: { alias: { '@': resolve(__dirname, './src') } },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
