import { PlaneGeometry } from 'three';

/* ------------------------------------------------------------------------ */
/* The two unit quads the whole library draws on                             */
/* ------------------------------------------------------------------------ */
/**
 * One flat quad and one upright quad, built once and shared by everything.
 *
 * ## Why this is its own file
 *
 * Five modules arrived with a private copy of one of these two eight-line
 * pools: `GroundField` and `Caustics` for the flat one, `Distortion`, `Portal`
 * and `Mirror` for the upright one. Caustics' comment argued its duplication
 * was correct, and half of the argument was right — it must not import
 * `GroundField`, because that would drag two thousand lines and a rune alphabet
 * into the graph of any ability that only wanted water on the floor. The
 * conclusion did not follow. The fix for "these two must not depend on each
 * other" is a third file that neither of them is, which is exactly what
 * `prefixedBlock.js` already is for shader assembly, and this is thirty lines
 * rather than two thousand.
 *
 * What the duplication cost: with a caustic net, three ground marks, a portal
 * and a heat shimmer standing, the app held **five** identical two-triangle
 * buffers instead of two, on five independent reference counts. Cheap, and
 * invisible until somebody profiles buffer uploads and finds four geometries
 * that should not exist.
 *
 * ## The contract
 *
 * Both quads are **1 × 1, centred on the origin**, and neither carries a metre.
 * An effect scales the mesh; a quad built at the effect's radius would be a
 * dimension captured in a buffer, which is the invariant (I1) this whole
 * project is organised around. Never mutate either of them, and never call
 * `dispose()` on one — it is not yours.
 */

/* ---------------------------------------------------------------- */
/* Flat — 1 × 1 in the XZ plane, normal +Y. Refcounted.              */
/* ---------------------------------------------------------------- */

/** @type {THREE.PlaneGeometry|null} */
let _ground = null;
let _groundRefs = 0;

/**
 * Borrow the shared ground quad. Returns the same geometry every time.
 *
 * `acquireGroundQuad()` in the constructor, `releaseGroundQuad()` in
 * `dispose()`, exactly once each.
 *
 * @returns {THREE.PlaneGeometry}
 */
export function acquireGroundQuad() {
  if (!_ground) {
    _ground = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    _ground.name = 'vfx.groundQuad';
  }
  _groundRefs++;
  return _ground;
}

/**
 * Give it back. The last release disposes the buffer, so a scene that has torn
 * every ground effect down leaves nothing behind — and the next acquisition
 * rebuilds it rather than handing out a disposed geometry.
 */
export function releaseGroundQuad() {
  if (--_groundRefs <= 0) {
    _ground?.dispose();
    _ground = null;
    _groundRefs = 0;
  }
}

/** Live borrowers. For the harness and for a leak readout; not for logic. */
export function groundQuadRefs() {
  return _groundRefs;
}

/* ---------------------------------------------------------------- */
/* Upright — 1 × 1 in the XY plane, normal +Z. Not refcounted.       */
/* ---------------------------------------------------------------- */

/** @type {THREE.PlaneGeometry|null} */
let _upright = null;

/**
 * The shared upright quad — the face of a portal, a mirror, a distortion plane.
 *
 * **Deliberately not refcounted**, matching the behaviour `Distortion` and
 * `Portal` already shipped with. It is two triangles and twenty-four bytes of
 * attribute data, it is wanted again the instant anything else is cast, and a
 * refcount would mean the last portal closing frees a buffer the next one
 * immediately rebuilds. `disposeQuads()` exists for a teardown that genuinely
 * wants the context empty; nothing in the app calls it, and that is correct.
 *
 * @returns {THREE.PlaneGeometry}
 */
export function uprightQuad() {
  if (!_upright) {
    _upright = new PlaneGeometry(1, 1, 1, 1);
    _upright.name = 'vfx.uprightQuad';
  }
  return _upright;
}

/**
 * Drop both quads. For a harness tearing a context down, and for nothing else —
 * a live mesh still holding one is left drawing a disposed geometry.
 */
export function disposeQuads() {
  _ground?.dispose();
  _ground = null;
  _groundRefs = 0;
  _upright?.dispose();
  _upright = null;
}
