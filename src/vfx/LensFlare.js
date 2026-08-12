import {
  Mesh,
  PlaneGeometry,
  InstancedBufferGeometry,
  InstancedBufferAttribute,
  ShaderMaterial,
  AdditiveBlending,
  DoubleSide,
  Color,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonVertexGLSL } from '../shaders/lib/common.glsl.js';
import { frame, sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { copyColor } from '../utils/color.js';

/* ------------------------------------------------------------------------ */
/* LensFlare — the artefact that belongs to the camera, not to the world     */
/* ------------------------------------------------------------------------ */
/**
 * A screen-space anamorphic flare anchored to a world point, **occlusion tested
 * against the depth prepass**.
 *
 * Everything else in `src/vfx/` draws something that is *there*: a tube of
 * plasma, a sheet of ice, a hole in the air. This module draws something that
 * is not there at all. A flare is what a bright point does to the glass in
 * front of the sensor — ghosts bouncing between element surfaces, a starburst
 * from the iris blades, a horizontal smear from the cylindrical anamorphic
 * element — and none of it exists in the scene. That single fact decides every
 * design choice below.
 *
 * ## Why the occlusion test is the whole module
 *
 * Because a flare lives on the lens it must be drawn **after** the scene, with
 * the depth test off: a ghost that vanishes behind a pillar is not a lens
 * artefact, it is a decal. But turning the depth test off also throws away the
 * only occlusion the renderer gives you for free, and a flare that survives the
 * character walking in front of the lamp is the tell that has made cheap flares
 * look cheap for twenty years. It is a sticker stuck to the monitor.
 *
 * So the module buys the occlusion back by hand. `frame.uSceneDepth` is already
 * there — a packed-RGBA depth prepass of the opaque `WORLD` layer, rendered
 * every frame for the soft particles — and the flare samples it at the source's
 * own screen position, in the **vertex** shader, with a small area-uniform disc
 * kernel. The average over the kernel is an estimate of what fraction of the
 * source's disc is unoccluded, and the whole flare is scaled by it.
 *
 * The first version took one tap at the source's exact pixel. It is much worse
 * than it sounds: the flare does not dim as the character crosses the source,
 * it **switches off**, on one frame, at the instant the silhouette edge crosses
 * that one pixel — and switches back on the same way. Sixteen elements totalling
 * a third of the screen popping in and out is far more distracting than no
 * occlusion at all. The kernel is not a quality nicety; it is the difference
 * between the feature working and being worse than not having it.
 *
 * Second thing the kernel buys: the prepass is **half resolution** and is
 * sampled with linear filtering, and interpolating *packed* depth between two
 * texels produces a number that is not a depth at all. Every `softFade` in the
 * project already lives with that. Spreading the taps over the source's
 * apparent size means the nonsense values are a minority of the average instead
 * of the whole answer.
 *
 * ## Why it is one draw call
 *
 * Sixteen billboards is sixteen draw calls if you build it the obvious way.
 * Here one instanced quad carries every element: instance 0 is the core and its
 * starburst, 1 the anamorphic streak, 2 the iris ring, and 3..10 the ghosts.
 * The vertex shader places each instance directly in NDC from the projected
 * anchor, so the mesh's own matrix is identity for its whole life and moving
 * the flare is a `Vector3` copy into a uniform.
 *
 * The ghost series is generated from sliders rather than from an array of
 * per-ghost records, for two reasons. The first is **I1**: an array of metres
 * would be a dimension living somewhere other than a settings block. The second
 * is that a uniform array may be indexed only by a loop counter in ESSL 1.00
 * (see the traps in the README), so per-ghost lookups would need the
 * `if (i == slot)` unrolled loop `FilamentPaths` uses, for values that a base,
 * a stride and a hashed scatter describe better anyway.
 *
 * ## Why every ghost shares a blade count
 *
 * `ghostBlades` is one slider for the whole flare, and this is deliberate. The
 * ghosts are all images of the *same iris*, so they all have the same number of
 * sides; what differs between them is rotation, roundness (the far ones defocus
 * into discs) and polarity. Giving each ghost its own blade count — a hexagon
 * next to a pentagon next to an octagon — is the single most common way a drawn
 * flare announces itself. Each ghost does get its own size, its own tint off a
 * four-stop gradient, its own spin and its own roundness; that is "its own
 * aperture shape" in the only sense a real lens allows.
 *
 * ## Tone mapping
 *
 * The material is `toneMapped: false` and draws at `renderOrder` 3000 with the
 * depth test off, so it is the last thing in the scene pass and the renderer
 * never applies a curve to it directly. But inside the composer *everything* is
 * linear HDR until `OutputPass`, and ACES will happily take an authored deep
 * blue streak at 8× and hand back a white bar — hue clipped, which is exactly
 * the failure the module has to avoid, because the colour of the streak is the
 * whole reason it is there.
 *
 * So the fragment shader ends with a **hue-preserving shoulder**: the Reinhard
 * curve is applied to the largest channel and all three are scaled by the same
 * ratio, which compresses the magnitude and leaves chromaticity untouched.
 * `headroom` is the value the peak asymptotes to, in linear light, and it is a
 * slider. The version before this applied Reinhard per channel, which is the
 * textbook thing to do and desaturates towards white precisely as hard as the
 * tone curve we were trying to get out from under.
 *
 * ## Cost
 *
 * **One draw call.** Up to eleven instanced quads, fill-heavy by nature (the
 * streak is a third of the frame wide) but the fragment work per element is a
 * handful of `pow`s. The occlusion kernel is evaluated per *vertex*: with the
 * default seven taps that is 7 × 4 × 11 = 308 depth fetches for the whole
 * flare, against roughly a million if the same test were done per fragment.
 *
 * ## Invariants
 *
 * - **I1** — nothing dimensioned is stored. `update()` writes every size,
 *   spacing and angle into uniforms from the caller's live params object, on
 *   every frame including a zero-length one.
 * - **I2** — no texture. The starburst, the polygons, the dispersion fringes
 *   and the streak grain are all analytic.
 * - **I3** — the mesh, the geometry and the eleven instances are built once.
 *   `update()` writes numbers into existing boxes and sets `instanceCount`.
 * - **I5** — every dimension below is a slider and every colour is a picker;
 *   seven pickers, none derived from another.
 */

/* ---------------------------------------------------------------- */
/* Layout                                                            */
/* ---------------------------------------------------------------- */

/** Instance roles. The order is the instance order and must not be reshuffled. */
export const FlareRole = Object.freeze({
  /** The source itself: hot core, iris starburst, tight halo. */
  CORE: 0,
  /** The horizontal anamorphic smear. */
  STREAK: 1,
  /** The wide, dim, chromatic iris ring near the opposite side of the frame. */
  RING: 2,
  /** Everything from index 3 up: the ghost train along the source→centre line. */
  GHOST: 3
});

/** Fixed instances that exist whatever the ghost count is. */
const FIXED_INSTANCES = 3;

/** Hard ceiling on the ghost train. Eight is more than any real lens shows. */
export const MAX_FLARE_GHOSTS = 8;

/** Kernel ceiling. The loop is unrolled to this; `occTaps` clamps into it. */
const MAX_OCC_TAPS = 9;

/* ---------------------------------------------------------------- */
/* Shaders                                                           */
/* ---------------------------------------------------------------- */

/**
 * The vertex shader does all four hard jobs, and the fragment shader only
 * shades a unit square.
 *
 * 1. Project the anchor once and keep it as a constant across the quad. (The
 *    same trick `Distortion.js` documents: a varying whose value is identical
 *    at every vertex interpolates to exactly that value, so "where is the
 *    source on screen" is exact per fragment for the price of one matrix
 *    multiply, rather than approximately right at the corners.)
 * 2. Run the occlusion kernel against the depth prepass.
 * 3. Place, size, spin and tint this instance — the ghost train's arithmetic
 *    lives here, so the fragment shader never learns what a ghost is.
 * 4. Emit the quad **directly in NDC**, aspect-corrected, so a "size" slider
 *    means a fraction of the frame and not a number of metres.
 *
 * `vLocal` is the un-rotated quad coordinate. Rotating the *vertices* and
 * shading in the un-rotated frame is what lets `ghostSpin` and `streakTilt`
 * exist without either of them appearing in the fragment shader at all.
 */
const FLARE_VERTEX = /* glsl */ `
  attribute float aRole;      // 0 core · 1 streak · 2 ring · 3+ ghost
  attribute float aSlot;      // ghost ordinal, 0-based; 0 for the fixed three

  uniform vec3  uAnchor;      // world point the flare hangs off
  uniform vec2  uResolution;  // device pixels — the only reason aspect is right
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  /* --- occlusion --- */
  uniform float uOcclusion;   // 0..1 master; 0 also means "no depth buffer bound"
  uniform float uOccRadius;   // screen fraction — the source's apparent half-size
  uniform float uOccTaps;     // 1..9
  uniform float uOccFade;     // metres over which the depth compare feathers
  uniform float uOccSpin;     // radians — rotates the kernel off the pixel grid

  /* --- framing --- */
  uniform float uEdgeStart;   // |ndc| where the flare starts fading out
  uniform float uEdgeEnd;     // |ndc| where it is gone
  uniform float uIntensity;
  uniform float uOpacity;
  uniform float uSeed;

  /* --- core --- */
  uniform float uCoreSize;    // fraction of frame HEIGHT
  uniform float uCoreGlow;
  uniform float uBurstLength; // fraction of frame height, spike reach
  uniform float uBurstSpin;   // radians
  uniform float uHaloSize;
  uniform float uHaloWidth;

  /* --- streak --- */
  uniform float uStreakLength;    // fraction of frame WIDTH, per side
  uniform float uStreakThickness; // fraction of frame height
  uniform float uStreakTilt;      // radians off horizontal
  uniform float uStreakGlow;

  /* --- ring --- */
  uniform float uRing;        // 0 hides it
  uniform float uRingSpacing; // fraction of the source→centre vector
  uniform float uRingSize;    // fraction of frame height
  uniform float uRingWidth;
  uniform float uRingGlow;

  /* --- ghosts --- */
  uniform float uGhostCount;
  uniform float uGhostSpacing;    // first ghost, as a fraction of source→centre
  uniform float uGhostStride;     // added per ghost — negative walks back out
  uniform float uGhostScatter;    // hashed jitter on the spacing
  uniform float uGhostSize;       // fraction of frame height
  uniform float uGhostSizeStep;   // multiplied per ghost
  uniform float uGhostSizeScatter;
  uniform float uGhostSpin;       // radians added per ghost
  uniform float uGhostRound;      // 0 polygon, 1 disc — the first ghost
  uniform float uGhostRoundStep;  // added per ghost; the far ones defocus
  uniform float uGhostGlow;
  uniform float uGhostChroma;

  /* --- colours --- */
  uniform vec3 uColorCore;
  uniform vec3 uColorStreak;
  uniform vec3 uColorRing;
  uniform vec3 uColorGhostA;
  uniform vec3 uColorGhostB;
  uniform vec3 uColorGhostC;
  uniform vec3 uColorGhostD;

  varying float vRole;
  varying vec2  vLocal;   // un-rotated quad coords, -1..1
  varying vec3  vTint;
  varying float vAmp;     // intensity x glow x occlusion x edge fade x opacity
  varying vec4  vShape;   // x extent (height fractions) · y roundness · z chroma · w polarity

  ${noiseGLSL}

  /* commonGLSL is deliberately NOT injected here, and this is a trap worth
   * knowing about: it carries aastep, which calls fwidth, and derivative
   * functions do not exist in a vertex shader. Injecting the *fragment* chunk
   * into a vertex stage fails to compile the whole program with an error that
   * points at a helper you are not using. commonVertexGLSL is that chunk minus
   * the two functions that cannot live here, and injecting it is the answer —
   * this shader used to carry a hand-copied gradient4 instead, which is exactly
   * how a four-stop ramp ends up meaning something slightly different on one
   * mesh than on the next. */
  ${commonVertexGLSL}
  #include <packing>

  /**
   * softFade of common.glsl.js, restated — and this one genuinely cannot be
   * shared. It samples a texture, and a sampler read in a vertex shader is a
   * different capability from a sampler read in a fragment shader (vertex
   * texture units, no implicit LOD); the shared vertex chunk deliberately
   * contains nothing that touches a sampler, so that injecting it can never be
   * the reason a program fails to link on a weak driver.
   */
  float flareFade(sampler2D sceneDepth, vec2 screenUV, float viewZ, float near, float far, float fade) {
    /* screenUV, not uv: three declares the mesh's own uv attribute in the
     * prefix, and a parameter that shadows it is legal and unreadable. */
    float bits = unpackRGBAToDepth(texture2D(sceneDepth, screenUV));
    float sceneViewZ = perspectiveDepthToViewZ(bits, near, far);
    return clamp((viewZ - sceneViewZ) / max(fade, 1e-4), 0.0, 1.0);
  }

  void main() {
    float aspect = max(uResolution.x, 1.0) / max(uResolution.y, 1.0);

    /* ---- the source, in NDC ---- */
    vec4 clip = projectionMatrix * viewMatrix * vec4(uAnchor, 1.0);
    float behind = step(clip.w, 0.0001);          // 1 when the source is behind the eye
    vec2 src = clip.xy / max(clip.w, 0.0001);
    vec2 srcUV = src * 0.5 + 0.5;
    float srcViewZ = (viewMatrix * vec4(uAnchor, 1.0)).z;

    /* ---- occlusion: an area-uniform disc over the prepass ---- */
    /* Area-uniform, not Gaussian. A Gaussian weighting puts most of the answer
     * back on the centre tap and brings the popping straight back; the whole
     * point is an unweighted estimate of the *fraction* of the source's disc
     * that is showing. sqrt() on the radius is what makes the golden-angle
     * spiral cover area evenly instead of piling up in the middle. */
    float taps = clamp(uOccTaps, 1.0, ${MAX_OCC_TAPS}.0);
    float vis = 0.0;
    for (int i = 0; i < ${MAX_OCC_TAPS}; i++) {
      float fi = float(i);
      if (fi >= taps) break;
      float ang = fi * 2.39996323 + uOccSpin;
      float rad = sqrt((fi + 0.5) / taps) * uOccRadius;
      vec2 off = vec2(cos(ang) / aspect, sin(ang)) * rad;
      vis += flareFade(uSceneDepth, srcUV + off, srcViewZ, uCameraNear, uCameraFar, uOccFade);
    }
    vis /= taps;
    float dim = mix(1.0, vis, clamp(uOcclusion, 0.0, 1.0));

    /* A flare does not stop existing when its source leaves the frame — the
     * glass is still lit — but it must not snap off at the border either. */
    float outside = max(abs(src.x), abs(src.y));
    dim *= 1.0 - smoothstep(uEdgeStart, max(uEdgeEnd, uEdgeStart + 0.001), outside);
    dim *= 1.0 - behind;
    dim *= clamp(uOpacity, 0.0, 1.0) * max(uIntensity, 0.0);

    /* ---- place this instance ---- */
    vec2 centre = src;      // NDC position of the element's own centre
    vec2 half2 = vec2(0.0); // NDC half-extent (x, y)
    float spin = 0.0;
    float extent = 0.0;     // isotropic half-extent, in height fractions
    float glow = 1.0;
    vec3 tint = uColorCore;
    float roundness = 0.0;
    float chroma = 0.0;
    float polarity = 0.0;

    if (aRole < 0.5) {
      /* CORE — the quad has to cover the longest spike and the halo. */
      extent = max(uCoreSize * 3.0, max(uBurstLength * 1.7, uHaloSize * (1.0 + uHaloWidth * 2.5)));
      half2 = vec2(extent * 2.0 / aspect, extent * 2.0);
      spin = uBurstSpin;
      glow = uCoreGlow;
      tint = uColorCore;
    } else if (aRole < 1.5) {
      /* STREAK — length in frame widths, thickness in frame heights. Those are
       * different units on purpose: a streak is authored by how far across the
       * frame it reaches, and a thickness of "0.012 of the width" would get
       * thicker every time somebody widened the window. */
      half2 = vec2(uStreakLength * 2.0, uStreakThickness * 2.0);
      spin = uStreakTilt;
      glow = uStreakGlow;
      tint = uColorStreak;
      extent = 1.0;
    } else if (aRole < 2.5) {
      /* RING — the wide dim halo the iris throws across the frame. */
      centre = src * (1.0 - uRingSpacing);
      extent = uRingSize * (1.0 + uRingWidth * 2.0) + 0.01;
      half2 = vec2(extent * 2.0 / aspect, extent * 2.0);
      glow = uRingGlow * step(0.5, uRing);
      tint = uColorRing;
    } else {
      /* GHOST — bounce n along the line from the source through the centre.
       * A spacing over 1 puts the ghost on the far side of the frame, which is
       * where half of a real train ends up; nothing here clamps it. */
      float n = aSlot;
      float h = hash11(n * 13.31 + uSeed * 7.77);
      float h2 = hash11(n * 5.17 + uSeed * 3.11 + 41.0);
      float t = uGhostSpacing + uGhostStride * n + (h - 0.5) * 2.0 * uGhostScatter;
      centre = src * (1.0 - t);

      float size = uGhostSize * pow(max(uGhostSizeStep, 0.01), n);
      size *= 1.0 + (h2 - 0.5) * 2.0 * uGhostSizeScatter;
      extent = max(size, 0.0005);
      half2 = vec2(extent * 2.0 / aspect, extent * 2.0);

      spin = uGhostSpin * n;
      glow = uGhostGlow;
      roundness = clamp(uGhostRound + uGhostRoundStep * n, 0.0, 1.0);
      chroma = uGhostChroma;
      /* Alternate ghosts come off the far surface of the doublet and arrive
       * with the polygon inverted — bright rim, hollow middle, then the other
       * way about. Turning that off makes the train read as one sprite scaled. */
      polarity = mod(n, 2.0);

      float span = max(uGhostCount - 1.0, 1.0);
      tint = gradient4(uColorGhostA, uColorGhostB, uColorGhostC, uColorGhostD, n / span);
      dim *= step(n, uGhostCount - 0.5);
    }

    /* ---- the quad, in NDC ---- */
    vec2 local = position.xy;                  // -1..1
    float cs = cos(spin);
    float sn = sin(spin);
    /* Rotate in *pixel* space or a spun hexagon comes out sheared on a wide
     * window: undo the aspect, rotate, redo it. */
    vec2 pix = vec2(local.x * half2.x * aspect, local.y * half2.y);
    vec2 rot = vec2(pix.x * cs - pix.y * sn, pix.x * sn + pix.y * cs);
    vec2 ndc = centre + vec2(rot.x / aspect, rot.y);

    vLocal = local;
    vRole = aRole;
    vTint = tint;
    vAmp = dim * glow;
    vShape = vec4(extent, roundness, chroma, polarity);

    /* Collapsing to a point is cheaper than a discard: an element that is off
     * or behind the camera never reaches the rasteriser at all. */
    gl_Position = vec4(vAmp > 0.0001 ? ndc : centre, 0.0, 1.0);
  }
`;

/**
 * One fragment shader, four elements, selected on the constant `vRole`.
 *
 * Every chromatic effect in here is **the same shape evaluated at three
 * radii**, one per channel, rather than a hue rotation of one evaluation.
 * Dispersion is geometry: the red image of the iris really is a slightly
 * different size from the blue one. A hue rotation gives you a rainbow that
 * slides around when the ghost moves, which is the giveaway.
 */
const FLARE_FRAGMENT = /* glsl */ `
  uniform float uGlobalGlow;
  uniform float uShaderIntensity;
  uniform float uSeed;
  uniform float uHeadroom;

  /* --- core --- */
  uniform float uCoreSize;
  uniform float uBurstBlades;
  uniform float uBurstLength;
  uniform float uBurstSharp;
  uniform float uBurstJitter;
  uniform float uHaloSize;
  uniform float uHaloWidth;
  uniform float uHaloGlow;
  uniform vec3  uColorHalo;

  /* --- streak --- */
  uniform float uStreakFalloff;
  uniform float uStreakTight;
  uniform float uStreakGrain;
  uniform float uStreakChroma;
  uniform vec3  uColorStreakEdge;

  /* --- ring --- */
  uniform float uRingSize;
  uniform float uRingWidth;
  uniform float uRingChroma;
  uniform float uRingBlades;

  /* --- ghosts --- */
  uniform float uGhostBlades;
  uniform float uGhostFill;
  uniform float uGhostRim;
  uniform float uGhostRimWidth;
  uniform float uGhostSoft;

  varying float vRole;
  varying vec2  vLocal;
  varying vec3  vTint;
  varying float vAmp;
  varying vec4  vShape;

  ${noiseGLSL}

  const float TAU = 6.28318530718;

  /**
   * Distance to a regular polygon of apothem 1, blended toward a circle.
   * The blend is what "the far ghosts defocus into discs" is made of.
   */
  float irisDistance(vec2 p, float blades, float roundness) {
    float r = length(p);
    if (r < 1e-6) return 0.0;
    float a = atan(p.y, p.x);
    float seg = TAU / max(blades, 3.0);
    float poly = cos(floor(0.5 + a / seg) * seg - a) * r;
    return mix(poly, r, clamp(roundness, 0.0, 1.0));
  }

  /** Filled iris with a bright rim. scale is the dispersion knob. */
  float iris(vec2 p, float blades, float roundness, float scale, float fill, float rim) {
    float d = irisDistance(p * scale, blades, roundness);
    float body = 1.0 - smoothstep(1.0 - clamp(uGhostSoft, 0.001, 0.999), 1.0, d);
    float edge = exp(-abs(d - 1.0) / max(uGhostRimWidth, 0.001));
    return body * fill + edge * rim;
  }

  /** Annulus of unit radius, width w, in the same units as iris. */
  float band(vec2 p, float blades, float scale, float w) {
    float d = irisDistance(p * scale, blades, 0.85);
    return exp(-abs(d - 1.0) * abs(d - 1.0) / max(w * w, 1e-6));
  }

  /**
   * Hue-preserving shoulder — see the module comment. Reinhard on the largest
   * channel, all three scaled by the same ratio, so a deep blue streak stays
   * deep blue however hard it is driven.
   */
  vec3 shoulder(vec3 c, float headroom) {
    float m = max(max(c.r, c.g), c.b);
    if (m <= 1e-5) return c;
    float h = max(headroom, 0.05);
    float s = (m / (1.0 + m / h));
    return c * (s / m);
  }

  void main() {
    vec3 rgb = vec3(0.0);

    if (vRole < 0.5) {
      /* ---------------------------------------------------------------- */
      /* CORE — hot point, iris starburst, halo                            */
      /* ---------------------------------------------------------------- */
      /* rf is in fractions of the frame height, so every size slider in this
       * block is in the same unit and comparable by eye in the editor. */
      float rf = length(vLocal) * vShape.x;

      /* An even-bladed iris throws as many spikes as it has blades; an odd one
       * throws twice as many, because opposite edges are no longer parallel.
       * A five-bladed lens with five spikes is one of those details that is
       * wrong in most CG flares and instantly right in the ones that work. */
      float blades = max(uBurstBlades, 3.0);
      float spikes = mod(blades, 2.0) < 0.5 ? blades : blades * 2.0;

      float ang = atan(vLocal.y, vLocal.x);
      float lobe = abs(cos(ang * spikes * 0.5));
      float index = floor((ang + 3.14159265) / (TAU / spikes));
      float jitter = 1.0 + (hash11(index * 3.77 + uSeed * 9.13) - 0.5) * 2.0 * uBurstJitter;

      float reach = max(uBurstLength * jitter, 1e-4);
      float spike = pow(lobe, max(uBurstSharp, 1.0)) * exp(-rf / reach);

      float core = exp(-(rf * rf) / max(uCoreSize * uCoreSize, 1e-8));
      float halo = exp(-pow(abs(rf - uHaloSize) / max(uHaloWidth * uHaloSize, 1e-5), 2.0));

      rgb = vTint * (core + spike) + uColorHalo * halo * uHaloGlow;
    } else if (vRole < 1.5) {
      /* ---------------------------------------------------------------- */
      /* STREAK — the cylindrical element's smear                          */
      /* ---------------------------------------------------------------- */
      float x = vLocal.x;
      float y = vLocal.y;

      float body = pow(max(1.0 - abs(x), 0.0), max(uStreakFalloff, 0.01));
      float thin = exp(-y * y * max(uStreakTight, 0.1));
      float hot = exp(-abs(y) * 26.0);

      /* Real anamorphic streaks are not a clean gradient — the element is a
       * lens, not a light bar, and the smear is grainy along its length. A
       * static hash on x is enough; anything animated boils. */
      float grain = 1.0 + (hash11(floor(x * 220.0) + uSeed * 17.0) - 0.5) * uStreakGrain;

      /* The ends of a streak run blue because the coating's transmission falls
       * off first at the short end of the spectrum. Two pickers, mixed on the
       * distance out, not a hue shift. */
      vec3 tint = mix(vTint, uColorStreakEdge, pow(abs(x), 0.7) * uStreakChroma);
      rgb = tint * body * (thin + hot * 0.6) * grain;
    } else if (vRole < 2.5) {
      /* ---------------------------------------------------------------- */
      /* RING — the wide chromatic iris halo                               */
      /* ---------------------------------------------------------------- */
      float ext = max(vShape.x, 1e-5);
      vec2 p = vLocal * (ext / max(uRingSize, 1e-5));
      float w = max(uRingWidth, 0.002) / max(uRingSize, 1e-5) * ext;
      float c = uRingChroma * 0.06;
      rgb = vTint * vec3(
        band(p, uRingBlades, 1.0 - c, w),
        band(p, uRingBlades, 1.0, w),
        band(p, uRingBlades, 1.0 + c, w)
      );
    } else {
      /* ---------------------------------------------------------------- */
      /* GHOST — an image of the iris                                      */
      /* ---------------------------------------------------------------- */
      float roundness = vShape.y;
      float c = vShape.z * 0.06;
      float fill = mix(uGhostFill, uGhostFill * 0.25, vShape.w);
      float rim = mix(uGhostRim, uGhostRim * 1.6, vShape.w);
      rgb = vTint * vec3(
        iris(vLocal, uGhostBlades, roundness, 1.0 - c, fill, rim),
        iris(vLocal, uGhostBlades, roundness, 1.0, fill, rim),
        iris(vLocal, uGhostBlades, roundness, 1.0 + c, fill, rim)
      );
    }

    rgb *= vAmp * uGlobalGlow * uShaderIntensity;
    rgb = shoulder(rgb, uHeadroom);

    /* Additive with alpha 1: three's AdditiveBlending is (SRC_ALPHA, ONE), so
     * writing the coverage into alpha as well would square it and quietly
     * darken every soft edge in the flare. */
    if (max(max(rgb.r, rgb.g), rgb.b) < 0.0008) discard;
    gl_FragColor = vec4(rgb, 1.0);
  }
`;

/* ---------------------------------------------------------------- */
/* Defaults                                                          */
/* ---------------------------------------------------------------- */

/**
 * Every canonical key, its default and its unit.
 *
 * As everywhere else in this library these are *not* an art direction — they
 * are the values that make a recognisable flare appear on the first frame so
 * the author has something to drag. Anything an ability leaves out of its
 * params bag falls back to here and stays there, which is the one way this
 * module can be used to break **I1**.
 */
const DEFAULTS = {
  /* --- master --- */
  intensity: 1, // multiplies every element
  opacity: 1, // fade the whole flare in and out
  seed: 0, // unitless dice roll: spike jitter, ghost scatter, streak grain
  headroom: 6, // linear-light ceiling of the hue-preserving shoulder

  /* --- occlusion (the point of the module) --- */
  occlusion: 1, // 0..1 — how much the depth test dims the flare
  occRadius: 0.02, // screen fraction — the source's apparent half-size
  occTaps: 7, // 1..9 kernel taps
  occFade: 0.6, // metres over which the depth compare feathers
  occSpin: 0, // radians — rotate the kernel off the pixel grid

  /* --- framing --- */
  edgeStart: 0.8, // |NDC| where the flare begins to fade out of frame
  edgeEnd: 1.35, // |NDC| where it is gone

  /* --- core + starburst --- */
  coreSize: 0.02, // fraction of frame height
  coreGlow: 2.4,
  burstBlades: 6, // iris blades; odd counts throw twice as many spikes
  burstLength: 0.12, // fraction of frame height
  burstSharp: 26, // spike sharpness exponent
  burstJitter: 0.35, // 0..1 per-spike length variation
  burstSpin: 0.35, // radians
  haloSize: 0.05, // fraction of frame height
  haloWidth: 0.35, // fraction of haloSize
  haloGlow: 0.7,

  /* --- anamorphic streak --- */
  streakLength: 0.3, // fraction of frame WIDTH, per side
  streakThickness: 0.014, // fraction of frame height
  streakFalloff: 2.2, // how fast it dies along its length
  streakTight: 9, // Gaussian tightness across it
  streakGlow: 1.3,
  streakTilt: 0, // radians off horizontal
  streakGrain: 0.35, // 0..1 along-length grain
  streakChroma: 0.7, // 0..1 mix toward colorStreakEdge at the ends

  /* --- ghost train --- */
  ghosts: 5, // 0..8
  ghostSpacing: 0.34, // first ghost, fraction of source→centre
  ghostStride: 0.3, // added per ghost; > 1 total crosses the centre
  ghostScatter: 0.1, // hashed jitter on the spacing
  ghostSize: 0.045, // fraction of frame height
  ghostSizeStep: 0.88, // multiplied per ghost
  ghostSizeScatter: 0.25,
  ghostBlades: 6, // ONE iris for the whole flare — see the module comment
  ghostRound: 0.1, // 0 polygon, 1 disc
  ghostRoundStep: 0.14, // added per ghost
  ghostSpin: 0.5, // radians per ghost
  ghostFill: 0.3, // interior brightness
  ghostRim: 0.9, // rim brightness
  ghostRimWidth: 0.14, // rim falloff, in apothems
  ghostSoft: 0.22, // edge softness of the fill
  ghostChroma: 0.5, // dispersion between the R and B evaluations
  ghostGlow: 1,

  /* --- iris ring --- */
  ring: 1, // 0 hides it
  ringSpacing: 1.15, // fraction of source→centre; > 1 is the far side
  ringSize: 0.26, // fraction of frame height
  ringWidth: 0.03, // fraction of frame height
  ringBlades: 6,
  ringChroma: 1, // dispersion across the band
  ringGlow: 0.45,

  /* --- colours: seven pickers, none derived --- */
  colorCore: '#fff4dc',
  colorHalo: '#ffd7a0',
  colorStreak: '#bfe4ff',
  colorStreakEdge: '#2f5cff',
  colorGhostA: '#ffd9a0',
  colorGhostB: '#ff7fae',
  colorGhostC: '#7fe0d0',
  colorGhostD: '#8fa8ff',
  colorRing: '#9fd8ff'
};

/** Every canonical key with its default. This function is the key list. */
export function lensFlareParams() {
  return { ...DEFAULTS };
}

const num = (v, d) => (v === undefined || v === null ? d : v);

/* ---------------------------------------------------------------- */
/* Scratch — module scope, reused, never allocated in a frame (I3)   */
/* ---------------------------------------------------------------- */

const _anchor = new Vector3();

/* ---------------------------------------------------------------- */
/* LensFlare                                                         */
/* ---------------------------------------------------------------- */

/**
 * ```js
 * const _f = lensFlareParams();                    // module scope — I3
 * const _p = new Vector3();
 *
 * this.flare = new LensFlare({ ghosts: 6 });
 * this.group.add(this.flare.object3D);
 * // …
 * onTravel(dt) {
 *   const c = settings.solarlens;
 *   this.flare.setAnchor(this.lensPoint(_p));      // world metres, this frame
 *   _f.intensity    = c.flareIntensity * this.charge;
 *   _f.occRadius    = c.flareOccRadius;            // screen fraction
 *   _f.ghosts       = c.flareGhosts;
 *   _f.streakLength = c.flareStreak;
 *   _f.colorCore    = c.colorFlareCore;
 *   this.flare.update(_f);
 *   this.flare.visible = this.charge > 0.01;
 * }
 * ```
 */
export class LensFlare {
  /**
   * @param {object}  [options]
   * @param {number}  [options.ghosts]      instances built for the ghost train.
   *        This is the *capacity*; `params.ghosts` is how many draw. Building
   *        fewer than you will ever ask for silently caps the slider.
   * @param {number}  [options.renderOrder] default 3000 — after the scene
   * @param {number}  [options.layer]       default `LAYER.VFX`
   * @param {string}  [options.name]
   */
  constructor({ ghosts = MAX_FLARE_GHOSTS, renderOrder = 3000, layer = LAYER.VFX, name } = {}) {
    /** How many ghost instances exist. `update()` cannot exceed it. */
    this.capacity = Math.max(0, Math.min(MAX_FLARE_GHOSTS, Math.round(ghosts)));

    const total = FIXED_INSTANCES + this.capacity;

    /* A 2×2 plane so `position.xy` is already the -1..1 quad coordinate the
     * shaders want; the base geometry is never rendered or uploaded itself. */
    const base = new PlaneGeometry(2, 2, 1, 1);
    const geometry = new InstancedBufferGeometry();
    geometry.index = base.index;
    geometry.setAttribute('position', base.attributes.position);
    geometry.setAttribute('uv', base.attributes.uv);

    const roles = new Float32Array(total);
    const slots = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      roles[i] = i < FIXED_INSTANCES ? i : FlareRole.GHOST;
      slots[i] = i < FIXED_INSTANCES ? 0 : i - FIXED_INSTANCES;
    }
    geometry.setAttribute('aRole', new InstancedBufferAttribute(roles, 1));
    geometry.setAttribute('aSlot', new InstancedBufferAttribute(slots, 1));
    geometry.instanceCount = total;
    this.geometry = geometry;

    this.material = new ShaderMaterial({
      name: name ? `${name}:flare` : 'LensFlare',
      transparent: true,
      // A lens artefact is in front of everything by definition. This is also
      // why the module has to do its own occlusion — see the header.
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      // Never let the renderer put a curve on this directly; the shoulder in
      // the fragment shader is the only compression the flare wants.
      toneMapped: false,
      uniforms: sharedUniforms({
        uAnchor: { value: new Vector3() },

        uOcclusion: { value: DEFAULTS.occlusion },
        uOccRadius: { value: DEFAULTS.occRadius },
        uOccTaps: { value: DEFAULTS.occTaps },
        uOccFade: { value: DEFAULTS.occFade },
        uOccSpin: { value: DEFAULTS.occSpin },

        uEdgeStart: { value: DEFAULTS.edgeStart },
        uEdgeEnd: { value: DEFAULTS.edgeEnd },
        uIntensity: { value: DEFAULTS.intensity },
        uOpacity: { value: DEFAULTS.opacity },
        uSeed: { value: DEFAULTS.seed },
        uHeadroom: { value: DEFAULTS.headroom },

        uCoreSize: { value: DEFAULTS.coreSize },
        uCoreGlow: { value: DEFAULTS.coreGlow },
        uBurstBlades: { value: DEFAULTS.burstBlades },
        uBurstLength: { value: DEFAULTS.burstLength },
        uBurstSharp: { value: DEFAULTS.burstSharp },
        uBurstJitter: { value: DEFAULTS.burstJitter },
        uBurstSpin: { value: DEFAULTS.burstSpin },
        uHaloSize: { value: DEFAULTS.haloSize },
        uHaloWidth: { value: DEFAULTS.haloWidth },
        uHaloGlow: { value: DEFAULTS.haloGlow },

        uStreakLength: { value: DEFAULTS.streakLength },
        uStreakThickness: { value: DEFAULTS.streakThickness },
        uStreakFalloff: { value: DEFAULTS.streakFalloff },
        uStreakTight: { value: DEFAULTS.streakTight },
        uStreakGlow: { value: DEFAULTS.streakGlow },
        uStreakTilt: { value: DEFAULTS.streakTilt },
        uStreakGrain: { value: DEFAULTS.streakGrain },
        uStreakChroma: { value: DEFAULTS.streakChroma },

        uGhostCount: { value: DEFAULTS.ghosts },
        uGhostSpacing: { value: DEFAULTS.ghostSpacing },
        uGhostStride: { value: DEFAULTS.ghostStride },
        uGhostScatter: { value: DEFAULTS.ghostScatter },
        uGhostSize: { value: DEFAULTS.ghostSize },
        uGhostSizeStep: { value: DEFAULTS.ghostSizeStep },
        uGhostSizeScatter: { value: DEFAULTS.ghostSizeScatter },
        uGhostBlades: { value: DEFAULTS.ghostBlades },
        uGhostRound: { value: DEFAULTS.ghostRound },
        uGhostRoundStep: { value: DEFAULTS.ghostRoundStep },
        uGhostSpin: { value: DEFAULTS.ghostSpin },
        uGhostFill: { value: DEFAULTS.ghostFill },
        uGhostRim: { value: DEFAULTS.ghostRim },
        uGhostRimWidth: { value: DEFAULTS.ghostRimWidth },
        uGhostSoft: { value: DEFAULTS.ghostSoft },
        uGhostChroma: { value: DEFAULTS.ghostChroma },
        uGhostGlow: { value: DEFAULTS.ghostGlow },

        uRing: { value: DEFAULTS.ring },
        uRingSpacing: { value: DEFAULTS.ringSpacing },
        uRingSize: { value: DEFAULTS.ringSize },
        uRingWidth: { value: DEFAULTS.ringWidth },
        uRingBlades: { value: DEFAULTS.ringBlades },
        uRingChroma: { value: DEFAULTS.ringChroma },
        uRingGlow: { value: DEFAULTS.ringGlow },

        uColorCore: { value: new Color(DEFAULTS.colorCore) },
        uColorHalo: { value: new Color(DEFAULTS.colorHalo) },
        uColorStreak: { value: new Color(DEFAULTS.colorStreak) },
        uColorStreakEdge: { value: new Color(DEFAULTS.colorStreakEdge) },
        uColorGhostA: { value: new Color(DEFAULTS.colorGhostA) },
        uColorGhostB: { value: new Color(DEFAULTS.colorGhostB) },
        uColorGhostC: { value: new Color(DEFAULTS.colorGhostC) },
        uColorGhostD: { value: new Color(DEFAULTS.colorGhostD) },
        uColorRing: { value: new Color(DEFAULTS.colorRing) }
      }),
      vertexShader: FLARE_VERTEX,
      fragmentShader: FLARE_FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = name || 'LensFlare';
    this.mesh.layers.set(layer);
    this.mesh.renderOrder = renderOrder;
    // Built in NDC: the bounding sphere is meaningless and the matrix is never
    // anything but identity.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;

    this._visible = false;
  }

  /** Add this to the ability's group. */
  get object3D() {
    return this.mesh;
  }

  /** One, always — every element is an instance of the same quad. */
  get drawCalls() {
    return 1;
  }

  get visible() {
    return this._visible;
  }

  set visible(v) {
    this._visible = !!v;
    this.mesh.visible = this._visible;
  }

  /** Pin the flare to a world point. Metres. */
  setAnchor(v) {
    this.material.uniforms.uAnchor.value.copy(v);
    return this;
  }

  /** Pin the flare to a world point, component-wise. */
  setAnchorXYZ(x, y, z) {
    this.material.uniforms.uAnchor.value.set(x, y, z);
    return this;
  }

  /** Where the flare currently hangs, for an ability that wants to read it back. */
  anchor(out = _anchor) {
    return out.copy(this.material.uniforms.uAnchor.value);
  }

  /**
   * Re-resolve everything. Call it every frame, including a zero-length one.
   *
   * Keys are exactly those of `lensFlareParams()`; anything omitted falls back
   * to the module default and *stays* there, which is the one way to break I1
   * with this module.
   *
   * @param {object} p a plain object. Keep it at module scope and refill it.
   */
  update(p) {
    const u = this.material.uniforms;

    u.uIntensity.value = num(p.intensity, DEFAULTS.intensity);
    u.uOpacity.value = num(p.opacity, DEFAULTS.opacity);
    u.uSeed.value = num(p.seed, DEFAULTS.seed);
    u.uHeadroom.value = num(p.headroom, DEFAULTS.headroom);

    /* README trap 7, inverted: with nothing bound to `uSceneDepth` the sampler
     * reads zeroes, `perspectiveDepthToViewZ(0)` lands on the near plane and
     * the kernel decides the flare is buried in a wall — the flare would simply
     * never appear, in the app *and* in any bespoke harness that skips the
     * prepass. Degrade by data rather than by branch: no buffer, no test. */
    const hasDepth = frame.uSceneDepth.value !== null && frame.uSceneDepth.value !== undefined;
    u.uOcclusion.value = hasDepth ? num(p.occlusion, DEFAULTS.occlusion) : 0;
    u.uOccRadius.value = num(p.occRadius, DEFAULTS.occRadius);
    u.uOccTaps.value = Math.max(1, Math.min(MAX_OCC_TAPS, num(p.occTaps, DEFAULTS.occTaps)));
    u.uOccFade.value = num(p.occFade, DEFAULTS.occFade);
    u.uOccSpin.value = num(p.occSpin, DEFAULTS.occSpin);

    u.uEdgeStart.value = num(p.edgeStart, DEFAULTS.edgeStart);
    u.uEdgeEnd.value = num(p.edgeEnd, DEFAULTS.edgeEnd);

    u.uCoreSize.value = num(p.coreSize, DEFAULTS.coreSize);
    u.uCoreGlow.value = num(p.coreGlow, DEFAULTS.coreGlow);
    u.uBurstBlades.value = num(p.burstBlades, DEFAULTS.burstBlades);
    u.uBurstLength.value = num(p.burstLength, DEFAULTS.burstLength);
    u.uBurstSharp.value = num(p.burstSharp, DEFAULTS.burstSharp);
    u.uBurstJitter.value = num(p.burstJitter, DEFAULTS.burstJitter);
    u.uBurstSpin.value = num(p.burstSpin, DEFAULTS.burstSpin);
    u.uHaloSize.value = num(p.haloSize, DEFAULTS.haloSize);
    u.uHaloWidth.value = num(p.haloWidth, DEFAULTS.haloWidth);
    u.uHaloGlow.value = num(p.haloGlow, DEFAULTS.haloGlow);

    u.uStreakLength.value = num(p.streakLength, DEFAULTS.streakLength);
    u.uStreakThickness.value = num(p.streakThickness, DEFAULTS.streakThickness);
    u.uStreakFalloff.value = num(p.streakFalloff, DEFAULTS.streakFalloff);
    u.uStreakTight.value = num(p.streakTight, DEFAULTS.streakTight);
    u.uStreakGlow.value = num(p.streakGlow, DEFAULTS.streakGlow);
    u.uStreakTilt.value = num(p.streakTilt, DEFAULTS.streakTilt);
    u.uStreakGrain.value = num(p.streakGrain, DEFAULTS.streakGrain);
    u.uStreakChroma.value = num(p.streakChroma, DEFAULTS.streakChroma);

    const ghosts = Math.max(0, Math.min(this.capacity, Math.round(num(p.ghosts, DEFAULTS.ghosts))));
    u.uGhostCount.value = ghosts;
    u.uGhostSpacing.value = num(p.ghostSpacing, DEFAULTS.ghostSpacing);
    u.uGhostStride.value = num(p.ghostStride, DEFAULTS.ghostStride);
    u.uGhostScatter.value = num(p.ghostScatter, DEFAULTS.ghostScatter);
    u.uGhostSize.value = num(p.ghostSize, DEFAULTS.ghostSize);
    u.uGhostSizeStep.value = num(p.ghostSizeStep, DEFAULTS.ghostSizeStep);
    u.uGhostSizeScatter.value = num(p.ghostSizeScatter, DEFAULTS.ghostSizeScatter);
    u.uGhostBlades.value = num(p.ghostBlades, DEFAULTS.ghostBlades);
    u.uGhostRound.value = num(p.ghostRound, DEFAULTS.ghostRound);
    u.uGhostRoundStep.value = num(p.ghostRoundStep, DEFAULTS.ghostRoundStep);
    u.uGhostSpin.value = num(p.ghostSpin, DEFAULTS.ghostSpin);
    u.uGhostFill.value = num(p.ghostFill, DEFAULTS.ghostFill);
    u.uGhostRim.value = num(p.ghostRim, DEFAULTS.ghostRim);
    u.uGhostRimWidth.value = num(p.ghostRimWidth, DEFAULTS.ghostRimWidth);
    u.uGhostSoft.value = num(p.ghostSoft, DEFAULTS.ghostSoft);
    u.uGhostChroma.value = num(p.ghostChroma, DEFAULTS.ghostChroma);
    u.uGhostGlow.value = num(p.ghostGlow, DEFAULTS.ghostGlow);

    u.uRing.value = num(p.ring, DEFAULTS.ring);
    u.uRingSpacing.value = num(p.ringSpacing, DEFAULTS.ringSpacing);
    u.uRingSize.value = num(p.ringSize, DEFAULTS.ringSize);
    u.uRingWidth.value = num(p.ringWidth, DEFAULTS.ringWidth);
    u.uRingBlades.value = num(p.ringBlades, DEFAULTS.ringBlades);
    u.uRingChroma.value = num(p.ringChroma, DEFAULTS.ringChroma);
    u.uRingGlow.value = num(p.ringGlow, DEFAULTS.ringGlow);

    copyColor(u.uColorCore.value, p.colorCore || DEFAULTS.colorCore);
    copyColor(u.uColorHalo.value, p.colorHalo || DEFAULTS.colorHalo);
    copyColor(u.uColorStreak.value, p.colorStreak || DEFAULTS.colorStreak);
    copyColor(u.uColorStreakEdge.value, p.colorStreakEdge || DEFAULTS.colorStreakEdge);
    copyColor(u.uColorGhostA.value, p.colorGhostA || DEFAULTS.colorGhostA);
    copyColor(u.uColorGhostB.value, p.colorGhostB || DEFAULTS.colorGhostB);
    copyColor(u.uColorGhostC.value, p.colorGhostC || DEFAULTS.colorGhostC);
    copyColor(u.uColorGhostD.value, p.colorGhostD || DEFAULTS.colorGhostD);
    copyColor(u.uColorRing.value, p.colorRing || DEFAULTS.colorRing);

    // Instances the ghost count has switched off never reach the rasteriser.
    this.geometry.instanceCount = FIXED_INSTANCES + ghosts;

    return this;
  }

  dispose() {
    this.visible = false;
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
