import { Mesh, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { VolumeHull, HullShape, Medium } from '../../vfx/VolumeHull.js';
import { FilamentPaths, filamentLook } from '../../vfx/FilamentPaths.js';
import { createBeadOrbitMaterial, createBeadGeometry, MAX_BEADS } from '../../materials/BeadOrbitMaterial.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing } from '../../utils/math.js';

/** Samples along one filament. The ceiling on how fine a kink can be. */
const NODES = 64;

/** Hard ceiling on filaments across all three roles. */
const MAX_FILAMENTS = 44;

/** The three role slots, in the order `FilamentPaths` truncates them. */
const ROLE_THREADS = 0;
const ROLE_RIM = 1;
const ROLE_LEASH = 2;

const TAU = Math.PI * 2;

/* ---------------------------------------------------------------- */
/* Scratch — module scope (I3). Filled and consumed inside one call. */
/* ---------------------------------------------------------------- */

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _hand = new Vector3();
const _a = new Vector3();
const _b = new Vector3();

const _pool = groundFieldParams();
const _look = filamentLook();
/** Handed to the bead material each frame — beats and a seed, never a metre. */
const _bead = { centre: new Vector3(), age: 0, seed: 0, count: 0, climb: 0, seal: 0, reveal: 0, fade: 1 };
_pool.centre = _centre;

/**
 * SANGUINE PACT — a bargain sealed on a circle.
 *
 * Four beats: the pool **draws itself**, the column **rises**, the beads
 * **climb**, and the seal **snaps**.
 *
 * ## The trick — the beads are on real orbits
 *
 * Around the pool, beads of blood climb in genuine three-dimensional orbits:
 * instanced spheres on **inclined ellipses**, each with its own ascending node
 * and its own tilt, so at any instant some of them are in front of the mist
 * column and the rest are behind it, correctly occluded because they are solid
 * bodies writing depth. The whole thing lives in
 * `materials/BeadOrbitMaterial.js` and its header is worth reading: the version
 * this replaced was a ring of billboards in the ground plane, and that version
 * had no perspective in it at all — nothing ever passed behind anything, so the
 * ring sat on the image instead of in the room and collapsed to a line the
 * moment the camera dropped.
 *
 * When the pact seals, one uniform — `uSeal` — takes every tilt to zero, pulls
 * every semi-major axis onto the rim radius, takes the eccentricity out of the
 * ellipses and slides each bead onto an evenly spaced slot. Four changes on one
 * clock, which is why it reads as a single event: the orbits *flatten into the
 * ring plane* and the beads merge into a rim.
 *
 * ## The other three modules
 *
 * - **`GroundField(POOL)`** draws itself. Its growth front is a signed distance
 *   warped in the plane — never on `atan(y, x)`, which hands every radius along
 *   a bearing the same value and opens the pool as a star with dead-straight
 *   arms. The meniscus (`poolThickness`) is the read: surface tension pulls
 *   blood *up* the last few centimetres before the edge, and without that lip a
 *   pool is a coloured disc lying on a floor.
 * - **`VolumeHull(CYLINDER, MIST)`** is the column, and the roster line that
 *   says *the mist is the only soft thing in it* is the art direction for the
 *   whole cast. It is barely absorbing and strongly forward-scattering;
 *   `mistAnisotropy` is what makes it mist rather than fog, and taking it to
 *   zero turns the column into a grey pipe.
 * - **`FilamentPaths`** carries three roles on one instanced strip and costs
 *   two draw calls for all of them: `ORBIT` threads climbing with the beads,
 *   `RIM` arcs travelling round the sealed ring, and the `LINE` leash that runs
 *   out from the caster's hand while the pact is being offered. Setting a
 *   role's count to zero retires it outright, which is how the leash vanishes
 *   on the frame the circle takes over.
 *
 * ## `zoneRadius` is the promise
 *
 * The aim indicator measures out a circle before the click, and five things
 * keep it: the pool's footprint, the column's radius, the beads' mean orbit,
 * the sealed rim and the ring of arcs are each that radius times their own
 * fraction. Drag it on a standing pact and all five re-scale together — the
 * sanctioned kind of shared value, because the sharing *is* the design.
 *
 * ## What a cast captures
 *
 * One number — `_seed` — and timestamps. Every metre, radian and second is
 * re-resolved from `settings.sanguinepact` inside the update loop, on a
 * zero-length frame included. Pause with **P** mid-hold and drag `orbitTilt`:
 * every orbital plane re-inclines under the paused clock.
 */
export class SanguinePactAbility extends Ability {
  constructor(context) {
    super('sanguinepact', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* ---- the pool ---- */
    // Non-additive: a pool of blood is darker than the floor it lies on, and an
    // additive one can only ever be a lit patch of floor.
    this.pool = new GroundField(this.group, {
      mode: GroundMode.POOL,
      additive: false,
      depthTest: true,
      renderOrder: 5,
      name: 'SanguinePact:pool'
    });

    /* ---- the mist column ---- */
    // A CYLINDER stands on the floor with its local +Y up, which is what a
    // column wants; `place()` only ever applies yaw, so it cannot tip off the
    // ground when the caster is facing an odd direction.
    this.column = new VolumeHull({
      hull: HullShape.CYLINDER,
      medium: Medium.MIST,
      prefix: 'mist',
      maxSteps: 40,
      renderOrder: 12,
      seed: Math.random() * 97
    });
    this.group.add(this.column.mesh);

    /* ---- the beads ---- */
    this.beadGeometry = createBeadGeometry(MAX_BEADS, 1);
    this.beadMaterial = createBeadOrbitMaterial();
    this.beads = new Mesh(this.beadGeometry, this.beadMaterial);
    this.beads.name = 'SanguinePact:beads';
    this.beads.frustumCulled = false;
    this.beads.matrixAutoUpdate = false;
    this.beads.layers.set(LAYER.VFX);
    this.beads.renderOrder = 10;
    this.group.add(this.beads);

    /* ---- the filaments ---- */
    this.paths = new FilamentPaths(this.group, {
      samples: NODES,
      capacity: MAX_FILAMENTS,
      renderOrder: 11
    });

    /** Re-rolled per cast so no two pacts draw the same orbits. */
    this._seed = 0;
    /** Filaments and beads drawn last frame — the HUD readout. */
    this._live = 0;
    /** Whether the stain has been laid; one per cast, at the seal. */
    this._stained = false;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Motes: hard flecks of blood carried up by the column. Not additive —
    // additive motes over a dark red mist are pink sparks, and this cast has no
    // sparks in it.
    this.motes = particles.get('sanguinepact.motes', {
      capacity: 2000,
      shape: ParticleShape.SOFT,
      additive: false,
      curl: true,
      lit: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.1;
    this.motes.uniforms.uEndSize.value = 0.3;
    this.motes.uniforms.uSizeIn.value = 0.08;
    this.motes.uniforms.uFadeIn.value = 0.12;
    this.motes.uniforms.uFadeOut.value = 0.4;

    // Drips: what the beads shed on the way round. Falls under gravity and
    // lands back in the pool.
    this.drips = particles.get('sanguinepact.drips', {
      capacity: 1200,
      shape: ParticleShape.SOFT,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.drips.uniforms.uDrag.value = 0.5;
    this.drips.uniforms.uEndSize.value = 0.5;
    this.drips.uniforms.uSizeIn.value = 0.03;
    this.drips.uniforms.uFadeIn.value = 0.05;
    this.drips.uniforms.uFadeOut.value = 0.45;

    this.moteEmitter = new RateEmitter();
    this.dripEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._live;
  }

  /** The column stands and the beads climb. */
  get impactDuration() {
    return Math.max(0.05, settings.sanguinepact.holdTime * settings.global.lifetime);
  }

  /** Then the pact seals and goes out. */
  get fadeDuration() {
    return Math.max(0.05, settings.sanguinepact.sealTime);
  }

  /**
   * A pact does not gutter. Two slow beats a second apart, so the light pulses
   * like something breathing rather than like something electrical.
   */
  lightShimmer() {
    return 0.85 + 0.15 * Math.sin(this.age * 1.9) * Math.sin(this.age * 0.7);
  }

  /* ------------------------------------------------------------------ */
  /* The beats — pure functions of the phase clock and live settings      */
  /* ------------------------------------------------------------------ */

  /** 0..1 how far the pact has run out to the circle. */
  _draw() {
    return this.phase === AbilityPhase.TRAVEL ? this.u : 1;
  }

  /** 0..1 through the hold. */
  _hold() {
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    if (this.phase === AbilityPhase.IMPACT) return saturate(this.impactTime / this.impactDuration);
    return 1;
  }

  /** 0..1 through the seal phase. */
  _sealPhase() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    return saturate(this.fadeTime / this.fadeDuration);
  }

  /**
   * 0..1 how flat the orbits are.
   *
   * Snaps over the first `sealSnap` of the seal phase and then holds at 1 —
   * a fraction of the phase rather than a duration in seconds, so shortening
   * `sealTime` tightens the snap along with everything else instead of leaving
   * a beat that no longer fits inside its own phase.
   */
  _seal() {
    const c = settings.sanguinepact;
    return Easing.outCubic(saturate(this._sealPhase() / Math.max(0.02, c.sealSnap)));
  }

  /** 0..1 how far the beads have climbed the column. */
  _climb() {
    const c = settings.sanguinepact;
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    if (this.phase === AbilityPhase.IMPACT) {
      return Easing.outCubic(saturate(this._hold() / Math.max(0.02, c.climbTime)));
    }
    return 1;
  }

  /** 0..1 how far the mist column has risen. */
  _rise() {
    const c = settings.sanguinepact;
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    if (this.phase === AbilityPhase.IMPACT) {
      return Easing.outQuad(saturate(this._hold() / Math.max(0.02, c.columnTime)));
    }
    return 1;
  }

  /** The footprint the indicator measured out, metres. */
  get radius() {
    return Math.max(0.05, settings.sanguinepact.zoneRadius);
  }

  /** The centre of the pact — the far end of the aimed line, on the floor. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** Where the leash leaves the caster, in world space. */
  _handPoint(out) {
    const c = settings.sanguinepact;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this.dripEmitter.reset();
    this._stained = false;

    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;

    this._sync(1);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Re-resolve the pool, the column, the beads and the three filament roles
   * from live settings and push them into their modules.
   *
   * @param {number} fade 1 while the pact stands, ramping to 0 as it goes out
   */
  _sync(fade) {
    const c = settings.sanguinepact;
    const g = settings.global;

    const zone = this.radius;
    const draw = this._draw();
    const climb = this._climb();
    const rise = this._rise();
    const seal = this._seal();

    this._centrePoint(_centre);

    /* ---------------- the pool ---------------- */
    _pool.yaw = Math.atan2(this.direction.x, this.direction.z);
    _pool.height = c.poolHeight;
    _pool.radius = zone * c.poolScale;
    // The pool draws itself: the growth front is the travel clock, so the SDF
    // spreads outward on the same beat the cast is arriving on.
    _pool.grow = draw;
    // At the very end of the seal the pool is pulled back into the rim rather
    // than dimmed — a pool that fades out reads as a projector being switched
    // off, and one that shrinks reads as liquid going somewhere.
    _pool.recede = Easing.inQuad(saturate((this._sealPhase() - c.sealHold) / Math.max(0.02, 1 - c.sealHold)));
    _pool.fade = fade;
    _pool.seed = this._seed;
    _pool.edge = c.poolEdge;
    _pool.ragged = c.poolRagged;
    _pool.raggedScale = c.poolRaggedScale;
    _pool.warp = c.poolWarp;
    _pool.relief = c.poolRelief;
    _pool.normalStep = c.poolNormalStep;
    _pool.ambient = c.poolAmbient;
    _pool.wrap = c.poolWrap;
    _pool.specular = c.poolSpecular;
    _pool.gloss = c.poolGloss;
    _pool.parallax = c.poolParallax;
    _pool.cell = c.poolCell;
    _pool.lift = c.poolLift;
    _pool.depth = c.poolDepth;
    _pool.thickness = c.poolThickness;
    _pool.detail = c.poolDetail;
    _pool.speed = c.poolSpeed;
    _pool.flow = c.poolFlow;
    _pool.windAngle = c.poolWindAngle;
    _pool.additive = false;
    _pool.emissive = c.poolEmissive;
    _pool.opacity = c.poolOpacity;
    _pool.depthFade = c.poolDepthFade;
    _pool.colorBase = c.colorPoolBase;
    _pool.colorEdge = c.colorPoolEdge;
    _pool.colorGlow = c.colorPoolGlow;
    _pool.colorDeep = c.colorPoolDeep;
    _pool.noiseStrength = g.noiseStrength;
    _pool.noiseFrequency = g.noiseFrequency;
    _pool.noiseSpeed = g.noiseSpeed;
    _pool.opacityScale = g.opacity;
    this.pool.setVisible(fade > 0.002 && _pool.grow > 0.002);
    this.pool.update(_pool);

    /* ---------------- the mist column ---------------- */
    // The hull must be the smallest shape that still contains the field: the
    // radius is the footprint's own fraction and the height is the rise beat,
    // so the proxy grows with the smoke rather than standing at full size while
    // an empty march crosses vacuum above it.
    const columnRadius = Math.max(0.05, zone * c.mistScale);
    this.column
      .place(_centre, this.direction)
      .setSize(columnRadius, Math.max(0.05, c.mistHeight * rise), columnRadius)
      .setFade(fade * rise)
      .sync(c, g);

    /* ---------------- the beads ---------------- */
    _bead.centre.copy(_centre);
    _bead.age = this.age;
    _bead.seed = this._seed;
    _bead.count = Math.max(0, Math.min(MAX_BEADS, Math.round(c.beadCount * g.particleCount)));
    _bead.climb = climb;
    _bead.seal = seal;
    // The beads climb out of the pool as it draws, and go out with the fade.
    _bead.reveal = Math.min(draw, fade);
    _bead.fade = fade;
    this.beadMaterial.userData.sync(_bead);
    this.beadGeometry.instanceCount = _bead.count;
    this.beads.visible = _bead.count > 0 && fade > 0.002;

    /* ---------------- the filaments ---------------- */
    const threads = this.paths.role(ROLE_THREADS);
    const rim = this.paths.role(ROLE_RIM);
    const leash = this.paths.role(ROLE_LEASH);

    // Threads climb with the beads and are retired by the seal — once the ring
    // is flat there is nothing left for them to wind around.
    threads.count = Math.round(c.threadCount * (1 - seal));
    _a.copy(_centre).setY(c.beadClimbBase);
    _b.copy(_a).setY(_a.y + c.threadPoleHeight);
    threads
      .orbit(
        _a,
        _b,
        zone * c.threadRadiusScale,
        c.threadArc,
        c.threadSpin,
        c.threadWobble,
        c.threadTilt,
        c.threadTiltSpread,
        c.threadRadiusJitter
      )
      .style(c.threadKink, c.threadWidthScale, c.threadDim * climb, 1)
      .ends(1, 1, 1, 1)
      .draw(2, 0.1, -1e4, 0);

    // Rim arcs are the seal's own signature: they do not exist until it lands.
    rim.count = Math.round(c.rimArcs * seal);
    _a.copy(_centre).setY(c.rimHeight);
    _b.copy(_a).setY(_a.y + 1);
    rim
      .rim(
        _a,
        _b,
        zone * c.rimScale,
        c.rimSpan,
        c.rimSpeed,
        c.rimArcLift,
        c.rimArcJitter,
        c.rimArcHug,
        this._seed
      )
      // `groundDamp` at 0.3: a kink with a free y buries half of a filament
      // running flat, and the effect reads as a broken dotted line.
      .style(c.rimKink, c.rimWidthScale, c.rimDim, 0.3)
      .ends(1, 1, 1, 1)
      .draw(2, 0.08, c.rimHeight * 0.25, 0.6);

    // The leash exists only while the pact is being offered.
    const offering = this.phase === AbilityPhase.TRAVEL ? 1 : 0;
    leash.count = Math.round(c.leashCount * offering);
    this._handPoint(_hand);
    _a.copy(_centre).setY(c.poolHeight);
    leash
      .line(
        _hand,
        _a,
        c.leashSag,
        c.leashSpreadNear,
        c.leashSpread,
        c.leashSpreadCurve,
        c.leashTwist,
        c.leashTwistSpeed,
        c.leashConverge
      )
      .style(c.leashKink, c.leashWidthScale, c.leashDim, 0.6)
      .ends(0, 1, 0, 1)
      .draw(draw, 0.12, 0, 1.2);

    _look.width = c.threadWidth;
    _look.glowWidth = c.threadGlowWidth;
    _look.glowOpacity = c.threadGlowOpacity;
    _look.jitter = c.threadJitter;
    _look.jitterScale = c.threadJitterScale;
    _look.octaves = c.threadOctaves;
    _look.jitterFalloff = c.threadJitterFalloff;
    _look.crawl = c.threadCrawl;
    _look.pinch = c.threadPinch;
    _look.restrike = c.threadRestrike;
    _look.flicker = c.threadFlicker;
    _look.flickerSpeed = c.threadFlickerSpeed;
    _look.strandFlash = c.threadStrandFlash;
    _look.coreSharp = c.threadCoreSharp;
    _look.glowFalloff = c.threadGlowFalloff;
    _look.softFade = c.threadSoftFade;
    _look.opacity = c.threadOpacity;
    _look.glow = c.threadGlow;
    _look.colorCore = c.colorThreadCore;
    _look.colorInner = c.colorThreadInner;
    _look.colorOuter = c.colorThreadOuter;
    _look.colorHalo = c.colorThreadHalo;
    _look.randomness = g.randomness;
    _look.noiseStrength = g.noiseStrength;
    _look.noiseFrequency = g.noiseFrequency;
    _look.noiseSpeed = g.noiseSpeed;
    _look.opacityScale = g.opacity;
    _look.glowScale = g.glow;
    this.paths.sync(_look, fade, this._seed);
    this._live = _bead.count + this.paths.liveCount;

    /* ---------------- the particle systems ---------------- */
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
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

    this.drips.setGradient(
      getColor(c.colorDripA),
      getColor(c.colorDripB),
      getColor(c.colorDripC),
      getColor(c.colorDripD)
    );
    this.drips.uniforms.uGravity.value.set(0, c.dripGravity, 0);
    this.drips.uniforms.uSizeScale.value = c.dripSize * g.particleSize * 7;
    this.drips.uniforms.uLifeScale.value = c.dripLifetime * 0.5 * g.particleLifetime;
    this.drips.uniforms.uSpeedScale.value = g.particleSpeed;
    this.drips.uniforms.uOpacity.value = g.opacity;

    /* ---------------- where the light stands ---------------- */
    // Inside the column, a third of the way up: at the floor it lights only the
    // pool, and at the top it lights nothing but air.
    this.position.copy(_centre).setY(c.mistHeight * rise * 0.34 + c.poolHeight);
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Motes lifted by the column and drips shed by the beads.
   *
   * @param {number} dt    seconds
   * @param {number} scale 0..1 — thinned as the pact goes out
   */
  _pactFx(dt, scale) {
    const c = settings.sanguinepact;
    const g = settings.global;
    const time = frame.uTime.value;
    const zone = this.radius;

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      // Off the pool's surface, anywhere inside the meniscus. Emitted from the
      // floor rather than from the column's middle: the column is what carries
      // them, not what makes them.
      _pos.copy(_centre).setY(c.poolHeight + 0.05);
      _emit.position = _pos;
      _emit.radius = zone * c.poolScale * 0.85;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.35;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.7;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    const dripCount = Math.round(this.dripEmitter.tick(dt, c.dripRate * scale) * g.particleCount);
    if (dripCount > 0) {
      // From a point on the mean orbit, at a height inside the climbing band —
      // the same shell the beads are on, so a drip looks shed rather than
      // spawned. The angle is a dice roll, which is allowed; the radius and the
      // height are metres and are resolved here, which is required.
      const angle = Math.random() * TAU;
      const orbit = zone * c.orbitScale;
      _pos.copy(_centre);
      _pos.x += Math.cos(angle) * orbit;
      _pos.z += Math.sin(angle) * orbit;
      _pos.y = c.beadClimbBase + c.beadClimbTop * Math.random() * this._climb();
      _emit.position = _pos;
      _emit.radius = c.beadSize * 3;
      _emit.direction = _dir.set(0, -1, 0);
      _emit.speed = c.dripSpeed;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.5;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.6;
      _emit.life = c.dripLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.time = time;
      this.drips.emit(dripCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1);
    // The pool is still drawing itself, so it is not shedding much yet.
    this._pactFx(dt, this._draw() * 0.5);
  }

  onImpact() {
    // The pact is *offered* here, not sealed — the loud beat is at the seal, so
    // this one is deliberately quiet: the leash lets go and the pool rings.
    const c = settings.sanguinepact;
    const g = settings.global;

    this._centrePoint(_pos);
    this.ctx.decals.spawn(DecalType.RIPPLE, _pos, {
      radius: this.radius * c.poolScale * 1.1,
      life: 0.9,
      width: 0.08,
      intensity: 0.55,
      colorA: getColor(c.colorPoolEdge),
      colorB: getColor(c.colorPoolBase)
    });

    this.lightBoost = c.lightIntensity * 0.35 * g.explosionIntensity;
  }

  onFade(dt, t) {
    // `t` runs 0..1 through the hold, then 1..2 through the seal. The pact
    // stands at full strength until `sealHold` of the seal phase has gone by,
    // then goes out — a bargain does not dim while it is being struck.
    const c = settings.sanguinepact;
    const phase = t <= 1 ? 0 : saturate(t - 1);
    const out = saturate((phase - c.sealHold) / Math.max(0.02, 1 - c.sealHold));
    const fade = 1 - Easing.inQuad(out);

    this._sync(fade);

    // The one-shot fires on the frame the flattening completes, not on entry to
    // the phase: the snap is the *arrival* of the rim, and firing it early puts
    // the bang a quarter of a second before the picture.
    if (!this._stained && this._seal() > 0.85) {
      this._stained = true;
      this._sealFx();
    }

    // Loudest while the beads are still climbing, then thinned to nothing.
    this._pactFx(dt, t <= 1 ? lerp(0.5, 1, this._climb()) : fade * 0.3);

    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  /** The snap: the rim arrives and the pact is sealed. */
  _sealFx() {
    const c = settings.sanguinepact;
    const g = settings.global;
    const time = frame.uTime.value;

    this._centrePoint(_pos);
    _pos.y = c.rimHeight;

    this.ctx.bursts.spawn(BurstMode.WATER, _pos, {
      radius: c.sealBurstSize * 0.25,
      endRadius: c.sealBurstSize * g.explosionIntensity,
      life: 0.55,
      intensity: c.sealBurstIntensity,
      opacity: 0.8,
      fresnel: 1.5,
      displace: 0.4,
      // Squashed hard: the seal is a ring closing in a plane, so the shell that
      // marks it has to be a disc and not a ball.
      squash: 0.3,
      colorA: getColor(c.colorSealA),
      colorB: getColor(c.colorSealB),
      colorC: getColor(c.colorSealC)
    });

    this._centrePoint(_pos);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.sealShockRadius * g.explosionIntensity,
      life: 0.5,
      width: 0.06,
      intensity: 0.9,
      colorA: getColor(c.colorSealShockA),
      colorB: getColor(c.colorSealShockB)
    });

    this.ctx.decals.spawn(DecalType.FOAM, _pos, {
      radius: c.stainRadius,
      life: c.stainLife,
      intensity: c.stainIntensity,
      colorA: getColor(c.colorStainA),
      colorB: getColor(c.colorStainB),
      height: 0.013
    });

    /* drips flung outward off the closing rim */
    _pos.y = c.rimHeight;
    _emit.position = _pos;
    _emit.radius = this.radius * c.rimScale;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dripSpeed * 3.2;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.11;
    _emit.sizeVariance = 0.7;
    _emit.life = c.dripLifetime * 1.4;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.drips.emit(Math.round(c.sealDrips * g.particleCount), _emit);

    _emit.speed = c.moteSpeed * 3.5;
    _emit.size = 0.08;
    _emit.life = c.moteLifetime;
    this.motes.emit(Math.round(c.sealMotes * g.particleCount), _emit);

    this.ctx.shake.add(
      c.sealShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.sealShakeDuration),
      22
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.sealFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.2 * g.explosionIntensity;
  }

  onDestroy() {
    this._live = 0;
    this._stained = false;
    this.pool.setVisible(false);
    this.pool.clearMarks();
    this.column.setFade(0);
    this.paths.clear();
    this.beads.visible = false;
    this.beadGeometry.instanceCount = 0;
  }

  dispose() {
    this.pool.dispose();
    this.column.dispose();
    this.paths.dispose();
    this.beadGeometry.dispose();
    this.beadMaterial.dispose();
    super.dispose();
  }
}
