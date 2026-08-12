import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  NormalBlending,
  ShaderMaterial,
  Sphere,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { getColor } from '../utils/color.js';

/**
 * FirewalkMaterial — the two shaders behind Firewalk, and the gait they share.
 *
 * ## Why there is a shared placement chunk
 *
 * Firewalk draws two instanced meshes: a flat sole on the floor and a short
 * pillar of flame standing on it. They are two programs because one is a ground
 * quad and the other is a billboard, but they must agree on **where the print
 * is** to within nothing at all — a pillar standing a centimetre off its own
 * footprint is immediately, obviously wrong, and it is wrong on every frame the
 * two are updated a step apart.
 *
 * So the gait lives in `PRINT_PLACEMENT_GLSL`, both vertex stages inject it,
 * and `createFirewalkPlacement()` hands both materials the **same uniform
 * objects** — not copies. One write per frame drives both, exactly the trick
 * `EmberTrailMaterial` uses to nail a ribbon to its bird.
 *
 * The alternative — resolving the print positions on the CPU and pushing them
 * into an instanced attribute — was written first and thrown away twice over.
 * It is a per-frame write of *metres* into a buffer, so `stride` and `stepLength`
 * stop being live the moment you stop resolving them (invariant I1 by
 * discipline rather than by construction), and it needs the two meshes updated
 * in lockstep for exactly the reason above. Here a print's position is
 * `origin + forward·(start + i·step) + side·(±stride)` evaluated in the vertex
 * shader, so dragging `stride` on a paused frame walks the whole trail sideways
 * and takes the pillars with it.
 *
 * ## What a print carries
 *
 * Four instanced floats, and not one of them is a dimension:
 *
 *   - `aIndex` — which footfall this is. Its **parity is the gait**: even prints
 *     go left, odd prints right. Nothing else in the file knows about feet.
 *   - `aSeed` — a dice roll, so the grain and the sway differ print to print.
 *   - `aWander` — a second dice roll, −1..1, multiplied by a live `uWander` in
 *     metres. It is an attribute rather than a hash of the seed so that the CPU
 *     knows the *exact* offset a print was given: the light, the sparks and the
 *     volume hull all have to stand on the print the shader drew, and a
 *     JavaScript re-implementation of a GLSL hash agrees to about five decimal
 *     places on a good day and to none at all on a driver that runs `mediump`.
 *   - `aBirth` — the timestamp the front crossed it, or a negative number if it
 *     has not been stepped on yet. An unlit print is culled in the vertex shader
 *     rather than scaled to zero, because a degenerate quad still rasterises a
 *     seam of fragments on some drivers and the whole trail was faintly visible
 *     before the cast reached it.
 *
 * The three geometry helpers share **one set of attribute objects** between the
 * two meshes, for the same reason the uniforms are shared: three keys its GPU
 * buffers by attribute identity, so this is also one upload rather than two.
 */

/* ====================================================================== */
/* The gait                                                               */
/* ====================================================================== */
/**
 * Where footfall `i` is, in world metres, resolved from live uniforms.
 *
 * `printSide()` is the whole silhouette trick reduced to one line: a walk is
 * not a line of marks down the middle, it is two lines of marks either side of
 * the middle, taken in turn. The first version put every print on the centre
 * line with a lateral jitter and it read as scorch blotches — the eye needs the
 * *regular alternation* to reconstruct a body. Stride is what makes it a walk,
 * so it is a slider, and at zero the trail collapses back into blotches, which
 * is a useful thing to be able to see.
 *
 * Self-contained: no noise library, no shared helpers. Both vertex stages inject
 * it and nothing else.
 */
export const PRINT_PLACEMENT_GLSL = /* glsl */ `
  uniform vec3  uOrigin;      // world, on the floor, where the walk starts
  uniform vec3  uForward;     // unit, downrange
  uniform vec3  uSide;        // unit, lateral
  uniform float uStart;       // metres before the first print
  uniform float uStep;        // metres between successive footfalls
  uniform float uStride;      // metres from the centre line to a print
  uniform float uWander;      // metres of per-print lateral slop
  uniform float uNow;         // the ability's age, seconds

  attribute float aIndex;     // footfall number; its parity is the foot
  attribute float aSeed;      // dice roll
  attribute float aWander;    // dice roll, -1..1, in units of uWander
  attribute float aBirth;     // seconds; negative until the front crosses it

  /** -1 for a left print, +1 for a right one. */
  float printSide(float index) {
    return mod(index, 2.0) < 0.5 ? -1.0 : 1.0;
  }

  vec3 printCentre(float index, float wander) {
    float lateral = printSide(index) * uStride + wander * uWander;
    return uOrigin + uForward * (uStart + index * uStep) + uSide * lateral;
  }
`;

/* ====================================================================== */
/* The sole                                                               */
/* ====================================================================== */
/**
 * The footprint itself: one instanced ground quad per print, carrying a signed
 * distance field of a sole.
 *
 * The field is authored **right-footed** and a left print is drawn by mirroring
 * its own local x on the way into the fragment stage. That is one multiply, and
 * it is the only reason two feet are not two sets of constants that drift apart
 * the first time somebody tunes the arch.
 *
 * Four pieces, unioned: a heel, a waist pushed to the outer edge (the arch is
 * the *absence* on the medial side, which is what makes the shape read as a
 * foot rather than as a bean), a ball, and five separate toes. The toes are
 * unioned with a hard `min` and everything else with a `smoothUnion`, because
 * toes that merge into the ball are a mitten — and at the sizes this draws at,
 * that reads as a paw print, which is a different ability.
 */
const SOLE_VERTEX = /* glsl */ `
  ${PRINT_PLACEMENT_GLSL}

  uniform float uFootLength;  // metres, heel to the end of the toes
  uniform float uFootWidth;   // metres, across the ball
  uniform float uPad;         // metres of quad outside the sole, for the scorch halo
  uniform float uToeOut;      // radians each print splays away from the line of travel
  uniform float uLift;        // metres above the floor

  varying vec2  vSole;        // metres in the print's own frame, right-footed
  varying vec3  vWorld;
  varying float vAge;         // seconds since this print was stepped on
  varying float vSeed;
  varying float vViewZ;

  void main() {
    // Not stepped on yet. Push the whole quad outside the frustum rather than
    // collapsing it: a zero-area quad still lights a seam of fragments.
    if (aBirth < 0.0) {
      vSole = vec2(0.0);
      vWorld = vec3(0.0);
      vAge = -1.0;
      vSeed = 0.0;
      vViewZ = -1.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    float side = printSide(aIndex);
    vec2 local = vec2(position.x * (uFootWidth + 2.0 * uPad), position.z * (uFootLength + 2.0 * uPad));

    // Toe-out. Negated against the side so both feet splay *away* from the line
    // of travel; without the sign the left foot toes in and the walker limps.
    float a = -uToeOut * side;
    float ca = cos(a);
    float sa = sin(a);
    vec2 turned = vec2(local.x * ca - local.y * sa, local.x * sa + local.y * ca);

    vec3 world = printCentre(aIndex, aWander) + uSide * turned.x + uForward * turned.y;
    world.y = uLift;

    // Mirror into the right-footed frame the SDF is authored in.
    vSole = vec2(local.x * side, local.y);
    vWorld = world;
    vAge = uNow - aBirth;
    vSeed = aSeed;

    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const SOLE_FRAGMENT = /* glsl */ `
  uniform vec2      uResolution;
  uniform sampler2D uSceneDepth;
  uniform float     uCameraNear;
  uniform float     uCameraFar;
  uniform float     uGlobalGlow;

  uniform float uFootLength;
  uniform float uFootWidth;
  uniform float uHeelWidth;   // heel as a fraction of the ball
  uniform float uBallWidth;   // ball as a fraction of the nominal width
  uniform float uArchCut;     // 0..1 how far the medial arch is eaten in
  uniform float uSoleRound;   // metres of smooth union between heel, waist and ball
  uniform float uToeSize;     // metres, the big toe
  uniform float uToeSpread;   // how far the toe row fans across the width
  uniform float uToeGap;      // metres the toe row sits ahead of the ball

  uniform float uRim;         // metres of ember rim inside the outline
  uniform float uHalo;        // metres of scorch outside it
  uniform float uEdge;        // metres of feather on the outline
  uniform float uRollTime;    // seconds the ignition takes to run heel to toe
  uniform float uFlashTime;   // seconds a freshly lit point stays white
  uniform float uCoolTime;    // seconds it takes that point to go dark
  uniform float uCharTime;    // seconds the char takes to blacken
  uniform float uGrain;       // ember-vein features per metre
  uniform float uVein;        // 0..1 how much of the sole is vein rather than char
  uniform float uRagged;      // metres the halo wanders
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFade;        // master fade
  uniform float uSoftFade;    // metres of depth feather

  uniform vec3 uColorFlash;
  uniform vec3 uColorEmber;
  uniform vec3 uColorChar;
  uniform vec3 uColorAsh;
  uniform vec3 uColorHalo;

  varying vec2  vSole;
  varying vec3  vWorld;
  varying float vAge;
  varying float vSeed;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  float sdEllipse(vec2 p, vec2 r) {
    vec2 rr = max(r, vec2(1e-4));
    return (length(p / rr) - 1.0) * min(rr.x, rr.y);
  }

  float smoothUnion(float a, float b, float k) {
    float kk = max(k, 1e-4);
    float h = clamp(0.5 + 0.5 * (b - a) / kk, 0.0, 1.0);
    return mix(b, a, h) - kk * h * (1.0 - h);
  }

  /** Heel, waist and ball. Metres in, metres out. +x is lateral, +y is the toe. */
  float soleSD(vec2 p) {
    float L = max(uFootLength, 0.02);
    float W = max(uFootWidth, 0.01);
    float heel = sdEllipse(p - vec2(0.0, -0.30 * L), vec2(0.5 * W * uHeelWidth, 0.21 * L));
    float ball = sdEllipse(p - vec2(0.0, 0.17 * L), vec2(0.5 * W * uBallWidth, 0.23 * L));
    // The waist is narrowed *and* shifted outward, so what is removed is the
    // medial arch and not a symmetric pinch. A symmetric pinch reads as a
    // dumbbell; this reads as a foot.
    float waist = sdEllipse(
      p - vec2(0.25 * W * uArchCut, -0.05 * L),
      vec2(0.5 * W * max(1.0 - uArchCut, 0.12), 0.22 * L)
    );
    return smoothUnion(smoothUnion(heel, waist, uSoleRound), ball, uSoleRound);
  }

  /** Five toes, biggest on the medial side, the row raked back to the outside. */
  float toesSD(vec2 p) {
    float L = max(uFootLength, 0.02);
    float W = max(uFootWidth, 0.01);
    float d = 1e3;
    for (int i = 0; i < 5; i++) {
      float t = float(i) * 0.25;
      float x = mix(-0.34, 0.34, t) * W * uToeSpread;
      float y = L * (0.41 - 0.10 * t * t) + uToeGap;
      float r = uToeSize * (1.0 - 0.38 * t);
      d = min(d, sdEllipse(p - vec2(x, y), vec2(r, r * 1.15)));
    }
    return d;
  }

  void main() {
    if (vAge < 0.0 || uFade < 0.004) discard;

    float L = max(uFootLength, 0.02);
    float sd = min(soleSD(vSole), toesSD(vSole));

    // Taken here, before the ignition discard below: a derivative evaluated in
    // divergent control flow is undefined, and the 2x2 quad along the ignition
    // line is exactly where half the fragments have gone. GroundField learnt the
    // same lesson on its stroke antialiasing.
    float px = fwidth(sd) + 1e-5;

    // The ignition runs heel to toe on the print's own clock — a footfall is a
    // roll, not a stamp, and this is the one detail that makes a still frame of
    // the trail look like somebody walked it rather than like somebody stencilled
    // it. The parameter below is 0 at the heel and 1 at the toe.
    float u = clamp(vSole.y / L + 0.5, 0.0, 1.0);
    float local = vAge - u * uRollTime;
    if (local < 0.0) discard;

    float flash = smoothstep(0.0, max(uFlashTime, 1e-3), local);
    float heat = flash * exp(-local / max(uCoolTime, 0.05));
    float soot = 1.0 - exp(-local / max(uCharTime, 0.05));

    // Ember veins: the char cracks, and the cracks are what stay hot. Sampled in
    // world metres so the grain belongs to the floor and two prints that overlap
    // share it, instead of each carrying its own copy of the same pattern.
    float grain = snoise(vec3(vWorld.xz * max(uGrain, 0.01), vSeed * 3.7)) * 0.5 + 0.5;
    float vein = smoothstep(0.52 - uVein * 0.4, 0.78, grain);

    float inside = 1.0 - smoothstep(-uEdge, max(uEdge, px), sd);
    float rimBand = exp(-pow(max(sd + uRim * 0.5, -uHalo) / max(uRim, 1e-3), 2.0));

    // The halo is the scorch that gets out past the sole. Ragged, warped in the
    // plane — never sampled on a bearing, which draws spokes.
    float wobble = snoise(vec3(vWorld.xz * 2.6, vSeed * 11.0)) * uRagged;
    float halo = exp(-max(sd + wobble, 0.0) / max(uHalo, 1e-3));

    float alpha = max(inside, halo * 0.55) * uOpacity * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    // Cold first, then everything hot added on top: an ember has to be able to
    // sit on a black scar, and mixing toward the ember colour instead washes the
    // scar out to grey the moment the glow is turned up.
    vec3 colour = mix(uColorAsh, uColorChar, soot);
    colour = mix(colour, uColorHalo, clamp(halo * (1.0 - inside), 0.0, 1.0));

    float ember = heat * mix(0.25, 1.0, vein) * inside;
    float front = exp(-pow(local / max(uFlashTime * 1.6, 1e-3), 2.0)) * inside;
    colour += uColorEmber * ember * uGlow * uGlobalGlow;
    colour += uColorFlash * (front * 0.9 + rimBand * heat * 0.7) * uGlow * uGlobalGlow;

    gl_FragColor = vec4(colour, clamp(alpha, 0.0, 1.0));
  }
`;

/* ====================================================================== */
/* The pillar                                                             */
/* ====================================================================== */
/**
 * The short column of flame each print throws.
 *
 * A cylindrical billboard — world up is up, the quad only yaws to face the
 * camera. A full billboard was tried and it leans the whole trail over as you
 * orbit, which reads as wind blowing from wherever the camera happens to be.
 *
 * The pillar's *width at height h* is the sole's own footprint chord at that
 * height, tapered: the base of the column is as wide as the foot that made it,
 * which is the only thing tying the two meshes together visually once the
 * flames are tall enough to hide the print underneath them.
 */
const PILLAR_VERTEX = /* glsl */ `
  ${PRINT_PLACEMENT_GLSL}

  uniform float uHeight;      // metres, a pillar at full stretch
  uniform float uWidth;       // metres, its half-width at the base
  uniform float uRiseTime;    // seconds to full height
  uniform float uFallTime;    // seconds to gutter out
  uniform float uLean;        // metres the crown leans downrange
  uniform float uWaver;       // metres of sideways sway at the crown
  uniform float uWaverRate;   // sways per second
  uniform float uLift;        // metres above the floor the base sits

  varying vec2  vQuad;        // x: -1..1 across, y: 0..1 up
  varying vec3  vWorld;
  varying float vHeat;        // 0..1 how hard this pillar is burning
  varying float vSeed;
  varying float vViewZ;

  void main() {
    if (aBirth < 0.0) {
      vQuad = vec2(0.0);
      vWorld = vec3(0.0);
      vHeat = 0.0;
      vSeed = 0.0;
      vViewZ = -1.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    float age = uNow - aBirth;
    // Rise then gutter. Both times are live, so a paused trail re-times when
    // either slider moves.
    float rise = smoothstep(0.0, max(uRiseTime, 1e-3), age);
    float fall = exp(-max(age - uRiseTime, 0.0) / max(uFallTime, 0.05));
    float heat = rise * fall;

    vec3 base = printCentre(aIndex, aWander);
    base.y = uLift;

    // Cylindrical billboard: the camera's right, flattened into the floor plane.
    vec3 camRight = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]) + vec3(1e-5, 0.0, 0.0));

    float h = position.y + 0.5;            // 0 at the foot, 1 at the crown
    float across = position.x * 2.0;       // -1..1

    float wave = sin(uNow * uWaverRate + aSeed * 6.2831) * uWaver * h * h;
    vec3 world = base
      + camRight * (across * uWidth * heat)
      + vec3(0.0, h * uHeight * heat, 0.0)
      + uForward * (uLean * h * h * heat)
      + uSide * wave;

    vQuad = vec2(across, h);
    vWorld = world;
    vHeat = heat;
    vSeed = aSeed;

    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const PILLAR_FRAGMENT = /* glsl */ `
  uniform vec2      uResolution;
  uniform sampler2D uSceneDepth;
  uniform float     uCameraNear;
  uniform float     uCameraFar;
  uniform float     uGlobalGlow;
  uniform float     uTime;

  uniform float uTaper;       // >1 pulls the flame to a point
  uniform float uBulge;       // 0..1 how much it swells above the base
  uniform float uNoiseScale;  // features per metre
  uniform float uNoiseSpeed;  // metres/second the field climbs
  uniform float uErosion;     // how hard the noise eats the silhouette
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFade;
  uniform float uSoftFade;

  uniform vec3 uColorA;       // the base
  uniform vec3 uColorB;
  uniform vec3 uColorC;
  uniform vec3 uColorD;       // the smoke at the crown

  varying vec2  vQuad;
  varying vec3  vWorld;
  varying float vHeat;
  varying float vSeed;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    if (vHeat < 0.01 || uFade < 0.004) discard;

    float h = clamp(vQuad.y, 0.0, 1.0);
    // Width profile: swells just off the floor, then tapers to nothing. A flame
    // that is widest at the ground looks like a puddle of light.
    float profile = pow(1.0 - h, max(uTaper, 0.05)) * (1.0 + uBulge * sin(h * 3.14159265));
    float body = 1.0 - abs(vQuad.x) / max(profile, 1e-3);
    if (body <= 0.0) discard;

    // The field climbs in world metres, so two pillars side by side do not
    // flicker in step — the thing that gives away a billboard fire instantly.
    float n = fbm3(vec3(vWorld.xz * uNoiseScale, vWorld.y * uNoiseScale - uTime * uNoiseSpeed) + vSeed * 13.0);
    float shape = body - uErosion * (0.5 + 0.5 * n) * h;

    float alpha = smoothstep(0.0, 0.35, shape) * vHeat * uOpacity * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    float t = clamp(h * 0.85 + (1.0 - shape) * 0.3, 0.0, 1.0);
    vec3 colour = gradient4(uColorA, uColorB, uColorC, uColorD, t);
    colour *= uGlow * uGlobalGlow * mix(0.6, 1.0, vHeat);

    gl_FragColor = vec4(colour, clamp(alpha, 0.0, 1.0));
  }
`;

/* ====================================================================== */
/* Construction                                                           */
/* ====================================================================== */

/**
 * The uniform boxes the two materials **share by identity**.
 *
 * Cloning this object gives you a sole and a pillar that agree until the first
 * frame one of them is written and the other is not. There is exactly one call
 * site per cast, in `FirewalkAbility#_syncPlacement()`.
 */
export function createFirewalkPlacement() {
  return {
    uOrigin: { value: new Vector3() },
    uForward: { value: new Vector3(0, 0, 1) },
    uSide: { value: new Vector3(1, 0, 0) },
    uStart: { value: 0.9 },
    uStep: { value: 1.15 },
    uStride: { value: 0.32 },
    uWander: { value: 0.05 },
    uNow: { value: 0 },
    uLift: { value: 0.015 }
  };
}

/**
 * The four per-print attributes, built once and handed to **both** geometries.
 *
 * `aIndex` never changes. `aSeed` and `aWander` are re-rolled per cast by the
 * ability (dice rolls, which a cast is allowed to capture); `aBirth` is written
 * as the front crosses each print. All three are `Float32Array`s the ability
 * writes into directly — there is no allocation anywhere in a cast.
 */
export function createPrintAttributes(capacity) {
  const index = new Float32Array(capacity);
  const seed = new Float32Array(capacity);
  const wander = new Float32Array(capacity);
  const birth = new Float32Array(capacity);
  for (let i = 0; i < capacity; i++) {
    index[i] = i;
    seed[i] = Math.random() * 100;
    wander[i] = Math.random() * 2 - 1;
    birth[i] = -1;
  }
  return {
    aIndex: new InstancedBufferAttribute(index, 1),
    aSeed: new InstancedBufferAttribute(seed, 1),
    aWander: new InstancedBufferAttribute(wander, 1),
    aBirth: new InstancedBufferAttribute(birth, 1)
  };
}

/**
 * One quad per print, in the print's own frame.
 *
 * `ground` lays it in XZ (the sole); otherwise it stands in XY (the pillar).
 * Both are unit quads centred on the origin — not one metre of either is in the
 * buffer, which is what lets `footLength` and `pillarHeight` stay live.
 */
function printQuad(attributes, ground) {
  const geometry = new InstancedBufferGeometry();

  const position = ground
    ? new Float32Array([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5])
    : new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

  for (const [name, attribute] of Object.entries(attributes)) geometry.setAttribute(name, attribute);
  geometry.instanceCount = 0;

  // Every vertex is placed by the shader, so three's idea of the bounds is a
  // half-metre box at the world origin and has nothing to do with where this
  // draws. Frustum culling is off on the mesh for the same reason.
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

/** The instanced ground quad the soles are drawn on. */
export function createSoleGeometry(attributes) {
  return printQuad(attributes, true);
}

/** The instanced upright quad the pillars are drawn on. */
export function createPillarGeometry(attributes) {
  return printQuad(attributes, false);
}

/**
 * The sole. Alpha-blended, not additive: a burnt footprint is *darker* than the
 * flagstone it is burnt into, and the embers are added on top of that.
 */
export function createSoleMaterial(placement) {
  return new ShaderMaterial({
    name: 'Firewalk:sole',
    vertexShader: SOLE_VERTEX,
    fragmentShader: SOLE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...placement,

      uFootLength: { value: 0.3 },
      uFootWidth: { value: 0.115 },
      uPad: { value: 0.12 },
      uToeOut: { value: 0.13 },

      uHeelWidth: { value: 0.78 },
      uBallWidth: { value: 1.0 },
      uArchCut: { value: 0.42 },
      uSoleRound: { value: 0.02 },
      uToeSize: { value: 0.03 },
      uToeSpread: { value: 0.92 },
      uToeGap: { value: 0.016 },

      uRim: { value: 0.016 },
      uHalo: { value: 0.1 },
      uEdge: { value: 0.006 },
      uRollTime: { value: 0.16 },
      uFlashTime: { value: 0.09 },
      uCoolTime: { value: 1.6 },
      uCharTime: { value: 0.5 },
      uGrain: { value: 5.5 },
      uVein: { value: 0.6 },
      uRagged: { value: 0.03 },
      uOpacity: { value: 1 },
      uGlow: { value: 2.2 },
      uFade: { value: 1 },
      uSoftFade: { value: 0.3 },

      uColorFlash: { value: new Color(1, 1, 1) },
      uColorEmber: { value: new Color(1, 0.45, 0.12) },
      uColorChar: { value: new Color(0.06, 0.05, 0.05) },
      uColorAsh: { value: new Color(0.3, 0.27, 0.26) },
      uColorHalo: { value: new Color(0.12, 0.09, 0.08) }
    })
  });
}

/** The pillar. Additive, because it is fire. */
export function createPillarMaterial(placement) {
  return new ShaderMaterial({
    name: 'Firewalk:pillar',
    vertexShader: PILLAR_VERTEX,
    fragmentShader: PILLAR_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...placement,

      uHeight: { value: 1.3 },
      uWidth: { value: 0.22 },
      uRiseTime: { value: 0.2 },
      uFallTime: { value: 0.9 },
      uLean: { value: 0.18 },
      uWaver: { value: 0.06 },
      uWaverRate: { value: 3.1 },

      uTaper: { value: 1.35 },
      uBulge: { value: 0.55 },
      uNoiseScale: { value: 1.6 },
      uNoiseSpeed: { value: 2.4 },
      uErosion: { value: 0.9 },
      uOpacity: { value: 1 },
      uGlow: { value: 1.7 },
      uFade: { value: 1 },
      uSoftFade: { value: 0.4 },

      uColorA: { value: new Color(1, 1, 1) },
      uColorB: { value: new Color(1, 0.6, 0.15) },
      uColorC: { value: new Color(0.8, 0.2, 0.05) },
      uColorD: { value: new Color(0.1, 0.08, 0.09) }
    })
  });
}

/** Four pickers into the pillar's height gradient. Memoised through `getColor`. */
export function setPillarGradient(material, a, b, c, d) {
  const u = material.uniforms;
  u.uColorA.value.copy(getColor(a));
  u.uColorB.value.copy(getColor(b));
  u.uColorC.value.copy(getColor(c));
  u.uColorD.value.copy(getColor(d));
  return material;
}
