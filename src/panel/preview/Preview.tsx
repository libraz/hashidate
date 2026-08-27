import { useEffect, useRef, useState } from 'react';
import type { CameraFrame, Snapshot } from '@/protocol';
import { Segmented } from '@/ui/Segmented';
import { sendMonitorMute } from '@/viewer/monitor-link';
import { setCamera } from '../api';
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
 * ## Silent by default, and not by declining to speak
 *
 * The embedded viewer is opened with `?mute=1`, which zeroes the last gain in
 * its audio graph. It still asks for every line and still plays the take. That
 * costs a second synthesis per line and is worth it: a preview that skipped
 * synthesis would fall back to the text estimate, end its lines at different
 * moments, and drift out of step with the queue it exists to show.
 *
 * It is silent by *default* rather than always, because whether the operator can
 * hear anything at all depends on a setting outside this program. OBS sends a
 * browser source's audio to the stream and not to the desk unless monitoring is
 * switched on for it, so on an ordinary setup nobody in the room hears the
 * character — and this preview is then the only way to. Switched the other way,
 * with OBS monitoring on, hearing both is every line twice a fraction of a
 * second apart, which is worse than hearing none.
 *
 * Only one of those is knowable from here, so it is a button. It moves a gain
 * over `postMessage` rather than reloading the frame: unmuting to check a
 * reading and muting again is a thing done constantly, and a model download and
 * two seconds of black picture each time would mean nobody does it.
 *
 * ## Framing lives here
 *
 * The camera is the one control an operator reaches for *because of what they
 * can see*, so it sits under the picture rather than in a tab. Orbiting is
 * deliberately not available — the preview does not take the pointer, so a wheel
 * over it scrolls the panel rather than dollying a camera the stream does not
 * share.
 */

const FRAMES: Array<{ value: CameraFrame; label: string }> = [
  { value: 'face', label: '顔' },
  { value: 'bust', label: 'バスト' },
  { value: 'upper', label: '上半身' },
  { value: 'full', label: '全身' },
];

/** Both survive a reload: turning either off is a deliberate choice. */
const SHOWN_KEY = 'aituber.panel.preview';
const HEARD_KEY = 'aituber.panel.preview.audio';

/**
 * How long a report of blocked audio keeps the warning up.
 *
 * Every renderer reports into the same slot, so with two of them — the preview
 * here and whatever is on air — a flag that is true for only one of them
 * alternates at the reporting interval. Held, the warning reads as a state
 * rather than flashing; it clears a few reports after the last blocked one, and
 * being a little late to disappear costs nothing next to being unreadable.
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

export function Preview({ snapshot }: { snapshot: Snapshot }) {
  const [on, setOn] = useState(() => readStored(SHOWN_KEY, true));
  // Off by default: on an OBS setup with monitoring switched on, sound here is
  // every line twice. The operator who cannot hear it any other way turns it on
  // once and it stays on.
  const [heard, setHeard] = useState(() => readStored(HEARD_KEY, false));
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => store(SHOWN_KEY, on), [on]);
  useEffect(() => store(HEARD_KEY, heard), [heard]);

  // Also on every load of the frame, not only on a change: the iframe starts
  // muted from its own URL, so an operator who left the sound on has to be given
  // it back once the page inside is there to receive the message.
  useEffect(() => {
    if (!on) return;
    sendMonitorMute(frame.current, !heard);
  }, [on, heard]);

  const avatar = snapshot.vocabulary.avatar?.id ?? null;
  const speaking = snapshot.state.speaking ?? false;
  const blocked = useHeld(snapshot.voice?.blocked ?? false, BLOCKED_HOLD_MS);

  return (
    <section className={styles.preview}>
      <div className={styles.head}>
        <span className={styles.title}>プレビュー</span>
        <button
          type="button"
          className={`${styles.toggle} ${heard ? styles.armed : ''}`}
          aria-pressed={heard}
          disabled={!on}
          onClick={() => setHeard((v) => !v)}
          title={
            heard
              ? 'この画面の音を止める。OBS のモニタリングを使っているなら二重に聞こえます'
              : 'この画面の音を出す。OBS 側でモニタリングしていない場合はここが唯一の確認手段です'
          }
        >
          {heard ? '音声 入' : '音声 切'}
        </button>
        <button
          type="button"
          className={styles.toggle}
          aria-pressed={on}
          onClick={() => setOn((v) => !v)}
          title={on ? 'プレビューを止めて GPU を返す' : 'プレビューを表示する'}
        >
          {on ? '停止' : '表示'}
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
            ref={frame}
            className={styles.canvas}
            // The sound is restored after the page inside has loaded, not from
            // the URL: it starts muted either way, so a frame that never finishes
            // loading is silent rather than shouting.
            onLoad={() => sendMonitorMute(frame.current, !heard)}
            // No `?size`: the canvas matches the element. A browser source is
            // pinned to a pixel size so nothing resamples it; a monitor on a
            // window somebody resizes wants the opposite.
            src="/?stage=1&mute=1"
            title="アバターのプレビュー"
            // The picture is a monitor. Taking the pointer would mean a wheel
            // over it dollies a camera the stream does not share, while the
            // panel behind it stops scrolling.
            tabIndex={-1}
          />
        ) : (
          <p className={styles.off}>
            プレビュー停止中。二つ目の WebGL
            コンテキストを開かないので、配信側の描画が軽くなります。
          </p>
        )}
      </div>

      {/* Not a control, and deliberately not dismissible: nothing sent from this
          panel can clear it. A browser will not start an audio device until the
          page it is on has been interacted with, so a viewer nobody has clicked
          mouths every line in silence — and from here that looks exactly like a
          speech sidecar that is not running. */}
      {blocked ? (
        <p className={styles.blocked}>
          音声ブロック中。ビューアの画面を一度クリックすると次の行から声が出ます。
        </p>
      ) : null}

      <div className={styles.framing}>
        <Segmented
          ariaLabel="カメラ"
          options={FRAMES}
          // The renderer does not report its framing, so nothing is lit. A
          // segment shown as selected on the strength of the last click would be
          // wrong the moment an orchestrator moved the camera.
          value={null}
          onChange={(frame) => void setCamera(frame)}
        />
      </div>
    </section>
  );
}
