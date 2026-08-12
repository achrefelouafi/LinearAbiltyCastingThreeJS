import { ShaderMaterial, DoubleSide, NormalBlending } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';

/**
 * The mirage's skin: a **skinned** writer for the refraction buffer.
 *
 * `vfx/Distortion.js` covers every emitter whose shape is a quad or a static
 * hull, and it covered the mirage too — as ten capsules and a sphere posed by
 * a hand-written IK solver. That was the wrong shape of solution and it looked
 * like it: a capsule figure is a *mannequin*, its silhouette is smooth
 * everywhere a person's is not, and the swing of an arm authored as a sine has
 * none of the weight-shift a real walk cycle carries. The give-away was the
 * shoulders — two spheres cannot make a deltoid, and the eye reads the miss
 * long before it can name it.
 *
 * So the double is now the **caster's own skinned mesh**, cloned by
 * `vfx/TimeControl.js#GhostRig` and posed from a `TimeRecorder` track, which
 * is the machinery Echo Step already uses. This material is the one piece that
 * was missing: `GhostRig` will take any material, but the clone has to write
 * the offset encoding `DistortionShader` decodes rather than a colour, and it
 * has to do it *through the skeleton*.
 *
 * ## Skinning a raw ShaderMaterial
 *
 * three supplies `USE_SKINNING` and the bone-texture uniforms to any material
 * drawn on a `SkinnedMesh`, `ShaderMaterial` included — the define is added by
 * the program's vertex prefix, not by the built-in shaders. So the only thing
 * needed is to include the four skinning chunks in the right order and let the
 * renderer bind `boneTexture`, `bindMatrix` and `bindMatrixInverse` itself.
 * The normal has to go through `<skinnormal_vertex>` for the same reason the
 * position does: an unskinned normal on a skinned mesh leaves the rim term
 * lit from wherever the bind pose happened to be facing, and the figure looks
 * like it is made of glass panes rather than of one body.
 *
 * ## What it writes
 *
 * The same four channels every other emitter writes, documented in
 * `postprocessing/DistortionShader.js`:
 *
 * ```
 *   R,G  unit screen-space direction, encoded as d * 0.5 + 0.5
 *   B    magnitude, in screen widths at post.distortion = 1
 *   A    coverage — the blend weight where two emitters overlap
 * ```
 *
 * The direction is the **view-space normal's xy**, which is the direction a ray
 * refracting through the surface leaves in, weighted by a rim term so the
 * silhouette bends hardest. That is what a solid of any real index of
 * refraction does, and it is why the double reads as a body-shaped *absence*
 * rather than as a body-shaped smear.
 *
 * Nothing here emits light. The material is on `LAYER.DISTORTION` and never
 * reaches the beauty pass at all, so there is no colour to tone down and no
 * bloom to guard against — which is the whole reason this ability can be
 * invisible-until-it-moves without fighting the post stack.
 */
export function createMirageSkinMaterial() {
  const uniforms = sharedUniforms({
    uStrength: { value: 0.62 }, // screen widths at post.distortion = 1
    uPower: { value: 1.35 }, // rim exponent; 0 flattens to a plain pane
    uRipple: { value: 0.16 }, // break-up of the surface normal
    uRippleScale: { value: 2.4 }, // ripple cycles per metre
    uRippleSpeed: { value: 1.7 }, // metres/second the ripple crawls
    uOpacity: { value: 0.95 }, // coverage
    uDepthReject: { value: 1.0 }, // how hard the real world occludes it
    uDepthFade: { value: 0.3 }, // metres that occlusion feathers over
    uPerspective: { value: 0.35 }, // 0 = flat screen fraction, 1 = shrinks with range
    uPerspectiveRef: { value: 10.0 }, // metres at which perspective = 1
    uFade: { value: 1 } // the ability's own envelope
  });

  const material = new ShaderMaterial({
    uniforms,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    // Both faces. A limb is a closed hull and the far wall's normal points the
    // other way, so drawing only the front face throws away half the bend and
    // the double reads as a shell instead of as a solid.
    side: DoubleSide,
    blending: NormalBlending,
    toneMapped: false,
    vertexShader: /* glsl */ `
      #include <common>
      #include <skinning_pars_vertex>

      varying vec3  vNormalV;
      varying vec3  vWorld;
      varying float vViewZ;
      varying float vOnScreen;

      void main() {
        vec3 objectNormal = normal;
        vec3 transformed = position;

        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <skinning_vertex>

        vec4 world = modelMatrix * vec4(transformed, 1.0);
        vWorld = world.xyz;

        vNormalV = normalize(normalMatrix * objectNormal);

        vec4 mv = viewMatrix * world;
        vViewZ = mv.z;

        vec4 clip = projectionMatrix * mv;
        // Behind the camera the projected xy is meaningless and the offset it
        // would encode is a mirror image of the right one. Gate it here rather
        // than clipping, so a double walking past the camera fades instead of
        // flipping inside out.
        vOnScreen = step(0.0, -mv.z);
        gl_Position = clip;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uStrength;
      uniform float uPower;
      uniform float uRipple;
      uniform float uRippleScale;
      uniform float uRippleSpeed;
      uniform float uOpacity;
      uniform float uDepthReject;
      uniform float uDepthFade;
      uniform float uPerspective;
      uniform float uPerspectiveRef;
      uniform float uFade;

      // From sharedUniforms(). That helper hands over the uniform *boxes*, by
      // identity, so one write per frame updates every material at once — but
      // it cannot declare them for you, and a missed declaration is a link
      // error that only ever shows up in a browser. The check harness never
      // compiles GLSL, so this is one of the few classes of fault it is
      // structurally unable to catch: put a new material on screen once.
      uniform float     uTime;
      uniform vec2      uResolution;
      uniform sampler2D uSceneDepth;
      uniform float     uCameraNear;
      uniform float     uCameraFar;
      uniform float     uShaderIntensity;

      varying vec3  vNormalV;
      varying vec3  vWorld;
      varying float vViewZ;
      varying float vOnScreen;

      ${noiseGLSL}
      ${commonGLSL}

      void main() {
        // Two-sided, so flip the normal on the far wall or the back of the
        // figure bends the scene the opposite way to the front and the two
        // cancel almost exactly.
        vec3 hn = gl_FrontFacing ? vNormalV : -vNormalV;

        // Heat coming off a body: the ripple is sampled in WORLD space and
        // crawls upward, so it stays put on the world as the double moves
        // through it rather than swimming with the skin.
        vec3 wp = vec3(vWorld.xz * uRippleScale, vWorld.y * uRippleScale - uTime * uRippleSpeed);
        vec2 raw = hn.xy + vec2(fbm3(wp), fbm3(wp + vec3(23.1, 4.7, 17.5))) * uRipple;

        float rl = length(raw);
        vec2 dir = rl > 1e-6 ? raw / rl : vec2(0.0);

        // The silhouette bends hardest. max() on the base because pow() of a
        // negative is NaN at every exponent, and one NaN here is smeared over
        // the whole frame by the bloom blur.
        float rim = pow(max(1.0 - abs(hn.z), 0.0), uPower);
        float mag = uStrength * rim * min(rl, 2.0) * uFade;

        // The offset buffer has no depth of its own, so an emitter behind the
        // real character would happily warp him. The opaque prepass is already
        // in uSceneDepth for the soft particles and costs one sample here.
        vec2 screenUV = gl_FragCoord.xy / uResolution;
        float occluded = softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uDepthFade);
        float mask = mix(1.0, occluded, clamp(uDepthReject, 0.0, 1.0));

        mag *= mix(1.0, clamp(uPerspectiveRef / max(-vViewZ, 0.05), 0.0, 4.0), uPerspective);
        mag = clamp(mag * uShaderIntensity, 0.0, 8.0);

        float alpha = clamp(mask * uOpacity * uFade, 0.0, 1.0) * vOnScreen;
        if (alpha * mag < 0.0004) discard;

        gl_FragColor = vec4(clamp(dir, -1.0, 1.0) * 0.5 + 0.5, mag, alpha);
      }
    `
  });

  material.userData.uniforms = uniforms;

  /** Pull every refraction control from the live settings. */
  material.userData.sync = (fade) => {
    const c = settings.mirage;
    uniforms.uStrength.value = c.bodyStrength;
    uniforms.uPower.value = c.refractPower;
    uniforms.uRipple.value = c.refractRipple;
    uniforms.uRippleScale.value = c.refractRippleScale;
    uniforms.uRippleSpeed.value = c.refractRippleSpeed;
    uniforms.uOpacity.value = c.refractOpacity;
    uniforms.uDepthReject.value = c.refractDepthReject;
    uniforms.uDepthFade.value = c.refractDepthFade;
    uniforms.uPerspective.value = c.refractPerspective;
    uniforms.uPerspectiveRef.value = c.refractPerspectiveRef;
    uniforms.uFade.value = fade;
  };

  return material;
}
