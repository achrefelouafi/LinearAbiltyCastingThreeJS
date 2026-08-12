import { BufferGeometry, Color, Float32BufferAttribute, MeshStandardMaterial, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { GrowthField, GrowthLayout, growthParams, patchGrowthMaterial } from '../../vfx/GrowthField.js';
import { ShatterField, ShatterLayout, shatterParams } from '../../vfx/ShatterField.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { noiseGLSL } from '../../shaders/lib/noise.glsl.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing } from '../../utils/math.js';

const TAU = Math.PI * 2;

/** Hard ceiling on blades in one bloom. The `shards` slider clamps here. */
const MAX_SHARDS = 120;
/** Distinct blade silhouettes — the number `GrowthField` argues for, and why. */
const VARIANTS = 3;
/** Distinct flake silhouettes. Two is `ShatterField`'s own recommendation. */
const FLAKE_VARIANTS = 2;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _growth = growthParams();
const _shatter = shatterParams();
const _glaze = groundFieldParams();
const _flakeLook = {
  colorA: new Color(),
  colorB: new Color(),
  colorEdge: new Color(),
  colorScene: new Color(),
  opacity: 1,
  glow: 1,
  rim: 1,
  rimPower: 2.4,
  shade: 1,
  ambient: 0.3,
  fadeStart: 0.6,
  soft: 0.3,
  sceneMix: 0,
  refract: 0.4,
  saturation: 0.35
};

/** Deterministic 0..1 hash, so a rebuilt blade is the *same* blade. */
function hash1(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

/* ---------------------------------------------------------------------- */
/* One blade — conchoidal fracture, in the mesh                            */
/* ---------------------------------------------------------------------- */
/**
 * A shard of volcanic glass, in `GrowthField`'s unit space: footprint inside a
 * circle of radius 0.5 on `y = 0`, terminal point at `y = 1`.
 *
 * **This function is the ability.** Every other rock in this project is built
 * the same way — a lofted prism, non-indexed, `computeVertexNormals()`, one flat
 * normal per triangle — because every other rock in this project has a crystal
 * structure to cleave along and flat is *right* for it. Obsidian has none. It is
 * a supercooled liquid, so a fracture in it is a **conchoidal** one: a smooth
 * curved shell, concave, with concentric rib marks radiating out from wherever
 * the blow landed. That is the same fracture you see on a flint arrowhead or the
 * lip of a broken bottle, and once you have seen it you cannot see a faceted
 * black crystal as glass again.
 *
 * Four decisions make it, and three of them are about *where the vertices go*
 * rather than about shading:
 *
 * 1. **A face is a grid, not a quad.** Each of the `sides` faces is subdivided
 *    `arc` × `rings` and each interior vertex is pushed *inward* by `dish`. The
 *    push is `sin(pi·u)`-weighted across the face so it vanishes exactly at both
 *    arrises, which keeps the shard watertight and keeps the edges razor sharp —
 *    curved faces meeting in hard edges is the whole silhouette of knapped
 *    glass, and it is why obsidian was worth carrying across a continent.
 * 2. **The dish is deepest one radius from the initiation point, not at the
 *    centre of the face.** `d·e^(1−d)` peaks at `d = 1` and shallows past it,
 *    with `d` measured from `(u = 0.5, v = dishBias)` — the point of impact. A
 *    scar that is deepest in the middle of the face is a spoon; a scar that
 *    deepens away from a corner and then flattens out is a fracture.
 * 3. **The rib marks are concentric about that same point.**
 *    `sin(d · ripplePitch · 2π)` and nothing else. They are small — four per cent
 *    of the radius — and they are the reason a highlight *travels* across a face
 *    as the camera moves instead of sitting still on it. This is the one part
 *    that could have been faked with a normal map, and invariant I2 forbids the
 *    texture anyway; doing it in the mesh also means it survives at the
 *    silhouette, where a normal map would give itself away instantly.
 * 4. **Indexed per face, smooth-shaded.** Each face owns its own vertices, so
 *    `computeVertexNormals()` averages *within* a face and cannot average
 *    across one. Smooth inside, hard at every arris. The first version was
 *    non-indexed like `PetrifyAbility`'s plates and it came out as a perfectly
 *    ordinary faceted crystal: all the curvature was in the silhouette and none
 *    of it was in the shading, which is exactly backwards, because on glass the
 *    curvature *is* the shading.
 *
 * The radius at each height is precomputed **per bearing**, not per face, so the
 * two faces meeting at an arris read the identical radius there. Jittering the
 * radius per face instead was the first attempt and it split the shard open
 * along every edge — a hairline crack you can see through, on every instance.
 *
 * @param {number} seed   deterministic shape seed; the variant index moves it
 * @param {object} shape  live shape params — see `_fillShape()`
 */
function createConchoidalGeometry(seed, shape) {
  const sides = clampInt(shape?.sides ?? 6, 4, 9);
  const rings = clampInt(shape?.rings ?? 5, 2, 8);
  const arc = clampInt(shape?.arc ?? 3, 2, 6);
  const taper = Math.max(0.01, Math.min(0.9, shape?.taper ?? 0.14));
  const tipCurve = Math.max(0.2, shape?.tipCurve ?? 1.7);
  const tipRise = Math.max(0.01, Math.min(0.6, shape?.tipRise ?? 0.15));
  const bulge = Math.max(0, Math.min(1, shape?.bulge ?? 0.22));
  const dish = Math.max(0, Math.min(0.95, shape?.dish ?? 0.3));
  const dishBias = Math.max(0, Math.min(1, shape?.dishBias ?? 0.18));
  const dishStretch = Math.max(0.1, shape?.dishStretch ?? 1.35);
  const ripple = Math.max(0, Math.min(0.4, shape?.ripple ?? 0.045));
  const ripplePitch = Math.max(0, shape?.ripplePitch ?? 2.6);
  const shear = shape?.shear ?? 0.32;
  const chip = Math.max(0, Math.min(1, shape?.chip ?? 0.3));

  /** Where the faces hand over to the terminal point. */
  const capBase = 1 - tipRise;

  /* --- the bearings, jittered once and shared by every ring --- */
  const angles = new Float64Array(sides + 1);
  for (let k = 0; k < sides; k++) {
    const wobble = (hash1(seed * 3.13 + k * 7.7) - 0.5) * (TAU / sides) * 0.55;
    angles[k] = (k / sides) * TAU + wobble;
  }
  angles[sides] = angles[0] + TAU;

  /* --- the radius at every (ring, bearing). Per BEARING — see the header. --- */
  const radial = new Float64Array((rings + 1) * (sides + 1));
  let widest = 1e-6;
  for (let j = 0; j <= rings; j++) {
    const v = (j / rings) * capBase;
    const body = taper + (1 - taper) * Math.pow(1 - v, tipCurve);
    const swell = 1 + bulge * Math.sin(Math.PI * v);
    const base = 0.5 * body * swell;
    for (let k = 0; k < sides; k++) {
      const r = base * (1 + (hash1(seed * 11.1 + k * 13.7 + j * 3.9) - 0.5) * chip);
      radial[j * (sides + 1) + k] = r;
      if (r > widest) widest = r;
    }
    radial[j * (sides + 1) + sides] = radial[j * (sides + 1)];
  }
  // Normalise so the widest point of the blade is exactly the unit footprint.
  // Without this, `bulge` pushes the mid-height past r = 0.5 and every
  // `bladeRadius` metre the ability resolves is quietly a lie.
  const norm = 0.5 / widest;
  for (let i = 0; i < radial.length; i++) radial[i] *= norm;

  const positions = [];
  const index = [];

  /* --- the faces --- */
  for (let f = 0; f < sides; f++) {
    const first = positions.length / 3;
    const phase = hash1(seed * 23.9 + f * 5.3);

    for (let j = 0; j <= rings; j++) {
      const v = (j / rings) * capBase;
      const rowA = radial[j * (sides + 1) + f];
      const rowB = radial[j * (sides + 1) + f + 1];
      const dv = (v - dishBias) * dishStretch;

      for (let i = 0; i <= arc; i++) {
        const u = i / arc;
        const across = Math.sin(Math.PI * u);
        const du = (u - 0.5) * 2;
        const d = Math.sqrt(du * du + dv * dv);
        // Deepest one radius out from the blow, shallowing beyond it.
        const bow = d * Math.exp(1 - d) * across;
        const rib = ripple * Math.sin((d * ripplePitch + phase) * TAU) * across;

        const angle = lerp(angles[f], angles[f + 1], u) + shear * v;
        const r = Math.max(0.004, lerp(rowA, rowB, u) * (1 - dish * bow - rib));
        positions.push(Math.cos(angle) * r, v, Math.sin(angle) * r);
      }
    }

    // Named `v0..v3` rather than the obvious `a, b, c, d`: `c` is this project's
    // universal alias for `settings[id]`, and `npm run check` reads the source
    // statically to cross-check every `c.<key>` against the block. A local `c`
    // anywhere in the file poisons that alias and the harness silently reports
    // eleven of a hundred and seventy-six sliders as read. It cost a run.
    const stride = arc + 1;
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < arc; i++) {
        const v0 = first + j * stride + i;
        const v1 = v0 + 1;
        const v2 = v0 + stride;
        const v3 = v2 + 1;
        index.push(v0, v1, v2, v1, v3, v2);
      }
    }
  }

  /* --- the terminal point --- */
  // Its own vertex set, so the join to the faces is a hard edge. A shard of
  // glass ends in a point you would not want to press, not in a dome.
  const apex = positions.length / 3;
  positions.push(
    (hash1(seed * 31.7) - 0.5) * taper * 0.5,
    1,
    (hash1(seed * 37.1) - 0.5) * taper * 0.5
  );
  const capFirst = positions.length / 3;
  let capCount = 0;
  for (let f = 0; f < sides; f++) {
    const phase = hash1(seed * 23.9 + f * 5.3);
    const j = rings;
    const v = capBase;
    const rowA = radial[j * (sides + 1) + f];
    const rowB = radial[j * (sides + 1) + f + 1];
    const dv = (v - dishBias) * dishStretch;
    // `arc` steps, not `arc + 1`: the last one is the next face's first, so the
    // ring closes without a doubled vertex and the fan has no seam in it.
    for (let i = 0; i < arc; i++) {
      const u = i / arc;
      const across = Math.sin(Math.PI * u);
      const du = (u - 0.5) * 2;
      const d = Math.sqrt(du * du + dv * dv);
      const bow = d * Math.exp(1 - d) * across;
      const rib = ripple * Math.sin((d * ripplePitch + phase) * TAU) * across;
      const angle = lerp(angles[f], angles[f + 1], u) + shear * v;
      const r = Math.max(0.004, lerp(rowA, rowB, u) * (1 - dish * bow - rib));
      positions.push(Math.cos(angle) * r, v, Math.sin(angle) * r);
      capCount++;
    }
  }
  for (let i = 0; i < capCount; i++) {
    index.push(apex, capFirst + i, capFirst + ((i + 1) % capCount));
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  // Indexed, and each face owns its vertices: smooth across a shell, hard at
  // every arris. See point 4 in the header — this one line is the trick.
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A flake of the same glass, for the break.
 *
 * The same generator with the proportions of something that came off a face
 * rather than out of the ground: two or three broad shells, almost no taper, a
 * deep dish. The trick appears twice at two scales, which is the point — a
 * shatter into flat triangles would say the blades were never glass.
 *
 * Its shape is the one thing in this ability that is not a live slider, because
 * `ShatterField` has no `syncGeometry()` to rebuild through. `flakeSize` is, and
 * that is the control anyone actually reaches for.
 */
function createFlakeGeometry(variant) {
  return createConchoidalGeometry(71.3 + variant * 13.9, {
    sides: 4 + variant,
    rings: 3,
    arc: 3,
    taper: 0.55,
    tipCurve: 0.9,
    tipRise: 0.3,
    bulge: 0.1,
    dish: 0.55,
    dishBias: 0.3,
    dishStretch: 1.1,
    ripple: 0.06,
    ripplePitch: 2.2,
    shear: 0.1,
    chip: 0.5
  });
}

/* ---------------------------------------------------------------------- */
/* The glass                                                               */
/* ---------------------------------------------------------------------- */
/**
 * Near-black glass with one very tight highlight.
 *
 * Built on `MeshStandardMaterial` through `patchGrowthMaterial` so the blades
 * take the stage's real shadows and its probe — the probe matters more here than
 * anywhere else in the project, because a reflective surface with nothing to
 * reflect is just a dark shape.
 *
 * Everything injected on top is about *not* being emissive. There are four
 * additive terms and three of them are reflections rather than light: the
 * grazing-angle fresnel (a dielectric goes to full reflectance at the
 * silhouette, which is why the edge of a black bottle is white), the tight
 * analytic specular lobe, and the transmission through the thin end. Obsidian is
 * genuinely translucent where it is thin, and it is *red-brown* there rather
 * than grey — that is iron in the glass, and it is the single detail that makes
 * people say "volcanic" without being able to say why.
 *
 * The fourth is `uHeat`, weighted almost entirely onto `vGrowBirth` and onto the
 * base of the blade, because the blade came out of the ground molten and cooled
 * in about half a second.
 *
 * The one term that is not a light at all is the flow banding: fbm in **world**
 * space, so two blades that ended up beside each other look poured from the same
 * flow. In local space every blade carries its own copy of the same swirl and
 * the bloom reads as seventy identical props, which is what the first pass was.
 */
function createObsidianMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.07,
    metalness: 0.0,
    // Emphatically NOT flatShading. See `createConchoidalGeometry`.
    flatShading: false,
    transparent: true,
    depthWrite: true
  });

  const uniforms = {
    uLightDir: frame.uLightDir,
    uColorGlass: { value: new Color() },
    uColorDeep: { value: new Color() },
    uColorSheen: { value: new Color() },
    uColorBleed: { value: new Color() },
    uColorHeat: { value: new Color() },
    uFresnel: { value: 0.85 },
    uFresnelPower: { value: 4.5 },
    uGlint: { value: 2.4 },
    uGlintSharp: { value: 220 },
    uBleed: { value: 0.6 },
    uBleedPower: { value: 2.2 },
    uHeat: { value: 3.2 },
    uHeatBand: { value: 2.4 },
    uBanding: { value: 0.45 },
    uBandScale: { value: 2.2 },
    uEmission: { value: 0.04 }
  };

  patchGrowthMaterial(material, {
    environment,
    uniforms,
    common: /* glsl */ `
      uniform vec3  uLightDir;
      uniform vec3  uColorGlass;
      uniform vec3  uColorDeep;
      uniform vec3  uColorSheen;
      uniform vec3  uColorBleed;
      uniform vec3  uColorHeat;
      uniform float uFresnel;
      uniform float uFresnelPower;
      uniform float uGlint;
      uniform float uGlintSharp;
      uniform float uBleed;
      uniform float uBleedPower;
      uniform float uHeat;
      uniform float uHeatBand;
      uniform float uBanding;
      uniform float uBandScale;
      uniform float uEmission;
      ${noiseGLSL}
    `,
    fragment: /* glsl */ `
      vec3  gN = normalize(normal);
      vec3  gV = normalize(vViewPosition);
      float ndv = clamp(dot(gN, gV), 0.0, 1.0);

      // Flow banding, in WORLD space — see the header for why not local.
      float band = fbm3(vGrowWorld * uBandScale + vGrowSeed * 5.0) * 0.5 + 0.5;
      vec3 body = mix(uColorGlass, uColorDeep, clamp(band * uBanding, 0.0, 1.0));
      diffuseColor.rgb *= body;

      // Schlick, near enough. A dielectric at a grazing angle reflects
      // everything, which is why the edge of black glass is the brightest part
      // of it and why this term is doing more work than any colour picker.
      float rim = pow(1.0 - ndv, uFresnelPower);
      totalEmissiveRadiance += uColorSheen * rim * uFresnel;

      // One tight lobe against the same key direction the lit meshes use. A
      // fake highlight that disagrees with the real sun reads as a sticker.
      vec3  gH = normalize(uLightDir + gV);
      float spec = pow(max(dot(gN, gH), 0.0), max(1.0, uGlintSharp));
      totalEmissiveRadiance += uColorSheen * spec * uGlint;

      // Transmission through the thin end. vGrowLocal.y is 0 at the base and
      // 1 at the point, so this is strongest exactly where the glass is
      // thinnest, and it only fires when the key is behind the blade.
      // (No backticks in here. The shader is a JS template literal and one
      //  backtick in a comment ends it two hundred lines early.)
      float thin = pow(clamp(vGrowLocal.y, 0.0, 1.0), uBleedPower);
      float back = clamp(dot(-gN, uLightDir), 0.0, 1.0);
      totalEmissiveRadiance += uColorBleed * uBleed * thin * back;

      // Molten, on the way out of the ground, low down and going fast.
      float hot = vGrowBirth * pow(1.0 - clamp(vGrowLocal.y, 0.0, 1.0), uHeatBand);
      totalEmissiveRadiance += uColorHeat * uHeat * hot;

      // The standing glow, which is almost nothing on purpose: glass does not
      // emit, and every slot in this sandbox that forgets that reads as plastic.
      totalEmissiveRadiance += uColorSheen * uEmission;
    `
  });

  material.userData.uniforms = uniforms;

  /** Pull the palette and every shading control from the live settings. */
  material.userData.sync = () => {
    const c = settings.obsidian;
    const g = settings.global;

    uniforms.uColorGlass.value.copy(getColor(c.colorGlass));
    uniforms.uColorDeep.value.copy(getColor(c.colorDeep));
    uniforms.uColorSheen.value.copy(getColor(c.colorSheen));
    uniforms.uColorBleed.value.copy(getColor(c.colorBleed));
    uniforms.uColorHeat.value.copy(getColor(c.colorHeat));

    uniforms.uFresnel.value = c.fresnel * g.shaderIntensity;
    uniforms.uFresnelPower.value = c.fresnelPower;
    uniforms.uGlint.value = c.glint * g.glow;
    uniforms.uGlintSharp.value = c.glintSharp;
    uniforms.uBleed.value = c.bleed * g.shaderIntensity;
    uniforms.uBleedPower.value = c.bleedPower;
    uniforms.uHeat.value = c.heat * g.glow;
    uniforms.uHeatBand.value = c.heatBand;
    uniforms.uBanding.value = c.banding * g.shaderIntensity;
    uniforms.uBandScale.value = c.bandScale * g.noiseFrequency;
    uniforms.uEmission.value = c.emission * g.glow;

    material.roughness = c.glassRough;
    material.metalness = c.glassMetal;
    material.envMapIntensity = c.envIntensity;
  };

  material.userData.sync();
  return material;
}

/* ---------------------------------------------------------------------- */
/* The ability                                                             */
/* ---------------------------------------------------------------------- */
/**
 * OBSIDIAN BLOOM — a ring of volcanic glass opening out of the floor.
 *
 * **THE TRICK — conchoidal fracture.** The blades are not faceted. Their faces
 * are smooth curved shells that meet in razor arrises, with concentric rib marks
 * radiating from the point each face was struck at, because that is the only way
 * glass breaks. All of it is in the mesh — see `createConchoidalGeometry` above,
 * which is where the ability actually lives. The material is a supporting
 * argument: near-black albedo, roughness 0.07, a fresnel that goes white at the
 * silhouette and one very tight specular lobe. It reads as glass at a glance,
 * from the silhouette and the way a highlight *slides*, before the specular has
 * landed at all — and that was the brief.
 *
 * **The beats.**
 *
 *  1. **The pour** (`TRAVEL`). The heat front runs out to the zone and the floor
 *     vitrifies behind it — a `GroundField(WET)` in black and orange, growing
 *     with `this.u`. Nothing stands up yet.
 *  2. **The bloom** (`IMPACT`, first `bloomTime`). `triggerRadial` releases the
 *     blades from the centre outward, each punching up on its own staggered
 *     clock, leaning out from the middle. Every breach throws chips, ash and a
 *     puff of orange light.
 *  3. **The hold** (the rest of `IMPACT`). It stands there and glints. This is
 *     the beat the whole ability is for and it is the longest one; the glass has
 *     to be *looked at* or the geometry was a waste of everybody's time.
 *  4. **The break** (`FADE`). One `ShatterField` burst of flakes cut from the
 *     same generator, and the blades go over `breakTime` — which is short. They
 *     drop rather than shrink, with the material's opacity taken out from under
 *     them on the same window, because glass does not dwindle. It is there and
 *     then it is flakes.
 *
 * **The rule that makes the editor work.** A blade record holds dice and one
 * timestamp — `GrowthField`'s discipline, unchanged. Not one metre, radian or
 * second is captured by this file. `zoneRadius`, `bladeHeight`, `lean` and
 * `dish` all resolve against `settings.obsidian` inside the update loop, on a
 * zero-length frame included. Pause mid-bloom with **P** and drag `dish` and the
 * standing blades re-fracture, because `syncGeometry` hashes the twelve shape
 * numbers and rebuilds the three meshes when one of them moves. That rebuild is
 * the one expensive thing in here and it is deliberate: the curvature cannot be
 * a per-instance scale, and the alternative is a texture, which invariant I2
 * does not allow.
 */
export class ObsidianAbility extends Ability {
  constructor(context) {
    super('obsidian', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.material = createObsidianMaterial(this.ctx.environment);

    /** The twelve numbers `syncGeometry` hashes. Filled from settings, live. */
    this._shape = {
      sides: 6,
      rings: 5,
      arc: 3,
      taper: 0.14,
      tipCurve: 1.7,
      tipRise: 0.15,
      bulge: 0.22,
      dish: 0.3,
      dishBias: 0.18,
      dishStretch: 1.35,
      ripple: 0.045,
      ripplePitch: 2.6,
      shear: 0.32,
      chip: 0.3
    };
    this._fillShape();

    this.field = new GrowthField(this.group, {
      geometry: (variant, shape) => createConchoidalGeometry(4.7 + variant * 19.3, shape),
      material: this.material,
      shape: this._shape,
      variants: VARIANTS,
      capacity: MAX_SHARDS,
      renderOrder: 2
    });
    // Assigned once, at construction. A closure built in the update loop is an
    // allocation per instance per frame, which is exactly what I3 forbids.
    this.field.onBreach = (index, position, radius, height) => this._onBreach(index, position, radius, height);

    this.flakes = new ShatterField(this.group, {
      geometry: createFlakeGeometry,
      variants: FLAKE_VARIANTS,
      capacity: 192,
      renderOrder: 6
    });

    // WET rather than POCK or SCOUR: the mode is "darkened, reflective stone",
    // which is what a floor looks like after something poured glass over it.
    // The heat is in the colours rather than in a second additive field.
    this.glaze = new GroundField(this.group, {
      mode: GroundMode.WET,
      additive: false,
      renderOrder: 5,
      name: 'obsidian.glaze'
    });

    /** Re-rolled per cast so two blooms do not glaze the floor identically. */
    this._seed = 0;
    /** Absolute age the bloom was released at, or -1. A timestamp. */
    this._bloomAt = -1;
    /** Latched at the break, and re-armed if the clock goes back before it. */
    this._broke = false;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Chips of glass. Lit and non-additive: they are matter, and they are the
    // one part of this ability that reads dark against the flash rather than
    // bright.
    this.chips = particles.get('obsidian.chips', {
      capacity: 1400,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.chips.uniforms.uDrag.value = 0.3;
    this.chips.uniforms.uEndSize.value = 0.7;
    this.chips.uniforms.uFadeOut.value = 0.65;

    // Ash off the pour.
    this.ash = particles.get('obsidian.ash', {
      capacity: 1000,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.ash.uniforms.uDrag.value = 1.8;
    this.ash.uniforms.uEndSize.value = 2.8;
    this.ash.uniforms.uSizeIn.value = 0.12;
    this.ash.uniforms.uFadeIn.value = 0.18;
    this.ash.uniforms.uFadeOut.value = 0.35;

    // The one additive system: the key catching an arris. Short-lived and
    // small, because a glint that lingers is a firefly.
    this.glints = particles.get('obsidian.glints', {
      capacity: 700,
      shape: ParticleShape.SOFT,
      additive: true,
      softFade: 0.3
    });
    this.glints.uniforms.uDrag.value = 2.4;
    this.glints.uniforms.uEndSize.value = 0.1;
    this.glints.uniforms.uSizeIn.value = 0.03;
    this.glints.uniforms.uFadeIn.value = 0.04;
    this.glints.uniforms.uFadeOut.value = 0.5;

    this.glintEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.field.count + this.flakes.count;
  }

  /** The bloom opening plus the hold. Both live. */
  get impactDuration() {
    const c = settings.obsidian;
    return Math.max(0.1, (c.bloomTime + c.holdTime) * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.1, settings.obsidian.fadeTime);
  }

  /** The live footprint, metres. What the circle indicator measured out. */
  get radius() {
    return Math.max(0.1, settings.obsidian.zoneRadius);
  }

  /** 0..1 through the ring opening. */
  _bloom() {
    if (this._bloomAt < 0) return 0;
    const c = settings.obsidian;
    return saturate((this.age - this._bloomAt) / Math.max(0.02, c.bloomTime));
  }

  /** 0..1 through the break, once the fade has started. */
  _break() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    return saturate(this.fadeTime / Math.max(0.02, settings.obsidian.breakTime));
  }

  /**
   * The dynamic light is the magma, not the glass.
   *
   * It comes up with the bloom and is gone well before the hold ends, which is
   * what makes the standing blades read as *cold* — they are lit by the stage
   * from then on, and being lit by the stage is the whole argument that they are
   * a real surface.
   */
  lightShimmer() {
    const c = settings.obsidian;
    if (this.phase === AbilityPhase.TRAVEL) return 0.25 + 0.35 * this.u;
    const bloom = this._bloom();
    const cool = saturate((this.age - this._bloomAt - c.bloomTime) / Math.max(0.05, c.birthFade * 3));
    return Math.max(0.05, bloom * (1 - Easing.inQuad(cool)));
  }

  /* ------------------------------------------------------------------ */
  /* Resolving — every metre comes from here, every frame                */
  /* ------------------------------------------------------------------ */

  _fillShape() {
    const c = settings.obsidian;
    const s = this._shape;
    s.sides = c.faceSides;
    s.rings = c.faceRings;
    s.arc = c.faceArc;
    s.taper = c.tipTaper;
    s.tipCurve = c.tipCurve;
    s.tipRise = c.tipRise;
    s.bulge = c.bulge;
    s.dish = c.dish;
    s.dishBias = c.dishBias;
    s.dishStretch = c.dishStretch;
    s.ripple = c.ripple;
    s.ripplePitch = c.ripplePitch;
    s.shear = c.shear;
    s.chip = c.chip;
    return s;
  }

  _fillGrowth() {
    const c = settings.obsidian;
    const p = _growth;
    const R = this.radius;

    this._centrePoint(_centre);
    p.layout = GrowthLayout.ZONE;
    p.origin = this.origin;
    p.direction = this.direction;
    p.side = this.side;
    p.length = this.length;
    p.centre = _centre;

    p.radius = R * c.ringOuter;
    p.innerRadius = Math.min(R * c.ringOuter, R * c.ringInner);
    p.radialCurve = c.radialCurve;
    p.radialJitter = c.radialJitter;
    p.angleJitter = c.angleJitter;
    p.clusterRadius = c.clusterRadius;

    p.heightNear = c.heightNear;
    p.height = c.bladeHeight;
    p.heightCurve = c.heightCurve;
    p.heightJitter = c.heightJitter;
    p.crown = c.crown;
    p.crownPower = c.crownPower;
    p.peak = c.peak;
    p.rubble = c.rubble;
    p.rubbleScale = c.rubbleScale;
    p.rubbleSpread = c.rubbleSpread;

    p.radiusNear = c.bladeRadius;
    p.radius2 = c.bladeRadius2;
    p.radiusCurve = c.radiusCurve;
    p.radiusJitter = c.radiusJitter;

    p.lean = c.lean;
    p.leanJitter = c.leanJitter;
    p.leanRamp = c.leanRamp;
    p.leanOutward = c.leanOutward;
    p.leanForward = c.leanForward;
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

  _fillShatter() {
    const c = settings.obsidian;
    const p = _shatter;

    this._centrePoint(_centre);
    p.layout = ShatterLayout.ZONE;
    p.origin = this.origin;
    p.direction = this.direction;
    p.side = this.side;
    p.length = this.length;
    p.centre = _centre;
    p.radius = this.radius * c.ringOuter;

    p.spawnRadius = c.flakeSpawnRadius;
    p.spawnHeight = c.flakeSpawnHeight;
    p.speed = c.flakeSpeed;
    p.speedJitter = c.flakeSpeedJitter;
    p.spread = c.flakeSpread;
    p.upBias = c.flakeUp;
    p.inherit = null;
    p.inheritScale = 1;

    p.gravity = c.flakeGravity;
    p.drag = c.flakeDrag;

    p.size = c.flakeSize;
    p.sizeJitter = c.flakeJitter;
    p.shrink = c.flakeShrink;
    p.shrinkPower = c.flakeShrinkPower;
    p.spin = c.flakeSpin;
    p.spinJitter = c.flakeSpinJitter;

    p.lifetime = c.flakeLife;
    p.floor = c.flakeFloor;
    p.floorSpin = c.flakeFloorSpin;

    p.randomness = settings.global.randomness;
    return p;
  }

  /**
   * @param {number} grow   0..1 the glaze spreading outward
   * @param {number} fade   0..1 master
   */
  _fillGlaze(grow, fade) {
    const c = settings.obsidian;
    const g = settings.global;
    const p = _glaze;

    this._centrePoint(_centre);
    p.centre = _centre;
    // GroundField's local +Z is downrange, so the yaw is the cast's bearing.
    p.yaw = Math.atan2(this.direction.x, this.direction.z);
    p.height = c.glazeHeight;
    p.radius = this.radius * Math.max(0.05, c.glazeSpan);
    p.grow = grow;
    p.recede = 0;
    p.fade = fade;
    p.seed = this._seed;

    p.edge = c.glazeEdge;
    p.ragged = c.glazeRagged;
    p.raggedScale = c.glazeRaggedScale;
    p.warp = c.glazeWarp;

    p.relief = c.glazeRelief;
    p.normalStep = c.glazeNormalStep;
    p.ambient = c.glazeAmbient;
    p.wrap = c.glazeWrap;
    p.specular = c.glazeSpecular;
    p.gloss = c.glazeGloss;
    p.parallax = c.glazeParallax;

    p.detail = c.glazeDetail;
    p.flow = c.glazeFlow;
    p.sharp = c.glazeSharp;

    p.additive = false;
    p.emissive = c.glazeEmissive * g.glow;
    p.opacity = c.glazeOpacity;
    p.colorBase = c.colorGlazeBase;
    p.colorEdge = c.colorGlazeEdge;
    p.colorGlow = c.colorGlazeGlow;
    p.colorDeep = c.colorGlazeDeep;

    p.noiseStrength = g.noiseStrength;
    p.noiseFrequency = g.noiseFrequency;
    p.noiseSpeed = g.noiseSpeed;
    p.opacityScale = g.opacity;
    return p;
  }

  /** The zone centre, on the floor. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** Colours and rates for the three particle systems, and the flake look. */
  _syncLooks(fade) {
    const c = settings.obsidian;
    const g = settings.global;

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

    this.ash.setGradient(
      getColor(c.colorAshA),
      getColor(c.colorAshB),
      getColor(c.colorAshC),
      getColor(c.colorAshD)
    );
    this.ash.uniforms.uGravity.value.set(0, c.ashRise, 0);
    this.ash.uniforms.uSizeScale.value = c.ashSize * g.particleSize;
    this.ash.uniforms.uLifeScale.value = c.ashLifetime * 0.5 * g.particleLifetime;
    this.ash.uniforms.uSpeedScale.value = c.ashSpeed * g.particleSpeed;
    this.ash.uniforms.uOpacity.value = c.ashOpacity * g.opacity;
    this.ash.uniforms.uTurbulence.value = 0.4 * g.turbulence;

    this.glints.setGradient(
      getColor(c.colorGlintA),
      getColor(c.colorGlintB),
      getColor(c.colorGlintC),
      getColor(c.colorGlintD)
    );
    this.glints.uniforms.uGravity.value.set(0, c.glintRise, 0);
    this.glints.uniforms.uSizeScale.value = c.glintSize * g.particleSize * 7;
    this.glints.uniforms.uLifeScale.value = c.glintLifetime * 0.5 * g.particleLifetime;
    this.glints.uniforms.uSpeedScale.value = g.particleSpeed;
    this.glints.uniforms.uOpacity.value = g.opacity;
    this.glints.uniforms.uGlow.value = c.glint * 0.4 * g.glow;

    _flakeLook.colorA.copy(getColor(c.colorFlakeA));
    _flakeLook.colorB.copy(getColor(c.colorFlakeB));
    _flakeLook.colorEdge.copy(getColor(c.colorFlakeEdge));
    _flakeLook.colorScene.copy(getColor(c.colorFlakeScene));
    _flakeLook.opacity = c.flakeOpacity * g.opacity;
    _flakeLook.glow = c.flakeGlow * g.glow;
    _flakeLook.rim = c.flakeRim;
    _flakeLook.rimPower = c.flakeRimPower;
    _flakeLook.shade = c.flakeShade;
    _flakeLook.ambient = c.flakeAmbient;
    _flakeLook.fadeStart = c.flakeFadeStart;
    _flakeLook.soft = c.flakeSoft;
    _flakeLook.sceneMix = c.flakeSceneMix;
    _flakeLook.refract = c.flakeRefract;
    _flakeLook.saturation = c.flakeSaturation;
    this.flakes.sync(_flakeLook);

    this.material.userData.sync();
    this.material.opacity = c.glassOpacity * g.opacity * fade;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.obsidian;

    this.glintEmitter.reset();
    this._bloomAt = -1;
    this._broke = false;

    // The one thing a cast captures beyond the field's own dice, and it is
    // unitless.
    this._seed = Math.random() * 100;

    this.field.clear();
    this.field.plant(Math.min(MAX_SHARDS, Math.round(c.shards)), c.clusterShare);
    this.flakes.clear();

    this.glaze.setVisible(true);
    this._syncLooks(1);
    this.glaze.update(this._fillGlaze(0, 1));
    this.field.update(this.age, this._fillGrowth(), 0);
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * A blade breaking the surface.
   *
   * `radius` and `height` arrive already resolved from the live params, which is
   * the reason this callback takes them rather than reading settings again: the
   * chips have to come off the blade the field actually drew, not off the one
   * the settings described three frames ago.
   */
  _onBreach(index, position, radius, height) {
    const c = settings.obsidian;
    const g = settings.global;
    const time = frame.uTime.value;

    _pos.copy(position);
    _pos.y = 0.05;

    _emit.position = _pos;
    _emit.radius = radius * 1.4;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.chipSpeed;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.75;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.7;
    _emit.life = c.chipLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 9;
    _emit.tint = null;
    _emit.time = time;
    this.chips.emit(Math.round(c.breachChips * g.particleCount), _emit);

    _emit.radius = radius * 2;
    _emit.speed = c.ashSpeed;
    _emit.spread = 0.9;
    _emit.size = 0.7;
    _emit.life = c.ashLifetime;
    _emit.spin = 0.3;
    this.ash.emit(Math.round(c.breachAsh * g.particleCount), _emit);

    // One glint at the tip, on the frame it arrives. The blade is molten here
    // and this is the last moment it is its own light source.
    _pos.copy(position);
    _pos.y = height * 0.85;
    _emit.position = _pos;
    _emit.radius = radius * 0.6;
    _emit.speed = c.glintSpeed;
    _emit.spread = 1.0;
    _emit.size = 0.08;
    _emit.life = c.glintLifetime;
    _emit.spin = 0;
    this.glints.emit(Math.max(1, Math.round(2 * g.particleCount)), _emit);

    void index;
  }

  /** Sparkles off the standing glass, while it stands. */
  _glintFx(dt, scale) {
    const c = settings.obsidian;
    const g = settings.global;
    const count = Math.round(this.glintEmitter.tick(dt, c.glintRate * scale) * g.particleCount);
    if (count <= 0) return;

    // Seeded on the blades themselves, read back live from the field, so a
    // paused drag on `bladeHeight` moves the sparkles with the glass. The params
    // are re-filled rather than borrowed off the last `update()`: relying on the
    // caller having filled the scratch first is the kind of coupling that breaks
    // silently the day somebody reorders two lines in `onFade`.
    const p = this._fillGrowth();
    const live = Math.max(1, this.field.count);
    const pick = Math.floor(Math.random() * live) % live;
    this.field.tipOf(pick, p, _pos);
    _pos.y *= 0.55 + 0.45 * Math.random();

    _emit.position = _pos;
    _emit.radius = this.field.radiusOf(pick, p) * 1.2;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.glintSpeed;
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.07;
    _emit.sizeVariance = 0.8;
    _emit.life = c.glintLifetime;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.glints.emit(count, _emit);
  }

  /** The break: one burst of flakes, one jolt, one cloud of ash. */
  _shatterFx() {
    const c = settings.obsidian;
    const g = settings.global;
    const time = frame.uTime.value;

    this.flakes.burst(this.age, Math.round(c.flakes * g.particleCount), 1, 0);

    this._centrePoint(_pos);
    _pos.y = Math.max(0.1, c.flakeSpawnHeight * 0.6);
    _emit.position = _pos;
    _emit.radius = this.radius * c.ringOuter;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.chipSpeed * 1.4;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.11;
    _emit.sizeVariance = 0.8;
    _emit.life = c.chipLifetime * 1.2;
    _emit.lifeVariance = 0.55;
    _emit.spin = 12;
    _emit.tint = null;
    _emit.time = time;
    this.chips.emit(Math.round(c.breakChips * g.particleCount), _emit);

    _emit.speed = c.ashSpeed * 1.6;
    _emit.size = 1.1;
    _emit.life = c.ashLifetime;
    _emit.spin = 0.4;
    this.ash.emit(Math.round(c.breakAsh * g.particleCount), _emit);

    this.ctx.shake.add(
      c.breakShake * g.explosionIntensity,
      1 / Math.max(0.05, c.breakShakeTime),
      28
    );
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.obsidian;

    this._syncLooks(1);
    this.field.syncGeometry(this._fillShape());
    this.field.update(this.age, this._fillGrowth(), 0);
    this.flakes.update(this.age, this._fillShatter());
    // The pour runs out ahead of the bloom. `this.u` is the front, so the glaze
    // is exactly as far along as the cast is — no second clock to disagree.
    this.glaze.update(this._fillGlaze(this.u, 1));

    this.ctx.shake.rumble(c.rumble * this.u, dt);
  }

  onImpact() {
    const c = settings.obsidian;
    const g = settings.global;

    this._bloomAt = this.age;
    this._broke = false;

    this.ctx.shake.add(
      c.bloomShake * g.explosionIntensity,
      1 / Math.max(0.05, c.bloomShakeTime),
      20
    );
    this.lightBoost = c.lightIntensity * 0.4 * g.explosionIntensity;
  }

  onFade(dt, _t) {
    const c = settings.obsidian;

    const bloom = this._bloom();
    const broke = this._break();
    // The blades keep their opacity until the break and then lose it fast. Glass
    // does not dwindle: `1 - t³` hangs on and then goes.
    const solid = broke <= 0 ? 1 : 1 - Easing.inCubic(broke);

    this._syncLooks(solid);
    this.field.syncGeometry(this._fillShape());
    // Radially, from the centre out, on the same clock the ring opens on.
    this.field.triggerRadial(this.age, bloom, c.riseStagger, false, true);
    this.field.update(this.age, this._fillGrowth(), broke);

    // Tested against the *live* boundary and re-armed whenever the clock is back
    // before it, so dragging `breakTime` on a paused cast walks the shatter
    // backward and forward instead of firing once and never again.
    if (this.phase !== AbilityPhase.FADE) {
      this._broke = false;
    } else if (!this._broke) {
      this._broke = true;
      this._shatterFx();
    }

    this.flakes.update(this.age, this._fillShatter());
    // The glaze outlives the glass by design — the floor stays vitrified for the
    // whole fade and goes with the cast, which is what says something happened
    // here rather than something was drawn here.
    this.glaze.update(this._fillGlaze(1, this.phase === AbilityPhase.FADE ? 1 - saturate(this.fadeTime / this.fadeDuration) : 1));

    // The light sits at the middle of the ring, at blade height.
    this._centrePoint(this.position);
    this.position.y = Math.max(0.2, c.bladeHeight * 0.5);

    this._glintFx(dt, solid * (0.35 + 0.65 * bloom));
  }

  onDestroy() {
    this.field.clear();
    this.flakes.clear();
    this.glaze.clearMarks();
    this.glaze.setVisible(false);
    this._bloomAt = -1;
    this._broke = false;
  }

  dispose() {
    this.field.dispose();
    this.flakes.dispose();
    this.glaze.dispose();
    this.material.dispose();
    super.dispose();
  }
}
