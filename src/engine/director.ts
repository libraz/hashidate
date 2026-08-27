/**
 * Director — the only object the outside world talks to.
 *
 * It accepts semantic commands (emotion vector, speech text, gesture name) and
 * resolves them against the avatar profile. Nothing above this line knows a
 * blendshape name or a bone name, which is what makes the avatar swappable.
 *
 * In production this is driven over a local socket by the orchestrator; here
 * the UI calls the same methods directly.
 */

import type * as THREE from 'three';
import type { ExpressionPreset, MouthViseme } from './face';
import {
  Blink,
  buildOverlays,
  buildPresets,
  composeArkit,
  composeNative,
  dominantEmotion,
  Mouth,
  scaleTrack,
  textToVisemes,
} from './face';
import { Body, HOPS, type HopDef, type PointCommand } from './motion';
import {
  holdsUntilReleased,
  type PerformanceDef,
  type PerformanceId,
  performanceDef,
} from './performance';
import { Rig } from './rig';
import { Spring, Tail } from './secondary';
import type {
  AvatarDescriptor,
  EmotionName,
  EmotionVector,
  LabelledId,
  Profile,
  Side,
  VrmEmotionName,
} from './types';

/**
 * What the frame knows and the director does not. Handed straight to the body
 * layer, which is the only thing in here that works in world space.
 */
export interface DirectorContext {
  /** Where the gaze chain is aimed, in world space. */
  headWorldTarget?: THREE.Vector3 | null;
}

const pickOne = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

/**
 * What the autopilot draws from, weighted by repetition rather than by a number:
 * the rows show the weighting, which a table of probabilities does not.
 *
 * Performances rather than moods and gestures picked separately. Choosing the
 * two independently is what produced the tell this replaced — a character whose
 * face and hands were reliably about different things, waving cheerfully while
 * looking thoughtful, because nothing ever related the two choices.
 *
 * Mostly quiet, on purpose. An idle stream is a character standing there being
 * in some mood, punctuated by something; the `mood` rows are that standing, and
 * they outnumber everything else three to one. Poses are in the pool and sulking
 * and startlement are not — a held pose is fine because the next pick releases
 * it, whereas a character who is periodically furious at nothing is not.
 */
// biome-ignore format: the repetition is the weighting, and the rows show it
const AUTO_ACTS: PerformanceId[] = [
  'calm', 'calm', 'calm', 'calm',
  'blank', 'blank', 'blank',
  'wonder', 'wonder',
  'bashful', 'gloomy',
  'agree', 'agree', 'curious', 'curious', 'ponder', 'dunno', 'interested',
  'giggle', 'peace', 'applause',
  'shy', 'catPaw', 'sparkle', 'secret', 'sleepy', 'refresh', 'bouncy', 'plead',
  'polite', 'bored', 'guarded', 'nice', 'love', 'listening',
];

/** What the current state asks the authored-face channel for, and how strongly. */
interface WantedPreset {
  id: string;
  w: number;
}

/**
 * Above this, a drawing counts as replacing the eye rather than reshaping it,
 * and stops being something that can be shown by halves — see `swap` in
 * `face/presets.ts` for what is measured and why a face like that is only ever
 * correct at nothing or all of it. The measurement lands at the ends of the
 * range, so the threshold only has to sit between them.
 */
const SWAPS_THE_EYE = 0.5;

export class Director {
  readonly p: Profile;
  readonly a: AvatarDescriptor;
  readonly rig: Rig;
  readonly body: Body;
  readonly mouth: Mouth;
  readonly spring: Spring;
  readonly tail: Tail;

  emotion: EmotionVector;
  target: EmotionVector;
  emotionRate: number;

  useArkit: boolean;

  readonly presets: ExpressionPreset[];
  readonly presetById: Map<string, ExpressionPreset>;
  useNativePresets: boolean;

  readonly overlays: LabelledId[];
  readonly overlayIds: Set<string>;

  /**
   * The blink state machine. It knows nothing about the profile or the emotion
   * vector; this class decides when the eyes are held open and routes the one
   * number it produces to whatever the avatar calls its blink shapes.
   */
  readonly #blink = new Blink();

  private readonly _emotionPreset: Partial<Record<EmotionName, string>>;
  /** id -> weight, 0..1 */
  private readonly _overlay = new Map<string, number>();

  /** explicit setExpression, outranks everything */
  private _manualPreset: string | null = null;
  /** the autopilot reaching for an unmapped face */
  private _autoPreset: string | null = null;
  /** the one currently faded in */
  private _preset: string | null = null;
  private _presetW = 0;

  private readonly _extraFaces: string[];
  private _faceTimer = 0;
  private _autoTimer = 4;

  /** autopilot: performances, and the avatar's own faces between them */
  private _auto = false;

  /** The performance in flight, and what it will have to put back. */
  private _act: string | null = null;
  private _actOverlays: string[] = [];
  private _lookBefore: number | null = null;

  /** mesh -> Map<index, value> for this frame */
  private _morphs = new Map<THREE.Mesh, Map<number, number>>();
  /** mesh -> Set<index> written last frame */
  private _written = new Map<THREE.Mesh, Set<number>>();

  /**
   * `avatar` defaults to the profile's own descriptor rather than to an empty
   * object: the profile is built from a descriptor, so it always carries one,
   * and a caller that omits it means "the avatar this profile is of".
   */
  constructor(profile: Profile, avatar: AvatarDescriptor = profile.avatar) {
    this.p = profile;
    this.a = avatar;
    this.rig = new Rig(profile);
    this.body = new Body(this.rig, profile);
    this.mouth = new Mouth();
    // Driven by the pose rather than by anything semantic, so it takes no
    // commands — it only has to run last. See the note at the end of `update`.
    this.spring = new Spring(profile, avatar);
    // The exception to that: a tail hangs off the hips and the hips barely
    // move, so it has to be posed rather than merely simulated. It reads the
    // emotion vector directly and writes into the sway layer's rest pose.
    this.tail = new Tail(profile, avatar, this.spring);

    this.emotion = { neutral: 1 };
    this.target = { neutral: 1 };
    this.emotionRate = 3.5;

    this.useArkit = profile.arkit.supported;

    // The avatar's own finished expressions, if it ships any. Discovered from
    // the profile's shape groups — see face/presets.ts for why they cannot
    // simply be composed out of ARKit.
    this.presets = buildPresets(profile, avatar);
    this.presetById = new Map(this.presets.map((x) => [x.id, x]));
    this.useNativePresets = this.presets.length > 0;
    this._emotionPreset = avatar.presets?.emotion ?? {};

    // Drawn effects that layer over a face rather than replacing it. A
    // different channel from the presets above, and an avatar may ship either,
    // both or neither.
    this.overlays = buildOverlays(profile, avatar);
    this.overlayIds = new Set(this.overlays.map((x) => x.id));

    // Authored faces that no canonical emotion maps to. They are the bulk of
    // the set and the semantic API cannot ask for them, so the autopilot picks
    // from here directly.
    const mapped = new Set(Object.values(this._emotionPreset));
    this._extraFaces = this.presets.map((x) => x.id).filter((id) => !mapped.has(id));
  }

  /**
   * The idle autopilot.
   *
   * Turning it off releases whatever it was holding. It picks sustained
   * performances — a character who folds their arms for a while is exactly what
   * an idle stream looks like — and those hold until something replaces them,
   * so switching the autopilot off has to be the thing that replaces the last
   * one. Without this a turn that starts while the autopilot happens to be
   * mid-pose delivers its whole line with the arms still folded.
   */
  get auto(): boolean {
    return this._auto;
  }

  set auto(on: boolean) {
    if (on === this._auto) return;
    this._auto = on;
    if (!on) this.releaseAct();
  }

  /** Current blink weight, 0..1. Read by the HUD. */
  get blink(): number {
    return this.#blink.weight;
  }

  /** Automatic blinking. Off holds the lids open; written by the UI. */
  get blinkEnabled(): boolean {
    return this.#blink.enabled;
  }

  set blinkEnabled(on: boolean) {
    this.#blink.enabled = on;
  }

  /**
   * What is on the face right now, or null. This is an observation, not a
   * setting: it also reports faces the emotion vector or the autopilot chose.
   */
  get expression(): string | null {
    return this._presetW > 0.02 ? this._preset : null;
  }

  /**
   * What was explicitly asked for via setExpression, or null. Distinct from
   * `expression` on purpose — toggling a control against what merely happens to
   * be showing means the control cannot clear a face it did not choose.
   */
  get pickedExpression(): string | null {
    return this._manualPreset;
  }

  // --- semantic commands -------------------------------------------------

  /** setEmotion({ joy: 0.8, surprise: 0.2 }) — continuous, blended over time. */
  setEmotion(vec: EmotionVector): void {
    this.target = { ...vec };
  }

  /**
   * Drive one of the avatar's own finished expressions by id, or `null` to hand
   * the face back to the emotion vector. Ids come from `profile.groups`, so
   * callers discover them rather than knowing them.
   */
  setExpression(id: string | null): void {
    this._manualPreset = id && this.presetById.has(id) ? id : null;
    // Clearing a pick is a clear: drop the autopilot's face too, or the caller
    // asks for nothing and the face does not change.
    if (!this._manualPreset) this._autoPreset = null;
  }

  /**
   * Raise or clear a drawn effect. Several can be up at once — tears and a
   * blush are a different face from either alone — so this is per id rather
   * than a single slot like `setExpression`.
   */
  setOverlay(id: string, weight = 1): void {
    if (!this.overlayIds.has(id)) return;
    if (weight > 0.001) this._overlay.set(id, Math.min(1, weight));
    else this._overlay.delete(id);
  }

  /** Everything currently raised, as `{ id: weight }`. */
  get overlayState(): Record<string, number> {
    return Object.fromEntries(this._overlay);
  }

  /**
   * Back to a resting face. Clears the pick, the autopilot's pick, the effects
   * and the mood — all of them, because "the expression" is one thing to
   * whoever is watching, and clearing part of it leaves a face on screen.
   */
  resetExpression(): void {
    // Including whatever a performance is holding — closed lids and a dropped
    // gaze are part of "the expression" to whoever is watching, and a reset
    // that leaves the eyes shut is not one.
    this.releaseAct();
    this._manualPreset = null;
    this._autoPreset = null;
    this._overlay.clear();
    this.setEmotion({ neutral: 1 });
    // Hold off the autopilot briefly, or it repoints on the very next frame and
    // the reset never becomes visible.
    this._faceTimer = 3 + Math.random() * 3;
  }

  /**
   * Start the mouth on a line. `reading` is the kana pronunciation and wins
   * when given — the viseme track is built from sound, not from spelling, and
   * only the caller knows how "3件" is meant to be said.
   *
   * `seconds` is how long the line *actually* lasts, when that is known because
   * it has already been synthesised. Given, it replaces the estimate rather
   * than correcting it: the track keeps the shape the text implies and is
   * stretched onto the real length, which is what makes the mouth stop when the
   * voice does instead of a quarter-second early on every turn.
   */
  speak(text: string, reading?: string, seconds?: number): number {
    const track = textToVisemes(reading ?? text);
    return this.mouth.schedule(seconds === undefined ? track : scaleTrack(track, seconds));
  }

  gesture(id: string): void {
    this.body.play(id);
  }

  /**
   * A run of hops. Distinct from a gesture — it moves the whole skeleton rather
   * than posing it, and runs alongside whatever the arms are doing.
   *
   * No id is the plain single hop; an id the table does not have is ignored,
   * rather than falling back to that hop. The two are different requests, and a
   * caller naming a pattern that no longer exists wants to see nothing happen.
   */
  hop(id?: string): void {
    if (id === undefined) {
      this.body.hop();
      return;
    }
    if (!Object.hasOwn(HOPS, id)) return;
    this.body.hop((HOPS as Record<string, HopDef>)[id]);
  }

  /**
   * Play a named performance: a face and a movement together. `null` releases
   * the current one.
   *
   * This is the API an orchestrator is meant to use, and the one the autopilot
   * uses. The pieces underneath it stay reachable — an orchestrator that wants
   * an emotion this table has no name for still sets the vector directly — but
   * everything a character routinely does has a name here.
   */
  perform(id: string | null): void {
    this.releaseAct();
    if (!id) return;
    const def = performanceDef(id);
    if (!def) return;
    this._act = id;

    this.setEmotion(def.emotion);
    // An explicit pick is what the caller asked for and outranks a mood, so a
    // performance has to clear one or the face it names never appears.
    this._manualPreset = null;
    this._autoPreset = null;

    for (const overlay of def.overlay ?? []) {
      if (!this.overlayIds.has(overlay)) continue;
      this.setOverlay(overlay, 1);
      this._actOverlays.push(overlay);
    }
    if (def.droop !== undefined) this.#blink.droop = def.droop;
    if (def.look !== undefined) {
      this._lookBefore = this.body.lookAt;
      this.body.lookAt = def.look;
    }
    if (def.gesture) this.body.play(def.gesture);
    if (def.hop) this.hop(def.hop);
  }

  /** Which performance is up, or null. Cleared as soon as one is released. */
  get performance(): string | null {
    return this._act;
  }

  /**
   * Put back what the current performance changed, leaving the mood.
   *
   * Only the things it explicitly took: a gesture that ends on its own is left
   * alone rather than cut short, because releasing a performance is not a stop
   * button — `interrupt` is. What is undone here is the state a performance
   * would otherwise leave behind forever.
   */
  private releaseAct(): void {
    if (!this._act) return;
    const def: PerformanceDef | null = performanceDef(this._act);
    this._act = null;
    for (const overlay of this._actOverlays) this.setOverlay(overlay, 0);
    this._actOverlays = [];
    if (!def) return;
    if (def.droop !== undefined) this.#blink.droop = 0;
    if (this._lookBefore !== null) {
      this.body.lookAt = this._lookBefore;
      this._lookBefore = null;
    }
    if (holdsUntilReleased(def) && def.gesture && this.body.gesture?.id === def.gesture) {
      this.body.stopGesture();
    }
  }

  /**
   * Aim a fingertip at a bearing and hold it. See `Body.point` for the
   * coordinate; the arm is back-solved from it, so nothing above this line
   * names a joint.
   *
   * The bearing arrives in degrees and stays in degrees down to the body layer,
   * which converts — this boundary is the control API's, not the solver's.
   */
  point(side: Side, spec: PointCommand): void {
    this.body.point(side === 'L' ? 'L' : 'R', spec);
  }

  lookAt(amount: number): void {
    this.body.lookAt = amount;
  }

  /** Ask for a blink. Dropped if one is in flight or the gap has not elapsed. */
  triggerBlink(): void {
    this.#blink.trigger();
  }

  // --- per-frame ---------------------------------------------------------

  update(dt: number, ctx?: DirectorContext): void {
    // Emotion vector eases toward the target so switches are not instant.
    const k = 1 - Math.exp(-dt * this.emotionRate);
    const keys = new Set<EmotionName>([
      ...(Object.keys(this.emotion) as EmotionName[]),
      ...(Object.keys(this.target) as EmotionName[]),
    ]);
    for (const key of keys) {
      const cur = this.emotion[key] ?? 0;
      const to = this.target[key] ?? 0;
      const next = cur + (to - cur) * k;
      if (next < 0.001 && to === 0) delete this.emotion[key];
      else this.emotion[key] = next;
    }

    this.mouth.update(dt);
    this.updatePreset(dt);

    // The body breathes around the speech: it takes a breath before a line and
    // stretches the exhale through it. Head motion follows the envelope rather
    // than individual morae — driving it off per-mora openness makes the head
    // stutter with the syllables.
    this.body.speaking = this.mouth.speaking;
    this.body.speechEnergy = this.mouth.busy * (0.6 + 0.4 * this.mouth.openness);

    this.autopilot(dt);

    this.rig.reset();
    this.body.update(dt, ctx);

    // Blinks cluster around gaze shifts in life, so let a large saccade pull
    // the next blink forward instead of leaving the two independent.
    if (this.body.saccade > 0.2 && Math.random() < 0.6) this.triggerBlink();

    this.writeFace(dt);

    // Poses the base of the tail for this frame. It writes a rest pose rather
    // than a bone, so it belongs before the simulation reads one.
    this.tail.update(dt, this.emotion, this.body.speechEnergy);

    // Last, and it has to be last. Hair and cloth are driven by where the body
    // ended up this frame, so anything that moves a bone after this point is a
    // frame the secondary motion never saw — which does not read as lag, it
    // reads as hair that is attached to the head one frame ago.
    this.spring.update(dt);
  }

  // --- autopilot ---------------------------------------------------------
  //
  // Stands in for the orchestrator. In production the LLM decides what the
  // character feels and does; this picks plausible values on a timer so the
  // idle can be watched for minutes at a stretch. Several of the problems in
  // this layer — a face that never resets, motion that locks into a rhythm —
  // only show up when it is left running.

  private autopilot(dt: number): void {
    if (!this._auto) return;
    this.autoAct(dt);
    this.autoFace(dt);
  }

  /**
   * One channel, one pick.
   *
   * Face and body used to be chosen on two independent timers, which is what
   * made the idle read as two unrelated animations sharing a body. A
   * performance decides both at once, so whatever the character does, they are
   * plausibly feeling it.
   */
  private autoAct(dt: number): void {
    this._autoTimer -= dt;
    if (this._autoTimer > 0) return;
    // Nothing is cut short: a pick waits for a running gesture to finish rather
    // than crossfading out of it.
    //
    // Only for one that *will* finish, though. A sustained pose ends when
    // something releases it and never otherwise, so waiting on one is waiting
    // for good — and this is the thing that would eventually have released it.
    // Asking the running gesture rather than asking whether the *performance*
    // holds is what makes that true whoever started it: an operator pressing a
    // pose on the panel, or a `gesture` command off the wire, leaves a held
    // pose behind that no performance owns, and the autopilot has to be able to
    // move on from that too.
    const running = this.body.gesture;
    if (running && !running.def.sustain && !running.released) {
      this._autoTimer = 1.2;
      return;
    }
    this.perform(pickOne(AUTO_ACTS));
    // Long enough that a pose is a pose rather than a flicker, uneven enough
    // that the rotation does not become a beat the viewer can count along with.
    this._autoTimer = 5.5 + Math.random() * 7;
  }

  /**
   * The avatar's own extra vocabulary: authored faces that no canonical emotion
   * maps to, so a performance cannot reach them and nothing else will.
   *
   * A second channel and a slower one. It only ever puts a face on top of
   * whatever the body is already doing, which is why it can run beside the
   * performance channel without the two disagreeing.
   */
  private autoFace(dt: number): void {
    // An explicit pick outranks the autopilot and holds until it is cleared.
    if (this._manualPreset || !this._extraFaces.length) return;
    this._faceTimer -= dt;
    if (this._faceTimer > 0) return;
    if (Math.random() < 0.45) {
      this._autoPreset = pickOne(this._extraFaces);
      this._faceTimer = 3.5 + Math.random() * 3;
    } else {
      this._autoPreset = null;
      this._faceTimer = 7 + Math.random() * 8;
    }
  }

  // --- native expression presets -----------------------------------------

  /** Whether this drawing replaces the eye, and so cannot be shown in part. */
  private swapsTheEye(id: string | null): boolean {
    return !!id && (this.presetById.get(id)?.swap ?? 0) > SWAPS_THE_EYE;
  }

  /** Which authored face the current state asks for, and how strongly. */
  private wantedPreset(): WantedPreset | null {
    if (this._manualPreset) return { id: this._manualPreset, w: 1 };
    if (this._autoPreset) return { id: this._autoPreset, w: 1 };
    if (!this.useNativePresets) return null;
    // The emotion vector blends, an authored face does not, so only the
    // dominant emotion can claim one — and only once it is clearly dominant.
    const name = dominantEmotion(this.emotion);
    const w = this.emotion[name] ?? 0;
    const id = this._emotionPreset[name];
    if (!(id && w > 0.35 && this.presetById.has(id))) return null;
    // How strongly an emotion is felt decides whether a drawing that replaces
    // the eye fires, never how much of it is drawn. Asking for four tenths of
    // one leaves the default iris four tenths of the way out of its opening,
    // which is a broken eyeball rather than a milder feeling.
    return { id, w: this.swapsTheEye(id) ? 1 : w };
  }

  private updatePreset(dt: number): void {
    const want = this.wantedPreset();
    const k = 1 - Math.exp(-dt * 6);

    // Two authored faces cannot be crossfaded. They are finished drawings over
    // the same vertices, and adding one to the other lands somewhere neither of
    // them is — a mouth halfway between a grin and a pout is just a smear. So
    // the outgoing one fades out on its own first, and only then does the
    // incoming one take the slot.
    if (this._preset && want?.id !== this._preset) {
      // A drawing that swaps the eye cannot fade either, for the same reason it
      // cannot be held at a fraction: every frame of the fade is a fraction. It
      // leaves in one frame, which is how a drawn face changes anyway.
      if (this.swapsTheEye(this._preset)) {
        this._presetW = 0;
        this._preset = null;
        return;
      }
      this._presetW -= this._presetW * k;
      if (this._presetW < 0.02) {
        this._presetW = 0;
        this._preset = null;
      }
      return;
    }
    if (!this._preset) {
      if (!want) {
        this._presetW = 0;
        return;
      }
      this._preset = want.id;
    }
    if (this.swapsTheEye(this._preset)) {
      this._presetW = want?.w ?? 0;
      return;
    }
    this._presetW += ((want?.w ?? 0) - this._presetW) * k;
  }

  // --- morph writing -----------------------------------------------------

  /**
   * Route a canonical shape name to every (mesh, index) that carries it.
   * A name can live on more than one mesh, so the profile hands back a list.
   */
  private set(name: string | null | undefined, v: number): void {
    if (!name) return;
    const targets = this.p.morphTargets.get(name);
    if (!targets) return;
    const val = Math.min(1, v);
    for (const { mesh, index } of targets) {
      let m = this._morphs.get(mesh);
      if (!m) {
        m = new Map();
        this._morphs.set(mesh, m);
      }
      m.set(index, Math.max(m.get(index) ?? 0, val));
    }
  }

  private writeFace(dt: number): void {
    const { p, mouth } = this;
    this._morphs.clear();

    // An authored face goes down first and the composed one yields to it in
    // proportion. Layering muscle weights on top of a finished drawing does not
    // add expression, it muddies the drawing — the artist already placed the
    // brows, the lids and the mouth.
    const preset = this._preset ? this.presetById.get(this._preset) : null;
    const pw = preset ? this._presetW : 0;
    if (preset) this.set(preset.id, pw);
    const composed = 1 - pw;

    // Expression, in order of preference: the portable ARKit composition, the
    // avatar's own composition table, then a single VRM preset.
    //
    // The first two are the same operation and blend the same way; only the
    // vocabulary differs. The third is a genuine downgrade — one whole-face
    // preset at a time, because those are sculpts that fight over the same
    // vertices — and it is what an avatar gets when nobody has written a
    // profile for it yet.
    if (this.useArkit && p.arkit.supported) {
      const arkit = composeArkit(this.emotion, { mouthBusy: mouth.busy });
      for (const [shape, v] of Object.entries(arkit)) this.set(shape, v * composed);
    } else if (this.a.emotionShapes && composed > 0.02) {
      const native = composeNative(this.emotion, this.a.emotionShapes, {
        mouthBusy: mouth.busy,
        mouthShapes: this.a.mouthShapePattern ?? null,
      });
      for (const [shape, v] of Object.entries(native)) this.set(shape, v * composed);
    } else if (composed > 0.02) {
      // One preset at a time. Named presets are whole-face sculpts that fight
      // over the same vertices, so layering "joy 0.55 + relaxed 0.45" distorts
      // the face instead of blending it — which is the reason ARKit is the
      // primary channel. The fallback keeps the dominant one and drops the rest.
      const name = dominantEmotion(this.emotion);
      // `thinking` and `shy` have no VRM preset of their own; the lookup misses
      // and `set` drops it, which is the whole of what this channel can do.
      this.set(
        p.vrmEmotion[name as VrmEmotionName],
        Math.min(1, this.emotion[name] ?? 1) * composed,
      );
    }

    // Drawn effects go on top and are not scaled by `composed`: an overlay is
    // meant to sit over whatever face is showing, and a heart pupil that fades
    // out as the smile underneath it grows is not the effect the author drew.
    for (const [id, w] of this._overlay) this.set(id, w);

    // Mouth: explicit viseme shapes take priority over composed ones.
    for (const [v, w] of Object.entries(mouth.weights) as Array<[MouthViseme, number]>) {
      if (w < 0.005) continue;
      const shape = p.viseme[v];
      if (shape) this.set(shape, w);
    }
    // The authored visemes already move the jaw; this only adds a little
    // weight underneath them. Too much and the mouth hangs open.
    if (this.useArkit && mouth.openness > 0.01) {
      this.set('jawOpen', mouth.openness * 0.16);
    }

    // Blink last so nothing can hold the eyes open — except an authored face
    // that has already lowered the lids. The preset and the blink are separate
    // morphs that sum on the vertex, so the blink only has to supply the travel
    // the preset has not already used: a face drawn shut gets nothing, one drawn
    // at a squint gets the remainder, and a wink blinks on the open side alone.
    // All of it falls out of the measured closure, with no per-preset flags.
    this.#blink.update(dt, {
      speaking: this.mouth.speaking,
      // Surprise holds the eyes open; blinking through it looks wrong.
      suppressed: (this.emotion.surprise ?? 0) > 0.4,
    });
    const blink = this.#blink.weight;
    if (blink > 0.001) {
      const lid = preset ? preset.lid : null;
      const room = (v: number): number => (lid ? Math.max(0, 1 - v * pw) : 1);
      if (p.blink.L) {
        this.set(p.blink.L, blink * room(lid?.L ?? 0));
        this.set(p.blink.R, blink * room(lid?.R ?? 0));
      } else {
        this.set(p.blink.both, blink * room(Math.max(lid?.L ?? 0, lid?.R ?? 0)));
      }
    }

    // Clear exactly what was written last frame and nothing else. Wiping a
    // whole influence array would also erase the wardrobe's outfit-hide shapes,
    // which live on the same meshes but are owned by another layer.
    for (const [mesh, indices] of this._written) {
      const infl = mesh.morphTargetInfluences;
      if (!infl) continue;
      for (const i of indices) infl[i] = 0;
    }
    const written = new Map<THREE.Mesh, Set<number>>();
    for (const [mesh, values] of this._morphs) {
      const infl = mesh.morphTargetInfluences;
      if (!infl) continue;
      const indices = new Set<number>();
      for (const [i, v] of values) {
        infl[i] = v;
        indices.add(i);
      }
      written.set(mesh, indices);
    }
    this._written = written;
  }
}
