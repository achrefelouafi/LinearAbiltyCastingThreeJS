import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { Projectile, FlightMode, Stagger } from '../../vfx/Projectile.js';
import { DistortionField, DistortionMode, DistortionFacing } from '../../vfx/Distortion.js';
import { Shell, ShellMode } from '../../vfx/Shell.js';
import { FilamentPaths } from '../../vfx/FilamentPaths.js';
import { createSunspearMaterial } from '../../materials/SunspearMaterial.js';
import { createCrystalGeometry } from '../../assets/ProceduralGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, Easing, randRange } from '../../utils/math.js';

/**
 * Samples along one corona filament. A lick is a third of a turn of a 5 m rim —
 * about 10 m of path — and 48 nodes puts a sample every 20 cm, which is finer
 * than the kink can resolve anyway.
 */
const CORONA_SAMPLES = 48;
/** Hard ceiling on corona filaments across both roles. */
const CORONA_CAPACITY = 48;

/** Which role slot is which. Structural roles first: the strip fills in order. */
const Role = Object.freeze({
  FLARE: 0, // the crowd of short arcs travelling round the rim
  LICK: 1 // the handful of long ones going the other way
});

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _up = new Vector3(0, 1, 0);

/** Scratch parameter blocks — refilled every frame, never replaced (I3). */
const _flight = {};
const _warp = {};
const _look = {};
const _state = {
  origin: new Vector3(),
  axis: new Vector3(0, 1, 0),
  side: new Vector3(1, 0, 0),
  span: 1,
  t: 0,
  fade: 1,
  seed: 0
};

/**
 * SUNSPEAR — the slot that proves the distortion pass works.
 *
 * A white-fire javelin is thrown on a ballistic arc, and the air behind it is
 * genuinely bent: a `DistortionField` in `HEAT` mode rides the spear and writes
 * screen-space UV offsets into the refraction buffer, so the floor grid, the
 * character and every particle standing behind the flight path warp as it goes
 * past. There is no post effect keyed to this ability and nothing is faked in
 * colour — turn `wakeStrength` to zero and the spear becomes a bright stick.
 *
 * On landing the spear is gone and a **sun disc** opens flat on the floor with
 * corona filaments licking off its rim: a hard screen flash, then a long slow
 * bloom-out over `discFade`.
 *
 * ## The trick, and the three things that make it land
 *
 * **The wake is one emitter with two jobs.** In flight it is anchored to the
 * spear; on landing it walks — over `discWakeSettle` — out to the disc's width
 * and stays there, so the floor keeps boiling around the sun. A second emitter
 * for the disc would be a second draw call, a second coverage term arguing with
 * the first over who owns the pixels where they overlap, and one more thing to
 * keep in step. `HEAT` is sampled in **world** space by the module, which is
 * what stops the shimmer sliding across the frame when the camera orbits — the
 * single tell that gives a screen-space heat haze away instantly.
 *
 * **The javelin's τ is the ability's own front.** `Projectile` is handed
 * `spearFlight` as its flight time and the ability's `u` as its clock, so
 * τ ≡ u and the spear lands on the exact frame the impact beat fires, however
 * the base class's ease-off-the-standstill curve behaves. The first version
 * gave the projectile a flight time in seconds and let it run on `age`: it
 * arrived a frame or two off the beat, every time, and the flash and the
 * landing came apart just enough to look wrong without being obviously wrong.
 * The cost is that `wakeSpan` is a fraction of the flight rather than a
 * duration, which is the better slider anyway, and that the tail's burn-off
 * needs its own real-seconds clock after the landing — `wakeBurn`.
 *
 * **The corona never learns the disc's radius.** `Shell` interpolates
 * `discRadius → discRadiusEnd` itself on a live easing exponent from a
 * normalised life, and the filament roles are placed against `Shell#radius`
 * *this frame*. Drag `discRadiusEnd` while paused and the rim moves out and the
 * corona goes with it, because the corona never had a copy of the number.
 *
 * ## What a cast captures
 *
 * One seed and one timestamp — the moment of landing. Not a metre, not a
 * radian, not a colour.
 *
 * Six draw calls: the spear, its trail, the wake, the disc, and the corona's
 * two passes.
 */
export class SunspearAbility extends Ability {
  constructor(context) {
    super('sunspear', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.material = createSunspearMaterial();

    /** The javelin. One body, one trail. */
    this.spear = new Projectile(this.group, {
      geometry: () => this._buildSpear(),
      shapeKey: () => this._shapeKey(),
      material: this.material,
      capacity: 1,
      trail: true,
      trailNodes: 32,
      trailAdditive: true,
      layer: LAYER.VFX,
      renderOrder: 12,
      castShadow: false
    });

    /**
     * The wake. Invisible to the main render — it lives on `LAYER.DISTORTION`,
     * which the camera does not draw — and what you see is the rest of the
     * frame moving. `UPRIGHT` rather than a full billboard: heat rises
     * vertically whatever the camera is doing, and a billboarded plume leans
     * over when you orbit, which reads as wind.
     */
    this.wake = new DistortionField({
      mode: DistortionMode.HEAT,
      facing: DistortionFacing.UPRIGHT,
      name: 'sunspear.wake'
    });
    this.group.add(this.wake.object3D);

    /** The sun on the floor. One instanced annulus with no hole in it. */
    this.disc = new Shell({
      mode: ShellMode.SUNDISC,
      prefix: 'disc',
      segments: 128,
      renderOrder: 14
    });
    this.disc.visible = false;
    this.group.add(this.disc.group);

    /** The corona. Two roles, one strip, two draw calls. */
    this.corona = new FilamentPaths(this.group, {
      samples: CORONA_SAMPLES,
      capacity: CORONA_CAPACITY,
      renderOrder: 13,
      layer: LAYER.VFX
    });
    this.corona.visible = false;

    /** Re-rolled per cast so two throws do not draw the identical corona. */
    this._seed = 0;
    /** Timestamp: the moment the spear landed. An event, not a duration. */
    this._impactAt = 0;
    /** Signature of the silhouette controls, so a rebuild follows a change. */
    this._shapeHash = '';
  }

  createParticles() {
    const particles = this.ctx.particles;

    // White fire shed off the shaft, and thrown out of the landing.
    this.embers = particles.get('sunspear.embers', {
      capacity: 4000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.embers.uniforms.uDrag.value = 1.5;
    this.embers.uniforms.uEndSize.value = 0.2;
    this.embers.uniforms.uSizeIn.value = 0.02;
    this.embers.uniforms.uFadeIn.value = 0.03;
    this.embers.uniforms.uFadeOut.value = 0.4;

    // Haze off the scorched disc. Non-additive so it genuinely occludes.
    this.smoke = particles.get('sunspear.smoke', {
      capacity: 1600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.smoke.uniforms.uDrag.value = 1.7;
    this.smoke.uniforms.uEndSize.value = 3.2;
    this.smoke.uniforms.uSizeIn.value = 0.12;
    this.smoke.uniforms.uFadeIn.value = 0.18;
    this.smoke.uniforms.uFadeOut.value = 0.32;

    // What drifts up out of the disc while it blooms out.
    this.motes = particles.get('sunspear.motes', {
      capacity: 1800,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.5;
    this.motes.uniforms.uEndSize.value = 0.18;
    this.motes.uniforms.uSizeIn.value = 0.06;
    this.motes.uniforms.uFadeIn.value = 0.09;
    this.motes.uniforms.uFadeOut.value = 0.42;

    this.emberEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
  }

  /**
   * The javelin, in unit space.
   *
   * `createCrystalGeometry` already builds a tapered faceted prism with its
   * base ring at y = 0 and its point at y = 1 — which is a javelin seen from
   * the side. Sliding it down half a unit and doubling its height puts the
   * butt at y = −1 and the point at +1, centred on the origin, which is where
   * `Projectile` scales and aligns from. Writing a second spindle builder for
   * this would have been thirty lines to arrive at the same solid.
   */
  _buildSpear() {
    const c = settings.sunspear;
    const geometry = createCrystalGeometry({
      seed: 3.1,
      sides: clamp(Math.round(c.spearSides), 3, 9),
      taper: c.spearTaper,
      roughness: c.spearRough,
      bend: c.spearBend
    });
    geometry.translate(0, -0.5, 0);
    geometry.scale(1, 2, 1);
    return geometry;
  }

  /** Everything `_buildSpear` reads, as one string. A change rebuilds. */
  _shapeKey() {
    const c = settings.sunspear;
    return `${Math.round(c.spearSides)}|${c.spearTaper}|${c.spearRough}|${c.spearBend}`;
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.spear.count + this.corona.liveCount;
  }

  /** The disc holds at full brightness. */
  get impactDuration() {
    return Math.max(0.1, settings.sunspear.discHold * settings.global.lifetime);
  }

  /** ...and then the long slow bloom-out, which is what the slot is for. */
  get fadeDuration() {
    return Math.max(0.1, settings.sunspear.discFade);
  }

  /**
   * The spear's clock.
   *
   * Identical to the ability's own front while it is in the air, so τ ≡ u and
   * the landing cannot drift off the beat. Afterwards it advances in units of
   * `wakeBurn` seconds, which is what pulls the trail's tail up to its head —
   * a trail that shortens reads as something that stopped being made, where a
   * trail that dims reads as a light going out.
   */
  _spearClock() {
    const c = settings.sunspear;
    if (this.phase === AbilityPhase.TRAVEL) return this.u * Math.max(0.05, c.spearFlight);
    const since = this.age - this._impactAt;
    return Math.max(0.05, c.spearFlight) * (1 + since / Math.max(0.05, c.wakeBurn));
  }

  /** 0..1 through the disc's whole life — what `Shell` expands against. */
  _discLife() {
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    const total = this.impactDuration + this.fadeDuration;
    return saturate((this.age - this._impactAt) / Math.max(0.05, total));
  }

  /** Where the spear lands, and where the sun opens. */
  _impactPoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.emberEmitter.reset();
    this.smokeEmitter.reset();
    this.moteEmitter.reset();
    this.spear.reset();
    this.corona.clear();

    this._seed = Math.random() * 100;
    this._impactAt = 0;
    this.spear.roll(this._seed);

    this.disc.visible = false;
    this.corona.visible = false;
    // Retaining the writer counter here rather than at construction: the pass
    // skips its clear, its draw and its resample when nothing is writing, and
    // an emitter that is never released keeps it running for the session.
    this.wake.visible = true;

    this._syncSpear();
    this._syncWake(0);
    this._syncParticles();
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /** Re-fly the javelin against the live block. */
  _syncSpear() {
    const c = settings.sunspear;
    const g = settings.global;
    const p = _flight;

    p.mode = FlightMode.ARC;
    p.stagger = Stagger.NONE;
    p.count = 1;
    p.radius = c.spearRadius;
    p.sizeJitter = 0;
    p.stretch = c.spearStretch;
    p.align = c.spearAlign;
    p.spin = c.spearSpin * g.randomness;
    p.flash = c.spearFlash;

    p.handForward = c.handForward;
    p.handSide = c.handSide;
    p.handHeight = c.handHeight;
    // The spear is scaled about its middle, so the landing point is its centre;
    // lifting it by roughly its own half-length is what puts the *point* on the
    // floor rather than a body length under it.
    p.landHeight = c.landHeight;
    p.landInZone = false;
    p.spreadSide = 0;
    p.spreadForward = 0;

    p.pathCurve = c.arcCurve;
    p.apex = c.arcApex;
    p.apexCurve = c.arcApexCurve;
    p.weaveSide = 0;
    p.weaveUp = 0;

    // Nominal, not seconds — the clock handed to `update()` is the cast's own
    // front. See `_spearClock`.
    p.flightTime = Math.max(0.05, c.spearFlight);
    p.speedJitter = 0;
    p.lead = 0;
    p.window = 0;
    p.linger = 0;
    p.sink = 0;

    p.trailSpan = c.wakeSpan * Math.max(0.05, c.spearFlight);
    p.trailBurn = Math.max(0.05, c.spearFlight);
    p.trailWidth = c.wakeTrailWidth;
    p.trailTaper = c.wakeTrailTaper;
    p.trailLift = c.wakeTrailLift;
    p.trailOpacity = c.wakeTrailOpacity * g.opacity;
    p.trailGlow = c.wakeTrailGlow * g.glow;
    p.trailCore = c.wakeTrailCore;
    p.trailHeadBias = c.wakeTrailHeadBias;
    p.trailNoise = c.wakeTrailNoise * g.noiseStrength;
    p.trailNoiseScale = c.wakeTrailNoiseScale * g.noiseFrequency;
    p.trailNoiseSpeed = c.wakeTrailNoiseSpeed * g.noiseSpeed;
    p.trailSoftFade = c.wakeTrailSoftFade;

    this.spear.setBasis(this.origin, this.direction, this.side, this.length);
    this.spear.setTrailColors(c.colorWakeA, c.colorWakeB, c.colorWakeC, c.colorWakeD);
    this.spear.update(this._spearClock(), p);

    // The spear itself goes out the instant it lands; what is left is the disc.
    this.material.userData.sync(this.phase === AbilityPhase.TRAVEL ? 1 : 0);
  }

  /**
   * The wake — the whole point of the slot.
   *
   * @param {number} settle 0 while it rides the spear, 1 once it owns the disc
   */
  _syncWake(settle) {
    const c = settings.sunspear;
    const p = _warp;
    const k = saturate(settle);

    if (k < 1) {
      // On the spear. `slotPosition` is where the body was actually drawn this
      // frame, which is a metre or two ahead of `pointAt(u)` on a lofted arc —
      // and anchoring the shimmer to the flat cast line instead was the first
      // version, which left the warp crawling along the floor under a javelin
      // that was three metres up.
      this.spear.slotPosition(0, _pos);
    } else {
      this._impactPoint(_pos);
    }
    if (k > 0) {
      this._impactPoint(_centre);
      _pos.lerp(_centre, k);
    }
    // A HEAT column's pivot is its *base*, so the anchor goes on the floor
    // under the spear and the column stands up through it.
    this.wake.setAnchorXYZ(_pos.x, Math.max(0, _pos.y - c.wakeHeight * 0.5), _pos.z);

    // Magnitudes here are screen fractions. `post.distortion` and
    // `global.distortion` are applied by the pass, once — folding either of
    // them in here means this ability applies them twice and the next one not
    // at all.
    p.width = lerp(c.wakeWidth, c.discWakeWidth, k);
    p.height = lerp(c.wakeHeight, c.discWakeHeight, k);
    // The wake cools behind the spear: a javelin that warps the room just as
    // hard at the end of a thirty-metre throw as at the start reads as a bug.
    const cooled = 1 - c.wakeFall * (this.phase === AbilityPhase.TRAVEL ? this.u : 1);
    p.strength = lerp(c.wakeStrength * cooled, c.discWakeStrength, k);
    p.opacity = c.wakeOpacity;
    p.seed = this._seed;
    p.frequency = c.wakeFrequency * settings.global.noiseFrequency;
    p.speed = c.wakeSpeed * settings.global.noiseSpeed;
    p.sourceBias = c.wakeSourceBias;
    p.spread = c.wakeSpread;
    p.vertical = c.wakeVertical;
    p.flicker = c.wakeFlicker;
    p.depthReject = c.wakeDepthReject;
    p.depthFade = c.wakeDepthFade;
    p.perspective = c.wakePerspective;
    p.perspectiveRef = c.wakePerspectiveRef;

    this.wake.update(p);
  }

  /**
   * The disc and the corona standing on its rim.
   * @param {number} fade 1 while it holds, ramping to 0 through the bloom-out
   */
  _syncDisc(fade) {
    const c = settings.sunspear;

    this._impactPoint(_centre);
    _state.origin.copy(_centre);
    _state.axis.set(0, 1, 0);
    _state.side.copy(this.side);
    _state.span = this.length;
    _state.t = this._discLife();
    _state.fade = fade;
    _state.seed = this._seed;
    this.disc.sync(c, _state, settings.global);

    /* --- the corona, placed against the radius the disc resolved --- */
    const radius = Math.max(0.05, this.disc.radius);
    _centre.y = c.discLift;

    const flare = this.corona.role(Role.FLARE);
    flare.count = Math.round(c.flareCount) * (fade > 0.001 ? 1 : 0);
    flare
      .rim(_centre, _up, radius * c.flareRadius, c.flareSpan, c.flareSpeed, c.flareLift, c.flareJitter, c.flareHug, 0)
      // `groundDamp` at 0.3 and a floor clamp: a kink with a free y buries half
      // of every filament that runs flat, and the corona reads as a dotted line.
      // The snare learnt this the hard way and it is the same lesson here.
      .style(1, 1, 1, 0.3)
      .ends(1, 1, 1, 1)
      .draw(2, 0.12, 0.0, 0.6);

    const lick = this.corona.role(Role.LICK);
    lick.count = Math.round(c.lickCount) * (fade > 0.001 ? 1 : 0);
    lick
      .rim(_centre, _up, radius * c.lickRadius, c.lickSpan, c.lickSpeed, c.lickLift, c.lickJitter, c.lickHug, c.lickPhase)
      .style(1.4, 1.5, 0.85, 0.45)
      .ends(1, 1, 1, 1)
      .draw(2, 0.2, 0.0, 1.1);

    this._syncCoronaLook(fade);
  }

  /** The shared look both corona roles are drawn with. */
  _syncCoronaLook(fade) {
    const c = settings.sunspear;
    const g = settings.global;
    const look = _look;

    look.width = c.flareWidth;
    look.glowWidth = c.flareGlowWidth;
    look.glowOpacity = c.flareGlowOpacity;
    look.jitter = c.flareKink;
    look.jitterScale = c.flareKinkScale;
    look.octaves = c.flareOctaves;
    look.jitterFalloff = c.flareKinkFalloff;
    look.crawl = c.flareCrawl;
    look.pinch = c.flarePinch;
    look.restrike = c.flareRestrike;
    look.flicker = c.flareFlicker;
    look.flickerSpeed = c.flareFlickerSpeed;
    look.strandFlash = c.flareStrandFlash;
    look.coreSharp = c.flareCoreSharp;
    look.glowFalloff = c.flareFalloff;
    look.softFade = c.flareSoftFade;
    look.opacity = c.flareOpacity;
    look.glow = c.flareGlow;
    look.colorCore = c.colorFlareCore;
    look.colorInner = c.colorFlareInner;
    look.colorOuter = c.colorFlareOuter;
    look.colorHalo = c.colorFlareHalo;

    look.randomness = g.randomness;
    look.noiseStrength = g.noiseStrength;
    look.noiseFrequency = g.noiseFrequency;
    look.noiseSpeed = g.noiseSpeed;
    look.opacityScale = g.opacity;
    look.glowScale = g.glow;

    // `sync` overwrites the counts from the role blocks every frame, so the
    // roles above have to be filled first — every frame, not at spawn.
    this.corona.sync(look, fade, this._seed);
  }

  /** The three particle systems. */
  _syncParticles() {
    const c = settings.sunspear;
    const g = settings.global;

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
    this.embers.uniforms.uGlow.value = c.spearGlow * 0.4 * g.glow;
    this.embers.uniforms.uStretch.value = c.emberStretch;

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

    this.motes.setGradient(
      getColor(c.colorMoteA),
      getColor(c.colorMoteB),
      getColor(c.colorMoteC),
      getColor(c.colorMoteD)
    );
    this.motes.uniforms.uGravity.value.set(0, c.moteRise, 0);
    this.motes.uniforms.uSizeScale.value = c.moteSize * g.particleSize * 7;
    this.motes.uniforms.uLifeScale.value = c.moteLifetime * 0.5 * g.particleLifetime;
    this.motes.uniforms.uSpeedScale.value = c.moteSpeed * g.particleSpeed;
    this.motes.uniforms.uOpacity.value = g.opacity;
    this.motes.uniforms.uGlow.value = 1.2 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** The flash at the hand as the javelin leaves it. */
  _muzzleFx() {
    const c = settings.sunspear;
    const g = settings.global;

    _pos
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    _pos.y = c.handHeight;

    _emit.position = _pos;
    _emit.radius = 0.2;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.emberSpeed * 1.4;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.7;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.emberSize * 1.2;
    _emit.sizeVariance = 0.7;
    _emit.life = c.emberLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.embers.emit(Math.round(50 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
  }

  /** White fire coming off the shaft in flight. */
  _flightFx(dt) {
    const c = settings.sunspear;
    const g = settings.global;
    const count = Math.round(this.emberEmitter.tick(dt, c.emberRate) * g.particleCount);
    if (count <= 0) return;

    this.spear.slotPosition(0, _pos);
    _emit.position = _pos;
    // The shed follows the shaft's half-length, so a longer spear sheds along
    // more of the air it is passing through rather than out of one point.
    _emit.radius = c.spearRadius * c.spearStretch * 0.6;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.6).setY(0.5).normalize();
    _emit.speed = c.emberSpeed;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.emberSize;
    _emit.sizeVariance = 0.7;
    _emit.life = c.emberLifetime;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.embers.emit(count, _emit);
  }

  /** Smoke and motes off the standing disc. */
  _discFx(dt, scale) {
    const c = settings.sunspear;
    const g = settings.global;
    const time = frame.uTime.value;
    const radius = Math.max(0.05, this.disc.radius);

    const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * scale) * g.particleCount);
    if (smokeCount > 0) {
      this._impactPoint(_pos);
      _pos.y = 0.2;
      _emit.position = _pos;
      _emit.radius = radius * 0.9;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 1.0;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.35;
      _emit.tint = null;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      this._impactPoint(_pos);
      _pos.y = 0.12;
      _emit.position = _pos;
      // Off the rim rather than the face: the corona is where the disc is
      // actually losing material, and motes rising out of the middle read as a
      // campfire.
      _emit.radius = radius * 0.95;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.85;
      _emit.size = c.moteSize;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._syncParticles();
    this._syncSpear();
    this._syncWake(0);
    this._flightFx(dt);

    // The light rides the javelin, not the floor under it — `advance()` has
    // already put `position` on the ground line, so lift it onto the arc.
    this.spear.slotPosition(0, this.position);

    this.ctx.shake.rumble(settings.sunspear.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.sunspear;
    const g = settings.global;
    const time = frame.uTime.value;

    this._impactAt = this.age;
    this.disc.visible = true;
    this.corona.visible = true;

    this._impactPoint(_pos);
    _pos.y = 0.45;

    /* the shell of white fire */
    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: c.burstSize * 0.2,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.8,
      intensity: c.burstIntensity,
      opacity: 0.9,
      fresnel: 1.6,
      displace: 0.55,
      squash: 0.7,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* embers thrown out of it */
    _emit.position = _pos;
    _emit.radius = 0.4;
    _emit.direction = _dir.set(randRange(-0.3, 0.3), 1, randRange(-0.3, 0.3)).normalize();
    _emit.speed = c.emberSpeed * 2.4;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.emberSize * 1.4;
    _emit.sizeVariance = 0.8;
    _emit.life = c.emberLifetime * 1.6;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.embers.emit(Math.round(c.emberBurst * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      28
    );
    // The hard one. This is the beat the whole cast is built around, and it is
    // deliberately the brightest flash in the frost-and-flame half of the set.
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.6 * g.explosionIntensity;
  }

  /**
   * `t` runs 0..1 while the disc holds, then 1..2 through the bloom-out.
   *
   * The bloom-out is `outQuint` rather than linear: a sun does not dim evenly,
   * it stays bright and then is suddenly not there. Linear read as a dimmer
   * switch, which is the one thing this slot must not do after that flash.
   */
  onFade(dt, t) {
    const c = settings.sunspear;
    const fade = t <= 1 ? 1 : 1 - Easing.outQuint(saturate(t - 1));

    this._syncParticles();
    this._syncSpear();
    this._syncDisc(fade);

    // The emitter walks off the spear and onto the disc over `discWakeSettle`.
    const settle = saturate((this.age - this._impactAt) / Math.max(0.02, c.discWakeSettle));
    this._syncWake(settle);

    this._discFx(dt, fade);

    this._impactPoint(this.position);
    this.position.y = 0.5;
  }

  onDestroy() {
    this.spear.reset();
    this.corona.clear();
    this.corona.visible = false;
    this.disc.visible = false;
    // Releases the distortion pass's writer counter. Hiding the parent group
    // instead leaks it, and the pass then runs for the rest of the session.
    this.wake.visible = false;
  }

  dispose() {
    this.spear.dispose();
    this.corona.dispose();
    this.disc.dispose();
    this.wake.dispose();
    this.material.dispose();
    super.dispose();
  }
}
