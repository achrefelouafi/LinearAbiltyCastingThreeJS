import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  FrontSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Sphere,
  Vector3
} from 'three';
import { Swarm, swarmParams } from './Swarm.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { getColor } from '../utils/color.js';
import { clamp, saturate, hash11 } from '../utils/math.js';

/* ====================================================================== */
/*  Colony.js — the Hive school's four tricks                             */
/* ====================================================================== */

/**
 * Four renderers for **many small things behaving as one**, in one file
 * because they share a vocabulary rather than a shader: a unitless structural
 * description rolled once, and every metre in it resolved from a live params
 * object each frame.
 *
 *   1. `ColonySwarm`  — a flock that condenses onto a signed distance field, so
 *                       the cloud *becomes* a fist, a wall or a spear and then
 *                       comes apart again. Serves `locusttide`, `waspfunnel`
 *                       and the swarm half of `broodburst`.
 *   2. `WebGraph`     — sagging strands between anchor points **plus the film
 *                       between them**, built from the graph's own faces.
 *                       Serves `webline`.
 *   3. `LatticeGrowth`— hexagonal cells building outward from a seed on a
 *                       lattice their neighbours defined, with overlapping
 *                       candidates refused. Serves `hivecolumn`.
 *   4. `PlateShell`   — a spherical Voronoi tessellation whose cells are chitin
 *                       plates that fly in and lock. Serves `carapace`.
 *
 * ## Conventions, which are the same for all four
 *
 * **Parent-first.** `new X(parent, options)` — every class here builds its own
 * meshes and adds them to `parent`. There is no `.object3D` to hang yourself,
 * and no class here owns more than two meshes.
 *
 * **Canonical settings.** Each class has an `xxxParams()` returning every key it
 * understands with its default and its unit; `update()` reads `p.key ?? default`
 * every frame. Hand it `settings[id]` outright if your block uses these names.
 *
 * **The clock.** `LatticeGrowth.update(now, p)` and `PlateShell.update(now, p)`
 * take **`now`** — the ability's `age` in seconds — because both are staggered
 * builds and the stagger is measured against it. `ColonySwarm.update(_now, p)`
 * and `WebGraph.update(_now, p)` **ignore** the first argument, as `Swarm` and
 * `Curtain` do: their motion is a standing one driven by `frame.uTime` in the
 * shader, and a web should not stop swaying because the ability was re-cast.
 *
 * ## Why one file
 *
 * The first cut of this was four files. It was worse. Three of these four share
 * `COLONY_CHITIN_GLSL` — one wrapped-diffuse-plus-fresnel chunk that is what
 * makes chitin read as chitin rather than as plastic — and two of them share the
 * same "roll a unitless structure, rebuild only when its *shape* hash changes,
 * resolve every metre in the vertex shader" skeleton. Split across files that
 * became either a fifth module nobody could name or four divergent copies. It is
 * one file, sectioned, and the sections are independent.
 */

/* ---------------------------------------------------------------------- */
/* Scratch — the frame allocates nothing (I3)                              */
/* ---------------------------------------------------------------------- */

const _v0 = new Vector3();
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();

const TAU = Math.PI * 2;

/** Golden angle, in radians. The one irrational that spaces a spiral evenly. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/* ---------------------------------------------------------------------- */
/* The shared look                                                         */
/* ---------------------------------------------------------------------- */

/**
 * Chitin, in eighteen lines.
 *
 * Three terms, and the order matters. A **wrapped** diffuse (`n·l` remapped
 * from -1..1 rather than clamped at zero) because a beetle's shell is thin
 * enough to bleed light through the far side, and a hard terminator on a curved
 * plate reads as painted metal. A **fresnel** rim, because the shine on chitin
 * is almost entirely grazing — this is the term that separates it from plastic.
 * And a **sheen** lobe on the half vector with a narrow exponent, which is the
 * oily highlight that slides across a carapace as the camera moves.
 *
 * The first version was a plain Lambert plus an additive rim colour. It read as
 * a painted sphere: the rim sat at a fixed width all the way round because a
 * constant rim does not know where the light is, and the moment two plates met
 * at an angle the seam vanished. Weighting the rim by the fresnel *and* the
 * sheen by the light direction is what makes an edge-on plate flare and a
 * face-on one go matte.
 */
const COLONY_CHITIN_GLSL = /* glsl */ `
  /**
   * n  surface normal (unit, world)
   * v  direction to the eye (unit, world)
   * l  direction to the key light (unit, world)
   * wrap   0 hard terminator, 1 fully wrapped
   * rimPow fresnel exponent
   */
  vec3 chitin(vec3 n, vec3 v, vec3 l, vec3 body, vec3 rimColour, vec3 sheenColour,
              float wrap, float rimPow, float rimGain, float sheenPow, float sheenGain) {
    float ndl = dot(n, l);
    float diffuse = mix(max(ndl, 0.0), ndl * 0.5 + 0.5, clamp(wrap, 0.0, 1.0));
    float ndv = clamp(abs(dot(n, v)), 0.0, 1.0);
    float rim = pow(1.0 - ndv, max(rimPow, 0.1));
    vec3 h = normalize(l + v);
    float sheen = pow(clamp(dot(n, h), 0.0, 1.0), max(sheenPow, 1.0));
    return body * (0.18 + 0.82 * diffuse)
         + rimColour * (rim * rimGain)
         + sheenColour * (sheen * sheenGain);
  }
`;

/* ====================================================================== */
/*  §1 · SDF-targeted swarm                                               */
/* ====================================================================== */

/**
 * The shapes a colony can condense into.
 *
 * Six, deliberately: enough that a transition between two of them is legible as
 * *this became that*, few enough that every one of them is recognisable from
 * across the arena at agent scale. A silhouette that needs a second look is not
 * a silhouette.
 *
 * They are authored in a **unit space** — the field is evaluated in roughly
 * `[-1, 1]³` with `x` lateral, `y` up and `z` downrange — and the metres arrive
 * afterwards as `shapeWidth/Height/Depth`. That split is what keeps invariant
 * I1: no shape in here knows how big it is.
 */
export const ColonyShape = Object.freeze({
  /** A ball. The resting state, and the thing every other shape reads against. */
  BALL: 0,
  /** A slab broadside to the caster — the swarm as a wall you cannot walk into. */
  WALL: 1,
  /** A shaft with a spindle head, pointing downrange. */
  SPEAR: 2,
  /** A closed fist: palm, four knuckles, a thumb folded across. */
  FIST: 3,
  /** A torus about the cast axis — a hoop to fly through. */
  RING: 4,
  /** A standing pillar. What a funnel condenses into at the top of its surge. */
  COLUMN: 5
});

/** Editor-facing labels, index-aligned with `ColonyShape`. */
export const COLONY_SHAPE_NAMES = Object.freeze([
  'ball',
  'wall',
  'spear',
  'fist',
  'ring',
  'column'
]);

/**
 * The distance-field library and the projection that samples it.
 *
 * ### Why a projection and not rejection sampling
 *
 * The obvious way to scatter agents through a shape is to draw points in its
 * bounding box and throw away the ones outside it. That cannot be done here for
 * two reasons and both of them are fatal. A shader has no unbounded loop, so
 * "keep drawing until one lands inside" has no expressible form; and even given
 * one, the number of draws an agent needs depends on the shape, so an agent's
 * final position would *change identity* the moment the shape morphed — the
 * whole cloud would boil rather than flow.
 *
 * So: every agent draws **one** point from its own dice, once, and then walks
 * that point onto the isosurface by gradient descent. Rejection-free by
 * construction, and stable by construction — the dice never change, so an agent
 * keeps its own place in the shape and morphs across with it. That stability is
 * the entire difference between "the swarm formed a fist" and "the swarm
 * dissolved and a fist appeared".
 *
 * ### Why the fields are blended and not the points
 *
 * `mix(pointInA, pointInB, k)` is a crossfade: at `k = 0.5` every agent is
 * halfway between two unrelated places and the intermediate state is a smear
 * with no shape at all. `mix(fieldA, fieldB, k)` is a **morph**: the blended
 * field is a real distance-ish field at every `k`, so the intermediate states
 * are themselves shapes — a fist growing a point, a wall drawing itself into a
 * spear. Locusttide's trick is the transition, so the transition is what had to
 * be a real object.
 *
 * The price is honest: both shapes are evaluated at every tap even when the
 * blend is 0 or 1. Roughly forty field evaluations per vertex at the default
 * three steps, which is a rounding error in a vertex shader and buys the only
 * feature anybody will notice.
 *
 * ### Why the interior fill is an isolevel and not a second scatter
 *
 * Projecting every agent to `d = 0` gives a hollow shell, and a hollow swarm
 * looks like a balloon. Each agent instead targets `d = -fill · dice`, so it
 * lands somewhere inside on its own private isosurface. Same descent, same cost,
 * a solid mass — and `fill` is a slider, so the same cast can go from a skin of
 * insects to a packed body.
 */
const COLONY_SDF_GLSL = /* glsl */ `
  /* --- the target shape ------------------------------------------- */
  uniform int   uShapeA;        // ColonyShape.*
  uniform int   uShapeB;        // the shape being morphed toward
  uniform float uShapeBlend;    // 0 all A, 1 all B — blends the FIELDS
  uniform float uCondense;      // 0 pure flock, 1 pure shape
  uniform vec3  uShapeSize;     // metres: half-width, half-height, half-depth
  uniform vec3  uShapeOffset;   // metres from the lead: forward, side, up
  uniform float uShapeSpin;     // radians/second about the world up axis
  uniform float uShapeFill;     // 0 a shell of agents, 1 a solid body
  uniform float uShapeSteps;    // descent steps, 1..4
  uniform float uShapeSlack;    // fraction of each step taken (under-relaxation)
  uniform float uShapeRough;    // unitless slop on the landed target

  /* --- the density wave ------------------------------------------- */
  uniform float uWaveAmp;       // metres of longitudinal bunching
  uniform float uWaveLength;    // metres between crests
  uniform float uWaveSpeed;     // metres/second the crests travel
  uniform vec3  uWaveAxis;      // unit, world space — normalised on the CPU

  /* --- crawling ----------------------------------------------------- */
  uniform float uCling;         // 0 flying, 1 pinned to the floor
  uniform float uFloorY;        // metres
  uniform float uCrawlHeight;   // metres above the floor a crawler rides

  /* --- primitives, all in unit space -------------------------------- */

  /** Polynomial smooth minimum. A hard union creases; a hive does not. */
  float colonySmin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / max(k, 1e-4), 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
  }

  float colonyBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return min(max(q.x, max(q.y, q.z)), 0.0) + length(max(q, 0.0));
  }

  float colonyCapsule(vec3 p, vec3 a, vec3 b, float r) {
    vec3 pa = p - a;
    vec3 ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
    return length(pa - ba * h) - r;
  }

  /** Torus about +z, so the hoop faces downrange. */
  float colonyTorus(vec3 p, float bigR, float smallR) {
    vec2 q = vec2(length(p.xy) - bigR, p.z);
    return length(q) - smallR;
  }

  float colonyCylinderY(vec3 p, float r, float h) {
    vec2 d = vec2(length(p.xz) - r, abs(p.y) - h);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
  }

  /**
   * The fist.
   *
   * Palm, four knuckles and a thumb, smooth-unioned. The knuckles are the whole
   * read: a rounded box alone is a brick, and it is the four bumps along its
   * top-front edge that the eye resolves as a hand at fifteen metres. They are
   * placed on a loop rather than unrolled because four hand-written spheres is
   * four places to get the spacing wrong.
   */
  float colonyFist(vec3 p) {
    float d = colonyBox(p, vec3(0.52, 0.44, 0.34)) - 0.20;
    for (int i = 0; i < 4; i++) {
      float u = (float(i) - 1.5) / 1.5;                 // -1..1 across the hand
      vec3 knuckle = vec3(u * 0.46, 0.40, 0.34 - abs(u) * 0.08);
      d = colonySmin(d, length(p - knuckle) - 0.23, 0.14);
    }
    // The thumb rides across the front, low and to one side. Without it the
    // silhouette is symmetric, and a symmetric hand reads as a rock.
    d = colonySmin(d, colonyCapsule(p, vec3(-0.44, -0.22, 0.10), vec3(0.06, -0.08, 0.46), 0.19), 0.12);
    return d;
  }

  /**
   * The spear.
   *
   * A thin shaft smooth-unioned with a fatter, shorter capsule at the front,
   * which gives a spindle head rather than a cone. A true round cone is about
   * thirty lines of iq arithmetic and buys a sharper point that no agent is
   * small enough to resolve; the spindle costs two capsules and reads the same.
   */
  float colonySpear(vec3 p) {
    float shaft = colonyCapsule(p, vec3(0.0, 0.0, -0.95), vec3(0.0, 0.0, 0.42), 0.085);
    float head = colonyCapsule(p, vec3(0.0, 0.0, 0.40), vec3(0.0, 0.0, 0.86), 0.21);
    return colonySmin(shaft, head, 0.16);
  }

  float colonyShapeField(int which, vec3 p) {
    if (which == 1) return colonyBox(p, vec3(0.92, 0.90, 0.10)) - 0.06;
    if (which == 2) return colonySpear(p);
    if (which == 3) return colonyFist(p);
    if (which == 4) return colonyTorus(p, 0.70, 0.22);
    if (which == 5) return colonyCylinderY(p, 0.40, 0.90) - 0.06;
    return length(p) - 0.90;
  }

  /** The blended field. This, not the projected point, is what morphs. */
  float colonyField(vec3 p) {
    float k = clamp(uShapeBlend, 0.0, 1.0);
    return mix(colonyShapeField(uShapeA, p), colonyShapeField(uShapeB, p), k);
  }

  /**
   * Gradient by the tetrahedron trick — four taps rather than the six a
   * central difference wants, for the same accuracy at this step size.
   */
  vec3 colonyGrad(vec3 p) {
    const vec2 e = vec2(1.0, -1.0);
    const float h = 0.055;
    vec3 g = e.xyy * colonyField(p + e.xyy * h)
           + e.yyx * colonyField(p + e.yyx * h)
           + e.yxy * colonyField(p + e.yxy * h)
           + e.xxx * colonyField(p + e.xxx * h);
    return g * inversesqrt(max(dot(g, g), 1e-8));
  }

  /**
   * Where this agent belongs in the shape, in world metres.
   *
   * The agent's dice and its index are its entire identity and neither
   * changes, so this is a pure function of the shape uniforms — which is
   * exactly why a paused slider re-forms the whole silhouette.
   */
  vec3 colonyTarget(vec3 dice, float idx) {
    // One draw from the unit cube. Not the surface, not a sphere — the descent
    // does the shaping, and starting from a cube is what lets a concave shape
    // (a ring, the gap under a thumb) get agents into its hollows at all.
    vec3 q = (hash31(dot(dice, vec3(11.3, 27.7, 53.1)) + idx * 0.0137 + 4.19) - 0.5) * 2.0;

    float iso = -max(uShapeFill, 0.0) * hash11(idx * 0.771 + 3.31);
    float steps = clamp(uShapeSteps, 1.0, 4.0);
    float relax = clamp(uShapeSlack, 0.05, 1.0);
    // Masked rather than broken out of: a break on a uniform is the kind of
    // thing that compiles on the desktop driver and fails on the one the player
    // has, which is the same reason Swarm's glyph walk masks its strokes.
    for (int i = 0; i < 4; i++) {
      float on = step(float(i), steps - 1.0);
      float d = colonyField(q) - iso;
      vec3 g = colonyGrad(q);
      q -= g * (d * relax * on);
    }

    // A perfectly converged surface is a shrink-wrap, and a swarm is not a
    // membrane. A little unitless slop off the isosurface is what keeps it a
    // crowd of insects that happens to be fist-shaped.
    q += (hash31(idx * 1.913 + 17.7) - 0.5) * (2.0 * uShapeRough);

    // Rigid spin about the shape's own up axis. Applied after the descent so
    // every agent turns with the shape instead of sliding around inside it.
    q.xz = rot2(uShapeSpin * uTime) * q.xz;

    vec3 up = vec3(0.0, 1.0, 0.0);
    vec3 centre = leadAt(uLeadS)
                + uForward * uShapeOffset.x
                + uSideAxis * uShapeOffset.y
                + up * uShapeOffset.z;
    vec3 local = q * uShapeSize;
    return centre + uSideAxis * local.x + up * local.y + uForward * local.z;
  }

  /**
   * The density wave, and the floor.
   *
   * A LONGITUDINAL compression along the wave axis: agents are displaced
   * along the axis by a sine of their own position on it, which crowds them at
   * the zero crossings and thins them at the extremes. That is a real surge —
   * a band of high density travelling up a funnel — and it costs one sine.
   *
   * The first version modulated per-agent *opacity* by the same sine. It looked
   * like a strobing gradient painted over a static swarm, because nothing
   * moved: density you can see is agents arriving, not agents brightening.
   */
  vec3 colonySurge(vec3 p, float t) {
    float len = max(uWaveLength, 0.05);
    float phase = TAU * (dot(p, uWaveAxis) - uWaveSpeed * t) / len;
    p += uWaveAxis * (uWaveAmp * sin(phase));
    p.y = mix(p.y, uFloorY + uCrawlHeight, clamp(uCling, 0.0, 1.0));
    return p;
  }
`;

/* ---------------------------------------------------------------------- */
/* The splice                                                              */
/* ---------------------------------------------------------------------- */

/**
 * Two anchors in `Swarm`'s vertex shader, matched literally.
 *
 * `ColonySwarm` **extends** `Swarm` rather than reimplementing it, and the way
 * a subclass extends a shader is by editing the string its superclass built.
 * That is a seam, so it is checked: if either anchor stops matching — because
 * somebody reformatted `Swarm.js`, which they are entitled to do — construction
 * throws here, naming the anchor, rather than silently rendering a flock that
 * ignores every shape uniform.
 */
const COLONY_ANCHOR_DECL = 'void main() {';
const COLONY_ANCHOR_BODY = 'vec3 vel = (p0 - p1) / H;';

/**
 * What replaces the body anchor.
 *
 * The target is evaluated **once per vertex** and the same value is mixed into
 * all three time samples, which has a consequence worth stating: while the
 * swarm is condensed its finite-difference velocity, and therefore its bank,
 * falls to zero. That is correct — an agent holding station in a shape is not
 * turning — and it is also forty field evaluations saved per vertex against the
 * alternative of sampling the field at t, t−h and t−2h. What it costs is that a
 * shape being *carried* downrange does not bank its agents; nothing in the
 * roster asks for that, and if something does, the fix is to sample
 * `colonyTarget` three times and pay for it.
 *
 * The branch on `uCondense` is uniform flow — every invocation in the draw
 * agrees on it — so it is a real saving and not a divergence penalty. With the
 * swarm dispersed, a `ColonySwarm` costs what a `Swarm` costs.
 */
const COLONY_SPLICE_BODY = /* glsl */ `
    float cnd = clamp(uCondense, 0.0, 1.0);
    if (cnd > 0.002) {
      vec3 tgt = colonyTarget(dice, idx);
      p0 = mix(p0, tgt, cnd);
      p1 = mix(p1, tgt, cnd);
      p2 = mix(p2, tgt, cnd);
    }
    p0 = colonySurge(p0, uTime);
    p1 = colonySurge(p1, uTime - H);
    p2 = colonySurge(p2, uTime - 2.0 * H);

    vec3 vel = (p0 - p1) / H;`;

/**
 * **What it draws.** A `Swarm` that can condense onto a signed distance field.
 * Everything `Swarm` does — the lattice separation, the lag cohesion, the
 * banking, the five silhouettes, the four-stop gradient, the edge-on flicker —
 * plus a target shape, a morph between two shapes, a travelling density wave
 * and a floor-crawling mode.
 *
 * **Draw calls.** One. It is one `Swarm`.
 *
 * **What it reads from settings.** Nothing directly; `update(_now, params)` is
 * handed a live block and resolves `p.key ?? default` for every key in
 * `colonySwarmParams()`, which is `swarmParams()` plus this class's own.
 *
 * **The one rule for using it well.** *Drive `condense` and `shapeBlend` from
 * the ability's beats, and leave everything else alone.* The module has exactly
 * two ideas in it and both of them are transitions. A swarm parked at
 * `condense = 1` on one shape is a mesh with a bad silhouette; a swarm that
 * arrives as a cloud, closes into a fist over three-tenths of a second, holds
 * for two frames and opens into a spear is the ability.
 *
 * ---
 *
 * ## Extending rather than composing, and why
 *
 * `Swarm`'s flock is a closed-form function evaluated in its vertex shader —
 * there is no agent state on the CPU to intercept, and no uniform that could
 * carry a per-agent target without becoming a texture (I2) or a uniform array
 * indexed by something other than a loop counter (which does not compile on
 * ANGLE). Composition — holding a `Swarm` and driving it from outside — can
 * therefore only move the *lead*, which moves all the agents together and
 * cannot make a shape.
 *
 * So this subclasses `Swarm` and splices two blocks into the vertex shader it
 * built: the field library before `main`, and a target-blend before the finite
 * difference. Both anchors are asserted at construction. The alternative was a
 * second flock, which would have meant a second copy of the lattice bijection,
 * the lag cohesion, the bank and the five silhouettes — and the moment one of
 * them was fixed the two would disagree about what a flock is.
 *
 * @example
 *   this.colony = new ColonySwarm(this.group, { capacity: 384 });
 *   // onSpawn
 *   this.colony.roll();
 *   // onTravel, every frame
 *   this._p.condense  = this._closeCurve(age);      // 0..1, authored beats
 *   this._p.shapeA    = ColonyShape.WALL;
 *   this._p.shapeB    = ColonyShape.SPEAR;
 *   this._p.shapeBlend = saturate((age - c.morphAt) / c.morphTime);
 *   this.colony.setBasis(origin, direction, side, length);
 *   this.colony.update(age, this._p);
 */
export class ColonySwarm extends Swarm {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} [options] every `Swarm` option; see that class.
   */
  constructor(parent, options = {}) {
    super(parent, options);

    const source = this.material.vertexShader;
    if (source.indexOf(COLONY_ANCHOR_DECL) < 0 || source.indexOf(COLONY_ANCHOR_BODY) < 0) {
      throw new Error(
        'ColonySwarm: the splice anchors are gone from Swarm.js. Expected to find ' +
          `"${COLONY_ANCHOR_DECL}" and "${COLONY_ANCHOR_BODY}" in its vertex shader. ` +
          'Re-point COLONY_ANCHOR_DECL / COLONY_ANCHOR_BODY in vfx/Colony.js at whatever ' +
          'replaced them — do not paper over it by copying the flock.'
      );
    }

    this.material.vertexShader = source
      .replace(COLONY_ANCHOR_DECL, `${COLONY_SDF_GLSL}\n\n${COLONY_ANCHOR_DECL}`)
      .replace(COLONY_ANCHOR_BODY, COLONY_SPLICE_BODY);
    this.material.needsUpdate = true;

    const u = this.material.uniforms;
    u.uShapeA = { value: ColonyShape.BALL };
    u.uShapeB = { value: ColonyShape.BALL };
    u.uShapeBlend = { value: 0 };
    u.uCondense = { value: 0 };
    u.uShapeSize = { value: new Vector3(1.4, 1.4, 1.4) };
    u.uShapeOffset = { value: new Vector3(0, 0, 0) };
    u.uShapeSpin = { value: 0 };
    u.uShapeFill = { value: 0.6 };
    u.uShapeSteps = { value: 3 };
    u.uShapeSlack = { value: 0.85 };
    u.uShapeRough = { value: 0.06 };
    u.uWaveAmp = { value: 0 };
    u.uWaveLength = { value: 2.5 };
    u.uWaveSpeed = { value: 3 };
    u.uWaveAxis = { value: new Vector3(0, 1, 0) };
    u.uCling = { value: 0 };
    u.uFloorY = { value: 0 };
    u.uCrawlHeight = { value: 0.12 };

    /** The colony half of the resolved params. Written into, never replaced. */
    this._cp = colonyOwnParams();
  }

  /**
   * Push the live params.
   *
   * @param {number} _now  ignored, as `Swarm`'s is — the shape's spin and the
   *   density wave both run on `frame.uTime`, because a colony that has been in
   *   the air for four seconds should not restart its surge when it condenses.
   * @param {object} params live block; keys from `colonySwarmParams()`.
   */
  update(_now, params) {
    super.update(_now, params);

    const p = params ?? COLONY_OWN_DEFAULTS;
    const c = this._cp;
    for (const key in COLONY_OWN_DEFAULTS) {
      const value = p[key];
      c[key] = value === undefined ? COLONY_OWN_DEFAULTS[key] : value;
    }

    const u = this.material.uniforms;
    u.uShapeA.value = clamp(Math.round(c.shapeA), 0, 5);
    u.uShapeB.value = clamp(Math.round(c.shapeB), 0, 5);
    u.uShapeBlend.value = c.shapeBlend;
    u.uCondense.value = c.condense;
    u.uShapeSize.value.set(c.shapeWidth, c.shapeHeight, c.shapeDepth);
    u.uShapeOffset.value.set(c.shapeForward, c.shapeSide, c.shapeUp);
    u.uShapeSpin.value = c.shapeSpin;
    u.uShapeFill.value = c.shapeFill;
    u.uShapeSteps.value = c.shapeSteps;
    u.uShapeSlack.value = c.shapeSlack;
    u.uShapeRough.value = c.shapeRough;

    u.uWaveAmp.value = c.waveAmp;
    u.uWaveLength.value = c.waveLength;
    u.uWaveSpeed.value = c.waveSpeed;
    // One slider instead of a vector: 0 is a wave climbing a funnel, 1 is a
    // wave running down the cast. Normalised here so the shader never has to.
    _v0.set(0, 1, 0).lerp(_v1.copy(this._direction).setY(0.0001), saturate(c.waveAlong));
    if (_v0.lengthSq() < 1e-8) _v0.set(0, 1, 0);
    u.uWaveAxis.value.copy(_v0.normalize());

    u.uCling.value = c.cling;
    u.uFloorY.value = c.floorY;
    u.uCrawlHeight.value = c.crawlHeight;
  }

  /**
   * Where the shape's centre is, in world space — for a light, a burst or an
   * emitter. The CPU mirror of the `centre` term in `colonyTarget()`; mirror,
   * so if you change one change the other.
   */
  shapeCentre(out) {
    this.leadPoint(out);
    const c = this._cp;
    out.addScaledVector(this._direction, c.shapeForward).addScaledVector(this._side, c.shapeSide);
    out.y += c.shapeUp;
    return out;
  }
}

/** The keys `ColonySwarm` adds on top of `swarmParams()`. */
function colonyOwnParams() {
  return {
    /* --- the shape --- */
    shapeA: ColonyShape.BALL, // ColonyShape.*
    shapeB: ColonyShape.BALL, // the shape being morphed toward
    shapeBlend: 0, // 0 all A, 1 all B — blends the fields, so the middle is a shape
    condense: 0, // 0 pure flock, 1 pure shape
    shapeWidth: 1.4, // metres, half-extent across
    shapeHeight: 1.4, // metres, half-extent up
    shapeDepth: 1.4, // metres, half-extent downrange
    shapeForward: 0, // metres from the lead, downrange
    shapeSide: 0, // metres from the lead, lateral
    shapeUp: 0, // metres from the lead, vertical
    shapeSpin: 0.35, // radians/second about the world up axis
    shapeFill: 0.6, // 0 a shell of agents, 1 a solid body
    shapeSteps: 3, // descent steps, 1..4 — 2 is soft, 4 is a shrink-wrap
    shapeSlack: 0.85, // fraction of each step taken; < 1 stops concavities ringing
    shapeRough: 0.06, // unitless slop off the isosurface — a crowd, not a membrane

    /* --- the density wave --- */
    waveAmp: 0, // metres of longitudinal bunching
    waveLength: 2.5, // metres between crests
    waveSpeed: 3, // metres/second the crests travel
    waveAlong: 0, // 0 the wave climbs, 1 it runs down the cast

    /* --- crawling --- */
    cling: 0, // 0 flying, 1 pinned to the floor
    floorY: 0, // metres
    crawlHeight: 0.12 // metres above the floor a crawler rides
  };
}

const COLONY_OWN_DEFAULTS = colonyOwnParams();

/**
 * Every key `ColonySwarm.update()` understands — `swarmParams()` plus the
 * shape, the wave and the crawl. Same contract: anything absent falls back.
 */
export function colonySwarmParams() {
  return { ...swarmParams(), ...colonyOwnParams() };
}

/* ====================================================================== */
/*  §2 · Graph + membrane                                                 */
/* ====================================================================== */

/**
 * The field both meshes are drawn in.
 *
 * Injected verbatim into the strand shader *and* the film shader, and every
 * uniform it names is a **shared box** — the two materials hold the same
 * `{ value }` objects by identity, so one write updates both. That is not a
 * micro-optimisation, it is the correctness property: a film whose sag formula
 * drifts a millimetre from its threads' does not look like a slightly wrong
 * web, it looks like a sheet of cling film hovering near one. Sharing the
 * source and sharing the boxes makes the drift unrepresentable.
 *
 * A node is addressed by two integers — its ring and its spoke — and nothing
 * else. Ring -1 is the hub, and it needs no special case: its radius fraction
 * is zero, and every per-node jitter in here is multiplied by that fraction, so
 * all the spokes of ring -1 land on exactly the same point however the dice
 * fell. The first version carried an explicit hub flag and a branch; deleting
 * the flag deleted three bugs, all of them "the hub moved".
 *
 * The dice are hashed from the indices rather than stored in a per-node array,
 * for the reason given in the traps file: a uniform array may only be indexed
 * by a loop counter, and a texture is I2. The cost is that the CPU cannot
 * reproduce them exactly — see `nodePoint()`.
 */
const WEB_FIELD_GLSL = /* glsl */ `
  uniform vec3  uAnchor;        // metres, the hub
  uniform vec3  uAxisX;         // unit, the web's own right
  uniform vec3  uAxisY;         // unit, the web's own up
  uniform vec3  uNormalAxis;    // unit, out of the web's plane

  uniform float uRings;         // whole number
  uniform float uSpokes;        // whole number
  uniform float uRadius;        // metres to the outer ring
  uniform float uSquash;        // 1 circular, < 1 an ellipse lying down
  uniform float uRingCurve;     // > 1 crowds the rings toward the rim
  uniform float uRingJitter;    // unitless, fraction of a ring's radius
  uniform float uSpokeJitter;   // unitless, fraction of a spoke's spacing
  uniform float uTwist;         // radians of shear per unit radius fraction
  uniform float uDroop;         // metres the whole disc sags at the rim
  uniform float uDepth;         // metres of out-of-plane node scatter
  uniform float uSlack;         // sag as a FRACTION of a strand's own span
  uniform float uSway;          // metres of breeze, out of plane
  uniform float uSwayRate;      // radians/second
  uniform float uSeed;

  /**
   * The dice for the strand between two nodes.
   *
   * Argument order matters and must match the CPU's: the film's four boundary
   * curves are the same four strands the strand mesh draws, and they only agree
   * if they roll the same number.
   */
  float webEdgeDice(vec2 a, vec2 b) {
    return hash11(dot(a, vec2(17.31, 5.77)) + dot(b, vec2(3.13, 29.71)) + uSeed * 1.7);
  }

  /** Node (ring, spoke) in world metres. Ring -1 is the hub. */
  vec3 webNode(vec2 rs) {
    float rings = max(uRings, 1.0);
    float spokes = max(uSpokes, 1.0);
    vec3 dice = hash31(uSeed * 3.11 + rs.x * 37.13 + rs.y * 7.31 + 5.77);

    float rho = clamp((rs.x + 1.0) / rings, 0.0, 1.0);
    rho = pow(rho, max(uRingCurve, 0.05));
    rho *= 1.0 + (dice.x - 0.5) * 2.0 * uRingJitter;

    float turn = rs.y / spokes + (dice.y - 0.5) * 2.0 * uSpokeJitter / spokes;
    float a = turn * TAU + uTwist * rho;

    vec2 pl = vec2(cos(a), sin(a)) * (rho * uRadius);
    pl.y *= uSquash;
    pl.y -= uDroop * rho * rho;
    float off = (dice.z - 0.5) * 2.0 * uDepth * rho;

    return uAnchor + uAxisX * pl.x + uAxisY * pl.y + uNormalAxis * (off * rho);
  }

  /**
   * A point at fraction u along the strand between two nodes.
   *
   * The sag is a fraction of the strand's OWN span, not a fixed drop. That is
   * the difference between a web and a net: a short chord near the hub hangs
   * almost straight while a two-metre outer chord bellies, which is what the
   * eye reads as tension. The first version used an absolute sag in metres and
   * every strand hung by the same amount, so the inner rings looked slack and
   * the whole thing read as knitting.
   */
  vec3 webEdge(vec3 a, vec3 b, float u, float dice) {
    vec3 p = mix(a, b, u);
    float span = length(b - a);
    float bow = 4.0 * u * (1.0 - u);
    p.y -= uSlack * span * bow * (0.55 + 0.9 * dice);
    p += uNormalAxis * (uSway * bow * sin(uTime * uSwayRate + dice * TAU + span * 1.7));
    return p;
  }

  vec3 webSafeNormalize(vec3 v, vec3 fallback) {
    float l2 = dot(v, v);
    return l2 > 1e-10 ? v * inversesqrt(l2) : fallback;
  }
`;

/* --- strands ---------------------------------------------------------- */

const WEB_STRAND_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uStrandWidth;   // metres
  uniform float uWidthJitter;   // +/- fraction
  uniform float uChordWidth;    // multiplier on chords, so radials read heavier
  uniform float uGrow;          // 0..1 of the web that has been spun
  uniform float uGrowFeather;   // 0..1 width of the spinning front

  attribute vec2 aFrom;         // (ring, spoke)
  attribute vec2 aTo;
  attribute vec2 aStrand;       // x order 0..1, y kind: 0 radial, 1 chord

  varying vec2  vUv;
  varying vec3  vTangent;
  varying vec3  vWorld;
  varying float vAlpha;
  varying float vDice;

  ${noiseGLSL}
  ${WEB_FIELD_GLSL}

  void main() {
    float drawn = smoothstep(aStrand.x, aStrand.x + max(uGrowFeather, 1e-3), clamp(uGrow, 0.0, 1.0));
    float u = min(position.x, drawn);

    vec3 a = webNode(aFrom);
    vec3 b = webNode(aTo);
    float dice = webEdgeDice(aFrom, aTo);

    vec3 p = webEdge(a, b, u, dice);
    // Central difference for the tangent rather than (b - a): the strand sags,
    // and a ribbon oriented off the chord twists visibly at the belly.
    const float du = 0.03;
    vec3 ahead = webEdge(a, b, min(u + du, 1.0), dice);
    vec3 behind = webEdge(a, b, max(u - du, 0.0), dice);
    vec3 tangent = webSafeNormalize(ahead - behind, vec3(0.0, 1.0, 0.0));

    vec3 view = webSafeNormalize(cameraPosition - p, vec3(0.0, 0.0, 1.0));
    vec3 across = webSafeNormalize(cross(tangent, view), vec3(1.0, 0.0, 0.0));

    float w = uStrandWidth
            * (1.0 + uWidthJitter * (dice - 0.5) * 2.0)
            * mix(1.0, uChordWidth, aStrand.y);
    vec3 world = p + across * (position.y * w * 0.5);

    vUv = uv;
    vTangent = tangent;
    vWorld = world;
    vDice = dice;
    vAlpha = step(0.002, drawn);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  }
`;

/**
 * Silk is a fibre, so it is shaded as one.
 *
 * A thread has no surface normal — it has a tangent, and every normal
 * perpendicular to that tangent is equally the surface. The Kajiya–Kay model is
 * the standard answer: integrate the highlight around that ring and you get a
 * lobe that depends on the angle between the tangent, the light and the eye,
 * and nothing else. What it looks like is the *band* of light that runs across
 * a web perpendicular to the threads and slides along them as you move — which
 * is the single most recognisable thing about a web and cannot be faked with a
 * fresnel.
 *
 * The first version shaded the ribbon as a billboarded quad with a soft edge.
 * It gave grey string. Nothing about it moved when the camera did, because a
 * billboard's normal always points at you and the highlight therefore never
 * goes anywhere.
 */
const WEB_STRAND_FRAGMENT = /* glsl */ `
  uniform vec3  uLightDir;
  uniform float uGlobalGlow;
  uniform vec3  uStrandColor;
  uniform vec3  uSilkColor;
  uniform float uSilkPower;     // fibre highlight exponent
  uniform float uSilkGain;
  uniform float uStrandOpacity;
  uniform float uStrandGlow;
  uniform float uCoreBias;      // how much brighter the thread's spine is

  varying vec2  vUv;
  varying vec3  vTangent;
  varying vec3  vWorld;
  varying float vAlpha;
  varying float vDice;

  void main() {
    if (vAlpha < 0.004) discard;

    // The ribbon is flat; treating its across-coordinate as a cylinder's
    // cross-section is what stops it reading as tape.
    float across = vUv.y * 2.0 - 1.0;
    float round = sqrt(max(1.0 - across * across, 0.0));
    float alpha = vAlpha * uStrandOpacity * round;
    if (alpha < 0.004) discard;

    vec3 v = normalize(cameraPosition - vWorld);
    vec3 l = normalize(uLightDir);
    vec3 t = normalize(vTangent);

    float tl = dot(t, l);
    float tv = dot(t, v);
    float sinTL = sqrt(max(1.0 - tl * tl, 0.0));
    float sinTV = sqrt(max(1.0 - tv * tv, 0.0));
    float spec = pow(max(sinTL * sinTV - tl * tv, 0.0), max(uSilkPower, 1.0));

    vec3 colour = uStrandColor * (0.35 + 0.65 * sinTL);
    colour += uSilkColor * (spec * uSilkGain * (0.7 + 0.6 * vDice));
    colour *= mix(1.0, 1.0 + uCoreBias, round);
    colour *= uStrandGlow * uGlobalGlow;

    gl_FragColor = vec4(colour, clamp(alpha, 0.0, 1.0));
  }
`;

/* --- the membrane ----------------------------------------------------- */

const WEB_FILM_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uDish;          // metres the film bellies between its threads
  uniform float uGrow;
  uniform float uGrowFeather;
  uniform float uOrderScatter;  // 0 the film fills ring by ring, 1 at random

  attribute vec2 aC0;           // inner ring, spoke j
  attribute vec2 aC1;           // inner ring, spoke j+1
  attribute vec2 aC2;           // outer ring, spoke j+1
  attribute vec2 aC3;           // outer ring, spoke j

  varying vec3  vNormal;
  varying vec3  vWorld;
  varying vec3  vDice;
  varying float vRho;
  varying float vAlpha;

  ${noiseGLSL}
  ${WEB_FIELD_GLSL}

  /**
   * A Coons patch over the face's four strands.
   *
   * Bilinear interpolation of the four *nodes* would give a flat quad whose
   * edges cut straight across the sag of the threads that bound it — the film
   * would visibly float off its own frame at every belly. A Coons patch is the
   * surface that interpolates four given boundary *curves* exactly, so the film
   * meets each of its four strands along its whole length, by construction. The
   * subtracted bilinear term is the correction that keeps the corners from
   * being counted twice; drop it and the patch bulges by exactly one corner.
   */
  vec3 filmPoint(vec3 c0, vec3 c1, vec3 c2, vec3 c3, vec4 d, vec2 st, float dish) {
    float s = clamp(st.x, 0.0, 1.0);
    float t = clamp(st.y, 0.0, 1.0);
    vec3 inner = webEdge(c0, c1, s, d.x);
    vec3 outer = webEdge(c3, c2, s, d.y);
    vec3 left = webEdge(c0, c3, t, d.z);
    vec3 right = webEdge(c1, c2, t, d.w);
    vec3 corners = mix(mix(c0, c1, s), mix(c3, c2, s), t);
    vec3 p = mix(inner, outer, t) + mix(left, right, s) - corners;
    // Zero on all four edges, so dishing the film cannot break the seal.
    float bump = 16.0 * s * (1.0 - s) * t * (1.0 - t);
    return p + uNormalAxis * (dish * bump);
  }

  void main() {
    vec3 c0 = webNode(aC0);
    vec3 c1 = webNode(aC1);
    vec3 c2 = webNode(aC2);
    vec3 c3 = webNode(aC3);
    // The same four rolls the strand mesh makes for these same four edges.
    vec4 d = vec4(
      webEdgeDice(aC0, aC1),
      webEdgeDice(aC3, aC2),
      webEdgeDice(aC0, aC3),
      webEdgeDice(aC1, aC2)
    );

    vec3 dice = hash31(uSeed * 5.13 + aC0.x * 31.7 + aC0.y * 11.3 + 91.1);
    float dish = uDish * ((dice.x - 0.5) * 2.0);

    vec2 st = position.xy;
    vec3 world = filmPoint(c0, c1, c2, c3, d, st, dish);

    // Derivatives of the patch itself, so the normal knows about the sag and
    // the dish. Four extra evaluations; the alternative was a per-face constant
    // normal, and a flat normal on a bellied film kills the grazing term
    // exactly where the film is most visible.
    const float h = 0.09;
    vec3 ds = filmPoint(c0, c1, c2, c3, d, st + vec2(h, 0.0), dish)
            - filmPoint(c0, c1, c2, c3, d, st - vec2(h, 0.0), dish);
    vec3 dt = filmPoint(c0, c1, c2, c3, d, st + vec2(0.0, h), dish)
            - filmPoint(c0, c1, c2, c3, d, st - vec2(0.0, h), dish);
    vNormal = webSafeNormalize(cross(ds, dt), uNormalAxis);

    float rho = clamp((aC3.x + 1.0) / max(uRings, 1.0), 0.0, 1.0);
    float order = mix(rho, dice.y, clamp(uOrderScatter, 0.0, 1.0));
    vAlpha = smoothstep(order, order + max(uGrowFeather, 1e-3), clamp(uGrow, 0.0, 1.0));

    vWorld = world;
    vDice = dice;
    vRho = rho;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  }
`;

/**
 * The membrane, which is the part everybody forgets.
 *
 * Two facts about a real web film and the shader is both of them. It is
 * **invisible head-on** — a film a fraction of a micron thick transmits almost
 * everything at normal incidence — and it **flares at grazing angles**, where
 * the path through it lengthens and the Fresnel reflectance climbs toward one.
 * So the alpha here is a pure grazing term and there is no constant part at all.
 * Adding even a small ambient floor was the first version's mistake: it turned
 * the web into a frosted disc, and the whole trick — panels of the web
 * appearing and vanishing as the camera swings — went with it.
 *
 * The colour comes from the same angle. Thin-film interference shifts hue with
 * path length, so walking the four-stop gradient with the grazing term gives
 * the oil-slick banding for nothing; `filmBands` is how many times round the
 * gradient the film goes between head-on and edge-on, and the per-face dice
 * offsets each panel so neighbours never band in step.
 */
const WEB_FILM_FRAGMENT = /* glsl */ `
  uniform vec3  uLightDir;
  uniform float uGlobalGlow;

  uniform vec3  uFilmA;
  uniform vec3  uFilmB;
  uniform vec3  uFilmC;
  uniform vec3  uFilmD;
  uniform vec3  uFilmSheenColor;
  uniform float uGrazePower;    // higher is a thinner rim of visibility
  uniform float uFilmOpacity;
  uniform float uFilmBands;     // times round the gradient, head-on to edge-on
  uniform float uFilmShift;     // per-face offset along it
  uniform float uFilmSheen;
  uniform float uFilmSheenPower;
  uniform float uFilmFill;      // 0..1 of the faces that carry any film at all
  uniform float uTearBias;      // 1 tears the rim first, 0 tears evenly
  uniform float uFilmGlow;

  varying vec3  vNormal;
  varying vec3  vWorld;
  varying vec3  vDice;
  varying float vRho;
  varying float vAlpha;

  ${commonGLSL}

  void main() {
    if (vAlpha < 0.004) discard;

    // Torn panels. A web with every face filled is a lampshade; the holes are
    // what say it was built by something and then walked through.
    float keep = uFilmFill * mix(1.0, 1.0 - vRho, clamp(uTearBias, 0.0, 1.0));
    if (vDice.z > keep) discard;

    vec3 n = normalize(vNormal);
    vec3 v = normalize(cameraPosition - vWorld);
    float graze = 1.0 - clamp(abs(dot(n, v)), 0.0, 1.0);

    float alpha = vAlpha * uFilmOpacity * pow(graze, max(uGrazePower, 0.1));
    if (alpha < 0.003) discard;

    float band = fract(graze * uFilmBands + vDice.y * uFilmShift);
    vec3 colour = gradient4(uFilmA, uFilmB, uFilmC, uFilmD, band);

    vec3 l = normalize(uLightDir);
    float sheen = pow(clamp(dot(reflect(-l, n), v), 0.0, 1.0), max(uFilmSheenPower, 1.0));
    colour += uFilmSheenColor * (sheen * uFilmSheen);
    colour *= uFilmGlow * uGlobalGlow;

    gl_FragColor = vec4(colour, clamp(alpha, 0.0, 1.0));
  }
`;

/**
 * Every key `WebGraph.update()` understands, with its default and its unit.
 *
 * The **topology** group is structural: changing `rings` or `spokes` rewrites
 * the index attributes, which happens inside `update()` on the frame the number
 * changes and costs a few hundred integer writes. Everything else is a uniform
 * and is live on a paused frame.
 */
export function webGraphParams() {
  return {
    /* --- the graph --- */
    rings: 5, // rings of chords outside the hub, whole number
    spokes: 12, // radials, whole number
    radius: 3.2, // metres to the outer ring
    squash: 0.82, // 1 circular, < 1 an ellipse lying down
    ringCurve: 1.35, // > 1 crowds the rings toward the rim, as a real web does
    ringJitter: 0.12, // unitless, fraction of a ring's radius
    spokeJitter: 0.22, // unitless, fraction of a spoke's spacing
    twist: 0.25, // radians of shear per unit radius fraction
    droop: 0.35, // metres the whole disc sags at the rim
    depth: 0.28, // metres of out-of-plane node scatter

    /* --- the strands --- */
    slack: 0.09, // sag as a FRACTION of a strand's own span
    sway: 0.05, // metres of breeze, out of plane
    swayRate: 1.7, // radians/second
    strandWidth: 0.02, // metres
    widthJitter: 0.35, // +/- fraction
    chordWidth: 0.75, // multiplier on chords, so the radials read as the frame
    strandOpacity: 1,
    strandGlow: 1.1,
    silkPower: 22, // fibre highlight exponent — the band across the threads
    silkGain: 1.6,
    coreBias: 0.5, // how much brighter a thread's spine is than its edge

    /* --- the membrane --- */
    dish: 0.07, // metres each panel bellies between its four threads
    grazePower: 2.6, // higher is a thinner rim of visibility
    filmOpacity: 0.55,
    filmBands: 2.2, // times round the gradient, head-on to edge-on
    filmShift: 0.7, // per-face offset along it
    filmSheen: 0.8,
    filmSheenPower: 34,
    filmFill: 0.8, // 0..1 of the faces that carry any film at all
    tearBias: 0.65, // 1 tears the rim first, 0 tears evenly
    filmGlow: 1,

    /* --- the spinning --- */
    grow: 1, // 0..1 of the web that has been spun
    growFeather: 0.18, // 0..1 width of the spinning front
    orderScatter: 0.25, // 0 the film fills ring by ring, 1 at random

    /* --- colour: five pickers, none derived from another --- */
    strandColor: '#efe7d2',
    silkColor: '#ffffff',
    filmA: '#9fe8d8',
    filmB: '#cfd2ff',
    filmC: '#ffd9b0',
    filmD: '#8fa8c8',
    filmSheenColor: '#ffffff'
  };
}

const WEB_DEFAULTS = webGraphParams();

/**
 * **What it draws.** An orb web: radial strands from a hub out to a rim, chords
 * between them, every strand sagging by a fraction of its own span — **and the
 * film in the faces those strands bound**.
 *
 * **Draw calls.** Two. One instanced strip for every strand, one indexed mesh
 * for every panel of film.
 *
 * **What it reads from settings.** Nothing directly. `update(_now, params)`
 * resolves `p.key ?? default` for every key in `webGraphParams()`.
 *
 * **The one rule for using it well.** *Put the caster somewhere they will move,
 * and never let `filmFill` reach 1.* The membrane is the whole point of the
 * module and it is a grazing-angle effect: it does not exist head-on, and if
 * every face carries it the panels that do flare have nothing to flare against.
 * A web at `filmFill = 0.8` with the camera orbiting is the ability; the same
 * web filled solid and viewed square-on is a disc.
 *
 * ---
 *
 * ## Anchors are two integers
 *
 * A node is `(ring, spoke)` and that is all that is stored — not a position, not
 * an angle, not a radius. Ring -1 is the hub. Every metre the web has is a
 * uniform: the rim radius, the ellipse's squash, the out-of-plane scatter, the
 * sag, the breeze. Drag `radius` with **P** held and the whole web re-spans,
 * film included, because the film is built from the same four functions the
 * strands are.
 *
 * ## The two meshes cannot disagree
 *
 * They are compiled from one source chunk and they hold the same uniform boxes
 * by identity. A film panel is a **Coons patch** over its four boundary
 * strands, so it meets them along their entire length rather than at their
 * corners, and it rolls the same per-strand dice for the sag because
 * `webEdgeDice()` takes the endpoints in an order both builders agree on.
 *
 * @example
 *   this.web = new WebGraph(this.group, { maxRings: 6, maxSpokes: 14 });
 *   // onSpawn
 *   this.web.roll();
 *   // every frame
 *   this.web.setPlacement(_target, _direction, _up);
 *   this._p.grow = saturate(age / c.spinTime);
 *   this.web.update(age, this._p);
 */
export class WebGraph {
  /**
   * @param {THREE.Object3D} parent
   * @param {object}  [options]
   * @param {number}  [options.maxRings=8]    ceiling on `rings`
   * @param {number}  [options.maxSpokes=16]  ceiling on `spokes`
   * @param {number}  [options.samples=10]    segments along one strand. Ten is
   *   enough for a sag; the strand is a smooth curve, not a kinked bolt.
   * @param {number}  [options.filmSubdiv=2]  quads per film panel, per axis. The
   *   patch is curved, so 1 would draw its two triangles straight across the
   *   belly and lose exactly the dish the grazing term is looking for.
   * @param {boolean} [options.additive=false]
   * @param {number}  [options.renderOrder=11]
   */
  constructor(parent, options = {}) {
    const maxRings = Math.max(1, Math.round(options.maxRings ?? 8));
    const maxSpokes = Math.max(3, Math.round(options.maxSpokes ?? 16));
    const samples = Math.max(2, Math.round(options.samples ?? 10));
    const sub = Math.max(1, Math.round(options.filmSubdiv ?? 2));

    this.maxRings = maxRings;
    this.maxSpokes = maxSpokes;
    this.subdivision = sub;

    this.group = new Group();
    this.group.name = 'WebGraph';
    this.group.matrixAutoUpdate = false;
    parent?.add(this.group);

    /* --- the shared uniform boxes -------------------------------------- */
    // Held by identity by both materials. See WEB_FIELD_GLSL for why.
    const shared = {
      uAnchor: { value: new Vector3() },
      uAxisX: { value: new Vector3(1, 0, 0) },
      uAxisY: { value: new Vector3(0, 1, 0) },
      uNormalAxis: { value: new Vector3(0, 0, 1) },
      uRings: { value: 5 },
      uSpokes: { value: 12 },
      uRadius: { value: 3.2 },
      uSquash: { value: 0.82 },
      uRingCurve: { value: 1.35 },
      uRingJitter: { value: 0.12 },
      uSpokeJitter: { value: 0.22 },
      uTwist: { value: 0.25 },
      uDroop: { value: 0.35 },
      uDepth: { value: 0.28 },
      uSlack: { value: 0.09 },
      uSway: { value: 0.05 },
      uSwayRate: { value: 1.7 },
      uSeed: { value: 0 },
      uGrow: { value: 1 },
      uGrowFeather: { value: 0.18 }
    };
    this._shared = shared;

    /* --- strands -------------------------------------------------------- */
    const maxStrands = maxRings * maxSpokes * 2;
    this.maxStrands = maxStrands;

    const columns = samples + 1;
    const stripPos = new Float32Array(columns * 2 * 3);
    const stripUv = new Float32Array(columns * 2 * 2);
    for (let i = 0; i < columns; i++) {
      const u = i / samples;
      for (let r = 0; r < 2; r++) {
        const v = (i * 2 + r) * 3;
        const t = (i * 2 + r) * 2;
        stripPos[v + 0] = u;
        stripPos[v + 1] = r === 0 ? -1 : 1;
        stripPos[v + 2] = 0;
        stripUv[t + 0] = u;
        stripUv[t + 1] = r;
      }
    }
    const stripIndex = new Uint16Array(samples * 6);
    for (let i = 0; i < samples; i++) {
      const a = i * 2;
      const o = i * 6;
      stripIndex[o + 0] = a;
      stripIndex[o + 1] = a + 2;
      stripIndex[o + 2] = a + 1;
      stripIndex[o + 3] = a + 1;
      stripIndex[o + 4] = a + 2;
      stripIndex[o + 5] = a + 3;
    }

    this._aFrom = new InstancedBufferAttribute(new Float32Array(maxStrands * 2), 2);
    this._aTo = new InstancedBufferAttribute(new Float32Array(maxStrands * 2), 2);
    this._aStrand = new InstancedBufferAttribute(new Float32Array(maxStrands * 2), 2);

    const strandGeometry = new InstancedBufferGeometry();
    strandGeometry.setAttribute('position', new BufferAttribute(stripPos, 3));
    strandGeometry.setAttribute('uv', new BufferAttribute(stripUv, 2));
    strandGeometry.setAttribute('aFrom', this._aFrom);
    strandGeometry.setAttribute('aTo', this._aTo);
    strandGeometry.setAttribute('aStrand', this._aStrand);
    strandGeometry.setIndex(new BufferAttribute(stripIndex, 1));
    strandGeometry.instanceCount = 0;
    strandGeometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    this.strandGeometry = strandGeometry;

    this.strandMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: options.additive ? AdditiveBlending : NormalBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        ...shared,
        uStrandWidth: { value: 0.02 },
        uWidthJitter: { value: 0.35 },
        uChordWidth: { value: 0.75 },
        uStrandColor: { value: new Color('#efe7d2') },
        uSilkColor: { value: new Color('#ffffff') },
        uSilkPower: { value: 22 },
        uSilkGain: { value: 1.6 },
        uStrandOpacity: { value: 1 },
        uStrandGlow: { value: 1.1 },
        uCoreBias: { value: 0.5 }
      }),
      vertexShader: WEB_STRAND_VERTEX,
      fragmentShader: WEB_STRAND_FRAGMENT
    });

    this.strandMesh = new Mesh(strandGeometry, this.strandMaterial);
    this.strandMesh.frustumCulled = false;
    this.strandMesh.matrixAutoUpdate = false;
    this.strandMesh.layers.set(LAYER.VFX);
    this.strandMesh.renderOrder = (options.renderOrder ?? 11) + 1;
    this.group.add(this.strandMesh);

    /* --- the membrane --------------------------------------------------- */
    const maxFaces = maxRings * maxSpokes;
    this.maxFaces = maxFaces;
    const vpf = (sub + 1) * (sub + 1);
    this._vertsPerFace = vpf;
    this._indexPerFace = sub * sub * 6;

    const filmPos = new Float32Array(maxFaces * vpf * 3);
    const filmC = [0, 1, 2, 3].map(() => new Float32Array(maxFaces * vpf * 2));
    // The index buffer is a pure function of the subdivision, so it is written
    // once here and never again — a topology change only rewrites vertices, and
    // `setDrawRange` hides the faces that are not in use.
    const filmIndex = new Uint16Array(maxFaces * this._indexPerFace);
    for (let f = 0; f < maxFaces; f++) {
      const base = f * vpf;
      let o = f * this._indexPerFace;
      for (let a = 0; a < sub; a++) {
        for (let b = 0; b < sub; b++) {
          const v00 = base + a * (sub + 1) + b;
          const v10 = base + (a + 1) * (sub + 1) + b;
          const v11 = base + (a + 1) * (sub + 1) + b + 1;
          const v01 = base + a * (sub + 1) + b + 1;
          filmIndex[o++] = v00;
          filmIndex[o++] = v10;
          filmIndex[o++] = v11;
          filmIndex[o++] = v00;
          filmIndex[o++] = v11;
          filmIndex[o++] = v01;
        }
      }
    }

    const filmGeometry = new BufferGeometry();
    filmGeometry.setAttribute('position', new BufferAttribute(filmPos, 3));
    filmGeometry.setAttribute('aC0', new BufferAttribute(filmC[0], 2));
    filmGeometry.setAttribute('aC1', new BufferAttribute(filmC[1], 2));
    filmGeometry.setAttribute('aC2', new BufferAttribute(filmC[2], 2));
    filmGeometry.setAttribute('aC3', new BufferAttribute(filmC[3], 2));
    filmGeometry.setIndex(new BufferAttribute(filmIndex, 1));
    filmGeometry.setDrawRange(0, 0);
    filmGeometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    this.filmGeometry = filmGeometry;
    this._filmCorners = filmC;

    this.filmMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: options.additive ? AdditiveBlending : NormalBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        ...shared,
        uDish: { value: 0.07 },
        uOrderScatter: { value: 0.25 },
        uFilmA: { value: new Color('#9fe8d8') },
        uFilmB: { value: new Color('#cfd2ff') },
        uFilmC: { value: new Color('#ffd9b0') },
        uFilmD: { value: new Color('#8fa8c8') },
        uFilmSheenColor: { value: new Color('#ffffff') },
        uGrazePower: { value: 2.6 },
        uFilmOpacity: { value: 0.55 },
        uFilmBands: { value: 2.2 },
        uFilmShift: { value: 0.7 },
        uFilmSheen: { value: 0.8 },
        uFilmSheenPower: { value: 34 },
        uFilmFill: { value: 0.8 },
        uTearBias: { value: 0.65 },
        uFilmGlow: { value: 1 }
      }),
      vertexShader: WEB_FILM_VERTEX,
      fragmentShader: WEB_FILM_FRAGMENT
    });

    this.filmMesh = new Mesh(filmGeometry, this.filmMaterial);
    this.filmMesh.frustumCulled = false;
    this.filmMesh.matrixAutoUpdate = false;
    this.filmMesh.layers.set(LAYER.VFX);
    this.filmMesh.renderOrder = options.renderOrder ?? 11;
    this.group.add(this.filmMesh);

    /** Topology hash: rebuild the index attributes only when this changes. */
    this._topology = -1;
    this.strands = 0;
    this.faces = 0;
    this.seed = 0;
    this._p = webGraphParams();

    this._rebuild(5, 12);
  }

  /** Two — the strands and the film. */
  get drawCalls() {
    return 2;
  }

  /** Live strands. → `Ability#instanceCount`. */
  get count() {
    return this.strands;
  }

  /**
   * Re-roll the web.
   *
   * The seed only feeds the hashes inside the shader, so this is one uniform
   * write and it is safe at any time: re-rolling mid-spin re-scatters a web that
   * is already half built without restarting it.
   */
  roll(seed = Math.random() * 100) {
    this.seed = seed;
    this._shared.uSeed.value = seed;
    return this;
  }

  /** Hide the web. Leaves the instance reusable — the pooling contract. */
  reset() {
    this.strandGeometry.instanceCount = 0;
    this.filmGeometry.setDrawRange(0, 0);
    this.strandMesh.visible = false;
    this.filmMesh.visible = false;
  }

  /**
   * Where the web hangs and which way it faces.
   *
   * @param {THREE.Vector3} anchor  the hub, in metres
   * @param {THREE.Vector3} normal  out of the web's plane — for a LINE cast this
   *   is the cast direction, so the web stands across the lane
   * @param {THREE.Vector3} up      the world up the web's own up is built from
   */
  setPlacement(anchor, normal, up) {
    const s = this._shared;
    s.uAnchor.value.copy(anchor);
    _v0.copy(normal);
    if (_v0.lengthSq() < 1e-8) _v0.set(0, 0, 1);
    _v0.normalize();
    _v1.copy(up ?? _v2.set(0, 1, 0));
    if (_v1.lengthSq() < 1e-8) _v1.set(0, 1, 0);
    // Gram-Schmidt against the normal, so a caster aiming steeply downhill does
    // not get a web sheared into a sliver.
    _v1.addScaledVector(_v0, -_v1.dot(_v0));
    if (_v1.lengthSq() < 1e-8) _v1.set(0, 1, 0).addScaledVector(_v0, -_v0.y);
    _v1.normalize();
    _v3.crossVectors(_v1, _v0).normalize();
    s.uNormalAxis.value.copy(_v0);
    s.uAxisY.value.copy(_v1);
    s.uAxisX.value.copy(_v3);
    return this;
  }

  /**
   * Rewrite the index attributes for a new `rings × spokes`.
   *
   * Called from `update()` when the topology hash changes and from nowhere
   * else. Every number written here is an **integer index or a unitless
   * ordering fraction** — not one metre — which is why a topology rebuild is
   * legal under I1 and why it never has to happen again once the sliders stop
   * moving.
   */
  _rebuild(rings, spokes) {
    const from = this._aFrom.array;
    const to = this._aTo.array;
    const strand = this._aStrand.array;

    let n = 0;
    // Radials first, hub outward: a real orb weaver lays the frame before the
    // spiral, and drawing them in that order is most of why the spin reads.
    for (let r = 0; r < rings; r++) {
      const order = 0.45 * ((r + 1) / rings);
      for (let j = 0; j < spokes; j++) {
        from[n * 2] = r - 1;
        from[n * 2 + 1] = j;
        to[n * 2] = r;
        to[n * 2 + 1] = j;
        strand[n * 2] = order;
        strand[n * 2 + 1] = 0;
        n++;
      }
    }
    // Then the spiral, rim inward — which is the direction the animal walks it.
    for (let r = 0; r < rings; r++) {
      const order = 0.5 + 0.5 * (1 - (r + 1) / rings);
      for (let j = 0; j < spokes; j++) {
        from[n * 2] = r;
        from[n * 2 + 1] = j;
        to[n * 2] = r;
        to[n * 2 + 1] = (j + 1) % spokes;
        strand[n * 2] = order;
        strand[n * 2 + 1] = 1;
        n++;
      }
    }
    this.strands = n;
    this._aFrom.needsUpdate = true;
    this._aTo.needsUpdate = true;
    this._aStrand.needsUpdate = true;
    this.strandGeometry.instanceCount = n;

    /* --- the faces ---------------------------------------------------- */
    const sub = this.subdivision;
    const vpf = this._vertsPerFace;
    const pos = this.filmGeometry.attributes.position.array;
    const [c0, c1, c2, c3] = this._filmCorners;

    let f = 0;
    for (let r = 0; r < rings; r++) {
      for (let j = 0; j < spokes; j++) {
        const jn = (j + 1) % spokes;
        const base = f * vpf;
        for (let a = 0; a <= sub; a++) {
          for (let b = 0; b <= sub; b++) {
            const v = base + a * (sub + 1) + b;
            pos[v * 3 + 0] = a / sub;
            pos[v * 3 + 1] = b / sub;
            pos[v * 3 + 2] = 0;
            // The four corners, in the order the boundary curves expect:
            // c0-c1 is the inner chord, c3-c2 the outer, c0-c3 and c1-c2 the
            // two radials. Swap any pair and the film turns inside out.
            c0[v * 2] = r - 1;
            c0[v * 2 + 1] = j;
            c1[v * 2] = r - 1;
            c1[v * 2 + 1] = jn;
            c2[v * 2] = r;
            c2[v * 2 + 1] = jn;
            c3[v * 2] = r;
            c3[v * 2 + 1] = j;
          }
        }
        f++;
      }
    }
    this.faces = f;
    this.filmGeometry.attributes.position.needsUpdate = true;
    for (const name of ['aC0', 'aC1', 'aC2', 'aC3']) {
      this.filmGeometry.attributes[name].needsUpdate = true;
    }
    this.filmGeometry.setDrawRange(0, f * this._indexPerFace);
  }

  /**
   * Push the live params.
   *
   * @param {number} _now ignored, as `Swarm`'s and `Curtain`'s are — the breeze
   *   runs on `frame.uTime`, and the spin is driven by `p.grow`, which the
   *   ability authors from its own beats.
   * @param {object} params live block; keys from `webGraphParams()`.
   */
  update(_now, params) {
    const p = this._p;
    const src = params ?? WEB_DEFAULTS;
    for (const key in WEB_DEFAULTS) {
      const value = src[key];
      p[key] = value === undefined ? WEB_DEFAULTS[key] : value;
    }

    const rings = clamp(Math.round(p.rings), 1, this.maxRings);
    const spokes = clamp(Math.round(p.spokes), 3, this.maxSpokes);
    const hash = rings * 1024 + spokes;
    if (hash !== this._topology) {
      this._topology = hash;
      this._rebuild(rings, spokes);
    }

    const s = this._shared;
    s.uRings.value = rings;
    s.uSpokes.value = spokes;
    s.uRadius.value = p.radius;
    s.uSquash.value = p.squash;
    s.uRingCurve.value = p.ringCurve;
    s.uRingJitter.value = p.ringJitter;
    s.uSpokeJitter.value = p.spokeJitter;
    s.uTwist.value = p.twist;
    s.uDroop.value = p.droop;
    s.uDepth.value = p.depth;
    s.uSlack.value = p.slack;
    s.uSway.value = p.sway;
    s.uSwayRate.value = p.swayRate;
    s.uGrow.value = p.grow;
    s.uGrowFeather.value = p.growFeather;

    const su = this.strandMaterial.uniforms;
    su.uStrandWidth.value = p.strandWidth;
    su.uWidthJitter.value = p.widthJitter;
    su.uChordWidth.value = p.chordWidth;
    su.uSilkPower.value = p.silkPower;
    su.uSilkGain.value = p.silkGain;
    su.uStrandOpacity.value = p.strandOpacity;
    su.uStrandGlow.value = p.strandGlow;
    su.uCoreBias.value = p.coreBias;
    copyPicker(su.uStrandColor.value, p.strandColor);
    copyPicker(su.uSilkColor.value, p.silkColor);

    const fu = this.filmMaterial.uniforms;
    fu.uDish.value = p.dish;
    fu.uOrderScatter.value = p.orderScatter;
    fu.uGrazePower.value = p.grazePower;
    fu.uFilmOpacity.value = p.filmOpacity;
    fu.uFilmBands.value = p.filmBands;
    fu.uFilmShift.value = p.filmShift;
    fu.uFilmSheen.value = p.filmSheen;
    fu.uFilmSheenPower.value = p.filmSheenPower;
    fu.uFilmFill.value = p.filmFill;
    fu.uTearBias.value = p.tearBias;
    fu.uFilmGlow.value = p.filmGlow;
    copyPicker(fu.uFilmA.value, p.filmA);
    copyPicker(fu.uFilmB.value, p.filmB);
    copyPicker(fu.uFilmC.value, p.filmC);
    copyPicker(fu.uFilmD.value, p.filmD);
    copyPicker(fu.uFilmSheenColor.value, p.filmSheenColor);

    const shown = p.grow > 0.001 && p.radius > 0;
    this.strandMesh.visible = shown && p.strandOpacity > 0 && p.strandWidth > 0;
    this.filmMesh.visible = shown && p.filmOpacity > 0 && p.filmFill > 0;
  }

  /**
   * Where node `(ring, spoke)` is, in world metres. Ring -1 is the hub.
   *
   * **Without the per-node jitter.** The jitter is hashed in the shader, and a
   * JS mirror of a `fract`-chain hash run at double precision does not agree
   * with the same chain run at `highp` float — a hash amplifies the last bit
   * into a completely different number, so a "mirror" would be confidently
   * wrong rather than approximately right. This returns the node's nominal
   * place, which is within `ringJitter` of where the strand actually is. Same
   * decision, same reason, as `Curtain#sheetPoint()` leaving out the travelling
   * ripple and `LiquidSurface#lipPosition()` leaving out the chop.
   *
   * @param {number} ring   -1 for the hub
   * @param {number} spoke
   * @param {object} p      the same live block handed to `update()`
   * @param {THREE.Vector3} out
   */
  nodePoint(ring, spoke, p, out) {
    const rings = Math.max(1, Math.round(p.rings ?? WEB_DEFAULTS.rings));
    const spokes = Math.max(3, Math.round(p.spokes ?? WEB_DEFAULTS.spokes));
    const radius = p.radius ?? WEB_DEFAULTS.radius;
    const curve = Math.max(p.ringCurve ?? WEB_DEFAULTS.ringCurve, 0.05);
    const rho = Math.pow(saturate((ring + 1) / rings), curve);
    const a = (spoke / spokes) * TAU + (p.twist ?? WEB_DEFAULTS.twist) * rho;

    const s = this._shared;
    const x = Math.cos(a) * rho * radius;
    const y =
      Math.sin(a) * rho * radius * (p.squash ?? WEB_DEFAULTS.squash) -
      (p.droop ?? WEB_DEFAULTS.droop) * rho * rho;
    return out
      .copy(s.uAnchor.value)
      .addScaledVector(s.uAxisX.value, x)
      .addScaledVector(s.uAxisY.value, y);
  }

  dispose() {
    this.strandGeometry.dispose();
    this.strandMaterial.dispose();
    this.filmGeometry.dispose();
    this.filmMaterial.dispose();
    this.group.parent?.remove(this.group);
  }
}

/**
 * Copy a picker into a `THREE.Color`, accepting either a `#rrggbb` string or a
 * `Color`. Strings go through the memoised `getColor`, so calling this every
 * frame for a dozen pickers costs a dozen copies and no allocation.
 */
function copyPicker(target, value) {
  target.copy(typeof value === 'string' ? getColor(value) : value);
}

/* ====================================================================== */
/*  §3 · Lattice growth                                                   */
/* ====================================================================== */

/**
 * One comb cell, in unit space: circumradius 1 across, height 1 up, open at the
 * top with a rim and a recess.
 *
 * It is not a hexagonal prism. A prism gives a tiled floor — the eye reads a
 * mosaic and stops. What says *hive* is the **rim and the hole**: a wall of a
 * definite thickness, a shadowed recess behind it, and a floor down there
 * catching a little light. Those three features cost thirty triangles and they
 * are the difference between a honeycomb and a bathroom.
 *
 * Every face carries a `kind` so the fragment shader can treat them
 * differently — the recess is what glows, and it can only glow if the shader
 * knows which triangles are inside it.
 *
 * Normals are flat and explicit, so the geometry is drawn `DoubleSide`. Winding
 * on a five-part hand-built solid is a bug farm and the interior of a cell is
 * meant to be looked into anyway; the cost is fill on faces the rim already
 * hides.
 *
 * @param {number} sides  6 is a hive; 4 and 8 are also legal and also read
 * @param {number} wall   wall thickness as a fraction of the circumradius
 * @param {number} depth  recess depth as a fraction of the height
 */
function buildCombCell(sides, wall, depth) {
  const n = Math.max(3, Math.round(sides));
  const inner = clamp(1 - wall, 0.05, 0.98);
  const yFloor = clamp(1 - depth, 0.02, 0.98);

  const verts = n * 18;
  const position = new Float32Array(verts * 3);
  const normal = new Float32Array(verts * 3);
  const kind = new Float32Array(verts);
  const index = new Uint16Array(n * 24);

  let v = 0;
  let i = 0;
  const put = (x, y, z, nx, ny, nz, k) => {
    position[v * 3] = x;
    position[v * 3 + 1] = y;
    position[v * 3 + 2] = z;
    normal[v * 3] = nx;
    normal[v * 3 + 1] = ny;
    normal[v * 3 + 2] = nz;
    kind[v] = k;
    return v++;
  };
  const quad = (a, b, c, d) => {
    index[i++] = a;
    index[i++] = b;
    index[i++] = c;
    index[i++] = a;
    index[i++] = c;
    index[i++] = d;
  };
  const tri = (a, b, c) => {
    index[i++] = a;
    index[i++] = b;
    index[i++] = c;
  };

  for (let k = 0; k < n; k++) {
    const a0 = ((k + 0.5) / n) * TAU;
    const a1 = ((k + 1.5) / n) * TAU;
    const x0 = Math.cos(a0);
    const z0 = Math.sin(a0);
    const x1 = Math.cos(a1);
    const z1 = Math.sin(a1);
    // The face normal of a wall is the bisector of its two corners, which for a
    // regular polygon is the outward normal of the edge itself.
    const mx = x0 + x1;
    const mz = z0 + z1;
    const ml = Math.hypot(mx, mz) || 1;
    const nx = mx / ml;
    const nz = mz / ml;

    /* outer wall */
    quad(
      put(x0, 0, z0, nx, 0, nz, 0),
      put(x1, 0, z1, nx, 0, nz, 0),
      put(x1, 1, z1, nx, 0, nz, 0),
      put(x0, 1, z0, nx, 0, nz, 0)
    );
    /* the rim, between the outer and inner polygons at full height */
    quad(
      put(x0, 1, z0, 0, 1, 0, 1),
      put(x1, 1, z1, 0, 1, 0, 1),
      put(x1 * inner, 1, z1 * inner, 0, 1, 0, 1),
      put(x0 * inner, 1, z0 * inner, 0, 1, 0, 1)
    );
    /* inner wall, down into the recess — normal points inward */
    quad(
      put(x0 * inner, 1, z0 * inner, -nx, 0, -nz, 2),
      put(x1 * inner, 1, z1 * inner, -nx, 0, -nz, 2),
      put(x1 * inner, yFloor, z1 * inner, -nx, 0, -nz, 2),
      put(x0 * inner, yFloor, z0 * inner, -nx, 0, -nz, 2)
    );
    /* the floor of the recess */
    tri(
      put(0, yFloor, 0, 0, 1, 0, 3),
      put(x0 * inner, yFloor, z0 * inner, 0, 1, 0, 3),
      put(x1 * inner, yFloor, z1 * inner, 0, 1, 0, 3)
    );
    /* the underside */
    tri(
      put(0, 0, 0, 0, -1, 0, 4),
      put(x1, 0, z1, 0, -1, 0, 4),
      put(x0, 0, z0, 0, -1, 0, 4)
    );
  }

  return { position, normal, kind, index, vertexCount: v, indexCount: i };
}

const LATTICE_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform vec3  uAnchor;        // metres
  uniform vec3  uAxisX;         // unit
  uniform vec3  uAxisZ;         // unit
  uniform float uNow;           // seconds since the cast began

  uniform float uCellPitch;     // metres between adjacent cell centres
  uniform float uCellRadius;    // metres, circumradius of one cell
  uniform float uSizeJitter;    // +/- fraction
  uniform float uHeightBase;    // metres, a cell far from the seed
  uniform float uHeightPeak;    // metres, a cell at the seed
  uniform float uHeightFalloff; // LATTICE UNITS over which peak decays to base
  uniform float uLayerHeight;   // metres between stacked layers
  uniform float uBaseY;         // metres, the floor the comb sits on
  uniform float uRise;          // metres a cell climbs out of the floor as it lands

  uniform float uStagger;       // seconds between one cell and the next
  uniform float uGrowTime;      // seconds one cell takes to land
  uniform float uOvershoot;     // fraction it overshoots by on the way
  uniform float uRetract;       // 1 fully built, 0 fully withdrawn

  attribute vec3 aCell;         // x, y in LATTICE UNITS; z the layer index
  attribute vec4 aCellInfo;     // turn fraction, order index, dice, lattice radius

  varying vec3  vNormal;
  varying vec3  vWorld;
  varying float vKind;
  varying float vDice;
  varying float vRadius;
  varying float vFlash;
  varying float vEmerge;

  attribute float aKind;

  ${noiseGLSL}

  void main() {
    float dice = aCellInfo.z;
    float birth = aCellInfo.y * uStagger;
    float e = clamp((uNow - birth) / max(uGrowTime, 1e-3), 0.0, 1.0);
    // Cubic ease out, then an overshoot that is zero at both ends — so the cell
    // punches past its height and settles onto it exactly, rather than settling
    // onto whatever the overshoot happened to leave behind.
    float ease = 1.0 - pow(1.0 - e, 3.0);
    float grow = ease * (1.0 + uOvershoot * sin(PI * e) * (1.0 - e));
    grow *= clamp(uRetract, 0.0, 1.0);

    float far = clamp(aCellInfo.w / max(uHeightFalloff, 0.01), 0.0, 1.0);
    float h = mix(uHeightPeak, uHeightBase, far) * (1.0 + uSizeJitter * (dice - 0.5) * 2.0);
    float radius = uCellRadius * (1.0 + uSizeJitter * (hash11(dice * 31.7) - 0.5) * 2.0);

    float turn = aCellInfo.x * TAU;
    mat2 spin = rot2(turn);
    vec2 local = spin * position.xz * radius;
    // Swizzling a constructor is legal and compiles here and fails somewhere
    // else; two statements cost nothing and cannot be got wrong.
    vec2 nrmXZ = spin * normal.xz;
    vec3 nrm = vec3(nrmXZ.x, normal.y, nrmXZ.y);

    vec2 centre = aCell.xy * uCellPitch;
    float y = uBaseY + aCell.z * uLayerHeight + position.y * h * grow - (1.0 - ease) * uRise;

    vec3 world = uAnchor
               + uAxisX * (centre.x + local.x)
               + uAxisZ * (centre.y + local.y);
    world.y = y;

    vNormal = normalize(uAxisX * nrm.x + vec3(0.0, 1.0, 0.0) * nrm.y + uAxisZ * nrm.z);
    vWorld = world;
    vKind = aKind;
    vDice = dice;
    vRadius = aCellInfo.w;
    vEmerge = e;
    // The flash is the moment of landing, and it is a function of e rather than
    // of the clock: a cell that has not been reached yet has never flashed, and
    // one whose stagger was dragged forward under a paused frame flashes now.
    vFlash = pow(1.0 - e, 3.0) * step(0.001, e);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  }
`;

const LATTICE_FRAGMENT = /* glsl */ `
  uniform vec3  uLightDir;
  uniform float uGlobalGlow;

  uniform vec3  uCombA;
  uniform vec3  uCombB;
  uniform vec3  uCombC;
  uniform vec3  uCombD;
  uniform vec3  uCoreColor;
  uniform vec3  uRimColor;
  uniform vec3  uSheenColor;
  uniform vec3  uFlashColor;

  uniform float uTintRadius;    // LATTICE UNITS over which the gradient is walked
  uniform float uTintJitter;
  uniform float uWrap;
  uniform float uRimPow;
  uniform float uRimGain;
  uniform float uSheenPow;
  uniform float uSheenGain;
  uniform float uCoreGlow;      // how hot the recess is
  uniform float uFlashGain;
  uniform float uGlow;

  varying vec3  vNormal;
  varying vec3  vWorld;
  varying float vKind;
  varying float vDice;
  varying float vRadius;
  varying float vFlash;
  varying float vEmerge;

  ${commonGLSL}
  ${COLONY_CHITIN_GLSL}

  void main() {
    if (vEmerge < 0.001) discard;

    vec3 n = normalize(vNormal);
    vec3 v = normalize(cameraPosition - vWorld);
    vec3 l = normalize(uLightDir);

    float t = clamp(vRadius / max(uTintRadius, 0.01) + (vDice - 0.5) * 2.0 * uTintJitter, 0.0, 1.0);
    vec3 body = gradient4(uCombA, uCombB, uCombC, uCombD, t);

    vec3 colour = chitin(n, v, l, body, uRimColor, uSheenColor,
                         uWrap, uRimPow, uRimGain, uSheenPow, uSheenGain);

    // Only the recess glows. A cell lit all over is a lantern; a cell with a
    // hot hole in it is a hive, and the read comes entirely from the rim being
    // dark against it.
    float core = step(1.5, vKind);
    colour += uCoreColor * (core * uCoreGlow * (0.55 + 0.45 * vDice));
    colour += uFlashColor * (vFlash * uFlashGain);
    colour *= uGlow * uGlobalGlow;

    gl_FragColor = vec4(colour, 1.0);
  }
`;

/** Buckets in the refusal hash. A power of two, so the mask is an AND. */
const LATTICE_BUCKETS = 2048;

/**
 * Every key `LatticeGrowth.update()` understands, with its default and its unit.
 *
 * The **structure** group is what the growth is run against; changing any of it
 * regrows the comb inside `update()` on the frame it changes, which is a few
 * hundred microseconds and happens while a slider is moving. Everything else is
 * a uniform and is live on a zero-length frame.
 */
export function latticeGrowthParams() {
  return {
    /* --- the structure: changing any of these regrows --- */
    cells: 120, // cells to attempt, whole number
    seed: 0, // the growth's dice
    drift: 0.16, // turns of lattice drift a child may take from its parent
    refuse: 0.94, // LATTICE UNITS — candidates closer than this to a placed cell
    //               are refused. Just under 1, so a clean neighbour passes and a
    //               drifted one does not. This is what makes the edge ragged.
    climb: 0.15, // 0..1 tendency to start a new layer instead of spreading
    outward: 0.55, // 0..1 preference for candidates further from the seed
    layers: 4, // ceiling on stacked layers, whole number

    /* --- the metres --- */
    pitch: 0.34, // metres between adjacent cell centres
    cellRadius: 0.2, // metres, circumradius of one cell
    sizeJitter: 0.12, // +/- fraction on height and radius
    heightBase: 0.22, // metres, a cell far from the seed
    heightPeak: 1.1, // metres, a cell at the seed
    heightFalloff: 5, // LATTICE UNITS over which peak decays to base
    layerHeight: 0.26, // metres between stacked layers
    baseY: 0, // metres, the floor the comb sits on
    rise: 0.35, // metres a cell climbs out of the floor as it lands

    /* --- the clock --- */
    stagger: 0.012, // seconds between one cell and the next
    growTime: 0.22, // seconds one cell takes to land
    overshoot: 0.28, // fraction it overshoots by on the way
    retract: 1, // 1 fully built, 0 fully withdrawn

    /* --- the look --- */
    tintRadius: 7, // LATTICE UNITS over which the gradient is walked
    tintJitter: 0.14,
    wrap: 0.45, // 0 hard terminator, 1 fully wrapped
    rimPow: 3.2,
    rimGain: 0.5,
    sheenPow: 42,
    sheenGain: 0.6,
    coreGlow: 0.7, // how hot the recess is
    flashGain: 1.4,
    glow: 1,

    /* --- eight pickers, none derived from another --- */
    combA: '#e8d27a',
    combB: '#c8a03c',
    combC: '#8a6218',
    combD: '#3a2a10',
    coreColor: '#ffd24a',
    rimColor: '#fff0b0',
    sheenColor: '#fffbe8',
    flashColor: '#fff6c8'
  };
}

const LATTICE_DEFAULTS = latticeGrowthParams();

/**
 * **What it draws.** A comb: hexagonal cells building outward from a seed, each
 * one snapping to the lattice its own parent defined, each landing on its own
 * staggered clock.
 *
 * **Draw calls.** One, however many cells.
 *
 * **What it reads from settings.** Nothing directly. `update(now, params)`
 * resolves `p.key ?? default` for every key in `latticeGrowthParams()`.
 *
 * **The one rule for using it well.** *`refuse` and `drift` are one control, and
 * they are the ability.* With `drift = 0` this is a hex grid and the refusal
 * never fires, which is precisely the thing the roster says not to build. With
 * `drift` up and `refuse` just under 1, children inherit a rotated lattice,
 * cousins collide, the collisions are refused, and the structure grows an
 * irregular perimeter and interior voids that no radius function would have
 * produced. Start at `drift 0.16 / refuse 0.94` and pull them apart.
 *
 * ---
 *
 * ## Why it is not a hex grid filled by radius
 *
 * A global hexagonal grid has one lattice, and a cell either exists or it does
 * not. Everything you can do with it is a mask, and every mask reads as a
 * *shape someone cut out of a honeycomb*, because the honeycomb was there first
 * and the shape came after.
 *
 * Here each cell carries **its own lattice frame**, inherited from its parent
 * and turned by up to `drift` of a turn. A child buds one lattice unit away
 * along one of its parent's six directions, so locally the packing is perfectly
 * hexagonal — three cells in a row look built — but two branches that started at
 * the seed and went round opposite sides of a void arrive back at each other
 * out of register. When they do, the candidate cell lands within `refuse` of
 * something already placed and is **thrown away**.
 *
 * That refusal is the whole design. It is what puts a seam where two growth
 * fronts met, a hole where three did, and a perimeter that is jagged in a way
 * that follows the history of the growth rather than a noise function.
 *
 * ## Cost of a regrow
 *
 * Refusal is a lookup in a fixed open-addressed spatial hash — a head array and
 * a next array, both `Int32Array`s allocated once, so a regrow allocates
 * nothing and touches nine buckets per candidate. The first version tested
 * every placed cell and was O(n²); at 256 cells that was several milliseconds
 * on every frame of a slider drag, which is exactly the interaction this has to
 * survive.
 *
 * @example
 *   this.comb = new LatticeGrowth(this.group, { capacity: 220 });
 *   // every frame
 *   this.comb.setPlacement(_anchor, _direction, null);
 *   this.comb.update(age, settings.hivecolumn);
 */
export class LatticeGrowth {
  /**
   * @param {THREE.Object3D} parent
   * @param {object} [options]
   * @param {number} [options.capacity=192]  hard ceiling on cells
   * @param {number} [options.sides=6]       6 is a hive
   * @param {number} [options.wall=0.24]     wall thickness, fraction of radius
   * @param {number} [options.recess=0.62]   recess depth, fraction of height
   * @param {number} [options.renderOrder=2]
   * @param {boolean} [options.castShadow=true]
   */
  constructor(parent, options = {}) {
    this.capacity = Math.max(1, Math.round(options.capacity ?? 192));

    this.group = new Group();
    this.group.name = 'LatticeGrowth';
    this.group.matrixAutoUpdate = false;
    parent?.add(this.group);

    const cell = buildCombCell(options.sides ?? 6, options.wall ?? 0.24, options.recess ?? 0.62);

    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(cell.position, 3));
    geometry.setAttribute('normal', new BufferAttribute(cell.normal, 3));
    geometry.setAttribute('aKind', new BufferAttribute(cell.kind, 1));
    geometry.setIndex(new BufferAttribute(cell.index, 1));

    this._aCell = new InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this._aInfo = new InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    geometry.setAttribute('aCell', this._aCell);
    geometry.setAttribute('aCellInfo', this._aInfo);
    geometry.instanceCount = 0;
    geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    this.geometry = geometry;

    this.material = new ShaderMaterial({
      transparent: false,
      depthWrite: true,
      depthTest: true,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uAnchor: { value: new Vector3() },
        uAxisX: { value: new Vector3(1, 0, 0) },
        uAxisZ: { value: new Vector3(0, 0, 1) },
        uNow: { value: 0 },

        uCellPitch: { value: 0.34 },
        uCellRadius: { value: 0.2 },
        uSizeJitter: { value: 0.12 },
        uHeightBase: { value: 0.22 },
        uHeightPeak: { value: 1.1 },
        uHeightFalloff: { value: 5 },
        uLayerHeight: { value: 0.26 },
        uBaseY: { value: 0 },
        uRise: { value: 0.35 },

        uStagger: { value: 0.012 },
        uGrowTime: { value: 0.22 },
        uOvershoot: { value: 0.28 },
        uRetract: { value: 1 },

        uCombA: { value: new Color('#e8d27a') },
        uCombB: { value: new Color('#c8a03c') },
        uCombC: { value: new Color('#8a6218') },
        uCombD: { value: new Color('#3a2a10') },
        uCoreColor: { value: new Color('#ffd24a') },
        uRimColor: { value: new Color('#fff0b0') },
        uSheenColor: { value: new Color('#fffbe8') },
        uFlashColor: { value: new Color('#fff6c8') },

        uTintRadius: { value: 7 },
        uTintJitter: { value: 0.14 },
        uWrap: { value: 0.45 },
        uRimPow: { value: 3.2 },
        uRimGain: { value: 0.5 },
        uSheenPow: { value: 42 },
        uSheenGain: { value: 0.6 },
        uCoreGlow: { value: 0.7 },
        uFlashGain: { value: 1.4 },
        uGlow: { value: 1 }
      }),
      vertexShader: LATTICE_VERTEX,
      fragmentShader: LATTICE_FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.layers.set(LAYER.WORLD);
    this.mesh.renderOrder = options.renderOrder ?? 2;
    this.mesh.castShadow = options.castShadow ?? true;
    this.mesh.receiveShadow = options.receiveShadow ?? true;
    this.group.add(this.mesh);

    /* --- the structure, all unitless ---------------------------------- */
    this._x = new Float32Array(this.capacity);
    this._z = new Float32Array(this.capacity);
    this._layer = new Int32Array(this.capacity);
    this._turn = new Float32Array(this.capacity);
    this._rad = new Float32Array(this.capacity);
    /** Spatial hash for the refusal test: a head list and a next list. */
    this._head = new Int32Array(LATTICE_BUCKETS);
    this._next = new Int32Array(this.capacity);

    this.cells = 0;
    /** Last structure the growth ran against. Compared field by field. */
    this._structure = { cells: -1, seed: 0, drift: -1, refuse: -1, climb: -1, outward: -1, layers: -1 };
    this._p = latticeGrowthParams();
  }

  /** One, however many cells. */
  get drawCalls() {
    return 1;
  }

  /** Cells that survived the refusal. → `Ability#instanceCount`. */
  get count() {
    return this.cells;
  }

  /** Hide the comb. Leaves the instance reusable — the pooling contract. */
  reset() {
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  /**
   * Where the comb sits and which way its lattice's x axis points.
   *
   * @param {THREE.Vector3} anchor    the seed cell, in metres
   * @param {THREE.Vector3} [forward] the lattice's second axis; the first is
   *   derived from it, so a cast direction is the natural thing to pass
   */
  setPlacement(anchor, forward) {
    const u = this.material.uniforms;
    u.uAnchor.value.copy(anchor);
    _v0.copy(forward ?? _v1.set(0, 0, 1));
    _v0.y = 0;
    if (_v0.lengthSq() < 1e-8) _v0.set(0, 0, 1);
    _v0.normalize();
    u.uAxisZ.value.copy(_v0);
    u.uAxisX.value.set(_v0.z, 0, -_v0.x);
    return this;
  }

  _bucket(ix, iz, layer) {
    return ((ix * 73856093) ^ (iz * 19349663) ^ (layer * 83492791)) >>> 0 & (LATTICE_BUCKETS - 1);
  }

  /** True when a candidate lands on top of something already placed. */
  _refused(x, z, layer, refuse) {
    const r2 = refuse * refuse;
    const cx = Math.floor(x);
    const cz = Math.floor(z);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        let i = this._head[this._bucket(cx + dx, cz + dz, layer)];
        while (i >= 0) {
          if (this._layer[i] === layer) {
            const ex = this._x[i] - x;
            const ez = this._z[i] - z;
            if (ex * ex + ez * ez < r2) return true;
          }
          i = this._next[i];
        }
      }
    }
    return false;
  }

  /**
   * Run the growth. Writes unitless lattice coordinates and nothing else.
   *
   * Called from `update()` when the structure hash changes. Allocation-free:
   * every array it writes was sized at construction.
   */
  _grow(count, seed, drift, refuse, climb, outward, layers) {
    this._head.fill(-1);

    const put = (x, z, layer, turn, n) => {
      this._x[n] = x;
      this._z[n] = z;
      this._layer[n] = layer;
      this._turn[n] = turn;
      this._rad[n] = Math.hypot(x, z);
      const b = this._bucket(Math.floor(x), Math.floor(z), layer);
      this._next[n] = this._head[b];
      this._head[b] = n;
    };

    put(0, 0, 0, hash11(seed * 3.7) * drift, 0);
    let n = 1;

    /*
     * A breadth-first frontier, and it has to be breadth-first.
     *
     * The first version took the parent as `cursor % n` with `cursor` advancing
     * once per attempt. That reads like a sweep and is not one: `n` grows on
     * every success, so `cursor` and `n` advance in lockstep and the parent is
     * always the cell placed last. What grows is a single chain — a hundred and
     * sixty cells laid end to end over a hundred and twenty lattice units, one
     * cell wide. It looked like a worm.
     *
     * A head pointer that advances only when its parent is exhausted keeps the
     * frontier a ring, which is what a colony builds. `BRANCH` children per
     * parent before moving on: at 1 the comb is a spiral, at 6 it is a disc with
     * no history in it, and 3 leaves the lobes.
     */
    const BRANCH = 3;
    let head = 0;
    let budded = 0;
    const budget = count * 16;
    for (let attempt = 0; attempt < budget && n < count; attempt++) {
      // The frontier can run out before the count is met when refusals are
      // dense; sweeping back to the start lets the interior try again rather
      // than stopping short of the requested cells.
      if (head >= n) {
        head = 0;
        budded = 0;
      }
      const parent = head;

      const px = this._x[parent];
      const pz = this._z[parent];
      const pl = this._layer[parent];
      const pt = this._turn[parent];
      const plen = Math.hypot(px, pz);

      let best = -1e9;
      let bx = 0;
      let bz = 0;
      let bl = 0;
      let bt = 0;
      let found = false;

      for (let k = 0; k < 7; k++) {
        let cx;
        let cz;
        let cl;
        let ct;
        let score;
        if (k === 6) {
          if (climb <= 0 || pl + 1 >= layers) continue;
          cx = px;
          cz = pz;
          cl = pl + 1;
          ct = pt;
          // Climbing competes with spreading rather than pre-empting it, so a
          // blocked front goes up on its own instead of needing a rule for it.
          score = hash11(seed + parent * 5.13 + 77.1) * 0.5 + climb * 2 - 1;
        } else {
          // The child's frame is the PARENT's frame, turned. Not the world's —
          // there is no world lattice here, and that is the entire trick.
          const turn = pt + (hash11(seed + n * 7.13 + k * 2.71) - 0.5) * drift;
          const a = (k / 6 + pt) * TAU;
          cx = px + Math.cos(a);
          cz = pz + Math.sin(a);
          cl = pl;
          ct = turn;
          const radial = Math.hypot(cx, cz) - plen;
          score = hash11(seed + parent * 13.77 + k * 4.31) + outward * radial;
        }
        if (score <= best) continue;
        if (this._refused(cx, cz, cl, refuse)) continue;
        best = score;
        bx = cx;
        bz = cz;
        bl = cl;
        bt = ct;
        found = true;
      }

      if (!found) {
        // Every direction refused: this cell is enclosed and will never bud.
        head++;
        budded = 0;
        continue;
      }
      put(bx, bz, bl, bt, n);
      n++;
      budded++;
      if (budded >= BRANCH) {
        head++;
        budded = 0;
      }
    }

    this.cells = n;

    const cellArr = this._aCell.array;
    const infoArr = this._aInfo.array;
    for (let i = 0; i < n; i++) {
      cellArr[i * 3] = this._x[i];
      cellArr[i * 3 + 1] = this._z[i];
      cellArr[i * 3 + 2] = this._layer[i];
      infoArr[i * 4] = this._turn[i];
      infoArr[i * 4 + 1] = i; // order index — the stagger multiplies it
      infoArr[i * 4 + 2] = hash11(seed + i * 1.913 + 0.37);
      infoArr[i * 4 + 3] = this._rad[i];
    }
    this._aCell.needsUpdate = true;
    this._aInfo.needsUpdate = true;
    this.geometry.instanceCount = n;
  }

  /**
   * Push the live params, regrowing first if the structure changed.
   *
   * @param {number} now    the ability's `age` in seconds — the stagger is
   *   measured against it, so it must be the same clock the ability uses.
   * @param {object} params live block; keys from `latticeGrowthParams()`.
   */
  update(now, params) {
    const p = this._p;
    const src = params ?? LATTICE_DEFAULTS;
    for (const key in LATTICE_DEFAULTS) {
      const value = src[key];
      p[key] = value === undefined ? LATTICE_DEFAULTS[key] : value;
    }

    const count = clamp(Math.round(p.cells), 1, this.capacity);
    const layers = Math.max(1, Math.round(p.layers));
    // Seven compared scalars rather than a joined string. The string version
    // allocated once per frame for the lifetime of every cast, which is the
    // allocation invariant I3 forbids and the kind that never shows up in a
    // profile because it is only forty bytes — it shows up in the GC sawtooth.
    const s = this._structure;
    if (
      s.cells !== count ||
      s.seed !== p.seed ||
      s.drift !== p.drift ||
      s.refuse !== p.refuse ||
      s.climb !== p.climb ||
      s.outward !== p.outward ||
      s.layers !== layers
    ) {
      s.cells = count;
      s.seed = p.seed;
      s.drift = p.drift;
      s.refuse = p.refuse;
      s.climb = p.climb;
      s.outward = p.outward;
      s.layers = layers;
      this._grow(
        count,
        p.seed,
        Math.max(p.drift, 0),
        Math.max(p.refuse, 0.01),
        saturate(p.climb),
        p.outward,
        layers
      );
    }

    const u = this.material.uniforms;
    u.uNow.value = now;
    u.uCellPitch.value = p.pitch;
    u.uCellRadius.value = p.cellRadius;
    u.uSizeJitter.value = p.sizeJitter;
    u.uHeightBase.value = p.heightBase;
    u.uHeightPeak.value = p.heightPeak;
    u.uHeightFalloff.value = p.heightFalloff;
    u.uLayerHeight.value = p.layerHeight;
    u.uBaseY.value = p.baseY;
    u.uRise.value = p.rise;
    u.uStagger.value = p.stagger;
    u.uGrowTime.value = p.growTime;
    u.uOvershoot.value = p.overshoot;
    u.uRetract.value = p.retract;
    u.uTintRadius.value = p.tintRadius;
    u.uTintJitter.value = p.tintJitter;
    u.uWrap.value = p.wrap;
    u.uRimPow.value = p.rimPow;
    u.uRimGain.value = p.rimGain;
    u.uSheenPow.value = p.sheenPow;
    u.uSheenGain.value = p.sheenGain;
    u.uCoreGlow.value = p.coreGlow;
    u.uFlashGain.value = p.flashGain;
    u.uGlow.value = p.glow;
    copyPicker(u.uCombA.value, p.combA);
    copyPicker(u.uCombB.value, p.combB);
    copyPicker(u.uCombC.value, p.combC);
    copyPicker(u.uCombD.value, p.combD);
    copyPicker(u.uCoreColor.value, p.coreColor);
    copyPicker(u.uRimColor.value, p.rimColor);
    copyPicker(u.uSheenColor.value, p.sheenColor);
    copyPicker(u.uFlashColor.value, p.flashColor);

    this.mesh.visible = this.cells > 0 && p.retract > 0 && p.cellRadius > 0;
  }

  /**
   * Where cell `index` stands, in world metres — for an emitter, a light or a
   * decal. Reads the same floats the vertex shader reads, so it lands *on* the
   * cell rather than near it.
   *
   * @param {number} index
   * @param {object} p    the same live block handed to `update()`
   * @param {THREE.Vector3} out
   * @param {number} [height] 0 the cell's base, 1 its rim
   */
  cellPoint(index, p, out, height = 1) {
    const i = clamp(Math.round(index), 0, Math.max(0, this.cells - 1));
    const u = this.material.uniforms;
    const pitch = p.pitch ?? LATTICE_DEFAULTS.pitch;
    const far = saturate(this._rad[i] / Math.max(p.heightFalloff ?? LATTICE_DEFAULTS.heightFalloff, 0.01));
    const h =
      (p.heightPeak ?? LATTICE_DEFAULTS.heightPeak) * (1 - far) +
      (p.heightBase ?? LATTICE_DEFAULTS.heightBase) * far;
    out
      .copy(u.uAnchor.value)
      .addScaledVector(u.uAxisX.value, this._x[i] * pitch)
      .addScaledVector(u.uAxisZ.value, this._z[i] * pitch);
    out.y =
      (p.baseY ?? LATTICE_DEFAULTS.baseY) +
      this._layer[i] * (p.layerHeight ?? LATTICE_DEFAULTS.layerHeight) +
      h * height;
    return out;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.group.parent?.remove(this.group);
  }
}

/* ====================================================================== */
/*  §4 · Shell tessellation                                               */
/* ====================================================================== */

/**
 * Vertices a plate's polygon may have.
 *
 * A Voronoi cell over a Fibonacci hemisphere is almost always a hexagon and
 * occasionally a pentagon or a heptagon; twelve is four standard deviations of
 * headroom. It matters because the vertex layout is **fixed** — every plate
 * occupies the same number of slots whatever its real side count, unused slots
 * collapse onto the last real vertex and draw as zero-area triangles, and that
 * is what lets the index buffer be written once at construction and never
 * touched again.
 */
const MAX_PLATE_SIDES = 12;

/** Vertices per plate: two fan centres, two rims, four per side wall. */
const PLATE_VERTS = 2 + 6 * MAX_PLATE_SIDES;

/** Indices per plate: two fans of M triangles, M quads of two. */
const PLATE_INDICES = 12 * MAX_PLATE_SIDES;

/** Tangent radius of the polygon each cell starts as, before any clipping. */
const PLATE_SEED_RADIUS = 2.2;

const SHELL_VERTEX = /* glsl */ `
  #define PI 3.141592653589793

  uniform vec3  uAnchor;        // metres
  uniform vec3  uAxisX;         // unit
  uniform vec3  uAxisZ;         // unit
  uniform float uNow;           // seconds since the cast began

  uniform vec3  uRadius;        // metres — three, so the dome can be an ellipsoid
  uniform float uThickness;     // metres a plate is extruded inward
  uniform float uSeam;          // 0..1 the rim is drawn in toward the plate centre
  uniform float uFlyOut;        // metres a plate starts out from its locked place
  uniform float uTumbleSpin;    // radians it starts rotated about its own axis
  uniform float uTumbleSwing;   // radians it starts tipped off the dome
  uniform float uStagger;       // seconds between one plate locking and the next
  uniform float uLockTime;      // seconds one plate takes to arrive
  uniform float uOrderScatter;  // 0 they lock from the ground up, 1 at random
  uniform float uRetract;       // 1 the dome is closed, 0 it is gone

  attribute vec3 aDir;          // unit: this vertex on the sphere
  attribute vec3 aCentre;       // unit: the plate's own centre
  attribute vec3 aNrm;          // unit: the face normal, in the sphere's frame
  attribute vec3 aFace;         // x side 0 outer / 1 inner, y rim, z side wall
  attribute vec3 aPlate;        // orderY, orderHash, dice

  varying vec3  vNormal;
  varying vec3  vWorld;
  varying float vWall;
  varying float vDice;
  varying float vHeight;
  varying float vLock;

  ${noiseGLSL}

  /** Rotate v about a unit axis. Rodrigues, three terms, no matrix. */
  vec3 shellRotate(vec3 v, vec3 axis, float a) {
    float c = cos(a);
    float s = sin(a);
    return v * c + cross(axis, v) * s + axis * (dot(axis, v) * (1.0 - c));
  }

  void main() {
    float dice = aPlate.z;
    float order = mix(aPlate.x, aPlate.y, clamp(uOrderScatter, 0.0, 1.0));
    float e = clamp((uNow - order * uStagger) / max(uLockTime, 1e-3), 0.0, 1.0);
    float ease = 1.0 - pow(1.0 - e, 3.0);
    // Everything the fly-in does is multiplied by k, and k is exactly zero when
    // the plate has landed. That is the guarantee the whole module exists for:
    // no easing curve, no overshoot and no tumble can leave a plate a
    // millimetre off the tessellation, because at e = 1 none of them apply.
    float k = 1.0 - ease;

    // The seam is drawn on the UNIT sphere before any of the metres arrive, so
    // two neighbours inset by the same fraction of their own cell and the gap
    // between them stays even all the way round.
    vec3 dir = normalize(mix(aDir, aCentre, clamp(uSeam, 0.0, 1.0)));
    vec3 nrm = aNrm;
    vec3 centre = aCentre;

    vec3 tangent = normalize(cross(aCentre, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 1e-4));
    float spin = uTumbleSpin * k * ((hash11(dice * 17.3) - 0.5) * 2.0);
    float swing = uTumbleSwing * k * ((dice - 0.5) * 2.0);

    dir = shellRotate(dir, aCentre, spin);
    nrm = shellRotate(nrm, aCentre, spin);
    dir = shellRotate(dir, tangent, swing);
    nrm = shellRotate(nrm, tangent, swing);
    centre = shellRotate(centre, tangent, swing);

    vec3 rad = max(uRadius - aFace.x * uThickness, vec3(0.01));
    vec3 local = dir * rad + centre * (uFlyOut * k);
    local *= clamp(uRetract, 0.0, 1.0);

    // An ellipsoid's normal is not its radial direction. One divide fixes it,
    // and without it a squashed dome lights as though it were a sphere.
    vec3 fixedNrm = normalize(nrm / rad);

    vec3 world = uAnchor
               + uAxisX * local.x
               + vec3(0.0, 1.0, 0.0) * local.y
               + uAxisZ * local.z;

    vNormal = normalize(uAxisX * fixedNrm.x + vec3(0.0, 1.0, 0.0) * fixedNrm.y + uAxisZ * fixedNrm.z);
    vWorld = world;
    vWall = aFace.z;
    vDice = dice;
    vHeight = clamp(aCentre.y, 0.0, 1.0);
    vLock = ease;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  }
`;

const SHELL_FRAGMENT = /* glsl */ `
  uniform vec3  uLightDir;
  uniform float uGlobalGlow;

  uniform vec3  uPlateA;
  uniform vec3  uPlateB;
  uniform vec3  uPlateC;
  uniform vec3  uPlateD;
  uniform vec3  uRimColor;
  uniform vec3  uSheenColor;
  uniform vec3  uSeamColor;
  uniform vec3  uArriveColor;

  uniform float uTintHeight;    // how much of the gradient the dome's height walks
  uniform float uTintJitter;
  uniform float uWrap;
  uniform float uRimPow;
  uniform float uRimGain;
  uniform float uSheenPow;
  uniform float uSheenGain;
  uniform float uSeamGlow;      // how hot the side walls are
  uniform float uArriveGain;    // flash as a plate locks
  uniform float uGlow;

  varying vec3  vNormal;
  varying vec3  vWorld;
  varying float vWall;
  varying float vDice;
  varying float vHeight;
  varying float vLock;

  ${commonGLSL}
  ${COLONY_CHITIN_GLSL}

  void main() {
    if (vLock < 0.001) discard;

    vec3 n = normalize(vNormal);
    vec3 v = normalize(cameraPosition - vWorld);
    vec3 l = normalize(uLightDir);

    float t = clamp(vHeight * uTintHeight + (vDice - 0.5) * 2.0 * uTintJitter, 0.0, 1.0);
    vec3 body = gradient4(uPlateA, uPlateB, uPlateC, uPlateD, t);

    vec3 colour = chitin(n, v, l, body, uRimColor, uSheenColor,
                         uWrap, uRimPow, uRimGain, uSheenPow, uSheenGain);

    // The side walls are the seams, and the seams are the point: they are the
    // only evidence that the dome is made of separate plates at all once it has
    // closed. Lighting them from inside is cheaper and reads better than trying
    // to find the seam in screen space.
    colour += uSeamColor * (vWall * uSeamGlow);
    colour += uArriveColor * (pow(1.0 - vLock, 3.0) * uArriveGain);
    colour *= uGlow * uGlobalGlow;

    gl_FragColor = vec4(colour, 1.0);
  }
`;

/**
 * Every key `PlateShell.update()` understands, with its default and its unit.
 *
 * The **tessellation** group is structural: `sites`, `seed` and `jitter` are
 * what the Voronoi is computed from, and changing any of them re-tessellates
 * inside `update()` on the frame it changes. Everything else is a uniform.
 */
export function plateShellParams() {
  return {
    /* --- the tessellation: changing any of these re-tessellates --- */
    sites: 46, // plates, whole number, at least 12
    seed: 0,
    jitter: 0.35, // unitless wobble on the Fibonacci sites — 0 is too regular

    /* --- the metres --- */
    radiusX: 3.2, // metres
    radiusY: 2.4, // metres — a dome is not a hemisphere, it is squatter
    radiusZ: 3.2, // metres
    thickness: 0.12, // metres a plate is extruded inward
    seam: 0.045, // 0..1 the rim is drawn in toward the plate centre
    flyOut: 2.6, // metres a plate starts out from its locked place
    tumbleSpin: 1.9, // radians it starts rotated about its own axis
    tumbleSwing: 1.1, // radians it starts tipped off the dome

    /* --- the clock --- */
    stagger: 0.013, // seconds between one plate locking and the next
    lockTime: 0.34, // seconds one plate takes to arrive
    orderScatter: 0.3, // 0 they lock from the ground up, 1 at random
    retract: 1, // 1 the dome is closed, 0 it is gone

    /* --- the look --- */
    tintHeight: 0.85, // how much of the gradient the dome's height walks
    tintJitter: 0.16,
    wrap: 0.35,
    rimPow: 3,
    rimGain: 0.65,
    sheenPow: 56,
    sheenGain: 0.9,
    seamGlow: 0.35, // how hot the side walls are
    arriveGain: 1.6, // flash as a plate locks
    glow: 1,

    /* --- eight pickers, none derived from another --- */
    plateA: '#5a4a22',
    plateB: '#8a7028',
    plateC: '#c8a83c',
    plateD: '#e8d888',
    rimColor: '#fff2c0',
    sheenColor: '#ffffff',
    seamColor: '#ffb43a',
    arriveColor: '#fff0b8'
  };
}

const SHELL_DEFAULTS = plateShellParams();

/**
 * **What it draws.** A dome made of interlocking chitin plates: a Voronoi
 * tessellation of a hemisphere, each cell a solid plate with a rim and a side
 * wall, each flying in from outside and locking against its neighbours.
 *
 * **Draw calls.** One, however many plates.
 *
 * **What it reads from settings.** Nothing directly. `update(now, params)`
 * resolves `p.key ?? default` for every key in `plateShellParams()`.
 *
 * **The one rule for using it well.** *Let it finish, and keep `seam` small.*
 * Everything this module is worth is in the last tenth of a second of the
 * animation, when the last plates drop into holes that are exactly their own
 * shape. A dome held at half-built, or opened up with a large `seam`, is a
 * scatter of debris — and a scatter of debris is what `ShatterField` is for.
 *
 * ---
 *
 * ## Why the seams are exact
 *
 * Two points on a unit sphere are equidistant from a third exactly when that
 * third point lies on the plane through the **origin** whose normal is their
 * difference — the `|x|² ` terms cancel because both sites are unit vectors. So
 * a spherical Voronoi cell is the intersection of half-spaces through the
 * origin, and it can be built by ordinary polygon clipping: start each cell as
 * a wide polygon in the tangent plane at its site, clip it by one plane per
 * other site, and project what survives back onto the sphere.
 *
 * The exactness follows for free. The edge that cell `i` gets from the plane
 * bisecting `i` and `j` is the *same plane* cell `j` gets from bisecting `j` and
 * `i`; the endpoints of that edge are where a third bisector cuts it, and both
 * cells cut it with the same third bisector. Adjacent plates therefore share
 * their boundary vertices to the last bit of the arithmetic that produced them.
 * The dome closes with no gaps and no overlaps because the two plates that meet
 * at a seam are solving the same equation.
 *
 * That is why this is not "scatter some plates and hope". A rejection-sampled
 * or noise-perturbed plate layout leaves slivers of daylight, and the eye finds
 * every one of them the moment there is anything bright behind the dome.
 *
 * ## The equator is one more plane
 *
 * A hemisphere's rim needs no special case: clipping every cell additionally by
 * `y ≥ 0` — a plane through the origin like all the others — cuts the dome off
 * flat at the ground with the same exactness, so the plates that meet the floor
 * meet it in a straight line rather than a fringe.
 *
 * ## Cost
 *
 * `tessellate()` is O(n²) half-plane clips — 46 sites is about two thousand,
 * around a fifth of a millisecond, and it runs only when `sites`, `seed` or
 * `jitter` change. It allocates nothing: the clipper ping-pongs between two
 * scratch arrays sized at construction, as does everything it writes.
 *
 * @example
 *   this.shell = new PlateShell(this.group, { capacity: 64 });
 *   // every frame
 *   this.shell.setPlacement(_anchor, _direction);
 *   this.shell.update(age, settings.carapace);
 */
export class PlateShell {
  /**
   * @param {THREE.Object3D} parent
   * @param {object}  [options]
   * @param {number}  [options.capacity=64]  hard ceiling on plates
   * @param {number}  [options.renderOrder=2]
   * @param {boolean} [options.castShadow=true]
   */
  constructor(parent, options = {}) {
    this.capacity = clamp(Math.round(options.capacity ?? 64), 12, 400);

    this.group = new Group();
    this.group.name = 'PlateShell';
    this.group.matrixAutoUpdate = false;
    parent?.add(this.group);

    const verts = this.capacity * PLATE_VERTS;
    this._aDir = new BufferAttribute(new Float32Array(verts * 3), 3);
    this._aCentre = new BufferAttribute(new Float32Array(verts * 3), 3);
    this._aNrm = new BufferAttribute(new Float32Array(verts * 3), 3);
    this._aFaceAttr = new BufferAttribute(new Float32Array(verts * 3), 3);
    this._aPlate = new BufferAttribute(new Float32Array(verts * 3), 3);

    // `position` is never read by the shader — every vertex is placed from
    // aDir — but three.js wants the attribute to exist, and a zero-filled one
    // costs a buffer nobody samples rather than a special case in the shader.
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(verts * 3), 3));
    geometry.setAttribute('aDir', this._aDir);
    geometry.setAttribute('aCentre', this._aCentre);
    geometry.setAttribute('aNrm', this._aNrm);
    geometry.setAttribute('aFace', this._aFaceAttr);
    geometry.setAttribute('aPlate', this._aPlate);

    /* --- the index buffer, written once and never again --------------- */
    const index = new Uint16Array(this.capacity * PLATE_INDICES);
    const M = MAX_PLATE_SIDES;
    for (let p = 0; p < this.capacity; p++) {
      const base = p * PLATE_VERTS;
      const outerCentre = base;
      const outerRim = base + 1;
      const innerCentre = base + 1 + M;
      const innerRim = base + 2 + M;
      const wall = base + 2 + 2 * M;
      let o = p * PLATE_INDICES;
      for (let j = 0; j < M; j++) {
        const jn = (j + 1) % M;
        index[o++] = outerCentre;
        index[o++] = outerRim + j;
        index[o++] = outerRim + jn;
        index[o++] = innerCentre;
        index[o++] = innerRim + jn;
        index[o++] = innerRim + j;
        const w = wall + j * 4;
        index[o++] = w;
        index[o++] = w + 1;
        index[o++] = w + 2;
        index[o++] = w;
        index[o++] = w + 2;
        index[o++] = w + 3;
      }
    }
    geometry.setIndex(new BufferAttribute(index, 1));
    geometry.setDrawRange(0, 0);
    geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    this.geometry = geometry;

    this.material = new ShaderMaterial({
      transparent: false,
      depthWrite: true,
      depthTest: true,
      side: FrontSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uAnchor: { value: new Vector3() },
        uAxisX: { value: new Vector3(1, 0, 0) },
        uAxisZ: { value: new Vector3(0, 0, 1) },
        uNow: { value: 0 },
        uRadius: { value: new Vector3(3.2, 2.4, 3.2) },
        uThickness: { value: 0.12 },
        uSeam: { value: 0.045 },
        uFlyOut: { value: 2.6 },
        uTumbleSpin: { value: 1.9 },
        uTumbleSwing: { value: 1.1 },
        uStagger: { value: 0.013 },
        uLockTime: { value: 0.34 },
        uOrderScatter: { value: 0.3 },
        uRetract: { value: 1 },
        uPlateA: { value: new Color('#5a4a22') },
        uPlateB: { value: new Color('#8a7028') },
        uPlateC: { value: new Color('#c8a83c') },
        uPlateD: { value: new Color('#e8d888') },
        uRimColor: { value: new Color('#fff2c0') },
        uSheenColor: { value: new Color('#ffffff') },
        uSeamColor: { value: new Color('#ffb43a') },
        uArriveColor: { value: new Color('#fff0b8') },
        uTintHeight: { value: 0.85 },
        uTintJitter: { value: 0.16 },
        uWrap: { value: 0.35 },
        uRimPow: { value: 3 },
        uRimGain: { value: 0.65 },
        uSheenPow: { value: 56 },
        uSheenGain: { value: 0.9 },
        uSeamGlow: { value: 0.35 },
        uArriveGain: { value: 1.6 },
        uGlow: { value: 1 }
      }),
      vertexShader: SHELL_VERTEX,
      fragmentShader: SHELL_FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.layers.set(LAYER.WORLD);
    this.mesh.renderOrder = options.renderOrder ?? 2;
    this.mesh.castShadow = options.castShadow ?? true;
    this.mesh.receiveShadow = options.receiveShadow ?? false;
    this.group.add(this.mesh);

    /* --- tessellation scratch, sized once ----------------------------- */
    const SLOTS = MAX_PLATE_SIDES * 4;
    this._sites = new Float32Array(this.capacity * 3);
    this._centres = new Float32Array(this.capacity * 3);
    this._poly = new Float32Array(this.capacity * MAX_PLATE_SIDES * 3);
    this._polyCount = new Int32Array(this.capacity);
    this._clipA = new Float32Array(SLOTS * 3);
    this._clipB = new Float32Array(SLOTS * 3);
    this._slots = SLOTS;

    this.plates = 0;
    /** Last tessellation the clipper ran. Compared field by field. */
    this._structure = { sites: -1, seed: 0, jitter: -1 };
    this._p = plateShellParams();
  }

  /** One, however many plates. */
  get drawCalls() {
    return 1;
  }

  /** Plates in the tessellation. → `Ability#instanceCount`. */
  get count() {
    return this.plates;
  }

  /** Hide the dome. Leaves the instance reusable — the pooling contract. */
  reset() {
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
  }

  /**
   * Where the dome stands and which way its lattice's z axis points.
   * The dome's base sits on `anchor.y`.
   */
  setPlacement(anchor, forward) {
    const u = this.material.uniforms;
    u.uAnchor.value.copy(anchor);
    _v0.copy(forward ?? _v1.set(0, 0, 1));
    _v0.y = 0;
    if (_v0.lengthSq() < 1e-8) _v0.set(0, 0, 1);
    _v0.normalize();
    u.uAxisZ.value.copy(_v0);
    u.uAxisX.value.set(_v0.z, 0, -_v0.x);
    return this;
  }

  /**
   * Clip a polygon by the half-space `dot(x, m) <= 0`, where the plane passes
   * through the origin. Sutherland–Hodgman, in 3D, allocation-free.
   *
   * @returns the number of vertices written to `dst`
   */
  _clip(src, n, dst, mx, my, mz) {
    let out = 0;
    for (let a = 0; a < n; a++) {
      const b = (a + 1) % n;
      const ax = src[a * 3];
      const ay = src[a * 3 + 1];
      const az = src[a * 3 + 2];
      const bx = src[b * 3];
      const by = src[b * 3 + 1];
      const bz = src[b * 3 + 2];
      const da = ax * mx + ay * my + az * mz;
      const db = bx * mx + by * my + bz * mz;
      const keepA = da <= 0;
      if (keepA && out < this._slots) {
        dst[out * 3] = ax;
        dst[out * 3 + 1] = ay;
        dst[out * 3 + 2] = az;
        out++;
      }
      if (keepA !== db <= 0 && out < this._slots) {
        // The crossing point. Both cells sharing this plane compute it from the
        // same two endpoints, which is the whole basis of the exactness claim.
        const t = da / (da - db);
        dst[out * 3] = ax + (bx - ax) * t;
        dst[out * 3 + 1] = ay + (by - ay) * t;
        dst[out * 3 + 2] = az + (bz - az) * t;
        out++;
      }
    }
    return out;
  }

  /**
   * Build the tessellation and write the whole vertex buffer.
   *
   * Called from `update()` when the structure hash changes.
   *
   * @param {number} sites  plates to place, >= 12
   * @param {number} seed
   * @param {number} jitter unitless wobble on the Fibonacci lattice
   */
  tessellate(sites, seed, jitter) {
    const n = clamp(Math.round(sites), 12, this.capacity);
    const S = this._sites;

    /* --- the sites: a Fibonacci hemisphere ---------------------------- */
    // Even by construction and rejection-free: the i-th of n points has
    // height (i + 0.5) / n, which distributes area uniformly because a sphere's
    // area is uniform in height. A jittered *lattice* rather than a random
    // scatter, because random points clump, and a clumped Voronoi gives one
    // plate the size of four and reads as damage rather than as armour.
    for (let i = 0; i < n; i++) {
      const y = (i + 0.5) / n;
      const r = Math.sqrt(Math.max(1 - y * y, 0));
      const phi = i * GOLDEN_ANGLE + seed;
      let x = Math.cos(phi) * r;
      let z = Math.sin(phi) * r;
      let yy = y;
      if (jitter > 0) {
        const j = jitter / Math.sqrt(n);
        x += (hash11(seed + i * 3.71) - 0.5) * 2 * j;
        yy += (hash11(seed + i * 7.13 + 5.1) - 0.5) * 2 * j;
        z += (hash11(seed + i * 11.9 + 9.7) - 0.5) * 2 * j;
        // A site that jittered under the equator would own a cell the clip
        // throws away entirely, so it is folded back up rather than dropped.
        yy = Math.abs(yy);
      }
      const len = Math.hypot(x, yy, z) || 1;
      S[i * 3] = x / len;
      S[i * 3 + 1] = yy / len;
      S[i * 3 + 2] = z / len;
    }

    /* --- one cell at a time ------------------------------------------- */
    let live = 0;
    for (let i = 0; i < n; i++) {
      const sx = S[i * 3];
      const sy = S[i * 3 + 1];
      const sz = S[i * 3 + 2];

      // A tangent basis at the site. The seed polygon is an octagon out at
      // PLATE_SEED_RADIUS, which is several times any real cell's reach, so it
      // never contributes an edge of its own.
      _v0.set(sx, sy, sz);
      _v1.set(0, 1, 0);
      if (Math.abs(sy) > 0.9) _v1.set(1, 0, 0);
      _v2.crossVectors(_v1, _v0).normalize();
      _v3.crossVectors(_v0, _v2).normalize();

      let src = this._clipA;
      let dst = this._clipB;
      let count = 8;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU;
        const cx = sx + (_v2.x * Math.cos(a) + _v3.x * Math.sin(a)) * PLATE_SEED_RADIUS;
        const cy = sy + (_v2.y * Math.cos(a) + _v3.y * Math.sin(a)) * PLATE_SEED_RADIUS;
        const cz = sz + (_v2.z * Math.cos(a) + _v3.z * Math.sin(a)) * PLATE_SEED_RADIUS;
        src[k * 3] = cx;
        src[k * 3 + 1] = cy;
        src[k * 3 + 2] = cz;
      }

      for (let j = 0; j < n && count >= 3; j++) {
        if (j === i) continue;
        count = this._clip(src, count, dst, S[j * 3] - sx, S[j * 3 + 1] - sy, S[j * 3 + 2] - sz);
        const swap = src;
        src = dst;
        dst = swap;
      }
      // The equator: exactly one more plane through the origin, so the rim of
      // the dome is as exact as every other seam.
      if (count >= 3) {
        count = this._clip(src, count, dst, 0, -1, 0);
        const swap = src;
        src = dst;
        dst = swap;
      }

      if (count < 3) {
        this._polyCount[live] = 0;
        continue;
      }

      const k = Math.min(count, MAX_PLATE_SIDES);
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let v = 0; v < k; v++) {
        const px = src[v * 3];
        const py = src[v * 3 + 1];
        const pz = src[v * 3 + 2];
        const len = Math.hypot(px, py, pz) || 1;
        const base = (live * MAX_PLATE_SIDES + v) * 3;
        this._poly[base] = px / len;
        this._poly[base + 1] = py / len;
        this._poly[base + 2] = pz / len;
        cx += px / len;
        cy += py / len;
        cz += pz / len;
      }
      const clen = Math.hypot(cx, cy, cz) || 1;
      this._centres[live * 3] = cx / clen;
      this._centres[live * 3 + 1] = cy / clen;
      this._centres[live * 3 + 2] = cz / clen;
      this._polyCount[live] = k;
      live++;
    }

    this.plates = live;
    this._writeVertices(seed);
    this.geometry.setDrawRange(0, live * PLATE_INDICES);
    return live;
  }

  /** Expand the polygons into the fixed vertex layout. */
  _writeVertices(seed) {
    const M = MAX_PLATE_SIDES;
    const dir = this._aDir.array;
    const cen = this._aCentre.array;
    const nrm = this._aNrm.array;
    const face = this._aFaceAttr.array;
    const plate = this._aPlate.array;

    for (let p = 0; p < this.plates; p++) {
      const k = this._polyCount[p];
      const base = p * PLATE_VERTS;
      const ccx = this._centres[p * 3];
      const ccy = this._centres[p * 3 + 1];
      const ccz = this._centres[p * 3 + 2];
      const dice = hash11(seed + p * 2.713 + 0.91);
      // The base plates lock first: a dome that closes from the ground up looks
      // like it is being built, and one that closes from the top down looks
      // like it is being dropped on you.
      const orderY = 1 - clamp(ccy, 0, 1);
      const orderHash = hash11(seed + p * 5.317 + 13.3);

      const put = (slot, dx, dy, dz, nx, ny, nz, side, rim, wall) => {
        const v = (base + slot) * 3;
        dir[v] = dx;
        dir[v + 1] = dy;
        dir[v + 2] = dz;
        cen[v] = ccx;
        cen[v + 1] = ccy;
        cen[v + 2] = ccz;
        nrm[v] = nx;
        nrm[v + 1] = ny;
        nrm[v + 2] = nz;
        face[v] = side;
        face[v + 1] = rim;
        face[v + 2] = wall;
        plate[v] = orderY;
        plate[v + 1] = orderHash;
        plate[v + 2] = dice;
      };

      // Fan centres. The outer face's normal is the plate's own centre for
      // every vertex on it, not the vertex's radial direction: a flat normal
      // over a curved position is what makes the dome read as panels rather
      // than as a smooth shell with lines drawn on it.
      put(0, ccx, ccy, ccz, ccx, ccy, ccz, 0, 0, 0);
      put(1 + M, ccx, ccy, ccz, -ccx, -ccy, -ccz, 1, 0, 0);

      for (let j = 0; j < M; j++) {
        // Slots past the real side count collapse onto the last real vertex,
        // so their triangles have zero area and cost a vertex shader each.
        const a = Math.min(j, k - 1);
        const ax = this._poly[(p * M + a) * 3];
        const ay = this._poly[(p * M + a) * 3 + 1];
        const az = this._poly[(p * M + a) * 3 + 2];
        put(1 + j, ax, ay, az, ccx, ccy, ccz, 0, 1, 0);
        put(2 + M + j, ax, ay, az, -ccx, -ccy, -ccz, 1, 1, 0);
      }

      for (let j = 0; j < M; j++) {
        // Real edges are (j, j+1) with the last wrapping to 0; the padding
        // slots point both ends at the last real vertex and vanish.
        const j0 = Math.min(j, k - 1);
        const j1 = j + 1 < k ? j + 1 : j + 1 === k ? 0 : j0;
        const ax = this._poly[(p * M + j0) * 3];
        const ay = this._poly[(p * M + j0) * 3 + 1];
        const az = this._poly[(p * M + j0) * 3 + 2];
        const bx = this._poly[(p * M + j1) * 3];
        const by = this._poly[(p * M + j1) * 3 + 1];
        const bz = this._poly[(p * M + j1) * 3 + 2];

        // Outward normal of the wall: perpendicular to the edge and to the
        // plate's own axis, flipped to face away from the plate's centre.
        _v0.set(bx - ax, by - ay, bz - az);
        _v1.set(ccx, ccy, ccz);
        _v2.crossVectors(_v0, _v1);
        if (_v2.lengthSq() < 1e-12) _v2.set(ax - ccx, ay - ccy, az - ccz);
        _v2.normalize();
        _v3.set((ax + bx) * 0.5 - ccx, (ay + by) * 0.5 - ccy, (az + bz) * 0.5 - ccz);
        if (_v2.dot(_v3) < 0) _v2.multiplyScalar(-1);

        const w = 2 + 2 * M + j * 4;
        put(w, ax, ay, az, _v2.x, _v2.y, _v2.z, 0, 1, 1);
        put(w + 1, bx, by, bz, _v2.x, _v2.y, _v2.z, 0, 1, 1);
        put(w + 2, bx, by, bz, _v2.x, _v2.y, _v2.z, 1, 1, 1);
        put(w + 3, ax, ay, az, _v2.x, _v2.y, _v2.z, 1, 1, 1);
      }
    }

    this._aDir.needsUpdate = true;
    this._aCentre.needsUpdate = true;
    this._aNrm.needsUpdate = true;
    this._aFaceAttr.needsUpdate = true;
    this._aPlate.needsUpdate = true;
  }

  /**
   * Push the live params, re-tessellating first if the structure changed.
   *
   * @param {number} now    the ability's `age` in seconds — the lock stagger is
   *   measured against it.
   * @param {object} params live block; keys from `plateShellParams()`.
   */
  update(now, params) {
    const p = this._p;
    const src = params ?? SHELL_DEFAULTS;
    for (const key in SHELL_DEFAULTS) {
      const value = src[key];
      p[key] = value === undefined ? SHELL_DEFAULTS[key] : value;
    }

    const sites = clamp(Math.round(p.sites), 12, this.capacity);
    // Three compared scalars, not a joined string — see LatticeGrowth#update().
    const s = this._structure;
    if (s.sites !== sites || s.seed !== p.seed || s.jitter !== p.jitter) {
      s.sites = sites;
      s.seed = p.seed;
      s.jitter = p.jitter;
      this.tessellate(sites, p.seed, Math.max(p.jitter, 0));
    }

    const u = this.material.uniforms;
    u.uNow.value = now;
    u.uRadius.value.set(p.radiusX, p.radiusY, p.radiusZ);
    u.uThickness.value = p.thickness;
    u.uSeam.value = p.seam;
    u.uFlyOut.value = p.flyOut;
    u.uTumbleSpin.value = p.tumbleSpin;
    u.uTumbleSwing.value = p.tumbleSwing;
    u.uStagger.value = p.stagger;
    u.uLockTime.value = p.lockTime;
    u.uOrderScatter.value = p.orderScatter;
    u.uRetract.value = p.retract;
    u.uTintHeight.value = p.tintHeight;
    u.uTintJitter.value = p.tintJitter;
    u.uWrap.value = p.wrap;
    u.uRimPow.value = p.rimPow;
    u.uRimGain.value = p.rimGain;
    u.uSheenPow.value = p.sheenPow;
    u.uSheenGain.value = p.sheenGain;
    u.uSeamGlow.value = p.seamGlow;
    u.uArriveGain.value = p.arriveGain;
    u.uGlow.value = p.glow;
    copyPicker(u.uPlateA.value, p.plateA);
    copyPicker(u.uPlateB.value, p.plateB);
    copyPicker(u.uPlateC.value, p.plateC);
    copyPicker(u.uPlateD.value, p.plateD);
    copyPicker(u.uRimColor.value, p.rimColor);
    copyPicker(u.uSheenColor.value, p.sheenColor);
    copyPicker(u.uSeamColor.value, p.seamColor);
    copyPicker(u.uArriveColor.value, p.arriveColor);

    this.mesh.visible = this.plates > 0 && p.retract > 0;
  }

  /**
   * 0..1 of the dome that has locked, given the live clock. What an ability
   * polls to know when to fire the impact.
   */
  progress(now, p) {
    const stagger = p.stagger ?? SHELL_DEFAULTS.stagger;
    const lock = Math.max(p.lockTime ?? SHELL_DEFAULTS.lockTime, 1e-3);
    const span = Math.max(this.plates - 1, 1) * stagger + lock;
    return saturate(now / span);
  }

  /**
   * The locked world position of plate `index`'s centre — for a light, an
   * emitter or a decal. The fly-in is deliberately left out: this is where the
   * plate is *going*, which is what a light wants to be at.
   */
  plateCentre(index, p, out) {
    const i = clamp(Math.round(index), 0, Math.max(0, this.plates - 1));
    const u = this.material.uniforms;
    const dx = this._centres[i * 3];
    const dy = this._centres[i * 3 + 1];
    const dz = this._centres[i * 3 + 2];
    const rx = (p.radiusX ?? SHELL_DEFAULTS.radiusX) * dx;
    const ry = (p.radiusY ?? SHELL_DEFAULTS.radiusY) * dy;
    const rz = (p.radiusZ ?? SHELL_DEFAULTS.radiusZ) * dz;
    out
      .copy(u.uAnchor.value)
      .addScaledVector(u.uAxisX.value, rx)
      .addScaledVector(u.uAxisZ.value, rz);
    out.y += ry;
    return out;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.group.parent?.remove(this.group);
  }
}
