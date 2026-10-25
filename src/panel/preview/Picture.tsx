import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import type { Shot } from '@/protocol';
import { FeedReceiver, webCodecsDecoder } from './feed';
import styles from './Picture.module.css';
import { dragShot, wheelShot } from './shot-drag';

/**
 * The picture in the preview: the stage's feed when one is coming, otherwise a
 * renderer of its own. Either way it is also the camera control.
 *
 * The feed is waited for briefly before falling back, because the fallback is
 * a whole avatar load that is thrown away the moment the feed turns up.
 */

/** How long a freshly shown preview waits for a feed before it draws its own picture. */
const GRACE_MS = 1_500;

/** How often the feed's liveness is read off the receiver. */
const POLL_MS = 250;

type Source = 'waiting' | 'feed' | 'own';

/** Contain-fit a decoded frame into the canvas, letterboxed. */
function drawFit(ctx: CanvasRenderingContext2D, frame: VideoFrame): void {
  const { width, height } = ctx.canvas;
  const scale = Math.min(width / frame.displayWidth, height / frame.displayHeight);
  const w = frame.displayWidth * scale;
  const h = frame.displayHeight * scale;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(frame, (width - w) / 2, (height - h) / 2, w, h);
}

const watcherId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `watcher-${Math.random().toString(36).slice(2)}`;

export function Picture({
  avatar,
  shot,
  onShot,
}: {
  /** Keys the fallback renderer, which reads its avatar only when it loads. */
  avatar: string | null;
  shot: Required<Shot>;
  /** Where the pointer moved the shot to. */
  onShot: (shot: Required<Shot>) => void;
}) {
  const { t } = useT();
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [source, setSource] = useState<Source>('waiting');
  // Read inside pointer handlers, which must not be rebuilt on every shot.
  const current = useRef(shot);
  current.current = shot;
  const report = useRef(onShot);
  report.current = onShot;

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d', { alpha: false }) ?? null;
    if (!(el && ctx)) {
      setSource('own');
      return;
    }
    const fit = new ResizeObserver(() => {
      el.width = Math.max(1, Math.round(el.clientWidth * devicePixelRatio));
      el.height = Math.max(1, Math.round(el.clientHeight * devicePixelRatio));
    });
    fit.observe(el);
    const receiver = new FeedReceiver({
      watcher: watcherId(),
      decoder: webCodecsDecoder((frame) => drawFit(ctx, frame)),
    });
    const shown = performance.now();
    const poll = setInterval(() => {
      setSource((was) => {
        if (receiver.live) return 'feed';
        if (was === 'waiting' && performance.now() - shown < GRACE_MS) return 'waiting';
        return 'own';
      });
    }, POLL_MS);
    return () => {
      clearInterval(poll);
      receiver.dispose();
      fit.disconnect();
    };
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let drag: { id: number; x: number; y: number; from: Required<Shot> } | null = null;
    const down = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, from: current.current };
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent): void => {
      if (drag === null || e.pointerId !== drag.id) return;
      report.current(dragShot(drag.from, e.clientX - drag.x, e.clientY - drag.y, el.clientHeight));
    };
    const up = (e: PointerEvent): void => {
      if (drag === null || e.pointerId !== drag.id) return;
      drag = null;
      el.releasePointerCapture(e.pointerId);
    };
    // Not passive: a wheel over the picture dollies the camera instead of scrolling the panel.
    const wheel = (e: WheelEvent): void => {
      e.preventDefault();
      report.current(wheelShot(current.current, e.deltaY));
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
    };
  }, []);

  return (
    <div ref={host} className={styles.picture}>
      <canvas ref={canvas} className={styles.layer} hidden={source === 'own'} />
      {source === 'own' ? (
        <iframe
          // Keyed on the avatar so a swap reloads the preview rather than
          // leaving it on the character that is no longer loaded. The embedded
          // viewer picks its avatar from its own stored selection, which is
          // only read at load.
          key={avatar ?? 'none'}
          className={styles.layer}
          // No `?size`: the canvas matches the element. A browser source is
          // pinned to a pixel size so nothing resamples it; a monitor on a
          // window somebody resizes wants the opposite.
          src="/?mute=1&preview=1"
          title={t('panel.preview.frameTitle')}
          tabIndex={-1}
        />
      ) : null}
      {source === 'waiting' ? null : (
        <span
          className={styles.badge}
          title={t(
            source === 'feed'
              ? 'panel.preview.source.feed.title'
              : 'panel.preview.source.own.title',
          )}
        >
          {t(source === 'feed' ? 'panel.preview.source.feed' : 'panel.preview.source.own')}
        </span>
      )}
    </div>
  );
}
