/**
 * Strings that belong to no single surface.
 *
 * The shared widgets in `src/ui` and the transport errors that both the panel
 * and the console can hit. Kept apart from the surface catalogues so that a
 * change to a button label does not have to be made twice and then drift.
 */
export const commonEn = {
  'locale.label': 'Language',
  'error.controlUnreachable': 'Cannot reach the control server',
  'section.explain': 'About {title}',
  'preset.groups': 'Preset groups',
  'preset.search': 'Search presets',
  'preset.search.placeholder': 'Search by name or id',
  'preset.search.clear': 'Clear search',
  'preset.search.empty': 'No presets found',
} as const;

export const commonJa: Record<keyof typeof commonEn, string> = {
  'locale.label': '言語',
  'error.controlUnreachable': '制御サーバーに接続できません',
  'section.explain': '{title}の説明',
  'preset.groups': 'プリセットのグループ',
  'preset.search': 'プリセットを検索',
  'preset.search.placeholder': '名前またはIDで検索',
  'preset.search.clear': '検索をクリア',
  'preset.search.empty': 'プリセットが見つかりません',
};
