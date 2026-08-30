import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { same } from '@/i18n/locale';
import { DECK_SCAN_FLOOR_SECONDS, Decks } from '@/server/decks';

/**
 * The directory of documents, read as the control server reads it.
 *
 * Real bytes throughout: what is being tested is that a file on disk is opened
 * and understood, and a stubbed parser would test the stub. The documents are
 * assembled here rather than committed — nothing large may enter git, and a
 * fixture is exactly the kind of thing that starts small.
 *
 * The clock is real for the same reason. The scan floor is the one piece of
 * behaviour here that is time-bound, and it is short enough to reason about by
 * writing a file and looking again.
 */

let root: string;
let decks: Decks;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hashidate-decks-'));
  decks = new Decks(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Assemble a small but complete PDF, one line of text per page.
 *
 * An entry of `''` is a page with an empty content stream, which is what a page
 * that is all picture looks like to a text extractor.
 */
function pdf(pages: string[]): Buffer {
  const pageIds = pages.map((_, index) => 3 + index * 2);
  const fontId = 3 + pages.length * 2;
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  ];
  for (const [index, text] of pages.entries()) {
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200]` +
        ` /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${pageIds[index] + 1} 0 R >>`,
    );
    const stream = text === '' ? '' : `BT /F1 24 Tf 20 100 Td (${text}) Tj ET`;
    bodies.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  bodies.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, body] of bodies.entries()) {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const startxref = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Write one document into the directory under test. */
async function write(name: string, pages: string[]): Promise<string> {
  const path = join(root, name);
  await writeFile(path, pdf(pages));
  return path;
}

describe('scanning the directory', () => {
  it('lists a document with the page count read out of the file', async () => {
    await write('intro.pdf', ['One', 'Two', 'Three']);
    const [deck] = await decks.list();
    // Counted without rasterising anything, so it is known before the document
    // has ever been shown.
    expect(deck).toMatchObject({ id: 'intro', label: same('intro.pdf'), pages: 3 });
    expect(deck.bytes).toBeGreaterThan(0);
    expect(deck.at).toBeGreaterThan(0);
  });

  it('sees a document saved after the server started', async () => {
    expect(await decks.list()).toEqual([]);
    await write('late.pdf', ['One']);
    await new Promise((done) => setTimeout(done, DECK_SCAN_FLOOR_SECONDS * 1000));
    // The directory is the source of truth and it changes mid-broadcast. A
    // roster built once at startup would answer with the list from before.
    expect((await decks.list()).map((deck) => deck.id)).toEqual(['late']);
  });

  it('orders the newest first, because that is the one about to be reached for', async () => {
    await write('old.pdf', ['One']);
    await write('new.pdf', ['One']);
    await utimes(join(root, 'old.pdf'), new Date(1_000_000), new Date(1_000_000));
    expect((await decks.list()).map((deck) => deck.id)).toEqual(['new', 'old']);
  });

  it('ignores anything that is not a document', async () => {
    await write('deck.pdf', ['One']);
    await writeFile(join(root, 'notes.txt'), 'not a document');
    expect((await decks.list()).map((deck) => deck.id)).toEqual(['deck']);
  });

  it('is empty for a directory that is not there, rather than an error', async () => {
    // The feature is optional: a server started without slides must behave
    // exactly as it did before there was such a thing.
    const missing = new Decks(join(root, 'nowhere'));
    expect(await missing.list()).toEqual([]);
    expect(missing.current).toEqual([]);
  });

  it('lists a file that will not parse with no pages rather than dropping it', async () => {
    await writeFile(join(root, 'broken.pdf'), 'this is not a PDF at all');
    // The operator put it there and needs to see that it arrived and is broken.
    // A document that silently does not appear reads as a name typed wrong.
    expect(await decks.list()).toMatchObject([{ id: 'broken', pages: 0 }]);
  });

  it('lists a document whose name is not written in ASCII', async () => {
    // The first document anybody puts in this directory is called 資料.pdf. An
    // id alphabet that leaves it out does not make it unusable, which would at
    // least be visible — it makes it invisible.
    await write('日本語.pdf', ['One']);
    await write('fine.pdf', ['One']);
    expect((await decks.list()).map((deck) => deck.id).sort()).toEqual(['fine', '日本語']);
  });

  it('leaves a name that could not be sent back as an id out of the list', async () => {
    await write('.hidden.pdf', ['One']);
    await write('fine.pdf', ['One']);
    expect((await decks.list()).map((deck) => deck.id)).toEqual(['fine']);
  });
});

describe('the cached scan', () => {
  it('reuses a scan inside the floor and reads again past it', async () => {
    await write('one.pdf', ['One']);
    expect(await decks.list()).toHaveLength(1);

    await write('two.pdf', ['One']);
    // Twice a second, the panel asks. Statting the directory on every one of
    // those is what the floor is for.
    expect(await decks.list()).toHaveLength(1);

    await new Promise((done) => setTimeout(done, DECK_SCAN_FLOOR_SECONDS * 1000));
    expect(await decks.list()).toHaveLength(2);
  });

  it('answers current without waiting, with the last completed scan', async () => {
    await write('intro.pdf', ['One']);
    // Nothing has been scanned yet, so the first synchronous read is empty and
    // is what starts the scan the next one will see.
    expect(decks.current).toEqual([]);
    await decks.list();
    expect(decks.current.map((deck) => deck.id)).toEqual(['intro']);
  });

  it('re-reads a document that was replaced under the same name', async () => {
    await write('intro.pdf', ['One']);
    expect((await decks.list())[0].pages).toBe(1);

    await write('intro.pdf', ['One', 'Two', 'Three']);
    await new Promise((done) => setTimeout(done, DECK_SCAN_FLOOR_SECONDS * 1000));
    // Cached against the bytes rather than the path: fixing a typo and saving
    // over a document has to be visible on the next turn of the page.
    expect((await decks.list())[0].pages).toBe(3);
  });
});

describe('the id guard', () => {
  it.each([
    ['../secret', 'a path that climbs out of the root'],
    ['../../etc/passwd', 'a path that climbs several'],
    ['..%2Fsecret', 'a separator spelled as an escape'],
    ['sub/deck', 'a separator'],
    ['..', 'the one spelling every climb starts from'],
    ['.hidden', 'a dotfile, which is something a tool left rather than a document'],
    ['deck\u0000x', 'a control character, which no filename carries by accident'],
    ['', 'nothing at all'],
    ['x'.repeat(129), 'a name longer than an id may be'],
  ])('refuses %j, which is %s', (id) => {
    expect(decks.path(id)).toBeNull();
  });

  it('resolves an ordinary id to a file inside the root', () => {
    expect(decks.path('intro')).toBe(join(root, 'intro.pdf'));
  });

  it.each([
    ['資料', 'ordinary Japanese'],
    ['第 3 回 まとめ', 'spaces and digits'],
    ['q&a?', 'characters that have to be escaped in a URL but not in a filename'],
  ])('resolves %j inside the root, which is %s', (id) => {
    // Anything a filesystem accepts is a document name. What a URL makes of it
    // is the client's problem and is solved there, by escaping it.
    expect(decks.path(id)).toBe(join(root, `${id}.pdf`));
  });

  it('composes an id before resolving it, so a decomposed name still opens', () => {
    // A Japanese name is stored decomposed on this filesystem and arrives
    // composed in a URL. They are the same name everywhere except in a string
    // comparison, which is the one place this would notice.
    expect(decks.path('が'.normalize('NFD'))).toBe(join(root, `${'が'.normalize('NFC')}.pdf`));
  });

  it('answers no text for an id the guard refused', async () => {
    await write('intro.pdf', ['One']);
    expect(await decks.text('../intro')).toBeNull();
  });

  it('answers no text for an id with no file behind it', async () => {
    expect(await decks.text('absent')).toBeNull();
  });
});

describe('reading the words', () => {
  it('returns one entry per page, in order', async () => {
    await write('intro.pdf', ['One', 'Two', 'Three']);
    expect(await decks.text('intro')).toEqual({
      id: 'intro',
      pages: 3,
      from: 1,
      text: ['One', 'Two', 'Three'],
    });
  });

  it('keeps the empty string for a page with nothing on it', async () => {
    await write('intro.pdf', ['One', '', 'Three']);
    const found = await decks.text('intro');
    // A gap would be indistinguishable from a page that was not asked for, and
    // the caller counting entries against `from` would read the wrong page.
    expect(found?.text).toEqual(['One', '', 'Three']);
  });

  it('returns the range asked for and says where it starts', async () => {
    await write('intro.pdf', ['One', 'Two', 'Three', 'Four']);
    expect(await decks.text('intro', 2, 3)).toMatchObject({
      pages: 4,
      from: 2,
      text: ['Two', 'Three'],
    });
  });

  it('clamps a range past the end rather than refusing it', async () => {
    await write('intro.pdf', ['One', 'Two']);
    // The same rule the `slide` command follows: a caller that asked for page 90
    // of an 80 page deck meant the end of it.
    expect(await decks.text('intro', 2, 99)).toMatchObject({ from: 2, text: ['Two'] });
    expect(await decks.text('intro', 0)).toMatchObject({ from: 1, text: ['One', 'Two'] });
  });

  it('reports a document it cannot parse as having no pages and no words', async () => {
    await writeFile(join(root, 'broken.pdf'), 'this is not a PDF at all');
    expect(await decks.text('broken')).toEqual({ id: 'broken', pages: 0, from: 1, text: [] });
  });

  it('lists and opens a name that is decomposed on disk and composed in the id', async () => {
    // The filesystem stores this decomposed and every surface downstream of the
    // roster composes it — the URL a browser sends most of all. They are one
    // name except in a string comparison.
    const onDisk = await write('資料ダ.pdf'.normalize('NFD'), ['One', 'Two']);
    const [deck] = await decks.list();
    expect(deck?.id).toBe('資料ダ'.normalize('NFC'));
    expect(deck?.pages).toBe(2);

    // The path is asserted rather than only the lookup succeeding, because the
    // two come apart per platform: a lookup on macOS ignores the normalisation
    // form, so a path composed back out of the id opens there and opens nothing
    // on Linux. Pinning the name the directory holds fails on both.
    expect(await decks.file('資料ダ'.normalize('NFC'))).toBe(onDisk);
    expect(decks.path('資料ダ'.normalize('NFC'))).toBe(onDisk);
    expect(await decks.text('資料ダ'.normalize('NFC'))).toMatchObject({ text: ['One', 'Two'] });
  });
});
