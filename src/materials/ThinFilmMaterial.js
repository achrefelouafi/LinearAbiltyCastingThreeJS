import {
  ShaderMaterial,
  InstancedBufferGeometry,
  InstancedBufferAttribute,
  BufferAttribute,
  SphereGeometry,
  AdditiveBlending,
  DoubleSide,
  Color,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/* ====================================================================== */
/* THIN FILM — soap-bubble colour, computed rather than authored           */
/* ====================================================================== */
/**
 * The one shader in this project whose **hue is not a picker**.
 *
 * Everything else in `src/materials` gets its colour from a gradient, a lerp
 * between two pickers, or a fresnel ramp between a body colour and a rim
 * colour. That is the right answer almost every time, and it is the wrong
 * answer for a soap film, because a soap film's colour is a *measurement*: it
 * is what is left of white light after the wave reflected off the front face of
 * the film and the wave reflected off the back face have been added together.
 * Change the film's thickness by eighty nanometres and the colour moves from
 * gold to magenta whether the artist wanted it to or not.
 *
 * So this file implements the interference and lets the colour fall out.
 *
 * ## The term
 *
 * For a film of index `n` and thickness `d`, a ray arriving at `θᵢ` refracts to
 * `θₜ` inside it (`sin θᵢ = n sin θₜ`) and the two reflected waves differ in
 * optical path by
 *
 * ```
 *   Δ = 2 · n · d · cos θₜ
 * ```
 *
 * — and then there is the half-wave. The reflection off the **front** face is
 * air → water, going *into* the denser medium, so it flips sign; the reflection
 * off the back face is water → air and does not. That is an extra `π` of phase
 * that no amount of geometry produces, and it is the whole reason a soap film
 * goes **black** rather than white as it thins to nothing:
 *
 * ```
 *   δ(λ) = 2π·Δ/λ + π          I(λ) = ½(1 + cos δ) = ½ − ½·cos(2π·Δ/λ)
 * ```
 *
 * At `d = 0` that is exactly zero for every wavelength. Drop the `π` — which
 * the first version of this shader did — and a vanishing film goes brilliant
 * white instead, which is not a subtlety: the top of a bubble about to burst is
 * the single most recognisable thing about bubbles, and getting it backwards
 * makes the whole effect read as a fresnel ramp with rainbow noise on it.
 *
 * ## Spectrum → RGB
 *
 * `I(λ)` is a spectrum, and a spectrum is not a colour until it has been
 * integrated against an observer. Sampling three wavelengths and calling them
 * R, G and B was the first attempt and it is visibly wrong — the three-tap
 * version beats against its own sampling and produces cyan/orange banding that
 * no real film has. Instead this integrates `FILM_SAMPLES` wavelengths across
 * 400–700 nm against a piecewise-Gaussian fit of the CIE 1931 colour matching
 * functions and converts the resulting XYZ to linear sRGB. It costs
 * `FILM_SAMPLES × 7` exponentials a fragment, and it is the reason the bands
 * come out in the right order — gold, magenta, blue, silver, black — going up
 * a draining bubble.
 *
 * `FILM_SAMPLES` is a compile-time constant rather than a slider because it is
 * a *sampling rate*, not a look. Above roughly 900 nm of film the integrand
 * oscillates faster than 14 taps across the visible band can follow and the
 * colours alias into false pastels, which is why `filmThickness` stops there.
 *
 * ## What is still a picker
 *
 * Four things, because they are genuinely authored and not derived from the
 * interference: the water's own body tint, the specular glint, the wash on the
 * silhouette, and the colour the film decays to as it goes black (which is
 * *not* forced to `#000000` — a real black film still picks up a little of the
 * room). The film hue itself is deliberately absent from the settings block and
 * `bubblecage.js` says so at the point where a reader will look for it.
 */

/** Wavelength taps across 400–700 nm. See the note on aliasing above. */
const FILM_SAMPLES = 14;

/**
 * The CIE fit and the interference, as one chunk.
 *
 * Kept out of `shaders/lib/` on purpose: it is one ability's physics, not a
 * shared helper, and putting it in the library would invite the next author to
 * reach for it as a "rainbow" function — which is exactly the fake-iridescence
 * habit this material exists to avoid.
 */
const FILM_GLSL = /* glsl */ `
  #define FILM_SAMPLES ${FILM_SAMPLES}
  #define FILM_LAMBDA_MIN 400.0
  #define FILM_LAMBDA_SPAN 300.0

  /* A Gaussian with a different width either side of its peak. */
  float lobe(float w, float mu, float sLow, float sHigh) {
    float s = w < mu ? sLow : sHigh;
    float t = (w - mu) / max(s, 1e-3);
    return exp(-0.5 * t * t);
  }

  /*
   * Multi-lobe piecewise-Gaussian fit of the CIE 1931 2-degree observer.
   * Three lobes for x-bar (one of them negative, which is real — x-bar dips
   * below zero around 500 nm and dropping that lobe warms every cyan band by a
   * visible amount), two each for y-bar and z-bar.
   */
  vec3 cieFit(float w) {
    float cx = 1.056 * lobe(w, 599.8, 37.9, 31.0)
             + 0.362 * lobe(w, 442.0, 16.0, 26.7)
             - 0.065 * lobe(w, 501.1, 20.4, 26.2);
    float cy = 0.821 * lobe(w, 568.8, 46.9, 40.5)
             + 0.286 * lobe(w, 530.9, 16.3, 31.1);
    float cz = 1.217 * lobe(w, 437.0, 11.8, 36.0)
             + 0.681 * lobe(w, 459.0, 26.0, 13.8);
    return vec3(cx, cy, cz);
  }

  /* CIE XYZ (D65) to linear sRGB. Clamped by the caller, not here. */
  vec3 xyzToLinear(vec3 c) {
    return vec3(
       3.2406 * c.x - 1.5372 * c.y - 0.4986 * c.z,
      -0.9689 * c.x + 1.8758 * c.y + 0.0415 * c.z,
       0.0557 * c.x - 0.2040 * c.y + 1.0570 * c.z
    );
  }

  /*
   * The interference colour of a film d nanometres thick, seen at cosI against
   * its normal, with refractive index ior.
   *
   * Returns linear sRGB normalised so a perfectly reflecting film integrates to
   * roughly unit luminance — i.e. the *hue and saturation* of the reflection.
   * How much light there is at all is the caller's fresnel term, deliberately
   * kept separate so nobody can quietly turn this back into a fresnel ramp.
   */
  vec3 filmColour(float d, float cosI, float ior) {
    float n = max(ior, 1.001);
    float sin2 = max(0.0, 1.0 - cosI * cosI);
    /* Snell, inside the film. Grazing rays travel further through it, which is
       why the bands crowd toward the silhouette of a sphere. */
    float cosT = sqrt(max(0.0, 1.0 - sin2 / (n * n)));
    float opd = 2.0 * n * d * cosT;          //  nanometres

    vec3 xyz = vec3(0.0);
    float weight = 0.0;
    for (int i = 0; i < FILM_SAMPLES; i++) {
      float lambda = FILM_LAMBDA_MIN + FILM_LAMBDA_SPAN * (float(i) + 0.5) / float(FILM_SAMPLES);
      /* The half-wave from the hard front reflection is folded into the sign:
         I = 0.5*(1 + cos(2*pi*opd/lambda + pi)). */
      float intensity = 0.5 - 0.5 * cos(6.283185307179586 * opd / lambda);
      vec3 bar = cieFit(lambda);
      xyz += bar * intensity;
      weight += bar.y;
    }
    xyz /= max(weight, 1e-4);
    return max(xyzToLinear(xyz), vec3(0.0));
  }
`;

/* ---------------------------------------------------------------------- */
/* The vertex stage — every bubble placed from uniforms                    */
/* ---------------------------------------------------------------------- */
/**
 * No `instanceMatrix`, and that is the invariant.
 *
 * The obvious build is an `InstancedMesh` whose matrices the ability writes
 * each frame; it works, and it fails the moment somebody pauses and drags
 * `cageRadius`, because the matrix was composed from the old metres one frame
 * ago and nothing recomputes it on a zero-length frame unless the ability
 * remembers to. Here the *only* per-instance data is four unitless dice rolls —
 * a direction on the cage, a size fraction, a decorrelation seed and a pop roll
 * — and every metre and second comes out of a uniform. A paused cage genuinely
 * re-inflates under `bubbleRadius`.
 *
 * `aDir` is a unit vector rather than an angle pair because the Fibonacci
 * lattice the ability plants on is naturally Cartesian, and because a pair of
 * angles has a pole where the bubbles pile up.
 */
const FILM_VERTEX = /* glsl */ `
  #define PI 3.141592653589793
  #define TAU 6.283185307179586

  uniform float uAge;            // seconds since the cage was raised
  uniform vec3  uCentre;         // cage centre, world metres
  uniform float uSeed;           // per-cast dice roll, unitless

  /* --- the cage --- */
  uniform float uCageRadius;     // metres from the centre to a bubble's centre
  uniform float uCageSquash;     // vertical scale on the cage sphere, unitless
  uniform float uBreathe;        // radial pulse, fraction of uCageRadius
  uniform float uBreatheSpeed;   // Hz
  uniform float uJostle;         // tangential slop, metres
  uniform float uJostleSpeed;    // Hz

  /* --- one bubble --- */
  uniform float uBubbleRadius;   // metres, before aScale
  uniform float uStagger;        // seconds between the first bubble and the last
  uniform float uInflate;        // seconds one bubble takes to reach full size
  uniform float uOvershoot;      // how far past full size it goes on the way
  uniform float uSwell;          // extra radius as the film gives out, fraction

  /* --- the rupture --- */
  uniform float uPopAt;          // seconds after birth the film gives way
  uniform float uPopSpread;      // seconds of scatter on that, × aPop
  uniform float uBurstTime;      // seconds the hole takes to eat the bubble
  uniform float uRuptureJitter;  // radians the rupture wanders off the crown

  attribute vec3  aDir;          // unit direction on the cage — a dice roll
  attribute float aSeed;         // 0..1 decorrelation
  attribute float aScale;        // 0..2 size fraction
  attribute float aPop;          // 0..1 where in uPopSpread this one sits

  varying vec3  vNormalW;
  varying vec3  vViewW;
  varying vec3  vLocalN;         // the point on the film, in the bubble's frame
  varying vec3  vRupture;        // unit direction of the rupture, same frame
  varying float vSeed;
  varying float vLife;           // 0 at birth, 1 at the pop
  varying float vBurst;          // 0 before the pop, then 0..1 through it
  varying float vBorn;           // 0..1 inflation
  varying float vViewZ;

  ${noiseGLSL}

  void main() {
    vec3 dir = normalize(aDir);

    /* --- this bubble's own clock --- */
    float local = uAge - aSeed * max(uStagger, 0.0);
    float born  = clamp(local / max(uInflate, 0.02), 0.0, 1.0);
    float popAt = max(uPopAt + aPop * uPopSpread, 0.05);
    vLife  = clamp(local / popAt, 0.0, 1.0);
    vBurst = clamp((local - popAt) / max(uBurstTime, 0.01), 0.0, 1.0);
    vBorn  = born;

    /* Inflation with a real overshoot: a bubble blown off a wand snaps past its
       resting size and settles back. Easing straight in reads as a balloon on a
       pump, which is the wrong kind of slow. */
    float grow = smoothstep(0.0, 1.0, born);
    grow *= 1.0 + uOvershoot * sin(born * PI) * (1.0 - born);
    grow *= 1.0 + uSwell * smoothstep(0.62, 1.0, vLife);

    /* --- where the bubble sits on the cage --- */
    float breathe = 1.0 + uBreathe * sin(uAge * TAU * uBreatheSpeed + aSeed * TAU + uSeed);
    vec3 wob = vec3(
      snoise(dir * 1.7 + vec3(uAge * uJostleSpeed, aSeed * 9.1, uSeed)),
      snoise(dir * 1.7 + vec3(aSeed * 9.1, uAge * uJostleSpeed + 4.0, uSeed)),
      snoise(dir * 1.7 + vec3(uSeed, aSeed * 9.1, uAge * uJostleSpeed + 8.0))
    );
    /* Tangential only. A radial component would make the cage boil in and out
       and fight the breathe term, which is the one that is supposed to do that. */
    wob -= dir * dot(wob, dir);

    /* The squash is applied to the *offset*, not to the bubble, so the cage
       flattens into a dome while every bubble on it stays round. Scaling the
       geometry instead gives you a cage of eggs. */
    vec3 offset = vec3(dir.x, dir.y * uCageSquash, dir.z) * (uCageRadius * breathe);
    vec3 centre = uCentre + offset + wob * uJostle;
    float radius = max(uBubbleRadius, 0.0) * aScale * grow;

    vec3 nLocal = normalize(normal);
    vec3 world = centre + nLocal * radius;

    /* --- where the film will give way --- */
    /* The crown, jittered. Drainage makes the top the thinnest part of any
       bubble, so that is where it goes; the jitter is what stops thirty bubbles
       all bursting from the same pixel of their own north pole. */
    float ja = hash11(aSeed * 31.7 + uSeed) * TAU;
    float jb = hash11(aSeed * 13.1 + 5.0) * uRuptureJitter;
    vRupture = normalize(vec3(sin(jb) * cos(ja), cos(jb), sin(jb) * sin(ja)));

    vLocalN  = nLocal;
    vNormalW = nLocal;
    vViewW = cameraPosition - world;
    vSeed = aSeed;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/* ---------------------------------------------------------------------- */
/* The fragment stage                                                      */
/* ---------------------------------------------------------------------- */
/**
 * Three things happen here and the order matters.
 *
 * **The hole is cut first.** A ruptured film does not fade; a hole opens at the
 * thinnest point and the rim retracts across the bubble in a few milliseconds,
 * dragging the film into it. Fading the alpha instead was the first version and
 * it reads as thirty bubbles being switched off, which is somehow less
 * convincing than one bubble popping. The hole is an angular cap around
 * `vRupture` whose radius runs to `π`, so it genuinely eats the whole sphere,
 * and the band just outside it carries the collected rim.
 *
 * **Then the thickness, then the colour.** Thickness is a field over the film —
 * a drainage gradient plus marbling — and the interference reads it. Not the
 * other way round: an early attempt drove the *hue* from a noise field and
 * scaled the thickness to match, which is a rainbow texture wearing a physics
 * costume, and it does not do the one thing a real film does, which is march
 * its bands in order as the film thins.
 *
 * **The fresnel is amplitude only.** `filmColour()` is normalised, so it
 * carries the hue; Schlick against `uReflect` carries how much of it there is.
 * Keeping those two apart in the code is the only reason the trick survives
 * being tuned by somebody in a hurry.
 */
const FILM_FRAGMENT = /* glsl */ `
  #define PI 3.141592653589793

  uniform float uAge;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform vec3  uLightDir;
  uniform float uGlobalGlow;

  /* --- the film --- */
  uniform float uThickness;      // nanometres at the foot of the bubble
  uniform float uIor;            // refractive index of the film
  uniform float uDrain;          // 0..1 how much thinner the crown is
  uniform float uDrainSeed;      // 0..1 of that drainage present at birth
  uniform float uMarble;         // 0..1 thickness variation from convection
  uniform float uMarbleScale;    // marbling features per bubble
  uniform float uFlow;           // Hz the marbling creeps
  uniform float uThinRate;       // fraction of thickness lost by the pop

  /* --- how much light comes back --- */
  uniform float uReflect;        // normal-incidence reflectance
  uniform float uFresnel;        // Schlick exponent
  uniform float uFilmGain;       // master on the interference term
  uniform float uFilmSat;        // 0 = the film in grey, 1 = as computed
  uniform float uRim;            // wash on the silhouette
  uniform float uRimPower;
  uniform float uSheen;          // the specular glint
  uniform float uSheenSharp;
  uniform float uBurstFlash;     // brightness of the retracting rim
  uniform float uBurstWidth;     // radians of that rim

  uniform float uOpacity;
  uniform float uGlow;
  uniform float uSoftFade;
  uniform float uFade;

  uniform vec3  uColorBody;      // the water's own tint, under the interference
  uniform vec3  uColorBlack;     // what a film thinner than a quarter-wave is
  uniform vec3  uColorSheen;     // the glint
  uniform vec3  uColorRim;       // the silhouette wash

  varying vec3  vNormalW;
  varying vec3  vViewW;
  varying vec3  vLocalN;
  varying vec3  vRupture;
  varying float vSeed;
  varying float vLife;
  varying float vBurst;
  varying float vBorn;
  varying float vViewZ;

  ${commonGLSL}
  ${noiseGLSL}
  ${FILM_GLSL}

  /*
   * Film thickness at this point, nanometres.
   *
   * Gravity drains a real film downward, so the crown is thin and the foot is
   * thick, and the gradient steepens as the bubble ages. uThinRate is the whole
   * film losing water at once, which is what actually kills it.
   */
  float thicknessAt(vec3 nl, float seed, float life) {
    float crown = 0.5 + 0.5 * nl.y;
    float drain = clamp(uDrain, 0.0, 1.0) * (uDrainSeed + (1.0 - uDrainSeed) * life);
    float d = uThickness * (1.0 - drain * crown);
    d *= 1.0 - clamp(uThinRate, 0.0, 1.0) * life;
    /* Marbling. Sampled on the surface direction, not on world space: the
       swirls belong to this bubble and have to ride it, and a world-space field
       makes every bubble look cut out of one block of marble. */
    float swirl = fbm3(nl * uMarbleScale + vec3(0.0, -uFlow * uAge, seed * 27.0));
    d *= 1.0 + uMarble * swirl;
    return max(d, 0.0);
  }

  void main() {
    /* --- the hole, cut before anything is shaded --- */
    float away = acos(clamp(dot(vLocalN, vRupture), -1.0, 1.0));
    float hole = PI * pow(clamp(vBurst, 0.0, 1.0), 0.65);
    if (away < hole) discard;
    float retract = smoothstep(hole + max(uBurstWidth, 1e-3), hole, away) * step(0.001, vBurst);

    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewW);
    /* abs(), because the material is double sided and the far wall of the
       bubble is seen from behind. That second wall is not a cheat — it is why a
       bubble reads as hollow, and its interference is genuinely a different
       colour because the view angle across it is different. */
    float cosI = abs(dot(N, V));

    float d = thicknessAt(vLocalN, vSeed, vLife);
    vec3 hue = filmColour(d, cosI, uIor);
    hue = mix(vec3(dot(hue, vec3(0.2126, 0.7152, 0.0722))), hue, clamp(uFilmSat, 0.0, 2.0));

    /* As the film goes below a quarter-wave the interference term goes to zero
       on its own — the black film is not painted on. uColorBlack only decides
       what little is left, so the crown can be given a hint of the room instead
       of a hard hole. */
    float lum = dot(hue, vec3(0.2126, 0.7152, 0.0722));
    vec3 colour = mix(uColorBlack, hue * uColorBody, clamp(lum * 3.0, 0.0, 1.0));

    /* Amplitude, and only amplitude. */
    float schlick = uReflect + (1.0 - uReflect) * pow(1.0 - cosI, max(uFresnel, 0.1));
    colour *= schlick * uFilmGain;

    /* The wash that keeps the silhouette legible at twenty metres. */
    float rim = pow(1.0 - cosI, max(uRimPower, 0.1));
    colour += uColorRim * rim * uRim;

    /* One glint. A soap bubble has exactly one bright highlight and a broad
       specular lobe turns it into a plastic marble. */
    vec3 H = normalize(normalize(uLightDir) + V);
    colour += uColorSheen * pow(max(dot(N, H), 0.0), max(uSheenSharp, 1.0)) * uSheen * schlick;

    /* The retracting rim carries the film it has swallowed. */
    colour += uColorSheen * retract * uBurstFlash;

    float alpha = clamp(schlick * (0.22 + 0.78 * lum) + rim * uRim * 0.4 + retract, 0.0, 1.0);
    alpha *= uOpacity * uFade * smoothstep(0.0, 0.35, vBorn);
    if (alpha < 0.004) discard;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    colour *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(clamp(colour, 0.0, 48.0), alpha);
  }
`;

/* ---------------------------------------------------------------------- */
/* Geometry                                                                */
/* ---------------------------------------------------------------------- */
/**
 * One sphere, instanced, with four unitless per-instance attributes.
 *
 * The arrays are allocated once at construction at `capacity`; `plant()` fills
 * as many as the cast wants and `geometry.instanceCount` decides how many are
 * drawn. Nothing here is touched again per frame — I3.
 *
 * @param {number} capacity hard ceiling on bubbles
 * @param {number} segments longitudinal facets on one bubble
 * @param {number} rings latitudinal facets
 */
export function createBubbleGeometry(capacity = 64, segments = 26, rings = 18) {
  const source = new SphereGeometry(1, segments, rings);
  const geometry = new InstancedBufferGeometry();

  // Copied rather than shared, so disposing the source here cannot pull the
  // buffers out from under the instanced geometry later.
  geometry.setIndex(new BufferAttribute(Uint16Array.from(source.getIndex().array), 1));
  for (const name of ['position', 'normal', 'uv']) {
    const attribute = source.getAttribute(name);
    geometry.setAttribute(
      name,
      new BufferAttribute(Float32Array.from(attribute.array), attribute.itemSize)
    );
  }
  source.dispose();

  geometry.setAttribute('aDir', new InstancedBufferAttribute(new Float32Array(capacity * 3), 3));
  geometry.setAttribute('aSeed', new InstancedBufferAttribute(new Float32Array(capacity), 1));
  geometry.setAttribute('aScale', new InstancedBufferAttribute(new Float32Array(capacity), 1));
  geometry.setAttribute('aPop', new InstancedBufferAttribute(new Float32Array(capacity), 1));

  geometry.instanceCount = 0;
  // The bubbles are placed in the vertex shader, so the mesh's own bounds are
  // meaningless and the frustum test would cull the cage the moment the camera
  // looked away from the origin.
  geometry.boundingSphere = null;
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* The material                                                            */
/* ---------------------------------------------------------------------- */
/**
 * Additive and double sided, which together are the bubble.
 *
 * Additive because a film *adds* reflected light to whatever is behind it and
 * transmits the rest — a soap bubble never occludes anything. Double sided
 * because both walls reflect, and the pair of them adding is what makes a
 * sphere of film read as a sphere rather than as a disc.
 */
export function createThinFilmMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uAge: { value: 0 },
      uCentre: { value: new Vector3() },
      uSeed: { value: 0 },
      uFade: { value: 1 },

      uCageRadius: { value: 3.2 },
      uCageSquash: { value: 0.72 },
      uBreathe: { value: 0.05 },
      uBreatheSpeed: { value: 0.35 },
      uJostle: { value: 0.16 },
      uJostleSpeed: { value: 0.4 },

      uBubbleRadius: { value: 0.9 },
      uStagger: { value: 0.5 },
      uInflate: { value: 0.35 },
      uOvershoot: { value: 0.22 },
      uSwell: { value: 0.1 },

      uPopAt: { value: 2.1 },
      uPopSpread: { value: 1.7 },
      uBurstTime: { value: 0.16 },
      uRuptureJitter: { value: 0.7 },

      uThickness: { value: 420 },
      uIor: { value: 1.34 },
      uDrain: { value: 0.55 },
      uDrainSeed: { value: 0.3 },
      uMarble: { value: 0.3 },
      uMarbleScale: { value: 2.1 },
      uFlow: { value: 0.25 },
      uThinRate: { value: 0.72 },

      uReflect: { value: 0.06 },
      uFresnel: { value: 3.4 },
      uFilmGain: { value: 9 },
      uFilmSat: { value: 1 },
      uRim: { value: 0.35 },
      uRimPower: { value: 3 },
      uSheen: { value: 1.4 },
      uSheenSharp: { value: 90 },
      uBurstFlash: { value: 1.6 },
      uBurstWidth: { value: 0.12 },

      uOpacity: { value: 1 },
      uGlow: { value: 1.5 },
      uSoftFade: { value: 0.35 },

      uColorBody: { value: new Color('#bfe8ff') },
      uColorBlack: { value: new Color('#0a1420') },
      uColorSheen: { value: new Color('#ffffff') },
      uColorRim: { value: new Color('#4fd8d0') }
    }),
    vertexShader: FILM_VERTEX,
    fragmentShader: FILM_FRAGMENT
  });

  /**
   * Push the live settings and the cast's unitless beats into the uniforms.
   *
   * Called every frame, zero-length frames included. `state` carries a world
   * point, an age in seconds and two 0..1 beats; every nanometre, metre and
   * second below is read out of `settings.bubblecage` right here, which is what
   * makes a paused cage answer `filmThickness`.
   *
   * @param {object} state { centre, age, seed, fade, collapse }
   */
  material.userData.sync = (state) => {
    const c = settings.bubblecage;
    const g = settings.global;
    const u = material.uniforms;

    u.uCentre.value.copy(state.centre);
    u.uAge.value = state.age;
    u.uSeed.value = state.seed;
    u.uFade.value = state.fade;

    u.uCageRadius.value = c.zoneRadius * c.cageRadius;
    u.uCageSquash.value = c.cageSquash;
    u.uBreathe.value = c.cageBreathe;
    u.uBreatheSpeed.value = c.cageBreatheSpeed * g.noiseSpeed;
    u.uJostle.value = c.cageJostle * g.randomness;
    u.uJostleSpeed.value = c.cageJostleSpeed * g.noiseSpeed;

    u.uBubbleRadius.value = c.zoneRadius * c.bubbleRadius;
    u.uStagger.value = c.bubbleStagger;
    u.uInflate.value = c.bubbleInflate;
    u.uOvershoot.value = c.bubbleOvershoot;
    u.uSwell.value = c.bubbleSwell;

    // The collapse beat pulls every remaining bubble's deadline toward now, so
    // the fade phase *is* the cage giving out rather than a dissolve over it.
    u.uPopAt.value = Math.max(0.05, c.popTime * (1 - c.popCollapse * state.collapse));
    u.uPopSpread.value = c.popSpread * (1 - state.collapse);
    u.uBurstTime.value = c.popBurstTime;
    u.uRuptureJitter.value = c.popJitter;

    u.uThickness.value = c.filmThickness;
    u.uIor.value = c.filmIor;
    u.uDrain.value = c.filmDrain;
    u.uDrainSeed.value = c.filmDrainSeed;
    u.uMarble.value = c.filmMarble * g.noiseStrength;
    u.uMarbleScale.value = c.filmMarbleScale * g.noiseFrequency;
    u.uFlow.value = c.filmFlow * g.noiseSpeed;
    u.uThinRate.value = c.filmThinRate;

    u.uReflect.value = c.filmReflect;
    u.uFresnel.value = c.filmFresnel * g.fresnel;
    u.uFilmGain.value = c.filmGain * g.shaderIntensity;
    u.uFilmSat.value = c.filmSaturation;
    u.uRim.value = c.filmRim;
    u.uRimPower.value = c.filmRimPower;
    u.uSheen.value = c.filmSheen;
    u.uSheenSharp.value = c.filmSheenSharp;
    u.uBurstFlash.value = c.popFlash;
    u.uBurstWidth.value = c.popRimWidth;

    u.uOpacity.value = c.filmOpacity * g.opacity;
    u.uGlow.value = c.filmGlow * g.glow;
    u.uSoftFade.value = c.filmSoftFade;

    u.uColorBody.value.copy(getColor(c.colorFilmBody));
    u.uColorBlack.value.copy(getColor(c.colorFilmBlack));
    u.uColorSheen.value.copy(getColor(c.colorFilmSheen));
    u.uColorRim.value.copy(getColor(c.colorFilmRim));
  };

  return material;
}
