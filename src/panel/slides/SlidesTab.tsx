import { useEffect, useState } from 'react';
import { PLACEMENT_LIMITS } from '@/engine/types';
import { getLocale, type MessageKey, translate, useT } from '@/i18n';
import type { Anchor, Placement, SlidePlacement, Snapshot } from '@/protocol';
import { Chip, ChipRow } from '@/ui/Chip';
import { Field } from '@/ui/Field';
import { Section } from '@/ui/Section';
import { Segmented } from '@/ui/Segmented';
import { Slider } from '@/ui/Slider';
import { FULL_FRAME, FULL_SLIDE } from '@/viewer/scene/placement';
import { deck, place, readDecks, slide } from '../api';
import styles from './SlidesTab.module.css';

/**
 * The document behind the character: which one is up, which page, and how the
 * two layers share the frame.
 *
 * ## The page counter is the renderer's, never the panel's
 *
 * Everything here that reads a page reads `snapshot.slides`, which is what the
 * renderer says it is showing. Counting locally instead would be one line
 * shorter and wrong at both ends of every document: a page turn past the last
 * page is clamped by the renderer and not refused, so an optimistic counter
 * keeps climbing while the picture stands still, and from then on the number on
 * screen and the page on air disagree by however many times the operator kept
 * pressing.
 *
 * That is also why nothing here re-reads the state after sending. The page
 * arrives on the renderer's own report; asking the server again the moment the
 * command went out would only fetch the page we already knew about.
 *
 * ## No thumbnails
 *
 * The preview above this is the real composited frame — the document layer, the
 * character on top of it, at the placement these controls set. A grid of page
 * thumbnails here would mean a second rasteriser giving a second answer to the
 * question the picture above already answers, and disagreeing with it about
 * exactly the thing being judged.
 */

interface Props {
  snapshot: Snapshot;
  refresh: () => void;
}

type Fit = 'contain' | 'cover';

const FITS: Array<{ value: Fit; label: MessageKey; title: MessageKey }> = [
  {
    value: 'contain',
    label: 'panel.slides.fit.contain',
    title: 'panel.slides.fit.contain.title',
  },
  { value: 'cover', label: 'panel.slides.fit.cover', title: 'panel.slides.fit.cover.title' },
];

/**
 * The nine positions, laid out as they sit in the frame so the grid below reads
 * as the frame rather than as a list of names.
 */
const ANCHORS: Array<{ value: Anchor; key: MessageKey }> = [
  { value: 'top-left', key: 'panel.slides.anchor.topLeft' },
  { value: 'top', key: 'panel.slides.anchor.top' },
  { value: 'top-right', key: 'panel.slides.anchor.topRight' },
  { value: 'left', key: 'panel.slides.anchor.left' },
  { value: 'center', key: 'panel.slides.anchor.center' },
  { value: 'right', key: 'panel.slides.anchor.right' },
  { value: 'bottom-left', key: 'panel.slides.anchor.bottomLeft' },
  { value: 'bottom', key: 'panel.slides.anchor.bottom' },
  { value: 'bottom-right', key: 'panel.slides.anchor.bottomRight' },
];

/** What the character's controls stand for, before they become two fractions. */
interface AvatarControls {
  anchor: Anchor;
  size: number;
  margin: number;
}

/** The document's, which needs no aspect: `fit` is what shapes the page. */
interface DocControls {
  anchor: Anchor;
  size: number;
  fit: Fit;
}

/**
 * The effective size of the standard broadcast corner placement.
 *
 * README.md, `src/panel/stage/source.ts`, and the use-case docs all use
 * `bottom-{left,right}:0.32x0.6`; the renderer's effective multiplier is the
 * tighter 0.32 axis. A full-frame avatar needs this size before a non-centre
 * anchor has room to move it.
 */
const STANDARD_BROADCAST_SIZE = 0.32;

/**
 * Whether a change this panel sent has come back: the renderer reporting the
 * rectangle it was asked for.
 *
 * What the drag needs, and it needs exactly this much. The report is the
 * authority on where the layers are — it is what is going to air, and it moves
 * for reasons the panel never sees, starting with the layout a browser source
 * was opened on — but it arrives twice a second, so a control bound straight to
 * it would snap back under the pointer for the whole of the gap between a drag
 * and the poll that answers it. Holding what was sent until this says the
 * renderer agrees closes that gap and no more of it: the moment it agrees, the
 * report is the only thing being drawn again.
 *
 * A change that never comes back — nothing connected, or a command the renderer
 * refused — leaves the control where the operator put it, which is what the tab
 * did when it held the placement outright.
 */
export function settled<T extends object>(sent: T, reported: T | null | undefined): boolean {
  if (!reported) return false;
  const answer = reported as Record<string, unknown>;
  return Object.entries(sent).every(([key, value]) => answer[key] === value);
}

/**
 * The two fractions one size stands for.
 *
 * Both axes, by the same amount. The wire carries a rectangle of two
 * independent fractions because the *document* needs one — see `Placement` —
 * and the character does not: the renderer draws the frame's own shape inside
 * whatever area it is given, so only the tighter of the two ever decides
 * anything and a second control for the other would be a control that does
 * nothing half the time.
 *
 * Clamped to what the wire accepts, because a command outside the limits is
 * refused silently at the other end — the slider would move and nothing else
 * would.
 */
export function fitAspect(size: number): { width: number; height: number } {
  return {
    width: clamp(size, PLACEMENT_LIMITS.width),
    height: clamp(size, PLACEMENT_LIMITS.height),
  };
}

/**
 * Resolve one avatar control change into the complete placement on the wire.
 *
 * The character's effective scale is the tighter of the reported fractions —
 * the renderer draws the same frame inside both axes. A full-frame character
 * has no room for a non-centre anchor, so selecting one uses the standard
 * broadcast effective scale in this same placement command. Other changes,
 * including selecting centre or moving an already smaller character, retain
 * the current effective scale.
 */
export function avatarPlacement(
  avatar: Required<Placement>,
  next: Partial<AvatarControls>,
): Required<Placement> {
  const currentSize = Math.min(avatar.width, avatar.height);
  const merged: AvatarControls = {
    anchor: avatar.anchor,
    size: currentSize,
    margin: avatar.margin,
    ...next,
  };
  const size =
    next.anchor !== undefined &&
    merged.anchor !== 'center' &&
    currentSize === PLACEMENT_LIMITS.width.max
      ? STANDARD_BROADCAST_SIZE
      : merged.size;
  return {
    anchor: merged.anchor,
    margin: merged.margin,
    ...fitAspect(size),
  };
}

/**
 * The page a typed jump means.
 *
 * The renderer clamps at both ends and never errors, so this is not about
 * safety: it is that the wire refuses a page below 1 outright, and a command
 * refused by the schema is a command that goes nowhere with nothing said about
 * it. Anything unreadable stays on the page that is up.
 */
export function clampPage(typed: number, current: number, pages: number): number {
  if (!Number.isFinite(typed)) return current;
  const last = Math.max(1, Math.trunc(pages));
  return Math.min(last, Math.max(1, Math.trunc(typed)));
}

/**
 * How long ago a file was saved, short enough to sit on a chip.
 *
 * The one thing that tells two documents with similar names apart during a
 * broadcast is which of them was just exported.
 */
export function ago(at: number, now: number = Date.now() / 1000): string {
  // Called from a chip's tag rather than from a component, so the locale is read
  // from the store the way it is anywhere else outside a hook.
  const say = (key: MessageKey, count: number): string => translate(key, getLocale(), { count });
  const seconds = Math.max(0, now - at);
  if (seconds < 90) return translate('panel.slides.ago.now', getLocale());
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return say('panel.slides.ago.minutes', minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return say('panel.slides.ago.hours', hours);
  return say('panel.slides.ago.days', Math.round(hours / 24));
}

const clamp = (value: number, limit: { min: number; max: number }): number =>
  Math.min(limit.max, Math.max(limit.min, value));

/**
 * Whether a keystroke is somebody typing.
 *
 * The arrow keys are bound to the page turn while this tab is open, so the jump
 * field beside the transport — and any other field that gains focus — has to
 * keep its own arrows for moving the caret.
 */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function SlidesTab({ snapshot, refresh }: Props) {
  const slides = snapshot.slides;
  const decks = snapshot.decks;
  const up = slides?.deck ?? null;
  const page = slides?.page ?? 0;
  const pages = slides?.pages ?? 0;

  const [jump, setJump] = useState('');
  const { t, tx } = useT();

  /**
   * The placement, followed rather than held. See `settled`.
   *
   * These two hold a change that is still on its way to the renderer, and
   * nothing else: they are dropped as soon as it reports the same rectangle
   * back, and from then on the report is what the controls are drawn at. It has
   * to be, because it is the only thing that knows about a layout nobody here
   * asked for — a source opened on `?place=bottom-right:0.32x0.6`, or a `place`
   * an orchestrator sent mid-segment.
   */
  const [sentAvatar, setSentAvatar] = useState<Required<Placement> | null>(null);
  const [sentDoc, setSentDoc] = useState<Required<SlidePlacement> | null>(null);
  const reported = snapshot.placement;
  const avatar = sentAvatar ?? reported?.avatar ?? FULL_FRAME;
  const doc = sentDoc ?? reported?.slide ?? FULL_SLIDE;

  /** Let go of a change the moment the renderer reports it. See `settled`. */
  useEffect(() => {
    if (!reported) return;
    setSentAvatar((sent) => (sent && settled(sent, reported.avatar) ? null : sent));
    setSentDoc((sent) => (sent && settled(sent, reported.slide) ? null : sent));
  }, [reported]);

  /**
   * Arrow keys turn pages while this tab is open.
   *
   * A page turn happens between two sentences, with the operator watching the
   * render and not the panel — aiming a pointer at a 20-pixel button is the one
   * movement that cannot be made without looking away. The binding is scoped to
   * this tab because the effect only runs while it is mounted, and it stands
   * down whenever focus is in a field, where the same keys move a caret.
   *
   * Modified presses are left alone: browsers navigate on them.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;
      event.preventDefault();
      void slide({ by: event.key === 'ArrowRight' ? 1 : -1 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Move the character's rectangle: locally so the control tracks, then on the wire. */
  const moveAvatar = (next: Partial<AvatarControls>): void => {
    const placement = avatarPlacement(avatar, next);
    setSentAvatar(placement);
    void place({ avatar: placement });
  };

  /** The document's rectangle. Square fractions: `fit` is what shapes the page in it. */
  const moveDoc = (next: Partial<DocControls>): void => {
    const merged: DocControls = { anchor: doc.anchor, size: doc.width, fit: doc.fit, ...next };
    const placement = {
      anchor: merged.anchor,
      width: clamp(merged.size, PLACEMENT_LIMITS.width),
      height: clamp(merged.size, PLACEMENT_LIMITS.height),
      // Carried through rather than reset: there is no control for it here, so
      // whatever set it — the URL a source was opened on — keeps it.
      margin: doc.margin,
      fit: merged.fit,
    };
    setSentDoc(placement);
    void place({ slide: placement });
  };

  const jumpTo = (): void => {
    if (jump.trim() === '') return;
    void slide({ page: clampPage(Number(jump), page, pages) });
    setJump('');
  };

  return (
    <>
      <Section
        title={t('panel.slides.title')}
        meta={up ?? t('panel.slides.none')}
        action={
          <Chip
            label={t('panel.slides.rescan')}
            variant="action"
            title={t('panel.slides.rescan.title')}
            onClick={() => void readDecks().then(refresh)}
          />
        }
        note={[t('panel.slides.title.note1'), t('panel.slides.title.note2')]}
      >
        <ChipRow>
          {/* A state and not an action: no document up is one of the things the
              layer can be showing, and it is picked the same way a document is.
              As an action it took that variant's transparent fill over the
              selection tint, so the chip that was chosen was the one drawn as
              though it were not. */}
          <Chip
            label={t('panel.slides.none')}
            state={up === null ? 'on' : 'off'}
            title={t('panel.slides.none.title')}
            onClick={() => void deck(null)}
          />
          {decks.map((item) => (
            <Chip
              key={item.id}
              label={tx(item.label)}
              tag={`${item.pages}p · ${ago(item.at)}`}
              title={item.id}
              state={up === item.id ? 'on' : 'off'}
              onClick={() => void deck(item.id)}
            />
          ))}
        </ChipRow>
        {decks.length === 0 ? <p className={styles.empty}>{t('panel.slides.empty')}</p> : null}
      </Section>

      <Section
        title={t('panel.slides.page')}
        meta={pages ? `${page} / ${pages}` : '—'}
        note={[
          t('panel.slides.page.note1'),
          t('panel.slides.page.note2'),
          t('panel.slides.page.note3'),
        ]}
      >
        {slides === null ? (
          <p className={styles.empty}>{t('panel.slides.noReport')}</p>
        ) : (
          <>
            <div className={styles.transport}>
              <button
                type="button"
                className={styles.step}
                disabled={up === null}
                title={t('panel.slides.prev')}
                onClick={() => void slide({ by: -1 })}
              >
                ◀
              </button>
              <span className={styles.count}>
                {up === null ? '—' : `${page} / ${pages}`}
                {up !== null && !slides.ready ? (
                  <span className={styles.drawing}>{t('panel.slides.drawing')}</span>
                ) : null}
              </span>
              <button
                type="button"
                className={styles.step}
                disabled={up === null}
                title={t('panel.slides.next')}
                onClick={() => void slide({ by: 1 })}
              >
                ▶
              </button>
              <input
                className={styles.jump}
                type="number"
                min={1}
                max={pages || 1}
                step={1}
                value={jump}
                disabled={up === null}
                placeholder={t('panel.slides.jump.placeholder')}
                aria-label={t('panel.slides.jump.aria')}
                onChange={(e) => setJump(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') jumpTo();
                  if (e.key === 'Escape') setJump('');
                }}
                onBlur={jumpTo}
              />
            </div>
            {slides.error !== null ? <p className={styles.error}>{slides.error}</p> : null}
          </>
        )}
      </Section>

      <Section
        title={t('panel.slides.layout')}
        note={[t('panel.slides.layout.note1'), t('panel.slides.layout.note2')]}
      >
        <Field label={t('panel.slides.stand')}>
          <AnchorGrid
            value={avatar.anchor}
            ariaLabel={t('panel.slides.stand.aria')}
            onChange={(anchor) => moveAvatar({ anchor })}
          />
        </Field>
        <Slider
          label={t('panel.slides.size')}
          value={Math.min(avatar.width, avatar.height)}
          min={PLACEMENT_LIMITS.height.min}
          max={PLACEMENT_LIMITS.height.max}
          step={0.01}
          onChange={(size) => moveAvatar({ size })}
        />
        <Slider
          label={t('panel.slides.margin')}
          value={avatar.margin}
          min={PLACEMENT_LIMITS.margin.min}
          max={PLACEMENT_LIMITS.margin.max}
          step={0.005}
          onChange={(margin) => moveAvatar({ margin })}
        />

        <Field label={t('panel.slides.docPosition')}>
          <AnchorGrid
            value={doc.anchor}
            ariaLabel={t('panel.slides.docPosition')}
            onChange={(anchor) => moveDoc({ anchor })}
          />
        </Field>
        <Field label={t('panel.slides.fit')}>
          <Segmented
            ariaLabel={t('panel.slides.fit.aria')}
            options={FITS.map((fit) => ({
              value: fit.value,
              label: t(fit.label),
              title: t(fit.title),
            }))}
            value={doc.fit}
            onChange={(fit) => moveDoc({ fit })}
          />
        </Field>
        <Slider
          label={t('panel.slides.docSize')}
          value={doc.width}
          min={PLACEMENT_LIMITS.width.min}
          max={PLACEMENT_LIMITS.width.max}
          step={0.01}
          onChange={(size) => moveDoc({ size })}
        />
      </Section>
    </>
  );
}

/**
 * The nine anchors, drawn as the frame they name.
 *
 * Not a `Segmented`: nine segments in a row stop being readable long before
 * they stop fitting, and the arrangement is the label here — 右下 (bottom right)
 * is in the bottom right corner of the control, which is what makes it findable
 * without reading. The buttons carry the same tokens the rest of the panel does.
 */
function AnchorGrid({
  value,
  ariaLabel,
  onChange,
}: {
  value: Anchor;
  ariaLabel: string;
  onChange: (anchor: Anchor) => void;
}) {
  const { t } = useT();
  return (
    <fieldset className={styles.grid} aria-label={ariaLabel}>
      {ANCHORS.map((anchor) => (
        <button
          key={anchor.value}
          type="button"
          className={`${styles.cell} ${anchor.value === value ? styles.on : ''}`}
          aria-pressed={anchor.value === value}
          title={t(anchor.key)}
          onClick={() => onChange(anchor.value)}
        >
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.cellLabel}>{t(anchor.key)}</span>
        </button>
      ))}
    </fieldset>
  );
}
