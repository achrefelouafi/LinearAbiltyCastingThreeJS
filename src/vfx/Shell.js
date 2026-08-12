import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Group,
  Mesh,
  ShaderMaterial,
  Vector3
} from 'three';
import { createBeamTubeGeometry, createBeamRingGeometry } from '../assets/ProceduralGeometry.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms, frame } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { globals } from '../config/globals.js';
import { getColor } from '../utils/color.js';
import { clamp, saturate } from '../utils/math.js';
import { num, str, prefixed, buildKeys, buildDefaults, auditBlock } from './prefixedBlock.js';

/**
 * `vfx/Shell.js` — the standing half of the burst vocabulary.
 *
 * ## Why this is a new module and not four more `BurstMode`s
 *
 * `effects/BurstSphere.js` stays exactly as it is, and the six shipped abilities
 * go on using it. It is a **fire-and-forget pool**: you hand `spawn()` a start
 * radius and an end radius in metres, and it runs its own clock to death. That
 * is a *captured dimension* — the thing invariant I1 exists to forbid — and it
 * is completely fine there, because a burst lives 900 ms and nobody can drag a
 * slider inside 900 ms. Trying to retrofit live re-resolution onto a pool whose
 * whole contract is "spawn and forget" would have made every existing caller
 * pass a settings object it does not have.
 *
 * What the roster needs instead is shells that **stand**: a thunderclap dome
 * that holds while three pressure fronts cross it, a resonant chord's ring train
 * running for two seconds, a sun disc lying on the floor while you tune the
 * corona licking off its rim. Those are owned by the ability, live in its group,
 * and re-resolve every metre from settings on every frame including a
 * zero-length one.
 *
 * So: **`BurstSystem` owns the transient vocabulary, `Shell` owns the standing
 * one.** Both are re-exported from here, because from an ability's point of view
 * they are one vocabulary with two lifetimes, and having to remember which file
 * a hemisphere lives in is exactly the friction the tech library is supposed to
 * remove.
 *
 * ## What it draws
 *
 * **One draw call per shell.** Two geometry kinds cover all five modes, and that
 * economy is the good idea in this file:
 *
 *  - **the `(t, a)` surface grid** — `createBeamTubeGeometry`, the same grid the
 *    beam and `vfx/Tube.js` are drawn on. Map `t` to a polar angle and it is a
 *    dome; map it to a full polar sweep and it is a sphere; map it to distance
 *    along an axis with a rising radius and it is a cone. One grid, three
 *    silhouettes, no new geometry builders.
 *  - **the instanced annulus** — `createBeamRingGeometry`. One instance is one
 *    ring; the shader places it. That is the ring train, and with a single
 *    instance and an inner radius of zero it is also the sun disc.
 *
 * ## Modes
 *
 * | mode | what it is |
 * | --- | --- |
 * | `DOME`       | a hemisphere standing on the floor, with a bright seal where it meets it. |
 * | `CONE`       | an open blast cone from an apex along an axis, rim-weighted and hollow. |
 * | `RING_TRAIN` | rings travelling out along an axis at fixed spacing, reflecting off the far end. |
 * | `SUNDISC`    | a low disc lying on the ground with corona filaments licking off its rim. |
 * | `PRESSURE`   | a near-invisible shell that is almost entirely a fresnel rim. |
 *
 * ### RING_TRAIN, and the standing wave
 *
 * This is Resonant Chord's whole trick, so it is worth being exact about it.
 *
 * Rings are launched at the origin `spacing` metres apart and travel out at
 * `ringSpeed`. At the far end they **fold**: `s = span − |d − span|` on a
 * `2·span` cycle, so a ring runs out, turns round and comes back. Outbound and
 * returning rings therefore cross, and where they cross they add.
 *
 * The interference is not faked. Superposing the outbound wave with its
 * reflection off a fixed end,
 *
 * ```
 *   sin(ks − ωt) − sin(k(2L − s) − ωt)  =  2·cos(kL − ωt)·sin(k(s − L))
 * ```
 *
 * — a spatial envelope `|sin(k(s − L))|` with a node at the far end and every
 * half-wavelength back from it, multiplied by a temporal term `cos(kL − ωt)`
 * that pulses the *whole line together*. That identity is three lines of GLSL,
 * and each ring reads the envelope at its own position: at a node it pinches to
 * the axis and goes dark, at an antinode it blooms. The nodes are visible
 * because they are actually there.
 *
 * `resonantSpacing(n)` returns the wavelength that fits exactly `n` half-waves
 * on the line, which is how an ability makes the nodes stand still instead of
 * drifting. `nodePosition(i)` hands back where they are, so a burst or a dust
 * puff can be dropped on one.
 *
 * ### SUNDISC, and the spokes it does not draw
 *
 * The corona is ridged noise sampled **in the plane** and domain-warped, then
 * masked to the annulus just outside the rim. The obvious implementation —
 * sampling on `atan(y, x)` — hands every radius along a given bearing the same
 * value and draws dead-straight spokes out of the centre: a firework, not a
 * corona. The bolt's ground burns learnt this the hard way; the same lesson
 * applies to anything radial.
 *
 * ## What it reads from settings
 *
 * Everything in `shellDefaults()`, by prefixed key, off whatever object is
 * handed to `sync()` — plus `settings.global`. Spread `shellDefaults()` into the
 * ability's block and `shellSchema()` into its editor schema.
 *
 * ## The one rule for using it well
 *
 * **Drive it with a normalised life `t`, never with a captured radius.** The
 * shell interpolates `radius → radiusEnd` itself, on a live easing exponent, so
 * an ability hands it `t = age / duration` and gets an expansion that reshapes
 * under the sliders while it is standing. An ability that computes its own
 * metres and pokes them in has thrown away the only reason this module exists.
 */

/* The transient half of the vocabulary. Re-exported deliberately — see above. */
export { BurstMode, BurstSystem } from '../effects/BurstSphere.js';

/* ---------------------------------------------------------------- */
/* Enums                                                             */
/* ---------------------------------------------------------------- */

export const ShellMode = Object.freeze({
  DOME: 0, // hemisphere on the floor
  CONE: 1, // open blast cone along an axis
  RING_TRAIN: 2, // reflecting train of rings — standing waves
  SUNDISC: 3, // ground disc with a corona
  PRESSURE: 4 // near-invisible fresnel rim
});

/** Enum → name, for the editor dropdown and for readable diagnostics. */
export const SHELL_MODE_NAMES = Object.freeze(['DOME', 'CONE', 'RING_TRAIN', 'SUNDISC', 'PRESSURE']);

const TAU = Math.PI * 2;

/* ---------------------------------------------------------------- */
/* The settings contract                                             */
/* ---------------------------------------------------------------- */

const SHELL_FIELDS = {
  /* --- the expansion --- */
  radius: 0.6, // radius at t = 0, metres
  radiusEnd: 4.0, // radius at t = 1, metres
  expand: 5.0, // easing exponent: 1 − (1−t)^expand, >1 = fast then easing out
  height: 1.0, // axial extent, × radius (squash a dome, stretch a sphere)
  span: 6.0, // CONE length / RING_TRAIN run, metres (state.span overrides)
  lift: 0.04, // hover above the anchor along the axis, metres

  /* --- the surface --- */
  displace: 0.22, // billow along the normal, × radius
  noiseScale: 1.8, // billow features per unit radius
  noiseSpeed: 0.6, // Hz the billow crawls at
  turbulence: 1.0, // master on the billow

  /* --- shading --- */
  fill: 0.25, // how much body the shell keeps, 0 = rim only
  rim: 1.0, // strength of the fresnel rim
  rimPower: 2.2, // how tight that rim is
  seal: 1.4, // DOME: brightness where the dome meets the floor
  sealWidth: 0.12, // how wide that seal band is, fraction of the sweep
  edge: 1.2, // CONE: brightness of the leading lip
  edgeWidth: 0.16, // how wide that lip is, fraction of the length
  coneCurve: 1.0, // CONE: <1 bells out early, >1 stays needle-thin
  dissolve: 0.9, // how hard the age dissolve bites, 0 = fade evenly

  /* --- RING_TRAIN --- */
  rings: 10, // live instance count
  spacing: 1.6, // metres between launched rings — the wavelength
  ringSpeed: 7.0, // metres/second they travel at
  ringThickness: 0.16, // radial thickness of one ring, metres
  ringSharp: 1.6, // how hard its profile falls off
  reflect: 1.0, // 0 = rings die at the far end, 1 = perfect reflection
  standing: 1.0, // how much of the standing envelope modulates them
  swell: 0.45, // extra radius at an antinode, × radius

  /* --- SUNDISC --- */
  coronaReach: 1.8, // how far past the rim the disc is drawn, × radius
  corona: 1.3, // brightness of the filaments licking off the rim
  coronaLength: 0.55, // how far they reach, × radius
  coronaScale: 5.0, // filament features per radius
  coronaWarp: 0.45, // domain warp — the thing that stops them being spokes
  coronaSpeed: 0.7, // Hz they crawl at
  coronaSharp: 0.72, // threshold: low fills the corona in and it reads as fog
  granule: 0.45, // convection cells across the disc face
  granuleScale: 6.0, // cells per radius
  rimWidth: 0.18, // hot band inside the rim, × radius

  /* --- rendering --- */
  opacity: 1.0,
  glow: 1.8, // emissive gain into bloom
  softFade: 0.6, // metres of depth fade against the opaque scene

  /* --- colour (I5: four pickers, none derived from another) --- */
  colorBody: '#2f6f9a', // the body of the shell
  colorRim: '#d0f0ff', // the fresnel rim / the seal / the leading lip
  colorEdge: '#ffffff', // the hottest mark it has
  colorCorona: '#ffb44a' // SUNDISC filaments — deliberately its own picker
};

const FIELD_NAMES = Object.freeze(Object.keys(SHELL_FIELDS));

/**
 * Per-mode tuning, applied on top of the field defaults.
 *
 * A pressure front and a sun disc want opposite numbers from the same block —
 * one is 95% rim and 5% body, the other is a solid face with filaments coming
 * off it. Starting points only; every one is a slider once the block is spread.
 */
const MODE_DEFAULTS = {
  [ShellMode.CONE]: { fill: 0.14, rim: 1.2, rimPower: 1.6, displace: 0.12, radius: 0.05, radiusEnd: 2.4 },
  [ShellMode.RING_TRAIN]: { radius: 0.5, radiusEnd: 1.4, expand: 2, fill: 0, displace: 0, glow: 2.4 },
  [ShellMode.SUNDISC]: {
    radius: 0.4, radiusEnd: 3.2, height: 0.02, fill: 0.7, rim: 0.4,
    displace: 0, dissolve: 0.4, glow: 2.6, lift: 0.03,
    colorBody: '#ff9a1f', colorRim: '#ffe07a', colorEdge: '#ffffff', colorCorona: '#ffd27a'
  },
  [ShellMode.PRESSURE]: {
    fill: 0.02, rim: 1.6, rimPower: 3.4, displace: 0.06, dissolve: 1.2, glow: 1.2
  }
};


/**
 * A fresh settings fragment for one shell. Spread into an ability's block.
 *
 * ```js
 * export const resonance = {
 *   range: 20, minRange: 2, speed: 40, cooldown: 1.1, castAnim: 'cast1',
 *   ...shellDefaults('chord', ShellMode.RING_TRAIN, { chordSpacing: 2.2 })
 * };
 * ```
 *
 * Overrides are keyed by the **prefixed** name, so they read the same way the
 * ability will read them.
 *
 * @param {string} [prefix] key prefix — take a second one for a second shell
 * @param {number} [mode]   ShellMode.*, which picks the per-mode tuning above
 * @param {object} [overrides] prefixed key → value
 */
export function shellDefaults(prefix = 'shell', mode = ShellMode.DOME, overrides = {}) {
  return buildDefaults(FIELD_NAMES, SHELL_FIELDS, MODE_DEFAULTS[mode] ?? {}, prefix, overrides);
}

/** The unprefixed → prefixed key map, built once. */
export function shellKeys(prefix = 'shell') {
  return buildKeys(FIELD_NAMES, prefix);
}

/** Editor folders for one shell. Spread into an ability's schema. */
export function shellSchema(prefix = 'shell', mode = ShellMode.DOME) {
  const k = (name) => prefixed(prefix, name);
  const schema = {
    'The shell': [
      [k('radius'), 0.01, 20, 0.01, 'start radius (m)'],
      [k('radiusEnd'), 0.01, 40, 0.01, 'end radius (m)'],
      [k('expand'), 0.2, 12, 0.01, 'expansion curve'],
      [k('height'), 0.02, 4, 0.01, 'height × radius'],
      [k('lift'), -2, 2, 0.001, 'lift (m)'],
      [k('displace'), 0, 1.5, 0.01, 'billow'],
      [k('noiseScale'), 0.1, 10, 0.01, 'billow scale'],
      [k('noiseSpeed'), 0, 4, 0.01, 'billow Hz'],
      [k('turbulence'), 0, 3, 0.01, 'turbulence']
    ],
    'Shell shading': [
      [k('fill'), 0, 1, 0.01, 'body fill'],
      [k('rim'), 0, 3, 0.01, 'rim'],
      [k('rimPower'), 0.1, 8, 0.01, 'rim power'],
      [k('dissolve'), 0, 2, 0.01, 'dissolve'],
      k('colorBody'),
      k('colorRim'),
      k('colorEdge'),
      [k('opacity'), 0, 1, 0.01, 'opacity'],
      [k('glow'), 0, 8, 0.01, 'glow'],
      [k('softFade'), 0, 3, 0.01, 'soft fade (m)']
    ]
  };

  if (mode === ShellMode.DOME) {
    schema['The dome'] = [
      [k('seal'), 0, 4, 0.01, 'floor seal'],
      [k('sealWidth'), 0.01, 0.6, 0.01, 'seal width']
    ];
  }
  if (mode === ShellMode.CONE) {
    schema['The cone'] = [
      [k('span'), 0.1, 40, 0.05, 'length (m)'],
      [k('coneCurve'), 0.1, 4, 0.01, 'flare curve'],
      [k('edge'), 0, 4, 0.01, 'leading lip'],
      [k('edgeWidth'), 0.01, 0.8, 0.01, 'lip width']
    ];
  }
  if (mode === ShellMode.RING_TRAIN) {
    schema['The ring train'] = [
      [k('span'), 0.1, 40, 0.05, 'run length (m)'],
      [k('rings'), 1, 48, 1, 'rings'],
      [k('spacing'), 0.1, 12, 0.01, 'wavelength (m)'],
      [k('ringSpeed'), 0, 40, 0.05, 'speed (m/s)'],
      [k('ringThickness'), 0.01, 2, 0.01, 'thickness (m)'],
      [k('ringSharp'), 0.05, 8, 0.01, 'profile'],
      [k('reflect'), 0, 1, 0.01, 'reflection'],
      [k('standing'), 0, 1, 0.01, 'standing wave'],
      [k('swell'), 0, 2, 0.01, 'antinode swell']
    ];
  }
  if (mode === ShellMode.SUNDISC) {
    schema['The sun disc'] = [
      [k('coronaReach'), 1, 4, 0.01, 'drawn reach'],
      [k('corona'), 0, 4, 0.01, 'corona'],
      [k('coronaLength'), 0, 3, 0.01, 'corona length'],
      [k('coronaScale'), 0.5, 20, 0.1, 'corona scale'],
      [k('coronaWarp'), 0, 2, 0.01, 'corona warp'],
      [k('coronaSpeed'), 0, 4, 0.01, 'corona Hz'],
      [k('coronaSharp'), 0, 0.98, 0.01, 'corona threshold'],
      [k('granule'), 0, 2, 0.01, 'granulation'],
      [k('granuleScale'), 0.5, 24, 0.1, 'granule scale'],
      [k('rimWidth'), 0.01, 0.6, 0.01, 'rim band'],
      k('colorCorona')
    ];
  }
  return schema;
}

/* ---------------------------------------------------------------- */
/* GLSL                                                              */
/* ---------------------------------------------------------------- */

const SHELL_UNIFORMS = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  #define MODE_DOME       0
  #define MODE_CONE       1
  #define MODE_RING_TRAIN 2
  #define MODE_SUNDISC    3
  #define MODE_PRESSURE   4

  uniform float uTime;
  uniform vec3  uOrigin;
  uniform vec3  uAxis;
  uniform vec3  uSide;
  uniform float uSeed;
  uniform float uAge;
  uniform float uFade;

  uniform float uRadius;
  uniform float uHeight;
  uniform float uSpan;
  uniform float uLift;

  uniform float uDisplace;
  uniform float uNoiseScale;
  uniform float uNoiseSpeed;

  uniform float uFill;
  uniform float uRim;
  uniform float uRimPower;
  uniform float uSeal;
  uniform float uSealWidth;
  uniform float uEdge;
  uniform float uEdgeWidth;
  uniform float uConeCurve;
  uniform float uDissolve;

  uniform float uSpacing;
  uniform float uRingSpeed;
  uniform float uRingThickness;
  uniform float uRingSharp;
  uniform float uReflect;
  uniform float uStanding;
  uniform float uSwell;

  uniform float uCoronaReach;
  uniform float uCorona;
  uniform float uCoronaLength;
  uniform float uCoronaScale;
  uniform float uCoronaWarp;
  uniform float uCoronaSpeed;
  uniform float uCoronaSharp;
  uniform float uGranule;
  uniform float uGranuleScale;
  uniform float uRimWidth;

  uniform float uOpacity;
  uniform float uGlow;
  uniform float uSoftFade;
  uniform vec3  uColorBody;
  uniform vec3  uColorRim;
  uniform vec3  uColorEdge;
  uniform vec3  uColorCorona;
`;

/**
 * Five is the ceiling here, guarded per mode — the same discipline
 * `BeamMaterial` keeps, and for the same reason: the low end has a varying
 * budget and a shell is never the only thing on screen.
 */
const SHELL_VARYINGS = /* glsl */ `
  varying float vT;
  varying float vViewZ;

  #if SHELL_MODE == MODE_RING_TRAIN
    varying float vAmp;
    varying float vS;
  #elif SHELL_MODE == MODE_SUNDISC
    varying vec2  vPolar;
    varying vec2  vPlane;
  #else
    varying vec3  vNormalW;
    varying vec3  vViewDir;
    varying float vDisp;
  #endif
`;

const SHELL_SHAPE = /* glsl */ `
  /** The shell's local frame: its axis and two vectors spanning across it. */
  void shellFrame(out vec3 ax, out vec3 e1, out vec3 e2) {
    ax = normalize(uAxis);
    vec3 lateral = uSide - ax * dot(uSide, ax);
    e1 = length(lateral) > 1e-4 ? normalize(lateral) : normalize(cross(ax, vec3(0.0, 0.0, 1.0)));
    e2 = normalize(cross(ax, e1));
  }

  /**
   * The standing-wave envelope at s metres along the run.
   *
   *   sin(ks − ωt) − sin(k(2L − s) − ωt) = 2·cos(kL − ωt)·sin(k(s − L))
   *
   * so the spatial part is a fixed pattern of nodes counted back from the far
   * end, and the temporal part pulses the whole line at once. uReflect fades
   * between a plain travelling train and the full standing pattern, which is
   * exactly what a lossy end reflection does.
   */
  float standingAmp(float s) {
    float lambda = max(uSpacing, 0.05);
    float k = TAU / lambda;
    float w = k * uRingSpeed;
    float envelope = abs(sin(k * (s - uSpan)));
    float breath = abs(cos(w * uTime - k * uSpan));
    return mix(1.0, envelope * breath, clamp(uReflect * uStanding, 0.0, 1.0));
  }
`;

const SHELL_VERTEX = /* glsl */ `
  ${SHELL_UNIFORMS}
  ${SHELL_VARYINGS}

  #if SHELL_MODE == MODE_RING_TRAIN || SHELL_MODE == MODE_SUNDISC
    attribute float aRing;
  #endif

  ${noiseGLSL}
  ${SHELL_SHAPE}

  void main() {
    vec3 ax, e1, e2;
    shellFrame(ax, e1, e2);

    vec3 here;

    #if SHELL_MODE == MODE_DOME || SHELL_MODE == MODE_PRESSURE
      // One (t, a) grid, two silhouettes: sweep the polar angle a quarter turn
      // and it is a dome standing on the floor, a half turn and it is a ball.
      #if SHELL_MODE == MODE_DOME
        float polar = position.x * (PI * 0.5);
      #else
        float polar = position.x * PI;
      #endif
      float ang = position.y * TAU;
      vec3 rad = e1 * cos(ang) + e2 * sin(ang);
      vec3 n = ax * cos(polar) + rad * sin(polar);

      // Billowing surface, scrolling as the shell expands. Sampled on the
      // undisplaced direction so the grain stays welded to the shell rather
      // than swimming through it.
      float d = fbm4(n * uNoiseScale * (1.0 + uAge) + vec3(uSeed * 13.0)
                     - vec3(0.0, uTime * uNoiseSpeed, 0.0));
      vDisp = d;

      vec3 shape = ax * (cos(polar) * uHeight) + rad * sin(polar);
      here = uOrigin + ax * uLift + (shape + n * d * uDisplace) * uRadius;
      vNormalW = normalize(n);
      vT = position.x;

    #elif SHELL_MODE == MODE_CONE
      float t = position.x;
      float ang = position.y * TAU;
      vec3 rad = e1 * cos(ang) + e2 * sin(ang);
      float rr = uRadius * pow(clamp(t, 0.0, 1.0), max(uConeCurve, 0.05));

      float d = fbm4(rad * uNoiseScale + vec3(t * 2.7 + uSeed * 13.0)
                     - vec3(0.0, uTime * uNoiseSpeed, 0.0));
      vDisp = d;

      here = uOrigin + ax * (uLift + uSpan * t) + rad * (rr + d * uDisplace * uRadius);
      // Analytic cone normal: the surface leans by dr/dz, so the rim term knows
      // it is looking at a slope rather than at a cylinder.
      float slope = uRadius * max(uConeCurve, 0.05) *
                    pow(max(t, 1e-3), max(uConeCurve, 0.05) - 1.0) / max(uSpan, 1e-3);
      vNormalW = normalize(rad - ax * slope);
      vT = t;

    #elif SHELL_MODE == MODE_RING_TRAIN
      // Launched spacing metres apart and folded off the far end, so one train is
      // both the outbound and the returning wave.
      float lambda = max(uSpacing, 0.05);
      float cycle = 2.0 * max(uSpan, 0.05);
      float d = mod(uRingSpeed * uTime + aRing * lambda, cycle);
      float s = uSpan - abs(d - uSpan);
      float returning = step(uSpan, d);

      float amp = standingAmp(s);
      float ang = position.y * TAU;
      vec3 rad = e1 * cos(ang) + e2 * sin(ang);
      float rr = uRadius * (1.0 + uSwell * amp) * mix(1.0, amp, clamp(uStanding, 0.0, 1.0));
      rr += (position.x - 0.5) * uRingThickness;

      here = uOrigin + ax * (uLift + s) + rad * max(rr, 0.0);
      vT = position.x;
      vAmp = amp * mix(1.0, uReflect, returning);
      vS = s;

    #else                                                   /* SUNDISC */
      float band = position.x;
      float ang = position.y * TAU;
      float reach = max(uCoronaReach, 1.0);
      vec3 rad = e1 * cos(ang) + e2 * sin(ang);

      here = uOrigin + ax * uLift + rad * (uRadius * reach * band);
      // Radius in units of the disc, so 1.0 is exactly the rim wherever the
      // slider puts it, and the plane coordinates the corona is sampled in.
      vPolar = vec2(band * reach, ang);
      vPlane = vec2(cos(ang), sin(ang)) * (band * reach);
      vT = band;
    #endif

    vec4 mv = viewMatrix * vec4(here, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const SHELL_FRAGMENT = /* glsl */ `
  ${SHELL_UNIFORMS}
  ${SHELL_VARYINGS}

  uniform float uGlobalGlow;
  uniform float uShaderIntensity;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    vec3 color = vec3(0.0);
    float alpha = 0.0;

    #if SHELL_MODE == MODE_RING_TRAIN
      // A ring is a band across its own thickness. At a node vAmp is zero and
      // the ring is simply not there — which is the point of the whole mode.
      float band = 1.0 - abs(vT * 2.0 - 1.0);
      float profile = pow(clamp(band, 0.0, 1.0), max(uRingSharp, 0.05));
      float amp = clamp(vAmp, 0.0, 1.0);
      color = mix(uColorBody, uColorRim, profile);
      color += uColorEdge * profile * amp * amp;
      alpha = profile * mix(0.15, 1.0, amp);

    #elif SHELL_MODE == MODE_SUNDISC
      float rn = vPolar.x;                       // 1.0 is the rim

      // The face: convection cells, plus a hot band inside the rim.
      float cells = 1.0 - voronoi2(vPlane * uGranuleScale + uSeed * 7.0
                                   + vec2(uTime * uCoronaSpeed * 0.3)).x;
      float face = 1.0 - smoothstep(1.0 - uRimWidth, 1.0, rn);
      float ring = smoothstep(1.0 - uRimWidth, 1.0, rn) * (1.0 - smoothstep(1.0, 1.06, rn));

      // The corona. Sampled in the *plane* and domain warped — sampling on
      // atan(y, x) gives every radius along a bearing the same value and draws
      // dead-straight spokes, which is a firework, not a corona.
      vec2 q = vPlane * uCoronaScale;
      q += vec2(
        snoise(vec3(q * 0.7, uTime * uCoronaSpeed)),
        snoise(vec3(q * 0.7 + 11.3, uTime * uCoronaSpeed + 4.1))
      ) * uCoronaWarp * uCoronaScale * 0.25;
      float fil = ridged(vec3(q, uTime * uCoronaSpeed * 0.5 + uSeed), 4);
      float lick = smoothstep(clamp(uCoronaSharp, 0.0, 0.98), 0.99, fil);
      lick *= smoothstep(0.94, 1.02, rn) *
              (1.0 - smoothstep(1.0, 1.0 + max(uCoronaLength, 1e-3), rn));

      color = mix(uColorBody, uColorRim, face * (0.35 + uGranule * cells));
      color += uColorEdge * ring;
      color += uColorCorona * lick * uCorona;
      alpha = face * (uFill + uGranule * cells * 0.35) + ring + lick * uCorona * 0.6;

    #else
      float fres = fresnelTerm(vViewDir, vNormalW, max(uRimPower, 0.1), 1.0) * uRim;
      float heat = clamp(vDisp * 0.5 + 0.5, 0.0, 1.0);
      // Dissolve the shell away over its life, torn by the same billow the
      // vertex stage already computed rather than by a second noise field.
      vec2 dis = dissolveMask(heat, uAge * (0.6 + uDissolve * 0.75) - 0.15, 0.3);

      #if SHELL_MODE == MODE_DOME
        // The seal: a dome that fades out at the floor looks like it is
        // floating. Brightening the last few degrees of the sweep is what
        // plants it.
        float seal = smoothstep(1.0 - max(uSealWidth, 1e-3), 1.0, vT);
        color = mix(uColorBody, uColorRim, clamp(fres, 0.0, 1.0));
        color += uColorEdge * seal * uSeal;
        alpha = (uFill * (0.35 + heat * 0.5) + fres + seal * uSeal * 0.35) * dis.x;

      #elif SHELL_MODE == MODE_CONE
        // Hollow: the body contributes almost nothing and the silhouette does
        // the work, so orbiting the cone shows you the far wall through it.
        float lip = smoothstep(1.0 - max(uEdgeWidth, 1e-3), 1.0, vT);
        color = mix(uColorBody, uColorRim, clamp(fres, 0.0, 1.0));
        color += uColorEdge * lip * uEdge;
        alpha = (uFill * heat * 0.6 + fres + lip * uEdge * 0.4) * dis.x;

      #else                                                 /* PRESSURE */
        // Almost nothing is drawn. This is a front you read from the way the
        // rim tightens as it passes, and filling it in at all defeats it.
        color = mix(uColorBody, uColorRim, fres);
        color += uColorEdge * dis.y * 0.6;
        alpha = (uFill * 0.15 + fres) * dis.x;
      #endif
    #endif

    alpha *= uFade * uOpacity;
    if (alpha < 0.004) discard;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    color *= uGlow * uGlobalGlow * mix(0.7, 1.0, uShaderIntensity);
    gl_FragColor = vec4(clamp(color, 0.0, 64.0), clamp(alpha, 0.0, 1.0));
  }
`;

/** One shell's material. Uniforms are pushed by `Shell#sync`. */
export function createShellMaterial(mode = ShellMode.DOME) {
  return new ShaderMaterial({
    defines: { SHELL_MODE: mode },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uOrigin: { value: new Vector3() },
      uAxis: { value: new Vector3(0, 1, 0) },
      uSide: { value: new Vector3(1, 0, 0) },
      uSeed: { value: 0 },
      uAge: { value: 0 },
      uFade: { value: 1 },

      uRadius: { value: SHELL_FIELDS.radius },
      uHeight: { value: SHELL_FIELDS.height },
      uSpan: { value: SHELL_FIELDS.span },
      uLift: { value: SHELL_FIELDS.lift },

      uDisplace: { value: SHELL_FIELDS.displace },
      uNoiseScale: { value: SHELL_FIELDS.noiseScale },
      uNoiseSpeed: { value: SHELL_FIELDS.noiseSpeed },

      uFill: { value: SHELL_FIELDS.fill },
      uRim: { value: SHELL_FIELDS.rim },
      uRimPower: { value: SHELL_FIELDS.rimPower },
      uSeal: { value: SHELL_FIELDS.seal },
      uSealWidth: { value: SHELL_FIELDS.sealWidth },
      uEdge: { value: SHELL_FIELDS.edge },
      uEdgeWidth: { value: SHELL_FIELDS.edgeWidth },
      uConeCurve: { value: SHELL_FIELDS.coneCurve },
      uDissolve: { value: SHELL_FIELDS.dissolve },

      uSpacing: { value: SHELL_FIELDS.spacing },
      uRingSpeed: { value: SHELL_FIELDS.ringSpeed },
      uRingThickness: { value: SHELL_FIELDS.ringThickness },
      uRingSharp: { value: SHELL_FIELDS.ringSharp },
      uReflect: { value: SHELL_FIELDS.reflect },
      uStanding: { value: SHELL_FIELDS.standing },
      uSwell: { value: SHELL_FIELDS.swell },

      uCoronaReach: { value: SHELL_FIELDS.coronaReach },
      uCorona: { value: SHELL_FIELDS.corona },
      uCoronaLength: { value: SHELL_FIELDS.coronaLength },
      uCoronaScale: { value: SHELL_FIELDS.coronaScale },
      uCoronaWarp: { value: SHELL_FIELDS.coronaWarp },
      uCoronaSpeed: { value: SHELL_FIELDS.coronaSpeed },
      uCoronaSharp: { value: SHELL_FIELDS.coronaSharp },
      uGranule: { value: SHELL_FIELDS.granule },
      uGranuleScale: { value: SHELL_FIELDS.granuleScale },
      uRimWidth: { value: SHELL_FIELDS.rimWidth },

      uOpacity: { value: 1 },
      uGlow: { value: SHELL_FIELDS.glow },
      uSoftFade: { value: SHELL_FIELDS.softFade },
      uColorBody: { value: new Color(0.18, 0.44, 0.6) },
      uColorRim: { value: new Color(0.82, 0.94, 1) },
      uColorEdge: { value: new Color(1, 1, 1) },
      uColorCorona: { value: new Color(1, 0.7, 0.29) }
    }),
    vertexShader: SHELL_VERTEX,
    fragmentShader: SHELL_FRAGMENT
  });
}

/* ---------------------------------------------------------------- */
/* Module scratch — I3                                               */
/* ---------------------------------------------------------------- */

const WORLD_UP = new Vector3(0, 1, 0);
const _lat = new Vector3();

const DEFAULT_STATE = {
  origin: null,
  axis: null, // unit; defaults to world up
  side: null, // unit reference for the angular seam
  span: 0, // metres; 0 = fall back to the settings value
  t: 0, // 0..1 through the shell's life
  fade: 1,
  seed: 0
};

/* ---------------------------------------------------------------- */
/* Shell                                                             */
/* ---------------------------------------------------------------- */

export class Shell {
  /**
   * @param {object} [options]
   * @param {number} [options.mode]        ShellMode.* — compile-time
   * @param {string} [options.prefix]      settings key prefix ('shell')
   * @param {number} [options.nodes]       surface-grid samples along t
   * @param {number} [options.sides]       surface-grid facets around a
   * @param {number} [options.rings]       RING_TRAIN instance capacity
   * @param {number} [options.segments]    facets around one ring / the disc
   * @param {number} [options.renderOrder]
   */
  constructor({
    mode = ShellMode.DOME,
    prefix = 'shell',
    nodes = 48,
    sides = 48,
    rings = 24,
    segments = 96,
    renderOrder = 14
  } = {}) {
    this.mode = mode;
    this.prefix = prefix;
    this.keys = shellKeys(prefix);
    this.capacity = Math.max(1, Math.round(rings));

    this.group = new Group();
    this.group.name = `Shell:${prefix}`;
    this.group.matrixAutoUpdate = false;

    if (mode === ShellMode.RING_TRAIN) {
      this.geometry = createBeamRingGeometry(this.capacity, segments);
    } else if (mode === ShellMode.SUNDISC) {
      // One instance, inner lip at the centre: the annulus is a disc.
      this.capacity = 1;
      this.geometry = createBeamRingGeometry(1, segments);
    } else {
      this.geometry = createBeamTubeGeometry(nodes, sides);
    }

    this.material = createShellMaterial(mode);
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.renderOrder = renderOrder;
    this.group.add(this.mesh);

    /* --- the frame --- */
    this._origin = new Vector3();
    this._axis = new Vector3(0, 1, 0);
    this._sideRef = new Vector3(1, 0, 0);

    /** Resolved dimensions, rewritten whole every frame. Never captured. */
    this._r = {};
    for (const name of FIELD_NAMES) {
      if (typeof SHELL_FIELDS[name] === 'number') this._r[name] = SHELL_FIELDS[name];
    }
    this._r.liveRadius = SHELL_FIELDS.radius;
    this._r.liveSpan = SHELL_FIELDS.span;
    this._r.count = this.capacity;

    /** Defaults for this mode, so a missing key falls back rather than NaNs. */
    this._defaults = shellDefaults(prefix, mode);
    /** The settings contract is audited once, on the first frame. */
    this._checked = false;
  }

  /** Draw calls this shell costs. One, always. */
  get drawCalls() {
    return 1;
  }

  set visible(value) {
    this.group.visible = value;
  }

  get visible() {
    return this.group.visible;
  }

  /* ------------------------------------------------------------------ */
  /* The frame update                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Re-resolve everything from settings and push it into the material.
   *
   * @param {object} c     the ability's live settings block (`settings.<id>`)
   * @param {object} state  { origin, axis, side, span, t, fade, seed } — dice
   *                        rolls and normalised time only
   * @param {object} [g]    `settings.global`; defaults to the live block.
   *                        Taken from `config/globals.js` rather than from
   *                        `config/settings.js`, because a settings module is
   *                        allowed to spread this module's defaults and the
   *                        round trip through `settings.js` closes a fatal
   *                        import cycle — see `config/globals.js`.
   */
  sync(c, state, g = globals) {
    const s = state || DEFAULT_STATE;
    const K = this.keys;
    const D = this._defaults;
    const r = this._r;
    const u = this.material.uniforms;

    if (!this._checked) this._audit(c);

    if (s.origin) this._origin.copy(s.origin);
    if (s.axis) this._axis.copy(s.axis);
    if (s.side) this._sideRef.copy(s.side);
    if (this._axis.lengthSq() < 1e-8) this._axis.copy(WORLD_UP);
    this._axis.normalize();
    // The seam reference has to be off-axis or the frame degenerates; pick one
    // rather than letting a caller who does not care see a NaN.
    _lat.copy(this._sideRef).addScaledVector(this._axis, -this._sideRef.dot(this._axis));
    if (_lat.lengthSq() < 1e-8) {
      this._sideRef.set(0, 0, 1).cross(this._axis);
      if (this._sideRef.lengthSq() < 1e-8) this._sideRef.set(1, 0, 0);
      this._sideRef.normalize();
    }

    const t = saturate(s.t ?? 0);

    /* --- the expansion. Both ends are sliders; t is the ability's clock. --- */
    r.radius = num(c[K.radius], D[K.radius]);
    r.radiusEnd = num(c[K.radiusEnd], D[K.radiusEnd]);
    r.expand = num(c[K.expand], D[K.expand]);
    const eased = 1 - Math.pow(1 - t, Math.max(r.expand, 0.05));
    r.liveRadius = Math.max(r.radius + (r.radiusEnd - r.radius) * eased, 1e-4);

    r.height = num(c[K.height], D[K.height]);
    r.span = num(c[K.span], D[K.span]);
    r.liveSpan = Math.max(s.span || r.span, 0.05);
    r.lift = num(c[K.lift], D[K.lift]);

    r.displace = num(c[K.displace], D[K.displace]) * g.turbulence * num(c[K.turbulence], D[K.turbulence]);
    r.noiseScale = num(c[K.noiseScale], D[K.noiseScale]) * g.noiseFrequency;
    r.noiseSpeed = num(c[K.noiseSpeed], D[K.noiseSpeed]) * g.noiseSpeed;

    r.fill = num(c[K.fill], D[K.fill]);
    r.rim = num(c[K.rim], D[K.rim]) * g.fresnel;
    r.rimPower = num(c[K.rimPower], D[K.rimPower]);
    r.seal = num(c[K.seal], D[K.seal]);
    r.sealWidth = num(c[K.sealWidth], D[K.sealWidth]);
    r.edge = num(c[K.edge], D[K.edge]);
    r.edgeWidth = num(c[K.edgeWidth], D[K.edgeWidth]);
    r.coneCurve = num(c[K.coneCurve], D[K.coneCurve]);
    r.dissolve = num(c[K.dissolve], D[K.dissolve]);

    r.count = clamp(Math.round(num(c[K.rings], D[K.rings])), 1, this.capacity);
    r.spacing = num(c[K.spacing], D[K.spacing]);
    r.ringSpeed = num(c[K.ringSpeed], D[K.ringSpeed]) * g.speed;
    r.ringThickness = num(c[K.ringThickness], D[K.ringThickness]);
    r.ringSharp = num(c[K.ringSharp], D[K.ringSharp]);
    r.reflect = num(c[K.reflect], D[K.reflect]);
    r.standing = num(c[K.standing], D[K.standing]);
    r.swell = num(c[K.swell], D[K.swell]);

    r.coronaReach = num(c[K.coronaReach], D[K.coronaReach]);
    r.corona = num(c[K.corona], D[K.corona]);
    r.coronaLength = num(c[K.coronaLength], D[K.coronaLength]);
    r.coronaScale = num(c[K.coronaScale], D[K.coronaScale]) * g.noiseFrequency;
    r.coronaWarp = num(c[K.coronaWarp], D[K.coronaWarp]);
    r.coronaSpeed = num(c[K.coronaSpeed], D[K.coronaSpeed]) * g.noiseSpeed;
    r.coronaSharp = num(c[K.coronaSharp], D[K.coronaSharp]);
    r.granule = num(c[K.granule], D[K.granule]);
    r.granuleScale = num(c[K.granuleScale], D[K.granuleScale]) * g.noiseFrequency;
    r.rimWidth = num(c[K.rimWidth], D[K.rimWidth]);

    r.opacity = num(c[K.opacity], D[K.opacity]) * g.opacity;
    r.glow = num(c[K.glow], D[K.glow]);
    r.softFade = num(c[K.softFade], D[K.softFade]);
    r.age = t;
    r.seed = s.seed ?? 0;
    r.fade = s.fade ?? 1;

    /* --- push --- */
    u.uOrigin.value.copy(this._origin);
    u.uAxis.value.copy(this._axis);
    u.uSide.value.copy(this._sideRef);
    u.uSeed.value = r.seed;
    u.uAge.value = r.age;
    u.uFade.value = r.fade;

    u.uRadius.value = r.liveRadius;
    u.uHeight.value = r.height;
    u.uSpan.value = r.liveSpan;
    u.uLift.value = r.lift;

    u.uDisplace.value = r.displace;
    u.uNoiseScale.value = r.noiseScale;
    u.uNoiseSpeed.value = r.noiseSpeed;

    u.uFill.value = r.fill;
    u.uRim.value = r.rim;
    u.uRimPower.value = r.rimPower;
    u.uSeal.value = r.seal;
    u.uSealWidth.value = r.sealWidth;
    u.uEdge.value = r.edge;
    u.uEdgeWidth.value = r.edgeWidth;
    u.uConeCurve.value = r.coneCurve;
    u.uDissolve.value = r.dissolve;

    u.uSpacing.value = r.spacing;
    u.uRingSpeed.value = r.ringSpeed;
    u.uRingThickness.value = r.ringThickness;
    u.uRingSharp.value = r.ringSharp;
    u.uReflect.value = r.reflect;
    u.uStanding.value = r.standing;
    u.uSwell.value = r.swell;

    u.uCoronaReach.value = r.coronaReach;
    u.uCorona.value = r.corona;
    u.uCoronaLength.value = r.coronaLength;
    u.uCoronaScale.value = r.coronaScale;
    u.uCoronaWarp.value = r.coronaWarp;
    u.uCoronaSpeed.value = r.coronaSpeed;
    u.uCoronaSharp.value = r.coronaSharp;
    u.uGranule.value = r.granule;
    u.uGranuleScale.value = r.granuleScale;
    u.uRimWidth.value = r.rimWidth;

    u.uOpacity.value = r.opacity;
    u.uGlow.value = r.glow;
    u.uSoftFade.value = r.softFade;
    u.uColorBody.value.copy(getColor(str(c[K.colorBody], D[K.colorBody])));
    u.uColorRim.value.copy(getColor(str(c[K.colorRim], D[K.colorRim])));
    u.uColorEdge.value.copy(getColor(str(c[K.colorEdge], D[K.colorEdge])));
    u.uColorCorona.value.copy(getColor(str(c[K.colorCorona], D[K.colorCorona])));

    if (this.mode === ShellMode.RING_TRAIN) this.geometry.instanceCount = r.count;
  }

  /* ------------------------------------------------------------------ */
  /* The queries                                                         */
  /* ------------------------------------------------------------------ */

  /** The shell's current radius, metres. Live — what the rim is standing on. */
  get radius() {
    return this._r.liveRadius;
  }

  /** The run length, metres: the cone's length or the ring train's line. */
  get span() {
    return this._r.liveSpan;
  }

  /** Instances currently drawn. HUD readout. */
  get instanceCount() {
    return this.mode === ShellMode.RING_TRAIN ? this._r.count : 1;
  }

  /**
   * The standing-wave amplitude at `s` metres along the run, 0..1.
   *
   * The JS mirror of `standingAmp()` in the shader, for the same reason
   * `Tube#radiusAt` exists: an ability that wants to put a dust puff or a burst
   * where the air is actually being compressed has to be able to ask.
   */
  standingAt(s) {
    const r = this._r;
    const lambda = Math.max(r.spacing, 0.05);
    const k = TAU / lambda;
    const w = k * r.ringSpeed;
    const envelope = Math.abs(Math.sin(k * (s - r.liveSpan)));
    const breath = Math.abs(Math.cos(w * frame.uTime.value - k * r.liveSpan));
    const mixAmount = saturate(r.reflect * r.standing);
    return 1 + (envelope * breath - 1) * mixAmount;
  }

  /** Metres between adjacent nodes: half a wavelength. */
  get nodeSpacing() {
    return Math.max(this._r.spacing, 0.05) * 0.5;
  }

  /** How many nodes fit on the run, counting the one at the far end. */
  get nodeCount() {
    return Math.max(1, Math.floor(this._r.liveSpan / this.nodeSpacing) + 1);
  }

  /**
   * World position of node `i`, counted back from the reflecting far end —
   * node 0 is the far end itself, which is always a node for a fixed boundary.
   */
  nodePosition(i, out) {
    const s = Math.max(this._r.liveSpan - i * this.nodeSpacing, 0);
    return out
      .copy(this._origin)
      .addScaledVector(this._axis, this._r.lift + s);
  }

  /**
   * The wavelength that fits exactly `n` half-waves on the current run, metres.
   *
   * Feed it back into `shellSpacing` and the nodes stop drifting and stand
   * still — which is the difference between "some rings are dimmer" and "this
   * line is resonating".
   */
  resonantSpacing(n) {
    return (2 * this._r.liveSpan) / Math.max(Math.round(n), 1);
  }

  /**
   * Warn once about a settings block that has not been given the contract —
   * see the same audit in `vfx/Tube.js` for why this warns and falls back
   * rather than throwing.
   */
  _audit(c) {
    this._checked = true;
    auditBlock(
      `Shell:${this.prefix}`,
      this.keys,
      FIELD_NAMES,
      c,
      `shellDefaults('${this.prefix}', ShellMode.${SHELL_MODE_NAMES[this.mode]})`
    );
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.group.parent?.remove(this.group);
  }
}
