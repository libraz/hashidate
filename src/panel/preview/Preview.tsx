import { useEffect, useMemo, useState } from 'react';
import { type MessageKey, type Translator, useT } from '@/i18n';
import type { CameraFrame, Shot, Snapshot } from '@/protocol';
import { Segmented } from '@/ui/Segmented';
import { Toggle } from '@/ui/Toggle';
import { CAMERA_FRAMES, CAMERA_LABELS } from '@/viewer/scene/framing';
import {
  place,
  setBackdrop as sendBackdrop,
  setAvatar,
  setCamera,
  setDebugReadout,
  setIdle,
} from '../api';
import { Picture } from './Picture';
import styles from './Preview.module.css';
import { SpeakingLine } from './SpeakingLine';
import { throttleShots } from './shot-drag';

/**
 * The character, beside the controls that drive it.
 *
 * ## The stage's picture when there is one, a renderer of its own when not
 *
 * With a stage window up in the same browser profile — the native shell — the
 * picture is that window's own frame, sent across (`src/viewer/stage-feed.ts`),
 * and this panel renders nothing. Otherwise it falls back to a second renderer
 * of the same commands, as OBS's browser source already is. That one agrees on
 * every command-driven state and on the idle's picks, which the server makes
 * once for every renderer, but not on what runs on `Math.random()` — blinks,
 * saccades, breathing phase, each gesture's small variation — which is why the
 * feed is preferred and why the picture says which of the two it is showing.
 *
 * ## Always silent, and not by declining to speak
 *
 * The fallback viewer is opened with `?mute=1`, which zeroes the last gain in
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
 * what they can see*, so they sit under the picture on the stage rather than in
 * the inspector. They
 * are the same four the console keeps above its tabs, for the same reason.
 *
 * ## The picture is also the camera control
 *
 * Drag to swing round the character, wheel to come in. The panel reads the
 * pointer itself and sends the ordinary `camera` command an orchestrator could
 * have sent, so every renderer swings with it — the same whether the picture is
 * the stage's feed, which has no camera to drag, or the fallback renderer, which
 * no longer takes the pointer. See `shot-drag.ts` and `Shot`.
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

/**
 * Why the picture is empty, or null when it should not be.
 *
 * Said here, over the panel's own copy, because the renderer going to air says
 * nothing on purpose — whatever it printed would be on the stream. An empty
 * roster is the state a fresh checkout is in, so it is answered with where a
 * model goes rather than treated as a fault. Offline outranks the rest: with no
 * server every other field is the empty snapshot's, not the truth.
 */
export function previewNotice(
  snapshot: Snapshot,
  offline: boolean,
): { key: MessageKey; error?: string } | null {
  if (offline) return { key: 'panel.preview.empty.offline' };
  if (snapshot.avatars.length === 0) return { key: 'panel.preview.empty.noAvatar' };
  if (snapshot.avatar?.phase === 'loading') return { key: 'panel.preview.empty.loading' };
  if (snapshot.avatar?.phase === 'failed') {
    return { key: 'panel.preview.empty.failed', error: snapshot.avatar.error ?? '' };
  }
  return null;
}

export function Preview({
  snapshot,
  offline,
  refresh,
}: {
  snapshot: Snapshot;
  offline: boolean;
  refresh: () => void;
}) {
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
  const notice = previewNotice(snapshot, offline);
  const blocked = useHeld(snapshot.voice?.blocked ?? false, BLOCKED_HOLD_MS);
  const backdrops = snapshot.vocabulary.backdrops ?? [];
  const idle = snapshot.state.idleEnabled ?? false;
  // Read back rather than held, unlike the readout: the layout is reported.
  const hidden = snapshot.placement?.avatar.visible === false;

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

  /** What the drag produced, sent about ten times a second and once when it settles. */
  const shots = useMemo(() => throttleShots((moved) => void setCamera(moved)), []);
  useEffect(() => () => shots.cancel(), [shots]);
  const dragged = (moved: Required<Shot>): void => {
    setShot(moved);
    shots.push(moved);
  };

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
          <Picture avatar={avatar} shot={shot} onShot={dragged} />
        ) : (
          <p className={styles.off}>{t('panel.preview.stopped')}</p>
        )}
        {on && notice !== null ? (
          <p className={styles.empty} role="status">
            {t(notice.key, notice.error === undefined ? undefined : { error: notice.error })}
          </p>
        ) : null}
      </div>

      {/* Under the picture and inside this block, so it is carried by the same
          sticky column and is on screen whichever tab is up. See
          `SpeakingLine`, which is also why it is here rather than beside the
          queue's own on-air strip. */}
      <SpeakingLine snapshot={snapshot} />

      {/* Not a control, and deliberately not dismissible: nothing sent from this
          panel can clear it. A browser will not start an audio device until the
          page it is on has been interacted with, so a viewer nobody has clicked
          mouths every line in silence — and from here that looks exactly like a
          speech sidecar that is not running. */}
      {blocked ? <p className={styles.blocked}>{t('panel.preview.blocked')}</p> : null}

      {/*
        Named, and each name sits over its control rather than beside it: the
        stage is wide and the four tracks are long, so a label column would
        spend a strip of the picture's width on four words. Laid out in a grid
        that puts two side by side once there is room for both.
      */}
      <div className={styles.staging}>
        {/* Who is on screen. The renderer holds every command sent behind a swap
            until the model is standing, so the tab beside this can be used the
            moment it is clicked rather than after the picture comes back. */}
        {snapshot.avatars.length > 1 ? (
          <div className={`${styles.cell} ${styles.wide}`}>
            <span className={styles.cellLabel}>{t('panel.preview.avatarAria')}</span>
            <Segmented
              ariaLabel={t('panel.preview.avatarAria')}
              options={snapshot.avatars.map((a) => ({ value: a.id, label: tx(a.label) }))}
              value={avatar}
              onChange={(id) => void setAvatar(id).then(refresh)}
            />
          </div>
        ) : null}

        <div className={styles.cell}>
          <span className={styles.cellLabel}>{t('panel.preview.cameraAria')}</span>
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
        </div>

        {backdrops.length ? (
          <div className={styles.cell}>
            <span className={styles.cellLabel}>{t('panel.preview.backdropAria')}</span>
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
          </div>
        ) : null}

        <div className={`${styles.cell} ${styles.wide} ${styles.idle}`}>
          <Toggle
            label={t('panel.preview.idle')}
            checked={idle}
            onChange={(v) => void setIdle(v).then(refresh)}
          />
          {/* The same readout `?debug=1` opens on, and an ordinary command — so it
              goes to every renderer attached, this preview included. That is the
              point: the question it answers is nearly always about the picture
              going to air, and the preview then shows what that picture looks
              like because it is a second renderer of the same commands. It is
              never folded into the standing setup, so a renderer that reloads
              comes back clean; see `debugCommandSchema`. */}
          <Toggle
            label={t('panel.preview.readout')}
            title={t('panel.preview.readout.title')}
            checked={measured}
            onChange={(next) => {
              setMeasured(next);
              void setDebugReadout(next);
            }}
          />
          {/* The same switch as the layout's shown/hidden, here for debugging the
              document or the backdrop with nobody standing in front of it. */}
          <Toggle
            label={t('panel.preview.hideAvatar')}
            title={t('panel.preview.hideAvatar.title')}
            checked={hidden}
            onChange={(hide) => void place({ avatar: { visible: !hide } }).then(refresh)}
          />
        </div>
      </div>
    </section>
  );
}
