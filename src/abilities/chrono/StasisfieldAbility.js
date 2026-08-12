import { SphereGeometry, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { DistortionField, DistortionMode } from '../../vfx/Distortion.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { timeField, timeRegionParams } from '../../vfx/TimeControl.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../../utils/math.js';

/**
 * Segments on the refraction hull. High enough that the silhouette is a circle
 * at five metres and the shading normal is smooth; a sphere is the one shape
 * where a coarse tessellation shows up as a *faceted refraction*, which reads
 * as a disco ball rather than as glass.
 */
const HULL_SEGMENTS = 30;
const HULL_RINGS = 20;

const TAU = Math.PI * 2;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _floor = new Vector3();
const _ground = groundFieldParams();
const _warp = timeRegionParams();
const _glass = {};

/**
 * STASIS FIELD — a sphere of stopped time dropped over the aimed circle.
 *
 * ## THE TRICK — it is not the ability that you look at
 *
 * Every other slot in this project is a thing that is drawn. This one is a
 * thing that is *done to everything else*. It claims a slot in
 * `vfx/TimeControl.js`'s four-wide `timeField`, stamps the instant it snapped
 * shut, and publishes a centre, a radius and a **clock rate of zero**. Every
 * shader that injects `shaders/lib/timewarp.glsl.js` then evaluates itself at
 * the moment the field closed rather than at now, for as long as it is inside
 * the sphere:
 *
 *     bent = mix(clock, hold + (clock - hold) * rate, weight)
 *
 * With `rate = 0` that is a stasis field; the roster entry's "Implemented by
 * clamping age inside a region rather than by drawing anything" is that line
 * and nothing else. The ability's own visible budget is **two draw calls** — a
 * refractive hull and a hex lattice on the floor — and both of them exist to
 * say *where* the boundary is, not to be the effect.
 *
 * ## What actually stops, today, and what does not
 *
 * This is the honest part, and it is worth stating rather than discovering.
 *
 * **Particles stop, completely.** `particles/ParticleSystem.js` is the one
 * consumer that already injects the chunk, and it does it properly: it probes
 * each region at the position the particle's body had *on the frame that slot
 * locked* rather than at the particle's current position, which is the only
 * formulation with a fixed point. (Probe at the current position and the freeze
 * thaws itself: the particle stops, the world clock runs on, the probe drifts,
 * and one step later it lets go.) So a Cinder Fall's embers, a Storm Lance's
 * sparks and motes, a Rimewalker's mist and this ability's own dust all hang
 * exactly where they were, mid-arc, and resume when the field lets go. Since
 * particles are most of the visible mass of most casts, this alone carries the
 * ability.
 *
 * **The bolt itself does not.** `materials/LightningMaterial.js` does not
 * inject the chunk, so a Storm Lance's filaments keep guttering inside the
 * radius while its sparks are frozen in the air around them. The same is true
 * of every other bespoke material, of `Swarm`, `Curtain` and `VolumeHull`, and
 * `src/vfx/README.md` says so in the same words. Fixing it is one line per
 * material — read `warpedTime(uTime, worldPos)` instead of `uTime`, at a probe
 * position that does not itself depend on the clock — and it is deliberately
 * **not** done here: it is a change to six shipped abilities' shading, made
 * from inside a seventh, and that is not a trade this slot gets to make on its
 * own. What it does instead is document the boundary and hold up its end.
 *
 * ## The arming lag, and why a lag and a rate are the same thing
 *
 * A region whose hold instant *is* the current instant is exact identity
 * whatever its rate — `hold + (clock - hold) × r` collapses to `clock` when
 * `hold = clock` — so simply ramping `rate` down while the field forms does
 * nothing at all. The first version did exactly that and the field snapped from
 * "no effect" to "everything stopped" in one frame, which reads as a bug.
 *
 * What does work is to lag the hold instant. Put `hold = clock - L` and the
 * interior clock becomes `clock - L(1 - rate)`: a **uniform delay**, continuous
 * in both `L` and `rate`, and continuous again at the moment the field shuts,
 * because that is the frame we stop advancing `hold` and the expression is
 * already sitting at `clock - L`. So `armLag` grows from 0 to its slider value
 * as the seed flies, the world inside the closing sphere falls further and
 * further behind, and then it stops. Air going syrupy, from one subtraction.
 *
 * ## The rule that makes the editor work
 *
 * A cast captures three numbers and every one of them is an event: `_seed`,
 * `_spawnClock` and `_holdClock`. A timestamp names a moment, not a quantity.
 * Every metre, every second and every rate is resolved from
 * `settings.stasisfield` inside the update loop on every frame, a zero-length
 * one included — which for this ability is unusually easy to see. Drop a field
 * over a standing cast, press **P**, and drag `fieldScale`: the boundary
 * between the particles that are moving and the particles that are not moves
 * under your cursor, with the clock stopped.
 *
 * ## I6
 *
 * `timeField.acquire()` returns `null` when all four slots are taken, on
 * exactly the `ctx.lights.acquire()` contract. Every use of the handle here is
 * guarded, and the degradation is deliberately *total*: with no slot the hull
 * and the lattice still draw, the lattice still spreads — and nothing stops,
 * including the ability's own dust, because the interior clock is read back out
 * of `timeField.clockAt()` rather than recomputed on the side. A stasis field
 * that cannot hold anything should look like a stasis field that cannot hold
 * anything.
 */
export class StasisfieldAbility extends Ability {
  constructor(context) {
    super('stasisfield', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the glass: the only thing standing in the air --- */
    // A hull emitter rather than a billboard. `REFRACT` on a real sphere
    // refracts along the sphere's own normal, so the skin bends what is behind
    // it hardest where you are looking along it and not at all through the
    // middle — which is what makes it read as a closed volume of glass instead
    // of a circular smudge. It writes to the offset buffer and emits no light
    // whatsoever; see the settings block for the glowing dome this is not.
    this.hullGeometry = new SphereGeometry(1, HULL_SEGMENTS, HULL_RINGS);
    this.glass = new DistortionField({
      mode: DistortionMode.REFRACT,
      geometry: this.hullGeometry,
      renderOrder: 1,
      name: 'stasisfield.glass'
    });
    this.group.add(this.glass.object3D);

    /* --- the floor mark, on the field's own arrested clock --- */
    this.lattice = new GroundField(this.group, {
      mode: GroundMode.LATTICE,
      additive: false,
      renderOrder: 4,
      name: 'stasisfield.lattice'
    });
    this.lattice.setVisible(false);

    /** The slot in the shared field. May be `null` — I6. */
    this._region = null;

    /** Re-rolled per cast so two fields do not crawl identically. A dice roll. */
    this._seed = 0;
    /** The instant the cast started, in `frame.uTime`'s clock. A timestamp. */
    this._spawnClock = 0;
    /** The instant the field snapped shut. A timestamp; `-1` before the snap. */
    this._holdClock = -1;
    /** Has the catch-up one-shot fired yet? An event, not a dimension. */
    this._released = false;

    /**
     * The cast's beats, all unitless, refilled every frame. One object, reused.
     *
     *   arm      0..1  how far the field is from closed
     *   rate     0..1  the clock rate inside it, live
     *   release  0..1  how far through the catch-up it is
     *   fade     1..0  master presence
     */
    this._b = { arm: 0, rate: 1, release: 0, fade: 0 };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The motes the field catches. Soft and additive, and given a *long*
    // lifetime on purpose: a held particle does not spend its life, so a mote
    // caught at 10% of its life is still at 10% two seconds later and comes
    // back with almost all of it left. Give them a short one and the field
    // empties itself while nothing is moving, which is a very strange sight.
    this.motes = particles.get('stasisfield.motes', {
      capacity: 1400,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 2.4;
    this.motes.uniforms.uEndSize.value = 0.5;
    this.motes.uniforms.uSizeIn.value = 0.14;
    this.motes.uniforms.uFadeIn.value = 0.16;
    this.motes.uniforms.uFadeOut.value = 0.5;

    // A thin haze off the floor. Non-additive so it genuinely occludes — the
    // one thing in this ability allowed to hide something.
    this.haze = particles.get('stasisfield.haze', {
      capacity: 900,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.haze.uniforms.uDrag.value = 2.6;
    this.haze.uniforms.uEndSize.value = 2.2;
    this.haze.uniforms.uSizeIn.value = 0.14;
    this.haze.uniforms.uFadeIn.value = 0.2;
    this.haze.uniforms.uFadeOut.value = 0.35;

    this.moteEmitter = new RateEmitter();
    this.hazeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    // Two meshes, and they are both singular. The interesting count for this
    // ability is the one it is holding, which belongs to somebody else.
    return this.glass.visible ? 2 : 1;
  }

  /** The field holds through the whole impact phase. */
  get impactDuration() {
    return Math.max(0.05, settings.stasisfield.holdTime * settings.global.lifetime);
  }

  /** The fade is the catch-up plus the settle after it. */
  get fadeDuration() {
    const c = settings.stasisfield;
    return Math.max(0.05, c.releaseTime + c.settleTime);
  }

  /**
   * Dead steady. Not an oversight.
   *
   * Every other ability in the project shimmers its light — ice glints, flame
   * breathes, lightning gutters — and every one of those is a statement that
   * time is passing. A light that flickers over a sphere in which nothing is
   * allowed to move is the single detail that would break the whole read, and
   * it would break it before anybody consciously noticed why. The base class's
   * default is a sine of `age`, so this override is the entire fix.
   */
  lightShimmer() {
    return 1;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry of the field — every metre resolved from live settings      */
  /* ------------------------------------------------------------------ */

  /** Where the sphere hangs. Rides the seed out, then sits over the circle. */
  _centrePoint(out) {
    const c = settings.stasisfield;
    const s = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    this.pointAt(s, out);
    // Off the hand at the start, at its standing height once it has landed.
    out.y = lerp(c.handHeight, c.fieldHeight, Easing.outQuad(s));
    if (this.phase === AbilityPhase.TRAVEL) {
      out.addScaledVector(this.direction, c.handForward * (1 - s));
    }
    return out;
  }

  /** The floor point under the sphere. */
  _floorPoint(out) {
    const s = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    return this.pointAt(s, out);
  }

  /** The held sphere's outer radius, metres. */
  _fieldRadius() {
    const c = settings.stasisfield;
    return Math.max(0.05, c.zoneRadius * c.fieldScale);
  }

  /**
   * Refill `this._b` from the phase clock.
   *
   * Fractions only. The beats decide *how far through* something is; the
   * settings block decides how big it is in metres and how long it is in
   * seconds, and both are re-read on the frame they change.
   *
   * @param {number} t 0..1 through the impact phase, then 1..2 through the fade
   */
  _resolveBeats(t) {
    const c = settings.stasisfield;
    const b = this._b;

    if (this.phase === AbilityPhase.TRAVEL) {
      b.arm = Math.pow(saturate(this.u), Math.max(0.05, c.armCurve));
      b.rate = lerp(1, saturate(c.holdRate), b.arm);
      b.release = 0;
      b.fade = b.arm;
      return;
    }

    if (t <= 1) {
      b.arm = 1;
      b.rate = saturate(c.holdRate);
      b.release = 0;
      b.fade = 1;
      return;
    }

    // The catch-up. `releaseFrac` is where in the fade phase the interior has
    // finished re-joining the world; everything after it is the hull fading out
    // over a scene that is already running normally again.
    const releaseFrac = saturate(c.releaseTime / Math.max(c.releaseTime + c.settleTime, 1e-3));
    const s = saturate(t - 1);
    b.arm = 1;
    b.release = saturate(s / Math.max(releaseFrac, 1e-3));
    // Rate, not strength. Ramping the *weight* back to zero instead would also
    // let the interior go, but it would do it from the rim inward and the
    // middle of the sphere would be the last thing to move — which is backwards
    // from how anything lets go of anything.
    b.rate = lerp(saturate(c.holdRate), 1, Easing.inOutCubic(b.release));
    b.fade = 1 - Easing.inCubic(saturate((s - releaseFrac) / Math.max(1 - releaseFrac, 1e-3)));
  }

  /**
   * The clock the inside of the sphere is living on, as an age since the cast.
   *
   * Read back out of `timeField.clockAt()` — the module's own CPU mirror of
   * `warpedTime()`, arithmetic for arithmetic — rather than recomputed here
   * from the same numbers. Two implementations of one formula is two
   * implementations that can disagree, and the way you find out that they have
   * is that the floor mark stops half a frame before the dust does.
   *
   * Must be called *after* `region.sync()`, because the mirror reads the same
   * uniform boxes the shaders will.
   *
   * @param {import('three').Vector3} centre the sphere's centre this frame
   */
  _interiorAge(centre) {
    return timeField.clockAt(frame.uTime.value, centre) - this._spawnClock;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this.hazeEmitter.reset();

    this._seed = Math.random() * 100;
    this._spawnClock = frame.uTime.value;
    this._holdClock = -1;
    this._released = false;

    // I6 — may be null, and every use below is guarded. `borrow()` is what
    // gives it back on the three ways a cast can end that are not this
    // ability's idea; a leaked region stops a sphere of the world for the rest
    // of the session and nobody would trace it back here.
    this._region = this.borrow(timeField.acquire());

    this.glass.visible = true;
    this.lattice.setVisible(true);

    this._resolveBeats(0);
    this._sync();
    this._castFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current beats into the region and the two
   * things that draw.
   *
   * Order is load-bearing exactly once: the region is synced **first**, because
   * `_interiorAge()` reads the field back through its CPU mirror and a mirror
   * of last frame's uniforms is a floor mark one frame out of step with the
   * dust standing on it.
   */
  _sync() {
    this._centrePoint(_centre);
    this._syncRegion(_centre);

    this._syncGlass(_centre);
    this._syncLattice(this._interiorAge(_centre));
    this._syncParticles();

    // The light lives at the centre of the sphere rather than on the floor line
    // the base class walks out along.
    this.position.copy(_centre);
  }

  /** The region. Zero draw calls, and the entire ability. */
  _syncRegion(centre) {
    const c = settings.stasisfield;
    const b = this._b;
    const region = this._region;
    if (!region) return;

    // Until the field shuts, the hold instant chases the world clock at a fixed
    // lag — see the class doc. `armLag` is scaled by the same curve the grip
    // is, so the delay and the strength arrive together.
    if (this._holdClock < 0) {
      region.lock(frame.uTime.value - Math.max(0, c.armLag) * b.arm);
    }

    region.place(centre);
    _warp.radius = this._fieldRadius();
    _warp.core = saturate(c.fieldCore);
    _warp.strength = saturate(c.fieldStrength) * b.arm;
    _warp.rate = b.rate;
    region.sync(_warp);
  }

  /**
   * The hull.
   *
   * Hull-mode emitters are placed by their own matrix rather than by
   * `setAnchor`, which is the one place this module behaves like ordinary
   * geometry — so the radius arrives as a *scale*, re-resolved here every
   * frame, and dragging `fieldScale` while paused visibly re-sizes the glass
   * and the held volume together because both read the same expression.
   */
  _syncGlass(centre) {
    const c = settings.stasisfield;
    const b = this._b;
    const radius = this._fieldRadius() * Math.max(0.01, c.glassScale);

    const mesh = this.glass.object3D;
    mesh.position.copy(centre);
    mesh.position.y += c.glassLift;
    mesh.scale.set(radius, radius * Math.max(0.05, c.glassSquash), radius);
    // The anchor is still used by the shared perspective falloff, so it is kept
    // in step with the matrix rather than left at the origin.
    this.glass.setAnchor(mesh.position);

    _glass.strength = c.glassStrength * b.fade;
    _glass.power = c.glassPower;
    _glass.ripple = c.glassRipple;
    _glass.rippleScale = c.glassRippleScale * settings.global.noiseFrequency;
    _glass.rippleSpeed = c.glassRippleSpeed * settings.global.noiseSpeed;
    _glass.opacity = c.glassOpacity * b.fade;
    _glass.depthReject = c.glassDepthReject;
    _glass.depthFade = c.glassDepthFade;
    _glass.perspective = c.glassPerspective;
    _glass.perspectiveRef = c.glassPerspectiveRef;
    _glass.seed = this._seed;
    this.glass.update(_glass);
  }

  /**
   * The lattice, driven by the interior clock rather than by `this.age`.
   *
   * This is the only thing the ability draws that *obeys* the ability. The
   * front spreads at `latticeTime` seconds to the rim, the field shuts, and the
   * front stops wherever it had got to — for as long as the field holds, and
   * then finishes in a rush during the catch-up. Every other floor mark in the
   * project would keep spreading, because every other floor mark is on the
   * ability's own monotone clock.
   *
   * @param {number} interior seconds of the field's own clock since the cast
   */
  _syncLattice(interior) {
    const c = settings.stasisfield;
    const g = settings.global;
    const b = this._b;

    _ground.centre = this._floorPoint(_floor);
    _ground.yaw = 0;
    _ground.height = c.latticeHeight;
    _ground.radius = this._fieldRadius() * Math.max(0.05, c.latticeScale);
    _ground.length = _ground.radius * 2;

    _ground.grow = saturate(interior / Math.max(0.02, c.latticeTime));
    _ground.recede = 0;
    _ground.progress = 1;
    _ground.inscribe = 1;
    _ground.ignite = 0;
    _ground.fade = b.fade;
    _ground.seed = this._seed;

    _ground.edge = c.latticeEdge;
    _ground.ragged = c.latticeRagged;
    _ground.raggedScale = c.latticeRaggedScale;
    _ground.warp = c.latticeWarp;

    _ground.relief = c.latticeRelief;
    _ground.normalStep = c.latticeNormalStep;
    _ground.ambient = c.latticeAmbient;
    _ground.wrap = c.latticeWrap;
    _ground.specular = c.latticeSpecular;
    _ground.gloss = c.latticeGloss;
    _ground.parallax = c.latticeParallax;

    _ground.cell = c.latticeCell;
    _ground.seam = c.latticeSeam;
    _ground.thickness = c.latticeThickness;
    _ground.lift = c.latticeLift;
    _ground.depth = c.latticeDepth;
    _ground.sharp = c.latticeSharp;
    _ground.detail = c.latticeDetail;
    // The cell shader's own animation rate, held to the same rate the field is
    // holding everything else to: a lattice whose interior keeps crawling while
    // the front is frozen is two clocks in one object.
    _ground.speed = c.latticeSpeed * b.rate;

    _ground.additive = false;
    _ground.emissive = c.latticeEmissive;
    _ground.opacity = c.latticeOpacity;
    _ground.depthFade = c.latticeDepthFade;
    _ground.colorBase = c.colorLatticeBase;
    _ground.colorEdge = c.colorLatticeEdge;
    _ground.colorGlow = c.colorLatticeGlow;
    _ground.colorDeep = c.colorLatticeDeep;

    _ground.noiseStrength = g.noiseStrength;
    _ground.noiseFrequency = g.noiseFrequency;
    _ground.noiseSpeed = g.noiseSpeed;
    _ground.opacityScale = g.opacity;

    this.lattice.update(_ground);
  }

  /** Both particle systems, re-coloured and re-scaled every frame. */
  _syncParticles() {
    const c = settings.stasisfield;
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
    this.motes.uniforms.uOpacity.value = c.moteOpacity * g.opacity;
    this.motes.uniforms.uGlow.value = c.moteGlow * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

    this.haze.setGradient(
      getColor(c.colorDustA),
      getColor(c.colorDustB),
      getColor(c.colorDustC),
      getColor(c.colorDustD)
    );
    this.haze.uniforms.uGravity.value.set(0, c.dustRise, 0);
    this.haze.uniforms.uSizeScale.value = c.dustSize * g.particleSize;
    this.haze.uniforms.uLifeScale.value = c.dustLifetime * 0.5 * g.particleLifetime;
    this.haze.uniforms.uSpeedScale.value = c.dustSpeed * g.particleSpeed;
    this.haze.uniforms.uOpacity.value = c.dustOpacity * g.opacity;
    this.haze.uniforms.uTurbulence.value = 0.3 * g.turbulence;
  }

  /** The seed leaving the caster's hand. Almost nothing, on purpose. */
  _castFx() {
    const c = settings.stasisfield;
    const g = settings.global;
    this._centrePoint(_pos);
    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.25 * g.explosionIntensity;
  }

  /**
   * The trickle of dust into the field, and the haze under it.
   *
   * Motes are seeded **in a shell at the rim**, between `1 - rimBand` and the
   * radius, because the rim is the only part of a stasis field where anything
   * is still allowed to move: `weight` there is partway between 0 and 1, so the
   * interior clock runs at a fraction of the real one and those motes *crawl*.
   * A band of crawling dust wrapped around a sphere of dust that is not moving
   * at all is the time-dilation gradient made visible, and it costs one
   * `randRange`.
   *
   * The first version emitted uniformly through the volume. It fills the sphere
   * with specks that are all equally motionless, which does not read as stopped
   * time — it reads as a particle system that has hung.
   *
   * @param {number} scale 0..1, thinned once the field is only holding
   */
  _fieldFx(dt, scale) {
    const c = settings.stasisfield;
    const g = settings.global;
    const time = frame.uTime.value;
    const radius = this._fieldRadius();

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      const bearing = Math.random() * TAU;
      const pitch = Math.acos(randRange(-1, 1));
      const r = radius * randRange(1 - saturate(c.rimBand), 1);
      this._centrePoint(_pos);
      _pos.x += Math.sin(pitch) * Math.cos(bearing) * r;
      _pos.y += Math.cos(pitch) * r;
      _pos.z += Math.sin(pitch) * Math.sin(bearing) * r;
      // Never below the floor: a mote frozen under the stone is a mote nobody
      // will ever see thaw.
      _pos.y = Math.max(0.05, _pos.y);

      _emit.position = _pos;
      _emit.radius = radius * saturate(c.rimBand) * 0.35;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.9;
      _emit.spread = 1;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.65;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    const hazeCount = Math.round(this.hazeEmitter.tick(dt, c.dustRate * scale) * g.particleCount);
    if (hazeCount > 0) {
      const bearing = Math.random() * TAU;
      const r = radius * Math.sqrt(Math.random());
      this._floorPoint(_pos);
      _pos.x += Math.cos(bearing) * r;
      _pos.z += Math.sin(bearing) * r;
      _pos.y = 0.12;

      _emit.position = _pos;
      _emit.radius = radius * 0.15;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.8;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.25;
      _emit.tint = null;
      _emit.time = time;
      this.haze.emit(hazeCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._resolveBeats(0);
    this._sync();
    // Emission ramps in with the grip: the seed is not yet a field and should
    // not yet be shedding like one.
    this._fieldFx(dt, this._b.arm);
    this.ctx.shake.rumble(settings.stasisfield.rumble * settings.global.cameraShake, dt);
  }

  /** SNAP — the field shuts. The only frame in the cast that punches. */
  onImpact() {
    const c = settings.stasisfield;
    const g = settings.global;
    const time = frame.uTime.value;

    // Stop chasing the world clock. Everything inside is now held at this
    // instant, less whatever lag the arming had already built up — which is why
    // this is a timestamp read back off the region rather than a fresh one:
    // re-stamping here would jerk the interior forward by `armLag` on exactly
    // the frame the eye is watching hardest.
    this._holdClock = this._region ? this._region.hold : frame.uTime.value;

    this._resolveBeats(0);
    this._centrePoint(_pos);

    // A pressure shell rather than a fireball: the field arrives by taking
    // something away, and AIR is the burst mode with the least body in it.
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.snapBurstSize * 0.25,
      endRadius: c.snapBurstSize * g.explosionIntensity,
      life: 0.45,
      intensity: c.snapBurstIntensity,
      opacity: 0.7,
      fresnel: 2.6,
      displace: 0.25,
      squash: 0.9,
      colorA: getColor(c.colorSnapA),
      colorB: getColor(c.colorSnapB),
      colorC: getColor(c.colorSnapC)
    });

    // One ring on the floor, at the boundary, so the footprint is stated once
    // and then never mentioned again.
    this._floorPoint(_floor);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _floor, {
      radius: c.snapRingRadius * g.explosionIntensity,
      life: 0.5,
      width: 0.04,
      intensity: c.snapRingIntensity,
      colorA: getColor(c.colorRingA),
      colorB: getColor(c.colorRingB)
    });

    // A last inward gasp of dust — thrown *at* the centre, so what the field
    // catches is matter that was on its way somewhere.
    const radius = this._fieldRadius();
    this._centrePoint(_centre);
    _emit.position = _centre;
    _emit.radius = radius * 0.9;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed * 2.5;
    _emit.speedVariance = 0.8;
    _emit.spread = 1;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.7;
    _emit.life = c.moteLifetime;
    _emit.lifeVariance = 0.45;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.motes.emit(Math.round(c.snapMotes * g.particleCount), _emit);

    _emit.position = this._floorPoint(_floor);
    _emit.radius = radius * 0.7;
    _emit.speed = c.dustSpeed * 1.6;
    _emit.spread = 0.95;
    _emit.size = 1.1;
    _emit.life = c.dustLifetime;
    _emit.spin = 0.3;
    this.haze.emit(Math.round(c.snapDust * g.particleCount), _emit);

    this.ctx.shake.add(
      c.snapShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this.ctx.flash.trigger(getColor(c.colorSnapFlash), c.snapFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.9 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.stasisfield;
    const g = settings.global;

    // The catch-up one-shot, on the first frame of the fade phase — which is
    // the frame the interior clock starts moving again.
    if (t > 1 && !this._released) {
      this._released = true;
      this._releaseFx();
    }

    this._resolveBeats(t);
    this._sync();

    // While the field is shut it keeps drawing dust in — the rim is the only
    // place that emission is visible, and it is exactly where it is emitted.
    // Once it lets go there is nothing left to catch.
    this._fieldFx(dt, t <= 1 ? 1 : 1 - this._b.release);

    if (t <= 1) {
      this.ctx.shake.rumble(c.rumble * 0.5 * g.cameraShake, dt);
    }
  }

  /** RELEASE — the field lets go and two and a half seconds arrive at once. */
  _releaseFx() {
    const c = settings.stasisfield;
    const g = settings.global;

    this._centrePoint(_pos);
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.releaseBurstSize * 0.3,
      endRadius: c.releaseBurstSize * g.explosionIntensity,
      life: 0.6,
      intensity: c.releaseBurstIntensity,
      opacity: 0.6,
      fresnel: 2.2,
      displace: 0.35,
      colorA: getColor(c.colorReleaseA),
      colorB: getColor(c.colorReleaseB),
      colorC: getColor(c.colorReleaseC)
    });

    this.ctx.shake.add(
      c.releaseShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      14
    );
    this.ctx.flash.trigger(getColor(c.colorReleaseFlash), c.releaseFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  onDestroy() {
    // Give the slot back on the frame the cast ends. `Ability#destroy()` would
    // do it anyway through `borrow()`, and `release()` is idempotent, so doing
    // it here as well costs nothing and means the *ordinary* path never leans
    // on the safety net.
    this._region = this._region?.release() ?? null;
    this._holdClock = -1;
    this._released = false;
    // Releases the distortion pass's writer counter. Hiding the group instead
    // leaks it for the session and the pass then runs every frame with nothing
    // in it.
    this.glass.visible = false;
    this.lattice.setVisible(false);
    this._b.arm = 0;
    this._b.fade = 0;
    this._b.rate = 1;
    this._b.release = 0;
  }

  dispose() {
    this.glass.dispose();
    this.hullGeometry.dispose();
    this.lattice.dispose();
    super.dispose();
  }
}
