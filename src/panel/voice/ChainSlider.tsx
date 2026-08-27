import { useRef, useState } from 'react';
import { Slider } from '@/ui/Slider';

/**
 * One parameter of the voice chain, drawn from the renderer and dragged locally.
 *
 * ## Why this cannot just be a controlled `Slider`
 *
 * The value shown has to come from the renderer's report — that is the whole
 * point of reporting the resolved configuration rather than assuming it, since
 * loading a preset moves twenty of these at once and the panel does not know any
 * of the numbers in it. But the report arrives on a 500 ms poll, and a slider
 * bound straight to it fights the pointer: drag, and for half a second the
 * component re-renders at the value the server still has, which snaps the handle
 * back under the finger. It is unusable, and it is unusable in exactly the
 * situation the panel exists for.
 *
 * Bound only to local state it stops telling the truth instead — a preset change
 * would leave every slider sitting where it was.
 *
 * ## So it follows, except where it has spoken
 *
 * The local value wins from the moment it is dragged. The reported value takes
 * over again when it becomes something *other* than what was last sent — which
 * happens when a preset is loaded, or when the renderer clamped the value to a
 * range this panel does not know about, and does not happen while the report is
 * merely catching up to a drag already in progress.
 *
 * That is the same shape `useFollowed` describes for any control over a polled
 * source, kept here as a component because a hook cannot be called from the loop
 * that builds twenty of these.
 */

interface Props {
  label: string;
  /** The renderer's value, from the resolved report. */
  reported: number;
  onCommit: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  precision?: number;
  unit?: string;
  /** The dotted path into the configuration, shown on hover. */
  title?: string;
}

export function ChainSlider({
  label,
  reported,
  onCommit,
  min,
  max,
  step = 0.01,
  precision = 2,
  unit = '',
  title,
}: Props) {
  const [local, setLocal] = useState<number | null>(null);
  /** The last value this slider sent, so a report echoing it is not a change. */
  const sent = useRef<number | null>(null);
  const lastReported = useRef(reported);

  if (!Object.is(lastReported.current, reported)) {
    lastReported.current = reported;
    if (shouldAdopt(reported, sent.current, step)) {
      sent.current = null;
      if (local !== null) setLocal(null);
    }
  }

  return (
    <Slider
      label={label}
      value={local ?? reported}
      min={min}
      max={max}
      step={step}
      precision={precision}
      unit={unit}
      title={title}
      onChange={(value) => {
        setLocal(value);
        sent.current = value;
        onCommit(value);
      }}
    />
  );
}

/**
 * Whether a newly reported value should take over from what is being dragged.
 *
 * Yes when nothing has been sent — the slider is only following. Yes when the
 * report says something other than what was sent, which is a preset load or a
 * clamp the panel does not know the rule for. No when it is merely the echo of
 * the drag arriving back, which is the common case and the one that must not
 * drop the pointer.
 *
 * The echo is matched against the step rather than exactly, because the value
 * makes a round trip through JSON and a 32-bit float in the processor: 0.7 sent
 * comes back as 0.699999988079071. An exact comparison would read every echo as
 * a change and pull the handle out from under the finger on the next poll.
 */
export function shouldAdopt(reported: number, sent: number | null, step: number): boolean {
  if (sent === null) return true;
  // A step of zero would make every echo a mismatch. Not reachable from the
  // sliders below, but it is the sort of thing a later parameter arrives with.
  const tolerance = step > 0 ? step / 2 : Number.EPSILON;
  return Math.abs(reported - sent) >= tolerance;
}
