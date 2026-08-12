import { BufferGeometry, Float32BufferAttribute, Mesh, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { Tube, TubePath } from '../../vfx/Tube.js';
import { ShatterField, ShatterLayout, shatterParams } from '../../vfx/ShatterField.js';
import { createPrismSolidMaterial, createPrismFanMaterial, MAX_CHILDREN } from '../../materials/PrismMaterial.js';
import { createBoltRibbonGeometry } from '../../assets/ProceduralGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor, makeColor } from '../../utils/color.js';
import { saturate, clamp, lerp, hash11, Easing, randRange } from '../../utils/math.js';

/** Samples along one child beam. The ceiling on how fine its bow can be. */
const FAN_NODES = 56;
/** Distinct chip shapes — and therefore draw calls the ShatterField costs. */
const CHIP_VARIANTS = 2;
/** Hard ceiling on chips in the air at once. `chipCount` clamps here. */
const CHIP_CAPACITY = 192;
/** How many points along the fan one frame's sparks are split between. */
const SPARK_BATCHES = 4;

const TAU = Math.PI * 2;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _hand = new Vector3();
const _prism = new Vector3();
const _target = new Vector3();

/* ------------------------------------------------------------------ */
/* Procedural bodies                                                   */
/* ------------------------------------------------------------------ */

/**
 * A triangular bipyramid, in unit space: equator radius 1 at `y = 0`, apex at
 * `y = ±1`. Six triangular faces and not one smooth normal on it.
 *
 * Non-indexed with per-face normals, the same way the crystals are built — a
 * refracting solid whose facets have been averaged into a ball is a marble, and
 * a marble does not disperse anything you can see. The three-sided form is
 * deliberate: it is the silhouette everyone reads as *prism*, and with only six
 * faces every one of them is large enough to carry a distinct piece of the room
 * behind it.
 */
function createBipyramidGeometry() {
  const positions = [];
  const equator = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + Math.PI * 0.5;
    equator.push([Math.cos(a), 0, Math.sin(a)]);
  }

  const push = (p) => positions.push(p[0], p[1], p[2]);
  const apex = [0, 1, 0];
  const nadir = [0, -1, 0];

  for (let i = 0; i < 3; i++) {
    const a = equator[i];
    const b = equator[(i + 1) % 3];
    // Winding chosen so the face normal points away from the axis, not into it;
    // with DoubleSide it would still draw, but the fresnel rim would be inside.
    push(apex);
    push(b);
    push(a);
    push(nadir);
    push(a);
    push(b);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * One prism chip: a thin triangular plate, centred on its own origin because
 * `ShatterField` tumbles a fragment about that point and a chip that spins
 * about its corner reads as a thrown stick.
 *
 * Deterministic per variant — two shapes is enough for glass. Anything with
 * more faces than this is invisible at the size these things fly at, and the
 * only thing that reads is the *silhouette flicker* as a flat plate turns
 * edge-on.
 */
function createChipGeometry(variant) {
  const seed = variant * 13.7 + 3.1;
  const corner = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + hash11(seed + i) * 1.1;
    const r = 0.55 + hash11(seed + i * 3.3) * 0.45;
    corner.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const half = 0.07 + hash11(seed + 9.4) * 0.1;

  const positions = [];
  const v = (i, sign) => positions.push(corner[i][0], corner[i][1], sign * half);

  // Front and back faces, wound opposite ways.
  v(0, 1); v(1, 1); v(2, 1);
  v(2, -1); v(1, -1); v(0, -1);
  // The three edges, two triangles each — the thickness is what catches a rim.
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    v(i, 1); v(j, -1); v(j, 1);
    v(i, 1); v(i, -1); v(j, -1);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * PRISM LANCE — white light in, spectrum out.
 *
 * Four beats. A lance of white light winds up in the hand (`charge`), is let
 * out along the aimed line, **stops part-way** at a refracting solid hanging in
 * the air, and continues from there as a fan of coloured child beams that bow
 * apart and converge again exactly where the white lance was aimed. It holds,
 * then the solid cracks into its own fragments and the fan whitens as it dies.
 *
 * **THE TRICK — dispersion, and the fact that it is one draw call.** The six
 * children are not six tubes. They are six instances of a single ribbon strip,
 * and a child's instance index picks its bearing around the axis, its hue out
 * of eight pickers, *and* how hard it bends: `fanDispersion` ramps the lateral
 * throw from the first child to the last, so the fan opens in spectral order
 * rather than as six beams pointing six ways. Drag it to 1 and every child
 * bends the same amount, which is a tube of colour; drag it to 0 and the whole
 * fan collapses onto the axis, which is what a prism with no dispersion in it
 * should do. Either one is the shader telling the truth.
 *
 * They converge because the bow is `sin(π·tᵇ)` — zero at the prism, zero at the
 * target, with a real slope at the prism so the children *leave at an angle*
 * instead of easing away from the axis. There is no convergence logic and no
 * correction term anywhere in this file. A child cannot miss.
 *
 * The first version of the fan gave each child a constant lateral offset and
 * lerped it to zero at the target. That draws six straight lines meeting at a
 * point — a claw, not a refraction — because the *curvature* is what says the
 * light was bent once, at one place, and then travelled straight-ish. The
 * second version bowed them but shared one amplitude, and the fan read as a
 * cage. Ordering the amplitude by index was the change that made it a prism.
 *
 * The solid is real: a triangular bipyramid with per-face normals, shaded by
 * three `refract()` probes at three indices with one channel taken from each,
 * so the fringes swing round the geometry behind it when you orbit. It blazes
 * from the inside while the lance is striking it and dissolves along a
 * world-space fracture field when it lets go, at which point a `ShatterField`
 * throws ninety-odd chips that inherit nothing but the direction the lance was
 * pointing.
 *
 * **What a cast captures.** One seed and three timestamps: when the lance was
 * released, when it entered the solid, and when the solid cracked. Not one
 * metre. `prismAt` is resolved every frame, so dragging it slides the split
 * point along a cast that is already standing and the lance and the fan re-cut
 * against each other — with the clock stopped.
 */
export class PrismLanceAbility extends Ability {
  constructor(context) {
    super('prismlance', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the white lance: three draw calls, all of the shape in the GPU --- */
    this.lance = new Tube({ path: TubePath.STRAIGHT, prefix: 'lance', nodes: 72, sides: 22, renderOrder: 11 });
    this.group.add(this.lance.group);

    /* --- the solid: one draw call, and the only thing here with a matrix --- */
    this.prismGeometry = createBipyramidGeometry();
    this.prismMaterial = createPrismSolidMaterial();
    this.prismMesh = new Mesh(this.prismGeometry, this.prismMaterial);
    this.prismMesh.layers.set(LAYER.VFX);
    this.prismMesh.renderOrder = 14;
    this.prismMesh.frustumCulled = false;
    this.group.add(this.prismMesh);

    /* --- the fan: one draw call for every child --- */
    this.fanGeometry = createBoltRibbonGeometry(FAN_NODES, MAX_CHILDREN);
    this.fanMaterial = createPrismFanMaterial();
    this.fanMesh = new Mesh(this.fanGeometry, this.fanMaterial);
    this.fanMesh.frustumCulled = false;
    this.fanMesh.matrixAutoUpdate = false;
    this.fanMesh.layers.set(LAYER.VFX);
    this.fanMesh.renderOrder = 12;
    this.group.add(this.fanMesh);

    /* --- the chips: two draw calls --- */
    this.chips = new ShatterField(this.group, {
      geometry: createChipGeometry,
      variants: CHIP_VARIANTS,
      capacity: CHIP_CAPACITY,
      additive: false,
      depthWrite: false,
      renderOrder: 8
    });

    /** The one dice roll a cast makes. */
    this._seed = 0;
    /** Children actually drawn this frame — the HUD's instance count. */
    this._childCount = 1;
    /** Timestamps, in the cast's own clock. `-1` for "has not happened". */
    this._splitAt = -1;
    this._crackAt = -1;

    /* --- scratch handed to the modules each frame. One each, reused. --- */
    this._lanceState = {
      origin: new Vector3(),
      target: new Vector3(),
      side: new Vector3(),
      progress: 0,
      fade: 1,
      widthFade: 1,
      seed: 0,
      time: 0
    };
    this._fanState = {
      prism: new Vector3(),
      target: new Vector3(),
      side: new Vector3(),
      progress: 0,
      fade: 1,
      seed: 0,
      count: 6,
      white: 0
    };
    this._prismState = {
      fade: 0,
      load: 0,
      crack: 0,
      seed: 0,
      normalFix: new Vector3(1, 1, 1)
    };
    this._chipParams = shatterParams();
    this._chipParams.layout = ShatterLayout.LINE;
    this._chipLook = {
      colorA: makeColor('#ffffff'),
      colorB: makeColor('#ffffff'),
      colorEdge: makeColor('#ffffff'),
      colorScene: makeColor('#ffffff'),
      opacity: 1,
      glow: 1,
      rim: 1,
      rimPower: 2,
      shade: 1,
      ambient: 0.4,
      fadeStart: 0.6,
      soft: 0,
      sceneMix: 0.75,
      refract: 0.05,
      saturation: 0.3
    };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Spectral motes shed by the solid — the thing that tells you it is *hot*
    // rather than merely lit.
    this.motes = particles.get('prismlance.motes', {
      capacity: 2000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.5;
    this.motes.uniforms.uEndSize.value = 0.2;
    this.motes.uniforms.uSizeIn.value = 0.06;
    this.motes.uniforms.uFadeIn.value = 0.1;
    this.motes.uniforms.uFadeOut.value = 0.45;

    // Sparks: the split, the crack and the impact. Velocity-stretched streaks.
    this.sparks = particles.get('prismlance.sparks', {
      capacity: 2400,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.5;
    this.sparks.uniforms.uEndSize.value = 0.25;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.45;

    // Dust off the floor where the fan converges. Non-additive so it occludes.
    this.dust = particles.get('prismlance.dust', {
      capacity: 1200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.dust.uniforms.uDrag.value = 1.8;
    this.dust.uniforms.uEndSize.value = 2.6;
    this.dust.uniforms.uSizeIn.value = 0.12;
    this.dust.uniforms.uFadeIn.value = 0.16;
    this.dust.uniforms.uFadeOut.value = 0.32;

    this.moteEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._childCount + this.chips.count;
  }

  get impactDuration() {
    return Math.max(0.05, settings.prismlance.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.prismlance.fadeTime);
  }

  /** How far the lance has wound up in the hand, 0..1. */
  get charge() {
    return saturate(this.age / Math.max(0.01, settings.prismlance.charge));
  }

  /**
   * A prism breathes; it does not gutter. A stutter here would immediately read
   * as the Storm Lance's light, and this ability is the opposite of electric.
   */
  lightShimmer() {
    const c = settings.prismlance;
    return 1 - c.lightPulse * (0.5 - 0.5 * Math.cos(this.age * c.lightPulseSpeed * TAU));
  }

  /**
   * Hold the front in the hand until the lance is up to power.
   *
   * The fourth beat, bought exactly the way Nova Beam buys it: the phase
   * machine still runs travel → impact → fade, and the wind-up is simply a
   * refusal to let `front` leave the caster.
   */
  advance(dt) {
    const c = this.config;
    const charge = Math.max(0, c.charge);
    if (this.age < charge) return false;

    const speed = c.speed * settings.global.speed;
    const since = this.age - charge;
    this.front += speed * Easing.outQuad(saturate(since / 0.06)) * dt;

    const previousU = this.u;
    this.u = saturate(this.front / this.length);
    this.pointAt(this.u, this.position);
    return this.u >= 1 && previousU < 1;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                  */
  /* ------------------------------------------------------------------ */

  /** Where along the span the solid floats, 0..1, clamped off both ends. */
  get _prismFraction() {
    return clamp(settings.prismlance.prismAt, 0.02, 0.98);
  }

  /** Where the lance leaves the caster, world space. */
  _handPoint(out) {
    const c = settings.prismlance;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /**
   * Where the solid is hanging, world space.
   *
   * The bob is a live sine on the cast's own clock rather than an integrated
   * position, so dragging `prismBob` with the sandbox paused moves the solid
   * instead of changing where it will drift to next.
   */
  _prismPoint(out) {
    const c = settings.prismlance;
    this.pointAt(this._prismFraction, out);
    out.y = c.prismHeight + c.prismBob * Math.sin(this.age * c.prismBobSpeed * TAU);
    return out;
  }

  /** Where the fan converges, world space. */
  _impactPoint(out) {
    this.pointAt(1, out);
    out.y = settings.prismlance.endHeight;
    return out;
  }

  /**
   * A point on the *visible* path at `s`, 0..1 — hand → prism → target.
   *
   * The cast line is straight along the floor, but the light is not: it leaves
   * a hand at chest height, turns at a solid hanging above the line, and lands
   * low. Sparks and the dynamic light are placed against this rather than
   * against `pointAt()`, or they sit under the beam instead of on it.
   */
  _pathPoint(s, out) {
    const at = this._prismFraction;
    const t = saturate(s);
    if (t <= at) {
      this._handPoint(_hand);
      this._prismPoint(_prism);
      return out.copy(_hand).lerp(_prism, at <= 1e-4 ? 1 : t / at);
    }
    this._prismPoint(_prism);
    this._impactPoint(_target);
    return out.copy(_prism).lerp(_target, (t - at) / Math.max(1e-4, 1 - at));
  }

  /** Half-width of the fan at `s` along the *fan*, 0..1 — metres. */
  _fanRadius(s) {
    const c = settings.prismlance;
    const t = saturate(s);
    const bow = Math.pow(Math.sin(Math.PI * Math.pow(t, Math.max(0.05, c.fanBow))), Math.max(0.05, c.fanBowCurve));
    return c.fanSpread * Math.max(1, c.fanDispersion) * bow;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this.chips.clear();
    this._splitAt = -1;
    this._crackAt = -1;

    // The one thing a cast captures, and it is unitless.
    this._seed = Math.random() * 100;

    this._syncUniforms(1);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push live settings and the current cast state into all four systems.
   *
   * @param {number} fade 1 while the cast is lit, ramping to 0 as it dies
   */
  _syncUniforms(fade) {
    const c = settings.prismlance;
    const g = settings.global;
    const at = this._prismFraction;
    const charge = this.charge;

    this._handPoint(_hand);
    this._prismPoint(_prism);
    this._impactPoint(_target);

    /* --- how much of each half exists yet --- */
    // Before release the lance is a stub creeping out of the hand; after it,
    // the front's fraction of the span is renormalised onto each half.
    const travelling = this.phase === AbilityPhase.TRAVEL;
    const lanceProgress = travelling
      ? this.u <= 0
        ? Easing.outQuad(charge) * c.chargeStub
        : saturate(this.u / at)
      : 1;
    const fanProgress = travelling ? saturate((this.u - at) / Math.max(1e-4, 1 - at)) : 1;

    /* --- the white lance --- */
    const lance = this._lanceState;
    lance.origin.copy(_hand);
    lance.target.copy(_prism);
    lance.side.copy(this.side);
    lance.progress = lanceProgress;
    lance.fade = fade;
    // The barrel is thin while it winds up and full width once it goes.
    lance.widthFade = travelling && this.u <= 0 ? lerp(c.chargeSwell, 1, Easing.inQuad(charge)) : 1;
    lance.seed = this._seed;
    lance.time = this.age;
    this.lance.sync(c, lance, g);

    /* --- the fan --- */
    const fan = this._fanState;
    fan.prism.copy(_prism);
    fan.target.copy(_target);
    fan.side.copy(this.side);
    fan.progress = fanProgress;
    fan.fade = fade;
    fan.seed = this._seed;
    this._childCount = Math.max(1, Math.min(MAX_CHILDREN, Math.round(c.children)));
    fan.count = this._childCount;
    this.fanGeometry.instanceCount = this._childCount;
    // The collapse: once the solid has cracked, the children are no longer
    // being separated by anything, so they run back to white.
    fan.white = this._crackAt < 0 ? 0 : Math.pow(saturate((this.age - this._crackAt) / Math.max(0.05, c.prismCrackTime)), Math.max(0.05, c.fanCollapse));
    this.fanMaterial.userData.sync(fan);

    /* --- the solid --- */
    const prism = this._prismState;
    const crack = this._crackAt < 0 ? 0 : saturate((this.age - this._crackAt) / Math.max(0.05, c.prismCrackTime));
    // It fades in over the wind-up, blazes while the lance is inside it, and is
    // eaten by its own fracture field on the way out.
    prism.fade = Easing.outCubic(charge) * fade * (1 - crack);
    prism.load = this._splitAt < 0 ? charge * 0.35 : 1 - crack;
    prism.crack = crack;
    prism.seed = this._seed;

    const swell = lerp(1, c.prismSwell, prism.load);
    const radius = Math.max(0.01, c.prismRadius * swell);
    const length = Math.max(0.01, c.prismLength * swell);
    this.prismMesh.position.copy(_prism);
    this.prismMesh.scale.set(radius, length, radius);
    this.prismMesh.rotation.set(c.prismTilt, this.age * c.prismSpin * TAU + this._seed, 0);
    // See PrismMaterial: mat3(modelMatrix) is R·S, and a normal wants R·S⁻¹.
    prism.normalFix.set(1 / (radius * radius), 1 / (length * length), 1 / (radius * radius));
    this.prismMaterial.userData.sync(prism);

    /* --- the chips --- */
    const p = this._chipParams;
    p.origin = this.origin;
    p.direction = this.direction;
    p.side = this.side;
    p.length = this.length;
    p.width = c.fanSpread;
    p.spawnRadius = c.chipScatter;
    p.spawnHeight = c.prismHeight;
    p.speed = c.chipSpeed;
    p.speedJitter = c.chipSpeedJitter;
    p.spread = c.chipSpread;
    p.upBias = c.chipUpBias;
    p.gravity = c.chipGravity;
    p.drag = c.chipDrag;
    p.size = c.chipSize;
    p.sizeJitter = c.chipSizeJitter;
    p.shrink = c.chipShrink;
    p.shrinkPower = c.chipShrinkPower;
    p.spin = c.chipSpin * g.animationSpeed;
    p.spinJitter = c.chipSpinJitter;
    p.lifetime = c.chipLifetime * g.lifetime;
    p.floorSpin = c.chipFloorSpin;
    p.randomness = g.randomness;

    const look = this._chipLook;
    look.colorA.copy(getColor(c.colorChipA));
    look.colorB.copy(getColor(c.colorChipB));
    look.colorEdge.copy(getColor(c.colorChipEdge));
    look.colorScene.copy(getColor(c.colorChipScene));
    look.opacity = c.chipOpacity * g.opacity * fade;
    look.glow = c.chipGlow * g.glow;
    look.rim = c.chipRim;
    look.rimPower = c.chipRimPower;
    look.shade = c.chipShade;
    look.ambient = c.chipAmbient;
    look.fadeStart = c.chipFadeStart;
    this.chips.sync(look);
    this.chips.update(this.age, p);

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
    this.motes.uniforms.uGlow.value = 1.1 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

    this.sparks.setGradient(
      getColor(c.colorSparkA),
      getColor(c.colorSparkB),
      getColor(c.colorSparkC),
      getColor(c.colorSparkD)
    );
    this.sparks.uniforms.uGravity.value.set(0, c.sparkGravity, 0);
    this.sparks.uniforms.uSizeScale.value = c.sparkSize * g.particleSize * 7;
    this.sparks.uniforms.uLifeScale.value = c.sparkLifetime * 0.5 * g.particleLifetime;
    this.sparks.uniforms.uSpeedScale.value = g.particleSpeed;
    this.sparks.uniforms.uOpacity.value = g.opacity;
    this.sparks.uniforms.uGlow.value = c.fanGlow * 0.5 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
    this.sparks.uniforms.uTurbulence.value = 0.25 * g.turbulence;

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
    this.dust.uniforms.uTurbulence.value = 0.3 * g.turbulence;
  }

  /** The flash at the caster's hand as the lance leaves it. */
  _muzzleFx() {
    const c = settings.prismlance;
    const g = settings.global;

    this._handPoint(_pos);
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.muzzleSize * 0.2,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.32,
      intensity: c.muzzleIntensity,
      opacity: 0.85,
      fresnel: 1.6,
      displace: 0.4,
      colorA: getColor(c.colorMuzzleA),
      colorB: getColor(c.colorMuzzleB),
      colorC: getColor(c.colorMuzzleC)
    });

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  /**
   * The moment the lance reaches the solid.
   *
   * This is the beat the whole ability is named for, and it is a real event in
   * the geometry rather than a scheduled one: it fires on the frame the front
   * crosses `prismAt`, so moving the solid moves the moment.
   */
  _splitFx() {
    const c = settings.prismlance;
    const g = settings.global;

    this._prismPoint(_pos);
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.splitSize * 0.15,
      endRadius: c.splitSize * g.explosionIntensity,
      life: 0.45,
      intensity: c.splitIntensity,
      opacity: 0.8,
      fresnel: 2.0,
      displace: 0.35,
      squash: 0.7,
      colorA: getColor(c.colorSplitA),
      colorB: getColor(c.colorSplitB),
      colorC: getColor(c.colorSplitC)
    });

    _emit.position = _pos;
    _emit.radius = 0.16;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.sparkSpeed * 1.4;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.95;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.18;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(c.splitSparks * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorSplitC), c.splitFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.8 * g.explosionIntensity;
  }

  /** The solid letting go: the chips, and the sparks that come with them. */
  _crackFx() {
    const c = settings.prismlance;
    const g = settings.global;

    this.chips.burst(this.age, Math.round(c.chipCount * g.particleCount), this._prismFraction, 0);

    this._prismPoint(_pos);
    _emit.position = _pos;
    _emit.radius = c.chipScatter;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.4).setY(0.6).normalize();
    _emit.speed = c.sparkSpeed;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.75;
    _emit.life = c.sparkLifetime * 1.2;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(c.crackSparks * g.particleCount), _emit);
  }

  /** Motes shed by the solid and along whichever half of the light exists. */
  _shedFx(dt, scale) {
    const c = settings.prismlance;
    const g = settings.global;

    const count = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (count <= 0) return;

    // Half off the solid itself, half strung along the light. A single origin
    // makes every batch read as a puff pinned to the prism, which is very
    // obviously wrong the moment the fan is long.
    const reach = this.phase === AbilityPhase.TRAVEL ? Math.max(0.02, this.u) : 1;
    const batches = Math.min(count, SPARK_BATCHES);
    const per = Math.ceil(count / batches);
    let left = count;
    while (left > 0) {
      const s = randRange(0.02, 1) * reach;
      this._pathPoint(s, _pos);
      _emit.position = _pos;
      _emit.radius = 0.1 + this._fanRadius(saturate((s - this._prismFraction) / Math.max(1e-4, 1 - this._prismFraction))) * 0.6;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.motes.emit(Math.min(per, left), _emit);
      left -= per;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.prismlance;
    const g = settings.global;

    // The split is polled against the live fraction, not scheduled off a
    // timestamp taken at spawn — move the solid and the moment moves with it.
    if (this._splitAt < 0 && this.u >= this._prismFraction && this.u > 0) {
      this._splitAt = this.age;
      this._splitFx();
    }

    this._syncUniforms(1);

    // The light rides the front along the *visible* path, so it turns the
    // corner at the solid instead of sliding along the floor.
    if (this.u <= 0) this._handPoint(this.position);
    else this._pathPoint(this.u, this.position);

    this._shedFx(dt, this.u <= 0 ? 0.5 : 1);

    const shake = this.u <= 0 ? c.chargeShake * this.charge : c.rumble;
    this.ctx.shake.rumble(shake * g.cameraShake, dt);
  }

  onImpact() {
    const c = settings.prismlance;
    const g = settings.global;
    const time = frame.uTime.value;

    this._impactPoint(_pos);
    this.pointAt(1, _target);

    /* the shell where the children meet again */
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.burstSize * 0.2,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.65,
      intensity: c.burstIntensity,
      opacity: 0.9,
      fresnel: 1.7,
      displace: 0.5,
      squash: 0.85,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring across the floor, and the pale burn under it */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _target, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.55,
      width: 0.045,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });
    this.ctx.decals.spawn(DecalType.SCORCH, _target, {
      radius: c.scorchRadius * randRange(1.6, 2.4),
      life: c.scorchLife,
      intensity: c.scorchIntensity,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorEmber),
      height: 0.015
    });

    /* sparks out of the convergence, dust off the floor under it */
    _emit.position = _pos;
    _emit.radius = 0.28;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.45).setY(0.7).normalize();
    _emit.speed = c.sparkSpeed * 2.0;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.2;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);

    _emit.position = _target;
    _emit.radius = c.scorchRadius * 2;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dustSpeed * 2.0;
    _emit.spread = 1.0;
    _emit.size = 1.3;
    _emit.life = c.dustLifetime * 1.2;
    _emit.spin = 0.4;
    this.dust.emit(Math.round(c.burstDust * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      24
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.2 * g.explosionIntensity;
  }

  onFade(dt, t) {
    // `t` runs 0..1 while the fan holds, then 1..2 while everything lets go.
    // The crack is fired on the transition rather than at a fixed age, so
    // stretching `lifetime` keeps the solid intact for longer.
    if (t >= 1 && this._crackAt < 0) {
      this._crackAt = this.age;
      this._crackFx();
    }

    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
    this._syncUniforms(fade);

    this._pathPoint(1, this.position);
    this._shedFx(dt, fade * (t <= 1 ? 0.7 : 0.25));
  }

  onDestroy() {
    this._childCount = 1;
    this.fanGeometry.instanceCount = 1;
    this.chips.clear();
    this.lance.materials.core.uniforms.uFade.value = 0;
    this.lance.materials.sheath.uniforms.uFade.value = 0;
    this.lance.materials.halo.uniforms.uFade.value = 0;
    this.fanMaterial.uniforms.uFade.value = 0;
    this.prismMaterial.uniforms.uFade.value = 0;
  }

  dispose() {
    this.lance.dispose();
    this.chips.dispose();
    this.prismGeometry.dispose();
    this.prismMaterial.dispose();
    this.fanGeometry.dispose();
    this.fanMaterial.dispose();
    super.dispose();
  }
}
