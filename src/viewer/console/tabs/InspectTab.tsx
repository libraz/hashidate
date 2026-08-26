import { useEffect, useRef, useState } from 'react';
import { ZONES } from '@/engine/anatomy';
import type { JointReading, SessionEvent, SessionState, Side } from '@/engine/types';
import { useTick } from '../../hooks';
import type { LoadedAvatar } from '../../scene/runtime';
import { Section } from '../../ui/Section';
import { Segmented } from '../../ui/Segmented';
import styles from './InspectTab.module.css';

const SIDES: Array<{ value: Side; label: string }> = [
  { value: 'R', label: '右腕' },
  { value: 'L', label: '左腕' },
];

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
        title="関節の負担"
        meta={state ? `L ${state.strain.L.toFixed(2)} · R ${state.strain.R.toFixed(2)}` : ''}
        note={[
          '各関節の実測値と判定。緑は日常の動作が使う範囲、黄はやればできるが無理のある範囲、赤は解剖学的な限界に張り付いている。',
          '限界に達した関節はそこで止まるので、要求どおりの姿勢にはならない。「—」は姿勢からその量が決まらないもの — 下ろした腕の挙上面や、伸びきった腕の回旋がそれにあたる。',
          '身体貫通は角度ではなく体幹半径に対する割合。腕が自分の胸や頭にめり込んでいる量で、これだけは可動域とは別の話。',
        ]}
      >
        <Segmented ariaLabel="どちらの腕" options={SIDES} value={side} onChange={setSide} />
        {rows ? (
          <div className={styles.joints}>
            {rows.map((r) => (
              <div key={r.id} className={styles.joint}>
                <span className={styles.jointLabel}>{r.label}</span>
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
                  {r.measured ? ZONES[r.zone] : '—'}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.facts}>体幹フレーム未解決のため計測不可</p>
        )}
      </Section>

      <Section
        title="プロファイル"
        meta={profile.missing.length ? `未解決 ${profile.missing.length}` : '完全'}
        note={[
          'エンジンが読み込み時にこのモデルから見つけたもの。ボーン名もシェイプ名も作者ごとに違うので、正規スロットへの対応付けはすべてここで解決している。',
          '未解決があっても動く — 解決できなかったものはその機能が黙って落ちるだけで、失敗にはならない。',
        ]}
      >
        <div className={styles.facts}>
          <Fact label="ARKit" value={`${profile.arkit.count} / 52`} />
          <Fact
            label="ビセーム"
            value={Object.entries(profile.viseme)
              .map(([k, v]) => `${k}=${v}`)
              .join(' · ')}
          />
          <Fact label="指ボーン" value={`${Object.keys(profile.fingerBones).length} 系統`} />
          <Fact label="表情メッシュ" value={`${profile.faceMeshes.length}`} />
          <Fact label="シェイプ群" value={groups || 'なし'} />
          <Fact label="未解決" value={profile.missing.join(' / ') || 'なし'} />
        </div>
      </Section>

      <Section
        title="イベント"
        meta={`${log.length}`}
        note={[
          'セッションが出すターン境界。外部の制御 API が受け取るのと同じもので、オーケストレータはこれを待って次の行を送る。',
        ]}
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
          <p className={styles.facts}>まだ何も起きていない。</p>
        )}
      </Section>

      <Section
        title="語彙"
        meta={avatar.id}
        note={[
          'このアバターに何を頼めるかの一覧。宣言ではなく発見されたもので、表情はモデル自身のシェイプ群から、衣装はメッシュから引いている。アバターを差し替えると中身が変わる。',
          'LLM のシステムプロンプトに貼るのはこのオブジェクト。',
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
