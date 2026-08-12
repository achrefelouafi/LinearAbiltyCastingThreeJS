import {
  BufferAttribute,
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Sphere,
  Vector2,
  Vector3,
  Vector4
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { putColor } from '../utils/color.js';
import { saturate } from '../utils/math.js';

/* ---------------------------------------------------------------------- */
/* FoldMesh — paper that folds without stretching                          */
/* ---------------------------------------------------------------------- */

/**
 * A flat sheet with a **crease pattern**, folded from one number.
 *
 * Two abilities want this and they want opposite ends of it. `origami` throws a
 * flock of cranes downrange that *unfold* into flat sheets in the air;
 * `scrollward` stands a ring of scrolls up and pays them out into a wall of
 * text. Both are the same object — a rectangle of paper being told, by a single
 * `progress` slider, how far along a sequence of rigid motions it currently is.
 *
 * ## The one rule: paper does not stretch
 *
 * This is the whole module. Everything below is in service of it, and if you
 * change one line in the vertex shader, change it so that this stays true.
 *
 * The first version did the obvious thing: author the flat sheet, author the
 * folded sheet, and `mix()` between them on `progress`. It is four lines and it
 * is wrong in a way you cannot un-see. A vertex travelling in a straight line
 * between two positions that are *rotated* apart cuts the chord instead of
 * walking the arc, so every span across a fold **shortens** on the way over: a
 * 180° fold at the halfway point has lost `1 − cos(θ/2)` — thirty per cent — of
 * its width. The crane deflates as it closes and re-inflates as it opens. It
 * reads as rubber, or as a balloon, and no amount of shading rescues it.
 *
 * So nothing here interpolates positions. **Every vertex is moved by a product
 * of rigid motions**, one per crease, and a product of rigid motions preserves
 * every distance on the sheet by construction — at every intermediate value of
 * `progress`, not just at the ends. The isometry is not a quality setting, it
 * is a consequence of the representation.
 *
 * ## How a crease works
 *
 * A crease is a **line in sheet space** with a signed target angle. Sheet space
 * is the unfolded material: `aSheet` runs `-0.5 .. 0.5` on both axes and never
 * changes, whatever the paper is doing. For each crease:
 *
 *   - the *moving flap* is the half-plane you reach by turning right from the
 *     crease's own direction — `n = (dir.y, −dir.x)` in sheet coordinates, which
 *     is `cross(up, dir)` in three dimensions. Material with `d ≤ 0` is held;
 *     material with `d > 0` moves;
 *   - a **positive** angle lifts that flap toward `+y` (a *valley* seen from
 *     above), a negative one drives it down (a *mountain*). The tables below use
 *     the `VALLEY` / `MOUNTAIN` constants rather than bare signs, because a
 *     crease pattern read six months later is a list of signs and nothing else;
 *   - the crease is not a knife edge. It is a **hinge of finite radius**: over a
 *     band `hinge` metres wide the flap rolls onto a cylinder tangent to the
 *     sheet, and only past the band is it rigidly rotated. Paper does exactly
 *     this — a crease has a radius of a few paper thicknesses — and it costs
 *     nothing, because a cylindrical roll parameterised **by arc length** is
 *     itself isometric. The band is also where the crease highlight lives, so
 *     the fold catches light along its length with no extra geometry.
 *
 * The per-crease operator is, in the crease's own frame, a rotation by
 * `φ = clamp(d/w, 0, 1)·θ` about the hinge axis followed by a slide of
 * `−min(d, w)` along the rotated in-plane direction. That is a rigid motion for
 * each material point — which is why it composes with the others — and
 * differentiating it along `n` gives exactly 1, which is the proof that the
 * band does not stretch either. Both halves of that sentence were worth the
 * afternoon it took to get them: the naive "rotate the flap about the axis"
 * form is rigid but has a knife crease, and the naive "roll it onto a cylinder"
 * form is smooth but is not a rigid motion of the *point*, so it silently threw
 * away every fold applied before it.
 *
 * ## The hierarchy
 *
 * Real folding is a tree. The head is folded, then the neck the head is on is
 * folded, then the body the neck is on is folded, and the earlier folds ride
 * along. The tables are authored **root first**, the way you would describe the
 * model out loud, and the shader walks them **backwards** so the deepest fold is
 * applied to the vertex first and every fold above it carries the result. Each
 * crease line is expressed in *flat* sheet space and stays there — a parent's
 * rotation transports its children automatically, so nothing has to re-derive
 * where a crease has got to.
 *
 * Two consequences worth knowing:
 *
 *   - the side test is done against the vertex's **flat** position, never its
 *     current one. Material either side of a crease is decided by the paper, not
 *     by where the paper happens to be pointing;
 *   - the loop runs `MAX_CREASES` times and skips the empty slots, because
 *     `uCreaseLine[i]` may only be indexed by something built out of constants
 *     and the loop counter. `MAX_CREASES - 1 - k` qualifies; `uCreaseCount - 1 - k`
 *     does not, and does not compile on ANGLE.
 *
 * ## The patterns
 *
 * `DART` (six creases), `CRANE` (seven) and `FAN` (an accordion, generated) plus
 * `FLAT`, which is a sheet of paper and is not a lesser thing — it is what a
 * crane becomes and what `scrollward` starts from.
 *
 * They are **stylised**, and the honest statement of how is this: a real crease
 * pattern limits a crease to a *region*, and a half-plane fold cannot. Where a
 * pattern needs one — the crane's neck and tail are strips, not halves — the
 * crease carries a **gate**, a slab through the crease's own origin outside
 * which the fold does not apply. A gate is a cut, not a crease: the sheet
 * separates along it. Use one only where the real pattern already has a crease
 * there, keep `hinge` small enough that the seam is a line rather than a gap,
 * and do not go looking for a paper aeroplane you can fly.
 *
 * `CRANE` also wants a **square**. `aspect` away from 1 stretches the crease
 * pattern, the fold angles stop meeting, and the tips open. That is not a bug in
 * the fold; it is the pattern being asked to do something paper cannot. `DART`
 * tolerates a rectangle, `FAN` does not care.
 *
 * ## `UNROLL` — the other half of the module
 *
 * A scroll is not a crease pattern; it is one continuous bend, and it is the
 * mode `scrollward` is built on. The sheet is placed **by arc length from the
 * free end**:
 *
 *   - the paid-out run is an arc of constant curvature `curl` — the paper
 *     remembers the roll — with `sin(κa)/κ` and `(1−cos(κa))/κ` for the position,
 *     which is a cylindrical bend and therefore isometric;
 *   - the wound part is an **Archimedean spiral**, `r(w) = √(r₀² + wt/π)`, which
 *     is the exact relation between wound length and radius for paper of
 *     thickness `t` on a core of radius `r₀`. It **tightens toward the spool**
 *     because that is what the square root does, and the turn angle
 *     `θ = 2π(r_outer − r)/t` is its integral. Arc length along it comes back as
 *     `√(1 + (t/2πr)²) ≈ 1 + 10⁻⁵` — the residual stretch is five parts in a
 *     million at a millimetre of paper on a 30 mm core, which is a thousand times
 *     under a pixel.
 *
 * Placing by arc length is the whole trick, and the alternative fails loudly:
 * place by *fraction of the sheet* and a tight inner turn and a flat metre of
 * paper are declared the same amount of material, so the marks bunch up at the
 * spool and stretch on the run. Because every mark this module draws — grain,
 * laid lines, ink — is a function of the sheet coordinate and nothing else, the
 * **foreshortening is free and it is correct**: the shader never learns it is on
 * a curve, and the writing compresses as it comes off the roll because the
 * paper it is printed on genuinely is compressed there in screen space.
 *
 * ## The shading: it has to be paper
 *
 * Thin, matte, slightly translucent, with a fibre grain and a crease that
 * catches light. Five pickers, none derived from another: the sheet, its shaded
 * side, the colour of light coming *through* it, the ink and the crease.
 *
 *   - **Translucency is the tell.** A sheet with light behind it glows, and it
 *     glows *less where the ink is*, because ink is opaque and paper is not.
 *     That one line — the ink ghosting through from the back — is the difference
 *     between paper and painted card, and it costs a multiply.
 *   - **The grain is anisotropic and lives in sheet space.** Paper fibres lie
 *     along the machine direction; the noise is stretched `grainAniso` times
 *     along `grainAngle`, and it does not move when the sheet folds, because it
 *     is printed on the material rather than projected onto it.
 *   - **Laid lines.** The faint regular ribbing of a laid sheet. Two periods, a
 *     fine one and the chain lines every few centimetres. Free, and it is the
 *     thing that stops a big flat scroll reading as a polygon.
 *   - **The crease highlight** is the hinge band, brightened on the mountain
 *     side and darkened on the valley side, scaled by how far the fold has
 *     actually gone. It appears as the paper folds and vanishes when it opens,
 *     which is what a crease does.
 *
 * This is the only material in `src/vfx/` with `toneMapped: true`. It is paper,
 * not light: left out of the tone map a white sheet is the brightest thing on
 * the screen and blooms, and the ink school forbids bloom.
 *
 * ## Cost
 *
 * **One draw call** for the whole flock — one `InstancedBufferGeometry`, every
 * sheet placed, folded and lit by the vertex shader. No textures. The vertex
 * cost is `segments² × MAX_CREASES` rotations per sheet, which is the one number
 * to watch: 24 segments and 12 creases is 7k rotations a sheet, fine for a
 * flock of twenty, and `segments` is a constructor option because a scroll wants
 * resolution along one axis and a crane wants it on both.
 *
 * ## Invariants
 *
 * - **I1** — a sheet carries four dice and a phase. Every metre — the sheet's
 *   own size, the spread of the flock, the hinge radius, the core of the roll —
 *   is re-resolved from `update()`'s params each frame, so a paused flock
 *   re-folds under a dragged slider. The crease *tables* carry no metres either:
 *   they are fractions of the sheet and multiples of π.
 * - **I3** — `roll()` refills existing typed arrays; `update()` writes into
 *   existing uniform boxes; `setPattern()` writes into the twelve `Vector4`s it
 *   allocated at construction.
 * - **I5** — every dimension is a slider and every colour is a picker.
 *
 * @example
 *   this.paper = new FoldMesh(this.group, {
 *     pattern: FoldPattern.CRANE, layout: FoldLayout.LINE, capacity: 24
 *   });
 *   // spawn
 *   this.paper.roll();
 *   // travel, every frame
 *   this._fillParams();                       // reads settings.origami into a scratch
 *   this.paper.setBasis(origin, direction, side, length);
 *   this.paper.update(this.age, this._params);
 */

/** Hard ceiling on the crease table. Sized by the uniform budget — see the header. */
export const MAX_CREASES = 12;

/* ---------------------------------------------------------------- */
/* Enums                                                             */
/* ---------------------------------------------------------------- */

/** Which crease table is loaded. A mode, not a dimension — safe to capture. */
export const FoldPattern = Object.freeze({
  /** No creases. A sheet, a page, a leaf. What a crane unfolds into. */
  FLAT: 0,
  /** A paper dart: keel, two nose folds, two wings. Tolerates a rectangle. */
  DART: 1,
  /** A stylised crane: body, swept wings, tail, neck, head. Wants a square. */
  CRANE: 2,
  /** An accordion of parallel pleats, generated from `fanCreases(count)`. */
  FAN: 3,
  /**
   * Not a crease pattern at all — the sheet wraps onto a spool. Ignores the
   * crease table entirely; `progress` still drives it, through `payout`.
   */
  UNROLL: 4
});

/** Where the sheets stand. */
export const FoldLayout = Object.freeze({
  /** Strung down the cast line, lying flat, nose downrange. A flock. */
  LINE: 0,
  /** Standing upright around a circle, facing out. Scrolls, banners, walls. */
  ZONE: 1,
  /** One sheet at the anchor, carried downrange by `travel`. */
  SINGLE: 2
});

/** Crease signs, so a pattern table reads as folding instructions. */
export const VALLEY = 1;
export const MOUNTAIN = -1;

/* ---------------------------------------------------------------- */
/* The crease tables                                                 */
/* ---------------------------------------------------------------- */

/**
 * One crease.
 *
 * Everything here is **unitless**: fractions of the unfolded sheet, multiples of
 * π, and fractions of `progress`. A table can therefore be captured — it is not
 * a dimension, it is a shape — and every metre it turns into is resolved in the
 * shader from a live uniform.
 *
 * @typedef {object} Crease
 * @property {number[]} o     origin of the crease line, sheet units, −0.5..0.5
 * @property {number[]} dir   direction of the line, sheet units, normalised here
 * @property {number} turns   fold angle in half-turns, signed: + valley, − mountain
 * @property {number} [t0]    progress at which this crease starts folding
 * @property {number} [t1]    progress at which it is fully folded
 * @property {number} [hinge] multiplier on the global hinge radius
 * @property {number[]} [gate] gate line direction through `o`; omit for none
 * @property {number[]} [span] gate slab bounds, sheet units, `[min, max]`
 */

/**
 * A paper dart.
 *
 * Root first: the keel, then the two nose folds inside it, then the wings. The
 * nose folds stop at 0.94 rather than 1.0 turns because a fold that lies exactly
 * flat on the sheet under it is two coplanar surfaces fighting for the same
 * depth; the stack offset handles the rest.
 */
const DART_CREASES = [
  { o: [0, 0], dir: [0, -1], turns: 0.12 * VALLEY, t0: 0, t1: 0.35 }, // keel, left half
  { o: [0, 0], dir: [0, 1], turns: 0.12 * VALLEY, t0: 0, t1: 0.35 }, // keel, right half
  { o: [0, 0.5], dir: [-0.7071, -0.7071], turns: 0.94 * VALLEY, t0: 0.15, t1: 0.7 }, // nose, left
  { o: [0, 0.5], dir: [0.7071, -0.7071], turns: 0.94 * VALLEY, t0: 0.15, t1: 0.7 }, // nose, right
  { o: [-0.16, 0], dir: [0, -1], turns: 0.8 * MOUNTAIN, t0: 0.55, t1: 1 }, // wing, left
  { o: [0.16, 0], dir: [0, 1], turns: 0.8 * MOUNTAIN, t0: 0.55, t1: 1 } // wing, right
];

/**
 * A crane, stylised.
 *
 * The sheet's `+v` is the head end. Root first: the spine lifts both halves into
 * the body, the wings break back out of them, and the tail, neck and head are
 * gated strips down the middle. The head is authored last because it is the
 * deepest fold in the tree — it has to be applied to the vertex before the neck
 * that carries it.
 *
 * The staging is the ability: the windows are laid end to end so the bird
 * assembles in the order you would fold it, and `origami` runs `progress`
 * *backwards* so it comes apart in the order you would unfold it.
 */
const CRANE_CREASES = [
  { o: [0, 0], dir: [0, -1], turns: 0.55 * VALLEY, t0: 0, t1: 0.45 }, // spine, left half
  { o: [0, 0], dir: [0, 1], turns: 0.55 * VALLEY, t0: 0, t1: 0.45 }, // spine, right half
  { o: [-0.17, 0], dir: [0, -1], turns: 0.35 * MOUNTAIN, t0: 0.3, t1: 0.7 }, // wing break, left
  { o: [0.17, 0], dir: [0, 1], turns: 0.35 * MOUNTAIN, t0: 0.3, t1: 0.7 }, // wing break, right
  {
    o: [0, -0.22],
    dir: [1, 0],
    turns: 0.5 * VALLEY,
    t0: 0.45,
    t1: 0.75,
    gate: [0, 1],
    span: [-0.13, 0.13]
  }, // tail — a strip, not a half
  {
    o: [0, 0.15],
    dir: [-1, 0],
    turns: 0.6 * VALLEY,
    t0: 0.55,
    t1: 0.9,
    gate: [0, 1],
    span: [-0.11, 0.11]
  }, // neck
  {
    o: [0, 0.35],
    dir: [-1, 0],
    turns: 0.75 * MOUNTAIN,
    t0: 0.8,
    t1: 1,
    gate: [0, 1],
    span: [-0.11, 0.11],
    hinge: 0.6
  } // head
];

/**
 * An accordion of `count` parallel pleats.
 *
 * Generated rather than authored, and it is the clearest demonstration of the
 * hierarchy in the module: the first crease turns the sheet by θ, and every
 * crease after it turns by **−2θ, +2θ, −2θ…** because each one has to undo its
 * parent and go the same distance again the other way. Author them as ±θ each
 * and you get a spiral, not a fan — which is how the sign convention got tested.
 *
 * @param {number} count pleats, 2..MAX_CREASES
 * @param {number} [turns] half-turns of the first fold; 1 lies flat
 * @returns {Crease[]}
 */
export function fanCreases(count = 8, turns = 0.5) {
  const n = Math.max(2, Math.min(MAX_CREASES, Math.round(count)));
  const table = [];
  for (let i = 0; i < n; i++) {
    const u = -0.5 + ((i + 1) / (n + 1)) * 1;
    const magnitude = i === 0 ? turns : turns * 2;
    const sign = i % 2 === 0 ? VALLEY : MOUNTAIN;
    table.push({
      o: [u, 0],
      dir: [0, 1], // moving flap is everything to the right of this pleat
      turns: magnitude * sign,
      // Pleats close outward from the first one, a beat apart, so the fan opens
      // like a fan instead of snapping shut in one frame.
      t0: (i / n) * 0.5,
      t1: 0.5 + (i / n) * 0.5
    });
  }
  return table;
}

/** Keyed by `FoldPattern`. `UNROLL` and `FLAT` have no creases by definition. */
export const CREASE_PATTERNS = Object.freeze({
  [FoldPattern.FLAT]: [],
  [FoldPattern.DART]: DART_CREASES,
  [FoldPattern.CRANE]: CRANE_CREASES,
  [FoldPattern.FAN]: fanCreases(8),
  [FoldPattern.UNROLL]: []
});

/* ---------------------------------------------------------------- */
/* The fold, in GLSL                                                 */
/* ---------------------------------------------------------------- */

/**
 * Injected into the vertex shader. Kept as its own chunk because it is the part
 * of this file that has to be read carefully, and burying it three hundred
 * lines into a placement shader is how it stops being read at all.
 *
 * NOTE for anyone editing: no backticks in these comments. The file is one
 * template literal and a stray backtick ends it, reporting as a JavaScript
 * syntax error pointing into the middle of the shader.
 */
const FOLD_GLSL = /* glsl */ `
  #define MAX_CREASES ${MAX_CREASES}

  uniform vec4  uCreaseLine[MAX_CREASES];   // (ox, oy, dx, dy) sheet units
  uniform vec4  uCreaseFold[MAX_CREASES];   // (halfTurns, t0, t1, hingeScale)
  uniform vec4  uCreaseGate[MAX_CREASES];   // (gdx, gdy, spanMin, spanMax)
  uniform float uCreaseCount;

  uniform vec2  uSheetSize;   // metres: (across, along)
  uniform float uProgress;    // 0 flat, 1 folded — the one slider
  uniform float uFoldGain;    // multiplier on every angle; > 1 overfolds
  uniform float uHinge;       // metres — the crease radius band
  uniform float uStageEase;   // 0 linear stage windows, 1 smoothstepped
  uniform float uThickness;   // metres of paper, per stacked layer

  /** Rodrigues, with the cosine and sine already taken. */
  vec3 spin(vec3 v, vec3 axis, float c, float s) {
    return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
  }

  /**
   * Fold the sheet.
   *
   * @param sheet  material coordinate, -0.5..0.5 on both axes. Never changes.
   * @param prog   this instance's progress. Staggered per sheet by the caller.
   * @param pos    out: position in the sheet's own local frame, metres
   * @param nrm    out: unit normal in that frame
   * @param crease out: signed hinge term, -1..1, for the crease highlight
   * @param layers out: how many flaps are stacked under this vertex
   */
  void foldSheet(vec2 sheet, float prog, out vec3 pos, out vec3 nrm,
                 out float crease, out float layers) {
    vec2 scale = uSheetSize;
    vec2 rest = sheet * scale;               // unfolded position, metres
    pos = vec3(rest.x, 0.0, rest.y);
    nrm = vec3(0.0, 1.0, 0.0);
    crease = 0.0;
    layers = 0.0;

    for (int k = 0; k < MAX_CREASES; k++) {
      // Backwards: the table is authored root first and the deepest fold has to
      // reach the vertex first. MAX_CREASES - 1 - k is a constant-index
      // expression; uCreaseCount - 1 - k is not, and will not compile.
      int i = MAX_CREASES - 1 - k;
      if (float(i) >= uCreaseCount) continue;

      vec4 line = uCreaseLine[i];
      vec4 fold = uCreaseFold[i];
      vec4 gate = uCreaseGate[i];

      /* --- how far through its own window is this crease? --- */
      float span = max(fold.z - fold.y, 1e-4);
      float w01 = clamp((prog - fold.y) / span, 0.0, 1.0);
      w01 = mix(w01, w01 * w01 * (3.0 - 2.0 * w01), uStageEase);
      float theta = fold.x * PI * uFoldGain * w01;
      if (abs(theta) < 1e-5) continue;

      /* --- the crease frame, in metres --- */
      // The direction is scaled with the sheet before it is normalised, so a
      // diagonal crease on a rectangle stays where the paper put it.
      vec2 t2 = normalize(line.zw * scale + vec2(1e-8, 0.0));
      vec2 n2 = vec2(t2.y, -t2.x);           // turn right: the moving flap
      vec2 o2 = line.xy * scale;
      float d = dot(rest - o2, n2);          // UNFOLDED distance. Material, not geometry.
      if (d <= 0.0) continue;

      /* --- the gate: a slab through the crease origin, in sheet units --- */
      if (dot(gate.xy, gate.xy) > 1e-6) {
        vec2 g2 = normalize(gate.xy);
        float gd = dot(sheet - line.xy, vec2(g2.y, -g2.x));
        if (gd < gate.z || gd > gate.w) continue;
      }

      /* --- the hinge --- */
      float hw = max(uHinge * max(fold.w, 0.02), 1e-4);
      float dc = min(d, hw);
      float phi = dc * theta / hw;           // partway across the band, part-folded
      float radius = hw / theta;             // signed: mountains curl the other way
      vec3 axis = vec3(t2.x, 0.0, t2.y);
      vec3 nrm3 = vec3(n2.x, 0.0, n2.y);
      vec3 up3 = vec3(0.0, 1.0, 0.0);
      vec3 axisPoint = vec3(o2.x, 0.0, o2.y) + up3 * radius;

      float c = cos(phi);
      float s = sin(phi);

      // A rigid motion of THIS material point: rotate about the hinge axis by
      // the angle its own distance across the band has earnt, then slide back
      // along the rotated in-plane direction by that same distance. On the
      // neutral surface this lands exactly on the cylinder of radius hw/theta,
      // and d(arc)/d(distance) is 1 — the band does not stretch. Past the band
      // it degenerates into a plain rotation-plus-offset, which is what carries
      // the flap.
      pos = axisPoint + spin(pos - axisPoint, axis, c, s);
      pos -= (nrm3 * c + up3 * s) * dc;
      nrm = spin(nrm, axis, c, s);

      layers += 1.0;

      /* --- the highlight lives in the band, on both sides of the line --- */
      float band = 1.0 - clamp(abs(d) / hw, 0.0, 1.0);
      float lit = band * clamp(abs(theta) / PI, 0.0, 1.0) * sign(theta);
      if (abs(lit) > abs(crease)) crease = lit;
    }

    // Flaps folded flat onto the sheet under them are not coplanar in real
    // paper and must not be here either, or two layers z-fight along their whole
    // shared face. One thickness per fold this vertex is downstream of, along
    // the final normal: the cheapest possible depth-fight fix, and it is also
    // physically what is happening.
    pos += nrm * layers * uThickness;
  }
`;

/**
 * `UNROLL`. Placement by arc length from the free end — see the class header for
 * why that is the only correct choice and what breaks when it is not made.
 */
const UNROLL_GLSL = /* glsl */ `
  uniform float uPayout;      // 0..1 of the sheet paid out flat
  uniform float uCore;        // metres — radius of the spool's core
  uniform float uPaper;       // metres — paper thickness. Sets how fast r grows.
  uniform float uCurl;        // 1/metres — residual curvature of the paid-out run
  uniform float uSpoolClimb;  // 0 spool fixed and the sheet falls, 1 the wall rises
  uniform float uSpin;        // radians of phase on the roll

  /**
   * @param sheet  material coordinate, -0.5..0.5
   * @param pos    out: local position, metres
   * @param nrm    out: unit normal
   * @param wound  out: 0 on the flat run, 1 where the paper is on the roll
   */
  void unrollSheet(vec2 sheet, out vec3 pos, out vec3 nrm, out float wound) {
    float L = max(uSheetSize.y, 1e-4);
    float s = (sheet.y + 0.5) * L;               // arc length from the free end
    float payout = clamp(uPayout, 0.0, 1.0) * L;
    float across = sheet.x * uSheetSize.x;

    /* --- the paid-out run: an arc of constant curvature ---------------- */
    // Series-expanded below a hundredth of a curvature unit, because sin(k a)/k
    // is a perfectly good straight line in the limit and a division by nothing
    // is not.
    float kappa = uCurl;
    float aRun = min(s, payout);
    float psi = kappa * aRun;
    float runZ = abs(kappa) > 1e-3 ? sin(psi) / kappa : aRun;
    float runY = abs(kappa) > 1e-3 ? (1.0 - cos(psi)) / kappa : 0.5 * kappa * aRun * aRun;
    vec3 runPos = vec3(across, runY, runZ);
    vec3 runNrm = vec3(0.0, cos(psi), -sin(psi));

    // Where the paper leaves the roll, and the frame there.
    float psiT = kappa * payout;
    float tz = abs(kappa) > 1e-3 ? sin(psiT) / kappa : payout;
    float ty = abs(kappa) > 1e-3 ? (1.0 - cos(psiT)) / kappa : 0.5 * kappa * payout * payout;
    vec3 tangentPoint = vec3(across, ty, tz);
    vec3 e1 = vec3(0.0, sin(psiT), cos(psiT));   // along the paper at the tangent
    vec3 e2 = vec3(0.0, cos(psiT), -sin(psiT));  // the paper's own +y there

    /* --- the wound part: an Archimedean spiral ------------------------- */
    float W = max(L - payout, 0.0);              // metres still on the roll
    float t = max(uPaper, 1e-5);
    float r0 = max(uCore, 1e-4);
    float w = max(s - payout, 0.0);              // metres in from the tangent point
    float rOuter = sqrt(r0 * r0 + W * t / PI);
    float r = sqrt(r0 * r0 + max(W - w, 0.0) * t / PI);
    float turn = (2.0 * PI / t) * (rOuter - r) + uSpin * step(1e-6, w);

    vec3 centre = tangentPoint + e2 * rOuter;
    float cs = cos(turn);
    float sn = sin(turn);
    vec3 spiralPos = centre + (-e2 * cs + e1 * sn) * r;
    // The face that pointed at the roll becomes the inside of the roll, so the
    // paper's own +y is the inward radial. Continuous with the run at turn = 0.
    vec3 spiralNrm = e2 * cs - e1 * sn;

    wound = step(payout, s);
    pos = mix(runPos, spiralPos, wound);
    nrm = normalize(mix(runNrm, spiralNrm, wound));

    // spoolClimb 0 pins the tangent point and lets the sheet grow downwards;
    // 1 pins the free end on the floor and the spool climbs, which is the wall
    // rising out of nothing that scrollward is after.
    pos -= tangentPoint * (1.0 - clamp(uSpoolClimb, 0.0, 1.0));
  }
`;

/* ---------------------------------------------------------------- */
/* Vertex                                                            */
/* ---------------------------------------------------------------- */

const FOLD_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  attribute vec2  aSheet;   // material coordinate, -0.5..0.5
  attribute vec4  aDice;    // (lateral, along, lift, size) — unitless rolls
  attribute vec4  aDiceB;   // (bearing, phase, tint, stagger)
  attribute float aSlot;

  uniform float uTime;
  uniform float uSeed;
  uniform int   uMode;      // 0 crease table, 1 unroll

  /* --- the basis, written by setBasis() every frame --- */
  uniform vec3  uOrigin;
  uniform vec3  uForward;
  uniform vec3  uSide;
  uniform vec3  uUp;
  uniform float uLength;    // metres of cast

  /* --- the flock --- */
  uniform int   uLayout;
  uniform float uCount;
  uniform float uTravel;    // 0..1 of the cast the flock has covered
  uniform float uSpread;    // metres of lateral scatter
  uniform float uStretch;   // metres of along-line scatter
  uniform float uLift;      // metres off the floor
  uniform float uLiftJitter;
  uniform float uRadius;    // metres, ZONE
  uniform float uRadiusJitter;
  uniform float uArc;       // radians of the ZONE fan, TAU for a full ring
  uniform float uArcPhase;

  /* --- attitude --- */
  uniform float uPitch;     // radians about the sheet's own across axis
  uniform float uYaw;
  uniform float uYawJitter;
  uniform float uRoll;
  uniform float uRollJitter;
  uniform float uBob;       // metres of vertical breathing
  uniform float uBobRate;   // radians/second
  uniform float uTumble;    // radians/second of free rotation about the normal
  uniform float uSizeJitter;

  /* --- staging --- */
  uniform float uSpreadStagger;   // fraction of progress spread across the flock
  uniform float uReveal;          // 0..1, sheets appear as this passes their dice
  uniform float uRevealSpread;

  ${FOLD_GLSL}
  ${UNROLL_GLSL}

  varying vec2  vSheet;
  varying vec3  vWorld;
  varying vec3  vNormal;
  varying float vCrease;
  varying float vLayers;
  varying float vTint;
  varying float vFade;
  varying float vWound;

  /** Rotate about an arbitrary unit axis. */
  vec3 turnAbout(vec3 v, vec3 axis, float a) {
    return spin(v, axis, cos(a), sin(a));
  }

  void main() {
    float slot = aSlot;
    float phase = aDiceB.y;

    /* --- where this sheet stands, and which way it is lying ---------- */
    vec3 centre;
    vec3 ex;   // the sheet's +u
    vec3 ez;   // the sheet's +v
    if (uLayout == 1) {
      // ZONE — upright, facing out of the circle. Scrolls, banners, walls.
      float bearing = uArcPhase + (slot + 0.5) / max(uCount, 1.0) * uArc;
      bearing += (aDiceB.x - 0.5) * 0.35 * uArc / max(uCount, 1.0);
      vec3 radial = uSide * cos(bearing) + uForward * sin(bearing);
      float r = uRadius * (1.0 + (aDice.x - 0.5) * 2.0 * uRadiusJitter);
      centre = uOrigin + radial * r;
      ex = normalize(cross(uUp, radial));
      ez = uUp;
    } else if (uLayout == 2) {
      // SINGLE — one sheet, carried downrange by travel.
      centre = uOrigin + uForward * (uTravel * uLength);
      ex = uSide;
      ez = uForward;
    } else {
      // LINE — a flock strung down the cast, lying flat, nose downrange.
      float along = uTravel * uLength + (aDice.y - 0.5) * 2.0 * uStretch;
      centre = uOrigin + uForward * along + uSide * ((aDice.x - 0.5) * 2.0 * uSpread);
      ex = uSide;
      ez = uForward;
    }
    centre += uUp * (uLift + (aDice.z - 0.5) * 2.0 * uLiftJitter);
    centre += uUp * (uBob * sin(uTime * uBobRate + phase * TAU));

    vec3 ey = normalize(cross(ez, ex));

    /* --- attitude, all of it live -------------------------------------- */
    float yaw = uYaw + (aDiceB.x - 0.5) * 2.0 * uYawJitter;
    float roll = uRoll + (aDiceB.z - 0.5) * 2.0 * uRollJitter + uTumble * uTime;
    // Pitch first about the sheet's own across axis, then yaw about the world
    // up, then roll about what is left of the normal. Order matters and this one
    // is "nose up, then turn, then bank", which is how a thing in the air reads.
    ez = turnAbout(ez, ex, uPitch);
    ey = normalize(cross(ez, ex));
    ex = turnAbout(ex, uUp, yaw);
    ez = turnAbout(ez, uUp, yaw);
    ey = normalize(cross(ez, ex));
    ex = turnAbout(ex, ey, roll);
    ez = turnAbout(ez, ey, roll);

    /* --- fold it ------------------------------------------------------- */
    // Per-sheet stagger is a fraction of progress, so a flock opens as a
    // ripple from one slider rather than in lockstep.
    float prog = clamp(uProgress - aDiceB.w * uSpreadStagger, -0.5, 1.5);

    vec3 local;
    vec3 lnrm;
    float creaseTerm = 0.0;
    float layers = 0.0;
    float wound = 0.0;
    if (uMode == 1) {
      unrollSheet(aSheet, local, lnrm, wound);
    } else {
      foldSheet(aSheet, prog, local, lnrm, creaseTerm, layers);
    }

    float size = 1.0 + (aDice.w - 0.5) * 2.0 * uSizeJitter;
    local *= size;

    vec3 world = centre + ex * local.x + ey * local.y + ez * local.z;
    vec3 normal = normalize(ex * lnrm.x + ey * lnrm.y + ez * lnrm.z);

    /* --- reveal -------------------------------------------------------- */
    // Its own die, mixed out of two of the others rather than borrowing one
    // whole: share the size die and the flock appears smallest-first, which
    // nobody authored and everybody notices.
    float rDie = fract(aDice.w * 7.13 + aDiceB.y * 3.71);
    float rs = max(uRevealSpread, 1e-3);   // smoothstep(a, a, x) is a coin toss
    float rStart = rDie * (1.0 - rs);
    float appear = smoothstep(rStart, rStart + rs, uReveal);

    vSheet = aSheet;
    vWorld = world;
    vNormal = normal;
    vCrease = creaseTerm;
    vLayers = layers;
    vTint = aDiceB.z;
    vFade = appear;
    vWound = wound;

    // Collapsing a hidden sheet to a point is cheaper than paying for its
    // fragments and discarding them one at a time.
    world = mix(centre, world, step(0.001, appear));

    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

/* ---------------------------------------------------------------- */
/* Fragment                                                          */
/* ---------------------------------------------------------------- */

const FOLD_FRAGMENT = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform vec3  uLightDir;
  uniform float uShaderIntensity;

  uniform vec3  uColorPaper;
  uniform vec3  uColorShade;
  uniform vec3  uColorTransmit;
  uniform vec3  uColorInk;
  uniform vec3  uColorCrease;

  uniform float uAmbient;
  uniform float uWrap;          // how far light bends around the sheet, 0..1
  uniform float uTransmit;      // how much comes through from behind
  uniform float uTransmitPower; // tightness of that lobe
  uniform float uSheen;         // grazing specular
  uniform float uGloss;

  uniform vec2  uSheetSize;
  uniform float uGrain;
  uniform float uGrainScale;    // fibres per metre
  uniform float uGrainAngle;    // radians
  uniform float uGrainAniso;    // how far the fibres are stretched
  uniform float uFleck;
  uniform float uLaid;
  uniform float uLaidPitch;     // lines per metre
  uniform float uChainPitch;    // the coarse chain lines, lines per metre

  uniform float uCreaseGlow;
  uniform float uCreaseDark;
  uniform float uCreaseSharp;

  uniform float uInk;
  uniform float uInkRows;
  uniform float uInkCols;
  uniform float uInkFill;
  uniform float uInkWeight;
  uniform float uInkMargin;
  uniform float uInkSeed;
  uniform float uInkGhost;      // how much the writing shows through the back

  uniform float uEdge;          // deckle edge softening
  uniform float uTintSpread;
  uniform float uOpacity;
  uniform float uWoundShade;    // how much darker the paper is on the roll

  ${noiseGLSL}

  varying vec2  vSheet;
  varying vec3  vWorld;
  varying vec3  vNormal;
  varying float vCrease;
  varying float vLayers;
  varying float vTint;
  varying float vFade;
  varying float vWound;

  /**
   * The writing.
   *
   * Hashed bars inside a grid of cells, in SHEET space — which is what makes it
   * fold and wrap correctly with no work at all. Four strokes per cell reads as
   * script at any distance a viewer will ever be at; the fifth stroke costs the
   * same and reads as noise, which was worth finding out once.
   */
  float inkField(vec2 sheet) {
    vec2 g = sheet + 0.5;
    float margin = uInkMargin;
    float inside = step(margin, g.x) * step(g.x, 1.0 - margin) *
                   step(margin, g.y) * step(g.y, 1.0 - margin);
    if (inside < 0.5) return 0.0;

    vec2 cells = vec2(max(uInkCols, 1.0), max(uInkRows, 1.0));
    vec2 uv = (g - margin) / max(1.0 - 2.0 * margin, 1e-3) * cells;
    vec2 id = floor(uv);
    vec2 f = fract(uv);

    float live = step(hash13(vec3(id, uInkSeed)) , uInkFill);
    if (live < 0.5) return 0.0;

    float ink = 0.0;
    float weight = max(uInkWeight, 0.002);
    for (int b = 0; b < 4; b++) {
      float bi = float(b);
      vec3 key = vec3(id, uInkSeed + bi * 17.31);
      float y = 0.18 + 0.64 * hash13(key);
      float x0 = 0.12 + 0.4 * hash13(key + 3.7);
      float x1 = x0 + 0.15 + 0.5 * hash13(key + 8.1);
      float vertical = step(0.72, hash13(key + 12.9));
      vec2 q = mix(f, f.yx, vertical);
      float bar = step(x0, q.x) * step(q.x, x1) *
                  (1.0 - smoothstep(weight * 0.6, weight, abs(q.y - y)));
      ink = max(ink, bar);
    }
    return clamp(ink, 0.0, 1.0);
  }

  void main() {
    if (vFade <= 0.001) discard;

    vec3 N = normalize(vNormal);
    if (!gl_FrontFacing) N = -N;
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 L = normalize(uLightDir);

    /* --- the grain, in sheet metres, stretched along the machine direction --- */
    vec2 metres = vSheet * uSheetSize;
    float ca = cos(uGrainAngle);
    float sa = sin(uGrainAngle);
    vec2 grainUV = vec2(metres.x * ca + metres.y * sa,
                        (-metres.x * sa + metres.y * ca) / max(uGrainAniso, 0.05));
    float fibre = fbm3(vec3(grainUV * uGrainScale, 0.0)) * 0.5 + 0.5;
    // Flecks are a hashed lattice, not a noise threshold: value noise piles up
    // at its midpoint, so thresholding it gives you either nothing or a rash.
    vec3 fleckCell = floor(vec3(grainUV * uGrainScale * 3.0, 0.0));
    float fleck = step(0.972, hash13(fleckCell)) * uFleck;

    float laid = (sin(metres.y * uLaidPitch * TAU) * 0.5 + 0.5) * uLaid;
    float chain = smoothstep(0.86, 1.0, sin(metres.x * uChainPitch * TAU) * 0.5 + 0.5) * uLaid;

    /* --- the writing --- */
    float ink = inkField(vSheet) * uInk;
    // Seen from the back, the writing is a shadow inside the sheet rather than
    // a mark on it. Fainter, and it never gets the ink's own colour.
    float inkFace = gl_FrontFacing ? ink : ink * uInkGhost;

    /* --- lighting: thin, matte, and lit from both sides ---------------- */
    float ndl = dot(N, L);
    float diffuse = clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0);
    // A sheet is thin enough that light behind it arrives at the eye. The lobe
    // is around -L, not around the mirror direction, and the ink blocks it —
    // which is the entire difference between paper and painted card.
    float through = pow(clamp(dot(V, -L), 0.0, 1.0), max(uTransmitPower, 0.5));
    through *= clamp(-ndl * 0.5 + 0.5, 0.0, 1.0) * uTransmit * (1.0 - ink);

    vec3 H = normalize(L + V);
    float spec = pow(clamp(dot(N, H), 0.0, 1.0), max(uGloss, 1.0));
    // Paper's sheen is grazing and anisotropic — it runs along the fibre.
    float graze = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
    spec *= uSheen * (0.35 + 0.65 * graze) * (0.7 + 0.6 * fibre);

    /* --- the crease --- */
    float creaseAmount = pow(clamp(abs(vCrease), 0.0, 1.0), max(uCreaseSharp, 0.2));
    float mountain = clamp(-vCrease, 0.0, 1.0);
    float valley = clamp(vCrease, 0.0, 1.0);

    /* --- put it together ----------------------------------------------- */
    vec3 body = mix(uColorShade, uColorPaper, diffuse);
    body = mix(body, uColorShade, (laid + chain) * 0.5);
    body *= 1.0 - fleck * 0.55;
    body = mix(body, uColorPaper * (0.9 + 0.2 * fibre), uGrain * 0.5);
    body = mix(body, uColorShade * 0.75, vWound * uWoundShade);

    // Deckle: the sheet thins at its edges, so it passes more light and holds
    // less pigment. Two lines, and it is what stops a rectangle reading as a
    // rectangle of plastic.
    vec2 fromEdge = 0.5 - abs(vSheet);
    float deckle = 1.0 - smoothstep(0.0, max(uEdge, 1e-4), min(fromEdge.x, fromEdge.y));

    body += uColorTransmit * (through + deckle * uTransmit * 0.6);
    body += uColorCrease * creaseAmount * uCreaseGlow * pow(mountain, 0.6);
    body *= 1.0 - creaseAmount * uCreaseDark * pow(valley, 0.6);
    body = mix(body, uColorInk, inkFace);
    body += vec3(spec) * (1.0 - ink);

    // Stacked flaps are more opaque and slightly darker: two sheets of paper.
    body *= 1.0 - clamp(vLayers, 0.0, 4.0) * 0.045;
    body *= 1.0 + (vTint - 0.5) * 2.0 * uTintSpread;
    body *= uAmbient + (1.0 - uAmbient) * uShaderIntensity;

    float alpha = uOpacity * vFade;
    alpha = mix(alpha, alpha * 0.82, deckle);

    gl_FragColor = vec4(max(body, vec3(0.0)), clamp(alpha, 0.0, 1.0));
  }
`;

/* ---------------------------------------------------------------- */
/* The module                                                        */
/* ---------------------------------------------------------------- */

export class FoldMesh {
  /**
   * @param {THREE.Object3D} parent the ability's group. Parent-first, like
   *   `Swarm` — this module owns its mesh and you never see it.
   * @param {object} [options]
   * @param {number} [options.pattern] `FoldPattern.*`. Live-swappable afterwards
   *   with `setPattern()`; no recompile, because the pattern is a uniform table
   *   and the mode is a uniform branch.
   * @param {number} [options.layout] `FoldLayout.*`
   * @param {number} [options.capacity] sheets in the pool
   * @param {number} [options.segments] grid resolution across the sheet. The
   *   crease is only as sharp as the grid can resolve: a hinge narrower than one
   *   cell quantises into a kink. 24 is a crane; a scroll wants 12 × 48.
   * @param {number} [options.segmentsV] resolution along the sheet; defaults to
   *   `segments`. `UNROLL` spends almost everything here.
   */
  constructor(parent, options = {}) {
    const {
      pattern = FoldPattern.CRANE,
      layout = FoldLayout.LINE,
      capacity = 32,
      segments = 20,
      segmentsV = segments,
      renderOrder = 4,
      layer = LAYER.WORLD,
      name = 'FoldMesh'
    } = options;

    this.capacity = Math.max(1, capacity | 0);
    this.group = new Group();
    this.group.name = name;
    this.group.matrixAutoUpdate = false;
    parent.add(this.group);

    /* --- the sheet's grid ------------------------------------------- */
    const nx = Math.max(1, segments | 0);
    const nz = Math.max(1, segmentsV | 0);
    const vertices = (nx + 1) * (nz + 1);
    const sheet = new Float32Array(vertices * 2);
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const o = (j * (nx + 1) + i) * 2;
        sheet[o] = i / nx - 0.5;
        sheet[o + 1] = j / nz - 0.5;
      }
    }
    const indices = new Uint16Array(nx * nz * 6);
    let w = 0;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i;
        const b = a + 1;
        const c = a + nx + 1;
        const d = c + 1;
        indices[w++] = a;
        indices[w++] = c;
        indices[w++] = b;
        indices[w++] = b;
        indices[w++] = c;
        indices[w++] = d;
      }
    }

    this._dice = new Float32Array(this.capacity * 4);
    this._diceB = new Float32Array(this.capacity * 4);
    const slots = new Float32Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) slots[i] = i;

    const geometry = new InstancedBufferGeometry();
    // The vertex shader needs no `position`, but three wants one to compute a
    // bounding sphere from and every downstream chunk assumes it exists.
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices * 3), 3));
    geometry.setAttribute('aSheet', new BufferAttribute(sheet, 2));
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.setAttribute('aDice', new InstancedBufferAttribute(this._dice, 4));
    geometry.setAttribute('aDiceB', new InstancedBufferAttribute(this._diceB, 4));
    geometry.setAttribute('aSlot', new InstancedBufferAttribute(slots, 1));
    geometry.instanceCount = 0;
    // Placed in world space by the vertex shader; its own bounds mean nothing.
    geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    this.geometry = geometry;

    /* --- the crease table lives in uniforms, allocated once ---------- */
    this._creaseLine = [];
    this._creaseFold = [];
    this._creaseGate = [];
    for (let i = 0; i < MAX_CREASES; i++) {
      this._creaseLine.push(new Vector4(0, 0, 0, 1));
      this._creaseFold.push(new Vector4(0, 0, 1, 1));
      this._creaseGate.push(new Vector4(0, 0, -9, 9));
    }

    this.material = new ShaderMaterial({
      name,
      transparent: true,
      depthWrite: true,
      depthTest: true,
      side: DoubleSide,
      // The one toneMapped material in this library. See the class header: it is
      // paper, not light, and an untonemapped white sheet blooms.
      toneMapped: true,
      uniforms: sharedUniforms({
        uSeed: { value: 0 },
        uMode: { value: pattern === FoldPattern.UNROLL ? 1 : 0 },

        uOrigin: { value: new Vector3() },
        uForward: { value: new Vector3(0, 0, 1) },
        uSide: { value: new Vector3(1, 0, 0) },
        uUp: { value: new Vector3(0, 1, 0) },
        uLength: { value: 12 },

        uLayout: { value: layout },
        uCount: { value: 0 },
        uTravel: { value: 0 },
        uSpread: { value: DEFAULTS.spread },
        uStretch: { value: DEFAULTS.stretch },
        uLift: { value: DEFAULTS.lift },
        uLiftJitter: { value: DEFAULTS.liftJitter },
        uRadius: { value: DEFAULTS.radius },
        uRadiusJitter: { value: DEFAULTS.radiusJitter },
        uArc: { value: DEFAULTS.arc },
        uArcPhase: { value: DEFAULTS.arcPhase },

        uPitch: { value: DEFAULTS.pitch },
        uYaw: { value: DEFAULTS.yaw },
        uYawJitter: { value: DEFAULTS.yawJitter },
        uRoll: { value: DEFAULTS.roll },
        uRollJitter: { value: DEFAULTS.rollJitter },
        uBob: { value: DEFAULTS.bob },
        uBobRate: { value: DEFAULTS.bobRate },
        uTumble: { value: DEFAULTS.tumble },
        uSizeJitter: { value: DEFAULTS.sizeJitter },

        uSpreadStagger: { value: DEFAULTS.foldStagger },
        uReveal: { value: DEFAULTS.reveal },
        uRevealSpread: { value: DEFAULTS.revealSpread },

        uSheetSize: { value: new Vector2(DEFAULTS.sheetWidth, DEFAULTS.sheetLength) },
        uProgress: { value: DEFAULTS.progress },
        uFoldGain: { value: DEFAULTS.foldGain },
        uHinge: { value: DEFAULTS.hinge },
        uStageEase: { value: DEFAULTS.stageEase },
        uThickness: { value: DEFAULTS.thickness },
        uCreaseCount: { value: 0 },
        uCreaseLine: { value: this._creaseLine },
        uCreaseFold: { value: this._creaseFold },
        uCreaseGate: { value: this._creaseGate },

        uPayout: { value: DEFAULTS.payout },
        uCore: { value: DEFAULTS.core },
        uPaper: { value: DEFAULTS.paper },
        uCurl: { value: DEFAULTS.curl },
        uSpoolClimb: { value: DEFAULTS.spoolClimb },
        uSpin: { value: DEFAULTS.spin },

        uColorPaper: { value: new Color(DEFAULTS.colorPaper) },
        uColorShade: { value: new Color(DEFAULTS.colorShade) },
        uColorTransmit: { value: new Color(DEFAULTS.colorTransmit) },
        uColorInk: { value: new Color(DEFAULTS.colorInk) },
        uColorCrease: { value: new Color(DEFAULTS.colorCrease) },

        uAmbient: { value: DEFAULTS.ambient },
        uWrap: { value: DEFAULTS.wrap },
        uTransmit: { value: DEFAULTS.transmit },
        uTransmitPower: { value: DEFAULTS.transmitPower },
        uSheen: { value: DEFAULTS.sheen },
        uGloss: { value: DEFAULTS.gloss },

        uGrain: { value: DEFAULTS.grain },
        uGrainScale: { value: DEFAULTS.grainScale },
        uGrainAngle: { value: DEFAULTS.grainAngle },
        uGrainAniso: { value: DEFAULTS.grainAniso },
        uFleck: { value: DEFAULTS.fleck },
        uLaid: { value: DEFAULTS.laid },
        uLaidPitch: { value: DEFAULTS.laidPitch },
        uChainPitch: { value: DEFAULTS.chainPitch },

        uCreaseGlow: { value: DEFAULTS.creaseGlow },
        uCreaseDark: { value: DEFAULTS.creaseDark },
        uCreaseSharp: { value: DEFAULTS.creaseSharp },

        uInk: { value: DEFAULTS.ink },
        uInkRows: { value: DEFAULTS.inkRows },
        uInkCols: { value: DEFAULTS.inkCols },
        uInkFill: { value: DEFAULTS.inkFill },
        uInkWeight: { value: DEFAULTS.inkWeight },
        uInkMargin: { value: DEFAULTS.inkMargin },
        uInkSeed: { value: DEFAULTS.inkSeed },
        uInkGhost: { value: DEFAULTS.inkGhost },

        uEdge: { value: DEFAULTS.edge },
        uTintSpread: { value: DEFAULTS.tintSpread },
        uOpacity: { value: DEFAULTS.opacity },
        uWoundShade: { value: DEFAULTS.woundShade }
      }),
      vertexShader: FOLD_VERTEX,
      fragmentShader: FOLD_FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.layers.set(layer);
    this.mesh.renderOrder = renderOrder;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.group.add(this.mesh);

    /* --- the basis --------------------------------------------------- */
    this._origin = new Vector3();
    this._direction = new Vector3(0, 0, 1);
    this._side = new Vector3(1, 0, 0);
    this._up = new Vector3(0, 1, 0);
    this._length = 1;

    /** The last block `update()` resolved. Owned, written into, never replaced. */
    this._p = foldMeshParams();
    this.pattern = pattern;
    this.liveSheets = 0;
    this.seed = 0;

    this.setPattern(pattern);
    this.roll(0);
  }

  /* ---------------- handles ---------------- */

  get uniforms() {
    return this.material.uniforms;
  }

  /** Sheets drawn on the last update. → `Ability#instanceCount`. */
  get count() {
    return this.liveSheets;
  }

  /** One, however many sheets. */
  get drawCalls() {
    return 1;
  }

  get visible() {
    return this.group.visible;
  }

  set visible(v) {
    this.group.visible = !!v;
  }

  /** Where the flock stands. LINE ⇄ ZONE ⇄ SINGLE, a uniform branch. */
  get layout() {
    return this.material.uniforms.uLayout.value;
  }

  set layout(l) {
    this.material.uniforms.uLayout.value = l | 0;
  }

  /**
   * Load a crease table.
   *
   * Writes into the twelve `Vector4`s allocated at construction, so this is
   * free to call every frame if an ability wants to morph between patterns —
   * and it does not recompile, because the pattern is data and the crease/unroll
   * split is a uniform branch.
   *
   * @param {number|Crease[]} pattern a `FoldPattern` or your own table
   */
  setPattern(pattern) {
    const table = Array.isArray(pattern) ? pattern : (CREASE_PATTERNS[pattern] ?? []);
    const n = Math.min(MAX_CREASES, table.length);
    for (let i = 0; i < MAX_CREASES; i++) {
      const line = this._creaseLine[i];
      const fold = this._creaseFold[i];
      const gate = this._creaseGate[i];
      if (i >= n) {
        fold.set(0, 0, 1, 1);
        continue;
      }
      const c = table[i];
      const dx = c.dir?.[0] ?? 0;
      const dy = c.dir?.[1] ?? 1;
      const len = Math.hypot(dx, dy) || 1;
      line.set(c.o?.[0] ?? 0, c.o?.[1] ?? 0, dx / len, dy / len);
      fold.set(c.turns ?? 0, c.t0 ?? 0, c.t1 ?? 1, c.hinge ?? 1);
      if (c.gate) {
        const gl = Math.hypot(c.gate[0], c.gate[1]) || 1;
        gate.set(c.gate[0] / gl, c.gate[1] / gl, c.span?.[0] ?? -9, c.span?.[1] ?? 9);
      } else {
        gate.set(0, 0, -9, 9);
      }
    }
    this.material.uniforms.uCreaseCount.value = n;
    if (!Array.isArray(pattern)) {
      this.pattern = pattern;
      this.material.uniforms.uMode.value = pattern === FoldPattern.UNROLL ? 1 : 0;
    }
    return this;
  }

  /**
   * Five pickers, none derived from another.
   *
   * Takes `THREE.Color`s or `#rrggbb` straight out of a settings block; the
   * strings go through the memoised `getColor`, so calling this every frame
   * costs five copies and no allocation.
   */
  setColors(paper, shade, transmit, ink, crease) {
    const u = this.material.uniforms;
    // Written out rather than looped through a helper closure: a closure built
    // inside a per-frame call allocates, and this is a per-frame call (I3).
    putColor(u.uColorPaper.value, paper, DEFAULTS.colorPaper);
    putColor(u.uColorShade.value, shade, DEFAULTS.colorShade);
    putColor(u.uColorTransmit.value, transmit, DEFAULTS.colorTransmit);
    putColor(u.uColorInk.value, ink, DEFAULTS.colorInk);
    putColor(u.uColorCrease.value, crease, DEFAULTS.colorCrease);
    return this;
  }

  /** The cast's frame. Called once per frame by the ability. */
  setBasis(origin, direction, side, length) {
    this._origin.copy(origin);
    this._direction.copy(direction);
    this._side.copy(side);
    this._up.crossVectors(this._direction, this._side).normalize();
    if (this._up.lengthSq() < 0.5) this._up.set(0, 1, 0);
    this._length = Math.max(0.01, length);
    return this;
  }

  /**
   * Re-roll the per-sheet dice. Call from `onSpawn` and nowhere else.
   *
   * Four dice and four more: where the sheet sits across and along the lane, how
   * high, how big, its bearing, its bob phase, its tint and its place in the
   * fold stagger. Every one of them unitless — where they land in metres is
   * decided by `update()` every frame, which is why a paused flock re-lays
   * itself under `spread` and re-folds under `progress`.
   *
   * @param {number} [seed] per-cast seed; shifts the whole flock
   */
  roll(seed = Math.random() * 100) {
    this.seed = seed;
    this.material.uniforms.uSeed.value = seed;
    for (let i = 0; i < this.capacity; i++) {
      const o = i * 4;
      this._dice[o] = Math.random();
      this._dice[o + 1] = Math.random();
      this._dice[o + 2] = Math.random();
      this._dice[o + 3] = Math.random();
      this._diceB[o] = Math.random();
      this._diceB[o + 1] = Math.random();
      this._diceB[o + 2] = Math.random();
      this._diceB[o + 3] = Math.random();
    }
    this.geometry.getAttribute('aDice').needsUpdate = true;
    this.geometry.getAttribute('aDiceB').needsUpdate = true;
    return this;
  }

  /** Hide the flock. Leaves the instance reusable — the pooling contract. */
  reset() {
    this.liveSheets = 0;
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
    return this;
  }

  /**
   * Fill `_p` from the caller's block, defaults where it is silent.
   *
   * A `for...in` over eighty keys per frame is a rounding error next to one
   * uniform upload, and it is what lets an ability hand this module its raw
   * `settings[id]` — the version of the contract that cannot be got wrong.
   */
  _resolve(params) {
    const p = this._p;
    for (const key in DEFAULTS) {
      const value = params[key];
      p[key] = value === undefined ? DEFAULTS[key] : value;
    }
    return p;
  }

  /**
   * Push the live params into the uniforms.
   *
   * @param {number} _now seconds since the cast began. Accepted for symmetry
   *   with the rest of the library and unused: a sheet's motion is a standing
   *   one driven by the shared `uTime`, and its fold is driven by `progress`,
   *   which the ability owns because the *staging* is the ability.
   * @param {object} params live block; anything absent falls back to
   *   `foldMeshParams()`.
   */
  update(_now, params) {
    const p = this._resolve(params ?? DEFAULTS);
    const u = this.material.uniforms;

    const count = Math.max(0, Math.min(this.capacity, Math.round(p.count)));
    this.liveSheets = count;
    this.geometry.instanceCount = count;
    this.mesh.visible = count > 0 && p.opacity > 0 && p.sheetWidth > 0 && p.sheetLength > 0;

    u.uOrigin.value.copy(this._origin);
    u.uForward.value.copy(this._direction);
    u.uSide.value.copy(this._side);
    u.uUp.value.copy(this._up);
    u.uLength.value = this._length;

    u.uCount.value = count;
    u.uTravel.value = p.travel;
    u.uSpread.value = p.spread;
    u.uStretch.value = p.stretch;
    u.uLift.value = p.lift;
    u.uLiftJitter.value = p.liftJitter;
    u.uRadius.value = p.radius;
    u.uRadiusJitter.value = p.radiusJitter;
    u.uArc.value = p.arc;
    u.uArcPhase.value = p.arcPhase;

    u.uPitch.value = p.pitch;
    u.uYaw.value = p.yaw;
    u.uYawJitter.value = p.yawJitter;
    u.uRoll.value = p.roll;
    u.uRollJitter.value = p.rollJitter;
    u.uBob.value = p.bob;
    u.uBobRate.value = p.bobRate;
    u.uTumble.value = p.tumble;
    u.uSizeJitter.value = p.sizeJitter;

    u.uSpreadStagger.value = p.foldStagger;
    u.uReveal.value = p.reveal;
    u.uRevealSpread.value = p.revealSpread;

    /* --- the sheet and the fold ------------------------------------- */
    // aspect is a multiplier on the across axis. A crane wants 1; see the header.
    u.uSheetSize.value.set(p.sheetWidth * p.aspect, p.sheetLength);
    u.uProgress.value = p.progress;
    u.uFoldGain.value = p.foldGain;
    u.uHinge.value = p.hinge;
    u.uStageEase.value = p.stageEase;
    u.uThickness.value = p.thickness;

    u.uPayout.value = p.payout;
    u.uCore.value = p.core;
    u.uPaper.value = p.paper;
    u.uCurl.value = p.curl;
    u.uSpoolClimb.value = p.spoolClimb;
    u.uSpin.value = p.spin;

    /* --- shading ------------------------------------------------------ */
    u.uAmbient.value = p.ambient;
    u.uWrap.value = p.wrap;
    u.uTransmit.value = p.transmit;
    u.uTransmitPower.value = p.transmitPower;
    u.uSheen.value = p.sheen;
    u.uGloss.value = p.gloss;

    u.uGrain.value = p.grain;
    u.uGrainScale.value = p.grainScale;
    u.uGrainAngle.value = p.grainAngle;
    u.uGrainAniso.value = p.grainAniso;
    u.uFleck.value = p.fleck;
    u.uLaid.value = p.laid;
    u.uLaidPitch.value = p.laidPitch;
    u.uChainPitch.value = p.chainPitch;

    u.uCreaseGlow.value = p.creaseGlow;
    u.uCreaseDark.value = p.creaseDark;
    u.uCreaseSharp.value = p.creaseSharp;

    u.uInk.value = p.ink;
    u.uInkRows.value = p.inkRows;
    u.uInkCols.value = p.inkCols;
    u.uInkFill.value = p.inkFill;
    u.uInkWeight.value = p.inkWeight;
    u.uInkMargin.value = p.inkMargin;
    u.uInkSeed.value = p.inkSeed;
    u.uInkGhost.value = p.inkGhost;

    u.uEdge.value = p.edge;
    u.uTintSpread.value = p.tintSpread;
    u.uOpacity.value = p.opacity;
    u.uWoundShade.value = p.woundShade;
    return this;
  }

  /**
   * Where sheet `index` is standing, in world space.
   *
   * The CPU mirror of the placement half of the vertex shader — the ability
   * needs it to hang a light, a burst or an emitter on a sheet. It deliberately
   * does **not** mirror the fold: nothing on the CPU needs to know where the
   * crane's head got to, and a second copy of the fold would be a second thing
   * to keep in step. Mirror, so if you change one change the other.
   *
   * @param {number} index sheet slot
   * @param {object} p live params — the same block you hand `update()`
   * @param {THREE.Vector3} out written into and returned
   */
  sheetPoint(index, p, out) {
    const i = Math.max(0, Math.min(this.capacity - 1, index | 0)) * 4;
    const d0 = this._dice[i];
    const d1 = this._dice[i + 1];
    const d2 = this._dice[i + 2];
    const b0 = this._diceB[i];
    const count = Math.max(1, Math.min(this.capacity, Math.round(p.count ?? DEFAULTS.count)));
    const layout = this.material.uniforms.uLayout.value;

    if (layout === FoldLayout.ZONE) {
      const arc = p.arc ?? DEFAULTS.arc;
      const bearing =
        (p.arcPhase ?? DEFAULTS.arcPhase) +
        ((index + 0.5) / count) * arc +
        (b0 - 0.5) * 0.35 * (arc / count);
      const r = (p.radius ?? DEFAULTS.radius) * (1 + (d0 - 0.5) * 2 * (p.radiusJitter ?? DEFAULTS.radiusJitter));
      out
        .copy(this._origin)
        .addScaledVector(this._side, Math.cos(bearing) * r)
        .addScaledVector(this._direction, Math.sin(bearing) * r);
    } else if (layout === FoldLayout.SINGLE) {
      out.copy(this._origin).addScaledVector(this._direction, (p.travel ?? 0) * this._length);
    } else {
      const along = (p.travel ?? 0) * this._length + (d1 - 0.5) * 2 * (p.stretch ?? DEFAULTS.stretch);
      out
        .copy(this._origin)
        .addScaledVector(this._direction, along)
        .addScaledVector(this._side, (d0 - 0.5) * 2 * (p.spread ?? DEFAULTS.spread));
    }
    out.addScaledVector(
      this._up,
      (p.lift ?? DEFAULTS.lift) + (d2 - 0.5) * 2 * (p.liftJitter ?? DEFAULTS.liftJitter)
    );
    return out;
  }

  /**
   * Where the spool of sheet `index` is, in world space — `UNROLL` only.
   *
   * The roll climbs as the paper pays out, so this is where the dust comes off
   * and where a light wants to be. Zero payout puts it a whole sheet-length up
   * the standing axis; full payout puts it at the free end.
   */
  spoolPoint(index, p, out) {
    this.sheetPoint(index, p, out);
    const length = p.sheetLength ?? DEFAULTS.sheetLength;
    const payout = saturate(p.payout ?? DEFAULTS.payout);
    const climb = saturate(p.spoolClimb ?? DEFAULTS.spoolClimb);
    const kappa = p.curl ?? DEFAULTS.curl;
    const a = payout * length;
    // Same arc as the shader, same guard. Mirror.
    const run = Math.abs(kappa) > 1e-3 ? Math.sin(kappa * a) / kappa : a;
    const axis = this.material.uniforms.uLayout.value === FoldLayout.ZONE ? this._up : this._direction;
    return out.addScaledVector(axis, run * climb);
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
 * Call it to seed a scratch block you fill from `settings[id]` each frame, or
 * ignore it and hand `update()` your settings block — anything absent falls back
 * to the value here. Defaults exist so that a forgotten field gives paper rather
 * than a `NaN`, which is the most expensive mistake to debug in this codebase.
 */
export function foldMeshParams() {
  return {
    /* --- how many --- */
    count: 12, // live sheets, clamped to capacity

    /* --- the sheet --- */
    sheetWidth: 0.42, // metres across (the u axis)
    sheetLength: 0.42, // metres along (the v axis)
    aspect: 1, // multiplier on the width. CRANE wants 1 — see the header.
    sizeJitter: 0.18, // ±fraction per sheet
    thickness: 0.0008, // metres of paper, per stacked flap. Kills the z-fight.

    /* --- the fold: the one slider --- */
    progress: 1, // 0 flat, 1 folded. Run it backwards to unfold.
    foldGain: 1, // multiplier on every crease angle; >1 overfolds
    hinge: 0.02, // metres — the crease radius. Under one grid cell it kinks.
    stageEase: 1, // 0 linear stage windows, 1 smoothstepped
    foldStagger: 0.35, // fraction of progress spread across the flock

    /* --- UNROLL --- */
    payout: 0.5, // 0..1 of the sheet off the roll
    core: 0.03, // metres — the spool's core radius
    paper: 0.0006, // metres — paper thickness. Sets how fast the roll grows.
    curl: 0.35, // 1/metres of residual curvature in the paid-out run
    spoolClimb: 1, // 0 spool fixed and the sheet falls, 1 the wall rises
    spin: 0, // radians of phase on the roll

    /* --- the flock --- */
    travel: 0, // 0..1 of the cast the flock has covered
    spread: 1.2, // metres of lateral scatter (LINE)
    stretch: 1.6, // metres of along-line scatter (LINE)
    lift: 1.2, // metres off the floor
    liftJitter: 0.5, // ±metres
    radius: 3.5, // metres (ZONE)
    radiusJitter: 0.12, // ±fraction
    arc: 6.283185307179586, // radians the ZONE ring covers
    arcPhase: 0, // radians

    /* --- attitude --- */
    pitch: 0, // radians, nose up
    yaw: 0, // radians
    yawJitter: 0.5, // ±radians
    roll: 0, // radians of bank
    rollJitter: 0.35, // ±radians
    bob: 0.09, // metres of vertical breathing
    bobRate: 2.1, // radians/second
    tumble: 0, // radians/second about the sheet's normal

    /* --- appearing --- */
    reveal: 1, // 0..1 — sheets appear as this passes their dice
    revealSpread: 0.3, // width of that wave

    /* --- shading --- */
    ambient: 0.45, // floor under the diffuse term
    wrap: 0.35, // how far light bends around the sheet, 0..1
    transmit: 0.55, // how much light comes through from behind
    transmitPower: 6, // tightness of that lobe
    sheen: 0.25, // grazing specular
    gloss: 24, // specular exponent

    grain: 0.5, // how much fibre shows in the albedo
    grainScale: 55, // fibres per metre
    grainAngle: 0.2, // radians — the machine direction
    grainAniso: 9, // how far the fibres are stretched along it
    fleck: 0.3, // sparse darker specks in the pulp
    laid: 0.16, // the regular ribbing of a laid sheet
    laidPitch: 42, // lines per metre, the fine ones
    chainPitch: 1.6, // lines per metre, the coarse chain lines

    creaseGlow: 0.5, // how much a mountain crease catches
    creaseDark: 0.35, // how much a valley crease holds shadow
    creaseSharp: 1.6, // exponent on the band profile — apparent width

    /* --- the writing --- */
    ink: 0, // 0 blank paper, 1 fully written
    inkRows: 14, // characters down the sheet
    inkCols: 5, // columns across
    inkFill: 0.8, // fraction of cells that carry a mark
    inkWeight: 0.07, // stroke half-width, cell units
    inkMargin: 0.08, // fraction of the sheet left blank at the edges
    inkSeed: 3.7, // shifts the whole text
    inkGhost: 0.35, // how much the writing shows through the back

    /* --- the sheet as an object --- */
    edge: 0.02, // deckle: fraction of the sheet the edge thins over
    tintSpread: 0.06, // ±per-sheet brightness walk
    opacity: 1,
    woundShade: 0.35, // how much darker the paper is on the roll

    /* --- colour: five pickers, none derived --- */
    colorPaper: '#efe7d6',
    colorShade: '#b6a992',
    colorTransmit: '#ffe9bd',
    colorInk: '#241d18',
    colorCrease: '#fffaf0'
  };
}

/** Resolved once at module load; `_resolve` walks its keys every frame. */
const DEFAULTS = foldMeshParams();

/**
 * Editor schema fragment. Spread into an ability's schema so the sheet, the
 * fold and the paper get sensible ranges without every ability re-deriving them.
 */
export function foldMeshSchema(label = 'Paper') {
  return {
    [`${label} · sheet`]: [
      ['sheetWidth', 0.05, 4, 0.01, 'width (m)'],
      ['sheetLength', 0.05, 8, 0.01, 'length (m)'],
      ['aspect', 0.25, 4, 0.01],
      ['sizeJitter', 0, 1, 0.01, 'size jitter'],
      ['thickness', 0, 0.006, 0.0001, 'paper (m)']
    ],
    [`${label} · fold`]: [
      ['progress', -0.2, 1.2, 0.001],
      ['foldGain', 0, 1.6, 0.01, 'fold gain'],
      ['hinge', 0.002, 0.2, 0.001, 'crease radius (m)'],
      ['stageEase', 0, 1, 0.01, 'stage ease'],
      ['foldStagger', 0, 1, 0.01, 'flock stagger']
    ],
    [`${label} · unroll`]: [
      ['payout', 0, 1, 0.001],
      ['core', 0.005, 0.3, 0.001, 'core (m)'],
      ['paper', 0.0001, 0.004, 0.00005, 'thickness (m)'],
      ['curl', -1.5, 1.5, 0.01, 'curl (1/m)'],
      ['spoolClimb', 0, 1, 0.01, 'spool climbs'],
      ['spin', 0, 6.283, 0.01]
    ],
    [`${label} · surface`]: [
      ['grain', 0, 1, 0.01],
      ['grainScale', 4, 200, 1, 'fibres/m'],
      ['grainAngle', 0, 3.142, 0.01, 'grain angle'],
      ['grainAniso', 1, 30, 0.5, 'grain stretch'],
      ['fleck', 0, 1, 0.01],
      ['laid', 0, 0.6, 0.01, 'laid lines'],
      ['laidPitch', 4, 120, 1, 'laid/m'],
      ['chainPitch', 0.2, 8, 0.05, 'chain/m'],
      ['creaseGlow', 0, 2, 0.01, 'crease glow'],
      ['creaseDark', 0, 1, 0.01, 'crease shadow'],
      ['creaseSharp', 0.2, 5, 0.05, 'crease width'],
      ['transmit', 0, 2, 0.01],
      ['transmitPower', 0.5, 24, 0.5, 'transmit focus'],
      ['wrap', 0, 1, 0.01, 'light wrap'],
      ['sheen', 0, 1.5, 0.01],
      ['gloss', 2, 128, 1],
      ['edge', 0, 0.15, 0.001, 'deckle'],
      'colorPaper',
      'colorShade',
      'colorTransmit',
      'colorCrease'
    ],
    [`${label} · writing`]: [
      ['ink', 0, 1, 0.01],
      ['inkRows', 1, 40, 1, 'rows'],
      ['inkCols', 1, 16, 1, 'columns'],
      ['inkFill', 0, 1, 0.01, 'fill'],
      ['inkWeight', 0.01, 0.3, 0.005, 'stroke'],
      ['inkMargin', 0, 0.3, 0.005, 'margin'],
      ['inkSeed', 0, 40, 0.1, 'seed'],
      ['inkGhost', 0, 1, 0.01, 'shows through'],
      'colorInk'
    ]
  };
}
