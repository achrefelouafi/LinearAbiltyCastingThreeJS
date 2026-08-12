/**
 * Render layers.
 *
 * WORLD       — opaque environment + character. Written to the depth prepass,
 *               receives shadows, is what soft particles fade against.
 * VFX         — every transparent ability mesh and particle system.
 * DISTORTION  — invisible-to-the-main-pass proxies that write screen-space UV
 *               offsets for heat shimmer / water refraction.
 * CONTACT     — additional layer flag on the character only, so the contact
 *               shadow pass captures it without also capturing grass or VFX.
 */
export const LAYER = Object.freeze({
  WORLD: 0,
  VFX: 1,
  DISTORTION: 2,
  CONTACT: 3
});

/** Put an object and all of its descendants on a single layer. */
export function setLayerRecursive(object, layer) {
  object.traverse((node) => node.layers.set(layer));
  return object;
}

/* ---------------------------------------------------------------- */
/* Who is writing to the distortion buffer                           */
/* ---------------------------------------------------------------- */

/**
 * How many meshes are currently *visible* on `LAYER.DISTORTION`.
 *
 * The refraction pass is a half-res clear plus a half-res draw plus a full-res
 * resample, and for most of any given second nothing in the scene is refracting
 * anything. `PostProcessing` consults this counter and skips all three when it
 * is zero — which is the other half of closing the "the distortion pass runs
 * with nothing writing to it" rough edge. Turning the pass *on* would be a poor
 * trade if it then ran unconditionally.
 *
 * It lives here rather than in `vfx/Distortion.js` for one reason: the
 * postprocessing stack must not have to import a VFX module (and drag its
 * shader source into the boot bundle) merely to ask whether it has work. This
 * file is already imported by both sides and is the natural home for anything
 * that is *about* the layer rather than about what draws into it.
 *
 * Retain when a writer becomes visible, release when it hides or is disposed.
 * The counter tracks visibility, not construction: abilities are pooled, so a
 * writer exists for the lifetime of the app and is visible for a second of it.
 */
export const distortionWriters = { count: 0 };

export function retainDistortion() {
  distortionWriters.count++;
}

export function releaseDistortion() {
  distortionWriters.count = Math.max(0, distortionWriters.count - 1);
}
