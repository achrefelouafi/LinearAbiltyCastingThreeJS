import {
  Mesh,
  ShaderMaterial,
  NormalBlending,
  DoubleSide,
  WebGLRenderTarget,
  HalfFloatType,
  LinearFilter,
  PerspectiveCamera,
  Matrix4,
  Frustum,
  Sphere,
  Plane,
  Color,
  Vector2,
  Vector3,
  Vector4
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { uprightQuad } from './quads.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { copyColor } from '../utils/color.js';

/* ------------------------------------------------------------------------ */
/* Mirror — a planar surface that reflects the real scene                    */
/* ------------------------------------------------------------------------ */
/**
 * A flat reflector: a camera mirrored about the surface's plane renders the
 * `WORLD` layer into a small target, and the surface samples that target
 * projectively.
 *
 * Two abilities need this and neither of them is served by faking it.
 * `blackice` is *the* reflective surface in the sandbox and the entire read is
 * "that is the actual room, upside down, sharpening as it freezes".
 * `refractcascade` bounces a beam between floating panes and the roster line is
 * blunt about it: fake it with an environment map and it reads as chrome; do it
 * properly and it reads as glass. The reason is that an env map has no
 * *parallax* — the reflection does not slide across the surface as you orbit,
 * and the brain reads a static reflection as a painted-on shine within about
 * half a second of camera movement.
 *
 * ## What it costs, honestly
 *
 * A rendering mirror is **one extra `renderer.render()` of the `WORLD` layer
 * per frame**. Not a cheap pass — a whole scene traversal, render list, sort
 * and draw. What it is *not* is a whole frame: no post stack, no depth prepass,
 * no distortion pass, no VFX layer, no shadow-map update (the nested render
 * turns `shadowMap.autoUpdate` off and reuses the maps the main pass already
 * built, which is both faster and correct — the shadows in a reflection are the
 * same shadows).
 *
 * The measurable numbers, which the module reports rather than estimates:
 * `mirrorBudget.calls` and `mirrorBudget.triangles` are read straight out of
 * `renderer.info` immediately after each nested render, so a mirror will tell
 * you what it actually cost on this machine in this scene. The arithmetic ones:
 * at the default 384² a reflection is 147,456 pixels, which is 16% of a 720p
 * frame and 7% of a 1080p one, and its target is 384 × 384 × RGBA16F = 1.13 MB
 * of colour plus a depth attachment, so roughly 1.7 MB per live mirror.
 *
 * Two caveats worth having in writing:
 *
 *  - **`renderer.info` is contaminated on a mirror frame.** `render()` resets
 *    the counters at the top of every call, so a nested render wipes whatever
 *    the outer frame had accumulated so far. Anything reading `info.render.calls`
 *    for a HUD will under-report on frames where a mirror rendered. That is
 *    also exactly why the module publishes its own numbers.
 *  - A mirror is a **fill** cost as well as a draw cost, and the fill is the
 *    part that scales with `resolution`. Halving the resolution slider quarters
 *    the pixels and changes the draw-call count not at all.
 *
 * ## The budget, and the discipline it copies
 *
 * `core/Layers.js#distortionWriters` counts the meshes currently visible on the
 * distortion layer so `PostProcessing` can skip that pass — clear included —
 * whenever nothing is writing to it. The lesson is that a pass that runs when
 * it has nothing to do is worse than no pass at all, and this module inherits
 * it in two ways.
 *
 * The first is structural: a mirror's reflection is rendered from the mesh's
 * own `onBeforeRender`, which the renderer calls only for a mesh that is
 * visible and in the render list. **No visible mirror, no pass at all** —
 * there is nothing to skip, because there is nothing to run. That is also why
 * this module needs no wiring into `App` or `PostProcessing`: the renderer
 * hands `onBeforeRender` the renderer, the scene and the camera, which is
 * everything the reflection needs, and a module in `src/vfx/` never has to be
 * given a renderer handle it has no other use for.
 *
 * The second is the hard cap. `mirrorBudget.max` mirrors may re-render in one
 * frame — **two** by default. `refractcascade` puts five panes down a line, and
 * five extra scene renders a frame is not a cast, it is a slideshow. At the
 * top of each frame the module scores every live mirror by
 *
 * ```
 *   priority × apparent size × (1 + frames since it last rendered)
 * ```
 *
 * and gives the slots to the best few. The starvation term is what stops the
 * nearest mirror hogging the budget forever, and it is unbounded upward on
 * purpose so a mirror that has *never* rendered outranks everything.
 *
 * A mirror that misses its slot keeps last frame's texture. At 60 Hz with five
 * panes and two slots each pane updates every 2–3 frames, which is a 30–50 ms
 * old reflection — invisible for a slow orbit, and visible as a slight lag if
 * you whip the camera. Given the alternative is 5× the cost, that is the right
 * trade, and `mirrorBudget.max` is there for whoever disagrees.
 *
 * ## The oblique near plane
 *
 * The mirrored camera can see things *behind* the mirror, and they must not
 * appear in the reflection: a floating pane would show the wall it is hanging
 * in front of, glued to its own surface. The fix is Lengyel's oblique
 * projection — the near plane is skewed to lie exactly on the mirror's plane,
 * so everything behind it is clipped by hardware for free. The alternative, a
 * user clipping plane, costs a `gl_ClipDistance` in every shader in the scene
 * (three implements it by patching every material) and is enormously more
 * expensive for the same result. The maths here follows `three/addons`'
 * `Reflector`, which is the reference implementation of it in this ecosystem.
 *
 * ## Roughness
 *
 * The reflection lookup is blurred by a jittered disc whose radius is
 * `roughness × blurRadius`, so `blackice` can start as a scuffed frozen puddle
 * and sharpen into a black mirror as it freezes by moving one slider from 1 to
 * 0. Two things about that kernel are not obvious:
 *
 *  - The jitter hash is on `gl_FragCoord` **and nothing else**. Adding `uTime`
 *    to it, which is the obvious way to break up the banding, turns a soft
 *    reflection into boiling static — there is no temporal filter in this
 *    pipeline to resolve it against.
 *  - The kernel is *stretched* along the screen-space direction of the surface
 *    normal (`roughStretch`). A rough planar surface does not blur its
 *    reflection isotropically: at a grazing angle the reflected lobe is
 *    smeared along the view-vertical, which is why a wet road smears the
 *    headlights above them into a streak and not into a disc.
 *
 * ## Invariants
 *
 * - **I1** — the plane, the extents and every look parameter are re-resolved
 *   from the caller's live params object each frame, zero-length frames
 *   included. The quad is built in the vertex shader from `uAnchor`, two axes
 *   and `uSize`, so the mesh matrix is identity for its whole life and the
 *   reflection camera derives its plane from those same uniform boxes — there
 *   is nowhere for a stale metre to hide.
 * - **I3** — the reflection camera, the frustum, the plane and every vector in
 *   the per-frame path are module-scope scratch. The render target is
 *   reallocated only on the frame the `resolution` slider actually changes.
 * - **I5** — every dimension is a slider, both colours are pickers.
 */

/* ---------------------------------------------------------------- */
/* The budget                                                        */
/* ---------------------------------------------------------------- */

/**
 * How many mirrors may re-render per frame, plus the live tally.
 *
 * `max` is the only field you should write; use `setMirrorBudget()` so the
 * clamp applies. Everything else is published by the module each frame and is
 * there for a HUD, a profiling overlay, or a sanity check in the console.
 *
 * This lives here rather than in `core/Layers.js` — where `distortionWriters`
 * lives — for the reason that file states in its own doc comment: the counter
 * belongs wherever the *consumer* can reach it without dragging shader source
 * into its bundle. `PostProcessing` has to ask about distortion, so that
 * counter cannot live in a VFX module. Nothing outside `src/vfx/` has to ask
 * about mirrors, because nothing outside runs their pass.
 */
export const mirrorBudget = {
  /** Hard cap on reflection renders per frame. Small on purpose. */
  max: 2,
  /** Mirrors currently visible. Retain/release, `distortionWriters`-style. */
  live: 0,
  /** Reflections rendered so far this frame. */
  rendered: 0,
  /** Mirrors that wanted a slot this frame and did not get one. */
  skipped: 0,
  /** Draw calls the reflections cost this frame — measured, not estimated. */
  calls: 0,
  /** Triangles ditto. */
  triangles: 0
};

/** Set the per-frame cap. 0 freezes every reflection at its last texture. */
export function setMirrorBudget(n) {
  mirrorBudget.max = Math.max(0, Math.min(8, Math.round(n)));
  return mirrorBudget.max;
}

/**
 * Live mirrors, in retain order, and the frame bookkeeping.
 *
 * `own` is the number of nested renders this module has issued during the
 * current frame, and it exists because the obvious frame token does not work.
 * `renderer.info.render.frame` increments inside *every* `render()` call —
 * including the depth prepass, and including our own reflection renders — so
 * the second mirror in a frame would see a different value from the first and
 * conclude a new frame had started, resetting the budget on every mirror in
 * turn and rendering all of them. Subtracting our own renders back out makes
 * the token constant across one traversal, which is all it has to be.
 */
const _reg = {
  list: [],
  token: -1,
  own: 0,
  rendering: false
};

/* ---------------------------------------------------------------- */
/* Scratch — module scope, reused, never allocated in a frame (I3)   */
/* ---------------------------------------------------------------- */

const _refCam = new PerspectiveCamera();
const _normal = new Vector3();
const _anchor = new Vector3();
const _camPos = new Vector3();
const _eye = new Vector3();
const _look = new Vector3();
const _target = new Vector3();
const _up = new Vector3();
const _ax = new Vector3();
const _ay = new Vector3();
const _tmp = new Vector3();
const _rot = new Matrix4();
const _proj = new Matrix4();
const _frustum = new Frustum();
const _sphere = new Sphere();
const _plane = new Plane();
const _clip = new Vector4();
const _q = new Vector4();

/** Bias matrix: clip space → texture space. Built once, never mutated. */
const _bias = new Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

/* ---------------------------------------------------------------- */
/* Frame scheduling                                                  */
/* ---------------------------------------------------------------- */

/**
 * Start a frame if this is the first mirror to ask, and pick the winners.
 *
 * Selection is a repeated max-scan rather than a sort: the live list is at most
 * a handful of entries, and `Array.prototype.sort` with a comparator would put
 * a closure in the per-frame path (**I3**).
 */
function beginFrame(renderer, camera) {
  const raw = renderer.info.render.frame - _reg.own;
  if (raw === _reg.token) return;

  _reg.token = renderer.info.render.frame;
  _reg.own = 0;
  mirrorBudget.rendered = 0;
  mirrorBudget.skipped = 0;
  mirrorBudget.calls = 0;
  mirrorBudget.triangles = 0;

  const list = _reg.list;
  let wanting = 0;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    m._selected = false;
    m._wants = m._wantsRender(camera);
    if (m._wants) wanting++;
  }

  const slots = Math.min(mirrorBudget.max, wanting);
  for (let k = 0; k < slots; k++) {
    let best = null;
    let bestScore = -1;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m._wants || m._selected) continue;
      const score = m._score(camera);
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    if (!best) break;
    best._selected = true;
  }

  mirrorBudget.skipped = wanting - slots;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m._wants && !m._selected) m._starve++;
  }
}

/* ---------------------------------------------------------------- */
/* Shaders                                                           */
/* ---------------------------------------------------------------- */

/**
 * The quad is built here from an anchor and two in-plane axes rather than from
 * the mesh's matrix, for the same reason `Distortion.js` does it: a metre that
 * lives in `mesh.scale` is a metre the ability captured at spawn, and **I1**
 * says there are none of those. Placing a mirror is two uniform writes.
 *
 * Three varyings are the interesting ones:
 *
 * - `vReflect` is the fragment's world position pushed through
 *   `bias × projection × view` of the *reflection* camera, i.e. the projective
 *   texture coordinate. Doing it here and dividing in the fragment is the
 *   standard planar-reflection lookup and is exact under perspective.
 * - `vStretch` is the screen-space direction of the surface normal, and it is a
 *   constant-across-the-quad varying (the anchor and the anchor-plus-normal are
 *   both projected here, once). The roughness kernel elongates along it.
 * - `vLocal` is metres from the centre in the plane, which is what the edge
 *   fade and the ripple measure in.
 */
const MIRROR_VERTEX = /* glsl */ `
  uniform vec3  uAnchor;
  uniform vec3  uAxisX;
  uniform vec3  uAxisY;
  uniform vec2  uSize;          // full extents in metres (x along uAxisX)
  uniform mat4  uReflectMatrix; // bias * proj * view of the reflection camera

  varying vec2 vLocal;      // metres from the centre, in the plane
  varying vec2 vNorm;       // -1..1 across the quad
  varying vec4 vReflect;
  varying vec3 vWorld;
  varying vec3 vViewDir;    // world-space, fragment → eye
  varying vec3 vNormalW;
  varying vec2 vStretch;    // screen direction of the normal, constant

  void main() {
    vec2 ext = (uv - 0.5) * uSize;
    vec3 world = uAnchor + uAxisX * ext.x + uAxisY * ext.y;

    vLocal = ext;
    vNorm = (uv - 0.5) * 2.0;
    vWorld = world;
    vNormalW = normalize(cross(uAxisX, uAxisY));
    vViewDir = normalize(cameraPosition - world);

    vReflect = uReflectMatrix * vec4(world, 1.0);

    vec4 clip = projectionMatrix * viewMatrix * vec4(world, 1.0);
    gl_Position = clip;

    /* The screen image of the anchor and of one metre of surface normal. Both
     * are constant over the quad, so the varying is exact everywhere. */
    vec4 c0 = projectionMatrix * viewMatrix * vec4(uAnchor, 1.0);
    vec4 c1 = projectionMatrix * viewMatrix * vec4(uAnchor + vNormalW, 1.0);
    vec2 s0 = c0.xy / max(c0.w, 0.001);
    vec2 s1 = c1.xy / max(c1.w, 0.001);
    vec2 d = s1 - s0;
    vStretch = length(d) > 1e-5 ? normalize(d) : vec2(0.0, 1.0);
  }
`;

const MIRROR_FRAGMENT = /* glsl */ `
  uniform sampler2D uReflection;
  uniform float uHasReflection;   // 0 until the first reflection has been rendered
  uniform vec2  uResolution;
  uniform float uTime;

  uniform float uRoughness;       // 0 mirror-smooth, 1 fully scattered
  uniform float uBlurRadius;      // reflection-UV radius at roughness 1
  uniform float uBlurTaps;        // 1..12
  uniform float uRoughStretch;    // elongation along the normal's screen direction

  uniform float uReflectivity;    // 0..1 base reflection weight
  uniform float uFresnel;         // 0..1 how much the grazing term shapes it
  uniform float uFresnelPower;

  uniform float uRipple;          // UV amplitude of the surface disturbance
  uniform float uRippleScale;     // cycles per metre
  uniform float uRippleSpeed;     // metres per second

  uniform float uOpacity;
  uniform float uEdgeFade;        // 0..1 of the half-extent
  uniform float uCorner;          // 0 rectangle, 1 ellipse
  uniform float uSeed;

  uniform vec3  uColorTint;       // multiplies the reflection
  uniform vec3  uColorBase;       // what shows through where it does not reflect

  varying vec2 vLocal;
  varying vec2 vNorm;
  varying vec4 vReflect;
  varying vec3 vWorld;
  varying vec3 vViewDir;
  varying vec3 vNormalW;
  varying vec2 vStretch;

  ${noiseGLSL}

  void main() {
    /* --- the reflection lookup ------------------------------------- */
    vec2 base = vReflect.xy / max(vReflect.w, 0.0001);

    /* The disturbance is sampled in world metres and scrolls in world metres,
     * so orbiting the camera does not drag the ripple across the surface —
     * the same reason Distortion.js's heat haze works in world space. */
    vec3 rp = vec3(vWorld.xz * uRippleScale, vWorld.y * uRippleScale - uTime * uRippleSpeed);
    base += vec2(fbm3(rp), fbm3(rp + vec3(19.3, 7.1, 41.7))) * uRipple;

    float aspect = max(uResolution.x, 1.0) / max(uResolution.y, 1.0);
    float radius = clamp(uRoughness, 0.0, 1.0) * uBlurRadius;
    float taps = clamp(uBlurTaps, 1.0, 12.0);

    /* Static per-pixel jitter. Deliberately not a function of time — see the
     * module comment; a temporal hash here boils. */
    float jitter = hash13(vec3(gl_FragCoord.xy, uSeed)) * 6.28318530718;

    vec3 refl = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < 12; i++) {
      float fi = float(i);
      if (fi >= taps) break;
      float ang = fi * 2.39996323 + jitter;
      float rad = sqrt((fi + 0.5) / taps) * radius;
      vec2 dir = vec2(cos(ang), sin(ang));
      vec2 off = dir * rad;
      // Elongate along the normal's screen direction: a rough plane smears its
      // reflection along the view-vertical, it does not fog it evenly.
      off += vStretch * dot(dir, vStretch) * rad * uRoughStretch;
      off.x /= aspect;   // the square target holds a wide frame; unsquash it
      refl += texture2D(uReflection, clamp(base + off, 0.0015, 0.9985)).rgb;
      wsum += 1.0;
    }
    refl /= max(wsum, 1.0);
    refl *= uColorTint;

    /* --- how much of it survives ------------------------------------ */
    float grazing = 1.0 - abs(dot(normalize(vViewDir), normalize(vNormalW)));
    float fres = mix(1.0, pow(clamp(grazing, 0.0, 1.0), max(uFresnelPower, 0.01)), clamp(uFresnel, 0.0, 1.0));
    float k = clamp(uReflectivity * fres, 0.0, 1.0) * uHasReflection;

    vec3 rgb = mix(uColorBase, refl, k);

    /* --- the silhouette ---------------------------------------------- */
    float d = mix(max(abs(vNorm.x), abs(vNorm.y)), length(vNorm), clamp(uCorner, 0.0, 1.0));
    float edge = 1.0 - smoothstep(1.0 - clamp(uEdgeFade, 0.001, 1.0), 1.0, d);
    float alpha = clamp(uOpacity, 0.0, 1.0) * edge;

    if (alpha < 0.002) discard;
    gl_FragColor = vec4(rgb, alpha);
  }
`;

/* ---------------------------------------------------------------- */
/* Defaults                                                          */
/* ---------------------------------------------------------------- */

/** Every canonical key, its default and its unit. */
const DEFAULTS = {
  /* --- the surface --- */
  width: 4, // metres along the placement's `along` axis
  height: 4, // metres along the other in-plane axis
  opacity: 1,
  edgeFade: 0.12, // 0..1 of the half-extent
  corner: 0, // 0 rectangle, 1 ellipse
  seed: 0, // unitless dice roll — the blur jitter

  /* --- the reflection --- */
  resolution: 384, // pixels, square. 256 is fine for rough, 512 for a black mirror
  reflectivity: 0.85, // 0..1
  fresnel: 0.35, // 0..1 how much grazing angle shapes the reflection
  fresnelPower: 2.4,

  /* --- roughness --- */
  roughness: 0.25, // 0 mirror-smooth. blackice drives this to 0 as it freezes
  blurRadius: 0.035, // reflection-UV radius at roughness 1
  blurTaps: 6, // 1..12
  roughStretch: 1.2, // elongation along the normal's screen direction

  /* --- disturbance --- */
  ripple: 0, // UV amplitude
  rippleScale: 1.4, // cycles per metre
  rippleSpeed: 0.5, // metres per second

  /* --- scheduling --- */
  priority: 1, // relative claim on the per-frame budget

  /* --- colour --- */
  colorTint: '#ffffff', // multiplies the reflection
  colorBase: '#0a1116' // what shows where the surface does not reflect
};

/** Every canonical key with its default. This function is the key list. */
export function mirrorParams() {
  return { ...DEFAULTS };
}

const num = (v, d) => (v === undefined || v === null ? d : v);

/* ---------------------------------------------------------------- */
/* Mirror                                                            */
/* ---------------------------------------------------------------- */

/**
 * ```js
 * const _m = mirrorParams();                       // module scope — I3
 * const _p = new Vector3();
 *
 * this.sheet = new Mirror({ resolution: 384 });
 * this.group.add(this.sheet.object3D);
 * // …
 * onImpact() { this.sheet.visible = true; }
 * onFade(dt, t) {
 *   const c = settings.blackice;
 *   this.sheet.setPlacement(this.target, UP, this.direction);
 *   _m.width     = c.zoneRadius * 2;               // metres, resolved THIS frame
 *   _m.height    = c.zoneRadius * 2;
 *   _m.roughness = c.roughness * (1 - this.freeze); // sharpens as it freezes
 *   _m.colorBase = c.colorIce;
 *   this.sheet.update(_m);
 * }
 * onDestroy() { this.sheet.visible = false; }
 * ```
 */
export class Mirror {
  /**
   * @param {object}  [options]
   * @param {number}  [options.resolution]  initial square target edge, pixels.
   *        `params.resolution` re-sizes it live; this is only the first value.
   * @param {number}  [options.layer]       the surface's own layer. Default
   *        `LAYER.VFX`. Putting a mirror on `LAYER.WORLD` also puts it in the
   *        depth prepass, which is handled (see `_wantsRender`) but means the
   *        surface writes depth for soft particles — usually what you want for
   *        a floor sheet and never what you want for a floating pane.
   * @param {number}  [options.reflectLayer] which layer the reflection renders.
   *        Default `LAYER.WORLD`: the real scene, no VFX. Reflecting the VFX
   *        layer as well means a mirror can see another mirror, which is a
   *        recursion this module refuses rather than resolves.
   * @param {number}  [options.renderOrder]
   * @param {boolean} [options.doubleSided] default true — a floating pane is
   *        reflective from both sides and the plane's normal is flipped toward
   *        the camera each frame. Set false for a floor sheet you never see
   *        from underneath and get back a free cull.
   * @param {boolean} [options.depthWrite]  default false
   * @param {string}  [options.name]
   */
  constructor({
    resolution = 384,
    layer = LAYER.VFX,
    reflectLayer = LAYER.WORLD,
    renderOrder = 4,
    doubleSided = true,
    depthWrite = false,
    name
  } = {}) {
    this.reflectLayer = reflectLayer;
    this.doubleSided = doubleSided;

    this._resolution = Math.max(64, Math.min(1024, Math.round(resolution)));
    this.target = new WebGLRenderTarget(this._resolution, this._resolution, {
      type: HalfFloatType, // the world is linear HDR here; 8 bits would band the sky
      depthBuffer: true,
      minFilter: LinearFilter,
      magFilter: LinearFilter
    });
    this.target.texture.generateMipmaps = false;
    this.target.texture.name = name ? `${name}:reflection` : 'Mirror:reflection';

    this.material = new ShaderMaterial({
      name: name ? `${name}:mirror` : 'Mirror',
      transparent: true,
      depthWrite,
      depthTest: true,
      blending: NormalBlending,
      side: DoubleSide,
      uniforms: sharedUniforms({
        uAnchor: { value: new Vector3() },
        uAxisX: { value: new Vector3(1, 0, 0) },
        uAxisY: { value: new Vector3(0, 0, 1) },
        uSize: { value: new Vector2(DEFAULTS.width, DEFAULTS.height) },
        uReflectMatrix: { value: new Matrix4() },
        uReflection: { value: this.target.texture },
        uHasReflection: { value: 0 },

        uRoughness: { value: DEFAULTS.roughness },
        uBlurRadius: { value: DEFAULTS.blurRadius },
        uBlurTaps: { value: DEFAULTS.blurTaps },
        uRoughStretch: { value: DEFAULTS.roughStretch },

        uReflectivity: { value: DEFAULTS.reflectivity },
        uFresnel: { value: DEFAULTS.fresnel },
        uFresnelPower: { value: DEFAULTS.fresnelPower },

        uRipple: { value: DEFAULTS.ripple },
        uRippleScale: { value: DEFAULTS.rippleScale },
        uRippleSpeed: { value: DEFAULTS.rippleSpeed },

        uOpacity: { value: DEFAULTS.opacity },
        uEdgeFade: { value: DEFAULTS.edgeFade },
        uCorner: { value: DEFAULTS.corner },
        uSeed: { value: DEFAULTS.seed },

        uColorTint: { value: new Color(DEFAULTS.colorTint) },
        uColorBase: { value: new Color(DEFAULTS.colorBase) }
      }),
      vertexShader: MIRROR_VERTEX,
      fragmentShader: MIRROR_FRAGMENT
    });

    this.mesh = new Mesh(uprightQuad(), this.material);
    this.mesh.name = name || 'Mirror';
    this.mesh.layers.set(layer);
    this.mesh.renderOrder = renderOrder;
    // The quad is built from uniforms: its bounding sphere is a lie and its
    // matrix never changes. Culling is done by hand in `_wantsRender()`.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.mesh.onBeforeRender = (renderer, scene, camera) => this._onBeforeRender(renderer, scene, camera);

    /** Priority weight against the per-frame budget. Re-read every update(). */
    this.priority = DEFAULTS.priority;
    /** Frames this mirror has wanted a slot and not had one. */
    this._starve = 999; // never rendered: outranks everything on the first frame
    this._selected = false;
    this._wants = false;
    this._visible = false;
    this._disposed = false;

    /** Draw calls the last reflection cost. Measured off `renderer.info`. */
    this.lastCalls = 0;
    /** Triangles ditto. */
    this.lastTriangles = 0;
  }

  /** Add this to the ability's group. */
  get object3D() {
    return this.mesh;
  }

  /** One — the surface. The reflection pass is reported by `mirrorBudget`. */
  get drawCalls() {
    return 1;
  }

  /** Current square edge of the reflection target, in pixels. */
  get resolution() {
    return this._resolution;
  }

  /**
   * Visible mirrors are registered, and only registered mirrors are scheduled.
   * Retain/release exactly as `Layers.js#distortionWriters` does — the counter
   * tracks visibility, not construction, because abilities are pooled and a
   * mirror exists for the lifetime of the app and is visible for a second of it.
   */
  get visible() {
    return this._visible;
  }

  set visible(v) {
    const on = !!v && !this._disposed;
    if (on === this._visible) return;
    this._visible = on;
    this.mesh.visible = on;
    if (on) {
      _reg.list.push(this);
      mirrorBudget.live++;
      // Come back hungry: a mirror that has been hidden for a second is showing
      // a reflection of where the camera used to be.
      this._starve = 999;
      this.material.uniforms.uHasReflection.value = 0;
    } else {
      const i = _reg.list.indexOf(this);
      if (i >= 0) _reg.list.splice(i, 1);
      mirrorBudget.live = Math.max(0, mirrorBudget.live - 1);
    }
  }

  /**
   * Put the plane somewhere. Call it every frame — nothing here is captured.
   *
   * @param {THREE.Vector3} anchor the centre of the surface, world metres
   * @param {THREE.Vector3} normal the surface normal; world up for a floor
   * @param {THREE.Vector3} along  an in-plane direction hint — becomes the
   *        `width` axis. Re-orthogonalised against `normal`, so passing the
   *        cast heading for a floor sheet does the obvious thing.
   */
  setPlacement(anchor, normal, along) {
    const u = this.material.uniforms;
    _normal.copy(normal).normalize();
    _ax.copy(along);
    _ax.addScaledVector(_normal, -_ax.dot(_normal));
    if (_ax.lengthSq() < 1e-8) {
      // `along` was parallel to the normal. Any in-plane axis will do.
      _ax.set(1, 0, 0).addScaledVector(_normal, -_normal.x);
      if (_ax.lengthSq() < 1e-8) _ax.set(0, 0, 1).addScaledVector(_normal, -_normal.z);
    }
    _ax.normalize();
    _ay.crossVectors(_normal, _ax).normalize();
    u.uAnchor.value.copy(anchor);
    u.uAxisX.value.copy(_ax);
    u.uAxisY.value.copy(_ay);
    return this;
  }

  /**
   * Re-resolve everything. Call it every frame, including a zero-length one.
   *
   * Keys are exactly those of `mirrorParams()`. `resolution` is the only one
   * with a side effect beyond a uniform write: changing it reallocates the
   * render target, which is gated on the value actually moving, so dragging the
   * slider costs one reallocation per distinct value and nothing on the frames
   * between.
   *
   * @param {object} p a plain object. Keep it at module scope and refill it.
   */
  update(p) {
    const u = this.material.uniforms;

    u.uSize.value.set(num(p.width, DEFAULTS.width), num(p.height, DEFAULTS.height));

    u.uRoughness.value = num(p.roughness, DEFAULTS.roughness);
    u.uBlurRadius.value = num(p.blurRadius, DEFAULTS.blurRadius);
    u.uBlurTaps.value = num(p.blurTaps, DEFAULTS.blurTaps);
    u.uRoughStretch.value = num(p.roughStretch, DEFAULTS.roughStretch);

    u.uReflectivity.value = num(p.reflectivity, DEFAULTS.reflectivity);
    u.uFresnel.value = num(p.fresnel, DEFAULTS.fresnel);
    u.uFresnelPower.value = num(p.fresnelPower, DEFAULTS.fresnelPower);

    u.uRipple.value = num(p.ripple, DEFAULTS.ripple);
    u.uRippleScale.value = num(p.rippleScale, DEFAULTS.rippleScale);
    u.uRippleSpeed.value = num(p.rippleSpeed, DEFAULTS.rippleSpeed);

    u.uOpacity.value = num(p.opacity, DEFAULTS.opacity);
    u.uEdgeFade.value = num(p.edgeFade, DEFAULTS.edgeFade);
    u.uCorner.value = num(p.corner, DEFAULTS.corner);
    u.uSeed.value = num(p.seed, DEFAULTS.seed);

    copyColor(u.uColorTint.value, p.colorTint || DEFAULTS.colorTint);
    copyColor(u.uColorBase.value, p.colorBase || DEFAULTS.colorBase);

    this.priority = num(p.priority, DEFAULTS.priority);
    this._setResolution(num(p.resolution, DEFAULTS.resolution));

    return this;
  }

  /** Reallocate the target only when the slider actually moves. */
  _setResolution(value) {
    const next = Math.max(64, Math.min(1024, Math.round(value)));
    if (next === this._resolution) return;
    this._resolution = next;
    this.target.setSize(next, next);
    // The old texture object survives `setSize`, but its contents do not.
    this.material.uniforms.uHasReflection.value = 0;
    this._starve = 999;
  }

  /* ---------------------------------------------------------------- */
  /* Scheduling                                                        */
  /* ---------------------------------------------------------------- */

  /** Half the diagonal of the surface, metres — the culling sphere's radius. */
  _boundRadius() {
    const s = this.material.uniforms.uSize.value;
    return 0.5 * Math.sqrt(s.x * s.x + s.y * s.y);
  }

  /**
   * Would this mirror benefit from a reflection this frame?
   *
   * Three cheap rejections, in increasing cost: hidden, facing away (only when
   * single-sided — a double-sided pane flips its plane toward the camera and is
   * never facing away), and outside the frustum. The frustum test is done here
   * rather than left to the renderer because `frustumCulled` is off on a mesh
   * whose geometry is built in the vertex shader, so the free cull is not
   * available and this is the honest replacement for it.
   */
  _wantsRender(camera) {
    if (!this._visible || this._disposed) return false;

    const u = this.material.uniforms;
    _anchor.copy(u.uAnchor.value);
    _camPos.setFromMatrixPosition(camera.matrixWorld);

    if (!this.doubleSided) {
      _normal.crossVectors(u.uAxisX.value, u.uAxisY.value).normalize();
      if (_tmp.subVectors(_camPos, _anchor).dot(_normal) <= 0) return false;
    }

    _proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_proj);
    _sphere.center.copy(_anchor);
    _sphere.radius = this._boundRadius();
    return _frustum.intersectsSphere(_sphere);
  }

  /**
   * Priority × apparent size × starvation.
   *
   * Apparent size is the bounding radius over the distance to the eye, which is
   * the tangent of the half-angle the mirror subtends — near and large beats
   * far and small, which is the order the eye notices a stale reflection in.
   */
  _score(camera) {
    _camPos.setFromMatrixPosition(camera.matrixWorld);
    const distance = Math.max(0.25, _camPos.distanceTo(this.material.uniforms.uAnchor.value));
    const span = this._boundRadius() / distance;
    return Math.max(this.priority, 0) * span * (1 + this._starve);
  }

  /* ---------------------------------------------------------------- */
  /* The reflection pass                                               */
  /* ---------------------------------------------------------------- */

  _onBeforeRender(renderer, scene, camera) {
    // The depth prepass draws `LAYER.WORLD` with `scene.overrideMaterial` set.
    // A mirror on that layer would otherwise render its whole reflection from
    // inside the prepass, into a target the prepass then throws away.
    if (scene.overrideMaterial) return;
    // A mirror inside another mirror's reflection: refused, not resolved.
    if (_reg.rendering) return;
    if (!camera.isPerspectiveCamera) return;

    beginFrame(renderer, camera);
    if (!this._selected) return;
    this._selected = false;

    this._renderReflection(renderer, scene, camera);
  }

  _renderReflection(renderer, scene, camera) {
    const u = this.material.uniforms;

    _anchor.copy(u.uAnchor.value);
    _normal.crossVectors(u.uAxisX.value, u.uAxisY.value).normalize();
    _camPos.setFromMatrixPosition(camera.matrixWorld);

    // Face the plane at the eye. `Reflector` skips the mirror when it is facing
    // away; a pane hanging in mid-air that you can walk around wants both sides
    // to work, and flipping the plane is all that takes.
    if (_tmp.subVectors(_camPos, _anchor).dot(_normal) < 0) {
      if (!this.doubleSided) return;
      _normal.negate();
    }

    /* ---- the mirrored camera ---- */
    // Eye, reflected about the plane.
    _eye.subVectors(_anchor, _camPos).reflect(_normal).negate().add(_anchor);

    // The point the real camera is looking at, reflected the same way.
    _rot.extractRotation(camera.matrixWorld);
    _look.set(0, 0, -1).applyMatrix4(_rot).add(_camPos);
    _target.subVectors(_anchor, _look).reflect(_normal).negate().add(_anchor);

    _up.set(0, 1, 0).applyMatrix4(_rot).reflect(_normal);

    _refCam.position.copy(_eye);
    _refCam.up.copy(_up);
    _refCam.lookAt(_target);
    _refCam.near = camera.near;
    _refCam.far = camera.far; // WebGLBackground reads it
    _refCam.updateMatrixWorld(true);
    _refCam.matrixWorldInverse.copy(_refCam.matrixWorld).invert();
    _refCam.projectionMatrix.copy(camera.projectionMatrix);
    _refCam.layers.set(this.reflectLayer);

    /* ---- the oblique near plane (Lengyel) ---- */
    // Skew the near plane onto the mirror so everything behind the surface is
    // clipped in hardware. Without this a pane shows the wall it hangs in front
    // of, welded to its own face.
    _plane.setFromNormalAndCoplanarPoint(_normal, _anchor);
    _plane.applyMatrix4(_refCam.matrixWorldInverse);
    _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);

    const pm = _refCam.projectionMatrix;
    _q.x = (Math.sign(_clip.x) + pm.elements[8]) / pm.elements[0];
    _q.y = (Math.sign(_clip.y) + pm.elements[9]) / pm.elements[5];
    _q.z = -1;
    _q.w = (1 + pm.elements[10]) / pm.elements[14];
    _clip.multiplyScalar(2 / _clip.dot(_q));
    pm.elements[2] = _clip.x;
    pm.elements[6] = _clip.y;
    // CLIP_BIAS pushes the plane a hair behind the surface: exactly on it, the
    // mirror's own edge pixels sample a hairline of clipped background.
    pm.elements[10] = _clip.z + 1 - 0.004;
    pm.elements[14] = _clip.w;

    /* ---- the projective lookup matrix ---- */
    u.uReflectMatrix.value
      .copy(_bias)
      .multiply(_refCam.projectionMatrix)
      .multiply(_refCam.matrixWorldInverse);

    /* ---- render ---- */
    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const wasVisible = this.mesh.visible;

    this.mesh.visible = false;
    renderer.xr.enabled = false; // the reflection camera is not the XR camera
    renderer.shadowMap.autoUpdate = false; // reuse the maps the main pass built

    _reg.rendering = true;
    renderer.setRenderTarget(this.target);
    // #18897: the composer leaves the depth mask wherever the last pass put it,
    // and a target that cannot clear its depth reflects last frame's geometry.
    renderer.state.buffers.depth.setMask(true);
    if (renderer.autoClear === false) renderer.clear();
    renderer.render(scene, _refCam);
    _reg.rendering = false;

    // `info` was reset at the top of that render call, so these are exactly the
    // reflection's own numbers — and the outer frame's are now gone, which the
    // module comment warns about.
    this.lastCalls = renderer.info.render.calls;
    this.lastTriangles = renderer.info.render.triangles;
    mirrorBudget.calls += this.lastCalls;
    mirrorBudget.triangles += this.lastTriangles;
    mirrorBudget.rendered++;
    _reg.own++;

    renderer.setRenderTarget(prevTarget);
    renderer.xr.enabled = prevXr;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    this.mesh.visible = wasVisible;

    // Restoring the target resets the viewport to the target's full size; a
    // camera with an explicit viewport has to have it put back.
    if (camera.viewport !== undefined) renderer.state.viewport(camera.viewport);

    u.uHasReflection.value = 1;
    this._starve = 0;
  }

  dispose() {
    this.visible = false;
    this._disposed = true;
    this.mesh.onBeforeRender = () => {};
    this.target.dispose();
    this.material.dispose();
    // The quad is a shared module-scope singleton — four vertices, never freed.
    this.mesh.parent?.remove(this.mesh);
  }
}
