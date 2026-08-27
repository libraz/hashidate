import { useEffect, useId, useRef, useState } from 'react';
import type { TurnRequest, Vocabulary } from '@/protocol';
import { Chip, ChipRow } from '@/ui/Chip';
import { checkLine } from '../lint';
import styles from './LineEditor.module.css';

/**
 * Writing or fixing one line.
 *
 * The same form for a new line and for an edit, because they are the same act:
 * a queue entry keeps its id through an edit, so "add" and "change" differ only
 * in whether an id is being carried. Two forms would drift, and the one that
 * drifted would be the edit — the path used least when things are calm and most
 * when they are not.
 *
 * ## It checks as you type and refuses nothing
 *
 * The findings under the field are the same ones the row shows, run on every
 * keystroke. Nothing here disables the submit button over them. A warning means
 * the renderer will do something other than what was written — a cue that will
 * be dropped, a bracket that will be swallowed — and during a broadcast the
 * operator is the one who decides whether that matters. Being told is the
 * feature; being stopped would just be a second thing to fight.
 *
 * ## The cue palette inserts at the caret
 *
 * A cue belongs at a position in the sentence, which means the useful gesture is
 * "put `[explain]` where I am typing", not "append it". The performance list is
 * avatar data and arrives in the vocabulary, so this palette is also the only
 * place the operator can see what the loaded avatar can actually be asked for.
 */

interface Props {
  /** The entry being edited, or a blank turn for a new one. */
  initial: TurnRequest;
  vocabulary: Partial<Vocabulary>;
  /** Shown on the submit button: 追加 / 保存. */
  submitLabel: string;
  onSubmit: (turn: TurnRequest) => void;
  onCancel: () => void;
  /**
   * A second way to commit the same draft, for the composer's 割り込み.
   *
   * One draft, two destinations — the end of the queue or the front of it —
   * because a comment worth answering arrives while the line is half typed, and
   * a separate interject form would mean deciding where it goes before knowing
   * what it says.
   */
  secondaryLabel?: string;
  onSecondary?: (turn: TurnRequest) => void;
}

export function LineEditor({
  initial,
  vocabulary,
  submitLabel,
  onSubmit,
  onCancel,
  secondaryLabel,
  onSecondary,
}: Props) {
  const [text, setText] = useState(initial.text ?? '');
  const [reading, setReading] = useState(initial.reading ?? '');
  const [perform, setPerform] = useState(initial.perform ?? '');
  const [hold, setHold] = useState(initial.hold ?? false);
  const [showCues, setShowCues] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const textId = useId();
  const readingId = useId();

  // Focus on open, and put the caret at the end rather than selecting: an edit
  // usually continues a line rather than replacing it, and a stray keystroke
  // over a selection would wipe a line mid-broadcast.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const draft: TurnRequest = {
    text,
    ...(reading.trim() ? { reading: reading.trim() } : {}),
    ...(perform ? { perform } : {}),
    ...(hold ? { hold } : {}),
  };
  const check = checkLine(draft, vocabulary);

  /** Put a cue where the caret is, and leave the caret after it. */
  const insertCue = (id: string): void => {
    const el = area.current;
    const token = `[${id}]`;
    if (!el) {
      setText((value) => value + token);
      return;
    }
    const at = el.selectionStart;
    const next = `${text.slice(0, at)}${token}${text.slice(el.selectionEnd)}`;
    setText(next);
    // After React has written the new value, or the caret would be placed in
    // the old string and jump the moment it re-renders.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at + token.length, at + token.length);
    });
  };

  const submit = (): void => {
    // A turn with nothing in it at all would be a row that does nothing and
    // cannot be told apart from a mis-click. A pose-only turn is fine and is
    // not this.
    if (!(text.trim() || perform)) return;
    onSubmit(draft);
  };

  return (
    <form
      className={styles.editor}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className={styles.label} htmlFor={textId}>
        台詞
      </label>
      <textarea
        id={textId}
        ref={area}
        className={styles.text}
        value={text}
        rows={3}
        placeholder="こんばんは。[explain]今日はこの話をします。"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter is a newline — a line of dialogue has paragraphs in it. The
          // modifier submits, which is the convention every chat client trained
          // everyone on and the only one that does not cost a lost line.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
          if (e.key === 'Escape') onCancel();
        }}
      />

      <div className={styles.readingRow}>
        <label className={styles.label} htmlFor={readingId}>
          読み
        </label>
        <input
          id={readingId}
          className={styles.reading}
          value={reading}
          placeholder="かなで。数え方・日付・固有名詞だけで十分"
          onChange={(e) => setReading(e.target.value)}
        />
      </div>

      <div className={styles.row}>
        <button
          type="button"
          className={`${styles.disclosure} ${showCues ? styles.open : ''}`}
          aria-expanded={showCues}
          onClick={() => setShowCues((v) => !v)}
        >
          演技 {showCues ? '−' : '+'}
        </button>
        <span className={styles.estimate}>
          およそ {check.seconds.toFixed(1)} 秒
          {check.cues.length ? ` · キュー ${check.cues.length}` : ''}
        </span>
        <label className={styles.hold}>
          <input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} />
          表情を保持
        </label>
      </div>

      {showCues ? (
        <div className={styles.palette}>
          <p className={styles.paletteNote}>
            クリックでカーソル位置に <code>[id]</code> を挿入。角括弧は読み上げられません。
          </p>
          <ChipRow>
            {(vocabulary.performances ?? []).map((p) => (
              <Chip
                key={p.id}
                label={p.label}
                tag={p.id}
                title={`[${p.id}] を挿入`}
                onClick={() => insertCue(p.id)}
              />
            ))}
          </ChipRow>
          <div className={styles.performRow}>
            <span className={styles.label}>行全体</span>
            <ChipRow>
              <Chip
                label="なし"
                state={perform === '' ? 'on' : 'off'}
                onClick={() => setPerform('')}
              />
              {(vocabulary.performances ?? []).map((p) => (
                <Chip
                  key={p.id}
                  label={p.label}
                  tag={p.id}
                  state={perform === p.id ? 'on' : 'off'}
                  onClick={() => setPerform(perform === p.id ? '' : p.id)}
                />
              ))}
            </ChipRow>
          </div>
        </div>
      ) : null}

      {check.findings.length ? (
        <ul className={styles.findings}>
          {check.findings.map((f) => (
            <li key={f.message} className={f.severity === 'warn' ? styles.warn : styles.note}>
              {f.message}
            </li>
          ))}
        </ul>
      ) : null}

      <div className={styles.buttons}>
        <button type="button" className={styles.cancel} onClick={onCancel}>
          取消
        </button>
        {secondaryLabel && onSecondary ? (
          <button
            type="button"
            className={styles.secondary}
            disabled={!(text.trim() || perform)}
            onClick={() => {
              if (!(text.trim() || perform)) return;
              onSecondary(draft);
            }}
          >
            {secondaryLabel}
          </button>
        ) : null}
        <button type="submit" className={styles.submit} disabled={!(text.trim() || perform)}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
