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
  const strain = state.strain;
  // Newest first: the row anybody is looking for is the one that just happened.
  const log = [...events].reverse().slice(0, SHOWN);

  return (
    <>
      <Section
        title="接続"
        meta={snapshot.connected ? `${snapshot.viewers}` : '未接続'}
        note={[
          'レンダラーが何面つながっているか。パネルのプレビューも一面として数える。',
          '「未接続」は誰もいないか、報告が途絶えて数秒たった状態。ビューアのタブを閉じるとこうなる。',
        ]}
      >
        <div className={styles.facts}>
          <Fact label="ビューア" value={`${snapshot.viewers}`} />
          <Fact label="アバター" value={vocabulary.avatar?.label ?? '—'} />
          <Fact label="読み込める" value={avatars.map((a) => a.label).join(' · ') || '—'} />
          <Fact label="待ち行列" value={`${snapshot.queue.length}`} />
          <Fact label="イベント通番" value={`${snapshot.seq}`} />
        </div>
      </Section>

      <Section
        title="関節の負担"
        meta={strain ? `L ${strain.L.toFixed(2)} · R ${strain.R.toFixed(2)}` : ''}
        note={[
          '直近の指さしで腕がどれだけ無理をしたか。0 は楽な範囲、1 を超えると届かないところへ手を伸ばしている。',
          '可動域を超える指示は失敗せず、届く範囲で止まる。この数字だけが、要求どおりの姿勢になったかどうかを教える。',
          '関節ごとの内訳はレンダラー側のコンソールにある — 毎秒何度も測り直すもので、この線に載せるものではない。',
        ]}
      >
        <div className={styles.facts}>
          <Fact label="右腕" value={strain ? strain.R.toFixed(2) : '—'} />
          <Fact label="左腕" value={strain ? strain.L.toFixed(2) : '—'} />
        </div>
      </Section>

      <Section
        title="音声"
        meta={voice ? (voice.preset ?? '素通し') : ''}
        note={[
          '直近の一行の測定値。ラウドネスは配信の基準に対して、真のピークは 0 を超えると歪む。',
          '「ブロック」はブラウザがまだ音声デバイスを許していない状態で、ここからは直せない — ビューアの画面を一度クリックする必要がある。',
        ]}
      >
        {voice ? (
          <div className={styles.facts}>
            <Fact label="チェイン" value={voice.preset ?? '素通し'} />
            <Fact label="部屋" value={voice.room ?? 'ドライ'} />
            <Fact
              label="ラウドネス"
              value={voice.lufs === null ? '—' : `${voice.lufs.toFixed(1)} LUFS`}
            />
            <Fact
              label="真のピーク"
              value={voice.truePeakDb === null ? '—' : `${voice.truePeakDb.toFixed(1)} dBTP`}
            />
            <Fact label="ブロック" value={voice.blocked ? 'あり' : 'なし'} />
          </div>
        ) : (
          <p className={styles.empty}>声を持つビューアがまだ報告していない。</p>
        )}
      </Section>

      <Section
        title="イベント"
        meta={`${events.length}`}
        note={[
          'レンダラーが返すターン境界。オーケストレータが次の行を送るのを待つのもこれで、外部の制御 API が受け取るのと同じもの。',
        ]}
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
          <p className={styles.empty}>まだ何も起きていない。</p>
        )}
      </Section>

      <Section
        title="語彙"
        meta={vocabulary.avatar?.id ?? ''}
        note={[
          'このアバターに何を頼めるかの一覧。宣言ではなく発見されたもので、表情はモデル自身のシェイプ群から、衣装はメッシュから引いている。差し替えると中身が変わる。',
          'LLM のシステムプロンプトに貼るのはこのオブジェクト。',
        ]}
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
