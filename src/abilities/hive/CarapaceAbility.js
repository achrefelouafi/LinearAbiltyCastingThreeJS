import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { PlateShell, plateShellParams } from '../../vfx/Colony.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, Easing, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;

/**
 * Hard ceiling on plates. The `sites` slider clamps here, and the vertex buffer
 * is sized for exactly this many at construction so the two can never disagree.
 */
const MAX_PLATES = 96;

/**
 * Landing plates a single frame is allowed to throw chips for.
 *
 * Normally one or two: the stagger is fourteen milliseconds and a frame is
 * sixteen. It matters when a *slider* moves the clock instead — dragging
 * `stagger` down on a paused frame can advance the landing front past thirty
 * plates at once, and thirty simultaneous chip bursts is a gravel explosion out
 * of nowhere. Capped, it is a handful of chips and the front catches up over
 * the next few frames, which is what it looks like anyway.
 */
const CHIP_BATCH = 4;

/* --- module-scope scratch. Nothing below allocates during a cast (I3) --- */
const _shell = plateShellParams();
const _apron = groundFieldParams();
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _plate = new Vector3();

/**
 * CARAPACE — a dome of chitin plates that closes with no gaps.
 *
 * **THE TRICK — one tessellation, so the seams are exact.** Every plate is a
 * cell of a *single* spherical Voronoi diagram over a jittered Fibonacci
 * hemisphere. Two points on a unit sphere are equidistant from a third exactly
 * when that third lies on the plane through the **origin** whose normal is
 * their difference — the `|x|²` terms cancel because both sites are unit
 * vectors — so a cell is an intersection of half-spaces through the origin and
 * can be cut by ordinary polygon clipping. The consequence is the whole
 * ability: the edge cell *i* gets from the bisector of *i* and *j* lies in the
 * same plane cell *j* gets from bisecting *j* and *i*, and both cut it with the
 * same third bisector, so two plates that meet at a seam are solving the same
 * equation and share their boundary vertices to the last bit of the arithmetic
 * that produced them. The dome closes with no gaps and no overlaps, at any
 * `sites`, at any `jitter`, on the frame you drag either of them.
 *
 * That exactness is not decoration. The floor is lit and there is a light
 * *inside* this dome, and the eye finds a sliver of daylight between two plates
 * instantly — a noise-perturbed or rejection-sampled plate layout, which is
 * what the first attempt at this slot was, leaves one on nearly every seam and
 * reads as damage rather than as armour.
 *
 * **Nothing the fly-in does can leave a plate off the tessellation.** Every
 * term of the arrival — the outward offset, the spin about the plate's own
 * axis, the tip off the dome — is multiplied by `k = 1 − ease`, which is
 * exactly zero once the plate has landed. No easing curve and no overshoot can
 * be tuned into a gap.
 *
 * Three beats:
 *
 *   1. **summon** — a front runs out to the footprint, throwing amber motes.
 *   2. **close** — plates arrive from outside and lock, from the ground up
 *      (`orderScatter`), each one flashing and knocking chips off its
 *      neighbours as it seats. The chips are fired at the plate that is
 *      landing *this frame*, read back out of the tessellation by index, so
 *      they come off the seam that is actually closing.
 *   3. **open** — and this is the beat that proves the claim. The dome does not
 *      shatter: `seam` climbs, every plate is drawn in toward its own centre by
 *      the same fraction of the unit sphere, and the gaps that appear are the
 *      Voronoi edges themselves, lit from inside by the light the dome has been
 *      hiding. Then it retracts and is gone.
 *
 * **The rule that makes the editor work.** A cast captures one number — the
 * tessellation seed — and the timestamps of its beats. The dome's own radius is
 * `zoneRadius`, which is what the aim circle measured, and `domeHeight` is the
 * only thing that makes it a dome rather than a hemisphere. Every metre,
 * radian and second is resolved from `settings.carapace` inside the update
 * loop, zero-length frames included: pause with **P** mid-close and drag
 * `sites` and the clipper re-cuts the whole dome under the plates that have
 * already landed.
 *
 * Two draw calls: the shell, and the apron of floor plate it grows out of.
 */
export class CarapaceAbility extends Ability {
  constructor(context) {
    super('carapace', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * The dome. One draw call however many plates, because the vertex layout is
     * fixed at `2 + 6 × 12` slots per plate whatever its real side count —
     * padding slots collapse onto the last real vertex and draw as zero-area
     * triangles — which is what lets the index buffer be written once at
     * construction and never touched again.
     */
    this.shell = new PlateShell(this.group, {
      capacity: MAX_PLATES,
      renderOrder: 2,
      castShadow: true,
      receiveShadow: true
    });

    /**
     * The apron: the floor the dome grows out of, in the same interlocking
     * plate vocabulary. Shaded rather than additive, because chitin laid over
     * stone has to be able to be *darker* than the stone, and an additive mark
     * can only ever brighten. Without it the dome sits on the floor like a prop
     * on a table; with it, the two are the same animal.
     */
    this.apron = new GroundField(this.group, {
      mode: GroundMode.PLATE,
      additive: false,
      name: 'CarapaceApron'
    });

    /* --- what a cast captures: one dice roll and some timestamps --- */
    /** The tessellation seed. Two casts must not cut the same dome. */
    this._seed = 0;
    /** One-way. A slider drag must not be able to re-fire the opening. */
    this._opened = false;
    /** Index of the last plate that has been given its landing chips. */
    this._landed = 0;
    /** HUD readout only. */
    this._live = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Chips knocked off a seam as a plate seats. Lit and non-additive: this is
    // the one thing in the ability made of matter rather than of light.
    this.chips = particles.get('carapace.chips', {
      capacity: 1400,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.chips.uniforms.uDrag.value = 0.4;
    this.chips.uniforms.uEndSize.value = 0.75;
    this.chips.uniforms.uFadeOut.value = 0.65;

    // Dust pushed out from under the rim as the dome grounds out.
    this.dust = particles.get('carapace.dust', {
      capacity: 1600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.dust.uniforms.uDrag.value = 2.0;
    this.dust.uniforms.uEndSize.value = 3.0;
    this.dust.uniforms.uSizeIn.value = 0.14;
    this.dust.uniforms.uFadeIn.value = 0.2;
    this.dust.uniforms.uFadeOut.value = 0.32;

    // Amber motes leaking out of the seams. Additive, and the only reason the
    // closed dome does not read as a solid lump: something is in there.
    this.motes = particles.get('carapace.motes', {
      capacity: 1800,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.6;
    this.motes.uniforms.uEndSize.value = 0.16;
    this.motes.uniforms.uSizeIn.value = 0.07;
    this.motes.uniforms.uFadeIn.value = 0.09;
    this.motes.uniforms.uFadeOut.value = 0.4;

    this.dustEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing — every beat resolved from settings, every frame              */
  /* ------------------------------------------------------------------ */

  /** A beat's length in seconds, under the global lifetime knob. */
  _span(seconds) {
    return Math.max(0.01, seconds * settings.global.lifetime);
  }

  /**
   * Seconds the dome takes to close, from the live plate count.
   *
   * Derived rather than authored, because the alternative — a `buildTime`
   * slider next to `stagger` and `lockTime` — is two numbers that describe the
   * same thing and disagree the moment either moves. Dragging `stagger` here
   * lengthens the impact phase to match on the same frame.
   */
  _buildSpan() {
    const c = settings.carapace;
    const plates = Math.max(1, this.shell.plates);
    return this._span((plates - 1) * c.stagger + c.lockTime);
  }

  get impactDuration() {
    return this._buildSpan() + this._span(settings.carapace.holdTime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.carapace.fadeTime);
  }

  get instanceCount() {
    return this._live;
  }

  /**
   * Something in the dome breathes.
   *
   * A quantised flicker was tried first and read as a fire inside a shell,
   * which is the wrong idea — the light is a *living thing*, and the slow
   * cosine is what makes the closed dome look occupied rather than lit.
   */
  lightShimmer() {
    const c = settings.carapace;
    return 1 - saturate(c.lightPulse) * 0.5 * (1 - Math.cos(this.age * c.lightPulseSpeed));
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The live footprint, metres. What the aim circle measured out. */
  get radius() {
    return Math.max(0.2, settings.carapace.zoneRadius);
  }

  /** The dome's crown height, metres. */
  get domeRise() {
    return this.radius * Math.max(0.05, settings.carapace.domeHeight);
  }

  /** Where the dome stands: the far end of the aimed line, on the floor. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** Seconds since the front arrived. Zero while it is still on its way. */
  _sinceLand() {
    return this.phase === AbilityPhase.TRAVEL ? 0 : this.impactTime + this.fadeTime;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.dustEmitter.reset();
    this.moteEmitter.reset();

    this._opened = false;
    this._landed = 0;

    // The only thing a cast captures. Unitless: it seeds the Fibonacci phase
    // and the per-plate dice, and nothing else.
    this._seed = Math.random() * 100;

    this.apron.setVisible(true);
    this._sync(1, 0);
    this._castFx();
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve the dome, the apron and the three particle systems from live
   * settings.
   *
   * The dome is synced whether or not it has started to close, for the reason
   * every ability in this project syncs its hidden pieces: drag `sites` while
   * the front is still travelling and the dome that arrives must be the one you
   * chose, not the one that was current when the cast left the hand.
   *
   * @param {number} fade 1 while the dome stands, ramping to 0 as it goes
   * @param {number} open 0..1 how far the seams have come apart
   */
  _sync(fade, open) {
    const c = settings.carapace;
    const g = settings.global;
    const p = _shell;
    const now = this._sinceLand();
    const radius = this.radius;

    this._centrePoint(_centre);

    /* ---------------- the tessellation ---------------- */
    // Only these three re-run the clipper, and `PlateShell` compares them field
    // by field rather than hashing a string, so a frame that changes nothing
    // costs three comparisons.
    p.sites = clamp(Math.round(c.sites), 12, MAX_PLATES);
    p.seed = this._seed;
    p.jitter = Math.max(0, c.jitter * g.randomness);

    /* ---------------- the metres ---------------- */
    // The footprint is the aim circle, in both lateral axes. That sharing is
    // the design: what the player drew on the floor is what the dome covers.
    p.radiusX = radius;
    p.radiusZ = radius;
    p.radiusY = this.domeRise;
    p.thickness = c.thickness;
    // The seams open along the tessellation as the dome lets go. This is the
    // whole exit: no shatter, no debris — the plates simply stop touching.
    p.seam = c.seam + c.openSeam * open;
    p.flyOut = c.flyOut;
    p.tumbleSpin = c.tumbleSpin;
    p.tumbleSwing = c.tumbleSwing;

    /* ---------------- the clock ---------------- */
    // Scaled by the global lifetime here *and* in `_buildSpan()`, from the same
    // two keys, so the phase and the animation cannot drift apart.
    p.stagger = c.stagger * g.lifetime;
    p.lockTime = c.lockTime * g.lifetime;
    p.orderScatter = c.orderScatter;
    // Held at full size and then withdrawn late: `openRetract` above 1 keeps the
    // dome its own size while the seams are doing the talking.
    p.retract = 1 - Math.pow(saturate(open), Math.max(0.2, c.openRetract));

    /* ---------------- the look ---------------- */
    p.tintHeight = c.tintHeight;
    p.tintJitter = c.tintJitter * g.randomness;
    p.wrap = c.wrap;
    p.rimPow = c.rimPow;
    p.rimGain = c.rimGain;
    p.sheenPow = c.sheenPow;
    p.sheenGain = c.sheenGain;
    // The gaps are lit from inside, and they get brighter as they widen — which
    // is the only honest way to say "there is something in here".
    p.seamGlow = c.seamGlow * (1 + c.openSpill * open) * g.shaderIntensity;
    p.arriveGain = c.arriveGain;
    p.glow = c.glow * fade * g.glow;
    p.plateA = c.colorPlateA;
    p.plateB = c.colorPlateB;
    p.plateC = c.colorPlateC;
    p.plateD = c.colorPlateD;
    p.rimColor = c.colorRim;
    p.sheenColor = c.colorSheen;
    p.seamColor = c.colorSeam;
    p.arriveColor = c.colorArrive;

    this.shell.setPlacement(_centre, this.direction);
    this.shell.update(now, p);

    /* ---------------- the apron ---------------- */
    const a = _apron;
    a.centre = _centre;
    // The quad carries the caster's heading, so the plate grain runs downrange
    // and the relief lights from the same side the dome does.
    a.yaw = Math.atan2(this.direction.x, this.direction.z);
    a.height = c.apronHeight;
    a.radius = radius * c.apronRadius;
    // The apron spreads with the dome rather than ahead of it, so the floor and
    // the shell are one event. Recede takes it back out from the rim inward.
    a.grow = this.shell.progress(now, p);
    a.recede = Easing.inQuad(saturate(open));
    a.fade = fade;
    a.seed = this._seed;
    a.edge = c.apronEdge;
    a.ragged = c.apronRagged;
    a.raggedScale = c.apronRaggedScale;
    a.warp = c.apronWarp;
    a.relief = c.apronRelief;
    a.ambient = c.apronAmbient;
    a.wrap = c.apronWrap;
    a.specular = c.apronSpecular;
    a.gloss = c.apronGloss;
    a.cell = c.apronCell;
    a.cellJitter = c.apronCellJitter;
    a.seam = c.apronSeam;
    a.thickness = c.apronThickness;
    a.lift = c.apronLift;
    a.additive = false;
    a.emissive = c.apronEmissive * g.shaderIntensity;
    a.opacity = c.apronOpacity;
    a.depthFade = c.apronDepthFade;
    a.colorBase = c.colorApronBase;
    a.colorEdge = c.colorApronEdge;
    a.colorGlow = c.colorApronGlow;
    a.colorDeep = c.colorApronDeep;
    a.noiseStrength = g.noiseStrength;
    a.noiseFrequency = g.noiseFrequency;
    a.noiseSpeed = g.noiseSpeed;
    a.opacityScale = g.opacity;
    this.apron.update(a);

    this._live = this.shell.count;

    this._syncParticles();
  }

  /** The three particle systems, re-coloured and re-scaled every frame. */
  _syncParticles() {
    const c = settings.carapace;
    const g = settings.global;

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
    this.dust.uniforms.uTurbulence.value = 0.35 * g.turbulence;

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
    this.motes.uniforms.uGlow.value = 1.15 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** A breath of motes at the caster as the summons goes out. */
  _castFx() {
    const c = settings.carapace;
    const g = settings.global;

    _pos.copy(this.origin).addScaledVector(this.direction, 0.6);
    _pos.y = 1.2;

    _emit.position = _pos;
    _emit.radius = 0.16;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.moteSpeed * 4;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.6;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.09;
    _emit.sizeVariance = 0.6;
    _emit.life = c.moteLifetime * 0.7;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(Math.round(22 * g.particleCount), _emit);

    this.lightBoost = c.lightIntensity * 0.3 * g.explosionIntensity;
  }

  /**
   * Chips off the plate that is landing *this* frame.
   *
   * The landing front is `PlateShell#progress()` — the same clock the vertex
   * shader eases each plate on — turned into an index, and the plate's own
   * locked centre is read back out of the tessellation rather than guessed at
   * from a bearing. So the chips come off the seam that is actually closing,
   * and they keep doing so when `sites`, `jitter` or `zoneRadius` move.
   *
   * The first version emitted from a random point on the dome at a fixed rate.
   * It looked fine in a still and wrong in motion, because the sparkle was
   * uncorrelated with the plates arriving — which is the only event on screen.
   */
  _landingFx(progress) {
    const c = settings.carapace;
    const g = settings.global;
    const plates = this.shell.plates;
    if (plates <= 0) return;

    const front = Math.floor(saturate(progress) * plates);
    const per = Math.round(c.chipLand * g.particleCount);
    let budget = CHIP_BATCH;

    while (this._landed < front && budget-- > 0) {
      const index = this._landed++;
      if (per <= 0) continue;

      this.shell.plateCentre(index, _shell, _plate);

      _emit.position = _plate;
      _emit.radius = 0.12;
      // Outward along the dome's own normal at that plate: a chip flicks off
      // the face it was struck against, not upward.
      _emit.direction = _dir.copy(_plate).sub(_centre).normalize();
      _emit.speed = c.chipSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.7;
      _emit.life = c.chipLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 9;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.chips.emit(per, _emit);
    }
  }

  /**
   * What the dome sheds while it stands: dust from under the rim, motes out of
   * the seams.
   *
   * @param {number} dt
   * @param {number} scale 0..1 — thinned as the dome goes
   * @param {number} open  0..1 — wider seams leak more
   */
  _domeFx(dt, scale, open) {
    const c = settings.carapace;
    const g = settings.global;
    const time = frame.uTime.value;
    const radius = this.radius;

    const dustCount = Math.round(this.dustEmitter.tick(dt, c.dustRate * scale) * g.particleCount);
    if (dustCount > 0) {
      // On the rim, on the floor: the dust is the dome pushing air out from
      // under itself, so it belongs at the ground line and nowhere else.
      const a = Math.random() * TAU;
      _pos.set(_centre.x + Math.cos(a) * radius, 0.08, _centre.z + Math.sin(a) * radius);
      _emit.position = _pos;
      _emit.radius = radius * 0.14;
      _emit.direction = _dir.set(Math.cos(a), 0.35, Math.sin(a)).normalize();
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.7;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.9;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.tint = null;
      _emit.time = time;
      this.dust.emit(dustCount, _emit);
    }

    // Leakage scales with the gaps: a sealed dome is nearly tight, and an open
    // one is pouring. `1 +` rather than `open` alone so the closed dome still
    // has something coming out of it.
    const leak = scale * (1 + c.openSpill * 0.35 * open);
    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * leak) * g.particleCount);
    if (moteCount > 0) {
      // On the shell itself, at a random height — the motes come out through
      // the seams, which are everywhere on it.
      const a = Math.random() * TAU;
      const h = Math.random();
      const r = radius * Math.sqrt(Math.max(0, 1 - h * h));
      _pos.set(_centre.x + Math.cos(a) * r, this.domeRise * h, _centre.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = radius * 0.08;
      _emit.direction = _dir.set(Math.cos(a) * 0.5, 1, Math.sin(a) * 0.5).normalize();
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.9;
      _emit.size = 0.06;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }
  }

  /** The first ring of plates bites: dust, a ring, fractures under the rim. */
  _sealFx() {
    const c = settings.carapace;
    const g = settings.global;
    const radius = this.radius;

    this._centrePoint(_centre);

    _pos.copy(_centre).setY(this.domeRise * 0.35);
    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.7,
      intensity: c.burstIntensity,
      opacity: 0.7,
      fresnel: 1.3,
      displace: 0.55,
      squash: 0.75,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _centre, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.6,
      width: 0.06,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    // Fractures under the rim: the floor takes the weight of the dome landing
    // on it, and this is what outlives the cast.
    this.ctx.decals.spawn(DecalType.CRACK, _centre, {
      radius: c.crackRadius,
      life: c.crackLife,
      intensity: c.crackIntensity,
      width: 0.5,
      colorA: getColor(c.colorCrackDeep),
      colorB: getColor(c.colorCrack)
    });

    _emit.position = _centre;
    _emit.radius = radius * 0.9;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dustSpeed * 3;
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 1.4;
    _emit.sizeVariance = 0.5;
    _emit.life = c.dustLifetime * 1.3;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.4;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.dust.emit(Math.round(40 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      20
    );
    this.ctx.flash.trigger(getColor(c.colorSealFlash), c.sealFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.9 * g.explosionIntensity;
  }

  /** The dome lets go: chips off every seam at once, and the light escapes. */
  _openFx() {
    const c = settings.carapace;
    const g = settings.global;
    const radius = this.radius;

    this._centrePoint(_centre);

    _emit.position = _centre;
    _emit.radius = radius * 0.8;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.chipSpeed * 1.5;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.11;
    _emit.sizeVariance = 0.8;
    _emit.life = c.chipLifetime * 1.5;
    _emit.lifeVariance = 0.6;
    _emit.spin = 11;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.chips.emit(Math.round(c.openChips * g.particleCount), _emit);

    _emit.radius = radius * 0.5;
    _emit.speed = c.moteSpeed * 3.5;
    _emit.spread = 0.8;
    _emit.size = 0.08;
    _emit.life = c.moteLifetime * 1.4;
    _emit.spin = 0;
    this.motes.emit(Math.round(70 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorOpenFlash), c.openFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * c.lightSpill * 0.4 * g.explosionIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1, 0);

    // A few motes run out ahead of the front, so the footprint is announced
    // before anything lands on it. Jittered off the line so they do not read as
    // a dotted trail.
    const c = settings.carapace;
    const g = settings.global;
    const count = Math.round(this.moteEmitter.tick(dt, c.moteRate * 0.4) * g.particleCount);
    if (count > 0) {
      this.pointAt(Math.max(0.05, this.u), _pos);
      _pos.y = randRange(0.1, 0.7);
      _emit.position = _pos;
      _emit.radius = 0.35;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.05;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime * 0.8;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.motes.emit(count, _emit);
    }

    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    this._landed = 0;
    this._sealFx();
    this._centrePoint(this.position);
    this.position.y = this.domeRise * settings.carapace.lightHeight;
  }

  onFade(dt, t) {
    const c = settings.carapace;
    // `t` runs 0..1 through the close and the hold, then 1..2 as the seams
    // open. Cubic on the way out so the dome holds together and then lets go.
    const open = saturate(t - 1);
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(open) * 0.85;

    if (!this._opened && open > 0) {
      this._opened = true;
      this._openFx();
    }

    this._sync(fade, open);

    const progress = this.shell.progress(this._sinceLand(), _shell);
    this._landingFx(progress);
    this._domeFx(dt, fade, open);

    // The light hangs inside the dome and climbs as the seams widen — it is
    // getting out, and the shell is what was holding it in.
    this._centrePoint(this.position);
    this.position.y = this.domeRise * saturate(c.lightHeight);
    this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.12 * c.lightSpill * open);

    // Still rumbling while plates are landing, and nothing after that.
    if (progress < 1) this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._opened = false;
    this._landed = 0;
    this._live = 0;
    this.shell.reset();
    this.apron.setVisible(false);
  }

  dispose() {
    this.shell.dispose();
    this.apron.dispose();
    super.dispose();
  }
}
