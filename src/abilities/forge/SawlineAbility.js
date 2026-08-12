import { Color, Matrix4, Mesh, Quaternion, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import {
  HardShape,
  HardAxis,
  BrushMode,
  ShapeCache,
  GrindContact,
  sawbladeShape,
  plateShape,
  createPlateGeometry,
  createHardSurfaceMaterial,
  hardSurfaceParams,
  grindParams,
  blackbodyColor,
  heatToKelvin
} from '../../vfx/HardSurface.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { Projectile, FlightMode, Stagger, projectileParams } from '../../vfx/Projectile.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, Easing, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;

/** Hard ceiling on slugs thrown by the last bite. The `offcutCount` slider clamps here. */
const MAX_OFFCUTS = 24;
/**
 * Tessellation of the blade, fixed rather than exposed.
 *
 * A `SAWBLADE` is about four milliseconds of contour work to build, and every
 * *shape* slider rebuilds it through the `ShapeCache`. The tooth count is the
 * silhouette and the flank sample count is not — three samples along a
 * logarithmic-spiral face is already smooth at any size this ability draws at,
 * and raising it only buys vertices and rebuild milliseconds. So these are
 * constants with a reason rather than sliders without one.
 */
const FLANK_STEPS = 3;
const GULLET_STEPS = 3;
const SLOT_STEPS = 3;
const ARBOR_SEGMENTS = 20;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _hub = new Vector3();
const _contact = new Vector3();
const _arc = new Vector3();
const _rim = new Vector3();
const _normal = new Vector3(0, 1, 0);
const _spinAxis = new Vector3();
const _basisX = new Vector3();
const _basisY = new Vector3(0, 1, 0);
const _basisZ = new Vector3();
const _basis = new Matrix4();
const _qBase = new Quaternion();
const _qSpin = new Quaternion();
const _qLean = new Quaternion();
const _tint = new Color();
const _bb = new Color();

/** Live param bags, filled from `settings.sawline` every frame and never kept. */
const _hard = hardSurfaceParams();
const _grind = grindParams();
const _ground = groundFieldParams();
const _flight = projectileParams();

/**
 * The blade's shape. Unitless proportions only — `HardSurface` shapes carry no
 * metres, so this object is safe to hold across frames: it is *refilled* from
 * the block every frame and the `ShapeCache` rebuilds only when a number in it
 * actually moved.
 */
const _saw = sawbladeShape({
  axis: HardAxis.X,
  flankSteps: FLANK_STEPS,
  gulletSteps: GULLET_STEPS,
  slotSteps: SLOT_STEPS,
  arborSegments: ARBOR_SEGMENTS
});

/** The offcut slug's shape. Same rules. */
const _slug = plateShape({ bolts: 0, axis: HardAxis.Y });

/**
 * SAWLINE — a machined blade dropped into the floor and run down the aimed line.
 *
 * A 1.4-metre circular saw lands at the caster's feet, buries a quarter of a
 * metre of rim in the stone and tracks out to the far end of the cast, cutting
 * a kerf and throwing a continuous sheaf of sparks. It grinds in place for
 * `lifetime`, hurls a handful of glowing offcuts downrange on the last bite,
 * then dives into its own cut and is gone.
 *
 * ## THE TRICK — the sparks leave at the contact tangent
 *
 * A saw that throws sparks radially is a firework. It is also what you get for
 * free from every particle system in this project, because "emit in a cone
 * away from the surface" is the default and it is wrong here in a way that is
 * instantly readable: a dandelion instead of an angle grinder.
 *
 * Real grinding sparks are lumps of the workpiece that were travelling with
 * the tooth at the moment it let go of them. They carry off the *tooth's*
 * velocity, and a tooth at the rim is moving tangentially by definition. So
 * the emission direction here is `ω × r`, evaluated at the contact:
 * `GrindContact.rimVelocity(out, axis, rate, point, centre)` with the spin
 * axis being the cast's own `side` vector, and the speed is
 * `grindGain × |ω × r|` clamped between a floor and a ceiling rather than an
 * authored metres-per-second. Every one of those is a live number, so
 * doubling `bladeSpin` while paused genuinely doubles how hard the sparks
 * leave, and flipping its **sign** throws the whole sheaf from behind the
 * blade to in front of it.
 *
 * Two corrections sit on top of the bare cross product, both inside
 * `GrindContact` and both sliders here:
 *
 *  - the component of `ω × r` pointing *into* the floor is reflected back out
 *    with a restitution (`grindBounce`), because sparks do not tunnel;
 *  - the whole sheaf is tilted off the surface by `grindRise`, which is the
 *    rooster tail every photograph of a grinder shows.
 *
 * ### Where the contact is, and why it is not simply "under the hub"
 *
 * The first version struck the sparks from the point on the floor directly
 * below the hub. That looks fine in a still and is wrong in motion, because at
 * bottom dead centre `ω × r` is exactly horizontal: the sheaf came out flat,
 * skated along the ground and never arced. The blade is a circle cutting a
 * plane, so the real contact is a **chord** — the arc between where a tooth
 * enters the stone and where it leaves — and the tangent has a genuine
 * vertical component everywhere along it except the middle.
 *
 * So `contactPhase` walks the strike point along that chord: −1 at the entry
 * edge, 0 at bottom dead centre, +1 at the exit edge. The half-chord is
 * `√(R² − hubY²)`, which falls straight out of the blade radius and how deep
 * it is buried — both live — and it goes to zero the instant the rim clears
 * the floor, which is exactly when the sparks should stop. That is why the
 * blade's exit works without a single "stop emitting" flag: it lifts out of
 * the chord and there is nothing left to grind.
 *
 * The rim velocity is computed at the true point on the arc, but the sparks
 * are *emitted* from that point raised to floor level: a spark born 20 cm down
 * inside a kerf is a spark nobody sees, and the stream reads as thinning out
 * for no reason.
 *
 * ### The blade is not a `Projectile`, and that was tried
 *
 * `Projectile`'s `ROLL` mode is real rolling — the contact point is
 * instantaneously at rest, the angle is distance over radius and nothing else.
 * It is the obviously right module and it is the wrong answer here, because
 * rolling *ties the rim speed to the travel speed*. A blade advancing at 11
 * m/s would have a rim doing 11 m/s, the sparks would leave at walking pace,
 * and the one number the whole slot is about would stop being a number at all.
 * A cutting blade slips: it spins two orders of magnitude faster than it
 * advances, and that decoupling is the ability. So the blade is a plain `Mesh`
 * whose orientation this file owns — one draw call, and `bladeSpin` is free to
 * be its own signed radians-per-second.
 *
 * `Projectile` still earns its place, on the offcuts: eight slugs on a
 * parametric arc with vertex-shader trails, staggered launches, and an
 * `arrivals` event per landing that fires its own spark burst and scorch.
 *
 * ## The brushing
 *
 * `HardSurface`'s material is set to `BrushMode.CIRCUMFERENTIAL` about the
 * blade's own local axis, which for a `SAWBLADE` seated on `HardAxis.X` is
 * local **+X**. That is not a detail: the grain on a surface-ground plate runs
 * *round* it, and the anisotropic lobe smears the highlight across the grain
 * into an arc that swings as the blade turns. With `LINEAR` brushing the same
 * geometry, the same albedo and the same heat read as a painted disc.
 *
 * ## The rule that makes the editor work
 *
 * A cast captures two things and both are events: `_seed`, so two casts do not
 * wander the same way, and `_markDistance`, a cursor over how much of the kerf
 * has already been recorded. Every metre, radian and second — the blade's diameter,
 * how deep it bites, where on the chord it strikes, how fast the rim is going,
 * the spark speed that falls out of it, the depth of the kerf and the flight of
 * the offcuts — is resolved from `settings.sawline` inside the update loop, on
 * a zero-length frame included. Pause mid-cut and drag `contactPhase`: the
 * sheaf swings from the back of the blade to the front, because the contact is
 * a function of the slider rather than something that was integrated while you
 * were watching.
 *
 * Seven draw calls: the blade, the kerf, the offcut bodies, their trails, and
 * three particle systems.
 */
export class SawlineAbility extends Ability {
  constructor(context) {
    super('sawline', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const environment = this.ctx.environment;

    /**
     * The blade's geometry cache. One slot, and it is *ours* — a shared cache
     * would have to reference-count, and the first thing that would happen is
     * somebody else's rebuild freeing the geometry this mesh is drawing.
     */
    this.cache = new ShapeCache({ capacity: 2 });

    /* --- the blade: one Mesh, one draw call --- */
    this.metal = createHardSurfaceMaterial({ environment });
    this.blade = new Mesh(this.cache.get(0, HardShape.SAWBLADE, this._bladeShape()), this.metal);
    this.blade.frustumCulled = false;
    this.blade.layers.set(LAYER.WORLD);
    this.blade.renderOrder = 2;
    this.blade.receiveShadow = true;
    this.group.add(this.blade);

    /* --- the kerf it cuts --- */
    this.kerf = new GroundField(this.group, {
      mode: GroundMode.RUT,
      marks: 16,
      additive: false,
      name: 'Sawline:kerf'
    });
    this.kerf.setVisible(false);

    /* --- the offcuts thrown by the last bite --- */
    // Their own material, not the blade's: a slug is cut *floor*, and giving
    // it the blade's five pickers would be deriving one colour from another
    // (I5). It is also brushed LINEAR rather than circumferential, because a
    // torn-off lump has a rolling direction and no lathe ever touched it.
    this.slag = createHardSurfaceMaterial({ environment });
    this.offcuts = new Projectile(this.group, {
      geometry: () => createPlateGeometry(this._slugShape()),
      shapeKey: () => this._slugKey(),
      material: this.slag,
      capacity: MAX_OFFCUTS,
      trail: true,
      trailNodes: 24,
      trailAdditive: true,
      layer: LAYER.WORLD,
      renderOrder: 2,
      castShadow: false
    });

    /** The solver that turns a contact into spark jets. THE TRICK lives here. */
    this.grind = new GrindContact();
    /** True on the frames the rim is actually inside the floor. */
    this._cutting = false;

    /** Re-rolled per cast so two blades do not wander the same way. */
    this._seed = 0;
    /** Metres of travel already recorded as kerf contact samples. A cursor. */
    this._markDistance = 0;

    /**
     * The cast's beats, all unitless, refilled every frame.
     *
     *   cut   0..1  how far the rim has sunk to its full depth
     *   dive  0..1  how far through the exit it is
     *   fade  1..0  master opacity on the kerf
     */
    this._b = { cut: 0, dive: 0, fade: 1 };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The sparks. Velocity-stretched streaks under a hard gravity, which is
    // what turns a straight tangential jet into the drooping arc a grinder
    // actually throws.
    this.sparks = particles.get('sawline.sparks', {
      capacity: 4000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.1;
    this.sparks.uniforms.uEndSize.value = 0.2;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.02;
    this.sparks.uniforms.uFadeOut.value = 0.5;

    // Cold chips of floor kicked out of the kerf. Lit rather than additive:
    // they have to read as rubble against the sparks, not as more sparks.
    this.grit = particles.get('sawline.grit', {
      capacity: 1200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.grit.uniforms.uDrag.value = 0.35;
    this.grit.uniforms.uEndSize.value = 0.7;
    this.grit.uniforms.uFadeOut.value = 0.65;

    // Stone dust off the cut. Non-additive so it genuinely occludes the sparks
    // behind it, which is most of what sells the depth of the kerf.
    this.smoke = particles.get('sawline.smoke', {
      capacity: 1400,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.smoke.uniforms.uDrag.value = 1.8;
    this.smoke.uniforms.uEndSize.value = 2.6;
    this.smoke.uniforms.uSizeIn.value = 0.14;
    this.smoke.uniforms.uFadeIn.value = 0.18;
    this.smoke.uniforms.uFadeOut.value = 0.32;

    this.sparkEmitter = new RateEmitter();
    this.gritEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return 1 + this.offcuts.count;
  }

  /** The blade grinds in place at the far end, then dives out. */
  get impactDuration() {
    return Math.max(0.05, settings.sawline.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.sawline.fadeTime);
  }

  /**
   * The light stutters at roughly tooth rate.
   *
   * A saw does not gutter the way a bolt does — the cut is continuous and the
   * only thing modulating it is the teeth going past. So this is a quantised
   * step rather than a smooth wave, hashed off the step index so it snaps
   * between levels instead of oscillating between two of them.
   */
  lightShimmer() {
    const c = settings.sawline;
    const step = Math.floor(this.age * Math.max(1, c.lightFlickerSpeed));
    const noise = Math.abs(Math.sin(step * 91.7) * 43758.5453) % 1;
    return 1 - saturate(c.lightFlicker) * noise;
  }

  /* ------------------------------------------------------------------ */
  /* Shapes — proportions, refilled from the block every frame            */
  /* ------------------------------------------------------------------ */

  /** The blade's outline. Not one metre in here; see the settings header. */
  _bladeShape() {
    const c = settings.sawline;
    _saw.teeth = Math.max(6, Math.round(c.teeth));
    _saw.rake = c.toothRake;
    _saw.clearance = c.toothClearance;
    _saw.gullet = c.toothGullet;
    _saw.tipLand = c.toothLand;
    _saw.thickness = c.bladeThickness;
    _saw.chamfer = c.bladeChamfer;
    _saw.arbor = c.bladeArbor;
    _saw.slots = Math.max(0, Math.round(c.bladeSlots));
    _saw.slotDepth = c.slotDepth;
    _saw.slotWidth = c.slotWidth;
    _saw.creaseAngle = c.bladeCrease;
    return _saw;
  }

  /** One offcut slug's outline. */
  _slugShape() {
    const c = settings.sawline;
    _slug.width = c.slugWidth;
    _slug.depth = c.slugDepth;
    _slug.thickness = c.slugThickness;
    _slug.corner = c.slugCorner;
    _slug.bevel = c.slugBevel;
    return _slug;
  }

  /**
   * The slug's rebuild key.
   *
   * `Projectile#syncGeometry` stringifies whatever this returns and compares
   * it, so it has to fold every number that changes the outline into one
   * value. A number rather than a template literal: at fifty abilities a
   * per-frame template literal is fifty strings a frame for the collector.
   */
  _slugKey() {
    const c = settings.sawline;
    return (
      c.slugWidth * 1e0 + c.slugDepth * 1e3 + c.slugThickness * 1e6 + c.slugCorner * 1e9 + c.slugBevel * 1e12
    );
  }

  /* ------------------------------------------------------------------ */
  /* Geometry of the cut — every metre resolved from live settings        */
  /* ------------------------------------------------------------------ */

  /** Half the blade's diameter, metres. */
  _radius() {
    return Math.max(0.05, settings.sawline.bladeDiameter * 0.5);
  }

  /**
   * How far off the cast line the blade has drifted at `distance` metres out.
   *
   * Two octaves, not one. A single sine is a slalom — a perfectly periodic
   * left-right that reads as an animation curve the moment the camera settles.
   * The second, incommensurate term turns it into a drift, which is what a
   * heavy thing cutting into uneven stone actually does.
   */
  _wanderAt(distance) {
    const c = settings.sawline;
    const a = distance * c.bladeWanderScale * TAU + this._seed;
    return (Math.sin(a) * 0.65 + Math.sin(a * 2.3 + 1.7) * 0.35) * c.bladeWander;
  }

  /** How far down the line the blade is, 0..1. */
  _reach() {
    return this.phase === AbilityPhase.TRAVEL ? this.u : 1;
  }

  /**
   * The hub, in world space.
   *
   * The height is the whole state machine in one line: a blade whose rim sits
   * `bite` below the floor has its hub at `R − bite`, and the exit simply keeps
   * subtracting until the hub is more than a radius under and there is no
   * intersection left to grind.
   */
  _hubPoint(out) {
    const c = settings.sawline;
    const b = this._b;
    const s = this._reach();
    this.pointAt(s, out);
    out.addScaledVector(this.side, this._wanderAt(s * this.length));
    out.y = this._radius() - c.bladeBite * b.cut - c.bladeExit * b.dive;
    return out;
  }

  /**
   * Resolve the contact and hand it to `GrindContact`.
   *
   * @returns {boolean} false when the rim is not in the floor at all — which is
   *   true before the blade has sunk and again once it has dived through.
   */
  _solveGrind() {
    const c = settings.sawline;
    const R = this._radius();
    this._hubPoint(_hub);
    const hubY = _hub.y;

    // No chord: the rim is clear of the floor, or the hub is a full radius
    // under it and the blade has vanished into its own cut.
    if (Math.abs(hubY) >= R) return false;

    // The engagement chord. Half of it is √(R² − hubY²) — the offset from the
    // hub, along the heading, to where the circle crosses y = 0.
    const half = Math.sqrt(Math.max(0, R * R - hubY * hubY));
    const phase = clamp(c.contactPhase, -1, 1);
    const dx = half * phase;

    // The true point on the arc, which is what ω × r must be evaluated at.
    _arc.copy(_hub).addScaledVector(this.direction, dx);
    _arc.y = hubY - Math.sqrt(Math.max(0, R * R - dx * dx));

    // The spin axis is the cast's side vector, rolled by the blade's lean. The
    // chord above is measured on the upright circle; at the small leans this
    // slider is for the difference is under a percent, and correcting it would
    // cost an ellipse solve for something nobody can see.
    _spinAxis.copy(this.side).applyAxisAngle(this.direction, c.bladeLean).normalize();
    GrindContact.rimVelocity(_rim, _spinAxis, c.bladeSpin, _arc, _hub);

    // Emit from the mouth of the kerf, not from the bottom of it. See the
    // class doc: a spark born inside the slot is a spark nobody sees.
    _contact.copy(_arc);
    _contact.y = Math.max(_contact.y, 0);

    _normal.set(0, 1, 0);
    this._fillGrind();
    this.grind.solve(_contact, _normal, _rim, _grind);
    return true;
  }

  /** `GrindContact`'s params, straight off the block. */
  _fillGrind() {
    const c = settings.sawline;
    const g = settings.global;
    _grind.lift = c.grindLift;
    _grind.bounce = c.grindBounce;
    _grind.rise = c.grindRise;
    _grind.speedGain = c.grindGain;
    // Metres per second, and NOT scaled by `global.particleSpeed` — the
    // particle shader multiplies that in once already, and doing it here as
    // well makes the global a square.
    _grind.speedFloor = c.grindFloor;
    _grind.speedCeiling = c.grindCeiling;
    _grind.fan = c.grindFan;
    _grind.swing = c.grindSwing;
    _grind.graze = c.grindGraze;
    _grind.jets = Math.max(1, Math.round(c.grindJets));
    _grind.spread = c.grindSpread;
    _grind.speedVariance = c.grindVariance * g.randomness;
    _grind.drift = c.grindDrift;
  }

  /**
   * Refill the beats from the phase clock. Fractions only.
   *
   * @param {number} t 0..1 through the impact phase, then 1..2 through the fade
   */
  _resolveBeats(t) {
    const c = settings.sawline;
    const b = this._b;

    if (this.phase === AbilityPhase.TRAVEL) {
      b.cut = saturate(this.u / Math.max(c.bladeBiteIn, 1e-3));
      b.dive = 0;
      b.fade = 1;
      return;
    }
    if (t <= 1) {
      b.cut = 1;
      b.dive = 0;
      b.fade = 1;
      return;
    }
    const s = saturate(t - 1);
    b.cut = 1;
    // Quadratic in: the blade hangs in the cut for a beat and then goes,
    // rather than sliding out at a constant rate like a lift.
    b.dive = Easing.inQuad(s);
    b.fade = 1 - Easing.inQuad(s);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.sparkEmitter.reset();
    this.gritEmitter.reset();
    this.smokeEmitter.reset();
    this._markDistance = 0;
    this._cutting = false;

    // The one dice roll a cast makes.
    this._seed = Math.random() * 100;

    this.offcuts.reset();
    this.offcuts.roll(this._seed);
    this.kerf.clearMarks();
    this.kerf.setVisible(true);
    this.blade.visible = true;

    this._resolveBeats(0);
    this._sync();
    this._dropFx();
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live block into everything that draws.
   *
   * Order matters in one place: `_solveGrind()` runs first and everything
   * downstream reads the hub and contact it left in the scratch vectors, so
   * the blade, the sparks, the kerf's lit lip and the dynamic light cannot
   * disagree about where the cut is by a frame.
   */
  _sync() {
    this._cutting = this._solveGrind();
    this._syncBlade();
    this._syncKerf();
    this._syncOffcuts();
    this._syncParticles();

    // The light rides the contact while there is one, and the hub once the
    // blade has left the floor.
    this.position.copy(this._cutting ? _contact : _hub);
  }

  /**
   * The blade: geometry from the cache, orientation from three rotations.
   *
   * `q = lean · spin · base`, read right to left. `base` takes the blade out of
   * its own frame (local +X is the arbor axis, seated by `HardAxis.X`) into the
   * cast's frame; `spin` turns it about that axis; `lean` rolls the whole thing
   * about the heading so it is not dead square to the floor.
   *
   * The spin angle is `rate × age` in closed form rather than an integrated
   * accumulator, which is the difference between a slider that re-phases a
   * blade already in the ground and one that only affects the next cast.
   */
  _syncBlade() {
    const c = settings.sawline;
    const g = settings.global;

    this.blade.geometry = this.cache.get(0, HardShape.SAWBLADE, this._bladeShape());
    this.blade.castShadow = c.bladeShadow === true;

    const diameter = Math.max(0.1, c.bladeDiameter);
    this.blade.position.copy(_hub);
    // The unit blade is seated on y = 0 with the hub at half its diameter, so
    // the mesh's origin belongs a radius below the hub.
    this.blade.position.y -= diameter * 0.5;
    this.blade.scale.setScalar(diameter);

    _basisX.copy(this.side);
    _basisY.set(0, 1, 0);
    _basisZ.crossVectors(_basisX, _basisY);
    _basis.makeBasis(_basisX, _basisY, _basisZ);
    _qBase.setFromRotationMatrix(_basis);
    _qSpin.setFromAxisAngle(this.side, c.bladeSpin * this.age);
    _qLean.setFromAxisAngle(this.direction, c.bladeLean);
    this.blade.quaternion.copy(_qLean).multiply(_qSpin).multiply(_qBase);

    /* --- the steel --- */
    const p = _hard;
    p.colorMetal = c.colorMetal;
    p.colorDeep = c.colorDeep;
    p.colorScale = c.colorScale;
    p.colorPolish = c.colorPolish;
    p.colorSpec = c.colorSpec;
    p.roughness = c.steelRough;
    p.metalness = c.steelMetalness;
    p.envIntensity = c.steelEnv;

    // The one line that carries the machined read. See the class doc.
    p.brush = BrushMode.CIRCUMFERENTIAL;
    p.brushAxisX = 1;
    p.brushAxisY = 0;
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

    // Heat follows engagement, not the clock: a blade that is not touching
    // anything is not making heat, and lifting it out cools it on the way.
    p.heat = lerp(c.bladeHeatIdle, c.bladeHeat, saturate(this._b.cut) * (this._cutting ? 1 : 0));
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

    /* --- the slugs' steel: same bag, its own colours and its own heat --- */
    p.colorMetal = c.colorSlagMetal;
    p.colorDeep = c.colorSlagDeep;
    p.colorScale = c.colorSlagScale;
    p.colorPolish = c.colorSlagPolish;
    p.colorSpec = c.colorSlagSpec;
    p.roughness = c.slagRough;
    p.metalness = c.slagMetalness;
    p.scale = c.slagScale;
    p.pit = c.slagPit;
    // A torn lump has a rolling direction, not a turned one.
    p.brush = BrushMode.LINEAR;
    p.brushAxisX = 0;
    p.brushAxisY = 1;
    p.brushAxisZ = 0;
    p.heat = c.slagHeat;
    p.heatGlow = c.slagHeatGlow;
    p.heatTint = c.slagHeatTint;
    this.slag.userData.sync(p);
  }

  /** The kerf: a `GroundField(RUT)` running the length of the cast. */
  _syncKerf() {
    const c = settings.sawline;
    const g = settings.global;
    const b = this._b;
    const p = _ground;

    p.centre = this.origin;
    p.yaw = Math.atan2(this.direction.x, this.direction.z);
    p.height = c.kerfHeight;
    // For `RUT` the radius sizes the quad *across* the track rather than
    // drawing anything, so it has to cover the gouge, the spoil and the drift.
    p.radius = c.kerfWidth + c.kerfThickness * 3 + c.kerfWander;
    p.length = this.length;

    p.grow = 1;
    p.recede = 0;
    p.progress = this._reach();
    p.fade = b.fade;
    p.seed = this._seed;

    p.edge = c.kerfEdge;
    p.ragged = 0;
    p.raggedScale = c.kerfWanderScale * g.noiseFrequency;
    p.warp = 0;
    p.swirl = c.kerfWander;

    p.relief = c.kerfRelief;
    p.normalStep = c.kerfNormalStep;
    p.ambient = c.kerfAmbient;
    p.wrap = c.kerfWrap;
    p.specular = c.kerfSpecular;
    p.gloss = c.kerfGloss;
    p.parallax = c.kerfParallax;

    p.width = c.kerfWidth;
    p.depth = c.kerfDepth;
    p.lift = c.kerfLift;
    p.sharp = c.kerfSharp;
    p.thickness = c.kerfThickness;
    p.seam = c.kerfSeam;
    p.detail = c.kerfDetail;

    p.markLife = c.kerfMarkLife;
    p.markRadius = c.kerfMarkRadius;

    p.additive = false;
    p.emissive = c.kerfEmissive * g.glow;
    p.opacity = c.kerfOpacity;
    p.depthFade = c.kerfDepthFade;
    p.colorBase = c.colorKerfBase;
    p.colorEdge = c.colorKerfEdge;
    p.colorGlow = c.colorKerfGlow;
    p.colorDeep = c.colorKerfDeep;

    p.noiseStrength = g.noiseStrength;
    p.noiseFrequency = g.noiseFrequency;
    p.noiseSpeed = g.noiseSpeed;
    p.opacityScale = g.opacity;

    this.kerf.update(p);
  }

  /**
   * The offcuts.
   *
   * The basis is pinned to the cast line and the launch point is the far end
   * of it, which is where the blade is by the time any of these exist. That
   * pinning is deliberate: `Projectile` re-resolves every body's launch and
   * landing from the basis on every frame, so a basis that chased the moving
   * blade would drag every slug already in the air along with it — the arcs
   * would slide sideways and the whole volley would read as a smear.
   */
  _syncOffcuts() {
    const c = settings.sawline;
    const g = settings.global;
    const p = _flight;

    p.mode = FlightMode.ARC;
    p.stagger = Stagger.RIPPLE;
    p.count = this.phase === AbilityPhase.TRAVEL ? 0 : Math.min(MAX_OFFCUTS, Math.round(c.offcutCount));
    p.radius = c.offcutRadius;
    p.sizeJitter = c.offcutJitter * g.randomness;
    p.stretch = c.offcutStretch;
    p.align = c.offcutAlign;
    p.spin = c.offcutSpin * g.randomness;
    p.flash = c.offcutFlash;

    p.handForward = this.length;
    p.handSide = this._wanderAt(this.length);
    p.handHeight = Math.max(0.06, this._radius() - c.bladeBite);
    p.landHeight = c.offcutRadius * 0.5;
    p.landInZone = false;
    p.spreadSide = c.offcutSpreadSide;
    p.spreadForward = c.offcutSpreadForward;

    p.pathCurve = c.offcutCurve;
    p.apex = c.offcutApex;
    p.apexCurve = c.offcutApexCurve;
    p.weaveSide = 0;
    p.weaveUp = 0;

    p.flightTime = c.offcutFlight;
    p.speedJitter = c.offcutFlightJitter * g.randomness;
    p.lead = c.offcutLead;
    p.window = c.offcutWindow;
    p.linger = c.offcutLinger;
    p.sink = c.offcutSink;

    p.trailSpan = c.trailSpan;
    p.trailBurn = c.trailBurn;
    p.trailWidth = c.trailWidth;
    p.trailTaper = c.trailTaper;
    p.trailLift = c.trailLift;
    p.trailOpacity = c.trailOpacity * g.opacity;
    p.trailGlow = c.trailGlow * g.glow;
    p.trailCore = c.trailCore;
    p.trailHeadBias = c.trailHeadBias;
    p.trailNoise = c.trailNoise * g.noiseStrength;
    p.trailNoiseScale = c.trailNoiseScale * g.noiseFrequency;
    p.trailNoiseSpeed = c.trailNoiseSpeed * g.noiseSpeed;
    p.trailSoftFade = c.trailSoftFade;

    this.offcuts.setBasis(this.origin, this.direction, this.side, this.length + c.offcutThrow);
    this.offcuts.setTrailColors(c.colorTrailA, c.colorTrailB, c.colorTrailC, c.colorTrailD);
    // Seconds since the last bite. Both counters are the base class's own, so
    // nothing here has to remember a timestamp.
    this.offcuts.update(this.impactTime + this.fadeTime, p);
  }

  /** The three particle systems, re-coloured and re-scaled every frame. */
  _syncParticles() {
    const c = settings.sawline;
    const g = settings.global;

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
    this.sparks.uniforms.uTurbulence.value = 0.18 * g.turbulence;

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

    this.smoke.setGradient(
      getColor(c.colorSmokeA),
      getColor(c.colorSmokeB),
      getColor(c.colorSmokeC),
      getColor(c.colorSmokeD)
    );
    this.smoke.uniforms.uGravity.value.set(0, c.smokeRise, 0);
    this.smoke.uniforms.uSizeScale.value = c.smokeSize * g.particleSize;
    this.smoke.uniforms.uLifeScale.value = c.smokeLifetime * 0.5 * g.particleLifetime;
    this.smoke.uniforms.uSpeedScale.value = c.smokeSpeed * g.particleSpeed;
    this.smoke.uniforms.uOpacity.value = c.smokeOpacity * g.opacity;
    this.smoke.uniforms.uTurbulence.value = 0.3 * g.turbulence;
  }

  /**
   * The spark tint: the blackbody colour of steel at `sparkHeat`.
   *
   * Sparks off hot metal are the same temperature as the metal, so hard-coding
   * an orange here would be the one thing in the whole slot that is not
   * derived from the same physics as the blade. `sparkTemper` decides how far
   * that tint is allowed to overrule the authored four-stop gradient — the
   * gradient is the spark *cooling over its own life*, the tint is the
   * temperature it left the wheel at, and both are wanted.
   */
  _sparkTint() {
    const c = settings.sawline;
    // `heatToKelvin` reads `heatCold`/`heatHot` off whatever it is handed, and
    // the block carries both under exactly those names — so the sparks and the
    // blade are on one ramp by construction rather than by convention.
    const kelvin = heatToKelvin(c.sparkHeat, c);
    _tint.setRGB(1, 1, 1).lerp(blackbodyColor(kelvin, _bb), saturate(c.sparkTemper));
    return _tint;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * THE TRICK, emitted.
   *
   * Every jet the solver hands back is one `emit()` call with a direction that
   * came out of `ω × r`. The fan is spread deterministically across the sheaf
   * rather than randomly — a random fan re-rolls its shape every frame and
   * shimmers, where a fixed fan full of random particles reads as one
   * continuous stream, which is what a grinder throws.
   *
   * @param {number} scale 0..1 — thinned as the blade lifts out
   */
  _grindFx(dt, scale) {
    if (!this._cutting) return;
    const c = settings.sawline;
    const g = settings.global;

    const total = Math.round(this.sparkEmitter.tick(dt, c.sparkRate * scale) * g.particleCount);
    if (total <= 0) return;

    const jets = this.grind.jets;
    const per = Math.max(1, Math.round(total / jets));
    const tint = this._sparkTint();
    const time = frame.uTime.value;

    for (let j = 0; j < jets; j++) {
      // `jet()` fills position, direction, speed, spread, speedVariance and
      // inherit, and points its vectors at the solver's own scratch. The rest
      // is ours, and every field is written because `_emit` is shared.
      this.grind.jet(j, _emit);
      _emit.radius = c.grindLift;
      _emit.anchor = null;
      _emit.size = 0.14;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = tint;
      _emit.time = time;
      this.sparks.emit(per, _emit);
    }
  }

  /**
   * What the cut throws that is not on fire: chips and dust.
   *
   * The chips leave along the *reversed* tangent — they are the heavy end of
   * the same stream, too massive to be flung and mostly shouldered aside — and
   * the dust comes straight up out of the kerf mouth.
   *
   * @param {number} scale 0..1
   */
  _spoilFx(dt, scale) {
    if (!this._cutting) return;
    const c = settings.sawline;
    const g = settings.global;
    const time = frame.uTime.value;

    const gritCount = Math.round(this.gritEmitter.tick(dt, c.gritRate * scale) * g.particleCount);
    if (gritCount > 0) {
      _dir.copy(this.grind.direction).multiplyScalar(-0.45).setY(0.85).normalize();
      _emit.position = _contact;
      _emit.radius = c.kerfWidth * 1.6;
      _emit.anchor = null;
      _emit.direction = _dir;
      _emit.speed = c.gritSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.85;
      _emit.inherit = null;
      _emit.size = 0.12;
      _emit.sizeVariance = 0.7;
      _emit.life = c.gritLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = c.gritSpin;
      _emit.tint = null;
      _emit.time = time;
      this.grit.emit(gritCount, _emit);
    }

    const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * scale) * g.particleCount);
    if (smokeCount > 0) {
      _pos.copy(_contact);
      _pos.y = 0.1;
      _emit.position = _pos;
      _emit.radius = c.kerfWidth * 2.5;
      _emit.anchor = null;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.65;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.size = 0.8;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.35;
      _emit.tint = null;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }
  }

  /** Contact samples posted into the kerf as the blade advances. */
  _kerfFx() {
    const c = settings.sawline;
    const step = 1 / Math.max(0.05, c.biteRate);
    while (this.front - this._markDistance >= step) {
      this._markDistance += step;
      const s = saturate(this._markDistance / this.length);
      // Unitless: a fraction along the track, a timestamp, and a load. The
      // gouge re-scales under `kerfDepth` because nothing here carries a metre.
      this.kerf.mark(0, s, this.age, saturate(this._b.cut));
    }
  }

  /** The blade landing and taking its first bite. */
  _dropFx() {
    const c = settings.sawline;
    const g = settings.global;

    this._hubPoint(_pos);
    _pos.y = 0.05;

    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.dropSize * 0.25,
      endRadius: c.dropSize * g.explosionIntensity,
      life: 0.35,
      intensity: c.dropIntensity,
      opacity: 0.8,
      fresnel: 1.8,
      displace: 0.45,
      squash: 0.6,
      colorA: getColor(c.colorDropA),
      colorB: getColor(c.colorDropB),
      colorC: getColor(c.colorDropC)
    });

    _emit.position = _pos;
    _emit.radius = 0.14;
    _emit.anchor = null;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.5).setY(0.6).normalize();
    _emit.speed = Math.max(c.grindFloor, Math.abs(c.bladeSpin) * this._radius() * c.grindGain);
    _emit.speedVariance = 0.8;
    _emit.spread = 0.7;
    _emit.inherit = null;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = this._sparkTint();
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(c.dropSparks * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._resolveBeats(0);
    this._sync();
    this._kerfFx();
    this._grindFx(dt, 1);
    this._spoilFx(dt, 1);
    this.ctx.shake.rumble(settings.sawline.rumble * settings.global.cameraShake, dt);
  }

  /** The last bite: the blade stalls at the end of the line and throws slugs. */
  onImpact() {
    const c = settings.sawline;
    const g = settings.global;

    this._resolveBeats(0);
    this._solveGrind();

    this.ctx.bursts.spawn(BurstMode.EARTH, _contact, {
      radius: c.biteSize * 0.2,
      endRadius: c.biteSize * g.explosionIntensity,
      life: 0.6,
      intensity: c.biteIntensity,
      opacity: 0.9,
      fresnel: 1.6,
      displace: 0.6,
      squash: 0.7,
      colorA: getColor(c.colorBiteA),
      colorB: getColor(c.colorBiteB),
      colorC: getColor(c.colorBiteC)
    });

    // The one-shot sheaf. Fired through the solver like every other spark, so
    // the big burst leaves along the same tangent the stream has been using —
    // a radial burst here would undo the whole slot in one frame.
    if (this._cutting) {
      const jets = this.grind.jets;
      const per = Math.max(1, Math.round((c.biteSparks * g.particleCount) / jets));
      const tint = this._sparkTint();
      const time = frame.uTime.value;
      for (let j = 0; j < jets; j++) {
        this.grind.jet(j, _emit);
        _emit.radius = c.grindLift * 2;
        _emit.anchor = null;
        _emit.size = 0.2;
        _emit.sizeVariance = 0.8;
        _emit.life = c.sparkLifetime * 1.5;
        _emit.lifeVariance = 0.6;
        _emit.spin = 0;
        _emit.tint = tint;
        _emit.time = time;
        this.sparks.emit(per, _emit);
      }
    }

    this.ctx.shake.add(
      c.biteShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      24
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.biteFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.2 * g.explosionIntensity;
  }

  onFade(dt, t) {
    this._resolveBeats(t);
    this._sync();

    const b = this._b;
    // Thinned as the blade withdraws. `_cutting` has already gone false by the
    // time it is a radius under, so this only shapes the last few frames.
    const scale = 1 - Easing.outQuad(b.dive);
    this._grindFx(dt, scale);
    this._spoilFx(dt, scale * 0.7);

    if (t <= 1) {
      this._kerfFx();
      this.ctx.shake.rumble(settings.sawline.rumble * settings.global.cameraShake, dt);
    }

    this._landOffcuts();
  }

  /**
   * Slugs that touched down this frame.
   *
   * `arrivals` is re-derived from the flight rather than remembered, so
   * dragging `offcutFlight` while paused can put a landed slug back in the air
   * and land it again — which is exactly the behaviour a live editor wants,
   * and the reason nothing here keeps a landed list of its own.
   */
  _landOffcuts() {
    const count = this.offcuts.arrivalCount;
    if (count <= 0) return;
    const c = settings.sawline;
    const g = settings.global;
    const tint = this._sparkTint();
    const time = frame.uTime.value;

    for (let i = 0; i < count; i++) {
      this.offcuts.landPoint(this.offcuts.arrivals[i], _pos);

      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: c.scorchRadius * randRange(0.7, 1.3),
        life: c.scorchLife,
        intensity: c.scorchIntensity,
        colorA: getColor(c.colorScorch),
        colorB: getColor(c.colorEmber),
        height: 0.015
      });

      _emit.position = _pos;
      _emit.radius = c.offcutRadius;
      _emit.anchor = null;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.gritSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 1;
      _emit.inherit = null;
      _emit.size = 0.12;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime * 0.8;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = tint;
      _emit.time = time;
      this.sparks.emit(Math.round(c.offcutLandSparks * g.particleCount), _emit);
    }
  }

  onDestroy() {
    this.offcuts.reset();
    this.kerf.clearMarks();
    this.kerf.setVisible(false);
    this.blade.visible = false;
    this._cutting = false;
    this._markDistance = 0;
  }

  dispose() {
    // The blade's geometry belongs to the cache; disposing it here would free
    // it twice.
    this.cache.dispose();
    this.metal.dispose();
    this.slag.dispose();
    this.offcuts.dispose();
    this.kerf.dispose();
    super.dispose();
  }
}
