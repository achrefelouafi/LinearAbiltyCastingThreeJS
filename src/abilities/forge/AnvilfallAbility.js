import { Mesh, Vector3, Color } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import {
  HardShape,
  ShapeCache,
  anvilShape,
  createHardSurfaceMaterial,
  syncHardSurfaceMaterial,
  heatToKelvin,
  blackbodyColor
} from '../../vfx/HardSurface.js';
import { Shell, ShellMode } from '../../vfx/Shell.js';
import { GroundField, GroundMode } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, Easing } from '../../utils/math.js';

const TAU = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;

/**
 * Craters the dent is made of, posted in a line along the anvil's own base.
 *
 * Five, and the number is a judgement rather than a budget: three leaves two
 * visible bowls with a bridge of untouched floor between them, and seven costs
 * seven more slots in the shader's fixed trip count to add nothing the eye can
 * separate at a 3.4 m radius.
 */
const FOOT_MARKS = 5;

/**
 * Points around the footprint the contact spray leaves from.
 *
 * A heavy flat-bottomed thing does not throw material *up*, it squeezes it out
 * from underneath itself, radially. `ParticleSystem#emit` takes one direction
 * and a cone, so one call from the centre can only ever produce a fountain —
 * the first pass did exactly that and the anvil read as landing on a geyser.
 * Six calls round the rim, each pointing outward along its own bearing, is a
 * genuine radial sheet for the price of five extra emits on a one-shot beat.
 */
const CONTACT_BATCHES = 6;

/**
 * Tessellation of the anvil. Deliberately *not* sliders.
 *
 * `createAnvilGeometry` is a lathe: it smooths a key silhouette, lofts a
 * rounded rectangle up it and lofts a second body out for the horn. Section
 * counts are the one class of number in the shape that changes the *cost* of a
 * rebuild rather than the result, and the shape is rebuilt from a `ShapeCache`
 * whenever any live slider moves — so leaving them on the panel would let a
 * drag of `sections` turn a 4 ms rebuild into a 40 ms one with nothing to show
 * for it. Every number that changes the silhouette is a slider; these do not.
 */
const SECTIONS = 26;
const CORNER_STEPS = 3;
const FILLET_PASSES = 4;
const HORN_SECTIONS = 10;
const HORN_STEPS = 12;

/* --- module-scope scratch: nothing below allocates on a frame (I3) --- */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _land = new Vector3();
const _tint = new Color();
/** Params objects, rewritten whole every frame and never cached between them. */
const _hard = {};
const _dish = { centre: new Vector3() };
const _shock = { origin: new Vector3(), axis: new Vector3(0, 1, 0), side: new Vector3() };

/**
 * ANVILFALL — a machined anvil is dropped on the circle.
 *
 * **THE TRICK — mass, and mass is a set of consequences that agree.** Nothing
 * about an impact reads as heavy on its own. A big shake over a slow arrival
 * reads as a bug in the camera; a deep crater under a light landing reads as
 * a decal. What makes weight legible is that every consequence is the *same*
 * event seen from a different angle, so this ability refuses to let any of
 * them be typed in independently. It derives them all from one number:
 *
 * ```
 *   h(u) = dropHeight · (1 − u^fallCurve)         the height on screen
 *   v    = −dh/dt |_{u=1} = dropHeight · fallCurve / T          T = length / speed
 * ```
 *
 * `v` is the speed the anvil is *actually travelling at* on the frame it
 * touches, read off the animation rather than asserted, and against `refSpeed`
 * it drives six things at once: the camera kick, the depth of the dent, the
 * speed of the pressure front, the chip speed, the dust speed and the light
 * punch. Halve `dropHeight` with the clock stopped and all six get quieter
 * together. That single coupling is the whole slot.
 *
 * The first version did the obvious thing and used the textbook free-fall
 * speed, `√(2gh)`, with `g` as its own slider. It is wrong here for a reason
 * worth writing down: the anvil is not falling under that `g`, it is falling
 * down the cast's own normalised clock, so the number and the picture
 * disagreed — a 20 m drop over the same travel time arrived at a *typed* speed
 * that had nothing to do with how fast the mesh was moving, and shortening
 * `range` made the anvil visibly faster while every derived read stayed put.
 * Differentiating the curve that is actually on screen fixed all of it.
 *
 * Three things then carry the read on top of that:
 *
 * **The floor dishes.** `vfx/GroundField.js` in `POCK`, but not with one
 * crater — with `FOOT_MARKS` craters posted in a line along the anvil's base,
 * in a frame yawed to the anvil's own long axis, so the dent is the *shape of
 * the thing that made it*. One central bowl was the first attempt and it reads
 * as a cannonball landing. The marks are unitless fractions and the ability
 * keeps the `Vector4`s the module handed back, rewriting their positions and
 * strengths every frame, so `anvilSize`, `dishFootprint`, `dishRadius`,
 * `dishDepth` and `dishCurve` all reshape a dent that is already in the floor
 * with the clock stopped. (The pattern is `BoulderAbility`'s, and it is the
 * only way a posted event stays a live slider.)
 *
 * **The shock is low and slow.** `vfx/Shell.js` in `PRESSURE` at
 * `shockHeight = 0.1` is an oblate lens lying on the floor rather than a dome,
 * `shockExpand = 1.15` is nearly linear so it keeps *travelling* instead of
 * snapping out and easing, and it is dust-coloured at `shockGlow = 0.55`. Its
 * clock is `shockRadiusEnd / (v · shockSpeedRatio)` — the front's speed is a
 * third of the anvil's arrival speed, so it is fast when the drop is high and
 * ponderous when it is low, and it never disagrees with the shake.
 *
 * **It stays.** The anvil does not fade, dissolve or dim. It is opaque steel
 * from the frame it lands, it settles into its own dent by `dishSink` of the
 * depth it made, and it leaves at the very end of the fade by *sinking*
 * (`exitSink`) rather than by going transparent, because a lump of steel that
 * fades out is a hologram. `fadeTime` ships at 2.2 s for the same reason.
 *
 * **The rule that makes the editor work.** A cast captures two numbers and a
 * timestamp: a seed for the resting yaw, a boolean for whether it has landed,
 * and the age it landed at. Every metre, radian and second is resolved from
 * `settings.anvilfall` inside the update loop, on a zero-length frame
 * included — including the anvil's own silhouette, which goes through a
 * `ShapeCache` and rebuilds only when one of the eleven shape sliders actually
 * moves.
 */
export class AnvilfallAbility extends Ability {
  constructor(context) {
    super('anvilfall', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* ---- the steel ---- */
    this.anvilMaterial = createHardSurfaceMaterial({
      environment: this.ctx.environment,
      // Smooth shading. The generators already crease at `creaseAngle`, so
      // flat shading here would only re-facet the fillets that are the entire
      // reason the shape reads as forged rather than as boxes.
      flatShading: false
    });

    /**
     * One shape object, rewritten in place every frame and handed to the
     * cache, which compares its values against a `Float64Array` and rebuilds
     * only on a real change. Building it fresh each frame would be an object
     * literal per frame (I3) *and* an eleven-key string compare.
     */
    this._shape = anvilShape({
      sections: SECTIONS,
      cornerSteps: CORNER_STEPS,
      filletPasses: FILLET_PASSES,
      hornSections: HORN_SECTIONS,
      hornSteps: HORN_STEPS
    });
    this.shapes = new ShapeCache({ capacity: 1 });

    this.anvil = new Mesh(this.shapes.get(0, HardShape.ANVIL, this._shape), this.anvilMaterial);
    this.anvil.castShadow = true;
    this.anvil.receiveShadow = true;
    this.anvil.frustumCulled = false;
    this.anvil.layers.set(LAYER.WORLD);
    this.anvil.renderOrder = 2;
    this.group.add(this.anvil);

    /* ---- the dent ---- */
    this.dish = new GroundField(this.group, {
      mode: GroundMode.POCK,
      marks: FOOT_MARKS,
      // A dent is a hole. It shades the floor; it never lights it.
      additive: false,
      depthTest: true,
      layer: LAYER.VFX,
      name: 'AnvilDent'
    });
    this.dish.setVisible(false);

    /* ---- the pressure front ---- */
    this.shock = new Shell({
      mode: ShellMode.PRESSURE,
      prefix: 'shock',
      nodes: 40,
      sides: 40,
      renderOrder: 12
    });
    this.shock.visible = false;
    this.group.add(this.shock.group);

    /** Has it touched yet. One boolean. */
    this._landed = false;
    /** The age it touched at — a timestamp, which is an event, not a dimension. */
    this._landedAt = 0;
    /** Resting yaw, 0..1 of a turn. The one dice roll a cast makes. */
    this._seed = 0;

    /**
     * The crater slots, and why they are held rather than posted and forgotten.
     *
     * `GroundField#mark()` returns the `Vector4` it wrote into, and that vector
     * *is* the uniform. Keeping the references lets every crater's position and
     * strength be recomputed from the live sliders on every frame, including a
     * zero-length one. Without it, `anvilSize`, `dishFootprint`, `dishRadius`,
     * `dishBaseLoad` and `dishHornLoad` would all be baked into the floor at
     * the instant of contact — five dead sliders on the one part of the
     * ability that is supposed to prove the anvil was heavy.
     */
    this._markSlots = new Array(FOOT_MARKS).fill(null);
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The plume punched out from under it. Non-additive: dust thrown up by
    // something heavy has to occlude, or the anvil reads as landing in fog.
    this.dust = particles.get('anvilfall.dust', {
      capacity: 2200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.dust.uniforms.uDrag.value = 2.2;
    this.dust.uniforms.uEndSize.value = 3.2;
    this.dust.uniforms.uSizeIn.value = 0.09;
    this.dust.uniforms.uFadeIn.value = 0.1;
    this.dust.uniforms.uFadeOut.value = 0.34;

    // Chips of floor. Lit, because they are stone and stone is not emissive.
    this.chips = particles.get('anvilfall.chips', {
      capacity: 1400,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.chips.uniforms.uDrag.value = 0.24;
    this.chips.uniforms.uEndSize.value = 0.8;
    this.chips.uniforms.uFadeOut.value = 0.72;

    // Struck sparks. Steel on stone throws a few even stone cold, and if the
    // anvil is up at forge heat they are the same temperature the metal is.
    this.sparks = particles.get('anvilfall.sparks', {
      capacity: 1200,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.5;
    this.sparks.uniforms.uEndSize.value = 0.22;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.45;

    this.dustEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing — everything below is derived, nothing is remembered          */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return 1;
  }

  /** Seconds the cast spends falling. The front's own travel time. */
  get travelTime() {
    const c = settings.anvilfall;
    return Math.max(0.05, this.length / Math.max(0.2, c.speed * settings.global.speed));
  }

  /**
   * Metres/second the anvil is travelling at the instant it touches.
   *
   * `h(u) = dropHeight · (1 − u^fallCurve)`, and `u` runs 0→1 over
   * `travelTime`, so `dh/dt = −dropHeight · fallCurve · u^(fallCurve−1) / T`
   * and the arrival speed is that at `u = 1`. Differentiated from the curve
   * that is genuinely on screen — see the class comment for what happens when
   * it is not.
   */
  get impactSpeed() {
    const c = settings.anvilfall;
    return (Math.max(c.dropHeight, 0) * Math.max(c.fallCurve, 0.05)) / this.travelTime;
  }

  /** How hard the landing was, 0..~2, against `refSpeed`. Everything reads this. */
  get impactLoad() {
    return clamp(this.impactSpeed / Math.max(settings.anvilfall.refSpeed, 0.5), 0, 2.5);
  }

  /** Metres the floor actually gives way by, for this landing. */
  get dentDepth() {
    const c = settings.anvilfall;
    return c.dishDepth * Math.pow(this.impactLoad, Math.max(c.dishCurve, 0.05));
  }

  /** Seconds the pressure front takes to cross `shockRadiusEnd`. */
  get shockTime() {
    const c = settings.anvilfall;
    const speed = Math.max(this.impactSpeed * Math.max(c.shockSpeedRatio, 0.01), 0.5);
    return Math.max(0.05, c.shockRadiusEnd / speed);
  }

  /** The anvil sits there long enough for the front to cross and the dust to go. */
  get impactDuration() {
    const c = settings.anvilfall;
    const busy = Math.max(this.shockTime + c.shockDelay, c.settleTime, c.dustLifetime * 0.6);
    return Math.max(0.3, (busy + c.holdTime) * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.2, settings.anvilfall.fadeTime);
  }

  /** Steel does not gutter. A steady light, faintly breathing. */
  lightShimmer() {
    return 0.94 + 0.06 * Math.sin(this.age * 2.1);
  }

  /* ------------------------------------------------------------------ */
  /* Where the anvil is                                                  */
  /* ------------------------------------------------------------------ */

  /** The point on the floor the anvil is aimed at. */
  _landingPoint(out) {
    const c = settings.anvilfall;
    this.pointAt(1, out);
    out.addScaledVector(this.direction, c.driftForward);
    out.addScaledVector(this.side, c.driftSide);
    out.y = 0;
    return out;
  }

  /**
   * Metres the anvil's seat is above (positive) or below (negative) the floor.
   *
   * Before contact this is the fall curve. After it, the anvil settles into
   * the dent it just made — `dishSink` of the live dent depth plus a
   * `settleDrop` of pure compression — and, right at the end of the fade,
   * sinks out of sight rather than fading out.
   *
   * @param {number} fadePhase 0..1 through the *fade* only; 0 while it holds
   */
  _seatHeight(fadePhase) {
    const c = settings.anvilfall;
    if (!this._landed) {
      const u = this.phase === AbilityPhase.TRAVEL ? saturate(this.u) : 1;
      return Math.max(c.dropHeight, 0) * (1 - Math.pow(u, Math.max(c.fallCurve, 0.05)));
    }
    const since = Math.max(0, this.age - this._landedAt);
    const settle = Easing.outCubic(saturate(since / Math.max(c.settleTime, 0.02)));
    const bed = (this.dentDepth * saturate(c.dishSink) + c.settleDrop) * settle;
    const exit = c.exitSink * settings.anvilfall.anvilSize * Easing.inQuad(saturate(fadePhase));
    return -(bed + exit);
  }

  /** The anvil's yaw, radians. It stops turning the moment it lands. */
  _yaw() {
    const c = settings.anvilfall;
    const spinFor = this._landed ? this._landedAt : this.age;
    return this._seed * TAU + c.yawTurns * TAU * spinFor;
  }

  /** How far it is still tipped over, radians. Levels out as it comes down. */
  _tilt() {
    const c = settings.anvilfall;
    if (this._landed) return 0;
    const u = this.phase === AbilityPhase.TRAVEL ? saturate(this.u) : 1;
    return c.tilt * Math.pow(1 - u, Math.max(c.tiltSettle, 0.05));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.dustEmitter.reset();

    this._seed = Math.random();
    this._landed = false;
    this._landedAt = 0;
    this._markSlots.fill(null);

    this.dish.clearMarks();
    this.dish.setVisible(false);
    this.shock.visible = false;
    this.anvil.visible = true;

    this._sync(0, 1);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Re-resolve everything and drive the three modules.
   *
   * @param {number} fade      1 while it is fresh, ramping to 0 as the cast goes
   * @param {number} fadePhase 0..1 through the fade only — drives the exit sink
   */
  _sync(fade, fadePhase) {
    const c = settings.anvilfall;
    const g = settings.global;

    /* ---- the anvil ---- */
    this._syncShape(c);
    this._landingPoint(_land);
    this.anvil.position.set(_land.x, this._seatHeight(fadePhase), _land.z);
    this.anvil.scale.setScalar(Math.max(c.anvilSize, 0.02));
    // Tilt about the axis across the fall, so it comes down leaning on the
    // horn and rolls flat rather than pitching forward and back.
    const tilt = this._tilt();
    this.anvil.rotation.set(tilt, this._yaw(), tilt * 0.4);

    this._syncMetal(c, g);
    this._syncDent(c, g, fade);
    this._syncShock(c, g, fade);
    this._syncParticles(c, g);
  }

  /**
   * The silhouette. Eleven live sliders through a `ShapeCache`.
   *
   * The cache rebuilds only when one of the numbers below actually moves, and
   * the anvil is a lathe with two lofts in it — four-odd milliseconds a build.
   * Doing it unconditionally would be four milliseconds a *frame* to produce a
   * byte-identical buffer, which is the mistake `ShapeCache` exists to stop.
   */
  _syncShape(c) {
    const s = this._shape;
    s.height = Math.max(c.bodyHeight, 0.15);
    s.faceWidth = Math.max(c.faceWidth, 0.05);
    s.faceDepth = Math.max(c.faceDepth, 0.05);
    s.waistWidth = Math.max(c.waistWidth, 0.03);
    s.waistDepth = Math.max(c.waistWidth * 0.92, 0.03); // the waist is very slightly oval
    s.waistHeight = Math.max(c.waistHeight, 0.03);
    s.baseWidth = Math.max(c.baseWidth, 0.05);
    s.baseDepth = Math.max(c.baseWidth * 0.79, 0.05); // ... and so is the foot
    s.horn = Math.max(c.hornReach, 0);
    s.hornDroop = c.hornDroop;
    s.fillet = saturate(c.fillet);
    s.corner = clamp(c.corner, 0, 0.9);
    const geometry = this.shapes.get(0, HardShape.ANVIL, s);
    if (this.anvil.geometry !== geometry) this.anvil.geometry = geometry;
  }

  /** The steel. `syncHardSurfaceMaterial` every frame, zero-length ones too. */
  _syncMetal(c, g) {
    _hard.colorMetal = c.colorMetal;
    _hard.colorDeep = c.colorDeep;
    _hard.colorScale = c.colorScale;
    _hard.colorPolish = c.colorPolish;
    _hard.colorSpec = c.colorSpec;
    _hard.roughness = c.roughness;
    _hard.metalness = c.metalness;
    _hard.envIntensity = c.envIntensity;

    _hard.brush = Math.round(clamp(c.brushMode, 0, 2));
    _hard.brushAxisX = c.brushAxisX;
    _hard.brushAxisY = c.brushAxisY;
    _hard.brushAxisZ = c.brushAxisZ;
    _hard.anisotropy = c.anisotropy;
    _hard.specular = c.specular;
    _hard.grain = c.grain;
    _hard.grainScale = c.grainScale;
    _hard.grainStretch = c.grainStretch;

    _hard.scale = c.millScale;
    _hard.scaleScale = c.millScaleSize;
    _hard.scaleSharp = c.millScaleSharp;
    _hard.pit = c.pit;
    _hard.pitScale = c.pitScale;
    _hard.wear = c.wear;
    _hard.wearGrain = c.wearGrain;

    _hard.heat = c.heat;
    _hard.heatCold = c.heatCold;
    _hard.heatHot = c.heatHot;
    _hard.heatRef = c.heatRef;
    _hard.heatExponent = c.heatExponent;
    _hard.heatGlow = c.heatGlow;
    _hard.heatTint = c.heatTint;
    _hard.heatEdge = c.heatEdge;

    _hard.glow = g.glow;
    _hard.shaderIntensity = g.shaderIntensity;
    _hard.noiseFrequency = g.noiseFrequency;

    syncHardSurfaceMaterial(this.anvilMaterial, _hard);
  }

  /**
   * The dent, and the five craters that make it anvil-shaped.
   *
   * The frame is yawed to `anvilYaw + π/2` so the field's local **+Z** lies
   * along the anvil's own long axis — the generators seat the part with its
   * axis on +Y and the horn on local +X, and `GroundField` puts local +Z
   * downrange, so the two frames are a quarter turn apart. Getting that wrong
   * lays the dent across the anvil instead of under it, which looks almost
   * right until the yaw slider is touched.
   */
  _syncDent(c, g, fade) {
    const radius = Math.max(c.dishRadius, 0.2);
    const depth = this.dentDepth;

    // Re-derive every crater already in the floor. Only the timestamp survives
    // from the moment of contact — see `_markSlots`.
    if (this._landed) {
      const span = c.anvilSize * c.dishFootprint;
      for (let i = 0; i < FOOT_MARKS; i++) {
        const slot = this._markSlots[i];
        if (!slot) continue;
        // −0.5 at the heavy end, +0.5 at the horn.
        const s = FOOT_MARKS > 1 ? i / (FOOT_MARKS - 1) - 0.5 : 0;
        slot.x = 0;
        slot.y = (s * span) / radius;
        slot.w = saturate(lerp(c.dishBaseLoad, c.dishHornLoad, i / Math.max(FOOT_MARKS - 1, 1)));
      }
    }

    _dish.centre.copy(_land);
    _dish.yaw = this._yaw() + HALF_PI;
    _dish.height = c.dishHeight;
    _dish.radius = radius;
    _dish.length = radius * 2;
    _dish.grow = 1;
    _dish.recede = 0;
    _dish.progress = 1;
    _dish.fade = fade;
    _dish.seed = this._seed * 100;

    _dish.edge = c.dishEdge;
    _dish.ragged = c.dishRagged;
    _dish.raggedScale = c.dishRaggedScale;
    _dish.warp = c.dishWarp;

    _dish.relief = c.dishRelief;
    _dish.normalStep = c.dishNormalStep;
    _dish.ambient = c.dishAmbient;
    _dish.wrap = c.dishWrap;
    _dish.specular = c.dishSpecular;
    _dish.gloss = c.dishGloss;
    _dish.parallax = c.dishParallax;

    _dish.depth = depth;
    _dish.lift = c.dishLift;
    _dish.thickness = c.dishRimWidth;
    _dish.detail = c.dishGrain;
    _dish.speed = c.dishDig;
    _dish.markLife = c.dishLife;
    _dish.markRadius = c.dishMarkRadius;

    _dish.additive = false;
    _dish.emissive = c.dishEmissive;
    _dish.opacity = c.dishOpacity;
    _dish.depthFade = c.dishDepthFade;
    _dish.colorBase = c.colorDishBase;
    _dish.colorEdge = c.colorDishEdge;
    _dish.colorGlow = c.colorDishGlow;
    _dish.colorDeep = c.colorDishDeep;

    _dish.noiseStrength = g.noiseStrength;
    _dish.noiseFrequency = g.noiseFrequency;
    _dish.noiseSpeed = g.noiseSpeed;
    _dish.opacityScale = g.opacity;

    this.dish.update(_dish);
    this.dish.setVisible(this._landed && fade > 0.004);
  }

  /**
   * The pressure front.
   *
   * `t` is not `age / lifetime` — it is `since contact / shockTime`, and
   * `shockTime` is the reach divided by a fraction of the arrival speed. That
   * is the only reason the front and the camera shake ever agree with each
   * other about how hard the thing hit.
   */
  _syncShock(c, g, fade) {
    if (!this._landed) {
      this.shock.visible = false;
      return;
    }
    const since = Math.max(0, this.age - this._landedAt - c.shockDelay);
    const t = saturate(since / this.shockTime);

    _shock.origin.copy(_land);
    _shock.axis.set(0, 1, 0);
    _shock.side.copy(this.side);
    _shock.span = c.shockSpan;
    _shock.t = t;
    // A pressure front dies as it runs out of energy, not when the cast does:
    // squared so the last third of its travel is already almost gone.
    _shock.fade = fade * (1 - t) * (1 - t);
    _shock.seed = this._seed * 100;

    this.shock.sync(c, _shock, g);
    this.shock.visible = _shock.fade > 0.004;
  }

  /** Colours, sizes and the two globals every particle system folds in. */
  _syncParticles(c, g) {
    const load = this.impactLoad;

    this.dust.setGradient(
      getColor(c.colorDustA),
      getColor(c.colorDustB),
      getColor(c.colorDustC),
      getColor(c.colorDustD)
    );
    this.dust.uniforms.uGravity.value.set(0, c.dustRise, 0);
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize;
    this.dust.uniforms.uLifeScale.value = c.dustLifetime * 0.5 * g.particleLifetime;
    // The plume leaves faster off a harder landing, from the same slider.
    this.dust.uniforms.uSpeedScale.value = c.dustSpeed * load * g.particleSpeed * 0.2;
    this.dust.uniforms.uOpacity.value = c.dustOpacity * g.opacity;
    this.dust.uniforms.uTurbulence.value = c.dustTurbulence * g.turbulence;

    this.chips.setGradient(
      getColor(c.colorChipA),
      getColor(c.colorChipB),
      getColor(c.colorChipC),
      getColor(c.colorChipD)
    );
    this.chips.uniforms.uGravity.value.set(0, c.chipGravity, 0);
    this.chips.uniforms.uSizeScale.value = c.chipSize * g.particleSize * 7;
    this.chips.uniforms.uLifeScale.value = g.particleLifetime;
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
    this.sparks.uniforms.uGlow.value = 1.6 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
  }

  /**
   * The tint struck sparks leave at.
   *
   * Sparks off steel are the temperature of the steel, so the one slider that
   * drives the metal drives them too. Hard-coding an orange here is how a
   * cherry-red anvil ends up throwing lemon-yellow sparks — `HardSurface`'s own
   * note, and it is right. At `heat = 0` the locus clamps at 700 K, which is
   * black, so `sparkHeatTint` blends back toward the authored gradient and a
   * cold strike keeps its own colour.
   */
  _sparkTint(c) {
    blackbodyColor(heatToKelvin(saturate(c.heat), _hard), _tint);
    return _tint.lerp(getColor(c.colorSparkA), 1 - saturate(c.sparkHeatTint));
  }

  /**
   * Fire one contact spray radially out of the footprint.
   *
   * The caller has already filled `_emit` with everything that is not
   * positional; this only walks the bearings. `_emit.direction` points along
   * the bearing with `up` folded in, so the whole sheet leaves the way the
   * material under a falling flat face actually has to go — sideways.
   *
   * @param {object} system   the particle system to emit from
   * @param {number} total    particles across all batches
   * @param {number} radius   metres from the landing point the batch sits at
   * @param {number} height   metres above the floor
   * @param {number} up       how much +Y is folded into the outward direction
   * @param {number} scatter  metres of emission radius per batch
   */
  _ringEmit(system, total, radius, height, up, scatter) {
    if (total <= 0) return;
    const per = Math.max(1, Math.round(total / CONTACT_BATCHES));
    let left = total;
    for (let i = 0; i < CONTACT_BATCHES && left > 0; i++) {
      // Phased off the cast's own seed so two casts do not spray identically,
      // and off nothing else — a Math.random() here would make the ability
      // restless under the harness's paused probe for no gain.
      const angle = (i / CONTACT_BATCHES + this._seed) * TAU;
      const cx = Math.cos(angle);
      const cz = Math.sin(angle);
      _pos.copy(_land);
      _pos.x += cx * radius;
      _pos.z += cz * radius;
      _pos.y = height;
      _dir.set(cx, Math.max(up, 0.05), cz).normalize();
      _emit.position = _pos;
      _emit.direction = _dir;
      _emit.radius = scatter;
      system.emit(Math.min(per, left), _emit);
      left -= per;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1, 0);

    // The light rides down with the anvil, so the floor brightens as it comes.
    // Read straight off the mesh rather than through `getWorldPosition`: the
    // ability's group carries an identity matrix it never updates, so the two
    // agree and only one of them depends on traversal order.
    this.position.copy(this.anvil.position);
    this.position.y += settings.anvilfall.anvilSize * 0.4;

    this.ctx.shake.rumble(settings.anvilfall.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.anvilfall;
    const g = settings.global;
    const time = frame.uTime.value;
    const load = this.impactLoad;

    this._landed = true;
    this._landedAt = this.age;
    this._landingPoint(_land);

    /* ---- the dent: five craters in a line under the base ---- */
    // Position and strength are rewritten every frame in `_syncDent`; the only
    // thing that survives from here is the timestamp, which is the event.
    for (let i = 0; i < FOOT_MARKS; i++) {
      this._markSlots[i] = this.dish.mark(0, 0, time, 1);
    }
    this.dish.setVisible(true);
    this._sync(1, 0);

    /* ---- what is squeezed out from under it ---- */
    const rim = Math.max(c.anvilSize * 0.5, 0.1);

    _emit.speed = c.dustSpeed * load;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.7;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 1.0;
    _emit.sizeVariance = 0.55;
    _emit.life = c.dustLifetime;
    _emit.lifeVariance = 0.45;
    _emit.spin = 0.4;
    _emit.tint = null;
    _emit.time = time;
    this._ringEmit(this.dust, Math.round(c.dustCount * g.particleCount), rim * 1.15, c.dustHeight, 0.55, rim * 0.6);

    _emit.speed = c.chipSpeed * load;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.55;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.75;
    _emit.life = c.chipLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 11;
    // `chipSpray` tips the outward direction from straight up (0) to flat
    // along the floor (1). Flat is the heavy read.
    this._ringEmit(this.chips, Math.round(c.chipCount * g.particleCount), rim, 0.05, 1 - saturate(c.chipSpray), rim * 0.4);

    _emit.speed = c.sparkSpeed * load;
    _emit.speedVariance = 0.9;
    _emit.spread = 0.5;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = this._sparkTint(c);
    this._ringEmit(this.sparks, Math.round(c.sparkCount * g.particleCount), rim * 0.9, 0.08, 0.35, rim * 0.3);
    _emit.tint = null;

    /* ---- the camera ---- */
    // Low frequency and a long decay. A heavy landing is a *slow* shake; the
    // 26 Hz snap the bolt uses reads as something small and sharp, and using it
    // here was the single worst frame of the first pass.
    this.ctx.shake.add(
      c.impactShake * load * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      Math.max(c.shakeFrequency, 1)
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * load * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * load * 0.9 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.anvilfall;
    const g = settings.global;
    // `t` runs 0..1 while it sits there, then 1..2 while the cast lets go.
    const fadePhase = t <= 1 ? 0 : saturate((t - 1 - c.exitStart) / Math.max(1 - c.exitStart, 0.05));
    const fade = t <= 1 ? 1 : 1 - Easing.inQuad(saturate(t - 1));

    this._sync(fade, fadePhase);
    this.position.copy(_land).setY(c.lightHeight);

    // Dust keeps rolling off the dent for a moment, thinning as it goes. Gated
    // on the emitter's own accumulator, so a paused frame emits nothing and a
    // long frame emits the right amount.
    const settle = this.phase === AbilityPhase.IMPACT ? 1 - saturate(t / 0.7) : 0;
    const rate = c.dustRate * settle * this.impactLoad;
    const count = Math.round(this.dustEmitter.tick(dt, rate) * g.particleCount);
    if (count > 0) {
      _pos.copy(_land);
      _pos.y = c.dustHeight * 0.6;
      _emit.position = _pos;
      _emit.radius = Math.max(c.anvilSize * 0.8, 0.1);
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.dustSpeed * 0.3;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.95;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.8;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime * 0.8;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.dust.emit(count, _emit);
    }

    this.ctx.shake.rumble(c.settleRumble * fade * settle * g.cameraShake, dt);
  }

  onDestroy() {
    this._landed = false;
    this._landedAt = 0;
    this._markSlots.fill(null);
    this.dish.clearMarks();
    this.dish.setVisible(false);
    this.shock.visible = false;
  }

  dispose() {
    this.dish.dispose();
    this.shock.dispose();
    this.shapes.dispose();
    this.anvilMaterial.dispose();
    super.dispose();
  }
}
