import { MeshStandardMaterial, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Ghost iron — the metal a soul chain is forged out of.
 *
 * A `MeshStandardMaterial` because a chain has to be *metal*: the read depends
 * entirely on a hard specular running along the top of each link as the chain
 * swings, and no emissive-only shader in this project can produce one. Cast
 * iron with a pitted surface, a cold fresnel rim, and a glow that lives on the
 * **inside** of each ring.
 *
 * ### The inner glow, and why it needs an attribute
 *
 * "Ghost-iron with an inner glow" is not a rim light. A rim light is on the
 * silhouette, which is the outside; what makes a chain look haunted is light
 * coming out of the *holes* — the concave inner wall of every link, which is
 * the one part of the surface that faces its neighbours rather than the world.
 *
 * There is no way to ask a general mesh which of its faces those are, so the
 * link builder records it. Every vertex carries `aLinkSection`, the cosine and
 * sine of its angle around the swept tube, with the cosine measured against the
 * ring's **outward** in-plane direction. `-cos α` is therefore exactly "how far
 * inside the hole am I", and `uSoulInner` is the exponent that decides how
 * tightly the glow hugs it. The first version used `1 − N·V` and the chain lit
 * up like chrome; the glow was everywhere the metal was, which is the one place
 * it should not be.
 *
 * ### Per-instance state, and the negative break flag
 *
 * Three instanced attributes:
 *
 * | attribute | meaning |
 * | --- | --- |
 * | `aLinkStation` | 0..1 along the chain, hand → far anchor |
 * | `aLinkSeed`    | unitless dice, 0..1 |
 * | `aLinkBreak`   | **−1 while the link is threaded**; 0..1 once it has broken free, as a fraction of `breakLife` |
 *
 * The negative sentinel is doing real work. A separate boolean attribute would
 * be a second upload per frame for one bit, and a `0` sentinel collides with
 * "broke this exact frame" — which is the frame the link is supposed to be at
 * its hottest. `step(0.0, aLinkBreak)` reads the flag and the same number
 * carries the fall.
 *
 * Uniform boxes are parked on `material.userData.uniforms`, the
 * `IceMaterial` / `MeteorMaterial` convention the harness's pause test looks
 * for.
 */
export function createGhostIronMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.44,
    metalness: 0.85,
    flatShading: false,
    // A link is a thin swept tube seen from every side at once as the chain
    // twists; back faces are a real part of the silhouette through the hole.
    side: DoubleSide,
    transparent: true,
    depthWrite: true
  });

  const uniforms = {
    uTime: frame.uTime,
    uColorIron: { value: new Color() },
    uColorIronDeep: { value: new Color() },
    uColorSoul: { value: new Color() },
    uColorGhost: { value: new Color() },
    uColorBreak: { value: new Color() },
    uPit: { value: 0.55 },
    uPitScale: { value: 42 },
    uSoulGlow: { value: 2.2 },
    uSoulInner: { value: 2.6 },
    uSoulPulse: { value: 0.7 },
    uPulseScale: { value: 1.6 },
    uPulseSpeed: { value: 1.1 },
    uRim: { value: 1.4 },
    uRimPower: { value: 3.2 },
    uBreakGlow: { value: 3.5 }
  };

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec2  aLinkSection;
         attribute float aLinkStation;
         attribute float aLinkSeed;
         attribute float aLinkBreak;
         varying vec2  vLinkSection;
         varying float vLinkStation;
         varying float vLinkSeed;
         varying float vLinkBreak;
         varying vec3  vLinkLocal;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vLinkSection = aLinkSection;
         vLinkStation = aLinkStation;
         vLinkSeed = aLinkSeed;
         vLinkBreak = aLinkBreak;
         vLinkLocal = transformed;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform vec3  uColorIron;
         uniform vec3  uColorIronDeep;
         uniform vec3  uColorSoul;
         uniform vec3  uColorGhost;
         uniform vec3  uColorBreak;
         uniform float uPit;
         uniform float uPitScale;
         uniform float uSoulGlow;
         uniform float uSoulInner;
         uniform float uSoulPulse;
         uniform float uPulseScale;
         uniform float uPulseSpeed;
         uniform float uRim;
         uniform float uRimPower;
         uniform float uBreakGlow;
         varying vec2  vLinkSection;
         varying float vLinkStation;
         varying float vLinkSeed;
         varying float vLinkBreak;
         varying vec3  vLinkLocal;
         ${noiseGLSL}

         /* Casting pits. Local space, offset by the per-link dice, so two links
            side by side are pitted differently and neither of them swims when
            the chain moves. */
         float ironPit() {
           return clamp(smoothstep(0.4, 0.95,
             ridged(vLinkLocal * uPitScale + vLinkSeed * 31.0, 4)), 0.0, 1.0);
         }`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = clamp(roughnessFactor + ironPit() * uPit * 0.45, 0.03, 1.0);`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           float pit = ironPit();
           diffuseColor.rgb *= mix(uColorIron, uColorIronDeep, pit * uPit);

           vec3  N   = normalize(normal);
           float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);

           // Inside the hole, not on the silhouette. See the header.
           float inner = pow(clamp(-vLinkSection.x, 0.0, 1.0), max(uSoulInner, 0.05));
           float pulse = 0.5 + 0.5 * sin((vLinkStation * uPulseScale - uTime * uPulseSpeed) * PI2);
           float soul = inner * mix(1.0, pulse, clamp(uSoulPulse, 0.0, 1.0));

           float rim = pow(1.0 - ndv, max(uRimPower, 0.05)) * uRim;

           // −1 means "still threaded". A link is at its hottest on the frame it
           // lets go and cools on its way down, which is what makes twenty of
           // them breaking in sequence read as twenty events.
           float broken = step(0.0, vLinkBreak);
           float hot = broken * exp(-5.0 * max(vLinkBreak, 0.0));

           vec3 glow = uColorSoul * soul * uSoulGlow;
           glow += uColorGhost * rim;
           glow += uColorBreak * hot * uBreakGlow;
           // Reinhard ceiling, as in IceMaterial: the three terms peak in
           // different places but a freshly broken link on the silhouette hits
           // all three at once and bloom turns it into a white disc.
           glow /= 1.0 + glow * 0.26;

           totalEmissiveRadiance += glow;

           // A freed link fades out over the back half of its fall rather than
           // popping. Threaded links are untouched.
           diffuseColor.a *= 1.0 - broken * smoothstep(0.55, 1.0, max(vLinkBreak, 0.0));
         }`
      );
  });

  material.userData.uniforms = uniforms;

  /** Pull the palette and every shading control from the live settings. */
  material.userData.sync = () => {
    const c = settings.soulchain;
    const g = settings.global;

    uniforms.uColorIron.value.copy(getColor(c.colorIron));
    uniforms.uColorIronDeep.value.copy(getColor(c.colorIronDeep));
    uniforms.uColorSoul.value.copy(getColor(c.colorSoul));
    uniforms.uColorGhost.value.copy(getColor(c.colorGhost));
    uniforms.uColorBreak.value.copy(getColor(c.colorBreak));

    uniforms.uPit.value = c.ironPit * g.shaderIntensity;
    uniforms.uPitScale.value = c.ironPitScale * g.noiseFrequency;
    uniforms.uSoulGlow.value = c.soulGlow * g.glow;
    uniforms.uSoulInner.value = c.soulInner;
    uniforms.uSoulPulse.value = c.soulPulse;
    uniforms.uPulseScale.value = c.soulPulseScale;
    uniforms.uPulseSpeed.value = c.soulPulseSpeed * g.noiseSpeed;
    uniforms.uRim.value = c.ghostRim * g.fresnel;
    uniforms.uRimPower.value = c.ghostRimPower;
    uniforms.uBreakGlow.value = c.breakGlow * g.glow;

    material.roughness = Math.min(1, c.ironRough);
    material.metalness = Math.min(1, c.ironMetal);
    material.envMapIntensity = c.ironEnv;
  };

  material.userData.sync();
  return material;
}
