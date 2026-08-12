import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { LatticeGrowth, latticeGrowthParams } from '../../vfx/Colony.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, Easing, hash11 } from '../../utils/math.js';

/**
 * Hard ceiling on comb cells. The editor's `cells` slider clamps here, and the
 * instance buffers are sized for exactly this many at construction.
 */
const MAX_CELLS = 240;

/**
 * How many freshly-landed cells may be given their own puff of wax on a single
 * frame.
 *
 * This is a *catch-up* cap, not a rate limit. At the shipped `stagger` roughly
 * one cell lands per frame and the loop never sees more than two; the cap only
 * bites when the clock jumps — the first frame after `stagger` is dragged from
 * 0.06 to 0.002, say — where firing a hundred and sixty puffs in one frame
 * would blow the particle budget on a single frame for no visible gain, since
 * they would all be born on the same timestamp and read as one flash.
 */
const MAX_LANDINGS_PER_FRAME = 6;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _hand = new Vector3();

/**
 * HIVE COLUMN — a tower of comb that is legibly *constructed*.
 *
 * Four beats:
 *
 *   1. **travel** — a scent runner races out along the aimed line to the circle,
 *      dragging dry dust off the floor behind it. Nothing of the tower exists
 *      yet.
 *   2. **build** — the first half of the impact phase. One seed cell is laid at
 *      the centre and the colony works outward from it on a stagger, cell by
 *      cell, climbing into layers as the skirt fills. A mat of wax charges
 *      across the floor underneath, its own front stepping from hex to hex.
 *   3. **hold** — the tower stands, the recesses lit, wax motes coming off it.
 *   4. **collapse** — the fade. `retract` winds back to zero and the whole
 *      structure withdraws into the floor in the order it was built, throwing
 *      the chips it was made of.
 *
 * **THE TRICK — growth on a real lattice, and the refusals that shape it.**
 * There is no hex grid here and nothing is filled by radius. Each cell carries
 * *its own* lattice frame, inherited from its parent and turned by up to
 * `drift` of a turn; a child buds one lattice unit along one of its parent's six
 * directions, so locally the packing is exact and three cells in a row read as
 * masonry. Two branches that left the seed around opposite sides of a void come
 * back at each other out of register — the candidate lands within `refuse` of
 * something already standing and is **thrown away**. That refusal is what puts
 * the seams, the interior voids and the ragged perimeter there, and none of them
 * is a noise function. `vfx/Colony.js#LatticeGrowth` owns the growth; this file
 * owns the beats, the palette and the feedback.
 *
 * **What this ability adds on top of the module: the build is *audible*.** The
 * first version let the comb rise silently and it read as a mesh being scaled —
 * the staggered landing was there in the shader and nobody could see it, because
 * a cell arriving is a two-frame event and the eye needs an edge to catch. So
 * the CPU re-derives *which* cells have landed each frame — `floor((combAge −
 * growTime·0.55) / stagger)`, resolved from live settings, never accumulated —
 * and every newly landed cell throws its own puff of wax and, sometimes, a chip.
 * Because the landing order is the colony's **breadth-first growth order** and
 * not a radius, you watch the lobes fill and you watch a hole get skipped. That
 * is the refusal, made visible, without the CPU knowing anything about the
 * structure.
 *
 * The wax mat's front is not an independent animation either. `_reachUnits` is
 * the largest **lattice radius** any landed cell has reached — unitless, so it
 * is a legal thing for a cast to hold — and the mat's `grow` is that number
 * times the live `pitch` over the live mat radius. Drag `pitch` on a paused
 * frame and the comb and the mat re-scale together, because they are reading the
 * same measurement.
 *
 * **The rule that makes the editor work.** A cast captures three things and all
 * three are unitless: the growth seed, the count of landings already given
 * feedback, and that lattice reach. Every metre, radian and second — the pitch,
 * the cell height, the layer spacing, the stagger, the mat's trace width, the
 * light's height above the tower — is resolved against `settings.hivecolumn`
 * inside the update loop, on a zero-length frame included. Pause with **P**
 * mid-build and drag `drift`: the colony regrows from the same seed with a
 * different history, and the perimeter changes shape while the clock is stopped.
 *
 * Two draw calls for the structure — the comb and the mat — plus three particle
 * systems.
 */
export class HivecolumnAbility extends Ability {
  constructor(context) {
    super('hivecolumn', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /*
     * `recess` is pushed past the module's default: a shallow cell reads as a
     * tiled floor stood on its end, and what says *hive* is the rim being dark
     * against a hole with something glowing at the bottom of it. `wall` stays at
     * the default — thicker and the tower turns into a block of cheese.
     */
    this.comb = new LatticeGrowth(this.group, {
      capacity: MAX_CELLS,
      sides: 6,
      wall: 0.24,
      recess: 0.66,
      renderOrder: 2
    });

    /** Live lattice params, allocated once. Refilled from settings every frame. */
    this.lattice = latticeGrowthParams();

    /*
     * The wax the tower is seated on. LATTICE rather than PLATE or POOL because
     * its front crosses the *lattice* rather than the field — a cell on the floor
     * lights when the front reaches that cell's own centre — which is the same
     * idea as the comb above it, one dimension down. A POOL under a hex tower
     * looked like the tower had been dropped in a puddle.
     */
    this.mat = new GroundField(this.group, {
      mode: GroundMode.LATTICE,
      additive: false,
      renderOrder: 6,
      name: 'HiveWaxMat'
    });

    /** Live ground params, allocated once. `centre` is ours, written in place. */
    this.matParams = groundFieldParams();
    this.matParams.centre = new Vector3();

    /** Casts so far, mod a power of two. Only ever used to roll a seed. */
    this._casts = 0;
    /** The growth's dice. Unitless, re-rolled per cast. */
    this._seed = 0;
    /** How many landings have already been given feedback. An event ledger. */
    this._landed = 0;
    /** Largest lattice radius reached by a landed cell. Unitless — see the header. */
    this._reachUnits = 0;
    /** One-shot latch for the collapse, which is a single event across the tower. */
    this._collapsed = false;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Wax motes: the signature system. Additive and curl-driven, because what
    // comes off fresh comb is warm air with flecks in it, not sparks.
    this.motes = particles.get('hivecolumn.motes', {
      capacity: 2200,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.8;
    this.motes.uniforms.uEndSize.value = 0.4;
    this.motes.uniforms.uSizeIn.value = 0.08;
    this.motes.uniforms.uFadeIn.value = 0.1;
    this.motes.uniforms.uFadeOut.value = 0.42;

    // Dry dust off the floor the tower is pushing through. Non-additive so it
    // genuinely occludes the comb behind it.
    this.dust = particles.get('hivecolumn.dust', {
      capacity: 1500,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.dust.uniforms.uDrag.value = 2.1;
    this.dust.uniforms.uEndSize.value = 2.5;
    this.dust.uniforms.uSizeIn.value = 0.13;
    this.dust.uniforms.uFadeIn.value = 0.18;
    this.dust.uniforms.uFadeOut.value = 0.32;

    // Chips of comb. Lit and opaque: they are the only solid matter in the cast
    // and they are what makes the collapse read as a structure coming apart
    // rather than as an opacity ramp.
    this.chips = particles.get('hivecolumn.chips', {
      capacity: 1200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.chips.uniforms.uDrag.value = 0.3;
    this.chips.uniforms.uEndSize.value = 0.7;
    this.chips.uniforms.uFadeOut.value = 0.65;

    this.moteEmitter = new RateEmitter();
    this.dustEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing — every second resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.comb.count;
  }

  /** Cells the colony is allowed to attempt this frame. */
  _cellCount() {
    return clamp(Math.round(settings.hivecolumn.cells), 1, MAX_CELLS);
  }

  /**
   * Seconds from the seed cell being laid to the last cell settling.
   *
   * Derived rather than authored, because the build clock belongs to the
   * *colony*: doubling `cells` has to buy a longer build, not a faster one, or
   * the tail of the structure lands after the hold has already begun.
   */
  _buildTime() {
    const c = settings.hivecolumn;
    return this._cellCount() * Math.max(0.001, c.stagger) + Math.max(0.03, c.growTime) + c.buildPad;
  }

  /** Build, then stand. */
  get impactDuration() {
    const c = settings.hivecolumn;
    return Math.max(0.2, (this._buildTime() + c.holdTime) * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.2, settings.hivecolumn.collapseTime);
  }

  /** The live footprint, metres. What the indicator measured out. */
  get radius() {
    return Math.max(0.05, settings.hivecolumn.zoneRadius);
  }

  /**
   * Seconds since the seed cell was laid.
   *
   * Assembled from the base class's phase clocks rather than kept as its own
   * accumulator, so it stays correct when `impactDuration` moves under it — and
   * it does move, because `impactDuration` is derived from `cells` and `stagger`
   * and both are sliders.
   */
  _combAge() {
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    if (this.phase === AbilityPhase.IMPACT) return this.impactTime;
    return this.impactDuration + this.fadeTime;
  }

  /** 1 while the tower stands, easing to 0 as it withdraws. */
  _retract() {
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    if (this.phase !== AbilityPhase.FADE) return 1;
    const c = settings.hivecolumn;
    return 1 - Easing.inCubic(saturate(this.fadeTime / Math.max(0.05, c.collapseTime)));
  }

  /**
   * How many cells have landed, 0..count.
   *
   * A pure function of the live clock — nothing is accumulated, so dragging
   * `stagger` on a paused frame moves the whole build forward or backward and
   * the feedback ledger below re-syncs to it in either direction.
   *
   * The `growTime · 0.55` bias is where a cell reads as having *arrived*: the
   * shader takes `growTime` to slide one cell home and overshoot it, and a puff
   * fired on the first frame of that ramp comes off a cell still buried in the
   * floor.
   */
  _landedCount() {
    const c = settings.hivecolumn;
    const t = this._combAge() - Math.max(0.03, c.growTime) * 0.55;
    if (t < 0) return 0;
    return clamp(Math.floor(t / Math.max(0.001, c.stagger)) + 1, 0, this.comb.count);
  }

  /** The middle of the circle — the far end of the aimed line. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** Where the cast leaves the caster, in world space. */
  _handPoint(out) {
    const c = settings.hivecolumn;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** Metres from the floor to the crown of the tower, live. */
  _towerHeight() {
    const c = settings.hivecolumn;
    return c.baseY + c.heightPeak + Math.max(0, Math.round(c.layers) - 1) * c.layerHeight;
  }

  /** The comb gutters like something alive rather than glinting like ice. */
  lightShimmer() {
    const c = settings.hivecolumn;
    return 1 - saturate(c.lightPulse) * 0.5 * (1 - Math.cos(this.age * c.lightPulseRate));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this.dustEmitter.reset();
    this._landed = 0;
    this._reachUnits = 0;
    this._collapsed = false;

    /*
     * The one thing a cast captures, and it has to *change* every time.
     *
     * `LatticeGrowth` only regrows when its structure hash moves, and
     * `onDestroy()` below calls `reset()`, which zeroes the instance count
     * without touching that hash. Two casts that happened to draw the same seed
     * would therefore leave the comb hidden and the ability silently empty. A
     * counter times the golden ratio guarantees consecutive casts are at least
     * 0.11 apart, which no float rounding is going to close, while the random
     * term keeps two casts from ever laying out the identical tower.
     */
    this._casts = (this._casts + 1) & 4095;
    this._seed = this._casts * 0.6180339887 + Math.random() * 0.5;

    this._sync();
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Refill the lattice params from live settings.
   *
   * Every number is re-read on every call, including on a zero-length frame.
   * Nothing is cached between frames and nothing but the seed is captured at
   * spawn — that is the whole of I1 for the comb.
   */
  _fillLattice() {
    const c = settings.hivecolumn;
    const g = settings.global;
    const p = this.lattice;

    /* the structure — changing any of these regrows the colony */
    p.cells = this._cellCount();
    p.seed = this._seed;
    p.drift = c.drift;
    p.refuse = c.refuse;
    p.climb = c.climb;
    p.outward = c.outward;
    p.layers = c.layers;

    /* the metres */
    p.pitch = c.pitch;
    p.cellRadius = c.cellRadius;
    p.sizeJitter = c.sizeJitter * g.randomness;
    p.heightBase = c.heightBase;
    p.heightPeak = c.heightPeak;
    p.heightFalloff = c.heightFalloff;
    p.layerHeight = c.layerHeight;
    p.baseY = c.baseY;
    p.rise = c.rise;

    /* the clock */
    p.stagger = c.stagger;
    p.growTime = c.growTime;
    p.overshoot = c.overshoot;
    p.retract = this._retract();

    /* the surface */
    p.tintRadius = c.tintRadius;
    p.tintJitter = c.tintJitter * g.randomness;
    p.wrap = c.combWrap;
    p.rimPow = c.rimPow;
    p.rimGain = c.rimGain * g.shaderIntensity;
    p.sheenPow = c.sheenPow;
    p.sheenGain = c.sheenGain * g.shaderIntensity;
    p.coreGlow = c.coreGlow * g.shaderIntensity;
    p.flashGain = c.flashGain;
    p.glow = c.combGlow * g.glow;

    p.combA = c.colorCombA;
    p.combB = c.colorCombB;
    p.combC = c.colorCombC;
    p.combD = c.colorCombD;
    p.coreColor = c.colorCombCore;
    p.rimColor = c.colorCombRim;
    p.sheenColor = c.colorCombSheen;
    p.flashColor = c.colorCombFlash;
  }

  /**
   * Refill the wax mat's params.
   *
   * The one interesting line is `grow`. It is not a clock — it is the colony's
   * own reach in metres over the mat's own radius in metres, so the charge on
   * the floor stops exactly where the comb above it stops, and both move
   * together when `pitch`, `cells` or `zoneRadius` are dragged.
   */
  _fillMat() {
    const c = settings.hivecolumn;
    const g = settings.global;
    const p = this.matParams;
    const R = this.radius * c.floorRadius;

    this._centrePoint(p.centre);
    p.radius = R;
    p.height = c.floorHeight;
    p.seed = this._seed;
    p.grow = saturate((this._reachUnits * c.pitch) / Math.max(0.05, R));
    p.recede = 0;
    p.fade = this._retract();

    p.edge = c.floorEdge;
    p.ragged = c.floorRagged;
    p.raggedScale = c.floorRaggedScale;
    p.warp = c.floorWarp;

    p.relief = c.floorRelief;
    p.ambient = c.floorAmbient;
    p.wrap = c.floorWrap;
    p.specular = c.floorSpecular;
    p.gloss = c.floorGloss;
    p.parallax = c.floorParallax;

    p.cell = c.floorCell;
    p.seam = c.floorSeam;
    p.thickness = c.floorThickness;
    p.lift = c.floorLift;
    p.depth = c.floorDepth;
    p.detail = c.floorDetail;
    p.sharp = c.floorSharp;
    p.speed = c.floorSpeed;

    p.additive = false;
    p.emissive = c.floorEmissive * g.shaderIntensity;
    p.opacity = c.floorOpacity;
    p.depthFade = c.floorDepthFade;
    p.colorBase = c.colorFloorBase;
    p.colorEdge = c.colorFloorEdge;
    p.colorGlow = c.colorFloorGlow;
    p.colorDeep = c.colorFloorDeep;

    p.noiseStrength = g.noiseStrength;
    p.noiseFrequency = g.noiseFrequency;
    p.noiseSpeed = g.noiseSpeed;
    p.opacityScale = g.opacity;
  }

  /**
   * Push everything into the comb, the mat and the three particle systems.
   *
   * The order is load-bearing and it is the one thing to be careful of when
   * editing this method. The comb has to be grown before the ledger walks it,
   * because `_landedCount()` clamps against `comb.count` and that count is zero
   * until the first `update()`; and the ledger has to run before the mat is
   * filled, because the mat's growth front is the reach the ledger just
   * recorded. Filling the mat first cost a frame of lag on every slider drag —
   * invisible while running, glaring while paused, which is exactly the wrong
   * way round.
   */
  _sync() {
    const c = settings.hivecolumn;
    const g = settings.global;

    this._centrePoint(_centre);

    this._fillLattice();
    this.comb.setPlacement(_centre, this.direction);
    this.comb.update(this._combAge(), this.lattice);

    this._walkLandings();

    this._fillMat();
    this.mat.setVisible(this.matParams.fade > 0 && this.matParams.grow > 0);
    this.mat.update(this.matParams);

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
    this.motes.uniforms.uGlow.value = c.moteGlow * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

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
  }

  /** The puff at the caster's hand as the runner leaves it. */
  _muzzleFx() {
    const c = settings.hivecolumn;
    const g = settings.global;

    this._handPoint(_hand);

    this.ctx.bursts.spawn(BurstMode.EARTH, _hand, {
      radius: c.muzzleSize * 0.25,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.4,
      intensity: c.muzzleIntensity,
      opacity: 0.6,
      fresnel: 1.3,
      displace: 0.5,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    _emit.position = _hand;
    _emit.radius = 0.16;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.65).setY(0.45).normalize();
    _emit.speed = c.moteSpeed * 3;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.08;
    _emit.sizeVariance = 0.7;
    _emit.life = c.moteLifetime * 0.6;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(Math.round(24 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.4 * g.explosionIntensity;
  }

  /** Dust kicked up under the scent runner while it crosses the floor. */
  _runnerFx(dt) {
    const c = settings.hivecolumn;
    const g = settings.global;

    const count = Math.round(this.dustEmitter.tick(dt, c.dustRate * 0.6) * g.particleCount);
    if (count <= 0) return;

    _emit.position = _pos.copy(this.position).setY(0.1);
    _emit.radius = 0.5;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dustSpeed;
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
   * Walk the ledger of landed cells forward.
   *
   * Two jobs, and they are deliberately in one loop. The first is the lattice
   * reach the wax mat's front reads — every landed cell, no matter how many
   * arrived this frame. The second is the puff of wax each landing throws, which
   * is capped, for the reason `MAX_LANDINGS_PER_FRAME` gives.
   *
   * The reach is recorded in **lattice units**, not metres: `cellPoint` gives a
   * world position that already has the live `pitch` in it, so dividing it back
   * out leaves a number that means "this many cells out from the seed" and
   * survives a `pitch` drag. Storing the metres instead was the first version
   * and it froze the mat's front the moment the clock stopped.
   */
  _walkLandings() {
    const c = settings.hivecolumn;
    const landed = this._landedCount();

    if (landed < this._landed) {
      // A slider ran the build backwards. Drop the ledger and let it re-fill;
      // the reach has to go with it or the mat keeps a front the comb has lost.
      this._landed = landed;
      this._reachUnits = 0;
      for (let i = 0; i < landed; i++) this._recordReach(i, c);
      return;
    }

    let puffs = 0;
    for (let i = this._landed; i < landed; i++) {
      this._recordReach(i, c);
      if (puffs < MAX_LANDINGS_PER_FRAME) {
        this._landingFx(i);
        puffs++;
      }
    }
    this._landed = landed;
  }

  /** Fold cell `index` into the unitless lattice reach. */
  _recordReach(index, c) {
    this._centrePoint(_centre);
    this.comb.cellPoint(index, this.lattice, _pos, 0);
    const units = Math.hypot(_pos.x - _centre.x, _pos.z - _centre.z) / Math.max(0.01, c.pitch);
    if (units > this._reachUnits) this._reachUnits = units;
  }

  /**
   * The wax a single cell throws as it snaps into place.
   *
   * Emitted at the cell's own rim — `cellPoint` reads the same floats the vertex
   * shader reads, so the puff comes off the cell that is actually there and
   * moves with it when `layerHeight` or `heightPeak` is dragged.
   */
  _landingFx(index) {
    const c = settings.hivecolumn;
    const g = settings.global;
    const time = frame.uTime.value;

    this.comb.cellPoint(index, this.lattice, _pos, 1);

    const motes = Math.round(c.cellMotes * g.particleCount);
    if (motes > 0) {
      _emit.position = _pos;
      _emit.radius = c.cellRadius * 0.9;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.7;
      _emit.life = c.moteLifetime * 0.8;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(motes, _emit);
    }

    // Only some cells shed. A chip off every one of a hundred and fifty is a
    // continuous gravel fountain, and the point of the chips is that the tower
    // is occasionally *breaking* something as it forces its way up.
    if (hash11(index * 7.31 + this._seed) < c.cellChipChance) {
      _emit.position = _pos;
      _emit.radius = c.cellRadius;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.chipSpeed * 0.5;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.7;
      _emit.life = c.chipLifetime * 0.7;
      _emit.lifeVariance = 0.5;
      _emit.spin = c.chipSpin;
      _emit.time = time;
      this.chips.emit(Math.max(1, Math.round(g.particleCount)), _emit);
    }
  }

  /**
   * Wax motes off the standing tower and dust off the floor around it.
   *
   * @param {number} scale 0..1 — thinned out as the tower dies
   */
  _towerFx(dt, scale) {
    const c = settings.hivecolumn;
    const g = settings.global;
    const time = frame.uTime.value;
    const count = this.comb.count;
    if (count <= 0) return;

    this._centrePoint(_centre);

    const motes = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (motes > 0) {
      // From a cell that has actually landed, so the motes climb the tower as
      // it builds rather than filling the whole footprint from frame one.
      const live = Math.max(1, this._landed);
      const index = Math.min(live - 1, (Math.random() * live) | 0);
      this.comb.cellPoint(index, this.lattice, _pos, 1);
      _emit.position = _pos;
      _emit.radius = c.cellRadius * 1.6;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.7;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(motes, _emit);
    }

    const dustCount = Math.round(this.dustEmitter.tick(dt, c.dustRate * scale) * g.particleCount);
    if (dustCount > 0) {
      const bearing = Math.random() * Math.PI * 2;
      const r = this.radius * Math.sqrt(Math.random());
      _pos.set(_centre.x + Math.cos(bearing) * r, 0.12, _centre.z + Math.sin(bearing) * r);
      _emit.position = _pos;
      _emit.radius = this.radius * 0.14;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.95;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.7;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.35;
      _emit.tint = null;
      _emit.time = time;
      this.dust.emit(dustCount, _emit);
    }
  }

  /** The one-shot as the tower lets go of the floor. */
  _collapseFx() {
    const c = settings.hivecolumn;
    const g = settings.global;
    const time = frame.uTime.value;

    this._centrePoint(_centre);
    _pos.copy(_centre).setY(this._towerHeight() * 0.4);

    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.burstSize * 0.3,
      endRadius: c.burstSize * 0.9 * g.explosionIntensity,
      life: 0.8,
      intensity: c.burstIntensity * 0.8,
      opacity: 0.5,
      fresnel: 1.4,
      displace: 0.55,
      squash: 0.7,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    _emit.position = _pos;
    _emit.radius = this.radius * 0.7;
    _emit.direction = _dir.set(0, 0.5, 0).normalize();
    _emit.speed = c.chipSpeed;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.8;
    _emit.life = c.chipLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = c.chipSpin;
    _emit.tint = null;
    _emit.time = time;
    this.chips.emit(Math.round(c.collapseChips * g.particleCount), _emit);

    _emit.position = _pos;
    _emit.radius = this.radius * 0.8;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dustSpeed * 2.0;
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.size = 1.3;
    _emit.life = c.dustLifetime * 1.2;
    _emit.spin = 0.5;
    this.dust.emit(Math.round(40 * g.particleCount), _emit);

    this.ctx.decals.spawn(DecalType.DUSTRING, _centre, {
      radius: c.shockRadius * 0.9 * g.explosionIntensity,
      life: 0.9,
      width: 0.06,
      intensity: 0.6,
      colorA: getColor(c.colorSeatEdge),
      colorB: getColor(c.colorSeat)
    });

    this.ctx.shake.add(
      c.impactShake * 0.6 * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      15
    );
    this.lightBoost = c.lightIntensity * 0.6 * g.explosionIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync();

    // The light rides the runner, just off the floor.
    this.position.y = 0.28;

    this._runnerFx(dt);
    this.ctx.shake.rumble(settings.hivecolumn.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.hivecolumn;
    const g = settings.global;
    const time = frame.uTime.value;

    this._centrePoint(_centre);

    /* the shell as the seed cell is laid */
    _pos.copy(_centre).setY(c.heightPeak * 0.4);
    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.7,
      intensity: c.burstIntensity,
      opacity: 0.55,
      fresnel: 1.4,
      displace: 0.5,
      squash: 0.65,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the mat of wax the whole tower is seated on */
    this.ctx.decals.spawn(DecalType.FOAM, _centre, {
      radius: this.radius * c.seatRadius,
      life: c.seatLife,
      intensity: c.seatIntensity,
      colorA: getColor(c.colorSeat),
      colorB: getColor(c.colorSeatEdge)
    });

    /* and the ring of dust pushed out as it takes hold */
    this.ctx.decals.spawn(DecalType.DUSTRING, _centre, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.8,
      width: 0.05,
      intensity: 0.65,
      colorA: getColor(c.colorSeatEdge),
      colorB: getColor(c.colorSeat)
    });

    _emit.position = _pos;
    _emit.radius = this.radius * 0.35;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed * 2.2;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.08;
    _emit.sizeVariance = 0.8;
    _emit.life = c.moteLifetime * 1.2;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.motes.emit(Math.round(c.burstMotes * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.9 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.hivecolumn;

    this._sync();

    if (!this._collapsed && this.phase === AbilityPhase.FADE) {
      this._collapsed = true;
      this._collapseFx();
    }

    // The light climbs with the tower and rides it back down.
    const retract = this._retract();
    this._centrePoint(this.position);
    this.position.y = this._towerHeight() * saturate(c.lightHeight) * retract;

    this._towerFx(dt, t <= 1 ? 1 : retract * 0.5);
  }

  onDestroy() {
    this.comb.reset();
    this.mat.setVisible(false);
    this._landed = 0;
    this._reachUnits = 0;
    this._collapsed = false;
  }

  dispose() {
    this.comb.dispose();
    this.mat.dispose();
    super.dispose();
  }
}
