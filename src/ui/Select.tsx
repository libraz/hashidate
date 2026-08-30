import type { ReactNode } from 'react';
import styles from './Select.module.css';

export interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<SelectOption>;
  /** Set when a visible `label` elsewhere points at this control. */
  id?: string;
  /** Required when no visible label sits beside it. */
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  /** A leading item for "nothing chosen", which is a value and not an absence. */
  placeholder?: ReactNode;
}

/**
 * A one-of-many picker for a list too long, or too changeable, to be segments.
 *
 * Still a native `select`, and deliberately: the popup is the platform's, so it
 * scrolls, type-aheads, and reaches the menu bar's own keyboard handling on a
 * machine where that is how the operator works. What is replaced is only the
 * closed control, which the browser draws in the system's colours — a light
 * rounded rectangle in the middle of a matte near-black bar is the one thing on
 * this page that looks borrowed from another program.
 *
 * The open list cannot be styled and is not worth faking. A menu rebuilt out of
 * divs to match the panel would lose everything above and gain a colour.
 */
export function Select({
  value,
  onChange,
  options,
  id,
  ariaLabel,
  title,
  disabled,
  placeholder,
}: Props) {
  return (
    <span className={styles.wrap}>
      <select
        id={id}
        className={styles.select}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
      >
        {placeholder === undefined ? null : <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}
