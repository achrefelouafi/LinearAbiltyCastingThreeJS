import { MeshStandardMaterial, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { InkDiffusion, InkMode, inkDiffusionParams } from '../../vfx/InkDiffusion.js';
import { Projectile, FlightMode, Stagger, projectileParams } from '../../vfx/Projectile.js';
import { createAsteroidGeometry } from '../../assets/ProceduralGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, Easing, randRange } from '../../utils/math.js';

/**
 * Satellite slots the shader carries, and therefore the ceiling on the
 * `satellites` slider. Sixteen teardrops is where the far field stops looking
 * countable; the fragment walks the list once, so the cost is linear and the
 * quad is not what decides this number — the *readability* is. Past about
 * twenty the power law stops being visible because every size is present.
 */
const MAX_SATELLITES = 16;

/** The mass plus its satellites. One `Projectile` body each. */
const MAX_BODIES = MAX_SATELLITES + 1;

/** Nuclei the mass is allowed to break into. */
const MAX_SOURCES = 3;

/* --- module-scope scratch. Nothing below allocates during a cast (I3) --- */
const _mark = inkDiffusionParams();
const _flight = projectileParams();
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _hit = new Vector3();
const _bead = new Vector3();

/**
 * SPLATTERBRAND — a loaded brush flung down the line.
 *
 * ## The trick: splatter morphology
 *
 * A thrown blob does not make a circle, and the three ways it fails to are all
 * separately identifiable:
 *
 *  - **a directional main mass.** The anisotropy lives in the *metric* — the
 *    distance function is measured in a stretched frame — and never in a
 *    bearing-indexed radius. Writing the front as `f(bearing)` hands every
 *    point along a bearing the same answer and the mass grows flat facets down
 *    its flanks, which is the single most common way this effect is got wrong.
 *    The trailing edge is blunter than the leading one (`massRear`), because
 *    the trailing edge is where the sheet tore away rather than where it spread
 *    to.
 *  - **a crown of teeth on the leading arc.** These *are* bearing-indexed, and
 *    that is correct: a crown is a Rayleigh–Plateau breakup of an expanding rim,
 *    so it genuinely is periodic in bearing, its teeth genuinely are radial, and
 *    its tooth count genuinely does rise with the rim's radius. The rule was
 *    never "never index on bearing", it was "do not index on bearing when the
 *    physics is areal".
 *  - **satellite droplets**, thrown further along the travel vector, **sized by
 *    a bounded Pareto law**, with the *small* ones flying furthest because they
 *    detach last from the fastest part of the sheet and carry the least drag
 *    per unit mass. That last coupling is the recognition cue. Draw the sizes
 *    uniformly instead and you get a dozen identical dots that the eye files as
 *    a stencil; couple distance to the same draw and the far field goes fine
 *    while the near field stays coarse, which is what a splatter looks like.
 *
 * All three live in `vfx/InkDiffusion.js`'s `SPLATTER` mode. What lives *here*
 * is the half of the idea the shader cannot do on its own.
 *
 * ## Every droplet is flown, and it lands in its own mark
 *
 * The obvious build is a splat decal plus a handful of projectiles thrown at
 * roughly the same area. It was the first build, and it is broken in a way that
 * is impossible to un-see once noticed: two independent scatters means drops
 * landing where there is no mark and marks appearing where no drop went.
 *
 * `InkDiffusion` uploads its satellite dice as **uniform arrays** rather than
 * hashing them in the shader precisely so this cannot happen — so the CPU can
 * ask, exactly, where droplet *i* is going and when. This ability therefore
 * flies `satellites + 1` bodies whose endpoints and clocks are *derived from
 * the mark*:
 *
 * ```
 *   offset_i      = satellitePoint(i) − impact           // metres, from the mark
 *
 *   spreadForward = throwFar                depth_i   = offset_i · direction / throwFar
 *   spreadSide    = throwFar · throwSpread  lateral_i = offset_i · side      / spreadSide
 *   radius = 1, sizeJitter = 1              size_i    = R_i − 1
 *   flightTime = length / speed             speed_i   = (landing lateness) / T
 * ```
 *
 * Every one of those right-hand sides is **unitless** — a ratio of two live
 * metres or two live seconds — and every one is recomputed from settings after
 * `InkDiffusion#update()` on the same frame, on a zero-length frame included.
 * The `radius = 1, sizeJitter = 1` pair is the module's size law set to the
 * identity on purpose: the power law belongs to the mark and there must be
 * exactly one copy of it in the ability. Drag `satAlpha` with the clock stopped
 * and the drops still in the air resize and re-aim along with the marks they
 * are going to make.
 *
 * The handover is the point of the whole arrangement. A body's `linger` and
 * `sink` are set so it goes *into* the floor over the same tenth of a second
 * its mark pops in — the drop does not disappear and the splash does not appear
 * from nowhere; the drop becomes the splash.
 *
 * ## One clock
 *
 * The projectile is never given the wall clock. During the travel phase it is
 * given `u · T`, where `T = length / speed` — so the mass is exactly where the
 * base class's front is, and it arrives on the frame the base class enters
 * `IMPACT`. After that it is given `T + (age − landAt)`, which is continuous
 * across the handover because `u = 1` there, and which keeps running while the
 * satellites are still in the air. Two clocks in one ability is how a
 * projectile ends up landing twice.
 *
 * ## The school with no bloom in it
 *
 * No flash, no burst shell, no additive particle, no decal. The mark clamps its
 * own luminance below `post.bloomThreshold`; the trail is `NormalBlending` with
 * pigment-dark stops, so even with `global.glow` pinned it stays an order of
 * magnitude under that threshold. The one specular term is the wet gloss on the
 * leading edge, and it is inside the clamp.
 *
 * ## What a cast captures
 *
 * One seed, one timestamp, and the unitless dice the two modules hold. Not one
 * metre.
 *
 * **Three draw calls** — the mark, the bodies, the ligaments — plus two shared
 * particle systems.
 */
export class SplatterbrandAbility extends Ability {
  constructor(context) {
    super('splatterbrand', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * The mark. `SPLATTER` compiles the mass metric, the crown and the
     * satellite loop into the program; a `BLOOM` would carry none of them.
     */
    this.mark = new InkDiffusion(this.group, {
      mode: InkMode.SPLATTER,
      sources: MAX_SOURCES,
      satellites: MAX_SATELLITES,
      layer: LAYER.VFX,
      renderOrder: 6,
      name: 'splatterbrand.mark'
    });

    /**
     * The bodies in the air.
     *
     * A plain `MeshStandardMaterial` rather than a bespoke shader, and that is
     * a decision rather than a shortcut: ink is a *matte dielectric*, which is
     * the one material the standard model is already exactly right about. Every
     * bespoke material in this project exists because something about it could
     * not be expressed as roughness and albedo — refraction, emission, a
     * blackbody curve — and none of those is true of a blob of pigment.
     * `metalness` ships at zero and stays there.
     */
    this.blobMaterial = new MeshStandardMaterial({
      color: 0x0e0d13,
      roughness: 0.36,
      metalness: 0,
      flatShading: false
    });

    this.body = new Projectile(this.group, {
      // A factory, not a geometry: the module owns the buffer, dresses it with
      // its per-instance attributes and rebuilds it when `shapeKey()` moves.
      geometry: () => this._buildBlob(),
      shapeKey: () => this._shapeKey(),
      material: this.blobMaterial,
      capacity: MAX_BODIES,
      trail: true,
      trailNodes: 20,
      // The one flag that keeps this school honest in this module. Additive
      // ligaments over a matte mark is the failure mode of the whole school.
      trailAdditive: false,
      layer: LAYER.WORLD,
      renderOrder: 3,
      castShadow: true
    });

    /* --- what a cast captures: one seed and one timestamp --- */
    /** Unitless. Decorrelates the fingers, the nuclei and the droplet draw. */
    this._seed = 0;
    /** True once the mass has landed. One-way. */
    this._landed = false;
    /** The moment it did, on the cast's own clock. An event, not a duration. */
    this._landAt = 0;
    /** Signature of the silhouette controls, so a rebuild only follows a change. */
    this._shapeHash = '';
  }

  createParticles() {
    const particles = this.ctx.particles;

    /*
     * The spatter thrown off a landing, and the only thing in this ability that
     * is emitted per event rather than per second.
     *
     * `additive: false`, like everything else here. The first pass had these
     * additive out of habit and a landing droplet threw a small orange firework,
     * which is precisely the reading this school exists to avoid.
     */
    this.spatter = particles.get('splatterbrand.spatter', {
      capacity: 1200,
      shape: ParticleShape.SOFT,
      additive: false,
      softFade: 0.2
    });
    this.spatter.uniforms.uDrag.value = 1.1;
    this.spatter.uniforms.uEndSize.value = 0.4;
    this.spatter.uniforms.uSizeIn.value = 0.03;
    this.spatter.uniforms.uFadeIn.value = 0.04;
    this.spatter.uniforms.uFadeOut.value = 0.55;

    // Atomised ink over the mark. Non-additive so it genuinely occludes what it
    // is standing on.
    this.mist = particles.get('splatterbrand.mist', {
      capacity: 700,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.mist.uniforms.uDrag.value = 2.0;
    this.mist.uniforms.uEndSize.value = 2.6;
    this.mist.uniforms.uSizeIn.value = 0.18;
    this.mist.uniforms.uFadeIn.value = 0.22;
    this.mist.uniforms.uFadeOut.value = 0.38;

    this.mistEmitter = new RateEmitter();
  }

  /** One blob, in unit space — `Projectile` scales it by the body radius. */
  _buildBlob() {
    const c = settings.splatterbrand;
    return createAsteroidGeometry({
      seed: 4.1,
      detail: clamp(Math.round(c.blobFacets), 0, 2),
      lumpiness: c.blobLumps,
      noiseScale: c.blobLumpScale,
      roughness: c.blobRough,
      // No cuts and no craters: those are what make the same generator read as
      // *rock*, and a blob of ink is the one thing in the sandbox with no
      // fracture surfaces at all.
      cuts: 0,
      cutDepth: 0,
      craters: 0,
      craterDepth: 0,
      craterSize: 0.4
    });
  }

  /** Everything `_buildBlob` reads, as one string. A change rebuilds. */
  _shapeKey() {
    const c = settings.splatterbrand;
    return `${Math.round(c.blobFacets)}|${c.blobLumps}|${c.blobLumpScale}|${c.blobRough}`;
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.body.count;
  }

  /**
   * A beat's length in seconds, under the global lifetime knob.
   */
  _span(seconds) {
    return Math.max(0.005, seconds * settings.global.lifetime);
  }

  /**
   * The impact phase has to outlast the *last droplet*, not just the mass.
   *
   * The first version returned `holdTime` alone and the furthest satellites
   * were still half a second from the floor when the phase machine moved on —
   * so the fade started eating the mark while a third of the pattern had not
   * arrived. Adding the throw window here is not padding; it is the statement
   * that the cast is not over until the far field is down.
   */
  get impactDuration() {
    const c = settings.splatterbrand;
    return this._span(c.satDelay + c.satJitter + c.holdTime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.splatterbrand.fadeTime);
  }

  /** A wet mark swells under a moving light; it does not gutter. */
  lightShimmer() {
    const c = settings.splatterbrand;
    return 1 - saturate(c.lightPulse) * 0.5 * (1 - Math.cos(this.age * c.lightPulseSpeed));
  }

  /* ------------------------------------------------------------------ */
  /* The one clock                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Seconds the mass spends in the air, resolved from the cast rather than
   * carried as its own slider.
   *
   * Deriving it from `length / speed` is what keeps the base class's front and
   * the projectile's body in the same place: `speed` already means metres per
   * second everywhere else in the sandbox and a second, independent `flightTime`
   * would be one more number that has to agree with it and eventually will not.
   */
  _throwTime() {
    const c = settings.splatterbrand;
    return Math.max(0.05, this.length / Math.max(0.2, c.speed * settings.global.speed));
  }

  /**
   * The projectile's clock. Monotone across the phase handover by construction:
   * at the moment of impact `u` is 1 and `age − landAt` is 0, so both branches
   * agree on `T`.
   */
  _flightClock() {
    const throwTime = this._throwTime();
    if (this.phase === AbilityPhase.TRAVEL) return this.u * throwTime;
    return throwTime + this._soak();
  }

  /** Seconds since the mass landed. The mark's whole clock. */
  _soak() {
    return this._landed ? Math.max(0, this.age - this._landAt) : 0;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** Where the mass lands: the far end of the aimed line, on the floor. */
  _impactPoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** How many droplets are live this frame. */
  _satelliteCount() {
    return clamp(Math.round(settings.splatterbrand.satellites), 0, MAX_SATELLITES);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.mistEmitter.reset();

    this._landed = false;
    this._landAt = 0;

    // The one thing a cast captures, and it is unitless. Both modules are
    // rolled from it: the mark's dice decide where the droplets go and the
    // body's dice decide how they tumble on the way.
    this._seed = Math.random() * 100;
    this.mark.roll(this._seed);
    this.body.roll(this._seed);

    this._sync(1);
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings into the mark, then derive the flight from the mark,
   * then push both into the particle systems.
   *
   * **Order matters and is the whole mechanism.** `InkDiffusion`'s CPU mirrors
   * (`satellitePoint`, `satelliteSize`, `satelliteReach`, `satelliteAge`) read
   * the params it last resolved, so they are only correct *after* its
   * `update()` on the same frame. Reading them first gives last frame's answer,
   * which is invisible at sixty frames per second and catastrophic on a paused
   * slider drag — the drops would trail the marks by exactly one edit.
   *
   * @param {number} fade 1 while the mark stands, ramping to 0 as it soaks away
   */
  _sync(fade) {
    const c = settings.splatterbrand;
    const g = settings.global;

    this._impactPoint(_hit);
    const satellites = this._satelliteCount();

    /* ---------------- the mark ---------------- */
    const m = _mark;
    m.radius = Math.max(0.2, c.markRadius);
    m.height = c.markHeight;

    m.spread = c.spread;
    m.spreadPower = c.spreadPower;
    m.edge = c.edge;
    m.clipSoft = c.clipSoft;
    m.sources = c.sources;
    m.sourceScatter = c.sourceScatter;
    m.sourceDelay = c.sourceDelay;

    m.finger = c.finger;
    m.fingerMax = c.fingerMax;
    m.coarse = c.coarse;
    m.onset = c.onset;
    m.growth = c.growth;
    m.growthMax = c.growthMax;

    m.core = c.core;
    m.falloff = c.falloff;
    m.film = c.film;
    m.granulation = c.granulation;
    m.granScale = c.granScale;
    m.ring = c.ring;
    m.ringWidth = c.ringWidth;

    m.dryTime = c.dryTime;
    m.wetDarken = c.wetDarken;
    m.gloss = c.gloss;
    m.glossPower = c.glossPower;
    m.meniscus = c.meniscus;

    m.massAlong = c.massAlong;
    m.massAcross = c.massAcross;
    m.massLead = c.massLead;
    m.massRear = c.massRear;
    m.crown = c.crown;
    m.crownSpacing = c.crownSpacing;
    m.crownSharp = c.crownSharp;
    m.crownGate = c.crownGate;

    m.satellites = satellites;
    m.satMin = c.satMin;
    m.satMax = c.satMax;
    m.satAlpha = c.satAlpha;
    m.throwNear = c.throwNear;
    m.throwFar = c.throwFar;
    m.throwCurve = c.throwCurve;
    m.throwSpread = c.throwSpread;
    m.satTail = c.satTail;
    m.satDelay = c.satDelay;
    m.satJitter = c.satJitter;
    m.satPop = c.satPop;

    m.opacity = c.markOpacity * g.opacity;
    m.fade = fade;
    m.ceiling = c.markCeiling;
    m.softFade = c.markSoftFade;
    m.tint = c.markTint;
    m.tintDensity = c.markTintDensity;
    m.colorWash = c.colorMarkThin;
    m.colorBody = c.colorMarkBody;
    m.colorDeep = c.colorMarkDeep;
    m.colorPool = c.colorMarkPool;
    m.colorRing = c.colorMarkRing;
    m.colorWet = c.colorMarkWet;
    m.colorGloss = c.colorMarkGloss;

    // The field's local +z is the travel vector: the axis the mass stretches
    // down, the arc the crown is gated to, and the direction the droplets fly.
    this.mark.setPlacement(_hit, this.direction);
    this.mark.update(this._soak(), m);

    /* ---------------- the flight, derived from the mark ---------------- */
    this._syncFlight(satellites);

    /* ---------------- the two particle systems ---------------- */
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
    this.mist.uniforms.uTurbulence.value = 0.45 * g.turbulence;
  }

  /**
   * Fly the handful, with every endpoint and every clock taken off the mark.
   *
   * Body 0 is the mass and lands at the aim point. Bodies 1..n are the
   * satellites, and the four dice written per body below are the whole of the
   * coupling. They are **written every frame**, not at spawn: they are unitless
   * ratios of live settings, and re-deriving them is what lets a paused
   * `throwFar` drag move the drops in the air along with the marks.
   *
   * @param {number} satellites live droplets this frame
   */
  _syncFlight(satellites) {
    const c = settings.splatterbrand;
    const g = settings.global;
    const p = _flight;
    const throwTime = this._throwTime();
    const throwFar = Math.max(0.05, c.throwFar);
    // The lateral half-cone at the furthest droplet. Guarded, because
    // `throwSpread` at zero is a legitimate authoring choice (a perfectly
    // collimated throw) and a zero divisor here would NaN every body at once.
    const spreadSide = Math.max(1e-3, throwFar * c.throwSpread);

    p.mode = FlightMode.ARC;
    // NONE, because the arrival order is not this module's to decide: it comes
    // out of the mark's own `satDelay` law, applied through the per-body flight
    // times below.
    p.stagger = Stagger.NONE;
    p.count = 1 + satellites;

    // The size law set to the identity, so `dice.size` carries the metre. See
    // the class comment — the power law belongs to the mark.
    p.radius = 1;
    p.sizeJitter = 1;
    p.stretch = c.dropStretch;
    p.align = 1; //  lay the long axis along the heading
    p.spin = c.dropSpin * g.randomness;
    p.flash = c.dropFlash;

    p.handForward = c.handForward;
    p.handSide = c.handSide;
    p.handHeight = c.handHeight;

    p.landInZone = false;
    p.landHeight = c.markHeight;
    p.spreadForward = throwFar;
    p.spreadSide = spreadSide;

    p.pathCurve = c.pathCurve;
    p.apex = c.apex;
    p.apexCurve = c.apexCurve;
    p.weaveSide = 0;
    p.weaveUp = 0;
    p.weaveDecay = 1;

    // The flight-time law set to the identity in the same way: `dice.speed`
    // carries "how many throw-times late this droplet is".
    p.flightTime = throwTime;
    p.speedJitter = 1;
    p.lead = 0;
    p.window = 0;
    p.linger = c.dropLinger;
    p.sink = c.dropSink;

    p.trailSpan = c.trailSpan;
    p.trailBurn = c.trailBurn;
    p.trailWidth = c.trailWidth;
    p.trailTaper = c.trailTaper;
    p.trailLift = c.trailLift;
    p.trailOpacity = c.trailOpacity * g.opacity;
    // Not a glow. The trail is `NormalBlending` here, so this only scales the
    // pigment down; the stops are dark enough that `global.glow` at its maximum
    // still leaves the ligaments an order of magnitude under the bloom
    // threshold. The multiply is the module's and cannot be removed from here.
    p.trailGlow = c.trailGlow * g.glow;
    p.trailCore = c.trailCore;
    p.trailHeadBias = c.trailHeadBias;
    p.trailNoise = c.trailNoise * g.noiseStrength;
    p.trailNoiseScale = c.trailNoiseScale * g.noiseFrequency;
    p.trailNoiseSpeed = c.trailNoiseSpeed * g.noiseSpeed;
    p.trailSoftFade = c.trailSoftFade;

    /* --- the coupling: four unitless dice per body --- */
    const dice = this.body.dice;

    // The mass. Dead centre of the aim point, on time, at its own radius.
    const mass = dice[0];
    mass.depth = 0;
    mass.lateral = 0;
    mass.size = Math.max(0.005, c.massRadius) - 1;
    mass.speed = 0;

    for (let i = 0; i < satellites; i++) {
      const d = dice[i + 1];
      /*
       * `satellitePoint` is the authority on where the mark is, so the offset
       * is *projected out of it* rather than recomputed from the dice. There is
       * then exactly one expression of the lateral cone in the ability, and no
       * second copy of it to get the sign of wrong.
       *
       * Which is not hypothetical. The first version rebuilt the offset by hand
       * as `-(dice.y − 0.5)·2·throwSpread·reach`, on the reasoning that the
       * field's local +x is `-side`. It is — but the sign that matters here is
       * the one on the *projection*, and negating a projection that has already
       * absorbed the axis flip mirrors every droplet across the cast line. The
       * marks and the drops were then in mirror-image scatters that agreed
       * exactly on the middle one, which is the worst possible way for a bug
       * like this to present.
       */
      this.mark.satellitePoint(i, _bead);
      _pos.copy(_bead).sub(_hit);

      d.depth = _pos.dot(this.direction) / throwFar;
      d.lateral = _pos.dot(this.side) / spreadSide;
      d.size = Math.max(0.005, this.mark.satelliteSize(i) * c.dropScale) - 1;
      // `satelliteAge(i)` is seconds since the droplet's mark appeared, read
      // against the mark's current clock — so `age − clock` is how late it is,
      // and dividing by the throw time turns it into the module's jitter
      // fraction. Positive means it lands after the mass, which all of them do.
      d.speed = (this._soak() - this.mark.satelliteAge(i)) / throwTime;
    }

    this.body.setBasis(this.origin, this.direction, this.side, this.length);
    this.body.setTrailColors(c.colorTrailA, c.colorTrailB, c.colorTrailC, c.colorTrailD);
    this.body.update(this._flightClock(), p);

    this.blobMaterial.color.copy(getColor(c.colorBlob));
    this.blobMaterial.roughness = c.blobRoughness;
    this.blobMaterial.metalness = c.blobMetalness;
  }

  /**
   * Everything a body does the instant it arrives.
   *
   * Read straight after `update()`: an arrival is *re-derived*, not remembered,
   * so a slider that puts a droplet back in the air clears its flag and it
   * arrives again — which is the correct behaviour for a paused editor and is
   * why the spatter is a burst rather than a latch.
   */
  _landings() {
    const c = settings.splatterbrand;
    const g = settings.global;
    const count = this.body.arrivalCount;
    if (count <= 0) return;
    const time = frame.uTime.value;

    for (let i = 0; i < count; i++) {
      const index = this.body.arrivals[i];
      this.body.landPoint(index, _pos);
      _pos.y = c.markHeight + 0.03;

      // The mass throws a lot; a 5 cm droplet throws almost nothing. Scaling by
      // the body's own radius against the mass's is what keeps the far field
      // from sounding as loud as the near field.
      const scale =
        index === 0 ? 1 : saturate(this.mark.satelliteSize(index - 1) / Math.max(0.02, c.satMax));
      const number = index === 0 ? c.spatterMassCount : c.spatterCount * (0.35 + 0.65 * scale);

      _emit.position = _pos;
      _emit.radius = 0.04 + 0.12 * scale;
      // Up and forward: a drop that lands moving forward throws its spatter
      // forward. Straight up made every landing read as a stamp.
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.45).setY(1).normalize();
      _emit.speed = c.spatterSpeed * (0.5 + 0.5 * scale);
      _emit.speedVariance = 0.8;
      _emit.spread = 0.85;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.4 + 0.6 * scale;
      _emit.sizeVariance = 0.7;
      _emit.life = c.spatterLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.spatter.emit(Math.round(number * g.particleCount), _emit);
    }
  }

  /**
   * The mist over the mark, thinned as it dries.
   *
   * Keyed off the wetness rather than off the phase: `dryTime` is what decides
   * how long a film stays glossy, so it is what should decide how long there is
   * anything in the air above it. Dragging `dryTime` up on a paused mark starts
   * the mist again.
   *
   * @param {number} dt
   * @param {number} scale 0..1 — thinned as the mark soaks away
   */
  _mistFx(dt, scale) {
    const c = settings.splatterbrand;
    const g = settings.global;
    const wet = Math.exp(-this._soak() / Math.max(0.05, c.dryTime));
    const count = Math.round(this.mistEmitter.tick(dt, c.mistRate * scale * wet) * g.particleCount);
    if (count <= 0) return;

    this._impactPoint(_pos);
    const reach = Math.max(0.3, this.mark.frontRadius(0));
    _pos.x += randRange(-reach, reach) * 0.7;
    _pos.z += randRange(-reach, reach) * 0.7;
    _pos.y = randRange(0.08, 0.45);

    _emit.position = _pos;
    _emit.radius = reach * 0.25;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.mistSpeed;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 1;
    _emit.sizeVariance = 0.5;
    _emit.life = c.mistLifetime;
    _emit.lifeVariance = 0.45;
    _emit.spin = 0.25;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.mist.emit(count, _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1);
    // Nothing has landed yet, but the list is consumed anyway: a very short
    // cast can put the mass across τ = 1 on the same frame the base class is
    // still calling this, and an unconsumed arrival is one that never fires.
    this._landings();

    // The light rides the blob rather than the floor under it. Asked by τ
    // rather than by draw slot: `slotPosition` indexes the *drawn* bodies and
    // is undefined when none are, which on a one-frame cast is a crash.
    // Body 0's τ is the ability's own `u` by construction — that is what
    // `_flightClock` is for.
    this.body.pointAt(0, this.u, this.position);

    this.ctx.shake.rumble(settings.splatterbrand.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.splatterbrand;
    const g = settings.global;

    // The one timestamp a cast records past the seed.
    this._landed = true;
    this._landAt = this.age;

    this._impactPoint(_pos);
    this.position.copy(_pos);
    this.position.y = 0.2;

    // No flash and no burst. A brush hitting the floor is a wet slap and a
    // kick, and the two pieces of impact vocabulary this sandbox reaches for
    // first are both emissive.
    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      22
    );

    _pos.y = c.markHeight + 0.1;
    _emit.position = _pos;
    _emit.radius = 0.3;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.mistSpeed * 2.4;
    _emit.speedVariance = 0.75;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 1.3;
    _emit.sizeVariance = 0.5;
    _emit.life = c.mistLifetime * 1.2;
    _emit.lifeVariance = 0.45;
    _emit.spin = 0.35;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.mist.emit(Math.round(c.mistCount * g.particleCount), _emit);

    this._sync(1);
    this._landings();
  }

  onFade(dt, t) {
    /*
     * `t` runs 0..1 while the far field is still arriving and the mark stands,
     * then 1..2 while it soaks away.
     *
     * `inQuad` rather than the emissive schools' `inCubic`: a light being
     * switched off hangs and then goes, and a stain does not — it thins evenly
     * as the water leaves it.
     */
    const fade = t <= 1 ? 1 : 1 - Easing.inQuad(saturate(t - 1));
    this._sync(fade);
    this._landings();

    this._impactPoint(this.position);
    this.position.y = 0.2;

    this._mistFx(dt, fade);
    this.ctx.shake.rumble(
      settings.splatterbrand.rumble * fade * 0.5 * settings.global.cameraShake,
      dt
    );
  }

  onDestroy() {
    this._landed = false;
    this._landAt = 0;
    this.mark.reset();
    this.body.reset();
  }

  dispose() {
    this.mark.dispose();
    this.body.dispose();
    this.blobMaterial.dispose();
    super.dispose();
  }
}
