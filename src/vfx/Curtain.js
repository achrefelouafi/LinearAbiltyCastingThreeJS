import {
  AddEquation,
  Color,
  CustomBlending,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  ShaderMaterial,
  Sphere,
  Vector3,
  Vector4
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms, frame } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { copyColor } from '../utils/color.js';

/* ------------------------------------------------------------------------ */
/* Curtain — vertical sheets of light in air                                 */
/* ------------------------------------------------------------------------ */
/**
 * Instanced vertical sheets with a travelling vertex ripple.
 *
 * ## The mismatch is the effect
 *
 * A hanging ribbon and a curtain of aurora are the same geometry. The single
 * thing that separates them is that on a ribbon, **coverage and brightness fall
 * off together** — where the cloth thins out, it both stops hiding what is
 * behind it and stops being bright. Light in air does not do that. A column of
 * excited gas keeps emitting long after it has stopped occluding anything, so
 * the top of a real aurora is *pure radiance over a visible sky*: bright, and
 * transparent, at the same time.
 *
 * So alpha and emission are driven by two independent curves —
 *
 * ```
 *   alpha    = mix(alphaTop,    alphaBase,    pow(1 - h, alphaCurve))
 *   emission = mix(emissionTop, emissionBase, pow(1 - h, emissionCurve))
 * ```
 *
 * — and **they are meant to disagree**. Set `alphaCurve` well above
 * `emissionCurve` and the sheet stops covering things halfway up while still
 * throwing light out of its top; that is the aurora. Set them equal and you get
 * the hanging ribbon back, which is the useful thing to try once so you can see
 * what the mismatch is buying. For a light shaft, put `emissionTop` above
 * `emissionBase` and the shaft is brightest where it enters the canopy.
 *
 * That only works because the output is **premultiplied alpha**
 * (`ONE, ONE_MINUS_SRC_ALPHA`), the same trick `Portal` uses. One pass writes
 * `rgb = body·α + emissive` and `a = α`, so it can be an occluding sheet
 * (rain on glass), pure additive light (aurora), or a *darkening* (the wet
 * floor) with no change but the numbers. `body` — the amount of α the sheet is
 * allowed to have at all — is the `body` slider, and setting it to 0 turns the
 * whole curtain into light with no substance.
 *
 * ## The other thing that matters: the grazing term
 *
 * A sheet has no thickness, so a ray crossing it face-on passes through almost
 * nothing and a ray crossing it edge-on travels the length of a fold. Both alpha
 * and emission are scaled by `1/|N·V|`, clamped. Without it a curtain is a flat
 * decal that looks identical from every angle; with it the folds flare as you
 * orbit and the sheet reads as a volume. It is two lines and it is most of the
 * effect.
 *
 * ## Modes
 *
 * - **RAIN** — hashed streak lanes scrolling down the face, with an antialias
 *   floor so a distant curtain melts into haze rather than into a stipple of
 *   dots. Pairs with the floor companion, which goes wet and reflective and
 *   takes impact rings.
 * - **AURORA** — vertical rays from an fbm sampled along the sheet's *length*
 *   only, a slow three-way hue band, and a distinct hem of a fourth colour along
 *   the bottom edge. Real aurora has that hem (a couple of hundred metres of
 *   nitrogen under the oxygen green), and leaving it out is the reason most
 *   attempts read as a green rag.
 * - **SHAFT** — a tapered translucent volume falling through a canopy: a
 *   gaussian core across the sheet, a fixed noise gate along it so each shaft
 *   has its own silhouette of leaf gaps, and dust motes on a hashed world-space
 *   lattice. Pass `-frame.uLightDir` as the sheet's up axis and the shafts slant
 *   with the stage's own sun.
 *
 * ## Cost
 *
 * **One draw call** for any number of sheets — one `InstancedBufferGeometry`,
 * every sheet placed by the vertex shader. **Two** if the floor companion is on.
 * No textures.
 *
 * ## Invariants
 *
 * - **I1** — the per-sheet attributes are *dice*: four disc/bearing/jitter rolls
 *   and a phase. Every metre — spacing, width, height, lean, ripple amplitude —
 *   is re-resolved from `update()`'s params each frame, so a standing curtain
 *   re-lays itself under a paused slider.
 * - **I3** — `roll()` allocates nothing (it refills existing typed arrays);
 *   `update()` writes into existing uniform boxes.
 * - **I5** — eight pickers on the sheets, three more on the floor, none derived.
 */

/* ---------------------------------------------------------------- */
/* Enums                                                             */
/* ---------------------------------------------------------------- */

export const CurtainMode = Object.freeze({
  /** Streaks running down the face. Wants the floor companion. */
  RAIN: 0,
  /** Banded, multi-hue, slow, with a coloured hem. */
  AURORA: 1,
  /** A tapered translucent shaft with a canopy gate and dust motes. */
  SHAFT: 2
});

export const CurtainLayout = Object.freeze({
  /** A rank of sheets side by side along +X — a wall. */
  LINE: 0,
  /** Sheets standing tangentially around a circle — a ring of aurora. */
  RING: 1,
  /** Hashed placement inside a disc, each at its own bearing — light shafts. */
  SCATTER: 2
});

/** Hard ceiling on the floor companion's per-sheet pool loop. */
const FLOOR_SHEETS = 32;

/* ---------------------------------------------------------------- */
/* Layout — shared by the sheets and by the floor under them         */
/* ---------------------------------------------------------------- */
/**
 * Written once and injected into both shaders. The floor companion has to know
 * exactly where the sheets stand in order to put a puddle or a light pool under
 * each one, and two copies of a layout drift apart the first time someone adds a
 * mode.
 */
const CURTAIN_LAYOUT = /* glsl */ `
  #define TAU 6.283185307179586

  uniform vec3  uAnchor;    // world foot of the curtain
  uniform vec3  uAxisX;     // the layout's +X, unit
  uniform vec3  uAxisY;     // the sheets' up, unit. Tilt it for slanted shafts.
  uniform vec3  uAxisZ;     // the layout's +Z, unit
  uniform int   uLayout;
  uniform float uCount;     // sheets drawn this frame
  uniform float uSpacing;   // metres between sheets (LINE)
  uniform float uRadius;    // metres (RING, SCATTER)
  uniform float uScatter;   // metres of hashed slop off the nominal place
  uniform float uSeed;

  /**
   * Where sheet 'slot' stands and which way it runs. Metres.
   *
   * @param dice (discRadius, discAngle, bearing, jitterAlong) — unitless rolls
   * @param jitterAcross a fifth roll, kept separate so SCATTER can spend four
   */
  void sheetFrame(float slot, vec4 dice, float jitterAcross,
                  out vec3 centre, out vec3 along, out vec3 norm) {
    float n = max(uCount, 1.0);

    if (uLayout == 1) {
      float a = (slot + 0.5) / n * TAU;
      vec3 dir = uAxisX * cos(a) + uAxisZ * sin(a);
      centre = uAnchor + dir * uRadius;
      along = -uAxisX * sin(a) + uAxisZ * cos(a);
      norm = dir;
    } else if (uLayout == 2) {
      // sqrt on the radial die, or every shaft crowds into the middle: the
      // area of an annulus grows with r, so a uniform die must be warped to
      // scatter uniformly over the disc.
      float rr = uRadius * sqrt(clamp(dice.x, 0.0, 1.0));
      float aa = dice.y * TAU;
      centre = uAnchor + (uAxisX * cos(aa) + uAxisZ * sin(aa)) * rr;
      float b = dice.z * TAU;
      along = uAxisX * cos(b) + uAxisZ * sin(b);
      norm = normalize(cross(along, uAxisY) + vec3(1e-5));
    } else {
      centre = uAnchor + uAxisX * ((slot - (n - 1.0) * 0.5) * uSpacing);
      along = uAxisX;
      norm = uAxisZ;
    }

    // A rank of identical sheets on an even pitch reads as a fence at any
    // distance. Two hashed metres of slop is all it takes to stop that, and it
    // is a *die* times a live metre — never a captured offset.
    centre += (along * (dice.w - 0.5) + norm * (jitterAcross - 0.5)) * uScatter * 2.0;
  }
`;

/* ---------------------------------------------------------------- */
/* Sheet vertex                                                      */
/* ---------------------------------------------------------------- */

const CURTAIN_VERTEX = /* glsl */ `
  uniform float uTime;

  /* --- the body of a sheet --- */
  uniform float uWidth;        // metres
  uniform float uWidthJitter;  // ±fraction
  uniform float uHeight;       // metres
  uniform float uHeightJitter; // ±fraction
  uniform float uBase;         // metres the foot sits above the anchor plane
  uniform float uTaper;        // width multiplier at the top. <1 for a shaft.
  uniform float uLean;         // metres the top is pushed along the sheet normal
  uniform float uLeanJitter;   // ±fraction
  uniform float uRise;         // 0..1 how far the curtain has risen
  uniform float uRiseSpread;   // 0..1 stagger of that wave across the sheets

  /* --- the travelling ripple --- */
  uniform float uRippleAmp;        // metres
  uniform float uRippleLength;     // metres along the sheet, crest to crest
  uniform float uRippleSpeed;      // metres/second
  uniform float uRippleCurve;      // exponent on height: 0 rigid, >0 pinned foot
  uniform float uFoldAmp;          // metres — the second, longer fold
  uniform float uFoldLength;       // metres
  uniform float uFoldSpeed;        // metres/second
  uniform float uRippleNoise;      // metres of fbm slop on top
  uniform float uRippleNoiseScale; // cycles per metre
  uniform float uRippleNoiseSpeed; // Hz
  uniform float uPhaseSpread;      // turns of per-sheet phase offset

  attribute vec4  aDiceA;  // (discRadius, discAngle, bearing, jitterAlong)
  attribute vec4  aDiceB;  // (jitterAcross, width, height, lean)
  attribute float aSeed;   // phase / hue / reveal
  /** The instance's slot. Carried explicitly rather than read from
      gl_InstanceID, which does not exist in GLSL ES 1.00 and this project's
      raw materials are all compiled as ES 1.00. */
  attribute float aIndex;

  varying float vH;        // 0 at the foot, 1 at the head
  varying float vS;        // metres along the sheet from its centre
  varying float vHalf;     // metres — this sheet's half-width at this height
  varying float vSeed;
  varying float vGrow;     // 0..1 this sheet's own reveal
  varying vec3  vNormalW;
  varying vec3  vWorld;
  varying float vViewZ;

  ${noiseGLSL}
  ${CURTAIN_LAYOUT}

  /**
   * Lateral displacement of the sheet at 's' metres along it.
   *
   * The ripple travels along the sheet's *length*, not up it — that is what
   * makes a curtain fold rather than flap. A sine plus a longer, slower fold
   * plus a little fbm: the sine alone is a corrugated iron sheet, and the fbm
   * alone is a rag. The height curve pins the foot, because a curtain that
   * swings from the bottom reads as hanging cloth.
   */
  float sheetRipple(float s, float h, float phase) {
    float amp = pow(clamp(h, 0.0, 1.0), max(uRippleCurve, 0.0));
    float k1 = TAU / max(uRippleLength, 0.05);
    float k2 = TAU / max(uFoldLength, 0.05);
    float r = sin(s * k1 - uTime * uRippleSpeed * k1 + phase) * uRippleAmp;
    r += sin(s * k2 - uTime * uFoldSpeed * k2 + phase * 1.7) * uFoldAmp;
    if (uRippleNoise > 0.0) {
      r += fbm3(vec3(s * uRippleNoiseScale, h * 0.6,
                     uTime * uRippleNoiseSpeed + phase * 3.0)) * uRippleNoise;
    }
    return r * amp;
  }

  void main() {
    float slot = aIndex;
    vSeed = aSeed;

    vec3 centre;
    vec3 along;
    vec3 norm;
    sheetFrame(slot, aDiceA, aDiceB.x, centre, along, norm);

    // Staggered reveal. A curtain that appears all at once is a decal; one that
    // walks up the rank is a thing arriving.
    float g = clamp((uRise - aSeed * uRiseSpread) / max(1.0 - uRiseSpread, 1e-3), 0.0, 1.0);
    g = g * g * (3.0 - 2.0 * g);
    vGrow = g;

    float h = uv.y;
    float hh = h * g;
    vH = h;

    float w = uWidth * (1.0 + (aDiceB.y - 0.5) * 2.0 * uWidthJitter);
    w *= mix(1.0, uTaper, hh);
    vHalf = w * 0.5;

    float s = (uv.x - 0.5) * w;
    vS = s;

    float phase = aSeed * uPhaseSpread * TAU;
    float r = sheetRipple(s, hh, phase);

    vec3 pos = centre
             + along * s
             + uAxisY * (uBase + hh * uHeight * (1.0 + (aDiceB.z - 0.5) * 2.0 * uHeightJitter))
             + norm * (r + uLean * hh * (1.0 + (aDiceB.w - 0.5) * 2.0 * uLeanJitter));

    // The mesh normal is meaningless once the sheet has been rebuilt here, and
    // the grazing term is the whole reason the curtain reads as a volume — so
    // difference the ripple for a real one. dP/ds = along + norm·(dr/ds), and
    // the surface normal is that turned a quarter into the sheet.
    const float ds = 0.05;
    float dr = (sheetRipple(s + ds, hh, phase) - r) / ds;
    vNormalW = normalize(norm - along * dr);

    vWorld = pos;
    vec4 mv = viewMatrix * vec4(pos, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/* ---------------------------------------------------------------- */
/* Sheet fragment                                                    */
/* ---------------------------------------------------------------- */

const CURTAIN_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform int   uMode;
  uniform float uGlobalGlow;
  uniform float uShaderIntensity;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  /* --- the two curves. See the header; they are meant to disagree. --- */
  uniform float uAlphaBase;     // coverage at the foot
  uniform float uAlphaTop;      // coverage at the head
  uniform float uAlphaCurve;    // exponent between them
  uniform float uEmissionBase;  // radiance at the foot
  uniform float uEmissionTop;   // radiance at the head
  uniform float uEmissionCurve; // exponent between them

  uniform float uBody;      // 0..1 how much α the sheet is allowed at all
  uniform float uFootFade;  // 0..1 of the height, feathering the bottom edge
  uniform float uHeadFade;  // 0..1 of the height, feathering the top edge
  uniform float uEdgeFade;  // 0..1 across the sheet, feathering the sides
  uniform float uGraze;     // 0..1 how much the 1/|N·V| term is applied
  uniform float uGrazeFloor;// clamp on |N·V| — 0.1 gives a 10× ceiling
  uniform float uSoftFade;  // metres of depth fade against opaque geometry

  /* --- RAIN --- */
  uniform float uStreakDensity;    // lanes per metre across the face
  uniform float uStreakRepeat;     // streaks per sheet height
  uniform float uStreakSpeed;      // sheet heights per second
  uniform float uStreakSpeedJitter;// ±fraction, per lane
  uniform float uStreakWidth;      // 0..1 of a lane
  uniform float uStreakTail;       // 0..1 of a repeat — the trailing smear
  uniform float uStreakDuty;       // 0..1 of lanes that carry a streak
  uniform float uHaze;             // the veil between the streaks

  /* --- AURORA --- */
  uniform float uRayScale;   // cycles per metre of the vertical striations
  uniform float uRaySpeed;   // Hz
  uniform float uRaySharp;
  uniform float uBandScale;  // cycles per metre of the hue banding
  uniform float uBandSpeed;  // Hz
  uniform float uHem;        // 0..1 of the height — the coloured bottom band

  /* --- SHAFT --- */
  uniform float uCoreWidth;   // 0..1 of the half-width — the gaussian core
  uniform float uCanopy;      // 0..1 threshold — how much light gets through
  uniform float uCanopySoft;  // 0..1 of the field
  uniform float uCanopyScale; // cycles per metre along the sheet
  uniform float uMote;        // dust motes
  uniform float uMoteScale;   // motes per metre
  uniform float uMoteSize;
  uniform float uMoteDrift;   // metres/second the motes settle

  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uColorC;
  uniform vec3  uColorHem;
  uniform vec3  uColorCore;
  uniform vec3  uColorMote;
  uniform vec3  uColorBody;   // what the sheet OCCLUDES with, independent of its light
  uniform float uTintSpread;  // 0..1 how far apart neighbouring sheets are tinted
  uniform float uGlow;
  uniform float uOpacity;

  varying float vH;
  varying float vS;
  varying float vHalf;
  varying float vSeed;
  varying float vGrow;
  varying vec3  vNormalW;
  varying vec3  vWorld;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    float h = clamp(vH, 0.0, 1.0);
    float across = clamp(abs(vS) / max(vHalf, 1e-4), 0.0, 1.0);

    /* ---------------- the two curves ---------------- */
    float aFall = mix(uAlphaTop, uAlphaBase, pow(1.0 - h, max(uAlphaCurve, 0.01)));
    float eFall = mix(uEmissionTop, uEmissionBase, pow(1.0 - h, max(uEmissionCurve, 0.01)));

    /* ---------------- the envelope ---------------- */
    float env = smoothstep(0.0, max(uFootFade, 1e-3), h)
              * (1.0 - smoothstep(1.0 - max(uHeadFade, 1e-3), 1.0, h))
              * (1.0 - smoothstep(1.0 - max(uEdgeFade, 1e-3), 1.0, across))
              * vGrow;

    /* ---------------- the grazing term ---------------- */
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vWorld);
    float path = 1.0 / max(abs(dot(N, V)), max(uGrazeFloor, 0.02));
    path = mix(1.0, path, clamp(uGraze, 0.0, 1.0));

    /* ---------------- the mode ---------------- */
    float cov = 0.0;     // what covers  (feeds α)
    float emit = 0.0;    // what shines  (feeds the emissive)
    vec3  tint = uColorA;

    if (uMode == 0) {
      /* ---- RAIN ---- */
      float lane = vS * max(uStreakDensity, 0.1);
      float id = floor(lane);
      float r1 = hash11(id * 1.37 + vSeed * 91.0);
      float r2 = hash11(id * 4.11 + vSeed * 17.0);
      float spd = mix(1.0 - uStreakSpeedJitter, 1.0 + uStreakSpeedJitter, r2);

      // The pattern scrolls toward the foot, so the bright q ≈ 0 end is the
      // head of the drop and the exponential trails up behind it.
      float q = fract(h * max(uStreakRepeat, 0.1) + uTime * uStreakSpeed * spd + r1);
      float head = exp(-q / max(uStreakTail, 1e-3));

      // Antialias floor, straight out of the archived wind material: widen the
      // lane to at least a pixel, then fade what is left into the lane's own
      // average once the pitch stops resolving. Without the second half a
      // distant curtain is a stipple of beating dots rather than a haze.
      float d = abs(fract(lane) - 0.5) * 2.0;
      float aa = fwidth(lane);
      float w0 = max(uStreakWidth, 0.02);
      float w = max(w0, aa * 2.0);
      float core = 1.0 - smoothstep(0.0, w, d);
      float resolve = 1.0 - smoothstep(w0 * 0.35, w0 * 1.5, aa);
      core = mix(clamp(w, 0.0, 1.0) * 0.5, core, resolve);

      float lit = step(1.0 - clamp(uStreakDuty, 0.0, 1.0), hash11(id * 7.71 + vSeed * 5.0));
      lit = mix(clamp(uStreakDuty, 0.0, 1.0), lit, resolve);

      float streak = core * head * lit;
      cov = streak + uHaze * 0.35;
      emit = streak * 0.6 + uHaze * 0.1;
      tint = mix(uColorA, uColorB, clamp(head, 0.0, 1.0));
    } else if (uMode == 1) {
      /* ---- AURORA ---- */
      // Rays sampled on the sheet's length ALONE. Feed the height in as well —
      // the obvious thing — and the striations break into blotches, because a
      // ray is by definition a field that does not vary along a field line.
      float ray = fbm3(vec3(vS * uRayScale, uTime * uRaySpeed + vSeed * 13.0, 0.0));
      ray = smoothstep(-0.15, max(uRaySharp, 0.05), ray);
      float fine = fbm3(vec3(vS * uRayScale * 3.7, uTime * uRaySpeed * 1.6 + vSeed * 3.0, 9.0));
      ray *= 0.6 + 0.6 * (fine * 0.5 + 0.5);

      float band = fbm3(vec3(vS * uBandScale, uTime * uBandSpeed + vSeed * 7.0, 5.0)) * 0.5 + 0.5;
      band = clamp(band + (vSeed - 0.5) * uTintSpread, 0.0, 1.0);
      tint = band < 0.5 ? mix(uColorA, uColorB, band * 2.0)
                        : mix(uColorB, uColorC, (band - 0.5) * 2.0);

      // The hem. Real aurora carries a band of a different gas along its bottom
      // edge; without it the curtain is a green rag with a straight cut.
      float hem = 1.0 - smoothstep(0.0, max(uHem, 1e-3), h);
      tint = mix(tint, uColorHem, hem);

      cov = ray * 0.5;
      emit = ray + hem * 0.35;
    } else {
      /* ---- SHAFT ---- */
      // A gaussian across the sheet, not a smoothstep: a shaft has no edge, it
      // has a falloff, and a smoothstep draws the plane it is standing in.
      float core = exp(-(across * across) / max(uCoreWidth * uCoreWidth, 1e-4));

      // The canopy. A fixed field along the sheet, seeded per shaft, so each one
      // has its own silhouette of leaf gaps and they do not all flicker together.
      float leaf = fbm3(vec3(vS * uCanopyScale, vSeed * 23.0, 0.0)) * 0.5 + 0.5;
      float gate = smoothstep(uCanopy, uCanopy + max(uCanopySoft, 1e-3), leaf);

      float motes = 0.0;
      if (uMote > 0.0) {
        vec3 mp = vWorld * max(uMoteScale, 0.05) + vec3(0.0, uTime * uMoteDrift, 0.0);
        vec3 cell = floor(mp);
        vec3 fr = fract(mp) - 0.5;
        float hh = hash13(cell);
        vec3 off = (hash31(hh * 37.1) - 0.5) * 0.6;
        float dd = length(fr - off);
        motes = smoothstep(0.62, 0.97, hh) * exp(-dd / max(uMoteSize, 1e-3)) * uMote;
      }

      tint = mix(uColorCore, uColorA, clamp(across, 0.0, 1.0));
      cov = core * gate * 0.4;
      emit = core * gate + motes;
      tint = mix(tint, uColorMote, clamp(motes, 0.0, 1.0));
    }

    /* ---------------- composite, premultiplied ---------------- */
    float alpha = clamp(cov * aFall * env * path * uBody * uOpacity, 0.0, 1.0);
    vec3 emissive = tint * (emit * eFall * env * path * uGlow * uOpacity)
                  * uGlobalGlow * mix(0.7, 1.0, uShaderIntensity);

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    float soft = softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, max(uSoftFade, 1e-3));
    alpha *= soft;
    emissive *= soft;

    if (alpha < 0.002 && max(emissive.r, max(emissive.g, emissive.b)) < 0.002) discard;

    gl_FragColor = vec4(uColorBody * alpha + emissive, alpha);
  }
`;

/* ---------------------------------------------------------------- */
/* Floor companion                                                   */
/* ---------------------------------------------------------------- */

const FLOOR_VERTEX = /* glsl */ `
  uniform float uFloorSize;   // metres, the quad's full extent

  varying vec2  vLocal;       // metres from the anchor, in the floor plane
  varying vec3  vWorld;
  varying float vViewZ;

  ${CURTAIN_LAYOUT}

  void main() {
    vec2 ext = (uv - 0.5) * uFloorSize;
    vLocal = ext;
    // Lifted a hair off the ground so it never z-fights the stage floor.
    vec3 world = uAnchor + uAxisX * ext.x + uAxisZ * ext.y + uAxisY * 0.012;
    vWorld = world;
    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * What the ground under a curtain does.
 *
 * Three terms, all of them premultiplied so one pass can darken *and* add:
 *
 *  - **sheen** — a Schlick fresnel over `frame.uEnvMap` on a normal perturbed by
 *    a slow fbm. This is what "wet" is. Dry stone is diffuse and returns the
 *    same colour from every angle; wet stone is a mirror with a very short
 *    memory, and it is the *grazing* reflection that says so, which is why the
 *    fresnel matters more here than the reflection does.
 *  - **pools** — a falloff around each sheet's footprint, evaluated by walking
 *    the same `sheetFrame()` the sheets themselves use. For RAIN that is the
 *    wet patch; for SHAFT it is the disc of light the shaft lands in, which is
 *    the whole reason a shaft reads as reaching the ground.
 *  - **rings** — expanding impact rings on a hashed lattice, each cell holding
 *    its own phase, so a downpour is a hundred rings at a hundred ages rather
 *    than one animation played everywhere.
 */
const FLOOR_FRAGMENT = /* glsl */ `
  uniform float     uTime;
  uniform sampler2D uEnvMap;
  uniform vec3      uLightDir;
  uniform float     uGlobalGlow;
  uniform float     uShaderIntensity;
  uniform vec2      uResolution;
  uniform sampler2D uSceneDepth;
  uniform float     uCameraNear;
  uniform float     uCameraFar;

  uniform float uFloorSize;
  uniform float uFloorFade;     // 0..1 of the half-extent where the quad dies
  uniform float uWet;           // 0..1 how wet the stone is
  uniform float uWetDark;       // 0..1 how much wet stone darkens
  uniform float uSheen;         // env reflection gain
  uniform float uSheenRough;    // cycles per metre of the surface ripple
  uniform float uSheenSpeed;    // Hz
  uniform float uFresnel;

  uniform float uPool;          // 0..1 master on the per-sheet footprints
  uniform float uPoolWidth;     // metres either side of a sheet
  uniform float uPoolLength;    // 0..1 of the sheet's own half-width
  uniform float uPoolSoft;      // metres of feather

  uniform float uRings;         // 0..1 master
  uniform float uRingScale;     // cells per metre
  uniform float uRingPeriod;    // seconds per ring
  uniform float uRingRadius;    // metres a ring reaches
  uniform float uRingWidth;     // metres

  uniform vec3  uColorWet;
  uniform vec3  uColorPool;
  uniform vec3  uColorRing;
  uniform float uFloorOpacity;

  /* --- the sheets' dice, mirrored so the pools land under them --- */
  uniform vec4  uSheetDice[${FLOOR_SHEETS}];   // (discR, discA, bearing, jitterAlong)
  uniform float uSheetJitter[${FLOOR_SHEETS}]; // the fifth roll, jitterAcross
  uniform float uSheetHalf;     // metres — half of the sheets' nominal width

  varying vec2  vLocal;
  varying vec3  vWorld;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}
  ${CURTAIN_LAYOUT}

  // equirectUv comes from commonGLSL above. (No backticks in here: the file is
  // one template literal and a stray one ends it mid-shader.)

  void main() {
    /* ---------------- the sheen ---------------- */
    float sc = max(uSheenRough, 0.02);
    float e = 0.4 / sc;
    float t = uTime * uSheenSpeed;
    float n0 = fbm3(vec3(vLocal * sc, t));
    float nx = fbm3(vec3((vLocal + vec2(e, 0.0)) * sc, t));
    float nz = fbm3(vec3((vLocal + vec2(0.0, e)) * sc, t));
    vec3 nLocal = normalize(vec3(-(nx - n0) / e, 1.0, -(nz - n0) / e) * vec3(uWet, 1.0, uWet));
    vec3 N = normalize(uAxisX * nLocal.x + uAxisY * nLocal.y + uAxisZ * nLocal.z);

    vec3 V = normalize(cameraPosition - vWorld);
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float fres = clamp((0.02 + 0.98 * pow(1.0 - ndv, 5.0)) * uFresnel, 0.0, 1.0);

    vec3 refl = reflect(-V, N);
    vec3 env = texture2D(uEnvMap, equirectUv(refl)).rgb;
    float glint = pow(max(dot(refl, normalize(uLightDir)), 0.0), 90.0);

    /* ---------------- the pools ---------------- */
    float pool = 0.0;
    if (uPool > 0.001) {
      for (int i = 0; i < ${FLOOR_SHEETS}; i++) {
        if (float(i) >= uCount) break;
        vec3 centre;
        vec3 along;
        vec3 norm;
        sheetFrame(float(i), uSheetDice[i], uSheetJitter[i], centre, along, norm);

        // Distance to the sheet's footprint, treated as a segment: the puddle
        // under a two-metre sheet is a two-metre puddle, not a circle.
        vec3 rel = vWorld - centre;
        float a = dot(rel, along);
        float half_ = uSheetHalf * clamp(uPoolLength, 0.0, 2.0);
        a -= clamp(a, -half_, half_);
        float b = dot(rel, norm);
        float d = length(vec2(a, b));
        pool = max(pool, 1.0 - smoothstep(max(uPoolWidth - uPoolSoft, 0.0), uPoolWidth, d));
      }
      pool *= clamp(uPool, 0.0, 1.0);
    }

    /* ---------------- the rings ---------------- */
    float ring = 0.0;
    if (uRings > 0.001) {
      vec2 g = vLocal * max(uRingScale, 0.05);
      vec2 id = floor(g);
      vec2 fr = fract(g) - 0.5;
      float cellSize = 1.0 / max(uRingScale, 0.05);
      float hcell = hash13(vec3(id, 3.7));
      vec2 off = (hash21(hcell * 71.3) - 0.5) * 0.7;
      float d = length(fr - off) * cellSize;
      float age = fract(uTime / max(uRingPeriod, 0.05) + hcell);
      float r = age * uRingRadius;
      ring = exp(-abs(d - r) / max(uRingWidth, 1e-3)) * (1.0 - age) * uRings;
    }

    /* ---------------- composite ---------------- */
    float edge = 1.0 - smoothstep(1.0 - max(uFloorFade, 1e-3), 1.0,
                                  length(vLocal) / max(uFloorSize * 0.5, 1e-3));

    // Wetness *darkens*, which premultiplied alpha can express and additive
    // cannot: a low-luminance rgb with a real α subtracts from what is behind.
    float wet = clamp(uWet * (0.35 + 0.65 * pool), 0.0, 1.0) * edge;
    float alpha = clamp(wet * uWetDark, 0.0, 1.0) * uFloorOpacity;

    vec3 emissive = (env * uSheen + uColorWet * glint * uSheen) * fres * wet;
    emissive += uColorPool * pool * edge * uFloorOpacity;
    emissive += uColorRing * ring * edge * uFloorOpacity;
    emissive *= uGlobalGlow * mix(0.7, 1.0, uShaderIntensity);

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    float soft = softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, 0.25);
    alpha *= soft;
    emissive *= soft;

    if (alpha < 0.002 && max(emissive.r, max(emissive.g, emissive.b)) < 0.002) discard;

    gl_FragColor = vec4(uColorWet * alpha + emissive, alpha);
  }
`;

/* ---------------------------------------------------------------- */
/* Defaults                                                          */
/* ---------------------------------------------------------------- */

/**
 * A curtain that is visible on the first frame, not an art direction. Every one
 * of these is meant to become a slider in the ability's own settings block.
 */
const DEFAULTS = {
  /* --- the layout --- */
  count: 7, //          sheets drawn
  spacing: 1.4, //      metres between sheets (LINE)
  radius: 5, //         metres (RING, SCATTER)
  scatter: 0.35, //     metres of hashed slop off the nominal place
  seed: 0,

  /* --- the body of a sheet --- */
  width: 4, //          metres
  widthJitter: 0.25, // ±fraction
  height: 5, //         metres
  heightJitter: 0.2, // ±fraction
  base: 0, //           metres the foot sits above the anchor plane
  taper: 1, //          width multiplier at the head. <1 for a shaft.
  lean: 0.6, //         metres the head is pushed along the sheet normal
  leanJitter: 0.5, //   ±fraction
  rise: 1, //           0..1 how far the curtain has risen
  riseSpread: 0.45, //  0..1 stagger of that wave across the sheets

  /* --- the travelling ripple --- */
  rippleAmp: 0.5, //        metres
  rippleLength: 3.2, //     metres along the sheet, crest to crest
  rippleSpeed: 1.1, //      metres/second
  rippleCurve: 1.2, //      exponent on height: 0 rigid, >0 pins the foot
  foldAmp: 0.9, //          metres — the second, longer fold
  foldLength: 9, //         metres
  foldSpeed: 0.45, //       metres/second
  rippleNoise: 0.18, //     metres of fbm slop
  rippleNoiseScale: 0.35, //cycles per metre
  rippleNoiseSpeed: 0.15, //Hz
  phaseSpread: 1, //        turns of per-sheet phase offset

  /* --- the two curves --- */
  alphaBase: 1, //      coverage at the foot
  alphaTop: 0, //       coverage at the head
  alphaCurve: 2.4, //   exponent between them
  emissionBase: 1, //   radiance at the foot
  emissionTop: 0.35, // radiance at the head
  emissionCurve: 0.7, //exponent between them — DELIBERATELY not alphaCurve

  body: 0.25, //        0..1 how much α the sheet is allowed at all
  footFade: 0.03, //    0..1 of the height
  headFade: 0.25, //    0..1 of the height
  edgeFade: 0.3, //     0..1 across the sheet
  graze: 1, //          0..1 how much the 1/|N·V| path term is applied
  grazeFloor: 0.12, //  clamp on |N·V| — 0.12 gives a ~8× ceiling
  softFade: 0.5, //     metres of depth fade against opaque geometry
  opacity: 1,
  glow: 1.2,
  tintSpread: 0.4, //   0..1 how far apart neighbouring sheets are tinted

  /* --- RAIN --- */
  streakDensity: 9, //      lanes per metre across the face
  streakRepeat: 2.4, //     streaks per sheet height
  streakSpeed: 1.6, //      sheet heights per second
  streakSpeedJitter: 0.35, //±fraction, per lane
  streakWidth: 0.14, //     0..1 of a lane
  streakTail: 0.09, //      0..1 of a repeat — the trailing smear
  streakDuty: 0.55, //      0..1 of lanes that carry a streak
  haze: 0.35, //            the veil between the streaks

  /* --- AURORA --- */
  rayScale: 0.9, //   cycles per metre of the vertical striations
  raySpeed: 0.07, //  Hz
  raySharp: 0.45,
  bandScale: 0.12, // cycles per metre of the hue banding
  bandSpeed: 0.04, // Hz
  hem: 0.12, //       0..1 of the height — the coloured bottom band

  /* --- SHAFT --- */
  coreWidth: 0.45, // 0..1 of the half-width
  canopy: 0.4, //     0..1 threshold — how much light gets through
  canopySoft: 0.25, //0..1 of the field
  canopyScale: 0.6, //cycles per metre along the sheet
  mote: 0.7,
  moteScale: 2.2, //  motes per metre
  moteSize: 0.06,
  moteDrift: 0.06, // metres/second the motes settle

  colorA: '#5fffc0',
  colorB: '#3a9aff',
  colorC: '#c05fff',
  colorHem: '#ff5f9a',
  colorCore: '#e8f0c0',
  colorMote: '#ffffff',
  colorBody: '#101c2a',

  /* --- the floor companion --- */
  floorSize: 18, //     metres, the quad's full extent
  floorFade: 0.35, //   0..1 of the half-extent where it dies
  wet: 0.7, //          0..1 how wet the stone is
  wetDark: 0.55, //     0..1 how much wet stone darkens
  sheen: 0.8, //        env reflection gain
  sheenRough: 1.1, //   cycles per metre of the surface ripple
  sheenSpeed: 0.5, //   Hz
  floorFresnel: 1.4,
  pool: 1, //           0..1 master on the per-sheet footprints
  poolWidth: 1.6, //    metres either side of a sheet
  poolLength: 1, //     0..1 of the sheet's own half-width
  poolSoft: 1.1, //     metres of feather
  rings: 0.8, //        0..1 master
  ringScale: 0.55, //   cells per metre
  ringPeriod: 0.9, //   seconds per ring
  ringRadius: 0.5, //   metres a ring reaches
  ringWidth: 0.035, //  metres
  floorOpacity: 1,
  colorWet: '#101c2a',
  colorPool: '#2a4258',
  colorRing: '#c8dcea'
};

/** Every canonical key with its default. Copy it into a settings block. */
export function curtainParams() {
  return { ...DEFAULTS };
}

const num = (v, d) => (v === undefined || v === null ? d : v);

/* ---------------------------------------------------------------- */
/* Scratch — module scope (I3)                                       */
/* ---------------------------------------------------------------- */

const _ax = new Vector3();
const _ay = new Vector3();
const _az = new Vector3();
const _centre = new Vector3();
const _along = new Vector3();
const _norm = new Vector3();

/* ---------------------------------------------------------------- */
/* Curtain                                                           */
/* ---------------------------------------------------------------- */

/**
 * ```js
 * const _o = curtainParams();                     // module scope — I3
 * const _p = new Vector3();
 *
 * this.veil = new Curtain({ mode: CurtainMode.AURORA, layout: CurtainLayout.RING });
 * this.group.add(this.veil.object3D);
 * // …
 * onSpawn()    { this.veil.roll(); }
 * onTravel(dt) {
 *   const c = settings.aurora;
 *   this.veil.setPlacement(this.target, this.direction, UP);
 *   _o.count  = c.sheets;
 *   _o.radius = c.zoneRadius;                     // metres, resolved THIS frame
 *   _o.height = c.veilHeight;
 *   _o.rise   = this.u;
 *   this.veil.update(this.age, _o);
 * }
 * ```
 */
export class Curtain {
  /**
   * @param {object}  options
   * @param {number}  [options.capacity]  hard ceiling on sheets
   * @param {number}  [options.segmentsX] quads across a sheet. The ripple lives
   *                                      here, so this is the one that matters.
   * @param {number}  [options.segmentsY] quads up a sheet
   * @param {number}  [options.mode]      CurtainMode.*
   * @param {number}  [options.layout]    CurtainLayout.*
   * @param {boolean} [options.floor]     build the wet/lit ground companion
   * @param {number}  [options.renderOrder]
   * @param {string}  [options.name]
   */
  constructor({
    capacity = 16,
    segmentsX = 32,
    segmentsY = 16,
    mode = CurtainMode.AURORA,
    layout = CurtainLayout.LINE,
    floor = false,
    renderOrder = 8,
    name = 'Curtain'
  } = {}) {
    this.capacity = Math.max(1, Math.round(capacity));

    this.group = new Group();
    this.group.name = name;
    this.group.matrixAutoUpdate = false;

    /* --- the sheet mesh -------------------------------------------- */

    // A unit plane, borrowed for its uv grid and its index buffer only: every
    // metre comes from a uniform in the vertex shader, so resizing a curtain
    // never touches a buffer.
    const plane = new PlaneGeometry(1, 1, Math.max(1, segmentsX | 0), Math.max(1, segmentsY | 0));

    this._diceA = new Float32Array(this.capacity * 4);
    this._diceB = new Float32Array(this.capacity * 4);
    this._seeds = new Float32Array(this.capacity);
    const slots = new Float32Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) slots[i] = i;

    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', plane.getAttribute('position'));
    geometry.setAttribute('uv', plane.getAttribute('uv'));
    geometry.setIndex(plane.getIndex());
    geometry.setAttribute('aDiceA', new InstancedBufferAttribute(this._diceA, 4));
    geometry.setAttribute('aDiceB', new InstancedBufferAttribute(this._diceB, 4));
    geometry.setAttribute('aSeed', new InstancedBufferAttribute(this._seeds, 1));
    geometry.setAttribute('aIndex', new InstancedBufferAttribute(slots, 1));
    geometry.instanceCount = 0;
    // Placed in world space by the vertex shader; its own bounds mean nothing.
    geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    this.geometry = geometry;

    const layoutUniforms = {
      uAnchor: { value: new Vector3() },
      uAxisX: { value: new Vector3(1, 0, 0) },
      uAxisY: { value: new Vector3(0, 1, 0) },
      uAxisZ: { value: new Vector3(0, 0, 1) },
      uLayout: { value: layout },
      uCount: { value: DEFAULTS.count },
      uSpacing: { value: DEFAULTS.spacing },
      uRadius: { value: DEFAULTS.radius },
      uScatter: { value: DEFAULTS.scatter },
      uSeed: { value: DEFAULTS.seed }
    };
    // Shared *by identity* with the floor companion, so the pools cannot drift
    // out from under the sheets: one write moves both.
    this._layoutUniforms = layoutUniforms;

    this.material = new ShaderMaterial({
      name: `${name}:sheets`,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
      toneMapped: false,
      // Premultiplied alpha — see the class header. One pass, three behaviours.
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendEquationAlpha: AddEquation,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
      uniforms: sharedUniforms({
        ...layoutUniforms,
        uMode: { value: mode },

        uWidth: { value: DEFAULTS.width },
        uWidthJitter: { value: DEFAULTS.widthJitter },
        uHeight: { value: DEFAULTS.height },
        uHeightJitter: { value: DEFAULTS.heightJitter },
        uBase: { value: DEFAULTS.base },
        uTaper: { value: DEFAULTS.taper },
        uLean: { value: DEFAULTS.lean },
        uLeanJitter: { value: DEFAULTS.leanJitter },
        uRise: { value: DEFAULTS.rise },
        uRiseSpread: { value: DEFAULTS.riseSpread },

        uRippleAmp: { value: DEFAULTS.rippleAmp },
        uRippleLength: { value: DEFAULTS.rippleLength },
        uRippleSpeed: { value: DEFAULTS.rippleSpeed },
        uRippleCurve: { value: DEFAULTS.rippleCurve },
        uFoldAmp: { value: DEFAULTS.foldAmp },
        uFoldLength: { value: DEFAULTS.foldLength },
        uFoldSpeed: { value: DEFAULTS.foldSpeed },
        uRippleNoise: { value: DEFAULTS.rippleNoise },
        uRippleNoiseScale: { value: DEFAULTS.rippleNoiseScale },
        uRippleNoiseSpeed: { value: DEFAULTS.rippleNoiseSpeed },
        uPhaseSpread: { value: DEFAULTS.phaseSpread },

        uAlphaBase: { value: DEFAULTS.alphaBase },
        uAlphaTop: { value: DEFAULTS.alphaTop },
        uAlphaCurve: { value: DEFAULTS.alphaCurve },
        uEmissionBase: { value: DEFAULTS.emissionBase },
        uEmissionTop: { value: DEFAULTS.emissionTop },
        uEmissionCurve: { value: DEFAULTS.emissionCurve },

        uBody: { value: DEFAULTS.body },
        uFootFade: { value: DEFAULTS.footFade },
        uHeadFade: { value: DEFAULTS.headFade },
        uEdgeFade: { value: DEFAULTS.edgeFade },
        uGraze: { value: DEFAULTS.graze },
        uGrazeFloor: { value: DEFAULTS.grazeFloor },
        uSoftFade: { value: DEFAULTS.softFade },

        uStreakDensity: { value: DEFAULTS.streakDensity },
        uStreakRepeat: { value: DEFAULTS.streakRepeat },
        uStreakSpeed: { value: DEFAULTS.streakSpeed },
        uStreakSpeedJitter: { value: DEFAULTS.streakSpeedJitter },
        uStreakWidth: { value: DEFAULTS.streakWidth },
        uStreakTail: { value: DEFAULTS.streakTail },
        uStreakDuty: { value: DEFAULTS.streakDuty },
        uHaze: { value: DEFAULTS.haze },

        uRayScale: { value: DEFAULTS.rayScale },
        uRaySpeed: { value: DEFAULTS.raySpeed },
        uRaySharp: { value: DEFAULTS.raySharp },
        uBandScale: { value: DEFAULTS.bandScale },
        uBandSpeed: { value: DEFAULTS.bandSpeed },
        uHem: { value: DEFAULTS.hem },

        uCoreWidth: { value: DEFAULTS.coreWidth },
        uCanopy: { value: DEFAULTS.canopy },
        uCanopySoft: { value: DEFAULTS.canopySoft },
        uCanopyScale: { value: DEFAULTS.canopyScale },
        uMote: { value: DEFAULTS.mote },
        uMoteScale: { value: DEFAULTS.moteScale },
        uMoteSize: { value: DEFAULTS.moteSize },
        uMoteDrift: { value: DEFAULTS.moteDrift },

        uColorA: { value: new Color(DEFAULTS.colorA) },
        uColorB: { value: new Color(DEFAULTS.colorB) },
        uColorC: { value: new Color(DEFAULTS.colorC) },
        uColorHem: { value: new Color(DEFAULTS.colorHem) },
        uColorCore: { value: new Color(DEFAULTS.colorCore) },
        uColorMote: { value: new Color(DEFAULTS.colorMote) },
        uColorBody: { value: new Color(DEFAULTS.colorBody) },
        uTintSpread: { value: DEFAULTS.tintSpread },
        uGlow: { value: DEFAULTS.glow },
        uOpacity: { value: DEFAULTS.opacity }
      }),
      vertexShader: CURTAIN_VERTEX,
      fragmentShader: CURTAIN_FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = `${name}:sheets`;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.renderOrder = renderOrder;
    this.group.add(this.mesh);

    /* --- the floor companion --------------------------------------- */

    this.floorMesh = null;
    this.floorMaterial = null;
    this._sheetDice = null;
    this._sheetJitter = null;
    if (floor) this._buildFloor(name, renderOrder, layoutUniforms);

    this.roll();
  }

  _buildFloor(name, renderOrder, layoutUniforms) {
    // The dice the sheets carry as attributes, mirrored into uniform arrays so
    // the floor can walk the same `sheetFrame()`. Allocated once here, mutated
    // in `roll()`, never reallocated.
    this._sheetDice = [];
    for (let i = 0; i < FLOOR_SHEETS; i++) this._sheetDice.push(new Vector4(0, 0, 0, 0));
    this._sheetJitter = new Float32Array(FLOOR_SHEETS);

    this.floorMaterial = new ShaderMaterial({
      name: `${name}:floor`,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
      toneMapped: false,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendEquationAlpha: AddEquation,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
      uniforms: sharedUniforms({
        ...layoutUniforms,
        uEnvMap: frame.uEnvMap,
        uFloorSize: { value: DEFAULTS.floorSize },
        uFloorFade: { value: DEFAULTS.floorFade },
        uWet: { value: DEFAULTS.wet },
        uWetDark: { value: DEFAULTS.wetDark },
        uSheen: { value: DEFAULTS.sheen },
        uSheenRough: { value: DEFAULTS.sheenRough },
        uSheenSpeed: { value: DEFAULTS.sheenSpeed },
        uFresnel: { value: DEFAULTS.floorFresnel },
        uPool: { value: DEFAULTS.pool },
        uPoolWidth: { value: DEFAULTS.poolWidth },
        uPoolLength: { value: DEFAULTS.poolLength },
        uPoolSoft: { value: DEFAULTS.poolSoft },
        uRings: { value: DEFAULTS.rings },
        uRingScale: { value: DEFAULTS.ringScale },
        uRingPeriod: { value: DEFAULTS.ringPeriod },
        uRingRadius: { value: DEFAULTS.ringRadius },
        uRingWidth: { value: DEFAULTS.ringWidth },
        uColorWet: { value: new Color(DEFAULTS.colorWet) },
        uColorPool: { value: new Color(DEFAULTS.colorPool) },
        uColorRing: { value: new Color(DEFAULTS.colorRing) },
        uFloorOpacity: { value: DEFAULTS.floorOpacity },
        uSheetDice: { value: this._sheetDice },
        uSheetJitter: { value: this._sheetJitter },
        uSheetHalf: { value: DEFAULTS.width * 0.5 }
      }),
      vertexShader: FLOOR_VERTEX,
      fragmentShader: FLOOR_FRAGMENT
    });

    this.floorMesh = new Mesh(new PlaneGeometry(1, 1, 1, 1), this.floorMaterial);
    this.floorMesh.name = `${name}:floor`;
    this.floorMesh.frustumCulled = false;
    this.floorMesh.matrixAutoUpdate = false;
    this.floorMesh.layers.set(LAYER.VFX);
    this.floorMesh.renderOrder = renderOrder - 1;
    this.group.add(this.floorMesh);
  }

  /* ---------------- handles ---------------- */

  /** Add this to the ability's group. */
  get object3D() {
    return this.group;
  }

  get uniforms() {
    return this.material.uniforms;
  }

  /** One, or two with the floor companion. */
  get drawCalls() {
    return this.floorMesh ? 2 : 1;
  }

  /** Sheets drawn this frame. HUD readout / `Ability#instanceCount`. */
  get instanceCount() {
    return this.geometry.instanceCount;
  }

  get visible() {
    return this.group.visible;
  }

  set visible(v) {
    this.group.visible = !!v;
  }

  get mode() {
    return this.material.uniforms.uMode.value;
  }

  /** RAIN ⇄ AURORA ⇄ SHAFT. A uniform branch — no recompile. */
  set mode(m) {
    this.material.uniforms.uMode.value = m | 0;
  }

  get layout() {
    return this._layoutUniforms.uLayout.value;
  }

  /** LINE ⇄ RING ⇄ SCATTER. Shared by identity with the floor. */
  set layout(l) {
    this._layoutUniforms.uLayout.value = l | 0;
  }

  /**
   * Place the curtain without touching a matrix.
   *
   * @param {THREE.Vector3} anchor world foot of the curtain, metres
   * @param {THREE.Vector3} along  the layout's +X. For a **wall across the cast**
   *                               pass the cast's *side* vector, not its
   *                               direction — the line you aim is the wall's
   *                               normal, which is `stormwall`'s whole trick.
   * @param {THREE.Vector3} up     the sheets' up axis, re-orthogonalised. Pass
   *                               a negated `frame.uLightDir` for slanted shafts.
   */
  setPlacement(anchor, along, up) {
    const u = this._layoutUniforms;
    u.uAnchor.value.copy(anchor);
    _ax.copy(along).normalize();
    _az.crossVectors(up, _ax).normalize();
    _ay.crossVectors(_ax, _az).normalize();
    u.uAxisX.value.copy(_ax);
    u.uAxisY.value.copy(_ay);
    u.uAxisZ.value.copy(_az);
    return this;
  }

  /**
   * Re-roll the per-sheet dice. Call from `onSpawn` and nowhere else.
   *
   * The dice are the only thing a sheet carries and every one of them is
   * unitless: two for its place on the scatter disc, one for its bearing, four
   * for jitter/width/height/lean, one for phase. Where that lands it in metres
   * is decided by `update()` every frame, which is why a paused curtain re-lays
   * itself under `spacing` and `radius`.
   *
   * @param {number} [seed] per-cast seed; shifts the whole layout
   */
  roll(seed = Math.random() * 100) {
    this._layoutUniforms.uSeed.value = seed;
    for (let i = 0; i < this.capacity; i++) {
      const o = i * 4;
      this._diceA[o + 0] = Math.random();
      this._diceA[o + 1] = Math.random();
      this._diceA[o + 2] = Math.random();
      this._diceA[o + 3] = Math.random();
      this._diceB[o + 0] = Math.random();
      this._diceB[o + 1] = Math.random();
      this._diceB[o + 2] = Math.random();
      this._diceB[o + 3] = Math.random();
      this._seeds[i] = Math.random();
    }
    this.geometry.getAttribute('aDiceA').needsUpdate = true;
    this.geometry.getAttribute('aDiceB').needsUpdate = true;
    this.geometry.getAttribute('aSeed').needsUpdate = true;

    if (this._sheetDice) {
      for (let i = 0; i < FLOOR_SHEETS; i++) {
        const src = (i < this.capacity ? i : 0) * 4;
        this._sheetDice[i].set(
          this._diceA[src + 0],
          this._diceA[src + 1],
          this._diceA[src + 2],
          this._diceA[src + 3]
        );
        this._sheetJitter[i] = this._diceB[src + 0];
      }
    }
    return this;
  }

  /** Hide it. Leaves the instance reusable — the pooling contract. */
  reset() {
    this.geometry.instanceCount = 0;
    this.group.visible = false;
    return this;
  }

  /* ---------------- the frame ---------------- */

  /**
   * Re-resolve every dimension. Every frame, zero-length ones included.
   *
   * *the layout* — `count`, `spacing` (metres, LINE), `radius` (metres, RING and
   * SCATTER), `scatter` (metres), `seed`.
   *
   * *the sheet* — `width` / `widthJitter`, `height` / `heightJitter`, `base`
   * (metres above the anchor), `taper` (width multiplier at the head), `lean` /
   * `leanJitter` (metres), `rise` (0..1) and `riseSpread`.
   *
   * *the ripple* — `rippleAmp` (metres), `rippleLength` (metres), `rippleSpeed`
   * (m/s), `rippleCurve`, the slower `foldAmp` / `foldLength` / `foldSpeed`, the
   * `rippleNoise` / `rippleNoiseScale` / `rippleNoiseSpeed` slop, `phaseSpread`.
   *
   * *the two curves* — `alphaBase` / `alphaTop` / `alphaCurve` against
   * `emissionBase` / `emissionTop` / `emissionCurve`. **Make them disagree.**
   *
   * *the envelope* — `body` (0..1 how much α the sheet may have at all),
   * `footFade`, `headFade`, `edgeFade`, `graze`, `grazeFloor`, `softFade`,
   * `opacity`, `glow`, `tintSpread`.
   *
   * *RAIN* — `streakDensity` (lanes/metre), `streakRepeat`, `streakSpeed`,
   * `streakSpeedJitter`, `streakWidth`, `streakTail`, `streakDuty`, `haze`.
   *
   * *AURORA* — `rayScale`, `raySpeed`, `raySharp`, `bandScale`, `bandSpeed`,
   * `hem`.
   *
   * *SHAFT* — `coreWidth`, `canopy`, `canopySoft`, `canopyScale`, `mote`,
   * `moteScale`, `moteSize`, `moteDrift`.
   *
   * *colour* — `colorA`, `colorB`, `colorC` (the band mix), `colorHem`,
   * `colorCore`, `colorMote`, `colorBody` (what it occludes with — independent
   * of everything it emits).
   *
   * *the floor* — `floorSize`, `floorFade`, `wet`, `wetDark`, `sheen`,
   * `sheenRough`, `sheenSpeed`, `floorFresnel`, `pool`, `poolWidth`,
   * `poolLength`, `poolSoft`, `rings`, `ringScale`, `ringPeriod`, `ringRadius`,
   * `ringWidth`, `floorOpacity`, `colorWet`, `colorPool`, `colorRing`.
   *
   * @param {number} _now seconds since the cast began. Accepted for symmetry
   *   with the rest of the library; a curtain's motion is a standing one and
   *   rides the shared `uTime`, so it does not restart on every cast.
   * @param {object} p    a plain object. Keep it at module scope and refill it.
   */
  update(_now, p) {
    const u = this.material.uniforms;
    const l = this._layoutUniforms;

    const count = Math.max(0, Math.min(this.capacity, Math.round(num(p.count, DEFAULTS.count))));
    this.geometry.instanceCount = count;
    l.uCount.value = count;
    l.uSpacing.value = num(p.spacing, DEFAULTS.spacing);
    l.uRadius.value = num(p.radius, DEFAULTS.radius);
    l.uScatter.value = num(p.scatter, DEFAULTS.scatter);
    if (p.seed !== undefined && p.seed !== null) l.uSeed.value = p.seed;

    u.uWidth.value = num(p.width, DEFAULTS.width);
    u.uWidthJitter.value = num(p.widthJitter, DEFAULTS.widthJitter);
    u.uHeight.value = num(p.height, DEFAULTS.height);
    u.uHeightJitter.value = num(p.heightJitter, DEFAULTS.heightJitter);
    u.uBase.value = num(p.base, DEFAULTS.base);
    u.uTaper.value = num(p.taper, DEFAULTS.taper);
    u.uLean.value = num(p.lean, DEFAULTS.lean);
    u.uLeanJitter.value = num(p.leanJitter, DEFAULTS.leanJitter);
    u.uRise.value = num(p.rise, DEFAULTS.rise);
    // Hard-capped below 1: at 1 the stagger's denominator is zero and every
    // sheet either pops in on frame one or never appears at all.
    u.uRiseSpread.value = Math.min(num(p.riseSpread, DEFAULTS.riseSpread), 0.95);

    u.uRippleAmp.value = num(p.rippleAmp, DEFAULTS.rippleAmp);
    u.uRippleLength.value = num(p.rippleLength, DEFAULTS.rippleLength);
    u.uRippleSpeed.value = num(p.rippleSpeed, DEFAULTS.rippleSpeed);
    u.uRippleCurve.value = num(p.rippleCurve, DEFAULTS.rippleCurve);
    u.uFoldAmp.value = num(p.foldAmp, DEFAULTS.foldAmp);
    u.uFoldLength.value = num(p.foldLength, DEFAULTS.foldLength);
    u.uFoldSpeed.value = num(p.foldSpeed, DEFAULTS.foldSpeed);
    u.uRippleNoise.value = num(p.rippleNoise, DEFAULTS.rippleNoise);
    u.uRippleNoiseScale.value = num(p.rippleNoiseScale, DEFAULTS.rippleNoiseScale);
    u.uRippleNoiseSpeed.value = num(p.rippleNoiseSpeed, DEFAULTS.rippleNoiseSpeed);
    u.uPhaseSpread.value = num(p.phaseSpread, DEFAULTS.phaseSpread);

    u.uAlphaBase.value = num(p.alphaBase, DEFAULTS.alphaBase);
    u.uAlphaTop.value = num(p.alphaTop, DEFAULTS.alphaTop);
    u.uAlphaCurve.value = num(p.alphaCurve, DEFAULTS.alphaCurve);
    u.uEmissionBase.value = num(p.emissionBase, DEFAULTS.emissionBase);
    u.uEmissionTop.value = num(p.emissionTop, DEFAULTS.emissionTop);
    u.uEmissionCurve.value = num(p.emissionCurve, DEFAULTS.emissionCurve);

    u.uBody.value = num(p.body, DEFAULTS.body);
    u.uFootFade.value = num(p.footFade, DEFAULTS.footFade);
    u.uHeadFade.value = num(p.headFade, DEFAULTS.headFade);
    u.uEdgeFade.value = num(p.edgeFade, DEFAULTS.edgeFade);
    u.uGraze.value = num(p.graze, DEFAULTS.graze);
    u.uGrazeFloor.value = num(p.grazeFloor, DEFAULTS.grazeFloor);
    u.uSoftFade.value = num(p.softFade, DEFAULTS.softFade);

    u.uStreakDensity.value = num(p.streakDensity, DEFAULTS.streakDensity);
    u.uStreakRepeat.value = num(p.streakRepeat, DEFAULTS.streakRepeat);
    u.uStreakSpeed.value = num(p.streakSpeed, DEFAULTS.streakSpeed);
    u.uStreakSpeedJitter.value = num(p.streakSpeedJitter, DEFAULTS.streakSpeedJitter);
    u.uStreakWidth.value = num(p.streakWidth, DEFAULTS.streakWidth);
    u.uStreakTail.value = num(p.streakTail, DEFAULTS.streakTail);
    u.uStreakDuty.value = num(p.streakDuty, DEFAULTS.streakDuty);
    u.uHaze.value = num(p.haze, DEFAULTS.haze);

    u.uRayScale.value = num(p.rayScale, DEFAULTS.rayScale);
    u.uRaySpeed.value = num(p.raySpeed, DEFAULTS.raySpeed);
    u.uRaySharp.value = num(p.raySharp, DEFAULTS.raySharp);
    u.uBandScale.value = num(p.bandScale, DEFAULTS.bandScale);
    u.uBandSpeed.value = num(p.bandSpeed, DEFAULTS.bandSpeed);
    u.uHem.value = num(p.hem, DEFAULTS.hem);

    u.uCoreWidth.value = num(p.coreWidth, DEFAULTS.coreWidth);
    u.uCanopy.value = num(p.canopy, DEFAULTS.canopy);
    u.uCanopySoft.value = num(p.canopySoft, DEFAULTS.canopySoft);
    u.uCanopyScale.value = num(p.canopyScale, DEFAULTS.canopyScale);
    u.uMote.value = num(p.mote, DEFAULTS.mote);
    u.uMoteScale.value = num(p.moteScale, DEFAULTS.moteScale);
    u.uMoteSize.value = num(p.moteSize, DEFAULTS.moteSize);
    u.uMoteDrift.value = num(p.moteDrift, DEFAULTS.moteDrift);

    u.uTintSpread.value = num(p.tintSpread, DEFAULTS.tintSpread);
    u.uGlow.value = num(p.glow, DEFAULTS.glow);
    u.uOpacity.value = num(p.opacity, DEFAULTS.opacity);

    copyColor(u.uColorA.value, p.colorA || DEFAULTS.colorA);
    copyColor(u.uColorB.value, p.colorB || DEFAULTS.colorB);
    copyColor(u.uColorC.value, p.colorC || DEFAULTS.colorC);
    copyColor(u.uColorHem.value, p.colorHem || DEFAULTS.colorHem);
    copyColor(u.uColorCore.value, p.colorCore || DEFAULTS.colorCore);
    copyColor(u.uColorMote.value, p.colorMote || DEFAULTS.colorMote);
    copyColor(u.uColorBody.value, p.colorBody || DEFAULTS.colorBody);

    if (this.floorMaterial) {
      const f = this.floorMaterial.uniforms;
      f.uFloorSize.value = num(p.floorSize, DEFAULTS.floorSize);
      f.uFloorFade.value = num(p.floorFade, DEFAULTS.floorFade);
      f.uWet.value = num(p.wet, DEFAULTS.wet);
      f.uWetDark.value = num(p.wetDark, DEFAULTS.wetDark);
      f.uSheen.value = num(p.sheen, DEFAULTS.sheen);
      f.uSheenRough.value = num(p.sheenRough, DEFAULTS.sheenRough);
      f.uSheenSpeed.value = num(p.sheenSpeed, DEFAULTS.sheenSpeed);
      f.uFresnel.value = num(p.floorFresnel, DEFAULTS.floorFresnel);
      f.uPool.value = num(p.pool, DEFAULTS.pool);
      f.uPoolWidth.value = num(p.poolWidth, DEFAULTS.poolWidth);
      f.uPoolLength.value = num(p.poolLength, DEFAULTS.poolLength);
      f.uPoolSoft.value = num(p.poolSoft, DEFAULTS.poolSoft);
      f.uRings.value = num(p.rings, DEFAULTS.rings);
      f.uRingScale.value = num(p.ringScale, DEFAULTS.ringScale);
      f.uRingPeriod.value = num(p.ringPeriod, DEFAULTS.ringPeriod);
      f.uRingRadius.value = num(p.ringRadius, DEFAULTS.ringRadius);
      f.uRingWidth.value = num(p.ringWidth, DEFAULTS.ringWidth);
      f.uFloorOpacity.value = num(p.floorOpacity, DEFAULTS.floorOpacity);
      // The pools have to follow the sheets' live width, not a captured one.
      f.uSheetHalf.value = num(p.width, DEFAULTS.width) * 0.5;
      copyColor(f.uColorWet.value, p.colorWet || DEFAULTS.colorWet);
      copyColor(f.uColorPool.value, p.colorPool || DEFAULTS.colorPool);
      copyColor(f.uColorRing.value, p.colorRing || DEFAULTS.colorRing);
    }

    return this;
  }

  /* ---------------- read-back ---------------- */

  /**
   * A point on sheet `index`, in world metres — where to hang an emitter.
   *
   * Mirrors `sheetFrame()` exactly, because the dice it reads are the same
   * floats the vertex shader reads. It deliberately leaves out the travelling
   * ripple: you want droplets leaving a clean line, and sampling the ripple
   * would jitter every emitter by the sheet's own fold, which reads as a fault
   * in the emitter rather than as motion in the curtain.
   *
   * @param {number}        index    0..count-1
   * @param {object}        p        the same live params `update()` was given
   * @param {THREE.Vector3} out      written in place
   * @param {number}        [across] −1..1 across the sheet's width
   * @param {number}        [height] 0..1 up the sheet
   */
  sheetPoint(index, p, out, across = 0, height = 0) {
    const l = this._layoutUniforms;
    const n = Math.max(1, Math.min(this.capacity, Math.round(num(p.count, DEFAULTS.count))));
    const slot = Math.max(0, Math.min(n - 1, index | 0));
    const o = slot * 4;

    const dRadius = this._diceA[o + 0];
    const dAngle = this._diceA[o + 1];
    const dBearing = this._diceA[o + 2];
    const dJitterAlong = this._diceA[o + 3];
    const dJitterAcross = this._diceB[o + 0];

    const ax = l.uAxisX.value;
    const ay = l.uAxisY.value;
    const az = l.uAxisZ.value;
    const radius = num(p.radius, DEFAULTS.radius);
    const spacing = num(p.spacing, DEFAULTS.spacing);

    if (l.uLayout.value === CurtainLayout.RING) {
      const a = ((slot + 0.5) / n) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      _norm.copy(ax).multiplyScalar(c).addScaledVector(az, s);
      _along.copy(ax).multiplyScalar(-s).addScaledVector(az, c);
      _centre.copy(l.uAnchor.value).addScaledVector(_norm, radius);
    } else if (l.uLayout.value === CurtainLayout.SCATTER) {
      const rr = radius * Math.sqrt(Math.min(Math.max(dRadius, 0), 1));
      const aa = dAngle * Math.PI * 2;
      _centre
        .copy(l.uAnchor.value)
        .addScaledVector(ax, Math.cos(aa) * rr)
        .addScaledVector(az, Math.sin(aa) * rr);
      const b = dBearing * Math.PI * 2;
      _along.copy(ax).multiplyScalar(Math.cos(b)).addScaledVector(az, Math.sin(b));
      _norm.crossVectors(_along, ay).normalize();
    } else {
      _centre.copy(l.uAnchor.value).addScaledVector(ax, (slot - (n - 1) * 0.5) * spacing);
      _along.copy(ax);
      _norm.copy(az);
    }

    const scatter = num(p.scatter, DEFAULTS.scatter);
    _centre
      .addScaledVector(_along, (dJitterAlong - 0.5) * scatter * 2)
      .addScaledVector(_norm, (dJitterAcross - 0.5) * scatter * 2);

    const hh = Math.min(Math.max(height, 0), 1);
    const w =
      num(p.width, DEFAULTS.width) *
      (1 + (this._diceB[o + 1] - 0.5) * 2 * num(p.widthJitter, DEFAULTS.widthJitter)) *
      (1 + (num(p.taper, DEFAULTS.taper) - 1) * hh);
    const H =
      num(p.height, DEFAULTS.height) *
      (1 + (this._diceB[o + 2] - 0.5) * 2 * num(p.heightJitter, DEFAULTS.heightJitter));
    const lean =
      num(p.lean, DEFAULTS.lean) *
      (1 + (this._diceB[o + 3] - 0.5) * 2 * num(p.leanJitter, DEFAULTS.leanJitter));

    out
      .copy(_centre)
      .addScaledVector(_along, across * w * 0.5)
      .addScaledVector(ay, num(p.base, DEFAULTS.base) + hh * H)
      .addScaledVector(_norm, lean * hh);
    return out;
  }

  dispose() {
    this.group.visible = false;
    this.geometry.dispose();
    this.material.dispose();
    if (this.floorMesh) {
      this.floorMesh.geometry.dispose();
      this.floorMaterial.dispose();
    }
    this.group.parent?.remove(this.group);
  }
}
