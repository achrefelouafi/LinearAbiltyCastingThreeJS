import { Vector3 } from 'three';
import { FilamentPaths, MAX_CHAIN_NODES } from './FilamentPaths.js';
import { clamp, saturate, hash11 } from '../utils/math.js';

/* ---------------------------------------------------------------------- */
/* ArcNetwork — a discharge that hops instead of travelling                 */
/* ---------------------------------------------------------------------- */

/**
 * Node graph plus a segment-lighting clock, for chained discharges.
 *
 * Everything else in the project that crosses a distance *travels*: a front
 * moves at metres per second and the effect is drawn behind it. A chain
 * lightning does not do that. It picks a handful of points, and then it is at
 * the first one, and then it is at the second one, and the space between them
 * was never crossed so much as *skipped*. That discontinuity is the entire
 * read, and it is why this is a module rather than a `progress` uniform.
 *
 * ## What it owns
 *
 * Three things, and deliberately nothing else:
 *
 *   1. **the scatter** — `nodes` points between two anchors, stored as
 *      *unitless fractions* (`along`, `lateral`, `lift`) rolled once per cast
 *      from one seed. Not one metre is captured. The metres arrive when the
 *      shader resolves a node against the role's live `scatter` and `lift`, so
 *      dragging either re-routes a chain that is already in the air, and
 *      `reseed()` re-routes it outright.
 *   2. **the clock** — a cursor that advances in **hops**, not seconds
 *      (`dt / hopTime`), so changing the hop time mid-flight changes what
 *      happens next rather than rewriting what already happened. A hop is dark
 *      until the cursor reaches it, holds for `hold` hops, then decays over
 *      `overlap` hops. `hold = 0, overlap = 0.6` is a single spark running the
 *      chain; `hold = 8` lights the whole thing and leaves it lit.
 *   3. **the hooks** — `onNode(index, position, count)` fires exactly once per
 *      node, on the frame the cursor reaches it, with the node's *resolved*
 *      world position. That is where the burst, the light punch and the decal
 *      go.
 *
 * ## What it does not own
 *
 * A renderer. It draws through `FilamentPaths` in `CHAIN` mode, which is the
 * same instanced ribbon strip the bolt and the snare are drawn on — **two draw
 * calls**, and the other three role slots are still free, so an ability can
 * hang earthing spikes or a rim ring off `net.paths.role(1)` for nothing.
 *
 * ## The one rule for using it well
 *
 * **Write `from` and `to` every frame, then call `update()` with a params
 * object filled from `settings[id]` that frame.** The network holds dice rolls
 * and a hop counter; it holds no geometry. If you find yourself caching a node
 * position between frames, use `nodePoint()` instead — it re-derives it, and it
 * is the same arithmetic the vertex shader does, so the burst lands *on* the
 * node rather than near it.
 *
 * @example
 *   this.net = new ArcNetwork(this.group, { capacity: 24 });
 *   this.net.onNode = this._nodeBurst;      // bound once, never per frame
 *   // spawn
 *   this.net.reset(Math.random() * 100);
 *   // travel / fade, every frame
 *   this._fillParams();                     // reads settings.chainarc into a scratch
 *   this.net.from.copy(_hand);
 *   this.net.to.copy(_target);
 *   this.net.update(dt, this._params, fade);
 */

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _node = new Vector3();

/**
 * Canonical parameter names with their defaults.
 *
 * Read fresh on every `update()`; a missing field falls back to the default
 * here. The block also carries the whole of `filamentLook()` — width, colours,
 * kinks — because it is handed straight to `FilamentPaths.sync()`, so an
 * ability keeps one params object rather than two.
 */
export function arcNetworkParams() {
  return {
    /* --- the graph --- */
    nodes: 6, // points including both ends, 2..MAX_CHAIN_NODES
    filaments: 3, // whole polylines drawn over the same nodes
    scatter: 1.6, // metres the lateral fractions are scaled by
    lift: 0.5, // metres the lift fractions are scaled by
    alongJitter: 0.5, // 0..1 of a hop that a node may slide down the line

    /* --- each hop --- */
    sag: 0.12, // metres a hop bows downward at mid-hop
    bow: 0.3, // metres a hop bows sideways, alternating per hop
    floorY: 0.06, // metres — a node's filament is clamped above this

    /* --- the clock --- */
    hopTime: 0.045, // seconds per hop
    hold: 1.4, // hops a lit segment stays at full
    overlap: 2.6, // hops it then decays over
    tip: 0.3, // how much of a hop the front is smeared over

    /* --- the role's share of the shared look --- */
    kink: 1, // multiplier on the shared `jitter`
    chainWidth: 1, // multiplier on the shared `width`
    dim: 1, // 0..1 alpha
    groundDamp: 0.55 // 0..1 on the kink's world y — a chain skimming the floor wants < 1

    /* --- plus every field of filamentLook(), passed through to sync() --- */
  };
}

export class ArcNetwork {
  /**
   * @param {THREE.Object3D} parent  the ability's group
   * @param {object} [options]
   * @param {FilamentPaths} [options.paths] draw through an existing instance instead
   *   of building one — the network then owns neither the meshes nor their disposal
   * @param {number} [options.role=0]       which role slot of that instance to use
   * @param {number} [options.samples=96]   nodes along one filament. Higher than the
   *   bolt's 72 because a polyline has corners to resolve, and a corner landing
   *   between two samples rounds itself off — which is the one thing this must not do.
   * @param {number} [options.capacity=24]  filament ceiling
   * @param {number} [options.renderOrder]
   * @param {number} [options.layer]
   */
  constructor(parent, options = {}) {
    this.paths =
      options.paths ??
      new FilamentPaths(parent, {
        samples: options.samples ?? 96,
        capacity: options.capacity ?? 24,
        renderOrder: options.renderOrder,
        layer: options.layer
      });
    /** True when we built the FilamentPaths and are therefore allowed to free it. */
    this._ownsPaths = !options.paths;
    this._role = this.paths.role(options.role ?? 0);

    /** Anchors. The caller writes these every frame; the network never keeps them. */
    this.from = new Vector3();
    this.to = new Vector3(0, 0, 1);

    /**
     * Fired once per node, on the frame the cursor reaches it.
     * `(index, position, count)`. `position` is module scratch — read it, do not
     * keep it. Assign this once, in `createShaders()`; a closure built per frame
     * is the allocation invariant I3 forbids.
     */
    this.onNode = null;

    /* --- the dice, and nothing but --- */
    this._lateral = new Float32Array(MAX_CHAIN_NODES);
    this._lift = new Float32Array(MAX_CHAIN_NODES);
    this._slide = new Float32Array(MAX_CHAIN_NODES);

    this.seed = 0;
    /** The lit front, in hops. Unitless, so `hopTime` can move under it. */
    this.cursor = 0;
    this._fired = 0;
    this._nodes = 2;

    this.reseed(0);
  }

  /** The two meshes, if this network built them. */
  get object3D() {
    return this.paths.object3D;
  }

  /** Two — the chain shares the strip with whatever else is on it. */
  get drawCalls() {
    return this.paths.drawCalls;
  }

  /** Live nodes, including both ends. */
  get nodeCount() {
    return this._nodes;
  }

  /** Hops between them. */
  get segments() {
    return Math.max(1, this._nodes - 1);
  }

  /** 0..1 of the way down the chain the front has reached. */
  get progress() {
    return saturate(this.cursor / this.segments);
  }

  /** True once the last node has lit. */
  get arrived() {
    return this.cursor >= this.segments;
  }

  /** Nodes whose hook has already fired. */
  get firedCount() {
    return this._fired;
  }

  /**
   * Re-roll the scatter.
   *
   * Deterministic in `seed`, and safe to call at any time — including mid-cast,
   * which is what "re-rolling the node scatter live re-routes a chain already in
   * the air" means. The clock is untouched, so a re-route does not restart the
   * discharge, it just changes where the rest of it goes.
   */
  reseed(seed) {
    this.seed = seed;
    for (let i = 0; i < MAX_CHAIN_NODES; i++) {
      // Alternating sides, not free scatter. Two consecutive nodes on the same
      // side draw a curve, and a curve is a bolt — the zig is the whole point of
      // a chain. The magnitude still varies, so it does not read as a zip.
      const side = i % 2 === 0 ? 1 : -1;
      this._lateral[i] = side * (0.35 + 0.65 * hash11(seed + i * 3.71));
      this._lift[i] = hash11(seed + i * 7.13 + 11.7);
      this._slide[i] = hash11(seed + i * 5.31 + 41.3) - 0.5;
    }
    return this;
  }

  /** Start a cast: re-roll, rewind the clock, un-fire every hook. */
  reset(seed) {
    this.reseed(seed);
    this.cursor = 0;
    this._fired = 0;
    return this;
  }

  /**
   * Where node `i` is, in metres. The shader's arithmetic, mirrored.
   * @param {number} i
   * @param {THREE.Vector3} out
   */
  nodePoint(i, out) {
    return this.paths.nodePoint(this._role.index, i, out);
  }

  /**
   * Advance the clock, re-resolve the graph, fire whatever hooks came due.
   *
   * @param {number} dt      seconds
   * @param {object} p       live params — see `arcNetworkParams()`
   * @param {number} [fade]  1 while lit, ramping to 0 as it blows out
   */
  update(dt, p, fade = 1) {
    const n = clamp(Math.round(p.nodes ?? 6), 2, MAX_CHAIN_NODES);
    this._nodes = n;
    this.paths.setNodeCount(n);

    /* ---- the scatter, resolved against the live node count ---- */
    // `along` is derived here rather than stored, because the count is a live
    // slider: dropping from seven nodes to four has to re-space the survivors,
    // not leave a gap where the last three were.
    const segs = n - 1;
    const slide = (p.alongJitter ?? 0.5) / segs;
    for (let i = 0; i < n; i++) {
      const end = i === 0 || i === n - 1;
      const along = end ? i / segs : i / segs + this._slide[i] * slide;
      // The ends are the anchors themselves — the hand and the thing that was
      // aimed at. Scattering those makes the cast look like it missed.
      this.paths.setNode(i, along, end ? 0 : this._lateral[i], end ? 0 : this._lift[i]);
    }

    /* ---- the clock ---- */
    const hop = Math.max(p.hopTime ?? 0.045, 1e-4);
    const hold = Math.max(p.hold ?? 1.4, 0);
    const overlap = Math.max(p.overlap ?? 2.6, 1e-3);
    this.cursor += dt / hop;
    // Park it once the tail has passed the last node. Left to run, the cursor
    // grows without bound and the float loses the fractional precision the
    // front's smear needs.
    this.cursor = Math.min(this.cursor, segs + hold + overlap + 1);

    /* ---- the role ---- */
    this._role.count = Math.max(1, Math.round(p.filaments ?? 3));
    this._role.chain(
      this.from,
      this.to,
      p.scatter ?? 1.6,
      p.lift ?? 0.5,
      p.sag ?? 0.12,
      p.bow ?? 0.3,
      this.cursor,
      hold,
      overlap,
      Math.max(p.tip ?? 0.3, 1e-3)
    );
    this._role.style(p.kink ?? 1, p.chainWidth ?? 1, p.dim ?? 1, p.groundDamp ?? 0.55);
    this._role.ends(1, 1, 1, 1);
    // The chain does its own front in `chainLit`, so the ribbon-wide clip stays
    // out of its way; the floor clamp is the only part of `draw` it wants.
    this._role.draw(2, 0.08, p.floorY ?? 0.06, 0);

    /* ---- the hooks, after the role is configured so a node resolves ---- */
    while (this._fired < n && this.cursor >= this._fired) {
      const index = this._fired;
      this._fired++;
      if (this.onNode) this.onNode(index, this.nodePoint(index, _node), n);
    }

    this.paths.sync(p, fade, this.seed);
  }

  /** Retire the chain. Leaves the instance reusable. */
  clear() {
    this._role.retire();
    this.cursor = 0;
    this._fired = 0;
    if (this._ownsPaths) this.paths.clear();
  }

  dispose() {
    if (this._ownsPaths) this.paths.dispose();
  }
}
