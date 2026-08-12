import { AdditiveBlending, Color, DoubleSide, ShaderMaterial, Vector2, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Arcane Volley's two draw calls: the trails, and the heads that draw them.
 *
 * Both are instanced once per bolt and both evaluate **the same parametric
 * flight**, which is the only reason a trail is possible at all. A recorded
 * trail is a ring buffer of metres, and a ring buffer of metres cannot be
 * re-shaped by a slider — drag `weaveSide` on a recorded trail and the history
 * behind the bolt stays where it was flown, which looks exactly like a bug. So
 * nothing is recorded: the trail's vertex shader samples the flight *backwards
 * in the bolt's own clock* and gets a ribbon that re-flies itself, live, on a
 * zero-length frame.
 *
 * `vfx/Projectile` does this too, and does it well — but its Lissajous mode
 * carries **one** pair of weave frequencies for the whole volley, with the
 * bolts separated only by phase and sign. Seven congruent curves at seven
 * phases is a braid, and a braid is uniform. The table below is the difference:
 * a per-bolt frequency ratio, so bolt 3 traces a 3:2 figure while bolt 5 traces
 * a 1:3, and the crossings stop being periodic.
 */

/** Hard ceiling on bolts. `bolts` clamps here and the geometry is built for it. */
export const MAX_BOLTS = 8;

/**
 * The small table.
 *
 * Lateral : vertical cycles over the flight, per bolt. Unitless — a live
 * `weaveTurns` slider multiplies the pair, so the whole volley speeds up or
 * slows down together while the *ratios* stay what makes each bolt distinct.
 *
 * They are near-coprime on purpose. A 2:4 bolt is a 1:2 bolt drawn twice as
 * fast and reads as the same figure; 1:2, 2:3, 3:2, 2:1, 3:4, 1:3, 4:3, 5:3 all
 * close at different points in the flight, so the seven cross each other at
 * irregular intervals instead of pulsing in unison. The first version used
 * `i + 1 : i + 2` and the volley breathed — every bolt hit its widest point at
 * the same instant, which is the one thing a weave must not do.
 */
const RATIOS = [
  [1, 2],
  [2, 3],
  [3, 2],
  [2, 1],
  [3, 4],
  [1, 3],
  [4, 3],
  [5, 3]
];

/**
 * The flight, shared verbatim by both shaders.
 *
 * `q` is the bolt's whole life in one number:
 *
 * | q | where the bolt is |
 * | --- | --- |
 * | `-1` | the instant the charge began, circling the hand at `uOrbitStart` |
 * | `0`  | release — still at the hand, at full weave amplitude |
 * | `0..1` | in flight |
 * | `1`  | at the target, **exactly**, whatever its ratio or phase |
 *
 * The wind-up and the flight are not two behaviours. During the charge the
 * bolt's weave phase is *rotated* and its τ is pinned at zero, so it traces the
 * τ = 0 slice of its own Lissajous figure — a small loop around the hand — and
 * at q = 0 the rotation stops and the same offsets simply start being carried
 * downrange. The two beats are continuous by construction, which is what lets
 * one trail run through the release without a seam.
 *
 * The convergence is the decay: the lateral and vertical offsets are multiplied
 * by `(1 − τ)^weaveDecay`, which is *identically zero* at τ = 1. Nothing steers
 * and nothing is corrected. Seven bolts on seven different figures arrive at one
 * point on one frame because the algebra leaves them nowhere else to be.
 */
const VOLLEY_PATH = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586
  #define MAX_BOLTS ${MAX_BOLTS}

  uniform vec3  uHand;
  uniform vec3  uTarget;
  uniform vec3  uSide;
  uniform float uSeed;
  uniform float uCount;

  uniform float uWeaveSide;
  uniform float uWeaveUp;
  uniform float uWeaveTurns;
  uniform float uWeavePhase;
  uniform float uWeaveDecay;
  uniform float uPathCurve;
  uniform float uOrbitTurns;
  uniform float uOrbitStart;
  uniform float uChargeCurve;
  uniform vec2  uRatio[MAX_BOLTS];

  /** The perpendicular frame the weave lives in. Gram-Schmidt, as the bolt does. */
  void volleyFrame(out vec3 dir, out vec3 n1, out vec3 n2) {
    vec3 delta = uTarget - uHand;
    float span = max(length(delta), 0.01);
    dir = delta / span;
    n1 = uSide - dir * dot(uSide, dir);
    n1 = length(n1) > 1e-4 ? normalize(n1) : normalize(cross(dir, vec3(0.0, 1.0, 0.0)));
    n2 = normalize(cross(dir, n1));
  }

  /** This bolt's frequency pair, fetched the only way ANGLE allows. */
  vec2 boltRatio(float bolt) {
    vec2 r = uRatio[0];
    for (int i = 0; i < MAX_BOLTS; i++) {
      if (float(i) == bolt) r = uRatio[i];
    }
    return r;
  }

  /** Where bolt number 'bolt' is at 'q'. See the header for what q means. */
  vec3 boltPoint(float bolt, float q, vec3 n1, vec3 n2) {
    float tau = clamp(q, 0.0, 1.0);
    float wind = clamp(q, -1.0, 0.0);

    vec2 ratio = boltRatio(bolt);
    float phase = (bolt / max(uCount, 1.0)) * TAU + uSeed;
    // Rotating while it is held, frozen the moment it leaves.
    phase += wind * uOrbitTurns * TAU;

    // The ring opens from uOrbitStart to full amplitude over the wind-up, and
    // is exactly 1 at release, so the flight inherits the offset it had.
    float grow = pow(clamp(1.0 + wind, 0.0, 1.0), max(uChargeCurve, 0.05));
    float gate = mix(uOrbitStart, 1.0, grow);
    float decay = pow(1.0 - tau, max(uWeaveDecay, 0.01)) * gate;

    vec3 base = mix(uHand, uTarget, pow(tau, max(uPathCurve, 0.05)));
    base += n1 * (uWeaveSide * decay * sin(TAU * ratio.x * uWeaveTurns * tau + phase));
    base += n2 * (uWeaveUp * decay * sin(TAU * ratio.y * uWeaveTurns * tau + phase + uWeavePhase));
    return base;
  }
`;

/* ------------------------------------------------------------------ */
/* 1 · The trails — the main read                                      */
/* ------------------------------------------------------------------ */

/**
 * One instanced ribbon per bolt, sampled backwards along its own flight.
 *
 * The head's `q` and the tail's `q` both arrive as uniforms — the ability turns
 * `trailSpan` seconds into a Δq using the live flight time, and turns the
 * post-arrival catch-up into a tail that walks *forward* to meet a head that has
 * stopped. A trail that dims reads as a light going out; one that shortens
 * reads as something that has stopped being made, which is what a spent bolt is.
 */
const TRAIL_VERTEX = /* glsl */ `
  ${VOLLEY_PATH}

  uniform float uTime;
  uniform float uQHead;
  uniform float uQTail;
  uniform float uWidth;
  uniform float uTaper;
  uniform float uFade;
  uniform float uFlicker;
  uniform float uFlickerSpeed;

  attribute float aStrand;

  varying float vV;
  varying float vSide;
  varying float vFlash;
  varying float vViewZ;

  ${noiseGLSL}

  void main() {
    float v = position.x;
    vV = v;
    vSide = position.y;

    vec3 dir, n1, n2;
    volleyFrame(dir, n1, n2);

    float q = mix(uQTail, uQHead, v);
    vec3 here = boltPoint(aStrand, q, n1, n2);

    // The tangent is taken along the *flight*, not along the ribbon's own
    // parameter, so a ribbon whose ends coincide (a bolt that has stopped)
    // still has a direction to face the camera with.
    float dq = max(abs(uQHead - uQTail), 1e-3) * 0.05;
    float flip = 1.0;
    float other = q + dq;
    if (other > 1.0) { other = q - dq; flip = -1.0; }
    vec3 next = boltPoint(aStrand, other, n1, n2);
    vec3 tangent = (next - here) * flip;
    tangent = length(tangent) > 1e-5 ? normalize(tangent) : dir;

    vec3 toCamera = normalize(cameraPosition - here);
    vec3 binormal = cross(tangent, toCamera);
    float bl = length(binormal);
    binormal = bl > 1e-4 ? binormal / bl : n1;

    float flash = mix(1.0, hash11(floor(uTime * uFlickerSpeed) + aStrand * 5.1 + uSeed), uFlicker);
    vFlash = flash;

    // Tapered to a point at the tail. The head keeps its width so the ribbon
    // reads as *emitted* rather than as a spindle.
    float halfWidth = uWidth * pow(clamp(v, 0.0, 1.0), max(uTaper, 0.05)) * flash * uFade;

    vec4 mv = viewMatrix * vec4(here + binormal * vSide * halfWidth, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const TRAIL_FRAGMENT = /* glsl */ `
  uniform float uCoreSharp;
  uniform float uCoreWidth;
  uniform float uHaloFalloff;
  uniform float uHaloOpacity;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFade;
  uniform float uSoftFade;
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uColorC;
  uniform vec3  uColorD;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying float vV;
  varying float vSide;
  varying float vFlash;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    float v = clamp(abs(vSide), 0.0, 1.0);

    // One pass carrying both profiles: additive blending is a sum, so a halo
    // pass and a core pass over the same ribbon are the same image as adding
    // them here — for one draw call instead of two.
    float core = pow(clamp(1.0 - v / max(uCoreWidth, 1e-3), 0.0, 1.0), max(uCoreSharp, 0.05));
    float halo = pow(1.0 - v, max(uHaloFalloff, 0.05)) * uHaloOpacity;

    // Four stops from the tail to the head. Sampled along the ribbon rather
    // than over a particle's life, because the ribbon *is* the history.
    vec3 tint = gradient4(uColorA, uColorB, uColorC, uColorD, clamp(vV, 0.0, 1.0));

    float ends = smoothstep(0.0, 0.12, vV);
    float alpha = (core + halo) * ends * vFlash * uFade * uOpacity;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    vec3 color = tint * (core + halo) * uGlow * uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/** The trail pass. One draw call, `bolts` instances. */
export function createVolleyTrailMaterial() {
  const ratios = [];
  for (let i = 0; i < MAX_BOLTS; i++) ratios.push(new Vector2(RATIOS[i][0], RATIOS[i][1]));

  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uHand: { value: new Vector3() },
      uTarget: { value: new Vector3(0, 0, 1) },
      uSide: { value: new Vector3(1, 0, 0) },
      uSeed: { value: 0 },
      uCount: { value: 7 },
      uRatio: { value: ratios },

      uWeaveSide: { value: 1.9 },
      uWeaveUp: { value: 1.2 },
      uWeaveTurns: { value: 1.0 },
      uWeavePhase: { value: Math.PI * 0.5 },
      uWeaveDecay: { value: 1.5 },
      uPathCurve: { value: 1.0 },
      uOrbitTurns: { value: 1.2 },
      uOrbitStart: { value: 0.25 },
      uChargeCurve: { value: 0.8 },

      uQHead: { value: 0 },
      uQTail: { value: 0 },
      uWidth: { value: 0.13 },
      uTaper: { value: 1.5 },
      uFade: { value: 1 },
      uFlicker: { value: 0.1 },
      uFlickerSpeed: { value: 20 },

      uCoreSharp: { value: 2.4 },
      uCoreWidth: { value: 0.36 },
      uHaloFalloff: { value: 2.4 },
      uHaloOpacity: { value: 0.6 },
      uOpacity: { value: 1 },
      uGlow: { value: 2.0 },
      uSoftFade: { value: 0.5 },

      uColorA: { value: new Color(0.16, 0.1, 0.29) },
      uColorB: { value: new Color(0.54, 0.37, 0.82) },
      uColorC: { value: new Color(0.88, 0.75, 1) },
      uColorD: { value: new Color(1, 1, 1) }
    }),
    vertexShader: TRAIL_VERTEX,
    fragmentShader: TRAIL_FRAGMENT
  });

  /**
   * @param {object} state { hand, target, side, seed, count, qHead, qTail, fade }
   */
  material.userData.sync = (state) => {
    const c = settings.arcanevolley;
    const g = settings.global;
    const u = material.uniforms;

    u.uHand.value.copy(state.hand);
    u.uTarget.value.copy(state.target);
    u.uSide.value.copy(state.side);
    u.uSeed.value = state.seed;
    u.uCount.value = state.count;
    u.uQHead.value = state.qHead;
    u.uQTail.value = state.qTail;
    u.uFade.value = state.fade;

    u.uWeaveSide.value = c.weaveSide;
    u.uWeaveUp.value = c.weaveUp;
    u.uWeaveTurns.value = c.weaveTurns;
    u.uWeavePhase.value = c.weavePhase;
    u.uWeaveDecay.value = c.weaveDecay;
    u.uPathCurve.value = c.pathCurve;
    u.uOrbitTurns.value = c.orbitTurns;
    u.uOrbitStart.value = c.orbitStart;
    u.uChargeCurve.value = c.chargeCurve;

    u.uWidth.value = c.trailWidth;
    u.uTaper.value = c.trailTaper;
    u.uFlicker.value = c.trailFlicker;
    u.uFlickerSpeed.value = c.trailFlickerSpeed;

    u.uCoreSharp.value = c.trailCoreSharp;
    u.uCoreWidth.value = c.trailCoreWidth;
    u.uHaloFalloff.value = c.trailHaloFalloff;
    u.uHaloOpacity.value = c.trailHaloOpacity;
    u.uOpacity.value = c.trailOpacity * g.opacity;
    u.uGlow.value = c.trailGlow * g.glow;
    u.uSoftFade.value = c.trailSoftFade;

    u.uColorA.value.copy(getColor(c.colorTrailA));
    u.uColorB.value.copy(getColor(c.colorTrailB));
    u.uColorC.value.copy(getColor(c.colorTrailC));
    u.uColorD.value.copy(getColor(c.colorTrailD));
  };

  return material;
}

/* ------------------------------------------------------------------ */
/* 2 · The heads — small on purpose                                    */
/* ------------------------------------------------------------------ */

/**
 * A camera-facing quad per bolt, placed by the same `boltPoint()`.
 *
 * Small, and it must stay small: the trails are the read, and a big bright head
 * turns seven weaving ribbons into seven dots with smears behind them. The quad
 * is expanded along the view basis pulled out of `viewMatrix` rather than out of
 * a billboard matrix, because there is no model matrix on this mesh at all.
 */
const HEAD_VERTEX = /* glsl */ `
  ${VOLLEY_PATH}

  uniform float uTime;
  uniform float uQHead;
  uniform float uSize;
  uniform float uFade;

  attribute float aStrand;

  varying vec2  vQuad;
  varying float vViewZ;

  ${noiseGLSL}

  void main() {
    vQuad = position.xy;

    vec3 dir, n1, n2;
    volleyFrame(dir, n1, n2);
    vec3 here = boltPoint(aStrand, uQHead, n1, n2);

    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    float size = uSize * uFade;

    vec4 mv = viewMatrix * vec4(here + (right * position.x + up * position.y) * size, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const HEAD_FRAGMENT = /* glsl */ `
  uniform float uCoreSharp;
  uniform float uSoft;
  uniform float uGlow;
  uniform float uOpacity;
  uniform float uFade;
  uniform float uSoftFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorRim;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying vec2  vQuad;
  varying float vViewZ;

  ${commonGLSL}

  void main() {
    float r = length(vQuad);
    if (r > 1.0) discard;

    float core = pow(clamp(1.0 - r, 0.0, 1.0), max(uCoreSharp, 0.05));
    float bloom = pow(clamp(1.0 - r, 0.0, 1.0), max(uSoft, 0.05));

    vec3 color = (uColorCore * core + uColorRim * bloom) * uGlow * uGlobalGlow;
    float alpha = clamp(core + bloom * 0.6, 0.0, 1.0) * uOpacity * uFade;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

/** The head pass. One draw call, `bolts` instances. */
export function createVolleyHeadMaterial() {
  const ratios = [];
  for (let i = 0; i < MAX_BOLTS; i++) ratios.push(new Vector2(RATIOS[i][0], RATIOS[i][1]));

  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uHand: { value: new Vector3() },
      uTarget: { value: new Vector3(0, 0, 1) },
      uSide: { value: new Vector3(1, 0, 0) },
      uSeed: { value: 0 },
      uCount: { value: 7 },
      uRatio: { value: ratios },

      uWeaveSide: { value: 1.9 },
      uWeaveUp: { value: 1.2 },
      uWeaveTurns: { value: 1.0 },
      uWeavePhase: { value: Math.PI * 0.5 },
      uWeaveDecay: { value: 1.5 },
      uPathCurve: { value: 1.0 },
      uOrbitTurns: { value: 1.2 },
      uOrbitStart: { value: 0.25 },
      uChargeCurve: { value: 0.8 },

      uQHead: { value: 0 },
      uSize: { value: 0.11 },
      uFade: { value: 1 },
      uCoreSharp: { value: 3.4 },
      uSoft: { value: 1.1 },
      uGlow: { value: 2.4 },
      uOpacity: { value: 1 },
      uSoftFade: { value: 0.35 },
      uColorCore: { value: new Color(1, 1, 1) },
      uColorRim: { value: new Color(0.6, 0.4, 0.9) }
    }),
    vertexShader: HEAD_VERTEX,
    fragmentShader: HEAD_FRAGMENT
  });

  /**
   * The path half of this is the same state the trail is handed, so the two
   * cannot drift apart: they are literally the same numbers into the same
   * chunk.
   *
   * @param {object} state { hand, target, side, seed, count, qHead, fade }
   */
  material.userData.sync = (state) => {
    const c = settings.arcanevolley;
    const g = settings.global;
    const u = material.uniforms;

    u.uHand.value.copy(state.hand);
    u.uTarget.value.copy(state.target);
    u.uSide.value.copy(state.side);
    u.uSeed.value = state.seed;
    u.uCount.value = state.count;
    u.uQHead.value = state.qHead;
    u.uFade.value = state.fade;

    u.uWeaveSide.value = c.weaveSide;
    u.uWeaveUp.value = c.weaveUp;
    u.uWeaveTurns.value = c.weaveTurns;
    u.uWeavePhase.value = c.weavePhase;
    u.uWeaveDecay.value = c.weaveDecay;
    u.uPathCurve.value = c.pathCurve;
    u.uOrbitTurns.value = c.orbitTurns;
    u.uOrbitStart.value = c.orbitStart;
    u.uChargeCurve.value = c.chargeCurve;

    u.uSize.value = c.headSize;
    u.uCoreSharp.value = c.headCoreSharp;
    u.uSoft.value = c.headSoft;
    u.uGlow.value = c.headGlow * g.glow;
    u.uOpacity.value = c.headOpacity * g.opacity;
    u.uSoftFade.value = c.headSoftFade;
    u.uColorCore.value.copy(getColor(c.colorHeadCore));
    u.uColorRim.value.copy(getColor(c.colorHeadRim));
  };

  return material;
}

/**
 * The JS mirror of `boltPoint()`, for the handful of things the CPU has to
 * place against the flight: the dynamic light, the motes that come off a bolt,
 * and the point the volley converges on.
 *
 * **This function and the GLSL above are one thing in two languages.** Editing
 * either without the other is the single way to break this ability silently —
 * the bolts would fly one path and everything hung off them would sit on
 * another, and nothing would error.
 *
 * @param {object} c  the live settings block
 * @param {number} seed  the cast's unitless dice roll
 * @param {number} bolt  instance index
 * @param {number} count live bolt count
 * @param {number} q  the flight parameter; see the header
 * @param {THREE.Vector3} hand
 * @param {THREE.Vector3} target
 * @param {THREE.Vector3} n1 lateral basis
 * @param {THREE.Vector3} n2 vertical basis
 * @param {THREE.Vector3} out
 */
export function boltPointJS(c, seed, bolt, count, q, hand, target, n1, n2, out) {
  const TAU2 = Math.PI * 2;
  const tau = q < 0 ? 0 : q > 1 ? 1 : q;
  const wind = q < -1 ? -1 : q > 0 ? 0 : q;
  const ratio = RATIOS[Math.max(0, Math.min(MAX_BOLTS - 1, bolt))];

  let phase = (bolt / Math.max(1, count)) * TAU2 + seed;
  phase += wind * c.orbitTurns * TAU2;

  const grow = Math.pow(Math.max(0, 1 + wind), Math.max(0.05, c.chargeCurve));
  const gate = c.orbitStart + (1 - c.orbitStart) * grow;
  const decay = Math.pow(1 - tau, Math.max(0.01, c.weaveDecay)) * gate;

  out.copy(hand).lerp(target, Math.pow(tau, Math.max(0.05, c.pathCurve)));
  out.addScaledVector(n1, c.weaveSide * decay * Math.sin(TAU2 * ratio[0] * c.weaveTurns * tau + phase));
  out.addScaledVector(n2, c.weaveUp * decay * Math.sin(TAU2 * ratio[1] * c.weaveTurns * tau + phase + c.weavePhase));
  return out;
}
