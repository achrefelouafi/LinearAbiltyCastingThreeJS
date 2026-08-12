import {
  BufferAttribute,
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Sphere,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { getColor } from '../utils/color.js';

/* ====================================================================== */
/*  BrushStroke — a loaded brush, not a ribbon with a noise mask           */
/* ====================================================================== */

/**
 * How the bristles are packed into the ferrule.
 *
 * This is the *only* thing that decides where the dry-brush streaks appear,
 * because a streak is one bristle running out of ink and the bristles are laid
 * out once, here. It is a construction option rather than a slider because it
 * re-lays the per-instance dice; `retip()` exists for an editor dropdown.
 */
export const BrushTip = Object.freeze({
  /** A hake / flat brush: bristles in one rank across the width. Sumi default. */
  FLAT: 0,
  /** A round brush: bristles on a golden-angle disc, so streaks split in depth too. */
  ROUND: 1,
  /** A worn brush whose bristles have clumped into three tufts, with gaps between. */
  SPLIT: 2
});

/** Names in enum order, for an editor dropdown. */
export const BRUSH_TIP_NAMES = ['FLAT', 'ROUND', 'SPLIT'];

/* ---------------------------------------------------------------------- */
/* Shared GLSL                                                             */
/* ---------------------------------------------------------------------- */

/**
 * One-dimensional value noise on a hashed lattice, plus the contrast curve
 * that stops it piling up in the middle.
 *
 * Value noise concentrates hard around 0.5 (README trap 4). That is fatal for
 * the dry-brush contact test, which compares this against a dryness in 0..1: if
 * almost every sample sits near 0.5 then every bristle on the brush loses
 * contact within a few millimetres of the same place, and the stroke ends with
 * a clean horizontal cut instead of a fray. `uSkipContrast` pushes the
 * distribution back out toward the ends; 1.8 is enough that the bristles let go
 * across a hand's width of stroke rather than all at once.
 */
const BRUSH_NOISE = /* glsl */ `
  float vnoise1(float x) {
    float i = floor(x);
    float f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(hash11(i), hash11(i + 1.0), f);
  }
`;

/**
 * The stroke lives entirely in this vertex shader.
 *
 * An instance is one **bristle of one stroke**. Its spine is a cubic Bézier
 * handed over as four world-space control points, its width comes from a
 * four-point pressure curve, and how much ink it still holds comes from
 * integrating what it has already laid down. Nothing about the stroke exists on
 * the CPU between frames except the numbers the ability wrote this frame — so
 * every metre in here re-resolves on a zero-length frame (I1).
 *
 * ## Why the bristles are instances
 *
 * The first version drew one even ribbon and multiplied its alpha by a noise
 * field to fake the dry tail. It is the obvious thing and it is wrong in a way
 * you can see from across the room: a mask makes *holes in a stroke*, and dry
 * brush is not a stroke with holes in it — it is four or five separate marks
 * that used to be one mark, each ending at its own place, each with its own
 * width, with clean paper between them. The mask version also breaks up
 * uniformly along the width, because the noise does not know where the middle
 * of the brush is, whereas a real brush keeps ink in the core long after the
 * outside bristles have given up.
 *
 * Modelling the bristles gets all of that for free and costs one instanced draw:
 *
 *  - each bristle carries its own **ink load**, jittered per bristle and
 *    starved toward the edge of the ferrule (`uEdgeStarve`), so the stroke goes
 *    dry from the outside in;
 *  - ink is **spent** by integrating the deposition along the spine, so a
 *    stroke that presses hard runs out sooner than one that skims — the tail is
 *    a consequence of the pressure curve rather than a separate slider;
 *  - past the point where a bristle's load runs low it makes **intermittent
 *    contact** with the paper, gated per bristle by `vnoise1` along its own
 *    arclength. That is the fray.
 *
 * ## Why it is a prism and not a billboard
 *
 * The cross-section is an ellipse of half-width `bw` (the bristle's ink width)
 * and half-depth `uDepth` (metres, through the paper normal), swept along the
 * spine. Sealscript hangs a column of characters in the air and the camera
 * orbits it; a billboard turned edge-on is thinner than a pixel and the whole
 * column blinks out of existence. A prism seen edge-on is a solid bar of ink
 * `2 * uDepth` wide, and the writing stays writing. Face-on the depth is
 * invisible and it reads flat, which is what sumi wants — the same geometry
 * serves both because the ellipse is degenerate in exactly one axis.
 *
 * ## The ink integral
 *
 * `inkSpent(t)` is a 13-point trapezoid over the deposition. The analytic
 * alternative — integrating only the pressure cubic, which has a closed form —
 * was tried first and is wrong: it ignores the brush's *speed*, so a stroke
 * with a hairpin in it (control points bunched, brush dwelling) spends no extra
 * ink at the hairpin and never runs dry early. The dwell is the whole reason a
 * hook pools and the tail after the hook is bone dry.
 */
const BRUSH_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586
  #define INK_QUAD 12

  /* --- the paper --- */
  uniform vec3  uPaper;         // unit normal of the plane the stroke is written in

  /* --- the brush --- */
  uniform float uWidth;         // metres, ferrule half-width at pressure 1
  uniform float uDepth;         // metres, half-thickness of one bristle's deposit
  uniform float uFerruleDepth;  // metres the bristles are spread through the paper normal
  uniform float uBristles;      // how many, so one bristle's share of the width is known
  uniform float uBristleWidth;  // >1 overlaps into a solid stroke, <1 separates
  uniform float uSplay;         // fraction the bristles fan out at full pressure
  uniform float uWobble;        // metres of per-bristle lateral wander
  uniform float uFibreScale;    // features per metre of that wander

  /* --- ink --- */
  uniform float uFlowLength;    // pigment laid per metre of travel, at pressure 1
  uniform float uFlowDwell;     // extra pigment laid per metre when the brush dwells
  uniform float uSpeedRef;      // metres per unit t at which the brush is "at speed"
  uniform float uEdgeStarve;    // load multiplier at the edge of the ferrule
  uniform float uLoadJitter;    // +/- fraction of load, per bristle
  uniform float uDryBand;       // ink units over which a bristle goes wet -> dry
  uniform float uDryThin;       // width multiplier when a bristle is fully dry
  uniform float uSkipScale;     // features per metre of the contact noise
  uniform float uSkipSoft;      // softness of the contact threshold
  uniform float uSkipContrast;  // pushes the value noise off its central pile

  /* --- pooling --- */
  uniform float uPoolSwell;     // fraction the stroke widens per unit of extra pigment
  uniform float uPoolCurve;     // extra pigment per 1/metre of spine curvature
  uniform float uPigment;       // overall density multiplier

  /* --- the beat --- */
  uniform float uProgress;      // 0..1 across the whole set of strokes
  uniform float uHeadTaper;     // fraction of the drawn length the moving head tapers over
  uniform float uWetLength;     // metres behind the head that still read wet

  attribute vec3 aP0;
  attribute vec3 aP1;
  attribute vec3 aP2;
  attribute vec3 aP3;
  attribute vec4 aPress;        // pressure control points: entry, swell, hold, exit
  attribute vec4 aStroke;       // drawStart, drawSpan, strokeSeed, inkLoad
  attribute vec4 aBrush;        // across -1..1, through -1..1, load dice, bristle seed

  varying float vPigment;
  varying float vAcross;
  varying float vDry;
  varying float vContact;
  varying float vWet;
  varying float vAlong;
  varying float vSeed;
  varying vec3  vNormalW;
  varying float vViewZ;

  ${noiseGLSL}
  ${BRUSH_NOISE}

  vec3 safeNormalize(vec3 v, vec3 fallback) {
    float l2 = dot(v, v);
    return l2 > 1e-10 ? v * inversesqrt(l2) : fallback;
  }

  /* --- the spine ---------------------------------------------------- */

  vec3 bezier(float t) {
    float m = 1.0 - t;
    return m * m * m * aP0 + 3.0 * m * m * t * aP1 + 3.0 * m * t * t * aP2 + t * t * t * aP3;
  }

  vec3 bezierD(float t) {
    float m = 1.0 - t;
    return 3.0 * (m * m * (aP1 - aP0) + 2.0 * m * t * (aP2 - aP1) + t * t * (aP3 - aP2));
  }

  vec3 bezierDD(float t) {
    float m = 1.0 - t;
    return 6.0 * (m * (aP2 - 2.0 * aP1 + aP0) + t * (aP3 - 2.0 * aP2 + aP1));
  }

  /**
   * Pressure, on the same cubic Bernstein basis as the spine.
   *
   * Bernstein rather than an interpolating spline on purpose: the curve passes
   * through the first and last control points exactly, which is what "entry"
   * and "exit" have to mean, and the two middle points only pull at the body.
   * An interpolating curve through four authored values overshoots between them
   * and the overshoot is a bulge the author did not draw.
   */
  float pressureAt(float t) {
    float m = 1.0 - t;
    return m * m * m * aPress.x + 3.0 * m * m * t * aPress.y
         + 3.0 * m * t * t * aPress.z + t * t * t * aPress.w;
  }

  /** Pigment laid per metre of travel. 1.0 is a nominal full-pressure stroke. */
  float pigmentAt(float t) {
    float sp = max(length(bezierD(t)), 1e-3);
    float pr = max(pressureAt(t), 0.0);
    // Two terms because deposition has two causes: area swept (scales with the
    // distance covered) and time in contact (does not). Where the spine's
    // control points bunch, sp collapses, the dwell term blows up, and the ink
    // pools — which is the whole of "pooling where the stroke slows".
    float dwell = uFlowDwell * (uSpeedRef / sp);
    return pr * (uFlowLength + dwell) * uPigment;
  }

  /** Ink drawn out of the ferrule between the start of the stroke and t. */
  float inkSpent(float t) {
    float h = t / float(INK_QUAD);
    float acc = 0.0;
    for (int i = 0; i <= INK_QUAD; i++) {
      float s = float(i) * h;
      float w = (i == 0 || i == INK_QUAD) ? 0.5 : 1.0;
      acc += w * pigmentAt(s) * max(length(bezierD(s)), 1e-3);
    }
    return acc * h;
  }

  void main() {
    /*
     * The head. Strokes are written in sequence: uProgress is one clock for the
     * whole set and each stroke owns a window of it. The along-parameter is
     * *remapped* into 0..head rather than clipped at it, so the strip spends
     * all its samples on the part that exists and the head itself is a full
     * cross-section — the brush is still there, it has not been lifted.
     */
    float head = clamp((uProgress - aStroke.x) / max(aStroke.y, 1e-4), 0.0, 1.0);
    float t = position.x * head;
    float ring = position.y;

    vec3  P  = bezier(t);
    vec3  T  = bezierD(t);
    float sp = max(length(T), 1e-4);
    vec3  Tn = T / sp;

    vec3 paper = safeNormalize(uPaper, vec3(0.0, 1.0, 0.0));
    vec3 W = safeNormalize(cross(Tn, paper), vec3(1.0, 0.0, 0.0));  // across the stroke
    vec3 D = safeNormalize(cross(W, Tn), paper);                     // through the paper

    float pr = max(pressureAt(t), 0.0);
    float halfW = uWidth * pr;

    /* --- pooling ---------------------------------------------------- */
    // Curvature in 1/metres. A hairpin is where the brush pivots on its tip and
    // dumps ink, and the speed term alone under-reads it because a tight turn
    // can still be quick.
    vec3 A = bezierDD(t);
    float curv = length(cross(T, A)) / (sp * sp * sp);
    float pig = pigmentAt(t) * (1.0 + uPoolCurve * curv);
    halfW *= 1.0 + uPoolSwell * max(pig - 1.0, 0.0);

    /* --- the head, while it is still moving -------------------------- */
    // step(head, 0.999) is 1 while the stroke is unfinished. A finished stroke
    // must not taper at t = 1: that is the exit, and the exit is the author's
    // last pressure control point, not ours.
    float drawing = step(head, 0.999);
    float toHead = (head - t) / max(head, 1e-4);
    float headFade = mix(1.0, smoothstep(0.0, max(uHeadTaper, 1e-4), toHead), drawing);

    /* --- arclength, approximated by the chord ------------------------ */
    // Good enough for the noise phases and the wet band, and it costs nothing.
    // The exact arclength would need its own quadrature and would move the
    // streaks by less than their own width.
    float chord = max(length(aP3 - aP0), 1e-3);
    float along = t * chord;
    float wet = 1.0 - smoothstep(0.0, max(uWetLength, 1e-3), (head - t) * chord);

    /* --- this bristle's ink ------------------------------------------ */
    float load = aStroke.w
               * mix(1.0, max(uEdgeStarve, 0.0), abs(aBrush.x))
               * (1.0 + uLoadJitter * (aBrush.z - 0.5) * 2.0);
    float remain = load - inkSpent(t);
    float dry = 1.0 - clamp(remain / max(uDryBand, 1e-3), 0.0, 1.0);

    float bseed = aBrush.w * 613.0 + aStroke.z * 37.0;
    float n = vnoise1(along * uSkipScale + bseed);
    n = clamp(0.5 + (n - 0.5) * max(uSkipContrast, 0.0), 0.0, 1.0);
    float soft = max(uSkipSoft, 1e-3);
    // Below the threshold the bristle is off the paper. step() on remain is not
    // redundant with the smoothstep: dryness saturates at 1 while remain keeps
    // going negative, and a lucky noise sample would otherwise let a spent
    // bristle print a stray dash a metre past its runout.
    float contact = smoothstep(dry - soft, dry + soft, n) * step(0.0, remain);

    /* --- the cross-section ------------------------------------------- */
    float bw = halfW * (max(uBristleWidth, 0.0) / max(uBristles, 1.0));
    bw *= mix(1.0, max(uDryThin, 0.0), dry);
    float bd = uDepth * mix(1.0, max(uDryThin, 0.0), dry);

    float across = aBrush.x * (1.0 + uSplay * pr);
    float wob = (vnoise1(along * uFibreScale + bseed * 1.7) - 0.5) * 2.0 * uWobble;
    vec3 centre = P + W * (across * halfW + wob) + D * (aBrush.y * uFerruleDepth);

    float ang = ring * TAU;
    vec2 sect = vec2(cos(ang), sin(ang));
    // Collapsing the section onto the spine where contact is lost is what makes
    // the fray read as fibres tapering off rather than as a stroke with bites
    // taken out of it. The degenerate triangles cost nothing; the fragment
    // discards them on alpha anyway.
    float sc = contact * headFade;
    vec3 world = centre + W * (sect.x * bw * sc) + D * (sect.y * bd * sc);

    // The ellipse normal, written as the un-normalised gradient so a zero
    // half-axis does not divide by zero.
    vec3 nrm = safeNormalize(W * (sect.x * bd) + D * (sect.y * bw), D);

    vPigment = pig;
    vAcross  = sect.x;
    vDry     = dry;
    vContact = sc * step(0.0001, head);
    vWet     = wet;
    vAlong   = along;
    vSeed    = bseed;
    vNormalW = nrm;

    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * Pigment, and nothing that glows.
 *
 * Two ideas: the **bleed**, which is the wicking at the edge of the mark where
 * the vehicle carries the pigment further than the pigment can stay dense; and
 * the **ceiling**, which is how this school stays out of the bloom pass.
 *
 * The bloom high-pass runs on linear scene colour *before* the tone map
 * (`RenderPass -> distortion -> UnrealBloomPass -> OutputPass`), so its
 * threshold — `settings.post.bloomThreshold`, 0.88 as shipped — is a linear
 * luminance. Clamping this material's output luminance to `uCeiling` (0.62 by
 * default) therefore makes it *impossible* for ink to feed bloom, whatever the
 * caster is standing next to and whatever the pickers are set to. That is
 * stronger than "pick dark colours", which is one careless colour picker away
 * from a glowing brushstroke.
 *
 * Note also what is missing: this material never multiplies by `uGlobalGlow`.
 * Every other VFX material in the project does, because every other one is
 * emissive. Ink is not emissive; the global glow slider must not touch it, or
 * the anti-glow school glows whenever anybody turns the sandbox up.
 */
const BRUSH_FRAGMENT = /* glsl */ `
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform vec3  uLightDir;

  uniform float uBleed;         // fraction of the bristle half-width the edge wicks over
  uniform float uFibreEdge;     // capillary roughness of that edge
  uniform float uFibreScale;    // features per metre
  uniform float uDryPigment;    // density multiplier where a bristle is dry
  uniform float uWetGain;       // extra density in the wet band behind the head
  uniform float uOpacity;
  uniform float uFade;          // the ability's own fade, 0..1
  uniform float uLit;           // 0 flat pigment, 1 wrapped diffuse
  uniform float uBackLit;       // the floor of that wrap
  uniform float uCeiling;       // max linear luminance — the anti-bloom clamp
  uniform float uSoftFade;      // metres of depth feather

  uniform vec3  uColorA;        // the palest wicked edge
  uniform vec3  uColorB;        // body
  uniform vec3  uColorC;        // full-strength ink
  uniform vec3  uColorD;        // pooled
  uniform float uTint;          // where in the gradient a zero-density mark sits
  uniform float uTintDensity;   // how far density walks it
  uniform float uTintJitter;    // +/- per bristle

  varying float vPigment;
  varying float vAcross;
  varying float vDry;
  varying float vContact;
  varying float vWet;
  varying float vAlong;
  varying float vSeed;
  varying vec3  vNormalW;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}
  ${BRUSH_NOISE}

  void main() {
    if (vContact < 0.004) discard;

    // Distance in from the rim of this bristle, 1 on its centreline.
    float edge = 1.0 - abs(vAcross);
    float fibre = (vnoise1(vAlong * uFibreScale * 3.1 + vSeed * 0.37) - 0.5) * uFibreEdge;
    float ink = smoothstep(0.0, max(uBleed, 1e-3), edge + fibre);
    if (ink < 0.004) discard;

    float density = vPigment * ink * vContact;
    density *= mix(1.0, max(uDryPigment, 0.0), vDry);
    density *= 1.0 + uWetGain * vWet;

    float alpha = clamp(density * uOpacity, 0.0, 1.0) * clamp(uFade, 0.0, 1.0);
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    float jitter = (fract(vSeed * 0.618034) - 0.5) * 2.0 * uTintJitter;
    float g = clamp(uTint + density * uTintDensity + jitter, 0.0, 1.0);
    vec3 colour = gradient4(uColorA, uColorB, uColorC, uColorD, g);

    // Wrapped diffuse and no specular at all. A specular lobe on ink is the one
    // thing that would put this school back among the emissive ones; the only
    // gloss in Ink is on wet InkDiffusion, where it is a real observation.
    vec3 nrm = normalize(vNormalW);
    float ndl = dot(nrm, normalize(uLightDir)) * 0.5 + 0.5;
    colour *= mix(1.0, mix(max(uBackLit, 0.0), 1.0, ndl), clamp(uLit, 0.0, 1.0));

    float lum = dot(colour, vec3(0.2126, 0.7152, 0.0722));
    colour *= lum > uCeiling ? uCeiling / max(lum, 1e-4) : 1.0;

    gl_FragColor = vec4(colour, clamp(alpha, 0.0, 1.0));
  }
`;

/* ---------------------------------------------------------------------- */
/* Scratch — the frame allocates nothing (I3)                              */
/* ---------------------------------------------------------------------- */

const _dir = new Vector3();
const _side = new Vector3();
const _mid = new Vector3();
const _tmp = new Vector3();
const _up = new Vector3(0, 1, 0);

/* ---------------------------------------------------------------------- */
/* A stroke                                                                */
/* ---------------------------------------------------------------------- */

/**
 * One mark of the brush.
 *
 * Handles are built once at construction and re-used, the way `FilamentPaths`
 * hands out roles — an ability holds no references it did not get from the
 * module and nothing here allocates once the brush exists.
 *
 * Everything a handle is given is a **live dimension**: the ability calls
 * `curve()` / `line()` / `pressure()` every frame with values it has just
 * resolved from `settings[id]`. The handle stores them so `update()` can expand
 * them across the bristles, not so anything can be captured.
 */
class Stroke {
  constructor(brush, index) {
    this._brush = brush;
    this.index = index;

    /** The spine, as four world-space control points. */
    this.p0 = new Vector3();
    this.p1 = new Vector3();
    this.p2 = new Vector3();
    this.p3 = new Vector3();

    /** Pressure control points: entry, swell, hold, exit. Unitless, 0..1-ish. */
    this.pressEntry = 0.15;
    this.pressSwell = 1;
    this.pressHold = 0.85;
    this.pressExit = 0.05;

    /** Where in `uProgress` this stroke is written. */
    this.drawStart = 0;
    this.drawSpan = 1;

    /**
     * Ink in the ferrule, in **metre-pigment**: the length of nominal
     * full-pressure stroke it can lay before the brush is empty. 9 means "nine
     * metres and then nothing", which is a unit an author can actually aim.
     */
    this.load = 9;

    /** Unitless, set by `roll()`. Shifts this stroke's bristle noise. */
    this.seed = 0;

    /** Skipped entirely when false. */
    this.active = true;
  }

  /** The spine as an explicit cubic. Everything else is sugar over this. */
  curve(p0, p1, p2, p3) {
    this.p0.copy(p0);
    this.p1.copy(p1);
    this.p2.copy(p2);
    this.p3.copy(p3);
    return this;
  }

  /**
   * A stroke from `from` to `to`, bowed `bow` metres sideways in the paper
   * plane and lifted `lift` metres along the paper normal at its middle.
   *
   * The two inner control points sit at 1/3 and 2/3 and share the same
   * displacement, which gives an arc rather than an S. Ask for an S by calling
   * `curve()` — the point of this helper is that a calligraphic stroke is
   * almost always one arc, and four points is three too many to author per
   * frame for something that simple.
   */
  line(from, to, bow = 0, lift = 0) {
    const paper = this._brush._paper;
    _dir.copy(to).sub(from);
    const span = _dir.length();
    if (span > 1e-5) _dir.multiplyScalar(1 / span);
    else _dir.set(0, 0, 1);
    _side.copy(_dir).cross(paper);
    if (_side.lengthSq() < 1e-8) _side.copy(_dir).cross(_up);
    if (_side.lengthSq() < 1e-8) _side.set(1, 0, 0);
    _side.normalize();

    this.p0.copy(from);
    this.p3.copy(to);
    _mid.copy(_side).multiplyScalar(bow).addScaledVector(paper, lift);
    this.p1.copy(from).lerp(to, 1 / 3).add(_mid);
    this.p2.copy(from).lerp(to, 2 / 3).add(_mid);
    return this;
  }

  /**
   * The pressure curve, in ferrule half-widths.
   *
   * `entry` and `exit` are hit exactly; `swell` and `hold` pull at the body.
   * A sumi stroke is roughly `(0.12, 1.0, 0.8, 0.02)` — set down light, press
   * through the body, lift off to nothing. A seal-script stroke is closer to
   * `(0.75, 0.9, 0.9, 0.7)`: seal script has almost constant weight, and that
   * evenness is exactly what makes it legible as *writing* rather than as
   * painting.
   */
  pressure(entry, swell, hold, exit) {
    this.pressEntry = entry;
    this.pressSwell = swell;
    this.pressHold = hold;
    this.pressExit = exit;
    return this;
  }

  /** Metre-pigment in the ferrule. Lower it and the tail frays sooner. */
  ink(load) {
    this.load = load;
    return this;
  }

  /** The window of `uProgress` this stroke occupies. */
  timing(start, span) {
    this.drawStart = start;
    this.drawSpan = span;
    return this;
  }

  /** How far this stroke has been written, 0..1 of its own length. */
  get head() {
    const u = this._brush.material.uniforms.uProgress.value;
    return Math.max(0, Math.min(1, (u - this.drawStart) / Math.max(this.drawSpan, 1e-4)));
  }
}

/* ---------------------------------------------------------------------- */
/* BrushStroke                                                             */
/* ---------------------------------------------------------------------- */

/**
 * **What it draws.** Brush marks with brush dynamics: a pressure curve that
 * swells and lifts, ink that pools where the brush slows or turns, an edge that
 * wicks into the paper, and a dry tail that comes apart into separate bristle
 * streaks because the bristles are separately modelled and separately run out.
 * The mark is a swept ellipse, not a billboard, so it survives being looked at
 * edge-on.
 *
 * **Draw calls.** One, for every stroke and every bristle. Two brushes that
 * must differ in *tip layout* are two `BrushStroke`s and two draw calls; two
 * that only differ in width, pressure or colour are one.
 *
 * **What it reads from settings.** Nothing directly. `update(_now, params)`
 * takes a live block and resolves `p.key ?? default` against
 * `brushStrokeParams()`, and the per-stroke dimensions arrive on the `Stroke`
 * handles every frame. Pause with **P** and drag `width`, `flowDwell` or
 * `inkLoad` and the standing mark re-inks itself.
 *
 * **The one rule for using it well.** *Let the pressure curve spend the ink.*
 * The tail frays where `inkLoad` runs out against what `pressure()` and the
 * spine's own speed have already spent — so a heavy stroke should fray early
 * and a skimming one should not fray at all, and the way to move the fray is to
 * change how hard the brush is pressing, not to reach for `dryBand`. If you
 * find yourself tuning the dry parameters to put the fray in a particular
 * place, the pressure curve is wrong.
 *
 * ---
 *
 * ## Clock
 *
 * `update()` **ignores its first argument**, like `Swarm` and `Curtain`. A
 * brush mark is not an animation, it is a standing object whose only temporal
 * parameter is `progress` — how much of it has been written — and the ability
 * owns that beat. Taking a clock as well would mean two sources of truth for
 * where the head is, and they would disagree the first time anything paused.
 *
 * ## Sizing
 *
 * `strokes * bristles` instances, each `(samples + 1) * sides` vertices. The
 * defaults (6 x 14 x 41 x 6) are about 20k vertices, which is nothing. Seal
 * script wants many short strokes: build it `{ strokes: 24, bristles: 10,
 * samples: 20 }` — a character stroke is 15 cm long and does not need forty
 * samples down it — and it lands in the same place.
 */
export class BrushStroke {
  /**
   * @param {THREE.Object3D} parent the ability's group
   * @param {object}  [options]
   * @param {number}  [options.strokes=6]     marks the brush can hold at once
   * @param {number}  [options.bristles=14]   bristles per mark — the fray's resolution
   * @param {number}  [options.samples=40]    segments along a spine
   * @param {number}  [options.sides=6]       vertices around the swept ellipse
   * @param {number}  [options.tip=BrushTip.FLAT]
   * @param {boolean} [options.depthWrite=false]
   * @param {number}  [options.layer=LAYER.VFX]
   * @param {number}  [options.renderOrder=7]
   * @param {string}  [options.name]
   */
  constructor(
    parent,
    {
      strokes = 6,
      bristles = 14,
      samples = 40,
      sides = 6,
      tip = BrushTip.FLAT,
      depthWrite = false,
      layer = LAYER.VFX,
      renderOrder = 7,
      name = null
    } = {}
  ) {
    this.strokes = Math.max(1, Math.round(strokes));
    this.bristles = Math.max(1, Math.round(bristles));
    this.samples = Math.max(2, Math.round(samples));
    this.sides = Math.max(3, Math.round(sides));
    this.capacity = this.strokes * this.bristles;

    this.group = new Group();
    this.group.name = name ?? 'BrushStroke';
    this.group.matrixAutoUpdate = false;
    parent?.add(this.group);

    /* --- the swept strip --------------------------------------------- */
    const rings = this.samples + 1;
    const vertexCount = rings * this.sides;
    const positions = new Float32Array(vertexCount * 3);
    for (let i = 0; i < rings; i++) {
      const u = i / this.samples;
      for (let j = 0; j < this.sides; j++) {
        const v = (i * this.sides + j) * 3;
        positions[v + 0] = u; //  along the spine, 0..1
        positions[v + 1] = j / this.sides; //  around the ellipse, 0..1 (wraps in the index)
        positions[v + 2] = 0;
      }
    }
    const indices = new Uint16Array(this.samples * this.sides * 6);
    let k = 0;
    for (let i = 0; i < this.samples; i++) {
      for (let j = 0; j < this.sides; j++) {
        const j1 = (j + 1) % this.sides;
        const a = i * this.sides + j;
        const b = i * this.sides + j1;
        const c = (i + 1) * this.sides + j;
        const d = (i + 1) * this.sides + j1;
        indices[k++] = a;
        indices[k++] = c;
        indices[k++] = b;
        indices[k++] = b;
        indices[k++] = c;
        indices[k++] = d;
      }
    }

    /* --- per-instance state ------------------------------------------ */
    this._p0 = new InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this._p1 = new InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this._p2 = new InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this._p3 = new InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this._press = new InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this._stroke = new InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this._brushAttr = new InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);

    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aP0', this._p0);
    geometry.setAttribute('aP1', this._p1);
    geometry.setAttribute('aP2', this._p2);
    geometry.setAttribute('aP3', this._p3);
    geometry.setAttribute('aPress', this._press);
    geometry.setAttribute('aStroke', this._stroke);
    geometry.setAttribute('aBrush', this._brushAttr);
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.instanceCount = 0;
    // Placed in world space by the vertex shader; its own bounds mean nothing.
    geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    this.geometry = geometry;

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite,
      depthTest: true,
      blending: NormalBlending,
      // Double-sided because the ellipse degenerates to a flat ribbon whenever
      // depth is authored near zero, and a one-sided flat ribbon is invisible
      // from below. The prism is closed when it has depth, so this only ever
      // costs the degenerate case.
      side: DoubleSide,
      /*
       * Declared true, unlike every other module in this library.
       *
       * It is inert as things stand — the composer always renders to a target
       * and three switches materials to NoToneMapping off-screen, so the grade
       * happens once, in OutputPass, for everything. But the flag is a
       * statement about what the material *is*, and ink is pigment: it belongs
       * under the same grade as the floor it is lying on, not punched through
       * it like an ember. Copying `toneMapped: false` off an emissive module
       * into a matte one is exactly the mistake this school exists to avoid.
       */
      toneMapped: true,
      uniforms: sharedUniforms({
        uPaper: { value: new Vector3(0, 1, 0) },

        uWidth: { value: 0.34 },
        uDepth: { value: 0.035 },
        uFerruleDepth: { value: 0 },
        uBristles: { value: this.bristles },
        uBristleWidth: { value: 1.7 },
        uSplay: { value: 0.18 },
        uWobble: { value: 0.012 },
        uFibreScale: { value: 2.4 },

        uFlowLength: { value: 0.65 },
        uFlowDwell: { value: 0.35 },
        uSpeedRef: { value: 12 },
        uEdgeStarve: { value: 0.55 },
        uLoadJitter: { value: 0.35 },
        uDryBand: { value: 2.6 },
        uDryThin: { value: 0.55 },
        uSkipScale: { value: 3.4 },
        uSkipSoft: { value: 0.12 },
        uSkipContrast: { value: 1.8 },

        uPoolSwell: { value: 0.45 },
        uPoolCurve: { value: 0.35 },
        uPigment: { value: 1 },

        uProgress: { value: 1 },
        uHeadTaper: { value: 0.05 },
        uWetLength: { value: 0.9 },

        uBleed: { value: 0.22 },
        uFibreEdge: { value: 0.16 },
        uDryPigment: { value: 0.7 },
        uWetGain: { value: 0.3 },
        uOpacity: { value: 1 },
        uFade: { value: 1 },
        uLit: { value: 0.35 },
        uBackLit: { value: 0.72 },
        uCeiling: { value: 0.62 },
        uSoftFade: { value: 0.12 },

        uColorA: { value: new Color('#b6a893') },
        uColorB: { value: new Color('#544a41') },
        uColorC: { value: new Color('#1b1815') },
        uColorD: { value: new Color('#070605') },
        uTint: { value: 0.04 },
        uTintDensity: { value: 0.82 },
        uTintJitter: { value: 0.08 }
      }),
      vertexShader: BRUSH_VERTEX,
      fragmentShader: BRUSH_FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = `${this.group.name}:mesh`;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.layers.set(layer);
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
    this.group.add(this.mesh);

    /* --- handles, built once ----------------------------------------- */
    this._strokes = [];
    for (let i = 0; i < this.strokes; i++) this._strokes.push(new Stroke(this, i));
    this._liveStrokes = this.strokes;
    this._liveInstances = 0;

    this._paper = new Vector3(0, 1, 0);
    this._tip = tip;
    this.seed = 0;

    this._p = brushStrokeParams();
    this.roll(0);
    this.retip(tip);
  }

  get object3D() {
    return this.group;
  }

  get uniforms() {
    return this.material.uniforms;
  }

  /** One. However many strokes, however many bristles. */
  get drawCalls() {
    return 1;
  }

  /** Instances drawn on the last update. → `Ability#instanceCount`. */
  get count() {
    return this._liveInstances;
  }

  /** Strokes the ability is currently using, ≤ `strokes`. */
  get strokeCount() {
    return this._liveStrokes;
  }

  get tip() {
    return this._tip;
  }

  /** How many of the handles are written this cast. Clamped to capacity. */
  setStrokeCount(n) {
    this._liveStrokes = Math.max(0, Math.min(this.strokes, Math.round(n)));
    return this;
  }

  /** Handle `i`, built at construction. Out of range returns the last one. */
  stroke(i) {
    return this._strokes[Math.max(0, Math.min(this.strokes - 1, i | 0))];
  }

  /**
   * The plane the writing lies in, as its unit normal.
   *
   * Sumi lays a stroke on the floor and passes world up. Seal script hangs a
   * column in the air facing the caster and passes the horizontal facing
   * direction — and it is precisely then that the swept ellipse earns its keep,
   * because orbiting to 90° off that normal is what would kill a billboard.
   */
  setPaper(normal) {
    this._paper.copy(normal);
    if (this._paper.lengthSq() < 1e-8) this._paper.set(0, 1, 0);
    this._paper.normalize();
    this.material.uniforms.uPaper.value.copy(this._paper);
    return this;
  }

  /**
   * Four pickers, none derived from another: wicked edge, body, full ink,
   * pooled. Takes `THREE.Color`s or `#rrggbb` straight out of a settings block.
   */
  setColors(a, b, c, d) {
    const u = this.material.uniforms;
    u.uColorA.value.copy(typeof a === 'string' ? getColor(a) : a);
    u.uColorB.value.copy(typeof b === 'string' ? getColor(b) : b);
    u.uColorC.value.copy(typeof c === 'string' ? getColor(c) : c);
    const pool = d ?? c;
    u.uColorD.value.copy(typeof pool === 'string' ? getColor(pool) : pool);
    return this;
  }

  /**
   * Re-roll the unitless dice. Call from `onSpawn` and nowhere else.
   *
   * The dice are all a bristle carries: how much ink it started with relative
   * to its neighbours, and where its own contact noise sits. Every metre those
   * turn into is resolved in the vertex shader from live uniforms.
   */
  roll(seed = Math.random() * 100) {
    this.seed = seed;
    const brush = this._brushAttr.array;
    for (let i = 0; i < this.capacity; i++) {
      brush[i * 4 + 2] = Math.random(); //  load dice
      brush[i * 4 + 3] = Math.random(); //  contact-noise seed
    }
    this._brushAttr.needsUpdate = true;
    for (let s = 0; s < this.strokes; s++) {
      // Derived rather than random so two casts with the same seed write the
      // same characters — a preset has to be reproducible.
      this._strokes[s].seed = ((seed * 0.6180339887 + s * 0.7548776662) % 1) * 100;
    }
    return this;
  }

  /**
   * Lay the bristles out in the ferrule. Cheap; safe to drive from a dropdown.
   *
   * FLAT is one rank across the width — the sumi brush, and the layout where a
   * dry tail comes apart into clean parallel streaks. ROUND spreads them on a
   * golden-angle disc so the streaks separate through the paper normal as well,
   * which is what a round brush's tail actually does and which needs
   * `ferruleDepth` to be non-zero to show. SPLIT clumps them into three tufts
   * with paper between: a brush somebody has already ruined, and the fastest
   * way to a mark that looks two hundred years old.
   */
  retip(tip) {
    this._tip = tip;
    const brush = this._brushAttr.array;
    const n = this.bristles;
    for (let b = 0; b < n; b++) {
      let across;
      let through = 0;
      if (tip === BrushTip.ROUND) {
        // Vogel's spiral: the only cheap fill of a disc with no clumps and no
        // preferred axis. A random fill leaves holes and doubles, and holes in
        // a ferrule read as a brush that was already dry.
        const r = Math.sqrt((b + 0.5) / n);
        const a = b * 2.399963229728653;
        across = r * Math.cos(a);
        through = r * Math.sin(a);
      } else if (tip === BrushTip.SPLIT) {
        const tufts = 3;
        const per = Math.max(1, Math.ceil(n / tufts));
        const tuft = Math.min(tufts - 1, Math.floor(b / per));
        const within = per > 1 ? ((b % per) / (per - 1) - 0.5) * 2 : 0;
        // The tuft is deliberately much narrower than its share of the ferrule:
        // a split brush is defined by the *paper between the tufts*, and at
        // 0.72 the tufts touched and the mark came back out as a solid stroke.
        across = ((tuft + 0.5) / tufts - 0.5) * 2 + within * (0.42 / tufts);
      } else {
        across = n > 1 ? ((b + 0.5) / n - 0.5) * 2 : 0;
      }
      for (let s = 0; s < this.strokes; s++) {
        const i = s * n + b;
        brush[i * 4 + 0] = across;
        brush[i * 4 + 1] = through;
      }
    }
    this._brushAttr.needsUpdate = true;
    return this;
  }

  /** Hide the brush. Leaves the instance reusable — the pooling contract. */
  reset() {
    this._liveInstances = 0;
    this._liveStrokes = this.strokes;
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
    for (let s = 0; s < this.strokes; s++) {
      const stroke = this._strokes[s];
      stroke.active = true;
      stroke.p0.set(0, 0, 0);
      stroke.p1.set(0, 0, 0);
      stroke.p2.set(0, 0, 0);
      stroke.p3.set(0, 0, 0);
      stroke.timing(0, 1);
    }
    return this;
  }

  /** Fill `_p` from the caller's block, defaults where it is silent. */
  _resolve(params) {
    const p = this._p;
    for (const key in DEFAULT_PARAMS) {
      const value = params[key];
      p[key] = value === undefined ? DEFAULT_PARAMS[key] : value;
    }
    return p;
  }

  /**
   * Push the live params into the uniforms and expand the strokes across the
   * bristles.
   *
   * @param {number} _now ignored — see the clock note in the class doc.
   * @param {object} params live block; anything absent falls back to
   *   `brushStrokeParams()`.
   */
  update(_now, params) {
    const p = this._resolve(params ?? DEFAULT_PARAMS);
    const u = this.material.uniforms;

    /* --- the strokes --------------------------------------------------
     * Written every frame, from whatever the ability resolved this frame. The
     * arrays are the transport, not the storage: nothing in here survives a
     * frame in a form that could go stale under a paused slider.
     */
    const n = this.bristles;
    let live = 0;
    for (let s = 0; s < this._liveStrokes; s++) {
      const stroke = this._strokes[s];
      const base = s * n;
      /*
       * An inactive stroke is *parked*, not skipped. Its slots stay where they
       * are and its draw window is pushed past the end of the clock, so its
       * head resolves to zero and the vertex shader collapses it. Compacting
       * the live strokes down instead would slide every later stroke into a
       * different slot, and the slot is where the bristle dice live — the
       * remaining characters would silently re-write themselves.
       */
      const parked = !stroke.active;
      for (let b = 0; b < n; b++) {
        const i = base + b;
        const v3 = i * 3;
        const v4 = i * 4;
        this._p0.array[v3 + 0] = stroke.p0.x;
        this._p0.array[v3 + 1] = stroke.p0.y;
        this._p0.array[v3 + 2] = stroke.p0.z;
        this._p1.array[v3 + 0] = stroke.p1.x;
        this._p1.array[v3 + 1] = stroke.p1.y;
        this._p1.array[v3 + 2] = stroke.p1.z;
        this._p2.array[v3 + 0] = stroke.p2.x;
        this._p2.array[v3 + 1] = stroke.p2.y;
        this._p2.array[v3 + 2] = stroke.p2.z;
        this._p3.array[v3 + 0] = stroke.p3.x;
        this._p3.array[v3 + 1] = stroke.p3.y;
        this._p3.array[v3 + 2] = stroke.p3.z;
        this._press.array[v4 + 0] = stroke.pressEntry;
        this._press.array[v4 + 1] = stroke.pressSwell;
        this._press.array[v4 + 2] = stroke.pressHold;
        this._press.array[v4 + 3] = stroke.pressExit;
        this._stroke.array[v4 + 0] = parked ? 1e4 : stroke.drawStart;
        this._stroke.array[v4 + 1] = Math.max(stroke.drawSpan, 1e-4);
        this._stroke.array[v4 + 2] = stroke.seed;
        this._stroke.array[v4 + 3] = stroke.load * p.inkLoad;
      }
      if (!parked) live = base + n;
    }

    this._p0.needsUpdate = true;
    this._p1.needsUpdate = true;
    this._p2.needsUpdate = true;
    this._p3.needsUpdate = true;
    this._press.needsUpdate = true;
    this._stroke.needsUpdate = true;

    this._liveInstances = live;
    this.geometry.instanceCount = live;
    this.mesh.visible = live > 0 && p.opacity > 0 && p.fade > 0 && p.width > 0;

    /* --- the brush ---------------------------------------------------- */
    u.uWidth.value = p.width;
    u.uDepth.value = p.depth;
    u.uFerruleDepth.value = p.ferruleDepth;
    u.uBristles.value = this.bristles;
    u.uBristleWidth.value = p.bristleWidth;
    u.uSplay.value = p.splay;
    u.uWobble.value = p.wobble;
    u.uFibreScale.value = p.fibreScale;

    /* --- ink ----------------------------------------------------------- */
    u.uFlowLength.value = p.flowLength;
    u.uFlowDwell.value = p.flowDwell;
    u.uSpeedRef.value = p.speedRef;
    u.uEdgeStarve.value = p.edgeStarve;
    u.uLoadJitter.value = p.loadJitter;
    u.uDryBand.value = p.dryBand;
    u.uDryThin.value = p.dryThin;
    u.uSkipScale.value = p.skipScale;
    u.uSkipSoft.value = p.skipSoft;
    u.uSkipContrast.value = p.skipContrast;

    /* --- pooling -------------------------------------------------------- */
    u.uPoolSwell.value = p.poolSwell;
    u.uPoolCurve.value = p.poolCurve;
    u.uPigment.value = p.pigment;

    /* --- the beat -------------------------------------------------------- */
    u.uProgress.value = p.progress;
    u.uHeadTaper.value = p.headTaper;
    u.uWetLength.value = p.wetLength;

    /* --- the mark --------------------------------------------------------- */
    u.uBleed.value = p.bleed;
    u.uFibreEdge.value = p.fibreEdge;
    u.uDryPigment.value = p.dryPigment;
    u.uWetGain.value = p.wetGain;
    u.uOpacity.value = p.opacity;
    u.uFade.value = p.fade;
    u.uLit.value = p.lit;
    u.uBackLit.value = p.backLit;
    u.uCeiling.value = p.ceiling;
    u.uSoftFade.value = p.softFade;
    u.uTint.value = p.tint;
    u.uTintDensity.value = p.tintDensity;
    u.uTintJitter.value = p.tintJitter;

    this.setColors(p.colorWash, p.colorBody, p.colorInk, p.colorPool);
    if (p.paper) this.setPaper(p.paper);
  }

  /* --- CPU mirrors -------------------------------------------------- *
   * The ability needs the tip of the brush to hang a light, a wisp of smoke or
   * a particle emitter on. These evaluate the same cubic the vertex shader
   * does: change one, change the other.
   */

  /** The spine of stroke `i` at parameter `t`, in world space. */
  pointAt(i, t, out) {
    const s = this.stroke(i);
    const m = 1 - t;
    out.set(0, 0, 0);
    out.addScaledVector(s.p0, m * m * m);
    out.addScaledVector(s.p1, 3 * m * m * t);
    out.addScaledVector(s.p2, 3 * m * t * t);
    out.addScaledVector(s.p3, t * t * t);
    return out;
  }

  /** The unit tangent of stroke `i` at `t`. Falls back downrange if degenerate. */
  tangentAt(i, t, out) {
    const s = this.stroke(i);
    const m = 1 - t;
    out.set(0, 0, 0);
    _tmp.copy(s.p1).sub(s.p0);
    out.addScaledVector(_tmp, 3 * m * m);
    _tmp.copy(s.p2).sub(s.p1);
    out.addScaledVector(_tmp, 6 * m * t);
    _tmp.copy(s.p3).sub(s.p2);
    out.addScaledVector(_tmp, 3 * t * t);
    if (out.lengthSq() < 1e-10) out.set(0, 0, 1);
    return out.normalize();
  }

  /** How far stroke `i` has been written, 0..1 of its own length. */
  headOf(i) {
    return this.stroke(i).head;
  }

  /** Where the brush is right now on stroke `i`. */
  tipPoint(i, out) {
    return this.pointAt(i, this.headOf(i), out);
  }

  /** The pressure curve of stroke `i` at `t`, unitless. */
  pressureOf(i, t) {
    const s = this.stroke(i);
    const m = 1 - t;
    return (
      m * m * m * s.pressEntry +
      3 * m * m * t * s.pressSwell +
      3 * m * t * t * s.pressHold +
      t * t * t * s.pressExit
    );
  }

  /** Half-width of the mark of stroke `i` at `t`, in metres. Reads `_p`. */
  widthAt(i, t) {
    return Math.max(0, this.pressureOf(i, t)) * this._p.width;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.group.parent?.remove(this.group);
  }
}

/* ---------------------------------------------------------------------- */
/* Params                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * Every key `update()` understands, with its default and its unit.
 *
 * `inkLoad` is a *multiplier* on the per-stroke load rather than the load
 * itself, because the load is genuinely per stroke — the first character of a
 * column is written with a full brush and the last one is not — while the
 * slider that says "how wet is this cast" is one number for the whole thing.
 */
export function brushStrokeParams() {
  return {
    /* --- the brush --- */
    width: 0.34, // metres, ferrule half-width at pressure 1
    depth: 0.035, // metres, half-thickness through the paper normal
    ferruleDepth: 0, // metres the bristles spread through that normal (ROUND tips)
    bristleWidth: 1.7, // >1 overlaps into a solid stroke, <1 separates
    splay: 0.18, // fraction the bristles fan out at full pressure
    wobble: 0.012, // metres of per-bristle lateral wander
    fibreScale: 2.4, // features per metre of that wander
    paper: null, // optional Vector3 normal; setPaper() otherwise

    /* --- ink --- */
    inkLoad: 1, // multiplier on every stroke's own metre-pigment load
    flowLength: 0.65, // pigment laid per metre of travel, at pressure 1
    flowDwell: 0.35, // extra pigment laid per metre when the brush dwells
    speedRef: 12, // metres per unit t at which the brush is "at speed"
    edgeStarve: 0.55, // load multiplier at the edge of the ferrule
    loadJitter: 0.35, // +/- fraction of load, per bristle
    dryBand: 2.6, // metre-pigment over which a bristle goes wet -> dry
    dryThin: 0.55, // width multiplier when a bristle is fully dry
    skipScale: 3.4, // features per metre of the contact noise
    skipSoft: 0.12, // softness of the contact threshold
    skipContrast: 1.8, // pushes the value noise off its central pile

    /* --- pooling --- */
    poolSwell: 0.45, // fraction the stroke widens per unit of extra pigment
    poolCurve: 0.35, // extra pigment per 1/metre of spine curvature
    pigment: 1, // overall density multiplier

    /* --- the beat --- */
    progress: 1, // 0..1 across the whole set of strokes
    headTaper: 0.05, // fraction of the drawn length the moving head tapers over
    wetLength: 0.9, // metres behind the head that still read wet

    /* --- the mark --- */
    bleed: 0.22, // fraction of the bristle half-width the edge wicks over
    fibreEdge: 0.16, // capillary roughness of that edge
    dryPigment: 0.7, // density multiplier where a bristle is dry
    wetGain: 0.3, // extra density in the wet band behind the head
    opacity: 1,
    fade: 1, // the ability's own fade, 0..1
    lit: 0.35, // 0 flat pigment, 1 wrapped diffuse
    backLit: 0.72, // the floor of that wrap — high, because ink is matte
    ceiling: 0.62, // max linear luminance; post.bloomThreshold is 0.88
    softFade: 0.12, // metres of depth feather against solid geometry
    tint: 0.04, // where in the gradient a zero-density mark sits
    tintDensity: 0.82, // how far density walks it
    tintJitter: 0.08, // +/- per bristle

    /* --- four pickers, none derived from another --- */
    colorWash: '#b6a893', // the palest wicked edge
    colorBody: '#544a41',
    colorInk: '#1b1815',
    colorPool: '#070605'
  };
}

/** Resolved once at module load; `_resolve` walks its keys every frame. */
const DEFAULT_PARAMS = brushStrokeParams();
