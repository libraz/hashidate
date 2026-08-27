import type { Session } from '@/engine/session';
import type { Vocabulary } from '@/engine/types';

/**
 * The self-test: everything this avatar can do, performed once, unattended.
 *
 * The viewer's console can reach every control individually, which is what it is
 * for — but "does this avatar work" is a question about all of them, and
 * answering it by hand means forty clicks and remembering which of the forty
 * were skipped. After a re-export, a profile change or a swap to a rig nobody
 * has driven yet, that is exactly the question, and it is asked on a machine
 * with no orchestrator running.
 *
 * So the demo walks the *vocabulary* rather than a written script. The
 * vocabulary is discovered from the loaded avatar — its own shape groups, its
 * own meshes — so the sequence is different per avatar and is always complete
 * for the one on screen. A performance that exists and is broken gets played; a
 * fixture list would have gone stale the first time the table grew.
 *
 * ## It drives the session, not the director
 *
 * Everything below is a `Session` call, which means it goes through the turn
 * queue, the idle suspension and — where a speech sidecar is running — the
 * synthesiser. A demo that posed the director directly would exercise the layer
 * least likely to be wrong and skip the one most likely to be: the sequencing.
 *
 * ## Steps wait for the character, not for the clock
 *
 * A step is done when the session is no longer busy, with a hold afterwards so
 * that a pose can be looked at. Timing each step instead would either rush the
 * long lines or leave dead air after the short ones, and the whole point is to
 * watch it.
 */

/** One thing to do, and how long to hold afterwards so it can be seen. */
export interface Step {
  label: string;
  hold: number;
  run: (session: Session) => void;
}

/** How long a pose with no line in it is held. Long enough to read a silhouette. */
const POSE_HOLD = 1.6;

/** After a spoken line. Shorter, because the line itself was the time. */
const LINE_HOLD = 0.5;

/**
 * How long a step may take before the demo gives up on it and moves on.
 *
 * A sustained gesture is held until it is released, so `busy` never clears on
 * its own; without this the walk would stop on the first one. Also the backstop
 * for a turn whose voice never answered, though the session has its own.
 */
const STEP_TIMEOUT = 12;

/**
 * Build the walk for one avatar.
 *
 * Ordered from the least to the most disruptive: the camera and the face first,
 * because a mistake there is visible without anything else moving; the wardrobe
 * last, because it swaps meshes and a failure in it hides everything after it.
 */
export function buildDemo(vocabulary: Vocabulary): Step[] {
  const steps: Step[] = [];

  const pose = (label: string, run: (s: Session) => void): void => {
    steps.push({ label, hold: POSE_HOLD, run });
  };
  const line = (label: string, run: (s: Session) => void): void => {
    steps.push({ label, hold: LINE_HOLD, run });
  };

  // --- the shot -------------------------------------------------------------
  for (const frame of vocabulary.cameras) {
    pose(`カメラ ${frame}`, (s) => s.setCamera(frame));
  }
  pose('カメラを戻す', (s) => s.setCamera('bust'));

  // --- the face -------------------------------------------------------------
  // The emotion vector before the drawn expressions, because the drawn ones sit
  // on top of it: a mask that never lifts is only visible against a face that
  // was doing something underneath.
  for (const emotion of vocabulary.emotions) {
    pose(`感情 ${emotion.label}`, (s) => s.setEmotion({ [emotion.id]: 1 }));
  }
  pose('感情を戻す', (s) => s.setEmotion({ neutral: 1 }));

  for (const expression of vocabulary.expressions) {
    pose(`表情 ${expression.label}`, (s) => s.setExpression(expression.id));
  }
  pose('表情を解除', (s) => s.resetExpression());

  for (const overlay of vocabulary.overlays) {
    pose(`効果 ${overlay.label}`, (s) => s.setOverlay(overlay.id, 1));
    pose(`効果 ${overlay.label} を下げる`, (s) => s.setOverlay(overlay.id, 0));
  }

  // --- the body -------------------------------------------------------------
  // Performances first and in full, since they are the command an orchestrator
  // should be reaching for and each one is a face and a movement together.
  for (const performance of vocabulary.performances) {
    pose(`演技 ${performance.label}`, (s) => s.perform(performance.id));
  }
  pose('演技を解除', (s) => s.perform(null));

  for (const gesture of vocabulary.gestures) {
    pose(`動作 ${gesture.label}`, (s) => s.gesture(gesture.id));
  }
  pose('動作を停止', (s) => s.stopGesture());

  for (const hop of vocabulary.hops) {
    pose(`跳躍 ${hop.label}`, (s) => s.hop(hop.id));
  }

  // Pointing is continuous, so it is swept rather than enumerated: the failure
  // it has is a discontinuity between two elbow solutions, which only shows up
  // when the arm travels through the range rather than jumping across it.
  for (const side of vocabulary.pointing.side) {
    for (const azimuth of [-90, -45, 0, 45, 90]) {
      steps.push({
        label: `指差し ${side} ${azimuth}°`,
        hold: 0.45,
        run: (s) => s.point({ side, azimuth, elevation: 10, extent: 0.85 }),
      });
    }
  }
  pose('腕を下ろす', (s) => s.stopGesture());

  // --- the voice ------------------------------------------------------------
  // One line per room, and the same line, so the rooms can be told apart. This
  // is silent on a machine with no sidecar and still exercises the mouth, which
  // is the part that has to work either way.
  line('台詞', (s) => s.say({ text: 'こんばんは。動作確認をしています。' }));
  line('読み付きの台詞', (s) => s.say({ text: '三件あります。', reading: 'さんけんあります' }));

  const cueable = vocabulary.performances.slice(0, 2).map((p) => p.id);
  if (cueable.length === 2) {
    // The one thing no other step covers: a performance change landing partway
    // through a line, on the mouth's own clock.
    line('行中のキュー', (s) =>
      s.say({
        text: `[${cueable[0]}]まずこう言って、[${cueable[1]}]途中で表情が変わります。`,
      }),
    );
  }

  for (const room of vocabulary.rooms) {
    line(`部屋 ${room.label}`, (s) => {
      s.setRoom(room.id);
      s.say({ text: 'この部屋の響きです。' });
    });
  }
  if (vocabulary.rooms.length) pose('部屋をドライに', (s) => s.setRoom(null));

  // --- the wardrobe ---------------------------------------------------------
  // Last: it swaps meshes, and a failure here leaves the character missing a
  // garment for everything that follows.
  for (const preset of vocabulary.wardrobePresets) {
    pose(`衣装 ${preset.label}`, (s) => s.wear({ preset: preset.id }));
  }

  steps.push({
    label: 'おわり',
    hold: 0,
    run: (s) => {
      s.perform(null);
      s.resetExpression();
      s.setCamera('bust');
    },
  });

  return steps;
}

export interface DemoState {
  running: boolean;
  /** Index of the step in flight, or -1. */
  index: number;
  label: string;
  total: number;
}

/**
 * Runs a walk, one step at a time, on the frame loop's clock.
 *
 * `tick` is called from the render loop rather than from a timer, so the demo
 * stops advancing when the tab does — a walk that ran on `setInterval` in a
 * backgrounded tab would fire thirty poses into a renderer that drew none of
 * them, and end reporting success.
 */
export class Demo {
  private steps: Step[] = [];
  private index = -1;
  private held = 0;
  private elapsed = 0;
  private started = false;
  private readonly listeners = new Set<(state: DemoState) => void>();

  constructor(private readonly session: Session) {}

  get state(): DemoState {
    return {
      running: this.index >= 0,
      index: this.index,
      label: this.steps[this.index]?.label ?? '',
      total: this.steps.length,
    };
  }

  on(fn: (state: DemoState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const state = this.state;
    for (const fn of this.listeners) fn(state);
  }

  /** Begin, from the top, on the vocabulary the avatar currently advertises. */
  start(): void {
    this.steps = buildDemo(this.session.vocabulary());
    this.index = -1;
    this.held = 0;
    this.elapsed = 0;
    this.started = false;
    this.advance();
  }

  /**
   * Stop where it is, and leave the character somewhere presentable.
   *
   * Not just a flag: a demo stopped mid-gesture with a drawn expression up and
   * the camera on a close-up leaves the viewer looking broken, and the operator
   * who stopped it was usually stopping it to look at something else.
   */
  stop(): void {
    if (this.index < 0) return;
    this.index = -1;
    this.session.interrupt();
    this.session.perform(null);
    this.session.resetExpression();
    this.session.setEmotion({ neutral: 1 });
    this.session.setRoom(null);
    this.emit();
  }

  /** Call once per frame. Does nothing unless a walk is in flight. */
  tick(dt: number): void {
    if (this.index < 0) return;
    const step = this.steps[this.index];
    if (!step) return;

    this.elapsed += dt;
    // `busy` is false for the first frame after a turn is queued — the queue is
    // read on the *next* update — so a step is not considered finished until it
    // has been seen busy at least once, or has run past a step with no work in
    // it at all.
    if (this.session.busy) this.started = true;
    const settled = this.started ? !this.session.busy : this.elapsed > 0.1;
    if (!(settled || this.elapsed > STEP_TIMEOUT)) return;

    this.held += dt;
    if (this.held < step.hold) return;
    this.advance();
  }

  private advance(): void {
    this.index += 1;
    this.held = 0;
    this.elapsed = 0;
    this.started = false;
    const step = this.steps[this.index];
    if (!step) {
      this.index = -1;
      this.emit();
      return;
    }
    step.run(this.session);
    this.emit();
  }
}
