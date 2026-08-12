import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { LiquidSurface, LiquidMode, liquidParams } from '../../vfx/LiquidSurface.js';
import { Projectile, FlightMode, Stagger, projectileParams } from '../../vfx/Projectile.js';
import { DistortionField, DistortionMode } from '../../vfx/Distortion.js';
import { createMagmaBlobMaterial, setBlobColors } from '../../materials/MagmaBlobMaterial.js';
import { createAsteroidGeometry } from '../../assets/ProceduralGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../../utils/math.js';

/** Hard ceiling on blobs. The editor's `blobs` slider clamps here. */
const MAX_BLOBS = 48;
/**
 * Grid resolution of the heightfield. Below about 48 the Gerstner cusps facet
 * visibly; above about 160 you are paying vertex cost for detail the shading
 * normal already carries for free, because the normal is four evaluations of
 * the whole field rather than a difference of neighbouring vertices.
 */
const POOL_SEGMENTS = 108;

/* --- module-scope scratch: the frame allocates nothing (I3) --- */
const _liq = liquidParams();
const _proj = projectileParams();
const _haze = {};
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _hit = new Vector3();
const _up = new Vector3(0, 1, 0);

/**
 * MAGMA FOUNT — a molten pool torn open in the floor, with a fount playing out
 * of the middle of it.
 *
 * The floor swells and splits, the fount runs for a long hold, and then it
 * cools: the crust closes over, the seams dim, and the last thing left on
 * screen is the heat coming off a black slab.
 *
 * **THE TRICK — the pool is real, and the crust is a consequence rather than a
 * decoration.** `vfx/LiquidSurface.js` is a live heightfield whose fragment
 * shader computes an honest 2-D **surface speed** in metres per second: a bulk
 * drift, a radial outflow that dies with distance from the feed, eddies taken
 * as the *curl* of a scalar noise field (so they swirl without any point acting
 * as a source or a sink), and downhill gravity read straight off the shading
 * normal. Crust coverage is then `1 − smoothstep(crustForm, crustBreak, speed)`
 * and the crack pattern is the zero crossing of a signed fbm evaluated in a
 * frame built from the flow direction and squashed along it, so the seams run
 * *with* the pour like pahoehoe instead of crazing like pottery.
 *
 * Which means: a blob lands, `rippleAtWorld()` puts an analytic packet into the
 * heightfield, the packet steepens the local slope, the slope feeds
 * `flowGravity`, the flow pushes the surface past `crustBreak`, and **the black
 * skin tears open along the ripple front and glows** — then heals behind it as
 * the packet decays. Nothing in this file says "crack when a blob lands". The
 * coupling is real, and that is why it reads.
 *
 * The cool is the same mechanism run backwards. It does not paint crust on; it
 * takes the *flow* away — `flowRadial`, `flowEddy` and `flowSpeed` all ramp to
 * zero over `coolTime` — and coverage goes to one on its own, at which point
 * the only thing still moving on screen is the `HEAT` emitter's shimmer.
 *
 * **Ordering matters and is easy to get wrong.** `rippleAtWorld()` converts a
 * world point into a *fraction* of this frame's half-extents, so it must be
 * called after `LiquidSurface.update()` on the frame it is measured against.
 * The update order here is therefore: pool, then blobs, then arrivals. Do it
 * the other way round while the pool is still swelling and every early ripple
 * lands at the wrong radius — subtly, and only during the first half second,
 * which is the worst kind of bug to notice.
 *
 * **Budget.** `LiquidSurface` is fill-heavy — one per screen — so everything
 * else in this ability is deliberately cheap: the fount is one `Projectile`
 * (two draw calls, bodies and trails, however many blobs), the shimmer is one
 * emitter into a buffer nothing else reads, and there is no `GroundField`
 * because a second full-footprint quad under the pool would double the most
 * expensive thing on screen to add a mark you cannot see through the melt. The
 * scorched rock outside the waterline is shared decals instead.
 *
 * A cast captures two numbers: a seed and the timestamp the floor split at.
 * Everything with a unit is resolved from `settings.magma` every frame,
 * zero-length frames included.
 *
 * Four draw calls: the pool, the blobs, their trails, the shimmer.
 */
export class MagmaAbility extends Ability {
  constructor(context) {
    super('magma', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the pool --------------------------------------------------- */
    this.pool = new LiquidSurface({
      segments: POOL_SEGMENTS,
      mode: LiquidMode.POOL,
      // A heightfield is a solid: its own crests must hide its far side, or a
      // swell reads as a sheet of cellophane.
      depthWrite: true,
      doubleSide: true,
      renderOrder: 3,
      name: 'magma.pool'
    });
    this.pool.object3D.layers.set(LAYER.VFX);
    this.group.add(this.pool.object3D);

    /* --- the fount --------------------------------------------------- */
    this.blobMaterial = createMagmaBlobMaterial();
    this.blobs = new Projectile(this.group, {
      capacity: MAX_BLOBS,
      // A factory, not a geometry: `Projectile` takes ownership of what this
      // returns and rebuilds it whenever `shapeKey()` moves, which is what
      // makes the four shape sliders live.
      geometry: () => {
        const c = settings.magma;
        return createAsteroidGeometry({
          seed: 7,
          detail: c.blobDetail,
          lumpiness: c.blobLumpiness,
          noiseScale: c.blobNoiseScale,
          roughness: c.blobRoughness,
          // No cuts and no craters. A blob of melt has no flat faces and no
          // impact scars — the first build reused Cinder Fall's rock wholesale
          // and it read as a burning pebble, not as something poured.
          cuts: 0,
          craters: 0
        });
      },
      shapeKey: () => {
        const c = settings.magma;
        return `${Math.round(c.blobDetail)}|${c.blobLumpiness}|${c.blobNoiseScale}|${c.blobRoughness}`;
      },
      material: this.blobMaterial,
      trail: true,
      trailNodes: 26,
      trailAdditive: true,
      layer: LAYER.VFX,
      renderOrder: 6,
      castShadow: false
    });

    /* --- the shimmer -------------------------------------------------- */
    // UPRIGHT rather than BILLBOARD: heat rises vertically whatever the camera
    // is doing, and a full billboard makes the column lean over when you orbit,
    // which the eye reads as wind rather than as heat.
    this.haze = new DistortionField({ mode: DistortionMode.HEAT, name: 'magma.haze' });
    this.group.add(this.haze.object3D);

    /** Re-rolled per cast — decorrelates the pool's noise and the fount's dice. */
    this._seed = 0;
    /** `this.age` at the moment the floor split. A timestamp, not a duration. */
    this._foundAt = 0;
    /** Blobs drawn last frame, for the HUD's instance readout. */
    this._live = 0;
    /** 0 while the cast is still travelling, then `t` out of `onFade`. */
    this._beat = 0;
    /**
     * 0..1 — is the fount still playing? Resolved once per frame in `_sync`
     * and read by the emitters, so the one expression that decides it lives in
     * one place rather than in three.
     */
    this._fountGate = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Droplets thrown off the fount and off every landing. Additive and soft:
    // this is the melt in the air, and it has to read as *light* rather than as
    // grit or the pool stops looking hot.
    this.spatter = particles.get('magma.spatter', {
      capacity: 3000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.35
    });
    this.spatter.uniforms.uDrag.value = 1.2;
    this.spatter.uniforms.uEndSize.value = 0.25;
    this.spatter.uniforms.uSizeIn.value = 0.05;
    this.spatter.uniforms.uFadeIn.value = 0.05;
    this.spatter.uniforms.uFadeOut.value = 0.5;

    // Chips that have already chilled. Lit and non-additive, so they read as
    // solid rock against the glow — the contrast is the point.
    this.cinders = particles.get('magma.cinders', {
      capacity: 1400,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.cinders.uniforms.uDrag.value = 0.35;
    this.cinders.uniforms.uEndSize.value = 0.7;
    this.cinders.uniforms.uFadeOut.value = 0.65;

    this.smoke = particles.get('magma.smoke', {
      capacity: 1800,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.2
    });
    this.smoke.uniforms.uDrag.value = 2.0;
    this.smoke.uniforms.uEndSize.value = 3.4;
    this.smoke.uniforms.uSizeIn.value = 0.16;
    this.smoke.uniforms.uFadeIn.value = 0.22;
    this.smoke.uniforms.uFadeOut.value = 0.3;

    this.spatterEmitter = new RateEmitter();
    this.cinderEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._live;
  }

  /** The long hold: the fount runs for the whole of it. */
  get impactDuration() {
    return Math.max(0.1, settings.magma.lifetime * settings.global.lifetime);
  }

  /** The cool. */
  get fadeDuration() {
    return Math.max(0.1, settings.magma.fadeTime);
  }

  /** A slow, heavy gutter — this is a pool breathing, not a bolt striking. */
  lightShimmer() {
    const c = settings.magma;
    const step = Math.floor(this.age * Math.max(1, c.lightFlickerSpeed));
    const noise = Math.abs(Math.sin(step * 127.1) * 43758.5453) % 1;
    return 1 - saturate(c.lightFlicker) * noise;
  }

  /* ------------------------------------------------------------------ */
  /* The beats                                                           */
  /* ------------------------------------------------------------------ */

  /** The centre of the footprint — the far end of the aimed line. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /**
   * 0..1 — how far the pool has opened out.
   *
   * During travel it is only the swelling: the floor bulges to `preFill` of the
   * footprint and no further. The rest arrives when the floor splits.
   */
  _fill() {
    const c = settings.magma;
    if (this.phase === AbilityPhase.TRAVEL) return saturate(c.preFill) * this.u;
    const open = Easing.outCubic(saturate(this.impactTime / Math.max(0.02, c.swellTime)));
    return lerp(saturate(c.preFill), 1, open);
  }

  /** 0..1 — how far the flow has died. Zero until the fade phase starts. */
  _cool() {
    const c = settings.magma;
    return Easing.inOutCubic(saturate(this.fadeTime / Math.max(0.05, c.coolTime)));
  }

  /** 0..1 — how hard the fount is playing. */
  _fount() {
    const c = settings.magma;
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    const ramp = saturate((this.age - this._foundAt) / Math.max(0.02, c.fountRamp));
    return ramp * (1 - this._cool());
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.spatterEmitter.reset();
    this.cinderEmitter.reset();
    this.smokeEmitter.reset();
    this._foundAt = 0;
    this._beat = 0;
    this._live = 0;

    this._seed = Math.random() * 100;
    this.blobs.reset();
    this.blobs.roll(this._seed);
    this.pool.reset();
    this.pool.visible = true;
    this.haze.visible = true;

    this._sync();
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve the pool, the fount and the shimmer from live settings.
   *
   * Every metre, radian and second below is read on the frame it is used,
   * including a zero-length one. The order — pool, then blobs, then the
   * arrivals the blobs raised — is load-bearing; see the class comment.
   */
  _sync() {
    const c = settings.magma;
    const g = settings.global;

    const cool = this._cool();
    const fount = this._fount();
    // The flow is what everything else is a function of, so the cool is one
    // multiplier applied to three sliders rather than a second set of
    // "cooled" values that would have to be kept in step with the first.
    const flowing = 1 - cool;

    this._centrePoint(_centre);

    /* ---------------- the pool ---------------- */
    _centre.y = c.poolHeight;
    this.pool.setPlacement(_centre, this.direction, _up);
    _centre.y = 0;

    _liq.sizeX = c.zoneRadius * 2;
    _liq.sizeZ = c.zoneRadius * 2;
    _liq.fill = this._fill();
    _liq.round = c.round;
    _liq.edgeSoft = c.edgeSoft;
    _liq.edgeNoise = c.edgeNoise;
    _liq.edgeScale = c.edgeScale;
    _liq.seed = this._seed;
    _liq.opacity = c.poolOpacity * g.opacity;
    _liq.contactFade = c.contactFade;

    // The swell dies with the flow but never entirely: a cooled slab still has
    // the shape the last wave left in it, and flattening it to a plane is the
    // single most obvious way to make the cool look like a fade-out.
    const swell = lerp(1, 0.35, cool);
    _liq.waveAmpA = c.waveAmpA * swell;
    _liq.waveAmpB = c.waveAmpB * swell;
    _liq.waveAmpC = c.waveAmpC * swell;
    _liq.waveAmpD = c.waveAmpD * swell;
    _liq.waveLengthA = c.waveLengthA;
    _liq.waveLengthB = c.waveLengthB;
    _liq.waveLengthC = c.waveLengthC;
    _liq.waveLengthD = c.waveLengthD;
    _liq.waveSpeedA = c.waveSpeedA * flowing;
    _liq.waveSpeedB = c.waveSpeedB * flowing;
    _liq.waveSpeedC = c.waveSpeedC * flowing;
    _liq.waveSpeedD = c.waveSpeedD * flowing;
    _liq.waveAngleA = c.waveAngleA;
    _liq.waveAngleB = c.waveAngleB;
    _liq.waveAngleC = c.waveAngleC;
    _liq.waveAngleD = c.waveAngleD;
    _liq.steepness = c.steepness;

    _liq.chop = c.chop * swell;
    _liq.chopScale = c.chopScale * g.noiseFrequency;
    _liq.chopSpeed = c.chopSpeed * g.noiseSpeed * flowing;
    _liq.detail = c.detail;
    _liq.detailScale = c.detailScale * g.noiseFrequency;
    _liq.detailSpeed = c.detailSpeed * g.noiseSpeed;

    _liq.rippleAmp = c.rippleAmp;
    _liq.rippleSpeed = c.rippleSpeed;
    _liq.rippleLength = c.rippleLength;
    _liq.rippleWidth = c.rippleWidth;
    _liq.rippleDecay = c.rippleDecay;
    _liq.rippleSpread = c.rippleSpread;

    _liq.flowAngle = c.flowAngle;
    _liq.flowSpeed = c.flowSpeed * flowing;
    _liq.flowRadial = c.flowRadial * flowing;
    _liq.flowRadialFall = c.flowRadialFall;
    _liq.flowEddy = c.flowEddy * flowing;
    _liq.flowEddyScale = c.flowEddyScale * g.noiseFrequency;
    _liq.flowEddySpeed = c.flowEddySpeed * g.noiseSpeed;
    // Left alone by the cool on purpose. This is the term that lets a landing
    // blob's ripple tear the skin, and it should keep doing that right up to
    // the moment the surface stops moving at all.
    _liq.flowGravity = c.flowGravity;

    _liq.crust = c.crust;
    _liq.crustForm = c.crustForm;
    _liq.crustBreak = c.crustBreak;
    _liq.crustFormTime = c.crustFormTime;
    _liq.crackScale = c.crackScale * g.noiseFrequency;
    _liq.crackStretch = c.crackStretch;
    _liq.crackWidth = c.crackWidth;
    _liq.crustAdvect = c.crustAdvect;
    _liq.crustPeriod = c.crustPeriod;
    _liq.crustBump = c.crustBump;
    _liq.seamGlow = c.seamGlow * flowing * g.glow;
    _liq.meltGlow = c.meltGlow * flowing * g.glow;

    _liq.poolDepth = c.poolDepth;
    _liq.depthTint = c.depthTint;
    _liq.translucency = c.translucency;
    _liq.ambient = c.ambient;
    _liq.specular = c.specular;
    _liq.shininess = c.shininess;
    _liq.fresnel = c.fresnel * g.fresnel;
    _liq.envIntensity = c.envIntensity;
    _liq.skyIntensity = c.skyIntensity;
    _liq.emissive = c.emissive * flowing;
    _liq.glow = c.poolGlow * g.glow;
    _liq.normalEps = c.normalEps;

    _liq.colorDeep = c.colorDeep;
    _liq.colorShallow = c.colorShallow;
    _liq.colorCrust = c.colorCrust;
    _liq.colorSeam = c.colorSeam;
    _liq.colorHot = c.colorHot;
    _liq.colorSpec = c.colorSpec;
    _liq.colorSky = c.colorSky;

    this.pool.update(this.age, _liq);

    /* ---------------- the fount ---------------- */
    // `setBasis` clamps the length to a centimetre, so the fount's landing disc
    // is centred a centimetre downrange of the pool's centre. That is below the
    // resolution of anything on screen and it buys a launch point that is
    // genuinely the middle of the pool rather than the caster's hand.
    this.blobs.setBasis(_centre, this.direction, this.side, 0.01);

    _proj.mode = FlightMode.ARC;
    _proj.stagger = Stagger.HASH;
    _proj.count = this.phase === AbilityPhase.TRAVEL ? 0 : Math.min(MAX_BLOBS, Math.round(c.blobs));
    _proj.radius = c.blobRadius;
    _proj.sizeJitter = c.blobSizeJitter * g.randomness;
    _proj.stretch = c.blobStretch;
    _proj.align = c.blobAlign;
    _proj.spin = c.blobSpin;
    _proj.flash = c.blobFlash;

    _proj.handForward = c.fountForward;
    _proj.handSide = c.fountSide;
    _proj.handHeight = c.fountHeight;

    _proj.landHeight = c.poolHeight;
    _proj.landInZone = true;
    _proj.zoneRadius = c.zoneRadius * c.blobReach;
    _proj.zoneBias = c.blobBias;

    _proj.pathCurve = c.blobPathCurve;
    _proj.apex = c.blobApex;
    _proj.apexCurve = c.blobApexCurve;
    _proj.weaveSide = c.blobWeaveSide;
    _proj.weaveUp = c.blobWeaveUp;
    _proj.weaveTurns = c.blobWeaveTurns;
    _proj.weaveTurnsUp = c.blobWeaveTurns;
    _proj.weaveDecay = c.blobWeaveDecay;

    _proj.flightTime = c.blobFlight;
    _proj.speedJitter = c.blobSpeedJitter;
    _proj.lead = c.blobLead;
    _proj.window = c.blobWindow;
    _proj.fillBias = c.blobFillBias;
    _proj.fillScatter = c.blobFillScatter;
    _proj.hashCell = c.blobHashCell;
    _proj.linger = c.blobLinger;
    _proj.sink = c.blobSink;

    _proj.trailSpan = c.blobTrailSpan;
    _proj.trailBurn = c.blobTrailBurn;
    _proj.trailWidth = c.blobTrailWidth;
    _proj.trailTaper = c.blobTrailTaper;
    _proj.trailLift = c.blobTrailLift;
    _proj.trailOpacity = c.blobTrailOpacity * g.opacity * flowing;
    _proj.trailGlow = c.blobTrailGlow * g.glow;
    _proj.trailCore = c.blobTrailCore;
    _proj.trailHeadBias = c.blobTrailHeadBias;
    _proj.trailNoise = c.blobTrailNoise * g.turbulence;
    _proj.trailNoiseScale = c.blobTrailNoiseScale * g.noiseFrequency;
    _proj.trailNoiseSpeed = c.blobTrailNoiseSpeed * g.noiseSpeed;
    _proj.trailSoftFade = c.blobTrailSoftFade;

    setBlobColors(this.blobMaterial, c.colorBlobHot, c.colorBlobMelt, c.colorBlobCrust, c.colorBlobSeam);
    const b = this.blobMaterial.uniforms;
    b.uCrust.value = c.blobCrust;
    b.uCrustGrow.value = c.blobCrustGrow;
    b.uCrackScale.value = c.blobCrackScale * g.noiseFrequency;
    b.uCrackWidth.value = c.blobCrackWidth;
    b.uSeamGlow.value = c.blobSeamGlow;
    b.uRim.value = c.blobRim;
    b.uRimPower.value = c.blobRimPower;
    b.uShade.value = c.blobShade;
    b.uAmbient.value = c.blobAmbient;
    b.uFlashGain.value = c.blobFlashGain;
    b.uGlow.value = c.blobGlow * g.glow;
    b.uOpacity.value = c.blobOpacity * g.opacity;
    b.uSoftFade.value = c.blobSoftFade;

    this.blobs.setTrailColors(
      getColor(c.colorBlobTrailA),
      getColor(c.colorBlobTrailB),
      getColor(c.colorBlobTrailC),
      getColor(c.colorBlobTrailD)
    );
    this.blobs.syncGeometry();
    // Blob time starts when the floor splits, not when the cast leaves the
    // hand: the launch window is authored against the fount, and offsetting it
    // by the travel time would make `blobWindow` mean different things at
    // different cast ranges.
    this.blobs.update(Math.max(0, this.age - this._foundAt), _proj);
    this._live = this.blobs.count;

    /* ---------------- the ripples the fount punches ---------------- */
    // Straight after `update()`, which is where the module says to read them,
    // and after the pool's own update, which is where `rippleAtWorld()` gets
    // this frame's half-extents from.
    for (let i = 0; i < this.blobs.arrivalCount; i++) {
      const index = this.blobs.arrivals[i];
      this.blobs.landPoint(index, _hit);
      this.pool.rippleAtWorld(_hit, c.rippleStrength, this.age);
      this._splashFx(_hit);
    }

    /* ---------------- the shimmer ---------------- */
    _pos.copy(_centre);
    _pos.y = c.poolHeight;
    this.haze.setAnchor(_pos);

    // Held open through the first part of the cool and then let go, so the last
    // thing on screen is heat coming off a slab that has already gone black.
    const hazeOut = saturate((this.fadeTime - c.hazeHold) / Math.max(0.02, c.hazeFade));
    _haze.width = c.zoneRadius * 2 * c.hazeWidth;
    _haze.height = c.hazeHeight;
    // NEVER multiply global.distortion or post.distortion in here — the pass
    // applies both, once, and doing it twice squares them.
    _haze.strength = c.hazeStrength * (1 - hazeOut) * this._fill();
    _haze.opacity = c.hazeOpacity;
    _haze.frequency = c.hazeFrequency * g.noiseFrequency;
    _haze.speed = c.hazeSpeed * g.noiseSpeed;
    _haze.sourceBias = c.hazeSourceBias;
    _haze.spread = c.hazeSpread;
    _haze.vertical = c.hazeVertical;
    _haze.flicker = c.hazeFlicker;
    _haze.depthReject = c.hazeDepthReject;
    _haze.depthFade = c.hazeDepthFade;
    _haze.perspective = c.hazePerspective;
    _haze.perspectiveRef = c.hazePerspectiveRef;
    _haze.seed = this._seed;
    this.haze.update(_haze);

    /* ---------------- the particle systems ---------------- */
    this.spatter.setGradient(
      getColor(c.colorSpatterA),
      getColor(c.colorSpatterB),
      getColor(c.colorSpatterC),
      getColor(c.colorSpatterD)
    );
    this.spatter.uniforms.uGravity.value.set(0, c.spatterGravity, 0);
    this.spatter.uniforms.uSizeScale.value = c.spatterSize * g.particleSize * 7;
    this.spatter.uniforms.uLifeScale.value = c.spatterLifetime * 0.5 * g.particleLifetime;
    this.spatter.uniforms.uSpeedScale.value = g.particleSpeed;
    this.spatter.uniforms.uOpacity.value = g.opacity;
    this.spatter.uniforms.uGlow.value = c.meltGlow * 0.8 * g.glow;
    this.spatter.uniforms.uTurbulence.value = c.spatterTurbulence * g.turbulence;

    this.cinders.setGradient(
      getColor(c.colorCinderA),
      getColor(c.colorCinderB),
      getColor(c.colorCinderC),
      getColor(c.colorCinderD)
    );
    this.cinders.uniforms.uGravity.value.set(0, c.cinderGravity, 0);
    this.cinders.uniforms.uSizeScale.value = c.cinderSize * g.particleSize * 7;
    this.cinders.uniforms.uLifeScale.value = c.cinderLifetime * 0.5 * g.particleLifetime;
    this.cinders.uniforms.uSpeedScale.value = g.particleSpeed;
    this.cinders.uniforms.uOpacity.value = g.opacity;

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
    this.smoke.uniforms.uTurbulence.value = 0.45 * g.turbulence;

    /* ---------------- the light, sitting on the surface ---------------- */
    this.position.copy(_centre);
    this.position.y = c.poolHeight + c.lightHeight;

    // Kept in step with the swell so a pool that has not opened yet is not
    // already lighting the stage.
    this.pool.visible = _liq.fill > 0.001 && _liq.opacity > 0.001;

    // `fount` is consumed by the emitters in `_surfaceFx`; resolving it here
    // keeps the one expression that decides "is it still playing" in one place.
    this._fountGate = fount;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** A point on the pool's surface, `r` being a 0..1 fraction of the radius. */
  _surfacePoint(r, out) {
    const c = settings.magma;
    const angle = Math.random() * Math.PI * 2;
    const radius = c.zoneRadius * this._fill() * r;
    out.set(_centre.x + Math.cos(angle) * radius, c.poolHeight, _centre.z + Math.sin(angle) * radius);
    return out;
  }

  /** Spatter, cinders and smoke coming off the surface while the fount runs. */
  _surfaceFx(dt) {
    const c = settings.magma;
    const g = settings.global;
    const time = frame.uTime.value;
    const gate = this._fountGate;

    const spatterCount = Math.round(this.spatterEmitter.tick(dt, c.spatterRate * gate) * g.particleCount);
    if (spatterCount > 0) {
      // Crowded toward the middle, where the feed is: the outflow is radial, so
      // the surface is fastest at the centre and that is where it throws.
      this._surfacePoint(Math.random() * Math.random(), _pos);
      _emit.position = _pos;
      _emit.radius = c.zoneRadius * 0.12;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.spatterSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.6;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.14;
      _emit.sizeVariance = 0.7;
      _emit.life = c.spatterLifetime;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.spatter.emit(spatterCount, _emit);
    }

    const cinderCount = Math.round(this.cinderEmitter.tick(dt, c.cinderRate * gate) * g.particleCount);
    if (cinderCount > 0) {
      this._surfacePoint(randRange(0.4, 1), _pos);
      _emit.position = _pos;
      _emit.radius = c.zoneRadius * 0.2;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.cinderSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.85;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.cinderLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 9;
      _emit.time = time;
      this.cinders.emit(cinderCount, _emit);
    }

    // Smoke keeps coming off a cooling slab long after the fount has stopped,
    // so it is gated on the pool being open rather than on the fount running.
    const smokeGate = this._fill();
    const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * smokeGate) * g.particleCount);
    if (smokeCount > 0) {
      this._surfacePoint(Math.sqrt(Math.random()), _pos);
      _emit.position = _pos;
      _emit.radius = c.zoneRadius * 0.35;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.95;
      _emit.size = 1.0;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }
  }

  /** The little crown of droplets a blob throws where it goes back in. */
  _splashFx(point) {
    const c = settings.magma;
    const g = settings.global;
    const count = Math.round(c.spatterOnLanding * g.particleCount);
    if (count <= 0) return;

    _emit.position = point;
    _emit.radius = c.blobRadius * 1.4;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.spatterSpeed * 0.85;
    _emit.speedVariance = 0.9;
    // Wide and shallow: a splash crown leaves sideways, and firing it straight
    // up just puts a second small fount on top of the first one.
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.8;
    _emit.life = c.spatterLifetime * 0.7;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.spatter.emit(count, _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._beat = 0;
    this._sync();
    this._surfaceFx(dt);
  }

  onImpact() {
    const c = settings.magma;
    const g = settings.global;
    const time = frame.uTime.value;

    // The one timestamp a cast captures. Everything the fount does is measured
    // from here rather than from the moment the cast left the hand.
    this._foundAt = this.age;

    this._centrePoint(_centre);
    _pos.copy(_centre);
    _pos.y = c.poolHeight;

    /* the shell of burning gas as the floor gives way */
    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: c.burstSize * 0.2,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.8,
      intensity: c.burstIntensity,
      opacity: 0.9,
      fresnel: 1.3,
      displace: 0.85,
      squash: 0.65,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring across the floor */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _centre, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.7,
      width: 0.07,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* scorched rock outside the waterline */
    const marks = Math.max(0, Math.round(c.scorchMarks));
    for (let i = 0; i < marks; i++) {
      // Evenly spaced with a jittered bearing rather than fully random: a
      // handful of random angles clumps, and a clumped ring reads as a mistake
      // rather than as heat.
      const angle = ((i + randRange(-0.35, 0.35)) / marks) * Math.PI * 2;
      const radius = c.zoneRadius * randRange(0.85, 1.25);
      _pos.set(_centre.x + Math.cos(angle) * radius, 0, _centre.z + Math.sin(angle) * radius);
      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: c.scorchRadius * randRange(0.7, 1.3),
        life: c.scorchLife,
        intensity: c.scorchIntensity,
        colorA: getColor(c.colorScorch),
        colorB: getColor(c.colorScorchEmber),
        height: 0.014
      });
    }

    /* the first throw */
    _pos.copy(_centre);
    _pos.y = c.poolHeight + c.fountHeight;
    _emit.position = _pos;
    _emit.radius = c.zoneRadius * 0.2;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.spatterSpeed * 1.8;
    _emit.speedVariance = 0.9;
    _emit.spread = 0.7;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.8;
    _emit.life = c.spatterLifetime * 1.3;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.spatter.emit(Math.round(c.burstSpatter * g.particleCount), _emit);

    _emit.speed = c.cinderSpeed * 1.6;
    _emit.spread = 0.95;
    _emit.size = 0.12;
    _emit.life = c.cinderLifetime;
    _emit.spin = 11;
    this.cinders.emit(Math.round(c.burstCinders * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.1 * g.explosionIntensity;
  }

  onFade(dt, t) {
    this._beat = t;
    this._sync();
    this._surfaceFx(dt);

    // The ground keeps shaking while the fount plays, and stops when it does.
    this.ctx.shake.rumble(
      settings.magma.rumble * this._fountGate * settings.global.cameraShake,
      dt
    );
  }

  onDestroy() {
    this._live = 0;
    this._beat = 0;
    this._fountGate = 0;
    this.blobs.reset();
    this.pool.reset();
    this.pool.visible = false;
    // Toggling the field itself, never the parent group: hiding the group would
    // leak the distortion pass's writer counter for the rest of the session.
    this.haze.visible = false;
  }

  dispose() {
    this.pool.dispose();
    this.blobs.dispose();
    this.blobMaterial.dispose();
    this.haze.dispose();
    super.dispose();
  }
}
