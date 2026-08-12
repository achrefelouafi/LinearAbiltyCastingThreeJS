import {
  Color,
  DoubleSide,
  FrontSide,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Sphere,
  Vector2,
  Vector3,
  Vector4
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms, frame } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { copyColor } from '../utils/color.js';

/* ------------------------------------------------------------------------ */
/* LiquidSurface — a heightfield that knows how fast it is moving            */
/* ------------------------------------------------------------------------ */
/**
 * A live liquid heightfield: lava, blood, water.
 *
 * The archived `OceanWaterMaterial` raymarched a *body* of water because a
 * thrown stream has no top and bottom — it is a tube in the air. A pool is the
 * opposite problem. It has exactly one surface, gravity has already decided
 * where that surface is, and everything the eye reads off it is a property of
 * that one sheet: its slope, how fast it is sliding, and what it reflects. So
 * this is a real subdivided plane with a displaced vertex shader, and it costs
 * a fortieth of what the march did.
 *
 * Four things make it more than a wobbling plane.
 *
 * **1 — Surface speed is a real quantity.** Everything interesting about molten
 * rock is a function of how fast the skin is travelling, so the shader computes
 * an honest 2-D flow field in metres per second at every fragment:
 *
 *   - a bulk drift (`flowAngle` / `flowSpeed`) — the pour;
 *   - a radial outflow that dies off with distance (`flowRadial`) — the fount;
 *   - eddies taken as the **curl of a scalar noise field**, so they swirl
 *     without any point of the surface acting as a source or a sink. Sampling
 *     two independent noises as `(nx, nz)` instead — the obvious thing — gives a
 *     field with divergence, and a divergent flow map makes the crust pile up in
 *     some places and tear open in others for no reason the picture can explain;
 *   - **downhill gravity**, taken straight off the shading normal. Lava runs
 *     down slopes, so `flowGravity` adds `n.xz / n.y` metres per second of it.
 *
 * That last term is the one that pays for itself. A ripple arriving from an
 * impact steepens the local slope; the slope feeds the flow; the flow speeds
 * the surface past `crustBreak`; and the black skin *cracks open along the
 * ripple front and glows*, then heals behind it. Nothing in the code says
 * "crack when hit" — the coupling is real, and that is why it reads.
 *
 * **2 — The crust is a flow map, not a texture.** Coverage is
 * `1 − smoothstep(crustForm, crustBreak, speed)`: skin where the surface is
 * slow, bare melt where it is fast. The crack pattern is the zero-crossing of an
 * fbm evaluated in a frame **built from the flow direction** and squashed along
 * it by `crackStretch`, so the seams run *with* the flow the way pahoehoe does
 * rather than in isotropic blobs. It is advected by the flow using the two-phase
 * cross-fade (sample at `fract(t/T)` and `fract(t/T + 0.5)`, weight by
 * `|1 − 2·fract(t/T)|`): a single advected layer would smear without bound after
 * a few seconds, which is exactly the failure that makes hand-rolled flow maps
 * look like melting plastic.
 *
 * The honest limitation, stated once: a fragment cannot remember when it was
 * last moving fast, so "the crust re-forms where it is slow" is instantaneous in
 * space and only lagged in time by the global `crustFormTime` ramp. Real skin
 * has hysteresis. Fixing it needs a ping-pong buffer, which is a texture, which
 * is **I2**.
 *
 * **3 — Ripples are analytic and unitless.** `ripple(u, v, strength)` writes one
 * slot of a small ring buffer holding *a position fraction, a timestamp and a
 * strength* — no metres, per **I1**. The shader turns the fraction into metres
 * against the live half-extents every frame, so dragging `sizeX` moves standing
 * ripples with the pool. Each is a gaussian-enveloped cosine packet riding out at
 * `rippleSpeed`, decaying as `e^{−age/rippleDecay}` and spreading as
 * `1/(1 + r/rippleSpread)`. No integrator, so a paused pool still re-rings under
 * the sliders.
 *
 * **4 — WAVE mode curls.** The travelling crest is a profile in metres from a
 * front at `waveFront` (a 0..1 fraction of the plane, driven by the ability): a
 * long exponential back and a short exponential face. The overhang is Gerstner's
 * trick pushed hard — the horizontal displacement is proportional to the *height*
 * (`crestCurl · h`), so the material at the top of the crest is thrown further
 * forward than the material at its foot and the sheet genuinely folds over
 * itself. Where it has folded, `vFace` is high: the shader thins the alpha there
 * and adds a backlight term, which is what makes the front face of a breaking
 * wave read as lit from inside. `lipPosition()` hands the ability the world point
 * of that lip so it can emit droplets from it.
 *
 * ## Cost
 *
 * **One draw call**, `segments²·2` triangles, no textures. It is *fill*-heavy,
 * not vertex-heavy: the shading normal is four evaluations of the whole
 * heightfield, and the crust adds a flow field and two advected fbm phases on
 * top. Both of the expensive blocks are behind `if (uCrust > 0.001)` style
 * gates, so water and blood pay for neither. Do not stack two of these over the
 * same pixels, and keep `sizeX`/`sizeZ` honest — a pool the size of the stage is
 * a full-screen shader.
 *
 * ## Invariants
 *
 * - **I1** — holds no dimension whatsoever. `update(now, p)` re-resolves every
 *   metre and second from `p`; the ripple records hold fractions and timestamps.
 * - **I2** — waves are sines, chop is fbm, the crust is a noise zero-crossing,
 *   the reflection is `frame.uEnvMap` sampled equirectangularly the way
 *   `IceMaterial` reflects the probe and `GlacierMaterial` samples it by hand.
 * - **I3** — `update()` writes into existing uniform boxes and into `Vector4`s
 *   that were allocated at construction. Nothing in the frame path allocates.
 * - **I5** — eight colour pickers, none derived from another.
 */

/* ---------------------------------------------------------------- */
/* Enums                                                             */
/* ---------------------------------------------------------------- */

export const LiquidMode = Object.freeze({
  /** A standing pool: swell, chop and ripples only. */
  POOL: 0,
  /** POOL plus one travelling crest that curls, thins and breaks. */
  WAVE: 1
});

/**
 * Ripple slots. Eight is not arbitrary: the packet is evaluated five times per
 * fragment (once for shading, four times for the finite-difference normal), so
 * every slot costs five length()s and five exponentials whether or not it is
 * live. Eight simultaneous impacts is more than any ability in the roster
 * throws, and `ripple()` recycles the oldest slot rather than dropping the
 * newest — a dropped *newest* is the one the player was looking at.
 */
const RIPPLE_SLOTS = 8;

/* ---------------------------------------------------------------- */
/* The field — injected into both shaders so they agree exactly      */
/* ---------------------------------------------------------------- */
/**
 * The vertex shader and the fragment shader must evaluate *the same* height
 * function or the lighting will not sit on the silhouette. So it is written
 * once, here, uniform declarations and all, and pasted into both stages.
 *
 * The one asymmetry is deliberate and is the same split the ocean material
 * documents: the `detail` argument scales an octave far finer than the vertex
 * grid can resolve. The vertex passes 0 (displacing by something smaller than a
 * quad is aliasing, not detail); the fragment passes 1, because in the *normal*
 * that same octave is the difference between a wobbling sheet and a surface.
 */
const LIQUID_FIELD = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  /** Seconds since the ability's cast began — the ripple clock. */
  uniform float uNow;
  /** Half-extents of the sheet in metres. Ripple fractions resolve against it. */
  uniform vec2  uHalf;
  uniform float uSeed;
  uniform int   uMode;

  /* --- the swell: four independent directional waves --- */
  uniform vec4  uWaveAmp;      // metres, one component per wave
  uniform vec4  uWaveLength;   // metres, crest to crest
  uniform vec4  uWaveSpeed;    // metres/second
  uniform vec4  uWaveAngle;    // radians, bearing in the surface plane
  uniform float uSteepness;    // 0 = sine, 1 = Gerstner cusps

  /* --- chop --- */
  uniform float uChop;         // metres
  uniform float uChopScale;    // cycles per metre
  uniform float uChopSpeed;    // metres/second the chop drifts
  uniform float uDetail;       // metres — fragment-only, lives in the normal
  uniform float uDetailScale;  // cycles per metre
  uniform float uDetailSpeed;  // metres/second

  /* --- ripples: (u, v, born, strength). Unitless + a timestamp. I1. --- */
  uniform vec4  uRipples[${RIPPLE_SLOTS}];
  uniform float uRippleAmp;     // metres at strength 1
  uniform float uRippleSpeed;   // metres/second the front travels
  uniform float uRippleLength;  // metres, crest to crest inside the packet
  uniform float uRippleWidth;   // metres, the packet's gaussian envelope
  uniform float uRippleDecay;   // seconds to 1/e
  uniform float uRippleSpread;  // metres over which it also thins with radius

  /* --- the travelling wave (WAVE mode) --- */
  uniform float uWaveFront;     // 0..1 along +X. The ability drives this.
  uniform float uCrestHeight;   // metres
  uniform float uCrestBack;     // metres — the long back slope's 1/e length
  uniform float uCrestFace;     // metres — the short front face's 1/e length
  uniform float uCrestCurl;     // metres of forward throw per metre of height
  uniform float uCrestWidth;    // 0..1 of the half-extent across the wave
  uniform float uCrestFeather;  // 0..1 of that, over which the ends die
  uniform float uCrestBreak;    // 0..1 how ragged the lip is
  uniform float uCrestBreakScale; // cycles per metre along the lip

  /** 0 at the trailing edge of the sheet, 2*uHalf.x at the leading edge. */
  float crestFrontX() { return (uWaveFront - 0.5) * uHalf.x * 2.0; }

  /** How much of the crest survives this far off the wave's centreline. */
  float crestLateral(float z) {
    float a = abs(z) / max(uHalf.y, 1e-3);
    float w = clamp(uCrestWidth, 0.0, 1.0);
    return 1.0 - smoothstep(max(w - max(uCrestFeather, 1e-3), 0.0), w, a);
  }

  /**
   * The crest's height in metres.
   *
   * Two exponentials meeting at 1 where they join, so the profile is continuous
   * at the front and the *asymmetry* is entirely 'uCrestBack' against
   * 'uCrestFace'. A symmetric bump is a swell; a bump with a face an eighth as
   * long as its back is a wave about to break, and that ratio does more for the
   * silhouette than any amount of noise on top of it.
   */
  float crestHeightAt(vec2 xz) {
    if (uMode == 0) return 0.0;
    float s = xz.x - crestFrontX();
    float prof = s < 0.0
      ? exp(s / max(uCrestBack, 0.02))
      : exp(-s / max(uCrestFace, 0.01));
    // The lip breaks unevenly along its length. Sampled on z alone, so a gap is
    // a gap for the whole depth of the wave rather than a dent in its middle.
    float rag = fbm3(vec3(xz.y * uCrestBreakScale, uSeed, uNow * 0.6)) * 0.5 + 0.5;
    prof *= mix(1.0, rag, clamp(uCrestBreak, 0.0, 1.0));
    return uCrestHeight * prof * crestLateral(xz.y);
  }

  /**
   * 0..1: how much this point is on the *front face* of the crest.
   *
   * 'ahead' climbs with distance past the front while the profile falls, so the
   * product peaks in the thin overhanging lip and is zero both on the back slope
   * and out in the flat water. It is the mask for every translucency term.
   */
  float crestFaceAt(vec2 xz) {
    if (uMode == 0) return 0.0;
    float s = xz.x - crestFrontX();
    float ahead = smoothstep(0.0, max(uCrestFace, 0.01) * 1.5, s);
    float h = crestHeightAt(xz) / max(uCrestHeight, 1e-3);
    return clamp(ahead * h * 2.2, 0.0, 1.0);
  }

  /**
   * One directional wave, accumulated in place.
   *
   * The horizontal term is Gerstner's: pulling material *toward* the crest
   * sharpens it and flattens the trough, which is what an ocean does and what a
   * plain sine cannot do at any amplitude. It is also why 'uSteepness' above ~1
   * folds the mesh through itself — capped in 'update()', not here, so the
   * shader stays a shader.
   */
  void addWave(inout vec3 acc, vec2 xz, float amp, float len, float spd, float ang) {
    if (amp <= 0.0) return;
    vec2 d = vec2(cos(ang), sin(ang));
    float k = TAU / max(len, 0.05);
    float phase = dot(d, xz) * k - uTime * spd * k;
    acc.y += amp * sin(phase);
    acc.xz -= d * (amp * uSteepness * cos(phase));
  }

  /**
   * Every live ripple, summed.
   *
   * Analytic, not integrated: a packet's whole history is a closed-form function
   * of 'uNow - born', so the surface can be re-rung from a slider with the clock
   * stopped. The '1/(1 + r/spread)' term is the geometric thinning of a circular
   * wave (energy over a growing circumference); the exponential is the viscous
   * loss. Both are needed — with only the exponential a small pool's ripples die
   * in the middle, with only the spread they never die at all.
   */
  float ripplesAt(vec2 xz) {
    float sum = 0.0;
    for (int i = 0; i < ${RIPPLE_SLOTS}; i++) {
      vec4 r = uRipples[i];
      if (r.w <= 0.0) continue;
      float age = uNow - r.z;
      if (age < 0.0) continue;
      // The fraction becomes metres HERE, against this frame's half-extents.
      vec2 c = r.xy * uHalf;
      float d = length(xz - c);
      float x = d - age * uRippleSpeed;
      float env = exp(-(x * x) / max(uRippleWidth * uRippleWidth, 1e-4));
      float decay = exp(-age / max(uRippleDecay, 0.02)) / (1.0 + d / max(uRippleSpread, 0.05));
      sum += r.w * uRippleAmp * env * decay * cos(x * TAU / max(uRippleLength, 0.05));
    }
    return sum;
  }

  /**
   * The surface's displacement from the flat plane, in surface-local metres.
   *
   * @param xz     parametric position on the sheet, metres from its centre
   * @param detail 0 in the vertex stage, 1 in the fragment stage
   * @returns (dx, dy, dz) — dy is height, dx/dz are the Gerstner and curl throws
   */
  vec3 liquidOffset(vec2 xz, float detail) {
    vec3 acc = vec3(0.0);

    addWave(acc, xz, uWaveAmp.x, uWaveLength.x, uWaveSpeed.x, uWaveAngle.x);
    addWave(acc, xz, uWaveAmp.y, uWaveLength.y, uWaveSpeed.y, uWaveAngle.y);
    addWave(acc, xz, uWaveAmp.z, uWaveLength.z, uWaveSpeed.z, uWaveAngle.z);
    addWave(acc, xz, uWaveAmp.w, uWaveLength.w, uWaveSpeed.w, uWaveAngle.w);

    if (uChop > 0.0) {
      acc.y += uChop * fbm3(vec3(xz * uChopScale, uTime * uChopSpeed + uSeed));
    }
    if (detail > 0.0 && uDetail > 0.0) {
      acc.y += uDetail * detail *
               snoise(vec3(xz * uDetailScale, uTime * uDetailSpeed + uSeed * 3.1));
    }

    acc.y += ripplesAt(xz);

    // The curl. Horizontal throw proportional to height is what turns a bump
    // into an overhang: the crest's own material outruns its foot.
    float ch = crestHeightAt(xz);
    acc.y += ch;
    acc.x += ch * uCrestCurl;

    return acc;
  }

  /** The surface point in local space — parametric position plus its offset. */
  vec3 liquidPoint(vec2 xz, float detail) {
    vec3 d = liquidOffset(xz, detail);
    return vec3(xz.x + d.x, d.y, xz.y + d.z);
  }
`;

/* ---------------------------------------------------------------- */
/* Vertex                                                            */
/* ---------------------------------------------------------------- */

const LIQUID_VERTEX = /* glsl */ `
  uniform vec3 uAnchor;   // world centre of the sheet
  uniform vec3 uAxisX;    // the sheet's local +X, unit — the "along" of a WAVE
  uniform vec3 uAxisY;    // the sheet's up, unit
  uniform vec3 uAxisZ;    // the sheet's local +Z, unit

  varying vec2  vParam;   // parametric metres from the centre, pre-displacement
  varying vec3  vWorld;
  varying float vHeight;  // metres above the mean plane
  varying float vFace;    // 0..1 on the crest's front face
  varying float vViewZ;

  ${noiseGLSL}
  ${LIQUID_FIELD}

  void main() {
    // The plane geometry is a unit square; every metre comes from uHalf, which
    // is rewritten every frame. Resizing the pool never touches a buffer.
    vec2 xz = (uv - 0.5) * (uHalf * 2.0);
    vParam = xz;

    vec3 local = liquidPoint(xz, 0.0);
    vHeight = local.y;
    vFace = crestFaceAt(xz);

    vec3 world = uAnchor + uAxisX * local.x + uAxisY * local.y + uAxisZ * local.z;
    vWorld = world;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/* ---------------------------------------------------------------- */
/* Fragment                                                          */
/* ---------------------------------------------------------------- */

const LIQUID_FRAGMENT = /* glsl */ `
  uniform vec3      uAxisX;
  uniform vec3      uAxisY;
  uniform vec3      uAxisZ;
  uniform sampler2D uEnvMap;
  uniform vec3      uLightDir;      // world direction TOWARD the key light
  uniform float     uGlobalGlow;
  uniform float     uShaderIntensity;
  uniform vec2      uResolution;
  uniform sampler2D uSceneDepth;
  uniform float     uCameraNear;
  uniform float     uCameraFar;

  /* --- the edge of the pool --- */
  uniform float uFill;        // 0..1 of the half-extent the liquid reaches
  uniform float uRound;       // 0 rectangular footprint, 1 elliptical
  uniform float uEdgeSoft;    // 0..1 of the field over which it fades out
  uniform float uEdgeNoise;   // 0..1 how ragged the waterline is
  uniform float uEdgeScale;   // cycles per metre of that raggedness

  /* --- the flow field, metres/second --- */
  uniform float uFlowAngle;      // radians, the bulk drift's bearing
  uniform float uFlowSpeed;      // m/s
  uniform float uFlowRadial;     // m/s outward at the centre
  uniform float uFlowRadialFall; // metres to 1/e
  uniform float uFlowEddy;       // m/s of curl-noise swirl
  uniform float uFlowEddyScale;  // cycles per metre
  uniform float uFlowEddySpeed;  // Hz the eddies churn
  uniform float uFlowGravity;    // m/s per unit of surface slope

  /* --- the crust --- */
  uniform float uCrust;        // 0..1 master. 0 skips the whole block.
  uniform float uCrustForm;    // m/s below which skin is unbroken
  uniform float uCrustBreak;   // m/s above which there is none
  uniform float uCrustFormTime;// seconds for the first skin to appear
  uniform float uCrackScale;   // cycles per metre across the flow
  uniform float uCrackStretch; // how many times longer features are along it
  uniform float uCrackWidth;   // 0..1 of the field — the seam's width
  uniform float uCrustAdvect;  // 0..1 how strongly the pattern is carried
  uniform float uCrustPeriod;  // seconds before the flow map resets
  uniform float uCrustBump;    // 0..1 how much the skin roughens the normal
  uniform float uSeamGlow;
  uniform float uMeltGlow;     // glow of the bare melt between the plates

  /* --- foam --- */
  uniform float uFoam;         // 0..1 master
  uniform float uFoamScale;    // cycles per metre of the speckle
  uniform float uFoamSharp;
  uniform float uFoamCrest;    // how much a rising crest seeds it
  uniform float uFoamSpeed;    // how much surface speed seeds it

  /* --- shading --- */
  uniform vec3  uColorDeep;
  uniform vec3  uColorShallow;
  uniform vec3  uColorCrust;
  uniform vec3  uColorSeam;
  uniform vec3  uColorHot;
  uniform vec3  uColorFoam;
  uniform vec3  uColorSpec;
  uniform vec3  uColorSky;
  uniform float uPoolDepth;    // metres of liquid under the mean plane
  uniform float uDepthTint;    // Beer-Lambert density, per metre
  uniform float uTranslucency; // backlight through the thin lip
  uniform float uAmbient;
  uniform float uSpecular;
  uniform float uShininess;
  uniform float uFresnel;
  uniform float uEnvIntensity;
  uniform float uSkyIntensity;
  uniform float uEmissive;     // self-lit body — lava reads at night, water does not
  uniform float uGlow;
  uniform float uOpacity;
  uniform float uNormalEps;    // metres — the finite-difference step
  uniform float uContactFade;  // metres of soft fade against opaque geometry

  varying vec2  vParam;
  varying vec3  vWorld;
  varying float vHeight;
  varying float vFace;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}
  ${LIQUID_FIELD}

  // equirectUv comes from commonGLSL above. (No backticks in here: the file is
  // one template literal and a stray one ends it mid-shader.)

  /**
   * Floor under the reflected probe — lifted wholesale from the archived ocean
   * material, for the same reason it existed there: on a night stage most of the
   * probe is genuinely black, a straight lookup returns nothing, and the surface
   * collapses into flat holes of body colour. Something must always be
   * reflected, or there is no shape.
   */
  vec3 skyFloor(vec3 dir) {
    float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
    return mix(uColorSky * 0.25, uColorSky, pow(h, 0.65)) * uSkyIntensity;
  }

  /** The 2-D flow of the skin at this point, metres per second. */
  vec2 flowAt(vec2 xz, vec3 nLocal) {
    vec2 f = vec2(cos(uFlowAngle), sin(uFlowAngle)) * uFlowSpeed;

    float d = length(xz) + 1e-4;
    f += (xz / d) * uFlowRadial * exp(-d / max(uFlowRadialFall, 0.05));

    if (uFlowEddy > 0.0) {
      // Curl of one scalar field: divergence-free by construction. Three taps
      // with a forward difference — the eddies are low frequency, so the extra
      // accuracy of a central difference buys nothing at twice the cost.
      float sc = max(uFlowEddyScale, 0.02);
      float e = 0.5 / sc;
      float t = uTime * uFlowEddySpeed;
      float n0 = snoise(vec3(xz * sc, t));
      float nx = snoise(vec3((xz + vec2(e, 0.0)) * sc, t));
      float nz = snoise(vec3((xz + vec2(0.0, e)) * sc, t));
      vec2 grad = vec2(nx - n0, nz - n0) / e;
      f += vec2(grad.y, -grad.x) * uFlowEddy;
    }

    // Downhill. For y = h(x,z) the normal is proportional to (-dh/dx, 1, -dh/dz),
    // so the downhill direction is n.xz / n.y and needs no extra taps at all.
    f += (nLocal.xz / max(nLocal.y, 0.15)) * uFlowGravity;

    return f;
  }

  /**
   * The crack field: 0 deep inside a plate of skin, 1 on a seam.
   *
   * Seams are the *zero crossing* of a signed fbm rather than a ridge or a
   * voronoi edge. Zero crossings of a smooth field are naturally continuous,
   * they branch and rejoin, and their width is set by one number — three
   * properties a threshold on |noise| does not have. The domain is squashed
   * along the flow by 'uCrackStretch', which is the whole reason the seams run
   * *with* the pour instead of looking like crazed pottery.
   */
  float crackField(vec2 q) {
    float n = fbm3(vec3(q, uSeed * 7.3));
    return 1.0 - smoothstep(0.0, max(uCrackWidth, 1e-3), abs(n));
  }

  void main() {
    /* ---------------- normal, by finite difference ---------------- */
    // Four evaluations of the *whole* field, including the fragment-only octave.
    // Differencing the point rather than the height is what makes this correct
    // in the presence of the Gerstner and curl throws: the tangents pick up the
    // horizontal displacement too, so an overhanging crest is lit as an overhang.
    float e = max(uNormalEps, 1e-3);
    vec3 px = liquidPoint(vParam + vec2(e, 0.0), 1.0) - liquidPoint(vParam - vec2(e, 0.0), 1.0);
    vec3 pz = liquidPoint(vParam + vec2(0.0, e), 1.0) - liquidPoint(vParam - vec2(0.0, e), 1.0);
    vec3 nLocal = normalize(cross(pz, px) + vec3(0.0, 1e-6, 0.0));
    vec3 N = normalize(uAxisX * nLocal.x + uAxisY * nLocal.y + uAxisZ * nLocal.z);

    vec3 V = normalize(cameraPosition - vWorld);
    if (dot(N, V) < 0.0) N = -N;   // the curl folds the sheet; light both faces

    /* ---------------- the flow, and therefore the speed ---------------- */
    float speed = 0.0;
    vec2 flow = vec2(0.0);
    bool needFlow = uCrust > 0.001 || uFoamSpeed > 0.001;
    if (needFlow) {
      flow = flowAt(vParam, nLocal);
      speed = length(flow);
    }

    /* ---------------- the crust ---------------- */
    float skin = 0.0;      // 0..1 — how much black plate covers this fragment
    float seam = 0.0;      // 0..1 — how much glowing crack
    if (uCrust > 0.001) {
      // Coverage: unbroken where the surface is slow, gone where it is fast.
      float cover = 1.0 - smoothstep(uCrustForm, max(uCrustBreak, uCrustForm + 1e-3), speed);
      // The first skin takes a moment to chill. This is the only memory the
      // module has, and it is global rather than per-fragment — see the header.
      cover *= smoothstep(0.0, max(uCrustFormTime, 1e-3), uNow);
      cover *= clamp(uCrust, 0.0, 1.0);

      // A frame built from the flow. Squashing the along-flow axis stretches the
      // features along it; the perpendicular axis keeps its scale, so the seams
      // come out long and parallel rather than isotropic.
      vec2 fdir = speed > 1e-4 ? flow / speed : vec2(1.0, 0.0);
      vec2 fperp = vec2(-fdir.y, fdir.x);
      vec2 q = vec2(dot(vParam, fdir) / max(uCrackStretch, 0.05),
                    dot(vParam, fperp)) * uCrackScale;

      // Two-phase advection. One layer advected forever smears without bound;
      // two layers half a period out of step, cross-faded on |1 - 2·frac|, reset
      // one at a time and the smear never gets past half a period's worth.
      float period = max(uCrustPeriod, 0.05);
      float ph = uTime / period;
      float p0 = fract(ph);
      float p1 = fract(ph + 0.5);
      // The flow expressed in the crack frame, so the pattern rides the same
      // field the coverage was computed from.
      vec2 fq = vec2(speed / max(uCrackStretch, 0.05), 0.0) * uCrackScale * uCrustAdvect;
      float w = abs(1.0 - 2.0 * p0);
      float ca = crackField(q - fq * (p0 * period));
      float cb = crackField(q - fq * (p1 * period));
      float crack = mix(cb, ca, w);

      seam = crack * cover;
      skin = cover * (1.0 - crack);

      if (uCrustBump > 0.001) {
        // One extra pair of taps, offset across the flow. The seams are grooves,
        // so the skin's normal tilts across them and not along them — a 1-D
        // gradient is the whole of the effect and a 2-D one is twice the price
        // for nothing. Differenced against the *unweighted* crack field, or the
        // coverage term would leak a phantom bump into the melt.
        float bump = mix(crackField(q + vec2(0.0, 0.35) - fq * (p1 * period)),
                         crackField(q + vec2(0.0, 0.35) - fq * (p0 * period)), w);
        vec3 perpW = normalize(uAxisX * fperp.x + uAxisZ * fperp.y);
        N = normalize(N + perpW * (bump - crack) * cover * uCrustBump * 2.0);
      }
    }

    /* ---------------- lighting ---------------- */
    vec3 L = normalize(uLightDir);
    float ndl = dot(N, L);
    float ndv = clamp(dot(N, V), 0.0, 1.0);

    // Wrapped diffuse: a liquid scatters, so the terminator is soft and the
    // shaded side never reaches zero. A hard lambert on a heightfield draws the
    // wave troughs as black bands.
    float lam = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
    float lit = uAmbient + (1.0 - uAmbient) * lam;

    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), max(uShininess, 1.0)) * uSpecular;
    // Skin is matte and melt is glass: the crust has to kill the highlight or
    // the black plates read as wet paint.
    spec *= mix(1.0, 0.12, skin);

    float fres = clamp((0.02 + 0.98 * pow(1.0 - ndv, 5.0)) * uFresnel, 0.0, 1.0);
    fres *= mix(1.0, 0.15, skin);

    vec3 refl = reflect(-V, N);
    vec3 env = texture2D(uEnvMap, equirectUv(refl)).rgb * uEnvIntensity;
    env = max(env, skyFloor(refl));

    /* ---------------- the body ---------------- */
    // Thickness is the liquid standing above the floor, so a crest is *deeper*
    // than a trough and the depth tint tracks the swell instead of fighting it.
    float thick = clamp((vHeight + uPoolDepth) * uDepthTint, 0.0, 1.0);
    thick = 1.0 - exp(-thick * 2.0);
    vec3 body = mix(uColorShallow, uColorDeep, thick) * lit;

    // The thin front face of a breaking wave is lit from behind. Only ever
    // applied where the sheet has actually folded, which is what vFace is for.
    float through = pow(clamp(dot(V, -L), 0.0, 1.0), 2.0);
    vec3 sss = uColorShallow * (vFace * uTranslucency * (0.35 + 0.65 * through));

    /* ---------------- foam ---------------- */
    float foam = 0.0;
    if (uFoam > 0.001) {
      // Density varies smoothly, the speckle itself does not. Shading foam as a
      // smooth function of the wave paints that field's iso-contours onto the
      // surface and the pool comes out looking like a contour map.
      float sp = fbm3(vec3(vParam * uFoamScale, uTime * 0.7 + uSeed)) * 0.5 + 0.5;
      float bias = clamp(vFace * uFoamCrest
                       + smoothstep(uCrustForm, max(uCrustBreak, uCrustForm + 1e-3), speed) * uFoamSpeed
                       + clamp(vHeight * 2.0, 0.0, 1.0) * 0.25, 0.0, 1.4);
      float threshold = mix(0.95, 0.34, clamp(bias, 0.0, 1.0));
      foam = smoothstep(threshold, threshold + 0.14, sp);
      foam = pow(foam, max(uFoamSharp, 0.2)) * clamp(bias * 1.4, 0.0, 1.0) * uFoam;
    }

    /* ---------------- composite ---------------- */
    vec3 color = mix(body, env + uColorSpec * spec, fres);
    color += uColorSpec * spec * (1.0 - fres);
    color += sss;

    // The crust goes over the top of everything the melt was doing: it is opaque
    // rock, not a tint on the liquid.
    color = mix(color, uColorCrust * (uAmbient + (1.0 - uAmbient) * lam), skin);

    vec3 emissive =
        uColorHot * (1.0 - skin) * uEmissive
      + uColorSeam * seam * uSeamGlow
      + uColorHot * clamp(speed / max(uCrustBreak, 0.01), 0.0, 1.0) * (1.0 - skin) * uMeltGlow;
    color += emissive;

    color = mix(color, uColorFoam * (0.5 + 0.5 * lit), foam);
    color *= uGlow * uGlobalGlow * mix(0.7, 1.0, uShaderIntensity);

    /* ---------------- the waterline ---------------- */
    vec2 nq = vParam / max(uHalf, vec2(1e-3));
    float r = mix(max(abs(nq.x), abs(nq.y)), length(nq), clamp(uRound, 0.0, 1.0));
    // Sampled in metres so the raggedness is a fixed physical size: a small pool
    // and a large one break up with the same size of tongue.
    float jag = fbm3(vec3(vParam * uEdgeScale, uSeed * 5.7)) * 0.5 + 0.5;
    r *= mix(1.0, 0.7 + 0.6 * jag, clamp(uEdgeNoise, 0.0, 1.0));
    float mask = 1.0 - smoothstep(max(uFill - uEdgeSoft, 0.0), uFill, r);

    float alpha = mask * uOpacity;
    // The folded lip is a sheet a few millimetres thick — you can see through it.
    alpha *= 1.0 - vFace * clamp(uTranslucency * 0.4, 0.0, 0.85);
    alpha = clamp(alpha + foam * 0.5, 0.0, 1.0);

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, max(uContactFade, 1e-3));
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(color, alpha);
  }
`;

/* ---------------------------------------------------------------- */
/* Defaults                                                          */
/* ---------------------------------------------------------------- */

/**
 * A pool that is visible on the first frame, not an art direction. Every one of
 * these is meant to become a slider in the ability's own settings block —
 * anything left falling back to here is a value the editor cannot reach, which
 * is an **I1** violation waiting to be filed as a bug.
 */
const DEFAULTS = {
  /* --- the sheet --- */
  sizeX: 8, //          metres, along the surface's +X
  sizeZ: 8, //          metres, across
  fill: 1, //           0..1 of the half-extent the liquid reaches
  round: 1, //          0 rectangular footprint, 1 elliptical
  edgeSoft: 0.14, //    0..1 of the field over which the waterline fades
  edgeNoise: 0.35, //   0..1 how ragged that line is
  edgeScale: 0.9, //    cycles per metre of the raggedness
  seed: 0, //           decorrelates two pools on screen at once
  opacity: 1,
  contactFade: 0.25, // metres of soft fade against opaque geometry

  /* --- the swell: four directional waves --- */
  waveAmpA: 0.09, //    metres
  waveAmpB: 0.05,
  waveAmpC: 0.03,
  waveAmpD: 0.02,
  waveLengthA: 5.5, //  metres, crest to crest
  waveLengthB: 3.1,
  waveLengthC: 1.7,
  waveLengthD: 0.9,
  waveSpeedA: 1.1, //   metres/second
  waveSpeedB: 0.8,
  waveSpeedC: 0.55,
  waveSpeedD: 0.4,
  waveAngleA: 0.0, //   radians
  waveAngleB: 1.05,
  waveAngleC: 2.4,
  waveAngleD: 3.9,
  steepness: 0.45, //   0 sine, 1 Gerstner cusps. Above ~1 the mesh self-folds.

  /* --- chop --- */
  chop: 0.035, //       metres
  chopScale: 1.6, //    cycles per metre
  chopSpeed: 0.35, //   metres/second the field drifts
  detail: 0.012, //     metres — fragment-only; lives entirely in the normal
  detailScale: 7.5, //  cycles per metre
  detailSpeed: 0.9, //  metres/second

  /* --- ripples --- */
  rippleAmp: 0.18, //     metres at strength 1
  rippleSpeed: 3.2, //    metres/second the front travels
  rippleLength: 1.0, //   metres, crest to crest inside the packet
  rippleWidth: 0.75, //   metres of the gaussian envelope
  rippleDecay: 1.3, //    seconds to 1/e
  rippleSpread: 2.6, //   metres over which it also thins with radius

  /* --- the flow field --- */
  flowAngle: 0, //        radians, the bulk drift's bearing
  flowSpeed: 0.25, //     metres/second
  flowRadial: 0.6, //     metres/second outward at the centre
  flowRadialFall: 3.2, // metres to 1/e
  flowEddy: 0.5, //       metres/second of curl swirl
  flowEddyScale: 0.28, // cycles per metre
  flowEddySpeed: 0.12, // Hz the eddies churn
  flowGravity: 2.2, //    metres/second per unit of surface slope

  /* --- the crust (0 for water and blood) --- */
  crust: 0, //            0..1 master; 0 skips the whole block
  crustForm: 0.35, //     m/s below which the skin is unbroken
  crustBreak: 1.5, //     m/s above which there is none
  crustFormTime: 0.7, //  seconds for the first skin to chill
  crackScale: 1.15, //    cycles per metre across the flow
  crackStretch: 4.5, //   how many times longer features are along it
  crackWidth: 0.18, //    0..1 of the field — the seam's width
  crustAdvect: 1, //      0..1 how strongly the pattern is carried by the flow
  crustPeriod: 2.4, //    seconds before the flow map resets
  crustBump: 0.4, //      0..1 how much the skin roughens the normal
  seamGlow: 2.6,
  meltGlow: 1.2, //       glow of the bare melt between the plates

  /* --- foam --- */
  foam: 0, //             0..1 master
  foamScale: 5.5, //      cycles per metre of the speckle
  foamSharp: 1.4,
  foamCrest: 1.1, //      how much the breaking lip seeds it
  foamSpeed: 0.5, //      how much surface speed seeds it

  /* --- the travelling wave (WAVE mode) --- */
  waveFront: 0.5, //      0..1 along +X. The ability drives this.
  crestHeight: 1.1, //    metres
  crestBack: 2.2, //      metres — the back slope's 1/e length
  crestFace: 0.3, //      metres — the front face's 1/e length
  crestCurl: 0.55, //     metres of forward throw per metre of height
  crestWidth: 0.8, //     0..1 of the half-extent across the wave
  crestFeather: 0.3, //   0..1 of that, over which the ends die
  crestBreak: 0.35, //    0..1 how ragged the lip is
  crestBreakScale: 1.3, //cycles per metre along the lip

  /* --- shading --- */
  poolDepth: 0.4, //      metres of liquid under the mean plane
  depthTint: 1.5, //      Beer-Lambert density, per metre
  translucency: 1.0, //   backlight through the folded lip
  ambient: 0.28,
  specular: 1.3,
  shininess: 64, //       Blinn-Phong exponent
  fresnel: 1.1,
  envIntensity: 0.7,
  skyIntensity: 0.45,
  emissive: 0, //         self-lit body — lava needs it, water must not have it
  glow: 1,
  normalEps: 0.045, //    metres — the finite-difference step

  colorDeep: '#0a2230',
  colorShallow: '#2c7f92',
  colorCrust: '#120806',
  colorSeam: '#ff5a12',
  colorHot: '#ffe08a',
  colorFoam: '#eef6f8',
  colorSpec: '#ffffff',
  colorSky: '#3a5570'
};

/** Every canonical key with its default. Copy it into a settings block. */
export function liquidParams() {
  return { ...DEFAULTS };
}

const num = (v, d) => (v === undefined || v === null ? d : v);

/* ---------------------------------------------------------------- */
/* Scratch — module scope (I3)                                       */
/* ---------------------------------------------------------------- */

const _ax = new Vector3();
const _ay = new Vector3();
const _az = new Vector3();
const _rel = new Vector3();

/* ---------------------------------------------------------------- */
/* LiquidSurface                                                     */
/* ---------------------------------------------------------------- */

/**
 * ```js
 * const _o = liquidParams();               // module scope — I3
 * const _hit = new Vector3();
 *
 * this.pool = new LiquidSurface({ mode: LiquidMode.POOL, segments: 96 });
 * this.group.add(this.pool.object3D);
 * // …
 * onTravel(dt) {
 *   const c = settings.magma;
 *   this.pool.setPlacement(this.target, this.direction, UP);
 *   _o.sizeX = _o.sizeZ = c.zoneRadius * 2;   // metres, resolved THIS frame
 *   _o.fill = this.u;
 *   _o.crust = c.crust;
 *   this.pool.update(this.age, _o);
 * }
 * onBlobLanded(worldPos) {
 *   this.pool.rippleAtWorld(worldPos, 1);    // fraction + timestamp, no metres
 * }
 * ```
 */
export class LiquidSurface {
  /**
   * @param {object}  options
   * @param {number}  [options.segments]   grid resolution per side. 96 is a good
   *                                       default; below ~48 the Gerstner cusps
   *                                       facet and above ~160 you are paying
   *                                       vertex cost for detail the normal
   *                                       already carries for free.
   * @param {number}  [options.mode]       LiquidMode.*
   * @param {boolean} [options.depthWrite]  a heightfield is a solid: its own
   *                                        crests should hide its far side.
   * @param {boolean} [options.doubleSide]  needed once `crestCurl` folds the sheet
   * @param {number}  [options.renderOrder]
   * @param {string}  [options.name]
   */
  constructor({
    segments = 96,
    mode = LiquidMode.POOL,
    depthWrite = true,
    doubleSide = true,
    renderOrder = 3,
    name = 'LiquidSurface'
  } = {}) {
    const n = Math.max(2, Math.round(segments));

    /* The geometry is a unit square. Every metre it ever occupies comes out of
       `uHalf` in the vertex shader, which is what lets a pool be resized by a
       slider on a paused frame without touching a buffer. */
    this.geometry = new PlaneGeometry(1, 1, n, n);
    this.geometry.boundingSphere = new Sphere(new Vector3(), 1e4);

    /** Ripple records: (u, v, born, strength). Allocated once, mutated forever. */
    this._ripples = [];
    for (let i = 0; i < RIPPLE_SLOTS; i++) this._ripples.push(new Vector4(0, 0, 0, 0));
    this._nextSlot = 0;

    this.material = new ShaderMaterial({
      name: `${name}:surface`,
      transparent: true,
      depthWrite,
      depthTest: true,
      side: doubleSide ? DoubleSide : FrontSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uEnvMap: frame.uEnvMap,

        uAnchor: { value: new Vector3() },
        uAxisX: { value: new Vector3(1, 0, 0) },
        uAxisY: { value: new Vector3(0, 1, 0) },
        uAxisZ: { value: new Vector3(0, 0, 1) },
        uHalf: { value: new Vector2(DEFAULTS.sizeX * 0.5, DEFAULTS.sizeZ * 0.5) },
        uNow: { value: 0 },
        uSeed: { value: DEFAULTS.seed },
        uMode: { value: mode },

        uWaveAmp: { value: new Vector4() },
        uWaveLength: { value: new Vector4(1, 1, 1, 1) },
        uWaveSpeed: { value: new Vector4() },
        uWaveAngle: { value: new Vector4() },
        uSteepness: { value: DEFAULTS.steepness },

        uChop: { value: DEFAULTS.chop },
        uChopScale: { value: DEFAULTS.chopScale },
        uChopSpeed: { value: DEFAULTS.chopSpeed },
        uDetail: { value: DEFAULTS.detail },
        uDetailScale: { value: DEFAULTS.detailScale },
        uDetailSpeed: { value: DEFAULTS.detailSpeed },

        uRipples: { value: this._ripples },
        uRippleAmp: { value: DEFAULTS.rippleAmp },
        uRippleSpeed: { value: DEFAULTS.rippleSpeed },
        uRippleLength: { value: DEFAULTS.rippleLength },
        uRippleWidth: { value: DEFAULTS.rippleWidth },
        uRippleDecay: { value: DEFAULTS.rippleDecay },
        uRippleSpread: { value: DEFAULTS.rippleSpread },

        uWaveFront: { value: DEFAULTS.waveFront },
        uCrestHeight: { value: DEFAULTS.crestHeight },
        uCrestBack: { value: DEFAULTS.crestBack },
        uCrestFace: { value: DEFAULTS.crestFace },
        uCrestCurl: { value: DEFAULTS.crestCurl },
        uCrestWidth: { value: DEFAULTS.crestWidth },
        uCrestFeather: { value: DEFAULTS.crestFeather },
        uCrestBreak: { value: DEFAULTS.crestBreak },
        uCrestBreakScale: { value: DEFAULTS.crestBreakScale },

        uFill: { value: DEFAULTS.fill },
        uRound: { value: DEFAULTS.round },
        uEdgeSoft: { value: DEFAULTS.edgeSoft },
        uEdgeNoise: { value: DEFAULTS.edgeNoise },
        uEdgeScale: { value: DEFAULTS.edgeScale },

        uFlowAngle: { value: DEFAULTS.flowAngle },
        uFlowSpeed: { value: DEFAULTS.flowSpeed },
        uFlowRadial: { value: DEFAULTS.flowRadial },
        uFlowRadialFall: { value: DEFAULTS.flowRadialFall },
        uFlowEddy: { value: DEFAULTS.flowEddy },
        uFlowEddyScale: { value: DEFAULTS.flowEddyScale },
        uFlowEddySpeed: { value: DEFAULTS.flowEddySpeed },
        uFlowGravity: { value: DEFAULTS.flowGravity },

        uCrust: { value: DEFAULTS.crust },
        uCrustForm: { value: DEFAULTS.crustForm },
        uCrustBreak: { value: DEFAULTS.crustBreak },
        uCrustFormTime: { value: DEFAULTS.crustFormTime },
        uCrackScale: { value: DEFAULTS.crackScale },
        uCrackStretch: { value: DEFAULTS.crackStretch },
        uCrackWidth: { value: DEFAULTS.crackWidth },
        uCrustAdvect: { value: DEFAULTS.crustAdvect },
        uCrustPeriod: { value: DEFAULTS.crustPeriod },
        uCrustBump: { value: DEFAULTS.crustBump },
        uSeamGlow: { value: DEFAULTS.seamGlow },
        uMeltGlow: { value: DEFAULTS.meltGlow },

        uFoam: { value: DEFAULTS.foam },
        uFoamScale: { value: DEFAULTS.foamScale },
        uFoamSharp: { value: DEFAULTS.foamSharp },
        uFoamCrest: { value: DEFAULTS.foamCrest },
        uFoamSpeed: { value: DEFAULTS.foamSpeed },

        uColorDeep: { value: new Color(DEFAULTS.colorDeep) },
        uColorShallow: { value: new Color(DEFAULTS.colorShallow) },
        uColorCrust: { value: new Color(DEFAULTS.colorCrust) },
        uColorSeam: { value: new Color(DEFAULTS.colorSeam) },
        uColorHot: { value: new Color(DEFAULTS.colorHot) },
        uColorFoam: { value: new Color(DEFAULTS.colorFoam) },
        uColorSpec: { value: new Color(DEFAULTS.colorSpec) },
        uColorSky: { value: new Color(DEFAULTS.colorSky) },

        uPoolDepth: { value: DEFAULTS.poolDepth },
        uDepthTint: { value: DEFAULTS.depthTint },
        uTranslucency: { value: DEFAULTS.translucency },
        uAmbient: { value: DEFAULTS.ambient },
        uSpecular: { value: DEFAULTS.specular },
        uShininess: { value: DEFAULTS.shininess },
        uFresnel: { value: DEFAULTS.fresnel },
        uEnvIntensity: { value: DEFAULTS.envIntensity },
        uSkyIntensity: { value: DEFAULTS.skyIntensity },
        uEmissive: { value: DEFAULTS.emissive },
        uGlow: { value: DEFAULTS.glow },
        uOpacity: { value: DEFAULTS.opacity },
        uNormalEps: { value: DEFAULTS.normalEps },
        uContactFade: { value: DEFAULTS.contactFade }
      }),
      vertexShader: LIQUID_VERTEX,
      fragmentShader: LIQUID_FRAGMENT
    });

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = name;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.renderOrder = renderOrder;
    // Placed entirely by the vertex shader; its own bounds mean nothing.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;

    this._now = 0;
    this._halfX = DEFAULTS.sizeX * 0.5;
    this._halfZ = DEFAULTS.sizeZ * 0.5;
  }

  /** Add this to the ability's group. */
  get object3D() {
    return this.mesh;
  }

  get uniforms() {
    return this.material.uniforms;
  }

  /** Always one. */
  get drawCalls() {
    return 1;
  }

  get visible() {
    return this.mesh.visible;
  }

  set visible(v) {
    this.mesh.visible = !!v;
  }

  get mode() {
    return this.material.uniforms.uMode.value;
  }

  /** POOL ⇄ WAVE. A uniform branch — no recompile, switch it mid-cast. */
  set mode(m) {
    this.material.uniforms.uMode.value = m | 0;
  }

  /**
   * Place the sheet without touching a matrix.
   *
   * @param {THREE.Vector3} anchor world centre of the mean plane, metres
   * @param {THREE.Vector3} along  the sheet's local +X — a WAVE travels this way
   * @param {THREE.Vector3} up     the sheet's normal at rest, re-orthogonalised
   */
  setPlacement(anchor, along, up) {
    const u = this.material.uniforms;
    u.uAnchor.value.copy(anchor);
    _ax.copy(along).normalize();
    _az.crossVectors(up, _ax).normalize();
    _ay.crossVectors(_ax, _az).normalize();
    u.uAxisX.value.copy(_ax);
    u.uAxisY.value.copy(_ay);
    u.uAxisZ.value.copy(_az);
    return this;
  }

  /* ---------------- ripples ---------------- */

  /**
   * Inject a circular wave.
   *
   * @param {number} u        −1..1 across the sheet's +X half-extent. **Unitless.**
   * @param {number} v        −1..1 across the +Z half-extent. **Unitless.**
   * @param {number} strength dimensionless multiplier on `rippleAmp`
   * @param {number} [now]    timestamp; defaults to the clock `update()` last saw
   * @returns {number} the slot it took
   *
   * The record is a fraction, a timestamp and a strength — never a metre, per
   * **I1**. Resize the pool afterwards and the standing ripples move with it,
   * which is the observable proof the rule is being kept.
   */
  ripple(u, v, strength = 1, now = this._now) {
    const slot = this._oldestSlot(now);
    this._ripples[slot].set(u, v, now, Math.max(0, strength));
    return slot;
  }

  /**
   * The same, from a world point — converted against the live placement.
   *
   * Call it *after* `update()` on the frame you want it measured against, since
   * the conversion needs this frame's half-extents. What is stored is still only
   * the fraction.
   */
  rippleAtWorld(position, strength = 1, now = this._now) {
    const un = this.material.uniforms;
    _rel.copy(position).sub(un.uAnchor.value);
    const u = _rel.dot(un.uAxisX.value) / Math.max(this._halfX, 1e-4);
    const v = _rel.dot(un.uAxisZ.value) / Math.max(this._halfZ, 1e-4);
    return this.ripple(u, v, strength, now);
  }

  /**
   * Prefer a free slot; otherwise evict the *oldest*, never the newest. The
   * newest is the one the player is looking at.
   */
  _oldestSlot(now) {
    let best = 0;
    let bestAge = -1;
    for (let i = 0; i < RIPPLE_SLOTS; i++) {
      const r = this._ripples[i];
      if (r.w <= 0) return i;
      const age = now - r.z;
      if (age > bestAge) {
        bestAge = age;
        best = i;
      }
    }
    // Round-robin as a tie-break so a burst of same-frame impacts spreads out.
    const slot = this._nextSlot;
    this._nextSlot = (this._nextSlot + 1) % RIPPLE_SLOTS;
    return bestAge > 0 ? best : slot;
  }

  clearRipples() {
    for (let i = 0; i < RIPPLE_SLOTS; i++) this._ripples[i].set(0, 0, 0, 0);
    this._nextSlot = 0;
    return this;
  }

  /** Hide it and blank the ring buffer. Leaves the instance reusable. */
  reset() {
    this.clearRipples();
    this._now = 0;
    this.material.uniforms.uNow.value = 0;
    this.mesh.visible = false;
    return this;
  }

  /* ---------------- the frame ---------------- */

  /**
   * Re-resolve every dimension. Every frame, zero-length ones included.
   *
   * *the sheet* — `sizeX` `sizeZ` (metres), `fill` (0..1 of the half-extent),
   * `round` (0 rectangular, 1 elliptical), `edgeSoft` / `edgeNoise` /
   * `edgeScale`, `seed`, `opacity`, `contactFade` (metres).
   *
   * *the swell* — `waveAmpA..D` (metres), `waveLengthA..D` (metres),
   * `waveSpeedA..D` (m/s), `waveAngleA..D` (radians), `steepness`.
   *
   * *chop* — `chop` / `chopScale` / `chopSpeed`, and `detail` / `detailScale` /
   * `detailSpeed` which the vertex stage deliberately ignores.
   *
   * *ripples* — `rippleAmp` (metres), `rippleSpeed` (m/s), `rippleLength`
   * (metres), `rippleWidth` (metres), `rippleDecay` (seconds), `rippleSpread`
   * (metres).
   *
   * *the flow* — `flowAngle` (rad), `flowSpeed` (m/s), `flowRadial` (m/s),
   * `flowRadialFall` (metres), `flowEddy` (m/s), `flowEddyScale`,
   * `flowEddySpeed`, `flowGravity`.
   *
   * *the crust* — `crust` (0..1 master; 0 skips the block entirely), `crustForm`
   * and `crustBreak` (m/s — the speeds between which the skin dies),
   * `crustFormTime` (seconds), `crackScale`, `crackStretch`, `crackWidth`,
   * `crustAdvect`, `crustPeriod` (seconds), `crustBump`, `seamGlow`, `meltGlow`.
   *
   * *foam* — `foam`, `foamScale`, `foamSharp`, `foamCrest`, `foamSpeed`.
   *
   * *the wave* — `waveFront` (0..1), `crestHeight` / `crestBack` / `crestFace` /
   * `crestCurl` (metres), `crestWidth` / `crestFeather` / `crestBreak` (0..1),
   * `crestBreakScale`.
   *
   * *shading* — `poolDepth`, `depthTint`, `translucency`, `ambient`, `specular`,
   * `shininess`, `fresnel`, `envIntensity`, `skyIntensity`, `emissive`, `glow`,
   * `normalEps` (metres), and eight pickers `colorDeep`, `colorShallow`,
   * `colorCrust`, `colorSeam`, `colorHot`, `colorFoam`, `colorSpec`, `colorSky`.
   *
   * @param {number} now seconds since the cast began — the ripple clock
   * @param {object} p   a plain object. Keep it at module scope and refill it.
   */
  update(now, p) {
    const u = this.material.uniforms;
    this._now = now;
    u.uNow.value = now;

    this._halfX = Math.max(num(p.sizeX, DEFAULTS.sizeX), 0.01) * 0.5;
    this._halfZ = Math.max(num(p.sizeZ, DEFAULTS.sizeZ), 0.01) * 0.5;
    u.uHalf.value.set(this._halfX, this._halfZ);
    u.uSeed.value = num(p.seed, DEFAULTS.seed);

    u.uWaveAmp.value.set(
      num(p.waveAmpA, DEFAULTS.waveAmpA),
      num(p.waveAmpB, DEFAULTS.waveAmpB),
      num(p.waveAmpC, DEFAULTS.waveAmpC),
      num(p.waveAmpD, DEFAULTS.waveAmpD)
    );
    u.uWaveLength.value.set(
      num(p.waveLengthA, DEFAULTS.waveLengthA),
      num(p.waveLengthB, DEFAULTS.waveLengthB),
      num(p.waveLengthC, DEFAULTS.waveLengthC),
      num(p.waveLengthD, DEFAULTS.waveLengthD)
    );
    u.uWaveSpeed.value.set(
      num(p.waveSpeedA, DEFAULTS.waveSpeedA),
      num(p.waveSpeedB, DEFAULTS.waveSpeedB),
      num(p.waveSpeedC, DEFAULTS.waveSpeedC),
      num(p.waveSpeedD, DEFAULTS.waveSpeedD)
    );
    u.uWaveAngle.value.set(
      num(p.waveAngleA, DEFAULTS.waveAngleA),
      num(p.waveAngleB, DEFAULTS.waveAngleB),
      num(p.waveAngleC, DEFAULTS.waveAngleC),
      num(p.waveAngleD, DEFAULTS.waveAngleD)
    );
    // Capped here rather than in the shader: past ~1 the Gerstner term pulls
    // vertices through one another and the surface knots. Better to clamp the
    // slider's effect than to litter the field function with guards.
    u.uSteepness.value = Math.min(num(p.steepness, DEFAULTS.steepness), 1.2);

    u.uChop.value = num(p.chop, DEFAULTS.chop);
    u.uChopScale.value = num(p.chopScale, DEFAULTS.chopScale);
    u.uChopSpeed.value = num(p.chopSpeed, DEFAULTS.chopSpeed);
    u.uDetail.value = num(p.detail, DEFAULTS.detail);
    u.uDetailScale.value = num(p.detailScale, DEFAULTS.detailScale);
    u.uDetailSpeed.value = num(p.detailSpeed, DEFAULTS.detailSpeed);

    u.uRippleAmp.value = num(p.rippleAmp, DEFAULTS.rippleAmp);
    u.uRippleSpeed.value = num(p.rippleSpeed, DEFAULTS.rippleSpeed);
    u.uRippleLength.value = num(p.rippleLength, DEFAULTS.rippleLength);
    u.uRippleWidth.value = num(p.rippleWidth, DEFAULTS.rippleWidth);
    u.uRippleDecay.value = num(p.rippleDecay, DEFAULTS.rippleDecay);
    u.uRippleSpread.value = num(p.rippleSpread, DEFAULTS.rippleSpread);

    u.uWaveFront.value = num(p.waveFront, DEFAULTS.waveFront);
    u.uCrestHeight.value = num(p.crestHeight, DEFAULTS.crestHeight);
    u.uCrestBack.value = num(p.crestBack, DEFAULTS.crestBack);
    u.uCrestFace.value = num(p.crestFace, DEFAULTS.crestFace);
    u.uCrestCurl.value = num(p.crestCurl, DEFAULTS.crestCurl);
    u.uCrestWidth.value = num(p.crestWidth, DEFAULTS.crestWidth);
    u.uCrestFeather.value = num(p.crestFeather, DEFAULTS.crestFeather);
    u.uCrestBreak.value = num(p.crestBreak, DEFAULTS.crestBreak);
    u.uCrestBreakScale.value = num(p.crestBreakScale, DEFAULTS.crestBreakScale);

    u.uFill.value = num(p.fill, DEFAULTS.fill);
    u.uRound.value = num(p.round, DEFAULTS.round);
    u.uEdgeSoft.value = num(p.edgeSoft, DEFAULTS.edgeSoft);
    u.uEdgeNoise.value = num(p.edgeNoise, DEFAULTS.edgeNoise);
    u.uEdgeScale.value = num(p.edgeScale, DEFAULTS.edgeScale);

    u.uFlowAngle.value = num(p.flowAngle, DEFAULTS.flowAngle);
    u.uFlowSpeed.value = num(p.flowSpeed, DEFAULTS.flowSpeed);
    u.uFlowRadial.value = num(p.flowRadial, DEFAULTS.flowRadial);
    u.uFlowRadialFall.value = num(p.flowRadialFall, DEFAULTS.flowRadialFall);
    u.uFlowEddy.value = num(p.flowEddy, DEFAULTS.flowEddy);
    u.uFlowEddyScale.value = num(p.flowEddyScale, DEFAULTS.flowEddyScale);
    u.uFlowEddySpeed.value = num(p.flowEddySpeed, DEFAULTS.flowEddySpeed);
    u.uFlowGravity.value = num(p.flowGravity, DEFAULTS.flowGravity);

    u.uCrust.value = num(p.crust, DEFAULTS.crust);
    u.uCrustForm.value = num(p.crustForm, DEFAULTS.crustForm);
    u.uCrustBreak.value = num(p.crustBreak, DEFAULTS.crustBreak);
    u.uCrustFormTime.value = num(p.crustFormTime, DEFAULTS.crustFormTime);
    u.uCrackScale.value = num(p.crackScale, DEFAULTS.crackScale);
    u.uCrackStretch.value = num(p.crackStretch, DEFAULTS.crackStretch);
    u.uCrackWidth.value = num(p.crackWidth, DEFAULTS.crackWidth);
    u.uCrustAdvect.value = num(p.crustAdvect, DEFAULTS.crustAdvect);
    u.uCrustPeriod.value = num(p.crustPeriod, DEFAULTS.crustPeriod);
    u.uCrustBump.value = num(p.crustBump, DEFAULTS.crustBump);
    u.uSeamGlow.value = num(p.seamGlow, DEFAULTS.seamGlow);
    u.uMeltGlow.value = num(p.meltGlow, DEFAULTS.meltGlow);

    u.uFoam.value = num(p.foam, DEFAULTS.foam);
    u.uFoamScale.value = num(p.foamScale, DEFAULTS.foamScale);
    u.uFoamSharp.value = num(p.foamSharp, DEFAULTS.foamSharp);
    u.uFoamCrest.value = num(p.foamCrest, DEFAULTS.foamCrest);
    u.uFoamSpeed.value = num(p.foamSpeed, DEFAULTS.foamSpeed);

    u.uPoolDepth.value = num(p.poolDepth, DEFAULTS.poolDepth);
    u.uDepthTint.value = num(p.depthTint, DEFAULTS.depthTint);
    u.uTranslucency.value = num(p.translucency, DEFAULTS.translucency);
    u.uAmbient.value = num(p.ambient, DEFAULTS.ambient);
    u.uSpecular.value = num(p.specular, DEFAULTS.specular);
    u.uShininess.value = num(p.shininess, DEFAULTS.shininess);
    u.uFresnel.value = num(p.fresnel, DEFAULTS.fresnel);
    u.uEnvIntensity.value = num(p.envIntensity, DEFAULTS.envIntensity);
    u.uSkyIntensity.value = num(p.skyIntensity, DEFAULTS.skyIntensity);
    u.uEmissive.value = num(p.emissive, DEFAULTS.emissive);
    u.uGlow.value = num(p.glow, DEFAULTS.glow);
    u.uOpacity.value = num(p.opacity, DEFAULTS.opacity);
    u.uNormalEps.value = num(p.normalEps, DEFAULTS.normalEps);
    u.uContactFade.value = num(p.contactFade, DEFAULTS.contactFade);

    copyColor(u.uColorDeep.value, p.colorDeep || DEFAULTS.colorDeep);
    copyColor(u.uColorShallow.value, p.colorShallow || DEFAULTS.colorShallow);
    copyColor(u.uColorCrust.value, p.colorCrust || DEFAULTS.colorCrust);
    copyColor(u.uColorSeam.value, p.colorSeam || DEFAULTS.colorSeam);
    copyColor(u.uColorHot.value, p.colorHot || DEFAULTS.colorHot);
    copyColor(u.uColorFoam.value, p.colorFoam || DEFAULTS.colorFoam);
    copyColor(u.uColorSpec.value, p.colorSpec || DEFAULTS.colorSpec);
    copyColor(u.uColorSky.value, p.colorSky || DEFAULTS.colorSky);

    return this;
  }

  /* ---------------- read-back ---------------- */

  /**
   * Where the breaking lip is, in world metres — the point to emit droplets from.
   *
   * Deliberately evaluates only the crest profile, not the chop and not the
   * ripples. You want droplets leaving a clean moving line; sampling the full
   * field would jitter every emitter by the finest octave in it, which reads as
   * a fault in the emitter rather than as detail in the wave.
   *
   * @param {object}        p       the same live params `update()` was given
   * @param {THREE.Vector3} out     written in place
   * @param {number}        [across] −1..1 along the lip. Roll it per droplet.
   */
  lipPosition(p, out, across = 0) {
    const u = this.material.uniforms;
    const halfX = Math.max(num(p.sizeX, DEFAULTS.sizeX), 0.01) * 0.5;
    const halfZ = Math.max(num(p.sizeZ, DEFAULTS.sizeZ), 0.01) * 0.5;

    const h = this.lipHeight(p, across);
    const x = (num(p.waveFront, DEFAULTS.waveFront) - 0.5) * halfX * 2 + h * num(p.crestCurl, DEFAULTS.crestCurl);
    const z = across * num(p.crestWidth, DEFAULTS.crestWidth) * halfZ;

    out.copy(u.uAnchor.value)
      .addScaledVector(u.uAxisX.value, x)
      .addScaledVector(u.uAxisY.value, h)
      .addScaledVector(u.uAxisZ.value, z);
    return out;
  }

  /** The crest's height in metres at a −1..1 position along the lip. */
  lipHeight(p, across = 0) {
    if (this.mode === LiquidMode.POOL) return 0;
    const width = Math.min(Math.max(num(p.crestWidth, DEFAULTS.crestWidth), 0), 1);
    const feather = Math.max(num(p.crestFeather, DEFAULTS.crestFeather), 1e-3);
    // `across` is a fraction of the crest's own width, so it lands at
    // |across| * width of the half-extent — the same coordinate `crestLateral`
    // thresholds in the shader.
    const a = Math.abs(across) * width;
    const edge0 = Math.max(width - feather, 0);
    const span = Math.max(width - edge0, 1e-4);
    // The same smoothstep the shader uses, expanded, so the two never disagree.
    const t = Math.min(Math.max((a - edge0) / span, 0), 1);
    const lateral = 1 - t * t * (3 - 2 * t);
    return num(p.crestHeight, DEFAULTS.crestHeight) * lateral;
  }

  dispose() {
    this.mesh.visible = false;
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
