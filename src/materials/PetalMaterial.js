import { MeshStandardMaterial, Color, Vector4, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Procedurally shaded, procedurally **posed** flowers — the material behind
 * Bloomburst.
 *
 * This is the one place in the project where the vertex shader does more than
 * place a ribbon: it *builds the pose*. Every petal on every flower is stored
 * once, unbent, as four numbers per vertex — how far along the blade it is,
 * how far across, which bearing its blade leaves the heart on, and a per-blade
 * dice roll — and the shader bends it from a closed bud to a fully open flower
 * on a per-instance clock. Nothing about the pose is on the CPU, which is why
 * dragging `unfurlCurve` re-opens a field of flowers that is already standing,
 * with the clock stopped.
 *
 * ## Why the pose has to live here
 *
 * The obvious first attempt was to bake the bend into the geometry and let
 * `GrowthField` scale it. That cannot work: the bend is a *function of time,
 * per instance*, and `GrowthField` owns one geometry per variant shared by
 * every instance of it. Baking the bend would give the whole field one pose.
 *
 * The second attempt bent the blade as a circular arc of total turn `theta`,
 * which is the textbook answer and looks wrong: constant curvature gives every
 * petal the same shape at every stage of opening, so the flower reads as a
 * paper fan being spread rather than as a bud splitting. A real petal is nearly
 * straight at the base and does almost all of its turning in the outer third.
 * So the centreline is a **quadratic Bezier in the (radial, up) plane** whose
 * two free control points are simply lerped from the bud pose to the open
 * pose. Four sliders per pose, they are readable on a panel, and the shape of
 * the interpolation — which is the whole character of the unfurl — is one more
 * slider on top, `unfurlCurve`.
 *
 * ## Where the clock comes from
 *
 * `aBirth`, the per-instance value `GrowthField` already writes, counts 1 → 0
 * over its `birthFade` seconds from the moment that instance was triggered.
 * Bloomburst hands `birthFade` its `unfurlTime`, so `1 - aBirth` is exactly
 * "how far open is this flower", staggered per instance by the field's own
 * eruption wave and re-derived every frame from a live slider. No second
 * attribute, no second clock, and it is live on a paused frame because
 * `GrowthField` rewrites `aBirth` from `birthFade` on every call to `update()`.
 *
 * ## Shading
 *
 * Built on `MeshStandardMaterial` for the same reason `IceMaterial` is: the
 * flowers take the stage's real shadows and its HDR probe, and the stylisation
 * is injected on top — a base-to-tip gradient, a radiating vein fan off the
 * midrib, a fibrous world-space grain so two petals are not the same flat
 * wash, a backlit translucency term (a petal is thin, and the read of a flower
 * in a low sun is the light coming *through* it), and a heart glow that the
 * pollen volume sits on.
 *
 * `flatShading` is on, so there is no `vNormal` varying and every
 * view-dependent term reads the face normal that `<normal_fragment_begin>`
 * derives from screen derivatives. That is also what makes the vertex-shader
 * pose work at all: a deformed mesh gets correct normals for free, which it
 * would not if the normals had been transformed from the unbent attribute.
 *
 * Per-instance inputs arrive as instanced attributes (`aSeed`, `aBirth`), so
 * this material is only ever used on an `InstancedMesh`.
 */
export function createPetalMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.62,
    metalness: 0.0,
    flatShading: true,
    transparent: true,
    // A petal has no back: you see the underside of the far ones through the
    // gap between the near ones, and culling them leaves a flower that is
    // hollow from every angle except dead on.
    side: DoubleSide,
    depthWrite: true
  });

  const uniforms = {
    // No clock. Every other patched material in the project carries `uTime`,
    // and this one deliberately does not: a flower's whole animation is its
    // pose, which is driven per instance off `aBirth`, and a global time-based
    // shimmer on top of that turns a still field into a shivering one. If you
    // add one, add it as a slider first.
    uLightDir: frame.uLightDir,

    /* --- the stalk and the heart, in the flower's own unit space --- */
    uStemTop: { value: 0.42 }, // fraction of the flower's height the stalk occupies
    uStemRadius: { value: 0.045 }, // stalk radius at the floor
    uHeartRadius: { value: 0.085 }, // radius the petals are hinged on

    /* --- the blade --- */
    uWidth: { value: 0.3 }, // half-width at the widest point
    uWidthBias: { value: 0.78 }, // <1 pushes the widest point toward the base
    uTaper: { value: 0.72 }, // >1 sharpens the tip, <1 rounds it
    uCrease: { value: 0.42 }, // the lengthwise fold, as a fraction of the half-width
    uCup: { value: 0.34 }, // cross-sectional curl, same units

    /* --- the two poses the unfurl runs between --- */
    // (mid.radial, mid.up, tip.radial, tip.up) — Bezier control points in the
    // blade's own (radial, up) plane, in units of the flower's height.
    uBud: { value: new Vector4(0.02, 0.34, 0.06, 0.68) },
    uOpen: { value: new Vector4(0.3, 0.42, 0.62, 0.16) },
    uUnfurlCurve: { value: 1.5 },
    uPetalStagger: { value: 0.28 },
    // 0..1 of the birth ramp spent still climbing out of the floor, before the
    // bud is allowed to start opening. See the note in the vertex stage.
    uOpenDelay: { value: 0.35 },

    /* --- the release --- */
    uRelease: { value: 0 }, // 0..1, driven by the phase clock, not a slider
    uThrow: { value: 0.9 }, // radial metres-of-unit-height a freed petal travels
    uLift: { value: 0.55 },
    uSpin: { value: 1.35 }, // radians it tumbles about its own hinge
    uShrink: { value: 0.85 }, // how far it closes to nothing on the way out
    uWilt: { value: 0.65 }, // how far the stalk folds once the petals have gone

    /* --- colour --- */
    uColorStem: { value: new Color() },
    uColorBase: { value: new Color() },
    uColorMid: { value: new Color() },
    uColorTip: { value: new Color() },
    uColorVein: { value: new Color() },
    uColorHeart: { value: new Color() },

    uVeins: { value: 0.55 },
    uVeinCount: { value: 5 },
    uGrain: { value: 0.22 },
    uGrainScale: { value: 7.5 },
    uFresnel: { value: 1.1 },
    uFresnelPower: { value: 2.6 },
    uTranslucency: { value: 1.8 },
    uTranslucencyPower: { value: 4.0 },
    uGlow: { value: 1.0 },
    uEdgeGlow: { value: 0.7 },
    uHeartGlow: { value: 2.4 },
    uBirthGlow: { value: 1.6 }
  };

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec4  aPetal;   // (along 0..1, across -1..1, blade bearing, blade dice)
         attribute float aPart;    // 0 = stalk, 1 = petal
         attribute float aSeed;    // per instance
         attribute float aBirth;   // per instance, 1 -> 0 over the unfurl
         uniform float uStemTop;
         uniform float uStemRadius;
         uniform float uHeartRadius;
         uniform float uWidth;
         uniform float uWidthBias;
         uniform float uTaper;
         uniform float uCrease;
         uniform float uCup;
         uniform vec4  uBud;
         uniform vec4  uOpen;
         uniform float uUnfurlCurve;
         uniform float uPetalStagger;
         uniform float uOpenDelay;
         uniform float uRelease;
         uniform float uThrow;
         uniform float uLift;
         uniform float uSpin;
         uniform float uShrink;
         uniform float uWilt;
         varying float vPart;
         varying float vAlong;
         varying float vAcross;
         varying float vBloom;
         varying float vBirth;
         varying float vFlowerSeed;
         varying vec3  vPetalWorld;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           float along  = aPetal.x;
           float across = aPetal.y;
           float bearing = aPetal.z;
           float dice   = aPetal.w;

           // The unfurl clock. GrowthField counts aBirth from 1 down to 0 over
           // its birthFade seconds, and this ability hands birthFade the sum of
           // its rise and its unfurl, so 1 - aBirth is a per-instance ramp
           // across both — re-resolved on every call to the field's update(),
           // a zero-length one included.
           //
           // uOpenDelay is the share of that ramp the stalk is still climbing
           // for. Without it a bud starts splitting while it is half buried,
           // which loses the whole first beat: the read of this ability is
           // stalks, THEN flowers, and if they overlap you only ever see
           // flowers.
           float bloom = clamp(1.0 - aBirth, 0.0, 1.0);
           float delay = clamp(uOpenDelay, 0.0, 0.95);
           bloom = clamp((bloom - delay) / max(1e-3, 1.0 - delay), 0.0, 1.0);
           // ...and a small ripple inside each flower, so the petals do not all
           // let go on the identical frame. Without it a six-petal flower opens
           // like an umbrella; with it, it opens like a flower.
           float stagger = clamp(uPetalStagger, 0.0, 0.9);
           bloom = clamp((bloom - dice * stagger) / max(1e-3, 1.0 - stagger), 0.0, 1.0);
           bloom = pow(bloom, max(0.05, uUnfurlCurve));

           vPart = aPart;
           vAlong = along;
           vAcross = across;
           vBloom = bloom;
           vBirth = aBirth;
           vFlowerSeed = aSeed;

           vec3 outward = vec3(cos(bearing), 0.0, sin(bearing));
           vec3 lateral = vec3(-sin(bearing), 0.0, cos(bearing));

           if (aPart < 0.5) {
             // The stalk. Stored as a unit prism and given its real proportions
             // here, so stem height and thickness stay live sliders that need no
             // geometry rebuild. aPetal.y carries a 0..1 radial scale, which is
             // how the cap fan gets its centre vertex.
             float grip = mix(uStemRadius, uHeartRadius, along) * across;
             float wilt = 1.0 - uWilt * uRelease;
             transformed = outward * grip * wilt + vec3(0.0, uStemTop * along * wilt, 0.0);
           } else {
             // The centreline, as a quadratic Bezier from the hinge on the rim
             // of the heart out to the tip. Both free control points lerp from
             // the bud pose to the open pose; that lerp is the whole unfurl.
             vec2 hinge = vec2(uHeartRadius, 0.0);
             vec2 mid   = mix(uBud.xy, uOpen.xy, bloom);
             vec2 tip   = mix(uBud.zw, uOpen.zw, bloom);

             float s  = along;
             float ms = 1.0 - s;
             vec2 centre = ms * ms * hinge + 2.0 * ms * s * mid + s * s * tip;
             vec2 slope  = 2.0 * ms * (mid - hinge) + 2.0 * s * (tip - mid);

             vec2 tangentPlane = normalize(slope + vec2(1e-5, 1e-5));
             // In-plane normal. For a blade standing up this comes out pointing
             // radially outward, which is the face of the petal.
             vec2 facePlane = vec2(tangentPlane.y, -tangentPlane.x);

             // Half-width along the blade. A sine raised to a power: zero at the
             // hinge, widest a little past the middle, and rounded or pointed at
             // the tip depending on uTaper. Evaluated here rather than baked so
             // both controls stay live.
             float halfWidth = uWidth *
               pow(max(sin(3.14159265 * pow(clamp(along, 0.0, 1.0), uWidthBias)), 0.0), uTaper);
             halfWidth *= 1.0 - uShrink * uRelease;

             // The lengthwise crease is a tent fold about the midrib; the cup is
             // the cross-section curling toward the axis. Two separate marks:
             // the crease is what catches the key light down the middle of the
             // blade, the cup is what makes the flower hold water.
             float fold = uCrease * halfWidth * (1.0 - abs(across));
             float curl = -uCup * halfWidth * (1.0 - across * across);
             vec2 planar = centre + facePlane * (fold + curl);

             // The release: every petal in the field lets go on the same frame,
             // tumbling about its own hinge and thrown outward and up.
             if (uRelease > 0.0) {
               float turn = uSpin * uRelease * (0.35 + dice);
               vec2 arm = planar - hinge;
               float cs = cos(turn);
               float sn = sin(turn);
               planar = hinge + vec2(arm.x * cs - arm.y * sn, arm.x * sn + arm.y * cs);
               planar += vec2(uThrow, uLift) * uRelease * (0.55 + 0.9 * dice);
             }

             transformed = outward * planar.x
                         + lateral * (across * halfWidth)
                         + vec3(0.0, uStemTop + planar.y, 0.0);
           }

           #ifdef USE_INSTANCING
             vPetalWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
           #else
             vPetalWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
           #endif
         }`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform vec3  uLightDir;
         uniform vec3  uColorStem;
         uniform vec3  uColorBase;
         uniform vec3  uColorMid;
         uniform vec3  uColorTip;
         uniform vec3  uColorVein;
         uniform vec3  uColorHeart;
         uniform float uVeins;
         uniform float uVeinCount;
         uniform float uGrain;
         uniform float uGrainScale;
         uniform float uFresnel;
         uniform float uFresnelPower;
         uniform float uTranslucency;
         uniform float uTranslucencyPower;
         uniform float uGlow;
         uniform float uEdgeGlow;
         uniform float uHeartGlow;
         uniform float uBirthGlow;
         uniform float uRelease;
         varying float vPart;
         varying float vAlong;
         varying float vAcross;
         varying float vBloom;
         varying float vBirth;
         varying float vFlowerSeed;
         varying vec3  vPetalWorld;
         ${noiseGLSL}`
      )
      // Injected once the normal is resolved: with flatShading there is no
      // vNormal varying, so every view-dependent term below has to read the
      // face normal that <normal_fragment_begin> derives from derivatives.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           vec3  N   = normalize(normal);
           vec3  V   = normalize(vViewPosition);
           float ndv = clamp(dot(N, V), 0.0, 1.0);
           float rim = pow(1.0 - ndv, uFresnelPower);

           vec3 body;
           float emissiveMask = 0.0;

           if (vPart < 0.5) {
             body = uColorStem;
             // A little sap-green variation up the stalk so a field of forty
             // does not read as forty copies of one extruded tube.
             body *= 0.86 + 0.28 * fbm3(vPetalWorld * 3.1 + vFlowerSeed * 9.0);
           } else {
             body = mix(uColorBase, uColorMid, smoothstep(0.0, 0.55, vAlong));
             body = mix(body, uColorTip, smoothstep(0.42, 1.0, vAlong));

             // Veins. The midrib is a hard ridge at across = 0; the fan is a
             // set of ribs running out from it, swept back along the blade.
             // The first version drew the fan as cos(across * n) alone, which
             // gives ribs parallel to the midrib all the way to the tip — a
             // corduroy petal. Sweeping the phase with vAlong is what makes
             // them converge on the hinge the way a real vein pattern does.
             float across = abs(vAcross);
             float midrib = pow(1.0 - across, 7.0);
             float fan = cos(vAcross * uVeinCount * 3.14159265 - vAlong * 2.6);
             float vein = midrib + 0.4 * smoothstep(0.72, 1.0, abs(fan)) * (1.0 - across);
             body = mix(body, uColorVein, clamp(vein * uVeins, 0.0, 1.0));

             // A fibrous grain in world space, so neighbouring petals look cut
             // from the same tissue rather than each carrying its own pattern.
             body *= 1.0 + uGrain * (fbm3(vPetalWorld * uGrainScale + vFlowerSeed * 13.0) - 0.5);

             // The heart. Bright, tight to the hinge, and the thing the pollen
             // volume is anchored on visually.
             emissiveMask = smoothstep(0.24, 0.0, vAlong) * vBloom;
           }

           diffuseColor.rgb *= body;

           // Backlit translucency. A petal is two cells thick and the read of a
           // flower in a low sun is entirely the light coming through it, not
           // the light bouncing off it — so this term is deliberately stronger
           // than the diffuse response it sits on top of.
           float through = pow(clamp(dot(V, -uLightDir), 0.0, 1.0), uTranslucencyPower);
           float thin = step(0.5, vPart) * (0.35 + 0.65 * smoothstep(0.1, 0.9, vAlong));

           vec3 glow = uColorTip * through * thin * uTranslucency;
           glow += uColorVein * rim * uFresnel * uEdgeGlow;
           glow += uColorHeart * emissiveMask * uHeartGlow;
           glow += uColorHeart * vBirth * uBirthGlow * step(0.5, vPart);
           glow *= uGlow;

           // Soft ceiling, as on the ice: every term above peaks at a grazing
           // angle and they stack, and without this a petal on the silhouette
           // sums past 4x white and the bloom pass smears the whole field.
           glow /= 1.0 + glow * 0.3;

           totalEmissiveRadiance += glow;

           // Petals thin out as they are thrown; the stalk does not.
           float shed = step(0.5, vPart) * uRelease;
           diffuseColor.a = clamp(diffuseColor.a * (1.0 - shed * shed), 0.0, 1.0);
         }`
      );
  });

  material.userData.uniforms = uniforms;

  /**
   * Pull the pose, the palette and every shading control from live settings.
   *
   * @param {number} release 0..1 phase value — how far the petals have let go.
   *        Not a slider: it is the fade clock, and the only argument here that
   *        does not come out of `settings.bloomburst`.
   */
  material.userData.sync = (release = 0) => {
    const c = settings.bloomburst;
    const g = settings.global;

    uniforms.uStemTop.value = c.stemFrac;
    uniforms.uStemRadius.value = c.stemRadius;
    uniforms.uHeartRadius.value = c.heartRadius;

    uniforms.uWidth.value = c.petalWidth;
    uniforms.uWidthBias.value = c.petalWidthBias;
    uniforms.uTaper.value = c.petalTaper;
    uniforms.uCrease.value = c.petalCrease;
    uniforms.uCup.value = c.petalCup;

    uniforms.uBud.value.set(c.budMidOut, c.budMidUp, c.budTipOut, c.budTipUp);
    uniforms.uOpen.value.set(c.openMidOut, c.openMidUp, c.openTipOut, c.openTipUp);
    uniforms.uUnfurlCurve.value = c.unfurlCurve;
    uniforms.uPetalStagger.value = c.petalStagger;
    // The split of the field's birth ramp between climbing and opening. It has
    // to be derived rather than authored, because the ramp `GrowthField` writes
    // is exactly `riseTime + unfurlTime` long — see `_fillGrowth`.
    uniforms.uOpenDelay.value = c.riseTime / Math.max(1e-3, c.riseTime + c.unfurlTime);

    uniforms.uRelease.value = release;
    uniforms.uThrow.value = c.releaseThrow;
    uniforms.uLift.value = c.releaseLift;
    uniforms.uSpin.value = c.releaseSpin;
    uniforms.uShrink.value = c.releaseShrink;
    uniforms.uWilt.value = c.stemWilt;

    uniforms.uColorStem.value.copy(getColor(c.colorStem));
    uniforms.uColorBase.value.copy(getColor(c.colorPetalBase));
    uniforms.uColorMid.value.copy(getColor(c.colorPetalMid));
    uniforms.uColorTip.value.copy(getColor(c.colorPetalTip));
    uniforms.uColorVein.value.copy(getColor(c.colorVein));
    uniforms.uColorHeart.value.copy(getColor(c.colorHeart));

    uniforms.uVeins.value = c.veins * g.shaderIntensity;
    uniforms.uVeinCount.value = c.veinCount;
    uniforms.uGrain.value = c.grain * g.shaderIntensity;
    uniforms.uGrainScale.value = c.grainScale * g.noiseFrequency;
    uniforms.uFresnel.value = c.fresnel * g.fresnel;
    uniforms.uFresnelPower.value = c.fresnelPower;
    uniforms.uTranslucency.value = c.translucency;
    uniforms.uTranslucencyPower.value = c.translucencyPower;
    uniforms.uGlow.value = c.petalGlow * g.glow;
    uniforms.uEdgeGlow.value = c.edgeGlow;
    uniforms.uHeartGlow.value = c.heartGlow;
    uniforms.uBirthGlow.value = c.birthGlow;

    material.opacity = c.petalOpacity * g.opacity;
    material.roughness = c.petalRoughness;
    material.envMapIntensity = c.envIntensity;
  };

  material.userData.sync(0);
  return material;
}
