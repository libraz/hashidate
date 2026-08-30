/**
 * The record tab — writing a take to a file.
 */

export const recordEn = {
  'panel.record.take': 'Recording',
  'panel.record.take.note1':
    'The frame is composed again at the size below, so a take is the same size whatever the stage window is. It cannot add detail: a stage window smaller than the output records soft.',
  'panel.record.take.note2':
    'The renderer that is not muted is the one that records, which is the stage rather than the preview above.',
  'panel.record.take.note3':
    'Load a script in the Queue tab, frame the shot, then record. The file lands in recordings/.',
  'panel.record.take.size': 'Output size',
  'panel.record.take.fps': 'Frame rate',
  'panel.record.take.autoStop': 'Stop at the end of the script',
  'panel.record.take.autoStop.title':
    'End the take a moment after the last line. A line queued in that moment carries it on.',
  'panel.record.take.start': 'Record',
  'panel.record.take.start.title': 'Start recording, and let a held queue go once it is rolling',
  'panel.record.take.releases': 'and lets the held queue go once it is rolling',
  'panel.record.take.stop': 'Stop',
  'panel.record.take.stop.title': 'End the take. The last second is still being written.',
  'panel.record.take.file': 'File',
  'panel.record.take.written': 'Written',
  'panel.record.take.waiting': 'waiting for the first frames',
  'panel.record.take.format': 'Format',
  'panel.recording': 'Recording',
  'panel.recording.title': 'A take is being written. The Recording tab has the details.',
} as const;

export const recordJa: Record<keyof typeof recordEn, string> = {
  'panel.record.take': '録画',
  'panel.record.take.note1':
    '画面は下のサイズで組み直すので、ステージウィンドウの大きさに関わらず同じサイズで録れる。ただし解像度は増えない。出力より小さいウィンドウで録ると眠い絵になる。',
  'panel.record.take.note2':
    '録画するのはミュートされていないレンダラー。つまり上のプレビューではなくステージのほう。',
  'panel.record.take.note3':
    'キュータブで台本を読み込み、画角を決めてから録画する。ファイルは recordings/ に落ちる。',
  'panel.record.take.size': '出力サイズ',
  'panel.record.take.fps': '毎秒コマ',
  'panel.record.take.autoStop': '台本の終わりで停止',
  'panel.record.take.autoStop.title':
    '最終行の少しあとで録画を終える。そのあいだに行が入れば録画は続く。',
  'panel.record.take.start': '録画開始',
  'panel.record.take.start.title': '録画を始め、録れ始めた時点で一時停止を解除する',
  'panel.record.take.releases': '録れ始めた時点で一時停止も解除される',
  'panel.record.take.stop': '停止',
  'panel.record.take.stop.title': '録画を終える。最後の一秒はまだ書き込み中。',
  'panel.record.take.file': 'ファイル',
  'panel.record.take.written': '書き込み済み',
  'panel.record.take.waiting': '最初のフレーム待ち',
  'panel.record.take.format': '形式',
  'panel.recording': '録画中',
  'panel.recording.title': '録画を書き込んでいる。詳細は録画タブ。',
};
