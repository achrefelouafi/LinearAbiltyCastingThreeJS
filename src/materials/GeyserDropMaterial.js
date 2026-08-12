import { Color, DoubleSide, ShaderMaterial } from 'three';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { getColor } from '../utils/color.js';

/* ====================================================================== */
/* One drop of the column, on its way back down                           */
/* ====================================================================== */
/**
 * A blob of the geyser's own water, in the air.
 *
 * `vfx/Projectile.js` places the body and hands the material three per-instance
 * attributes: `aSeed` (a unitless dice roll), `aFlight` (τ, 0 where the drop
 * tore off the column and 1 where it lands) and `aFlash` (the birth pop,
 * decaying in seconds). Everything here is a function of those three and live
 * uniforms — no per-drop state on the CPU, and nothing is a texture.
 *
 * **The read is a real refraction, not a fresnel ramp.** A drop of water is a
 * lens. Light entering the front is bent toward the axis and concentrates into
 * a bright point on the *far* side — which is why a dewdrop on a leaf has a hot
 * spot that stays put when you move and slides when the sun does. So the
 * highlight here is `refract(-V, N, 1/ior)` dotted against the key light,
 * raised to `uSpotPower`. It costs one builtin, it is the only term in this
 * material that could not be faked with a power of `1 − N·V`, and it is the
 * whole reason a hundred and twenty of these read as *water* rather than as a
 * hundred and twenty pale spheres.
 *
 * A first version used a Blinn-Phong lobe for the same job. It put the
 * highlight on the near side, every drop lit identically, and the field looked
 * like polystyrene beads. Moving the highlight to the far side fixed it, and it
 * is one line.
 *
 * **The second read is τ.** Water that has just torn off a plume losing
 * pressure is white with entrained air; by the time it has fallen five metres
 * it has shed most of that and is clear. So `uFroth` fades over
 * `pow(tau, uFrothFade)` and the drop genuinely *clarifies* as it falls. That
 * continuity is the point of the ability — this is the water that went up, so
 * it must not look like a different substance coming down.
 */
const DROP_VERTEX = /* glsl */ `
  attribute float aSeed;
  attribute float aFlight;
  attribute float aFlash;

  varying float vSeed;
  varying float vFlight;
  varying float vFlash;
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;

  void main() {
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

const DROP_FRAGMENT = /* glsl */ `
  uniform vec3  uColorClear;    // the body once the air has come out of it
  uniform vec3  uColorFroth;    // the same water, white with entrained air
  uniform vec3  uColorSpot;     // the refracted hot spot
  uniform vec3  uColorRim;      // the silhouette

  uniform float uIor;           // refractive index. Water is 1.333.
  uniform float uSpot;          // how bright the refracted point is
  uniform float uSpotPower;     // how tight it is
  uniform float uRim;
  uniform float uRimPower;
  uniform float uFroth;         // 0..1 aeration at tau = 0
  uniform float uFrothFade;     // exponent on tau — >1 clears late
  uniform float uAmbient;
  uniform float uShade;         // key-light term on the body
  uniform float uFlashGain;     // extra light on a drop that has just torn off
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
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;

  ${commonGLSL}

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDir);
    vec3 L = normalize(uLightDir);
    float facing = clamp(dot(N, V), 0.0, 1.0);

    /* --- the lens ----------------------------------------------------- */
    // The view ray, bent on the way in. Where it comes out pointing at the key
    // light is where the drop concentrates it: the far side, not the near one.
    vec3 bent = refract(-V, N, 1.0 / max(uIor, 1.001));
    // Total internal reflection returns a zero vector; guard rather than
    // normalising a zero and handing NaN to the pow below.
    float spot = 0.0;
    if (dot(bent, bent) > 1e-6) {
      spot = pow(clamp(dot(normalize(bent), L), 0.0, 1.0), max(uSpotPower, 1.0)) * uSpot;
    }

    float rim = pow(1.0 - facing, max(uRimPower, 0.1));

    /* --- the body ------------------------------------------------------ */
    // Air comes out of it as it falls. See the module header.
    float froth = uFroth * (1.0 - pow(clamp(vFlight, 0.0, 1.0), max(uFrothFade, 0.05)));
    float ndl = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);

    vec3 body = mix(uColorClear, uColorFroth, clamp(froth, 0.0, 1.0));
    body *= uAmbient + uShade * ndl;

    vec3 colour = body;
    colour += uColorSpot * spot;
    colour += uColorRim * rim * uRim;
    colour += uColorFroth * (vFlash * uFlashGain);
    colour *= uGlow * uGlobalGlow;

    // Clear water hides almost nothing face-on; the froth and the silhouette
    // are what you actually see, which is why a drop reads as a drop and a
    // sphere of flat alpha reads as a bead.
    float alpha = uOpacity * clamp(0.2 + 0.55 * froth + 0.8 * rim + spot * 0.4, 0.0, 1.0);
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, max(uSoftFade, 1e-3));
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(colour, clamp(alpha, 0.0, 1.0));
  }
`;

/**
 * Build the droplet material.
 *
 * Two-sided: the drop is transparent, so the far wall is part of the read and
 * culling it takes the volume out of the silhouette.
 *
 * @returns {ShaderMaterial}
 */
export function createGeyserDropMaterial() {
  return new ShaderMaterial({
    name: 'GeyserDrop',
    vertexShader: DROP_VERTEX,
    fragmentShader: DROP_FRAGMENT,
    transparent: true,
    // Off: a hundred transparent drops sorting against one another by depth
    // punches holes in the ones behind. They are small and additive-ish enough
    // that letting them all composite is the better trade.
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uColorClear: { value: new Color('#bfeef6') },
      uColorFroth: { value: new Color('#ffffff') },
      uColorSpot: { value: new Color('#eafcff') },
      uColorRim: { value: new Color('#67d4e6') },

      uIor: { value: 1.333 },
      uSpot: { value: 2.2 },
      uSpotPower: { value: 14 },
      uRim: { value: 0.9 },
      uRimPower: { value: 2.2 },
      uFroth: { value: 0.85 },
      uFrothFade: { value: 1.3 },
      uAmbient: { value: 0.35 },
      uShade: { value: 0.7 },
      uFlashGain: { value: 1.8 },
      uGlow: { value: 1.2 },
      uOpacity: { value: 1 },
      uSoftFade: { value: 0.18 }
    })
  });
}

/** The four droplet pickers, none derived from another. */
export function setDropColors(material, clear, froth, spot, rim) {
  const u = material.uniforms;
  u.uColorClear.value.copy(getColor(clear));
  u.uColorFroth.value.copy(getColor(froth));
  u.uColorSpot.value.copy(getColor(spot));
  u.uColorRim.value.copy(getColor(rim));
  return material;
}
