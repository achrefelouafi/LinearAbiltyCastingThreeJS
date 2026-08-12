import { Color, InstancedBufferAttribute, InstancedMesh, Object3D, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import {
  HardShape,
  HardAxis,
  BrushMode,
  ShapeCache,
  pistonShape,
  plateShape,
  createHardSurfaceMaterial,
  hardSurfaceParams,
  blackbodyColor,
  heatToKelvin
} from '../../vfx/HardSurface.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, Easing } from '../../utils/math.js';

const TAU = Math.PI * 2;

/**
 * Hard ceiling on stations. The `pistonCount` slider clamps here, and the
 * `GroundField`'s mark ring is sized to match: one port per station, and the
 * `POCK` fragment loops over every slot, so this is a fill cost as much as a
 * draw-call one.
 */
const MAX_PISTONS = 16;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _station = new Vector3();
const _crown = new Vector3();
const _dummy = new Object3D();
const _tint = new Color();
const _bb = new Color();

/** Live param bags, filled from `settings.pistondrive` every frame. */
const _hard = hardSurfaceParams();
const _ground = groundFieldParams();

/** The two shapes. Unitless proportions only — refilled, never captured. */
const _piston = pistonShape({ axis: HardAxis.Y });
const _deck = plateShape({ axis: HardAxis.Y });

/** One sample of the cam: where the follower is, and how hot the work made it. */
const _cam = { lift: 0, heat: 0 };

/**
 * PISTON DRIVE — a battery of machined rams bolted into the aimed line.
 *
 * An arming front runs down the lane and twelve hydraulic pistons come live
 * behind it, each one rising through its own bolted deck plate. Then they
 * work: dwell, slam, hold, ring, drop, and again, with the strike travelling
 * down the row as a wave. When the drive stops they withdraw flush and what is
 * left is a line of ports punched into the floor.
 *
 * ## THE TRICK — a real cam curve, exposed as control points
 *
 * The roster line for this slot is a warning as much as a brief: *smooth
 * easing makes them read as rising rock and kills the ability*. That is not a
 * matter of taste, and it is worth being precise about why, because the first
 * version of this file did exactly the wrong thing and looked exactly as
 * predicted.
 *
 * The obvious implementation is `GrowthField` with a `PUSH` emergence: an
 * eruption clock per instance, a rise time, an overshoot, a settle. Every
 * ability in the stone school is built that way and they are all correct. Run
 * a piston through it and you get a chrome-plated boulder. The reason is that
 * a rise-and-settle curve spends *all* of its time moving — its displacement
 * has support everywhere — and a machine's does not. A cam follower spends
 * most of a turn doing **nothing at all**, and the nothing is what makes the
 * something read as mechanical.
 *
 * So the motion here is a genuine dwell–rise–dwell–return cam, specified the
 * way a cam is specified in a machine shop: as four **angular shares of one
 * shaft turn** (`camLow`, `camRise`, `camHigh`, `camFall`), normalised at use
 * so each one is an independent slider, plus a motion law inside each moving
 * segment. Ship values give the rise 47° of a 360° turn — thirteen per cent of
 * the cycle spent moving up, against forty per cent spent doing nothing at all
 * at the bottom. See `camRise` in the settings block for why it is not the 22°
 * a real pneumatic ram would want.
 *
 * ```
 *   lift
 *    1 |            ╭────────────╮
 *      |           ╱              ╲
 *    0 |─────────╯                  ╰──────
 *      └──────────┴──┴──────────────┴──┴───→  one shaft turn
 *         camLow  camRise   camHigh   camFall
 * ```
 *
 * `camSnap` and `camDrop` blend between two textbook cam laws rather than
 * between two ad-hoc eases, and both were chosen because they satisfy the
 * boundary conditions a real follower needs — zero velocity at both ends of a
 * segment, so the follower never leaves the cam and the join to the dwell is
 * silent:
 *
 *  - **cycloidal**, `s = τ − sin(2πτ)/2π`, the jerk-free law. Continuous
 *    acceleration, and at `camSnap = 0` the row is unmistakably being politely
 *    raised.
 *  - **constant acceleration**, the parabolic law, `2τ²` then `1 − 2(1−τ)²`.
 *    Its acceleration steps at the midpoint, which is a discontinuity you can
 *    genuinely see, and it is what makes the thing hit.
 *
 * On top of the rise sits `camRing`: a damped overshoot in **seconds**, not in
 * shaft angle, because a follower on a return spring rings at its own natural
 * frequency and does not care how fast the shaft is turning. Folding it into
 * `camHigh` was the second version and it was subtly wrong in a way that only
 * shows when you drag `camRate` — the ring sped up with the shaft, which no
 * spring does.
 *
 * ### One shaft, twelve keyings
 *
 * The sequence down the line is **a phase offset on the same curve**, which is
 * both the brief and the truthful mechanism: this is one camshaft with twelve
 * lobes keyed `camStagger` turns apart. So `phase_i = camRate·age −
 * i·camStagger + camPhase`, and there is no per-station clock anywhere in the
 * file. Set `camStagger` to 0 and all twelve fire together; set it to
 * `1/count` and exactly one station is up at any moment and the wave runs
 * clean off the end.
 *
 * ### The heat is on the cam too
 *
 * A station's heat is not a timer. `_camSample` returns lift *and* heat from
 * the same shaft angle: zero through the low dwell, up across the rise, then
 * bleeding off on a real exponential in seconds through the hold and the
 * return. It reaches the material as `aHeat`, the per-instance **offset** the
 * `HardSurface` material adds to `uHeat` — which is why the attribute is an
 * offset rather than an absolute, and why the deck plates, which have no such
 * attribute, sit at their own cold value without anybody arranging it.
 *
 * ## What is on screen
 *
 * Six draw calls: one `InstancedMesh` of pistons, one of deck plates, a
 * `GroundField(POCK)` for the ports, and three particle systems. Both meshes
 * share one `ShapeCache` and each has its own patched `MeshStandardMaterial`,
 * so the pistons can run at forging heat while the deck stays cold.
 *
 * ## The rule that makes the editor work
 *
 * A cast captures three things and none of them is a dimension: `_seed`,
 * `_dice` (two unitless rolls per station, so a machine is nearly but not
 * quite uniform), and `_up`, a bitfield of which stations are currently above
 * the strike threshold — an event record, exactly like `Projectile#arrivals`,
 * and re-derived from the live cam every frame rather than remembered. Pause
 * mid-drive and drag `camRise`: the whole row re-poses on the new curve, and
 * stations whose phase has moved across the threshold fire their strike again,
 * which is the behaviour a live editor should have.
 */
export class PistondriveAbility extends Ability {
  constructor(context) {
    super('pistondrive', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const environment = this.ctx.environment;

    /** Both shapes, one cache. Ours alone — see `ShapeCache`'s doc comment. */
    this.cache = new ShapeCache({ capacity: 4 });

    /* --- the pistons: one InstancedMesh, one draw call --- */
    this.metal = createHardSurfaceMaterial({ environment });
    /**
     * Per-station heat, as the **offset** the material adds to `uHeat`.
     *
     * It has to be re-attached after every geometry rebuild, because the cache
     * hands back a whole new `BufferGeometry` when a shape slider moves and the
     * attribute does not come with it. Cheap: one map write and a dirty flag.
     */
    this.heatAttr = new InstancedBufferAttribute(new Float32Array(MAX_PISTONS), 1);
    this.pistons = new InstancedMesh(
      this.cache.get(0, HardShape.PISTON, this._pistonShape()),
      this.metal,
      MAX_PISTONS
    );
    this.pistons.count = 0;
    this.pistons.frustumCulled = false;
    this.pistons.receiveShadow = true;
    this.pistons.layers.set(LAYER.WORLD);
    this.pistons.renderOrder = 2;
    this.group.add(this.pistons);

    /* --- the deck plates each one comes up through --- */
    this.deckMetal = createHardSurfaceMaterial({ environment });
    this.decks = new InstancedMesh(
      this.cache.get(1, HardShape.PLATE, this._deckShape()),
      this.deckMetal,
      MAX_PISTONS
    );
    this.decks.count = 0;
    this.decks.frustumCulled = false;
    this.decks.receiveShadow = true;
    this.decks.layers.set(LAYER.WORLD);
    this.decks.renderOrder = 2;
    this.group.add(this.decks);

    /* --- the ports punched in the floor --- */
    this.ports = new GroundField(this.group, {
      mode: GroundMode.POCK,
      marks: MAX_PISTONS,
      additive: false,
      name: 'Pistondrive:ports'
    });
    this.ports.setVisible(false);

    /** Two unitless rolls per station: a general seed and a size jitter. */
    this._dice = new Float32Array(MAX_PISTONS * 2);
    /** Which stations are above the strike threshold. An event record. */
    this._up = new Uint8Array(MAX_PISTONS);
    /** How many stations have had their port posted. A cursor. */
    this._ported = 0;
    /** The station that struck most recently, so the light has somewhere to be. */
    this._lastStrike = 0;
    this._seed = 0;

    /**
     * The cast's beats, unitless, refilled every frame.
     *
     *   arm   0..1  how far the arming front has run
     *   drive 0..1  master on the cam's amplitude — 1 while working, 0 withdrawn
     *   fade  1..0  master on the ports
     */
    this._b = { arm: 0, drive: 0, fade: 1 };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Dust punched out of a port. Non-additive: it has to occlude the piston
    // behind it, which is most of what sells the row having depth.
    this.dust = particles.get('pistondrive.dust', {
      capacity: 1600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.dust.uniforms.uDrag.value = 2.0;
    this.dust.uniforms.uEndSize.value = 2.8;
    this.dust.uniforms.uSizeIn.value = 0.1;
    this.dust.uniforms.uFadeIn.value = 0.12;
    this.dust.uniforms.uFadeOut.value = 0.35;

    // Floor broken out round the port.
    this.chips = particles.get('pistondrive.chips', {
      capacity: 1200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.chips.uniforms.uDrag.value = 0.3;
    this.chips.uniforms.uEndSize.value = 0.75;
    this.chips.uniforms.uFadeOut.value = 0.6;

    // Sheared off the lip as the head punches through it.
    this.sparks = particles.get('pistondrive.sparks', {
      capacity: 1400,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.3;
    this.sparks.uniforms.uEndSize.value = 0.2;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.02;
    this.sparks.uniforms.uFadeOut.value = 0.45;

    this.ventEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.pistons.count + this.decks.count;
  }

  /** The battery cycles for `lifetime`, then withdraws over `fadeTime`. */
  get impactDuration() {
    return Math.max(0.05, settings.pistondrive.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.pistondrive.fadeTime);
  }

  /**
   * The light pulses on the shaft, not on a noise field.
   *
   * A machine's light is periodic because the machine is. `lightPulseRate` is
   * its own slider rather than being wired to `camRate` — they usually want to
   * be the same number and occasionally very much do not, and a derived value
   * gives you no way to say so.
   */
  lightShimmer() {
    const c = settings.pistondrive;
    const phase = this.age * c.lightPulseRate;
    return 1 - saturate(c.lightPulse) * (0.5 - 0.5 * Math.cos(TAU * phase));
  }

  /* ------------------------------------------------------------------ */
  /* Shapes — proportions, refilled from the block every frame            */
  /* ------------------------------------------------------------------ */

  _pistonShape() {
    const c = settings.pistondrive;
    _piston.length = c.pistonLength;
    _piston.segments = Math.max(6, Math.round(c.pistonSegments));
    _piston.baseRadius = c.baseRadius;
    _piston.baseHeight = c.baseHeight;
    _piston.baseChamfer = c.baseChamfer;
    _piston.rodRadius = c.rodRadius;
    _piston.collarAt = c.collarAt;
    _piston.collarRadius = c.collarRadius;
    _piston.collarHeight = c.collarHeight;
    _piston.collarChamfer = c.collarChamfer;
    _piston.headAt = c.headAt;
    _piston.headRadius = c.headRadius;
    _piston.headChamfer = c.headChamfer;
    _piston.rings = Math.max(0, Math.round(c.rings));
    _piston.ringDepth = c.ringDepth;
    _piston.ringHeight = c.ringHeight;
    _piston.faceRecess = c.faceRecess;
    _piston.creaseAngle = c.pistonCrease;
    return _piston;
  }

  _deckShape() {
    const c = settings.pistondrive;
    _deck.width = c.deckWidth;
    _deck.depth = c.deckDepth;
    _deck.thickness = c.deckThickness;
    _deck.corner = c.deckCorner;
    _deck.bevel = c.deckBevel;
    _deck.bolts = Math.max(0, Math.round(c.deckBolts));
    _deck.boltRadius = c.deckBoltRadius;
    _deck.boltInset = c.deckBoltInset;
    _deck.counterSink = c.deckSink;
    return _deck;
  }

  /* ------------------------------------------------------------------ */
  /* THE CAM                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * One cam motion law, blended.
   *
   * @param {number} x    0..1 through the segment
   * @param {number} hard 0 cycloidal (jerk-free) … 1 constant acceleration
   * @returns {number} displacement, 0..1, with zero velocity at both ends
   */
  _camLaw(x, hard) {
    const t = saturate(x);
    // Cycloidal: s = τ − sin(2πτ)/2π. Continuous acceleration everywhere,
    // which is why every high-speed cam in the world uses it and why it is
    // useless here on its own.
    const cyc = t - Math.sin(TAU * t) / TAU;
    // Constant acceleration: two parabolas meeting at the midpoint. The
    // acceleration steps there, and the step is the hit.
    const par = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    return lerp(cyc, par, saturate(hard));
  }

  /**
   * Sample the cam at shaft angle `phase`, in turns.
   *
   * Fills `_cam` with the follower's displacement (0..1, and above 1 while it
   * is ringing) and the heat the stroke put into the station (0..1). Both come
   * off the same four control points, which is the point: there is no second
   * curve anywhere in this file that could drift out of step with the first.
   *
   * The four shares are normalised here rather than in the block so that each
   * one stays an independent slider — raising `camRise` on its own squeezes
   * the other three rather than requiring three compensating drags.
   */
  _camSample(phase) {
    const c = settings.pistondrive;

    const low = Math.max(0, c.camLow);
    const rise = Math.max(1e-4, c.camRise);
    const high = Math.max(0, c.camHigh);
    const fall = Math.max(1e-4, c.camFall);
    const total = low + rise + high + fall;

    // `phase` can be large and negative once `camStagger` is wound up, so the
    // wrap has to be a true modulo rather than `% 1`.
    let a = (phase - Math.floor(phase)) * total;

    // Seconds per unit of `a`. One full turn is `total` of these units and
    // takes `1 / camRate` seconds, so the conversion has to carry `total` —
    // and getting that wrong is invisible at the ship values, where the four
    // shares happen to sum to exactly 1, and obvious the moment anybody drags
    // `camRise`. It cost a confused half-hour.
    const perUnit = 1 / (Math.max(Math.abs(c.camRate), 1e-3) * total);

    if (a < low) {
      _cam.lift = 0;
      // Still cooling from the last stroke — the low dwell is the longest part
      // of the cycle and a station that arrives at it cold has already lost the
      // rhythm.
      const since = (a + fall + high) * perUnit;
      _cam.heat = Math.exp(-since * Math.max(c.heatBleed, 0.01));
      return _cam;
    }
    a -= low;

    if (a < rise) {
      const x = a / rise;
      _cam.lift = this._camLaw(x, c.camSnap);
      // The work goes in on the way up, so the heat follows the displacement
      // rather than leading or lagging it.
      _cam.heat = _cam.lift;
      return _cam;
    }
    a -= rise;

    if (a < high) {
      const since = a * perUnit;
      // The ring: a damped overshoot in seconds, on top of a flat dwell. It is
      // in seconds and not in shaft angle because a return spring has its own
      // natural frequency and does not know how fast the cam is turning.
      _cam.lift =
        1 + c.camRing * Math.exp(-since * Math.max(c.camRingDecay, 0.01)) * Math.sin(TAU * c.camRingRate * since);
      _cam.heat = Math.exp(-since * Math.max(c.heatBleed, 0.01));
      return _cam;
    }
    a -= high;

    const x = a / fall;
    _cam.lift = 1 - this._camLaw(x, c.camDrop);
    const since = (a + high) * perUnit;
    _cam.heat = Math.exp(-since * Math.max(c.heatBleed, 0.01));
    return _cam;
  }

  /** Shaft angle at station `i`, in turns. One shaft, `camStagger` keying. */
  _phaseOf(i) {
    const c = settings.pistondrive;
    return c.camRate * this.age - i * c.camStagger + c.camPhase;
  }

  /* ------------------------------------------------------------------ */
  /* Layout — every metre resolved from live settings                     */
  /* ------------------------------------------------------------------ */

  /** How many stations are drawn this frame. */
  _count() {
    return Math.max(1, Math.min(MAX_PISTONS, Math.round(settings.pistondrive.pistonCount)));
  }

  /** Fraction along the cast line of station `i`. */
  _stationAt(i, count) {
    return (i + 0.5) / Math.max(1, count);
  }

  /** Which rail station `i` sits on: −1 or +1. A machine alternates. */
  _railOf(i) {
    return i % 2 === 0 ? -1 : 1;
  }

  /** The floor point at the foot of station `i`. */
  _stationPoint(i, count, out) {
    const c = settings.pistondrive;
    this.pointAt(this._stationAt(i, count), out);
    out.addScaledVector(this.side, this._railOf(i) * c.railOffset);
    return out;
  }

  /** This station's own height in metres, with its share of the jitter. */
  _heightOf(i) {
    const c = settings.pistondrive;
    return Math.max(0.05, c.pistonHeight * (1 + this._dice[i * 2 + 1] * c.sizeJitter));
  }

  /**
   * 0..1 — how live station `i` is.
   *
   * The arming front is the cast's own front, so a station that the front has
   * not reached is flush and inert; `armFeather` is how much of the line it
   * takes to come up. The withdraw at the end multiplies straight into it, so
   * a station retracting mid-stroke retracts from wherever it was rather than
   * snapping down first.
   */
  _armOf(i, count) {
    const c = settings.pistondrive;
    const reach = this._b.arm;
    const s = this._stationAt(i, count);
    return saturate((reach - s) / Math.max(c.armFeather, 1e-3)) * this._b.drive;
  }

  /**
   * @param {number} t 0..1 through the impact phase, then 1..2 through the fade
   */
  _resolveBeats(t) {
    const b = this._b;
    if (this.phase === AbilityPhase.TRAVEL) {
      b.arm = this.u;
      b.drive = 1;
      b.fade = 1;
      return;
    }
    if (t <= 1) {
      b.arm = 1;
      b.drive = 1;
      b.fade = 1;
      return;
    }
    const s = saturate(t - 1);
    b.arm = 1;
    // Cubic in: the battery keeps working almost to the end and then drops
    // together, which is a machine being switched off rather than one winding
    // down.
    b.drive = 1 - Easing.inCubic(s);
    b.fade = 1 - Easing.inQuad(s);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.ventEmitter.reset();
    this._ported = 0;
    this._lastStrike = 0;
    this._up.fill(0);

    this._seed = Math.random() * 100;
    for (let i = 0; i < MAX_PISTONS; i++) {
      this._dice[i * 2] = Math.random();
      this._dice[i * 2 + 1] = Math.random() * 2 - 1;
    }

    this.ports.clearMarks();
    this.ports.setVisible(true);
    this.pistons.visible = true;
    this.decks.visible = true;

    this._resolveBeats(0);
    this._sync(0);
    this._seatFx();
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Rebuild every instance from the live block and the live cam.
   *
   * @param {number} dt seconds; 0 on a paused frame, which must still re-pose
   *   the row — the strikes it detects are gated on the cam having moved, not
   *   on the clock having.
   */
  _sync(dt) {
    const c = settings.pistondrive;
    const count = this._count();

    /* --- geometry, rebuilt only when a proportion actually moved --- */
    const pistonGeometry = this.cache.get(0, HardShape.PISTON, this._pistonShape());
    if (this.pistons.geometry !== pistonGeometry) {
      this.pistons.geometry = pistonGeometry;
      // The cache hands back a fresh BufferGeometry; the per-station heat is
      // ours and has to be put back on it.
      pistonGeometry.setAttribute('aHeat', this.heatAttr);
    } else if (!pistonGeometry.getAttribute('aHeat')) {
      pistonGeometry.setAttribute('aHeat', this.heatAttr);
    }
    const deckGeometry = this.cache.get(1, HardShape.PLATE, this._deckShape());
    if (this.decks.geometry !== deckGeometry) this.decks.geometry = deckGeometry;

    this.pistons.castShadow = c.pistonShadow === true;
    this.decks.castShadow = c.pistonShadow === true;

    const yaw = Math.atan2(this.direction.x, this.direction.z) + c.pistonYaw;
    const strikeAt = clamp(c.strikeAt, 0.02, 0.98);
    let live = 0;
    let deckLive = 0;
    let load = 0;

    for (let i = 0; i < count; i++) {
      const arm = this._armOf(i, count);
      const height = this._heightOf(i);
      this._stationPoint(i, count, _station);

      /* --- the deck plate: rises into its recess as the station arms --- */
      if (arm > 0.001) {
        const size = Math.max(0.02, c.deckSize);
        // Seated, the plate sits `deckLift` below the floor line; unarmed it is
        // exactly one plate thickness lower again, which is flush.
        const seat = -c.deckLift;
        _dummy.position.set(_station.x, lerp(seat - size * c.deckThickness, seat, arm), _station.z);
        _dummy.rotation.set(0, yaw, 0);
        _dummy.scale.setScalar(size);
        _dummy.updateMatrix();
        this.decks.setMatrixAt(deckLive++, _dummy.matrix);
      }

      if (arm <= 0.001) {
        this._up[i] = 0;
        continue;
      }

      /* --- the cam --- */
      const cam = this._camSample(this._phaseOf(i));
      const lift = cam.lift * arm;
      load += Math.max(0, cam.heat) * arm;

      // A piston whose base is at −H has its crown exactly flush with the
      // floor, so `stroke × lift` is literally how far the crown stands proud.
      _dummy.position.set(_station.x, -height + c.stroke * lift, _station.z);
      _dummy.rotation.set(0, yaw, this._railOf(i) * c.pistonSplay);
      _dummy.scale.setScalar(height);
      _dummy.updateMatrix();
      this.pistons.setMatrixAt(live, _dummy.matrix);
      this.heatAttr.array[live] = c.pistonHeatDrive * saturate(cam.heat) * arm;
      live++;

      /* --- the port, posted once per station as it comes live --- */
      if (i >= this._ported) this._postPort(i, count);

      /* --- the strike, re-derived rather than remembered --- */
      const up = cam.lift >= strikeAt ? 1 : 0;
      if (up && !this._up[i]) {
        this._lastStrike = i;
        this._strikeFx(i, _station, height, lift);
      }
      this._up[i] = up;
    }

    this.pistons.count = live;
    this.decks.count = deckLive;
    this.pistons.instanceMatrix.needsUpdate = true;
    this.decks.instanceMatrix.needsUpdate = true;
    this.heatAttr.needsUpdate = true;

    this._syncMaterials();
    this._syncPorts();
    this._syncParticles();
    this._ventFx(dt, count, load);

    // The light sits on the crown of whoever hit last.
    this._crownOf(Math.min(this._lastStrike, count - 1), count, this.position);
  }

  /** The crown of station `i`, in world space. */
  _crownOf(i, count, out) {
    const c = settings.pistondrive;
    const index = Math.max(0, i);
    this._stationPoint(index, count, out);
    const cam = this._camSample(this._phaseOf(index));
    out.y = Math.max(0, c.stroke * cam.lift * this._armOf(index, count));
    return out;
  }

  /** Both patched materials, pushed from one params bag. */
  _syncMaterials() {
    const c = settings.pistondrive;
    const g = settings.global;
    const p = _hard;

    p.colorMetal = c.colorMetal;
    p.colorDeep = c.colorDeep;
    p.colorScale = c.colorScale;
    p.colorPolish = c.colorPolish;
    p.colorSpec = c.colorSpec;
    p.roughness = c.steelRough;
    p.metalness = c.steelMetalness;
    p.envIntensity = c.steelEnv;

    // Circumferential about the piston's own axis, which for `HardAxis.Y` is
    // local +Y. A rod and a collar came off a lathe and the grain runs round
    // them; brushed straight, the same silhouette is a painted dowel.
    p.brush = BrushMode.CIRCUMFERENTIAL;
    p.brushAxisX = 0;
    p.brushAxisY = 1;
    p.brushAxisZ = 0;
    p.anisotropy = c.brushAniso;
    p.specular = c.brushSpecular;
    p.grain = c.brushGrain;
    p.grainScale = c.brushGrainScale;
    p.grainStretch = c.brushGrainStretch;

    p.scale = c.millScale;
    p.scaleScale = c.millScalePatch;
    p.scaleSharp = c.millScaleSharp;
    p.pit = c.steelPit;
    p.pitScale = c.steelPitScale;
    p.wear = c.steelWear;
    p.wearGrain = c.steelWearGrain;

    // The base of the ramp. `aHeat` adds each station's own stroke heat on top
    // of this, which is the whole reason the attribute is an offset.
    p.heat = c.pistonHeatIdle;
    p.heatCold = c.heatCold;
    p.heatHot = c.heatHot;
    p.heatRef = c.heatRef;
    p.heatExponent = c.heatExponent;
    p.heatGlow = c.heatGlow;
    p.heatTint = c.heatTint;
    p.heatEdge = c.heatEdge;

    p.glow = g.glow;
    p.shaderIntensity = g.shaderIntensity;
    p.noiseFrequency = g.noiseFrequency;
    this.metal.userData.sync(p);

    /* --- the deck: same bag, its own colours, and cold --- */
    p.colorMetal = c.colorDeckMetal;
    p.colorDeep = c.colorDeckDeep;
    p.colorScale = c.colorDeckScale;
    p.colorPolish = c.colorDeckPolish;
    p.colorSpec = c.colorDeckSpec;
    p.roughness = c.deckRough;
    p.metalness = c.deckMetalness;
    p.scale = c.deckScale;
    p.pit = c.deckPit;
    // A rolled plate is brushed straight, along the plate rather than round it.
    p.brush = BrushMode.LINEAR;
    p.brushAxisX = 0;
    p.brushAxisY = 0;
    p.brushAxisZ = 1;
    p.heat = c.deckHeat;
    this.deckMetal.userData.sync(p);
  }

  /** The ports: a `GroundField(POCK)` over the whole lane. */
  _syncPorts() {
    const c = settings.pistondrive;
    const g = settings.global;
    const p = _ground;

    // POCK is a disc, and the lane is a line, so the field is anchored at the
    // middle of the cast with a radius of half its length. Marks are fractions
    // of that radius in the anchor's frame, which is exactly what a station's
    // position along the line already is.
    this.pointAt(0.5, _crown);
    p.centre = _crown;
    p.yaw = Math.atan2(this.direction.x, this.direction.z);
    p.height = c.portHeight;
    p.radius = Math.max(0.5, this.length * 0.5);
    p.length = this.length;

    p.grow = 1;
    p.recede = 0;
    p.fade = this._b.fade;
    p.seed = this._seed;

    p.edge = c.portEdge;
    p.ragged = 0;
    p.warp = 0;

    p.relief = c.portRelief;
    p.normalStep = c.portNormalStep;
    p.ambient = c.portAmbient;
    p.wrap = c.portWrap;
    p.specular = c.portSpecular;
    p.gloss = c.portGloss;
    p.parallax = c.portParallax;

    p.depth = c.portDepth;
    p.lift = c.portLift;
    p.thickness = c.portRim;
    p.detail = c.portGrain;
    // POCK reads `speed` as how fast a crater digs itself in once posted.
    p.speed = c.portDig;
    p.markLife = c.portLife;
    p.markRadius = c.portRadius;

    p.additive = false;
    p.emissive = c.portEmissive * g.glow;
    p.opacity = c.portOpacity;
    p.depthFade = c.portDepthFade;
    p.colorBase = c.colorPortBase;
    p.colorEdge = c.colorPortEdge;
    p.colorGlow = c.colorPortGlow;
    p.colorDeep = c.colorPortDeep;

    p.noiseStrength = g.noiseStrength;
    p.noiseFrequency = g.noiseFrequency;
    p.noiseSpeed = g.noiseSpeed;
    p.opacityScale = g.opacity;

    this.ports.update(p);
  }

  /**
   * Post station `i`'s port.
   *
   * The mark is unitless — a fraction of the radius across and downrange, a
   * timestamp, and a strength — so dragging `range` after the fact re-places
   * every port along the new lane instead of leaving them where the old one
   * was.
   */
  _postPort(i, count) {
    const c = settings.pistondrive;
    const radius = Math.max(0.5, this.length * 0.5);
    const z = (this._stationAt(i, count) - 0.5) * this.length;
    const x = this._railOf(i) * c.railOffset;
    this.ports.mark(x / radius, z / radius, frame.uTime.value, 0.6 + 0.4 * this._dice[i * 2]);
    this._ported = i + 1;
  }

  /** The three particle systems, re-coloured and re-scaled every frame. */
  _syncParticles() {
    const c = settings.pistondrive;
    const g = settings.global;

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
    this.dust.uniforms.uTurbulence.value = 0.3 * g.turbulence;

    this.chips.setGradient(
      getColor(c.colorChipA),
      getColor(c.colorChipB),
      getColor(c.colorChipC),
      getColor(c.colorChipD)
    );
    this.chips.uniforms.uGravity.value.set(0, c.chipGravity, 0);
    this.chips.uniforms.uSizeScale.value = c.chipSize * g.particleSize * 7;
    this.chips.uniforms.uLifeScale.value = c.chipLifetime * 0.5 * g.particleLifetime;
    this.chips.uniforms.uSpeedScale.value = g.particleSpeed;
    this.chips.uniforms.uOpacity.value = g.opacity;

    this.sparks.setGradient(
      getColor(c.colorSparkA),
      getColor(c.colorSparkB),
      getColor(c.colorSparkC),
      getColor(c.colorSparkD)
    );
    this.sparks.uniforms.uGravity.value.set(0, c.sparkGravity, 0);
    this.sparks.uniforms.uSizeScale.value = c.sparkSize * g.particleSize * 7;
    this.sparks.uniforms.uLifeScale.value = c.sparkLifetime * 0.5 * g.particleLifetime;
    this.sparks.uniforms.uSpeedScale.value = g.particleSpeed;
    this.sparks.uniforms.uOpacity.value = g.opacity;
    this.sparks.uniforms.uGlow.value = c.sparkGlow * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
  }

  /**
   * The spark tint: the blackbody colour of steel at `sparkHeat`.
   *
   * `heatToKelvin` reads `heatCold` / `heatHot` off whatever it is handed, and
   * the block carries both under exactly those names — so the sparks off a
   * port lip are on the same Planckian ramp as the piston that made them,
   * without anybody remembering to keep two numbers in step.
   */
  _sparkTint() {
    const c = settings.pistondrive;
    const kelvin = heatToKelvin(c.sparkHeat, c);
    _tint.setRGB(1, 1, 1).lerp(blackbodyColor(kelvin, _bb), saturate(c.sparkTemper));
    return _tint;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * One station crossing the strike threshold.
   *
   * Everything leaves the **port**, not the crown: the dust and the chips are
   * the floor being punched, and the sparks are the head shearing past the lip
   * on its way through. Throwing them off the head instead was the first
   * version and it read as the piston being on fire rather than as the floor
   * losing.
   */
  _strikeFx(i, point, height, lift) {
    const c = settings.pistondrive;
    const g = settings.global;
    const time = frame.uTime.value;
    const rim = Math.max(0.05, c.deckSize * 0.5);

    _pos.copy(point);
    _pos.y = 0.06;

    const dustCount = Math.round(c.strikeDust * g.particleCount);
    if (dustCount > 0) {
      _emit.position = _pos;
      _emit.radius = rim;
      _emit.anchor = null;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.size = 0.7;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.4;
      _emit.tint = null;
      _emit.time = time;
      this.dust.emit(dustCount, _emit);
    }

    const chipCount = Math.round(c.strikeChips * g.particleCount);
    if (chipCount > 0) {
      _emit.position = _pos;
      _emit.radius = rim * 0.8;
      _emit.anchor = null;
      // Out and up, away from the rail — the floor breaking outward round a
      // punch rather than a fountain out of the middle of it.
      _emit.direction = _dir
        .copy(this.side)
        .multiplyScalar(this._railOf(i) * 0.75)
        .setY(0.9)
        .normalize();
      _emit.speed = c.chipSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = 0.8;
      _emit.inherit = null;
      _emit.size = 0.12;
      _emit.sizeVariance = 0.7;
      _emit.life = c.chipLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = c.chipSpin;
      _emit.tint = null;
      _emit.time = time;
      this.chips.emit(chipCount, _emit);
    }

    const sparkCount = Math.round(c.strikeSparks * g.particleCount);
    if (sparkCount > 0) {
      _emit.position = _pos;
      _emit.radius = rim * 0.6;
      _emit.anchor = null;
      // Along the lip, near-horizontal: the head is shearing past a collar, so
      // the sparks leave in the plane of the seal rather than up the shaft.
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.35).setY(0.2).normalize();
      _emit.speed = c.sparkSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.size = 0.13;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = this._sparkTint();
      _emit.time = time;
      this.sparks.emit(sparkCount, _emit);
    }

    // The kick scales with how far the follower actually went, so a row set to
    // a short stroke does not shake the camera as hard as one set to a long
    // one — and `height` is here for the same reason, since a bigger ram hits
    // harder.
    this.ctx.shake.add(
      c.strikeShake * saturate(lift) * (height / Math.max(0.05, c.pistonHeight)) * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      20
    );
    if (c.strikeFlash > 0) {
      this.ctx.flash.trigger(getColor(c.colorFlash), c.strikeFlash * g.explosionIntensity);
    }
    this.lightBoost = c.lightIntensity * 0.45 * g.explosionIntensity;
  }

  /**
   * The continuous bleed off the whole battery.
   *
   * `load` is the summed cam heat over every live station, so a row that is
   * mostly dwelling breathes and a row that is mostly stroking smokes. It is
   * derived from the cam rather than from a rate slider on its own, which is
   * what keeps the dust in rhythm with the machine when `camRate` moves.
   */
  _ventFx(dt, count, load) {
    if (dt <= 0) return;
    const c = settings.pistondrive;
    const g = settings.global;
    const share = load / Math.max(1, count);
    const n = Math.round(this.ventEmitter.tick(dt, c.ventRate * share) * g.particleCount);
    if (n <= 0) return;

    const i = Math.min(count - 1, Math.floor(Math.random() * count));
    this._stationPoint(i, count, _pos);
    _pos.y = 0.08;

    _emit.position = _pos;
    _emit.radius = Math.max(0.05, c.deckSize * 0.6);
    _emit.anchor = null;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dustSpeed * 0.5;
    _emit.speedVariance = 0.6;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.size = 0.5;
    _emit.sizeVariance = 0.5;
    _emit.life = c.dustLifetime;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.3;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.dust.emit(n, _emit);
  }

  /** The battery seating itself as the cast leaves. */
  _seatFx() {
    const c = settings.pistondrive;
    const g = settings.global;

    this.pointAt(0, _pos);
    _pos.y = 0.1;

    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.seatSize * 0.2,
      endRadius: c.seatSize * g.explosionIntensity,
      life: 0.45,
      intensity: c.seatIntensity,
      opacity: 0.85,
      fresnel: 1.7,
      displace: 0.5,
      squash: 0.55,
      colorA: getColor(c.colorSeatA),
      colorB: getColor(c.colorSeatB),
      colorC: getColor(c.colorSeatC)
    });

    this.ctx.shake.add(
      c.castShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.6 * g.explosionIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._resolveBeats(0);
    this._sync(dt);
    this.ctx.shake.rumble(settings.pistondrive.rumble * settings.global.cameraShake, dt);
  }

  /** The far end is reached; the whole row is live and the drive settles in. */
  onImpact() {
    this._resolveBeats(0);
    this._sync(0);
  }

  onFade(dt, t) {
    this._resolveBeats(t);
    this._sync(dt);
    if (t <= 1) {
      this.ctx.shake.rumble(settings.pistondrive.rumble * settings.global.cameraShake, dt);
    }
  }

  onDestroy() {
    this.pistons.count = 0;
    this.decks.count = 0;
    this.pistons.visible = false;
    this.decks.visible = false;
    this.heatAttr.array.fill(0);
    this.heatAttr.needsUpdate = true;
    this.ports.clearMarks();
    this.ports.setVisible(false);
    this._up.fill(0);
    this._ported = 0;
    this._lastStrike = 0;
  }

  dispose() {
    // Both geometries belong to the cache; disposing them here would free them
    // twice.
    this.cache.dispose();
    this.metal.dispose();
    this.deckMetal.dispose();
    this.pistons.dispose();
    this.decks.dispose();
    this.ports.dispose();
    super.dispose();
  }
}
