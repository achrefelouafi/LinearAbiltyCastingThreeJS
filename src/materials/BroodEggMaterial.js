import { MeshStandardMaterial, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * A brood egg: a two-piece chitin shell that inflates, thins, and splits.
 *
 * This runs on a `GrowthField` whose geometry factory hands it an ovoid built
 * as **two separate half-shells** that share a torn seam line — see
 * `abilities/hive/BroodburstAbility.js#createEggGeometry`. Everything below is
 * one pose function over that buffer, evaluated per vertex, driven entirely by
 * per-instance values.
 *
 * ### The clock is `aBirth`, and there is no other one
 *
 * `GrowthField` writes `aBirth` per instance, counting 1 → 0 over its live
 * `birthFade` seconds. Broodburst hands `birthFade` the sum of its rise, its
 * swell and its split, so `1 - aBirth` is a **per-egg ramp across the whole
 * hatch**, re-resolved by the field on every `update()` including a zero-length
 * one. Every beat here is a threshold on that one number: `uSwellAt` is where
 * inflation begins, `uSplitAt` where the seam gives, `uHuskAt` where what is
 * left of the shell stops being there.
 *
 * There is deliberately **no `uTime`**. A clutch of forty eggs must not throb in
 * unison — that is the single thing that would give away that they are
 * instances of one mesh — so the throb's phase comes from `aSeed` and its clock
 * from the egg's own ramp. The first version drove the throb off `frame.uTime`
 * and the whole clutch pulsed like one lung.
 *
 * ### The split is a rigid rotation of each half, not a displacement
 *
 * Each vertex carries `aShell` = ±1 saying which half-shell it belongs to. The
 * split rotates that half about the **z axis at the base** — the line where the
 * seam plane meets the floor — so the two halves swing apart like doors and
 * nothing about the shell stretches. Pushing vertices apart along the seam
 * normal instead was the first attempt, and it thins the shell into a pair of
 * flat flaps: the rotation keeps the curvature, which is what makes the empty
 * husk still read as having held something.
 *
 * Because the halves are separate blocks in the buffer that only *coincide* on
 * the seam, the closed egg has no visible join at all and the open one has a
 * real torn edge with a lip on it. `aShell.w` — the rim weight — is 1 exactly on
 * that edge and 0 a couple of rings in, which is what the fragment stage
 * thickens and darkens.
 *
 * ### `flatShading`, on purpose
 *
 * The pose is written in the vertex shader, so a normal transformed from the
 * undeformed attribute would be wrong everywhere the shell has swollen or
 * hinged. `flatShading` derives the normal from screen-space derivatives of the
 * *final* position, which is correct by construction — the same argument
 * `PetalMaterial` makes. The faceting it costs is a gain here rather than a
 * loss: a smooth egg reads as a snooker ball, and chitin is plated.
 *
 * ### The surface is authored in shell coordinates
 *
 * `aShell.yz` is `(cos θ, sin θ)` of the vertex's bearing round the egg, not θ
 * itself, for the reason `VineBarkMaterial` gives at length: a raw angle wraps
 * from 1 back to 0 across one quad and every egg gets a bright seam down a side
 * that has nothing to do with the real seam. The pair interpolates without a
 * discontinuity and the veins hold still while the shell inflates, because they
 * are indexed by a material coordinate rather than by a position.
 *
 * Uniform boxes are parked on `material.userData.uniforms` — the convention the
 * harness's pause test looks for. Without it forty working sliders report dead.
 */
export function createBroodEggMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.48,
    metalness: 0.0,
    flatShading: true,
    transparent: true,
    // Both sides. Once the seam gives you are looking straight into the shell,
    // and the inside of the far half is most of what the gape is *for*.
    side: DoubleSide,
    depthWrite: true
  });

  const uniforms = {
    uLightDir: frame.uLightDir,

    /* --- the swell --- */
    uSwellAt: { value: 0.08 }, // 0..1 of the ramp where inflation starts
    uSplitAt: { value: 0.62 }, // 0..1 of the ramp where the seam gives
    uSplitSpan: { value: 0.22 }, // 0..1 of the ramp the seam takes to open
    uHuskAt: { value: 0.9 }, // 0..1 of the ramp where the husk stops being there
    uSwell: { value: 0.42 }, // fraction the shell inflates by
    uSwellCurve: { value: 1.8 }, // >1 holds it small then goes late
    uBulge: { value: 0.3 }, // extra width at the egg's waist
    uStretch: { value: 0.24 }, // extra height, as a fraction of the swell
    uThrob: { value: 0.055 }, // fraction of a per-egg pulse on top
    uThrobRate: { value: 7.0 }, // pulses across the whole ramp

    /* --- the split --- */
    uGape: { value: 1.25 }, // radians each half swings through
    uGapeSlide: { value: 0.12 }, // unit-space metres the halves also slide apart
    uGapeLift: { value: 0.06 }, // unit-space metres the husk lifts as it opens
    uGapeCurve: { value: 0.6 }, // <1 snaps open then eases

    /* --- the shell --- */
    uVeins: { value: 0.85 }, // strength of the vein network
    uVeinScale: { value: 5.5 }, // features around the shell
    uVeinBands: { value: 2.6 }, // features up the shell
    uVeinSharp: { value: 0.62 }, // 0 soft mottle, 1 hard filaments
    uMottle: { value: 0.35 }, // broad blotching under the veins
    uMottleScale: { value: 2.2 },
    uRimWidth: { value: 0.55 }, // how far in from the torn edge the lip reaches
    uRimDark: { value: 0.7 }, // how much darker that lip is
    uRimGlow: { value: 1.6 }, // and how hot it is once the seam has given
    uFresnel: { value: 1.2 },
    uFresnelPower: { value: 2.4 },
    uThin: { value: 2.2 }, // how much light the stretched shell passes
    uThinPower: { value: 3.0 },
    uBroodGlow: { value: 2.6 }, // the thing inside, showing through
    uBroodRise: { value: 1.7 }, // >1 keeps it hidden until the shell is tight
    uInteriorGlow: { value: 0.9 }, // the wet inside of an opened husk
    uGlow: { value: 1.0 }, // master multiplier
    uHuskFade: { value: 1.0 }, // 0..1 master alpha, driven by the fade phase

    /* --- colour, none derived from another --- */
    uColorShell: { value: new Color() },
    uColorBelly: { value: new Color() },
    uColorVein: { value: new Color() },
    uColorBrood: { value: new Color() },
    uColorRim: { value: new Color() },
    uColorInterior: { value: new Color() }
  };

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec4  aShell;   // (v 0..1 up the egg, cos bearing, sin bearing, rim weight)
         attribute float aSide;    // +1 / -1 — which half-shell this vertex belongs to
         attribute float aSeed;    // per instance, 0..10
         attribute float aBirth;   // per instance, 1 -> 0 across the whole hatch
         uniform float uSwellAt;
         uniform float uSplitAt;
         uniform float uSplitSpan;
         uniform float uHuskAt;
         uniform float uSwell;
         uniform float uSwellCurve;
         uniform float uBulge;
         uniform float uStretch;
         uniform float uThrob;
         uniform float uThrobRate;
         uniform float uGape;
         uniform float uGapeSlide;
         uniform float uGapeLift;
         uniform float uGapeCurve;
         varying vec4  vShell;
         varying float vHatch;   // 0..1 across the whole ramp
         varying float vSwellT;  // 0..1 how far the inflation has got
         varying float vSplit;   // 0..1 how far the seam has opened
         varying float vEggSeed;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           float hatch = clamp(1.0 - aBirth, 0.0, 1.0);
           float dice  = fract(aSeed * 0.6180339887 + 0.137);

           float swellT = clamp((hatch - uSwellAt) / max(uSplitAt - uSwellAt, 0.001), 0.0, 1.0);
           float split  = pow(clamp((hatch - uSplitAt) / max(uSplitSpan, 0.001), 0.0, 1.0),
                              max(uGapeCurve, 0.05));

           // The inflation. Width and height are separate multipliers because an
           // egg under pressure goes fat before it goes long — driving both off
           // one number gave a balloon rather than a sac.
           float grow = pow(swellT, max(uSwellCurve, 0.05));
           float pulse = uThrob * sin((grow * uThrobRate + dice) * PI2) * swellT;
           float waist = 1.0 - abs(aShell.x * 2.0 - 1.0);
           float wide = 1.0 + (uSwell + pulse) * grow * (1.0 + uBulge * waist);
           float tall = 1.0 + (uSwell * uStretch + pulse * 0.4) * grow;

           transformed.xz *= wide;
           transformed.y  *= tall;

           // The seam gives. A rigid rotation of this half about the z axis at
           // the base — the line where the seam plane meets the floor — so the
           // shell keeps every bit of its curvature on the way open.
           float a = -aSide * uGape * split;
           float ca = cos(a);
           float sa = sin(a);
           transformed.xy = vec2(transformed.x * ca - transformed.y * sa,
                                 transformed.x * sa + transformed.y * ca);
           transformed.x += aSide * uGapeSlide * split;
           transformed.y += uGapeLift * split;

           vShell   = aShell;
           vHatch   = hatch;
           vSwellT  = swellT;
           vSplit   = split;
           vEggSeed = aSeed;
         }`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform vec3  uLightDir;
         uniform float uHuskAt;
         uniform float uVeins;
         uniform float uVeinScale;
         uniform float uVeinBands;
         uniform float uVeinSharp;
         uniform float uMottle;
         uniform float uMottleScale;
         uniform float uRimWidth;
         uniform float uRimDark;
         uniform float uRimGlow;
         uniform float uFresnel;
         uniform float uFresnelPower;
         uniform float uThin;
         uniform float uThinPower;
         uniform float uBroodGlow;
         uniform float uBroodRise;
         uniform float uInteriorGlow;
         uniform float uGlow;
         uniform float uHuskFade;
         uniform vec3  uColorShell;
         uniform vec3  uColorBelly;
         uniform vec3  uColorVein;
         uniform vec3  uColorBrood;
         uniform vec3  uColorRim;
         uniform vec3  uColorInterior;
         varying vec4  vShell;
         varying float vHatch;
         varying float vSwellT;
         varying float vSplit;
         varying float vEggSeed;
         ${noiseGLSL}`
      )
      // After <emissivemap_fragment>, where `normal` has been resolved. With
      // flatShading there is no vNormal varying at all, so every view-dependent
      // term below *has* to live here and not one include earlier.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           // Shell coordinates: up the egg, and (cos, sin) round it. Not the
           // world position — the shell inflates, and a world-space field would
           // slide across it while it did.
           vec3 shellCoord = vec3(vShell.yz * uVeinScale, vShell.x * uVeinBands + vEggSeed);

           float vein = ridged(shellCoord, 4);
           vein = smoothstep(0.42 + 0.3 * (1.0 - uVeinSharp), 0.98, vein);
           float mottle = fbm3(vec3(vShell.yz * uMottleScale, vShell.x * uMottleScale + vEggSeed));

           // Belly to crown. A real egg is paler where it sits.
           vec3 body = mix(uColorBelly, uColorShell, clamp(vShell.x, 0.0, 1.0));
           body = mix(body, uColorShell * 0.72, mottle * uMottle);

           // The torn lip. 1 exactly on the seam edge, 0 a couple of rings in.
           float rim = smoothstep(1.0 - clamp(uRimWidth, 0.01, 1.0), 1.0, vShell.w);
           body = mix(body, body * (1.0 - clamp(uRimDark, 0.0, 1.0)), rim);

           float facing = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
           float edge = pow(1.0 - facing, max(uFresnelPower, 0.05));

           // The translucency, and it is the beat that matters. A shell under
           // pressure thins, so light from behind starts coming through it —
           // driven by swellT rather than by a constant, which is what turns
           // "an egg" into "an egg about to go". Written as a wrapped
           // back-light rather than a fresnel rim: a fresnel puts the glow on
           // the silhouette, and a thin shell glows across its whole belly.
           float back = pow(clamp(dot(-normal, uLightDir) * 0.5 + 0.5, 0.0, 1.0),
                            max(uThinPower, 0.05));
           float thin = back * uThin * vSwellT;

           // The brood, showing through. Late, and through the veins, so what
           // you read is a shape moving under a membrane rather than a lamp.
           float showing = pow(vSwellT, max(uBroodRise, 0.05));
           float lumen = showing * (0.35 + 0.65 * vein);

           vec3 glow = uColorVein * vein * uVeins * (0.4 + 0.6 * vSwellT);
           glow += uColorBrood * lumen * uBroodGlow;
           glow += uColorShell * thin;
           glow += uColorShell * edge * uFresnel;
           glow += uColorRim * rim * uRimGlow * vSplit;

           // The inside of an opened husk: wet, dark, and not lit by anything
           // the outside is lit by. gl_FrontFacing is the only handle on it and
           // it is exactly the right one.
           if (!gl_FrontFacing) {
             body = uColorInterior;
             glow = uColorBrood * uInteriorGlow * (0.25 + 0.75 * vSplit);
           }

           diffuseColor.rgb *= body;

           // Soft ceiling, as IceMaterial does: the veins, the brood and the
           // back-light all peak in different places but a swollen egg seen
           // edge-on has all three at once, and without this the sum runs past
           // 4 and bloom turns the clutch into a single white blob.
           glow *= uGlow;
           glow /= 1.0 + glow * 0.28;
           totalEmissiveRadiance += glow;

           // The husk goes last, not first: it has to still be catching light
           // while it dissolves, or the shell reads as fading out rather than
           // as being left behind.
           float husk = 1.0 - smoothstep(clamp(uHuskAt, 0.0, 0.999), 1.0, vHatch);
           diffuseColor.a *= husk * clamp(uHuskFade, 0.0, 1.0);
         }`
      );
  });

  material.userData.uniforms = uniforms;

  /**
   * Pull the palette and every shading control from the live settings.
   *
   * @param {number} fade 1 while the clutch stands, ramping to 0 as it dies
   */
  material.userData.sync = (fade) => {
    const c = settings.broodburst;
    const g = settings.global;

    uniforms.uSwellAt.value = c.swellAt;
    uniforms.uSplitAt.value = c.splitAt;
    uniforms.uSplitSpan.value = c.splitSpan;
    uniforms.uHuskAt.value = c.huskAt;
    uniforms.uSwell.value = c.swell;
    uniforms.uSwellCurve.value = c.swellCurve;
    uniforms.uBulge.value = c.bulge;
    uniforms.uStretch.value = c.stretch;
    uniforms.uThrob.value = c.throb;
    uniforms.uThrobRate.value = c.throbRate;

    uniforms.uGape.value = c.gape;
    uniforms.uGapeSlide.value = c.gapeSlide;
    uniforms.uGapeLift.value = c.gapeLift;
    uniforms.uGapeCurve.value = c.gapeCurve;

    uniforms.uVeins.value = c.veins * g.shaderIntensity;
    uniforms.uVeinScale.value = c.veinScale * g.noiseFrequency;
    uniforms.uVeinBands.value = c.veinBands * g.noiseFrequency;
    uniforms.uVeinSharp.value = c.veinSharp;
    uniforms.uMottle.value = c.mottle * g.noiseStrength;
    uniforms.uMottleScale.value = c.mottleScale * g.noiseFrequency;
    uniforms.uRimWidth.value = c.rimWidth;
    uniforms.uRimDark.value = c.rimDark;
    uniforms.uRimGlow.value = c.rimGlow;
    uniforms.uFresnel.value = c.shellFresnel * g.fresnel;
    uniforms.uFresnelPower.value = c.shellFresnelPower;
    uniforms.uThin.value = c.thin * g.shaderIntensity;
    uniforms.uThinPower.value = c.thinPower;
    uniforms.uBroodGlow.value = c.broodGlow;
    uniforms.uBroodRise.value = c.broodRise;
    uniforms.uInteriorGlow.value = c.interiorGlow;
    uniforms.uGlow.value = c.shellGlow * g.glow;
    uniforms.uHuskFade.value = fade;

    uniforms.uColorShell.value.copy(getColor(c.colorShell));
    uniforms.uColorBelly.value.copy(getColor(c.colorBelly));
    uniforms.uColorVein.value.copy(getColor(c.colorVein));
    uniforms.uColorBrood.value.copy(getColor(c.colorBrood));
    uniforms.uColorRim.value.copy(getColor(c.colorRim));
    uniforms.uColorInterior.value.copy(getColor(c.colorInterior));

    material.roughness = c.shellRoughness;
    material.envMapIntensity = c.shellEnv;
    material.opacity = 1;
  };

  material.userData.sync(1);
  return material;
}
