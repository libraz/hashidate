// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetLocale, setLocale } from '@/i18n';
import { PresetPicker, type PresetPickerGroup, type PresetPickerItem } from '@/ui/PresetPicker';

interface Item extends PresetPickerItem {
  held?: boolean;
}

const groups: PresetPickerGroup<Item>[] = [
  {
    key: 'affection',
    label: { en: 'Affection', ja: '愛情' },
    items: [
      { id: 'heartHands', label: { en: 'Hand heart', ja: '両手ハート' }, held: false },
      { id: 'blowKiss', label: { en: 'Blow a kiss', ja: '投げキッス' }, held: true },
    ],
  },
  {
    key: 'photo',
    label: { en: 'Photo pose', ja: '撮影ポーズ' },
    items: [{ id: 'flowerPose', label: { en: 'Flower pose', ja: 'おはなポーズ' } }],
  },
  {
    key: 'dance',
    label: { en: 'Dance', ja: 'ダンス' },
    items: [{ id: 'tinyDance', label: { en: 'Little dance', ja: 'ちょこっとダンス' } }],
  },
];

const itemText = (item: Item): string => `${item.label.en}${item.held ? ' *' : ''}`;

describe('PresetPicker', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  const mount = async (items: PresetPickerGroup<Item>[] = groups, activeId?: string | null) => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        createElement(PresetPicker, {
          groups: items,
          activeId,
          renderItem: (item: Item) =>
            createElement(
              'button',
              {
                type: 'button',
                'data-preset': item.id,
                'data-held': item.held ? 'true' : 'false',
              },
              itemText(item),
            ),
        }),
      );
    });
  };

  const rerender = async (items: PresetPickerGroup<Item>[]) => {
    await act(async () => {
      root?.render(
        createElement(PresetPicker, {
          groups: items,
          renderItem: (item: Item) =>
            createElement(
              'button',
              {
                type: 'button',
                'data-preset': item.id,
                'data-held': item.held ? 'true' : 'false',
              },
              itemText(item),
            ),
        }),
      );
    });
  };

  const search = async (value: string) => {
    const input = host?.querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const presetIds = (): string[] =>
    [...(host?.querySelectorAll('[data-preset]') ?? [])].map((node) =>
      node.getAttribute('data-preset'),
    ) as string[];

  const element = <T extends Element>(selector: string): T => {
    const found = host?.querySelector(selector);
    if (!found) throw new Error(`Missing ${selector}`);
    return found as T;
  };

  beforeEach(() => {
    setLocale('en');
  });

  afterEach(() => {
    if (root !== null) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    setLocale('en');
    resetLocale();
  });

  it('shows one selected group and marks the active group', async () => {
    await mount(groups, 'flowerPose');

    const groupButtons = [...(host?.querySelectorAll('[role="group"] > button') ?? [])];
    expect(groupButtons).toHaveLength(3);
    expect(groupButtons[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(groupButtons[1]?.getAttribute('data-active')).toBe('true');
    expect(presetIds()).toEqual(['heartHands', 'blowKiss']);
    expect(host?.querySelector('[data-preset="blowKiss"]')?.getAttribute('data-held')).toBe('true');
    expect(host?.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it('clears search when a group is chosen and restores that group when search is cleared', async () => {
    await mount();
    const groupButtons = [...(host?.querySelectorAll('[role="group"] > button') ?? [])];

    await act(async () => {
      (groupButtons[1] as HTMLButtonElement).click();
    });
    expect(presetIds()).toEqual(['flowerPose']);

    await search('heart');
    expect(presetIds()).toEqual(['heartHands']);
    const input = element<HTMLInputElement>('input[type="search"]');
    expect(input.value).toBe('heart');

    await act(async () => {
      element<HTMLButtonElement>('[aria-label="Clear search"]').click();
    });
    expect(input.value).toBe('');
    expect(presetIds()).toEqual(['flowerPose']);

    await search('heart');
    await act(async () => {
      (groupButtons[2] as HTMLButtonElement).click();
    });
    expect(input.value).toBe('');
    expect(presetIds()).toEqual(['tinyDance']);
  });

  it('searches every group by id and either localized label, without case sensitivity', async () => {
    await mount();

    await search('BLOWKISS');
    expect(presetIds()).toEqual(['blowKiss']);
    await search('おはなポーズ');
    expect(presetIds()).toEqual(['flowerPose']);
    await act(async () => setLocale('ja'));
    await search('LITTLE DANCE');
    expect(presetIds()).toEqual(['tinyDance']);
    expect(host?.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(
      'プリセットのグループ',
    );
  });

  it('keeps an empty result area and falls back when the selected group disappears', async () => {
    await mount();
    const groupButtons = [...(host?.querySelectorAll('[role="group"] > button') ?? [])];
    await act(async () => {
      (groupButtons[1] as HTMLButtonElement).click();
    });
    await search('missing');
    const result = host?.querySelector('[aria-live="polite"]');
    expect(result?.textContent).toContain('No presets found');
    const resultClass = result?.className;

    await rerender([
      {
        key: 'affection',
        label: { en: 'Affection', ja: '愛情' },
        items: groups[0]?.items ?? [],
      },
      {
        key: 'photo',
        label: { en: 'Photo pose', ja: '撮影ポーズ' },
        items: [],
      },
    ]);
    expect(host?.querySelector('[role="group"] > button')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(host?.querySelector('[aria-live="polite"]')?.className).toBe(resultClass);
    await search('');
    expect(presetIds()).toEqual(['heartHands', 'blowKiss']);
    await rerender([]);
    expect(presetIds()).toEqual([]);
    expect(host?.querySelector('[aria-live="polite"]')?.textContent).toContain('No presets found');
    await rerender(groups);
    expect(presetIds()).toEqual(['heartHands', 'blowKiss']);
  });
});
