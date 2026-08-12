/**
 * The subset of the shared helpers that is legal in a **vertex** shader.
 *
 * This split exists because injecting `commonGLSL` into a vertex stage does not
 * compile, and the error points at a function you are not using. `aastep` calls
 * `fwidth`, and derivative functions do not exist in a vertex shader; three
 * reports it as a failure on that line and the natural reading is that the
 * chunk is broken rather than that it is in the wrong stage. It has cost two
 * people a round-trip here, and the first workaround both times was to
 * hand-copy the four lines they actually wanted into the shader — which is how
 * a gradient ends up with three subtly different definitions and a colour ramp
 * that shifts depending on which mesh you are looking at.
 *
 * So: everything derivative-free and sampler-free lives here, `commonGLSL`
 * includes it, and a vertex stage injects this instead. Both carry include
 * guards and the guards are different, so injecting **both** into the same
 * stage — which a material sharing one string across two stages will do — is
 * safe in either order.
 *
 * Nothing in here reads a texture either, so it is also the chunk to reach for
 * in a stage with no sampler bound.
 */
export const commonVertexGLSL = /* glsl */ `
#ifndef COMMON_VERTEX_LIB_INCLUDED
#define COMMON_VERTEX_LIB_INCLUDED

/** Standard Schlick-ish rim term. */
float fresnelTerm(vec3 viewDir, vec3 normal, float power, float scale) {
  return clamp(scale * pow(1.0 - abs(dot(normalize(viewDir), normalize(normal))), power), 0.0, 4.0);
}

/** Threshold dissolve with an emissive burn edge. Returns vec2(alphaMask, edge). */
vec2 dissolveMask(float noiseValue, float threshold, float edgeWidth) {
  float mask = step(threshold, noiseValue);
  float edge = smoothstep(threshold, threshold + edgeWidth, noiseValue) - mask;
  return vec2(mask, clamp(edge, 0.0, 1.0));
}

/** 4-stop gradient sampled by t in 0..1 (core → mid → edge → tail). */
vec3 gradient4(vec3 c0, vec3 c1, vec3 c2, vec3 c3, float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 a = mix(c0, c1, smoothstep(0.0, 0.34, t));
  vec3 b = mix(a, c2, smoothstep(0.30, 0.68, t));
  return mix(b, c3, smoothstep(0.64, 1.0, t));
}

/** Screen-space UV of the current fragment (needs the clip position). */
vec2 screenUVFromClip(vec4 clipPos) {
  return (clipPos.xy / clipPos.w) * 0.5 + 0.5;
}

/*
 * Equirectangular lookup for a world-space direction — the environment probe's
 * UV for a reflected ray.
 *
 * The two magic numbers are 1/(2*PI) and 1/PI. asin rather than acos because
 * three's equirect convention puts v = 0 at the south pole, and the clamp is
 * not paranoia: a normal perturbed by a heightfield routinely comes back a few
 * ulps outside the unit sphere, asin(1.0000001) is NaN, and that reads on
 * screen as one black pixel crawling across the water.
 *
 * NOTE for anyone editing this chunk: no backticks in these comments. The file
 * is one big template literal and a stray backtick ends it, reporting as a
 * JS syntax error pointing into the middle of the shader.
 *
 * This lived in three copies — GlacierMaterial and both surface modules in
 * vfx/ — before it moved here. GlacierMaterial keeps its own: it injects
 * noiseGLSL but not this chunk, and folding it in would mean editing a shipped
 * material for tidiness alone.
 */
vec2 equirectUv(vec3 dir) {
  return vec2(atan(dir.z, dir.x) * 0.15915494 + 0.5,
              asin(clamp(dir.y, -1.0, 1.0)) * 0.31830989 + 0.5);
}

#endif
`;

/**
 * Shared shading helpers: soft particles, fresnel, dissolve, gradients.
 *
 * **Fragment stages only.** Pulls in three's `<packing>` chunk itself (needed
 * by `softFade`), so this chunk must only be injected into raw
 * ShaderMaterials — never into a built-in material that already includes
 * `<packing>`, or the depth helpers would be defined twice. For a vertex stage
 * inject `commonVertexGLSL` above, which is the same chunk minus the two
 * functions that cannot exist there.
 */
export const commonGLSL = /* glsl */ `
#ifndef COMMON_LIB_INCLUDED
#define COMMON_LIB_INCLUDED

#include <packing>

${commonVertexGLSL}

/**
 * Depth-based soft particle fade.
 * sceneDepth is a packed-RGBA depth prepass of the opaque scene.
 * Returns 0 where the fragment intersects geometry, 1 when well in front of it.
 */
float softFade(sampler2D sceneDepth, vec2 screenUV, float fragViewZ, float near, float far, float fadeDist) {
  float depthBits = unpackRGBAToDepth(texture2D(sceneDepth, screenUV));
  float sceneViewZ = perspectiveDepthToViewZ(depthBits, near, far);
  return clamp((fragViewZ - sceneViewZ) / max(fadeDist, 1e-4), 0.0, 1.0);
}

/** Anti-aliased step using screen-space derivatives where available. */
float aastep(float threshold, float value) {
  float afwidth = fwidth(value) * 0.7;
  return smoothstep(threshold - afwidth, threshold + afwidth, value);
}

#endif
`;
