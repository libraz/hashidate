import type { Localized } from '../../../i18n/locale';
import type { GestureGroup } from '../../types';

/**
 * What each group is called on screen, and the order they are drawn in.
 *
 * The table is filed under these — one file per key — so this object is also
 * what decides the order `GESTURES_BY_GROUP` comes out in.
 */
export const GESTURE_GROUPS: Record<GestureGroup, Localized> = {
  reaction: { en: 'Reaction', ja: '相槌' },
  greeting: { en: 'Greeting', ja: '挨拶' },
  explain: { en: 'Explaining', ja: '説明' },
  emote: { en: 'Feeling', ja: '感情' },
  cute: { en: 'Mannerism', ja: '仕草' },
  pose: { en: 'Pose', ja: 'ポーズ' },
  affection: { en: 'Affection', ja: '愛情' },
  playful: { en: 'Playful', ja: 'おちゃめ' },
  idol: { en: 'Idol', ja: 'アイドル' },
  cheer: { en: 'Encouragement', ja: '応援' },
  dance: { en: 'Dance', ja: 'ダンス' },
  photo: { en: 'Photo pose', ja: '撮影ポーズ' },
};
