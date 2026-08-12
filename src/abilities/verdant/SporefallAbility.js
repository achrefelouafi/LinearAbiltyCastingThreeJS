import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { VolumeHull, HullShape, Medium } from '../../vfx/VolumeHull.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, Easing } from '../../utils/math.js';

const TAU = Math.PI * 2;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _hand = new Vector3();

/**
 * SPOREFALL — a volume that hugs the floor.
 *
 * Every other raymarched thing in the expansion goes **up**: Pyroclasm's dome,
 * Wyrm's Breath's cone, Sanguine Pact's column. This one goes sideways. A slab
 * of spore-laden air lands on the circle and pours outward across the ground,
 * pooling in the middle rather than billowing out of it, and then thins and
 * sinks. Out of it, bioluminescent motes drift up and die at head height.
 *
 * Three beats over three phases:
 *
 *   1. **seep** — a low front runs out across the floor to the circle.
 *   2. **spread & hold** — the impact phase. The slab lands gathered and thick
 *      and spreads to the boundary over `seepTime`, losing height as it gains
 *      footprint; a pool opens on the floor beneath it; motes start leaving.
 *   3. **disperse** — the fade. The slab loses its thickness, keeps creeping
 *      outward as it goes, and the pool dries back from its rim.
 *
 * **The trick, part one: the field is flattened, not the hull.** Squashing the
 * proxy alone gives a low cloud made of round blobs, which reads exactly like a
 * cloud somebody sat on. `sporeFlatten` stretches the *noise domain's* Y, so
 * every eddy in the field is a pancake, and it is the eddies rather than the
 * silhouette that say which way this substance wants to move. Take that one
 * slider to zero and the whole cast reverts to fog with a low ceiling, with
 * every other number unchanged.
 *
 * The outward pour is the **footprint growing**, not a flow vector. The first
 * version bought it from `sporeFlowX`/`sporeFlowZ`, which is the obvious
 * reading of "advected outward" and is wrong: those are world-constant, so
 * what they actually produce is a wind — the whole cloud slides off downrange
 * and leaves the circle behind. A radially outward advection is not something
 * a single flow uniform can express, and it does not need to be: a flattened
 * field inside a footprint that is widening while it thins *is* a spill.
 *
 * **The trick, part two: the motes stop.** A mote that keeps rising turns a
 * zone cast into weather. So `moteDeathHeight` is a real metre and it is
 * enforced analytically: the particle system integrates
 * `rise(t) = v·(1 − e^(−k·t))/k`, so the time at which a mote crosses a given
 * height has a closed form, and `_moteLifetime()` solves it every frame and
 * writes the answer to the system's `uLifeScale`. That is what makes the
 * ceiling a live slider — drag it with the clock stopped and every mote
 * already in the air is re-timed, and the layer they wink out in moves.
 *
 * **The rule that makes the editor work.** A cast captures one seed and the
 * moment the slab landed. Not one metre, radian or second: the slab's
 * half-extents, the pool's radius, the mote ceiling and the light's height are
 * all resolved against `settings.sporefall` inside the update loop, which runs
 * on a zero-length frame too.
 *
 * Two draw calls for the whole cast, which is the other half of "the quietest
 * zone cast in the sandbox".
 */
export class SporefallAbility extends Ability {
  constructor(context) {
    super('sporefall', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * The slab.
     *
     * BOX rather than CYLINDER, and the choice is not arbitrary: with
     * `sporeRound` near 1 a box's footprint rounds off into the same disc for
     * the same money, and turning the rounding *down* is then available as a
     * look — a spill with a straight leading edge. A cylinder can never be
     * anything but a cylinder.
     */
    this.slab = new VolumeHull({
      hull: HullShape.BOX,
      medium: Medium.SPORE,
      prefix: 'spore',
      // Deliberately low. This volume covers a lot of screen and is nearly
      // uniform inside; steps buy nothing here and coverage is the cost driver.
      maxSteps: 36,
      renderOrder: 12
    });
    this.group.add(this.slab.mesh);

    /** The standing pool the slab is lying on. One draw call, live in metres. */
    this.pool = new GroundField(this.group, {
      mode: GroundMode.POOL,
      additive: false,
      depthTest: true,
      layer: LAYER.VFX,
      renderOrder: 7,
      name: 'SporePool'
    });
    /** Live params, allocated once and refilled every frame — I1. */
    this.poolParams = groundFieldParams();
    this.poolParams.centre = new Vector3();

    /** Re-rolled per cast so two slabs do not draw the same grain. */
    this._seed = 0;
    /** Seconds since the slab landed. Drives the spread, nothing else. */
    this._spreadTime = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    /**
     * The motes. Additive, curled, and emitted with a *unit* life and a *unit*
     * speed: the real metres-per-second lives in `uSpeedScale` and the real
     * lifetime in `uLifeScale`, both rewritten every frame. That is what makes
     * `moteRise` and `moteDeathHeight` live sliders rather than numbers baked
     * into each particle at the instant it was emitted.
     */
    this.motes = particles.get('sporefall.motes', {
      capacity: 1600,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uEndSize.value = 0.35;
    this.motes.uniforms.uSizeIn.value = 0.14;
    this.motes.uniforms.uFadeIn.value = 0.16;
    // A long fade-out, because the death is meant to read as a mote *going
    // out* at a height rather than as one being deleted at a height.
    this.motes.uniforms.uFadeOut.value = 0.55;

    // Heavy air rolling off the slab's rim. Non-additive so it genuinely
    // occludes, which is what gives the slab an edge you can see past.
    this.drift = particles.get('sporefall.drift', {
      capacity: 1200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.2
    });
    this.drift.uniforms.uDrag.value = 2.4;
    this.drift.uniforms.uEndSize.value = 3.2;
    this.drift.uniforms.uSizeIn.value = 0.16;
    this.drift.uniforms.uFadeIn.value = 0.22;
    this.drift.uniforms.uFadeOut.value = 0.3;

    this.moteEmitter = new RateEmitter();
    this.driftEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    // Two meshes, and neither is instanced. The HUD readout is honest about it.
    return 2;
  }

  /** Spread out to the boundary, then lie there. */
  get impactDuration() {
    const c = settings.sporefall;
    return Math.max(0.2, (c.seepTime + c.holdTime) * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.2, settings.sporefall.disperseTime);
  }

  /** The live footprint, metres. What the indicator measured out. */
  get radius() {
    return Math.max(0.05, settings.sporefall.zoneRadius);
  }

  /**
   * A slow swell rather than a flicker.
   *
   * Everything else in this ability is deliberately still, so the light is the
   * only thing with a pulse in it, and it has to be under the frequency where
   * a viewer reads "flicker" — half a hertz, not thirty.
   */
  lightShimmer() {
    const c = settings.sporefall;
    return 1 - saturate(c.lightBreathe) * 0.5 * (1 - Math.cos(this.age * c.lightBreatheRate * TAU));
  }

  /* ------------------------------------------------------------------ */
  /* The clocks — pure functions of live settings                        */
  /* ------------------------------------------------------------------ */

  /** The middle of the circle — the far end of the aimed line. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** Where the cast leaves the caster, in world space. */
  _handPoint(out) {
    const c = settings.sporefall;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** How far the slab has spread toward the boundary, 0..1. */
  _spread() {
    const c = settings.sporefall;
    return Easing.outCubic(saturate(this._spreadTime / Math.max(0.05, c.seepTime)));
  }

  /** How far it has thinned out and sunk, 0..1. */
  _disperse() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    const c = settings.sporefall;
    return saturate(this.fadeTime / Math.max(0.05, c.disperseTime));
  }

  /**
   * Seconds a mote lives, solved from the height it is required to die at.
   *
   * The particle system integrates drag analytically:
   *
   *     rise(t) = v · (1 − e^(−k·t)) / k
   *
   * so the time at which a mote crosses `h` metres is
   * `−ln(1 − h·k/v) / k`, exactly. Past `v/k` the mote never gets there at all
   * — drag stalls it below the ceiling — so the ratio is clamped just short of
   * one and it simply lives out the asymptote instead. The alternative was to
   * kill motes on the CPU by testing their height, which needs the CPU to know
   * where they are, and the whole point of this particle system is that it
   * does not.
   *
   * `global.particleLifetime` is deliberately **not** folded in here: it would
   * scale the answer and move the ceiling off the slider that names it. It is
   * the one global multiplier this system ignores, and this comment is the
   * reason.
   */
  _moteLifetime() {
    const c = settings.sporefall;
    const g = settings.global;
    const k = Math.max(0.05, c.moteDrag);
    const v = Math.max(0.01, c.moteRise * g.particleSpeed);
    const h = Math.max(0.02, c.moteDeathHeight - c.moteBirthHeight);
    const ratio = Math.min(0.97, (h * k) / v);
    return -Math.log(1 - ratio) / k;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this.driftEmitter.reset();
    this._spreadTime = 0;

    // The one thing a cast captures, besides the timestamp the slab landed on.
    this._seed = Math.random() * 100;

    this.pool.clearMarks();
    this.slab.setFade(0);
    this.pool.setVisible(false);

    this._sync(0, 0);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings into the slab, the pool and the two particle
   * systems.
   *
   * @param {number} spread   0..1 — how far the slab has reached the boundary
   * @param {number} disperse 0..1 — how far it has thinned out and sunk
   */
  _sync(spread, disperse) {
    const c = settings.sporefall;
    const g = settings.global;
    const R = this.radius;

    this._centrePoint(_centre);

    /* --- the slab ---------------------------------------------------- */
    // It lands gathered and thick and ends up wide and thin, and it keeps
    // creeping outward the whole time it is dying, because a spill does not
    // stop at the edge of its own puddle.
    const reach =
      R * c.sporeRadius * (c.sporeGather + (1 - c.sporeGather) * spread) * (1 + c.sporeCreep * disperse);
    const thickness =
      Math.max(0.02, c.sporeThickness * (c.sporeHeap + (1 - c.sporeHeap) * spread)) *
      (1 - saturate(c.sporeSink) * disperse);

    // Fade in over the first fifth of the spread — the slab arriving instantly
    // at full density reads as a cut, and this is a substance that seeps.
    const arrive = saturate(spread * 5);
    const fade = arrive * (1 - Easing.inQuad(disperse));

    _pos.set(_centre.x, c.sporeBase, _centre.z);
    this.slab
      .place(_pos, this.direction)
      .setSize(reach, thickness, reach)
      .setFade(fade)
      .sync(c, g);

    /* --- the pool ---------------------------------------------------- */
    const p = this.poolParams;
    p.centre.copy(_centre);
    p.yaw = 0;
    p.height = c.poolHeight;
    p.radius = R * c.poolRadius;
    p.grow = spread;
    // The pool dries from its rim inward while the slab above it is still
    // spreading — the two fronts run in opposite directions, which is what
    // stops the ground and the air reading as one flat sticker.
    p.recede = disperse;
    p.fade = 1 - Easing.inQuad(disperse);
    p.seed = this._seed;

    p.edge = c.poolEdge;
    p.ragged = c.poolRagged;
    p.raggedScale = c.poolRaggedScale;
    p.warp = c.poolWarp;
    p.relief = c.poolRelief;
    p.ambient = c.poolAmbient;
    p.specular = c.poolSpecular;
    p.gloss = c.poolGloss;
    p.cell = c.poolCell;
    p.depth = c.poolDepth;
    p.flow = c.poolFlow;
    p.swirl = c.poolSwirl;
    p.detail = c.poolDetail;
    p.sharp = c.poolSharp;
    p.speed = c.poolSpeed;
    p.emissive = c.poolEmissive * g.glow;
    p.opacity = c.poolOpacity;
    p.depthFade = c.poolDepthFade;
    p.colorBase = c.colorPoolBase;
    p.colorEdge = c.colorPoolEdge;
    p.colorGlow = c.colorPoolGlow;
    p.colorDeep = c.colorPoolDeep;
    p.noiseStrength = g.noiseStrength;
    p.noiseFrequency = g.noiseFrequency;
    p.noiseSpeed = g.noiseSpeed;
    p.opacityScale = g.opacity;

    this.pool.setVisible(spread > 0.001 && p.fade > 0.004);
    this.pool.update(p);

    /* --- the two particle systems ------------------------------------ */
    this.motes.setGradient(
      getColor(c.colorMoteA),
      getColor(c.colorMoteB),
      getColor(c.colorMoteC),
      getColor(c.colorMoteD)
    );
    // Unit velocity and unit life at emit; the metres and the seconds live
    // here, where they are re-read every frame. See `_moteLifetime()`.
    this.motes.uniforms.uSpeedScale.value = c.moteRise * g.particleSpeed;
    this.motes.uniforms.uLifeScale.value = this._moteLifetime();
    this.motes.uniforms.uDrag.value = Math.max(0.05, c.moteDrag);
    this.motes.uniforms.uGravity.value.set(0, c.moteSag, 0);
    this.motes.uniforms.uSizeScale.value = c.moteSize * g.particleSize * 7;
    this.motes.uniforms.uOpacity.value = g.opacity;
    this.motes.uniforms.uGlow.value = c.moteGlow * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

    this.drift.setGradient(
      getColor(c.colorDriftA),
      getColor(c.colorDriftB),
      getColor(c.colorDriftC),
      getColor(c.colorDriftD)
    );
    this.drift.uniforms.uGravity.value.set(0, c.driftRise, 0);
    this.drift.uniforms.uSizeScale.value = c.driftSize * g.particleSize;
    this.drift.uniforms.uLifeScale.value = c.driftLifetime * 0.5 * g.particleLifetime;
    this.drift.uniforms.uSpeedScale.value = c.driftSpeed * g.particleSpeed;
    this.drift.uniforms.uOpacity.value = c.driftOpacity * g.opacity;
    this.drift.uniforms.uTurbulence.value = 0.3 * g.turbulence;
  }

  /** The soft cough of spores at the caster's hand as the seep leaves it. */
  _muzzleFx() {
    const c = settings.sporefall;
    const g = settings.global;

    this._handPoint(_hand);

    this.ctx.bursts.spawn(BurstMode.EARTH, _hand, {
      radius: c.muzzleSize * 0.3,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.6,
      intensity: c.muzzleIntensity,
      opacity: 0.4,
      fresnel: 1.2,
      displace: 0.45,
      squash: 0.7,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this._emitMotes(Math.round(18 * g.particleCount), _hand, 0.18);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.4 * g.explosionIntensity;
  }

  /**
   * Release `count` motes in a ball of `spread` metres about `at`.
   *
   * Speed and life go out as **1**. Both are scaled by uniforms that are
   * rewritten every frame, which is the whole reason the ceiling is live.
   */
  _emitMotes(count, at, spread) {
    if (count <= 0) return;
    const c = settings.sporefall;

    _emit.position = at;
    _emit.radius = spread;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 1;
    _emit.speedVariance = c.moteSpeedVariance;
    _emit.spread = c.moteSpread;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.08;
    _emit.sizeVariance = 0.6;
    _emit.life = 1;
    // Zero, and this is the point of the ability: a lifetime variance here
    // would smear the ceiling into a gradient and there would be nothing left
    // for `moteDeathHeight` to mean. The softening comes from
    // `moteSpeedVariance` instead, which widens the *band* without breaking
    // the relationship between the rise and the height.
    _emit.lifeVariance = 0;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(count, _emit);
  }

  /** A thin haze laid under the seep front while it runs out. */
  _frontFx(dt) {
    const c = settings.sporefall;
    const g = settings.global;

    const driftCount = Math.round(this.driftEmitter.tick(dt, c.driftRate * 0.5) * g.particleCount);
    if (driftCount <= 0) return;

    _emit.position = _pos.copy(this.position).setY(0.08);
    _emit.radius = 0.4;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.7).setY(0.25).normalize();
    _emit.speed = 1;
    _emit.speedVariance = 0.6;
    _emit.spread = 0.7;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.6;
    _emit.sizeVariance = 0.5;
    _emit.life = 1;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.3;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.drift.emit(driftCount, _emit);
  }

  /**
   * Motes out of the slab and drift off its rim.
   *
   * @param {number} scale 0..1 — thinned out as the slab disperses
   */
  _fieldFx(dt, scale, spread) {
    const c = settings.sporefall;
    const g = settings.global;
    const R = this.radius * spread;

    this._centrePoint(_centre);

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      const bearing = Math.random() * TAU;
      // sqrt keeps the disc evenly dense instead of crowding the middle, which
      // matters here because the middle is where the pool already is and a
      // second concentration on top of it reads as a chimney.
      const r = R * c.moteInset * Math.sqrt(Math.random());
      _pos.set(_centre.x + Math.cos(bearing) * r, c.moteBirthHeight, _centre.z + Math.sin(bearing) * r);
      this._emitMotes(moteCount, _pos, R * 0.06 + 0.05);
    }

    const driftCount = Math.round(this.driftEmitter.tick(dt, c.driftRate * scale) * g.particleCount);
    if (driftCount > 0) {
      const bearing = Math.random() * TAU;
      const r = R * c.driftInset;
      _pos.set(
        _centre.x + Math.cos(bearing) * r,
        Math.max(0.04, settings.sporefall.sporeThickness * 0.35),
        _centre.z + Math.sin(bearing) * r
      );
      _emit.position = _pos;
      _emit.radius = R * 0.1;
      // Outward and barely up. This is heavy air falling off the edge of a
      // spill, not smoke leaving a fire.
      _emit.direction = _dir.set(Math.cos(bearing), 0.1, Math.sin(bearing)).normalize();
      _emit.speed = 1;
      _emit.speedVariance = 0.55;
      _emit.spread = 0.4;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.75;
      _emit.sizeVariance = 0.5;
      _emit.life = 1;
      _emit.lifeVariance = 0.35;
      _emit.spin = 0.25;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.drift.emit(driftCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(0, 0);

    // The light rides the seep front, right down on the floor.
    this.position.y = settings.sporefall.lightHeight * 0.4;

    this._frontFx(dt);
    this.ctx.shake.rumble(settings.sporefall.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.sporefall;
    const g = settings.global;

    this._spreadTime = 0;
    this._centrePoint(_centre);

    /* the low shell as the slab lands — squashed hard, because it is a slab */
    _pos.copy(_centre).setY(c.sporeThickness * 0.5);
    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.burstSize * 0.3,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 1.1,
      intensity: c.burstIntensity,
      opacity: 0.35,
      fresnel: 1.3,
      displace: 0.5,
      squash: 0.25,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    _pos.copy(_centre).setY(c.moteBirthHeight);
    this._emitMotes(Math.round(c.burstMotes * g.particleCount), _pos, this.radius * 0.5);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      11
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.6 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.sporefall;

    if (t <= 1) this._spreadTime += dt;

    const spread = this._spread();
    const disperse = this._disperse();

    this._sync(spread, disperse);

    // The light sits in the slab, and sinks with it.
    this._centrePoint(this.position);
    this.position.y = c.lightHeight * (1 - saturate(c.sporeSink) * disperse);

    this._fieldFx(dt, (1 - disperse) * (t <= 1 ? 1 : 0.6), Math.max(0.05, spread));
  }

  onDestroy() {
    this._spreadTime = 0;
    this.slab.setFade(0);
    this.pool.setVisible(false);
    this.pool.clearMarks();
  }

  dispose() {
    this.slab.dispose();
    this.pool.dispose();
    super.dispose();
  }
}
