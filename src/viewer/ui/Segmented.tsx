import styles from './Segmented.module.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  title?: string;
  disabled?: boolean;
}

interface Props<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T | null;
  onChange: (value: T) => void;
  ariaLabel: string;
}

/**
 * A primary picker where the options are mutually exclusive and few.
 *
 * Used for the camera framing and for the console's tabs. Anything with more
 * than about five options, or where the set is avatar-derived and so unknown
 * at design time, uses chips instead — segments stop being readable once they
 * are narrower than their labels.
 */
export function Segmented<T extends string>({ options, value, onChange, ariaLabel }: Props<T>) {
  return (
    <div className={styles.track} role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          title={o.title ?? o.label}
          disabled={o.disabled}
          className={`${styles.segment} ${o.value === value ? styles.on : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
