import { type CSSProperties, useId } from 'react';
import styles from './Slider.module.css';

interface Props {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Decimal places in the readout. Angles want 0, gains want 2. */
  precision?: number;
  /** Appended to the readout: `cm`, `s`, `°`. */
  unit?: string;
  /** Where the control changes nothing, when that is not zero or the bottom. */
  rest?: number;
  title?: string;
}

/**
 * A labelled fader with a numeric readout.
 *
 * Controlled: the value comes from the caller, which matters because several of
 * these track state the autopilot also writes — an uncontrolled input would sit
 * at whatever the operator last dragged it to while the character did something
 * else.
 */
export function Slider({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  precision = 2,
  unit = '',
  rest,
  title,
}: Props) {
  const id = useId();
  const span = fill(value, min, max, rest);
  return (
    <div className={styles.row}>
      <label className={styles.label} htmlFor={id} title={title ?? label}>
        {label}
      </label>
      <input
        id={id}
        className={styles.input}
        style={{ '--from': span.from, '--to': span.to } as CSSProperties}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output className={styles.value} htmlFor={id}>
        {value.toFixed(precision)}
        {unit}
      </output>
    </div>
  );
}

/**
 * The lit stretch of the track, as fractions of its length.
 *
 * From `rest` when the control declares one — a multiplier, where 1 changes
 * nothing — else from zero when zero is inside the range, as for a pitch or an
 * EQ band, else from the bottom. A fader sitting on its anchor shows no fill at
 * all, which is what makes the one that was moved findable in a column of them.
 */
export function fill(
  value: number,
  min: number,
  max: number,
  rest?: number,
): { from: number; to: number } {
  if (!(max > min)) return { from: 0, to: 0 };
  const at = (x: number): number => Math.min(1, Math.max(0, (x - min) / (max - min)));
  const anchor = rest !== undefined ? at(rest) : min < 0 && max > 0 ? at(0) : 0;
  const here = at(value);
  return { from: Math.min(anchor, here), to: Math.max(anchor, here) };
}
