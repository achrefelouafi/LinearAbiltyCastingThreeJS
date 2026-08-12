import {
  AdditiveBlending,
  BackSide,
  Color,
  CylinderGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  ShaderMaterial,
  Sphere,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';

/* ---------------------------------------------------------------------- */
/* PhotonBeamMaterial — a three-dimensional grid of beams, in one draw call */
/* ---------------------------------------------------------------------- */

/**
 * An instanced lattice of thin gaussian beams whose brightness at any pixel is
 * the **closed-form line integral** of a gaussian tube along the view ray.
 *
 * ## Why this is not `vfx/Tube.js`
 *
 * `Tube` is the right module for one beam and it draws a very good one — three
 * passes, core, sheath and halo, and the reason the Nova Beam reads as solid.
 * It is also **one tube per instance of the class**: `t.group`, `t.materials`,
 * `t.geometry`, one path, three meshes. A 4×4×4 lattice is forty-eight beams,
 * which through `Tube` is forty-eight groups and **one hundred and forty-four
 * draw calls** against a budget of twelve. There is no instanced mode to reach
 * for; the module's whole interface is a single `state = {origin, target, …}`.
 * So this file exists, and it borrows `Tube`'s three-layer idea rather than its
 * geometry: the core and the halo are two gaussians of different width summed
 * in one fragment, which is cheaper than two passes and — because they are
 * summed before the blend rather than after it — behaves correctly where four
 * of them overlap, which is the entire point of the ability that uses it.
 *
 * ## The integral, and why it is closed form
 *
 * A beam here is not a surface. It is a line segment with a gaussian density
 * around it, and what you see at a pixel is
 *
 * ```
 *   I = ∫ exp( -d(s)² / σ² ) ds        over the part of the view ray inside the beam
 * ```
 *
 * where `d(s)` is the distance from the ray at parameter `s` to the beam's axis.
 * Because both the ray and the axis are straight, `d(s)²` is exactly a quadratic
 * `A·s² + 2B·s + C`, and the integral of a gaussian in a quadratic is an error
 * function. So it is evaluated in closed form, with the Winitzki approximation
 * to `erf`, in about a dozen instructions.
 *
 * The first version marched it, the way `LightShaft` marches its cone, and that
 * is the version that taught me why this one is worth the algebra. A marched
 * thin beam is *catastrophically* worse than a marched fat cone: the beam is a
 * centimetre or two across, so at sixteen steps down a twelve-metre ray a
 * typical sample count **inside** the beam is one, sometimes zero, and the beam
 * flickers along its length as the dither moves. Pushing to sixty-four steps
 * fixed the flicker and cost forty-eight beams' worth of fill. Worse, the noise
 * lands squarely on the thing the ability is about: a node is bright because two
 * integrals *add*, and two integrals that are each ±40 % noise do not make a
 * node, they make a bright speckle in roughly the right place. Closed form is
 * exact, it is cheaper than eight steps, and the doubling at a crossing is
 * exactly 2.00.
 *
 * ## What it draws
 *
 * One `InstancedBufferGeometry` — a capped unit cylinder per beam — and **one
 * draw call** for the whole lattice, no textures. The hull is only a bound; the
 * beam is solved analytically inside it, so `sides` can be six.
 *
 * Back faces with the depth test off, for `LightShaft`'s reasons and not for a
 * different set that happens to agree: every view ray entering the hull gets
 * exactly one fragment to integrate in whether the camera is inside the lattice
 * or outside it, the caps are on because a ray straight down a beam would
 * otherwise find no back face and punch a hole along its own axis, and occlusion
 * is part of the integral rather than a test — the far limit is the depth
 * buffer, so a beam passing behind the character genuinely stops contributing at
 * the shoulder instead of being thrown away whole.
 *
 * ## Invariants
 *
 * - **I1** — per-beam state is *an index*. Nothing else. Every metre — the
 *   grid's extent, the spacing between nodes, the overhang past the outer nodes,
 *   the beam radius — is resolved from a uniform in the vertex shader each
 *   frame, so a paused lattice re-lays itself under a slider drag and beams
 *   move between families if the node counts change.
 * - **I3** — `sync()` writes into existing uniform boxes; the geometry is
 *   allocated once at `capacity`.
 * - **I5** — four pickers, none derived from another.
 * - **I7/I8** — one mesh, and the uniforms live on `material.uniforms` because
 *   this is a `ShaderMaterial` and not a patched standard one.
 */

/** Beams the geometry is allocated for. 3 × 5 × 5 = 75 is a 5-node lattice. */
export const MAX_PHOTON_BEAMS = 96;

/* ---------------------------------------------------------------------- */
/* Vertex — where a beam is, and how much of it is drawn                   */
/* ---------------------------------------------------------------------- */

/**
 * The whole lattice is derived from one instance index against three live node
 * counts, which is what makes the grid a *slider* rather than a build step.
 *
 * Beams come in three families — those running across (`+side`), those running
 * up (`+up`) and those running downrange (`+along`) — and the index space is
 * laid out as the three families' plane-grids back to back. Family 0 has
 * `gy × gz` members, family 1 has `gx × gz`, family 2 has `gx × gy`. Change
 * `uGrid` and every beam moves, several of them into a different family, with
 * no buffer touched.
 */
const BEAM_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;      // seconds — the only clock this stage reads

  uniform vec3  uAnchor;    // world, on the floor, centre of the footprint
  uniform vec3  uAlong;     // unit, the cast's heading
  uniform vec3  uSide;      // unit, across it
  uniform vec3  uUp;        // unit, normally +Y

  uniform vec3  uGrid;      // node counts per axis (x across, y up, z downrange)
  uniform vec3  uSpan;      // HALF-extents of the lattice, metres
  uniform float uLift;      // metres the lattice centre floats above the floor
  uniform float uOverhang;  // metres a beam runs past the outermost node
  uniform float uSpin;      // radians the lattice is yawed about its own up
  uniform float uSeed;

  uniform float uRadius;    // metres — the core gaussian's sigma
  uniform float uHaloScale; // halo sigma as a multiple of the core's
  uniform float uHullPad;   // sigmas of tail the bounding hull has to cover

  uniform float uAssemble;  // 0..1 — how much of the lattice has been drawn in
  uniform float uStagger;   // 0..1 — how far apart the beams switch on
  uniform float uFlicker;   // 0..1 depth of the per-beam breath
  uniform float uFlickerSpeed; // breaths per second
  uniform float uFade;      // 0..1 master

  attribute float aIndex;

  varying vec3  vWorld;
  varying vec3  vOrigin;    // the beam's start, world metres
  varying vec3  vDir;       // unit, along the beam
  varying vec2  vSpan;      // metres along the beam that are drawn: (from, to)
  varying vec2  vBeam;      // x = amplitude 0..1, y = the beam's full length

  ${noiseGLSL}

  /**
   * Node i of n, as -1..1 across the lattice.
   *
   * A single node on an axis sits in the middle rather than at -1, because a
   * 1 x 4 x 4 lattice should be one plane of crossings and not one face of a
   * box that is not there.
   */
  float latCoord(float i, float n) {
    return n > 1.5 ? (i / (n - 1.0)) * 2.0 - 1.0 : 0.0;
  }

  void main() {
    float gx = max(floor(uGrid.x + 0.5), 1.0);
    float gy = max(floor(uGrid.y + 0.5), 1.0);
    float gz = max(floor(uGrid.z + 0.5), 1.0);
    float nAcross = gy * gz;
    float nUp = gx * gz;
    float nDown = gx * gy;

    if (aIndex > nAcross + nUp + nDown - 0.5) {
      // Collapsed off-screen rather than scaled to zero: a degenerate triangle
      // still rasterises a sliver on some drivers and this shader's fragment is
      // the expensive one.
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    /* ---- the lattice's own frame ---- */
    float cs = cos(uSpin);
    float sn = sin(uSpin);
    vec3 ex = normalize(uSide * cs + uAlong * sn);
    vec3 ez = normalize(uAlong * cs - uSide * sn);
    vec3 ey = uUp;
    vec3 mid = uAnchor + ey * uLift;

    /* ---- which beam is this ---- */
    vec3 dirV;
    vec3 off;
    float reach;
    if (aIndex < nAcross - 0.5) {
      float j = floor(aIndex / gz);
      float k = aIndex - j * gz;
      dirV = ex;
      reach = uSpan.x + uOverhang;
      off = ey * (latCoord(j, gy) * uSpan.y) + ez * (latCoord(k, gz) * uSpan.z);
    } else if (aIndex < nAcross + nUp - 0.5) {
      float slot = aIndex - nAcross;
      float i = floor(slot / gz);
      float k = slot - i * gz;
      dirV = ey;
      reach = uSpan.y + uOverhang;
      off = ex * (latCoord(i, gx) * uSpan.x) + ez * (latCoord(k, gz) * uSpan.z);
    } else {
      float slot = aIndex - nAcross - nUp;
      float i = floor(slot / gy);
      float j = slot - i * gy;
      dirV = ez;
      reach = uSpan.z + uOverhang;
      off = ex * (latCoord(i, gx) * uSpan.x) + ey * (latCoord(j, gy) * uSpan.y);
    }

    float len = max(2.0 * reach, 0.02);
    vec3 origin = mid + off - dirV * reach;

    /* ---- how much of it is drawn, and how bright ---- */
    float dice = hash11(aIndex * 1.7 + uSeed);
    float threshold = dice * uStagger;
    float grow = clamp((uAssemble - threshold) / max(1.0 - uStagger, 1e-3), 0.0, 1.0);

    // Drawn from the middle out. A beam that grows from one end has a *tip*,
    // and a tip travelling along a lattice edge reads as a projectile being
    // fired down a wire; growing symmetrically reads as the beam coming into
    // existence, which is what light does.
    float from = (0.5 - 0.5 * grow) * len;
    float to = (0.5 + 0.5 * grow) * len;

    float breath = 1.0 - uFlicker * 0.5 * (1.0 - cos(uTime * uFlickerSpeed * TAU + dice * TAU));
    float amp = uFade * breath * grow;

    if (amp <= 0.002 || to - from < 1e-4) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vOrigin = origin;
    vDir = dirV;
    vSpan = vec2(from, to);
    vBeam = vec2(amp, len);

    /* ---- the bound ----
     * A gaussian is never zero, so the hull has to cover enough of the tail
     * that clipping it is invisible: uHullPad is in sigmas, and three is about
     * exp(-9) = 1e-4 of the peak. */
    float rad = uRadius * max(uHaloScale, 1.0) * uHullPad;
    float k = position.y + 0.5;
    float a = mix(from, to, k);
    vec3 ref = abs(dot(dirV, vec3(0.0, 1.0, 0.0))) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 perpA = normalize(cross(ref, dirV));
    vec3 perpB = cross(dirV, perpA);
    vec3 world = origin + dirV * a + (perpA * position.x + perpB * position.z) * rad;

    vWorld = world;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

/* ---------------------------------------------------------------------- */
/* Fragment — the closed-form integral                                     */
/* ---------------------------------------------------------------------- */

const BEAM_FRAGMENT = /* glsl */ `
  uniform float uRadius;
  uniform float uHaloScale;
  uniform float uDensity;     // per metre — turns the integral into brightness
  uniform float uCoreGain;
  uniform float uHaloGain;
  uniform float uEndTaper;    // 0..1 of the beam over which the ends fade in
  uniform float uEndTint;     // 0..1 how far the ends take uColorEnd
  uniform float uPulse;       // extra brightness in the travelling band
  uniform float uPulseAt;     // 0..1 along the beam
  uniform float uPulseWidth;  // 0..1 of the beam
  uniform float uIntensity;

  uniform vec3  uColorCore;
  uniform vec3  uColorHalo;
  uniform vec3  uColorEnd;

  uniform sampler2D uSceneDepth;
  uniform vec2      uResolution;
  uniform float     uCameraNear;
  uniform float     uCameraFar;
  uniform float     uGlobalGlow;
  uniform float     uShaderIntensity;

  varying vec3  vWorld;
  varying vec3  vOrigin;
  varying vec3  vDir;
  varying vec2  vSpan;
  varying vec2  vBeam;

  ${commonGLSL}

  /**
   * Winitzki's approximation to erf. Maximum absolute error about 2e-4, which
   * is four orders of magnitude better than the marched version this replaced
   * and costs one exp and one sqrt.
   */
  float erfApprox(float x) {
    float ax = abs(x);
    float x2 = ax * ax;
    float t = (1.2732395447 + 0.147 * x2) / (1.0 + 0.147 * x2);
    return sign(x) * sqrt(1.0 - exp(-x2 * t));
  }

  /**
   * The whole trick, in eight lines.
   *
   * The squared distance from the view ray to the beam's axis is exactly
   * A s^2 + 2B s + C, so completing the square gives a gaussian in (s - sm)
   * whose integral between two limits is a difference of error functions.
   * 0.8862269255 is sqrt(pi)/2.
   *
   * The A -> 0 branch is not a numerical guard bolted on afterwards: it is the
   * case where the eye is looking straight down the beam, the distance to the
   * axis is constant along the whole ray, and the answer is genuinely the
   * segment length times a constant. It is also the case that produces the
   * brightest pixel in the ability, so getting it wrong is not subtle.
   */
  float gaussLine(float qa, float qb, float qc, float s0, float s1, float sigma) {
    float inv = 1.0 / max(sigma, 1e-4);
    if (qa < 1e-8) return (s1 - s0) * exp(-qc * inv * inv);
    float rootA = sqrt(qa);
    float sm = -qb / qa;
    float floorSq = max(qc - qb * qb / qa, 0.0);
    float scale = sigma * 0.8862269255 / rootA;
    float hi = erfApprox(rootA * (s1 - sm) * inv);
    float lo = erfApprox(rootA * (s0 - sm) * inv);
    return exp(-floorSq * inv * inv) * scale * (hi - lo);
  }

  void main() {
    float amp = vBeam.x;
    float len = vBeam.y;
    if (amp <= 0.002) discard;

    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorld - ro);

    vec3 axis = vDir;
    vec3 rel = ro - vOrigin;
    float a0 = dot(rel, axis);
    float ad = dot(rd, axis);

    /* ---- the drawn part of the beam, as a range of s ---- */
    float sNear = 0.0;
    float sFar = 1e6;
    if (abs(ad) > 1e-5) {
      float s1 = (vSpan.x - a0) / ad;
      float s2 = (vSpan.y - a0) / ad;
      sNear = min(s1, s2);
      sFar = max(s1, s2);
    } else if (a0 < vSpan.x || a0 > vSpan.y) {
      discard;
    }

    /* ---- and how far the ray may go before something opaque stops it ---- */
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    float depthBits = unpackRGBAToDepth(texture2D(uSceneDepth, screenUV));
    float sceneViewZ = perspectiveDepthToViewZ(depthBits, uCameraNear, uCameraFar);
    // The third row of the view matrix is the camera's own -Z in world space,
    // which converts a view-space depth into a distance along OUR ray with no
    // inverse projection.
    vec3 row2 = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
    float axialCos = dot(row2, rd);
    float sScene = abs(axialCos) > 1e-4 ? sceneViewZ / axialCos : 1e6;
    if (sScene < 0.0) sScene = 1e6;

    sNear = max(sNear, 0.0);
    sFar = min(sFar, sScene);
    if (sFar <= sNear) discard;

    /* ---- the quadratic ---- */
    vec3 perpRel = rel - axis * a0;
    vec3 perpRay = rd - axis * ad;
    float qa = dot(perpRay, perpRay);
    float qb = dot(perpRay, perpRel);
    float qc = dot(perpRel, perpRel);

    float sigmaCore = max(uRadius, 1e-3);
    float sigmaHalo = sigmaCore * max(uHaloScale, 1.0);
    float core = gaussLine(qa, qb, qc, sNear, sFar, sigmaCore);
    float halo = gaussLine(qa, qb, qc, sNear, sFar, sigmaHalo);
    if (core + halo < 1e-5) discard;

    /* ---- where along the beam this pixel is looking ----
     * The closest approach, clamped into the drawn range. The axial profile is
     * evaluated once there rather than under the integral, which is the one
     * approximation in this file: it is exact for a ray crossing the beam and
     * wrong by half a taper width for a ray running along it, where the taper
     * is the least visible thing on screen anyway. */
    float sMid = qa > 1e-8 ? clamp(-qb / qa, sNear, sFar) : (sNear + sFar) * 0.5;
    float an = clamp((a0 + sMid * ad) / max(len, 1e-4), 0.0, 1.0);

    float taper = smoothstep(0.0, max(uEndTaper, 1e-3), an) *
                  smoothstep(0.0, max(uEndTaper, 1e-3), 1.0 - an);
    float dp = (an - uPulseAt) / max(uPulseWidth, 1e-3);
    float pulse = 1.0 + uPulse * exp(-dp * dp);

    float endMix = clamp(abs(an - 0.5) * 2.0, 0.0, 1.0) * clamp(uEndTint, 0.0, 1.0);
    vec3 tint = mix(uColorCore, uColorEnd, endMix);

    vec3 rgb = tint * (core * uCoreGain) + uColorHalo * (halo * uHaloGain);
    rgb *= uDensity * taper * pulse * amp * uIntensity * uShaderIntensity;

    if (max(max(rgb.r, rgb.g), rgb.b) < 0.003) discard;

    // Alpha 1 with AdditiveBlending (SrcAlpha, One): the destination gets rgb,
    // once, and two beams crossing get exactly the sum of two beams. Writing a
    // luminance into alpha instead — the obvious thing — makes the blend square
    // it, and a node would then be four times a beam rather than twice, which
    // sounds better and is a lie.
    gl_FragColor = vec4(rgb * uGlobalGlow, 1.0);
  }
`;

/* ---------------------------------------------------------------------- */
/* Construction                                                            */
/* ---------------------------------------------------------------------- */

/**
 * The instanced hull. Capped, six-sided, and only ever a bound.
 *
 * @param {number} [capacity=MAX_PHOTON_BEAMS] beams the buffer is sized for
 * @param {number} [sides=6] hull tessellation
 */
export function createPhotonBeamGeometry(capacity = MAX_PHOTON_BEAMS, sides = 6) {
  const count = Math.max(1, Math.round(capacity));
  const slots = new Float32Array(count);
  for (let i = 0; i < count; i++) slots[i] = i;

  const hull = new CylinderGeometry(1, 1, 1, Math.max(3, Math.round(sides)), 1, false);
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', hull.getAttribute('position'));
  geometry.setIndex(hull.getIndex());
  geometry.setAttribute('aIndex', new InstancedBufferAttribute(slots, 1));
  geometry.instanceCount = 0;
  // Placed in world space by the vertex shader; its own bounds mean nothing.
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  // `hull` is deliberately not disposed: the instanced geometry holds its
  // attribute objects by reference and disposing it would tell the renderer to
  // delete GL buffers the mesh is still drawing from. It has never been
  // uploaded on its own, so nothing leaks.
  return geometry;
}

/** Every uniform, with its unit. The ability writes these every frame. */
export function createPhotonBeamMaterial() {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // Occlusion is part of the integral. See the class comment.
    depthTest: false,
    blending: AdditiveBlending,
    side: BackSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uAnchor: { value: new Vector3() },
      uAlong: { value: new Vector3(0, 0, 1) },
      uSide: { value: new Vector3(1, 0, 0) },
      uUp: { value: new Vector3(0, 1, 0) },

      uGrid: { value: new Vector3(4, 4, 4) },
      uSpan: { value: new Vector3(3, 2, 3) },
      uLift: { value: 2.4 },
      uOverhang: { value: 0.5 },
      uSpin: { value: 0 },
      uSeed: { value: 0 },

      uRadius: { value: 0.05 },
      uHaloScale: { value: 4 },
      uHullPad: { value: 3.2 },

      uAssemble: { value: 0 },
      uStagger: { value: 0.55 },
      uFlicker: { value: 0.16 },
      uFlickerSpeed: { value: 1.4 },
      uFade: { value: 1 },

      uDensity: { value: 2.4 },
      uCoreGain: { value: 1 },
      uHaloGain: { value: 0.35 },
      uEndTaper: { value: 0.14 },
      uEndTint: { value: 0.6 },
      uPulse: { value: 0 },
      uPulseAt: { value: 0.5 },
      uPulseWidth: { value: 0.16 },
      uIntensity: { value: 1 },

      uColorCore: { value: new Color(1, 0.98, 0.9) },
      uColorHalo: { value: new Color(0.62, 0.85, 1) },
      uColorEnd: { value: new Color(1, 0.78, 0.45) }
    }),
    vertexShader: BEAM_VERTEX,
    fragmentShader: BEAM_FRAGMENT
  });
}

/**
 * How many beams a node count implies — three families of plane-grids.
 *
 * The ability needs this on the CPU to set `geometry.instanceCount`, and it is
 * the one number the shader and the CPU both have to agree on.
 */
export function photonBeamCount(gx, gy, gz) {
  const x = Math.max(1, Math.round(gx));
  const y = Math.max(1, Math.round(gy));
  const z = Math.max(1, Math.round(gz));
  return Math.min(MAX_PHOTON_BEAMS, y * z + x * z + x * y);
}
