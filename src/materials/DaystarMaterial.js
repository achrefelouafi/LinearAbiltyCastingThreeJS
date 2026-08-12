import { AdditiveBlending, Color, ShaderMaterial, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';

/**
 * DAYSTAR — the one thing Dawnbreak actually draws.
 *
 * Dawnbreak's trick is that it borrows the scene's key light and swings it, so
 * that every object on the stage throws a *real* shadow that sweeps. That means
 * the ability's own geometry budget is almost entirely spare, and the one thing
 * worth spending it on is the **source**: a disc up-sun from the cast, so the
 * player can see where the light is coming from and watch it climb. Without it
 * the sweep still happens and still reads as "something is wrong with the
 * lighting" rather than as "the sun is moving overhead", which is a different
 * sentence and the wrong one.
 *
 * ## Why it is a billboard built in view space
 *
 * The first version was a `Mesh` with a live `position` and `matrixAutoUpdate`
 * left on, oriented at the camera with `lookAt`. Two things went wrong. The
 * ability's group has `matrixAutoUpdate = false` — every effect in this project
 * passes its geometry in as uniforms rather than riding a model matrix — so the
 * mesh's own matrix was never recomposed from the position that was being
 * written, and the sun sat at the world origin, inside the floor, for a very
 * confusing ten minutes. And `lookAt` needs the camera, which an `Ability` does
 * not have and should not acquire.
 *
 * So the centre arrives as `uCentre` in **world metres** and the quad is built
 * around it in view space:
 *
 * ```
 *   vec4 centre = viewMatrix * vec4(uCentre, 1.0);
 *   centre.xy  += position.xy * span;          // always camera-facing
 * ```
 *
 * — no model matrix, no camera reference, exact billboarding for free, and the
 * pause probe reads the sun's live world position straight off the uniform.
 *
 * ## What it draws
 *
 * One additive quad, three terms, all of them procedural:
 *
 *  - **the body**, limb-darkened by `pow(1 - r², limb)` so the edge of the disc
 *    is cooler than its middle. A flat disc reads as a hole punched in the
 *    backdrop; the limb is what makes it a sphere;
 *  - **the aureole**, a wide power falloff that is the atmosphere the light is
 *    coming through, not a bloom — bloom is applied to it afterwards and would
 *    have nothing to work with if the disc had a hard edge and nothing else;
 *  - **the streak**, a horizontal anamorphic flare on a pair of exponentials.
 *    It is the one deliberately artificial term and it is what makes a small
 *    bright shape read as *the sun* rather than as a lamp.
 *
 * The face carries a slow granulation — one `fbm4` sampled in the disc's own
 * plane. It is nearly invisible at the size the disc is usually drawn, and that
 * is fine: it is there for the frames where the sun is close to the camera and
 * a perfectly smooth disc would look like a decal.
 *
 * ## Colour, and the horizon
 *
 * Three pickers, none derived from another (I5): `uColorCore` is the disc at
 * its height, `uColorLow` is the disc on the horizon, and `uColorHalo` is the
 * aureole and the streak. `uWarm` — 0 on the horizon, 1 overhead — mixes the
 * first two, and it is the **same** number Dawnbreak hands the key light, so
 * the disc you are looking at and the light falling on the floor redden
 * together. Driving those two from separate curves was the second bug: the sun
 * went orange while the stage stayed noon-white, and every shadow on the floor
 * looked pasted on.
 *
 * Every uniform below is re-resolved from `settings.dawnbreak` by the ability
 * on every frame including a zero-length one (I1). Nothing here is captured.
 */

const DAYSTAR_VERTEX = /* glsl */ `
  uniform vec3  uCentre;
  uniform float uSize;
  uniform float uSpan;

  varying vec2 vPlane;

  void main() {
    // The quad is built around the centre in view space, so it faces the camera
    // whatever the camera does and needs no model matrix of its own.
    vec4 centre = viewMatrix * vec4(uCentre, 1.0);

    // position.xy is the unit quad's -0.5..0.5. vPlane is measured in DISC
    // RADII, so r = 1.0 is exactly the limb wherever the size slider puts it.
    vPlane = position.xy * 2.0 * uSpan;
    centre.xy += position.xy * (2.0 * uSpan * uSize);

    gl_Position = projectionMatrix * centre;
  }
`;

const DAYSTAR_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uGlobalGlow;
  uniform float uShaderIntensity;

  uniform float uSeed;
  uniform float uFade;
  uniform float uWarm;

  uniform float uSoft;
  uniform float uLimb;
  uniform float uHalo;
  uniform float uHaloFalloff;
  uniform float uFlare;
  uniform float uFlareLength;
  uniform float uFlareWidth;
  uniform float uGranule;
  uniform float uGranuleScale;
  uniform float uGranuleSpeed;

  uniform float uGlow;
  uniform float uOpacity;
  uniform vec3  uColorCore;
  uniform vec3  uColorLow;
  uniform vec3  uColorHalo;

  varying vec2 vPlane;

  ${noiseGLSL}

  void main() {
    float r = length(vPlane);

    /* --- the body, limb-darkened --- */
    float body = 1.0 - smoothstep(1.0 - clamp(uSoft, 0.001, 0.999), 1.0, r);
    float limb = pow(clamp(1.0 - r * r, 0.0, 1.0), max(uLimb, 0.01));
    float cells = fbm4(vec3(vPlane * uGranuleScale, uTime * uGranuleSpeed + uSeed));
    body *= mix(1.0, 0.55 + 0.45 * (cells * 0.5 + 0.5), clamp(uGranule, 0.0, 1.0));

    /* --- the aureole --- */
    float reach = max(uHalo, 1.001);
    float halo = pow(clamp(1.0 - r / reach, 0.0, 1.0), max(uHaloFalloff, 0.05));

    /* --- the streak. Two exponentials, wide in x and tight in y. --- */
    float streak = exp(-abs(vPlane.x) / max(uFlareLength * reach, 1e-3)) *
                   exp(-abs(vPlane.y) / max(uFlareWidth, 1e-3));

    vec3 face = mix(uColorLow, uColorCore, clamp(uWarm, 0.0, 1.0));

    vec3 color = face * (body * (0.35 + 0.65 * limb));
    color += uColorHalo * halo * halo;
    color += uColorHalo * streak * uFlare;

    float alpha = clamp(body + halo * 0.55 + streak * uFlare * 0.5, 0.0, 1.0);
    alpha *= uFade * uOpacity;
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow * mix(0.7, 1.0, uShaderIntensity);
    gl_FragColor = vec4(clamp(color, 0.0, 64.0), alpha);
  }
`;

/**
 * One daystar. Uniforms are pushed by the ability every frame.
 *
 * Additive and depth-tested: the disc is a light source hanging in the void
 * beyond the stage, so anything genuinely in front of it should hide it, and
 * nothing it lands on should be darkened by it.
 */
export function createDaystarMaterial() {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    toneMapped: false,
    uniforms: sharedUniforms({
      uCentre: { value: new Vector3() },
      uSize: { value: 3 },
      uSpan: { value: 4 },
      uSeed: { value: 0 },
      uFade: { value: 0 },
      uWarm: { value: 0 },

      uSoft: { value: 0.12 },
      uLimb: { value: 0.35 },
      uHalo: { value: 3.4 },
      uHaloFalloff: { value: 2.6 },
      uFlare: { value: 0.55 },
      uFlareLength: { value: 0.85 },
      uFlareWidth: { value: 0.18 },
      uGranule: { value: 0.35 },
      uGranuleScale: { value: 1.6 },
      uGranuleSpeed: { value: 0.15 },

      uGlow: { value: 2.4 },
      uOpacity: { value: 1 },
      uColorCore: { value: new Color(1, 0.98, 0.9) },
      uColorLow: { value: new Color(1, 0.55, 0.22) },
      uColorHalo: { value: new Color(1, 0.78, 0.45) }
    }),
    vertexShader: DAYSTAR_VERTEX,
    fragmentShader: DAYSTAR_FRAGMENT
  });
}
