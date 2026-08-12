import {
  AdditiveBlending,
  Color,
  DoubleSide,
  NormalBlending,
  ShaderMaterial,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms, frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The two bespoke materials Prism Lance needs, and nothing else.
 *
 * Everything else in that ability is library work — the white lance is a
 * `vfx/Tube`, the chips are a `vfx/ShatterField` — but the two things that make
 * the slot *the prism slot* are not in the library and should not be:
 *
 *  1. **the solid** — a refracting triangular bipyramid with a real dispersion
 *     term, three refracted probes at three indices, one per channel;
 *  2. **the fan** — six (up to eight) coloured child beams in **one instanced
 *     draw**, each with its own hue and its own exit angle out of the prism.
 *
 * Both read `settings.prismlance` directly, the way `materials/LightningMaterial`
 * reads `settings.thunder`: the ability hands `userData.sync(state)` the dice
 * rolls and the timestamps, and the material resolves every metre, radian and
 * second itself, on every frame including a zero-length one.
 */

/** Hard ceiling on child beams. `children` clamps here, and so does the fan geometry. */
export const MAX_CHILDREN = 8;

/* ------------------------------------------------------------------ */
/* 1 · The solid                                                       */
/* ------------------------------------------------------------------ */

/**
 * The prism's vertex stage, which is unusually boring on purpose.
 *
 * This is the only thing in the ability that rides a model matrix: the solid is
 * a *body*, it has to tumble and it has to be scaled independently in radius
 * and in length, so placing it on the CPU each frame is both correct and
 * cheaper than re-deriving a basis per vertex. The one wrinkle is that a
 * non-uniform scale skews normals — `mat3(modelMatrix)` is `R·S`, and the
 * normal wants `R·S⁻¹` — so the ability hands over `uNormalFix = 1/s²` and the
 * shader multiplies twice. The first version skipped that and the bipyramid's
 * six faces caught the light as though it were a sphere, which is exactly the
 * one thing a faceted solid must not do.
 */
const PRISM_VERTEX = /* glsl */ `
  uniform vec3 uNormalFix;

  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying vec3 vLocal;

  void main() {
    vLocal = position;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * (normal * uNormalFix));
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/**
 * The refraction.
 *
 * A prism disperses because the index of refraction is a function of
 * wavelength: blue bends harder than red. There is no spectral renderer here
 * and there is not going to be one, so the cheap-and-correct-looking version is
 * three `refract()` calls at three indices and one channel taken from each —
 * `r` from the red ray, `g` from the green, `b` from the blue. Where the three
 * rays land on the same thing you get the room; where they diverge — grazing
 * angles, the edges of the faces — they fringe, and the fringe is the effect.
 *
 * The first version sampled a single refracted ray and multiplied the result by
 * a hue ramp taken from the surface UV. It looked like a sticker of a rainbow
 * on a lump of glass, because the colour was not moving with the *ray*: orbit
 * the prism and the fringes have to swing round with the geometry behind it,
 * and only three real probes do that.
 *
 * Total internal reflection makes `refract()` return the zero vector, which
 * would sample the probe at an undefined direction and read as a hard black
 * facet. Those rays fall back to the reflected direction, which is what
 * physically happens anyway.
 *
 * The environment probe degrades: `frame.uEnvMap` is null until `App` sets the
 * equirect, and a null sampler reads black. So `uEnvMix` blends the probe
 * against a two-colour procedural sky — the prism is never a black hole, and
 * the sky is two pickers rather than a value derived from the body tint.
 */
const PRISM_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform sampler2D uEnvMap;
  uniform float uEnvIntensity;
  uniform float uEnvMix;

  uniform float uIor;
  uniform float uDispersion;
  uniform float uFresnelPower;
  uniform float uFresnelScale;

  uniform float uFacet;
  uniform float uFacetScale;
  uniform float uGlow;
  uniform float uOpacity;
  uniform float uFade;
  uniform float uLoad;
  uniform float uLoadGlow;

  uniform float uCrack;
  uniform float uCrackScale;
  uniform float uCrackEdge;
  uniform float uCrackGlow;
  uniform float uSeed;

  uniform vec3 uColorBody;
  uniform vec3 uColorRim;
  uniform vec3 uColorFire;
  uniform vec3 uColorSkyUp;
  uniform vec3 uColorSkyDown;

  uniform float uGlobalGlow;

  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying vec3 vLocal;

  ${noiseGLSL}
  ${commonGLSL}

  /** The two-picker fallback room, for when there is no equirect bound. */
  vec3 sky(vec3 d) {
    return mix(uColorSkyDown, uColorSkyUp, clamp(d.y * 0.5 + 0.5, 0.0, 1.0));
  }

  /** What the prism sees down a ray. */
  vec3 probe(vec3 d) {
    vec3 lit = texture2D(uEnvMap, equirectUv(d)).rgb * uEnvIntensity;
    return mix(sky(d), lit, clamp(uEnvMix, 0.0, 1.0));
  }

  void main() {
    vec3 N = normalize(vNormalW);
    if (!gl_FrontFacing) N = -N;
    vec3 V = normalize(vWorld - cameraPosition);

    /* ---- the crack, which happens before anything is shaded ---- */
    // A fracture is a *hole*, so it is a discard and not a darkening. The field
    // is world-space fbm at a metre scale, so the cracks keep their size when
    // the solid is scaled and do not swim when it spins.
    float grain = fbm3(vWorld * max(uCrackScale, 0.01) + uSeed);
    vec2 broken = dissolveMask(grain, uCrack, max(uCrackEdge, 1e-3));
    if (uCrack > 0.001 && broken.x < 0.5) discard;

    /* ---- three rays, three indices ---- */
    float eta = 1.0 / max(uIor, 1.0001);
    vec3 mirror = reflect(V, N);
    vec3 rr = refract(V, N, eta * (1.0 + uDispersion));
    vec3 rg = refract(V, N, eta);
    vec3 rb = refract(V, N, eta * (1.0 - uDispersion));
    // Total internal reflection: refract() hands back the zero vector.
    if (dot(rr, rr) < 0.25) rr = mirror;
    if (dot(rg, rg) < 0.25) rg = mirror;
    if (dot(rb, rb) < 0.25) rb = mirror;

    vec3 through = vec3(probe(rr).r, probe(rg).g, probe(rb).b);
    vec3 reflected = probe(mirror);

    /* ---- the interior ---- */
    // Facets inside the body, in the solid's *own* space so they tumble with
    // it. Without this the prism is an empty shell: the refraction alone has no
    // internal structure and the thing reads as a soap bubble.
    float veins = fbm3(vLocal * max(uFacetScale, 0.01) + vec3(0.0, uTime * 0.15, uSeed));
    float fres = fresnelTerm(V, N, uFresnelPower, uFresnelScale);

    vec3 color = through * uColorBody;
    color += reflected * fres;
    color += uColorRim * fres * fres;
    color += uColorFire * veins * uFacet;
    // While the lance is actually in it, the solid blazes from the inside.
    color += uColorFire * uLoad * uLoadGlow;
    color += uColorFire * broken.y * uCrackGlow;
    color *= uGlow * uGlobalGlow;

    // Same Reinhard ceiling GlacierMaterial uses: every term above peaks at a
    // grazing angle and they stack, and a slider pinned against a white cutout
    // is a slider nobody can hear.
    color /= 1.0 + color * 0.16;

    float alpha = mix(uOpacity, 1.0, clamp(fres, 0.0, 1.0)) * uFade;
    alpha = max(alpha, broken.y * uFade);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The refracting solid.
 *
 * Normal blending, not additive: this is glass in a room, and glass that adds
 * has no body. `depthWrite` stays off so the back faces of the bipyramid show
 * through the front ones, which is what makes the six facets legible as a
 * volume rather than as a silhouette.
 */
export function createPrismSolidMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uEnvMap: frame.uEnvMap,
      uNormalFix: { value: new Vector3(1, 1, 1) },
      uEnvIntensity: { value: 1 },
      uEnvMix: { value: 0.6 },
      uIor: { value: 1.62 },
      uDispersion: { value: 0.06 },
      uFresnelPower: { value: 2.6 },
      uFresnelScale: { value: 1.1 },
      uFacet: { value: 0.6 },
      uFacetScale: { value: 5.5 },
      uGlow: { value: 1.4 },
      uOpacity: { value: 0.35 },
      uFade: { value: 0 },
      uLoad: { value: 0 },
      uLoadGlow: { value: 1.6 },
      uCrack: { value: 0 },
      uCrackScale: { value: 6.0 },
      uCrackEdge: { value: 0.12 },
      uCrackGlow: { value: 2.4 },
      uSeed: { value: 0 },
      uColorBody: { value: new Color(0.85, 0.9, 1) },
      uColorRim: { value: new Color(1, 1, 1) },
      uColorFire: { value: new Color(1, 0.85, 1) },
      uColorSkyUp: { value: new Color(0.35, 0.42, 0.6) },
      uColorSkyDown: { value: new Color(0.05, 0.05, 0.08) }
    }),
    vertexShader: PRISM_VERTEX,
    fragmentShader: PRISM_FRAGMENT
  });

  /**
   * @param {object} state { fade, load, crack, seed, normalFix }
   */
  material.userData.sync = (state) => {
    const c = settings.prismlance;
    const g = settings.global;
    const u = material.uniforms;

    u.uNormalFix.value.copy(state.normalFix);
    u.uFade.value = state.fade;
    u.uLoad.value = state.load;
    u.uCrack.value = state.crack;
    u.uSeed.value = state.seed;

    u.uEnvIntensity.value = c.prismEnvIntensity;
    u.uEnvMix.value = c.prismEnvMix;
    u.uIor.value = c.prismIor;
    u.uDispersion.value = c.prismDispersion;
    u.uFresnelPower.value = c.prismFresnelPower;
    u.uFresnelScale.value = c.prismFresnelScale * g.fresnel;
    u.uFacet.value = c.prismFacet * g.noiseStrength;
    u.uFacetScale.value = c.prismFacetScale * g.noiseFrequency;
    u.uGlow.value = c.prismGlow * g.glow;
    u.uOpacity.value = c.prismOpacity * g.opacity;
    u.uLoadGlow.value = c.prismLoadGlow;
    u.uCrackScale.value = c.prismCrackScale * g.noiseFrequency;
    u.uCrackEdge.value = c.prismCrackEdge;
    u.uCrackGlow.value = c.prismCrackGlow;

    u.uColorBody.value.copy(getColor(c.colorPrismBody));
    u.uColorRim.value.copy(getColor(c.colorPrismRim));
    u.uColorFire.value.copy(getColor(c.colorPrismFire));
    u.uColorSkyUp.value.copy(getColor(c.colorPrismSkyUp));
    u.uColorSkyDown.value.copy(getColor(c.colorPrismSkyDown));
  };

  return material;
}

/* ------------------------------------------------------------------ */
/* 2 · The fan                                                         */
/* ------------------------------------------------------------------ */

/**
 * Six child beams, one draw call.
 *
 * The geometry is `createBoltRibbonGeometry` — the same parameter-space ladder
 * the Storm Lance's filaments are drawn on — instanced once per child. Nothing
 * about a child's path exists on the CPU: the vertex shader is handed the prism
 * point, the impact point and eight colours, and derives the rest from the
 * instance index.
 *
 * **The exit angle and the hue are the same number.** A child's index picks its
 * bearing around the axis, *and* its colour, *and* how hard it bends —
 * `uDispersion` ramps the lateral throw from the first child to the last, so
 * the fan is ordered the way a real spectrum is ordered rather than being six
 * beams in six arbitrary directions. Drag `fanDispersion` to nothing and the
 * six collapse into one white line, which is the correct behaviour for a prism
 * with no dispersion in it and is a good way to check the rest of the shader.
 *
 * **They converge because the bow is zero at both ends.** The lateral offset is
 * `sin(π·tᵇ)` — zero at the prism, zero at the target, and with `b = 1` its
 * derivative at the prism is `π`, so the beams genuinely *leave at an angle*
 * rather than easing away from the axis. That one function is the whole trick:
 * there is no convergence logic, no correction term, and no way for a child to
 * miss the point the parent beam was aimed at.
 *
 * One pass, not two. A halo pass and a core pass over the same ribbon are both
 * additive, and additive blending is a sum — so summing the two profiles inside
 * one fragment is the identical image for half the draw calls. The ribbon is
 * therefore as wide as the *halo* and the core is a tight power of the
 * cross-ribbon coordinate inside it.
 */
const FAN_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586
  #define MAX_CHILDREN ${MAX_CHILDREN}

  uniform float uTime;
  uniform vec3  uPrism;
  uniform vec3  uTarget;
  uniform vec3  uSide;
  uniform float uSeed;
  uniform float uCount;
  uniform float uFade;

  uniform float uSpread;
  uniform float uDispersion;
  uniform float uBowBias;
  uniform float uBowCurve;
  uniform float uSpin;
  uniform float uWave;
  uniform float uWaveScale;
  uniform float uWaveSpeed;

  uniform float uWidth;
  uniform float uWidthTip;
  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform float uWhite;

  uniform vec3  uChildColor[MAX_CHILDREN];
  uniform vec3  uColorCollapse;

  attribute float aStrand;

  varying float vT;
  varying float vSide;
  varying float vFlash;
  varying float vViewZ;
  varying vec3  vTint;

  ${noiseGLSL}

  /**
   * One child's axis point at t, 0 at the prism and 1 at the target.
   *
   * The 'order' argument is the child's place in the spectrum, 0..1, and it is the only
   * thing that separates one child from another: it picks the bearing, it
   * scales the throw, and up in main() it picks the colour.
   */
  vec3 childPoint(float t, float order, float bearing, vec3 n1, vec3 n2) {
    vec3 axis = mix(uPrism, uTarget, t);

    float bow = pow(max(sin(PI * pow(clamp(t, 0.0, 1.0), max(uBowBias, 0.05))), 0.0), max(uBowCurve, 0.05));
    float amp = uSpread * mix(1.0, uDispersion, order);
    // A slow travelling ripple down the beam. Small: a child beam is coherent
    // light, and anything that kinks it reads as the Storm Lance by mistake.
    amp *= 1.0 + uWave * sin(TAU * (t * uWaveScale - uTime * uWaveSpeed) + order * 4.0);

    float angle = bearing + uTime * uSpin * TAU;
    vec2 offset = vec2(cos(angle), sin(angle)) * amp * bow;
    return axis + n1 * offset.x + n2 * offset.y;
  }

  void main() {
    float t = position.x;
    vT = t;
    vSide = position.y;

    /* ---- the frame the fan opens in ---- */
    vec3 delta = uTarget - uPrism;
    float span = max(length(delta), 0.01);
    vec3 dir = delta / span;
    vec3 n1 = uSide - dir * dot(uSide, dir);
    n1 = length(n1) > 1e-4 ? normalize(n1) : normalize(cross(dir, vec3(0.0, 1.0, 0.0)));
    vec3 n2 = normalize(cross(dir, n1));

    /* ---- which child is this ---- */
    float count = max(uCount, 1.0);
    float order = count > 1.0 ? aStrand / (count - 1.0) : 0.0;
    float bearing = (aStrand / count) * TAU + uSeed;

    vec3 tint = uChildColor[0];
    // Indexed by the loop counter and compared against the instance id: a
    // uniform array indexed by a varying does not compile on ANGLE, and this is
    // the same dance FilamentPaths does for its roles.
    for (int i = 0; i < MAX_CHILDREN; i++) {
      if (float(i) == aStrand) tint = uChildColor[i];
    }
    vTint = mix(tint, uColorCollapse, clamp(uWhite, 0.0, 1.0));

    vec3 here = childPoint(t, order, bearing, n1, n2);

    /* ---- camera-facing ribbon ---- */
    float step_ = 0.02;
    float ahead = t + step_;
    float flip = 1.0;
    if (ahead > 1.0) { ahead = t - step_; flip = -1.0; }
    vec3 next = childPoint(ahead, order, bearing, n1, n2);
    vec3 tangent = (next - here) * flip;
    tangent = length(tangent) > 1e-5 ? normalize(tangent) : dir;

    vec3 toCamera = normalize(cameraPosition - here);
    vec3 binormal = cross(tangent, toCamera);
    float bl = length(binormal);
    binormal = bl > 1e-4 ? binormal / bl : n1;

    /* ---- width ---- */
    float flash = mix(1.0, hash11(floor(uTime * uFlickerSpeed) + aStrand * 3.7 + uSeed), uFlicker);
    vFlash = flash;

    float halfWidth = uWidth * mix(1.0, uWidthTip, t) * flash * uFade;

    vec4 mv = viewMatrix * vec4(here + binormal * vSide * halfWidth, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const FAN_FRAGMENT = /* glsl */ `
  uniform float uProgress;
  uniform float uTipGlow;
  uniform float uTipLength;
  uniform float uCoreSharp;
  uniform float uCoreWidth;
  uniform float uHaloFalloff;
  uniform float uHaloOpacity;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFade;
  uniform float uSoftFade;
  uniform vec3  uColorCore;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying float vT;
  varying float vSide;
  varying float vFlash;
  varying float vViewZ;
  varying vec3  vTint;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    // Ahead of the split front there is no child beam yet. Clipped, never
    // scaled: the *shape* must not change as the fan reaches the target.
    float tip = max(uTipLength, 1e-3);
    float drawn = smoothstep(uProgress, uProgress - tip, vT);
    if (drawn <= 0.002) discard;

    float v = clamp(abs(vSide), 0.0, 1.0);

    // Two profiles summed in one fragment — see the header. The core lives
    // inside the first uCoreWidth of the ribbon; the halo spans all of it.
    float core = pow(clamp(1.0 - v / max(uCoreWidth, 1e-3), 0.0, 1.0), max(uCoreSharp, 0.05));
    float halo = pow(1.0 - v, max(uHaloFalloff, 0.05)) * uHaloOpacity;

    vec3 color = vTint * (core * 0.35 + halo);
    color += uColorCore * core * core;
    color += uColorCore * smoothstep(uProgress - tip * 2.0, uProgress, vT) * uTipGlow;

    float alpha = (core + halo) * drawn * vFlash * uFade * uOpacity;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The fan. One instanced draw, `children` instances.
 *
 * @returns {THREE.ShaderMaterial} with `userData.sync(state)` on it
 */
export function createPrismFanMaterial() {
  const childColors = [];
  for (let i = 0; i < MAX_CHILDREN; i++) childColors.push(new Color(1, 1, 1));

  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uPrism: { value: new Vector3() },
      uTarget: { value: new Vector3(0, 0, 1) },
      uSide: { value: new Vector3(1, 0, 0) },
      uSeed: { value: 0 },
      uCount: { value: 6 },
      uFade: { value: 1 },
      uProgress: { value: 0 },

      uSpread: { value: 0.9 },
      uDispersion: { value: 2.2 },
      uBowBias: { value: 1 },
      uBowCurve: { value: 1 },
      uSpin: { value: 0.12 },
      uWave: { value: 0.12 },
      uWaveScale: { value: 2.4 },
      uWaveSpeed: { value: 1.1 },

      uWidth: { value: 0.16 },
      uWidthTip: { value: 0.6 },
      uFlicker: { value: 0.12 },
      uFlickerSpeed: { value: 24 },
      uWhite: { value: 0 },

      uCoreSharp: { value: 2.6 },
      uCoreWidth: { value: 0.34 },
      uHaloFalloff: { value: 2.6 },
      uHaloOpacity: { value: 0.5 },
      uTipGlow: { value: 1.4 },
      uTipLength: { value: 0.07 },
      uOpacity: { value: 1 },
      uGlow: { value: 2.1 },
      uSoftFade: { value: 0.5 },

      uChildColor: { value: childColors },
      uColorCore: { value: new Color(1, 1, 1) },
      uColorCollapse: { value: new Color(1, 1, 1) }
    }),
    vertexShader: FAN_VERTEX,
    fragmentShader: FAN_FRAGMENT
  });

  /**
   * @param {object} state { prism, target, side, progress, fade, seed, count, white }
   */
  material.userData.sync = (state) => {
    const c = settings.prismlance;
    const g = settings.global;
    const u = material.uniforms;

    u.uPrism.value.copy(state.prism);
    u.uTarget.value.copy(state.target);
    u.uSide.value.copy(state.side);
    u.uSeed.value = state.seed;
    u.uCount.value = state.count;
    u.uFade.value = state.fade;
    u.uProgress.value = state.progress;
    u.uWhite.value = state.white;

    u.uSpread.value = c.fanSpread;
    u.uDispersion.value = c.fanDispersion;
    u.uBowBias.value = c.fanBow;
    u.uBowCurve.value = c.fanBowCurve;
    u.uSpin.value = c.fanSpin * g.animationSpeed;
    u.uWave.value = c.fanWave * g.noiseStrength;
    u.uWaveScale.value = c.fanWaveScale * g.noiseFrequency;
    u.uWaveSpeed.value = c.fanWaveSpeed * g.noiseSpeed;

    u.uWidth.value = c.fanWidth;
    u.uWidthTip.value = c.fanWidthTip;
    u.uFlicker.value = c.fanFlicker;
    u.uFlickerSpeed.value = c.fanFlickerSpeed;

    u.uCoreSharp.value = c.fanCoreSharp;
    u.uCoreWidth.value = c.fanCoreWidth;
    u.uHaloFalloff.value = c.fanHaloFalloff;
    u.uHaloOpacity.value = c.fanHaloOpacity;
    u.uTipGlow.value = c.fanTipGlow;
    u.uTipLength.value = c.fanTipLength;
    u.uOpacity.value = c.fanOpacity * g.opacity;
    u.uGlow.value = c.fanGlow * g.glow;
    u.uSoftFade.value = c.fanSoftFade;

    // Eight pickers, none derived from another (I5). The block spells out the
    // whole spectrum rather than generating one from a hue sweep, because a
    // generated spectrum is one control and this is meant to be eight.
    const boxes = u.uChildColor.value;
    boxes[0].copy(getColor(c.colorChild1));
    boxes[1].copy(getColor(c.colorChild2));
    boxes[2].copy(getColor(c.colorChild3));
    boxes[3].copy(getColor(c.colorChild4));
    boxes[4].copy(getColor(c.colorChild5));
    boxes[5].copy(getColor(c.colorChild6));
    boxes[6].copy(getColor(c.colorChild7));
    boxes[7].copy(getColor(c.colorChild8));
    u.uColorCore.value.copy(getColor(c.colorFanCore));
    u.uColorCollapse.value.copy(getColor(c.colorCollapse));
  };

  return material;
}
