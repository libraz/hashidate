import { useState } from 'react';
import { GESTURE_GROUPS } from '@/engine/motion';
import { PERFORMANCE_GROUPS } from '@/engine/performance';
import type { EmotionName, EmotionVector, FingerName, Side } from '@/engine/types';
import type { LabelledId, Snapshot } from '@/protocol';
import { Chip, ChipRow } from '@/ui/Chip';
import { Field } from '@/ui/Field';
import { Section } from '@/ui/Section';
import { Segmented } from '@/ui/Segmented';
import { Slider } from '@/ui/Slider';
import {
  type Aim,
  gesture,
  hop,
  perform,
  point,
  resetFace,
  setEmotion,
  setExpression,
  setLook,
  setOverlay,
} from '../api';

/**
 * The live surface: face, movement, pointing.
 *
 * The console has a tab of the same name reaching into the scene it is drawn
 * beside. This one draws from the vocabulary the renderer reported and sends
 * commands back, which is the whole difference between the two panels — and the
 * reason this one works with the renderer on another screen, in another
 * process, or not yet open.
 *
 * ## Everything here is avatar-derived, including what is missing
 *
 * The drawn expressions and the overlays come from the loaded avatar's own shape
 * groups, so an avatar that has none gets no section rather than an empty one.
 * The performances and gestures are engine tables and are always there; only
 * their group headings are read from the engine directly, because a heading is
 * presentation and putting it on the wire would be shipping a label table to
 * make a panel prettier.
 *
 * ## The chips lag by up to half a second
 *
 * What is lit comes from the reported state, which arrives on the panel's poll.
 * That is the right way round: the autopilot also moves the emotion vector and
 * a chip lit from the last click would be wrong about it. It does mean a chip
 * pressed during a line does not light instantly, which reads as slowness and is
 * not — the character has already moved.
 */

/** Every emotion but neutral: neutral is what 解除 means, not a thing to pick. */
const pickable = (emotions: LabelledId[]): LabelledId[] =>
  emotions.filter((emotion) => emotion.id !== 'neutral');

const FINGERS: Array<{ value: FingerName; label: string }> = [
  { value: 'thumb', label: '親' },
  { value: 'index', label: '人差' },
  { value: 'middle', label: '中' },
  { value: 'ring', label: '薬' },
  { value: 'little', label: '小' },
];

const SIDES: Array<{ value: Side; label: string }> = [
  { value: 'R', label: '右手' },
  { value: 'L', label: '左手' },
];

/** Group an avatar's list by its own group key, in the engine's heading order. */
function byGroup<T extends { group: string }>(
  items: T[],
  headings: Record<string, string>,
): Array<{ key: string; label: string; items: T[] }> {
  return Object.entries(headings)
    .map(([key, label]) => ({ key, label, items: items.filter((item) => item.group === key) }))
    .filter((group) => group.items.length > 0);
}

interface Props {
  snapshot: Snapshot;
  refresh: () => void;
}

export function PerformTab({ snapshot, refresh }: Props) {
  const { vocabulary, state } = snapshot;
  const [mixing, setMixing] = useState(false);
  const [aim, setAim] = useState<Aim>({
    side: 'R',
    finger: 'index',
    azimuth: 35,
    elevation: 20,
    extent: 0.85,
  });

  /** Send, then re-read: both lists this tab lights up moved. */
  const run = (job: Promise<unknown>): void => void job.then(refresh);

  const emotion: EmotionVector = state.emotion ?? {};
  const moods = pickable(vocabulary.emotions ?? []);
  const performances = byGroup(vocabulary.performances ?? [], PERFORMANCE_GROUPS);
  const gestures = byGroup(vocabulary.gestures ?? [], GESTURE_GROUPS);
  const pointing = vocabulary.pointing;
  const strain = state.strain?.[aim.side] ?? 0;

  const mix = (name: string, value: number): void => {
    const next: EmotionVector = { ...emotion, [name as EmotionName]: value };
    for (const key of Object.keys(next) as EmotionName[]) {
      if (!next[key]) delete next[key];
    }
    run(setEmotion(Object.keys(next).length ? next : { neutral: 1 }));
  };

  /** Point with one field overridden, so changing the hand re-aims with it. */
  const aimAt = (over: Partial<Aim> = {}): void => {
    const next = { ...aim, ...over };
    setAim(next);
    run(point(next));
  };

  return (
    <>
      <Section
        title="プリセット"
        meta={state.performance ?? ''}
        note={[
          '表情とモーションをひと組にしたもの。下の「感情」「ジェスチャ」はその部品で、名前のない組み合わせを作るときに使う。',
          '感情はプリセットを抜けても残る。姿勢や伏し目のように保持されるものは * 印つきで、次のプリセットか「解除」で戻る。',
        ]}
      >
        {performances.map((group) => (
          <Field key={group.key} label={group.label}>
            <ChipRow>
              {group.items.map((item) => (
                <Chip
                  key={item.id}
                  label={item.sustain ? `${item.label} *` : item.label}
                  title={`${item.id}  ${[item.gesture, item.hop].filter(Boolean).join(' + ') || '表情のみ'}`}
                  state={state.performance === item.id ? 'on' : 'off'}
                  onClick={() => run(perform(state.performance === item.id ? null : item.id))}
                />
              ))}
            </ChipRow>
          </Field>
        ))}
        <ChipRow>
          <Chip label="解除" variant="action" onClick={() => run(perform(null))} />
        </ChipRow>
      </Section>

      <Section
        title="感情"
        note={[
          '連続値なので複数を混ぜると中間表情になる。チップは単独指定、「配合」を開くと比率を作れる。',
          '台詞が終わっても残る — 気分は文の長さでは終わらない。',
        ]}
      >
        <ChipRow>
          {moods.map((mood) => (
            <Chip
              key={mood.id}
              label={mood.label}
              title={mood.id}
              state={(emotion[mood.id as EmotionName] ?? 0) > 0.5 ? 'auto' : 'off'}
              onClick={() => run(setEmotion({ [mood.id as EmotionName]: 1 }))}
            />
          ))}
          <Chip label="解除" variant="action" onClick={() => run(resetFace())} />
          <Chip label="配合" state={mixing ? 'on' : 'off'} onClick={() => setMixing((v) => !v)} />
        </ChipRow>
        {mixing
          ? moods.map((mood) => (
              <Slider
                key={mood.id}
                label={`${mood.label}  ${mood.id}`}
                value={emotion[mood.id as EmotionName] ?? 0}
                onChange={(v) => mix(mood.id, v)}
              />
            ))
          : null}
      </Section>

      {vocabulary.expressions?.length ? (
        <Section
          title="描き起こし表情"
          meta={`${vocabulary.expressions.length}`}
          note={[
            'モデル同梱の完成形の表情。合成では作れない目や口の形が入るため、感情とは別系統で持つ。',
            '塗りつぶしが操作者の選択、枠線だけのものは感情か自動モードが選んだもの。後者は解除できない。',
          ]}
        >
          <ChipRow>
            {vocabulary.expressions.map((preset) => (
              <Chip
                key={preset.id}
                label={preset.label}
                title={preset.id}
                state={
                  state.pickedExpression === preset.id
                    ? 'on'
                    : state.expression === preset.id
                      ? 'auto'
                      : 'off'
                }
                onClick={() =>
                  run(setExpression(state.pickedExpression === preset.id ? null : preset.id))
                }
              />
            ))}
            <Chip label="解除" variant="action" onClick={() => run(resetFace())} />
          </ChipRow>
        </Section>
      ) : null}

      {vocabulary.overlays?.length ? (
        <Section
          title="重ねる効果"
          meta={`${vocabulary.overlays.length}`}
          note={['表情を置き換えず上に重なるので、複数を同時に出せる。']}
        >
          <ChipRow>
            {vocabulary.overlays.map((overlay) => {
              const up = (state.overlays?.[overlay.id] ?? 0) > 0;
              return (
                <Chip
                  key={overlay.id}
                  label={overlay.label}
                  title={overlay.id}
                  state={up ? 'on' : 'off'}
                  onClick={() => run(setOverlay(overlay.id, up ? 0 : 1))}
                />
              );
            })}
            <Chip label="全解除" variant="action" onClick={() => run(resetFace())} />
          </ChipRow>
        </Section>
      ) : null}

      <Section
        title="ジェスチャ"
        meta={state.gesture ?? ''}
        note={[
          '表情を伴わない体だけの語彙。再生ごとに速さ・振幅・左右が変わり、切り替えはクロスフェードで送る。',
          'ポーズ群は解除するまで保持する。それ以外は自分で終わる。跳躍は腕とは別に走るので同時に出せる。',
        ]}
      >
        {gestures.map((group) => (
          <Field key={group.key} label={group.label}>
            <ChipRow>
              {group.items.map((item) => (
                <Chip
                  key={item.id}
                  label={item.label}
                  title={item.id}
                  state={state.gesture === item.id ? 'auto' : 'off'}
                  onClick={() => run(gesture(item.id))}
                />
              ))}
            </ChipRow>
          </Field>
        ))}
        {vocabulary.hops?.length ? (
          <Field label="跳躍">
            <ChipRow>
              {vocabulary.hops.map((item) => (
                <Chip
                  key={item.id}
                  label={item.label}
                  title={item.id}
                  onClick={() => run(hop(item.id))}
                />
              ))}
            </ChipRow>
          </Field>
        ) : null}
        <ChipRow>
          <Chip label="停止" variant="action" onClick={() => run(gesture())} />
        </ChipRow>
      </Section>

      {pointing ? (
        <Section
          title="指さし"
          meta={strain > 0 ? `負担 ${strain.toFixed(2)}` : ''}
          note={[
            pointing.note,
            '可動域を超える指示は失敗せず、届く範囲まで伸ばして止まる。どれだけ無理をしたかは「負担」に出る。',
          ]}
        >
          <Field label="手">
            <Segmented
              ariaLabel="どちらの手"
              options={SIDES}
              value={aim.side}
              onChange={(side) => aimAt({ side })}
            />
          </Field>
          <Field label="指">
            <Segmented
              ariaLabel="どの指"
              options={FINGERS}
              value={aim.finger}
              onChange={(finger) => aimAt({ finger })}
            />
          </Field>
          <Slider
            label="方位  azimuth"
            value={aim.azimuth}
            min={pointing.azimuth[0]}
            max={pointing.azimuth[1]}
            step={1}
            precision={0}
            unit="°"
            onChange={(azimuth) => setAim((a) => ({ ...a, azimuth }))}
          />
          <Slider
            label="仰角  elevation"
            value={aim.elevation}
            min={pointing.elevation[0]}
            max={pointing.elevation[1]}
            step={1}
            precision={0}
            unit="°"
            onChange={(elevation) => setAim((a) => ({ ...a, elevation }))}
          />
          <Slider
            label="伸ばし  extent"
            value={aim.extent}
            min={pointing.extent[0]}
            max={pointing.extent[1]}
            onChange={(extent) => setAim((a) => ({ ...a, extent }))}
          />
          {/* The two angle faders do not send as they move, unlike everything
              else here: a drag would be sixty solves and sixty requests, and the
              arm would chase the slider rather than being aimed. */}
          <ChipRow>
            <Chip label="指す" variant="primary" onClick={() => aimAt()} />
            <Chip label="解除" variant="action" onClick={() => run(gesture())} />
          </ChipRow>
        </Section>
      ) : null}

      <Section
        title="カメラ目線"
        note={['視線がカメラを追う度合い。0 は正面を向いたまま、1 は常にレンズを見る。']}
      >
        <Slider
          label="カメラ目線  lookAt"
          value={state.lookAt ?? 1}
          onChange={(amount) => run(setLook(amount))}
        />
      </Section>
    </>
  );
}
