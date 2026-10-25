import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type MessageKey, useT } from '@/i18n';
import type { Snapshot, SpeechState } from '@/protocol';
import { clear, interrupt, setPaused } from './api';
import { BgmTab } from './bgm/BgmTab';
import { DressTab } from './dress/DressTab';
import { EMPTY, useRuntime } from './hooks';
import { InspectTab } from './inspect/InspectTab';
import { checkQueue } from './lint';
import styles from './Panel.module.css';
import { PerformTab } from './perform/PerformTab';
import { Preview } from './preview/Preview';
import { clock } from './queue/QueueRow';
import { QueueTab } from './queue/QueueTab';
import { Rail, type RailOption } from './Rail';
import { elapsed, RecordTab } from './record/RecordTab';
import { SettingsTab } from './settings/SettingsTab';
import { KEYS, shortcut, withKey } from './shortcuts';
import { SlidesTab } from './slides/SlidesTab';
import { StageSource } from './stage/StageSource';
import { canHold, transport } from './transport';
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
 * ## Three panes under one bar
 *
 * The rail on the left picks what the inspector on the right shows; the monitor
 * between them is the same picture whichever tab is up. Each pane scrolls on
 * its own, so a long fader list never carries the picture away and a short
 * queue never leaves the stage half empty.
 *
 * ## The bar is the answer to "what is happening"
 *
 * Whether the character is talking, how much is still to say, whether a take is
 * being written, and the two buttons that end a run — all on one line that does
 * not move. A stop that lives inside a tab is a stop that is behind a click when
 * it is needed, and a status that lives inside a tab is only seen by whoever
 * happened to have that tab up.
 *
 * `--live` marks the character speaking and nothing else, per the token file. On
 * the bar it is the tally's colour, which is what makes "is it talking right
 * now" answerable from across a room.
 *
 * ## The OBS source is set up, not operated
 *
 * It is composed once a session and pasted into OBS, so it lives behind a button
 * in the bar as a popover rather than holding a strip of the screen all evening.
 */

/**
 * The tabs, in the order a broadcast uses them, under two rail headings.
 *
 * The first six are touched during one: the script, the take being recorded,
 * the acting, the voice, the music, and the document being presented — a page
 * is turned between two sentences, which puts the slides with the live half
 * rather than with the setup half. The next three are set before it and looked
 * at when something is wrong — a costume, the layer underneath the character,
 * and the readouts — and the last holds what is set once a machine, such as
 * the language. The four names borrowed from the console are the console's,
 * deliberately: an operator moving between the two screens should not have to
 * learn a second vocabulary for the same jobs.
 *
 * Recording sits second because it is where a segment *begins*: a script is
 * loaded there, and what it puts on the queue is what the first tab then shows.
 */
type Tab =
  | 'queue'
  | 'record'
  | 'perform'
  | 'voice'
  | 'bgm'
  | 'slides'
  | 'dress'
  | 'tune'
  | 'inspect'
  | 'settings';

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

/** What the rail points `aria-controls` at. One region, so a constant. */
const BODY_ID = 'panel-tab-body';

/** The popover the bar's source button opens. */
const SOURCE_ID = 'panel-obs-source';

type Group = 'panel.tabs.group.live' | 'panel.tabs.group.setup';

const TAB_LABELS: Array<{ value: Tab; key: MessageKey; group: Group }> = [
  { value: 'queue', key: 'panel.tabs.queue', group: 'panel.tabs.group.live' },
  { value: 'record', key: 'panel.tabs.record', group: 'panel.tabs.group.live' },
  { value: 'perform', key: 'panel.tabs.perform', group: 'panel.tabs.group.live' },
  { value: 'voice', key: 'panel.tabs.voice', group: 'panel.tabs.group.live' },
  { value: 'bgm', key: 'panel.tabs.bgm', group: 'panel.tabs.group.live' },
  { value: 'slides', key: 'panel.tabs.slides', group: 'panel.tabs.group.live' },
  { value: 'dress', key: 'panel.tabs.dress', group: 'panel.tabs.group.setup' },
  { value: 'tune', key: 'panel.tabs.tune', group: 'panel.tabs.group.setup' },
  { value: 'inspect', key: 'panel.tabs.inspect', group: 'panel.tabs.group.setup' },
  { value: 'settings', key: 'panel.tabs.settings', group: 'panel.tabs.group.setup' },
];

/**
 * What a tab can say about itself from the rail while another tab is up.
 *
 * Only what is running or waiting: a queue with lines in it, a take being
 * written, music playing, a document on screen. A tab with nothing going on
 * stays plain, so a lamp is never part of the furniture.
 */
function railMarks(tab: Tab, snapshot: Snapshot): Pick<RailOption<Tab>, 'badge' | 'lamp'> {
  switch (tab) {
    case 'queue':
      if ((snapshot.state.turn ?? null) !== null) return { lamp: 'live' };
      return snapshot.queue.length > 0 ? { badge: String(snapshot.queue.length) } : {};
    case 'record':
      return snapshot.recording !== null ? { lamp: 'rec' } : {};
    case 'bgm':
      return snapshot.bgm?.transport === 'playing' ? { lamp: 'lit' } : {};
    case 'slides': {
      const slides = snapshot.slides;
      return slides?.deck && slides.pages > 0 ? { badge: `${slides.page}/${slides.pages}` } : {};
    }
    default:
      return {};
  }
}

export function Panel() {
  const { snapshot, error, refresh } = useRuntime();
  const [tab, showTab] = useState<Tab>('queue');
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

  // An empty snapshot rather than a loading state: the panel draws the same
  // layout either way, and every field would otherwise need its own branch.
  const data = snapshot ?? EMPTY;
  const speaking = data.state.speaking ?? false;
  const can = transport(data);
  const notice = SPEECH_NOTICE[data.speech];
  const avatarLabel = data.vocabulary.avatar?.label;

  const tabs: Array<RailOption<Tab>> = TAB_LABELS.map(({ value, key, group }, index) => ({
    value,
    label: t(key),
    group: t(group),
    // Only the digits are keys, so a tenth tab has none to show.
    shortcut: index < 9 ? String(index + 1) : undefined,
    ...railMarks(value, data),
  }));
  const current = TAB_LABELS.find((entry) => entry.value === tab) ?? TAB_LABELS[0];

  // Each tab keeps its own place in the inspector. One shared scroll offset
  // opened the queue halfway down because the gestures had been scrolled to,
  // and lost the gesture row the operator was working from on the way back.
  // Saved before the switch rather than after it, when the offset would already
  // have been clamped to the incoming tab's height.
  const inspector = useRef<HTMLElement>(null);
  const scrolled = useRef(new Map<Tab, number>());
  const shown = useRef(tab);
  shown.current = tab;
  const setTab = useCallback((next: Tab): void => {
    if (inspector.current !== null)
      scrolled.current.set(shown.current, inspector.current.scrollTop);
    showTab(next);
  }, []);
  useLayoutEffect(() => {
    if (inspector.current !== null) inspector.current.scrollTop = scrolled.current.get(tab) ?? 0;
  }, [tab]);

  // Read through a ref so the listener is bound once rather than on every poll.
  const latest = useRef(data);
  latest.current = data;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const action = shortcut(event);
      if (action === null) return;
      const now = latest.current;
      if (action.kind === 'tab') {
        const target = TAB_LABELS[action.index];
        if (target === undefined) return;
        event.preventDefault();
        setTab(target.value);
        return;
      }
      // Claimed even when there is nothing to act on, so Shift+Space never falls
      // through to press whichever button happens to have focus.
      event.preventDefault();
      if (action.kind === 'stop' && transport(now).stop) void interrupt().then(refresh);
      if (action.kind === 'hold' && canHold(now)) void setPaused(!now.paused).then(refresh);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [refresh, setTab]);

  return (
    <div className={styles.panel}>
      <header className={styles.bar}>
        <div className={styles.identity}>
          <span className={styles.mark} aria-hidden="true" />
          <div className={styles.names}>
            <span className={styles.title}>{t('panel.title')}</span>
            <span className={styles.avatar}>{avatarLabel ? tx(avatarLabel) : '—'}</span>
          </div>
        </div>

        <Tally snapshot={data} offline={error !== null} />

        {/* In the bar rather than only in its own tab, because a take runs for
            minutes and the operator spends them in the Slides tab turning
            pages. A recording nobody can see is a recording that gets left
            running into the next segment. Pressing it goes to the tab that
            stops it. */}
        {data.recording !== null ? (
          <button
            type="button"
            className={styles.taking}
            title={t('panel.recording.title')}
            onClick={() => setTab('record')}
          >
            <span className={styles.takingDot} aria-hidden="true" />
            {t('panel.recording')}
            <span className={styles.takingClock}>
              {elapsed(Date.now() / 1000 - data.recording.since)}
            </span>
          </button>
        ) : null}

        {/* Only while something is attached: with nothing there the tally
            already says so, at a size meant to be read from across the room. */}
        {data.connected ? (
          <span className={styles.link}>
            <span className={styles.dot} aria-hidden="true" />
            {t('panel.status.connected', { viewers: data.viewers })}
          </span>
        ) : null}

        {/* The right-hand group: what the operator reaches for, against the edge
            they reach from. The source address is set once a session and the
            transport is pressed all through one, so a rule separates them and
            the transport keeps the corner. */}
        <div className={styles.tools}>
          <button type="button" className={styles.tool} popoverTarget={SOURCE_ID}>
            {t('panel.source.title')}
            <span className={styles.chevron} aria-hidden="true" />
          </button>
          <span className={styles.divider} aria-hidden="true" />
          <div className={styles.transport}>
            <button
              type="button"
              className={styles.clear}
              disabled={!can.drop}
              onClick={() => void clear().then(refresh)}
              title={t('panel.drop.title')}
            >
              {t('panel.drop')}
            </button>
            <button
              type="button"
              className={`${styles.stop} ${speaking ? styles.armed : ''}`}
              disabled={!can.stop}
              onClick={() => void interrupt().then(refresh)}
              title={withKey(t('panel.stop.title'), KEYS.stop.shown)}
              aria-keyshortcuts={KEYS.stop.aria}
            >
              <span className={styles.stopGlyph} aria-hidden="true" />
              {t('panel.stop')}
            </button>
          </div>
        </div>
      </header>

      <StageSource id={SOURCE_ID} snapshot={data} />

      {/* The server restarts during development and the panel stays open. The
          banner appears over the last data rather than replacing it, so a queue
          does not flicker empty and get clicked on by mistake. */}
      {error ? <div className={styles.error}>{error}</div> : null}

      {/* Under the transport error rather than beside it: a control server that
          is gone is the larger fault of the two, and this one is still true
          while it is being fixed. See `SPEECH_NOTICE`. */}
      {notice ? <div className={styles.notice}>{t(notice)}</div> : null}

      <div className={styles.workspace}>
        <nav className={styles.nav}>
          <Rail
            options={tabs}
            value={tab}
            onChange={setTab}
            ariaLabel={t('panel.tabs.aria')}
            controls={BODY_ID}
          />
        </nav>

        {/* The picture, the words being said and the staging chosen by looking
            at both. Not inside the tab panel: it is the same whichever tab is
            up, and a screen reader told it changed on every tab press would be
            describing a change that did not happen. */}
        <main className={styles.stage}>
          <Preview snapshot={data} offline={error !== null} refresh={refresh} />
        </main>

        <section ref={inspector} className={styles.inspector} id={BODY_ID} role="tabpanel">
          <div className={styles.inspectorHead}>
            <h1 className={styles.inspectorTitle}>{t(current.key)}</h1>
          </div>
          <div key={tab} className={styles.inspectorBody}>
            {tab === 'queue' ? <QueueTab snapshot={data} refresh={refresh} /> : null}
            {tab === 'record' ? <RecordTab snapshot={data} refresh={refresh} /> : null}
            {tab === 'perform' ? <PerformTab snapshot={data} refresh={refresh} /> : null}
            {tab === 'voice' ? <VoiceTab snapshot={data} refresh={refresh} /> : null}
            {tab === 'bgm' ? <BgmTab snapshot={data} refresh={refresh} /> : null}
            {tab === 'slides' ? <SlidesTab snapshot={data} refresh={refresh} /> : null}
            {tab === 'dress' ? <DressTab snapshot={data} refresh={refresh} /> : null}
            {tab === 'tune' ? <TuneTab snapshot={data} /> : null}
            {tab === 'inspect' ? <InspectTab snapshot={data} /> : null}
            {tab === 'settings' ? <SettingsTab /> : null}
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * The tally: on air, held or standing by, and how much is still to say.
 *
 * The same three states the queue tab's on-air strip names, lifted into the bar
 * so they are on screen whichever tab is up. The figure after them is the
 * queue's own estimate, so the two never disagree.
 *
 * A fourth, offline, outranks them all: with the control server gone the panel
 * is showing its last snapshot, and "standing by" read from across the room
 * would say all is well about a run nothing is driving. A fifth, no renderer,
 * comes next: the server holds the queue until one attaches and then plays it,
 * so the figures are true but nothing is performing them yet.
 */
type TallyState = 'offline' | 'unattached' | 'live' | 'held' | 'idle';

const TALLY_LABELS: Record<TallyState, MessageKey> = {
  offline: 'panel.tally.offline',
  unattached: 'panel.tally.unattached',
  live: 'panel.queue.onAir',
  held: 'panel.queue.held',
  idle: 'panel.queue.standingBy',
};

/** Which of the five the tally shows, in the order of precedence above. */
export function tallyState(snapshot: Snapshot, offline: boolean): TallyState {
  if (offline) return 'offline';
  if (!snapshot.connected) return 'unattached';
  if ((snapshot.state.turn ?? null) !== null) return 'live';
  return snapshot.paused ? 'held' : 'idle';
}

function Tally({ snapshot, offline }: { snapshot: Snapshot; offline: boolean }) {
  const { t } = useT();
  const state = tallyState(snapshot, offline);
  const { seconds } = checkQueue(snapshot.queue, snapshot.vocabulary);
  return (
    <div className={`${styles.tally} ${styles[state] ?? ''}`}>
      <span className={styles.tallyLamp} aria-hidden="true" />
      <span key={state} className={styles.tallyState}>
        {t(TALLY_LABELS[state])}
      </span>
      <span className={styles.tallyRule} aria-hidden="true" />
      <span className={styles.tallyFigure}>
        {t('panel.tally.waiting', { count: snapshot.queue.length })}
      </span>
      <span className={styles.tallyFigure}>
        {t('panel.queue.remaining', { time: clock(seconds) })}
      </span>
    </div>
  );
}
