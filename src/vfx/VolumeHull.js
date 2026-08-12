import {
  Mesh,
  BoxGeometry,
  CylinderGeometry,
  ConeGeometry,
  SphereGeometry,
  ShaderMaterial,
  CustomBlending,
  AddEquation,
  OneFactor,
  OneMinusSrcAlphaFactor,
  AdditiveBlending,
  BackSide,
  Color,
  Matrix4,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { getColor } from '../utils/color.js';
import { num, auditBlock } from './prefixedBlock.js';

/* ---------------------------------------------------------------- */
/* Enums                                                             */
/* ---------------------------------------------------------------- */

/**
 * The proxy hull the ray is marched inside.
 *
 * Every one of these is a *unit* primitive in object space, resized by the
 * `uSize` uniform in the vertex shader — never by `mesh.scale` and never by
 * rebuilding geometry. That is not a micro-optimisation, it is invariant I1:
 * dragging a radius slider with the sim paused (`P`) has to resize the standing
 * volume, and a CPU-side rebuild cannot happen on a zero-length frame.
 *
 * Local axes, in metres, after the vertex stage has applied `uSize`:
 *
 *   BOX       x ∈ [-Sx, Sx]   y ∈ [0, Sy]   z ∈ [-Sz, Sz]   — a slab on the floor
 *   CYLINDER  elliptic radius (Sx, Sz) in xz, y ∈ [0, Sy]   — a column on the floor
 *   CONE      apex at the origin, axis +Z, mouth radii (Sx, Sy) at z = Sz
 *   DOME      half-ellipsoid, radii (Sx, Sy, Sz), y ≥ 0     — sits on the floor
 *   SPHERE    ellipsoid, radii (Sx, Sy, Sz), centred on the origin
 *
 * CONE points down +Z because +Z is the cast heading everywhere else in this
 * project (`Ability.direction`); the others stand up +Y because they sit on the
 * ground and gravity does not care which way the caster is facing.
 */
export const HullShape = Object.freeze({
  BOX: 0,
  CYLINDER: 1,
  CONE: 2,
  DOME: 3,
  SPHERE: 4
});

/**
 * Which medium the shared shader compiles into.
 *
 * These are `#define`d variants of one fragment shader rather than eight
 * shaders. The march, the hull intersection, the compositing and the depth
 * clipping are identical in all eight — only twenty-odd lines in the middle,
 * where density becomes colour, actually differ — and a raymarcher is expensive
 * enough to compile that eight copies of the identical 400 lines would be a
 * visible hitch the first time a school is opened.
 *
 *   FLAME     emissive gas. Colour from the four-stop ramp weighted by a heat
 *             term, radiated as pow(d, curve). The cheap cousin of
 *             `materials/VolumetricFireMaterial.js` — no black-body fit, no
 *             vortex roll-up. Use that one when the flame *is* the ability.
 *   SMOKE     absorbing, non-emissive, lit only by the key direction through the
 *             self-shadow tap. Without the tap smoke is a flat grey blob.
 *   ASH       smoke plus sparse embers on a hashed lattice, and a downward
 *             advection default because ash falls.
 *   SPORE     thin, non-absorbing, bioluminescent in *glints* rather than as a
 *             glow — the emission is a sparse point field drifting inside a dim
 *             cloud, not the cloud itself lit up.
 *   SAND      grain. The fbm is hard-thresholded so the medium reads as a
 *             curtain of particles rather than as a cloud tinted brown.
 *   MIST      near-uniform, barely absorbing, strongly forward-scattering. It is
 *             the anisotropy term that makes it read as mist and not as fog.
 *   GAS_BOIL  the interesting one — see `boilField()`.
 *   VOID      subtractive. See the note on blending below.
 */
export const Medium = Object.freeze({
  FLAME: 0,
  SMOKE: 1,
  ASH: 2,
  SPORE: 3,
  SAND: 4,
  MIST: 5,
  GAS_BOIL: 6,
  VOID: 7
});

/** Debug/editor labels, index-aligned with the enums above. */
export const HULL_NAMES = ['BOX', 'CYLINDER', 'CONE', 'DOME', 'SPHERE'];
export const MEDIUM_NAMES = ['FLAME', 'SMOKE', 'ASH', 'SPORE', 'SAND', 'MIST', 'GAS_BOIL', 'VOID'];

/**
 * Field samples per frame the whole scene may spend on raymarched volumes.
 *
 *   samples = coveredPixels × steps × (1 + shadowTaps)
 *
 * A "sample" is one call to `mediumDensity()`: an fbm at `uOctaves` octaves,
 * each octave eight `hash13`s, so four octaves is around three hundred ALU ops.
 * Twenty million of them is roughly four milliseconds on a mid-range discrete
 * GPU at 1080p, which is the whole of what this sandbox has spare once the
 * bloom chain has been paid for.
 *
 * This is a budget, not a measurement. `VolumeHull#cost()` does the arithmetic;
 * check it against this number before shipping an ability.
 */
export const VOLUME_SAMPLE_BUDGET = 20e6;

/* ---------------------------------------------------------------- */
/* Proxy geometry                                                    */
/* ---------------------------------------------------------------- */

/**
 * Unit hulls, built once and shared by every instance.
 *
 * Two things are non-obvious.
 *
 * **The tessellated hulls are circumscribed, not inscribed.** A twenty-sided
 * prism drawn at radius 1 has its flats at radius cos(π/20) ≈ 0.988, so a
 * volume that fills its nominal radius pokes out through twenty flat facets and
 * is sliced off along them. Scaling the ring radius by 1/cos(π/n) puts the
 * *flats* on the nominal radius and the corners outside it, which costs a
 * sliver of overdraw and removes the failure mode entirely. This is the same
 * lesson as `fireHullReach()`: a volume that ends one pixel outside its proxy
 * is sliced along a dead straight line, and that reads as a bug immediately.
 *
 * **DOME uses the full sphere.** The obvious build is an open hemisphere, and
 * it fails when the camera is inside the dome and looking down: back faces only
 * exist above the horizon, so the lower half of the volume has no fragment to
 * march it. Using a whole sphere and clipping the *field* to y ≥ 0 costs a few
 * hundred vertices and nothing at all in fill rate — the sub-floor fragments
 * discard on the first depth test, because their entire span is behind the
 * opaque floor.
 */
const _geometryCache = new Map();

function unitHull(shape) {
  // DOME and SPHERE share one geometry, so they share one cache slot too.
  const slot = shape === HullShape.DOME ? HullShape.SPHERE : shape;
  let geometry = _geometryCache.get(slot);
  if (geometry) return geometry;

  const RADIAL = 20;
  const circumscribe = 1 / Math.cos(Math.PI / RADIAL);

  switch (shape) {
    case HullShape.BOX:
      geometry = new BoxGeometry(2, 1, 2).translate(0, 0.5, 0);
      break;
    case HullShape.CYLINDER:
      geometry = new CylinderGeometry(circumscribe, circumscribe, 1, RADIAL, 1).translate(
        0,
        0.5,
        0
      );
      break;
    case HullShape.CONE:
      // three's cone has its apex at +h/2 and its base at -h/2. Drop it by half
      // a unit to put the apex on the origin, then rotate -90° about X, which
      // sends -Y to +Z: apex at the origin, base circle at z = 1, exactly the
      // frame hullSpan() and hullShape() assume. Get the sign of either
      // transform wrong and the hull ends up behind its own z-clip, which
      // renders as a two-pixel sliver rather than as an error.
      geometry = new ConeGeometry(circumscribe, 1, RADIAL, 1)
        .translate(0, -0.5, 0)
        .rotateX(-Math.PI / 2);
      break;
    default:
      // DOME and SPHERE share it — see the note above.
      geometry = new SphereGeometry(1 / Math.cos(Math.PI / 12), 24, 12);
      break;
  }

  geometry.name = `VolumeHull:${HULL_NAMES[slot] ?? slot}`;
  _geometryCache.set(slot, geometry);
  return geometry;
}

/** App teardown only. The hulls are shared, so no instance may dispose them. */
export function disposeVolumeHullGeometry() {
  for (const geometry of _geometryCache.values()) geometry.dispose();
  _geometryCache.clear();
}

/* ---------------------------------------------------------------- */
/* Shaders                                                           */
/* ---------------------------------------------------------------- */

const VERTEX = /* glsl */ `
  uniform vec3 uSize;

  varying vec3 vLocal;
  varying vec3 vWorld;

  void main() {
    // The hull is resized *here*, from a uniform, so a paused sim still
    // re-sizes when a slider moves. Object space is therefore metres and the
    // hull's half-extents are exactly uSize — which is what lets the fragment
    // stage intersect it analytically without a single trig call.
    vLocal = position * uSize;
    vec4 world = modelMatrix * vec4(vLocal, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform mat4  uInvModel;
  uniform vec3  uSize;

  /* march */
  uniform float uSteps;
  uniform float uJitter;
  uniform float uContact;
  uniform float uSeed;

  /* silhouette */
  uniform float uRound;
  uniform float uMargin;
  uniform float uHeightBias;
  uniform float uFeather;
  uniform float uHollow;
  uniform float uThroat;

  /* field */
  uniform float uDensity;
  uniform float uDensityCurve;
  uniform float uSoftness;
  uniform float uNoiseFrequency;
  uniform float uNoiseStrength;
  uniform float uNoiseWarp;
  uniform float uOctaves;
  uniform float uDetail;

  /* advection */
  uniform vec3  uFlow;
  uniform float uJet;
  uniform float uRise;
  uniform float uSwirl;
  uniform float uFlatten;

  /* optics */
  uniform float uAbsorption;
  uniform float uScatter;
  uniform float uAmbient;
  uniform float uAnisotropy;
  uniform float uEmission;
  uniform float uEmissionCurve;
  uniform float uShadowTaps;
  uniform float uShadowStrength;
  uniform float uShadowLength;
  uniform float uOpacity;

  /* GAS_BOIL */
  uniform float uBoilRate;
  uniform float uBoilScale;
  uniform float uBoilSize;
  uniform float uBoilPop;
  uniform float uBoilWarp;
  uniform float uBoilDepth;
  uniform float uBoilFlash;

  /* sparse points — ASH embers, SPORE glints, VOID stars */
  uniform float uSpeckDensity;
  uniform float uSpeckScale;
  uniform float uSpeckSize;
  uniform float uSpeckGlow;

  /* VOID */
  uniform float uVoidBite;

  /* colour — five independent pickers, nothing derived (I5) */
  uniform vec3  uColorCore;
  uniform vec3  uColorMid;
  uniform vec3  uColorEdge;
  uniform vec3  uColorDeep;
  uniform vec3  uColorLight;
  uniform vec3  uColorEvent;
  uniform vec3  uColorSpeck;

  /* shared */
  uniform float uTime;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform vec3  uLightDir;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying vec3 vLocal;
  varying vec3 vWorld;

  ${noiseGLSL}
  ${commonGLSL}

  /* ---------------------------------------------------------------- */
  /* Noise                                                             */
  /* ---------------------------------------------------------------- */

  /* Trilinear value noise on a hashed lattice — about a third of the cost of
     the simplex noise the surface shaders use, and indistinguishable once four
     octaves of it are being advected and warped. Inside a march the difference
     is not academic: this function is called up to MAX_STEPS × (1 + taps) times
     per pixel. */
  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float a = hash13(i);
    float b = hash13(i + vec3(1.0, 0.0, 0.0));
    float c = hash13(i + vec3(0.0, 1.0, 0.0));
    float d = hash13(i + vec3(1.0, 1.0, 0.0));
    float e = hash13(i + vec3(0.0, 0.0, 1.0));
    float g = hash13(i + vec3(1.0, 0.0, 1.0));
    float h = hash13(i + vec3(0.0, 1.0, 1.0));
    float k = hash13(i + vec3(1.0, 1.0, 1.0));

    return mix(
      mix(mix(a, b, f.x), mix(c, d, f.x), f.y),
      mix(mix(e, g, f.x), mix(h, k, f.x), f.y),
      f.z
    );
  }

  /* Unit-determinant rotation between octaves. Value noise sits on an
     axis-aligned lattice; stacking octaves on the same axes lines their
     features up into a grid you cannot unsee once you have seen it. */
  const mat3 OCTAVE_ROT = mat3(
     0.00,  0.80,  0.60,
    -0.80,  0.36, -0.48,
    -0.60, -0.48,  0.64
  );

  /** Progressively domain-warped fbm, 0..1. */
  float volFbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    float norm = 0.0;

    for (int i = 0; i < 5; i++) {
      if (float(i) >= uOctaves) break;
      float n = vnoise(p);
      v += a * n;
      norm += a;
      p = OCTAVE_ROT * p * 2.13 + (n - 0.5) * uNoiseWarp * vec3(1.7, 0.9, 1.3);
      a *= 0.55;
    }

    return v / max(norm, 1e-4);
  }

  /**
   * A sparse field of points on a world lattice — embers, spore glints, stars.
   *
   * The first version took these off a ridged octave of the fbm, which is the
   * cheap-looking answer and is wrong for a reason worth writing down: value
   * noise is a *smoothed* hash, so its values pile up around 0.5, and
   * 1 - |2n - 1| therefore piles up around **one**. A ridged term built on it
   * is bright nearly everywhere, so "sparse embers" came out as red television
   * static covering the whole cloud. Nothing you can do to the threshold fixes
   * a distribution that is wrong at the shape level.
   *
   * A hashed lattice is uniform by construction, so 'density' means exactly
   * what it says: the fraction of cells that hold a point. One point per cell,
   * radius capped below half a cell, so the containing cell is the only cell
   * that can contribute — the same containment argument as 'boilField()', and
   * the same one hash.
   *
   * @param id out — the point's hash, for per-point flicker
   */
  float speck(vec3 p, float density, float size, out float id) {
    vec3 cell = floor(p);
    id = hash13(cell + 5.1);
    if (id > clamp(density, 0.0, 1.0)) return 0.0;
    vec3 centre = vec3(0.5) + (hash31(id * 77.0) - 0.5) * (1.0 - size);
    return 1.0 - smoothstep(size * 0.3, size * 0.5, length(fract(p) - centre));
  }

  /** Henyey-Greenstein phase function. g > 0 forward-scatters. */
  float phaseHG(float cosTheta, float g) {
    g = clamp(g, -0.92, 0.92);
    float gg = g * g;
    float d = 1.0 + gg - 2.0 * g * cosTheta;
    return (1.0 - gg) / (12.566370614 * max(d * sqrt(max(d, 1e-4)), 1e-4));
  }

  /* ---------------------------------------------------------------- */
  /* Hull intersection — analytic, in the hull's own frame              */
  /* ---------------------------------------------------------------- */

  /* Clip an interval against the slab a ≤ o + d·t ≤ b. Returns false when the
     interval has collapsed. */
  bool clipSlab(float o, float d, float a, float b, inout float lo, inout float hi) {
    if (abs(d) < 1e-6) return o >= a && o <= b;
    float ta = (a - o) / d;
    float tb = (b - o) / d;
    if (ta > tb) { float s = ta; ta = tb; tb = s; }
    lo = max(lo, ta);
    hi = min(hi, tb);
    return hi > lo;
  }

  /**
   * Clip an interval against the solid { A·t² + 2B·t + C ≤ 0 }.
   *
   * The A < 0 branch is the cone's, and it is the one worth reading: a double
   * cone's interior is the *outside* of the root pair, i.e. two rays heading
   * off in opposite directions. Clipped to the +Z nappe by the z-slab the solid
   * is convex, so a line can only meet it in one interval and at most one of
   * those two ends can survive — which is why keeping the longer overlap is
   * exact here and would not be for a general quadric.
   */
  bool clipQuadric(float A, float B, float C, inout float lo, inout float hi) {
    if (abs(A) < 1e-7) {
      // The ray runs parallel to the surface: the inequality is linear in t.
      if (abs(B) < 1e-9) return C <= 0.0;
      float r = -C / (2.0 * B);
      if (B > 0.0) hi = min(hi, r); else lo = max(lo, r);
      return hi > lo;
    }

    float disc = B * B - A * C;
    // No roots with A < 0 means the quadratic never climbs to zero: the whole
    // line is inside. With A > 0 it means the whole line is outside.
    if (disc < 0.0) return A < 0.0;

    float s = sqrt(disc);
    float r0 = (-B - s) / A;
    float r1 = (-B + s) / A;
    if (r0 > r1) { float t = r0; r0 = r1; r1 = t; }

    if (A > 0.0) {
      lo = max(lo, r0);
      hi = min(hi, r1);
    } else {
      float loA = max(lo, r1), hiA = hi;
      float loB = lo,          hiB = min(hi, r0);
      if (hiA - loA >= hiB - loB) { lo = loA; hi = hiA; }
      else                        { lo = loB; hi = hiB; }
    }
    return hi > lo;
  }

  /**
   * The ray's span inside the hull, in **world metres**.
   *
   * Bounding the volume with a sphere is what the obvious implementation does
   * and it is ruinous for anything that is not round: a floor slab five metres
   * across and half a metre tall inside its bounding sphere is ninety-odd per
   * cent empty, and the fixed step budget gets spread over all of it. The hull
   * is already exactly the shape the field lives in — intersecting *that*
   * costs a handful of ALU and buys the whole factor back as step density.
   */
  bool hullSpan(vec3 ro, vec3 rd, out float t0, out float t1) {
    t0 = 0.0;
    t1 = 1e6;

    #if HULL_SHAPE == 0                       /* BOX */
      if (!clipSlab(ro.x, rd.x, -uSize.x, uSize.x, t0, t1)) return false;
      if (!clipSlab(ro.y, rd.y, 0.0, uSize.y, t0, t1)) return false;
      if (!clipSlab(ro.z, rd.z, -uSize.z, uSize.z, t0, t1)) return false;

    #elif HULL_SHAPE == 1                     /* CYLINDER */
      if (!clipSlab(ro.y, rd.y, 0.0, uSize.y, t0, t1)) return false;
      vec2 o = ro.xz / uSize.xz;
      vec2 d = rd.xz / uSize.xz;
      if (!clipQuadric(dot(d, d), dot(o, d), dot(o, o) - 1.0, t0, t1)) return false;

    #elif HULL_SHAPE == 2                     /* CONE, apex at the origin, +Z */
      if (!clipSlab(ro.z, rd.z, 0.0, uSize.z, t0, t1)) return false;
      vec3 o = ro / uSize;
      vec3 d = rd / uSize;
      if (!clipQuadric(d.x * d.x + d.y * d.y - d.z * d.z,
                       o.x * d.x + o.y * d.y - o.z * d.z,
                       o.x * o.x + o.y * o.y - o.z * o.z, t0, t1)) return false;

    #elif HULL_SHAPE == 3                     /* DOME */
      if (!clipSlab(ro.y, rd.y, 0.0, uSize.y, t0, t1)) return false;
      vec3 o = ro / uSize;
      vec3 d = rd / uSize;
      if (!clipQuadric(dot(d, d), dot(o, d), dot(o, o) - 1.0, t0, t1)) return false;

    #else                                     /* SPHERE (ellipsoid) */
      vec3 o = ro / uSize;
      vec3 d = rd / uSize;
      if (!clipQuadric(dot(d, d), dot(o, d), dot(o, o) - 1.0, t0, t1)) return false;
    #endif

    t0 = max(t0, 0.0);
    return t1 > t0;
  }

  /**
   * Hull-relative silhouette: 1 in the core, 0 at the nominal surface of the
   * medium, negative beyond it.
   *
   * This is **local** on purpose, and it is the one term that must be. The
   * silhouette *is* the hull — sampled in world space it would slide out of its
   * own proxy the moment the ability moved the anchor and get sliced along the
   * hull's wall. Everything grainy is sampled in world space instead; see
   * 'mediumDensity()'.
   *
   * 'uMargin' is the whole reason the volume does not end on a straight line.
   * The nominal surface is placed a fraction of the hull *inside* the hull, so
   * the erosion has somewhere to push density into before it runs out of proxy.
   * Every normalised coordinate below is scaled by 'inv' and nothing else in
   * the function knows about it — which is the point: the margin is a property
   * of the hull, not of any one shape's algebra.
   *
   * Note the floor is not given margin on hulls that sit on it (y = 0 stays
   * y = 0). It does not need any: the ground is opaque, so a volume that
   * reaches through it is clipped by the depth prepass, not by the proxy.
   */
  float hullShape(vec3 p) {
    float inv = 1.0 / max(1.0 - uMargin, 0.05);

    #if HULL_SHAPE == 0                       /* BOX */
      vec2 lat = abs(p.xz) / uSize.xz * inv;
      // Chebyshev gives a genuinely rectangular footprint; Euclidean gives an
      // ellipse inside it. uRound blends between them, because "rounded
      // rectangle" is what almost every ground slab actually wants and a real
      // rounded-box SDF costs more than this is worth inside a march.
      float side = 1.0 - mix(max(lat.x, lat.y), length(lat), clamp(uRound, 0.0, 1.0));
      float yn = clamp(p.y / max(uSize.y, 1e-4) * inv, 0.0, 1.0);
      return side * mix(1.0, 1.0 - yn, uHeightBias)
                  * (1.0 - smoothstep(1.0 - uFeather, 1.0, yn));

    #elif HULL_SHAPE == 1                     /* CYLINDER */
      float r = length(p.xz / uSize.xz) * inv;
      float yn = clamp(p.y / max(uSize.y, 1e-4) * inv, 0.0, 1.0);
      return (1.0 - r) * mix(1.0, 1.0 - yn, uHeightBias)
                       * (1.0 - smoothstep(1.0 - uFeather, 1.0, yn));

    #elif HULL_SHAPE == 2                     /* CONE */
      float zn = clamp(p.z / max(uSize.z, 1e-4) * inv, 0.0, 1.0);
      // Normalise by the *local* radius so r is 0 on the axis and 1 on the
      // lateral surface at every station along the cone: the field then
      // describes the cross-section once instead of once per distance.
      float w = max(zn, 0.02);
      float r = length(vec2(p.x / (uSize.x * w), p.y / (uSize.y * w))) * inv;
      // Hollow: move the density peak off the axis. A gout of flame from a
      // nozzle is a sheath — unburnt fuel down the middle — and that is what
      // lets you orbit it and see the far wall of the cone through the near
      // one. A solid cone reads as a cardboard megaphone from every angle.
      float core = 1.0 - abs(r - uHollow) / max(1.0 - uHollow, 1e-3);
      return core * smoothstep(0.0, max(uThroat, 1e-3), zn)
                  * (1.0 - smoothstep(1.0 - uFeather, 1.0, zn));

    #elif HULL_SHAPE == 3                     /* DOME */
      float r = length(p / uSize) * inv;
      float yn = clamp(p.y / max(uSize.y, 1e-4) * inv, 0.0, 1.0);
      return (1.0 - r) * mix(1.0, 1.0 - yn, uHeightBias);

    #else                                     /* SPHERE */
      float r = length(p / uSize) * inv;
      float yn = clamp(p.y / max(uSize.y, 1e-4) * 0.5 + 0.5, 0.0, 1.0);
      return (1.0 - r) * mix(1.0, 1.0 - yn, uHeightBias);
    #endif
  }

  /* ---------------------------------------------------------------- */
  /* Advection                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * The **world**-space noise domain.
   *
   * World, so the medium keeps a fixed physical grain: a dome that contracts
   * reveals more grain rather than magnifying the same grain, which is the
   * entire reason Pyroclasm's implosion reads as an implosion and not as a
   * zoom. It is also why two casts landing beside each other do not look like
   * the same cloud printed twice.
   *
   * 'uFlatten' compresses nothing — it *stretches* the domain's Y, which makes
   * every feature short and wide. A cloud that pours across the floor instead
   * of billowing is a cloud whose eddies are pancakes, and no amount of
   * squashing the hull will produce that on its own.
   */
  vec3 worldDomain(vec3 wp) {
    vec3 p = wp - uFlow * uTime;
    p.y -= uRise * uTime;
    p.y *= mix(1.0, 5.0, clamp(uFlatten, 0.0, 1.0));
    return p * uNoiseFrequency + uSeed;
  }

  /**
   * The **local** noise domain.
   *
   * Local, so the structure is carried by the hull rather than swum through: a
   * jet's turbulence belongs to the jet, and a cone that yaws with the caster
   * must take its tongues of flame with it. 'uJet' pushes the domain along the
   * hull's own axis — +Z for a cone, +Y for anything standing on the floor —
   * and 'uSwirl' rotates it about that same axis.
   */
  vec3 localDomain(vec3 lp) {
    vec3 p = lp;
    #if HULL_SHAPE == 2
      p.z -= uJet * uTime;
      p.xy = rot2(uSwirl * uTime) * p.xy;
    #else
      p.y -= uJet * uTime;
      p.xz = rot2(uSwirl * uTime) * p.xz;
      p.y *= mix(1.0, 5.0, clamp(uFlatten, 0.0, 1.0));
    #endif
    return p * uNoiseFrequency + uSeed;
  }

  /* ---------------------------------------------------------------- */
  /* GAS_BOIL                                                          */
  /* ---------------------------------------------------------------- */

  #if MEDIUM == 6
  /**
   * A cellular field whose cells inflate and pop on their own timers.
   *
   * The first version was a 3×3×3 Worley field, which is the textbook answer
   * and is unaffordable here: twenty-seven hashed cells inside a forty-step
   * march is eleven hundred hashes a pixel before the fbm has been touched.
   *
   * So each bubble is confined to its own lattice cell. Jitter the centre by at
   * most (1 - size)/2 and cap the radius at size/2 and a bubble provably cannot
   * leave its cell, which makes the containing cell the *only* cell that can
   * contribute — one hash, no neighbourhood loop, exact. The price is that
   * bubbles never overlap and the lattice would be plainly visible; one octave
   * of value noise bending the domain first ('uBoilWarp') buys that back for a
   * single extra tap. Two taps total, against twenty-seven.
   *
   * Each cell's clock is 'fract(t · rate · jitter + offset)', so the cloud is
   * full of independent events rather than one global pulse:
   *
   *   0.00 → 0.55  inflate
   *   0.55 → 0.80  hold
   *   0.80 → 1.00  swell and thin — the pop
   *
   * @param event out — the pop flash, 0..1, spent on 'uColorEvent'.
   */
  float boilField(vec3 p, out float event) {
    event = 0.0;

    // One tap, reused on three axes with different weights. Properly it wants
    // three independent noises; at three times the cost, for a warp whose only
    // job is to stop a lattice reading as a lattice, it does not.
    float w = vnoise(p * 0.4) - 0.5;
    vec3 warped = p + w * uBoilWarp * vec3(1.7, 0.9, 1.3);

    vec3 cell = floor(warped);
    vec3 f = warped - cell;

    float seed = hash13(cell + uSeed);
    float phase = fract(uTime * uBoilRate * (0.55 + 0.9 * seed) + seed * 7.31);

    float grow = smoothstep(0.0, 0.55, phase);
    float pop = smoothstep(0.80, 1.0, phase);
    event = pop * (1.0 - smoothstep(0.96, 1.0, phase));

    float size = clamp(uBoilSize, 0.05, 1.0);
    // Clamped, not merely scaled: the containment proof above depends on the
    // radius never exceeding size/2, and uBoilPop would otherwise push it past.
    float radius = size * 0.5 * min(grow * (1.0 + uBoilPop * pop), 1.0);
    vec3 centre = vec3(0.5) + (hash31(seed * 91.7) - 0.5) * (1.0 - size);

    float shell = 1.0 - smoothstep(radius * 0.45, radius, length(f - centre));
    // The bubble thins as it bursts rather than vanishing on a frame boundary.
    return shell * (1.0 - pop * 0.85);
  }
  #endif

  /* ---------------------------------------------------------------- */
  /* The medium                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Density at a point, plus everything the shading needs.
   *
   * @param lp    hull-local metres
   * @param wp    world metres
   * @param shape  out — the hull silhouette, for the colour ramp
   * @param detail out — the raw fbm, 0..1, which SAND and SPORE cut into grain
   * @param event  out — a per-medium one-shot (GAS_BOIL's pop; 0 elsewhere)
   */
  float mediumDensity(vec3 lp, vec3 wp, out float shape, out float detail, out float event) {
    detail = 0.5;
    event = 0.0;

    shape = hullShape(lp);

    // Conservative reject before paying for the fbm. 'fringe' is clamped at 2
    // below, so the erosion can lift the field by at most
    // uNoiseStrength · (0.22 + 0.78 · 2²) = 3.34 · uNoiseStrength — anything
    // further out than that provably cannot become density, whatever the noise
    // does. It fires on the corners of a box hull and around the apex of a
    // cone; it is a guard, not the main saving. The main saving is the empty-
    // space stride in the march.
    float reachable = -3.34 * uNoiseStrength;
    #if MEDIUM == 6
      reachable -= 0.75 * uBoilDepth;
    #endif
    if (shape < reachable) return 0.0;

    #if MEDIUM == 0                           /* FLAME — follows the hull */
      vec3 domain = localDomain(lp);
      domain.y -= uRise * uTime * uNoiseFrequency;
    #else                                     /* everything else keeps world grain */
      vec3 domain = worldDomain(wp);
    #endif

    detail = volFbm(domain);
    float n = detail * 2.0 - 1.0;

    // Erosion is weak on the axis and violent at the fringe. That contrast —
    // a solid heart with an edge dissolving into wisps — is most of what reads
    // as a *volume* rather than as a shaded proxy mesh. A uniform erosion just
    // makes the whole thing noisy, which looks like television static.
    float fringe = clamp(1.0 - shape, 0.0, 2.0);
    float erosion = uNoiseStrength * (0.22 + 0.78 * fringe * fringe);

    float field = shape + n * erosion;

    #if MEDIUM == 6
      float boil = boilField(wp * uBoilScale, event);
      // Pockets swell out of the cloud and the gaps between them thin it, so
      // the silhouette is genuinely eaten by the boil rather than decorated.
      field += (boil - 0.25) * uBoilDepth;
      event *= boil;
    #endif

    float d = smoothstep(0.0, max(uSoftness, 0.02), field);
    if (d <= 0.0) return 0.0;
    d = pow(d, max(uDensityCurve, 0.05));

    #if MEDIUM == 4                           /* SAND */
      // Cut the fbm somewhere steep. Sand is not a brown cloud, it is a curtain
      // of separate grains, and the only way to get separate grains out of a
      // continuous field is to threshold it hard enough to break it up.
      d *= mix(1.0, smoothstep(0.42, 0.72, detail), clamp(uDetail, 0.0, 1.0));
    #elif MEDIUM == 3                         /* SPORE */
      d *= mix(1.0, 0.3 + 0.7 * detail, clamp(uDetail, 0.0, 1.0));
    #endif

    return d * uDensity;
  }

  /** Density only — the self-shadow tap does not need the rest. */
  float shadowDensity(vec3 lp, vec3 wp) {
    float shape, detail, event;
    return mediumDensity(lp, wp, shape, detail, event);
  }

  /**
   * Emission and albedo for a sample.
   *
   * 'emit' radiates on its own; 'albedo' is what the medium *reflects* out of
   * the key light. Splitting them is what separates a flame from smoke without
   * two shaders: FLAME leaves albedo near zero and lives on emit, SMOKE leaves
   * emit at zero and lives on albedo, ASH does both.
   */
  void mediumShade(float shape, float detail, float event, vec3 wp,
                   out vec3 emit, out vec3 albedo) {
    float s = clamp(shape, 0.0, 1.0);
    albedo = gradient4(uColorCore, uColorMid, uColorEdge, uColorDeep, 1.0 - s);
    emit = vec3(0.0);

    #if MEDIUM == 0                           /* FLAME */
      // Temperature from the silhouette — geometry — rather than from the
      // density field. The density field's level sets are nested closed loops,
      // and a high emission exponent pointed at them renders the flame as
      // polished agate: contour lines wrapping every blob. Blunter is better.
      // The full treatment lives in materials/VolumetricFireMaterial.js.
      float heat = clamp(s * 1.35, 0.0, 1.0);
      emit = gradient4(uColorCore, uColorMid, uColorEdge, uColorDeep, pow(1.0 - heat, 0.85));
      albedo *= 0.15;

    #elif MEDIUM == 2                         /* ASH */
      // Embers on the sparse lattice, each blinking on its own hash so they
      // never pulse together. Deliberately gated on the silhouette too: an
      // ember floating in the thin fringe has nothing burning around it.
      float id;
      float ember = speck(wp * uSpeckScale, uSpeckDensity, uSpeckSize, id);
      ember *= 0.35 + 0.65 * sin(uTime * 9.0 + id * 61.0);
      emit = uColorSpeck * max(ember, 0.0) * uSpeckGlow * s;

    #elif MEDIUM == 3                         /* SPORE */
      // Glints, not a glow. Bioluminescence spread evenly through the medium
      // reads as a fog machine with a green gel in it; discrete points drifting
      // in a dim cloud read as something alive in there.
      float gid;
      float glint = speck(wp * uSpeckScale, uSpeckDensity, uSpeckSize, gid);
      glint *= 0.4 + 0.6 * sin(uTime * 2.2 + gid * 47.0);
      emit = uColorSpeck * max(glint, 0.0) * uSpeckGlow;

    #elif MEDIUM == 6                         /* GAS_BOIL */
      emit = uColorEvent * event * uBoilFlash;

    #elif MEDIUM == 7                         /* VOID */
      // Stars on the world lattice, so they belong to the sky and do not swim
      // when the dome moves.
      float sid;
      float star = speck(wp * uSpeckScale, uSpeckDensity, uSpeckSize, sid);
      star *= 0.55 + 0.45 * sin(uTime * 2.6 + sid * 51.0);
      emit = uColorSpeck * star * uSpeckGlow;
      // The residual interior colour, deliberately tiny: VOID's job is to take
      // light away, and anything it adds back fights that.
      albedo *= 0.06;
    #endif
  }

  /* ---------------------------------------------------------------- */
  /* March                                                             */
  /* ---------------------------------------------------------------- */

  void main() {
    vec3 roW = cameraPosition;
    vec3 rdW = normalize(vWorld - roW);

    // The direction is transformed *without* normalising, on purpose: an affine
    // map sends the world ray ro + rd·t to roL + rdL·t with the same t. That
    // single fact is what lets the march keep one parameter in world metres —
    // so 'uContact', 'uAbsorption' and the depth clip are all in real metres —
    // while the hull test, which only makes sense in the hull's own frame, runs
    // in local metres. It also means the hull's matrix must stay rigid: scale
    // it with setSize(), never with mesh.scale, or t stops meaning metres.
    vec3 roL = (uInvModel * vec4(roW, 1.0)).xyz;
    vec3 rdL = (uInvModel * vec4(rdW, 0.0)).xyz;

    float t0, t1;
    if (!hullSpan(roL, rdL, t0, t1)) discard;
    t0 = max(t0, 0.02);

    // Clip the march on the opaque scene rather than depth-testing the hull.
    // Testing the hull's own depth would slice the volume flat where it meets
    // the floor; clipping per sample lets it *fade* into the contact, which is
    // the difference between a volume and a decal of a volume. The depth buffer
    // is half resolution (see PostProcessing), so uContact has to be generous
    // enough to hide the stair-stepping — a metre is not too much.
    float dzdt = (viewMatrix * vec4(rdW, 0.0)).z;
    // Not called 'packed': that is a future-reserved word in GLSL ES, and while
    // every desktop driver we have met lets it through, SwiftShader does not.
    float depthBits = unpackRGBAToDepth(texture2D(uSceneDepth, gl_FragCoord.xy / uResolution));
    float sceneViewZ = perspectiveDepthToViewZ(depthBits, uCameraNear, uCameraFar);
    float tScene = dzdt < -1e-5 ? sceneViewZ / dzdt : 1e6;
    t1 = min(t1, tScene);
    if (t1 <= t0) discard;

    float steps = clamp(uSteps, 4.0, float(MAX_STEPS));
    float baseStep = (t1 - t0) / steps;

    // Dither the entry point. A fixed start turns the slices into onion rings
    // wrapped around the hull; a per-pixel offset turns the same error into
    // grain, which the bloom eats. uJitter of 0 is only ever useful for
    // screenshots of the banding you are trying to fix.
    float dither = hash13(vec3(gl_FragCoord.xy, fract(uTime) * 64.0));
    float t = t0 + baseStep * mix(0.5, dither, clamp(uJitter, 0.0, 1.0));

    vec3 lightL = (uInvModel * vec4(uLightDir, 0.0)).xyz;
    float phase = phaseHG(dot(rdW, uLightDir), uAnisotropy) * 12.566370614;

    vec3 acc = vec3(0.0);
    float transmittance = 1.0;
    // A hull tight enough to be affordable is still mostly empty along any one
    // ray. Coasting through the empty part at a coarser stride — and dropping
    // back to the fine one the instant anything is hit — buys back most of the
    // cost of the headroom the silhouette needs.
    float stride = 1.0;

    for (int i = 0; i < MAX_STEPS; i++) {
      if (t >= t1 || transmittance < 0.012) break;

      vec3 wp = roW + rdW * t;
      vec3 lp = roL + rdL * t;

      float shape, detail, event;
      float d = mediumDensity(lp, wp, shape, detail, event);
      float stepSize = baseStep * stride;

      if (d > 0.002) {
        stride = 1.0;
        stepSize = baseStep;

        // Soften the contact with whatever the march ran into.
        d *= clamp((tScene - t) / max(uContact, 1e-3), 0.0, 1.0);

        vec3 emit, albedo;
        mediumShade(shape, detail, event, wp, emit, albedo);

        float shadow = 1.0;
        #if VOLUME_SHADOW == 1
          // One or two taps up the key direction. This is the single most
          // expensive option in the module — each tap is a whole extra field
          // evaluation — and for absorbing media it is also the only thing that
          // gives them a lit side and a dark side. Emissive media do not need
          // it and should run at zero taps.
          if (uShadowTaps > 0.5) {
            float occ = 0.0;
            float taps = 0.0;
            for (int s = 0; s < 2; s++) {
              if (float(s) >= uShadowTaps) break;
              float h = uShadowLength * (0.45 + float(s) * 1.1);
              occ += shadowDensity(lp + lightL * h, wp + uLightDir * h);
              taps += 1.0;
            }
            // Averaged, then converted to an optical depth over *one*
            // shadowLength. Summing the raw taps instead makes the second tap
            // count for twice the first and turns any dense medium
            // black — which is exactly what it did the first time.
            shadow = exp(-occ / max(taps, 1.0) * uAbsorption * uShadowLength * uShadowStrength);
          }
        #endif

        // uAmbient stands in for multiple scattering. Real smoke is grey, not
        // black, because light that failed to arrive along the key direction
        // arrived after bouncing around inside the cloud; single scattering
        // alone gives an unlit side with no light in it at all, and no amount
        // of raising uScatter fixes that because it scales the lit side too.
        vec3 radiance = emit * uEmission * pow(clamp(d, 0.0, 1.0), max(uEmissionCurve, 0.05))
                      + albedo * uColorLight * uScatter * (phase * shadow + uAmbient);

        acc += radiance * d * transmittance * stepSize;
        transmittance *= exp(-d * uAbsorption * stepSize);
      } else {
        stride = min(stride * 1.6, 2.4);
      }

      t += stepSize;
    }

    float alpha = clamp((1.0 - transmittance) * uOpacity, 0.0, 1.0);
    #if MEDIUM == 7
      // VOID needs no special blend mode, and that surprises people. Premultiplied
      // "over" with a near-black premultiplied colour *is* subtraction: the
      // destination is multiplied by (1 - alpha) and almost nothing is added
      // back. uVoidBite lets the dome occlude harder than its own density would,
      // so it can go to genuine black without having to be made physically thick.
      alpha = clamp(alpha * (1.0 + uVoidBite), 0.0, 1.0);
    #endif

    vec3 color = acc * uOpacity * uGlobalGlow * mix(0.65, 1.0, uShaderIntensity);
    if (alpha < 0.002 && max(color.r, max(color.g, color.b)) < 0.002) discard;

    gl_FragColor = vec4(color, alpha);
  }
`;

/* ---------------------------------------------------------------- */
/* Settings schema                                                   */
/* ---------------------------------------------------------------- */

/**
 * The single table that drives everything on the settings side: the key list,
 * the defaults an ability spreads into its block, the editor schema, and the
 * suffix → full-key binding 'sync()' reads through.
 *
 * 'def' is the neutral default. Per-medium opinions live in MEDIUM_DEFAULTS
 * below and are layered on top, so a medium only states what it disagrees with.
 *
 * Columns: [suffix, default, min, max, step, label, folder]
 */
const FIELDS = [
  /* --- march --- */
  ['Steps', 36, 4, 96, 1, 'steps', 'march'],
  ['Jitter', 1.0, 0, 1, 0.01, 'step dither', 'march'],
  ['Contact', 0.9, 0.05, 4, 0.01, 'contact fade (m)', 'march'],

  /* --- silhouette --- */
  ['Margin', 0.18, 0.02, 0.6, 0.01, 'headroom inside the hull', 'shape'],
  ['Round', 0.35, 0, 1, 0.01, 'footprint rounding', 'shape'],
  ['HeightBias', 0.35, 0, 1, 0.01, 'density falls with height', 'shape'],
  ['Feather', 0.25, 0.01, 0.9, 0.01, 'far-edge feather', 'shape'],
  ['Hollow', 0.0, 0, 0.9, 0.01, 'cone: peak off-axis', 'shape'],
  ['Throat', 0.12, 0.01, 0.6, 0.01, 'cone: opening length', 'shape'],

  /* --- field --- */
  ['Density', 1.6, 0, 8, 0.01, 'density', 'field'],
  ['DensityCurve', 1.0, 0.1, 4, 0.01, 'density curve', 'field'],
  ['Softness', 0.45, 0.02, 1, 0.01, 'edge softness', 'field'],
  ['NoiseFrequency', 1.4, 0.05, 8, 0.01, 'features per metre', 'field'],
  ['NoiseStrength', 0.85, 0, 3, 0.01, 'erosion', 'field'],
  ['NoiseWarp', 0.25, 0, 1.5, 0.01, 'domain warp', 'field'],
  ['Octaves', 4, 1, 5, 1, 'octaves', 'field'],
  ['Detail', 0.5, 0, 1, 0.01, 'fine-octave gain', 'field'],

  /* --- advection --- */
  ['FlowX', 0.0, -6, 6, 0.01, 'world flow X (m/s)', 'flow'],
  ['FlowY', 0.0, -6, 6, 0.01, 'world flow Y (m/s)', 'flow'],
  ['FlowZ', 0.0, -6, 6, 0.01, 'world flow Z (m/s)', 'flow'],
  ['Jet', 0.0, -12, 12, 0.01, 'along hull axis (m/s)', 'flow'],
  ['Rise', 0.6, -4, 6, 0.01, 'buoyant rise (m/s)', 'flow'],
  ['Swirl', 0.0, -4, 4, 0.01, 'swirl about axis (rad/s)', 'flow'],
  ['Flatten', 0.0, 0, 1, 0.01, 'pancake the eddies', 'flow'],

  /* --- optics --- */
  ['Absorption', 1.4, 0, 8, 0.01, 'absorption (1/m)', 'optics'],
  ['Scatter', 1.0, 0, 4, 0.01, 'scattering', 'optics'],
  ['Ambient', 0.25, 0, 2, 0.01, 'multi-scatter floor', 'optics'],
  ['Anisotropy', 0.25, -0.9, 0.9, 0.01, 'forward scatter', 'optics'],
  ['Emission', 0.0, 0, 12, 0.01, 'emission', 'optics'],
  ['EmissionCurve', 1.0, 0.1, 4, 0.01, 'emission by density', 'optics'],
  ['ShadowTaps', 1, 0, 2, 1, 'self-shadow taps', 'optics'],
  ['ShadowStrength', 1.0, 0, 4, 0.01, 'self-shadow strength', 'optics'],
  ['ShadowLength', 0.6, 0.05, 4, 0.01, 'self-shadow reach (m)', 'optics'],
  ['Opacity', 1.0, 0, 1, 0.01, 'opacity', 'optics'],

  /* --- GAS_BOIL --- */
  ['BoilRate', 0.5, 0, 4, 0.01, 'pops per second', 'boil'],
  ['BoilScale', 1.6, 0.1, 8, 0.01, 'cells per metre', 'boil'],
  ['BoilSize', 0.72, 0.05, 1, 0.01, 'bubble size in a cell', 'boil'],
  ['BoilPop', 0.55, 0, 1, 0.01, 'burst swell', 'boil'],
  ['BoilWarp', 1.1, 0, 3, 0.01, 'lattice warp', 'boil'],
  ['BoilDepth', 0.8, 0, 3, 0.01, 'how far bubbles eat the cloud', 'boil'],
  ['BoilFlash', 2.2, 0, 12, 0.01, 'pop flash', 'boil'],

  /* --- sparse points: ASH embers, SPORE glints, VOID stars --- */
  ['SpeckDensity', 0.12, 0, 1, 0.005, 'fraction of cells with a point', 'speck'],
  ['SpeckScale', 2.2, 0.1, 16, 0.01, 'point cells per metre', 'speck'],
  ['SpeckSize', 0.3, 0.02, 0.9, 0.01, 'point size in a cell', 'speck'],
  ['SpeckGlow', 3.0, 0, 24, 0.01, 'point brightness', 'speck'],

  /* --- VOID --- */
  ['VoidBite', 0.4, 0, 3, 0.01, 'extra occlusion', 'void'],

  /* --- colour (I5: five independent pickers, nothing derived) --- */
  ['ColorCore', '#ffffff', null, null, null, 'core', 'colour'],
  ['ColorMid', '#b0b0b0', null, null, null, 'mid', 'colour'],
  ['ColorEdge', '#606060', null, null, null, 'edge', 'colour'],
  ['ColorDeep', '#181818', null, null, null, 'deep', 'colour'],
  ['ColorLight', '#fff4e0', null, null, null, 'key light', 'colour'],
  ['ColorEvent', '#ffb060', null, null, null, 'event flash', 'colour'],
  ['ColorSpeck', '#c0d0ff', null, null, null, 'embers / glints / stars', 'colour']
];

/** Bare suffixes, in table order. Prefix them to build a settings block. */
export const VOLUME_HULL_KEYS = FIELDS.map((f) => f[0]);

/**
 * What each medium disagrees with in the neutral defaults.
 *
 * Palettes are the ROSTER's, so an ability that wants Pyroclasm's ash or
 * Nightfall's void starts from the colours its entry already specifies and
 * tunes from there rather than from grey.
 */
const MEDIUM_DEFAULTS = [
  /* FLAME */ {
    Steps: 40,
    Density: 2.4,
    DensityCurve: 1.2,
    Softness: 0.35,
    NoiseFrequency: 2.4,
    NoiseStrength: 1.0,
    NoiseWarp: 0.35,
    // Erosion at 1.0 throws density a long way past the silhouette; it needs
    // the room. See "the one rule" on VolumeHull.
    Margin: 0.3,
    Rise: 2.6,
    Absorption: 0.9,
    Scatter: 0.35,
    Anisotropy: 0.4,
    Emission: 7.0,
    EmissionCurve: 1.5,
    ShadowTaps: 0,
    Ambient: 0.1,
    Feather: 0.3,
    ColorCore: '#fff2c0',
    ColorMid: '#ffb03a',
    ColorEdge: '#e0400f',
    ColorDeep: '#2a0a04',
    ColorLight: '#ffd9a0',
    ColorEvent: '#ffe0a0'
  },
  /* SMOKE */ {
    Steps: 32,
    Density: 1.7,
    // Scatter is deliberately close to absorption. The integral gathers
    // albedo · scatter and loses transmittance at absorption, so a medium whose
    // scatter is a third of its absorption comes out a third as bright as its
    // own palette — which is how the first pass rendered slate-grey smoke as a
    // black hole. If a medium looks too dark, this ratio is the first place to
    // look, not the colour pickers.
    Absorption: 2.6,
    Scatter: 2.4,
    Anisotropy: 0.2,
    Emission: 0.0,
    NoiseFrequency: 1.1,
    Rise: 0.9,
    ShadowTaps: 1,
    Ambient: 0.42,
    ColorCore: '#d2d2d2',
    ColorMid: '#8e8e8e',
    ColorEdge: '#4a4a4a',
    ColorDeep: '#1a1a1a',
    ColorLight: '#fff4e0'
  },
  /* ASH */ {
    Steps: 36,
    Density: 2.0,
    Absorption: 3.0,
    Scatter: 1.9,
    Anisotropy: 0.1,
    Emission: 1.6,
    EmissionCurve: 0.7,
    NoiseFrequency: 1.6,
    Detail: 0.8,
    Rise: 0.2,
    FlowY: -0.4,
    ShadowTaps: 1,
    Ambient: 0.34,
    SpeckDensity: 0.1,
    SpeckScale: 3.4,
    SpeckSize: 0.16,
    SpeckGlow: 9.0,
    ColorCore: '#8a7a6a',
    ColorMid: '#5c2a10',
    ColorEdge: '#2a1a12',
    ColorDeep: '#1a1210',
    ColorLight: '#ffcf9a',
    ColorEvent: '#ff7a2a'
  },
  /* SPORE */ {
    Steps: 28,
    Density: 0.9,
    Absorption: 0.5,
    Scatter: 1.4,
    Anisotropy: 0.5,
    Emission: 2.2,
    EmissionCurve: 0.6,
    NoiseFrequency: 1.8,
    Detail: 0.9,
    Rise: 0.35,
    Flatten: 0.4,
    ShadowTaps: 0,
    Ambient: 0.5,
    SpeckDensity: 0.16,
    SpeckScale: 2.8,
    SpeckSize: 0.2,
    SpeckGlow: 7.0,
    ColorCore: '#c8ff9a',
    ColorMid: '#7ad0a0',
    ColorEdge: '#2a6b4a',
    ColorDeep: '#0e2018',
    ColorLight: '#d8ffe8'
  },
  /* SAND */ {
    Steps: 34,
    Density: 2.2,
    Absorption: 3.4,
    Scatter: 2.4,
    Anisotropy: 0.05,
    Emission: 0.0,
    NoiseFrequency: 2.2,
    Detail: 1.0,
    Rise: -0.3,
    ShadowTaps: 1,
    Ambient: 0.4,
    ColorCore: '#c8b48a',
    ColorMid: '#9a8460',
    ColorEdge: '#565049',
    ColorDeep: '#221f1c',
    ColorLight: '#ffe8c0'
  },
  /* MIST */ {
    Steps: 24,
    Density: 0.85,
    DensityCurve: 1.4,
    Softness: 0.7,
    Absorption: 0.9,
    Scatter: 2.0,
    Anisotropy: 0.72,
    Emission: 0.0,
    Octaves: 2,
    NoiseFrequency: 0.7,
    NoiseStrength: 0.55,
    Margin: 0.1,
    Rise: 0.15,
    Flatten: 0.5,
    ShadowTaps: 0,
    Ambient: 0.55,
    ColorCore: '#e8f0ff',
    ColorMid: '#b0c0d8',
    ColorEdge: '#68788c',
    ColorDeep: '#2a3340',
    ColorLight: '#ffffff'
  },
  /* GAS_BOIL */ {
    Steps: 38,
    Density: 1.8,
    Absorption: 2.2,
    Scatter: 1.9,
    Anisotropy: 0.15,
    Emission: 1.4,
    EmissionCurve: 0.5,
    NoiseFrequency: 0.9,
    Octaves: 3,
    Rise: 0.5,
    ShadowTaps: 1,
    Ambient: 0.4,
    ColorCore: '#c8d86a',
    ColorMid: '#9aa83a',
    ColorEdge: '#4a5a18',
    ColorDeep: '#161c08',
    ColorLight: '#f0ffc0',
    ColorEvent: '#e8ff9a'
  },
  /* VOID */ {
    Steps: 30,
    Density: 1.8,
    DensityCurve: 0.8,
    Softness: 0.55,
    // Deliberately modest, and the reason is the stars. Absorption high enough
    // to black the dome out on its own kills the transmittance in the first
    // half-metre, so every star behind that is integrated at T = 0 and never
    // appears. VoidBite does the blacking-out instead — it works on the final
    // alpha, after the emission has already been gathered.
    Absorption: 1.9,
    Scatter: 0.25,
    Ambient: 0.06,
    Anisotropy: 0.0,
    Emission: 1.0,
    EmissionCurve: 0.35,
    NoiseFrequency: 0.6,
    NoiseStrength: 0.5,
    Octaves: 3,
    Rise: 0.1,
    ShadowTaps: 0,
    VoidBite: 1.1,
    SpeckDensity: 0.09,
    SpeckScale: 1.8,
    SpeckSize: 0.14,
    SpeckGlow: 14.0,
    ColorCore: '#0a0a18',
    ColorMid: '#050510',
    ColorEdge: '#020206',
    ColorDeep: '#000000',
    ColorLight: '#20203a',
    ColorSpeck: '#c0d0ff'
  }
];

/**
 * A ready-made settings sub-block for one hull.
 *
 * Spread it into an ability's block so the editor, the presets and
 * `scripts/check.mjs` all see real keys:
 *
 * ```js
 * export const pyroclasm = {
 *   range: 22, minRange: 4, speed: 30, cooldown: 1.2, castAnim: 'cast2',
 *   zoneRadius: 5.5,
 *   ...volumeHullDefaults('ash', Medium.ASH, { ashSteps: 44, ashRise: 1.2 })
 * };
 * ```
 *
 * Overrides are keyed by the **prefixed** name, so they read the same way the
 * ability will read them.
 *
 * @param {string} prefix   settings-key prefix, e.g. 'ash'
 * @param {number} medium   Medium.* — picks the palette and the tuning
 * @param {object} overrides prefixed key → value
 */
export function volumeHullDefaults(prefix, medium = Medium.SMOKE, overrides = {}) {
  const tuning = MEDIUM_DEFAULTS[medium] ?? {};
  const block = {};
  for (const [suffix, def] of FIELDS) {
    block[prefix + suffix] = suffix in tuning ? tuning[suffix] : def;
  }
  return Object.assign(block, overrides);
}

/**
 * Editor folders for one hull, ready to spread into an ability's schema.
 *
 * @param {string} prefix
 * @param {object} [options]
 * @param {string} [options.label]  folder prefix, defaults to the key prefix
 * @param {string[]} [options.only] folder ids to emit ('march','shape','field',
 *                                  'flow','optics','boil','void','colour').
 *                                  Omit the two medium-specific ones unless the
 *                                  medium uses them, or the editor grows forty
 *                                  dead sliders per ability.
 */
export function volumeHullSchema(prefix, options = {}) {
  const label = options.label ?? prefix;
  const only = options.only ?? ['march', 'shape', 'field', 'flow', 'optics', 'colour'];
  const schema = {};
  for (const [suffix, def, min, max, step, name, folder] of FIELDS) {
    if (!only.includes(folder)) continue;
    const key = `${label} · ${folder}`;
    if (!schema[key]) schema[key] = [];
    // Colours are detected by value, so they go in bare (see EXPANSION §2).
    schema[key].push(typeof def === 'string' ? prefix + suffix : [prefix + suffix, min, max, step, name]);
  }
  return schema;
}

/** suffix → prefixed key, built once per prefix. See the note in `sync()`. */
const _keyCache = new Map();

function keysFor(prefix) {
  let keys = _keyCache.get(prefix);
  if (keys) return keys;
  keys = {};
  for (const [suffix] of FIELDS) keys[suffix] = prefix + suffix;
  _keyCache.set(prefix, keys);
  return keys;
}

/* ---------------------------------------------------------------- */
/* The hull                                                          */
/* ---------------------------------------------------------------- */

const _dir = new Vector3();
const _up = new Vector3(0, 1, 0);


/**
 * A raymarched volume inside a proxy hull.
 *
 * **What it draws.** One mesh — a unit BOX / CYLINDER / CONE / DOME / SPHERE —
 * whose fragment shader fires a ray from the camera, intersects the hull
 * analytically in the hull's own frame, and integrates a procedural density
 * field front to back with an early-out on transmittance and a per-sample clip
 * against the opaque depth prepass. Nothing is a texture; the field is value
 * noise, an fbm and (for GAS_BOIL) a cellular lattice.
 *
 * **Draw calls.** One. Always one, whatever the medium.
 *
 * **What it reads from settings.** Everything, through a key prefix, every
 * frame — see `sync()`. The one dimension it does *not* own is its own
 * footprint: call `setSize()` each frame with metres you have just re-resolved
 * yourself. That is deliberate. In every ability that wants a volume the
 * footprint already belongs to something else — `zoneRadius`, the cast length,
 * the cone's reach — and giving the hull its own radius slider would produce
 * two numbers that have to agree and one bug report per ability when they do
 * not.
 *
 * **The one rule.** *The hull must be the smallest shape that still contains
 * the field.* Both failures are ugly and both are common. Too small and the
 * volume is sliced off along a dead straight line where it meets the proxy —
 * unmistakable, and the single most obvious way this technique fails. Too big
 * and every ray spends its whole step budget crossing vacuum, so the volume
 * both costs more *and* resolves less.
 *
 * The knob that reconciles them is `<prefix>Margin`: it holds the medium's
 * nominal surface that fraction of the hull inside the wall, leaving the
 * erosion somewhere to push into. Erosion is what escapes, so the pair to
 * watch is `Margin` against `NoiseStrength` — turn one up and you owe the
 * other. If you see a straight edge, that is the pair, every time.
 *
 * **Cost.** `cost(pixels)` gives the field-sample count; keep the scene's total
 * under `VOLUME_SAMPLE_BUDGET`. Rules of thumb, at 1080p:
 *
 *   coverage   steps   taps   samples     verdict
 *   ────────   ─────   ────   ────────    ───────────────────────────────
 *   10 %       32      0      6.6 M       comfortable
 *   25 %       36      0      18.7 M      the working limit for a hero volume
 *   25 %       36      1      37 M        only if it is the only VFX on screen
 *   50 %       48      1      100 M       will not hold 60 fps anywhere
 *
 * There is no half-resolution VFX pass in this renderer, so a volume pays full
 * fragment cost. The two levers in order of effect are **coverage** (shrink the
 * hull, or move the camera) and **taps** (emissive media need none); dropping
 * steps is the last resort because it is the one that shows.
 *
 * @example
 * const hull = new VolumeHull({
 *   hull: HullShape.DOME, medium: Medium.ASH, prefix: 'ash', maxSteps: 48
 * });
 * this.group.add(hull.mesh);
 * // ...each frame, including a zero-length one:
 * const r = settings.pyroclasm.zoneRadius * settings.pyroclasm.ashSpread;
 * hull.place(this.position).setSize(r, r * 0.55, r).setFade(1 - t).sync(c, g);
 */
export class VolumeHull {
  /**
   * @param {object}  options
   * @param {number}  [options.hull=HullShape.SPHERE]   HullShape.*
   * @param {number}  [options.medium=Medium.SMOKE]     Medium.*
   * @param {string}  [options.prefix='volume']         settings-key prefix
   * @param {number}  [options.maxSteps=48]             compile-time loop cap
   * @param {boolean} [options.shadow]                  compile the self-shadow
   *                  tap at all. Defaults to true for absorbing media. Setting
   *                  it false removes the branch and shrinks the shader.
   * @param {boolean} [options.additive=false]          additive instead of
   *                  premultiplied "over". Cheaper to reason about for pure
   *                  glow (MIST haloes), but the medium then cannot occlude
   *                  anything, so never use it for SMOKE, SAND, ASH or VOID.
   * @param {number}  [options.renderOrder=12]
   * @param {number}  [options.seed]                    unitless; a dice roll
   */
  constructor(options = {}) {
    const {
      hull = HullShape.SPHERE,
      medium = Medium.SMOKE,
      prefix = 'volume',
      maxSteps = 48,
      shadow = medium !== Medium.FLAME && medium !== Medium.VOID && medium !== Medium.SPORE,
      additive = false,
      renderOrder = 12,
      seed = Math.random() * 97
    } = options;

    this.hull = hull;
    this.medium = medium;
    this.prefix = prefix;
    this.maxSteps = Math.max(4, Math.round(maxSteps));
    this.shadowCompiled = !!shadow;

    this._keys = keysFor(prefix);
    this._defaults = volumeHullDefaults(prefix, medium);
    this._fade = 1;
    this._steps = 0;
    this._shadowTaps = 0;
    this._checked = false;

    const blend = additive
      ? { blending: AdditiveBlending }
      : {
          blending: CustomBlending,
          blendEquation: AddEquation,
          blendSrc: OneFactor,
          blendDst: OneMinusSrcAlphaFactor,
          blendSrcAlpha: OneFactor,
          blendDstAlpha: OneMinusSrcAlphaFactor
        };

    this.material = new ShaderMaterial({
      defines: {
        HULL_SHAPE: hull,
        MEDIUM: medium,
        MAX_STEPS: this.maxSteps,
        VOLUME_SHADOW: this.shadowCompiled ? 1 : 0
      },
      transparent: true,
      depthWrite: false,
      // Per-sample scene-depth clipping inside the march does the occlusion job
      // properly. Testing the hull's own depth would slice the volume flat.
      depthTest: false,
      // Back faces, so the camera can stand *inside* the volume and still get a
      // fragment — front faces would be clipped away by the near plane and the
      // volume would vanish exactly when the player walks into it.
      side: BackSide,
      toneMapped: false,
      ...blend,
      uniforms: sharedUniforms({
        uInvModel: { value: new Matrix4() },
        uSize: { value: new Vector3(1, 1, 1) },

        uSteps: { value: 32 },
        uJitter: { value: 1 },
        uContact: { value: 0.9 },
        uSeed: { value: seed },

        uRound: { value: 0.35 },
        uMargin: { value: 0.18 },
        uHeightBias: { value: 0.35 },
        uFeather: { value: 0.25 },
        uHollow: { value: 0 },
        uThroat: { value: 0.12 },

        uDensity: { value: 1.6 },
        uDensityCurve: { value: 1 },
        uSoftness: { value: 0.45 },
        uNoiseFrequency: { value: 1.4 },
        uNoiseStrength: { value: 0.85 },
        uNoiseWarp: { value: 0.25 },
        uOctaves: { value: 4 },
        uDetail: { value: 0.5 },

        uFlow: { value: new Vector3() },
        uJet: { value: 0 },
        uRise: { value: 0.6 },
        uSwirl: { value: 0 },
        uFlatten: { value: 0 },

        uAbsorption: { value: 1.4 },
        uScatter: { value: 1 },
        uAmbient: { value: 0.25 },
        uAnisotropy: { value: 0.25 },
        uEmission: { value: 0 },
        uEmissionCurve: { value: 1 },
        uShadowTaps: { value: 1 },
        uShadowStrength: { value: 1 },
        uShadowLength: { value: 0.6 },
        uOpacity: { value: 1 },

        uBoilRate: { value: 0.5 },
        uBoilScale: { value: 1.6 },
        uBoilSize: { value: 0.72 },
        uBoilPop: { value: 0.55 },
        uBoilWarp: { value: 1.1 },
        uBoilDepth: { value: 0.8 },
        uBoilFlash: { value: 2.2 },

        uSpeckDensity: { value: 0.12 },
        uSpeckScale: { value: 2.2 },
        uSpeckSize: { value: 0.3 },
        uSpeckGlow: { value: 3 },
        uVoidBite: { value: 0.4 },

        uColorCore: { value: new Color(1, 1, 1) },
        uColorMid: { value: new Color(0.7, 0.7, 0.7) },
        uColorEdge: { value: new Color(0.35, 0.35, 0.35) },
        uColorDeep: { value: new Color(0.08, 0.08, 0.08) },
        uColorLight: { value: new Color(1, 0.95, 0.88) },
        uColorEvent: { value: new Color(1, 0.7, 0.35) },
        uColorSpeck: { value: new Color(0.75, 0.82, 1) }
      }),
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT
    });

    this.mesh = new Mesh(unitHull(hull), this.material);
    this.mesh.name = `VolumeHull:${HULL_NAMES[hull]}:${MEDIUM_NAMES[medium]}`;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.renderOrder = renderOrder;
    // The geometry is unit-sized and stretched in the vertex shader, so three's
    // bounding sphere describes a one-metre ball that has nothing to do with
    // where this thing actually is. Culling against it would blink the volume
    // out at the screen edge.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
  }

  /* ---- placement ---------------------------------------------------- */

  /**
   * Anchor the hull. `direction` is optional and **flat**: only yaw is applied,
   * because a dome or a slab that pitched with an aim line would lift off the
   * floor at one edge and bury itself at the other.
   *
   * @param {THREE.Vector3} position world anchor (the hull's local origin)
   * @param {THREE.Vector3} [direction] cast heading; the hull's local +Z
   */
  place(position, direction = null) {
    this.mesh.position.copy(position);
    if (direction) {
      _dir.copy(direction).setY(0);
      if (_dir.lengthSq() > 1e-8) {
        this.mesh.quaternion.setFromAxisAngle(_up, Math.atan2(_dir.x, _dir.z));
      }
    }
    this.mesh.updateMatrix();
    return this;
  }

  /**
   * Half-extents in metres — see `HullShape` for what each axis means.
   *
   * Free to call every frame: it writes a uniform, nothing is rebuilt, and the
   * hull's world matrix is untouched (which is what keeps the march's `t` in
   * metres — see the note in `main()`).
   */
  setSize(x, y = x, z = x) {
    this.material.uniforms.uSize.value.set(Math.max(x, 1e-3), Math.max(y, 1e-3), Math.max(z, 1e-3));
    return this;
  }

  /**
   * Master 0..1 from the ability's phase clock.
   *
   * It thins the medium rather than merely making it transparent, because a
   * volume that fades on opacity alone goes ghostly and evenly grey — real
   * smoke disperses, which means it loses density first and coverage with it.
   *
   * At zero the mesh is hidden outright. That is a real cost control, not
   * tidiness: `frustumCulled` is off, so an invisible-but-drawn hull would keep
   * paying full fill rate for a volume nobody can see.
   */
  setFade(k) {
    this._fade = k > 0 ? (k < 1 ? k : 1) : 0;
    this.mesh.visible = this._fade > 0.002;
    return this;
  }

  /* ---- the frame ---------------------------------------------------- */

  /**
   * Re-resolve every uniform from live settings. Call once per frame, from
   * `onTravel` / `onFade`, **including on a zero-length frame** (I1).
   *
   * Keys are `prefix + Suffix` — `ashDensity`, `ashSteps`, `ashColorCore`. The
   * prefixed strings are built once, when the hull is constructed, and cached
   * per prefix module-wide: concatenating forty strings per frame per hull
   * would allocate forty short-lived strings sixty times a second, which is
   * exactly the kind of thing I3 exists to stop.
   *
   * `settings.global` scales what it scales elsewhere, plus one of its own:
   * `global.volumeQuality` (default 1 when absent) multiplies the step count,
   * so the whole expansion's raymarching can be dialled down from one slider.
   *
   * @param {object} c the ability's settings block (`settings.<id>`)
   * @param {object} g `settings.global`
   */
  sync(c, g) {
    const K = this._keys;
    const D = this._defaults;
    const u = this.material.uniforms;

    if (!this._checked) this._audit(c);

    /* --- march --- */
    const quality = num(g?.volumeQuality, 1);
    const steps = Math.round(num(c[K.Steps], D[K.Steps]) * quality);
    this._steps = Math.max(4, Math.min(this.maxSteps, steps));
    u.uSteps.value = this._steps;
    u.uJitter.value = num(c[K.Jitter], D[K.Jitter]);
    u.uContact.value = num(c[K.Contact], D[K.Contact]);

    /* --- silhouette --- */
    u.uMargin.value = num(c[K.Margin], D[K.Margin]);
    u.uRound.value = num(c[K.Round], D[K.Round]);
    u.uHeightBias.value = num(c[K.HeightBias], D[K.HeightBias]);
    u.uFeather.value = num(c[K.Feather], D[K.Feather]);
    u.uHollow.value = num(c[K.Hollow], D[K.Hollow]);
    u.uThroat.value = num(c[K.Throat], D[K.Throat]);

    /* --- field. The fade thins the medium; see setFade(). --- */
    u.uDensity.value = num(c[K.Density], D[K.Density]) * this._fade;
    u.uDensityCurve.value = num(c[K.DensityCurve], D[K.DensityCurve]);
    u.uSoftness.value = num(c[K.Softness], D[K.Softness]);
    u.uNoiseFrequency.value =
      num(c[K.NoiseFrequency], D[K.NoiseFrequency]) * num(g?.noiseFrequency, 1);
    u.uNoiseStrength.value =
      num(c[K.NoiseStrength], D[K.NoiseStrength]) * num(g?.noiseStrength, 1) * num(g?.turbulence, 1);
    u.uNoiseWarp.value = num(c[K.NoiseWarp], D[K.NoiseWarp]) * num(g?.turbulence, 1);
    u.uOctaves.value = num(c[K.Octaves], D[K.Octaves]);
    u.uDetail.value = num(c[K.Detail], D[K.Detail]);

    /* --- advection. Metres per second, so global.noiseSpeed belongs here. --- */
    const speed = num(g?.noiseSpeed, 1);
    u.uFlow.value.set(
      num(c[K.FlowX], D[K.FlowX]) * speed,
      num(c[K.FlowY], D[K.FlowY]) * speed,
      num(c[K.FlowZ], D[K.FlowZ]) * speed
    );
    u.uJet.value = num(c[K.Jet], D[K.Jet]) * speed;
    u.uRise.value = num(c[K.Rise], D[K.Rise]) * speed;
    u.uSwirl.value = num(c[K.Swirl], D[K.Swirl]) * speed;
    u.uFlatten.value = num(c[K.Flatten], D[K.Flatten]);

    /* --- optics --- */
    u.uAbsorption.value = num(c[K.Absorption], D[K.Absorption]);
    u.uScatter.value = num(c[K.Scatter], D[K.Scatter]);
    u.uAmbient.value = num(c[K.Ambient], D[K.Ambient]);
    u.uAnisotropy.value = num(c[K.Anisotropy], D[K.Anisotropy]);
    u.uEmission.value = num(c[K.Emission], D[K.Emission]) * num(g?.glow, 1);
    u.uEmissionCurve.value = num(c[K.EmissionCurve], D[K.EmissionCurve]);
    // The compile-time flag wins: asking for taps in a shader built without
    // them would silently do nothing, and reporting the cost as if they ran
    // would make `cost()` lie.
    this._shadowTaps = this.shadowCompiled
      ? Math.max(0, Math.min(2, Math.round(num(c[K.ShadowTaps], D[K.ShadowTaps]) * quality)))
      : 0;
    u.uShadowTaps.value = this._shadowTaps;
    u.uShadowStrength.value = num(c[K.ShadowStrength], D[K.ShadowStrength]);
    u.uShadowLength.value = num(c[K.ShadowLength], D[K.ShadowLength]);
    u.uOpacity.value = num(c[K.Opacity], D[K.Opacity]) * num(g?.opacity, 1);

    /* --- GAS_BOIL --- */
    u.uBoilRate.value = num(c[K.BoilRate], D[K.BoilRate]) * speed;
    u.uBoilScale.value = num(c[K.BoilScale], D[K.BoilScale]);
    u.uBoilSize.value = num(c[K.BoilSize], D[K.BoilSize]);
    u.uBoilPop.value = num(c[K.BoilPop], D[K.BoilPop]);
    u.uBoilWarp.value = num(c[K.BoilWarp], D[K.BoilWarp]);
    u.uBoilDepth.value = num(c[K.BoilDepth], D[K.BoilDepth]);
    u.uBoilFlash.value = num(c[K.BoilFlash], D[K.BoilFlash]) * num(g?.glow, 1);

    /* --- sparse points --- */
    u.uSpeckDensity.value = num(c[K.SpeckDensity], D[K.SpeckDensity]);
    u.uSpeckScale.value = num(c[K.SpeckScale], D[K.SpeckScale]);
    u.uSpeckSize.value = num(c[K.SpeckSize], D[K.SpeckSize]);
    u.uSpeckGlow.value = num(c[K.SpeckGlow], D[K.SpeckGlow]) * num(g?.glow, 1);

    /* --- VOID --- */
    u.uVoidBite.value = num(c[K.VoidBite], D[K.VoidBite]);

    /* --- colour --- */
    u.uColorCore.value.copy(getColor(c[K.ColorCore] ?? D[K.ColorCore]));
    u.uColorMid.value.copy(getColor(c[K.ColorMid] ?? D[K.ColorMid]));
    u.uColorEdge.value.copy(getColor(c[K.ColorEdge] ?? D[K.ColorEdge]));
    u.uColorDeep.value.copy(getColor(c[K.ColorDeep] ?? D[K.ColorDeep]));
    u.uColorLight.value.copy(getColor(c[K.ColorLight] ?? D[K.ColorLight]));
    u.uColorEvent.value.copy(getColor(c[K.ColorEvent] ?? D[K.ColorEvent]));
    u.uColorSpeck.value.copy(getColor(c[K.ColorSpeck] ?? D[K.ColorSpeck]));

    /* --- the frame's one matrix inverse ---
       World → hull-local. The march needs it to turn the camera ray into the
       frame the hull is analytic in. Rebuilt every frame rather than on a dirty
       flag: it is one 4×4 invert against a rigid matrix, and a dirty flag that
       misses one placement leaves the volume marching yesterday's pose. */
    this.mesh.updateWorldMatrix(true, false);
    u.uInvModel.value.copy(this.mesh.matrixWorld).invert();

    return this;
  }

  /* ---- cost --------------------------------------------------------- */

  /** Steps actually marched last frame, after the quality multiplier. */
  get steps() {
    return this._steps;
  }

  /** Shadow taps actually taken last frame. */
  get shadowTaps() {
    return this._shadowTaps;
  }

  /**
   * Field samples per frame at a given screen coverage.
   *
   * @param {number} coveredPixels how many pixels the hull's silhouette fills.
   *        Eyeball it: a dome filling a quarter of a 1080p frame is 520 000.
   * @returns {number} compare against VOLUME_SAMPLE_BUDGET
   */
  cost(coveredPixels) {
    return coveredPixels * this._steps * (1 + this._shadowTaps);
  }

  /* ---- teardown ----------------------------------------------------- */

  /** Material only — the unit hull is shared. See disposeVolumeHullGeometry(). */
  dispose() {
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }

  /**
   * One-shot check that the settings block actually has the keys this hull
   * reads. `sync()` falls back to the medium's default for anything missing, so
   * a half-written block renders instead of turning the volume into NaN — but
   * silently falling back is how an ability ends up with a slider that does
   * nothing, so it says so, once, and names every key.
   */
  _audit(c) {
    this._checked = true;
    auditBlock(
      `VolumeHull:${this.prefix}`,
      this._keys,
      VOLUME_HULL_KEYS,
      c,
      `volumeHullDefaults('${this.prefix}', Medium.${MEDIUM_NAMES[this.medium]})`
    );
  }
}
