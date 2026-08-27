import { useState } from 'react';
import { Segmented } from '@/ui/Segmented';
import { clear, interrupt } from './api';
import { DressTab } from './dress/DressTab';
import { EMPTY, useRuntime } from './hooks';
import { InspectTab } from './inspect/InspectTab';
import styles from './Panel.module.css';
import { PerformTab } from './perform/PerformTab';
import { Preview } from './preview/Preview';
import { QueueTab } from './queue/QueueTab';
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
 * 停止 and 以降を破棄 apply whatever is on screen. During a broadcast the thing
 * that has to be reachable in one movement is the stop, and a stop that lives
 * inside a tab is a stop that is behind a click when it is needed.
 *
 * `--live` marks the character speaking and nothing else, per the token file. On
 * this page it is the header's only colour, which is what makes "is it talking
 * right now" answerable from across a room.
 */

/**
 * The tabs, in the order a broadcast uses them.
 *
 * The first three are touched during one: the script, the acting, the voice.
 * The last three are set before it and looked at when something is wrong — a
 * costume, the layer underneath the character, and the readouts. The four names
 * borrowed from the console are the console's, deliberately: an operator moving
 * between the two screens should not have to learn a second vocabulary for the
 * same jobs.
 */
type Tab = 'queue' | 'perform' | 'voice' | 'dress' | 'tune' | 'inspect';

const TABS = [
  { value: 'queue' as const, label: 'キュー' },
  { value: 'perform' as const, label: '演じる' },
  { value: 'voice' as const, label: '音声' },
  { value: 'dress' as const, label: '装う' },
  { value: 'tune' as const, label: '調律' },
  { value: 'inspect' as const, label: '診る' },
];

export function Panel() {
  const { snapshot, error, refresh } = useRuntime();
  const [tab, setTab] = useState<Tab>('queue');

  // An empty snapshot rather than a loading state: the panel draws the same
  // layout either way, and every field would otherwise need its own branch.
  const data = snapshot ?? EMPTY;
  const speaking = data.state.speaking ?? false;

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <div className={styles.identity}>
          <span className={styles.title}>配信パネル</span>
          <span className={styles.avatar}>{data.vocabulary.avatar?.label ?? '—'}</span>
        </div>

        <span className={`${styles.link} ${data.connected ? styles.online : ''}`}>
          <span className={styles.dot} aria-hidden="true" />
          {data.connected ? `接続 ${data.viewers}` : 'レンダラー未接続'}
        </span>

        <div className={styles.transport}>
          <button
            type="button"
            className={styles.clear}
            onClick={() => void clear().then(refresh)}
            title="いま言っている行は終わらせて、以降を破棄します"
          >
            以降を破棄
          </button>
          <button
            type="button"
            className={`${styles.stop} ${speaking ? styles.armed : ''}`}
            onClick={() => void interrupt().then(refresh)}
            title="いま言っている行を途中で切り、待ち行列も破棄します"
          >
            停止
          </button>
        </div>
      </header>

      {/* The server restarts during development and the panel stays open. The
          banner appears over the last data rather than replacing it, so a queue
          does not flicker empty and get clicked on by mistake. */}
      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.tabs}>
        <Segmented options={TABS} value={tab} onChange={setTab} ariaLabel="パネル" />
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
          {tab === 'perform' ? <PerformTab snapshot={data} refresh={refresh} /> : null}
          {tab === 'voice' ? <VoiceTab snapshot={data} refresh={refresh} /> : null}
          {tab === 'dress' ? <DressTab snapshot={data} refresh={refresh} /> : null}
          {tab === 'tune' ? <TuneTab snapshot={data} /> : null}
          {tab === 'inspect' ? <InspectTab snapshot={data} /> : null}
        </div>
      </main>
    </div>
  );
}
