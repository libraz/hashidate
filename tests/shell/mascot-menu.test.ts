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
};

function handlers(): MascotMenuHandlers {
  return {
    setVisible: vi.fn(),
    setMode: vi.fn(),
    stepScale: vi.fn(),
    setAvatar: vi.fn(),
    setOutfit: vi.fn(),
    setMuted: vi.fn(),
    faceFront: vi.fn(),
    resetPosition: vi.fn(),
    quit: vi.fn(),
  };
}

describe('the right-click menu', () => {
  it('lists mode, size, outfit, a rule, then face front, reset position and hide', () => {
    const items = contextMenu(model, handlers(), 'en');
    expect(items.map((item) => item.label ?? item.type)).toEqual([
      'Display Mode',
      'Size',
      'Outfit',
      'separator',
      'Face Front',
      'Reset Position',
      'Hide',
    ]);
  });

  it('is labelled in Japanese too', () => {
    const items = contextMenu(model, handlers(), 'ja');
    expect(items.map((item) => item.label ?? item.type).slice(3)).toEqual([
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

describe('the tray menu', () => {
  it('has no face-front entry', () => {
    const labels = trayMenu(model, handlers(), 'en').map((item) => item.label);
    expect(labels).not.toContain('Face Front');
  });
});
