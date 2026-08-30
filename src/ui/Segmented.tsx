import { type KeyboardEvent, type RefObject, useRef } from 'react';
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
 * Used for the camera framing, the set, the output size of a take, the way a
 * document is fitted. Anything with more than about five options, or where the
 * set is avatar-derived and so unknown at design time, uses chips instead —
 * segments stop being readable once they are narrower than their labels — and
 * a list that is long and changeable wants `Select`.
 *
 * ## A radio group, and `Tabs` below is the one exception
 *
 * The whole strip used to be a `tablist` wherever it appeared, which promised a
 * region underneath that changed with the selection. For all of the above there
 * is no such region: the choice goes out as a command and what changes is the
 * render, which a screen reader cannot follow anyway. Announcing them as tabs
 * described a page that does not exist. They are radio groups.
 *
 * The two places that really do swap a region — this panel's tab strip and the
 * console's — use `Tabs`, which is the same track with the roles that mean it.
 *
 * ## One stop on the way through, and the arrows do the rest
 *
 * Both are single-stop widgets: tab through the panel and a segmented control
 * takes one tab, not one per segment. Nine tabs across the top of the broadcast
 * panel were nine stops between the header and the first control under them,
 * which is most of a keyboard's journey spent on a strip already in plain
 * sight.
 *
 * So the chosen segment is the only one in the tab order and the arrows move
 * within the group, selecting as they go. Selecting on arrow rather than on a
 * second keystroke suits both of these: a tab strip that only swaps a region,
 * and a picker whose whole effect is one command that the next arrow press
 * supersedes.
 */
export function Segmented<T extends string>({ options, value, onChange, ariaLabel }: Props<T>) {
  const track = useRef<HTMLDivElement>(null);
  const at = tabStop(options, value);
  const keys = roving(options, at, onChange, track);

  return (
    <div
      ref={track}
      className={styles.track}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={keys}
    >
      {options.map((o, index) => (
        // An `input type=radio` cannot carry this track's geometry: the
        // equal-width rule needs the flex item to be the control itself rather
        // than a label wrapping a hidden input, and the tab stop belongs to the
        // group here rather than to each option.
        // biome-ignore lint/a11y/useSemanticElements: see above
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={index === at ? 0 : -1}
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

/**
 * The same track where the segments really do swap a region of the page.
 *
 * Separate from `Segmented` rather than a role it takes as a prop, because the
 * difference is not decoration: a tab promises a panel and `aria-controls` has
 * to name it. Keeping them apart means neither can be reached for by accident.
 */
export function Tabs<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  controls,
}: Props<T> & { controls: string }) {
  const track = useRef<HTMLDivElement>(null);
  const at = tabStop(options, value);
  const keys = roving(options, at, onChange, track);

  return (
    <div
      ref={track}
      className={styles.track}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={keys}
    >
      {options.map((o, index) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          aria-controls={controls}
          tabIndex={index === at ? 0 : -1}
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

/** The one segment in the tab order: the chosen one, or the first choosable. */
function tabStop<T extends string>(
  options: ReadonlyArray<SegmentedOption<T>>,
  value: T | null,
): number {
  const chosen = options.findIndex((o) => o.value === value && !o.disabled);
  return chosen === -1 ? options.findIndex((o) => !o.disabled) : chosen;
}

/** Arrow and Home/End handling, shared because both roles use the same ring. */
function roving<T extends string>(
  options: ReadonlyArray<SegmentedOption<T>>,
  at: number,
  onChange: (value: T) => void,
  track: RefObject<HTMLDivElement | null>,
): (event: KeyboardEvent<HTMLDivElement>) => void {
  return (event) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    const to =
      step !== 0
        ? nextEnabled(options, at, step)
        : event.key === 'Home'
          ? nextEnabled(options, -1, 1)
          : event.key === 'End'
            ? nextEnabled(options, options.length, -1)
            : -1;
    if (to === -1 || to === at) return;
    event.preventDefault();
    onChange(options[to].value);
    // Focus follows the selection rather than waiting for the re-render to move
    // the tab stop: without this the next arrow press starts from a button the
    // browser has just taken out of the tab order.
    track.current?.querySelectorAll('button').item(to)?.focus();
  };
}

/**
 * The next segment that can be chosen, wrapping, and −1 if none can.
 *
 * Wrapping rather than stopping at the ends, which is what every platform's own
 * implementation of both roles does. Stepping over disabled segments is not an
 * edge case here: a take that is running greys every output but its own.
 */
function nextEnabled<T extends string>(
  options: ReadonlyArray<SegmentedOption<T>>,
  from: number,
  step: number,
): number {
  const count = options.length;
  for (let i = 1; i <= count; i += 1) {
    const at = (((from + i * step) % count) + count) % count;
    if (!options[at].disabled) return at;
  }
  return -1;
}
