import { BufferGeometry, Float32BufferAttribute, MeshStandardMaterial, Color, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { GrowthField, GrowthLayout, GrowthEmerge, patchGrowthMaterial } from '../../vfx/GrowthField.js';
import { FilamentPaths, MAX_FILAMENT_ROLES } from '../../vfx/FilamentPaths.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, hash11, Easing, randRange } from '../../utils/math.js';

/* ---------------------------------------------------------------------- */
/* Constants                                                               */
/* ---------------------------------------------------------------------- */

const TAU = Math.PI * 2;

/** Hard ceiling on thorns per cast. The editor's `thorns` slider clamps here. */
const MAX_THORNS = 96;

/** Distinct thorn silhouettes — one InstancedMesh each. Three draw calls. */
const VARIANTS = 3;

/**
 * Vine slots.
 *
 * `FilamentPaths` holds four role slots and **one anchor pair per role**, which
 * is the constraint that shapes this whole ability: a role's `from`/`to` are
 * uniforms, so a role can draw a dozen parallel strands between two points but
 * cannot draw a dozen strands between a dozen different pairs. Twelve vines is
 * therefore three strips at two draw calls each. The alternative — one strip and
 * four vines — was the first thing tried, and four strands across forty thorns
 * reads as four strands across forty thorns. Twelve reads as a bramble.
 */
const WEAVES = 3;
const MAX_VINES = WEAVES * MAX_FILAMENT_ROLES;

/** Parallel filaments one vine may carry. Four is already a rope. */
const MAX_VINE_STRANDS = 4;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _target = new Vector3();
const _va = new Vector3();
const _vb = new Vector3();
const _probe = new Vector3();

/* ---------------------------------------------------------------------- */
/* The thorn                                                               */
/* ---------------------------------------------------------------------- */

/** Ring heights up the shaft. Crowded low, where the taper is doing its work. */
const RING_T = [0, 0.1, 0.24, 0.42, 0.62, 0.82];

/**
 * A tapered, swept, barbed spike in `GrowthField`'s unit space: footprint inside
 * a circle of radius 0.5 on `y = 0`, tip at `y = 1`.
 *
 * Three things had to be true before this read as a bramble rather than as a
 * cone with lumps on it.
 *
 * **The shaft sweeps.** A straight spike is a stalagmite. The axis drifts
 * sideways by `curve · t^1.7`, in one bearing chosen per variant, so the whole
 * thorn hooks over — and because the bearing is per *variant* rather than per
 * instance, `GrowthField`'s random yaw then scatters the hooks in every
 * direction anyway.
 *
 * **The taper is an exponent, not a slope.** `r = 0.5 · (1 − t)^taper`. At
 * `taper = 1` you get a cone; at 2.3 you get a needle with a thick heel, which
 * is the profile that says "this grew" rather than "this was machined". The
 * first version lerped the radius linearly and the whole field looked like a bed
 * of tent pegs.
 *
 * **The barbs point back down the stem.** `barbTilt` is negative by default. A
 * barb angled forward reads as a fir branch, and the entire silhouette flips
 * from hostile to festive with one sign change; it is worth flipping the slider
 * once to see how completely the read depends on it.
 *
 * The barbs are what push the widest point of the footprint slightly past 0.5 at
 * their attach height. That is accepted rather than clamped: the contract is
 * about the scale convention (so `local.y` reads as "how far up am I" in the
 * fragment stage), and a barb trimmed to keep a bounding circle honest is a barb
 * you cannot see.
 */
function createThornGeometry({
  seed = 1,
  sides = 5,
  taper = 2.3,
  curve = 0.48,
  barbs = 3,
  barbLength = 0.19,
  barbTilt = -0.5,
  barbSpread = 0.62,
  rough = 0.34
} = {}) {
  const faces = Math.max(3, Math.min(8, Math.round(sides)));
  const barbCount = Math.max(0, Math.min(5, Math.round(barbs)));
  const power = Math.max(0.2, taper);

  const bendAngle = hash11(seed * 1.77) * TAU;
  const bendX = Math.cos(bendAngle);
  const bendZ = Math.sin(bendAngle);

  const shaftRadius = (t) => 0.5 * Math.pow(Math.max(1e-4, 1 - t), power);
  const drift = (t) => curve * 0.5 * Math.pow(t, 1.7);

  // Angles are jittered once and shared by every ring, so the facets stay
  // continuous edges up the shaft instead of twisting into a screw.
  const angles = [];
  for (let i = 0; i < faces; i++) {
    const jitter = (hash11(seed * 3.13 + i * 7.7) - 0.5) * (TAU / faces) * 0.5 * rough;
    angles.push((i / faces) * TAU + jitter);
  }

  const rings = RING_T.map((t, ringIndex) => {
    const baseR = shaftRadius(t);
    const dx = bendX * drift(t);
    const dz = bendZ * drift(t);
    const y = t + (hash11(seed * 5.9 + ringIndex * 2.3) - 0.5) * 0.05 * rough * (t > 0 ? 1 : 0);
    return angles.map((angle, i) => {
      const wobble = 1 + (hash11(seed * 11.1 + ringIndex * 13.7 + i * 3.9) - 0.5) * rough * 1.2;
      const r = Math.max(0.002, baseR * wobble);
      return [Math.cos(angle) * r + dx, y, Math.sin(angle) * r + dz];
    });
  });

  const apex = [
    bendX * drift(1) + (hash11(seed * 17.3) - 0.5) * 0.05 * rough,
    1,
    bendZ * drift(1) + (hash11(seed * 19.7) - 0.5) * 0.05 * rough
  ];
  const floorCentre = [0, 0, 0];

  const positions = [];
  const push = (p) => positions.push(p[0], p[1], p[2]);

  for (let ring = 0; ring < rings.length - 1; ring++) {
    const lower = rings[ring];
    const upper = rings[ring + 1];
    for (let i = 0; i < faces; i++) {
      const j = (i + 1) % faces;
      push(lower[i]); push(lower[j]); push(upper[i]);
      push(lower[j]); push(upper[j]); push(upper[i]);
    }
  }

  const top = rings[rings.length - 1];
  const base = rings[0];
  for (let i = 0; i < faces; i++) {
    const j = (i + 1) % faces;
    push(top[i]); push(top[j]); push(apex); // the point
    push(floorCentre); push(base[j]); push(base[i]); // the underside
  }

  /* --- the barbs ---------------------------------------------------- */
  for (let k = 0; k < barbCount; k++) {
    // Golden-ratio bearings plus a scatter: evenly spaced barbs stack into a
    // visible helix, and identical bearings stack into a fin.
    const roll = hash11(seed * 23.7 + k * 5.13);
    const t = 0.16 + 0.64 * ((k + 0.3 + 0.4 * roll) / Math.max(1, barbCount));
    const bearing = (k * 0.61803 + barbSpread * hash11(seed * 31.1 + k * 9.7)) * TAU;
    const cos = Math.cos(bearing);
    const sin = Math.sin(bearing);

    const shaft = shaftRadius(t);
    const cx = bendX * drift(t) + cos * shaft * 0.75;
    const cy = t;
    const cz = bendZ * drift(t) + sin * shaft * 0.75;

    // Outward, then tipped toward the floor by `barbTilt`.
    let dxx = cos;
    let dyy = barbTilt;
    let dzz = sin;
    const dl = Math.hypot(dxx, dyy, dzz) || 1;
    dxx /= dl; dyy /= dl; dzz /= dl;

    const length = barbLength * (0.75 + 0.5 * hash11(seed * 41.3 + k * 3.7));
    const tip = [cx + dxx * length, cy + dyy * length, cz + dzz * length];

    // Two vectors perpendicular to the barb's axis, for its three-sided root.
    let ux = -dzz;
    let uy = 0;
    let uz = dxx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = dyy * uz - dzz * uy;
    const vy = dzz * ux - dxx * uz;
    const vz = dxx * uy - dyy * ux;

    const root = Math.max(0.012, shaft * 0.55);
    const ring = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + roll * TAU;
      const ca = Math.cos(a) * root;
      const sa = Math.sin(a) * root;
      ring.push([cx + ux * ca + vx * sa, cy + uy * ca + vy * sa, cz + uz * ca + vz * sa]);
    }
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      push(ring[i]); push(ring[j]); push(tip);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  // Non-indexed with per-face normals: this is what keeps the facets crisp under
  // `flatShading`, and it is the same trick the crystal field uses.
  geometry.computeVertexNormals();
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* Bark                                                                    */
/* ---------------------------------------------------------------------- */

/**
 * Bark on a `MeshStandardMaterial`, so the field takes the stage's real shadows
 * and probe and only the stylisation is injected.
 *
 * The one term that took work is the tip highlight. A thorn's *point* is easy —
 * it is `vGrowLocal.y` near 1 — but the barbs' points are halfway up the shaft
 * and would have stayed dull, which is exactly backwards: the barbs are the
 * thing a bramble threatens you with. There is no room for a second vertex
 * attribute here (`patchGrowthMaterial` injects fragment declarations only), so
 * "am I on a point" is reconstructed in the fragment from the geometry's own
 * profile: anything further from the local axis than the shaft radius at that
 * height, `0.5 · (1 − y)^taper`, must be a barb. The reconstruction ignores the
 * shaft's sweep, so the outer flank of a strongly swept thorn picks up a little
 * of the same highlight — which turned out to be what light does to a curved
 * stem anyway, and is left in.
 */
function createBarkMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.74,
    metalness: 0.0,
    flatShading: true,
    // Transparent from the start and left that way. `barkOpacity` has to be a
    // live slider, and toggling `transparent` from the update loop moves the
    // meshes between render lists every frame the value crosses 1 — which shows
    // up as the field flickering behind the particles rather than as a bug you
    // would look for in a material.
    transparent: true,
    depthWrite: true
  });

  const uniforms = {
    uTime: frame.uTime,
    uColorBark: { value: new Color() },
    uColorHeart: { value: new Color() },
    uColorMoss: { value: new Color() },
    uColorTip: { value: new Color() },
    uColorSap: { value: new Color() },
    uGrain: { value: 0.6 },
    uGrainScale: { value: 5.5 },
    uMoss: { value: 0.42 },
    uMossScale: { value: 2.4 },
    uTipStart: { value: 0.6 },
    uTipSharp: { value: 1.8 },
    uTipGlow: { value: 1.5 },
    uTaper: { value: 2.3 },
    uBarbEdge: { value: 0.055 },
    uBarbSpan: { value: 0.075 },
    uSapGlow: { value: 2.4 },
    uGlow: { value: 1.0 }
  };

  patchGrowthMaterial(material, {
    environment,
    uniforms,
    common: /* glsl */ `
      uniform float uTime;
      uniform vec3  uColorBark;
      uniform vec3  uColorHeart;
      uniform vec3  uColorMoss;
      uniform vec3  uColorTip;
      uniform vec3  uColorSap;
      uniform float uGrain;
      uniform float uGrainScale;
      uniform float uMoss;
      uniform float uMossScale;
      uniform float uTipStart;
      uniform float uTipSharp;
      uniform float uTipGlow;
      uniform float uTaper;
      uniform float uBarbEdge;
      uniform float uBarbSpan;
      uniform float uSapGlow;
      uniform float uGlow;
    `,
    fragment: /* glsl */ `
      vec3  N   = normalize(normal);
      float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);
      float y   = clamp(vGrowLocal.y, 0.0, 1.0);

      // World space for the fibre, so a knee-high shoot and a two-metre thorn
      // are visibly cut from the same wood instead of each carrying a copy of
      // the pattern scaled to its own size.
      float fibre = fbm3(vec3(vGrowWorld.xz * uGrainScale, vGrowWorld.y * uGrainScale * 0.35)
                         + vGrowSeed * 7.0);
      float grain = (fibre * 0.5 + 0.5);

      // Local space for the mottle, so the lichen follows each thorn's own axis
      // however it is scaled, leaned or tipped.
      float mottle = fbm3(vGrowLocal * uMossScale * 3.0 + vGrowSeed * 13.0) * 0.5 + 0.5;
      mottle = smoothstep(0.42, 0.86, mottle);

      vec3 body = mix(uColorHeart, uColorBark, mix(1.0, grain, uGrain));
      body = mix(body, uColorMoss, mottle * uMoss);

      // 'Am I on a point?' — see the function header. The shaft profile is
      // reconstructed, not sampled, because there is nowhere to put an
      // attribute that would carry it.
      float shaft  = 0.5 * pow(max(1.0 - y, 0.0), max(uTaper, 0.2));
      float offAxis = length(vGrowLocal.xz);
      float barb   = smoothstep(shaft + uBarbEdge, shaft + uBarbEdge + max(uBarbSpan, 1e-3), offAxis);
      float point  = pow(smoothstep(clamp(uTipStart, 0.0, 0.99), 1.0, y), max(uTipSharp, 0.05));
      float sharp  = clamp(max(point, barb), 0.0, 1.0);

      body = mix(body, uColorTip, sharp * 0.75);

      // Facets pointing at the camera lift, so the field reads as a bundle of
      // planes rather than one green mass.
      body *= 0.62 + 0.55 * ndv;

      diffuseColor.rgb *= body;

      vec3 glow = uColorTip * sharp * uTipGlow * (0.35 + 0.65 * pow(1.0 - ndv, 2.0));
      glow += uColorSap * vGrowBirth * uSapGlow;
      glow *= uGlow;
      // Reinhard ceiling: the two terms are independent and both peak at a
      // grazing angle, and without this a barb on the silhouette sums past 6
      // and the bloom pass smears the whole bramble into a green cloud.
      glow /= 1.0 + glow * 0.3;

      totalEmissiveRadiance += glow;
    `
  });

  // The pause test reads a patched standard material's live boxes from here —
  // `material.uniforms` does not exist until a GL context compiles the shader.
  material.userData.uniforms = uniforms;
  return material;
}

/* ---------------------------------------------------------------------- */
/* The ability                                                             */
/* ---------------------------------------------------------------------- */

/**
 * THORNWAKE — a bramble erupts along the aimed line.
 *
 * A growth front runs the cast at `speed`; curved, barbed thorns punch up out of
 * the floor behind it on staggered clocks, throwing soil and leaf; a knot of
 * them closes over the impact point; the whole bed stands, and then withers back
 * into the ground.
 *
 * **THE TRICK — the brambles interlace.** A field of forty separate spikes reads
 * as forty props however good the spike is. What turns it into one tangled mass
 * is the vines: sagging strands threaded *between* thorn instances, each one
 * picking two indices by a deterministic function of its own slot and threading
 * a catenary between where those two thorns actually are.
 *
 * The endpoints are not stored. Every frame, for every vine, the ability asks
 * the `GrowthField` — `positionOf`, `heightOf`, `emergenceOf` — where its two
 * thorns currently stand *at the current sliders*, lifts the anchors to
 * `vineGripLow`/`vineGripHigh` of their live heights, scales that by how far out
 * of the ground each one is, and hands the two points to a `FilamentPaths` LINK
 * role. So the weave is a live query rather than a captured mesh: drag
 * `clumping` with the clock stopped and the thorns crowd inward and every vine
 * slackens with them; drag `height` and the anchors climb; drag `vineReach` and
 * the whole thing re-routes onto different neighbours mid-air.
 *
 * The partner search is what makes it read as *tangle* rather than *cat's
 * cradle*. `GrowthField.plant` lays its records stratified along the line — one
 * per slot plus a jitter inside it — so index distance is distance down the
 * cast. A vine starting at instance `a` walks forward through the next
 * `vineReach` indices and takes the first partner whose live span fits inside
 * `vineMaxSpan`, which means the pairs are always spatial neighbours but their
 * lateral offsets are uncorrelated: strands cross the corridor in both
 * directions and the field closes over.
 *
 * The first version of this threaded `tipOf(a)` to `tipOf(b)` and it was wrong
 * in a way worth recording — tip to tip drapes every strand *over* the field
 * like bunting, because there is nothing above a thorn's point to interrupt it.
 * Tying one end low on the shaft and the other high is what pushes the strands
 * down *into* the bed, where they read as caught on the barbs.
 *
 * A cast captures dice and timestamps and nothing else: two unitless rolls per
 * vine (where to start, how far to look), the `GrowthField`'s own record dice,
 * one seed for the filament noise, and the moment each vine's two ends were both
 * clear of the ground. Every metre, radian and second is re-resolved from
 * `settings.thornwake` inside the update loop, on zero-length frames included.
 *
 * **Cost.** Three instanced thorn meshes + three filament strips at two passes
 * each = **9 draw calls**, three shared particle systems, one dynamic light.
 */
export class ThornwakeAbility extends Ability {
  constructor(context) {
    super('thornwake', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const environment = this.ctx.environment;
    this.material = createBarkMaterial(environment);

    /** Geometry controls, compared each frame by `syncGeometry`. */
    this._shape = {
      sides: 5,
      taper: 2.3,
      curve: 0.48,
      barbs: 3,
      barbLength: 0.19,
      barbTilt: -0.5,
      barbSpread: 0.62,
      rough: 0.34
    };
    this._fillShape();

    this.field = new GrowthField(this.group, {
      geometry: (variant, shape) => createThornGeometry({ seed: 3.7 + variant * 19.3, ...shape }),
      material: this.material,
      shape: this._shape,
      variants: VARIANTS,
      capacity: MAX_THORNS,
      renderOrder: 2
    });
    // Assigned once, at construction. A closure built inside the update loop is
    // an allocation per instance per frame, which is what I3 forbids.
    this.field.onBreach = (index, position, radius, height) =>
      this._onBreach(index, position, radius, height);

    /**
     * Three strips, four LINK roles each. See `WEAVES`.
     * `samples` is deliberately low: a vine is a metre or two of smooth sag, and
     * 36 nodes is already finer than `vineKinkScale` can resolve.
     */
    this.weaves = [];
    for (let w = 0; w < WEAVES; w++) {
      this.weaves.push(
        new FilamentPaths(this.group, {
          samples: 36,
          capacity: MAX_FILAMENT_ROLES * MAX_VINE_STRANDS,
          renderOrder: 10
        })
      );
    }

    /** Live params handed to the field every frame. Never holds a stale metre. */
    this._params = {
      layout: GrowthLayout.LINE,
      emerge: GrowthEmerge.PUSH,
      origin: this.origin,
      direction: this.direction,
      side: this.side,
      length: 1
    };

    /** Live look handed to every strip every frame. */
    this._look = {};

    /* --- the cast's dice, all unitless --- */
    this._seed = 0;
    /** Which instance vine `v` starts from, 0..1. */
    this._vineStart = new Float32Array(MAX_VINES);
    /** How far ahead vine `v` begins looking for a partner, 0..1. */
    this._vineStep = new Float32Array(MAX_VINES);
    /** The age at which vine `v` first had both ends clear. −1 for unthreaded. */
    this._vineTime = new Float32Array(MAX_VINES);
    this._liveVines = 0;
    this._liveStrands = 0;
    /** Age the cinch is measured from — a timestamp, re-stamped at impact. */
    this._cinchFrom = 1e9;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Leaf and husk torn off the growth. Lit and non-additive: this is matter,
    // not light, and additive chaff over a green field disappears into it.
    this.chaff = particles.get('thornwake.chaff', {
      capacity: 2400,
      shape: ParticleShape.LEAF,
      additive: false,
      lit: true,
      softFade: 0.3
    });
    this.chaff.uniforms.uDrag.value = 1.9;
    this.chaff.uniforms.uEndSize.value = 0.85;
    this.chaff.uniforms.uSizeIn.value = 0.05;
    this.chaff.uniforms.uFadeIn.value = 0.06;
    this.chaff.uniforms.uFadeOut.value = 0.45;

    // Spores lifting off the bed. Additive, curled, slow.
    this.motes = particles.get('thornwake.motes', {
      capacity: 1800,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.5
    });
    this.motes.uniforms.uDrag.value = 1.5;
    this.motes.uniforms.uEndSize.value = 0.2;
    this.motes.uniforms.uSizeIn.value = 0.08;
    this.motes.uniforms.uFadeIn.value = 0.12;
    this.motes.uniforms.uFadeOut.value = 0.5;

    // Soil kicked out of the hole a thorn came through.
    this.soil = particles.get('thornwake.soil', {
      capacity: 1600,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.soil.uniforms.uDrag.value = 0.4;
    this.soil.uniforms.uEndSize.value = 0.7;
    this.soil.uniforms.uFadeOut.value = 0.6;

    this.chaffEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.field.count + this._liveStrands;
  }

  /** The bed stands after the front lands. */
  get impactDuration() {
    return Math.max(0.1, settings.thornwake.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.1, settings.thornwake.fadeTime);
  }

  /** Growth does not gutter. A slow breath, slightly slower than the default. */
  lightShimmer() {
    return 0.88 + 0.12 * Math.sin(this.age * 4.1) * Math.sin(this.age * 1.7);
  }

  /* ------------------------------------------------------------------ */
  /* Resolving — every metre comes from here, every frame                */
  /* ------------------------------------------------------------------ */

  /** The eight numbers baked into the thorn geometry. */
  _fillShape() {
    const c = settings.thornwake;
    const s = this._shape;
    s.sides = c.thornSides;
    s.taper = c.thornTaper;
    s.curve = c.thornCurve;
    s.barbs = c.thornBarbs;
    s.barbLength = c.thornBarbLength;
    s.barbTilt = c.thornBarbTilt;
    s.barbSpread = c.thornBarbSpread;
    s.rough = c.thornRough;
  }

  /** Everything the field resolves an instance's transform from. */
  _fillParams() {
    const c = settings.thornwake;
    const p = this._params;

    p.origin = this.origin;
    p.direction = this.direction;
    p.side = this.side;
    p.length = this.length;

    p.widthNear = c.widthNear;
    p.width = c.width;
    p.widthCurve = c.widthCurve;
    p.frontBias = c.frontBias;
    p.clumping = c.clumping;
    p.scatter = c.scatter;
    p.clusterRadius = c.clusterRadius;

    p.heightNear = c.heightNear;
    p.height = c.height;
    p.heightCurve = c.heightCurve;
    p.heightJitter = c.heightJitter;
    p.crown = c.crown;
    p.crownPower = c.crownPower;
    p.peak = c.peak;
    p.peakWidth = c.peakWidth;
    p.rubble = c.rubble;
    p.rubbleScale = c.rubbleScale;
    p.rubbleSpread = c.rubbleSpread;

    p.radiusNear = c.radiusNear;
    p.radius2 = c.radius2;
    p.radiusCurve = c.radiusCurve;
    p.radiusJitter = c.radiusJitter;

    p.lean = c.lean;
    p.leanJitter = c.leanJitter;
    p.leanRamp = c.leanRamp;
    p.leanForward = c.leanForward;
    p.leanOutward = c.leanOutward;
    p.twist = c.twist;
    p.tilt = c.tilt;

    p.riseTime = c.riseTime;
    p.riseOvershoot = c.riseOvershoot;
    p.settle = c.settle;
    p.springRate = c.springRate;
    p.emergeSink = c.emergeSink;
    p.birthScale = c.birthScale;
    p.birthFade = c.birthFade;
    p.breachAt = c.breachAt;
    p.sinkDepth = c.sinkDepth;

    p.randomness = settings.global.randomness;
    return p;
  }

  /** The shared filament look, pulled out of the `vine*` sliders. */
  _fillLook() {
    const c = settings.thornwake;
    const g = settings.global;
    const look = this._look;

    look.width = c.vineWidth;
    look.glowWidth = c.vineGlowWidth;
    look.glowOpacity = c.vineGlowOpacity;

    look.jitter = c.vineKink;
    look.jitterScale = c.vineKinkScale;
    look.octaves = c.vineOctaves;
    look.jitterFalloff = c.vineKinkFalloff;
    look.crawl = c.vineCrawl;
    look.pinch = c.vinePinch;
    look.restrike = c.vineRestrike;

    look.flicker = c.vineFlicker;
    look.flickerSpeed = c.vineFlickerSpeed;
    look.strandFlash = c.vineStrandFlash;

    look.coreSharp = c.vineCoreSharp;
    look.glowFalloff = c.vineGlowFalloff;
    look.softFade = c.vineSoftFade;

    look.opacity = c.vineOpacity;
    look.glow = c.vineGlow;
    look.colorCore = c.colorVineCore;
    look.colorInner = c.colorVineInner;
    look.colorOuter = c.colorVineOuter;
    look.colorHalo = c.colorVineHalo;

    look.randomness = g.randomness;
    look.noiseStrength = g.noiseStrength;
    look.noiseFrequency = g.noiseFrequency;
    look.noiseSpeed = g.noiseSpeed;
    look.opacityScale = g.opacity;
    look.glowScale = g.glow;
    return look;
  }

  /** Push the palette and every shading control into the bark. */
  _syncMaterial() {
    const c = settings.thornwake;
    const g = settings.global;
    const u = this.material.userData.uniforms;

    u.uColorBark.value.copy(getColor(c.colorBark));
    u.uColorHeart.value.copy(getColor(c.colorHeart));
    u.uColorMoss.value.copy(getColor(c.colorMoss));
    u.uColorTip.value.copy(getColor(c.colorTip));
    u.uColorSap.value.copy(getColor(c.colorSap));

    u.uGrain.value = c.barkGrain * g.shaderIntensity;
    u.uGrainScale.value = c.barkGrainScale * g.noiseFrequency;
    u.uMoss.value = c.mossAmount * g.shaderIntensity;
    u.uMossScale.value = c.mossScale * g.noiseFrequency;
    u.uTipStart.value = c.tipStart;
    u.uTipSharp.value = c.tipSharp;
    u.uTipGlow.value = c.tipGlow;
    // The fragment reconstructs the shaft profile, so it needs the same
    // exponent the geometry factory was built with — one uniform, not a guess.
    u.uTaper.value = c.thornTaper;
    u.uBarbEdge.value = c.barbEdge;
    u.uBarbSpan.value = c.barbSpan;
    u.uSapGlow.value = c.sapGlow;
    u.uGlow.value = c.barkGlow * g.glow;

    this.material.roughness = c.barkRough;
    this.material.opacity = c.barkOpacity * g.opacity;
  }

  /**
   * World height of a point `grip` of the way up thorn `index`, right now.
   *
   * This mirrors `GrowthField#update`'s PUSH placement rather than guessing at
   * it: an instance still coming out of the ground has its base pushed down by
   * `(emerge − 1) · height · emergeSink`, so a vine tied a third of the way up a
   * half-risen thorn has to ride that down or it floats in the air above one and
   * clips through the other.
   */
  _gripHeight(index, emerge, grip, p) {
    const height = this.field.heightOf(index, p);
    const settled = Math.min(1, Math.max(0, emerge));
    return height * ((settled - 1) * (p.emergeSink ?? 0.85) + grip * settled);
  }

  /* ------------------------------------------------------------------ */
  /* The weave                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Re-thread every vine from the live placement.
   *
   * The whole trick is in this method and it is deliberately dumb: no cached
   * pairs, no incremental update, no early-out on "nothing moved". Twelve vines
   * times a `vineReach` of five is sixty position reads a frame, which is
   * nothing next to being able to say that a paused field re-weaves itself under
   * any slider in the block.
   *
   * @param {number} fade 1 while the bramble stands, ramping to 0 as it withers
   */
  _syncVines(fade) {
    const c = settings.thornwake;
    const p = this._params;
    const look = this._fillLook();

    const count = this.field.count;
    const wanted = Math.max(0, Math.min(MAX_VINES, Math.round(c.vines)));
    const strands = Math.max(1, Math.min(MAX_VINE_STRANDS, Math.round(c.vineStrands)));
    const reach = Math.max(1, Math.min(MAX_THORNS - 1, Math.round(c.vineReach)));
    const maxSpan = Math.max(0.05, c.vineMaxSpan);
    const gate = c.vineBirth;
    const grow = Math.max(0.02, c.vineGrow);

    // How hard the weave is pulled. It slackens while the field is still coming
    // up and cinches once the front has landed, which is what makes the impact
    // read as the bramble *closing* rather than as one more thorn appearing.
    const cinch =
      this.phase === AbilityPhase.TRAVEL
        ? c.vineTaut
        : lerp(
            c.vineTaut,
            c.vineCinch,
            Easing.outCubic(saturate((this.age - this._cinchFrom) / Math.max(0.02, c.cinchTime)))
          );

    let live = 0;
    let strandTotal = 0;

    for (let v = 0; v < MAX_VINES; v++) {
      const role = this.weaves[(v / MAX_FILAMENT_ROLES) | 0].role(v % MAX_FILAMENT_ROLES);

      if (v >= wanted || count < 2) {
        role.retire();
        this._vineTime[v] = -1;
        continue;
      }

      // Where this vine roots. If its die lands on a thorn that is still buried
      // the search walks *backwards* down the index order, which is backwards
      // down the cast, because `plant` lays its records stratified along the
      // line and the field fills from the caster forward. So the fallback is
      // always the nearest thorn already standing *behind* the front, and the
      // weave chases the front out instead of waiting for the whole bed. The
      // first version simply retired a vine whose die landed ahead of the front,
      // and the result was a corridor of bare thorns that suddenly laced
      // together a third of a second after the cast landed.
      let a = Math.min(count - 1, Math.floor(this._vineStart[v] * count));
      let emergeA = this.field.emergenceOf(a, this.age, p);
      for (let k = 1; k < count && emergeA < gate; k++) {
        a = (a - 1 + count) % count;
        emergeA = this.field.emergenceOf(a, this.age, p);
      }
      if (emergeA < gate) {
        role.retire();
        this._vineTime[v] = -1;
        continue;
      }

      /* --- find a partner: the first neighbour whose live span fits --- */
      // The offset walk starts at a per-vine die so twelve vines rooted near
      // each other do not all reach for the same neighbour.
      this.field.positionOf(a, p, _va);
      _va.y += this._gripHeight(a, emergeA, c.vineGripLow, p);

      const first = 1 + Math.floor(this._vineStep[v] * reach);
      let b = -1;
      for (let k = 0; k < reach; k++) {
        const offset = 1 + ((first - 1 + k) % reach);
        const candidate = (a + offset) % count;
        if (candidate === a) continue;
        const e = this.field.emergenceOf(candidate, this.age, p);
        if (e < gate) continue;
        this.field.positionOf(candidate, p, _probe);
        _probe.y += this._gripHeight(candidate, e, c.vineGripHigh, p);
        if (_probe.distanceTo(_va) > maxSpan) continue;
        b = candidate;
        _vb.copy(_probe);
        break;
      }

      if (b < 0) {
        role.retire();
        this._vineTime[v] = -1;
        continue;
      }

      // The timestamp — an event, not a dimension. Only set on the frame the
      // pair first became threadable.
      if (this._vineTime[v] < 0) this._vineTime[v] = this.age;
      const drawn = saturate((this.age - this._vineTime[v]) / grow);

      role.count = strands;
      role.link(
        _va,
        _vb,
        c.vineSlack, //       metres of droop at mid-span when fully slack
        c.vineCurve, //       1 rope, 3 heavy chain
        c.vineSwing, //       metres of lateral sway
        c.vineSwingSpeed, //  radians/second of that sway
        saturate(cinch), //   0..1 tension
        c.vineSpread //       metres between the parallel strands
      );
      role.style(1, 1, 1, c.vineGroundDamp);
      role.ends(c.vineEndFade, c.vineEndFade, c.vineEndTaper, c.vineEndTaper);
      role.draw(drawn, c.vineTipLength, c.vineFloor, c.vineTipGlow * (1 - drawn));

      live++;
      strandTotal += strands;
    }

    for (let w = 0; w < WEAVES; w++) this.weaves[w].sync(look, fade, this._seed + w * 3.1);

    this._liveVines = live;
    this._liveStrands = strandTotal;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.thornwake;

    this.chaffEmitter.reset();
    this.moteEmitter.reset();
    this._seed = Math.random() * 100;
    this._cinchFrom = 1e9;

    for (let v = 0; v < MAX_VINES; v++) {
      this._vineStart[v] = Math.random();
      this._vineStep[v] = Math.random();
      this._vineTime[v] = -1;
    }

    this.field.plant(c.thorns, c.clusterShare);

    this._fillShape();
    this.field.syncGeometry(this._shape);
    this._syncMaterial();
    this._fillParams();
    this.field.update(this.age, this._params, 0);
    this._syncVines(1);
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** One thorn breaking the surface: chips, litter and a split in the floor. */
  _onBreach(index, position, radius, _height) {
    const c = settings.thornwake;
    const g = settings.global;
    const time = frame.uTime.value;

    _emit.position = position;
    _emit.radius = radius * 1.4;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.soilSpeed;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.85;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.7;
    _emit.life = c.soilLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 9;
    _emit.tint = null;
    _emit.time = time;
    this.soil.emit(Math.round(c.soilBreach * g.particleCount), _emit);

    _emit.speed = c.chaffSpeed;
    _emit.spread = 1.0;
    _emit.size = 0.18;
    _emit.life = c.chaffLifetime;
    _emit.spin = c.chaffSpin;
    this.chaff.emit(Math.round(c.chaffBreach * g.particleCount), _emit);

    this.ctx.decals.spawn(DecalType.DUSTRING, position, {
      radius: c.dustRadius * randRange(0.7, 1.3),
      life: c.dustLife,
      intensity: c.dustIntensity,
      colorA: getColor(c.colorDustA),
      colorB: getColor(c.colorDustB)
    });

    // Only some breaches split the floor. Every one of them doing it turns the
    // corridor into a solid mat of cracks and the individual events stop
    // reading — the same reason the arc burns under the bolt are rate-limited.
    if (hash11(index * 3.77 + this._seed) < c.crackChance) {
      this.ctx.decals.spawn(DecalType.CRACK, position, {
        radius: c.crackRadius * randRange(0.7, 1.4),
        life: c.crackLife,
        width: c.crackWidth,
        intensity: c.crackIntensity,
        colorA: getColor(c.colorCrackA),
        colorB: getColor(c.colorCrackB)
      });
    }
  }

  /** Continuous shed off the standing bed. */
  _fieldFx(dt, scale) {
    const c = settings.thornwake;
    const g = settings.global;
    const time = frame.uTime.value;
    // Only the part of the corridor the front has passed may shed.
    const reach = this.phase === AbilityPhase.TRAVEL ? Math.max(0.03, this.u) : 1;

    const chaffCount = Math.round(this.chaffEmitter.tick(dt, c.chaffRate * scale) * g.particleCount);
    if (chaffCount > 0) {
      const s = Math.random() * reach;
      this.pointAt(s, _pos);
      _pos.y = lerp(c.heightNear, c.height, s) * 0.55;
      _emit.position = _pos;
      _emit.radius = lerp(c.widthNear, c.width, s) * 1.1;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.chaffSpeed * 0.55;
      _emit.speedVariance = 0.85;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.16;
      _emit.sizeVariance = 0.7;
      _emit.life = c.chaffLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = c.chaffSpin;
      _emit.tint = null;
      _emit.time = time;
      this.chaff.emit(chaffCount, _emit);
    }

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      const s = Math.random() * reach;
      this.pointAt(s, _pos);
      _pos.y = lerp(c.heightNear, c.height, s) * 0.4;
      _emit.position = _pos;
      _emit.radius = lerp(c.widthNear, c.width, s) * 1.3;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = 1.0;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }
  }

  /** Push the live gradients and scales into the three systems. */
  _syncParticles() {
    const c = settings.thornwake;
    const g = settings.global;

    this.chaff.setGradient(
      getColor(c.colorChaffA),
      getColor(c.colorChaffB),
      getColor(c.colorChaffC),
      getColor(c.colorChaffD)
    );
    this.chaff.uniforms.uGravity.value.set(0, c.chaffGravity, 0);
    this.chaff.uniforms.uSizeScale.value = c.chaffSize * g.particleSize * 7;
    this.chaff.uniforms.uLifeScale.value = c.chaffLifetime * 0.5 * g.particleLifetime;
    this.chaff.uniforms.uSpeedScale.value = g.particleSpeed;
    this.chaff.uniforms.uOpacity.value = g.opacity;
    this.chaff.uniforms.uTurbulence.value = 0.5 * g.turbulence;

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
    this.motes.uniforms.uGlow.value = 0.8 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

    this.soil.setGradient(
      getColor(c.colorSoilA),
      getColor(c.colorSoilB),
      getColor(c.colorSoilC),
      getColor(c.colorSoilD)
    );
    this.soil.uniforms.uGravity.value.set(0, c.soilGravity, 0);
    this.soil.uniforms.uSizeScale.value = c.soilSize * g.particleSize * 7;
    this.soil.uniforms.uLifeScale.value = g.particleLifetime;
    this.soil.uniforms.uSpeedScale.value = g.particleSpeed;
    this.soil.uniforms.uOpacity.value = g.opacity;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.thornwake;
    const p = this._fillParams();

    this._fillShape();
    this.field.syncGeometry(this._shape);
    this._syncMaterial();
    this._syncParticles();

    this.field.triggerUpTo(this.age, this.u, c.riseStagger, c.frontBias, false);
    this.field.update(this.age, p, 0);
    this._syncVines(1);

    this._fieldFx(dt, 1);
    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.thornwake;
    const g = settings.global;
    const time = frame.uTime.value;

    // The knot at the end goes up now, and the weave starts pulling taut.
    this.field.triggerUpTo(this.age, 1, c.riseStagger, c.frontBias, true);
    this._cinchFrom = this.age;

    this.pointAt(1, _target);
    _pos.copy(_target).setY(c.height * 0.4);

    this.ctx.bursts.spawn(BurstMode.STORM, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.6,
      intensity: c.burstIntensity,
      opacity: 0.85,
      fresnel: 1.5,
      displace: 0.7,
      squash: 0.85,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.ctx.decals.spawn(DecalType.CRACK, _target, {
      radius: c.crackRadius * 3.2,
      life: c.crackLife * 1.3,
      width: c.crackWidth * 1.4,
      intensity: c.crackIntensity * 1.3,
      colorA: getColor(c.colorCrackA),
      colorB: getColor(c.colorCrackB)
    });
    this.ctx.decals.spawn(DecalType.DUSTRING, _target, {
      radius: c.dustRadius * 3.0,
      life: c.dustLife * 1.4,
      intensity: c.dustIntensity * 1.2,
      colorA: getColor(c.colorDustA),
      colorB: getColor(c.colorDustB)
    });

    _emit.position = _pos;
    _emit.radius = c.clusterRadius;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.chaffSpeed * 1.8;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.2;
    _emit.sizeVariance = 0.8;
    _emit.life = c.chaffLifetime * 1.3;
    _emit.lifeVariance = 0.6;
    _emit.spin = c.chaffSpin * 1.4;
    _emit.tint = null;
    _emit.time = time;
    this.chaff.emit(Math.round(c.burstChaff * g.particleCount), _emit);

    _emit.position = _target;
    _emit.radius = c.clusterRadius * 0.7;
    _emit.speed = c.soilSpeed * 1.6;
    _emit.size = 0.11;
    _emit.life = c.soilLifetime * 1.2;
    _emit.spin = 11;
    this.soil.emit(Math.round(c.burstSoil * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      20
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.6 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.thornwake;
    const p = this._fillParams();

    this._fillShape();
    this.field.syncGeometry(this._shape);
    this._syncMaterial();
    this._syncParticles();

    // `t` runs 0..1 while the bramble stands, then 1..2 while it withers. The
    // field sinks on the second half; the vines go with it and fade out cubic,
    // so the weave lets go a moment before the thorns are gone rather than being
    // clipped off flat at the floor.
    const retract = t <= 1 ? 0 : saturate(t - 1);
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(retract);

    // Anything the front never reached still comes up, so a cast at short range
    // does not leave half its bed buried.
    this.field.triggerUpTo(this.age, 1, c.riseStagger, c.frontBias, true);
    this.field.update(this.age, p, retract);
    this._syncVines(fade);

    this._fieldFx(dt, fade * (t <= 1 ? 0.55 : 0.2));

    // The light settles onto the knot at the far end.
    this.pointAt(1, this.position).setY(c.height * 0.35);
  }

  onDestroy() {
    this.field.clear();
    for (let w = 0; w < WEAVES; w++) this.weaves[w].clear();
    this._liveVines = 0;
    this._liveStrands = 0;
  }

  dispose() {
    this.field.dispose();
    for (let w = 0; w < WEAVES; w++) this.weaves[w].dispose();
    this.material.dispose();
    super.dispose();
  }
}
