import {
  BufferGeometry,
  BufferAttribute,
  Mesh,
  MeshStandardMaterial,
  InstancedMesh,
  Object3D,
  Sphere,
  Vector3,
  DynamicDrawUsage
} from 'three';
import { Ability } from '../Ability.js';
import {
  createFissureMaterial,
  FissurePass,
  FISSURE_LAYER,
  MAX_FISSURE_ARMS
} from '../../materials/TectonicMaterial.js';
import { Shell, ShellMode, shellDefaults } from '../../vfx/Shell.js';
import { createAsteroidGeometry } from '../../assets/ProceduralGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, Easing, randRange } from '../../utils/math.js';

/* ---------------------------------------------------------------- */
/* Fixed sizes — buffers are allocated once and rewritten per cast    */
/* ---------------------------------------------------------------- */

/** Samples along one main arm, centre to boundary. */
const ARM_NODES = 64;
/** Samples along one fork. */
const FORK_NODES = 18;
/** Forks hung off each arm. The `forks` slider culls them live. */
const FORKS_PER_ARM = 2;
const NODES_PER_ARM = ARM_NODES + FORKS_PER_ARM * FORK_NODES;
const MAX_NODES = MAX_FISSURE_ARMS * NODES_PER_ARM;
/** Basalt shouldered up along the lips. One InstancedMesh, one draw call. */
const MAX_LIPS = 40;
/** Where an arm leaves the middle, as a fraction of the footprint. */
const START_REACH = 0.05;
const TAU = Math.PI * 2;

/**
 * Which arm gets which speed, as a unitless dice in 0..1.
 *
 * A **table**, not a roll, and the order matters: index 0 is always the fastest
 * and index 1 always the slowest, so however far the `arms` slider is dragged —
 * and it is a live slider, so it can be dragged mid-slam — the network still
 * contains an arm running at exactly `fissureSpeed · (1 + speedSpread)` and one
 * running at exactly `fissureSpeed`. The shockwave ring is timed against the
 * first of those, and a derivation that only holds for *some* arm counts is not
 * a derivation. What the cast randomises is the **bearing** (`_spin`), so the
 * fast crack does not leave on the same heading twice.
 *
 * The remaining six are a low-discrepancy spread rather than an even ramp: an
 * even ramp fanned around the circle reads as a rotating sweep, which is a
 * different (and much more mechanical) effect from five cracks racing.
 */
const SPEED_ORDER = [1, 0, 0.62, 0.28, 0.85, 0.14, 0.46, 0.74];

const _emit = {};
const _pos = new Vector3();
const _tip = new Vector3();
const _dir = new Vector3();
const _tangent = new Vector3();
const _centre = new Vector3();
const _dummy = new Object3D();

/**
 * TECTONIC SLAM — the ground is hit once, and then it tears.
 *
 * A far cast. A shock front runs out along the floor to the aimed circle, the
 * caster brings it down, and five fissures whip outward from that point to the
 * boundary **at different speeds**, each with a wave of dust riding just behind
 * its own tip. The floor of every crack opens white, cools through ember to
 * dead basalt on its own local clock, and blocks of crust are shouldered up
 * along the lips as each tip passes them. A pressure ring goes out with the
 * fastest crack and touches the boundary on the same frame it does.
 *
 * **THE TRICK — the footprint is drawn by motion, not revealed.** Every other
 * far cast in the sandbox tells you where it lands by lighting the disc up: the
 * Snare snaps its field open, the Crown freezes its sheet outward. This one
 * never draws the disc at all. What you get is five racing lines with different
 * arrival times, and the circle only exists in your head, assembled out of
 * where the tips went. That is why the speeds must genuinely differ — five arms
 * on one clock is a star, and a star is revealed all at once whatever it is
 * made of.
 *
 * **The derivation.** The ring is not tuned to match the cracks. The fastest
 * arm runs at `fissureSpeed · (1 + speedSpread)`, so it reaches the boundary at
 * `t = zoneRadius / that`, and the shell is handed `t_norm = slamAge / t` with
 * an end radius of `zoneRadius · ringReach`. `Shell` interpolates
 * `radius → radiusEnd` and lands exactly on `radiusEnd` at `t_norm = 1`, so the
 * two events coincide by construction — drag `zoneRadius`, `fissureSpeed` or
 * `speedSpread` mid-cast and they *stay* coincident. `ringRadiusEnd` is
 * therefore deliberately **not** a slider: it is the one number in the block
 * that is a consequence rather than a taste, and it is assigned onto a proxy
 * that inherits from the live block so `Shell` reads it without anything ever
 * being written back into settings.
 *
 * **The shake ramps.** `shake.add()` at the slam is a spike, and a spike says
 * "an event happened here" — which is the wrong sentence, because the event is
 * still happening for the next second. So the slam gets a small punch and the
 * rumble then *climbs* with the propagation, peaking as the tips hit the rim,
 * and decays with the embers. The first version spiked once and the cracks
 * afterwards felt like decoration.
 *
 * **The rule that makes the editor work.** A cast captures four things: a seed,
 * a spin fraction (0..1, turned into a bearing by the shader), a per-arm
 * unitless angular walk, and the timestamp of the slam. Not one metre, radian
 * or second. The footprint, the crack widths, the propagation speeds, the ember
 * cooling and the ring are all resolved against `settings.tectonic` every
 * frame, on a zero-length frame included — so pausing mid-propagation and
 * dragging `zoneRadius` re-scales a network that is already halfway across it,
 * with the tips carrying on from where they now are.
 */
export class TectonicAbility extends Ability {
  constructor(context) {
    super('tectonic', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* ---- the crack network: one ribbon strip, two passes ---- */
    this._buildFissureGeometry();

    this.gashMaterial = createFissureMaterial(FissurePass.GASH);
    this.glowMaterial = createFissureMaterial(FissurePass.UNDERGLOW);
    this.fissureMaterials = [this.glowMaterial, this.gashMaterial];

    this.fissureMeshes = [];
    for (const [index, material] of this.fissureMaterials.entries()) {
      const mesh = new Mesh(this.geometry, material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(FISSURE_LAYER);
      // Underglow under the gash: the ember light spills onto the stone either
      // side, so it has to be behind the hole it is coming out of.
      mesh.renderOrder = index === 0 ? 7 : 9;
      mesh.visible = false;
      this.group.add(mesh);
      this.fissureMeshes.push(mesh);
    }

    /* ---- basalt shouldered up along the lips ---- */
    // Few cuts on purpose: at higher subdivision a heavily sliced rock rounds
    // off into a pebble, and these have to read as blocks of crust levered out
    // of a floor rather than as gravel dropped on it.
    this.lipGeometry = createAsteroidGeometry({
      seed: 8.3,
      detail: 1,
      lumpiness: 0.3,
      noiseScale: 1.7,
      roughness: 0.2,
      cuts: 4,
      cutDepth: 0.22,
      craters: 2
    });
    this.lipMaterial = new MeshStandardMaterial({
      color: 0x8a7f6b,
      roughness: 0.96,
      metalness: 0.02,
      flatShading: true
    });
    this.lips = new InstancedMesh(this.lipGeometry, this.lipMaterial, MAX_LIPS);
    this.lips.castShadow = true;
    this.lips.receiveShadow = true;
    this.lips.frustumCulled = false;
    this.lips.count = 0;
    this.lips.layers.set(LAYER.WORLD);
    this.group.add(this.lips);

    /* ---- the pressure ring ---- */
    // A DOME squashed almost flat is a ring standing on the floor with a bright
    // seal where it meets it, which is what a pressure front looks like from
    // above. PRESSURE mode is a *sphere* and reads as a bubble over the zone.
    this.ring = new Shell({ mode: ShellMode.DOME, prefix: 'ring', nodes: 36, sides: 72, renderOrder: 13 });
    this.ring.visible = false;
    this.group.add(this.ring.group);

    /**
     * The object `Shell` is handed instead of the settings block.
     *
     * It **inherits** from the live block, so every `ringX` slider the block
     * does own is read straight off it with no copying and no staleness, and
     * the only own properties on it are the handful this ability derives
     * (`ringRadiusEnd`) plus fallbacks for the corners of the shell vocabulary
     * a flattened dome has no use for — the ring train and the sun disc. Those
     * are filled once, here, so `Shell`'s missing-key audit has nothing to say
     * and the editor is not asked to carry twenty-four controls that do
     * nothing in this mode.
     */
    this._ringConfig = Object.create(settings.tectonic);
    const ringFallback = shellDefaults('ring', ShellMode.DOME);
    for (const key of Object.keys(ringFallback)) {
      if (!(key in settings.tectonic)) this._ringConfig[key] = ringFallback[key];
    }

    /* ---- per-cast state: dice and timestamps only ---- */
    /** Unitless 0..1; the shader turns it into the fan's bearing. */
    this._spin = 0;
    this._seed = 0;
    /** The moment the slam landed, or -1 while the front is still travelling. */
    this._slamTime = -1;
    this._lipsDrawn = 0;
    this._lipCount = 0;
    this._markArm = 0;

    /** Per-arm dice, re-rolled per cast. Nothing here has a unit. */
    this._bearJitter = new Float32Array(MAX_FISSURE_ARMS);
    /** The baked angular walk, and its derivative — the CPU's copy of it. */
    this._wander = new Float32Array(MAX_FISSURE_ARMS * ARM_NODES);
    this._wanderRate = new Float32Array(MAX_FISSURE_ARMS * ARM_NODES);

    this.lipRecords = [];
    for (let i = 0; i < MAX_LIPS; i++) {
      this.lipRecords.push({
        arm: 0,
        reach: 0, // 0..1 out along its arm
        side: 1, // which lip it was levered onto
        yaw: 0, // 0..1 of a turn
        size: 0, // 0..1
        flat: 0, // 0..1
        offset: 0 // 0..1 how far outside the crack edge
      });
    }

    // Scratch state handed to the materials and the shell each frame. One
    // object apiece, reused — syncing a standing slam allocates nothing.
    this._state = { centre: new Vector3(), age: 0, fade: 1, seed: 0, spin: 0 };
    this._ringState = {
      origin: new Vector3(),
      axis: new Vector3(0, 1, 0),
      side: new Vector3(1, 0, 0),
      span: 0,
      t: 0,
      fade: 1,
      seed: 0
    };
  }

  /** Allocate the ribbon strip. Filled by `_generate()`, never grown. */
  _buildFissureGeometry() {
    const vertices = MAX_NODES * 2;
    this.positions = new Float32Array(vertices * 3);
    this.shapes = new Float32Array(vertices * 4);
    this.roles = new Float32Array(vertices * 4);
    this.edges = new Float32Array(vertices * 2);
    this.indices = new Uint16Array(MAX_NODES * 6);

    // The two edges of the ribbon never change hands.
    for (let i = 0; i < vertices; i++) this.edges[i * 2] = i % 2 === 0 ? -1 : 1;

    this.geometry = new BufferGeometry();
    const attribute = (array, size) => new BufferAttribute(array, size).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', attribute(this.positions, 3));
    this.geometry.setAttribute('aShape', attribute(this.shapes, 4));
    this.geometry.setAttribute('aRole', attribute(this.roles, 4));
    this.geometry.setAttribute('aEdge', attribute(this.edges, 2));
    this.geometry.setIndex(new BufferAttribute(this.indices, 1));
    this.geometry.setDrawRange(0, 0);
    // The vertex shader places everything in world space off `uCentre`, so the
    // local bounds are meaningless. Frustum culling is off; this is only here
    // so three never tries to compute them from the attribute.
    this.geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The wave that rides behind each tip. Non-additive, because it has to
    // *occlude* — a dust front you can see the floor through is a haze, and a
    // haze does not read as a tonne of stone being displaced.
    this.dust = particles.get('tectonic.dust', {
      capacity: 3000,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.dust.uniforms.uDrag.value = 2.2;
    this.dust.uniforms.uEndSize.value = 3.4;
    this.dust.uniforms.uSizeIn.value = 0.1;
    this.dust.uniforms.uFadeIn.value = 0.12;
    this.dust.uniforms.uFadeOut.value = 0.34;

    // Chips of floor thrown up by the tearing tip.
    this.grit = particles.get('tectonic.grit', {
      capacity: 2000,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.grit.uniforms.uDrag.value = 0.2;
    this.grit.uniforms.uEndSize.value = 0.8;
    this.grit.uniforms.uFadeOut.value = 0.72;

    // Embers lifting out of the open crack. These are the only additive thing
    // the ability owns besides the underglow, and they die at knee height.
    this.embers = particles.get('tectonic.embers', {
      capacity: 2200,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.embers.uniforms.uDrag.value = 1.5;
    this.embers.uniforms.uEndSize.value = 0.16;
    this.embers.uniforms.uSizeIn.value = 0.05;
    this.embers.uniforms.uFadeIn.value = 0.07;
    this.embers.uniforms.uFadeOut.value = 0.42;

    this.dustEmitter = new RateEmitter();
    this.gritEmitter = new RateEmitter();
    this.emberEmitter = new RateEmitter();
    this.markEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing — every one of these is a live derivation                    */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._lipsDrawn + this.ring.instanceCount;
  }

  /** The live footprint, metres. What the circle indicator measured out. */
  get radius() {
    return Math.max(0.2, settings.tectonic.zoneRadius);
  }

  /** Metres/second of reach for one arm, given its unitless speed dice. */
  _speedOf(dice) {
    const c = settings.tectonic;
    const base = Math.max(0.2, c.fissureSpeed) * Math.max(0.05, settings.global.speed);
    return base * (1 + Math.max(0, c.speedSpread) * dice);
  }

  /** Seconds the fastest arm — and therefore the ring — takes to reach the rim. */
  _fastArrival() {
    return this.radius / this._speedOf(1);
  }

  /** Seconds the slowest arm takes. The hold does not start until it lands. */
  _slowArrival() {
    return this.radius / this._speedOf(0);
  }

  /** Seconds since the slam. A clock off a timestamp, not a captured second. */
  get slamAge() {
    return this._slamTime < 0 ? 0 : Math.max(0, this.age - this._slamTime);
  }

  /** The propagation, 0..1, measured against the *slowest* arm. */
  get propagation() {
    return saturate(this.slamAge / Math.max(0.02, this._slowArrival()));
  }

  get impactDuration() {
    return Math.max(0.2, this._slowArrival() + settings.tectonic.holdTime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.2, settings.tectonic.settleTime);
  }

  /**
   * The light cools with the ground rather than shimmering.
   *
   * Ice glints and lightning gutters; a crack full of ember does neither. It
   * has one slow breath in it and then it goes out, on the same `emberCool`
   * constant the fissure floors use — which is why dragging that slider dims
   * the room as well as the crack.
   */
  lightShimmer() {
    const c = settings.tectonic;
    const breathe = 0.86 + 0.14 * Math.sin(this.age * c.lightBreath);
    if (this._slamTime < 0) return breathe;
    return breathe * (c.lightFloor + (1 - c.lightFloor) * Math.exp(-this.slamAge / Math.max(0.05, c.emberCool)));
  }

  /* ------------------------------------------------------------------ */
  /* The network — generated once per cast, in dice                      */
  /* ------------------------------------------------------------------ */

  /**
   * Roll a fresh crack network into the buffers.
   *
   * Everything written here is **unitless**: a fraction of the footprint, an
   * angular walk in units of `wander`, a width jitter, an index. The metres and
   * the radians are applied in the vertex shader, every frame, which is what
   * makes `zoneRadius`, `wander`, `arms` and `fissureWidth` live sliders on a
   * network that is already open. `effects/GroundFissures.js` bakes `x, z` and
   * therefore cannot do that; this is the one thing this ability does that its
   * ancestor could not.
   *
   * All `MAX_FISSURE_ARMS` arms are always generated. The `arms` slider culls
   * them in the shader instead of deciding how many exist, so it can be dragged
   * mid-slam and the fan re-spaces itself.
   */
  _generate() {
    let node = 0;
    let quad = 0;
    const dr = (1 - START_REACH) / (ARM_NODES - 1);

    for (let arm = 0; arm < MAX_FISSURE_ARMS; arm++) {
      this._bearJitter[arm] = randRange(-1, 1);
      const speed01 = SPEED_ORDER[arm];
      const base = arm * ARM_NODES;

      /* --- the angular walk, in units of `wander` --- */
      // A steady curvature plus a smoothed stagger, pulled back toward the
      // launch bearing each step. Without the pull-back a constant veer curls
      // an arm into a circle instead of driving it out of the impact, which is
      // the mistake `GroundFissures` documents and this inherits the fix for.
      const curvature = randRange(-1, 1);
      let rate = curvature;
      let walk = 0;
      for (let i = 0; i < ARM_NODES; i++) {
        this._wander[base + i] = walk;
        rate = clamp(rate + randRange(-0.45, 0.45), -3, 3);
        rate = lerp(rate, curvature, 0.08);
        walk = walk * 0.94 + rate * dr;
      }
      // The rate the ribbon is squared against is the *actual* derivative of
      // the walk, taken by central difference. Storing the integrator's `rate`
      // instead left the ribbon leaning, because the pull-back had bent the
      // centreline underneath it.
      for (let i = 0; i < ARM_NODES; i++) {
        const a = this._wander[base + Math.max(0, i - 1)];
        const b = this._wander[base + Math.min(ARM_NODES - 1, i + 1)];
        const span = (Math.min(ARM_NODES - 1, i + 1) - Math.max(0, i - 1)) * dr;
        this._wanderRate[base + i] = span > 1e-6 ? (b - a) / span : 0;
      }

      /* --- the arm itself --- */
      let jitter = 1;
      const armFirst = node;
      for (let i = 0; i < ARM_NODES; i++) {
        const reach = START_REACH + i * dr;
        jitter = clamp(jitter + randRange(-0.16, 0.16), 0.6, 1.45);
        // A crack terminates in a needle at the rim and is pinched where it
        // leaves the middle, so the network has no sawn-off ends.
        const tip = Math.pow(saturate((1 - reach) / 0.16), 0.55);
        const root = Math.pow(saturate((reach - START_REACH) / 0.07), 0.5);
        node = this._pushNode(
          node,
          reach, 0, 0,
          this._wander[base + i], this._wanderRate[base + i], reach, jitter * tip * root,
          arm, this._bearJitter[arm], 0, speed01,
          0
        );
      }
      quad = this._stitch(armFirst, node, quad);

      /* --- forks, hung off it in its own frame --- */
      for (let f = 0; f < FORKS_PER_ARM; f++) {
        const anchorIndex = Math.floor(randRange(ARM_NODES * 0.28, ARM_NODES * 0.82));
        const anchorReach = START_REACH + anchorIndex * dr;
        // 30°–70° off the parent. Baked, unlike the arm's veer: `forks` and
        // `forkLength` are the two fork controls worth having live, and a
        // per-fork bearing uniform would need an array indexed by something
        // that is not a loop counter, which GLSL ES 1.00 will not compile.
        const phi = (Math.random() < 0.5 ? 1 : -1) * randRange(0.52, 1.22);
        const cos = Math.cos(phi);
        const sin = Math.sin(phi);
        const span = randRange(0.16, 0.34);
        const rank = (f * MAX_FISSURE_ARMS + arm + 1) / (FORKS_PER_ARM * MAX_FISSURE_ARMS);
        const forkFirst = node;

        for (let j = 0; j < FORK_NODES; j++) {
          const t = j / (FORK_NODES - 1);
          const travelled = t * span;
          node = this._pushNode(
            node,
            anchorReach, cos * travelled, sin * travelled,
            this._wander[base + anchorIndex], this._wanderRate[base + anchorIndex],
            anchorReach + travelled, 0.62 * (1 - t * 0.25) * randRange(0.8, 1.2),
            arm, this._bearJitter[arm], Math.max(t, 1e-3), speed01,
            rank
          );
        }
        quad = this._stitch(forkFirst, node, quad);
      }
    }

    this.geometry.setDrawRange(0, quad * 6);
    for (const name of ['position', 'aShape', 'aRole', 'aEdge']) {
      this.geometry.attributes[name].needsUpdate = true;
    }
    this.geometry.index.needsUpdate = true;

    /* --- where the crust gets levered up --- */
    let lip = 0;
    const stride = Math.max(3, Math.floor((ARM_NODES - 10) / Math.ceil(MAX_LIPS / MAX_FISSURE_ARMS)));
    for (let arm = 0; arm < MAX_FISSURE_ARMS && lip < MAX_LIPS; arm++) {
      for (let i = 6; i < ARM_NODES - 2 && lip < MAX_LIPS; i += stride) {
        const record = this.lipRecords[lip++];
        record.arm = arm;
        record.reach = START_REACH + i * dr;
        record.side = i % (stride * 2) === 6 % (stride * 2) ? 1 : -1;
        record.yaw = Math.random();
        record.size = Math.random();
        record.flat = Math.random();
        record.offset = Math.random();
      }
    }
    this._lipCount = lip;
  }

  /** Write one ribbon node — two vertices, both edges. Returns the next index. */
  _pushNode(node, baseReach, along, lateral, wander, rate, prop, width, arm, bearJit, fork, speed01, rank) {
    if (node >= MAX_NODES) return node;
    const v = node * 2;
    for (let k = 0; k < 2; k++) {
      const i = v + k;
      this.positions[i * 3 + 0] = baseReach;
      this.positions[i * 3 + 1] = along;
      this.positions[i * 3 + 2] = lateral;
      this.shapes[i * 4 + 0] = wander;
      this.shapes[i * 4 + 1] = rate;
      this.shapes[i * 4 + 2] = prop;
      this.shapes[i * 4 + 3] = width;
      this.roles[i * 4 + 0] = arm;
      this.roles[i * 4 + 1] = bearJit;
      this.roles[i * 4 + 2] = fork;
      this.roles[i * 4 + 3] = speed01;
      this.edges[i * 2 + 1] = rank;
    }
    return node + 1;
  }

  /** Stitch one run of nodes into the index buffer. Runs are never joined. */
  _stitch(first, last, quad) {
    for (let i = first; i < last - 1; i++) {
      const a = i * 2;
      this.indices[quad * 6 + 0] = a;
      this.indices[quad * 6 + 1] = a + 1;
      this.indices[quad * 6 + 2] = a + 2;
      this.indices[quad * 6 + 3] = a + 1;
      this.indices[quad * 6 + 4] = a + 3;
      this.indices[quad * 6 + 5] = a + 2;
      quad++;
    }
    return quad;
  }

  /* ------------------------------------------------------------------ */
  /* The JS mirror of the vertex shader                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Where arm `arm` is at `reach` (0..1 of the footprint), in world space, and
   * optionally which way it is heading there.
   *
   * A line-for-line mirror of the first half of `FISSURE_VERTEX`, and it has to
   * stay one: this is what puts the dust wave on the crack instead of near it.
   * `Tube#radiusAt` and `Projectile#_pathPoint` are the same pattern — if you
   * edit the bearing in one, edit it in the other.
   */
  _armFrame(arm, reach, out, tangent = null) {
    const c = settings.tectonic;
    const g = settings.global;
    const arms = clamp(Math.round(c.arms), 1, MAX_FISSURE_ARMS);
    const radius = this.radius;

    const f = saturate((reach - START_REACH) / (1 - START_REACH)) * (ARM_NODES - 1);
    const i0 = Math.min(ARM_NODES - 1, Math.floor(f));
    const i1 = Math.min(ARM_NODES - 1, i0 + 1);
    const k = f - i0;
    const base = arm * ARM_NODES;
    const walk = lerp(this._wander[base + i0], this._wander[base + i1], k);
    const rate = lerp(this._wanderRate[base + i0], this._wanderRate[base + i1], k);

    const wander = c.wander * g.randomness;
    const bearing =
      this._spin * TAU + ((arm + 0.5) / arms) * TAU + this._bearJitter[arm] * c.armJitter;
    const theta = bearing + walk * wander;
    const dTheta = rate * wander;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);

    out.set(
      this._state.centre.x + cos * reach * radius,
      c.fissureHeight,
      this._state.centre.z + sin * reach * radius
    );

    if (tangent) {
      tangent.set(cos - reach * dTheta * sin, 0, sin + reach * dTheta * cos);
      if (tangent.lengthSq() < 1e-8) tangent.set(cos, 0, sin);
      tangent.normalize();
    }
    return out;
  }

  /** How far arm `arm`'s tip has got, 0..1 of the footprint. */
  _tipReach(arm) {
    const front = this.slamAge * this._speedOf(SPEED_ORDER[arm]);
    return saturate(front / this.radius);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.dustEmitter.reset();
    this.gritEmitter.reset();
    this.emberEmitter.reset();
    this.markEmitter.reset();

    // The four things a cast captures, and all four are dice or clocks.
    this._seed = Math.random() * 100;
    this._spin = Math.random();
    this._slamTime = -1;
    this._markArm = 0;

    this._generate();

    this._lipsDrawn = 0;
    this.lips.count = 0;
    this.ring.visible = false;
    for (const mesh of this.fissureMeshes) mesh.visible = false;

    this._sync(1);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the cast's dice into both fissure passes, the
   * rubble, the ring and the three particle systems.
   *
   * @param {number} fade 1 while the ground is open, ramping to 0 as it settles
   */
  _sync(fade) {
    const c = settings.tectonic;
    const g = settings.global;
    const state = this._state;

    this.pointAt(1, state.centre).setY(0);
    state.age = this.slamAge;
    state.fade = fade;
    state.seed = this._seed;
    state.spin = this._spin;

    for (const material of this.fissureMaterials) material.userData.sync(state);

    const slammed = this._slamTime >= 0;
    for (const mesh of this.fissureMeshes) mesh.visible = slammed && fade > 0.002;

    this._poseLips(fade);
    this._syncRing(fade);

    /* --- the three particle systems --- */
    this.dust.setGradient(
      getColor(c.colorDustA),
      getColor(c.colorDustB),
      getColor(c.colorDustC),
      getColor(c.colorDustD)
    );
    this.dust.uniforms.uGravity.value.set(0, c.dustRise, 0);
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize;
    this.dust.uniforms.uLifeScale.value = c.dustLifetime * 0.5 * g.particleLifetime;
    this.dust.uniforms.uSpeedScale.value = c.dustSpeed * g.particleSpeed;
    this.dust.uniforms.uOpacity.value = c.dustOpacity * g.opacity;
    this.dust.uniforms.uTurbulence.value = c.dustTurbulence * g.turbulence;

    this.grit.setGradient(
      getColor(c.colorGritA),
      getColor(c.colorGritB),
      getColor(c.colorGritC),
      getColor(c.colorGritD)
    );
    this.grit.uniforms.uGravity.value.set(0, c.gritGravity, 0);
    this.grit.uniforms.uSizeScale.value = c.gritSize * g.particleSize * 7;
    this.grit.uniforms.uLifeScale.value = g.particleLifetime;
    this.grit.uniforms.uSpeedScale.value = g.particleSpeed;
    this.grit.uniforms.uOpacity.value = g.opacity;

    this.embers.setGradient(
      getColor(c.colorSparkA),
      getColor(c.colorSparkB),
      getColor(c.colorSparkC),
      getColor(c.colorSparkD)
    );
    this.embers.uniforms.uGravity.value.set(0, c.emberRise, 0);
    this.embers.uniforms.uSizeScale.value = c.emberSize * g.particleSize * 7;
    this.embers.uniforms.uLifeScale.value = c.emberLifetime * 0.5 * g.particleLifetime;
    this.embers.uniforms.uSpeedScale.value = g.particleSpeed;
    this.embers.uniforms.uOpacity.value = g.opacity;
    this.embers.uniforms.uGlow.value = c.emberGlow * g.glow;
    this.embers.uniforms.uTurbulence.value = c.emberTurbulence * g.turbulence;
  }

  /**
   * Place every block of crust from the live settings.
   *
   * A record holds an arm, a reach and four dice. Where that is in metres, how
   * big the block is and how far it has been shouldered out of the lip are all
   * resolved here, so dragging `zoneRadius` walks the rubble outward along the
   * cracks it belongs to rather than leaving it stranded.
   */
  _poseLips(fade) {
    const c = settings.tectonic;
    const g = settings.global;
    // The blocks drop back into the lip as the ability lets go, on the same
    // fade the cracks close on.
    const sink = Easing.inCubic(saturate(1 - fade));
    let used = 0;

    for (let i = 0; i < this._lipCount; i++) {
      const record = this.lipRecords[i];
      const arm = record.arm;
      // Rubble belonging to an arm the slider has culled is not drawn.
      const live = arm < clamp(Math.round(c.arms), 1, MAX_FISSURE_ARMS);
      const behind = this.slamAge * this._speedOf(SPEED_ORDER[arm]) - record.reach * this.radius;
      const emerge = live ? saturate(behind / Math.max(0.05, c.rubbleEmerge)) : 0;

      if (emerge <= 0.001) {
        _dummy.position.set(0, -999, 0);
        _dummy.quaternion.identity();
        _dummy.scale.setScalar(0.0001);
      } else {
        const size = c.rubbleSize * lerp(0.55, 1.35, record.size) * (1 + record.flat * 0.2 * g.randomness);
        this._armFrame(arm, record.reach, _pos, _tangent);
        const out = c.fissureWidth * 0.55 + record.offset * c.rubbleSpread + size * 0.15;
        // The lateral of the crack is the tangent turned a quarter turn in the
        // floor plane — the same rotation the vertex shader does.
        _dummy.position.set(
          _pos.x - _tangent.z * out * record.side,
          // Sunk well in, so only the top ridge breaks the surface: crust that
          // was levered up, not pebbles resting on a floor.
          -size * lerp(0.3, 0.6, record.flat) - sink * (size * 2 + 0.4),
          _pos.z + _tangent.x * out * record.side
        );
        _dummy.rotation.set(0, record.yaw * TAU, 0);
        const grow = Easing.outBack(Math.min(1, emerge));
        _dummy.scale.set(size * grow, size * lerp(0.45, 0.85, record.flat) * grow, size * 0.8 * grow);
      }

      _dummy.updateMatrix();
      this.lips.setMatrixAt(i, _dummy.matrix);
      used = i + 1;
    }

    this._lipsDrawn = used;
    this.lips.count = used;
    this.lips.instanceMatrix.needsUpdate = true;
    this.lipMaterial.color.copy(getColor(c.colorRubble));
  }

  /**
   * The pressure ring.
   *
   * The whole derivation lives in these five lines: `t` is the slam clock over
   * the fastest arm's arrival time, and the end radius is the footprint. The
   * shell lands on `radiusEnd` at `t = 1` and the crack lands on the boundary
   * at the same instant, whatever anyone does to the sliders in between.
   */
  _syncRing(fade) {
    const c = settings.tectonic;
    const arrival = Math.max(0.02, this._fastArrival());
    const t = saturate(this.slamAge / arrival);
    // Not a slider: see the class comment. Assigned onto the proxy so `Shell`
    // reads a derived metre without anything being written back into settings.
    this._ringConfig[this.ring.keys.radiusEnd] = this.radius * c.ringReach;

    const state = this._ringState;
    state.origin.copy(this._state.centre);
    state.side.copy(this.side);
    state.t = t;
    // The ring dies the moment it lands on the rim; holding it there turns a
    // front into a fence.
    state.fade = fade * (1 - saturate((this.slamAge - arrival) / Math.max(0.05, c.ringFade)));
    state.seed = this._seed;

    this.ring.sync(this._ringConfig, state);
    this.ring.visible = this._slamTime >= 0 && state.fade > 0.004;
  }

  /** The stamp at the caster's feet as the shock front leaves. */
  _muzzleFx() {
    const c = settings.tectonic;
    const g = settings.global;

    _pos.copy(this.origin).addScaledVector(this.direction, c.handForward);
    _pos.y = 0.1;

    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.muzzleSize * 0.25,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.5,
      intensity: c.muzzleIntensity,
      opacity: 0.7,
      fresnel: 1.2,
      displace: 0.6,
      squash: 0.45,
      colorA: getColor(c.colorDustB),
      colorB: getColor(c.colorDustA),
      colorC: getColor(c.colorRubble)
    });

    _emit.position = _pos;
    _emit.radius = 0.3;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.5).setY(0.7).normalize();
    _emit.speed = c.gritSpeed * 0.7;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.7;
    _emit.life = c.gritLifetime * 0.7;
    _emit.lifeVariance = 0.5;
    _emit.spin = 8;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.grit.emit(Math.round(14 * g.particleCount), _emit);

    this.lightBoost = c.lightIntensity * 0.35 * g.explosionIntensity;
  }

  /** Dust kicked up under the shock front while it runs out to the circle. */
  _frontFx(dt) {
    const c = settings.tectonic;
    const g = settings.global;
    const count = Math.round(this.dustEmitter.tick(dt, c.dustRate * 0.25) * g.particleCount);
    if (count <= 0) return;

    _emit.position = _pos.copy(this.position).setY(0.1);
    _emit.radius = 0.45;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dustSpeed * 0.6;
    _emit.speedVariance = 0.7;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.6;
    _emit.sizeVariance = 0.5;
    _emit.life = c.dustLifetime * 0.7;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.4;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.dust.emit(count, _emit);
  }

  /**
   * The wave that rides behind each tip.
   *
   * This is the half of the trick the shader cannot do. Each arm's tip is asked
   * for by `_armFrame` at `tipReach − dustLag/zoneRadius` — a wave that sits a
   * fixed number of *metres* behind the tearing edge, so it does not slide
   * forward when the footprint grows — and the dust is thrown sideways off the
   * crack rather than up out of it, because what is being displaced is a lip,
   * not a chimney.
   *
   * @param {number} scale 0..1, thinned once the arms have all landed
   */
  _tipFx(dt, scale) {
    const c = settings.tectonic;
    const g = settings.global;
    const time = frame.uTime.value;
    const arms = clamp(Math.round(c.arms), 1, MAX_FISSURE_ARMS);
    const radius = this.radius;
    const lag = c.dustLag / radius;

    const dustTotal = Math.round(this.dustEmitter.tick(dt, c.dustRate * scale) * g.particleCount);
    const gritTotal = Math.round(this.gritEmitter.tick(dt, c.gritRate * scale) * g.particleCount);
    const emberTotal = Math.round(this.emberEmitter.tick(dt, c.emberRate * scale) * g.particleCount);

    for (let arm = 0; arm < arms; arm++) {
      const tip = this._tipReach(arm);
      // A tip that has already reached the boundary stops throwing anything —
      // which is exactly what makes the fast arms go quiet while the slow ones
      // are still tearing, and is most of why the speeds read as different.
      const running = tip < 1 ? 1 : 0;
      const behind = Math.max(START_REACH, tip - lag);

      const dust = Math.floor(dustTotal / arms) * running;
      if (dust > 0) {
        this._armFrame(arm, behind, _tip, _tangent);
        _tip.y = c.dustHeight;
        _emit.position = _tip;
        _emit.radius = c.fissureWidth * 1.6 + 0.1;
        // Off the lip, both ways, with a little lift: a bow wave, not a plume.
        _emit.direction = _dir
          .set(-_tangent.z * (arm % 2 === 0 ? 1 : -1), c.dustLift, _tangent.x * (arm % 2 === 0 ? 1 : -1))
          .normalize();
        _emit.speed = c.dustSpeed;
        _emit.speedVariance = 0.75;
        _emit.spread = 0.85;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.7;
        _emit.sizeVariance = 0.5;
        _emit.life = c.dustLifetime;
        _emit.lifeVariance = 0.4;
        _emit.spin = 0.5;
        _emit.tint = null;
        _emit.time = time;
        this.dust.emit(dust, _emit);
      }

      const grit = Math.floor(gritTotal / arms) * running;
      if (grit > 0) {
        this._armFrame(arm, tip, _tip, _tangent);
        _tip.y = 0.05;
        _emit.position = _tip;
        _emit.radius = c.fissureWidth * 0.8;
        _emit.direction = _dir.set(_tangent.x * 0.35, 1, _tangent.z * 0.35).normalize();
        _emit.speed = c.gritSpeed;
        _emit.speedVariance = 0.8;
        _emit.spread = 0.7;
        _emit.size = 0.1;
        _emit.sizeVariance = 0.75;
        _emit.life = c.gritLifetime;
        _emit.lifeVariance = 0.5;
        _emit.spin = 9;
        _emit.time = time;
        this.grit.emit(grit, _emit);
      }

      const ember = Math.floor(emberTotal / arms);
      if (ember > 0) {
        // Embers come off the *open* crack behind the tip, not the tip itself.
        this._armFrame(arm, Math.max(START_REACH, tip * (0.15 + 0.7 * Math.random())), _tip, null);
        _tip.y = 0.08;
        _emit.position = _tip;
        _emit.radius = c.fissureWidth * 0.7;
        _emit.direction = _dir.set(0, 1, 0);
        _emit.speed = c.emberSpeed;
        _emit.speedVariance = 0.8;
        _emit.spread = 0.9;
        _emit.size = 0.07;
        _emit.sizeVariance = 0.6;
        _emit.life = c.emberLifetime;
        _emit.lifeVariance = 0.5;
        _emit.spin = 0;
        _emit.time = time;
        this.embers.emit(ember, _emit);
      }
    }

    /* --- ground dust rings dropped behind the tips --- */
    const marks = this.markEmitter.tick(dt, c.markRate * scale);
    for (let i = 0; i < marks; i++) {
      this._markArm = (this._markArm + 1) % arms;
      const tip = this._tipReach(this._markArm);
      if (tip >= 1) continue;
      this._armFrame(this._markArm, Math.max(START_REACH, tip - lag * 0.5), _tip, null);
      this.ctx.decals.spawn(DecalType.DUSTRING, _tip, {
        radius: c.markRadius * randRange(0.7, 1.3),
        life: c.markLife,
        intensity: c.markIntensity,
        colorA: getColor(c.colorDustB),
        colorB: getColor(c.colorDustA),
        height: 0.012
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1);
    this.position.y = 0.3;
    this._frontFx(dt);
    this.ctx.shake.rumble(settings.tectonic.travelRumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.tectonic;
    const g = settings.global;
    const time = frame.uTime.value;

    // The one timestamp the propagation runs off.
    this._slamTime = this.age;
    this._centreFx(c, g, time);
  }

  /** The slam itself: one punch, and everything the impact throws. */
  _centreFx(c, g, time) {
    this.pointAt(1, _centre).setY(0);

    /* the ball of dust the slam punches out of the floor */
    _pos.copy(_centre).setY(0.3);
    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.slamSize * 0.3,
      endRadius: c.slamSize * g.explosionIntensity,
      life: 0.85,
      intensity: c.slamIntensity,
      opacity: 0.85,
      fresnel: 1.1,
      displace: 0.7,
      squash: 0.45,
      colorA: getColor(c.colorDustB),
      colorB: getColor(c.colorDustA),
      colorC: getColor(c.colorEmber)
    });

    /* the star of cracks under the point of impact, where the arms leave */
    this.ctx.decals.spawn(DecalType.CRACK, _centre, {
      radius: this.radius * c.starRadius,
      life: c.starLife,
      width: c.starWidth,
      intensity: c.starIntensity,
      colorA: getColor(c.colorSeam),
      colorB: getColor(c.colorEmber),
      height: 0.014
    });

    /* the dust it sits in */
    this.ctx.decals.spawn(DecalType.DUSTRING, _centre, {
      radius: this.radius * c.slamDust,
      life: c.markLife * 1.6,
      intensity: c.markIntensity,
      colorA: getColor(c.colorDustA),
      colorB: getColor(c.colorDustB),
      height: 0.01
    });

    /* chips and dust thrown straight up out of the middle */
    _emit.position = _pos;
    _emit.radius = this.radius * 0.18;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.gritSpeed * 1.6;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.85;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.14;
    _emit.sizeVariance = 0.8;
    _emit.life = c.gritLifetime * 1.3;
    _emit.lifeVariance = 0.5;
    _emit.spin = 11;
    _emit.tint = null;
    _emit.time = time;
    this.grit.emit(Math.round(c.slamGrit * g.particleCount), _emit);

    _emit.radius = this.radius * 0.3;
    _emit.speed = c.dustSpeed * 1.8;
    _emit.spread = 1.0;
    _emit.size = 1.2;
    _emit.life = c.dustLifetime * 1.2;
    _emit.spin = 0.6;
    this.dust.emit(Math.round(c.slamDustCount * g.particleCount), _emit);

    // A punch, and only a punch. The rest of the shake climbs with the cracks —
    // see `onFade`.
    this.ctx.shake.add(
      c.slamShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.slamShakeTime),
      19
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.slamFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.2 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.tectonic;
    // `t` runs 0..1 while the ground is open, then 1..2 while it settles.
    const fade = t <= 1 ? 1 : 1 - Easing.inQuad(saturate(t - 1));

    this._sync(fade);

    // The light sits in the middle of the footprint, just off the floor, where
    // the ember is brightest.
    this.pointAt(1, this.position).setY(c.lightHeight);

    this._tipFx(dt, fade * (t <= 1 ? 1 : 0.3));

    /*
     * The ramp. Amplitude climbs with the propagation and peaks as the last
     * tip reaches the boundary, then decays on the ember clock. `rumble()`
     * takes an amplitude and a dt, so this is a continuous read of "how much
     * ground is currently coming apart" rather than a scheduled sequence.
     */
    const propagation = this.propagation;
    const ramp =
      propagation < 1
        ? Math.pow(propagation, Math.max(0.05, c.shakeRamp))
        : Math.exp(-(this.slamAge - this._slowArrival()) / Math.max(0.05, c.shakeDecay));
    this.ctx.shake.rumble(c.slamRumble * ramp * fade * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._slamTime = -1;
    this._lipsDrawn = 0;
    this.lips.count = 0;
    this.ring.visible = false;
    for (const mesh of this.fissureMeshes) mesh.visible = false;
    for (const material of this.fissureMaterials) material.uniforms.uFade.value = 0;
  }

  dispose() {
    this.geometry.dispose();
    for (const material of this.fissureMaterials) material.dispose();
    this.lipGeometry.dispose();
    this.lipMaterial.dispose();
    this.lips.dispose();
    this.ring.dispose();
    super.dispose();
  }
}
