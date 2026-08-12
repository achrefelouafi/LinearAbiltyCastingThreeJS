import {
  AdditiveBlending,
  BackSide,
  Color,
  CylinderGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Sphere,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { getColor } from '../utils/color.js';

/* ---------------------------------------------------------------------- */
/* LightShaft — light in air, integrated along the view ray                */
/* ---------------------------------------------------------------------- */

/**
 * Volumetric shafts: a real in-scattering integral through a cone of lit air,
 * clamped by the depth buffer, landing in a bright band on the ground that is
 * produced by the same integral rather than decalled on afterwards.
 *
 * ## Why this is not `Curtain(SHAFT)`
 *
 * `Curtain` already has a `SHAFT` mode and it is good; it is also a **sheet**,
 * and three of the four things a shaft has to do are not expressible on a sheet.
 * That was checked before this file was written, not asserted after:
 *
 * 1. **Anisotropy.** The single thing that makes light in air read as light in
 *    air is that a shaft seen nearly end-on is several times brighter than the
 *    same shaft seen across. That is the Henyey–Greenstein phase function of the
 *    angle between the view ray and the *shaft's axis*. A sheet's only angular
 *    term is `1/|N·V|` against the *sheet's normal*, which is a proxy for path
 *    length through a fold and points the wrong way: it peaks when you look
 *    along the sheet, not when you look along the beam. Curtain's own
 *    documentation is honest about what that term is for.
 * 2. **A path length that is a path length.** A sheet has no thickness, so its
 *    brightness is a function of where you hit it. Here the ray genuinely enters
 *    and leaves a cone, and the segment between them is integrated. Move the
 *    camera towards the axis and the segment lengthens on its own; no term had
 *    to be written to make that happen.
 * 3. **A soft floor intersection.** A sheet meeting the ground gives a straight
 *    cut, which is why Curtain has `footFade`. Here the far end of the integral
 *    is the depth buffer, feathered over `contact` metres, so the shaft dies
 *    into whatever it actually meets — floor, character, a rock — at the right
 *    distance and with the right shape.
 * 4. **The band on the ground.** Curtain's floor companion is a second quad with
 *    its own pool term, and the README says so. Here the band *is* the shaft:
 *    the view ray terminates on the floor, we know where, and we evaluate the
 *    shaft's own radial falloff, its own gobo silhouette and its own axial
 *    extinction at that point and add the bounce. Drag `gobo` and the leaf-gaps
 *    on the floor change with the gaps in the air, because they are one field.
 *
 * Extending `Curtain` would have meant a second geometry, a second placement
 * path, a second integral and a mode that shares nothing with the other two but
 * the file. `Curtain(SHAFT)` remains the right answer for a rank of cheap
 * god-rays behind something; this is the right answer when the shaft is the
 * subject.
 *
 * ## What it draws
 *
 * One `InstancedBufferGeometry` — a tapered hull per shaft — and **one draw
 * call** for all of them, no textures. The hull is only a bound: everything
 * visible is solved analytically against the shaft primitive inside it, so the
 * hull's tessellation changes nothing but the silhouette of the region that gets
 * fragments.
 *
 * The material renders **back faces with the depth test off**. Back faces
 * because every view ray that enters the hull then has exactly one fragment to
 * do its integral in, whether the camera is inside the hull or outside it; the
 * caps are on for the same reason (open-ended, a ray straight down the axis
 * finds no back face and punches a hole through the middle of the shaft). The
 * depth test is off because occlusion is *part of the integral* — a shaft behind
 * a wall must be dark because its light never reaches you, not because a test
 * threw the fragment away, and the difference shows the moment a character's
 * shoulder is halfway into it.
 *
 * ## Invariants
 *
 * - **I1** — per-shaft state is four dice and an index. Every metre — length,
 *   the two radii, spacing, ring radius, scatter — is re-resolved from `update()`
 *   each frame in the vertex shader, so a paused shaft re-lays itself under a
 *   slider drag. There is nothing dimensional on the CPU but the scratch vectors
 *   that place the anchor.
 * - **I3** — `roll()` refills existing typed arrays; `update()` writes into
 *   existing uniform boxes; the CPU mirrors write into a caller's `out`.
 * - **I5** — four pickers (`colorMouth`, `colorFoot`, `colorMote`, `colorPool`),
 *   none derived from another.
 * - **I6** — no light pool use at all. A shaft is not a `PointLight`.
 *
 * @example
 *   // construction — godspear
 *   this.shafts = new LightShaft(this.group, { layout: ShaftLayout.LINE, capacity: 8 });
 *
 *   // module scope
 *   const _shaft = lightShaftParams();
 *
 *   // onSpawn
 *   this.shafts.roll();
 *
 *   // every frame
 *   this.shafts.setPlacement(this.origin, this.direction, _up);
 *   _shaft.count  = c.shaftCount;
 *   _shaft.length = c.shaftLength;          // metres, re-read every frame
 *   _shaft.sweep  = this.travel;            // 0..1 — which shaft is lit now
 *   this.shafts.update(_shaft);
 *
 *   // and the scene's own dust, brightened as it crosses one:
 *   const lit = this.shafts.irradianceAt(motePosition, _shaft);   // 0..1
 */

/** How the shafts are laid out around the anchor. A uniform, not a `#define`. */
export const ShaftLayout = Object.freeze({
  SINGLE: 0,
  LINE: 1,
  RING: 2,
  SCATTER: 3
});

/** Human names, for the editor and for `check.mjs` error messages. */
export const SHAFT_LAYOUT_NAMES = Object.freeze(['SINGLE', 'LINE', 'RING', 'SCATTER']);

/* ---------------------------------------------------------------------- */
/* Vertex — the hull, and nothing else                                     */
/* ---------------------------------------------------------------------- */

/**
 * The hull is a unit capped cylinder that the vertex shader bends into each
 * shaft's own truncated cone.
 *
 * It carries no lighting at all. Everything the fragment needs about the shaft
 * arrives as five varyings describing the *primitive* — mouth, axis, length,
 * the two radii — and the fragment solves against those, not against the
 * triangles. That is why `sides` can be twelve: the hull is a bound, and a
 * coarser bound only means slightly more fragments that immediately find no
 * intersection and discard.
 */
const SHAFT_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  #define SL_SINGLE  0
  #define SL_LINE    1
  #define SL_RING    2
  #define SL_SCATTER 3

  uniform vec3  uAnchor;     // world, on the floor
  uniform vec3  uAlong;      // unit, the cast's heading
  uniform vec3  uSide;       // unit, across it
  uniform vec3  uUp;         // unit, the shaft's own up. Pass -frame.uLightDir for sun shafts

  uniform float uLayout;
  uniform float uCount;
  uniform float uSpacing;    // metres between shafts (LINE)
  uniform float uRing;       // metres (RING)
  uniform float uScatter;    // metres of positional slop
  uniform float uSeed;

  uniform float uLength;        // metres, mouth to foot
  uniform float uRadiusMouth;   // metres
  uniform float uRadiusFoot;    // metres
  uniform float uLengthJitter;  // 0..1
  uniform float uRadiusJitter;  // 0..1
  uniform float uHullPad;       // how much wider than the shaft the bound is

  uniform float uFade;
  uniform float uSweep;       // 0..1 — where the lit window sits along the rank
  uniform float uSweepWidth;  // 0..1 of the rank

  attribute float aIndex;
  attribute vec4  aDice;      // four unitless rolls. The only captured state

  varying vec3  vMouth;
  varying vec3  vAxis;        // unit, pointing DOWN the shaft
  varying vec3  vWorld;
  varying vec3  vRadii;       // x = at the mouth, y = at the foot, z = length
  varying vec2  vShaft;       // x = per-shaft amplitude, y = seed

  void main() {
    if (aIndex > uCount - 0.5) {
      // Collapsed off-screen rather than scaled to zero: a degenerate triangle
      // still rasterises a sliver on some drivers, and this shader's fragment is
      // the expensive one in the file.
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    float slot = uCount > 1.5 ? aIndex / (uCount - 1.0) : 0.5;

    /* ---- where this shaft stands ---- */
    vec3 offset = vec3(0.0);
    // NOT called 'layout': that identifier is a keyword in GLSL ES 3.00, and a
    // shader that only ever compiles under 1.00 today is one glslVersion away
    // from a build error nobody would connect to this line.
    // (And no backticks in here. This comment cost a round-trip proving that
    // README trap #1 is still live in 2026.)
    int rank = int(uLayout + 0.5);
    if (rank == SL_LINE) {
      offset = uAlong * ((aIndex - (uCount - 1.0) * 0.5) * uSpacing);
    } else if (rank == SL_RING) {
      float bearing = TAU * (aIndex / max(uCount, 1.0)) + uSeed;
      offset = (uSide * cos(bearing) + uAlong * sin(bearing)) * uRing;
    } else if (rank == SL_SCATTER) {
      float bearing = TAU * aDice.x;
      float reach = sqrt(aDice.y) * uRing;
      offset = (uSide * cos(bearing) + uAlong * sin(bearing)) * reach;
    }
    offset += (uSide * (aDice.z - 0.5) + uAlong * (aDice.w - 0.5)) * uScatter;

    /* ---- how big it is, resolved from live metres every frame ---- */
    float len = max(uLength * (1.0 + (aDice.x - 0.5) * uLengthJitter), 0.05);
    float jr = 1.0 + (aDice.y - 0.5) * uRadiusJitter;
    float rMouth = max(uRadiusMouth * jr, 0.01);
    float rFoot = max(uRadiusFoot * jr, 0.01);

    vec3 axis = normalize(-uUp);
    vec3 foot = uAnchor + offset;
    vec3 mouth = foot - axis * len;

    /* ---- the sweep: a window travelling down the rank ---- */
    float window = 1.0;
    if (uSweepWidth < 0.999) {
      float d = abs(slot - uSweep) / max(uSweepWidth, 1e-3);
      window = 1.0 - smoothstep(0.6, 1.0, d);
    }

    vMouth = mouth;
    vAxis = axis;
    vRadii = vec3(rMouth, rFoot, len);
    vShaft = vec2(uFade * window, aDice.z * 37.0 + aIndex * 11.7 + uSeed);

    /* ---- the bound ----
     * position.y is +0.5 at the mouth and -0.5 at the foot; the caps sit at
     * those two planes with |position.xz| <= 1, so one expression places wall
     * and cap alike. */
    float k = 0.5 - position.y;                 // 0 at the mouth, 1 at the foot
    float rad = mix(rMouth, rFoot, k) * uHullPad;
    // The same basis the fragment derives, by the same rule, so the hull cannot
    // end up rotated a few degrees off the primitive it is supposed to bound.
    // Derived rather than passed: two more varyings to save four instructions.
    vec3 ref = abs(axis.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 perpA = normalize(cross(ref, axis));
    vec3 perpB = cross(axis, perpA);
    vec3 world = mouth + axis * (k * len) + (perpA * position.x + perpB * position.z) * rad;

    vWorld = world;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

/* ---------------------------------------------------------------------- */
/* Fragment — the integral                                                 */
/* ---------------------------------------------------------------------- */

const SHAFT_FRAGMENT = /* glsl */ `
  uniform float uTime;

  /* ---- the medium ---- */
  uniform float uSteps;        // marching samples; capped by MAX_STEPS
  uniform float uJitter;       // 0..1 dither on the first sample, kills the banding
  uniform float uDensity;      // per metre — the in-scattering coefficient
  uniform float uExtinct;      // 1/metres, down the shaft: the beam loses energy
  uniform float uSoft;         // widens the gaussian core. NOT an edge
  uniform float uAxialCurve;   // how the medium thins toward the mouth
  uniform float uAxialMouth;   // 0..1 density AT the mouth — never let this be 0
  uniform float uAnisotropy;   // -0.95..0.95, the Henyey-Greenstein g
  uniform float uContact;      // metres of feather where the shaft meets geometry

  /* ---- the shaft's own silhouette ---- */
  uniform float uGobo;         // 0..1 how much of the shaft the gaps eat
  uniform float uGoboScale;    // cycles per metre, across the shaft
  uniform float uGoboBias;     // moves the gate: bigger = more open sky
  uniform float uGoboDrift;    // radians/second the canopy stirs

  /* ---- dust ---- */
  uniform float uMote;         // 0 disables the lattice outright
  uniform float uMoteScale;    // cells per metre
  uniform float uMoteSize;     // 0..1 of a cell
  uniform float uMoteFall;     // cells/second the lattice drifts down

  /* ---- the ground ---- */
  uniform float uBounce;       // how much of the landed light comes back at you
  uniform float uPoolSoft;     // widens the band's gaussian
  uniform float uLandBand;     // metres either side of the foot plane that count

  /* ---- output ---- */
  uniform float uIntensity;
  uniform vec3  uColorMouth;
  uniform vec3  uColorFoot;
  uniform vec3  uColorMote;
  uniform vec3  uColorPool;

  uniform sampler2D uSceneDepth;
  uniform vec2      uResolution;
  uniform float     uCameraNear;
  uniform float     uCameraFar;
  uniform float     uGlobalGlow;
  uniform float     uShaderIntensity;

  varying vec3  vMouth;
  varying vec3  vAxis;
  varying vec3  vWorld;
  varying vec3  vRadii;
  varying vec2  vShaft;

  ${noiseGLSL}
  ${commonGLSL}

  /**
   * Henyey-Greenstein, normalised so g = 0 gives exactly 1.
   *
   * This is the whole reason the module exists. 'c' is the cosine between the
   * direction the light is travelling and the direction it would have to go to
   * reach the eye; at g = 0.7 a shaft looked at nearly end-on is about eight
   * times the brightness of the same shaft looked at across, and that ratio is
   * what the eye reads as "there is light in the air" rather than "there is a
   * translucent cone in the scene".
   *
   * The denominator is (1 + g^2 - 2gc)^1.5 and cannot go negative for |g| < 1,
   * because its minimum is (1 - |g|)^2. It is still clamped: g arrives from a
   * slider and 1.0 is one drag away.
   */
  float shaftPhase(float g, float c) {
    float gg = clamp(g, -0.95, 0.95);
    float d = 1.0 + gg * gg - 2.0 * gg * c;
    return (1.0 - gg * gg) / pow(max(d, 1e-4), 1.5);
  }

  /** The canopy the light came through. Fixed across the shaft, so gaps are gaps. */
  float shaftGobo(vec2 cross2, float seed) {
    if (uGobo <= 0.0) return 1.0;
    float n = snoise(vec3(cross2 * uGoboScale, seed + uTime * uGoboDrift));
    return mix(1.0, smoothstep(-uGoboBias, uGoboBias + 0.4, n), uGobo);
  }

  void main() {
    float amp = vShaft.x;
    if (amp <= 0.002) discard;

    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorld - ro);

    vec3 O = vMouth;
    vec3 D = vAxis;
    float len = vRadii.z;
    float rMouth = vRadii.x;
    float rFoot = vRadii.y;
    float rMax = max(rMouth, rFoot);

    /* ---- how far the ray may go before something opaque stops it ---- */
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    float depthBits = unpackRGBAToDepth(texture2D(uSceneDepth, screenUV));
    float sceneViewZ = perspectiveDepthToViewZ(depthBits, uCameraNear, uCameraFar);
    // The third row of the view matrix is the camera's own -Z in world space, so
    // this converts a view-space depth into a distance along OUR ray without
    // needing the inverse projection.
    vec3 row2 = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
    float axialCos = dot(row2, rd);
    float sScene = abs(axialCos) > 1e-4 ? sceneViewZ / axialCos : 1e6;
    if (sScene < 0.0) sScene = 1e6;

    /* ---- the axial slab: 0 <= a <= len ---- */
    vec3 w = ro - O;
    float a0 = dot(w, D);
    float ad = dot(rd, D);
    float sNear = 0.0;
    float sFar = 1e6;
    if (abs(ad) > 1e-5) {
      float s1 = -a0 / ad;
      float s2 = (len - a0) / ad;
      sNear = min(s1, s2);
      sFar = max(s1, s2);
    } else if (a0 < 0.0 || a0 > len) {
      discard;
    }

    /* ---- the enclosing cylinder ---- */
    vec3 wp = w - D * a0;
    vec3 rp = rd - D * ad;
    float A = dot(rp, rp);
    float B = 2.0 * dot(wp, rp);
    float C = dot(wp, wp) - rMax * rMax;
    if (A > 1e-6) {
      float disc = B * B - 4.0 * A * C;
      if (disc < 0.0) discard;
      float sq = sqrt(disc);
      sNear = max(sNear, (-B - sq) / (2.0 * A));
      sFar = min(sFar, (-B + sq) / (2.0 * A));
    } else if (C > 0.0) {
      discard;
    }

    sNear = max(sNear, 0.0);
    // Beyond the scene surface plus the contact feather there is nothing left to
    // integrate, so the march stops there rather than spending samples inside a
    // wall. The feather itself is applied per sample, below.
    sFar = min(sFar, sScene + uContact);
    if (sFar <= sNear) discard;

    /* ---- march ---- */
    float steps = clamp(uSteps, 4.0, float(MAX_STEPS));
    float ds = (sFar - sNear) / steps;
    float dither = uJitter * (hash13(vec3(gl_FragCoord.xy, uTime * 60.0)) - 0.5);
    float s = sNear + ds * (0.5 + dither);

    // A basis across the shaft, derived rather than passed: two more varyings
    // would have cost a slot on WebGL1 hardware to save four instructions.
    vec3 up = abs(D.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 sideA = normalize(cross(up, D));
    vec3 sideB = cross(D, sideA);

    float accMouth = 0.0;
    float accFoot = 0.0;
    float accMote = 0.0;

    for (int i = 0; i < MAX_STEPS; i++) {
      if (float(i) >= steps) break;

      vec3 P = ro + rd * s;
      float a = dot(P - O, D);
      float k = clamp(a / len, 0.0, 1.0);

      vec3 off = (P - O) - D * a;
      float rad = mix(rMouth, rFoot, k);
      float r2 = dot(off, off);
      // A gaussian, not a smoothstep. A shaft has a falloff, not an edge, and a
      // smoothstep draws the surface of the cone you were trying not to have.
      float fall = exp(-r2 / max(rad * rad * uSoft, 1e-6));

      if (fall > 0.0015) {
        vec2 cross2 = vec2(dot(off, sideA), dot(off, sideB));
        float gate = shaftGobo(cross2, vShaft.y);
        // Thinner near the mouth: dust settles, and a column of even density
        // reads as a solid object because nothing about it varies. The mix
        // floor is not tidiness — a bare pow(k, c) is exactly zero at the mouth,
        // which puts a hard flat disc of nothing where the shaft enters and
        // reads as the shaft having been cut off with scissors.
        float axial = mix(uAxialMouth, 1.0, pow(k, max(uAxialCurve, 0.001)));
        // Feathered against whatever is in front. This is the soft intersection:
        // the medium stops existing over uContact metres as it reaches the floor.
        float clip = smoothstep(0.0, max(uContact, 1e-3), sScene - s);
        float dens = fall * gate * axial * clip;
        float trans = exp(-max(uExtinct, 0.0) * a);
        float lit = dens * trans;

        accMouth += lit * (1.0 - k);
        accFoot += lit * k;

        if (uMote > 0.0) {
          vec3 q = P * uMoteScale + vec3(0.0, uTime * uMoteFall, 0.0);
          vec3 ci = floor(q);
          vec3 cf = fract(q);
          vec3 o = hash31(dot(ci, vec3(7.13, 113.17, 31.71)));
          float d = length(cf - o);
          accMote += smoothstep(max(uMoteSize, 1e-3), 0.0, d) * lit;
        }
      }

      s += ds;
    }

    float scale = ds * uDensity;
    accMouth *= scale;
    accFoot *= scale;
    accMote *= scale;

    /* ---- anisotropy ----
     * cos between the direction the light travels (D) and the direction back to
     * the eye (-rd). Looking up the shaft toward its mouth gives c -> 1 and the
     * forward lobe. */
    float phase = shaftPhase(uAnisotropy, dot(D, -rd));

    /* ---- the band on the ground ----
     * Not a decal. The ray stopped somewhere; if that somewhere is inside the
     * shaft's footprint and near its foot plane, the light that landed there is
     * bouncing back at us, and it carries the same radial falloff, the same
     * canopy gaps and the same axial extinction the air above it has. */
    float pool = 0.0;
    if (uBounce > 0.0 && sScene < 1e5) {
      vec3 hit = ro + rd * sScene;
      float ha = dot(hit - O, D);
      vec3 hoff = (hit - O) - D * ha;
      float hk = clamp(ha / len, 0.0, 1.0);
      float hrad = mix(rMouth, rFoot, hk);
      float hfall = exp(-dot(hoff, hoff) / max(hrad * hrad * uPoolSoft, 1e-6));
      float band = 1.0 - smoothstep(0.0, max(uLandBand, 1e-3), abs(ha - len));
      vec2 hcross = vec2(dot(hoff, sideA), dot(hoff, sideB));
      // Lambert against a horizontal receiver. The module cannot know the real
      // normal without a normal buffer, and the ground is what a shaft lands on.
      float lambert = clamp(-D.y, 0.0, 1.0);
      pool = hfall * band * shaftGobo(hcross, vShaft.y) * exp(-max(uExtinct, 0.0) * ha) * lambert;
    }

    float gain = amp * uIntensity * uShaderIntensity;
    vec3 rgb = (uColorMouth * accMouth + uColorFoot * accFoot) * phase;
    rgb += uColorMote * (accMote * uMote);
    rgb += uColorPool * (pool * uBounce);
    rgb *= gain;

    float lum = max(max(rgb.r, rgb.g), rgb.b);
    if (lum < 0.003) discard;

    // Alpha 1 with AdditiveBlending (SrcAlpha, One) means the destination gets
    // rgb, once. Writing the luminance here instead — the obvious thing — makes
    // the blend square it, so every dim part of the shaft goes to nothing and
    // only the core survives. Light adds; it does not add proportionally to how
    // bright it already is.
    gl_FragColor = vec4(rgb * uGlobalGlow, 1.0);
  }
`;

/* ---------------------------------------------------------------------- */
/* Params                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * Every canonical key with its default and its unit.
 *
 * Hold one at module scope, fill it from `settings[id]` every frame, hand it to
 * `update()`. Nothing here is remembered between calls.
 */
export function lightShaftParams() {
  return {
    /* --- the rank --- */
    layout: ShaftLayout.SINGLE,
    count: 1, // shafts drawn; clamped to the capacity
    spacing: 3.2, // metres between shafts (LINE)
    ring: 4, // metres (RING / SCATTER reach)
    scatter: 0.4, // metres of positional slop
    seed: 0, // decorrelates two casts. A dice roll, safe to capture

    /* --- the shaft --- */
    length: 9, // metres, mouth to foot
    radiusMouth: 0.5, // metres — narrow at the source
    radiusFoot: 1.6, // metres — a cone if these differ, a cylinder if they do not
    lengthJitter: 0.15, // 0..1
    radiusJitter: 0.2, // 0..1
    hullPad: 1.35, // how much wider than the shaft the bound is. Cheap insurance

    /* --- the medium --- */
    steps: 28, // marching samples, capped by the compile-time MAX_STEPS
    jitter: 0.9, // 0..1 dither on the first sample
    density: 0.5, // per metre — the in-scattering coefficient
    extinct: 0.06, // 1/metres down the shaft
    soft: 0.55, // widens the gaussian core
    axialCurve: 0.55, // how the medium thins toward the mouth
    axialMouth: 0.4, // 0..1 density at the mouth. Zero cuts the shaft off flat
    anisotropy: 0.62, // -0.95..0.95 Henyey-Greenstein g. THE slider
    contact: 0.7, // metres of feather where the shaft meets geometry

    /* --- the canopy --- */
    gobo: 0.55, // 0..1 how much of the shaft the gaps eat
    goboScale: 0.5, // cycles per metre across the shaft
    goboBias: 0.18, // bigger = more open sky
    goboDrift: 0.08, // radians/second the canopy stirs

    /* --- dust --- */
    mote: 0.7, // 0 disables the lattice outright
    moteScale: 2.6, // cells per metre
    moteSize: 0.13, // 0..1 of a cell
    moteFall: 0.09, // cells/second the lattice drifts down

    /* --- the ground --- */
    bounce: 0.9, // how much of the landed light comes back at you
    poolSoft: 0.75, // widens the band's gaussian
    landBand: 0.5, // metres either side of the foot plane that count

    /* --- the beats --- */
    fade: 1, // 0..1 master fade
    sweep: 0.5, // 0..1 where the lit window sits along the rank
    sweepWidth: 1, // 0..1 of the rank; 1 lights everything

    /* --- output --- */
    intensity: 1,
    colorMouth: '#fff4d6', // where it enters
    colorFoot: '#ffd79a', // where it lands
    colorMote: '#fffbee', // the dust
    colorPool: '#ffe6b4', // the band on the ground

    /* --- global multipliers (settings.global.*, 1 = neutral) --- */
    noiseStrength: 1,
    noiseFrequency: 1,
    noiseSpeed: 1,
    opacityScale: 1
  };
}

/* ---------------------------------------------------------------------- */
/* Scratch — module scope, per invariant I3                                */
/* ---------------------------------------------------------------------- */

const _along = new Vector3(0, 0, 1);
const _up = new Vector3(0, 1, 0);
const _side = new Vector3(1, 0, 0);
const _axis = new Vector3(0, -1, 0);
const _foot = new Vector3();
const _rel = new Vector3();

/** Mulberry-ish: a deterministic 0..1 stream from one integer seed. */
function diceStream(seed) {
  let t = (seed * 1013904223 + 1664525) >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------------- */
/* The module                                                              */
/* ---------------------------------------------------------------------- */

export class LightShaft {
  /**
   * @param {THREE.Object3D} parent the ability's group
   * @param {object} [options]
   * @param {number} [options.capacity=6]   hard ceiling on shafts
   * @param {number} [options.layout=ShaftLayout.SINGLE] initial layout; live after
   * @param {number} [options.sides=14]     hull tessellation. It is only a bound
   * @param {number} [options.maxSteps=48]  compile-time cap on the march
   * @param {number} [options.layer=LAYER.VFX]
   * @param {number} [options.renderOrder=10]
   * @param {string} [options.name]
   */
  constructor(parent, options = {}) {
    const {
      capacity = 6,
      layout = ShaftLayout.SINGLE,
      sides = 14,
      maxSteps = 48,
      layer = LAYER.VFX,
      renderOrder = 10,
      name = null
    } = options;

    this.parent = parent;
    this.capacity = Math.max(1, Math.round(capacity));
    this.maxSteps = Math.max(4, Math.round(maxSteps));
    this._count = 0;

    /** Four unitless rolls per shaft. The only state a cast captures. */
    this._dice = new Float32Array(this.capacity * 4);
    const slots = new Float32Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) slots[i] = i;
    this.roll(0);

    // Capped, not open-ended: a ray straight down the axis of an open tube finds
    // no back face and leaves a hole in the middle of the shaft — which reads as
    // a ring of light with a dead centre, exactly wrong.
    const hull = new CylinderGeometry(1, 1, 1, Math.max(3, Math.round(sides)), 1, false);
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', hull.getAttribute('position'));
    geometry.setIndex(hull.getIndex());
    geometry.setAttribute('aIndex', new InstancedBufferAttribute(slots, 1));
    geometry.setAttribute('aDice', new InstancedBufferAttribute(this._dice, 4));
    geometry.instanceCount = 0;
    // Placed in world space by the vertex shader; its own bounds mean nothing.
    geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    // `hull` is deliberately NOT disposed: the instanced geometry above holds
    // its attribute objects by reference, and `BufferGeometry#dispose()` tells
    // the renderer to delete the GL buffers *for those attributes*. It has never
    // been uploaded so nothing leaks, and disposing it would eventually delete
    // buffers out from under the mesh that is still drawing them.
    this.geometry = geometry;

    this.material = new ShaderMaterial({
      defines: { MAX_STEPS: this.maxSteps },
      transparent: true,
      depthWrite: false,
      // Occlusion is part of the integral, not a test. See the class comment.
      depthTest: false,
      blending: AdditiveBlending,
      side: BackSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uAnchor: { value: new Vector3() },
        uAlong: { value: new Vector3(0, 0, 1) },
        uSide: { value: new Vector3(1, 0, 0) },
        uUp: { value: new Vector3(0, 1, 0) },

        uLayout: { value: layout },
        uCount: { value: 1 },
        uSpacing: { value: 3.2 },
        uRing: { value: 4 },
        uScatter: { value: 0.4 },
        uSeed: { value: 0 },

        uLength: { value: 9 },
        uRadiusMouth: { value: 0.5 },
        uRadiusFoot: { value: 1.6 },
        uLengthJitter: { value: 0.15 },
        uRadiusJitter: { value: 0.2 },
        uHullPad: { value: 1.35 },

        uFade: { value: 1 },
        uSweep: { value: 0.5 },
        uSweepWidth: { value: 1 },

        uSteps: { value: 28 },
        uJitter: { value: 0.9 },
        uDensity: { value: 0.5 },
        uExtinct: { value: 0.06 },
        uSoft: { value: 0.55 },
        uAxialCurve: { value: 0.55 },
        uAxialMouth: { value: 0.4 },
        uAnisotropy: { value: 0.62 },
        uContact: { value: 0.7 },

        uGobo: { value: 0.55 },
        uGoboScale: { value: 0.5 },
        uGoboBias: { value: 0.18 },
        uGoboDrift: { value: 0.08 },

        uMote: { value: 0.7 },
        uMoteScale: { value: 2.6 },
        uMoteSize: { value: 0.13 },
        uMoteFall: { value: 0.09 },

        uBounce: { value: 0.9 },
        uPoolSoft: { value: 0.75 },
        uLandBand: { value: 0.5 },

        uIntensity: { value: 1 },
        uColorMouth: { value: new Color(1, 0.96, 0.84) },
        uColorFoot: { value: new Color(1, 0.84, 0.6) },
        uColorMote: { value: new Color(1, 0.98, 0.93) },
        uColorPool: { value: new Color(1, 0.9, 0.7) }
      }),
      vertexShader: SHAFT_VERTEX,
      fragmentShader: SHAFT_FRAGMENT
    });

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = name ?? `LightShaft:${SHAFT_LAYOUT_NAMES[layout] ?? layout}`;
    this.mesh.layers.set(layer);
    this.mesh.renderOrder = renderOrder;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;

    parent?.add(this.mesh);
  }

  get object3D() {
    return this.mesh;
  }

  /** One, for any number of shafts. */
  get drawCalls() {
    return 1;
  }

  /** Shafts currently drawn → the ability's `instanceCount`. */
  get instanceCount() {
    return this._count;
  }

  get layout() {
    return this.material.uniforms.uLayout.value;
  }

  set layout(value) {
    this.material.uniforms.uLayout.value = value;
  }

  get visible() {
    return this.mesh.visible;
  }

  set visible(value) {
    this.mesh.visible = value;
  }

  /**
   * The frame the rank is laid out in.
   *
   * `up` is the shaft's own up, and it is the interesting argument: hand it
   * `-frame.uLightDir` and the shafts slant with the stage's own sun, which is
   * the difference between "there is a spotlight here" and "the light in this
   * room is coming through something".
   */
  setPlacement(anchor, along, up) {
    const u = this.material.uniforms;
    if (anchor) u.uAnchor.value.copy(anchor);

    _along.copy(along ?? _along);
    if (_along.lengthSq() < 1e-8) _along.set(0, 0, 1);
    _along.normalize();

    _up.copy(up ?? _up);
    if (_up.lengthSq() < 1e-8) _up.set(0, 1, 0);
    _up.normalize();

    _side.crossVectors(_up, _along);
    if (_side.lengthSq() < 1e-8) _side.set(1, 0, 0);
    _side.normalize();

    u.uAlong.value.copy(_along);
    u.uUp.value.copy(_up);
    u.uSide.value.copy(_side);
    return this;
  }

  /**
   * Re-roll the per-shaft dice. The only place random numbers are written.
   *
   * Every one is unitless: two for the scatter disc, one for the length jitter
   * (also reused as the scatter bearing, which decorrelates fine and saves an
   * attribute), one for the radius jitter. What they turn into is resolved from
   * live metres in the vertex shader, every frame — which is why a paused rank
   * re-lays itself when `spacing` moves.
   */
  roll(seed = Math.random() * 100) {
    const next = diceStream(Math.floor(Math.abs(seed) * 1013) + 7);
    for (let i = 0; i < this._dice.length; i++) this._dice[i] = next();
    if (this.geometry) this.geometry.getAttribute('aDice').needsUpdate = true;
    this.material && (this.material.uniforms.uSeed.value = seed);
    return this;
  }

  /** Leaves the instance reusable — the pooling contract. */
  reset() {
    this._count = 0;
    if (this.geometry) this.geometry.instanceCount = 0;
    this.mesh.visible = false;
    return this;
  }

  /**
   * Re-resolve every metre from the live params.
   *
   * There is no clock argument, for the reason `Curtain` ignores its one: every
   * animated term is driven by `frame.uTime` inside the shader and every beat
   * arrives as a unitless `0..1` on `p`. Allocation-free, correct on a
   * zero-length frame.
   *
   * @param {object} p live params — see `lightShaftParams()`
   */
  update(p) {
    const u = this.material.uniforms;

    const nf = p.noiseFrequency ?? 1;
    const ns = p.noiseStrength ?? 1;
    const nsp = p.noiseSpeed ?? 1;

    const count = Math.max(0, Math.min(this.capacity, Math.round(p.count ?? 1)));
    this._count = count;
    this.geometry.instanceCount = count;
    this.mesh.visible = count > 0 && (p.fade ?? 1) > 0.0005;

    u.uLayout.value = p.layout ?? ShaftLayout.SINGLE;
    u.uCount.value = Math.max(1, count);
    u.uSpacing.value = p.spacing ?? 3.2;
    u.uRing.value = Math.max(0, p.ring ?? 4);
    u.uScatter.value = Math.max(0, p.scatter ?? 0.4);
    if (p.seed !== undefined && p.seed !== null) u.uSeed.value = p.seed;

    u.uLength.value = Math.max(0.05, p.length ?? 9);
    u.uRadiusMouth.value = Math.max(0.01, p.radiusMouth ?? 0.5);
    u.uRadiusFoot.value = Math.max(0.01, p.radiusFoot ?? 1.6);
    u.uLengthJitter.value = Math.max(0, Math.min(1, p.lengthJitter ?? 0.15));
    u.uRadiusJitter.value = Math.max(0, Math.min(1, p.radiusJitter ?? 0.2));
    u.uHullPad.value = Math.max(1, p.hullPad ?? 1.35);

    u.uFade.value = (p.fade ?? 1) * (p.opacityScale ?? 1);
    u.uSweep.value = p.sweep ?? 0.5;
    u.uSweepWidth.value = Math.max(0.01, p.sweepWidth ?? 1);

    /* ---- the medium ---- */
    u.uSteps.value = Math.max(4, Math.min(this.maxSteps, Math.round(p.steps ?? 28)));
    u.uJitter.value = Math.max(0, p.jitter ?? 0.9);
    u.uDensity.value = Math.max(0, p.density ?? 0.5);
    u.uExtinct.value = Math.max(0, p.extinct ?? 0.06);
    u.uSoft.value = Math.max(0.02, p.soft ?? 0.55);
    u.uAxialCurve.value = Math.max(0, p.axialCurve ?? 0.55);
    u.uAxialMouth.value = Math.max(0, Math.min(1, p.axialMouth ?? 0.4));
    u.uAnisotropy.value = Math.max(-0.95, Math.min(0.95, p.anisotropy ?? 0.62));
    u.uContact.value = Math.max(0.001, p.contact ?? 0.7);

    /* ---- the canopy ---- */
    u.uGobo.value = Math.max(0, Math.min(1, (p.gobo ?? 0.55) * ns));
    u.uGoboScale.value = Math.max(0.01, (p.goboScale ?? 0.5) * nf);
    u.uGoboBias.value = p.goboBias ?? 0.18;
    u.uGoboDrift.value = (p.goboDrift ?? 0.08) * nsp;

    /* ---- dust ---- */
    u.uMote.value = Math.max(0, p.mote ?? 0.7);
    u.uMoteScale.value = Math.max(0.01, (p.moteScale ?? 2.6) * nf);
    u.uMoteSize.value = Math.max(0.001, Math.min(0.9, p.moteSize ?? 0.13));
    u.uMoteFall.value = (p.moteFall ?? 0.09) * nsp;

    /* ---- the ground ---- */
    u.uBounce.value = Math.max(0, p.bounce ?? 0.9);
    u.uPoolSoft.value = Math.max(0.02, p.poolSoft ?? 0.75);
    u.uLandBand.value = Math.max(0.001, p.landBand ?? 0.5);

    /* ---- output ---- */
    u.uIntensity.value = Math.max(0, p.intensity ?? 1);
    u.uColorMouth.value.copy(getColor(p.colorMouth ?? '#fff4d6'));
    u.uColorFoot.value.copy(getColor(p.colorFoot ?? '#ffd79a'));
    u.uColorMote.value.copy(getColor(p.colorMote ?? '#fffbee'));
    u.uColorPool.value.copy(getColor(p.colorPool ?? '#ffe6b4'));
  }

  /* ------------------------------------------------------------------ */
  /* CPU mirrors                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Where shaft `index` meets the ground, in world metres.
   *
   * Reads the same floats the vertex shader reads, so a CPU emitter lands on
   * the shaft rather than near it. Like `LiquidSurface#lipPosition()` it leaves
   * out nothing — the layout is closed-form.
   */
  footPoint(index, p, out) {
    const u = this.material.uniforms;
    const i = Math.max(0, Math.min(this.capacity - 1, Math.round(index)));
    const d0 = this._dice[i * 4];
    const d1 = this._dice[i * 4 + 1];
    const d2 = this._dice[i * 4 + 2];
    const d3 = this._dice[i * 4 + 3];

    const count = Math.max(1, this._count);
    const layout = p?.layout ?? u.uLayout.value;
    const along = u.uAlong.value;
    const side = u.uSide.value;
    const ring = Math.max(0, p?.ring ?? u.uRing.value);
    const scatter = Math.max(0, p?.scatter ?? u.uScatter.value);
    const spacing = p?.spacing ?? u.uSpacing.value;
    const seed = p?.seed ?? u.uSeed.value;

    out.copy(u.uAnchor.value);
    if (layout === ShaftLayout.LINE) {
      out.addScaledVector(along, (i - (count - 1) * 0.5) * spacing);
    } else if (layout === ShaftLayout.RING) {
      const bearing = Math.PI * 2 * (i / count) + seed;
      out.addScaledVector(side, Math.cos(bearing) * ring);
      out.addScaledVector(along, Math.sin(bearing) * ring);
    } else if (layout === ShaftLayout.SCATTER) {
      const bearing = Math.PI * 2 * d0;
      const reach = Math.sqrt(d1) * ring;
      out.addScaledVector(side, Math.cos(bearing) * reach);
      out.addScaledVector(along, Math.sin(bearing) * reach);
    }
    out.addScaledVector(side, (d2 - 0.5) * scatter);
    out.addScaledVector(along, (d3 - 0.5) * scatter);
    return out;
  }

  /** Where shaft `index` enters, in world metres. */
  mouthPoint(index, p, out) {
    const u = this.material.uniforms;
    const i = Math.max(0, Math.min(this.capacity - 1, Math.round(index)));
    const jitter = p?.lengthJitter ?? u.uLengthJitter.value;
    const len = Math.max(0.05, (p?.length ?? u.uLength.value) * (1 + (this._dice[i * 4] - 0.5) * jitter));
    this.footPoint(i, p, out);
    return out.addScaledVector(u.uUp.value, len);
  }

  /**
   * How brightly the shafts light a world point — `0..1`, the strongest shaft.
   *
   * This is the answer to "the dust in the shaft must be the scene's own dust
   * motes, brightened as they pass through it, not a second system". The module
   * cannot reach into `ParticleEngine`, but it can tell an ability exactly how
   * lit a particle is, and the ability can put that on the particle's own
   * brightness — one shared field, two consumers, which is the same shape as
   * `Caustics#bindSource()`.
   *
   * It mirrors the radial gaussian, the axial curve and the extinction. It
   * deliberately leaves out the gobo, for the reason `LiquidSurface#lipPosition`
   * leaves out the chop: the caller wants a smooth envelope to multiply into a
   * particle, not a field that flickers as a mote crosses a leaf edge at four
   * metres a second.
   */
  irradianceAt(point, p, out = null) {
    void out;
    const u = this.material.uniforms;
    const count = this._count;
    if (count <= 0) return 0;

    _axis.copy(u.uUp.value).negate();
    const soft = Math.max(0.02, p?.soft ?? u.uSoft.value);
    const curve = Math.max(0.001, p?.axialCurve ?? u.uAxialCurve.value);
    const mouth = Math.max(0, Math.min(1, p?.axialMouth ?? u.uAxialMouth.value));
    const extinct = Math.max(0, p?.extinct ?? u.uExtinct.value);
    const rJit = p?.radiusJitter ?? u.uRadiusJitter.value;
    const lJit = p?.lengthJitter ?? u.uLengthJitter.value;
    const rMouth0 = Math.max(0.01, p?.radiusMouth ?? u.uRadiusMouth.value);
    const rFoot0 = Math.max(0.01, p?.radiusFoot ?? u.uRadiusFoot.value);
    const len0 = Math.max(0.05, p?.length ?? u.uLength.value);
    const fade = (p?.fade ?? u.uFade.value) * (p?.intensity ?? u.uIntensity.value);

    let best = 0;
    for (let i = 0; i < count; i++) {
      const len = Math.max(0.05, len0 * (1 + (this._dice[i * 4] - 0.5) * lJit));
      const jr = 1 + (this._dice[i * 4 + 1] - 0.5) * rJit;

      this.footPoint(i, p, _foot);
      // The mouth is `len` up the axis from the foot; a is measured down from it.
      _rel.copy(point).sub(_foot);
      const axialUp = -_rel.dot(_axis); // metres above the foot
      const a = len - axialUp;
      if (a < 0 || a > len) continue;

      const k = a / len;
      const rad = Math.max(0.01, (rMouth0 + (rFoot0 - rMouth0) * k) * jr);
      // Perpendicular distance: |rel| minus the axial component.
      const axialLen = _rel.dot(_axis);
      const perp2 = Math.max(0, _rel.lengthSq() - axialLen * axialLen);
      const fall = Math.exp(-perp2 / Math.max(rad * rad * soft, 1e-6));
      const axial = mouth + (1 - mouth) * Math.pow(k, curve);
      const lit = fall * axial * Math.exp(-extinct * a);
      if (lit > best) best = lit;
    }
    return Math.max(0, Math.min(1, best * fade));
  }

  dispose() {
    this.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
