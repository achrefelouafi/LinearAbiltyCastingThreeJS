import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { Shell, ShellMode } from '../../vfx/Shell.js';
import { DistortionField, DistortionMode, DistortionFacing } from '../../vfx/Distortion.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;

/**
 * How many points around the wavefront one frame's dust is split between.
 *
 * The first version emitted the whole frame's batch from a single bearing and
 * the "expanding ring of dust" came out as a rotating hose — a jet of dust
 * sweeping round the circle rather than a ring leaving it. Six is enough that
 * the ring closes at any sane rate; below three you can still see the spokes.
 */
const RING_BATCHES = 6;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _anchor = new Vector3();
const _air = {};
const _floorParams = {};

/**
 * THUNDERCLAP — a far cast whose whole read is the **delay**.
 *
 * Every other impact in the project is simultaneous: the flash, the shell, the
 * shake and the debris all land on the same frame, because that is what an
 * explosion is. A thunderclap is not an explosion, it is a *report*, and the
 * one thing everybody has actually experienced about it is that the light and
 * the pressure arrive at different times.
 *
 * So the ability is three beats and the middle one is empty:
 *
 *  1. **`clapTime`** — a hard white flash and a `Shell(DOME)` that is fully out
 *     within a tenth of a second and then gone. No dust. No debris. No shake.
 *  2. **`gapTime`** — *nothing*. The dome is not drawn, both refraction
 *     emitters are released, no emitter ticks, and `lightShimmer()` pulls the
 *     dynamic light down to `gapGlow`. Deliberately, conspicuously empty.
 *  3. **`frontTime`** — the pressure front arrives. `frontRings` concentric
 *     `SHOCK` fronts cross out to `zoneRadius` through **two** distortion
 *     emitters — one billboarded for the air, one lying flat for the stone —
 *     and the camera shake, the dust and the grit are all on *this* beat.
 *
 * Take the gap out and this is another shockwave slot. That is why `gapTime` is
 * the first slider in the editor folder and why nothing else in the ability is
 * allowed to bleed across it: the emptiness is load-bearing.
 *
 * **Two things about the refraction, both of which cost somebody a day
 * elsewhere.** `DistortionField` magnitudes are *screen fractions*, not metres,
 * and the post pass already multiplies `post.distortion × global.distortion`
 * into them — so this file never does. And the pass counts *visible* emitters
 * to decide whether to run at all, so the beats toggle `field.visible` rather
 * than hiding the parent group, which would leak the writer for the session.
 *
 * **What a cast captures.** One seed and a handful of timestamps. The beat
 * boundaries are recomputed from `settings.thunderclap` on every frame,
 * zero-length ones included, so pausing mid-gap and dragging `gapTime` down
 * makes the front arrive with the clock stopped — and dragging it back up
 * re-arms the boom, because the crossing is tested against the live boundary
 * rather than latched forever.
 */
export class ThunderclapAbility extends Ability {
  constructor(context) {
    super('thunderclap', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- beat 1: the dome, and the knot that carries it downrange --- */
    this.dome = new Shell({ mode: ShellMode.DOME, prefix: 'dome', nodes: 40, sides: 56 });
    this.group.add(this.dome.group);

    /* --- beat 3: the same wavefront, written twice --- */
    // Two emitters rather than one because "it shoves the dust" and "it shoves
    // the floor" are different pictures. A billboard ring warps whatever is
    // behind it at any height, which is the air; a ground ring warps only the
    // stone, and reads as the front running out under your feet. One of them
    // alone always looks like half of the effect.
    this.air = new DistortionField({
      mode: DistortionMode.SHOCK,
      facing: DistortionFacing.BILLBOARD,
      renderOrder: 2,
      name: 'thunderclap.air'
    });
    this.floor = new DistortionField({
      mode: DistortionMode.SHOCK,
      facing: DistortionFacing.GROUND,
      renderOrder: 1,
      name: 'thunderclap.floor'
    });
    this.group.add(this.air.object3D);
    this.group.add(this.floor.object3D);

    /** Re-rolled per cast so two claps do not billow identically. */
    this._seed = 0;
    /** Latch on beat 3. Re-armed whenever the clock is back before the boom. */
    this._boomed = false;
    /** Metres of wavefront travel already paid out in dust puffs. */
    this._frontDistance = 0;

    // Scratch handed to the shell each frame. One object, reused.
    this._state = {
      origin: new Vector3(),
      axis: new Vector3(0, 1, 0),
      side: new Vector3(1, 0, 0),
      span: 0,
      t: 0,
      fade: 1,
      seed: 0
    };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The dust the front shoves. Non-additive so it genuinely occludes — a
    // pressure front that adds light reads as fire.
    this.dust = particles.get('thunderclap.dust', {
      capacity: 2200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.2
    });
    this.dust.uniforms.uDrag.value = 2.2;
    this.dust.uniforms.uEndSize.value = 3.4;
    this.dust.uniforms.uSizeIn.value = 0.1;
    this.dust.uniforms.uFadeIn.value = 0.12;
    this.dust.uniforms.uFadeOut.value = 0.35;

    // Chips lifted off the floor as the front passes over them.
    this.grit = particles.get('thunderclap.grit', {
      capacity: 1400,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.grit.uniforms.uDrag.value = 0.3;
    this.grit.uniforms.uEndSize.value = 0.8;
    this.grit.uniforms.uFadeOut.value = 0.65;

    this.dustEmitter = new RateEmitter();
    this.gritEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing — the three beats, re-resolved every frame                   */
  /* ------------------------------------------------------------------ */

  /** Beat 1, seconds. */
  _clapSpan() {
    return Math.max(0.01, settings.thunderclap.clapTime * settings.global.lifetime);
  }

  /** Beat 2 — the gap — seconds. May legitimately be zero. */
  _gapSpan() {
    return Math.max(0, settings.thunderclap.gapTime * settings.global.lifetime);
  }

  /** Beat 3, seconds. */
  _frontSpan() {
    return Math.max(0.02, settings.thunderclap.frontTime * settings.global.lifetime);
  }

  /** The three beats end to end. */
  get impactDuration() {
    return this._clapSpan() + this._gapSpan() + this._frontSpan();
  }

  get fadeDuration() {
    return Math.max(0.05, settings.thunderclap.fadeTime);
  }

  get instanceCount() {
    return this.dome.visible ? 1 : 0;
  }

  /**
   * Seconds since the clap landed.
   *
   * Deliberately *not* the `t` the base class hands `onFade`: that was divided
   * by the impact duration one frame ago, and the whole point of this ability
   * is that the duration is three sliders which may move underneath a standing
   * cast. Rebuilding the local clock from `impactTime` and the live
   * `impactDuration` is what lets a paused `gapTime` drag walk the effect
   * forward and backward through its own beats.
   */
  _clock() {
    if (this.phase === AbilityPhase.FADE) return this.impactDuration + this.fadeTime;
    return this.impactTime;
  }

  /**
   * The dynamic light, beat by beat.
   *
   * This is where the gap is enforced hardest. A clap that keeps a glow burning
   * through beat 2 reads as one continuous event with a lull in it; a clap that
   * goes properly dark reads as two events, which is the truth.
   */
  lightShimmer() {
    const c = settings.thunderclap;
    if (this.phase === AbilityPhase.TRAVEL) return saturate(c.knotFade);

    const local = this._clock();
    const clap = this._clapSpan();
    const boomAt = clap + this._gapSpan();
    const gap = saturate(c.gapGlow);

    if (local < clap) return 1;
    if (local < boomAt) return gap; //  BEAT 2 — nothing
    const t3 = saturate((local - boomAt) / this._frontSpan());
    return gap + (1 - gap) * Math.pow(1 - t3, Math.max(0.05, c.frontDecay));
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** Where the clap lands, on the floor. */
  _impactPoint(out) {
    return this.pointAt(1, out);
  }

  /**
   * The wavefront radius at `t3`, metres.
   *
   * `zoneRadius` is where it stops, which is the circle the aim indicator drew
   * before the click — the promise and the payoff are one number, exactly as
   * they are for the snare. The easing is `1 − (1 − t)^expand`, the same curve
   * `Shell` expands on, so `frontExpand` above 1 means the front leaves fast
   * and eases into its final radius rather than crawling out linearly.
   */
  _wave(t3) {
    const c = settings.thunderclap;
    const eased = 1 - Math.pow(1 - saturate(t3), Math.max(0.05, c.frontExpand));
    return Math.max(0.01, c.zoneRadius) * eased;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.dustEmitter.reset();
    this.gritEmitter.reset();
    this._boomed = false;
    this._frontDistance = 0;

    // The one thing a cast captures, and it is unitless.
    this._seed = Math.random() * 100;

    this.dome.visible = true;
    this.air.visible = false;
    this.floor.visible = false;

    this._sync(0);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current beat into the dome and both
   * emitters.
   *
   * Both refraction fields are updated on *every* frame whether or not they are
   * drawn, and only their amplitude is gated by the beat. That costs nothing —
   * an invisible emitter is not rasterised — and it means `airThickness`,
   * `floorSpan` and the rest are live sliders during the travel and the gap as
   * well as during the front, which is what you want when you are tuning a
   * quarter-second event by dragging it.
   *
   * @param {number} amp 0..1 how much of beat 3 is happening
   * @param {number} t3  0..1 through the front's crossing
   */
  _sync(t3, amp = 0) {
    const c = settings.thunderclap;
    const g = settings.global;

    this._impactPoint(_anchor);
    const wave = this._wave(t3);
    const radius = Math.max(0.05, c.zoneRadius);

    /* --- the front in the air --- */
    this.air.setAnchorXYZ(_anchor.x, radius * Math.max(0, c.airHeight) * 0.5, _anchor.z);
    _air.width = radius * Math.max(0.2, c.airSpan) * 2;
    _air.height = radius * Math.max(0.05, c.airHeight);
    // NEVER multiply global.distortion or post.distortion in here — the pass
    // applies both, once, and folding them in doubles them for this one slot.
    _air.strength = c.airStrength * amp;
    _air.radius = radius;
    _air.window = c.airWindow;
    _air.maxOffset = c.airMaxOffset;
    _air.wave = wave;
    _air.thickness = c.airThickness;
    _air.compression = c.airCompression;
    _air.rarefaction = c.airRarefaction;
    _air.rings = c.frontRings;
    _air.ringGap = c.frontRingGap;
    _air.ringDecay = c.frontRingDecay;
    _air.depthReject = c.frontDepthReject;
    _air.depthFade = c.frontDepthFade;
    _air.perspective = c.airPerspective;
    _air.perspectiveRef = c.airPerspectiveRef;
    _air.seed = this._seed;
    this.air.update(_air);

    /* --- and the same front in the floor --- */
    this.floor.setAnchorXYZ(_anchor.x, Math.max(0.002, c.floorHeight), _anchor.z);
    _floorParams.width = radius * Math.max(0.2, c.floorSpan) * 2;
    _floorParams.height = radius * Math.max(0.2, c.floorSpan) * 2;
    _floorParams.strength = c.floorStrength * amp;
    _floorParams.radius = radius;
    _floorParams.window = c.floorWindow;
    _floorParams.maxOffset = c.floorMaxOffset;
    _floorParams.wave = wave;
    _floorParams.thickness = c.floorThickness;
    _floorParams.compression = c.floorCompression;
    _floorParams.rarefaction = c.floorRarefaction;
    _floorParams.rings = c.frontRings;
    _floorParams.ringGap = c.frontRingGap;
    _floorParams.ringDecay = c.frontRingDecay;
    _floorParams.depthReject = c.frontDepthReject;
    _floorParams.depthFade = c.frontDepthFade;
    _floorParams.seed = this._seed + 11;
    this.floor.update(_floorParams);

    /* --- the particle systems --- */
    this.dust.setGradient(
      getColor(c.colorDustA),
      getColor(c.colorDustB),
      getColor(c.colorDustC),
      getColor(c.colorDustD)
    );
    this.dust.uniforms.uGravity.value.set(0, c.dustRise, 0);
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize;
    this.dust.uniforms.uLifeScale.value = c.dustLifetime * 0.5 * g.particleLifetime;
    this.dust.uniforms.uSpeedScale.value = g.particleSpeed;
    this.dust.uniforms.uOpacity.value = c.dustOpacity * g.opacity;
    this.dust.uniforms.uTurbulence.value = 0.4 * g.turbulence;

    this.grit.setGradient(
      getColor(c.colorGritA),
      getColor(c.colorGritB),
      getColor(c.colorGritC),
      getColor(c.colorGritD)
    );
    this.grit.uniforms.uGravity.value.set(0, c.gritGravity, 0);
    this.grit.uniforms.uSizeScale.value = c.gritSize * g.particleSize * 7;
    this.grit.uniforms.uLifeScale.value = c.gritLifetime * 0.5 * g.particleLifetime;
    this.grit.uniforms.uSpeedScale.value = g.particleSpeed;
    this.grit.uniforms.uOpacity.value = g.opacity;
  }

  /**
   * The dome, wherever it currently is and however far through beat 1 it is.
   *
   * @param {THREE.Vector3} at  where the hemisphere is seated
   * @param {number} t          0..1 through the dome's expansion
   * @param {number} fade       0..1 master
   */
  _syncDome(at, t, fade) {
    const state = this._state;
    state.origin.copy(at);
    state.origin.y = 0;
    state.axis.set(0, 1, 0);
    state.side.copy(this.side);
    state.t = saturate(t);
    state.fade = saturate(fade);
    state.seed = this._seed;
    this.dome.sync(settings.thunderclap, state, settings.global);
  }

  /* ------------------------------------------------------------------ */
  /* Beat 3 — the one-shot and the crossing                              */
  /* ------------------------------------------------------------------ */

  /** The frame the pressure front launches. Everything that punches is here. */
  _boom() {
    const c = settings.thunderclap;
    const g = settings.global;
    const time = frame.uTime.value;

    this._frontDistance = 0;
    this._impactPoint(_anchor);

    /* the ring it leaves on the floor */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _anchor, {
      radius: Math.max(0.05, c.zoneRadius),
      life: c.shockLife,
      width: c.shockWidth,
      intensity: c.shockIntensity,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* the dust and the chips it lifts as it goes */
    _emit.position = _anchor;
    _emit.radius = Math.max(0.05, c.zoneRadius) * 0.2;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dustSpeed * 1.4;
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 1.1;
    _emit.sizeVariance = 0.6;
    _emit.life = c.dustLifetime;
    _emit.lifeVariance = 0.45;
    _emit.spin = 0.35;
    _emit.tint = null;
    _emit.time = time;
    this.dust.emit(Math.round(c.boomDust * g.particleCount), _emit);

    _emit.speed = c.gritSpeed * 1.6;
    _emit.size = 0.12;
    _emit.life = c.gritLifetime;
    _emit.spin = 9;
    this.grit.emit(Math.round(c.boomGrit * g.particleCount), _emit);

    // `CameraShake#add` already multiplies `global.cameraShake` in, so this
    // does not — the shipped six fold it in a second time and end up with the
    // square of the master slider.
    this.ctx.shake.add(
      c.boomShake * g.explosionIntensity,
      1 / Math.max(0.05, c.boomShakeTime),
      24
    );
    this.ctx.flash.trigger(getColor(c.colorBoomFlash), c.boomFlash * g.explosionIntensity);
    this.lightBoost = c.boomLight * g.explosionIntensity;
  }

  /**
   * Dust and grit thrown off the wavefront itself, and the puffs it leaves.
   *
   * Emitted *on the ring*, not at the centre: a bearing is rolled per batch and
   * the outward normal is built from the cast's own flat frame, so the particles
   * leave along the front rather than being sprayed from the middle and
   * happening to arrive.
   */
  _frontFx(dt, wave, amp) {
    const c = settings.thunderclap;
    const g = settings.global;
    const time = frame.uTime.value;

    this._impactPoint(_anchor);

    let dustCount = Math.round(this.dustEmitter.tick(dt, c.dustRate * amp) * g.particleCount);
    if (dustCount > 0) {
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = saturate(c.dustSpread);
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.9;
      _emit.sizeVariance = 0.6;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.tint = null;
      _emit.time = time;

      const batches = Math.min(dustCount, RING_BATCHES);
      const per = Math.ceil(dustCount / batches);
      while (dustCount > 0) {
        const bearing = Math.random() * TAU;
        this._ringPoint(bearing, wave, _pos, _dir);
        _pos.y = 0.12;
        _emit.position = _pos;
        _emit.radius = c.dustSize * 0.6;
        _dir.y = 0.45;
        _dir.normalize();
        _emit.direction = _dir;
        this.dust.emit(Math.min(per, dustCount), _emit);
        dustCount -= per;
      }
    }

    const gritCount = Math.round(this.gritEmitter.tick(dt, c.gritRate * amp) * g.particleCount);
    if (gritCount > 0) {
      const bearing = Math.random() * TAU;
      this._ringPoint(bearing, wave, _pos, _dir);
      _pos.y = 0.05;
      _emit.position = _pos;
      _emit.radius = c.ringRadius * 0.4;
      _dir.y = 1.1;
      _dir.normalize();
      _emit.direction = _dir;
      _emit.speed = c.gritSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = 0.7;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.gritLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 8;
      _emit.time = time;
      this.grit.emit(gritCount, _emit);
    }

    /* --- puffs paid out per metre of front travel, not per second --- */
    // Keyed off distance so the ring of marks stays evenly spaced whether the
    // front is snapping out in a fifth of a second or rolling out over two.
    const step = 1 / Math.max(0.05, c.ringRate);
    let guard = 24;
    while (wave - this._frontDistance >= step && guard-- > 0) {
      this._frontDistance += step;
      const bearing = Math.random() * TAU;
      this._ringPoint(bearing, this._frontDistance, _pos, _dir);
      this.ctx.decals.spawn(DecalType.DUSTRING, _pos, {
        radius: c.ringRadius * randRange(0.7, 1.3),
        life: c.ringLife,
        intensity: c.ringIntensity,
        colorA: getColor(c.colorRingA),
        colorB: getColor(c.colorRingB)
      });
    }
  }

  /**
   * A point on the wavefront at `bearing`, plus the outward normal there.
   *
   * Built from the cast's own `side` and `direction` — both flat and
   * orthonormal already — so no basis is constructed and nothing allocates.
   */
  _ringPoint(bearing, radius, outPoint, outNormal) {
    const cos = Math.cos(bearing);
    const sin = Math.sin(bearing);
    outNormal.copy(this.side).multiplyScalar(cos).addScaledVector(this.direction, sin);
    outPoint.copy(_anchor).addScaledVector(outNormal, radius);
    return outPoint;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.thunderclap;

    // The knot of compressed air riding the front. Held at the shell's start
    // radius (t = 0) so `domeRadius` is what you are looking at, and dimmed to
    // `knotFade` — it is on screen for a tenth of a second and it is not the
    // point, but a clap that is switched on at the target has no cause.
    this.dome.visible = true;
    this._syncDome(this.position, 0, saturate(c.knotFade));
    this._sync(0, 0);

    // Nothing else happens on the way out. No dust, no light punch, no shake:
    // beat 1 has not fired yet, and everything this ability owns belongs to a
    // beat.
    void dt;
  }

  onImpact() {
    const c = settings.thunderclap;
    const g = settings.global;

    this._boomed = false;
    this._frontDistance = 0;
    this._impactPoint(_anchor);

    this.ctx.flash.trigger(getColor(c.colorClapFlash), c.clapFlash * g.explosionIntensity);
    // Almost nothing. The punch is beat 3's and moving it here is precisely the
    // mistake this ability exists to avoid.
    this.ctx.shake.add(c.clapShake * g.explosionIntensity, 8, 30);
    this.lightBoost = c.clapLight * g.explosionIntensity;
  }

  onFade(dt, _t) {
    const c = settings.thunderclap;
    const g = settings.global;

    const local = this._clock();
    const clap = this._clapSpan();
    const boomAt = clap + this._gapSpan();
    const front = this._frontSpan();

    this._impactPoint(_anchor);
    // The light sits at the height of the dome's shoulder rather than on the
    // floor, so the flash throws shadows down and outward.
    this.position.copy(_anchor);
    this.position.y = Math.max(0.1, c.domeRadiusEnd * 0.35);

    /* ---------------- beat 1 ---------------- */
    const t1 = saturate(local / clap);
    const inClap = local <= clap;
    this.dome.visible = inClap;
    // The dome does not dim, it *goes*: cubic on the way out so it hangs at
    // full brightness and then is simply not there. A linear fade turns the
    // first beat into a soft glow, which reads as an explosion starting.
    this._syncDome(_anchor, t1, inClap ? 1 - t1 * t1 * t1 : 0);

    /* ---------------- beat 3, and the latch ---------------- */
    // The crossing is tested against the *live* boundary, and the latch is
    // re-armed whenever the clock is back before it. That is what makes a
    // paused `gapTime` drag walk the boom backward and forward instead of
    // firing once and never again.
    const t3 = saturate((local - boomAt) / front);
    if (local < boomAt) {
      this._boomed = false;
    } else if (!this._boomed) {
      this._boomed = true;
      this._boom();
    }

    const crossing = local >= boomAt && t3 < 1;
    const amp = crossing ? Math.pow(1 - t3, Math.max(0.05, c.frontDecay)) : 0;

    this.air.visible = crossing;
    this.floor.visible = crossing;
    this._sync(t3, amp);

    if (crossing) {
      this._frontFx(dt, this._wave(t3), amp);
      this.ctx.shake.rumble(c.frontRumble * amp, dt);
    }
    // ... and between beat 1 and beat 3 this method deliberately does nothing
    // at all. That silence is the ability.
    void g;
  }

  onDestroy() {
    // Both of these release the distortion pass's writer counter. Hiding the
    // group instead would leave the pass running for the rest of the session.
    this.air.visible = false;
    this.floor.visible = false;
    this.dome.visible = false;
    this._boomed = false;
    this._frontDistance = 0;
  }

  dispose() {
    this.air.visible = false;
    this.floor.visible = false;
    this.dome.dispose();
    this.air.dispose();
    this.floor.dispose();
    super.dispose();
  }
}
