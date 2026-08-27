import { useEffect, useState } from 'react';
import type { AvatarDescriptor } from '@/engine/types';
import styles from './Hud.module.css';
import type { AvatarRuntime, Hud as HudData } from './runtime';

/**
 * The on-canvas readout.
 *
 * Sampled at 8 Hz by the runtime rather than driven from the frame loop: this
 * is text, and re-reconciling it sixty times a second buys nothing a person can
 * see while costing frames the simulation wants.
 */
export function Hud({ runtime, avatar }: { runtime: AvatarRuntime; avatar: AvatarDescriptor }) {
  const [hud, setHud] = useState<HudData | null>(null);
  useEffect(() => runtime.onHud(setHud), [runtime]);

  if (!hud) return null;

  return (
    <div className={styles.hud}>
      <div className={styles.facts}>
        <span className={styles.fact}>
          <b>{hud.fps}</b> fps
        </span>
        <span className={styles.fact}>{avatar.label}</span>
        <span className={styles.fact}>{hud.channel}</span>
        <span className={styles.fact}>
          morph <b>{hud.morphs}</b>
        </span>
        <span className={styles.fact}>
          揺れ <b>{hud.sway ?? 'off'}</b>
        </span>
      </div>

      <div className={styles.meters}>
        <Meter label="呼吸" value={hud.breath} readout={`${Math.round(hud.breath * 100)}%`} />
        <Meter label="瞬き" value={hud.blink} readout={hud.blink.toFixed(2)} />
        <Meter
          label="視線"
          value={hud.gazeX}
          centred
          readout={`${hud.gazeX >= 0 ? '+' : ''}${hud.gazeX.toFixed(2)}`}
        />
      </div>

      <div className={styles.state}>
        {hud.speaking ? (
          <span className={styles.live}>
            <span className={styles.dot} />
            ON AIR
          </span>
        ) : (
          <span className={styles.idle}>待機</span>
        )}
        {/* The one readout here that asks for something. Everything else is a
            measurement; this says the browser will not start the audio device
            until somebody clicks this page, which no command can do for it. */}
        {hud.voiceBlocked ? (
          <span className={styles.blocked} title="ブラウザが操作されるまで音声を再生できません">
            音声ブロック中 — この画面をクリック
          </span>
        ) : null}
        {hud.gesture ? <span className={styles.tag}>{hud.gesture}</span> : null}
        {hud.expression ? <span className={styles.tag}>{hud.expression}</span> : null}
        {hud.auto ? <span className={styles.auto}>自動</span> : null}
      </div>
    </div>
  );
}

/**
 * `centred` puts zero in the middle of the track and lets the bar grow either
 * way, which the gaze needs and the other two do not: a bar that always grows
 * from the left cannot say which way the eyes went.
 */
function Meter({
  label,
  value,
  readout,
  centred = false,
}: {
  label: string;
  value: number;
  readout: string;
  centred?: boolean;
}) {
  // The gaze channel is radians and small — ±0.5 covers everything the limits
  // allow, so that is what the track spans.
  const span = centred ? 0.5 : 1;
  const magnitude = Math.min(1, Math.abs(value) / span);
  const style = centred
    ? { left: value >= 0 ? '50%' : `${50 - magnitude * 50}%`, width: `${magnitude * 50}%` }
    : { left: 0, width: `${magnitude * 100}%` };

  return (
    <>
      <span className={styles.meterLabel}>{label}</span>
      <span className={`${styles.track} ${centred ? styles.centred : ''}`}>
        {centred ? <span className={styles.tick} /> : null}
        <span className={styles.fill} style={style} />
      </span>
      <span className={styles.meterValue}>{readout}</span>
    </>
  );
}
