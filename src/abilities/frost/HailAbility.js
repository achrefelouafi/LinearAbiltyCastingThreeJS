import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { Projectile, FlightMode, Stagger } from '../../vfx/Projectile.js';
import { GroundField, GroundMode } from '../../vfx/GroundField.js';
import { createHailMaterial } from '../../materials/HailMaterial.js';
import { createAsteroidGeometry } from '../../assets/ProceduralGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, Easing, hash11, randRange } from '../../utils/math.js';

/**
 * How many craters the ground field's event list carries.
 *
 * One stone posts one crater, so this is also the ceiling on `stones` — past it
 * the ring buffer recycles oldest-first and the earliest holes vanish while you
 * are looking at them. The fragment walks the list three times (the bowl, the
 * coverage mask and the cold), so this is the number that decides what the
 * floor costs; 32 is about where a 5 m circle stops looking sparse and well
 * before the quad becomes the most expensive thing on screen.
 */
const POCK_SLOTS = 32;

/** Hard ceiling on stones in the air. `stones` clamps here. */
const MAX_STONES = POCK_SLOTS;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _land = new Vector3();
const _centre = new Vector3();
const _heading = new Vector3();

/** Scratch parameter blocks — refilled every frame, never replaced (I3). */
const _flight = {};
const _floor = {};

/**
 * HAILWRATH — the far cast whose front is *vertical*.
 *
 * Every other zone slot in the sandbox answers a circle with something that
 * spreads: a sheet that freezes outward, a ring of blades that closes. This one
 * answers it with weather. A column of freezing air stands over the footprint
 * and then it comes down — irregular stones that stretch along their own
 * velocity, punch a white pock into the floor, throw chips, bounce once and are
 * gone. The pocks stay, rime over during the hold, and thaw back from the rim.
 *
 * ## The trick
 *
 * **No stone knows when it falls; the floor does.** A stone's launch delay is a
 * hash of *where it is going to land*, quantised onto a lattice and mixed with
 * the cast's seed (`Projectile`'s `Stagger.HASH`). Ordering by index — the
 * obvious `i / count` — correlates the fill order with the layout, because the
 * same dice place the stones, and you can watch the loop run. Keying on the
 * floor decorrelates them completely: neighbouring stones share a hash cell, so
 * the circle fills in *patches that spread*, `fillBias` runs those patches
 * inward from the boundary, and a different seed fills the same circle in a
 * completely different order.
 *
 * ## The envelope, and what it cost
 *
 * Hail does not arrive at a constant rate. It gathers, hammers, and tails off.
 * `Projectile` spreads its launches **uniformly** over `window`, and there is no
 * per-body hook to change that — so the envelope is not applied to the stones
 * at all. It is applied to the *clock they are read against*:
 * `_stormClock()` integrates the rate curve `stormRamp`/`stormPeak`/`stormTail`
 * into a monotone reparametrisation of the storm's own time, and a uniform
 * spread read against a clock that runs fast at the peak and slow at the edges
 * **is** a ramp-peak-tail. Four coefficients, one integral, no schedule and no
 * captured seconds — which is why dragging `stormPeak` with the game paused
 * re-times every stone still in the sky.
 *
 * The price is real and worth knowing: the stones' *fall* is measured in storm
 * seconds too, so the first ones drift down and the ones at the peak hammer.
 * `stormFloor` bounds the ratio. Set it to zero and the very first stone hangs
 * motionless in the air — which is the mechanism made visible, and the reason
 * it ships at 0.35. The alternative, dividing `fallTime` by the local rate to
 * cancel it exactly, was written and thrown away: it makes a body's τ
 * non-monotone wherever the rate is rising, so a stone that had landed goes
 * back into the air, and the arrival re-fires and digs its crater twice.
 *
 * ## What a cast captures
 *
 * Two timestamps — the moment of the cast and the moment the storm started —
 * one seed, and the dice `Projectile#roll()` holds. Not one metre. The craters
 * on the floor are posted as **fractions of the radius**, so dragging
 * `zoneRadius` on a floor that is already cratered grows the whole pattern with
 * the circle instead of leaving it sitting in the middle of a bigger one.
 *
 * Three draw calls: the stones, their streaks, and the floor.
 */
export class HailAbility extends Ability {
  constructor(context) {
    super('hail', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.material = createHailMaterial(this.ctx.environment);

    /**
     * The stones. `geometry` is a *factory* — the module owns the buffer,
     * dresses it with its per-instance attributes and rebuilds it whenever
     * `shapeKey()` moves, which is what keeps the silhouette sliders live.
     */
    this.stones = new Projectile(this.group, {
      geometry: () => this._buildStone(),
      shapeKey: () => this._shapeKey(),
      material: this.material,
      capacity: MAX_STONES,
      trail: true,
      trailNodes: 18,
      trailAdditive: true,
      layer: LAYER.WORLD,
      renderOrder: 2,
      castShadow: true
    });

    /**
     * The floor. `POCK` accumulates craters from a list of unitless hits: the
     * bowls union with `min` and the lips sum, so two stones on the same spot
     * dig one hole and pile two rims — which is what happens.
     */
    this.pocks = new GroundField(this.group, {
      mode: GroundMode.POCK,
      marks: POCK_SLOTS,
      additive: false,
      depthTest: true,
      name: 'hail.pocks'
    });

    /** Re-rolled per cast so no two storms fill the circle in the same order. */
    this._seed = 0;
    /** Timestamp: the moment the storm was let go. An event, not a duration. */
    this._stormAt = 0;
    /** Signature of the silhouette controls, so a rebuild only follows a change. */
    this._shapeHash = '';
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The freezing column, and the fog that pools in the crater field. Not
    // additive: cold air that adds light is a spotlight.
    this.mist = particles.get('hail.mist', {
      capacity: 900,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.mist.uniforms.uDrag.value = 1.6;
    this.mist.uniforms.uEndSize.value = 2.6;
    this.mist.uniforms.uSizeIn.value = 0.14;
    this.mist.uniforms.uFadeIn.value = 0.2;
    this.mist.uniforms.uFadeOut.value = 0.35;

    // Ice knocked off a stone — and, at a different size and life, the stone's
    // own single bounce. Same substance, so the same system and the same
    // gradient; a second system for one hop would be a second draw call and a
    // second set of colour pickers that must not disagree with these.
    this.chips = particles.get('hail.chips', {
      capacity: 1200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.chips.uniforms.uDrag.value = 0.35;
    this.chips.uniforms.uEndSize.value = 0.7;
    this.chips.uniforms.uFadeOut.value = 0.65;

    // The bright shatter at the moment of contact.
    this.spray = particles.get('hail.spray', {
      capacity: 1400,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.2
    });
    this.spray.uniforms.uDrag.value = 2.2;
    this.spray.uniforms.uEndSize.value = 0.2;
    this.spray.uniforms.uSizeIn.value = 0.02;
    this.spray.uniforms.uFadeIn.value = 0.02;
    this.spray.uniforms.uFadeOut.value = 0.5;

    // What lifts off the rime while it closes over.
    this.glitter = particles.get('hail.glitter', {
      capacity: 700,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.glitter.uniforms.uDrag.value = 1.8;
    this.glitter.uniforms.uEndSize.value = 0.12;
    this.glitter.uniforms.uSizeIn.value = 0.05;
    this.glitter.uniforms.uFadeIn.value = 0.1;
    this.glitter.uniforms.uFadeOut.value = 0.45;

    this.mistEmitter = new RateEmitter();
    this.glitterEmitter = new RateEmitter();
  }

  /**
   * One stone, in unit space — `Projectile` scales it by the body radius.
   *
   * An icosphere at one subdivision is eighty triangles, which is plenty: a
   * hailstone is 17 cm across and what carries it at that size is the *cut
   * faces*, not the tessellation. The cuts are what make it read as hail rather
   * than as gravel — real stones are accreted in layers and shear along them.
   */
  _buildStone() {
    const c = settings.hail;
    return createAsteroidGeometry({
      seed: 7.3,
      detail: clamp(Math.round(c.stoneFacets), 0, 2),
      lumpiness: c.stoneLumps,
      noiseScale: c.stoneLumpScale,
      roughness: c.stoneChip,
      cuts: Math.max(0, Math.round(c.stoneCuts)),
      cutDepth: c.stoneCutDepth,
      craters: 0,
      craterDepth: 0,
      craterSize: 0.4
    });
  }

  /** Everything `_buildStone` reads, as one string. A change rebuilds. */
  _shapeKey() {
    const c = settings.hail;
    return `${Math.round(c.stoneFacets)}|${c.stoneLumps}|${c.stoneLumpScale}|${c.stoneChip}|${Math.round(c.stoneCuts)}|${c.stoneCutDepth}`;
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.stones.count;
  }

  /** The storm: the lead-in, the launches, and the last stone's fall. */
  get impactDuration() {
    const c = settings.hail;
    return Math.max(0.2, (c.stormLead + c.stormTime + c.fallTime) * settings.global.lifetime);
  }

  /** The hold: the pocks rime over, then the field thaws back from the rim. */
  get fadeDuration() {
    return Math.max(0.2, settings.hail.holdTime);
  }

  /** The live footprint, metres. What the indicator measured out. */
  get radius() {
    return Math.max(0.2, settings.hail.zoneRadius);
  }

  /* ------------------------------------------------------------------ */
  /* The storm clock — the envelope, integrated                          */
  /* ------------------------------------------------------------------ */

  /**
   * The rate envelope's own integral, normalised to 0..1 over the storm.
   *
   * The rate curve is a floor plus two power arms meeting at the peak:
   *
   * ```
   *   e(x) = floor + (1 − floor) · (x/p)^ramp            for x ≤ p
   *   e(x) = floor + (1 − floor) · ((1−x)/(1−p))^tail    for x > p
   * ```
   *
   * Both arms integrate in closed form, which is the whole reason the envelope
   * is shaped this way rather than as an fbm or a spline: a clock has to be
   * evaluated, not marched, or it cannot be re-derived on a zero-length frame.
   */
  _envelopeCdf(x) {
    const c = settings.hail;
    const p = clamp(c.stormPeak, 0.02, 0.98);
    const ramp = Math.max(0.05, c.stormRamp);
    const tail = Math.max(0.05, c.stormTail);
    const floor = saturate(c.stormFloor);
    const gain = 1 - floor;

    const rise = (gain * p) / (ramp + 1); //  area under the rising arm
    const fall = (gain * (1 - p)) / (tail + 1); //  ... and the falling one
    const total = floor + rise + fall;

    const t = saturate(x);
    const area =
      t <= p
        ? floor * t + rise * Math.pow(t / p, ramp + 1)
        : floor * t + rise + fall * (1 - Math.pow((1 - t) / (1 - p), tail + 1));

    return area / Math.max(total, 1e-4);
  }

  /**
   * Seconds on the storm's own clock.
   *
   * Identity before the lead-in and after the last launch — only the launch
   * window is warped, so a stone still in the air when the storm ends finishes
   * its fall in real time rather than freezing.
   */
  _stormClock() {
    const c = settings.hail;
    if (this.phase === AbilityPhase.TRAVEL) return 0;

    const lead = Math.max(0, c.stormLead);
    const span = Math.max(0.05, c.stormTime);
    const since = this.age - this._stormAt - lead;

    if (since <= 0) return Math.max(0, this.age - this._stormAt);
    if (since >= span) return lead + since;
    return lead + span * this._envelopeCdf(since / span);
  }

  /** The centre of the storm — the far end of the aimed line, on the floor. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.mistEmitter.reset();
    this.glitterEmitter.reset();
    this.pocks.clearMarks();
    this.stones.reset();

    // The two things a cast captures: one seed and, at impact, one timestamp.
    this._seed = Math.random() * 100;
    this._stormAt = 0;
    this.stones.roll(this._seed);

    this._syncStones(0);
    this._syncFloor(0, 0);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Re-fly every stone against the live block, and deal with whatever landed.
   * @param {number} clock seconds on the storm's warped clock
   */
  _syncStones(clock) {
    const c = settings.hail;
    const g = settings.global;
    const p = _flight;

    p.mode = FlightMode.FALL;
    p.stagger = Stagger.HASH;
    p.count = Math.min(MAX_STONES, Math.round(c.stones));
    p.radius = c.stoneRadius;
    p.sizeJitter = c.stoneJitter;
    p.stretch = c.stoneStretch;
    p.align = c.stoneAlign;
    p.spin = c.stoneSpin * g.randomness;
    p.flash = c.stoneFlash;

    // Where they come from. One point, high and behind — the trails converge in
    // the sky and diverge on the ground, and that parallax is the whole reason
    // the sky reads as being above you rather than as a wall of streaks.
    p.skyBack = c.skyBack;
    p.skyHeight = c.skyHeight;
    p.skyScatter = c.skySpread;

    // ... and where they go. `landInZone` puts them on the far disc rather than
    // at the end of the line; `zoneRadius` is shared with the ground field and
    // the indicator, which is the one kind of sharing I5 allows because the
    // sharing *is* the design.
    p.landInZone = true;
    p.zoneRadius = this.radius;
    p.zoneBias = c.rimCrowd;
    p.landHeight = 0;

    p.pathCurve = c.fallCurve;
    p.apex = 0; //  a fall has no loft; the cloud is already the high point
    p.apexCurve = 1;
    p.weaveSide = c.driftSide;
    p.weaveUp = 0;
    p.weaveTurns = c.driftTurns;
    p.weaveTurnsUp = 1;
    p.weaveDecay = c.driftDecay;

    p.flightTime = c.fallTime;
    p.speedJitter = c.speedJitter;
    p.lead = c.stormLead;
    p.window = Math.max(0.05, c.stormTime);
    p.fillBias = c.fillBias;
    p.fillScatter = c.fillScatter;
    p.hashCell = c.hashCell;
    // A hailstone does not lie about on the floor. It shatters, and what is
    // left is the pock, the chips and one bounce.
    p.linger = 0;
    p.sink = 0;

    p.trailSpan = c.trailSpan;
    p.trailBurn = c.trailBurn;
    p.trailWidth = c.trailWidth;
    p.trailTaper = c.trailTaper;
    p.trailLift = c.trailLift;
    p.trailOpacity = c.trailOpacity * g.opacity;
    p.trailGlow = c.trailGlow * g.glow;
    p.trailCore = c.trailCore;
    p.trailHeadBias = c.trailHeadBias;
    p.trailNoise = c.trailNoise * g.noiseStrength;
    p.trailNoiseScale = c.trailNoiseScale * g.noiseFrequency;
    p.trailNoiseSpeed = c.trailNoiseSpeed * g.noiseSpeed;
    p.trailSoftFade = c.trailSoftFade;

    this.stones.setBasis(this.origin, this.direction, this.side, this.length);
    this.stones.setTrailColors(c.colorTrailA, c.colorTrailB, c.colorTrailC, c.colorTrailD);
    this.stones.update(clock, p);

    // The mean heading of the fall, for the leading-face light on the stones:
    // the cloud point to the middle of the circle. Taken once rather than per
    // stone because thirty bodies out of one vanishing point are within a few
    // degrees of each other, and a per-instance heading is a second instanced
    // attribute bought for nothing.
    this._centrePoint(_centre);
    _heading
      .copy(_centre)
      .sub(this.origin)
      .addScaledVector(this.direction, c.skyBack);
    _heading.y = -Math.max(0.1, c.skyHeight);
    _heading.normalize();
    this.material.userData.sync(_heading);
  }

  /**
   * Everything a stone does the instant it arrives.
   *
   * Read straight after `update()`: an arrival is *re-derived*, not remembered,
   * so a slider that puts a body back in the air clears it again.
   */
  _strikes() {
    const c = settings.hail;
    const g = settings.global;
    const time = frame.uTime.value;
    const count = this.stones.arrivalCount;
    if (count <= 0) return;

    this._centrePoint(_centre);
    const radius = this.radius;

    for (let i = 0; i < count; i++) {
      const index = this.stones.arrivals[i];
      this.stones.landPoint(index, _land);

      /* --- the pock. Fractions of the radius, never metres. --- */
      _pos.copy(_land).sub(_centre);
      // The field's local +Z is downrange and its local +X is `-side`; posting
      // in that frame is what lets the whole crater pattern rotate with a
      // re-aimed cast rather than being stamped in world axes.
      const strength = 0.55 + 0.45 * hash11(index * 3.7 + this._seed);
      this.pocks.mark(
        -_pos.dot(this.side) / radius,
        _pos.dot(this.direction) / radius,
        time,
        strength
      );

      /* --- chips off the floor --- */
      _land.y = 0.04;
      _emit.position = _land;
      _emit.radius = c.stoneRadius * 1.4;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.chipSpeed * strength;
      _emit.speedVariance = 0.8;
      _emit.spread = c.chipSpread;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.chipSize;
      _emit.sizeVariance = 0.7;
      _emit.life = c.chipLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = c.chipSpin;
      _emit.tint = null;
      _emit.time = time;
      this.chips.emit(Math.round(c.chipCount * g.particleCount), _emit);

      /* --- the bounce: one chip the size of the stone, thrown back up --- */
      _emit.radius = 0.02;
      _emit.speed = c.bounceSpeed * strength;
      _emit.speedVariance = 0.3;
      _emit.spread = c.bounceSpread;
      _emit.size = c.bounceSize;
      _emit.sizeVariance = 0.35;
      _emit.life = c.bounceLifetime;
      _emit.lifeVariance = 0.3;
      _emit.spin = c.bounceSpin;
      this.chips.emit(1, _emit);

      /* --- the shatter --- */
      _emit.radius = c.stoneRadius;
      _emit.direction = _dir
        .set(randRange(-1, 1), c.sprayRise * 2.2, randRange(-1, 1))
        .normalize();
      _emit.speed = c.spraySpeed * strength;
      _emit.speedVariance = 0.85;
      _emit.spread = 1.0;
      _emit.size = c.spraySize;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sprayLifetime;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      this.spray.emit(Math.round(c.sprayCount * g.particleCount), _emit);

      this.ctx.shake.add(
        c.strikeShake * strength * g.explosionIntensity * g.cameraShake,
        1 / Math.max(0.05, c.strikeShakeDecay),
        24
      );
      this.lightBoost += c.strikeLight * strength * g.explosionIntensity;
      // The light rides the freshest crater, which is what makes a storm read
      // as a sequence of events rather than as one lit disc.
      this.position.copy(_land).setY(0.4);
    }
  }

  /**
   * The floor, and the frost closing over it.
   *
   * @param {number} grow 0..1 how far the chill has spread across the circle
   * @param {number} rime 0..1 how far the frost has closed over the craters
   * @param {number} thaw 0..1 how far the field is being eaten back from the rim
   * @param {number} fade 0..1 master
   */
  _syncFloor(grow, rime, thaw = 0, fade = 1) {
    const c = settings.hail;
    const g = settings.global;
    const p = _floor;

    p.centre = this._centrePoint(_centre);
    // Local +Z downrange, so a re-aimed cast turns the whole crater field with
    // it. `Ability#side` is `direction × up`, which is local −X.
    p.yaw = Math.atan2(this.direction.x, this.direction.z);
    p.height = c.pockHeight;
    p.radius = this.radius;
    p.length = this.length;

    p.grow = grow;
    p.recede = thaw;
    p.fade = fade;
    p.seed = this._seed;

    p.edge = c.pockEdge;
    p.ragged = c.pockRagged;
    p.raggedScale = c.pockRaggedScale;
    p.warp = c.pockWarp;

    p.relief = c.pockRelief;
    p.normalStep = c.pockNormalStep;
    p.ambient = c.pockAmbient;
    p.wrap = c.pockWrap;
    // Frost is glossier than the bruised stone under it, and it is the sheen
    // rather than any colour change that says the craters have iced over.
    p.specular = lerp(c.pockSpecular, c.rimeSpecular, rime);
    p.gloss = lerp(c.pockGloss, c.rimeGloss, rime);
    p.parallax = c.pockParallax;

    // `thickness` is the lip's half-width and `lift` its height. Walking both
    // up over the hold spreads the white rim inward until it closes over the
    // bowl — frost growing out of the broken edges, which is where it starts.
    // The first version crossfaded `colorBase` toward a frost colour instead
    // and read as somebody tinting the floor, not as ice forming on it.
    p.thickness = lerp(c.pockRim, c.rimeRim, rime);
    p.lift = lerp(c.pockLift, c.rimeLift, rime);
    p.depth = c.pockDepth;
    p.detail = lerp(c.pockGrain, c.rimeGrain, rime);
    p.speed = c.pockDig;
    p.markLife = c.pockLife;
    p.markRadius = c.pockRadius;

    p.additive = false;
    p.emissive = c.pockEmissive * g.shaderIntensity;
    p.opacity = c.pockOpacity;
    p.depthFade = c.pockDepthFade;
    p.colorBase = c.colorPock;
    p.colorEdge = c.colorPockRim;
    p.colorGlow = c.colorPockGlow;
    p.colorDeep = c.colorPockDeep;

    p.noiseStrength = g.noiseStrength;
    p.noiseFrequency = g.noiseFrequency;
    p.noiseSpeed = g.noiseSpeed;
    p.opacityScale = g.opacity;

    this.pocks.update(p);
  }

  /** The particle systems, all four of them. */
  _syncParticles() {
    const c = settings.hail;
    const g = settings.global;

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
    this.mist.uniforms.uTurbulence.value = c.mistTurbulence * g.turbulence;

    this.chips.setGradient(
      getColor(c.colorChipA),
      getColor(c.colorChipB),
      getColor(c.colorChipC),
      getColor(c.colorChipD)
    );
    this.chips.uniforms.uGravity.value.set(0, c.chipGravity, 0);
    this.chips.uniforms.uSizeScale.value = c.chipSize * g.particleSize * 7;
    this.chips.uniforms.uLifeScale.value = g.particleLifetime;
    this.chips.uniforms.uSpeedScale.value = g.particleSpeed;
    this.chips.uniforms.uOpacity.value = g.opacity;

    this.spray.setGradient(
      getColor(c.colorSprayA),
      getColor(c.colorSprayB),
      getColor(c.colorSprayC),
      getColor(c.colorSprayD)
    );
    this.spray.uniforms.uGravity.value.set(0, c.sprayGravity, 0);
    this.spray.uniforms.uSizeScale.value = c.spraySize * g.particleSize * 7;
    this.spray.uniforms.uLifeScale.value = c.sprayLifetime * 0.5 * g.particleLifetime;
    this.spray.uniforms.uSpeedScale.value = g.particleSpeed;
    this.spray.uniforms.uOpacity.value = g.opacity;
    this.spray.uniforms.uGlow.value = c.iceGlow * 0.9 * g.glow;
    this.spray.uniforms.uStretch.value = c.sprayStretch;

    this.glitter.setGradient(
      getColor(c.colorGlitterA),
      getColor(c.colorGlitterB),
      getColor(c.colorGlitterC),
      getColor(c.colorGlitterD)
    );
    this.glitter.uniforms.uGravity.value.set(0, c.glitterRise, 0);
    this.glitter.uniforms.uSizeScale.value = c.glitterSize * g.particleSize * 7;
    this.glitter.uniforms.uLifeScale.value = c.glitterLifetime * 0.5 * g.particleLifetime;
    this.glitter.uniforms.uSpeedScale.value = c.glitterSpeed * g.particleSpeed;
    this.glitter.uniforms.uOpacity.value = g.opacity;
    this.glitter.uniforms.uGlow.value = 1.1 * g.glow;
    this.glitter.uniforms.uTurbulence.value = c.glitterTurbulence * g.turbulence;
  }

  /**
   * The column of freezing air standing over the circle.
   * @param {number} scale 0..1 — thinned as the storm dies
   */
  _mistFx(dt, scale) {
    const c = settings.hail;
    const g = settings.global;
    const count = Math.round(this.mistEmitter.tick(dt, c.mistRate * scale) * g.particleCount);
    if (count <= 0) return;

    this._centrePoint(_pos);
    // Fog pools in the middle and pours off the rim, so the emission disc is a
    // fraction of the footprint rather than a fixed radius — drag `zoneRadius`
    // and the column widens with the circle.
    _pos.y = randRange(0.1, Math.max(0.2, c.mistHeight));
    _emit.position = _pos;
    _emit.radius = this.radius * c.mistSpread;
    _emit.direction = _dir.set(0, -1, 0);
    _emit.speed = c.mistSpeed;
    _emit.speedVariance = 0.7;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 1.0;
    _emit.sizeVariance = 0.5;
    _emit.life = c.mistLifetime;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.25;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.mist.emit(count, _emit);
  }

  /** Glitter lifting off the rime while it closes. */
  _glitterFx(dt, rime) {
    const c = settings.hail;
    const g = settings.global;
    const count = Math.round(this.glitterEmitter.tick(dt, c.glitterRate * rime) * g.particleCount);
    if (count <= 0) return;

    this._centrePoint(_pos);
    _pos.y = 0.08;
    _emit.position = _pos;
    _emit.radius = this.radius;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.glitterSpeed;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.06;
    _emit.sizeVariance = 0.6;
    _emit.life = c.glitterLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.glitter.emit(count, _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * The chill runs out to the circle. There is no travelling front in the
   * ability itself — this is the reach, and it is over in a fifth of a second.
   */
  onTravel(dt) {
    this._syncParticles();
    this._syncStones(this._stormClock());
    this._syncFloor(Easing.outCubic(this.u), 0);
    this._mistFx(dt, this.u);

    // The light waits over the circle rather than riding the reach, because
    // the reach is not what anybody is looking at.
    this._centrePoint(this.position);
    this.position.y = 1.2;
  }

  onImpact() {
    const c = settings.hail;
    const g = settings.global;

    // The one timestamp a cast records past the seed.
    this._stormAt = this.age;

    this._centrePoint(_pos);
    _pos.y = 0.6;
    this.ctx.bursts.spawn(BurstMode.FROST, _pos, {
      radius: c.chillBurst * 0.3,
      endRadius: c.chillBurst * g.explosionIntensity,
      life: 0.8,
      intensity: c.chillIntensity,
      opacity: 0.7,
      fresnel: 1.5,
      displace: 0.5,
      squash: 0.5,
      colorA: getColor(c.colorChillA),
      colorB: getColor(c.colorChillB),
      colorC: getColor(c.colorChillC)
    });

    this.ctx.flash.trigger(getColor(c.colorChillFlash), c.chillFlash * g.explosionIntensity);
  }

  /**
   * `t` runs 0..1 through the storm, then 1..2 through the hold.
   *
   * Both halves share this method because both of them are the same three
   * calls with different arguments — and because the last stone of a storm
   * lands a frame or two into the hold, and a phase boundary that stops
   * updating the projectile would leave it hanging in the air.
   */
  onFade(dt, t) {
    const c = settings.hail;

    if (t <= 1) {
      /* --- the storm --- */
      this._syncParticles();
      this._syncStones(this._stormClock());
      this._strikes();
      this._syncFloor(1, 0);

      // The mist thins as the cloud empties, on the same envelope the stones
      // arrive on — one curve driving two things is why the storm reads as a
      // single event rather than as a rain of props over a fog machine.
      const rate = this._envelopeRate();
      this._mistFx(dt, 0.35 + 0.65 * rate);
      this.ctx.shake.rumble(c.rumble * rate * settings.global.cameraShake, dt);
      return;
    }

    /* --- the hold: the frost closes, then the field thaws back --- */
    const k = saturate(t - 1);
    const rime = Easing.outCubic(saturate(k / Math.max(0.05, c.rimeShare)));
    const thawStart = saturate(c.thawStart);
    const thaw = Easing.inQuad(saturate((k - thawStart) / Math.max(0.05, 1 - thawStart)));

    this._syncParticles();
    this._syncStones(this._stormClock());
    this._strikes();
    this._syncFloor(1, rime, thaw, 1 - Easing.inCubic(thaw));

    this._mistFx(dt, 0.3 * (1 - thaw));
    this._glitterFx(dt, rime * (1 - thaw));
  }

  /**
   * The envelope's *rate* at the current moment, 0..1 of its own peak.
   *
   * The clock is the integral; this is the integrand, and the two are read on
   * the same frame from the same four sliders — so the mist and the rumble
   * cannot drift out of step with the stones.
   */
  _envelopeRate() {
    const c = settings.hail;
    const span = Math.max(0.05, c.stormTime);
    const x = saturate((this.age - this._stormAt - Math.max(0, c.stormLead)) / span);
    const p = clamp(c.stormPeak, 0.02, 0.98);
    const floor = saturate(c.stormFloor);
    const shape =
      x <= p
        ? Math.pow(x / p, Math.max(0.05, c.stormRamp))
        : Math.pow((1 - x) / (1 - p), Math.max(0.05, c.stormTail));
    return floor + (1 - floor) * saturate(shape);
  }

  onDestroy() {
    this.stones.reset();
    this.pocks.clearMarks();
  }

  dispose() {
    this.stones.dispose();
    this.pocks.dispose();
    this.material.dispose();
    super.dispose();
  }
}
