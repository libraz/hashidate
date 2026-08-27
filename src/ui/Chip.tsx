import type { ReactNode } from 'react';
import styles from './Chip.module.css';

/**
 * How a chip got to be lit.
 *
 * `on` is a selection the operator made. `auto` is the same face or gesture
 * appearing because the emotion channel or the autopilot chose it — visually
 * distinct on purpose, since a control cannot clear something it did not pick.
 */
export type ChipState = 'off' | 'on' | 'auto';

interface Props {
  label: ReactNode;
  onClick: () => void;
  state?: ChipState;
  /** An action rather than a state: 停止 (stop), 解除 (clear), 台本を再生 (play the script). */
  variant?: 'default' | 'action' | 'primary';
  tag?: string;
  title?: string;
  disabled?: boolean;
}

export function Chip({
  label,
  onClick,
  state = 'off',
  variant = 'default',
  tag,
  title,
  disabled,
}: Props) {
  const classes = [
    styles.chip,
    state === 'on' ? styles.on : '',
    state === 'auto' ? styles.auto : '',
    variant === 'action' ? styles.action : '',
    variant === 'primary' ? styles.primary : '',
  ]
    .filter(Boolean)
    .join(' ');

  // `auto` is deliberately not "pressed". The chip is lit because the emotion
  // channel or the autopilot put that face on screen, and the operator cannot
  // un-press something they never pressed — announcing it as pressed would
  // promise a toggle that does nothing.
  const pressed = variant === 'default' ? state === 'on' : undefined;

  return (
    <button
      type="button"
      className={classes}
      onClick={onClick}
      title={title}
      disabled={disabled}
      aria-pressed={pressed}
    >
      {label}
      {tag ? <span className={styles.tag}>{tag}</span> : null}
    </button>
  );
}

export function ChipRow({ children }: { children: ReactNode }) {
  return <div className={styles.row}>{children}</div>;
}
