/**
 * The BGM tab — the server-owned music transport, and the insert chain under it.
 */

export const bgmEn = {
  'panel.bgm.title': 'Background music',
  'panel.bgm.note1':
    'Tracks are read from show/bgm/. Put an MP3 or FLAC there, then press Rescan; the runtime keeps the files outside the build and serves them only on loopback.',
  'panel.bgm.note2':
    'BGM is its own stream. Its volume and effects do not change the voice chain or the room applied to speech.',
  'panel.bgm.rescan': 'Rescan',
  'panel.bgm.rescan.title': 'Read the BGM directory again',
  'panel.bgm.empty': 'No MP3 or FLAC tracks. Put one in show/bgm/ and press Rescan.',
  'panel.bgm.missing':
    'The selected track is no longer in the BGM directory. Rescan to update the list.',
  'panel.bgm.none': 'No track selected',
  'panel.bgm.selected': 'Selected',
  'panel.bgm.status.playing': 'Playing',
  'panel.bgm.status.paused': 'Paused',
  'panel.bgm.status.stopped': 'Stopped',
  'panel.bgm.status.ended': 'Ended',
  'panel.bgm.play': 'Play / restart',
  'panel.bgm.play.title': 'Play the selected track from its beginning',
  'panel.bgm.pause': 'Pause',
  'panel.bgm.pause.title': 'Pause the selected track where it is',
  'panel.bgm.resume': 'Resume',
  'panel.bgm.resume.title': 'Resume the selected track where it is paused',
  'panel.bgm.stop': 'Stop',
  'panel.bgm.stop.title': 'Stop and return the selected track to its beginning',
  'panel.bgm.unload': 'Unload',
  'panel.bgm.unload.title': 'Take the selected track out of the player',
  'panel.bgm.position': 'Position',
  'panel.bgm.volume': 'Volume',
  'panel.bgm.loop': 'Loop',
  'panel.bgm.loop.title': 'Repeat the selected track after it ends',
  'panel.bgm.fade': 'Track transitions',
  'panel.bgm.fade.note1':
    'Playing a different track crossfades: the outgoing track fades out while the incoming track fades in. The first play and a stopped play fade in only.',
  'panel.bgm.fade.note2':
    'Stop fades out over the same duration. Pause and resume remain immediate. Set either side to 0 to disable that fade.',
  'panel.bgm.fadeIn': 'Fade in',
  'panel.bgm.fadeIn.title':
    'Fade in the first or stopped play, and the incoming side of a different-track crossfade',
  'panel.bgm.fadeOut': 'Fade out',
  'panel.bgm.fadeOut.title':
    'Fade out the track that is leaving: the old one on a different-track play, and the selected one on stop. Pause stays immediate',
  'panel.bgm.effects': 'Effects — BGM only',
  'panel.bgm.effects.note':
    'These controls are the libsonare insert chain for BGM. Voice effects and the room are unaffected.',
  'panel.bgm.tone': 'Tone',
  'panel.bgm.compression': 'Compression',
  'panel.bgm.width': 'Stereo width',
  'panel.bgm.reverbMix': 'Reverb mix',
  'panel.bgm.reverbDecay': 'Reverb decay',
  'panel.bgm.damping': 'Damping',
  'panel.bgm.resetEffects': 'Reset effects',
  'panel.bgm.resetEffects.title': 'Reset the BGM libsonare effects to their defaults',
  'panel.bgm.blocked':
    'BGM audio is blocked. Interact with the audible stage or OBS source once; do not click the muted preview.',
  'panel.bgm.degraded':
    'BGM effects are running dry because the libsonare DSP path is unavailable. Voice effects and room are unaffected.',
  'panel.bgm.error': 'BGM playback error',
} as const;

export const bgmJa: Record<keyof typeof bgmEn, string> = {
  'panel.bgm.title': 'BGM',
  'panel.bgm.note1':
    '曲は show/bgm/ から読み込みます。MP3 か FLAC を置いて「再読込」を押してください。実行時のファイルはビルドの外にあり、ループバックからだけ配信されます。',
  'panel.bgm.note2':
    'BGM は独立した音声です。音量とエフェクトは、声のチェーンや声にかかる部屋の響きを変えません。',
  'panel.bgm.rescan': '再読込',
  'panel.bgm.rescan.title': 'BGM ディレクトリを読み直す',
  'panel.bgm.empty': 'MP3 / FLAC がありません。show/bgm/ に置いて「再読込」を押してください。',
  'panel.bgm.missing':
    '選択中の曲が BGM ディレクトリからなくなっています。再読込で一覧を更新してください。',
  'panel.bgm.none': '曲を選択していません',
  'panel.bgm.selected': '選択中',
  'panel.bgm.status.playing': '再生中',
  'panel.bgm.status.paused': '一時停止中',
  'panel.bgm.status.stopped': '停止中',
  'panel.bgm.status.ended': '再生終了',
  'panel.bgm.play': '再生 / 最初から',
  'panel.bgm.play.title': '選択した曲を最初から再生する',
  'panel.bgm.pause': '一時停止',
  'panel.bgm.pause.title': '選択した曲をその位置で一時停止する',
  'panel.bgm.resume': '再開',
  'panel.bgm.resume.title': '一時停止した位置から選択した曲を再開する',
  'panel.bgm.stop': '停止',
  'panel.bgm.stop.title': '選択した曲を停止して最初に戻す',
  'panel.bgm.unload': '取り外す',
  'panel.bgm.unload.title': '選択した曲をプレーヤーから外す',
  'panel.bgm.position': '位置',
  'panel.bgm.volume': '音量',
  'panel.bgm.loop': 'ループ',
  'panel.bgm.loop.title': '曲が終わったら選択した曲を繰り返す',
  'panel.bgm.fade': '曲の切り替え',
  'panel.bgm.fade.note1':
    '別の曲へ切り替えるときは、前の曲をフェードアウトしながら次の曲をフェードインします。最初の再生や停止中からの再生は、フェードインだけです。',
  'panel.bgm.fade.note2':
    '停止も同じ長さでフェードアウトします。一時停止と再開はすぐに反映されます。0 秒にすると、その側のフェードを無効にできます。',
  'panel.bgm.fadeIn': 'フェードイン',
  'panel.bgm.fadeIn.title':
    '最初の再生、停止中からの再生、別の曲へ切り替えるときの次の曲をフェードインする',
  'panel.bgm.fadeOut': 'フェードアウト',
  'panel.bgm.fadeOut.title':
    '去っていく曲をフェードアウトする。別の曲へ切り替えるときの前の曲と、停止したときの選択中の曲。一時停止はすぐに反映される',
  'panel.bgm.effects': 'エフェクト — BGM のみ',
  'panel.bgm.effects.note':
    'ここは BGM 用 libsonare インサートチェーンの操作です。声のエフェクトと部屋の響きには影響しません。',
  'panel.bgm.tone': '音色',
  'panel.bgm.compression': 'コンプレッション',
  'panel.bgm.width': 'ステレオ幅',
  'panel.bgm.reverbMix': '残響ミックス',
  'panel.bgm.reverbDecay': '残響の減衰',
  'panel.bgm.damping': 'ダンピング',
  'panel.bgm.resetEffects': 'エフェクトを初期化',
  'panel.bgm.resetEffects.title': 'BGM の libsonare エフェクトを既定値に戻す',
  'panel.bgm.blocked':
    'BGM の音声がブロックされています。ミュートされたプレビューではなく、音の出るステージか OBS ソースを一度操作してください。',
  'panel.bgm.degraded':
    'libsonare の DSP 経路が使えないため、BGM エフェクトなしで再生しています。声のエフェクトと部屋の響きには影響しません。',
  'panel.bgm.error': 'BGM 再生エラー',
};
