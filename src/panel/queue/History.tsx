import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryEntry } from '@/protocol';
import { Segmented } from '@/ui/Segmented';
import { isFailure, POLL_INTERVAL, queueRewind, type RewindMode, readHistory } from '../api';
import styles from './History.module.css';

/**
 * What has already been said, and the two ways to send it round again.
 *
 * ## Newest first, which is the opposite of the queue below it
 *
 * The pending list is read forwards because it is the future. This is read
 * backwards because the row anybody wants is almost always the last one — the
 * line that came out wrong, or the one that got cut off — and a list that put it
 * at the bottom of a scroller would make the common case the furthest away.
 *
 * ## Closed by default, and not polled while closed
 *
 * A hundred spoken lines is the largest thing this panel can ask for, and for
 * most of a broadcast nobody is looking at it. Open, it re-reads on the panel's
 * own interval; closed, it costs nothing. That is also why the history is its
 * own endpoint rather than a field on the snapshot.
 *
 * ## Cutting the line on air is a choice, every time
 *
 * The two rewind buttons do not decide it. A rewind during a fluffed sentence
 * wants the character stopped mid-word; a rewind planned during a quiet stretch
 * wants the line finished first. Neither is right often enough to be the
 * default, so the choice sits above the list where it can be seen before either
 * button is pressed, rather than being a modifier nobody discovers.
 */

/** Wall-clock, because a spoken line is remembered as "the one a minute ago". */
const stamp = (seconds: number): string =>
  new Date(seconds * 1000).toLocaleTimeString('ja-JP', { hour12: false });

const CUT_OPTIONS = [
  {
    value: 'finish' as const,
    label: '言い終わってから',
    title: 'いま言っている行は最後まで喋り、その次から巻き戻し先に入ります',
  },
  {
    value: 'cut' as const,
    label: '中断して切替',
    title: 'いま言っている行をその場で止めて、巻き戻し先に切り替えます',
  },
];

type Cut = (typeof CUT_OPTIONS)[number]['value'];

export function History({ refresh }: { refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cut, setCut] = useState<Cut>('finish');

  /**
   * Set on unmount and on close, and checked after every await, so a request in
   * flight when the section is folded away cannot restart the timer behind it.
   */
  const alive = useRef(false);

  const poll = useCallback(async () => {
    const result = await readHistory();
    if (!alive.current) return;
    if (isFailure(result)) setError(result.error);
    else {
      setError(null);
      setEntries(result.history);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    alive.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Chained rather than an interval, for the reason `useRuntime` is: a slow
    // request must not let a second one start behind it.
    const loop = async (): Promise<void> => {
      await poll();
      if (!alive.current) return;
      timer = setTimeout(() => void loop(), POLL_INTERVAL);
    };
    void loop();
    return () => {
      alive.current = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [open, poll]);

  const rewind = async (id: string, mode: RewindMode): Promise<void> => {
    await queueRewind(id, mode, cut === 'cut');
    // Both lists moved: the entries left the history and joined the queue.
    await poll();
    refresh();
  };

  return (
    <section className={styles.history}>
      <button
        type="button"
        className={styles.head}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.caret} aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        履歴
        <span className={styles.hint}>{open ? '新しい順・最大100件' : '話し終えた行'}</span>
      </button>

      {open ? (
        <>
          <div className={styles.mode}>
            <span className={styles.modeLabel}>巻き戻すとき</span>
            <Segmented
              ariaLabel="巻き戻したときに再生中の行をどうするか"
              options={CUT_OPTIONS}
              value={cut}
              onChange={setCut}
            />
          </div>

          {error ? <p className={styles.error}>{error}</p> : null}

          {entries.length === 0 ? (
            <p className={styles.empty}>まだ話し終えた行はありません。</p>
          ) : (
            <ul className={styles.list}>
              {[...entries].reverse().map((entry) => (
                <li key={entry.id} className={styles.row}>
                  <div className={styles.meta}>
                    <span className={styles.time}>{stamp(entry.saidAt)}</span>
                    {entry.interrupted ? <span className={styles.cutTag}>中断</span> : null}
                    {entry.source ? <span className={styles.source}>{entry.source}</span> : null}
                  </div>
                  <p className={styles.text}>{entry.text}</p>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      onClick={() => void rewind(entry.id, 'from')}
                      title="この行と、これより後に話した行をまとめてキューの先頭に戻す"
                    >
                      ここから
                    </button>
                    <button
                      type="button"
                      onClick={() => void rewind(entry.id, 'one')}
                      title="この行だけをキューの先頭に入れて、もう一度言わせる"
                    >
                      この行だけ
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}
