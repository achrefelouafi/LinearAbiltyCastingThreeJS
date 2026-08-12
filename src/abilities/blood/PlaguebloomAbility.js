import { Vector3 } from 'three';
import { Ability } from '../Ability.js';
import { VolumeHull, HullShape, Medium } from '../../vfx/VolumeHull.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing } from '../../utils/math.js';

/**
 * The phase at which a blister lets go.
 *
 * `GroundField`'s PUSTULE shader bursts a cell over `smoothstep(0.76, 0.84)` of
 * its own cycle, so 0.80 is the middle of that ramp — the frame the skin is
 * actually open. Everything the CPU throws is keyed off this one number, and it
 * is a *constant* rather than a slider precisely because it is not a dimension:
 * it is the shader's own threshold, and a slider that could disagree with the
 * fragment code would be a slider that breaks the sync.
 */
const BURST_PHASE = 0.8;

/**
 * How far out, in cells, the CPU is prepared to walk the blister lattice.
 *
 * The lattice pitch is a live slider, so a footprint of twelve metres at eight
 * cells per metre is nearly two hundred cells across — thirty-eight thousand
 * hashes a frame for events the eye cannot separate anyway. Past this the CPU
 * simply stops looking; the *shader* still draws every blister out to the front,
 * so what is lost is only the puff of gas off the ones near the rim.
 */
const MAX_CELL_SPAN = 14;

/**
 * Vents allowed to fire in one frame.
 *
 * The real ceiling on I7 is the particle systems' own capacities, which recycle
 * oldest-first — but a frame that opened two hundred blisters at once would
 * flush every one of those buffers in a single go and the cloud would visibly
 * blink. Three per frame is 180 a second, which is more events than the eye
 * resolves and is what the capacities below are sized against.
 */
const MAX_VENTS_PER_FRAME = 3;

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ */
/* The two hashes, transcribed — and rounded to 32 bits at every step   */
/* ------------------------------------------------------------------ */
/**
 * **Every arithmetic step below goes through `Math.fround`, and that is not
 * fussiness — it is the difference between the trick working and not.**
 *
 * These are `shaders/lib/noise.glsl.js`'s `hash11` and `hash21`, which the
 * PUSTULE fragment shader uses to decide which blister is which and when it
 * bursts. The CPU has to reach the *same* answers or the puff of gas comes out
 * of the wrong hole at the wrong moment, and the whole ability is that it does
 * not.
 *
 * The first version transcribed them straight, in JS doubles, on the reasoning
 * that a hash is a hash and a 1e-7 difference could not matter. It matters
 * enormously. `hash11` is `fract(p·(p+33.33) · 2·…)`: by the last line `p` has
 * been amplified to around 2300, where one float32 ULP is already 1.2e-4, and
 * the value is then wrapped by `fract`. Any cell whose intermediate happens to
 * sit near an integer wraps on one side in `highp` and the other in a double.
 * Measured over a 25 × 25 patch of the lattice, **24 cells out of 625 came back
 * with a completely different id — up to a full unit apart** — and on those the
 * puff fires at an unrelated time. Two per cent of the field visibly out of
 * step is exactly the sort of thing the eye picks up and cannot name.
 *
 * Rounding through `fround` after every multiply, add and `fract` reproduces
 * GLSL `highp` exactly for this code: there are no multiply-adds for a compiler
 * to contract (`p *= p + 33.33` is add-then-multiply), and `fract` is defined as
 * `x - floor(x)` in both languages. The float32 literals are hoisted so the
 * constants are rounded once rather than 600 times a frame.
 *
 * An earlier attempt avoided all of this by hashing with `Math.sin`, which is
 * the usual JS trick and is simply *not what the shader does*: the puffs landed
 * in the right general area and on the wrong blisters, which reads as sloppy
 * particle placement rather than as a bug, and cost an afternoon.
 */
const f32 = Math.fround;
const K_1031 = f32(0.1031);
const K_1030 = f32(0.103);
const K_0973 = f32(0.0973);
const K_3333 = f32(33.33);
/** `gfCells`' id key: `dot(cell, vec2(31.7, 57.1))`. */
const K_ID_X = f32(31.7);
const K_ID_Y = f32(57.1);
/** `gfCells`' offset key: `dot(cell, vec2(7.13, 113.17))`. */
const K_OFF_X = f32(7.13);
const K_OFF_Y = f32(113.17);

/** `fract`, at 32 bits. */
const fract32 = (x) => f32(x - Math.floor(x));

/** `dot(vec2(x, y), vec2(ax, ay))`, at 32 bits. */
const dot2 = (x, y, ax, ay) => f32(f32(f32(x) * ax) + f32(f32(y) * ay));

/** `noise.glsl.js#hash11`, line for line, at 32 bits. */
function hash11(p) {
  p = fract32(f32(p * K_1031));
  p = f32(p * f32(p + K_3333));
  p = f32(p * f32(p + p));
  return fract32(p);
}

/** `hash21`'s two components, written here rather than returned in a pair (I3). */
let _h21x = 0;
let _h21y = 0;

/**
 * `noise.glsl.js#hash21`, line for line, at 32 bits. Writes `_h21x` / `_h21y`.
 *
 * This one amplifies far less than `hash11` — the intermediates top out around
 * a hundred rather than two thousand — so it would have survived being written
 * in doubles. It is rounded anyway, because "this hash needs it and that one
 * does not" is a distinction nobody will remember in six months.
 */
function hash21(p) {
  let x = fract32(f32(p * K_1031));
  let y = fract32(f32(p * K_1030));
  let z = fract32(f32(p * K_0973));
  // dot(p3, p3.yzx + 33.33)
  const d = f32(
    f32(f32(x * f32(y + K_3333)) + f32(y * f32(z + K_3333))) + f32(z * f32(x + K_3333))
  );
  x = f32(x + d);
  y = f32(y + d);
  z = f32(z + d);
  // fract((p3.xx + p3.yz) * p3.zy)
  _h21x = fract32(f32(f32(x + y) * z));
  _h21y = fract32(f32(f32(x + z) * y));
}

/* ------------------------------------------------------------------ */
/* Scratch — module scope (I3)                                         */
/* ------------------------------------------------------------------ */

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();

/** Filled from `settings.plaguebloom` every frame; never held between frames. */
const _pustule = groundFieldParams();
const _stain = groundFieldParams();

/**
 * PLAGUE BLOOM — a boiling cloud of gas over a circle of blistered ground.
 *
 * **The trick is the sync.** Two completely different renderers are drawing the
 * same cellular field. Above the floor, a `Medium.GAS_BOIL` `VolumeHull` marches
 * a lattice of bubbles that inflate, hold, then swell and thin — a pop — each on
 * its own clock. On the floor, a `GroundMode.PUSTULE` `GroundField` grows
 * blisters that inflate, hold, then burst into a crater — each on its own clock.
 * Run those two as separate effects and you have a green cloud sitting on some
 * green lumps. Run them as *one* field seen twice and the cloud acquires a floor
 * and the floor acquires a sky.
 *
 * So they are one field, and it is one number in three places:
 *
 *  - **pitch.** `gasBoilScale` is cells per metre. The cloud gets it directly;
 *    the floor gets `1 / gasBoilScale` as its cell size in metres. The two
 *    lattices have the same spacing at every moment, including while the slider
 *    is moving with the clock stopped.
 *  - **clock.** `gasBoilRate` is pops per second. It is the cloud's base rate
 *    and the floor's `speed`, and both modules multiply it by
 *    `global.noiseSpeed` on the way in, so slowing the sandbox down slows both
 *    by exactly the same factor.
 *  - **phase.** Both fields hash their cell to a 0..1 id and run
 *    `fract(t · rate · (0.55 + 0.9 · id) + …)` on `frame.uTime`. Same form, same
 *    clock, same seed. The cell *ids* cannot be literally identical — one field
 *    is a 2D Voronoi and the other a 3D warped lattice, and forcing them to
 *    share would mean editing a shared module every other ability also uses —
 *    but the distribution, the pitch and the rate are, which is what the eye is
 *    actually reading.
 *
 * And the floor quad is **never yawed with the cast**. It is the one ground
 * field in the project that ignores `this.direction`, because the cloud's boil
 * is sampled in *world* space: turn the floor and the two lattices slide out of
 * register, and "that blister burst and that bubble popped" becomes "some things
 * happened".
 *
 * **The bridge that makes it visible.** A raymarched pop and a shaded blister
 * are both events the eye can miss. So the CPU walks the same lattice, with the
 * same two hashes transcribed above, and asks each cell whether it crossed
 * `BURST_PHASE` this frame. Where one did, a puff of gas leaves the floor and a
 * few droplets are thrown — *at that cell's jittered site*, on that frame. That
 * is not decoration; it is the only thing in the cast that says out loud that
 * the two fields are the same field.
 *
 * Three beats, all of them slow:
 *
 *  1. **seep** (travel) — a `GroundMode.POOL` stain opens on the target ahead of
 *     the front and the first breath of gas creeps out of it.
 *  2. **boil** (impact, `lifetime` long) — the dome inflates, the blisters come
 *     up through the stain, and it stands there having events in it.
 *  3. **burst** (fade, `fadeTime` long) — the footprint is eaten back from its
 *     rim, and the dome climbs and spreads as it thins.
 *
 * Three draw calls: one raymarched dome, two ground quads. Everything else is
 * shared GPU particles.
 *
 * **The rule that makes the editor work.** A cast captures one dice roll
 * (`_seed`) and one timestamp (`_boilClock`, last frame's `frame.uTime`, which
 * is how the burst test knows what "this frame" means). Not one metre, radian,
 * second or colour. Pause with **P** mid-boil and drag `gasBoilScale`: the
 * bubbles in the cloud and the blisters on the floor re-pitch together, because
 * neither of them ever wrote the pitch down.
 */
export class PlaguebloomAbility extends Ability {
  constructor(context) {
    super('plaguebloom', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* ---- the stain, first because it is underneath everything ---- */
    // Alpha-blended, not additive: sick ground is *darker* than clean ground,
    // and an additive pool lights the flagstones it is supposed to be soaking.
    this.stain = new GroundField(this.group, {
      mode: GroundMode.POOL,
      additive: false,
      renderOrder: 5,
      name: 'Plaguebloom:Stain'
    });

    /* ---- the blisters ---- */
    this.pustules = new GroundField(this.group, {
      mode: GroundMode.PUSTULE,
      additive: false,
      renderOrder: 6,
      name: 'Plaguebloom:Pustules'
    });

    /* ---- the cloud ---- */
    // A DOME rather than a SPHERE because the gas sits *on* the floor: a sphere
    // would have to be half-buried to look right, and every ray that entered
    // through the buried half would spend its step budget under the ground.
    this.cloud = new VolumeHull({
      hull: HullShape.DOME,
      medium: Medium.GAS_BOIL,
      prefix: 'gas',
      maxSteps: 48,
      renderOrder: 12
    });
    this.group.add(this.cloud.mesh);

    /** The one dice roll a cast makes. Decorrelates two blooms. */
    this._seed = 0;
    /** Last frame's `frame.uTime`. A timestamp, not a duration — see the header. */
    this._boilClock = 0;
    /** Blisters the CPU is currently watching. HUD readout only. */
    this._cells = 0;
    /** Vents that fired this frame; drives the light punch. */
    this._vents = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    /**
     * The capacities below **are** the I7 guarantee, not a guess at one. A
     * particle system is a ring buffer: emitting past capacity recycles the
     * oldest slot, so 720 + 480 + 300 is a hard ceiling of 1500 live particles
     * for this cast no matter how far the vent sliders are pushed.
     */

    // The gas a blister lets go of. Non-additive, because it has to occlude the
    // cloud behind it or it is not gas, it is a glow.
    this.puffs = particles.get('plaguebloom.puff', {
      capacity: 720,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.9
    });
    this.puffs.uniforms.uDrag.value = 1.9;
    this.puffs.uniforms.uEndSize.value = 3.4;
    this.puffs.uniforms.uSizeIn.value = 0.1;
    this.puffs.uniforms.uFadeIn.value = 0.14;
    this.puffs.uniforms.uFadeOut.value = 0.35;

    // What comes out with it. Lit chips rather than additive dots: this is wet
    // matter, and the one thing it must not do is glow.
    this.spatter = particles.get('plaguebloom.spatter', {
      capacity: 480,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.2
    });
    this.spatter.uniforms.uDrag.value = 0.4;
    this.spatter.uniforms.uEndSize.value = 0.55;
    this.spatter.uniforms.uFadeOut.value = 0.62;

    // Spores lifting out of the cloud and dying at head height.
    this.spores = particles.get('plaguebloom.spore', {
      capacity: 300,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.5
    });
    this.spores.uniforms.uDrag.value = 1.5;
    this.spores.uniforms.uEndSize.value = 0.4;
    this.spores.uniforms.uSizeIn.value = 0.14;
    this.spores.uniforms.uFadeIn.value = 0.2;
    this.spores.uniforms.uFadeOut.value = 0.45;

    this.sporeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** Blisters inside the CPU's window. Not a draw count — the field is one quad. */
  get instanceCount() {
    return this._cells;
  }

  /** The bloom stands for a long time. That is the ability. */
  get impactDuration() {
    return Math.max(0.05, settings.plaguebloom.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.plaguebloom.fadeTime);
  }

  /**
   * A slow swell rather than a flicker.
   *
   * Nothing about this ability is fast, and the default shimmer's 9.3 Hz beat
   * makes the light read as electrical. One sine at `lightBreathSpeed` is the
   * cloud breathing; the pops arrive on top of it through `lightBoost`.
   */
  lightShimmer() {
    const c = settings.plaguebloom;
    return 1 + c.lightBreath * Math.sin(this.age * c.lightBreathSpeed * TAU);
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The footprint's centre: the aimed point, on the floor. */
  _footprint(out) {
    return this.pointAt(1, out);
  }

  /**
   * Metres between blisters — and between bubbles.
   *
   * `gasBoilScale` is authored as *cells per metre* because that is what the
   * volume's shader wants; the floor wants a pitch. One reciprocal, resolved
   * here, every frame. This function existing at all is the sync.
   */
  _cellPitch() {
    return 1 / Math.max(0.05, settings.plaguebloom.gasBoilScale);
  }

  /** Pops per second, after the global clock. Both fields are handed this. */
  _boilRate() {
    return settings.plaguebloom.gasBoilRate * settings.global.noiseSpeed;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.sporeEmitter.reset();
    this.stain.clearMarks();
    this.pustules.clearMarks();

    this._seed = Math.random() * 100;
    // Seeded to *now* so the first frame of a cast cannot discover four hundred
    // blisters that "burst" while the ability was sitting in the pool.
    this._boilClock = frame.uTime.value;
    this._cells = 0;
    this._vents = 0;

    this._sync(0, 0, 0);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings into all three surfaces.
   *
   * @param {number} seep     0..1 the stain spreading, during the travel beat
   * @param {number} boil     0..1 the dome inflated and the blisters up
   * @param {number} disperse 0..1 the whole thing letting go
   */
  _sync(seep, boil, disperse) {
    const c = settings.plaguebloom;
    const g = settings.global;

    this._footprint(_centre);

    // How far open the cloud is. The seep only ever buys it half, so the dome
    // still visibly inflates when the cast lands even if the travel was long.
    const open = Math.max(seep * 0.5, boil);
    const gone = Easing.inQuad(saturate(disperse));
    const density = (c.seepDensity * seep * (1 - boil) + boil) * (1 - gone);

    /* ---- the cloud ---- */
    const spread = c.cloudSpread * (0.5 + 0.5 * open) + c.disperseSpread * gone;
    const wide = Math.max(0.05, c.zoneRadius * spread);
    const tall = Math.max(0.05, c.cloudHeight * (0.28 + 0.72 * open));
    _pos.set(_centre.x, c.cloudLift + c.disperseLift * gone, _centre.z);
    this.cloud
      .place(_pos)
      .setSize(wide, tall, wide)
      .setFade(density)
      .sync(c, g);

    /* ---- the stain ---- */
    const stainGrow = Math.max(seep, boil);
    _stain.centre = _centre;
    // Deliberately world-aligned. See the class header: yaw the floor and the
    // lattice above it no longer lines up with the lattice below it.
    _stain.yaw = 0;
    _stain.height = c.stainHeight;
    _stain.radius = Math.max(0.05, c.zoneRadius * c.stainSpread);
    _stain.grow = stainGrow;
    _stain.recede = gone * c.stainRecede;
    _stain.seed = this._seed;
    _stain.edge = c.stainEdge;
    _stain.ragged = c.stainRagged;
    _stain.raggedScale = c.stainRaggedScale;
    _stain.warp = c.stainWarp;
    _stain.relief = c.stainRelief;
    _stain.normalStep = c.stainNormalStep;
    _stain.ambient = c.stainAmbient;
    _stain.wrap = c.stainWrap;
    _stain.specular = c.stainSpecular;
    _stain.gloss = c.stainGloss;
    _stain.parallax = c.stainParallax;
    _stain.cell = c.stainCell;
    _stain.thickness = c.stainThickness;
    _stain.lift = c.stainLift;
    _stain.depth = c.stainDepth;
    _stain.sharp = c.stainSharp;
    _stain.detail = c.stainDetail;
    _stain.speed = c.stainSpeed;
    _stain.flow = c.stainFlow;
    _stain.windAngle = c.stainWindAngle;
    _stain.additive = false;
    _stain.emissive = c.stainEmissive;
    _stain.opacity = c.stainOpacity;
    _stain.depthFade = c.stainDepthFade;
    _stain.fade = 1;
    _stain.colorBase = c.stainColorBase;
    _stain.colorEdge = c.stainColorEdge;
    _stain.colorGlow = c.stainColorGlow;
    _stain.colorDeep = c.stainColorDeep;
    _stain.noiseStrength = g.noiseStrength;
    _stain.noiseFrequency = g.noiseFrequency;
    _stain.noiseSpeed = g.noiseSpeed;
    _stain.opacityScale = g.opacity;
    this.stain.update(_stain);
    // At `grow` near zero the front sits at the origin and the ragged wander
    // still pushes a patch of the field inside it — a smear of pool under the
    // caster's aim before anything has happened. Hiding the quad outright is the
    // honest fix; feathering the front to nothing just moves the smear.
    this.stain.setVisible(stainGrow > 0.004);

    /* ---- the blisters ---- */
    _pustule.centre = _centre;
    _pustule.yaw = 0;
    _pustule.height = c.pustuleHeight;
    _pustule.radius = Math.max(0.05, c.zoneRadius);
    _pustule.grow = boil;
    _pustule.recede = gone;
    _pustule.seed = this._seed;
    _pustule.edge = c.pustuleEdge;
    _pustule.ragged = c.pustuleRagged;
    _pustule.raggedScale = c.pustuleRaggedScale;
    _pustule.warp = c.pustuleWarp;
    _pustule.relief = c.pustuleRelief;
    _pustule.normalStep = c.pustuleNormalStep;
    _pustule.ambient = c.pustuleAmbient;
    _pustule.wrap = c.pustuleWrap;
    _pustule.specular = c.pustuleSpecular;
    _pustule.gloss = c.pustuleGloss;
    _pustule.parallax = c.pustuleParallax;
    // The two shared numbers. Everything above this pair is the floor's own.
    _pustule.cell = this._cellPitch();
    _pustule.speed = c.gasBoilRate;
    _pustule.cellJitter = c.pustuleJitter;
    _pustule.seam = c.pustuleSeam;
    // PUSTULE ignores `thickness` in its height field; it survives only as one
    // of the terms that pads the quad out past the mark, and the seam is the
    // right scale for that.
    _pustule.thickness = c.pustuleSeam;
    _pustule.lift = c.pustuleLift;
    _pustule.depth = c.pustuleDepth;
    _pustule.sharp = c.pustuleSharp;
    _pustule.detail = c.pustuleDetail;
    _pustule.additive = false;
    _pustule.emissive = c.pustuleEmissive;
    _pustule.opacity = c.pustuleOpacity;
    _pustule.depthFade = c.pustuleDepthFade;
    _pustule.fade = 1;
    _pustule.colorBase = c.pustuleColorBase;
    _pustule.colorEdge = c.pustuleColorEdge;
    _pustule.colorGlow = c.pustuleColorGlow;
    _pustule.colorDeep = c.pustuleColorDeep;
    _pustule.noiseStrength = g.noiseStrength;
    _pustule.noiseFrequency = g.noiseFrequency;
    _pustule.noiseSpeed = g.noiseSpeed;
    _pustule.opacityScale = g.opacity;
    this.pustules.update(_pustule);
    this.pustules.setVisible(boil > 0.004);

    /* ---- the particle systems ---- */
    this.puffs.setGradient(
      getColor(c.colorPuffA),
      getColor(c.colorPuffB),
      getColor(c.colorPuffC),
      getColor(c.colorPuffD)
    );
    this.puffs.uniforms.uGravity.value.set(0, c.puffRise, 0);
    this.puffs.uniforms.uSizeScale.value = c.puffSize * g.particleSize;
    this.puffs.uniforms.uLifeScale.value = c.puffLifetime * 0.5 * g.particleLifetime;
    this.puffs.uniforms.uSpeedScale.value = c.puffSpeed * g.particleSpeed;
    this.puffs.uniforms.uOpacity.value = c.puffOpacity * g.opacity;
    this.puffs.uniforms.uTurbulence.value = c.puffTurbulence * g.turbulence;

    this.spatter.setGradient(
      getColor(c.colorSpatterA),
      getColor(c.colorSpatterB),
      getColor(c.colorSpatterC),
      getColor(c.colorSpatterD)
    );
    this.spatter.uniforms.uGravity.value.set(0, c.spatterGravity, 0);
    this.spatter.uniforms.uSizeScale.value = c.spatterSize * g.particleSize * 7;
    this.spatter.uniforms.uLifeScale.value = c.spatterLifetime * 0.5 * g.particleLifetime;
    // On the uniform rather than on the emit, so dragging the slider on a
    // paused frame re-speeds the droplets that are already in the air. `emit`
    // then hands over a unit speed and the gradient does the metres.
    this.spatter.uniforms.uSpeedScale.value = c.spatterSpeed * g.particleSpeed;
    this.spatter.uniforms.uOpacity.value = g.opacity;

    this.spores.setGradient(
      getColor(c.colorSporeA),
      getColor(c.colorSporeB),
      getColor(c.colorSporeC),
      getColor(c.colorSporeD)
    );
    this.spores.uniforms.uGravity.value.set(0, c.sporeRise, 0);
    this.spores.uniforms.uSizeScale.value = c.sporeSize * g.particleSize * 7;
    this.spores.uniforms.uLifeScale.value = c.sporeLifetime * 0.5 * g.particleLifetime;
    this.spores.uniforms.uSpeedScale.value = c.sporeSpeed * g.particleSpeed;
    this.spores.uniforms.uOpacity.value = g.opacity;
    this.spores.uniforms.uGlow.value = c.pustuleEmissive * g.glow;
    this.spores.uniforms.uTurbulence.value = c.sporeTurbulence * g.turbulence;
  }

  /* ------------------------------------------------------------------ */
  /* The bridge: the CPU walking the shader's own lattice                 */
  /* ------------------------------------------------------------------ */

  /**
   * Fire a vent wherever a blister crossed `BURST_PHASE` since the last frame.
   *
   * No per-cell state is kept and none is needed. A cell's raw phase is
   * `t · rate + bias`, strictly increasing, so it crossed `k + BURST_PHASE` in
   * this interval exactly when `floor(raw - BURST_PHASE)` stepped — one integer
   * compare per cell against last frame's timestamp, and a paused clock
   * (`now === prev`) therefore fires nothing at all, which is correct: a paused
   * blister has not burst.
   *
   * The cell walk mirrors `GroundField`'s `gfCells`: the jittered site of cell
   * `n` is `n + mix(0.5, hash21(dot(n, (7.13, 113.17))), jitter)` and its id is
   * `hash11(dot(n, (31.7, 57.1)))`. Because the offset is always inside the unit
   * cell, the nearest site to a site is itself — so evaluating the Voronoi *at*
   * the site is guaranteed to return that cell, and the CPU does not have to run
   * the 3×3 neighbourhood the shader does.
   *
   * @param {number} boil 0..1 — nothing vents before the blisters are up
   */
  _vent(boil) {
    this._vents = 0;
    this._cells = 0;

    const c = settings.plaguebloom;
    const g = settings.global;
    const now = frame.uTime.value;
    const prev = this._boilClock;
    // Advanced unconditionally, before either early exit. Leaving it behind
    // while the blisters are down means the frame they come up discovers every
    // burst that "happened" in the meantime and vents the whole field at once.
    this._boilClock = now;
    if (boil <= 0.02) return;
    if (!(now > prev)) return; //  a zero-length frame; nothing has happened

    const cell = this._cellPitch();
    const rateBase = this._boilRate();
    const jitter = c.pustuleJitter;
    const share = c.ventShare;
    // The blisters only exist inside the grown front, so neither does a vent.
    const radius = Math.max(0.05, c.zoneRadius) * boil;
    const radiusSq = (radius + cell) * (radius + cell);
    const span = Math.min(MAX_CELL_SPAN, Math.ceil(radius / cell) + 1);

    this._footprint(_centre);

    const puffCount = Math.max(0, Math.round(c.ventPuffs * g.particleCount));
    const spatterCount = Math.max(0, Math.round(c.ventSpatter * g.particleCount));
    const time = now;

    for (let j = -span; j <= span; j++) {
      for (let i = -span; i <= span; i++) {
        // Integer reject first: it is two multiplies against two hashes.
        const cx = i * cell;
        const cz = j * cell;
        if (cx * cx + cz * cz > radiusSq) continue;
        this._cells++;

        const id = hash11(dot2(i, j, K_ID_X, K_ID_Y));
        // Only the big ones vent. Reading the gate off the cell's own id rather
        // than off a die means the *same* blisters vent every cycle, which is
        // what makes the field read as terrain rather than as static.
        if (id > share) continue;

        const rate = rateBase * (0.55 + 0.9 * id);
        const bias = id * 7.13 + this._seed - BURST_PHASE;
        if (Math.floor(now * rate + bias) <= Math.floor(prev * rate + bias)) continue;

        // Past the frame's cap the walk keeps counting but stops emitting. The
        // alternative — breaking out of both loops — truncates `_cells`, and a
        // HUD readout that flickers with the vent rate is worse than useless.
        if (this._vents >= MAX_VENTS_PER_FRAME) continue;

        hash21(dot2(i, j, K_OFF_X, K_OFF_Y));
        const sx = (i + lerp(0.5, _h21x, jitter)) * cell;
        const sz = (j + lerp(0.5, _h21y, jitter)) * cell;
        if (sx * sx + sz * sz > radius * radius) continue;

        _pos.set(_centre.x + sx, c.pustuleLift * 0.5, _centre.z + sz);

        if (puffCount > 0) {
          _emit.position = _pos;
          _emit.radius = c.ventRadius;
          _emit.direction = _dir.set(0, 1, 0);
          _emit.speed = 1; //  metres/second live on uSpeedScale — see _sync()
          _emit.speedVariance = 0.6;
          _emit.spread = 0.75;
          _emit.inherit = null;
          _emit.anchor = null;
          _emit.size = 0.6;
          _emit.sizeVariance = 0.5;
          _emit.life = c.puffLifetime;
          _emit.lifeVariance = 0.45;
          _emit.spin = 0.25;
          _emit.tint = null;
          _emit.time = time;
          this.puffs.emit(puffCount, _emit);
        }

        if (spatterCount > 0) {
          _emit.position = _pos;
          _emit.radius = c.ventRadius * 0.4;
          _emit.direction = _dir.set(0, 1, 0);
          _emit.speed = 1; //  ... and the same for the droplets
          _emit.speedVariance = 0.8;
          _emit.spread = 0.85;
          _emit.inherit = null;
          _emit.anchor = null;
          _emit.size = 0.12;
          _emit.sizeVariance = 0.7;
          _emit.life = c.spatterLifetime;
          _emit.lifeVariance = 0.5;
          _emit.spin = 9;
          _emit.tint = null;
          _emit.time = time;
          this.spatter.emit(spatterCount, _emit);
        }

        this._vents++;
      }
    }

    this.lightBoost = Math.min(this.lightBoost + this._vents * c.ventLight, c.lightIntensity);
  }

  /** The spores lifting out of the standing cloud. */
  _sporeFx(dt, boil) {
    const c = settings.plaguebloom;
    const g = settings.global;
    const count = Math.round(this.sporeEmitter.tick(dt, c.sporeRate * boil) * g.particleCount);
    if (count <= 0) return;

    this._footprint(_centre);
    _pos.set(_centre.x, c.cloudHeight * c.sporeCeiling * 0.5, _centre.z);

    _emit.position = _pos;
    _emit.radius = c.zoneRadius * c.sporeSpread;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 1; //  ... and the spores
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sporeLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.spores.emit(count, _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(_dt) {
    const c = settings.plaguebloom;
    this._sync(this.u, 0, 0);
    // The light rides the front on its way out, at head height rather than on
    // the floor — a cloud lights from inside itself.
    this.position.y = c.lightHeight;
    // The clock still has to be walked forward or the first frame of the boil
    // discovers every burst that happened during the travel all at once.
    this._boilClock = frame.uTime.value;
  }

  onImpact() {
    // Deliberately nothing loud. There is no shockwave, no flash and no shake in
    // this ability: it is a disease, and the moment it lands should be quieter
    // than the moment it starts working. The bloom's whole read is the six
    // seconds after this.
    this._boilClock = frame.uTime.value;
  }

  /**
   * @param {number} dt seconds
   * @param {number} t  0..1 through the boil, then 1..2 through the disperse
   */
  onFade(dt, t) {
    const c = settings.plaguebloom;
    const held = t <= 1;

    // Inflation is measured in *seconds* against `riseTime`, not as a fraction
    // of the impact phase: dragging `lifetime` from two seconds to twelve should
    // make the bloom last longer, not make it inflate six times more slowly.
    const boil = held
      ? Easing.outQuad(saturate((t * this.impactDuration) / Math.max(0.01, c.riseTime)))
      : 1;
    const disperse = held ? 0 : Math.pow(saturate(t - 1), Math.max(0.05, c.disperseCurve));

    this._sync(1, boil, disperse);
    this._vent(boil * (1 - disperse));
    this._sporeFx(dt, boil * (1 - disperse));

    this._footprint(this.position);
    this.position.y = c.lightHeight;
  }

  onDestroy() {
    this.cloud.setFade(0);
    this.stain.setVisible(false);
    this.pustules.setVisible(false);
    this._cells = 0;
    this._vents = 0;
  }

  dispose() {
    this.cloud.dispose();
    this.stain.dispose();
    this.pustules.dispose();
    super.dispose();
  }
}
