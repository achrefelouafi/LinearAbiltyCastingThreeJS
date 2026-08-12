import { ShaderMaterial, AdditiveBlending, NormalBlending, Color, DoubleSide, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/* ====================================================================== */
/* SINGULARITY — the two bespoke shaders the well needs                    */
/* ====================================================================== */
/**
 * Everything else about this ability is library work: the lens is
 * `vfx/Distortion.js` in `LENS` mode, the dust is `vfx/Swarm.js`, the hole in
 * the floor is `vfx/GroundField.js` in `FUNNEL` mode. Two things are not, and
 * they are both here:
 *
 *  1. **the infall** — instanced ribbons on a genuine angular-momentum orbit,
 *     and
 *  2. **the event horizon** — a camera-facing disc that is the only object in
 *     the project which is *darker* than what it covers.
 *
 * Neither is a recolour of anything in `src/materials`, and the first one is
 * the reason this file exists rather than a `FilamentPaths` role: `SPIRAL_IN`
 * draws a spiral whose whole pattern rotates rigidly, which means every point
 * on it turns at the same rate. A body falling into a well does not do that.
 * The whole read of an accretion disc is that the inside laps the outside, and
 * you only get that from the conservation law.
 */

/* ---------------------------------------------------------------------- */
/* The infall                                                              */
/* ---------------------------------------------------------------------- */
/**
 * One vertex arrives as `(t, side)` — how far along a stream's tail it is and
 * which edge of the ribbon it sits on — and leaves as a world position on a
 * Keplerian in-spiral. There is no path on the CPU, no per-stream record, and
 * no integrated angle anywhere; the shape is a closed-form function of the
 * cast's age and the numbers in `settings.singularity`.
 *
 * ## The orbit, and why it is closed form
 *
 * Specific angular momentum is conserved: `r² · dθ/dt = L`. Let a stream's
 * radius fall linearly from its own starting radius `r0` to the horizon `rh`
 * over `fallTime` seconds, so with `τ` running 0..1 over that fall,
 *
 * ```
 *   r(τ)  = r0 + (rh − r0) · τ
 *   θ(τ)  = θ0 + L · T · ∫ dτ / r²  =  θ0 + ω0 · T · τ · r0 / r(τ)
 * ```
 *
 * — because the integral of `1/(r0 + cτ)²` is `τ / (r0 · r(τ))`, which is one
 * multiply and one divide, and `L = ω0 · r0²` names the constant as *the
 * angular rate at the widest point*, which is a slider a person can reason
 * about. At the horizon the sweep rate is `r0/rh` times what it was on the
 * outside: with a 5 m disc closing onto a 0.6 m horizon, the last turn is taken
 * eight times faster than the first. That ratio is the entire effect.
 *
 * The first version integrated `theta += omega * dt` on the CPU and kept it in
 * a per-stream record. It looked identical for about a second and then drifted
 * apart from the settings entirely: pausing and dragging `orbitRate` did
 * nothing, because the angle already banked was not a function of the slider
 * any more. Closed form is not an optimisation here, it is invariant **I1**.
 *
 * ## The tail, which stretches for free
 *
 * A stream's ribbon samples the same orbit at `τ − (1 − t) · trailTime / T`, so
 * the tail is a fixed window of *time* behind the head, not a fixed length. The
 * head near the horizon is moving many times faster than one out on the rim, so
 * the same half-second of history covers many times more arc — the streams
 * visibly stretch as they fall in, and nothing in the code says so. Tapering
 * the trail by length instead was the first attempt and it reads as a comet
 * pinned to a wire: the tail has to be a memory, not a shape.
 *
 * Sampling with `τ` allowed to go negative matters too. Clamping it at zero
 * bunched every tail up at the birth radius into a bright bead on the rim; a
 * negative τ simply puts the tail further out than the stream has yet been,
 * which is where it was.
 */
const INFALL_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uAge;          // seconds since the cast began
  uniform vec3  uCentre;       // the well, world metres
  uniform float uSeed;         // per-cast dice roll, unitless

  /* --- the orbit --- */
  uniform float uFallTime;     // seconds one stream takes to reach the horizon
  uniform float uRadiusInner;  // metres — the tightest starting orbit
  uniform float uRadiusOuter;  // metres — the widest
  uniform float uHorizon;      // metres — where a stream is swallowed
  uniform float uOrbitRate;    // radians/second at the widest orbit
  uniform float uInclination;  // radians the orbits tilt out of the disc plane
  uniform float uFlatten;      // 0 a flat disc, 1 a sphere of orbits
  uniform float uEject;        // metres of outward blow-out (the collapse)
  uniform float uTrailTime;    // seconds of history in a stream's tail
  uniform float uWobble;       // metres of lateral slop on a stream
  uniform float uWobbleTurns;  // wobbles per turn of the orbit

  /* --- the ribbon --- */
  uniform float uWidth;        // half-width at the head, metres
  uniform float uWidthTail;    // that width at the tail, as a fraction
  uniform float uWidthCurve;   // how early the taper happens
  uniform float uWidthNear;    // extra width at the horizon, × uWidth
  uniform float uEnter;        // fraction of the fall spent fading in
  uniform float uExit;         // ... and fading out
  uniform float uOpen;         // 0..1 how much of the disc exists yet
  uniform float uFade;         // master fade

  attribute float aStrand;

  varying float vT;
  varying float vSide;
  varying float vTau;
  varying float vAlpha;
  varying float vViewZ;

  ${noiseGLSL}

  /**
   * Where one stream is at fall parameter tau. Tau may run negative — that is
   * the tail, still out where the stream has not been yet.
   */
  vec3 orbitAt(float tau, float bearing, float rDice, float tilt) {
    float r0 = mix(uRadiusInner, uRadiusOuter, rDice);
    float rh = max(min(uHorizon, r0), 0.02);
    float r = mix(r0, rh, tau);
    // r is linear in tau and never reaches zero, so the closed form below has
    // no singularity in it — the *hole* has one, the maths does not.
    float theta = bearing + uOrbitRate * uFallTime * tau * (r0 / max(r, 1e-3));

    float span = max(r + uEject, 0.0);
    float c = cos(tilt);
    float s = sin(tilt);

    vec3 p = uCentre;
    p.x += cos(theta) * span * c;
    p.z += sin(theta) * span * c;
    p.y += s * span * uFlatten;

    // Phase-locked to the orbit rather than to the clock: a wobble keyed off
    // time slides along a stream and reads as a wet noodle, while one keyed off
    // theta is a fixed corrugation the stream travels through.
    float w = theta * uWobbleTurns;
    p += vec3(sin(w + uSeed), cos(w * 1.31 + bearing * 7.0), sin(w * 0.87 + rDice * 13.0)) * uWobble;
    return p;
  }

  void main() {
    float t = position.x;      // 0 at the tail, 1 at the head
    float side = position.y;

    vec3 dice = hash31(aStrand * 3.77 + uSeed * 1.31 + 0.5);
    float bearing = dice.x * TAU;
    float rDice = dice.y;
    float tilt = (dice.z - 0.5) * 2.0 * uInclination;
    float phase = hash11(aStrand * 9.13 + uSeed + 4.7);

    float fall = max(uFallTime, 0.05);
    // Each stream runs its own loop of the fall, offset by its dice. The cast's
    // own age drives it, not the shared clock, so a fresh cast starts with the
    // disc already populated instead of with everything on the rim at once.
    float head = fract(uAge / fall + phase);
    float tau = head - (1.0 - t) * (uTrailTime / fall);

    vec3 here = orbitAt(tau, bearing, rDice, tilt);
    vec3 back = orbitAt(tau - 0.015, bearing, rDice, tilt);
    vec3 tangent = here - back;
    tangent = length(tangent) > 1e-6 ? normalize(tangent) : vec3(0.0, 1.0, 0.0);

    /* Turn the ribbon edge-on to the eye, the way the bolt does. */
    vec3 toCamera = normalize(cameraPosition - here);
    vec3 binormal = cross(tangent, toCamera);
    float bl = length(binormal);
    binormal = bl > 1e-4 ? binormal / bl : vec3(1.0, 0.0, 0.0);

    float taper = pow(clamp(t, 0.0, 1.0), max(uWidthCurve, 0.01));
    float halfWidth = uWidth * mix(uWidthTail, 1.0, taper);
    halfWidth *= mix(1.0, uWidthNear, clamp(head, 0.0, 1.0));

    float appear = smoothstep(0.0, max(uEnter, 1e-3), head);
    float vanish = 1.0 - smoothstep(1.0 - max(uExit, 1e-3), 1.0, head);
    vAlpha = appear * vanish * uFade * clamp(uOpen, 0.0, 1.0);

    vT = t;
    vSide = side;
    vTau = head;

    // World space throughout: the ability's group is an identity transform.
    vec4 mv = viewMatrix * vec4(here + binormal * side * halfWidth, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const INFALL_FRAGMENT = /* glsl */ `
  uniform float uCoreSharp;    // how hard the hot core falls off across the ribbon
  uniform float uHeat;         // how much of the colour walk the fall owns
  uniform float uGlow;
  uniform float uOpacity;
  uniform float uSoftFade;
  uniform vec3  uColorTail;
  uniform vec3  uColorHead;
  uniform vec3  uColorCore;
  uniform vec3  uColorHalo;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying float vT;
  varying float vSide;
  varying float vTau;
  varying float vAlpha;
  varying float vViewZ;

  ${commonGLSL}

  void main() {
    if (vAlpha < 0.003) discard;

    float v = clamp(abs(vSide), 0.0, 1.0);
    float profile = pow(1.0 - v, max(uCoreSharp, 0.05));

    // Two walks along one gradient, weighted by uHeat: how far down the well
    // the stream is, and how near the head of its own tail this fragment is.
    // At uHeat = 1 the whole disc reddens together as it collapses; at 0 each
    // stream is cold at the tail and hot at the nose whatever its radius.
    float heat = clamp(mix(vT, vTau, clamp(uHeat, 0.0, 1.0)), 0.0, 1.0);
    vec3 body = mix(uColorTail, uColorHead, heat);

    vec3 colour = mix(uColorHalo, body, profile);
    colour = mix(colour, uColorCore, smoothstep(0.55, 1.0, profile) * heat);

    float alpha = profile * vAlpha * uOpacity;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    colour *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(colour, alpha);
  }
`;

/**
 * The instanced in-spiral. One draw call, however many streams.
 *
 * Pairs with `createBoltRibbonGeometry(nodes, streams)` — the same ribbon strip
 * the bolt uses, because the vertex contract (`position.x` along, `position.y`
 * across, `aStrand` per instance) is exactly the same and a second copy of that
 * buffer builder would be a second thing to keep in step.
 */
export function createInfallMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uAge: { value: 0 },
      uCentre: { value: new Vector3() },
      uSeed: { value: 0 },

      uFallTime: { value: 2.4 },
      uRadiusInner: { value: 1.8 },
      uRadiusOuter: { value: 4.8 },
      uHorizon: { value: 0.6 },
      uOrbitRate: { value: 1.05 },
      uInclination: { value: 0.42 },
      uFlatten: { value: 0.55 },
      uEject: { value: 0 },
      uTrailTime: { value: 0.55 },
      uWobble: { value: 0.1 },
      uWobbleTurns: { value: 3 },

      uWidth: { value: 0.07 },
      uWidthTail: { value: 0.15 },
      uWidthCurve: { value: 1.5 },
      uWidthNear: { value: 1.8 },
      uEnter: { value: 0.12 },
      uExit: { value: 0.06 },
      uOpen: { value: 0 },
      uFade: { value: 1 },

      uCoreSharp: { value: 2.6 },
      uHeat: { value: 0.72 },
      uGlow: { value: 2.2 },
      uOpacity: { value: 1 },
      uSoftFade: { value: 0.4 },
      uColorTail: { value: new Color('#3a1f7a') },
      uColorHead: { value: new Color('#b58cff') },
      uColorCore: { value: new Color('#ffffff') },
      uColorHalo: { value: new Color('#160a2e') }
    }),
    vertexShader: INFALL_VERTEX,
    fragmentShader: INFALL_FRAGMENT
  });

  /**
   * Push the live settings and the cast's own beats into the uniforms.
   *
   * Called every frame, zero-length frames included. `state` carries only
   * unitless beats, a seed and a world point; every metre, radian and second
   * below is read out of `settings.singularity` right here.
   *
   * @param {object} state { centre, age, seed, open, pull, blow, fade }
   */
  material.userData.sync = (state) => {
    const c = settings.singularity;
    const g = settings.global;
    const u = material.uniforms;

    u.uCentre.value.copy(state.centre);
    u.uAge.value = state.age;
    u.uSeed.value = state.seed;
    u.uOpen.value = state.open;
    u.uFade.value = state.fade;

    // The disc is narrower while the well is still forming and while the pull
    // is hauling it in — both of those are a *fraction* on the beat side and a
    // metre on the settings side, which is the split invariant I1 asks for.
    const wide = c.discOuter * c.zoneRadius;
    const tight = c.discInner * c.zoneRadius;
    const draw = 1 - c.discDraw * state.pull;
    u.uRadiusOuter.value = wide * (c.discSeed + (1 - c.discSeed) * state.open) * draw;
    u.uRadiusInner.value = tight * (c.discSeed + (1 - c.discSeed) * state.open) * draw;
    u.uHorizon.value = c.horizonRadius * c.discSwallow;

    u.uFallTime.value = Math.max(0.05, c.fallTime * (1 - c.fallSpeedUp * state.pull));
    u.uOrbitRate.value = c.orbitRate * (1 + c.orbitPull * state.pull);
    u.uInclination.value = c.inclination;
    u.uFlatten.value = c.flatten;
    u.uEject.value = c.ejectDistance * state.blow * g.explosionIntensity;
    u.uTrailTime.value = c.trailTime;
    u.uWobble.value = c.streamWobble * g.randomness * g.noiseStrength;
    u.uWobbleTurns.value = c.streamWobbleTurns * g.noiseFrequency;

    u.uWidth.value = c.streamWidth;
    u.uWidthTail.value = c.streamWidthTail;
    u.uWidthCurve.value = c.streamWidthCurve;
    u.uWidthNear.value = c.streamWidthNear;
    u.uEnter.value = c.streamEnter;
    u.uExit.value = c.streamExit;

    u.uCoreSharp.value = c.streamCoreSharp;
    u.uHeat.value = c.streamHeat;
    u.uGlow.value = c.streamGlow * g.glow;
    u.uOpacity.value = c.streamOpacity * g.opacity;
    u.uSoftFade.value = c.streamSoftFade;
    u.uColorTail.value.copy(getColor(c.colorStreamTail));
    u.uColorHead.value.copy(getColor(c.colorStreamHead));
    u.uColorCore.value.copy(getColor(c.colorStreamCore));
    u.uColorHalo.value.copy(getColor(c.colorStreamHalo));
  };

  return material;
}

/* ---------------------------------------------------------------------- */
/* The event horizon                                                       */
/* ---------------------------------------------------------------------- */
/**
 * The quad is built in the vertex shader from an anchor and a half-extent in
 * metres, the way `vfx/Distortion.js` builds its emitters, so the mesh's matrix
 * stays identity and moving or resizing the horizon is a uniform write. Placing
 * it with `mesh.position` and `mesh.scale` instead works right up until you
 * pause and drag `horizonRadius`, at which point the *shader* is still thinking
 * in the old metres while the matrix has moved on.
 */
const HORIZON_VERTEX = /* glsl */ `
  uniform vec3  uCentre;
  uniform float uSize;      // half-extent of the quad, metres

  varying vec2  vLocal;     // metres from the centre, in the billboard plane
  varying float vViewZ;

  void main() {
    // viewMatrix's rows are the camera's basis in world space.
    vec3 ax = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 ay = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

    vec2 ext = (uv - 0.5) * 2.0 * uSize;
    vec3 world = uCentre + ax * ext.x + ay * ext.y;
    vLocal = ext;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * Three concentric statements, and the first one is the unusual one.
 *
 * **The interior is drawn, not left out.** Every other emissive surface in this
 * project adds light; this one alpha-blends a colour darker than the floor over
 * the top of whatever is behind it, which is the only way a hole reads on a
 * renderer with bloom turned up. Additive blending cannot make anything darker,
 * so an "invisible" hole with additive blending is not a hole — it is a gap you
 * can see the accretion streams through, and the illusion dies instantly.
 *
 * **The photon ring is offset outward.** A real one sits at 1.5 Schwarzschild
 * radii and it is worth honouring, because a bright ring drawn exactly on the
 * silhouette edge reads as an outline on a sticker. The gap between the black
 * and the light is what makes it look like something in front of the light.
 *
 * **One side is brighter.** Relativistic beaming: the half of the disc rotating
 * toward the eye is the bright one. Faked as a lateral gradient on the ring,
 * signed by the disc's spin, which costs one dot product and is the single
 * cheapest cue in the file that the thing is *turning*.
 */
const HORIZON_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uRadius;      // the horizon, metres
  uniform float uEdge;        // metres of feather on it
  uniform float uRing;        // photon-ring radius, × uRadius
  uniform float uRingWidth;   // metres
  uniform float uRingGlow;
  uniform float uDoppler;     // 0..1 brightness asymmetry across the disc
  uniform float uHalo;        // metres the outer bloom reaches
  uniform float uHaloGlow;
  uniform float uRim;         // brightness of the sheen inside the ring
  uniform float uShimmer;     // 0..1 wobble on the ring's radius
  uniform float uShimmerRate; // cycles/second
  uniform float uOpacity;
  uniform float uFade;
  uniform float uSoftFade;
  uniform vec3  uColorVoid;
  uniform vec3  uColorRim;
  uniform vec3  uColorRing;
  uniform vec3  uColorHalo;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying vec2  vLocal;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    float d = length(vLocal);
    float rr = max(uRadius, 1e-3);

    // Sampled in the plane, never on atan(y, x): an angular lookup gives every
    // radius along a bearing the same value and the ring breaks into spokes.
    float wobble = snoise(vec3(vLocal * 2.7, uTime * uShimmerRate));
    float ringR = rr * uRing * (1.0 + uShimmer * wobble);

    float inside = 1.0 - smoothstep(rr - uEdge, rr + uEdge, d);
    float ring = exp(-abs(d - ringR) / max(uRingWidth, 1e-3));
    float halo = exp(-max(d - ringR, 0.0) / max(uHalo, 1e-3)) * (1.0 - inside);

    float side = d > 1e-4 ? vLocal.x / d : 0.0;
    ring *= clamp(1.0 + uDoppler * side, 0.0, 2.0);

    vec3 colour = uColorVoid * inside;
    colour += uColorRim * inside * smoothstep(rr * 0.3, rr, d) * uRim;
    colour += uColorRing * ring * uRingGlow;
    colour += uColorHalo * halo * uHaloGlow;

    float alpha = clamp(max(inside, max(ring, halo * 0.8)), 0.0, 1.0) * uOpacity * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    // The interior is deliberately left out of the glow multiplier: multiplying
    // a near-black by the bloom gain is how a black hole ends up grey.
    colour = uColorVoid * inside + (colour - uColorVoid * inside) * uGlobalGlow;
    gl_FragColor = vec4(colour, alpha);
  }
`;

/**
 * The horizon disc. One draw call, alpha-blended, no depth write.
 *
 * Give it a render order *above* the infall so it covers the streams that have
 * reached it — matter arriving at the horizon should stop existing, and letting
 * the ribbons draw over the black is what makes the well look like a decal.
 */
export function createHorizonMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uCentre: { value: new Vector3() },
      uSize: { value: 1 },

      uRadius: { value: 0.62 },
      uEdge: { value: 0.05 },
      uRing: { value: 1.16 },
      uRingWidth: { value: 0.05 },
      uRingGlow: { value: 3.4 },
      uDoppler: { value: 0.55 },
      uHalo: { value: 0.42 },
      uHaloGlow: { value: 1.4 },
      uRim: { value: 0.5 },
      uShimmer: { value: 0.12 },
      uShimmerRate: { value: 0.7 },
      uOpacity: { value: 1 },
      uFade: { value: 1 },
      uSoftFade: { value: 0.3 },
      uColorVoid: { value: new Color('#0a0612') },
      uColorRim: { value: new Color('#6a3fd0') },
      uColorRing: { value: new Color('#ffffff') },
      uColorHalo: { value: new Color('#8a5cf0') }
    }),
    vertexShader: HORIZON_VERTEX,
    fragmentShader: HORIZON_FRAGMENT
  });

  /**
   * @param {object} state { centre, open, blow, fade }
   */
  material.userData.sync = (state) => {
    const c = settings.singularity;
    const g = settings.global;
    const u = material.uniforms;

    u.uCentre.value.copy(state.centre);

    // The horizon opens out of nothing and is *torn* open by the collapse
    // before it goes — the last frame of a singularity should be big, not dim.
    const radius = c.horizonRadius * (c.horizonSeed + (1 - c.horizonSeed) * state.open)
      * (1 + c.horizonBurst * state.blow);
    u.uRadius.value = radius;
    u.uEdge.value = c.horizonEdge;
    u.uRing.value = c.horizonRing;
    u.uRingWidth.value = c.horizonRingWidth;
    u.uRingGlow.value = c.horizonRingGlow * g.glow;
    u.uDoppler.value = c.horizonDoppler;
    u.uHalo.value = c.horizonHalo;
    u.uHaloGlow.value = c.horizonHaloGlow * g.glow;
    u.uRim.value = c.horizonRim;
    u.uShimmer.value = c.horizonShimmer * g.noiseStrength;
    u.uShimmerRate.value = c.horizonShimmerRate * g.noiseSpeed;
    u.uOpacity.value = c.horizonOpacity * g.opacity;
    u.uFade.value = state.fade;
    u.uSoftFade.value = c.horizonSoftFade;

    // The quad has to cover the ring and the whole exponential tail of the
    // halo, or the bloom is cut off in a square — resolved from the same live
    // metres, never guessed at.
    u.uSize.value = radius * c.horizonRing + c.horizonHalo * 4 + c.horizonRingWidth * 3;

    u.uColorVoid.value.copy(getColor(c.colorVoid));
    u.uColorRim.value.copy(getColor(c.colorRim));
    u.uColorRing.value.copy(getColor(c.colorRing));
    u.uColorHalo.value.copy(getColor(c.colorHorizonHalo));
  };

  return material;
}
