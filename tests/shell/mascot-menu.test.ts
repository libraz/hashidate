import { describe, expect, it, vi } from 'vitest';
import {
  contextMenu,
  type MascotMenuHandlers,
  type MascotMenuModel,
  trayMenu,
} from '@/mascot/menu';

/**
 * The two menus as templates: what is in them, in what order, and what a click does.
 */

const model: MascotMenuModel = {
  state: { mode: 'bottom-right', scale: 0.5, muted: false },
  visible: true,
  avatars: [],
  avatar: null,
  outfits: [],
  accessories: [],
};

function handlers(): MascotMenuHandlers {
  return {
    setVisible: vi.fn(),
    setMode: vi.fn(),
    stepScale: vi.fn(),
    setAvatar: vi.fn(),
    setOutfit: vi.fn(),
    setAccessory: vi.fn(),
    setMuted: vi.fn(),
    faceFront: vi.fn(),
    resetPosition: vi.fn(),
    quit: vi.fn(),
  };
}

describe('the right-click menu', () => {
  describe('the size steps', () => {
    const enabled = (state: MascotMenuModel['state']) => {
      const size = contextMenu({ ...model, state }, handlers(), 'en').find(
        (item) => item.label === 'Size',
      );
      const submenu = (size?.submenu ?? []) as { label: string; enabled?: boolean }[];
      return Object.fromEntries(submenu.map((item) => [item.label, item.enabled]));
    };
    const at = (mode: MascotMenuModel['state']['mode'], scale: number) => ({
      mode,
      scale,
      muted: false,
    });

    it('opens both from the full height', () => {
      expect(enabled(at('full', 1))).toEqual({ Larger: true, Smaller: true });
    });

    it('opens larger up to 2 and smaller down to 0.25', () => {
      expect(enabled(at('bottom-right', 1.95))).toEqual({ Larger: true, Smaller: true });
      expect(enabled(at('bottom-right', 2))).toEqual({ Larger: false, Smaller: true });
      expect(enabled(at('free', 0.25))).toEqual({ Larger: true, Smaller: false });
    });
  });

  it('lists mode, size, outfit, accessories, a rule, then face front, reset position and hide', () => {
    const items = contextMenu(model, handlers(), 'en');
    expect(items.map((item) => item.label ?? item.type)).toEqual([
      'Display Mode',
      'Size',
      'Outfit',
      'Accessories',
      'separator',
      'Face Front',
      'Reset Position',
      'Hide',
    ]);
  });

  it('is labelled in Japanese too', () => {
    const items = contextMenu(model, handlers(), 'ja');
    expect(items.map((item) => item.label ?? item.type).slice(4)).toEqual([
      'separator',
      '正面を向く',
      '位置を戻す',
      '隠す',
    ]);
  });

  it('turns the character front on click and does nothing else', () => {
    const calls = handlers();
    const item = contextMenu(model, calls, 'en').find((entry) => entry.label === 'Face Front');
    item?.click?.({} as never, undefined, {} as never);
    expect(calls.faceFront).toHaveBeenCalledTimes(1);
    expect(calls.resetPosition).not.toHaveBeenCalled();
    expect(calls.setVisible).not.toHaveBeenCalled();
  });
});

describe('the accessories submenu', () => {
  type Entry = {
    label?: string;
    type?: string;
    checked?: boolean;
    enabled?: boolean;
    submenu?: Entry[];
    click?: (...args: never[]) => void;
  };
  const left = (id: string, worn: string | null | undefined, items: string[]) => ({
    id,
    label: { en: id.toUpperCase(), ja: id },
    items: items.map((item) => ({ id: item, label: { en: item, ja: item } })),
    worn,
  });
  const submenu = (accessories: MascotMenuModel['accessories'], calls = handlers()): Entry[] => {
    const entry = contextMenu({ ...model, accessories }, calls, 'en').find(
      (item) => item.label === 'Accessories',
    ) as Entry;
    return entry.submenu ?? [];
  };
  const click = (entry: Entry | undefined) => entry?.click?.({} as never);

  it('is one greyed line when the avatar has none', () => {
    expect(submenu([])).toEqual([{ label: 'No accessories', enabled: false }]);
  });

  it('is labelled in Japanese', () => {
    const items = contextMenu(model, handlers(), 'ja');
    expect(items[3].label).toBe('アクセサリー');
    const [none] = items[3].submenu as Entry[];
    expect(none.label).toBe('アクセサリーなし');
  });

  it('gives a one-item slot a checkbox that puts the piece on and takes it off', () => {
    const calls = handlers();
    const worn = submenu([left('hat', 'cap', ['cap'])], calls);
    expect(worn).toHaveLength(1);
    expect(worn[0]).toMatchObject({ label: 'HAT', type: 'checkbox', checked: true });
    click(worn[0]);
    expect(calls.setAccessory).toHaveBeenLastCalledWith('hat', null);

    const bare = submenu([left('hat', null, ['cap'])], calls);
    expect(bare[0]).toMatchObject({ type: 'checkbox', checked: false });
    click(bare[0]);
    expect(calls.setAccessory).toHaveBeenLastCalledWith('hat', 'cap');
  });

  it('makes a one-item slot a plain item that puts it on when what is worn is unknown', () => {
    const calls = handlers();
    const [entry] = submenu([left('hat', undefined, ['cap'])], calls);
    expect(entry.label).toBe('HAT');
    expect(entry.type).toBeUndefined();
    expect(entry.checked).toBeUndefined();
    click(entry);
    expect(calls.setAccessory).toHaveBeenCalledWith('hat', 'cap');
  });

  it('gives a many-item slot a submenu of None and a radio per item', () => {
    const calls = handlers();
    const [entry] = submenu([left('tail', 'fox', ['fox', 'cat'])], calls);
    expect(entry.label).toBe('TAIL');
    const radios = entry.submenu ?? [];
    expect(radios.map((r) => [r.label, r.type, r.checked])).toEqual([
      ['None', 'radio', false],
      ['fox', 'radio', true],
      ['cat', 'radio', false],
    ]);
    click(radios[0]);
    expect(calls.setAccessory).toHaveBeenLastCalledWith('tail', null);
    click(radios[2]);
    expect(calls.setAccessory).toHaveBeenLastCalledWith('tail', 'cat');
  });

  it('keeps each many-item slot in a submenu of its own', () => {
    const entries = submenu([left('tail', 'fox', ['fox', 'cat']), left('head', null, ['a', 'b'])]);
    expect(entries.map((e) => e.label)).toEqual(['TAIL', 'HEAD']);
    expect(entries.every((e) => Array.isArray(e.submenu))).toBe(true);
  });

  it('checks None when what is worn is known but not among the items', () => {
    const [entry] = submenu([left('tail', 'gone', ['fox', 'cat'])]);
    expect((entry.submenu ?? []).map((r) => r.checked)).toEqual([true, false, false]);
  });

  it('checks nothing when what is worn is unknown', () => {
    const [entry] = submenu([left('tail', undefined, ['fox', 'cat'])]);
    for (const radio of entry.submenu ?? []) {
      expect(radio.type).toBeUndefined();
      expect(radio.checked).toBeUndefined();
    }
  });
});

describe('the tray menu', () => {
  it('has no face-front entry', () => {
    const labels = trayMenu(model, handlers(), 'en').map((item) => item.label);
    expect(labels).not.toContain('Face Front');
  });
});
