import { useEffect, useRef, useState } from 'react';
import { ZONES } from '@/engine/anatomy';
import type { JointReading, SessionEvent, SessionState, Side } from '@/engine/types';
import { type MessageKey, useT } from '@/i18n';
import { Section } from '@/ui/Section';
import { Segmented } from '@/ui/Segmented';
import { useTick } from '../../hooks';
import type { LoadedAvatar } from '../../scene/runtime';
import styles from './InspectTab.module.css';

const SIDES = [
  { value: 'R', message: 'console.inspect.side.right' },
  { value: 'L', message: 'console.inspect.side.left' },
] as const satisfies ReadonlyArray<{ value: Side; message: MessageKey }>;

/** How many turn events to keep. Enough to see a whole demo script sequence. */
const LOG_LIMIT = 60;

/** A stable key for the log. Turn ids repeat across `turn.start` / `turn.end`. */
interface LoggedEvent {
  seq: number;
  event: SessionEvent;
}

/**
 * Read-only.
 *
 * These three readouts used to be scattered through the panel — the joint table
 * inside the pointing section, the profile figures inside a render section, the
 * event stream nowhere at all. They answer a different question from the rest of
 * the console ("what is actually true right now") and they are what a swap or a
 * failed export is diagnosed from, so they are together.
 */
export function InspectTab({
  loaded,
  state,
}: {
  loaded: LoadedAvatar;
  state: SessionState | null;
}) {
  const { t, tx } = useT();
  const { director, profile, session, avatar } = loaded;
  const [side, setSide] = useState<Side>('R');

  // `rig.measure` allocates a fresh report, so it is pulled at a low rate rather
  // than carried in the polled session state.
  useTick(5);
  const rows: JointReading[] | null = director.rig.measure(side);

  const log = useEventLog(session);

  const groups = [...profile.groups].map(([g, s]) => `${g}:${s.length}`).join(' · ');

  return (
    <>
      <Section
        title={t('console.inspect.strain')}
        meta={state ? `L ${state.strain.L.toFixed(2)} · R ${state.strain.R.toFixed(2)}` : ''}
        note={[
          t('console.inspect.strain.note.zones'),
          t('console.inspect.strain.note.limits'),
          t('console.inspect.strain.note.penetration'),
        ]}
      >
        <Segmented
          ariaLabel={t('console.inspect.side.aria')}
          options={SIDES.map((s) => ({ value: s.value, label: t(s.message) }))}
          value={side}
          onChange={setSide}
        />
        {rows ? (
          <div className={styles.joints}>
            {rows.map((r) => (
              <div key={r.id} className={styles.joint}>
                <span className={styles.jointLabel}>{tx(r.label)}</span>
                <span className={styles.jointValue}>
                  {r.deg >= 0 ? '' : '−'}
                  {Math.abs(r.deg).toFixed(0)}
                  {r.unit ?? '°'}
                </span>
                <span
                  className={`${styles.jointZone} ${
                    r.measured ? styles[r.zone] : styles.unmeasured
                  }`}
                >
                  {r.measured ? tx(ZONES[r.zone]) : '—'}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.facts}>{t('console.inspect.strain.unmeasurable')}</p>
        )}
      </Section>

      <Section
        title={t('console.inspect.profile')}
        meta={
          profile.missing.length
            ? t('console.inspect.profile.unresolved', { count: profile.missing.length })
            : t('console.inspect.profile.complete')
        }
        note={[
          t('console.inspect.profile.note.discovered'),
          t('console.inspect.profile.note.partial'),
        ]}
      >
        <div className={styles.facts}>
          <Fact label="ARKit" value={`${profile.arkit.count} / 52`} />
          <Fact
            label={t('console.inspect.fact.viseme')}
            value={Object.entries(profile.viseme)
              .map(([k, v]) => `${k}=${v}`)
              .join(' · ')}
          />
          <Fact
            label={t('console.inspect.fact.fingerBones')}
            value={t('console.inspect.fact.chains', {
              count: Object.keys(profile.fingerBones).length,
            })}
          />
          <Fact
            label={t('console.inspect.fact.faceMeshes')}
            value={`${profile.faceMeshes.length}`}
          />
          <Fact label={t('console.inspect.fact.shapeGroups')} value={groups || t('console.none')} />
          <Fact
            label={t('console.inspect.fact.unresolved')}
            value={profile.missing.join(' / ') || t('console.none')}
          />
        </div>
      </Section>

      <Section
        title={t('console.inspect.events')}
        meta={`${log.length}`}
        note={[t('console.inspect.events.note')]}
      >
        {log.length ? (
          <div className={styles.log}>
            {log.map(({ seq, event }) => (
              <div className={styles.entry} key={seq}>
                <span className={styles.entryType}>{event.type}</span>
                <span className={styles.entryBody}>
                  {event.turn ?? event.turns?.join(',') ?? ''}
                  {event.seconds !== undefined ? ` ${event.seconds.toFixed(1)}s` : ''}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.facts}>{t('console.inspect.events.empty')}</p>
        )}
      </Section>

      <Section
        title={t('console.inspect.vocabulary')}
        meta={avatar.id}
        note={[
          t('console.inspect.vocabulary.note.discovered'),
          t('console.inspect.vocabulary.note.prompt'),
        ]}
      >
        <pre className={styles.json}>{JSON.stringify(session.vocabulary(), null, 1)}</pre>
      </Section>
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.fact}>
      <span className={styles.factLabel}>{label}</span>
      <span className={styles.factValue}>{value}</span>
    </div>
  );
}

/**
 * A local ring of turn events, newest first.
 *
 * Subscribed rather than drained: `session.takeEvents()` empties the queue, and
 * the control channel is already draining it to send upstream. Two consumers of
 * a drain means each sees half the log.
 */
function useEventLog(session: LoadedAvatar['session']): LoggedEvent[] {
  const [log, setLog] = useState<LoggedEvent[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    setLog([]);
    return session.on((event) => {
      seq.current += 1;
      const entry = { seq: seq.current, event };
      setLog((prev) => [entry, ...prev].slice(0, LOG_LIMIT));
    });
  }, [session]);

  return log;
}
