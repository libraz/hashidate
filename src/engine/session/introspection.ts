import type { Director } from '../director';
import { EMOTION_LABELS, EMOTIONS } from '../face';
import { gestureEntries, HOP_IDS, HOPS } from '../motion';
import { holdsUntilReleased, PERFORMANCE_IDS, PERFORMANCE_TABLE } from '../performance';
import type { Wardrobe } from '../scene';
import type {
  EmotionName,
  EmotionVector,
  Scenery,
  SessionState,
  Turn,
  Vocabulary,
  Voice,
} from '../types';

/**
 * What the session can be asked *about*, rather than asked to do.
 *
 * Two readouts and nothing else: what this avatar can be asked for, and what it
 * is doing right now. Both are assembled fresh on every call and neither is
 * cached — the whole point of reporting rather than remembering is that an
 * avatar can be swapped underneath a panel that is still open.
 */

/** Everything the vocabulary needs that is not on the director. */
interface VocabularyContext {
  wardrobe: Wardrobe | null;
  voice: Voice | null;
  scenery: Scenery | null;
}

/**
 * What this avatar can be asked to do.
 *
 * Discovered, not declared: the expression list comes from the avatar's own
 * shape groups and the wardrobe from its meshes, so swapping the avatar
 * changes what the orchestrator is offered. This is the object to paste into
 * an LLM's system prompt.
 */
export function describe(d: Director, { wardrobe, voice, scenery }: VocabularyContext): Vocabulary {
  return {
    // Which avatar this vocabulary describes. Everything below it is that
    // avatar's, and an orchestrator holding a cached copy needs to be able to
    // tell that the thing on screen changed under it.
    avatar: { id: d.a.id ?? null, label: d.a.label ?? null },
    emotions: (Object.keys(EMOTIONS) as EmotionName[]).map((id) => ({
      id,
      label: EMOTION_LABELS[id] ?? id,
    })),
    expressions: d.presets.map((p) => ({ id: p.id, label: p.label })),
    overlays: d.overlays.map((o) => ({ id: o.id, label: o.label })),
    // First among the body entries, because it is the one an orchestrator
    // should be reaching for: a performance names a face and a movement
    // together, and the two lists after it are its parts.
    performances: PERFORMANCE_IDS.map((id) => {
      const def = PERFORMANCE_TABLE[id];
      return {
        id,
        label: def.label,
        group: def.group,
        emotion: { ...def.emotion },
        gesture: def.gesture ?? null,
        hop: def.hop ?? null,
        sustain: holdsUntilReleased(def),
      };
    }),
    // Built-in and loaded together, and not marked apart. What an
    // orchestrator does with the list is send one of the ids back, and where
    // a gesture was defined does not change that — the distinction belongs to
    // whoever put the file in the directory.
    gestures: gestureEntries().map(([id, g]) => ({
      id,
      label: g.label,
      group: g.group,
      sustain: !!g.sustain,
    })),
    hops: HOP_IDS.map((id) => ({ id, label: HOPS[id].label })),
    cue: {
      syntax:
        '[performanceId] or [@perform id], [@expression id], [@gesture id], [@hop id], [@camera frame], [@slide N], [@bgm play] or [@bgm play track.mp3], [@bgm pause], [@bgm stop]',
      note: {
        en: "Write a cue straight into say's text. It fires at the point written, and nothing inside square brackets is spoken. The legacy [performanceId] shorthand starts a performance; typed cues can change a performance, expression, gesture, hop, camera frame, slide, or BGM transport. A BGM track is an .mp3 or .flac filename and may contain spaces.",
        ja: 'say の text にキューを直接書く。書いた位置で実行し、角括弧の中身は読み上げない。従来の [performanceId] は演技を開始し、[@...] 形式では演技、表情、ジェスチャ、ジャンプ、カメラ、スライド、BGM の再生・一時停止・停止を切り替えられる。BGM の曲名は .mp3 / .flac のファイル名で、空白も使える。',
      },
    },
    cameras: ['bust', 'upper', 'face', 'full'],
    // Continuous, so it is stated as ranges rather than as a list of ids.
    // The bounds are the anatomical ones: past them the arm still goes as far
    // as it can, but the pose is a strained one and reads that way.
    pointing: {
      side: ['L', 'R'],
      azimuth: [-120, 120],
      elevation: [-70, 110],
      extent: [0.1, 1],
      finger: ['thumb', 'index', 'middle', 'ring', 'little'],
      note: {
        en: "azimuth 0 is straight ahead, positive toward the character's own right. elevation 0 is shoulder height. extent is a fraction of the arm's full reach.",
        ja: 'azimuth 0 = 正面、+ がキャラクターから見て右。elevation 0 = 肩の高さ。extent は腕の全長に対する割合',
      },
    },
    // Read off the loaded wardrobe rather than a module-level table: the slot
    // names themselves are avatar data, so an orchestrator that cached this
    // for one avatar holds nothing that applies to the next.
    wardrobe: Object.fromEntries(
      Object.entries(wardrobe?.slots ?? {}).map(([slot, def]) => [
        slot,
        { label: def.label, items: def.items.map((i) => ({ id: i.id, label: i.label })) },
      ]),
    ),
    wardrobePresets: Object.entries(wardrobe?.presetDefs ?? {}).map(([id, p]) => ({
      id,
      label: p.label,
    })),
    rooms: voice?.rooms ?? [],
    backdrops: scenery?.backdrops ?? [],
    voicePresets: voice?.presets ?? [],
  };
}

/** Everything the state readout needs that is not on the director. */
interface StateContext {
  turn: Turn | null;
  queued: number;
  busy: boolean;
  idleEnabled: boolean;
  wardrobe: Wardrobe | null;
}

/** Everything an orchestrator might branch on, cheap enough to poll. */
export function snapshot(
  d: Director,
  { turn, queued, busy, idleEnabled, wardrobe }: StateContext,
): SessionState {
  return {
    speaking: d.mouth.speaking,
    turn: turn?.id ?? null,
    queued,
    busy,
    idle: d.auto,
    idleEnabled,
    emotion: Object.fromEntries(
      (Object.entries(d.effectiveTarget) as Array<[EmotionName, number]>)
        .filter(([, v]) => v > 0.01)
        .map(([k, v]) => [k, +v.toFixed(2)]),
    ) as EmotionVector,
    expression: d.expression,
    pickedExpression: d.pickedExpression,
    overlays: d.overlayState,
    performance: d.performance,
    gesture: d.body.gesture?.id ?? null,
    hopping: d.body.jumping,
    // Joint strain from the last fingertip solve, per arm. 0 is a pose that
    // sits entirely inside comfortable range; above about 1 the arm is
    // reaching for something it cannot comfortably get to, which is the only
    // way a caller can tell that without looking at the render.
    strain: { L: +d.body.pointStrain.L.toFixed(2), R: +d.body.pointStrain.R.toFixed(2) },
    lookAt: d.body.lookAt,
    wardrobe: wardrobe ? { ...wardrobe.state } : null,
  };
}
