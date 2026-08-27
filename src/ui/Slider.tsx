import { useId } from 'react';
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
  title,
}: Props) {
  const id = useId();
  return (
    <div className={styles.row}>
      <label className={styles.label} htmlFor={id} title={title ?? label}>
        {label}
      </label>
      <input
        id={id}
        className={styles.input}
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
