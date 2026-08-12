import { MeshStandardMaterial, Color, FrontSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Bark.
 *
 * A `MeshStandardMaterial` rather than a raw `ShaderMaterial`, for the same
 * reason `IceMaterial` is one: the vine is a *solid* in a scene with a sun, a
 * rim light and an HDR probe, and the single biggest thing separating it from
 * the sap column glowing behind it is that the sun actually lands on it and it
 * casts a shadow. Everything below is injected on top of that.
 *
 * ### The surface is authored in stem coordinates, not world space
 *
 * The mesh this runs on is swept along `Tube#pointAt()` fresh every frame, so
 * its vertices are somewhere different on every one of them. Two custom
 * attributes carry a coordinate system that is *not*:
 *
 * | attribute | meaning |
 * | --- | --- |
 * | `aBarkAlong` | metres from the root, measured along the stem |
 * | `aBarkRing`  | `(cos θ, sin θ)` of the position around the section |
 *
 * Both are material coordinates. Bark does not slide when the vine recoils and
 * grain does not swim when the axis drifts, and neither does anything here.
 *
 * The first version sampled `ridged(worldPosition * scale)` — the obvious
 * thing, and it gives a rock. Three-dimensional noise has no preferred
 * direction and bark is nothing *but* direction: what turns the mottle into
 * bark is sampling with the around-frequency an order above the along-frequency
 * (`uRidgeBands` ≈ 3.6 against `uRidgeScale` ≈ 0.55/m), so the field is nearly
 * constant along the stem and the ridges run its length.
 *
 * Passing `(cos θ, sin θ)` rather than θ itself is the other half of that. A
 * raw angle wraps from 1 back to 0 across the last quad of the ring, the noise
 * lookup sweeps backwards over that quad, and every vine had one bright seam
 * down its side. Interpolating the cosine and sine instead shortens the chord
 * by a fraction of a percent and has no seam at all.
 *
 * ### The wet highlight
 *
 * `uSheen` is keyed off the **world** normal's `y`, not off a fresnel term: the
 * brief is a wet highlight along *the top of the curve*, and a fresnel rim puts
 * it on the silhouette instead, which reads as a glass tube. `vBarkNormalW` is
 * carried from the vertex stage for exactly that, and `uSheenPower` decides how
 * narrow the band on top is. A crawling speck field (`uGlisten`) breaks it up,
 * because an unbroken specular stripe reads as plastic.
 *
 * Uniform boxes are parked on `material.userData.uniforms` — the
 * `IceMaterial` / `MeteorMaterial` convention, and the thing the harness's
 * pause test looks for. Without it thirty working sliders report as dead.
 */
export function createVineBarkMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.72,
    metalness: 0.0,
    // Smooth shading: a vine is a swept curve, and `flatShading` would facet
    // the ten-sided section into something that reads as a pencil. It also
    // means `vNormal` exists, which is what the roughness injection needs.
    flatShading: false,
    // Single-sided and depth-writing. The bark is opaque even while its master
    // alpha is winding down, and it has to occlude the additive sap tube drawn
    // in the same place — that occlusion is the entire reason the sap reads as
    // *inside* the stem rather than painted over it.
    side: FrontSide,
    transparent: true,
    depthWrite: true
  });

  const uniforms = {
    uTime: frame.uTime,
    uColorBark: { value: new Color() },
    uColorDeep: { value: new Color() },
    uColorSap: { value: new Color() },
    uColorSheen: { value: new Color() },
    uColorWither: { value: new Color() },
    uRidge: { value: 0.75 },
    uRidgeScale: { value: 0.55 },
    uRidgeBands: { value: 3.6 },
    uGrain: { value: 0.32 },
    uGrainScale: { value: 9.0 },
    uGrainBands: { value: 7.0 },
    uDepth: { value: 0.85 },
    uRough: { value: 0.72 },
    uRoughWet: { value: 0.24 },
    uSapGlow: { value: 1.5 },
    uSapPulse: { value: 0.55 },
    uSapPulseScale: { value: 1.4 },
    uSapPulseSpeed: { value: 2.4 },
    uSheen: { value: 1.6 },
    uSheenPower: { value: 5.5 },
    uGlisten: { value: 0.9 },
    uGlistenScale: { value: 26.0 },
    uGlistenSpeed: { value: 0.7 },
    uWither: { value: 0 }
  };

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aBarkAlong;
         attribute vec2  aBarkRing;
         varying float vBarkAlong;
         varying vec2  vBarkRing;
         varying vec3  vBarkNormalW;`
      )
      // After <beginnormal_vertex> so `objectNormal` exists; the vine's group
      // is parked at the origin with matrixAutoUpdate off, so modelMatrix is
      // the identity — this is written the long way anyway, because a mesh that
      // silently depends on its parent being untransformed is a landmine.
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         vBarkAlong = aBarkAlong;
         vBarkRing = aBarkRing;
         vBarkNormalW = normalize(mat3(modelMatrix) * objectNormal);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform vec3  uColorBark;
         uniform vec3  uColorDeep;
         uniform vec3  uColorSap;
         uniform vec3  uColorSheen;
         uniform vec3  uColorWither;
         uniform float uRidge;
         uniform float uRidgeScale;
         uniform float uRidgeBands;
         uniform float uGrain;
         uniform float uGrainScale;
         uniform float uGrainBands;
         uniform float uDepth;
         uniform float uRough;
         uniform float uRoughWet;
         uniform float uSapGlow;
         uniform float uSapPulse;
         uniform float uSapPulseScale;
         uniform float uSapPulseSpeed;
         uniform float uSheen;
         uniform float uSheenPower;
         uniform float uGlisten;
         uniform float uGlistenScale;
         uniform float uGlistenSpeed;
         uniform float uWither;
         varying float vBarkAlong;
         varying vec2  vBarkRing;
         varying vec3  vBarkNormalW;
         ${noiseGLSL}

         /* 0 on a ridge, 1 at the bottom of a groove. The one field the whole
            material is built out of, so it is computed once and shared. */
         float barkGroove() {
           float r = ridged(vec3(vBarkRing * uRidgeBands, vBarkAlong * uRidgeScale), 4);
           return clamp(smoothstep(0.42, 0.92, r), 0.0, 1.0);
         }`
      )
      // Grooves hold water and shed light differently from the ridges between
      // them, so roughness varies with the same field the colour does. Injected
      // here because `roughnessFactor` does not exist before this line.
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = mix(uRough, uRoughWet, barkGroove());`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           float groove = barkGroove();

           // Fibrous grain on top of the grooves: the same trick at a higher
           // frequency, and the reason a close-up does not read as corduroy.
           float grain = fbm3(vec3(vBarkRing * uGrainBands, vBarkAlong * uGrainScale)) * 0.5 + 0.5;

           vec3 body = mix(uColorBark, uColorDeep, groove * uDepth);
           body = mix(body, uColorDeep, grain * uGrain * 0.5);
           body = mix(body, uColorWither, clamp(uWither, 0.0, 1.0));
           diffuseColor.rgb *= body;

           // Sap in the grooves, pulsing up the stem. A travelling wave rather
           // than a global throb: the first version pulsed the whole stem at
           // once and it read as a heartbeat in a rubber hose, where what a
           // growing thing does is push a bolus of sap toward the tip.
           float wave = 0.5 + 0.5 * sin((vBarkAlong * uSapPulseScale -
                                         uTime * uSapPulseSpeed * uSapPulseScale) * PI2);
           float sap = groove * mix(1.0, wave, clamp(uSapPulse, 0.0, 1.0));

           // The wet highlight: the top of the curve, not the silhouette.
           float up = clamp(vBarkNormalW.y, 0.0, 1.0);
           float wet = pow(up, max(uSheenPower, 0.05));
           float speck = snoise(vec3(vBarkRing * uGlistenScale,
                                     vBarkAlong * uGlistenScale - uTime * uGlistenSpeed * uGlistenScale));
           wet *= mix(1.0, smoothstep(0.15, 0.85, speck * 0.5 + 0.5), clamp(uGlisten, 0.0, 1.0));

           vec3 glow = uColorSap * sap * uSapGlow;
           glow += uColorSheen * wet * uSheen;
           // Withered bark is dead wood: it stops glowing before it stops being
           // there, which is what makes the fade read as dying rather than as
           // an opacity ramp.
           glow *= 1.0 - clamp(uWither, 0.0, 1.0);
           // Soft ceiling, as in IceMaterial: the sap and the sheen peak in
           // different places but they do overlap on a wet ridge, and without
           // this the overlap sums past 4 and bloom smears the stem into a bar.
           glow /= 1.0 + glow * 0.3;

           totalEmissiveRadiance += glow;
         }`
      );
  });

  material.userData.uniforms = uniforms;

  /** Pull the palette and every shading control from the live settings. */
  material.userData.sync = () => {
    const c = settings.vinelash;
    const g = settings.global;

    uniforms.uColorBark.value.copy(getColor(c.colorBark));
    uniforms.uColorDeep.value.copy(getColor(c.colorBarkDeep));
    uniforms.uColorSap.value.copy(getColor(c.colorSap));
    uniforms.uColorSheen.value.copy(getColor(c.colorSheen));
    uniforms.uColorWither.value.copy(getColor(c.colorWither));

    uniforms.uRidge.value = c.barkRidge * g.shaderIntensity;
    uniforms.uRidgeScale.value = c.barkRidgeScale * g.noiseFrequency;
    uniforms.uRidgeBands.value = c.barkRidgeBands * g.noiseFrequency;
    uniforms.uGrain.value = c.barkGrain * g.shaderIntensity;
    uniforms.uGrainScale.value = c.barkGrainScale * g.noiseFrequency;
    uniforms.uGrainBands.value = c.barkGrainBands * g.noiseFrequency;
    uniforms.uDepth.value = c.barkDepth * c.barkRidge;
    uniforms.uRough.value = c.barkRoughness;
    uniforms.uRoughWet.value = c.barkRoughnessWet;
    uniforms.uSapGlow.value = c.sapGlow * g.glow;
    uniforms.uSapPulse.value = c.sapPulse;
    uniforms.uSapPulseScale.value = c.sapPulseScale;
    uniforms.uSapPulseSpeed.value = c.sapPulseSpeed * g.noiseSpeed;
    uniforms.uSheen.value = c.sheen * g.shaderIntensity;
    uniforms.uSheenPower.value = c.sheenPower;
    uniforms.uGlisten.value = c.glisten;
    uniforms.uGlistenScale.value = c.glistenScale * g.noiseFrequency;
    uniforms.uGlistenSpeed.value = c.glistenSpeed * g.noiseSpeed;

    material.roughness = c.barkRoughness;
    material.envMapIntensity = c.barkEnv;
  };

  material.userData.sync();
  return material;
}
