import { Color, MeshDepthMaterial, MeshStandardMaterial, RGBADepthPacking, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { patchGrowthMaterial } from '../vfx/GrowthField.js';
import { patchOnBeforeCompile, replaceChunk } from '../utils/shaderPatch.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/* ------------------------------------------------------------------------ */
/* AstralStoneMaterial — the one material in the project that knows about a  */
/* plane it is not allowed to be seen behind                                 */
/* ------------------------------------------------------------------------ */
/**
 * Obelisks of dark stone with a starfield inside them, and — the whole reason
 * this file exists — a **half-space clip against the gate plane**.
 *
 * ## The clip
 *
 * Astral Gate's bodies are `GrowthField` instances whose bases sit on a portal
 * aperture floating in the air. `GrowthField` emerges an instance by burying it
 * `emergeSink` of its own height below its base and sliding it up, which is
 * exactly right when the base is the floor and exactly wrong when the base is a
 * hole in space: the buried part hangs *under the gate*, in mid-air, in plain
 * view. Two uniforms and one dot product fix it:
 *
 * ```glsl
 * float side = dot(vGrowWorld - uGatePoint, uGateNormal);
 * if (side < 0.0) discard;
 * ```
 *
 * It is a general half-space and not `worldY > k` on purpose. The extra cost is
 * a dot product over a subtraction, and what it buys is a gate that can be
 * tilted or stood on edge later without this file changing at all — the plane
 * is defined by the same point and normal the `Portal` is placed with, so the
 * two cannot drift.
 *
 * ## Why the *depth* material has to be patched too
 *
 * The first version stopped at the fragment discard above and looked correct
 * from every angle except one: the floor. `Environment#registerShadowCasterWithPatch`
 * patches the material you hand it, and three renders the shadow map with its
 * own auto-generated `MeshDepthMaterial`, which has never heard of the gate. So
 * every body that had not come through yet was invisible **and casting a full
 * shadow on the stone below** — a ring of shadows with nothing above them,
 * which is a far worse artefact than the one the clip was written to remove.
 *
 * So the ability also gets a `customDepthMaterial` carrying the identical test,
 * sharing the **same two uniform boxes by identity**, so one write per frame
 * moves the clip in the colour pass and in the shadow pass together. Cloning
 * them would give a shadow that lags the geometry by however wrong the second
 * copy was, and nobody would ever find it.
 *
 * ## The emergence lip
 *
 * A clip on its own is an absence, and an absence is not an effect. The same
 * `side` value drives a hot band — `exp(-side / lipWidth)` — so every body is
 * ringed in light exactly where it crosses, and the ring travels down the shaft
 * as the body climbs. That band is the only thing in the ability that says
 * *through* rather than *in front of*, and it exists because the shader knows
 * where the plane is. It is the positive half of the trick and the reason the
 * clip is worth having rather than merely correct.
 *
 * ## The stone
 *
 * Built on `MeshStandardMaterial`, like `IceMaterial` and for the same reason:
 * the obelisks take the stage's real shadows, real lights and HDR probe, and
 * the stylisation is injected after `<emissivemap_fragment>` where the face
 * normal exists (`flatShading` is on, so there is no `vNormal` varying).
 *
 * Three marks on top of the PBR: a base-to-tip darkening in **local** space so
 * it follows each body's own axis however it is scaled and leaned; ridged
 * starlight veins in **world** space so two neighbouring obelisks look quarried
 * out of the same block of night; and a hashed lattice of points on the faces,
 * which is the same construction the `Portal`'s interior uses for its stars.
 * That last one is deliberate: the stone is supposed to look like a piece of
 * what is behind the gate, and the cheapest way to say so is to make its specks
 * and the portal's stars come out of the same maths.
 *
 * The first attempt shaded the veins in local space so they ran base-to-tip
 * with the gradient. Every obelisk got an identical set of stripes and the
 * field read as forty copies of one prop with a decal on it — which it was.
 * World space costs nothing and fixes it completely.
 *
 * Uniform boxes are parked on `material.userData.uniforms` (I8) so the
 * harness's pause probe can see them, and `material.userData.sync()` re-reads
 * `settings.astralgate` every frame, zero-length frames included.
 */

/** Declarations shared by the colour pass and the depth pass. */
const GATE_UNIFORMS_GLSL = /* glsl */ `
  uniform vec3 uGatePoint;    // a point on the aperture plane, world metres
  uniform vec3 uGateNormal;   // its unit normal; +side is "has come through"
`;

const STONE_FRAGMENT = /* glsl */ `
  // Everything here is in the body's own unit space (vGrowLocal, y = 0 at the
  // base and 1 at the tip) or in world metres (vGrowWorld). Never both.
  float up = clamp(vGrowLocal.y, 0.0, 1.0);
  vec3 N = normalize(normal);
  vec3 V = normalize(vViewPosition);

  /* --- the body: dark at the base, opening out toward the tip --- */
  vec3 body = mix(uColorDeep, uColorFace, pow(up, max(uFaceCurve, 0.05)));

  /* --- starlight veins, in WORLD space (see the header) --- */
  float vein = ridged(vGrowWorld * uVeinScale + uSeedOffset * vGrowSeed, 4);
  vein = smoothstep(uVeinSharp, 1.0, vein) * uVeins;

  /* --- and the specks, on the same lattice the portal draws stars on --- */
  vec3 cell = floor(vGrowWorld * uSpeckScale);
  float pick = hash13(cell + vGrowSeed);
  float speck = smoothstep(0.86, 0.995, pick) * uSpecks;

  /* --- grain, so the faces are not flat washes --- */
  float grain = fbm3(vGrowWorld * uGrainScale) * 0.5 + 0.5;
  body *= 1.0 - uGrain * (0.5 - grain);

  float fres = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), max(uFresnelPower, 0.05));

  diffuseColor.rgb *= body;
  totalEmissiveRadiance +=
      uColorVein * (vein + speck) * uGlow
    + uColorFace * fres * uFresnel
    // The birth flash GrowthField already writes, spent here rather than on a
    // second attribute: 1 on the frame a body is triggered, 0 uGrowBirth
    // seconds later.
    + uColorBirth * vGrowBirth * uBirthGlow;

  /* --- the emergence lip: the positive half of the clip --- */
  float side = dot(vGrowWorld - uGatePoint, uGateNormal);
  float lip = exp(-max(side, 0.0) / max(uLipWidth, 1e-3));
  totalEmissiveRadiance += uColorLip * lip * uLipGlow;
`;

/**
 * The two boxes the colour pass and the depth pass share by identity.
 *
 * Built per material rather than at module scope: two Astral Gates can be live
 * at once under the concurrency cap, standing at two different points, and a
 * module-level plane would put both fields' clips at whichever gate synced
 * last. Every other uniform in this file could be shared safely; these two
 * cannot, and that is worth a sentence because the bug it prevents looks like
 * "sometimes half the obelisks are missing".
 */
function gatePlaneUniforms() {
  return {
    uGatePoint: { value: new Vector3() },
    uGateNormal: { value: new Vector3(0, 1, 0) }
  };
}

/**
 * The depth pass, carrying the identical half-space test.
 *
 * Written as a patch on a real `MeshDepthMaterial` rather than as a bespoke
 * shader because the shadow map's packing, its `logdepthbuf` handling and its
 * instancing all come free that way, and every one of them is a thing that
 * silently produces a black screen when it is written by hand.
 *
 * `replaceChunk` rather than `String#replace`: a chunk name that vanishes in a
 * three upgrade warns, once, naming the token — the alternative is a shadow
 * pass that quietly stops clipping and nobody notices for a month.
 */
function createGateDepthMaterial(plane) {
  const material = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });

  patchOnBeforeCompile(material, (shader) => {
    Object.assign(shader.uniforms, plane);

    shader.vertexShader = replaceChunk(
      shader.vertexShader,
      '#include <common>',
      `#include <common>
       varying vec3 vGateWorld;`
    );
    shader.vertexShader = replaceChunk(
      shader.vertexShader,
      '#include <begin_vertex>',
      `#include <begin_vertex>
       #ifdef USE_INSTANCING
         vGateWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
       #else
         vGateWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
       #endif`
    );

    shader.fragmentShader = replaceChunk(
      shader.fragmentShader,
      '#include <common>',
      `#include <common>
       ${GATE_UNIFORMS_GLSL}
       varying vec3 vGateWorld;`
    );
    shader.fragmentShader = replaceChunk(
      shader.fragmentShader,
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>
       if (dot(vGateWorld - uGatePoint, uGateNormal) < 0.0) discard;`
    );
  });

  material.userData = material.userData ?? {};
  material.userData.uniforms = plane;
  return material;
}

/**
 * @param {object} environment `world/Environment.js` — routes the patch through
 *        `registerShadowCasterWithPatch` so nothing else's patch is clobbered
 * @returns {THREE.MeshStandardMaterial} with `userData.sync(gatePoint, gateNormal)`
 *          and `userData.depthMaterial`, which the ability must hang on every
 *          one of the field's meshes as `customDepthMaterial`
 */
export function createAstralStoneMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.72,
    metalness: 0.08,
    // Crisp facets on a quarried body, and the reason the shading above reads
    // `normal` rather than a varying.
    flatShading: true
  });

  const plane = gatePlaneUniforms();

  // No `uLightDir`. Every other patched standard material in this project
  // carries one because it fakes its own lambert; this one does not fake
  // anything — the obelisks are lit by the stage's real key light through the
  // physical shader, and the only view-dependent term here is a fresnel off the
  // face normal. An unused uniform is not free: it is a line the next person
  // has to read and decide is not the reason their light is wrong.
  const uniforms = {
    ...plane,

    /* --- the body --- */
    uColorDeep: { value: new Color('#0d1024') }, //  the base, in shadow
    uColorFace: { value: new Color('#3a3f66') }, //  the lit faces near the tip
    uColorVein: { value: new Color('#b9a6ff') }, //  the starlight in the cracks
    uColorLip: { value: new Color('#e6dcff') }, //   the band at the plane
    uColorBirth: { value: new Color('#ffffff') }, // the flash as it breaks through
    uFaceCurve: { value: 1.4 }, //   >1 keeps the base dark and opens late

    /* --- the marks --- */
    uVeins: { value: 0.85 },
    uVeinScale: { value: 1.6 }, //   cycles per metre
    uVeinSharp: { value: 0.62 },
    uSpecks: { value: 0.7 },
    uSpeckScale: { value: 11.0 }, // cells per metre
    uGrain: { value: 0.35 },
    uGrainScale: { value: 5.5 }, //  cycles per metre
    uSeedOffset: { value: 3.1 }, //  how far a per-instance seed shifts the field

    /* --- optics --- */
    uFresnel: { value: 0.9 },
    uFresnelPower: { value: 3.0 },
    uGlow: { value: 1.4 },
    uBirthGlow: { value: 2.2 },

    /* --- the clip's visible half --- */
    uLipWidth: { value: 0.22 }, //   metres the band falls off over
    uLipGlow: { value: 2.6 }
  };

  patchGrowthMaterial(material, {
    environment,
    uniforms,
    common: /* glsl */ `
      ${GATE_UNIFORMS_GLSL}
      uniform vec3  uColorDeep;
      uniform vec3  uColorFace;
      uniform vec3  uColorVein;
      uniform vec3  uColorLip;
      uniform vec3  uColorBirth;
      uniform float uFaceCurve;
      uniform float uVeins;
      uniform float uVeinScale;
      uniform float uVeinSharp;
      uniform float uSpecks;
      uniform float uSpeckScale;
      uniform float uGrain;
      uniform float uGrainScale;
      uniform float uSeedOffset;
      uniform float uFresnel;
      uniform float uFresnelPower;
      uniform float uGlow;
      uniform float uBirthGlow;
      uniform float uLipWidth;
      uniform float uLipGlow;
      ${noiseGLSL}
    `,
    fragment: STONE_FRAGMENT
  });

  // The clip itself, in the colour pass. Injected separately from the shading
  // above and *before* it in the shader, because a discarded fragment must not
  // pay for four octaves of ridged noise first.
  patchOnBeforeCompile(material, (shader) => {
    shader.fragmentShader = replaceChunk(
      shader.fragmentShader,
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       if (dot(vGrowWorld - uGatePoint, uGateNormal) < 0.0) discard;`
    );
  });

  const depthMaterial = createGateDepthMaterial(plane);

  /**
   * Re-resolve everything from `settings.astralgate`.
   *
   * @param {THREE.Vector3} point  a point on the aperture plane, world metres
   * @param {THREE.Vector3} normal its unit normal
   */
  material.userData.sync = (point, normal) => {
    const c = settings.astralgate;
    const g = settings.global;

    uniforms.uGatePoint.value.copy(point);
    uniforms.uGateNormal.value.copy(normal);

    uniforms.uColorDeep.value.copy(getColor(c.colorStoneDeep));
    uniforms.uColorFace.value.copy(getColor(c.colorStoneFace));
    uniforms.uColorVein.value.copy(getColor(c.colorStoneVein));
    uniforms.uColorLip.value.copy(getColor(c.colorLip));
    uniforms.uColorBirth.value.copy(getColor(c.colorBirth));

    uniforms.uFaceCurve.value = c.stoneFaceCurve;
    uniforms.uVeins.value = c.stoneVeins * g.shaderIntensity;
    uniforms.uVeinScale.value = c.stoneVeinScale * g.noiseFrequency;
    uniforms.uVeinSharp.value = c.stoneVeinSharp;
    uniforms.uSpecks.value = c.stoneSpecks * g.shaderIntensity;
    uniforms.uSpeckScale.value = c.stoneSpeckScale * g.noiseFrequency;
    uniforms.uGrain.value = c.stoneGrain * g.shaderIntensity;
    uniforms.uGrainScale.value = c.stoneGrainScale * g.noiseFrequency;
    uniforms.uSeedOffset.value = c.stoneSeedOffset;

    uniforms.uFresnel.value = c.stoneFresnel * g.fresnel;
    uniforms.uFresnelPower.value = c.stoneFresnelPower;
    uniforms.uGlow.value = c.stoneGlow * g.glow;
    uniforms.uBirthGlow.value = c.birthGlow * g.glow;

    uniforms.uLipWidth.value = c.lipWidth;
    uniforms.uLipGlow.value = c.lipGlow * g.glow;

    material.roughness = c.stoneRoughness;
    material.metalness = c.stoneMetalness;
    material.envMapIntensity = c.stoneEnv;
  };

  // I8 — the pause probe reads uniforms off here, and so does anyone wondering
  // why the lip will not move.
  material.userData.uniforms = uniforms;
  material.userData.depthMaterial = depthMaterial;
  return material;
}
