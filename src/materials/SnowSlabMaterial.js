import { MeshStandardMaterial, Color, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * A block of wind-packed snow, broken out of a slab and shouldered up by the
 * flow behind it.
 *
 * Built on `MeshStandardMaterial`, like the Lance's crystal and the hailstone,
 * for the same reason: this is a **solid** sitting in a heap of translucent
 * grains, and if it does not take the key light and cast into the shadow map it
 * disappears into the heap it is supposed to be standing out of. The first
 * version was an additive `ShaderMaterial` and the slabs read as bright smudges
 * hovering over the snow — the exact failure the hail material's header warns
 * about, arrived at independently.
 *
 * Three ideas, in the order they matter:
 *
 *   - **the fracture face.** A snow slab does not erode, it *breaks*, and it
 *     breaks on a plane. So one face of every block — the one pointing back up
 *     the slope, against the flow — is raw, bright, untouched snow, and every
 *     other face is the wind crust that was on the surface of the snowpack an
 *     hour ago. It is one dot product against a direction the ability resolves
 *     each frame, and it is the entire reason the blocks read as *broken* rather
 *     than as rocks that happen to be white. Widen `fractureSharp` down toward
 *     1 and the whole block goes raw; push it up and only the true crown face
 *     catches it.
 *   - **strata.** Wind-packed snow is layered, and the layers are horizontal
 *     *in the world*, not in the block: the block has been tipped over. So the
 *     banding is sampled on **world y** and not on local y. Sampling it locally
 *     was the first attempt and every slab came out banded along its own axis,
 *     which reads as a stack of coins and tells you instantly that the block
 *     was extruded rather than broken off something bigger.
 *   - **grain, hashed rather than smoothed.** A speckle on a hashed lattice,
 *     because value noise piles up at its midpoint and thresholding it gives
 *     either a clean block or a uniform rash — the trap `VolumeHull` documents.
 *
 * Per-instance inputs are the two attributes `GrowthField` dresses its geometry
 * with (`aSeed`, `aBirth`), so this is only ever used on an `InstancedMesh`.
 */
export function createSnowSlabMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.86,
    metalness: 0.0,
    // Faceted. A smooth-shaded snow block is a bread roll.
    flatShading: true
  });

  const uniforms = {
    uTime: frame.uTime,
    uColorCrust: { value: new Color() },
    uColorFracture: { value: new Color() },
    uColorShade: { value: new Color() },
    uColorGlow: { value: new Color() },
    uStrata: { value: 0.4 },
    uStrataScale: { value: 9.0 },
    uGrain: { value: 0.22 },
    uGrainScale: { value: 34.0 },
    uFracture: { value: 1.1 },
    uFractureSharp: { value: 1.9 },
    uRim: { value: 0.7 },
    uRimPower: { value: 2.6 },
    uGlow: { value: 0.85 },
    uBirthGlow: { value: 1.6 },
    /** Unit heading of the flow, world space. The crown face points at -this. */
    uFlow: { value: new Vector3(0, 0, 1) }
  };

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aSeed;
         attribute float aBirth;
         varying vec3  vSlabLocal;
         varying vec3  vSlabWorld;
         varying vec3  vSlabNormalW;
         varying float vSlabSeed;
         varying float vSlabBirth;`
      )
      // `objectNormal` is declared by <beginnormal_vertex>, which runs before
      // this chunk. three only ever takes it into *view* space, and the crown
      // face test needs it in world space.
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vSlabLocal = transformed;
         vSlabSeed  = aSeed;
         vSlabBirth = aBirth;
         #ifdef USE_INSTANCING
           vSlabWorld   = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
           vSlabNormalW = normalize(mat3(modelMatrix) * (instanceMatrix * vec4(objectNormal, 0.0)).xyz);
         #else
           vSlabWorld   = (modelMatrix * vec4(transformed, 1.0)).xyz;
           vSlabNormalW = normalize(mat3(modelMatrix) * objectNormal);
         #endif`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform vec3  uColorCrust;
         uniform vec3  uColorFracture;
         uniform vec3  uColorShade;
         uniform vec3  uColorGlow;
         uniform float uStrata;
         uniform float uStrataScale;
         uniform float uGrain;
         uniform float uGrainScale;
         uniform float uFracture;
         uniform float uFractureSharp;
         uniform float uRim;
         uniform float uRimPower;
         uniform float uGlow;
         uniform float uBirthGlow;
         uniform vec3  uFlow;
         varying vec3  vSlabLocal;
         varying vec3  vSlabWorld;
         varying vec3  vSlabNormalW;
         varying float vSlabSeed;
         varying float vSlabBirth;
         ${noiseGLSL}`
      )
      // Injected once the normal is resolved: with flatShading there is no
      // vNormal varying, so every view-dependent term has to read the face
      // normal that <normal_fragment_begin> derives from the derivatives.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           vec3  N   = normalize(normal);
           float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);

           /* --- the crown face: raw snow where the slab broke --- */
           // Measured on the WORLD normal, against the flow the ability hands
           // in. A block that has tumbled shows its broken face wherever that
           // face has ended up, which is the whole point of resolving it here
           // rather than baking it into the geometry.
           float crown = clamp(dot(normalize(vSlabNormalW), -uFlow), 0.0, 1.0);
           crown = pow(crown, max(uFractureSharp, 0.05));

           /* --- strata: horizontal in the ROOM, not in the block --- */
           float bands = sin(vSlabWorld.y * uStrataScale * 6.2831853 +
                             vSlabSeed * 5.1 +
                             fbm3(vSlabWorld * 0.9 + vSlabSeed) * 2.2);
           float strata = 1.0 + bands * uStrata * 0.5 * (1.0 - crown);

           /* --- grain, on a hashed lattice so it stays a speckle --- */
           float speck = hash13(floor(vSlabWorld * max(uGrainScale, 1.0)) + vSlabSeed * 13.0);
           float grain = 1.0 + (speck - 0.5) * 2.0 * uGrain;

           vec3 body = mix(uColorCrust, uColorFracture, crown * clamp(uFracture, 0.0, 1.5));
           body *= strata * grain;

           // Cheap cavity term: unit-space radius says how far out of the block
           // this fragment is, and the recesses of a fracture are dark.
           body *= mix(0.74, 1.05, smoothstep(0.15, 0.75, length(vSlabLocal.xz) + vSlabLocal.y * 0.3));
           // The shade colour is a picker, not a multiply on the body, so a
           // slab in shadow is blue-grey and not merely dimmer (I5).
           body = mix(uColorShade, body, clamp(0.35 + 0.65 * ndv, 0.0, 1.0));

           diffuseColor.rgb *= max(body, vec3(0.0));

           /* --- what actually emits: a rim, and the birth flash --- */
           vec3 glow = uColorGlow * pow(1.0 - ndv, max(uRimPower, 0.05)) * uRim;
           glow += uColorGlow * vSlabBirth * uBirthGlow;
           glow *= uGlow;
           // The soft ceiling the rock and the hailstone both use: these terms
           // are independent and stack, and a rim crossing a birth flash sums
           // past 8 and blows the whole block out under bloom.
           glow /= 1.0 + glow * 0.3;
           totalEmissiveRadiance += glow;
         }`
      );
  });

  /**
   * Parked here rather than on `material.uniforms`, which a patched
   * `MeshStandardMaterial` does not have. The harness's pause test reads this
   * exact property, and without it every slider below is reported dead (I8).
   */
  material.userData.uniforms = uniforms;

  /**
   * Pull the palette and every shading control from the live settings.
   * @param {THREE.Vector3} [flow] unit heading of the avalanche, world space
   */
  material.userData.sync = (flow = null) => {
    const c = settings.avalanche;
    const g = settings.global;

    material.roughness = c.slabRoughness;

    uniforms.uColorCrust.value.copy(getColor(c.colorCrust));
    uniforms.uColorFracture.value.copy(getColor(c.colorFracture));
    uniforms.uColorShade.value.copy(getColor(c.colorShade));
    uniforms.uColorGlow.value.copy(getColor(c.colorSlabGlow));

    uniforms.uStrata.value = c.strata;
    uniforms.uStrataScale.value = c.strataScale * g.noiseFrequency;
    uniforms.uGrain.value = c.grain * g.randomness;
    uniforms.uGrainScale.value = c.grainScale * g.noiseFrequency;
    uniforms.uFracture.value = c.fracture;
    uniforms.uFractureSharp.value = c.fractureSharp;
    uniforms.uRim.value = c.slabRim * g.fresnel;
    uniforms.uRimPower.value = c.slabRimPower;
    uniforms.uGlow.value = c.slabGlow * g.glow;
    uniforms.uBirthGlow.value = c.slabBirthGlow * g.shaderIntensity;

    if (flow) uniforms.uFlow.value.copy(flow);
  };

  return material;
}
