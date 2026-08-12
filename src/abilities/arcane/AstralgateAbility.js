import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { GrowthField, GrowthLayout, GrowthEmerge, growthParams } from '../../vfx/GrowthField.js';
import { Portal } from '../../vfx/Portal.js';
import { DistortionField, DistortionMode, DistortionFacing } from '../../vfx/Distortion.js';
import { createAstralStoneMaterial } from '../../materials/AstralStoneMaterial.js';
import { createCrystalGeometry } from '../../assets/ProceduralGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp } from '../../utils/math.js';

const TAU = Math.PI * 2;

/** Distinct obelisk silhouettes. Three, for facet variety — see `GrowthField`. */
const BODY_VARIANTS = 3;

/** Hard ceiling on bodies per cast. `bodyCount` clamps here. */
const MAX_BODIES = 96;

/* --- module-scope scratch. Nothing below allocates during a cast (I3) --- */
const _growth = growthParams();
const _shape = { sides: 0, taper: 0, roughness: 0, bend: 0 };
const _gate = {};
const _lens = {};
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _hit = new Vector3();
const _normal = new Vector3(0, 1, 0);
const _axisY = new Vector3();
const _up = new Vector3(0, 1, 0);

/**
 * ASTRAL GATE — geometry emerging *through* a plane.
 *
 * **The trick is the clip, and the clip is the whole ability.** A ring gate
 * tears open in the air over the zone (`vfx/Portal.js`) and obelisks of astral
 * stone climb out of it (`vfx/GrowthField.js`). Every fragment of every body
 * is tested against the aperture's own plane in
 * `materials/AstralStoneMaterial.js`, and anything on the far side of it is
 * discarded — in the colour pass *and* in the shadow pass. Take that test out
 * and the ability collapses into things popping into existence in front of a
 * decal, which is the single most common way a portal effect fails.
 *
 * ## Why the gate floats
 *
 * `gateHeight` is the number that makes the clip necessary and it is a slider
 * for exactly that reason. Put the aperture on the floor and the clip is free:
 * the floor is opaque, the buried half of every body is under it, and nothing
 * has to be clipped at all. Float it a metre and a half and the buried half is
 * hanging in mid-air, in plain view, under a hole in space.
 *
 * The tempting shortcut is "the portal is opaque inside its aperture, so it
 * hides them anyway". It hides *some* of them, from *one* angle, and only
 * once: not during the tear, when most of the aperture is not drawn yet; not
 * at the crown, where the material is additive and alpha is 0; not at any
 * `gateOpacity` below 1; and not from a camera low enough to see the underside.
 * Mostly hidden from one angle is not a clip.
 *
 * ## The half-space, and the part of it that is not an absence
 *
 * The test is a general half-space — a point on the plane and a unit normal,
 * the same two vectors `Portal#setPlacement` is given — rather than
 * `worldY > gateHeight`. One dot product instead of a subtraction, and the
 * gate can be tilted later without the material changing.
 *
 * A clip on its own is a hole in the picture, and a hole is not an effect. The
 * same signed distance drives an **emergence lip**: a hot band that sits
 * exactly where a body crosses the plane and travels down its shaft as it
 * climbs. That band is the only thing in the cast that says *through* rather
 * than *in front of*.
 *
 * ## The shadow pass had to be taught the same thing
 *
 * The first version stopped at the fragment discard and was correct from every
 * angle except downward. `Environment#registerShadowCasterWithPatch` patches
 * the material it is handed; three renders shadows with its own generated
 * `MeshDepthMaterial`, which had never heard of the gate. So every body that
 * had not arrived yet was invisible *and laying a full shadow on the stone
 * below it* — a ring of shadows with nothing above them, which is a worse
 * artefact than the one the clip removed. The material now ships a
 * `customDepthMaterial` carrying the identical test off the **same two uniform
 * boxes**, and the ability hangs it on all three of the field's meshes.
 *
 * ## The beats
 *
 *   1. **travel** — the summoning front runs out. Nothing at the zone yet.
 *   2. **tear** — the aperture opens over `openTime`. `Portal`'s `open` is a
 *      threshold on a noise field, not a scale, so it unzips raggedly and
 *      unzips in the same places on the way shut.
 *   3. **pour** — `triggerRadial` walks a front outward from the centre of the
 *      aperture and the bodies come through in order, each firing a breach
 *      spark on the frame it crosses. The field's footprint is the
 *      **aperture's**, not the zone's: nothing may come out of a hole it does
 *      not fit through.
 *   4. **hold**, then **withdraw** — the bodies sink back through on
 *      `retractCurve` and the hole shuts on `shutCurve`, which is the slower of
 *      the two on purpose. The gate must not close on something that is still
 *      half in it.
 *
 * **The rule that makes the editor work.** A cast captures one unitless seed
 * and one clock. Every metre — the aperture's two radii, the annulus, every
 * obelisk's height and lean, the plane the clip is measured against — is
 * resolved against `settings.astralgate` inside the update loop, on a
 * zero-length frame included. Pause with **P** mid-pour and drag `gateHeight`:
 * the plane moves, the lip climbs every shaft, and bodies that were through
 * are buried again.
 */
export class AstralgateAbility extends Ability {
  constructor(context) {
    super('astralgate', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * The gate. Not billboarded and not depth-writing: it is a real plane in
     * the world with a real orientation, which is the only way the clip and
     * the picture can agree, and a transparent that must be hidden by nearer
     * opaque geometry — walk in front of it and it is behind you.
     */
    this.gate = new Portal({ renderOrder: 6, name: 'AstralGate' });
    this.group.add(this.gate.object3D);

    this.stone = createAstralStoneMaterial(this.ctx.environment);

    this._readShape();
    this.bodies = new GrowthField(this.group, {
      geometry: (variant, shape) =>
        createCrystalGeometry({
          seed: 8.1 + variant * 27.3,
          sides: shape.sides,
          taper: shape.taper,
          roughness: shape.roughness,
          bend: shape.bend
        }),
      material: this.stone,
      shape: _shape,
      variants: BODY_VARIANTS,
      capacity: MAX_BODIES,
      renderOrder: 2
    });

    // The shadow pass, taught the clip. Hung here rather than in the material
    // factory because `customDepthMaterial` is a property of a *mesh* and the
    // meshes belong to the field.
    for (const mesh of this.bodies.meshes) {
      mesh.customDepthMaterial = this.stone.userData.depthMaterial;
    }

    /**
     * Assigned once, at construction. A closure built inside the update loop
     * would be an allocation per instance per frame, which is what I3 forbids.
     */
    this.bodies.onBreach = (index, position, radius, height) =>
      this._breachFx(index, position, radius, height);

    /**
     * The bent air at the rim. `Portal` deliberately writes no screen-space
     * offsets — an ability that wants a hole does not always want the frame
     * warped around it — so the lens is the ability's choice and its own draw
     * call. `LENS` rather than `SHOCK`: this one does not travel, it sits.
     */
    this.lens = new DistortionField({
      mode: DistortionMode.LENS,
      facing: DistortionFacing.BILLBOARD,
      name: 'AstralGate:lens'
    });
    this.group.add(this.lens.object3D);

    // Note for whoever comes next: everything here is placed from the CPU in
    // *world* space and the group's matrix is identity. The clip plane is in
    // world space too, so moving or scaling `this.group` would put the picture
    // and the clip in different places — which would look like the shader
    // failing rather than like a transform being wrong.

    /* --- what a cast captures: one dice roll and one clock --- */
    /** Decorrelates the tear, the starfield and the vein offsets. Unitless. */
    this._seed = 0;
    /** Seconds since the summoning front landed. A clock, not a dimension. */
    this._land = 0;
    /** One-way: the tear only completes once, however the sliders move. */
    this._opened = false;
    /** HUD readout only. */
    this._live = 1;

    /** The gate's anchor and normal, rewritten every frame from live settings. */
    this._anchor = new Vector3();
    this._planeNormal = new Vector3(0, 1, 0);
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Star-stuff coming up out of the hole. Additive and curled, so it reads as
    // light leaking from somewhere rather than as smoke.
    this.motes = particles.get('astralgate.motes', {
      capacity: 2600,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.5;
    this.motes.uniforms.uEndSize.value = 0.16;
    this.motes.uniforms.uSizeIn.value = 0.07;
    this.motes.uniforms.uFadeIn.value = 0.1;
    this.motes.uniforms.uFadeOut.value = 0.4;

    // Chips shaken off a body as it comes through. Lit, not additive: this is
    // rock, and rock that glows is the fastest way to make debris read as
    // confetti.
    this.grit = particles.get('astralgate.grit', {
      capacity: 1600,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.grit.uniforms.uDrag.value = 0.3;
    this.grit.uniforms.uEndSize.value = 0.75;
    this.grit.uniforms.uFadeOut.value = 0.65;

    // Cold haze spilling off the underside. The only thing in the cast that
    // moves *downward*, and the reason the gate reads as having an underside at
    // all from a camera that is mostly above it.
    this.haze = particles.get('astralgate.haze', {
      capacity: 1600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.haze.uniforms.uDrag.value = 2.1;
    this.haze.uniforms.uEndSize.value = 2.8;
    this.haze.uniforms.uSizeIn.value = 0.14;
    this.haze.uniforms.uFadeIn.value = 0.2;
    this.haze.uniforms.uFadeOut.value = 0.32;

    this.moteEmitter = new RateEmitter();
    this.gritEmitter = new RateEmitter();
    this.hazeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** A beat's length in seconds, under the global lifetime knob. */
  _span(seconds) {
    return Math.max(0.01, seconds * settings.global.lifetime);
  }

  /** The impact phase holds the tear, the pour and the hold. */
  get impactDuration() {
    const c = settings.astralgate;
    return this._span(c.openTime) + this._span(c.pourTime) + this._span(c.holdTime);
  }

  /** The fade is the withdrawal: the bodies sink back and the hole shuts. */
  get fadeDuration() {
    return Math.max(0.05, settings.astralgate.fadeTime);
  }

  get instanceCount() {
    return this._live;
  }

  /** A gate breathes. It does not gutter, and it does not strobe. */
  lightShimmer() {
    const c = settings.astralgate;
    return 1 - saturate(c.lightPulse) * 0.5 * (1 - Math.cos(this.age * c.lightPulseSpeed));
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The live footprint, metres. What the aim circle measured out. */
  get radius() {
    return Math.max(0.2, settings.astralgate.zoneRadius);
  }

  /**
   * The aperture radius, metres.
   *
   * The growth field reads this too, not `zoneRadius`: nothing may come out of
   * a hole it does not fit through, and deriving both from one number is what
   * keeps that true while somebody is dragging `gateSpan`.
   */
  get apertureRadius() {
    return Math.max(0.1, this.radius * settings.astralgate.gateSpan);
  }

  /** Where the gate hangs: over the far end of the aimed line. */
  _anchorPoint(out) {
    return this.pointAt(1, out).setY(settings.astralgate.gateHeight);
  }

  /** 0..1 — how far the aperture has torn open. */
  _openAmount() {
    return saturate(this._land / this._span(settings.astralgate.openTime));
  }

  /** 0..1 — how far the pour front has crossed the aperture. */
  _pourAmount() {
    const c = settings.astralgate;
    return saturate((this._land - this._span(c.openTime)) / this._span(c.pourTime));
  }

  /** The obelisk silhouette, into module scratch. Returns it. */
  _readShape() {
    const c = settings.astralgate;
    _shape.sides = clamp(Math.round(c.bodySides), 3, 8);
    _shape.taper = c.bodyTaper;
    _shape.roughness = c.bodyRough;
    _shape.bend = c.bodyBend;
    return _shape;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this.gritEmitter.reset();
    this.hazeEmitter.reset();

    this._land = 0;
    this._opened = false;

    // The only thing a cast captures with no unit on it.
    this._seed = Math.random() * 100;

    const c = settings.astralgate;
    this.bodies.clear();
    this.bodies.plant(Math.min(MAX_BODIES, Math.round(c.bodyCount)), c.bodyCluster);

    this._sync(1, 0);
    this._castFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current cast state into the gate, the
   * bodies, the lens and the three particle systems.
   *
   * @param {number} fade    1 while the gate stands, ramping to 0 as it shuts
   * @param {number} retract 0..1 — how far the bodies have sunk back through
   */
  _sync(fade, retract) {
    const c = settings.astralgate;
    const g = settings.global;

    const travelling = this.phase === AbilityPhase.TRAVEL;
    const aperture = this.apertureRadius;
    this._anchorPoint(this._anchor);
    const open = travelling ? 0 : this._openAmount();
    const pour = travelling ? 0 : this._pourAmount();

    /* ---------------- 1 · the plane, before anything reads it ---------- */
    // The gate is horizontal today, so the normal is world up. It is carried as
    // a vector rather than assumed, because the material's clip, the portal's
    // placement and the lens all take it from here — three consumers of one
    // definition is how a tilted gate stays a one-line change instead of a
    // three-file hunt.
    this._planeNormal.copy(_up);
    // Portal wants (anchor, along, up) and builds its normal as along × up. To
    // land a chosen normal on a plane whose local +X is the cast's side vector,
    // the second axis is normal × side — which is what `setPlacement` will
    // re-derive, so handing it that vector is a fixed point rather than a
    // guess.
    _normal.copy(this._planeNormal);
    _axisY.crossVectors(_normal, this.side).normalize();
    if (_axisY.lengthSq() < 1e-8) _axisY.copy(this.direction);
    this.gate.setPlacement(this._anchor, this.side, _axisY);

    // Hand the same two vectors to the stone. Written every frame, including a
    // zero-length one: this is the line that makes dragging `gateHeight` on a
    // paused field re-bury the obelisks.
    this.stone.userData.sync(this._anchor, this._planeNormal);

    /* ---------------- 2 · the aperture --------------------------------- */
    const p = _gate;
    p.radiusX = aperture;
    p.radiusY = aperture;
    p.margin = c.gateMargin;
    // Shut on `shutCurve`, which is deliberately slower than the withdrawal:
    // the hole must not close on something that is still half in it. A linear
    // shut clipped the last two obelisks off at the knee.
    p.open = fade >= 1 ? open : open * (1 - Math.pow(1 - fade, Math.max(0.05, c.shutCurve)));
    p.seam = c.tearSeam;
    p.tearJag = c.tearJag;
    p.tearScale = c.tearScale;
    p.tearCrawl = c.tearCrawl;
    p.edgeSoft = c.edgeSoft;
    p.seed = this._seed;
    p.opacity = c.gateOpacity * g.opacity;

    p.rim = c.rim;
    p.rimGlow = c.rimGlow * g.glow;
    p.core = c.core;
    p.coreGlow = c.coreGlow * g.glow;
    p.throat = c.throat;
    p.throatGlow = c.throatGlow * g.glow;
    p.crackCount = c.crackCount;
    p.crackWidth = c.crackWidth;
    p.crackLength = c.crackLength;
    p.crackGlow = c.crackGlow * g.glow;

    p.parallax = c.parallax;
    p.swirl = c.swirl;
    p.interiorFade = c.interiorFade;

    p.starSize = c.starSize;
    p.starTwinkle = c.starTwinkle;
    p.starGain = c.starGain;
    p.starScaleA = c.starScaleA;
    p.starScaleB = c.starScaleB;
    p.starScaleC = c.starScaleC;
    p.starDepthA = c.starDepthA;
    p.starDepthB = c.starDepthB;
    p.starDepthC = c.starDepthC;
    p.starDriftA = c.starDriftA;
    p.starDriftB = c.starDriftB;
    p.starDriftC = c.starDriftC;
    p.nebulaScale = c.nebulaScale;
    p.nebulaSpeed = c.nebulaSpeed;
    p.nebulaGain = c.nebulaGain;
    p.nebulaDepth = c.nebulaDepth;

    p.colorVoid = c.colorVoid;
    p.colorRim = c.colorGateRim;
    p.colorCore = c.colorGateCore;
    p.colorCrack = c.colorGateCrack;
    p.colorThroat = c.colorGateThroat;
    p.colorStarA = c.colorStarA;
    p.colorStarB = c.colorStarB;
    p.colorStarC = c.colorStarC;
    p.colorNebulaA = c.colorNebulaA;
    p.colorNebulaB = c.colorNebulaB;
    this.gate.update(p);
    this.gate.visible = p.open > 0.002;

    /* ---------------- 3 · what comes through --------------------------- */
    this.bodies.syncGeometry(this._readShape());

    const f = _growth;
    f.layout = GrowthLayout.ZONE;
    // PUSH, not SCALE. An obelisk that accretes in place never crosses the
    // plane and the whole ability evaporates — the clip only has anything to
    // say about a body that is *moving through* it.
    f.emerge = GrowthEmerge.PUSH;
    f.origin = this.origin;
    f.direction = this.direction;
    f.side = this.side;
    f.length = this.length;
    f.centre = this._anchor;
    f.radius = aperture;
    f.innerRadius = aperture * saturate(c.bodyInner);
    f.radialCurve = c.bodyRadialCurve;
    f.radialJitter = c.bodyRadialJitter;
    f.angleJitter = c.bodyAngleJitter;
    f.clusterRadius = -1;

    f.heightNear = c.bodyHeightNear;
    f.height = c.bodyHeight;
    f.heightCurve = c.bodyHeightCurve;
    f.heightJitter = c.bodyHeightJitter;
    f.crown = c.bodyCrown;
    f.crownPower = c.bodyCrownPower;
    f.peak = c.bodyPeak;
    f.peakWidth = c.bodyPeakWidth;
    f.rubble = c.bodyRubble;
    f.rubbleScale = c.bodyRubbleScale;
    f.rubbleSpread = c.bodyRubbleSpread;

    f.radiusNear = c.bodyRadiusNear;
    f.radius2 = c.bodyRadius;
    f.radiusCurve = c.bodyRadiusCurve;
    f.radiusJitter = c.bodyRadiusJitter;

    f.lean = c.bodyLean;
    f.leanJitter = c.bodyLeanJitter;
    f.leanRamp = c.bodyLeanRamp;
    f.leanForward = c.bodyLeanForward;
    f.leanOutward = c.bodyLeanOutward;
    f.twist = c.bodyTwist;
    f.tilt = c.bodyTilt;

    // The one line that puts the field in the air instead of on the floor.
    // `GrowthField` measures `baseHeight` from y = 0, and the gate's height is
    // the same number the clip plane is at, so a body's base is exactly on the
    // plane by construction rather than by tuning.
    f.baseHeight = c.gateHeight;
    f.baseJitter = 0;

    f.riseTime = c.riseTime;
    f.riseOvershoot = c.riseOvershoot;
    f.settle = c.settle;
    f.springRate = c.springRate;
    f.emergeSink = c.emergeSink;
    f.birthScale = c.birthScale;
    f.birthFade = c.birthFade;
    f.breachAt = c.breachAt;
    f.sinkDepth = c.sinkDepth;
    f.randomness = g.randomness;

    if (!travelling) {
      // A front walking outward from the middle of the aperture. `includeCluster`
      // is true so the group under the centre goes first, which is the read:
      // something arrives, and then the ring of it does.
      this.bodies.triggerRadial(this.age, pour, c.riseStagger * this._span(c.pourTime), false, true);
    }
    this.bodies.update(this.age, f, retract);
    this._live = this.bodies.count;

    /* ---------------- 4 · the bent air --------------------------------- */
    const lensRadius = Math.max(0.05, aperture * c.lensSpan);
    this.lens.setAnchorXYZ(this._anchor.x, this._anchor.y, this._anchor.z);
    _lens.width = lensRadius * 2;
    _lens.height = lensRadius * 2;
    _lens.radius = lensRadius;
    _lens.core = c.lensCore;
    _lens.window = c.lensWindow;
    _lens.maxOffset = c.lensMaxOffset;
    _lens.fold = c.lensFold;
    _lens.swirl = c.lensSwirl;
    _lens.depthFade = c.lensDepthFade;
    _lens.seed = this._seed;
    // NEVER multiplied by global.distortion or post.distortion — the pass
    // applies both, once, and doing it here squares them.
    _lens.strength = c.lensStrength * p.open * fade;
    _lens.opacity = c.lensOpacity;
    this.lens.update(_lens);
    this.lens.visible = p.open > 0.01 && fade > 0.01;

    /* ---------------- 5 · the three particle systems ------------------- */
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
    this.motes.uniforms.uGlow.value = 1.0 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

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

    this.haze.setGradient(
      getColor(c.colorHazeA),
      getColor(c.colorHazeB),
      getColor(c.colorHazeC),
      getColor(c.colorHazeD)
    );
    this.haze.uniforms.uGravity.value.set(0, c.hazeFall, 0);
    this.haze.uniforms.uSizeScale.value = c.hazeSize * g.particleSize;
    this.haze.uniforms.uLifeScale.value = c.hazeLifetime * 0.5 * g.particleLifetime;
    this.haze.uniforms.uSpeedScale.value = c.hazeSpeed * g.particleSpeed;
    this.haze.uniforms.uOpacity.value = c.hazeOpacity * g.opacity;
    this.haze.uniforms.uTurbulence.value = 0.3 * g.turbulence;
  }

  /** A small flare at the hand as the summoning front leaves it. */
  _castFx() {
    const c = settings.astralgate;
    const g = settings.global;

    _pos.copy(this.origin).addScaledVector(this.direction, 0.6).setY(1.3);

    _emit.position = _pos;
    _emit.radius = 0.15;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.moteSpeed * 3.2;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.6;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.6;
    _emit.life = c.moteLifetime * 0.6;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(Math.round(20 * g.particleCount), _emit);

    this.lightBoost = c.lightIntensity * 0.3 * g.explosionIntensity;
  }

  /**
   * One body breaks the plane.
   *
   * `GrowthField` calls this at `breachAt` of the emergence ramp with the
   * instance's live world position, footprint and height — every one of them a
   * metre resolved from settings on that frame, which is why the grit comes off
   * at the right size when somebody drags `bodyRadiusNear` mid-pour.
   */
  _breachFx(index, position, radius, height) {
    const c = settings.astralgate;
    const g = settings.global;

    _pos.copy(position);
    // The spark belongs on the *plane*, not at the body's base — the base is
    // buried, and grit thrown from under the gate falls out of the bottom of
    // the world with nothing to explain it.
    _pos.y = c.gateHeight;

    _emit.position = _pos;
    _emit.radius = radius * 1.2 + 0.05;
    _emit.direction = _dir.set(
      position.x - this._anchor.x,
      0,
      position.z - this._anchor.z
    );
    if (_emit.direction.lengthSq() < 1e-6) _emit.direction.set(0, 1, 0);
    _emit.direction.normalize().multiplyScalar(0.55).setY(1).normalize();
    _emit.speed = c.gritSpeed;
    _emit.speedVariance = 0.75;
    _emit.spread = 0.8;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.08;
    _emit.sizeVariance = 0.7;
    _emit.life = c.gritLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 9;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.grit.emit(Math.round(c.gritBreach * g.particleCount), _emit);

    // A puff of star-stuff pushed out of the hole by the body coming through.
    // Scaled by the body's own height, so a tall obelisk displaces more than a
    // shard does — one line, and it is the difference between a field where
    // everything arrives with the same event and one where the big ones land.
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed * 1.6;
    _emit.size = 0.07;
    _emit.life = c.moteLifetime * 0.8;
    _emit.spin = 0;
    this.motes.emit(Math.round(4 * height * g.particleCount), _emit);
  }

  /**
   * Everything the standing gate sheds.
   *
   * @param {number} dt
   * @param {number} open  0..1, how far the aperture is open
   * @param {number} scale 0..1, thinned as the cast withdraws
   */
  _gateFx(dt, open, scale) {
    const c = settings.astralgate;
    const g = settings.global;
    const time = frame.uTime.value;
    const aperture = this.apertureRadius;
    const anchor = this._anchor;

    if (open <= 0.01) return;

    /* --- motes, up out of the aperture --- */
    const moteCount = Math.round(
      this.moteEmitter.tick(dt, c.moteRate * open * scale) * g.particleCount
    );
    if (moteCount > 0) {
      // Inside the aperture and nowhere else: sqrt-uniform so a disc fills
      // evenly rather than crowding the middle, and multiplied by `open` so the
      // motes appear as the hole does instead of a moment before it.
      const a = Math.random() * TAU;
      const r = aperture * open * Math.sqrt(Math.random());
      _pos.set(anchor.x + Math.cos(a) * r, anchor.y + 0.05, anchor.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = aperture * 0.08;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = 0.85;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.06;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    /* --- haze, down off the underside --- */
    const hazeCount = Math.round(
      this.hazeEmitter.tick(dt, c.hazeRate * open * scale) * g.particleCount
    );
    if (hazeCount > 0) {
      const a = Math.random() * TAU;
      const r = aperture * (0.5 + 0.5 * Math.random());
      _pos.set(anchor.x + Math.cos(a) * r, anchor.y - 0.1, anchor.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = aperture * 0.2;
      _emit.direction = _dir.set(Math.cos(a) * 0.4, -1, Math.sin(a) * 0.4).normalize();
      _emit.speed = c.hazeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.75;
      _emit.size = 0.8;
      _emit.sizeVariance = 0.5;
      _emit.life = c.hazeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.time = time;
      this.haze.emit(hazeCount, _emit);
    }

    /* --- grit, shaken off whatever is already standing --- */
    if (this.bodies.count === 0) return;
    const gritCount = Math.round(
      this.gritEmitter.tick(dt, c.gritRate * scale) * g.particleCount
    );
    if (gritCount > 0) {
      const index = (Math.random() * this.bodies.count) | 0;
      this.bodies.positionOf(index, _growth, _pos);
      _pos.y = Math.max(_pos.y, c.gateHeight);
      _emit.position = _pos;
      _emit.radius = 0.2;
      _emit.direction = _dir.set(0, -1, 0);
      _emit.speed = c.gritSpeed * 0.4;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.6;
      _emit.size = 0.06;
      _emit.sizeVariance = 0.7;
      _emit.life = c.gritLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 7;
      _emit.time = time;
      this.grit.emit(gritCount, _emit);
    }
  }

  /**
   * The one-shot, tested against the live beat length every frame.
   *
   * One-way, like every other beat flag in the project: dragging `openTime`
   * upward after the hole has torn would otherwise push the threshold back past
   * the clock and fire the tear a second time.
   */
  _checkBeats() {
    if (this._opened) return;
    if (this._land < this._span(settings.astralgate.openTime)) return;
    this._opened = true;
    this._openFx();
  }

  /** The hole finishes tearing: the shell, the floor ring, the flash. */
  _openFx() {
    const c = settings.astralgate;
    const g = settings.global;
    const time = frame.uTime.value;

    this._anchorPoint(_hit);

    this.ctx.bursts.spawn(BurstMode.AIR, _hit, {
      radius: c.burstSize * 0.2,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.6,
      intensity: c.burstIntensity,
      opacity: 0.7,
      fresnel: 1.7,
      displace: 0.4,
      squash: 0.55,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    // On the floor under the gate, not at it: this is the mark the pressure
    // leaves on the stone, and a shockwave hanging in the air at 1.5 m reads as
    // a second, smaller portal.
    this.pointAt(1, _pos).setY(0);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: this.radius * c.ringSpan * g.explosionIntensity,
      life: 0.75,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorRingA),
      colorB: getColor(c.colorRingB)
    });

    _emit.position = _hit;
    _emit.radius = this.apertureRadius * 0.8;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed * 2.4;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.09;
    _emit.sizeVariance = 0.75;
    _emit.life = c.moteLifetime * 1.3;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.motes.emit(Math.round(c.moteOpen * g.particleCount), _emit);

    this.ctx.shake.add(
      c.openShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.openFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.1 * g.explosionIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1, 0);

    // The light rides the summoning front out to the point and then climbs.
    this.pointAt(this.u, this.position).setY(lerp(1.2, settings.astralgate.gateHeight, this.u));

    this.ctx.shake.rumble(settings.astralgate.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    // Nothing fires here. The tear runs on its own clock from the moment the
    // front lands, and the landing is not one of them — firing the tear here
    // opened a hole at three metres before the front had visibly got there.
    this._land = 0;
    this._anchorPoint(this.position);
  }

  onFade(dt, t) {
    const c = settings.astralgate;
    this._land += dt;
    this._checkBeats();

    // `t` runs 0..1 while the gate stands, then 1..2 while it withdraws.
    const out = saturate(t - 1);
    const fade = t <= 1 ? 1 : 1 - out;
    // The bodies sink back on their own curve, ahead of the hole shutting. At
    // 1.5 they hold their height for the first third of the withdrawal and then
    // drop, which reads as *being pulled back* rather than as deflating.
    const retract = t <= 1 ? 0 : Math.pow(out, Math.max(0.05, c.retractCurve));

    this._sync(fade, retract);

    // The light climbs out of the hole with the obelisks and sinks with them.
    this._anchorPoint(this.position);
    this.position.y +=
      c.bodyHeight * saturate(c.lightHeight) * this._pourAmount() * (1 - retract);

    this._gateFx(dt, this._openAmount() * (t <= 1 ? 1 : 1 - out), fade);
    this.ctx.shake.rumble(c.rumble * fade * 0.6 * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._live = 1;
    this._land = 0;
    this._opened = false;
    this.bodies.clear();
    this.gate.visible = false;
    this.lens.visible = false;
  }

  dispose() {
    this.bodies.dispose();
    this.gate.dispose();
    this.lens.dispose();
    this.stone.userData.depthMaterial?.dispose();
    this.stone.dispose();
    super.dispose();
  }
}
