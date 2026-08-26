import { type ReactNode, useId, useState } from 'react';
import styles from './Section.module.css';

interface Props {
  title: string;
  /** A short count or state, shown in monospace beside the title. */
  meta?: string;
  /** Long-form explanation, hidden behind the info toggle. One string per paragraph. */
  note?: string[];
  children: ReactNode;
}

/**
 * One block of the console.
 *
 * The panel is read at a glance while the operator is watching the render, so
 * the title row carries only the title and a short state readout; anything that
 * needs a sentence lives behind the info toggle.
 */
export function Section({ title, meta, note, children }: Props) {
  const [open, setOpen] = useState(false);
  const noteId = useId();

  return (
    <section className={styles.section}>
      <div className={styles.head}>
        <h2 className={styles.title}>{title}</h2>
        {meta ? <span className={styles.meta}>{meta}</span> : <span className={styles.meta} />}
        {note?.length ? (
          <button
            type="button"
            className={`${styles.info} ${open ? styles.open : ''}`}
            aria-expanded={open}
            aria-controls={noteId}
            aria-label={`${title}の説明`}
            onClick={() => setOpen((v) => !v)}
          >
            ?
          </button>
        ) : null}
      </div>
      <div className={styles.body}>{children}</div>
      {note?.length && open ? (
        <div className={styles.note} id={noteId}>
          {note.map((p) => (
            <p key={p.slice(0, 24)}>{p}</p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
