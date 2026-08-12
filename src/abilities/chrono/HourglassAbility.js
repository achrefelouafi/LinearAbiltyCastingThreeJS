import { Quaternion, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { VolumeHull, HullShape, Medium } from '../../vfx/VolumeHull.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { sceneHooks, Hook } from '../../vfx/SceneHooks.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, Easing, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/**
 * Smallest value the shared app clock is allowed to be when it appears in a
 * denominator. See `_syncHulls()`: the volumes' advection is authored as a
 * *displacement* and divided by the clock, and the clock is zero on the frame
 * the app boots and on the first frame of the headless harness.
 */
const CLOCK_FLOOR = 0.01;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _waist = new Vector3();
const _apex = new Vector3();
const _floor = new Vector3();
const _ground = groundFieldParams();

/** The two cone orientations. Built once; neither ever changes. */
const _zAxis = new Vector3(0, 0, 1);
const _qUp = new Quaternion().setFromUnitVectors(_zAxis, new Vector3(0, 1, 0));
const _qDown = new Quaternion().setFromUnitVectors(_zAxis, new Vector3(0, -1, 0));

/** The run's three windows in seconds, refilled per call. */
const _win = { drain: 0, stall: 0, rise: 0, total: 0 };

/**
 * HOURGLASS — sand falls into a cone, and then it falls up.
 *
 * Two raymarched cones of `Medium.SAND` stand apex to apex over the aimed
 * circle. The bulb above the neck drains; the heap below it grows on its own
 * angle of repose; the zone goes weightless for a beat you can see coming; and
 * then the same sand climbs back into the same bulb.
 *
 * ## THE TRICK — one sign, published, read back
 *
 * There is exactly one signed number in this ability. `flow` is unitless and
 * lives on `this._b`: +1 while the glass runs down, easing through zero across
 * `stallTime`, −1 while it runs back up. It is not used directly by anything
 * that draws. It is multiplied by `gravityInside` and written into
 * **`Hook.GRAVITY`**, `sceneHooks.apply()` publishes it, and every consumer
 * then asks `sceneHooks.gravityAt()` for the multiplier at the neck.
 *
 * The round trip is the point and it is not ceremony. Going through the
 * published field means (a) the grains, the two volumes and the dust cannot
 * disagree about which way is down, because they are all reading one uniform
 * block rather than four copies of a local; (b) anything else in the app that
 * has opted into `gravityGLSL` — a shader that has never heard of this ability
 * — falls upward inside the zone for free; and (c) the CPU mirror
 * (`gravityAt`) and the GLSL (`gravityScaleAt`) are the same smoothstep, so a
 * particle system integrating on the CPU and a shader integrating on the GPU
 * agree at the wall of the well. Reading the local variable instead would look
 * identical today and be wrong the first time somebody else's material joins in.
 *
 * ## Why the grains genuinely reverse, and why the stall is load-bearing
 *
 * `ParticleSystem`'s vertex shader is closed form in the particle's own age:
 * `start + v·travel(age) + ½·g·age²`. Nothing has been integrated, so nothing
 * has spent the old gravity — change `uGravity` and a grain half way down the
 * neck re-flies its whole arc and climbs back out of it. That is the shot.
 *
 * It is also why the stall is not decoration. Position is a *function* of `g`,
 * so a `g` that jumps teleports every live grain. Easing `flow` through zero
 * makes the quadratic term pass through exactly zero, and at that instant every
 * grain is sitting on its own ballistic path with nothing to jump from. The
 * telegraph and the safety are the same curve; wind `stallTime` down to 0.02
 * and you can watch a thousand grains snap.
 *
 * ## The volumes: a displacement, not a rate
 *
 * The first version flipped the two hulls the obvious way — multiply
 * `uJet`/`uRise` by the sign after `sync()` — and it does not work, in a way
 * that is worth writing down because three modules in the library share the
 * hazard. `VolumeHull` offsets its noise domain by `rate × frame.uTime`, and
 * `frame.uTime` is the **app** clock, not the cast's. Changing the rate by Δv
 * therefore moves the field by `t·Δv` on that one frame: five minutes into a
 * session that is several hundred metres of domain, and the sand does not
 * reverse, it re-scrambles. Easing the rate through zero does not help, because
 * the offending term is `t·dv/dt` and `t` is enormous.
 *
 * So the ability integrates `flow` itself — `_b.travel`, closed form, in
 * seconds — and hands the hull `displacement / clock`, which the shader
 * multiplies straight back by the clock. What the volume sees is a metre count
 * that is continuous in the beat and re-resolves from the sliders on a paused
 * frame like everything else. The sand in the column visibly streams down,
 * stops, and streams back up.
 *
 * The floor is the one consumer that does **not** flip, for the same reason
 * without the fix: `GroundField`'s scour spiral turns on `uTime × uSpeed`, and
 * a spiral is not worth a second closed-form integral. It keeps one rate all
 * cast. Nobody has ever noticed which way the grooves were cut; everybody
 * notices a floor that snaps ninety degrees.
 *
 * ## What a cast captures
 *
 * Three things, all of them events: `_seed` (so two glasses do not draw the
 * same grain), `_travelSeconds` (the timestamp the front landed, which is what
 * keeps the flow integral continuous across the phase change), and two
 * fired-yet flags for the telegraph and the turn. Every metre, radian and
 * second — the neck height, the repose angle, the well radius, the grain
 * gravity, all three durations — is resolved from `settings.hourglass` inside
 * the update loop, zero-length frames included. Pause with **P** at the top of
 * the stall and drag `reposeAngle`: the heap re-slopes under a stopped clock.
 */
export class HourglassAbility extends Ability {
  constructor(context) {
    super('hourglass', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * The falling column. A CONE with its apex at the neck and its mouth above
     * it — which is the shape a conical bulb of sand actually is, and the
     * reason it can empty by shrinking rather than by fading: length and mouth
     * radius come down together and the silhouette stays a cone all the way.
     *
     * `maxSteps` is the compile-time loop cap, not the step count. `sandSteps`
     * drives the real one and stays a slider underneath it.
     */
    this.sand = new VolumeHull({
      hull: HullShape.CONE,
      medium: Medium.SAND,
      prefix: 'sand',
      maxSteps: 40,
      renderOrder: 12
    });
    // The cone's local +Z is its axis. Set once: the glass does not tumble, and
    // `place()` only ever writes position when no direction is handed to it.
    this.sand.mesh.quaternion.copy(_qUp);
    this.group.add(this.sand.mesh);

    /** The heap, apex up. Same medium, same palette family, half the march. */
    this.dune = new VolumeHull({
      hull: HullShape.CONE,
      medium: Medium.SAND,
      prefix: 'dune',
      maxSteps: 32,
      renderOrder: 11
    });
    this.dune.mesh.quaternion.copy(_qDown);
    this.group.add(this.dune.mesh);

    /** What the column cuts into the floor it is landing on. */
    this.scour = new GroundField(this.group, {
      mode: GroundMode.SCOUR,
      additive: false,
      name: 'Hourglass:scour'
    });
    this.scour.setVisible(false);

    /**
     * Park the gravity block where the harness's pause probe looks (I8, and
     * `SceneHooks#observe`). An ability whose output is partly a scene hook
     * owns no uniform for that half of itself, and would otherwise read as a
     * dead slider bank while it is inverting the world.
     */
    sceneHooks.observe(this.sand.material);

    /** Re-rolled per cast. A dice roll — the only kind of number a cast keeps. */
    this._seed = 0;
    /** Timestamp: `age` on the frame the front landed. Keeps the integral joined. */
    this._travelSeconds = 0;
    /** Fired-yet flags for the two one-shots. Events, not dimensions. */
    this._warned = false;
    this._turned = false;
    /** The live gravity token, or null between casts. */
    this._grav = null;
    /** The published multiplier read back at the neck. 1 when nothing is held. */
    this._gravity = 1;

    /**
     * The cast's beats, all unitless, refilled every frame. One object, reused.
     *
     *   seat    0..1  how much of the glass exists
     *   level   0..1  how much of the sand is in the heap
     *   flow   -1..1  signed rate — THE number
     *   travel  s     the signed integral of `flow`, in seconds
     *   turn    0..1  1 − |flow|; the weightless beat, which is the telegraph
     *   fade    1..0  master
     */
    this._b = { seat: 0, level: 0, flow: 1, travel: 0, turn: 0, fade: 1 };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The grains. Lit chips rather than additive motes: sand is matter, it
    // occludes, and it has to read as darker than the light behind it or the
    // column looks like a beam. These are the particles the trick is about.
    this.grains = particles.get('hourglass.grains', {
      capacity: 2400,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.2
    });
    this.grains.uniforms.uDrag.value = 0.35;
    this.grains.uniforms.uEndSize.value = 0.7;
    this.grains.uniforms.uSizeIn.value = 0.04;
    this.grains.uniforms.uFadeIn.value = 0.05;
    this.grains.uniforms.uFadeOut.value = 0.5;

    // The puff where the stream lands. Non-additive so it genuinely occludes
    // the heap behind it.
    this.dust = particles.get('hourglass.dust', {
      capacity: 1200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.9
    });
    this.dust.uniforms.uDrag.value = 1.9;
    this.dust.uniforms.uEndSize.value = 2.4;
    this.dust.uniforms.uSizeIn.value = 0.14;
    this.dust.uniforms.uFadeIn.value = 0.18;
    this.dust.uniforms.uFadeOut.value = 0.32;

    // The bone-amber time dust hanging around the glass. Additive, and the
    // cheapest way to make the weightless beat legible in empty air — when the
    // field turns, every mote in the shell stops and drifts back down.
    this.motes = particles.get('hourglass.motes', {
      capacity: 1600,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.5;
    this.motes.uniforms.uEndSize.value = 0.2;
    this.motes.uniforms.uSizeIn.value = 0.08;
    this.motes.uniforms.uFadeIn.value = 0.12;
    this.motes.uniforms.uFadeOut.value = 0.42;

    this.grainEmitter = new RateEmitter();
    this.dustEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** Nothing here is instanced: two raymarched hulls and one ground quad. */
  get instanceCount() {
    return 0;
  }

  /**
   * The three windows of the run, in seconds, resolved live.
   *
   * `impactDuration` and `_resolveBeats()` both read this so the phase machine
   * and the beat curve cannot drift apart when a duration slider moves under a
   * standing cast. The floors are the same in both for the same reason.
   */
  _windows() {
    const c = settings.hourglass;
    const life = Math.max(0.05, settings.global.lifetime);
    _win.drain = Math.max(0.02, c.drainTime) * life;
    _win.stall = Math.max(0.02, c.stallTime) * life;
    _win.rise = Math.max(0.02, c.riseTime) * life;
    _win.total = _win.drain + _win.stall + _win.rise;
    return _win;
  }

  /** Drain, stall and rise all live inside the impact phase. */
  get impactDuration() {
    return this._windows().total;
  }

  get fadeDuration() {
    return Math.max(0.05, settings.hourglass.settleTime);
  }

  /**
   * A glass does not gutter. It breathes, and it **swells** as the zone loses
   * its weight — which is the one channel that can say "something is about to
   * happen" while every silhouette on screen is still doing what it was doing.
   *
   * The breathing rate is deliberately a constant rather than something that
   * accelerates into the turn. `this.age` is a real clock, so a rate that moves
   * slews the phase by `age·Δrate` — the same hazard the class doc describes for
   * the volumes, in miniature. The swell carries the beat instead, and the swell
   * is a multiplier, which has no phase to slew.
   */
  lightShimmer() {
    const c = settings.hourglass;
    const breath = 0.5 - 0.5 * Math.cos(this.age * c.lightTickRate);
    return 1 + c.lightSwell * this._b.turn - c.lightFlicker * breath;
  }

  /* ------------------------------------------------------------------ */
  /* The beats — every one of them a closed form of the live durations    */
  /* ------------------------------------------------------------------ */

  /**
   * Refill `this._b`.
   *
   * `flow` is piecewise: +1 through the drain, `cos(π·k)` through the stall,
   * −1 from there on. The cosine is not a taste decision — it is the cheapest
   * curve that is C¹ at both ends *and* passes through zero at a single
   * identifiable instant, which is what the turn one-shot fires on and what
   * keeps the grains continuous.
   *
   * `travel` is its integral, in seconds, and it is what the volumes advect on.
   * The stall contributes exactly zero over its whole width (∫cos over a half
   * period), so the sand ends the stall having moved as far as it had at the
   * start of it — it hesitated, it did not creep.
   *
   * `level` is deliberately **not** that integral. Making the heap the integral
   * of the flow would tie `riseTime` to `drainTime` through the area under the
   * curve, and those two want to be independent: the fall is slow enough to be
   * boring and the climb is fast enough to be wrong, and that gap is the joke.
   * The two agree in *sign* by construction, which is the only thing the eye
   * checks.
   *
   * @param {number} t 0..1 through the impact phase, then 1..2 through the fade
   */
  _resolveBeats(t) {
    const c = settings.hourglass;
    const b = this._b;
    const w = this._windows();
    const seatSec = Math.max(0.02, c.seatTime) * Math.max(0.05, settings.global.lifetime);

    if (this.phase === AbilityPhase.TRAVEL) {
      // The glass is already pouring as it flies out — flow is +1 from the
      // first frame, so the integral is simply the age and joins the run's own
      // integral at the timestamp captured in `onImpact()`.
      b.seat = saturate(c.seedFill) * Easing.outQuad(this.u);
      b.level = 0;
      b.flow = 1;
      b.travel = this.age;
      b.turn = 0;
      b.fade = 1;
      return;
    }

    const s = t <= 1 ? saturate(t) * w.total : w.total + (t - 1) * this.fadeDuration;
    const afterStall = w.drain + w.stall;

    if (s <= w.drain) {
      b.flow = 1;
      b.travel = s;
      b.level = saturate(s / w.drain);
    } else if (s <= afterStall) {
      const k = (s - w.drain) / w.stall;
      b.flow = Math.cos(Math.PI * k);
      b.travel = w.drain + (w.stall / Math.PI) * Math.sin(Math.PI * k);
      b.level = 1;
    } else {
      b.flow = -1;
      b.travel = w.drain - (s - afterStall);
      b.level = saturate(1 - (s - afterStall) / w.rise);
    }

    // The travel-phase integral is carried across on a timestamp, so the
    // volumes' domains do not jump on the frame the front lands.
    b.travel += this._travelSeconds;
    b.turn = 1 - Math.abs(b.flow);
    b.seat = lerp(saturate(c.seedFill), 1, Easing.outCubic(saturate(s / seatSec)));
    b.fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
  }

  /* ------------------------------------------------------------------ */
  /* Geometry of the glass — every metre resolved from live settings      */
  /* ------------------------------------------------------------------ */

  /** The floor point under the glass. Rides the front while it travels. */
  _floorPoint(out) {
    const s = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    return this.pointAt(s, out);
  }

  /** Metres from the floor to the neck. Both cones are measured from here. */
  _waistY() {
    const c = settings.hourglass;
    return c.waistHeight * c.zoneRadius * this._b.seat;
  }

  /** The neck, in world space: the apex of both cones and the light's home. */
  _waistPoint(out) {
    this._floorPoint(out);
    out.y = this._waistY();
    return out;
  }

  /** The heap's apex — where the stream lands, and where it leaves from. */
  _pileApex(out) {
    this._floorPoint(out);
    out.y = this._pileHeight();
    return out;
  }

  /** Height of the heap, metres. At `level` 1 it reaches `pileFill` of the neck. */
  _pileHeight() {
    const c = settings.hourglass;
    return Math.max(0, this._waistY() * c.pileFill * saturate(this._b.level));
  }

  /**
   * Base radius of the heap, metres.
   *
   * A heap of dry granular material has one shape: a cone at its angle of
   * repose. Deriving the radius from the height rather than giving it a slider
   * of its own is what makes the pile *pile* — it widens as it grows, at a
   * fixed slope, and dragging `reposeAngle` re-slopes it under a paused clock.
   * The cap exists because a very shallow repose angle would otherwise put the
   * skirt outside the circle the indicator drew.
   */
  _pileRadius(height) {
    const c = settings.hourglass;
    const slope = Math.tan(clamp(c.reposeAngle, 5, 85) * DEG);
    return Math.min(height / Math.max(slope, 0.05), c.pileMax * c.zoneRadius);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.grainEmitter.reset();
    this.dustEmitter.reset();
    this.moteEmitter.reset();
    this._warned = false;
    this._turned = false;
    this._travelSeconds = 0;
    this._seed = Math.random() * 100;

    // The world, borrowed. `borrow()` is what gives it back on all four of the
    // ways a cast can end, three of which are not this ability's idea.
    this._grav = this.borrow(sceneHooks.acquire(Hook.GRAVITY, this));

    this.scour.setVisible(true);
    this.scour.clearMarks();

    this._resolveBeats(0);
    this._sync();
    this._castFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current beats into everything that draws.
   *
   * Order is load-bearing exactly once, and it is the first three lines: the
   * hook is written, the ledger is applied, and only then does anything read
   * the multiplier back. Swap the second and third and every consumer spends
   * the frame on the *previous* frame's gravity, which is invisible for the
   * whole cast except on the one frame that matters.
   */
  _sync() {
    this._waistPoint(_waist);
    /** The published multiplier at the neck, this frame. Read once, used by all. */
    this._gravity = this._syncGravity();

    this._syncHulls();
    this._syncScour();
    this._syncParticles(this._gravity);

    // The light lives at the neck, not on the floor line the base class walks.
    this.position.copy(_waist);
  }

  /**
   * Write the well, publish it, and read the multiplier back out of it.
   *
   * `sceneHooks.apply()` is idempotent — every hook blends from `settings`, not
   * from the live value — so calling it here and again from `App.frame` costs
   * one pass over six short arrays and changes nothing. It is called here for
   * two reasons: the read-back below needs the published block rather than the
   * token, and an ability whose effect is partly a hook is invisible to the
   * harness's pause probe until something has actually written the uniforms.
   *
   * @returns {number} the signed gravity multiplier at the neck; exactly 1 when
   *          nothing is held, so every caller can multiply unconditionally
   */
  _syncGravity() {
    const c = settings.hourglass;
    const b = this._b;

    if (this._grav) {
      this._grav
        .atPoint(_waist)
        .well(Math.max(0.05, c.gravityRadius * c.zoneRadius), clamp(c.gravityEdge, 0.01, 1))
        // The one sign in the ability. `gravityInside` is a magnitude; `flow`
        // is what turns it over.
        .scale(b.flow * c.gravityInside, c.gravityOutside)
        .blend(saturate(b.seat) * saturate(b.fade));
    }

    sceneHooks.apply();
    return sceneHooks.gravityAt(_waist.x, _waist.y, _waist.z);
  }

  /**
   * The two cones.
   *
   * Margin compensation, as in Pyroclasm and for the same reason: `Margin`
   * holds the medium's nominal surface that fraction of the way *inside* the
   * proxy, so a hull sized at the radius you want draws sand at
   * `radius × (1 − margin)`. Dividing here makes the numbers in the block mean
   * the size of the sand rather than the size of the box around it.
   *
   * `setSize`, never `mesh.scale` — the march's parameter is in world metres
   * only because the hull's matrix stays rigid.
   *
   * These two are the one pair that does **not** read the published field, and
   * the reason is arithmetic rather than principle: the hulls advect on the
   * *integral* of `flow`, and an instantaneous published multiplier cannot be
   * integrated in closed form. Accumulating it on the CPU instead would be
   * exactly the state invariant I1 forbids — a paused slider could not
   * re-resolve a sum that had already been spent. They share `flow`'s sign by
   * construction, which is what the eye is checking.
   */
  _syncHulls() {
    const c = settings.hourglass;
    const g = settings.global;
    const b = this._b;
    const radius = c.zoneRadius;

    /* --- the falling column: a cone that empties by shrinking --- */
    const open = lerp(1, saturate(c.bulbEmpty), saturate(b.level));
    const bulbR = Math.max(1e-3, c.bulbRadius * radius * b.seat * open);
    const bulbL = Math.max(1e-3, c.bulbHeight * radius * b.seat * open);
    const kSand = Math.max(1, c.hullSlack) / Math.max(0.2, 1 - c.sandMargin);

    this.sand
      .place(_waist)
      .setSize(bulbR * kSand, bulbR * kSand, bulbL * kSand)
      .setFade(b.fade * saturate(b.seat))
      .sync(c, g);

    /* --- the heap: a cone that grows on its own angle of repose --- */
    const pileH = this._pileHeight();
    const pileR = this._pileRadius(pileH);
    const kDune = Math.max(1, c.hullSlack) / Math.max(0.2, 1 - c.duneMargin);
    _apex.set(_waist.x, Math.max(1e-3, pileH), _waist.z);

    this.dune
      .place(_apex)
      .setSize(Math.max(1e-3, pileR) * kDune, Math.max(1e-3, pileR) * kDune, Math.max(1e-3, pileH) * kDune)
      // A heap with nothing in it is not a very small heap, it is no heap.
      .setFade(b.fade * saturate(b.level * 8))
      .sync(c, g);

    /* --- the advection, as a displacement. See the class doc. --- */
    // What the shader computes is `rate × frame.uTime`, so the rate handed over
    // is the metres we want divided by the clock those metres will be
    // multiplied by. Continuous in the beat, and re-resolved from the sliders
    // on a zero-length frame like everything else.
    const clock = Math.max(frame.uTime.value, CLOCK_FLOOR);
    const carry = (b.travel * g.noiseSpeed) / clock;
    const su = this.sand.material.uniforms;
    // The column's local +Z points up, so a downward stream is a negative jet.
    su.uJet.value = -c.streamJet * carry;
    su.uRise.value = -c.streamFall * carry;
    const du = this.dune.material.uniforms;
    // The heap's local +Z points down, so settling *is* the positive direction.
    du.uJet.value = c.settleJet * carry;
    du.uRise.value = -c.settleFall * carry;
  }

  /** The drift the column cuts into the floor. */
  _syncScour() {
    const c = settings.hourglass;
    const g = settings.global;
    const b = this._b;

    _ground.centre = this._floorPoint(_floor);
    _ground.yaw = 0;
    _ground.height = c.scourHeight;
    _ground.radius = Math.max(0.1, c.scourSpread * c.zoneRadius);
    _ground.grow = Easing.outCubic(saturate(b.seat));
    _ground.recede = Easing.inQuad(saturate(1 - b.fade));
    _ground.fade = b.fade;
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
    _ground.arms = c.scourArms;
    _ground.swirl = c.scourSwirl;
    _ground.sharp = c.scourSharp;
    _ground.detail = c.scourDetail;
    // One rate, all cast — the spiral turns on the shared clock and a rate that
    // moves mid-cast snaps the whole pattern. See the class doc.
    _ground.speed = c.scourTurn;

    _ground.additive = false;
    // The floor is the third thing that says the turn is coming: the grooves
    // light up as the zone loses its weight.
    _ground.emissive = c.scourEmissive * lerp(1, c.scourTurnGlow, saturate(b.turn));
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
  }

  /**
   * The three particle systems.
   *
   * All three gravities are the published multiplier times the system's own
   * authored acceleration, which is exactly what `gravityGLSL` promises on the
   * GPU side: the hook hands out a *scale*, never a replacement vector, so the
   * grain's −13.5 m/s² stays the grain's slider and the zone only decides which
   * way it points.
   */
  _syncParticles(gravity) {
    const c = settings.hourglass;
    const g = settings.global;

    this.grains.setGradient(
      getColor(c.colorGrainA),
      getColor(c.colorGrainB),
      getColor(c.colorGrainC),
      getColor(c.colorGrainD)
    );
    this.grains.uniforms.uGravity.value.set(0, c.grainGravity * gravity, 0);
    this.grains.uniforms.uSizeScale.value = c.grainSize * g.particleSize * 7;
    this.grains.uniforms.uLifeScale.value = c.grainLifetime * 0.5 * g.particleLifetime;
    this.grains.uniforms.uSpeedScale.value = g.particleSpeed;
    this.grains.uniforms.uOpacity.value = g.opacity;

    this.dust.setGradient(
      getColor(c.colorDustA),
      getColor(c.colorDustB),
      getColor(c.colorDustC),
      getColor(c.colorDustD)
    );
    this.dust.uniforms.uGravity.value.set(0, c.dustRise * gravity, 0);
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize;
    this.dust.uniforms.uLifeScale.value = c.dustLifetime * 0.5 * g.particleLifetime;
    this.dust.uniforms.uSpeedScale.value = c.dustSpeed * g.particleSpeed;
    this.dust.uniforms.uOpacity.value = c.dustOpacity * g.opacity;
    this.dust.uniforms.uTurbulence.value = c.dustTurbulence * g.turbulence;

    this.motes.setGradient(
      getColor(c.colorMoteA),
      getColor(c.colorMoteB),
      getColor(c.colorMoteC),
      getColor(c.colorMoteD)
    );
    this.motes.uniforms.uGravity.value.set(0, c.moteRise * gravity, 0);
    this.motes.uniforms.uSizeScale.value = c.moteSize * g.particleSize * 7;
    this.motes.uniforms.uLifeScale.value = c.moteLifetime * 0.5 * g.particleLifetime;
    this.motes.uniforms.uSpeedScale.value = g.particleSpeed;
    this.motes.uniforms.uOpacity.value = g.opacity;
    this.motes.uniforms.uGlow.value = c.moteGlow * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;
  }

  /** The seed leaving the caster's hand. */
  _castFx() {
    const c = settings.hourglass;
    const g = settings.global;

    _pos
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .setY(c.handHeight);

    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.seatBurstSize * 0.3,
      endRadius: c.seatBurstSize * 0.6 * g.explosionIntensity,
      life: 0.3,
      intensity: c.seatBurstIntensity * 0.7,
      opacity: 0.75,
      fresnel: 1.8,
      displace: 0.4,
      colorA: getColor(c.colorSeatA),
      colorB: getColor(c.colorSeatB),
      colorC: getColor(c.colorSeatC)
    });

    this.lightBoost = c.lightIntensity * 0.3 * g.explosionIntensity;
  }

  /**
   * Grains through the throat, dust where they land, motes in the shell.
   *
   * Which end is the source is decided by the *published* multiplier, not by
   * the local beat: falling sand is born at the neck and lands on the heap,
   * rising sand is born off the heap and lands at the neck. Everything else
   * about the emission is identical, which is the whole point — the same throat
   * running the other way.
   *
   * @param {number} scale 0..1, thinned once the glass is only holding
   */
  _glassFx(dt, scale, gravity) {
    const c = settings.hourglass;
    const g = settings.global;
    const time = frame.uTime.value;
    const b = this._b;
    // No sand moves at the top of the stall, so nothing is emitted there — and
    // that hole in the emission is a large part of why the beat reads.
    const rate = Math.abs(b.flow) * scale;
    const falling = gravity >= 0;

    this._waistPoint(_waist);
    this._pileApex(_apex);
    const source = falling ? _waist : _apex;
    const sink = falling ? _apex : _waist;

    const grainCount = Math.round(this.grainEmitter.tick(dt, c.grainRate * rate) * g.particleCount);
    if (grainCount > 0) {
      _emit.position = source;
      _emit.radius = c.neckRadius;
      _emit.anchor = null;
      _emit.direction = _dir.set(0, falling ? -1 : 1, 0);
      _emit.speed = c.grainSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = c.grainSpread;
      _emit.inherit = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.grainLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = c.grainSpin;
      _emit.tint = null;
      _emit.time = time;
      this.grains.emit(grainCount, _emit);
    }

    const dustCount = Math.round(this.dustEmitter.tick(dt, c.dustRate * rate) * g.particleCount);
    if (dustCount > 0) {
      _pos.copy(sink);
      _emit.position = _pos;
      _emit.radius = c.dustSpread;
      _emit.anchor = null;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.95;
      _emit.inherit = null;
      _emit.size = 0.7;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.35;
      _emit.spin = 0.35;
      _emit.tint = null;
      _emit.time = time;
      this.dust.emit(dustCount, _emit);
    }

    // The motes do not care which way the sand is going; they hang in the shell
    // and are turned over by the same published field the grains read.
    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      const bearing = Math.random() * TAU;
      const shell = c.bulbRadius * c.zoneRadius * c.moteShell * randRange(0.55, 1.1);
      _pos.copy(_waist);
      _pos.x += Math.cos(bearing) * shell;
      _pos.z += Math.sin(bearing) * shell;
      _pos.y = randRange(0.1, Math.max(0.2, _waist.y + c.bulbHeight * c.zoneRadius));

      _emit.position = _pos;
      _emit.radius = 0.25;
      _emit.anchor = null;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 1;
      _emit.inherit = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._resolveBeats(0);
    this._sync();
    this._glassFx(dt, saturate(this._b.seat), this._gravity);
  }

  /** The glass lands and stands up. */
  onImpact() {
    const c = settings.hourglass;
    const g = settings.global;

    // A timestamp, and the only reason one is captured: the flow integral has
    // to carry across the phase change or the volumes' noise domain jumps by
    // however long the front was in the air.
    this._travelSeconds = this.age;

    this._resolveBeats(0);
    this._waistPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.seatBurstSize * 0.25,
      endRadius: c.seatBurstSize * g.explosionIntensity,
      life: 0.5,
      intensity: c.seatBurstIntensity,
      opacity: 0.85,
      fresnel: 1.7,
      displace: 0.45,
      squash: 0.8,
      colorA: getColor(c.colorSeatA),
      colorB: getColor(c.colorSeatB),
      colorC: getColor(c.colorSeatC)
    });

    this._floorPoint(_pos);
    this.ctx.decals.spawn(DecalType.DUSTRING, _pos, {
      radius: c.scourSpread * c.zoneRadius * g.explosionIntensity,
      life: 1.1,
      intensity: 0.9,
      colorA: getColor(c.colorScourBase),
      colorB: getColor(c.colorScourEdge)
    });

    this.ctx.shake.add(
      c.seatShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      20
    );
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  onFade(dt, t) {
    this._resolveBeats(t);
    const b = this._b;

    // The telegraph: fired on the way *into* the weightless beat, at a fraction
    // of the envelope rather than at a wall-clock offset, so re-timing the
    // stall re-times the warning with it.
    if (!this._warned && b.turn >= saturate(settings.hourglass.warnAt)) {
      this._warned = true;
      this._warnFx();
    }
    // The turn: the frame the sign changes. A flag, not a timestamp — the beats
    // already know where in the phase we are.
    if (!this._turned && b.flow < 0) {
      this._turned = true;
      this._turnFx();
    }

    this._sync();
    this._glassFx(dt, t <= 1 ? 1 : b.fade, this._gravity);

    if (t <= 1) {
      this.ctx.shake.rumble(settings.hourglass.rumble * settings.global.cameraShake, dt);
    }
  }

  /** The telegraph — the zone announces that it is about to change its mind. */
  _warnFx() {
    const c = settings.hourglass;
    const g = settings.global;

    this._waistPoint(_pos);
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.warnBurstSize * 0.15,
      endRadius: c.warnBurstSize * g.explosionIntensity,
      life: 0.75,
      intensity: c.warnBurstIntensity,
      opacity: 0.7,
      fresnel: 2.4,
      displace: 0.25,
      colorA: getColor(c.colorWarnA),
      colorB: getColor(c.colorWarnB),
      colorC: getColor(c.colorWarnC)
    });

    this._floorPoint(_pos);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.warnRingRadius * g.explosionIntensity,
      life: 0.9,
      width: 0.04,
      intensity: c.warnRingIntensity,
      colorA: getColor(c.colorRingA),
      colorB: getColor(c.colorRingB)
    });

    this.ctx.flash.trigger(getColor(c.colorWarnFlash), c.warnFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.4 * g.explosionIntensity;
  }

  /** The turn — the sand lets go of the floor. */
  _turnFx() {
    const c = settings.hourglass;
    const g = settings.global;
    const time = frame.uTime.value;

    this._waistPoint(_pos);
    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.turnBurstSize * 0.2,
      endRadius: c.turnBurstSize * g.explosionIntensity,
      life: 0.85,
      intensity: c.turnBurstIntensity,
      opacity: 0.9,
      fresnel: 1.6,
      displace: 0.55,
      squash: 0.85,
      colorA: getColor(c.colorTurnA),
      colorB: getColor(c.colorTurnB),
      colorC: getColor(c.colorTurnC)
    });

    // The heap coming off the floor all at once. Emitted with an *upward*
    // direction and no gravity of its own — the published field, which has just
    // changed sign, is what carries them up.
    this._pileApex(_pos);
    _pos.y = Math.max(0.05, _pos.y * 0.4);
    _emit.position = _pos;
    _emit.radius = Math.max(0.2, this._pileRadius(this._pileHeight()) * 0.9);
    _emit.anchor = null;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.grainSpeed * 2.2;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.85;
    _emit.inherit = null;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.75;
    _emit.life = c.grainLifetime * 1.6;
    _emit.lifeVariance = 0.5;
    _emit.spin = c.grainSpin * 1.4;
    _emit.tint = null;
    _emit.time = time;
    this.grains.emit(Math.round(c.grainBurst * g.particleCount), _emit);

    this._floorPoint(_pos);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.turnRingRadius * g.explosionIntensity,
      life: 0.7,
      width: 0.05,
      intensity: c.turnRingIntensity,
      colorA: getColor(c.colorRingA),
      colorB: getColor(c.colorRingB)
    });

    this.ctx.shake.add(
      c.turnShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      26
    );
    this.ctx.flash.trigger(getColor(c.colorTurnFlash), c.turnFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.2 * g.explosionIntensity;
  }

  onDestroy() {
    // The hook itself is given back by the base class through `borrow()`, on
    // every path a cast can end by; dropping the reference here just stops this
    // instance writing to a token it no longer owns if it is re-pooled.
    this._grav = null;
    this._warned = false;
    this._turned = false;
    this._travelSeconds = 0;
    this.sand.setFade(0);
    this.dune.setFade(0);
    this.scour.setVisible(false);
    this.scour.clearMarks();
  }

  dispose() {
    this.sand.dispose();
    this.dune.dispose();
    this.scour.dispose();
    super.dispose();
  }
}
