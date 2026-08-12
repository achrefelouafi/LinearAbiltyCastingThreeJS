import {
  Mesh,
  ShaderMaterial,
  AdditiveBlending,
  NormalBlending,
  DoubleSide,
  Color,
  Vector2,
  Vector4
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { acquireGroundQuad, releaseGroundQuad } from './quads.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { disruptGLSL, disruptUniforms } from './SceneHooks.js';
import { LAYER } from '../core/Layers.js';
import { getColor } from '../utils/color.js';

/* ---------------------------------------------------------------------- */
/* GroundField — one quad that thinks in metres                            */
/* ---------------------------------------------------------------------- */

/**
 * A ground quad whose fragment shader works in **metres from an anchor**.
 *
 * This generalises the snare's burnt field and the two targeting indicators,
 * and it exists for the reason the snare's field is a mesh rather than a pooled
 * decal: *a decal captures its radius when it spawns*. `DecalSystem.spawn()`
 * writes `uRadius` once and scales the mesh once, so a crater that is already
 * on the floor cannot hear a slider move. Everything here is re-resolved from
 * the live params on every call to `update()` — including a zero-length frame —
 * so dragging `radius` on a standing mark re-scales the mark, its grain, its
 * relief and its growth front together, with the clock stopped. That is
 * invariant **I1** and it is the whole reason this module exists.
 *
 * ## What it draws
 *
 * One `Mesh`, **one draw call**, no textures, ten modes selected by a `#define`
 * so a program only ever carries the branch it needs. Every mode is a different
 * *substance*, not a different palette:
 *
 * | mode | what it is |
 * | --- | --- |
 * | `PLATE`   | interlocking sheet-ice plates whose downwind edges lift and curl |
 * | `RUNE`    | a whole inscribed seal — nested counter-rotating rings of signed-distance glyphs, a chord armature, a tick collar and a central sigil, all inking themselves stroke by stroke and then igniting from the inside out |
 * | `POCK`    | impact craters accumulating from a list of unitless hits |
 * | `RUT`     | a gouged track behind a rolling body, depth following contact force |
 * | `WET`     | darkened, reflective stone that dries from the edges in |
 * | `PUSTULE` | cellular blisters inflating and bursting on individual timers |
 * | `FUNNEL`  | an inverted cone read as depth off a faked normal — the sinkhole |
 * | `SCOUR`   | rotational scour marks under a vortex |
 * | `LATTICE` | a hex lattice propagating outward along its own edges |
 * | `POOL`    | a liquid pool with a meniscus rim and a slow surface flow |
 *
 * ## The three things every mode shares
 *
 * **A ragged front.** The growth boundary is warped *in the plane* and never
 * sampled on `atan(y, x)`. An angular lookup hands every radius along a bearing
 * the same value, which draws dead-straight spokes out of the centre — a
 * firework, not a burn. The README documents that mistake twice (the bolt's
 * ground burn and the snare's field) because it was made twice. Angular
 * sampling is used in exactly two places below, both of them deliberate: the
 * scour spiral, whose marks genuinely *are* rotational, and the compass sweep
 * that draws the rune circles.
 *
 * **A fake normal.** Each mode publishes a height field in metres; the shared
 * path takes two forward differences off it and lights the result with
 * `frame.uLightDir`, the same key direction the lit meshes use. Without it a
 * ground mark is a sticker — the FROST decal learnt that and this is the same
 * lesson generalised. `RUNE` skips the taps: the glyph SDF hands you its own
 * gradient for free, which is the cheapest normal in the file.
 *
 * **Both blend modes.** The README's rough-edges list ends on "both the
 * targeting circle and the snare's field are additive, so the footprint
 * brightens the floor rather than shading it". `additive: false` (the default)
 * alpha-blends, so a wet flagstone, a hole and a pool of blood are genuinely
 * *darker* than the floor they lie on. Set `additive: true` for the marks that
 * really are made of light.
 *
 * ## The rule for using it well
 *
 * Fill the params object from `settings[id]` **every frame** and hand it to
 * `update()`. Hold that object at module scope and mutate it; an object literal
 * per frame is the allocation invariant **I3** forbids. Never keep a resolved
 * metre between frames — in particular never cache `radius`, because re-scaling
 * live is the one thing this module is for.
 *
 * @example
 *   // construction
 *   this.seal = new GroundField(this.group, { mode: GroundMode.RUNE, additive: false });
 *
 *   // module scope, next to the other scratch
 *   const _seal = groundFieldParams();
 *
 *   // every frame, travel and fade alike
 *   const c = settings.runeseal;
 *   _seal.centre = this.position;            // a Vector3 the ability owns
 *   _seal.radius = c.zoneRadius;             // resolved from settings, never stored
 *   _seal.inscribe = saturate(this.age / c.inscribeTime);
 *   _seal.ignite = saturate((this.age - c.inscribeTime) / c.igniteTime);
 *   _seal.fade = fade;
 *   _seal.glyphSize = c.glyphSize;           // …and the other forty
 *   this.seal.update(_seal);
 */

/** Which substance the one shader is drawing. A mode, not a dimension. */
export const GroundMode = Object.freeze({
  PLATE: 0,
  RUNE: 1,
  POCK: 2,
  RUT: 3,
  WET: 4,
  PUSTULE: 5,
  FUNNEL: 6,
  SCOUR: 7,
  LATTICE: 8,
  POOL: 9
});

/** Human names, for the editor and for `check.mjs` error messages. */
export const GROUND_MODE_NAMES = Object.freeze([
  'PLATE',
  'RUNE',
  'POCK',
  'RUT',
  'WET',
  'PUSTULE',
  'FUNNEL',
  'SCOUR',
  'LATTICE',
  'POOL'
]);

/** Rings the RUNE branch will draw. Fixed so the loop bound is a constant. */
const RUNE_RINGS = 4;

/* ---------------------------------------------------------------------- */
/* The glyph alphabet                                                      */
/* ---------------------------------------------------------------------- */

/**
 * A rune skeleton: eighteen candidate strokes on a 3 × 3 armature.
 *
 * Authoring the alphabet in JavaScript and *generating* the GLSL is not a
 * shortcut, it is the only portable way to do it. GLSL ES 1.00 forbids indexing
 * an array with anything but a constant expression, so a `vec4 STROKES[18]`
 * table read at `strokes[glyphIndex * 18 + i]` will not compile on half the
 * targets three supports. Unrolling the skeleton into straight-line code at
 * module load removes the array, removes the dynamic index, and leaves the
 * alphabet readable *here* — where it is data — rather than smeared through a
 * shader as magic numbers.
 *
 * Segments are `['seg', ax, ay, bx, by]`, arcs are `['arc', cx, cy, r, a0,
 * span]`, all in glyph-local units where the em box is roughly 0.7 × 1.2 and
 * the origin is the waist. Index order is drawing order: uprights, then bars,
 * then the stem, then diagonals, then the bowls and the counter — a scribe
 * blocking in the frame and closing the curves last.
 *
 * ### Why there are twenty-four of them and not twenty-five
 *
 * A stroke set is carried as a **bit field in a float** (see `GLYPH_CODES`), and
 * a highp float holds integers exactly only to 2²⁴. Twenty-four strokes gives a
 * largest possible code of 16 777 215, which is exactly representable;
 * twenty-five gives 33 554 431, which is not, and the failure mode is not a
 * compile error but a glyph that silently loses its last stroke on some
 * hardware and not others. If the alphabet ever needs a twenty-fifth stroke it
 * needs a second code word, not a wider one.
 *
 * The first eighteen shipped with the module. Indices 18–23 were added for
 * `runeseal`, which needed the alphabet to carry a five-metre seal without the
 * eye finding the repeat: **asymmetric arms** (20, 21) so a mark can be
 * left- or right-handed rather than always balanced, **barbs** (18, 19) so a
 * terminal can flick rather than stop, and **two off-centre counters**
 * (22, 23) so an enclosed space can sit above or below the waist instead of
 * only on it. Those three families are what a script has and a set of runes
 * usually does not.
 */
const G_XL = -0.34;
const G_XM = 0.0;
const G_XR = 0.34;
const G_YT = 0.55;
const G_YM = 0.0;
const G_YB = -0.55;
const G_PI = Math.PI;

const GLYPH_STROKES = [
  ['seg', G_XL, G_YM, G_XL, G_YT], //  0  left upright, upper half
  ['seg', G_XL, G_YB, G_XL, G_YM], //  1  left upright, lower half
  ['seg', G_XR, G_YM, G_XR, G_YT], //  2  right upright, upper half
  ['seg', G_XR, G_YB, G_XR, G_YM], //  3  right upright, lower half
  ['seg', G_XL, G_YT, G_XR, G_YT], //  4  head bar
  ['seg', G_XL, G_YM, G_XR, G_YM], //  5  waist bar
  ['seg', G_XL, G_YB, G_XR, G_YB], //  6  foot bar
  ['seg', G_XM, G_YM, G_XM, G_YT], //  7  stem, upper half
  ['seg', G_XM, G_YB, G_XM, G_YM], //  8  stem, lower half
  ['seg', G_XL, G_YT, G_XM, G_YM], //  9  shoulder, NW → waist
  ['seg', G_XR, G_YT, G_XM, G_YM], // 10  shoulder, NE → waist
  ['seg', G_XM, G_YM, G_XL, G_YB], // 11  leg, waist → SW
  ['seg', G_XM, G_YM, G_XR, G_YB], // 12  leg, waist → SE
  ['arc', G_XM, 0.24, 0.3, 0.0, G_PI], // 13  upper bowl — a cap
  ['arc', G_XM, -0.24, 0.3, G_PI, G_PI], // 14  lower bowl
  ['arc', G_XM, G_YM, 0.36, -G_PI * 0.5, G_PI], // 15  right bowl, the 'D'
  ['arc', G_XM, G_YM, 0.36, G_PI * 0.5, G_PI], // 16  left bowl
  ['arc', G_XM, G_YM, 0.15, 0.0, G_PI * 2], // 17  the counter — a closed eye
  ['seg', G_XL, G_YT, -0.1, 0.28], //  18  NW barb — a flag off the head
  ['seg', G_XR, G_YB, 0.1, -0.28], //  19  SE barb — the same, upside down
  ['seg', G_XM, G_YM, G_XR, G_YM], //  20  right arm — half a waist bar
  ['seg', G_XL, G_YT, G_XM, G_YT], //  21  left ear — half a head bar
  ['arc', G_XM, 0.3, 0.12, 0.0, G_PI * 2], //  22  upper counter, off the waist
  ['arc', G_XM, -0.3, 0.12, 0.0, G_PI * 2] //  23  lower counter
];

/**
 * Twenty-four marks, each a set of skeleton strokes.
 *
 * Sixteen was plenty while the only consumer was a two-ring decoration. It is
 * not plenty for a seal that is meant to be **paused and stared at**: three
 * rings of a five-metre seal carry roughly sixty slots, and with sixteen marks
 * a slow orbit of the camera walks you past the same letterform four or five
 * times. At twenty-four the eye reads "a script it does not know" rather than
 * "a pattern repeating", which is the whole job.
 *
 * Every one has at least one terminal and most have a counter, because a
 * stroke-only alphabet with no enclosed space reads as scaffolding rather than
 * as writing. The rule when adding one: it must differ from every mark below by
 * more than a reflection — a mirrored twin is the one kind of near-duplicate the
 * eye catches instantly, because the rings counter-rotate and eventually show
 * you both at once.
 */
const GLYPH_ALPHABET = [
  [0, 1, 4, 5], //  0  upright with head and waist bars
  [0, 1, 15], //  1  thorn — upright with a right bowl
  [7, 8, 4, 11, 12], //  2  dagger — stem, head bar, two legs
  [5, 17], //  3  a counter struck through the waist
  [13, 14, 17], //  4  the eye — two bowls closed round a counter
  [5, 9, 12], //  5  the fold
  [0, 1, 2, 3, 4], //  6  the gate
  [9, 10, 11, 12, 17], //  7  saltire with a counter
  [6, 7, 16], //  8  the sickle
  [4, 9, 12], //  9  tri-branch
  [5, 15, 16], // 10  closed ring, struck
  [2, 3, 16], // 11  mirrored thorn
  [0, 1, 4, 6], // 12  the bracket
  [6, 8, 13], // 13  the anvil
  [7, 8, 9, 10], // 14  the crown
  [4, 5, 11, 12], // 15  the anchor
  [0, 1, 20, 22], // 16  the flag — upright, right arm, counter above the waist
  [7, 8, 21, 19], // 17  the pennant — full stem, left ear, barbed foot
  [2, 3, 4, 18], // 18  the hook — right upright under a barbed head
  [5, 22, 23], // 19  the abacus — a bar strung with two counters
  [13, 14, 8], // 20  the spindle — two bowls on a lower stem
  [0, 1, 12, 23], // 21  the kick — upright, one leg, counter below
  [4, 6, 7, 8], // 22  the pillar — a full stem between head and foot
  [16, 20, 6] // 23  the ladle — left bowl, right arm, foot bar
];

const GLYPH_COUNT = GLYPH_ALPHABET.length;

/** A stroke set as a bit field. 18 bits — exact in a highp float, see below. */
const GLYPH_CODES = GLYPH_ALPHABET.map((strokes) =>
  strokes.reduce((code, index) => code + Math.pow(2, index), 0)
);

/** GLSL float literal — `0` must come out as `0.0` or the compiler rejects it. */
const f = (n) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

/** `code = CODES[index]`, without an array and without a dynamic index. */
const GLYPH_CODE_SELECT = GLYPH_CODES.map(
  (code, i) => `    code += ${f(code)} * step(abs(index - ${f(i)}), 0.5);`
).join('\n');

/** How many strokes this glyph has — the denominator of the inking clock. */
const GLYPH_COUNT_PASS = GLYPH_STROKES.map(
  (_, i) => `    count += gfBit(code, ${f(i)});`
).join('\n');

/**
 * The alphabet, unrolled.
 *
 * `order` counts only the strokes this glyph actually has, so the nib spends
 * the same time on every stroke of a three-stroke mark as on every stroke of a
 * five-stroke one; the inking is even, and the glyphs finish together.
 */
const GLYPH_DRAW_PASS = GLYPH_STROKES.map((s, i) => {
  const head = `    on = gfBit(code, ${f(i)});
    if (on > 0.5) {
      part = clamp(draw * count - order, 0.0, 1.0);
      order += 1.0;`;
  const body =
    s[0] === 'seg'
      ? `      if (part > 0.002) gfSeg(g, vec2(${f(s[1])}, ${f(s[2])}),
          mix(vec2(${f(s[1])}, ${f(s[2])}), vec2(${f(s[3])}, ${f(s[4])}), part), w, sd, grad);`
      : `      if (part > 0.002) gfArc(g, vec2(${f(s[1])}, ${f(s[2])}), ${f(s[3])},
          ${f(s[4])}, ${f(s[5])} * part, w, sd, grad);`;
  return `${head}\n${body}\n    }`;
}).join('\n');

/* ---------------------------------------------------------------------- */
/* The shaders                                                             */
/* ---------------------------------------------------------------------- */

/**
 * Nothing but a frame change.
 *
 * The key direction and the view vector are rotated into the quad's own frame
 * here, once per vertex, because the quad carries the caster's yaw: a world
 * direction used straight in the fragment stage would light every mark from a
 * different side of the room as the anchor turns. `GroundDecals` negates the Z
 * component and this does not — that file's `c.y` runs along local **-Z**,
 * while `p.y` below runs along local **+Z** so that "downrange" and "the aim
 * heading" are the same axis as in the two indicators. Get that sign wrong and
 * the relief lights from behind, which looks almost right and is maddening.
 */
const GROUND_VERTEX = /* glsl */ `
  uniform vec3 uLightDir;      // world space, toward the sun

  ${disruptGLSL}

  varying float vDisrupt;      // spellbreak's field — see vfx/SceneHooks.js
  varying vec2  vUv;
  varying vec3  vLight;        // key direction, in the quad's frame
  varying vec3  vView;         // fragment → camera, in the quad's frame
  varying float vViewZ;

  void main() {
    vUv = uv;

    vec4 world = modelMatrix * vec4(position, 1.0);

    vec3 ax = normalize(modelMatrix[0].xyz);
    vec3 ay = normalize(modelMatrix[1].xyz);
    vec3 az = normalize(modelMatrix[2].xyz);

    vLight = normalize(vec3(dot(uLightDir, ax), dot(uLightDir, ay), dot(uLightDir, az)));

    vec3 toCamera = cameraPosition - world.xyz;
    vView = normalize(vec3(dot(toCamera, ax), dot(toCamera, ay), dot(toCamera, az)));

    // Opt-in to the disruption field. Four vertices per quad, so this is the
    // cheapest opt-in in the library: one distance, four times, per mark.
    vDisrupt = disruptAt(world.xyz);

    vec4 mv = viewMatrix * world;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const GROUND_FRAGMENT = /* glsl */ `
  ${disruptGLSL}
  varying float vDisrupt;

  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  #define GF_PLATE   0
  #define GF_RUNE    1
  #define GF_POCK    2
  #define GF_RUT     3
  #define GF_WET     4
  #define GF_PUSTULE 5
  #define GF_FUNNEL  6
  #define GF_SCOUR   7
  #define GF_LATTICE 8
  #define GF_POOL    9

  uniform float uTime;

  /* ---- the anchor and its footprint ---- */
  uniform vec2  uQuadSize;     // metres the quad covers: x across, y downrange
  uniform float uRadius;       // the mark's radius, metres — live, never captured
  uniform float uLength;       // RUT: length of the track, metres
  uniform float uSeed;

  /* ---- the growth front ---- */
  uniform float uGrow;         // 0..1 how far the front has reached
  uniform float uRecede;       // 0..1 how far the *outside* has been eaten back
  uniform float uEdge;         // metres of feather on that front
  uniform float uRagged;       // fraction of the radius the front wanders by
  uniform float uRaggedScale;  // lobes per metre
  uniform float uWarp;         // metres of domain warp on the lobes

  /* ---- how the fake relief is lit ---- */
  uniform float uRelief;       // how hard the height field tilts the normal
  uniform float uNormalStep;   // metres between the height taps
  uniform float uAmbient;      // 0..1 floor on the diffuse term
  uniform float uWrap;         // 0..1 wraps the terminator round the back
  uniform float uSpecular;
  uniform float uGloss;        // Blinn exponent
  uniform float uParallax;     // metres of view-driven offset on interior detail

  /* ---- the shared shape vocabulary (per-mode meaning in GroundField.js) ---- */
  uniform float uCell;         // metres — plate / blister / hex / groove pitch
  uniform float uCellJitter;   // 0..1 lattice disorder
  uniform float uSeam;         // metres — gap or blend width between cells
  uniform float uThickness;    // metres — sheet, trace, rim, meniscus
  uniform float uLift;         // metres — how far the substance stands proud
  uniform float uDepth;        // metres — how far it goes down
  uniform float uWidth;        // metres — track / groove half-width
  uniform float uSharp;        // 0..1 profile hardness
  uniform float uDetail;       // 0..1 fine grain
  uniform float uSwirl;        // rotational shear / lateral wander
  uniform float uArms;         // count — scour arms
  uniform float uSpeed;        // events or radians per second
  uniform float uFlow;         // metres per second of surface drift
  uniform vec2  uWind;         // unit, in the quad's frame: downwind / flow

  /* ---- output ---- */
  uniform float uFade;
  uniform float uOpacity;
  uniform float uEmissive;
  uniform float uDepthFade;    // metres
  uniform vec3  uColorBase;
  uniform vec3  uColorEdge;
  uniform vec3  uColorGlow;
  uniform vec3  uColorDeep;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  #if GF_MODE == GF_RUNE
    uniform float uRings;        // how many nested rings, 1..4
    uniform float uRingInner;    // innermost ring, as a fraction of the radius
    uniform float uGlyphSize;    // metres, em box height — a real measurement
    uniform float uGlyphStroke;  // metres, half-width of a stroke
    uniform float uGlyphGap;     // slot pitch, in glyph widths
    uniform float uSpin;         // radians/second, ring 0
    uniform float uSpinFalloff;  // how much slower each ring out turns
    uniform float uRule;         // metres, half-width of the compass circles
    uniform float uInscribe;     // 0..1 how much of the seal has been inked
    uniform float uIgnite;       // 0..1 ignition front, inner ring first
    uniform float uScorch;       // 0..1 how far the seal has burnt down to a scar

    /* ---- the armature: chords struck across the seal, and a tick collar ---- */
    uniform float uArmStart;     // 0..1 point in the inscription the armature begins
    uniform float uArmRadius;    // armature circle, as a fraction of uRadius
    uniform float uArmSides;     // how many chords are struck around it
    uniform float uArmTangent;   // apothem as a fraction of the armature radius
    uniform float uArmStroke;    // metres, half-width of an armature line
    uniform float uArmPhase;     // radians, where the first chord starts
    uniform float uArmSpin;      // radians/second the armature turns
    uniform float uTickCount;    // ticks in the collar
    uniform float uTickRadius;   // collar radius, as a fraction of uRadius
    uniform float uTickLength;   // metres, a minor tick
    uniform float uTickStroke;   // metres, half-width of a tick
    uniform float uTickMajor;    // every Nth tick is a long one
    uniform float uTickMajorLen; // metres of extra length on a major tick

    /* ---- the central sigil: larger than anything else, and drawn last ---- */
    uniform float uSigilStart;   // 0..1 point in the inscription the sigil begins
    uniform float uSigilRadius;  // metres, how far the rosette glyph sits out
    uniform float uSigilSize;    // metres, its em box — deliberately not uGlyphSize
    uniform float uSigilArms;    // rotational symmetry of the rosette
    uniform float uSigilStroke;  // metres, half-width of a sigil stroke
    uniform float uSigilRing;    // metres, the circle enclosing the sigil
    uniform float uSigilSpin;    // radians/second the sigil turns
  #endif

  #if GF_MODE == GF_POCK || GF_MODE == GF_RUT
    /**
     * Up to GF_MARKS events: xy is a **unitless** position (fractions of the
     * radius, in the anchor's frame), z is the timestamp it fired at and w
     * is its strength. Nothing here carries a metre, so the marks re-place
     * themselves when the radius slider moves — which is the point.
     */
    uniform vec4  uMarks[GF_MARKS];
    uniform float uMarkCount;
    uniform float uMarkLife;     // seconds a mark takes to weather away
    uniform float uMarkRadius;   // metres, radius of a full-strength mark
  #endif

  #if GF_MODE == GF_RUT
    uniform float uProgress;     // 0..1 how far the body has rolled
  #endif

  varying vec2  vUv;
  varying vec3  vLight;
  varying vec3  vView;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  /* ------------------------------------------------------------------ */
  /* Shared field helpers                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Voronoi that also reports how far it is to the *wall* of the cell.
   *
   * noise.glsl.js#voronoi2 returns F1 and an id, which is enough to stipple
   * with and not enough to build plates out of: a plate needs its own outline,
   * and the outline is where two sites are equidistant. Half the F1/F2 gap is
   * the standard cheap estimate of that — not exact near a corner, and nobody
   * has ever noticed on a sheet of ice.
   */
  float gfCells(vec2 p, float jitter, out float wall, out vec2 site, out float id) {
    vec2 n = floor(p);
    vec2 f = fract(p);
    float d1 = 8.0;
    float d2 = 8.0;
    site = n;
    id = 0.0;

    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 o = mix(vec2(0.5), hash21(dot(n + g, vec2(7.13, 113.17))), jitter);
        vec2 r = g + o - f;
        float d = dot(r, r);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          site = n + g + o;
          id = hash11(dot(n + g, vec2(31.7, 57.1)));
        } else if (d < d2) {
          d2 = d;
        }
      }
    }

    d1 = sqrt(d1);
    wall = (sqrt(d2) - d1) * 0.5;
    return d1;
  }

  /**
   * Hex lattice. xy is the offset from the nearest cell centre, zw is that
   * centre, both in cell units (circumradius 1). Two interleaved rectangular
   * lattices, nearest wins — the honeycomb falls out of the pair.
   */
  vec4 gfHex(vec2 p) {
    const vec2 s = vec2(1.7320508, 3.0);
    const vec2 h = vec2(0.8660254, 1.5);
    vec2 ca = (floor(p / s) + 0.5) * s;
    vec2 cb = (floor((p - h) / s) + 0.5) * s + h;
    vec2 a = p - ca;
    vec2 b = p - cb;
    return dot(a, a) < dot(b, b) ? vec4(a, ca) : vec4(b, cb);
  }

  /** Hex radial distance: 0 at the centre, 0.8660254 on every one of the six flats. */
  float gfHexRadius(vec2 p) {
    p = abs(p);
    return max(p.x, dot(p, vec2(0.5, 0.8660254)));
  }

  /**
   * The growth front, folded into the distance so every mode compares one
   * number against one front.
   *
   * The wander is sampled **in the plane** and domain warped. Sampled on
   * atan(y, x) it would hand every radius along a bearing the same value and
   * the front would open as a star with dead-straight arms — a firework, not a
   * spreading substance. The bolt's ground burn made that mistake, the snare's
   * field inherited the fix, and it is written down here so the next forty
   * abilities inherit it too.
   *
   * The wander scales with uRadius, so a 2 m mark and an 8 m mark are ragged
   * by the same *proportion* and both stay recognisable when the slider moves.
   */
  float gfReach(vec2 q, float d) {
    vec2 w = vec2(
      fbm3(vec3(q * uRaggedScale * 0.5, uSeed)),
      fbm3(vec3(q * uRaggedScale * 0.5, uSeed + 5.7))
    ) * uWarp;
    float lobes = fbm3(vec3((q + w) * uRaggedScale, uSeed + 13.0));
    return d - lobes * uRagged * uRadius;
  }

  /* ------------------------------------------------------------------ */
  /* PLATE — sheet ice                                                   */
  /* ------------------------------------------------------------------ */
  #if GF_MODE == GF_PLATE

  /**
   * Metres of relief for a raft of interlocking plates.
   *
   * The plate is a *sheet*: a couple of centimetres of body everywhere, cut
   * along the cell walls, plus a curl that rises toward whichever wall is
   * downwind. Hinging the lift on the wind rather than on the cell id is what
   * makes a field of these read as one event — paper curling off a hot pan,
   * all of it peeling the same way — instead of as scattered debris.
   */
  float gfHeight(vec2 q) {
    float wall;
    vec2 site;
    float id;
    gfCells(q / max(uCell, 0.02), uCellJitter, wall, site, id);

    float wallM = wall * uCell;                       // metres to the plate edge
    float along = dot(q - site * uCell, uWind);       // metres downwind of the centre

    float body = uThickness * smoothstep(0.0, max(uSeam, 0.001), wallM);
    float downwind = smoothstep(-uCell * 0.15, uCell * 0.75, along);
    float lipness = 1.0 - smoothstep(0.0, max(uCell * 0.45, 0.01), wallM);
    float curl = uLift * downwind * lipness * lipness * (0.55 + 0.9 * id);

    // Frozen spray settles in the seams and roughens the top face.
    float grain = snoise(vec3(q * 6.0, uSeed)) * uDetail * uThickness * 0.6;
    return body + curl * smoothstep(0.0, max(uSeam * 0.4, 0.001), wallM) + grain;
  }

  #endif

  /* ------------------------------------------------------------------ */
  /* RUNE — the alphabet                                                 */
  /* ------------------------------------------------------------------ */
  #if GF_MODE == GF_RUNE

  /**
   * Bit i of a stroke set. Codes run to 2^18, which a highp float holds
   * exactly (integers are exact to 2^24); three compiles fragment shaders at
   * highp by default and this is the one thing in the file that depends on it.
   */
  float gfBit(float code, float i) {
    return mod(floor(code / exp2(i)), 2.0);
  }

  /**
   * One stroke of the nib, accumulated into sd — and into grad, the unit
   * direction *away* from the nearest point on the winning stroke.
   *
   * That gradient is the trick that makes the seal cheap. Every other mode
   * pays three evaluations of its height field for a normal; a signed distance
   * field already knows which way is out, so the incision can be bevelled and
   * lit off one evaluation. Three taps through eighteen strokes and four rings
   * would have been the most expensive fragment in the project.
   *
   * The width swells toward the middle of the stroke and tapers into its ends,
   * which is what gives the letterforms terminals instead of sawn-off tubes.
   */
  void gfSeg(vec2 p, vec2 a, vec2 b, float w, inout float sd, inout vec2 grad) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-7), 0.0, 1.0);
    vec2 r = pa - ba * h;
    float len = length(r);
    float d = len - w * (0.62 + 0.38 * sqrt(max(sin(h * PI), 0.0)));
    if (d < sd) {
      sd = d;
      grad = len > 1e-5 ? r / len : vec2(0.0, 1.0);
    }
  }

  /** The same, on an arc — bowls and counters. span is already scaled by the ink. */
  void gfArc(vec2 p, vec2 c, float r, float a0, float span, float w, inout float sd, inout vec2 grad) {
    vec2 q = p - c;
    float a = atan(q.y, q.x);
    float rel = mod(a - a0 + TAU * 2.0, TAU);
    float len = length(q);

    float d;
    vec2 dir;
    if (rel <= span) {
      dir = len > 1e-5 ? q / len : vec2(1.0, 0.0);
      float side = len - r;
      d = abs(side) - w;
      dir *= sign(side + 1e-6);
    } else {
      // Outside the wedge the nearest point is a terminal, so the arc gets the
      // same round cap a segment does and the two kinds of stroke join cleanly.
      vec2 e0 = c + vec2(cos(a0), sin(a0)) * r;
      vec2 e1 = c + vec2(cos(a0 + span), sin(a0 + span)) * r;
      vec2 r0 = p - e0;
      vec2 r1 = p - e1;
      vec2 rn = dot(r0, r0) < dot(r1, r1) ? r0 : r1;
      float ln = length(rn);
      d = ln - w;
      dir = ln > 1e-5 ? rn / ln : vec2(0.0, 1.0);
    }

    if (d < sd) {
      sd = d;
      grad = dir;
    }
  }

  /**
   * One glyph, in its own em box, inked to draw.
   *
   * code selects the stroke set; the strokes are unrolled from
   * GLYPH_STROKES at module load — see the note there for why the obvious
   * table lookup is not portable.
   */
  float gfGlyph(vec2 g, float index, float draw, float w, out vec2 grad) {
    float code = 0.0;
${GLYPH_CODE_SELECT}

    float count = 0.0;
${GLYPH_COUNT_PASS}
    count = max(count, 1.0);

    float sd = 1e4;
    float order = 0.0;
    float on = 0.0;
    float part = 0.0;
    grad = vec2(0.0, 1.0);

${GLYPH_DRAW_PASS}

    return sd;
  }

  #endif

  /* ------------------------------------------------------------------ */
  /* POCK — craters                                                      */
  /* ------------------------------------------------------------------ */
  #if GF_MODE == GF_POCK

  /**
   * Craters, accumulated.
   *
   * Depth combines with min and rims with +: two hits landing on the same
   * spot dig one hole and pile two lips, which is what happens. Summing the
   * bowls instead would punch a well twice as deep as the ordnance.
   *
   * The gate is the snare's octave trick — a step per slot rather than a
   * break, because a fixed trip count is what every compiler agrees on and
   * an unused slot costs one multiply.
   */
  float gfHeight(vec2 q) {
    float h = 0.0;
    float rims = 0.0;

    for (int i = 0; i < GF_MARKS; i++) {
      float on = step(float(i), uMarkCount - 1.0);
      vec4 m = uMarks[i];

      vec2 c = m.xy * uRadius;                        // unitless → metres, live
      float age = max(uTime - m.z, 0.0);
      float dig = 1.0 - exp(-age * max(uSpeed, 0.1)); // the crater digs itself in
      float weather = 1.0 - smoothstep(uMarkLife * 0.4, uMarkLife, age);

      float rad = max(uMarkRadius * (0.35 + 0.65 * m.w) * dig, 0.02);
      float r = length(q - c) / rad;

      float bowl = -uDepth * m.w * max(0.0, 1.0 - r * r) * weather;
      float lip = (r - 1.0) / max(uThickness / rad, 1e-3);
      float rim = uLift * m.w * exp(-lip * lip) * weather;

      h = mix(h, min(h, bowl), on);
      rims += on * rim;
    }

    float grain = snoise(vec3(q * (2.0 + uDetail * 8.0), uSeed)) * uDetail * uThickness * 0.5;
    return h + rims + grain;
  }

  /** Union coverage of every crater, 0..1 — the mask the colour rides on. */
  float gfPockCover(vec2 q) {
    float cover = 0.0;
    for (int i = 0; i < GF_MARKS; i++) {
      float on = step(float(i), uMarkCount - 1.0);
      vec4 m = uMarks[i];
      float age = max(uTime - m.z, 0.0);
      float dig = 1.0 - exp(-age * max(uSpeed, 0.1));
      float rad = max(uMarkRadius * (0.35 + 0.65 * m.w) * dig, 0.02);
      float r = length(q - m.xy * uRadius) / rad;
      float weather = 1.0 - smoothstep(uMarkLife * 0.5, uMarkLife, age);
      cover = max(cover, on * smoothstep(1.25, 0.85, r) * weather);
    }
    return cover;
  }

  /** How hot the freshest crater under this fragment still is, 0..1. */
  float gfPockHeat(vec2 q) {
    float heat = 0.0;
    for (int i = 0; i < GF_MARKS; i++) {
      float on = step(float(i), uMarkCount - 1.0);
      vec4 m = uMarks[i];
      float age = max(uTime - m.z, 0.0);
      float rad = max(uMarkRadius * (0.35 + 0.65 * m.w), 0.02);
      float r = length(q - m.xy * uRadius) / rad;
      heat = max(heat, on * smoothstep(1.0, 0.2, r) * exp(-age * max(uSpeed, 0.1) * 0.6));
    }
    return heat;
  }

  #endif

  /* ------------------------------------------------------------------ */
  /* RUT — the gouged track                                              */
  /* ------------------------------------------------------------------ */
  #if GF_MODE == GF_RUT

  /**
   * Where the track is, laterally, s fractions down it.
   *
   * A sine would be a slalom. This is one axis of a noise field sampled along
   * the track in metres, so the body drifts the way a heavy thing rolling over
   * uneven ground drifts — and it stays put when the length slider moves,
   * because the lookup is in metres rather than in fractions.
   */
  float gfTrack(float s) {
    return fbm3(vec3(17.0, s * uLength * max(uRaggedScale, 0.01) * 0.35, uSeed)) * uSwirl;
  }

  /**
   * Contact force at s, interpolated from the samples the ability posted.
   *
   * With no samples at all it returns 1 — a rut of constant depth — so an
   * ability can use this mode without bothering to weigh its own boulder.
   */
  float gfForce(float s) {
    float acc = 0.0;
    float wsum = 0.0;
    for (int i = 0; i < GF_MARKS; i++) {
      float on = step(float(i), uMarkCount - 1.0);
      vec4 m = uMarks[i];
      float dz = (s - m.y) * uLength / max(uSeam, 0.05);
      float k = on * exp(-dz * dz);
      acc += k * m.w;
      wsum += k;
    }
    return wsum > 1e-4 ? acc / wsum : 1.0;
  }

  /** Metres of relief: a gouge, two spoil ridges, and the body's own chatter. */
  float gfHeight(vec2 q) {
    float s = clamp((q.y + uLength * 0.5) / max(uLength, 0.01), 0.0, 1.0);
    float off = abs(q.x - gfTrack(s));
    float force = gfForce(s);

    float floorProfile = smoothstep(uWidth, uWidth * mix(0.9, 0.1, uSharp), off);
    float gouge = -uDepth * force * floorProfile;

    // The body is round, so it prints its own circumference into the soft floor.
    float chatter = 0.5 + 0.5 * sin(s * uLength / max(uCell, 0.05) * TAU);
    gouge *= 1.0 - uDetail * 0.35 * chatter;

    float sp = (off - uWidth) / max(uThickness, 0.02);
    float spoil = uLift * force * exp(-sp * sp) * (0.7 + 0.6 * snoise01(vec3(q * 3.0, uSeed)));

    float behind = smoothstep(uProgress + 0.01, uProgress - 0.01, s);
    return (gouge + spoil) * behind;
  }

  #endif

  /* ------------------------------------------------------------------ */
  /* WET — soaked stone                                                  */
  /* ------------------------------------------------------------------ */
  #if GF_MODE == GF_WET

  /**
   * Almost flat. What relief there is exists to bend the specular: standing
   * water fills the low spots, so the puddles are where the sheen is, and a
   * millimetre of height difference is enough to sell it.
   */
  float gfHeight(vec2 q) {
    float pool = fbm3(vec3(q * max(uCell, 0.05), uSeed)) * 0.5 + 0.5;
    float ripple = snoise(vec3((q - uWind * uFlow * uTime) * 9.0, uTime * uSpeed * 0.2));
    return -uDepth * pool + uLift * ripple * uDetail;
  }

  #endif

  /* ------------------------------------------------------------------ */
  /* PUSTULE — blisters                                                  */
  /* ------------------------------------------------------------------ */
  #if GF_MODE == GF_PUSTULE

  /** Where a cell is in its own cycle: 0 flat, ~0.8 taut, then it goes. */
  float gfPhase(float id) {
    return fract(uTime * uSpeed * (0.55 + 0.9 * id) + id * 7.13 + uSeed);
  }

  /**
   * A dome that inflates and a crater that replaces it.
   *
   * Each cell runs its own clock off its own id hash, which is the entire
   * effect: a field on one clock pulses like a heartbeat and reads as a
   * material property, a field on N clocks has *events* in it and reads as
   * something alive. The collapse is four times faster than the swell, because
   * a blister does not deflate, it bursts.
   */
  float gfHeight(vec2 q) {
    float wall;
    vec2 site;
    float id;
    float f1 = gfCells(q / max(uCell, 0.02), uCellJitter, wall, site, id);

    float phase = gfPhase(id);
    float inflate = smoothstep(0.0, 0.72, phase);
    float burst = smoothstep(0.76, 0.84, phase);

    float profile = max(0.0, 1.0 - f1 * f1 / 0.36);
    float dome = uLift * (0.35 + 0.75 * id) * inflate * (1.0 - burst) * sqrt(profile);
    float crater = uDepth * burst * (1.0 - smoothstep(0.0, 0.5, f1)) * (1.0 - smoothstep(0.9, 1.0, phase));

    float skin = snoise(vec3(q * 5.0, uSeed)) * uDetail * uLift * 0.25;
    return dome - crater + skin * smoothstep(0.0, max(uSeam, 0.001), wall * uCell);
  }

  #endif

  /* ------------------------------------------------------------------ */
  /* FUNNEL — the sinkhole                                               */
  /* ------------------------------------------------------------------ */
  #if GF_MODE == GF_FUNNEL

  /**
   * An inverted cone, with the lip calved into blocks.
   *
   * There is no hole in the floor and there never will be — the floor is one
   * opaque plane. What sells the depth is that the wall normal swings a long
   * way between the near and far rims, so one side of the pit is lit and the
   * other is in shadow, and the eye reads a shaded interior as a volume. The
   * parallax offset in main does the rest: the wall detail slides against the
   * lip as the camera orbits, which is the only cue a flat quad cannot fake by
   * shading alone.
   */
  float gfHeight(vec2 q) {
    float d = length(q);
    float t = clamp(d / max(uRadius, 0.05), 0.0, 1.0);

    float wall = pow(1.0 - t, mix(0.7, 3.5, uSharp));
    float h = -uDepth * wall;

    // The lip does not break on a circle: it calves into blocks that tilt in.
    float cellWall;
    vec2 site;
    float id;
    gfCells(q / max(uCell, 0.02), uCellJitter, cellWall, site, id);
    float lipBand = smoothstep(uRadius * 1.15, uRadius * 0.82, d) * smoothstep(uRadius * 0.55, uRadius * 0.9, d);
    h -= uThickness * lipBand * id * smoothstep(0.0, max(uSeam, 0.001), cellWall * uCell);

    // Spoil slumped over the rim, and a scree grain on the walls.
    float outside = smoothstep(uRadius, uRadius * 1.25, d) * (1.0 - smoothstep(uRadius * 1.3, uRadius * 1.7, d));
    h += uLift * outside * (0.5 + 0.9 * id);
    h += snoise(vec3(q * 3.5, uSeed)) * uDetail * uDepth * 0.06 * (1.0 - t);
    return h;
  }

  #endif

  /* ------------------------------------------------------------------ */
  /* SCOUR — what a vortex leaves                                        */
  /* ------------------------------------------------------------------ */
  #if GF_MODE == GF_SCOUR

  /**
   * Log-spiral grooves.
   *
   * This is the one place in the file where sampling on atan(y, x) is right:
   * the marks *are* rotational, a vortex cuts them by turning, and a spiral is
   * an angular function of the radius by definition. It is still domain warped
   * in the plane, because a mathematically exact spiral reads as a logo. The
   * growth front above stays plane-sampled regardless — the front is not
   * rotational and never was.
   *
   * uArms must be a whole number or the phase tears along the ±π seam; the
   * CPU side rounds it.
   */
  float gfHeight(vec2 q) {
    float d = max(length(q), 1e-3);
    vec2 w = vec2(fbm3(vec3(q * 0.6, uSeed)), fbm3(vec3(q * 0.6, uSeed + 3.3))) * uWarp;
    vec2 qw = q + w;

    float a = atan(qw.y, qw.x);
    // fract() before the cosine, and it is not tidiness — it is the fix for a
    // bug that blacked out the entire frame. uTime is the app's elapsed seconds
    // and grows without bound, so after a few minutes this phase was in the
    // thousands and cos(phase * TAU) was being asked for the cosine of ~10^4
    // radians. A float32 cosine that far out has lost most of its mantissa to
    // argument reduction and can return fractionally *outside* [-1, 1] — at
    // which point 0.5 + 0.5 * cos() goes microscopically negative, pow() of a
    // negative base is NaN by definition, the NaN lands in the HDR buffer, and
    // the very next bloom blur smears it across every pixel on screen. One
    // fragment, one whole black frame.
    //
    // cos(phase * TAU) has period 1 in phase, so folding it is *exact* rather
    // than an approximation, and it keeps the argument inside a couple of
    // radians for as long as the app is open.
    float phase = a / TAU * max(uArms, 1.0)
                + log(max(length(qw), 1e-3) / max(uRadius, 0.05)) * uSwirl
                + uTime * uSpeed;
    phase = fract(phase);

    // The max() is the second half of the same fix, and it stays even with the
    // fold above: any base reaching pow() here must be provably non-negative,
    // because a driver computes pow as exp2(y * log2(x)) and therefore returns
    // NaN for a negative base at *every* exponent — including 1.0, which is
    // why turning the sharpness slider to zero did not mask the fault.
    float groove = 0.5 + 0.5 * cos(phase * TAU);
    groove = pow(max(groove, 0.0), mix(1.0, 9.0, uSharp));

    // Deepest where the throat sat, feathering out to nothing at the skirt.
    float bite = smoothstep(uRadius, uRadius * 0.1, d);
    float h = -uDepth * groove * bite;

    // Between the grooves the scoured dust piles into low ridges.
    h += uLift * (1.0 - groove) * bite * 0.6;
    h += snoise(vec3(q * 7.0, uSeed)) * uDetail * uDepth * 0.08;
    return h;
  }

  #endif

  /* ------------------------------------------------------------------ */
  /* LATTICE — a circuit that grows                                      */
  /* ------------------------------------------------------------------ */
  #if GF_MODE == GF_LATTICE

  /** Distance from the anchor to this cell's centre, jittered per cell. */
  float gfCellFront(vec2 centre, float id) {
    return length(centre) + (id - 0.5) * uCellJitter * uCell * 2.0;
  }

  /** Traces standing proud of the substrate, plus a node at each corner. */
  float gfHeight(vec2 q) {
    vec4 hx = gfHex(q / max(uCell, 0.05));
    float edge = 0.8660254 - gfHexRadius(hx.xy);            // 0 on the wall
    float trace = smoothstep(uThickness / max(uCell, 0.05), 0.0, edge);
    float node = smoothstep(uSeam / max(uCell, 0.05), 0.0, abs(length(hx.xy) - 1.0));
    return uLift * (trace * 0.7 + node * 0.9) - uDepth * (1.0 - trace) * 0.15;
  }

  #endif

  /* ------------------------------------------------------------------ */
  /* POOL — standing liquid                                              */
  /* ------------------------------------------------------------------ */
  #if GF_MODE == GF_POOL

  /**
   * A flat surface with a raised rim.
   *
   * The meniscus is the read. Surface tension pulls the liquid *up* the last
   * few centimetres before the edge, and that lip is where the whole rim of
   * specular comes from; without it a pool is a coloured disc lying on a floor.
   * Everything else is two crossed layers of flow-warped noise, slow enough to
   * be a liquid rather than a shader.
   */
  float gfHeight(vec2 q) {
    float d = length(q);
    vec2 drift = uWind * uFlow * uTime;

    float w1 = snoise(vec3((q - drift) * max(uCell, 0.05), uTime * uSpeed * 0.2));
    float w2 = snoise(vec3((q - drift * 0.6) * max(uCell, 0.05) * 2.3 + 11.0, uTime * uSpeed * 0.31));
    float surface = (w1 * 0.65 + w2 * 0.35) * uLift * uDetail;

    float men = uThickness > 1e-4
      ? smoothstep(uRadius - uThickness, uRadius - uThickness * 0.15, d) * (1.0 - smoothstep(uRadius, uRadius + uEdge, d))
      : 0.0;

    return -uDepth * smoothstep(uRadius, 0.0, d) + surface + uLift * men * 2.0;
  }

  #endif

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  void main() {
    /* ---- uv → metres, measured from the anchor; +y runs downrange ---- */
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float d = length(p);

    // Metres per pixel, near enough. Every antialiasing width below is derived
    // from this one number, and it is taken *before* the first discard: a
    // derivative in divergent control flow is undefined, and the symptom is a
    // sparkling fringe on exactly one GPU vendor.
    float px = fwidth(d) + 1e-4;

    // ...and the same thing measured **in the plane** rather than along the
    // radius. The two are the same number only where the fragment happens to
    // move radially. A glyph stroke runs in any direction it likes, and a
    // stroke that happens to point at the anchor sits where d barely changes
    // at all: antialiasing it on px gave every such stroke a hard, crawling
    // edge while its neighbour two slots round the ring was clean. Taken here,
    // with the same discipline — before the first discard, because a
    // derivative in divergent control flow is undefined.
    vec2 pd = fwidth(p);
    float pxp = max(max(pd.x, pd.y), 1e-5);

    /* ---- the growth front ---- */
    float reach = gfReach(p, d);
    float front = uGrow * (uRadius + uEdge) * (1.0 - uRecede);
    float cover = smoothstep(front, front - max(uEdge, 1e-3), reach);
    float lip = smoothstep(max(uEdge, 1e-3), 0.0, abs(reach - front)) * step(0.002, uGrow);

    #if GF_MODE == GF_RUT
      // The rut's front runs down the track, not out from a centre.
      float sRaw = (p.y + uLength * 0.5) / max(uLength, 0.01);
      float s01 = clamp(sRaw, 0.0, 1.0);
      float lateral = abs(p.x - gfTrack(s01));
      // The quad is longer than the track — it has to hold the spoil and the
      // feather — so the *unclamped* parameter caps both ends. Without this the
      // clamp holds the last value all the way to the quad's edge and the rut
      // ends on a dead-straight line at right angles to itself.
      float cap = uEdge / max(uLength, 0.01);
      float ends = smoothstep(-cap, 0.0, sRaw) * smoothstep(1.0 + cap, 1.0, sRaw);
      cover = ends
            * smoothstep(uProgress + 0.006, uProgress - 0.006, s01)
            * smoothstep(uWidth + uThickness * 2.5, uWidth + uThickness * 0.5, lateral);
      lip = smoothstep(0.05, 0.0, abs(s01 - uProgress)) * step(0.002, uProgress);
    #endif

    if (cover < 0.002 && lip < 0.002) discard;

    /* ---- relief, and the fake normal that makes it a substance ---- */
    float h = 0.0;
    vec3 nrm = vec3(0.0, 1.0, 0.0);

    #if GF_MODE == GF_RUNE
      /* ---- the seal: rings of glyphs, an armature, a tick collar, a sigil ---- */
      float sd = 1e4;                 // metres to the nearest stroke
      vec2 grad = vec2(0.0, 1.0);     // that stroke's own outward gradient
      float rule = 0.0;               // the compass circles
      float ringT = 1.0;              // 0 innermost, 1 outermost
      float inked = 0.0;              // how far through its own inking this stroke is

      float rings = clamp(uRings, 1.0, float(GF_RINGS));
      float band = max(uRadius * (1.0 - uRingInner), 0.001);

      /**
       * The inscription has three movements, and uInscribe is the one clock
       * they share. The rings of glyphs take the first slice, the armature and
       * its collar of ticks the second, the central sigil the last — so the
       * thing you are still watching when the seal finishes is the biggest mark
       * on it. A single clock rather than three is what keeps a slider drag
       * coherent: shortening the inscription shortens all three movements in
       * proportion instead of desynchronising them.
       *
       * A slice of zero length is the off switch, and both starts default to 1.
       * A caller that asks for RUNE and says nothing else therefore gets
       * exactly what this mode drew before the armature and the sigil existed:
       * rings of glyphs, over the whole clock. Growing a shared mode must not
       * redecorate somebody else's floor.
       */
      float armStart = clamp(uArmStart, 0.02, 1.0);
      float sigStart = clamp(uSigilStart, armStart, 1.0);
      float armSpan = sigStart - armStart;
      float sigSpan = 1.0 - sigStart;
      float inkRun = clamp(uInscribe / armStart, 0.0, 1.0);
      float armRun = armSpan > 1e-3 ? clamp((uInscribe - armStart) / armSpan, 0.0, 1.0) : 0.0;
      float sigRun = sigSpan > 1e-3 ? clamp((uInscribe - sigStart) / sigSpan, 0.0, 1.0) : 0.0;

      for (int r = 0; r < GF_RINGS; r++) {
        if (float(r) >= rings) continue;

        float rt = (float(r) + 0.5) / rings;
        float rr = uRadius * uRingInner + band * rt;
        if (abs(d - rr) > uGlyphSize * 0.9 + uRule * 4.0) continue;

        // Counter-rotation: even rings run with the clock, odd against it, and
        // each ring out turns slower. Two rings turning the same way read as
        // one wheel; turning against each other they read as machinery.
        float dir = mod(float(r), 2.0) < 0.5 ? 1.0 : -1.0;
        float spin = uTime * uSpin * dir / (1.0 + float(r) * uSpinFalloff);
        float a = atan(p.y, p.x) - spin;

        // The glyph keeps its size in *metres*, so a bigger seal carries more
        // runes rather than bigger ones — the single most convincing thing
        // about working in metres instead of in UV.
        float n = max(floor(TAU * rr / max(uGlyphSize * uGlyphGap, 0.02)), 3.0);
        float slot = floor(a / TAU * n + 0.5);
        float centre = slot / n * TAU;

        float off = a - centre;
        off -= TAU * floor(off / TAU + 0.5);

        // Glyph frame: x is arc length along the ring, y is radially outward.
        vec2 g = vec2(off * rr, d - rr) / max(uGlyphSize, 0.02);

        float index = floor(hash11(slot * 3.71 + float(r) * 17.31 + uSeed * 41.0) * float(GF_GLYPHS));
        index = clamp(index, 0.0, float(GF_GLYPHS) - 1.0);

        // Inking order: ring by ring outward, glyph by glyph round each ring.
        float k = mod(slot, n);
        float start = (float(r) + k / n) / rings;
        float width = 1.0 / (rings * n);
        float draw = clamp((inkRun - start) / width, 0.0, 1.0);

        vec2 g2;
        float dsd = gfGlyph(g, index, draw, uGlyphStroke / max(uGlyphSize, 0.02), g2) * uGlyphSize;
        if (dsd < sd) {
          sd = dsd;
          // The glyph's gradient comes back in its own em box, where x runs
          // along the ring and y runs outward. Handing that straight to the
          // normal — which the first version did — lights every glyph as if it
          // were sitting at bearing zero, so the incisions on the far side of
          // the seal are shaded from the wrong edge and the ring looks
          // embossed on one side and engraved on the other.
          vec2 rdir = d > 1e-4 ? p / d : vec2(1.0, 0.0);
          grad = vec2(-rdir.y, rdir.x) * g2.x + rdir * g2.y;
          inked = draw;
          ringT = rt;
        }

        // The compass circles bracketing the band, swept round on the same
        // clock. An angular sweep is exactly right here: a compass *is* an
        // angular instrument, and this is the only furniture that draws itself
        // by turning rather than by spreading.
        float progress = clamp((inkRun - float(r) / rings) * rings, 0.0, 1.0);
        float bearing = fract(a / TAU + 0.5);
        float sweep = smoothstep(progress + 0.015, progress - 0.015, bearing);
        float r0 = rr - uGlyphSize * 0.62;
        float r1 = rr + uGlyphSize * 0.62;
        float circles = (1.0 - smoothstep(uRule, uRule + px, abs(d - r0)))
                      + (1.0 - smoothstep(uRule, uRule + px, abs(d - r1)));
        rule = max(rule, min(circles, 1.0) * sweep);
      }

      /* ------------------------------------------------------------------ */
      /* The armature — what a seal has that a wheel of letters does not     */
      /* ------------------------------------------------------------------ */
      /**
       * Chords struck between the rings, each one a straight line whose ends
       * land on the armature circle and which passes at distance apothem from
       * the anchor. That single parameterisation covers both things the eye
       * wants here: at uArmTangent = cos(PI / sides) the chords close into an
       * inscribed polygon, and below that they cross into a star — and at any
       * value they are simultaneously *tangent lines* to the inner circle of
       * that radius, which is the other half of the figure.
       *
       * The obvious cheap implementation folds the bearing into one sector and
       * measures the distance to a single line. That draws the polygon fine and
       * silently truncates the star: a chord that spans three sectors is only
       * the nearest line inside one of them, so a pentagram came out as five
       * disconnected stubs. Hence the fixed seven-candidate sweep, three
       * sectors either side of the nearest.
       *
       * Walking the centre line of every chord and asking whether the field is
       * still negative says where that runs out: at up to twelve chords the
       * seven candidates hold the figure whole down to uArmTangent = 0, and at
       * sixteen they need about 0.2. Above sixteen chords with a low tangency
       * the ends will start to break off — widen the loop, do not widen the
       * stroke.
       */
      float asd = 1e4;
      vec2 agrad = vec2(0.0, 1.0);
      float armR = uRadius * clamp(uArmRadius, 0.02, 1.0);
      float armPhase = uArmPhase + uTime * uArmSpin;

      if (armRun > 0.001 && d < armR + uArmStroke * 6.0) {
        float sides = max(floor(uArmSides + 0.5), 3.0);
        float sector = TAU / sides;
        float apo = armR * clamp(uArmTangent, 0.0, 0.985);
        float halfChord = sqrt(max(armR * armR - apo * apo, 1e-4));
        float aa = atan(p.y, p.x) - armPhase;
        float base = floor(aa / sector + 0.5);

        for (int j = -3; j <= 3; j++) {
          float idx = base + float(j);
          float th = armPhase + idx * sector;
          vec2 nl = vec2(cos(th), sin(th));      // the chord's own normal
          vec2 tl = vec2(-nl.y, nl.x);           // ...and its direction
          vec2 ea = nl * apo - tl * halfChord;
          vec2 eb = nl * apo + tl * halfChord;
          // Struck one at a time, in order round the figure, so the armature
          // is drawn rather than switched on.
          float slotA = mod(idx, sides);
          float partA = clamp(armRun * sides - slotA, 0.0, 1.0);
          if (partA > 0.002) gfSeg(p, ea, mix(ea, eb, partA), uArmStroke, asd, agrad);
        }
      }

      /**
       * The tick collar. Sixty short radial marks with every sixth one long is
       * the difference between "a magic circle" and "an instrument": it says
       * the seal is *divided*, and division is what makes a drawing look like
       * it was measured out rather than decorated.
       *
       * One segment per fragment, because ticks are radial and short enough
       * that the nearest bearing is always the nearest tick — the only place in
       * this branch where the angular fold is exact rather than a compromise.
       */
      float tickR = uRadius * clamp(uTickRadius, 0.02, 1.2);
      float tickOut = uTickLength + uTickMajorLen + uTickStroke * 3.0;
      if (armRun > 0.001 && d > tickR - uTickStroke * 3.0 && d < tickR + tickOut) {
        float ticks = max(floor(uTickCount + 0.5), 4.0);
        float ts = TAU / ticks;
        float ta = atan(p.y, p.x) - armPhase;
        float ti = floor(ta / ts + 0.5);
        float th = armPhase + ti * ts;
        vec2 rdir = vec2(cos(th), sin(th));
        float every = max(floor(uTickMajor + 0.5), 1.0);
        float major = 1.0 - step(0.5, mod(ti, every));
        float len = uTickLength + uTickMajorLen * major;
        float partT = clamp(armRun * ticks - mod(ti, ticks), 0.0, 1.0);
        if (partT > 0.002) {
          gfSeg(p, rdir * tickR, rdir * (tickR + len * partT), uTickStroke, asd, agrad);
        }
      }

      if (asd < sd) {
        sd = asd;
        grad = agrad;
        inked = armRun;
        // The armature is one continuous figure rather than a ring of separate
        // marks, so it takes the ignition front where the fragment actually
        // stands. A chord that ran from an inner ring to an outer one and lit
        // all at once looked like a switch closing, not like fire spreading.
        ringT = clamp(d / max(uRadius, 0.05), 0.0, 1.0);
      }

      /* ------------------------------------------------------------------ */
      /* The central sigil — larger than anything else, and drawn last       */
      /* ------------------------------------------------------------------ */
      /**
       * A rosette: one glyph from the same alphabet, at its own em box, copied
       * uSigilArms times about the anchor and closed inside a ruled circle.
       *
       * The copies are free. Folding the bearing into one sector and evaluating
       * the alphabet **once** gives exact N-fold rotational symmetry; the first
       * version looped the arms and paid for the most expensive function in the
       * file five times over for a picture the fold hands you for nothing.
       */
      float ssd = 1e4;
      vec2 sgrad = vec2(0.0, 1.0);
      float sigReach = uSigilRing + uSigilRadius + uSigilSize * 1.4;

      if (sigRun > 0.001 && d < sigReach) {
        // The frame before the writing, as a scribe would: the enclosing circle
        // is ruled in over the first part of the sigil's slice.
        gfArc(p, vec2(0.0, 0.0), uSigilRing, -PI * 0.5,
              TAU * clamp(sigRun * 2.2, 0.0, 1.0), uSigilStroke, ssd, sgrad);

        float arms = max(floor(uSigilArms + 0.5), 1.0);
        float ss = TAU / arms;
        float sa = atan(p.y, p.x) - uTime * uSigilSpin;
        float mfold = sa - ss * floor(sa / ss + 0.5);
        vec2 q = vec2(cos(mfold), sin(mfold)) * d;

        // Same convention as the rings: x tangential, y radially outward, waist
        // on uSigilRadius — so the rosette reads as the alphabet at a larger
        // size rather than as a different kind of mark.
        vec2 gg = vec2(q.y, q.x - uSigilRadius) / max(uSigilSize, 0.02);
        float sIndex = floor(hash11(uSeed * 41.0 + 7.13) * float(GF_GLYPHS));
        sIndex = clamp(sIndex, 0.0, float(GF_GLYPHS) - 1.0);

        vec2 sg;
        float sDraw = clamp(sigRun * 1.7 - 0.35, 0.0, 1.0);
        float sGlyph = gfGlyph(gg, sIndex, sDraw, uSigilStroke / max(uSigilSize, 0.02), sg)
                     * uSigilSize;
        if (sGlyph < ssd) {
          // Out of the em box, out of the sector, into the plane. Two rotations,
          // and skipping the second is the bug that lights one arm of the
          // rosette correctly and the other four from the wrong side.
          float rot = atan(p.y, p.x) - mfold;
          vec2 gp = vec2(sg.y, sg.x);
          ssd = sGlyph;
          sgrad = vec2(gp.x * cos(rot) - gp.y * sin(rot), gp.x * sin(rot) + gp.y * cos(rot));
        }
      }

      if (ssd < sd) {
        sd = ssd;
        grad = sgrad;
        inked = sigRun;
        // The middle of the seal: whatever else it is, it is the first thing
        // the ignition front reaches.
        ringT = 0.0;
      }

      // The incision, and its normal straight off the SDF's gradient.
      float cut = smoothstep(0.0, -max(uThickness, 0.002), sd);
      h = -uDepth * cut;
      float slope = uDepth / max(uThickness, 0.002) * (1.0 - abs(2.0 * cut - 1.0));
      nrm = normalize(vec3(-grad.x * slope * uRelief, 1.0, -grad.y * slope * uRelief));
    #else
      // Two forward differences. Cheap, one-sided and slightly biased, which
      // costs a fraction of a degree of tilt and saves two evaluations of a
      // field that can be nine voronoi cells deep.
      float e = max(uNormalStep, 0.005);
      h = gfHeight(p);
      float hdx = gfHeight(p + vec2(e, 0.0));
      float hdy = gfHeight(p + vec2(0.0, e));
      nrm = normalize(vec3((h - hdx) / e * uRelief, 1.0, (h - hdy) / e * uRelief));
    #endif

    /* ---- one lighting model for every mode ---- */
    vec3 L = normalize(vLight);
    vec3 V = normalize(vView);
    float lambert = dot(nrm, L);
    // Wrapped, because none of these substances is a Lambertian brick: snow,
    // liquid and churned earth all carry light round the terminator, and a hard
    // cosine on a fake normal reads as embossed metal.
    float diffuse = mix(max(lambert, 0.0), lambert * 0.5 + 0.5, uWrap);
    float shade = uAmbient + (1.0 - uAmbient) * diffuse;
    float spec = pow(max(dot(nrm, normalize(L + V)), 0.0), max(uGloss, 1.0)) * uSpecular;
    float fresnel = pow(1.0 - clamp(dot(nrm, V), 0.0, 1.0), 4.0);

    // View-driven offset for interior detail, in metres. vView is already in
    // the quad's frame, so its horizontal part is (x across, y downrange) —
    // the same axes p uses.
    vec2 parallax = vec2(V.x, V.z) * -h * uParallax;

    vec3 body = uColorBase;
    vec3 emit = vec3(0.0);
    float alpha = 0.0;

    /* ------------------------------------------------------------------ */
    #if GF_MODE == GF_PLATE

      float wall;
      vec2 site;
      float id;
      gfCells(p / max(uCell, 0.02), uCellJitter, wall, site, id);
      float wallM = wall * uCell;
      float along = dot(p - site * uCell, uWind);

      float plate = smoothstep(0.0, max(uSeam, 0.001) + px, wallM);
      float curled = smoothstep(0.0, max(uCell * 0.45, 0.01), wallM);
      float lifted = (1.0 - curled) * smoothstep(-uCell * 0.15, uCell * 0.75, along);

      // Sheet ice is thin enough to see the next plate through, so the body
      // colour is graded by how much ice the ray had to cross rather than by a
      // flat tint: the middle of a plate is deep, the fractured seams are pale.
      float thick = mix(0.25, 1.0, id) * plate;
      body = mix(uColorEdge, uColorDeep, thick * 0.85);
      body = mix(body, uColorBase, shade * 0.7);
      // The lip is the only part that catches the key properly.
      body = mix(body, uColorEdge, lifted * 0.65);
      emit = uColorGlow * (spec * (0.4 + lifted) + lip * 0.6);

      alpha = cover * clamp(plate * (0.55 + 0.45 * thick) + lifted * 0.5, 0.0, 1.0);
      alpha = mix(alpha, alpha * 0.25, smoothstep(0.0, 1.0, uRecede));

    /* ------------------------------------------------------------------ */
    #elif GF_MODE == GF_RUNE

      /**
       * The crisp edge. This is the whole reason the mode exists, so it is
       * worth being exact about how it is got.
       *
       * aastep is the house analytic step: smoothstep across
       * fwidth(value), which resolves an edge in about one pixel *at any
       * zoom*. Feeding it the distance normalised to pixels rather than the
       * distance in metres is what makes that true — a seal that fills the
       * screen and a seal seen from the far corner of the stage then get the
       * same edge, and a paused camera can be walked right up to it.
       *
       * The clamp is not cosmetic and it is not paranoia. The ring loop above
       * skips bands with continue, so two fragments of one 2×2 quad can leave
       * it holding 1e4 and 0.01; fwidth of that is astronomical, aastep
       * spreads its transition over the whole range, and the result is a row of
       * bright grey pixels tracing every band boundary — which is exactly the
       * kind of fault that only shows up when somebody pauses and stares.
       * Bounding the normalised distance to six pixels either side kills it and
       * cannot touch the edge itself, where the distance is by definition
       * within a pixel of zero.
       */
      float sdn = clamp(sd / pxp, -6.0, 6.0);
      float ink = aastep(0.0, -sdn);
      float halo = 1.0 - smoothstep(0.0, max(uThickness, 0.002) * 3.0, sd);

      // Ignition runs outward from the middle: a mark lights when the front
      // passes its own normalised radius. The sigil sits at ringT = 0, so the
      // seal always catches at the centre and the rings go up in order.
      float lit = smoothstep(ringT + 0.18, ringT - 0.18, uIgnite);
      float burning = smoothstep(0.14, 0.0, abs(ringT - uIgnite)) * step(0.002, uIgnite);
      // The stroke currently under the nib burns brightest — a stroke being cut
      // is hot, a stroke already cut is only warm.
      float nib = inked * (1.0 - inked) * 4.0;
      // ...and what is left when the fire has gone through it. The seal does
      // not fade out, it burns down: the ink chars to uColorDeep and stops
      // emitting, and what remains on the floor is a scar in the shape of the
      // writing rather than a rune that got quieter.
      float scar = clamp(uScorch, 0.0, 1.0);

      float wash = cover * smoothstep(uRadius, uRadius * 0.2, d);
      body = mix(uColorDeep, uColorBase, ink * (0.45 + 0.55 * shade));
      body = mix(body, uColorDeep, scar * 0.85 * ink);
      emit = (uColorGlow * (ink * (0.35 + lit * 1.6 + burning * 2.2 + nib * 1.4) + halo * lit * 0.25)
           + uColorEdge * (rule * 1.2 + spec * ink)) * (1.0 - scar);

      alpha = clamp(ink * 0.95 + halo * 0.18 * lit * (1.0 - scar) + rule * 0.9
                  + wash * 0.14 * (1.0 - scar), 0.0, 1.0) * cover;

    /* ------------------------------------------------------------------ */
    #elif GF_MODE == GF_POCK

      float pit = gfPockCover(p + parallax);
      float heat = gfPockHeat(p);
      float rimness = smoothstep(0.0, uLift + 1e-4, h);
      float depthness = smoothstep(0.0, -uDepth * 0.6 - 1e-4, h);

      body = mix(uColorBase, uColorDeep, depthness);
      body = mix(body, uColorEdge, rimness * 0.8);
      body *= shade;
      emit = uColorGlow * heat * (0.6 + depthness) + uColorEdge * spec * 0.4;

      alpha = clamp(pit * (0.7 + 0.3 * rimness), 0.0, 1.0) * cover;

    /* ------------------------------------------------------------------ */
    #elif GF_MODE == GF_RUT

      float force = gfForce(s01);
      float inRut = smoothstep(uWidth, uWidth * 0.35, lateral);
      float ridge = smoothstep(0.0, uLift + 1e-4, h);

      body = mix(uColorBase, uColorDeep, inRut * (0.55 + 0.45 * force));
      body = mix(body, uColorEdge, ridge * 0.7);
      body *= shade;
      // The churn right under the body is still moving, so it is the only part
      // that is lit rather than shaded.
      emit = uColorGlow * lip * (0.5 + force) + uColorEdge * spec * 0.3;

      alpha = clamp(cover * (inRut * (0.55 + 0.45 * force) + ridge * 0.6), 0.0, 1.0);

    /* ------------------------------------------------------------------ */
    #elif GF_MODE == GF_WET

      // Soaked stone is *darker* than dry stone and shinier — which is only
      // expressible with a non-additive blend. This mode is the argument for
      // the option existing.
      float damp = cover;
      float sheen = spec * (0.5 + 0.5 * fresnel);

      body = mix(uColorBase, uColorDeep, damp * (0.7 + 0.3 * shade));
      emit = uColorEdge * sheen + uColorGlow * lip * 0.4;

      // Drying leaves a pale tide mark where the last of it stood.
      float tide = smoothstep(0.0, max(uEdge, 1e-3), abs(reach - front)) ;
      body = mix(uColorGlow, body, clamp(tide + 1.0 - step(0.002, uRecede), 0.0, 1.0));

      alpha = clamp(damp * (0.55 + 0.45 * (1.0 - shade)) + sheen * 0.5, 0.0, 1.0);

    /* ------------------------------------------------------------------ */
    #elif GF_MODE == GF_PUSTULE

      float wall;
      vec2 site;
      float id;
      float f1 = gfCells(p / max(uCell, 0.02), uCellJitter, wall, site, id);
      float phase = gfPhase(id);
      float burst = smoothstep(0.76, 0.84, phase);

      // The splatter thrown out at the moment it goes, travelling in metres.
      float since = max(phase - 0.8, 0.0) / max(uSpeed, 0.01);
      float ringR = since * uFlow;
      float splat = smoothstep(uSeam, 0.0, abs(f1 * uCell - ringR)) * (1.0 - smoothstep(0.0, uCell * 0.9, ringR));

      float taut = smoothstep(0.35, 0.95, phase) * (1.0 - burst);
      body = mix(uColorBase, uColorEdge, taut * smoothstep(0.5, 0.0, f1));
      body = mix(body, uColorDeep, burst * smoothstep(0.55, 0.0, f1));
      body *= shade;
      emit = uColorGlow * (splat * 1.4 + spec * taut) ;

      alpha = clamp(cover * (smoothstep(0.95, 0.25, f1) * (0.6 + 0.4 * taut) + splat), 0.0, 1.0);

    /* ------------------------------------------------------------------ */
    #elif GF_MODE == GF_FUNNEL

      float t = clamp(d / max(uRadius, 0.05), 0.0, 1.0);
      // Detail on the walls is offset by the view, which is the only cue a flat
      // quad has that says "this is below the floor" while the camera orbits.
      float grit = snoise01(vec3((p + parallax) * 4.0, uSeed)) ;
      float depthness = 1.0 - t;

      body = mix(uColorBase, uColorDeep, depthness * depthness);
      body = mix(body, uColorEdge, smoothstep(0.85, 1.0, t) * 0.6);   // the calved lip
      body *= shade * (0.65 + 0.5 * grit * uDetail);
      // The throat is never drawn. It is drawn as *nothing*, at full alpha.
      body = mix(body, uColorDeep * 0.2, smoothstep(0.28, 0.0, t));
      emit = uColorGlow * smoothstep(0.2, 0.0, t) + uColorEdge * spec * 0.5;

      alpha = clamp(cover * smoothstep(1.35, 0.95, t) * (0.75 + 0.25 * depthness), 0.0, 1.0);

    /* ------------------------------------------------------------------ */
    #elif GF_MODE == GF_SCOUR

      float groove = smoothstep(0.0, -uDepth * 0.5 - 1e-4, h);
      float ridge = smoothstep(0.0, uLift * 0.6 + 1e-4, h);
      float bite = smoothstep(uRadius, uRadius * 0.1, d);

      body = mix(uColorBase, uColorDeep, groove);
      body = mix(body, uColorEdge, ridge * 0.7);
      body *= shade;
      emit = uColorGlow * groove * bite * 0.5 + uColorEdge * spec * 0.4;

      alpha = clamp(cover * bite * (0.45 + 0.55 * max(groove, ridge)), 0.0, 1.0);

    /* ------------------------------------------------------------------ */
    #elif GF_MODE == GF_LATTICE

      vec4 hx = gfHex(p / max(uCell, 0.05));
      vec2 centre = hx.zw * max(uCell, 0.05);
      float id = hash11(dot(floor(centre / max(uCell, 0.05) + 0.5), vec2(31.7, 57.1)));
      float edge = 0.8660254 - gfHexRadius(hx.xy);
      float trace = smoothstep((uThickness + px) / max(uCell, 0.05), uThickness / max(uCell, 0.05) * 0.4, edge);
      float node = smoothstep((uSeam + px) / max(uCell, 0.05), 0.0, abs(length(hx.xy) - 1.0)) * trace;

      // The front does not cross the field, it crosses the *lattice*: a cell
      // lights when the front reaches that cell's own centre, so the growth
      // steps from cell to cell along the edges instead of sliding over them.
      float cellFront = gfCellFront(centre, id);
      float lit = smoothstep(cellFront + uCell * 0.9, cellFront - uCell * 0.2, front);
      // Inside a lit cell the trace still fills from the side the charge came
      // in on, which is what stops the whole hex flashing on at once.
      float entry = dot(normalize(hx.xy + 1e-5), normalize(centre + 1e-5));
      lit *= smoothstep(-1.0, 0.4, entry + (front - cellFront) / max(uCell, 0.05));

      // Charge running along the traces, phase keyed to the cell so two
      // neighbours are never in step.
      float run = fract((edge * max(uCell, 0.05) + length(centre)) * 0.5 - uTime * uSpeed + id);
      float pulse = pow(1.0 - run, 6.0);

      body = mix(uColorDeep, uColorBase, trace) * shade;
      emit = uColorGlow * (trace * lit * (0.5 + pulse * 1.5)) + uColorEdge * node * lit * 1.6;

      alpha = clamp(cover * (trace * (0.35 + 0.65 * lit) + node * lit), 0.0, 1.0);

    /* ------------------------------------------------------------------ */
    #else /* GF_POOL */

      float deepness = smoothstep(uRadius, uRadius * 0.15, d);
      float men = smoothstep(uRadius - uThickness, uRadius, d) * step(d, uRadius + uEdge);

      // A liquid is mostly what it reflects at grazing angles and mostly what
      // it absorbs looking straight down, which is one Fresnel term and two
      // colour pickers.
      body = mix(uColorBase, uColorDeep, deepness);
      body = mix(body, uColorEdge, clamp(fresnel * 0.8 + men * 0.5, 0.0, 1.0));
      body *= 0.4 + 0.6 * shade;
      emit = uColorEdge * spec + uColorGlow * deepness * 0.25;

      alpha = clamp(cover * (0.35 + 0.65 * deepness + men * 0.4), 0.0, 1.0);

    #endif

    /* ---- assemble ---- */
    vec3 color = body + emit * uEmissive;
    alpha *= uFade * uOpacity;

    // Soft against anything standing in the mark. The depth prepass is half
    // resolution, so its silhouettes are a pixel or two soft — which is exactly
    // the band worth feathering, and why this is worth doing even with the
    // depth test on. Turn the test off and this term does all the work.
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    // Not 'packed', which is the obvious name and a future-reserved word in
    // GLSL ES: ANGLE rejects it outright, so every mode of this shader would
    // have failed to compile on macOS Chrome. commonGLSL#softFade made the same
    // mistake and renamed to depthBits; VolumeHull.js has the note. This one
    // survived because the reserved-word scanner in scripts/ only audits
    // Distortion and Portal, and nothing had compiled a GroundField in a
    // browser yet.
    float depthBits = unpackRGBAToDepth(texture2D(uSceneDepth, screenUV));
    float sceneViewZ = perspectiveDepthToViewZ(depthBits, uCameraNear, uCameraFar);
    alpha *= smoothstep(-max(uDepthFade, 1e-3), 0.0, vViewZ - sceneViewZ);

    if (alpha < 0.004) discard;
    color *= uGlobalGlow;
    disruptShade(color, alpha, vDisrupt, gl_FragCoord.xy);
    gl_FragColor = vec4(color, alpha);
  }
`;

/* ---------------------------------------------------------------------- */
/* Params                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * Canonical parameter names with their defaults, in the units the field wants.
 *
 * Every one of these is read fresh on every call to `update()`, so a missing
 * field falls back to the value listed here and a params object only carries
 * what the ability actually authors.
 *
 * ### The shared shape vocabulary
 *
 * Ten modes with private names would be four hundred uniforms. Instead there is
 * one vocabulary of measurements and each mode says what it does with them:
 *
 * | param | PLATE | RUNE | POCK | RUT | WET | PUSTULE | FUNNEL | SCOUR | LATTICE | POOL |
 * | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 * | `cell` | plate size | — | grain | chatter pitch | puddle scale | blister size | lip block | — | hex size | ripple scale |
 * | `seam` | gap between plates | — | — | force blend | — | skin gap | block gap | — | node size | — |
 * | `thickness` | sheet | stroke depth | rim width | spoil width | — | — | lip drop | — | trace width | meniscus |
 * | `lift` | curl height | — | rim height | spoil height | ripple | dome height | spoil | ridge | trace height | wave height |
 * | `depth` | — | incision | crater | gouge | puddle | crater | the pit | groove | etch | body depth |
 * | `width` | — | — | — | track half-width | — | — | — | — | — | — |
 * | `swirl` | — | — | — | track wander | — | — | — | spiral pitch | — | — |
 * | `arms` | — | — | — | — | — | — | — | groove count | — | — |
 * | `speed` | — | — | dig rate | — | ripple rate | bursts/s | — | rotation | charge rate | ripple rate |
 * | `flow` | — | — | — | — | drift | splatter speed | — | — | — | drift |
 * | `windAngle` | downwind | — | — | — | drift bearing | — | — | — | — | flow bearing |
 */
export function groundFieldParams() {
  return {
    /* --- where it is (the ability's own vectors; never copied) --- */
    centre: null, // Vector3 on the floor. RUT: the *start* of the track
    yaw: 0, // radians about +Y; local +Z is downrange
    height: 0.02, // metres above the floor the quad sits at
    radius: 4, // metres — the mark's own radius. Re-read every frame
    length: 10, // metres — RUT only, how long the track is

    /* --- the beats (unitless; the ability's clock resolves them) --- */
    grow: 1, // 0..1 the front spreading outward
    recede: 0, // 0..1 the outside being eaten back (drying, sublimating)
    progress: 1, // 0..1 RUT: how far the body has rolled
    inscribe: 1, // 0..1 RUNE: how much of the seal has been inked
    ignite: 0, // 0..1 RUNE: the ignition front, inner ring first
    fade: 1, // 0..1 master fade
    seed: 0, // decorrelates two casts. A dice roll, safe to capture

    /* --- the front --- */
    edge: 0.35, // metres of feather on the front
    ragged: 0.28, // how far it wanders, as a fraction of the radius
    raggedScale: 0.7, // lobes per metre
    warp: 0.5, // metres of domain warp on those lobes

    /* --- relief and lighting --- */
    relief: 0.6, // how hard the height field tilts the fake normal
    normalStep: 0.06, // metres between the height taps
    ambient: 0.32, // floor on the diffuse term
    wrap: 0.45, // 0..1 wraps the terminator round the back
    specular: 0.5,
    gloss: 24, // Blinn exponent
    parallax: 0.35, // metres of view-driven offset on interior detail

    /* --- the shape vocabulary; see the table above --- */
    cell: 0.55, // metres
    cellJitter: 0.85, // 0..1
    seam: 0.05, // metres
    thickness: 0.05, // metres
    lift: 0.12, // metres
    depth: 0.25, // metres
    width: 0.5, // metres
    sharp: 0.5, // 0..1
    detail: 0.6, // 0..1
    swirl: 0.3,
    arms: 5, // whole number; rounded on the way in
    speed: 1.2, // events or radians per second
    flow: 0.35, // metres per second
    windAngle: 0.6, // radians, in the quad's frame

    /* --- RUNE --- */
    rings: 3, // 1..4 nested rings
    ringInner: 0.35, // innermost ring as a fraction of the radius
    glyphSize: 0.55, // metres — the em box, a real measurement
    glyphStroke: 0.045, // metres — half-width of a stroke
    glyphGap: 1.35, // slot pitch, in glyph widths
    spin: 0.12, // radians/second, ring 0
    spinFalloff: 0.6, // how much slower each ring out turns
    rule: 0.012, // metres — half-width of the compass circles
    scorch: 0, // 0..1 how far the seal has burnt down to a scar

    /* --- RUNE: the armature and its tick collar --- */
    armStart: 1, // 0..1 where the rings hand over to the armature. 1 = no armature
    armRadius: 0.66, // armature circle, as a fraction of the radius
    armSides: 7, // chords struck around it
    armTangent: 0.4, // apothem, as a fraction of the armature radius (0 = through the anchor)
    armStroke: 0.02, // metres — half-width of an armature line
    armPhase: 0.35, // radians — where the first chord starts
    armSpin: -0.05, // radians/second the armature turns
    tickCount: 60, // ticks in the collar
    tickRadius: 0.95, // collar radius, as a fraction of the radius
    tickLength: 0.13, // metres — a minor tick
    tickStroke: 0.011, // metres — half-width of a tick
    tickMajor: 6, // every Nth tick is a long one
    tickMajorLen: 0.15, // metres of extra length on a major tick

    /* --- RUNE: the central sigil --- */
    sigilStart: 1, // 0..1 where the armature hands over to the sigil. 1 = no sigil
    sigilRadius: 0.36, // metres — how far the rosette glyph sits from the anchor
    sigilSize: 0.72, // metres — its em box; deliberately larger than glyphSize
    sigilArms: 5, // rotational symmetry of the rosette
    sigilStroke: 0.032, // metres — half-width of a sigil stroke
    sigilRing: 0.92, // metres — the circle enclosing the sigil
    sigilSpin: 0.06, // radians/second the sigil turns

    /* --- POCK / RUT marks --- */
    markLife: 6, // seconds a mark weathers away over
    markRadius: 0.7, // metres, a full-strength mark

    /* --- output --- */
    additive: false, // true adds light, false shades the floor
    emissive: 1, // multiplier on every glowing term
    opacity: 1,
    depthFade: 0.5, // metres of soft fade against standing geometry
    colorBase: '#8a8f96', // the substance itself
    colorEdge: '#dfe8f0', // rims, lips, highlights, sheen
    colorGlow: '#ffd27a', // anything emissive
    colorDeep: '#161a1e', // the interior, the shadow, the hole

    /* --- global multipliers (settings.global.*, 1 = neutral) --- */
    noiseStrength: 1,
    noiseFrequency: 1,
    noiseSpeed: 1,
    opacityScale: 1
  };
}

/* ---------------------------------------------------------------------- */
/* The mesh                                                                */
/* ---------------------------------------------------------------------- */

export class GroundField {
  /**
   * @param {THREE.Object3D} parent the ability's group
   * @param {object} options
   * @param {number} options.mode          GroundMode.* — a `#define`, fixed for the lifetime
   * @param {number} [options.marks=12]    POCK/RUT: how many events the shader carries
   * @param {boolean} [options.additive=false] initial blend; `params.additive` drives it after
   * @param {boolean} [options.depthTest=true] false lets the soft fade do all the occlusion
   * @param {number} [options.layer=LAYER.VFX]
   * @param {number} [options.renderOrder] defaults to 6 shaded / 8 additive, as the decals do
   * @param {string} [options.name]
   */
  constructor(parent, options = {}) {
    const {
      mode = GroundMode.PLATE,
      marks = 12,
      additive = false,
      depthTest = true,
      layer = LAYER.VFX,
      renderOrder = null,
      name = null
    } = options;

    this.parent = parent;
    this.mode = mode;
    this.marks = Math.max(1, Math.round(marks));
    this.geometry = acquireGroundQuad();

    /**
     * The event list, as `(x, z, time, strength)`.
     *
     * `xy` is a fraction of the radius, not a metre — which is the whole reason
     * a crater re-places itself when the radius slider moves. Allocated once
     * here; `mark()` writes into it and never grows it.
     */
    this._marks = [];
    for (let i = 0; i < this.marks; i++) this._marks.push(new Vector4(0, 0, -1e4, 1));
    this._markCount = 0;
    this._markNext = 0;

    this.material = new ShaderMaterial({
      defines: {
        GF_MODE: mode,
        GF_MARKS: this.marks,
        GF_RINGS: RUNE_RINGS,
        GF_GLYPHS: GLYPH_COUNT
      },
      transparent: true,
      depthWrite: false,
      depthTest,
      blending: additive ? AdditiveBlending : NormalBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uQuadSize: { value: new Vector2(12, 12) },
        uRadius: { value: 4 },
        uLength: { value: 10 },
        uSeed: { value: 0 },

        uGrow: { value: 1 },
        uRecede: { value: 0 },
        uEdge: { value: 0.35 },
        uRagged: { value: 0.28 },
        uRaggedScale: { value: 0.7 },
        uWarp: { value: 0.5 },

        uRelief: { value: 0.6 },
        uNormalStep: { value: 0.06 },
        uAmbient: { value: 0.32 },
        uWrap: { value: 0.45 },
        uSpecular: { value: 0.5 },
        uGloss: { value: 24 },
        uParallax: { value: 0.35 },

        uCell: { value: 0.55 },
        uCellJitter: { value: 0.85 },
        uSeam: { value: 0.05 },
        uThickness: { value: 0.05 },
        uLift: { value: 0.12 },
        uDepth: { value: 0.25 },
        uWidth: { value: 0.5 },
        uSharp: { value: 0.5 },
        uDetail: { value: 0.6 },
        uSwirl: { value: 0.3 },
        uArms: { value: 5 },
        uSpeed: { value: 1.2 },
        uFlow: { value: 0.35 },
        uWind: { value: new Vector2(0.56, 0.83) },

        uRings: { value: 3 },
        uRingInner: { value: 0.35 },
        uGlyphSize: { value: 0.55 },
        uGlyphStroke: { value: 0.045 },
        uGlyphGap: { value: 1.35 },
        uSpin: { value: 0.12 },
        uSpinFalloff: { value: 0.6 },
        uRule: { value: 0.012 },
        uInscribe: { value: 1 },
        uIgnite: { value: 0 },
        uScorch: { value: 0 },

        uArmStart: { value: 1 },
        uArmRadius: { value: 0.66 },
        uArmSides: { value: 7 },
        uArmTangent: { value: 0.4 },
        uArmStroke: { value: 0.02 },
        uArmPhase: { value: 0.35 },
        uArmSpin: { value: -0.05 },
        uTickCount: { value: 60 },
        uTickRadius: { value: 0.95 },
        uTickLength: { value: 0.13 },
        uTickStroke: { value: 0.011 },
        uTickMajor: { value: 6 },
        uTickMajorLen: { value: 0.15 },

        uSigilStart: { value: 1 },
        uSigilRadius: { value: 0.36 },
        uSigilSize: { value: 0.72 },
        uSigilArms: { value: 5 },
        uSigilStroke: { value: 0.032 },
        uSigilRing: { value: 0.92 },
        uSigilSpin: { value: 0.06 },

        uMarks: { value: this._marks },
        uMarkCount: { value: 0 },
        uMarkLife: { value: 6 },
        uMarkRadius: { value: 0.7 },
        uProgress: { value: 1 },

        uFade: { value: 1 },
        uOpacity: { value: 1 },
        uEmissive: { value: 1 },
        uDepthFade: { value: 0.5 },
        uColorBase: { value: new Color(0.54, 0.56, 0.59) },
        uColorEdge: { value: new Color(0.87, 0.91, 0.94) },
        uColorGlow: { value: new Color(1, 0.82, 0.48) },
        uColorDeep: { value: new Color(0.09, 0.1, 0.12) },

        // Opt-in to vfx/SceneHooks.js's disruption field. Shared boxes, by
        // identity: one write in sceneHooks.apply() reaches every mark in the
        // app, and cloning them here would read a field that is always off.
        ...disruptUniforms()
      }),
      vertexShader: GROUND_VERTEX,
      fragmentShader: GROUND_FRAGMENT
    });

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = name ?? `GroundField:${GROUND_MODE_NAMES[mode] ?? mode}`;
    this.mesh.layers.set(layer);
    // Under the VFX, over the floor — and additive marks last, so a shaded mark
    // never composites on top of the light it is supposed to be sitting under.
    this.mesh.renderOrder = renderOrder ?? (additive ? 8 : 6);
    this.mesh.frustumCulled = false;
    this._additive = additive;
    this._renderOrder = renderOrder;

    parent?.add(this.mesh);
  }

  get object3D() {
    return this.mesh;
  }

  /** One. Always one. */
  get drawCalls() {
    return 1;
  }

  /** Events currently in the list. */
  get markCount() {
    return this._markCount;
  }

  setVisible(visible) {
    this.mesh.visible = visible;
  }

  /**
   * Post an event: an impact for `POCK`, a contact sample for `RUT`.
   *
   * @param {number} x        unitless, fraction of the radius across (local +X)
   * @param {number} z        unitless, fraction of the radius downrange (local +Z);
   *                          for `RUT`, 0..1 along the track
   * @param {number} time     the timestamp it fired at — an event, not a dimension
   * @param {number} [strength=1] 0..1, scales the crater or the contact force
   *
   * Past `marks` events the list recycles oldest-first. That is a ring buffer,
   * not a queue: nothing shuffles and nothing allocates.
   */
  mark(x, z, time, strength = 1) {
    const slot = this._marks[this._markNext];
    slot.set(x, z, time, strength);
    this._markNext = (this._markNext + 1) % this.marks;
    this._markCount = Math.min(this._markCount + 1, this.marks);
    this.material.uniforms.uMarkCount.value = this._markCount;
    return slot;
  }

  /** Forget every event. Part of the pooling contract — call it from `onSpawn`. */
  clearMarks() {
    this._markCount = 0;
    this._markNext = 0;
    this.material.uniforms.uMarkCount.value = 0;
    for (let i = 0; i < this.marks; i++) this._marks[i].set(0, 0, -1e4, 1);
  }

  /**
   * Re-resolve everything from the live params and place the quad.
   *
   * Allocation-free, and safe on a zero-length frame — which is the test that
   * matters: pause, drag `radius`, and the mark on the floor re-scales, its
   * grain re-scales with it and its front stays where the growth clock left it.
   *
   * @param {object} p live params — see `groundFieldParams()`
   */
  update(p) {
    const u = this.material.uniforms;

    const nf = p.noiseFrequency ?? 1;
    const ns = p.noiseStrength ?? 1;
    const nsp = p.noiseSpeed ?? 1;

    const radius = Math.max(0.05, p.radius ?? 4);
    const length = Math.max(0.2, p.length ?? 10);
    const edge = Math.max(0.001, p.edge ?? 0.35);

    /* ---- the front ---- */
    u.uRadius.value = radius;
    u.uLength.value = length;
    u.uSeed.value = p.seed ?? 0;
    u.uGrow.value = p.grow ?? 1;
    u.uRecede.value = p.recede ?? 0;
    u.uEdge.value = edge;
    u.uRagged.value = (p.ragged ?? 0.28) * ns;
    u.uRaggedScale.value = (p.raggedScale ?? 0.7) * nf;
    u.uWarp.value = (p.warp ?? 0.5) * ns;

    /* ---- relief ---- */
    u.uRelief.value = p.relief ?? 0.6;
    u.uNormalStep.value = Math.max(0.005, p.normalStep ?? 0.06);
    u.uAmbient.value = p.ambient ?? 0.32;
    u.uWrap.value = p.wrap ?? 0.45;
    u.uSpecular.value = p.specular ?? 0.5;
    u.uGloss.value = Math.max(1, p.gloss ?? 24);
    u.uParallax.value = p.parallax ?? 0.35;

    /* ---- the shape vocabulary ---- */
    u.uCell.value = Math.max(0.02, p.cell ?? 0.55);
    u.uCellJitter.value = p.cellJitter ?? 0.85;
    u.uSeam.value = Math.max(0.001, p.seam ?? 0.05);
    u.uThickness.value = Math.max(0.001, p.thickness ?? 0.05);
    u.uLift.value = p.lift ?? 0.12;
    u.uDepth.value = p.depth ?? 0.25;
    u.uWidth.value = Math.max(0.01, p.width ?? 0.5);
    u.uSharp.value = p.sharp ?? 0.5;
    u.uDetail.value = p.detail ?? 0.6;
    u.uSwirl.value = p.swirl ?? 0.3;
    // Whole grooves only: the spiral phase is angular and a fractional arm
    // count tears the field open along the ±π seam.
    u.uArms.value = Math.max(1, Math.round(p.arms ?? 5));
    u.uSpeed.value = (p.speed ?? 1.2) * nsp;
    u.uFlow.value = (p.flow ?? 0.35) * nsp;
    const wind = p.windAngle ?? 0.6;
    u.uWind.value.set(Math.sin(wind), Math.cos(wind));

    /* ---- the seal ---- */
    u.uRings.value = Math.min(RUNE_RINGS, Math.max(1, Math.round(p.rings ?? 3)));
    u.uRingInner.value = Math.min(0.95, Math.max(0.02, p.ringInner ?? 0.35));
    u.uGlyphSize.value = Math.max(0.02, p.glyphSize ?? 0.55);
    u.uGlyphStroke.value = Math.max(0.002, p.glyphStroke ?? 0.045);
    u.uGlyphGap.value = Math.max(0.5, p.glyphGap ?? 1.35);
    u.uSpin.value = p.spin ?? 0.12;
    u.uSpinFalloff.value = p.spinFalloff ?? 0.6;
    u.uRule.value = Math.max(0.001, p.rule ?? 0.012);
    u.uInscribe.value = p.inscribe ?? 1;
    u.uIgnite.value = p.ignite ?? 0;
    u.uScorch.value = p.scorch ?? 0;

    /* ---- the armature and the tick collar ---- */
    // The counts are rounded here rather than in the shader for the same reason
    // `arms` is: a fractional side count puts the last chord and the first one
    // at different bearings and the figure tears open along one seam.
    // 1 means "the rings own the whole clock", which is how this mode behaved
    // before the armature existed and is therefore what a caller who says
    // nothing must keep getting.
    u.uArmStart.value = Math.min(1, Math.max(0.02, p.armStart ?? 1));
    u.uArmRadius.value = p.armRadius ?? 0.66;
    u.uArmSides.value = Math.max(3, Math.round(p.armSides ?? 7));
    u.uArmTangent.value = p.armTangent ?? 0.4;
    u.uArmStroke.value = Math.max(0.001, p.armStroke ?? 0.02);
    u.uArmPhase.value = p.armPhase ?? 0.35;
    u.uArmSpin.value = p.armSpin ?? -0.05;
    u.uTickCount.value = Math.max(4, Math.round(p.tickCount ?? 60));
    u.uTickRadius.value = p.tickRadius ?? 0.95;
    u.uTickLength.value = Math.max(0.001, p.tickLength ?? 0.13);
    u.uTickStroke.value = Math.max(0.001, p.tickStroke ?? 0.011);
    u.uTickMajor.value = Math.max(1, Math.round(p.tickMajor ?? 6));
    u.uTickMajorLen.value = Math.max(0, p.tickMajorLen ?? 0.15);

    /* ---- the central sigil ---- */
    u.uSigilStart.value = Math.min(1, Math.max(0.03, p.sigilStart ?? 1));
    u.uSigilRadius.value = Math.max(0, p.sigilRadius ?? 0.36);
    u.uSigilSize.value = Math.max(0.02, p.sigilSize ?? 0.72);
    u.uSigilArms.value = Math.max(1, Math.round(p.sigilArms ?? 5));
    u.uSigilStroke.value = Math.max(0.002, p.sigilStroke ?? 0.032);
    u.uSigilRing.value = Math.max(0.01, p.sigilRing ?? 0.92);
    u.uSigilSpin.value = p.sigilSpin ?? 0.06;

    /* ---- events ---- */
    u.uMarkLife.value = Math.max(0.05, p.markLife ?? 6);
    u.uMarkRadius.value = Math.max(0.02, p.markRadius ?? 0.7);
    u.uProgress.value = p.progress ?? 1;

    /* ---- output ---- */
    u.uFade.value = p.fade ?? 1;
    u.uOpacity.value = (p.opacity ?? 1) * (p.opacityScale ?? 1);
    u.uEmissive.value = p.emissive ?? 1;
    u.uDepthFade.value = Math.max(0.001, p.depthFade ?? 0.5);
    u.uColorBase.value.copy(getColor(p.colorBase ?? '#8a8f96'));
    u.uColorEdge.value.copy(getColor(p.colorEdge ?? '#dfe8f0'));
    u.uColorGlow.value.copy(getColor(p.colorGlow ?? '#ffd27a'));
    u.uColorDeep.value.copy(getColor(p.colorDeep ?? '#161a1e'));

    this.setAdditive(p.additive ?? false);

    /* ---- the quad ---- */
    // Big enough to hold the mark at full raggedness plus whatever stands
    // outside it — spoil, splatter, a calved lip. Re-derived every frame, so a
    // radius drag grows the canvas along with the drawing on it.
    const pad = edge + radius * (p.ragged ?? 0.28) + Math.max(p.lift ?? 0, p.thickness ?? 0) * 4 + 0.6;
    const across = (radius + pad) * 2;
    const down = this.mode === GroundMode.RUT ? length + pad * 2 : across;

    u.uQuadSize.value.set(across, down);
    this.mesh.scale.set(across, 1, down);

    const yaw = p.yaw ?? 0;
    const centre = p.centre;
    const height = p.height ?? 0.02;
    if (centre) {
      // RUT anchors at the *start* of the track, so the quad slides downrange
      // by half its own length to cover it.
      const slide = this.mode === GroundMode.RUT ? length * 0.5 : 0;
      this.mesh.position.set(
        centre.x + Math.sin(yaw) * slide,
        height,
        centre.z + Math.cos(yaw) * slide
      );
    } else {
      this.mesh.position.y = height;
    }
    this.mesh.rotation.set(0, yaw, 0);
  }

  /**
   * Switch between adding light to the floor and shading it.
   *
   * Blend state is not compiled into the program, so this is free to drive from
   * a checkbox every frame — which is the point, since choosing wrong is the
   * documented rough edge this module exists to close.
   */
  setAdditive(additive) {
    if (additive === this._additive) return;
    this._additive = additive;
    this.material.blending = additive ? AdditiveBlending : NormalBlending;
    this.mesh.renderOrder = this._renderOrder ?? (additive ? 8 : 6);
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.material.dispose();
    releaseGroundQuad();
    this.geometry = null;
  }
}
