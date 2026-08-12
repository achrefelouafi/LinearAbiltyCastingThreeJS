import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  ShaderMaterial,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL, commonVertexGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The one bespoke material Afterimage needs — and the reason it is bespoke.
 *
 * The ability's trick is **N frozen copies of the cast, all still live**: six
 * moments of one flight standing in a row down the line, each held at the age
 * it was taken and each still re-resolving every metre from the sliders. There
 * is no module in `src/vfx/` that expresses that, because every one of them
 * takes a single `now` and draws the world at that instant. What this needs is
 * a *single* draw in which every instance evaluates the same closed form at a
 * **different** instant.
 *
 * So the whole ability is one `InstancedBufferGeometry` and this shader. Per
 * instance there are exactly three constant attributes, baked once at
 * construction and never touched again:
 *
 * | attribute | what it is |
 * | --- | --- |
 * | `aCopy` | `0` for the live body, `k ≥ 1` for the k-th snapshot |
 * | `aFin` | which blade of that copy's fan this is |
 * | `aSeed` | unitless dice, so two copies do not erode identically |
 *
 * and the instant a copy is showing is **derived, not stored**:
 *
 * ```glsl
 * float target = aCopy < 0.5 ? uAge : aCopy * uSnapGap;   // uSnapGap is a slider
 * float shown  = min(uAge, target);   // grows with the cast, then holds forever
 * float held   = max(uAge - target, 0.0);   // how long it has been standing
 * ```
 *
 * ### Why that is the whole design
 *
 * The obvious implementation stamps `frame.uTime.value` into an instance
 * attribute the moment a snapshot is taken. It works, it is what the first
 * version did, and it quietly throws the ability away: a stamped snapshot is a
 * **captured second**, so dragging `snapGap` on a paused frame moves nothing,
 * and the roster entry for this slot is precisely "pausing and dragging
 * reshapes all six frozen moments at once". Deriving the target from the
 * slider instead means every frozen copy re-ages under the cursor, slides to
 * the place on the line it would have been at that new age, and re-opens to
 * the shape it had there — while the clock is stopped. It is invariant I1
 * turned into an effect, which is the brief.
 *
 * It is also strictly cheaper: nothing is written to a buffer during a cast, so
 * there is no attribute upload, no ring bookkeeping and no I3 exposure at all.
 *
 * ### The body
 *
 * A fan of `fins` tapered slivers on a common axis, which open outward as the
 * flight progresses. The form has to be strongly age-dependent or six copies of
 * it read as six of the same object: a bud at the muzzle, a blade at mid-range
 * and a splayed fan at the far end is three legibly different silhouettes off
 * one parameter, and that is what makes the row read as *one thing photographed
 * six times* rather than as six things.
 *
 * The first version varied only the length. Six copies of a stick at six
 * lengths reads as a ruler.
 */

/** Rings along the sliver. Enough that the taper is a curve and not a cone. */
const RINGS = 16;
/** Sides around it. Ten is where the silhouette stops being a polygon at 3 m. */
const SIDES = 10;

/**
 * Hard ceiling on blades per copy. The `fins` slider clamps here, and the
 * instance layout is `copy × MAX_FINS + fin` so that truncating `instanceCount`
 * drops whole copies rather than half of one.
 */
export const MAX_FINS = 4;

/**
 * Hard ceiling on frozen copies. Six is the roster's number; eight leaves the
 * slider somewhere to go. Note the real cost of raising it is not the draw —
 * there is only ever one — but the fill, since every copy is a translucent
 * additive body the camera can be inside of.
 */
export const MAX_SNAPS = 8;

/**
 * A unit sliver: a lathe about +Y, `y` running 0 → 1, radius 1 at its widest.
 *
 * Authored in unit space for the same reason `GrowthField`'s geometry factory
 * is — the instance scales length and radius independently, and `position.y`
 * then reads straight off in the fragment shader as "how far along this blade
 * am I", which is what every gradient on it keys off.
 *
 * The profile is `sin(πy)^k` rather than a cone: a cone has a flat base that
 * catches the rim light as a disc and makes the fan look like a bundle of
 * pencils. Both ends have to come to a point.
 */
function createSliverGeometry(profile = 0.62) {
  const position = [];
  const normal = [];
  const index = [];

  for (let r = 0; r <= RINGS; r++) {
    const y = r / RINGS;
    const radius = Math.pow(Math.sin(Math.PI * y), profile);
    // Analytic derivative of the profile — a forward difference here puts a
    // visible crease in the normal at the two tips, where dr/dy is unbounded.
    const dr =
      profile *
      Math.pow(Math.max(Math.sin(Math.PI * y), 1e-4), profile - 1) *
      Math.cos(Math.PI * y) *
      Math.PI;

    for (let s = 0; s <= SIDES; s++) {
      const theta = (s / SIDES) * Math.PI * 2;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      position.push(radius * cos, y, radius * sin);
      // Surface of revolution: n ∝ (cosθ, −r′, sinθ).
      const length = Math.sqrt(1 + dr * dr);
      normal.push(cos / length, -dr / length, sin / length);
    }
  }

  for (let r = 0; r < RINGS; r++) {
    for (let s = 0; s < SIDES; s++) {
      const a = r * (SIDES + 1) + s;
      const b = a + SIDES + 1;
      index.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normal, 3));
  geometry.setIndex(index);
  return geometry;
}

/**
 * The instanced geometry: `(MAX_SNAPS + 1) × MAX_FINS` copies of one sliver.
 *
 * Built once per ability instance and never rewritten. `instanceCount` is the
 * only thing that moves, and because the layout is copy-major, lowering it
 * removes the *oldest* snapshots — which is what a `snaps` slider should do.
 */
export function createAfterimageGeometry() {
  const source = createSliverGeometry();
  const geometry = new InstancedBufferGeometry();
  geometry.index = source.index;
  geometry.setAttribute('position', source.getAttribute('position'));
  geometry.setAttribute('normal', source.getAttribute('normal'));

  const total = (MAX_SNAPS + 1) * MAX_FINS;
  const copy = new Float32Array(total);
  const fin = new Float32Array(total);
  const seed = new Float32Array(total);

  for (let k = 0; k <= MAX_SNAPS; k++) {
    for (let f = 0; f < MAX_FINS; f++) {
      const i = k * MAX_FINS + f;
      copy[i] = k;
      fin[i] = f;
      // A fixed irrational-ish walk rather than Math.random(): the dice are
      // baked into a buffer that outlives every cast, so they must not make
      // one pooled instance look different from another.
      seed[i] = (i * 0.6180339887) % 1;
    }
  }

  geometry.setAttribute('aCopy', new InstancedBufferAttribute(copy, 1));
  geometry.setAttribute('aFin', new InstancedBufferAttribute(fin, 1));
  geometry.setAttribute('aSeed', new InstancedBufferAttribute(seed, 1));
  geometry.instanceCount = MAX_FINS;
  return geometry;
}

/* ------------------------------------------------------------------ */
/* The shader                                                          */
/* ------------------------------------------------------------------ */

const AFTERIMAGE_VERTEX = /* glsl */ `
  #define AI_PI  3.141592653589793
  #define AI_TAU 6.283185307185

  attribute float aCopy;
  attribute float aFin;
  attribute float aSeed;

  uniform float uAge;          // the ability's own clock, seconds
  uniform float uSnapGap;      // seconds of cast age between one copy and the next
  uniform float uSpeed;        // metres/second the body flies at
  uniform float uLength;       // metres to the far end
  uniform float uFlightCurve;  // >1 starts slow and arrives fast

  uniform vec3  uOrigin;
  uniform vec3  uDir;
  uniform vec3  uSide;

  uniform float uLiftNear;     // metres above the floor at the muzzle
  uniform float uLift;         // ... and at the far end
  uniform float uArc;          // metres the flight bows upward at mid-span
  uniform float uSway;         // metres of lateral wander
  uniform float uSwayWaves;    // wavelengths of it over the whole line
  uniform float uSeed;

  uniform float uFins;
  uniform float uSplay;        // radians a blade tilts off the axis, fully open
  uniform float uFinGap;       // metres a blade steps off the axis, fully open
  uniform float uRoll;         // radians the fan is rolled at birth
  uniform float uRollSpeed;    // radians/second it keeps rolling as it flies
  uniform float uHoldSpin;     // radians/second a *frozen* copy keeps turning

  uniform float uLenNear;      // metres — the bud at the muzzle
  uniform float uLen;          // metres — the blade, fully open
  uniform float uRadNear;      // metres
  uniform float uRad;          // metres
  uniform float uFlatten;      // 0..1 squashes the sliver into a blade
  uniform float uOpenCurve;    // >1 keeps it shut and then opens it late

  uniform float uHoldLife;     // seconds a frozen copy takes to give up
  uniform float uHoldShrink;   // × per second a frozen copy contracts
  uniform float uHoldSink;     // metres/second it settles

  varying vec3  vWorld;
  varying vec3  vNormalW;
  varying float vAlong;        // 0..1 base → tip of this blade
  varying float vHeld;         // 0..1 how far through its hold this copy is
  varying float vOpen;         // 0..1 how far the fan had opened
  varying float vSeed;
  varying float vViewZ;

  ${commonVertexGLSL}

  void main() {
    /* --- which instant is this copy showing --- */
    // 'target' is derived from a live slider, never from a stored timestamp:
    // that is the difference between six frozen moments and six dead ones.
    float target = aCopy < 0.5 ? uAge : aCopy * uSnapGap;
    float shown = min(uAge, target);
    float held = max(uAge - target, 0.0);
    vHeld = clamp(held / max(uHoldLife, 1e-3), 0.0, 1.0);
    vSeed = aSeed;

    /* --- where the body was at that instant --- */
    float travel = uLength / max(uSpeed, 0.01);
    float s = pow(clamp(shown / max(travel, 1e-4), 0.0, 1.0), max(uFlightCurve, 0.05));
    float open = pow(s, max(uOpenCurve, 0.05));
    vOpen = open;

    vec3 centre = uOrigin + uDir * (s * uLength);
    centre += uSide * (sin((s * uSwayWaves + uSeed) * AI_TAU) * uSway);
    centre.y += mix(uLiftNear, uLift, s) + uArc * sin(s * AI_PI) - held * uHoldSink;

    /* --- the blade itself --- */
    // A fin past the live count collapses to a point. Branch-free, because the
    // alternative is a per-instance early-out and the degenerate triangles it
    // produces never reach a fragment anyway.
    float finOn = step(aFin + 0.5, uFins);
    float shrink = max(1.0 - held * uHoldShrink, 0.0) * finOn;
    float len = mix(uLenNear, uLen, open) * shrink;
    float rad = mix(uRadNear, uRad, open) * shrink;
    float radZ = rad * max(uFlatten, 0.02);

    vAlong = position.y;

    vec3 q = vec3(position.x * rad, (position.y - 0.5) * len, position.z * radZ);
    vec3 n = normal * vec3(1.0 / max(rad, 1e-4), 1.0 / max(len, 1e-4), 1.0 / max(radZ, 1e-4));

    // Splay: tilt the blade off the travel axis, then step it outward, then
    // roll the whole fan about that axis. Doing the tilt first is what makes
    // the fan a *cone* — tilting after the roll gives every blade the same
    // lean in world space and the thing reads as a bent bundle.
    float sp = uSplay * open;
    float cs = cos(sp);
    float sn = sin(sp);
    q = vec3(q.x * cs - q.y * sn, q.x * sn + q.y * cs, q.z);
    n = vec3(n.x * cs - n.y * sn, n.x * sn + n.y * cs, n.z);
    q.x += uFinGap * open;

    float phi = (aFin + 0.5) / max(uFins, 1.0) * AI_TAU
              + uRoll + uRollSpeed * shown + uHoldSpin * held;
    float cp = cos(phi);
    float sq = sin(phi);
    q = vec3(q.x * cp + q.z * sq, q.y, -q.x * sq + q.z * cp);
    n = vec3(n.x * cp + n.z * sq, n.y, -n.x * sq + n.z * cp);

    // The cast's own frame: local x is lateral, local y is downrange, local z
    // is up. uSide and uDir arrive orthonormal from Ability.
    vec3 up = cross(uSide, uDir);
    mat3 basis = mat3(uSide, uDir, up);

    vec3 world = centre + basis * q;
    vWorld = world;
    vNormalW = normalize(basis * n);

    vec4 view = viewMatrix * vec4(world, 1.0);
    vViewZ = -view.z;
    gl_Position = projectionMatrix * view;
  }
`;

const AFTERIMAGE_FRAGMENT = /* glsl */ `
  #define AI_TAU 6.283185307185

  uniform vec3  uColorLive;
  uniform vec3  uColorHeld;
  uniform vec3  uColorRim;
  uniform vec3  uColorCore;
  uniform float uRim;
  uniform float uRimPower;
  uniform float uCore;
  uniform float uBandScale;
  uniform float uBandSpeed;
  uniform float uBandGlow;
  uniform float uErode;
  uniform float uErodeScale;
  uniform float uEdge;
  uniform float uEdgeGlow;
  uniform float uHoldDim;
  uniform float uGlow;
  uniform float uOpacity;
  uniform float uFade;
  uniform float uSoftFade;

  uniform float uTime;
  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying vec3  vWorld;
  varying vec3  vNormalW;
  varying float vAlong;
  varying float vHeld;
  varying float vOpen;
  varying float vSeed;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    vec3 view = normalize(cameraPosition - vWorld);
    float ndv = clamp(dot(normalize(vNormalW), view), 0.0, 1.0);
    float rim = pow(1.0 - ndv, max(uRimPower, 0.05));

    // Both tips are points, so anything drawn evenly along the blade piles up
    // there and the sliver reads as two bright dots on a wire. The core is
    // weighted to the middle instead.
    float spine = pow(max(sin(vAlong * 3.14159265), 0.0), 1.4);

    // Bands measured in **world metres**, not along the blade: they stay put in
    // the room, so a copy that froze between two of them sits between them
    // forever. Keyed to the blade's own length instead, every copy would carry
    // an identical stripe and the row would look printed.
    float band = 0.5 + 0.5 * sin((vWorld.y * uBandScale - uTime * uBandSpeed) * AI_TAU);

    /* --- ageing --- */
    float aged = clamp(vHeld, 0.0, 1.0);
    vec3 body = mix(uColorLive, uColorHeld, aged);

    // A held copy comes apart from the inside. dissolveMask returns the keep
    // mask and the burning edge in one call — the same pair GhostRig uses,
    // so the two chrono slots dissolve with the same vocabulary.
    float grain = clamp(fbm3(vWorld * max(uErodeScale, 1e-3) + vSeed * 37.0) * 0.5 + 0.5, 0.0, 1.0);
    vec2 cut = dissolveMask(grain, aged * uErode * 1.2 - 0.1, max(uEdge, 1e-3));

    float shade = uCore * spine * (0.35 + 0.65 * vOpen) + uRim * rim + uBandGlow * band * spine;
    vec3 color = body * shade + uColorRim * rim * uRim * 0.6 + uColorCore * uCore * spine * 0.5;
    color += uColorRim * cut.y * uEdgeGlow;
    // Reinhard ceiling: rim, core and burn all peak on the silhouette of a
    // dissolving copy at once, and bloom turns the sum into a white blob.
    color /= 1.0 + color * 0.22;
    color *= uGlow * uGlobalGlow * mix(1.0, 1.0 - uHoldDim, aged);

    float alpha = (rim * 0.75 + spine * 0.55 + band * 0.15)
                * uOpacity * uFade * cut.x * (1.0 - aged * uHoldDim);

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The material. Additive, depth-tested, no depth write.
 *
 * Additive because six translucent bodies seen through each other have to
 * *add*: with a normal blend the nearest copy over-writes the ones behind it
 * and, with no depth write to sort them, the row develops a hard edge wherever
 * two of them overlap and it flickers as the camera turns. Light does not do
 * that, and a frozen moment is made of light here.
 */
export function createAfterimageMaterial() {
  const material = new ShaderMaterial({
    name: 'Afterimage',
    vertexShader: AFTERIMAGE_VERTEX,
    fragmentShader: AFTERIMAGE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uAge: { value: 0 },
      uSnapGap: { value: 0.12 },
      uSpeed: { value: 18 },
      uLength: { value: 18 },
      uFlightCurve: { value: 1 },

      uOrigin: { value: new Vector3() },
      uDir: { value: new Vector3(0, 0, 1) },
      uSide: { value: new Vector3(1, 0, 0) },

      uLiftNear: { value: 1.2 },
      uLift: { value: 1.0 },
      uArc: { value: 0.35 },
      uSway: { value: 0.2 },
      uSwayWaves: { value: 1.2 },
      uSeed: { value: 0 },

      uFins: { value: 3 },
      uSplay: { value: 0.4 },
      uFinGap: { value: 0.08 },
      uRoll: { value: 0 },
      uRollSpeed: { value: 1.4 },
      uHoldSpin: { value: 0.15 },

      uLenNear: { value: 0.5 },
      uLen: { value: 1.9 },
      uRadNear: { value: 0.1 },
      uRad: { value: 0.16 },
      uFlatten: { value: 0.45 },
      uOpenCurve: { value: 0.8 },

      uHoldLife: { value: 2.4 },
      uHoldShrink: { value: 0.05 },
      uHoldSink: { value: 0.05 },

      uColorLive: { value: new Color('#f6e3b4') },
      uColorHeld: { value: new Color('#8d8570') },
      uColorRim: { value: new Color('#ffeec8') },
      uColorCore: { value: new Color('#ffffff') },
      uRim: { value: 1.1 },
      uRimPower: { value: 2.4 },
      uCore: { value: 0.9 },
      uBandScale: { value: 3.0 },
      uBandSpeed: { value: 0.6 },
      uBandGlow: { value: 0.35 },
      uErode: { value: 0.85 },
      uErodeScale: { value: 2.6 },
      uEdge: { value: 0.16 },
      uEdgeGlow: { value: 1.6 },
      uHoldDim: { value: 0.55 },
      uGlow: { value: 1.5 },
      uOpacity: { value: 1 },
      uFade: { value: 1 },
      uSoftFade: { value: 0.5 }
    })
  });

  /**
   * Push the live settings and this frame's cast state into the shader.
   *
   * Everything with a unit is read here, every frame, from `settings.afterimage`
   * — the state object carries only the cast's frame, its dice and its clock.
   *
   * @param {object} state `{ origin, dir, side, length, age, seed, fade }` —
   *   the cast's frame, how far it reaches, its clock and its one dice roll
   */
  material.userData.sync = (state) => {
    const c = settings.afterimage;
    const g = settings.global;
    const u = material.uniforms;

    u.uAge.value = state.age;
    u.uSeed.value = state.seed;
    u.uFade.value = state.fade;
    u.uOrigin.value.copy(state.origin);
    u.uDir.value.copy(state.dir);
    u.uSide.value.copy(state.side);
    u.uLength.value = state.length;

    u.uSnapGap.value = c.snapGap;
    u.uSpeed.value = c.speed * g.speed;
    u.uFlightCurve.value = c.flightCurve;

    u.uLiftNear.value = c.liftNear;
    u.uLift.value = c.lift;
    u.uArc.value = c.arc;
    u.uSway.value = c.sway;
    u.uSwayWaves.value = c.swayWaves;

    u.uFins.value = c.fins;
    u.uSplay.value = c.splay;
    u.uFinGap.value = c.finGap;
    u.uRoll.value = c.roll;
    u.uRollSpeed.value = c.rollSpeed;
    u.uHoldSpin.value = c.holdSpin;

    u.uLenNear.value = c.lengthNear;
    u.uLen.value = c.bladeLength;
    u.uRadNear.value = c.radiusNear;
    u.uRad.value = c.bladeRadius;
    u.uFlatten.value = c.flatten;
    u.uOpenCurve.value = c.openCurve;

    u.uHoldLife.value = c.holdLife;
    u.uHoldShrink.value = c.holdShrink;
    u.uHoldSink.value = c.holdSink;

    u.uColorLive.value.copy(getColor(c.colorLive));
    u.uColorHeld.value.copy(getColor(c.colorHeld));
    u.uColorRim.value.copy(getColor(c.colorRim));
    u.uColorCore.value.copy(getColor(c.colorCore));
    u.uRim.value = c.rim;
    u.uRimPower.value = c.rimPower;
    u.uCore.value = c.core;
    u.uBandScale.value = c.bandScale;
    u.uBandSpeed.value = c.bandSpeed;
    u.uBandGlow.value = c.bandGlow;
    u.uErode.value = c.erode;
    u.uErodeScale.value = c.erodeScale;
    u.uEdge.value = c.erodeEdge;
    u.uEdgeGlow.value = c.edgeGlow;
    u.uHoldDim.value = c.holdDim;
    u.uGlow.value = c.glow * g.glow;
    u.uOpacity.value = c.opacity * g.opacity;
    u.uSoftFade.value = c.softFade;
  };

  return material;
}
