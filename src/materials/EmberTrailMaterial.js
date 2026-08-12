import { AdditiveBlending, Color, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { getColor } from '../utils/color.js';

/* ====================================================================== */
/* The flock path, mirrored                                               */
/* ====================================================================== */
/**
 * `agentAt()` and everything it stands on, copied out of `vfx/Swarm.js`.
 *
 * This is a **mirror**, and it is the one place in the ability where editing
 * half the code silently breaks the other half — the same warning
 * `vfx/Projectile.js` puts on `pathAt()` in its trail shader, for the same
 * reason and with the same remedy: if the flock's path changes, this changes
 * with it.
 *
 * The alternative was a ring buffer of past positions per bird. That is what
 * the first attempt did, and it fails on two counts at once. It is a *record of
 * metres*, so dragging `spacingSide` on a paused frame moves twenty-four birds
 * and leaves twenty-four trails hanging in the air behind where they used to be
 * — a direct **I1** violation you can see. And it needs a write per bird per
 * frame on the CPU, which is exactly the per-frame work `Swarm` exists to avoid.
 *
 * A trail here is therefore not a recording. It is the *same closed-form flock*
 * evaluated backwards in the bird's own clock, so it is guaranteed to pass
 * through the bird, and every slider that reshapes the flock reshapes its
 * trails on the same frame, paused or not.
 *
 * The uniform names are Swarm's own, and the ability hands this material the
 * **same uniform objects** the flock's material holds — one write in
 * `Swarm.update()` drives both, so the two can never drift out of step by a
 * frame.
 */
export const FLOCK_PATH_GLSL = /* glsl */ `
  uniform float uSeed;

  uniform int   uLeadMode;
  uniform vec3  uLeadA;
  uniform vec3  uLeadB;
  uniform vec3  uForward;
  uniform vec3  uSideAxis;
  uniform float uLeadRise;
  uniform float uLeadS;
  uniform float uLeadRate;
  uniform float uOrbitRadius;
  uniform float uOrbitHeight;
  uniform float uOrbitTurns;

  uniform vec3  uLattice;
  uniform float uSpacingSide;
  uniform float uSpacingUp;
  uniform float uLag;
  uniform float uJitter;
  uniform float uChurn;
  uniform float uBreathe;
  uniform float uBreatheRate;
  uniform float uWander;
  uniform float uWanderScale;
  uniform float uWanderSpeed;
  uniform float uGather;

  /** Normalise, or fall back — a zero-length basis vector is a NaN ribbon. */
  vec3 safeNormalize(vec3 v, vec3 fallback) {
    float l2 = dot(v, v);
    return l2 > 1e-8 ? v * inversesqrt(l2) : fallback;
  }

  vec3 leadAt(float s) {
    if (uLeadMode == 2) {
      float a = s * TAU * uOrbitTurns;
      return uLeadB + vec3(cos(a), 0.0, sin(a)) * uOrbitRadius + vec3(0.0, uOrbitHeight, 0.0);
    }
    if (uLeadMode == 1) {
      float t = clamp(s, -0.5, 1.0);
      vec3 p = mix(uLeadA, uLeadB, t);
      p.y += uLeadRise * sin(PI * clamp(t, 0.0, 1.0));
      return p;
    }
    return uLeadB;
  }

  vec3 cellOf(float idx, vec3 L) {
    vec3 cell = vec3(
      mod(idx, L.x),
      mod(floor(idx / L.x), L.y),
      mod(floor(idx / (L.x * L.y)), L.z)
    );
    vec3 shift = floor(hash31(uSeed * 13.0 + 0.7) * L);
    return mod(cell + shift, L);
  }

  vec3 agentAt(vec3 dice, float idx, float dt) {
    vec3 L = max(vec3(1.0), floor(uLattice));
    vec3 cell = cellOf(idx, L);
    vec3 centred = cell - (L - 1.0) * 0.5;

    float lagN = L.z > 1.0 ? cell.z / (L.z - 1.0) : 0.0;
    float lag = uLag * lagN;

    float t = uTime + dt;
    vec3 home = leadAt(uLeadS + (dt - lag) * uLeadRate);

    vec2 plane = vec2(centred.x * uSpacingSide, centred.y * uSpacingUp);
    plane += (dice.xy - 0.5) * (2.0 * uJitter);
    plane = rot2(t * uChurn + dice.z * TAU * 0.15 + uSeed) * plane;
    plane *= 1.0 + uBreathe * sin(t * uBreatheRate + dice.y * TAU);

    vec3 pos = home + uSideAxis * plane.x + vec3(0.0, plane.y, 0.0);
    pos += curlNoise(pos * uWanderScale + vec3(0.0, t * uWanderSpeed, 0.0) + dice.z * 17.0) * uWander;

    return mix(home, pos, clamp(uGather, 0.0, 1.0));
  }
`;

/* ====================================================================== */
/* The ribbon                                                             */
/* ====================================================================== */
/**
 * One instanced camera-facing strip per bird.
 *
 * The strip's `position` is `(v, side, 0)` — `v` runs 0 at the tail to 1 at the
 * head, `side` is -1 or +1 — and every metre of it is placed here. The vertex
 * at `v` is the bird as it was `(1 - v) · uSpan` seconds ago, so the whole
 * ribbon slides forward with the bird for free and there is nothing to
 * integrate.
 *
 * The tail thins rather than dimming. A trail that fades uniformly reads as a
 * light going out; one that *shortens and sharpens* reads as something that
 * stopped being made — the same observation `vfx/Projectile.js` makes about its
 * own trail burn, and it is worth more here than any amount of alpha ramp.
 */
const TRAIL_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;

  ${noiseGLSL}
  ${FLOCK_PATH_GLSL}

  uniform float uSpan;          // seconds of flight the tail reaches back over
  uniform float uWidth;         // metres, half-width at the head
  uniform float uWidthTaper;    // >1 sharpens the tail to a point
  uniform float uLift;          // metres the tail floats above the flown path
  uniform float uSag;           // metres the tail drops per second of age
  uniform float uWobble;        // metres of curl drift on the tail
  uniform float uWobbleScale;   // features per metre
  uniform float uWobbleSpeed;
  uniform float uReveal;        // 0..1 — a bird's trail appears with the bird
  uniform float uRevealSpread;  // 0..1 width of that wave
  uniform float uFade;          // the whole ribbon's master fade

  attribute float aStrand;      // which bird this instance belongs to
  attribute float aSeed;        // that bird's seed — mirrors the flock's

  varying float vAlong;         // 0 tail, 1 head
  varying float vAcross;        // -1..1 across the ribbon
  varying float vSeed;
  varying float vViewZ;
  varying float vAlpha;

  void main() {
    float v = clamp(position.x, 0.0, 1.0);
    float side = position.y;

    // Same hash the flock's vertex shader takes, off the same seed, so this
    // ribbon is threaded through that bird and not a bird beside it.
    vec3 dice = hash31(aSeed * 91.7 + 3.1);

    float back = -(1.0 - v) * max(uSpan, 0.0);
    vec3 p = agentAt(dice, aStrand, back);

    // The tangent comes from a second evaluation a fixed step earlier rather
    // than from the neighbouring strip node: the node spacing changes with
    // uSpan, and a tangent that changes width when you drag the span is the
    // sort of coupling that takes an afternoon to find.
    const float H = 0.03;
    vec3 behind = agentAt(dice, aStrand, back - H);
    vec3 tangent = safeNormalize(p - behind, uForward);

    vec3 viewDir = safeNormalize(cameraPosition - p, vec3(0.0, 0.0, 1.0));
    vec3 across = safeNormalize(cross(tangent, viewDir), uSideAxis);

    float age = (1.0 - v) * max(uSpan, 0.0);
    // Embers slump and drift apart behind the bird. Both terms are keyed off
    // the age of the sample rather than off v, so they do not change shape when
    // the span is dragged.
    p.y += uLift * age - uSag * age * age;
    p += curlNoise(p * uWobbleScale + vec3(0.0, uTime * uWobbleSpeed, 0.0) + dice.z * 29.0) * (uWobble * age);

    float w = uWidth * pow(v, max(uWidthTaper, 0.01));
    vec3 world = p + across * (side * w);

    float threshold = dice.z * (1.0 - clamp(uRevealSpread, 0.0, 1.0));
    vAlpha = smoothstep(threshold, threshold + max(uRevealSpread, 1e-3), clamp(uReveal, 0.0, 1.0)) * uFade;

    vAlong = v;
    vAcross = side;
    vSeed = aSeed;

    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const TRAIL_FRAGMENT = /* glsl */ `
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uGlobalGlow;

  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uColorC;
  uniform vec3  uColorD;
  uniform float uTint;          // where in the gradient the head sits
  uniform float uTintAlong;     // how far down the gradient the tail walks
  uniform float uTintJitter;    // ±per-bird walk along it
  uniform float uCore;          // how tightly light crowds the centre line
  uniform float uHeadBias;      // >0 keeps the brightness near the bird
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uSoftFade;      // metres of depth feather against solid geometry

  varying float vAlong;
  varying float vAcross;
  varying float vSeed;
  varying float vViewZ;
  varying float vAlpha;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    if (vAlpha < 0.004) discard;

    // Triangular across the ribbon, raised to a power: the strip has two
    // vertices per node, so anything smoother than this has to come out of the
    // exponent rather than out of more geometry.
    float body = pow(max(0.0, 1.0 - abs(vAcross)), max(uCore, 0.05));
    float along = mix(1.0, vAlong, clamp(uHeadBias, 0.0, 1.0));

    float alpha = body * along * vAlpha * uOpacity;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    float t = clamp(
      uTint + (1.0 - vAlong) * uTintAlong + uTintJitter * (hash11(vSeed * 51.3) - 0.5) * 2.0,
      0.0,
      1.0
    );
    vec3 colour = gradient4(uColorA, uColorB, uColorC, uColorD, t);
    colour *= uGlow * uGlobalGlow;

    gl_FragColor = vec4(colour, clamp(alpha, 0.0, 1.0));
  }
`;

/**
 * The path uniforms this material borrows from the flock.
 *
 * Listed rather than derived by prefix, because "everything the swarm happens
 * to own" would also drag in the flock's own colour pickers and silently make
 * the trail gradient, in **I5**'s terms, a derived colour rather than an
 * authored one.
 */
const FLOCK_UNIFORMS = [
  'uSeed',
  'uLeadMode',
  'uLeadA',
  'uLeadB',
  'uForward',
  'uSideAxis',
  'uLeadRise',
  'uLeadS',
  'uLeadRate',
  'uOrbitRadius',
  'uOrbitHeight',
  'uOrbitTurns',
  'uLattice',
  'uSpacingSide',
  'uSpacingUp',
  'uLag',
  'uJitter',
  'uChurn',
  'uBreathe',
  'uBreatheRate',
  'uWander',
  'uWanderScale',
  'uWanderSpeed',
  'uGather'
];

/**
 * Build the trail material for a flock.
 *
 * @param {object} flockUniforms the `Swarm`'s own `material.uniforms`. The
 *   twenty-five entries that describe the flock's path are **shared by
 *   reference**, not copied: `Swarm.update()` writes them once and both
 *   materials see the write, which is the only way to guarantee a ribbon and
 *   its bird cannot part company on a frame where one was updated and the
 *   other was not.
 * @returns {ShaderMaterial}
 */
export function createEmberTrailMaterial(flockUniforms) {
  const shared = {};
  for (const name of FLOCK_UNIFORMS) shared[name] = flockUniforms[name];

  return new ShaderMaterial({
    name: 'EmberTrail',
    vertexShader: TRAIL_VERTEX,
    fragmentShader: TRAIL_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...shared,

      uSpan: { value: 0.34 },
      uWidth: { value: 0.09 },
      uWidthTaper: { value: 1.5 },
      uLift: { value: 0.35 },
      uSag: { value: 0.4 },
      uWobble: { value: 0.5 },
      uWobbleScale: { value: 0.7 },
      uWobbleSpeed: { value: 0.6 },
      uReveal: { value: 1 },
      uRevealSpread: { value: 0.35 },
      uFade: { value: 1 },

      uColorA: { value: new Color(1, 1, 1) },
      uColorB: { value: new Color(1, 1, 1) },
      uColorC: { value: new Color(1, 1, 1) },
      uColorD: { value: new Color(1, 1, 1) },
      uTint: { value: 0.1 },
      uTintAlong: { value: 0.7 },
      uTintJitter: { value: 0.15 },
      uCore: { value: 1.6 },
      uHeadBias: { value: 0.45 },
      uOpacity: { value: 1 },
      uGlow: { value: 1.6 },
      uSoftFade: { value: 0.4 }
    })
  });
}

/** Four pickers into the trail gradient. Memoised through `getColor`. */
export function setTrailGradient(material, a, b, c, d) {
  const u = material.uniforms;
  u.uColorA.value.copy(getColor(a));
  u.uColorB.value.copy(getColor(b));
  u.uColorC.value.copy(getColor(c));
  u.uColorD.value.copy(getColor(d));
  return material;
}
