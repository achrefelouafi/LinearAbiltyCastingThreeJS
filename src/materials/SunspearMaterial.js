import { ShaderMaterial, Color, AdditiveBlending, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The white-fire javelin.
 *
 * Deliberately the least interesting material in the ability. Sunspear's read
 * is the *wake* — a hole punched in the refraction buffer — and the sun disc it
 * opens; a spear with its own crust, seams and embers would compete with both
 * and win, because it is the thing in the middle of the screen. So this is one
 * unlit additive pass over a faceted spindle, and everything it does is in
 * service of "very bright, and pointed that way".
 *
 * Three terms, all of them in the geometry's **own** frame so they hold still
 * while the spear rolls:
 *
 *   - **the core.** Local radius against `uCore`: the middle of the shaft runs
 *     pure white and the fire falls off across it on `uFalloff`. Doing this in
 *     screen space instead — the obvious "bright in the middle of the
 *     silhouette" — makes the hot line slide about as the camera orbits, and
 *     the spear stops looking solid.
 *   - **the head.** Everything past `uHead` along the shaft gets hotter, so the
 *     point is the brightest thing on it. A javelin with an even temperature is
 *     a fluorescent tube.
 *   - **the crawl.** One noise octave advected along the shaft, which is all a
 *     1.8 m object needs; anything finer disappears at the distance you
 *     actually watch this from.
 *
 * The fresnel is added rather than mixed. On an additive pass a mixed rim
 * darkens the middle of the silhouette to pay for the edge, which on a white
 * object reads as a hole.
 */
const SPEAR_VERTEX = /* glsl */ `
  attribute float aSeed;
  attribute float aFlight;
  attribute float aFlash;

  varying vec3  vLocal;
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;
  varying float vSeed;
  varying float vFlight;
  varying float vFlash;

  void main() {
    vLocal = position;
    vSeed = aSeed;
    vFlight = aFlight;
    vFlash = aFlash;

    mat4 im = mat4(1.0);
    #ifdef USE_INSTANCING
      im = instanceMatrix;
    #endif

    vec4 world = modelMatrix * im * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * mat3(im) * normal);
    vViewDir = cameraPosition - world.xyz;

    vec4 mv = viewMatrix * world;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const SPEAR_FRAGMENT = /* glsl */ `
  uniform vec3  uColorCore;
  uniform vec3  uColorFire;
  uniform vec3  uColorEdge;
  uniform float uCore;
  uniform float uFalloff;
  uniform float uHead;
  uniform float uHeadGain;
  uniform float uFresnel;
  uniform float uFresnelPower;
  uniform float uNoise;
  uniform float uNoiseScale;
  uniform float uNoiseSpeed;
  uniform float uGlow;
  uniform float uOpacity;
  uniform float uSoft;
  uniform float uFade;

  uniform float     uTime;
  uniform vec2      uResolution;
  uniform sampler2D uSceneDepth;
  uniform float     uCameraNear;
  uniform float     uCameraFar;
  uniform float     uGlobalGlow;

  varying vec3  vLocal;
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;
  varying float vSeed;
  varying float vFlight;
  varying float vFlash;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDir);

    // Local frame. The spindle spans y in -1..1 with the point at +1 and its
    // half-width at 0.5, so "across" is 0 on the axis and 1 at the surface.
    float along  = clamp(vLocal.y * 0.5 + 0.5, 0.0, 1.0);
    float across = clamp(length(vLocal.xz) * 2.0, 0.0, 1.0);

    // The shaft, hottest on the axis.
    float body = pow(1.0 - across, max(uFalloff, 0.05));
    float core = smoothstep(uCore, uCore * 0.35, across);

    // The head. Everything past uHead runs hotter, on a curve rather than a
    // step, or the join reads as a collar.
    float head = smoothstep(uHead, 1.0, along);

    // One octave, advected down the shaft. The seed decorrelates two casts.
    float crawl = snoise(vec3(vLocal.xz * uNoiseScale, along * uNoiseScale - uTime * uNoiseSpeed) + vSeed * 13.0);
    float fire = body * (1.0 + uNoise * crawl * 0.5);

    float fres = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), max(uFresnelPower, 0.05));

    vec3 color = uColorFire * fire;
    color += uColorCore * (core + head * uHeadGain * 0.35 + vFlash);
    color += uColorEdge * fres * uFresnel;

    // The soft ceiling every emissive surface in this project carries: these
    // terms are independent and stack, and a fresnel edge crossing the white
    // core sums past 10 and the bloom pass eats the silhouette.
    color *= uGlow * uGlobalGlow;
    color /= 1.0 + color * 0.14;

    float alpha = clamp(fire + core * 0.8 + fres * 0.6, 0.0, 1.0) * uOpacity * uFade;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoft);
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * Build the javelin's material. One per ability instance; the ability owns it
 * and disposes it.
 */
export function createSunspearMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    // The spindle is thin enough that you see its far side constantly.
    side: DoubleSide,
    blending: AdditiveBlending,
    toneMapped: false,
    uniforms: sharedUniforms({
      uColorCore: { value: new Color('#ffffff') },
      uColorFire: { value: new Color('#ffe07a') },
      uColorEdge: { value: new Color('#ff9a1f') },
      uCore: { value: 0.34 },
      uFalloff: { value: 2.2 },
      uHead: { value: 0.62 },
      uHeadGain: { value: 2.4 },
      uFresnel: { value: 1.5 },
      uFresnelPower: { value: 2.0 },
      uNoise: { value: 0.55 },
      uNoiseScale: { value: 4.5 },
      uNoiseSpeed: { value: 2.6 },
      uGlow: { value: 3.2 },
      uOpacity: { value: 1 },
      uSoft: { value: 0.4 },
      uFade: { value: 1 }
    }),
    vertexShader: SPEAR_VERTEX,
    fragmentShader: SPEAR_FRAGMENT
  });

  /**
   * Pull every shading control from the live settings.
   * @param {number} fade 1 while the spear is in the air, 0 once it has landed
   */
  material.userData.sync = (fade = 1) => {
    const c = settings.sunspear;
    const g = settings.global;
    const u = material.uniforms;

    u.uColorCore.value.copy(getColor(c.colorSpearCore));
    u.uColorFire.value.copy(getColor(c.colorSpearFire));
    u.uColorEdge.value.copy(getColor(c.colorSpearEdge));

    u.uCore.value = Math.max(0.01, c.spearCore);
    u.uFalloff.value = c.spearFalloff;
    u.uHead.value = c.spearHead;
    u.uHeadGain.value = c.spearHeadGain;
    u.uFresnel.value = c.spearFresnel * g.fresnel;
    u.uFresnelPower.value = c.spearFresnelPower;
    u.uNoise.value = c.spearNoise * g.noiseStrength;
    u.uNoiseScale.value = c.spearNoiseScale * g.noiseFrequency;
    u.uNoiseSpeed.value = c.spearNoiseSpeed * g.noiseSpeed;
    u.uGlow.value = c.spearGlow * g.glow;
    u.uOpacity.value = c.spearOpacity * g.opacity;
    u.uSoft.value = c.spearSoftFade;
    u.uFade.value = fade;
  };

  return material;
}
