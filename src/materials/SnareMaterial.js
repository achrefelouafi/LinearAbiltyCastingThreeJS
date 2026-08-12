import { ShaderMaterial, AdditiveBlending, Color, DoubleSide, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The two passes the cage is drawn in. Same geometry, same paths, same
 * uniforms — only the ribbon width and the cross-ribbon profile differ, exactly
 * as with the bolt.
 */
export const SnarePass = Object.freeze({
  CORE: 0, // the hot filaments themselves
  GLOW: 1 // the wide halo they sit inside
});

/**
 * The four things a filament can be.
 *
 * A role is decided from the instance index against four live counts, which is
 * what lets one instanced strip draw the whole trap: the whip that plants it,
 * the pillar in the middle, the tendrils crawling out to the boundary and the
 * arcs running around it are four *parametric paths*, not four meshes. Two draw
 * calls cover all of them however many filaments are in the air, and setting a
 * count to zero retires that role outright — which is how the leash disappears
 * the instant the trap snaps open.
 */
export const SnareRole = Object.freeze({
  LEASH: 0,
  COLUMN: 1,
  TENDRIL: 2,
  RIM: 3
});

/**
 * The whole cage lives in this vertex shader.
 *
 * A vertex arrives as `(t, side)` — how far along its filament it is and which
 * edge of the ribbon it is on — and leaves as a world position. Nothing about
 * any path exists on the CPU, so there is no record to go stale: dragging
 * `zoneRadius` re-scales a trap that is already standing, dragging `height`
 * re-grows the pillar, and both do it with the clock stopped.
 *
 * Three things stack, as they do on the bolt:
 *
 *   1. **the path** — the role's own centreline. A sagging line for the leash,
 *      a twisting climb for the column, a meander running outward for a
 *      tendril, an arc travelling around the circle for the rim. This is the
 *      only part that knows the trap's geometry.
 *   2. **the frame** — a tangent by finite difference on that path, and two
 *      normals off it. Every offset below lives in this frame, which is what
 *      lets one kink function serve a vertical pillar and a filament crawling
 *      flat across the floor.
 *   3. **the kinks** — octaves of *linearly* interpolated value noise. Linear
 *      on purpose: smoothstep would round the corners off, and the corners are
 *      the entire reason it reads as lightning rather than as a wobbly tube.
 *
 * The two ground-hugging roles damp the vertical component of that offset and
 * clamp their result above the floor, because a kink with a free y is a
 * filament that spends half its length buried.
 */
const CAGE_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform vec3  uCentre;      // the trap's point on the floor
  uniform vec3  uHand;        // where the leash leaves the caster
  uniform vec3  uFront;       // the leash's travelling tip
  uniform float uRadius;      // footprint, metres — already eased by the snap
  uniform float uHeight;      // column height, metres
  uniform float uSeed;
  uniform float uRestrike;
  uniform float uFade;

  uniform float uCountLeash;
  uniform float uCountColumn;
  uniform float uCountTendril;
  uniform float uCountRim;

  uniform float uLeashSag;
  uniform float uLeashSpread;
  uniform float uLeashCling;
  uniform float uLeashKink;
  uniform float uLeashWidth;

  uniform float uHeightCurve;
  uniform float uThroat;
  uniform float uColumnSpread;
  uniform float uColumnCurve;
  uniform float uColumnFlare;
  uniform float uColumnTwist;
  uniform float uColumnSpin;
  uniform float uColumnKink;
  uniform float uColumnWidth;
  uniform float uColumnTaper;

  uniform float uTendrilInner;
  uniform float uTendrilReach;
  uniform float uTendrilCurve;
  uniform float uTendrilWander;
  uniform float uTendrilArch;
  uniform float uTendrilHug;
  uniform float uTendrilSpin;
  uniform float uTendrilKink;
  uniform float uTendrilWidth;
  uniform float uTendrilDim;

  uniform float uRimSpan;
  uniform float uRimSpeed;
  uniform float uRimHeight;
  uniform float uRimJitter;
  uniform float uRimKink;
  uniform float uRimWidth;
  uniform float uRimDim;

  uniform float uJitter;
  uniform float uJitterScale;
  uniform float uOctaves;
  uniform float uJitterFalloff;
  uniform float uCrawl;
  uniform float uPinch;

  uniform float uWidth;
  uniform float uWidthScale;
  uniform float uStrandFlash;
  uniform float uFlickerSpeed;

  attribute float aStrand;

  varying float vT;
  varying float vSide;
  varying float vDim;
  varying float vFlash;
  varying float vViewZ;

  ${noiseGLSL}

  /** Value noise with a *linear* ramp — piecewise-linear output, sharp corners. */
  float vnoise(float x, float seed) {
    float i = floor(x);
    float f = x - i;
    return mix(hash11(i + seed), hash11(i + 1.0 + seed), f) * 2.0 - 1.0;
  }

  /**
   * Offset of one filament from its path, in the perpendicular plane.
   * span is the length of that path, so uJitterScale stays kinks per *metre*
   * whether the filament is a 20 m whip or a 1 m hop around the rim.
   */
  vec2 kink(float t, float seed, float span) {
    vec2 o = vec2(0.0);
    float amp = 1.0;
    float freq = max(uJitterScale, 0.01) * span;
    float scroll = uTime * uCrawl;

    // Fixed trip count with a per-octave gate: a dynamic bound is not portable,
    // and five multiply-adds are cheaper than the branch would be anyway.
    for (int i = 0; i < 5; i++) {
      float on = step(float(i), uOctaves - 1.0);
      o.x += on * amp * vnoise(t * freq + scroll, seed + 13.0 * float(i));
      o.y += on * amp * vnoise(t * freq + scroll * 1.17, seed + 71.3 + 13.0 * float(i));
      amp *= uJitterFalloff;
      freq *= 2.0;
      scroll *= 1.63;
    }
    return o;
  }

  /** The role's centreline at t, before any kink is added. */
  vec3 pathAt(float role, float f, float seed, float t) {
    if (role < 0.5) {
      /* ---- the leash: a line from the hand to the travelling tip ---- */
      vec3 p = mix(uHand, uFront, t);
      p.y += uLeashSag * sin(t * PI);
      // Negative sag drops the whip onto the floor, which is where a whip
      // thrown at the ground belongs — but not through it.
      p.y = max(p.y, uLeashCling);
      return p;
    }

    if (role < 1.5) {
      /* ---- the column: a twisting climb out of the middle ---- */
      float a = f * TAU + (t * uColumnTwist + uTime * uColumnSpin) * TAU;
      float r = uRadius * (mix(uThroat, uColumnSpread, pow(t, max(uColumnCurve, 0.01)))
                           + uColumnFlare * smoothstep(0.72, 1.0, t));
      vec3 p = uCentre + vec3(cos(a), 0.0, sin(a)) * r;
      p.y = pow(t, max(uHeightCurve, 0.01)) * uHeight;
      return p;
    }

    if (role < 2.5) {
      /* ---- a tendril: a meander running out to the boundary ---- */
      // The veer is a per-filament constant rather than noise so the tendril
      // curves *consistently*, the way a discharge that has committed to a
      // direction does; the kinks on top of it supply the rest.
      float veer = (hash11(seed + 5.0) - 0.5) * 2.0 * uTendrilWander;
      float a = f * TAU + uTime * uTendrilSpin * TAU + hash11(seed) * 0.4 + veer * pow(t, 1.4);
      float r = uRadius * mix(uTendrilInner, uTendrilReach, pow(t, max(uTendrilCurve, 0.01)));
      vec3 p = uCentre + vec3(cos(a), 0.0, sin(a)) * r;
      p.y = uTendrilHug + uTendrilArch * sin(t * PI);
      return p;
    }

    /* ---- a rim arc: current hopping around the boundary ---- */
    float a = (f + uTime * uRimSpeed) * TAU + hash11(seed) * 0.3 + t * uRimSpan * TAU;
    float r = uRadius * (1.0 + uRimJitter * 0.25 * sin(t * 6.0 + seed));
    vec3 p = uCentre + vec3(cos(a), 0.0, sin(a)) * r;
    p.y = uTendrilHug + uRimHeight * sin(t * PI);
    return p;
  }

  void main() {
    float t = position.x;
    float side = position.y;
    vT = t;
    vSide = side;

    /* ---- which role is this filament wearing ---- */
    float b1 = uCountLeash;
    float b2 = b1 + uCountColumn;
    float b3 = b2 + uCountTendril;

    float role = 0.0;
    float local = aStrand;
    float count = max(uCountLeash, 1.0);
    if (aStrand >= b3) {
      role = 3.0; local = aStrand - b3; count = max(uCountRim, 1.0);
    } else if (aStrand >= b2) {
      role = 2.0; local = aStrand - b2; count = max(uCountTendril, 1.0);
    } else if (aStrand >= b1) {
      role = 1.0; local = aStrand - b1; count = max(uCountColumn, 1.0);
    }
    // Open interval on purpose: 0 and 1 would put two filaments on the same
    // bearing for the roles that fan around a circle.
    float f = local / count;

    // The strike index snaps every filament onto a new shape uRestrike times a
    // second; the crawl inside kink() slides it continuously in between.
    float strike = floor(uTime * max(uRestrike, 0.01));
    float seed = hash11(aStrand * 7.13 + uSeed + strike * 3.77) * 97.0;

    /* ---- per-role constants ---- */
    float amp = uLeashKink;
    float widthMul = uLeashWidth;
    float span = max(length(uFront - uHand), 0.01);
    float dim = 1.0;
    if (role > 2.5) {
      amp = uRimKink; widthMul = uRimWidth; dim = uRimDim;
      span = max(uRadius * uRimSpan * TAU, 0.01);
    } else if (role > 1.5) {
      amp = uTendrilKink; widthMul = uTendrilWidth; dim = uTendrilDim;
      span = max(uRadius * max(uTendrilReach - uTendrilInner, 0.05), 0.01);
    } else if (role > 0.5) {
      amp = uColumnKink; widthMul = uColumnWidth;
      span = max(uHeight, 0.01);
    }
    vDim = dim;

    /* ---- the frame the offsets live in ---- */
    float step_ = 0.02;
    vec3 here = pathAt(role, f, seed, t);
    vec3 behind = pathAt(role, f, seed, max(t - step_, 0.0));
    vec3 ahead = pathAt(role, f, seed, min(t + step_, 1.0));

    vec3 tangent = ahead - behind;
    tangent = length(tangent) > 1e-5 ? normalize(tangent) : vec3(0.0, 1.0, 0.0);
    // The column runs vertically, so the usual world-up reference degenerates
    // on exactly the role that needs the frame most.
    vec3 upRef = abs(tangent.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 n1 = normalize(cross(tangent, upRef));
    vec3 n2 = normalize(cross(tangent, n1));

    /* ---- the kinks, and the fan that separates the whip's filaments ---- */
    float pinch = max(uPinch, 1e-3);
    float ends = smoothstep(0.0, pinch, t) * smoothstep(0.0, pinch, 1.0 - t);

    vec2 k = kink(t, seed, span) * amp * uJitter * ends;
    if (role < 0.5) {
      float fan = (f - 0.5) * 2.0 * uLeashSpread;
      k += vec2(cos(seed), sin(seed)) * fan * ends;
    }

    vec3 offset = n1 * k.x + n2 * k.y;
    // Ground roles keep their kinks in the floor plane. A free y here buries
    // half of every tendril and the effect reads as a broken dotted line.
    if (role > 1.5) offset.y *= 0.3;

    vec3 world = here + offset;
    vec3 nextWorld = ahead + offset;
    if (role > 1.5) {
      world.y = max(world.y, uTendrilHug * 0.4);
      nextWorld.y = max(nextWorld.y, uTendrilHug * 0.4);
    }

    /* ---- turn the ribbon to face the camera ---- */
    vec3 tan2 = nextWorld - world;
    tan2 = length(tan2) > 1e-5 ? normalize(tan2) : tangent;
    vec3 toCamera = normalize(cameraPosition - world);
    vec3 binormal = cross(tan2, toCamera);
    float bl = length(binormal);
    binormal = bl > 1e-4 ? binormal / bl : n1;

    /* ---- width ---- */
    // A stuttering per-filament blink, quantised to uFlickerSpeed so the whole
    // cage strobes on one clock instead of shimmering independently.
    float flash = mix(1.0, hash11(floor(uTime * uFlickerSpeed) + aStrand * 3.7 + uSeed), uStrandFlash);
    vFlash = flash;

    float halfWidth = uWidth * uWidthScale * widthMul;
    // Every filament is an arc with two loose ends, so it tapers at both.
    halfWidth *= mix(1.0, pow(max(sin(clamp(t, 0.0, 1.0) * PI), 0.0), 0.35), 0.85);
    if (role > 0.5 && role < 1.5) halfWidth *= mix(1.0, uColumnTaper, t);
    halfWidth *= flash * uFade;

    // World space throughout: the ability's group is an identity transform, and
    // going through modelMatrix would only invite it to drift.
    vec4 mv = viewMatrix * vec4(world + binormal * side * halfWidth, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const CAGE_FRAGMENT = /* glsl */ `
  #define PI 3.141592653589793

  uniform float uTime;
  uniform float uSeed;
  uniform float uCoreSharp;
  uniform float uGlowFalloff;
  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform float uPassOpacity;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFade;
  uniform float uSoftFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform vec3  uColorHalo;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying float vT;
  varying float vSide;
  varying float vDim;
  varying float vFlash;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    float v = clamp(abs(vSide), 0.0, 1.0);

    #ifdef CAGE_GLOW
      float profile = pow(1.0 - v, max(uGlowFalloff, 0.05));
      vec3 color = mix(uColorHalo, uColorOuter, profile);
      float alpha = profile;
    #else
      float profile = pow(1.0 - v, max(uCoreSharp, 0.05));
      vec3 color = mix(uColorOuter, uColorInner, smoothstep(0.0, 0.5, profile));
      color = mix(color, uColorCore, smoothstep(0.45, 1.0, profile));
      float alpha = profile;
    #endif

    // Quantised, not sinusoidal: real lightning stutters between brightnesses,
    // it does not breathe.
    float flicker = 1.0 - uFlicker * hash11(floor(uTime * uFlickerSpeed) + uSeed);

    // The loose ends fade as well as thin. A ribbon that only narrows leaves a
    // hard dot at each tip, and every filament here has two of them.
    alpha *= pow(max(sin(clamp(vT, 0.0, 1.0) * PI), 0.0), 0.35);
    alpha *= flicker * vFlash * vDim * uFade * uPassOpacity * uOpacity;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * One pass of the cage.
 *
 * Both passes share every uniform except the two that define the pass itself
 * (`uWidthScale`, `uPassOpacity`), so `userData.sync()` can be handed the same
 * state for each and the editor drives them together.
 *
 * @param {number} pass SnarePass.*
 */
export function createSnareCageMaterial(pass = SnarePass.CORE) {
  const glow = pass === SnarePass.GLOW;

  const material = new ShaderMaterial({
    defines: glow ? { CAGE_GLOW: '' } : {},
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uCentre: { value: new Vector3() },
      uHand: { value: new Vector3() },
      uFront: { value: new Vector3(0, 0, 1) },
      uRadius: { value: 4.4 },
      uHeight: { value: 6.2 },
      uSeed: { value: 0 },
      uRestrike: { value: 21 },
      uFade: { value: 1 },

      uCountLeash: { value: 3 },
      uCountColumn: { value: 8 },
      uCountTendril: { value: 12 },
      uCountRim: { value: 7 },

      uLeashSag: { value: -0.35 },
      uLeashSpread: { value: 0.22 },
      uLeashCling: { value: 0.12 },
      uLeashKink: { value: 0.3 },
      uLeashWidth: { value: 1 },

      uHeightCurve: { value: 0.85 },
      uThroat: { value: 0.07 },
      uColumnSpread: { value: 0.17 },
      uColumnCurve: { value: 1.35 },
      uColumnFlare: { value: 0.12 },
      uColumnTwist: { value: 0.55 },
      uColumnSpin: { value: 0.4 },
      uColumnKink: { value: 0.24 },
      uColumnWidth: { value: 1.6 },
      uColumnTaper: { value: 0.55 },

      uTendrilInner: { value: 0.06 },
      uTendrilReach: { value: 1 },
      uTendrilCurve: { value: 0.8 },
      uTendrilWander: { value: 0.9 },
      uTendrilArch: { value: 0.22 },
      uTendrilHug: { value: 0.05 },
      uTendrilSpin: { value: 0.05 },
      uTendrilKink: { value: 0.18 },
      uTendrilWidth: { value: 0.75 },
      uTendrilDim: { value: 0.8 },

      uRimSpan: { value: 0.19 },
      uRimSpeed: { value: 0.28 },
      uRimHeight: { value: 0.35 },
      uRimJitter: { value: 0.16 },
      uRimKink: { value: 0.12 },
      uRimWidth: { value: 0.7 },
      uRimDim: { value: 0.9 },

      uJitter: { value: 1 },
      uJitterScale: { value: 1.4 },
      uOctaves: { value: 4 },
      uJitterFalloff: { value: 0.55 },
      uCrawl: { value: 2.4 },
      uPinch: { value: 0.16 },

      uWidth: { value: 0.032 },
      uWidthScale: { value: glow ? 6.2 : 1 },
      uPassOpacity: { value: glow ? 0.44 : 1 },
      uStrandFlash: { value: 0.45 },
      uFlickerSpeed: { value: 30 },
      uFlicker: { value: 0.26 },
      uCoreSharp: { value: 4.4 },
      uGlowFalloff: { value: 2.3 },
      uSoftFade: { value: 0.7 },

      uOpacity: { value: 1 },
      uGlow: { value: 2.2 },
      uColorCore: { value: new Color(1, 1, 1) },
      uColorInner: { value: new Color(0.86, 0.82, 1) },
      uColorOuter: { value: new Color(0.56, 0.42, 1) },
      uColorHalo: { value: new Color(0.16, 0.05, 0.55) }
    }),
    vertexShader: CAGE_VERTEX,
    fragmentShader: CAGE_FRAGMENT
  });

  /**
   * Push the live settings and the current cast state into the uniforms.
   *
   * Called every frame — including on a zero-length frame while the sandbox is
   * paused, which is what keeps every control below a live slider.
   *
   * @param {object} state
   *   { centre, hand, front, radius, height, fade, seed, counts }
   */
  material.userData.sync = (state) => {
    const c = settings.snare;
    const g = settings.global;
    const u = material.uniforms;

    u.uCentre.value.copy(state.centre);
    u.uHand.value.copy(state.hand);
    u.uFront.value.copy(state.front);
    u.uRadius.value = state.radius;
    u.uHeight.value = state.height;
    u.uSeed.value = state.seed;
    u.uFade.value = state.fade;

    u.uCountLeash.value = state.counts.leash;
    u.uCountColumn.value = state.counts.column;
    u.uCountTendril.value = state.counts.tendril;
    u.uCountRim.value = state.counts.rim;

    u.uRestrike.value = c.restrike;

    u.uLeashSag.value = c.leashSag;
    u.uLeashSpread.value = c.leashSpread;
    u.uLeashCling.value = c.leashCling;
    u.uLeashKink.value = c.leashKink;
    u.uLeashWidth.value = c.leashWidth;

    u.uHeightCurve.value = c.heightCurve;
    u.uThroat.value = c.throat;
    u.uColumnSpread.value = c.columnSpread;
    u.uColumnCurve.value = c.columnCurve;
    u.uColumnFlare.value = c.columnFlare;
    u.uColumnTwist.value = c.columnTwist;
    u.uColumnSpin.value = c.columnSpin;
    u.uColumnKink.value = c.columnKink;
    u.uColumnWidth.value = c.columnWidth;
    u.uColumnTaper.value = c.columnTaper;

    u.uTendrilInner.value = c.tendrilInner;
    u.uTendrilReach.value = c.tendrilReach;
    u.uTendrilCurve.value = c.tendrilCurve;
    u.uTendrilWander.value = c.tendrilWander;
    u.uTendrilArch.value = c.tendrilArch;
    u.uTendrilHug.value = c.tendrilHug;
    u.uTendrilSpin.value = c.tendrilSpin;
    u.uTendrilKink.value = c.tendrilKink;
    u.uTendrilWidth.value = c.tendrilWidth;
    u.uTendrilDim.value = c.tendrilDim;

    u.uRimSpan.value = c.rimSpan;
    u.uRimSpeed.value = c.rimSpeed;
    u.uRimHeight.value = c.rimHeight;
    u.uRimJitter.value = c.rimJitter;
    u.uRimKink.value = c.rimKink;
    u.uRimWidth.value = c.rimWidth;
    u.uRimDim.value = c.rimDim;

    // The kinks are the one place `global.randomness` and the noise multipliers
    // have anything to bite on, so they scale here rather than everywhere.
    u.uJitter.value = c.jitter * g.randomness * g.noiseStrength;
    u.uJitterScale.value = c.jitterScale * g.noiseFrequency;
    u.uOctaves.value = Math.round(c.octaves);
    u.uJitterFalloff.value = c.jitterFalloff;
    u.uCrawl.value = c.crawl * g.noiseSpeed;
    u.uPinch.value = c.pinch;

    u.uWidth.value = c.width;
    u.uWidthScale.value = glow ? c.glowWidth : 1;
    u.uPassOpacity.value = glow ? c.glowOpacity : 1;
    u.uStrandFlash.value = c.strandFlash;
    u.uFlickerSpeed.value = c.flickerSpeed;
    u.uFlicker.value = c.flicker;
    u.uCoreSharp.value = c.coreSharp;
    u.uGlowFalloff.value = c.glowFalloff;
    u.uSoftFade.value = c.softFade;

    u.uOpacity.value = c.opacity * g.opacity;
    u.uGlow.value = c.glow;
    u.uColorCore.value.copy(getColor(c.colorCore));
    u.uColorInner.value.copy(getColor(c.colorInner));
    u.uColorOuter.value.copy(getColor(c.colorOuter));
    u.uColorHalo.value.copy(getColor(c.colorHalo));
  };

  return material;
}

/* ==================================================================== */
/* The field burnt into the floor                                        */
/* ==================================================================== */

const FIELD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The circle the indicator promised, burnt into the floor.
 *
 * Same signed-distance construction as the aim circle and the same thick band,
 * because that correspondence *is* the effect: what you measured out before you
 * clicked is what is now standing on the ground. What it does not share is the
 * treatment — the interior is charred and veined rather than washed, the ring
 * is a burn rather than a line, and everything in it crawls.
 *
 * It is an ability-owned mesh rather than a pooled decal for one reason: a
 * decal captures its radius when it spawns, and this circle has to re-scale
 * under `zoneRadius` while it is still standing.
 */
const FIELD_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;
  uniform float uRadius;
  uniform float uBoundary;
  uniform float uBoundaryGlow;
  uniform float uFill;
  uniform float uFalloff;
  uniform float uVeins;
  uniform float uVeinScale;
  uniform float uVeinSharp;
  uniform float uWarp;
  uniform float uCrawl;
  uniform float uRings;
  uniform float uRingSpeed;
  uniform float uSpokes;
  uniform float uSpokeLength;
  uniform float uSpin;
  uniform float uCore;
  uniform float uCoreSize;
  uniform float uPulse;
  uniform float uPulseSpeed;
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform vec3  uColorField;
  uniform vec3  uColorEdge;
  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${noiseGLSL}
  ${commonGLSL}

  #define TAU 6.28318530718

  void main() {
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float d = length(p);

    float outer = uRadius + uBoundary * 0.4;
    float inner = max(0.01, uRadius - uBoundary * 0.6);

    float aa = fwidth(d) + 0.02;
    if (d > outer + aa * 4.0) discard;

    float band = smoothstep(outer + aa, outer - aa, d) * smoothstep(inner - aa, inner + aa, d);
    float interior = smoothstep(inner + aa, inner - aa, d);
    float radial = clamp(d / inner, 0.0, 1.0);

    /* ---- the veins burnt across the disc ---- */
    // Sampled in the *plane* and domain warped, never on atan(): an angular
    // lookup hands every radius along a bearing the same value and draws
    // dead-straight spokes out of the centre — a firework, not a burn.
    float warp = fbm3(vec3(p * 0.5, uTime * 0.2 + uSeed)) * uWarp;
    float fil = ridged(vec3(p * uVeinScale + warp, uSeed * 11.0 + uTime * uCrawl), 4);
    float veins = smoothstep(mix(0.55, 0.86, uVeinSharp), 0.98, fil) * interior * uVeins;

    /* ---- pressure rings running out of the middle ---- */
    float ring = 0.5 + 0.5 * cos((radial * uRings - uTime * uRingSpeed) * TAU);
    ring = pow(ring, 8.0) * interior;

    /* ---- ticks stepping around the boundary ---- */
    float ang = atan(p.y, p.x) / TAU + 0.5;
    float spokePhase = fract(ang * uSpokes + uTime * uSpin * uSpokes);
    float spoke = 1.0 - smoothstep(0.22, 0.3, spokePhase);
    spoke *= smoothstep(inner - uSpokeLength, inner, d) * smoothstep(outer, inner, d);

    /* ---- the pool the column stands in ---- */
    float core = smoothstep(uCoreSize * uRadius, 0.0, d) * uCore;

    float breathe = 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU);
    float wash = interior * pow(radial, uFalloff) * uFill;
    float lines = (band * uBoundaryGlow + spoke + core + ring * 0.35) * breathe;
    float body = (wash + veins * 0.9) * breathe;

    float alpha = clamp(body + lines, 0.0, 1.0) * uFade * uOpacity;
    if (alpha < 0.004) discard;

    vec3 color = uColorField * body + uColorEdge * lines;
    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * The ground field. One quad, re-sized and re-shaded from `settings.snare`
 * every frame.
 */
export function createSnareFieldMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uQuadSize: { value: 12 },
      uRadius: { value: 4.4 },
      uBoundary: { value: 0.4 },
      uBoundaryGlow: { value: 2.6 },
      uFill: { value: 0.3 },
      uFalloff: { value: 1.7 },
      uVeins: { value: 1 },
      uVeinScale: { value: 1.5 },
      uVeinSharp: { value: 0.72 },
      uWarp: { value: 0.55 },
      uCrawl: { value: 0.5 },
      uRings: { value: 2.4 },
      uRingSpeed: { value: 0.8 },
      uSpokes: { value: 20 },
      uSpokeLength: { value: 0.5 },
      uSpin: { value: 0.05 },
      uCore: { value: 1.3 },
      uCoreSize: { value: 0.22 },
      uPulse: { value: 0.3 },
      uPulseSpeed: { value: 3.4 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uColorField: { value: new Color(0.56, 0.42, 1) },
      uColorEdge: { value: new Color(1, 1, 1) }
    }),
    vertexShader: FIELD_VERTEX,
    fragmentShader: FIELD_FRAGMENT
  });

  /**
   * @param {object} state { radius, quadSize, fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.snare;
    const g = settings.global;
    const u = material.uniforms;

    u.uQuadSize.value = state.quadSize;
    u.uRadius.value = state.radius;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uBoundary.value = c.fieldBoundary;
    u.uBoundaryGlow.value = c.fieldBoundaryGlow;
    u.uFill.value = c.fieldFill;
    u.uFalloff.value = c.fieldFalloff;
    u.uVeins.value = c.fieldVeins * g.shaderIntensity;
    u.uVeinScale.value = c.fieldVeinScale * g.noiseFrequency;
    u.uVeinSharp.value = c.fieldVeinSharp;
    u.uWarp.value = c.fieldWarp * g.noiseStrength;
    u.uCrawl.value = c.fieldCrawl * g.noiseSpeed;
    u.uRings.value = c.fieldRings;
    u.uRingSpeed.value = c.fieldRingSpeed;
    u.uSpokes.value = Math.max(0, Math.round(c.fieldSpokes));
    u.uSpokeLength.value = c.fieldSpokeLength;
    u.uSpin.value = c.fieldSpin;
    u.uCore.value = c.fieldCore;
    u.uCoreSize.value = c.fieldCoreSize;
    u.uPulse.value = c.fieldPulse;
    u.uPulseSpeed.value = c.fieldPulseSpeed;
    u.uOpacity.value = c.fieldOpacity * g.opacity;
    u.uColorField.value.copy(getColor(c.colorField));
    u.uColorEdge.value.copy(getColor(c.colorFieldEdge));
  };

  return material;
}
