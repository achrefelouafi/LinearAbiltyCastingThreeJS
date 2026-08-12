import {
  MeshStandardMaterial,
  ShaderMaterial,
  Color,
  Vector3,
  DoubleSide,
  NormalBlending
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame, sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The two materials Shatterlance is made of, in one file because they share a
 * job: making a swarm of shards and the lance they merge into look like the
 * same piece of ice.
 *
 *  - `createLanceMaterial()` — the lance. A patched `MeshStandardMaterial`, so
 *    it takes the stage's shadows and the HDR probe, with faceted crystal
 *    shading and a **longitudinal seam** that runs its whole length.
 *  - `createIntakeMaterial()` — the converging shards. A raw `ShaderMaterial`
 *    that places every instance *parametrically in its vertex shader*, from a
 *    point on a sphere to a point on the lance's surface.
 *
 * ## The seam, and the one place an angular sample is not a mistake
 *
 * Everything else in this project that samples `atan(y, x)` is a bug — an
 * angular lookup hands every radius along a bearing the same value and draws
 * dead-straight spokes, which is why `GroundField` warps its front in the plane
 * instead. The lance is the exception, and it is worth saying why: a fluted
 * prism's grooves genuinely *are* angular features of its cross-section, cut at
 * a fixed count around the axis and running the full length. Sampling the seam
 * on the bearing is not an approximation of the geometry, it is a description
 * of it, and the twist term follows the same helix the geometry factory cuts.
 *
 * ## The convergence is closed form
 *
 * A shard's position is `mix(sphere point, lance point, ease(t))` where `t` is
 * the assembly clock minus that shard's own stagger. Nothing integrates and
 * nothing is stored between frames, so dragging `intakeSphere` on a paused
 * wind-up re-flies every shard from a bigger shell — which an Euler integrator
 * physically could not do, because it has already spent the old radius.
 *
 * Both materials park their uniforms on `userData.uniforms`, because the
 * harness's pause test reads a patched standard material's uniforms from
 * exactly there and will otherwise report thirty working sliders as dead.
 */

/* ---------------------------------------------------------------------- */
/* The lance                                                               */
/* ---------------------------------------------------------------------- */

export function createLanceMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.1,
    metalness: 0.0,
    flatShading: true,
    transparent: true,
    // A lance is a solid you can see into: the far wall is part of the read.
    side: DoubleSide,
    depthWrite: true
  });

  const uniforms = {
    uTime: frame.uTime,
    uColorIce: { value: new Color() },
    uColorDeep: { value: new Color() },
    uColorSeam: { value: new Color() },
    uColorRim: { value: new Color() },
    uDepthTint: { value: 1.3 },
    uFresnel: { value: 2.0 },
    uFresnelPower: { value: 2.3 },
    uFacetSharp: { value: 0.62 },
    uFracture: { value: 0.3 },
    uFractureScale: { value: 5.0 },
    uVeins: { value: 0.28 },
    uVeinScale: { value: 2.6 },
    uSeamGlow: { value: 2.4 },
    uSeamCount: { value: 3.5 },
    uSeamWidth: { value: 0.35 },
    uSeamTwist: { value: 0.5 },
    uGlint: { value: 1.4 },
    uGlintScale: { value: 22 },
    uGlintSpeed: { value: 0.6 },
    uGlow: { value: 1.4 },
    /** 0..1 while the lance is assembling; 1 once it is whole. */
    uCharge: { value: 0 },
    uChargeGlow: { value: 3.0 }
  };

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aSeed;
         attribute float aBirth;
         varying vec3  vLanceLocal;
         varying vec3  vLanceWorld;
         varying float vLanceSeed;
         varying float vLanceBirth;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vLanceLocal = transformed;
         vLanceSeed  = aSeed;
         vLanceBirth = aBirth;
         #ifdef USE_INSTANCING
           vLanceWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
         #else
           vLanceWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
         #endif`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform vec3  uColorIce;
         uniform vec3  uColorDeep;
         uniform vec3  uColorSeam;
         uniform vec3  uColorRim;
         uniform float uDepthTint;
         uniform float uFresnel;
         uniform float uFresnelPower;
         uniform float uFacetSharp;
         uniform float uFracture;
         uniform float uFractureScale;
         uniform float uVeins;
         uniform float uVeinScale;
         uniform float uSeamGlow;
         uniform float uSeamCount;
         uniform float uSeamWidth;
         uniform float uSeamTwist;
         uniform float uGlint;
         uniform float uGlintScale;
         uniform float uGlintSpeed;
         uniform float uGlow;
         uniform float uCharge;
         uniform float uChargeGlow;
         varying vec3  vLanceLocal;
         varying vec3  vLanceWorld;
         varying float vLanceSeed;
         varying float vLanceBirth;
         ${noiseGLSL}`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           vec3  N   = normalize(normal);
           float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);

           // A solid, unlike the rime plates: face a facet and you are looking
           // down the long axis of the body, so it deepens.
           float thick = clamp(ndv * uDepthTint, 0.0, 1.0);
           float fres = pow(1.0 - ndv, uFresnelPower) * uFresnel;

           // Fracture in world space so the lance and the fragments it breaks
           // into look quarried from one block.
           float cracks = smoothstep(0.58, 0.98, ridged(vLanceWorld * uFractureScale + vLanceSeed * 31.0, 4));
           float veins = smoothstep(0.45, 0.92,
                         fbm3(vLanceLocal * uVeinScale * 4.0 + vLanceSeed * 9.0) * 0.5 + 0.5);

           vec3 body = mix(uColorIce, uColorDeep, thick);
           body = mix(body, uColorRim, veins * uVeins * 0.5);
           body = mix(body, uColorRim, cracks * uFracture * 0.35);
           body *= mix(1.0, 0.55 + 0.9 * ndv, uFacetSharp);

           // The seam: the flute valleys, sampled on the bearing because that
           // is genuinely what they are — see the module header.
           float bearing = atan(vLanceLocal.z, vLanceLocal.x);
           float flute = abs(sin(bearing * uSeamCount + vLanceLocal.y * uSeamTwist * 6.2831853));
           float seam = pow(1.0 - clamp(flute, 0.0, 1.0), max(1.0, 1.0 / max(uSeamWidth, 0.02)));

           // While it assembles, a band of light runs from the tail to the tip
           // on the charge clock: the lance filling up, one shard at a time.
           float fill = smoothstep(uCharge + 0.18, uCharge - 0.05, vLanceLocal.y);
           float weld = smoothstep(0.16, 0.0, abs(vLanceLocal.y - uCharge)) * (1.0 - step(0.999, uCharge));

           float glint = snoise(vLanceWorld * uGlintScale +
                                vec3(0.0, uTime * uGlintSpeed, 0.0) + vLanceSeed * 13.0);
           glint = pow(clamp(glint, 0.0, 1.0), 13.0);

           vec3 glow = uColorSeam * seam * uSeamGlow * mix(0.35, 1.0, fill);
           glow += uColorRim * pow(1.0 - ndv, uFresnelPower) * uFresnel * 0.5;
           glow += uColorSeam * (weld + vLanceBirth) * uChargeGlow;
           glow += uColorRim * glint * uGlint;
           glow += uColorSeam * cracks * uFracture * 0.4;
           glow *= uGlow;

           // The same Reinhard ceiling the crystals use — every term here peaks
           // at a grazing angle and they stack.
           glow /= 1.0 + glow * 0.22;

           diffuseColor.rgb *= body;
           totalEmissiveRadiance += glow;
           diffuseColor.a = clamp(diffuseColor.a * (0.66 + 0.5 * fres) + seam * 0.1, 0.0, 1.0);
         }`
      );
  });

  material.userData.uniforms = uniforms;

  material.userData.sync = () => {
    const c = settings.shatterlance;
    const g = settings.global;

    uniforms.uColorIce.value.copy(getColor(c.colorIce));
    uniforms.uColorDeep.value.copy(getColor(c.colorDeep));
    uniforms.uColorSeam.value.copy(getColor(c.colorSeam));
    uniforms.uColorRim.value.copy(getColor(c.colorRim));

    uniforms.uDepthTint.value = c.depthTint;
    uniforms.uFresnel.value = c.fresnel * g.fresnel;
    uniforms.uFresnelPower.value = c.fresnelPower;
    uniforms.uFacetSharp.value = c.facetSharp;
    uniforms.uFracture.value = c.fracture * g.shaderIntensity;
    uniforms.uFractureScale.value = c.fractureScale * g.noiseFrequency;
    uniforms.uVeins.value = c.veins * g.shaderIntensity;
    uniforms.uVeinScale.value = c.veinScale * g.noiseFrequency;
    uniforms.uSeamGlow.value = c.seamGlow;
    uniforms.uSeamCount.value = Math.max(0.5, c.seamCount);
    uniforms.uSeamWidth.value = c.seamWidth;
    uniforms.uSeamTwist.value = c.seamTwist;
    uniforms.uGlint.value = c.glint * g.shaderIntensity;
    uniforms.uGlintScale.value = c.glintScale;
    uniforms.uGlintSpeed.value = c.glintSpeed * g.noiseSpeed;
    uniforms.uGlow.value = c.glow * g.glow;
    uniforms.uChargeGlow.value = c.chargeGlow;

    material.opacity = c.opacity * g.opacity;
    material.roughness = c.roughness;
    material.envMapIntensity = c.envIntensity;
  };

  material.userData.sync();
  return material;
}

/* ---------------------------------------------------------------------- */
/* The converging shards                                                   */
/* ---------------------------------------------------------------------- */

const INTAKE_VERTEX = /* glsl */ `
  attribute float aSeed;

  uniform vec3  uHub;          // world centre of the lance
  uniform vec3  uAxis;         // unit, down the lance
  uniform vec3  uSide;         // unit, across it
  uniform vec3  uUp;           // unit, uAxis x uSide
  uniform float uAssembly;     // 0..1 the wind-up clock
  uniform float uStagger;      // 0..1 of that clock spread over the shards
  uniform float uSphere;       // metres, the shell they start on
  uniform float uSpread;       // metres, that shell stretched along the axis
  uniform float uLanceHalf;    // metres, half the lance
  uniform float uLanceRadius;  // metres
  uniform float uSize;         // metres, one shard
  uniform float uSpin;         // radians/second of tumble
  uniform float uEase;         // >1 makes them accelerate in late
  uniform float uSeed;         // per-cast, so two casts do not draw the same intake
  uniform float uTime;

  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vShardT;

  float ihash(float p) {
    return fract(sin(p * 127.1) * 43758.5453);
  }

  void main() {
    float s0 = aSeed + uSeed;
    float h1 = ihash(s0 * 1.7);
    float h2 = ihash(s0 * 3.3 + 4.1);
    float h3 = ihash(s0 * 5.9 + 8.7);
    float h4 = ihash(s0 * 7.1 + 12.3);
    float h5 = ihash(s0 * 11.3 + 19.9);

    // Where it starts: a point on a shell about the hub, stretched along the
    // axis so the intake is a capsule rather than a ball — a ball puts as many
    // shards behind the caster as in front of him.
    float cosT = h1 * 2.0 - 1.0;
    float sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
    float phi = h2 * 6.2831853;
    vec3 start = uHub
               + uSide * (sinT * cos(phi) * uSphere)
               + uUp   * (cosT * uSphere)
               + uAxis * (sinT * sin(phi) * uSpread);

    // Where it lands: a point on the lance's own surface.
    float along = (h3 * 2.0 - 1.0) * uLanceHalf;
    float bearing = h4 * 6.2831853;
    vec3 target = uHub
                + uAxis * along
                + (uSide * cos(bearing) + uUp * sin(bearing)) * (uLanceRadius * (0.45 + 0.55 * h5));

    // Closed form, so a paused wind-up re-flies under the slider.
    float t = clamp((uAssembly - h5 * uStagger) / max(1e-3, 1.0 - uStagger), 0.0, 1.0);
    float e = 1.0 - pow(1.0 - t, max(1.0, uEase));
    vec3 hub = mix(start, target, e);

    // It shrinks into the last few centimetres of its flight, so the merge
    // reads as absorption rather than as shards parked on the surface.
    float scale = uSize * (1.0 - smoothstep(0.62, 1.0, t));

    // Tumble about its own axis.
    vec3 spinAxis = normalize(vec3(h4 - 0.5, h1 - 0.5, h2 - 0.5) + vec3(1e-4, 1e-4, 1e-4));
    float ang = uTime * uSpin * (0.6 + h3) + h1 * 6.2831853;
    float ca = cos(ang);
    float sa = sin(ang);

    vec3 p = position * scale;
    vec3 rotated = p * ca + cross(spinAxis, p) * sa + spinAxis * dot(spinAxis, p) * (1.0 - ca);
    vec3 n = normal * ca + cross(spinAxis, normal) * sa + spinAxis * dot(spinAxis, normal) * (1.0 - ca);

    vec3 world = hub + rotated;

    vShardT = t;
    vNormalW = normalize(mat3(modelMatrix) * n);
    vViewDir = cameraPosition - world;

    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(world, 1.0);
  }
`;

const INTAKE_FRAGMENT = /* glsl */ `
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uColorEdge;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uRim;
  uniform float uRimPower;
  uniform float uShade;
  uniform float uAmbient;
  uniform float uFade;

  uniform vec3  uLightDir;
  uniform float uGlobalGlow;

  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vShardT;

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDir);

    // Two-sided: a shard is thin enough that its back face is on screen half
    // the time, and lighting it from behind makes the swarm flicker black.
    float lambert = max(dot(N, uLightDir), 0.0);
    if (dot(N, V) < 0.0) lambert = max(dot(-N, uLightDir), 0.0);
    float shade = mix(1.0, uAmbient + (1.0 - uAmbient) * lambert, uShade);

    float fres = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), uRimPower);

    // A shard cools from the shell colour to the lance colour as it arrives, so
    // the swarm reads as feeding the thing it is turning into.
    vec3 color = mix(uColorA, uColorB, clamp(vShardT, 0.0, 1.0)) * shade;
    color += uColorEdge * fres * uRim * uGlow * uGlobalGlow;

    // Gone by the time it lands; the lance is what is left.
    float alpha = uOpacity * uFade * (1.0 - smoothstep(0.62, 1.0, vShardT));
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The shards that fly in and become the lance.
 *
 * One draw call for the whole intake: an `InstancedBufferGeometry` whose only
 * per-instance attribute is a seed, with every metre of the flight resolved
 * from uniforms in the vertex shader. There is no per-shard state on the CPU at
 * all, which is the strongest form of invariant I1 available.
 */
export function createIntakeMaterial() {
  const uniforms = sharedUniforms({
    uHub: { value: new Vector3() },
    uAxis: { value: new Vector3(0, 0, 1) },
    uSide: { value: new Vector3(1, 0, 0) },
    uUp: { value: new Vector3(0, 1, 0) },
    uAssembly: { value: 0 },
    uStagger: { value: 0.55 },
    uSphere: { value: 4.5 },
    uSpread: { value: 3.2 },
    uLanceHalf: { value: 2.1 },
    uLanceRadius: { value: 0.42 },
    uSize: { value: 0.22 },
    uSpin: { value: 6 },
    uEase: { value: 3 },
    uSeed: { value: 0 },
    uFade: { value: 1 },
    uColorA: { value: new Color() },
    uColorB: { value: new Color() },
    uColorEdge: { value: new Color() },
    uOpacity: { value: 0.95 },
    uGlow: { value: 1.6 },
    uRim: { value: 1.2 },
    uRimPower: { value: 2.2 },
    uShade: { value: 1 },
    uAmbient: { value: 0.35 }
  });

  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: true,
    depthTest: true,
    side: DoubleSide,
    blending: NormalBlending,
    toneMapped: false,
    uniforms,
    vertexShader: INTAKE_VERTEX,
    fragmentShader: INTAKE_FRAGMENT
  });

  material.userData.uniforms = uniforms;

  material.userData.sync = () => {
    const c = settings.shatterlance;
    const g = settings.global;

    uniforms.uColorA.value.copy(getColor(c.colorIntakeA));
    uniforms.uColorB.value.copy(getColor(c.colorIntakeB));
    uniforms.uColorEdge.value.copy(getColor(c.colorIntakeEdge));

    uniforms.uStagger.value = Math.min(0.95, c.intakeStagger);
    uniforms.uSphere.value = c.intakeSphere;
    uniforms.uSpread.value = c.intakeSpread;
    uniforms.uSize.value = c.intakeSize;
    uniforms.uSpin.value = c.intakeSpin;
    uniforms.uEase.value = Math.max(1, c.intakeEase);
    uniforms.uOpacity.value = c.intakeOpacity * g.opacity;
    uniforms.uGlow.value = c.intakeGlow * g.glow;
    uniforms.uRim.value = c.intakeRim;
    uniforms.uRimPower.value = c.intakeRimPower;
    uniforms.uShade.value = c.intakeShade;
    uniforms.uAmbient.value = c.intakeAmbient;
  };

  material.userData.sync();
  return material;
}
