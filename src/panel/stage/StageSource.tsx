import { useMemo, useState } from 'react';
import { useT } from '@/i18n';
import type { Snapshot } from '@/protocol';
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
      <span className={styles.label}>{t('panel.source.title')}</span>
      <label>
        {t('panel.source.size')}
        <select value={size} onChange={(event) => setSize(event.target.value as SourceSize)}>
          {SOURCE_SIZES.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <label>
        {t('panel.source.backdrop')}
        <select value={backdrop} onChange={(event) => setBackdrop(event.target.value)}>
          <option value="">{t('panel.source.none')}</option>
          {(snapshot.vocabulary.backdrops ?? []).map((item) => (
            <option key={item.id} value={item.id}>
              {tx(item.label)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('panel.source.deck')}
        <select value={chosenDeck} onChange={(event) => setDeck(event.target.value)}>
          <option value="">{t('panel.source.none')}</option>
          {snapshot.decks.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('panel.source.place')}
        <select value={place} onChange={(event) => setPlace(event.target.value as SourcePlace)}>
          {SOURCE_PLACES.map((value) => (
            <option key={value} value={value}>
              {t(SOURCE_PLACE_LABELS[value])}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={transparent && transparentAllowed}
          disabled={!transparentAllowed}
          onChange={(event) => setTransparent(event.target.checked)}
        />
        <span title={transparentAllowed ? undefined : t('panel.source.transparent.roomWins')}>
          {t('panel.source.transparent')}
        </span>
      </label>
      <code className={styles.url}>{url}</code>
      <button
        type="button"
        className={`${styles.copy} ${copied === 'failed' ? styles.failed : ''}`}
        onClick={() => void copy()}
      >
        {copyLabel}
      </button>
    </section>
  );
}
