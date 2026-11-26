import type { MenuItemConstructorOptions } from 'electron';
import { getLocale, type Locale, pick } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { translate } from '../i18n/translate';
import type { LabelledId } from '../protocol';
import {
  MASCOT_MODES,
  MASCOT_SCALE_MAX,
  MASCOT_SCALE_MIN,
  type MascotMode,
  type MascotState,
} from '../shell/state';

/**
 * The mascot's two menus, as templates.
 *
 * The tray is where the mascot is switched on and off as a whole — shown,
 * silenced, quit — and the right-click on the character is where it is
 * arranged. How it is placed and how large it is are in both, because the tray
 * is the only one of the two that can still be reached when the character is
 * somewhere it cannot be clicked.
 *
 * Templates rather than menus so they are built without Electron; `main.ts`
 * turns them into native ones each time one is opened.
 */

/** What the menus show as current. */
export interface MascotMenuModel {
  state: MascotState;
  visible: boolean;
  /** What the renderer can load, and which of them it is showing. */
  avatars: readonly LabelledId[];
  avatar: string | null;
  /** The whole outfits the avatar on screen can be put in. */
  outfits: readonly LabelledId[];
}

export interface MascotMenuHandlers {
  setVisible(visible: boolean): void;
  setMode(mode: MascotMode): void;
  stepScale(dir: 1 | -1): void;
  setAvatar(id: string): void;
  setOutfit(id: string): void;
  setMuted(muted: boolean): void;
  faceFront(): void;
  resetPosition(): void;
  quit(): void;
}

const MODE_LABEL: Record<MascotMode, MessageKey> = {
  full: 'mascot.mode.full',
  'bottom-right': 'mascot.mode.bottomRight',
  'bottom-left': 'mascot.mode.bottomLeft',
  free: 'mascot.mode.free',
};

type Item = MenuItemConstructorOptions;

function modeItem({ state }: MascotMenuModel, handlers: MascotMenuHandlers, locale: Locale): Item {
  return {
    label: translate('mascot.mode', locale),
    submenu: MASCOT_MODES.map((mode) => ({
      label: translate(MODE_LABEL[mode], locale),
      type: 'radio',
      checked: state.mode === mode,
      click: () => handlers.setMode(mode),
    })),
  };
}

function sizeItem({ state }: MascotMenuModel, handlers: MascotMenuHandlers, locale: Locale): Item {
  // From the full height both steps are open, and each leaves for a corner;
  // see `nextMascotState`.
  const full = state.mode === 'full';
  return {
    label: translate('mascot.size', locale),
    submenu: [
      {
        label: translate('mascot.size.larger', locale),
        enabled: full || state.scale < MASCOT_SCALE_MAX,
        click: () => handlers.stepScale(1),
      },
      {
        label: translate('mascot.size.smaller', locale),
        enabled: full || state.scale > MASCOT_SCALE_MIN,
        click: () => handlers.stepScale(-1),
      },
    ],
  };
}

/** A submenu of choices by id, or one greyed line saying there are none. */
function choiceItem(
  label: string,
  none: string,
  choices: readonly LabelledId[],
  current: string | null,
  locale: Locale,
  choose: (id: string) => void,
): Item {
  return {
    label,
    submenu:
      choices.length === 0
        ? [{ label: none, enabled: false }]
        : choices.map(
            (choice): Item => ({
              label: pick(choice.label, locale),
              // A radio only where something is known to be current. An outfit
              // is not: pieces of it may have been changed since.
              ...(current === null
                ? {}
                : { type: 'radio' as const, checked: choice.id === current }),
              click: () => choose(choice.id),
            }),
          ),
  };
}

function visibilityItem(
  { visible }: MascotMenuModel,
  handlers: MascotMenuHandlers,
  locale: Locale,
): Item {
  return {
    label: translate(visible ? 'mascot.hide' : 'mascot.show', locale),
    click: () => handlers.setVisible(!visible),
  };
}

/** The tray's menu: show or hide, display mode, size, avatar, mute, quit. */
export function trayMenu(
  model: MascotMenuModel,
  handlers: MascotMenuHandlers,
  locale: Locale = getLocale(),
): Item[] {
  return [
    visibilityItem(model, handlers, locale),
    { type: 'separator' },
    modeItem(model, handlers, locale),
    sizeItem(model, handlers, locale),
    choiceItem(
      translate('mascot.avatar', locale),
      translate('mascot.avatar.none', locale),
      model.avatars,
      // An id that is not in the list would leave every radio unchecked, which
      // Electron answers by checking the first.
      model.avatars.some(({ id }) => id === model.avatar) ? model.avatar : null,
      locale,
      handlers.setAvatar,
    ),
    { type: 'separator' },
    {
      label: translate('mascot.mute', locale),
      type: 'checkbox',
      checked: model.state.muted,
      click: () => handlers.setMuted(!model.state.muted),
    },
    { type: 'separator' },
    { label: translate('mascot.quit', locale), click: () => handlers.quit() },
  ];
}

/** The right-click on the character: display mode, size, outfit, face front, reset position, hide. */
export function contextMenu(
  model: MascotMenuModel,
  handlers: MascotMenuHandlers,
  locale: Locale = getLocale(),
): Item[] {
  return [
    modeItem(model, handlers, locale),
    sizeItem(model, handlers, locale),
    choiceItem(
      translate('mascot.outfit', locale),
      translate('mascot.outfit.none', locale),
      model.outfits,
      null,
      locale,
      handlers.setOutfit,
    ),
    { type: 'separator' },
    { label: translate('mascot.faceFront', locale), click: () => handlers.faceFront() },
    { label: translate('mascot.resetPosition', locale), click: () => handlers.resetPosition() },
    { label: translate('mascot.hide', locale), click: () => handlers.setVisible(false) },
  ];
}
