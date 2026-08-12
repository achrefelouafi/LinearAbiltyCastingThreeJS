import {
  Group,
  Mesh,
  ShaderMaterial,
  AdditiveBlending,
  DoubleSide,
  Color,
  Vector3,
  Vector4
} from 'three';
import { createBoltRibbonGeometry } from '../assets/ProceduralGeometry.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { disruptGLSL, disruptUniforms } from './SceneHooks.js';
import { getColor } from '../utils/color.js';
import { LAYER } from '../core/Layers.js';

/* ---------------------------------------------------------------------- */
/* FilamentPaths — every filament in the project, on two draw calls        */
/* ---------------------------------------------------------------------- */

/**
 * The instanced ribbon strip with pluggable parametric paths.
 *
 * `LightningMaterial` proved the shape of the idea: a vertex arrives as
 * `(t, side)` — how far along its filament it is and which edge of the ribbon it
 * is on — and leaves as a world position, so *no path exists on the CPU to go
 * stale*. `SnareMaterial` then proved the generalisation: a filament's **role**
 * is decided in the vertex shader by testing its instance index against a set of
 * live counts, and the role picks which parametric path it is threaded along, so
 * one strip draws a whip, a pillar, a crawl of tendrils and a ring of travelling
 * arcs at once, and setting a count to zero retires that role outright.
 *
 * This module is that second idea with the snare taken out of it. Nine path
 * modes, four role slots, one geometry, two draw calls, and every metre re-read
 * from the caller's live settings on every frame including a zero-length one.
 *
 * ## What it draws
 *
 * One `InstancedBufferGeometry` ribbon strip (`createBoltRibbonGeometry`) drawn
 * **twice** — a wide soft halo underneath and the hot core on top. Drawing the
 * glow as real ribbon rather than leaving it to bloom is what keeps it
 * *attached* to every kink; it is the single biggest reason the original bolt
 * reads as lightning at any distance.
 *
 * **Two draw calls. Always.** Four roles or one, forty filaments or three.
 *
 * ## The three stages, which never change
 *
 *   1. **the path** — the role's own centreline, `pathAt(t)`. The only part that
 *      knows the cast's geometry.
 *   2. **the frame** — a tangent by finite difference on that path and two
 *      normals off it. Every offset lives in this frame, which is what lets one
 *      kink function serve a vertical pillar and a filament crawling flat across
 *      the floor.
 *   3. **the kinks** — octaves of *linearly* interpolated value noise. Linear on
 *      purpose: `smoothstep` would round the corners off, and the corners are
 *      the entire reason it reads as lightning rather than as a wobbly tube.
 *      Every mode gets them, including the ones that are not lightning; set
 *      `kink` to 0 on a role that wants a clean curve.
 *
 * ## Ground-hugging roles
 *
 * A kink with a free `y` buries half of every filament that runs flat, and the
 * effect reads as a broken dotted line. Two knobs, both per role: `groundDamp`
 * scales the world-`y` component of the kink (0.3 is the snare's value) and
 * `floorY` clamps the result above the floor. Set them on `MEANDER`, `RIM` and
 * any `CHAIN` that skims the ground; leave them at 1 and −∞ for anything in
 * the air.
 *
 * ## The one rule for using it well
 *
 * **Fill the role from `settings[id]` every frame, and never keep a metre
 * between frames.** A role's setters take resolved metres and radians, so the
 * call belongs in `onTravel`/`onFade` next to the settings read that produced
 * it — not in `onSpawn`. The test is the one in `docs/EXPANSION.md §0`: pause
 * with **P**, drag a slider, and the standing filaments must move.
 *
 * ## Cost
 *
 * 2 draw calls. ~90 of the 128 vertex uniform vectors WebGL guarantees, which
 * is why there are four role slots and twelve chain nodes rather than eight and
 * thirty-two; if you need a fifth role you want a second `FilamentPaths` (and
 * two more draw calls), not a wider array.
 *
 * @example
 *   this.paths = new FilamentPaths(this.group, { samples: 72, capacity: 48 });
 *   // …every frame:
 *   const bolt = this.paths.role(0);
 *   bolt.count = c.strands;
 *   bolt.line(_hand, _target, c.sag, c.spreadNear, c.spread, c.spreadCurve,
 *             c.twist, c.twistSpeed, c.converge);
 *   bolt.ends(0, 1, 0, 1);                 // pinned at the hand, tapering at the tip
 *   bolt.draw(this.u, c.tipLength, -1e4, c.tipGlow);
 *   this.paths.sync(this._look, fade, this._seed);
 */

/** Which parametric path a role is threaded along. A mode, not a dimension. */
export const PathMode = Object.freeze({
  /** The bolt: straight axis + a fan opening downrange + linear-value-noise kinks. */
  LINE: 0,
  /** A coil around the axis between two points. Railgun barrels, wound ropes. */
  HELIX: 1,
  /** Great slow loops around a point, each on its own inclined plane. Caged orbs. */
  ORBIT: 2,
  /** A committed veer running outward from a centre. The snare's tendril. */
  MEANDER: 3,
  /** An arc travelling around a boundary, lifting over it at mid-span. */
  RIM: 4,
  /** A polyline through the scattered nodes, with a per-hop lighting clock. */
  CHAIN: 5,
  /** A sagging catenary between two points, with a slack→taut control. */
  LINK: 6,
  /** A spiral collapsing from one radius to another as it travels. */
  SPIRAL_IN: 7,
  /** A branching fracture: trunk, branches, twigs, three generations deep. */
  CRACK: 8
});

/** The two passes. Same geometry, same paths — only width and profile differ. */
export const FilamentPass = Object.freeze({
  CORE: 0, // the hot filament itself
  GLOW: 1 // the wide halo it sits inside
});

/** Role slots per instance. Four, because four is what fits — see the header. */
export const MAX_FILAMENT_ROLES = 4;

/** Nodes a `CHAIN` may thread. Twelve is already more hops than reads. */
export const MAX_CHAIN_NODES = 12;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _dir = new Vector3();
const _lat = new Vector3();
const _up = new Vector3(0, 1, 0);
const _flat = new Vector3();

/**
 * Canonical look parameters with their defaults.
 *
 * Every one is read fresh on every call to `sync()`; a missing field falls back
 * to the default listed here, so a look object only carries what the ability
 * actually authors. The names are deliberately the snare's and the bolt's, so
 * an ability whose settings block uses them can pass the block itself and make
 * breaking invariant **I1** impossible.
 *
 * The five `global.*` multipliers at the bottom default to 1, which is what you
 * get if you do pass the block straight through; fill them from
 * `settings.global` when the ability wants the master sliders to bite.
 */
export function filamentLook() {
  return {
    /* --- the ribbon (metres) --- */
    width: 0.032, // half-width of the core ribbon
    glowWidth: 6.2, // halo half-width as a multiple of `width`
    glowOpacity: 0.44, // halo alpha relative to the core

    /* --- the kinks --- */
    jitter: 1, // metres of lateral kink, before the per-role multiplier
    jitterScale: 1.4, // kinks per metre of path
    octaves: 4, // 1..5 octaves of value noise
    jitterFalloff: 0.55, // amplitude multiplier per octave
    crawl: 2.4, // how fast the kinks slide along, per second
    pinch: 0.16, // 0..1 of the path the kink is eased in over at each end
    restrike: 21, // whole re-shapes per second

    /* --- the guttering --- */
    flicker: 0.26, // 0..1 depth of the whole-bundle brightness stutter
    flickerSpeed: 30, // steps per second that stutter is quantised to
    strandFlash: 0.45, // 0..1 depth of the per-filament blink

    /* --- the cross-ribbon profile --- */
    coreSharp: 4.4, // exponent on the core's edge falloff — higher is thinner
    glowFalloff: 2.3, // the same for the halo
    softFade: 0.7, // metres of depth fade against the opaque scene

    /* --- output --- */
    opacity: 1,
    glow: 2.2, // emissive multiplier fed into bloom
    colorCore: '#ffffff', // the white-hot centre line
    colorInner: '#dcd2ff',
    colorOuter: '#8f6bff',
    colorHalo: '#290d8c', // the wide, dim atmosphere

    /* --- settings.global, if the ability wants them --- */
    randomness: 1, // multiplies `jitter`
    noiseStrength: 1, // multiplies `jitter`
    noiseFrequency: 1, // multiplies `jitterScale`
    noiseSpeed: 1, // multiplies `crawl`
    opacityScale: 1, // multiplies `opacity`
    glowScale: 1 // multiplies `glow`
  };
}

/* ---------------------------------------------------------------------- */
/* The shader                                                              */
/* ---------------------------------------------------------------------- */

/**
 * The whole library lives in this vertex shader.
 *
 * Two things about it are worth knowing before reading it.
 *
 * **Role parameters are lifted into globals.** `pathAt()` is called three times
 * per vertex (here, behind, ahead) and threading eight uniforms through every
 * call would drown the maths it exists to show. They are assigned once in
 * `main()` and read as `g*` from there down.
 *
 * **Uniform arrays are only ever indexed by a loop counter.** GLSL ES 1.00 only
 * guarantees array indexing by a *constant-index-expression*, and a for-loop
 * index counts while a value derived from an attribute does not. So the role
 * lookup and the chain-node lookup are both a fixed loop with an `if` inside
 * rather than the direct `uFrom[role]` they would obviously like to be. This is
 * not a style choice; the direct version fails to compile on ANGLE.
 */
const FILAMENT_VERTEX = /* glsl */ `
  ${disruptGLSL}
  varying float vDisrupt;   // spellbreak's field, sampled per vertex — see SceneHooks

  #define PI  3.141592653589793
  #define TAU 6.283185307179586
  #define ROLES ${MAX_FILAMENT_ROLES}
  #define NODES ${MAX_CHAIN_NODES}

  uniform float uTime;
  uniform float uSeed;
  uniform float uRestrike;
  uniform float uFade;

  /* --- per-role blocks. See the JSDoc on each FilamentRole method. --- */
  uniform float uMode[ROLES];   // PathMode
  uniform float uCount[ROLES];  // live filaments in this role
  uniform vec3  uFrom[ROLES];   // anchor A — start, or centre, metres
  uniform vec3  uTo[ROLES];     // anchor B — end, or axis reference, metres
  uniform vec4  uShape[ROLES];  // mode-specific
  uniform vec4  uShape2[ROLES]; // mode-specific, continued
  uniform vec4  uStyle[ROLES];  // kink amp, width multiplier, dim, ground damp
  uniform vec4  uEnds[ROLES];   // fade start, fade end, taper start, taper end
  uniform vec4  uDraw[ROLES];   // progress, tip length, floor y (m), tip glow

  /* --- the chain's scatter, unitless fractions only --- */
  uniform vec4  uNodes[NODES];  // along 0..1, lateral -1..1, lift 0..1, spare
  uniform float uNodeCount;

  /* --- shared look --- */
  uniform float uJitter;
  uniform float uJitterScale;
  uniform float uOctaves;
  uniform float uJitterFalloff;
  uniform float uCrawl;
  uniform float uPinch;
  uniform float uWidth;
  uniform float uWidthScale;
  uniform float uStrandFlash;
  uniform float uFlickerSpeed;

  attribute float aStrand;

  varying float vSide;
  varying float vDim;
  varying float vFlash;
  varying float vLit;
  varying float vDrawn;
  varying float vTip;
  varying float vEndFade;
  varying float vViewZ;

  ${noiseGLSL}

  /* --- the role, hoisted out of main so pathAt can see it --- */
  float gMode;
  vec3  gFrom;
  vec3  gTo;
  vec4  gShape;
  vec4  gShape2;
  vec4  gStyle;
  vec4  gEnds;
  vec4  gDraw;
  float gF;    // this filament's place in its role, 0..1, half-open
  float gSeed; // per-filament, re-rolled on every strike

  /** Value noise with a *linear* ramp — piecewise-linear output, sharp corners. */
  float vnoise(float x, float seed) {
    float i = floor(x);
    float f = x - i;
    return mix(hash11(i + seed), hash11(i + 1.0 + seed), f) * 2.0 - 1.0;
  }

  /** ESSL 1.00 has no hyperbolics. The catenary needs one. */
  float coshf(float x) { return 0.5 * (exp(x) + exp(-x)); }

  /**
   * Offset of one filament from its path, in the perpendicular plane.
   * 'span' is the length of that path, so 'uJitterScale' stays kinks per
   * *metre* whether the filament is a 20 m whip or a 1 m hop around a rim.
   */
  vec2 kink(float t, float seed, float span) {
    vec2 o = vec2(0.0);
    float amp = 1.0;
    float freq = max(uJitterScale, 0.01) * span;
    float scroll = uTime * uCrawl;

    // Fixed trip count with a per-octave gate: a dynamic bound is not portable,
    // and five multiply-adds are cheaper than the branch would be anyway.
    for (int i = 0; i < 5; i++) {
      float on = step(float(i), uOctaves - 1.0);
      o.x += on * amp * vnoise(t * freq + scroll, seed + 13.0 * float(i));
      o.y += on * amp * vnoise(t * freq + scroll * 1.17, seed + 71.3 + 13.0 * float(i));
      amp *= uJitterFalloff;
      freq *= 2.0;
      scroll *= 1.63;
    }
    return o;
  }

  /** Unit tangent plus two normals for the segment A→B. */
  void axisFrame(vec3 a, vec3 b, out vec3 dir, out vec3 n1, out vec3 n2) {
    vec3 d = b - a;
    float len = length(d);
    dir = len > 1e-4 ? d / len : vec3(0.0, 1.0, 0.0);
    // The usual world-up reference degenerates on exactly the paths that run
    // vertically — the column, the spiral — which are the ones that need a
    // frame most.
    vec3 up = abs(dir.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    n1 = normalize(cross(dir, up));
    n2 = normalize(cross(dir, n1));
  }

  /** The chain's lateral and vertical, taken flat so 'lift' is genuinely up. */
  void chainBasis(out vec3 lat, out vec3 up) {
    vec3 d = gTo - gFrom;
    // 'flat' would be the obvious name and is a reserved word in GLSL ES.
    vec3 ground = vec3(d.x, 0.0, d.z);
    up = vec3(0.0, 1.0, 0.0);
    lat = length(ground) > 1e-4 ? normalize(cross(up, normalize(ground))) : vec3(1.0, 0.0, 0.0);
  }

  /** One chain node, resolved from its unitless fractions. Mirrored on the CPU. */
  vec3 nodeWorld(vec4 f, vec3 lat, vec3 up) {
    return mix(gFrom, gTo, f.x) + lat * (f.y * gShape.x) + up * (f.z * gShape.y);
  }

  /**
   * The role's centreline at 't', before any kink is added.
   *
   * Every branch reads only from the 'g*' globals and 'uTime', which is what
   * makes the whole thing re-resolve for free on a paused frame.
   */
  vec3 pathAt(float t) {
    vec3 dir, n1, n2;

    if (gMode < 0.5) {
      /* ---- LINE: the bolt ---- */
      // shape  = (sag m, spreadNear m, spread m, spreadCurve)
      // shape2 = (twist turns, twistSpeed turns/s, converge, —)
      axisFrame(gFrom, gTo, dir, n1, n2);
      vec3 p = mix(gFrom, gTo, t);
      p.y += gShape.x * sin(t * PI);
      // A constant per-filament offset in the perpendicular plane, opening from
      // spreadNear at the start to spread at the end and rolling with twist.
      // This, not the noise, is what separates one filament from the next.
      float a = gSeed * TAU + (t * gShape2.x + uTime * gShape2.y) * TAU;
      float reach = mix(gShape.y, gShape.z, pow(clamp(t, 0.0, 1.0), max(gShape.w, 0.01)));
      return p + (n1 * cos(a) + n2 * sin(a)) * reach * gF;
    }

    if (gMode < 1.5) {
      /* ---- HELIX: a coil around the axis ---- */
      // shape  = (radius m, radiusEnd m, turns, spin turns/s)
      // shape2 = (sag m, phaseSpread, taperCurve, —)
      axisFrame(gFrom, gTo, dir, n1, n2);
      vec3 p = mix(gFrom, gTo, t);
      p.y += gShape2.x * sin(t * PI);
      float a = (gF * gShape2.y + t * gShape.z + uTime * gShape.w) * TAU;
      float r = mix(gShape.x, gShape.y, pow(clamp(t, 0.0, 1.0), max(gShape2.z, 0.01)));
      return p + (n1 * cos(a) + n2 * sin(a)) * r;
    }

    if (gMode < 2.5) {
      /* ---- ORBIT: great slow loops around a point ---- */
      // shape  = (radius m, arc turns, spin turns/s, wobble)
      // shape2 = (tilt rad, tiltSpread rad, radiusJitter, —)
      // A caged orb's filaments do not radiate, they *circle*. The loops need
      // to sit on different planes or the cage reads as one flat ring, so each
      // filament tips its plane by 'tilt' and rotates its ascending node by a
      // per-filament hash. Wobble then stops any of them being a clean circle.
      axisFrame(gFrom, gTo, dir, n1, n2);
      float tilt = gShape2.x + (hash11(gSeed + 2.7) - 0.5) * gShape2.y;
      vec3 u = n1;
      vec3 v = n2 * cos(tilt) + dir * sin(tilt);
      float node = hash11(gSeed + 8.3) * TAU;
      vec3 uu =  u * cos(node) + v * sin(node);
      vec3 vv = -u * sin(node) + v * cos(node);

      float theta = (gF + t * gShape.y + uTime * gShape.z) * TAU;
      float r = gShape.x * (1.0 + (hash11(gSeed + 5.1) - 0.5) * gShape2.z);
      r *= 1.0 + gShape.w * sin(theta * 3.0 + gSeed);
      return gFrom + (uu * cos(theta) + vv * sin(theta)) * r;
    }

    if (gMode < 3.5) {
      /* ---- MEANDER: a committed veer running outward ---- */
      // shape  = (inner m, reach m, curve, wander rad)
      // shape2 = (arch m, hug m, spin turns/s, —)
      // The veer is a per-filament constant rather than noise so the tendril
      // curves *consistently*, the way a discharge that has committed to a
      // direction does; the kinks on top of it supply the rest.
      axisFrame(gFrom, gTo, dir, n1, n2);
      float veer = (hash11(gSeed + 5.0) - 0.5) * 2.0 * gShape.w;
      float a = gF * TAU + uTime * gShape2.z * TAU + hash11(gSeed) * 0.4 + veer * pow(t, 1.4);
      float r = mix(gShape.x, gShape.y, pow(clamp(t, 0.0, 1.0), max(gShape.z, 0.01)));
      return gFrom + (n1 * cos(a) + n2 * sin(a)) * r
                   + dir * (gShape2.y + gShape2.x * sin(t * PI));
    }

    if (gMode < 4.5) {
      /* ---- RIM: an arc travelling around a boundary ---- */
      // shape  = (radius m, span turns, speed turns/s, lift m)
      // shape2 = (jitter, hug m, phase turns, —)
      axisFrame(gFrom, gTo, dir, n1, n2);
      float a = (gF + uTime * gShape.z + gShape2.z) * TAU + hash11(gSeed) * 0.3 + t * gShape.y * TAU;
      float r = gShape.x * (1.0 + gShape2.x * 0.25 * sin(t * 6.0 + gSeed));
      return gFrom + (n1 * cos(a) + n2 * sin(a)) * r
                   + dir * (gShape2.y + gShape.w * sin(t * PI));
    }

    if (gMode < 5.5) {
      /* ---- CHAIN: a polyline through the scattered nodes ---- */
      // shape  = (scatter m, lift m, sag m, bow m)
      // shape2 = (lit cursor in hops, hold hops, overlap hops, tip hops)
      vec3 lat, up;
      chainBasis(lat, up);

      float segs = max(uNodeCount - 1.0, 1.0);
      float x = clamp(t, 0.0, 1.0) * segs;
      float s = min(floor(x), segs - 1.0);
      float u = x - s;

      // Constant-index-expression lookup: see the header. 'n + 1' is still one.
      vec4 fa = uNodes[0];
      vec4 fb = uNodes[1];
      for (int n = 0; n < NODES - 1; n++) {
        if (float(n) == s) { fa = uNodes[n]; fb = uNodes[n + 1]; }
      }

      // Linear between nodes, deliberately: a spline through the scatter would
      // round off the corners, and the corners are what say "this jumped".
      vec3 p = mix(nodeWorld(fa, lat, up), nodeWorld(fb, lat, up), u);
      float bowSign = mod(s, 2.0) < 0.5 ? 1.0 : -1.0;
      p += lat * (gShape.w * bowSign * sin(u * PI));
      p.y += gShape.z * sin(u * PI);
      return p;
    }

    if (gMode < 6.5) {
      /* ---- LINK: a sagging catenary ---- */
      // shape  = (slack m, curve, swing m, swingSpeed rad/s)
      // shape2 = (taut 0..1, spread m, —, —)
      // A real catenary, not a parabola: the difference is all at the ends,
      // where a hanging chain leaves its anchor much steeper than a parabola
      // does, and that steepness is most of what says "heavy".
      axisFrame(gFrom, gTo, dir, n1, n2);
      vec3 p = mix(gFrom, gTo, t);
      float k = max(gShape.y, 0.01);
      float bow = (coshf(k) - coshf(k * (2.0 * t - 1.0))) / max(coshf(k) - 1.0, 1e-4);
      p.y -= gShape.x * (1.0 - clamp(gShape2.x, 0.0, 1.0)) * bow;
      float swing = sin(uTime * gShape.w + gSeed) * gShape.z * sin(t * PI);
      return p + n1 * (swing + (gF - 0.5) * 2.0 * gShape2.y);
    }

    if (gMode < 7.5) {
      /* ---- SPIRAL_IN: a spiral collapsing as it travels ---- */
      // shape  = (radius m, radiusEnd m, turns, spin turns/s)
      // shape2 = (curve, phaseSpread, wobble, —)
      axisFrame(gFrom, gTo, dir, n1, n2);
      float e = pow(clamp(t, 0.0, 1.0), max(gShape2.x, 0.01));
      vec3 p = mix(gFrom, gTo, e);
      float theta = (gF * gShape2.y + t * gShape.z + uTime * gShape.w) * TAU;
      float r = mix(gShape.x, gShape.y, e) * (1.0 + gShape2.z * sin(theta * 2.0 + gSeed));
      return p + (n1 * cos(theta) + n2 * sin(theta)) * r;
    }

    /* ---- CRACK: a branching fracture ---- */
    // shape  = (angle rad, lengthFrac, depthFalloff, spread)
    // shape2 = (start 0..1, sag m, forkBias 0..1, —)
    // Three generations, walked forward rather than recursed: a twig has to
    // know where its branch went, and its branch has to know where the trunk
    // went, so each pass re-anchors A→B onto the child before the next one
    // reads it. Filament 0 is always the trunk, which is why a crack still
    // reads with the count wound down to one.
    vec3 a = gFrom;
    vec3 b = gTo;
    float depth = gF > 0.0001 ? 1.0 + step(mix(0.75, 0.35, clamp(gShape2.z, 0.0, 1.0)), gF) : 0.0;

    for (int gen = 0; gen < 2; gen++) {
      if (float(gen) < depth) {
        vec3 d = b - a;
        float len = length(d);
        vec3 fd = len > 1e-4 ? d / len : vec3(0.0, -1.0, 0.0);
        vec3 up = abs(fd.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
        vec3 m1 = normalize(cross(fd, up));
        vec3 m2 = normalize(cross(fd, m1));

        float at = mix(clamp(gShape2.x, 0.0, 1.0), 1.0, hash11(gSeed + float(gen) * 17.0));
        float roll = hash11(gSeed + float(gen) * 7.3 + 3.1) * TAU;
        float sgn = hash11(gSeed + float(gen) * 5.5) < 0.5 ? -1.0 : 1.0;
        float ang = gShape.x * (1.0 + (hash11(gSeed + float(gen) * 2.9) - 0.5) * gShape.w);

        vec3 off = m1 * cos(roll) + m2 * sin(roll);
        vec3 nd = normalize(fd * cos(ang) + off * sin(ang) * sgn);

        vec3 root = mix(a, b, at);
        a = root;
        b = root + nd * len * gShape.y * pow(max(gShape.z, 0.01), float(gen));
      }
    }

    vec3 p = mix(a, b, t);
    p.y += gShape2.y * sin(t * PI);
    return p;
  }

  /** Metres of path, so the kink frequency means the same thing in every mode. */
  float pathSpan() {
    float len = length(gTo - gFrom);
    if (gMode < 1.5) return max(len, 0.01);                        // LINE, HELIX
    if (gMode < 2.5) return max(gShape.x * gShape.y * TAU, 0.01);  // ORBIT
    if (gMode < 3.5) return max(abs(gShape.y - gShape.x), 0.05);   // MEANDER
    if (gMode < 4.5) return max(gShape.x * gShape.y * TAU, 0.01);  // RIM
    return max(len, 0.01);                                         // CHAIN, LINK, SPIRAL, CRACK
  }

  /**
   * How lit this point of a chain is.
   *
   * The clock is a cursor in *hops*, not seconds — 'ArcNetwork' integrates
   * 'dt / hopTime' so that dragging the hop time never rewrites the past. A hop
   * is dark until the cursor reaches it, holds for 'hold' hops, then decays over
   * 'overlap' hops, which is the knob that decides whether the discharge is a
   * single travelling spark or a whole lit chain.
   */
  float chainLit(float t) {
    float segs = max(uNodeCount - 1.0, 1.0);
    float x = clamp(t, 0.0, 1.0) * segs;
    float s = min(floor(x), segs - 1.0);
    float u = x - s;

    float d = gShape2.x - s;
    float hold = max(gShape2.y, 0.0);
    float over = max(gShape2.z, 1e-3);
    float tip = max(gShape2.w, 1e-3);

    float lum = step(0.0, d) * (1.0 - smoothstep(hold, hold + over, d));
    // Inside the hop the front is crossing, only the part behind it exists.
    float drawn = mix(smoothstep(d, d - tip, u), 1.0, step(1.0, d));
    return lum * drawn;
  }

  void main() {
    float t = position.x;
    float side = position.y;
    vSide = side;

    /* ---- which role is this filament wearing ---- */
    // The instance index is tested against the live counts, so a role retires
    // the instant its count hits zero and the rest close up behind it.
    gMode = uMode[0]; gFrom = uFrom[0]; gTo = uTo[0];
    gShape = uShape[0]; gShape2 = uShape2[0]; gStyle = uStyle[0];
    gEnds = uEnds[0]; gDraw = uDraw[0];

    float local = aStrand;
    float count = 1.0;
    float acc = 0.0;
    for (int i = 0; i < ROLES; i++) {
      float n = max(uCount[i], 0.0);
      if (aStrand >= acc && aStrand < acc + n) {
        local = aStrand - acc;
        count = max(n, 1.0);
        gMode = uMode[i]; gFrom = uFrom[i]; gTo = uTo[i];
        gShape = uShape[i]; gShape2 = uShape2[i]; gStyle = uStyle[i];
        gEnds = uEnds[i]; gDraw = uDraw[i];
      }
      acc += n;
    }
    // Half-open on purpose: 0 and 1 would put two filaments on the same bearing
    // for every mode that fans around a circle.
    gF = local / count;

    // The strike index snaps every filament onto a new shape uRestrike times a
    // second; the crawl inside kink() slides it continuously in between. Both
    // together are what stops a held filament looking like a static ribbon.
    float strike = floor(uTime * max(uRestrike, 0.01));
    gSeed = hash11(aStrand * 7.13 + uSeed + strike * 3.77) * 97.0;

    vDim = gStyle.z;
    vLit = gMode > 4.5 && gMode < 5.5 ? chainLit(t) : 1.0;

    /* ---- the frame the offsets live in ---- */
    float step_ = 0.02;
    vec3 here = pathAt(t);
    vec3 behind = pathAt(max(t - step_, 0.0));
    vec3 ahead = pathAt(min(t + step_, 1.0));

    vec3 tangent = ahead - behind;
    tangent = length(tangent) > 1e-5 ? normalize(tangent) : vec3(0.0, 1.0, 0.0);
    vec3 upRef = abs(tangent.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 n1 = normalize(cross(tangent, upRef));
    vec3 n2 = normalize(cross(tangent, n1));

    /* ---- the kinks ---- */
    float pinch = max(uPinch, 1e-3);
    // Only LINE has an end it may leave loose: a bolt that lands somewhere other
    // than where it was aimed reads as a bug, but converge < 1 lets a fracture
    // fray. Every other mode is pinched at both ends.
    float converge = gMode < 0.5 ? clamp(gShape2.z, 0.0, 1.0) : 1.0;
    float ends = smoothstep(0.0, pinch, t) * mix(1.0, smoothstep(0.0, pinch, 1.0 - t), converge);

    vec2 k = kink(t, gSeed, pathSpan()) * gStyle.x * uJitter * ends;
    vec3 offset = n1 * k.x + n2 * k.y;
    // Ground roles keep their kinks in the floor plane. A free y here buries
    // half of every tendril and the effect reads as a broken dotted line.
    offset.y *= gStyle.w;

    vec3 world = here + offset;
    vec3 nextWorld = ahead + offset;
    world.y = max(world.y, gDraw.z);
    nextWorld.y = max(nextWorld.y, gDraw.z);

    /* ---- how much of it exists yet ---- */
    // The ribbon is drawn whole and clipped in the fragment rather than scaled,
    // so the *shape* never changes as the front travels — only how much of it
    // is there. Roles that never travel sit at progress 2 and skip all of this.
    float tipLen = max(gDraw.y, 1e-3);
    vDrawn = smoothstep(gDraw.x, gDraw.x - tipLen, t);
    vTip = smoothstep(gDraw.x - tipLen * 2.0, gDraw.x, t) * gDraw.w;

    /* ---- turn the ribbon to face the camera ---- */
    vec3 tan2 = nextWorld - world;
    tan2 = length(tan2) > 1e-5 ? normalize(tan2) : tangent;
    vec3 toCamera = normalize(cameraPosition - world);
    vec3 binormal = cross(tan2, toCamera);
    float bl = length(binormal);
    binormal = bl > 1e-4 ? binormal / bl : n1;

    /* ---- width ---- */
    // A stuttering per-filament blink, quantised to uFlickerSpeed so the whole
    // bundle strobes on one clock instead of shimmering independently.
    float flash = mix(1.0, hash11(floor(uTime * uFlickerSpeed) + aStrand * 3.7 + uSeed), uStrandFlash);
    vFlash = flash;

    // One-sided tapers, so a filament pinned at the hand can keep its full
    // width there while the loose end still comes to a point.
    float taperS = pow(max(sin(min(t, 0.5) * PI), 0.0), 0.35);
    float taperE = pow(max(sin(max(t, 0.5) * PI), 0.0), 0.35);
    vEndFade = mix(1.0, taperS, gEnds.x) * mix(1.0, taperE, gEnds.y);

    float halfWidth = uWidth * uWidthScale * gStyle.y;
    halfWidth *= mix(1.0, taperS, gEnds.z) * mix(1.0, taperE, gEnds.w);
    halfWidth *= flash * uFade;

    // World space throughout: the ability's group is an identity transform, and
    // going through modelMatrix would only invite it to drift.
    // Opt-in to the disruption field (vfx/SceneHooks.js). One compare against a
    // uniform when nothing is disrupting, and the field is smooth over metres,
    // so sampling it here and interpolating costs one varying instead of a
    // world position and a distance in every fragment of the strip.
    vDisrupt = disruptAt(world);

    vec4 mv = viewMatrix * vec4(world + binormal * side * halfWidth, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const FILAMENT_FRAGMENT = /* glsl */ `
  ${disruptGLSL}
  varying float vDisrupt;

  uniform float uTime;
  uniform float uSeed;
  uniform float uCoreSharp;
  uniform float uGlowFalloff;
  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform float uPassOpacity;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFade;
  uniform float uSoftFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform vec3  uColorHalo;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying float vSide;
  varying float vDim;
  varying float vFlash;
  varying float vLit;
  varying float vDrawn;
  varying float vTip;
  varying float vEndFade;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    // Ahead of the front, and behind a hop that has not lit yet, there is no
    // filament at all.
    float presence = vDrawn * vLit;
    if (presence <= 0.002) discard;

    float v = clamp(abs(vSide), 0.0, 1.0);

    #ifdef FILAMENT_GLOW
      float profile = pow(1.0 - v, max(uGlowFalloff, 0.05));
      vec3 color = mix(uColorHalo, uColorOuter, profile);
      float alpha = profile;
    #else
      float profile = pow(1.0 - v, max(uCoreSharp, 0.05));
      vec3 color = mix(uColorOuter, uColorInner, smoothstep(0.0, 0.5, profile));
      color = mix(color, uColorCore, smoothstep(0.45, 1.0, profile));
      float alpha = profile;
    #endif

    // The leading edge is where the air is actually breaking down.
    color += uColorCore * vTip;

    // Quantised, not sinusoidal: real lightning stutters between brightnesses,
    // it does not breathe.
    float flicker = 1.0 - uFlicker * hash11(floor(uTime * uFlickerSpeed) + uSeed);

    // A loose end has to fade as well as thin. A ribbon that only narrows
    // leaves a hard dot at its tip.
    alpha *= vEndFade * presence * flicker * vFlash * vDim * uFade * uPassOpacity * uOpacity;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;
    disruptShade(color, alpha, vDisrupt, gl_FragCoord.xy);
    gl_FragColor = vec4(color, alpha);
  }
`;

/* ---------------------------------------------------------------------- */
/* One role slot                                                           */
/* ---------------------------------------------------------------------- */

/**
 * A handle onto one of the four role slots.
 *
 * Every setter is positional and writes straight into the uniform vectors —
 * there is no options object anywhere in here, because these are called every
 * frame and an object literal per call per role is exactly the allocation
 * invariant **I3** exists to forbid. The argument order of each mode method is
 * the order of the two `vec4`s it fills; the comments in the vertex shader are
 * the same list.
 */
class FilamentRole {
  constructor(uniforms, index) {
    this._u = uniforms;
    this.index = index;

    this._u.uMode.value[index] = PathMode.LINE;
    this._u.uCount.value[index] = 0;
    this.style(1, 1, 1, 1);
    this.ends(1, 1, 1, 1);
    this.draw(2, 0.08, -1e4, 0);
  }

  /** Live filaments in this role. 0 retires it outright. */
  get count() {
    return this._u.uCount.value[this.index];
  }

  set count(n) {
    this._u.uCount.value[this.index] = Math.max(0, Math.round(n));
  }

  /** Shorthand for `count = 0`. */
  retire() {
    this._u.uCount.value[this.index] = 0;
  }

  /**
   * Per-role modifiers on the shared look.
   *
   * @param {number} kink        multiplier on the shared `jitter`, unitless
   * @param {number} width       multiplier on the shared `width`, unitless
   * @param {number} dim         0..1 alpha multiplier — how secondary this role is
   * @param {number} groundDamp  0..1 on the kink's world y; 0.3 for anything flat
   */
  style(kink, width, dim, groundDamp) {
    this._u.uStyle.value[this.index].set(kink, width, dim, groundDamp);
    return this;
  }

  /**
   * How each end of the filament finishes, 0 (square) .. 1 (tapered to nothing).
   *
   * A bolt leaving a hand wants `ends(0, 1, 0, 1)`; a rim arc with two loose
   * ends wants the default `ends(1, 1, 1, 1)`.
   */
  ends(fadeStart, fadeEnd, taperStart, taperEnd) {
    this._u.uEnds.value[this.index].set(fadeStart, fadeEnd, taperStart, taperEnd);
    return this;
  }

  /**
   * The travelling front and the floor.
   *
   * @param {number} progress   0..1 of the path that exists; ≥ 1 + tip draws it whole
   * @param {number} tipLength  0..1 of the path the front is smeared over
   * @param {number} floorY     metres — the result is clamped above this; use -1e4 for none
   * @param {number} tipGlow    additive core colour at the front, unitless
   */
  draw(progress, tipLength, floorY, tipGlow) {
    this._u.uDraw.value[this.index].set(progress, tipLength, floorY, tipGlow);
    return this;
  }

  /* ---- the modes. Each one is its own uniform block. ---- */

  /**
   * `LINE` — the bolt. A straight axis bowed by `sag`, a fan opening downrange,
   * and the kinks on top.
   *
   * @param {THREE.Vector3} from  where it leaves, metres
   * @param {THREE.Vector3} to    where it lands, metres
   * @param {number} sag          metres of bow at mid-span; negative droops
   * @param {number} spreadNear   metres the bundle is fanned at `from`
   * @param {number} spread       metres it is fanned at `to`
   * @param {number} spreadCurve  how late the fan opens; >1 stays tight then flares
   * @param {number} twist        turns of roll from end to end
   * @param {number} twistSpeed   turns per second the whole fan rolls
   * @param {number} converge     0..1 — how hard the far end is pinned to `to`
   */
  line(from, to, sag, spreadNear, spread, spreadCurve, twist, twistSpeed, converge) {
    return this._set(PathMode.LINE, from, to, sag, spreadNear, spread, spreadCurve,
      twist, twistSpeed, converge, 0);
  }

  /**
   * `HELIX` — a coil wound around the axis between two points.
   *
   * @param {number} radius       metres at `from`
   * @param {number} radiusEnd    metres at `to`
   * @param {number} turns        full turns from end to end
   * @param {number} spin         turns per second the coil rotates
   * @param {number} sag          metres of bow at mid-span
   * @param {number} phaseSpread  how far the filaments are spread around the coil, 1 = evenly
   * @param {number} taperCurve   how late the radius reaches `radiusEnd`
   */
  helix(from, to, radius, radiusEnd, turns, spin, sag, phaseSpread, taperCurve) {
    return this._set(PathMode.HELIX, from, to, radius, radiusEnd, turns, spin,
      sag, phaseSpread, taperCurve, 0);
  }

  /**
   * `ORBIT` — great slow loops around a point, each on its own inclined plane.
   *
   * @param {THREE.Vector3} centre  the point being orbited, metres
   * @param {THREE.Vector3} pole    a point along the mean orbital axis, metres
   * @param {number} radius         metres
   * @param {number} arc            turns one filament covers; 0.4 is an open loop
   * @param {number} spin           turns per second the loops travel
   * @param {number} wobble         0..1 — how far from a clean circle
   * @param {number} tilt           radians the orbital plane is tipped by
   * @param {number} tiltSpread     radians of per-filament variation on that
   * @param {number} radiusJitter   ± fraction of `radius` per filament
   */
  orbit(centre, pole, radius, arc, spin, wobble, tilt, tiltSpread, radiusJitter) {
    return this._set(PathMode.ORBIT, centre, pole, radius, arc, spin, wobble,
      tilt, tiltSpread, radiusJitter, 0);
  }

  /**
   * `MEANDER` — a committed veer running out from a centre. The snare's tendril.
   *
   * @param {THREE.Vector3} centre  where it starts, metres
   * @param {THREE.Vector3} up      a point along the plane's normal (usually centre + up)
   * @param {number} inner          metres from the centre at t = 0
   * @param {number} reach          metres at t = 1
   * @param {number} curve          how late it covers the ground; <1 sprints out
   * @param {number} wander         radians of per-filament veer
   * @param {number} arch           metres it lifts at mid-span
   * @param {number} hug            metres it floats above the plane throughout
   * @param {number} spin           turns per second the whole crawl rotates
   */
  meander(centre, up, inner, reach, curve, wander, arch, hug, spin) {
    return this._set(PathMode.MEANDER, centre, up, inner, reach, curve, wander,
      arch, hug, spin, 0);
  }

  /**
   * `RIM` — an arc travelling around a boundary.
   *
   * @param {THREE.Vector3} centre  metres
   * @param {THREE.Vector3} up      a point along the plane's normal
   * @param {number} radius         metres
   * @param {number} span           turns one arc covers; 0.19 is a short hop
   * @param {number} speed          turns per second the arcs travel
   * @param {number} lift           metres it hops over the boundary at mid-span
   * @param {number} jitter         0..1 radial wobble
   * @param {number} hug            metres above the plane
   * @param {number} phase          turns of constant offset, for a second ring
   */
  rim(centre, up, radius, span, speed, lift, jitter, hug, phase) {
    return this._set(PathMode.RIM, centre, up, radius, span, speed, lift,
      jitter, hug, phase, 0);
  }

  /**
   * `CHAIN` — a polyline through the nodes set with `setNode()`.
   *
   * The lighting arguments are what `ArcNetwork` drives; a static chain passes
   * `lit` far past the node count and gets the whole thing.
   *
   * @param {THREE.Vector3} from  node 0, metres
   * @param {THREE.Vector3} to    the last node, metres
   * @param {number} scatter      metres the lateral fractions are scaled by
   * @param {number} lift         metres the lift fractions are scaled by
   * @param {number} sag          metres each hop bows downward at mid-hop
   * @param {number} bow          metres each hop bows sideways, alternating
   * @param {number} lit          the front, in hops
   * @param {number} hold         hops a lit segment stays at full
   * @param {number} overlap      hops it then decays over
   * @param {number} tip          how much of a hop the front is smeared over
   */
  chain(from, to, scatter, lift, sag, bow, lit, hold, overlap, tip) {
    return this._set(PathMode.CHAIN, from, to, scatter, lift, sag, bow,
      lit, hold, overlap, tip);
  }

  /**
   * `LINK` — a sagging catenary between two points.
   *
   * @param {number} slack       metres of droop at mid-span when fully slack
   * @param {number} curve       1 is rope, 3 is heavy chain, 0.01 is a parabola
   * @param {number} swing       metres of lateral sway
   * @param {number} swingSpeed  radians per second of that sway
   * @param {number} taut        0..1 — 1 pulls the sag out entirely
   * @param {number} spread      metres between parallel filaments
   */
  link(from, to, slack, curve, swing, swingSpeed, taut, spread) {
    return this._set(PathMode.LINK, from, to, slack, curve, swing, swingSpeed,
      taut, spread, 0, 0);
  }

  /**
   * `SPIRAL_IN` — a spiral collapsing from one radius to another as it travels.
   *
   * @param {THREE.Vector3} from  the wide end, metres
   * @param {THREE.Vector3} to    the point it spirals into, metres
   * @param {number} radius       metres at `from`
   * @param {number} radiusEnd    metres at `to`
   * @param {number} turns        full turns along the way
   * @param {number} spin         turns per second
   * @param {number} curve        how late the travel happens; >1 lingers wide
   * @param {number} phaseSpread  how far the filaments are spread around, 1 = evenly
   * @param {number} wobble       0..1 radial wobble
   */
  spiralIn(from, to, radius, radiusEnd, turns, spin, curve, phaseSpread, wobble) {
    return this._set(PathMode.SPIRAL_IN, from, to, radius, radiusEnd, turns, spin,
      curve, phaseSpread, wobble, 0);
  }

  /**
   * `CRACK` — a branching fracture, three generations deep.
   *
   * Filament 0 is always the trunk from `from` to `to`; the rest fork off it and
   * off each other, so the count is "how much fracture", not "how many lines".
   *
   * @param {number} angle          radians a branch leaves its parent by
   * @param {number} lengthFrac     branch length as a fraction of its parent's
   * @param {number} depthFalloff   extra shortening per generation
   * @param {number} spread         ± fraction of variation on `angle`
   * @param {number} start          0..1 — earliest point on a parent a fork may happen
   * @param {number} sag            metres of bow on each segment
   * @param {number} forkBias       0..1 — slides the branch/twig split
   */
  crack(from, to, angle, lengthFrac, depthFalloff, spread, start, sag, forkBias) {
    return this._set(PathMode.CRACK, from, to, angle, lengthFrac, depthFalloff, spread,
      start, sag, forkBias, 0);
  }

  /** @private Everything above funnels through here. */
  _set(mode, from, to, a, b, c, d, e, f, g, h) {
    const i = this.index;
    const u = this._u;
    u.uMode.value[i] = mode;
    u.uFrom.value[i].copy(from);
    u.uTo.value[i].copy(to);
    u.uShape.value[i].set(a, b, c, d);
    u.uShape2.value[i].set(e, f, g, h);
    return this;
  }
}

/* ---------------------------------------------------------------------- */
/* The system                                                              */
/* ---------------------------------------------------------------------- */

function fillVector(count, make) {
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = make();
  return out;
}

export class FilamentPaths {
  /**
   * @param {THREE.Object3D} parent  the ability's group
   * @param {object} [options]
   * @param {number} [options.samples=72]     nodes along one filament. The ceiling on
   *   how fine a kink can be: anything higher-frequency than one kink per two
   *   samples only aliases, so `jitterScale` above `samples / (2 × span)` stops
   *   adding detail and starts costing vertices.
   * @param {number} [options.capacity=48]    hard ceiling on filaments across all roles
   * @param {number} [options.renderOrder=11] halo draws here, core at +2
   * @param {number} [options.layer]          defaults to LAYER.VFX
   */
  constructor(parent, options = {}) {
    const samples = Math.max(2, Math.round(options.samples ?? 72));
    this.capacity = Math.max(1, Math.round(options.capacity ?? 48));

    this.geometry = createBoltRibbonGeometry(samples, this.capacity);
    this.geometry.instanceCount = 0;

    /**
     * Both passes share every uniform box except the two that define the pass
     * itself, by identity — the same trick `core/FrameUniforms.js` plays. One
     * write in `sync()` therefore updates the halo and the core together, and
     * there is no way for them to disagree about where a filament is.
     */
    const shared = {
      uSeed: { value: 0 },
      uRestrike: { value: 21 },
      uFade: { value: 1 },

      uMode: { value: new Float32Array(MAX_FILAMENT_ROLES) },
      uCount: { value: new Float32Array(MAX_FILAMENT_ROLES) },
      uFrom: { value: fillVector(MAX_FILAMENT_ROLES, () => new Vector3()) },
      uTo: { value: fillVector(MAX_FILAMENT_ROLES, () => new Vector3(0, 1, 0)) },
      uShape: { value: fillVector(MAX_FILAMENT_ROLES, () => new Vector4()) },
      uShape2: { value: fillVector(MAX_FILAMENT_ROLES, () => new Vector4()) },
      uStyle: { value: fillVector(MAX_FILAMENT_ROLES, () => new Vector4(1, 1, 1, 1)) },
      uEnds: { value: fillVector(MAX_FILAMENT_ROLES, () => new Vector4(1, 1, 1, 1)) },
      uDraw: { value: fillVector(MAX_FILAMENT_ROLES, () => new Vector4(2, 0.08, -1e4, 0)) },

      uNodes: { value: fillVector(MAX_CHAIN_NODES, () => new Vector4()) },
      uNodeCount: { value: 2 },

      uJitter: { value: 1 },
      uJitterScale: { value: 1.4 },
      uOctaves: { value: 4 },
      uJitterFalloff: { value: 0.55 },
      uCrawl: { value: 2.4 },
      uPinch: { value: 0.16 },
      uWidth: { value: 0.032 },
      uStrandFlash: { value: 0.45 },
      uFlickerSpeed: { value: 30 },
      uFlicker: { value: 0.26 },
      uCoreSharp: { value: 4.4 },
      uGlowFalloff: { value: 2.3 },
      uSoftFade: { value: 0.7 },
      uOpacity: { value: 1 },
      uGlow: { value: 2.2 },
      uColorCore: { value: new Color(1, 1, 1) },
      uColorInner: { value: new Color(0.86, 0.82, 1) },
      uColorOuter: { value: new Color(0.56, 0.42, 1) },
      uColorHalo: { value: new Color(0.16, 0.05, 0.55) }
    };
    this.uniforms = shared;

    this.group = new Group();
    this.group.name = 'FilamentPaths';
    this.group.matrixAutoUpdate = false;
    this.group.layers.set(options.layer ?? LAYER.VFX);

    this.materials = [];
    this.meshes = [];
    // Halo first so the core adds on top of it.
    for (const pass of [FilamentPass.GLOW, FilamentPass.CORE]) {
      const glow = pass === FilamentPass.GLOW;
      const material = new ShaderMaterial({
        defines: glow ? { FILAMENT_GLOW: '' } : {},
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: AdditiveBlending,
        side: DoubleSide,
        toneMapped: false,
        uniforms: sharedUniforms({
          ...shared,
          ...disruptUniforms(),
          uWidthScale: { value: glow ? 6.2 : 1 },
          uPassOpacity: { value: glow ? 0.44 : 1 }
        }),
        vertexShader: FILAMENT_VERTEX,
        fragmentShader: FILAMENT_FRAGMENT
      });

      const mesh = new Mesh(this.geometry, material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(options.layer ?? LAYER.VFX);
      mesh.renderOrder = (options.renderOrder ?? 11) + (glow ? 0 : 2);

      this.group.add(mesh);
      this.materials.push(material);
      this.meshes.push(mesh);
      if (glow) this.glowMaterial = material;
      else this.coreMaterial = material;
    }

    this.roles = fillVector(MAX_FILAMENT_ROLES, () => null);
    for (let i = 0; i < MAX_FILAMENT_ROLES; i++) this.roles[i] = new FilamentRole(shared, i);

    // Two nodes is the minimum chain: a straight hop from A to B.
    this.setNode(0, 0, 0, 0);
    this.setNode(1, 1, 0, 0);

    if (parent) parent.add(this.group);
  }

  /** The two meshes. Add this to the ability's group if you passed no parent. */
  get object3D() {
    return this.group;
  }

  /** Two. Four roles or one, forty filaments or three. */
  get drawCalls() {
    return this.meshes.length;
  }

  /** Filaments actually being drawn this frame, after the capacity clamp. */
  get liveCount() {
    return this.geometry.instanceCount;
  }

  set visible(v) {
    this.group.visible = v;
  }

  get visible() {
    return this.group.visible;
  }

  /** @param {number} i 0..MAX_FILAMENT_ROLES-1 */
  role(i) {
    return this.roles[i];
  }

  /** How many of the chain nodes are live. Clamped to `MAX_CHAIN_NODES`. */
  setNodeCount(n) {
    this.uniforms.uNodeCount.value = Math.max(2, Math.min(MAX_CHAIN_NODES, Math.round(n)));
    return this.uniforms.uNodeCount.value;
  }

  get nodeCount() {
    return this.uniforms.uNodeCount.value;
  }

  /**
   * One chain node, as **unitless fractions only** — the metres come from the
   * role's `scatter` and `lift` when the shader resolves it, which is what lets
   * a chain re-route under a slider mid-flight.
   *
   * @param {number} i        node index
   * @param {number} along    0..1 from the role's `from` to its `to`
   * @param {number} lateral  −1..1, scaled by the role's `scatter`
   * @param {number} lift     0..1, scaled by the role's `lift`
   */
  setNode(i, along, lateral, lift) {
    if (i < 0 || i >= MAX_CHAIN_NODES) return;
    this.uniforms.uNodes.value[i].set(along, lateral, lift, 0);
  }

  /**
   * Where node `i` of a `CHAIN` role actually is, in metres.
   *
   * This is the shader's `nodeWorld()` line for line, and it exists so the
   * burst an ability fires at a node lands *on* the node rather than near it.
   * Anything else — a second scatter formula on the CPU, a captured position —
   * drifts the moment a slider moves.
   *
   * @param {number} roleIndex
   * @param {number} i
   * @param {THREE.Vector3} out
   */
  nodePoint(roleIndex, i, out) {
    const u = this.uniforms;
    const from = u.uFrom.value[roleIndex];
    const to = u.uTo.value[roleIndex];
    const shape = u.uShape.value[roleIndex];
    const f = u.uNodes.value[Math.max(0, Math.min(MAX_CHAIN_NODES - 1, i))];

    _flat.set(to.x - from.x, 0, to.z - from.z);
    if (_flat.lengthSq() > 1e-8) {
      _dir.copy(_flat).normalize();
      _lat.crossVectors(_up, _dir).normalize();
    } else {
      _lat.set(1, 0, 0);
    }

    out.copy(from).lerp(to, f.x);
    out.addScaledVector(_lat, f.y * shape.x);
    out.y += f.z * shape.y;
    return out;
  }

  /**
   * Push the live look and the current cast state into both passes.
   *
   * Called every frame — including on a zero-length frame while the sandbox is
   * paused, which is what keeps every control below a live slider.
   *
   * @param {object} look   see `filamentLook()`; a settings block works directly
   * @param {number} [fade] 1 while lit, ramping to 0 as it blows out
   * @param {number} [seed] the cast's one captured dice roll
   */
  sync(look, fade = 1, seed = 0) {
    const u = this.uniforms;

    u.uFade.value = fade;
    u.uSeed.value = seed;
    u.uRestrike.value = look.restrike ?? 21;

    /* --- the counts, and the capacity clamp --- */
    // A role that overruns the capacity is truncated rather than wrapping into
    // the next role's index space, which would silently redraw it as the wrong
    // path. Roles earlier in the list win, so put the structural ones first.
    let total = 0;
    for (let i = 0; i < MAX_FILAMENT_ROLES; i++) {
      const want = u.uCount.value[i];
      const room = Math.max(0, this.capacity - total);
      const got = Math.min(want, room);
      u.uCount.value[i] = got;
      total += got;
    }
    this.geometry.instanceCount = total;

    /* --- the kinks. The one place the global noise multipliers bite. --- */
    const randomness = look.randomness ?? 1;
    u.uJitter.value = (look.jitter ?? 1) * randomness * (look.noiseStrength ?? 1);
    u.uJitterScale.value = (look.jitterScale ?? 1.4) * (look.noiseFrequency ?? 1);
    u.uOctaves.value = Math.round(look.octaves ?? 4);
    u.uJitterFalloff.value = look.jitterFalloff ?? 0.55;
    u.uCrawl.value = (look.crawl ?? 2.4) * (look.noiseSpeed ?? 1);
    u.uPinch.value = look.pinch ?? 0.16;

    /* --- the ribbon --- */
    u.uWidth.value = look.width ?? 0.032;
    // The only two uniforms the passes do not share.
    this.glowMaterial.uniforms.uWidthScale.value = look.glowWidth ?? 6.2;
    this.glowMaterial.uniforms.uPassOpacity.value = look.glowOpacity ?? 0.44;

    u.uStrandFlash.value = look.strandFlash ?? 0.45;
    u.uFlickerSpeed.value = look.flickerSpeed ?? 30;
    u.uFlicker.value = look.flicker ?? 0.26;
    u.uCoreSharp.value = look.coreSharp ?? 4.4;
    u.uGlowFalloff.value = look.glowFalloff ?? 2.3;
    u.uSoftFade.value = look.softFade ?? 0.7;

    u.uOpacity.value = (look.opacity ?? 1) * (look.opacityScale ?? 1);
    u.uGlow.value = (look.glow ?? 2.2) * (look.glowScale ?? 1);
    u.uColorCore.value.copy(getColor(look.colorCore ?? '#ffffff'));
    u.uColorInner.value.copy(getColor(look.colorInner ?? '#dcd2ff'));
    u.uColorOuter.value.copy(getColor(look.colorOuter ?? '#8f6bff'));
    u.uColorHalo.value.copy(getColor(look.colorHalo ?? '#290d8c'));
  }

  /**
   * Retire every role and stop drawing. This is what an ability's `onDestroy()`
   * calls — it leaves the instance reusable, unlike `dispose()`.
   */
  clear() {
    for (let i = 0; i < MAX_FILAMENT_ROLES; i++) this.uniforms.uCount.value[i] = 0;
    this.geometry.instanceCount = 0;
    this.uniforms.uFade.value = 0;
  }

  dispose() {
    this.geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.group.parent?.remove(this.group);
  }
}
