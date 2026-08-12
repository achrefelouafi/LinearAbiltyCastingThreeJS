import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { createBrineIceMaterial } from '../../materials/BrineIceMaterial.js';
import { LiquidSurface, LiquidMode, liquidParams } from '../../vfx/LiquidSurface.js';
import { GrowthField, GrowthLayout, GrowthEmerge } from '../../vfx/GrowthField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, hash11, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;

/**
 * Crowns held at once. This is **not** an arbitrary number: it is
 * `RIPPLE_SLOTS` in `vfx/LiquidSurface.js`, and the two move together or the
 * ability is writing off the end of the module's uniform array.
 */
const CROWN_SLOTS = 8;
/** Hard ceiling on fingers of ice. The editor's `blades` slider clamps here. */
const MAX_BLADES = 216;
/** Distinct finger silhouettes — one `InstancedMesh` each, so one draw call each. */
const BLADE_VARIANTS = 3;
/**
 * Grid resolution of the lane. Below about 64 the Gerstner cusps facet on a
 * sheet this long and thin; above about 160 the vertex cost buys detail the
 * shading normal already carries, because the normal is four evaluations of the
 * whole heightfield rather than a difference of neighbouring vertices.
 */
const LANE_SEGMENTS = 128;

/* --- module-scope scratch: the frame allocates nothing (I3) --- */
const _liq = liquidParams();
/* The three lava terms the module ships on by default. Brine has no skin, is
   not self-lit, and has no glowing seams; set once, here, rather than burned as
   sliders nobody would ever move off zero. */
_liq.crust = 0;
_liq.emissive = 0;
_liq.seamGlow = 0;
_liq.meltGlow = 0;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _rel = new Vector3();
const _par = new Vector3(); //  parametric position on the sheet: (x, 0, z) metres
const _up = new Vector3(0, 1, 0);

/* ---------------------------------------------------------------------- */
/* One finger of a splash crown                                            */
/* ---------------------------------------------------------------------- */

/**
 * A compact-support lobe — 1 at `at`, 0 outside `at ± w`, smooth at the join.
 *
 * A gaussian was the first thing tried and it is subtly wrong here: it never
 * reaches zero, so a bead authored near the top of the finger leaves a
 * millimetre of radius at `v = 1` and the tip is a flat disc rather than a
 * point. This closes, exactly, which is what lets the profile end in a needle
 * without a special case at the last ring.
 */
function lobe(v, at, w) {
  const x = (v - at) / Math.max(w, 1e-3);
  const k = 1 - x * x;
  return k <= 0 ? 0 : k * Math.sqrt(k);
}

/**
 * Unit-space geometry for one frozen splash finger.
 *
 * The contract `GrowthField` imposes: footprint inside a circle of radius 0.5
 * on `y = 0`, tip at `y = 1`. An instance then scales footprint and height
 * independently and `vGrowLocal.y` reads off in the fragment shader as "how far
 * up this finger am I", which is what the aeration gradient keys off.
 *
 * The silhouette is a **Worthington finger**: a tapering stalk, necked in just
 * below the top, carrying the bead of water it was about to shed. That bead is
 * the whole reason this reads as a splash rather than as a spike — a plain cone
 * is a stalagmite and a plain cone is what the first version drew.
 *
 * @param {number} variant 0..2 — three different histories of the same finger
 * @param {object} shape   live numbers from `settings.brinelock`
 */
function createCrownFingerGeometry(variant, shape) {
  const facets = clamp(Math.round(shape.facets), 4, 24);
  const rings = clamp(Math.round(shape.rings), 3, 32);
  const taper = Math.max(0.05, shape.taper);
  const waist = saturate(shape.waist);
  const twist = shape.shapeTwist;
  const jitter = Math.max(0, shape.facetJitter);
  const width = clamp(shape.beadWidth, 0.03, 0.45);

  /* The three histories.
     0 — one bead, still attached: the common case.
     1 — already pinched once, so a big bead under a small one.
     2 — the bead has gone; a blunt, waisted stub left behind. */
  let beadA = clamp(shape.beadAt, 0.2, 1 - width);
  let sizeA = Math.max(0, shape.bead);
  let beadB = 0;
  let sizeB = 0;
  let stalk = taper;
  let neck = waist;
  if (variant === 1) {
    beadA = clamp(shape.beadAt * 0.74, 0.2, 1 - width);
    sizeA *= 0.82;
    beadB = clamp(shape.beadAt * 1.16, beadA + width * 0.6, 1 - width * 0.65);
    sizeB = sizeA * 0.5;
  } else if (variant === 2) {
    sizeA *= 0.14;
    stalk = taper * 0.72;
    neck = Math.min(0.85, waist * 1.5);
  }

  // Everything is authored against a unit base radius and then divided by the
  // worst case of the facet jitter, so the footprint is exactly 0.5 whatever
  // the jitter slider is doing.
  const scale = 0.5 / (1 + jitter);

  const levels = rings + 1;
  const positions = new Float32Array(levels * facets * 3);
  const indices = [];

  let write = 0;
  for (let i = 0; i < levels; i++) {
    const v = i / rings;

    let r = Math.pow(Math.max(0, 1 - v), stalk);
    // The neck. A finger is thinnest just under the drop it is shedding, and
    // that pinch is the single most recognisable thing about the silhouette.
    const pinch = lobe(v, beadA * 0.6, 0.34);
    r *= 1 - neck * pinch;
    r += sizeA * lobe(v, beadA, width);
    if (sizeB > 0) r += sizeB * lobe(v, beadB, width * 0.65);
    // Never exactly zero: a degenerate last ring gives `computeVertexNormals`
    // two zero-area triangles per facet to normalise and the tip goes to NaN.
    r = Math.max(r, 0.006);

    const spin = twist * v * TAU;
    for (let f = 0; f < facets; f++) {
      const theta = (f / facets) * TAU + spin;
      // Deterministic per (variant, facet, level band) so the finger is
      // irregular but does not shimmer when the geometry is rebuilt.
      const wobble = 1 + (hash11(variant * 91.7 + f * 13.3 + Math.floor(v * 3) * 5.1) - 0.5) * 2 * jitter;
      const rr = r * wobble * scale;
      positions[write++] = Math.cos(theta) * rr;
      positions[write++] = v;
      positions[write++] = Math.sin(theta) * rr;
    }
  }

  for (let i = 0; i < rings; i++) {
    for (let f = 0; f < facets; f++) {
      const next = (f + 1) % facets;
      // Named for their corners rather than a/b/c/d: `c` is bound to
      // `settings.brinelock` everywhere else in this file, and the static
      // settings cross-check in `scripts/check.mjs` drops an alias that is ever
      // bound to something else — one index variable here would blind it to the
      // whole file.
      const lowNear = i * facets + f;
      const lowFar = i * facets + next;
      const highNear = (i + 1) * facets + f;
      const highFar = (i + 1) * facets + next;
      indices.push(lowNear, highNear, lowFar, lowFar, highNear, highFar);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * BRINELOCK — a lane of brine thrown up in splash crowns, and stopped.
 *
 * Four beats. A splash front runs down the aimed line at `speed`, punching a
 * crown into the brine every `crownSpacing` metres. It lands, throws the big
 * one, and the lane rings for `lockDelay` seconds. Then the water goes glassy
 * still, and **locks**: a glaze front sweeps the lane over `glazeTime` and every
 * crown in it stops mid-air as glass-clear ice. It stands for the rest of
 * `lifetime` and melts back over `fadeTime`.
 *
 * **THE TRICK — the ice is the water, evaluated at the frame it stopped.**
 *
 * A crown here is not a mesh and not a particle burst. It is one analytic wave
 * packet in `vfx/LiquidSurface.js` — a gaussian-enveloped cosine riding out at
 * `rippleSpeed`, decaying as `e^{−age/rippleDecay}` and thinning as
 * `1/(1 + r/rippleSpread)` — and its whole history is a closed-form function of
 * its own age. Which means the height of the water at any point of the lane, at
 * any moment, is a number this file can *ask for* rather than remember.
 *
 * So the handover is: freeze the water's clock at `_lockAt`, and give every
 * finger of ice the height the water has at that finger's own footprint on that
 * frozen frame. `_surfaceAt()` is a line-for-line mirror of `ripplesAt()` in
 * `LIQUID_FIELD`, reading the *same* `uRipples` array the shader reads, so the
 * two cannot disagree about where the crest is. A finger standing on a ring
 * wall is tall; one standing in the trough behind it is `iceFloor` and
 * invisible. The frozen lane is therefore not a row of spikes — it is the
 * *record* of a splash, with tight rings at the far end where the crowns are
 * young and broad transverse bars near the caster where they have spread.
 *
 * Three consequences worth stating, because each one was a bug first:
 *
 * **1 — the height is re-derived every frame, not captured.** `GrowthField`
 * resolves an instance's height as `lerp(heightNear, height, …) × (1 +
 * heightRoll × heightJitter × randomness)`, and `heightRoll` is documented as a
 * unitless dice roll. Here it is not a dice roll: `heightNear`, `height` and
 * `heightJitter` are pinned to 1 and the roll is rewritten every frame as
 * `waterHeight × iceGain − 1`, so the field's own resolver hands back exactly
 * the sampled metres. Nothing dimensional survives a frame boundary, and
 * dragging `rippleAmp` or `rippleWidth` with the clock stopped **re-carves a
 * standing sheet of ice**. That is the observable proof the handover is real
 * rather than a look-alike.
 *
 * **2 — `randomness` is pinned to 1 in the growth params, and the jitters carry
 * the global multiplier themselves.** They are the same number in the module's
 * resolver, so `settings.global.randomness` would otherwise scale the *water's
 * silhouette* along with the lean and the radius scatter. A global slider is
 * not allowed to change what the water did.
 *
 * **3 — the lane is drawn at full length from the first frame, and this ability
 * owns the ripple ring buffer.** `LiquidSurface.ripple()` stores a fraction of
 * the *sheet*, which is exactly right for a pool of fixed size and exactly
 * wrong here: growing the sheet behind the travelling front would slide every
 * standing crown downrange as it grew, a metre a frame, and it looks like the
 * whole lane is sliding away from you. The eight records here are fractions of
 * the **cast** — `along` down the line, `across` the lane — plus a timestamp
 * and a strength, and they are converted against this frame's half-extents and
 * written straight into `uRipples` every frame. Same eight slots, same eviction
 * (oldest, never newest), one frame of indirection, and the crowns stay where
 * they were punched.
 *
 * **The one honest seam.** The swell rides `frame.uTime` and the ripples ride
 * the ability's own clock, so freezing the second does not freeze the first.
 * Rather than snap four sine waves off on the lock frame — a few centimetres of
 * pop across the whole lane, small but visible on the silhouette the ice is
 * about to claim — the swell and the chop are ramped to zero over `stillTime`
 * *before* the lock, and the brine goes glassy still first. It also reads
 * better: the lane stops moving, holds, and then goes hard.
 *
 * A cast captures a seed, four crown dice per crown, and two timestamps
 * (`_lockAt`, and the crowns' births). Everything with a unit is resolved from
 * `settings.brinelock` inside the update loop, zero-length frames included.
 *
 * **Four draw calls**: the lane, and three finger silhouettes.
 */
export class BrinelockAbility extends Ability {
  constructor(context) {
    super('brinelock', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the brine ---------------------------------------------------- */
    this.pool = new LiquidSurface({
      segments: LANE_SEGMENTS,
      mode: LiquidMode.POOL,
      // A heightfield is a solid: a crown must hide the lane behind it, or the
      // whole thing reads as a sheet of cellophane laid on the floor.
      depthWrite: true,
      doubleSide: true,
      renderOrder: 3,
      name: 'brinelock.lane'
    });
    this.pool.object3D.layers.set(LAYER.VFX);
    this.group.add(this.pool.object3D);

    /* --- the ice ------------------------------------------------------ */
    this.iceMaterial = createBrineIceMaterial(this.ctx.environment);

    /**
     * Live shape controls handed to the geometry factory. Mutated in place — an
     * object literal per frame is the allocation I3 forbids — and compared
     * numerically by `syncGeometry`, which rebuilds only when one of them moved.
     */
    this._shape = {
      facets: 9,
      rings: 13,
      taper: 1.35,
      waist: 0.34,
      bead: 0.38,
      beadAt: 0.82,
      beadWidth: 0.15,
      shapeTwist: 0.22,
      facetJitter: 0.16
    };
    this._fillShape();

    this.ice = new GrowthField(this.group, {
      geometry: createCrownFingerGeometry,
      material: this.iceMaterial,
      shape: this._shape,
      variants: BLADE_VARIANTS,
      capacity: MAX_BLADES,
      layer: LAYER.WORLD,
      renderOrder: 2,
      // Ice this clear casting a hard opaque shadow of a needle reads as a
      // black hair on the floor. It takes the stage's shadows; it does not
      // throw one.
      castShadow: false,
      receiveShadow: true
    });
    // Assigned once, at construction: a closure rebuilt per instance per frame
    // is exactly the allocation I3 forbids.
    this.ice.onBreach = (index, position, radius, height) => this._frostFx(position, radius, height);

    /**
     * The crown ring buffer this ability owns. Four numbers per crown, three of
     * them unitless and one a timestamp — see the class comment for why these
     * are fractions of the *cast* and not of the sheet.
     */
    this._crowns = [];
    for (let i = 0; i < CROWN_SLOTS; i++) {
      this._crowns.push({ along: 0, across: 0, born: -1, strength: 0 });
    }
    /** Parametric centre of every crown on the sheet, (x, z) pairs, metres. */
    this._crownParam = new Float32Array(CROWN_SLOTS * 2);
    this._nextCrown = 0;

    /* --- scratch parameter block, refilled from settings every frame --- */
    this._growth = {
      layout: GrowthLayout.LINE,
      // Ice does not push out of the floor: it arrives where the water already
      // was. PUSH would bury every finger below the lane and slide it up.
      emerge: GrowthEmerge.SCALE,
      origin: new Vector3(),
      direction: new Vector3(0, 0, 1),
      side: new Vector3(1, 0, 0),
      length: 1,
      // Pinned. See consequence 1 in the class comment: the height ramp is
      // neutral so `heightRoll` alone carries the sampled water height.
      heightNear: 1,
      height: 1,
      heightCurve: 1,
      heightJitter: 1,
      crown: 0,
      peak: 1,
      rubble: 0,
      randomness: 1
    };

    /** Re-rolled per cast so two lanes do not freeze in the same pattern. */
    this._seed = 0;
    /** `this.age` at the moment the brine locked, or −1. A timestamp. */
    this._lockAt = -1;
    /** One-shot latch on the lock. */
    this._locked = false;
    /** Fraction of the lane already paid out in crowns. Unitless. */
    this._crownAt = 0;
    /** Fingers drawn last frame, for the HUD's instance readout. */
    this._live = 0;
    /** The frozen water clock, resolved once per frame in `_sync`. */
    this._waterNow = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The brine in the air while the lane is live. Additive and soft: this is
    // spray lit from every side, not grit.
    this.spray = particles.get('brinelock.spray', {
      capacity: 3000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.3
    });
    this.spray.uniforms.uDrag.value = 1.5;
    this.spray.uniforms.uEndSize.value = 0.3;
    this.spray.uniforms.uSizeIn.value = 0.05;
    this.spray.uniforms.uFadeIn.value = 0.05;
    this.spray.uniforms.uFadeOut.value = 0.45;

    // What comes off a finger the instant it locks. Slow, rising, and it hangs
    // — the cold coming out of the water, not the water itself.
    this.frost = particles.get('brinelock.frost', {
      capacity: 2200,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.5
    });
    this.frost.uniforms.uDrag.value = 2.2;
    this.frost.uniforms.uEndSize.value = 0.5;
    this.frost.uniforms.uSizeIn.value = 0.08;
    this.frost.uniforms.uFadeIn.value = 0.14;
    this.frost.uniforms.uFadeOut.value = 0.5;

    // Chips off the melting ice. Lit and non-additive, so they read as solid
    // against the glow — the contrast is what says "this was a solid".
    this.shards = particles.get('brinelock.shards', {
      capacity: 1400,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.shards.uniforms.uDrag.value = 0.4;
    this.shards.uniforms.uEndSize.value = 0.55;
    this.shards.uniforms.uFadeOut.value = 0.6;

    this.sprayEmitter = new RateEmitter();
    this.shardEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._live;
  }

  /** The lane rings, locks, and stands — all inside the impact phase. */
  get impactDuration() {
    return Math.max(0.1, settings.brinelock.lifetime * settings.global.lifetime);
  }

  /** The melt. */
  get fadeDuration() {
    return Math.max(0.1, settings.brinelock.fadeTime);
  }

  /* ------------------------------------------------------------------ */
  /* The beats                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Seconds since the lock beat should have started.
   *
   * Measured across the phase boundary rather than off `impactTime` alone,
   * because `lockDelay` is a slider and nothing stops it being dragged past
   * `lifetime` — at which point `impactTime` has already stopped accumulating
   * and the lane would ring for ever.
   */
  _lockElapsed() {
    if (this.phase === AbilityPhase.TRAVEL) return -1;
    if (this.phase === AbilityPhase.IMPACT) return this.impactTime;
    return this.impactDuration + this.fadeTime;
  }

  /** 0..1 — how far the swell has died on its way to the lock. */
  _still() {
    if (this._locked) return 1;
    const c = settings.brinelock;
    const window = Math.max(0.02, c.stillTime);
    return saturate((this._lockElapsed() - (c.lockDelay - window)) / window);
  }

  /** 0..1 — how far the water has handed over to the ice. */
  _handover() {
    if (!this._locked) return 0;
    return saturate((this.age - this._lockAt) / Math.max(0.02, settings.brinelock.waterFade));
  }

  /** 0..1 — the glaze front, sweeping the lane from the caster outward. */
  _glaze() {
    if (!this._locked) return 0;
    return saturate((this.age - this._lockAt) / Math.max(0.02, settings.brinelock.glazeTime));
  }

  /** 0..1 — how far the ice has melted back into the lane. */
  _melt() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    return saturate(this.fadeTime / this.fadeDuration);
  }

  /* ------------------------------------------------------------------ */
  /* The crowns — the ring buffer this ability owns                      */
  /* ------------------------------------------------------------------ */

  /**
   * Take a slot for a new crown: a free one, else the oldest.
   *
   * The same policy `LiquidSurface` uses, and for the same reason — the newest
   * crown is the one the player is looking at, so it is never the one dropped.
   */
  _takeSlot() {
    let best = 0;
    let bestAge = -1;
    for (let i = 0; i < CROWN_SLOTS; i++) {
      const record = this._crowns[i];
      if (record.strength <= 0) return i;
      const age = this.age - record.born;
      if (age > bestAge) {
        bestAge = age;
        best = i;
      }
    }
    const slot = this._nextCrown;
    this._nextCrown = (this._nextCrown + 1) % CROWN_SLOTS;
    return bestAge > 0 ? best : slot;
  }

  /** @param {number} along 0..1 down the cast @param {number} across −1..1 */
  _pushCrown(along, across, strength) {
    const record = this._crowns[this._takeSlot()];
    record.along = along;
    record.across = across;
    record.born = this.age;
    record.strength = Math.max(0, strength);
    return record;
  }

  /** Where a crown was punched, in world metres. Live — nothing is stored. */
  _crownWorld(record, out) {
    const c = settings.brinelock;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, record.along * this.length)
      .addScaledVector(this.side, record.across * c.laneWidth);
    out.y = c.poolHeight;
    return out;
  }

  /** A world point in the sheet's own parametric frame: (x, 0, z), metres. */
  _paramOf(point, out) {
    const u = this.pool.uniforms;
    _rel.copy(point).sub(u.uAnchor.value);
    return out.set(_rel.dot(u.uAxisX.value), 0, _rel.dot(u.uAxisZ.value));
  }

  /**
   * Convert every crown into this frame's sheet fractions and write them
   * straight into the module's uniform array.
   *
   * Called after `pool.update()`, which is where the live half-extents come
   * from — the same ordering rule `rippleAtWorld()` documents, for the same
   * reason. The parametric centres are cached into `_crownParam` on the way
   * past because `_surfaceAt()` is about to ask for them a hundred and sixty
   * times.
   */
  _writeCrowns(halfX, halfZ) {
    const slots = this.pool.uniforms.uRipples.value;
    for (let i = 0; i < CROWN_SLOTS; i++) {
      const record = this._crowns[i];
      if (record.strength <= 0) {
        slots[i].set(0, 0, 0, 0);
        this._crownParam[i * 2] = 0;
        this._crownParam[i * 2 + 1] = 0;
        continue;
      }
      this._crownWorld(record, _pos);
      this._paramOf(_pos, _par);
      this._crownParam[i * 2] = _par.x;
      this._crownParam[i * 2 + 1] = _par.z;
      slots[i].set(_par.x / halfX, _par.z / halfZ, record.born, record.strength);
    }
  }

  /**
   * The height of the brine above its mean plane at a world point, metres.
   *
   * **A line-for-line mirror of `ripplesAt()` in `LIQUID_FIELD`.** If one of
   * them changes the other must, and the pair is called out in both files. It
   * reads the crown records this ability owns and the same six live sliders the
   * shader is handed, at the same frozen clock, so the ice cannot land anywhere
   * the water was not.
   *
   * The swell, the chop and the fragment-only detail octave are deliberately
   * *not* mirrored — by the lock they are all zero (see `stillTime`), and
   * mirroring an fbm on the CPU is not a mirror, it is a second implementation
   * that would drift the first time either side was tuned.
   */
  _surfaceAt(point) {
    const c = settings.brinelock;
    this._paramOf(point, _par);
    const px = _par.x;
    const pz = _par.z;

    const speed = c.rippleSpeed;
    const width = Math.max(c.rippleWidth * c.rippleWidth, 1e-4);
    const decayTime = Math.max(c.rippleDecay, 0.02);
    const spread = Math.max(c.rippleSpread, 0.05);
    const wavelength = TAU / Math.max(c.rippleLength, 0.05);

    let sum = 0;
    for (let i = 0; i < CROWN_SLOTS; i++) {
      const record = this._crowns[i];
      if (record.strength <= 0) continue;
      const age = this._waterNow - record.born;
      if (age < 0) continue;
      const dx = px - this._crownParam[i * 2];
      const dz = pz - this._crownParam[i * 2 + 1];
      const d = Math.sqrt(dx * dx + dz * dz);
      const x = d - age * speed;
      const env = Math.exp(-(x * x) / width);
      const decay = Math.exp(-age / decayTime) / (1 + d / spread);
      sum += record.strength * c.rippleAmp * env * decay * Math.cos(x * wavelength);
    }
    return sum;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.brinelock;

    this.sprayEmitter.reset();
    this.shardEmitter.reset();

    this._seed = Math.random() * 100;
    this._lockAt = -1;
    this._locked = false;
    this._crownAt = 0;
    this._live = 0;
    this._waterNow = 0;
    this._nextCrown = 0;
    for (const record of this._crowns) {
      record.along = 0;
      record.across = 0;
      record.born = -1;
      record.strength = 0;
    }

    this.pool.reset();
    this.pool.visible = true;

    this.ice.clear();
    // The dice are rolled once, here, and never again: the fingers stand where
    // the cast put them and only their *heights* answer to the water.
    this.ice.plant(Math.max(1, Math.min(MAX_BLADES, Math.round(c.blades))));

    // The lane starts with one crown at the caster's feet, so the very first
    // frame already has water in the air rather than a flat sheet.
    this._pushCrown(0, 0, c.crownStrength * 0.7);

    this._sync();
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /** Copy the live shape sliders into the factory's params. */
  _fillShape() {
    const c = settings.brinelock;
    const s = this._shape;
    s.facets = c.facets;
    s.rings = c.rings;
    s.taper = c.taper;
    s.waist = c.waist;
    s.bead = c.bead;
    s.beadAt = c.beadAt;
    s.beadWidth = c.beadWidth;
    s.shapeTwist = c.shapeTwist;
    s.facetJitter = c.facetJitter;
  }

  /**
   * Resolve the lane, the crowns and the ice from live settings.
   *
   * Every metre, radian and second below is read on the frame it is used,
   * including a zero-length one. The order is load-bearing: the sheet is
   * resolved first, then the crowns are converted against its half-extents,
   * then the ice samples the crowns.
   */
  _sync() {
    const c = settings.brinelock;
    const g = settings.global;

    const still = this._still();
    const handover = this._handover();
    const alive = 1 - still;

    // The water's clock stops at the lock; the ice keeps running on `this.age`.
    // Two clocks, and confusing them is the one mistake that breaks the trick:
    // freeze both and the fingers never emerge, freeze neither and the ice is
    // carved from a splash that has moved on.
    this._waterNow = this._locked ? this._lockAt : this.age;

    /* ---------------- the lane ---------------- */
    this.pointAt(0.5, _centre);
    _centre.y = c.poolHeight;
    this.pool.setPlacement(_centre, this.direction, _up);

    const halfX = Math.max(0.05, this.length * c.laneLength * 0.5);
    const halfZ = Math.max(0.05, c.laneWidth);

    _liq.sizeX = halfX * 2;
    _liq.sizeZ = halfZ * 2;
    _liq.fill = 1;
    _liq.round = c.round;
    _liq.edgeSoft = c.edgeSoft;
    _liq.edgeNoise = c.edgeNoise;
    _liq.edgeScale = c.edgeScale;
    _liq.seed = this._seed;
    _liq.opacity = lerp(c.poolOpacity, c.lockedOpacity, handover) * g.opacity;
    _liq.contactFade = c.contactFade;

    // The swell dies before the lock, not on it. See the class comment.
    _liq.waveAmpA = c.waveAmpA * alive;
    _liq.waveAmpB = c.waveAmpB * alive;
    _liq.waveAmpC = c.waveAmpC * alive;
    _liq.waveAmpD = c.waveAmpD * alive;
    _liq.waveLengthA = c.waveLengthA;
    _liq.waveLengthB = c.waveLengthB;
    _liq.waveLengthC = c.waveLengthC;
    _liq.waveLengthD = c.waveLengthD;
    _liq.waveSpeedA = c.waveSpeedA;
    _liq.waveSpeedB = c.waveSpeedB;
    _liq.waveSpeedC = c.waveSpeedC;
    _liq.waveSpeedD = c.waveSpeedD;
    _liq.waveAngleA = c.waveAngleA;
    _liq.waveAngleB = c.waveAngleB;
    _liq.waveAngleC = c.waveAngleC;
    _liq.waveAngleD = c.waveAngleD;
    _liq.steepness = c.steepness;

    _liq.chop = c.chop * alive;
    _liq.chopScale = c.chopScale * g.noiseFrequency;
    _liq.chopSpeed = c.chopSpeed * g.noiseSpeed;
    _liq.detail = c.detail * alive;
    _liq.detailScale = c.detailScale * g.noiseFrequency;
    _liq.detailSpeed = c.detailSpeed * g.noiseSpeed;

    // The crowns themselves are NOT faded by the lock — they are the shape the
    // ice is about to claim, and the water is taken away by its opacity alone.
    _liq.rippleAmp = c.rippleAmp;
    _liq.rippleSpeed = c.rippleSpeed;
    _liq.rippleLength = c.rippleLength;
    _liq.rippleWidth = c.rippleWidth;
    _liq.rippleDecay = c.rippleDecay;
    _liq.rippleSpread = c.rippleSpread;

    _liq.flowAngle = c.flowAngle;
    _liq.flowSpeed = c.flowSpeed * alive;
    _liq.flowRadial = c.flowRadial * alive;
    _liq.flowRadialFall = c.flowRadialFall;
    _liq.flowEddy = c.flowEddy * alive;
    _liq.flowEddyScale = c.flowEddyScale * g.noiseFrequency;
    _liq.flowEddySpeed = c.flowEddySpeed * g.noiseSpeed;
    _liq.flowGravity = c.flowGravity;

    _liq.foam = c.foam * (1 - handover);
    _liq.foamScale = c.foamScale * g.noiseFrequency;
    _liq.foamSharp = c.foamSharp;
    _liq.foamCrest = c.foamCrest;
    _liq.foamSpeed = c.foamSpeed;

    _liq.poolDepth = c.poolDepth;
    _liq.depthTint = c.depthTint;
    _liq.translucency = c.translucency;
    _liq.ambient = c.ambient;
    _liq.specular = c.specular;
    _liq.shininess = c.shininess;
    _liq.fresnel = c.fresnel * g.fresnel;
    _liq.envIntensity = c.envIntensity;
    _liq.skyIntensity = c.skyIntensity;
    _liq.glow = c.poolGlow * g.glow;
    _liq.normalEps = c.normalEps;

    _liq.colorDeep = c.colorDeep;
    _liq.colorShallow = c.colorShallow;
    _liq.colorFoam = c.colorFoam;
    _liq.colorSpec = c.colorSpec;
    _liq.colorSky = c.colorSky;

    this.pool.update(this._waterNow, _liq);
    this._writeCrowns(halfX, halfZ);
    this.pool.visible = _liq.opacity > 0.002;

    /* ---------------- the ice ---------------- */
    this._syncIce();

    /* ---------------- the particle systems ---------------- */
    this.spray.setGradient(
      getColor(c.colorSprayA),
      getColor(c.colorSprayB),
      getColor(c.colorSprayC),
      getColor(c.colorSprayD)
    );
    this.spray.uniforms.uGravity.value.set(0, c.sprayGravity, 0);
    this.spray.uniforms.uSizeScale.value = c.spraySize * g.particleSize * 7;
    this.spray.uniforms.uLifeScale.value = c.sprayLifetime * 0.5 * g.particleLifetime;
    this.spray.uniforms.uSpeedScale.value = g.particleSpeed;
    this.spray.uniforms.uOpacity.value = g.opacity;
    this.spray.uniforms.uGlow.value = c.poolGlow * 0.7 * g.glow;
    this.spray.uniforms.uTurbulence.value = c.sprayTurbulence * g.turbulence;

    this.frost.setGradient(
      getColor(c.colorFrostA),
      getColor(c.colorFrostB),
      getColor(c.colorFrostC),
      getColor(c.colorFrostD)
    );
    this.frost.uniforms.uGravity.value.set(0, c.frostRise, 0);
    this.frost.uniforms.uSizeScale.value = c.frostSize * g.particleSize * 7;
    this.frost.uniforms.uLifeScale.value = c.frostLifetime * 0.5 * g.particleLifetime;
    this.frost.uniforms.uSpeedScale.value = g.particleSpeed;
    this.frost.uniforms.uOpacity.value = g.opacity;
    this.frost.uniforms.uGlow.value = c.iceGlow * 0.8 * g.glow;
    this.frost.uniforms.uTurbulence.value = c.frostTurbulence * g.turbulence;

    this.shards.setGradient(
      getColor(c.colorShardA),
      getColor(c.colorShardB),
      getColor(c.colorShardC),
      getColor(c.colorShardD)
    );
    this.shards.uniforms.uGravity.value.set(0, c.shardGravity, 0);
    this.shards.uniforms.uSizeScale.value = c.shardSize * g.particleSize * 7;
    this.shards.uniforms.uLifeScale.value = c.shardLifetime * 0.5 * g.particleLifetime;
    this.shards.uniforms.uSpeedScale.value = g.particleSpeed;
    this.shards.uniforms.uOpacity.value = g.opacity;

    /* ---------------- the light, riding the lane ---------------- */
    this.pointAt(this.phase === AbilityPhase.TRAVEL ? this.u : 0.6, this.position);
    this.position.y = c.poolHeight + c.lightHeight;
  }

  /**
   * Re-resolve the field of ice, including the height every finger takes from
   * the water underneath it.
   */
  _syncIce() {
    const c = settings.brinelock;
    const g = settings.global;
    const p = this._growth;

    p.origin.copy(this.origin);
    p.direction.copy(this.direction);
    p.side.copy(this.side);
    p.length = this.length;

    p.widthNear = c.laneWidth * c.bladeSpreadNear;
    p.width = c.laneWidth * c.bladeSpread;
    p.widthCurve = 1;
    p.clumping = c.bladeClumping;
    p.frontBias = c.bladeFrontBias;
    // The global randomness multiplier is folded into the jitters here rather
    // than into `p.randomness`, because the module applies that same number to
    // `heightJitter` — and `heightJitter` is carrying the water's silhouette.
    p.scatter = c.bladeScatter * g.randomness;

    p.minHeight = c.iceFloor;
    p.radiusNear = c.bladeRadius;
    p.radius2 = c.bladeRadiusTip;
    p.radiusCurve = c.bladeRadiusCurve;
    p.radiusJitter = c.bladeRadiusJitter * g.randomness;
    p.minRadius = 0.004;

    p.lean = c.bladeLean;
    p.leanJitter = c.bladeLeanJitter * g.randomness;
    p.leanRamp = c.bladeLeanRamp;
    p.leanForward = c.bladeLeanForward;
    p.leanOutward = c.bladeLeanOutward;
    p.twist = c.bladeTwist;
    p.tilt = c.bladeTilt * g.randomness;

    p.baseHeight = c.poolHeight;
    p.baseJitter = 0;

    p.riseTime = c.riseTime;
    p.riseOvershoot = c.riseOvershoot;
    p.settle = c.settle;
    p.springRate = c.springRate;
    p.birthScale = c.birthScale;
    p.birthFade = c.birthFade;
    p.emergeSink = 0;
    p.sinkDepth = c.sinkDepth;

    this._fillShape();
    this.ice.syncGeometry(this._shape);

    // The glaze front. Nothing is triggered before the lock, so the whole field
    // sits buried and costs three empty draw calls while the lane is water.
    if (this._locked) {
      this.ice.triggerUpTo(this.age, this._glaze(), c.glazeStagger, c.bladeFrontBias);
    }

    /* --- THE HANDOVER --------------------------------------------------
       Every finger takes the height the water has at its own footprint on the
       frozen frame. Resolved here, every frame, from the live sliders — never
       captured. See consequence 1 in the class comment. */
    const records = this.ice.records;
    const gain = c.iceGain;
    for (let i = 0; i < this.ice.count; i++) {
      this.ice.positionOf(i, p, _pos);
      records[i].heightRoll = this._surfaceAt(_pos) * gain - 1;
    }

    this.iceMaterial.userData.sync();
    this.ice.update(this.age, p, this._melt());
    this._live = this._locked ? this.ice.count : 0;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** Crowns punched into the lane as the splash front runs down it. */
  _layCrowns() {
    const c = settings.brinelock;
    // Kept as a fraction of the cast rather than as metres travelled, so
    // nothing dimensional survives between frames.
    const step = Math.max(0.02, c.crownSpacing / Math.max(this.length, 0.1));

    while (this.u - this._crownAt >= step) {
      this._crownAt += step;
      const record = this._pushCrown(
        saturate(this._crownAt),
        randRange(-1, 1) * c.crownWander,
        c.crownStrength * (1 + randRange(-1, 1) * c.crownJitter)
      );
      this._crownWorld(record, _pos);
      this._sprayBurst(_pos, c.sprayPerCrown, 1);
    }
  }

  /** A handful of droplets thrown out of one crown. */
  _sprayBurst(point, count, scale) {
    const c = settings.brinelock;
    const g = settings.global;
    const total = Math.round(count * g.particleCount);
    if (total <= 0) return;

    _emit.position = point;
    _emit.radius = c.rippleWidth * 0.6;
    // Wide and shallow: a crown leaves sideways. Firing it straight up just
    // puts a small fountain in the lane and the ring never reads.
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.spraySpeed * scale;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.95;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.spraySize;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sprayLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.spray.emit(total, _emit);
  }

  /** The continuous shed off the standing water. */
  _laneFx(dt) {
    const c = settings.brinelock;
    const g = settings.global;
    const gate = 1 - this._handover();
    const count = Math.round(this.sprayEmitter.tick(dt, c.sprayRate * gate) * g.particleCount);
    if (count <= 0) return;

    // Somewhere on the drawn part of the lane, on the crown wall rather than in
    // the flat between crowns: `crownWander` is the same fraction the crowns
    // themselves were thrown off the centre line by.
    const reach = this.phase === AbilityPhase.TRAVEL ? Math.max(0.05, this.u) : 1;
    this.pointAt(Math.random() * reach, _pos);
    _pos.addScaledVector(this.side, randRange(-1, 1) * c.laneWidth * 0.85);
    _pos.y = c.poolHeight;

    _emit.position = _pos;
    _emit.radius = c.laneWidth * 0.3;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.spraySpeed * 0.6;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.spraySize * 0.8;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sprayLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.spray.emit(count, _emit);
  }

  /**
   * One finger has locked. Fired by `GrowthField.onBreach` on the frame it
   * breaks through, which is what makes the frost trail the glaze front down
   * the lane without a single line of per-instance bookkeeping here.
   */
  _frostFx(position, radius, height) {
    const c = settings.brinelock;
    const g = settings.global;
    const count = Math.round(c.frostPerBlade * g.particleCount);
    if (count <= 0) return;

    _pos.copy(position);
    _pos.y += height * 0.6;

    _emit.position = _pos;
    _emit.radius = radius * 2.5;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.frostSpeed;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.frostSize;
    _emit.sizeVariance = 0.6;
    _emit.life = c.frostLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.frost.emit(count, _emit);
  }

  /** Chips coming off the ice as it goes back to water. */
  _meltFx(dt) {
    const c = settings.brinelock;
    const g = settings.global;
    const gate = this._melt();
    if (gate <= 0) return;

    const count = Math.round(this.shardEmitter.tick(dt, c.shardRate * gate) * g.particleCount);
    if (count <= 0) return;

    this.pointAt(Math.random(), _pos);
    _pos.addScaledVector(this.side, randRange(-1, 1) * c.laneWidth * c.bladeSpread);
    _pos.y = c.poolHeight + c.rippleAmp * 0.5;

    _emit.position = _pos;
    _emit.radius = c.laneWidth * 0.4;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.shardSpeed;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.85;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.shardSize;
    _emit.sizeVariance = 0.7;
    _emit.life = c.shardLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 7;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.shards.emit(count, _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._layCrowns();
    this._sync();
    this._laneFx(dt);
    this.ctx.shake.rumble(settings.brinelock.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.brinelock;
    const g = settings.global;

    // The big one, at the far end, dead centre.
    const record = this._pushCrown(1, 0, c.crownStrength * c.impactCrown);
    this._crownWorld(record, _pos);

    /* the sheet of spray thrown off it */
    this.ctx.bursts.spawn(BurstMode.WATER, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.6,
      intensity: c.burstIntensity,
      opacity: 0.85,
      fresnel: 1.8,
      displace: 0.55,
      squash: 0.7,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring across the floor */
    this.pointAt(1, _centre);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _centre, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.55,
      width: 0.06,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* brine thrown outside the waterline */
    const marks = Math.max(0, Math.round(c.brineMarks));
    for (let i = 0; i < marks; i++) {
      // Spaced along the lane with a jittered offset rather than scattered at
      // random: a handful of random points clumps, and a clumped set of stains
      // reads as a mistake rather than as a spill.
      const along = (i + randRange(-0.35, 0.35)) / Math.max(1, marks);
      this.pointAt(saturate(along), _pos);
      _pos.addScaledVector(this.side, randRange(1, 1.9) * c.laneWidth * (i % 2 === 0 ? 1 : -1));
      this.ctx.decals.spawn(DecalType.FOAM, _pos, {
        radius: c.brineRadius * randRange(0.7, 1.3),
        life: c.brineLife,
        intensity: c.brineIntensity,
        colorA: getColor(c.colorBrine),
        colorB: getColor(c.colorBrineEdge),
        height: 0.012
      });
    }

    this._sprayBurst(_pos, c.sprayPerCrown * 3, 1.6);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      22
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.7 * g.explosionIntensity;
  }

  /**
   * The lock. One-shot: the frame the brine stops being water.
   *
   * All it captures is a timestamp. Everything the ice does afterwards — the
   * ring positions, the finger heights, the glaze front — is re-derived from
   * that timestamp and the live sliders on every frame that follows.
   */
  _lock() {
    const c = settings.brinelock;
    const g = settings.global;

    this._locked = true;
    this._lockAt = this.age;

    this.pointAt(0.5, _centre);
    _centre.y = c.poolHeight;

    this.ctx.bursts.spawn(BurstMode.FROST, _centre, {
      radius: c.burstSize * 0.3,
      endRadius: c.burstSize * 1.6 * g.explosionIntensity,
      life: 0.75,
      intensity: c.burstIntensity * 0.8,
      opacity: 0.7,
      fresnel: 2.0,
      displace: 0.35,
      squash: 0.45,
      colorA: getColor(c.colorLockFlash),
      colorB: getColor(c.colorIce),
      colorC: getColor(c.colorSeam)
    });

    /* rime creeping out from under the frozen lane */
    const marks = Math.max(0, Math.round(c.brineMarks));
    for (let i = 0; i < marks; i++) {
      this.pointAt(saturate((i + 0.5) / Math.max(1, marks)), _pos);
      _pos.addScaledVector(this.side, randRange(-1, 1) * c.laneWidth);
      this.ctx.decals.spawn(DecalType.FROST, _pos, {
        radius: c.brineRadius * randRange(1.0, 1.8),
        life: c.brineLife * 1.4,
        intensity: c.brineIntensity * 1.3,
        colorA: getColor(c.colorIce),
        colorB: getColor(c.colorSeam),
        height: 0.014
      });
    }

    this.ctx.shake.add(
      c.lockShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      30
    );
    this.ctx.flash.trigger(getColor(c.colorLockFlash), c.lockFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.1 * g.explosionIntensity;
  }

  onFade(dt, t) {
    if (!this._locked && this._lockElapsed() >= settings.brinelock.lockDelay) this._lock();

    this._sync();
    this._laneFx(dt);
    this._meltFx(dt);

    // The lane keeps rumbling while it is still water and goes quiet the
    // instant it locks — the silence is half of what sells the state change.
    if (!this._locked && t <= 1) {
      this.ctx.shake.rumble(settings.brinelock.rumble * settings.global.cameraShake, dt);
    }
  }

  onDestroy() {
    this._live = 0;
    this._locked = false;
    this._lockAt = -1;
    this._crownAt = 0;
    this.ice.clear();
    this.pool.reset();
    this.pool.visible = false;
  }

  dispose() {
    this.pool.dispose();
    this.ice.dispose();
    this.iceMaterial.dispose();
    super.dispose();
  }
}
