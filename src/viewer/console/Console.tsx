import { useEffect, useState } from 'react';
import { AVATARS } from '@/avatars';
import type { CameraFrame } from '@/engine/types';
import type { ControlStatus } from '../control-client';
import { useSessionState } from '../hooks';
import { CAMERA_FRAMES, CAMERA_LABELS } from '../scene/framing';
import type { AvatarRuntime, RuntimeStatus } from '../scene/runtime';
import { Chip, ChipRow } from '../ui/Chip';
import { Segmented } from '../ui/Segmented';
import { Toggle } from '../ui/Toggle';
import styles from './Console.module.css';
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
 *   演じる  the live surface — face, gesture, pointing, the demo script
 *   装う    the wardrobe, which is avatar data and a separate task
 *   調律    every slider that is set once and left
 *   診る    read-only: joint strain, the resolved profile, the event log
 *
 * The avatar picker, the camera framing, the idle switch and the speech box all
 * sit outside the tabs, because none of them belongs to one of those four jobs.
 */

const TABS = [
  { value: 'perform', label: '演じる' },
  { value: 'dress', label: '装う' },
  { value: 'tune', label: '調律' },
  { value: 'inspect', label: '診る' },
] as const;

type TabId = (typeof TABS)[number]['value'];

interface Props {
  runtime: AvatarRuntime | null;
  status: RuntimeStatus;
  control: ControlStatus;
  rejected: number;
  onSwitch: (id: string) => void;
}

export function Console({ runtime, status, control, rejected, onSwitch }: Props) {
  const [tab, setTab] = useState<TabId>('perform');
  const [text, setText] = useState('こんばんは。今日も配信を見に来てくれてありがとうございます。');
  // Followed, not held: the control API can change the shot too, and a picker
  // showing the old framing after the orchestrator moved the camera is worse
  // than no picker.
  const [frame, setFrame] = useState<CameraFrame>('bust');
  useEffect(() => runtime?.onCamera(setFrame), [runtime]);

  const loaded = status.phase === 'ready' ? status.loaded : null;
  const session = loaded?.session ?? null;
  const state = useSessionState(session);

  const say = () => {
    if (!(session && text.trim())) return;
    session.say({ text });
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

  return (
    <div className={styles.console}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <h1 className={styles.title}>AITUBER</h1>
          <span className={`${styles.link} ${control === 'online' ? styles.online : ''}`}>
            <span className={styles.linkDot} />
            {control === 'online' ? '制御接続' : '制御未接続'}
            {rejected > 0 ? ` · 不正 ${rejected}` : ''}
          </span>
        </div>
        <Segmented
          ariaLabel="アバター"
          options={AVATARS.map((a) => ({ value: a.id, label: a.label }))}
          value={loaded?.avatar.id ?? (status.phase === 'loading' ? status.avatar.id : null)}
          onChange={onSwitch}
        />
        {loaded ? (
          <div className={styles.author}>
            {loaded.avatar.author ?? '—'} · ARKit {loaded.profile.arkit.count}/52 · シェイプ{' '}
            {Object.keys(loaded.profile.dict).length}
          </div>
        ) : null}
      </header>

      <div className={styles.toolbar}>
        <Segmented
          ariaLabel="カメラ"
          options={CAMERA_FRAMES.map((f) => ({ value: f, label: CAMERA_LABELS[f] }))}
          value={frame}
          onChange={goto}
        />
        <Toggle
          label="自動モード（アイドル）"
          checked={state?.idleEnabled ?? false}
          onChange={(v) => {
            session?.setIdle(v);
            if (!v) session?.resetExpression();
          }}
        />
      </div>

      <div className={styles.tabs}>
        <Segmented ariaLabel="操作の種類" options={TABS} value={tab} onChange={setTab} />
      </div>

      <div className={styles.body}>
        {status.phase === 'failed' ? (
          <>
            <p className={styles.problems}>{status.message}</p>
            <p className={styles.empty}>別のアバターを選ぶか、make glb で書き出し直す。</p>
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
          <p className={styles.empty}>読み込み中…</p>
        ) : null}
      </div>

      <div className={styles.composer}>
        <textarea
          id="speech"
          name="speech"
          aria-label="しゃべらせたい文章"
          className={styles.input}
          value={text}
          placeholder="しゃべらせたい文章"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              say();
            }
          }}
        />
        <div className={styles.composerRow}>
          <span className={styles.hint}>
            {state?.queued ? `待ち ${state.queued}` : '⌘⏎ / Space'}
          </span>
          <ChipRow>
            <Chip label="止める" variant="action" onClick={() => session?.interrupt()} />
            <Chip label="話す" variant="primary" onClick={say} />
          </ChipRow>
        </div>
      </div>
    </div>
  );
}
