import { bgmEn, bgmJa } from './bgm';
import { chromeEn, chromeJa } from './chrome';
import { dressEn, dressJa } from './dress';
import { inspectEn, inspectJa } from './inspect';
import { performEn, performJa } from './perform';
import { previewEn, previewJa } from './preview';
import { queueEn, queueJa } from './queue';
import { recordEn, recordJa } from './record';
import { slidesEn, slidesJa } from './slides';
import { tuneEn, tuneJa } from './tune';
import { voiceEn, voiceJa } from './voice';

/**
 * The broadcast panel's own chrome.
 *
 * Only the text the panel writes itself. Anything the panel merely displays —
 * a wardrobe slot, a performance name, a backdrop note — arrives from the
 * control server as a `Localized` pair and is resolved with `tx`, because those
 * names are avatar data and change when the avatar does.
 *
 * One file per tab, plus the frame around them. The parity check that
 * `src/i18n/messages/index.ts` runs over the whole catalogue is run again in
 * each of these files, against that file's own English keys — so a string added
 * to the voice tab and forgotten in Japanese is an error in `voice.ts` rather
 * than somewhere in a thousand-line map.
 */

export const panelEn = {
  ...chromeEn,
  ...previewEn,
  ...queueEn,
  ...performEn,
  ...dressEn,
  ...slidesEn,
  ...recordEn,
  ...tuneEn,
  ...voiceEn,
  ...bgmEn,
  ...inspectEn,
} as const;

export const panelJa: Record<keyof typeof panelEn, string> = {
  ...chromeJa,
  ...previewJa,
  ...queueJa,
  ...performJa,
  ...dressJa,
  ...slidesJa,
  ...recordJa,
  ...tuneJa,
  ...voiceJa,
  ...bgmJa,
  ...inspectJa,
};
