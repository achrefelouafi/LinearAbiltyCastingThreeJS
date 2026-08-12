import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { GrowthField, GrowthLayout, GrowthEmerge, growthParams } from '../../vfx/GrowthField.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { createBoneRibGeometry, createBoneMaterial } from '../../materials/BoneRibMaterial.js';
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
const _hand = new Vector3();

/**
 * BONE CAGE — the argument that a school is not a palette.
 *
 * **THE TRICK: it is a completely different material.** Crimson Tide is
 * standing two metres away being viscous, wet, red and self-lit. This is the
 * same school, and every one of those four properties is inverted on purpose:
 * warm subsurface scatter instead of a specular sheen, chalky micro-roughness
 * pinned near 0.95 instead of a wet groove, an emissive term that is **capped
 * below the bloom threshold** instead of one that blooms, and a fresnel-shaped
 * curve applied to the *albedo* instead of a fresnel rim on the silhouette.
 * The contrast standing next to the tide is the slot. See
 * `materials/BoneRibMaterial.js` for the three terms that carry it — the
 * anti-fresnel is the one to take to zero if you want to see what chalk is.
 *
 * ## What it does
 *
 * A ring of ribs punches up out of the floor around the circle and lays over
 * it. `GrowthField(ZONE)` scales its lean by each record's radial fraction, so
 * the ribs at the rim go over hard and the ones near the middle stand nearly
 * upright — which makes the field a **dome** rather than a fence, for free, out
 * of one slider.
 *
 * The ribs themselves are straight, and that is a decision rather than an
 * oversight; the arithmetic that forced it is written up on
 * `createBoneRibGeometry`. The short version: `GrowthField` orients an instance
 * by tipping its local +Y toward a lean vector and rolling it about its own
 * axis, and no local axis maps to a consistent world bearing under that, so a
 * curve baked into the geometry points inward at one bearing on the ring and
 * sideways ninety degrees round from it. The first cage had a proper sickle in
 * it and slewed off tangentially on two sides.
 *
 * ## The beats
 *
 *  1. **reach** — the cast runs out to the circle. One cough of dust, nothing
 *     standing.
 *  2. **raise** — impact. `triggerRadial(..., invert)` fires the ribs from the
 *     **rim inward** over `raiseTime`, each punching a crater in the flagstone
 *     it comes through: `onBreach` posts a unitless mark to a
 *     `GroundField(POCK)`, which is the whole reason that module carries an
 *     event list.
 *  3. **close** — the lean ramps from `ribLeanOpen` to `ribLeanShut` over
 *     `closeTime`. This is the only animation in the ability and it is a
 *     *transform*, not geometry: the shape cache would rebuild sixty times a
 *     second if the arch lived in the mesh.
 *  4. **hold**, then **crumble** — the field retracts into the floor and the
 *     material withers. Bone does not blow out; it goes back under.
 *
 * ## What a cast captures
 *
 * One seed and one timestamp per rib, both handed to `GrowthField#plant`, which
 * rolls nothing but unitless fractions. Every metre — rib length, rib girth,
 * ring radius, crater size, the lean in radians — re-resolves from
 * `settings.bonecage` inside `update()`, on a zero-length frame included. Pause
 * mid-close and drag `ribLeanShut` and the standing cage opens.
 *
 * **Four draw calls**: three rib silhouettes and the cracked floor.
 */
export class BonecageAbility extends Ability {
  constructor(context) {
    super('bonecage', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.boneMaterial = createBoneMaterial(this.ctx.environment);

    /**
     * Three silhouettes. Three is the house recommendation and it is right
     * here for a reason the doc on `GrowthField` states well: per-instance
     * scaling buys proportion variety and only distinct geometry buys *facet*
     * variety. A ribcage of one bone scaled forty ways reads as a prop the
     * moment the camera moves, and a ribcage is exactly the object where a
     * viewer knows the bones should not match.
     */
    /**
     * The geometry sliders, held in one object and refilled every frame.
     * `syncGeometry()` hashes it and only rebuilds when a number has actually
     * moved, so this is a live shape control rather than sixty rebuilds a
     * second — which is also why the *arch* cannot live in here.
     */
    this._shape = {
      ribSides: 7,
      ribRings: 12,
      ribFlatten: 0.44,
      ribTwist: 0.18,
      ribGroove: 0.3,
      ribHead: 1.05,
      ribNeck: 0.52,
      ribShaft: 0.7,
      ribTaper: 0.1,
      ribKnuckle: 0.2,
      ribWarp: 0.28
    };

    this.ribs = new GrowthField(this.group, {
      geometry: createBoneRibGeometry,
      material: this.boneMaterial,
      shape: this._shape,
      variants: 3,
      capacity: 288,
      layer: LAYER.WORLD,
      renderOrder: 2,
      castShadow: true,
      receiveShadow: true
    });

    /** Live params, allocated once and refilled every frame — I1. */
    this.ribParams = growthParams();
    this.ribParams.layout = GrowthLayout.ZONE;
    this.ribParams.emerge = GrowthEmerge.PUSH;
    this.ribParams.centre = new Vector3();
    this.ribParams.origin = new Vector3();
    this.ribParams.direction = new Vector3(0, 0, 1);
    this.ribParams.side = new Vector3(1, 0, 0);

    /**
     * The floor each rib came through. `POCK` exists for exactly this: an event
     * list of *unitless* hits with timestamps, so the craters re-place and
     * re-scale themselves when the zone radius slider moves under a standing
     * cage.
     */
    this.floor = new GroundField(this.group, {
      mode: GroundMode.POCK,
      marks: 16,
      additive: false,
      depthTest: true,
      layer: LAYER.VFX,
      renderOrder: 6,
      name: 'BonecageFloor'
    });
    this.floorParams = groundFieldParams();
    this.floorParams.centre = new Vector3();

    /** The middle of the circle, refreshed every frame before the field updates. */
    this._centre = new Vector3();
    /** Seconds since the first rib was called. Drives the raise and the close. */
    this._riseTime = 0;
    /** Re-rolled per cast so two cages are not the same skeleton. */
    this._seed = 0;

    /**
     * Assigned **once**, at construction — I3. A rib breaking the surface
     * cracks the flagstone it came through and throws the pieces.
     */
    this.ribs.onBreach = (index, position, radius, height) => this._onBreach(position, radius, height);
  }

  createParticles() {
    const particles = this.ctx.particles;

    /**
     * Floor chips. `lit` and non-additive, because everything about this slot
     * is "no glow": these are lumps of the stage's own flagstone catching the
     * key light, and an additive chip would be a spark.
     */
    this.grit = particles.get('bonecage.grit', {
      capacity: 1200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.grit.uniforms.uDrag.value = 0.3;
    this.grit.uniforms.uEndSize.value = 0.7;
    this.grit.uniforms.uFadeOut.value = 0.65;

    /** Stone and bone dust. Non-additive so it genuinely occludes. */
    this.dust = particles.get('bonecage.dust', {
      capacity: 1100,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.dust.uniforms.uDrag.value = 2.2;
    this.dust.uniforms.uEndSize.value = 2.6;
    this.dust.uniforms.uSizeIn.value = 0.16;
    this.dust.uniforms.uFadeIn.value = 0.2;
    this.dust.uniforms.uFadeOut.value = 0.35;

    this.dustEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.ribs.count;
  }

  get impactDuration() {
    const c = settings.bonecage;
    return Math.max(0.2, (c.raiseTime + c.closeTime + c.holdTime) * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.2, settings.bonecage.crumbleTime);
  }

  /** The live footprint, metres. What the indicator measured out. */
  get radius() {
    return Math.max(0.1, settings.bonecage.zoneRadius);
  }

  /**
   * Bone does not flicker and it does not pulse. The light this cast owns is a
   * lamp inside a closed cage, so all it is allowed to do is sit still and get
   * a fraction dimmer as the ribs lay over and shut it in.
   */
  lightShimmer() {
    const c = settings.bonecage;
    return 1 - saturate(c.lightSmother) * this._closure();
  }

  /* ------------------------------------------------------------------ */
  /* The clocks — pure functions of live settings                        */
  /* ------------------------------------------------------------------ */

  /** The middle of the circle — the far end of the aimed line. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** Where the cast leaves the caster. */
  _handPoint(out) {
    const c = settings.bonecage;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** How far through the raise the ring is, 0..1. */
  _raise() {
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    return saturate(this._riseTime / Math.max(0.05, settings.bonecage.raiseTime));
  }

  /** How far the cage has laid over, 0..1. Starts once the ring is up. */
  _closure() {
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    const c = settings.bonecage;
    return Easing.outCubic(saturate((this._riseTime - c.raiseTime) / Math.max(0.05, c.closeTime)));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.dustEmitter.reset();
    this._riseTime = 0;
    this._seed = Math.random() * 100;

    this.ribs.clear();
    this.ribs.plant(Math.round(settings.bonecage.ribCount), 0);
    this.floor.clearMarks();
    this.floor.setVisible(false);

    this.boneMaterial.userData.setWither(0);
    this._sync(0);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * A rib breaking the surface.
   *
   * The crater is posted to the ground field as `(x, z)` **fractions of the
   * zone radius** and a timestamp — nothing with a unit crosses this boundary,
   * which is what lets the whole set of craters re-place themselves when the
   * radius slider moves on a cage that is already standing.
   *
   * @param {THREE.Vector3} position world, where it came through
   * @param {number} radius  the rib's own base radius, metres
   * @param {number} height  its full height, metres
   */
  _onBreach(position, radius, height) {
    const c = settings.bonecage;
    const g = settings.global;
    const R = this.radius;

    this.floor.mark(
      (position.x - this._centre.x) / R,
      (position.z - this._centre.z) / R,
      this.age,
      saturate(0.4 + radius / Math.max(0.05, c.ribGirth) * 0.6)
    );

    const chips = Math.round(c.breachGrit * g.particleCount);
    if (chips > 0) {
      _emit.position = _pos.copy(position).setY(0.05);
      _emit.radius = radius * 1.6;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.gritSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.85;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.gritLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 9;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.grit.emit(chips, _emit);
    }

    // A rib two metres long moves more floor than a stub does. Scaled by the
    // instance's own height, which is itself resolved from settings, so this
    // number is never written down.
    const puff = Math.round(c.breachDust * g.particleCount * saturate(height / Math.max(0.1, c.ribLength)));
    if (puff > 0) {
      _emit.position = _pos.copy(position).setY(0.08);
      _emit.radius = radius * 2.2;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.9;
      _emit.size = 0.55;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.time = frame.uTime.value;
      this.dust.emit(puff, _emit);
    }
  }

  /**
   * Push the live settings into the rib field, the cracked floor, the bone
   * material and both particle systems.
   *
   * @param {number} rot 0..1 — how far through the crumble the cage is
   */
  _sync(rot) {
    const c = settings.bonecage;
    const g = settings.global;
    const R = this.radius;
    const close = this._closure();

    this._centrePoint(this._centre);

    /* --- the geometry sliders, rebuilt only when a number actually moves --- */
    const shape = this._shape;
    shape.ribSides = Math.max(4, Math.round(c.ribSides));
    shape.ribRings = Math.max(5, Math.round(c.ribRings));
    shape.ribFlatten = c.ribFlatten;
    shape.ribTwist = c.ribTwist;
    shape.ribGroove = c.ribGroove;
    shape.ribHead = c.ribHead;
    shape.ribNeck = c.ribNeck;
    shape.ribShaft = c.ribShaft;
    shape.ribTaper = c.ribTaper;
    shape.ribKnuckle = c.ribKnuckle;
    shape.ribWarp = c.ribWarp;
    this.ribs.syncGeometry(shape);

    /* --- the ring --------------------------------------------------------- */
    const p = this.ribParams;
    p.centre.copy(this._centre);
    p.origin.copy(this.origin);
    p.direction.copy(this.direction);
    p.side.copy(this.side);
    p.radius = R * c.ribRing;
    p.innerRadius = R * c.ribInner;
    p.radialCurve = c.ribRadialCurve;
    p.radialJitter = c.ribRadialJitter;
    p.angleJitter = c.ribAngleJitter;

    p.heightNear = c.ribLengthInner;
    p.height = c.ribLength;
    p.heightCurve = c.ribLengthCurve;
    p.heightJitter = c.ribLengthJitter;
    p.minHeight = 0.05;

    p.radiusNear = c.ribGirthInner;
    p.radius2 = c.ribGirth;
    p.radiusCurve = c.ribGirthCurve;
    p.radiusJitter = c.ribGirthJitter;
    p.minRadius = 0.02;

    // Negative, and that is the whole cage: `lean` tips an instance's +Y toward
    // the outward radial, so a negative angle lays it **inward** over the zone.
    // `leanForward` is zero because a cage has no downrange — the fence that
    // reading gives you was the first version and it looked like a palisade.
    p.lean = -(c.ribLeanOpen + (c.ribLeanShut - c.ribLeanOpen) * close);
    p.leanJitter = c.ribLeanJitter;
    // High on purpose: the lean is already scaled by `record.radial` inside the
    // module, and this compounds it, so the middle of the field stands up
    // almost straight while the rim goes right over. That difference is what
    // makes it a dome instead of a funnel.
    p.leanRamp = c.ribLeanRamp;
    p.leanForward = 0;
    p.leanOutward = 1;
    p.twist = c.ribRoll;
    p.tilt = c.ribTilt;

    p.riseTime = c.ribRiseTime;
    p.riseOvershoot = c.ribOvershoot;
    p.settle = c.ribSettle;
    p.springRate = c.ribSpring;
    p.emergeSink = c.ribSink;
    p.birthScale = c.ribBirthScale;
    p.birthFade = c.ribBirthFade;
    p.breachAt = c.ribBreachAt;
    p.sinkDepth = c.ribSinkDepth;
    p.randomness = g.randomness;

    this.ribs.update(this.age, p, rot);

    /* --- the material ----------------------------------------------------- */
    this.boneMaterial.userData.sync();
    this.boneMaterial.userData.setWither(rot * c.witherDepth);
    this.boneMaterial.opacity = c.boneOpacity * g.opacity * (1 - Easing.inQuad(rot) * c.crumbleFade);

    /* --- the cracked floor ------------------------------------------------ */
    const f = this.floorParams;
    f.centre.copy(this._centre);
    f.yaw = 0;
    f.height = c.floorHeight;
    f.radius = R * c.floorRadius;
    f.grow = 1;
    f.recede = 0;
    f.fade = 1 - Easing.inQuad(rot);
    f.seed = this._seed;

    f.edge = c.floorEdge;
    f.ragged = c.floorRagged;
    f.raggedScale = c.floorRaggedScale;
    f.warp = c.floorWarp;
    f.relief = c.floorRelief;
    f.normalStep = c.floorNormalStep;
    f.ambient = c.floorAmbient;
    f.specular = c.floorSpecular;
    f.gloss = c.floorGloss;
    f.parallax = c.floorParallax;
    f.cell = c.floorCell;
    f.lift = c.floorLift;
    f.depth = c.floorDepth;
    f.detail = c.floorDetail;
    f.sharp = c.floorSharp;
    f.speed = c.floorSpeed;
    f.markLife = c.floorMarkLife;
    f.markRadius = c.floorMarkRadius;
    // Zero, and it is a picker with a black default rather than a missing
    // uniform: POCK's glow channel is cooling ember, and nothing here is hot.
    f.emissive = c.floorEmissive;
    f.opacity = c.floorOpacity;
    f.depthFade = c.floorDepthFade;
    f.colorBase = c.colorFloorBase;
    f.colorEdge = c.colorFloorEdge;
    f.colorGlow = c.colorFloorGlow;
    f.colorDeep = c.colorFloorDeep;
    f.noiseStrength = g.noiseStrength;
    f.noiseFrequency = g.noiseFrequency;
    f.noiseSpeed = g.noiseSpeed;
    f.opacityScale = g.opacity;

    this.floor.setVisible(this.floor.markCount > 0 && f.fade > 0.004);
    this.floor.update(f);

    /* --- the two particle systems ----------------------------------------- */
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

    this.dust.setGradient(
      getColor(c.colorDustA),
      getColor(c.colorDustB),
      getColor(c.colorDustC),
      getColor(c.colorDustD)
    );
    this.dust.uniforms.uGravity.value.set(0, c.dustRise, 0);
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize;
    this.dust.uniforms.uLifeScale.value = 0.5 * g.particleLifetime;
    this.dust.uniforms.uSpeedScale.value = g.particleSpeed;
    this.dust.uniforms.uOpacity.value = c.dustOpacity * g.opacity;
    this.dust.uniforms.uTurbulence.value = 0.3 * g.turbulence;
  }

  /** The dry rattle at the caster's hand as the cage is called. */
  _muzzleFx() {
    const c = settings.bonecage;
    const g = settings.global;

    this._handPoint(_hand);

    this.ctx.bursts.spawn(BurstMode.EARTH, _hand, {
      radius: c.muzzleSize * 0.3,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.45,
      intensity: c.muzzleIntensity,
      opacity: 0.4,
      fresnel: 1.1,
      displace: 0.35,
      squash: 0.8,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    _emit.position = _hand;
    _emit.radius = 0.2;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.5).setY(0.4).normalize();
    _emit.speed = c.dustSpeed;
    _emit.speedVariance = 0.6;
    _emit.spread = 0.8;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.4;
    _emit.sizeVariance = 0.5;
    _emit.life = c.dustLifetime;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.3;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.dust.emit(Math.round(12 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.3 * g.explosionIntensity;
  }

  /** Dust drifting off a standing cage. */
  _cageFx(dt, scale) {
    const c = settings.bonecage;
    const g = settings.global;
    const count = Math.round(this.dustEmitter.tick(dt, c.dustRate * scale) * g.particleCount);
    if (count <= 0) return;

    const bearing = Math.random() * TAU;
    const r = this.radius * c.ribRing * Math.sqrt(Math.random());
    _pos.set(
      this._centre.x + Math.cos(bearing) * r,
      c.dustBirthHeight,
      this._centre.z + Math.sin(bearing) * r
    );

    _emit.position = _pos;
    _emit.radius = this.radius * 0.12;
    _emit.direction = _dir.set(Math.cos(bearing) * 0.25, 1, Math.sin(bearing) * 0.25).normalize();
    _emit.speed = c.dustSpeed * 0.6;
    _emit.speedVariance = 0.5;
    _emit.spread = 0.6;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.6;
    _emit.sizeVariance = 0.5;
    _emit.life = c.dustLifetime;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.2;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.dust.emit(count, _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.bonecage;

    this._sync(0);
    this.position.y = c.lightHeight * 0.5;
    this._cageFx(dt, 0.25);
    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.bonecage;
    const g = settings.global;

    this._riseTime = 0;
    this._centrePoint(this._centre);

    // A low pressure shell as the ring comes up. AIR rather than EARTH: this is
    // the air being shoved out from under a closing lid, and a dust ball here
    // hides the one moment the ribs are most legible.
    _pos.copy(this._centre).setY(c.ribLength * 0.2);
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.burstSize * 0.3,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.8,
      intensity: c.burstIntensity,
      opacity: 0.28,
      fresnel: 1.4,
      displace: 0.4,
      squash: 0.35,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      15
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.bonecage;

    if (t <= 1) this._riseTime += dt;

    // The ring fires from the boundary **inward**. Outward is the obvious
    // choice and it is wrong for this shape: the ribs that have furthest to
    // travel are the ones at the rim, so starting them first is what lets the
    // whole cage arrive at the top at the same moment.
    this.ribs.triggerRadial(this.age, this._raise(), c.riseStagger, true, true);

    const rot = t <= 1 ? 0 : saturate(t - 1);
    this._sync(rot);

    // The light sits inside the cage and is smothered by it. It never leaves
    // the floor: a lamp at rib height would light the ribs from inside and
    // make them look like lampshades, which is the one thing bone must not do.
    this._centrePoint(this.position);
    this.position.y = c.lightHeight;

    this._cageFx(dt, (1 - rot) * (t <= 1 ? 1 : 0.4));
  }

  onDestroy() {
    this._riseTime = 0;
    this.ribs.clear();
    this.floor.clearMarks();
    this.floor.setVisible(false);
    this.boneMaterial.userData.setWither(0);
  }

  dispose() {
    this.ribs.dispose();
    this.boneMaterial.dispose();
    this.floor.dispose();
    super.dispose();
  }
}
