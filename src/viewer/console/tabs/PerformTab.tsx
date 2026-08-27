import { useState } from 'react';
import { EMOTION_LABELS, EMOTIONS } from '@/engine/face';
import { GESTURE_GROUPS, GESTURES, GESTURES_BY_GROUP, HOP_IDS, HOPS } from '@/engine/motion';
import {
  holdsUntilReleased,
  PERFORMANCE_GROUPS,
  PERFORMANCE_TABLE,
  PERFORMANCES_BY_GROUP,
} from '@/engine/performance';
import type {
  CameraFrame,
  EmotionName,
  EmotionVector,
  FingerName,
  SessionState,
  Side,
} from '@/engine/types';
import { Chip, ChipRow } from '@/ui/Chip';
import { Field } from '@/ui/Field';
import { Section } from '@/ui/Section';
import { Segmented } from '@/ui/Segmented';
import { Slider } from '@/ui/Slider';
import type { LoadedAvatar } from '../../scene/runtime';

/** Every emotion but neutral — neutral is what "解除" means, not a thing to pick. */
const MOODS = (Object.keys(EMOTIONS) as EmotionName[]).filter((n) => n !== 'neutral');

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

interface Props {
  loaded: LoadedAvatar;
  state: SessionState | null;
  onCamera: (frame: CameraFrame) => void;
}

export function PerformTab({ loaded, state, onCamera }: Props) {
  const { director, session, avatar, profile } = loaded;
  const [mixing, setMixing] = useState(false);
  const [side, setSide] = useState<Side>('R');
  const [finger, setFinger] = useState<FingerName>('index');
  const [azimuth, setAzimuth] = useState(35);
  const [elevation, setElevation] = useState(20);
  const [extent, setExtent] = useState(0.85);

  const emotion: EmotionVector = state?.emotion ?? {};

  /**
   * What every 解除 in this tab does, including the one under the presets.
   *
   * Not `perform(null)`, which is the *turn's* release and puts back only what a
   * performance is holding — a pose, closed lids, a dropped gaze. Three quarters
   * of the table hold none of those: their gesture has already ended by the time
   * anyone reaches for the button and the mood is kept on purpose, so releasing
   * one used to clear an internal flag and change nothing on screen. A control
   * labelled 解除 that leaves the face it was pressed on is broken however
   * correct the release underneath it is.
   */
  const rest = () => session.resetExpression();

  const setMood = (name: EmotionName) => session.setEmotion({ [name]: 1 });
  const mix = (name: EmotionName, value: number) => {
    const next: EmotionVector = { ...emotion, [name]: value };
    for (const k of Object.keys(next) as EmotionName[]) {
      if (!next[k]) delete next[k];
    }
    session.setEmotion(Object.keys(next).length ? next : { neutral: 1 });
  };

  const aim = (over: Partial<{ side: Side; finger: FingerName }> = {}) =>
    session.point({
      side: over.side ?? side,
      finger: over.finger ?? finger,
      azimuth,
      elevation,
      extent,
    });

  const composition = profile.arkit.supported
    ? 'ARKit 52 合成'
    : avatar.emotionShapes
      ? 'モデル固有シェイプ合成'
      : 'VRM プリセット';

  const strain = state?.strain?.[side] ?? 0;

  return (
    <>
      <Section
        title="プリセット"
        meta={state?.performance ?? ''}
        note={[
          '表情とモーションをひと組にしたもの。ここから下の「感情」「ジェスチャ」はその部品で、プリセットに名前のない組み合わせを作るときに使う。',
          '台詞に添えたプリセットは行の終わりで自分から抜けるが、気分だけは残る — 気分は台詞と一緒には終わらない。ここの「解除」はそれとは別で、気分も重ねた効果も含めて素の顔に戻す。',
          '* 印は自分では終わらないもの。姿勢・伏し目・視線は、次のプリセットを押すか解除するまで保持する。',
          '自動モードもこの表から選ぶので、パネルで押せるものと自動で出るものは同じ語彙になる。',
        ]}
      >
        {PERFORMANCES_BY_GROUP.map((g) => (
          <Field key={g.key} label={PERFORMANCE_GROUPS[g.key] ?? g.label}>
            <ChipRow>
              {g.ids.map((id) => {
                const def = PERFORMANCE_TABLE[id];
                const held = holdsUntilReleased(def);
                return (
                  <Chip
                    key={id}
                    label={held ? `${def.label} *` : def.label}
                    title={`${id}  ${[def.gesture, def.hop].filter(Boolean).join(' + ') || '表情のみ'}`}
                    state={state?.performance === id ? 'on' : 'off'}
                    onClick={() => (state?.performance === id ? rest() : session.perform(id))}
                  />
                );
              })}
            </ChipRow>
          </Field>
        ))}
        <ChipRow>
          <Chip label="解除" variant="action" onClick={rest} />
        </ChipRow>
      </Section>

      <Section
        title="感情"
        meta={composition}
        note={[
          '感情は連続値で、複数を混ぜると中間表情になる。チップは単独指定、スライダーは配合。',
          profile.arkit.supported
            ? '筋肉レベルのシェイプを加算しているので、感情どうしが同じ頂点を奪い合わない。'
            : avatar.emotionShapes
              ? 'このモデルは ARKit 非対応。同じ感情語彙を、モデル自身のシェイプ名で書いた対応表から合成している。部品単位のシェイプなので合成の性質は変わらない。'
              : 'このモデルは ARKit 非対応で、固有の対応表も未作成。優勢な感情ひとつを VRM プリセットに流すだけの縮退動作になっている。',
        ]}
      >
        <ChipRow>
          {MOODS.map((name) => (
            <Chip
              key={name}
              label={EMOTION_LABELS[name] ?? name}
              title={name}
              state={(emotion[name] ?? 0) > 0.5 ? 'auto' : 'off'}
              onClick={() => setMood(name)}
            />
          ))}
          <Chip label="解除" variant="action" onClick={rest} />
          <Chip label="配合" state={mixing ? 'on' : 'off'} onClick={() => setMixing((v) => !v)} />
        </ChipRow>
        {mixing
          ? MOODS.map((name) => (
              <Slider
                key={name}
                label={`${EMOTION_LABELS[name] ?? name}  ${name}`}
                value={emotion[name] ?? 0}
                onChange={(v) => mix(name, v)}
              />
            ))
          : null}
      </Section>

      {director.presets.length ? (
        <Section
          title="描き起こし表情"
          meta={`${director.presets.length}`}
          note={[
            'モデル同梱の完成形の表情。ARKit 合成では作れない目や口の形が含まれるため、合成とは別系統として持つ。選択中は合成側が比例して引く。',
            '塗りつぶしが操作者の選択、枠線だけのものは感情または自動モードが選んだもの。後者は解除できない — 選んでいないものは外せない。',
          ]}
        >
          <ChipRow>
            {director.presets.map((p) => (
              <Chip
                key={p.id}
                label={p.label}
                title={p.id}
                state={
                  state?.pickedExpression === p.id
                    ? 'on'
                    : state?.expression === p.id
                      ? 'auto'
                      : 'off'
                }
                onClick={() =>
                  session.setExpression(state?.pickedExpression === p.id ? null : p.id)
                }
              />
            ))}
            <Chip label="解除" variant="action" onClick={rest} />
          </ChipRow>
        </Section>
      ) : null}

      {director.overlays.length ? (
        <Section
          title="重ねる効果"
          meta={`${director.overlays.length}`}
          note={[
            'ハート目・ぐるぐる目・頬染め・涙といった、合成では作れない描き起こし。表情を置き換えるのではなく上に重なるため、複数を同時に出せる。',
          ]}
        >
          <ChipRow>
            {director.overlays.map((o) => (
              <Chip
                key={o.id}
                label={o.label}
                title={o.id}
                state={(state?.overlays?.[o.id] ?? 0) > 0 ? 'on' : 'off'}
                onClick={() => session.setOverlay(o.id, (state?.overlays?.[o.id] ?? 0) > 0 ? 0 : 1)}
              />
            ))}
            <Chip label="全解除" variant="action" onClick={rest} />
          </ChipRow>
        </Section>
      ) : null}

      <Section
        title="ジェスチャ"
        meta={state?.gesture ?? ''}
        note={[
          '表情を伴わない、体だけの語彙。ふだんはプリセット側から呼ばれる。',
          '再生ごとに速さ・振幅・左右が変わる。切り替えは前の動作をクロスフェードで送る。',
          'ポーズ群は解除するまで保持する。それ以外は自分で終わる。',
          '跳躍は骨格全体を動かすので、腕のジェスチャと同時に走る。',
        ]}
      >
        {GESTURES_BY_GROUP.map((g) => (
          <Field key={g.key} label={GESTURE_GROUPS[g.key] ?? g.label}>
            <ChipRow>
              {g.ids.map((id) => (
                <Chip
                  key={id}
                  label={GESTURES[id].label}
                  title={id}
                  state={state?.gesture === id ? 'auto' : 'off'}
                  onClick={() => session.gesture(id)}
                />
              ))}
            </ChipRow>
          </Field>
        ))}
        <Field label="跳躍">
          <ChipRow>
            {HOP_IDS.map((id) => (
              <Chip key={id} label={HOPS[id].label} title={id} onClick={() => session.hop(id)} />
            ))}
          </ChipRow>
        </Field>
        <ChipRow>
          <Chip label="停止" variant="action" onClick={() => session.stopGesture()} />
        </ChipRow>
      </Section>

      <Section
        title="指さし"
        meta={strain > 0 ? `負担 ${strain.toFixed(2)}` : ''}
        note={[
          '指先の方位・仰角・伸ばしを与えると、肩・肘・手首を逆算する。肘は肩と手首を結ぶ線のまわりを一周できてしまうため、可動域の負担が最小になる位置を探索して決める。',
          '正面から大きく外れた方位では体幹も一緒に向きを変える。可動域を超える指示は失敗せず、届く範囲まで伸ばして止まる — どれだけ無理をしたかは「診る」の関節表に出る。',
        ]}
      >
        <Field label="手">
          <Segmented
            ariaLabel="どちらの手"
            options={SIDES}
            value={side}
            onChange={(v) => {
              setSide(v);
              aim({ side: v });
            }}
          />
        </Field>
        <Field label="指">
          <Segmented
            ariaLabel="どの指"
            options={FINGERS}
            value={finger}
            onChange={(v) => {
              setFinger(v);
              aim({ finger: v });
            }}
          />
        </Field>
        <Slider
          label="方位  azimuth"
          value={azimuth}
          min={-120}
          max={120}
          step={1}
          precision={0}
          unit="°"
          onChange={setAzimuth}
        />
        <Slider
          label="仰角  elevation"
          value={elevation}
          min={-70}
          max={110}
          step={1}
          precision={0}
          unit="°"
          onChange={setElevation}
        />
        <Slider label="伸ばし  extent" value={extent} min={0.2} max={1} onChange={setExtent} />
        <ChipRow>
          <Chip label="指す" variant="primary" onClick={() => aim()} />
          <Chip label="解除" variant="action" onClick={() => session.stopGesture()} />
        </ChipRow>
      </Section>

      <Section
        title="デモ台本"
        meta={avatar.script?.length ? `${avatar.script.length} ターン` : 'なし'}
        note={[
          '台本を 1 行 1 ターンとしてキューに積む。時刻指定はない — 各ターンは前の口パクが終わってから始まる。外部制御 API が受け取るのもこの形。',
        ]}
      >
        <ChipRow>
          <Chip
            label="台本を再生"
            variant="primary"
            disabled={!avatar.script?.length}
            onClick={() => {
              session.interrupt();
              onCamera('bust');
              for (const step of avatar.script ?? []) session.say(step);
            }}
          />
          <Chip label="停止" variant="action" onClick={() => session.interrupt()} />
        </ChipRow>
      </Section>
    </>
  );
}
