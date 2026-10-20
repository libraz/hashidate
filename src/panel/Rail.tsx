import { type RefObject, useLayoutEffect, useRef } from 'react';
import { roving, type SegmentedOption, tabStop } from '@/ui/Segmented';
import styles from './Rail.module.css';
import { withKey } from './shortcuts';

export interface RailOption<T extends string> extends SegmentedOption<T> {
  /** The heading this tab sits under. A new heading starts wherever it changes. */
  group: string;
  /** A short figure beside the label — a count, a page — or nothing. */
  badge?: string;
  /** A lit mark beside the label, for a tab whose subject is running right now. */
  lamp?: 'live' | 'rec' | 'lit';
  /** The key that picks this tab from anywhere on the page. */
  shortcut?: string;
}

interface Props<T extends string> {
  options: ReadonlyArray<RailOption<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  controls: string;
}

/**
 * The panel's tab strip, stood on its side.
 *
 * Down the left edge rather than across the top, because nine labels across a
 * wide window spread a picker over two metres, and because a column has room
 * for what a strip did not: a heading between the tabs used during a broadcast
 * and the ones set before it, and a lamp on a tab whose subject is running —
 * a take being written, music playing — while some other tab is up.
 *
 * Same keyboard contract as `Tabs`: one stop, arrows move and select.
 */
export function Rail<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  controls,
}: Props<T>) {
  const track = useRef<HTMLDivElement>(null);
  const at = tabStop(options, value);
  const keys = roving(options, at, onChange, track);
  const selected = options.findIndex((o) => o.value === value);
  useSelection(track, selected);

  return (
    <div
      ref={track}
      className={styles.rail}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="vertical"
      onKeyDown={keys}
    >
      <span className={styles.selection} aria-hidden="true" />
      {options.map((o, index) => (
        <RailItem
          key={o.value}
          option={o}
          heading={index === 0 || options[index - 1].group !== o.group ? o.group : null}
          selected={o.value === value}
          focusable={index === at}
          controls={controls}
          onSelect={() => onChange(o.value)}
        />
      ))}
    </div>
  );
}

/**
 * Moves the selection onto the chosen row.
 *
 * Measured rather than computed, because the headings between the groups make
 * a row's offset depend on which group it is in. The glide is switched on only
 * after the first placement, so the panel opens with the selection already there
 * instead of watching it travel down from the top.
 */
function useSelection(track: RefObject<HTMLDivElement | null>, selected: number) {
  useLayoutEffect(() => {
    const rail = track.current;
    if (rail === null) return;
    const place = () => {
      const row = rail.querySelectorAll<HTMLElement>('[role="tab"]').item(selected);
      rail.style.setProperty('--selection-y', `${row?.offsetTop ?? 0}px`);
      rail.style.setProperty('--selection-h', `${row?.offsetHeight ?? 0}px`);
      rail.style.setProperty('--selection-lit', row ? '1' : '0');
    };
    place();
    const frame = requestAnimationFrame(() => {
      rail.dataset.settled = '';
    });
    const resize = new ResizeObserver(place);
    resize.observe(rail);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
    };
  }, [track, selected]);
}

function RailItem<T extends string>({
  option,
  heading,
  selected,
  focusable,
  controls,
  onSelect,
}: {
  option: RailOption<T>;
  heading: string | null;
  selected: boolean;
  focusable: boolean;
  controls: string;
  onSelect: () => void;
}) {
  return (
    <>
      {heading !== null ? (
        <span className={styles.heading} role="presentation">
          {heading}
        </span>
      ) : null}
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        aria-controls={controls}
        tabIndex={focusable ? 0 : -1}
        title={
          option.shortcut
            ? withKey(option.title ?? option.label, option.shortcut)
            : (option.title ?? option.label)
        }
        aria-keyshortcuts={option.shortcut}
        disabled={option.disabled}
        className={`${styles.item} ${selected ? styles.on : ''}`}
        onClick={onSelect}
      >
        <span className={styles.label}>{option.label}</span>
        {option.lamp ? (
          <span className={`${styles.lamp} ${styles[option.lamp]}`} aria-hidden="true" />
        ) : option.badge ? (
          <span className={styles.badge}>{option.badge}</span>
        ) : null}
      </button>
    </>
  );
}
