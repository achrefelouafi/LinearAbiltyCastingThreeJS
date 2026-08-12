import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  MeshStandardMaterial,
  Vector3
} from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { GrowthField, GrowthEmerge, GrowthLayout, patchGrowthMaterial } from '../../vfx/GrowthField.js';
import { GroundField, GroundMode } from '../../vfx/GroundField.js';
import { noiseGLSL } from '../../shaders/lib/noise.glsl.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing } from '../../utils/math.js';

/** Hard ceiling on spears per cast. The `spearCount` slider clamps here. */
const MAX_SPEARS = 240;
const TAU = Math.PI * 2;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _shadowDir = new Vector3();
const _anchor = new Vector3();

/**
 * Live parameter objects for the two shared modules.
 *
 * Filled from `settings.umbralspears` every frame and handed straight over.
 * They are module scope rather than per-instance because four concurrent casts
 * of this ability fill and consume them inside their own `update()` call and
 * never across one — and one object per ability instance is three objects that
 * exist only to be identical.
 */
const _growth = {};
const _shape = {};
const _shadow = {};

/* ---------------------------------------------------------------------- */
/* One spear                                                               */
/* ---------------------------------------------------------------------- */
/**
 * A barbed blade, in `GrowthField`'s unit space: footprint inside a circle of
 * radius 0.5 on `y = 0`, tip at `y = 1`.
 *
 * Five rings and an apex. The ring that matters is the **barb** — a single ring
 * pushed back out past the shoulder a third of the way up. Without it the
 * silhouette is a cone, and a field of cones reads as a fence; with it there is
 * a hard shoulder line that catches the rim and the whole thing reads as a
 * weapon. It is also the only part of the profile that is not monotonic, which
 * is why it survives being seen as pure outline: a black shape against a lit
 * floor has nothing but its outline to say anything with.
 *
 * `twist` rotates each ring's bearings a little further round than the last, so
 * the facets run up the blade as flutes rather than as straight prism edges. At
 * zero it is a plain faceted spike, and that is a perfectly good look too.
 *
 * @param {number} variant  which of the three silhouettes
 * @param {object} shape    `{ sides, taper, barb, barbAt, rough, twist }`, live
 */
function createSpearGeometry(variant, shape) {
  const seed = 3.1 + variant * 27.7;
  const sides = Math.max(4, Math.min(8, Math.round(shape?.sides ?? 5)));
  const taper = Math.max(0.02, Math.min(0.8, shape?.taper ?? 0.16));
  const barb = Math.max(0.2, Math.min(2, shape?.barb ?? 1.25));
  const barbAt = Math.max(0.05, Math.min(0.8, shape?.barbAt ?? 0.3));
  const rough = Math.max(0, Math.min(1, shape?.rough ?? 0.34));
  const twist = shape?.twist ?? 0.35;

  const hash = (n) => {
    const s = Math.sin(n * 127.1) * 43758.5453;
    return s - Math.floor(s);
  };

  // Rings: floor, shoulder, barb, waist, neck — then the apex.
  const ringY = [0, barbAt * 0.35, barbAt, lerp(barbAt, 1, 0.45), lerp(barbAt, 1, 0.8)];
  const ringR = [0.5 * 0.72, 0.5, 0.5 * barb, 0.5 * Math.max(taper, 0.03) * 1.6, 0.5 * Math.max(taper, 0.03) * 0.55];

  const rings = ringY.map((y, ring) => {
    const spin = twist * TAU * y;
    const points = [];
    for (let i = 0; i < sides; i++) {
      const wobble = (hash(seed * 3.13 + i * 7.7) - 0.5) * (TAU / sides) * 0.5 * rough * 2;
      const angle = (i / sides) * TAU + wobble + spin;
      const chip = 1 + (hash(seed * 11.1 + ring * 13.7 + i * 3.9) - 0.5) * rough * 1.2 * (0.3 + 0.7 * y);
      const r = Math.max(0.003, ringR[ring] * chip);
      points.push([Math.cos(angle) * r, y, Math.sin(angle) * r]);
    }
    return points;
  });

  const positions = [];
  const push = (p) => positions.push(p[0], p[1], p[2]);

  for (let ring = 0; ring < rings.length - 1; ring++) {
    const lower = rings[ring];
    const upper = rings[ring + 1];
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      push(lower[i]); push(lower[j]); push(upper[i]);
      push(lower[j]); push(upper[j]); push(upper[i]);
    }
  }

  const apex = [
    (hash(seed * 17.3) - 0.5) * 0.06 * rough,
    1,
    (hash(seed * 19.7) - 0.5) * 0.06 * rough
  ];
  const floor = [0, 0, 0];
  const neck = rings[rings.length - 1];
  const base = rings[0];
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    push(neck[i]); push(neck[j]); push(apex);
    push(floor); push(base[j]); push(base[i]);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  // Non-indexed + per-face normals. Flat facets are what give a pure-silhouette
  // object its only interior line: the rim breaks along every hard edge.
  geometry.computeVertexNormals();
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* The rim-only shading model                                              */
/* ---------------------------------------------------------------------- */
/**
 * A material with **no diffuse, no specular and no emission except a rim**.
 *
 * The trick is one line of setup rather than a pile of shader code:
 * `metalness: 1` with a near-black colour. In the standard BRDF a metal has no
 * diffuse lobe at all (`diffuse = albedo × (1 − metalness)`) and its specular
 * F0 *is* its albedo — so a black metal reflects nothing and scatters nothing,
 * and the only thing left in the sum is `totalEmissiveRadiance`. The first
 * version tried to get there with `metalness: 0` and a black colour instead,
 * and it did not work: a dielectric keeps an F0 of 0.04 whatever its albedo, so
 * every spear had a soft white sheen sliding over it and the field read as wet
 * plastic. The probe is switched off outright for the same reason — an
 * anti-glow object that picks up the sky is a dark object with a bright sky
 * on it.
 *
 * That leaves the rim carrying the entire read, and the rim is authored as a
 * **line, not a wash**: a tight fresnel with a wider, softer copy of itself
 * subtracted back off, biased toward the face turned away from
 * `frame.uLightDir`, weighted toward the tip in the spear's own local space,
 * and eaten into by world-space grain so it is pitted rather than drawn.
 *
 * **The bloom guard.** `PostProcessing` runs `UnrealBloomPass` on the linear
 * HDR buffer *before* `OutputPass` tone maps, at `post.bloomThreshold` = 0.88.
 * Anything this material emits above that number gets smeared across the
 * silhouette the ability exists to protect — and a rim is exactly the
 * high-frequency, high-contrast edge bloom is worst on. So the assembled rim is
 * run through a Reinhard rolloff whose asymptote is `uRimCeiling`
 * (`x / (1 + x/c)` → `c`), which means it *provably* cannot reach the
 * threshold, while the bottom of `rimGain`'s range is left essentially
 * untouched so the slider still does what it looks like it does. A hard
 * `min()` was the first attempt and it flattened the top half of the slider
 * into a dead zone.
 */
function createUmbralMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0x050308,
    roughness: 0.95,
    metalness: 1.0,
    flatShading: true,
    transparent: false,
    depthWrite: true
  });
  material.envMapIntensity = 0;

  const uniforms = {
    uLightDir: frame.uLightDir,
    uColorBody: { value: new Color() },
    uColorRim: { value: new Color() },
    uColorBirth: { value: new Color() },
    uRimPower: { value: 4.2 },
    uRimInner: { value: 0.55 },
    uRimGain: { value: 1.35 },
    uRimCeiling: { value: 0.82 },
    uRimShadowBias: { value: 0.6 },
    uRimTip: { value: 0.45 },
    uRimGrain: { value: 0.5 },
    uRimGrainScale: { value: 7.5 },
    uBirthRim: { value: 0.9 },
    /** Whole-field rim punch when the front lands. Decays on the ability's clock. */
    uImpactRim: { value: 0 }
  };

  patchGrowthMaterial(material, {
    environment,
    uniforms,
    common: /* glsl */ `
      uniform vec3  uLightDir;
      uniform vec3  uColorBody;
      uniform vec3  uColorRim;
      uniform vec3  uColorBirth;
      uniform float uRimPower;
      uniform float uRimInner;
      uniform float uRimGain;
      uniform float uRimCeiling;
      uniform float uRimShadowBias;
      uniform float uRimTip;
      uniform float uRimGrain;
      uniform float uRimGrainScale;
      uniform float uBirthRim;
      uniform float uImpactRim;
      ${noiseGLSL}
    `,
    fragment: /* glsl */ `
      vec3  N   = normalize(normal);
      float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);

      // A line, not a wash. Subtracting a wider, softer copy of the same
      // fresnel is what pushes the band out to the very edge of the
      // silhouette; a bare pow() covers half the spear and reads as a glow.
      float wide = pow(1.0 - ndv, max(uRimPower * 0.45, 0.05));
      float rim  = clamp(pow(1.0 - ndv, uRimPower) - uRimInner * wide, 0.0, 1.0);

      // Brightest on the side the key light is not, because these come up out
      // of the caster's shadow and the lit face is the one that stays black.
      float away = clamp(0.5 - 0.5 * dot(N, uLightDir), 0.0, 1.0);
      rim *= mix(1.0, away, uRimShadowBias);

      // Tip weighting in LOCAL space, so it follows each spear's own axis
      // however that spear is scaled and leaned. In world space this became a
      // horizontal band across the whole field at one height, which is a very
      // fast way to make forty objects look like one object.
      rim *= mix(1.0, clamp(vGrowLocal.y, 0.0, 1.0), uRimTip);

      // Erosion in WORLD space, so neighbouring spears are pitted out of the
      // same block of darkness rather than each carrying an identical copy.
      float pit = fbm3(vGrowWorld * uRimGrainScale + vGrowSeed * 7.0) * 0.5 + 0.5;
      rim *= mix(1.0, pit, uRimGrain);

      vec3 glow = uColorRim * rim * (uRimGain + uImpactRim);
      glow += uColorBirth * vGrowBirth * uBirthRim * (0.25 + 0.75 * rim);

      // THE BLOOM GUARD — see the doc comment. Reinhard with its asymptote at
      // uRimCeiling: it can never reach post.bloomThreshold, and it leaves the
      // bottom of the range alone so the gain slider stays honest.
      glow = glow / (1.0 + glow / max(uRimCeiling, 1e-3));

      // metalness is 1, so this is F0 and nothing else: the body reflects
      // almost nothing and scatters nothing at all.
      diffuseColor.rgb = uColorBody;

      totalEmissiveRadiance += glow;
    `
  });

  material.userData.uniforms = uniforms;

  /** Pull the palette and every rim control from the live settings. */
  material.userData.sync = (impactRim) => {
    const c = settings.umbralspears;
    const g = settings.global;

    uniforms.uColorBody.value.copy(getColor(c.colorBody));
    uniforms.uColorRim.value.copy(getColor(c.colorRim));
    uniforms.uColorBirth.value.copy(getColor(c.colorBirth));

    uniforms.uRimPower.value = c.rimPower;
    uniforms.uRimInner.value = c.rimInner;
    uniforms.uRimGain.value = c.rimGain * g.glow;
    uniforms.uRimCeiling.value = c.rimCeiling;
    uniforms.uRimShadowBias.value = c.rimShadowBias * g.fresnel;
    uniforms.uRimTip.value = c.rimTip;
    uniforms.uRimGrain.value = c.rimGrain * g.shaderIntensity;
    uniforms.uRimGrainScale.value = c.rimGrainScale * g.noiseFrequency;
    uniforms.uBirthRim.value = c.birthRim;
    uniforms.uImpactRim.value = impactRim;
  };

  material.userData.sync(0);
  return material;
}

/* ---------------------------------------------------------------------- */
/* The ability                                                             */
/* ---------------------------------------------------------------------- */

/**
 * UMBRAL SPEARS — a line of blades that comes up out of the caster's shadow.
 *
 * One beat, short: a front runs the aimed line at `speed` and near-black spears
 * punch out of the floor behind it, a ring of them thrown up around the impact
 * point. They stand for `lifetime` and withdraw.
 *
 * **THE TRICK — anti-glow.** Every other slot in this sandbox is competing for
 * the bloom pass's attention. This one is the only thing on screen *darker than
 * the floor*, and it is built out of three decisions that all point the same
 * way:
 *
 *  1. **No shading model.** `metalness: 1` on a near-black colour removes the
 *     diffuse lobe and drops F0 to the body colour, so there is no diffuse, no
 *     specular and no probe. What is left is a silhouette. See
 *     `createUmbralMaterial` for why `metalness: 0` does not get you there.
 *  2. **The rim is the only bright thing in the ability.** Both particle
 *     systems are non-additive, there is no burst shell, no screen flash and no
 *     additive ground mark; the impact is expressed as a punch of *rim* that
 *     decays over `impactRimTime`, which is the one lever this slot allows
 *     itself. The rim itself is rolled off so the bloom pass can never reach
 *     it — the guard is documented on the material.
 *  3. **The shadow is subtractive.** The band pooled under the field is a
 *     `GroundField` in RUT mode with `additive: false`, so it genuinely shades
 *     the flagstones. An additive mark would have brightened the floor under a
 *     black object, which is the exact inverse of the effect and is what the
 *     first version did.
 *
 * **Where `frame.uLightDir` comes in.** The scene's key direction decides which
 * way a shadow points, so it decides three things here: the band on the floor
 * is offset `shadowOffset` metres along the horizontal projection of
 * `-uLightDir`, the spears' forward lean is steered by how much of that
 * direction lies along the cast (`shadowLean`), and in the fragment shader the
 * rim prefers the face turned away from the light. All three are re-read every
 * frame; none of them is captured.
 *
 * **The rule that makes the editor work.** `GrowthField` holds the field, and a
 * record in it is dice rolls and one timestamp — the whole point of that
 * module. Every metre, radian and second lands in `_growth` from
 * `settings.umbralspears` inside the update loop, on a zero-length frame
 * included, so pausing mid-cast and dragging `height` re-grows a field that is
 * already standing and dragging `shadowOffset` slides its shadow out from under
 * it.
 */
export class UmbralSpearsAbility extends Ability {
  constructor(context) {
    super('umbralspears', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.material = createUmbralMaterial(this.ctx.environment);

    this._fillShape();
    this.field = new GrowthField(this.group, {
      geometry: createSpearGeometry,
      material: this.material,
      shape: _shape,
      variants: 3,
      capacity: MAX_SPEARS,
      layer: LAYER.WORLD,
      renderOrder: 2,
      // castShadow is doing real work here and is half of the pooled shadow:
      // CSM already draws these silhouettes onto the floor in the scene's own
      // key direction, for free, and the authored band below only has to
      // deepen and unify what the shadow map is already putting there.
      // receiveShadow is off because there is nothing to receive onto — the
      // body has no diffuse lobe at all.
      castShadow: true,
      receiveShadow: false
    });
    // Assigned once, here, and never rebuilt: a closure created inside the
    // update loop is an allocation per instance per frame (I3).
    this.field.onBreach = (index, position, radius, height) =>
      this._onBreach(index, position, radius, height);

    /**
     * The shadow pooled at the bases.
     *
     * RUT rather than POOL, and the reason is the shape of a line cast: POOL is
     * a disc about one centre, and a disc wide enough to cover an eighteen-metre
     * band darkens half the arena. RUT is a *track* — it has a length, a
     * half-width and a `progress` that follows the front — and it carries a list
     * of contact marks, which is exactly the mechanism needed to pool the
     * darkness under each spear instead of laying an even stripe.
     */
    this.shadow = new GroundField(this.group, {
      mode: GroundMode.RUT,
      marks: 16,
      additive: false,
      depthTest: true,
      name: 'UmbralShadow'
    });

    /** Seconds since the front landed, or -1. Drives the rim punch. */
    this._impactAt = -1;
    /** A dice roll, so two casts do not wobble their shadow identically. */
    this._seed = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Dark haze pooling around the bases. Non-additive, and that is not a
    // detail: an additive haze around a black object is a grey object.
    this.gloom = particles.get('umbralspears.gloom', {
      capacity: 2400,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.2
    });
    this.gloom.uniforms.uDrag.value = 2.0;
    this.gloom.uniforms.uEndSize.value = 2.8;
    this.gloom.uniforms.uSizeIn.value = 0.14;
    this.gloom.uniforms.uFadeIn.value = 0.2;
    this.gloom.uniforms.uFadeOut.value = 0.35;

    // Chips kicked off the floor as a spear breaks through. Lit, so they take
    // the stage's own key — they are the one part of this ability that is
    // allowed to look like it is in the room rather than cut out of it.
    this.grit = particles.get('umbralspears.grit', {
      capacity: 1800,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.grit.uniforms.uDrag.value = 0.28;
    this.grit.uniforms.uEndSize.value = 0.8;
    this.grit.uniforms.uFadeOut.value = 0.7;

    this.gloomEmitter = new RateEmitter();
    this.gritEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.field.count;
  }

  get impactDuration() {
    return Math.max(0.1, settings.umbralspears.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    const c = settings.umbralspears;
    return Math.max(0.1, c.sinkDelay + c.sinkTime);
  }

  /** Nothing about this ability flickers. Darkness is steady. */
  lightShimmer() {
    return 1;
  }

  /* ------------------------------------------------------------------ */
  /* The shadow direction                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Where the caster's shadow points, flat and unit — the horizontal projection
   * of `-frame.uLightDir`.
   *
   * Read fresh every frame rather than captured. It is the environment's key
   * direction, so if the sun moves the spears re-lean and their shadow band
   * slides round with it, paused included.
   */
  _shadowDirection(out) {
    out.copy(frame.uLightDir.value).multiplyScalar(-1).setY(0);
    // Sun directly overhead: there is no shadow bearing to have, so fall back
    // to the cast heading rather than normalising a zero vector into NaN.
    if (out.lengthSq() < 1e-6) out.copy(this.direction);
    return out.normalize();
  }

  /* ------------------------------------------------------------------ */
  /* Live parameters                                                     */
  /* ------------------------------------------------------------------ */

  /** The geometry factory's shape controls. Handed to `syncGeometry`. */
  _fillShape() {
    const c = settings.umbralspears;
    _shape.sides = c.spearSides;
    _shape.taper = c.spearTaper;
    _shape.barb = c.spearBarb;
    _shape.barbAt = c.spearBarbAt;
    _shape.rough = c.spearRough;
    _shape.twist = c.spearTwist;
    return _shape;
  }

  /**
   * Everything `GrowthField` needs, re-resolved. This is the whole of invariant
   * I1 for this ability: not one number below survives a frame.
   */
  _fillGrowth() {
    const c = settings.umbralspears;
    const g = settings.global;
    const p = _growth;

    p.layout = GrowthLayout.LINE;
    p.emerge = GrowthEmerge.PUSH;
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
    p.minHeight = c.minHeight;

    p.radiusNear = c.radiusNear;
    p.radius2 = c.radius2;
    p.radiusCurve = c.radiusCurve;
    p.radiusJitter = c.radiusJitter;
    p.minRadius = c.minRadius;

    // The one derived number in the block, and the derivation is the point:
    // how much of the shadow's bearing lies along the cast decides how far
    // downrange the blades tip. Cast into the light and they lean back at you.
    const along = this._shadowDirection(_shadowDir).dot(this.direction);
    p.lean = c.lean;
    p.leanJitter = c.leanJitter;
    p.leanRamp = c.leanRamp;
    p.leanForward = c.leanForward + along * c.shadowLean;
    p.leanOutward = c.leanOutward;
    p.twist = c.twist;
    p.tilt = c.tilt;

    p.baseHeight = 0;
    p.baseJitter = 0;

    p.riseTime = c.riseTime;
    p.riseOvershoot = c.riseOvershoot;
    p.settle = c.settle;
    p.springRate = c.springRate;
    p.emergeSink = c.emergeSink;
    p.birthScale = c.birthScale;
    p.birthFade = c.birthFade;
    p.breachAt = c.breachAt;
    p.sinkDepth = c.sinkDepth;

    p.randomness = g.randomness;
    return p;
  }

  /**
   * The shadow band. Offset along the shadow bearing, `progress` chasing the
   * front, and a `fade` that follows the field down as it withdraws.
   */
  _fillShadow(front, fade) {
    const c = settings.umbralspears;
    const g = settings.global;
    const p = _shadow;

    this._shadowDirection(_shadowDir);
    _anchor.copy(this.origin).addScaledVector(_shadowDir, c.shadowOffset);

    p.centre = _anchor;
    p.yaw = Math.atan2(this.direction.x, this.direction.z);
    p.height = c.shadowHeight;
    p.length = this.length;
    // RUT does not use the radius for its own coverage, but it *does* pad the
    // quad with it — so it has to be the band, not the cast, or the shadow
    // arrives on a canvas four times the size it needs.
    p.radius = c.shadowWidth * 2.2;
    p.width = c.shadowWidth;
    p.progress = front;
    p.grow = 1;
    p.recede = 0;
    p.fade = fade;
    p.seed = this._seed;

    p.edge = c.shadowEdge;
    p.ragged = c.shadowRagged;
    p.raggedScale = c.shadowRaggedScale;
    p.warp = c.shadowWarp;

    // A shadow is flat. `relief` is left barely on rather than at zero purely
    // so the pooled patches have an edge you can find; turned up it becomes a
    // trench, which is a different ability.
    p.relief = c.shadowRelief;
    p.normalStep = 0.08;
    p.ambient = c.shadowAmbient;
    p.wrap = 0.6;
    p.specular = 0;
    p.gloss = 24;
    p.parallax = 0;

    p.depth = c.shadowDepth;
    // No spoil ridges: earth thrown out of a rut has a lip and a shadow does
    // not, so `lift` is pinned at zero and `thickness` only feeds the padding.
    p.lift = 0;
    p.thickness = 0.02;
    p.seam = c.shadowPool;
    p.cell = 1;
    p.sharp = c.shadowSharp;
    p.detail = 0;
    p.swirl = c.shadowWander;
    p.speed = 1;
    p.flow = 0;
    p.windAngle = 0;

    p.markLife = c.shadowMarkLife;
    p.markRadius = c.shadowWidth;

    p.additive = false;
    p.emissive = c.shadowEmissive * g.glow;
    p.opacity = c.shadowOpacity;
    p.depthFade = 0.4;
    p.colorBase = c.colorShadow;
    p.colorDeep = c.colorShadowDeep;
    p.colorEdge = c.colorShadowEdge;
    p.colorGlow = c.colorShadowFront;

    p.noiseStrength = g.noiseStrength;
    p.noiseFrequency = g.noiseFrequency;
    p.noiseSpeed = g.noiseSpeed;
    p.opacityScale = g.opacity;
    return p;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.umbralspears;

    this.gloomEmitter.reset();
    this.gritEmitter.reset();
    this._impactAt = -1;
    this._seed = Math.random() * 100;

    this.shadow.clearMarks();
    this.shadow.setVisible(true);
    this.field.plant(Math.min(MAX_SPEARS, Math.max(1, Math.round(c.spearCount))), c.clusterShare);

    this._sync(0, 0, 1);
  }

  /**
   * Chips and a pool of darkness where a spear breaks the surface.
   *
   * The mark is the point: `z` is where this spear is along the track and
   * `strength` is how big it is, both unitless, so the pooling re-places *and*
   * re-scales itself when `shadowWidth` or the cast length moves. Nothing here
   * writes down a metre.
   */
  _onBreach(index, position, radius, height) {
    const c = settings.umbralspears;
    const g = settings.global;

    const s = saturate(_pos.copy(position).sub(this.origin).dot(this.direction) / this.length);
    this.shadow.mark(0, s, this.age, saturate(0.35 + height / Math.max(0.1, c.height)));

    _emit.position = _pos.copy(position).setY(0.05);
    _emit.radius = radius * 1.4;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.25).setY(1).normalize();
    _emit.speed = c.gritSpeed;
    _emit.speedVariance = 0.75;
    _emit.spread = 0.8;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.09;
    _emit.sizeVariance = 0.7;
    _emit.life = c.gritLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 7;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.grit.emit(Math.round(c.breachGrit * g.particleCount), _emit);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /** How much extra rim the impact punch is still worth, 0 when it is spent. */
  _impactRim() {
    const c = settings.umbralspears;
    if (this._impactAt < 0) return 0;
    const k = saturate((this.age - this._impactAt) / Math.max(0.05, c.impactRimTime));
    return c.impactRim * (1 - Easing.outQuad(k));
  }

  /**
   * Re-resolve everything and rebuild the field.
   * @param {number} front   0..1, how far the front has travelled
   * @param {number} retract 0..1, the field withdrawing into the floor
   * @param {number} fade    0..1 on the shadow band
   */
  _sync(front, retract, fade) {
    this.material.userData.sync(this._impactRim());

    this.field.syncGeometry(this._fillShape());
    this.field.update(this.age, this._fillGrowth(), retract);
    this.shadow.update(this._fillShadow(front, fade));

    this._syncParticles();
  }

  _syncParticles() {
    const c = settings.umbralspears;
    const g = settings.global;

    this.gloom.setGradient(
      getColor(c.colorGloomA),
      getColor(c.colorGloomB),
      getColor(c.colorGloomC),
      getColor(c.colorGloomD)
    );
    this.gloom.uniforms.uGravity.value.set(0, c.gloomRise, 0);
    this.gloom.uniforms.uSizeScale.value = c.gloomSize * g.particleSize;
    this.gloom.uniforms.uLifeScale.value = c.gloomLifetime * 0.5 * g.particleLifetime;
    this.gloom.uniforms.uSpeedScale.value = c.gloomSpeed * g.particleSpeed;
    this.gloom.uniforms.uOpacity.value = c.gloomOpacity * g.opacity;
    this.gloom.uniforms.uTurbulence.value = 0.35 * g.turbulence;

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
  }

  /** Haze rolling off whatever part of the field exists. */
  _gloomFx(dt, reach, scale) {
    const c = settings.umbralspears;
    const g = settings.global;
    const count = Math.round(this.gloomEmitter.tick(dt, c.gloomRate * scale) * g.particleCount);
    if (count <= 0) return;

    const s = Math.random() * Math.max(0.02, reach);
    this.pointAt(s, _pos).setY(0.16);
    // Pushed toward the shadow side, because that is where a shadow's own murk
    // would collect. Drifting it up the middle read as fog, not as gloom.
    _pos.addScaledVector(this._shadowDirection(_shadowDir), c.shadowOffset * 0.5);

    _emit.position = _pos;
    _emit.radius = lerp(c.widthNear, c.width, s);
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.gloomSpeed;
    _emit.speedVariance = 0.7;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.9;
    _emit.sizeVariance = 0.5;
    _emit.life = c.gloomLifetime;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.4;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.gloom.emit(count, _emit);
  }

  /**
   * The trickle of grit still coming off the blades after they have arrived.
   *
   * Separate from the breach burst on purpose: the burst is an *event* and this
   * is a state, and running both off `breachGrit` meant that turning the arrival
   * down also turned off the settling, which is the part that keeps a standing
   * field from looking like it was placed there rather than pushed up.
   */
  _gritFx(dt, reach, scale) {
    const c = settings.umbralspears;
    const g = settings.global;
    const count = Math.round(this.gritEmitter.tick(dt, c.gritRate * scale) * g.particleCount);
    if (count <= 0) return;

    const s = Math.random() * Math.max(0.02, reach);
    this.pointAt(s, _pos).setY(0.05);
    _emit.position = _pos;
    _emit.radius = lerp(c.widthNear, c.width, s);
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.gritSpeed * 0.4;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.7;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.07;
    _emit.sizeVariance = 0.7;
    _emit.life = c.gritLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 6;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.grit.emit(count, _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.umbralspears;
    this.field.triggerUpTo(this.age, this.u, c.riseStagger, c.frontBias, false);
    this._sync(this.u, 0, 1);
    this._gloomFx(dt, this.u, 1);
    this._gritFx(dt, this.u, 1);

    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.umbralspears;
    const g = settings.global;

    // Everything still buried goes up now, the terminal ring included.
    this.field.triggerUpTo(this.age, 1, c.riseStagger, c.frontBias, true);
    this._impactAt = this.age;

    // No burst shell, no screen flash. The impact is a punch of *rim* — the
    // only bright thing this ability owns — plus chips and a knock. Every
    // version of this that added a shell put a bright ball in the middle of a
    // field of black spears and lost the field.
    this.pointAt(1, _pos).setY(0.08);
    _emit.position = _pos;
    _emit.radius = c.width * 0.8;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.35).setY(1).normalize();
    _emit.speed = c.gritSpeed * 1.7;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.75;
    _emit.life = c.gritLifetime * 1.3;
    _emit.lifeVariance = 0.5;
    _emit.spin = 9;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.grit.emit(Math.round(c.impactGrit * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      21
    );
    this.lightBoost = c.lightIntensity * 0.7 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.umbralspears;

    let retract = 0;
    if (this.phase === AbilityPhase.FADE) {
      retract = saturate((this.fadeTime - c.sinkDelay) / Math.max(0.05, c.sinkTime));
    }
    // The band goes with the spears rather than before them: a shadow that
    // outlives the thing casting it is a stain.
    this._sync(1, retract, 1 - Easing.inQuad(retract));

    this.pointAt(1, this.position);
    if (retract < 0.7) {
      this._gloomFx(dt, 1, t <= 1 ? 0.7 : 0.35);
      this._gritFx(dt, 1, t <= 1 ? 0.4 : 0.15);
    }
  }

  onDestroy() {
    this.field.clear();
    this.shadow.clearMarks();
    this.shadow.setVisible(false);
    this._impactAt = -1;
  }

  dispose() {
    this.field.dispose();
    this.shadow.dispose();
    this.material.dispose();
    super.dispose();
  }
}
