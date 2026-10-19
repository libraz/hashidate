// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '@/i18n';
import { pageOptions, ScriptPicker } from '@/panel/script/ScriptPicker';
import type { QueueEntry, ScriptSummary } from '@/protocol';

const api = vi.hoisted(() => ({
  readScripts: vi.fn(),
  runScript: vi.fn(),
}));

vi.mock('@/panel/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/panel/api')>();
  return { ...actual, ...api };
});

/**
 * Loading a script from a page part-way through: the picker offers the pages
 * the server found, and the run it sends names the line that page starts on.
 */

const summary = (id: string, pages: ScriptSummary['pages']): ScriptSummary => ({
  id,
  lines: 10,
  setup: 1,
  bytes: 100,
  at: 1_800_000_000,
  ...(pages === undefined ? {} : { pages }),
});

const TALK = summary('talk', [
  { line: 0, deck: 'talk', page: 1 },
  { line: 4, deck: 'talk', page: 2 },
  { line: 7, deck: 'talk', page: 3 },
]);
const PLAIN = summary('plain', undefined);
const OTHER = summary('other', [{ line: 2, deck: 'other', page: 5 }]);

describe('ScriptPicker from a page', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    setLocale('en');
    api.runScript.mockResolvedValue({ queue: [], viewers: 1, setupFates: [] });
  });

  afterEach(() => {
    if (root !== null) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.clearAllMocks();
  });

  const mount = async (scripts: ScriptSummary[], entries: QueueEntry[] = []) => {
    api.readScripts.mockResolvedValue({ scripts, errors: [] });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(ScriptPicker, { entries, refresh: () => {} }));
      await Promise.resolve();
    });
    return host;
  };

  const select = (where: HTMLElement, label: string): HTMLSelectElement => {
    const found = where.querySelector(`select[aria-label="${label}"]`);
    if (!(found instanceof HTMLSelectElement)) throw new Error(`no select ${label}`);
    return found;
  };

  const choose = async (field: HTMLSelectElement, value: string) => {
    await act(async () => {
      field.value = value;
      field.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  const run = (where: HTMLElement): HTMLButtonElement => {
    const found = [...where.querySelectorAll('button')].find(
      (b) => b.textContent === 'Read from here',
    );
    if (!found) throw new Error('no run button');
    return found;
  };

  it('offers only scripts that have pages, and sends the line the chosen page starts on', async () => {
    const where = await mount([PLAIN, TALK]);
    const scripts = select(where, 'The script to start part-way through');
    expect([...scripts.options].map((option) => option.value)).toEqual(['talk']);
    const pages = select(where, 'The page to start from');
    expect([...pages.options].map((option) => option.textContent)).toEqual(['p.1', 'p.2', 'p.3']);

    await choose(pages, '2');
    await act(async () => {
      run(where).click();
    });
    expect(api.runScript).toHaveBeenCalledWith('talk', { pause: true, from: 7 });
  });

  it('starts from the script whose lines are up, and from its first page when switched', async () => {
    const queued: QueueEntry[] = [{ id: 'q1', text: 'あ', at: 1, source: 'other' }];
    const where = await mount([TALK, OTHER], queued);
    expect(select(where, 'The script to start part-way through').value).toBe('other');

    await choose(select(where, 'The script to start part-way through'), 'talk');
    await choose(select(where, 'The page to start from'), '1');
    await choose(select(where, 'The script to start part-way through'), 'other');
    expect(select(where, 'The page to start from').value).toBe('0');
  });

  it('is not shown when no script has a page', async () => {
    const where = await mount([PLAIN]);
    expect(where.querySelector('select[aria-label="The page to start from"]')).toBeNull();
  });
});

describe('pageOptions', () => {
  it('names the document only when a script moves between more than one', () => {
    expect(pageOptions([{ line: 0, deck: 'a', page: 1 }]).map((o) => o.label)).toEqual(['p.1']);
    expect(
      pageOptions([
        { line: 0, deck: 'a', page: 1 },
        { line: 3, deck: 'b', page: 2 },
      ]).map((o) => o.label),
    ).toEqual(['a p.1', 'b p.2']);
  });
});
