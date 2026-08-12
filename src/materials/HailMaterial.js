import { MeshStandardMaterial, Color, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * A hailstone — clear ice with a cloudy core, lit by the stage.
 *
 * Built on `MeshStandardMaterial` for the same reason Frost Lance's crystal and
 * Cinder Fall's rock are: a hailstone is a *solid*. It has to take the key
 * light, cast into the shadow map and pick up the HDR probe, or thirty of them
 * falling read as thirty additive smudges — which is exactly what the first
 * version, a raw additive `ShaderMaterial`, looked like. Nothing about hail is
 * emissive except its edges.
 *
 * Four ideas on top of the standard shading, in the order they matter:
 *
 *   - **the cloudy core.** Real hail is layered: clear rime over milky, trapped
 *     air. An fbm field sampled in **local space** picks out the milk, so the
 *     cloud is welded into the stone and tumbles with it. Sampling in world
 *     space — which the ice deliberately does, so a whole field looks quarried
 *     out of one block — makes the marbling swim across a spinning stone and
 *     gives the trick away instantly.
 *   - **the fresnel edge.** A transparent solid is mostly read from its rim,
 *     and this is the only term that survives being 17 cm across at twenty
 *     metres. It is the reason `iceRim` ships high.
 *   - **glints.** Hashed specks rather than a smooth specular: ice catches the
 *     sun on a handful of facets at a time, and a broad highlight reads as wet
 *     plastic. `speck`-style hashing, not a ridged noise — value noise piles up
 *     at its midpoint and a ridged octave of it would frost the whole stone.
 *   - **the leading face.** The stones are stretched along their velocity, so
 *     the facets pointing down the heading catch the light first. One dot
 *     product against a heading the ability resolves each frame, and it is what
 *     stops a stretched stone reading as a static blob with motion blur.
 *
 * Per-instance inputs arrive as the attributes `Projectile` dresses its
 * geometry with (`aSeed`, `aFlight`, `aFlash`), so this material is only ever
 * used on an `InstancedMesh`.
 */
export function createHailMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.42,
    metalness: 0.0,
    // Faceted, like the crystals. A smooth-shaded hailstone is a pebble.
    flatShading: true
  });

  const uniforms = {
    uTime: frame.uTime,
    uColorIce: { value: new Color() },
    uColorMilk: { value: new Color() },
    uColorRim: { value: new Color() },
    uColorGlint: { value: new Color() },
    uMilk: { value: 0.72 },
    uMilkScale: { value: 3.1 },
    uFacetTint: { value: 0.3 },
    uRim: { value: 1.3 },
    uRimPower: { value: 2.4 },
    uGlint: { value: 1.0 },
    uGlintScale: { value: 7.5 },
    uLead: { value: 0.75 },
    uLeadSharp: { value: 2.6 },
    /** Unit heading of the fall, world space — drives the leading-face light. */
    uHeading: { value: new Vector3(0, -1, 0) },
    uGlow: { value: 1.15 }
  };

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aSeed;
         attribute float aFlash;
         varying vec3  vHailLocal;
         varying vec3  vHailNormalW;
         varying float vHailSeed;
         varying float vHailFlash;`
      )
      // `objectNormal` is declared by <beginnormal_vertex>, which runs before
      // this chunk; three only takes it into *view* space and the leading-face
      // term needs it in world space.
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vHailLocal = transformed;
         vHailSeed = aSeed;
         vHailFlash = aFlash;
         #ifdef USE_INSTANCING
           vHailNormalW = normalize(mat3(modelMatrix) * (instanceMatrix * vec4(objectNormal, 0.0)).xyz);
         #else
           vHailNormalW = normalize(mat3(modelMatrix) * objectNormal);
         #endif`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform vec3  uColorIce;
         uniform vec3  uColorMilk;
         uniform vec3  uColorRim;
         uniform vec3  uColorGlint;
         uniform float uMilk;
         uniform float uMilkScale;
         uniform float uFacetTint;
         uniform float uRim;
         uniform float uRimPower;
         uniform float uGlint;
         uniform float uGlintScale;
         uniform float uLead;
         uniform float uLeadSharp;
         uniform vec3  uHeading;
         uniform float uGlow;
         varying vec3  vHailLocal;
         varying vec3  vHailNormalW;
         varying float vHailSeed;
         varying float vHailFlash;
         ${noiseGLSL}`
      )
      // Injected once the normal is resolved: with `flatShading` there is no
      // `vNormal` varying, so the view-dependent terms have to read the face
      // normal that <normal_fragment_begin> derives from screen-space
      // derivatives.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           vec3  N   = normalize(normal);
           float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);
           float rim = pow(1.0 - ndv, max(uRimPower, 0.05));

           /* --- the cloudy core, welded into the stone --- */
           float cloud = fbm3(vHailLocal * uMilkScale + vHailSeed * 23.0) * 0.5 + 0.5;
           vec3  body  = mix(uColorIce, uColorMilk, smoothstep(0.35, 0.85, cloud) * uMilk);

           // Per-facet value break-up. The geometric normal in object space is
           // constant across a triangle, so hashing it gives every flat face
           // its own shade — two derivatives, and it is the difference between
           // cut ice and a noise-painted ball.
           vec3  faceN = normalize(cross(dFdx(vHailLocal), dFdy(vHailLocal)));
           body *= 1.0 + (hash13(faceN * 41.0 + vHailSeed) - 0.5) * uFacetTint;

           // Cheap curvature occlusion: cut faces sit closer to the centre than
           // the lumps do, so radius doubles as a cavity term.
           body *= mix(0.82, 1.06, smoothstep(0.55, 1.0, length(vHailLocal)));
           diffuseColor.rgb *= body;

           /* --- what glows: edges and specks, nothing else --- */
           vec3 glow = uColorRim * rim * uRim;

           // Specks, hashed on the local position rather than smoothed, so the
           // stone catches the sun on a few facets at a time.
           float speck = hash13(floor(vHailLocal * uGlintScale) + vHailSeed * 7.0);
           speck = pow(clamp(speck, 0.0, 1.0), 9.0) * (0.6 + 0.4 * sin(uTime * 11.0 + vHailSeed * 30.0));
           glow += uColorGlint * speck * uGlint * ndv;

           float lead = pow(clamp(dot(normalize(vHailNormalW), -uHeading), 0.0, 1.0), max(uLeadSharp, 0.05));
           glow += uColorGlint * lead * uLead;

           // The birth pop, so a stone entering the frame is not a hard cut.
           glow += uColorGlint * vHailFlash * 1.5;

           glow *= uGlow;
           // The same soft ceiling the rock uses: these terms are independent
           // and stack, and a glint crossing the rim sums past 10 and smears
           // the whole stone into a white blob under bloom.
           glow /= 1.0 + glow * 0.25;

           totalEmissiveRadiance += glow;
         }`
      );
  });

  /**
   * Parked here rather than on `material.uniforms`, which a patched
   * `MeshStandardMaterial` does not have — the harness's pause test reads this
   * exact property and would otherwise report every slider below as dead.
   */
  material.userData.uniforms = uniforms;

  /**
   * Pull the palette and every shading control from the live settings.
   * @param {THREE.Vector3} heading unit direction of the fall, world space
   */
  material.userData.sync = (heading = null) => {
    const c = settings.hail;
    const g = settings.global;

    material.roughness = c.iceRoughness;

    uniforms.uColorIce.value.copy(getColor(c.colorIce));
    uniforms.uColorMilk.value.copy(getColor(c.colorMilk));
    uniforms.uColorRim.value.copy(getColor(c.colorRim));
    uniforms.uColorGlint.value.copy(getColor(c.colorGlint));

    uniforms.uMilk.value = c.iceMilk;
    uniforms.uMilkScale.value = c.iceMilkScale * g.noiseFrequency;
    uniforms.uFacetTint.value = c.iceFacetTint * g.randomness;
    uniforms.uRim.value = c.iceRim * g.fresnel;
    uniforms.uRimPower.value = c.iceRimPower;
    uniforms.uGlint.value = c.iceGlint * g.shaderIntensity;
    uniforms.uGlintScale.value = c.iceGlintScale * g.noiseFrequency;
    uniforms.uLead.value = c.iceLead;
    uniforms.uLeadSharp.value = c.iceLeadSharp;
    uniforms.uGlow.value = c.iceGlow * g.glow;

    if (heading) uniforms.uHeading.value.copy(heading);
  };

  return material;
}
