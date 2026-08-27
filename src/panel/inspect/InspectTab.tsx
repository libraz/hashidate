import { useT } from '@/i18n';
import type { SessionEvent, Snapshot } from '@/protocol';
import { Section } from '@/ui/Section';
import styles from './InspectTab.module.css';

/**
 * Read-only: what is actually true right now.
 *
 * The counterpart to the console's tab of the same name, and deliberately not
 * the same list. That one measures the rig — every joint angle against its
 * anatomical range, the resolved profile, what the loader could not find — by
 * asking the live scene for a fresh report several times a second. None of that
 * is on the wire, and putting it there would be moving a debugging instrument
 * onto a broadcast connection to be sampled by a panel that is usually looking
 * at something else.
 *
 * What is here is what the control API already carries and what a broadcast
 * actually goes wrong in: how much the arm is straining, what the renderer has
 * been reporting, and the vocabulary — which is the thing to paste into an
 * orchestrator's prompt and the first thing to check when a command is being
 * ignored.
 */

/** How many events to show. The server keeps far more; this is a tail. */
const SHOWN = 60;

export function InspectTab({ snapshot }: { snapshot: Snapshot }) {
  const { state, vocabulary, voice, events, avatars } = snapshot;
  const { t, tx } = useT();
  const strain = state.strain;
  // Newest first: the row anybody is looking for is the one that just happened.
  const log = [...events].reverse().slice(0, SHOWN);

  return (
    <>
      <Section
        title={t('panel.inspect.link')}
        meta={snapshot.connected ? `${snapshot.viewers}` : t('panel.inspect.link.none')}
        note={[t('panel.inspect.link.note1'), t('panel.inspect.link.note2')]}
      >
        <div className={styles.facts}>
          <Fact label={t('panel.inspect.viewers')} value={`${snapshot.viewers}`} />
          <Fact
            label={t('panel.inspect.avatar')}
            value={vocabulary.avatar?.label ? tx(vocabulary.avatar.label) : '—'}
          />
          <Fact
            label={t('panel.inspect.loadable')}
            value={avatars.map((a) => tx(a.label)).join(' · ') || '—'}
          />
          <Fact label={t('panel.inspect.queue')} value={`${snapshot.queue.length}`} />
          <Fact label={t('panel.inspect.seq')} value={`${snapshot.seq}`} />
        </div>
      </Section>

      <Section
        title={t('panel.inspect.strain')}
        meta={strain ? `L ${strain.L.toFixed(2)} · R ${strain.R.toFixed(2)}` : ''}
        note={[
          t('panel.inspect.strain.note1'),
          t('panel.inspect.strain.note2'),
          t('panel.inspect.strain.note3'),
        ]}
      >
        <div className={styles.facts}>
          <Fact label={t('panel.inspect.rightArm')} value={strain ? strain.R.toFixed(2) : '—'} />
          <Fact label={t('panel.inspect.leftArm')} value={strain ? strain.L.toFixed(2) : '—'} />
        </div>
      </Section>

      <Section
        title={t('panel.inspect.voice')}
        meta={voice ? (voice.preset ?? t('panel.inspect.voice.bypass')) : ''}
        note={[t('panel.inspect.voice.note1'), t('panel.inspect.voice.note2')]}
      >
        {voice ? (
          <div className={styles.facts}>
            <Fact
              label={t('panel.inspect.chain')}
              value={voice.preset ?? t('panel.inspect.voice.bypass')}
            />
            <Fact label={t('panel.inspect.room')} value={voice.room ?? t('panel.inspect.dry')} />
            <Fact
              label={t('panel.inspect.loudness')}
              value={voice.lufs === null ? '—' : `${voice.lufs.toFixed(1)} LUFS`}
            />
            <Fact
              label={t('panel.inspect.truePeak')}
              value={voice.truePeakDb === null ? '—' : `${voice.truePeakDb.toFixed(1)} dBTP`}
            />
            <Fact
              label={t('panel.inspect.blocked')}
              value={voice.blocked ? t('panel.inspect.yes') : t('panel.inspect.no')}
            />
          </div>
        ) : (
          <p className={styles.empty}>{t('panel.inspect.voice.empty')}</p>
        )}
      </Section>

      <Section
        title={t('panel.inspect.events')}
        meta={`${events.length}`}
        note={[t('panel.inspect.events.note')]}
      >
        {log.length ? (
          <div className={styles.log}>
            {log.map((event) => (
              <div className={styles.entry} key={event.seq ?? `${event.type}-${event.turn}`}>
                <span className={styles.entryTime}>{stamp(event)}</span>
                <span className={styles.entryType}>{event.type}</span>
                <span className={styles.entryBody}>
                  {event.turn ?? event.turns?.join(',') ?? ''}
                  {event.seconds !== undefined ? ` ${event.seconds.toFixed(1)}s` : ''}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.empty}>{t('panel.inspect.events.empty')}</p>
        )}
      </Section>

      <Section
        title={t('panel.inspect.vocabulary')}
        meta={vocabulary.avatar?.id ?? ''}
        note={[t('panel.inspect.vocabulary.note1'), t('panel.inspect.vocabulary.note2')]}
      >
        <pre className={styles.json}>{JSON.stringify(vocabulary, null, 1)}</pre>
      </Section>
    </>
  );
}

/** Wall-clock, since an event is remembered as "the one just before it broke". */
function stamp(event: SessionEvent): string {
  if (event.at === undefined) return '—';
  return new Date(event.at * 1000).toLocaleTimeString('ja-JP', { hour12: false });
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.fact}>
      <span className={styles.factLabel}>{label}</span>
      <span className={styles.factValue}>{value}</span>
    </div>
  );
}
