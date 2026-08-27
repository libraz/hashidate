import { useEffect, useRef, useState } from 'react';
import { TUNING_RANGES, type Tuning, type TuningPatch } from '@/engine/tuning';
import type { Snapshot } from '@/protocol';
import { Chip, ChipRow } from '@/ui/Chip';
import { Section } from '@/ui/Section';
import { Slider } from '@/ui/Slider';
import { Toggle } from '@/ui/Toggle';
import { tune } from '../api';

/**
 * Everything that is set once and left.
 *
 * ## Why these are reachable from here at all
 *
 * They used to be reachable only from the console, by writing onto the live
 * engine objects — which is fine while the renderer is the screen being worked
 * in front of, and useless once the renderer is a browser source opened at the
 * top of the broadcast. Naming the layer on the wire is what lets it be moved
 * from the other side of the control API, and the preview above is what makes
 * moving it there worth doing: the numbers are judged by watching a render, and
 * there is one on this page.
 *
 * ## The faders are held locally once they are touched
 *
 * The value comes from the renderer's report, which arrives twice a second. A
 * fader bound straight to that would jump back under the pointer between the
 * drag and the next poll, so the reported figures seed a local copy and the
 * local copy wins from then on. It is re-seeded when the avatar changes, because
 * every default below belongs to the model that is loaded.
 *
 * That is the same trade the console makes and it has the same cost: a value
 * moved by something other than this panel is not followed. Nothing else moves
 * them during a broadcast — which is exactly what makes them the set-once layer.
 */

interface Props {
  snapshot: Snapshot;
}

export function TuneTab({ snapshot }: Props) {
  const reported = snapshot.tuning;
  const avatar = snapshot.vocabulary.avatar?.id ?? null;

  const [draft, setDraft] = useState<Tuning | null>(reported);
  /** Which avatar the draft describes, so a swap re-seeds it. */
  const seededFor = useRef<string | null>(avatar);

  useEffect(() => {
    if (!reported) return;
    if (draft && seededFor.current === avatar) return;
    seededFor.current = avatar;
    setDraft(reported);
  }, [reported, draft, avatar]);

  if (!draft) {
    return (
      <Section title="調律">
        <p>レンダラーがまだ何も報告していない。ビューアを開くと値が入る。</p>
      </Section>
    );
  }

  /** Move one fader: locally first so it tracks the pointer, then on the wire. */
  const set = (patch: TuningPatch): void => {
    setDraft((prev) => (prev ? merge(prev, patch) : prev));
    void tune(patch);
  };

  const R = TUNING_RANGES;

  return (
    <>
      <Section
        title="アイドル"
        note={[
          '呼吸と重心移動はジェスチャ中も止まらない。手を上げた瞬間に呼吸が止まるキャラクターは人形に見える。',
          'まばたきは視線移動に引き寄せられる。目の可動域は白目が出ない範囲に絞ってあり、向きを変えるのはほぼ頭の仕事になる。',
        ]}
      >
        <Fader
          label="呼吸の深さ"
          range={R.idle.breathDepth}
          value={draft.idle.breathDepth}
          onChange={(breathDepth) => set({ idle: { breathDepth } })}
        />
        <Fader
          label="呼吸の周期"
          range={R.idle.breathPeriod}
          value={draft.idle.breathPeriod}
          onChange={(breathPeriod) => set({ idle: { breathPeriod } })}
        />
        <Fader
          label="頭のマイクロムーブ"
          range={R.idle.idleAmount}
          value={draft.idle.idleAmount}
          onChange={(idleAmount) => set({ idle: { idleAmount } })}
        />
        <Fader
          label="重心移動"
          range={R.idle.weightShift}
          value={draft.idle.weightShift}
          onChange={(weightShift) => set({ idle: { weightShift } })}
        />
        <Fader
          label="視線のゆらぎ"
          range={R.idle.gazeAmount}
          value={draft.idle.gazeAmount}
          onChange={(gazeAmount) => set({ idle: { gazeAmount } })}
        />
        <Fader
          label="目の可動限界"
          range={R.idle.eyeLimit}
          value={draft.idle.eyeLimit}
          onChange={(eyeLimit) => set({ idle: { eyeLimit } })}
        />
        <Toggle
          label="自動まばたき"
          checked={draft.idle.blink}
          onChange={(blink) => set({ idle: { blink } })}
        />
      </Section>

      {draft.has.sway ? (
        <Section
          title="揺れもの"
          note={[
            '髪・衣装・リボンなど、駆動されず親に遅れて揺れるだけのボーン。倍率はモデルに書かれた値に対するもの。',
            '固定ステップで解いているので、フレームレートが変わっても揺れ幅は変わらない。',
          ]}
        >
          <Toggle
            label="揺れを有効にする"
            checked={draft.sway.enabled}
            onChange={(enabled) => set({ sway: { enabled } })}
          />
          <Fader
            label="硬さ"
            range={R.sway.stiffness}
            value={draft.sway.stiffness}
            onChange={(stiffness) => set({ sway: { stiffness } })}
          />
          <Fader
            label="揺れの持続"
            range={R.sway.inertia}
            value={draft.sway.inertia}
            onChange={(inertia) => set({ sway: { inertia } })}
          />
          <Fader
            label="重力"
            range={R.sway.gravity}
            value={draft.sway.gravity}
            onChange={(gravity) => set({ sway: { gravity } })}
          />
          {/* Not a value and so not part of the readout: it snaps the chains to
              rest so that two settings can be compared from the same standstill. */}
          <ChipRow>
            <Chip label="静止させる" variant="action" onClick={() => void tune({ settle: true })} />
          </ChipRow>
        </Section>
      ) : null}

      <Section
        title="跳躍"
        note={[
          '揺れものが正しく調整されているか見るための動き。呼吸では分からないことが着地の一瞬で分かる。',
          '高さと重力だけで弧が決まる。重力を下げると同じ高さのまま頂点で浮く。',
          '脚はリグに含まれないので、バストアップか上半身の画角で見ること。',
        ]}
      >
        <Fader
          // Centimetres here and metres on the wire. A jump is stated in the one
          // and stored in the other; see `TUNING_RANGES`.
          label="跳ぶ高さ"
          range={{ ...R.hop.height, min: R.hop.height.min * 100, max: R.hop.height.max * 100 }}
          value={draft.hop.height * 100}
          step={1}
          precision={0}
          unit="cm"
          onChange={(cm) => set({ hop: { height: cm / 100 } })}
        />
        <Fader
          label="重力"
          range={R.hop.gravity}
          value={draft.hop.gravity}
          onChange={(gravity) => set({ hop: { gravity } })}
        />
      </Section>

      {draft.has.tail ? (
        <Section
          title="尻尾"
          note={[
            '尻尾は腰にぶら下がっているだけなので、揺れもの層に任せると止まって見える。感情から振りを決めて根元を能動的に振り、その先は揺れもの層が追う。',
          ]}
        >
          <Fader
            label="振りの大きさ"
            range={R.tail.amount}
            value={draft.tail.amount}
            onChange={(amount) => set({ tail: { amount } })}
          />
        </Section>
      ) : null}

      <Section
        title="描画"
        note={[
          'トゥーンを切ると、GLB が持ってきたマテリアルそのままになる。モデルがおかしいのかシェーダーがおかしいのかを切り分けるためのもの。',
          ...(draft.has.arkit
            ? [
                'ARKit 合成を切ると VRM プリセットに落ちる。プリセットは顔全体の彫刻なので同時にひとつしか出せない — 縮退動作の確認用。',
              ]
            : []),
        ]}
      >
        <Toggle
          label="トゥーン表示"
          checked={draft.render.toon}
          onChange={(toon) => set({ render: { toon } })}
        />
        {/* Only offered where there is something to switch between: on an avatar
            with no ARKit shapes the toggle has no effect, and a dead control
            reads as a bug. */}
        {draft.has.arkit ? (
          <Toggle
            label="表情を ARKit 合成で駆動"
            checked={draft.render.arkit}
            onChange={(arkit) => set({ render: { arkit } })}
          />
        ) : null}
      </Section>
    </>
  );
}

/** A fader stated by the range table, so the panel cannot sweep past the wire. */
function Fader({
  label,
  range,
  value,
  onChange,
  step,
  precision,
  unit,
}: {
  label: string;
  range: { min: number; max: number; step: number; precision: number; unit: string };
  value: number;
  onChange: (value: number) => void;
  step?: number;
  precision?: number;
  unit?: string;
}) {
  return (
    <Slider
      label={label}
      value={value}
      min={range.min}
      max={range.max}
      step={step ?? range.step}
      precision={precision ?? range.precision}
      unit={unit ?? range.unit}
      onChange={onChange}
    />
  );
}

/**
 * Fold a patch onto the held copy, one group at a time.
 *
 * Only the groups the patch names are rebuilt; `has` and everything untouched
 * come through as they were. `settle` never reaches here — it moves nothing.
 */
function merge(base: Tuning, patch: TuningPatch): Tuning {
  return {
    idle: { ...base.idle, ...patch.idle },
    sway: { ...base.sway, ...patch.sway },
    hop: { ...base.hop, ...patch.hop },
    tail: { ...base.tail, ...patch.tail },
    render: { ...base.render, ...patch.render },
    has: base.has,
  };
}
