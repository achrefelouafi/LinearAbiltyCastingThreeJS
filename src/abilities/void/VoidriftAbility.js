import { Vector3 } from 'three';
import { Ability } from '../Ability.js';
import { Portal } from '../../vfx/Portal.js';
import { DistortionField, DistortionMode } from '../../vfx/Distortion.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../../utils/math.js';

/* ---------------------------------------------------------------- */
/* Scratch — module scope (I3). Nothing below allocates per frame.   */
/* ---------------------------------------------------------------- */

const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _axis = new Vector3();
const _emit = {};
/** Refilled every frame and handed to `Portal.update`. Never rebuilt. */
const _rift = {};
/** Refilled every frame and handed to `DistortionField.update`. */
const _lens = {};

/**
 * VOID RIFT — a hole, and the two fronts that open it.
 *
 * A slit torn along the aimed line and lying **in the floor plane**, so the
 * camera looks down *into* it: pure black interior, three shells of stars
 * parallaxing against the camera at a deliberately wrong rate, a white-hot
 * fracture rim with a crown of radial cracks, and a screen-space lens at the
 * same anchor bending the floor around the lip. Motes near it spiral in and are
 * eaten at the rim. Closing runs the tear backwards and leaves a hairline.
 *
 * ## THE TRICK — it opens by tearing, on two fronts at once
 *
 * `Portal` already refuses to open by scaling: `open` is a threshold on a
 * ragged field sampled in *metres*, so different bearings cross it at different
 * times and the boundary is ragged in the same places on the way back. That
 * gives the wound its **width** — the seam unzips from the long centreline
 * (`seam` ≈ 0.92) over `openTime`.
 *
 * It does not give the wound its **length**, and length is what a slit is. So
 * the second front is the ability's own: `radiusX` marches outward from a
 * `tearSeed` nick at `tearSpeed` metres per second while `radiusY` — the
 * half-width across the line — never moves. The two ends propagate along the
 * cast line and the slit stays exactly as wide as it started. Grow both radii
 * together and you have a sprite scaling up, which is what the first build did:
 * it read as a decal fading in, not as space being forced apart. The give-away
 * was the crack crown, which grew *with* the aperture instead of being outrun
 * by it.
 *
 * Both fronts are resolved from live settings against the cast's own clock
 * (`age`, a timestamp — the one thing a cast may keep), never accumulated. Drag
 * `tearSpeed` with the clock paused and the ends jump to where that speed says
 * they should be.
 *
 * ## The second illusion, and the number that owns it
 *
 * `parallax` must not be 1. One is geometrically honest and geometric honesty
 * reads as a hole in a wall — you can feel the plane. 1.75 slides the interior
 * against the camera three quarters faster than the aperture says it should,
 * and the mismatch is what makes it a hole in *space*. It is the single most
 * important number in the block and it is a slider for exactly that reason.
 *
 * ## What each of the two draw calls is for
 *
 * `Portal` occludes and glows in one pass, because it writes premultiplied
 * alpha: the interior is `rgb ≈ 0, a = 1` (it genuinely removes the floor) and
 * the rim is `rgb = hot, a = 0` (it genuinely adds over whatever is behind).
 * `DistortionField(LENS)` writes nothing you can see — it puts screen-space
 * offsets in the refraction buffer, and what you see is the floor bending.
 * Portal deliberately writes no offsets of its own, so the two are authored
 * independently: `lensRadius` sits a little past the rift's live half-length so
 * the bend starts *outside* the fracture rather than inside it.
 *
 * Two draw calls for the whole cast, plus two shared particle systems.
 */
export class VoidriftAbility extends Ability {
  constructor(context) {
    super('voidrift', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    // No `writeDepth`: the void must not punch a hole in the transparent queue,
    // because its own motes are transparents drawn after it and the read is
    // that they *reach* the rim before they vanish. Alpha-testing them out a
    // frame early is the difference between "eaten" and "clipped".
    this.rift = new Portal({ renderOrder: 7, name: 'voidrift.rift' });
    this.group.add(this.rift.object3D);

    // BILLBOARD facing, not GROUND. A ground-facing lens is coplanar with the
    // floor it is meant to bend, so `depthReject` sees the floor at its own
    // depth and rejects most of the quad — the warp survives only where the
    // ground happens to be a centimetre lower. A billboard at the same anchor
    // has the floor comfortably behind it everywhere.
    this.lens = new DistortionField({
      mode: DistortionMode.LENS,
      renderOrder: 4,
      name: 'voidrift.lens'
    });
    this.group.add(this.lens.object3D);

    /** Re-rolled per cast: decorrelates the tear grain and the starfield. */
    this._seed = 0;
    /** How many floor stains the racing ends have already paid out. A count. */
    this._stains = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The motes. `swirl` is what makes this system worth its own gradient: the
    // shader orbits each particle about a *travelling anchor* and scales its
    // offset by `1 + uSwirlExpand * t`, so a negative expansion drives the
    // offset to zero at the end of the mote's life. It converges on the rift
    // and is gone. Nothing here fades out and pretends.
    this.motes = particles.get('voidrift.motes', {
      capacity: 1200,
      shape: ParticleShape.SOFT,
      additive: true,
      swirl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 0.9;
    this.motes.uniforms.uEndSize.value = 0.1;
    this.motes.uniforms.uSizeIn.value = 0.1;
    this.motes.uniforms.uFadeIn.value = 0.14;
    this.motes.uniforms.uFadeOut.value = 0.62;

    // Embers shed by the fracture as it opens. Velocity-stretched, additive,
    // and the only warm-bright thing the ability owns besides the rim itself.
    this.embers = particles.get('voidrift.embers', {
      capacity: 1000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.embers.uniforms.uDrag.value = 1.6;
    this.embers.uniforms.uEndSize.value = 0.2;
    this.embers.uniforms.uSizeIn.value = 0.03;
    this.embers.uniforms.uFadeIn.value = 0.04;
    this.embers.uniforms.uFadeOut.value = 0.42;

    this.moteEmitter = new RateEmitter();
    this.emberEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    // Two meshes, and the lens only counts while it is retaining the pass.
    return 1 + (this.lens.visible ? 1 : 0);
  }

  /** The rift stands open. */
  get impactDuration() {
    return Math.max(0.05, settings.voidrift.holdTime * settings.global.lifetime);
  }

  /** The tear runs backwards, then the hairline burns off. */
  get fadeDuration() {
    const c = settings.voidrift;
    return Math.max(0.1, c.closeTime + c.afterTime);
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** World centre of the aperture, on the cast line and off the floor. */
  _riftCentre(out) {
    const c = settings.voidrift;
    this.pointAt(saturate(c.centreBias), out);
    out.y = c.riftHeight;
    return out;
  }

  /**
   * The aperture's local +Y, in world space.
   *
   * At `tilt` = 0 this is `-side`, which puts the plane's normal (`along × up`)
   * straight up: the rift lies in the floor plane and you look down into it.
   * `tilt` rolls it about the cast line, and `riftHeight` is the clearance that
   * stops the low edge dipping under the floor and being depth-rejected.
   */
  _riftAxis(out) {
    const c = settings.voidrift;
    out.copy(this.side).multiplyScalar(-Math.cos(c.tilt));
    out.y += Math.sin(c.tilt);
    return out.normalize();
  }

  /** Full half-length the tear is allowed to reach, metres. */
  _fullHalf() {
    const c = settings.voidrift;
    return Math.max(0.05, this.length * 0.5 * c.riftSpan);
  }

  /**
   * Half-length of the slit right now, metres.
   *
   * The ends race at `tearSpeed` off the cast's own clock rather than off an
   * accumulated distance, which is the difference between a slider that works
   * while paused and one that does not: `age` is a timestamp (allowed), the
   * metres are multiplied out fresh every frame (required).
   *
   * @param {number} retract 0..1 through the close
   */
  _halfLength(retract) {
    const c = settings.voidrift;
    const full = this._fullHalf();
    const seed = Math.min(full, Math.max(0.01, c.tearSeed));
    const open = Math.min(full, seed + c.tearSpeed * this.age);
    return lerp(open, seed, saturate(c.closeDraw) * Easing.inCubic(retract));
  }

  /** How much of the full length the ends have paid out, 0..1. */
  _tearReach() {
    const full = this._fullHalf();
    return saturate(this._halfLength(0) / Math.max(1e-3, full));
  }

  /**
   * The aperture threshold handed to `Portal`.
   *
   * Ascending it unzips the wound across its width; descending it un-tears in
   * the same places, because the field it is thresholding is the same noise.
   * The floor at `afterOpen` is what leaves a hairline behind rather than a
   * clean disappearance.
   */
  _openAmount(retract, after) {
    const c = settings.voidrift;
    const born = saturate(this.age / Math.max(0.02, c.openTime));
    const shut = 1 - Easing.inCubic(retract);
    return Math.max(c.afterOpen * (1 - after), Math.min(born, shut));
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push live settings and the current beat into both draw calls and both
   * particle systems.
   *
   * @param {number} retract 0..1 — the ends pulling back in
   * @param {number} after   0..1 — the hairline burning off
   */
  _syncRift(retract, after) {
    const c = settings.voidrift;
    const g = settings.global;

    const half = this._halfLength(retract);
    const open = this._openAmount(retract, after);
    // The fracture is lifted while the hairline burns, then taken to nothing.
    // Emissive in `Portal` is not scaled by `opacity` — it is additive output,
    // deliberately — so fading the afterimage means fading the four glows.
    const glow = lerp(1, c.afterGlow, after) * (1 - Easing.inQuad(after));

    this._riftCentre(_centre);
    this._riftAxis(_axis);
    this.rift.setPlacement(_centre, this.direction, _axis);

    _rift.radiusX = half;
    _rift.radiusY = Math.max(0.02, c.riftWidth);
    _rift.margin = c.margin;
    _rift.open = open;
    _rift.seam = c.seam;
    _rift.tearJag = c.tearJag;
    _rift.tearScale = c.tearScale * g.noiseFrequency;
    _rift.tearCrawl = c.tearCrawl * g.noiseSpeed;
    _rift.edgeSoft = c.edgeSoft;
    _rift.seed = this._seed;
    _rift.opacity = c.opacity * g.opacity * (1 - after);

    _rift.rim = c.rim;
    _rift.rimGlow = c.rimGlow * glow * g.glow;
    _rift.core = c.core;
    _rift.coreGlow = c.coreGlow * glow * g.glow;
    _rift.throat = c.throat;
    _rift.throatGlow = c.throatGlow * glow * g.glow;
    _rift.crackCount = c.crackCount;
    _rift.crackWidth = c.crackWidth;
    _rift.crackLength = c.crackLength;
    _rift.crackGlow = c.crackGlow * glow * g.glow;

    _rift.parallax = c.parallax;
    _rift.swirl = c.swirl * g.noiseSpeed;
    _rift.interiorFade = c.interiorFade;
    _rift.starSize = c.starSize;
    _rift.starTwinkle = c.starTwinkle;
    _rift.starGain = c.starGain * g.glow;
    _rift.starScaleA = c.starScaleA;
    _rift.starScaleB = c.starScaleB;
    _rift.starScaleC = c.starScaleC;
    _rift.starDepthA = c.starDepthA;
    _rift.starDepthB = c.starDepthB;
    _rift.starDepthC = c.starDepthC;
    _rift.starDriftA = c.starDriftA * g.noiseSpeed;
    _rift.starDriftB = c.starDriftB * g.noiseSpeed;
    _rift.starDriftC = c.starDriftC * g.noiseSpeed;
    _rift.nebulaScale = c.nebulaScale * g.noiseFrequency;
    _rift.nebulaSpeed = c.nebulaSpeed * g.noiseSpeed;
    _rift.nebulaGain = c.nebulaGain;
    _rift.nebulaDepth = c.nebulaDepth;

    _rift.colorVoid = c.colorVoid;
    _rift.colorRim = c.colorRim;
    _rift.colorCore = c.colorCore;
    _rift.colorCrack = c.colorCrack;
    _rift.colorThroat = c.colorThroat;
    _rift.colorStarA = c.colorStarA;
    _rift.colorStarB = c.colorStarB;
    _rift.colorStarC = c.colorStarC;
    _rift.colorNebulaA = c.colorNebulaA;
    _rift.colorNebulaB = c.colorNebulaB;
    this.rift.update(_rift);

    /* --- the lens, at the same anchor, a little wider than the hole --- */
    const lensR = Math.max(0.05, half * c.lensRadius);
    this.lens.setAnchorXYZ(_centre.x, c.lensLift, _centre.z);
    _lens.radius = lensR;
    _lens.width = lensR * c.lensQuad;
    _lens.height = lensR * c.lensQuad;
    // Never multiplied by `post.distortion` or `global.distortion`: the pass
    // applies both, once, and folding them in here would apply them twice.
    _lens.strength = c.lensStrength * (1 - after) * Easing.outQuad(saturate(this.age / 0.18));
    _lens.window = c.lensWindow;
    _lens.core = c.lensCore;
    _lens.swirl = c.lensSwirl;
    _lens.maxOffset = c.lensMax;
    _lens.opacity = 1 - after;
    _lens.seed = this._seed;
    _lens.depthReject = c.lensDepthReject;
    _lens.depthFade = c.lensDepthFade;
    _lens.perspective = c.lensPerspective;
    _lens.perspectiveRef = c.lensPerspectiveRef;
    this.lens.update(_lens);

    /* --- the two particle systems --- */
    this.motes.setGradient(
      getColor(c.colorMoteA),
      getColor(c.colorMoteB),
      getColor(c.colorMoteC),
      getColor(c.colorMoteD)
    );
    this.motes.uniforms.uGravity.value.set(0, c.moteSink, 0);
    this.motes.uniforms.uSwirl.value = c.moteSpin;
    this.motes.uniforms.uSwirlExpand.value = c.motePull;
    this.motes.uniforms.uSizeScale.value = c.moteSize * g.particleSize * 7;
    this.motes.uniforms.uLifeScale.value = c.moteLifetime * 0.5 * g.particleLifetime;
    this.motes.uniforms.uSpeedScale.value = g.particleSpeed;
    this.motes.uniforms.uOpacity.value = g.opacity;
    this.motes.uniforms.uGlow.value = 1.1 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

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
    this.embers.uniforms.uTurbulence.value = 0.2 * g.turbulence;
  }

  /**
   * A point on the aperture's own plane, `u` along it (-1..1) and `v` across.
   * Mirrors the shader's `uAnchor + ax * x + ay * y` exactly, so a mote born
   * "at the rim" is born at the rim the GPU is drawing and not near it.
   */
  _riftPoint(u, v, retract, out) {
    const c = settings.voidrift;
    this._riftCentre(out);
    this._riftAxis(_axis);
    out.addScaledVector(this.direction, u * this._halfLength(retract));
    out.addScaledVector(_axis, v * c.riftWidth);
    return out;
  }

  /**
   * Motes drawn in, embers shed, and the stain the racing ends leave.
   *
   * @param {number} scale 0..1 — thinned once the rift is only holding
   */
  _riftFx(dt, scale, retract) {
    const c = settings.voidrift;
    const g = settings.global;
    const time = frame.uTime.value;

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      // A mote is born in a ball around a point on the rift, and the swirl
      // shader treats that same point as its anchor — so it orbits the rift
      // rather than orbiting wherever it happens to have drifted to.
      this._riftPoint(randRange(-1, 1), 0, retract, _pos);
      _emit.position = _pos;
      _emit.radius = c.moteSpread;
      _emit.direction = _dir.set(0, -1, 0);
      _emit.speed = c.moteDrift;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.4;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    const emberCount = Math.round(this.emberEmitter.tick(dt, c.emberRate * scale) * g.particleCount);
    if (emberCount > 0) {
      const v = randRange(-1, 1);
      this._riftPoint(randRange(-1, 1), v, retract, _pos);
      _emit.position = _pos;
      _emit.radius = 0.06;
      // Off the lip, along the aperture's own normal-ish: away from the plane
      // on whichever side the ember was born.
      _emit.direction = _dir.copy(_axis).multiplyScalar(v >= 0 ? 0.35 : -0.35).setY(0.9).normalize();
      _emit.speed = c.emberSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.75;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.14;
      _emit.sizeVariance = 0.7;
      _emit.life = c.emberLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.embers.emit(emberCount, _emit);
    }
  }

  /**
   * Stains laid on the floor as the ends race past.
   *
   * The counter is a count of events, not a distance: the metres are
   * re-resolved on the frame each stain is spawned, and a decal is allowed to
   * capture its radius because a decal *is* an event (`GroundDecals.spawn`
   * writes `uRadius` once, by design).
   */
  _stainFx() {
    const c = settings.voidrift;
    const full = this._fullHalf();
    const half = this._halfLength(0);
    const step = 1 / Math.max(0.05, c.scorchRate);
    const wanted = Math.min(64, Math.floor((half * 2) / step));

    while (this._stains < wanted) {
      // Alternate ends, so the pair of fronts lay their own marks.
      const side = this._stains % 2 === 0 ? 1 : -1;
      const u = ((this._stains + 1) / Math.max(1, wanted)) * side;
      this._riftPoint(u, randRange(-0.9, 0.9), 0, _pos);
      _pos.y = 0;
      this._stains++;

      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: c.scorchRadius * randRange(0.75, 1.3),
        life: c.scorchLife,
        intensity: c.scorchIntensity * saturate(half / Math.max(0.05, full)),
        colorA: getColor(c.colorScorch),
        colorB: getColor(c.colorScorchEdge),
        height: 0.012
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this.emberEmitter.reset();
    this._stains = 0;
    // The one thing this cast captures, besides its own timestamps.
    this._seed = Math.random() * 100;

    this.rift.visible = true;
    this.lens.visible = true;
    this._syncRift(0, 0);
  }

  onTravel(dt) {
    this._syncRift(0, 0);
    this._riftFx(dt, this._tearReach(), 0);
    this._stainFx();

    // The light sits in the rift, not on the cast front: the hole is what is
    // lighting the floor and there is nothing travelling to follow.
    this._riftCentre(this.position);

    this.ctx.shake.rumble(settings.voidrift.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.voidrift;
    const g = settings.global;
    const time = frame.uTime.value;

    this._riftCentre(_pos);

    /* the shell of displaced air over the middle of the rift */
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.burstSize * 0.2,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.6,
      intensity: c.burstIntensity,
      opacity: 0.85,
      fresnel: 1.7,
      displace: 0.55,
      squash: 0.55,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring that snaps out across the floor as the ends stop */
    this._riftCentre(_pos).setY(0);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.7,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* embers off the whole length at once */
    this._riftCentre(_pos);
    _emit.position = _pos;
    _emit.radius = this._halfLength(0) * 0.8;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.emberSpeed * 2.0;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.18;
    _emit.sizeVariance = 0.8;
    _emit.life = c.emberLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.embers.emit(Math.round(c.burstEmbers * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      19
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.2 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.voidrift;

    // `t` runs 0..1 while the rift stands, then 1..2 while it shuts. Inside the
    // second half the two sub-beats are split by the live pair of times, so
    // re-timing the close re-times a rift that is already shutting.
    const k = saturate(t - 1);
    const share = c.closeTime / Math.max(0.05, c.closeTime + c.afterTime);
    const retract = saturate(k / Math.max(1e-3, share));
    const after = saturate((k - share) / Math.max(1e-3, 1 - share));

    this._syncRift(retract, after);
    this._riftCentre(this.position);

    // The rift keeps eating while it is open and stops the moment it starts to
    // shut: nothing should be drawn into a hole that is no longer there.
    this._riftFx(dt, (t <= 1 ? 1 : 1 - retract) * 0.8, retract);
  }

  onDestroy() {
    // Both of these release something: the portal's mesh, and — the one that
    // matters — the distortion pass's writer counter. An emitter left visible
    // keeps the whole refraction pass running for the rest of the session.
    this.rift.visible = false;
    this.lens.visible = false;
    this._stains = 0;
  }

  dispose() {
    this.rift.dispose();
    this.lens.dispose();
    super.dispose();
  }
}
