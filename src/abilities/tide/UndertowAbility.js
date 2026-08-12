import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { LiquidSurface, LiquidMode, liquidParams } from '../../vfx/LiquidSurface.js';
import { Caustics, CausticSource, CausticShape, causticsParams } from '../../vfx/Caustics.js';
import { Swarm, Silhouette, LeadPath, swarmParams } from '../../vfx/Swarm.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;

/** Hard ceiling on the debris raft. The `debrisCount` slider clamps here. */
const MAX_DEBRIS = 320;

/* ---------------------------------------------------------------- */
/* Scratch — module scope (I3). Filled and consumed inside one call. */
/* ---------------------------------------------------------------- */

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _vel = new Vector3();
const _lead = new Vector3();
const _centre = new Vector3();
const _anchor = new Vector3();
const _netCentre = new Vector3();
const _up = new Vector3(0, 1, 0);

/**
 * The flow field's two components at one radius, metres per second.
 *
 * One object, refilled — `flowAt()` writes into whatever it is handed, and the
 * only caller that needs two answers at once takes the second into a local
 * copy of the numbers rather than a second object.
 */
const _flow = { radial: 0, tangential: 0, speed: 0 };

/** The three params blocks the shared modules read. Refilled every frame. */
const _liquid = liquidParams();
const _net = causticsParams();
const _drops = swarmParams();
_net.centre = _netCentre;

/**
 * UNDERTOW — a whirlpool, and one flow field driving everything in it.
 *
 * Three beats: the circle **opens** as the cast lands, the vortex **pulls** for
 * a long couple of seconds while everything loose winds inward and goes under,
 * and then it **shuts**.
 *
 * ## THE TRICK — one function, four consumers
 *
 * `flowAt(radius, out)` is the whole ability. It is an ideal **vortex-sink**:
 *
 * ```
 *   v_θ(r) = swirl / r          circulation — how hard it turns
 *   v_r(r) = −drain / r         the sink    — how hard it pulls in
 * ```
 *
 * and it is the only place in this file that reads either number. The surface's
 * drift, the caustic net, the debris raft and the spume all ask *it* where they
 * are going. Drag `swirl` with the game paused and the water's drift bearing,
 * the arm of debris and the flecks on the froth all re-aim together, because
 * there is only one thing to re-aim. This is the same contract `Tube.radiusAt`
 * has and it is kept for the same reason: the moment two consumers carry their
 * own copy of a shape, they start disagreeing about it in the third decimal
 * place and the picture stops holding together.
 *
 * **It is a real logarithmic spiral, and that is a consequence rather than a
 * choice.** A streamline satisfies `dr/dθ = v_r·r/v_θ = −(drain/swirl)·r`, so
 * `r(θ) = r₀·e^{−bθ}` with `b = drain/swirl`: constant pitch angle, which is
 * the definition. Two more things fall out in closed form, and having them in
 * closed form is what keeps invariant **I1**:
 *
 * ```
 *   r(t) = √(r₀² − 2·drain·t)            integrate  dr/dt = −drain/r
 *   θ(t) = (swirl/drain)·ln(r₀ / r(t))   which is the spiral law again
 * ```
 *
 * Nothing about the raft is integrated frame by frame. `radiusAt(t)` and
 * `angleAt(t)` are functions of the phase clock and the live sliders, so a
 * paused vortex re-solves its whole streamline when you move `drain` instead of
 * carrying on from wherever an accumulator had got to.
 *
 * **The spin-up is a clock, not a fudge.** Scaling the field by a ramp `k(t)`
 * would break those closed forms. Instead the ramp is *integrated* —
 * `flowTime()` returns `∫k dt`, itself closed form for a linear ramp — and the
 * same exact laws are evaluated against it. The field is never anything but
 * the field; only the clock it is read at is bent.
 *
 * ## Debris goes under, and is seen through the water
 *
 * The brief for this cast is explicit that the debris must be *pulled under*
 * rather than deleted, and that is a render-order problem before it is an art
 * problem. Two things make it work and both were wrong in the first version:
 *
 *  - **The pool stands `poolHeight` metres proud of the floor.** A sheet of
 *    water five centimetres off the flagstones has five centimetres of "under",
 *    and debris sinking into it just clips the ground. The pool is a body of
 *    water with a feathered waterline, the caustics are on the floor most of a
 *    metre below it, and there is somewhere for things to go.
 *  - **The raft draws *before* the surface.** `Swarm`'s renderOrder is put
 *    below `LiquidSurface`'s, so the water blends over the debris and tints it
 *    with its own depth colour. Drawn after — which is the module default, and
 *    which is what happened first — the chips paint on top of the water and
 *    read as flotsam sitting on it, or, with the surface writing depth, vanish
 *    entirely. That is the "deleted" failure the brief names.
 *
 * The raft itself is `Swarm` in `ORBIT`, fed the streamline: the lead's radius,
 * angle and depth are `radiusAt` / `angleAt` / a lerp between `debrisSinkRim`
 * and `debrisSinkCore`. One honest approximation is worth stating — `Swarm`
 * rewinds its trailing ranks at a *constant* rate, so the arm behind the lead
 * is a first-order estimate of where the streamline was, and its radius is the
 * lead's rather than the larger radius the tail really had. What it costs is a
 * raft that is an arc at one radius instead of an arm sweeping across several;
 * what it buys is that the whole raft is one draw call and nothing about it
 * exists on the CPU. The over-winding near the eye, where `ω = swirl/r²` is
 * large, is an error in the direction of the truth.
 *
 * ## The net
 *
 * `Caustics(WAVE)` bound to the pool with `bindSource()`, exactly as `tiderush`
 * does — the swell, the chop and every ripple packet are one set of uniform
 * boxes with one author, so the light on the floor is the image of the water
 * above it. The pool's `poolHeight` *is* the depth the light crosses, which is
 * the one place in this block where sharing a number between two consumers is
 * the design rather than a shortcut.
 *
 * The same handedness note as `tiderush` applies and is written out there: the
 * ground quad's frame is right-handed, `LiquidSurface`'s is not, so the net is
 * the water's mirror across the pool's own +X axis. The swell is authored in
 * mirror pairs so that reflection maps the wave set onto itself. **The one
 * thing that must never go into the height field here is a chiral term** — a
 * spiral ridge in the water would come out on the floor winding the other way
 * from the debris, and that is the single error in this cast a viewer would
 * actually catch. The spiral lives in the flow field, the debris and the
 * particles, all of which are in world space and none of which is mirrored.
 *
 * ## What a cast captures
 *
 * `_seed`, so two vortices do not lay their debris out identically, and
 * timestamps. Nothing else. Pause with **P** mid-pull and drag `drain`: the
 * raft jumps to where that streamline actually puts it, the froth ring around
 * the eye widens, and the net on the floor re-folds — three consumers, one
 * number.
 */
export class UndertowAbility extends Ability {
  constructor(context) {
    super('undertow', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /*
     * The raft is added FIRST and given the lowest render order of the three,
     * so the painter's order is floor-light, then debris, then water. See the
     * class comment: this is the whole of "under the surface, not deleted".
     */
    this.debris = new Swarm(this.group, {
      capacity: MAX_DEBRIS,
      silhouette: Silhouette.DROPLET,
      additive: false, //  a wet chip is a dark body, not a spark
      renderOrder: 7
    });

    /*
     * The net, on the floor under everything. Bound to the pool below, so it is
     * built before the surface only because it must be added to the group
     * before it — the binding happens after both exist.
     */
    this.net = new Caustics(this.group, {
      source: CausticSource.WAVE,
      shape: CausticShape.DISC,
      additive: true,
      depthTest: true,
      renderOrder: 6,
      name: 'Undertow:net'
    });

    /*
     * The pool. 96 segments a side: below about 48 the froth ring around the
     * eye facets, above 160 the fragment normal is already carrying the detail
     * for nothing. `depthWrite` stays on — the water is in front of the debris
     * from every camera angle the game allows, so it is free to occlude what is
     * behind it, and turning it off costs the surface its own self-sorting.
     */
    this.surface = new LiquidSurface({
      segments: 96,
      mode: LiquidMode.POOL,
      depthWrite: true,
      doubleSide: true,
      renderOrder: 9,
      name: 'Undertow:pool'
    });
    this.group.add(this.surface.object3D);

    // One height field, two consumers.
    this.net.bindSource(this.surface.uniforms);

    /** Re-rolled per cast so no two vortices lay their debris out the same. */
    this._seed = 0;
    /** Agents drawn last frame — the HUD readout. */
    this._live = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Spume: froth flecks torn off the surface. They are emitted *with the flow
    // velocity at the radius they were born at*, which is the cheapest of the
    // four consumers of the field and the one that sells the rotation, because
    // a fleck that is thrown along the streamline reads as being carried.
    this.spume = particles.get('undertow.spume', {
      capacity: 1600,
      shape: ParticleShape.SOFT,
      additive: false,
      lit: true,
      softFade: 0.3
    });
    this.spume.uniforms.uDrag.value = 1.1;
    this.spume.uniforms.uEndSize.value = 0.55;
    this.spume.uniforms.uSizeIn.value = 0.03;
    this.spume.uniforms.uFadeIn.value = 0.05;
    this.spume.uniforms.uFadeOut.value = 0.5;

    // The haze standing over the eye. Non-additive so it occludes.
    this.mist = particles.get('undertow.mist', {
      capacity: 1100,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.mist.uniforms.uDrag.value = 1.9;
    this.mist.uniforms.uEndSize.value = 2.5;
    this.mist.uniforms.uSizeIn.value = 0.14;
    this.mist.uniforms.uFadeIn.value = 0.2;
    this.mist.uniforms.uFadeOut.value = 0.35;

    // Grit: the stuff too small to be worth a `Swarm` agent, riding the same
    // streamlines a metre under the surface.
    this.grit = particles.get('undertow.grit', {
      capacity: 1200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.grit.uniforms.uDrag.value = 0.9;
    this.grit.uniforms.uEndSize.value = 0.7;
    this.grit.uniforms.uFadeOut.value = 0.6;

    this.spumeEmitter = new RateEmitter();
    this.mistEmitter = new RateEmitter();
    this.gritEmitter = new RateEmitter();
    this.rippleEmitter = new RateEmitter();
    this.rimEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._live;
  }

  /** The vortex holds open and pulls. */
  get impactDuration() {
    return Math.max(0.05, settings.undertow.pullTime * settings.global.lifetime);
  }

  /** Then it shuts. */
  get fadeDuration() {
    return Math.max(0.05, settings.undertow.closeTime);
  }

  /** Water does not gutter; the eye breathes. */
  lightShimmer() {
    return 0.86 + 0.14 * Math.sin(this.age * 2.1);
  }

  /* ------------------------------------------------------------------ */
  /* THE FLOW FIELD — one function, and its two closed-form integrals    */
  /* ------------------------------------------------------------------ */

  /**
   * The vortex-sink's velocity at a radius, in metres per second.
   *
   * This is the ability. Everything below it in this file is this function
   * evaluated somewhere, and nothing else in the file reads `swirl` or `drain`.
   *
   * Both terms go as `1/r`, which is what an inviscid vortex and an inviscid
   * sink actually do, and which is why the streamline is a logarithmic spiral —
   * their *ratio* is independent of `r`, so the angle between the flow and the
   * radius is the same everywhere. `coreRadius` is where that stops: inside it
   * the field would be a singularity, so it is clamped, and the clamp is the
   * eye of the whirlpool rather than a numerical guard bolted on afterwards.
   *
   * The value returned is the field at **full strength**. Consumers that want
   * the field as it is *right now* multiply by `spin()`; the raft instead reads
   * it through `flowTime()`, which is exact — see the class comment.
   *
   * @param {number} radius metres from the eye
   * @param {object} out    `{ radial, tangential, speed }`, written in place
   */
  flowAt(radius, out) {
    const c = settings.undertow;
    const r = Math.max(radius, Math.max(c.coreRadius, 0.01));
    out.radial = -c.drain / r; //  negative: inward
    out.tangential = c.swirl / r;
    out.speed = Math.hypot(out.radial, out.tangential);
    return out;
  }

  /**
   * The same field as a world-space vector at a world point.
   *
   * The tangential basis vector is the radial one turned a quarter turn about
   * `+Y` — `(−r̂.z, 0, r̂.x)` — which is the same sense `Swarm`'s `ORBIT` path
   * sweeps in, so a positive `swirl` turns the debris and the spume the same
   * way. Get that sign backwards and the froth runs against the raft, which is
   * exactly the kind of error nobody can name and everybody can see.
   */
  flowVectorAt(point, centre, out) {
    let dx = point.x - centre.x;
    let dz = point.z - centre.z;
    const r = Math.hypot(dx, dz);
    if (r < 1e-4) {
      dx = 1;
      dz = 0;
    } else {
      dx /= r;
      dz /= r;
    }
    this.flowAt(r, _flow);
    const k = this.spin();
    out.set(
      (dx * _flow.radial - dz * _flow.tangential) * k,
      0,
      (dz * _flow.radial + dx * _flow.tangential) * k
    );
    return out;
  }

  /**
   * Seconds the vortex has been open. Zero while the cast is still travelling.
   *
   * Recovered from the phase clock rather than accumulated, so changing
   * `pullTime` mid-cast re-times the beat instead of sliding the raft.
   */
  vortexClock() {
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    if (this.phase === AbilityPhase.IMPACT) return this.impactTime;
    return this.impactDuration + this.fadeTime;
  }

  /** 0..1 — how much of the field is switched on right now. */
  spin() {
    const c = settings.undertow;
    const ramp = Math.max(c.spinUp, 1e-3) * this.impactDuration;
    return saturate(this.vortexClock() / ramp);
  }

  /**
   * The vortex clock with the spin-up ramp **integrated out**.
   *
   * A field scaled by `k(t)` moves a particle exactly as the unscaled field
   * does when read against `∫k dt`, so this is the substitution that keeps
   * `radiusAt` and `angleAt` closed-form through the ramp rather than only
   * after it. For a linear ramp to 1 over `T` the integral is `t²/2T` while the
   * ramp lasts and `t − T/2` afterwards, which is two lines and exact.
   */
  flowTime() {
    const c = settings.undertow;
    const t = this.vortexClock();
    const T = Math.max(c.spinUp, 1e-3) * this.impactDuration;
    return t < T ? (t * t) / (2 * T) : t - T * 0.5;
  }

  /** The waterline's radius in metres — where a streamline is handed in. */
  rimRadius() {
    const c = settings.undertow;
    return Math.max(c.zoneRadius * this._fillNow(), Math.max(c.coreRadius, 0.01) * 1.5);
  }

  /**
   * Seconds one streamline takes to fall from the rim to the eye.
   *
   * `r² = r₀² − 2·drain·t` reaches zero at exactly this time, so it is the
   * natural period of the raft and there is no separate "debris lifetime"
   * slider: the fall time is what the field says it is.
   */
  fallTime() {
    const c = settings.undertow;
    const r0 = this.rimRadius();
    return Math.max((r0 * r0) / (2 * Math.max(c.drain, 1e-3)), 0.05);
  }

  /** Radius in metres, `flowAt` integrated once. */
  radiusAt(t) {
    const c = settings.undertow;
    const r0 = this.rimRadius();
    const core = Math.max(c.coreRadius, 0.01);
    return Math.sqrt(Math.max(r0 * r0 - 2 * Math.max(c.drain, 1e-3) * t, core * core));
  }

  /**
   * Bearing in radians, `flowAt` integrated once more.
   *
   * `(swirl/drain)·ln(r₀/r)` is the logarithmic spiral law written the other
   * way round, which is the tidiest possible demonstration that the streamline
   * really is one: no spiral was ever authored, only two velocities.
   */
  angleAt(t) {
    const c = settings.undertow;
    const b = c.swirl / Math.max(c.drain, 1e-3);
    return b * Math.log(this.rimRadius() / this.radiusAt(t));
  }

  /* ------------------------------------------------------------------ */
  /* The beats                                                           */
  /* ------------------------------------------------------------------ */

  /** 0..1 how open the pool is on the way in. */
  _openNow() {
    const c = settings.undertow;
    if (this.phase === AbilityPhase.TRAVEL) return Math.pow(saturate(this.u), Math.max(c.openCurve, 0.05));
    return 1;
  }

  /** 0..1 how far through shutting it is. */
  _closeNow() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    return saturate(this.fadeTime / this.fadeDuration);
  }

  /** The water's reach as a fraction of the half-extent, this frame. */
  _fillNow() {
    const c = settings.undertow;
    return saturate(c.poolFill * this._openNow() * (1 - Easing.inQuad(this._closeNow())));
  }

  /** Where the eye is, on the floor. */
  _eyePoint(out) {
    const s = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    return this.pointAt(s, out);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.spumeEmitter.reset();
    this.mistEmitter.reset();
    this.gritEmitter.reset();
    this.rippleEmitter.reset();
    this.rimEmitter.reset();
    this._live = 0;

    this.surface.clearRipples();
    this.net.reset();

    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;
    this.debris.roll(this._seed);

    this._sync(1);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Re-resolve the pool, the net and the raft from live settings.
   *
   * The order is the painter's order and it is also the dependency order: the
   * pool is placed and updated first because the net's quad has to sit on the
   * same anchor and the raft's ripples are posted against this frame's
   * half-extents.
   *
   * @param {number} fade 1 while the vortex holds, ramping to 0 as it shuts
   */
  _sync(fade) {
    const c = settings.undertow;
    const g = settings.global;

    const fill = this._fillNow();
    const rim = this.rimRadius();
    const gate = this.spin();

    /* ---------------- the pool ---------------- */
    this._eyePoint(_anchor);
    _anchor.y = c.poolHeight;
    this.surface.setPlacement(_anchor, this.direction, _up);

    // A disc: both half-extents are the aimed circle, and `fill` opens it.
    _liquid.sizeX = Math.max(0.4, c.zoneRadius * 2);
    _liquid.sizeZ = _liquid.sizeX;
    _liquid.fill = fill;
    _liquid.round = c.poolRound;
    _liquid.edgeSoft = c.poolEdge;
    _liquid.edgeNoise = c.poolRagged;
    _liquid.edgeScale = c.poolRaggedScale;
    _liquid.seed = this._seed;
    _liquid.opacity = c.poolOpacity * fade * g.opacity;
    _liquid.contactFade = c.contactFade;
    // POOL mode ignores the crest, but the caustics' WAVE height field does not
    // know that — it reads the bound `uCrestHeight` whatever the mode is. Left
    // at the module's 1.1 m default it draws a wall of light across a pool that
    // has no wave in it at all.
    _liquid.crestHeight = 0;

    /* ---------------- the swell, in mirror pairs ---------------- */
    _liquid.waveAmpA = c.swellAmpA;
    _liquid.waveAmpB = c.swellAmpB;
    _liquid.waveAmpC = c.swellAmpC;
    _liquid.waveAmpD = c.swellAmpD;
    _liquid.waveLengthA = c.swellLengthA;
    _liquid.waveLengthB = c.swellLengthB;
    _liquid.waveLengthC = c.swellLengthC;
    _liquid.waveLengthD = c.swellLengthD;
    _liquid.waveSpeedA = c.swellSpeedA;
    _liquid.waveSpeedB = c.swellSpeedB;
    _liquid.waveSpeedC = c.swellSpeedC;
    _liquid.waveSpeedD = c.swellSpeedD;
    _liquid.waveAngleA = c.swellAngleA;
    _liquid.waveAngleB = c.swellAngleB;
    _liquid.waveAngleC = c.swellAngleC;
    _liquid.waveAngleD = c.swellAngleD;
    _liquid.steepness = c.steepness;

    _liquid.chop = c.chop * g.noiseStrength;
    _liquid.chopScale = c.chopScale * g.noiseFrequency;
    _liquid.chopSpeed = c.chopSpeed * g.noiseSpeed;
    _liquid.detail = c.detail * g.noiseStrength;
    _liquid.detailScale = c.detailScale * g.noiseFrequency;
    _liquid.detailSpeed = c.detailSpeed * g.noiseSpeed;

    _liquid.rippleAmp = c.rippleAmp;
    _liquid.rippleSpeed = c.rippleSpeed;
    _liquid.rippleLength = c.rippleLength;
    _liquid.rippleWidth = c.rippleWidth;
    _liquid.rippleDecay = c.rippleDecay;
    _liquid.rippleSpread = c.rippleSpread;

    /* ---------------- consumer one: the surface's own flow ---------------- */
    // `LiquidSurface` carries one bulk drift vector, a radial term and a curl
    // term, and no coherent rotation at all — so the field is handed to it in
    // the three pieces it can hold. The drift is the flow at ONE radius, which
    // is the honest limitation of the module rather than a simplification of
    // the vortex: everything else here still comes from `flowAt`.
    this.flowAt(rim * c.flowSampleAt, _flow);
    // In the sheet's parametric frame the sample point on +X has its radial
    // direction along +x and its tangential direction along −z, because
    // `axisZ = up × axisX` makes that frame left-handed. Hence the minus.
    _liquid.flowAngle = Math.atan2(-_flow.tangential, _flow.radial);
    _liquid.flowSpeed = _flow.speed * gate;
    _liquid.flowRadial = _flow.radial * gate;
    _liquid.flowRadialFall = c.radialFall;
    _liquid.flowEddy = Math.abs(_flow.tangential) * c.eddyShare * gate;
    // One eddy across the pool. Deliberately not a slider: the swirl has one
    // length scale and it is the pool's own radius, so an independent control
    // could only ever put the two out of step.
    _liquid.flowEddyScale = g.noiseFrequency / Math.max(rim, 0.2);
    // The churn of the curl noise is the vortex's own angular rate in turns per
    // second, not a second clock running next to it.
    _liquid.flowEddySpeed =
      (Math.abs(_flow.tangential) / Math.max(rim * c.flowSampleAt, 0.05) / TAU) * gate * g.noiseSpeed;
    _liquid.flowGravity = 0; //  a pool has no slope to run down; the vortex is the flow

    _liquid.foam = c.foam * gate;
    _liquid.foamScale = c.foamScale * g.noiseFrequency;
    _liquid.foamSharp = c.foamSharp;
    _liquid.foamCrest = c.foamCrest;
    _liquid.foamSpeed = c.foamSpeed;
    // The froth's speed gate. These are the crust's boxes and the crust is off;
    // see `tiderush` for the same note.
    _liquid.crustForm = c.foamGateLow;
    _liquid.crustBreak = Math.max(c.foamGateHigh, c.foamGateLow + 0.01);
    // Neither is gated by `crust`, and `meltGlow` defaults to 1.2 — leave it
    // alone and the whole pool picks up a warm emissive haze the moment foam
    // asks for a surface speed.
    _liquid.meltGlow = 0;
    _liquid.seamGlow = 0;

    /* ---------------- shading ---------------- */
    _liquid.poolDepth = c.poolDepth;
    _liquid.depthTint = c.depthTint;
    _liquid.translucency = c.translucency;
    _liquid.ambient = c.ambient;
    _liquid.specular = c.specular;
    _liquid.shininess = c.shininess;
    _liquid.fresnel = c.fresnel * g.fresnel;
    _liquid.envIntensity = c.envIntensity;
    _liquid.skyIntensity = c.skyIntensity;
    _liquid.glow = c.glow * g.glow;
    _liquid.normalEps = c.normalEps;
    _liquid.colorDeep = c.colorDeep;
    _liquid.colorShallow = c.colorShallow;
    _liquid.colorFoam = c.colorFoam;
    _liquid.colorSpec = c.colorSpec;
    _liquid.colorSky = c.colorSky;

    this.surface.visible = _liquid.opacity > 0.002 && fill > 0.002;
    this.surface.update(this.age, _liquid);

    /* ---------------- consumer two: the net ---------------- */
    // The yaw is chosen so the quad's local +X lies along the pool's `axisX`,
    // because the bound height field is sampled in the pool's parametric
    // metres. See the handedness note in the class comment.
    _netCentre.copy(_anchor).setY(0);
    _net.yaw = Math.atan2(-this.direction.z, this.direction.x);
    _net.height = c.netHeight;
    _net.radius = Math.max(0.2, rim * c.netReach);
    _net.fade = fade;
    // The light crosses exactly the water that is standing there.
    _net.depth = Math.max(0, c.poolHeight + c.netDepthBias);
    _net.ior = c.netIor;
    _net.dispersion = c.netDispersion;
    _net.sampleStep = c.netStep;
    _net.absorb = c.netAbsorb;
    _net.foldFloor = c.netFoldFloor;
    _net.threshold = c.netThreshold;
    _net.gain = c.netGain;
    _net.sharpness = c.netSharp;
    _net.rolloff = c.netRolloff;
    _net.penumbra = c.netPenumbra;
    _net.wash = c.netWash;
    _net.fringeAt = c.netFringeAt;
    _net.emissive = c.netEmissive;
    _net.opacity = c.netOpacity;
    _net.depthFade = c.netDepthFade;
    _net.additive = true;
    _net.colorNet = c.colorNet;
    _net.colorFringe = c.colorFringe;
    _net.colorWash = c.colorWash;
    _net.noiseStrength = g.noiseStrength;
    _net.noiseFrequency = g.noiseFrequency;
    _net.noiseSpeed = g.noiseSpeed;
    _net.opacityScale = g.opacity;
    this.net.setVisible(fade > 0.002 && fill > 0.002);
    this.net.update(_net);

    /* ---------------- consumer three: the raft ---------------- */
    const fall = this.fallTime();
    // The streamline is cyclic: an agent that reaches the eye is handed back in
    // at the rim. `fall` is not a lifetime slider — it is what the field says
    // the fall takes — so the loop re-times itself when `drain` moves.
    const phase = this.flowTime() % fall;
    const along = saturate(phase / fall);
    const radius = this.radiusAt(phase);
    const angle = this.angleAt(phase);
    // Angular rate at the radius the lead is at now. `Swarm` rewinds its
    // trailing ranks with this, so the arm behind the lead is where the
    // streamline was — to first order. See the class comment.
    this.flowAt(radius, _flow);
    // Signed, because `tangential` already carries the sign of `swirl` — flip
    // that slider and the raft, the froth and the drift all turn the other way
    // together, which is the point of there being one field.
    const omega = _flow.tangential / Math.max(radius, 0.01);

    this.debris.setBasis(this.origin, this.direction, this.side, Math.max(0.2, this.length));
    _drops.count = Math.min(MAX_DEBRIS, Math.round(c.debrisCount * g.particleCount));
    _drops.leadMode = LeadPath.ORBIT;
    _drops.orbitTurns = 1; //  so `leadS` is turns, and `angle` is radians / TAU
    _drops.leadS = angle / TAU;
    _drops.leadRate = (omega / TAU) * gate;
    _drops.orbitRadius = radius;
    // The eye's floor point is where `Swarm` puts an ORBIT's centre, and the
    // depth is measured down from the water's mean plane: at the rim the raft
    // is barely wet, at the eye it is most of a metre under.
    _drops.endHeight = c.poolHeight;
    _drops.orbitHeight = -lerp(c.debrisSinkRim, c.debrisSinkCore, saturate(1 - radius / Math.max(rim, 0.05)));
    _drops.handForward = 0;
    _drops.handSide = 0;
    _drops.handHeight = c.poolHeight;
    _drops.leadRise = 0;
    _drops.latticeX = c.debrisLatticeX;
    _drops.latticeY = c.debrisLatticeY;
    _drops.latticeZ = c.debrisLatticeZ;
    _drops.spacingSide = c.debrisSpacingSide;
    _drops.spacingUp = c.debrisSpacingUp;
    _drops.lag = c.debrisLag;
    _drops.jitter = c.debrisJitter * g.randomness;
    _drops.churn = c.debrisChurn;
    _drops.breathe = c.debrisBreathe;
    _drops.breatheRate = c.debrisBreatheRate;
    _drops.wander = c.debrisWander * g.noiseStrength;
    _drops.wanderScale = c.debrisWanderScale * g.noiseFrequency;
    _drops.wanderSpeed = c.debrisWanderSpeed * g.noiseSpeed;
    _drops.gather = c.debrisGather;
    _drops.size = c.debrisSize * g.particleSize;
    _drops.aspect = c.debrisAspect;
    _drops.sizeJitter = c.debrisSizeJitter * g.randomness;
    _drops.billboard = c.debrisBillboard;
    _drops.bank = c.debrisBank;
    _drops.bankMax = c.debrisBankMax;
    _drops.dihedral = 0;
    _drops.flapRate = 0;
    _drops.curl = c.debrisCurl;
    _drops.edgeStretch = c.debrisEdgeStretch;
    _drops.edgeGain = c.debrisEdgeGain;
    // Agents appear at the rim and are swallowed at the eye. `revealSpread`
    // staggers that per agent off its own dice, so the raft does not blink in
    // and out as one object at the seam of the cycle.
    _drops.reveal =
      saturate(along / Math.max(c.debrisFadeIn, 0.01)) *
      (1 - saturate((along - (1 - c.debrisFadeOut)) / Math.max(c.debrisFadeOut, 0.01))) *
      fade *
      gate;
    _drops.revealSpread = c.debrisRevealSpread;
    _drops.silhouette = Silhouette.DROPLET;
    _drops.lit = c.debrisLit;
    _drops.tint = c.debrisTint;
    _drops.tintJitter = c.debrisTintJitter;
    _drops.tintAlong = c.debrisTintAlong;
    _drops.opacity = c.debrisOpacity * g.opacity;
    _drops.glow = c.debrisGlow * g.glow;
    _drops.softFade = c.debrisSoftFade;
    this.debris.setColors(c.colorDebrisA, c.colorDebrisB, c.colorDebrisC, c.colorDebrisD);
    this.debris.update(this.age, _drops);
    this._live = this.debris.count;

    /* ---------------- the particle systems ---------------- */
    this.spume.setGradient(
      getColor(c.colorSpumeA),
      getColor(c.colorSpumeB),
      getColor(c.colorSpumeC),
      getColor(c.colorSpumeD)
    );
    this.spume.uniforms.uGravity.value.set(0, c.spumeGravity, 0);
    this.spume.uniforms.uSizeScale.value = c.spumeSize * g.particleSize * 7;
    this.spume.uniforms.uLifeScale.value = c.spumeLifetime * 0.5 * g.particleLifetime;
    this.spume.uniforms.uSpeedScale.value = g.particleSpeed;
    this.spume.uniforms.uOpacity.value = g.opacity;
    this.spume.uniforms.uGlow.value = 0.45 * g.glow;
    this.spume.uniforms.uTurbulence.value = 0.25 * g.turbulence;

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
    this.mist.uniforms.uTurbulence.value = c.mistTurbulence * g.turbulence;

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
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Consumer four: everything that is emitted is emitted **along the flow**.
   *
   * A fleck of froth is given the field's own velocity at the radius it was
   * born at, plus a little of its own. That is what makes the surface read as
   * turning: `LiquidSurface` cannot draw a coherent rotation, and a hundred
   * flecks travelling along the streamline can.
   *
   * @param {number} dt    seconds
   * @param {number} scale 0..1 — thinned out once the vortex is shutting
   */
  _vortexFx(dt, scale) {
    const c = settings.undertow;
    const g = settings.global;
    const time = frame.uTime.value;
    const rim = this.rimRadius();

    // The eye, held for the whole method: every emitter below asks the field
    // where it is going, and the field is measured from here.
    this._eyePoint(_centre).setY(c.poolHeight);
    const eyeX = _centre.x;
    const eyeZ = _centre.z;

    let spumeCount = Math.round(this.spumeEmitter.tick(dt, c.spumeRate * scale) * g.particleCount);
    if (spumeCount > 0) {
      _emit.speedVariance = 0.6;
      _emit.spread = 0.35;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.spumeLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      _emit.radius = 0.25;

      // Split around the waterline. One emission point a frame puts the whole
      // frame's froth in one place and the ring reads as a sprinkler.
      const batches = Math.min(spumeCount, 4);
      const per = Math.ceil(spumeCount / batches);
      while (spumeCount > 0) {
        const a = Math.random() * TAU;
        const r = rim * c.spumeAt * randRange(0.85, 1.05);
        _pos.set(eyeX + Math.cos(a) * r, c.poolHeight + 0.05, eyeZ + Math.sin(a) * r);
        _emit.position = _pos;
        this.flowVectorAt(_pos, _centre, _vel);
        const carried = _vel.length();
        _emit.direction = _dir.copy(_vel).setY(carried * 0.25 + 0.4).normalize();
        _emit.speed = carried + c.spumeSpeed;
        this.spume.emit(Math.min(per, spumeCount), _emit);
        spumeCount -= per;
      }
    }

    const gritCount = Math.round(this.gritEmitter.tick(dt, c.gritRate * scale) * g.particleCount);
    if (gritCount > 0) {
      const a = Math.random() * TAU;
      const r = lerp(c.coreRadius, rim, Math.random());
      // A metre under, so the grit is seen through the water like the raft is.
      _pos.set(eyeX + Math.cos(a) * r, c.poolHeight - c.debrisSinkRim, eyeZ + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = 0.3;
      this.flowVectorAt(_pos, _centre, _vel);
      const carried = _vel.length();
      _emit.direction = _dir.copy(_vel).setY(-0.15).normalize();
      _emit.speed = carried + c.gritSpeed;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.3;
      _emit.size = 0.08;
      _emit.sizeVariance = 0.7;
      _emit.life = c.gritLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 5;
      _emit.time = time;
      this.grit.emit(gritCount, _emit);
    }

    const mistCount = Math.round(this.mistEmitter.tick(dt, c.mistRate * scale) * g.particleCount);
    if (mistCount > 0) {
      this._eyePoint(_pos).setY(c.poolHeight + 0.1);
      _emit.position = _pos;
      _emit.radius = rim * 0.45;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.mistSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 1.0;
      _emit.size = 0.7;
      _emit.sizeVariance = 0.5;
      _emit.life = c.mistLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.time = time;
      this.mist.emit(mistCount, _emit);
    }

    // The dimple where the raft is being taken down. `rippleAtWorld` converts
    // the point against this frame's half-extents and stores only the fraction,
    // and the net has bound the same array — so the ring on the water and the
    // ring on the floor are one record.
    const packets = this.rippleEmitter.tick(dt, c.rippleRate * scale);
    if (packets > 0) {
      this.debris.leadPoint(_lead);
      for (let i = 0; i < packets; i++) {
        this.surface.rippleAtWorld(_lead, randRange(0.5, 1.1), this.age);
      }
    }

    // The waterline soaking into the floor.
    const marks = this.rimEmitter.tick(dt, c.rimRate * scale);
    for (let i = 0; i < marks; i++) {
      const a = Math.random() * TAU;
      const r = rim * randRange(0.9, 1.12);
      _pos.set(eyeX + Math.cos(a) * r, 0, eyeZ + Math.sin(a) * r);
      this.ctx.decals.spawn(DecalType.FOAM, _pos, {
        radius: c.rimRadius * randRange(0.7, 1.3),
        life: c.rimLife,
        intensity: c.rimIntensity,
        colorA: getColor(c.colorRimA),
        colorB: getColor(c.colorRimB),
        height: 0.012
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1);
    // The light sits over the eye rather than on the travelling front.
    this._eyePoint(this.position).setY(settings.undertow.poolHeight + settings.undertow.lightHeight);
    this._vortexFx(dt, this._openNow());
  }

  onImpact() {
    const c = settings.undertow;
    const g = settings.global;
    const time = frame.uTime.value;

    this._eyePoint(_pos).setY(c.poolHeight);

    /* the gulp of water as the surface breaks open */
    this.ctx.bursts.spawn(BurstMode.WATER, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.6,
      intensity: c.burstIntensity,
      opacity: 0.85,
      fresnel: 1.5,
      displace: 0.7,
      squash: 0.5,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this._eyePoint(_pos);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.55,
      width: 0.06,
      intensity: 0.9,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    this.ctx.shake.add(
      c.openShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      16
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.openFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.4 * g.explosionIntensity;

    _emit.position = _pos;
    _emit.radius = this.rimRadius() * 0.5;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.spumeSpeed * 3.5;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.8;
    _emit.life = c.spumeLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.spume.emit(Math.round(c.burstSpume * g.particleCount), _emit);

    /* and the loose grit the opening pulls straight down with it */
    _emit.direction = _dir.set(0, -0.4, 0).normalize();
    _emit.speed = c.gritSpeed * 3;
    _emit.spread = 1.0;
    _emit.size = 0.09;
    _emit.life = c.gritLifetime * 1.2;
    _emit.spin = 6;
    this.grit.emit(Math.round(c.burstGrit * g.particleCount), _emit);

    /*
     * Ring the new surface. The packets are fractions of the half-extents plus
     * a timestamp — never a metre — and the net has bound the same array, so
     * these rings arrive in the water and in the light on the floor as one
     * record. Posted in mirror-symmetric pairs of angle where they can be, for
     * the reason the handedness note gives: a lone off-axis packet is drawn by
     * the net on the far side of the pool from the one on the water.
     */
    const packets = Math.max(0, Math.round(c.burstRipples));
    for (let i = 0; i < packets; i++) {
      const a = (i / Math.max(packets, 1)) * TAU;
      const r = randRange(0.25, 0.7);
      this.surface.ripple(Math.cos(a) * r, Math.sin(a) * r, randRange(0.7, 1.2), this.age);
    }
  }

  onFade(dt, t) {
    // `t` runs 0..1 while the vortex pulls, then 1..2 while it shuts. Cubic-out
    // on the way down so the water lets go all at once rather than dimming.
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
    this._sync(fade);

    this._eyePoint(this.position).setY(settings.undertow.poolHeight + settings.undertow.lightHeight);
    this._vortexFx(dt, t <= 1 ? 1 : fade * 0.5);

    if (t <= 1) {
      this.ctx.shake.rumble(settings.undertow.rumble * settings.global.cameraShake, dt);
    }
  }

  onDestroy() {
    // Nothing is emitted here on purpose. `destroy()` is also how the player
    // pressing **C** ends a cast and how a fifth cast pushes this one off the
    // concurrency cap, and a whirlpool that coughs up a burst of grit when the
    // player cancels it is telling the player something that did not happen.
    this._live = 0;
    this.surface.reset();
    this.debris.reset();
    this.net.setVisible(false);
  }

  dispose() {
    this.surface.dispose();
    this.net.dispose();
    this.debris.dispose();
    super.dispose();
  }
}
