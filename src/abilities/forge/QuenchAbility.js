import { InstancedMesh, Object3D, InstancedBufferAttribute, DynamicDrawUsage, Vector3, Color } from 'three';
import { Ability } from '../Ability.js';
import {
  ShapeCache,
  HardShape,
  HardAxis,
  plateShape,
  boltShape,
  createHardSurfaceMaterial,
  syncHardSurfaceMaterial,
  hardSurfaceParams,
  blackbodyColor
} from '../../vfx/HardSurface.js';
import { VolumeHull, HullShape, Medium } from '../../vfx/VolumeHull.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, hash11, Easing } from '../../utils/math.js';

/** Hard ceilings. The editor's counts clamp here; every array below is this long. */
const MAX_PLATES = 8;
const MAX_BOLTS = 16;
const MAX_PARTS = MAX_PLATES + MAX_BOLTS;

const TAU = Math.PI * 2;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _dummy = new Object3D();
const _hot = new Color();
const _tint = new Color();

/** The two shape objects handed to `ShapeCache`. Refilled, never rebuilt. */
const _plate = plateShape();
const _bolt = boltShape();

/**
 * One evaluation of the cooling curve. Module scope so `_resolveCooling()` can
 * call it once per part per frame without allocating a return value.
 */
const _cool = { kelvin: 0, flux: 0, stage: 0 };

/**
 * `T(t)` and `dT/dt` for one part, in kelvin and kelvin/second.
 *
 * Three Newton segments — vapour blanket, nucleate boiling, convection — whose
 * boundaries are solved rather than authored: the first is a time (`filmTime`),
 * the second is a *temperature* (`boilEnd`), and inverting the exponential is
 * what turns that temperature back into a time. All closed form, so a paused
 * billet re-cools under every slider in the folder.
 *
 * `scale` is the part's own mass factor. It multiplies all four times together,
 * which is the lumped-capacitance result: τ = ρcV/hA, and V/A goes as the
 * characteristic length.
 *
 * @param {object} c      settings.quench
 * @param {number} elapsed seconds since this part entered the water
 * @param {number} scale   (size / massRef)^massExponent
 * @param {object} out     `_cool`
 */
function coolingCurve(c, elapsed, scale, out) {
  const bath = c.tempBath;
  const start = Math.max(bath + 1, c.tempStart);
  const film = Math.max(0, c.filmTime) * scale;
  const filmTau = Math.max(0.02, c.filmTau) * scale;
  const boilTau = Math.max(0.02, c.boilTau) * scale;
  const convTau = Math.max(0.02, c.convectTau) * scale;
  const boilEnd = clamp(c.boilEnd, bath + 1, start);
  const t = Math.max(0, elapsed);

  /* 1 · the vapour blanket. Slow, because the film insulates. */
  if (t <= film) {
    const kelvin = bath + (start - bath) * Math.exp(-t / filmTau);
    out.kelvin = kelvin;
    out.flux = (kelvin - bath) / filmTau;
    out.stage = 0;
    return out;
  }

  const atCollapse = bath + (start - bath) * Math.exp(-film / filmTau);

  /* 2 · nucleate boiling. The film has gone; water is touching metal. */
  if (atCollapse > boilEnd) {
    const boilFor = boilTau * Math.log((atCollapse - bath) / (boilEnd - bath));
    if (t <= film + boilFor) {
      const kelvin = bath + (atCollapse - bath) * Math.exp(-(t - film) / boilTau);
      out.kelvin = kelvin;
      out.flux = (kelvin - bath) / boilTau;
      out.stage = 1;
      return out;
    }
    /* 3 · convection. */
    const kelvin = bath + (boilEnd - bath) * Math.exp(-(t - film - boilFor) / convTau);
    out.kelvin = kelvin;
    out.flux = (kelvin - bath) / convTau;
    out.stage = 2;
    return out;
  }

  // The blanket outlasted the boiling range: straight to convection.
  const kelvin = bath + (atCollapse - bath) * Math.exp(-(t - film) / convTau);
  out.kelvin = kelvin;
  out.flux = (kelvin - bath) / convTau;
  out.stage = 2;
  return out;
}

/**
 * QUENCH — white-hot stock plunged into a bath.
 *
 * ## THE TRICK — the cooling curve, and it is physical in two directions
 *
 * ### The colour comes off the Planckian locus
 *
 * `vfx/HardSurface.js` carries the real thing: Kim's cubic fit for CIE `x`
 * above 1667 K, a locus-fitted quadratic in `1000/T` below it (Kim's runs off
 * past the spectral locus down there and cools steel through *magenta*), then
 * `xyY → XYZ → linear sRGB`. The emission on top of it is `(T/T_ref)⁴` from
 * Stefan-Boltzmann.
 *
 * The tell that separates this from a four-stop gradient is the yellow, and it
 * is worth knowing why. A straight line in RGB from white to orange passes
 * through a yellow that is both too saturated and slightly green; the locus
 * does not go that way. Steel falling through 1400 K goes **pale straw**. The
 * first version of this ability *was* a four-stop gradient — `colorHotA..D`
 * over the quench — and the stops always landed slightly wrong: it read as an
 * object being lit by something orange rather than as an object making its own
 * light. Deleting the four pickers and letting the physics place the yellow is
 * the single change that made it convincing, and it is why there is no hot
 * colour in `settings.quench` and there must not be one.
 *
 * The `T⁴` matters just as much as the hue. Because the brightness is a power
 * of the temperature rather than a fade curve, **the metal stops glowing on its
 * own**. Nothing tells it to. At 900 K it is 0.27 of the reference, at 640 K it
 * is 0.07, and by the time the steam has cleared it is a grey lump lying in a
 * tank — which is exactly what the long exposure shows.
 *
 * One honest note on the word *white*: a 1750 K blackbody is orange, with a
 * blue channel about a thousandth of its red. The white in a foundry photograph
 * is the sensor clipping, and that is how it is reproduced — entry emission is
 * 3.8× the reference, which after `heatGlow` and the material's own Reinhard
 * ceiling lands near `(3.6, 1.6, 0)` and tone-maps to a yellow-white core with
 * an orange skirt. Raising `tempStart` to chase a bluer hue does not work and
 * is the first thing anybody tries.
 *
 * ### The rate comes off the boiling curve
 *
 * A quench is not one exponential, and treating it as one is why most of them
 * read as a dimmer switch. Water against metal that is hundreds of degrees
 * above its boiling point cannot wet it: it flashes to vapour and the part
 * wears a **film of steam that insulates it**. That is the Leidenfrost stage,
 * and it is *slow*. When the surface finally drops below the Leidenfrost point
 * the film collapses, water touches steel, and the heat comes out an order of
 * magnitude faster — nucleate boiling, the violent stage, the loud one. Below
 * the boiling point it is ordinary convection again, and slow.
 *
 * So the beat of the ability is not authored anywhere. The stock goes in and
 * for the better part of a second **almost nothing happens** — it lies there
 * white, steaming gently. Then the blanket goes and the bath detonates while
 * the colour falls through yellow, orange and cherry inside about a second and
 * a half. Then it is over, and the steam thins out while a dull red lump
 * finishes going black.
 *
 * The steam is driven by the **heat flow** `Σ mass · dT/dt`, which is where all
 * of that comes from: the same number that decides how fast the colour is
 * falling decides how hard the water is boiling. Driving the steam off an
 * envelope instead was the other thing the first version did, and it
 * desynchronised from the colour the moment anybody touched a slider. See
 * `_resolveCooling()` for why it is mass-weighted and not a mean rate — that
 * distinction is the difference between a beat and a bump.
 *
 * ### Mass is the read
 *
 * Every part carries its own `τ`, scaled by `(size/massRef)^massExponent` — the
 * lumped-capacitance result, because τ = ρcV/hA and V/A is a length. The little
 * off-cuts are black before the big billet is orange. One material, one curve,
 * one `aHeat` attribute; the sizes come out of the picture for free, and with
 * `massExponent` at 0 you can watch that read disappear.
 *
 * It buys a second thing for free: the off-cuts' vapour blankets collapse
 * *first*, because their τs are short, so the bath gets a small flurry of steam
 * a third of a second before the billets go. Nobody authored that beat and it
 * is the best part of the timing.
 *
 * ## What a cast captures
 *
 * Per part: five unitless dice rolls (where in the circle, how big, which way
 * up, how much it tumbles). Per cast: a seed and the timestamp the stock hit
 * the water. That is all. Every kelvin, metre and second is resolved from
 * `settings.quench` inside the update loop on every frame, zero-length ones
 * included.
 *
 * ## Budget
 *
 * Two `InstancedMesh`es (billets, off-cuts), one `VolumeHull(CYLINDER, SMOKE)`
 * and one `GroundField(POOL)` — four draw calls, one material, three particle
 * systems, one light.
 */
export class QuenchAbility extends Ability {
  constructor(context) {
    super('quench', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.metal = createHardSurfaceMaterial({ environment: this.ctx.environment });
    this._look = hardSurfaceParams();

    /** Two slots: the billet and the off-cut. Rebuilt only when a number moves. */
    this.cache = new ShapeCache({ capacity: 2 });

    this.plates = this._makeMesh(this.cache.get(0, HardShape.PLATE, _plate), MAX_PLATES, 'Quench:billets');
    this.bolts = this._makeMesh(this.cache.get(1, HardShape.BOLT, _bolt), MAX_BOLTS, 'Quench:offcuts');

    /**
     * The steam. A **cylinder**, not a dome: steam off a bath rises in a column
     * with a boiling, flattish crown, and a dome arches it over into something
     * that reads as an explosion. `steamHeightBias` is authored negative in the
     * settings block for the same reason — smoke thins as it climbs and steam
     * thickens.
     */
    this.steamHull = new VolumeHull({
      hull: HullShape.CYLINDER,
      medium: Medium.SMOKE,
      prefix: 'steam',
      maxSteps: 48,
      renderOrder: 12
    });
    this.group.add(this.steamHull.mesh);

    /** The bath. */
    this.bath = new GroundField(this.group, {
      mode: GroundMode.POOL,
      layer: LAYER.VFX,
      name: 'Quench:bath'
    });
    this._bathParams = groundFieldParams();
    this.bath.setVisible(false);

    /* --- per-part dice. Unitless, rolled once per cast. --- */
    this._sizeRoll = new Float32Array(MAX_PARTS);
    this._radiusRoll = new Float32Array(MAX_PARTS);
    this._angleRoll = new Float32Array(MAX_PARTS);
    this._yawRoll = new Float32Array(MAX_PARTS);
    this._tiltRoll = new Float32Array(MAX_PARTS);

    /* --- resolved every frame --- */
    this._kelvin = new Float32Array(MAX_PARTS);
    /** Mass-weighted heat flow per part — the roulette weight for the flakes. */
    this._partPower = new Float32Array(MAX_PARTS);
    this._powerTotal = 0;

    this._seed = 0;
    this._plunged = false;
    this._plungeAge = 0;
    /** 0..1 normalised boil rate across the whole bath, this frame. */
    this._boil = 0;
    /** The temperature the light and the sparks take their colour from. */
    this._heroKelvin = 300;
    this._fade = 1;
    this._live = 0;
  }

  /** One instanced body: same material, same conventions, different stock. */
  _makeMesh(geometry, capacity, name) {
    const mesh = new InstancedMesh(geometry, this.metal, capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.set(LAYER.WORLD);
    mesh.renderOrder = 2;
    mesh.count = 0;
    mesh.visible = false;
    mesh.name = name;

    // `aHeat` is an OFFSET on the material's `heat`, per instance. An unset
    // attribute reads as 0 in WebGL, so an absolute would make anything that
    // forgot one ice cold; an offset makes the default harmless.
    const heat = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    heat.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aHeat', heat);

    mesh.userData.heat = heat;
    this.group.add(mesh);
    return mesh;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Steam wisps. Non-additive: steam occludes, it does not add light.
    this.steam = particles.get('quench.steam', {
      capacity: 2200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.2
    });
    this.steam.uniforms.uDrag.value = 1.4;
    this.steam.uniforms.uEndSize.value = 3.4;
    this.steam.uniforms.uSizeIn.value = 0.1;
    this.steam.uniforms.uFadeIn.value = 0.12;
    this.steam.uniforms.uFadeOut.value = 0.34;

    // Scale flakes popping off the cooling surface.
    this.sparks = particles.get('quench.sparks', {
      capacity: 1400,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.7;
    this.sparks.uniforms.uEndSize.value = 0.2;
    this.sparks.uniforms.uSizeIn.value = 0.03;
    this.sparks.uniforms.uFadeIn.value = 0.04;
    this.sparks.uniforms.uFadeOut.value = 0.5;

    // Water thrown off the boil and out of the plunge.
    this.drops = particles.get('quench.drops', {
      capacity: 1600,
      shape: ParticleShape.SOFT,
      additive: false,
      lit: true,
      softFade: 0.3
    });
    this.drops.uniforms.uDrag.value = 0.6;
    this.drops.uniforms.uEndSize.value = 0.5;
    this.drops.uniforms.uFadeOut.value = 0.55;

    this.steamEmitter = new RateEmitter();
    this.sparkEmitter = new RateEmitter();
    this.dropEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._live;
  }

  get impactDuration() {
    return Math.max(0.05, settings.quench.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.quench.fadeTime);
  }

  /** A quench does not flicker. The intensity is doing all the work. */
  lightShimmer() {
    return 0.94 + 0.06 * Math.sin(this.age * 4.3) * Math.sin(this.age * 1.7);
  }

  /* ------------------------------------------------------------------ */
  /* The parts                                                           */
  /* ------------------------------------------------------------------ */

  _centrePoint(out) {
    return this.pointAt(1, out);
  }

  get _plateCount() {
    return clamp(Math.round(settings.quench.plateCount), 0, MAX_PLATES);
  }

  get _boltCount() {
    return clamp(Math.round(settings.quench.boltCount), 0, MAX_BOLTS);
  }

  /** Largest extent of part `index`, metres. Unit-space geometry scales by this. */
  _sizeOf(index) {
    const c = settings.quench;
    const plate = index < MAX_PLATES;
    const base = plate ? c.plateSize : c.boltSize;
    const jitter = saturate(plate ? c.plateSizeJitter : c.boltSizeJitter);
    // The roll is unitless; the metre appears here, this frame, every frame.
    return Math.max(0.02, base * (1 - jitter * this._sizeRoll[index]));
  }

  /**
   * Where part `index` lies in the bath, and how far it has fallen.
   *
   * `drop` is 0 in the air at `entryHeight` and 1 at rest. It is driven by the
   * cast's own front — `this.u` — rather than by a timer, so the stock hits the
   * water on the frame the front arrives however far the cast was thrown.
   */
  _placeOf(index, drop, out) {
    const c = settings.quench;
    const radius = Math.max(0.2, c.zoneRadius) * saturate(c.scatter);
    // sqrt on the radial roll, or everything piles up in the middle.
    const r = radius * Math.sqrt(this._radiusRoll[index]);
    const a = this._angleRoll[index] * TAU;

    this._centrePoint(out);
    out.x += Math.cos(a) * r;
    out.z += Math.sin(a) * r;
    out.y = lerp(c.entryHeight, c.restDepth, Easing.inQuad(saturate(drop)));
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* The curve                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Fill `_kelvin` and `_partPower` for every live part, and derive the three
   * numbers the rest of the frame reads off them: `_powerTotal`, `_boil` and
   * `_heroKelvin`.
   *
   * ### The steam is driven by **power**, not by rate
   *
   * The first version averaged each part's `dT/dt` and it was wrong in a way
   * that took a plot to see: a small off-cut has a short τ, so its temperature
   * falls fast, so the mean rate was already 0.38 of full steam *before the
   * cast had even started boiling* and the collapse of the vapour blanket
   * barely moved it. The nine bolts were shouting over the three billets.
   *
   * A bolt's temperature falls fast and it still boils almost no water,
   * because the heat coming out of it is `mc·dT/dt` — mass times rate — and
   * its mass is one-fiftieth of the billet's. So the driver is the
   * **mass-weighted** sum `Σ (size/massRef)³ · dT/dt`, which is the real heat
   * flow into the bath in units of one reference part cooling at one kelvin a
   * second. That single change is what gives the ability its beat: the bath is
   * quiet at 0.15 while the blanket holds, and pins at 1.0 the moment the
   * billet's film collapses.
   *
   * It also means putting more metal in makes more steam, which is correct and
   * which is why `steamRef` is not normalised by the part count.
   *
   * Called before anything that reads it, on every frame including a
   * zero-length one — which is the whole reason `coolingCurve` is closed form.
   */
  _resolveCooling() {
    const c = settings.quench;
    const elapsed = this._plunged ? Math.max(0, this.age - this._plungeAge) : 0;
    const reference = Math.max(1, c.steamRef);
    const massRef = Math.max(0.02, c.massRef);
    const exponent = Math.max(0, c.massExponent);

    const plates = this._plateCount;
    const bolts = this._boltCount;
    let power = 0;
    let hero = c.tempBath;
    let heroSize = -1;

    for (let slot = 0; slot < 2; slot++) {
      const first = slot === 0 ? 0 : MAX_PLATES;
      const count = slot === 0 ? plates : bolts;
      for (let n = 0; n < count; n++) {
        const index = first + n;
        const size = Math.max(0.02, this._sizeOf(index));
        const ratio = size / massRef;
        // τ ∝ characteristic length (lumped capacitance, V/A). `massExponent`
        // at 0 turns the whole effect off, which is the fastest way to see
        // what it is worth.
        const scale = Math.pow(ratio, exponent);
        coolingCurve(c, elapsed, scale, _cool);
        this._kelvin[index] = _cool.kelvin;
        // Mass, not count: ratio³ is the volume against the reference part's.
        const share = ratio * ratio * ratio * _cool.flux;
        this._partPower[index] = share;
        power += share;
        // The biggest part lights the scene and sets the sparks' temperature.
        if (size > heroSize) {
          heroSize = size;
          hero = _cool.kelvin;
        }
      }
    }

    this._powerTotal = power;
    this._boil = saturate(power / reference);
    // Before the plunge the stock is still in the air at entry heat.
    this._heroKelvin = this._plunged ? hero : Math.max(c.tempBath, c.tempStart);
  }

  /** 0..1 heat for the material, from a temperature, matching the shader exactly. */
  _heatOf(kelvin) {
    const c = settings.quench;
    const cold = c.heatCold;
    const hot = Math.max(cold + 1, c.heatHot);
    return saturate((kelvin - cold) / (hot - cold));
  }

  /* ------------------------------------------------------------------ */
  /* Sync                                                                */
  /* ------------------------------------------------------------------ */

  /** Rebuild the two profiles if a shape slider moved, then write the instances. */
  _syncParts(drop) {
    const c = settings.quench;

    _plate.width = c.plateWidth;
    _plate.depth = c.plateDepth;
    _plate.thickness = c.plateThickness;
    _plate.corner = c.plateCorner;
    _plate.bevel = c.plateBevel;
    _plate.bolts = Math.round(c.plateBolts);
    _plate.boltRadius = c.plateBoltRadius;
    _plate.boltInset = c.plateBoltInset;
    _plate.counterSink = c.plateCounterSink;
    _plate.counterDepth = c.plateCounterDepth;
    _plate.creaseAngle = c.plateCrease;
    _plate.axis = HardAxis.Y;

    _bolt.length = c.boltLength;
    _bolt.headHeight = c.boltHeadHeight;
    _bolt.headChamfer = c.boltHeadChamfer;
    _bolt.washer = c.boltWasher;
    _bolt.washerRadius = c.boltWasherRadius;
    _bolt.shankRadius = c.boltShankRadius;
    _bolt.threadTurns = Math.round(c.boltThreadTurns);
    _bolt.threadDepth = c.boltThreadDepth;
    _bolt.threadFrom = c.boltThreadFrom;
    _bolt.tipTaper = c.boltTipTaper;
    _bolt.creaseAngle = c.boltCrease;
    // Off-cuts lie down in the bath rather than standing on end, so the bolt is
    // seated across the cast instead of up it. This is a mode, not a dimension.
    _bolt.axis = HardAxis.X;

    this._rebuild(this.plates, 0, HardShape.PLATE, _plate);
    this._rebuild(this.bolts, 1, HardShape.BOLT, _bolt);

    const plates = this._plateCount;
    const bolts = this._boltCount;
    // In the air the stock tumbles; in the water it has come to rest.
    const tumble = 1 - saturate(drop);

    this._writeInstances(this.plates, 0, plates, drop, tumble);
    this._writeInstances(this.bolts, MAX_PLATES, bolts, drop, tumble);
    this._live = plates + bolts;
  }

  _rebuild(mesh, slot, kind, shape) {
    const geometry = this.cache.get(slot, kind, shape);
    if (this.cache.changed || mesh.geometry !== geometry) {
      mesh.geometry = geometry;
      // The cache handed back a fresh BufferGeometry and disposed the one that
      // was carrying the instance attribute, so it has to be reattached.
      geometry.setAttribute('aHeat', mesh.userData.heat);
    }
  }

  _writeInstances(mesh, first, count, drop, tumble) {
    const c = settings.quench;
    const heat = mesh.userData.heat;

    for (let n = 0; n < count; n++) {
      const index = first + n;
      const size = this._sizeOf(index);

      this._placeOf(index, drop, _pos);
      _dummy.position.copy(_pos);
      _dummy.rotation.set(
        (this._tiltRoll[index] * 2 - 1) * c.entryTilt * tumble + (this._tiltRoll[index] - 0.5) * c.plateLean,
        this._yawRoll[index] * TAU,
        (this._yawRoll[index] * 2 - 1) * c.entryTilt * tumble + (this._yawRoll[index] - 0.5) * c.plateLean
      );
      _dummy.scale.setScalar(size);
      _dummy.updateMatrix();
      mesh.setMatrixAt(n, _dummy.matrix);

      heat.array[n] = this._heatOf(this._kelvin[index]);
    }

    mesh.count = count;
    mesh.visible = count > 0;
    mesh.instanceMatrix.needsUpdate = true;
    heat.needsUpdate = true;
  }

  /** Push the live steel settings into the one shared material. */
  _syncMetal() {
    const c = settings.quench;
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
    // Zero, because every part carries its own temperature in `aHeat` and the
    // whole point is that they do not cool together.
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

  /**
   * The steam column.
   *
   * `setSize` takes **half-extents in metres and is called every frame** —
   * scaling the mesh instead would leave the raymarch's `t` meaning something
   * other than metres and the whole medium would drift as the column grew.
   */
  _syncSteam(fade) {
    const c = settings.quench;
    const g = settings.global;
    const radius = Math.max(0.2, c.zoneRadius);
    // The volume follows the boil, not the clock. `steamCurve` below 1 makes
    // the column reach full body early in the nucleate stage and hang there,
    // which is what a bath actually does; above 1 it tracks the flux exactly.
    const body = Math.pow(saturate(this._boil), Math.max(0.05, c.steamCurve));

    this._centrePoint(_centre);
    _centre.y = c.steamLift;

    this.steamHull
      .place(_centre, this.direction)
      .setSize(radius * c.steamWidth, radius * c.steamHeight * 0.5, radius * c.steamWidth)
      .setFade(body * fade * c.steamFade)
      .sync(c, g);
  }

  /** The bath. */
  _syncBath(grow, fade) {
    const c = settings.quench;
    const g = settings.global;
    const p = this._bathParams;

    this._centrePoint(_centre);
    p.centre = _centre;
    p.yaw = Math.atan2(this.direction.x, this.direction.z);
    p.height = 0.012;
    p.radius = Math.max(0.2, c.zoneRadius);
    p.grow = grow;
    p.fade = fade;
    p.seed = this._seed;

    p.edge = c.fieldEdge;
    p.ragged = c.fieldRagged;
    p.raggedScale = c.fieldRaggedScale;
    p.warp = c.fieldWarp;
    p.relief = c.fieldRelief;
    p.specular = c.fieldSpecular;
    p.gloss = c.fieldGloss;
    p.cell = c.fieldCell;
    p.thickness = c.fieldThickness;
    p.depth = c.fieldDepth;
    p.sharp = c.fieldSharp;
    p.detail = c.fieldDetail;
    p.flow = c.fieldFlow;
    p.speed = c.fieldSpeed;
    p.windAngle = c.fieldWindAngle;
    p.parallax = c.fieldParallax;
    p.opacity = c.fieldOpacity;
    // The firelight in the water is the boil's, not the clock's — a cold bath
    // does not glow, and this is the term that says so.
    p.emissive = c.fieldEmissive * (0.25 + 1.6 * saturate(this._boil));
    p.colorBase = c.colorFieldBase;
    p.colorEdge = c.colorFieldEdge;
    p.colorGlow = c.colorFieldGlow;
    p.colorDeep = c.colorFieldDeep;

    p.noiseStrength = g.noiseStrength;
    p.noiseFrequency = g.noiseFrequency;
    p.noiseSpeed = g.noiseSpeed;
    p.opacityScale = g.opacity;

    this.bath.setVisible(fade > 0.001);
    this.bath.update(p);
  }

  _syncParticles() {
    const c = settings.quench;
    const g = settings.global;

    this.steam.setGradient(
      getColor(c.colorSteamA),
      getColor(c.colorSteamB),
      getColor(c.colorSteamC),
      getColor(c.colorSteamD)
    );
    this.steam.uniforms.uGravity.value.set(0, c.steamRise, 0);
    this.steam.uniforms.uSizeScale.value = c.steamSize * g.particleSize;
    this.steam.uniforms.uLifeScale.value = c.steamLifetime * 0.5 * g.particleLifetime;
    this.steam.uniforms.uSpeedScale.value = c.steamSpeed * g.particleSpeed;
    this.steam.uniforms.uOpacity.value = c.steamOpacity * g.opacity;
    this.steam.uniforms.uTurbulence.value = c.steamTurbulence * g.turbulence;

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
    this.sparks.uniforms.uTurbulence.value = 0.25 * g.turbulence;

    this.drops.setGradient(
      getColor(c.colorDropA),
      getColor(c.colorDropB),
      getColor(c.colorDropC),
      getColor(c.colorDropD)
    );
    this.drops.uniforms.uGravity.value.set(0, c.dropGravity, 0);
    this.drops.uniforms.uSizeScale.value = c.dropSize * g.particleSize * 7;
    this.drops.uniforms.uLifeScale.value = c.dropLifetime * 0.5 * g.particleLifetime;
    this.drops.uniforms.uSpeedScale.value = g.particleSpeed;
    this.drops.uniforms.uOpacity.value = g.opacity;
  }

  /* ------------------------------------------------------------------ */
  /* Emission                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Steam, scale and spatter, all of it rationed by the boil rate.
   *
   * Nothing here has an envelope of its own. Three systems, one driver — which
   * is why turning `filmTime` up moves the whole eruption later rather than
   * sliding the steam out from under the colour.
   */
  _boilFx(dt, fade) {
    const c = settings.quench;
    const g = settings.global;
    const boil = saturate(this._boil) * fade;
    if (boil <= 1e-3) return;

    const time = frame.uTime.value;
    const radius = Math.max(0.2, c.zoneRadius) * saturate(c.scatter);
    const parts = this._plateCount + this._boltCount;

    const steamCount = Math.round(this.steamEmitter.tick(dt, c.steamRate * boil) * g.particleCount);
    if (steamCount > 0) {
      this._centrePoint(_pos);
      _pos.y = Math.max(0.02, c.steamLift);
      _emit.position = _pos;
      _emit.radius = radius * 1.05;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.steamSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.75;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 1.0;
      _emit.sizeVariance = 0.5;
      _emit.life = c.steamLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0.35;
      _emit.tint = null;
      _emit.time = time;
      this.steam.emit(steamCount, _emit);
    }

    const dropCount = Math.round(this.dropEmitter.tick(dt, c.dropRate * boil) * g.particleCount);
    if (dropCount > 0) {
      this._centrePoint(_pos);
      _pos.y = 0.05;
      _emit.position = _pos;
      _emit.radius = radius;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.dropSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.6;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.8;
      _emit.life = c.dropLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.drops.emit(dropCount, _emit);
    }

    // Scale flakes. Tinted with the blackbody colour of the part that threw
    // them — the same locus the metal is using, because a flake of scale is
    // exactly as hot as the surface it came off. Hard-coding an orange here is
    // how a cherry-red billet ends up throwing lemon-yellow sparks.
    const sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate * boil) * g.particleCount);
    if (sparkCount > 0 && parts > 0) {
      const index = this._pickPart(parts);
      this._placeOf(index, 1, _pos);
      _pos.y = Math.max(_pos.y, 0.03);
      blackbodyColor(this._kelvin[index], _hot);
      _emit.position = _pos;
      _emit.radius = this._sizeOf(index) * 0.5;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.sparkSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.size = 0.14;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = _tint.copy(_hot);
      _emit.time = time;
      this.sparks.emit(sparkCount, _emit);
      _emit.tint = null;
    }
  }

  /**
   * A live part index, drawn in proportion to the heat it is currently putting
   * into the water.
   *
   * Uniformly at random was the first version and it was quietly wrong: the
   * off-cuts outnumber the billets three to one, so three-quarters of the
   * flakes came off parts that had already gone black. Rouletting on
   * `_partPower` puts the flakes on whatever is actually boiling — the off-cuts
   * during the early flurry, the billets once their blanket goes — for the cost
   * of one loop over at most twenty-four floats.
   */
  _pickPart(parts) {
    const plates = this._plateCount;
    const bolts = this._boltCount;
    let ticket = Math.random() * this._powerTotal;
    let last = 0;
    for (let slot = 0; slot < 2; slot++) {
      const first = slot === 0 ? 0 : MAX_PLATES;
      const count = slot === 0 ? plates : bolts;
      for (let n = 0; n < count; n++) {
        const index = first + n;
        last = index;
        ticket -= this._partPower[index];
        if (ticket <= 0) return index;
      }
    }
    // Everything is stone cold and the sum was zero; any live part will do.
    void parts;
    return last;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.steamEmitter.reset();
    this.sparkEmitter.reset();
    this.dropEmitter.reset();

    this._seed = Math.random() * 100;
    this._plunged = false;
    this._plungeAge = 0;
    this._boil = 0;
    this._heroKelvin = settings.quench.tempStart;
    this._fade = 1;
    this._live = 0;

    // Five unitless rolls per part. Not one of them is a metre; every metre
    // they eventually become is multiplied on inside the update loop.
    for (let i = 0; i < MAX_PARTS; i++) {
      this._sizeRoll[i] = hash11(this._seed * 3.11 + i * 7.31);
      this._radiusRoll[i] = hash11(this._seed * 5.77 + i * 2.19);
      this._angleRoll[i] = hash11(this._seed * 1.93 + i * 9.07);
      this._yawRoll[i] = hash11(this._seed * 8.41 + i * 4.53);
      this._tiltRoll[i] = hash11(this._seed * 6.29 + i * 1.37);
    }

    this._resolveCooling();
    this._syncMetal();
    this._syncParticles();
    this._syncParts(0);
    this._syncSteam(0);
    this._syncBath(0, 1);
  }

  onTravel(_dt) {
    this._fade = 1;
    this._resolveCooling();
    this._syncMetal();
    this._syncParticles();
    // `this.u` is the fall: the stock is in the air until the front arrives.
    this._syncParts(this.u);
    this._syncSteam(0);
    this._syncBath(this.u, 1);

    // The light rides the falling stock, which is the only thing lit yet.
    this._placeOf(0, this.u, this.position);
  }

  onImpact() {
    const c = settings.quench;
    const g = settings.global;
    const time = frame.uTime.value;

    this._plunged = true;
    this._plungeAge = this.age;
    this._resolveCooling();

    this._centrePoint(_centre);

    this.ctx.bursts.spawn(BurstMode.WATER, _centre, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.6,
      intensity: c.burstIntensity,
      opacity: 0.75,
      fresnel: 1.8,
      displace: 0.55,
      squash: 0.6,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    const radius = Math.max(0.2, c.zoneRadius) * saturate(c.scatter);
    _pos.copy(_centre);
    _pos.y = 0.06;
    _emit.position = _pos;
    _emit.radius = radius * 0.8;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dropSpeed * 2.4;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.75;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.13;
    _emit.sizeVariance = 0.8;
    _emit.life = c.dropLifetime * 1.4;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.drops.emit(Math.round(c.splashDrops * g.particleCount), _emit);

    _emit.speed = c.steamSpeed * 1.6;
    _emit.spread = 0.9;
    _emit.size = 0.9;
    _emit.life = c.steamLifetime;
    _emit.spin = 0.4;
    this.steam.emit(Math.round(c.splashSteam * g.particleCount), _emit);

    this.ctx.shake.add(
      c.plungeShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.plungeFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.4 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.quench;

    this._fade = t <= 1 ? 1 : 1 - Easing.inQuad(saturate(t - 1));

    this._resolveCooling();
    this._syncMetal();
    this._syncParticles();
    this._syncParts(1);
    this._syncSteam(this._fade);
    this._syncBath(1, this._fade);
    this._boilFx(dt, this._fade);

    this._centrePoint(this.position);
    this.position.y = Math.max(0.2, c.restDepth + 0.4);
  }

  /**
   * The dynamic light, overridden — the one place this ability leaves the base
   * class's rails, and the reason is the trick.
   *
   * The base copies `lightColor` straight out of the block. Here the light is
   * being thrown by a specific object at a specific temperature, so the colour
   * comes off the **same Planckian locus the metal is using** — `blackbodyColor`
   * is the CPU mirror of `hardBlackbody` and they agree to the last float. The
   * intensity follows the same `(T/T_ref)ⁿ` too, which is what makes the light
   * go out with the steel instead of on a fade curve nobody asked for.
   *
   * I5 is not broken by this: `lightColor` is still an authored picker and
   * `lightBlackbody` says how far it is dragged onto the locus, so at 0 the
   * behaviour is exactly the base class's. The `T⁴` ceiling exists because
   * entry heat is 1660 K against a 1250 K reference and the unclamped term is
   * 3.1 — enough to blow the exposure on the frame the stock appears.
   */
  _updateLight(dt, scale) {
    if (!this.light) return;
    const c = settings.quench;

    blackbodyColor(this._heroKelvin, _hot);
    this.lightColor.copy(getColor(c.lightColor)).lerp(_hot, saturate(c.lightBlackbody));

    const emit = Math.pow(
      Math.max(this._heroKelvin, 1) / Math.max(c.heatRef, 1),
      Math.max(c.heatExponent, 0.1)
    );
    const intensity =
      c.lightIntensity * scale * Math.min(emit, Math.max(0.01, c.lightCeiling)) * this.lightShimmer() +
      this.lightBoost;

    this.ctx.lights.set(
      this.light,
      this.position,
      this.lightColor,
      intensity,
      c.lightRadius * (1 + this.lightBoost * 0.02),
      dt
    );
    this.lightBoost = Math.max(0, this.lightBoost - this.lightBoost * 4.5 * dt - 0.5 * dt);
  }

  onDestroy() {
    this._live = 0;
    this._plunged = false;
    this._boil = 0;
    this._powerTotal = 0;
    this.plates.count = 0;
    this.plates.visible = false;
    this.bolts.count = 0;
    this.bolts.visible = false;
    this.steamHull.setFade(0);
    this.bath.setVisible(false);
  }

  dispose() {
    this.steamHull.dispose();
    this.bath.dispose();
    // The cache owns both geometries; the meshes only borrow them.
    this.cache.dispose();
    this.metal.dispose();
    super.dispose();
  }
}
