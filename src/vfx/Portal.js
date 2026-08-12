import {
  Mesh,
  ShaderMaterial,
  CustomBlending,
  AddEquation,
  OneFactor,
  OneMinusSrcAlphaFactor,
  DoubleSide,
  Color,
  Vector2,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { uprightQuad } from './quads.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { copyColor } from '../utils/color.js';

/* ------------------------------------------------------------------------ */
/* Portal — a hole, not a decal                                             */
/* ------------------------------------------------------------------------ */
/**
 * A disc or a slit with something behind it.
 *
 * Everything in this sandbox is additive light laid over the stage. A portal has
 * to do the opposite: it has to *remove* the stage and put a different world
 * where it was. Three things make that read, and only one of them is obvious.
 *
 * **1 — It occludes.** The interior is drawn with premultiplied-alpha custom
 * blending (`ONE, ONE_MINUS_SRC_ALPHA`), which is the whole reason this is one
 * draw call instead of two. Premultiplied output lets a single fragment be both
 * *opaque black* (rgb ≈ 0, a = 1 — the void genuinely covers the floor) and
 * *pure additive glow* (rgb = hot, a = 0 — the fracture rim adds over whatever
 * is behind it) depending only on what it writes. A normal-blended pass cannot
 * express the second and an additive pass cannot express the first, so the
 * naive build is two meshes fighting over the same SDF.
 *
 * **2 — The interior parallaxes, at the wrong rate.** For each of three star
 * shells the view ray is continued *through* the portal plane to a depth in
 * metres behind it, and the starfield is sampled where it lands. That alone is
 * geometrically correct parallax, and geometrically correct parallax looks like
 * a window. The `parallax` slider then scales the lateral part of that shift
 * away from 1 — the interior slides against the camera *faster than the geometry
 * says it should*, and that mismatch is the entire illusion. Set it to 1 and the
 * portal collapses back into a hole in a wall; set it to 1.6 and it becomes a
 * hole in space. It is the single most important number in this file.
 *
 * **3 — It tears.** `open` does not scale the aperture. The aperture is always
 * full size; what `open` sweeps is a **threshold on a field**, and that field is
 * the normalised distance to the seam multiplied by a world-space noise. So
 * different bearings open at different rates, the boundary is ragged, and it is
 * ragged in the *same places* on the way closed. A portal that scales is a
 * sprite growing; a portal that tears is something being forced.
 *
 * ## Depth at the edge
 *
 * `depthTest` is on and `depthWrite` is off, which is the correct pair for a
 * transparent that must be hidden by nearer opaque geometry — walk the character
 * in front of a rift and the rift is behind them. What it will *not* do is hide
 * transparents drawn after it, because they are not depth-tested against
 * something that never wrote depth. If an ability needs the void to swallow its
 * own particles, construct with `writeDepth: true` and accept that the aperture
 * then punches a hole in the transparent queue with a hard alpha-tested edge.
 *
 * ## Cost
 *
 * One draw call. One material. No textures — the starfield is a hashed lattice
 * and the nebula is fbm, both evaluated in the shell's own tangent plane.
 *
 * ## Invariants
 *
 * - **I1** — holds no dimensions. `update()` is called every frame with values
 *   the ability resolved from `settings` that frame, zero-length frames
 *   included. Pause mid-tear and drag `open`, `radiusX`, `tearJag`.
 * - **I3** — `update()` writes into existing uniform boxes and into cached
 *   `Color`s via `copyColor`. Nothing allocates. The quad is a module-scope
 *   singleton.
 * - **I5** — ten colour pickers, and not one of them is derived from another.
 */

/* ---------------------------------------------------------------- */
/* Shaders                                                           */
/* ---------------------------------------------------------------- */

const PORTAL_VERTEX = /* glsl */ `
  uniform vec3 uAnchor;  // world centre of the aperture
  uniform vec2 uSize;    // quad extent, metres — aperture plus the crack margin
  uniform vec3 uAxisX;   // the plane's local +X, unit
  uniform vec3 uAxisY;   // the plane's local +Y, unit

  varying vec2 vUv;
  varying vec2 vLocal;   // metres from the centre, in the portal plane
  varying vec3 vWorld;
  varying vec3 vT;
  varying vec3 vB;
  varying vec3 vN;

  void main() {
    vUv = uv;

    vec3 ax;
    vec3 ay;
    #ifdef PORTAL_BILLBOARD
      ax = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
      ay = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    #else
      ax = uAxisX;
      ay = uAxisY;
    #endif

    vec2 ext = (uv - 0.5) * uSize;
    vec3 world = uAnchor + ax * ext.x + ay * ext.y;

    vLocal = ext;
    vWorld = world;
    vT = ax;
    vB = ay;
    vN = normalize(cross(ax, ay));

    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const PORTAL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uGlobalGlow;
  uniform float uShaderIntensity;

  uniform vec3  uAnchor;
  uniform vec2  uRadii;        // aperture half-extents, metres. Equal = a disc.
  uniform float uOpen;         // 0..1 tear progress
  uniform float uSeam;         // 0 opens from the centre, 1 from the long centreline
  uniform float uTearJag;      // 0..1 how uneven the front is
  uniform float uTearScale;    // cycles per metre of the crack grain
  uniform float uTearCrawl;    // Hz — the grain creeping while the tear is held
  uniform float uEdgeSoft;     // 0..1 of the field — how hard the aperture cuts
  uniform float uSeed;

  uniform float uRim;          // 0..1 of the field — the fracture band's width
  uniform float uRimGlow;
  uniform float uCore;         // 0..1 — the white-hot line inside the band
  uniform float uCoreGlow;
  uniform float uThroat;       // 0..1 — the soft inner glow past the rim
  uniform float uThroatGlow;

  uniform float uCrackCount;   // radial fractures around the rim
  uniform float uCrackWidth;   // 0..1 of one angular cell
  uniform float uCrackLength;  // 0..1 of the field they reach out to
  uniform float uCrackGlow;

  uniform float uParallax;     // 1 = geometrically honest. Do not ship 1.
  uniform float uSwirl;        // rad/s — the whole interior turning
  uniform float uInteriorFade; // 0..1 — how much the void darkens toward the rim

  uniform float uStarSize;
  uniform float uStarTwinkle;
  uniform float uStarGain;
  uniform vec3  uStarScale;    // stars per metre, per shell
  uniform vec3  uStarDepth;    // metres behind the plane, per shell
  uniform vec3  uStarDrift;    // rad/s, per shell

  uniform float uNebulaScale;  // cycles per metre
  uniform float uNebulaSpeed;
  uniform float uNebulaGain;
  uniform float uNebulaDepth;  // metres behind the plane

  uniform vec3  uColorVoid;
  uniform vec3  uColorRim;
  uniform vec3  uColorCore;
  uniform vec3  uColorCrack;
  uniform vec3  uColorThroat;
  uniform vec3  uColorStarA;
  uniform vec3  uColorStarB;
  uniform vec3  uColorStarC;
  uniform vec3  uColorNebulaA;
  uniform vec3  uColorNebulaB;

  uniform float uOpacity;

  varying vec2 vUv;
  varying vec2 vLocal;
  varying vec3 vWorld;
  varying vec3 vT;
  varying vec3 vB;
  varying vec3 vN;

  ${noiseGLSL}
  ${commonGLSL}

  #define TAU 6.28318530718

  vec2 rot2(vec2 p, float a) {
    float c = cos(a);
    float s = sin(a);
    return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  }

  /**
   * Where the view ray lands on a plane depth metres behind the portal.
   *
   * base is where we already are on the portal plane; the difference between
   * the two is the honest parallax shift, and uParallax scales *that* rather
   * than the depth — scaling the depth would also change how big the stars are,
   * which is a different lie and a worse one.
   */
  vec2 shellCoord(vec3 V, vec3 N, vec2 base, float depth) {
    float vn = max(abs(dot(V, N)), 0.18);   // clamp: a grazing view shoots to infinity
    vec3 hit = vWorld + V * (depth / vn);
    vec3 rel = hit - uAnchor;
    vec2 there = vec2(dot(rel, vT), dot(rel, vB));
    return base + (there - base) * uParallax;
  }

  /**
   * A hashed lattice of points. Not a texture, not a sprite — one cell per star,
   * jittered inside its cell, with exp(-d/size) for the falloff because a
   * gaussian core with an exponential skirt is what a small bright thing does to
   * a lens and a smoothstep disc is what a UI element does.
   */
  float starLayer(vec2 s, float scale, float seed) {
    vec2 g = s * scale;
    vec2 id = floor(g);
    vec2 fr = fract(g) - 0.5;
    float h = hash13(vec3(id, seed));
    vec2 off = (hash21(h * 91.7 + seed) - 0.5) * 0.72;
    float d = length(fr - off);
    float lit = smoothstep(0.52, 0.98, h);
    float tw = 1.0 + uStarTwinkle * sin(uTime * (1.7 + h * 6.1) + h * 37.0);
    return lit * max(tw, 0.0) * exp(-d / max(uStarSize, 1e-3));
  }

  void main() {
    /* ---------------- the aperture ---------------- */
    vec2 p = vLocal;
    vec2 q = p / max(uRadii, vec2(1e-3));
    float rn = length(q);

    // Which bearings open first. A disc unzips from the middle; a slit unzips
    // from its long centreline, which is what makes it read as a wound rather
    // than as an iris.
    float seamField = mix(rn, abs(q.y), clamp(uSeam, 0.0, 1.0));

    // Sampled in **metres**, so the crack grain is a fixed physical size — a
    // two-metre rift and a six-metre rift tear with the same size of shard.
    float jag = fbm3(vec3(p * uTearScale, uSeed + uTime * uTearCrawl)) * 0.5 + 0.5;
    float factor = mix(1.0, 0.72 + 0.56 * jag, clamp(uTearJag, 0.0, 1.0));
    float f = seamField * factor;

    // Signed distance to whichever boundary is nearer: the travelling tear front
    // or the aperture's own ellipse. Positive inside the hole.
    float edge = min(uOpen - f, 1.0 - rn);
    float born = smoothstep(0.0, 0.02, uOpen);

    float aperture = smoothstep(0.0, max(uEdgeSoft, 1e-3), edge) * born;

    /* ---------------- the interior ---------------- */
    vec3 V = normalize(vWorld - cameraPosition);
    vec3 N = gl_FrontFacing ? vN : -vN;
    vec3 rel0 = vWorld - uAnchor;
    vec2 base = vec2(dot(rel0, vT), dot(rel0, vB));

    float spin = uTime * uSwirl;

    vec2 sA = rot2(shellCoord(V, N, base, uStarDepth.x), spin + uTime * uStarDrift.x);
    vec2 sB = rot2(shellCoord(V, N, base, uStarDepth.y), spin + uTime * uStarDrift.y);
    vec2 sC = rot2(shellCoord(V, N, base, uStarDepth.z), spin + uTime * uStarDrift.z);

    vec3 stars =
        uColorStarA * starLayer(sA, uStarScale.x, uSeed + 1.0)
      + uColorStarB * starLayer(sB, uStarScale.y, uSeed + 2.0)
      + uColorStarC * starLayer(sC, uStarScale.z, uSeed + 3.0);
    stars *= uStarGain;

    vec2 sN = rot2(shellCoord(V, N, base, uNebulaDepth), spin * 0.4);
    float neb = fbm4(vec3(sN * uNebulaScale, uTime * uNebulaSpeed + uSeed)) * 0.5 + 0.5;
    neb = pow(clamp(neb, 0.0, 1.0), 2.0) * uNebulaGain;
    vec3 nebula = mix(uColorNebulaA, uColorNebulaB, clamp(neb, 0.0, 1.0)) * neb;

    vec3 interior = uColorVoid + stars + nebula;
    // Fall off toward the rim: the hole is deepest in the middle, and without
    // this the starfield runs flat into the fracture and the whole thing reads
    // as a painted disc again.
    interior *= mix(1.0, smoothstep(0.0, 0.5, edge), clamp(uInteriorFade, 0.0, 1.0));

    /* ---------------- the fracture ---------------- */
    float rim = exp(-abs(edge) / max(uRim, 1e-4));
    float core = exp(-abs(edge) / max(uCore, 1e-4));
    float throat = exp(-max(edge, 0.0) / max(uThroat, 1e-4)) * aperture;

    // Radial fractures licking out past the boundary. One per angular cell, at a
    // hashed bearing inside it, with a hashed reach — so the crown of cracks is
    // irregular without a single loop.
    //
    // Two details that are not optional. The angular distance wraps, because a
    // crack whose bearing lands near a cell boundary is otherwise sliced in half
    // and the crown develops a seam you cannot unsee. And the whole term is
    // gated to *strictly outside* the boundary: the first build multiplied by
    // step(0.0, outside), which is 1 at outside == 0 and therefore 1 across the
    // entire interior, so every crack ran unbroken to the centre of the hole.
    // Dead-straight spokes out of a middle — a firework, not a fracture.
    float cells = max(uCrackCount, 1.0);
    float ang = atan(q.y, q.x) / TAU + 0.5;
    float cell = floor(ang * cells);
    float within = fract(ang * cells);
    float bearing = hash11(cell + uSeed * 13.0);
    float reach = uCrackLength * (0.35 + 0.9 * hash11(cell + uSeed * 13.0 + 7.7));
    float sweep = abs(within - bearing);
    sweep = min(sweep, 1.0 - sweep);
    float spike = 1.0 - smoothstep(0.0, max(uCrackWidth, 1e-3), sweep);
    float outside = max(-edge, 0.0);
    float crack =
      spike * exp(-outside / max(reach, 1e-3)) * smoothstep(0.0, max(uRim, 1e-4), outside) * born;

    vec3 emissive =
        uColorRim * rim * uRimGlow
      + uColorCore * core * uCoreGlow
      + uColorThroat * throat * uThroatGlow
      + uColorCrack * crack * uCrackGlow;
    emissive *= born * uGlobalGlow * uShaderIntensity;

    /* ---------------- premultiplied output ---------------- */
    float a = clamp(aperture * uOpacity, 0.0, 1.0);
    vec3 rgb = interior * a + emissive;

    if (a < 0.001 && max(rgb.r, max(rgb.g, rgb.b)) < 0.002) discard;

    #ifdef PORTAL_WRITE_DEPTH
      // Only the solid part of the hole is allowed to own depth; the additive
      // crown must not, or every crack punches a rectangle out of the queue.
      if (a < 0.5) discard;
    #endif

    gl_FragColor = vec4(rgb, a);
  }
`;

/* ---------------------------------------------------------------- */
/* Defaults                                                          */
/* ---------------------------------------------------------------- */

/**
 * A portal that is visible on the first frame, not an art direction. Every one
 * of these is meant to become a slider in the ability's own settings block —
 * anything left to fall back to here is a value the editor cannot reach, which
 * is an **I1** violation waiting to be filed as a bug.
 */
const DEFAULTS = {
  radiusX: 1.6,
  radiusY: 1.6,
  margin: 0.45,
  open: 1,
  seam: 0,
  tearJag: 0.65,
  tearScale: 1.8,
  tearCrawl: 0.12,
  edgeSoft: 0.045,
  seed: 0,
  opacity: 1,

  rim: 0.035,
  rimGlow: 2.4,
  core: 0.01,
  coreGlow: 5,
  throat: 0.16,
  throatGlow: 0.6,

  crackCount: 14,
  crackWidth: 0.09,
  crackLength: 0.22,
  crackGlow: 1.8,

  parallax: 1.6,
  swirl: 0.05,
  interiorFade: 0.35,

  starSize: 0.045,
  starTwinkle: 0.35,
  starGain: 1,
  starScaleA: 2.6,
  starScaleB: 5.2,
  starScaleC: 9.5,
  starDepthA: 2.5,
  starDepthB: 7,
  starDepthC: 18,
  starDriftA: 0.03,
  starDriftB: 0.017,
  starDriftC: 0.008,

  nebulaScale: 0.22,
  nebulaSpeed: 0.05,
  nebulaGain: 0.55,
  nebulaDepth: 11,

  colorVoid: '#000000',
  colorRim: '#b07aff',
  colorCore: '#ffffff',
  colorCrack: '#8a5fd0',
  colorThroat: '#3a1a6a',
  colorStarA: '#ffffff',
  colorStarB: '#c0d0ff',
  colorStarC: '#8a7aff',
  colorNebulaA: '#12061f',
  colorNebulaB: '#5a2ea0'
};

const num = (v, d) => (v === undefined || v === null ? d : v);

/* ---------------------------------------------------------------- */
/* Scratch — module scope (I3)                                       */
/* ---------------------------------------------------------------- */

const _ax = new Vector3();
const _ay = new Vector3();
const _n = new Vector3();

/* ---------------------------------------------------------------- */
/* Portal                                                            */
/* ---------------------------------------------------------------- */

/**
 * ```js
 * const _p = new Vector3();
 * const _o = {};                                   // module scope — I3
 *
 * this.rift = new Portal();
 * this.group.add(this.rift.object3D);
 * // …
 * onTravel(dt) {
 *   const c = settings.voidrift;
 *   this.rift.setPlacement(this.pointAt(0.5, _p), this.direction, UP);
 *   _o.radiusX = this.length * 0.5 * c.riftSpan;   // metres, resolved this frame
 *   _o.radiusY = c.riftHeight;
 *   _o.open = this.u;
 *   _o.seam = c.riftSeam;
 *   this.rift.update(_o);
 * }
 * ```
 *
 * Pair it with a `DistortionField` in `LENS` mode anchored at the same point to
 * get the ring of bent floor around the edge — the portal itself deliberately
 * writes no offsets, because an ability that wants a hole does not always want
 * the frame warped around it.
 */
export class Portal {
  /**
   * @param {object}   options
   * @param {boolean} [options.billboard]  face the camera instead of using `setPlacement`
   * @param {boolean} [options.writeDepth] punch the aperture into the depth buffer
   * @param {number}  [options.renderOrder]
   * @param {string}  [options.name]
   */
  constructor({ billboard = false, writeDepth = false, renderOrder = 6, name = 'Portal' } = {}) {
    this.material = new ShaderMaterial({
      name: `${name}:surface`,
      transparent: true,
      depthWrite: writeDepth,
      depthTest: true,
      side: DoubleSide,
      toneMapped: false,
      // Premultiplied alpha. See the class header — this is what lets one pass
      // be an occluder and an emitter at the same time.
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendEquationAlpha: AddEquation,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
      defines: {
        ...(billboard ? { PORTAL_BILLBOARD: '' } : {}),
        ...(writeDepth ? { PORTAL_WRITE_DEPTH: '' } : {})
      },
      uniforms: sharedUniforms({
        uAnchor: { value: new Vector3() },
        uSize: { value: new Vector2(1, 1) },
        uAxisX: { value: new Vector3(1, 0, 0) },
        uAxisY: { value: new Vector3(0, 1, 0) },

        uRadii: { value: new Vector2(DEFAULTS.radiusX, DEFAULTS.radiusY) },
        uOpen: { value: DEFAULTS.open },
        uSeam: { value: DEFAULTS.seam },
        uTearJag: { value: DEFAULTS.tearJag },
        uTearScale: { value: DEFAULTS.tearScale },
        uTearCrawl: { value: DEFAULTS.tearCrawl },
        uEdgeSoft: { value: DEFAULTS.edgeSoft },
        uSeed: { value: DEFAULTS.seed },
        uOpacity: { value: DEFAULTS.opacity },

        uRim: { value: DEFAULTS.rim },
        uRimGlow: { value: DEFAULTS.rimGlow },
        uCore: { value: DEFAULTS.core },
        uCoreGlow: { value: DEFAULTS.coreGlow },
        uThroat: { value: DEFAULTS.throat },
        uThroatGlow: { value: DEFAULTS.throatGlow },

        uCrackCount: { value: DEFAULTS.crackCount },
        uCrackWidth: { value: DEFAULTS.crackWidth },
        uCrackLength: { value: DEFAULTS.crackLength },
        uCrackGlow: { value: DEFAULTS.crackGlow },

        uParallax: { value: DEFAULTS.parallax },
        uSwirl: { value: DEFAULTS.swirl },
        uInteriorFade: { value: DEFAULTS.interiorFade },

        uStarSize: { value: DEFAULTS.starSize },
        uStarTwinkle: { value: DEFAULTS.starTwinkle },
        uStarGain: { value: DEFAULTS.starGain },
        uStarScale: { value: new Vector3(DEFAULTS.starScaleA, DEFAULTS.starScaleB, DEFAULTS.starScaleC) },
        uStarDepth: { value: new Vector3(DEFAULTS.starDepthA, DEFAULTS.starDepthB, DEFAULTS.starDepthC) },
        uStarDrift: { value: new Vector3(DEFAULTS.starDriftA, DEFAULTS.starDriftB, DEFAULTS.starDriftC) },

        uNebulaScale: { value: DEFAULTS.nebulaScale },
        uNebulaSpeed: { value: DEFAULTS.nebulaSpeed },
        uNebulaGain: { value: DEFAULTS.nebulaGain },
        uNebulaDepth: { value: DEFAULTS.nebulaDepth },

        uColorVoid: { value: new Color(DEFAULTS.colorVoid) },
        uColorRim: { value: new Color(DEFAULTS.colorRim) },
        uColorCore: { value: new Color(DEFAULTS.colorCore) },
        uColorCrack: { value: new Color(DEFAULTS.colorCrack) },
        uColorThroat: { value: new Color(DEFAULTS.colorThroat) },
        uColorStarA: { value: new Color(DEFAULTS.colorStarA) },
        uColorStarB: { value: new Color(DEFAULTS.colorStarB) },
        uColorStarC: { value: new Color(DEFAULTS.colorStarC) },
        uColorNebulaA: { value: new Color(DEFAULTS.colorNebulaA) },
        uColorNebulaB: { value: new Color(DEFAULTS.colorNebulaB) }
      }),
      vertexShader: PORTAL_VERTEX,
      fragmentShader: PORTAL_FRAGMENT
    });

    this.mesh = new Mesh(uprightQuad(), this.material);
    this.mesh.name = name;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.renderOrder = renderOrder;
    // The quad is built from uniforms; its bounding sphere means nothing.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
  }

  /** Add this to the ability's group. */
  get object3D() {
    return this.mesh;
  }

  get visible() {
    return this.mesh.visible;
  }

  set visible(v) {
    this.mesh.visible = !!v;
  }

  /**
   * Place the aperture without touching a matrix.
   *
   * @param {THREE.Vector3} anchor  world centre, metres
   * @param {THREE.Vector3} along   the aperture's local +X — for a slit, its length
   * @param {THREE.Vector3} up      the aperture's local +Y, re-orthogonalised
   *
   * The plane's normal comes out as `along × up`, so a rift opened across the
   * cast line faces the caster when you pass the cast direction and world up.
   */
  setPlacement(anchor, along, up) {
    const u = this.material.uniforms;
    u.uAnchor.value.copy(anchor);
    _ax.copy(along).normalize();
    _n.crossVectors(_ax, up).normalize();
    _ay.crossVectors(_n, _ax).normalize();
    u.uAxisX.value.copy(_ax);
    u.uAxisY.value.copy(_ay);
    return this;
  }

  /**
   * Re-resolve every dimension. Every frame, zero-length ones included.
   *
   * *shape* — `radiusX` `radiusY` (metres, half-extents; equal makes a disc,
   * unequal a slit), `margin` (0..1 extra quad around the aperture so the cracks
   * have somewhere to go), `seed`, `opacity`.
   *
   * *the tear* — `open` (0..1; **not** a scale), `seam` (0 unzips from the
   * centre, 1 from the long centreline), `tearJag` (0..1 how uneven the front
   * is), `tearScale` (cycles per metre of crack grain), `tearCrawl` (Hz),
   * `edgeSoft` (0..1 of the field).
   *
   * *the fracture* — `rim` / `rimGlow` / `colorRim`, `core` / `coreGlow` /
   * `colorCore` (the white-hot line), `throat` / `throatGlow` / `colorThroat`
   * (the soft inner glow), `crackCount` / `crackWidth` / `crackLength` /
   * `crackGlow` / `colorCrack`.
   *
   * *the interior* — `parallax` (1 = honest; ship something else),
   * `swirl` (rad/s), `interiorFade`, `colorVoid`; three star shells as
   * `starScaleA/B/C` (stars per metre), `starDepthA/B/C` (metres behind the
   * plane), `starDriftA/B/C` (rad/s), `colorStarA/B/C`, plus the shared
   * `starSize`, `starTwinkle`, `starGain`; and the nebula as `nebulaScale`,
   * `nebulaSpeed`, `nebulaGain`, `nebulaDepth`, `colorNebulaA`, `colorNebulaB`.
   *
   * @param {object} p a plain object. Keep it at module scope and refill it.
   */
  update(p) {
    const u = this.material.uniforms;

    const rx = num(p.radiusX, DEFAULTS.radiusX);
    const ry = num(p.radiusY, DEFAULTS.radiusY);
    const margin = num(p.margin, DEFAULTS.margin);
    u.uRadii.value.set(rx, ry);
    // The quad has to hold the aperture *and* the crown of cracks; sizing it off
    // the same two numbers is what keeps a resized portal from clipping.
    u.uSize.value.set(rx * 2 * (1 + margin), ry * 2 * (1 + margin));

    u.uOpen.value = num(p.open, DEFAULTS.open);
    u.uSeam.value = num(p.seam, DEFAULTS.seam);
    u.uTearJag.value = num(p.tearJag, DEFAULTS.tearJag);
    u.uTearScale.value = num(p.tearScale, DEFAULTS.tearScale);
    u.uTearCrawl.value = num(p.tearCrawl, DEFAULTS.tearCrawl);
    u.uEdgeSoft.value = num(p.edgeSoft, DEFAULTS.edgeSoft);
    u.uSeed.value = num(p.seed, DEFAULTS.seed);
    u.uOpacity.value = num(p.opacity, DEFAULTS.opacity);

    u.uRim.value = num(p.rim, DEFAULTS.rim);
    u.uRimGlow.value = num(p.rimGlow, DEFAULTS.rimGlow);
    u.uCore.value = num(p.core, DEFAULTS.core);
    u.uCoreGlow.value = num(p.coreGlow, DEFAULTS.coreGlow);
    u.uThroat.value = num(p.throat, DEFAULTS.throat);
    u.uThroatGlow.value = num(p.throatGlow, DEFAULTS.throatGlow);

    u.uCrackCount.value = num(p.crackCount, DEFAULTS.crackCount);
    u.uCrackWidth.value = num(p.crackWidth, DEFAULTS.crackWidth);
    u.uCrackLength.value = num(p.crackLength, DEFAULTS.crackLength);
    u.uCrackGlow.value = num(p.crackGlow, DEFAULTS.crackGlow);

    u.uParallax.value = num(p.parallax, DEFAULTS.parallax);
    u.uSwirl.value = num(p.swirl, DEFAULTS.swirl);
    u.uInteriorFade.value = num(p.interiorFade, DEFAULTS.interiorFade);

    u.uStarSize.value = num(p.starSize, DEFAULTS.starSize);
    u.uStarTwinkle.value = num(p.starTwinkle, DEFAULTS.starTwinkle);
    u.uStarGain.value = num(p.starGain, DEFAULTS.starGain);
    u.uStarScale.value.set(
      num(p.starScaleA, DEFAULTS.starScaleA),
      num(p.starScaleB, DEFAULTS.starScaleB),
      num(p.starScaleC, DEFAULTS.starScaleC)
    );
    u.uStarDepth.value.set(
      num(p.starDepthA, DEFAULTS.starDepthA),
      num(p.starDepthB, DEFAULTS.starDepthB),
      num(p.starDepthC, DEFAULTS.starDepthC)
    );
    u.uStarDrift.value.set(
      num(p.starDriftA, DEFAULTS.starDriftA),
      num(p.starDriftB, DEFAULTS.starDriftB),
      num(p.starDriftC, DEFAULTS.starDriftC)
    );

    u.uNebulaScale.value = num(p.nebulaScale, DEFAULTS.nebulaScale);
    u.uNebulaSpeed.value = num(p.nebulaSpeed, DEFAULTS.nebulaSpeed);
    u.uNebulaGain.value = num(p.nebulaGain, DEFAULTS.nebulaGain);
    u.uNebulaDepth.value = num(p.nebulaDepth, DEFAULTS.nebulaDepth);

    copyColor(u.uColorVoid.value, p.colorVoid || DEFAULTS.colorVoid);
    copyColor(u.uColorRim.value, p.colorRim || DEFAULTS.colorRim);
    copyColor(u.uColorCore.value, p.colorCore || DEFAULTS.colorCore);
    copyColor(u.uColorCrack.value, p.colorCrack || DEFAULTS.colorCrack);
    copyColor(u.uColorThroat.value, p.colorThroat || DEFAULTS.colorThroat);
    copyColor(u.uColorStarA.value, p.colorStarA || DEFAULTS.colorStarA);
    copyColor(u.uColorStarB.value, p.colorStarB || DEFAULTS.colorStarB);
    copyColor(u.uColorStarC.value, p.colorStarC || DEFAULTS.colorStarC);
    copyColor(u.uColorNebulaA.value, p.colorNebulaA || DEFAULTS.colorNebulaA);
    copyColor(u.uColorNebulaB.value, p.colorNebulaB || DEFAULTS.colorNebulaB);

    return this;
  }

  dispose() {
    this.mesh.visible = false;
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
