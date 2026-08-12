/**
 * castShape.js — how an ability is aimed.
 *
 * `LINE` is the skillshot the sandbox started with: an arrow swung about the
 * caster, cast along its length. `ZONE` is the **far cast** — a circle with a
 * thick boundary dropped at the cursor, which answers the only question a
 * ground-targeted AoE has to answer before you commit: how much space is this
 * going to take. Both resolve to the same `cast(origin, direction, distance)`
 * event, so an ability never has to care which one aimed it; a zone ability
 * simply reads its target as `pointAt(1)` and works outward from there.
 *
 * This lives in its own two-line module for one reason: the **registry** needs
 * it to declare a descriptor, and `settings.js` needs the registry to derive
 * `ELEMENTS` / `ELEMENT_META`. Leaving the enum in `settings.js` would close
 * that loop into an import cycle, and an ES-module cycle resolves to
 * `undefined` at exactly the moment the registry is being evaluated — the
 * failure looks like every ability silently becoming a line cast. Splitting the
 * constant out is cheaper than debugging that twice.
 *
 * `settings.js` re-exports it, so `import { CastShape } from '../config/settings.js'`
 * keeps working everywhere it is already written.
 */
export const CastShape = Object.freeze({
  LINE: 'line',
  ZONE: 'zone'
});
