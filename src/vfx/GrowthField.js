import { InstancedMesh, InstancedBufferAttribute, Object3D, Vector3, Quaternion } from 'three';
import { patchOnBeforeCompile, replaceChunk } from '../utils/shaderPatch.js';
import { LAYER } from '../core/Layers.js';
import { disruptGLSL, disruptUniforms } from './SceneHooks.js';
import { saturate, lerp, smoothstep, Easing } from '../utils/math.js';

/* ---------------------------------------------------------------------- */
/* GrowthField — things that come out of the ground                        */
/* ---------------------------------------------------------------------- */

/**
 * Instanced procedural geometry erupting along a line or across a zone.
 *
 * This is `IceAbility`'s crystal field with the ice taken out of it. That field
 * is the best system in the original build for one reason, and it is not the
 * shader: a spike record holds **nothing but dice rolls and one timestamp**, and
 * every metre, radian and second is resolved against the live settings inside
 * the update loop. Drag `height` on a field that is already standing, with the
 * clock stopped, and the field re-grows. Twelve abilities in `docs/ROSTER.md`
 * want that behaviour with a different silhouette — thorns, sheet-ice plates,
 * heaved stone slabs, bone spears, petals, chain links — so the discipline moved
 * here and the look stayed with the ability.
 *
 * **This module does not own a material.** It owns placement, timing and
 * matrices; the ability supplies the geometry factory and the material, which is
 * why rime plates and umbral spears can share every line of this file and look
 * nothing like each other. `patchGrowthMaterial()` at the bottom wires the two
 * per-instance attributes into a `MeshStandardMaterial` for you.
 *
 * ## What it draws
 *
 * `variants` InstancedMeshes over one shared record pool — three by default,
 * because that is what `IceAbility` learnt: per-instance scaling gives you
 * proportion variety, but only distinct geometry gives you *facet* variety, and
 * a field of one silhouette scaled forty ways reads as a repeated prop the
 * moment the camera moves. Three draw calls is the price and it is worth it. Set
 * `variants: 1` for anything whose shape genuinely does not repeat (one big
 * lance) and the cost drops with it.
 *
 * ## The contract with the geometry factory
 *
 * The factory is called as `factory(variant, shape)` and must return geometry in
 * **unit space**: footprint inside a circle of radius 0.5 on `y = 0`, tip at
 * `y = 1`. An instance then scales footprint and height independently, and
 * `local.y` reads straight off in the fragment shader as "how far up this thing
 * am I" — which is what every base-to-tip gradient (rime line, bark, wither)
 * keys off. `assets/ProceduralGeometry.js#createCrystalGeometry` is the
 * reference implementation.
 *
 * ## The rule for using it well
 *
 * Fill the params object from `settings[id]` **every frame** and hand it to
 * `update()`. Never keep a resolved metre between frames. If your settings block
 * happens to use the canonical names below you can pass the block itself, which
 * makes breaking invariant I1 impossible.
 *
 * @example
 *   this.field = new GrowthField(this.group, {
 *     geometry: (v, shape) => createCrystalGeometry({ seed: 7.3 + v * 21.7, ...shape }),
 *     material: this.material,
 *     capacity: 240
 *   });
 *   // spawn
 *   this.field.plant(count, 0.22);
 *   // travel, every frame
 *   this._fillParams();                       // reads settings.rime into a scratch
 *   this.field.syncGeometry(this._shape);     // live shape sliders
 *   this.field.triggerUpTo(this.age, this.u, c.riseStagger, c.frontBias, false);
 *   this.field.update(this.age, this._params, 0);
 */

const TAU = Math.PI * 2;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _dummy = new Object3D();
const _lean = new Vector3();
const _axis = new Vector3();
const _up = new Vector3(0, 1, 0);
const _tilt = new Quaternion();
const _spin = new Quaternion();
const _centre = new Vector3();
const _breachPos = new Vector3();
const _zero = new Vector3();
const _forward = new Vector3(0, 0, 1);
const _right = new Vector3(1, 0, 0);

/** Where the field is laid out. A mode, not a dimension — safe to capture. */
export const GrowthLayout = Object.freeze({
  LINE: 0, // a band down the cast line, widening with `widthCurve`
  ZONE: 1 // an annulus about a centre, `innerRadius`..`radius`
});

/** How an instance arrives. */
export const GrowthEmerge = Object.freeze({
  /** Punches up out of the floor: buried, then slid into place. Ice, stone, bone. */
  PUSH: 0,
  /** Accretes in place at full position, scaling from nothing. Petals, facets, air growth. */
  SCALE: 1
});

/**
 * Canonical parameter names with their defaults, in the units the field wants.
 *
 * Every one of these is read fresh on every call to `update()`. A missing field
 * falls back to the default listed here, so a params object only carries what
 * the ability actually authors.
 */
export function growthParams() {
  return {
    /* --- mode + basis (the ability's own vectors; never copied) --- */
    layout: GrowthLayout.LINE,
    emerge: GrowthEmerge.PUSH,
    origin: null, // Vector3, on the floor
    direction: null, // Vector3, unit, flat
    side: null, // Vector3, unit, lateral
    length: 10, // metres down the line
    centre: null, // Vector3 for ZONE; defaults to the far end of the line
    radius: 4, // metres, ZONE outer
    innerRadius: 0, // metres, ZONE inner (0 fills the disc)

    /* --- LINE footprint (metres unless noted) --- */
    widthNear: 0.5, // half-width of the band at the caster
    width: 2.5, // half-width at the far end
    widthCurve: 1, // <1 flares early, >1 stays narrow then opens out
    frontBias: 1, // <1 crowds instances toward the far end, unitless
    clumping: 1, // >1 pulls them toward the centre line, unitless
    scatter: 0.5, // extra lateral jitter, fraction of the local half-width

    /* --- ZONE footprint --- */
    radialCurve: 1, // <1 pushes the band toward the rim
    radialJitter: 0, // metres of radial wander
    angleJitter: 0, // radians of bearing wander

    /* --- the terminal cluster (the records held back by `plant`) --- */
    clusterRadius: -1, // metres; < 0 derives 1.25 × the far half-width / inner radius

    /* --- silhouette --- */
    heightNear: 0.5, // metres at the near end / centre
    height: 3, // metres at the far end / rim
    heightCurve: 1, // how late the ramp climbs
    heightJitter: 0.4, // ± fraction
    crown: 0, // 0..1 — how much shorter the flank instances are than the spine
    crownPower: 1.4, // how sharply that dome falls off
    peak: 1, // extra height multiplier at the far end
    peakWidth: 0.25, // 0..1 of the cast that swell covers
    rubble: 0, // 0..1 chance an instance is demoted to wreckage
    rubbleScale: 0.3, // height multiplier for those
    rubbleSpread: 1.25, // radius multiplier for those
    minHeight: 0.02, // metres, floor

    radiusNear: 0.3, // metres, base radius at the near end / centre
    radius2: -1, // metres at the far end / rim; < 0 tracks `radiusNear`
    radiusCurve: 0.6, // how the radius ramps along the cast
    radiusJitter: 0.4, // ± fraction
    minRadius: 0.01, // metres, floor

    /* --- orientation --- */
    lean: 0, // radians away from the caster / outward from the centre
    leanJitter: 0, // ± fraction
    leanRamp: 0.65, // 0 leans everything equally, 1 only leans the far end
    leanForward: 0.75, // weight of "away from the caster" in the lean direction
    leanOutward: 0.85, // weight of "out across the band"
    twist: 1, // 0..1 of a full turn of random yaw
    tilt: 0, // radians of extra random tip, any bearing

    /* --- where the base sits (air growth) --- */
    baseHeight: 0, // metres above the floor
    baseJitter: 0, // ± fraction of `baseHeight`

    /* --- the eruption --- */
    riseTime: 0.18, // seconds from buried to full height
    riseOvershoot: 0.25, // how far past full height the punch carries
    settle: 0.5, // seconds the overshoot damps out over
    springRate: 14, // radians/second of that overshoot ring
    emergeSink: 0.85, // fraction of its height an instance is buried at emerge = 0
    birthScale: 0.86, // footprint scale at the moment it breaks through
    birthFade: 0.18, // seconds the `aBirth` flash decays over
    breachAt: 0.25, // emergence fraction that fires `onBreach`

    /* --- withdrawal --- */
    sinkDepth: 0.4, // extra metres a retracting instance drops beyond its own height

    /* --- globals --- */
    randomness: 1 // multiplies every *Jitter above (settings.global.randomness)
  };
}

export class GrowthField {
  /**
   * @param {THREE.Object3D} parent  the ability's group
   * @param {object} options
   * @param {(variant: number, shape: object) => THREE.BufferGeometry} options.geometry
   *        unit-space geometry factory — see the class header for the space
   * @param {THREE.Material} options.material  supplied by the ability, never owned here
   * @param {object} [options.shape]           first shape params, handed to the factory and
   *        used to prime the rebuild hash, so the first `syncGeometry` with the same numbers
   *        is a no-op. Omit it only if your factory tolerates `null`.
   * @param {number} [options.variants=3]      distinct silhouettes = distinct draw calls
   * @param {number} [options.capacity=288]    hard ceiling on instances per cast
   * @param {number} [options.layer=LAYER.WORLD]
   * @param {number} [options.renderOrder=2]
   * @param {boolean} [options.castShadow=true]
   * @param {boolean} [options.receiveShadow=true]
   */
  constructor(parent, options = {}) {
    const {
      geometry,
      material,
      shape = null,
      variants = 3,
      capacity = 288,
      layer = LAYER.WORLD,
      renderOrder = 2,
      castShadow = true,
      receiveShadow = true
    } = options;

    if (typeof geometry !== 'function') throw new Error('GrowthField: options.geometry must be a factory');
    if (!material) throw new Error('GrowthField: options.material is required');

    this.parent = parent;
    this.factory = geometry;
    this.material = material;
    this.variants = Math.max(1, Math.round(variants));
    this.capacity = Math.max(1, Math.round(capacity));
    this.slots = Math.ceil(this.capacity / this.variants);

    /**
     * Fired the frame an instance breaks the surface — chips, a puff, a decal.
     * Assign **once**, at construction: a closure built inside the update loop
     * is an allocation per frame per instance, which is exactly what I3 forbids.
     * @type {null | (index: number, position: Vector3, radius: number, height: number) => void}
     */
    this.onBreach = null;

    this.meshes = [];
    this.seedAttributes = [];
    this.birthAttributes = [];

    for (let v = 0; v < this.variants; v++) {
      const seeds = new InstancedBufferAttribute(new Float32Array(this.slots), 1);
      const births = new InstancedBufferAttribute(new Float32Array(this.slots), 1);
      for (let i = 0; i < this.slots; i++) seeds.array[i] = Math.random() * 10;

      const mesh = new InstancedMesh(this._buildGeometry(v, shape, seeds, births), material, this.slots);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      // Placed in world space from the CPU every frame; its own bounds are a lie
      // and the cost of computing them per cast is not worth paying.
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.layers.set(layer);
      mesh.renderOrder = renderOrder;
      parent.add(mesh);

      this.meshes.push(mesh);
      this.seedAttributes.push(seeds);
      this.birthAttributes.push(births);
    }

    /**
     * Fixed-size record pool — a cast allocates nothing.
     *
     * Dice and one timestamp. If you are tempted to add a metre to this object,
     * add a slider to the params instead; see the class header.
     */
    this.records = [];
    for (let i = 0; i < this.capacity; i++) {
      this.records.push({
        along: 0, // 0..1 uniform down the line, *before* frontBias
        lateral: 0, // -1..1 across the band, before clumping
        scatter: 0, // -1..1 extra lateral / angular jitter
        angle: 0, // 0..1 of a turn — cluster bearing, or ZONE bearing
        radial: 0, // 0..1 sqrt-uniform, so a disc fills evenly
        cluster: false, // held back for the group at the far end / the centre
        rubbleRoll: 0, // 0..1, compared live against `rubble`
        heightRoll: 0, // -1..1
        radiusRoll: 0, // -1..1
        leanRoll: 0, // -1..1
        tiltRoll: 0, // -1..1
        tiltBearing: 0, // 0..1 of a turn
        baseRoll: 0, // -1..1
        yaw: 0, // 0..1 of a turn
        stagger: 0, // 0..1 of the caller's stagger window
        eruptTime: -1, // absolute age it was triggered at, or -1 for buried
        breached: false
      });
    }

    this._count = 0;
    this._clusterStart = this.capacity;
    this._used = new Int32Array(this.variants);

    /** Numeric signature of the last geometry build. See `syncGeometry`. */
    this._shapeKeys = null;
    this._shapeValues = null;
    if (shape) {
      this._shapeKeys = Object.keys(shape);
      this._shapeValues = new Float64Array(this._shapeKeys.length);
      for (let k = 0; k < this._shapeKeys.length; k++) {
        this._shapeValues[k] = +shape[this._shapeKeys[k]];
      }
    }
  }

  /** Instances currently planted. Feed this to `Ability#instanceCount`. */
  get count() {
    return this._count;
  }

  /** Draw calls this field costs while it is standing. */
  get drawCalls() {
    return this.variants;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry                                                            */
  /* ------------------------------------------------------------------ */

  _buildGeometry(variant, shape, seeds, births) {
    const geometry = this.factory(variant, shape);
    // The per-instance attributes are state, not shape — they survive a rebuild.
    geometry.setAttribute('aSeed', seeds ?? this.seedAttributes[variant]);
    geometry.setAttribute('aBirth', births ?? this.birthAttributes[variant]);
    return geometry;
  }

  /**
   * Rebuild the meshes when a *shape* control moves.
   *
   * Facet counts, taper, curl and bend cannot be expressed as a per-instance
   * transform, so they are baked into the geometry — and a six-sided crystal is
   * 108 triangles, cheap enough to rebuild outright rather than approximate in a
   * vertex shader. That is what keeps them live sliders, paused included.
   *
   * The change test compares numbers in a Float64Array rather than building a
   * key string. `IceAbility#_syncGeometry` composes a template literal every
   * frame; at one ability that is invisible, at fifty it is fifty strings a
   * frame for the garbage collector to sweep up for nothing.
   *
   * @param {object|null} shape  handed straight to the factory
   * @returns {boolean} true if the geometry was rebuilt this call
   */
  syncGeometry(shape) {
    if (!shape) return false;

    if (!this._shapeKeys) {
      // One allocation, on the first call, outside any cast.
      this._shapeKeys = Object.keys(shape);
      this._shapeValues = new Float64Array(this._shapeKeys.length);
      for (let k = 0; k < this._shapeKeys.length; k++) this._shapeValues[k] = NaN;
    }

    let changed = false;
    for (let k = 0; k < this._shapeKeys.length; k++) {
      const value = +shape[this._shapeKeys[k]];
      if (value !== this._shapeValues[k]) {
        this._shapeValues[k] = value;
        changed = true;
      }
    }
    if (!changed) return false;

    for (let v = 0; v < this.variants; v++) {
      const mesh = this.meshes[v];
      const previous = mesh.geometry;
      mesh.geometry = this._buildGeometry(v, shape);
      previous.dispose();
    }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Planting — the only place the dice are rolled                       */
  /* ------------------------------------------------------------------ */

  /**
   * Roll a fresh field. Call from `onSpawn()`.
   *
   * `clusterShare` holds the last slice of the count back from the travelling
   * front: in LINE layout they land in a ring about the impact point, in ZONE
   * layout they land inside `innerRadius` as the core. Pass 0 for neither.
   *
   * The count is captured because it is a *count*, not a dimension — changing it
   * mid-cast would reshuffle a standing field rather than reshape it, which is
   * the one thing the paused-slider test is not asking for.
   *
   * @param {number} count         instances this cast, clamped to `capacity`
   * @param {number} [clusterShare] 0..1 of them reserved for the cluster
   * @returns {number} the count actually planted
   */
  plant(count, clusterShare = 0) {
    const wanted = Math.min(this.capacity, Math.max(0, Math.round(count)));
    const clustered = Math.round(wanted * saturate(clusterShare));

    this._count = wanted;
    this._clusterStart = wanted - clustered;

    const spine = Math.max(1, this._clusterStart);

    for (let i = 0; i < wanted; i++) {
      const record = this.records[i];
      const cluster = i >= this._clusterStart;

      record.cluster = cluster;
      record.eruptTime = -1;
      record.breached = false;
      record.yaw = Math.random();
      record.stagger = Math.random();
      record.heightRoll = Math.random() * 2 - 1;
      record.radiusRoll = Math.random() * 2 - 1;
      record.leanRoll = Math.random() * 2 - 1;
      record.tiltRoll = Math.random() * 2 - 1;
      record.tiltBearing = Math.random();
      record.baseRoll = Math.random() * 2 - 1;
      record.scatter = Math.random() * 2 - 1;
      record.rubbleRoll = Math.random();
      record.lateral = Math.random() * 2 - 1;
      record.angle = Math.random();
      // sqrt keeps a disc evenly dense instead of piling everything in the middle.
      record.radial = Math.sqrt(Math.random());
      // Stratified rather than uniform: one instance per slot down the line plus
      // a jitter inside it, so a sparse field still covers the whole cast.
      // `frontBias` is *not* applied here — it is a live exponent in `_alongOf`,
      // which is the one place this field improves on the crystal field it came
      // from, where dragging the bias could not move a standing spike.
      record.along = cluster ? 1 : (i + Math.random()) / spine;
    }

    for (let i = wanted; i < this.capacity; i++) this.records[i].eruptTime = -1;
    for (let v = 0; v < this.variants; v++) this.meshes[v].count = 0;
    return wanted;
  }

  /** Un-plant everything. `onDestroy()`. */
  clear() {
    this._count = 0;
    this._clusterStart = this.capacity;
    for (let v = 0; v < this.variants; v++) this.meshes[v].count = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Triggering                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Erupt everything the travelling front has now reached (LINE).
   *
   * @param {number} now      the ability's `age`, seconds
   * @param {number} limit    how far down the line the front has got, 0..1
   * @param {number} stagger  seconds of random delay between neighbours
   * @param {number} [frontBias] the same live exponent `update` will use
   * @param {boolean} [includeCluster] release the terminal group too
   */
  triggerUpTo(now, limit, stagger, frontBias = 1, includeCluster = false) {
    for (let i = 0; i < this._count; i++) {
      const record = this.records[i];
      if (record.eruptTime >= 0) continue;
      if (record.cluster) {
        if (!includeCluster) continue;
      } else if (Math.pow(record.along, frontBias) > limit) {
        continue;
      }
      record.eruptTime = now + record.stagger * stagger;
    }
  }

  /**
   * Erupt everything the front has reached measured *radially* (ZONE).
   * `invert` fills from the boundary inward, which is how Hailwrath reads.
   */
  triggerRadial(now, limit, stagger, invert = false, includeCluster = true) {
    for (let i = 0; i < this._count; i++) {
      const record = this.records[i];
      if (record.eruptTime >= 0) continue;
      if (record.cluster && !includeCluster) continue;
      const r = invert ? 1 - record.radial : record.radial;
      if (!record.cluster && r > limit) continue;
      record.eruptTime = now + record.stagger * stagger;
    }
  }

  /** Erupt the lot. */
  triggerAll(now, stagger) {
    for (let i = 0; i < this._count; i++) {
      const record = this.records[i];
      if (record.eruptTime >= 0) continue;
      record.eruptTime = now + record.stagger * stagger;
    }
  }

  /** Erupt one instance by index, `delay` seconds from now. */
  triggerIndex(now, index, delay = 0) {
    if (index < 0 || index >= this._count) return;
    const record = this.records[index];
    if (record.eruptTime >= 0) return;
    record.eruptTime = now + delay;
  }

  /** Whether every planted instance has been released. */
  get isFullyTriggered() {
    for (let i = 0; i < this._count; i++) if (this.records[i].eruptTime < 0) return false;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Resolving — every metre, radian and second comes from here          */
  /* ------------------------------------------------------------------ */

  /** The curve parameter an instance is sampled at: 0 at the caster, 1 at the far end. */
  _curveT(record, p) {
    if ((p.layout ?? GrowthLayout.LINE) === GrowthLayout.ZONE) return record.radial;
    if (record.cluster) return 1;
    return Math.pow(saturate(record.along), p.frontBias ?? 1);
  }

  /** Half-width of the LINE band at `t`, metres. */
  _halfWidth(t, p) {
    return lerp(p.widthNear ?? 0.5, p.width ?? 2.5, Math.pow(saturate(t), p.widthCurve ?? 1));
  }

  /** Signed lateral offset, as a fraction of the local half-width. */
  _lateralNorm(record, p) {
    const raw = record.lateral;
    const clumping = p.clumping ?? 1;
    const clumped = Math.sign(raw) * Math.pow(Math.abs(raw), clumping);
    return clumped + record.scatter * (p.scatter ?? 0);
  }

  /** How far off the spine an instance sits, 0 on the axis, 1 at the edge. */
  _edgeNorm(record, p) {
    if ((p.layout ?? GrowthLayout.LINE) === GrowthLayout.ZONE) return saturate(Math.abs(record.lateral));
    if (record.cluster) return record.radial;
    return saturate(Math.abs(this._lateralNorm(record, p)));
  }

  /** The centre of a ZONE / of the terminal cluster, live. */
  _anchor(p, out) {
    if (p.centre) return out.copy(p.centre);
    const origin = p.origin ?? _zero;
    const direction = p.direction ?? _forward;
    return out.copy(origin).addScaledVector(direction, p.length ?? 0);
  }

  /** Where an instance stands right now, at the live footprint. Writes `out`. */
  _position(record, p, out) {
    const layout = p.layout ?? GrowthLayout.LINE;
    const side = p.side ?? _right;

    if (layout === GrowthLayout.ZONE) {
      const outer = p.radius ?? 4;
      const inner = Math.min(outer, p.innerRadius ?? 0);
      const angle = (record.angle + record.scatter * ((p.angleJitter ?? 0) / TAU)) * TAU;
      let r;
      if (record.cluster) {
        // The core group lives inside the ring, never on it.
        r = inner * record.radial;
      } else {
        r = lerp(inner, outer, Math.pow(saturate(record.radial), p.radialCurve ?? 1));
        r += record.lateral * (p.radialJitter ?? 0);
      }
      this._anchor(p, out);
      out.x += Math.cos(angle) * r;
      out.z += Math.sin(angle) * r;
      return out;
    }

    if (record.cluster) {
      const authored = p.clusterRadius ?? -1;
      const reach = (authored >= 0 ? authored : this._halfWidth(1, p) * 1.25) * record.radial;
      const angle = record.angle * TAU;
      this._anchor(p, out);
      out.x += Math.cos(angle) * reach;
      out.z += Math.sin(angle) * reach;
      return out;
    }

    const t = this._curveT(record, p);
    const origin = p.origin ?? _zero;
    const direction = p.direction ?? _forward;
    out.copy(origin).addScaledVector(direction, t * (p.length ?? 0));
    return out.addScaledVector(side, this._lateralNorm(record, p) * this._halfWidth(t, p));
  }

  /** Full height of an instance, metres. */
  _height(record, p) {
    const t = this._curveT(record, p);
    const jitter = p.randomness ?? 1;

    let h = lerp(p.heightNear ?? 0.5, p.height ?? 3, Math.pow(saturate(t), p.heightCurve ?? 1));

    // The swell at the far end.
    const peak = p.peak ?? 1;
    if (peak !== 1) h *= 1 + (peak - 1) * smoothstep(1 - (p.peakWidth ?? 0.25), 1, t);

    // Domed silhouette: the instances on the flanks are shorter than the spine.
    const crown = saturate(p.crown ?? 0);
    if (crown > 0) h *= lerp(1, 1 - crown, Math.pow(this._edgeNorm(record, p), p.crownPower ?? 1.4));

    h *= 1 + record.heightRoll * (p.heightJitter ?? 0) * jitter;
    if (record.rubbleRoll < (p.rubble ?? 0)) h *= p.rubbleScale ?? 0.3;

    return Math.max(p.minHeight ?? 0.02, h);
  }

  /** Base radius of an instance, metres. */
  _radius(record, p) {
    const t = this._curveT(record, p);
    const near = p.radiusNear ?? 0.3;
    const far = (p.radius2 ?? -1) >= 0 ? p.radius2 : near;
    const jitter = 1 + record.radiusRoll * (p.radiusJitter ?? 0) * (p.randomness ?? 1);
    const grow = lerp(near, far, Math.pow(saturate(t), p.radiusCurve ?? 0.6));
    const spread = record.rubbleRoll < (p.rubble ?? 0) ? (p.rubbleSpread ?? 1.25) : 1;
    return Math.max(p.minRadius ?? 0.01, grow * jitter * spread);
  }

  /**
   * How far out of the ground an instance is: 0 → 1 with a springy overshoot
   * past 1. Negative while it is still buried and waiting.
   */
  _emergence(record, now, p) {
    if (record.eruptTime < 0) return -1;
    const elapsed = now - record.eruptTime;
    if (elapsed < 0) return -1;

    const riseTime = Math.max(0.02, p.riseTime ?? 0.18);
    const rise = Easing.outQuint(saturate(elapsed / riseTime));
    if (elapsed <= riseTime) return rise;

    // The punch-through carries past full height and settles back.
    const after = elapsed - riseTime;
    const spring =
      Math.sin(after * (p.springRate ?? 14)) * Math.exp(-after / Math.max(0.05, p.settle ?? 0.5));
    return 1 + (p.riseOvershoot ?? 0.25) * spring;
  }

  /* --- public read-back, for abilities that thread things between instances - */

  /** World position of instance `i` at the live settings. Thornwake links off this. */
  positionOf(index, p, out) {
    return this._position(this.records[index], p, out);
  }

  /** Metres. */
  heightOf(index, p) {
    return this._height(this.records[index], p);
  }

  /** Metres. */
  radiusOf(index, p) {
    return this._radius(this.records[index], p);
  }

  /** 0..1(+) emergence, or negative while buried. */
  emergenceOf(index, now, p) {
    return this._emergence(this.records[index], now, p);
  }

  /** World position of the tip of instance `i`, ignoring lean. */
  tipOf(index, p, out) {
    this._position(this.records[index], p, out);
    out.y += this._height(this.records[index], p);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Rebuild every instance matrix from the live params. Allocation-free.
   *
   * @param {number} now     the ability's `age`, seconds
   * @param {object} p       live params — see `growthParams()`
   * @param {number} [retract] 0..1, the whole field withdrawing into the floor
   */
  update(now, p, retract = 0) {
    const variants = this.variants;
    const used = this._used;
    used.fill(0);

    const emergeMode = p.emerge ?? GrowthEmerge.PUSH;
    const birthFade = Math.max(0.02, p.birthFade ?? 0.18);
    const jitter = p.randomness ?? 1;
    const layout = p.layout ?? GrowthLayout.LINE;
    const direction = p.direction ?? _forward;
    const side = p.side ?? _right;
    const sink = retract > 0 ? Easing.inCubic(saturate(retract)) : 0;

    for (let i = 0; i < this._count; i++) {
      const record = this.records[i];
      const variant = i % variants;
      const slot = (i / variants) | 0;
      const emerge = this._emergence(record, now, p);

      if (emerge < 0) {
        // Still buried. Park it out of the view rather than drawing a degenerate
        // matrix at the origin, which shows up as a speck on the floor.
        _dummy.position.set(0, -999, 0);
        _dummy.quaternion.identity();
        _dummy.scale.setScalar(0.0001);
        _dummy.updateMatrix();
        this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
        this.birthAttributes[variant].array[slot] = 0;
        used[variant] = Math.max(used[variant], slot + 1);
        continue;
      }

      const height = this._height(record, p);
      const radius = this._radius(record, p);

      /* --- the moment it breaks the surface --- */
      if (!record.breached && emerge > (p.breachAt ?? 0.25)) {
        record.breached = true;
        if (this.onBreach) {
          this._position(record, p, _breachPos);
          this.onBreach(i, _breachPos, radius, height);
        }
      }

      /* --- lean: away from the caster, and outward across the band --- */
      const outward =
        layout === GrowthLayout.ZONE || record.cluster
          ? record.radial
          : this._lateralNorm(record, p);

      if (layout === GrowthLayout.ZONE) {
        // Outward means radially outward from the centre, not sideways.
        const angle = record.angle * TAU;
        _lean
          .set(Math.cos(angle), 0, Math.sin(angle))
          .multiplyScalar((p.leanOutward ?? 0.85) * record.radial)
          .addScaledVector(direction, p.leanForward ?? 0);
      } else {
        _lean
          .copy(direction)
          .multiplyScalar(p.leanForward ?? 0.75)
          .addScaledVector(side, outward * (p.leanOutward ?? 0.85));
      }
      if (_lean.lengthSq() < 1e-6) _lean.copy(direction);
      _lean.normalize();

      const t = this._curveT(record, p);
      const leanRamp = p.leanRamp ?? 0.65;
      const leanAngle =
        (p.lean ?? 0) *
        lerp(1 - leanRamp, 1, t) *
        (1 + record.leanRoll * (p.leanJitter ?? 0) * jitter);

      // Rotating about (up × lean) tips the instance's own +Y toward `lean`.
      _axis.crossVectors(_up, _lean);
      if (_axis.lengthSq() < 1e-8) _axis.set(1, 0, 0);
      _axis.normalize();
      _tilt.setFromAxisAngle(_axis, leanAngle);

      const tilt = p.tilt ?? 0;
      if (tilt !== 0) {
        // A second, bearing-random tip so a field never looks combed.
        const bearing = record.tiltBearing * TAU;
        _axis.set(Math.cos(bearing), 0, Math.sin(bearing));
        _spin.setFromAxisAngle(_axis, tilt * record.tiltRoll * jitter);
        _tilt.multiply(_spin);
      }

      _spin.setFromAxisAngle(_up, record.yaw * TAU * (p.twist ?? 1));
      _tilt.multiply(_spin);

      /* --- slide it up out of the floor (or scale it up in place) --- */
      const settled = Math.min(1, emerge);
      this._position(record, p, _dummy.position);
      _dummy.position.y += (p.baseHeight ?? 0) * (1 + record.baseRoll * (p.baseJitter ?? 0) * jitter);

      let scale = lerp(p.birthScale ?? 0.86, 1, settled);
      if (emergeMode === GrowthEmerge.PUSH) {
        _dummy.position.y += (emerge - 1) * height * (p.emergeSink ?? 0.85);
      } else {
        // Accretion: nothing is buried, the body simply arrives.
        scale *= Math.max(0.0001, emerge);
      }

      if (sink > 0) _dummy.position.y -= sink * (height + radius + (p.sinkDepth ?? 0.4));

      _dummy.quaternion.copy(_tilt);
      _dummy.scale.set(radius, height, radius).multiplyScalar(scale);
      _dummy.updateMatrix();

      this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
      this.birthAttributes[variant].array[slot] = saturate(1 - (now - record.eruptTime) / birthFade);
      used[variant] = Math.max(used[variant], slot + 1);
    }

    for (let v = 0; v < variants; v++) {
      this.meshes[v].count = used[v];
      this.meshes[v].instanceMatrix.needsUpdate = true;
      this.birthAttributes[v].needsUpdate = true;
    }
  }

  /** Geometry and meshes. The material belongs to the ability — not touched. */
  dispose() {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
      mesh.parent?.remove(mesh);
    }
    this.meshes.length = 0;
    this.onBreach = null;
  }
}

/* ---------------------------------------------------------------------- */
/* Material helper                                                         */
/* ---------------------------------------------------------------------- */

/**
 * Spellbreak's disruption, applied to a shaded PBR fragment.
 *
 * Three shared modules already opted into `vfx/SceneHooks.js`'s published
 * region — `FilamentPaths`, `GroundField` and `Swarm` — and between them they
 * cover every bolt, every ground mark and every flock. They do not cover a
 * single thing that is *standing in the zone as an object*, which is most of
 * what a player has on the floor when they reach for a dispel: a lance, a
 * thorn wall, a spine of heaved stone. So this is the fourth opt-in, and it is
 * the one that made the ability read.
 *
 * It is not the three-line fragment call the other three use, for one reason:
 * they all draw with a blend, so erasing a shard cell is `alpha *= 0` and the
 * cell is gone. A growth material is **opaque** — the alpha channel of an
 * opaque fragment is written and then ignored — so zeroing it changes nothing
 * at all. The first version did exactly that and a crystal field inside a
 * Spellbreak went grey and stayed whole, which reads as a lighting change and
 * not as an effect being torn up. The `discard` is what actually breaks the
 * silhouette, and it is gated on the shade call having zeroed the alpha rather
 * than on a threshold, so a genuinely transparent growth material (petals) is
 * eroded on the same cells and not simply erased.
 *
 * The emissive is drained on the same field and with the same cells. Draining
 * albedo alone leaves a crystal that is grey and *still glowing through the
 * holes it is being erased in*, which looks like a z-fighting bug.
 */
const GROWTH_DISRUPT = /* glsl */ `
  float growDisrupt = disruptAt(vGrowWorld);
  if (growDisrupt > 0.0) {
    // Whole locals rather than swizzles for the inout arguments. A
    // non-repeating swizzle is a legal l-value and three of the drivers this
    // has been read on accept it; the fourth is not worth finding out about
    // for the sake of two lines.
    vec3  growAlbedo = diffuseColor.rgb;
    float growKeep = diffuseColor.a;
    disruptShade(growAlbedo, growKeep, growDisrupt, gl_FragCoord.xy);
    float growEmissiveKeep = 1.0;
    disruptShade(totalEmissiveRadiance, growEmissiveKeep, growDisrupt, gl_FragCoord.xy);
    if (growKeep < diffuseColor.a * 0.5) discard;
    diffuseColor.rgb = growAlbedo;
    diffuseColor.a = growKeep;
  }
`;

/**
 * Wire a `MeshStandardMaterial` up to the two per-instance attributes a
 * GrowthField writes, and inject the ability's own shading on top.
 *
 * This is `materials/IceMaterial.js`'s patch reduced to its skeleton. Building
 * on a standard material rather than a raw `ShaderMaterial` is deliberate and it
 * is the reason the crystals sit in the stage at all: they take the real
 * shadows, the real lights and the HDR probe, and the stylisation is injected
 * after `<emissivemap_fragment>`, where the normal has been resolved (with
 * `flatShading` there is no `vNormal` varying, so any view-dependent term *must*
 * go after that include and read `normal`).
 *
 * Available to the injected fragment code:
 *
 * | varying | meaning |
 * | --- | --- |
 * | `vGrowLocal` | unit-space position — `.y` is 0 at the base, 1 at the tip |
 * | `vGrowWorld` | world position, for detail that must keep a fixed physical size |
 * | `vGrowSeed`  | per-instance seed, 0..10 |
 * | `vGrowBirth` | per-instance birth flash, 1 → 0 over `birthFade` |
 *
 * The two spaces are not interchangeable and picking the wrong one is the usual
 * bug: cracks and grain belong in **world** space so neighbouring instances look
 * quarried from the same block, while anything that runs base-to-tip belongs in
 * **local** space so it follows each instance's own axis however it is scaled.
 *
 * @param {THREE.MeshStandardMaterial} material
 * @param {object} [options]
 * @param {object} [options.environment] `world/Environment.js` — routes through
 *        `registerShadowCasterWithPatch` so CSM's patch is not clobbered
 * @param {object} [options.uniforms]    merged into the compiled shader
 * @param {string} [options.common]      fragment-stage declarations (noise libs, uniforms)
 * @param {string} [options.vertex]      GLSL appended after `<begin_vertex>`
 * @param {string} [options.fragment]    GLSL appended after `<emissivemap_fragment>`
 * @returns {THREE.MeshStandardMaterial} the same material
 */
export function patchGrowthMaterial(material, options = {}) {
  const { environment = null, uniforms = null, common = '', vertex = '', fragment = '' } = options;

  const patch = (shader) => {
    if (uniforms) Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = replaceChunk(
      shader.vertexShader,
      '#include <common>',
      `#include <common>
       attribute float aSeed;
       attribute float aBirth;
       varying vec3  vGrowLocal;
       varying vec3  vGrowWorld;
       varying float vGrowSeed;
       varying float vGrowBirth;`
    );

    shader.vertexShader = replaceChunk(
      shader.vertexShader,
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vGrowLocal = transformed;
       vGrowSeed  = aSeed;
       vGrowBirth = aBirth;
       #ifdef USE_INSTANCING
         vGrowWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
       #else
         vGrowWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
       #endif
       ${vertex}`
    );

    shader.fragmentShader = replaceChunk(
      shader.fragmentShader,
      '#include <common>',
      `#include <common>
       varying vec3  vGrowLocal;
       varying vec3  vGrowWorld;
       varying float vGrowSeed;
       varying float vGrowBirth;
       ${disruptGLSL}
       ${common}`
    );

    // Always injected, even with no `fragment` snippet, because the disruption
    // block below has to land somewhere. Sampling it per *fragment* rather than
    // per vertex — the opposite of what `FilamentPaths` and `Tube` do — is the
    // one place the cheap route is wrong: a growth instance is a handful of
    // large facets, so a per-vertex sample of a field measured in metres is
    // interpolated across half a spike and the erosion front crosses the field
    // boundary as a smooth gradient instead of as an edge. `vGrowWorld` is
    // already there for the ability's own grain, so this costs one distance.
    shader.fragmentShader = replaceChunk(
      shader.fragmentShader,
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       {
         ${fragment}
       }
       {
         ${GROWTH_DISRUPT}
       }`
    );
  };

  if (environment) environment.registerShadowCasterWithPatch(material, patch);
  else patchOnBeforeCompile(material, patch);

  // I8 — where the harness's pause probe and anyone debugging why a standing
  // field will not break up look for the live boxes. Merged rather than
  // assigned, so a material that parked its own block first keeps it. A
  // material that parks *afterwards* with a plain assignment (which is what all
  // eleven of them do) drops these again, and that is fine: nothing reads them
  // from here, they are here to be seen.
  material.userData = material.userData ?? {};
  material.userData.uniforms = Object.assign(material.userData.uniforms ?? {}, disruptUniforms());

  return material;
}
