import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { FilamentPaths, filamentLook } from '../../vfx/FilamentPaths.js';
import { Shell, ShellMode } from '../../vfx/Shell.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange, hash11 } from '../../utils/math.js';

/** Turns to radians. Named because it appears in three places and is not a dimension. */
const TAU = Math.PI * 2;

/**
 * Samples along one filament. Seventy-two, not the chain's ninety-six: an orbit
 * is a smooth curve with no corners to resolve, and the extra samples bought
 * nothing but vertices.
 */
const SAMPLES = 72;

/** Filament ceiling across the cage, the spike and the ring. */
const CAPACITY = 48;

/* Role slots on the shared strip, structural first — capacity is handed out in
 * role order, so the cage can never be starved by a ring wound up to sixteen. */
const ROLE_CAGE = 0;
const ROLE_SPIKE = 1;
const ROLE_RING = 2;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _orb = new Vector3();
const _pole = new Vector3();
const _from = new Vector3();
const _to = new Vector3();
const _pos = new Vector3();
const _dir = new Vector3();
const _emit = {};

/**
 * FULMINANT ORB — a caged ball of current that walks downrange.
 *
 * **The trick is that the filaments orbit rather than radiate.** Every other
 * storm slot draws a fan: filaments leaving a point and going outward. This one
 * draws great slow loops *around* a point, each on its own inclined plane with
 * its own ascending node, so from any angle you see filaments passing in front
 * of the orb and behind it. That is the whole read, and it is one `PathMode`:
 * `ORBIT`, on a `FilamentPaths` role, with `orbitTiltSpread` doing the work
 * that stops nine coplanar rings looking like one flat hoop.
 *
 * Inside the cage is a `Shell` in `PRESSURE` mode — ninety-five per cent
 * fresnel rim and almost no body. You are not really meant to see it; you are
 * meant to see that the filaments are going *around something*, and the rim is
 * what supplies the something. Winding `orbFill` up to 0.4 to check turns the
 * orb into a ball of fog and loses the cage entirely, which is how I know the
 * near-invisibility is load-bearing rather than shy.
 *
 * **The cage is sized against the shell, deliberately.** `orbitRadius` is a
 * multiple of `shell.radius`, not a metre count, which is the one derivation
 * invariant I5 allows — where the sharing *is* the design. It buys the impact
 * for free: the shell interpolates `orbRadius → orbRadiusEnd` on its own live
 * easing as `t` runs 0→1, and the cage opens with it, in step. The first
 * version authored both in metres and every time the two disagreed the
 * filaments ended up *inside* the shell, which looks like a bug because it is.
 *
 * **It travels at six and a half metres a second**, which is walking pace and
 * roughly a fifth of the slowest thing else in the sandbox. That is the point:
 * this is the slot where the travel is the spectacle. It bobs, it drifts off
 * the aim line on a rate deliberately not commensurate with the bob, and it
 * lays a light wake of burns on the floor as it goes.
 *
 * **It hums.** `lightShimmer()` is two sines beating against each other rather
 * than Storm Lance's hash quantised onto a step clock: a continuous wobble
 * instead of a hard stutter. Set `humBeat` to exactly 1 or 2 and the period
 * becomes countable and it reads as a pulse; the shipped 1.47 never quite
 * repeats, which is what a hum is.
 *
 * **The earthing spike holds no state at all.** A second `LINE` role stabs from
 * the orb down to the floor now and then, and it is retired — `count = 0` — on
 * every frame it is not wanted. Whether it is wanted is decided by quantising
 * the clock into `earthRate` slots a second and hashing the slot index against
 * the live `earthChance`; how long it lives inside its slot is `earthDuty`.
 * Nothing is captured, so all three are sliders that work on a standing effect.
 * The version before this kept a fired-at timestamp and a boolean and neither
 * of them could be moved by dragging anything.
 *
 * Three roles, one strip, plus the shell: **three draw calls** for the whole
 * cast.
 */
export class BallLightningAbility extends Ability {
  constructor(context) {
    super('balllightning', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.paths = new FilamentPaths(this.group, {
      samples: SAMPLES,
      capacity: CAPACITY,
      renderOrder: 11
    });
    this.cageRole = this.paths.role(ROLE_CAGE);
    this.spikeRole = this.paths.role(ROLE_SPIKE);
    this.ringRole = this.paths.role(ROLE_RING);

    // PRESSURE sweeps its polar angle a full half-turn, so it is a ball rather
    // than the dome the same grid draws at a quarter turn.
    this.shell = new Shell({
      mode: ShellMode.PRESSURE,
      prefix: 'orb',
      nodes: 48,
      sides: 48,
      renderOrder: 14
    });
    this.group.add(this.shell.group);

    /** One look scratch, refilled from settings every frame. */
    this._look = filamentLook();

    /** The shell's per-frame state. Dice rolls and normalised time only. */
    this._state = {
      origin: new Vector3(),
      axis: new Vector3(0, 1, 0),
      side: new Vector3(1, 0, 0),
      span: 0,
      t: 0,
      fade: 1,
      seed: 0
    };

    /** Re-rolled per cast so no two orbs wear the same cage. */
    this._seed = 0;
    /** 0..1 of the discharge. Set from the phase clock, never accumulated. */
    this._discharge = 0;
    /** When the orb landed, seconds of `age`. −1 until it has. */
    this._impactAt = -1;
    /** Metres of travel already paid out in wake burns. */
    this._wakeDistance = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The ionised air the orb drags with it. This is the system that does most
    // of the work while it travels — the cage is thin, and the motes are what
    // give the orb a volume to read against.
    this.motes = particles.get('balllightning.motes', {
      capacity: 2400,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 2.2;
    this.motes.uniforms.uEndSize.value = 0.18;
    this.motes.uniforms.uSizeIn.value = 0.06;
    this.motes.uniforms.uFadeIn.value = 0.1;
    this.motes.uniforms.uFadeOut.value = 0.45;

    // Sparks shed by the cage where a loop passes closest to the shell.
    this.sparks = particles.get('balllightning.sparks', {
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

    // Haze off the wake. Non-additive so it genuinely occludes.
    this.smoke = particles.get('balllightning.smoke', {
      capacity: 1200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.smoke.uniforms.uDrag.value = 1.8;
    this.smoke.uniforms.uEndSize.value = 3.0;
    this.smoke.uniforms.uSizeIn.value = 0.12;
    this.smoke.uniforms.uFadeIn.value = 0.16;
    this.smoke.uniforms.uFadeOut.value = 0.3;

    // Chips, at the discharge only.
    this.debris = particles.get('balllightning.debris', {
      capacity: 1000,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.debris.uniforms.uDrag.value = 0.25;
    this.debris.uniforms.uEndSize.value = 0.8;
    this.debris.uniforms.uFadeOut.value = 0.7;

    this.moteEmitter = new RateEmitter();
    this.sparkEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.paths.liveCount + this.shell.instanceCount;
  }

  get impactDuration() {
    return Math.max(0.05, settings.balllightning.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.balllightning.fadeTime);
  }

  /**
   * The hum.
   *
   * Two sines whose rates are in a deliberately awkward ratio, summed and
   * folded into 0..1. The bolt's `lightShimmer()` floors a hash onto a step
   * clock and snaps between levels, which is right for something discharging
   * and wrong for something *sustaining*: the first attempt here reused that
   * code with a lower rate and the orb read as a strobe running slowly rather
   * than as a thing under continuous load.
   */
  lightShimmer() {
    const c = settings.balllightning;
    const first = Math.sin(this.age * c.humRate * TAU);
    const second = Math.sin(this.age * c.humRate * c.humBeat * TAU + 1.7);
    return 1 - saturate(c.humDepth) * (0.5 - 0.25 * (first + second));
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /**
   * Where the orb is, in world space.
   *
   * The bob and the drift are evaluated from `age` rather than integrated, so
   * they are exact on a zero-length frame and dragging `bobAmp` moves a
   * standing orb instead of only affecting it from here on.
   */
  _orbPoint(out) {
    const c = settings.balllightning;
    const u = saturate(this.u);
    this.pointAt(u, out);
    // The forward offset and the lateral offset both ease out of the hand, so
    // the orb leaves the caster rather than appearing beside them.
    out.addScaledVector(this.direction, c.handForward * (1 - u));
    out.addScaledVector(this.side, c.handSide * (1 - u));
    out.addScaledVector(this.side, Math.sin(this.age * c.wanderRate * TAU) * c.wanderAmp * u);
    out.y = lerp(c.handHeight, c.endHeight, u) + Math.sin(this.age * c.bobRate * TAU) * c.bobAmp;
    return out;
  }

  /**
   * Brightness of the earthing spike, 0 when there is not one.
   *
   * Stateless by construction — see the class header. Once the orb has landed
   * the spike is permanent: it is no longer "occasionally earthing", it is
   * grounded and pouring.
   */
  _spikeLevel(c) {
    if (this.phase !== AbilityPhase.TRAVEL) return 1;
    const rate = Math.max(0.05, c.earthRate);
    const slot = Math.floor(this.age * rate);
    if (hash11(this._seed * 3.17 + slot * 61.7) >= saturate(c.earthChance)) return 0;
    const within = this.age * rate - slot;
    return 1 - saturate(within / Math.max(0.02, c.earthDuty));
  }

  /** Where on the shell the current spike leaves. A hash of the slot index. */
  _spikeFrom(c, out) {
    const rate = Math.max(0.05, c.earthRate);
    const slot = Math.floor(this.age * rate);
    const angle = hash11(this._seed + slot * 17.31) * TAU;
    const r = this.shell.radius;
    this._orbPoint(out);
    out.addScaledVector(this.side, Math.cos(angle) * r * c.spikeExit);
    out.addScaledVector(this.direction, Math.sin(angle) * r * c.spikeExit);
    out.y -= r * c.spikeDrop;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /** Refill the shared ribbon look from live settings. */
  _fillLook() {
    const c = settings.balllightning;
    const g = settings.global;
    const l = this._look;

    l.width = c.width;
    l.glowWidth = c.glowWidth;
    l.glowOpacity = c.glowOpacity;
    l.jitter = c.jitter;
    l.jitterScale = c.jitterScale;
    l.octaves = c.octaves;
    l.jitterFalloff = c.jitterFalloff;
    l.crawl = c.crawl;
    l.pinch = c.pinch;
    l.restrike = c.restrike;
    l.flicker = c.flicker;
    l.flickerSpeed = c.flickerSpeed;
    l.strandFlash = c.strandFlash;
    l.coreSharp = c.coreSharp;
    l.glowFalloff = c.glowFalloff;
    l.softFade = c.softFade;
    l.opacity = c.opacity;
    l.glow = c.glow;
    l.colorCore = c.colorCore;
    l.colorInner = c.colorInner;
    l.colorOuter = c.colorOuter;
    l.colorHalo = c.colorHalo;

    l.randomness = g.randomness;
    l.noiseStrength = g.noiseStrength;
    l.noiseFrequency = g.noiseFrequency;
    l.noiseSpeed = g.noiseSpeed;
    l.opacityScale = g.opacity;
    l.glowScale = g.glow;
  }

  /**
   * One whole frame of the orb: the shell, then the three roles, then the sync.
   *
   * The shell goes first and it has to. Two of the three roles are sized in
   * multiples of `shell.radius`, and that getter only means anything after
   * `sync()` has re-resolved `orbRadius → orbRadiusEnd` against this frame's
   * `t`. Configuring the cage first gets you last frame's radius, which during
   * the discharge — when the radius is moving fastest — reads as the filaments
   * lagging a frame behind the thing they are supposed to be caging.
   *
   * @param {number} fade 1 while lit, ramping to 0 as it dies
   */
  _sync(fade) {
    const c = settings.balllightning;
    const g = settings.global;
    const state = this._state;

    this._orbPoint(state.origin);
    state.axis.set(0, 1, 0);
    state.side.copy(this.side);
    state.span = this.length;
    state.t = this._discharge;
    state.fade = fade;
    state.seed = this._seed;
    this.shell.sync(c, state, g);

    this._fillLook();
    this._syncCage(c, fade);
    this._syncSpike(c, fade);
    this._syncRing(c, fade);
    this.paths.sync(this._look, fade, this._seed);
  }

  /**
   * The cage: `ORBIT`, the one mode in the library whose filaments circle a
   * point instead of leaving it.
   *
   * `pole` is a *point* along the mean orbital axis, not a direction, so it is
   * built each frame from the orb's own position — leaning along the heading by
   * `orbitLean` metres, which tips the whole cage into the direction of travel
   * and is most of why it reads as being carried rather than as a decoration
   * hung in place.
   */
  _syncCage(c, fade) {
    const role = this.cageRole;
    const count = Math.round(c.orbitCount * (this._impactAt < 0 ? 1 : c.orbitBurst));
    if (count < 1) return void role.retire();

    this._orbPoint(_orb);
    _pole.copy(_orb).addScaledVector(this.direction, c.orbitLean);
    _pole.y += 1;

    role.count = count;
    role.orbit(
      _orb,
      _pole,
      this.shell.radius * c.orbitRadius,
      c.orbitArc,
      c.orbitSpin,
      c.orbitWobble,
      c.orbitTilt,
      c.orbitTiltSpread,
      c.orbitJitter
    );
    role.style(c.orbitKink, c.orbitWidth, c.orbitDim * fade, c.orbitGroundDamp);
    // Both ends loose and tapered: a loop with square ends reads as a cut pipe.
    role.ends(1, 1, 1, 1);
    role.draw(2, 0.1, -1e4, 0);
  }

  /** The occasional earthing spike, and the permanent one after it lands. */
  _syncSpike(c, fade) {
    const role = this.spikeRole;
    const level = this._spikeLevel(c);
    if (level <= 0) return void role.retire();

    const grounded = this._impactAt >= 0;
    role.count = Math.max(1, Math.round(c.spikeStrands * (grounded ? c.spikeBurst : 1)));

    this._spikeFrom(c, _from);
    _to.copy(_from);
    // Guard the degenerate case where the orb has sunk to the clamp height: a
    // zero-length LINE gives the shader a null tangent and the ribbon folds.
    _to.y = Math.min(c.spikeFloor, _from.y - 0.05);
    _to.addScaledVector(this.side, (hash11(this._seed + 4.9) - 0.5) * 2 * c.spikeWander);

    role.line(
      _from,
      _to,
      c.spikeSag,
      c.spikeNear,
      c.spikeSpread,
      c.spikeCurve,
      c.spikeTwist,
      c.spikeTwistSpeed,
      c.spikeConverge
    );
    role.style(c.spikeKink, c.spikeWidth, c.spikeDim * level * fade, c.spikeGroundDamp);
    role.ends(0, 1, 0, 1);
    role.draw(2, 0.12, c.spikeFloor, c.spikeTipGlow);
  }

  /**
   * The ring of ground current the discharge lays down.
   *
   * `RIM` rather than a radial fan: arcs *travelling around* the footprint,
   * hopping at mid-span, which keeps the discharge circular the way the cage
   * was circular. A fan out of the centre would have been the obvious thing and
   * it made the landing look like a completely different ability.
   */
  _syncRing(c, fade) {
    const role = this.ringRole;
    if (this._impactAt < 0 || c.ringCount < 1) return void role.retire();

    const since = this.age - this._impactAt;
    const grow = saturate(since / Math.max(0.02, c.ringGrow));

    this.pointAt(1, _from);
    _from.y = c.ringFloor;
    _pole.set(_from.x, _from.y + 1, _from.z);

    role.count = Math.round(c.ringCount);
    role.rim(
      _from,
      _pole,
      this.shell.radius * c.ringRadius,
      c.ringSpan,
      c.ringSpeed,
      c.ringLift,
      c.ringJitter,
      c.ringHug,
      c.ringPhase
    );
    role.style(c.ringKink, c.ringWidth, c.ringDim * fade, c.ringGroundDamp);
    role.ends(1, 1, 1, 1);
    role.draw(grow + c.ringTip, c.ringTip, c.ringFloor, c.ringTipGlow);
  }

  /** Push the live gradients and scales into all four particle systems. */
  _syncParticles() {
    const c = settings.balllightning;
    const g = settings.global;

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
    this.motes.uniforms.uGlow.value = c.glow * 0.5 * g.glow;
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
    this.sparks.uniforms.uGlow.value = c.glow * 0.6 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
    this.sparks.uniforms.uTurbulence.value = 0.25 * g.turbulence;

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
    this.smoke.uniforms.uTurbulence.value = 0.35 * g.turbulence;

    this.debris.setGradient(
      getColor(c.colorDebrisA),
      getColor(c.colorDebrisB),
      getColor(c.colorDebrisC),
      getColor(c.colorDebrisD)
    );
    this.debris.uniforms.uGravity.value.set(0, c.debrisGravity, 0);
    this.debris.uniforms.uSizeScale.value = c.debrisSize * g.particleSize * 7;
    this.debris.uniforms.uLifeScale.value = c.debrisLifetime * 0.5 * g.particleLifetime;
    this.debris.uniforms.uSpeedScale.value = g.particleSpeed;
    this.debris.uniforms.uOpacity.value = g.opacity;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Motes, sparks and smoke shed while the orb is alive.
   *
   * Motes are born on the shell rather than at its centre — `moteShell` is a
   * multiple of the live radius — so they fall away from the surface the cage
   * is wrapped around instead of squirting out of a point inside it.
   *
   * @param {number} scale 0..1 — thinned once the orb is only discharging
   */
  _orbFx(dt, scale) {
    const c = settings.balllightning;
    const g = settings.global;
    const time = frame.uTime.value;
    const radius = this.shell.radius;

    this._orbPoint(_orb);

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      _emit.position = _orb;
      _emit.radius = radius * c.moteShell;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.08;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    const sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate * scale) * g.particleCount);
    if (sparkCount > 0) {
      _emit.position = _orb;
      _emit.radius = radius * c.orbitRadius;
      _emit.direction = _dir.set(0, -1, 0);
      _emit.speed = c.sparkSpeed;
      _emit.speedVariance = 0.9;
      _emit.spread = 1.0;
      _emit.size = 0.14;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      _emit.time = time;
      this.sparks.emit(sparkCount, _emit);
    }

    const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * scale) * g.particleCount);
    if (smokeCount > 0) {
      // Off the floor under the orb — it is the wake smouldering, not the orb.
      _pos.set(_orb.x, 0.15, _orb.z);
      _emit.position = _pos;
      _emit.radius = c.scorchRadius * 2.2;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.9;
      _emit.size = 0.8;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.4;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }
  }

  /** The wake of burns the orb leaves on the floor as it passes over it. */
  _wakeFx() {
    const c = settings.balllightning;
    const step = 1 / Math.max(0.05, c.wakeRate);

    while (this.front - this._wakeDistance >= step) {
      this._wakeDistance += step;
      const s = saturate(this._wakeDistance / this.length);
      this.pointAt(s, _pos);

      this.ctx.decals.spawn(DecalType.ARC, _pos, {
        radius: c.wakeRadius * randRange(0.7, 1.2),
        life: c.wakeLife,
        width: c.wakeBranches,
        intensity: c.wakeIntensity,
        colorA: getColor(c.colorEmber),
        colorB: getColor(c.colorArc)
      });
      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: c.scorchRadius * randRange(0.7, 1.3),
        life: c.scorchLife,
        intensity: c.scorchIntensity,
        colorA: getColor(c.colorScorch),
        colorB: getColor(c.colorEmber),
        height: 0.015
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this.sparkEmitter.reset();
    this.smokeEmitter.reset();

    // The one thing a cast captures.
    this._seed = Math.random() * 100;
    this._discharge = 0;
    this._impactAt = -1;
    this._wakeDistance = 0;

    this._syncParticles();
    this._sync(1);
    this._orbPoint(this.position);

    const c = settings.balllightning;
    const g = settings.global;
    this._orbPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.STORM, _pos, {
      radius: c.muzzleSize * 0.2,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.35,
      intensity: c.muzzleIntensity,
      opacity: 0.9,
      fresnel: 1.5,
      displace: 0.4,
      colorA: getColor(c.colorMuzzleA),
      colorB: getColor(c.colorMuzzleB),
      colorC: getColor(c.colorMuzzleC)
    });
    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
  }

  onTravel(dt) {
    this._sync(1);
    this._syncParticles();
    // The light rides the orb, not the floor line the base class put it on.
    this._orbPoint(this.position);

    this._orbFx(dt, 1);
    this._wakeFx();
    this.ctx.shake.rumble(settings.balllightning.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.balllightning;
    const g = settings.global;
    const time = frame.uTime.value;

    this._impactAt = this.age;
    this._orbPoint(_orb);
    this.pointAt(1, _pos);

    /* the shell of ionised air the cage becomes */
    this.ctx.bursts.spawn(BurstMode.STORM, _orb, {
      radius: c.burstSize * 0.2,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.8,
      intensity: c.burstIntensity,
      opacity: 0.9,
      fresnel: 1.6,
      displace: 0.55,
      squash: 0.85,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring that snaps outward across the floor */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.7,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* a wide burn where it grounded out — the wake burn, scaled up */
    this.ctx.decals.spawn(DecalType.ARC, _pos, {
      radius: c.wakeRadius * 3.4,
      life: c.wakeLife * 1.8,
      width: c.wakeBranches,
      intensity: c.wakeIntensity * 1.6,
      colorA: getColor(c.colorEmber),
      colorB: getColor(c.colorArc)
    });
    this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
      radius: c.scorchRadius * 3.0,
      life: c.scorchLife * 1.4,
      intensity: c.scorchIntensity * 1.4,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorEmber),
      height: 0.015
    });

    /* the cage letting go */
    _emit.position = _orb;
    _emit.radius = 0.35;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.4).setY(0.7).normalize();
    _emit.speed = c.sparkSpeed * 2.6;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.2;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime * 1.6;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);

    _emit.radius = this.shell.radius;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed * 3.0;
    _emit.spread = 1.0;
    _emit.size = 0.1;
    _emit.life = c.moteLifetime * 1.4;
    this.motes.emit(Math.round(c.burstMotes * g.particleCount), _emit);

    _emit.position = _pos;
    _emit.radius = c.scorchRadius * 2.4;
    _emit.speed = c.debrisSpeed * 1.8;
    _emit.spread = 0.85;
    _emit.size = 0.14;
    _emit.life = c.debrisLifetime * 1.3;
    _emit.spin = 10;
    this.debris.emit(Math.round(c.burstDebris * g.particleCount), _emit);

    _emit.speed = c.smokeSpeed * 2.4;
    _emit.spread = 1.0;
    _emit.size = 1.4;
    _emit.life = c.smokeLifetime * 1.3;
    _emit.spin = 0.5;
    this.smoke.emit(Math.round(38 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      24
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.impactLightPunch * g.explosionIntensity;
  }

  onFade(dt, t) {
    // `t` runs 0..1 through the discharge, then 1..2 as it dies. The shell's
    // own expansion is driven by the first half and holds through the second,
    // so the discharge opens and then goes out rather than opening twice.
    this._discharge = saturate(t);
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));

    this._sync(fade);
    this._syncParticles();
    this._orbPoint(this.position);
    this._orbFx(dt, fade * lerp(0.7, 0.2, saturate(t - 1)));
  }

  onDestroy() {
    this.paths.clear();
    this._discharge = 0;
    this._impactAt = -1;
    this._wakeDistance = 0;
  }

  dispose() {
    this.paths.dispose();
    this.shell.dispose();
    super.dispose();
  }
}
