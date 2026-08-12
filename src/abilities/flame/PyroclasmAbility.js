import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { VolumeHull, HullShape, Medium } from '../../vfx/VolumeHull.js';
import { DistortionField, DistortionMode, DistortionFacing } from '../../vfx/Distortion.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;

/* Module-scope scratch. A standing dome allocates nothing — I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
/** The ground field's params bag, filled from settings every frame and reused. */
const _scour = groundFieldParams();
/** The heat emitter's params bag, likewise. */
const _haze = {};

/**
 * PYROCLASM — a dome of ash that **collapses before it blows**.
 *
 * A far cast. An ignition front runs out across the floor to the aimed circle;
 * a raymarched dome of ash snaps into being at the full footprint, contracts
 * onto its own centre, stands compressed while embers rain inside it, and then
 * inverts its density and blasts out past the boundary it started from. Heat
 * stands over the whole thing from the moment the front leaves the caster, and
 * the floor is scoured by the blast front as it passes over it.
 *
 * ## THE TRICK — the field is world-space, the hull is not
 *
 * `Medium.ASH` samples its fbm in `worldDomain()`: **world metres**, advected by
 * a world flow, with no knowledge whatever of the proxy hull it happens to be
 * marched inside. The hull, meanwhile, is resized every frame by `setSize()`.
 * Those two facts are decoupled on purpose and the decoupling *is* the
 * implosion. The grain of the ash is nailed to the room, so as the silhouette
 * eats inward you watch individual clots of soot pass out of the volume and
 * finer structure crowd into what is left. It reads as a mass being squeezed.
 *
 * The first version used `Medium.FLAME`, whose field is sampled in
 * `localDomain()` — hull space — because a jet of flame has to carry its own
 * turbulence when the caster turns. That is exactly wrong here: a local field
 * shrinks *with* `uSize`, so the contracting dome rendered as the same cloud
 * getting smaller, frame for frame. It looked like the camera pulling back. Not
 * one thing about the beat read until the medium changed, and no amount of
 * animating the density curve rescued it — the failure is at the level of which
 * space the noise lives in, which is not something a slider can reach.
 *
 * ## The inversion
 *
 * The blast is not "the same dome, bigger". Five uniforms are lerped by one
 * unitless beat, from the values that make a compressed mass to the values that
 * make a surge, and the ability writes them **after** `VolumeHull#sync()` — sync
 * resolves them from settings and applies the global multipliers, then this
 * class applies its own beat on top, so nothing here caches a number and
 * dragging `ashDensity` while paused still moves a blast that is already out:
 *
 *   - `HeightBias` past 1 drives the field negative near the crown, so the
 *     middle of the dome genuinely empties rather than merely thinning;
 *   - `DensityCurve` below 1 lifts the wispy fringe to nearly the weight the
 *     core used to carry;
 *   - `NoiseStrength` up, and erosion is *quadratic* in the distance past the
 *     nominal surface, so the field's weight is thrown outside the silhouette;
 *   - `Margin` up to pay for that — see the note in the settings block, and see
 *     `VolumeHull`'s "one rule". Raise erosion without margin and the ash is
 *     sliced along a dead straight line at the proxy wall;
 *   - `Density` down, because a surge is thinner than the thing it came out of.
 *
 * ## The floor
 *
 * The scour is **drawn by the front**, not spawned whole. `GroundField`'s
 * `grow` is the blast front's current radius over the mark's own radius, both
 * re-resolved every frame, so the bright lip in the shader is the actual
 * leading edge of the surge and shortening `blastSpread` mid-cast pulls the
 * burn back in with it. Spawning a decal at impact would capture its radius on
 * the frame it was born and none of that would be true.
 *
 * ## What a cast captures
 *
 * `_seed` — one dice roll so two domes are not the same cloud — and two
 * booleans recording that a one-shot has already fired. Nothing else. Every
 * metre, radian, second and colour is resolved against `settings.pyroclasm`
 * inside the update loop, on a zero-length frame included.
 *
 * ## Cost
 *
 * Three draw calls: the volume, the heat emitter, the scour. One dynamic light.
 */
export class PyroclasmAbility extends Ability {
  constructor(context) {
    super('pyroclasm', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * The dome. `maxSteps` is the compile-time loop cap, not the step count —
     * `ashSteps` drives the real one and stays a slider under it, so the shader
     * has headroom to be turned up without a recompile.
     */
    this.hull = new VolumeHull({
      hull: HullShape.DOME,
      medium: Medium.ASH,
      prefix: 'ash',
      maxSteps: 56,
      renderOrder: 12
    });
    this.group.add(this.hull.mesh);

    /**
     * The heat column. `UPRIGHT` rather than `BILLBOARD`: hot air rises along
     * world up whatever the camera is doing, and a full billboard makes the
     * plume lean over as you orbit, which reads as wind.
     */
    this.haze = new DistortionField({
      mode: DistortionMode.HEAT,
      facing: DistortionFacing.UPRIGHT,
      name: 'Pyroclasm:heat'
    });
    this.group.add(this.haze.object3D);

    /**
     * The floor. `SCOUR` and not a decal, for the reason in the class comment:
     * a decal captures its radius when it spawns and this mark has to be drawn
     * by a front whose radius is re-resolved every frame. Shaded, not additive
     * — a burn is *darker* than the stone it is on.
     */
    this.scour = new GroundField(this.group, {
      mode: GroundMode.SCOUR,
      additive: false,
      name: 'Pyroclasm:scour'
    });
    this.scour.setVisible(false);

    /** Re-rolled per cast so no two domes draw the same cloud. */
    this._seed = 0;
    /** One-shots already fired. Events, not dimensions. */
    this._collapsed = false;
    this._blasted = false;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The embers raining inside the dome. Additive and soft: these are lit
    // motes falling through soot, and the medium's own `speck` embers are
    // *inside* the volume — these are the ones that fall out of it.
    this.embers = particles.get('pyroclasm.embers', {
      capacity: 2400,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.embers.uniforms.uDrag.value = 1.1;
    this.embers.uniforms.uEndSize.value = 0.2;
    this.embers.uniforms.uSizeIn.value = 0.05;
    this.embers.uniforms.uFadeIn.value = 0.06;
    this.embers.uniforms.uFadeOut.value = 0.42;

    // The pall that gets out of the dome. Non-additive so it genuinely
    // occludes — an ash cloud that adds light to the scene is a fog machine.
    this.pall = particles.get('pyroclasm.pall', {
      capacity: 2000,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.2
    });
    this.pall.uniforms.uDrag.value = 1.9;
    this.pall.uniforms.uEndSize.value = 3.4;
    this.pall.uniforms.uSizeIn.value = 0.12;
    this.pall.uniforms.uFadeIn.value = 0.18;
    this.pall.uniforms.uFadeOut.value = 0.32;

    // Chips off the floor: under the front while it runs, and thrown wide by
    // the blast.
    this.grit = particles.get('pyroclasm.grit', {
      capacity: 1600,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.grit.uniforms.uDrag.value = 0.28;
    this.grit.uniforms.uEndSize.value = 0.75;
    this.grit.uniforms.uFadeOut.value = 0.72;

    this.emberEmitter = new RateEmitter();
    this.pallEmitter = new RateEmitter();
    this.gritEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** Nothing here is instanced; the HUD readout counts the three shaders. */
  get instanceCount() {
    return 3;
  }

  /** The contraction, then the compressed hold. */
  get impactDuration() {
    const c = settings.pyroclasm;
    return Math.max(0.1, (c.collapseTime + c.holdTime) * settings.global.lifetime);
  }

  /** The blast, then the settle. */
  get fadeDuration() {
    const c = settings.pyroclasm;
    return Math.max(0.1, c.blastTime + c.settleTime);
  }

  /** Ash smothers the light rather than letting it strobe: a slow, deep breath. */
  lightShimmer() {
    return 0.82 + 0.18 * Math.sin(this.age * 4.1) * Math.sin(this.age * 1.7);
  }

  /* ------------------------------------------------------------------ */
  /* The beats — pure functions of the phase clocks and live settings     */
  /* ------------------------------------------------------------------ */

  /**
   * Every one of these re-reads its own duration from settings, so re-timing a
   * beat re-times a dome that is already standing. They are pure: nothing here
   * writes state, which is what lets `onFade` call them four times a frame
   * without worrying about the order.
   */

  /** 0..1 through the contraction. */
  _collapseBeat() {
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    if (this.phase !== AbilityPhase.IMPACT) return 1;
    return saturate(this.impactTime / Math.max(0.02, settings.pyroclasm.collapseTime));
  }

  /** 0..1 through the blast front's run outward. */
  _blastBeat() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    return saturate(this.fadeTime / Math.max(0.02, settings.pyroclasm.blastTime));
  }

  /** 0..1 through the settle that follows it. */
  _settleBeat() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    const c = settings.pyroclasm;
    return saturate((this.fadeTime - c.blastTime) / Math.max(0.05, c.settleTime));
  }

  /**
   * How far the density has inverted, 0..1.
   *
   * Cubed off the front of the blast so the field flips *before* the silhouette
   * has finished travelling — the ash has to already be coming apart when it
   * crosses the old boundary, or the surge reads as a balloon.
   */
  _invert() {
    return Easing.outCubic(this._blastBeat());
  }

  /** Master fade. The settle thins the medium; `setFade` does the rest. */
  _fadeAmount() {
    if (this.phase !== AbilityPhase.FADE) return 1;
    return 1 - Easing.inQuad(this._settleBeat());
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The centre of the footprint — the far end of the aimed line. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /**
   * Where the front leaves the caster's hand, in world space.
   *
   * The base class puts `origin` on the floor because that is what the circle
   * indicator is measured from; ash comes off a hand, so the offsets live here
   * rather than being baked into the cast.
   */
  _handPoint(out) {
    const c = settings.pyroclasm;
    out.copy(this.origin).addScaledVector(this.direction, c.handForward);
    out.y = c.handHeight;
    return out;
  }

  /** The ash's ground radius right now, metres. */
  _ashRadius() {
    const c = settings.pyroclasm;
    const R = Math.max(0.05, c.zoneRadius);
    if (this.phase === AbilityPhase.FADE) {
      return R * lerp(c.collapseRadius, c.blastSpread, Easing.outCubic(this._blastBeat()));
    }
    // inOutCubic, not outCubic: the dome has to *hesitate* at full radius for a
    // fraction of a second before it starts to go, or the collapse has no
    // moment of stillness to collapse away from.
    return R * lerp(c.formSpread, c.collapseRadius, Easing.inOutCubic(this._collapseBeat()));
  }

  /**
   * Its height, metres.
   *
   * It stands *up* as it narrows — the same mass squeezed into a smaller
   * footprint has to go somewhere — and runs low and wide once it lets go.
   */
  _ashHeight() {
    const c = settings.pyroclasm;
    const R = Math.max(0.05, c.zoneRadius);
    if (this.phase === AbilityPhase.FADE) {
      return R * lerp(c.compressHeight, c.blastHeight, Easing.outCubic(this._blastBeat()));
    }
    return R * lerp(c.formHeight, c.compressHeight, Easing.inOutCubic(this._collapseBeat()));
  }

  /**
   * How far the char reaches, metres.
   *
   * Before the blast it is a fixed seat under the compressed dome; during the
   * blast it is the surge's own skirt. That is the whole "drawn by the front"
   * claim, and it is one `Math.max`.
   */
  _charFront() {
    const c = settings.pyroclasm;
    const seat = Math.max(0.05, c.zoneRadius) * c.charSeat;
    return this.phase === AbilityPhase.FADE ? Math.max(seat, this._ashRadius()) : seat;
  }

  /** Yaw of the cast, radians — the frame the scour's grain is authored in. */
  _yaw() {
    return Math.atan2(this.direction.x, this.direction.z);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.emberEmitter.reset();
    this.pallEmitter.reset();
    this.gritEmitter.reset();

    this._collapsed = false;
    this._blasted = false;
    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;

    this.scour.setVisible(false);
    this._sync(1);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current beat into the volume, the heat
   * column, the scour and the three particle systems.
   *
   * @param {number} fade 1 while the ash holds, ramping to 0 as it settles
   */
  _sync(fade) {
    this._centrePoint(_centre);
    this._syncVolume(fade);
    this._syncHaze(fade);
    this._syncScour(fade);
    this._syncParticles();
  }

  /** The dome, and the five uniforms the inversion drives on top of `sync()`. */
  _syncVolume(fade) {
    const c = settings.pyroclasm;
    const g = settings.global;
    const travelling = this.phase === AbilityPhase.TRAVEL;

    const radius = this._ashRadius();
    const height = this._ashHeight();
    const invert = this._invert();
    const margin = lerp(c.ashMargin, c.blastMargin, invert);

    /**
     * Margin compensation, and it is not optional.
     *
     * `Margin` holds the medium's nominal surface that fraction of the way
     * *inside* the proxy, so a hull sized at the radius you want draws ash at
     * `radius × (1 − margin)`. That is fine until the beat drives the margin —
     * and this one does, from 0.24 to 0.46, to pay for the erosion. Without the
     * division the blast came out at 0.54 of its authored spread and never
     * crossed the boundary it is supposed to blow through, so `blastSpread` was
     * quietly a lie and turning it up to compensate broke the collapse instead.
     * Dividing here makes `_ashRadius()` mean the radius of the *ash*.
     *
     * `hullSlack` is the small extra on top, for the erosion to spill into.
     * Note `setSize`, never `mesh.scale`: the march's parameter is in world
     * metres only because the hull's matrix stays rigid.
     */
    const k = Math.max(1, c.hullSlack) / Math.max(0.2, 1 - margin);

    this.hull
      .place(_centre)
      .setSize(radius * k, height * k, radius * k)
      .setFade(travelling ? 0 : fade)
      .sync(c, g);

    // ---- the inversion, applied over the top of the resolved uniforms ----
    // Multiplicative where `sync()` already folded in a global multiplier or
    // the fade (NoiseStrength, Density), absolute where it did not. Doing it
    // this way rather than writing into `settings` keeps the block the single
    // source of truth and keeps every one of these live under a paused clock.
    const u = this.hull.material.uniforms;
    u.uHeightBias.value = lerp(c.ashHeightBias, c.blastHeightBias, invert);
    u.uDensityCurve.value = lerp(c.ashDensityCurve, c.blastDensityCurve, invert);
    u.uMargin.value = margin;
    u.uNoiseStrength.value *= lerp(1, c.blastErosion, invert);
    u.uDensity.value *= lerp(1, c.blastDensity, invert);
    u.uRise.value = lerp(c.ashRise, c.blastRise, invert) * g.noiseSpeed;
  }

  /** The heat standing over it — on the front while it travels, on the dome after. */
  _syncHaze(fade) {
    const c = settings.pyroclasm;
    const g = settings.global;
    const travelling = this.phase === AbilityPhase.TRAVEL;

    const radius = travelling ? Math.max(0.05, c.zoneRadius) * c.collapseRadius : this._ashRadius();
    const anchor = travelling ? this.position : _centre;
    this.haze.setAnchorXYZ(anchor.x, c.hazeLift, anchor.z);

    _haze.width = radius * c.hazeWidth * (travelling ? c.hazeTravel : 1);
    _haze.height = radius * c.hazeHeight;
    // Screen fractions. `post.distortion` and `global.distortion` are applied
    // once, by the pass — multiplying them in here would apply them twice.
    _haze.strength = c.hazeStrength;
    _haze.opacity = fade;
    _haze.seed = this._seed;
    _haze.frequency = c.hazeFrequency * g.noiseFrequency;
    _haze.speed = c.hazeSpeed * g.noiseSpeed;
    _haze.sourceBias = c.hazeSourceBias;
    _haze.spread = c.hazeSpread;
    _haze.vertical = c.hazeVertical;
    _haze.flicker = c.hazeFlicker;
    _haze.perspective = c.hazePerspective;
    _haze.perspectiveRef = c.hazePerspectiveRef;
    _haze.depthReject = c.hazeDepthReject;
    _haze.depthFade = c.hazeDepthFade;
    this.haze.update(_haze);

    // Toggle the *field*, never the parent group: `visible` is what retains and
    // releases the pass's writer counter, and hiding the group behind its back
    // leaks the counter for the session.
    this.haze.visible = fade > 0.01;
  }

  /** The floor, drawn by the front passing over it. */
  _syncScour(fade) {
    const c = settings.pyroclasm;
    const g = settings.global;
    const radius = Math.max(0.1, Math.max(0.05, c.zoneRadius) * c.scorchSpread);

    _scour.centre = _centre;
    _scour.yaw = this._yaw();
    _scour.height = c.scorchHeight;
    _scour.radius = radius;
    // The growth front, in the shader's own terms: how far out of its own
    // radius the burn has been drawn. Both numbers are metres resolved this
    // frame, so pulling `blastSpread` in pulls the burn in with it.
    _scour.grow = saturate(this._charFront() / radius);
    _scour.recede = 0;
    _scour.fade = fade;
    _scour.seed = this._seed;

    _scour.edge = c.scorchEdge;
    _scour.ragged = c.scorchRagged;
    _scour.raggedScale = c.scorchRaggedScale;
    _scour.warp = c.scorchWarp;

    _scour.relief = c.scorchRelief;
    _scour.normalStep = c.scorchNormalStep;
    _scour.ambient = c.scorchAmbient;
    _scour.wrap = c.scorchWrap;
    _scour.specular = c.scorchSpecular;
    _scour.gloss = c.scorchGloss;
    _scour.parallax = c.scorchParallax;

    _scour.depth = c.scorchDepth;
    _scour.lift = c.scorchLift;
    _scour.arms = c.scorchArms;
    _scour.swirl = c.scorchSwirl;
    _scour.sharp = c.scorchSharp;
    _scour.detail = c.scorchDetail;
    _scour.speed = c.scorchTurn;

    _scour.additive = false;
    _scour.emissive = c.scorchEmissive;
    _scour.opacity = c.scorchOpacity;
    _scour.depthFade = c.scorchDepthFade;
    _scour.colorBase = c.colorScorchBase;
    _scour.colorEdge = c.colorScorchEdge;
    _scour.colorGlow = c.colorScorchGlow;
    _scour.colorDeep = c.colorScorchDeep;

    _scour.noiseStrength = g.noiseStrength;
    _scour.noiseFrequency = g.noiseFrequency;
    _scour.noiseSpeed = g.noiseSpeed;
    _scour.opacityScale = g.opacity;

    this.scour.update(_scour);
    this.scour.setVisible(this.phase !== AbilityPhase.TRAVEL && fade > 0.004);
  }

  /** The three particle systems. */
  _syncParticles() {
    const c = settings.pyroclasm;
    const g = settings.global;

    this.embers.setGradient(
      getColor(c.colorEmberA),
      getColor(c.colorEmberB),
      getColor(c.colorEmberC),
      getColor(c.colorEmberD)
    );
    this.embers.uniforms.uGravity.value.set(0, c.emberFall, 0);
    this.embers.uniforms.uSizeScale.value = c.emberSize * g.particleSize * 7;
    this.embers.uniforms.uLifeScale.value = c.emberLifetime * 0.5 * g.particleLifetime;
    this.embers.uniforms.uSpeedScale.value = g.particleSpeed;
    this.embers.uniforms.uOpacity.value = g.opacity;
    this.embers.uniforms.uGlow.value = c.emberGlow * g.glow;
    this.embers.uniforms.uTurbulence.value = c.emberTurbulence * g.turbulence;

    this.pall.setGradient(
      getColor(c.colorPallA),
      getColor(c.colorPallB),
      getColor(c.colorPallC),
      getColor(c.colorPallD)
    );
    this.pall.uniforms.uGravity.value.set(0, c.pallRise, 0);
    this.pall.uniforms.uSizeScale.value = c.pallSize * g.particleSize;
    this.pall.uniforms.uLifeScale.value = c.pallLifetime * 0.5 * g.particleLifetime;
    this.pall.uniforms.uSpeedScale.value = c.pallSpeed * g.particleSpeed;
    this.pall.uniforms.uOpacity.value = c.pallOpacity * g.opacity;
    this.pall.uniforms.uTurbulence.value = 0.4 * g.turbulence;

    this.grit.setGradient(
      getColor(c.colorGritA),
      getColor(c.colorGritB),
      getColor(c.colorGritC),
      getColor(c.colorGritD)
    );
    this.grit.uniforms.uGravity.value.set(0, c.gritGravity, 0);
    this.grit.uniforms.uSizeScale.value = c.gritSize * g.particleSize * 7;
    this.grit.uniforms.uLifeScale.value = g.particleLifetime;
    this.grit.uniforms.uSpeedScale.value = g.particleSpeed;
    this.grit.uniforms.uOpacity.value = g.opacity;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** The cough of hot ash at the caster's hand as the front leaves it. */
  _muzzleFx() {
    const c = settings.pyroclasm;
    const g = settings.global;

    this._handPoint(_pos);

    _emit.position = _pos;
    _emit.radius = 0.24;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.7).setY(0.5).normalize();
    _emit.speed = c.pallSpeed * 2.4;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.7;
    _emit.sizeVariance = 0.6;
    _emit.life = c.pallLifetime * 0.6;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.5;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.pall.emit(Math.round(14 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.35 * g.explosionIntensity;
  }

  /** Grit and haze thrown up under the ignition front while it runs out. */
  _frontFx(dt) {
    const c = settings.pyroclasm;
    const g = settings.global;
    const time = frame.uTime.value;

    const gritCount = Math.round(this.gritEmitter.tick(dt, c.gritRate) * g.particleCount);
    if (gritCount > 0) {
      _emit.position = _pos.copy(this.position).setY(0.06);
      _emit.radius = Math.max(0.05, c.zoneRadius) * 0.12;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.45).setY(1).normalize();
      _emit.speed = c.gritSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.8;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.gritLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 9;
      _emit.tint = null;
      _emit.time = time;
      this.grit.emit(gritCount, _emit);
    }

    const pallCount = Math.round(this.pallEmitter.tick(dt, c.pallRate * 0.35) * g.particleCount);
    if (pallCount > 0) {
      _emit.position = _pos.copy(this.position).setY(0.2);
      _emit.radius = Math.max(0.05, c.zoneRadius) * 0.2;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.pallSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.95;
      _emit.size = 0.6;
      _emit.sizeVariance = 0.5;
      _emit.life = c.pallLifetime * 0.7;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.4;
      _emit.time = time;
      this.pall.emit(pallCount, _emit);
    }
  }

  /**
   * What the standing dome sheds: embers raining down its inside, pall leaking
   * off its skirt, grit skittering at its foot.
   *
   * @param {number} scale 0..1 — thinned out as the surge dies
   */
  _domeFx(dt, scale) {
    const c = settings.pyroclasm;
    const g = settings.global;
    const time = frame.uTime.value;
    const radius = this._ashRadius();
    const height = this._ashHeight();

    /* --- embers, born up inside the dome and falling --- */
    const emberCount = Math.round(this.emberEmitter.tick(dt, c.emberRate * scale) * g.particleCount);
    if (emberCount > 0) {
      const a = Math.random() * TAU;
      // sqrt keeps the disc evenly dense; a bare random piles them on the axis.
      const r = radius * c.emberInset * Math.sqrt(Math.random());
      _pos.set(_centre.x + Math.cos(a) * r, height * c.emberCeiling * Math.random(), _centre.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = radius * 0.1;
      _emit.direction = _dir.set(0, -1, 0);
      _emit.speed = c.emberSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.7;
      _emit.life = c.emberLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.embers.emit(emberCount, _emit);
    }

    /* --- pall leaking off the skirt, outward and barely up --- */
    const pallCount = Math.round(this.pallEmitter.tick(dt, c.pallRate * scale) * g.particleCount);
    if (pallCount > 0) {
      const a = Math.random() * TAU;
      const r = radius * randRange(0.78, 1.04);
      _pos.set(_centre.x + Math.cos(a) * r, randRange(0.05, 0.45) * height, _centre.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = radius * 0.16;
      _emit.direction = _dir.set(Math.cos(a), 0.32, Math.sin(a)).normalize();
      _emit.speed = c.pallSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.75;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.95;
      _emit.sizeVariance = 0.5;
      _emit.life = c.pallLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.4;
      _emit.tint = null;
      _emit.time = time;
      this.pall.emit(pallCount, _emit);
    }

    /* --- grit skittering at its foot --- */
    const gritCount = Math.round(this.gritEmitter.tick(dt, c.gritRate * scale) * g.particleCount);
    if (gritCount > 0) {
      const a = Math.random() * TAU;
      const r = radius * randRange(0.6, 1.02);
      _pos.set(_centre.x + Math.cos(a) * r, 0.05, _centre.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = radius * 0.1;
      _emit.direction = _dir.set(Math.cos(a) * 0.7, 1, Math.sin(a) * 0.7).normalize();
      _emit.speed = c.gritSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.7;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.gritLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 9;
      _emit.tint = null;
      _emit.time = time;
      this.grit.emit(gritCount, _emit);
    }
  }

  /** The moment the contraction bottoms out: a compressed thump, no spread. */
  _collapseFx() {
    const c = settings.pyroclasm;
    const g = settings.global;

    _pos.copy(_centre).setY(this._ashHeight() * 0.4);
    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.burstSize * 0.15,
      endRadius: c.burstSize * 0.55 * g.explosionIntensity,
      life: 0.5,
      intensity: c.burstIntensity,
      opacity: 0.6,
      fresnel: 1.7,
      displace: 0.7,
      squash: 0.7,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.collapseFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.7 * g.explosionIntensity;
  }

  /** The moment it lets go. */
  _blastFx() {
    const c = settings.pyroclasm;
    const g = settings.global;
    const time = frame.uTime.value;
    const radius = Math.max(0.05, c.zoneRadius);

    _pos.copy(_centre).setY(radius * c.blastHeight * 0.5);
    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: c.blastBurstSize * 0.2,
      endRadius: c.blastBurstSize * g.explosionIntensity,
      life: 0.9,
      intensity: c.blastBurstIntensity,
      opacity: 0.85,
      fresnel: 1.4,
      displace: 0.75,
      squash: 0.55,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _centre, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.75,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* embers, pall and grit all thrown outward at once */
    _pos.copy(_centre).setY(radius * c.blastHeight * 0.45);
    _emit.position = _pos;
    _emit.radius = radius * c.collapseRadius;
    _emit.direction = _dir.set(0, 0.55, 0);
    _emit.speed = c.emberSpeed * 5.5;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.11;
    _emit.sizeVariance = 0.8;
    _emit.life = c.emberLifetime * 1.3;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.embers.emit(Math.round(c.emberBurst * g.particleCount), _emit);

    _emit.speed = c.pallSpeed * 4.5;
    _emit.spread = 1.0;
    _emit.size = 1.4;
    _emit.life = c.pallLifetime * 1.25;
    _emit.spin = 0.6;
    this.pall.emit(Math.round(c.pallBurst * g.particleCount), _emit);

    _pos.copy(_centre).setY(0.1);
    _emit.position = _pos;
    _emit.radius = radius * c.collapseRadius * 1.2;
    _emit.direction = _dir.set(0, 0.75, 0);
    _emit.speed = c.gritSpeed * 2.4;
    _emit.spread = 1.0;
    _emit.size = 0.13;
    _emit.life = c.gritLifetime * 1.3;
    _emit.spin = 11;
    this.grit.emit(Math.round(c.gritBurst * g.particleCount), _emit);

    this.ctx.shake.add(
      c.blastShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      24
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.blastFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.8 * g.explosionIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1);

    // The light rides the front, just off the floor.
    this.position.y = 0.4;

    this._frontFx(dt);
    this.ctx.shake.rumble(settings.pyroclasm.rumble * 0.5 * settings.global.cameraShake, dt);
  }

  /** The front arrives: the dome snaps into being at the full footprint. */
  onImpact() {
    const c = settings.pyroclasm;
    const g = settings.global;

    this._centrePoint(_centre);

    _pos.copy(_centre).setY(Math.max(0.05, c.zoneRadius) * c.formHeight * 0.35);
    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.8,
      intensity: c.burstIntensity,
      opacity: 0.7,
      fresnel: 1.5,
      displace: 0.65,
      squash: 0.6,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this.lightBoost = c.lightIntensity * 0.9 * g.explosionIntensity;
  }

  onFade(dt, _t) {
    const c = settings.pyroclasm;
    this._centrePoint(_centre);

    // Two one-shots, both gated on a boolean so a paused frame cannot re-fire
    // them. The blast is the phase change itself; the collapse is an event
    // *inside* the impact phase, which is why it is polled rather than hooked.
    if (!this._collapsed && this._collapseBeat() >= 1) {
      this._collapsed = true;
      this._collapseFx();
    }
    if (!this._blasted && this.phase === AbilityPhase.FADE) {
      this._blasted = true;
      this._blastFx();
    }

    const fade = this._fadeAmount();
    this._sync(fade);

    // The light sits inside the dome and rides it out.
    this.position.copy(_centre);
    this.position.y = this._ashHeight() * saturate(c.lightHeight);

    this._domeFx(dt, fade * (this.phase === AbilityPhase.FADE ? 0.55 : 1));
    this.ctx.shake.rumble(c.rumble * fade * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._collapsed = false;
    this._blasted = false;
    // The emitter's own flag, not the group's: hiding the parent leaks the
    // distortion pass's writer counter for the rest of the session.
    this.haze.visible = false;
    this.hull.setFade(0);
    this.scour.setVisible(false);
  }

  dispose() {
    this.hull.dispose();
    this.haze.dispose();
    this.scour.dispose();
    super.dispose();
  }
}
