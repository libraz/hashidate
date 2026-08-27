import { useEffect, useRef, useState } from 'react';
import type { AvatarDescriptor, SlideReport } from '@/engine/types';
import { useT } from '@/i18n';
import type { StageMode } from '../stage-mode';
import { type Readout, readout, type Tone } from './readout';
import type { AvatarRuntime, Hud } from './runtime';
import styles from './Telemetry.module.css';

/**
 * The measurements, printed over the frame as a shell.
 *
 * Sampled off `onHud` at the runtime's 8 Hz, which the document report rides
 * along with: it is a getter rather than a subscription, and reading it on the
 * tick that already woke the component costs nothing and keeps the two halves
 * of a sample from being taken at different moments.
 *
 * Everything here is read-only, which is what makes it safe over a live frame.
 * The component sends nothing, the panel takes no pointer, and the one thing on
 * it that asks for anything — blocked audio — asks for a click on the page
 * rather than on itself.
 */
export function Telemetry({
  runtime,
  avatar,
  problems,
  mode,
}: {
  runtime: AvatarRuntime;
  avatar: AvatarDescriptor;
  problems: number;
  mode: StageMode;
}) {
  const { t, tx } = useT();
  const [sample, setSample] = useState<{ hud: Hud; slides: SlideReport } | null>(null);

  useEffect(
    () => runtime.onHud((hud) => setSample({ hud, slides: runtime.slideReport })),
    [runtime],
  );

  const frame = useRef<HTMLDivElement>(null);
  const scale = useFrameScale(frame);
  const view = sample
    ? readout({
        ...sample,
        avatar: tx(avatar.label),
        problems,
        mode,
        voiceBlocked: t('console.telemetry.voiceBlocked'),
      })
    : null;

  // The frame is mounted before there is anything to print, because it is what
  // the scale is measured off: a readout that appeared only with its first
  // sample would be laid out once at whatever scale it was born with.
  return (
    <div className={styles.frame} ref={frame}>
      {view ? (
        <div className={styles.shell} style={{ '--scale': scale } as React.CSSProperties}>
          <Head head={view.head} />

          <div className={styles.gauges}>
            {view.gauges.map((g) => (
              <Gauge key={g.key} gauge={g} />
            ))}
          </div>

          <Fields fields={view.facts} />
          {view.deck ? <Fields fields={view.deck} /> : null}

          <div className={styles.flags}>
            {view.flags.map((f) => (
              <span key={f.text} className={`${styles.flag} ${tone(f.tone)}`}>
                {f.tone === 'live' ? <span className={styles.dot} /> : null}
                {f.text}
              </span>
            ))}
            {/* The prompt this readout would be sitting at, if it were one. It
                carries no information and is the only thing here that moves of
                its own accord — which is exactly what it is for: a frozen
                renderer and a renderer with nothing to say print the same
                numbers, and this is the difference between them. */}
            <span className={styles.cursor}>_</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The frame this readout was designed against, in CSS pixels.
 *
 * A broadcast source is 1920 wide, so that is what one unit of scale means.
 * Everything on the panel is stated in `em` off a font size derived from it,
 * which is what makes the readout the same *fraction* of the picture on every
 * renderer — the one going to air at its source size, and the monitor in the
 * panel at whatever size the column happens to be.
 */
const REFERENCE_WIDTH = 1920;

/**
 * How large this frame is against that one.
 *
 * Measured rather than read off `?size=`, because the flag is only one of the
 * ways a frame gets its size: absent it, the canvas fills the window, and in
 * the panel it fills an iframe the operator can resize by dragging the browser.
 *
 * The reason it is a ratio at all is that the readout has to *look the same* in
 * the preview as it does on air. Fixed pixels made the preview a different
 * picture from the thing it is a preview of — the same rows at the same size
 * over a third as much frame, which is the one thing a monitor may not be.
 */
function useFrameScale(ref: React.RefObject<HTMLDivElement | null>): number {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      // A frame with no width yet is a frame that has not been laid out. Taking
      // it would set the whole readout to a font size of zero.
      if (width > 0) setScale(width / REFERENCE_WIDTH);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return scale;
}

/**
 * Two lines, because they answer two questions.
 *
 * The first is what this page *is* — which of the two renderers, at what size —
 * and is the same on every sample of a given browser source. The second is what
 * it is currently running. Folded into one line they read as one fact and the
 * eye stops separating the constant part from the live part.
 */
function Head({ head }: { head: Readout['head'] }) {
  return (
    <div className={styles.head}>
      <div className={styles.source}>
        <span className={styles.host}>{head.host}</span>
        <span className={styles.size}>{head.size}</span>
      </div>
      <div className={styles.ident}>
        <span className={styles.avatar}>{head.avatar}</span>
        <span className={styles.channel}>{head.channel}</span>
        <span className={`${styles.fps} ${tone(head.fpsTone)}`}>{head.fps}</span>
      </div>
    </div>
  );
}

/**
 * `white-space: pre` on the track halves matters: a centred gauge at zero is
 * two runs of sixteen characters with an empty string between them, and a
 * collapsed run would move the column the readings are in.
 */
function Gauge({ gauge }: { gauge: Readout['gauges'][number] }) {
  return (
    <>
      <span className={styles.key}>{gauge.key}</span>
      <span className={styles.bar}>
        {/* The brackets are what make a run of characters read as a gauge with
            ends, which matters most on the centred one: without them a short
            fill either side of nothing has no scale to be short against. */}
        <span className={styles.bracket}>[</span>
        <span className={styles.track}>{gauge.bar.before}</span>
        <span className={styles.fill}>{gauge.bar.fill}</span>
        <span className={styles.track}>{gauge.bar.after}</span>
        <span className={styles.bracket}>]</span>
      </span>
      <span className={styles.reading}>{gauge.value}</span>
    </>
  );
}

function Fields({ fields }: { fields: Readout['facts'] }) {
  return (
    <div className={styles.fields}>
      {fields.map((f) => (
        <span key={f.key} className={styles.row}>
          <span className={styles.key}>{f.key}</span>
          <span className={`${styles.value} ${tone(f.tone)}`}>{f.value}</span>
        </span>
      ))}
    </div>
  );
}

const TONES: Record<Tone, string> = {
  ink: styles.ink,
  dim: styles.dim,
  faint: styles.faint,
  accent: styles.accent,
  warn: styles.warn,
  bad: styles.bad,
  live: styles.live,
};

const tone = (t: Tone): string => TONES[t];
