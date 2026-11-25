/**
 * The desktop mascot's tray and right-click menus.
 *
 * Native menus built in the main process, which is why these are few and
 * short: there is no page to explain anything on, only an item to pick.
 */
export const mascotEn = {
  'mascot.tray.tooltip': 'hashidate mascot',
  'mascot.show': 'Show',
  'mascot.hide': 'Hide',
  'mascot.mode': 'Display Mode',
  'mascot.mode.full': 'Full Height',
  'mascot.mode.bottomRight': 'Bottom Right',
  'mascot.mode.bottomLeft': 'Bottom Left',
  'mascot.mode.free': 'Free',
  'mascot.size': 'Size',
  'mascot.size.larger': 'Larger',
  'mascot.size.smaller': 'Smaller',
  'mascot.avatar': 'Avatar',
  'mascot.avatar.none': 'No avatars found',
  'mascot.outfit': 'Outfit',
  'mascot.outfit.none': 'No outfits',
  'mascot.mute': 'Mute',
  'mascot.resetPosition': 'Reset Position',
  'mascot.quit': 'Quit',
} as const;

export const mascotJa: Record<keyof typeof mascotEn, string> = {
  'mascot.tray.tooltip': 'hashidate マスコット',
  'mascot.show': '表示',
  'mascot.hide': '隠す',
  'mascot.mode': '表示モード',
  'mascot.mode.full': '画面の高さいっぱい',
  'mascot.mode.bottomRight': '右下',
  'mascot.mode.bottomLeft': '左下',
  'mascot.mode.free': '自由',
  'mascot.size': '大きさ',
  'mascot.size.larger': '大きく',
  'mascot.size.smaller': '小さく',
  'mascot.avatar': 'アバター',
  'mascot.avatar.none': 'アバターがありません',
  'mascot.outfit': '衣装',
  'mascot.outfit.none': '衣装がありません',
  'mascot.mute': '黙らせる',
  'mascot.resetPosition': '位置を戻す',
  'mascot.quit': '終了',
};
