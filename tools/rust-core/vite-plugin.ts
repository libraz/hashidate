import type { Plugin } from 'vite';
import { buildCore } from './build';

// Plain paths: the watcher does not expand globs. Filtered by name in the handler.
const WATCHED = ['crates', 'Cargo.toml'];
const DEBOUNCE_MS = 100;

/** Build the wasm core on start and rebuild it when the Rust sources change. */
export function rustCore(): Plugin {
  return {
    name: 'hashidate:rust-core',
    // Not buildStart, which runs once per environment.
    configResolved() {
      buildCore();
    },
    configureServer(server) {
      server.watcher.add(WATCHED);
      let timer: NodeJS.Timeout | undefined;
      // The build is synchronous, so builds never overlap; the debounce folds a burst of
      // changes, including those delivered while a build ran, into one more build.
      const rebuild = (): void => {
        try {
          buildCore();
          server.ws.send({ type: 'full-reload' });
        } catch (e) {
          console.error(e instanceof Error ? e.message : e);
        }
      };
      const onChange = (path: string): void => {
        if (!(path.endsWith('.rs') || path.endsWith('Cargo.toml'))) return;
        clearTimeout(timer);
        timer = setTimeout(rebuild, DEBOUNCE_MS);
      };
      server.watcher.on('change', onChange);
      server.watcher.on('add', onChange);
      server.watcher.on('unlink', onChange);
    },
  };
}
