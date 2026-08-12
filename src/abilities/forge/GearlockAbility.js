import { InstancedMesh, Object3D, InstancedBufferAttribute, DynamicDrawUsage, Vector3 } from 'three';
import { Ability } from '../Ability.js';
import {
  GearTrain,
  gearTrainParams,
  ShapeCache,
  HardShape,
  HardAxis,
  gearShape,
  gearPitchFraction,
  createHardSurfaceMaterial,
  syncHardSurfaceMaterial,
  hardSurfaceParams,
  GrindContact,
  grindParams
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

/**
 * Hard ceiling on gears in one train — `GearTrain`'s own default capacity, and
 * the size of every per-instance array in this file.
 */
const MAX_GEARS = 12;
/**
 * Distinct tooth counts the train may draw from.
 *
 * This is three because **a tooth count is a shape, not a transform**: two
 * gears with different `teeth` cannot share an `InstancedMesh`, so every count
 * on the menu costs a geometry, a rebuild whenever a profile slider moves, and
 * a draw call. Three ratios is enough for a train to read as a mechanism —
 * small driving large driving small — and three draw calls is a quarter of the
 * budget. Four was tried and the only thing it changed was the build time.
 */
const SLOTS = 3;

const _up = new Vector3(0, 1, 0);
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _contact = new Vector3();
const _hubA = new Vector3();
const _hubB = new Vector3();
const _tangent = new Vector3();
const _velA = new Vector3();
const _velB = new Vector3();
const _slide = new Vector3();
const _dummy = new Object3D();

/** Tooth counts resolved this frame; handed to `GearTrain` by reference. */
const _teeth = [11, 17, 26];
/** Per-contact sliding speed, metres/second. Filled in pass one of `_grindFx`. */
const _slideSpeed = new Float64Array(MAX_GEARS);
/** How many gears landed in each `InstancedMesh` this frame. */
const _slotCount = new Int32Array(SLOTS);
/** The shape object handed to `ShapeCache` — refilled per slot, never rebuilt. */
const _shape = gearShape();

/**
 * GEARLOCK — a train of meshing spur gears winds up out of the floor, runs, and
 * seizes.
 *
 * ## THE TRICK — the teeth actually mesh, and they stay meshed while you drag
 *
 * Everything else in this file is dressing on one piece of arithmetic, and the
 * arithmetic has two halves. Getting the first and skipping the second is the
 * failure that ships:
 *
 *  1. **Rate.** `ω₂ = −(z₁/z₂)·ω₁`. Obvious, and every gear demo does it.
 *  2. **Phase.** Two gears turning at the perfect ratio still grind straight
 *     through one another unless a *tooth* of one is aimed at a *gap* of the
 *     other along the line of centres — and that is a constraint on the
 *     absolute angles, not on their derivatives. `vfx/HardSurface.js` solves
 *     `θ₂ = β + π + (z₁/z₂)(β − θ₁) − π/z₂` for it, and differentiating that
 *     recovers (1) for free, which is the check that it is the right
 *     constraint.
 *
 * The first version of this ability skipped (2) and looked *correct*. The train
 * counter-rotated, the ratios were right, the sizes were right, and the teeth
 * passed through each other like smoke. It took a minute of staring to see, and
 * once you see it you cannot unsee it — which is exactly why the roster names
 * it as the thing to avoid.
 *
 * Because the phase is **solved rather than integrated**, the whole train is a
 * pure function of `settings.gearlock` and one warped clock. Stop the world with
 * **P** mid-cast and drag `teethB`: every gear that drew that count re-teeths,
 * its pitch radius changes, its neighbours slide along their bearings to the
 * new standard centre distance `m(z₁+z₂)/2`, and every angle downstream
 * re-phases — in the frame you moved the slider, with `dt = 0`, still meshed.
 * Nothing about the train survives a frame.
 *
 * ## Spacing is on the pitch circles, not the tips
 *
 * The tempting wrong answer is to butt the tip circles together, which leaves a
 * gap of one whole tooth height and reads as two gears that happen to be near
 * each other. Involute gears mesh at the sum of their **pitch** radii, and the
 * pitch radius is `m·z/2` — which is why the module is the one number that
 * matters and why it is resolved from `moduleFrac × zoneRadius` every frame
 * rather than captured. Drag `moduleFrac` and the train re-spaces without a
 * single vertex being rebuilt; drag `teeth` and it re-spaces *and* rebuilds.
 *
 * ## The clock is a closed-form warp, not an integrator
 *
 * `GearTrain#solve()` takes a time and produces an angle, so the run-up, the
 * seize and the shudder are all one function `τ(age)`:
 *
 * ```
 *   run-up   τ = t − up·(1 − e^(−t/up))            dτ/dt → 1
 *   seize    τ = τ(L) + r(L)·s·(1 − e^(−(t−L)/s))  dτ/dt → 0
 *   shudder  += shudder·e^(−(t−L)/d)·sin(ω(t−L))
 * ```
 *
 * Integrating a decaying rate on the CPU would have been three lines shorter
 * and would have made every one of those five sliders dead the moment the clock
 * stopped, because the angle would then be a number the ability was *holding*
 * rather than a number it can *derive*. The seize is authored as a warp of time
 * for the same reason the phase is solved rather than accumulated: I1 is not a
 * style rule, it is what makes the editor work.
 *
 * The shudder is added to **τ**, not to each gear's angle. That matters: a
 * per-gear wobble would break the mesh constraint on the frame it was applied,
 * because the constraint is on the absolute angles. Wobbling the root gear's
 * clock instead propagates through the ratio chain and the whole train judders
 * as one rigid mechanism, which is what a seizing gearbox does.
 *
 * ## Where the sparks come from, and where they do not
 *
 * At the **pitch point** the two flanks are in pure rolling: the sliding
 * velocity there is exactly zero, and a spark stream centred on it is a lie
 * anybody who has watched a gearbox will feel without being able to name. The
 * sliding speed grows linearly with distance from the pitch point along the
 * common tangent, so the jets are struck at `slideOffset` metres either side of
 * it and their speed comes from `v₁ − v₂` evaluated *there* — the real relative
 * velocity of two points that are momentarily in contact. Set `slideOffset` to
 * 0 and the sparks stop, which is the correct behaviour and a decent way to
 * convince yourself the maths is doing something.
 *
 * ## Budget
 *
 * Three `InstancedMesh`es (one per tooth count) and one `GroundField(LATTICE)`
 * — four draw calls, one material, three particle systems, one light.
 */
export class GearlockAbility extends Ability {
  constructor(context) {
    super('gearlock', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- one material for the whole train --- */
    this.metal = createHardSurfaceMaterial({ environment: this.ctx.environment });
    this._look = hardSurfaceParams();

    /**
     * The geometry cache is **this ability's**, never shared. A gear is the
     * most expensive thing in `HardSurface` to build — an involute flank per
     * tooth, a fillet per root, an Earcut over a blank with a bore and five
     * lightening holes in it — so it is built when a number moves and not
     * otherwise. `capacity: SLOTS` makes an accidental fourth slot throw here
     * rather than quietly thrash.
     */
    this.cache = new ShapeCache({ capacity: SLOTS });
    /** Pitch radius ÷ actual outer radius, per slot. Recomputed only on rebuild. */
    this._pitchFraction = new Float64Array(SLOTS);
    /** The tooth count each slot is currently built for. */
    this._slotTeeth = new Int32Array(SLOTS);

    this.train = new GearTrain({ capacity: MAX_GEARS });
    this._trainParams = gearTrainParams();
    this.grind = new GrindContact();
    this._grindParams = grindParams();

    /**
     * One `InstancedMesh` per tooth count.
     *
     * They are built here, at construction, and never added to or removed from
     * the group again — the pooling contract wants `spawn()` to allocate
     * nothing, and the harness fails an ability that grows its group mid-cast.
     * An empty slot sets `count = 0` and hides itself instead.
     */
    this.meshes = [];
    this.heat = [];
    for (let slot = 0; slot < SLOTS; slot++) {
      _shape.teeth = 10 + slot * 6;
      const geometry = this.cache.get(slot, HardShape.GEAR, _shape);
      const mesh = new InstancedMesh(geometry, this.metal, MAX_GEARS);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.layers.set(LAYER.WORLD);
      mesh.renderOrder = 2;
      mesh.count = 0;
      mesh.visible = false;
      mesh.name = `Gearlock:gears${slot}`;

      /**
       * `aHeat` is an **offset** on the material's `heat`, one float per
       * instance, so a small gear whipping round at eight metres a second at
       * the rim comes up hotter than the big one it is driving — off one
       * material and one draw call. It is an offset rather than an absolute
       * because an unset attribute reads as 0 in WebGL, and an absolute would
       * make every mesh that forgot one ice cold.
       */
      const heat = new InstancedBufferAttribute(new Float32Array(MAX_GEARS), 1);
      heat.setUsage(DynamicDrawUsage);
      geometry.setAttribute('aHeat', heat);

      this.group.add(mesh);
      this.meshes.push(mesh);
      this.heat.push(heat);
      this._pitchFraction[slot] = gearPitchFraction(_shape);
      this._slotTeeth[slot] = _shape.teeth;
    }

    /**
     * The bed plate. `LATTICE` propagates along its own edges cell by cell,
     * which is the one ground mode in the library that reads as *engineered*
     * rather than as weathered — a machined grid growing outward under the
     * train while the front is still running out to it.
     */
    this.bed = new GroundField(this.group, {
      mode: GroundMode.LATTICE,
      layer: LAYER.VFX,
      name: 'Gearlock:bed'
    });
    this._bedParams = groundFieldParams();
    this.bed.setVisible(false);

    /* --- per-cast state. Dice and timestamps only. --- */
    this._seed = 0;
    this._landed = false;
    this._landAge = 0;
    this._locked = false;
    this._lockAge = 0;
    this._live = 0;
    /** dτ/dt this frame — the run-up ramp, then the seize decay. */
    this._rateScale = 0;
    /** Handedness of the cast basis; recovered per frame, never assumed. */
    this._handed = -1;
    /** Recentring offset so the train sits *in* the aim circle, not off its edge. */
    this._offX = 0;
    this._offZ = 0;
    this._fade = 1;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Grinding sparks: velocity-stretched streaks under gravity.
    this.sparks = particles.get('gearlock.sparks', {
      capacity: 2600,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.3;
    this.sparks.uniforms.uEndSize.value = 0.22;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.5;

    // Swarf: lit chips of steel machined off the flanks.
    this.swarf = particles.get('gearlock.swarf', {
      capacity: 900,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.swarf.uniforms.uDrag.value = 0.3;
    this.swarf.uniforms.uEndSize.value = 0.75;
    this.swarf.uniforms.uFadeOut.value = 0.7;

    // Floor dust thrown up as each gear breaks the surface.
    this.dust = particles.get('gearlock.dust', {
      capacity: 1100,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.dust.uniforms.uDrag.value = 1.9;
    this.dust.uniforms.uEndSize.value = 2.6;
    this.dust.uniforms.uSizeIn.value = 0.12;
    this.dust.uniforms.uFadeIn.value = 0.18;
    this.dust.uniforms.uFadeOut.value = 0.32;

    this.sparkEmitter = new RateEmitter();
    this.swarfEmitter = new RateEmitter();
    this.dustEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._live;
  }

  /** The train runs for `lifetime`, then the fade phase is the seize. */
  get impactDuration() {
    return Math.max(0.05, settings.gearlock.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.gearlock.fadeTime);
  }

  /** Steel does not gutter. A slow swell off the mesh points, and nothing else. */
  lightShimmer() {
    return 0.92 + 0.08 * Math.sin(this.age * 5.1);
  }

  /* ------------------------------------------------------------------ */
  /* The clock                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Warped time in seconds, and the instantaneous rate multiplier that goes
   * with it.
   *
   * Returns τ and leaves `dτ/dt` in `this._rateScale`, because both are wanted
   * by every caller and computing them separately would evaluate the same three
   * exponentials twice. Both are pure functions of `age`, two timestamps and
   * five sliders — nothing is carried between frames, which is what makes the
   * seize re-time itself while the clock is stopped.
   */
  _resolveClock() {
    const c = settings.gearlock;
    if (!this._landed) {
      this._rateScale = 0;
      return 0;
    }
    const up = Math.max(0.01, c.spinUp);
    const t = Math.max(0, this.age - this._landAge);

    if (!this._locked) {
      const ramp = Math.exp(-t / up);
      this._rateScale = 1 - ramp;
      return t - up * (1 - ramp);
    }

    // Seconds of run before the lock fired, and seconds since.
    const runFor = Math.max(0, this._lockAge - this._landAge);
    const since = Math.max(0, this.age - this._lockAge);
    const seize = Math.max(0.01, c.seizeTime);
    const rateAtLock = 1 - Math.exp(-runFor / up);
    const decay = Math.exp(-since / seize);
    const ring = Math.exp(-since / Math.max(0.01, c.shudderDecay));
    const omega = Math.PI * 2 * Math.max(0.01, c.shudderRate);

    this._rateScale = rateAtLock * decay;
    return (
      runFor -
      up * (1 - Math.exp(-runFor / up)) +
      rateAtLock * seize * (1 - decay) +
      c.shudder * ring * Math.sin(omega * since)
    );
  }

  /** 0..1 — how far gear `i` has broken the surface. */
  _emergenceOf(index) {
    if (!this._landed) return 0;
    const c = settings.gearlock;
    const t = this.age - this._landAge - index * c.riseStagger;
    return Easing.outCubic(saturate(t / Math.max(0.01, c.riseTime)));
  }

  /** 0..1 — how far the seized train has sunk back into the floor. */
  _sink() {
    if (!this._locked) return 0;
    const c = settings.gearlock;
    const after = this.age - this._lockAge - c.seizeTime;
    const span = Math.max(0.05, c.fadeTime - c.seizeTime);
    return Easing.inCubic(saturate(after / span));
  }

  /* ------------------------------------------------------------------ */
  /* The train                                                           */
  /* ------------------------------------------------------------------ */

  /** The centre of the aimed circle. A zone cast works outward from `pointAt(1)`. */
  _centrePoint(out) {
    return this.pointAt(1, out);
  }

  /**
   * Re-plant, re-solve, re-centre. Every frame, `dt = 0` included.
   *
   * `plant()` is re-run rather than called once at spawn, and that is not the
   * waste it looks like: it is twelve hashes of a seed this cast captured once,
   * so the *same* train comes back every frame — but `gearCount` is read on the
   * way in, which is what lets the slider add and remove gears from a standing,
   * paused mechanism. `thunder` re-reads `strands` every frame for the same
   * reason.
   */
  _solveTrain() {
    const c = settings.gearlock;
    const p = this._trainParams;

    _teeth[0] = Math.max(4, Math.round(c.teethA));
    _teeth[1] = Math.max(4, Math.round(c.teethB));
    _teeth[2] = Math.max(4, Math.round(c.teethC));

    this._centrePoint(_centre);
    p.origin = _centre;
    p.direction = this.direction;
    p.side = this.side;
    // The one place a metre is made: millimetres of pitch diameter per tooth,
    // scaled off the circle the player was shown while aiming.
    p.module = Math.max(1e-3, c.moduleFrac * Math.max(0.2, c.zoneRadius));
    p.addendum = c.addendum;
    p.teeth = _teeth;
    p.spin = c.spin;
    p.time = this._resolveClock();
    p.phase = c.phase;
    p.bearingSpread = c.bearingSpread;
    p.bearingBias = c.bearingBias;
    p.lift = c.lift;
    p.reverse = false;

    this.train.plant(c.gearCount, this._seed);
    this.train.solve(p);

    // The solver lays gear 0 on the anchor and marches away from it, so an
    // unaltered train hangs off the edge of the aim circle instead of filling
    // it. Recentre on the train's own centroid — after the solve, because the
    // extent depends on every ratio in it.
    const count = this.train.count;
    let sumX = 0;
    let sumZ = 0;
    for (let i = 0; i < count; i++) {
      this.train.positionOf(i, p, _pos);
      sumX += _pos.x;
      sumZ += _pos.z;
    }
    if (count > 0) {
      this._offX = _centre.x - sumX / count;
      this._offZ = _centre.z - sumZ / count;
    } else {
      this._offX = 0;
      this._offZ = 0;
    }

    // Handedness of the cast basis, recovered the way `GearTrain` recovers it,
    // so the world angular velocities the spark solver builds turn the same way
    // the gears the player is looking at do.
    this._handed = Math.sign(this.direction.z * this.side.x - this.direction.x * this.side.z) || -1;
  }

  /** World centre of gear `i`, recentred. */
  _hubOf(index, out) {
    this.train.positionOf(index, this._trainParams, out);
    out.x += this._offX;
    out.z += this._offZ;
    return out;
  }

  /**
   * Rebuild the three profiles if a shape slider moved, then write every
   * instance transform and every per-instance heat.
   */
  _syncGears() {
    const c = settings.gearlock;

    /* --- the profiles --- */
    _shape.pressureAngle = c.pressureAngle;
    _shape.addendum = c.addendum;
    _shape.dedendum = c.dedendum;
    _shape.backlash = c.backlash;
    _shape.rootFillet = c.rootFillet;
    _shape.flankSteps = Math.round(c.flankSteps);
    _shape.tipSteps = Math.round(c.tipSteps);
    _shape.rootSteps = Math.round(c.rootSteps);
    _shape.thickness = c.thickness;
    _shape.chamfer = c.chamfer;
    _shape.bore = c.bore;
    _shape.boreSegments = Math.round(c.boreSegments);
    _shape.boreChamfer = c.boreChamfer;
    _shape.lightenHoles = Math.round(c.lightenHoles);
    _shape.lightenRadius = c.lightenRadius;
    _shape.lightenRing = c.lightenRing;
    _shape.lightenSegments = Math.round(c.lightenSegments);
    _shape.creaseAngle = c.creaseAngle;
    _shape.axis = HardAxis.Y;

    for (let slot = 0; slot < SLOTS; slot++) {
      _shape.teeth = _teeth[slot];
      const geometry = this.cache.get(slot, HardShape.GEAR, _shape);
      if (this.cache.changed || this.meshes[slot].geometry !== geometry) {
        this.meshes[slot].geometry = geometry;
        // The instance attribute has to be reattached: the cache handed back a
        // brand-new BufferGeometry and disposed the one that was carrying it.
        geometry.setAttribute('aHeat', this.heat[slot]);
        // Measured against the profile's *actual* outer radius, which is short
        // of `pitch + addendum` whenever a tooth has gone pointed. Placing by
        // the nominal radius there draws the gear slightly too large and puts
        // its pitch circle outside where its neighbour thinks it is, which is
        // interpenetration arriving by the back door.
        this._pitchFraction[slot] = gearPitchFraction(_shape);
        this._slotTeeth[slot] = _shape.teeth;
      }
    }

    /* --- the instances --- */
    const count = this.train.count;
    const sink = this._sink();
    const since = this._locked ? this.age - this._lockAge : 0;
    const seizeHeat = this._locked ? c.seizeHeat * Math.exp(-since / Math.max(0.01, c.seizeHeatDecay)) : 0;

    for (let slot = 0; slot < SLOTS; slot++) _slotCount[slot] = 0;

    for (let i = 0; i < count; i++) {
      const teeth = this.train.teethOf(i);
      let slot = 0;
      for (let s = 0; s < SLOTS; s++) {
        if (this._slotTeeth[s] === teeth) {
          slot = s;
          break;
        }
      }
      const at = _slotCount[slot];
      if (at >= MAX_GEARS) continue;

      const diameter = this.train.scaleOf(i, this._pitchFraction[slot]);
      const emerge = this._emergenceOf(i);
      const buried = diameter * c.thickness + c.riseDepth;

      this._hubOf(i, _pos);
      _pos.y = c.lift + lerp(-buried, 0, emerge) - sink * (buried + c.lift);

      _dummy.position.copy(_pos);
      _dummy.rotation.set(0, this.train.yawOf(i), 0);
      _dummy.scale.setScalar(diameter);
      _dummy.updateMatrix();
      this.meshes[slot].setMatrixAt(at, _dummy.matrix);

      // Friction heat, from this gear's own rim speed. `rateOf` is the nominal
      // rate; `_rateScale` is the run-up and the seize on top of it.
      const rim = Math.abs(this.train.rateOf(i) * this._rateScale) * diameter * 0.5;
      const heat = (c.heatGain * saturate(rim / Math.max(0.05, c.heatSpeed)) + seizeHeat) * emerge;
      this.heat[slot].array[at] = saturate(heat);

      _slotCount[slot]++;
    }

    this._live = 0;
    for (let slot = 0; slot < SLOTS; slot++) {
      const mesh = this.meshes[slot];
      mesh.count = _slotCount[slot];
      mesh.visible = _slotCount[slot] > 0;
      mesh.instanceMatrix.needsUpdate = true;
      this.heat[slot].needsUpdate = true;
      this._live += _slotCount[slot];
    }
  }

  /** Push the live steel settings into the one shared material. */
  _syncMetal() {
    const c = settings.gearlock;
    const g = settings.global;
    const p = this._look;

    p.colorMetal = c.colorMetal;
    p.colorDeep = c.colorDeep;
    p.colorScale = c.colorScale;
    p.colorPolish = c.colorPolish;
    p.colorSpec = c.colorSpec;
    p.roughness = c.roughness;
    p.metalness = c.metalness;
    p.envIntensity = c.envIntensity;
    p.brush = Math.round(clamp(c.brush, 0, 2));
    p.brushAxisX = 0;
    p.brushAxisY = 1;
    p.brushAxisZ = 0;
    p.anisotropy = c.anisotropy;
    p.specular = c.specular;
    p.grain = c.grain;
    p.grainScale = c.grainScale;
    p.grainStretch = c.grainStretch;
    p.scale = c.scale;
    p.scaleScale = c.scaleScale;
    p.scaleSharp = c.scaleSharp;
    p.pit = c.pit;
    p.pitScale = c.pitScale;
    p.wear = c.wear;
    p.wearGrain = c.wearGrain;
    // The base heat is zero and every gear carries its own in `aHeat`.
    p.heat = 0;
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

    syncHardSurfaceMaterial(this.metal, p);
  }

  /** The machined bed the train comes up through. */
  _syncBed(grow, fade) {
    const c = settings.gearlock;
    const g = settings.global;
    const p = this._bedParams;

    this._centrePoint(_centre);
    p.centre = _centre;
    p.yaw = Math.atan2(this.direction.x, this.direction.z);
    p.height = 0.015;
    p.radius = Math.max(0.2, c.zoneRadius);
    p.grow = grow;
    p.fade = fade;
    p.seed = this._seed;

    p.edge = c.fieldEdge;
    p.ragged = c.fieldRagged;
    p.raggedScale = c.fieldRaggedScale;
    p.warp = c.fieldWarp;
    p.relief = c.fieldRelief;
    p.cell = c.fieldCell;
    p.cellJitter = c.fieldCellJitter;
    p.seam = c.fieldSeam;
    p.thickness = c.fieldThickness;
    p.lift = c.fieldLift;
    p.depth = c.fieldDepth;
    p.sharp = c.fieldSharp;
    p.detail = c.fieldDetail;
    p.speed = c.fieldSpeed;
    p.parallax = c.fieldParallax;
    p.opacity = c.fieldOpacity;
    p.emissive = c.fieldEmissive;
    p.colorBase = c.colorFieldBase;
    p.colorEdge = c.colorFieldEdge;
    p.colorGlow = c.colorFieldGlow;
    p.colorDeep = c.colorFieldDeep;

    p.noiseStrength = g.noiseStrength;
    p.noiseFrequency = g.noiseFrequency;
    p.noiseSpeed = g.noiseSpeed;
    p.opacityScale = g.opacity;

    this.bed.setVisible(fade > 0.001);
    this.bed.update(p);
  }

  /* ------------------------------------------------------------------ */
  /* The grind                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Solve one tooth contact into `_contact` (where) and `_slide` (the relative
   * velocity of the two flanks there), and return the sliding speed.
   *
   * The point is deliberately **not** the pitch point. `contactOf()` hands back
   * the pitch point — the place the pitch circles touch, which divides the
   * centre distance in the ratio of the two pitch radii — and at that exact
   * point the flanks roll on one another with no sliding at all. Real gear
   * scuffing happens away from it, on the approach and recess flanks, and the
   * sliding speed there is `(|ω₁| + |ω₂|)·δ` for an offset δ along the common
   * tangent. So the jets are struck at `slideOffset` and the speed is measured,
   * not assumed: `v₁ − v₂` from two genuine `ω × r` evaluations at the same
   * world point.
   */
  _contactSolve(index) {
    const c = settings.gearlock;
    const p = this._trainParams;

    this._hubOf(index - 1, _hubA);
    this._hubOf(index, _hubB);

    this.train.contactOf(index, p, _contact);
    _contact.x += this._offX;
    _contact.z += this._offZ;

    // Common tangent: perpendicular to the line of centres, in the floor plane.
    _dir.copy(_hubB).sub(_hubA).setY(0);
    if (_dir.lengthSq() < 1e-10) _dir.copy(this.direction);
    _dir.normalize();
    _tangent.set(_dir.z, 0, -_dir.x);
    _contact.addScaledVector(_tangent, c.slideOffset);

    const rateA = this._handed * this.train.rateOf(index - 1) * this._rateScale;
    const rateB = this._handed * this.train.rateOf(index) * this._rateScale;
    GrindContact.rimVelocity(_velA, _up, rateA, _contact, _hubA);
    GrindContact.rimVelocity(_velB, _up, rateB, _contact, _hubB);
    _slide.copy(_velA).sub(_velB);
    return _slide.length();
  }

  /**
   * Sparks and swarf off every mesh point.
   * @param {number} scale 0..1 — thinned as the train dies
   */
  _grindFx(dt, scale) {
    const c = settings.gearlock;
    const g = settings.global;
    const count = this.train.count;
    if (count < 2) return;

    /* --- pass one: how hard is each contact working --- */
    const reference = Math.max(0.05, c.slideRef);
    let duty = 0;
    for (let i = 1; i < count; i++) {
      _slideSpeed[i] = this._contactSolve(i) * Math.min(this._emergenceOf(i - 1), this._emergenceOf(i));
      duty += saturate(_slideSpeed[i] / reference);
    }
    const contacts = count - 1;
    duty /= contacts;
    if (duty <= 1e-4) return;

    const time = frame.uTime.value;
    const jets = Math.max(1, Math.round(c.grindJets));
    const sparkTotal = Math.round(this.sparkEmitter.tick(dt, c.sparkRate * duty * scale) * g.particleCount);
    const swarfTotal = Math.round(this.swarfEmitter.tick(dt, c.swarfRate * duty * scale) * g.particleCount);

    /* --- pass two: strike them --- */
    const gp = this._grindParams;
    gp.lift = c.grindLift;
    gp.bounce = c.grindBounce;
    gp.rise = c.grindRise;
    gp.speedGain = c.grindSpeedGain;
    gp.speedFloor = c.grindSpeedFloor;
    gp.speedCeiling = c.grindSpeedCeiling;
    gp.fan = c.grindFan;
    gp.swing = c.grindSwing;
    gp.graze = c.grindGraze;
    gp.jets = jets;
    gp.spread = c.grindSpread;
    gp.speedVariance = c.grindVariance;
    gp.drift = c.grindDrift;

    for (let i = 1; i < count; i++) {
      const share = saturate(_slideSpeed[i] / reference);
      if (share <= 1e-4) continue;
      const perContact = Math.round((sparkTotal * share) / Math.max(1e-4, duty * contacts));
      if (perContact <= 0 && swarfTotal <= 0) continue;

      this._contactSolve(i);
      this.grind.solve(_contact, _up, _slide, gp);

      if (perContact > 0) {
        const perJet = Math.max(1, Math.round(perContact / jets));
        for (let j = 0; j < jets; j++) {
          this.grind.jet(j, _emit);
          _emit.radius = 0.05;
          _emit.anchor = null;
          _emit.size = 0.16;
          _emit.sizeVariance = 0.7;
          _emit.life = c.sparkLifetime;
          _emit.lifeVariance = 0.5;
          _emit.spin = 0;
          _emit.tint = null;
          _emit.time = time;
          this.sparks.emit(perJet, _emit);
        }
      }

      const swarfHere = Math.round((swarfTotal * share) / Math.max(1e-4, duty * contacts));
      if (swarfHere > 0) {
        _emit.position = _contact;
        _emit.radius = 0.09;
        _emit.direction = _dir.copy(_slide).normalize().multiplyScalar(0.6).setY(0.5).normalize();
        _emit.speed = c.swarfSpeed;
        _emit.speedVariance = 0.7;
        _emit.spread = 0.7;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.1;
        _emit.sizeVariance = 0.7;
        _emit.life = c.swarfLifetime;
        _emit.lifeVariance = 0.5;
        _emit.spin = 9;
        _emit.tint = null;
        _emit.time = time;
        this.swarf.emit(swarfHere, _emit);
      }
    }
  }

  /** Dust off the floor while the gears are still breaking through it. */
  _dustFx(dt) {
    const c = settings.gearlock;
    const g = settings.global;
    const count = this.train.count;

    let breaking = 0;
    for (let i = 0; i < count; i++) {
      const e = this._emergenceOf(i);
      if (e > 0.001 && e < 0.999) breaking++;
    }
    if (breaking === 0) return;

    const total = Math.round(this.dustEmitter.tick(dt, c.dustRate * breaking) * g.particleCount);
    if (total <= 0) return;

    const per = Math.max(1, Math.round(total / breaking));
    const time = frame.uTime.value;
    for (let i = 0; i < count; i++) {
      const e = this._emergenceOf(i);
      if (e <= 0.001 || e >= 0.999) continue;
      this._hubOf(i, _pos);
      _pos.y = 0.08;
      _emit.position = _pos;
      _emit.radius = this.train.tipRadiusOf(i) * 1.1;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.9;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.4;
      _emit.tint = null;
      _emit.time = time;
      this.dust.emit(per, _emit);
    }
  }

  /** The four particle systems' live gradients and scales. */
  _syncParticles() {
    const c = settings.gearlock;
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
    this.sparks.uniforms.uGlow.value = c.heatGlow * 0.5 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
    this.sparks.uniforms.uTurbulence.value = 0.2 * g.turbulence;

    this.swarf.setGradient(
      getColor(c.colorSwarfA),
      getColor(c.colorSwarfB),
      getColor(c.colorSwarfC),
      getColor(c.colorSwarfD)
    );
    this.swarf.uniforms.uGravity.value.set(0, c.swarfGravity, 0);
    this.swarf.uniforms.uSizeScale.value = c.swarfSize * g.particleSize * 7;
    this.swarf.uniforms.uLifeScale.value = c.swarfLifetime * 0.5 * g.particleLifetime;
    this.swarf.uniforms.uSpeedScale.value = g.particleSpeed;
    this.swarf.uniforms.uOpacity.value = g.opacity;

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
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.sparkEmitter.reset();
    this.swarfEmitter.reset();
    this.dustEmitter.reset();

    // The only dice this cast rolls, and the only two events it will record.
    this._seed = Math.random() * 100;
    this._landed = false;
    this._landAge = 0;
    this._locked = false;
    this._lockAge = 0;
    this._fade = 1;
    this._live = 0;

    this._solveTrain();
    this._syncMetal();
    this._syncParticles();
    this._syncGears();
    this._syncBed(0, 1);
  }

  onTravel(dt) {
    this._fade = 1;
    this._solveTrain();
    this._syncMetal();
    this._syncParticles();
    this._syncGears();
    // The lattice inks itself under the circle while the front is still on its
    // way there, so the cast has something to say before the gears arrive.
    this._syncBed(this.u, 1);

    // The light sits over the circle rather than on the front: this is a zone
    // cast and the circle is where the player is looking.
    this._centrePoint(this.position);
    this.position.y = settings.gearlock.lift + 0.4;
  }

  onImpact() {
    const c = settings.gearlock;
    const g = settings.global;

    this._landed = true;
    this._landAge = this.age;

    this._centrePoint(_centre);
    this.ctx.bursts.spawn(BurstMode.EARTH, _centre, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.55,
      intensity: c.burstIntensity * 0.7,
      opacity: 0.8,
      fresnel: 1.2,
      displace: 0.5,
      squash: 0.5,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.ctx.shake.add(
      c.lockShake * 0.4 * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      20
    );
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.gearlock;

    // `t` runs 0..1 while the train is running and 1..2 while it seizes and
    // sinks. The lock is the one-shot at the boundary — a timestamp and a flag,
    // which is all a cast is ever allowed to keep.
    if (t >= 1 && !this._locked) {
      this._locked = true;
      this._lockAge = this.age;
      this._lockFx();
    }

    this._fade = t <= 1 ? 1 : 1 - Easing.inQuad(saturate(t - 1));

    this._solveTrain();
    this._syncMetal();
    this._syncParticles();
    this._syncGears();
    this._syncBed(1, this._fade);

    this._grindFx(dt, t <= 1 ? 1 : this._fade);
    this._dustFx(dt);

    this._centrePoint(this.position);
    this.position.y = c.lift + 0.4;

    if (t <= 1) this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  /** The seize: every contact lets go of its heat at once. */
  _lockFx() {
    const c = settings.gearlock;
    const g = settings.global;
    const count = this.train.count;
    const time = frame.uTime.value;

    const jets = Math.max(1, Math.round(c.grindJets));
    const per = Math.max(
      1,
      Math.round((c.lockSparks * g.particleCount) / Math.max(1, (count - 1) * jets))
    );

    const gp = this._grindParams;
    gp.lift = c.grindLift;
    gp.bounce = c.grindBounce;
    gp.rise = c.grindRise;
    gp.speedGain = c.grindSpeedGain * 1.8;
    gp.speedFloor = c.grindSpeedFloor;
    gp.speedCeiling = c.grindSpeedCeiling;
    gp.fan = c.grindFan * 1.4;
    gp.swing = c.grindSwing * 1.6;
    gp.graze = c.grindGraze;
    gp.jets = jets;
    gp.spread = c.grindSpread * 1.5;
    gp.speedVariance = c.grindVariance;
    gp.drift = c.grindDrift;

    for (let i = 1; i < count; i++) {
      this._contactSolve(i);
      this.grind.solve(_contact, _up, _slide, gp);
      for (let j = 0; j < jets; j++) {
        this.grind.jet(j, _emit);
        _emit.radius = 0.1;
        _emit.anchor = null;
        _emit.size = 0.2;
        _emit.sizeVariance = 0.8;
        _emit.life = c.sparkLifetime * 1.6;
        _emit.lifeVariance = 0.6;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.sparks.emit(per, _emit);
      }
    }

    this._centrePoint(_centre);
    this.ctx.bursts.spawn(BurstMode.AIR, _centre, {
      radius: c.burstSize * 0.3,
      endRadius: c.burstSize * 1.6 * g.explosionIntensity,
      life: 0.5,
      intensity: c.burstIntensity,
      opacity: 0.7,
      fresnel: 1.7,
      displace: 0.35,
      squash: 0.45,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.ctx.shake.add(
      c.lockShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      28
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.lockFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.4 * g.explosionIntensity;
  }

  onDestroy() {
    this.train.clear();
    this._live = 0;
    this._landed = false;
    this._locked = false;
    for (let slot = 0; slot < SLOTS; slot++) {
      this.meshes[slot].count = 0;
      this.meshes[slot].visible = false;
    }
    this.bed.setVisible(false);
  }

  dispose() {
    this.bed.dispose();
    // The cache owns every gear geometry; the meshes only borrow them, so this
    // is the one place they are freed and no mesh disposes its own.
    this.cache.dispose();
    this.metal.dispose();
    super.dispose();
  }
}
