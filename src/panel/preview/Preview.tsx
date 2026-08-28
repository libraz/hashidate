import { useEffect, useState } from 'react';
import { type Translator, useT } from '@/i18n';
import type { CameraFrame, Shot, Snapshot } from '@/protocol';
import { Segmented } from '@/ui/Segmented';
import { Toggle } from '@/ui/Toggle';
import { onMonitorShot } from '@/viewer/monitor-link';
import { CAMERA_FRAMES, CAMERA_LABELS } from '@/viewer/scene/framing';
import {
  setBackdrop as sendBackdrop,
  setAvatar,
  setCamera,
  setDebugReadout,
  setIdle,
} from '../api';
import styles from './Preview.module.css';

/**
 * The character, beside the controls that drive it.
 *
 * ## It is a second renderer, and that is not a compromise here
 *
 * Everything else in this panel is deliberately not a renderer — one avatar, one
 * WebGL context, one set of blinks. This is the exception, and the reason it is
 * allowed is that OBS is *already* a second renderer: its browser source runs in
 * its own CEF process, in its own address space, and cannot be observed from
 * this page by any means. There is no single output to mirror. Whatever appears
 * on the stream and whatever appears here are two renders of the same commands
 * either way, so a third one costs nothing that was not already spent.
 *
 * What that means in practice: the state is identical — emotion, expression,
 * performance, gesture, camera, wardrobe, room, and the queue itself, because
 * all of it is command-driven. What differs is the autopilot's improvisation:
 * blink timing, saccades, breathing phase, which idle gesture came up. Those run
 * on `Math.random()` and two renderers do not agree about them. It is a monitor
 * of the performance, not a frame-accurate program feed, and there is no way to
 * make it the latter.
 *
 * ## Always silent, and not by declining to speak
 *
 * The embedded viewer is opened with `?mute=1`, which zeroes the last gain in
 * its audio graph. It still asks for every line and still plays the take: a
 * preview that skipped synthesis would fall back to the text estimate, end its
 * lines at different moments, and drift out of step with the queue it exists to
 * show. It does not cost a second synthesis, because the control server answers
 * every renderer asking for the same line with the same take — see
 * `TAKE_TTL_MS`, which exists for this.
 *
 * It is always silent now that the stage page is the sole in-app renderer
 * allowed to play the voice. There is no local setting to override this, and
 * the old audio preference is deliberately not read: a stale browser storage
 * value cannot make a preview speak again.
 *
 * ## The staging lives here
 *
 * Who is on screen, how they are framed, what is behind them and whether they
 * are moving between lines: four controls an operator reaches for *because of
 * what they can see*, so they sit under the picture rather than in a tab. They
 * are the same four the console keeps above its tabs, for the same reason.
 *
 * ## The picture is also the camera control
 *
 * Drag to swing round the character, wheel to come in. The frame takes the
 * pointer for this, which it deliberately did not before — the reason it did
 * not was that the camera was a property of *that* renderer and dollying it
 * moved a shot the stream did not share. It is shared now: the embedded viewer
 * reads its own camera back and posts it up here, and this turns it into the
 * ordinary `camera` command an orchestrator could have sent, so the renderer on
 * air swings with it. See `monitor-link.ts` and `Shot`.
 *
 * The cost is that a wheel over the picture no longer scrolls the panel. Worth
 * it: the shot is the one thing that can only be judged by looking, and this is
 * the only place in the program where the operator is looking at it.
 */

/**
 * "No backdrop" needs a value, because `Segmented` picks by string and null is
 * not one. A sentinel that never leaves this file.
 */
const NO_BACKDROP = '-';

/** The framing as authored, with the camera standing where it put it. */
const STRAIGHT_ON: Required<Shot> = { frame: 'bust', yaw: 0, pitch: 0, zoom: 1 };

/** How far off the framing the camera is, short enough to sit on a button. */
const describe = (shot: Required<Shot>, t: Translator['t']): string =>
  [
    shot.yaw === 0
      ? ''
      : `${t(shot.yaw > 0 ? 'panel.preview.shot.right' : 'panel.preview.shot.left')}${Math.abs(shot.yaw).toFixed(0)}°`,
    shot.pitch === 0
      ? ''
      : `${t(shot.pitch > 0 ? 'panel.preview.shot.up' : 'panel.preview.shot.down')}${Math.abs(shot.pitch).toFixed(0)}°`,
    shot.zoom === 1 ? '' : `${shot.zoom.toFixed(2)}×`,
  ]
    .filter(Boolean)
    .join(' ');

/** Survives a reload: hiding the preview is a deliberate choice. */
const SHOWN_KEY = 'hashidate.panel.preview';

/**
 * How long a report of blocked audio keeps the warning up.
 *
 * Every renderer reports into the same slot, so with several of them — this
 * preview, the stage window in the native shell, and whatever is on air — a
 * flag that is true for only one of them alternates at the reporting interval.
 * Held, the warning reads as a state rather than flashing; it clears a few
 * reports after the last blocked one, and being a little late to disappear
 * costs nothing next to being unreadable. It has to outlast one round of every
 * attached renderer reporting, which is what the number is: a renderer reports
 * about three times in this window.
 */
const BLOCKED_HOLD_MS = 2500;

function useHeld(flag: boolean, ms: number): boolean {
  const [held, setHeld] = useState(flag);
  useEffect(() => {
    if (flag) {
      setHeld(true);
      return;
    }
    const timer = setTimeout(() => setHeld(false), ms);
    return () => clearTimeout(timer);
  }, [flag, ms]);
  return held;
}

const readStored = (key: string, fallback: boolean): boolean => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    // Private browsing, or storage disabled.
    return fallback;
  }
};

const store = (key: string, value: boolean): void => {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* nothing to persist to */
  }
};

export function Preview({ snapshot, refresh }: { snapshot: Snapshot; refresh: () => void }) {
  const { t, tx } = useT();
  const [on, setOn] = useState(() => readStored(SHOWN_KEY, true));
  /**
   * The measurements, held rather than followed, and not stored anywhere.
   *
   * Held for the reason the set below is: nothing reports it back. Not stored
   * because this is a thing switched on to answer a question. A panel
   * that came back from a reload still holding it would eventually be a panel
   * with a terminal drawn over the picture that nobody remembers asking for,
   * and the renderer on air would have gone back to clean without it.
   */
  const [measured, setMeasured] = useState(false);

  useEffect(() => store(SHOWN_KEY, on), [on]);

  const avatar = snapshot.vocabulary.avatar?.id ?? null;
  const speaking = snapshot.state.speaking ?? false;
  const blocked = useHeld(snapshot.voice?.blocked ?? false, BLOCKED_HOLD_MS);
  const backdrops = snapshot.vocabulary.backdrops ?? [];
  const idle = snapshot.state.idleEnabled ?? false;

  /**
   * The set, held rather than followed.
   *
   * The renderer reports what it is *doing* — speaking, posing, wearing — and
   * not what it is standing in front of, so there is nothing to follow. Holding
   * the choice made here is what the console does with the same control and for
   * the same reason: a set is chosen a handful of times in a session, and until
   * one is chosen nothing is lit rather than the wrong thing being lit.
   */
  const [backdrop, setBackdrop] = useState<string | null>(null);

  /**
   * The shot, which this panel is the authority on.
   *
   * Held for the same reason the set above is — nothing reports it back — but
   * for a stronger one too: this is where it is *set*. The framing buttons name
   * one, the pointer over the picture moves off it, and both end in the same
   * `camera` command. An orchestrator that moves the camera itself leaves this
   * stale, which is the same trade every held control here makes.
   */
  const [shot, setShot] = useState<Required<Shot>>(STRAIGHT_ON);

  /**
   * What the drag produced, coming back out of the picture.
   *
   * The preview reads its own camera and posts it up; this turns it into the
   * ordinary command an orchestrator could have sent. Rate-limited inside the
   * frame — see `SHOT_INTERVAL` in the runtime — so this fires about ten times
   * a second while a drag is happening and once when it settles.
   */
  useEffect(() => {
    if (!on) return;
    return onMonitorShot((moved) => {
      setShot(moved);
      void setCamera(moved);
    });
  }, [on]);

  /** Name a framing, keeping wherever the operator is standing to see it. */
  const frameAt = (next: CameraFrame): void => {
    setShot((prev) => ({ ...prev, frame: next }));
    void setCamera({ frame: next });
  };

  const straightOn = (): void => {
    setShot((prev) => ({ ...STRAIGHT_ON, frame: prev.frame }));
    void setCamera({ yaw: 0, pitch: 0, zoom: 1 });
  };

  const moved = shot.yaw !== 0 || shot.pitch !== 0 || shot.zoom !== 1;

  return (
    <section className={styles.preview}>
      <div className={styles.head}>
        <span className={styles.title}>{t('panel.preview.title')}</span>
        {/* The same readout `?debug=1` opens on, and an ordinary command — so it
            goes to every renderer attached, this preview included. That is the
            point: the question it answers is nearly always about the picture
            going to air, and the preview then shows what that picture looks
            like because it is a second renderer of the same commands. It is
            never folded into the standing setup, so a renderer that reloads
            comes back clean; see `debugCommandSchema`. */}
        <button
          type="button"
          className={`${styles.toggle} ${measured ? styles.armed : ''}`}
          aria-pressed={measured}
          onClick={() => {
            const next = !measured;
            setMeasured(next);
            void setDebugReadout(next);
          }}
          title={t(
            measured ? 'panel.preview.readout.hideTitle' : 'panel.preview.readout.showTitle',
          )}
        >
          {t(measured ? 'panel.preview.readout.on' : 'panel.preview.readout.off')}
        </button>
        <button
          type="button"
          className={styles.toggle}
          aria-pressed={on}
          onClick={() => setOn((v) => !v)}
          title={t(on ? 'panel.preview.hideTitle' : 'panel.preview.showTitle')}
        >
          {t(on ? 'panel.preview.hide' : 'panel.preview.show')}
        </button>
      </div>

      <div className={`${styles.frame} ${speaking ? styles.live : ''}`}>
        {on ? (
          <iframe
            // Keyed on the avatar so a swap reloads the preview rather than
            // leaving it on the character that is no longer loaded. The embedded
            // viewer picks its avatar from its own stored selection, which is
            // only read at load.
            key={avatar ?? 'none'}
            className={styles.canvas}
            // No `?size`: the canvas matches the element. A browser source is
            // pinned to a pixel size so nothing resamples it; a monitor on a
            // window somebody resizes wants the opposite.
            src="/?mute=1"
            title={t('panel.preview.frameTitle')}
            // The picture takes the pointer, and that is the whole point of it
            // now: drag to swing round the character, wheel to come in. What
            // the drag produces is read back and sent as an ordinary `camera`
            // command, so the renderer on air moves with it. The cost is that a
            // wheel over the picture no longer scrolls the panel — worth it,
            // since the shot is the one thing judged by looking.
            tabIndex={-1}
          />
        ) : (
          <p className={styles.off}>{t('panel.preview.stopped')}</p>
        )}
      </div>

      {/* Not a control, and deliberately not dismissible: nothing sent from this
          panel can clear it. A browser will not start an audio device until the
          page it is on has been interacted with, so a viewer nobody has clicked
          mouths every line in silence — and from here that looks exactly like a
          speech sidecar that is not running. */}
      {blocked ? <p className={styles.blocked}>{t('panel.preview.blocked')}</p> : null}

      <div className={styles.staging}>
        {/* Who is on screen. The renderer holds every command sent behind a swap
            until the model is standing, so the tab below can be used the moment
            this is clicked rather than after the picture comes back. */}
        {snapshot.avatars.length > 1 ? (
          <Segmented
            ariaLabel={t('panel.preview.avatarAria')}
            options={snapshot.avatars.map((a) => ({ value: a.id, label: tx(a.label) }))}
            value={avatar}
            onChange={(id) => void setAvatar(id).then(refresh)}
          />
        ) : null}

        <div className={styles.shot}>
          <Segmented
            ariaLabel={t('panel.preview.cameraAria')}
            options={CAMERA_FRAMES.map((f) => ({ value: f, label: tx(CAMERA_LABELS[f]) }))}
            value={shot.frame}
            onChange={frameAt}
          />
          {/* Only offered once there is something to undo, and it undoes only
              the offsets: the framing is a choice, standing off it is a nudge. */}
          <button
            type="button"
            className={styles.reset}
            disabled={!moved}
            onClick={straightOn}
            title={t('panel.preview.straightOn.title')}
          >
            {moved
              ? t('panel.preview.straightOnFrom', { offset: describe(shot, t) })
              : t('panel.preview.straightOn')}
          </button>
        </div>

        {backdrops.length ? (
          <Segmented
            ariaLabel={t('panel.preview.backdropAria')}
            options={[
              {
                value: NO_BACKDROP,
                label: t('panel.preview.backdropNone'),
                title: t('panel.preview.backdropNone.title'),
              },
              ...backdrops.map((b) => ({ value: b.id, label: tx(b.label) })),
            ]}
            value={backdrop ?? NO_BACKDROP}
            onChange={(id) => {
              const next = id === NO_BACKDROP ? null : id;
              setBackdrop(next);
              void sendBackdrop(next);
            }}
          />
        ) : null}

        <Toggle
          label={t('panel.preview.idle')}
          checked={idle}
          onChange={(v) => void setIdle(v).then(refresh)}
        />
      </div>
    </section>
  );
}
