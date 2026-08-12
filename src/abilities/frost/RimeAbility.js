import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { createSheetIceMaterial } from '../../materials/SheetIceMaterial.js';
import { GrowthField, GrowthLayout, GrowthEmerge } from '../../vfx/GrowthField.js';
import { ShatterField, ShatterLayout } from '../../vfx/ShatterField.js';
import { GroundField, GroundMode } from '../../vfx/GroundField.js';
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

/** Hard ceiling on plates in one corridor. The editor's `plateCount` clamps here. */
const MAX_PLATES = 216;
/** Distinct plan outlines. Three, for the reason `GrowthField` documents. */
const PLATE_VARIANTS = 3;
/** Distinct silhouettes for the snapped-off curls. */
const CURL_VARIANTS = 2;
/**
 * How many points along the corridor one snap's fragments are split between.
 * `ShatterField#burst` takes one `along` for a whole batch, so a single call
 * puts two hundred curls in one place — which reads as a grenade, not as a
 * corridor letting go all at once.
 */
const SNAP_BATCHES = 10;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _target = new Vector3();

/* ---------------------------------------------------------------------- */
/* Geometry                                                                */
/* ---------------------------------------------------------------------- */

/**
 * One plate of sheet ice, flat, in `GrowthField`'s unit space.
 *
 * An irregular disc — a polygon of `facets` sides with a jittered outline,
 * subdivided into `rings` radial bands — extruded to `thickness` and gently
 * buckled so a plate lying flat is not a perfect plane and still catches the
 * key light somewhere. Footprint inside a circle of radius 0.5 on `y = 0`.
 *
 * **The curl is not here.** It is a constant-curvature roll applied in the
 * vertex shader of `SheetIceMaterial`, which is why every plate can be at a
 * different point in its own peel while they all share three meshes. What the
 * ring count buys is the *resolution* of that roll: eight rings is eight
 * segments across the sheet, which turns a π roll into a faceted scroll rather
 * than a polygon with four corners in it. Drop it to three and you can count
 * the bends.
 *
 * `thickness` arrives as a **ratio**, not as metres: the instance is scaled to
 * `plateHeight` metres tall, so the ability divides the authored thickness by
 * that height on the way in and the sheet comes out the right number of
 * centimetres thick whatever the peel is set to.
 */
function createIcePlateGeometry(variant, shape) {
  const seed = 3.1 + variant * 17.3;
  const sides = clamp(Math.round(shape?.facets ?? 11), 5, 24);
  const rings = clamp(Math.round(shape?.rings ?? 8), 2, 20);
  const rim = clamp(shape?.rimJitter ?? 0.34, 0, 0.95);
  const buckle = shape?.buckle ?? 0.055;
  const thickness = Math.max(1e-4, shape?.thickness ?? 0.04);

  // The outline: one radius per bearing, rolled once and shared by every ring,
  // so the plate keeps continuous edges from its centre out instead of
  // wobbling ring by ring into a starfish.
  const outline = [];
  for (let i = 0; i < sides; i++) outline.push(0.5 * (1 - rim * hash11(seed * 3.1 + i * 7.7)));

  /** Buckle: smooth, deterministic, and zero at the centre so the plate sits down. */
  const lift = (x, z, radial) =>
    buckle * Math.sin(x * 6.1 + seed * 2.3) * Math.cos(z * 5.3 - seed * 1.7) * radial;

  // rings × sides positions for the underside and the top face.
  const bottom = [];
  const top = [];
  for (let r = 0; r < rings; r++) {
    const radial = 0.12 + 0.88 * (r / (rings - 1));
    const ringBottom = [];
    const ringTop = [];
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * TAU;
      const radius = outline[i] * radial;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const y = lift(x, z, radial);
      ringBottom.push([x, y, z]);
      ringTop.push([x, y + thickness, z]);
    }
    bottom.push(ringBottom);
    top.push(ringTop);
  }

  const centreBottom = [0, 0, 0];
  const centreTop = [0, thickness, 0];

  const positions = [];
  // The locals here are deliberately not called `a`, `b`, `c`: the harness's
  // static settings pass treats `const c = ...` as poisoning the `c` alias for
  // the whole file, and a geometry helper called `c` blinded it to every
  // `settings.rime` read in the ability below it.
  const tri = (p, q, r) => {
    positions.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
  };

  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;

    // The middle of both faces. Winding is authored, not left to chance: the
    // top face has to come out +Y or a plate lying flat is lit from below.
    tri(centreTop, top[0][j], top[0][i]);
    tri(centreBottom, bottom[0][i], bottom[0][j]);

    for (let r = 0; r < rings - 1; r++) {
      tri(top[r][i], top[r][j], top[r + 1][i]);
      tri(top[r][j], top[r + 1][j], top[r + 1][i]);
      tri(bottom[r][j], bottom[r][i], bottom[r + 1][i]);
      tri(bottom[r][j], bottom[r + 1][i], bottom[r + 1][j]);
    }

    // The cut edge. Two triangles per side, and they are the whole reason the
    // ice reads as *thin*: without a wall the plate is a surface, and a surface
    // has no thickness to see when it stands up on its hinge.
    const outer = rings - 1;
    tri(top[outer][i], top[outer][j], bottom[outer][j]);
    tri(top[outer][i], bottom[outer][j], bottom[outer][i]);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * One curl that snapped off, for the `ShatterField`.
 *
 * A bent ribbon inside a unit sphere and centred on its own origin, because
 * the tumble rotates about that point. It is deliberately the *silhouette of a
 * curl* rather than a generic chip: what breaks off a peeled plate is the lip,
 * and the lip is a strip of ice bent through most of a half-turn.
 */
function createCurlFragmentGeometry(variant) {
  const seed = 5.7 + variant * 13.1;
  const segments = 6;
  const arc = 1.4 + hash11(seed) * 1.6; // radians of bend
  const radius = 0.42;
  const halfWidth = 0.11 + hash11(seed * 2.3) * 0.13;

  const yMid = radius * (Math.cos(arc * 0.5) + 1) * 0.5;
  const positions = [];
  const tri = (p, q, r) => {
    positions.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
  };

  const point = (s, side) => {
    const bend = (s / segments - 0.5) * arc;
    const w = halfWidth * (0.45 + 0.55 * Math.sin(Math.PI * (s / segments)));
    return [radius * Math.sin(bend), radius * Math.cos(bend) - yMid, w * side];
  };

  for (let s = 0; s < segments; s++) {
    const q0 = point(s, -1);
    const q1 = point(s, 1);
    const q2 = point(s + 1, 1);
    const q3 = point(s + 1, -1);
    tri(q0, q1, q2);
    tri(q0, q2, q3);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* The ability                                                             */
/* ---------------------------------------------------------------------- */

/**
 * RIME — Rimewalker. A corridor of sheet ice that peels up off the floor.
 *
 * **The trick: the ice is thin.** Every other frost slot in the sandbox is
 * made of solids — the Lance's crystals, the Crown's blades. This one is made
 * of *sheets*: plates three centimetres thick that glaze the floor behind a
 * freezing front, lock, and then lift their downwind edge and roll it back on
 * itself like paper curling off a hot pan. You can see the plate behind the one
 * in front, the light catches the rolled lip and nowhere else, and the whole
 * corridor peels in a wave because every plate is running its own curl clock.
 *
 * Four beats inside the base class's three:
 *
 *  1. **the front** runs the line at `speed` and the plates lock behind it,
 *     flat, on a staggered clock (`lockStagger`);
 *  2. **the peel** — each plate lies flat for `curlDelay` of `curlTime` and
 *     then rolls its rim through `curl` radians;
 *  3. **the hold** — `lifetime` seconds of a standing corridor of shards;
 *  4. **the snap and the sublimation** — the curls break off into a
 *     `ShatterField` and a front runs the corridor *from the caster's end
 *     forward*, taking the ice with it.
 *
 * ## Why the curl lives in the vertex shader
 *
 * `GrowthField.syncGeometry()` rebuilds every variant at once, so baking the
 * curl in as a shape parameter — which was the first attempt — peels the entire
 * field in lockstep and the corridor hinges like one sheet of paper. The roll
 * is therefore a constant-curvature bend in `SheetIceMaterial`'s vertex shader,
 * clocked per instance off `aBirth`, which is the only per-instance stopwatch
 * the field publishes. The stagger *is* the effect; see that module's header.
 *
 * ## Why the corridor is not a GroundField
 *
 * The obvious reading of the brief is one `GroundField` in `PLATE` mode
 * stretched down the line. It does not work, and the reason is worth writing
 * down. A `GroundField` is a **disc**: its growth front is radial, so it fills
 * from the middle outward, and `recede` eats it from the *outside* in. A
 * corridor that fills from the caster's end and then empties from the caster's
 * end needs a front that runs along an axis, and the only way to get one out of
 * a radial quad is to squash the mesh anisotropically — which works right up
 * until the radius changes, at which point the whole cell pattern swims
 * sideways under the ice already on the floor. Two hours went into that before
 * the obvious answer turned up: **the flat plates are the glaze.** A plate
 * before it curls is exactly a sheet of ice lying on the stone, and a hundred
 * and sixty of them interlocking is the corridor. So the `GroundField` draws
 * the one thing it is genuinely shaped like — the pool of glaze where the front
 * grounds out — and the directional sublimation is a front in the plates' own
 * fragment shader, measured in metres downrange of the caster.
 *
 * ## The rule that makes the editor work
 *
 * A cast captures one seed, one instance count, and four timestamps. Every
 * metre, radian and second is resolved against `settings.rime` inside the
 * update loop, on a zero-length frame included. Drag `curl` on a standing
 * corridor and it peels; drag `thickness` and the sheets regenerate; drag
 * `sublimeEdge` mid-fade and the band eating the ice widens where it stands.
 *
 * Six draw calls: three plate meshes, one glaze quad, two fragment meshes.
 */
export class RimeAbility extends Ability {
  constructor(context) {
    super('rime', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.material = createSheetIceMaterial(this.ctx.environment);
    this.plateUniforms = this.material.userData.uniforms;

    /**
     * Live shape controls, handed to the geometry factory. Mutated in place —
     * an object literal per frame is the allocation I3 forbids — and compared
     * numerically by `syncGeometry`, which only rebuilds when one of them moved.
     */
    this._shape = { facets: 11, rings: 8, rimJitter: 0.34, buckle: 0.055, thickness: 0.04 };
    this._fillShape();

    this.plates = new GrowthField(this.group, {
      geometry: createIcePlateGeometry,
      material: this.material,
      shape: this._shape,
      variants: PLATE_VARIANTS,
      capacity: MAX_PLATES,
      layer: LAYER.WORLD,
      renderOrder: 2,
      // The roll is a vertex-shader displacement and the depth material does
      // not carry the patch, so a cast shadow would be the shadow of a flat
      // plate that is not there. They take the stage's shadows; they do not
      // throw one.
      castShadow: false,
      receiveShadow: true
    });
    // Assigned once, at construction — a closure rebuilt per frame per instance
    // is exactly what I3 forbids.
    this.plates.onBreach = (index, position, radius) => this._lockFx(position, radius);

    this.glaze = new GroundField(this.group, {
      mode: GroundMode.PLATE,
      additive: false,
      name: 'Rime:glaze'
    });

    this.curls = new ShatterField(this.group, {
      geometry: createCurlFragmentGeometry,
      variants: CURL_VARIANTS,
      capacity: 192,
      renderOrder: 6
    });

    /* --- scratch parameter blocks, filled from settings every frame --- */
    this._growth = {
      layout: GrowthLayout.LINE,
      emerge: GrowthEmerge.SCALE,
      origin: new Vector3(),
      direction: new Vector3(0, 0, 1),
      side: new Vector3(1, 0, 0),
      length: 1,
      // Sheets are all the same thickness, and the thickness rides the height
      // scale — so the size variety is in the footprint and nowhere else.
      heightJitter: 0,
      lean: 0,
      baseHeight: 0
    };

    this._ground = { centre: new Vector3() };
    this._shatter = {
      layout: ShatterLayout.LINE,
      origin: new Vector3(),
      direction: new Vector3(0, 0, 1),
      side: new Vector3(1, 0, 0),
      length: 1
    };
    this._look = {};

    /** Re-rolled per cast so two corridors do not freeze in the same pattern. */
    this._seed = 0;
    /** Timestamp the glaze pool started freezing out, or -1. */
    this._poolTime = -1;
    /** One-shot latch on the snap. */
    this._snapped = false;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Vapour boiling off the freezing front. Non-additive so it genuinely
    // occludes — a corridor of thin plates needs something opaque behind it or
    // the silhouette has nothing to read against.
    this.mist = particles.get('rime.mist', {
      capacity: 2400,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.mist.uniforms.uDrag.value = 2.1;
    this.mist.uniforms.uEndSize.value = 2.8;
    this.mist.uniforms.uSizeIn.value = 0.12;
    this.mist.uniforms.uFadeIn.value = 0.18;
    this.mist.uniforms.uFadeOut.value = 0.3;

    // Ice crystals hanging in the air over the corridor.
    this.glints = particles.get('rime.glints', {
      capacity: 2000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.glints.uniforms.uDrag.value = 1.3;
    this.glints.uniforms.uEndSize.value = 0.16;
    this.glints.uniforms.uSizeIn.value = 0.05;
    this.glints.uniforms.uFadeIn.value = 0.07;
    this.glints.uniforms.uFadeOut.value = 0.34;

    // Chips knocked loose as a plate locks.
    this.chips = particles.get('rime.chips', {
      capacity: 1600,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.chips.uniforms.uDrag.value = 0.3;
    this.chips.uniforms.uEndSize.value = 0.7;
    this.chips.uniforms.uFadeOut.value = 0.7;

    this.mistEmitter = new RateEmitter();
    this.glintEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.plates.count + this.curls.count;
  }

  /** The corridor stands, then the snap and the sublimation take it apart. */
  get impactDuration() {
    return Math.max(0.1, settings.rime.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    const c = settings.rime;
    return Math.max(0.1, c.snapDelay + c.sublimeTime);
  }

  /** Ice breathes where lightning gutters — a slow cosine, never a stutter. */
  lightShimmer() {
    const c = settings.rime;
    return 1 - c.lightPulse * (0.5 - 0.5 * Math.cos(this.age * c.lightPulseSpeed * TAU));
  }

  /* ------------------------------------------------------------------ */
  /* Live geometry — every metre resolved from settings, every frame      */
  /* ------------------------------------------------------------------ */

  /**
   * The shape controls the plate geometry is baked against.
   *
   * `thickness` goes in as a ratio of the plate's own vertical scale, because
   * the instance matrix multiplies unit-space `y` by `plateHeight` metres. Divide
   * here and the sheet is `thickness` metres thick however tall the peel is set
   * to; forget to, and raising the peel thickens the ice with it, which was the
   * first version and made the plates look like roof tiles.
   */
  _fillShape() {
    const c = settings.rime;
    const shape = this._shape;
    shape.facets = c.facets;
    shape.rings = c.rings;
    shape.rimJitter = c.rimJitter;
    shape.buckle = c.buckle;
    shape.thickness = c.thickness / Math.max(0.02, c.plateHeight);
    return shape;
  }

  /** Footprint, silhouette and eruption of the plate field. */
  _fillGrowth() {
    const c = settings.rime;
    const g = settings.global;
    const p = this._growth;

    p.origin.copy(this.origin);
    p.direction.copy(this.direction);
    p.side.copy(this.side);
    p.length = this.length;

    p.widthNear = c.widthNear;
    p.width = c.width;
    p.widthCurve = c.widthCurve;
    p.frontBias = c.frontBias;
    p.clumping = c.clumping;
    p.scatter = c.scatter;
    p.clusterRadius = c.clusterRadius;

    p.heightNear = c.plateHeight;
    p.height = c.plateHeightFar;
    p.heightCurve = c.heightCurve;
    p.crown = c.crown;
    p.crownPower = c.crownPower;

    p.radiusNear = c.plateRadius;
    p.radius2 = c.plateRadiusFar;
    p.radiusCurve = c.radiusCurve;
    p.radiusJitter = c.radiusJitter;

    p.tilt = c.tilt;
    p.twist = c.twist;

    p.riseTime = c.riseTime;
    p.riseOvershoot = c.riseOvershoot;
    p.settle = c.settle;
    p.springRate = c.springRate;
    p.birthScale = c.birthScale;
    // The birth flash IS the curl clock — see `SheetIceMaterial`'s header.
    p.birthFade = Math.max(0.05, c.curlTime);
    p.randomness = g.randomness;
    return p;
  }

  /**
   * The glaze pool where the front grounds out.
   *
   * `windAngle` is 0 because the quad is yawed onto the cast: in its own frame
   * downrange *is* +Z, so the pool's plates lift their downwind edge in the
   * same direction the corridor's do, and the two read as one freeze rather
   * than as a mark with an effect standing on it.
   */
  _fillGround(grow, recede, fade) {
    const c = settings.rime;
    const g = settings.global;
    const p = this._ground;

    this.pointAt(1, p.centre);
    p.yaw = Math.atan2(this.direction.x, this.direction.z);
    p.height = c.poolHeight;
    p.radius = c.poolRadius;
    p.seed = this._seed;

    p.grow = grow;
    p.recede = recede;
    p.fade = fade;

    p.edge = c.poolEdge;
    p.ragged = c.poolRagged;
    p.raggedScale = c.poolRaggedScale;
    p.warp = c.poolWarp;

    p.relief = c.poolRelief;
    p.normalStep = c.poolNormalStep;
    p.ambient = c.poolAmbient;
    p.wrap = c.poolWrap;
    p.specular = c.poolSpecular;
    p.gloss = c.poolGloss;
    p.parallax = c.poolParallax;

    p.cell = c.poolCell;
    p.cellJitter = c.poolCellJitter;
    p.seam = c.poolSeam;
    p.thickness = c.poolThickness;
    p.lift = c.poolLift;
    p.detail = c.poolDetail;
    p.windAngle = 0;

    p.additive = false;
    p.emissive = c.poolEmissive;
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
    return p;
  }

  /** The flight of one snapped-off curl. */
  _fillShatter() {
    const c = settings.rime;
    const g = settings.global;
    const p = this._shatter;

    p.origin.copy(this.origin);
    p.direction.copy(this.direction);
    p.side.copy(this.side);
    p.length = this.length;
    p.width = c.width;

    p.spawnRadius = c.shardSpawnRadius;
    p.spawnHeight = c.shardSpawnHeight;
    p.speed = c.shardSpeed;
    p.speedJitter = c.shardSpeedJitter;
    p.spread = c.shardSpread;
    p.upBias = c.shardUpBias;
    p.gravity = c.shardGravity;
    p.drag = c.shardDrag;
    p.size = c.shardSize;
    p.sizeJitter = c.shardSizeJitter;
    p.shrink = c.shardShrink;
    p.shrinkPower = c.shardShrinkPower;
    p.spin = c.shardSpin;
    p.spinJitter = c.shardSpinJitter;
    p.lifetime = c.shardLifetime;
    p.floor = c.shardFloor;
    p.floorSpin = c.shardFloorSpin;
    p.randomness = g.randomness;
    return p;
  }

  /** Colours and shading of the fragments. Four pickers, none derived (I5). */
  _fillLook() {
    const c = settings.rime;
    const g = settings.global;
    const look = this._look;
    look.colorA = getColor(c.colorShardA);
    look.colorB = getColor(c.colorShardB);
    look.colorEdge = getColor(c.colorShardEdge);
    look.opacity = c.shardOpacity * g.opacity;
    look.glow = c.shardGlow * g.glow;
    look.rim = c.shardRim;
    look.rimPower = c.shardRimPower;
    look.shade = c.shardShade;
    look.ambient = c.shardAmbient;
    look.fadeStart = c.shardFadeStart;
    look.soft = c.shardSoft;
    return look;
  }

  /**
   * How far the sublimation front has run, in metres downrange of the caster.
   *
   * Well below the corridor until the snap, so the plates' fragment shader
   * leaves everything intact; then it sweeps from just behind the caster to
   * just past the target. The band, not the front, is where the ice is actually
   * turning to vapour, which is why it is the brightest thing in the fade.
   */
  _sublimeFront() {
    const c = settings.rime;
    if (this.phase !== AbilityPhase.FADE) return -1e4;
    const k = saturate((this.fadeTime - c.snapDelay) / Math.max(0.05, c.sublimeTime));
    return lerp(-c.sublimeEdge, this.length + c.sublimeEdge * 2, k);
  }

  /** 0..1 — how far the glaze pool has frozen out. */
  _poolGrowth() {
    if (this._poolTime < 0) return 0;
    return saturate((this.age - this._poolTime) / Math.max(0.05, settings.rime.poolGrow));
  }

  /** 0..1 — how far the pool has been eaten back. It goes last, and from its rim. */
  _poolRecede() {
    const c = settings.rime;
    if (this.phase !== AbilityPhase.FADE) return 0;
    const k = saturate((this.fadeTime - c.snapDelay) / Math.max(0.05, c.sublimeTime));
    const hold = Math.min(0.98, c.poolHold);
    return saturate((k - hold) / (1 - hold));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.rime;

    this.mistEmitter.reset();
    this.glintEmitter.reset();
    this._poolTime = -1;
    this._snapped = false;
    this._seed = Math.random() * 100;

    this.curls.clear();
    this.plates.plant(Math.min(MAX_PLATES, Math.round(c.plateCount)), c.clusterShare);

    this._syncUniforms();
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings into the sheet material, the glaze and the
   * fragments. Everything with a unit is read here and nowhere else.
   */
  _syncUniforms() {
    const c = settings.rime;
    const g = settings.global;
    const u = this.plateUniforms;

    this.material.userData.sync();

    // The cast's own frame, which the material cannot read for itself: the
    // direction the plates peel toward, and the axis the sublimation front is
    // measured along.
    u.uCurlDir.value.set(this.direction.x, this.direction.z);
    u.uSublimeOrigin.value.copy(this.origin);
    u.uSublimeDir.value.copy(this.direction);
    u.uSublimeFront.value = this._sublimeFront();

    this.curls.sync(this._fillLook());

    /* --- the three particle systems --- */
    this.mist.setGradient(
      getColor(c.colorMistA),
      getColor(c.colorMistB),
      getColor(c.colorMistC),
      getColor(c.colorMistD)
    );
    this.mist.uniforms.uGravity.value.set(0, c.mistRise, 0);
    this.mist.uniforms.uSizeScale.value = c.mistSize * g.particleSize;
    this.mist.uniforms.uLifeScale.value = c.mistLifetime * 0.5 * g.particleLifetime;
    this.mist.uniforms.uSpeedScale.value = c.mistSpeed * g.particleSpeed;
    this.mist.uniforms.uOpacity.value = c.mistOpacity * g.opacity;
    this.mist.uniforms.uTurbulence.value = 0.35 * g.turbulence;

    this.glints.setGradient(
      getColor(c.colorGlintA),
      getColor(c.colorGlintB),
      getColor(c.colorGlintC),
      getColor(c.colorGlintD)
    );
    this.glints.uniforms.uGravity.value.set(0, c.glintRise, 0);
    this.glints.uniforms.uSizeScale.value = c.glintSize * g.particleSize * 7;
    this.glints.uniforms.uLifeScale.value = c.glintLifetime * 0.5 * g.particleLifetime;
    this.glints.uniforms.uSpeedScale.value = c.glintSpeed * g.particleSpeed;
    this.glints.uniforms.uOpacity.value = g.opacity;
    this.glints.uniforms.uGlow.value = 0.9 * g.glow;
    this.glints.uniforms.uTurbulence.value = c.glintTurbulence * g.turbulence;

    this.chips.setGradient(
      getColor(c.colorChipA),
      getColor(c.colorChipB),
      getColor(c.colorChipC),
      getColor(c.colorChipD)
    );
    this.chips.uniforms.uGravity.value.set(0, c.chipGravity, 0);
    this.chips.uniforms.uSizeScale.value = c.chipSize * g.particleSize * 7;
    this.chips.uniforms.uLifeScale.value = c.chipLifetime * 0.5 * g.particleLifetime;
    this.chips.uniforms.uSpeedScale.value = g.particleSpeed;
    this.chips.uniforms.uOpacity.value = g.opacity;
  }

  /** Rebuild the field, the glaze and the fragments against the live settings. */
  _syncFields(grow, recede, fade) {
    this.plates.syncGeometry(this._fillShape());
    this.plates.update(this.age, this._fillGrowth(), 0);
    this.glaze.update(this._fillGround(grow, recede, fade));
    this.curls.update(this.age, this._fillShatter());
  }

  /** A breath of frost at the caster's hand as the front leaves it. */
  _muzzleFx() {
    const c = settings.rime;
    const g = settings.global;

    _pos.copy(this.origin).addScaledVector(this.direction, 0.5).setY(0.4);

    this.ctx.bursts.spawn(BurstMode.FROST, _pos, {
      radius: c.burstSize * 0.15,
      endRadius: c.burstSize * 0.55 * g.explosionIntensity,
      life: 0.5,
      intensity: c.burstIntensity * 0.7,
      opacity: 0.8,
      fresnel: 1.4,
      displace: 0.4,
      squash: 0.7,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  /**
   * Chips and a puff of vapour where one plate locks onto the stone.
   * Called by `GrowthField` the frame an instance breaks its `breachAt`.
   */
  _lockFx(position, radius) {
    const c = settings.rime;
    const g = settings.global;

    _pos.copy(position).setY(0.05);

    _emit.position = _pos;
    _emit.radius = radius * 0.5;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.45).setY(1).normalize();
    _emit.speed = c.chipSpeed;
    _emit.speedVariance = 0.75;
    _emit.spread = 0.85;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.09;
    _emit.sizeVariance = 0.7;
    _emit.life = c.chipLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 8;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.chips.emit(Math.round(c.breachChips * g.particleCount), _emit);
  }

  /**
   * Vapour off the freezing front and crystals hanging over the corridor.
   * @param {number} scale 0..1 — thinned once the corridor is only standing
   */
  _corridorFx(dt, scale) {
    const c = settings.rime;
    const g = settings.global;
    const time = frame.uTime.value;
    const reach = this.phase === AbilityPhase.TRAVEL ? Math.max(0.03, this.u) : 1;

    const mistCount = Math.round(this.mistEmitter.tick(dt, c.mistRate * scale) * g.particleCount);
    if (mistCount > 0) {
      // The vapour comes off the freezing front itself while it is running, and
      // off the whole corridor once it has landed.
      const s = this.phase === AbilityPhase.TRAVEL ? reach : Math.random() * reach;
      this.pointAt(s, _pos).setY(0.14);
      _emit.position = _pos;
      _emit.radius = lerp(c.widthNear, c.width, s) * 1.2;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.mistSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.8;
      _emit.sizeVariance = 0.5;
      _emit.life = c.mistLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.4;
      _emit.tint = null;
      _emit.time = time;
      this.mist.emit(mistCount, _emit);
    }

    const glintCount = Math.round(this.glintEmitter.tick(dt, c.glintRate * scale) * g.particleCount);
    if (glintCount > 0) {
      const s = Math.random() * reach;
      this.pointAt(s, _pos).setY(0.35);
      _emit.position = _pos;
      _emit.radius = lerp(c.widthNear, c.width, s);
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.glintSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.6;
      _emit.life = c.glintLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.glints.emit(glintCount, _emit);
    }
  }

  /**
   * The curls letting go, all at once, along the whole corridor.
   *
   * `burst()` takes one `along` per call, so this walks the line in batches —
   * one call would drop every fragment on the same spot and read as a grenade
   * rather than as a hundred and sixty lips snapping at the same instant.
   */
  _snapFx() {
    const c = settings.rime;
    const g = settings.global;
    const total = Math.round(c.shardCount * g.particleCount);
    const per = Math.max(1, Math.round(total / SNAP_BATCHES));

    for (let batch = 0; batch < SNAP_BATCHES; batch++) {
      this.curls.burst(this.age, per, (batch + 0.5) / SNAP_BATCHES, randRange(-0.85, 0.85));
    }

    this.ctx.shake.add(
      c.snapShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      22
    );
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.rime;

    this._syncUniforms();
    this.plates.triggerUpTo(this.age, this.u, c.lockStagger, c.frontBias, false);
    this._syncFields(this._poolGrowth(), 0, saturate(this._poolGrowth() * 3));
    this._corridorFx(dt, 1);

    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.rime;
    const g = settings.global;
    const time = frame.uTime.value;

    // Everything still waiting locks now, the terminal ring included.
    this.plates.triggerUpTo(this.age, 1, c.lockStagger, c.frontBias, true);
    this._poolTime = this.age;

    this.pointAt(1, _target);
    _pos.copy(_target).setY(0.35);

    /* the shell of freezing vapour where the front grounded out */
    this.ctx.bursts.spawn(BurstMode.FROST, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.85,
      intensity: c.burstIntensity,
      opacity: 0.85,
      fresnel: 1.4,
      displace: 0.5,
      squash: 0.68,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring that snaps outward across the floor */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _target, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.7,
      width: 0.05,
      intensity: 0.85,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* chips and vapour off the landing */
    _emit.position = _pos;
    _emit.radius = c.poolRadius * 0.5;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.chipSpeed * 1.8;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.13;
    _emit.sizeVariance = 0.8;
    _emit.life = c.chipLifetime * 1.3;
    _emit.lifeVariance = 0.5;
    _emit.spin = 9;
    _emit.tint = null;
    _emit.time = time;
    this.chips.emit(Math.round(40 * g.particleCount), _emit);

    _emit.speed = c.mistSpeed * 2.6;
    _emit.spread = 1.0;
    _emit.size = 1.4;
    _emit.life = c.mistLifetime * 1.3;
    _emit.spin = 0.5;
    this.mist.emit(Math.round(70 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.2 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.rime;

    if (this.phase === AbilityPhase.FADE && !this._snapped && this.fadeTime >= c.snapDelay) {
      this._snapped = true;
      this._snapFx();
    }

    this._syncUniforms();
    this._syncFields(this._poolGrowth(), this._poolRecede(), saturate(this._poolGrowth() * 3));

    // The light follows the interesting event: it rides the front out, sits on
    // the pool through the hold, and then walks back down the corridor with the
    // sublimation band.
    const front = this._sublimeFront();
    if (front > 0) {
      this.pointAt(saturate(front / Math.max(0.1, this.length)), this.position);
      this.position.y = 0.3;
    }

    // Vapour keeps coming off the standing corridor, and harder as the
    // sublimation front eats it.
    const boil = this.phase === AbilityPhase.FADE ? 1.4 : 0.5;
    this._corridorFx(dt, boil * (t <= 1 ? 1 : 1 - saturate((t - 1) * 0.6)));
  }

  onDestroy() {
    this.plates.clear();
    this.curls.clear();
    this._poolTime = -1;
    this._snapped = false;
    this.plateUniforms.uSublimeFront.value = -1e4;
    this.glaze.update(this._fillGround(0, 0, 0));
  }

  dispose() {
    this.plates.dispose();
    this.curls.dispose();
    this.glaze.dispose();
    this.material.dispose();
    super.dispose();
  }
}
