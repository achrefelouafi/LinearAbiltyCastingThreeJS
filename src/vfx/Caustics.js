import {
  AddEquation,
  Color,
  CustomBlending,
  DoubleSide,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { acquireGroundQuad, releaseGroundQuad } from './quads.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { getColor } from '../utils/color.js';

/* ---------------------------------------------------------------------- */
/* Caustics — the net of light a water surface throws on the floor         */
/* ---------------------------------------------------------------------- */

/**
 * An animated caustic net projected onto the ground.
 *
 * ## Why this is a module and not a decal
 *
 * A caustic is not a picture of a pattern. It is the *image of a refracting
 * surface*, and the only reason it is worth having in a sandbox with a floor is
 * that the pattern on the ground and the water above it are the same object
 * seen twice. `tiderush`'s whole trick is that you read the wave's thickness
 * off the floor ahead of it; if the floor is running its own unrelated loop of
 * squiggles, the two never agree and every viewer works it out in a second
 * without being able to say why.
 *
 * So the net here is computed from a **height field**, and the height field is
 * pluggable:
 *
 * | source | the height field |
 * | --- | --- |
 * | `SCROLL` | two counter-drifting worley lattices, differenced — the fallback |
 * | `WAVE`   | the Gerstner swell + breaking crest + ripple packets that `LiquidSurface` draws, with **the same uniform boxes**, shared by identity |
 * | `CUSTOM` | a GLSL chunk the caller supplies, defining `float causticHeight(vec2 xz)` |
 *
 * `bindSource(liquid.uniforms)` is the whole hook: it swaps our uniform boxes
 * for the surface's, so there is literally one set of numbers driving the wave
 * and the light under it. Drag `crestHeight` with the game paused and the wave
 * and its caustics move together, because there is nothing to keep in step.
 *
 * ## How the pattern is drawn, and the version that failed
 *
 * The received recipe for caustics is *the difference of two scrolling worley
 * fields, raised to a power*. The first version here did exactly that and it is
 * wrong in a way that is hard to unsee once noticed: raising a cell distance to
 * a power gives you **blobs with soft shoulders**, because a worley field is
 * smooth everywhere except at its cell walls. Real caustics are the opposite —
 * hairline-thin highlights an order of magnitude brighter than anything near
 * them, with genuinely black water between. You cannot get that falloff by
 * choosing a better exponent, because the thing being sharpened is the wrong
 * quantity.
 *
 * What is actually happening is a *fold*. Light entering the surface at `xz`
 * refracts and lands on the floor at
 *
 *     A(xz) = xz - k · D · ∇h(xz)          k = 1 - 1/ior,  D = depth in metres
 *
 * and the brightness at the arrival point is the reciprocal of how much that
 * map stretched the area it came from — `1 / |det J|`, `J = ∂A/∂xz`. Where the
 * map folds, `det J` passes through zero and the brightness goes to infinity:
 * that singular curve *is* the filament, and it is a curve, not a blob, which is
 * why it comes out thin without being told to be. Everywhere else `det J ≈ 1`
 * and the floor is dark. Both halves of the look fall out of one term.
 *
 *     J = I - k·D·H(h)                      H = the Hessian of the height field
 *     det J = (1 - a·hxx)(1 - a·hzz) - (a·hxz)²        a = k·D
 *
 * Six height taps give the Hessian by finite differences. That moves the worley
 * difference **one derivative earlier**: it is still what the `SCROLL` source's
 * height field is made of, but the folds of a worley-difference surface are the
 * sharp veins along its cell walls rather than the walls themselves. The direct
 * recipe is still there for `SCROLL` as `ridgeMix`, because at low depth the
 * fold term has nothing to fold and a little of the old mottle keeps the floor
 * from going empty — but it defaults low and it is not what you are looking at.
 *
 * ## Chromatic dispersion is free, and it is real
 *
 * Three channels refract at slightly different `ior`, so `a` differs per
 * channel, so the curve `det J = 0` sits in a *different place* for red than for
 * blue. The fringes are therefore spatially separated filaments, not a hue
 * gradient painted along one filament — which is the difference between water
 * and a decal with a rainbow on it. One extra `det` per channel, no extra taps.
 *
 * ## Depth
 *
 * The quad lies in the ground plane with the depth test on, so the character
 * occludes it. That is not enough on its own: a floor quad and the floor are
 * within millimetres of each other and a foot planted on the boundary gets a
 * hard bright line up its ankle. The fragment therefore also fades against
 * `frame.uSceneDepth` over `depthFade` metres, the same way `GroundField` does,
 * so the net dies out as it approaches anything standing on the floor instead
 * of climbing it.
 *
 * ## What it costs
 *
 * **One draw call**, no textures. It is *fill*-bound, not vertex-bound, and the
 * `SCROLL` source is the expensive one: six taps × two worley lattices × nine
 * cells is a hundred-odd hashes a pixel. Treat it like `LiquidSurface` — one per
 * screen, and keep `radius` honest, because the quad is sized from it.
 *
 * @example
 *   // construction — tiderush
 *   this.water = new LiquidSurface({ mode: LiquidMode.WAVE });
 *   this.group.add(this.water.object3D);
 *   this.net = new Caustics(this.group, {
 *     source: CausticSource.WAVE,
 *     shape:  CausticShape.LANE
 *   });
 *   this.net.bindSource(this.water.uniforms);   // ONE heightfield, two consumers
 *
 *   // module scope
 *   const _net = causticsParams();
 *
 *   // every frame
 *   _net.centre = this.origin;         // the same anchor the surface was placed at
 *   _net.yaw    = this.yaw;            // ...and the same yaw
 *   _net.depth  = c.causticDepth;      // metres of water over the floor
 *   _net.front  = this.travel;         // 0..1, the same front the wave is on
 *   this.net.update(_net);
 */

/** Where the refracting height field comes from. A `#define`, fixed at build. */
export const CausticSource = Object.freeze({
  SCROLL: 0,
  WAVE: 1,
  CUSTOM: 2
});

/** How the projector's own falloff shapes the net. Also a `#define`. */
export const CausticShape = Object.freeze({
  DISC: 0,
  CONE: 1,
  LANE: 2
});

/** Human names, for the editor and for `check.mjs` error messages. */
export const CAUSTIC_SOURCE_NAMES = Object.freeze(['SCROLL', 'WAVE', 'CUSTOM']);
export const CAUSTIC_SHAPE_NAMES = Object.freeze(['DISC', 'CONE', 'LANE']);

/**
 * Ripple packets carried by the `WAVE` source.
 *
 * **Not configurable.** It is eight because `LiquidSurface.RIPPLE_SLOTS` is
 * eight, and a bound `uRipples` array whose length disagrees with the array the
 * shader declared uploads garbage into the tail. If that constant ever moves,
 * this one moves with it in the same commit.
 */
export const CAUSTIC_RIPPLE_SLOTS = 8;

/**
 * The uniform boxes `bindSource()` is allowed to take over.
 *
 * Exactly the keys the `WAVE` height field reads, spelled the way
 * `LiquidSurface` spells them. Anything not in here stays ours — in particular
 * the projector, the fold and the colours, which belong to the light on the
 * floor and not to the water.
 */
export const CAUSTIC_BOUND_KEYS = Object.freeze([
  'uHalf',
  'uSeed',
  'uNow',
  'uWaveAmp',
  'uWaveLength',
  'uWaveSpeed',
  'uWaveAngle',
  'uChop',
  'uChopScale',
  'uChopSpeed',
  'uWaveFront',
  'uCrestHeight',
  'uCrestBack',
  'uCrestFace',
  'uCrestWidth',
  'uCrestFeather',
  'uCrestBreak',
  'uCrestBreakScale',
  'uRipples',
  'uRippleAmp',
  'uRippleSpeed',
  'uRippleLength',
  'uRippleWidth',
  'uRippleDecay',
  'uRippleSpread'
]);

/* ---------------------------------------------------------------------- */
/* The height fields                                                       */
/* ---------------------------------------------------------------------- */

/**
 * `SCROLL` — two counter-drifting worley lattices, differenced.
 *
 * The feature points *orbit* inside their cells rather than only sliding with
 * the domain. A lattice that only slides is a conveyor belt: the eye finds the
 * direction of travel in about a second and the whole thing reads as a texture
 * being dragged. Orbiting costs one `sin` per cell and the net boils in place,
 * which is what water on a floor does when nobody is throwing anything into it.
 */
const SCROLL_SOURCE = /* glsl */ `
  uniform float uSourceAmp;    // metres of relief in the fake surface
  uniform float uCellScale;    // cells per metre, lattice A
  uniform float uCellRatio;    // lattice B's scale, as a multiple of A
  uniform float uCellJitter;   // 0..1 how far a feature point wanders in its cell
  uniform vec2  uDrift;        // cells per second, lattice A (B goes the other way)
  uniform float uBoil;         // radians per second the feature points orbit
  uniform float uRidgeMix;     // 0..1 blend of the *direct* worley-difference net
  uniform float uRidgeScale;   // how wide a direct vein is, in field units
  uniform float uRidgePower;   // the exponent the received recipe asks for

  /** F1 distance to an animated feature-point lattice. */
  float causticCell(vec2 p, float phase, float jitter) {
    vec2 n = floor(p);
    vec2 f = fract(p);
    float best = 8.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 o = hash21(dot(n + g, vec2(7.13, 113.17)));
        o = 0.5 + jitter * 0.5 * sin(phase + 6.283185307 * o);
        vec2 r = g + o - f;
        best = min(best, dot(r, r));
      }
    }
    return sqrt(best);
  }

  float causticHeight(vec2 xz) {
    vec2 p = xz * uCellScale;
    vec2 drift = uDrift * uTime;
    float a = causticCell(p + drift, uTime * uBoil + uSeed, uCellJitter);
    float b = causticCell(p * uCellRatio - drift * 0.6, -uTime * uBoil * 0.83 + uSeed * 1.7, uCellJitter);
    return uSourceAmp * (a - b);
  }

  /**
   * The received recipe, kept so the fold term has something to sit on when
   * there is barely any water to fold light through. Zero at defaults + a bit.
   */
  float causticRidge(vec2 xz) {
    if (uRidgeMix <= 0.0) return 0.0;
    vec2 p = xz * uCellScale;
    vec2 drift = uDrift * uTime;
    float a = causticCell(p + drift, uTime * uBoil + uSeed, uCellJitter);
    float b = causticCell(p * uCellRatio - drift * 0.6, -uTime * uBoil * 0.83 + uSeed * 1.7, uCellJitter);
    float vein = clamp(1.0 - abs(a - b) * max(uRidgeScale, 0.01), 0.0, 1.0);
    return pow(vein, max(uRidgePower, 0.1)) * uRidgeMix;
  }
`;

/**
 * `WAVE` — the surface `LiquidSurface` is drawing, re-evaluated as a height
 * field.
 *
 * Every uniform below is spelled exactly as `LiquidSurface` spells it so that
 * `bindSource()` can hand this shader the *same boxes*. Two deliberate
 * omissions, both because a caustic needs `h(x, z)` and Gerstner does not give
 * you one:
 *
 * - the **horizontal** Gerstner throw (`uSteepness`) is dropped. Including it
 *   would mean inverting the surface's parametrisation at every one of six taps
 *   to find which material point is over this floor point. What is lost is a
 *   slight lateral lag of the net behind the crest at high steepness; what would
 *   be spent is six Newton iterations a tap.
 * - the crest's forward **curl** throw (`uCrestCurl`) is dropped for the same
 *   reason. The crest's *height* is fully present, and the height is what bends
 *   the light.
 *
 * The fragment-only `uDetail` chop is also absent, on purpose: it is a normal-map
 * wrinkle worth a few millimetres, and its second derivative is enormous. Feed
 * it in and the floor fills with a fizzing static of sub-pixel folds that
 * aliases the moment the camera moves.
 */
const WAVE_SOURCE = /* glsl */ `
  #define TAU 6.283185307179586

  uniform vec2  uHalf;          // half-extents of the surface, metres
  uniform float uNow;           // seconds since the cast began — the ripple clock

  uniform vec4  uWaveAmp;       // metres, one component per directional wave
  uniform vec4  uWaveLength;    // metres, crest to crest
  uniform vec4  uWaveSpeed;     // metres/second
  uniform vec4  uWaveAngle;     // radians, bearing in the surface plane

  uniform float uChop;          // metres
  uniform float uChopScale;     // cycles per metre
  uniform float uChopSpeed;     // metres/second the chop drifts

  uniform float uWaveFront;        // 0..1 along +X
  uniform float uCrestHeight;      // metres
  uniform float uCrestBack;        // metres — the long back slope's 1/e length
  uniform float uCrestFace;        // metres — the short front face's 1/e length
  uniform float uCrestWidth;       // 0..1 of the half-extent across the wave
  uniform float uCrestFeather;     // 0..1 of that, over which the ends die
  uniform float uCrestBreak;       // 0..1 how ragged the lip is
  uniform float uCrestBreakScale;  // cycles per metre along the lip

  uniform vec4  uRipples[${CAUSTIC_RIPPLE_SLOTS}];  // (u, v, born, strength)
  uniform float uRippleAmp;
  uniform float uRippleSpeed;
  uniform float uRippleLength;
  uniform float uRippleWidth;
  uniform float uRippleDecay;
  uniform float uRippleSpread;

  float causticWave(vec2 xz, float amp, float len, float spd, float ang) {
    if (amp <= 0.0) return 0.0;
    vec2 d = vec2(cos(ang), sin(ang));
    float k = TAU / max(len, 0.05);
    return amp * sin(dot(d, xz) * k - uTime * spd * k);
  }

  float causticCrest(vec2 xz) {
    if (uCrestHeight <= 0.0) return 0.0;
    float front = (uWaveFront - 0.5) * uHalf.x * 2.0;
    float s = xz.x - front;
    float prof = s < 0.0
      ? exp(s / max(uCrestBack, 0.02))
      : exp(-s / max(uCrestFace, 0.01));
    float rag = fbm3(vec3(xz.y * uCrestBreakScale, uSeed, uNow * 0.6)) * 0.5 + 0.5;
    prof *= mix(1.0, rag, clamp(uCrestBreak, 0.0, 1.0));
    float a = abs(xz.y) / max(uHalf.y, 1e-3);
    float w = clamp(uCrestWidth, 0.0, 1.0);
    float lateral = 1.0 - smoothstep(max(w - max(uCrestFeather, 1e-3), 0.0), w, a);
    return uCrestHeight * prof * lateral;
  }

  float causticRipples(vec2 xz) {
    float sum = 0.0;
    for (int i = 0; i < ${CAUSTIC_RIPPLE_SLOTS}; i++) {
      vec4 r = uRipples[i];
      if (r.w <= 0.0) continue;
      float age = uNow - r.z;
      if (age < 0.0) continue;
      vec2 c = r.xy * uHalf;
      float d = length(xz - c);
      float x = d - age * uRippleSpeed;
      float env = exp(-(x * x) / max(uRippleWidth * uRippleWidth, 1e-4));
      float decay = exp(-age / max(uRippleDecay, 0.02)) / (1.0 + d / max(uRippleSpread, 0.05));
      sum += r.w * uRippleAmp * env * decay * cos(x * TAU / max(uRippleLength, 0.05));
    }
    return sum;
  }

  float causticHeight(vec2 xz) {
    float h = 0.0;
    h += causticWave(xz, uWaveAmp.x, uWaveLength.x, uWaveSpeed.x, uWaveAngle.x);
    h += causticWave(xz, uWaveAmp.y, uWaveLength.y, uWaveSpeed.y, uWaveAngle.y);
    h += causticWave(xz, uWaveAmp.z, uWaveLength.z, uWaveSpeed.z, uWaveAngle.z);
    h += causticWave(xz, uWaveAmp.w, uWaveLength.w, uWaveSpeed.w, uWaveAngle.w);
    if (uChop > 0.0) h += uChop * fbm3(vec3(xz * uChopScale, uTime * uChopSpeed + uSeed));
    h += causticRipples(xz);
    h += causticCrest(xz);
    return h;
  }

  float causticRidge(vec2 xz) { return 0.0; }
`;

/* ---------------------------------------------------------------------- */
/* Shaders                                                                 */
/* ---------------------------------------------------------------------- */

const CAUSTIC_VERTEX = /* glsl */ `
  varying vec2  vUv;
  varying vec3  vWorld;
  varying float vViewZ;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vec4 mv = viewMatrix * world;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * The fragment is assembled per instance because the `CUSTOM` source replaces a
 * whole block of it. A single `const` with `#if`s cannot do that: the caller's
 * chunk is a string that does not exist until construction.
 */
function causticFragment(source, custom) {
  const field =
    source === CausticSource.WAVE
      ? WAVE_SOURCE
      : source === CausticSource.CUSTOM
        ? custom
        : SCROLL_SOURCE;

  return /* glsl */ `
  #define CS_DISC 0
  #define CS_CONE 1
  #define CS_LANE 2

  uniform float uTime;
  uniform float uSeed;

  /* ---- placement, in metres ---- */
  uniform vec2  uQuadSize;     // metres the quad covers: x across, y downrange
  uniform vec3  uAnchor;       // world position of the quad's centre
  uniform vec3  uLightAxis;    // unit, the direction the light TRAVELS (downward)
  uniform float uRadius;       // metres — the projector's own reach
  uniform float uLength;       // metres — LANE only

  /* ---- refraction ---- */
  uniform float uDepth;        // metres of water between the surface and the floor
  uniform float uBend;         // 1 - 1/ior, resolved on the CPU from the ior slider
  uniform float uDispersion;   // 0..1 fractional spread of uBend across R and B
  uniform float uStep;         // metres between the Hessian taps
  uniform float uAbsorb;       // 1/metres — Beer extinction through the water column

  /* ---- the fold, and how hard it is squeezed ---- */
  uniform float uFoldFloor;    // keeps 1/|det| finite; also the widest a filament gets
  uniform float uThreshold;    // compression below this is flat water, and black
  uniform float uGain;
  uniform float uSharpness;    // exponent on the surviving compression
  uniform float uRolloff;      // soft clip, so a fold does not detonate the bloom

  /* ---- the projector ---- */
  uniform float uPenumbra;     // 0..1 of the reach, over which the edge dies
  uniform float uConeAngle;    // radians, half-angle (CONE)
  uniform float uProjHeight;   // metres up the axis to the apex (CONE)
  uniform float uLaneWidth;    // metres, half-width (LANE)
  uniform float uLaneFeather;  // metres (LANE)
  uniform float uFront;        // 0..1 down the lane, the wave's own front
  uniform float uSpanBack;     // metres behind the front the net survives
  uniform float uSpanFront;    // metres ahead of it

  /* ---- output ---- */
  uniform float uFade;
  uniform float uOpacity;
  uniform float uEmissive;
  uniform float uWash;         // the lit-pool light BETWEEN the filaments
  uniform float uFringeAt;     // where on the fold the colour hands over
  uniform vec3  uColorNet;
  uniform vec3  uColorFringe;
  uniform vec3  uColorWash;

  /* ---- depth ---- */
  uniform sampler2D uSceneDepth;
  uniform vec2      uResolution;
  uniform float     uCameraNear;
  uniform float     uCameraFar;
  uniform float     uDepthFade;   // metres
  uniform float     uGlobalGlow;
  uniform float     uShaderIntensity;

  varying vec2  vUv;
  varying vec3  vWorld;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  /* ---- the pluggable height field ---- */
  ${field}

  /**
   * How much the refraction map compresses area here, per channel.
   *
   * 'a' is the only thing that differs between the three: red bends least, blue
   * most, so each channel folds along its own curve and the fringes are three
   * filaments a few centimetres apart rather than one filament with a gradient
   * painted along it.
   */
  float causticDet(float a, float hxx, float hzz, float hxz) {
    float jxx = 1.0 - a * hxx;
    float jzz = 1.0 - a * hzz;
    float jxz = a * hxz;
    return jxx * jzz - jxz * jxz;
  }

  /** Compression to light. Everything under the threshold is water, and black. */
  float causticFold(float det) {
    float comp = 1.0 / (abs(det) + max(uFoldFloor, 1e-3));
    float lit = max(comp - uThreshold, 0.0) * uGain;
    lit = pow(lit, max(uSharpness, 0.05));
    return lit / (1.0 + lit * max(uRolloff, 0.0));
  }

  /** The projector's own falloff. Never derived from the pattern. */
  float causticEnvelope(vec2 lp) {
    float pen = clamp(uPenumbra, 0.02, 1.0);

    #if CS_SHAPE == CS_CONE
      // The apex sits up the light's own axis, so a low sun gives an ellipse on
      // the floor for free — which is the entire reason the axis is a parameter
      // and not hard-wired to +Y.
      vec3 apex = uAnchor - uLightAxis * uProjHeight;
      vec3 d = vWorld - apex;
      float len = max(length(d), 1e-4);
      float c = dot(d / len, uLightAxis);
      float ci = cos(clamp(uConeAngle, 0.0, 1.5));
      float co = cos(clamp(uConeAngle, 0.0, 1.5) * (1.0 + pen));
      return smoothstep(co, ci, c);
    #elif CS_SHAPE == CS_LANE
      float across = 1.0 - smoothstep(max(uLaneWidth - uLaneFeather, 0.0),
                                      uLaneWidth + uLaneFeather, abs(lp.x));
      float front = uFront * uLength;
      float feather = max(uLaneFeather, 0.02);
      float behind = smoothstep(front - uSpanBack - feather, front - uSpanBack, lp.y);
      float ahead = 1.0 - smoothstep(front + uSpanFront, front + uSpanFront + feather, lp.y);
      return across * behind * ahead;
    #else
      float r = length(lp) / max(uRadius, 1e-3);
      return 1.0 - smoothstep(1.0 - pen, 1.0, r);
    #endif
  }

  void main() {
    vec2 lp = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;

    float env = causticEnvelope(lp);
    if (env <= 0.0015) discard;

    /* ---- six taps, one Hessian ---- */
    float s = max(uStep, 0.005);
    float inv = 1.0 / (s * s);
    float h0 = causticHeight(lp);
    float hpx = causticHeight(lp + vec2(s, 0.0));
    float hmx = causticHeight(lp - vec2(s, 0.0));
    float hpz = causticHeight(lp + vec2(0.0, s));
    float hmz = causticHeight(lp - vec2(0.0, s));
    float hd = causticHeight(lp + vec2(s, s));

    float hxx = (hpx - 2.0 * h0 + hmx) * inv;
    float hzz = (hpz - 2.0 * h0 + hmz) * inv;
    // The mixed partial needs the diagonal tap. Drop it and every fold that is
    // not aligned with the quad's own axes disappears, which shows up as a net
    // made of plus signs.
    float hxz = (hd - hpx - hpz + h0) * inv;

    float a = uBend * uDepth;
    float spread = clamp(uDispersion, 0.0, 1.0);
    vec3 lit = vec3(
      causticFold(causticDet(a * (1.0 - spread), hxx, hzz, hxz)),
      causticFold(causticDet(a, hxx, hzz, hxz)),
      causticFold(causticDet(a * (1.0 + spread), hxx, hzz, hxz))
    );

    lit += vec3(causticRidge(lp));

    /* ---- the water above is not clear ----
     * Thicker column, dimmer floor. This is the term that lets you read the
     * wave's body off the ground: the net dims under the crest and flares in
     * the thin water on its face, with no extra input beyond the height field
     * that is already here. */
    float column = max(uDepth + h0, 0.0);
    lit *= exp(-max(uAbsorb, 0.0) * column);

    float strength = uFade * uOpacity * uEmissive * uShaderIntensity;
    float peak = max(max(lit.r, lit.g), lit.b);
    vec3 tint = mix(uColorNet, uColorFringe, clamp(peak * uFringeAt, 0.0, 1.0));
    vec3 rgb = tint * lit + uColorWash * (uWash * env);

    rgb *= env * strength;

    /* ---- do not paint the character ----
     * The depth test already loses the argument on the millimetre between this
     * quad and the floor it is lying on, so the fade does the last of it: the
     * net dies over uDepthFade metres as anything standing on the floor comes
     * between it and the camera. */
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    float depthBits = unpackRGBAToDepth(texture2D(uSceneDepth, screenUV));
    float sceneViewZ = perspectiveDepthToViewZ(depthBits, uCameraNear, uCameraFar);
    rgb *= smoothstep(-max(uDepthFade, 1e-3), 0.0, vViewZ - sceneViewZ);

    float alpha = clamp(max(max(rgb.r, rgb.g), rgb.b), 0.0, 1.0);
    if (alpha < 0.003) discard;

    gl_FragColor = vec4(rgb * uGlobalGlow, alpha);
  }
`;
}

/* ---------------------------------------------------------------------- */
/* Params                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * Every canonical key with its default and its unit.
 *
 * Hold one of these at module scope, fill it from `settings[id]` every frame,
 * and hand it to `update()`. Nothing here is remembered between calls.
 */
export function causticsParams() {
  return {
    /* --- where it is (the ability's own vectors; never copied out) --- */
    centre: null, // Vector3 on the floor — the quad's centre
    lightAxis: null, // Vector3, unit, the direction light TRAVELS. Default straight down
    yaw: 0, // radians about +Y; local +Z is downrange
    height: 0.015, // metres above the floor the quad sits at
    radius: 6, // metres — the projector's reach. DISC/CONE cap, quad sizing
    length: 18, // metres — LANE only, how far downrange the lane runs

    /* --- the beats (unitless; the ability's clock resolves them) --- */
    fade: 1, // 0..1 master fade
    front: 0.5, // 0..1 LANE: where the wave's front is
    now: 0, // seconds since the cast began — a timestamp, not a dimension
    seed: 0, // decorrelates two casts. A dice roll, safe to capture

    /* --- refraction --- */
    depth: 1.4, // metres of water between the surface and the floor
    ior: 1.333, // water. The shader gets 1 - 1/ior
    dispersion: 0.06, // 0..1 how far R and B sit either side of G
    sampleStep: 0.09, // metres between the Hessian taps — the net's finest detail
    absorb: 0.18, // 1/metres, Beer extinction down the water column

    /* --- the fold --- */
    foldFloor: 0.22, // keeps 1/|det| finite; the widest a filament can get
    threshold: 1.15, // compression under this is flat water, and black
    gain: 0.55,
    sharpness: 1.35, // exponent on the surviving compression
    rolloff: 0.22, // soft clip on the peak

    /* --- SCROLL only --- */
    sourceAmp: 0.16, // metres of relief in the fake surface
    cellScale: 0.55, // cells per metre
    cellRatio: 1.63, // second lattice's scale, as a multiple of the first
    cellJitter: 0.85, // 0..1 how far a feature point wanders in its cell
    driftAngle: 0.7, // radians, the bearing the lattice drifts on
    driftSpeed: 0.12, // cells per second
    boil: 0.9, // radians per second the feature points orbit
    ridgeMix: 0.12, // 0..1 of the direct worley-difference net
    ridgeScale: 2.2, // how tight a direct vein is
    ridgePower: 6, // the exponent the received recipe asks for

    /* --- WAVE only, and all of it overridden by bindSource() --- */
    half: 8, // metres, half-extent of the surface (both axes)
    waveAmp: 0.16, // metres — the swell, applied to all four components
    waveLength: 5.5, // metres
    waveSpeed: 1.6, // metres/second
    waveAngle: 0.4, // radians
    chop: 0.05, // metres
    chopScale: 0.55, // cycles per metre
    chopSpeed: 0.3, // metres/second
    waveFront: 0.5, // 0..1 along the surface's +X
    crestHeight: 1.1, // metres
    crestBack: 3.2, // metres
    crestFace: 0.5, // metres
    crestWidth: 0.8, // 0..1
    crestFeather: 0.25, // 0..1
    crestBreak: 0.35, // 0..1
    crestBreakScale: 0.6, // cycles per metre
    rippleAmp: 0.12, // metres
    rippleSpeed: 3.2, // metres/second
    rippleLength: 1.1, // metres
    rippleWidth: 0.7, // metres
    rippleDecay: 1.4, // seconds
    rippleSpread: 3, // metres

    /* --- the projector --- */
    penumbra: 0.35, // 0..1 of the reach, over which the edge dies
    coneAngle: 0.45, // radians, half-angle (CONE)
    projectorHeight: 5, // metres up the axis to the apex (CONE)
    laneWidth: 2.6, // metres, half-width (LANE)
    laneFeather: 0.9, // metres (LANE)
    spanBack: 2, // metres behind the front the net survives (LANE)
    spanFront: 7, // metres ahead of it (LANE)

    /* --- output --- */
    additive: true, // caustics are light; false shades instead, for oil and ink
    emissive: 1,
    opacity: 1,
    wash: 0.18, // the lit pool between the filaments
    fringeAt: 1.6, // where on the fold the colour hands over to the fringe
    depthFade: 0.45, // metres of soft fade against standing geometry
    colorNet: '#9fe6ff', // the filaments
    colorFringe: '#ffffff', // the very top of a fold
    colorWash: '#2a6d86', // the general light in the pool

    /* --- global multipliers (settings.global.*, 1 = neutral) --- */
    noiseStrength: 1,
    noiseFrequency: 1,
    noiseSpeed: 1,
    opacityScale: 1
  };
}

/* ---------------------------------------------------------------------- */
/* Scratch — module scope, per invariant I3                                */
/* ---------------------------------------------------------------------- */

const _axis = new Vector3(0, -1, 0);

/* ---------------------------------------------------------------------- */
/* The module                                                              */
/* ---------------------------------------------------------------------- */

export class Caustics {
  /**
   * @param {THREE.Object3D} parent the ability's group
   * @param {object} [options]
   * @param {number} [options.source=CausticSource.SCROLL] a `#define`, fixed for the lifetime
   * @param {number} [options.shape=CausticShape.DISC]     ditto
   * @param {string} [options.custom]  GLSL for `CausticSource.CUSTOM`. Must define
   *                                   `float causticHeight(vec2 xz)` and
   *                                   `float causticRidge(vec2 xz)`, and may declare
   *                                   its own uniforms — pass their boxes in `uniforms`
   * @param {object} [options.uniforms] extra uniform boxes merged in, shared by identity
   * @param {boolean} [options.additive=true] initial blend; `params.additive` drives it after
   * @param {boolean} [options.depthTest=true]
   * @param {number} [options.layer=LAYER.VFX]
   * @param {number} [options.renderOrder=7]
   * @param {string} [options.name]
   */
  constructor(parent, options = {}) {
    const {
      source = CausticSource.SCROLL,
      shape = CausticShape.DISC,
      custom = '',
      uniforms = null,
      additive = true,
      depthTest = true,
      layer = LAYER.VFX,
      renderOrder = 7,
      name = null
    } = options;

    if (source === CausticSource.CUSTOM && !custom) {
      throw new Error(
        'Caustics: CausticSource.CUSTOM needs options.custom — a GLSL chunk defining ' +
          'float causticHeight(vec2 xz) and float causticRidge(vec2 xz)'
      );
    }

    this.parent = parent;
    this.source = source;
    this.shape = shape;
    this.geometry = acquireGroundQuad();

    /**
     * Which uniform boxes now belong to somebody else.
     *
     * `update()` consults this before writing: a bound key is the surface's to
     * drive, and writing it here would mean two authors for one number and a
     * one-frame flicker whichever way you look at it.
     */
    this._bound = new Set();

    /** Ripple packets, for the standalone case. Bound away by `bindSource()`. */
    this._ripples = [];
    for (let i = 0; i < CAUSTIC_RIPPLE_SLOTS; i++) this._ripples.push(new Vector4(0, 0, -1e4, 0));
    this._rippleNext = 0;

    this.material = new ShaderMaterial({
      defines: {
        CS_SOURCE: source,
        CS_SHAPE: shape
      },
      transparent: true,
      depthWrite: false,
      depthTest,
      // Premultiplied, the way `Portal` and `Curtain` are, so one pass can add
      // light or lay a darkening over the floor with no change but the
      // destination factor. `AdditiveBlending` was the first version and it is
      // wrong here: it is (SrcAlpha, One), so it multiplies the colour by an
      // alpha that is *derived from the colour*, squaring everything dim. A
      // caustic is nine-tenths dim.
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: additive ? OneFactor : OneMinusSrcAlphaFactor,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uQuadSize: { value: new Vector2(12, 12) },
        uAnchor: { value: new Vector3() },
        uLightAxis: { value: new Vector3(0, -1, 0) },
        uRadius: { value: 6 },
        uLength: { value: 18 },
        uSeed: { value: 0 },
        uNow: { value: 0 },

        uDepth: { value: 1.4 },
        uBend: { value: 1 - 1 / 1.333 },
        uDispersion: { value: 0.06 },
        uStep: { value: 0.09 },
        uAbsorb: { value: 0.18 },

        uFoldFloor: { value: 0.22 },
        uThreshold: { value: 1.15 },
        uGain: { value: 0.55 },
        uSharpness: { value: 1.35 },
        uRolloff: { value: 0.22 },

        /* SCROLL */
        uSourceAmp: { value: 0.16 },
        uCellScale: { value: 0.55 },
        uCellRatio: { value: 1.63 },
        uCellJitter: { value: 0.85 },
        uDrift: { value: new Vector2(0.08, 0.09) },
        uBoil: { value: 0.9 },
        uRidgeMix: { value: 0.12 },
        uRidgeScale: { value: 2.2 },
        uRidgePower: { value: 6 },

        /* WAVE — the bindable set */
        uHalf: { value: new Vector2(8, 8) },
        uWaveAmp: { value: new Vector4(0.16, 0.11, 0.07, 0.04) },
        uWaveLength: { value: new Vector4(5.5, 3.1, 1.9, 1.1) },
        uWaveSpeed: { value: new Vector4(1.6, 1.2, 0.9, 0.7) },
        uWaveAngle: { value: new Vector4(0.4, 1.1, 2.2, 3.4) },
        uChop: { value: 0.05 },
        uChopScale: { value: 0.55 },
        uChopSpeed: { value: 0.3 },
        uWaveFront: { value: 0.5 },
        uCrestHeight: { value: 1.1 },
        uCrestBack: { value: 3.2 },
        uCrestFace: { value: 0.5 },
        uCrestWidth: { value: 0.8 },
        uCrestFeather: { value: 0.25 },
        uCrestBreak: { value: 0.35 },
        uCrestBreakScale: { value: 0.6 },
        uRipples: { value: this._ripples },
        uRippleAmp: { value: 0.12 },
        uRippleSpeed: { value: 3.2 },
        uRippleLength: { value: 1.1 },
        uRippleWidth: { value: 0.7 },
        uRippleDecay: { value: 1.4 },
        uRippleSpread: { value: 3 },

        /* the projector */
        uPenumbra: { value: 0.35 },
        uConeAngle: { value: 0.45 },
        uProjHeight: { value: 5 },
        uLaneWidth: { value: 2.6 },
        uLaneFeather: { value: 0.9 },
        uFront: { value: 0.5 },
        uSpanBack: { value: 2 },
        uSpanFront: { value: 7 },

        /* output */
        uFade: { value: 1 },
        uOpacity: { value: 1 },
        uEmissive: { value: 1 },
        uWash: { value: 0.18 },
        uFringeAt: { value: 1.6 },
        uDepthFade: { value: 0.45 },
        uColorNet: { value: new Color(0.62, 0.9, 1) },
        uColorFringe: { value: new Color(1, 1, 1) },
        uColorWash: { value: new Color(0.16, 0.43, 0.53) },

        ...(uniforms ?? {})
      }),
      vertexShader: CAUSTIC_VERTEX,
      fragmentShader: causticFragment(source, custom)
    });

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name =
      name ?? `Caustics:${CAUSTIC_SOURCE_NAMES[source] ?? source}/${CAUSTIC_SHAPE_NAMES[shape] ?? shape}`;
    this.mesh.layers.set(layer);
    this.mesh.renderOrder = renderOrder;
    this.mesh.frustumCulled = false;
    this._additive = additive;

    parent?.add(this.mesh);
  }

  get object3D() {
    return this.mesh;
  }

  /** One. Always one. */
  get drawCalls() {
    return 1;
  }

  /** How many uniform boxes a driver has taken over. 0 means procedural. */
  get boundCount() {
    return this._bound.size;
  }

  setVisible(visible) {
    this.mesh.visible = visible;
  }

  /**
   * Take the refracting surface's own uniform boxes, by identity.
   *
   * This is the hook the whole module exists for. `LiquidSurface#uniforms` is
   * public and every key in `CAUSTIC_BOUND_KEYS` is spelled the same in both
   * files, so after one call the wave and the light under it are reading the
   * *same numbers* — not two copies kept in step by an ability remembering to
   * copy them, which is the version that drifts the first time somebody adds a
   * slider to one block and not the other.
   *
   * Everything bound is then skipped by `update()`, because a number with two
   * authors has none.
   *
   * @param {object} uniforms the driver's uniform map — `liquid.uniforms`
   * @param {string[]} [keys=CAUSTIC_BOUND_KEYS] narrow it if you only want some
   * @returns {number} how many boxes were taken
   */
  bindSource(uniforms, keys = CAUSTIC_BOUND_KEYS) {
    if (!uniforms) return 0;
    const mine = this.material.uniforms;
    for (const key of keys) {
      const box = uniforms[key];
      if (!box || typeof box !== 'object' || !('value' in box)) continue;
      if (!(key in mine)) continue;
      mine[key] = box;
      this._bound.add(key);
    }
    // three rebuilds its uniform list from `material.uniforms` lazily and reads
    // each box by key at upload time, so a swap after the first render is seen.
    // Do it at construction anyway: it is one less thing that is true only on
    // this version.
    this.material.uniformsNeedUpdate = true;
    return this._bound.size;
  }

  /** Hand the boxes back. Part of the pooling contract if an ability rebinds. */
  unbindSource() {
    if (!this._bound.size) return;
    const mine = this.material.uniforms;
    if (this._bound.has('uRipples')) mine.uRipples = { value: this._ripples };
    for (const key of this._bound) {
      if (key === 'uRipples') continue;
      const box = mine[key];
      // Re-box, so a later write here cannot reach into the old driver.
      mine[key] = { value: box?.value?.clone ? box.value.clone() : box?.value };
    }
    this._bound.clear();
    this.material.uniformsNeedUpdate = true;
  }

  /**
   * Ring the standalone surface — a droplet, a footfall, a focused point.
   *
   * `u`/`v` are **fractions of `half`**, never metres, for the same reason
   * `GroundField#mark()` takes fractions: a packet posted at 0.5 stays halfway
   * out when the surface is resized with the clock stopped.
   *
   * No-op once `uRipples` is bound — the driver owns the packet list then, and
   * `LiquidSurface#ripple()` is the call you want.
   */
  ripple(u, v, strength = 1, now = 0) {
    if (this._bound.has('uRipples')) return null;
    const slot = this._ripples[this._rippleNext];
    slot.set(u, v, now, strength);
    this._rippleNext = (this._rippleNext + 1) % CAUSTIC_RIPPLE_SLOTS;
    return slot;
  }

  /** Forget every packet. `onSpawn()` calls this; `onDestroy()` should too. */
  clearRipples() {
    if (this._bound.has('uRipples')) return;
    for (let i = 0; i < CAUSTIC_RIPPLE_SLOTS; i++) this._ripples[i].set(0, 0, -1e4, 0);
    this._rippleNext = 0;
  }

  /** Leaves the instance reusable — the other half of the pooling contract. */
  reset() {
    this.clearRipples();
    this.mesh.visible = true;
  }

  /**
   * Re-resolve everything from the live params and place the quad.
   *
   * There is no clock argument on purpose: `GroundField` has none either, and
   * for the same reason — every beat arrives as a unitless `0..1` on `p`, and
   * the animation clock is `frame.uTime`, which the shader reads itself. The one
   * timestamp the module needs, `p.now`, is the ripple epoch and is a timestamp
   * rather than a duration.
   *
   * Allocation-free, and correct on a zero-length frame.
   *
   * @param {object} p live params — see `causticsParams()`
   */
  update(p) {
    const u = this.material.uniforms;
    const bound = this._bound;

    const nf = p.noiseFrequency ?? 1;
    const ns = p.noiseStrength ?? 1;
    const nsp = p.noiseSpeed ?? 1;

    const radius = Math.max(0.05, p.radius ?? 6);
    const length = Math.max(0.2, p.length ?? 18);

    u.uRadius.value = radius;
    u.uLength.value = length;
    if (!bound.has('uSeed')) u.uSeed.value = p.seed ?? 0;
    if (!bound.has('uNow')) u.uNow.value = p.now ?? 0;

    /* ---- refraction ---- */
    // 1 - 1/ior is the small-angle bend coefficient. Resolved here rather than
    // in the shader because it is one divide a frame instead of one a tap.
    const ior = Math.max(1.0001, p.ior ?? 1.333);
    u.uDepth.value = Math.max(0, p.depth ?? 1.4);
    u.uBend.value = 1 - 1 / ior;
    u.uDispersion.value = Math.max(0, Math.min(1, p.dispersion ?? 0.06));
    u.uStep.value = Math.max(0.005, (p.sampleStep ?? 0.09) / Math.max(nf, 0.05));
    u.uAbsorb.value = Math.max(0, p.absorb ?? 0.18);

    /* ---- the fold ---- */
    u.uFoldFloor.value = Math.max(0.001, p.foldFloor ?? 0.22);
    u.uThreshold.value = Math.max(0, p.threshold ?? 1.15);
    u.uGain.value = Math.max(0, p.gain ?? 0.55);
    u.uSharpness.value = Math.max(0.05, p.sharpness ?? 1.35);
    u.uRolloff.value = Math.max(0, p.rolloff ?? 0.22);

    /* ---- SCROLL ---- */
    u.uSourceAmp.value = (p.sourceAmp ?? 0.16) * ns;
    u.uCellScale.value = Math.max(0.01, (p.cellScale ?? 0.55) * nf);
    u.uCellRatio.value = Math.max(0.05, p.cellRatio ?? 1.63);
    u.uCellJitter.value = Math.max(0, Math.min(1, p.cellJitter ?? 0.85));
    const driftAngle = p.driftAngle ?? 0.7;
    const driftSpeed = (p.driftSpeed ?? 0.12) * nsp;
    u.uDrift.value.set(Math.cos(driftAngle) * driftSpeed, Math.sin(driftAngle) * driftSpeed);
    u.uBoil.value = (p.boil ?? 0.9) * nsp;
    u.uRidgeMix.value = Math.max(0, p.ridgeMix ?? 0.12);
    u.uRidgeScale.value = Math.max(0.01, p.ridgeScale ?? 2.2);
    u.uRidgePower.value = Math.max(0.1, p.ridgePower ?? 6);

    /* ---- WAVE: only what nobody else is driving ---- */
    if (this.source === CausticSource.WAVE && bound.size < CAUSTIC_BOUND_KEYS.length) {
      const half = Math.max(0.2, p.half ?? 8);
      if (!bound.has('uHalf')) u.uHalf.value.set(half, half);
      if (!bound.has('uWaveAmp')) {
        // One slider for the swell, split across four components on a fixed
        // decay. An ability that wants four amplitudes binds a surface instead.
        const amp = (p.waveAmp ?? 0.16) * ns;
        u.uWaveAmp.value.set(amp, amp * 0.68, amp * 0.44, amp * 0.26);
      }
      if (!bound.has('uWaveLength')) {
        const len = Math.max(0.05, p.waveLength ?? 5.5);
        u.uWaveLength.value.set(len, len * 0.56, len * 0.35, len * 0.2);
      }
      if (!bound.has('uWaveSpeed')) {
        const spd = (p.waveSpeed ?? 1.6) * nsp;
        u.uWaveSpeed.value.set(spd, spd * 0.75, spd * 0.56, spd * 0.44);
      }
      if (!bound.has('uWaveAngle')) {
        const ang = p.waveAngle ?? 0.4;
        u.uWaveAngle.value.set(ang, ang + 0.7, ang + 1.8, ang + 3.0);
      }
      if (!bound.has('uChop')) u.uChop.value = (p.chop ?? 0.05) * ns;
      if (!bound.has('uChopScale')) u.uChopScale.value = Math.max(0.01, (p.chopScale ?? 0.55) * nf);
      if (!bound.has('uChopSpeed')) u.uChopSpeed.value = (p.chopSpeed ?? 0.3) * nsp;
      if (!bound.has('uWaveFront')) u.uWaveFront.value = p.waveFront ?? 0.5;
      if (!bound.has('uCrestHeight')) u.uCrestHeight.value = Math.max(0, p.crestHeight ?? 1.1);
      if (!bound.has('uCrestBack')) u.uCrestBack.value = Math.max(0.02, p.crestBack ?? 3.2);
      if (!bound.has('uCrestFace')) u.uCrestFace.value = Math.max(0.01, p.crestFace ?? 0.5);
      if (!bound.has('uCrestWidth')) u.uCrestWidth.value = Math.max(0, Math.min(1, p.crestWidth ?? 0.8));
      if (!bound.has('uCrestFeather')) u.uCrestFeather.value = Math.max(0.001, p.crestFeather ?? 0.25);
      if (!bound.has('uCrestBreak')) u.uCrestBreak.value = Math.max(0, Math.min(1, p.crestBreak ?? 0.35));
      if (!bound.has('uCrestBreakScale')) {
        u.uCrestBreakScale.value = Math.max(0.01, (p.crestBreakScale ?? 0.6) * nf);
      }
      if (!bound.has('uRippleAmp')) u.uRippleAmp.value = (p.rippleAmp ?? 0.12) * ns;
      if (!bound.has('uRippleSpeed')) u.uRippleSpeed.value = Math.max(0.01, (p.rippleSpeed ?? 3.2) * nsp);
      if (!bound.has('uRippleLength')) u.uRippleLength.value = Math.max(0.05, p.rippleLength ?? 1.1);
      if (!bound.has('uRippleWidth')) u.uRippleWidth.value = Math.max(0.02, p.rippleWidth ?? 0.7);
      if (!bound.has('uRippleDecay')) u.uRippleDecay.value = Math.max(0.02, p.rippleDecay ?? 1.4);
      if (!bound.has('uRippleSpread')) u.uRippleSpread.value = Math.max(0.05, p.rippleSpread ?? 3);
    }

    /* ---- the projector ---- */
    const penumbra = Math.max(0.02, Math.min(1, p.penumbra ?? 0.35));
    const coneAngle = Math.max(0.01, Math.min(1.5, p.coneAngle ?? 0.45));
    const projHeight = Math.max(0.05, p.projectorHeight ?? 5);
    const laneWidth = Math.max(0.05, p.laneWidth ?? 2.6);
    const laneFeather = Math.max(0.02, p.laneFeather ?? 0.9);
    const spanBack = Math.max(0, p.spanBack ?? 2);
    const spanFront = Math.max(0, p.spanFront ?? 7);

    u.uPenumbra.value = penumbra;
    u.uConeAngle.value = coneAngle;
    u.uProjHeight.value = projHeight;
    u.uLaneWidth.value = laneWidth;
    u.uLaneFeather.value = laneFeather;
    u.uFront.value = Math.max(0, Math.min(1, p.front ?? 0.5));
    u.uSpanBack.value = spanBack;
    u.uSpanFront.value = spanFront;

    /* ---- output ---- */
    u.uFade.value = p.fade ?? 1;
    u.uOpacity.value = (p.opacity ?? 1) * (p.opacityScale ?? 1);
    u.uEmissive.value = p.emissive ?? 1;
    u.uWash.value = Math.max(0, p.wash ?? 0.18);
    u.uFringeAt.value = Math.max(0, p.fringeAt ?? 1.6);
    u.uDepthFade.value = Math.max(0.001, p.depthFade ?? 0.45);
    u.uColorNet.value.copy(getColor(p.colorNet ?? '#9fe6ff'));
    u.uColorFringe.value.copy(getColor(p.colorFringe ?? '#ffffff'));
    u.uColorWash.value.copy(getColor(p.colorWash ?? '#2a6d86'));

    this.setAdditive(p.additive ?? true);

    /* ---- the axis the projector points down ---- */
    if (p.lightAxis) {
      _axis.copy(p.lightAxis);
      if (_axis.lengthSq() < 1e-8) _axis.set(0, -1, 0);
      _axis.normalize();
    } else {
      _axis.set(0, -1, 0);
    }
    u.uLightAxis.value.copy(_axis);

    /* ---- the quad ----
     * Re-derived every frame, so dragging `radius` or `coneAngle` grows the
     * canvas along with the drawing on it. A quad sized once at spawn is the
     * exact failure this whole library is built to avoid. */
    let across;
    let down;
    if (this.shape === CausticShape.LANE) {
      across = (laneWidth + laneFeather) * 2 + 0.4;
      down = length + spanFront + spanBack + laneFeather * 2 + 0.4;
    } else if (this.shape === CausticShape.CONE) {
      // The apex sits up the axis, so a slanted axis walks the footprint
      // sideways as well as widening it. Both are covered, conservatively.
      const drop = Math.max(0.2, Math.abs(_axis.y));
      const reach = projHeight * Math.tan(coneAngle) * (1 + penumbra);
      const slide = projHeight * Math.hypot(_axis.x, _axis.z) / drop;
      across = (Math.max(radius, reach + slide) + 0.4) * 2;
      down = across;
    } else {
      across = (radius + 0.4) * 2;
      down = across;
    }

    u.uQuadSize.value.set(across, down);
    this.mesh.scale.set(across, 1, down);

    const yaw = p.yaw ?? 0;
    const centre = p.centre;
    const height = p.height ?? 0.015;
    if (centre) {
      this.mesh.position.set(centre.x, centre.y + height, centre.z);
      u.uAnchor.value.set(centre.x, centre.y + height, centre.z);
    } else {
      this.mesh.position.y = height;
      u.uAnchor.value.copy(this.mesh.position);
    }
    this.mesh.rotation.set(0, yaw, 0);
  }

  /**
   * Light on the floor, or a shading of it. Free to change per frame.
   *
   * Only the destination factor moves, so this does **not** set
   * `needsUpdate` — blend state is not compiled into the program and marking the
   * material dirty every frame would rebuild the shader on any ability that
   * drives `additive` from a slider.
   */
  setAdditive(additive) {
    if (additive === this._additive) return;
    this._additive = additive;
    this.material.blendDst = additive ? OneFactor : OneMinusSrcAlphaFactor;
  }

  dispose() {
    this.parent?.remove(this.mesh);
    this.material.dispose();
    releaseGroundQuad();
    this.geometry = null;
  }
}
