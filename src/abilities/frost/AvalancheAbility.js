import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { createSnowSlabMaterial } from '../../materials/SnowSlabMaterial.js';
import { DissolveField } from '../../vfx/Dissolve.js';
import { GrowthField, GrowthLayout, GrowthEmerge } from '../../vfx/GrowthField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, hash11, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;

/** Hard ceiling on slabs in one flow. The editor's `slabCount` clamps here. */
const MAX_SLABS = 96;
/** Distinct slab silhouettes. Three, for the reason `GrowthField` documents. */
const SLAB_VARIANTS = 3;
/**
 * Grid resolution of the heap sheet, down the cast and across it.
 *
 * The lobes are metres across and the ridges where two of them meet are the
 * texture of the whole thing, so this is what decides whether a crease is a
 * crease or a staircase. 96 × 44 is one triangle every ~20 cm on a 19 m cast,
 * which is about where the staircase stops being visible from the default
 * camera; 64 × 32 is honest and noticeably blockier along the crest.
 */
const HEAP_ALONG = 96;
const HEAP_ACROSS = 44;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _target = new Vector3();

/* ---------------------------------------------------------------------- */
/* Geometry                                                                */
/* ---------------------------------------------------------------------- */

/**
 * One block of hard slab, in `GrowthField`'s unit space.
 *
 * A prism on an irregular plan, tapered upward and with its top face **sheared
 * off a plane** rather than cut flat — because that is what a slab avalanche
 * leaves behind. The snowpack fails along a weak layer, the plate above it
 * breaks into blocks, and each block is a wedge with one clean fracture plane
 * on it. Footprint inside a circle of radius 0.5 on `y = 0`, tip at `y = 1`.
 *
 * The first version was a rounded lump with vertex noise on it. It read as
 * rubble — as something that had been *eroded* — and rubble is exactly wrong
 * here: the whole point of the slabs is that they are freshly broken and their
 * faces are flat. Flat faces plus `flatShading` plus one sheared plane is the
 * entire silhouette, and it needed less code than the noise did.
 *
 * `notch` chips the high corner of that plane away, so the blocks are not all
 * the same wedge seen from different sides.
 */
function createSnowSlabGeometry(variant, shape) {
  const seed = 7.3 + variant * 21.7;
  const sides = clamp(Math.round(shape?.facets ?? 6), 4, 10);
  const shear = clamp(shape?.shear ?? 0.55, 0, 1);
  const taper = clamp(shape?.taper ?? 0.78, 0.15, 1.2);
  const rough = clamp(shape?.rough ?? 0.3, 0, 0.95);
  const notch = clamp(shape?.notch ?? 0.22, 0, 0.7);

  // The fracture plane, rolled once per variant: a bearing and a tip.
  const planeAngle = hash11(seed * 1.7) * TAU;
  const nx = Math.cos(planeAngle);
  const nz = Math.sin(planeAngle);

  const bottom = [];
  const top = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * TAU;
    // One radius per bearing, shared by the base and the top ring, so the
    // block keeps continuous vertical edges instead of twisting.
    const radius = 0.5 * (1 - rough * hash11(seed * 3.1 + i * 5.9));
    const bx = Math.cos(angle) * radius;
    const bz = Math.sin(angle) * radius;
    const tx = bx * taper;
    const tz = bz * taper;
    // The sheared plane. Held clear of the floor so a steeply tipped block
    // still has a wall on its low side rather than a zero-area sliver.
    let ty = 1 - shear * (tx * nx + tz * nz) * 2;
    // The chip out of the high corner, on the same plane's positive side.
    const high = saturate((tx * nx + tz * nz) * 2 + 0.5);
    ty -= notch * high * hash11(seed * 5.3 + i * 2.7);
    bottom.push([bx, 0, bz]);
    top.push([tx, clamp(ty, 0.18, 1), tz]);
  }

  let capY = 0;
  for (const point of top) capY += point[1];
  capY /= sides;
  const centreTop = [0, capY, 0];
  const centreBottom = [0, 0, 0];

  const positions = [];
  // Deliberately not named `a`, `b`, `c`: the harness's static settings pass
  // treats `const c = …` as poisoning the `c` alias for the whole file, and a
  // geometry local called `c` would blind it to every `settings.avalanche`
  // read in the ability below.
  const tri = (p, q, r) => {
    positions.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
  };

  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    // Winding is authored rather than left to chance — a block lit from below
    // is the one thing `flatShading` makes impossible to miss.
    tri(centreTop, top[j], top[i]);
    tri(centreBottom, bottom[i], bottom[j]);
    tri(top[i], top[j], bottom[j]);
    tri(top[i], bottom[j], bottom[i]);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* The ability                                                             */
/* ---------------------------------------------------------------------- */

/**
 * AVALANCHE — snow that piles, slumps and finds its angle of repose.
 *
 * **The trick: the front is a heap, not a wave.** Everything else in the
 * sandbox that moves along the floor is a *surface* being animated — a
 * heightfield with a travelling profile, a growth front, a sweep. Those all
 * share one tell, which is that the shape is authored and the motion is
 * imposed on it. This one is the other way round: the shape is a *consequence*.
 *
 * A lobe of snow is released at the front every `1/lobeRate` seconds. It is
 * born over-steep — `repose + excess` radians — and its slope relaxes back
 * toward `repose` at `slump` per second. Its **volume is held**, so a slope
 * that relaxes has nowhere to go but outward: with `V` fixed and a cone of
 * half-angle φ, `H = ∛(3V·tan²φ/π)` and `radius = H/tanφ`. One exponential and
 * one cube root, and the lobe collapses on its own. The surface you see is the
 * **upper envelope** of the sixteen youngest lobes — a max, never a sum, because
 * heaps merge by taking the higher of the two and summing them gives a smooth
 * mound with no creases, which is a pudding. Every crease on the front is two
 * lobes meeting. Each lobe's centroid also creeps forward at `creep` while it
 * collapses, so new material lands *on top of* older material and slides over
 * it, which is the "keeps falling forward over itself" of the brief and is one
 * term in the shader.
 *
 * The envelope is `vfx/Dissolve.js`'s `DissolveField`, and this ability is its
 * first caller. Everything above is closed-form in `now − birth`, which is why
 * the repose angle and the slump rate are live: pull `repose` down on a
 * **paused** avalanche and the whole standing heap flattens and spreads, which
 * is worth doing once just to watch.
 *
 * ## Why the heap has its own clock
 *
 * An avalanche does not stop because it reached a line on the floor. It runs
 * out: it decelerates over a few metres and the surface freezes where it lies.
 *
 * The heap's release point is `heapClock · frontSpeed`, so the honest way to
 * stop it is to stop the clock — and because the lobes' collapse is a function
 * of the *same* clock, throttling it slows the release of new material and the
 * slumping of the standing material by exactly the same factor. That is a
 * runout: the flow decelerates as one thing and comes to rest. So `heapClock`
 * advances at `dt × throttle`, and `throttle` falls from 1 to 0 over `runout`
 * seconds on the `runoutCurve` exponent once the cast front lands.
 *
 * Two alternatives were tried and both are worse. Clamping the front by driving
 * `frontSpeed` down as `length/now` keeps the clock running but re-places every
 * lobe (their centres are `birth · frontSpeed`), so the whole train visibly
 * contracts backwards toward the caster — the heap slides *uphill*. Letting the
 * front run on past the end of the sheet is worse still: the lobe train walks
 * out of the drawn region within half a second and all that is left standing is
 * the flat bed, so the avalanche appears to run off a cliff.
 *
 * ## The slabs
 *
 * A `GrowthField` of hard blocks shouldered up out of the flow behind the
 * front. They are not decoration: a heightfield of snow has no hard edges
 * anywhere in it and therefore no scale — the heap could be 30 cm deep or 3 m
 * deep and nothing in the image says which. The blocks are the scale reference,
 * they are the only thing in the cast that casts a real shadow, and their
 * fracture faces are the only sharp specular in it.
 *
 * They also **lie back onto the repose slope**: their lean is
 * `slabLean + (π/2 − repose) · slabRepose`, so dragging the repose angle tips
 * the blocks over with the surface they are sitting in. That tie is the one
 * derived value in the ability and it earns its place — with the blocks
 * standing bolt upright in a flattened heap the illusion goes immediately.
 *
 * ## The rule that makes the editor work
 *
 * A cast captures one seed and two timestamps (the impact, and the clock the
 * runout is measured from). Every metre, radian and second is resolved against
 * `settings.avalanche` inside the update loop, on a zero-length frame included.
 *
 * Four draw calls: one heap, three slab meshes.
 */
export class AvalancheAbility extends Ability {
  constructor(context) {
    super('avalanche', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.heap = new DissolveField(this.group, {
      along: HEAP_ALONG,
      across: HEAP_ACROSS,
      renderOrder: 3,
      name: 'Avalanche:heap'
    });

    this.material = createSnowSlabMaterial(this.ctx.environment);
    this.slabUniforms = this.material.userData.uniforms;

    /**
     * Live shape controls, handed to the geometry factory. Mutated in place —
     * an object literal per frame is the allocation I3 forbids — and compared
     * numerically by `syncGeometry`, which rebuilds only when one has moved.
     */
    this._shape = { facets: 6, shear: 0.55, taper: 0.78, rough: 0.3, notch: 0.22 };
    this._fillShape();

    this.slabs = new GrowthField(this.group, {
      geometry: createSnowSlabGeometry,
      material: this.material,
      shape: this._shape,
      variants: SLAB_VARIANTS,
      capacity: MAX_SLABS,
      layer: LAYER.WORLD,
      renderOrder: 2,
      castShadow: true,
      receiveShadow: true
    });
    // Assigned once, at construction — a closure rebuilt per frame per instance
    // is exactly what I3 forbids.
    this.slabs.onBreach = (index, position, radius) => this._breachFx(position, radius);

    /* --- scratch parameter blocks, filled from settings every frame --- */
    this._heapPar = {};
    this._growth = {
      layout: GrowthLayout.LINE,
      emerge: GrowthEmerge.PUSH,
      origin: new Vector3(),
      direction: new Vector3(0, 0, 1),
      side: new Vector3(1, 0, 0),
      length: 1
    };

    /** Re-rolled per cast so two avalanches do not pile in the same pattern. */
    this._seed = 0;
    /**
     * The heap's own clock, seconds. Integrated rather than read off `age`
     * because the runout throttles it — see the class header. This is the same
     * kind of quantity as the base class's own `front`, which is metres it has
     * accumulated from `speed`; it is not a dimension the cast *captured*.
     */
    this._heapNow = 0;
    /** Timestamp the front landed, or -1. The runout is measured from it. */
    this._landedAt = -1;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The powder cloud. Non-additive, because the one thing that separates a
    // real avalanche from a smoke effect is that the cloud is *opaque* — you
    // lose the heap behind it, and an additive cloud never occludes anything.
    this.powder = particles.get('avalanche.powder', {
      capacity: 2600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.2
    });
    this.powder.uniforms.uDrag.value = 1.7;
    this.powder.uniforms.uEndSize.value = 3.4;
    this.powder.uniforms.uSizeIn.value = 0.1;
    this.powder.uniforms.uFadeIn.value = 0.14;
    this.powder.uniforms.uFadeOut.value = 0.36;

    // Spindrift: individual crystals torn off the crest and lit from behind.
    this.drift = particles.get('avalanche.drift', {
      capacity: 2200,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.drift.uniforms.uDrag.value = 1.5;
    this.drift.uniforms.uEndSize.value = 0.2;
    this.drift.uniforms.uSizeIn.value = 0.05;
    this.drift.uniforms.uFadeIn.value = 0.08;
    this.drift.uniforms.uFadeOut.value = 0.36;

    // Chunks knocked off a slab as it breaks the surface.
    this.chunks = particles.get('avalanche.chunks', {
      capacity: 1400,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.chunks.uniforms.uDrag.value = 0.28;
    this.chunks.uniforms.uEndSize.value = 0.8;
    this.chunks.uniforms.uFadeOut.value = 0.7;

    this.powderEmitter = new RateEmitter();
    this.driftEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.slabs.count;
  }

  /** The deposit stands, then sinks and thins away. */
  get impactDuration() {
    return Math.max(0.1, settings.avalanche.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.1, settings.avalanche.settleTime);
  }

  /** Snow breathes; it does not gutter. A slow cosine on the bounced light. */
  lightShimmer() {
    const c = settings.avalanche;
    return 1 - c.lightPulse * (0.5 - 0.5 * Math.cos(this.age * c.lightPulseSpeed * TAU));
  }

  /* ------------------------------------------------------------------ */
  /* Live geometry — every metre resolved from settings, every frame      */
  /* ------------------------------------------------------------------ */

  /** The shape controls the slab geometry is baked against. */
  _fillShape() {
    const c = settings.avalanche;
    const shape = this._shape;
    shape.facets = c.facets;
    shape.shear = c.shear;
    shape.taper = c.taper;
    shape.rough = c.rough;
    shape.notch = c.notch;
    return shape;
  }

  /**
   * 0..1 through the runout — how much of the flow's momentum is left.
   *
   * Exponent rather than a smoothstep so the shape is authorable: at
   * `runoutCurve = 1` the brake is linear and the front stops dead at the end
   * of the window; above 1 it coasts and then stops, which is what a real
   * deposit does as the internal friction wins.
   */
  _throttle() {
    const c = settings.avalanche;
    if (this._landedAt < 0) return 1;
    const k = saturate((this.age - this._landedAt) / Math.max(0.05, c.runout));
    return Math.pow(1 - k, Math.max(0.2, c.runoutCurve));
  }

  /** 0..1 through the fade — how far the deposit has sunk and thinned. */
  _settle() {
    const c = settings.avalanche;
    if (this.phase !== AbilityPhase.FADE) return 0;
    return saturate(this.fadeTime / Math.max(0.05, c.settleTime));
  }

  /**
   * The heap, in `heapParams()`'s vocabulary.
   *
   * `frontSpeed` is the one derived number: the heap has to keep station with
   * the cast front the base class is advancing, so it reads the same `speed`
   * and the same global multiplier and carries its own `heapLead` on top. Give
   * it an independent speed slider and the two fronts drift apart within a
   * metre, and the powder cloud ends up hanging over bare floor.
   */
  _fillHeap() {
    const c = settings.avalanche;
    const g = settings.global;
    const p = this._heapPar;
    const settle = this._settle();

    p.halfWidth = c.heapWidth;
    p.floor = c.heapFloor - settle * c.settleSink;
    p.heightGain = c.heapHeight * (1 - settle * c.settleFlatten);

    p.lobes = c.lobes;
    p.rate = c.lobeRate;
    p.frontSpeed = c.speed * g.speed * c.heapLead;
    p.volume = c.lobeVolume;
    p.volumeJitter = c.lobeJitter * g.randomness;
    p.repose = c.repose;
    p.excess = c.excess;
    p.slump = c.slump;
    p.creep = c.creep;
    p.scatter = c.lobeScatter;
    p.widen = c.widen;

    p.bed = c.bed;
    p.bedRamp = c.bedRamp;
    p.bedWidth = c.bedWidth;
    p.bedCurve = c.bedCurve;

    p.ambient = c.snowAmbient;
    p.wrap = c.snowWrap;
    p.fresh = c.snowFresh;
    p.grain = c.snowGrain * g.randomness;
    p.grainScale = c.snowGrainScale * g.noiseFrequency;
    p.glint = c.snowGlint * g.shaderIntensity;
    p.glintScale = c.snowGlintScale * g.noiseFrequency;
    p.toe = c.heapToe;
    p.opacity = c.heapOpacity * g.opacity * (1 - settle * settle);
    return p;
  }

  /**
   * The slab field: footprint, silhouette and how a block shoulders up.
   *
   * The lean is the one place the two halves of the ability are wired together.
   * A block sitting in a surface at the angle of repose is lying back on that
   * surface, so `(π/2 − repose)` is how far past vertical it should be tipped,
   * and `slabRepose` is how much of that to believe. At 0 the blocks stand
   * upright out of a flattened heap and the whole read collapses.
   */
  _fillGrowth() {
    const c = settings.avalanche;
    const g = settings.global;
    const p = this._growth;

    p.origin.copy(this.origin);
    p.direction.copy(this.direction);
    p.side.copy(this.side);
    p.length = this.length;

    p.widthNear = c.slabWidthNear;
    p.width = c.slabWidth;
    p.widthCurve = c.slabWidthCurve;
    p.frontBias = c.slabBias;
    p.clumping = c.slabClump;
    p.scatter = c.slabScatter;
    p.clusterRadius = c.slabClusterRadius;

    p.heightNear = c.slabHeightNear;
    p.height = c.slabHeight;
    p.heightCurve = c.slabHeightCurve;
    p.heightJitter = c.slabHeightJitter;
    p.crown = c.slabCrown;
    p.crownPower = c.slabCrownPower;
    p.rubble = c.slabRubble;
    p.rubbleScale = c.slabRubbleScale;

    p.radiusNear = c.slabRadiusNear;
    p.radius2 = c.slabRadius;
    p.radiusCurve = c.slabRadiusCurve;
    p.radiusJitter = c.slabRadiusJitter;

    p.lean = c.slabLean + (HALF_PI - c.repose) * c.slabRepose;
    p.leanRamp = c.slabLeanRamp;
    p.twist = c.slabTwist;
    p.tilt = c.slabTilt;

    p.riseTime = c.slabRise;
    p.riseOvershoot = c.slabOvershoot;
    p.settle = c.slabSettle;
    p.springRate = c.slabSpring;
    p.emergeSink = c.slabSink;
    p.birthScale = c.slabBirthScale;
    p.birthFade = c.slabBirthFade;
    p.breachAt = c.slabBreach;
    p.sinkDepth = c.slabRetractSink;
    p.randomness = g.randomness;
    return p;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.avalanche;

    this.powderEmitter.reset();
    this.driftEmitter.reset();
    this._heapNow = 0;
    this._landedAt = -1;
    this._seed = Math.random() * 100;

    this.heap.roll(this._seed);
    this.slabs.plant(Math.min(MAX_SLABS, Math.round(c.slabCount)), c.slabCluster);

    this._syncUniforms();
    this._syncFields();
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** Push the live settings into the slab material and the three systems. */
  _syncUniforms() {
    const c = settings.avalanche;
    const g = settings.global;

    this.material.userData.sync(this.direction);

    this.powder.setGradient(
      getColor(c.colorPowderA),
      getColor(c.colorPowderB),
      getColor(c.colorPowderC),
      getColor(c.colorPowderD)
    );
    this.powder.uniforms.uGravity.value.set(0, c.powderRise, 0);
    this.powder.uniforms.uSizeScale.value = c.powderSize * g.particleSize;
    this.powder.uniforms.uLifeScale.value = c.powderLifetime * 0.5 * g.particleLifetime;
    this.powder.uniforms.uSpeedScale.value = c.powderSpeed * g.particleSpeed;
    this.powder.uniforms.uOpacity.value = c.powderOpacity * g.opacity;
    this.powder.uniforms.uTurbulence.value = 0.4 * g.turbulence;

    this.drift.setGradient(
      getColor(c.colorDriftA),
      getColor(c.colorDriftB),
      getColor(c.colorDriftC),
      getColor(c.colorDriftD)
    );
    this.drift.uniforms.uGravity.value.set(0, c.driftRise, 0);
    this.drift.uniforms.uSizeScale.value = c.driftSize * g.particleSize * 7;
    this.drift.uniforms.uLifeScale.value = c.driftLifetime * 0.5 * g.particleLifetime;
    this.drift.uniforms.uSpeedScale.value = c.driftSpeed * g.particleSpeed;
    this.drift.uniforms.uOpacity.value = g.opacity;
    this.drift.uniforms.uGlow.value = 0.55 * g.glow;
    this.drift.uniforms.uTurbulence.value = c.driftTurbulence * g.turbulence;

    this.chunks.setGradient(
      getColor(c.colorChunkA),
      getColor(c.colorChunkB),
      getColor(c.colorChunkC),
      getColor(c.colorChunkD)
    );
    this.chunks.uniforms.uGravity.value.set(0, c.chunkGravity, 0);
    this.chunks.uniforms.uSizeScale.value = c.chunkSize * g.particleSize * 7;
    this.chunks.uniforms.uLifeScale.value = c.chunkLifetime * 0.5 * g.particleLifetime;
    this.chunks.uniforms.uSpeedScale.value = g.particleSpeed;
    this.chunks.uniforms.uOpacity.value = g.opacity;
  }

  /** Rebuild the heap and the slab field against the live settings. */
  _syncFields() {
    const c = settings.avalanche;

    this.heap.setBasis(this.origin, this.direction, this.side, this.length);
    this.heap.setColors(c.colorFresh, c.colorSettled, c.colorFace, c.colorDeep);
    this.heap.update(this._heapNow, this._fillHeap());

    this.slabs.syncGeometry(this._fillShape());
    this.slabs.update(this.age, this._fillGrowth(), this._settle());
  }

  /**
   * Where the crest of the flow is right now, world space.
   *
   * `frontPoint` is the module's own mirror of the release point, so the
   * powder, the light and the shake all hang off the same number the vertex
   * shader is using rather than off a second guess at it.
   */
  _crestPoint(out) {
    const p = this._heapPar;
    this.heap.frontPoint(this._heapNow, p, out);
    out.y += this.heap.crestHeight(this._heapNow, p) * 0.6;
    return out;
  }

  /** A breath of powder at the caster's feet as the slope lets go. */
  _muzzleFx() {
    const c = settings.avalanche;
    const g = settings.global;

    _pos.copy(this.origin).addScaledVector(this.direction, 0.6).setY(0.3);

    this.ctx.bursts.spawn(BurstMode.FROST, _pos, {
      radius: c.burstSize * 0.15,
      endRadius: c.burstSize * 0.5 * g.explosionIntensity,
      life: 0.55,
      intensity: c.burstIntensity * 0.6,
      opacity: 0.75,
      fresnel: 1.2,
      displace: 0.55,
      squash: 0.55,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.lightBoost = c.lightIntensity * 0.35 * g.explosionIntensity;
  }

  /**
   * Chunks thrown as one slab breaks the surface.
   * Called by `GrowthField` the frame an instance passes its `breachAt`.
   */
  _breachFx(position, radius) {
    const c = settings.avalanche;
    const g = settings.global;

    _pos.copy(position).setY(0.08);

    _emit.position = _pos;
    _emit.radius = radius * 0.7;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.6).setY(1).normalize();
    _emit.speed = c.chunkSpeed;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.7;
    _emit.life = c.chunkLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 7;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.chunks.emit(Math.round(c.breachChunks * g.particleCount), _emit);
  }

  /**
   * Powder off the front and spindrift off the crest.
   *
   * Both are emitted at the **heap's** front rather than at the base class's
   * cast front. The two agree while the flow is running and part company during
   * the runout, and the runout is precisely when it matters: the powder has to
   * come to rest with the snow, not sail on to the end of the line.
   *
   * @param {number} scale 0..1 — thinned once the deposit is only standing
   */
  _flowFx(dt, scale) {
    const c = settings.avalanche;
    const g = settings.global;
    const time = frame.uTime.value;

    const powderCount = Math.round(this.powderEmitter.tick(dt, c.powderRate * scale) * g.particleCount);
    if (powderCount > 0) {
      this._crestPoint(_pos);
      _emit.position = _pos;
      _emit.radius = c.heapWidth * 0.55;
      // Up and *forward*: a powder cloud is dragged along by the flow under it
      // and outruns the heap, which is why the leading edge of a real avalanche
      // is cloud and not snow.
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.65).setY(1).normalize();
      _emit.speed = c.powderSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = 0.95;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.9;
      _emit.sizeVariance = 0.5;
      _emit.life = c.powderLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0.35;
      _emit.tint = null;
      _emit.time = time;
      this.powder.emit(powderCount, _emit);
    }

    const driftCount = Math.round(this.driftEmitter.tick(dt, c.driftRate * scale) * g.particleCount);
    if (driftCount > 0) {
      // Spindrift is torn off the whole length of the crest behind the front,
      // not just off its nose — the tail of an avalanche smokes too.
      const s = randRange(0.15, 1);
      this._crestPoint(_pos);
      _pos.addScaledVector(this.direction, -(1 - s) * this.length * 0.35);
      _emit.position = _pos;
      _emit.radius = c.heapWidth * 0.7;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.35).setY(1).normalize();
      _emit.speed = c.driftSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 1.0;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.6;
      _emit.life = c.driftLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.drift.emit(driftCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.avalanche;

    this._heapNow += dt * this._throttle();

    this._syncUniforms();
    this.slabs.triggerUpTo(this.age, this.u, c.slabStagger, c.slabBias, false);
    this._syncFields();
    this._flowFx(dt, 1);

    // The light rides the crest, not the floor line under it.
    this._crestPoint(this.position);

    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.avalanche;
    const g = settings.global;
    const time = frame.uTime.value;

    this._landedAt = this.age;
    // Everything still buried shoulders up now, the terminal pile-up included.
    this.slabs.triggerUpTo(this.age, 1, c.slabStagger, c.slabBias, true);

    this.pointAt(1, _target);
    _pos.copy(_target).setY(0.5);

    /* the wall of thrown powder where the flow piles into itself */
    this.ctx.bursts.spawn(BurstMode.FROST, _pos, {
      radius: c.burstSize * 0.3,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.95,
      intensity: c.burstIntensity,
      opacity: 0.8,
      fresnel: 1.2,
      displace: 0.65,
      squash: 0.6,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring of blown snow across the floor */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _target, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.8,
      width: 0.06,
      intensity: 0.7,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* powder and blocks off the pile-up */
    _emit.position = _pos;
    _emit.radius = c.heapWidth * 0.7;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.4).setY(1).normalize();
    _emit.speed = c.powderSpeed * 2.4;
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 1.5;
    _emit.sizeVariance = 0.55;
    _emit.life = c.powderLifetime * 1.35;
    _emit.lifeVariance = 0.45;
    _emit.spin = 0.45;
    _emit.tint = null;
    _emit.time = time;
    this.powder.emit(Math.round(c.impactPowder * g.particleCount), _emit);

    _emit.radius = c.heapWidth * 0.45;
    _emit.speed = c.chunkSpeed * 2.1;
    _emit.size = 0.16;
    _emit.life = c.chunkLifetime * 1.3;
    _emit.spin = 10;
    this.chunks.emit(Math.round(c.impactChunks * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      14
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.8 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.avalanche;

    this._heapNow += dt * this._throttle();

    this._syncUniforms();
    this._syncFields();
    this._crestPoint(this.position);

    // The flow keeps smoking while it is still moving and stops when it stops:
    // the throttle *is* the emission scale, so the cloud dies with the runout
    // rather than on a second timer that has to be kept in step by hand.
    const moving = this._throttle();
    this._flowFx(dt, moving * 0.85 + (t <= 1 ? 0.15 : 0.05));
    this.ctx.shake.rumble(c.rumble * moving * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this.slabs.clear();
    this.heap.reset();
    this._heapNow = 0;
    this._landedAt = -1;
  }

  dispose() {
    this.slabs.dispose();
    this.heap.dispose();
    this.material.dispose();
    super.dispose();
  }
}
