import {
  Mesh,
  ShaderMaterial,
  NormalBlending,
  AdditiveBlending,
  FrontSide,
  DoubleSide,
  Color,
  Vector2,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { uprightQuad } from './quads.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER, retainDistortion, releaseDistortion } from '../core/Layers.js';
import { settings } from '../config/settings.js';
import { copyColor } from '../utils/color.js';

/* ------------------------------------------------------------------------ */
/* Distortion — the pass that used to do nothing                            */
/* ------------------------------------------------------------------------ */
/**
 * Screen-space refraction emitters.
 *
 * `LAYER.DISTORTION` and its half-resolution buffer have existed since the
 * first build and the README has carried "the distortion pass runs with nothing
 * writing to it" as a known rough edge ever since. This module is the thing that
 * writes to it.
 *
 * ## What is in the buffer
 *
 * `PostProcessing._renderDistortion()` clears a half-res HalfFloat target to
 * `(0.5, 0.5, 0, 0)` — "no offset, no coverage" — and draws every visible mesh
 * on `LAYER.DISTORTION` into it. `DistortionShader` then resamples the composed
 * frame by whatever it finds:
 *
 * ```
 *   R,G  unit screen-space direction, encoded as d * 0.5 + 0.5
 *   B    magnitude, in screen widths at uScale = 1
 *   A    coverage — the blend weight between overlapping emitters
 * ```
 *
 * The offset the pass finally applies is `dir * B * settings.post.distortion *
 * settings.global.distortion`. **An emitter never multiplies the two global
 * gains in itself** — they are applied once, in the pass, so a writer that
 * forgets still obeys the master sliders and nothing double-applies them.
 *
 * ## The one rule
 *
 * Magnitudes are **screen fractions, not metres**. A fragment that writes
 * `B = 1` displaces the frame under it by a full `post.distortion` of screen
 * width no matter how far away the emitter is. That is a deliberate choice: it
 * makes an authored strength mean the same thing on every cast, and the thing
 * that *should* shrink with distance — the area being warped — already does,
 * because the emitter is real geometry. `perspective` (0..1) is there for the
 * cases where you disagree; heat shimmer usually does.
 *
 * ## The five emitters
 *
 * | mode | what it is |
 * | --- | --- |
 * | `HEAT`    | rising shimmer above a hot region, advected upward in world space, strongest at the source |
 * | `LENS`    | radial displacement going as 1/r² inside a falloff — a gravity well that bends the floor, the character and every particle behind it |
 * | `SHOCK`   | a travelling ring of compression then rarefaction, up to four concentric fronts |
 * | `BLADE`   | a razor-thin plane of pure refraction with a hairline at its cutting edge |
 * | `REFRACT` | a generic hull that refracts along its own normal — water, glass, prisms |
 *
 * ## Cost
 *
 * One draw call each, at half resolution, into a buffer nothing else reads.
 * A `BLADE` with `edge: true` is two, because the bright hairline is real
 * emissive geometry on `LAYER.VFX` and cannot live in an offset buffer.
 *
 * ## Invariants
 *
 * - **I1** — the field holds no dimensions. Everything in `update()` is
 *   re-resolved by the caller from `settings` every frame, zero-length frames
 *   included, and written straight into uniforms. Pause with **P**, drag a
 *   slider, and the standing warp changes.
 * - **I3** — `update()` writes numbers into existing uniform boxes. Nothing
 *   allocates. The quad geometry is a module-scope singleton shared by every
 *   emitter in the app.
 * - **I5** — every number below is a slider. There is one colour in the whole
 *   module (the blade's hairline) because an offset buffer has no colour.
 */

/* ---------------------------------------------------------------- */
/* Enums                                                             */
/* ---------------------------------------------------------------- */

export const DistortionMode = Object.freeze({
  HEAT: 0,
  LENS: 1,
  SHOCK: 2,
  BLADE: 3,
  REFRACT: 4
});

/**
 * How the emitter's quad is oriented. Everything except `WORLD` is built in the
 * vertex shader from `uAnchor` and the view matrix, so the mesh's own transform
 * stays identity and moving an emitter is a uniform write rather than a matrix
 * update — which is also what keeps it honest about **I1**.
 */
export const DistortionFacing = Object.freeze({
  /** Squarely at the camera. Lenses and shock fronts that read as spheres. */
  BILLBOARD: 'billboard',
  /** Local +Y is world up, local +X is camera-right flattened. Heat columns. */
  UPRIGHT: 'upright',
  /** Flat on the floor: local +X is world +X, local +Y is world +Z. */
  GROUND: 'ground',
  /** Placed by `setBasis()` — an arbitrary plane. Blades and panes. */
  WORLD: 'world'
});

const FACING_DEFINE = {
  [DistortionFacing.BILLBOARD]: 'DISTORT_FACE_BILLBOARD',
  [DistortionFacing.UPRIGHT]: 'DISTORT_FACE_UPRIGHT',
  [DistortionFacing.GROUND]: 'DISTORT_FACE_GROUND',
  [DistortionFacing.WORLD]: 'DISTORT_FACE_WORLD'
};

/* ---------------------------------------------------------------- */
/* Shaders                                                           */
/* ---------------------------------------------------------------- */

/**
 * The vertex shader does three jobs, and the third is the interesting one.
 *
 * 1. It *builds* the quad, rather than transforming one. `uAnchor` plus two
 *    world axes plus `uSize` in metres — so a heat column that is 0.6 m across
 *    and 2.4 m tall is two numbers, live, and the mesh matrix never changes.
 * 2. It carries `vLocal`, the fragment's offset from the anchor **in metres in
 *    the emitter's own plane**, which is what every radial mode measures against.
 * 3. It projects the anchor and the two unit axes into NDC and hands the results
 *    down as varyings.
 *
 * That third one deserves a note, because the obvious alternative is wrong. A
 * radial emitter needs, per fragment, the screen-space direction pointing away
 * from its centre. Interpolating a per-vertex "direction from centre" across the
 * quad gives a field that is only correct at the four corners and visibly wrong
 * in the middle. But a varying whose value is *identical at every vertex*
 * interpolates to exactly that value, perspective correction or not — so
 * projecting the anchor once and passing the constant, then differencing against
 * the fragment's own `vClip`, is exact everywhere for the price of one extra
 * matrix multiply. `vAxX` / `vAxY` are the same trick applied to the screen image
 * of one metre along each axis, which is what lets a plane-space wobble come out
 * pointing the right way on screen.
 */
const DISTORTION_VERTEX = /* glsl */ `
  uniform vec3 uAnchor;   // world position the emitter is pinned to
  uniform vec2 uSize;     // quad extent, metres (x across, y along local +Y)
  uniform vec2 uPivot;    // 0.5,0.5 centres the quad; 0.5,0.0 sits it on the anchor
  uniform vec3 uAxisX;    // WORLD facing only — unit, in the plane
  uniform vec3 uAxisY;    // WORLD facing only — unit, in the plane

  varying vec2  vUv;
  varying vec2  vLocal;    // metres from the anchor, in the emitter plane
  varying vec4  vClip;
  varying vec2  vCentre;   // the anchor in NDC — constant across the quad
  varying vec2  vAxX;      // screen-UV image of one metre along local +X
  varying vec2  vAxY;
  varying float vMetreUV;  // |vAxX| — screen UV per metre at the anchor's depth
  varying float vViewZ;    // negative, view space
  varying vec3  vWorld;
  varying vec3  vNormalV;  // view-space surface normal
  varying float vOnScreen; // 0 when the anchor is behind the eye

  void main() {
    vUv = uv;

    vec3 ax;
    vec3 ay;
    vec3 world;

    #ifdef DISTORT_HULL
      /* A real mesh with real normals: use its matrix as authored. */
      world = (modelMatrix * vec4(position, 1.0)).xyz;
      ax = normalize(mat3(modelMatrix) * vec3(1.0, 0.0, 0.0));
      ay = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
      vLocal = position.xy;
      vNormalV = normalize(mat3(viewMatrix) * mat3(modelMatrix) * normal);
    #else
      #if defined(DISTORT_FACE_BILLBOARD)
        // viewMatrix's rows are the camera's basis expressed in world space.
        ax = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        ay = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
      #elif defined(DISTORT_FACE_UPRIGHT)
        // Heat rises along world up whatever the camera is doing; only the
        // *roll* of the column follows the eye. A full billboard here makes a
        // plume lean over when you orbit, which reads as wind, not heat.
        vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        ay = vec3(0.0, 1.0, 0.0);
        vec3 planar = camRight - ay * dot(camRight, ay);
        ax = length(planar) > 1e-4 ? normalize(planar) : vec3(1.0, 0.0, 0.0);
      #elif defined(DISTORT_FACE_GROUND)
        ax = vec3(1.0, 0.0, 0.0);
        ay = vec3(0.0, 0.0, 1.0);
      #else
        ax = uAxisX;
        ay = uAxisY;
      #endif

      vec2 ext = (uv - uPivot) * uSize;
      world = uAnchor + ax * ext.x + ay * ext.y;
      vLocal = ext;
      vNormalV = normalize(mat3(viewMatrix) * normalize(cross(ax, ay)));
    #endif

    vWorld = world;
    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    vClip = projectionMatrix * mv;
    gl_Position = vClip;

    /* ---- the constant varyings: the anchor and its two unit axes, in NDC ---- */
    vec4 c0 = projectionMatrix * viewMatrix * vec4(uAnchor, 1.0);
    vec4 cx = projectionMatrix * viewMatrix * vec4(uAnchor + ax, 1.0);
    vec4 cy = projectionMatrix * viewMatrix * vec4(uAnchor + ay, 1.0);
    vOnScreen = step(0.001, c0.w);
    vCentre = c0.xy / max(c0.w, 0.001);
    vAxX = (cx.xy / max(cx.w, 0.001) - vCentre) * 0.5;
    vAxY = (cy.xy / max(cy.w, 0.001) - vCentre) * 0.5;
    vMetreUV = length(vAxX);
  }
`;

/**
 * One fragment shader, five emitters, selected by `#if DISTORT_MODE`.
 *
 * They share the tail — depth rejection, perspective, the encode — because the
 * tail is the part that has to agree with `DistortionShader` and there should be
 * exactly one copy of it in the project.
 */
const DISTORTION_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uShaderIntensity;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  /* --- shared --- */
  uniform float uStrength;      // screen widths at post.distortion = 1
  uniform float uOpacity;       // master coverage / fade-out, 0..1
  uniform float uSeed;          // per-cast dice roll, unitless
  uniform float uDepthReject;   // 0..1 — how hard opaque geometry in front cuts it
  uniform float uDepthFade;     // metres over which that rejection feathers
  uniform float uPerspective;   // 0 = screen fraction, 1 = shrink with distance
  uniform float uPerspectiveRef;// metres at which perspective = 1
  uniform float uPostScale;     // mirror of post.distortion × global.distortion

  /* --- radial (LENS, SHOCK) --- */
  uniform float uRadius;        // metres — the falloff edge
  uniform float uWindow;        // 0..1 of uRadius where the falloff starts
  uniform float uCore;          // 0..1 of uRadius — the 1/r² clamp
  uniform float uMaxOffset;     // hard ceiling on the magnitude
  uniform float uInvert;        // 0 = sample outward (safe), 1 = sample inward
  uniform float uFold;          // 0 = never let the image cross the centre
  uniform float uSwirl;         // tangential fraction — frame dragging

  /* --- SHOCK --- */
  uniform float uWave;          // wavefront radius, metres
  uniform float uThickness;     // metres from the front to the lobe peak
  uniform float uCompression;   // amplitude of the inner (negative) lobe
  uniform float uRarefaction;   // amplitude of the outer (positive) lobe
  uniform float uRings;         // 1..4 concentric fronts
  uniform float uRingGap;       // metres between them
  uniform float uRingDecay;     // per-ring amplitude falloff

  /* --- HEAT --- */
  uniform float uFrequency;     // cycles per metre
  uniform float uSpeed;         // metres per second the shimmer climbs
  uniform float uSourceBias;    // exponent — how hard it favours the base
  uniform float uSpread;        // how much the column opens out over its height
  uniform float uVertical;      // 0..1 how much of the wobble is up/down
  uniform float uFlicker;       // 0..1 amplitude of the second, slower clock

  /* --- BLADE --- */
  uniform float uCut;           // 0..1 how far along its length the blade has cut
  uniform float uGrazing;       // exponent on the edge-on path length
  uniform float uEdge;          // 0..1 of the height — the hairline's width
  uniform float uEdgeGain;      // how much harder the hairline warps than the body
  uniform float uWake;          // 0..1 of the height the wake survives to

  /* --- BLADE + REFRACT --- */
  uniform float uRipple;        // amplitude of the normal perturbation
  uniform float uRippleScale;   // cycles per metre
  uniform float uRippleSpeed;   // metres per second

  /* --- REFRACT --- */
  uniform float uPower;         // rim exponent; 0 = flat across the hull

  varying vec2  vUv;
  varying vec2  vLocal;
  varying vec4  vClip;
  varying vec2  vCentre;
  varying vec2  vAxX;
  varying vec2  vAxY;
  varying float vMetreUV;
  varying float vViewZ;
  varying vec3  vWorld;
  varying vec3  vNormalV;
  varying float vOnScreen;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    vec2 ndc = vClip.xy / vClip.w;
    vec2 screenUV = ndc * 0.5 + 0.5;

    /* Offset from the anchor in screen UV. Exact, see the vertex shader. */
    vec2 fromCentre = (ndc - vCentre) * 0.5;
    float screenR = length(fromCentre);
    vec2 radial = screenR > 1e-5 ? fromCentre / screenR : vec2(1.0, 0.0);

    vec2 dir = vec2(0.0);
    float mag = 0.0;
    float mask = 1.0;

  #if DISTORT_MODE == 0
    /* ---------------------------------------------------------------- */
    /* HEAT — shimmer rising off something hot                           */
    /* ---------------------------------------------------------------- */
    /* The noise is sampled in **world** space and scrolled downward in it, so
     * the shimmer is advected up through a column that stands still: orbiting
     * the camera does not drag the pattern along, which is the tell that gives
     * a screen-space heat haze away instantly.
     *
     * The column widens with height rather than being a rectangle of wobble,
     * because hot air entrains cold air and the plume opens out. And it is
     * biased hard toward the base — uSourceBias — because the whole read is
     * "this is coming off *that*". A plume of even strength top to bottom looks
     * like fog. */
    float h = vUv.y;
    float halfW = 0.5 * (1.0 + uSpread * h);
    float lateral = (vUv.x - 0.5) / max(halfW, 1e-3);
    mask = (1.0 - smoothstep(0.5, 1.0, abs(lateral))) * (1.0 - smoothstep(0.35, 1.0, h));

    vec3 np = vec3(
      vWorld.xz * uFrequency,
      vWorld.y * uFrequency * 0.55 - uTime * uSpeed * uFrequency + uSeed
    );
    vec2 wob = vec2(fbm3(np), fbm3(np + vec3(31.7, 11.3, 5.9)) * uVertical);

    /* Orientation from the plane's screen image, magnitude from the slider —
     * mixing the two would make the warp weaker as the camera pulls back, which
     * is what uPerspective is for and should not be automatic. */
    vec2 screenOff = wob.x * vAxX + wob.y * vAxY;
    float sl = length(screenOff);
    dir = sl > 1e-7 ? screenOff / sl : vec2(0.0);
    mag = uStrength * min(length(wob), 1.5);
    mag *= pow(max(1.0 - h, 1e-4), uSourceBias);
    mag *= 1.0 + uFlicker * sin(uTime * 7.3 + vWorld.y * 2.1 + uSeed * 6.0);
  #endif

  #if DISTORT_MODE == 1
    /* ---------------------------------------------------------------- */
    /* LENS — a gravity well                                             */
    /* ---------------------------------------------------------------- */
    /* Magnitude goes as 1/r² in the emitter's own plane, measured in metres, so
     * the well keeps its physical size when the camera moves. Two things stop
     * it being a divide-by-zero with a hole in the middle:
     *
     *  - uCore clamps the denominator, so the centre is a finite, very strong
     *    smear rather than NaN. Below about 0.08 the core samples so far out
     *    that it reads as a mirror; that is a look, and it is a slider.
     *  - uFold guards the *inverted* case. Sampling outward (the default) can
     *    only ever run off the edge of the frame. Sampling inward runs the
     *    sample point through the centre and out the other side, which flips the
     *    image — real, and occasionally wanted, but never by accident. With
     *    uFold at 0 the magnitude is clamped to exactly the screen distance
     *    back to the centre, using the post pass's own gain, so the core packs
     *    down to a point and stops.
     */
    float rm = length(vLocal);
    float rn = rm / max(uRadius, 1e-3);
    mask = 1.0 - smoothstep(uWindow, 1.0, rn);

    float denom = max(rn * rn, uCore * uCore);
    mag = min(uStrength / denom, uMaxOffset);

    vec2 tangent = vec2(-radial.y, radial.x);
    dir = normalize(radial + tangent * uSwirl);
    dir *= uInvert > 0.5 ? -1.0 : 1.0;

    float inward = max(-dot(dir, radial), 1e-3);
    float foldLimit = screenR * 0.98 / max(uPostScale * inward, 1e-4);
    mag = mix(min(mag, foldLimit), mag, clamp(uFold, 0.0, 1.0));
  #endif

  #if DISTORT_MODE == 2
    /* ---------------------------------------------------------------- */
    /* SHOCK — a travelling pressure front                               */
    /* ---------------------------------------------------------------- */
    /* The profile is the derivative of a Gaussian, d·exp(0.5 − d²), which is
     * ±1 at d = ∓1/√2 and crosses zero exactly on the wavefront. That single
     * expression gives compression just inside the front and rarefaction just
     * outside it with no seam between them — the first version used two
     * smoothsteps back to back and the join was visible as a stationary ring
     * inside a moving one.
     *
     * uWave is a metre, so the ability resolves it from settings every frame:
     * dragging the ring's speed while paused moves a front that is standing. */
    float rm2 = length(vLocal);
    float rn2 = rm2 / max(uRadius, 1e-3);
    mask = 1.0 - smoothstep(uWindow, 1.0, rn2);

    float acc = 0.0;
    for (int i = 0; i < 4; i++) {
      if (float(i) >= uRings) break;
      float r0 = uWave - float(i) * uRingGap;
      if (r0 <= 0.0) continue;
      float d = (rm2 - r0) / max(uThickness, 1e-3);
      float g = d * exp(0.5 - d * d);
      acc += g * (g < 0.0 ? uCompression : uRarefaction) / (1.0 + float(i) * uRingDecay);
    }

    mag = min(abs(uStrength * acc), uMaxOffset);
    dir = radial * (acc < 0.0 ? -1.0 : 1.0);
  #endif

  #if DISTORT_MODE == 3
    /* ---------------------------------------------------------------- */
    /* BLADE — a plane of vacuum                                         */
    /* ---------------------------------------------------------------- */
    /* A razor-thin slab shifts what is behind it along its own surface normal,
     * and the shift goes up as the view runs along the slab because that is
     * where the path through it is longest. So the whole effect is
     * normal projected to screen × (1 − |N·V|)^grazing, and the reason you see
     * a vacuum blade at all is that you are almost never looking squarely at it.
     *
     * uCut extends it along its own length: the blade is not scaled, it is
     * *drawn further*, so the wake it has already opened stays where it was. */
    float along = vUv.x;
    float across = 1.0 - vUv.y;   // 0 at the cutting edge, 1 at the trailing edge

    mask = smoothstep(0.0, 0.05, along) * (1.0 - smoothstep(uCut - 0.06, uCut + 0.01, along));
    mask *= 1.0 - smoothstep(uWake * 0.55, uWake, across);

    vec3 nv = vNormalV;
    vec2 nScreen = nv.xy;

    vec3 rp = vec3(vWorld.xz * uRippleScale, vWorld.y * uRippleScale - uTime * uRippleSpeed);
    nScreen += vec2(fbm3(rp), fbm3(rp + vec3(7.3, 19.7, 2.9))) * uRipple;

    float nl = length(nScreen);
    dir = nl > 1e-6 ? nScreen / nl : vec2(0.0);

    float graze = pow(clamp(1.0 - abs(nv.z), 0.0, 1.0), uGrazing);
    float hairline = exp(-across / max(uEdge, 1e-3));
    mag = uStrength * graze * (1.0 + uEdgeGain * hairline);
  #endif

  #if DISTORT_MODE == 4
    /* ---------------------------------------------------------------- */
    /* REFRACT — a hull that bends what is behind it                     */
    /* ---------------------------------------------------------------- */
    /* The generic one: water, glass, a prism, a pane of frozen time. The offset
     * is the surface normal in **view** space, whose xy *is* the screen-space
     * direction the refracted ray leaves in, weighted by a rim term so the
     * silhouette bends hardest — which is what a solid of any real index of
     * refraction actually does.
     *
     * uPower = 0 flattens the rim term to 1 and the hull becomes a uniform
     * offset, which is the pane-of-glass look. */
    vec3 hn = gl_FrontFacing ? vNormalV : -vNormalV;

    vec3 wp = vec3(vWorld.xz * uRippleScale, vWorld.y * uRippleScale - uTime * uRippleSpeed);
    vec2 raw = hn.xy + vec2(fbm3(wp), fbm3(wp + vec3(23.1, 4.7, 17.5))) * uRipple;

    float rl = length(raw);
    dir = rl > 1e-6 ? raw / rl : vec2(0.0);

    float rim = pow(clamp(1.0 - abs(hn.z), 0.0, 1.0), uPower);
    mag = uStrength * rim * min(rl, 2.0);
  #endif

    /* ---------------------------------------------------------------- */
    /* Shared tail                                                       */
    /* ---------------------------------------------------------------- */

    /* The distortion buffer has no depth of its own — nothing else renders into
     * it — so an emitter behind a pillar would happily warp the pillar. The
     * opaque depth prepass is already sitting in uSceneDepth for the soft
     * particles, and it costs one sample to use it here too. This is the only
     * occlusion the pass gets, and it is why the character stops shimmering the
     * moment they walk in front of the flame. */
    float occluded = softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uDepthFade);
    mask *= mix(1.0, occluded, clamp(uDepthReject, 0.0, 1.0));

    mag *= mix(1.0, clamp(uPerspectiveRef / max(-vViewZ, 0.05), 0.0, 4.0), uPerspective);
    mag = clamp(mag * uShaderIntensity, 0.0, 8.0);

    float alpha = clamp(mask * uOpacity, 0.0, 1.0) * vOnScreen;

    /* Blending costs more than the fragment does at this point. */
    if (alpha * mag < 0.0004) discard;

    gl_FragColor = vec4(clamp(dir, -1.0, 1.0) * 0.5 + 0.5, mag, alpha);
  }
`;

/**
 * The blade's hairline.
 *
 * An offset buffer cannot carry colour, so the one thing a vacuum blade *is*
 * allowed to emit — the white line at its cutting edge — has to be a second
 * mesh on `LAYER.VFX`. It shares the anchor, size, pivot, axis and cut uniform
 * boxes with the distortion material by identity, so `update()` writes them once
 * and both passes see the same plane. Two draw calls, welded together for free.
 */
const BLADE_EDGE_FRAGMENT = /* glsl */ `
  uniform vec3  uColorEdge;
  uniform float uEdgeGlow;
  uniform float uEdge;
  uniform float uCut;
  uniform float uOpacity;
  uniform float uGlobalGlow;

  varying vec2 vUv;

  void main() {
    float along = vUv.x;
    float across = 1.0 - vUv.y;
    float line = exp(-across / max(uEdge * 0.35, 1e-4));
    float ends = smoothstep(0.0, 0.03, along) * (1.0 - smoothstep(uCut - 0.05, uCut, along));
    float a = line * ends * uOpacity;
    if (a < 0.002) discard;
    gl_FragColor = vec4(uColorEdge * uEdgeGlow * uGlobalGlow * a, a);
  }
`;

/* ---------------------------------------------------------------- */
/* Defaults                                                          */
/* ---------------------------------------------------------------- */

/**
 * Every uniform's neutral value.
 *
 * These are *not* an art direction — they are the values that make the emitter
 * visible and stable so an ability author can see something on the first frame
 * and then author every one of them as a slider. Anything an ability leaves out
 * of its `update()` bag falls back to here and stays there, which is the one
 * way this module can be used to violate **I1**. Don't.
 */
const DEFAULTS = {
  strength: 0.35,
  opacity: 1,
  seed: 0,
  depthReject: 1,
  depthFade: 0.35,
  perspective: 0,
  perspectiveRef: 12,

  /* radial */
  radius: 3,
  window: 0.55,
  core: 0.16,
  maxOffset: 1.6,
  invert: 0,
  fold: 0,
  swirl: 0,

  /* shock */
  wave: 1,
  thickness: 0.45,
  compression: 1,
  rarefaction: 0.7,
  rings: 1,
  ringGap: 0.9,
  ringDecay: 0.8,

  /* heat */
  frequency: 1.1,
  speed: 1.4,
  sourceBias: 1.4,
  spread: 0.8,
  vertical: 0.35,
  flicker: 0.25,

  /* blade */
  cut: 1,
  grazing: 1.5,
  edge: 0.06,
  edgeGain: 2.2,
  wake: 1,
  edgeGlow: 3,
  edgeColor: '#ffffff',

  /* blade + refract */
  ripple: 0,
  rippleScale: 1.6,
  rippleSpeed: 1.2,

  /* refract */
  power: 1.6
};

/** Pivot per mode: a heat column sits *on* its anchor, everything else centres. */
const PIVOT = {
  [DistortionMode.HEAT]: [0.5, 0],
  [DistortionMode.LENS]: [0.5, 0.5],
  [DistortionMode.SHOCK]: [0.5, 0.5],
  [DistortionMode.BLADE]: [0, 0.5],
  [DistortionMode.REFRACT]: [0.5, 0.5]
};

const num = (v, d) => (v === undefined || v === null ? d : v);

/* ---------------------------------------------------------------- */
/* Scratch — module scope, reused, never allocated in a frame (I3)   */
/* ---------------------------------------------------------------- */

const _ax = new Vector3();
const _ay = new Vector3();
const _n = new Vector3();

/* ---------------------------------------------------------------- */
/* DistortionField                                                   */
/* ---------------------------------------------------------------- */

/**
 * One emitter. Add `field.object3D` to your ability's group, call
 * `setAnchor()` / `setBasis()` and `update()` every frame, and toggle
 * `field.visible`.
 *
 * ```js
 * const _p = new Vector3();
 * const _d = {};                                   // module scope — I3
 *
 * this.haze = new DistortionField({ mode: DistortionMode.HEAT });
 * this.group.add(this.haze.object3D);
 * // …
 * onTravel(dt) {
 *   const c = settings.sunspear;
 *   this.haze.setAnchor(this.pointAt(this.u, _p));
 *   _d.width = c.hazeWidth;                        // metres, resolved this frame
 *   _d.height = c.hazeHeight;
 *   _d.strength = c.hazeStrength * (1 - this.u * c.hazeDecay);
 *   this.haze.update(_d);
 * }
 * ```
 */
export class DistortionField {
  /**
   * @param {object}   options
   * @param {number}   options.mode      one of `DistortionMode`
   * @param {string}  [options.facing]   one of `DistortionFacing`; defaults per mode
   * @param {THREE.BufferGeometry} [options.geometry]
   *        a hull for `REFRACT`. Supplying one switches the emitter to using the
   *        mesh's own matrix and normals, and `object3D` becomes something you
   *        position and scale in the ordinary way.
   * @param {boolean} [options.edge]     `BLADE` only — also draw the bright hairline
   * @param {number}  [options.renderOrder] within the distortion pass, later wins
   * @param {string}  [options.name]
   */
  constructor({ mode = DistortionMode.HEAT, facing, geometry = null, edge = false, renderOrder = 0, name } = {}) {
    this.mode = mode;
    this.isHull = geometry !== null;
    this.facing =
      facing ||
      (this.isHull
        ? DistortionFacing.WORLD
        : mode === DistortionMode.HEAT
          ? DistortionFacing.UPRIGHT
          : mode === DistortionMode.BLADE
            ? DistortionFacing.WORLD
            : DistortionFacing.BILLBOARD);

    const pivot = PIVOT[mode] || [0.5, 0.5];

    /* Uniform boxes the blade's edge pass shares by identity. */
    this._shared = {
      uAnchor: { value: new Vector3() },
      uSize: { value: new Vector2(1, 1) },
      uPivot: { value: new Vector2(pivot[0], pivot[1]) },
      uAxisX: { value: new Vector3(1, 0, 0) },
      uAxisY: { value: new Vector3(0, 1, 0) },
      uCut: { value: DEFAULTS.cut },
      uEdge: { value: DEFAULTS.edge },
      uOpacity: { value: DEFAULTS.opacity }
    };

    this.material = new ShaderMaterial({
      name: name ? `${name}:distortion` : 'DistortionField',
      transparent: true,
      depthWrite: false,
      // Nothing else renders into the offset buffer, so there is no depth to
      // test against. Occlusion comes from the prepass in the fragment shader.
      depthTest: false,
      blending: NormalBlending,
      side: this.isHull ? FrontSide : DoubleSide,
      toneMapped: false,
      defines: {
        DISTORT_MODE: String(mode),
        [FACING_DEFINE[this.facing]]: '',
        ...(this.isHull ? { DISTORT_HULL: '' } : {})
      },
      uniforms: sharedUniforms({
        ...this._shared,

        uStrength: { value: DEFAULTS.strength },
        uSeed: { value: DEFAULTS.seed },
        uDepthReject: { value: DEFAULTS.depthReject },
        uDepthFade: { value: DEFAULTS.depthFade },
        uPerspective: { value: DEFAULTS.perspective },
        uPerspectiveRef: { value: DEFAULTS.perspectiveRef },
        uPostScale: { value: 0.045 },

        uRadius: { value: DEFAULTS.radius },
        uWindow: { value: DEFAULTS.window },
        uCore: { value: DEFAULTS.core },
        uMaxOffset: { value: DEFAULTS.maxOffset },
        uInvert: { value: DEFAULTS.invert },
        uFold: { value: DEFAULTS.fold },
        uSwirl: { value: DEFAULTS.swirl },

        uWave: { value: DEFAULTS.wave },
        uThickness: { value: DEFAULTS.thickness },
        uCompression: { value: DEFAULTS.compression },
        uRarefaction: { value: DEFAULTS.rarefaction },
        uRings: { value: DEFAULTS.rings },
        uRingGap: { value: DEFAULTS.ringGap },
        uRingDecay: { value: DEFAULTS.ringDecay },

        uFrequency: { value: DEFAULTS.frequency },
        uSpeed: { value: DEFAULTS.speed },
        uSourceBias: { value: DEFAULTS.sourceBias },
        uSpread: { value: DEFAULTS.spread },
        uVertical: { value: DEFAULTS.vertical },
        uFlicker: { value: DEFAULTS.flicker },

        uGrazing: { value: DEFAULTS.grazing },
        uEdgeGain: { value: DEFAULTS.edgeGain },
        uWake: { value: DEFAULTS.wake },

        uRipple: { value: DEFAULTS.ripple },
        uRippleScale: { value: DEFAULTS.rippleScale },
        uRippleSpeed: { value: DEFAULTS.rippleSpeed },

        uPower: { value: DEFAULTS.power }
      }),
      vertexShader: DISTORTION_VERTEX,
      fragmentShader: DISTORTION_FRAGMENT
    });

    this.mesh = new Mesh(geometry || uprightQuad(), this.material);
    this.mesh.name = name || 'DistortionField';
    this.mesh.layers.set(LAYER.DISTORTION);
    this.mesh.renderOrder = renderOrder;
    // The quad is built from uniforms, so its bounding sphere is a lie.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = this.isHull;
    this.mesh.visible = false;

    /** The blade's bright hairline, or null. */
    this.edgeMaterial = null;
    this.edgeMesh = null;
    if (edge && mode === DistortionMode.BLADE) {
      this.edgeMaterial = new ShaderMaterial({
        name: name ? `${name}:edge` : 'DistortionBladeEdge',
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: AdditiveBlending,
        side: DoubleSide,
        toneMapped: false,
        defines: { DISTORT_MODE: String(mode), [FACING_DEFINE[this.facing]]: '' },
        uniforms: sharedUniforms({
          ...this._shared,
          uColorEdge: { value: new Color(DEFAULTS.edgeColor) },
          uEdgeGlow: { value: DEFAULTS.edgeGlow }
        }),
        vertexShader: DISTORTION_VERTEX,
        fragmentShader: BLADE_EDGE_FRAGMENT
      });
      this.edgeMesh = new Mesh(uprightQuad(), this.edgeMaterial);
      this.edgeMesh.name = `${name || 'DistortionField'}:edge`;
      this.edgeMesh.layers.set(LAYER.VFX);
      this.edgeMesh.renderOrder = 14;
      this.edgeMesh.frustumCulled = false;
      this.edgeMesh.matrixAutoUpdate = false;
      this.edgeMesh.visible = false;
      this.mesh.add(this.edgeMesh);
    }

    this._visible = false;
  }

  /** Add this to the ability's group. */
  get object3D() {
    return this.mesh;
  }

  /**
   * Visible emitters are counted so `PostProcessing` can skip the whole pass —
   * clear included — on frames where nothing is warping anything. That was the
   * documented cost of the rough edge this module closes; leaving it in place
   * while *also* adding writers would be a poor trade.
   */
  get visible() {
    return this._visible;
  }

  set visible(v) {
    const on = !!v;
    if (on === this._visible) return;
    this._visible = on;
    this.mesh.visible = on;
    if (this.edgeMesh) this.edgeMesh.visible = on;
    if (on) retainDistortion();
    else releaseDistortion();
  }

  /** Pin the emitter to a world point. Metres. */
  setAnchor(v) {
    this._shared.uAnchor.value.copy(v);
    return this;
  }

  /** Pin the emitter to a world point, component-wise. */
  setAnchorXYZ(x, y, z) {
    this._shared.uAnchor.value.set(x, y, z);
    return this;
  }

  /**
   * Orient a `WORLD`-facing emitter without touching a matrix.
   *
   * @param {THREE.Vector3} along  the plane's local +X, e.g. the cast heading
   * @param {THREE.Vector3} up     the plane's local +Y, e.g. world up
   *
   * `up` is re-orthogonalised against `along`, so passing the world up vector
   * for a blade that is leaning downrange does the right thing.
   */
  setBasis(along, up) {
    _ax.copy(along).normalize();
    _n.crossVectors(_ax, up).normalize();
    _ay.crossVectors(_n, _ax).normalize();
    this._shared.uAxisX.value.copy(_ax);
    this._shared.uAxisY.value.copy(_ay);
    return this;
  }

  /**
   * Re-resolve every dimension. Call it every frame, including on a zero-length
   * one — that is the whole contract (**I1**).
   *
   * Keys, all optional, all falling back to `DEFAULTS`:
   *
   * *shared* — `width` `height` (metres, the quad), `strength` (screen widths at
   * `post.distortion = 1`), `opacity`, `seed`, `depthReject`, `depthFade`
   * (metres), `perspective`, `perspectiveRef` (metres).
   *
   * *LENS / SHOCK* — `radius` (metres), `window` (0..1 of radius),
   * `maxOffset`.
   *
   * *LENS* — `core` (0..1 of radius, the 1/r² clamp), `invert`, `fold`, `swirl`.
   *
   * *SHOCK* — `wave` (metres, the wavefront), `thickness` (metres),
   * `compression`, `rarefaction`, `rings` (1..4), `ringGap` (metres),
   * `ringDecay`.
   *
   * *HEAT* — `frequency` (cycles/m), `speed` (m/s), `sourceBias`, `spread`,
   * `vertical`, `flicker`.
   *
   * *BLADE* — `cut` (0..1), `grazing`, `edge` (0..1 of height), `edgeGain`,
   * `wake` (0..1 of height), plus `edgeColor` and `edgeGlow` when the hairline
   * is enabled.
   *
   * *BLADE / REFRACT* — `ripple`, `rippleScale` (cycles/m), `rippleSpeed` (m/s).
   *
   * *REFRACT* — `power` (rim exponent; 0 is a flat pane).
   *
   * @param {object} p a plain object. Keep it at module scope and refill it.
   */
  update(p) {
    const u = this.material.uniforms;
    const s = this._shared;

    if (!this.isHull) {
      s.uSize.value.set(num(p.width, 1), num(p.height, 1));
    }

    s.uOpacity.value = num(p.opacity, DEFAULTS.opacity);
    s.uCut.value = num(p.cut, DEFAULTS.cut);
    s.uEdge.value = num(p.edge, DEFAULTS.edge);

    u.uStrength.value = num(p.strength, DEFAULTS.strength);
    u.uSeed.value = num(p.seed, DEFAULTS.seed);
    u.uDepthReject.value = num(p.depthReject, DEFAULTS.depthReject);
    u.uDepthFade.value = num(p.depthFade, DEFAULTS.depthFade);
    u.uPerspective.value = num(p.perspective, DEFAULTS.perspective);
    u.uPerspectiveRef.value = num(p.perspectiveRef, DEFAULTS.perspectiveRef);

    // The fold guard needs the exact gain the post pass will apply, and the
    // post pass is the only place the two global multipliers live. Reading them
    // here — rather than baking them into `strength` — is what keeps the guard
    // exact when someone drags `global.distortion`.
    u.uPostScale.value = settings.post.distortion * settings.global.distortion;

    u.uRadius.value = num(p.radius, DEFAULTS.radius);
    u.uWindow.value = num(p.window, DEFAULTS.window);
    u.uCore.value = num(p.core, DEFAULTS.core);
    u.uMaxOffset.value = num(p.maxOffset, DEFAULTS.maxOffset);
    u.uInvert.value = num(p.invert, DEFAULTS.invert);
    u.uFold.value = num(p.fold, DEFAULTS.fold);
    u.uSwirl.value = num(p.swirl, DEFAULTS.swirl);

    u.uWave.value = num(p.wave, DEFAULTS.wave);
    u.uThickness.value = num(p.thickness, DEFAULTS.thickness);
    u.uCompression.value = num(p.compression, DEFAULTS.compression);
    u.uRarefaction.value = num(p.rarefaction, DEFAULTS.rarefaction);
    u.uRings.value = num(p.rings, DEFAULTS.rings);
    u.uRingGap.value = num(p.ringGap, DEFAULTS.ringGap);
    u.uRingDecay.value = num(p.ringDecay, DEFAULTS.ringDecay);

    u.uFrequency.value = num(p.frequency, DEFAULTS.frequency);
    u.uSpeed.value = num(p.speed, DEFAULTS.speed);
    u.uSourceBias.value = num(p.sourceBias, DEFAULTS.sourceBias);
    u.uSpread.value = num(p.spread, DEFAULTS.spread);
    u.uVertical.value = num(p.vertical, DEFAULTS.vertical);
    u.uFlicker.value = num(p.flicker, DEFAULTS.flicker);

    u.uGrazing.value = num(p.grazing, DEFAULTS.grazing);
    u.uEdgeGain.value = num(p.edgeGain, DEFAULTS.edgeGain);
    u.uWake.value = num(p.wake, DEFAULTS.wake);

    u.uRipple.value = num(p.ripple, DEFAULTS.ripple);
    u.uRippleScale.value = num(p.rippleScale, DEFAULTS.rippleScale);
    u.uRippleSpeed.value = num(p.rippleSpeed, DEFAULTS.rippleSpeed);

    u.uPower.value = num(p.power, DEFAULTS.power);

    if (this.edgeMaterial) {
      const e = this.edgeMaterial.uniforms;
      copyColor(e.uColorEdge.value, p.edgeColor || DEFAULTS.edgeColor);
      e.uEdgeGlow.value = num(p.edgeGlow, DEFAULTS.edgeGlow);
    }

    return this;
  }

  dispose() {
    this.visible = false;
    this.material.dispose();
    this.edgeMaterial?.dispose();
    // The quad is a shared singleton; a supplied hull belongs to its owner.
    this.mesh.parent?.remove(this.mesh);
  }
}
