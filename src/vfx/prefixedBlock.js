/**
 * prefixedBlock.js — the plumbing behind prefixed settings blocks.
 *
 * Two conventions for reading settings grew up side by side in `src/vfx/`, and
 * both are legitimate:
 *
 *  - **Canonical names.** `GrowthField`, `GroundField`, `Projectile`, `Swarm`,
 *    `LiquidSurface`, `Curtain`, `ShatterField` and `ArcNetwork` take a params
 *    object each frame and read `p.radius ?? 1`. Short, obvious, and an ability
 *    can hand its settings block straight through when the names line up.
 *  - **Prefixed names.** `Tube`, `Shell` and `VolumeHull` read `c[keys.radius]`
 *    where `keys.radius === 'tubeRadius'`. Uglier, and it exists because those
 *    three are the modules an ability plausibly wants *two* of. Pyroclasm
 *    carries an ash hull and a flame hull; a whip ability could carry a tube
 *    for the lash and another for the recoil. Bare names collide the moment it
 *    does, and the collision is silent — the second one just quietly drives
 *    the first one's radius.
 *
 * This module is the shared half of the second convention. It was three
 * verbatim copies of `num`, two of `str`, two of `prefixed` and two apiece of
 * the defaults / keys / audit loops before it was a file: `Tube.js`, `Shell.js`
 * and `VolumeHull.js` had each independently written the same eight lines.
 * Nothing here is clever. It is here so that a fix to the audit message lands
 * in one place, and so a fourth prefixed module costs its author nothing.
 *
 * `VolumeHull` uses `num()` and `auditBlock()` but keeps its own key builder:
 * its field table already stores capitalised suffixes (`'Density'`), so it
 * concatenates rather than capitalising, and forcing it through `prefixed()`
 * would mean rewriting a hundred-odd table rows to prove a point about tidiness.
 */

/* ---------------------------------------------------------------- */
/* Coercion                                                          */
/* ---------------------------------------------------------------- */

/**
 * A finite number, or the fallback.
 *
 * The `value === value` is a NaN test, and it is the one that matters: an
 * ability that spreads a defaults fragment but then computes one of the keys
 * wrongly hands us a NaN, and a NaN in a uniform does not render as a wrong
 * shape — it renders as nothing at all, silently, with no console output. A
 * missing key at least has the decency to be `undefined`.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
export function num(value, fallback) {
  return typeof value === 'number' && value === value ? value : fallback;
}

/**
 * A string (in practice a `#rrggbb` colour), or the fallback.
 *
 * @param {*} value
 * @param {string} fallback
 * @returns {string}
 */
export function str(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

/* ---------------------------------------------------------------- */
/* Keys                                                              */
/* ---------------------------------------------------------------- */

/**
 * `('tube', 'radius')` → `'tubeRadius'`. An empty prefix passes the name
 * through, which is what makes a single-hull ability able to opt out of the
 * whole scheme and keep bare names.
 *
 * @param {string} prefix
 * @param {string} name
 * @returns {string}
 */
export function prefixed(prefix, name) {
  return prefix ? prefix + name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/**
 * The unprefixed → prefixed map, built once at construction so that `sync()`
 * never concatenates a string on a frame (I3).
 *
 * @param {readonly string[]} fieldNames
 * @param {string} prefix
 * @returns {Object<string,string>}
 */
export function buildKeys(fieldNames, prefix) {
  const out = {};
  for (const name of fieldNames) out[name] = prefixed(prefix, name);
  return out;
}

/* ---------------------------------------------------------------- */
/* Defaults                                                          */
/* ---------------------------------------------------------------- */

/**
 * Compose a settings fragment: base defaults, per-mode tuning on top, then the
 * caller's overrides on top of that.
 *
 * The three layers are the whole point. `fields` is what the module thinks a
 * neutral instance looks like; `tuning` is what it thinks a *funnel* looks
 * like, because a vortex and a bullwhip genuinely do not want the same flare;
 * and `overrides` is the ability author disagreeing with both, which they are
 * entitled to do because every one of these is a slider the moment it lands in
 * the block.
 *
 * Overrides are keyed **prefixed** (`{ lashRadius: 0.3 }`), because that is
 * what the author sees in the editor and in their own settings module.
 *
 * @param {readonly string[]} fieldNames  iteration order
 * @param {Object<string,*>} fields       name → neutral default
 * @param {Object<string,*>} tuning       name → per-mode default (may be empty)
 * @param {string} prefix
 * @param {Object<string,*>} [overrides]  prefixed keys
 * @returns {Object<string,*>}
 */
export function buildDefaults(fieldNames, fields, tuning, prefix, overrides = {}) {
  const out = {};
  for (const name of fieldNames) {
    out[prefixed(prefix, name)] = name in tuning ? tuning[name] : fields[name];
  }
  return Object.assign(out, overrides);
}

/* ---------------------------------------------------------------- */
/* Audit                                                             */
/* ---------------------------------------------------------------- */

/**
 * Warn once, naming every key the block is missing.
 *
 * This warns rather than throwing on purpose. A half-written settings block is
 * the normal state of an ability for the first hour of its life, and a module
 * that refuses to render until every one of eighty keys exists is a module the
 * author fights instead of using — `num()`/`str()` fall back, the thing draws,
 * and the console says exactly which keys to paste in. The one-shot guard is
 * the caller's (`this._checked`), because a warning on every frame of every
 * cast is indistinguishable from no warning at all.
 *
 * @param {string} label      e.g. `'Tube:lash'` — what to print in the brackets
 * @param {Object<string,string>} keys  the map from `buildKeys`
 * @param {readonly string[]} fieldNames
 * @param {Object<string,*>} block      the ability's settings block
 * @param {string} remedy     the call that would fix it, e.g. `"tubeDefaults('lash', TubePath.WHIP)"`
 * @returns {string[]} the missing keys, in case the caller wants them
 */
export function auditBlock(label, keys, fieldNames, block, remedy) {
  const missing = [];
  for (const name of fieldNames) if (!(keys[name] in block)) missing.push(keys[name]);
  if (missing.length) {
    console.warn(
      `[${label}] settings block is missing ${missing.length} key(s); ` +
        `falling back to defaults. Spread ${remedy} into the block. ` +
        `Missing: ${missing.join(', ')}`
    );
  }
  return missing;
}
