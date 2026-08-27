import { useEffect, useState } from 'react';
import { AVATARS } from '@/avatars';
import { hasCueMarkup, isWellFormed } from '@/engine/cues';
import type { CameraFrame } from '@/engine/types';
import { useT } from '@/i18n';
import { Chip, ChipRow } from '@/ui/Chip';
import { LocaleSwitch } from '@/ui/LocaleSwitch';
import { Segmented } from '@/ui/Segmented';
import { Toggle } from '@/ui/Toggle';
import type { ControlStatus } from '../control-client';
import { useSessionState } from '../hooks';
import { backdropList, backdropNote } from '../scene/backdrop';
import { CAMERA_FRAMES, CAMERA_LABELS } from '../scene/framing';
import type { AvatarRuntime, RuntimeStatus } from '../scene/runtime';
import { rememberBackdrop, rememberTransparent } from '../stage-mode';
import styles from './Console.module.css';
import { DemoBar } from './DemoBar';
import { DressTab } from './tabs/DressTab';
import { InspectTab } from './tabs/InspectTab';
import { PerformTab } from './tabs/PerformTab';
import { TuneTab } from './tabs/TuneTab';

/**
 * The operator console.
 *
 * Organised by *what the operator is doing*, not by which subsystem a control
 * belongs to. The previous panel was one 3,000 px scroll of fifteen sections in
 * implementation order, which mixed the things touched every minute (speak,
 * emote, gesture) with the things set once a session (breath depth, spring
 * stiffness, gaze limits) and buried the diagnostics inside whichever feature
 * happened to produce them.
 *
 *   perform  the live surface — face, gesture, pointing, the demo script
 *   dress    the wardrobe, which is avatar data and a separate task
 *   tune     every slider that is set once and left
 *   inspect  read-only: joint strain, the resolved profile, the event log
 *
 * The avatar picker, the camera framing, the idle switch and the speech box all
 * sit outside the tabs, because none of them belongs to one of those four jobs.
 */

const TABS = [
  { value: 'perform', message: 'console.tabs.perform' },
  { value: 'dress', message: 'console.tabs.dress' },
  { value: 'tune', message: 'console.tabs.tune' },
  { value: 'inspect', message: 'console.tabs.inspect' },
] as const;

type TabId = (typeof TABS)[number]['value'];

/**
 * "No backdrop" needs a value, because `Segmented` picks by string and null is
 * not one. It is a sentinel and never leaves this file — `chooseBackdrop` maps
 * it back to the null the runtime and the URL both use.
 */
const NO_BACKDROP = '-';

interface Props {
  runtime: AvatarRuntime | null;
  status: RuntimeStatus;
  control: ControlStatus;
  rejected: number;
  onSwitch: (id: string) => void;
}

export function Console({ runtime, status, control, rejected, onSwitch }: Props) {
  const { t, tx } = useT();
  const [tab, setTab] = useState<TabId>('perform');
  const [text, setText] = useState('こんばんは。今日も配信を見に来てくれてありがとうございます。');
  const [reading, setReading] = useState('');
  // Followed, not held: the control API can change the shot too, and a picker
  // showing the old framing after the orchestrator moved the camera is worse
  // than no picker.
  const [frame, setFrame] = useState<CameraFrame>('bust');
  useEffect(() => runtime?.onCamera(setFrame), [runtime]);

  /**
   * The set, which starts as whatever the URL asked for.
   *
   * Held rather than followed, unlike the framing above. The camera has two
   * masters — this picker and the control API — so it has to be subscribed to;
   * the backdrop has the same two, but a set is changed a handful of times in a
   * session against a shot changed every minute, and a subscription and its
   * teardown are not worth carrying for a control that is never racing. If the
   * orchestrator starts driving it live, this becomes an `onBackdrop`.
   */
  const [backdrop, setBackdrop] = useState<string | null>(null);
  useEffect(() => setBackdrop(runtime?.backdropId ?? null), [runtime]);

  const chooseBackdrop = (id: string) => {
    const next = id === NO_BACKDROP ? null : id;
    setBackdrop(next);
    runtime?.setBackdrop(next);
    rememberBackdrop(next);
  };

  /**
   * Whether "なし" (none) means the flat colour or nothing at all.
   *
   * Held beside the picker rather than inside it, because it is not a fifth set:
   * a room is opaque and covers this either way, so it only decides what the
   * absence of one looks like. What it is for is written down on
   * `StageMode.transparent`.
   */
  const [transparent, setTransparent] = useState(false);
  useEffect(() => setTransparent(runtime?.isTransparent ?? false), [runtime]);

  const chooseTransparent = (on: boolean) => {
    setTransparent(on);
    runtime?.setTransparent(on);
    rememberTransparent(on);
  };

  const loaded = status.phase === 'ready' ? status.loaded : null;
  const session = loaded?.session ?? null;
  const state = useSessionState(session);

  /**
   * The same refusal the control API gives, for the same reason.
   *
   * This box calls `Session.say` in process, where malformed markup is stripped
   * rather than rejected — safe, since nothing in brackets is ever spoken, but
   * silent: half a typed cue would take the rest of the line with it and the
   * operator would watch the character say less than they wrote. So the check
   * that the wire format applies is applied here too, and the button goes dead
   * until the line is one the API would have accepted.
   */
  const problem = !isWellFormed(text)
    ? t('console.speech.badCue')
    : hasCueMarkup(reading)
      ? t('console.speech.cueInReading')
      : null;

  const say = () => {
    if (!(session && text.trim()) || problem) return;
    // Blank means no reading was given, not a reading that is empty — an empty
    // one would leave the mouth with nothing to say.
    session.say({ text, reading: reading.trim() || undefined });
  };

  // Space says the line from anywhere that is not a text field. The most
  // frequent action in the tool, and reaching for the mouse to repeat it is
  // what makes watching a long idle tedious.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
      if (e.key === ' ') {
        e.preventDefault();
        say();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const goto = (f: CameraFrame) => runtime?.goto(f);

  // A set that has no note answers null, which is not something to resolve.
  const setNote = backdrop ? backdropNote(backdrop) : null;
  const backdropText = setNote ? tx(setNote) : null;

  return (
    <div className={styles.console}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <h1 className={styles.title}>HASHIDATE</h1>
          <span className={`${styles.link} ${control === 'online' ? styles.online : ''}`}>
            <span className={styles.linkDot} />
            {control === 'online' ? t('console.link.online') : t('console.link.offline')}
            {rejected > 0 ? ` · ${t('console.link.rejected', { count: rejected })}` : ''}
          </span>
          {/* Set once a session at most, so it sits on the identity line rather
              than among the controls reached for every minute. */}
          <LocaleSwitch />
        </div>
        <Segmented
          ariaLabel={t('console.avatar.aria')}
          options={AVATARS.map((a) => ({ value: a.id, label: tx(a.label) }))}
          value={loaded?.avatar.id ?? (status.phase === 'loading' ? status.avatar.id : null)}
          onChange={onSwitch}
        />
        {loaded ? (
          <div className={styles.author}>
            {loaded.avatar.author ? tx(loaded.avatar.author) : '—'} · ARKit{' '}
            {loaded.profile.arkit.count}/52 · {t('console.header.shapes')}{' '}
            {Object.keys(loaded.profile.dict).length}
          </div>
        ) : null}
      </header>

      <div className={styles.toolbar}>
        <Segmented
          ariaLabel={t('console.camera.aria')}
          options={CAMERA_FRAMES.map((f) => ({ value: f, label: tx(CAMERA_LABELS[f]) }))}
          value={frame}
          onChange={goto}
        />
        {/* Beside the camera, because both of them say where the shot is
            rather than what the character is doing. */}
        <div>
          <Segmented
            ariaLabel={t('console.backdrop.aria')}
            options={[
              {
                value: NO_BACKDROP,
                label: t('console.backdrop.none'),
                title: t('console.backdrop.none.title'),
              },
              ...backdropList().map((b) => ({
                value: b.id,
                label: tx(b.label),
                title: tx(backdropNote(b.id) ?? b.label),
              })),
            ]}
            value={backdrop ?? NO_BACKDROP}
            onChange={chooseBackdrop}
          />
          {/* Only with no room. A room covers this whichever way it is set, and
              a control that changes nothing is worse than one that is absent. */}
          {backdrop === null ? (
            <Toggle
              label={t('console.backdrop.transparent')}
              checked={transparent}
              onChange={chooseTransparent}
            />
          ) : null}
          {/* What the room is for, in a line. Four of them are four value
              structures rather than four colour schemes, and the difference is
              not something the labels can carry. */}
          <p className={styles.note}>
            {backdrop
              ? backdropText
              : transparent
                ? t('console.backdrop.note.transparent')
                : t('console.backdrop.note.url')}
          </p>
        </div>
        <Toggle
          label={t('console.idle.auto')}
          checked={state?.idleEnabled ?? false}
          onChange={(v) => {
            session?.setIdle(v);
            if (!v) session?.resetExpression();
          }}
        />
      </div>

      {/* Between the toolbar and the tabs, because it is a mode the whole
          console is in rather than one of the things a tab does. */}
      <DemoBar session={session} />

      <div className={styles.tabs}>
        <Segmented
          ariaLabel={t('console.tabs.aria')}
          options={TABS.map((it) => ({ value: it.value, label: t(it.message) }))}
          value={tab}
          onChange={setTab}
        />
      </div>

      <div className={styles.body}>
        {status.phase === 'failed' ? (
          <>
            <p className={styles.problems}>{status.message}</p>
            <p className={styles.empty}>{t('console.load.failedHint')}</p>
          </>
        ) : null}

        {loaded ? (
          <>
            {loaded.problems.length ? (
              <p className={styles.problems}>{loaded.problems.join('\n')}</p>
            ) : null}
            {tab === 'perform' ? (
              <PerformTab loaded={loaded} state={state} onCamera={goto} />
            ) : null}
            {tab === 'dress' ? <DressTab loaded={loaded} /> : null}
            {tab === 'tune' ? <TuneTab loaded={loaded} runtime={runtime} /> : null}
            {tab === 'inspect' ? <InspectTab loaded={loaded} state={state} /> : null}
          </>
        ) : status.phase !== 'failed' ? (
          <p className={styles.empty}>{t('console.load.loading')}</p>
        ) : null}
      </div>

      <div className={styles.composer}>
        <textarea
          id="speech"
          name="speech"
          aria-label={t('console.speech.aria')}
          className={styles.input}
          value={text}
          placeholder={t('console.speech.placeholder')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              say();
            }
          }}
        />
        <input
          id="reading"
          name="reading"
          aria-label={t('console.reading.label')}
          className={styles.reading}
          value={reading}
          placeholder={t('console.reading.label')}
          onChange={(e) => setReading(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              say();
            }
          }}
        />
        <div className={styles.composerRow}>
          <span className={problem ? styles.hintBad : styles.hint}>
            {problem ??
              (state?.queued ? t('console.speech.queued', { count: state.queued }) : '⌘⏎ / Space')}
          </span>
          <ChipRow>
            <Chip
              label={t('console.speech.stop')}
              variant="action"
              onClick={() => session?.interrupt()}
            />
            <Chip
              label={t('console.speech.say')}
              variant="primary"
              onClick={say}
              disabled={!!problem}
            />
          </ChipRow>
        </div>
      </div>
    </div>
  );
}
