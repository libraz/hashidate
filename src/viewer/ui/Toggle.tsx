import { useId } from 'react';
import styles from './Toggle.module.css';

interface Props {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
}

export function Toggle({ label, checked, onChange, title }: Props) {
  const id = useId();
  return (
    <label className={styles.row} title={title ?? label} htmlFor={id}>
      <span className={styles.label}>{label}</span>
      <input
        id={id}
        name={id}
        className={styles.input}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={styles.switch}>
        <span className={styles.knob} />
      </span>
    </label>
  );
}
