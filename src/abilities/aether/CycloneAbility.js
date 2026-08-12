import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { Tube, TubePath } from '../../vfx/Tube.js';
import { FilamentPaths, filamentLook } from '../../vfx/FilamentPaths.js';
import { Swarm, Silhouette, LeadPath, swarmParams } from '../../vfx/Swarm.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../../utils/math.js';

/** Hard ceilings per ribbon role. The editor's sliders clamp here. */
const MAX_WALL = 18;
const MAX_INTAKE = 12;
/** Samples along one ribbon. Above this a kink is finer than two nodes and only aliases. */
const RIBBON_NODES = 64;
/** Agents the flock's buffer is built with. `swarmCount` clamps here. */
const SWARM_CAPACITY = 192;

/**
 * How many bearings one frame's dust is split between.
 *
 * A vortex sheds off its whole circumference, and emitting a frame's worth from
 * a single bearing reads as a puff being thrown out sideways — the same mistake
 * the bolt makes if all its sparks leave from one point on the filament.
 */
const RING_BATCHES = 4;

const TAU = Math.PI * 2;

/* Module-scope scratch — I3. Nothing below allocates on a frame. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
/** Filled from settings every frame; the modules read canonical names off these. */
const _look = filamentLook();
const _flock = swarmParams();
const _ground = groundFieldParams();

/**
 * CYCLONE — a vortex touching down on the aimed circle.
 *
 * Four beats over three phases:
 *
 *   1. **travel** — a whorl of dust starts turning over on the target circle
 *      while the cast is still going out. The funnel does not exist yet; the
 *      scour is inking itself and the ground ribbons are already crawling in.
 *   2. **touchdown** — the first `spinUp` seconds of the impact phase: the
 *      column stands up out of the whorl, from a thread to its full profile.
 *   3. **hold** — the rest of `lifetime`: it grinds, precesses, throws debris
 *      up the wall and drags grit in across the floor.
 *   4. **rope-out** — `fadeTime`: the foot *lifts*, climbing to `ropeLift` of
 *      the height while the column thins to a thread, so the thing dies from
 *      the bottom upward and the mouth is the last of it to go. Every dying
 *      tornado does this and no fade-to-zero has ever looked like it.
 *
 * **THE TRICK — the funnel profile is one function.** `vfx/Tube.js` in `FUNNEL`
 * mode publishes `radiusAt(tau)`, the real vortex profile: a tight throat, a
 * skirt flaring to the floor, a mouth flaring to the top. Nothing in this file
 * writes down a radius. The wall ribbons spiral between `radiusAt(0)` and
 * `radiusAt(ribbonTop)`; the flock orbits `radiusAt(swarmRide) × swarmHug`; the
 * dust is emitted on a ring of `radiusAt(0)`; the debris leaves the wall at
 * `radiusAt(u)` for whatever height it was picked up at; the ground scour is
 * `radiusAt(0) × scourReach`. Drag `funnelSkirtFlare` with the clock stopped
 * and all five move together, because there is only one of them.
 *
 * The first version had the scour on its own `scourRadius` slider and the dust
 * ring on a third. They were never the same number twice — every profile tweak
 * left the grooves either buried under the skirt or ringing clean floor a metre
 * outside it, and the ability read as three effects standing in the same place.
 * That is the snare's `zoneRadius` lesson applied to a *curve*: the shared value
 * is not a scalar here, it is a function of height, and it is still shared.
 *
 * The one measurement that is deliberately **not** the profile is `zoneRadius`.
 * That is the aim circle, and what the circle promises is the floor the vortex
 * is drawing air off — so it drives the intake ribbons crawling in and the
 * radius the grit is picked up from, both of which are wider than the foot. A
 * tornado seen from above is a small dark disc inside a much larger disturbed
 * one, and those are the two numbers.
 *
 * A cast captures exactly two things: `_seed`, a unitless dice roll so no two
 * touchdowns draw the same spiral, and `_yawRoll`, a 0..1 fraction that turns
 * the scour so the grooves do not always face the same way. Everything with a
 * unit is resolved from `settings.cyclone` inside the update loop, on a
 * zero-length frame included.
 */
export class CycloneAbility extends Ability {
  constructor(context) {
    super('cyclone', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the column: 3 draw calls, and the profile everything reads --- */
    this.funnel = new Tube({
      path: TubePath.FUNNEL,
      prefix: 'funnel',
      // A vortex is smooth along its length and detailed around it: the sway
      // and the mouth flare are low-frequency, but the barrel needs facets or
      // the silhouette polygonises the moment the camera comes close.
      nodes: 72,
      sides: 34,
      renderOrder: 10
    });
    this.group.add(this.funnel.group);

    /* --- the ribbons: 2 draw calls for both roles --- */
    this.paths = new FilamentPaths(this.group, {
      samples: RIBBON_NODES,
      capacity: MAX_WALL + MAX_INTAKE,
      renderOrder: 12
    });

    /* --- the flock: 1 draw call --- */
    this.swarm = new Swarm(this.group, {
      capacity: SWARM_CAPACITY,
      // Leaves, not birds: torn debris tumbles and curls, it does not flap with
      // intent. The silhouette is what stops the flock reading as wildlife.
      silhouette: Silhouette.LEAF,
      additive: false,
      renderOrder: 13
    });

    /* --- the floor: 1 draw call --- */
    this.scour = new GroundField(this.group, {
      mode: GroundMode.SCOUR,
      additive: false,
      depthTest: true,
      name: 'CycloneScour'
    });

    /** Unitless dice rolls, re-rolled per cast. The only things a cast keeps. */
    this._seed = 0;
    this._yawRoll = 0;

    /**
     * Scratch state handed to the tube each frame. One object, reused — syncing
     * the column allocates nothing.
     */
    this._state = {
      origin: new Vector3(),
      target: new Vector3(),
      side: new Vector3(),
      progress: 1,
      fade: 1,
      widthFade: 1,
      seed: 0,
      time: 0
    };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The skirt. Non-additive so the vortex genuinely occludes the floor behind
    // it — an additive dust cloud is a light source, and dust is not one.
    // `swirl` is the reason this system exists rather than reusing shared.smoke:
    // the particle shader orbits each grain about the anchor it was given, so
    // the skirt turns with the funnel instead of drifting off it.
    this.dust = particles.get('cyclone.dust', {
      capacity: 2400,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      swirl: true,
      softFade: 1.1
    });
    this.dust.uniforms.uDrag.value = 0.7;
    this.dust.uniforms.uEndSize.value = 2.6;
    this.dust.uniforms.uSizeIn.value = 0.14;
    this.dust.uniforms.uFadeIn.value = 0.18;
    this.dust.uniforms.uFadeOut.value = 0.42;

    // Chips carried up the wall. Lit rather than emissive — they are rock.
    this.debris = particles.get('cyclone.debris', {
      capacity: 1200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      swirl: true,
      softFade: 0.3
    });
    this.debris.uniforms.uDrag.value = 0.35;
    this.debris.uniforms.uEndSize.value = 0.9;
    this.debris.uniforms.uFadeOut.value = 0.7;

    // Grit streaming in across the floor. Velocity-stretched, so the intake
    // reads as a direction rather than as a scatter.
    this.grit = particles.get('cyclone.grit', {
      capacity: 2000,
      shape: ParticleShape.STREAK,
      additive: false,
      stretch: true,
      softFade: 0.25
    });
    this.grit.uniforms.uDrag.value = 1.1;
    this.grit.uniforms.uEndSize.value = 0.4;
    this.grit.uniforms.uSizeIn.value = 0.04;
    this.grit.uniforms.uFadeIn.value = 0.05;
    this.grit.uniforms.uFadeOut.value = 0.45;

    this.dustEmitter = new RateEmitter();
    this.debrisEmitter = new RateEmitter();
    this.gritEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.paths.liveCount + this.swarm.count;
  }

  /** The funnel stands for `lifetime`, then ropes out over `fadeTime`. */
  get impactDuration() {
    return Math.max(0.05, settings.cyclone.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.cyclone.fadeTime);
  }

  /**
   * Dust breathes; it does not gutter.
   *
   * A raised cosine rather than the base class's beat of two sines, because a
   * vortex is one slow pressure cycle and the interference pattern reads as a
   * flicker at this intensity.
   */
  lightShimmer() {
    const c = settings.cyclone;
    return 1 - c.lightShimmer * 0.5 * (1 - Math.cos(this.age * c.lightShimmerSpeed * TAU));
  }

  /* ------------------------------------------------------------------ */
  /* The beats — pure functions of the clock against live settings        */
  /* ------------------------------------------------------------------ */

  /** Where the vortex stands: the far end of the aimed line, on the floor. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** 0 while the cast travels, 1 once the column is fully up. */
  _standAmount() {
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    if (this.phase === AbilityPhase.FADE) return 1;
    return Easing.outCubic(saturate(this.impactTime / Math.max(0.01, settings.cyclone.spinUp)));
  }

  /** 0 while it stands, 1 when it has roped out entirely. */
  _ropeAmount() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    return saturate(this.fadeTime / this.fadeDuration);
  }

  /**
   * Metres the foot floats at.
   *
   * This is the whole of the dissipation. The column keeps its mouth where it
   * was and lifts its *base*, so the profile's skirt travels up the shaft and
   * the thing unhooks from the floor from the bottom. The first version faded
   * `fade` to zero instead and the tornado simply went transparent, which reads
   * as a bug rather than as weather.
   */
  _baseHeight() {
    const c = settings.cyclone;
    return lerp(c.baseHeight, c.height * c.ropeLift, Easing.inQuad(this._ropeAmount()));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.dustEmitter.reset();
    this.debrisEmitter.reset();
    this.gritEmitter.reset();

    // The two things a cast captures, both unitless.
    this._seed = Math.random() * 100;
    this._yawRoll = Math.random();

    this.swarm.roll(this._seed);
    this.scour.setVisible(true);
    this._sync(1);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Re-resolve every metre from `settings.cyclone` and push it into the four
   * modules and the three particle systems.
   *
   * Order matters exactly once: the tube is synced **first**, because every
   * `radiusAt()` and `pointAt()` below reads the dimensions that sync resolved.
   * Query it before syncing it and you get last frame's vortex, which is only
   * visible when a slider moves — the worst kind of stale.
   *
   * @param {number} fade 1 while the funnel stands, ramping to 0 as it ropes out
   */
  _sync(fade) {
    const c = settings.cyclone;
    const g = settings.global;
    const stand = this._standAmount();
    const rope = this._ropeAmount();
    const base = this._baseHeight();

    this._centrePoint(_centre);

    /* --- 1 · the column ------------------------------------------------ */
    const state = this._state;
    state.origin.set(_centre.x, base, _centre.z);
    // The mouth stays where it was put; only the foot climbs.
    state.target.set(_centre.x, Math.max(base + 0.25, c.height), _centre.z);
    state.side.copy(this.side);
    state.progress = 1;
    state.fade = fade * stand;
    // Two collapses on one number: the touchdown thread on the way up and the
    // rope on the way out. Both are widths, so both belong here rather than in
    // the profile — dragging the profile while it is roping out still works.
    state.widthFade = lerp(c.touchTaper, 1, stand) * lerp(1, c.ropeTaper, Easing.inQuad(rope));
    state.seed = this._seed;
    state.time = this.age;
    this.funnel.sync(c, state, g);
    this.funnel.visible = state.fade > 0.002;

    /* --- 2 · the ribbons, placed against the profile ------------------- */
    // Everything from here down asks the tube where it is. No radius below is
    // computed from a settings key.
    const wallTop = Math.max(0.05, c.ribbonTop);
    const footRadius = this.funnel.radiusAt(0);
    const wall = this.paths.role(0);
    this.funnel.pointAt(0, _a);
    this.funnel.pointAt(wallTop, _b);
    wall.spiralIn(
      _a,
      _b,
      footRadius * c.ribbonHug,
      this.funnel.radiusAt(wallTop) * c.ribbonHug,
      c.ribbonTurns,
      c.ribbonSpin,
      c.ribbonCurve,
      c.ribbonPhase,
      c.ribbonWobble
    );
    wall.style(1, 1, c.ribbonDim, 1).ends(1, 1, 1, 1).draw(2, 0.12, -1e4, 0);
    wall.count = Math.round(clampCount(c.wallRibbons, MAX_WALL) * stand);

    // The intake crawls in from the aim circle to the foot, and it is the one
    // role that touches the floor, so it gets the ground damping and a clamp.
    const intake = this.paths.role(1);
    const floor = base + c.intakeFloor;
    _a.set(_centre.x, floor + Math.max(0.05, c.intakeLift), _centre.z);
    _b.set(_centre.x, floor, _centre.z);
    intake.spiralIn(
      _a,
      _b,
      Math.max(footRadius, c.zoneRadius),
      footRadius,
      c.intakeTurns,
      c.intakeSpin,
      c.intakeCurve,
      c.intakePhase,
      c.intakeWobble
    );
    intake.style(1, 1, c.intakeDim, c.intakeDamp).ends(1, 1, 1, 1).draw(2, 0.2, floor, 0);
    // The intake belongs to the *ground*: it is drawn while the whorl is still
    // gathering and retired as the foot leaves the floor, which is the read
    // that says the vortex has let go.
    intake.count = Math.round(clampCount(c.intakeArms, MAX_INTAKE) * (1 - Easing.outQuad(rope)));

    _look.width = c.ribbonWidth;
    _look.glowWidth = c.ribbonGlowWidth;
    _look.glowOpacity = c.ribbonGlowOpacity;
    _look.jitter = c.ribbonJitter;
    _look.jitterScale = c.ribbonJitterScale;
    _look.octaves = c.ribbonOctaves;
    _look.jitterFalloff = c.ribbonJitterFalloff;
    _look.crawl = c.ribbonCrawl;
    _look.pinch = c.ribbonPinch;
    _look.restrike = c.ribbonRestrike;
    _look.flicker = c.ribbonFlicker;
    _look.flickerSpeed = c.ribbonFlickerSpeed;
    _look.strandFlash = c.ribbonStrandFlash;
    _look.coreSharp = c.ribbonCoreSharp;
    _look.glowFalloff = c.ribbonGlowFalloff;
    _look.softFade = c.ribbonSoftFade;
    _look.opacity = c.ribbonOpacity;
    _look.glow = c.ribbonGlow;
    _look.colorCore = c.colorRibbonCore;
    _look.colorInner = c.colorRibbonInner;
    _look.colorOuter = c.colorRibbonOuter;
    _look.colorHalo = c.colorRibbonHalo;
    _look.randomness = g.randomness;
    _look.noiseStrength = g.noiseStrength;
    _look.noiseFrequency = g.noiseFrequency;
    _look.noiseSpeed = g.noiseSpeed;
    _look.opacityScale = g.opacity;
    _look.glowScale = g.glow;
    this.paths.sync(_look, fade, this._seed);

    /* --- 3 · the flock, also placed against the profile ---------------- */
    const ride = saturate(c.swarmRide);
    _flock.count = c.swarmCount;
    _flock.leadMode = LeadPath.ORBIT;
    // A parameter, not a position: `leadS` is the cast's own clock times a live
    // rate, so dragging `swarmRate` while paused moves the flock round.
    _flock.leadS = this.age * c.swarmRate;
    _flock.leadRate = c.swarmRate;
    _flock.orbitTurns = c.swarmTurns;
    _flock.orbitRadius = this.funnel.radiusAt(ride) * c.swarmHug;
    _flock.orbitHeight = this.funnel.pointAt(ride, _a).y;
    _flock.endHeight = 0;
    _flock.latticeX = c.swarmLatticeX;
    _flock.latticeY = c.swarmLatticeY;
    _flock.latticeZ = c.swarmLatticeZ;
    _flock.spacingSide = c.swarmSpacingSide;
    _flock.spacingUp = c.swarmSpacingUp;
    _flock.lag = c.swarmLag;
    _flock.jitter = c.swarmJitter;
    _flock.churn = c.swarmChurn;
    _flock.breathe = c.swarmBreathe;
    _flock.breatheRate = c.swarmBreatheRate;
    _flock.wander = c.swarmWander;
    _flock.wanderScale = c.swarmWanderScale;
    _flock.wanderSpeed = c.swarmWanderSpeed;
    _flock.gather = c.swarmGather;
    _flock.size = c.swarmSize;
    _flock.aspect = c.swarmAspect;
    _flock.sizeJitter = c.swarmSizeJitter;
    _flock.billboard = c.swarmBillboard;
    _flock.bank = c.swarmBank;
    _flock.bankMax = c.swarmBankMax;
    _flock.dihedral = c.swarmDihedral;
    _flock.flapRate = c.swarmFlapRate;
    _flock.curl = c.swarmCurl;
    _flock.edgeStretch = c.swarmEdgeStretch;
    _flock.edgeGain = c.swarmEdgeGain;
    // Debris is picked up as the column stands and dropped as it lets go.
    _flock.reveal = stand * (1 - Easing.inQuad(rope));
    _flock.revealSpread = c.swarmRevealSpread;
    _flock.silhouette = Silhouette.LEAF;
    _flock.lit = c.swarmLit;
    _flock.tint = c.swarmTint;
    _flock.tintJitter = c.swarmTintJitter;
    _flock.tintAlong = c.swarmTintAlong;
    _flock.opacity = c.swarmOpacity * g.opacity * fade;
    _flock.glow = c.swarmGlow * g.glow;
    _flock.softFade = c.swarmSoftFade;
    this.swarm.setBasis(this.origin, this.direction, this.side, this.length);
    this.swarm.setColors(c.colorSwarmA, c.colorSwarmB, c.colorSwarmC, c.colorSwarmD);
    this.swarm.update(this.age, _flock);

    /* --- 4 · the floor, the last consumer of the same radius ----------- */
    _ground.centre = _centre;
    _ground.yaw = this._yawRoll * TAU;
    _ground.radius = footRadius * c.scourReach;
    _ground.height = c.scourHeight;
    // The grooves are cut as the whorl arrives and weather out from the outside
    // in once the vortex has gone: `grow` is the front, `recede` eats it back.
    _ground.grow = this.phase === AbilityPhase.TRAVEL ? Easing.outQuad(this.u) : 1;
    _ground.recede = Easing.inQuad(rope) * 0.85;
    _ground.fade = 1;
    _ground.seed = this._seed;
    _ground.edge = c.scourEdge;
    _ground.ragged = c.scourRagged;
    _ground.raggedScale = c.scourRaggedScale;
    _ground.warp = c.scourWarp;
    _ground.relief = c.scourRelief;
    _ground.normalStep = c.scourNormalStep;
    _ground.ambient = c.scourAmbient;
    _ground.wrap = c.scourWrap;
    _ground.specular = c.scourSpecular;
    _ground.gloss = c.scourGloss;
    _ground.parallax = c.scourParallax;
    _ground.depth = c.scourDepth;
    _ground.lift = c.scourLift;
    _ground.sharp = c.scourSharp;
    _ground.detail = c.scourDetail;
    _ground.swirl = c.scourSwirl;
    _ground.arms = c.scourArms;
    _ground.speed = c.scourSpin;
    _ground.additive = c.scourAdditive;
    _ground.emissive = c.scourEmissive;
    _ground.opacity = c.scourOpacity;
    _ground.depthFade = c.scourDepthFade;
    _ground.colorBase = c.colorScourBase;
    _ground.colorEdge = c.colorScourEdge;
    _ground.colorGlow = c.colorScourGlow;
    _ground.colorDeep = c.colorScourDeep;
    _ground.noiseStrength = g.noiseStrength;
    _ground.noiseFrequency = g.noiseFrequency;
    _ground.noiseSpeed = g.noiseSpeed;
    _ground.opacityScale = g.opacity;
    this.scour.update(_ground);

    /* --- 5 · the particle systems -------------------------------------- */
    const whorling = this.phase === AbilityPhase.TRAVEL;

    this.dust.setGradient(
      getColor(c.colorDustA),
      getColor(c.colorDustB),
      getColor(c.colorDustC),
      getColor(c.colorDustD)
    );
    this.dust.uniforms.uGravity.value.set(0, whorling ? c.whorlRise : c.dustRise, 0);
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize;
    this.dust.uniforms.uLifeScale.value = c.dustLifetime * 0.5 * g.particleLifetime;
    this.dust.uniforms.uSpeedScale.value = g.particleSpeed;
    this.dust.uniforms.uOpacity.value = c.dustOpacity * g.opacity;
    this.dust.uniforms.uTurbulence.value = c.dustTurbulence * g.turbulence;
    // The whorl is wound tighter and faster than the standing skirt — it is the
    // air being spun up, and it has not been thrown outward yet.
    this.dust.uniforms.uSwirl.value = whorling ? c.whorlSwirl : c.dustSwirl;
    this.dust.uniforms.uSwirlExpand.value = c.dustSwirlExpand;

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
    this.debris.uniforms.uSwirl.value = c.debrisSwirl;
    this.debris.uniforms.uSwirlExpand.value = c.debrisSwirlExpand;

    this.grit.setGradient(
      getColor(c.colorGritA),
      getColor(c.colorGritB),
      getColor(c.colorGritC),
      getColor(c.colorGritD)
    );
    this.grit.uniforms.uGravity.value.set(0, c.gritRise, 0);
    this.grit.uniforms.uSizeScale.value = c.gritSize * g.particleSize * 7;
    this.grit.uniforms.uLifeScale.value = c.gritLifetime * 0.5 * g.particleLifetime;
    this.grit.uniforms.uSpeedScale.value = g.particleSpeed;
    this.grit.uniforms.uOpacity.value = g.opacity;
    this.grit.uniforms.uStretch.value = c.gritStretch;
    this.grit.uniforms.uTurbulence.value = c.gritTurbulence * g.turbulence;
  }

  /**
   * A point on the circle of radius `radius` about the vortex axis, at world
   * height `y`, on the bearing `angle`.
   *
   * The two basis vectors are the cast's own `side` and `direction`, so the
   * ring is flat on the floor whatever way the caster is facing.
   */
  _ringPoint(radius, y, angle, out) {
    out.copy(_centre);
    out.addScaledVector(this.side, Math.cos(angle) * radius);
    out.addScaledVector(this.direction, Math.sin(angle) * radius);
    out.y = y;
    return out;
  }

  /**
   * Dust, debris and grit, all three emitted onto the profile.
   *
   * @param {number} dt
   * @param {number} scale 0..1 — thinned while the column is still standing up
   */
  _vortexFx(dt, scale) {
    const c = settings.cyclone;
    const g = settings.global;
    const time = frame.uTime.value;
    const base = this._baseHeight();
    const whorling = this.phase === AbilityPhase.TRAVEL;
    const skirt = this.funnel.radiusAt(0);

    /* --- the skirt (or, while travelling, the whorl) --- */
    const dustRate = whorling ? c.whorlRate : c.dustRate;
    let dustCount = Math.round(this.dustEmitter.tick(dt, dustRate * scale) * g.particleCount);
    if (dustCount > 0) {
      // The anchor is the point on the *axis* the grain orbits; the start
      // position is out on the skirt. The particle shader rotates the offset
      // between them, so the ring turns with the funnel without the CPU
      // touching a single grain after it is emitted.
      _emit.anchor = _a.set(_centre.x, base + 0.05, _centre.z);
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = whorling ? c.dustSpeed * 0.35 : c.dustSpeed;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.35;
      _emit.inherit = null;
      _emit.size = 1;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.tint = null;
      _emit.time = time;

      const batches = Math.min(dustCount, RING_BATCHES);
      const per = Math.ceil(dustCount / batches);
      while (dustCount > 0) {
        // Whorling: the dust is still being gathered, so it comes off the whole
        // disc rather than off a ring that does not exist yet.
        const r = whorling ? skirt * randRange(0.2, 1.15) : skirt * randRange(0.85, 1.15);
        this._ringPoint(r, base + randRange(0.02, 0.5), randRange(0, TAU), _pos);
        _emit.position = _pos;
        _emit.radius = skirt * 0.12;
        this.dust.emit(Math.min(per, dustCount), _emit);
        dustCount -= per;
      }
    }

    if (whorling) return;

    /* --- chips torn off and carried up the wall --- */
    const debrisCount = Math.round(this.debrisEmitter.tick(dt, c.debrisRate * scale) * g.particleCount);
    if (debrisCount > 0) {
      // Picked up at a random height and thrown from the wall *at that height*
      // — which is the profile again, sampled where the chip actually is.
      const u = saturate(Math.random() * c.ribbonTop);
      const wallRadius = this.funnel.radiusAt(u);
      this.funnel.pointAt(u, _a);
      this._ringPoint(wallRadius, _a.y, randRange(0, TAU), _pos);
      _emit.position = _pos;
      _emit.anchor = _a;
      _emit.radius = wallRadius * 0.1;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.debrisSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.5;
      _emit.inherit = null;
      _emit.size = 1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.debrisLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 9;
      _emit.tint = null;
      _emit.time = time;
      this.debris.emit(debrisCount, _emit);
    }

    /* --- grit dragged in across the floor, from the aim circle --- */
    let gritCount = Math.round(this.gritEmitter.tick(dt, c.gritRate * scale) * g.particleCount);
    if (gritCount > 0) {
      _emit.anchor = null;
      _emit.speed = c.gritSpeed;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.22;
      _emit.inherit = null;
      _emit.size = 1;
      _emit.sizeVariance = 0.6;
      _emit.life = c.gritLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      const batches = Math.min(gritCount, RING_BATCHES);
      const per = Math.ceil(gritCount / batches);
      while (gritCount > 0) {
        const angle = randRange(0, TAU);
        const r = randRange(skirt, Math.max(skirt + 0.1, c.zoneRadius));
        this._ringPoint(r, c.intakeFloor + randRange(0, 0.15), angle, _pos);
        _emit.position = _pos;
        _emit.radius = 0.2;
        // Inward and slightly across, which is what gives the intake its curl
        // rather than making it a set of spokes pointing at the middle.
        _dir.copy(_centre).sub(_pos).setY(0.35).normalize();
        _dir.addScaledVector(this.side, -Math.sin(angle) * 0.55);
        _dir.addScaledVector(this.direction, Math.cos(angle) * 0.55);
        _emit.direction = _dir.normalize();
        this.grit.emit(Math.min(per, gritCount), _emit);
        gritCount -= per;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1);
    this._vortexFx(dt, 1);
  }

  onImpact() {
    const c = settings.cyclone;
    const g = settings.global;

    this._centrePoint(_centre);
    _pos.set(_centre.x, c.baseHeight + this.funnel.radiusAt(0) * 0.35, _centre.z);

    // The pressure shell at touchdown. Sized off the foot, like everything
    // else. `EARTH` rather than `AIR`: what leaves the ground here is a dense
    // ball of dust, and the thin pressure shell reads as a shockwave, which is
    // a different event happening a metre higher up.
    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: this.funnel.radiusAt(0) * 0.5,
      endRadius: c.touchSize * g.explosionIntensity,
      life: 0.9,
      intensity: c.touchIntensity,
      opacity: 0.65,
      fresnel: 1.4,
      displace: 0.7,
      squash: 0.55,
      colorA: getColor(c.colorTouchA),
      colorB: getColor(c.colorTouchB),
      colorC: getColor(c.colorTouchC)
    });

    // A hard slug of grit thrown off the ring the instant the foot bites.
    _emit.position = _pos;
    _emit.anchor = null;
    _emit.radius = this.funnel.radiusAt(0) * 0.8;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.gritSpeed * 1.4;
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.size = 1.3;
    _emit.sizeVariance = 0.7;
    _emit.life = c.gritLifetime * 1.6;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.grit.emit(Math.round(140 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.touchShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this.ctx.flash.trigger(getColor(c.colorTouchFlash), c.touchFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.cyclone;
    // `t` runs 0..1 while it stands, then 1..2 while it ropes out. The column's
    // own collapse is in `widthFade` and the rising foot, so the master fade
    // only has to take the last of the light out at the very end.
    const rope = t <= 1 ? 0 : saturate(t - 1);
    this._sync(1 - Easing.inCubic(rope) * 0.9);

    // The light rides the column rather than the floor, and climbs with the
    // foot as it ropes out.
    this.funnel.pointAt(saturate(c.lightRide), this.position);

    this._vortexFx(dt, this._standAmount() * (1 - rope * 0.7));
    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake * (1 - rope), dt);
  }

  onDestroy() {
    this.paths.clear();
    this.swarm.reset();
    this.scour.setVisible(false);
    this.funnel.visible = false;
  }

  dispose() {
    this.funnel.dispose();
    this.paths.dispose();
    this.swarm.dispose();
    this.scour.dispose();
    super.dispose();
  }
}

/** Whole filaments, never more than the buffer holds. */
function clampCount(value, max) {
  return Math.max(0, Math.min(max, Math.round(value)));
}
