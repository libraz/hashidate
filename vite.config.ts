import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const CONTROL_PORT = Number(process.env.HASHIDATE_CONTROL_PORT ?? 8765);

/**
 * Print the panel's address next to the viewer's on startup.
 *
 * The dev server has two entries but only announces the one at the root, and
 * the panel is the page an operator spends the broadcast in — leaving its
 * address as something you had to already know made the second surface look
 * like it was not running.
 */
function announcePanel(): Plugin {
  return {
    name: 'hashidate:announce-panel',
    apply: 'serve',
    configureServer(server) {
      const printUrls = server.printUrls.bind(server);
      // The arrow and the bold label vite prints for its own lines, written out
      // rather than imported — its colour helper is internal. Dropped when
      // stdout is not a terminal, which is how `yarn dev` runs it: the child of
      // `concurrently` is a pipe, vite prints its own lines uncoloured there,
      // and an escape sequence nothing interprets is left on screen as text.
      const arrow = process.stdout.isTTY
        ? '  \x1b[32m➜\x1b[39m  \x1b[1mPanel\x1b[22m'
        : '  ➜  Panel';
      server.printUrls = () => {
        printUrls();
        for (const url of server.resolvedUrls?.local ?? []) {
          server.config.logger.info(`${arrow}:   ${url}panel/`);
        }
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), announcePanel()],
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
      // The documents the character presents from. They are not part of the
      // build — an operator saves one into the directory during a broadcast —
      // so they are served by the control server here and in production alike,
      // and the directory can sit outside the document root entirely.
      '/slides': {
        target: `http://127.0.0.1:${CONTROL_PORT}`,
        changeOrigin: false,
      },
      // pdf.js's character maps and standard font outlines, which it fetches
      // for a document that names a font instead of carrying it. Served by the
      // control server out of the installed package rather than copied into the
      // build; see its `PDFJS_PREFIX`.
      '/pdfjs': {
        target: `http://127.0.0.1:${CONTROL_PORT}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Models are several megabytes each and are served from public/ as-is.
    assetsInlineLimit: 4096,
    rollupOptions: {
      /*
       * Two pages, and the split is the point rather than a build detail.
       *
       * `index.html` renders the character; `panel/` drives it and renders
       * nothing. Separate entries mean the panel ships none of three.js and the
       * stage ships none of the queue editor — which matters most in the
       * direction nobody expects: the panel is the page left open on a second
       * monitor for six hours, and a WebGL context it never uses is a context
       * competing with the one that is on air.
       */
      input: {
        viewer: fileURLToPath(new URL('./index.html', import.meta.url)),
        panel: fileURLToPath(new URL('./panel/index.html', import.meta.url)),
      },
    },
  },
});
