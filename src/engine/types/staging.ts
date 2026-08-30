import type { CameraFrame } from './primitives';

/**
 * Where a line is delivered and how the output frame is laid out.
 *
 * Two separate questions that a turn asks at the same moment: where the camera
 * stands in the world the character is in, and where the resulting picture is
 * put in the frame that goes to air. See `Placement` for why joining them
 * would be wrong.
 */

/**
 * Where a line is delivered: the framing, the set and the acoustic.
 *
 * The three staging axes `Session` already exposes as their own calls, gathered
 * so a turn can carry them. They behave here exactly as they do there — each is
 * a pass-through to whatever the renderer supplied, each persists after the
 * turn, and an axis left out is an axis left alone. `null` is not "left out":
 * it is the empty value that axis has, dry for a room and flat for a backdrop.
 */
export interface Staging {
  camera?: CameraFrame;
  backdrop?: string | null;
  room?: string | null;
  /**
   * Which document is up. Usually set once at the top of a segment rather than
   * per line, but it is here for the run that moves between two of them.
   */
  deck?: string | null;
  /**
   * Which page of it, 1 based. **Absolute, and there is deliberately no
   * relative form here.** A queued line may be dropped, reordered or sent round
   * again, and a "next page" written into one of those means a different page
   * every time the script is touched — the whole deck slips by one and nothing
   * says why. An operator turning a page live is reacting and says `by`; a
   * script describing a line it has not reached yet knows the number.
   *
   * No null, unlike the two axes above: a page has no empty value. Taking the
   * document away is `deck: null`.
   */
  slide?: number;
  /**
   * Where the two layers sit in the broadcast frame, as `place` states it.
   *
   * Here because a document and a layout are one decision made at one moment: a
   * deck that fills the frame wants the character small in a corner, and the
   * line that puts the deck up is the line that wants her moved. Sent as a
   * separate command it lands at some other time, and the frame is briefly
   * wrong in the most visible way there is — two things on top of each other.
   *
   * A partial merge, like the command it mirrors, and persistent like every
   * other axis on this interface: absent means "leave it", never "reset it", so
   * the line that takes the deck down is the line that says where she stands
   * without one.
   */
  place?: { avatar?: Placement; slide?: SlidePlacement };
}

/**
 * Where the camera stands: a named framing, and how far it has been moved off it.
 *
 * ## Why the framing is not enough on its own
 *
 * The four framings answer "how much of the character is in shot" and are the
 * right unit for a script: a line is delivered in a bust shot, and what that
 * means in metres is the renderer's problem and differs per avatar. What they
 * cannot say is "from slightly to the left, a little closer" — which is most of
 * what an operator does to a shot while watching it, and all of what a drag on
 * a preview produces.
 *
 * ## Relative, so it survives a swap
 *
 * The offsets are stated against the framing rather than in world space. An
 * absolute camera position measured on one avatar puts the next one's head out
 * of frame, because the two differ in height and in where the bones sit; a
 * quarter-turn and a 1.3× dolly mean the same thing on both.
 *
 * Every field is optional and an absent one is left where it was, so a drag
 * sends two numbers and a framing change sends one.
 */
export interface Shot {
  frame?: CameraFrame;
  /** Degrees around the framing's target. 0 is straight on, positive to the right. */
  yaw?: number;
  /** Degrees above it. 0 is level with the framing, positive looking down. */
  pitch?: number;
  /** Multiplier on the framing's distance. 1 is the framing, higher is closer. */
  zoom?: number;
}

/**
 * How far a shot may travel, in the same units `Shot` states.
 *
 * Read by the wire schema, which refuses a value outside them, and by the
 * renderer, which stops the pointer at them. Both, and from one place: a drag
 * that could push the camera past what the schema accepts would produce a
 * command that is silently dropped, and the picture being dragged would be the
 * only one that moved.
 *
 * A guard rather than a taste. At the pole there is no bearing left to speak
 * of, and a zoom outside these puts the camera inside the character's head or
 * far enough away that there is nothing to see.
 */
export const SHOT_LIMITS = {
  yaw: { min: -180, max: 180 },
  pitch: { min: -85, max: 85 },
  zoom: { min: 0.25, max: 4 },
} as const;

/** Where in the output frame a layer sits. Nine positions, as a grid. */
export type Anchor =
  | 'center'
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right';

/**
 * A rectangle of the output frame, as a layer occupies it.
 *
 * ## Not the same question as `Shot`, and joining them would be wrong
 *
 * A shot is where the camera stands: a bearing and a distance in the world the
 * character is in. This is where the resulting *picture* is put in the frame
 * that goes to air. Both change how big the character looks and that is the
 * whole of what they have in common — a document behind the character has a
 * placement and no shot at all, and moving the camera to make room for one
 * would mean re-framing every line of a segment.
 *
 * ## Two fractions rather than a size and an aspect
 *
 * `width` and `height` are independent fractions of the stage. Stating it as
 * one size plus an aspect reads better and has a hole in it: at full size there
 * is no aspect to apply — the layer is the frame — so the aspect would have to
 * be ignored at exactly one value and honoured everywhere else, and a slider
 * dragged down from 1 would jump the moment it left the top. A surface that
 * wants one knob moves both from one, which is a surface's business.
 *
 * ## The rectangle is an area, and it does not decide the shot
 *
 * A framing is stated as a world-space top and bottom edge, so pointing it at a
 * rectangle of some other shape has to give something up — and both obvious
 * answers are wrong. Filling the rectangle keeps the vertical and cuts the arms
 * off both sides, which is where a raised hand and most of the hair are.
 * Standing the camera back until the width fits crops nothing and grows the
 * vertical by the same factor, so an upper-body shot quietly becomes a
 * full-body one.
 *
 * So the renderer draws the *frame's own shape*, scaled to fit inside whatever
 * area this names: the picture the whole frame would have shown, smaller and
 * off to one side. Nothing is cropped, nothing is reframed, and a framing goes
 * on meaning exactly what it says. What the area does not cover is left
 * transparent, so what shows through it is the document.
 *
 * What lands on the anchor is the **character**, not that picture. A framing is
 * a wide picture with a narrow figure in the middle of it, so putting the
 * picture's edge on the frame's edge leaves the character a quarter of a frame
 * short of it, in front of a large piece of nothing. The empty side is pushed
 * out past the edge instead and clipped there, which is what an overlay hanging
 * off the side of a shot looks like anyway.
 *
 * A consequence worth knowing: only the tighter of the two fractions decides
 * anything for the character, and at `1` there is nowhere for an anchor to move
 * to. The document is the layer the pair is really for — see `fit`.
 */
export interface Placement {
  anchor?: Anchor;
  /** Fraction of the stage width. 1 is the full frame. */
  width?: number;
  /** Fraction of the stage height. */
  height?: number;
  /**
   * Gap from the edges the anchor pulls the layer to, as a fraction of the
   * stage **height** on both axes — a margin measured per axis on a 16:9 frame
   * puts a wider gap at the side than at the bottom for the same number, and
   * the two are read as one inset by everyone who looks at them.
   *
   * Nothing for a centred layer, which touches no edge.
   */
  margin?: number;
}

/** A `Placement` with the one extra question a picture asks: how it fills it. */
export interface SlidePlacement extends Placement {
  /** `contain` shows the whole page and letterboxes; `cover` fills and crops. */
  fit?: 'contain' | 'cover';
}

/**
 * How far a placement may go, in the same units it states.
 *
 * Read by the wire schema and by whatever draws it, from one place, for the
 * reason `SHOT_LIMITS` is. The floor is a guard rather than a taste: below a
 * tenth of the frame the character is a smudge and the layer is more likely to
 * be a typo in a query string than an instruction.
 */
export const PLACEMENT_LIMITS = {
  width: { min: 0.1, max: 1 },
  height: { min: 0.1, max: 1 },
  margin: { min: 0, max: 0.2 },
} as const;

/**
 * What the document layer is doing, so a control surface can draw it.
 *
 * Reported for the reason `VoiceReport` is: the answer is only known where the
 * work happens. How many pages a document has is discovered by opening it, and
 * a panel that counted on the number it was told would be showing `4 / 0` until
 * somebody turned a page.
 */
export interface SlideReport {
  /** What was asked for, null when nothing is up. */
  deck: string | null;
  /** The page showing, 1 based. 0 when there is no document. */
  page: number;
  /** How many it has. 0 until it is open. */
  pages: number;
  /** Whether the page showing is the page asked for. False while one is drawn. */
  ready: boolean;
  /** Why a document is not up, for the operator. Null when nothing is wrong. */
  error: string | null;
}

/**
 * How the frame is laid out right now, so a control surface can draw it.
 *
 * Reported for the reason `VoiceReport` and `SlideReport` are: a panel that
 * draws its sliders from what it last sent is wrong from the moment it opens,
 * because a source opened on `?place=bottom-right:0.32x0.6` was never told to
 * be there by anything the panel saw — and it is wrong again after every
 * `place` an orchestrator sends.
 *
 * Both halves are **resolved**, never partial. What is in force is the whole
 * question here; a partial answer would be the last patch somebody sent, which
 * is exactly what the surface asking cannot rely on.
 */
export interface PlacementReport {
  avatar: Required<Placement>;
  slide: Required<SlidePlacement>;
}
