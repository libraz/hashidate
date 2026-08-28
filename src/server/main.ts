import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { SpeechState } from '../protocol';
import { Decks } from './decks';
import { Hub } from './hub';
import { Motions } from './motions';
import { handleApi } from './routes';
import { SIDECAR, SpeechWatch } from './speech';
import { serveStatic } from './static';

/**
 * Local control API for the hashidate runtime.
 *
 * Serves the viewer and carries commands to it, so an orchestrator running in
 * another process can drive the avatar.
 *
 *     orchestrator  ──POST /api/command──►  this server  ──SSE──►  viewer
 *                   ◄──GET  /api/state───                ◄─POST──
 *
 * Commands go down over Server-Sent Events; the viewer posts its state and its
 * turn events back up. SSE rather than WebSocket because it needs no dependency
 * and no handshake, and the traffic is one-directional by nature: a few commands
 * a second down, a state snapshot a second up.
 *
 * **Binds to 127.0.0.1 only, and that is a licence condition, not a default.**
 * The avatar may not be republished. There is deliberately no CORS header
 * either — the viewer is same-origin, so allowing another origin would only
 * ever serve a page that is not ours.
 *
 * usage: yarn start [--port 8765] [--root dist] [--slides show/slides] [--motions show/motions]
 */

const BIND = '127.0.0.1'; // do not change; see the module docstring
const DEFAULT_PORT = 8765;
const DEFAULT_ROOT = 'dist';

/**
 * Where the documents are, and the URL they are reached at.
 *
 * A second root rather than a directory inside the document root, because the
 * document root is a build output: `vite build` writes it, and anything an
 * operator dropped in there would last until the next build. The directory is
 * optional and a missing one is simply no documents — see `decks.ts`.
 *
 * The bytes are served from `/slides/` and deliberately not from under `/api/`.
 * It is a file read, answered with a file's content type and streamed; the API
 * answers JSON and only JSON, and a route that broke that rule would have to be
 * excepted in every caller that trusts it.
 */
const DEFAULT_SLIDES = 'show/slides';
const SLIDES_PREFIX = '/slides';

/**
 * Where the operator's own gestures are.
 *
 * Beside the documents under `show/`, because they are the same kind of thing:
 * material somebody brought to a broadcast rather than anything the build
 * produced. Read on request and never served as bytes — a motion reaches the
 * renderer as JSON on `/api/motions`, parsed and checked, and the file itself
 * stays on the machine it was written on. See `src/server/motions.ts`.
 */
const DEFAULT_MOTIONS = 'show/motions';

/**
 * The two data directories pdf.js needs to draw a document it was not given the
 * fonts for.
 *
 * A PDF may name a font instead of carrying it, and for Japanese it usually
 * does: 游ゴシック and MS 明朝 are on the machine that made the deck, so nothing
 * embeds them. Reading those pages needs the character-map tables in `cmaps/`,
 * and the fourteen standard PostScript faces need the outlines in
 * `standard_fonts/`. Without them pdf.js draws the page with the text missing —
 * not an error, not a warning anybody sees, just a slide that has lost its
 * words, which is the one failure this whole feature exists to avoid.
 *
 * Served out of the installed package rather than copied into the build. They
 * are 2.4 MB of somebody else's data files that change when the library does,
 * and this project is only ever run from its own checkout — the document root
 * is `dist` next to the `node_modules` this resolves.
 */
const PDFJS_PREFIX = '/pdfjs';
const PDFJS_DIRS = ['cmaps', 'standard_fonts'] as const;

/**
 * Where pdf.js is installed, or null if it is not.
 *
 * Resolved through the package's own entry rather than assembled out of
 * `node_modules`, so a hoisted install, a workspace and a linked checkout all
 * answer correctly — and so this says nothing about how packages happen to be
 * laid out today.
 */
function pdfjsRoot(): string | null {
  try {
    return dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  } catch {
    return null;
  }
}

function main(): void {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      root: { type: 'string' },
      slides: { type: 'string' },
      motions: { type: 'string' },
    },
  });

  const port = values.port === undefined ? DEFAULT_PORT : Number.parseInt(values.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`--port takes an integer between 1 and 65535: ${values.port}`);
    process.exit(2);
  }
  const root = resolve(values.root ?? DEFAULT_ROOT);
  const slides = resolve(values.slides ?? DEFAULT_SLIDES);
  const motionsRoot = resolve(values.motions ?? DEFAULT_MOTIONS);

  const decks = new Decks(slides);
  const motions = new Motions(motionsRoot);
  const speech = new SpeechWatch();
  const hub = new Hub(decks, speech);
  // Null on an install without the library, which is not a reason to refuse to
  // start: a document whose fonts are all embedded — most of them — draws
  // perfectly without either directory.
  const pdfjs = pdfjsRoot();
  const server = createServer((req, res) => {
    if (handleApi(req, res, hub, decks, motions)) return;
    if (req.method === 'GET' || req.method === 'HEAD') {
      // Same guard, same refusal to cache — the only difference is which root
      // the path is resolved against. See `serveStatic`.
      const url = req.url ?? '/';
      if (url.startsWith(`${SLIDES_PREFIX}/`)) {
        serveStatic(req, res, slides, SLIDES_PREFIX);
        return;
      }
      // One mount per directory rather than one over the package, so what is
      // reachable is the two sets of data files and not the library's source.
      const data = PDFJS_DIRS.find((dir) => url.startsWith(`${PDFJS_PREFIX}/${dir}/`));
      if (data && pdfjs !== null) {
        serveStatic(req, res, join(pdfjs, data), `${PDFJS_PREFIX}/${data}`);
        return;
      }
      serveStatic(req, res, root);
      return;
    }
    // Anything that is not a file read is an API call that named the wrong
    // path, so it is answered in the API's own terms rather than as a file.
    const body = Buffer.from(JSON.stringify({ error: 'unknown endpoint' }), 'utf8');
    res.writeHead(404, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });

  // A half-written request from a browser that was closed mid-reload is
  // routine, and the default handling logs a stack trace for each one.
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('error', (error) => {
    console.error(String(error));
    process.exit(1);
  });

  server.listen(port, BIND, () => {
    console.log(`viewer   http://${BIND}:${port}/`);
    console.log(`control  http://${BIND}:${port}/api/`);
    // Printed whether or not the directory exists: the line an operator needs
    // is where to put a document, and that is most useful before there is one.
    console.log(`slides   ${slides}`);
    // And where a motion goes, on the same reasoning: the line is worth most
    // before the directory has anything in it.
    console.log(`motions  ${motionsRoot}`);
    // And whether or not there is a voice, for the same reason. A sidecar that
    // was meant to be running and is not looks exactly like one that was never
    // installed until somebody says which of the two this is, and the moment to
    // say it is before the first line rather than after it went out silent.
    void speech.start().then((state) => console.log(`speech   ${BANNER[state]}`));
  });
}

/**
 * The startup line for each state. `down` cannot appear here — nothing has
 * answered yet at first probe — but the map is total so that adding a state
 * cannot leave the banner silent about it.
 */
const BANNER: Record<SpeechState, string> = {
  absent: `none at ${SIDECAR}; lines will be mouthed in silence (make tts)`,
  loading: `${SIDECAR} (loading its model)`,
  ready: SIDECAR,
  down: `${SIDECAR} (not answering)`,
};

main();
