import { type Dispatch, type SetStateAction, useRef, useState } from 'react';
import type { GazeLimits } from '@/engine/types';
import type { AvatarRuntime, LoadedAvatar } from '../../scene/runtime';
import { Chip, ChipRow } from '../../ui/Chip';
import { Section } from '../../ui/Section';
import { Slider } from '../../ui/Slider';
import { Toggle } from '../../ui/Toggle';

/**
 * Everything that is set once and left.
 *
 * These write straight onto the engine objects, which hold the authoritative
 * value; the component mirrors them in local state only so the fader has
 * something to render. Nothing here is polled, because nothing else writes
 * them — unlike the emotion vector on the performance tab, which the autopilot
 * also moves.
 */
export function TuneTab({
  loaded,
  runtime,
}: {
  loaded: LoadedAvatar;
  runtime: AvatarRuntime | null;
}) {
  const { director, profile } = loaded;
  const { body, spring, tail } = director;

  // The gaze limits are profile data and are scaled rather than replaced, so
  // the multiplier needs the avatar's own measured figures to scale *from*.
  // Captured per avatar, since a swap rebuilds the profile under us.
  const baseGaze = useRef<{ id: string; limits: GazeLimits }>({
    id: loaded.avatar.id,
    limits: { ...profile.gaze },
  });
  if (baseGaze.current.id !== loaded.avatar.id) {
    baseGaze.current = { id: loaded.avatar.id, limits: { ...profile.gaze } };
  }

  const [breathDepth, setBreathDepth] = useState(body.breathDepth);
  const [breathPeriod, setBreathPeriod] = useState(body.breathPeriod);
  const [idleAmount, setIdleAmount] = useState(body.idleAmount);
  const [weightShift, setWeightShift] = useState(body.weightShift);
  const [lookAt, setLookAt] = useState(body.lookAt);
  const [gazeAmount, setGazeAmount] = useState(body.gazeAmount);
  const [eyeLimit, setEyeLimit] = useState(1);
  const [blinkEnabled, setBlinkEnabled] = useState(director.blinkEnabled);

  const [swayEnabled, setSwayEnabled] = useState(spring.enabled);
  const [stiffness, setStiffness] = useState(spring.stiffnessScale);
  const [inertia, setInertia] = useState(spring.inertiaScale);
  const [swayGravity, setSwayGravity] = useState(spring.gravityScale);

  const [jumpHeight, setJumpHeight] = useState(body.jumpHeight * 100);
  const [gravity, setGravity] = useState(body.gravity);
  const [tailAmount, setTailAmount] = useState(tail.amount);

  const [toon, setToon] = useState(runtime?.toonEnabled ?? true);
  const [useArkit, setUseArkit] = useState(director.useArkit);

  /**
   * Mirror into local state and write through to the engine in one step.
   *
   * The engine object is the authoritative value; the local copy exists only so
   * the fader has something to render between repaints.
   */
  const set =
    <T,>(mirror: Dispatch<SetStateAction<T>>, apply: (v: T) => void) =>
    (v: T) => {
      mirror(v);
      apply(v);
    };

  return (
    <>
      <Section
        title="アイドル"
        note={[
          '呼吸と重心移動はジェスチャ中も止まらない。手を上げた瞬間に呼吸が止まる character は人形に見える。',
          'まばたきは視線移動に引き寄せられる。目の可動域は白目が出ない範囲に絞ってあり、限界へは漸近するだけで到達しない — 向きを変えるのはほぼ頭の仕事になる。',
        ]}
      >
        <Slider
          label="呼吸の深さ"
          value={breathDepth}
          max={2}
          onChange={set(setBreathDepth, (v) => {
            body.breathDepth = v;
          })}
        />
        <Slider
          label="呼吸の周期"
          value={breathPeriod}
          min={2}
          max={8}
          step={0.1}
          precision={1}
          unit="s"
          onChange={set(setBreathPeriod, (v) => {
            body.breathPeriod = v;
          })}
        />
        <Slider
          label="頭のマイクロムーブ"
          value={idleAmount}
          max={2}
          onChange={set(setIdleAmount, (v) => {
            body.idleAmount = v;
          })}
        />
        <Slider
          label="重心移動"
          value={weightShift}
          max={2}
          onChange={set(setWeightShift, (v) => {
            body.weightShift = v;
          })}
        />
        <Slider
          label="カメラ目線"
          value={lookAt}
          onChange={set(setLookAt, (v) => {
            body.lookAt = v;
          })}
        />
        <Slider
          label="視線のゆらぎ"
          value={gazeAmount}
          max={2}
          onChange={set(setGazeAmount, (v) => {
            body.gazeAmount = v;
          })}
        />
        <Slider
          label="目の可動限界"
          value={eyeLimit}
          min={0.2}
          max={2}
          step={0.05}
          onChange={set(setEyeLimit, (v) => {
            profile.gaze.eyeYaw = baseGaze.current.limits.eyeYaw * v;
            profile.gaze.eyePitch = baseGaze.current.limits.eyePitch * v;
          })}
        />
        <Toggle
          label="自動まばたき"
          checked={blinkEnabled}
          onChange={set(setBlinkEnabled, (v) => {
            director.blinkEnabled = v;
          })}
        />
      </Section>

      {spring.active ? (
        <Section
          title="揺れもの"
          meta={`${spring.groups.length}系統 ${spring.count}ジョイント`}
          note={[
            '髪・衣装・リボンなど、駆動されず親に遅れて揺れるだけのボーン。1/60 秒固定ステップで解いているので、フレームレートが変わっても揺れ幅は変わらない。',
            `倍率のスライダーはモデルに書かれた値に対するもの。系統: ${spring.groups
              .map((g) => `${g.label} ${g.joints.length}`)
              .join('・')}`,
            ...(spring.missing.length ? [`未解決: ${spring.missing.join(' / ')}`] : []),
          ]}
        >
          <Toggle
            label="揺れを有効にする"
            checked={swayEnabled}
            onChange={set(setSwayEnabled, (v) => {
              spring.enabled = v;
            })}
          />
          <Slider
            label="硬さ"
            value={stiffness}
            min={0.2}
            max={3}
            step={0.05}
            onChange={set(setStiffness, (v) => {
              spring.stiffnessScale = v;
            })}
          />
          <Slider
            label="揺れの持続"
            value={inertia}
            max={1.6}
            step={0.05}
            onChange={set(setInertia, (v) => {
              spring.inertiaScale = v;
            })}
          />
          <Slider
            label="重力"
            value={swayGravity}
            max={4}
            step={0.1}
            precision={1}
            onChange={set(setSwayGravity, (v) => {
              spring.gravityScale = v;
            })}
          />
          <ChipRow>
            <Chip label="静止させる" variant="action" onClick={() => spring.reset()} />
          </ChipRow>
        </Section>
      ) : null}

      <Section
        title="跳躍"
        note={[
          '揺れものが正しく調整されているかを見るための機能。呼吸は胸を数ミリ動かすだけで、チェーンが生きているかは分かっても、よく調整されているかは分からない。着地の一瞬がそれを決める。',
          '高さと重力だけで弧が決まる（v₀=√(2gh)、滞空=2v₀/g）。質量は自由飛行では打ち消し合うので要らない。重力を下げると同じ高さのまま頂点で浮く。',
          '脚はリグに含まれないので、沈み込みで足が床に潜り滞空中は浮く。バストアップか上半身の画角で見ること。',
        ]}
      >
        <Slider
          label="跳ぶ高さ"
          value={jumpHeight}
          min={1}
          max={30}
          step={1}
          precision={0}
          unit="cm"
          onChange={set(setJumpHeight, (v) => {
            body.jumpHeight = v / 100;
          })}
        />
        <Slider
          label="重力"
          value={gravity}
          min={1.5}
          max={20}
          step={0.1}
          precision={1}
          unit="m/s²"
          onChange={set(setGravity, (v) => {
            body.gravity = v;
          })}
        />
        <ChipRow>
          <Chip label="小さく跳ぶ" variant="primary" onClick={() => director.jump()} />
        </ChipRow>
      </Section>

      {tail.active ? (
        <Section
          title="尻尾"
          note={[
            '尻尾は腰にぶら下がっているだけなので、揺れもの層に任せると入力がなく止まって見える。感情ベクトルから振りの速さ・幅・高さを決めて根元を能動的に振り、その先は揺れもの層が遅れて追う。',
            '喜びは速く広く、悲しみは下がってほぼ止まり、驚きは振らずに立つ。',
          ]}
        >
          <Slider
            label="振りの大きさ"
            value={tailAmount}
            max={4}
            step={0.05}
            onChange={set(setTailAmount, (v) => {
              tail.amount = v;
            })}
          />
        </Section>
      ) : null}

      <Section
        title="描画"
        note={[
          'トゥーンを切ると、GLB が持ってきたマテリアルそのままになる。両面描画とアルファの扱いはどちらの経路でも同じ規則で直している。',
          ...(profile.arkit.supported
            ? [
                'ARKit 合成を切ると VRM プリセットに落ちる。プリセットは顔全体の彫刻なので同時にひとつしか出せず、混ぜると崩れる — 縮退動作がどう見えるかの確認用。',
              ]
            : []),
        ]}
      >
        <Toggle
          label="トゥーン表示"
          checked={toon}
          onChange={set(setToon, (v) => runtime?.setToon(v))}
        />
        {/* Only offered where there is something to switch between. On an avatar
            with no ARKit the toggle has no effect, and a dead control reads as
            a bug. */}
        {profile.arkit.supported ? (
          <Toggle
            label="表情を ARKit 合成で駆動"
            checked={useArkit}
            onChange={set(setUseArkit, (v) => {
              director.useArkit = v;
            })}
          />
        ) : null}
      </Section>
    </>
  );
}
