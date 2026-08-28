import { useEffect, useState } from 'react';
import { type MessageKey, useT } from '@/i18n';
import type { SpeechState } from '@/protocol';
import { LocaleSwitch } from '@/ui/LocaleSwitch';
import { Segmented } from '@/ui/Segmented';
import { clear, interrupt } from './api';
import { DressTab } from './dress/DressTab';
import { EMPTY, useRuntime } from './hooks';
import { InspectTab } from './inspect/InspectTab';
import styles from './Panel.module.css';
import { PerformTab } from './perform/PerformTab';
import { Preview } from './preview/Preview';
import { QueueTab } from './queue/QueueTab';
import { RecordTab } from './record/RecordTab';
import { SlidesTab } from './slides/SlidesTab';
import { StageSource } from './stage/StageSource';
import { TuneTab } from './tune/TuneTab';
import { VoiceTab } from './voice/VoiceTab';

/**
 * The broadcast panel.
 *
 * Opened beside the stream, not inside it. It holds no renderer and no
 * `AudioContext`: everything it does goes through the control API, so what the
 * panel can do is exactly what an orchestrator can do — and, more to the point,
 * there is only ever one avatar. A panel that drove the scene directly would
 * have to be a second renderer to do it, and two renderers driven by the same
 * commands do not agree, because the idle layer runs on `Math.random()`.
 *
 * ## The transport bar is above the tabs and stays there
 *
 * Stop and drop-the-rest apply whatever is on screen. During a broadcast the
 * thing that has to be reachable in one movement is the stop, and a stop that
 * lives inside a tab is a stop that is behind a click when it is needed.
 *
 * `--live` marks the character speaking and nothing else, per the token file. On
 * this page it is the header's only colour, which is what makes "is it talking
 * right now" answerable from across a room.
 */

/**
 * The tabs, in the order a broadcast uses them.
 *
 * The first five are touched during one: the script, the take being recorded,
 * the acting, the voice, and the document being presented — a page is turned
 * between two sentences, which puts the slides with the live half rather than
 * with the setup half. The last three are set before it and looked at when
 * something is wrong — a costume, the layer underneath the character, and the
 * readouts. The four names borrowed from the console are the console's,
 * deliberately: an operator moving between the two screens should not have to
 * learn a second vocabulary for the same jobs.
 *
 * Recording sits second because it is where a segment *begins*: a script is
 * loaded there, and what it puts on the queue is what the first tab then shows.
 */
type Tab = 'queue' | 'record' | 'perform' | 'voice' | 'slides' | 'dress' | 'tune' | 'inspect';

/**
 * What the header says about the voice, per state, and null for the two states
 * worth saying nothing about.
 *
 * `ready` needs no line, and neither does `absent`: most machines have no
 * sidecar and never will, so a panel that reported its absence would be
 * reporting it permanently — which is how a warning stops being read. What is
 * worth a line is the voice that was answering and stopped, because from the
 * panel that failure is invisible: the queue drains, the mouth moves, the
 * meters stay where they were, and every line goes out silent.
 */
const SPEECH_NOTICE: Record<SpeechState, MessageKey | null> = {
  absent: null,
  ready: null,
  loading: 'panel.speech.loading',
  down: 'panel.speech.down',
};

const TAB_LABELS: Array<{ value: Tab; key: MessageKey }> = [
  { value: 'queue', key: 'panel.tabs.queue' },
  { value: 'record', key: 'panel.tabs.record' },
  { value: 'perform', key: 'panel.tabs.perform' },
  { value: 'voice', key: 'panel.tabs.voice' },
  { value: 'slides', key: 'panel.tabs.slides' },
  { value: 'dress', key: 'panel.tabs.dress' },
  { value: 'tune', key: 'panel.tabs.tune' },
  { value: 'inspect', key: 'panel.tabs.inspect' },
];

export function Panel() {
  const { snapshot, error, refresh } = useRuntime();
  const [tab, setTab] = useState<Tab>('queue');
  const { t, tx, locale } = useT();

  // The tab strip is what the operator picks the panel out of a browser's tab
  // bar by, and `index.html` can only ship one language of it. `lang` moves with
  // it so that a screen reader and the browser's own hyphenation agree with the
  // text actually on screen.
  const documentTitle = t('panel.documentTitle');
  useEffect(() => {
    document.title = documentTitle;
    document.documentElement.lang = locale;
  }, [documentTitle, locale]);

  const tabs = TAB_LABELS.map(({ value, key }) => ({ value, label: t(key) }));

  // An empty snapshot rather than a loading state: the panel draws the same
  // layout either way, and every field would otherwise need its own branch.
  const data = snapshot ?? EMPTY;
  const speaking = data.state.speaking ?? false;
  const notice = SPEECH_NOTICE[data.speech];
  const avatarLabel = data.vocabulary.avatar?.label;

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <div className={styles.identity}>
          <span className={styles.title}>{t('panel.title')}</span>
          <span className={styles.avatar}>{avatarLabel ? tx(avatarLabel) : '—'}</span>
        </div>

        <span className={`${styles.link} ${data.connected ? styles.online : ''}`}>
          <span className={styles.dot} aria-hidden="true" />
          {data.connected
            ? t('panel.status.connected', { viewers: data.viewers })
            : t('panel.status.disconnected')}
        </span>

        {/* In the header rather than only in its own tab, because a take runs
            for minutes and the operator spends them in the Slides tab turning
            pages. A recording nobody can see is a recording that gets left
            running into the next segment. */}
        {data.recording !== null ? (
          <span className={styles.taking} title={t('panel.recording.title')}>
            <span className={styles.takingDot} aria-hidden="true" />
            {t('panel.recording')}
          </span>
        ) : null}

        {/* Beside the link readout rather than in a tab: it is set once by
            whoever opens the panel, and a setting nobody can find is a panel
            that stays in the wrong language all evening. */}
        <LocaleSwitch />

        <div className={styles.transport}>
          <button
            type="button"
            className={styles.clear}
            onClick={() => void clear().then(refresh)}
            title={t('panel.drop.title')}
          >
            {t('panel.drop')}
          </button>
          <button
            type="button"
            className={`${styles.stop} ${speaking ? styles.armed : ''}`}
            onClick={() => void interrupt().then(refresh)}
            title={t('panel.stop.title')}
          >
            {t('panel.stop')}
          </button>
        </div>
      </header>

      <StageSource snapshot={data} />

      {/* The server restarts during development and the panel stays open. The
          banner appears over the last data rather than replacing it, so a queue
          does not flicker empty and get clicked on by mistake. */}
      {error ? <div className={styles.error}>{error}</div> : null}

      {/* Under the transport error rather than beside it: a control server that
          is gone is the larger fault of the two, and this one is still true
          while it is being fixed. See `SPEECH_NOTICE`. */}
      {notice ? <div className={styles.notice}>{t(notice)}</div> : null}

      <div className={styles.tabs}>
        <Segmented options={tabs} value={tab} onChange={setTab} ariaLabel={t('panel.tabs.aria')} />
      </div>

      {/*
        The body scrolls and the frame does not. Both tabs are very different
        heights — a queue of two lines against twenty-odd faders — and a page
        that resized around the switch would move the transport bar, which is the
        one control that must be in the same place every time it is reached for.

        The preview shares the scroll region rather than sitting outside it, so
        that on a narrow window it can fall above the controls instead of
        stealing a column from them. It is sticky, so on a wide one it stays put
        while the queue moves under it.
      */}
      <main className={styles.body}>
        <div className={styles.monitor}>
          <Preview snapshot={data} refresh={refresh} />
        </div>
        <div className={styles.controls}>
          {tab === 'queue' ? <QueueTab snapshot={data} refresh={refresh} /> : null}
          {tab === 'record' ? <RecordTab snapshot={data} refresh={refresh} /> : null}
          {tab === 'perform' ? <PerformTab snapshot={data} refresh={refresh} /> : null}
          {tab === 'voice' ? <VoiceTab snapshot={data} refresh={refresh} /> : null}
          {tab === 'slides' ? <SlidesTab snapshot={data} refresh={refresh} /> : null}
          {tab === 'dress' ? <DressTab snapshot={data} refresh={refresh} /> : null}
          {tab === 'tune' ? <TuneTab snapshot={data} /> : null}
          {tab === 'inspect' ? <InspectTab snapshot={data} /> : null}
        </div>
      </main>
    </div>
  );
}
