import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const CONTROL_PORT = Number(process.env.AITUBER_CONTROL_PORT ?? 8765);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    watch: {
      // `backup/` is 1.5 GB of purchased packages and extracted textures and
      // `public/models` is 28 MB of built GLB. Neither is source, and watching
      // them costs a file handle per file and a full page reload every time the
      // model pipeline writes.
      ignored: ['**/backup/**', '**/public/models/**'],
    },
    // Loopback only, and that is a licence condition rather than a default —
    // see backup/plans/02-license.md. The avatars used for validation may not
    // be published, so the viewer must not be reachable from another machine.
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${CONTROL_PORT}`,
        changeOrigin: false,
        // The command channel is Server-Sent Events. Buffering it would hold
        // every command until the connection closed.
        ws: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Models are several megabytes each and are served from public/ as-is.
    assetsInlineLimit: 4096,
  },
});
