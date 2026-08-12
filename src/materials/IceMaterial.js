import { MeshStandardMaterial, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { disruptGLSL, disruptUniforms } from '../vfx/SceneHooks.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Procedurally shaded ice.
 *
 * Built on MeshStandardMaterial rather than a raw ShaderMaterial so the crystals
 * cast and receive the stage's real shadows and pick up the HDR probe — the
 * stylisation is injected on top:
 *
 *   - **thickness tint** — a facet seen head-on has the longest path through the
 *     crystal, so it darkens toward `colorDeep`; grazing edges stay pale. This is
 *     the term that makes the field read as a solid you can see *into* rather
 *     than as blue plastic.
 *   - **internal fracture** — ridged noise sampled in *world* space, so the crack
 *     planes stay a fixed physical size whether a spike is ankle-high or three
 *     metres tall, and neighbouring crystals look quarried from the same block.
 *   - **feather frost & rime** — fbm sampled in *local* space (0..1 up the
 *     crystal), so the milky veining and the frost creeping up from the base
 *     follow each spike's own axis however it is scaled or leaned.
 *   - **sparkle** — a hard-thresholded high-frequency field scrolling in world
 *     space, biased toward grazing angles, which is where real ice glints.
 *   - **birth flash** — a per-instance value the ability drives from 1 to 0 over
 *     `birthFade`, so a crystal is lit from within for the moment it erupts.
 *
 * Per-instance inputs arrive as instanced attributes (`aSeed`, `aBirth`), which
 * is why this material is only ever used on an InstancedMesh.
 */
export function createIceMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.16,
    metalness: 0.0,
    flatShading: true,
    transparent: true,
    // Ice is translucent, so the far wall of a crystal is part of what you see
    // through the near one. Culling it left the interior empty and the spikes
    // read as hollow shells wherever the body was thin.
    side: DoubleSide,
    // Kept on: the crystals are near-opaque, and writing depth is what stops the
    // field from sorting through itself and lets the mist fade against it.
    depthWrite: true
  });

  const uniforms = {
    // Opt-in to `vfx/SceneHooks.js`'s published disruption region — the shared
    // boxes, by identity, never a clone. Frost Lance is the standing effect
    // Spellbreak is most often cast into, and before this the field simply
    // ignored it: three of the library's modules had opted in and none of them
    // is a crystal. Nothing is read here unless a `Hook.DISRUPT` is held, at
    // which point the cost is one distance in the fragment stage.
    ...disruptUniforms(),
    uTime: frame.uTime,
    uColorDeep: { value: new Color() },
    uColorIce: { value: new Color() },
    uColorRim: { value: new Color() },
    uColorCore: { value: new Color() },
    uDensity: { value: 1.15 },
    uFresnel: { value: 2.3 },
    uFresnelPower: { value: 2.4 },
    uTranslucency: { value: 1.5 },
    uFacetSharp: { value: 0.68 },
    uFracture: { value: 0.62 },
    uFractureScale: { value: 6.5 },
    uVeins: { value: 0.45 },
    uVeinScale: { value: 3.2 },
    uSparkle: { value: 1.6 },
    uSparkleScale: { value: 34 },
    uSparkleSpeed: { value: 0.7 },
    uFrostLine: { value: 0.5 },
    uGlow: { value: 1.35 },
    uEdgeGlow: { value: 2.0 },
    uBirthGlow: { value: 3.2 }
  };

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aSeed;
         attribute float aBirth;
         varying vec3  vIceLocal;
         varying vec3  vIceWorld;
         varying float vIceSeed;
         varying float vIceBirth;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vIceLocal = transformed;
         vIceSeed = aSeed;
         vIceBirth = aBirth;
         #ifdef USE_INSTANCING
           vIceWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
         #else
           vIceWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
         #endif`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform vec3  uColorDeep;
         uniform vec3  uColorIce;
         uniform vec3  uColorRim;
         uniform vec3  uColorCore;
         uniform float uDensity;
         uniform float uFresnel;
         uniform float uFresnelPower;
         uniform float uTranslucency;
         uniform float uFacetSharp;
         uniform float uFracture;
         uniform float uFractureScale;
         uniform float uVeins;
         uniform float uVeinScale;
         uniform float uSparkle;
         uniform float uSparkleScale;
         uniform float uSparkleSpeed;
         uniform float uFrostLine;
         uniform float uGlow;
         uniform float uEdgeGlow;
         uniform float uBirthGlow;
         varying vec3  vIceLocal;
         varying vec3  vIceWorld;
         varying float vIceSeed;
         varying float vIceBirth;
         ${noiseGLSL}
         ${disruptGLSL}`
      )
      // Injected once the normal is resolved: with `flatShading` there is no
      // `vNormal` varying, so every view-dependent term here has to read the
      // face normal that <normal_fragment_begin> derives from derivatives.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           vec3  N   = normalize(normal);
           float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);

           // Facing a facet you look down the long axis of the crystal; at a
           // grazing angle you are only clipping its edge.
           float thickness = clamp(ndv * uDensity, 0.0, 1.0);
           float fres = pow(1.0 - ndv, uFresnelPower) * uFresnel;

           // World space: crack planes keep a fixed physical scale, so a small
           // shard and a tall spike look cut from the same glacier.
           vec3  fp     = vIceWorld * uFractureScale + vIceSeed * 37.0;
           float cracks = smoothstep(0.55, 0.98, ridged(fp, 4));

           // Local space: veining follows each crystal's own axis.
           float veins = fbm3(vIceLocal * uVeinScale * 4.0 + vIceSeed * 11.0) * 0.5 + 0.5;
           veins = smoothstep(0.45, 0.92, veins);

           vec3 body = mix(uColorIce, uColorDeep, thickness);
           body = mix(body, uColorRim, veins * uVeins * 0.55);
           body = mix(body, uColorRim, cracks * uFracture * 0.4);

           // Rime gathers where the crystal left the floor.
           float rime = smoothstep(0.55, 0.0, vIceLocal.y) *
                        (0.5 + 0.5 * fbm3(vIceLocal * 9.0 + vIceSeed * 5.0));
           body = mix(body, uColorRim, clamp(rime, 0.0, 1.0) * uFrostLine);

           // Lift the facets that point at the camera so the silhouette reads as
           // a bundle of planes rather than one smooth mass.
           body *= mix(1.0, 0.55 + 0.9 * ndv, uFacetSharp);

           // Pinpoint glints, biased to the grazing angles where ice catches.
           float sp = snoise(vIceWorld * uSparkleScale +
                             vec3(0.0, uTime * uSparkleSpeed, 0.0) + vIceSeed * 23.0);
           sp = pow(clamp(sp, 0.0, 1.0), 14.0) * smoothstep(0.0, 0.7, fres + 0.3);

           diffuseColor.rgb *= body;

           // The rim *glow* rides a normalised 0..1 fresnel, not fres. fres
           // carries uFresnel (2.3 by default) because it also drives opacity,
           // and folding that gain into the emissive too was multiplying the
           // silhouette up past 4x white before any of the other terms landed.
           float rimAmount = pow(1.0 - ndv, uFresnelPower);

           vec3 glow = uColorRim * rimAmount * uEdgeGlow;
           glow += uColorCore * (cracks * uFracture * 0.8 + veins * uVeins * 0.35) * uTranslucency;
           glow += uColorRim * sp * uSparkle * 1.5;
           glow += uColorCore * vIceBirth * uBirthGlow;
           glow *= uGlow;

           // Soft ceiling. The terms above are independent and all peak at a
           // grazing angle, so they stack: without this a facet on the silhouette
           // sums to well over 10 and the crystal reads as a white blob with the
           // bloom pass smeared across it. A Reinhard rolloff leaves everything
           // under ~1 essentially untouched and asymptotes at 1/0.22 ≈ 4.5, so
           // the sliders still bite at the top of their range without blowing out.
           glow /= 1.0 + glow * 0.22;

           totalEmissiveRadiance += glow;

           // Thin at the edges, denser through the body and along the cracks.
           diffuseColor.a = clamp(diffuseColor.a * (0.62 + 0.5 * fres) + cracks * 0.12, 0.0, 1.0);

           // Spellbreak's field (vfx/SceneHooks.js). Last, on the finished
           // fragment: draining the body before the emissive above is summed
           // would leave a grey crystal with a full-strength glow still coming
           // out of its cracks, which reads as a lighting bug rather than as
           // the spell being pulled apart. Ice is already a transparent, so the
           // cell erosion lands on the alpha and no discard is needed — the
           // opaque growth materials in vfx/GrowthField.js are not so lucky.
           // Whole locals for the inout arguments, not swizzles.
           float iceDisrupt = disruptAt(vIceWorld);
           if (iceDisrupt > 0.0) {
             vec3  iceAlbedo = diffuseColor.rgb;
             float iceAlpha  = diffuseColor.a;
             disruptShade(iceAlbedo, iceAlpha, iceDisrupt, gl_FragCoord.xy);
             diffuseColor.rgb = iceAlbedo;
             diffuseColor.a = iceAlpha;

             vec3  iceGlow = totalEmissiveRadiance;
             float iceGlowKeep = 1.0;
             disruptShade(iceGlow, iceGlowKeep, iceDisrupt, gl_FragCoord.xy);
             totalEmissiveRadiance = iceGlow * iceGlowKeep;
           }
         }`
      );
  });

  material.userData.uniforms = uniforms;

  /** Pull the palette and every shading control from the live settings. */
  material.userData.sync = () => {
    const c = settings.ice;
    const g = settings.global;

    uniforms.uColorDeep.value.copy(getColor(c.colorDeep));
    uniforms.uColorIce.value.copy(getColor(c.colorIce));
    uniforms.uColorRim.value.copy(getColor(c.colorRim));
    uniforms.uColorCore.value.copy(getColor(c.colorCore));

    uniforms.uDensity.value = c.depthTint;
    uniforms.uFresnel.value = c.fresnel * g.fresnel;
    uniforms.uFresnelPower.value = c.fresnelPower;
    uniforms.uTranslucency.value = c.translucency;
    uniforms.uFacetSharp.value = c.facetSharp;
    uniforms.uFracture.value = c.fracture * g.shaderIntensity;
    uniforms.uFractureScale.value = c.fractureScale * g.noiseFrequency;
    uniforms.uVeins.value = c.veins * g.shaderIntensity;
    uniforms.uVeinScale.value = c.veinScale * g.noiseFrequency;
    uniforms.uSparkle.value = c.glint * g.shaderIntensity;
    uniforms.uSparkleScale.value = c.glintScale;
    uniforms.uSparkleSpeed.value = c.glintSpeed * g.noiseSpeed;
    uniforms.uFrostLine.value = c.frostLine;
    uniforms.uGlow.value = c.glow * g.glow;
    uniforms.uEdgeGlow.value = c.edgeGlow;
    uniforms.uBirthGlow.value = c.birthGlow;

    material.opacity = c.opacity * g.opacity;
    material.envMapIntensity = c.envIntensity;
  };

  material.userData.sync();
  return material;
}
