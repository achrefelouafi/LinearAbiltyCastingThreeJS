import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { Tube, TubePath } from '../../vfx/Tube.js';
import { Shell, ShellMode } from '../../vfx/Shell.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../../utils/math.js';

/**
 * Samples along the lash. A whip is one long curve with a *tight* Gaussian lobe
 * running down it — at 96 nodes the lobe is about fifteen segments wide at the
 * shipped `lashWaveWidth` and its shoulders visibly facet, which reads as a
 * kink in the leather rather than as a loop. 128 is where that stops.
 */
const LASH_NODES = 128;
/**
 * Facets around the barrel. The lash is ten centimetres thick and is never
 * looked at from closer than a couple of metres, so the beam's 26 is money
 * spent on nothing; 14 holds the silhouette and halves the vertex count.
 */
const LASH_SIDES = 14;
/**
 * Points along the lash one frame's embers are split between. One origin makes
 * every batch read as a starburst pinned to a spot — the same lesson the bolt's
 * sparks learnt.
 */
const EMBER_BATCHES = 5;

const _pos = new Vector3();
const _dir = new Vector3();
const _rel = new Vector3();
const _emit = {};

/**
 * FIREWHIP — Ashen Lash.
 *
 * A burning lash thrown along the aimed line in four beats: it winds up (a loop
 * forms in the leather at the handle), it goes (the lash reaches full extension
 * and the loop starts down it), it **cracks**, and then it falls and burns out,
 * dropping embers along its own curve and shedding ash the whole way.
 *
 * **THE TRICK — the crack is a real event in the geometry, not a scheduled
 * effect.** `vfx/Tube.js`'s WHIP path carries a Gaussian curvature lobe
 * travelling handle → tip, and it conserves arc length: the lateral throw of
 * the loop is paid for out of the *axial* extent, so the tip is hauled back
 * while the loop is mid-whip and let go as the loop runs off the end. That is a
 * speed spike, and it belongs to the curve rather than to a clock — the tube
 * differentiates its own axis with respect to the wave phase, which is why
 * `tipSpeed` is correct on a **zero-length frame**. This ability does exactly
 * one thing with it: it calls `sync()`, polls `lash.crack.fired` on the very
 * next line, and if it is set, fires the shock ring *there*, at
 * `lash.crack.point`, with a strength taken from `crack.speed / waveSpeed`.
 * There is no timer anywhere in this file. Drag `lashWaveRate` mid-cast and the
 * bang moves; drag `lashWaveAmp` below about `0.6 × lashWaveWidth` and it stops
 * cracking at all, which is correct, because a slack whip does not bang.
 *
 * The first version *did* schedule it — a `crackTime` slider, fired at
 * `age > crackTime`, with the ring parented to `pointAt(1)`. It looked
 * plausible in isolation and fell apart the moment anything was dragged: the
 * bang arrived while the loop was still halfway down the lash, or after it had
 * run off the end, and the ring sat at the far end of the *cast* rather than at
 * the end of the *whip*, which are thirty-five centimetres apart at the worst
 * of the arc-length shortening. The tube already knew all of this. Asking it
 * was three lines.
 *
 * **What a cast captures.** One seed, one timestamp (`_crackAt`), and the crack
 * position as three *fractions of the cast length* — along, lateral and lift.
 * Not one metre. The ring's anchor is rebuilt from those fractions against the
 * live `length` on every frame, so it stays welded to the lash when `range` is
 * dragged with the clock stopped, and the ring's own radius, expansion and
 * colour are re-resolved from `settings.firewhip` by `Shell#sync` the same way.
 */
export class FirewhipAbility extends Ability {
  constructor(context) {
    super('firewhip', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    // The lash. Three draw calls: halo, sheath, core — the inversion in the
    // middle layer is what stops it reading as a lit pipe.
    this.lash = new Tube({
      path: TubePath.WHIP,
      prefix: 'lash',
      nodes: LASH_NODES,
      sides: LASH_SIDES,
      renderOrder: 11
    });
    this.group.add(this.lash.group);

    // The shock ring. A PRESSURE shell squashed along its own axis is a lens,
    // and a lens whose axis is the lash's heading is a ring standing across the
    // whip — which is what a crack throws off. A DOME would have stood it on
    // the floor, and the crack happens in the air.
    this.ring = new Shell({
      mode: ShellMode.PRESSURE,
      prefix: 'crack',
      nodes: 28,
      sides: 44,
      renderOrder: 14
    });
    this.ring.visible = false;
    this.group.add(this.ring.group);

    /* --- what a cast captures: a dice roll, a timestamp, three fractions --- */
    /** Re-rolled per cast so two lashes do not kink identically. */
    this._seed = 0;
    /** Seconds since spawn at which the crack fired; < 0 for "not yet". */
    this._crackAt = -1;
    /** Where it fired, as fractions of `length` in the cast's own frame. */
    this._crackAlong = 0;
    this._crackSide = 0;
    this._crackLift = 0;
    /** `crack.speed / waveSpeed` — unitless, and how hard everything hits. */
    this._crackPower = 1;
    /** How far the lash has fallen, 0..1. Rewritten every frame. */
    this._fall = 0;

    // Scratch handed to the two modules each frame. One object each, reused —
    // syncing the whole ability allocates nothing (I3).
    this._state = {
      origin: new Vector3(),
      target: new Vector3(),
      side: new Vector3(),
      progress: 0,
      fade: 1,
      widthFade: 1,
      seed: 0,
      time: 0
    };
    this._ringState = {
      origin: new Vector3(),
      axis: new Vector3(0, 0, 1),
      side: new Vector3(1, 0, 0),
      span: 1,
      t: 0,
      fade: 1,
      seed: 0
    };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Embers: velocity-stretched streaks under a light gravity. Not sparks —
    // an ember is a piece of the fire that came off, so it is slow, it is big,
    // and it falls at a third of the rate a spark does.
    this.embers = particles.get('firewhip.embers', {
      capacity: 2600,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.3
    });
    this.embers.uniforms.uDrag.value = 1.1;
    this.embers.uniforms.uEndSize.value = 0.15;
    this.embers.uniforms.uSizeIn.value = 0.05;
    this.embers.uniforms.uFadeIn.value = 0.06;
    this.embers.uniforms.uFadeOut.value = 0.5;

    // Ash flakes. Lit rather than additive, because ash is the one thing in a
    // fire effect that is *darker* than what is behind it — additive ash is
    // just more fire, and the flakes stop reading the moment they cross the
    // lash. `curl` gives them the flutter.
    this.ash = particles.get('firewhip.ash', {
      capacity: 1800,
      shape: ParticleShape.LEAF,
      additive: false,
      lit: true,
      curl: true,
      softFade: 0.35
    });
    this.ash.uniforms.uDrag.value = 2.2;
    this.ash.uniforms.uEndSize.value = 0.9;
    this.ash.uniforms.uSizeIn.value = 0.1;
    this.ash.uniforms.uFadeIn.value = 0.12;
    this.ash.uniforms.uFadeOut.value = 0.45;

    // Thin haze off the burn. Non-additive so it genuinely occludes.
    this.smoke = particles.get('firewhip.smoke', {
      capacity: 1400,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.smoke.uniforms.uDrag.value = 1.7;
    this.smoke.uniforms.uEndSize.value = 3.2;
    this.smoke.uniforms.uSizeIn.value = 0.14;
    this.smoke.uniforms.uFadeIn.value = 0.2;
    this.smoke.uniforms.uFadeOut.value = 0.35;

    this.emberEmitter = new RateEmitter();
    this.ashEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
    this.scorchEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** Halo + sheath + core, and the ring once it exists. HUD readout only. */
  get instanceCount() {
    return this.lash.drawCalls + (this.ring.visible ? this.ring.drawCalls : 0);
  }

  /** The lash hangs at full extension — the crack lands inside this beat. */
  get impactDuration() {
    return Math.max(0.05, settings.firewhip.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.firewhip.fadeTime);
  }

  /**
   * Firelight gutters on two clocks at once: a slow breath from the body of the
   * flame and a quantised stutter from the embers coming off it. A pure sine
   * reads as a lamp on a dimmer, and the Storm Lance's hard hash reads as
   * electricity — this wants to sit between them.
   */
  lightShimmer() {
    const c = settings.firewhip;
    const depth = saturate(c.lightFlicker);
    const step = Math.floor(this.age * Math.max(1, c.lightFlickerSpeed));
    const stutter = Math.abs(Math.sin(step * 91.7) * 43758.5453) % 1;
    const breath = 0.5 - 0.5 * Math.cos(this.age * 6.1);
    return 1 - depth * (0.65 * stutter + 0.35 * breath);
  }

  /* ------------------------------------------------------------------ */
  /* The lash's geometry — every metre resolved from live settings        */
  /* ------------------------------------------------------------------ */

  /**
   * The handle, in world space.
   *
   * The base class puts `origin` on the floor because that is what the aim
   * arrow targets. A whip comes out of a hand.
   */
  _handPoint(out) {
    const c = settings.firewhip;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** The far end of the lash — which comes down as it falls. */
  _endPoint(out) {
    const c = settings.firewhip;
    this.pointAt(1, out);
    out.y = lerp(c.tipHeight, c.fallHeight, this._fall);
    return out;
  }

  /**
   * How far the lash has come down, 0..1.
   *
   * Measured from the **crack**, not from the phase clock: the crack is what
   * takes the energy out of the whip, so the fall has to start there or the
   * lash reads as dropping on a schedule that has nothing to do with what you
   * just watched. `phaseT` is a floor under it purely so that a whip tuned
   * slack enough never to crack still comes down before the cast ends.
   */
  _fallAmount(phaseT) {
    const c = settings.firewhip;
    let k = 0;
    if (this._crackAt >= 0) k = saturate((this.age - this._crackAt) / Math.max(0.05, c.fallTime));
    if (phaseT > 1) k = Math.max(k, saturate(phaseT - 1));
    return Math.pow(k, Math.max(0.05, c.fallCurve));
  }

  /**
   * How much of the lash exists, 0..1.
   *
   * During the wind-up only the first `windUpReach` of it is drawn, which is
   * where the loop is: a whip being cocked is a curl of leather at the hand and
   * nothing else. After release the front takes over, but never falls below the
   * wind-up reach, because a lash that shortens at the moment you throw it
   * looks like a bug and took an embarrassingly long time to spot.
   */
  _progress() {
    const c = settings.firewhip;
    const wind = Math.max(0, c.windUp);
    if (this.phase !== AbilityPhase.TRAVEL) return 1;
    if (this.age < wind) {
      return saturate(c.windUpReach * Easing.outQuad(saturate(this.age / Math.max(0.01, wind))));
    }
    return Math.max(this.u, saturate(c.windUpReach));
  }

  /**
   * Where the crack happened, rebuilt from the three fractions the cast
   * captured against the live cast frame.
   *
   * This is the I1-clean half of "fire the ring at the tip". The tube hands
   * back a world position in metres; keeping that would freeze the ring in
   * space the moment anybody dragged `range`. Storing it as fractions of the
   * span costs three dot products at the crack and buys a ring that follows the
   * cast it belongs to.
   */
  _crackPoint(out) {
    out
      .copy(this.origin)
      .addScaledVector(this.direction, this._crackAlong * this.length)
      .addScaledVector(this.side, this._crackSide * this.length);
    out.y = this._crackLift * this.length;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Hold the front at the hand while the loop forms.
   *
   * The wind-up beat, bought exactly the way Nova Beam buys its charge: by
   * refusing to let `advance()` leave the caster. The base class's ease off the
   * standstill is kept, but keyed off the moment of *release* rather than the
   * moment of the cast.
   */
  advance(dt) {
    const c = this.config;
    const wind = Math.max(0, c.windUp);
    if (this.age < wind) {
      this.front = 0;
      this.u = 0;
      this.pointAt(0, this.position);
      return false;
    }

    const speed = c.speed * settings.global.speed;
    const since = this.age - wind;
    this.front += speed * Easing.outQuad(saturate(since / 0.06)) * dt;

    const previousU = this.u;
    this.u = saturate(this.front / this.length);
    this.pointAt(this.u, this.position);
    return this.u >= 1 && previousU < 1;
  }

  onSpawn() {
    this.emberEmitter.reset();
    this.ashEmitter.reset();
    this.smokeEmitter.reset();
    this.scorchEmitter.reset();

    this._seed = Math.random() * 100;
    this._crackAt = -1;
    this._crackAlong = 1;
    this._crackSide = 0;
    this._crackLift = 0;
    this._crackPower = 1;
    this._fall = 0;
    this.ring.visible = false;

    // One sync before anything else runs, so the tube's crack edge-detector is
    // disarmed at wave phase zero rather than wherever the last cast left it.
    this._syncLash(1, 1, 0);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the cast state into the lash — **and poll the
   * crack on the very next line.**
   *
   * The poll belongs here and nowhere else. `Tube#sync` recomputes
   * `tipSpeed`, `waveSpeed` and the crack edge every time it runs; anything
   * that syncs the tube and then does something else first is one frame late,
   * and one frame at these speeds is a metre and a half of lash.
   *
   * @param {number} fade       1 while the lash is lit, ramping to 0 as it dies
   * @param {number} widthFade  the collapse to a burning thread
   * @param {number} phaseT     0..1 through the impact, then 1..2 through the fade
   */
  _syncLash(fade, widthFade, phaseT) {
    const c = settings.firewhip;
    const g = settings.global;
    const state = this._state;

    this._fall = this._fallAmount(phaseT);

    this._handPoint(state.origin);
    this._endPoint(state.target);
    state.side.copy(this.side);
    state.progress = this._progress();
    state.fade = fade;
    state.widthFade = widthFade;
    state.seed = this._seed;
    // Seconds since the lash was *released*, which is the clock the loop runs
    // on. Derived, not stored: drag `windUp` while paused and the loop moves.
    state.time = Math.max(0, this.age - Math.max(0, c.windUp));

    this.lash.sync(c, state);

    // THE POLL. One cast, one crack: the tube re-arms and would fire a second
    // time as the tip's velocity reverses through the threshold on its way
    // back out, and two bangs 200 ms apart read as a stutter rather than as a
    // whip.
    if (this.lash.crack.fired && this._crackAt < 0) this._fireCrack();

    this._syncRing();
    this._syncParticleLook(c, g);
  }

  /** The shock ring, standing at the crack for `crackLife` seconds. */
  _syncRing() {
    const c = settings.firewhip;
    if (this._crackAt < 0) {
      this.ring.visible = false;
      return;
    }
    const t = (this.age - this._crackAt) / Math.max(0.02, c.crackLife);
    if (t > 1) {
      this.ring.visible = false;
      return;
    }

    const state = this._ringState;
    this._crackPoint(state.origin);
    // The ring stands across the lash, so its axis is the heading. Re-read from
    // the cast rather than captured at the crack: a captured direction is a
    // captured radian, and the tip is on the axis by the time it cracks anyway.
    state.axis.copy(this.direction);
    state.side.copy(this.side);
    state.span = this.length;
    state.t = saturate(t);
    state.fade = (1 - saturate(t)) * Math.min(1.8, this._crackPower);
    state.seed = this._seed;

    this.ring.visible = true;
    this.ring.sync(c, state);
  }

  /** The three particle systems, re-resolved every frame like everything else. */
  _syncParticleLook(c, g) {
    this.embers.setGradient(
      getColor(c.colorEmberA),
      getColor(c.colorEmberB),
      getColor(c.colorEmberC),
      getColor(c.colorEmberD)
    );
    this.embers.uniforms.uGravity.value.set(0, c.emberGravity, 0);
    this.embers.uniforms.uSizeScale.value = c.emberSize * g.particleSize * 7;
    this.embers.uniforms.uLifeScale.value = c.emberLifetime * 0.5 * g.particleLifetime;
    this.embers.uniforms.uSpeedScale.value = g.particleSpeed;
    this.embers.uniforms.uOpacity.value = g.opacity;
    this.embers.uniforms.uGlow.value = 1.4 * g.glow;
    this.embers.uniforms.uStretch.value = c.emberStretch;
    this.embers.uniforms.uTurbulence.value = 0.4 * g.turbulence;

    this.ash.setGradient(
      getColor(c.colorAshA),
      getColor(c.colorAshB),
      getColor(c.colorAshC),
      getColor(c.colorAshD)
    );
    this.ash.uniforms.uGravity.value.set(0, c.ashGravity, 0);
    this.ash.uniforms.uSizeScale.value = c.ashSize * g.particleSize * 7;
    this.ash.uniforms.uLifeScale.value = c.ashLifetime * 0.5 * g.particleLifetime;
    this.ash.uniforms.uSpeedScale.value = g.particleSpeed;
    this.ash.uniforms.uOpacity.value = g.opacity;
    this.ash.uniforms.uTurbulence.value = c.ashTurbulence * g.turbulence;

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

  /** The flare at the handle as the lash goes. */
  _muzzleFx() {
    const c = settings.firewhip;
    const g = settings.global;

    this._handPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: c.muzzleSize * 0.25,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.35,
      intensity: c.muzzleIntensity,
      opacity: 0.85,
      fresnel: 1.3,
      displace: 0.7,
      colorA: getColor(c.colorMuzzleA),
      colorB: getColor(c.colorMuzzleB),
      colorC: getColor(c.colorMuzzleC)
    });

    _emit.position = _pos;
    _emit.radius = 0.16;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.6).setY(0.5).normalize();
    _emit.speed = c.emberSpeed * 2.2;
    _emit.speedVariance = 0.8;
    _emit.spread = c.emberSpread;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.2;
    _emit.sizeVariance = 0.7;
    _emit.life = c.emberLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.embers.emit(Math.round(c.releaseSparks * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  /**
   * The crack. Called from inside `_syncLash`, on the frame the tip broke the
   * wave speed, with the tube's own answer for where that happened.
   */
  _fireCrack() {
    const c = settings.firewhip;
    const g = settings.global;
    const crack = this.lash.crack;

    /* --- capture: a timestamp, three fractions and a unitless ratio --- */
    const inv = 1 / Math.max(this.length, 0.01);
    _rel.subVectors(crack.point, this.origin);
    this._crackAlong = _rel.dot(this.direction) * inv;
    this._crackSide = _rel.dot(this.side) * inv;
    this._crackLift = crack.point.y * inv;
    this._crackPower = this.lash.waveSpeed > 0 ? crack.speed / this.lash.waveSpeed : 1;
    this._crackAt = this.age;

    // Everything below is driven off that ratio, so a whip tuned to only just
    // break the wave pops, and one tuned to blow through it bangs.
    const power = Math.min(3, this._crackPower);
    this._crackPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: c.crackBurstSize * 0.2,
      endRadius: c.crackBurstSize * power * g.explosionIntensity,
      life: 0.45,
      intensity: c.crackBurstIntensity,
      opacity: 0.9,
      fresnel: 1.5,
      displace: 0.8,
      colorA: getColor(c.colorCrackBurstA),
      colorB: getColor(c.colorCrackBurstB),
      colorC: getColor(c.colorCrackBurstC)
    });

    const time = frame.uTime.value;
    _emit.position = _pos;
    _emit.radius = 0.2;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.35).setY(0.6).normalize();
    _emit.speed = c.emberSpeed * 3.4 * power;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.22;
    _emit.sizeVariance = 0.8;
    _emit.life = c.emberLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.embers.emit(Math.round(c.crackSparks * g.particleCount), _emit);

    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.ashSpeed * 2.6 * power;
    _emit.spread = 1.0;
    _emit.size = 0.16;
    _emit.life = c.ashLifetime;
    _emit.spin = c.ashSpin;
    this.ash.emit(Math.round(c.crackAshBurst * g.particleCount), _emit);

    this.ctx.shake.add(
      c.crackShake * power * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.crackShakeTime),
      30
    );
    this.ctx.flash.trigger(getColor(c.colorCrackFlash), c.crackFlash * power * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * c.crackLight * power * g.explosionIntensity;
  }

  /**
   * Embers, ash and smoke shed along the lash.
   *
   * Every position comes off `lash.pointAt()` and every radius off
   * `lash.radiusAt()` — the tube's own JS mirror of its vertex shader — so the
   * particles sit on the curve the GPU is drawing rather than near it. The
   * first version placed them on the straight line from hand to target, which
   * is fine right up until the loop throws half a metre of lash sideways and
   * the embers stay behind in a neat row.
   *
   * @param {number} scale  0..1, thinned as the lash dies
   */
  _lashFx(dt, scale) {
    const c = settings.firewhip;
    const g = settings.global;
    const time = frame.uTime.value;
    const reach = Math.max(0.05, this._progress());
    // Once it is down and burning, the embers pour rather than shed.
    const emberRate = lerp(c.emberRate, c.emberFallRate, this._fall) * scale;

    let emberCount = Math.round(this.emberEmitter.tick(dt, emberRate) * g.particleCount);
    if (emberCount > 0) {
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.emberSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = c.emberSpread;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.14;
      _emit.sizeVariance = 0.7;
      _emit.life = c.emberLifetime;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      const batches = Math.min(emberCount, EMBER_BATCHES);
      const per = Math.ceil(emberCount / batches);
      while (emberCount > 0) {
        const s = randRange(0.04, 1) * reach;
        this.lash.pointAt(s, _pos);
        _emit.position = _pos;
        _emit.radius = this.lash.radiusAt(s) * 1.6;
        this.embers.emit(Math.min(per, emberCount), _emit);
        emberCount -= per;
      }
    }

    const ashCount = Math.round(this.ashEmitter.tick(dt, c.ashRate * scale) * g.particleCount);
    if (ashCount > 0) {
      const s = Math.random() * reach;
      this.lash.pointAt(s, _pos);
      _emit.position = _pos;
      _emit.radius = this.lash.radiusAt(s) * 2.4;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.ashSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = c.ashSpread;
      _emit.size = 0.12;
      _emit.sizeVariance = 0.8;
      _emit.life = c.ashLifetime;
      _emit.lifeVariance = 0.6;
      _emit.spin = c.ashSpin;
      _emit.time = time;
      this.ash.emit(ashCount, _emit);
    }

    const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * scale) * g.particleCount);
    if (smokeCount > 0) {
      const s = Math.random() * reach;
      this.lash.pointAt(s, _pos);
      _emit.position = _pos;
      _emit.radius = this.lash.radiusAt(s) * 3.5;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.9;
      _emit.size = 0.8;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }
  }

  /**
   * Burn marks laid under the lash while it lies on the floor burning out.
   *
   * Rated per second rather than per metre of travel, because by this point
   * nothing is travelling: the lash is down and the floor under it is cooking.
   */
  _groundFx(dt) {
    const c = settings.firewhip;
    if (this._fall <= 0.02) return;

    const marks = this.scorchEmitter.tick(dt, c.scorchRate * this._fall);
    for (let i = 0; i < marks; i++) {
      this.lash.pointAt(Math.random(), _pos);
      _pos.y = 0.015;
      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: c.scorchRadius * randRange(0.7, 1.35),
        life: c.scorchLife,
        intensity: c.scorchIntensity,
        colorA: getColor(c.colorScorch),
        colorB: getColor(c.colorScorchEmber),
        height: 0.015
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._syncLash(1, 1, 0);

    // The light rides the tip of the lash. `advance()` has already put
    // `position` on the ground line, so lift it onto the curve — and the tube
    // knows where the tip is far better than this file does.
    this.position.copy(this.lash.tipPoint);

    // Nothing sheds off a lash that is still coiled in the hand.
    const out = this.age < Math.max(0, settings.firewhip.windUp) ? 0.35 : 1;
    this._lashFx(dt, out);

    this.ctx.shake.rumble(settings.firewhip.rumble * settings.global.cameraShake, dt);
  }

  /**
   * Full extension. Not the payoff — the crack is — so this is a thump and a
   * handful of embers off the leather, and nothing that would upstage the bang
   * still to come.
   */
  onImpact() {
    const c = settings.firewhip;
    const g = settings.global;

    this.lash.pointAt(1, _pos);

    _emit.position = _pos;
    _emit.radius = this.lash.radiusAt(1) * 2.5;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.5).setY(0.45).normalize();
    _emit.speed = c.emberSpeed * 2.4;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.18;
    _emit.sizeVariance = 0.8;
    _emit.life = c.emberLifetime * 1.2;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.embers.emit(Math.round(c.snapSparks * g.particleCount), _emit);

    this.ctx.shake.add(
      c.snapShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.snapShakeTime),
      22
    );
    this.lightBoost = c.lightIntensity * 0.4 * g.explosionIntensity;
  }

  onFade(dt, t) {
    // `t` runs 0..1 while the lash hangs, then 1..2 while it burns out. The
    // brightness goes cubically — leather holds its heat and then lets go — and
    // the width collapses on a separate, gentler curve, so what is left at the
    // end is a thin burning thread rather than a faint fat one.
    const dying = saturate(t - 1);
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(dying);
    const widthFade = lerp(1, 0.22, Easing.outQuad(dying));

    this._syncLash(fade, widthFade, t);
    this.position.copy(this.lash.tipPoint);

    this._lashFx(dt, fade * (t <= 1 ? 0.85 : 0.5));
    this._groundFx(dt);
  }

  onDestroy() {
    this.ring.visible = false;
    this._crackAt = -1;
    this._fall = 0;
  }

  dispose() {
    this.lash.dispose();
    this.ring.dispose();
    super.dispose();
  }
}
