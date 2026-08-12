import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { ColonySwarm, ColonyShape, colonySwarmParams } from '../../vfx/Colony.js';
import { Silhouette, LeadPath } from '../../vfx/Swarm.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { clamp, saturate, lerp, Easing, randRange } from '../../utils/math.js';

/**
 * Hard ceiling on agents. The editor's `locusts` slider clamps here, and the
 * instanced buffer is built for exactly this many, so the two counts can never
 * disagree.
 */
const MAX_LOCUSTS = 640;

/**
 * Contact samples the stripped track carries.
 *
 * Sixteen, and it is a ring buffer inside `GroundField`, so a longer cast does
 * not cost more — it spaces the same sixteen samples further apart. Below about
 * ten the swathe reads as a row of discs rather than as a continuous strip;
 * above twenty the samples blend into one another and the extra ones are
 * arithmetic nobody can see.
 */
const TRACK_MARKS = 16;

/**
 * How many points along the mass one frame's chaff is split between.
 *
 * A tide sheds from its whole width. Emitting a frame's worth from one point
 * reads as a puff being thrown out sideways — the same mistake the bolt makes
 * if all its sparks leave from a single node on the filament.
 */
const CHAFF_BATCHES = 3;

/**
 * The unit-space half-extents of the three silhouettes in `Colony.js`'s
 * `colonyShapeField()`, and the reason this file has to know them.
 *
 * `shapeWidth/Height/Depth` scale a field that is *not* a unit cube: the wall is
 * a `0.92 × 0.90 × 0.10` box rounded by another 0.06, the fist is a `0.52 ×
 * 0.44 × 0.34` box rounded by 0.20 with knuckles reaching 0.63, and the spear's
 * widest point is its 0.21-radius spindle head. Anything that has to answer
 * *where the bottom of this shape actually is* — which is exactly what the
 * ground bite does — has to go through these, or the wall appears to be dragging
 * two metres of nothing along the floor.
 *
 * They are a mirror of another module's source. Change one, change the other.
 */
const FIST_UNIT_HALF = 0.64;
const FIST_UNIT_WIDE = 0.72;
const WALL_UNIT_HALF = 0.96;
const WALL_UNIT_WIDE = 0.98;
const SPEAR_UNIT_HALF = 0.21;
const SPEAR_UNIT_WIDE = 0.21;

/* --- module-scope scratch: the frame allocates nothing (I3) --- */
const _colony = colonySwarmParams();
const _rut = groundFieldParams();
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _ground = new Vector3();

/**
 * Which pair of shapes the morph is between, and how far across it is.
 *
 * One object, written by `_stageAt()` and read immediately by its caller. It is
 * module scope because `_sync()` asks for it four times a frame and a fresh
 * `{ index, blend }` four hundred times a second is exactly the allocation I3
 * exists to forbid.
 */
const _stage = { index: 0, blend: 0 };

/**
 * LOCUST TIDE — a colony thrown down the aimed line that forms shapes as it
 * travels.
 *
 * Five beats and none of them is a new renderer: the colony boils out of the
 * caster's hand as a loose cloud, closes into a **fist**, opens into a **wall**
 * broadside to the line, draws itself into a **spear** as it reaches the
 * target, drives that spear into the floor, and comes apart. Behind it the
 * ground is stripped in a ragged swathe.
 *
 * **THE TRICK — the transition, not the shape.** Anybody can park four hundred
 * agents inside a signed distance field; what makes this read is that the field
 * *changes* underneath them while they hold their places in it. Two things make
 * that work, and both of them are in `vfx/Colony.js` rather than here:
 *
 *  1. **The fields are blended, never the points.** `mix(pointInFist,
 *     pointInWall, 0.5)` is a crossfade, and its midpoint is every agent
 *     halfway between two unrelated places — a smear with no silhouette at all.
 *     `mix(fistField, wallField, 0.5)` is a *shape*: a fist growing broad, a
 *     wall drawing itself to a point. Every intermediate state of this ability
 *     is a real object, which is the only reason the morph is worth watching.
 *  2. **An agent keeps its own place.** Each one draws a single point from its
 *     own unchanging dice and walks it onto the isosurface by gradient descent,
 *     so its target is a pure function of the shape uniforms. Nothing is
 *     re-assigned when the shape changes; the agent simply flows to where the
 *     same corner of the same field went. Re-rolling per shape — the obvious
 *     implementation — boils the whole cloud on every transition, and a boiling
 *     cloud does not read as a thing becoming another thing.
 *
 * What this file owns is the **schedule**, and the schedule is deliberately
 * measured in fractions of the cast line rather than in seconds: `fistAt`,
 * `wallAt` and `spearAt` are where along the throw each silhouette lands, so a
 * fifteen-metre cast and a thirty-metre one both show all three, in the same
 * places relative to the caster, at the same speed slider. Timing them in
 * seconds was the first version and it was wrong at both ends of the range —
 * short casts arrived mid-fist and long ones held the spear for a second and a
 * half of dead air.
 *
 * **The size triple morphs on the same fraction as the field.** A fist is
 * compact, a wall is broad and thin, a spear is long and narrow, so each stage
 * carries its own half-extents and its own ride height and they are lerped on
 * the very blend the fields are. Blending the fields but holding the size gives
 * a wall that arrives fist-sized and then inflates, which looks like a bug
 * because it is one.
 *
 * **The floor is a consequence, not a second authored effect.** `_biteAt()`
 * asks how far the *bottom of the current shape* is off the ground and turns
 * that into a contact strength for `GroundField(RUT)`, so the wall — low, broad,
 * dragging its knuckles — scours the floor, and the spear, which flies, barely
 * marks it. Each contact sample already lying in the floor is re-derived every
 * frame from the unitless fraction of the track it was taken at, so dragging
 * `wallUp` with **P** held re-carves a gouge that was cut two seconds ago.
 *
 * A cast captures one seed, one fraction-of-the-line per contact sample and one
 * unitless lateral dice roll per sample. Everything with a unit is resolved from
 * `settings.locusttide` inside the update loop, on a zero-length frame included.
 *
 * Two draw calls: the colony and the swathe.
 */
export class LocusttideAbility extends Ability {
  constructor(context) {
    super('locusttide', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /*
     * The colony: one draw call for every agent in it.
     *
     * `additive: false` is not a detail. An additive swarm is a cloud of light
     * and its silhouette dissolves the moment two agents overlap — which, in a
     * condensed shape, is constantly. Chitin occludes chitin, and a fist that
     * gets *darker* where it is thick is the reason the shape reads at all.
     */
    this.colony = new ColonySwarm(this.group, {
      capacity: MAX_LOCUSTS,
      // BIRD, with the aspect pulled in and the flap rate pushed up: an insect
      // is a bird's silhouette at a third of the span and three times the beat.
      silhouette: Silhouette.BIRD,
      additive: false,
      renderOrder: 13
    });

    /* The stripped swathe: one draw call, however long the cast. */
    this.track = new GroundField(this.group, {
      mode: GroundMode.RUT,
      marks: TRACK_MARKS,
      additive: false,
      depthTest: true,
      name: 'LocustTrack'
    });

    /** Re-rolled per cast. A dice roll, not a dimension. */
    this._seed = 0;
    /** Agents drawn last frame — the HUD's instance readout. */
    this._live = 0;
    /** 0 while travelling, then `t` out of `onFade` — 0..1 hold, 1..2 blow-out. */
    this._beat = 0;

    /*
     * The contact samples, as events. `_markU[i]` is the fraction of the cast
     * the sample was taken at and `_markSlots[i]` is the `Vector4` inside
     * `GroundField`'s own ring buffer that carries it. Neither holds a metre:
     * where that fraction is on the floor and how hard the colony was pressing
     * there are both recomputed from live settings every frame.
     */
    this._markSlots = new Array(TRACK_MARKS).fill(null);
    this._markU = new Float32Array(TRACK_MARKS);
    this._markCount = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Shredded stubble kicked up under the mass. Lit and non-additive, because
    // this is the one system that has to read as *matter* — the tide is eating
    // the ground and the evidence has to be opaque.
    this.chaff = particles.get('locusttide.chaff', {
      capacity: 2400,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.chaff.uniforms.uDrag.value = 0.9;
    this.chaff.uniforms.uEndSize.value = 0.7;
    this.chaff.uniforms.uSizeIn.value = 0.04;
    this.chaff.uniforms.uFadeIn.value = 0.05;
    this.chaff.uniforms.uFadeOut.value = 0.55;

    // The dry ground haze the colony drags along with it.
    this.dust = particles.get('locusttide.dust', {
      capacity: 1400,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.dust.uniforms.uDrag.value = 2.0;
    this.dust.uniforms.uEndSize.value = 2.8;
    this.dust.uniforms.uSizeIn.value = 0.16;
    this.dust.uniforms.uFadeIn.value = 0.22;
    this.dust.uniforms.uFadeOut.value = 0.34;

    // Sunlight caught on a wing. Tiny, short and additive — this is the only
    // thing in the ability allowed to be bright, and it is what sells the mass
    // as thousands of individual bodies rather than as one moving volume.
    this.glints = particles.get('locusttide.glints', {
      capacity: 2200,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.3
    });
    this.glints.uniforms.uDrag.value = 1.8;
    this.glints.uniforms.uEndSize.value = 0.15;
    this.glints.uniforms.uSizeIn.value = 0.03;
    this.glints.uniforms.uFadeIn.value = 0.04;
    this.glints.uniforms.uFadeOut.value = 0.5;

    this.chaffEmitter = new RateEmitter();
    this.dustEmitter = new RateEmitter();
    this.glintEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._live;
  }

  get impactDuration() {
    return Math.max(0.05, settings.locusttide.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.locusttide.fadeTime);
  }

  /**
   * The light shimmers on the wingbeat rather than guttering.
   *
   * A quantised step like the bolt's, but shallow and fast: what the eye reads
   * off a swarm lit from one side is a *flutter* in the light it bounces, not a
   * flicker in the source. Deep flicker here makes the colony read as fire.
   */
  lightShimmer() {
    const c = settings.locusttide;
    const step = Math.floor(this.age * Math.max(1, c.lightFlickerSpeed));
    const noise = Math.abs(Math.sin(step * 127.1) * 43758.5453) % 1;
    return 1 - saturate(c.lightFlicker) * noise;
  }

  /* ------------------------------------------------------------------ */
  /* The beats, as unitless fractions of live settings                    */
  /* ------------------------------------------------------------------ */

  /** Where the colony is along the line, 0..1. Pinned at the target after it lands. */
  _leadU() {
    return this.phase === AbilityPhase.TRAVEL ? this.u : 1;
  }

  /** Seconds since the spear landed. Zero while it is still on its way. */
  _sinceArrival() {
    return this.phase === AbilityPhase.TRAVEL ? 0 : this.impactTime + this.fadeTime;
  }

  /**
   * Which two shapes the morph is between at `u`, and how far across it is.
   *
   * Writes and returns the shared `_stage`. The four schedule fractions are
   * nudged apart rather than trusted to be in order — the editor lets you drag
   * `wallAt` past `spearAt`, and the honest answer to that is a degenerate
   * transition, not a division by zero and a cloud of NaN.
   *
   * The blend is raised to `morphCurve` and *then* smoothstepped. The power is
   * the authored part — above 1 it holds each silhouette and crosses late,
   * which is what makes the shapes read as three distinct poses rather than as
   * one continuous ooze — and the smoothstep is there because a power curve
   * still arrives at each end with a non-zero slope, and the resulting kink is
   * visible as a twitch in four hundred agents all changing direction at once.
   */
  _stageAt(u) {
    const c = settings.locusttide;
    const fist = saturate(c.fistAt);
    const wall = Math.max(fist + 1e-3, saturate(c.wallAt));
    const spear = Math.max(wall + 1e-3, saturate(c.spearAt));

    let k;
    if (u <= wall) {
      _stage.index = 0;
      k = saturate((u - fist) / (wall - fist));
    } else {
      _stage.index = 1;
      k = saturate((u - wall) / (spear - wall));
    }
    k = Math.pow(k, Math.max(0.05, c.morphCurve));
    _stage.blend = k * k * (3 - 2 * k);
    return _stage;
  }

  /**
   * One measurement, interpolated across whichever transition is live.
   *
   * Called with the three stages' values for the same quantity — half-width,
   * ride height, whatever — so the size triple and the field are guaranteed to
   * be crossing on the same fraction. That guarantee is the whole reason this
   * is a helper rather than three lerps written out at the call site.
   */
  _stageValue(u, fist, wall, spear) {
    const stage = this._stageAt(u);
    return stage.index === 0 ? lerp(fist, wall, stage.blend) : lerp(wall, spear, stage.blend);
  }

  /** 0..1 — how completely the shape has taken the flock over at `u`. */
  _condenseAt(u) {
    const c = settings.locusttide;
    const close = saturate(c.closeAt);
    const fist = Math.max(close + 1e-3, saturate(c.fistAt));
    return Easing.outCubic(saturate((u - close) / (fist - close))) * saturate(c.condenseMax);
  }

  /** 0..1 — how far the shape has let the colony go again. */
  _disperse() {
    const c = settings.locusttide;
    const since = this._sinceArrival() - c.holdTime;
    return Easing.outCubic(saturate(since / Math.max(0.02, c.disperseTime)));
  }

  /**
   * The reveal wave, 0..1.
   *
   * Ramps up as the colony gathers at the hand and back down as it scatters;
   * `Swarm` compares it against each agent's own dice, so they appear and wink
   * out one at a time rather than as a block. A block is a decal switching on.
   */
  _reveal() {
    const c = settings.locusttide;
    const inWave = saturate(this.age / Math.max(0.02, c.revealTime));
    const dying = this._sinceArrival() - c.holdTime - c.vanishDelay;
    const outWave = 1 - saturate(dying / Math.max(0.02, c.vanishTime));
    return Math.min(inWave, outWave);
  }

  /**
   * How high the shape's centre rides above the **floor** at `u`, metres.
   *
   * Note the frame this is in. `ColonySwarm` measures `shapeUp` from the lead,
   * and the lead lofts over the middle of its throw, so authoring the three
   * stages against the lead would have made every silhouette's height depend on
   * `leadRise` — drag the loft and the wall climbs off the ground it is
   * supposed to be standing on. These are floor heights, and `_sync()` converts
   * by subtracting the lead's own height. The loft therefore shapes the loose
   * cloud and nothing else, which is what it is for.
   */
  _shapeCentreY(u) {
    const c = settings.locusttide;
    return this._stageValue(u, c.fistUp, c.wallUp, c.spearUp);
  }

  /**
   * The height of the lead at `u`, metres — the CPU mirror of `leadAt()` in
   * `LINE` mode. Mirror, so if one changes the other has to.
   */
  _leadHeight(u) {
    const c = settings.locusttide;
    const t = saturate(u);
    return lerp(c.handHeight, c.endHeight, t) + c.leadRise * Math.sin(Math.PI * t);
  }

  /**
   * How hard the colony is pressing on the floor at `u`, 0..1.
   *
   * Derived from the shape's own geometry — its centre height less its real
   * half-height, in metres above the floor — and weakened over `biteReach`
   * metres of clearance. That is why the wall, which stands with its lower edge
   * in the dirt, strips the ground, and the spear, which flies, barely marks
   * it; and why raising `wallUp` on a paused frame lifts the gouge out of a
   * swathe that was cut before you touched the slider.
   */
  _biteAt(u) {
    const c = settings.locusttide;
    const half = this._stageValue(
      u,
      c.fistHeight * FIST_UNIT_HALF,
      c.wallHeight * WALL_UNIT_HALF,
      c.spearHeight * SPEAR_UNIT_HALF
    );
    const clearance = Math.max(0, this._shapeCentreY(u) - half);
    const contact = 1 - saturate(clearance / Math.max(0.05, c.biteReach));
    return saturate(contact * this._condenseAt(u) * c.biteGain);
  }

  /**
   * Half the mass's lateral extent at `u`, metres — how far off the centre an
   * emitter may throw something and still be inside the colony.
   *
   * Through the unit widths for the same reason the bite goes through the unit
   * heights: a `spearWidth` of 2 is a 0.42 m spindle, not a 2 m one, and an
   * emitter that believes otherwise sprays chaff into clean air either side of
   * a spear that is nowhere near it.
   */
  _massRadius(u) {
    const c = settings.locusttide;
    return (
      this._stageValue(
        u,
        c.fistWidth * FIST_UNIT_WIDE,
        c.wallWidth * WALL_UNIT_WIDE,
        c.spearWidth * SPEAR_UNIT_WIDE
      ) + c.size
    );
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.chaffEmitter.reset();
    this.dustEmitter.reset();
    this.glintEmitter.reset();

    this._beat = 0;
    this._markCount = 0;
    for (let i = 0; i < TRACK_MARKS; i++) this._markSlots[i] = null;
    this.track.clearMarks();
    this.track.setVisible(true);

    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;
    this.colony.roll(this._seed);

    this._sync(1);
    this._releaseFx();
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve the whole colony, its swathe and its particle systems from live
   * settings.
   *
   * @param {number} fade 1 while the colony is up, ramping to 0 as it blows out
   */
  _sync(fade) {
    const c = settings.locusttide;
    const g = settings.global;
    const p = _colony;

    const travelling = this.phase === AbilityPhase.TRAVEL;
    const u = this._leadU();
    const disperse = this._disperse();
    // The shape's grip: everything the schedule closed, less everything the
    // dispersal has let go of.
    const closed = this._condenseAt(u) * (1 - disperse);

    this._live = clamp(Math.round(c.locusts), 0, MAX_LOCUSTS);

    /* --- the lead -------------------------------------------------- */
    p.count = this._live;
    p.leadMode = LeadPath.LINE;
    p.leadS = u;
    // d(s)/dt, so the shader can rewind the lead for the lagged ranks. Metres
    // per second over metres — unitless, and read from the live speed rather
    // than from whatever the front happened to do last frame.
    p.leadRate = travelling ? (c.speed * g.speed) / Math.max(0.1, this.length) : 0;
    p.leadRise = c.leadRise;
    p.handForward = c.handForward;
    p.handSide = c.handSide;
    p.handHeight = c.handHeight;
    p.endHeight = c.endHeight;

    /* --- the formation, opening out as the shape lets go ------------ */
    p.latticeX = c.latticeX;
    p.latticeY = c.latticeY;
    p.latticeZ = c.latticeZ;
    p.spacingSide = c.spacingSide * lerp(1, c.disperseSpacing, disperse);
    p.spacingUp = c.spacingUp * lerp(1, c.disperseSpacing, disperse);
    p.lag = c.lag * lerp(1, c.disperseLag, disperse);
    p.jitter = c.jitter * g.randomness;
    p.churn = c.churn * lerp(1, c.disperseChurn, disperse);
    p.breathe = c.breathe;
    p.breatheRate = c.breatheRate;
    p.wander = c.wander * lerp(1, c.disperseWander, disperse) * g.turbulence;
    p.wanderScale = c.wanderScale * g.noiseFrequency;
    p.wanderSpeed = c.wanderSpeed * g.noiseSpeed;
    p.gather = c.gather;

    /* --- one locust -------------------------------------------------- */
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
    p.reveal = this._reveal();
    p.revealSpread = c.revealSpread;

    /* --- the silhouette and its colour ------------------------------- */
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

    /* --- THE TRICK: which two shapes, and how far across ------------- */
    const stage = this._stageAt(u);
    p.shapeA = stage.index === 0 ? ColonyShape.FIST : ColonyShape.WALL;
    p.shapeB = stage.index === 0 ? ColonyShape.WALL : ColonyShape.SPEAR;
    p.shapeBlend = stage.blend;
    p.condense = closed;
    // The same fraction the fields are crossing on. See the class comment.
    p.shapeWidth = this._stageValue(u, c.fistWidth, c.wallWidth, c.spearWidth);
    p.shapeHeight = this._stageValue(u, c.fistHeight, c.wallHeight, c.spearHeight);
    p.shapeDepth = this._stageValue(u, c.fistDepth, c.wallDepth, c.spearDepth);
    p.shapeForward = c.shapeForward;
    p.shapeSide = c.shapeSide;
    // Authored against the floor, handed over in the lead's frame — see
    // `_shapeCentreY()` for why that conversion is here rather than in the
    // settings block.
    p.shapeUp = this._shapeCentreY(u) - this._leadHeight(u);
    p.shapeSpin = c.shapeSpin;
    p.shapeFill = c.shapeFill;
    p.shapeSteps = c.shapeSteps;
    p.shapeSlack = c.shapeSlack;
    p.shapeRough = c.shapeRough * g.randomness;

    /* --- the surge running down the mass ----------------------------- */
    p.waveAmp = c.waveAmp;
    p.waveLength = c.waveLength;
    p.waveSpeed = c.waveSpeed;
    p.waveAlong = c.waveAlong;

    this.colony.setBasis(this.origin, this.direction, this.side, this.length);
    this.colony.setColors(c.colorLocustA, c.colorLocustB, c.colorLocustC, c.colorLocustD);
    // The clock argument is ignored by design: the churn, the shape's spin and
    // the surge all run on the shared `uTime`, so a colony four seconds into
    // its flight does not restart its motion when it condenses.
    this.colony.update(this.age, p);

    this._syncTrack(c, g, fade);
    this._syncParticles(c, g);
  }

  /**
   * The stripped swathe.
   *
   * Every sample already in the floor is re-derived here — where it sits along
   * the track and how hard the colony was pressing on it are both consequences
   * of the live schedule, not of what the schedule said when the sample was
   * posted. This loop is the line that makes `wallAt`, `wallUp`, `wallHeight`
   * and `biteReach` re-carve a gouge that is already lying in the ground.
   */
  _syncTrack(c, g, fade) {
    for (let i = 0; i < this._markCount; i++) {
      const slot = this._markSlots[i];
      if (!slot) continue;
      const u = this._markU[i];
      slot.y = u;
      slot.w = this._biteAt(u);
    }

    // The swathe holds at full strength and then weathers away, on its own
    // clock rather than the colony's: the insects leave before the damage does.
    const since = this._sinceArrival();
    const weather = 1 - Easing.inQuad(saturate((since - c.rutHold) / Math.max(0.05, c.rutFadeTime)));

    _rut.centre = this.origin;
    _rut.yaw = Math.atan2(this.direction.x, this.direction.z);
    _rut.height = c.rutHeight;
    // RUT reads `radius` only to size its quad; the swathe's own measurement is
    // `width`, and a quad three half-widths across leaves room for the spoil.
    _rut.radius = Math.max(0.2, c.rutWidth * 3);
    _rut.length = Math.max(0.5, this.length);
    _rut.progress = this._leadU();
    _rut.grow = 1;
    _rut.recede = 0;
    _rut.fade = fade * weather;
    _rut.seed = this._seed;

    _rut.edge = c.rutEdge;
    _rut.ragged = c.rutRagged;
    _rut.raggedScale = c.rutRaggedScale * g.noiseFrequency;
    _rut.warp = c.rutWarp * g.noiseStrength;

    _rut.relief = c.rutRelief;
    _rut.normalStep = c.rutNormalStep;
    _rut.ambient = c.rutAmbient;
    _rut.wrap = c.rutWrap;
    _rut.specular = c.rutSpecular;
    _rut.gloss = c.rutGloss;
    _rut.parallax = c.rutParallax;

    _rut.width = c.rutWidth;
    _rut.depth = c.rutDepth;
    _rut.sharp = c.rutSharp;
    _rut.cell = c.rutCell;
    _rut.detail = c.rutBiteDepth;
    _rut.lift = c.rutSpoil;
    _rut.thickness = c.rutSpoilWidth;
    _rut.seam = c.rutSampleBlend;
    // The swathe follows the cast line; a lateral drift here would be a track
    // belonging to something that walked off it.
    _rut.swirl = 0;
    _rut.speed = 1;
    _rut.flow = 0;
    _rut.windAngle = 0;

    _rut.additive = false;
    _rut.emissive = c.rutEmissive;
    _rut.opacity = c.rutOpacity;
    _rut.depthFade = c.rutDepthFade;
    _rut.colorBase = c.colorRutBase;
    _rut.colorEdge = c.colorRutEdge;
    _rut.colorGlow = c.colorRutGlow;
    _rut.colorDeep = c.colorRutDeep;

    _rut.noiseStrength = g.noiseStrength;
    _rut.noiseFrequency = g.noiseFrequency;
    _rut.noiseSpeed = g.noiseSpeed;
    _rut.opacityScale = g.opacity;

    this.track.update(_rut);
    this.track.setVisible(_rut.fade > 0.001);
  }

  /** Gradients and scales for the three systems. Live, every frame. */
  _syncParticles(c, g) {
    this.chaff.setGradient(
      getColor(c.colorChaffA),
      getColor(c.colorChaffB),
      getColor(c.colorChaffC),
      getColor(c.colorChaffD)
    );
    this.chaff.uniforms.uGravity.value.set(0, c.chaffGravity, 0);
    this.chaff.uniforms.uSizeScale.value = c.chaffSize * g.particleSize * 7;
    this.chaff.uniforms.uLifeScale.value = c.chaffLifetime * 0.5 * g.particleLifetime;
    this.chaff.uniforms.uSpeedScale.value = g.particleSpeed;
    this.chaff.uniforms.uOpacity.value = g.opacity;
    this.chaff.uniforms.uTurbulence.value = 0.3 * g.turbulence;

    this.dust.setGradient(
      getColor(c.colorDustA),
      getColor(c.colorDustB),
      getColor(c.colorDustC),
      getColor(c.colorDustD)
    );
    this.dust.uniforms.uGravity.value.set(0, c.dustRise, 0);
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize;
    this.dust.uniforms.uLifeScale.value = c.dustLifetime * 0.5 * g.particleLifetime;
    this.dust.uniforms.uSpeedScale.value = c.dustSpeed * g.particleSpeed;
    this.dust.uniforms.uOpacity.value = c.dustOpacity * g.opacity;
    this.dust.uniforms.uTurbulence.value = c.dustTurbulence * g.turbulence;

    this.glints.setGradient(
      getColor(c.colorGlintA),
      getColor(c.colorGlintB),
      getColor(c.colorGlintC),
      getColor(c.colorGlintD)
    );
    this.glints.uniforms.uGravity.value.set(0, c.glintRise, 0);
    this.glints.uniforms.uSizeScale.value = c.glintSize * g.particleSize * 7;
    this.glints.uniforms.uLifeScale.value = c.glintLifetime * 0.5 * g.particleLifetime;
    this.glints.uniforms.uSpeedScale.value = g.particleSpeed;
    this.glints.uniforms.uOpacity.value = g.opacity;
    this.glints.uniforms.uGlow.value = c.glintGlow * g.glow;
    this.glints.uniforms.uTurbulence.value = c.glintTurbulence * g.turbulence;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** The boil at the caster's hand as the colony comes out of it. */
  _releaseFx() {
    const c = settings.locusttide;
    const g = settings.global;

    this.colony.leadPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
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
    _emit.radius = this._massRadius(0) * 0.4;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.7).setY(0.4).normalize();
    _emit.speed = c.glintSpeed * 2.2;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.7;
    _emit.life = c.glintLifetime;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.glints.emit(Math.round(c.castGlints * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.4 * g.explosionIntensity;
  }

  /**
   * Everything the tide sheds while it is up.
   *
   * @param {number} dt    seconds
   * @param {number} scale 0..1 — thinned once the colony is only holding
   */
  _colonyFx(dt, scale) {
    const c = settings.locusttide;
    const g = settings.global;
    const time = frame.uTime.value;
    const u = this._leadU();
    const radius = this._massRadius(u);
    // How much of the floor the mass is actually touching. The chaff and the
    // dust are the *ground* answering, so they follow the bite rather than the
    // colony: a spear flying overhead lifts nothing.
    const bite = this._biteAt(u);

    this.colony.shapeCentre(_centre);
    this.pointAt(u, _ground);

    let chaffCount = Math.round(
      this.chaffEmitter.tick(dt, c.chaffRate * scale * bite) * g.particleCount
    );
    if (chaffCount > 0) {
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.35).setY(1).normalize();
      _emit.speed = c.chaffSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = c.chaffSpread;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.75;
      _emit.life = c.chaffLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = c.chaffSpin;
      _emit.tint = null;
      _emit.time = time;

      // Split along the swathe, not fired from one point — see CHAFF_BATCHES.
      const batches = Math.min(chaffCount, CHAFF_BATCHES);
      const per = Math.ceil(chaffCount / batches);
      while (chaffCount > 0) {
        this.pointAt(saturate(u - randRange(0, 0.1)), _pos);
        _pos.y = 0.05;
        _emit.position = _pos;
        _emit.radius = c.rutWidth;
        this.chaff.emit(Math.min(per, chaffCount), _emit);
        chaffCount -= per;
      }
    }

    const dustCount = Math.round(this.dustEmitter.tick(dt, c.dustRate * scale * bite) * g.particleCount);
    if (dustCount > 0) {
      _ground.y = 0.12;
      _emit.position = _ground;
      _emit.radius = c.rutWidth * 1.4;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.95;
      _emit.size = 0.9;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.time = time;
      this.dust.emit(dustCount, _emit);
    }

    // The glints come off the *mass*, at whatever height it is flying, and they
    // are the one emitter that does not care about the floor.
    const glintCount = Math.round(this.glintEmitter.tick(dt, c.glintRate * scale) * g.particleCount);
    if (glintCount > 0) {
      _emit.position = _centre;
      _emit.radius = radius;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.glintSpeed;
      _emit.speedVariance = 0.9;
      _emit.spread = 1.0;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.8;
      _emit.life = c.glintLifetime;
      _emit.lifeVariance = 0.6;
      _emit.spin = 0;
      _emit.time = time;
      this.glints.emit(glintCount, _emit);
    }
  }

  /**
   * Post contact samples along the track as the front passes them.
   *
   * A sample is three unitless numbers and nothing else: the fraction of the
   * cast it was taken at, a lateral dice roll so the swathe does not read as a
   * ruled line, and the timestamp. Its depth is not recorded at all — it is
   * re-derived from the live schedule every frame in `_syncTrack()`.
   */
  _trackFx() {
    const c = settings.locusttide;
    const samples = Math.max(1, Math.min(TRACK_MARKS, Math.round(c.rutSamples)));
    const u = this._leadU();

    while (this._markCount < samples && u >= (this._markCount + 1) / samples) {
      const at = (this._markCount + 1) / samples;
      this._markU[this._markCount] = at;
      this._markSlots[this._markCount] = this.track.mark(
        randRange(-0.35, 0.35),
        at,
        frame.uTime.value,
        this._biteAt(at)
      );
      this._markCount++;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._beat = 0;
    this._sync(1);

    // The light rides the shape, not the floor under it. `advance()` has
    // already put `position` on the ground line, so lift it onto the mass.
    this.colony.shapeCentre(this.position);

    this._colonyFx(dt, 1);
    this._trackFx();

    this.ctx.shake.rumble(settings.locusttide.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.locusttide;
    const g = settings.global;
    const time = frame.uTime.value;

    this.colony.shapeCentre(_pos);
    this.pointAt(1, _ground);

    /* the dust the spear drives out of the floor */
    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.7,
      intensity: c.burstIntensity,
      opacity: 0.9,
      fresnel: 1.3,
      displace: 0.8,
      squash: 0.85,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring of chaff blown out across the ground */
    this.ctx.decals.spawn(DecalType.DUSTRING, _ground, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.9,
      width: 0.07,
      intensity: 0.8,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB),
      height: 0.02
    });

    /* and the stubble it throws up */
    _emit.position = _ground;
    _emit.radius = c.rutWidth * 1.6;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.25).setY(1).normalize();
    _emit.speed = c.chaffSpeed * 2.4;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.13;
    _emit.sizeVariance = 0.8;
    _emit.life = c.chaffLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = c.chaffSpin * 1.5;
    _emit.tint = null;
    _emit.time = time;
    this.chaff.emit(Math.round(c.burstChaff * g.particleCount), _emit);

    _emit.position = _pos;
    _emit.radius = this._massRadius(1);
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.glintSpeed * 3.2;
    _emit.spread = 1.0;
    _emit.size = 0.09;
    _emit.life = c.glintLifetime * 1.3;
    _emit.spin = 0;
    this.glints.emit(Math.round(c.burstGlints * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      20
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.1 * g.explosionIntensity;
  }

  onFade(dt, t) {
    this._beat = t;
    // 1 through the hold, easing to 0 through the blow-out. Cubic, so the last
    // of the colony hangs on and then goes rather than dimming evenly.
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
    this._sync(fade);

    this.colony.shapeCentre(this.position);

    // Thinned as it dies, but never cut dead: a colony coming apart is still
    // shedding until the last agent winks out.
    this._colonyFx(dt, fade * (t <= 1 ? 0.7 : 0.3));
  }

  onDestroy() {
    this._live = 0;
    this._beat = 0;
    this._markCount = 0;
    for (let i = 0; i < TRACK_MARKS; i++) this._markSlots[i] = null;
    this.colony.reset();
    this.track.clearMarks();
    this.track.setVisible(false);
  }

  dispose() {
    this.colony.dispose();
    this.track.dispose();
    super.dispose();
  }
}
