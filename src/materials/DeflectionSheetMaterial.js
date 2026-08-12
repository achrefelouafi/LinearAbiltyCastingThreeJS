import { ShaderMaterial, AdditiveBlending, DoubleSide, Color, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/* ====================================================================== */
/* DEFLECTION SHEET — where a jet goes after it stops                      */
/* ====================================================================== */
/**
 * The liquid sheet a pressurised jet throws when it hits a surface, and the
 * distribution that decides which way it goes.
 *
 * ## The problem this file exists to solve
 *
 * Every impact effect in this project sprays *radially*, because a radial puff
 * is what you get for free and it is right often enough. It is emphatically not
 * right for a jet. A jet arriving at forty-five degrees does not splash
 * evenly — almost all of it carries on downstream, a thin skirt wraps round the
 * sides, and essentially nothing comes back up the way it came. If the spray
 * does not know which way the surface is facing, the jet reads as a light
 * source touching the floor rather than as pressure hitting it.
 *
 * ## The distribution, from two conservation laws and nothing else
 *
 * Let **n** be the surface normal and **d** the jet's unit direction. The
 * reflection is
 *
 * ```
 *   r = d − 2(d·n)n
 * ```
 *
 * Split it: the component **in** the surface is untouched by the reflection,
 * and the component **along the normal** is exactly reversed. Those two facts
 * are the whole ability. The in-plane part is the direction the sheet runs
 * (`uAxis`); the reversed normal part is why a steep jet throws a crown and a
 * grazing one lies flat (`uCrown`).
 *
 * Now, how is the outgoing sheet distributed around the azimuth `φ` measured
 * from that axis? Write the flux as a density `q(φ)` on the circle and ask for
 * exactly two things:
 *
 *  - **mass is conserved** — `∫q dφ / 2π = 1`;
 *  - **in-plane momentum is conserved** — the sheet leaves at the speed it
 *    arrived (Bernoulli, inviscid), so the first Fourier cosine coefficient of
 *    `q` must equal the fraction of the jet's momentum that was already in the
 *    plane, which is `sin θ` for an incidence angle `θ` off the normal.
 *
 * The distribution on a circle whose *only* free parameter is its first Fourier
 * coefficient is the Poisson kernel — equivalently the wrapped Cauchy density:
 *
 * ```
 *   q(φ) = (1 − k²) / (1 + k² − 2k·cos φ)          k = the in-plane fraction
 * ```
 *
 * At `k = 0` — a jet straight down onto a flat floor — it is uniform, and the
 * spray genuinely is a radial ring, which is correct and is the one case where
 * everybody's default happens to be right. As `k → 1` it collapses onto a
 * narrow forward sheet. Nothing was chosen by eye.
 *
 * **And the particles use the same distribution from the other end.** The
 * wrapped Cauchy has an exact inverse CDF —
 * `φ = 2·atan( ((1−k)/(1+k))·tan(π(u−½)) )` — so `TorrentAbility` turns one
 * uniform random number into one exactly-distributed bearing, with no rejection
 * loop and no table. The sheet draws the density; the droplets sample it. They
 * cannot drift apart, because they are the same three lines of algebra.
 *
 * ## What the shipped `fanConcentration` is for
 *
 * The inviscid `k` is `sin θ`, and at the cast geometry this ability actually
 * ships — a mouth at chest height and a contact point twelve metres away — that
 * is 0.99, which collapses the fan to a line about seven degrees wide. Real
 * jets on real stone lose a great deal of their in-plane momentum to the
 * splash, the roughness and the boundary layer, so `k = sinθ · fanConcentration`
 * with the slider well below 1. That is a fudge and it is labelled as one; what
 * is not a fudge is that it is a single scalar on a term with a physical
 * meaning, so the *shape* of the fan still answers the geometry.
 */

/* ---------------------------------------------------------------------- */
/* The vertex stage                                                        */
/* ---------------------------------------------------------------------- */
/**
 * The sheet is drawn on the beam tube's `(t, a)` grid, reinterpreted: `t` is
 * distance out from the contact point as a fraction of that bearing's reach,
 * and `a` is the bearing itself. The seam the grid duplicates is put at `φ = π`
 * — directly upstream, where the sheet is thinnest and nobody is looking —
 * rather than at `φ = 0`, where it would run straight down the brightest part.
 *
 * Reusing that grid rather than building a fan geometry is not only tidiness:
 * the sheet's outline moves *every frame* as the fan swings, and a CPU-built
 * fan would be a buffer upload per frame and a captured metre besides.
 */
const SHEET_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  uniform vec3  uContact;      // where the jet lands, world metres
  uniform vec3  uNormal;       // the impact surface's unit normal
  uniform vec3  uAxis;         // in-plane fan axis (the reflected heading)
  uniform vec3  uBinormal;     // in-plane, orthogonal to uAxis

  uniform float uK;            // 0..0.985 — the in-plane momentum fraction
  uniform float uReach;        // metres the mean bearing carries
  uniform float uFanPower;     // how hard reach follows the density
  uniform float uOpen;         // 0..1 of the fan that exists yet
  uniform float uCrown;        // lift off the plate, x reach
  uniform float uCrownFall;    // how fast the sheet comes back down
  uniform float uFingers;      // ligaments the rim breaks into
  uniform float uFingerDepth;  // 0..1 how deep they cut
  uniform float uFingerScale;  // noise features around the rim
  uniform float uFingerSpeed;  // Hz they crawl
  uniform float uRipple;       // metres of surface chop on the sheet
  uniform float uRippleScale;  // chop features per metre
  uniform float uRippleSpeed;  // Hz it runs outward
  uniform float uAge;          // seconds since the jet made contact
  uniform float uSeed;

  varying float vS;            // 0 at the contact point, 1 at the rim
  varying float vQ;            // the density at this bearing, mean 1
  varying float vR;            // metres from the contact point
  varying vec3  vNormalW;
  varying vec3  vViewW;
  varying float vViewZ;

  ${noiseGLSL}

  void main() {
    float s = position.x;
    float phi = (position.y - 0.5) * TAU;

    /* The Poisson kernel. Mean 1 by construction, so uReach means "how far the
       average bearing carries" whatever the concentration is — which is what
       lets fanConcentration be dragged without the fan changing size. */
    float k = clamp(uK, 0.0, 0.985);
    float q = (1.0 - k * k) / max(1.0 + k * k - 2.0 * k * cos(phi), 1e-4);
    vQ = q;

    /* Ligaments. A liquid rim is Plateau-Rayleigh unstable: surface tension
       collects the sheet's edge into a torus and the torus beads up. Two terms,
       one periodic and one hashed, because a purely periodic rim reads as a
       gear and a purely noisy one reads as a stain. */
    float fingers = sin(phi * max(uFingers, 1.0) + uAge * uFingerSpeed + uSeed * 7.0) * 0.5 + 0.5;
    fingers = mix(fingers, snoise(vec3(cos(phi), sin(phi), uAge * 0.35) * uFingerScale + uSeed), 0.55);
    float reach = uReach * pow(max(q, 1e-4), uFanPower) * (1.0 - uFingerDepth * fingers) * uOpen;

    float r = reach * s;
    vec3 inPlane = uAxis * cos(phi) + uBinormal * sin(phi);

    /* The crown. Zero at the contact point, zero again where the rim lands, and
       scaled by the normal momentum the reflection handed back — a jet coming
       straight down throws a tall bell, a grazing one stays on the deck. */
    float fall = max(uCrownFall, 0.05);
    float shoulder = pow(max(1.0 - s, 0.0), fall);
    float lift = 4.0 * uCrown * reach * s * shoulder;
    lift += uRipple * snoise(vec3(r * uRippleScale, phi * 2.0, uAge * uRippleSpeed)) * s;

    vec3 world = uContact + inPlane * r + uNormal * lift;

    /* Analytic slope of the crown, so the sheet is lit as a surface rather than
       as a flat decal. Differentiating 4*A*s*(1-s)^f and dividing by dr/ds. */
    float slope = 4.0 * uCrown * (shoulder - fall * s * pow(max(1.0 - s, 1e-3), fall - 1.0));
    vNormalW = normalize(uNormal - inPlane * slope);

    vS = s;
    vR = r;
    vViewW = cameraPosition - world;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/* ---------------------------------------------------------------------- */
/* The fragment stage                                                      */
/* ---------------------------------------------------------------------- */
/**
 * The sheet thins as `q/r`, and that is the only reason it looks like water.
 *
 * A radially spreading sheet of fixed flux gets thinner in exact proportion to
 * how far out it has gone, because the same water is covering a circumference
 * that grows with `r`. So the alpha is `q / (1 + r/…)` rather than a linear
 * fade, and the consequence you can see is that the *bright* part of the fan is
 * a narrow crescent near the contact point that gets wider downstream — which
 * is what a jet on wet stone actually looks like and what a linear fade never
 * produces.
 *
 * The rim gets its own band because surface tension really does collect the
 * edge into a thick torus: the outline of a liquid sheet is its brightest part,
 * and losing that was the tell in the first version, which read as a decal.
 */
const SHEET_FRAGMENT = /* glsl */ `
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform vec3  uLightDir;
  uniform float uGlobalGlow;

  uniform float uThin;         // metres over which the sheet halves in thickness
  uniform float uBody;         // how much body the sheet keeps at all
  uniform float uRimWidth;     // 0..1 of the reach the rim occupies
  uniform float uRimGain;      // how bright that rim is
  uniform float uFresnel;      // grazing whitening exponent
  uniform float uSpecular;
  uniform float uGloss;        // Blinn exponent
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uSoftFade;
  uniform float uFade;

  uniform vec3  uColorSheet;   // the water where it is thick
  uniform vec3  uColorThin;    // ... and where it has stretched out
  uniform vec3  uColorRim;     // the collected edge
  uniform vec3  uColorSpray;   // the specular and the crest

  varying float vS;
  varying float vQ;
  varying float vR;
  varying vec3  vNormalW;
  varying vec3  vViewW;
  varying float vViewZ;

  ${commonGLSL}

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewW);
    float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);

    /* Mass conservation: the same flux over a circumference that grows with r. */
    float thickness = vQ / (1.0 + vR / max(uThin, 0.02));

    float rim = smoothstep(1.0 - clamp(uRimWidth, 0.01, 1.0), 1.0, vS);
    float fres = pow(1.0 - ndv, max(uFresnel, 0.1));

    vec3 colour = mix(uColorThin, uColorSheet, clamp(thickness, 0.0, 1.0));
    colour = mix(colour, uColorRim, rim);
    colour += uColorSpray * fres * 0.35;

    vec3 H = normalize(normalize(uLightDir) + V);
    colour += uColorSpray * pow(max(dot(N, H), 0.0), max(uGloss, 1.0)) * uSpecular;

    float alpha = clamp(thickness * uBody + rim * uRimGain + fres * 0.2, 0.0, 1.0);
    /* The sheet is born at the contact point and has to not be a hard disc
       there — the jet's own barrel is standing in that spot. */
    alpha *= smoothstep(0.0, 0.08, vS);
    alpha *= uOpacity * uFade;
    if (alpha < 0.004) discard;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    colour *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(clamp(colour, 0.0, 32.0), alpha);
  }
`;

/**
 * One draw call. Additive and double sided, like every other water surface in
 * the project: a sheet this thin transmits nearly everything and the far side
 * of the bell adding through the near side is most of what makes it read as a
 * volume of water rather than as a painted shape.
 */
export function createDeflectionSheetMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uContact: { value: new Vector3() },
      uNormal: { value: new Vector3(0, 1, 0) },
      uAxis: { value: new Vector3(0, 0, 1) },
      uBinormal: { value: new Vector3(1, 0, 0) },

      uK: { value: 0.6 },
      uReach: { value: 3.4 },
      uFanPower: { value: 0.8 },
      uOpen: { value: 0 },
      uCrown: { value: 0.12 },
      uCrownFall: { value: 1.6 },
      uFingers: { value: 13 },
      uFingerDepth: { value: 0.22 },
      uFingerScale: { value: 3.2 },
      uFingerSpeed: { value: 4.5 },
      uRipple: { value: 0.06 },
      uRippleScale: { value: 2.4 },
      uRippleSpeed: { value: 3.0 },
      uAge: { value: 0 },
      uSeed: { value: 0 },

      uThin: { value: 1.6 },
      uBody: { value: 0.65 },
      uRimWidth: { value: 0.16 },
      uRimGain: { value: 0.5 },
      uFresnel: { value: 2.6 },
      uSpecular: { value: 0.9 },
      uGloss: { value: 40 },
      uOpacity: { value: 1 },
      uGlow: { value: 1.3 },
      uSoftFade: { value: 0.3 },
      uFade: { value: 1 },

      uColorSheet: { value: new Color('#1f7f9a') },
      uColorThin: { value: new Color('#0b3a4c') },
      uColorRim: { value: new Color('#d6f6ff') },
      uColorSpray: { value: new Color('#ffffff') }
    }),
    vertexShader: SHEET_VERTEX,
    fragmentShader: SHEET_FRAGMENT
  });

  /**
   * Push the live settings and the cast's own frame into the uniforms.
   *
   * `state` carries the surface frame the ability computed this frame — the
   * contact point, the normal, and the two in-plane axes — plus two unitless
   * beats and the concentration. Every metre, radian and second below comes out
   * of `settings.torrent` right here, so the fan re-derives on a zero-length
   * frame and dragging `surfaceTilt` while paused swings it.
   *
   * @param {object} state { contact, normal, axis, binormal, k, crown, open, age, seed, fade }
   */
  material.userData.sync = (state) => {
    const c = settings.torrent;
    const g = settings.global;
    const u = material.uniforms;

    u.uContact.value.copy(state.contact);
    u.uNormal.value.copy(state.normal);
    u.uAxis.value.copy(state.axis);
    u.uBinormal.value.copy(state.binormal);

    u.uK.value = state.k;
    u.uOpen.value = state.open;
    u.uAge.value = state.age;
    u.uSeed.value = state.seed;
    u.uFade.value = state.fade;

    u.uReach.value = c.fanReach;
    u.uFanPower.value = c.fanPower;
    // Scaled by the reflection's own normal component — the physics, not a
    // second slider pretending to be it.
    u.uCrown.value = c.fanCrown * state.crown;
    u.uCrownFall.value = c.fanCrownFall;
    u.uFingers.value = c.fanFingers;
    u.uFingerDepth.value = c.fanFingerDepth * g.randomness;
    u.uFingerScale.value = c.fanFingerScale * g.noiseFrequency;
    u.uFingerSpeed.value = c.fanFingerSpeed * g.noiseSpeed;
    u.uRipple.value = c.fanRipple * g.noiseStrength;
    u.uRippleScale.value = c.fanRippleScale * g.noiseFrequency;
    u.uRippleSpeed.value = c.fanRippleSpeed * g.noiseSpeed;

    u.uThin.value = c.fanThin;
    u.uBody.value = c.fanBody;
    u.uRimWidth.value = c.fanRimWidth;
    u.uRimGain.value = c.fanRimGain;
    u.uFresnel.value = c.fanFresnel * g.fresnel;
    u.uSpecular.value = c.fanSpecular;
    u.uGloss.value = c.fanGloss;
    u.uOpacity.value = c.fanOpacity * g.opacity;
    u.uGlow.value = c.fanGlow * g.glow;
    u.uSoftFade.value = c.fanSoftFade;

    u.uColorSheet.value.copy(getColor(c.colorSheet));
    u.uColorThin.value.copy(getColor(c.colorSheetThin));
    u.uColorRim.value.copy(getColor(c.colorSheetRim));
    u.uColorSpray.value.copy(getColor(c.colorSheetSpray));
  };

  return material;
}
