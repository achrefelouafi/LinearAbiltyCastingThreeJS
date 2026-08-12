/**
 * FNV-1a over a string. Short, stable, and good enough to tell two shader
 * injections apart — which is the only thing it is asked to do.
 */
function hashSource(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Compose `onBeforeCompile` callbacks.
 *
 * Several systems want to patch the same built-in material (CSM injects its
 * cascade lookup, we inject procedural colour). Assigning `onBeforeCompile`
 * naively would silently clobber whichever ran first, so all patching goes
 * through here.
 *
 * ## Why `customProgramCacheKey` is not optional here
 *
 * This is the subtlest bug the project has had, so it is worth the paragraph.
 *
 * three caches compiled programs and, for a patched material, keys that cache
 * on `material.customProgramCacheKey()` — whose default implementation is
 * `this.onBeforeCompile.toString()`. That default is exactly right for a
 * hand-written `onBeforeCompile`, because two materials carrying *the same*
 * function genuinely want the same program.
 *
 * It is exactly wrong for this helper. Every material patched here gets the
 * same six-line wrapper above, so `toString()` returns **identical text for
 * every patched material in the project** — the injected code lives in `fn`,
 * which the wrapper only closes over and never spells out. Sixty-odd materials
 * therefore collided on one cache key, and every one of them after the first
 * silently rendered with *some other material's compiled program*: its own
 * uniforms did not exist there, the ones that did held another shader's values,
 * and the result was NaN fragments. One NaN reaching the HDR buffer is not one
 * bad pixel — the next bloom blur spreads it over its whole kernel and
 * tone-mapping NaN gives black, so eighty-odd bad fragments on one spear turned
 * the entire frame black. It presented as "some abilities black out the screen,
 * but only sometimes", because which material won the cache depended on which
 * one was cast first.
 *
 * So the key is derived from `fn`'s own source instead. Materials sharing an
 * injection still share a program, which is the behaviour that makes the cache
 * worth having; materials with different injections no longer collide. Keys are
 * composed down the chain so a second patch on the same material is also
 * distinguished from the first.
 */
export function patchOnBeforeCompile(material, fn) {
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  const key = hashSource(fn.toString());

  material.onBeforeCompile = function (shader, renderer) {
    if (previous) previous.call(this, shader, renderer);
    fn.call(this, shader, renderer);
  };

  // Composed, not replaced: a material can be patched more than once (the
  // shadow-caster path does exactly that) and each layer has to contribute.
  material.customProgramCacheKey = function () {
    const base = previousKey ? previousKey.call(this) : '';
    return `${base}|${key}`;
  };

  return material;
}

/**
 * Replace a token in a shader string, throwing in dev if the token vanished
 * after a three.js upgrade — silent no-ops here are painful to debug.
 */
export function replaceChunk(source, token, replacement) {
  if (!source.includes(token)) {
    console.warn(`[shaderPatch] token not found: ${token}`);
    return source;
  }
  return source.replace(token, replacement);
}

/** Prepend declarations to a shader stage. */
export function prependChunk(source, code) {
  return `${code}\n${source}`;
}
