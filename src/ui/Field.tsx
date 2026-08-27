import type { ReactNode } from 'react';
import styles from './Field.module.css';

/**
 * A left-hand label beside a control group.
 *
 * The label column is a fixed width rather than sized to content, so a stack of
 * these lines up — a wardrobe with a two-character slot name next to a
 * four-character one reads as a ragged list otherwise.
 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <div className={styles.label} title={label}>
        {label}
      </div>
      <div className={styles.control}>{children}</div>
    </div>
  );
}
