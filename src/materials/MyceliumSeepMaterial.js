import { ShaderMaterial, AdditiveBlending, DoubleSide, Color, Vector2 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { disruptGLSL, disruptUniforms } from '../vfx/SceneHooks.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/* ---------------------------------------------------------------------- */
/* MyceliumSeepMaterial — light arriving from underneath the floor         */
/* ---------------------------------------------------------------------- */

/**
 * The seep quad: **one draw call of light that is not allowed to draw itself.**
 *
 * Every other ground effect in this project is a mark *on* the stone — a
 * scorch, a plate of ice, a seal, a puddle. This one is a mark *under* it, and
 * the whole difference lives in one multiply near the bottom of the fragment
 * shader: the hyphal network computes a radiance and then that radiance is
 * multiplied by an **escape mask** derived from the floor's own detail. Where
 * the stone is sound, the light does not come out. The pattern you see is
 * therefore the flagstone's, not the fungus's; the fungus only decides how
 * brightly each part of the flagstone is lit from below.
 *
 * ## Why the mask is the floor's own numbers and not a new noise field
 *
 * The first version drew a perfectly good crack field of its own — a ridged
 * fbm at about two cycles a metre — and it looked completely wrong the instant
 * the camera moved, in a way that took an embarrassing while to name. The
 * cracks did not line up with anything. The floor has visible structure (broad
 * tonal patches from `fbm3(wp * 0.018)`, a warm wash at `0.09`, polished
 * regions at `0.06`), the glow had *different* structure, and the eye reads two
 * uncorrelated patterns on one surface as two surfaces — a decal on a floor,
 * which is exactly the thing the brief forbids.
 *
 * So the mask is built out of `world/Ground.js`'s **actual expressions**, at
 * the same frequencies and the same phase offsets:
 *
 * | the floor writes | this shader reads it as |
 * | --- | --- |
 * | `fbm3(wp * 0.018)` — broad tonal variation | its **level set** is the mortar course: the boundary between two flags |
 * | `fbm3(wp * 0.06 + 3.0)` — the sheen patches | polished stone is *closed*; it seals the light off |
 * | `snoise01(wp * 0.7)` — the grain | biases where the open pores sit |
 *
 * Those three lines are copied verbatim, deliberately, and this comment is the
 * dependency: if the floor's macro frequency ever changes, the seams here stop
 * following the flags and someone has to come back. That is a real coupling and
 * it is worth having, because the alternative is the decal.
 *
 * The one thing that could **not** be shared is the fine pore detail, because
 * the floor gets that from its normal map — one of the project's two texture
 * exceptions, and something an ability may not sample under I2. `porePitch` is
 * therefore a re-synthesised field with its own slider, matched to the map's
 * grain by eye and adjustable when the map changes.
 *
 * ## The seam is measured in metres, not in field units
 *
 * `abs(macro - seamLevel) < seamWidth` is the obvious way to draw a contour and
 * it is wrong: `macro` is dimensionless, so the band's width on the floor is
 * whatever the field's local slope happens to make it — hairline across a steep
 * patch, half a metre wide across a flat one, and the transition between the
 * two reads as a smear. Two extra taps of the same fbm give the field's
 * gradient in units-per-metre, and dividing by it turns the contour distance
 * into **metres**. `seamWidth` is then a real measurement of a real mortar
 * course, and the same gradient, normalised, is the direction across the crack
 * — which the crevice term below needs anyway, so it is two taps for two jobs.
 *
 * ## Depth is the reason it does not look like a painted network
 *
 * A hypha is buried somewhere between `webDepthMin` and `webDepthMax` metres
 * down, varying over the field. Depth does three things, all of them physical
 * and all of them sliders:
 *
 *  1. **It blurs.** The Gaussian half-width the strand is smeared over is
 *     `webCore + depth * webSpread`, so a shallow run is a tight bright thread
 *     and a deep one is a broad dim smudge. This is the single term that sells
 *     "under".
 *  2. **It absorbs.** `exp(-depth * webAbsorb)`, Beer–Lambert through the flags.
 *  3. **It parallaxes.** The buried point is sampled at
 *     `lane - viewXZ * depth / viewY`, so the network *slides against the
 *     cracks it is seen through* as the camera orbits. Turn `webParallax` to
 *     zero and the whole thing immediately flattens into a sticker; it is the
 *     cheapest convincing term in the file and the one worth protecting.
 *
 * ## Cost
 *
 * One draw call, no textures. Five `fbm3` (three octaves of simplex each), two
 * `snoise01` and two 3×3 cell walks per fragment — comparable to
 * `GroundField`'s PLATE branch, and it only ever covers the cast lane.
 *
 * @example
 *   this.seepMaterial = createMyceliumSeepMaterial();
 *   // …every frame, travel and fade alike:
 *   this.seepMaterial.userData.sync(this._state);
 */

const SEEP_VERTEX = /* glsl */ `
  uniform vec3 uLightDir;      // world space, toward the key

  ${disruptGLSL}

  varying float vDisrupt;
  varying vec2  vUv2;
  varying vec2  vWorldXZ;      // world metres — the stone fields are sampled here
  varying vec3  vLight;        // key direction, in the quad's frame
  varying vec3  vView;         // fragment -> camera, in the quad's frame
  varying vec3  vViewWorld;    // the same thing in world space, for the crevice term
  varying float vViewZ;

  void main() {
    vUv2 = uv;

    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldXZ = world.xz;

    vec3 ax = normalize(modelMatrix[0].xyz);
    vec3 ay = normalize(modelMatrix[1].xyz);
    vec3 az = normalize(modelMatrix[2].xyz);

    vLight = normalize(vec3(dot(uLightDir, ax), dot(uLightDir, ay), dot(uLightDir, az)));

    vec3 toCamera = cameraPosition - world.xyz;
    vViewWorld = normalize(toCamera);
    vView = normalize(vec3(dot(toCamera, ax), dot(toCamera, ay), dot(toCamera, az)));

    vDisrupt = disruptAt(world.xyz);

    vec4 mv = viewMatrix * world;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const SEEP_FRAGMENT = /* glsl */ `
  ${disruptGLSL}
  varying float vDisrupt;

  uniform float uTime;

  /* ---- the lane, all metres ---- */
  uniform vec2  uQuadSize;     // metres the quad covers: x across, y downrange
  uniform float uLength;       // the cast length; dz = 0 is the caster
  uniform float uHalfWidth;    // half-width of the band the network spreads in
  uniform float uTaper;        // 0..1 how much narrower the far end is
  uniform float uBack;         // metres the network reaches back behind the caster
  uniform float uEdge;         // metres of feather on every boundary
  uniform float uRagged;       // metres the boundaries wander by
  uniform float uRaggedScale;  // lobes per metre
  uniform float uWarp;         // metres of domain warp on those lobes
  uniform float uGrow;         // 0..1 the advancing front
  uniform float uRetreat;      // 0..1 the network dying back from the caster
  uniform float uSeed;

  /* ---- the buried web ---- */
  uniform float uCell;         // metres between hyphae
  uniform float uStretch;      // >1 draws the strands out along the lane
  uniform float uJitter;       // 0..1 lattice disorder
  uniform float uCore;         // metres — half-width of a hypha at zero depth
  uniform float uSpread;       // extra metres of half-width per metre of depth
  uniform float uDepthMin;     // metres
  uniform float uDepthMax;     // metres
  uniform float uDepthPitch;   // cycles per metre in the burial-depth field
  uniform float uAbsorb;       // 1/metre — Beer-Lambert through the flags
  uniform float uParallax;     // 0..1 of the true depth offset
  uniform float uBranch;       // 0..1 weight of the finer secondary web
  uniform float uBranchScale;  // >1 how much finer that web is

  /* ---- the nutrient pulses ---- */
  uniform float uPulseSpacing; // metres between pulse crests
  uniform float uPulseSpeed;   // metres per second they run downrange at
  uniform float uPulseSharp;   // crest exponent
  uniform float uPulseGain;

  /* ---- the escape mask: the floor's own detail ---- */
  uniform float uStoneStep;    // metres between the macro-gradient taps
  uniform float uSeamLevel;    // which contour of the floor's macro field is mortar
  uniform float uSeamWidth;    // metres — the mortar course, a real measurement
  uniform float uSeamWeight;   // 0..1 how much light the seams pass
  uniform float uSeamRelief;   // 0..1 how much a seam behaves like a slot
  uniform float uSeamGlow;     // extra light on the lip of a lit seam
  uniform float uPorePitch;    // cycles per metre in the re-synthesised pore field
  uniform float uPoreCut;      // 0..1 how sparse the open pores are
  uniform float uPoreWeight;   // 0..1 how much light the pores pass
  uniform float uPolishSeal;   // 0..1 how completely the floor's sheen patches close
  uniform float uBleed;        // 0..1 floor on the mask — thin flags are never opaque

  /* ---- output ---- */
  uniform float uFade;
  uniform float uOpacity;
  uniform float uEmissive;
  uniform float uDepthFade;    // metres
  uniform vec3  uColorDeep;    // the far-buried glow
  uniform vec3  uColorShallow; // a hypha just under the surface
  uniform vec3  uColorPulse;   // a nutrient surge running the web
  uniform vec3  uColorSeam;    // the lip of a crack catching the light

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying vec2  vUv2;
  varying vec2  vWorldXZ;
  varying vec3  vLight;
  varying vec3  vView;
  varying vec3  vViewWorld;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  /**
   * Voronoi that reports the distance to the cell **wall** rather than to the
   * site, because a mycelial network is a partition of its substrate and the
   * hyphae are the walls of that partition, not its centres.
   *
   * noise.glsl.js#voronoi2 hands back F1, which draws blobs. Half the F1/F2 gap
   * is the standard cheap estimate of the distance to the equidistant set — not
   * exact near a triple point, and nobody has ever seen the error on something
   * this diffuse.
   */
  float mycWall(vec2 pt, float jitter, out float id) {
    vec2 n = floor(pt);
    vec2 f = fract(pt);
    float d1 = 8.0;
    float d2 = 8.0;
    id = 0.0;

    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 o = mix(vec2(0.5), hash21(dot(n + g, vec2(7.13, 113.17))), jitter);
        vec2 r = g + o - f;
        float d = dot(r, r);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          id = hash11(dot(n + g, vec2(31.7, 57.1)));
        } else if (d < d2) {
          d2 = d;
        }
      }
    }
    return 0.5 * (sqrt(d2) - sqrt(d1));
  }

  void main() {
    /* ---- uv -> metres in the lane's frame; +y runs downrange ---- */
    vec2 p = vec2(vUv2.x - 0.5, 0.5 - vUv2.y) * uQuadSize;

    // Metres per pixel, taken before the first discard: a derivative evaluated
    // in divergent control flow is undefined, and the symptom is a sparkling
    // fringe on exactly one vendor's driver.
    vec2 pd = fwidth(p);
    float px = max(max(pd.x, pd.y), 1e-5);

    // The quad is centred on the middle of the cast, so this is metres
    // downrange of the caster and metres sideways off the spine.
    float dz = p.y + uLength * 0.5;
    float dx = p.x;

    /* ---- the footprint, warped in the plane and never on atan(y, x) ---- */
    // An angular sample hands every radius along a bearing the same value and
    // draws dead-straight spokes; a fungus does not grow in spokes.
    vec2 warped = p + vec2(
      fbm3(vec3(p * uRaggedScale, uSeed)),
      fbm3(vec3(p.yx * uRaggedScale, uSeed + 5.0))
    ) * uWarp;
    float lobe = fbm3(vec3(warped * uRaggedScale, uSeed + 11.0));

    float along = clamp(dz / max(uLength, 0.01), 0.0, 1.0);
    float halfW = max(uHalfWidth * (1.0 - clamp(uTaper, 0.0, 1.0) * along), 0.02);
    float rim = halfW + lobe * uRagged;
    float band = smoothstep(rim, rim - max(uEdge, 1e-3), abs(dx));

    float front = uGrow * (uLength + uEdge) + lobe * uRagged;
    float head = smoothstep(front, front - max(uEdge, 1e-3), dz);
    // The die-back runs the other way: the network is abandoned from the
    // caster outward, so the near end goes first and the far end lingers.
    float heel = -uBack + uRetreat * (uLength + uBack) + lobe * uRagged;
    float tail = smoothstep(heel - max(uEdge, 1e-3), heel, dz);

    float cover = band * head * tail;
    if (cover < 0.002) discard;

    /* ------------------------------------------------------------------ */
    /* The floor's own detail — see the doc comment. These four lines are   */
    /* world/Ground.js's, at its frequencies and its phase offsets.         */
    /* ------------------------------------------------------------------ */
    vec3 wp = vec3(vWorldXZ.x, 0.0, vWorldXZ.y);

    float macro = fbm3(wp * 0.018);
    float step2 = max(uStoneStep, 0.01);
    float macroX = fbm3((wp + vec3(step2, 0.0, 0.0)) * 0.018);
    float macroZ = fbm3((wp + vec3(0.0, 0.0, step2)) * 0.018);

    // Field units per metre. Dividing the contour distance by it is what makes
    // seamWidth a measurement rather than a number.
    vec2 grad = vec2(macroX - macro, macroZ - macro) / step2;
    float slope = max(length(grad), 1e-4);
    float seamMetres = abs(macro - uSeamLevel) / slope;
    float seam = 1.0 - smoothstep(uSeamWidth * 0.5, uSeamWidth * 0.5 + px * 1.5, seamMetres);

    // The floor's sheen patches. Polished stone is closed stone.
    float polish = smoothstep(0.3, 0.85, fbm3(wp * 0.06 + 3.0) * 0.5 + 0.5);

    // The pores. Re-synthesised rather than shared, because the floor's own
    // pore detail is in its normal map and I2 does not let an ability read it.
    // The grain the floor *does* compute procedurally biases where they sit.
    float grain = snoise01(wp * 0.7);
    float pore = smoothstep(uPoreCut, 1.0, snoise01(wp * uPorePitch) * (0.65 + 0.35 * grain));

    float openness = seam * uSeamWeight + pore * uPoreWeight;
    openness *= 1.0 - clamp(uPolishSeal, 0.0, 1.0) * polish;
    openness = clamp(max(openness, uBleed), 0.0, 1.0);

    /* ------------------------------------------------------------------ */
    /* The buried network                                                   */
    /* ------------------------------------------------------------------ */
    float burial = mix(
      uDepthMin,
      uDepthMax,
      snoise01(vec3(vWorldXZ.x, uSeed, vWorldXZ.y) * uDepthPitch)
    );

    vec3 V = normalize(vView);
    // The thing you are looking at is not under the pixel it appears in: it is
    // burial metres down, so it sits burial * tan(theta) away from the crack it
    // is seen through. Clamping the elevation stops the offset exploding at the
    // horizon, where the quad is a pixel tall anyway.
    vec2 lane = vec2(dx, dz) - vec2(V.x, V.z) * (burial * uParallax / max(V.y, 0.2));

    float cellSize = max(uCell, 0.03);
    vec2 web = vec2(lane.x / max(uStretch, 0.05), lane.y) / cellSize + uSeed;

    float id = 0.0;
    float wall = mycWall(web, clamp(uJitter, 0.0, 1.0), id);
    // Approximate: the x axis was divided by uStretch, so a metre across the
    // lane is not a metre along it. The error is a widening of the strands seen
    // end-on, which is what a stretched network does anyway.
    float strand = wall * cellSize;

    float id2 = 0.0;
    float fine = max(uBranchScale, 1.0);
    float wall2 = mycWall(web * fine + 7.31, clamp(uJitter, 0.0, 1.0), id2);
    float strand2 = wall2 * cellSize / fine;

    // Depth blurs. A shallow run is a tight bright thread; a deep one is a
    // broad dim smudge, because the stone above it scatters. One Gaussian,
    // whose width is a linear function of the burial depth.
    float sigma = max(uCore + burial * uSpread, 0.002);
    float inv2 = 1.0 / (2.0 * sigma * sigma);
    float lit = exp(-strand * strand * inv2);
    lit = max(lit, exp(-strand2 * strand2 * inv2) * clamp(uBranch, 0.0, 1.0));
    lit *= exp(-burial * max(uAbsorb, 0.0));

    /* ---- nutrient pulses, running outward from the caster ---- */
    float phase = fract((dz - uTime * uPulseSpeed) / max(uPulseSpacing, 0.05) + id);
    float pulse = pow(1.0 - phase, max(uPulseSharp, 1.0));

    /* ---- a crack is a slot, and you cannot see all the way into it ---- */
    // Two terms, both real. Looking down a crack you see its glowing floor;
    // looking along it you see the near wall instead — that is the elevation
    // term. And the two walls are not symmetric about the viewer, so the crack
    // brightens on one side as the camera orbits — that is the facing term,
    // taken in world space because the stone gradient is a world quantity.
    vec2 seamAcross = grad / slope;
    vec2 viewFlat = normalize(vec2(vViewWorld.x, vViewWorld.z) + 1e-5);
    float facing = dot(seamAcross, viewFlat);
    float elevation = clamp(vViewWorld.y, 0.0, 1.0);
    float slotted = mix(1.0, elevation * (0.55 + 0.45 * facing), clamp(uSeamRelief, 0.0, 1.0));

    /* ---- assemble ---- */
    float deepness = clamp(
      (burial - uDepthMin) / max(uDepthMax - uDepthMin, 1e-3),
      0.0,
      1.0
    );
    vec3 color = mix(uColorShallow, uColorDeep, deepness);
    color += uColorPulse * (pulse * uPulseGain);
    color += uColorSeam * (seam * uSeamGlow);
    color *= uEmissive;

    // The key light does nothing to this — it is light *leaving* the floor —
    // but a fragment facing away from the key sits in the floor's own shadow
    // and reads brighter, which is the one place the sun is allowed in.
    color *= 1.0 + 0.12 * (1.0 - max(vLight.y, 0.0));

    float alpha = cover * openness * lit * slotted * uFade * uOpacity;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    float depthBits = unpackRGBAToDepth(texture2D(uSceneDepth, screenUV));
    float sceneViewZ = perspectiveDepthToViewZ(depthBits, uCameraNear, uCameraFar);
    alpha *= smoothstep(-max(uDepthFade, 1e-3), 0.0, vViewZ - sceneViewZ);

    if (alpha < 0.004) discard;
    color *= uGlobalGlow;
    disruptShade(color, alpha, vDisrupt, gl_FragCoord.xy);
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  }
`;

/**
 * Build the seep quad's material.
 *
 * Additive, because this is genuinely light being added to a floor that is
 * already there. The damp the network leaves behind is a separate,
 * alpha-blended `GroundField(WET)` — one mesh cannot both add and subtract, and
 * splitting them is what lets the stain be darker than the stone while the
 * glow is brighter.
 *
 * @returns {THREE.ShaderMaterial} with `userData.sync(state)` on it
 */
export function createMyceliumSeepMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uQuadSize: { value: new Vector2(12, 20) },
      uLength: { value: 16 },
      uHalfWidth: { value: 2.4 },
      uTaper: { value: 0.25 },
      uBack: { value: 0.8 },
      uEdge: { value: 0.5 },
      uRagged: { value: 0.7 },
      uRaggedScale: { value: 0.5 },
      uWarp: { value: 0.8 },
      uGrow: { value: 0 },
      uRetreat: { value: 0 },
      uSeed: { value: 0 },

      uCell: { value: 0.42 },
      uStretch: { value: 2.2 },
      uJitter: { value: 0.9 },
      uCore: { value: 0.012 },
      uSpread: { value: 0.55 },
      uDepthMin: { value: 0.02 },
      uDepthMax: { value: 0.22 },
      uDepthPitch: { value: 0.35 },
      uAbsorb: { value: 4.5 },
      uParallax: { value: 1 },
      uBranch: { value: 0.5 },
      uBranchScale: { value: 2.7 },

      uPulseSpacing: { value: 3.2 },
      uPulseSpeed: { value: 2.4 },
      uPulseSharp: { value: 7 },
      uPulseGain: { value: 0.8 },

      uStoneStep: { value: 0.35 },
      uSeamLevel: { value: 0.05 },
      uSeamWidth: { value: 0.07 },
      uSeamWeight: { value: 1 },
      uSeamRelief: { value: 0.55 },
      uSeamGlow: { value: 0.35 },
      uPorePitch: { value: 9 },
      uPoreCut: { value: 0.68 },
      uPoreWeight: { value: 0.45 },
      uPolishSeal: { value: 0.85 },
      uBleed: { value: 0.06 },

      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uEmissive: { value: 1 },
      uDepthFade: { value: 0.5 },
      uColorDeep: { value: new Color(0.09, 0.28, 0.3) },
      uColorShallow: { value: new Color(0.45, 0.95, 0.72) },
      uColorPulse: { value: new Color(0.75, 1, 0.68) },
      uColorSeam: { value: new Color(0.16, 0.42, 0.38) },

      // Opt in to vfx/SceneHooks.js's disruption field by identity, so a
      // Spellbreak standing in the lane reaches this quad too.
      ...disruptUniforms()
    }),
    vertexShader: SEEP_VERTEX,
    fragmentShader: SEEP_FRAGMENT
  });

  /**
   * Re-resolve every dimension from `settings.mycelium`. Called every frame,
   * including a zero-length one — nothing here is ever cached.
   *
   * @param {object} state `{ length, grow, retreat, fade, seed }` — the beats
   *   the ability owns. Everything with a unit comes off the settings block.
   */
  material.userData.sync = (state) => {
    const c = settings.mycelium;
    const g = settings.global;
    const u = material.uniforms;

    const length = Math.max(0.4, state.length);

    u.uLength.value = length;
    u.uGrow.value = state.grow;
    u.uRetreat.value = state.retreat;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uHalfWidth.value = Math.max(0.05, c.laneHalfWidth);
    u.uTaper.value = c.laneTaper;
    u.uBack.value = Math.max(0, c.laneBack);
    u.uEdge.value = Math.max(0.01, c.laneEdge);
    u.uRagged.value = c.laneRagged * g.noiseStrength;
    u.uRaggedScale.value = Math.max(0.02, c.laneRaggedScale * g.noiseFrequency);
    u.uWarp.value = c.laneWarp * g.noiseStrength;

    u.uCell.value = Math.max(0.03, c.webCell);
    u.uStretch.value = Math.max(0.05, c.webStretch);
    u.uJitter.value = c.webJitter;
    u.uCore.value = Math.max(0.001, c.webCore);
    u.uSpread.value = Math.max(0, c.webSpread);
    u.uDepthMin.value = Math.max(0, c.webDepthMin);
    u.uDepthMax.value = Math.max(c.webDepthMin + 0.005, c.webDepthMax);
    u.uDepthPitch.value = Math.max(0.01, c.webDepthPitch * g.noiseFrequency);
    u.uAbsorb.value = Math.max(0, c.webAbsorb);
    u.uParallax.value = c.webParallax;
    u.uBranch.value = c.webBranch;
    u.uBranchScale.value = Math.max(1, c.webBranchScale);

    u.uPulseSpacing.value = Math.max(0.05, c.pulseSpacing);
    u.uPulseSpeed.value = c.pulseSpeed * g.noiseSpeed;
    u.uPulseSharp.value = Math.max(1, c.pulseSharp);
    u.uPulseGain.value = c.pulseGain * g.shaderIntensity;

    u.uStoneStep.value = Math.max(0.02, c.stoneStep);
    u.uSeamLevel.value = c.seamLevel;
    u.uSeamWidth.value = Math.max(0.002, c.seamWidth);
    u.uSeamWeight.value = c.seamWeight;
    u.uSeamRelief.value = c.seamRelief;
    u.uSeamGlow.value = c.seamGlow * g.glow;
    u.uPorePitch.value = Math.max(0.1, c.porePitch * g.noiseFrequency);
    u.uPoreCut.value = c.poreCut;
    u.uPoreWeight.value = c.poreWeight;
    u.uPolishSeal.value = c.polishSeal;
    u.uBleed.value = c.stoneBleed;

    u.uEmissive.value = c.seepEmissive * g.glow;
    u.uOpacity.value = c.seepOpacity * g.opacity;
    u.uDepthFade.value = Math.max(0.01, c.seepDepthFade);
    u.uColorDeep.value.copy(getColor(c.colorSeepDeep));
    u.uColorShallow.value.copy(getColor(c.colorSeepShallow));
    u.uColorPulse.value.copy(getColor(c.colorSeepPulse));
    u.uColorSeam.value.copy(getColor(c.colorSeepSeam));

    /* ---- the quad, re-derived every frame so a drag re-scales the canvas ---- */
    const pad = Math.max(0.01, c.laneEdge) + Math.abs(c.laneRagged) + 0.4;
    const across = (Math.max(0.05, c.laneHalfWidth) + pad) * 2;
    const down = length + Math.max(0, c.laneBack) * 2 + pad * 2;
    u.uQuadSize.value.set(across, down);
    return u.uQuadSize.value;
  };

  return material;
}
