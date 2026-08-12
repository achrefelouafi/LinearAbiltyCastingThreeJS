import { Color, DoubleSide, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { getColor } from '../utils/color.js';

/* ====================================================================== */
/* The blob                                                               */
/* ====================================================================== */
/**
 * A lump of the pool, in the air.
 *
 * `vfx/Projectile.js` places the body and hands the material three per-instance
 * attributes: `aSeed` (a unitless dice roll), `aFlight` (τ, 0 at the muzzle and
 * 1 at the landing point) and `aFlash` (the birth pop, decaying in seconds).
 * Everything this shader does is a function of those three plus live uniforms —
 * there is no per-blob state on the CPU and nothing here is a texture.
 *
 * The read it has to deliver is **the same material as the pool**, so that a
 * blob leaving the fount and a blob landing back in it are obviously the same
 * stuff. The pool's skin is the zero crossing of a signed fbm evaluated in the
 * flow frame; a blob has no flow, so its skin is the zero crossing of the same
 * kind of field evaluated in the blob's own local space and *chilled with τ*:
 * coverage starts near zero at the muzzle and closes over the flight, so a blob
 * genuinely darkens on the way up and cracks open again where it stretches.
 *
 * The first version faded a hot colour to a cold one over τ. It reads as a
 * light being turned down, not as rock forming — the giveaway is that the
 * silhouette never changes. Cracking a *coverage* term instead gives the blob
 * moving black patches with glowing seams between them, which is the whole
 * difference.
 */
const BLOB_VERTEX = /* glsl */ `
  attribute float aSeed;
  attribute float aFlight;
  attribute float aFlash;

  varying float vSeed;
  varying float vFlight;
  varying float vFlash;
  varying vec3  vLocal;
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;

  void main() {
    vSeed = aSeed;
    vFlight = aFlight;
    vFlash = aFlash;
    vLocal = position;

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

const BLOB_FRAGMENT = /* glsl */ `
  uniform vec3  uColorHot;      // the melt underneath the skin
  uniform vec3  uColorMelt;     // the melt at glancing angles
  uniform vec3  uColorCrust;    // the chilled skin
  uniform vec3  uColorSeam;     // the crack between two plates of it

  uniform float uCrust;         // 0..1 skin coverage once fully chilled
  uniform float uCrustGrow;     // exponent on tau — >1 chills late
  uniform float uCrackScale;    // cycles per unit of blob radius
  uniform float uCrackWidth;    // 0..1 of the field — the seam's width
  uniform float uSeamGlow;
  uniform float uRim;           // how hot the silhouette's edge runs
  uniform float uRimPower;
  uniform float uShade;         // key-light term on the crust, 0..1
  uniform float uAmbient;
  uniform float uFlashGain;     // extra heat on a blob that has just left
  uniform float uGlow;
  uniform float uOpacity;
  uniform float uSoftFade;      // metres of depth feather against geometry

  uniform vec3      uLightDir;
  uniform vec2      uResolution;
  uniform sampler2D uSceneDepth;
  uniform float     uCameraNear;
  uniform float     uCameraFar;
  uniform float     uGlobalGlow;

  varying float vSeed;
  varying float vFlight;
  varying float vFlash;
  varying vec3  vLocal;
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDir);
    float facing = clamp(dot(N, V), 0.0, 1.0);

    /* --- the skin ---------------------------------------------------- */
    // Signed field, so the seam is its zero crossing rather than a threshold on
    // an absolute value: continuous, branching, and one number wide anywhere on
    // the blob. A threshold on abs(noise) gives crazing, which is pottery.
    float field = snoise(vLocal * max(uCrackScale, 0.01) + vSeed * 37.0);
    float seam = 1.0 - smoothstep(0.0, max(uCrackWidth, 1e-3), abs(field));

    // Coverage closes over the flight. The blob leaves the fount as raw melt
    // and is a cracked black lump by the time it comes down.
    float chill = clamp(uCrust * pow(clamp(vFlight, 0.0, 1.0), max(uCrustGrow, 0.01)), 0.0, 1.0);
    float plate = chill * (1.0 - seam);

    /* --- the melt ----------------------------------------------------- */
    float rim = pow(1.0 - facing, max(uRimPower, 0.1));
    vec3 melt = mix(uColorHot, uColorMelt, rim);
    melt = mix(melt, uColorSeam, seam * uSeamGlow * chill);

    // The crust is the only part that takes the key light. Lighting the melt
    // as well flattens the blob into a lit sphere and the heat stops reading.
    float ndl = clamp(dot(N, normalize(uLightDir)), 0.0, 1.0);
    vec3 crust = uColorCrust * (uAmbient + uShade * ndl);

    vec3 colour = mix(melt, crust, plate);
    colour += uColorMelt * (rim * uRim * (1.0 - plate));
    colour += uColorHot * (vFlash * uFlashGain);
    colour *= uGlow * uGlobalGlow;

    float alpha = uOpacity;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(colour, clamp(alpha, 0.0, 1.0));
  }
`;

/**
 * Build the blob material.
 *
 * Two-sided, because the asteroid factory cuts facets off the rock and a
 * grazing view down one of those cuts otherwise shows a hole straight through
 * a lump of lava.
 *
 * @returns {ShaderMaterial}
 */
export function createMagmaBlobMaterial() {
  return new ShaderMaterial({
    name: 'MagmaBlob',
    vertexShader: BLOB_VERTEX,
    fragmentShader: BLOB_FRAGMENT,
    transparent: true,
    depthWrite: true,
    depthTest: true,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uColorHot: { value: new Color('#ffe08a') },
      uColorMelt: { value: new Color('#ff5a12') },
      uColorCrust: { value: new Color('#120806') },
      uColorSeam: { value: new Color('#ff8a2a') },

      uCrust: { value: 0.85 },
      uCrustGrow: { value: 1.4 },
      uCrackScale: { value: 2.6 },
      uCrackWidth: { value: 0.22 },
      uSeamGlow: { value: 1.2 },
      uRim: { value: 0.8 },
      uRimPower: { value: 2.0 },
      uShade: { value: 0.55 },
      uAmbient: { value: 0.22 },
      uFlashGain: { value: 2.4 },
      uGlow: { value: 1.6 },
      uOpacity: { value: 1 },
      uSoftFade: { value: 0.2 }
    })
  });
}

/** The four blob pickers, none derived from another. Memoised. */
export function setBlobColors(material, hot, melt, crust, seam) {
  const u = material.uniforms;
  u.uColorHot.value.copy(getColor(hot));
  u.uColorMelt.value.copy(getColor(melt));
  u.uColorCrust.value.copy(getColor(crust));
  u.uColorSeam.value.copy(getColor(seam));
  return material;
}
