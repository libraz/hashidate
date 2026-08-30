import { createRequire } from 'node:module';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import {
  inspectSafePath,
  readSafeDirectory,
  readSafePath,
  resolveSafeFile,
  trustedPathSync,
} from '../files';
import { same } from '../i18n/locale';
import type { Deck, DeckTextResponse } from '../protocol';

/**
 * The documents on disk, as the control server finds them.
 *
 * ## A rescan, not a registry
 *
 * The directory is the source of truth and it changes while the server is
 * running: the ordinary case is an operator saving a file three minutes into a
 * broadcast because the segment after this one needs it. A roster built once at
 * startup would answer that with the list from before the file existed, and the
 * operator would have no way to tell a document that is missing from one that is
 * merely not in the list yet. So nothing is registered — the directory is read
 * again, and what is cached is the expensive part rather than the answer.
 *
 * ## A missing directory is an empty list
 *
 * The feature is optional. A server started with no `slides/` at all must behave
 * exactly as it did before there was such a thing, which means an unreadable
 * root is nothing to present rather than something to report.
 *
 * ## Read without drawing anything
 *
 * The page count and the words come from pdf.js in this process, with rendering,
 * font loading and script evaluation all switched off — the server has no canvas
 * and wants none. That is what lets `pages` be known before a document has ever
 * been shown, and what lets an orchestrator ask what a page says before writing
 * a line about it. The library is imported the first time a document is opened,
 * so a server with no documents never pays to load it.
 */

/**
 * What may not be in a document id: the separators, and the control characters.
 *
 * A reject list rather than an accept list, which is the opposite of how the
 * paths in `static.ts` are guarded and is deliberate. An accept list here has to
 * be written in some alphabet, and the first document anybody puts in this
 * directory is called 資料.pdf — under `[A-Za-z0-9._-]` that file is not
 * unusable, which would at least be visible, it is simply never listed. A
 * document nobody can see is worse than one that is refused.
 *
 * What makes that safe is that the reject list is not the guard. The path is
 * still resolved and checked against the root in `path` below, which is what
 * actually stops an id climbing out — this only refuses the spellings that would
 * make the check meaningless.
 */
const FORBIDDEN_IN_ID = /[/\\]|\p{Cc}/u;

/** Long enough for a sentence of a filename, short enough not to be an attack. */
const MAX_ID_LENGTH = 128;

/**
 * Whether a string may name a document.
 *
 * Leading dots are out along with `.` and `..`: a dotfile in this directory is
 * something a tool left behind rather than something an operator saved, and it
 * is the spelling every traversal attempt starts from.
 */
function isId(raw: string): boolean {
  if (raw.length === 0 || raw.length > MAX_ID_LENGTH) return false;
  if (raw.startsWith('.')) return false;
  return !FORBIDDEN_IN_ID.test(raw);
}

/** The extension a document is recognised by, lowercased before comparison. */
const DECK_EXTENSION = '.pdf';

/**
 * How long a scan is reused before the directory is read again.
 *
 * The panel polls the snapshot twice a second and the roster rides on it, so
 * without a floor here every one of those polls would stat the directory and
 * every file in it. A second is under the time it takes an operator to move from
 * the save dialog to the panel, so nothing they do is ever answered with a list
 * that predates it; anything shorter only buys syscalls.
 */
export const DECK_SCAN_FLOOR_SECONDS = 1.0;

/**
 * The most pages one text request may return.
 *
 * The reply is JSON held whole in memory at both ends, and a request with no
 * range on a long document is the easy mistake — a caller that means "the deck"
 * writes nothing rather than a number. Two hundred pages is longer than any deck
 * that gets presented and short enough that the reply stays a reply.
 */
export const DECK_TEXT_MAX_PAGES = 200;

/** The first page, which is also the floor a page counter is clamped at. */
const FIRST_PAGE = 1;

/** What the hub needs of a document store: the last scan, without waiting. */
export interface DeckSource {
  readonly current: Deck[];
}

/**
 * One document as it was last parsed.
 *
 * `key` is the modification time and the size together, which is what says the
 * bytes changed. `text` is null until somebody asks for the words: the scan
 * needs the page count and nothing else, and extracting forty pages of text on
 * the poll that noticed a new file would put that cost on the snapshot.
 */
interface Parsed {
  key: string;
  pages: number;
  text: string[] | null;
}

export class Decks implements DeckSource {
  private readonly root: string;
  private readonly parsed = new Map<string, Parsed>();
  /**
   * Composed id to the name the directory actually holds.
   *
   * The roster composes every id on the way out and the filesystem stores
   * whatever was typed, which for anything outside ASCII is usually decomposed.
   * Keeping what the scan saw is what lets a later lookup ask for the file that
   * is there rather than for the spelling the id was rendered in.
   */
  private paths = new Map<string, string>();
  private decks: Deck[] = [];
  private scannedAt = 0;
  /** The scan in flight, so two callers arriving together read the disk once. */
  private scanning: Promise<Deck[]> | null = null;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * The roster, rescanning if the last one is older than the floor above.
   *
   * What `GET /api/decks` answers with, and what the panel's own refresh button
   * reaches: a caller that asked for the list by name wants the current one.
   */
  list(): Promise<Deck[]> {
    if (Date.now() / 1000 - this.scannedAt < DECK_SCAN_FLOOR_SECONDS) {
      return Promise.resolve(this.decks);
    }
    return this.rescan();
  }

  /**
   * The last completed scan, with a fresh one started if it has gone stale.
   *
   * Synchronous because the thing it feeds is: the snapshot is assembled in one
   * turn and read by a poller that will be back in half a second, so a roster
   * that is one poll behind costs nothing and an awaited snapshot would cost
   * every caller of it. The poll that finds the list stale is the poll that
   * pays for the next one.
   */
  get current(): Deck[] {
    if (Date.now() / 1000 - this.scannedAt >= DECK_SCAN_FLOOR_SECONDS) void this.rescan();
    return this.decks;
  }

  /**
   * Where an id's bytes are, or null for an id that is not one.
   *
   * Both halves of the guard are kept even though the first excludes a
   * separator on its own: `isId` says what an id may be spelled with and the
   * resolve says where it actually landed, and a path guard that trusts a
   * pattern to have thought of every spelling is the one that eventually does
   * not.
   *
   * The last scan answers first, because it is the only thing that knows which
   * spelling the directory holds. A name with a Japanese character in it is
   * decomposed on disk and composed in the URL a browser sends, and the two are
   * the same name everywhere except in a string comparison — macOS looks a path
   * up without regard to the form and hides that, and ext4 compares bytes.
   * Composing the path back out of the id is therefore a guess, kept only for
   * the id that no scan has seen yet, where it is still better than nothing.
   */
  path(id: string): string | null {
    if (!isId(id)) return null;
    const name = id.normalize('NFC');
    const known = this.paths.get(name);
    if (known !== undefined) {
      return trustedPathSync(this.root, known, { extensions: [DECK_EXTENSION] });
    }
    const target = resolve(this.root, `${name}${DECK_EXTENSION}`);
    return trustedPathSync(this.root, target, { extensions: [DECK_EXTENSION] });
  }

  /**
   * Where an id's bytes are, reading the directory again if the last scan had
   * no such id.
   *
   * The asynchronous half of `path`, and the one every caller that can wait
   * should use. A document saved a moment ago is not in the last scan, and a
   * guessed path is exactly the case that resolves to a file which is not there
   * on the machine a broadcast runs on — so the miss is answered by looking
   * rather than by spelling.
   */
  async file(id: string): Promise<string | null> {
    if (!isId(id)) return null;
    const found = await resolveSafeFile(this.root, id, {
      extensions: [DECK_EXTENSION],
      logical: true,
      maxIdLength: MAX_ID_LENGTH,
    });
    return found.ok ? found.path : null;
  }

  /**
   * What a document says, page by page, or null for one that is not there.
   *
   * The range is clamped rather than refused, on the same rule the `slide`
   * command follows: a caller that asked for page 90 of an 80 page deck has made
   * an ordinary mistake and meant the end of it. Every page in the resulting
   * span is present in `text`, including the empty string for a page that is all
   * picture — a gap would be indistinguishable from a page that was not asked
   * for, and the caller counting entries against `from` would be reading the
   * wrong page's words.
   */
  async text(id: string, from?: number, to?: number): Promise<DeckTextResponse | null> {
    const target = await this.file(id);
    if (target === null) return null;
    const info = await inspectSafePath(this.root, relative(this.root, target), {
      extensions: [DECK_EXTENSION],
      allowNested: true,
    });
    if (!(info.ok && info.info.isFile())) return null;

    const parsed = await this.open(target, key(info.info), { withText: true });
    if (parsed.pages === 0) return { id, pages: 0, from: FIRST_PAGE, text: [] };

    const first = clamp(from ?? FIRST_PAGE, FIRST_PAGE, parsed.pages);
    const last = Math.min(
      clamp(to ?? parsed.pages, first, parsed.pages),
      first + DECK_TEXT_MAX_PAGES - 1,
    );
    return {
      id,
      pages: parsed.pages,
      from: first,
      text: (parsed.text ?? []).slice(first - 1, last),
    };
  }

  /** Read the directory and rebuild the roster from it. */
  private rescan(): Promise<Deck[]> {
    this.scanning ??= this.scan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async scan(): Promise<Deck[]> {
    // No directory is no documents. See the module docstring: the feature is
    // optional, and a server started without one is not a server in trouble.
    const names = (await readSafeDirectory(this.root)) ?? [];
    const found: Deck[] = [];
    const live = new Set<string>();
    const paths = new Map<string, string>();
    const candidates = new Map<string, string[]>();
    for (const name of names) {
      if (extname(name).toLowerCase() !== DECK_EXTENSION) continue;
      // Composed, because this is the form that goes out on the wire and comes
      // back in a URL. The directory hands back whatever the filesystem stored,
      // which on this one is decomposed for anything outside ASCII.
      const id = basename(name, extname(name)).normalize('NFC');
      if (!isId(id)) continue;
      candidates.set(id, [...(candidates.get(id) ?? []), name]);
    }
    for (const [id, matching] of candidates) {
      // There is no error channel in the deck roster. Refusing the whole
      // normalized group is safer than making one of two visually identical
      // documents win by directory order.
      if (matching.length > 1) continue;
      const name = matching[0];
      // The entry as the directory spells it, and not as `path` would spell it
      // back out of the id. Composing it again asks for a name the directory
      // may not hold, which macOS answers anyway and Linux does not — and the
      // document then fails to appear in its own roster, which the module
      // docstring above says is the worst way for it to fail.
      const resolved = await resolveSafeFile(this.root, name, {
        extensions: [DECK_EXTENSION],
        maxIdLength: MAX_ID_LENGTH,
      });
      if (!resolved.ok) continue;
      const target = resolved.path;
      const info = resolved.info;
      live.add(target);
      paths.set(id, target);
      // A file that will not parse is listed with no pages rather than dropped.
      // The operator put it there and needs to see that it arrived and that it
      // is broken; a document that silently does not appear reads as a name
      // typed wrong, which is the one thing it is not.
      const parsed = await this.open(target, key(info), { withText: false });
      found.push({
        id,
        // The filename, which is the same string in either language, composed to
        // match the id beside it rather than left in whichever form the disk
        // happened to hold.
        label: same(name.normalize('NFC')),
        pages: parsed.pages,
        bytes: info.size,
        at: info.mtimeMs / 1000,
      });
    }
    // Newest first: the document an operator is about to reach for is almost
    // always the one they just saved. Ties fall back to the name so that two
    // files written in the same millisecond do not swap places between polls.
    found.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
    for (const path of this.parsed.keys()) if (!live.has(path)) this.parsed.delete(path);
    this.paths = paths;
    this.decks = found;
    this.scannedAt = Date.now() / 1000;
    return found;
  }

  /**
   * Page count, and the words if they are wanted, cached against the bytes.
   *
   * Keyed on modification time and size rather than on the path alone, so a
   * document replaced under the same name is re-read and one that has not
   * changed is never parsed twice — which is the whole reason polling the
   * snapshot twice a second is affordable.
   */
  private async open(path: string, cacheKey: string, { withText = false } = {}): Promise<Parsed> {
    const cached = this.parsed.get(path);
    if (cached?.key === cacheKey && (!withText || cached.text !== null)) return cached;

    const parsed: Parsed = { key: cacheKey, pages: 0, text: withText ? [] : null };
    try {
      const pdfjs = await load();
      const loaded = await readSafePath(this.root, path, { extensions: [DECK_EXTENSION] });
      if (!loaded.ok) throw new Error(loaded.error);
      const data = new Uint8Array(loaded.bytes);
      // Nothing is drawn and nothing is installed: this process has no canvas
      // and no document to add a font face to, and a document is a file that
      // arrived from outside. Only the metrics for the base-14 fonts are read,
      // which is what text extraction needs and all it needs.
      const task = pdfjs.getDocument({
        data,
        disableFontFace: true,
        useSystemFonts: false,
        standardFontDataUrl: standardFonts(),
      });
      try {
        const document = await task.promise;
        parsed.pages = document.numPages;
        if (withText) parsed.text = await words(document);
      } finally {
        // The loading task owns the worker; the document does not have a
        // `destroy` of its own. Leaving the task open leaks one per parse, which
        // on a directory that is rescanned every second is every second.
        await task.destroy();
      }
    } catch {
      // Listed with no pages. See the call in `scan`.
      parsed.pages = 0;
      parsed.text = withText ? [] : null;
    }
    this.parsed.set(path, parsed);
    return parsed;
  }
}

/** Every page's text, in order, with an entry for a page that has none. */
async function words(document: PdfDocument): Promise<string[]> {
  const out: string[] = [];
  for (let page = FIRST_PAGE; page <= document.numPages; page++) {
    const content = await (await document.getPage(page)).getTextContent();
    out.push(
      content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('')
        .trim(),
    );
  }
  return out;
}

/** The bytes' identity: changed either of these and it is a different document. */
function key(info: { mtimeMs: number; size: number }): string {
  return `${info.mtimeMs}:${info.size}`;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type PdfDocument = Awaited<ReturnType<Pdfjs['getDocument']>['promise']>;

let pdfjs: Promise<Pdfjs> | null = null;

/**
 * pdf.js, loaded once and only if a document is actually opened.
 *
 * The legacy build rather than the default one because this runs in Node: the
 * modern build reaches for browser APIs the server does not have.
 */
function load(): Promise<Pdfjs> {
  pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

let fonts: string | undefined;

/**
 * Where the base-14 font metrics are, which pdf.js needs to extract text from a
 * document that assumed Helvetica would simply be there. Resolved off the
 * package rather than hardcoded, and left undefined if it cannot be found —
 * missing it costs a warning and some inaccuracy, not the parse.
 */
function standardFonts(): string | undefined {
  if (fonts === undefined) {
    try {
      const pkg = createRequire(import.meta.url).resolve('pdfjs-dist/package.json');
      fonts = `${join(dirname(pkg), 'standard_fonts')}${sep}`;
    } catch {
      fonts = '';
    }
  }
  return fonts === '' ? undefined : fonts;
}
