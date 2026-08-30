/**
 * The preview beside the controls — the renderer this panel embeds, and the
 * shot an operator drags on it.
 */

export const previewEn = {
  'panel.preview.title': 'Preview',
  'panel.preview.readout.on': 'Measure on',
  'panel.preview.readout.off': 'Measure off',
  'panel.preview.readout.hideTitle': 'Take the measurements off the picture',
  'panel.preview.readout.showTitle':
    'Print breathing, gaze, frame rate and the document state on every viewer attached, including the one going to air',
  'panel.preview.hide': 'Stop',
  'panel.preview.show': 'Show',
  'panel.preview.hideTitle': 'Stop the preview and give the GPU back',
  'panel.preview.showTitle': 'Show the preview',
  'panel.preview.frameTitle': 'Avatar preview',
  'panel.preview.stopped':
    'Preview stopped. No second WebGL context is open, so the renderer going to air has more to work with.',
  'panel.preview.blocked':
    'Audio is blocked. Click the viewer window once and the next line will be heard.',
  'panel.preview.avatarAria': 'Avatar',
  'panel.preview.cameraAria': 'Camera',
  'panel.preview.backdropAria': 'Backdrop',
  'panel.preview.backdropNone': 'None',
  'panel.preview.backdropNone.title': 'The plain background',
  'panel.preview.straightOn': 'Straight on',
  'panel.preview.straightOnFrom': 'Straight on  {offset}',
  'panel.preview.straightOn.title':
    'Keep the framing and put the camera back to the front at its reference distance',
  'panel.preview.shot.right': 'R',
  'panel.preview.shot.left': 'L',
  'panel.preview.shot.up': 'U',
  'panel.preview.shot.down': 'D',
  'panel.preview.idle': 'Autopilot (idle)',
} as const;

export const previewJa: Record<keyof typeof previewEn, string> = {
  'panel.preview.title': 'プレビュー',
  'panel.preview.readout.on': '計測 入',
  'panel.preview.readout.off': '計測 切',
  'panel.preview.readout.hideTitle': '計測値の表示を消す',
  'panel.preview.readout.showTitle':
    '呼吸・視線・フレームレート・資料の状態を、接続中のすべてのビューアに表示する（配信に出る画面にも出ます）',
  'panel.preview.hide': '停止',
  'panel.preview.show': '表示',
  'panel.preview.hideTitle': 'プレビューを止めて GPU を返す',
  'panel.preview.showTitle': 'プレビューを表示する',
  'panel.preview.frameTitle': 'アバターのプレビュー',
  'panel.preview.stopped':
    'プレビュー停止中。二つ目の WebGL コンテキストを開かないので、配信側の描画が軽くなります。',
  'panel.preview.blocked':
    '音声ブロック中。ビューアの画面を一度クリックすると次の行から声が出ます。',
  'panel.preview.avatarAria': 'アバター',
  'panel.preview.cameraAria': 'カメラ',
  'panel.preview.backdropAria': '背景',
  'panel.preview.backdropNone': 'なし',
  'panel.preview.backdropNone.title': '素の背景',
  'panel.preview.straightOn': '正面',
  'panel.preview.straightOnFrom': '正面へ  {offset}',
  'panel.preview.straightOn.title': '画角はそのままに、カメラを正面・基準距離へ戻す',
  'panel.preview.shot.right': '右',
  'panel.preview.shot.left': '左',
  'panel.preview.shot.up': '上',
  'panel.preview.shot.down': '下',
  'panel.preview.idle': '自動モード（アイドル）',
};
