import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  Mesh,
  NormalBlending,
  Object3D,
  Quaternion,
  ShaderMaterial,
  Sphere,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { saturate, lerp } from '../utils/math.js';
import { getColor } from '../utils/color.js';

const TAU = Math.PI * 2;
const EPSILON = 0.004; // τ step used for the finite-difference heading

/**
 * How a body gets from the hand to the ground.
 *
 * These are not six different integrators. They are six different ways of
 * choosing **two endpoints**; the curve between them is one formula with
 * different coefficients — see `_pathPoint`. That collapse is the whole reason
 * the trail can be drawn entirely in a vertex shader without the GPU needing a
 * copy of the mode switch.
 */
export const FlightMode = Object.freeze({
  /** Hand → target, flat, with an optional lift. Bolts, needles, darts. */
  LINE: 'line',
  /** Ballistic lob. Launch, landing and apex are all live metres. */
  ARC: 'arc',
  /** On the floor, rotation derived from distance / radius so it never skates. */
  ROLL: 'roll',
  /** From one shared vanishing point above and behind the caster. */
  FALL: 'fall',
  /** Hand → target with a weave whose amplitude decays to zero on arrival. */
  HOMING: 'homing',
  /** As HOMING, but the lateral and vertical weaves run at different rates. */
  LISSAJOUS: 'lissajous',
  /** A fanned line cast whose bodies leave in an index-ordered ripple. */
  VOLLEY: 'volley'
});

/**
 * Where a body's launch delay comes from.
 *
 * `AUTO` picks the one the flight mode wants: a ripple for `VOLLEY`, the
 * spatial hash for `FALL`, nothing for the rest.
 */
export const Stagger = Object.freeze({
  AUTO: 'auto',
  NONE: 'none',
  /** Index order — body 0 first, body n-1 last. A ripple down the volley. */
  RIPPLE: 'ripple',
  /** Hash of the landing point on a lattice, blended with a radial ordering. */
  HASH: 'hash'
});

/* ---------------------------------------------------------------------- */
/* The spatial hash                                                        */
/* ---------------------------------------------------------------------- */

/**
 * Deterministic 0..1 ordering key for a point on the floor.
 *
 * The problem this solves: a zone fill wants forty arrivals spread over a
 * second, and the obvious `i / count` fills the circle in whatever order the
 * dice happened to hand out — which, because the dice are also what places the
 * stones, means the fill order and the layout are correlated and you can *see*
 * the loop. Hashing the **landing point** instead decorrelates them completely:
 * the order is a property of the floor, not of the array.
 *
 * The coordinates are quantised onto a lattice of `cell` metres first. Hashing
 * the raw position would give per-stone white noise, which reads as no order at
 * all; hashing the cell means neighbours share a key, so the circle fills in
 * *patches* that spread — much closer to how weather actually arrives. Drop
 * `cell` toward zero for confetti, push it past the zone radius and the whole
 * circle lands as one sheet.
 *
 * @param {number} x     metres
 * @param {number} z     metres
 * @param {number} cell  lattice size, metres
 * @param {number} seed  per-cast seed, so no two casts fill in the same order
 * @returns {number} 0..1
 */
export function spatialStagger(x, z, cell, seed) {
  const size = Math.max(0.01, cell);
  const cx = Math.floor(x / size);
  const cz = Math.floor(z / size);
  // Two decorrelated hashes of the same cell, folded together — one sine hash
  // on its own bands badly along the diagonal where cx + cz is constant.
  const a = Math.sin(cx * 127.1 + cz * 311.7 + seed * 74.7) * 43758.5453123;
  const b = Math.sin(cx * 269.5 + cz * 183.3 - seed * 41.3) * 24634.6345345;
  const h = (a - Math.floor(a)) * 0.65 + (b - Math.floor(b)) * 0.35;
  return h - Math.floor(h);
}

/* ---------------------------------------------------------------------- */
/* The trail                                                               */
/* ---------------------------------------------------------------------- */

/**
 * One instanced strip, N ribbons.
 *
 * A vertex arrives as `(v, side)` — how far along its own trail it is and which
 * edge it sits on — plus the four per-instance values that describe its body's
 * flight: two endpoints, two timings, four dice. It leaves as a world position.
 * Nothing about any trail exists on the CPU, which is what makes forty trails
 * cost one draw call and zero per-frame geometry work.
 *
 * The first version recorded the body's past positions into a ring buffer and
 * rebuilt a `RibbonGeometry` per body. That is forty draw calls, forty
 * allocations' worth of history, and — fatally — a trail that *cannot* be
 * reshaped by a slider, because the history is a record of metres. Sampling the
 * parametric flight backwards in the body's own clock has none of those
 * problems: dragging `apex` re-lofts the trail along with the rock making it,
 * with the simulation paused.
 */
const TRAIL_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uClock;        // seconds since the cast began
  uniform vec3  uSideAxis;     // the cast's lateral unit vector
  uniform float uPathCurve;    // easing exponent on the launch → land parameter
  uniform float uApex;         // ballistic loft, metres
  uniform float uApexCurve;    // >1 flattens the top of the lob
  uniform float uWeaveSide;    // lateral weave amplitude at launch, metres
  uniform float uWeaveUp;      // vertical weave amplitude at launch, metres
  uniform float uWeaveTurns;   // lateral cycles over the whole flight
  uniform float uWeaveTurnsUp; // vertical cycles over the whole flight
  uniform float uWeavePhase;   // radians the vertical weave leads the lateral
  uniform float uWeaveDecay;   // >0 pulls the weave to zero at the target

  uniform float uTrailSpan;    // how far back the tail reaches, seconds
  uniform float uTrailBurn;    // seconds the trail takes to eat itself after landing
  uniform float uTrailWidth;   // width at the head, metres
  uniform float uTrailTaper;   // >1 sharpens the tail to a point
  uniform float uTrailLift;    // metres the tail floats above the flown path

  attribute vec3  aLaunch;
  attribute vec3  aLand;
  attribute vec2  aTiming;     // x = launch delay (s), y = flight time (s)
  attribute vec4  aDice;       // seed, phase, weave sign, spin — all unitless

  varying float vAlong;        // 0 tail → 1 head
  varying float vSide;         // -1 .. 1 across the ribbon
  varying float vSeed;
  varying float vBurn;
  varying vec3  vWorld;
  varying float vViewZ;

  /**
   * The flight. Mirror of _pathPoint() in Projectile.js — if you change one,
   * change the other, or the body and its own trail will part company.
   */
  vec3 pathAt(float tau) {
    float t = clamp(tau, 0.0, 1.0);
    float s = pow(t, max(uPathCurve, 0.01));
    vec3 p = mix(aLaunch, aLand, s);

    p.y += uApex * pow(max(sin(PI * t), 0.0), max(uApexCurve, 0.05));

    float decay = pow(1.0 - t, max(uWeaveDecay, 0.0));
    float phase = aDice.y * TAU;
    p += uSideAxis * (uWeaveSide * aDice.z * decay * sin(TAU * uWeaveTurns * t + phase));
    p.y += uWeaveUp * aDice.z * decay * sin(TAU * uWeaveTurnsUp * t + phase + uWeavePhase);
    return p;
  }

  void main() {
    float flight = max(aTiming.y, 1e-3);
    float raw = (uClock - aTiming.x) / flight;

    // Before the body leaves the hand there is nothing to trail. Collapse the
    // whole instance outside the clip volume rather than drawing a dot at the
    // launch point.
    if (raw < 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    float head = min(raw, 1.0);
    float over = max(0.0, raw - 1.0) * flight;              // seconds since landing
    float burn = clamp(over / max(uTrailBurn, 1e-3), 0.0, 1.0);
    // The tail catches the head up rather than the whole ribbon fading: a trail
    // that dims uniformly reads as a light going out, one that shortens reads as
    // something that stopped being made.
    float span = (uTrailSpan / flight) * (1.0 - burn);
    float tail = max(0.0, head - span);

    float v = position.x;
    float tau = mix(tail, head, v);

    vec3 centre = pathAt(tau);
    vec3 ahead = pathAt(tau + ${EPSILON.toFixed(4)});
    vec3 tangent = ahead - centre;
    if (dot(tangent, tangent) < 1e-10) tangent = vec3(0.0, 0.0, 1.0);
    tangent = normalize(tangent);

    vec3 view = cameraPosition - centre;
    vec3 side = cross(tangent, view);
    if (dot(side, side) < 1e-10) side = vec3(1.0, 0.0, 0.0);
    side = normalize(side);

    float profile = pow(clamp(v, 0.0, 1.0), max(uTrailTaper, 0.01));
    vec3 world = centre
      + side * (position.y * 0.5 * uTrailWidth * profile)
      + vec3(0.0, uTrailLift * (1.0 - v), 0.0);

    vAlong = v;
    vSide = position.y;
    vSeed = aDice.x;
    vBurn = burn;
    vWorld = world;

    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const TRAIL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uGlobalGlow;

  uniform vec3  uColorA;       // at the head
  uniform vec3  uColorB;
  uniform vec3  uColorC;
  uniform vec3  uColorD;       // at the tail
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uCore;         // how tightly light crowds the centre line
  uniform float uHeadBias;     // >0 keeps the brightness near the body
  uniform float uNoise;        // how hard the grain eats into the ribbon
  uniform float uNoiseScale;   // features per metre
  uniform float uNoiseSpeed;
  uniform float uSoftFade;     // metres of depth feather against solid geometry

  varying float vAlong;
  varying float vSide;
  varying float vSeed;
  varying float vBurn;
  varying vec3  vWorld;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    // Across the ribbon: a hot filament in a soft sheath. The exponent is what
    // stops a wide trail reading as a flat strip of colour.
    float across = 1.0 - abs(vSide);
    float body = pow(clamp(across, 0.0, 1.0), max(uCore, 0.05));

    // Along it: the grain is sampled in *world* space so it stays pinned to the
    // air the body flew through instead of sliding along the ribbon's own uv,
    // which is the tell that gives a scrolling texture away.
    float grain = fbm3(vWorld * uNoiseScale + vec3(0.0, uTime * uNoiseSpeed, vSeed * 31.0));
    body *= 1.0 - uNoise * (0.5 - 0.5 * grain);

    float head = mix(1.0, pow(clamp(vAlong, 0.0, 1.0), 1.6), clamp(uHeadBias, 0.0, 1.0));
    float alpha = body * head * uOpacity * (1.0 - vBurn);
    if (alpha < 0.004) discard;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    vec3 colour = gradient4(uColorA, uColorB, uColorC, uColorD, 1.0 - vAlong);
    colour *= uGlow * uGlobalGlow;

    gl_FragColor = vec4(colour, clamp(alpha, 0.0, 1.0));
  }
`;

/* ---------------------------------------------------------------------- */
/* Scratch — the frame allocates nothing                                   */
/* ---------------------------------------------------------------------- */

const _point = new Vector3();
const _ahead = new Vector3();
const _behind = new Vector3();
const _heading = new Vector3();
const _axis = new Vector3();
const _dummy = new Object3D();
const _spin = new Quaternion();
const _aligned = new Quaternion();
const _UP = new Vector3(0, 1, 0);

/* ---------------------------------------------------------------------- */
/* Projectile                                                              */
/* ---------------------------------------------------------------------- */

/**
 * **What it draws.** One to a few hundred travelling bodies — rocks, needles,
 * stars, hailstones, blobs — each optionally dragging a ribbon trail.
 *
 * **Draw calls.** Two: one `InstancedMesh` for the bodies, one instanced strip
 * for every trail. Both are unconditional; a cast with no live body draws
 * nothing because the counts go to zero, not because the meshes are removed.
 *
 * **What it reads from settings.** Nothing directly. `update(now, params)` is
 * handed a live block every frame and resolves every key as `p.key ?? default`,
 * so you can either pass `settings[id]` outright (if your block uses the
 * canonical names — which makes breaking I1 impossible) or fill a scratch
 * object from it when you need to fold in `settings.global` multipliers.
 * `projectileParams()` returns the full key list with defaults and units.
 *
 * **The one rule for using it well.** Never write a metre into a dice roll.
 * `roll()` captures unitless fractions and nothing else; `update()` is handed a
 * *timestamp* and re-resolves every dimension from the params. If you find
 * yourself wanting to remember where a body was, you have already lost — ask
 * `pointAt()` again with a smaller τ.
 *
 * ---
 *
 * ## The flight
 *
 * Every mode is the same curve:
 *
 * ```
 *   p(τ) = mix(launch, land, τ^pathCurve)
 *        + up   · apex · sin(πτ)^apexCurve
 *        + side · weaveSide · (1-τ)^decay · sin(2π·turns·τ + φ)
 *        + up   · weaveUp   · (1-τ)^decay · sin(2π·turnsUp·τ + φ + ψ)
 * ```
 *
 * The modes differ only in where the two endpoints are and which coefficients
 * are non-zero. A ballistic lob is `apex > 0`; a homing bolt is `weave > 0` with
 * a decay that pulls the weave to *exactly* zero at τ = 1, which is why seven
 * bolts on seven different Lissajous paths arrive at one point on one frame with
 * nothing being simulated and nothing being corrected. A fall is a launch point
 * shared by every body, high and behind the caster, so the trails converge in
 * the sky and diverge on the ground — the parallax is the effect.
 *
 * ## Staggered arrival
 *
 * For a zone fill the launch delay comes from `spatialStagger()` of the landing
 * point, blended with a radial ordering (`fillBias`: +1 fills outward from the
 * centre, -1 inward from the boundary). Because the key is a property of the
 * *floor* and of the per-cast seed, the circle fills deterministically for a
 * given seed and never twice in the same order.
 */
export class Projectile {
  /**
   * @param {import('three').Object3D} parent  the ability's group
   * @param {object}          options
   * @param {number}          [options.capacity]  hard ceiling on bodies
   * @param {import('three').BufferGeometry|Function} options.geometry
   *        The body. A factory is re-run when `shapeKey` changes; a plain
   *        geometry is adopted outright (this class adds instanced attributes
   *        to it and disposes it).
   * @param {Function}        [options.shapeKey]  () => string, hashed for rebuilds
   * @param {import('three').Material} options.material  the body's material
   * @param {boolean}         [options.trail]     build the instanced multi-trail
   * @param {number}          [options.trailNodes] samples along one trail
   * @param {boolean}         [options.trailAdditive]
   * @param {number}          [options.layer]     LAYER.* for the bodies
   * @param {number}          [options.renderOrder]
   * @param {boolean}         [options.castShadow]
   */
  constructor(
    parent,
    {
      capacity = 48,
      geometry,
      shapeKey = null,
      material,
      trail = true,
      trailNodes = 28,
      trailAdditive = true,
      layer = LAYER.WORLD,
      renderOrder = 2,
      castShadow = false
    }
  ) {
    this.capacity = Math.max(1, Math.round(capacity));

    this.group = new Group();
    this.group.name = 'Projectile';
    this.group.matrixAutoUpdate = false;
    parent?.add(this.group);

    /* --- the bodies ------------------------------------------------- */

    this._geometryFactory = typeof geometry === 'function' ? geometry : null;
    this._shapeKey = shapeKey;
    this._shapeHash = '';

    this.seeds = new InstancedBufferAttribute(new Float32Array(this.capacity), 1);
    this.flights = new InstancedBufferAttribute(new Float32Array(this.capacity), 1);
    this.flashes = new InstancedBufferAttribute(new Float32Array(this.capacity), 1);
    this.seeds.setUsage(DynamicDrawUsage);
    this.flights.setUsage(DynamicDrawUsage);
    this.flashes.setUsage(DynamicDrawUsage);

    this.geometry = this._geometryFactory ? this._geometryFactory() : geometry;
    this._dressGeometry(this.geometry);

    this.material = material;
    this.mesh = new InstancedMesh(this.geometry, this.material, this.capacity);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = castShadow;
    this.mesh.count = 0;
    this.mesh.layers.set(layer);
    this.mesh.renderOrder = renderOrder;
    this.group.add(this.mesh);

    /* --- the trails ------------------------------------------------- */

    this.trailMesh = null;
    this.trailMaterial = null;
    this.trailGeometry = null;
    if (trail) this._buildTrail(Math.max(2, Math.round(trailNodes)), trailAdditive);

    /* --- the dice ---------------------------------------------------- */

    /**
     * Fixed-size record pool. A cast allocates nothing, and every field in here
     * is a *unitless* roll — see the class comment.
     */
    this.dice = [];
    for (let i = 0; i < this.capacity; i++) {
      this.dice.push({
        seed: 0, // 0..1, general-purpose
        angle: 0, // 0..1 of a turn, bearing of the landing point
        radial: 0, // 0..1, radius fraction before the bias exponent
        lateral: 0, // -1..1 across the cast line
        depth: 0, // -1..1 along the cast line
        speed: 0, // -1..1 flight-time jitter
        size: 0, // -1..1 radius jitter
        phase: 0, // 0..1 of a turn, weave phase
        weave: 0, // -1..1 weave amplitude and handedness
        spin: 0, // -1..1 tumble rate
        axis: new Vector3(0, 1, 0) // unit tumble axis
      });
    }

    /** Endpoints, re-resolved every frame. Metres — never read across frames. */
    this._launchPoints = [];
    this._landPoints = [];
    this._slotPoints = [];
    for (let i = 0; i < this.capacity; i++) {
      this._launchPoints.push(new Vector3());
      this._landPoints.push(new Vector3());
      this._slotPoints.push(new Vector3());
    }
    this._landedFlags = new Uint8Array(this.capacity);

    /** Bodies that crossed τ = 1 this frame. Consume it in `onTravel`. */
    this.arrivals = new Int32Array(this.capacity);
    this.arrivalCount = 0;

    /** Where the rolling body touches the floor, and how hard. */
    this.contact = new Vector3();
    this.contactLoad = 0;

    this.liveBodies = 0;
    this.liveTrails = 0;
    this.seed = 0;

    /* --- the basis --------------------------------------------------- */

    this._origin = new Vector3();
    this._direction = new Vector3(0, 0, 1);
    this._side = new Vector3(1, 0, 0);
    this._length = 1;

    /**
     * The last block `update()` resolved, defaults filled in.
     *
     * Owned per instance rather than module-scope so the read-back queries
     * (`pointAt`, `landPoint`) stay valid for *this* projectile after another
     * one has updated. Written into, never replaced — no frame allocates.
     */
    this._p = projectileParams();
  }

  /* ------------------------------------------------------------------ */
  /* Construction helpers                                                */
  /* ------------------------------------------------------------------ */

  _dressGeometry(geometry) {
    geometry.setAttribute('aSeed', this.seeds);
    geometry.setAttribute('aFlight', this.flights);
    geometry.setAttribute('aFlash', this.flashes);
  }

  /**
   * The instanced ladder every trail is drawn on, in *parameter* space.
   *
   * `position = (v, side, 0)`: v runs 0 → 1 from the tail to the head, side is
   * ±1 across the ribbon. There are no metres in the buffer at all, which is
   * what lets one strip serve forty bodies of any speed on any path.
   */
  _buildTrail(nodes, additive) {
    const positions = new Float32Array(nodes * 2 * 3);
    for (let i = 0; i < nodes; i++) {
      const v = i / (nodes - 1);
      const o = i * 6;
      positions[o + 0] = v;
      positions[o + 1] = -1;
      positions[o + 3] = v;
      positions[o + 4] = 1;
    }

    const indices = new Uint16Array((nodes - 1) * 6);
    for (let i = 0; i < nodes - 1; i++) {
      const a = i * 2;
      const o = i * 6;
      indices[o + 0] = a;
      indices[o + 1] = a + 1;
      indices[o + 2] = a + 2;
      indices[o + 3] = a + 1;
      indices[o + 4] = a + 3;
      indices[o + 5] = a + 2;
    }

    this.trailLaunch = new InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this.trailLand = new InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this.trailTiming = new InstancedBufferAttribute(new Float32Array(this.capacity * 2), 2);
    this.trailDice = new InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    for (const attribute of [this.trailLaunch, this.trailLand, this.trailTiming, this.trailDice]) {
      attribute.setUsage(DynamicDrawUsage);
    }

    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aLaunch', this.trailLaunch);
    geometry.setAttribute('aLand', this.trailLand);
    geometry.setAttribute('aTiming', this.trailTiming);
    geometry.setAttribute('aDice', this.trailDice);
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.instanceCount = 0;
    // Built in world space by the vertex shader, so its own bounds mean nothing.
    geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    this.trailGeometry = geometry;

    this.trailMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? AdditiveBlending : NormalBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uClock: { value: 0 },
        uSideAxis: { value: new Vector3(1, 0, 0) },
        uPathCurve: { value: 1 },
        uApex: { value: 0 },
        uApexCurve: { value: 1 },
        uWeaveSide: { value: 0 },
        uWeaveUp: { value: 0 },
        uWeaveTurns: { value: 1 },
        uWeaveTurnsUp: { value: 1 },
        uWeavePhase: { value: Math.PI * 0.5 },
        uWeaveDecay: { value: 1.6 },
        uTrailSpan: { value: 0.35 },
        uTrailBurn: { value: 0.25 },
        uTrailWidth: { value: 0.18 },
        uTrailTaper: { value: 1.4 },
        uTrailLift: { value: 0 },
        uColorA: { value: new Color('#ffffff') },
        uColorB: { value: new Color('#ffc27a') },
        uColorC: { value: new Color('#a03a12') },
        uColorD: { value: new Color('#100806') },
        uOpacity: { value: 1 },
        uGlow: { value: 1.4 },
        uCore: { value: 2.2 },
        uHeadBias: { value: 0.45 },
        uNoise: { value: 0.5 },
        uNoiseScale: { value: 1.6 },
        uNoiseSpeed: { value: 0.6 },
        uSoftFade: { value: 0.4 }
      }),
      vertexShader: TRAIL_VERTEX,
      fragmentShader: TRAIL_FRAGMENT
    });

    this.trailMesh = new Mesh(geometry, this.trailMaterial);
    this.trailMesh.frustumCulled = false;
    this.trailMesh.matrixAutoUpdate = false;
    this.trailMesh.layers.set(LAYER.VFX);
    // After the non-additive smoke (10) so a plume can occlude it, before the
    // additive particles (12) so sparks in front of it are not dimmed.
    this.trailMesh.renderOrder = 11;
    this.group.add(this.trailMesh);
  }

  /** Bodies drawn on the last update. → `Ability#instanceCount`. */
  get count() {
    return this.liveBodies;
  }

  /** One for the bodies, one more if they carry trails. */
  get drawCalls() {
    return this.trailMesh ? 2 : 1;
  }

  /** Live uniforms of the trail material, for anything `params` does not cover. */
  get trailUniforms() {
    return this.trailMaterial ? this.trailMaterial.uniforms : null;
  }

  /**
   * Head → tail colours. Four pickers, none derived from another.
   *
   * Takes `THREE.Color`s or `#rrggbb` strings straight out of a settings block;
   * the strings go through the memoised `getColor`, so calling this every frame
   * costs four copies and no allocation.
   */
  setTrailColors(a, b, c, d) {
    if (!this.trailMaterial) return;
    const u = this.trailMaterial.uniforms;
    u.uColorA.value.copy(typeof a === 'string' ? getColor(a) : a);
    u.uColorB.value.copy(typeof b === 'string' ? getColor(b) : b);
    u.uColorC.value.copy(typeof c === 'string' ? getColor(c) : c);
    const tail = d ?? c;
    u.uColorD.value.copy(typeof tail === 'string' ? getColor(tail) : tail);
  }

  /**
   * Rebuild the body geometry when a *shape* control moves.
   *
   * Only meaningful with a factory. Lumps, facets and cuts displace real
   * vertices — the silhouette and the shadow have to see them — so they cannot
   * be faked per instance, and a few hundred triangles is cheap enough to
   * simply regenerate. That is what keeps them live sliders.
   */
  syncGeometry() {
    if (!this._geometryFactory || !this._shapeKey) return;
    const key = String(this._shapeKey());
    if (key === this._shapeHash) return;
    this._shapeHash = key;

    const previous = this.geometry;
    this.geometry = this._geometryFactory();
    this._dressGeometry(this.geometry);
    this.mesh.geometry = this.geometry;
    previous.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  /** The cast's frame. Called once per frame by the ability; metres live here. */
  setBasis(origin, direction, side, length) {
    this._origin.copy(origin);
    this._direction.copy(direction);
    this._side.copy(side);
    this._length = Math.max(0.01, length);
    return this;
  }

  /**
   * Re-roll every body's dice. Call from `onSpawn` and nowhere else.
   *
   * @param {number} [seed] per-cast seed; random when omitted
   */
  roll(seed = Math.random() * 100) {
    this.seed = seed;
    for (let i = 0; i < this.capacity; i++) {
      const d = this.dice[i];
      d.seed = Math.random();
      d.angle = Math.random();
      d.radial = Math.random();
      d.lateral = Math.random() * 2 - 1;
      d.depth = Math.random() * 2 - 1;
      d.speed = Math.random() * 2 - 1;
      d.size = Math.random() * 2 - 1;
      d.phase = Math.random();
      d.weave = Math.random() * 2 - 1;
      d.spin = Math.random() * 2 - 1;

      // Uniform point on the sphere — `acos` on a uniform cosine, not a uniform
      // angle, or the tumble axes bunch at the poles.
      const phi = Math.acos(Math.random() * 2 - 1);
      const theta = Math.random() * TAU;
      const sinPhi = Math.sin(phi);
      d.axis.set(sinPhi * Math.cos(theta), Math.cos(phi), sinPhi * Math.sin(theta));
    }
    this._landedFlags.fill(0);
    this.arrivalCount = 0;
    return this;
  }

  /** Hide everything. Leaves the instance reusable — the pooling contract. */
  reset() {
    this.liveBodies = 0;
    this.liveTrails = 0;
    this.arrivalCount = 0;
    this.contactLoad = 0;
    this.mesh.count = 0;
    if (this.trailGeometry) this.trailGeometry.instanceCount = 0;
    this._landedFlags.fill(0);
  }

  /* ------------------------------------------------------------------ */
  /* The flight — every metre resolved from live params                  */
  /* ------------------------------------------------------------------ */

  /**
   * Fill `_p` from the caller's block, defaults where it is silent.
   *
   * A `for...in` over seventy keys per frame is a rounding error next to one
   * matrix rebuild, and it is what lets an ability hand this module its raw
   * `settings[id]` — the version of the contract that cannot be got wrong.
   */
  _resolve(params) {
    const p = this._p;
    for (const key in DEFAULT_PARAMS) {
      const value = params[key];
      p[key] = value === undefined ? DEFAULT_PARAMS[key] : value;
    }
    return p;
  }

  /** How many bodies this cast is flying, from the last resolved params. */
  _bodyCount(p) {
    return Math.max(0, Math.min(this.capacity, Math.round(p.count)));
  }

  /** Where a body leaves from, metres. Writes into `_launchPoints[i]`. */
  _resolveLaunch(i, p) {
    const d = this.dice[i];
    const out = this._launchPoints[i];

    if (p.mode === FlightMode.FALL) {
      // One shared vanishing point, above and behind the caster. The scatter is
      // deliberately tiny by default: the trails are supposed to *converge* up
      // there, and a metre of spread at fifty metres of height throws the whole
      // read away.
      out
        .copy(this._origin)
        .addScaledVector(this._direction, -p.skyBack + d.depth * p.skyScatter)
        .addScaledVector(this._side, d.lateral * p.skyScatter);
      out.y = p.skyHeight;
      return out;
    }

    out
      .copy(this._origin)
      .addScaledVector(this._direction, p.handForward)
      .addScaledVector(this._side, p.handSide);
    // A volley leaves the hand as a fan rather than from one point, otherwise
    // the first metre of seven needles is a single bright line.
    if (p.mode === FlightMode.VOLLEY) {
      const total = this._bodyCount(p);
      const fan = total > 1 ? (i / (total - 1)) * 2 - 1 : 0;
      out.addScaledVector(this._side, fan * p.fanWidth);
    }
    out.y = p.mode === FlightMode.ROLL ? this._radius(i, p) : p.handHeight;
    return out;
  }

  /** Where a body lands, metres. Writes into `_landPoints[i]`. */
  _resolveLand(i, p) {
    const d = this.dice[i];
    const out = this._landPoints[i];

    if (p.mode === FlightMode.FALL || p.landInZone) {
      // Uniform over the disc at bias 0.5; push the exponent down to crowd the
      // rim, up to crowd the middle.
      const radius = p.zoneRadius * Math.pow(saturate(d.radial), Math.max(0.05, p.zoneBias));
      const angle = d.angle * TAU;
      out
        .copy(this._origin)
        .addScaledVector(this._direction, this._length + radius * Math.sin(angle))
        .addScaledVector(this._side, radius * Math.cos(angle));
    } else {
      out
        .copy(this._origin)
        .addScaledVector(this._direction, this._length + d.depth * p.spreadForward)
        .addScaledVector(this._side, d.lateral * p.spreadSide);
    }

    out.y = p.mode === FlightMode.ROLL ? this._radius(i, p) : p.landHeight;
    return out;
  }

  /** Body radius, metres. */
  _radius(i, p) {
    return Math.max(0.005, p.radius * (1 + p.sizeJitter * this.dice[i].size));
  }

  /**
   * A body's launch delay, seconds.
   *
   * Needs the landing point, so it is resolved after `_resolveLand`.
   */
  _launchDelay(i, p) {
    let mode = p.stagger;
    if (mode === Stagger.AUTO) {
      mode =
        p.mode === FlightMode.FALL
          ? Stagger.HASH
          : p.mode === FlightMode.VOLLEY
            ? Stagger.RIPPLE
            : Stagger.NONE;
    }

    let order = 0;
    if (mode === Stagger.RIPPLE) {
      const total = this._bodyCount(p);
      order = total > 1 ? i / (total - 1) : 0;
    } else if (mode === Stagger.HASH) {
      const land = this._landPoints[i];
      // Radial ordering first: +1 fills outward from the centre, -1 inward from
      // the boundary, 0 leaves the hash to decide on its own.
      const radial = saturate(Math.pow(saturate(this.dice[i].radial), Math.max(0.05, p.zoneBias)));
      const radialOrder = saturate(0.5 + p.fillBias * (radial - 0.5));
      const hashed = spatialStagger(land.x, land.z, p.hashCell, this.seed);
      order = saturate(lerp(radialOrder, hashed, saturate(p.fillScatter)));
    }

    return p.lead + p.window * order;
  }

  /** A body's flight time, seconds. */
  _flightTime(i, p) {
    return Math.max(0.02, p.flightTime * (1 + p.speedJitter * this.dice[i].speed));
  }

  /**
   * The flight.
   *
   * Mirror of `pathAt()` in `TRAIL_VERTEX` — if you change one, change the
   * other, or a body and its own trail will part company. The formula is
   * documented on the class; everything in it is a live metre except `τ`.
   */
  _pathPoint(i, tau, out, p = this._p) {
    const d = this.dice[i];
    const t = saturate(tau);
    const s = Math.pow(t, Math.max(0.01, p.pathCurve));

    out.copy(this._launchPoints[i]).lerp(this._landPoints[i], s);
    out.y += p.apex * Math.pow(Math.sin(Math.PI * t), Math.max(0.05, p.apexCurve));

    const decay = Math.pow(1 - t, Math.max(0, p.weaveDecay));
    const phase = d.phase * TAU;
    out.addScaledVector(
      this._side,
      p.weaveSide * d.weave * decay * Math.sin(TAU * p.weaveTurns * t + phase)
    );
    out.y += p.weaveUp * d.weave * decay * Math.sin(TAU * p.weaveTurnsUp * t + phase + p.weavePhase);
    return out;
  }

  /**
   * Unit heading at τ.
   *
   * Differentiated numerically rather than by hand: every coefficient in the
   * path is a live slider, and a hand-written derivative is one more thing that
   * silently stops matching them.
   */
  _headingAt(i, tau, out, p = this._p) {
    this._pathPoint(i, tau + EPSILON, _ahead, p);
    this._pathPoint(i, tau - EPSILON, _behind, p);
    out.subVectors(_ahead, _behind);
    if (out.lengthSq() < 1e-10) return out.copy(this._direction);
    return out.normalize();
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Rebuild every instance from the live params.
   *
   * Consume `arrivals` immediately after this returns: an arrival fires on the
   * frame a body crosses τ = 1 and is not re-raised on the next call.
   *
   * @param {number} now    seconds since the cast began — a timestamp, and the
   *   only thing in here that is not re-resolved from the params.
   * @param {object} params live block; every key falls back to
   *   `projectileParams()` where it is absent.
   */
  update(now, params) {
    const p = this._resolve(params ?? DEFAULT_PARAMS);
    this.syncGeometry();

    const count = this._bodyCount(p);
    const linger = Math.max(0, p.linger);
    const trailBurn = Math.max(0.001, p.trailBurn);
    const spin = p.spin;
    const align = saturate(p.align);

    let bodySlot = 0;
    let trailSlot = 0;
    this.arrivalCount = 0;
    this.contactLoad = 0;

    for (let i = 0; i < count; i++) {
      const d = this.dice[i];
      this._resolveLaunch(i, p);
      this._resolveLand(i, p);

      const delay = this._launchDelay(i, p);
      const flight = this._flightTime(i, p);
      const since = now - delay; // seconds since this body left
      const tau = since / flight;

      /* --- arrival events, re-derived rather than remembered --------- */
      if (tau >= 1) {
        if (!this._landedFlags[i]) {
          this._landedFlags[i] = 1;
          this.arrivals[this.arrivalCount++] = i;
        }
      } else if (this._landedFlags[i]) {
        // Dragging a slider can put a landed body back in the air. Let it.
        this._landedFlags[i] = 0;
      }

      if (tau < 0) continue;

      const over = (tau - 1) * flight; // seconds since landing, negative in flight

      /* --- the trail -------------------------------------------------- */
      if (this.trailGeometry && (tau <= 1 || over <= trailBurn)) {
        const o3 = trailSlot * 3;
        const launch = this._launchPoints[i];
        const land = this._landPoints[i];
        this.trailLaunch.array[o3 + 0] = launch.x;
        this.trailLaunch.array[o3 + 1] = launch.y;
        this.trailLaunch.array[o3 + 2] = launch.z;
        this.trailLand.array[o3 + 0] = land.x;
        this.trailLand.array[o3 + 1] = land.y;
        this.trailLand.array[o3 + 2] = land.z;
        this.trailTiming.array[trailSlot * 2 + 0] = delay;
        this.trailTiming.array[trailSlot * 2 + 1] = flight;
        const o4 = trailSlot * 4;
        this.trailDice.array[o4 + 0] = d.seed;
        this.trailDice.array[o4 + 1] = d.phase;
        this.trailDice.array[o4 + 2] = d.weave;
        this.trailDice.array[o4 + 3] = d.spin;
        trailSlot++;
      }

      /* --- the body --------------------------------------------------- */
      if (tau > 1 && over > linger) continue;

      const held = Math.min(tau, 1);
      this._pathPoint(i, held, _point, p);
      const radius = this._radius(i, p);

      // A body sinks into the floor as it lingers rather than blinking out.
      if (over > 0 && p.sink > 0) {
        _point.y -= (over / Math.max(0.001, linger)) * p.sink * radius;
      }

      _dummy.position.copy(_point);
      this._slotPoints[bodySlot].copy(_point);

      if (p.mode === FlightMode.ROLL) {
        /*
         * Real rolling. The contact point has to be instantaneously at rest, so
         * the angle is *distance over radius* and nothing else — no spin slider
         * touches it. Get this wrong by any factor at all and the boulder
         * skates, which is the single most obvious failure mode a rolling
         * object has.
         *
         * The sign: for a body travelling along `direction`, the angular
         * velocity is about `direction × up` — which is `side` — with a
         * negative sense.
         */
        const travelled = this._launchPoints[i].distanceTo(_point);
        _axis.copy(this._side);
        _spin.setFromAxisAngle(_axis, -travelled / Math.max(0.01, radius));
        // What a GroundField(RUT) wants: where the body is pressing, and how
        // hard. Flat while it is rolling and zero once it has stopped — shape
        // it in the ability if the rut should deepen, because only the ability
        // knows whether its boulder is accelerating.
        this.contact.copy(_point);
        this.contact.y = 0;
        this.contactLoad = tau <= 1 ? saturate(p.load) : 0;
      } else {
        _axis.copy(d.axis);
        _spin.setFromAxisAngle(_axis, spin * d.spin * Math.max(0, since));
      }

      if (align > 0) {
        this._headingAt(i, held, _heading, p);
        _aligned.setFromUnitVectors(_UP, _heading);
        _spin.slerp(_aligned, align);
      }

      _dummy.quaternion.copy(_spin);
      _dummy.scale.set(radius, radius * Math.max(0.01, p.stretch), radius);
      _dummy.updateMatrix();
      this.mesh.setMatrixAt(bodySlot, _dummy.matrix);

      this.seeds.array[bodySlot] = d.seed;
      this.flights.array[bodySlot] = tau;
      this.flashes.array[bodySlot] = saturate(1 - since / Math.max(0.001, p.flash));
      bodySlot++;
    }

    this.liveBodies = bodySlot;
    this.liveTrails = trailSlot;

    this.mesh.count = bodySlot;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.seeds.needsUpdate = true;
    this.flights.needsUpdate = true;
    this.flashes.needsUpdate = true;

    if (this.trailGeometry) {
      this.trailGeometry.instanceCount = trailSlot;
      this.trailMesh.visible = trailSlot > 0 && p.trailWidth > 0 && p.trailOpacity > 0;
      this.trailLaunch.needsUpdate = true;
      this.trailLand.needsUpdate = true;
      this.trailTiming.needsUpdate = true;
      this.trailDice.needsUpdate = true;
      this._syncTrailUniforms(now, p);
    }
  }

  /** Push the live params into the trail's uniforms. */
  _syncTrailUniforms(now, p) {
    const u = this.trailMaterial.uniforms;
    u.uClock.value = now;
    u.uSideAxis.value.copy(this._side);
    u.uPathCurve.value = p.pathCurve;
    u.uApex.value = p.apex;
    u.uApexCurve.value = p.apexCurve;
    u.uWeaveSide.value = p.weaveSide;
    u.uWeaveUp.value = p.weaveUp;
    u.uWeaveTurns.value = p.weaveTurns;
    u.uWeaveTurnsUp.value = p.weaveTurnsUp;
    u.uWeavePhase.value = p.weavePhase;
    u.uWeaveDecay.value = p.weaveDecay;
    u.uTrailSpan.value = p.trailSpan;
    u.uTrailBurn.value = p.trailBurn;
    u.uTrailWidth.value = p.trailWidth;
    u.uTrailTaper.value = p.trailTaper;
    u.uTrailLift.value = p.trailLift;
    u.uOpacity.value = p.trailOpacity;
    u.uGlow.value = p.trailGlow;
    u.uCore.value = p.trailCore;
    u.uHeadBias.value = p.trailHeadBias;
    u.uNoise.value = p.trailNoise;
    u.uNoiseScale.value = p.trailNoiseScale;
    u.uNoiseSpeed.value = p.trailNoiseSpeed;
    u.uSoftFade.value = p.trailSoftFade;
  }

  /* ------------------------------------------------------------------ */
  /* Queries                                                             */
  /* ------------------------------------------------------------------ */

  /** World position of a drawn body, `slot` in `0 .. liveBodies-1`. */
  slotPosition(slot, out) {
    return out.copy(this._slotPoints[Math.max(0, Math.min(this.liveBodies - 1, slot))]);
  }

  /** Where body `index` lands, metres. Valid after `update`. */
  landPoint(index, out) {
    return out.copy(this._landPoints[Math.max(0, Math.min(this.capacity - 1, index))]);
  }

  /** Where body `index` is at τ. Valid after `update` has resolved endpoints. */
  pointAt(index, tau, out) {
    return this._pathPoint(Math.max(0, Math.min(this.capacity - 1, index)), tau, out);
  }

  /** Unit heading of body `index` at τ. */
  headingAt(index, tau, out) {
    return this._headingAt(Math.max(0, Math.min(this.capacity - 1, index)), tau, out);
  }

  dispose() {
    this.geometry.dispose();
    if (this.trailGeometry) this.trailGeometry.dispose();
    if (this.trailMaterial) this.trailMaterial.dispose();
    this.mesh.dispose();
    this.group.parent?.remove(this.group);
  }
}

/* ---------------------------------------------------------------------- */
/* Params                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * Every key `update()` understands, with its default and its unit.
 *
 * Call it to seed a scratch block you fill from `settings[id]` each frame, or
 * ignore it entirely and hand `update()` your settings block — anything absent
 * falls back to the value here. Defaults exist so that a forgotten field gives
 * a shape rather than a `NaN`, which is the single most expensive mistake to
 * debug in this codebase.
 */
export function projectileParams() {
  return {
    /* --- what is flying --- */
    mode: FlightMode.ARC, // FlightMode.*
    stagger: Stagger.AUTO, // Stagger.*
    count: 1, // live bodies, clamped to capacity
    radius: 0.35, // body radius, metres
    sizeJitter: 0.25, // ±fraction of radius
    stretch: 1, // scale along the aligned axis (needs `align`)
    align: 0, // 0 tumble freely, 1 lay +Y along the heading
    spin: 4, // tumble rate, radians/second
    flash: 0.12, // birth flash decay, seconds

    /* --- the launch --- */
    handForward: 0.55, // metres downrange of the caster
    handSide: 0.34, // metres to the caster's side
    handHeight: 1.35, // metres off the floor
    fanWidth: 0.5, // VOLLEY: half-width of the muzzle fan, metres

    /* --- the landing --- */
    landHeight: 0.0, // metres off the floor at the target
    spreadSide: 0, // ±metres across the cast line
    spreadForward: 0, // ±metres along it
    landInZone: false, // land on the far disc instead of the line's end
    zoneRadius: 4, // that disc, metres
    zoneBias: 0.5, // 0.5 uniform, <0.5 crowds the rim, >0.5 crowds the middle

    /* --- the curve --- */
    pathCurve: 1, // easing exponent on launch → land (>1 accelerates)
    apex: 1.6, // ballistic loft, metres
    apexCurve: 1, // >1 flattens the top of the lob
    weaveSide: 0, // lateral weave at launch, metres
    weaveUp: 0, // vertical weave at launch, metres
    weaveTurns: 1.5, // lateral cycles over the flight
    weaveTurnsUp: 2.5, // vertical cycles over the flight
    weavePhase: Math.PI * 0.5, // radians the vertical weave leads by
    weaveDecay: 1.6, // >0 pulls the weave to zero exactly at the target

    /* --- the fall --- */
    skyBack: 9, // metres behind the caster the vanishing point sits
    skyHeight: 26, // metres above the floor
    skyScatter: 0.4, // ±metres of spread around it (0 = perfect convergence)

    /* --- the clock --- */
    flightTime: 0.7, // seconds one body is in the air
    speedJitter: 0.15, // ±fraction of flight time
    lead: 0, // seconds before the first body leaves
    window: 0.9, // seconds the staggered launches are spread over
    fillBias: -1, // +1 fills outward from the centre, -1 inward from the rim
    fillScatter: 0.55, // 0 pure radial order, 1 pure spatial hash
    hashCell: 1.1, // hash lattice size, metres
    linger: 0, // seconds a landed body stays on the floor
    sink: 1.2, // body radii it sinks over that linger

    /* --- the rut --- */
    load: 1, // ROLL: peak contact load, 0..1

    /* --- the trail --- */
    trailSpan: 0.3, // seconds of flight the tail reaches back over
    trailBurn: 0.22, // seconds the tail takes to catch up after landing
    trailWidth: 0.16, // metres at the head
    trailTaper: 1.4, // >1 sharpens the tail to a point
    trailLift: 0, // metres the tail floats above the flown path
    trailOpacity: 1,
    trailGlow: 1.4,
    trailCore: 2.2, // how tightly light crowds the centre line
    trailHeadBias: 0.45, // >0 keeps the brightness near the body
    trailNoise: 0.5,
    trailNoiseScale: 1.6, // features per metre
    trailNoiseSpeed: 0.6,
    trailSoftFade: 0.4 // metres of depth feather against solid geometry
  };
}

/** Resolved once at module load; `_resolve` walks its keys every frame. */
const DEFAULT_PARAMS = projectileParams();
