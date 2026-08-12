import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  ShaderMaterial,
  Sphere,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { sharedUniforms, frame } from '../core/FrameUniforms.js';
import { patchOnBeforeCompile, replaceChunk } from '../utils/shaderPatch.js';
import { LAYER } from '../core/Layers.js';
import { putColor } from '../utils/color.js';

/* ---------------------------------------------------------------------- */
/* Dissolve — three ways for matter to stop being there                    */
/* ---------------------------------------------------------------------- */

/**
 * `unmake` takes a thing apart into cubes. `avalanche` buries the floor under a
 * heap of snow that keeps collapsing over itself. `entropy` ages a surface until
 * it is not there any more. Three abilities, one idea — **something is being
 * lost, and the loss has a shape** — and three shapes that could not be less
 * alike.
 *
 * ## Why this module has two entry points and not one
 *
 * `VOXEL` and `EROSION` are ways of *taking away* something that already exists.
 * The geometry is not this module's, the material is not this module's, and the
 * ability that reaches for them already has both — so they are a **patch**:
 * `patchDissolveMaterial(material, …)` injects into whatever the caller is
 * already drawing, and the caller keeps its own look.
 *
 * `GRANULAR` is the opposite. Nothing in the scene is heap-shaped, so the heap
 * has to be **drawn**, and that is a class with a mesh in it. One class doing
 * both meant either an object that owned a mesh half its callers threw away or a
 * patch that had to invent a surface out of nothing. The seam is here because
 * the two halves genuinely differ.
 *
 * ```
 *   patchDissolveMaterial(mat, { mode: DissolveMode.VOXEL })  // + EROSION
 *   new DissolveField(group, { … })                           // GRANULAR
 * ```
 *
 * Both read the same canonical params objects (`dissolveParams()` /
 * `heapParams()`) every frame and resolve every metre from them, so a paused
 * slider drag re-cuts a standing dissolve and re-slumps a standing heap.
 *
 * ---
 *
 * ## VOXEL — the cube size grows, which is why it reads as *accelerating*
 *
 * Matter comes apart into cubes that drift and wink out, and **the cubes get
 * bigger as it goes**. That is the whole ability: losing eight small cubes and
 * losing one cube eight times the size are the same volume, but the second one
 * looks like the thing is going faster, because the eye counts events and not
 * litres.
 *
 * It is done entirely in the vertex shader against a lattice whose cell size is
 * a uniform. **No CPU rebuild, ever** — the geometry is untouched and the mesh
 * is the mesh the ability was already drawing.
 *
 * The first version slid the cell size up continuously. It does not work, and
 * the reason is worth writing down: a lattice with a sliding cell size
 * re-partitions the mesh *every frame*, so a chunk that was drifting away as
 * part of one cell is suddenly half of two others and the whole surface
 * visibly reshuffles, twice a second, like a bad mosaic filter.
 *
 * The fix is a **power-of-two ladder walked once per vertex**:
 *
 * ```
 *   for rung r = 0 … rungs-1:
 *       s   = cell · 2^r                      // this rung's cell size
 *       id  = floor(p / s)                    // which cell of it this vertex is in
 *       if hash(id, r) < take   or  r is last:
 *           this vertex belongs to THIS cell, for ever. Stop.
 *           it lets go at t = (r + hash2(id, r)) / rungs
 * ```
 *
 * Every vertex is claimed exactly once, by the *finest* rung that wants it, and
 * the claim depends only on the vertex's rest position and the hashes — so it
 * never changes, never re-partitions, and needs no state. Material that rung 0
 * did not claim is still there when rung 1 comes round and gets taken away in
 * pieces twice the size, at twice the size again on rung 2. The acceleration is
 * not animated; it falls out of the ladder.
 *
 * **The voxel lattice is always object space**, and it is not the same choice as
 * the erosion field's `space`. It has to be: the displacement it produces is
 * added to `transformed`, which is object space, and a lattice in world
 * coordinates would hand a rotating mesh a drift direction that swings round
 * with it. Two consequences to know about — `cell` is metres *in the mesh's own
 * units*, so a mesh with a non-unit scale scales its cubes with it; and every
 * instance of an `InstancedMesh` comes apart identically, which is usually what
 * you want from a field of one thing and is otherwise a per-instance `seed`.
 *
 * A claimed cell then: snaps its vertices toward a sub-lattice (`block`, which
 * is what actually makes the chunk *cubic* rather than merely detached),
 * tumbles about its own centre, drifts, lifts, falls, and finally scales to
 * nothing **about the cell centre** — so it disappears cleanly instead of
 * collapsing into a spike of stray triangles.
 *
 * ## EROSION — and the world/local question, which has a real answer
 *
 * A threshold on a noise field with a bright band above it. `dissolveMask()` in
 * `shaders/lib/common.glsl.js` does exactly this and is not used here, because
 * that chunk pulls in `<packing>` and injecting it into a built-in material
 * defines the depth helpers twice; the two lines are re-stated locally.
 *
 * The field can be sampled in **local** or **world** space and it matters:
 *
 * - **LOCAL (the default)** — the pattern is glued to the object. A thing being
 *   consumed keeps its burn on the same part of itself however it moves, which
 *   is what you want when the *object* is the event. Use it for anything that
 *   travels, spins or is instanced-and-scattered.
 * - **WORLD** — the pattern is glued to the room. Several separate meshes handed
 *   the same uniform box dissolve as **one event**: the front crosses all of
 *   them consistently and the seams between them stop existing, which is the
 *   only way `unmake` can eat a standing ice field that is nine draw calls.
 *   The cost is that a moving mesh *slides through* the pattern, so the burn
 *   crawls over its surface. On something slow that reads as the room eating it;
 *   on something fast it reads as a bad projection. Do not use world space on a
 *   projectile.
 *
 * `biasDirection` adds `dot(p, dir) · biasAmount` to the threshold, which turns
 * the noise into a **front** sweeping a chosen way rather than a rash breaking
 * out everywhere at once.
 *
 * ## GRANULAR — a heap, not a wave
 *
 * The roster's line for `avalanche` is "the front is not a wave; it is a heap
 * that keeps collapsing forward over itself", and a heightfield with a sine in
 * it will never be that. What makes a heap a heap is the **angle of repose**:
 * granular material piles until its surface reaches a critical slope and then
 * refuses to get any steeper, so it grows sideways instead of upward.
 *
 * So the surface is the **upper envelope of a train of collapsing cones**:
 *
 * - a *lobe* is released every `1/rate` seconds at the front, which is at
 *   `frontSpeed · t`. Its identity is its release **ordinal**, not its slot in
 *   the loop, so a lobe keeps its own dice as it ages out of the window — the
 *   version that hashed the slot index gave every lobe a new size and place
 *   each time the window shifted, and the heap boiled;
 * - it is born **over-steep** (`repose + excess`) and relaxes back toward repose
 *   at `slump` per second, which is genuinely what wet snow and dry sand both
 *   do. With its volume held, that means it *gets shorter and wider on its own*:
 *   `H = ∛(3V·tan²φ/π)`, `radius = H/tanφ`. One exponential and a cube root, and
 *   the lobe collapses;
 * - the surface is the **max** of the lobes, not the sum. Heaps merge by taking
 *   the upper envelope — that is what a repose surface *is* — and summing them
 *   gives a smooth mound with no ridges, which is a pudding. The creases where
 *   two lobes meet are the whole texture of the thing;
 * - each lobe's centroid also creeps forward at `creep` while it collapses, so
 *   new lobes land **on top of** older ones and slide over them. That is the
 *   "collapsing forward over itself" in the roster line, and it is one term.
 *
 * Nothing is integrated and nothing is stored. Every lobe is a closed-form
 * function of `now − birth`, so a paused heap re-slumps under `repose` — pull
 * the repose angle down with the clock stopped and the whole avalanche flattens
 * and spreads, which is a thing worth doing once just to watch.
 *
 * ## Cost
 *
 * The patch is **free** — no extra draw call, it is the caller's mesh. The heap
 * is **one**. No textures anywhere.
 *
 * ## Invariants
 *
 * - **I1** — nothing is captured. Cell sizes, lobe volumes, repose angles and
 *   drift distances all re-resolve from the params every frame, including a
 *   zero-length one.
 * - **I3** — the patch allocates its uniform box once; `syncDissolve()` and
 *   `DissolveField.update()` write into existing boxes.
 * - **I5** — every dimension a slider, every colour a picker.
 * - **I8** — `patchDissolveMaterial()` parks its box on
 *   `material.userData.uniforms`, or the harness's pause test reports forty
 *   working sliders as dead.
 *
 * @example
 *   // unmake: dissolve someone else's standing field as one event
 *   const box = dissolveUniforms({ space: DissolveSpace.WORLD });
 *   for (const m of field.materials) patchDissolveMaterial(m, { uniforms: box });
 *   // every frame
 *   syncDissolve(box, this._params);          // params.progress drives all of them
 */

const PI = Math.PI;

/** Rungs of the voxel ladder. Six doublings is 64× the cell — more than enough. */
export const MAX_RUNGS = 6;

/** Lobes alive in the heap at once. The loop bound, and it is a real cost. */
export const MAX_LOBES = 24;

/* ---------------------------------------------------------------- */
/* Enums                                                             */
/* ---------------------------------------------------------------- */

export const DissolveMode = Object.freeze({
  /** Cubes, growing as it goes. A patch. */
  VOXEL: 0,
  /** A heap at its angle of repose, collapsing forward. A mesh — `DissolveField`. */
  GRANULAR: 1,
  /** A noise threshold with a burning edge. A patch. */
  EROSION: 2
});

/** Where the erosion field is nailed down. See the class header — this matters. */
export const DissolveSpace = Object.freeze({
  /** Glued to the object. The default, and right for anything that moves. */
  LOCAL: 0,
  /** Glued to the room. Several meshes dissolve as one event. */
  WORLD: 1
});

/* ---------------------------------------------------------------------- */
/* The patch: VOXEL + EROSION                                              */
/* ---------------------------------------------------------------------- */

/**
 * Declarations, shared by both stages of a patched material.
 *
 * NOTE for anyone editing this chunk: no backticks in these comments. The file
 * is one template literal and a stray backtick ends it, reporting as a
 * JavaScript syntax error pointing into the middle of the shader.
 */
const DISSOLVE_UNIFORMS = /* glsl */ `
#ifndef DISSOLVE_UNIFORMS_INCLUDED
#define DISSOLVE_UNIFORMS_INCLUDED
  #define DISSOLVE_RUNGS ${MAX_RUNGS}

  uniform float uDisProgress;   // 0 intact, 1 gone. The one slider.
  uniform float uDisSeed;
  uniform float uDisSpace;      // 0 local, 1 world

  uniform float uDisVoxel;      // 0..1 — how much of the cube behaviour is on
  uniform float uDisCell;       // metres — the FINEST rung
  uniform float uDisRungs;      // doublings the ladder walks, 1..DISSOLVE_RUNGS
  uniform float uDisTake;       // fraction of cells a rung claims
  uniform float uDisSpan;       // progress units one cell takes to let go
  uniform float uDisBlock;      // 0..1 — how far a chunk snaps to the lattice
  uniform float uDisFacet;      // sub-lattice size, fraction of the cell
  uniform float uDisHold;       // 0..1 of a cell's life before it starts shrinking
  uniform float uDisDrift;      // metres a chunk travels
  uniform vec3  uDisDriftBias;  // unitless direction preference
  uniform float uDisLift;       // metres up
  uniform float uDisGravity;    // metres of fall, on k squared
  uniform float uDisTumble;     // radians a chunk turns
  uniform float uDisWobble;     // metres of hashed wander
  uniform float uDisWobbleRate; // radians/second

  uniform float uDisErode;      // 0..1 — how much of the threshold behaviour is on
  uniform float uDisNoiseScale; // features per metre
  uniform float uDisWarp;       // metres the field is domain-warped by
  uniform float uDisEdge;       // width of the burning band, noise units
  uniform vec3  uDisBiasDir;    // unit-ish; turns the rash into a front
  uniform float uDisBiasAmount; // threshold shift per metre along it

  uniform vec3  uDisColorEdge;  // the burning edge
  uniform vec3  uDisColorEmber; // a chunk lighting up as it lets go
  uniform float uDisGlow;
#endif
`;

/**
 * The vertex half. Two entry points because three computes the normal before it
 * computes the position, and the chunk has to be able to turn both.
 */
const DISSOLVE_VERTEX = /* glsl */ `
#ifndef DISSOLVE_VERTEX_INCLUDED
#define DISSOLVE_VERTEX_INCLUDED
  varying float vDisK;        // 0..1 — how far through letting go this chunk is
  varying float vDisRung;     // which rung claimed it
  varying float vDisRand;     // its own die
  varying vec3  vDisLocal;    // rest position, object space
  varying vec3  vDisWorld;    // rest position, world space

  /* Filled by dissolveResolve(), read by the two appliers. Globals rather than
     out-params so the two injection sites can share one evaluation. */
  vec3  gDisCentre;
  vec3  gDisAxis;
  float gDisAngle;
  float gDisK;
  float gDisCell;

  vec3 disSpin(vec3 v, vec3 axis, float a) {
    float c = cos(a);
    float s = sin(a);
    return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
  }

  /**
   * Walk the ladder and find the cell that owns this vertex.
   *
   * Runs once per vertex. The claim depends on nothing but the rest position and
   * the hashes, so it is stable for the whole cast — which is the property the
   * sliding-cell-size version did not have and the reason it reshuffled.
   */
  void dissolveResolve(vec3 rest) {
    gDisK = 0.0;
    gDisCell = uDisCell;
    gDisCentre = rest;
    gDisAxis = vec3(0.0, 1.0, 0.0);
    gDisAngle = 0.0;
    vDisRung = 0.0;
    vDisRand = 0.0;
    if (uDisVoxel <= 0.001) return;

    float rungs = max(uDisRungs, 1.0);
    float cell = max(uDisCell, 1e-4);

    for (int r = 0; r < DISSOLVE_RUNGS; r++) {
      float rf = float(r);
      if (rf >= rungs) break;
      float s = cell * exp2(rf);
      vec3 id = floor(rest / s);
      float pick = hash13(id * 0.731 + vec3(rf * 19.7 + uDisSeed));
      // The last rung claims whatever is left, or material with an unlucky hash
      // would survive the dissolve entirely and hang in the air for ever.
      float last = step(rungs - 1.5, rf);
      if (pick < uDisTake || last > 0.5) {
        float when = (rf + hash13(id * 1.317 + vec3(rf * 7.3 + uDisSeed + 31.0))) / rungs;
        gDisK = clamp((uDisProgress - when) / max(uDisSpan, 1e-3), 0.0, 1.0);
        gDisCell = s;
        gDisCentre = (id + 0.5) * s;
        float a0 = hash13(id + vec3(uDisSeed + 3.1));
        float a1 = hash13(id + vec3(uDisSeed + 8.9));
        gDisAxis = normalize(vec3(a0 - 0.5, a1 - 0.5, hash13(id + vec3(uDisSeed + 15.7)) - 0.5) +
                             vec3(1e-4, 1.0, 1e-4) * 0.001);
        gDisAngle = uDisTumble * gDisK * gDisK;
        vDisRung = rf;
        vDisRand = a0;
        break;
      }
    }
    vDisK = gDisK;
  }

  /** The normal turns with the chunk. Called from beginnormal_vertex. */
  vec3 dissolveNormal(vec3 n) {
    if (gDisAngle == 0.0) return n;
    return disSpin(n, gDisAxis, gDisAngle);
  }

  /** The position. Called from begin_vertex, after dissolveResolve(). */
  vec3 dissolveVertex(vec3 p, float time) {
    if (gDisK <= 0.0) return p;
    float k = gDisK;

    // Cube it. Snapping to a sub-lattice is what turns a detached chunk into a
    // *cube*: coplanar faces become axis-aligned steps and the silhouette goes
    // blocky. The mix ramps in over the first sliver of the chunk's life so the
    // surface does not visibly crystallise before it has started to move.
    float grid = max(gDisCell * uDisFacet, 1e-5);
    vec3 snapped = floor(p / grid + 0.5) * grid;
    p = mix(p, snapped, clamp(uDisBlock, 0.0, 1.0) * smoothstep(0.0, 0.18, k));

    // Turn about its own centre.
    p = gDisCentre + disSpin(p - gDisCentre, gDisAxis, gDisAngle);

    // Then let it go. Drift on k, the fall on k squared — one is a push and the
    // other is gravity, and giving them the same curve is why an early version
    // looked like the cubes were on strings.
    vec3 jitter = vec3(hash13(gDisCentre * 3.7 + uDisSeed) - 0.5,
                       hash13(gDisCentre * 5.1 + uDisSeed + 4.0) - 0.5,
                       hash13(gDisCentre * 7.3 + uDisSeed + 9.0) - 0.5);
    vec3 dir = normalize(jitter + uDisDriftBias + vec3(1e-5, 1e-5, 1e-5));
    p += dir * (uDisDrift * k);
    p += vec3(0.0, uDisLift * k - uDisGravity * k * k, 0.0);
    p += jitter * (uDisWobble * k * sin(time * uDisWobbleRate + jitter.x * 20.0));

    // Wink out: scale to nothing about the cell centre so the chunk vanishes
    // whole. Collapsing it toward the object's origin instead leaves a spray of
    // stretched triangles crossing the model, which is what the first one did.
    float shrink = 1.0 - smoothstep(clamp(uDisHold, 0.0, 0.98), 1.0, k);
    p = gDisCentre + (p - gDisCentre) * shrink;
    return p;
  }
#endif
`;

/**
 * The fragment half: the threshold, the burning edge and the ember on a chunk
 * that has just let go.
 */
const DISSOLVE_FRAGMENT = /* glsl */ `
#ifndef DISSOLVE_FRAGMENT_INCLUDED
#define DISSOLVE_FRAGMENT_INCLUDED
  varying float vDisK;
  varying float vDisRung;
  varying float vDisRand;
  varying vec3  vDisLocal;
  varying vec3  vDisWorld;

  /**
   * The erosion field.
   *
   * Sampled in local or world space by a mix, not a branch: both are already
   * varyings, the compiler folds one away when the uniform is constant, and a
   * branch here costs more than the lerp does.
   */
  float dissolveField(out float threshold) {
    vec3 sp = mix(vDisLocal, vDisWorld, clamp(uDisSpace, 0.0, 1.0));
    vec3 q = sp * max(uDisNoiseScale, 1e-3);
    // One warp octave: an unwarped fbm threshold gives round holes, and round
    // holes read as a texture. Warped, the holes get the ragged re-entrant edge
    // that says something is eating this.
    q += uDisWarp * uDisNoiseScale * vec3(snoise(q * 0.7 + 11.0), snoise(q * 0.7 + 27.0), 0.0);
    float n = fbm3(q) * 0.5 + 0.5;
    // The threshold sweeps past 1 + edge so the last of the surface goes too,
    // and the directional bias turns a rash into a front.
    float sweep = uDisProgress * (1.0 + uDisEdge * 2.0) - uDisEdge;
    threshold = sweep + dot(sp, uDisBiasDir) * uDisBiasAmount;
    return n;
  }
#endif
`;

/**
 * Exported so a bespoke `ShaderMaterial` can inject the same chunks by hand.
 *
 * Inject `noiseGLSL` **first** — these chunks call `hash13`, `snoise` and
 * `fbm3` and do not carry them, because a material that already has the noise
 * library would otherwise get it twice. All three are `#ifndef`-guarded, so
 * injecting them into a material that `patchDissolveMaterial()` has also
 * touched compiles; it will, however, displace the vertex twice, which is a
 * different mistake and one you can see.
 */
export const DISSOLVE_GLSL = Object.freeze({
  uniforms: DISSOLVE_UNIFORMS,
  vertex: DISSOLVE_VERTEX,
  fragment: DISSOLVE_FRAGMENT
});

/**
 * Build a uniform box for the patch.
 *
 * **Share it by identity** across every material that should dissolve as one
 * event — that is the whole reason it is a separate function rather than
 * something the patch hides. One `syncDissolve()` then drives nine draw calls'
 * worth of standing ice, and because three stores uniforms as `{ value }` boxes
 * it costs one write, not nine.
 *
 * @param {object} [overrides] any key of `dissolveParams()`
 */
export function dissolveUniforms(overrides = {}) {
  const p = { ...DISSOLVE_DEFAULTS, ...overrides };
  return {
    uDisProgress: { value: p.progress },
    uDisSeed: { value: p.seed },
    uDisSpace: { value: p.space },

    uDisVoxel: { value: p.voxel },
    uDisCell: { value: p.cell },
    uDisRungs: { value: p.rungs },
    uDisTake: { value: p.take },
    uDisSpan: { value: p.span },
    uDisBlock: { value: p.block },
    uDisFacet: { value: p.facet },
    uDisHold: { value: p.hold },
    uDisDrift: { value: p.drift },
    uDisDriftBias: { value: new Vector3(p.driftBiasX, p.driftBiasY, p.driftBiasZ) },
    uDisLift: { value: p.lift },
    uDisGravity: { value: p.gravity },
    uDisTumble: { value: p.tumble },
    uDisWobble: { value: p.wobble },
    uDisWobbleRate: { value: p.wobbleRate },

    uDisErode: { value: p.erode },
    uDisNoiseScale: { value: p.noiseScale },
    uDisWarp: { value: p.warp },
    uDisEdge: { value: p.edge },
    uDisBiasDir: { value: new Vector3(p.biasX, p.biasY, p.biasZ) },
    uDisBiasAmount: { value: p.biasAmount },

    uDisColorEdge: { value: new Color(p.colorEdge) },
    uDisColorEmber: { value: new Color(p.colorEmber) },
    uDisGlow: { value: p.glow }
  };
}

/**
 * Push a live params block into a uniform box.
 *
 * @param {object} target the box from `dissolveUniforms()`, or a material that
 *   was patched (its box is on `material.userData.uniforms`)
 * @param {object} params live block; anything absent falls back to
 *   `dissolveParams()`
 */
export function syncDissolve(target, params) {
  const u = target?.userData?.uniforms ?? target;
  if (!u || !u.uDisProgress) return target;
  const p = params ?? DISSOLVE_DEFAULTS;
  const num = (key) => (p[key] === undefined ? DISSOLVE_DEFAULTS[key] : p[key]);

  u.uDisProgress.value = num('progress');
  u.uDisSeed.value = num('seed');
  u.uDisSpace.value = num('space');

  u.uDisVoxel.value = num('voxel');
  u.uDisCell.value = num('cell');
  u.uDisRungs.value = Math.max(1, Math.min(MAX_RUNGS, Math.round(num('rungs'))));
  u.uDisTake.value = num('take');
  u.uDisSpan.value = num('span');
  u.uDisBlock.value = num('block');
  u.uDisFacet.value = num('facet');
  u.uDisHold.value = num('hold');
  u.uDisDrift.value = num('drift');
  u.uDisDriftBias.value.set(num('driftBiasX'), num('driftBiasY'), num('driftBiasZ'));
  u.uDisLift.value = num('lift');
  u.uDisGravity.value = num('gravity');
  u.uDisTumble.value = num('tumble');
  u.uDisWobble.value = num('wobble');
  u.uDisWobbleRate.value = num('wobbleRate');

  u.uDisErode.value = num('erode');
  u.uDisNoiseScale.value = num('noiseScale');
  u.uDisWarp.value = num('warp');
  u.uDisEdge.value = num('edge');
  u.uDisBiasDir.value.set(num('biasX'), num('biasY'), num('biasZ'));
  u.uDisBiasAmount.value = num('biasAmount');

  putColor(u.uDisColorEdge.value, p.colorEdge, DISSOLVE_DEFAULTS.colorEdge);
  putColor(u.uDisColorEmber.value, p.colorEmber, DISSOLVE_DEFAULTS.colorEmber);
  u.uDisGlow.value = num('glow');
  return target;
}

/**
 * Inject `VOXEL` and `EROSION` into a built-in material.
 *
 * Works on anything three compiles from chunks — `MeshStandardMaterial` is the
 * one it was written against and the one the abilities use. Chunks that are
 * missing from a simpler material (`MeshBasicMaterial` has no
 * `<beginnormal_vertex>` and no `<emissivemap_fragment>`) are **skipped rather
 * than warned about**: the dissolve still cuts and still drifts, it just does
 * not turn the normal or add the ember, and that is a reasonable thing for a
 * basic material to do.
 *
 * Patching is composed through `patchOnBeforeCompile`, so this does not clobber
 * a shadow-caster patch or CSM.
 *
 * @param {THREE.Material} material the caller's material. Mutated and returned.
 * @param {object} [options]
 * @param {number} [options.mode] `DissolveMode.VOXEL` or `.EROSION` — sets which
 *   half starts switched on. Both can run at once; the mode is a starting point,
 *   not an exclusion.
 * @param {number} [options.space] `DissolveSpace.*` for the erosion field
 * @param {object} [options.uniforms] an existing box from `dissolveUniforms()`
 *   to **share by identity**. Pass one and several materials dissolve as one
 *   event. Omit it and the material gets its own.
 * @param {object} [options.environment] if given, the patch is registered with
 *   the shadow caster too, so a dissolving mesh's shadow dissolves with it
 * @param {string} [options.vertex] extra GLSL after the displacement
 * @param {string} [options.fragment] extra GLSL after the edge
 */
export function patchDissolveMaterial(material, options = {}) {
  const {
    mode = DissolveMode.VOXEL,
    space = DissolveSpace.LOCAL,
    uniforms = null,
    environment = null,
    vertex = '',
    fragment = ''
  } = options;

  const box =
    uniforms ??
    dissolveUniforms({
      space,
      voxel: mode === DissolveMode.EROSION ? 0 : 1,
      erode: mode === DissolveMode.VOXEL ? 0 : 1
    });

  const patch = (shader) => {
    Object.assign(shader.uniforms, box);

    shader.vertexShader = replaceChunk(
      shader.vertexShader,
      '#include <common>',
      `#include <common>
       ${noiseGLSL}
       ${DISSOLVE_UNIFORMS}
       ${DISSOLVE_VERTEX}`
    );

    // Normals first: three resolves them before it touches the position, so
    // where the material has normals at all the ladder is walked there and the
    // result kept in the globals. A global with no initialiser is *not*
    // guaranteed to be zero in GLSL ES, so which site resolves is decided here,
    // on the JavaScript side, rather than guarded by a runtime test.
    const hasNormals = shader.vertexShader.includes('#include <beginnormal_vertex>');
    if (hasNormals) {
      shader.vertexShader = replaceChunk(
        shader.vertexShader,
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         dissolveResolve(position);
         objectNormal = dissolveNormal(objectNormal);`
      );
    }

    shader.vertexShader = replaceChunk(
      shader.vertexShader,
      '#include <begin_vertex>',
      `#include <begin_vertex>
       ${hasNormals ? '' : 'dissolveResolve(position);'}
       vDisLocal = position;
       #ifdef USE_INSTANCING
         vDisWorld = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
       #else
         vDisWorld = (modelMatrix * vec4(position, 1.0)).xyz;
       #endif
       transformed = dissolveVertex(transformed, uTimeDis);
       ${vertex}`
    );

    // uTime is not a uniform of a built-in material, and adding one named uTime
    // risks colliding with somebody else's patch. The wobble reads this alias.
    shader.vertexShader = `uniform float uTimeDis;\n${shader.vertexShader}`;
    shader.uniforms.uTimeDis = frame.uTime;

    shader.fragmentShader = replaceChunk(
      shader.fragmentShader,
      '#include <common>',
      `#include <common>
       ${noiseGLSL}
       ${DISSOLVE_UNIFORMS}
       ${DISSOLVE_FRAGMENT}`
    );

    // The cut goes as early as three will let it, before any lighting is paid
    // for. clipping_planes_fragment is in every material and is the first thing
    // in main().
    shader.fragmentShader = replaceChunk(
      shader.fragmentShader,
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>
       float disThreshold;
       float disNoise = dissolveField(disThreshold);
       float disCut = mix(1.0, step(disThreshold, disNoise), clamp(uDisErode, 0.0, 1.0));
       float disEdge = clamp(uDisErode, 0.0, 1.0) *
                       (1.0 - smoothstep(disThreshold, disThreshold + max(uDisEdge, 1e-4), disNoise)) *
                       disCut;
       if (disCut < 0.5) discard;
       if (vDisK >= 0.999) discard;`
    );

    if (shader.fragmentShader.includes('#include <emissivemap_fragment>')) {
      shader.fragmentShader = replaceChunk(
        shader.fragmentShader,
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           // A chunk lights up as it lets go — the ember peaks in the middle of
           // its fall and is gone by the time it has shrunk away, so the eye
           // gets told which pieces are leaving.
           float ember = uDisVoxel * sin(clamp(vDisK, 0.0, 1.0) * ${PI.toFixed(7)}) ;
           totalEmissiveRadiance += uDisColorEmber * ember * uDisGlow;
           totalEmissiveRadiance += uDisColorEdge * disEdge * uDisGlow;
           ${fragment}
         }`
      );
    }
  };

  if (environment && typeof environment.registerShadowCasterWithPatch === 'function') {
    environment.registerShadowCasterWithPatch(material, patch);
  } else {
    patchOnBeforeCompile(material, patch);
  }

  // I8. Without this the harness's pause test cannot see any of these sliders
  // and reports every one of them as dead.
  material.userData.uniforms = { ...(material.userData.uniforms ?? {}), ...box };
  material.userData.dissolve = box;
  return material;
}

/**
 * Canonical names for the patch, with defaults and units.
 *
 * Hand the whole thing to `syncDissolve()` every frame, or fill a scratch from
 * `settings[id]`. Nothing here is captured — that is the point.
 */
export function dissolveParams() {
  return {
    /* --- the one slider --- */
    progress: 0, // 0 intact, 1 gone
    seed: 0, // per-cast; shifts every hash
    space: DissolveSpace.LOCAL, // where the erosion field is nailed down

    /* --- VOXEL --- */
    voxel: 1, // 0..1 — how much of the cube behaviour is on
    cell: 0.12, // metres — the FINEST cube. Everything else is 2^r of this.
    rungs: 4, // doublings; 4 means the last cubes are 8× the first
    take: 0.55, // fraction of cells a rung claims before handing on
    span: 0.22, // progress units one cell takes to let go
    block: 0.7, // 0..1 — how far a chunk snaps to the lattice. 0 is a shatter.
    facet: 0.5, // sub-lattice size as a fraction of the cell
    hold: 0.45, // 0..1 of a chunk's life before it starts shrinking away
    drift: 0.9, // metres a chunk travels
    driftBiasX: 0, // unitless direction preference…
    driftBiasY: 0.35, // …0.35 up reads as "lifting off" rather than "exploding"
    driftBiasZ: 0,
    lift: 0.35, // metres up, linear in k
    gravity: 0.8, // metres of fall, on k squared
    tumble: 1.6, // radians a chunk turns before it goes
    wobble: 0.06, // metres of hashed wander
    wobbleRate: 5.5, // radians/second

    /* --- EROSION --- */
    erode: 0, // 0..1 — how much of the threshold behaviour is on
    noiseScale: 2.4, // features per metre
    warp: 0.35, // metres of domain warp — the ragged re-entrant edge
    edge: 0.12, // width of the burning band, noise units
    biasX: 0, // a front instead of a rash: which way it sweeps
    biasY: 0,
    biasZ: 0,
    biasAmount: 0, // threshold shift per metre along that direction

    /* --- colour: two pickers, neither derived --- */
    colorEdge: '#ff9a3c', // the burning edge
    colorEmber: '#a06bff', // a chunk letting go
    glow: 1.2
  };
}

/** Resolved once at module load. */
const DISSOLVE_DEFAULTS = dissolveParams();

/* ---------------------------------------------------------------------- */
/* GRANULAR: the heap                                                      */
/* ---------------------------------------------------------------------- */

/**
 * The heap, shared by the vertex shader and by nothing else — but written as its
 * own chunk because it is the part of this file worth reading twice.
 */
const HEAP_GLSL = /* glsl */ `
  #define MAX_LOBES ${MAX_LOBES}

  uniform float uNow;          // the ability's age, seconds
  uniform float uSeed;
  uniform float uLobes;        // lobes alive at once, 1..MAX_LOBES
  uniform float uRate;         // lobes released per second
  uniform float uFrontSpeed;   // m/s the release point advances
  uniform float uVolume;       // cubic metres per lobe
  uniform float uVolumeJitter; // ±fraction
  uniform float uRepose;       // radians — the angle it refuses to exceed
  uniform float uExcess;       // radians above repose at release
  uniform float uSlump;        // 1/s the excess decays at
  uniform float uCreep;        // m/s the lobe's centroid crawls forward
  uniform float uScatter;      // metres of lateral scatter on release
  uniform float uWiden;        // >1 stretches a lobe across the line
  uniform float uBed;          // metres — the settled deposit left behind
  uniform float uBedRamp;      // metres the bed takes to reach full depth
  uniform float uBedWidth;     // metres, half-width of the bed
  uniform float uBedCurve;     // how sharply the bed thins toward its edges

  /**
   * Height of the heap at q = (metres along the cast, metres across it).
   *
   * The upper envelope of a train of collapsing cones. See the module header for
   * why it is a max and not a sum, and why a lobe is identified by its release
   * ordinal rather than by its slot in this loop.
   */
  float heapAt(vec2 q, out float age, out float slope, out vec2 towards) {
    float best = 0.0;
    age = 0.0;
    slope = uRepose;
    towards = vec2(0.0, 1.0);

    float ordNow = uNow * max(uRate, 1e-3);
    for (int k = 0; k < MAX_LOBES; k++) {
      float kf = float(k);
      if (kf >= uLobes) break;
      float m = floor(ordNow) - kf;      // release ordinal: this lobe's identity
      if (m < 0.0) continue;

      float birth = m / max(uRate, 1e-3);
      float a = uNow - birth;
      if (a < 0.0) continue;

      float d1 = hash11(m * 1.71 + uSeed);
      float d2 = hash11(m * 3.19 + uSeed + 11.0);

      // Over-steep at release, relaxing back toward repose. With the volume
      // held, that alone makes the lobe get shorter and wider — the collapse is
      // not animated, it is what conservation does to a decaying slope.
      float s = clamp(uRepose + uExcess * exp(-uSlump * a), 0.06, 1.45);
      float tn = tan(s);
      float vol = max(uVolume * (1.0 + (d1 - 0.5) * 2.0 * uVolumeJitter), 1e-5);
      float H = pow(3.0 * vol * tn * tn / PI, 1.0 / 3.0);

      vec2 centre = vec2(birth * uFrontSpeed + uCreep * a,
                         (d2 - 0.5) * 2.0 * uScatter);
      vec2 off = (q - centre) * vec2(1.0, 1.0 / max(uWiden, 0.05));
      float dist = length(off);
      float h = max(0.0, H - tn * dist);
      if (h > best) {
        best = h;
        age = a;
        slope = s;
        towards = dist > 1e-4 ? off / dist : vec2(0.0, 1.0);
      }
    }

    // The settled deposit the train leaves behind it. Without it the tail
    // vanishes as lobes age out of the window and the avalanche is a comet.
    float front = uNow * uFrontSpeed;
    float behind = smoothstep(0.0, max(uBedRamp, 1e-3), front - q.x);
    float across = 1.0 - clamp(abs(q.y) / max(uBedWidth, 1e-3), 0.0, 1.0);
    float bed = uBed * behind * pow(across, max(uBedCurve, 0.05));
    return max(best, bed);
  }
`;

const HEAP_VERTEX = /* glsl */ `
  #define PI 3.141592653589793

  uniform vec3  uOrigin;
  uniform vec3  uForward;
  uniform vec3  uSide;
  uniform float uLength;      // metres of cast the sheet covers
  uniform float uHalfWidth;   // metres either side of the line
  uniform float uFloor;       // metres — the y the heap sits on
  uniform float uHeightGain;  // multiplier on the whole heap

  ${noiseGLSL}
  ${HEAP_GLSL}

  attribute vec2 aGrid;       // (along 0..1, across -0.5..0.5)

  varying vec3  vWorld;
  varying vec3  vNormal;
  varying vec2  vLocal;       // metres (along, across)
  varying float vHeight;      // metres
  varying float vAge;         // seconds since the winning lobe was released
  varying float vSlope;       // radians of the winning lobe's face
  varying float vFlow;        // 0..1 — how far above repose that face is

  void main() {
    vec2 q = vec2(aGrid.x * uLength, aGrid.y * 2.0 * uHalfWidth);

    float age;
    float slope;
    vec2 towards;
    float h = heapAt(q, age, slope, towards) * uHeightGain;

    // The envelope is not differentiable at its ridges, and that is not an
    // artefact — a heap has ridges. So the normal is a forward difference at the
    // grid's own scale, which shades a ridge as the crease it actually is
    // instead of rounding it away.
    float eps = max(uLength / 96.0, 0.02);
    float a2;
    float s2;
    vec2 t2;
    float hx = heapAt(q + vec2(eps, 0.0), a2, s2, t2) * uHeightGain;
    float hz = heapAt(q + vec2(0.0, eps), a2, s2, t2) * uHeightGain;
    vec3 nLocal = normalize(vec3(-(hx - h) / eps, 1.0, -(hz - h) / eps));

    vec3 world = uOrigin + uForward * q.x + uSide * q.y;
    world.y = uFloor + h;

    vWorld = world;
    vNormal = normalize(uForward * nLocal.x + vec3(0.0, nLocal.y, 0.0) + uSide * nLocal.z);
    vLocal = q;
    vHeight = h;
    vAge = age;
    vSlope = slope;
    vFlow = clamp((slope - uRepose) / max(uExcess, 1e-3), 0.0, 1.0);

    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const HEAP_FRAGMENT = /* glsl */ `
  #define PI 3.141592653589793

  uniform vec3  uLightDir;
  uniform float uShaderIntensity;

  uniform vec3  uColorFresh;    // just-collapsed material at the front
  uniform vec3  uColorSettled;  // the tail, hours old in avalanche seconds
  uniform vec3  uColorFace;     // the slip face, actively moving
  uniform vec3  uColorDeep;     // shadow inside the heap
  uniform float uAmbient;
  uniform float uWrap;          // how far light bends round a translucent grain
  uniform float uFresh;         // seconds a lobe counts as fresh for
  uniform float uGrain;
  uniform float uGrainScale;    // grains per metre
  uniform float uGlint;         // pinpoint sparkle — snow, not sand
  uniform float uGlintScale;
  uniform float uToe;           // metres of height the heap fades out over
  uniform float uOpacity;

  ${noiseGLSL}

  varying vec3  vWorld;
  varying vec3  vNormal;
  varying vec2  vLocal;
  varying float vHeight;
  varying float vAge;
  varying float vSlope;
  varying float vFlow;

  void main() {
    if (vHeight <= 0.0005) discard;

    vec3 N = normalize(vNormal);
    vec3 L = normalize(uLightDir);
    vec3 V = normalize(cameraPosition - vWorld);

    float ndl = dot(N, L);
    float diffuse = clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0);

    // Grains on a hashed lattice, not a noise threshold: value noise piles up
    // at its midpoint, so thresholding it gives either nothing or a rash.
    vec3 cell = floor(vWorld * max(uGrainScale, 1.0));
    float grain = hash13(cell);
    // The glint sits on its own, finer lattice: tie it to the grain and every
    // sparkle lands in the middle of a speckle and the snow reads as glitter
    // paper. They are different physical scales and they need different cells.
    vec3 glintCell = floor(vWorld * max(uGlintScale, 1.0));
    float glint = step(0.9955, hash13(glintCell * 1.37 + 3.0)) *
                  step(0.55, pow(clamp(dot(N, normalize(L + V)), 0.0, 1.0), 40.0)) * uGlint;

    float fresh = 1.0 - clamp(vAge / max(uFresh, 1e-3), 0.0, 1.0);
    vec3 body = mix(uColorSettled, uColorFresh, fresh);
    // The slip face is the part still above repose: it is the moving surface and
    // it is the only part of an avalanche that looks like it is going anywhere.
    body = mix(body, uColorFace, vFlow);
    body = mix(uColorDeep, body, diffuse);
    body *= 1.0 + (grain - 0.5) * 2.0 * uGrain;
    body += vec3(glint);
    body *= uAmbient + (1.0 - uAmbient) * uShaderIntensity;

    // The toe: a heap does not end at a hard line on the floor, it thins out.
    float alpha = uOpacity * smoothstep(0.0, max(uToe, 1e-4), vHeight);

    gl_FragColor = vec4(max(body, vec3(0.0)), clamp(alpha, 0.0, 1.0));
  }
`;

/**
 * The granular heap. One mesh, one draw call, no state.
 *
 * Parent-first, like `GroundField` — it owns its mesh and you never see it.
 */
export class DissolveField {
  /**
   * @param {THREE.Object3D} parent the ability's group
   * @param {object} [options]
   * @param {number} [options.along] grid resolution down the cast. The lobes are
   *   metres across, so this is what decides whether a ridge is a ridge or a
   *   staircase; 96 is generous and 48 is honest.
   * @param {number} [options.across] grid resolution across it
   */
  constructor(parent, options = {}) {
    const {
      along = 72,
      across = 40,
      renderOrder = 3,
      layer = LAYER.WORLD,
      name = 'DissolveField'
    } = options;

    this.group = new Group();
    this.group.name = name;
    this.group.matrixAutoUpdate = false;
    parent.add(this.group);

    /* --- the grid ---------------------------------------------------- */
    const nx = Math.max(2, along | 0);
    const nz = Math.max(2, across | 0);
    const vertices = (nx + 1) * (nz + 1);
    const grid = new Float32Array(vertices * 2);
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const o = (j * (nx + 1) + i) * 2;
        grid[o] = i / nx; // along, 0..1
        grid[o + 1] = j / nz - 0.5; // across, -0.5..0.5
      }
    }
    const indices = new Uint32Array(nx * nz * 6);
    let w = 0;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i;
        const b = a + 1;
        const c = a + nx + 1;
        const d = c + 1;
        indices[w++] = a;
        indices[w++] = c;
        indices[w++] = b;
        indices[w++] = b;
        indices[w++] = c;
        indices[w++] = d;
      }
    }

    const geometry = new BufferGeometry();
    // The vertex shader needs no `position`, but three wants one to exist and
    // every downstream chunk assumes it does.
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices * 3), 3));
    geometry.setAttribute('aGrid', new BufferAttribute(grid, 2));
    geometry.setIndex(new BufferAttribute(indices, 1));
    // Placed in world space by the vertex shader; its own bounds mean nothing.
    geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    this.geometry = geometry;

    this.material = new ShaderMaterial({
      name,
      transparent: true,
      depthWrite: true,
      depthTest: true,
      side: DoubleSide,
      toneMapped: true,
      uniforms: sharedUniforms({
        uNow: { value: 0 },
        uSeed: { value: 0 },

        uOrigin: { value: new Vector3() },
        uForward: { value: new Vector3(0, 0, 1) },
        uSide: { value: new Vector3(1, 0, 0) },
        uLength: { value: 12 },
        uHalfWidth: { value: HEAP_DEFAULTS.halfWidth },
        uFloor: { value: HEAP_DEFAULTS.floor },
        uHeightGain: { value: HEAP_DEFAULTS.heightGain },

        uLobes: { value: HEAP_DEFAULTS.lobes },
        uRate: { value: HEAP_DEFAULTS.rate },
        uFrontSpeed: { value: HEAP_DEFAULTS.frontSpeed },
        uVolume: { value: HEAP_DEFAULTS.volume },
        uVolumeJitter: { value: HEAP_DEFAULTS.volumeJitter },
        uRepose: { value: HEAP_DEFAULTS.repose },
        uExcess: { value: HEAP_DEFAULTS.excess },
        uSlump: { value: HEAP_DEFAULTS.slump },
        uCreep: { value: HEAP_DEFAULTS.creep },
        uScatter: { value: HEAP_DEFAULTS.scatter },
        uWiden: { value: HEAP_DEFAULTS.widen },
        uBed: { value: HEAP_DEFAULTS.bed },
        uBedRamp: { value: HEAP_DEFAULTS.bedRamp },
        uBedWidth: { value: HEAP_DEFAULTS.bedWidth },
        uBedCurve: { value: HEAP_DEFAULTS.bedCurve },

        uColorFresh: { value: new Color(HEAP_DEFAULTS.colorFresh) },
        uColorSettled: { value: new Color(HEAP_DEFAULTS.colorSettled) },
        uColorFace: { value: new Color(HEAP_DEFAULTS.colorFace) },
        uColorDeep: { value: new Color(HEAP_DEFAULTS.colorDeep) },
        uAmbient: { value: HEAP_DEFAULTS.ambient },
        uWrap: { value: HEAP_DEFAULTS.wrap },
        uFresh: { value: HEAP_DEFAULTS.fresh },
        uGrain: { value: HEAP_DEFAULTS.grain },
        uGrainScale: { value: HEAP_DEFAULTS.grainScale },
        uGlint: { value: HEAP_DEFAULTS.glint },
        uGlintScale: { value: HEAP_DEFAULTS.glintScale },
        uToe: { value: HEAP_DEFAULTS.toe },
        uOpacity: { value: HEAP_DEFAULTS.opacity }
      }),
      vertexShader: HEAP_VERTEX,
      fragmentShader: HEAP_FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.layers.set(layer);
    this.mesh.renderOrder = renderOrder;
    this.group.add(this.mesh);

    this._origin = new Vector3();
    this._direction = new Vector3(0, 0, 1);
    this._side = new Vector3(1, 0, 0);
    this._length = 1;
    this._p = heapParams();
    this.seed = 0;
  }

  get uniforms() {
    return this.material.uniforms;
  }

  /** One, however deep the heap. */
  get drawCalls() {
    return 1;
  }

  get visible() {
    return this.group.visible;
  }

  set visible(v) {
    this.group.visible = !!v;
  }

  /** The cast's frame. Called once per frame by the ability. */
  setBasis(origin, direction, side, length) {
    this._origin.copy(origin);
    this._direction.copy(direction);
    this._side.copy(side);
    this._length = Math.max(0.01, length);
    return this;
  }

  /**
   * Re-seed the lobe train. Call from `onSpawn` and nowhere else.
   *
   * The seed is the only thing the heap carries. Everything else — where each
   * lobe was released, how big it was, how far it has collapsed — is a function
   * of `now` and the live params, which is why dragging `repose` on a paused
   * avalanche flattens it.
   */
  roll(seed = Math.random() * 100) {
    this.seed = seed;
    this.material.uniforms.uSeed.value = seed;
    return this;
  }

  /** Hide the heap. Leaves the instance reusable — the pooling contract. */
  reset() {
    this.mesh.visible = false;
    this.material.uniforms.uNow.value = 0;
    return this;
  }

  /** Four pickers, none derived from another. */
  setColors(fresh, settled, face, deep) {
    const u = this.material.uniforms;
    putColor(u.uColorFresh.value, fresh, HEAP_DEFAULTS.colorFresh);
    putColor(u.uColorSettled.value, settled, HEAP_DEFAULTS.colorSettled);
    putColor(u.uColorFace.value, face, HEAP_DEFAULTS.colorFace);
    putColor(u.uColorDeep.value, deep, HEAP_DEFAULTS.colorDeep);
    return this;
  }

  /** Fill `_p` from the caller's block, defaults where it is silent. */
  _resolve(params) {
    const p = this._p;
    for (const key in HEAP_DEFAULTS) {
      const value = params[key];
      p[key] = value === undefined ? HEAP_DEFAULTS[key] : value;
    }
    return p;
  }

  /**
   * @param {number} now seconds since the cast began — **this one is used**.
   *   The lobe train is an event with a start, unlike a flock or a curtain, so
   *   it runs on the ability's own clock and not on the shared `uTime`.
   * @param {object} params live block; anything absent falls back to
   *   `heapParams()`
   */
  update(now, params) {
    const p = this._resolve(params ?? HEAP_DEFAULTS);
    const u = this.material.uniforms;

    u.uNow.value = now;
    u.uOrigin.value.copy(this._origin);
    u.uForward.value.copy(this._direction);
    u.uSide.value.copy(this._side);
    u.uLength.value = this._length;
    u.uHalfWidth.value = p.halfWidth;
    u.uFloor.value = p.floor;
    u.uHeightGain.value = p.heightGain;

    u.uLobes.value = Math.max(1, Math.min(MAX_LOBES, Math.round(p.lobes)));
    u.uRate.value = p.rate;
    u.uFrontSpeed.value = p.frontSpeed;
    u.uVolume.value = p.volume;
    u.uVolumeJitter.value = p.volumeJitter;
    u.uRepose.value = p.repose;
    u.uExcess.value = p.excess;
    u.uSlump.value = p.slump;
    u.uCreep.value = p.creep;
    u.uScatter.value = p.scatter;
    u.uWiden.value = p.widen;
    u.uBed.value = p.bed;
    u.uBedRamp.value = p.bedRamp;
    u.uBedWidth.value = p.bedWidth;
    u.uBedCurve.value = p.bedCurve;

    u.uAmbient.value = p.ambient;
    u.uWrap.value = p.wrap;
    u.uFresh.value = p.fresh;
    u.uGrain.value = p.grain;
    u.uGrainScale.value = p.grainScale;
    u.uGlint.value = p.glint;
    u.uGlintScale.value = p.glintScale;
    u.uToe.value = p.toe;
    u.uOpacity.value = p.opacity;

    this.mesh.visible = p.opacity > 0 && p.heightGain > 0;
    return this;
  }

  /**
   * Where the release point is right now, on the floor, in world space.
   *
   * The CPU mirror of the front — the ability hangs the dust plume, the light
   * and the shake on it. Mirror, so if you change one change the other.
   */
  frontPoint(now, p, out) {
    const speed = p?.frontSpeed ?? HEAP_DEFAULTS.frontSpeed;
    const along = Math.min(now * speed, this._length);
    return out
      .copy(this._origin)
      .addScaledVector(this._direction, along)
      .setY((p?.floor ?? HEAP_DEFAULTS.floor) + (p?.bed ?? HEAP_DEFAULTS.bed));
  }

  /**
   * Height of the youngest lobe, in metres — the CPU mirror of the crest.
   *
   * Only the newest lobe, because that is the one an ability wants (it is where
   * the crest is), and mirroring the whole envelope on the CPU would be a second
   * implementation of the thing this module exists to keep in one place.
   */
  crestHeight(now, p) {
    const c = p ?? HEAP_DEFAULTS;
    const rate = Math.max(c.rate ?? HEAP_DEFAULTS.rate, 1e-3);
    const age = (now * rate - Math.floor(now * rate)) / rate;
    const slope = Math.max(
      0.06,
      Math.min(1.45, (c.repose ?? 0.6) + (c.excess ?? 0.2) * Math.exp(-(c.slump ?? 2) * age))
    );
    const tn = Math.tan(slope);
    const volume = Math.max(c.volume ?? HEAP_DEFAULTS.volume, 1e-5);
    return Math.cbrt((3 * volume * tn * tn) / PI) * (c.heightGain ?? 1);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.group.parent?.remove(this.group);
  }
}

/**
 * Canonical names for the heap, with defaults and units.
 *
 * The defaults are a snow avalanche: a 33° repose angle (dry snow sits between
 * 30° and 38°), released a few times a second, over-steep by 12° and relaxing
 * within half a second.
 */
export function heapParams() {
  return {
    /* --- the footprint --- */
    halfWidth: 3.2, // metres either side of the cast line the sheet covers
    floor: 0.005, // metres — the y the heap sits on. Off zero to beat the floor.
    heightGain: 1, // multiplier on the whole heap

    /* --- the lobe train --- */
    lobes: 16, // lobes alive at once, ≤ MAX_LOBES. This is the cost.
    rate: 5, // lobes released per second
    frontSpeed: 7, // m/s the release point advances down the line
    volume: 1.4, // cubic metres per lobe
    volumeJitter: 0.45, // ±fraction
    repose: 0.58, // radians — 33°, dry snow. The angle it refuses to exceed.
    excess: 0.21, // radians above repose at release — 12° of over-steepening
    slump: 2.4, // 1/s the excess decays at
    creep: 1.6, // m/s the lobe's centroid crawls forward as it collapses
    scatter: 0.9, // metres of lateral scatter on release
    widen: 1.4, // >1 stretches a lobe across the line

    /* --- the deposit left behind --- */
    bed: 0.22, // metres of settled snow in the tail
    bedRamp: 2.5, // metres it takes to reach that depth behind the front
    bedWidth: 2.6, // metres, half-width
    bedCurve: 0.6, // how sharply it thins toward its edges

    /* --- shading --- */
    ambient: 0.5, // floor under the diffuse term
    wrap: 0.5, // how far light bends round a translucent grain
    fresh: 0.7, // seconds a lobe counts as fresh for
    grain: 0.12, // speckle depth
    grainScale: 70, // grains per metre
    glint: 0.5, // pinpoint sparkle — snow, not sand
    glintScale: 120,
    toe: 0.06, // metres of height the heap fades out over
    opacity: 1,

    /* --- colour: four pickers, none derived --- */
    colorFresh: '#f2f6fb',
    colorSettled: '#cfd8e4',
    colorFace: '#ffffff',
    colorDeep: '#6d7f96'
  };
}

/** Resolved once at module load. */
const HEAP_DEFAULTS = heapParams();

/**
 * Editor schema fragments. Spread whichever half the ability uses.
 */
export function dissolveSchema(label = 'Dissolve') {
  return {
    [`${label} · cubes`]: [
      ['progress', 0, 1, 0.001],
      ['voxel', 0, 1, 0.01, 'cubes on'],
      ['cell', 0.01, 1, 0.005, 'finest cube (m)'],
      ['rungs', 1, MAX_RUNGS, 1, 'doublings'],
      ['take', 0.05, 0.95, 0.01, 'claimed per rung'],
      ['span', 0.02, 1, 0.01, 'time to let go'],
      ['block', 0, 1, 0.01, 'blockiness'],
      ['facet', 0.1, 1, 0.05, 'sub-lattice'],
      ['hold', 0, 0.98, 0.01, 'hold before shrink'],
      ['drift', 0, 6, 0.01, 'drift (m)'],
      ['lift', -2, 4, 0.01, 'lift (m)'],
      ['gravity', 0, 8, 0.01, 'fall (m)'],
      ['tumble', 0, 9, 0.01, 'tumble (rad)'],
      ['wobble', 0, 0.5, 0.005, 'wander (m)'],
      ['wobbleRate', 0, 20, 0.1, 'wander rate'],
      'colorEmber'
    ],
    [`${label} · erosion`]: [
      ['erode', 0, 1, 0.01, 'erosion on'],
      ['noiseScale', 0.2, 12, 0.05, 'features/m'],
      ['warp', 0, 2, 0.01, 'domain warp'],
      ['edge', 0.01, 0.5, 0.005, 'burn width'],
      ['biasAmount', -1, 1, 0.01, 'front bias'],
      'colorEdge',
      ['glow', 0, 4, 0.01]
    ],
    [`${label} · heap`]: [
      ['halfWidth', 0.5, 12, 0.1, 'half-width (m)'],
      ['heightGain', 0, 3, 0.01, 'height'],
      ['lobes', 1, MAX_LOBES, 1],
      ['rate', 0.5, 20, 0.1, 'lobes/s'],
      ['frontSpeed', 0, 30, 0.1, 'front (m/s)'],
      ['volume', 0.05, 12, 0.05, 'lobe (m³)'],
      ['volumeJitter', 0, 1, 0.01, 'lobe jitter'],
      ['repose', 0.15, 1.2, 0.005, 'repose (rad)'],
      ['excess', 0, 0.8, 0.005, 'over-steep (rad)'],
      ['slump', 0.1, 12, 0.05, 'slump (1/s)'],
      ['creep', 0, 8, 0.05, 'creep (m/s)'],
      ['scatter', 0, 6, 0.05, 'scatter (m)'],
      ['widen', 0.2, 4, 0.05, 'lobe widening'],
      ['bed', 0, 2, 0.01, 'deposit (m)'],
      ['bedRamp', 0.1, 12, 0.1, 'deposit ramp (m)'],
      ['bedWidth', 0.2, 12, 0.1, 'deposit width (m)'],
      ['bedCurve', 0.05, 4, 0.05, 'deposit edge']
    ],
    [`${label} · snow`]: [
      ['ambient', 0, 1, 0.01],
      ['wrap', 0, 1, 0.01, 'light wrap'],
      ['fresh', 0.05, 4, 0.05, 'fresh (s)'],
      ['grain', 0, 0.6, 0.01],
      ['grainScale', 5, 300, 1, 'grains/m'],
      ['glint', 0, 3, 0.01],
      ['toe', 0.005, 0.4, 0.005, 'toe (m)'],
      'colorFresh',
      'colorSettled',
      'colorFace',
      'colorDeep'
    ]
  };
}
