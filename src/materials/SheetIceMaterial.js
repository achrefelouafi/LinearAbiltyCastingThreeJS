import { MeshStandardMaterial, Color, DoubleSide, Vector2, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Sheet ice — the thin, curling plates of `RimeAbility`.
 *
 * **This is not `IceMaterial` in another colour, and the difference is the one
 * thing the ability is for.** A crystal is a *solid*: face one of its facets
 * head-on and you are looking down the long axis of the body, so it darkens;
 * catch it at a grazing angle and you are only clipping an edge, so it stays
 * pale. `IceMaterial` writes exactly that — `thickness = ndv * density` — and
 * it is right for a spike. A sheet three centimetres thick is the *other way
 * round*: face-on you are looking through three centimetres of ice and it is
 * nearly clear; at a grazing angle you are looking *along* the sheet and the
 * path is half a metre, so that is where it deepens toward the body tint. The
 * first version of Rimewalker reused `createIceMaterial` verbatim and the
 * plates read as blue slabs of glass lying on the floor — solid, heavy, and the
 * exact opposite of the brief. Inverting one term fixed it.
 *
 * Three things carry the read, in this order:
 *
 *  - **the lip.** A curled plate catches the key light on the outer band of its
 *    roll and nowhere else, so `uLipGlow` is keyed off `vSheetRoll`, which is 0
 *    at the hinge and 1 at the rolled rim, multiplied by how far this
 *    particular plate has actually peeled. A flat plate has no lip and gets no
 *    highlight, which is what makes the field *turn on* as it curls.
 *  - **translucency.** The plate behind shows through the plate in front. Alpha
 *    is low face-on and climbs with the path length, so a stack of three plates
 *    reads as three plates rather than as one wall.
 *  - **the environment.** These are polished sheets on a lit stage. Roughness
 *    and `envMapIntensity` are sliders because that reflection is doing more
 *    work here than any procedural term in the file.
 *
 * ## The curl is a vertex-shader roll, not geometry
 *
 * The plate is generated flat. Everything downwind of a hinge line is rolled
 * about that line at constant curvature, which is what paper does coming off a
 * hot pan, and the total angle at the rim is `uCurl` radians — a live slider
 * that runs a plate from dead flat to fully peeled while the clock is stopped.
 *
 * The per-plate clock is `aBirth`. `GrowthField` publishes exactly two
 * per-instance attributes, `aSeed` and `aBirth`, and `aBirth` is a birth flash
 * that runs 1 → 0 over `birthFade` seconds from the moment that instance was
 * triggered. Read backwards it is the only per-instance stopwatch the field
 * has, so the ability sets `birthFade` to the *curl* time and this shader reads
 * `1 - aBirth` as "how long since this plate locked". A staggered field
 * therefore peels in a wave without one line of per-instance bookkeeping on the
 * CPU. The cost is that the birth flash and the curl share a clock, which is
 * why the flash is raised to `uBirthPower` — at 6 it is gone in the first tenth
 * of a second of a one-second roll.
 *
 * The alternative, baking the curl into the geometry as a shape parameter, was
 * written first and thrown away: `syncGeometry` rebuilds *all* the variants at
 * once, so every plate in the field peeled in lockstep and the whole corridor
 * hinged like one sheet of paper. The stagger is the effect.
 *
 * ## The one number that is not resolved per frame
 *
 * None. Every metre, radian and second below is a uniform written from
 * `settings.rime` on every call to `userData.sync()`, paused frames included —
 * and `userData.uniforms` is where they are parked, because the harness's pause
 * test reads a patched `MeshStandardMaterial`'s uniforms from exactly there.
 */
export function createSheetIceMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.14,
    metalness: 0.0,
    // Flat shading is doing real work here: the roll is applied in the vertex
    // shader, and a face normal derived from screen-space derivatives follows a
    // displaced vertex for free. A smooth normal would have to be rotated by
    // the same roll, and `<defaultnormal_vertex>` has already run and written
    // `vNormal` by the time an injection after `<begin_vertex>` gets a look in.
    flatShading: true,
    transparent: true,
    // A sheet is seen from underneath the moment it peels.
    side: DoubleSide,
    // Kept on, as the crystals do: the plates are opaque enough that sorting
    // them against each other by depth reads better than letting the mist and
    // the glints composite straight through them.
    depthWrite: true
  });

  const uniforms = {
    uTime: frame.uTime,

    /* --- the roll --- */
    uCurl: { value: 2.5 }, // radians at the rim when fully peeled
    uCurlDelay: { value: 0.34 }, // fraction of the curl clock spent lying flat
    uCurlSpread: { value: 0.55 }, // radians of per-plate bearing jitter
    uCurlHinge: { value: -0.06 }, // unit-space position of the hinge line
    uCurlDir: { value: new Vector2(0, 1) }, // world XZ, the direction they peel toward

    /* --- the sublimation front --- */
    uSublimeOrigin: { value: new Vector3() },
    uSublimeDir: { value: new Vector3(0, 0, 1) },
    uSublimeFront: { value: -1e4 }, // metres downrange; below the field means "intact"
    uSublimeEdge: { value: 1.1 }, // metres of the dissolve band
    uSublimeGlow: { value: 2.2 },
    uColorSublime: { value: new Color() },

    /* --- the sheet --- */
    uColorSheet: { value: new Color() },
    uColorDeep: { value: new Color() },
    uColorLip: { value: new Color() },
    uColorGlow: { value: new Color() },
    uDepthTint: { value: 1.15 },
    uDepthPower: { value: 1.5 },
    uTranslucency: { value: 0.9 },
    uFresnel: { value: 1.6 },
    uFresnelPower: { value: 2.2 },
    uLipGlow: { value: 1.8 },
    uLipWidth: { value: 0.45 },
    uLipPower: { value: 1.6 },
    uGrain: { value: 0.4 },
    uGrainScale: { value: 4.5 },
    uGlint: { value: 1.3 },
    uGlintScale: { value: 26 },
    uGlintSpeed: { value: 0.5 },
    uGlow: { value: 1.25 },
    uBirthGlow: { value: 2.6 },
    uBirthPower: { value: 6 }
  };

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aSeed;
         attribute float aBirth;
         uniform float uCurl;
         uniform float uCurlDelay;
         uniform float uCurlSpread;
         uniform float uCurlHinge;
         uniform vec2  uCurlDir;
         varying vec3  vSheetLocal;
         varying vec3  vSheetWorld;
         varying float vSheetSeed;
         varying float vSheetBirth;
         varying float vSheetRoll;
         varying float vSheetPeel;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vSheetSeed  = aSeed;
         vSheetBirth = aBirth;

         // GrowthField's birth flash, read backwards, is the only per-instance
         // stopwatch the field publishes: 0 the instant this plate locked,
         // 1 once its curl clock has run out. See the module header.
         float locked = 1.0 - aBirth;
         float peel = smoothstep(uCurlDelay, 1.0, locked);
         vSheetPeel = peel;

         // The plan of the plate is authored around its own axes and the wind
         // is a world direction, so the wind has to come back into object
         // space or a yawed plate peels sideways. Columns 0 and 2 of the
         // instance matrix are the instance's own X and Z in world; flattened
         // and normalised they are its yaw, scale removed.
         vec2 wind = uCurlDir;
         #ifdef USE_INSTANCING
           vec2 ex = vec2(instanceMatrix[0].x, instanceMatrix[0].z);
           vec2 ez = vec2(instanceMatrix[2].x, instanceMatrix[2].z);
           ex = length(ex) > 1e-5 ? normalize(ex) : vec2(1.0, 0.0);
           ez = length(ez) > 1e-5 ? normalize(ez) : vec2(0.0, 1.0);
           wind = vec2(dot(uCurlDir, ex), dot(uCurlDir, ez));
         #endif
         float windLen = length(wind);
         wind = windLen > 1e-5 ? wind / windLen : vec2(0.0, 1.0);

         // ...plus a small per-plate bearing jitter, because a field that peels
         // on exactly one bearing reads as combed rather than as frozen.
         float bearing = (aSeed - 5.0) * uCurlSpread * 0.2;
         float cb = cos(bearing);
         float sb = sin(bearing);
         wind = vec2(wind.x * cb - wind.y * sb, wind.x * sb + wind.y * cb);

         // Constant-curvature roll about the hinge line. Everything upwind of
         // the hinge is left alone; downwind of it the sheet wraps onto a
         // cylinder whose radius shrinks as the plate peels.
         float along = dot(transformed.xz, wind);
         float reach = max(0.5 - uCurlHinge, 0.05);
         float rollT = clamp(max(0.0, along - uCurlHinge) / reach, 0.0, 1.0);
         vSheetRoll = rollT * peel;

         float bend = uCurl * peel;
         if (bend > 1.0e-3) {
           float radius = reach / bend;
           // The sheet has thickness, and a roll tighter than the sheet is
           // thick turns it inside out.
           float body = min(transformed.y, radius * 0.85);
           float theta = bend * rollT;
           vec2 perp = vec2(-wind.y, wind.x);
           float across = dot(transformed.xz, perp);
           float lifted = radius - (radius - body) * cos(theta);
           float slid = uCurlHinge + (radius - body) * sin(theta);
           transformed.xz = wind * slid + perp * across;
           transformed.y = lifted;
         }

         vSheetLocal = transformed;
         #ifdef USE_INSTANCING
           vSheetWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
         #else
           vSheetWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
         #endif`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform vec3  uColorSheet;
         uniform vec3  uColorDeep;
         uniform vec3  uColorLip;
         uniform vec3  uColorGlow;
         uniform vec3  uColorSublime;
         uniform float uDepthTint;
         uniform float uDepthPower;
         uniform float uTranslucency;
         uniform float uFresnel;
         uniform float uFresnelPower;
         uniform float uLipGlow;
         uniform float uLipWidth;
         uniform float uLipPower;
         uniform float uGrain;
         uniform float uGrainScale;
         uniform float uGlint;
         uniform float uGlintScale;
         uniform float uGlintSpeed;
         uniform float uGlow;
         uniform float uBirthGlow;
         uniform float uBirthPower;
         uniform vec3  uSublimeOrigin;
         uniform vec3  uSublimeDir;
         uniform float uSublimeFront;
         uniform float uSublimeEdge;
         uniform float uSublimeGlow;
         varying vec3  vSheetLocal;
         varying vec3  vSheetWorld;
         varying float vSheetSeed;
         varying float vSheetBirth;
         varying float vSheetRoll;
         varying float vSheetPeel;
         ${noiseGLSL}`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           vec3  N   = normalize(normal);
           float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);

           // A sheet, not a solid: face-on the ray crosses the thickness and
           // almost nothing absorbs; edge-on it runs the length of the plate.
           // This is the inverted term the module header is about.
           float depth = clamp(pow(1.0 - ndv, uDepthPower) * uDepthTint, 0.0, 1.0);
           float fres = pow(1.0 - ndv, uFresnelPower) * uFresnel;

           vec3 body = mix(uColorSheet, uColorDeep, depth);

           // The lip: the outer band of the roll, and only once the plate has
           // actually peeled. A flat plate has no lip and must not glow.
           float lip = pow(smoothstep(1.0 - uLipWidth, 1.0, vSheetRoll), uLipPower) * vSheetPeel;
           body = mix(body, uColorLip, clamp(lip * 0.8, 0.0, 1.0));

           // Rime grain in *world* space, so two plates that interlock look
           // frozen out of the same film rather than each carrying its own
           // private pattern. Local space was tried and every plate wore an
           // identical bullseye, which is the giveaway of an instanced field.
           float grain = fbm3(vSheetWorld * uGrainScale + vSheetSeed * 3.7) * 0.5 + 0.5;
           float frost = smoothstep(0.52, 1.0, grain);
           body = mix(body, uColorLip, frost * uGrain);

           // Pinpoint glints, scrolling slowly in world space.
           float glint = snoise(vSheetWorld * uGlintScale +
                                vec3(0.0, uTime * uGlintSpeed, 0.0) + vSheetSeed * 17.0);
           glint = pow(clamp(glint, 0.0, 1.0), 12.0);

           // The sublimation front, in metres downrange of the caster. Below
           // the front the plate has gone; the transition band is where the ice
           // is actually turning to vapour, so that is where it is brightest.
           float reach = dot(vSheetWorld - uSublimeOrigin, uSublimeDir);
           float gone = 1.0 - smoothstep(uSublimeFront - uSublimeEdge,
                                         uSublimeFront + uSublimeEdge, reach);
           float band = clamp(gone * (1.0 - gone) * 4.0, 0.0, 1.0);

           vec3 glow = uColorGlow * lip * uLipGlow;
           glow += uColorLip * fres * 0.45;
           glow += uColorGlow * frost * uTranslucency * 0.5;
           glow += uColorLip * glint * uGlint;
           glow += uColorGlow * pow(clamp(vSheetBirth, 0.0, 1.0), uBirthPower) * uBirthGlow;
           glow += uColorSublime * band * uSublimeGlow;
           glow *= uGlow;

           // The same Reinhard ceiling the crystals use: every term above peaks
           // at a grazing angle, so without it a plate on the silhouette sums
           // past 5x white and the bloom pass smears the whole corridor.
           glow /= 1.0 + glow * 0.22;

           diffuseColor.rgb *= body;
           totalEmissiveRadiance += glow;

           // Thin face-on so the plate behind shows through, denser along the
           // roll and at the lip where there is genuinely more ice in the way.
           diffuseColor.a = clamp(diffuseColor.a * (0.4 + 0.6 * clamp(depth + lip, 0.0, 1.0)), 0.0, 1.0);
           diffuseColor.a *= 1.0 - gone;
         }`
      );
  });

  material.userData.uniforms = uniforms;

  /** Pull the palette and every shading control from the live settings. */
  material.userData.sync = () => {
    const c = settings.rime;
    const g = settings.global;

    uniforms.uColorSheet.value.copy(getColor(c.colorSheet));
    uniforms.uColorDeep.value.copy(getColor(c.colorDeep));
    uniforms.uColorLip.value.copy(getColor(c.colorLip));
    uniforms.uColorGlow.value.copy(getColor(c.colorGlow));
    uniforms.uColorSublime.value.copy(getColor(c.colorSublime));

    uniforms.uCurl.value = c.curl;
    uniforms.uCurlDelay.value = Math.min(0.95, c.curlDelay);
    uniforms.uCurlSpread.value = c.curlSpread * g.randomness;
    uniforms.uCurlHinge.value = c.curlHinge;

    uniforms.uDepthTint.value = c.depthTint;
    uniforms.uDepthPower.value = c.depthPower;
    uniforms.uTranslucency.value = c.translucency;
    uniforms.uFresnel.value = c.fresnel * g.fresnel;
    uniforms.uFresnelPower.value = c.fresnelPower;
    uniforms.uLipGlow.value = c.lipGlow;
    uniforms.uLipWidth.value = Math.min(0.99, c.lipWidth);
    uniforms.uLipPower.value = c.lipPower;
    uniforms.uGrain.value = c.grain * g.shaderIntensity;
    uniforms.uGrainScale.value = c.grainScale * g.noiseFrequency;
    uniforms.uGlint.value = c.glint * g.shaderIntensity;
    uniforms.uGlintScale.value = c.glintScale;
    uniforms.uGlintSpeed.value = c.glintSpeed * g.noiseSpeed;
    uniforms.uGlow.value = c.glow * g.glow;
    uniforms.uBirthGlow.value = c.birthGlow;
    uniforms.uBirthPower.value = Math.max(0.5, c.birthPower);
    uniforms.uSublimeEdge.value = Math.max(0.02, c.sublimeEdge);
    uniforms.uSublimeGlow.value = c.sublimeGlow;

    material.opacity = c.opacity * g.opacity;
    material.roughness = c.roughness;
    material.envMapIntensity = c.envIntensity;
  };

  material.userData.sync();
  return material;
}
