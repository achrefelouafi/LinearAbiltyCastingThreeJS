import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { ColonySwarm, ColonyShape, colonySwarmParams } from '../../vfx/Colony.js';
import { Silhouette, LeadPath } from '../../vfx/Swarm.js';
import { Tube, TubePath } from '../../vfx/Tube.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { clamp, saturate, lerp, Easing, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;

/** Hard ceilings. The editor's `wasps` and `crawlers` sliders clamp here. */
const MAX_WASPS = 760;
const MAX_CRAWLERS = 260;

/**
 * The two unit-space constants this file has to know about `ColonySwarm`'s
 * shape library, and the reason they are named rather than folded into a fudge
 * factor.
 *
 * `colonyShapeField` builds its column as `colonyCylinderY(p, 0.40, 0.90) -
 * 0.06`, so the shape that actually appears has a radius of **0.46** and a
 * half-height of **0.96** in unit space before `shapeSize` scales it; its ball
 * is `length(p) - 0.90`. Dividing by these is what makes `columnHug = 1` mean
 * "exactly the tube's own radius" rather than "about the tube's radius, near
 * enough". They are a mirror of another module's source: change one, change
 * the other.
 */
const COLUMN_UNIT_RADIUS = 0.46;
const COLUMN_UNIT_HALF = 0.96;
const BALL_UNIT_RADIUS = 0.9;

/**
 * How many bearings one frame's grit is split between.
 *
 * A nest is disturbed all the way round its mouth, and emitting a frame's worth
 * from one bearing reads as a puff being thrown sideways rather than as ground
 * being worked over.
 */
const GRIT_BATCHES = 3;

/* --- module-scope scratch: the frame allocates nothing (I3) --- */
const _column = colonySwarmParams();
const _crawl = colonySwarmParams();
const _pit = groundFieldParams();
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _mouth = new Vector3();
const _axis = new Vector3();
const _flat = new Vector3();
const _ride = new Vector3();

/**
 * WASP FUNNEL — a nest opens on the aimed circle and a funnel of wasps stands
 * up out of it.
 *
 * Four beats: the mouth chews itself open in the floor while the cast is still
 * going out, the column stands up over `standTime`, it holds and surges for
 * `lifetime`, and then it sinks — the mouth dropping and the column thinning
 * while the ground carpet of crawlers swells with everything that has landed.
 *
 * **THE TRICK — density waves, and a wingbeat nobody is conducting.**
 *
 * The waves are *longitudinal*. Each agent is displaced along the wave axis by
 * a sine of its own position on that axis, which crowds agents at the zero
 * crossings and thins them at the extremes, so bands of high density travel up
 * the funnel at `waveSpeed / waveLength` per second. No agent is told where a
 * band is; the band is what happens when five hundred of them each answer the
 * same question about where they are standing. The alternative — modulating
 * per-agent brightness on the same sine — is in `vfx/Colony.js`'s history as
 * the version that failed, and it failed for a reason worth keeping in mind:
 * density you can see is agents *arriving*, not agents brightening.
 *
 * A consequence worth knowing, because it is free and it does a lot of work:
 * the surge is applied to all three of the flock's time samples (`t`, `t − h`,
 * `t − 2h`), so a condensed agent that would otherwise be motionless — and
 * therefore unbanked and pointing nowhere — gets its heading and its roll from
 * the wave. The wasps in a crest are visibly *climbing*.
 *
 * The wingbeat is the other half and costs a single sine: the fold runs on
 * `sin(TAU · (flapRate · uTime + dice.y))` where `dice.y` is per agent, so
 * every wasp beats on its own phase. With `edgeGain` up, a card going edge-on
 * collapses to a bright line, and five hundred of those flickering
 * independently is a mass that *shimmers* with nothing animated globally. Turn
 * `flapRate` to zero and the funnel goes dead — it stops being a swarm and
 * becomes a mesh with insects painted on it.
 *
 * **Everything is placed against `Tube.radiusAt()`.** `vfx/Tube.js` in FUNNEL
 * mode publishes the real vortex profile — `throat + skirt(tau) + mouth(tau)` —
 * and no radius in this file is computed any other way: the barrel of agents is
 * `radiusAt(barrel centre) × columnHug`, the crawlers' disc is `radiusAt(0) ×
 * crawlReach`, the pit is `radiusAt(0) × pitReach`, the pollen leaves on a ring
 * of `radiusAt(1)`. Drag `funnelSkirtFlare` with the clock stopped and the
 * carpet, the pit and the dust all move together, because there is one of them.
 *
 * **Where the colony is, and the honest reason.** A funnel is a cone at both
 * ends and a cylinder in the middle. `ColonySwarm` has a `COLUMN` and no cone,
 * so the agents are placed over exactly the cylindrical section — `barrelFrom`
 * to `barrelTo`, which want to sit inside `funnelSkirtHeight`…
 * `funnelMouthStart` — and the two flares are carried by the tube's dust, the
 * pit and the ejected pollen. The first attempt stretched the column across the
 * whole profile and scaled it to the mouth: agents stood a metre outside the
 * skirt at the bottom and a metre inside the mouth at the top, and the funnel
 * read as a cylinder with a smear of haze around it. Sitting the mass where the
 * profile really is a cylinder is not a compromise; it is the correct reading
 * of the curve.
 *
 * `zoneRadius` is deliberately *not* the profile. It is the aim circle, and
 * what it promises is the ground the nest disturbs — the grit comes off it and
 * the haze spreads across it — which is wider than the mouth. A nest from above
 * is a small dark hole inside a much larger scuffed patch.
 *
 * A cast captures two unitless dice rolls: `_seed` for the two colonies' cells
 * and `_yawRoll` so the pit's lip does not calve the same way twice.
 *
 * Six draw calls: three for the tube, one per colony, one for the mouth.
 */
export class WaspfunnelAbility extends Ability {
  constructor(context) {
    super('waspfunnel', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the haze column: 3 draw calls, and the profile everything reads --- */
    this.funnel = new Tube({
      path: TubePath.FUNNEL,
      prefix: 'funnel',
      // Smooth along its length, detailed around it: the sway and the mouth
      // flare are low-frequency, but the barrel needs facets or the silhouette
      // polygonises as soon as the camera comes near it.
      nodes: 64,
      sides: 30,
      renderOrder: 10
    });
    this.group.add(this.funnel.group);

    /* --- the colony in the barrel: 1 draw call --- */
    this.colony = new ColonySwarm(this.group, {
      capacity: MAX_WASPS,
      silhouette: Silhouette.BIRD,
      // Not additive. An additive swarm is a cloud of light, and a cloud of
      // light has no density — which would delete the one thing this ability
      // is about. Wasps occlude wasps, so a crest reads as *thicker*.
      additive: false,
      renderOrder: 13
    });

    /* --- the carpet on the mouth: 1 draw call --- */
    this.crawlers = new ColonySwarm(this.group, {
      capacity: MAX_CRAWLERS,
      silhouette: Silhouette.BIRD,
      additive: false,
      renderOrder: 12
    });

    /* --- the mouth itself: 1 draw call --- */
    this.pit = new GroundField(this.group, {
      mode: GroundMode.FUNNEL,
      additive: false,
      depthTest: true,
      name: 'WaspNestMouth'
    });

    /** Unitless dice rolls, re-rolled per cast. The only things a cast keeps. */
    this._seed = 0;
    this._yawRoll = 0;
    /** Agents drawn last frame, both colonies — the HUD's instance readout. */
    this._live = 0;
    /** 0 while travelling, then `t` out of `onFade` — 0..1 hold, 1..2 collapse. */
    this._beat = 0;
    /** Set on the frame the collapse begins. An event, not a dimension. */
    this._sank = false;

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

    // Pollen and wing-dust thrown out of the mouth. Additive and short: the one
    // bright thing in the ability, and it fires on the crest of the surge.
    this.motes = particles.get('waspfunnel.motes', {
      capacity: 2200,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.35
    });
    this.motes.uniforms.uDrag.value = 1.6;
    this.motes.uniforms.uEndSize.value = 0.2;
    this.motes.uniforms.uSizeIn.value = 0.05;
    this.motes.uniforms.uFadeIn.value = 0.06;
    this.motes.uniforms.uFadeOut.value = 0.45;

    // Chips of chewed ground whipped off the skirt. Lit and opaque, because
    // this is the system that has to read as matter.
    this.grit = particles.get('waspfunnel.grit', {
      capacity: 1800,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.grit.uniforms.uDrag.value = 1.0;
    this.grit.uniforms.uEndSize.value = 0.6;
    this.grit.uniforms.uSizeIn.value = 0.04;
    this.grit.uniforms.uFadeIn.value = 0.05;
    this.grit.uniforms.uFadeOut.value = 0.5;

    // Dry haze standing around the foot. Non-additive so it genuinely occludes.
    this.haze = particles.get('waspfunnel.haze', {
      capacity: 1200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.haze.uniforms.uDrag.value = 2.1;
    this.haze.uniforms.uEndSize.value = 2.6;
    this.haze.uniforms.uSizeIn.value = 0.18;
    this.haze.uniforms.uFadeIn.value = 0.24;
    this.haze.uniforms.uFadeOut.value = 0.3;

    this.moteEmitter = new RateEmitter();
    this.gritEmitter = new RateEmitter();
    this.hazeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._live;
  }

  get impactDuration() {
    return Math.max(0.05, settings.waspfunnel.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.waspfunnel.fadeTime);
  }

  /**
   * The light carries the wingbeat *and* the surge.
   *
   * Two terms, and they are two different things. The quantised step is the
   * flutter of a mass of wings passing in front of a light — shallow and fast,
   * because a deep flicker here makes the nest read as fire. The second term is
   * the **third consumer of the density wave**: the light brightens as a crest
   * climbs past the height it is sitting at, so the column is lit in time with
   * its own surge rather than on a clock of its own.
   */
  lightShimmer() {
    const c = settings.waspfunnel;
    const step = Math.floor(this.age * Math.max(1, c.lightFlickerSpeed));
    const noise = Math.abs(Math.sin(step * 127.1) * 43758.5453) % 1;
    const wing = 1 - saturate(c.lightFlicker) * noise;
    this.funnel.pointAt(saturate(c.lightRide), _ride);
    return Math.max(0, wing * (1 + saturate(c.lightSurge) * this._surgeAt(_ride)));
  }

  /* ------------------------------------------------------------------ */
  /* The beats and the wave                                              */
  /* ------------------------------------------------------------------ */

  /** Seconds since the nest opened. Zero while the cast is still going out. */
  _sinceArrival() {
    return this.phase === AbilityPhase.TRAVEL ? 0 : this.impactTime + this.fadeTime;
  }

  /** 0..1 — how far the column has stood up out of the mouth. */
  _stand() {
    const c = settings.waspfunnel;
    return Easing.outCubic(saturate(this._sinceArrival() / Math.max(0.02, c.standTime)));
  }

  /** 0..1 — how far it has sunk back into it. `_beat` runs 1..2 through the collapse. */
  _sink() {
    return Easing.inQuad(saturate(this._beat - 1));
  }

  /** 0..1 — how far the mouth has chewed itself open. Runs from the cast, not the arrival. */
  _mouthOpen() {
    const c = settings.waspfunnel;
    return Easing.outCubic(saturate(this.age / Math.max(0.02, c.pitGrowTime)));
  }

  /**
   * The wave axis, as `ColonySwarm` computes it.
   *
   * A CPU mirror of four lines in `Colony.js#update`: `waveAlong` lerps world
   * up toward the flattened cast heading and the result is normalised. It is a
   * mirror, so if one changes the other has to — but the alternative is a
   * second, subtly different idea of which way the crests are travelling, and
   * the whole point of this ability is that there is only one wave.
   */
  _surgeAxis(out) {
    const c = settings.waspfunnel;
    out.set(0, 1, 0).lerp(_flat.copy(this.direction).setY(0.0001), saturate(c.waveAlong));
    if (out.lengthSq() < 1e-8) out.set(0, 1, 0);
    return out.normalize();
  }

  /**
   * The surge at a world point, -1..1.
   *
   * The other half of the mirror — `colonySurge()`'s phase, evaluated on the
   * CPU so an emitter and a light can fire on the crest the eye is watching. It
   * runs on `frame.uTime`, not on the ability's age, for the same reason the
   * shader does: a colony four seconds into its life should not restart its
   * surge because something else happened.
   */
  _surgeAt(point) {
    const c = settings.waspfunnel;
    const len = Math.max(0.05, c.waveLength);
    this._surgeAxis(_axis);
    const along = point.dot(_axis);
    return Math.sin((TAU * (along - c.waveSpeed * frame.uTime.value)) / len);
  }

  /** Where the nest is. A far cast lands on its circle, so this is the target. */
  _centrePoint(out) {
    return this.pointAt(1, out);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this.gritEmitter.reset();
    this.hazeEmitter.reset();

    this._beat = 0;
    this._sank = false;

    // The two things a cast captures, both unitless.
    this._seed = Math.random() * 100;
    this._yawRoll = Math.random();

    this.colony.roll(this._seed);
    this.crawlers.roll(this._seed + 41.7);
    this.pit.setVisible(true);

    this._sync(1);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Re-resolve everything from live settings and push it into the four modules
   * and the three particle systems.
   *
   * Order matters exactly once: the tube is synced **first**, because every
   * `radiusAt()` and `pointAt()` below reads the dimensions that sync resolved.
   * Query it before syncing it and you are placing this frame's colony against
   * last frame's funnel, which is invisible until a slider moves and then looks
   * like lag.
   *
   * @param {number} fade 1 while the funnel stands, ramping to 0 as it sinks
   */
  _sync(fade) {
    const c = settings.waspfunnel;
    const g = settings.global;
    const stand = this._stand();
    const sink = this._sink();
    const base = c.baseHeight;

    this._centrePoint(_centre);

    /* --- 1 · the haze column ---------------------------------------- */
    const state = this._state;
    state.origin.set(_centre.x, base, _centre.z);
    // The mouth drops as the nest takes the colony back in: the column dies
    // downward, which is the opposite of a fade and the only reason the
    // collapse reads as the wasps *landing* rather than as the effect ending.
    state.target.set(_centre.x, Math.max(base + 0.3, c.height * lerp(1, c.sinkDrop, sink)), _centre.z);
    state.side.copy(this.side);
    state.progress = 1;
    state.fade = fade * stand;
    // Two collapses on one number, because both of them are widths: the thread
    // the column stands up out of, and the thread it sinks back to.
    state.widthFade = lerp(c.standTaper, 1, stand) * lerp(1, c.sinkTaper, sink);
    state.seed = this._seed;
    state.time = this.age;
    this.funnel.sync(c, state, g);
    this.funnel.visible = state.fade > 0.002;

    /* --- 2 · the colony, placed against the profile ------------------ */
    // Nothing from here down computes a radius. Every one of them asks the tube.
    const from = saturate(Math.min(c.barrelFrom, c.barrelTo));
    const to = Math.max(from + 1e-3, saturate(Math.max(c.barrelFrom, c.barrelTo)));
    const mid = (from + to) * 0.5;
    this.funnel.pointAt(from, _pos);
    const barrelBottom = _pos.y;
    this.funnel.pointAt(to, _pos);
    const barrelTop = _pos.y;
    const barrelMid = (barrelBottom + barrelTop) * 0.5;
    const barrelRadius = this.funnel.radiusAt(mid) * c.columnHug;

    const p = _column;
    const wasps = clamp(Math.round(c.wasps), 0, MAX_WASPS);

    p.count = wasps;
    // POINT: the lead does not travel, it stands at the nest. The barrel's own
    // mid height is handed to the lead rather than to `shapeUp`, so the flock
    // the agents fall back into as `condense` drops is centred on the same
    // place the shape is — otherwise every slider that softens the column also
    // drags it toward the floor.
    p.leadMode = LeadPath.POINT;
    p.leadS = 0;
    p.leadRate = 0;
    p.endHeight = barrelMid;

    p.latticeX = c.latticeX;
    p.latticeY = c.latticeY;
    p.latticeZ = c.latticeZ;
    p.spacingSide = c.spacingSide;
    p.spacingUp = c.spacingUp;
    p.lag = c.lag;
    p.jitter = c.jitter * g.randomness;
    p.churn = c.churn;
    p.breathe = c.breathe;
    p.breatheRate = c.breatheRate;
    p.wander = c.wander * g.turbulence;
    p.wanderScale = c.wanderScale * g.noiseFrequency;
    p.wanderSpeed = c.wanderSpeed * g.noiseSpeed;
    p.gather = c.gather;

    p.size = c.size;
    p.aspect = c.aspect;
    p.sizeJitter = c.sizeJitter * g.randomness;
    p.billboard = c.billboard;
    p.bank = c.bank;
    p.bankMax = c.bankMax;
    p.dihedral = c.dihedral;
    p.flapRate = c.flapRate;
    p.curl = c.wingCurl;
    p.edgeStretch = c.edgeStretch;
    // Populated on its own clock and emptied as the column sinks, agent by
    // agent against their own dice rather than as a block. `revealTime` is
    // deliberately not `standTime`: the funnel's *shape* standing up and the
    // funnel *filling with wasps* are two beats, and setting the first short
    // and the second long is the difference between a column that erupts and
    // one that is boiled into being.
    const appear = saturate(this._sinceArrival() / Math.max(0.02, c.revealTime));
    p.reveal = saturate(Math.min(appear, 1 - sink));
    p.revealSpread = c.revealSpread;

    p.silhouette = Silhouette.BIRD;
    p.sweep = c.sweep;
    p.edgeGain = c.edgeGain;
    p.lit = c.lit;
    p.tint = c.tint;
    p.tintJitter = c.tintJitter;
    p.tintAlong = c.tintAlong;
    p.opacity = c.opacity * g.opacity * fade;
    p.glow = c.glow * g.glow;
    p.softFade = c.softFade;

    // The barrel. Both shapes are COLUMN and the blend is 0: this ability does
    // not morph, it surges — see `locusttide` for the transition trick.
    p.shapeA = ColonyShape.COLUMN;
    p.shapeB = ColonyShape.COLUMN;
    p.shapeBlend = 0;
    p.condense = saturate(c.condense) * stand;
    p.shapeWidth = barrelRadius / COLUMN_UNIT_RADIUS;
    p.shapeDepth = barrelRadius / COLUMN_UNIT_RADIUS;
    p.shapeHeight = Math.max(0.05, (barrelTop - barrelBottom) * 0.5) / COLUMN_UNIT_HALF;
    p.shapeForward = 0;
    p.shapeSide = 0;
    p.shapeUp = 0;
    p.shapeSpin = c.shapeSpin;
    p.shapeFill = c.shapeFill;
    p.shapeSteps = c.shapeSteps;
    p.shapeSlack = c.shapeSlack;
    p.shapeRough = c.shapeRough * g.randomness;

    /* THE TRICK. Four numbers, and the funnel is alive. */
    p.waveAmp = c.waveAmp;
    p.waveLength = c.waveLength;
    p.waveSpeed = c.waveSpeed;
    p.waveAlong = c.waveAlong;
    p.cling = 0;
    p.floorY = 0;
    p.crawlHeight = 0;

    this.colony.setBasis(this.origin, this.direction, this.side, this.length);
    this.colony.setColors(c.colorWaspA, c.colorWaspB, c.colorWaspC, c.colorWaspD);
    this.colony.update(this.age, p);

    /* --- 3 · the carpet, also placed against the profile ------------- */
    const skirt = this.funnel.radiusAt(0);
    const q = _crawl;
    const carpetRadius = skirt * c.crawlReach;
    const crawlers = clamp(Math.round(c.crawlers * lerp(1, c.crawlSwell, sink)), 0, MAX_CRAWLERS);

    q.count = crawlers;
    q.leadMode = LeadPath.POINT;
    q.leadS = 0;
    q.leadRate = 0;
    q.endHeight = c.crawlHeight;
    q.latticeX = c.crawlLatticeX;
    q.latticeY = 1;
    q.latticeZ = c.crawlLatticeZ;
    q.spacingSide = c.crawlSpacing;
    q.spacingUp = c.crawlSpacing;
    q.lag = 0;
    q.jitter = c.crawlJitter * g.randomness;
    q.churn = c.crawlChurn;
    q.breathe = 0;
    q.breatheRate = c.breatheRate;
    q.wander = c.wander * 0.5 * g.turbulence;
    q.wanderScale = c.wanderScale * g.noiseFrequency;
    q.wanderSpeed = c.wanderSpeed * g.noiseSpeed;
    q.gather = c.gather;

    q.size = c.size * c.crawlSize;
    q.aspect = c.aspect;
    q.sizeJitter = c.sizeJitter * g.randomness;
    q.billboard = c.billboard;
    q.bank = c.bank;
    q.bankMax = c.bankMax;
    q.dihedral = c.dihedral;
    q.flapRate = c.flapRate;
    q.curl = c.wingCurl;
    q.edgeStretch = c.edgeStretch;
    // The carpet arrives with the mouth, not with the column: these are the
    // wasps that never left, and they are what says the hole is a nest.
    q.reveal = this._mouthOpen();
    q.revealSpread = c.revealSpread;

    q.silhouette = Silhouette.BIRD;
    q.sweep = c.sweep;
    q.edgeGain = c.edgeGain;
    q.lit = c.lit;
    q.tint = c.tint;
    q.tintJitter = c.tintJitter;
    q.tintAlong = c.tintAlong;
    q.opacity = c.crawlOpacity * g.opacity * fade;
    q.glow = c.glow * g.glow;
    q.softFade = c.softFade;

    // A ball squashed flat is a disc, which is the shape a carpet of insects
    // on the ground actually is. `cling` then pins them to the floor exactly,
    // so the disc's thickness is slop rather than a hovering slab.
    q.shapeA = ColonyShape.BALL;
    q.shapeB = ColonyShape.BALL;
    q.shapeBlend = 0;
    q.condense = saturate(c.crawlCondense);
    q.shapeWidth = carpetRadius / BALL_UNIT_RADIUS;
    q.shapeDepth = carpetRadius / BALL_UNIT_RADIUS;
    q.shapeHeight = c.crawlThickness / BALL_UNIT_RADIUS;
    q.shapeForward = 0;
    q.shapeSide = 0;
    q.shapeUp = 0;
    q.shapeSpin = c.crawlChurn * 0.3;
    q.shapeFill = 1;
    q.shapeSteps = c.shapeSteps;
    q.shapeSlack = c.shapeSlack;
    q.shapeRough = c.shapeRough * g.randomness;

    // The same wave runs through the carpet, and `cling` flattens it back onto
    // the floor afterwards — so the crawlers bunch and thin in step with the
    // column above them without ever leaving the ground.
    q.waveAmp = c.waveAmp;
    q.waveLength = c.waveLength;
    q.waveSpeed = c.waveSpeed;
    q.waveAlong = c.waveAlong;
    q.cling = saturate(c.crawlCling);
    q.floorY = 0;
    q.crawlHeight = c.crawlHeight;

    this.crawlers.setBasis(this.origin, this.direction, this.side, this.length);
    this.crawlers.setColors(c.colorWaspA, c.colorWaspB, c.colorWaspC, c.colorWaspD);
    this.crawlers.update(this.age, q);

    this._live = wasps + crawlers;

    /* --- 4 · the mouth, the last consumer of the same radius --------- */
    _pit.centre = _centre;
    _pit.yaw = this._yawRoll * TAU;
    _pit.height = c.pitHeight;
    _pit.radius = Math.max(0.2, skirt * c.pitReach);
    _pit.length = 1;
    _pit.grow = this._mouthOpen();
    _pit.recede = 0;
    _pit.progress = 1;
    _pit.fade = fade;
    _pit.seed = this._seed;

    _pit.edge = c.pitEdge;
    _pit.ragged = c.pitRagged;
    _pit.raggedScale = c.pitRaggedScale * g.noiseFrequency;
    _pit.warp = c.pitWarp * g.noiseStrength;

    _pit.relief = c.pitRelief;
    _pit.normalStep = c.pitNormalStep;
    _pit.ambient = c.pitAmbient;
    _pit.wrap = c.pitWrap;
    _pit.specular = c.pitSpecular;
    _pit.gloss = c.pitGloss;
    _pit.parallax = c.pitParallax;

    _pit.cell = c.pitCell;
    _pit.cellJitter = c.pitCellJitter;
    _pit.seam = c.pitSeam;
    _pit.thickness = c.pitLipDrop;
    _pit.lift = c.pitSpoil;
    _pit.depth = c.pitDepth;
    _pit.sharp = c.pitSharp;
    _pit.detail = c.pitDetail;
    // FUNNEL reads none of these; they are zeroed rather than left at their
    // defaults so a reader of this file is not left wondering what a spiral
    // pitch is doing on a hole in the ground.
    _pit.swirl = 0;
    _pit.arms = 0;
    _pit.speed = 0;
    _pit.flow = 0;
    _pit.windAngle = 0;

    _pit.additive = false;
    _pit.emissive = c.pitEmissive;
    _pit.opacity = c.pitOpacity;
    _pit.depthFade = c.pitDepthFade;
    _pit.colorBase = c.colorPitBase;
    _pit.colorEdge = c.colorPitEdge;
    _pit.colorGlow = c.colorPitGlow;
    _pit.colorDeep = c.colorPitDeep;

    _pit.noiseStrength = g.noiseStrength;
    _pit.noiseFrequency = g.noiseFrequency;
    _pit.noiseSpeed = g.noiseSpeed;
    _pit.opacityScale = g.opacity;

    this.pit.update(_pit);
    this.pit.setVisible(fade > 0.001);

    this._syncParticles(c, g);
  }

  /** Gradients and scales for the three systems. Live, every frame. */
  _syncParticles(c, g) {
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
    this.motes.uniforms.uGlow.value = c.moteGlow * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

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
    this.grit.uniforms.uTurbulence.value = 0.3 * g.turbulence;

    this.haze.setGradient(
      getColor(c.colorHazeA),
      getColor(c.colorHazeB),
      getColor(c.colorHazeC),
      getColor(c.colorHazeD)
    );
    this.haze.uniforms.uGravity.value.set(0, c.hazeRise, 0);
    this.haze.uniforms.uSizeScale.value = c.hazeSize * g.particleSize;
    this.haze.uniforms.uLifeScale.value = c.hazeLifetime * 0.5 * g.particleLifetime;
    this.haze.uniforms.uSpeedScale.value = c.hazeSpeed * g.particleSpeed;
    this.haze.uniforms.uOpacity.value = c.hazeOpacity * g.opacity;
    this.haze.uniforms.uTurbulence.value = c.hazeTurbulence * g.turbulence;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Everything the nest sheds while it is up.
   *
   * The pollen is **the second consumer of the density wave**: its rate is
   * scaled by the surge sampled at the mouth, so a puff leaves the top of the
   * funnel each time a crest arrives there and nothing between crests. That is
   * one line of arithmetic and it is the difference between "the swarm has a
   * pulsing texture" and "the swarm is *pumping*".
   *
   * @param {number} dt    seconds
   * @param {number} scale 0..1 — thinned as the column sinks
   */
  _nestFx(dt, scale) {
    const c = settings.waspfunnel;
    const g = settings.global;
    const time = frame.uTime.value;

    this._centrePoint(_centre);
    this.funnel.pointAt(1, _mouth);
    const skirt = this.funnel.radiusAt(0);
    const mouthRadius = this.funnel.radiusAt(1);
    // 0 in the trough, 2 on the crest, and never negative — a rate is not a
    // thing that can run backwards.
    const crest = Math.max(0, 1 + saturate(c.surgeGain) * this._surgeAt(_mouth));

    const moteCount = Math.round(
      this.moteEmitter.tick(dt, c.moteRate * scale * crest) * g.particleCount
    );
    if (moteCount > 0) {
      _emit.position = _mouth;
      _emit.radius = mouthRadius;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.85;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.08;
      _emit.sizeVariance = 0.7;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    let gritCount = Math.round(this.gritEmitter.tick(dt, c.gritRate * scale) * g.particleCount);
    if (gritCount > 0) {
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.gritSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.95;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.75;
      _emit.life = c.gritLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = c.gritSpin;
      _emit.tint = null;
      _emit.time = time;

      // Round the mouth rather than out of the middle of it — see GRIT_BATCHES.
      const batches = Math.min(gritCount, GRIT_BATCHES);
      const per = Math.ceil(gritCount / batches);
      while (gritCount > 0) {
        const a = Math.random() * TAU;
        // Between the skirt the funnel actually has and the circle the aim
        // indicator promised. Both are live; neither is written down here.
        const r = randRange(skirt, Math.max(skirt, c.zoneRadius));
        _pos.set(_centre.x + Math.cos(a) * r, 0.06, _centre.z + Math.sin(a) * r);
        _emit.position = _pos;
        _emit.radius = skirt * 0.25;
        this.grit.emit(Math.min(per, gritCount), _emit);
        gritCount -= per;
      }
    }

    const hazeCount = Math.round(this.hazeEmitter.tick(dt, c.hazeRate * scale) * g.particleCount);
    if (hazeCount > 0) {
      _pos.set(_centre.x, 0.15, _centre.z);
      _emit.position = _pos;
      _emit.radius = Math.max(skirt, c.zoneRadius) * 0.9;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.hazeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.95;
      _emit.size = 0.9;
      _emit.sizeVariance = 0.5;
      _emit.life = c.hazeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.time = time;
      this.haze.emit(hazeCount, _emit);
    }
  }

  /** The one-shot as the mouth tears open and the column comes out of it. */
  _openFx() {
    const c = settings.waspfunnel;
    const g = settings.global;
    const time = frame.uTime.value;

    this._centrePoint(_centre);
    _pos.copy(_centre);
    _pos.y = c.baseHeight + this.funnel.radiusAt(0) * 0.4;

    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.openSize * 0.25,
      endRadius: c.openSize * g.explosionIntensity,
      life: 0.6,
      intensity: c.openIntensity,
      opacity: 0.9,
      fresnel: 1.3,
      displace: 0.75,
      squash: 0.7,
      colorA: getColor(c.colorOpenA),
      colorB: getColor(c.colorOpenB),
      colorC: getColor(c.colorOpenC)
    });

    this.ctx.decals.spawn(DecalType.DUSTRING, _centre, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.9,
      width: 0.07,
      intensity: 0.8,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB),
      height: 0.02
    });

    _emit.position = _centre;
    _emit.radius = this.funnel.radiusAt(0);
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.gritSpeed * 2.2;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.8;
    _emit.life = c.gritLifetime * 1.3;
    _emit.lifeVariance = 0.6;
    _emit.spin = c.gritSpin * 1.4;
    _emit.tint = null;
    _emit.time = time;
    this.grit.emit(Math.round(c.openGrit * g.particleCount), _emit);

    _emit.speed = c.moteSpeed * 2.6;
    _emit.spread = 0.9;
    _emit.size = 0.08;
    _emit.life = c.moteLifetime;
    _emit.spin = 0;
    this.motes.emit(Math.round(c.openMotes * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      22
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.1 * g.explosionIntensity;
  }

  /** The one-shot on the frame the column starts to sink. */
  _collapseFx() {
    const c = settings.waspfunnel;
    const g = settings.global;

    this._centrePoint(_centre);
    _emit.position = _centre;
    _emit.radius = this.funnel.radiusAt(0) * 1.2;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.gritSpeed * 1.4;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.8;
    _emit.life = c.gritLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = c.gritSpin;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.grit.emit(Math.round(c.collapseGrit * g.particleCount), _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._beat = 0;
    this._sync(1);

    // The light sits at the nest from the moment the cast leaves: this is a far
    // cast, and what the player is watching is the circle, not the throw.
    this.funnel.pointAt(saturate(settings.waspfunnel.lightRide), this.position);

    // Only the ground is doing anything while the cast is still out — the mouth
    // is chewing itself open and throwing grit, and there is no column yet.
    this._nestFx(dt, this._mouthOpen() * 0.5);
  }

  onImpact() {
    this._sync(1);
    this._openFx();
  }

  onFade(dt, t) {
    this._beat = t;
    // 1 through the stand, easing to 0 through the collapse. Cubic, so the last
    // of the colony hangs on and then goes.
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
    this._sync(fade);

    if (t > 1 && !this._sank) {
      this._sank = true;
      this._collapseFx();
    }

    this.funnel.pointAt(saturate(settings.waspfunnel.lightRide), this.position);

    this._nestFx(dt, fade * (t <= 1 ? 1 : 0.4));
    this.ctx.shake.rumble(settings.waspfunnel.rumble * settings.global.cameraShake * fade, dt);
  }

  onDestroy() {
    this._live = 0;
    this._beat = 0;
    this._sank = false;
    this.colony.reset();
    this.crawlers.reset();
    this.funnel.visible = false;
    this.pit.setVisible(false);
  }

  dispose() {
    this.colony.dispose();
    this.crawlers.dispose();
    this.funnel.dispose();
    this.pit.dispose();
    super.dispose();
  }
}
