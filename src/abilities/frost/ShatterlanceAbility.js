import {
  BufferGeometry,
  Float32BufferAttribute,
  InstancedBufferGeometry,
  InstancedBufferAttribute,
  Mesh,
  Vector3
} from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { createLanceMaterial, createIntakeMaterial } from '../../materials/GlacialLanceMaterial.js';
import { createCrystalGeometry } from '../../assets/ProceduralGeometry.js';
import { GrowthField, GrowthLayout, GrowthEmerge } from '../../vfx/GrowthField.js';
import { ShatterField, ShatterLayout } from '../../vfx/ShatterField.js';
import { GroundField, GroundMode } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, hash11, randRange, Easing } from '../../utils/math.js';

const TAU = Math.PI * 2;

/** Hard ceiling on shards in the intake. The editor's `intakeCount` clamps here. */
const MAX_INTAKE = 256;
/** Hard ceiling on fragments the lance breaks into. */
const MAX_FRAGMENTS = 256;
/** Distinct fragment silhouettes — two, as `ShatterField` recommends. */
const FRAGMENT_VARIANTS = 2;
/**
 * How many points along the lance one break is split between.
 * `ShatterField#burst` takes one `along` for a whole batch, so a single call
 * drops two hundred fragments on one spot — which is a firework, not a lance
 * that came apart along its own length.
 */
const BREAK_BATCHES = 12;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _hub = new Vector3();
const _target = new Vector3();

/* ---------------------------------------------------------------------- */
/* Geometry                                                                */
/* ---------------------------------------------------------------------- */

/**
 * The lance, in `GrowthField`'s unit space: tail apex at `y = 0`, point at
 * `y = 1`, footprint inside a circle of radius 0.5.
 *
 * A fluted double-ended spindle. The flutes are cut by giving every ring
 * `2 × facets` vertices and pulling the odd ones in by `flute`, which is the
 * one detail worth spelling out: the obvious way to groove a prism is to
 * modulate alternate *facets*, and that only works for an even facet count —
 * at seven facets the modulation wraps and two neighbouring faces come out the
 * same depth, which reads as a dent rather than as fluting. Interleaving a
 * pulled-in vertex between each pair alternates correctly at any count, and
 * doubles the silhouette resolution for free.
 *
 * `fluteTwist` rotates those grooves as they climb, and the lance material's
 * seam term follows the same helix, so the glow sits in the valleys rather
 * than crawling across the ridges.
 */
function createLanceGeometry(variant, shape) {
  const seed = 9.7 + variant * 31.3;
  const facets = clamp(Math.round(shape?.facets ?? 7), 4, 20);
  const swell = clamp(shape?.swell ?? 0.26, 0.05, 0.9);
  const tailWidth = clamp(shape?.tailWidth ?? 0.22, 0.02, 1);
  const tipCurve = Math.max(0.2, shape?.tipCurve ?? 1.35);
  const flute = clamp(shape?.flute ?? 0.28, 0, 0.8);
  const fluteTwist = shape?.fluteTwist ?? 0.5;
  const jitter = clamp(shape?.bodyJitter ?? 0.12, 0, 0.8);

  const sides = facets * 2;
  // Rings bunched where the silhouette turns: just off the tail, at the swell,
  // and again as it runs out into the point.
  const heights = [
    0.03,
    swell * 0.45,
    swell,
    lerp(swell, 1, 0.35),
    lerp(swell, 1, 0.68),
    lerp(swell, 1, 0.88)
  ];

  /** Radius of the body at `t`, as a fraction of the unit footprint. */
  const profile = (t) => {
    const r =
      t <= swell
        ? tailWidth + (1 - tailWidth) * Math.pow(t / Math.max(swell, 1e-3), 0.65)
        : Math.pow(1 - (t - swell) / Math.max(1 - swell, 1e-3), tipCurve);
    return r * 0.5;
  };

  const rings = heights.map((t, ringIndex) => {
    const base = profile(t);
    const spin = fluteTwist * t * (TAU / facets);
    const ring = [];
    for (let j = 0; j < sides; j++) {
      const angle = (j / sides) * TAU + spin;
      const groove = j % 2 === 0 ? 1 : 1 - flute;
      const wobble = 1 + (hash11(seed * 7.3 + ringIndex * 13.1 + j * 3.7) - 0.5) * jitter * 0.6;
      const radius = Math.max(0.002, base * groove * wobble);
      ring.push([Math.cos(angle) * radius, t, Math.sin(angle) * radius]);
    }
    return ring;
  });

  const tail = [0, 0, 0];
  const tip = [
    (hash11(seed * 17.3) - 0.5) * 0.04 * jitter,
    1,
    (hash11(seed * 19.9) - 0.5) * 0.04 * jitter
  ];

  const positions = [];
  const tri = (p, q, r) => {
    positions.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
  };

  for (let j = 0; j < sides; j++) {
    const k = (j + 1) % sides;
    tri(tail, rings[0][j], rings[0][k]);
    for (let r = 0; r < rings.length - 1; r++) {
      tri(rings[r][j], rings[r + 1][j], rings[r][k]);
      tri(rings[r][k], rings[r + 1][j], rings[r + 1][k]);
    }
    tri(rings[rings.length - 1][j], tip, rings[rings.length - 1][k]);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * One fragment of the broken lance, centred on its own origin because the
 * tumble rotates about that point.
 *
 * The reference crystal, re-centred and squashed: using the *same* generator
 * the ice field uses is the point, because the fragments have to look like
 * pieces of the thing that broke rather than like generic debris.
 */
function createLanceFragmentGeometry(variant) {
  const geometry = createCrystalGeometry({
    seed: 11.3 + variant * 23.9,
    sides: 5,
    taper: 0.1,
    roughness: 0.55,
    bend: 0.3
  });
  geometry.translate(0, -0.5, 0);
  geometry.scale(0.8, 1.0, 0.8);
  return geometry;
}

/**
 * The intake: one instanced shard, `MAX_INTAKE` copies, and a single seed per
 * copy. Everything else about the flight is in the vertex shader.
 *
 * A plain `Mesh` over an `InstancedBufferGeometry` rather than an
 * `InstancedMesh`, deliberately: an `InstancedMesh` would multiply every vertex
 * by an instance matrix this ability does not want to maintain on the CPU, and
 * the whole point of the intake is that there is no CPU state per shard at all.
 * The bolt's ribbon strip is built the same way for the same reason.
 */
function createIntakeGeometry() {
  const shard = createCrystalGeometry({
    seed: 4.2,
    sides: 5,
    taper: 0.16,
    roughness: 0.5,
    bend: 0.25
  });
  shard.translate(0, -0.5, 0);

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', shard.getAttribute('position'));
  geometry.setAttribute('normal', shard.getAttribute('normal'));

  const seeds = new Float32Array(MAX_INTAKE);
  // Golden-ratio spacing: the hash in the vertex shader decorrelates them, and
  // a stratified input keeps the shell evenly covered at any live count.
  for (let i = 0; i < MAX_INTAKE; i++) seeds[i] = 0.13 + i * 0.6180339887;
  geometry.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1));
  geometry.instanceCount = 0;
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* The ability                                                             */
/* ---------------------------------------------------------------------- */

/**
 * SHATTERLANCE — one enormous ice lance, assembled, thrown, and broken.
 *
 * **The trick: the wind-up is the ability.** Every other line cast in the
 * sandbox leaves the caster on the frame you click. This one refuses to: for
 * `assembly` seconds a hundred and twenty shards converge out of a shell in the
 * air and merge into a single lance, which hangs there — bobbing, its flute
 * seams filling with light from the tail forward — long enough for you to read
 * it as **one object**. Then it goes, at sixty metres a second, and the impact
 * breaks that one object into two hundred fragments that inherit its flight
 * velocity, tumble and shrink. The contrast between the single silhouette and
 * the two hundred is the whole slot; everything else is in service of it.
 *
 * Four beats out of the base class's three, and it costs nothing: `advance()`
 * simply refuses to move the front until the lance is whole, exactly as
 * `BeamAbility` buys its charge. The phase machine still runs travel → impact →
 * fade and never has to know.
 *
 * ## The convergence is parametric, not simulated
 *
 * A shard's position is `mix(point on the shell, point on the lance, ease(t))`
 * where `t` is the assembly clock less that shard's own stagger, evaluated in
 * the vertex shader from eight uniforms and one seed. There is no per-shard
 * state on the CPU, so pausing mid-wind-up and dragging `intakeSphere` re-flies
 * all hundred and twenty from a wider shell — which a simulation physically
 * could not do, because it has already spent the old radius. The lance itself
 * is a `GrowthField` of exactly **one** instance, whose length and girth are
 * driven off the same clock on two different curves so it extends before it
 * thickens.
 *
 * A first version fed the intake with `Swarm`, which is the module that looks
 * like it should own this: agents cohering to a lead with `gather` running to
 * zero really does collapse a formation onto a point. It was wrong for two
 * reasons — the formation is a lattice box rather than a shell, so the shards
 * arrived in ranks, and the silhouettes on offer are birds, leaves, cards,
 * droplets and motes, none of which is a piece of ice. The shards had to be
 * real chips of the same crystal the lance is made of or the merge reads as a
 * lance switching on inside a cloud of sparks.
 *
 * ## The break
 *
 * `ShatterField` in LINE layout, burst in twelve batches walking the lance's
 * own span so the fragments come off its whole length at once, with `inherit`
 * set to the flight velocity times `fragInherit`. That last number is the one
 * that decides whether the impact reads as shrapnel or as confetti, and it is
 * re-resolved every frame — drag it during the fade and the debris re-flies.
 *
 * ## The rule that makes the editor work
 *
 * A cast captures one seed and three timestamps. Five draw calls: the lance,
 * the intake, two fragment meshes and the frost sheet.
 */
export class ShatterlanceAbility extends Ability {
  constructor(context) {
    super('shatterlance', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const environment = this.ctx.environment;

    this.lanceMaterial = createLanceMaterial(environment);
    this.lanceUniforms = this.lanceMaterial.userData.uniforms;
    this.intakeMaterial = createIntakeMaterial();
    this.intakeUniforms = this.intakeMaterial.userData.uniforms;

    /** Live shape controls for the lance body. Mutated in place — I3. */
    this._shape = {
      facets: 7,
      swell: 0.26,
      tailWidth: 0.22,
      tipCurve: 1.35,
      flute: 0.28,
      fluteTwist: 0.5,
      bodyJitter: 0.12
    };
    this._fillShape();

    // One instance. `variants: 1` is what `GrowthField` asks for when the thing
    // genuinely does not repeat, and it is the difference between one draw call
    // and three for a field of exactly one object.
    this.lance = new GrowthField(this.group, {
      geometry: createLanceGeometry,
      material: this.lanceMaterial,
      shape: this._shape,
      variants: 1,
      capacity: 1,
      layer: LAYER.WORLD,
      renderOrder: 2,
      castShadow: true,
      receiveShadow: true
    });

    this.intakeGeometry = createIntakeGeometry();
    this.intake = new Mesh(this.intakeGeometry, this.intakeMaterial);
    this.intake.frustumCulled = false;
    this.intake.matrixAutoUpdate = false;
    this.intake.layers.set(LAYER.VFX);
    this.intake.renderOrder = 7;
    this.group.add(this.intake);

    this.frags = new ShatterField(this.group, {
      geometry: createLanceFragmentGeometry,
      variants: FRAGMENT_VARIANTS,
      capacity: MAX_FRAGMENTS,
      renderOrder: 6
    });

    this.sheet = new GroundField(this.group, {
      mode: GroundMode.PLATE,
      additive: false,
      name: 'Shatterlance:sheet'
    });

    /* --- scratch parameter blocks, filled from settings every frame --- */
    this._growth = {
      layout: GrowthLayout.LINE,
      emerge: GrowthEmerge.SCALE,
      origin: new Vector3(),
      direction: new Vector3(0, 0, 1),
      side: new Vector3(1, 0, 0),
      length: 0,
      // One object: no jitter of any kind, or it stops being one object.
      clusterRadius: 0,
      heightJitter: 0,
      radiusJitter: 0,
      leanJitter: 0,
      leanRamp: 1,
      leanForward: 1,
      leanOutward: 0,
      tilt: 0,
      crown: 0,
      peak: 1,
      rubble: 0,
      riseTime: 0.02,
      riseOvershoot: 0,
      birthScale: 1
    };

    this._shatter = {
      layout: ShatterLayout.LINE,
      origin: new Vector3(),
      direction: new Vector3(0, 0, 1),
      side: new Vector3(1, 0, 0),
      length: 1,
      inherit: new Vector3(),
      inheritScale: 1
    };
    this._ground = { centre: new Vector3() };
    this._look = {};

    /** Re-rolled per cast so two lances do not assemble in the same order. */
    this._seed = 0;
    /** Timestamp the frost sheet started spreading, or -1. */
    this._sheetTime = -1;
    /** One-shot latch on the break. */
    this._broken = false;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The intake motes. This is the only system in the project using the
    // engine's `swirl` mode with a *negative* expansion: `uSwirlExpand` scales
    // the particle's offset from its anchor by `1 + expand * t`, so at -0.92 the
    // offset collapses to eight per cent of itself over the mote's life and the
    // whole shell spirals in. Emitting them at radius `moteShell` about the
    // lance's own centre then costs nothing on the CPU.
    this.motes = particles.get('shatterlance.motes', {
      capacity: 2400,
      shape: ParticleShape.SOFT,
      additive: true,
      swirl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 2.2;
    this.motes.uniforms.uEndSize.value = 0.1;
    this.motes.uniforms.uSizeIn.value = 0.05;
    this.motes.uniforms.uFadeIn.value = 0.1;
    this.motes.uniforms.uFadeOut.value = 0.3;

    // Chips off the break.
    this.chips = particles.get('shatterlance.chips', {
      capacity: 2000,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.chips.uniforms.uDrag.value = 0.28;
    this.chips.uniforms.uEndSize.value = 0.75;
    this.chips.uniforms.uFadeOut.value = 0.72;

    // Vapour rolling off the frost sheet. Non-additive so it occludes.
    this.mist = particles.get('shatterlance.mist', {
      capacity: 2000,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.mist.uniforms.uDrag.value = 2.0;
    this.mist.uniforms.uEndSize.value = 3.0;
    this.mist.uniforms.uSizeIn.value = 0.12;
    this.mist.uniforms.uFadeIn.value = 0.16;
    this.mist.uniforms.uFadeOut.value = 0.3;

    this.moteEmitter = new RateEmitter();
    this.mistEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.lance.count + this.frags.count + this.intakeGeometry.instanceCount;
  }

  get impactDuration() {
    return Math.max(0.05, settings.shatterlance.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.shatterlance.fadeTime);
  }

  /** It breathes as it charges and steadies once it is thrown. */
  lightShimmer() {
    const c = settings.shatterlance;
    const charging = 1 - saturate(this.assembly);
    return 1 - c.lightPulse * charging * (0.5 - 0.5 * Math.cos(this.age * c.lightPulseSpeed * TAU));
  }

  /** How far the lance has assembled, 0..1. Past 1 it is whole. */
  get assembly() {
    return saturate(this.age / Math.max(0.01, settings.shatterlance.assembly));
  }

  /**
   * Hold the front at the caster until the lance is whole.
   *
   * The entire fourth beat, and it needs nothing from the base class. The ease
   * off the standstill is keyed off the moment of *release* rather than the
   * moment of the cast, exactly as `BeamAbility` does — key it off the cast and
   * a long wind-up would let the lance leave at full speed on its first frame.
   */
  advance(dt) {
    const c = this.config;
    const assembly = Math.max(0, c.assembly);
    if (this.age < assembly) return false;

    const speed = c.speed * settings.global.speed;
    const since = this.age - assembly;
    this.front += speed * Easing.outQuad(saturate(since / 0.04)) * dt;

    const previousU = this.u;
    this.u = saturate(this.front / this.length);
    this.pointAt(this.u, this.position);
    return this.u >= 1 && previousU < 1;
  }

  /* ------------------------------------------------------------------ */
  /* Live geometry — every metre resolved from settings, every frame      */
  /* ------------------------------------------------------------------ */

  _fillShape() {
    const c = settings.shatterlance;
    const shape = this._shape;
    shape.facets = c.facets;
    shape.swell = c.swell;
    shape.tailWidth = c.tailWidth;
    shape.tipCurve = c.tipCurve;
    shape.flute = c.flute;
    shape.fluteTwist = c.fluteTwist;
    shape.bodyJitter = c.bodyJitter;
    return shape;
  }

  /** Metres downrange the lance's *point* has reached. */
  _tipDistance() {
    const c = settings.shatterlance;
    // It hangs `hoverForward` metres out in front while it assembles and then
    // runs to the target: interpolating on `u` rather than adding to it is what
    // makes the point land exactly on the aim marker instead of overshooting it
    // by the length of the hover.
    return lerp(c.hoverForward, this.length, this.u);
  }

  /** Metres above the floor the lance's axis sits at, bob included. */
  _lanceHeight() {
    const c = settings.shatterlance;
    return c.lanceHeight + Math.sin(this.age * c.hoverBobSpeed * TAU) * c.hoverBob * (1 - this.u);
  }

  /** World centre of the lance. The intake converges on this. */
  _lanceHub(out) {
    const c = settings.shatterlance;
    const form = this._lengthForm();
    out
      .copy(this.origin)
      .addScaledVector(this.direction, this._tipDistance() - c.lanceLength * form * 0.5);
    out.y = this._lanceHeight();
    return out;
  }

  /** 0..1 — how much of its full length the lance has, on the assembly clock. */
  _lengthForm() {
    const c = settings.shatterlance;
    return lerp(c.formSeed, 1, Math.pow(this.assembly, Math.max(0.05, c.formLengthCurve)));
  }

  /** 0..1 — and how much of its girth, on a different curve. */
  _radiusForm() {
    const c = settings.shatterlance;
    return lerp(c.formSeed, 1, Math.pow(this.assembly, Math.max(0.05, c.formRadiusCurve)));
  }

  /** Placement and size of the one instance. */
  _fillGrowth() {
    const c = settings.shatterlance;
    const g = settings.global;
    const p = this._growth;
    const form = this._lengthForm();

    p.origin.copy(this.origin);
    p.direction.copy(this.direction);
    p.side.copy(this.side);
    // The cluster record sits at `origin + direction * length`, and the unit
    // geometry runs tail-at-0 to point-at-1, so the anchor is the *tail*.
    p.length = this._tipDistance() - c.lanceLength * form;

    p.heightNear = c.lanceLength * form;
    p.height = c.lanceLength * form;
    p.radiusNear = c.lanceRadius * this._radiusForm();
    p.radius2 = c.lanceRadius * this._radiusForm();
    p.baseHeight = this._lanceHeight();

    p.lean = c.lanceLean;
    p.twist = c.lanceRoll;
    p.birthFade = Math.max(0.05, c.assembly * 0.12);
    p.randomness = g.randomness;
    return p;
  }

  /** The frost sheet thrown flat across the stone by the break. */
  _fillGround(grow, recede, fade) {
    const c = settings.shatterlance;
    const g = settings.global;
    const p = this._ground;

    this.pointAt(1, p.centre);
    p.yaw = Math.atan2(this.direction.x, this.direction.z);
    p.height = c.sheetHeight;
    p.radius = c.sheetRadius;
    p.seed = this._seed;

    p.grow = grow;
    p.recede = recede;
    p.fade = fade;

    p.edge = c.sheetEdge;
    p.ragged = c.sheetRagged;
    p.raggedScale = c.sheetRaggedScale;
    p.warp = c.sheetWarp;

    p.relief = c.sheetRelief;
    p.normalStep = c.sheetNormalStep;
    p.ambient = c.sheetAmbient;
    p.wrap = c.sheetWrap;
    p.specular = c.sheetSpecular;
    p.gloss = c.sheetGloss;
    p.parallax = c.sheetParallax;

    p.cell = c.sheetCell;
    p.cellJitter = c.sheetCellJitter;
    p.seam = c.sheetSeam;
    p.thickness = c.sheetThickness;
    p.lift = c.sheetLift;
    p.detail = c.sheetDetail;
    // The plates lift downrange, which in the quad's own yawed frame is 0 — the
    // direction is the cast's, not a number anybody should be authoring.
    p.windAngle = 0;

    p.additive = false;
    p.emissive = c.sheetEmissive;
    p.opacity = c.sheetOpacity;
    p.depthFade = c.sheetDepthFade;
    p.colorBase = c.colorSheetBase;
    p.colorEdge = c.colorSheetEdge;
    p.colorGlow = c.colorSheetGlow;
    p.colorDeep = c.colorSheetDeep;

    p.noiseStrength = g.noiseStrength;
    p.noiseFrequency = g.noiseFrequency;
    p.noiseSpeed = g.noiseSpeed;
    p.opacityScale = g.opacity;
    return p;
  }

  /** The flight of one fragment. */
  _fillShatter() {
    const c = settings.shatterlance;
    const g = settings.global;
    const p = this._shatter;

    p.origin.copy(this.origin);
    p.direction.copy(this.direction);
    p.side.copy(this.side);
    p.length = this.length;
    p.width = c.lanceRadius * 2;

    // Debris has to have come from somewhere: the fragments leave with a share
    // of the lance's own velocity, so the cloud keeps travelling downrange
    // instead of blooming on the spot.
    p.inherit.copy(this.direction).multiplyScalar(c.speed * g.speed * c.fragInherit);

    p.spawnRadius = c.fragSpawnRadius;
    p.spawnHeight = c.fragSpawnHeight;
    p.speed = c.fragSpeed;
    p.speedJitter = c.fragSpeedJitter;
    p.spread = c.fragSpread;
    p.upBias = c.fragUpBias;
    p.gravity = c.fragGravity;
    p.drag = c.fragDrag;
    p.size = c.fragSize;
    p.sizeJitter = c.fragSizeJitter;
    p.shrink = c.fragShrink;
    p.shrinkPower = c.fragShrinkPower;
    p.spin = c.fragSpin;
    p.spinJitter = c.fragSpinJitter;
    p.lifetime = c.fragLifetime;
    p.floor = c.fragFloor;
    p.floorSpin = c.fragFloorSpin;
    p.randomness = g.randomness;
    return p;
  }

  /** Colours and shading of the fragments. Three pickers, none derived (I5). */
  _fillLook() {
    const c = settings.shatterlance;
    const g = settings.global;
    const look = this._look;
    look.colorA = getColor(c.colorFragA);
    look.colorB = getColor(c.colorFragB);
    look.colorEdge = getColor(c.colorFragEdge);
    look.opacity = c.fragOpacity * g.opacity;
    look.glow = c.fragGlow * g.glow;
    look.rim = c.fragRim;
    look.rimPower = c.fragRimPower;
    look.shade = c.fragShade;
    look.ambient = c.fragAmbient;
    look.fadeStart = c.fragFadeStart;
    look.soft = c.fragSoft;
    return look;
  }

  /** 0..1 — how far the frost sheet has spread. */
  _sheetGrowth() {
    if (this._sheetTime < 0) return 0;
    return saturate((this.age - this._sheetTime) / Math.max(0.02, settings.shatterlance.sheetGrow));
  }

  /** 0..1 — how far it has been eaten back from its rim. */
  _sheetRecede() {
    const c = settings.shatterlance;
    if (this.phase !== AbilityPhase.FADE) return 0;
    const k = saturate(this.fadeTime / Math.max(0.05, c.fadeTime));
    const hold = Math.min(0.98, c.sheetHold);
    return saturate((k - hold) / (1 - hold));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this.mistEmitter.reset();
    this._sheetTime = -1;
    this._broken = false;
    this._seed = Math.random() * 100;

    this.frags.clear();
    this.lance.clear();
    // A cluster of one: `plant(1, 1)` puts the single record in the terminal
    // group, whose position is the anchor exactly, rather than at a random
    // fraction down the line — which is where `plant(1, 0)` would leave it.
    this.lance.plant(1, 1);
    this.lance.triggerIndex(0, 0, 0);

    this._syncUniforms();
    this._syncFields();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  _syncUniforms() {
    const c = settings.shatterlance;
    const g = settings.global;

    this.lanceMaterial.userData.sync();
    this.lanceUniforms.uCharge.value = this.assembly;

    this.intakeMaterial.userData.sync();
    const u = this.intakeUniforms;
    this._lanceHub(_hub);
    u.uHub.value.copy(_hub);
    u.uAxis.value.copy(this.direction);
    u.uSide.value.copy(this.side);
    // The third leg of the frame. Recomputed rather than assumed to be +Y so a
    // pitched lance still has its shards land on the body and not beside it.
    u.uUp.value.crossVectors(this.direction, this.side).normalize();
    u.uAssembly.value = this.assembly;
    u.uLanceHalf.value = c.lanceLength * this._lengthForm() * 0.5;
    u.uLanceRadius.value = c.lanceRadius * this._radiusForm();
    u.uSeed.value = this._seed;
    // Gone by the time it fires; the lance is what is left.
    u.uFade.value = 1 - saturate((this.assembly - 0.92) / 0.08);
    this.intakeGeometry.instanceCount = Math.min(MAX_INTAKE, Math.max(0, Math.round(c.intakeCount)));

    this.frags.sync(this._fillLook());

    /* --- the three particle systems --- */
    this.motes.setGradient(
      getColor(c.colorMoteA),
      getColor(c.colorMoteB),
      getColor(c.colorMoteC),
      getColor(c.colorMoteD)
    );
    this.motes.uniforms.uGravity.value.set(0, c.moteRise, 0);
    this.motes.uniforms.uSizeScale.value = c.moteSize * g.particleSize * 7;
    this.motes.uniforms.uLifeScale.value = c.moteLifetime * 0.5 * g.particleLifetime;
    this.motes.uniforms.uSpeedScale.value = g.particleSpeed;
    this.motes.uniforms.uOpacity.value = g.opacity;
    this.motes.uniforms.uGlow.value = 0.95 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;
    this.motes.uniforms.uSwirl.value = c.moteSwirl;
    // Negative: the offset from the anchor *shrinks* over the mote's life.
    this.motes.uniforms.uSwirlExpand.value = -Math.min(0.99, c.moteConverge);

    this.chips.setGradient(
      getColor(c.colorChipA),
      getColor(c.colorChipB),
      getColor(c.colorChipC),
      getColor(c.colorChipD)
    );
    this.chips.uniforms.uGravity.value.set(0, c.chipGravity, 0);
    this.chips.uniforms.uSizeScale.value = c.chipSize * g.particleSize * 7;
    this.chips.uniforms.uLifeScale.value = c.chipLifetime * 0.5 * g.particleLifetime;
    this.chips.uniforms.uSpeedScale.value = g.particleSpeed;
    this.chips.uniforms.uOpacity.value = g.opacity;

    this.mist.setGradient(
      getColor(c.colorMistA),
      getColor(c.colorMistB),
      getColor(c.colorMistC),
      getColor(c.colorMistD)
    );
    this.mist.uniforms.uGravity.value.set(0, c.mistRise, 0);
    this.mist.uniforms.uSizeScale.value = c.mistSize * g.particleSize;
    this.mist.uniforms.uLifeScale.value = c.mistLifetime * 0.5 * g.particleLifetime;
    this.mist.uniforms.uSpeedScale.value = c.mistSpeed * g.particleSpeed;
    this.mist.uniforms.uOpacity.value = c.mistOpacity * g.opacity;
    this.mist.uniforms.uTurbulence.value = 0.4 * g.turbulence;
  }

  /** Rebuild the lance, the fragments and the sheet against live settings. */
  _syncFields() {
    this.lance.syncGeometry(this._fillShape());
    this.lance.update(this.age, this._fillGrowth(), 0);
    this.frags.update(this.age, this._fillShatter());
    this.sheet.update(
      this._fillGround(this._sheetGrowth(), this._sheetRecede(), saturate(this._sheetGrowth() * 4))
    );
  }

  /** Frost drawn in out of the air while the lance assembles. */
  _chargeFx(dt) {
    const c = settings.shatterlance;
    const g = settings.global;

    const count = Math.round(this.moteEmitter.tick(dt, c.moteRate) * g.particleCount);
    if (count > 0) {
      this._lanceHub(_pos);
      _emit.position = _pos;
      _emit.radius = c.moteShell;
      // The anchor is what the swirl collapses onto — the lance's own centre.
      _emit.anchor = _pos;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = 0;
      _emit.speedVariance = 0;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.35;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.motes.emit(count, _emit);
    }

    this.ctx.shake.rumble(c.chargeShake * this.assembly * g.cameraShake, dt);
  }

  /** Vapour rolling off the frost sheet. */
  _sheetFx(dt, scale) {
    const c = settings.shatterlance;
    const g = settings.global;

    const count = Math.round(this.mistEmitter.tick(dt, c.mistRate * scale) * g.particleCount);
    if (count <= 0) return;

    const spread = c.sheetRadius * this._sheetGrowth();
    this.pointAt(1, _pos);
    _pos.y = 0.15;
    _emit.position = _pos;
    _emit.radius = Math.max(0.1, spread);
    _emit.anchor = null;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.mistSpeed;
    _emit.speedVariance = 0.7;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.size = 1.0;
    _emit.sizeVariance = 0.5;
    _emit.life = c.mistLifetime;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.4;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.mist.emit(count, _emit);
  }

  /**
   * The lance coming apart, along its whole length, in one frame.
   *
   * Walking `along` across the span the lance actually occupies is the
   * difference between two hundred fragments coming off a four-metre body and
   * two hundred fragments coming out of a point.
   */
  _breakFx() {
    const c = settings.shatterlance;
    const g = settings.global;
    const total = Math.min(MAX_FRAGMENTS, Math.round(c.fragmentCount * g.particleCount));
    const per = Math.max(1, Math.round(total / BREAK_BATCHES));
    const span = saturate(c.lanceLength / Math.max(0.5, this.length));

    for (let batch = 0; batch < BREAK_BATCHES; batch++) {
      const along = 1 - span * (1 - (batch + 0.5) / BREAK_BATCHES);
      this.frags.burst(this.age, per, along, randRange(-0.9, 0.9));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.shatterlance;

    this._syncUniforms();
    this._syncFields();

    if (this.age < c.assembly) {
      // Still winding up. The camera frames the lance, not the empty line.
      this._lanceHub(this.position);
      this._chargeFx(dt);
      return;
    }

    // The light rides the point, not the floor under it.
    this._lanceHub(this.position);
    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.shatterlance;
    const g = settings.global;
    const time = frame.uTime.value;

    this._broken = true;
    this._sheetTime = this.age;

    this._breakFx();
    // The lance is gone in the same frame the fragments appear. That
    // substitution is the whole point of the slot, so it happens on one frame
    // and never as a cross-fade.
    this.lance.clear();

    this.pointAt(1, _target);
    _pos.copy(_target);
    _pos.y = c.fragSpawnHeight;

    /* the shell of pulverised ice */
    this.ctx.bursts.spawn(BurstMode.FROST, _pos, {
      radius: c.burstSize * 0.2,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.8,
      intensity: c.burstIntensity,
      opacity: 0.9,
      fresnel: 1.5,
      displace: 0.6,
      squash: 0.8,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the cold ring across the floor */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _target, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.75,
      width: 0.045,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* chips and vapour */
    _emit.position = _pos;
    _emit.radius = c.lanceRadius * 2;
    _emit.anchor = null;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.55).setY(0.7).normalize();
    _emit.speed = c.chipSpeed;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.95;
    _emit.inherit = null;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.8;
    _emit.life = c.chipLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 11;
    _emit.tint = null;
    _emit.time = time;
    this.chips.emit(Math.round(c.chipCount * g.particleCount), _emit);

    _emit.speed = c.mistSpeed * 3.0;
    _emit.spread = 1.0;
    _emit.size = 1.5;
    _emit.life = c.mistLifetime * 1.2;
    _emit.spin = 0.5;
    this.mist.emit(Math.round(60 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.breakShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      26
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.breakFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.6 * g.explosionIntensity;
  }

  onFade(dt, t) {
    this._syncUniforms();
    this._syncFields();

    // The light sits where the lance broke.
    this.pointAt(1, this.position);
    this.position.y = settings.shatterlance.fragSpawnHeight * 0.6;

    this._sheetFx(dt, t <= 1 ? 1 : 1 - saturate((t - 1) * 0.8));
  }

  onDestroy() {
    this.lance.clear();
    this.frags.clear();
    this.intakeGeometry.instanceCount = 0;
    this._sheetTime = -1;
    this._broken = false;
    this.sheet.update(this._fillGround(0, 0, 0));
  }

  dispose() {
    this.lance.dispose();
    this.frags.dispose();
    this.sheet.dispose();
    this.intakeGeometry.dispose();
    this.intakeMaterial.dispose();
    this.lanceMaterial.dispose();
    super.dispose();
  }
}
