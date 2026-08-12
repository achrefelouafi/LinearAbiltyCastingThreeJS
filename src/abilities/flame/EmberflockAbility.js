import { InstancedBufferAttribute, Mesh, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { Swarm, Silhouette, LeadPath, swarmParams } from '../../vfx/Swarm.js';
import { createEmberTrailMaterial, setTrailGradient } from '../../materials/EmberTrailMaterial.js';
import { createBoltRibbonGeometry } from '../../assets/ProceduralGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../../utils/math.js';

/**
 * Hard ceiling on birds. The editor's `birds` slider clamps here, and the
 * trail strip is built for exactly this many instances so the two counts can
 * never disagree.
 */
const MAX_BIRDS = 48;
/**
 * Samples along one trail ribbon. Each sample is two evaluations of the flock
 * function, so this is the knob that decides what the trails cost: 32 × 48 × 2
 * is a hair over three thousand evaluations for the whole cast, which is
 * nothing next to the fill it draws.
 */
const TRAIL_NODES = 32;

/* --- module-scope scratch: the frame allocates nothing (I3) --- */
const _flock = swarmParams();
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _lead = new Vector3();
const _ground = new Vector3();

/**
 * EMBERFLIGHT — two dozen ember birds thrown down the aimed line.
 *
 * They gather at the caster's hand, stream downrange in a loose skein that
 * weaves and rolls as it goes, collapse onto a single point at the target, and
 * go up as a column of fire. Their trails outlive them by a beat.
 *
 * **THE TRICK — flocking, and specifically the roll.** The three behaviours a
 * boid solver spends its frame budget on are all closed-form here: *cohesion*
 * is a lag (a bird's home is the lead point as it was `lag` seconds ago, which
 * is one evaluation rather than a history buffer), *separation* is a bijection
 * onto a `latticeX × latticeY × latticeZ` grid (so two birds cannot claim the
 * same cell, and the n² neighbour term simply does not exist), and *banking*
 * is the second derivative of that position, sampled at t, t−h and t−2h.
 *
 * The bank is the one that matters and it is the reason this slot is not a
 * recolour of Cinder Fall's ember trail. A bird that turns without dropping the
 * inside wing reads as a spark on a curved path; the same geometry with the
 * roll switched on reads as a bird, immediately and unmistakably. `bank` is a
 * slider precisely so you can watch that flip happen. Set it to zero and the
 * ability stops being this ability.
 *
 * **The trails are not a recording.** The obvious implementation — a ring
 * buffer of past positions per bird — is a record of *metres*, and the moment
 * you drag `spacingSide` on a paused frame it leaves twenty-four ribbons
 * hanging behind where the birds used to be. So the trail is a second instanced
 * strip that evaluates the *same* flock function backwards in each bird's own
 * clock: the ribbon passes through its bird by construction, and every slider
 * that reshapes the flock reshapes the trails on the same frame. The two
 * materials share the *same uniform objects*, so one write in `Swarm.update()`
 * drives both and they cannot fall a frame out of step.
 *
 * The honest limitation, stated once. Because a trail is a probe of the
 * *current* field and not of the field as it was, a slider that changes shape
 * without changing time — `spacingSide`, `columnHeight` — moves the whole
 * ribbon rigidly rather than leaving a kink in it where the change happened.
 * Everything that is a function of the clock (`churn`, `wander`, `breathe`, the
 * lead's own travel) does trail correctly. The first version tried to buy the
 * column back by rewinding the lead past its endpoint; `leadAt()` clamps at
 * t = 1 and the flock simply stopped dead at the target, which looked far worse
 * than the rigid lift does.
 *
 * A cast captures exactly one number — the flock seed, which shifts the
 * separation lattice so two casts do not lay out the same formation. Every
 * metre, radian and second is resolved from `settings.emberflock` inside the
 * update loop, zero-length frames included.
 *
 * Two draw calls: the flock and its trails.
 */
export class EmberflockAbility extends Ability {
  constructor(context) {
    super('emberflock', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.flock = new Swarm(this.group, {
      capacity: MAX_BIRDS,
      silhouette: Silhouette.BIRD,
      additive: true,
      renderOrder: 13
    });

    /*
     * The trail strip. `createBoltRibbonGeometry` already hands out exactly the
     * attribute layout this wants — `position = (v, ±1, 0)` per vertex and one
     * `aStrand` index per instance — so the lightning ribbon and the ember
     * trail are the same buffer with two different vertex shaders over it.
     * Only the per-bird seed has to be added.
     */
    this.trailGeometry = createBoltRibbonGeometry(TRAIL_NODES, MAX_BIRDS);
    this.trailSeeds = new InstancedBufferAttribute(new Float32Array(MAX_BIRDS), 1);
    this.trailGeometry.setAttribute('aSeed', this.trailSeeds);

    this.trailMaterial = createEmberTrailMaterial(this.flock.uniforms);
    this.trailMesh = new Mesh(this.trailGeometry, this.trailMaterial);
    this.trailMesh.frustumCulled = false;
    this.trailMesh.matrixAutoUpdate = false;
    this.trailMesh.layers.set(LAYER.VFX);
    // Under the birds, so a bird always adds on top of its own tail.
    this.trailMesh.renderOrder = 11;
    this.group.add(this.trailMesh);

    /** Re-rolled per cast. The only thing a cast captures. */
    this._seed = 0;
    /** Birds drawn last frame — the HUD's instance readout. */
    this._live = 0;
    /** Metres of lead travel already paid out in char marks. */
    this._charDistance = 0;
    /** 0 while travelling, then `t` out of `onFade` — 0..1 hold, 1..2 blow-out. */
    this._beat = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The embers the flock sheds. Soft, buoyant, curling — this is the bulk of
    // what makes the line read as *fire* rather than as a formation of shapes.
    this.embers = particles.get('emberflock.embers', {
      capacity: 3200,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.embers.uniforms.uDrag.value = 1.5;
    this.embers.uniforms.uEndSize.value = 0.2;
    this.embers.uniforms.uSizeIn.value = 0.08;
    this.embers.uniforms.uFadeIn.value = 0.1;
    this.embers.uniforms.uFadeOut.value = 0.45;

    // Hard bright streaks off the wing tips. Velocity-stretched and under
    // gravity, so they fall out of the flock rather than drifting with it —
    // which is what stops the embers and the sparks reading as one system.
    this.sparks = particles.get('emberflock.sparks', {
      capacity: 2400,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.1;
    this.sparks.uniforms.uEndSize.value = 0.2;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.5;

    // Soot hanging on the line behind the flock. Non-additive so it occludes.
    this.smoke = particles.get('emberflock.smoke', {
      capacity: 1600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.smoke.uniforms.uDrag.value = 1.9;
    this.smoke.uniforms.uEndSize.value = 2.6;
    this.smoke.uniforms.uSizeIn.value = 0.14;
    this.smoke.uniforms.uFadeIn.value = 0.2;
    this.smoke.uniforms.uFadeOut.value = 0.32;

    this.emberEmitter = new RateEmitter();
    this.sparkEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
    this.columnEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** The flock plus its trails — one instance each, per bird, per mesh. */
  get instanceCount() {
    return this._live * 2;
  }

  get impactDuration() {
    return Math.max(0.05, settings.emberflock.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.emberflock.fadeTime);
  }

  /** Fire gutters. Same quantised stutter the bolt uses, on a slower clock. */
  lightShimmer() {
    const c = settings.emberflock;
    const step = Math.floor(this.age * Math.max(1, c.lightFlickerSpeed));
    const noise = Math.abs(Math.sin(step * 127.1) * 43758.5453) % 1;
    return 1 - saturate(c.lightFlicker) * noise;
  }

  /* ------------------------------------------------------------------ */
  /* The beats, as unitless fractions of live settings                    */
  /* ------------------------------------------------------------------ */

  /**
   * Seconds since the flock arrived. Zero while it is still on its way.
   *
   * Both clocks come off the base class, which is why nothing here has to hold
   * a stopwatch of its own: `impactTime` runs through the hold and `fadeTime`
   * picks up where it stops.
   */
  _sinceArrival() {
    return this.phase === AbilityPhase.TRAVEL ? 0 : this.impactTime + this.fadeTime;
  }

  /** 0..1 — how far the formation has squeezed onto its own lead point. */
  _collapse() {
    const c = settings.emberflock;
    return Easing.outCubic(saturate(this._sinceArrival() / Math.max(0.02, c.collapseTime)));
  }

  /** 0..1 — how far up the column has gone. Starts once the squeeze is done. */
  _rise() {
    const c = settings.emberflock;
    const since = this._sinceArrival() - c.collapseTime;
    return Easing.outCubic(saturate(since / Math.max(0.02, c.columnTime)));
  }

  /**
   * The reveal wave for the birds, 0..1.
   *
   * It ramps up as the flock forms at the hand and back down once the column
   * has topped out; `Swarm`'s `reveal` compares it against each bird's own dice
   * roll, so the flock appears and disappears bird by bird rather than as a
   * block, which is the difference between a flock arriving and a decal
   * switching on.
   */
  _birdReveal() {
    const c = settings.emberflock;
    const inWave = saturate(this.age / Math.max(0.02, c.revealTime));
    const dying = this._sinceArrival() - c.collapseTime - c.columnTime;
    const outWave = 1 - saturate(dying / Math.max(0.02, c.birdFade));
    return Math.min(inWave, outWave);
  }

  /** The same for the trails, held open by `trailPersist` seconds. */
  _trailReveal() {
    const c = settings.emberflock;
    const inWave = saturate(this.age / Math.max(0.02, c.revealTime));
    const dying = this._sinceArrival() - c.collapseTime - c.columnTime - c.birdFade - c.trailPersist;
    const outWave = 1 - saturate(dying / Math.max(0.02, c.trailFadeTime));
    return Math.min(inWave, outWave);
  }

  /**
   * Half the formation's lateral extent, metres — how far off the lead an
   * emitter may throw something and still be inside the flock.
   *
   * Resolved from the live lattice rather than remembered, so opening the
   * spacing on a paused frame widens the ember plume with it.
   */
  _flockRadius(collapse) {
    const c = settings.emberflock;
    const side = lerp(c.spacingSide, c.columnRadius, collapse);
    const cells = Math.max(1, Math.round(c.latticeX)) - 1;
    return cells * side * 0.5 + c.jitter + c.wander + c.size;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.emberEmitter.reset();
    this.sparkEmitter.reset();
    this.smokeEmitter.reset();
    this.columnEmitter.reset();
    this._charDistance = 0;
    this._beat = 0;

    this._seed = Math.random() * 100;
    this.flock.roll(this._seed);

    /*
     * Mirror the flock's per-bird seeds onto the trail strip. They have to be
     * the *same* numbers or every ribbon is threaded through the bird next to
     * the one it belongs to — which looks almost right, and is the sort of
     * almost-right that survives a review.
     */
    const source = this.flock.seeds.array;
    for (let i = 0; i < MAX_BIRDS; i++) this.trailSeeds.array[i] = source[i];
    this.trailSeeds.needsUpdate = true;

    this._sync();
    this._releaseFx();
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve the whole flock — and its trails — from live settings.
   *
   * Everything with a unit is read here, every frame, including a zero-length
   * one. The only inputs that are not settings are the phase clocks and the
   * cast's own frame.
   */
  _sync() {
    const c = settings.emberflock;
    const g = settings.global;
    const p = _flock;

    const travelling = this.phase === AbilityPhase.TRAVEL;
    const collapse = this._collapse();
    const rise = this._rise();
    // 1 through the hold, easing to 0 through the blow-out. Cubic so the last
    // embers hang on and then go, rather than dimming evenly.
    const master = this._beat <= 1 ? 1 : 1 - Easing.inCubic(saturate(this._beat - 1));
    // How much of the per-bird slop the squeeze takes out. One slider drives
    // jitter, breathe and wander together because they are the same idea.
    const loose = 1 - collapse * saturate(c.collapseTighten);

    this._live = Math.max(0, Math.min(MAX_BIRDS, Math.round(c.birds)));

    /* --- the lead ------------------------------------------------------ */
    p.count = this._live;
    p.leadMode = LeadPath.LINE;
    p.leadS = travelling ? this.u : 1;
    // d(s)/dt, so the shader can rewind the lead for the lagged ranks and for
    // every sample of every trail. Metres/second over metres — unitless, and
    // resolved from the live speed rather than from whatever the front did.
    p.leadRate = travelling ? (c.speed * g.speed) / Math.max(0.1, this.length) : 0;
    // The mid-span loft is pointless once the flock has arrived, and leaving it
    // in makes the collapse point sit above the target.
    p.leadRise = c.leadRise * (1 - collapse);
    p.handForward = c.handForward;
    p.handSide = c.handSide;
    p.handHeight = c.handHeight;
    p.endHeight = c.endHeight + c.columnHeight * rise;

    /* --- the formation ------------------------------------------------- */
    p.latticeX = c.latticeX;
    p.latticeY = c.latticeY;
    p.latticeZ = c.latticeZ;
    p.spacingSide = lerp(c.spacingSide, c.columnRadius, collapse);
    p.spacingUp = lerp(c.spacingUp, c.columnSpacing, collapse);
    p.lag = lerp(c.lag, c.columnLag, collapse);
    p.jitter = c.jitter * loose;
    p.churn = lerp(c.churn, c.columnChurn, collapse);
    p.breathe = c.breathe * loose;
    p.breatheRate = c.breatheRate;
    p.wander = c.wander * loose * g.turbulence;
    p.wanderScale = c.wanderScale * g.noiseFrequency;
    p.wanderSpeed = c.wanderSpeed * g.noiseSpeed;
    p.gather = c.gather;

    /* --- the body ------------------------------------------------------ */
    p.size = c.size;
    p.aspect = c.aspect;
    p.sizeJitter = c.sizeJitter * g.randomness;
    p.billboard = c.billboard;
    p.bank = c.bank;
    p.bankMax = c.bankMax;
    p.dihedral = c.dihedral;
    p.flapRate = c.flapRate;
    p.curl = c.wingCurl;
    p.edgeStretch = c.edgeStretch;
    p.reveal = this._birdReveal();
    p.revealSpread = c.revealSpread;

    /* --- the silhouette and its colour --------------------------------- */
    p.silhouette = Silhouette.BIRD;
    p.sweep = c.sweep;
    p.edgeGain = c.edgeGain;
    p.lit = c.lit;
    p.tint = c.tint;
    p.tintJitter = c.tintJitter;
    p.tintAlong = c.tintAlong;
    p.opacity = c.opacity * g.opacity * master;
    p.glow = c.glow * g.glow;
    p.softFade = c.softFade;

    this.flock.setBasis(this.origin, this.direction, this.side, this.length);
    this.flock.setColors(c.colorBirdA, c.colorBirdB, c.colorBirdC, c.colorBirdD);
    // The clock argument is ignored by design — the flock's churn runs on the
    // shared `uTime` so it does not restart every cast.
    this.flock.update(this.age, p);

    /* --- the trails ---------------------------------------------------- */
    // Written after the flock, because the flock's update is what wrote the
    // path uniforms these share.
    const t = this.trailMaterial.uniforms;
    t.uSpan.value = lerp(c.trailSpan, c.columnTrailSpan, collapse);
    t.uWidth.value = c.trailWidth;
    t.uWidthTaper.value = c.trailTaper;
    t.uLift.value = c.trailLift;
    t.uSag.value = c.trailSag;
    t.uWobble.value = c.trailWobble * loose * g.turbulence;
    t.uWobbleScale.value = c.trailWobbleScale * g.noiseFrequency;
    t.uWobbleSpeed.value = c.trailWobbleSpeed * g.noiseSpeed;
    t.uReveal.value = this._trailReveal();
    t.uRevealSpread.value = c.revealSpread;
    t.uFade.value = master;
    t.uTint.value = c.trailTint;
    t.uTintAlong.value = c.trailTintAlong;
    t.uTintJitter.value = c.trailTintJitter;
    t.uCore.value = c.trailCore;
    t.uHeadBias.value = c.trailHeadBias;
    t.uOpacity.value = c.trailOpacity * g.opacity;
    t.uGlow.value = c.trailGlow * g.glow;
    t.uSoftFade.value = c.trailSoftFade;
    setTrailGradient(this.trailMaterial, c.colorTrailA, c.colorTrailB, c.colorTrailC, c.colorTrailD);
    this.trailGeometry.instanceCount = this._live;
    this.trailMesh.visible = this._live > 0 && t.uReveal.value > 0.001;

    /* --- the particle systems ------------------------------------------ */
    this.embers.setGradient(
      getColor(c.colorEmberA),
      getColor(c.colorEmberB),
      getColor(c.colorEmberC),
      getColor(c.colorEmberD)
    );
    this.embers.uniforms.uGravity.value.set(0, c.emberRise, 0);
    this.embers.uniforms.uSizeScale.value = c.emberSize * g.particleSize * 7;
    this.embers.uniforms.uLifeScale.value = c.emberLifetime * 0.5 * g.particleLifetime;
    this.embers.uniforms.uSpeedScale.value = g.particleSpeed;
    this.embers.uniforms.uOpacity.value = g.opacity;
    this.embers.uniforms.uGlow.value = c.glow * 0.7 * g.glow;
    this.embers.uniforms.uTurbulence.value = c.emberTurbulence * g.turbulence;

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
    this.sparks.uniforms.uGlow.value = c.glow * 0.9 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
    this.sparks.uniforms.uTurbulence.value = 0.2 * g.turbulence;

    this.smoke.setGradient(
      getColor(c.colorSmokeA),
      getColor(c.colorSmokeB),
      getColor(c.colorSmokeC),
      getColor(c.colorSmokeD)
    );
    this.smoke.uniforms.uGravity.value.set(0, c.smokeRise, 0);
    this.smoke.uniforms.uSizeScale.value = c.smokeSize * g.particleSize;
    this.smoke.uniforms.uLifeScale.value = c.smokeLifetime * 0.5 * g.particleLifetime;
    this.smoke.uniforms.uSpeedScale.value = c.smokeSpeed * g.particleSpeed;
    this.smoke.uniforms.uOpacity.value = c.smokeOpacity * g.opacity;
    this.smoke.uniforms.uTurbulence.value = 0.4 * g.turbulence;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** The pop of sparks as the flock forms at the hand and leaves it. */
  _releaseFx() {
    const c = settings.emberflock;
    const g = settings.global;

    this.flock.leadPoint(_pos);

    _emit.position = _pos;
    _emit.radius = this._flockRadius(0) * 0.6;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.6).setY(0.5).normalize();
    _emit.speed = c.sparkSpeed * 1.3;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(c.gatherSparks * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  /**
   * Everything the flock sheds while it is in the air.
   *
   * @param {number} dt    seconds
   * @param {number} scale 0..1 — thinned once the flock is only holding
   * @param {number} collapse 0..1, so the plume narrows with the formation
   */
  _flockFx(dt, scale, collapse) {
    const c = settings.emberflock;
    const g = settings.global;
    const time = frame.uTime.value;
    const radius = this._flockRadius(collapse);

    this.flock.leadPoint(_lead);

    const emberCount = Math.round(this.emberEmitter.tick(dt, c.emberRate * scale) * g.particleCount);
    if (emberCount > 0) {
      // Behind the lead, not on it: the embers are what the flock has already
      // burnt, and spawning them at the head puts a bright cap on the front of
      // a formation that is supposed to be trailing fire.
      _pos.copy(_lead).addScaledVector(this.direction, -randRange(0, radius));
      _emit.position = _pos;
      _emit.radius = radius;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.emberSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.emberLifetime;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.embers.emit(emberCount, _emit);
    }

    const sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate * scale) * g.particleCount);
    if (sparkCount > 0) {
      _emit.position = _lead;
      _emit.radius = radius * 0.9;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.4).setY(0.35).normalize();
      _emit.speed = c.sparkSpeed;
      _emit.speedVariance = 0.9;
      _emit.spread = 1.0;
      _emit.size = 0.12;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime;
      _emit.lifeVariance = 0.6;
      _emit.spin = 0;
      _emit.time = time;
      this.sparks.emit(sparkCount, _emit);
    }

    const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * scale) * g.particleCount);
    if (smokeCount > 0) {
      _pos.copy(_lead).addScaledVector(this.direction, -randRange(0, radius * 2));
      _emit.position = _pos;
      _emit.radius = radius * 1.2;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.95;
      _emit.size = 0.8;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.35;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }
  }

  /** Char marks scorched into the floor under the flight path. */
  _groundFx() {
    const c = settings.emberflock;
    const step = 1 / Math.max(0.02, c.scorchRate);

    while (this.front - this._charDistance >= step) {
      this._charDistance += step;
      const s = saturate(this._charDistance / this.length);
      this.pointAt(s, _ground);
      // Jittered off the axis by the flock's own width, so the char reads as a
      // band the birds passed over rather than as a dotted centre line.
      const wander = this._flockRadius(0) * 0.7;
      _ground.x += this.side.x * randRange(-wander, wander);
      _ground.z += this.side.z * randRange(-wander, wander);

      this.ctx.decals.spawn(DecalType.SCORCH, _ground, {
        radius: c.scorchRadius * randRange(0.6, 1.3),
        life: c.scorchLife,
        intensity: c.scorchIntensity,
        colorA: getColor(c.colorScorch),
        colorB: getColor(c.colorCharEmber),
        height: 0.012
      });
    }
  }

  /** Embers fed into the column while it climbs. */
  _columnFx(dt, rise) {
    const c = settings.emberflock;
    const g = settings.global;
    // The feed dies as the column tops out; a chimney that keeps pumping after
    // it has stopped rising reads as a bonfire, not as a flock going up.
    const gate = rise > 0 ? 1 - rise * rise : 0;
    const count = Math.round(this.columnEmitter.tick(dt, c.columnEmbers * gate) * g.particleCount);
    if (count <= 0) return;

    this.pointAt(1, _pos);
    _pos.y = c.endHeight;
    _emit.position = _pos;
    _emit.radius = this._flockRadius(1) * 1.4;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.columnSpeed;
    _emit.speedVariance = 0.5;
    // Tight, because the column's whole read is that it is a *column*.
    _emit.spread = 0.16;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.13;
    _emit.sizeVariance = 0.8;
    _emit.life = c.emberLifetime * 1.4;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.embers.emit(count, _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._beat = 0;
    this._sync();

    // The light rides the flock, not the floor under it. `advance()` has
    // already put `position` on the ground line, so lift it onto the lead.
    this.flock.leadPoint(this.position);

    this._flockFx(dt, 1, 0);
    this._groundFx();

    this.ctx.shake.rumble(settings.emberflock.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.emberflock;
    const g = settings.global;
    const time = frame.uTime.value;

    this.pointAt(1, _pos);
    _pos.y = c.endHeight;

    /* the fireball the flock collapses into */
    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.65,
      intensity: c.burstIntensity,
      opacity: 0.9,
      fresnel: 1.4,
      displace: 0.75,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring across the floor under it */
    this.pointAt(1, _ground);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _ground, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.55,
      width: 0.06,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    this.ctx.decals.spawn(DecalType.SCORCH, _ground, {
      radius: c.scorchRadius * 3.2,
      life: c.scorchLife * 1.4,
      intensity: c.scorchIntensity * 1.4,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorCharEmber),
      height: 0.012
    });

    /* sparks and embers blown out of the collapse */
    _emit.position = _pos;
    _emit.radius = this._flockRadius(0) * 0.5;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.sparkSpeed * 2.0;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);

    _emit.speed = c.emberSpeed * 2.4;
    _emit.spread = 0.85;
    _emit.size = 0.12;
    _emit.life = c.emberLifetime;
    this.embers.emit(Math.round(c.burstEmbers * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      22
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.2 * g.explosionIntensity;
  }

  onFade(dt, t) {
    this._beat = t;
    this._sync();

    const rise = this._rise();
    // The light climbs with the column.
    this.flock.leadPoint(this.position);

    // Thinned as the flock dies, but never cut dead — a bird that is winking
    // out is still burning until the moment it does.
    const master = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
    this._flockFx(dt, master * (t <= 1 ? 0.7 : 0.35), this._collapse());
    this._columnFx(dt, rise);
  }

  onDestroy() {
    this._live = 0;
    this._beat = 0;
    this.flock.reset();
    this.trailGeometry.instanceCount = 0;
    this.trailMesh.visible = false;
    this.trailMaterial.uniforms.uFade.value = 0;
  }

  dispose() {
    this.flock.dispose();
    this.trailGeometry.dispose();
    this.trailMaterial.dispose();
    super.dispose();
  }
}
