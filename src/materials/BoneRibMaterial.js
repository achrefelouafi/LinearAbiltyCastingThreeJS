import { BufferGeometry, Float32BufferAttribute, MeshStandardMaterial, Color, FrontSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { patchGrowthMaterial } from '../vfx/GrowthField.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { hash11, saturate, lerp, smoothstep } from '../utils/math.js';

const TAU = Math.PI * 2;

/* ---------------------------------------------------------------------- */
/* The rib                                                                 */
/* ---------------------------------------------------------------------- */

/**
 * Radius profile of one rib at `t` along it, as a fraction of the unit
 * footprint. Everything here is a proportion, never a metre — the instance
 * matrix supplies the scale, and it does so from live settings every frame.
 *
 * A bone is not a taper. It is a **bulb, a neck, a long blade and a knuckle**,
 * and leaving any of the four out gives a horn. The neck is the one nobody
 * expects and the one that does most of the work: the pinch just above the
 * articular head is what says "this thing was jointed to something".
 *
 * @param {number} t 0 at the buried head, 1 at the tip
 * @param {object} s the shape block
 */
function ribRadius(t, s) {
  // The articular head: a Gaussian bulb that has died away by a tenth of the
  // way up, so it reads as a knob on the end rather than as a fat base.
  const bulb = Math.exp(-Math.pow(t / 0.1, 2)) * Math.max(0, s.headSwell - s.neck);
  const body = s.neck + (s.shaft - s.neck) * smoothstep(0.06, 0.34, t);
  // Beyond the shoulder the blade thins out. The 0.75 exponent keeps it a blade
  // for most of its length and then loses it quickly, which is the difference
  // between a rib and a spike.
  const fall = Math.pow(1 - saturate((t - 0.34) / 0.66), 0.75);
  const bladed = s.taper + (body - s.taper) * (t <= 0.34 ? 1 : fall);
  // The sternal knuckle: the small swell before the end.
  const knuckle = s.knuckle * Math.exp(-Math.pow((t - 0.8) / 0.07, 2));
  return Math.max(0.02, bladed + bulb + knuckle) * 0.5;
}

/**
 * One rib, in `GrowthField`'s unit space: footprint inside a circle of radius
 * 0.5 on `y = 0`, tip at `y = 1`.
 *
 * ### Why the rib is straight
 *
 * A rib should curve, and this one does not, and that is a decision rather than
 * an oversight. `GrowthField` orients an instance by tipping its local **+Y**
 * toward a lean vector and then rolling it about its own axis by a random yaw.
 * There is no local axis that maps to a consistent world direction under that:
 * work the Rodrigues rotation through for a ZONE field and the radial component
 * of the instance's local +X comes out as `cos θ · cos φ`, so a bend baked into
 * the geometry points inward at one bearing on the ring and sideways ninety
 * degrees round from it. The first version had a proper sickle in it and the
 * cage curved inward on two sides and slewed off tangentially on the other two,
 * which looks like a bug and is one.
 *
 * The curvature therefore lives entirely in the **lean**, which `GrowthField`
 * scales by each record's radial fraction — so the ribs at the rim lay in hard
 * and the ones near the middle stand nearly upright, and the field is a dome
 * rather than a fence. What the geometry keeps is everything that survives an
 * arbitrary roll: the profile, the flattened blade section, the twist along its
 * own axis and the groove down one face.
 *
 * @param {number} variant 0..n — decorrelates the three silhouettes
 * @param {object} shape   the live shape block, hashed by `GrowthField`
 */
export function createBoneRibGeometry(variant = 0, shape = {}) {
  const s = {
    sides: Math.max(4, Math.round(shape.ribSides ?? 7)),
    rings: Math.max(5, Math.round(shape.ribRings ?? 12)),
    flatten: saturate(shape.ribFlatten ?? 0.44),
    twist: shape.ribTwist ?? 0.18,
    groove: saturate(shape.ribGroove ?? 0.3),
    headSwell: shape.ribHead ?? 1.05,
    neck: shape.ribNeck ?? 0.52,
    shaft: shape.ribShaft ?? 0.7,
    taper: shape.ribTaper ?? 0.1,
    knuckle: shape.ribKnuckle ?? 0.2,
    warp: shape.ribWarp ?? 0.28
  };

  // One deterministic seed per variant: the same variant always builds the same
  // rib, so a live rebuild reshapes the cage without reshuffling it.
  const seed = 3.17 + variant * 11.9;
  const phase = hash11(seed * 1.7) * TAU;
  // Each variant is a slightly different bone. Real ribs are not three of one.
  const lengthBias = 1 + (hash11(seed * 2.3) - 0.5) * 0.22;
  const flatten = saturate(s.flatten * (1 + (hash11(seed * 3.9) - 0.5) * 0.4));

  const positions = [];
  const indices = [];

  for (let ring = 0; ring < s.rings; ring++) {
    const u = ring / (s.rings - 1);
    // Rings crowd toward both ends, because that is where the shape is: the
    // head and the knuckle need resolution and the middle of the blade does
    // not. Evenly spaced rings spend half the mesh on a straight bit.
    const t = Math.min(0.985, u - Math.sin(u * TAU) * 0.09);
    const roll = phase + s.twist * t * TAU;
    const radius = ribRadius(t, s) * lerp(1, lengthBias, t);

    for (let i = 0; i < s.sides; i++) {
      const a = (i / s.sides) * TAU + roll;
      const ca = Math.cos(a);
      const sa = Math.sin(a);

      // The costal groove: a scoop down one face, present only along the blade.
      // Cubed so it is a channel with a lip rather than a dent across the whole
      // half-section.
      const cut =
        s.groove *
        Math.pow(Math.max(0, -sa), 3) *
        smoothstep(0.22, 0.4, t) *
        smoothstep(0.95, 0.78, t);

      // Deterministic surface irregularity. Bone that is perfectly smooth reads
      // as ceramic; this is the only reason the silhouette is not a lathe.
      const wobble =
        1 + (hash11(seed * 7.3 + ring * 13.1 + i * 3.7) - 0.5) * s.warp * (0.3 + 0.7 * t);

      const rx = radius * wobble * (1 - cut);
      const rz = radius * wobble * (1 - flatten) * (1 - cut);
      positions.push(ca * rx, t, sa * rz);
    }
  }

  for (let ring = 0; ring < s.rings - 1; ring++) {
    for (let i = 0; i < s.sides; i++) {
      const j = (i + 1) % s.sides;
      // Named `v0..v3` and not `a..d`: the harness's static settings pass drops
      // any alias that is ever bound to a non-settings right-hand side anywhere
      // in the file, and a bare `const c = …` here quietly blinded it to the
      // twenty-three keys `sync()` reads through `const c = settings.bonecage`.
      const v0 = ring * s.sides + i;
      const v1 = ring * s.sides + j;
      const v2 = (ring + 1) * s.sides + i;
      const v3 = (ring + 1) * s.sides + j;
      indices.push(v0, v1, v2, v1, v3, v2);
    }
  }

  /* --- the tip, and the underside --- */
  const apex = positions.length / 3;
  positions.push(0, 1, 0);
  const lastRing = (s.rings - 1) * s.sides;
  for (let i = 0; i < s.sides; i++) {
    const j = (i + 1) % s.sides;
    indices.push(lastRing + i, lastRing + j, apex);
  }

  const floorCentre = positions.length / 3;
  positions.push(0, 0, 0);
  for (let i = 0; i < s.sides; i++) {
    const j = (i + 1) % s.sides;
    indices.push(floorCentre, j, i);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  // Indexed, so this averages across the seams and the blade shades smooth.
  // Bone is not faceted, and a faceted rib reads as carved wood.
  geometry.computeVertexNormals();
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* The material                                                            */
/* ---------------------------------------------------------------------- */

/**
 * Dry bone. **The single most different material in the blood school.**
 *
 * Crimson Tide is standing two metres away being viscous, wet, red and
 * self-lit. This is the argument that the school is not a palette: same school,
 * and every one of those four properties is inverted on purpose.
 *
 * | Crimson Tide | this |
 * | --- | --- |
 * | specular sheen keyed off the surface normal | no sheen term at all |
 * | roughness pulled *down* in the wet grooves | roughness pinned near 0.95 everywhere |
 * | emissive sap glowing in the dark | emissive that is **capped below the bloom threshold** |
 * | a fresnel rim that brightens the silhouette | a fresnel-shaped term on the *albedo* |
 *
 * ### The three things that make it chalk rather than plastic
 *
 * **1 · The anti-fresnel.** A dielectric gets shinier at grazing incidence.
 * Chalk gets *lighter*: the surface is porous, and light that would have
 * refracted into a smooth dielectric is instead scattered back out of the pores
 * a fraction of a millimetre away. So `uChalk` applies a fresnel-shaped curve
 * to `diffuseColor` and nothing at all to the specular lobe. It is the opposite
 * of what a fresnel term normally does and it is why this reads as matte
 * mineral instead of matte paint. Take it to zero and the ribs turn into grey
 * rubber under the same lights.
 *
 * **2 · Warm subsurface scatter.** The cheap back-scatter transmission term —
 * `pow(dot(V, -normalize(L + N · distort)), power)` — modulated by a thickness
 * field that is genuinely thin where the bone is thin: near the tip, near the
 * silhouette, and wherever the trabecular noise says the interior is open. The
 * colour is warm (`colorMarrow`, a red-orange) because that is what survives a
 * few millimetres of calcium — and it is the one warm thing in an otherwise
 * bleached object, which is what stops the cage reading as plaster.
 *
 * **3 · It is capped.** `uSssCeiling` clamps the scatter under the bloom
 * threshold before it reaches `totalEmissiveRadiance`. Bone is lit; bone does
 * not glow. The brief for this slot is a material that has no glow in it, and
 * that is enforced here rather than trusted to the tuning staying sensible.
 *
 * ### The dirty birth
 *
 * Every other growth material in the project flashes **bright** on breach —
 * `vGrowBirth` drives a hot rim on ice, on thorns, on stone. Bone cannot: a
 * flash is a glow. So the flash is inverted and a rib breaks the surface
 * *filthy*, caked in the floor it just came through, and cleans off over
 * `birthFade`. Same attribute, same clock, opposite sign, and it is a better
 * read anyway — something that has come up through a flagstone should have the
 * flagstone on it.
 *
 * Uniform boxes are parked on `material.userData.uniforms` — I8, and the thing
 * the harness's pause probe looks for.
 */
export function createBoneMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.0,
    // Smooth. See the note on `computeVertexNormals` above: a faceted rib is
    // carved wood, and the whole slot is about the material being right.
    flatShading: false,
    side: FrontSide,
    transparent: true,
    depthWrite: true
  });

  const uniforms = {
    uLightDir: frame.uLightDir,
    uColorBone: { value: new Color() },
    uColorShade: { value: new Color() },
    uColorMarrow: { value: new Color() },
    uColorStain: { value: new Color() },
    uColorGrime: { value: new Color() },

    uGrain: { value: 0.35 },
    uGrainScale: { value: 6.5 },
    uGrainBands: { value: 2.2 },
    uPit: { value: 0.45 },
    uPitScale: { value: 24.0 },
    uPitCut: { value: 0.55 },

    uChalk: { value: 0.55 },
    uChalkPower: { value: 2.6 },
    uRough: { value: 0.94 },
    uRoughPit: { value: 0.4 },

    uSss: { value: 0.9 },
    uSssPower: { value: 3.2 },
    uSssDistort: { value: 0.35 },
    uSssAmbient: { value: 0.18 },
    uSssCeiling: { value: 0.5 },
    uThinBase: { value: 0.15 },
    uThinEdge: { value: 0.65 },

    uStain: { value: 0.7 },
    uStainHeight: { value: 0.26 },
    uGrime: { value: 0.85 },
    uWither: { value: 0 }
  };

  /**
   * The growth plumbing comes from `patchGrowthMaterial`, which owns the two
   * per-instance attributes and the four varyings, routes through
   * `registerShadowCasterWithPatch` so CSM's own patch survives, and injects
   * the disruption block. Everything below lands in its one fragment slot.
   *
   * `roughnessFactor` is written from that slot rather than from
   * `<roughnessmap_fragment>`, which is where it would normally go: the growth
   * patch only offers the one injection point, and it does not matter, because
   * `<lights_physical_fragment>` — the line that actually consumes
   * `roughnessFactor` — comes *after* `<emissivemap_fragment>` in the standard
   * fragment shader. Writing it here is one statement out of order and zero
   * statements wrong.
   */
  patchGrowthMaterial(material, {
    environment,
    uniforms,
    common: /* glsl */ `
         uniform vec3  uLightDir;
         uniform vec3  uColorBone;
         uniform vec3  uColorShade;
         uniform vec3  uColorMarrow;
         uniform vec3  uColorStain;
         uniform vec3  uColorGrime;
         uniform float uGrain;
         uniform float uGrainScale;
         uniform float uGrainBands;
         uniform float uPit;
         uniform float uPitScale;
         uniform float uPitCut;
         uniform float uChalk;
         uniform float uChalkPower;
         uniform float uRough;
         uniform float uRoughPit;
         uniform float uSss;
         uniform float uSssPower;
         uniform float uSssDistort;
         uniform float uSssAmbient;
         uniform float uSssCeiling;
         uniform float uThinBase;
         uniform float uThinEdge;
         uniform float uStain;
         uniform float uStainHeight;
         uniform float uGrime;
         uniform float uWither;
         ${noiseGLSL}

         /**
          * Trabecular porosity: the open cells inside the bone, read at the
          * surface as pitting. Sampled in WORLD space on purpose, so two ribs
          * standing next to each other look like they came out of one animal
          * rather than out of one lathe. 0 on solid cortex, 1 in a pit.
          */
         float bonePit(vec3 worldPos) {
           float cells = snoise01(worldPos * uPitScale);
           return smoothstep(uPitCut, 1.0, cells);
         }`,
    fragment: /* glsl */ `
           float up = clamp(vGrowLocal.y, 0.0, 1.0);
           float pit = bonePit(vGrowWorld);

           // Haversian grain: runs UP the bone, so it is sampled in local space
           // with the along-frequency well above the around-frequency. Sampling
           // it in world space gives a rock, which is the same mistake
           // VineBarkMaterial documents and the same fix.
           float grain = fbm3(vec3(vGrowLocal.xz * uGrainBands, up * uGrainScale)) * 0.5 + 0.5;

           vec3 body = uColorBone;
           body = mix(body, uColorShade, grain * uGrain);
           body = mix(body, uColorShade, pit * uPit);
           // Earth staining where it came out of the floor, and never above
           // uStainHeight — a bone stained end to end reads as painted.
           body = mix(body, uColorStain, smoothstep(uStainHeight, 0.0, up) * uStain);

           /* --- the anti-fresnel: chalk gets LIGHTER at grazing incidence --- */
           vec3 V = normalize(vViewPosition);
           float facing = abs(dot(normalize(normal), V));
           float grazing = pow(1.0 - facing, max(uChalkPower, 0.1));
           body *= 1.0 + uChalk * grazing;

           /* --- the dirty birth: bright is a glow, so this one goes dark --- */
           float fresh = clamp(vGrowBirth, 0.0, 1.0);
           body = mix(body, uColorGrime, fresh * clamp(uGrime, 0.0, 1.0));

           diffuseColor.rgb *= body;

           /* --- warm subsurface scatter, and its hard ceiling --- */
           // The key direction has to come into view space to sit alongside
           // normal and vViewPosition; doing it here rather than carrying a
           // varying costs one mat3 multiply on a material that is already
           // paying for a standard BRDF.
           vec3 Lv = normalize((viewMatrix * vec4(uLightDir, 0.0)).xyz);
           vec3 leak = normalize(Lv + normalize(normal) * uSssDistort);
           float back = pow(clamp(dot(V, -leak), 0.0, 1.0), max(uSssPower, 0.1));

           // Thickness: thin at the tip, thin on the silhouette, thin wherever
           // the trabecular field says the interior is open.
           float thin = mix(uThinBase, 1.0, up * up);
           thin = mix(thin, 1.0, (1.0 - facing) * uThinEdge);
           thin = clamp(thin * (0.75 + 0.5 * pit), 0.0, 1.0);

           vec3 scatter = uColorMarrow * ((back + uSssAmbient) * thin * uSss);
           // Bone is lit; bone does not glow. This clamp is the anti-glow
           // contract for the slot and it is deliberately below the bloom
           // threshold rather than near it.
           scatter = min(scatter, vec3(max(uSssCeiling, 0.0)));
           scatter *= 1.0 - clamp(uWither, 0.0, 1.0);

           totalEmissiveRadiance += scatter;

           /* --- chalky micro-roughness, written one statement early --- */
           // See the note above patchGrowthMaterial: <lights_physical_fragment>
           // reads roughnessFactor and it comes after this injection point.
           // The pits have to be rougher than the cortex around them or the
           // whole surface reads as one uniform matte, which is plaster.
           roughnessFactor = clamp(uRough + pit * uRoughPit, 0.04, 1.0);
    `
  });

  material.userData.uniforms = Object.assign(material.userData.uniforms ?? {}, uniforms);

  /** Pull the palette and every shading control off the live settings. */
  material.userData.sync = () => {
    const c = settings.bonecage;
    const g = settings.global;

    uniforms.uColorBone.value.copy(getColor(c.colorBone));
    uniforms.uColorShade.value.copy(getColor(c.colorBoneShade));
    uniforms.uColorMarrow.value.copy(getColor(c.colorMarrow));
    uniforms.uColorStain.value.copy(getColor(c.colorStain));
    uniforms.uColorGrime.value.copy(getColor(c.colorGrime));

    uniforms.uGrain.value = c.boneGrain * g.shaderIntensity;
    uniforms.uGrainScale.value = c.boneGrainScale * g.noiseFrequency;
    uniforms.uGrainBands.value = c.boneGrainBands * g.noiseFrequency;
    uniforms.uPit.value = c.bonePit * g.shaderIntensity;
    uniforms.uPitScale.value = c.bonePitScale * g.noiseFrequency;
    uniforms.uPitCut.value = c.bonePitCut;

    uniforms.uChalk.value = c.boneChalk * g.shaderIntensity;
    uniforms.uChalkPower.value = c.boneChalkPower;
    uniforms.uRough.value = c.boneRoughness;
    uniforms.uRoughPit.value = c.boneRoughnessPit;

    // `g.glow` is allowed to scale the scatter, and the ceiling is applied on
    // top of it in the shader — turning the global glow up cannot make bone
    // bloom, which is the point of having the ceiling be a uniform.
    uniforms.uSss.value = c.sssStrength * g.glow;
    uniforms.uSssPower.value = c.sssPower;
    uniforms.uSssDistort.value = c.sssDistort;
    uniforms.uSssAmbient.value = c.sssAmbient;
    uniforms.uSssCeiling.value = c.sssCeiling;
    uniforms.uThinBase.value = c.sssThinBase;
    uniforms.uThinEdge.value = c.sssThinEdge;

    uniforms.uStain.value = c.stainAmount;
    uniforms.uStainHeight.value = c.stainHeight;
    uniforms.uGrime.value = c.grimeAmount;

    material.roughness = c.boneRoughness;
    material.envMapIntensity = c.boneEnv;
  };

  /**
   * How far through the cast's death the bone is, 0..1.
   *
   * Separate from `sync()` because it is a beat rather than a setting: the
   * ability owns the clock, the block owns the numbers.
   */
  material.userData.setWither = (wither) => {
    uniforms.uWither.value = saturate(wither);
  };

  material.userData.sync();
  return material;
}
