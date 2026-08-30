import { useId, useMemo, useState } from 'react';
import { useT } from '@/i18n';
import type { Snapshot } from '@/protocol';
import { Chip } from '@/ui/Chip';
import { Select } from '@/ui/Select';
import styles from './StageSource.module.css';
import {
  composeSourceURL,
  liveDeck,
  SOURCE_PLACE_LABELS,
  SOURCE_PLACES,
  SOURCE_SIZES,
  type SourcePlace,
  type SourceSize,
  transparencyApplies,
} from './source';

/** How long the copy button reports what happened before going back to itself. */
const COPY_NOTICE_MS = 2_000;

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Compose the browser-source address without claiming it as application state.
 *
 * OBS owns this setting once it is pasted there. These controls exist only to
 * make that one address visible and copyable after the browser's address bar
 * has gone away inside the shell.
 *
 * Which is also why the copy failing has to be visible. In a browser the button
 * works and there is a URL bar behind it anyway; inside the shell there is no
 * address bar, no way to select the text, and a clipboard write that is refused
 * leaves an operator clicking a button that does nothing and no way at all to
 * get the address out. So it says so.
 */
export function StageSource({ snapshot }: { snapshot: Snapshot }) {
  const { t, tx } = useT();
  // Bound by `htmlFor` rather than by wrapping the control in its own label:
  // the popup is a real `select` several components down, and a wrapping label
  // that cannot see it is a label that reads as decoration.
  const prefix = useId();
  const ids = {
    size: `${prefix}size`,
    backdrop: `${prefix}backdrop`,
    deck: `${prefix}deck`,
    place: `${prefix}place`,
  };
  const [size, setSize] = useState<SourceSize>('1920x1080');
  const [backdrop, setBackdrop] = useState('');
  const [transparent, setTransparent] = useState(false);
  const [deck, setDeck] = useState('');
  const [place, setPlace] = useState<SourcePlace>('');
  const [copied, setCopied] = useState<CopyState>('idle');

  // Both of these are the picker agreeing with the renderer rather than state
  // of their own: a room wins over transparency, and a document that is no
  // longer in the directory is not a document. See `source.ts`.
  const transparentAllowed = transparencyApplies(backdrop);
  const chosenDeck = liveDeck(deck, snapshot.decks);

  const url = useMemo(
    () =>
      composeSourceURL(window.location.href, {
        size,
        backdrop,
        transparent,
        deck: chosenDeck,
        place,
      }),
    [backdrop, chosenDeck, place, size, transparent],
  );

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
    window.setTimeout(() => setCopied('idle'), COPY_NOTICE_MS);
  };

  const copyLabel =
    copied === 'copied'
      ? t('panel.source.copied')
      : copied === 'failed'
        ? t('panel.source.copyFailed')
        : t('panel.source.copy');

  return (
    <section className={styles.source} aria-label={t('panel.source.aria')}>
      <span className={styles.title}>{t('panel.source.title')}</span>

      {/* Four settings and a switch, each label bound to its own control rather
          than merely laid out beside it: at this density a row of bare pairs
          runs together and there is no reading of it that says where one
          setting ends. */}
      <div className={styles.group}>
        <label className={styles.name} htmlFor={ids.size}>
          {t('panel.source.size')}
        </label>
        <Select
          id={ids.size}
          value={size}
          onChange={(value) => setSize(value as SourceSize)}
          options={SOURCE_SIZES.map((value) => ({ value, label: value }))}
        />
      </div>
      <div className={styles.group}>
        <label className={styles.name} htmlFor={ids.backdrop}>
          {t('panel.source.backdrop')}
        </label>
        <Select
          id={ids.backdrop}
          value={backdrop}
          onChange={setBackdrop}
          placeholder={t('panel.source.none')}
          options={(snapshot.vocabulary.backdrops ?? []).map((item) => ({
            value: item.id,
            label: tx(item.label),
          }))}
        />
      </div>
      <div className={styles.group}>
        <label className={styles.name} htmlFor={ids.deck}>
          {t('panel.source.deck')}
        </label>
        <Select
          id={ids.deck}
          value={chosenDeck}
          onChange={setDeck}
          placeholder={t('panel.source.none')}
          options={snapshot.decks.map((item) => ({ value: item.id, label: item.id }))}
        />
      </div>
      <div className={styles.group}>
        <label className={styles.name} htmlFor={ids.place}>
          {t('panel.source.place')}
        </label>
        <Select
          id={ids.place}
          value={place}
          onChange={(value) => setPlace(value as SourcePlace)}
          options={SOURCE_PLACES.map((value) => ({
            value,
            label: t(SOURCE_PLACE_LABELS[value]),
          }))}
        />
      </div>

      {/* A chip rather than a checkbox, for the reason every other switch on
          this page is one of the panel's own: it is the last control in a row
          of four that now look like the panel, and a system checkbox beside
          them is the only thing left that does not. */}
      <Chip
        label={t('panel.source.transparent')}
        state={transparent && transparentAllowed ? 'on' : 'off'}
        disabled={!transparentAllowed}
        title={transparentAllowed ? undefined : t('panel.source.transparent.roomWins')}
        onClick={() => setTransparent((on) => !on)}
      />

      <div className={styles.address}>
        <code className={styles.url}>{url}</code>
        <button
          type="button"
          className={`${styles.copy} ${copied === 'failed' ? styles.failed : ''}`}
          onClick={() => void copy()}
        >
          {copyLabel}
        </button>
      </div>
    </section>
  );
}
