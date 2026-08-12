import { ShaderMaterial, AdditiveBlending, NormalBlending, Color, DoubleSide, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { clamp } from '../utils/math.js';

/**
 * Hard ceiling on main arms in one slam. The editor's `arms` slider clamps
 * here, and the geometry is baked for this many whatever the slider says —
 * which is the whole reason `arms` can be dragged on a network that is already
 * lying on the floor.
 */
export const MAX_FISSURE_ARMS = 8;

/**
 * Which of the two passes over the same ribbon a material draws.
 *
 * They are *not* the same blend. The gash is alpha-blended, because a crack in
 * a stone floor is a hole and a hole is darker than the stone around it; the
 * underglow is additive, because the ember light in the bottom of it is not.
 * Every other two-pass effect in this project is additive twice over (the bolt,
 * the meteor's fissures) and that is exactly why those read as light and this
 * one reads as ground.
 */
export const FissurePass = Object.freeze({
  GASH: 0, // the open crack itself: dark seam, hot floor, white tip
  UNDERGLOW: 1 // the ember light it throws onto the stone either side
});

const TAU = Math.PI * 2;

/**
 * The whole fissure network lives in this vertex shader.
 *
 * A vertex arrives as a **unitless walk** — how far out along its arm it is,
 * how far that arm has veered by then, and which edge of the ribbon it is on —
 * and leaves as a world position. Nothing about the network's shape exists on
 * the CPU as a metre or a radian, which is the difference between this and
 * `effects/GroundFissures.js`: that one bakes `x, z` into a unit disc at spawn,
 * so its `wander` is frozen the instant a crater lands. Here the *angular
 * series* is baked and the radians are applied here, so `wander`, `armJitter`
 * and `arms` all re-draw a network that is already open, with the clock stopped.
 *
 * Three numbers stack into the shape:
 *
 *   1. **the bearing** — `spin + (arm + ½)/arms · 2π + jitter`. Rebuilt every
 *      frame from the live arm count, which is what lets five cracks become
 *      eight while you watch and stay evenly fanned.
 *   2. **the veer** — a baked unit-amplitude random walk in θ, multiplied by
 *      `uWander`. Zero wander gives you dead-straight spokes, which is a
 *      starburst and looks wrong; that is what the slider is for.
 *   3. **the offset** — forks only. A fork is stored in its *parent's* frame as
 *      (along, lateral) at the anchor's reach, so it swings with the parent
 *      instead of drifting off it when the wander is dragged.
 *
 * The tangent is analytic. For r ↦ r·(cos θ(r), sin θ(r)) the derivative is
 * `(cos θ − r·θ′·sin θ, sin θ + r·θ′·cos θ)`, and since θ′ is just the baked
 * rate times `uWander` we get the exact perpendicular for free. The first
 * version used a baked `aSide` copied off the generator, and the moment
 * `wander` moved the ribbon started leaning: the centreline had turned and the
 * width had not.
 *
 * **The propagation.** Each arm carries its own unitless speed dice and the
 * front is `age · mix(uSpeedMin, uSpeedMax, dice)` **metres of reach** — radial
 * distance from the centre, not arc length walked. That is deliberate. The
 * contract this ability is built on is that the fastest crack and the shockwave
 * ring touch the boundary on the same frame; parameterise the front on arc
 * length and a crack that wandered further arrives late, and the two events
 * come apart by a slider nobody thinks to look at.
 */
const FISSURE_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform vec3  uCentre;
  uniform float uRadius;
  uniform float uAge;
  uniform float uSpin;
  uniform float uArms;
  uniform float uArmJitter;
  uniform float uWander;
  uniform float uSpeedMin;
  uniform float uSpeedMax;
  uniform float uWidth;
  uniform float uWidthScale;
  uniform float uOpenLag;
  uniform float uForkFrac;
  uniform float uForkLength;

  /* position = (baseReach, along, lateral) — unit fractions of the footprint,
     never metres. See the class comment on TectonicAbility. */
  attribute vec4 aShape; // (wander, wanderRate, propagation, widthJitter)
  attribute vec4 aRole;  // (arm index, bearing jitter, fork progress, speed dice)
  attribute vec2 aEdge;  // (across the ribbon, fork rank)

  varying float vBehind;
  varying float vSince;
  varying float vAcross;
  varying float vTaper;
  varying float vProp;
  varying float vLive;

  void main() {
    float baseReach = position.x;
    float along = position.y;
    float lateral = position.z;

    float wander = aShape.x;
    float rate = aShape.y;
    float prop = aShape.z;
    float widthJit = aShape.w;

    float arm = aRole.x;
    float bearJit = aRole.y;
    float fork = aRole.z;
    float speed01 = aRole.w;

    float across = aEdge.x;
    float rank = aEdge.y;

    // An arm past the live count is culled, and so is a fork whose rank sits
    // above the density fraction. Main arms are rank 0 and survive everything.
    float live = step(arm, uArms - 0.5) * step(rank, uForkFrac);

    float bearing = uSpin + (arm + 0.5) / max(uArms, 1.0) * TAU + bearJit * uArmJitter;
    float theta = bearing + wander * uWander;
    float dTheta = rate * uWander;

    vec2 dir = vec2(cos(theta), sin(theta));
    vec2 tangent = normalize(vec2(dir.x - baseReach * dTheta * dir.y,
                                  dir.y + baseReach * dTheta * dir.x));
    vec2 sideDir = vec2(-tangent.y, tangent.x);

    vec2 unitPoint = dir * baseReach + tangent * along + sideDir * lateral;

    // A fork is pinched to a point wherever the length slider currently ends.
    float forkTaper = pow(clamp(1.0 - fork / max(uForkLength, 1e-3), 0.0, 1.0), 0.7);
    float taper = mix(1.0, forkTaper, step(1e-4, fork));

    float speed = max(mix(uSpeedMin, uSpeedMax, speed01), 0.01);
    float behind = uAge * speed - prop * uRadius;   // metres of reach behind the tip

    // The crack is a hairline at the tip and opens out behind it: it unzips
    // rather than appearing at full width, which is most of what sells the
    // motion. The first cut opened instantly and read as a decal being wiped on.
    float openWidth = smoothstep(0.0, max(uOpenLag, 0.01), behind);
    float halfWidth = uWidth * 0.5 * uWidthScale * widthJit * taper * openWidth * live;

    vec3 world = uCentre + vec3(unitPoint.x * uRadius + sideDir.x * across * halfWidth,
                                0.0,
                                unitPoint.y * uRadius + sideDir.y * across * halfWidth);

    vBehind = behind;
    vSince = behind / speed;    // seconds this point has been open — the ember clock
    vAcross = across;
    vTaper = taper;
    vProp = prop;
    vLive = live;

    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const FISSURE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uRadius;
  uniform float uFade;
  uniform float uSeed;
  uniform float uTipFeather;
  uniform float uHeat;
  uniform float uCool;
  uniform float uPulse;
  uniform float uFlicker;
  uniform float uTipFlash;
  uniform float uGrain;
  uniform float uPassOpacity;
  uniform float uGlobalGlow;
  uniform float uShaderIntensity;
  uniform vec3  uColorSeam;
  uniform vec3  uColorRed;
  uniform vec3  uColorEmber;
  uniform vec3  uColorHot;

  varying float vBehind;
  varying float vSince;
  varying float vAcross;
  varying float vTaper;
  varying float vProp;
  varying float vLive;

  ${noiseGLSL}

  void main() {
    if (vLive < 0.5) discard;

    // Nothing exists in front of the tip.
    float open = smoothstep(0.0, max(uTipFeather, 0.005), vBehind);
    if (open < 0.002) discard;

    /*
     * The cooling is the point of the ability, so it is a real exponential on
     * the *local* clock rather than one fade over the whole network: a point
     * one metre out has been open for far longer than a point on the rim, so
     * by the time the boundary is still tearing white the middle is already
     * dull basalt. Fading the lot together looked like a light being switched
     * off, which is the one thing cooling stone does not do.
     */
    float cool = exp(-max(vSince, 0.0) / max(uCool, 0.02));

    float grain = snoise01(vec3(vProp * uRadius * 2.7, vAcross * 1.6, uSeed));
    float pulse = sin(vProp * uRadius * 3.1 - uTime * uPulse) * 0.22 + 0.78;
    float flick = mix(1.0, snoise01(vec3(vProp * 7.3, uTime * 2.6, uSeed + 4.1)), uFlicker);

    float across = abs(vAcross);
    float centreness = 1.0 - smoothstep(0.1, 1.0, across);
    float lip = 1.0 - smoothstep(0.78, 1.0, across);
    // A white flash rides the tearing tip itself.
    float flash = (1.0 - smoothstep(0.0, max(uTipFeather * 2.5, 0.01), abs(vBehind))) * uTipFlash;

    float heat = uHeat * cool * centreness * pulse * flick * (vTaper * 0.4 + 0.6) + flash;

    #if TECTONIC_PASS == 0                                    /* THE GASH */
      vec3 color = mix(uColorSeam, uColorRed, smoothstep(0.0, 0.5, heat));
      color = mix(color, uColorEmber, smoothstep(0.5, 1.1, heat));
      color = mix(color, uColorHot, smoothstep(1.1, 2.0, heat));
      // Only the hot part of the gash answers to the global glow. Multiplying
      // the cold seam by it as well made a dead crack brighten when the bloom
      // was turned up, which is backwards.
      color *= mix(1.0, uGlobalGlow, smoothstep(0.2, 1.2, heat));
      float alpha = open * lip * uFade * uPassOpacity * mix(1.0, grain, uGrain);

    #else                                                     /* THE UNDERGLOW */
      float falloff = pow(max(1.0 - across, 0.0), 1.7);
      float strength = falloff * heat * 0.4;
      vec3 color = (uColorEmber * strength + uColorHot * flash * 0.5) * uGlobalGlow;
      float alpha = open * uFade * uPassOpacity * clamp(strength * 2.0, 0.0, 1.0);
    #endif

    if (alpha < 0.004) discard;
    gl_FragColor = vec4(clamp(color * mix(0.7, 1.0, uShaderIntensity), 0.0, 64.0),
                        clamp(alpha, 0.0, 1.0));
  }
`;

/**
 * One pass of the fissure network.
 *
 * Both passes share the geometry and every uniform except `uWidthScale` and
 * `uPassOpacity`, so `userData.sync()` can be handed the same state object for
 * each and the editor drives them together — the convention
 * `materials/LightningMaterial.js` established.
 *
 * @param {number} pass FissurePass.*
 */
export function createFissureMaterial(pass = FissurePass.GASH) {
  const glow = pass === FissurePass.UNDERGLOW;

  const material = new ShaderMaterial({
    defines: { TECTONIC_PASS: pass },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: glow ? AdditiveBlending : NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uCentre: { value: new Vector3() },
      uRadius: { value: 7 },
      uAge: { value: 0 },
      uFade: { value: 1 },
      uSeed: { value: 0 },
      uSpin: { value: 0 },

      uArms: { value: 5 },
      uArmJitter: { value: 0.22 },
      uWander: { value: 1.1 },
      uSpeedMin: { value: 9 },
      uSpeedMax: { value: 17 },

      uWidth: { value: 0.5 },
      uWidthScale: { value: glow ? 3.4 : 1 },
      uOpenLag: { value: 0.9 },
      uTipFeather: { value: 0.3 },
      uForkFrac: { value: 0.7 },
      uForkLength: { value: 0.8 },

      uHeat: { value: 1.6 },
      uCool: { value: 1.1 },
      uPulse: { value: 3.2 },
      uFlicker: { value: 0.35 },
      uTipFlash: { value: 1.6 },
      uGrain: { value: 0.45 },
      uPassOpacity: { value: glow ? 0.5 : 1 },

      uColorSeam: { value: new Color(0.05, 0.04, 0.03) },
      uColorRed: { value: new Color(0.5, 0.13, 0.03) },
      uColorEmber: { value: new Color(1, 0.48, 0.16) },
      uColorHot: { value: new Color(1, 0.85, 0.63) }
    }),
    vertexShader: FISSURE_VERTEX,
    fragmentShader: FISSURE_FRAGMENT
  });

  material.name = glow ? 'TectonicUnderglow' : 'TectonicGash';

  /**
   * Push the live settings and the cast's dice into this pass.
   *
   * `state` carries **only** dice rolls and clocks: where the slam landed, how
   * long ago it landed, the cast's seed and its spin fraction. Every metre,
   * radian and second below is re-read from `settings.tectonic` on the frame it
   * is used, including a zero-length one.
   *
   * @param {object} state { centre, age, fade, seed, spin }
   */
  material.userData.sync = (state) => {
    const c = settings.tectonic;
    const g = settings.global;
    const u = material.uniforms;

    u.uCentre.value.copy(state.centre);
    u.uCentre.value.y = c.fissureHeight;
    u.uAge.value = state.age;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;
    // A unitless dice roll on the CPU; the turn is applied here, so the cast
    // never wrote down a radian (I1).
    u.uSpin.value = state.spin * TAU;

    u.uRadius.value = Math.max(0.2, c.zoneRadius);
    u.uArms.value = clamp(Math.round(c.arms), 1, MAX_FISSURE_ARMS);
    u.uArmJitter.value = c.armJitter;
    u.uWander.value = c.wander * g.randomness;
    u.uSpeedMin.value = Math.max(0.2, c.fissureSpeed) * g.speed;
    u.uSpeedMax.value = Math.max(0.2, c.fissureSpeed * (1 + Math.max(0, c.speedSpread))) * g.speed;

    u.uWidth.value = c.fissureWidth;
    u.uWidthScale.value = glow ? c.glowWidth : 1;
    u.uOpenLag.value = c.openLag;
    u.uTipFeather.value = c.tipFeather;
    u.uForkFrac.value = c.forks;
    u.uForkLength.value = c.forkLength;

    u.uHeat.value = c.emberHeat * g.shaderIntensity;
    u.uCool.value = c.emberCool;
    u.uPulse.value = c.emberPulse;
    u.uFlicker.value = c.emberFlicker;
    u.uTipFlash.value = c.tipFlash;
    u.uGrain.value = c.fissureGrain * g.noiseStrength;
    u.uPassOpacity.value = (glow ? c.glowOpacity : c.gashOpacity) * g.opacity;

    u.uColorSeam.value.copy(getColor(c.colorSeam));
    u.uColorRed.value.copy(getColor(c.colorMagma));
    u.uColorEmber.value.copy(getColor(c.colorEmber));
    u.uColorHot.value.copy(getColor(c.colorHot));
  };

  return material;
}

/** The layer both passes are drawn on — VFX, like every other ribbon here. */
export const FISSURE_LAYER = LAYER.VFX;
