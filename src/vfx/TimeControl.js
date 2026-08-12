import {
  Color,
  FrontSide,
  Group,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Skeleton,
  Vector3
} from 'three';
import { frame, MAX_TIME_REGIONS } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';
import { clamp, saturate } from '../utils/math.js';
import { copyColor } from '../utils/color.js';

/* ---------------------------------------------------------------------- */
/* TimeControl — the three things a chrono ability does to the clock       */
/* ---------------------------------------------------------------------- */

/**
 * Recording the caster, clamping other systems' clocks inside a radius, and
 * running the same closed forms with a negative time step.
 *
 * This is the most architecturally invasive module in the library and the one
 * that draws the least. Two of its three capabilities draw *nothing at all*:
 * they are a shared uniform block, a GLSL chunk, and some arithmetic. The read
 * is entirely in what the rest of the frame does differently.
 *
 * ## 1 · RECORDER — the caster's own motion, played back
 *
 * `TimeRecorder` is a ring buffer of the caster's world transform and its bone
 * pose, sampled at a live rate. `GhostRig` is a copy of the caster's skinned
 * meshes with its own skeleton, which the recorder can be asked to drive to any
 * instant on the track. N ghosts at N delays is N `GhostRig`s reading one
 * `TimeRecorder`.
 *
 * **Full skeletal ghosting is feasible here and this module ships it.** The
 * trade-offs are real and are stated rather than hidden:
 *
 *   - Each ghost owns a clone of the bone hierarchy (about seventy `Object3D`s
 *     for the Mixamo rig in this project) and its own `Skeleton`. Geometry and
 *     the skin map are shared with the character; only the material and the
 *     bones are new. Three ghosts is roughly 210 extra scene-graph nodes and
 *     three extra draw calls.
 *   - The clone happens **once**, in `setSource()`, and never during a cast.
 *     That is a documented exception to I3 with an unavoidable cause: the
 *     character is an asynchronous FBX load that finishes *after* the ability
 *     pools can be warmed, so there is no earlier moment at which the source
 *     rig exists. Call `setSource()` from `createShaders()` — by the time a
 *     chrono ability is warmed on selection the character is long loaded — and
 *     the cast itself allocates nothing. `setSource()` on an already-sourced
 *     rig is a no-op, so calling it from `onSpawn()` as a fallback is free
 *     after the first cast.
 *   - The track stores **local position and rotation per bone, not scale.**
 *     Mixamo clips carry no scale animation, so a third of the buffer and a
 *     third of the per-frame write would be spent replaying a constant. Bone
 *     scale is copied from the bind pose when the rig is cloned. If a future
 *     rig animates scale, its ghosts will hold the bind scale and look
 *     correct-but-stiff rather than broken.
 *   - Interpolation is a lerp on position and a real `slerp` on rotation.
 *     Element-wise lerping the *matrices* was the first version; at 30 Hz it is
 *     almost right and then a wrist crosses ninety degrees between two samples
 *     and the hand collapses into the forearm for two frames.
 *
 * ## 2 · STASIS — other people's clocks
 *
 * `TimeField` is a pool of at most `MAX_TIME_REGIONS` spheres published as
 * shared uniforms in `core/FrameUniforms.js`. Every shader that injects
 * `shaders/lib/timewarp.glsl.js` reads them; the shared particle shader already
 * does. A region carries a centre, a radius, a strength, a **hold timestamp**
 * and a **rate**, and the one line in the chunk that does all the work is
 *
 *     bent = mix(clock, hold + (clock - hold) * rate, weight)
 *
 * so a region with `rate = 0` is a stasis field, one with `rate = -1` runs its
 * interior backwards, and one with `rate = 0.2` is slow motion. See the header
 * of `shaders/lib/timewarp.glsl.js` for why it is published as an instant and a
 * rate rather than as a time scale each consumer integrates — the short version
 * is that there is nothing here to integrate *into*, because every effect in
 * this project is a closed-form function of time with no per-object state.
 *
 * **The cost when nothing is held is one uniform float compare.** `acquire()`
 * is the only thing that ever raises `uTimeRegionCount` above zero, and until
 * an ability calls it every consumer returns its own clock on the first line.
 *
 * ## 3 · REVERSE — a negative time step
 *
 * `reverseTime(age, p)` is a closed form: forward at `rate` until `turnAt`,
 * held for `hold`, then backwards at `back`, floored. Hand its output to any
 * module's `now` and that module runs backwards, because every one of them is a
 * pure function of the clock you give it. **Prefer the closed form to the
 * integrator.** It is the version that survives the pause test: freeze the
 * sandbox mid-rewind, drag `back`, and the whole reversal re-times itself
 * retroactively, because nothing was accumulated.
 *
 * `TimeWarpClock` is the integrating alternative, for a rate that comes from
 * somewhere that is not a slider. It is honest about its cost: a clock you
 * integrate is a clock a paused slider cannot reach.
 *
 * ### What reverses cleanly
 *
 * | | |
 * | --- | --- |
 * | `GrowthField.update(now, p)` | **yes** — emergence is `g(now - birth)`; crystals retract into the floor |
 * | `ShatterField.update(now, p)` | **yes** — fragments fly back and reassemble |
 * | `FilamentPaths.sync(look, fade, seed)` + `role.draw(progress, …)` | **yes** — drive `progress` from the bent clock |
 * | `Projectile.update(now, p)` | **yes**, but `arrivals` fires again on the way back; latch it with a `RewindGate` |
 * | `Tube.sync(c, state)` / `Shell.sync(c, state)` | **yes** — time arrives on `state.time` / `state.t` |
 * | `GroundField.update(p)` + `mark(x, z, time, s)` | **yes** — marks carry their own timestamp |
 * | `LiquidSurface.update(now, p)` | **partly** — the surface reverses, injected ripples do not |
 *
 * ### What does not, and what to do instead
 *
 * | | |
 * | --- | --- |
 * | **the particle ring buffer** | A spawn is a log entry, not a state. Feeding a `RateEmitter` a negative `dt` emits nothing and thrashes its accumulator. Use `clock.emitDt`, which is `max(0, step)`. The *only* way particles genuinely run backwards is a time region with a negative rate — that path recomputes the closed form in the vertex shader and un-spawns them properly, at their emitter. |
 * | **decals, fissures, bursts** | One-shot systems on the app's forward clock. Nothing can un-spawn one. Lay them on the forward pass and let them expire; do not spawn during a reverse leg. |
 * | `ArcNetwork.update(dt, …)` | Integrates a hop cursor and fires `onNode` once per node, and `_fired` never counts down. Feed it `clock.emitDt` and `reset(seed)` on the turn. |
 * | `Swarm` · `Curtain` · `VolumeHull` | Their motion lives in `frame.uTime` inside the shader; the first argument to `Swarm.update` and `Curtain.update` is ignored by design. An ability clock cannot reach them. A **time region** can, if they are taught to inject the chunk — none of them has been, and that is the obvious next piece of work. |
 * | `Ability.advance(dt)` | The base class's front and phase machine are monotone and are not yours to reverse. Let the phases run forward and let the bent clock feed only the modules — `rewind` is a LINE cast whose *travel* still travels. |
 * | `ctx.lights` | `LightPool.set(..., dt)` smooths toward a target. A negative `dt` is not meaningful; pass `clock.spanDt`. |
 *
 * ## Draw calls
 *
 * `TimeField`: **zero.** `TimeRecorder`: **zero.** `GhostRig`: one per skinned
 * mesh in the source rig — one, for the character in this project. Three ghosts
 * is three draw calls and leaves nine of the I7 budget.
 *
 * ## The one rule for using it well
 *
 * **Call `region.sync(p)` every frame with a params object filled from
 * `settings[id]` that frame, and `region.release()` in `onDestroy()`.** The
 * pool is four slots wide and `acquire()` returns `null` when they are gone, on
 * exactly the `ctx.lights.acquire()` contract — guard it. A region that is
 * never released freezes a piece of the world until the page is reloaded, which
 * is the most alarming bug this library can produce.
 *
 * @example
 *   // stasisfield — the whole ability
 *   createShaders() {
 *     this._region = null;
 *     this._warp = timeRegionParams();
 *   }
 *   onSpawn() {
 *     this._region = timeField.acquire();     // may be null — I6
 *     this._region?.lock();
 *   }
 *   onTravel(dt) {
 *     const c = settings.stasisfield;
 *     const region = this._region;
 *     if (!region) return;
 *     region.centre.copy(this.origin).setY(c.domeHeight);
 *     this._warp.radius = c.zoneRadius * settings.global.scale;
 *     this._warp.core = c.holdCore;
 *     this._warp.strength = c.holdStrength;
 *     this._warp.rate = 0;                     // stasis
 *     region.sync(this._warp);
 *   }
 *   onDestroy() { this._region = this._region?.release() ?? null; }
 */

/* Module-scope scratch. Nothing in a frame path allocates — invariant I3. */
const _pos = new Vector3();
const _quat = new Quaternion();
const _scale = new Vector3();
const UP = new Vector3(0, 1, 0);
/** Where a lookup landed: two ring slots and the blend between them. */
const _cursor = { index: 0, next: 0, blend: 0, inside: false };
/** Four floats for one `Quaternion.slerpFlat` result. Reused by every bone. */
const _slerp = new Float32Array(4);

export { MAX_TIME_REGIONS };

/* ====================================================================== */
/* 1 · The time field                                                      */
/* ====================================================================== */

/**
 * Canonical parameter names for one region, with their defaults.
 *
 * Read fresh on every `sync()`; a missing field falls back to the default here.
 * Everything with a unit is in this object and nothing with a unit is anywhere
 * else in a `TimeRegion` — invariant I1 in one sentence.
 */
export function timeRegionParams() {
  return {
    radius: 6, // metres — the outer edge, past which the clock is untouched
    core: 0.65, // 0..1 of the radius that is held at full strength
    strength: 1, // 0..1 master weight; 0 is a region that does nothing
    rate: 0 // clock rate inside: 0 stasis, -1 rewind, 0.2 slow, 1 identity
  };
}

/**
 * One slot of the shared field.
 *
 * Holds two things and deliberately nothing else: the **slot index** it writes
 * into and the **hold timestamp** stamped by `lock()`. A timestamp is the one
 * kind of number a cast is allowed to capture, because it names an event rather
 * than a quantity. Every metre and every rate arrives through `sync()`, from
 * the ability's live settings, on every frame including a zero-length one.
 *
 * `centre` is a `Vector3` the caller writes each frame, the same contract as
 * `ArcNetwork.from` / `.to`. The region never keeps a position of its own.
 */
export class TimeRegion {
  /**
   * @param {TimeField} field
   * @param {number} index  which pair of uniform slots this region owns
   */
  constructor(field, index) {
    this._field = field;
    this.index = index;
    /** World centre. Written by the caller every frame. */
    this.centre = new Vector3();
    /** The instant the region locked. A timestamp — see the class doc. */
    this._hold = 0;
    this._live = false;
  }

  /** True between `acquire()` and `release()`. */
  get isLive() {
    return this._live;
  }

  /** The instant this region locked, in the same clock `lock()` was given. */
  get hold() {
    return this._hold;
  }

  /**
   * Stamp the instant the region snapped shut.
   *
   * Everything inside is held at this moment (`rate = 0`), mirrored about it
   * (`rate = -1`) or dilated around it. Defaults to the world clock, which is
   * what a stasis field wants; a rewind that should reach further back than the
   * moment it was cast passes an earlier value.
   *
   * @param {number} [now] seconds, in `frame.uTime`'s clock
   */
  lock(now = frame.uTime.value) {
    this._hold = now;
    return this;
  }

  /** Place the centre in one call. `centre` is public; this is for readability. */
  place(position) {
    this.centre.copy(position);
    return this;
  }

  placeXYZ(x, y, z) {
    this.centre.set(x, y, z);
    return this;
  }

  /**
   * Push this frame's dimensions into the shared uniforms.
   *
   * @param {object} p live params — see `timeRegionParams()`
   */
  sync(p) {
    if (!this._live) return this;
    const region = frame.uTimeRegion.value[this.index];
    const warp = frame.uTimeRegionWarp.value[this.index];
    region.set(this.centre.x, this.centre.y, this.centre.z, Math.max(p?.radius ?? 0, 0));
    warp.set(saturate(p?.strength ?? 1), saturate(p?.core ?? 0.65), this._hold, p?.rate ?? 0);
    return this;
  }

  /**
   * How strongly this region holds a world point, 0..1.
   *
   * The CPU mirror of `timeRegionFalloff` in the GLSL chunk, arithmetic for
   * arithmetic. An ability uses it to decide whether it is worth emitting into
   * its own frozen zone, or to fade a decal it is about to lay inside one.
   */
  weightAt(worldPos) {
    if (!this._live) return 0;
    const region = frame.uTimeRegion.value[this.index];
    const warp = frame.uTimeRegionWarp.value[this.index];
    return falloff(worldPos, region, warp);
  }

  /** Return the slot to the pool and leave it exactly identity. Returns null. */
  release() {
    this._field?.release(this);
    return null;
  }

  /** Pool-side only. */
  _claim(now) {
    this._live = true;
    this._hold = now;
    this.centre.set(0, 0, 0);
    frame.uTimeRegion.value[this.index].set(0, 0, 0, 0);
    frame.uTimeRegionWarp.value[this.index].set(0, 0, now, 1);
  }

  /** Pool-side only. Strength 0 and rate 1 are both identity; write both. */
  _retire() {
    this._live = false;
    this._hold = 0;
    frame.uTimeRegion.value[this.index].set(0, 0, 0, 0);
    frame.uTimeRegionWarp.value[this.index].set(0, 0, 0, 1);
  }
}

/** The falloff, shared by the pool and by `TimeRegion.weightAt`. */
function falloff(worldPos, region, warp) {
  const outer = Math.max(region.w, 1e-4);
  const inner = Math.min(saturate(warp.y) * outer, outer - 1e-3);
  const dx = worldPos.x - region.x;
  const dy = worldPos.y - region.y;
  const dz = worldPos.z - region.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  // smoothstep(inner, outer, d), inlined to keep the mirror obvious.
  const s = saturate((d - inner) / (outer - inner));
  return saturate(warp.x) * (1 - s * s * (3 - 2 * s));
}

/**
 * The pool of time regions, and the CPU-side mirror of the field.
 *
 * A singleton (`timeField`) rather than a service on the ability context, for
 * the same reason `distortionWriters` lives in `core/Layers.js`: the consumers
 * are the *shaders*, through uniform boxes that already exist whether or not
 * anybody has claimed one, and threading a service through `AbilityManager`
 * would mean editing the context every ability in the project is constructed
 * against. Nothing outside this file has to change for the field to work.
 */
export class TimeField {
  constructor() {
    this._regions = [];
    for (let i = 0; i < MAX_TIME_REGIONS; i++) this._regions.push(new TimeRegion(this, i));
  }

  /** Live regions. */
  get liveCount() {
    let n = 0;
    for (const region of this._regions) if (region._live) n++;
    return n;
  }

  /**
   * Claim a slot.
   *
   * **Returns `null` when all four are taken**, on exactly the contract of
   * `ctx.lights.acquire()` — guard every use of the handle. An ability that
   * wants two regions must read acceptably with one.
   *
   * @param {number} [now] the hold instant to start with; `lock()` re-stamps it
   * @returns {TimeRegion|null}
   */
  acquire(now = frame.uTime.value) {
    for (const region of this._regions) {
      if (region._live) continue;
      region._claim(now);
      this._repack();
      return region;
    }
    return null;
  }

  /** Give a slot back. Safe to call with `null` or with a foreign region. */
  release(region) {
    if (!region || region._field !== this || !region._live) return null;
    region._retire();
    this._repack();
    return null;
  }

  /**
   * The clock a world point lives on. The CPU mirror of `warpedTime`.
   *
   * The one place an ability needs this is when it must place something *on* a
   * frozen effect — a light on a held ember, a decal under a stopped crystal.
   * Everything drawn by a shader that injects the chunk bends itself.
   */
  clockAt(clock, worldPos) {
    const count = frame.uTimeRegionCount.value;
    if (count < 0.5) return clock;
    let bent = clock;
    for (let i = 0; i < MAX_TIME_REGIONS && i < count; i++) {
      const region = frame.uTimeRegion.value[i];
      const warp = frame.uTimeRegionWarp.value[i];
      const w = falloff(worldPos, region, warp);
      bent += (warp.z + (bent - warp.z) * warp.w - bent) * w;
    }
    return bent;
  }

  /** How held a world point is, 0..1. The CPU mirror of `timeRegionWeight`. */
  weightAt(worldPos) {
    const count = frame.uTimeRegionCount.value;
    if (count < 0.5) return 0;
    let held = 0;
    for (let i = 0; i < MAX_TIME_REGIONS && i < count; i++) {
      held = Math.max(held, falloff(worldPos, frame.uTimeRegion.value[i], frame.uTimeRegionWarp.value[i]));
    }
    return held;
  }

  /**
   * Retire every region. For `App.reset()` and for teardown.
   *
   * Worth wiring into whatever clears the scene: a leaked region is invisible
   * and stops a piece of the world for the rest of the session.
   */
  reset() {
    for (const region of this._regions) region._retire();
    frame.uTimeRegionCount.value = 0;
    return this;
  }

  /**
   * Republish the live count.
   *
   * The count is the index of the highest live slot plus one, not the number of
   * live regions — the shader loop walks slots in order and a hole in the
   * middle has to still be walked past. A retired slot is exact identity
   * (strength 0, rate 1), so walking it costs a `mix` by zero and changes
   * nothing.
   */
  _repack() {
    let high = 0;
    for (let i = 0; i < MAX_TIME_REGIONS; i++) if (this._regions[i]._live) high = i + 1;
    frame.uTimeRegionCount.value = high;
  }
}

/** The one pool. Abilities import this, not the class. */
export const timeField = new TimeField();

/* ====================================================================== */
/* 2 · The recorder                                                        */
/* ====================================================================== */

/** Hard ceiling on samples in the ring. The `window` slider clamps against it. */
export const MAX_TRACK_SAMPLES = 240;
/** Hard ceiling on recorded bones. The Mixamo rig here uses about sixty-five. */
export const MAX_TRACK_BONES = 128;
/** position(3) + quaternion(4). Scale is not recorded — see the module doc. */
const FLOATS_PER_BONE = 7;

/**
 * Canonical parameter names for the recorder.
 *
 * `rate` and `window` are live sliders and are read on every `sample()`. The
 * *capacity* of the ring is a constructor argument and a structural ceiling, in
 * the same way `MAX_STRANDS` is in `ThunderAbility` — a buffer cannot be
 * resized by a slider drag, but how much of it is used, and how finely, can.
 */
export function recorderParams() {
  return {
    rate: 30, // samples per second
    window: 2.5 // seconds of history to keep; older samples are allowed to fall off
  };
}

/**
 * A ring buffer of the caster's transform and pose.
 *
 * ## What is in it
 *
 * Per sample: a **timestamp**, the source's world position and rotation, and
 * every tracked bone's *local* position and rotation. Nothing else, and in
 * particular no metres that are not the caster's own — a recording is a
 * measurement of something that happened, which is the one category of state
 * invariant I1 has no argument with.
 *
 * ## The property that makes this an effect rather than a feature
 *
 * Sampling is driven by timestamps, so a zero-length frame writes nothing. But
 * *playback* is a function of the delay you ask for, and the delay is a slider.
 * Pause the sandbox mid-cast with **P** and drag `ghostDelay`, and the three
 * ghosts walk backwards and forwards through the recording while the world
 * stands still. That is the pause test passing loudly, on an ability whose
 * whole subject is time.
 *
 * ## Cost
 *
 * `240 samples × (1 + 7 + 128 × 7)` floats is 3.4 MB at the ceiling, and a
 * sensible `new TimeRecorder({ capacity: 90, bones: 70 })` is 178 kB.
 * Allocated once, at construction, and never again. Playback is a binary search
 * plus one lerp and one slerp per bone per ghost.
 */
export class TimeRecorder {
  /**
   * @param {object} [options]
   * @param {number} [options.capacity=120] samples in the ring, 2..MAX_TRACK_SAMPLES
   * @param {number} [options.bones=MAX_TRACK_BONES] bone ceiling; 0 records the
   *   root transform only, which is all a silhouette proxy needs
   */
  constructor({ capacity = 120, bones = MAX_TRACK_BONES } = {}) {
    this.capacity = clamp(Math.round(capacity), 2, MAX_TRACK_SAMPLES);
    this.boneCeiling = clamp(Math.round(bones), 0, MAX_TRACK_BONES);

    this._time = new Float32Array(this.capacity);
    this._root = new Float32Array(this.capacity * FLOATS_PER_BONE);
    this._pose =
      this.boneCeiling > 0
        ? new Float32Array(this.capacity * this.boneCeiling * FLOATS_PER_BONE)
        : null;

    /** The rig being watched, or null. */
    this.source = null;
    /** Source bones in skeleton order; index-matched to every `GhostRig`. */
    this.bones = [];
    this._count = 0;
    this._cursor = 0;
    this._last = -1e9;
  }

  /** Bones actually being recorded. */
  get boneCount() {
    return this.bones.length;
  }

  /** Samples currently held. */
  get sampleCount() {
    return this._count;
  }

  /** Timestamp of the newest sample, or `-Infinity` on an empty track. */
  get newest() {
    return this._count ? this._time[this._slot(this._count - 1)] : -Infinity;
  }

  /** Timestamp of the oldest sample, or `Infinity` on an empty track. */
  get oldest() {
    return this._count ? this._time[this._slot(0)] : Infinity;
  }

  /** Seconds between the oldest and newest sample. */
  get span() {
    return this._count > 1 ? this.newest - this.oldest : 0;
  }

  /**
   * Watch a rig.
   *
   * Discovers every skeleton under `source` and records the union of their
   * bones in traversal order — which is the order a `GhostRig` cloned from the
   * same source will produce, so bone `i` here is bone `i` there and no name
   * matching is needed at playback.
   *
   * @param {import('three').Object3D|null} source
   */
  attach(source) {
    this.source = source ?? null;
    this.bones.length = 0;
    this.clear();
    if (!source || this.boneCeiling === 0) return this;

    const seen = new Set();
    source.traverse((node) => {
      if (!node.isSkinnedMesh || !node.skeleton) return;
      for (const bone of node.skeleton.bones) {
        if (!bone || seen.has(bone)) continue;
        seen.add(bone);
        if (this.bones.length < this.boneCeiling) this.bones.push(bone);
      }
    });

    if (seen.size > this.boneCeiling) {
      console.warn(
        `[TimeRecorder] rig has ${seen.size} bones and the ceiling is ${this.boneCeiling}; ` +
          'the tail of the skeleton will hold its bind pose'
      );
    }
    return this;
  }

  detach() {
    return this.attach(null);
  }

  /** Empty the track. Leaves the recorder attached and reusable. */
  clear() {
    this._count = 0;
    this._cursor = 0;
    this._last = -1e9;
    return this;
  }

  /**
   * Write a sample if one is due.
   *
   * Refuses two things, both of them quietly:
   *
   *   - a frame that has not advanced far enough for the live `rate`, which is
   *     also what makes a paused frame write nothing;
   *   - a `now` **earlier than the newest sample**, which is what happens the
   *     moment an ability points a reversed clock at its own recorder. A track
   *     is a measurement; running time backwards does not un-measure it, and
   *     letting a rewind interleave descending timestamps into the ring turns
   *     every subsequent binary search into nonsense.
   *
   * @param {number} now seconds — the caster's clock, usually `frame.uTime.value`
   * @param {object} p   live params — see `recorderParams()`
   * @returns {boolean}  true if a sample was written
   */
  sample(now, p) {
    const source = this.source;
    if (!source) return false;
    if (this._count > 0) {
      if (now < this._last) return false;
      const rate = clamp(p?.rate ?? 30, 1, 240);
      if (now - this._last < 1 / rate) return false;
    }

    const slot = this._cursor;
    this._cursor = (this._cursor + 1) % this.capacity;
    if (this._count < this.capacity) this._count++;
    this._time[slot] = now;
    this._last = now;

    source.updateWorldMatrix(true, false);
    source.matrixWorld.decompose(_pos, _quat, _scale);
    const r = slot * FLOATS_PER_BONE;
    this._root[r + 0] = _pos.x;
    this._root[r + 1] = _pos.y;
    this._root[r + 2] = _pos.z;
    this._root[r + 3] = _quat.x;
    this._root[r + 4] = _quat.y;
    this._root[r + 5] = _quat.z;
    this._root[r + 6] = _quat.w;

    const pose = this._pose;
    if (!pose) return true;
    const base = slot * this.boneCeiling * FLOATS_PER_BONE;
    for (let b = 0; b < this.bones.length; b++) {
      const bone = this.bones[b];
      const o = base + b * FLOATS_PER_BONE;
      pose[o + 0] = bone.position.x;
      pose[o + 1] = bone.position.y;
      pose[o + 2] = bone.position.z;
      pose[o + 3] = bone.quaternion.x;
      pose[o + 4] = bone.quaternion.y;
      pose[o + 5] = bone.quaternion.z;
      pose[o + 6] = bone.quaternion.w;
    }
    return true;
  }

  /**
   * Drop samples older than `now - window`.
   *
   * Optional: the ring already evicts by overwriting, and a shorter window is
   * usually expressed by simply not asking for older instants. It exists so an
   * ability can make `window` a genuine slider whose effect — the oldest ghost
   * running out of history and fading — is visible while paused.
   */
  trim(now, p) {
    const window = Math.max(p?.window ?? 2.5, 0);
    while (this._count > 1 && now - this._time[this._slot(0)] > window) this._count--;
    return this;
  }

  /**
   * The caster's world transform at `t`.
   *
   * @param {number} t seconds, in the recorder's own clock
   * @param {import('three').Vector3} outPosition
   * @param {import('three').Quaternion} outQuaternion
   * @returns {boolean} false when `t` is off either end of the track — the
   *   outputs are clamped to the nearest sample, so a caller that ignores this
   *   gets a pose rather than a NaN, but a ghost with no history should hide
   */
  transformAt(t, outPosition, outQuaternion) {
    this._locate(t);
    if (this._count === 0) return false;
    const a = _cursor.index * FLOATS_PER_BONE;
    const b = _cursor.next * FLOATS_PER_BONE;
    const k = _cursor.blend;
    const r = this._root;
    outPosition.set(
      r[a + 0] + (r[b + 0] - r[a + 0]) * k,
      r[a + 1] + (r[b + 1] - r[a + 1]) * k,
      r[a + 2] + (r[b + 2] - r[a + 2]) * k
    );
    Quaternion.slerpFlat(_slerp, 0, r, a + 3, r, b + 3, k);
    outQuaternion.set(_slerp[0], _slerp[1], _slerp[2], _slerp[3]);
    return _cursor.inside;
  }

  /**
   * Drive a ghost's bones to the pose at `t`.
   *
   * Writes local position and rotation; scale is whatever the clone inherited
   * from the bind pose. The ghost's own `updateMatrixWorld` and three's
   * once-per-frame `Skeleton.update()` do the rest, so this costs one lerp and
   * one slerp per bone and no matrix work of its own.
   *
   * @param {number} t seconds
   * @param {GhostRig} ghost
   * @returns {boolean} false when `t` is off the end of the track
   */
  poseAt(t, ghost) {
    const pose = this._pose;
    const bones = ghost?.bones;
    if (!pose || !bones || bones.length === 0) return false;
    this._locate(t);
    if (this._count === 0) return false;

    const stride = this.boneCeiling * FLOATS_PER_BONE;
    const a = _cursor.index * stride;
    const b = _cursor.next * stride;
    const k = _cursor.blend;
    const n = Math.min(bones.length, this.bones.length);

    for (let i = 0; i < n; i++) {
      const bone = bones[i];
      if (!bone) continue;
      const oa = a + i * FLOATS_PER_BONE;
      const ob = b + i * FLOATS_PER_BONE;
      bone.position.set(
        pose[oa + 0] + (pose[ob + 0] - pose[oa + 0]) * k,
        pose[oa + 1] + (pose[ob + 1] - pose[oa + 1]) * k,
        pose[oa + 2] + (pose[ob + 2] - pose[oa + 2]) * k
      );
      Quaternion.slerpFlat(_slerp, 0, pose, oa + 3, pose, ob + 3, k);
      bone.quaternion.set(_slerp[0], _slerp[1], _slerp[2], _slerp[3]);
    }
    return _cursor.inside;
  }

  /** Ring slot of the `i`-th sample counting from the oldest. */
  _slot(i) {
    return (this._cursor - this._count + i + this.capacity * 2) % this.capacity;
  }

  /**
   * Bracket `t` and leave the result in the module-scope `_cursor`.
   *
   * A binary search rather than a walk. Every ghost queries a *different, old*
   * instant, so a walk from the newest end is close to a full sweep of the ring
   * per ghost per frame; eight ghosts on a 240-sample ring is 1,920 compares
   * against 64 for the search, and the search does not get worse when somebody
   * raises the capacity.
   *
   * @returns {boolean} true when `t` is genuinely inside the track
   */
  _locate(t) {
    const n = this._count;
    if (n === 0) {
      _cursor.index = 0;
      _cursor.next = 0;
      _cursor.blend = 0;
      _cursor.inside = false;
      return false;
    }
    if (n === 1) {
      _cursor.index = this._slot(0);
      _cursor.next = _cursor.index;
      _cursor.blend = 0;
      _cursor.inside = false;
      return false;
    }

    const time = this._time;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (time[this._slot(mid)] <= t) lo = mid;
      else hi = mid - 1;
    }

    const a = this._slot(lo);
    const b = this._slot(Math.min(lo + 1, n - 1));
    const ta = time[a];
    const tb = time[b];
    _cursor.index = a;
    _cursor.next = b;
    _cursor.blend = tb > ta ? saturate((t - ta) / (tb - ta)) : 0;
    _cursor.inside = t >= time[this._slot(0)] && t <= time[this._slot(n - 1)];
    return _cursor.inside;
  }
}

/* ====================================================================== */
/* 3 · Ghosts                                                              */
/* ====================================================================== */

/**
 * Canonical look for a ghost. Every one of these is a slider or a picker — I5.
 *
 * The defaults are deliberately close to "the character, dimmer". A ghost that
 * arrives already stylised into a blue silhouette cannot be tuned back into a
 * copy of the caster, and a copy of the caster is the entire trick of
 * `echostep`.
 */
export function ghostLook() {
  return {
    /* --- colour --- */
    tint: '#d5be8c', // where the skin was bright
    deep: '#3b3526', // where the skin was dark
    rimColor: '#f2e6c4', // the fresnel edge
    bleach: 0.7, // 0..1 how far the skin is washed toward tint/deep
    /* --- presence --- */
    fade: 1, // 0..1 master opacity; the per-ghost dimming lives here
    facing: 0.35, // 0..1 how much thinner the ghost is head-on than edge-on
    rim: 1.4, // fresnel emission
    rimPower: 2.6, // fresnel tightness
    /* --- the banding that says "recording", not "hologram" --- */
    glow: 0.35, // emission of the bands
    bandScale: 5.5, // bands per metre of world height
    bandSpeed: 0.9, // metres per second the bands travel down the body
    /* --- coming apart --- */
    erode: 0, // 0..1 dissolve; 1 removes the ghost entirely
    erodeScale: 3.4, // noise features per metre
    edge: 0.14, // 0..1 width of the burning edge on the dissolve
    edgeGlow: 2.2, // emission on that edge
    seed: 0 // unitless dice, so two ghosts do not dissolve identically
  };
}

/**
 * A `MeshStandardMaterial` that reads as a copy of the character.
 *
 * ### Why not a `ShaderMaterial`
 *
 * The first version was one: a fresnel ramp over a flat colour, drawn on the
 * cloned geometry. It looked like a mannequin. What makes a person recognisable
 * at ten metres is not the silhouette, it is the *shading* — the normal map
 * across the shoulders, the way the environment probe sits on the top of the
 * head, the shadow terminator down the side of the ribcage. Every one of those
 * arrives free from `MeshStandardMaterial` and costs a re-implementation
 * otherwise, so the ghost is the real lit material with three things done to it
 * on the way out.
 *
 * ### The three things
 *
 * 1. **Bleach, not tint.** The skin is mixed toward `deep → tint` *by its own
 *    luminance*, so the map's light and shade survive and only its hue is
 *    replaced. Multiplying by a tint instead — the obvious version — turns a
 *    dark jacket into black and the whole figure into a coloured blob, which is
 *    the exact failure the roster entry warns about.
 * 2. **A fresnel rim, and alpha that follows it.** `facing` makes the ghost
 *    thinner head-on than edge-on, so it reads as a volume of air rather than a
 *    decal of a person.
 * 3. **World-space banding and a world-space dissolve.** Both are measured in
 *    metres in *world* space, not in UV, so the bands stay put as the figure
 *    moves through them and two ghosts a metre apart are eroded differently
 *    without either of them owning a seed attribute.
 *
 * ### The texture
 *
 * The ghost shares the character's diffuse map. That is not a new I2 exception:
 * it is the same one, reused. Nothing is loaded, nothing is generated, and the
 * moment the caster's skin changes so does every echo of it.
 *
 * @param {import('three').Material|null} source the character's material, whose
 *   maps and roughness the ghost inherits. `null` builds an untextured ghost,
 *   which is what a rig with no material gets.
 */
export function createGhostMaterial(source = null) {
  const material = new MeshStandardMaterial({
    name: 'GhostRig',
    color: 0xffffff,
    map: source?.map ?? null,
    normalMap: source?.normalMap ?? null,
    bumpMap: source?.normalMap ? null : (source?.bumpMap ?? null),
    roughness: source?.roughness ?? 0.85,
    metalness: 0,
    side: source?.side ?? FrontSide,
    transparent: true,
    // A ghost is a stack of transparent copies of the same silhouette; writing
    // depth makes whichever one drew first punch a hole in the rest.
    depthWrite: false,
    toneMapped: true
  });

  const uniforms = {
    uTime: frame.uTime,
    uGhostTint: { value: new Color(1, 1, 1) },
    uGhostDeep: { value: new Color(0.1, 0.1, 0.1) },
    uGhostRimColor: { value: new Color(1, 1, 1) },
    uGhostBleach: { value: 0.7 },
    uGhostFade: { value: 1 },
    uGhostFacing: { value: 0.35 },
    uGhostRim: { value: 1.4 },
    uGhostRimPower: { value: 2.6 },
    uGhostGlow: { value: 0.35 },
    uGhostBandScale: { value: 5.5 },
    uGhostBandSpeed: { value: 0.9 },
    uGhostErode: { value: 0 },
    uGhostErodeScale: { value: 3.4 },
    uGhostEdge: { value: 0.14 },
    uGhostEdgeGlow: { value: 2.2 },
    uGhostSeed: { value: 0 }
  };

  patchOnBeforeCompile(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n         varying vec3 vGhostWorld;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         /* transformed is post-skinning, in the bind space; modelMatrix takes it
            to the world. Exactly what three's own worldpos chunk does, except
            that chunk only fires when an envmap or a shadow define asked for it
            and the ghost cannot rely on either being on. */
         vGhostWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform vec3  uGhostTint;
         uniform vec3  uGhostDeep;
         uniform vec3  uGhostRimColor;
         uniform float uGhostBleach;
         uniform float uGhostFade;
         uniform float uGhostFacing;
         uniform float uGhostRim;
         uniform float uGhostRimPower;
         uniform float uGhostGlow;
         uniform float uGhostBandScale;
         uniform float uGhostBandSpeed;
         uniform float uGhostErode;
         uniform float uGhostErodeScale;
         uniform float uGhostEdge;
         uniform float uGhostEdgeGlow;
         uniform float uGhostSeed;
         varying vec3  vGhostWorld;
         ${noiseGLSL}`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           /* --- bleach by luminance, so the map's shading survives --- */
           float luma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
           vec3 wash = mix(uGhostDeep, uGhostTint, clamp(luma, 0.0, 1.0));
           diffuseColor.rgb = mix(diffuseColor.rgb, wash, clamp(uGhostBleach, 0.0, 1.0));

           /* --- fresnel: the edge is where a ghost is --- */
           vec3  N   = normalize(normal);
           float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);
           float rim = pow(1.0 - ndv, max(uGhostRimPower, 0.05));

           /* --- bands travelling down the body, in world metres --- */
           float band = 0.5 + 0.5 * sin(
             (vGhostWorld.y - uTime * uGhostBandSpeed) * uGhostBandScale * PI2);

           /* --- the dissolve, also in world metres --- */
           float n = clamp(fbm3(vGhostWorld * uGhostErodeScale + uGhostSeed) * 0.5 + 0.5, 0.0, 1.0);
           float cut = clamp(uGhostErode, 0.0, 1.0);
           /* The threshold is stretched past both ends so erode = 0 leaves the
              whole body and erode = 1 takes all of it; a bare step(cut, n)
              against a noise field that never quite reaches 0 or 1 leaves a
              rind of the ghost standing at full erosion. */
           float threshold = cut * 1.2 - 0.1;
           float keep = step(threshold, n);
           float burn = clamp(
             smoothstep(threshold, threshold + max(uGhostEdge, 1e-3), n) - keep, 0.0, 1.0);
           /* Below one part in a thousand the ghost is gone; discarding beats
              paying for a full standard-material shade on nothing. */
           if (keep * clamp(uGhostFade, 0.0, 1.0) < 0.001) discard;

           float presence = clamp(uGhostFade, 0.0, 1.0);
           vec3 glow = uGhostRimColor * rim * uGhostRim;
           glow += uGhostTint * band * uGhostGlow;
           glow += uGhostRimColor * burn * uGhostEdgeGlow;
           /* Reinhard ceiling, the IceMaterial convention: rim, band and burn
              all peak on the silhouette of a dissolving ghost at once, and
              bloom turns the sum into a white smear without it. */
           glow /= 1.0 + glow * 0.3;
           totalEmissiveRadiance += glow * presence;

           diffuseColor.a *= presence * keep * mix(1.0, rim, clamp(uGhostFacing, 0.0, 1.0));
         }`
      );
  });

  // I8 — the harness's pause test looks for uniform boxes here, and reports
  // sixteen live sliders as dead if it cannot find them.
  material.userData.uniforms = uniforms;
  material.userData.sync = (look) => applyGhostLook(uniforms, look);
  return material;
}

/** Push a `ghostLook()` into a ghost material's uniform boxes. */
export function applyGhostLook(uniforms, look) {
  const l = look ?? {};
  copyColor(uniforms.uGhostTint.value, l.tint ?? '#d5be8c');
  copyColor(uniforms.uGhostDeep.value, l.deep ?? '#3b3526');
  copyColor(uniforms.uGhostRimColor.value, l.rimColor ?? '#f2e6c4');
  uniforms.uGhostBleach.value = saturate(l.bleach ?? 0.7);
  uniforms.uGhostFade.value = saturate(l.fade ?? 1);
  uniforms.uGhostFacing.value = saturate(l.facing ?? 0.35);
  uniforms.uGhostRim.value = Math.max(l.rim ?? 1.4, 0);
  uniforms.uGhostRimPower.value = Math.max(l.rimPower ?? 2.6, 0.05);
  uniforms.uGhostGlow.value = Math.max(l.glow ?? 0.35, 0);
  uniforms.uGhostBandScale.value = l.bandScale ?? 5.5;
  uniforms.uGhostBandSpeed.value = l.bandSpeed ?? 0.9;
  uniforms.uGhostErode.value = saturate(l.erode ?? 0);
  uniforms.uGhostErodeScale.value = Math.max(l.erodeScale ?? 3.4, 1e-3);
  uniforms.uGhostEdge.value = Math.max(l.edge ?? 0.14, 1e-3);
  uniforms.uGhostEdgeGlow.value = Math.max(l.edgeGlow ?? 2.2, 0);
  uniforms.uGhostSeed.value = l.seed ?? 0;
  return uniforms;
}

/** Walk two hierarchies of identical shape at once. */
function parallelTraverse(a, b, visit) {
  visit(a, b);
  const n = Math.min(a.children.length, b.children.length);
  for (let i = 0; i < n; i++) parallelTraverse(a.children[i], b.children[i], visit);
}

/**
 * One echo of the caster: a real clone of its skinned meshes, on its own
 * skeleton, that the recorder can drive to any past pose.
 *
 * ## Why a clone and not a second draw of the same mesh
 *
 * Skinning happens on the GPU from a per-skeleton matrix palette. Two ghosts
 * showing two different instants need two palettes, therefore two `Skeleton`s,
 * therefore two sets of `Bone` objects for `Skeleton.update()` to read. There
 * is no arrangement in which N poses of one rig cost one draw call; the honest
 * options were N clones, or a proxy that is not the character. The roster entry
 * for `echostep` says "They are the character, not a proxy; that is what makes
 * it unsettling", so it is N clones, and the ceiling is stated instead of
 * hidden: about seventy `Object3D`s and one draw call each.
 *
 * **Geometry and textures are shared with the source.** `dispose()` frees the
 * ghost material and nothing else — freeing the geometry would take the
 * character down with it.
 *
 * ## The one rule
 *
 * **`setSource()` once, off the cast.** It is the only allocating call in the
 * class, it is idempotent, and `createShaders()` is where it belongs.
 */
export class GhostRig {
  /**
   * @param {import('three').Object3D} parent the ability's group
   * @param {object} [options]
   * @param {import('three').Object3D} [options.source] the rig to copy; may be
   *   supplied later with `setSource()`
   * @param {import('three').Material} [options.material] share one ghost
   *   material between several rigs, or leave null for one of its own
   * @param {number} [options.layer=LAYER.VFX] VFX rather than WORLD, because
   *   the depth prepass renders WORLD with an override material and a
   *   transparent ghost written into it makes every soft particle behind it
   *   fade against a person who is not really there
   * @param {number} [options.renderOrder=4]
   */
  constructor(parent, options = {}) {
    this.object3D = new Group();
    this.object3D.name = 'GhostRig';
    this.object3D.matrixAutoUpdate = true;
    parent?.add(this.object3D);

    this._layer = options.layer ?? LAYER.VFX;
    this._renderOrder = options.renderOrder ?? 4;
    /** True when the material came from outside and must not be disposed here. */
    this._ownsMaterial = !options.material;
    this.material = options.material ?? null;

    /** Cloned bones, index-matched to `TimeRecorder.bones`. */
    this.bones = [];
    this.meshes = [];
    this.source = null;
    this._clone = null;

    if (options.source) this.setSource(options.source);
  }

  /** One per skinned mesh in the source rig. Zero before `setSource()`. */
  get drawCalls() {
    return this.meshes.length;
  }

  get boneCount() {
    return this.bones.length;
  }

  get hasSource() {
    return this.source !== null;
  }

  get visible() {
    return this.object3D.visible;
  }

  set visible(value) {
    this.object3D.visible = !!value;
  }

  /**
   * Build the clone. Idempotent, and the only allocating call in the class.
   *
   * @param {import('three').Object3D|null} source
   * @returns {boolean} true once the rig is usable
   */
  setSource(source) {
    if (this.source === source) return this.source !== null;
    this._teardown();
    if (!source) return false;

    const clone = source.clone(true);
    const map = new Map();
    parallelTraverse(source, clone, (a, b) => map.set(a, b));

    // The ghost material inherits from the first material it finds, so it keeps
    // the character's skin and normal map rather than inventing a look.
    if (!this.material) {
      let first = null;
      source.traverse((node) => {
        if (first || !node.material) return;
        first = Array.isArray(node.material) ? node.material[0] : node.material;
      });
      this.material = createGhostMaterial(first);
      this._ownsMaterial = true;
    }

    for (const [original, copy] of map) {
      if (!copy.isMesh && !copy.isSkinnedMesh) continue;

      copy.material = this.material;
      copy.castShadow = false;
      copy.receiveShadow = false;
      // The clone is driven by bones the frustum test knows nothing about, and
      // a ghost popping out at the edge of the screen is the sort of bug that
      // takes an afternoon to attribute.
      copy.frustumCulled = false;
      copy.layers.set(this._layer);
      copy.renderOrder = this._renderOrder;
      this.meshes.push(copy);

      if (!original.isSkinnedMesh || !original.skeleton) continue;

      const sourceBones = original.skeleton.bones;
      const bones = [];
      let complete = true;
      for (const bone of sourceBones) {
        const cloned = map.get(bone);
        if (!cloned) {
          complete = false;
          break;
        }
        bones.push(cloned);
      }
      if (!complete) {
        // A rig whose bones live outside the subtree we cloned would leave the
        // ghost bound to the *caster's* skeleton, so it would mirror the live
        // character exactly and look like a rendering bug rather than an echo.
        console.warn('[GhostRig] the source skeleton reaches outside the cloned subtree; not binding');
        continue;
      }

      // Copies of the inverses, not the array and not the matrices. Skeleton
      // only rewrites them in `calculateInverses()`, which nothing here calls —
      // but sharing them means a future caller of it silently re-binds the
      // character's own mesh, and that is not a bug anybody would find.
      const inverses = original.skeleton.boneInverses.map((m) => new Matrix4().copy(m));
      copy.bind(new Skeleton(bones, inverses), original.bindMatrix);
    }

    // The playback index. Built by walking the *source* exactly the way
    // `TimeRecorder.attach()` walks it — traversal order, skeleton bones,
    // deduplicated — rather than by taking the first skeleton's list, so bone
    // `i` on the track is bone `i` here even for a rig whose second skinned
    // mesh brings bones the first one never had. Getting this out of step is a
    // ghost whose forearm is driven by somebody's jaw.
    const seen = new Set();
    source.traverse((node) => {
      if (!node.isSkinnedMesh || !node.skeleton) return;
      for (const bone of node.skeleton.bones) {
        if (!bone || seen.has(bone)) continue;
        seen.add(bone);
        const cloned = map.get(bone);
        if (cloned) this.bones.push(cloned);
      }
    });

    this.object3D.add(clone);
    this._clone = clone;
    this.source = source;
    return true;
  }

  /**
   * Place the ghost in the world.
   *
   * Separate from the pose on purpose. In this sandbox the caster does not
   * move, so a recorded *transform* track is almost a constant and the
   * interesting part of a recording is the pose; the ability is what walks the
   * echoes down the line. `TimeRecorder.transformAt()` is there for the day
   * something does move.
   *
   * @param {import('three').Vector3} position
   * @param {number|import('three').Quaternion} [heading] radians about world +Y,
   *   or a quaternion straight off the recorder
   */
  place(position, heading = 0) {
    this.object3D.position.copy(position);
    if (typeof heading === 'number') this.object3D.quaternion.setFromAxisAngle(UP, heading);
    else if (heading) this.object3D.quaternion.copy(heading);
    return this;
  }

  /** Uniform scale, metres per metre. A shrinking echo reads as a receding one. */
  setScale(scale) {
    this.object3D.scale.setScalar(scale);
    return this;
  }

  /** Push this frame's look. See `ghostLook()`. */
  sync(look) {
    if (this.material?.userData?.uniforms) applyGhostLook(this.material.userData.uniforms, look);
    return this;
  }

  /** Free the material. Geometry and textures belong to the character. */
  dispose() {
    this._teardown();
    if (this._ownsMaterial) this.material?.dispose();
    this.material = null;
    this.object3D.parent?.remove(this.object3D);
  }

  _teardown() {
    if (this._clone) this.object3D.remove(this._clone);
    this._clone = null;
    this.bones = [];
    this.meshes.length = 0;
    this.source = null;
  }
}

/**
 * Find the caster in a scene, without editing anybody's context object.
 *
 * `CharacterController` names its root `'Character'` and `App` adds it straight
 * to the scene, and `ctx.scene` is already in the context every ability is
 * constructed with. That is the whole hook: no new service, no change to
 * `AbilityManager`, no ordering problem with the character's asynchronous load.
 *
 * Call it **once**, in `createShaders()`, and keep the result. `getObjectByName`
 * is a full traversal and has no business in a frame path.
 */
export function findCaster(scene) {
  return scene?.getObjectByName?.('Character') ?? null;
}

/* ====================================================================== */
/* 4 · Reverse                                                             */
/* ====================================================================== */

/**
 * Canonical parameters for the reverse beat.
 *
 * Every one of them is a live slider, which is the point: `reverseTime` is a
 * closed form over them, so dragging `back` while the sandbox is paused
 * re-times a rewind that is already halfway through itself.
 */
export function reverseParams() {
  return {
    rate: 1, // × forward speed before the turn
    turnAt: 0.55, // seconds of ability age at which time stops going forward
    hold: 0.12, // seconds held at the turn — the beat you can see coming
    back: 1.8, // × the speed it then runs backwards at
    floor: 0 // the earliest instant the clock may reach, seconds
  };
}

/**
 * The bent clock, as a closed-form function of the ability's age.
 *
 * Three legs: forward at `rate`, a hold, then backwards at `back` until it hits
 * `floor`. Hand the result to any module's `now` and that module runs the beat.
 *
 * The hold is not decoration. A reversal with no pause at the top reads as a
 * glitch — the eye needs the moment where nothing moves to understand that what
 * follows is the same motion inverted rather than a different motion. The
 * `hourglass` roster entry calls the same thing "a beat you can see coming".
 *
 * @param {number} age seconds since the cast
 * @param {object} p   live params — see `reverseParams()`
 */
export function reverseTime(age, p) {
  const rate = p?.rate ?? 1;
  const turn = Math.max(p?.turnAt ?? 0.55, 0);
  const hold = Math.max(p?.hold ?? 0.12, 0);
  const back = p?.back ?? 1.8;
  const floor = p?.floor ?? 0;
  if (age <= turn) return Math.max(floor, age * rate);
  const peak = turn * rate;
  if (age <= turn + hold) return Math.max(floor, peak);
  return Math.max(floor, peak - (age - turn - hold) * back);
}

/**
 * The signed speed of that clock, d(time)/d(age).
 *
 * `+rate` on the way out, `0` at the top and once the floor is reached, `-back`
 * on the way home. What an ability switches its *irreversible* behaviour on:
 * emit while this is positive, stop while it is not.
 */
export function reverseRate(age, p) {
  const rate = p?.rate ?? 1;
  const turn = Math.max(p?.turnAt ?? 0.55, 0);
  const hold = Math.max(p?.hold ?? 0.12, 0);
  const back = p?.back ?? 1.8;
  const floor = p?.floor ?? 0;
  if (age <= turn) return age * rate <= floor ? 0 : rate;
  if (age <= turn + hold) return 0;
  return turn * rate - (age - turn - hold) * back <= floor ? 0 : -back;
}

/**
 * The integrating alternative to `reverseTime`.
 *
 * Use it when the rate genuinely comes from somewhere that is not a slider — a
 * held key, a chained ability, a rate that is itself a function of what the
 * cast hit. Prefer the closed form everywhere else, and know what you are
 * giving up when you do not: **an accumulated clock cannot be re-derived, so a
 * paused slider drag has no retroactive effect on it.** The current frame's
 * step is still `dt × rate`, so the sliders are live going forward; the history
 * is simply already spent.
 *
 * It exists mostly for the two things it *does* own that a closed form cannot:
 * `turned`, the frame the direction flipped, and `emitDt`, the guard rail that
 * keeps a reversal from feeding a negative number to something that logs.
 */
export class TimeWarpClock {
  constructor(start = 0) {
    this.reset(start);
  }

  reset(start = 0) {
    /** The bent clock. Hand this to a module's `now`. */
    this.now = start;
    /** The signed step taken on the last `advance()`. */
    this.step = 0;
    /** The rate last asked for. */
    this.rate = 1;
    this._sign = 1;
    /** True on exactly the frame the direction of travel changed. */
    this.turned = false;
    return this;
  }

  /**
   * @param {number} dt      seconds of real simulation time
   * @param {number} [rate]  × — negative runs the clock backwards
   * @param {number} [floor] the clock may not go below this
   * @param {number} [ceiling]
   * @returns {number} the signed step actually taken, after clamping
   */
  advance(dt, rate = 1, floor = -Infinity, ceiling = Infinity) {
    this.rate = rate;
    const next = clamp(this.now + dt * rate, floor, ceiling);
    this.step = next - this.now;
    this.now = next;

    const sign = this.step > 1e-9 ? 1 : this.step < -1e-9 ? -1 : 0;
    this.turned = sign !== 0 && sign !== this._sign;
    if (sign !== 0) this._sign = sign;
    return this.step;
  }

  /** +1, -1, or the last non-zero direction while stalled. */
  get direction() {
    return this._sign;
  }

  get reversing() {
    return this.step < 0;
  }

  get stalled() {
    return this.step === 0;
  }

  /**
   * The delta the **irreversible** consumers get: `max(0, step)`.
   *
   * `RateEmitter.tick`, `ArcNetwork.update`, anything that spawns a decal.
   * Feeding a `RateEmitter` a negative delta drives its fractional accumulator
   * the wrong way and emits nothing while quietly banking credit, so the first
   * frame back on the forward leg dumps the lot.
   */
  get emitDt() {
    return Math.max(0, this.step);
  }

  /** `|step|` — for things that only want to know how much clock passed. */
  get spanDt() {
    return Math.abs(this.step);
  }
}

/**
 * A one-shot that re-arms when time runs back past it.
 *
 * The guard rail for every beat an ability fires at an instant: the burst at
 * the top of the arc, the decal under the impact, the light punch. On a
 * monotone clock these are a boolean. On a clock that can reverse they are a
 * *crossing*, and the difference is that the same beat has to be able to fire
 * again — or to be undone — when the clock comes back through it.
 *
 * `mark` is passed to `poll()` rather than held, so it stays a live slider: drag
 * the beat while the sandbox is paused and it fires under your cursor.
 *
 * @example
 *   // once, in createShaders()
 *   this._turnGate = new RewindGate();
 *   // every frame
 *   const t = reverseTime(this.age, this._warp);
 *   const crossed = this._turnGate.poll(t, settings.rewind.crackAt);
 *   if (crossed > 0) this._openCrack();
 *   else if (crossed < 0) this._closeCrack();
 */
export class RewindGate {
  constructor() {
    this.reset();
  }

  /**
   * Arm the gate on the "before" side, so the first forward crossing fires even
   * if the clock starts exactly on the mark.
   */
  reset() {
    this._side = -1;
    /** How many times this gate has fired, either way. */
    this.crossings = 0;
    return this;
  }

  /** True once the clock is past the mark. */
  get past() {
    return this._side > 0;
  }

  /**
   * @param {number} time the bent clock
   * @param {number} mark the instant to watch, live
   * @returns {number} `+1` crossed forward, `-1` crossed backward, `0` nothing
   */
  poll(time, mark) {
    const side = time >= mark ? 1 : -1;
    if (side === this._side) return 0;
    this._side = side;
    this.crossings++;
    return side;
  }
}
