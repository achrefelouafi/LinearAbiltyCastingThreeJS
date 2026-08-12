import {
  Color,
  DoubleSide,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { acquireGroundQuad, releaseGroundQuad } from './quads.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { getColor } from '../utils/color.js';

/* ====================================================================== */
/*  InkDiffusion — ink spreading on the floor, unstably                    */
/* ====================================================================== */

/**
 * What the front is doing.
 *
 * A `#define`, like `GroundField`'s mode, so the satellite loop and the crown
 * do not exist at all in a bloom and the bloom's octaves do not exist in a
 * wash. Fixed for the lifetime of the instance.
 */
export const InkMode = Object.freeze({
  /** Isotropic, unstable, branching. A drop of ink in still water. */
  BLOOM: 0,
  /** Directional mass, crown of spikes, satellite droplets. A flung blob. */
  SPLATTER: 1,
  /** Stable and soft-edged. A laid wash, for backing paper and underlays. */
  WASH: 2
});

/** Names in enum order, for an editor dropdown. */
export const INK_MODE_NAMES = ['BLOOM', 'SPLATTER', 'WASH'];

/* ---------------------------------------------------------------------- */
/* Shaders                                                                 */
/* ---------------------------------------------------------------------- */

const INK_VERTEX = /* glsl */ `
  uniform vec2 uQuadSize;      // metres, the full width and depth of the quad

  varying vec2  vMetres;       // metres from the anchor, in the field's own frame
  varying vec3  vWorld;
  varying float vViewZ;

  void main() {
    // The unit quad is +/-0.5 in x and z after its rotateX, so this is metres
    // from the anchor with the field's local +z pointing down the travel
    // vector. Everything in the fragment shader is in metres; nothing is in UV.
    vMetres = position.xz * uQuadSize;

    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vec4 mv = viewMatrix * world;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * The whole field. Nothing here is a simulation and nothing here is a texture.
 *
 * ## The fingering instability
 *
 * Ink dropped into water does not grow as a disc. The interface between a thin
 * fluid pushing into a thick one is **unstable**: any bulge in the front sees a
 * steeper local gradient, moves faster, and becomes a finger. Surface tension
 * fights back through the curvature term, which is what stops the whole rim
 * dissolving into fuzz.
 *
 * The part that has to be modelled — the part that separates a bloom from a
 * wobbly disc — is not that the front is rough. It is the **order the scales
 * arrive in**. A lobe two metres across cannot exist on a blob that is not yet
 * two metres across; the coarse modes are physically inadmissible until the
 * front has grown into them. So the picture goes: a young bloom is a small
 * crinkled disc, and a mature one is a handful of enormous branching lobes with
 * that same crinkle still riding on their tips. Watch a real one and that is
 * exactly what it does.
 *
 * `fingers()` implements that and nothing else:
 *
 *  - five octaves, wavelengths `uCoarse`, `uCoarse/2`, `uCoarse/4`, …;
 *  - octave *k* is **admitted** once the front radius passes `uOnset * L_k`, so
 *    the finest octave is live almost immediately and the coarsest is the last
 *    to arrive;
 *  - after admission its amplitude grows like `exp(uGrowth * travel / L_k)`,
 *    which is the linear instability's exponential;
 *  - growth **saturates** at `uGrowthMax`, so a mature mode's amplitude settles
 *    at roughly its own wavelength. Without the saturation the first octave to
 *    mature eats everything and the blob is two lobes for ever; with it, every
 *    mature scale contributes in proportion to its size and the result is
 *    self-similar and branchy.
 *
 * Two versions of this were wrong before this one, in different ways:
 *
 *  - `r + amplitude * fbm(atan(p.y, p.x))`. Sampling on the **bearing** hands
 *    every radius along a bearing the same value, so the "fingers" were
 *    dead-straight radial spokes of constant width from the centre to the rim —
 *    a firework, not a bloom. No number of octaves fixes it, because the error
 *    is in the domain and not in the spectrum. The noise here is sampled in
 *    two-dimensional metres, so a finger can bend and two fingers born at
 *    different radii do not line up.
 *  - all five octaves live from t = 0 at fixed amplitudes. That is an fbm ring,
 *    and the giveaway is that it is *the same shape at every size*: you can see
 *    that the blob is being scaled rather than grown. Admitting the octaves by
 *    radius is the whole of the difference, and it costs one `smoothstep`-free
 *    `max()` per octave.
 *
 * ## Why the crown *is* allowed to be spokes
 *
 * In `SPLATTER` the leading edge grows a crown of teeth, and those are
 * bearing-indexed on purpose. A crown is a Rayleigh–Plateau breakup of an
 * expanding *rim* — it genuinely is periodic in bearing, its teeth genuinely
 * are radial, and its tooth count genuinely does rise with the rim's radius
 * (`teeth = 2 pi r / uCrownSpacing`). The rule was never "never index on
 * bearing", it was "do not index on bearing when the physics is areal".
 *
 * ## Wet and dry
 *
 * A fragment's ink arrived when the front radius equalled its distance. The
 * front law `r = uSpread * t^uSpreadPower` inverts in closed form, so
 * `arrivalOf(d)` gives the arrival time exactly, `uAge - arrival` gives the age
 * of the film at every point, and the gloss is `exp(-age / uDryTime)`. No
 * history buffer, no per-fragment state, and the whole drying pattern
 * re-resolves when a paused author drags `dryTime`.
 *
 * ## The anti-glow clamp
 *
 * `UnrealBloomPass` runs on linear scene colour before the tone map, so its
 * threshold (`settings.post.bloomThreshold`, 0.88) is a linear luminance.
 * `uCeiling` hard-clamps this material's luminance below it. The wet gloss is
 * the one specular term in the school and it is inside that clamp — which is
 * the point: a reflection that cannot exceed the bloom threshold is an
 * observation about a wet surface, not an emission.
 */
function inkFragment(mode, sources, satellites) {
  return /* glsl */ `
  #define INK_MODE ${mode}
  #define INK_SOURCES ${sources}
  #define INK_SATELLITES ${satellites}
  #define TAU 6.283185307179586

  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform vec3  uLightDir;

  uniform float uAge;           // seconds since the cast began
  uniform float uSeed;
  uniform float uRadius;        // metres, the authored extent of the field
  uniform vec3  uAxisAlong;     // world unit vector the field's local +z maps to
  uniform vec3  uAxisAcross;    // world unit vector its local +x maps to

  /* --- the spread --- */
  uniform float uSpread;        // metres of front radius at t = 1 s
  uniform float uSpreadPower;   // r ~ t^power; 0.5 is Fickian
  uniform float uEdge;          // metres, the width of the interface
  uniform float uClipSoft;      // metres the mass fades out over at uRadius
  uniform float uSources;       // live nuclei
  uniform float uSourceScatter; // fraction of the radius the extra nuclei scatter over
  uniform float uSourceDelay;   // seconds each later nucleus starts behind the first
  uniform vec4  uSourceDice[INK_SOURCES];   // x,y scatter in -1..1 · z noise phase · w crown phase

  /* --- the instability --- */
  uniform float uFinger;        // overall amplitude, 0 gives a disc
  uniform float uFingerMax;     // cap, as a fraction of the front radius
  uniform float uCoarse;        // metres, the coarsest (last-admitted) wavelength
  uniform float uOnset;         // front radii per wavelength before a mode is admitted
  uniform float uGrowth;        // e-folds per wavelength of front travel
  uniform float uGrowthMax;     // saturation of that growth

  /* --- the film --- */
  uniform float uCore;          // density floor inside the blob
  uniform float uFalloff;       // metres of e-folding out from a nucleus
  uniform float uFilm;          // alpha floor inside the coverage
  uniform float uGranulation;   // pigment mottle
  uniform float uGranScale;     // features per metre
  uniform float uRing;          // strength of the deposition line at the interface
  uniform float uRingWidth;     // metres

  /* --- wet and dry --- */
  uniform float uDryTime;       // seconds for the gloss to fall to 1/e
  uniform float uWetDarken;     // how far the wet film pulls toward colorWet
  uniform float uGloss;         // specular strength on the wet film
  uniform float uGlossPower;    // its tightness
  uniform float uMeniscus;      // how far the film's normal tips at the interface

  /* --- splatter --- */
  uniform float uMassAlong;     // metric stretch down the travel vector
  uniform float uMassAcross;    // and across it
  uniform float uMassLead;      // fraction of the front the mass sits forward by
  uniform float uMassRear;      // >1 blunts the trailing edge
  uniform float uCrown;         // fraction of the front the teeth add
  uniform float uCrownSpacing;  // metres of rim per tooth
  uniform float uCrownSharp;    // tooth narrowness
  uniform float uCrownGate;     // how tightly the crown is held to the leading arc
  uniform float uSatellites;    // live droplets
  uniform float uSatMin;        // metres, smallest droplet radius
  uniform float uSatMax;        // metres, largest
  uniform float uSatAlpha;      // exponent of the size power law
  uniform float uThrowNear;     // metres, nearest droplet
  uniform float uThrowFar;      // metres, furthest
  uniform float uThrowCurve;    // bias of the distance draw
  uniform float uThrowSpread;   // lateral cone, as a fraction of the distance
  uniform float uSatTail;       // tail length, in droplet radii
  uniform float uSatDelay;      // seconds the furthest droplet lands behind the mass
  uniform float uSatJitter;     // seconds of per-droplet slop on that
  uniform float uSatPop;        // seconds a droplet takes to appear
  uniform vec4  uSatDice[INK_SATELLITES];   // x size draw · y lateral draw · z delay dice · w spare

  /* --- the mark --- */
  uniform float uOpacity;
  uniform float uFade;
  uniform float uCeiling;       // max linear luminance — the anti-bloom clamp
  uniform float uSoftFade;      // metres of depth feather
  uniform float uTint;
  uniform float uTintDensity;
  uniform vec3  uColorWash;
  uniform vec3  uColorBody;
  uniform vec3  uColorDeep;
  uniform vec3  uColorPool;
  uniform vec3  uColorRing;
  uniform vec3  uColorWet;
  uniform vec3  uColorGloss;

  varying vec2  vMetres;
  varying vec3  vWorld;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  /** The unperturbed front radius at time t. Fickian by default. */
  float frontAt(float t) {
    return uSpread * pow(max(t, 0.0), max(uSpreadPower, 0.05));
  }

  /** Its exact inverse: when the front reached distance d. */
  float arrivalOf(float d) {
    return pow(max(d, 0.0) / max(uSpread, 1e-4), 1.0 / max(uSpreadPower, 0.05));
  }

  /**
   * The perturbation of the interface, in metres. See the header.
   *
   * Positive pushes the front outward. Sampled on q in metres, never on the
   * bearing.
   */
  float fingers(vec2 q, float rf, float phase) {
    float sum = 0.0;
    float L = max(uCoarse, 0.05);
    for (int i = 0; i < 5; i++) {
      // A lobe of wavelength L is inadmissible until the front has grown into
      // it, so the coarse octaves are the last to arrive, not the first.
      float onset = uOnset * L;                       // metres of front radius
      float e = min(uGrowth * max(rf - onset, 0.0) / L, 8.0);
      float g = min(exp(e) - 1.0, uGrowthMax);
      sum += L * g * snoise(vec3(q / L, phase + float(i) * 37.0));
      L *= 0.5;
    }
    return sum;
  }

  void main() {
    vec2 q0 = vMetres;

    float covBest = 0.0;      // how much ink is here at all
    float densBest = 0.0;     // how thick it is
    float ringBest = 0.0;     // the deposition line
    float wetBest = 0.0;      // 1 just laid, 0 dry
    float dBest = 1e4;        // signed distance to the nearest interface
    vec2  gradBest = vec2(0.0, 1.0);

    /* --- the nuclei --------------------------------------------------- */
    for (int i = 0; i < INK_SOURCES; i++) {
      // Masked, not broken out of: a break on a uniform compiles on the driver
      // you have and fails on the one the player has.
      float live = step(float(i) + 0.5, uSources);
      vec4 dice = uSourceDice[i];

      // Nucleus 0 is the anchor itself; the rest scatter. A zone cast that
      // dropped every nucleus in the same place is one blob, and ink in water
      // is never one blob.
      float extra = step(0.5, float(i));
      vec2 nuc = dice.xy * uSourceScatter * uRadius * extra;
      float age = uAge - uSourceDelay * float(i);
      float rf = frontAt(age);

      vec2 q = q0 - nuc;
      vec2 core = q;
      float d;

      #if INK_MODE == 1
        // Directional. The anisotropy lives in the *metric*, not in a
        // bearing-indexed radius: measuring the front as f(bearing) gives every
        // point along a bearing the same answer and the mass grows flat facets
        // down its flanks.
        core = q - vec2(0.0, uMassLead * rf);
        vec2 s = vec2(core.x / max(uMassAcross, 0.05), core.y / max(uMassAlong, 0.05));
        // The trailing edge is where the sheet tore away, not where it spread
        // to, so it is blunter than the leading edge.
        s.y *= mix(1.0, max(uMassRear, 0.05), step(core.y, 0.0));
        d = length(s);
      #else
        d = length(core);
      #endif

      float cl = length(core);
      vec2 radial = cl > 1e-4 ? core / cl : vec2(0.0, 1.0);

      #if INK_MODE != 2
        float cap = uFingerMax * rf;
        d -= clamp(uFinger * fingers(q, rf, dice.z), -cap, cap);
      #endif

      /*
       * The crown is allowed to move the *silhouette* and nothing else, which
       * is why it gets its own distance rather than being folded into d.
       *
       * The first version subtracted it from d outright. The teeth came out
       * right and the inside of the mass grew a fan of radial spokes reaching
       * all the way to the impact point, because the film's thickness term
       * reads the same d and the crown is periodic in bearing at every radius.
       * A rim instability is a property of the rim. dShade never sees it.
       */
      float dShade = d;
      #if INK_MODE == 1
        // Bearing-indexed and radial because a rim instability really is both
        // — see the header. The tooth count rises with the rim's own radius.
        float bearing = atan(core.x, core.y);
        float gate = pow(max(radial.y, 0.0), max(uCrownGate, 0.01));
        float teeth = max(3.0, floor(TAU * max(rf, 0.05) / max(uCrownSpacing, 0.05)));
        float tooth = pow(max(cos(teeth * bearing + dice.w * TAU), 0.0), max(uCrownSharp, 1.0));
        d -= uCrown * rf * tooth * gate;
      #endif

      float w = max(uEdge, 1e-3);
      float cov = smoothstep(rf + w, rf - w, d) * live;

      /*
       * The zone boundary. Measured from the anchor rather than the nucleus,
       * because a zone is the ability's, not the blob's — and soft, over
       * uClipSoft metres, because a front that has outgrown its quad is the one
       * failure that reads instantly: the ink ends in a straight line with a
       * corner on it. Satellites are exempt; they are thrown out of the zone on
       * purpose.
       */
      cov *= smoothstep(uRadius, uRadius - max(uClipSoft, 1e-3), length(q0));

      float wetAge = max(age - arrivalOf(d), 0.0);
      float wet = exp(-wetAge / max(uDryTime, 1e-3));
      float dens = cov * (uCore + (1.0 - uCore) * exp(-max(dShade, 0.0) / max(uFalloff, 0.05)));

      float rz = (dShade - rf) / max(uRingWidth, 1e-3);
      float ring = exp(-rz * rz) * cov;

      float take = step(densBest, dens);
      densBest = max(densBest, dens);
      covBest = max(covBest, cov);
      ringBest = max(ringBest, ring);
      wetBest = mix(wetBest, wet * cov, take);
      gradBest = mix(gradBest, radial, take);
      dBest = mix(dBest, d - rf, take);
    }

    /* --- the satellites ------------------------------------------------ */
    #if INK_MODE == 1
    for (int i = 0; i < INK_SATELLITES; i++) {
      float live = step(float(i) + 0.5, uSatellites);
      vec4 dice = uSatDice[i];

      // Bounded-Pareto inverse CDF on the droplet radius. A fragmenting sheet
      // really does produce a power law, and it is the *only* thing that makes
      // a splatter read as a splatter: a uniform draw gives a dozen same-sized
      // dots and the eye files it as a stencil.
      float a = max(uSatAlpha, 1.05);
      float lo = max(uSatMin, 1e-3);
      float hi = max(uSatMax, lo * 1.001);
      float loA = pow(lo, -a);
      float hiA = pow(hi, -a);
      float size = pow(dice.x * (hiA - loA) + loA, -1.0 / a);

      // Small droplets fly furthest — they detach last, from the fastest part
      // of the sheet, and carry the least drag per unit mass. Driving distance
      // off the *same* draw is what makes the far field fine and the near field
      // coarse, which is the readable half of the effect.
      float reach = mix(uThrowNear, uThrowFar, pow(1.0 - dice.x, max(uThrowCurve, 0.05)));
      vec2 bead = vec2((dice.y - 0.5) * 2.0 * uThrowSpread * reach, reach);

      // A teardrop: a disc at the bead tapering to nothing down a tail pointing
      // back toward the throw. A droplet that lands moving forward does not
      // make a circle, and the tails are the direction cue that turns twelve
      // scattered dots into one thrown handful.
      vec2 tail = -vec2(0.0, uSatTail * size);
      float h = clamp(dot(q0 - bead, tail) / max(dot(tail, tail), 1e-6), 0.0, 1.0);
      float sd = length(q0 - (bead + tail * h)) - size * (1.0 - h);

      float w = max(uEdge, 1e-3) * 0.6;
      float sAge = uAge - uSatDelay * (reach / max(uThrowFar, 1e-3)) - dice.z * uSatJitter;
      float cov = smoothstep(w, -w, sd) * live * smoothstep(0.0, max(uSatPop, 1e-3), sAge);
      float wet = exp(-max(sAge, 0.0) / max(uDryTime, 1e-3));

      vec2 gv = q0 - bead;
      float gl2 = dot(gv, gv);
      vec2 radial = gl2 > 1e-8 ? gv * inversesqrt(gl2) : vec2(0.0, 1.0);

      float rz = sd / max(uRingWidth, 1e-3);
      float take = step(densBest, cov);
      densBest = max(densBest, cov);
      covBest = max(covBest, cov);
      ringBest = max(ringBest, exp(-rz * rz) * cov);
      wetBest = mix(wetBest, wet * cov, take);
      gradBest = mix(gradBest, radial, take);
      dBest = mix(dBest, sd, take);
    }
    #endif

    /* --- the paper ----------------------------------------------------- */
    // Granulation is pigment settling into the tooth of the paper, so it shows
    // where the film has dried and is invisible while it is still wet.
    float grain = snoise(vec3(q0 * uGranScale, uSeed * 0.37)) * 0.5 + 0.5;
    float granAmt = uGranulation * (1.0 - 0.6 * wetBest);
    float mottle = 1.0 - granAmt * grain;

    float density = clamp(densBest * mottle, 0.0, 1.0);
    float alpha = clamp(covBest * (uFilm + (1.0 - uFilm) * density) * uOpacity, 0.0, 1.0);
    alpha *= clamp(uFade, 0.0, 1.0);
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    float g = clamp(uTint + density * uTintDensity, 0.0, 1.0);
    vec3 colour = gradient4(uColorWash, uColorBody, uColorDeep, uColorPool, g);
    colour = mix(colour, uColorWet, clamp(wetBest * uWetDarken, 0.0, 1.0));
    colour = mix(colour, uColorRing, clamp(ringBest * uRing, 0.0, 1.0));

    /* --- the wet gloss --------------------------------------------------
     * The film is a lens: flat in the middle, tipped outward at the meniscus,
     * which is exactly where the interface is. dBest is the signed distance to
     * that interface, so a Gaussian on it is the lip, and the tilt is the
     * radial direction rotated into world space by the field's own axes.
     */
    float lz = dBest / max(uRingWidth, 1e-3);
    float lip = exp(-lz * lz);
    vec3 tilt = uAxisAcross * gradBest.x + uAxisAlong * gradBest.y;
    vec3 nrm = normalize(vec3(0.0, 1.0, 0.0) - tilt * (uMeniscus * lip));
    vec3 viewDir = normalize(cameraPosition - vWorld);
    vec3 halfway = normalize(viewDir + normalize(uLightDir));
    float spec = pow(max(dot(nrm, halfway), 0.0), max(uGlossPower, 1.0));
    colour += uColorGloss * (spec * uGloss * wetBest);

    // The clamp that keeps this school out of the bloom pass. Never multiplied
    // by uGlobalGlow — ink is not emissive and the global glow slider must not
    // be able to light it.
    float lum = dot(colour, vec3(0.2126, 0.7152, 0.0722));
    colour *= lum > uCeiling ? uCeiling / max(lum, 1e-4) : 1.0;

    gl_FragColor = vec4(colour, alpha);
  }
`;
}

/* ---------------------------------------------------------------------- */
/* Scratch — the frame allocates nothing (I3)                              */
/* ---------------------------------------------------------------------- */

const _flat = new Vector3();

/** Tolerates a picker string or a THREE.Color, like `Swarm#setColors` does. */
const _col = (value) => (typeof value === 'string' ? getColor(value) : value);

/* ---------------------------------------------------------------------- */
/* InkDiffusion                                                            */
/* ---------------------------------------------------------------------- */

/**
 * **What it draws.** One ground quad carrying ink that spreads through a real
 * fingering instability, glossy at the wet leading edge and matte behind it,
 * with a `SPLATTER` mode that adds a directional mass, a crown of rim teeth and
 * a power-law scatter of satellite droplets down the travel vector.
 *
 * **Draw calls.** One. Always one, whatever the mode, however many satellites.
 *
 * **What it reads from settings.** Nothing directly. `update(now, params)`
 * takes a live block and resolves `p.key ?? default` against
 * `inkDiffusionParams()`. `now` is the ability's age in seconds and it is the
 * *only* thing the front law needs, because the front is closed-form in it —
 * pause with **P** and drag `spread`, `coarse` or `dryTime` and the standing
 * pattern re-grows.
 *
 * **The one rule for using it well.** *`coarse` is the only knob that changes
 * what the pattern is; everything else changes how much of it you get.* The
 * finger wavelength sets the whole morphology — 3 m of `coarse` on a 4 m field
 * gives two fat lobes, 0.8 m gives lace. Set it against the field radius first,
 * then reach for `finger` and `growth`. Authors who start with `finger` end up
 * with a wobbly disc turned up loud.
 *
 * ---
 *
 * ## Seeds
 *
 * `roll()` fills two dice arrays and one noise phase, all unitless. Those dice
 * are **uploaded as uniform arrays** rather than hashed in the shader, for one
 * specific reason: `satellitePoint()` has to agree with the fragment shader
 * exactly, because `splatterbrand` throws a `Projectile` at each satellite and
 * it has to land in the droplet rather than near it. A JS mirror of a GLSL hash
 * is a mirror of float32 rounding and it drifts. The arrays are indexed only by
 * the loop counter, which is the one indexing ESSL 1.00 allows.
 *
 * ## Placement
 *
 * `setPlacement(anchor, along)` puts the field at a world point with its local
 * `+z` down `along` (projected flat), which is the direction satellites are
 * thrown and the mass is stretched. The quad's *size* is not part of placement:
 * it is re-derived from `radius` — and, in `SPLATTER`, from `throwFar` — every
 * frame, so dragging either grows the canvas along with the drawing on it.
 */
export class InkDiffusion {
  /**
   * @param {THREE.Object3D} parent the ability's group
   * @param {object}  [options]
   * @param {number}  [options.mode=InkMode.BLOOM]  a `#define`, fixed for the lifetime
   * @param {number}  [options.sources=4]      nuclei the shader carries; `params.sources` drives how many are live
   * @param {number}  [options.satellites=16]  droplet slots, SPLATTER only
   * @param {number}  [options.layer=LAYER.VFX]
   * @param {number}  [options.renderOrder=6]
   * @param {string}  [options.name]
   */
  constructor(
    parent,
    {
      mode = InkMode.BLOOM,
      sources = 4,
      satellites = 16,
      layer = LAYER.VFX,
      renderOrder = 6,
      name = null
    } = {}
  ) {
    this.mode = mode;
    this.sources = Math.max(1, Math.round(sources));
    this.satellites = Math.max(1, Math.round(satellites));

    // The shared, refcounted ground quad. This module originally built its own,
    // on the argument that a private four-vertex plane has no shared-state bug
    // surface — true when the alternative was importing GroundField, which is
    // two thousand lines. vfx/quads.js is thirty, holds nothing but the buffer
    // and a count, and is now what every flat effect in the library draws on.
    this.geometry = acquireGroundQuad();

    const sourceDice = [];
    for (let i = 0; i < this.sources; i++) sourceDice.push(new Vector4());
    const satDice = [];
    for (let i = 0; i < this.satellites; i++) satDice.push(new Vector4());

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: NormalBlending,
      side: DoubleSide,
      /*
       * True, and deliberately unlike the emissive modules in this library.
       * Inert as things stand — the composer always renders to a target, where
       * three switches materials to NoToneMapping and OutputPass does the grade
       * once for everything — but ink is pigment on a floor, and it belongs
       * under the same grade as the floor. The flag says which kind of thing
       * this is; the ceiling in the fragment is what actually enforces it.
       */
      toneMapped: true,
      uniforms: sharedUniforms({
        uQuadSize: { value: new Vector2(1, 1) },
        uAge: { value: 0 },
        uSeed: { value: 0 },
        uRadius: { value: 6 },
        uAxisAlong: { value: new Vector3(0, 0, 1) },
        uAxisAcross: { value: new Vector3(1, 0, 0) },

        uSpread: { value: 2.6 },
        uSpreadPower: { value: 0.5 },
        uEdge: { value: 0.09 },
        uClipSoft: { value: 0.8 },
        uSources: { value: 1 },
        uSourceScatter: { value: 0.35 },
        uSourceDelay: { value: 0.18 },
        uSourceDice: { value: sourceDice },

        uFinger: { value: 0.5 },
        uFingerMax: { value: 0.75 },
        uCoarse: { value: 2.4 },
        uOnset: { value: 0.55 },
        uGrowth: { value: 0.9 },
        uGrowthMax: { value: 1.5 },

        uCore: { value: 0.5 },
        uFalloff: { value: 5.5 },
        uFilm: { value: 0.6 },
        uGranulation: { value: 0.22 },
        uGranScale: { value: 1.6 },
        uRing: { value: 0.55 },
        uRingWidth: { value: 0.12 },

        uDryTime: { value: 1.6 },
        uWetDarken: { value: 0.35 },
        uGloss: { value: 0.22 },
        uGlossPower: { value: 44 },
        uMeniscus: { value: 0.55 },

        uMassAlong: { value: 1.35 },
        uMassAcross: { value: 0.8 },
        uMassLead: { value: 0.22 },
        uMassRear: { value: 1.45 },
        uCrown: { value: 0.35 },
        uCrownSpacing: { value: 0.55 },
        uCrownSharp: { value: 7 },
        uCrownGate: { value: 2.2 },
        uSatellites: { value: 12 },
        uSatMin: { value: 0.055 },
        uSatMax: { value: 0.42 },
        uSatAlpha: { value: 2.3 },
        uThrowNear: { value: 1.6 },
        uThrowFar: { value: 9 },
        uThrowCurve: { value: 1.7 },
        uThrowSpread: { value: 0.22 },
        uSatTail: { value: 2.4 },
        uSatDelay: { value: 0.42 },
        uSatJitter: { value: 0.12 },
        uSatPop: { value: 0.06 },
        uSatDice: { value: satDice },

        uOpacity: { value: 1 },
        uFade: { value: 1 },
        uCeiling: { value: 0.62 },
        uSoftFade: { value: 0.25 },
        uTint: { value: 0.05 },
        uTintDensity: { value: 1.05 },
        uColorWash: { value: new Color('#a89a88') },
        uColorBody: { value: new Color('#4c433b') },
        uColorDeep: { value: new Color('#1a1613') },
        uColorPool: { value: new Color('#080706') },
        uColorRing: { value: new Color('#2e2019') },
        uColorWet: { value: new Color('#100c09') },
        uColorGloss: { value: new Color('#c8ced2') }
      }),
      vertexShader: INK_VERTEX,
      fragmentShader: inkFragment(mode, this.sources, this.satellites)
    });

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = name ?? `InkDiffusion:${INK_MODE_NAMES[mode] ?? mode}`;
    this.mesh.layers.set(layer);
    // Below the emissive decals, above the floor. Ink is shaded, never additive
    // — there is no additive path in this module and there is not going to be
    // one, because "ink that adds light" is the failure mode of the school.
    this.mesh.renderOrder = renderOrder;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    parent?.add(this.mesh);

    this._anchor = new Vector3();
    this._along = new Vector3(0, 0, 1);
    this._yaw = 0;
    this._age = 0;
    this.seed = 0;
    this._p = inkDiffusionParams();
    this.roll(0);
  }

  get object3D() {
    return this.mesh;
  }

  get uniforms() {
    return this.material.uniforms;
  }

  /** One. Always one. */
  get drawCalls() {
    return 1;
  }

  /** Seconds of spread the last `update()` was given. */
  get age() {
    return this._age;
  }

  setVisible(visible) {
    this.mesh.visible = visible;
    return this;
  }

  /**
   * Where the field is and which way the ink was thrown.
   *
   * `along` is projected flat and normalised; it becomes the field's local `+z`,
   * so it is the axis the mass stretches down and the satellites fly along. For
   * a `BLOOM` or a `WASH` it only rotates the noise, which is still worth
   * passing the cast direction for — two casts down the same line should not be
   * distinguishable by their grain.
   */
  setPlacement(anchor, along) {
    this._anchor.copy(anchor);
    _flat.copy(along);
    _flat.y = 0;
    if (_flat.lengthSq() < 1e-8) _flat.set(0, 0, 1);
    _flat.normalize();
    this._along.copy(_flat);
    this._yaw = Math.atan2(_flat.x, _flat.z);
    return this;
  }

  /**
   * Re-roll the unitless dice. Call from `onSpawn` and nowhere else.
   *
   * Nothing rolled here has a unit: nucleus scatter is a fraction of the
   * radius, a droplet's size draw is a probability, the phases are phases. Every
   * metre they turn into is resolved in the fragment shader from live uniforms,
   * which is why a paused `throwFar` drag moves the whole spatter pattern
   * without re-rolling it.
   */
  roll(seed = Math.random() * 100) {
    this.seed = seed;
    this.material.uniforms.uSeed.value = seed;
    const src = this.material.uniforms.uSourceDice.value;
    for (let i = 0; i < src.length; i++) {
      src[i].set(
        Math.random() * 2 - 1, //  scatter x, -1..1
        Math.random() * 2 - 1, //  scatter z, -1..1
        Math.random() * 100, //  the octaves' noise phase
        Math.random() //  the crown's angular phase
      );
    }
    const sat = this.material.uniforms.uSatDice.value;
    for (let i = 0; i < sat.length; i++) {
      sat[i].set(Math.random(), Math.random(), Math.random(), Math.random());
    }
    return this;
  }

  /** Hide the field. Leaves the instance reusable — the pooling contract. */
  reset() {
    this._age = 0;
    this.material.uniforms.uAge.value = 0;
    this.mesh.visible = false;
    return this;
  }

  /** Fill `_p` from the caller's block, defaults where it is silent. */
  _resolve(params) {
    const p = this._p;
    for (const key in DEFAULT_PARAMS) {
      const value = params[key];
      p[key] = value === undefined ? DEFAULT_PARAMS[key] : value;
    }
    return p;
  }

  /**
   * @param {number} now    the ability's age in seconds — the front law's only input
   * @param {object} params live block; anything absent falls back to `inkDiffusionParams()`
   */
  update(now, params) {
    const p = this._resolve(params ?? DEFAULT_PARAMS);
    const u = this.material.uniforms;
    this._age = Math.max(0, now);

    u.uAge.value = this._age;
    u.uRadius.value = p.radius;

    u.uSpread.value = p.spread;
    u.uSpreadPower.value = p.spreadPower;
    u.uEdge.value = p.edge;
    u.uClipSoft.value = p.clipSoft;
    u.uSources.value = Math.max(0, Math.min(this.sources, Math.round(p.sources)));
    u.uSourceScatter.value = p.sourceScatter;
    u.uSourceDelay.value = p.sourceDelay;

    u.uFinger.value = p.finger;
    u.uFingerMax.value = p.fingerMax;
    u.uCoarse.value = p.coarse;
    u.uOnset.value = p.onset;
    u.uGrowth.value = p.growth;
    u.uGrowthMax.value = p.growthMax;

    u.uCore.value = p.core;
    u.uFalloff.value = p.falloff;
    u.uFilm.value = p.film;
    u.uGranulation.value = p.granulation;
    u.uGranScale.value = p.granScale;
    u.uRing.value = p.ring;
    u.uRingWidth.value = p.ringWidth;

    u.uDryTime.value = p.dryTime;
    u.uWetDarken.value = p.wetDarken;
    u.uGloss.value = p.gloss;
    u.uGlossPower.value = p.glossPower;
    u.uMeniscus.value = p.meniscus;

    u.uMassAlong.value = p.massAlong;
    u.uMassAcross.value = p.massAcross;
    u.uMassLead.value = p.massLead;
    u.uMassRear.value = p.massRear;
    u.uCrown.value = p.crown;
    u.uCrownSpacing.value = p.crownSpacing;
    u.uCrownSharp.value = p.crownSharp;
    u.uCrownGate.value = p.crownGate;
    u.uSatellites.value = Math.max(0, Math.min(this.satellites, Math.round(p.satellites)));
    u.uSatMin.value = p.satMin;
    u.uSatMax.value = p.satMax;
    u.uSatAlpha.value = p.satAlpha;
    u.uThrowNear.value = p.throwNear;
    u.uThrowFar.value = p.throwFar;
    u.uThrowCurve.value = p.throwCurve;
    u.uThrowSpread.value = p.throwSpread;
    u.uSatTail.value = p.satTail;
    u.uSatDelay.value = p.satDelay;
    u.uSatJitter.value = p.satJitter;
    u.uSatPop.value = p.satPop;

    u.uOpacity.value = p.opacity;
    u.uFade.value = p.fade;
    u.uCeiling.value = p.ceiling;
    u.uSoftFade.value = p.softFade;
    u.uTint.value = p.tint;
    u.uTintDensity.value = p.tintDensity;
    u.uColorWash.value.copy(_col(p.colorWash));
    u.uColorBody.value.copy(_col(p.colorBody));
    u.uColorDeep.value.copy(_col(p.colorDeep));
    u.uColorPool.value.copy(_col(p.colorPool));
    u.uColorRing.value.copy(_col(p.colorRing));
    u.uColorWet.value.copy(_col(p.colorWet));
    u.uColorGloss.value.copy(_col(p.colorGloss));

    /* --- the canvas ----------------------------------------------------
     * Re-derived every frame from the live params, never captured.
     *
     * `radius` is the whole story for the mass, because the mass is clipped to
     * it in the fragment stage — that clip exists precisely so this number is
     * bounded and a long-lived bloom cannot grow a quad the size of the level.
     * The satellites are not clipped, so a splatter's canvas has to reach past
     * its furthest droplet *and that droplet's tail*: getting this wrong cuts
     * the far field off with a straight edge, which is worse-looking than
     * having no satellites at all.
     */
    let extent = Math.max(p.radius, 0.1);
    if (this.mode === InkMode.SPLATTER) {
      extent = Math.max(extent, p.throwFar + p.satMax * (1 + p.satTail) + p.edge * 2);
    }
    extent += p.edge * 2 + p.clipSoft;
    const size = extent * 2;
    this.mesh.scale.set(size, 1, size);
    u.uQuadSize.value.set(size, size);

    this.mesh.position.set(this._anchor.x, p.height, this._anchor.z);
    this.mesh.rotation.set(0, this._yaw, 0);

    // The field's own axes in world space, so the fragment shader can tip the
    // wet meniscus the right way without knowing about the yaw.
    u.uAxisAlong.value.set(Math.sin(this._yaw), 0, Math.cos(this._yaw));
    u.uAxisAcross.value.set(Math.cos(this._yaw), 0, -Math.sin(this._yaw));

    this.mesh.visible = p.opacity > 0 && p.fade > 0;
  }

  /* --- CPU mirrors -------------------------------------------------- *
   * All of these read the last-synced params and age, so call them after
   * update() on the same frame. They mirror the fragment shader exactly,
   * including its dice, because the dice are uploaded rather than hashed.
   */

  /** The unperturbed front radius of nucleus `i`, in metres. */
  frontRadius(i = 0) {
    const p = this._p;
    const age = Math.max(0, this._age - p.sourceDelay * i);
    return p.spread * Math.pow(age, Math.max(p.spreadPower, 0.05));
  }

  /** World position of nucleus `i`. Nucleus 0 is the anchor. */
  sourcePoint(i, out) {
    const p = this._p;
    out.copy(this._anchor);
    if (i <= 0) return out;
    const dice = this.material.uniforms.uSourceDice.value[Math.min(i, this.sources - 1)];
    const x = dice.x * p.sourceScatter * p.radius;
    const z = dice.y * p.sourceScatter * p.radius;
    return this._toWorld(x, z, out);
  }

  /** Radius of satellite `i`, in metres. The same Pareto draw as the shader. */
  satelliteSize(i) {
    const p = this._p;
    const dice = this.material.uniforms.uSatDice.value[Math.min(Math.max(i, 0), this.satellites - 1)];
    const a = Math.max(p.satAlpha, 1.05);
    const lo = Math.max(p.satMin, 1e-3);
    const hi = Math.max(p.satMax, lo * 1.001);
    const loA = Math.pow(lo, -a);
    const hiA = Math.pow(hi, -a);
    return Math.pow(dice.x * (hiA - loA) + loA, -1 / a);
  }

  /** How far down the travel vector satellite `i` was thrown, in metres. */
  satelliteReach(i) {
    const p = this._p;
    const dice = this.material.uniforms.uSatDice.value[Math.min(Math.max(i, 0), this.satellites - 1)];
    const t = Math.pow(1 - dice.x, Math.max(p.throwCurve, 0.05));
    return p.throwNear + (p.throwFar - p.throwNear) * t;
  }

  /**
   * World position of satellite `i`'s bead.
   *
   * This is the hook `splatterbrand` hangs its `Projectile`s on: fire one at
   * `satellitePoint(i, v)` and it lands in the droplet, not near it.
   */
  satellitePoint(i, out) {
    const p = this._p;
    const dice = this.material.uniforms.uSatDice.value[Math.min(Math.max(i, 0), this.satellites - 1)];
    const reach = this.satelliteReach(i);
    const across = (dice.y - 0.5) * 2 * p.throwSpread * reach;
    out.copy(this._anchor);
    out.y = p.height;
    return this._toWorld(across, reach, out);
  }

  /** Seconds since satellite `i` landed. Negative means it has not yet. */
  satelliteAge(i) {
    const p = this._p;
    const dice = this.material.uniforms.uSatDice.value[Math.min(Math.max(i, 0), this.satellites - 1)];
    return (
      this._age - p.satDelay * (this.satelliteReach(i) / Math.max(p.throwFar, 1e-3)) - dice.z * p.satJitter
    );
  }

  /** Local (across, along) metres into a world point, at the field's height. */
  _toWorld(across, along, out) {
    const s = Math.sin(this._yaw);
    const c = Math.cos(this._yaw);
    out.x = this._anchor.x + across * c + along * s;
    out.z = this._anchor.z - across * s + along * c;
    out.y = this._p.height;
    return out;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.material.dispose();
    releaseGroundQuad();
  }
}

/* ---------------------------------------------------------------------- */
/* Params                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * Every key `update()` understands, with its default and its unit.
 *
 * The instability block is the one worth reading twice. `coarse` is the
 * wavelength of the **largest** lobe the bloom can ever grow; `onset` is how
 * many of a mode's own wavelengths of front radius have to pass before that
 * mode is admitted, so it is what staggers the scales; `growth` is how fast an
 * admitted mode then grows and `growthMax` is where it stops. Those four are
 * the dispersion relation, and between them they are the difference between a
 * bloom, a puddle and a bath sponge.
 *
 * Read `onset` with `coarse`: at 0.55 the coarsest lobe needs a front of
 * `0.55 * coarse` metres before it appears at all, which on the defaults is
 * 1.3 m — so a small cast never grows its biggest feature, and a large one
 * grows into it. That is the behaviour that makes two casts of different sizes
 * look like different events rather than one event at two zoom levels.
 */
export function inkDiffusionParams() {
  return {
    /* --- placement --- */
    radius: 6, // metres, the authored extent of the field
    height: 0.02, // metres above the floor

    /* --- the spread --- */
    spread: 2.6, // metres of front radius at t = 1 s
    spreadPower: 0.5, // r ~ t^power; 0.5 is Fickian diffusion
    edge: 0.09, // metres, the width of the interface
    clipSoft: 0.8, // metres the mass fades out over as it reaches `radius`
    sources: 1, // live nuclei, clamped to the constructed count
    sourceScatter: 0.35, // fraction of the radius the extra nuclei scatter over
    sourceDelay: 0.18, // seconds each later nucleus starts behind the first

    /* --- the instability --- */
    finger: 0.5, // overall amplitude; 0 gives a disc
    fingerMax: 0.75, // cap, as a fraction of the front radius
    coarse: 2.4, // metres, the coarsest lobe — the one knob that sets the morphology
    onset: 0.55, // front radii per wavelength before that mode is admitted
    growth: 0.9, // e-folds per wavelength of front travel
    growthMax: 1.5, // saturation — a finger stops growing at its own width

    /* --- the film --- */
    core: 0.5, // density floor inside the blob
    falloff: 5.5, // metres of e-folding out from a nucleus
    film: 0.6, // alpha floor inside the coverage
    granulation: 0.22, // pigment settling into the paper's tooth
    granScale: 1.6, // features per metre
    ring: 0.55, // strength of the deposition line at the interface
    ringWidth: 0.12, // metres

    /* --- wet and dry --- */
    dryTime: 1.6, // seconds for the gloss to fall to 1/e
    wetDarken: 0.35, // how far the wet film pulls toward colorWet
    gloss: 0.22, // specular strength on the wet film — under the ceiling
    glossPower: 44, // its tightness
    meniscus: 0.55, // how far the film's normal tips at the interface

    /* --- SPLATTER: the mass --- */
    massAlong: 1.35, // metric stretch down the travel vector
    massAcross: 0.8, // and across it
    massLead: 0.22, // fraction of the front the mass sits forward by
    massRear: 1.45, // >1 blunts the trailing edge
    crown: 0.35, // fraction of the front the teeth add
    crownSpacing: 0.55, // metres of rim per tooth
    crownSharp: 7, // tooth narrowness
    crownGate: 2.2, // how tightly the crown is held to the leading arc

    /* --- SPLATTER: the satellites --- */
    satellites: 12, // live droplets, clamped to the constructed count
    satMin: 0.055, // metres, smallest droplet radius
    satMax: 0.42, // metres, largest
    satAlpha: 2.3, // exponent of the size power law — 2..3 is what splashes do
    throwNear: 1.6, // metres, nearest droplet
    throwFar: 9, // metres, furthest — also sizes the quad
    throwCurve: 1.7, // bias of the distance draw
    throwSpread: 0.22, // lateral cone, as a fraction of the distance
    satTail: 2.4, // tail length, in droplet radii
    satDelay: 0.42, // seconds the furthest droplet lands behind the mass
    satJitter: 0.12, // seconds of per-droplet slop on that
    satPop: 0.06, // seconds a droplet takes to appear

    /* --- the mark --- */
    opacity: 1,
    fade: 1, // the ability's own fade, 0..1
    ceiling: 0.62, // max linear luminance; post.bloomThreshold is 0.88
    softFade: 0.25, // metres of depth feather
    tint: 0.05, // where in the gradient a zero-density film sits
    tintDensity: 1.05, // how far density walks it — over 1 so a thick film reaches colorPool

    /* --- seven pickers, none derived from another --- */
    colorWash: '#a89a88', // the thinnest film
    colorBody: '#4c433b',
    colorDeep: '#1a1613',
    colorPool: '#080706',
    colorRing: '#2e2019', // the deposition line at the interface
    colorWet: '#100c09', // what the still-wet film pulls toward
    colorGloss: '#c8ced2' // the specular on it
  };
}

/** Resolved once at module load; `_resolve` walks its keys every frame. */
const DEFAULT_PARAMS = inkDiffusionParams();
