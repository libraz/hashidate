import type { Snapshot, VoiceDsp } from '@/protocol';
import { Chip, ChipRow } from '@/ui/Chip';
import { Section } from '@/ui/Section';
import { setRoom, setVoice } from '../api';
import { ChainSlider } from './ChainSlider';
import { Meters } from './Meters';
import styles from './VoiceTab.module.css';

/**
 * How the voice is finished before it reaches the stream.
 *
 * ## The controls are the processor's own, on purpose
 *
 * Every slider here maps to one field of libsonare's realtime voice-changer
 * configuration, section for section and name for name. That is a deliberate
 * refusal to invent a friendlier vocabulary: a de-esser threshold is a de-esser
 * threshold, and a second set of names for the same twenty numbers would be a
 * mapping table for the panel and the renderer to drift across — while also
 * being *less* legible to the one person operating this, who already knows what
 * a compressor ratio is.
 *
 * ## Every change is a delta on a base preset
 *
 * The panel never sends a complete configuration, because it does not have one:
 * the processor refuses a partial config, and the only end that holds the preset
 * table is the renderer. So a slider sends the one field it moved, the renderer
 * merges it onto the base, and what comes back in the report is the resolved
 * result — which is what these sliders are drawn from. That round trip is why a
 * preset change moves every slider at once without the panel knowing any of the
 * numbers in it.
 *
 * ## Rooms are here and are not part of the chain
 *
 * A room is a convolution downstream of everything below it, derived from a
 * physical space rather than a decay time. The chain has its own reverb and it
 * is left at zero by every preset that matters — two reverbs is two rooms and
 * sounds like it, so the room picker is first and the chain's reverb is filed
 * under the section it belongs to rather than promoted beside it.
 */

interface Props {
  snapshot: Snapshot;
  refresh: () => void;
}

/** Read one number out of the resolved report, or a stated fallback. */
function read(dsp: Record<string, unknown> | null | undefined, path: string, fallback: number) {
  if (!dsp) return fallback;
  const [head, tail] = path.split('.');
  const section = dsp[head];
  if (tail === undefined) return typeof section === 'number' ? section : fallback;
  if (typeof section !== 'object' || section === null) return fallback;
  const value = (section as Record<string, unknown>)[tail];
  return typeof value === 'number' ? value : fallback;
}

export function VoiceTab({ snapshot, refresh }: Props) {
  const voice = snapshot.voice;
  const dsp = voice?.dsp ?? null;
  const bypassed = voice?.preset === null;

  /** Send one field and re-read. Building the nested shape from a dotted path. */
  const set = (path: string, value: number): void => {
    const [head, tail] = path.split('.');
    const patch: VoiceDsp =
      tail === undefined
        ? ({ [head]: value } as VoiceDsp)
        : ({ [head]: { [tail]: value } } as VoiceDsp);
    void setVoice(undefined, patch).then(refresh);
  };

  const knob = (
    label: string,
    path: string,
    fallback: number,
    opts: { min: number; max: number; step?: number; precision?: number; unit?: string },
  ) => (
    <ChainSlider
      key={path}
      label={label}
      reported={read(dsp, path, fallback)}
      onCommit={(v) => set(path, v)}
      min={opts.min}
      max={opts.max}
      step={opts.step ?? 0.01}
      precision={opts.precision ?? 2}
      unit={opts.unit ?? ''}
      title={path}
    />
  );

  return (
    <div className={styles.tab}>
      <Meters voice={voice} />

      <Section
        title="部屋"
        meta={voice?.room ?? 'ドライ'}
        note={[
          '合成された声には残響がまったく乗っていません。学習に使った録音から残響を取り除いてあるためで、素材としては正しく、そのまま流すと真空の中の声に聞こえます。',
          'ここで選ぶのは減衰時間ではなく部屋そのものです。寸法と壁の吸音率からインパルス応答を作り、畳み込みで鳴らします。チェーン全体より後段にあるので、口の動きは残響ではなく声そのものに追従します。',
        ]}
      >
        <ChipRow>
          <Chip
            label="ドライ"
            state={voice?.room ? 'off' : 'on'}
            onClick={() => void setRoom(null).then(refresh)}
          />
          {(snapshot.vocabulary.rooms ?? []).map((room) => (
            <Chip
              key={room.id}
              label={room.label}
              tag={room.id}
              state={voice?.room === room.id ? 'on' : 'off'}
              onClick={() => void setRoom(room.id).then(refresh)}
            />
          ))}
        </ChipRow>
      </Section>

      <Section
        title="ボイスチェンジャー"
        meta={bypassed ? 'バイパス' : (voice?.preset ?? '—')}
        note={[
          'プリセットを土台に、下のつまみが差分として乗ります。パネルは完全な設定を持たず、ずらした一項目だけを送り、レンダラー側でプリセットに重ねます。表示されている値はその合成結果の読み戻しです。',
          'ピッチとフォルマントは独立に動きます。ピッチだけ上げると早回しに聞こえ、フォルマントを一緒に動かすと別人の声になります。',
          '「バイパス」は加工なし。合成された音をそのまま再生し、つまみの差分も破棄します。',
        ]}
      >
        <ChipRow>
          <Chip
            label="バイパス"
            state={bypassed ? 'on' : 'off'}
            onClick={() => void setVoice(null).then(refresh)}
          />
          {(snapshot.vocabulary.voicePresets ?? []).map((preset) => (
            <Chip
              key={preset.id}
              label={preset.label}
              tag={preset.id}
              state={voice?.preset === preset.id ? 'on' : 'off'}
              onClick={() => void setVoice(preset.id).then(refresh)}
            />
          ))}
        </ChipRow>
      </Section>

      {bypassed ? (
        <p className={styles.bypassed}>
          加工なしで再生しています。つまみを使うにはプリセットを選んでください。
        </p>
      ) : (
        <>
          <Section title="声質" meta="pitch / formant">
            {knob('ピッチ', 'retune.semitones', 0, {
              min: -12,
              max: 12,
              step: 0.5,
              precision: 1,
              unit: '半音',
            })}
            {knob('ピッチ適用量', 'retune.mix', 1, { min: 0, max: 1 })}
            {knob('フォルマント', 'formant.factor', 1, { min: 0.5, max: 2, step: 0.01 })}
            {knob('フォルマント適用量', 'formant.amount', 1, { min: 0, max: 1 })}
            {knob('太さ', 'formant.body', 0, { min: -1, max: 1 })}
            {knob('明るさ', 'formant.brightness', 0, { min: -1, max: 1 })}
            {knob('鼻にかかり', 'formant.nasal', 0, { min: -1, max: 1 })}
          </Section>

          <Section title="イコライザ" meta="4 band">
            {knob('ローカット', 'eq.highpassHz', 120, {
              min: 20,
              max: 400,
              step: 5,
              precision: 0,
              unit: 'Hz',
            })}
            {knob('ボディ', 'eq.bodyDb', 0, {
              min: -12,
              max: 12,
              step: 0.5,
              precision: 1,
              unit: 'dB',
            })}
            {knob('プレゼンス', 'eq.presenceDb', 0, {
              min: -12,
              max: 12,
              step: 0.5,
              precision: 1,
              unit: 'dB',
            })}
            {knob('エア', 'eq.airDb', 0, {
              min: -12,
              max: 12,
              step: 0.5,
              precision: 1,
              unit: 'dB',
            })}
          </Section>

          <Section
            title="ゲート"
            meta="noise"
            note={[
              '合成音には環境ノイズがないので、ここは息継ぎや語尾の余韻を切るためのものです。しきい値を上げすぎると語尾が欠けます。',
            ]}
          >
            {knob('しきい値', 'gate.thresholdDb', -50, {
              min: -80,
              max: -10,
              step: 1,
              precision: 0,
              unit: 'dB',
            })}
            {knob('リリース', 'gate.releaseMs', 80, {
              min: 10,
              max: 500,
              step: 5,
              precision: 0,
              unit: 'ms',
            })}
            {knob('減衰量', 'gate.rangeDb', 22, {
              min: 0,
              max: 60,
              step: 1,
              precision: 0,
              unit: 'dB',
            })}
          </Section>

          <Section
            title="コンプレッサー"
            meta="dynamics"
            note={[
              '行ごとに音量が揺れるのを抑えます。配信では視聴者の音量つまみが固定なので、行間で 6 dB 動くと聞き手が操作を強いられます。',
            ]}
          >
            {knob('しきい値', 'compressor.thresholdDb', -23, {
              min: -50,
              max: 0,
              step: 0.5,
              precision: 1,
              unit: 'dB',
            })}
            {knob('レシオ', 'compressor.ratio', 3, { min: 1, max: 12, step: 0.1, precision: 1 })}
            {knob('アタック', 'compressor.attackMs', 4.5, {
              min: 0.5,
              max: 50,
              step: 0.5,
              precision: 1,
              unit: 'ms',
            })}
            {knob('リリース', 'compressor.releaseMs', 75, {
              min: 10,
              max: 500,
              step: 5,
              precision: 0,
              unit: 'ms',
            })}
            {knob('メイクアップ', 'compressor.makeupGainDb', 0, {
              min: -6,
              max: 12,
              step: 0.5,
              precision: 1,
              unit: 'dB',
            })}
          </Section>

          <Section title="ディエッサー" meta="sibilance">
            {knob('周波数', 'deesser.frequencyHz', 7000, {
              min: 3000,
              max: 12000,
              step: 100,
              precision: 0,
              unit: 'Hz',
            })}
            {knob('しきい値', 'deesser.thresholdDb', -30, {
              min: -60,
              max: 0,
              step: 1,
              precision: 0,
              unit: 'dB',
            })}
            {knob('減衰量', 'deesser.rangeDb', 6, {
              min: 0,
              max: 24,
              step: 0.5,
              precision: 1,
              unit: 'dB',
            })}
          </Section>

          <Section
            title="チェーンの残響"
            meta="上の「部屋」と併用しない"
            note={[
              'これは声そのものに足す残響で、上の「部屋」とは別物です。部屋のほうが物理形状から作られていて質が良いので、通常はこちらを 0 のままにします。両方上げると部屋が二つあるように聞こえます。',
            ]}
          >
            {knob('量', 'reverb.mix', 0, { min: 0, max: 1 })}
            {knob('長さ', 'reverb.timeMs', 320, {
              min: 50,
              max: 3000,
              step: 10,
              precision: 0,
              unit: 'ms',
            })}
            {knob('減衰', 'reverb.damping', 0.5, { min: 0, max: 1 })}
          </Section>

          <Section
            title="出力"
            meta="loudness"
            note={[
              'リミッターは配信に出る最後の砦です。true peak の天井を −1 dBTP に置くのは、配信プラットフォーム側のロッシー変換でサンプル間ピークが持ち上がるためで、0 に置くとそこで割れます。',
            ]}
          >
            {knob('出力ゲイン', 'outputGainDb', 0, {
              min: -12,
              max: 12,
              step: 0.5,
              precision: 1,
              unit: 'dB',
            })}
            {knob('加工量', 'wetMix', 1, { min: 0, max: 1 })}
            {knob('リミッター天井', 'limiter.ceilingDb', -1, {
              min: -6,
              max: 0,
              step: 0.1,
              precision: 1,
              unit: 'dB',
            })}
          </Section>
        </>
      )}
    </div>
  );
}
