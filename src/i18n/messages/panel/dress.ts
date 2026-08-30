/**
 * The dress tab: the wardrobe, as the loaded avatar reports it.
 */

export const dressEn = {
  'panel.dress.title': 'Wardrobe',
  'panel.dress.none': 'This avatar has nothing to change into.',
  'panel.dress.presets': 'Outfits',
  'panel.dress.presets.note':
    'Dress a whole set at once. Every slot below moves to this outfit the moment it is pressed.',
  'panel.dress.slots': 'Pieces',
  'panel.dress.slotCount': '{count} slots',
  'panel.dress.slots.note':
    'One garment per slot. The shapes under a covered area are taken in as the garment goes on, so nothing pokes through it.',
  'panel.dress.bare': 'None',
} as const;

export const dressJa: Record<keyof typeof dressEn, string> = {
  'panel.dress.title': '衣装',
  'panel.dress.none': 'このアバターは着せ替えを持たない。',
  'panel.dress.presets': '組み合わせ',
  'panel.dress.presets.note':
    'ひと揃いを一度に着せる。押した時点で、下のスロットはすべてこの組み合わせのものになる。',
  'panel.dress.slots': 'パーツ',
  'panel.dress.slotCount': '{count} スロット',
  'panel.dress.slots.note':
    'スロットひとつにつき一着。衣装が素体を貫通しないように、覆われる部分のシェイプは着替えと同時に自動で上がる。',
  'panel.dress.bare': 'なし',
};
