import { Group, Vector3, Color } from 'three';
import { settings } from '../config/settings.js';
import { saturate, Easing } from '../utils/math.js';
import { getColor } from '../utils/color.js';
import { LAYER } from '../core/Layers.js';

export const AbilityPhase = Object.freeze({
  IDLE: 'idle',
  TRAVEL: 'travel',
  IMPACT: 'impact',
  FADE: 'fade',
  DONE: 'done'
});

const _up = new Vector3(0, 1, 0);

/**
 * Abstract base for a linear skillshot.
 *
 * The sandbox used to cast along a freehand spline; it now casts along a **line**
 * chosen with the aim indicator, so this base is correspondingly small. What it
 * still owns, because every ability wants it and none of them should re-derive
 * it:
 *
 *   - the phase machine (travel → impact → fade → done)
 *   - a front that advances along the line at a constant metres-per-second,
 *     frame-rate independent and eased off a standstill
 *   - the local frame (`direction`, `side`) every effect places itself in
 *   - dynamic light bookkeeping, including a decaying impact punch
 *   - the pooling contract: `spawn` must fully reset state, `destroy` must
 *     release, and neither may allocate
 *
 * Subclasses implement: `createShaders`, `createParticles`, `onSpawn`,
 * `onTravel`, `onImpact`, `onFade`, `onDestroy`.
 *
 * A second ability is therefore one new file plus a settings block — nothing
 * else in the project changes.
 */
export class Ability {
  /**
   * @param {string} element  key into `settings` ('ice')
   * @param {object} context  shared systems (see AbilityManager)
   */
  constructor(element, context) {
    this.element = element;
    this.ctx = context;

    this.group = new Group();
    this.group.name = `Ability:${element}`;
    this.group.layers.set(LAYER.VFX);
    this.group.matrixAutoUpdate = false;

    this.phase = AbilityPhase.IDLE;

    /** Where the cast came from, on the floor. */
    this.origin = new Vector3();
    /** Unit heading, flat. */
    this.direction = new Vector3(0, 0, 1);
    /** Unit lateral, `direction × up`. */
    this.side = new Vector3(1, 0, 0);
    /** How far the cast reaches, metres. */
    this.length = 1;

    /** Metres the fracture front has travelled. */
    this.front = 0;
    /** That front as a fraction of `length`. */
    this.u = 0;
    /** World position of the front — what the camera frames. */
    this.position = new Vector3();

    this.age = 0;
    this.impactTime = 0;
    this.fadeTime = 0;

    this.light = null;
    this.lightColor = new Color();
    /** Transient additive light punch (impacts). Decays on its own. */
    this.lightBoost = 0;

    /**
     * Handles this cast has borrowed from a **global** pool — a scene hook
     * (`vfx/SceneHooks.js`), a time region (`vfx/TimeControl.js`), anything
     * else whose `acquire()` takes a slice of the world away from everybody
     * else. See `borrow()`.
     *
     * Allocated once, per instance, at construction; `destroy()` empties it in
     * place. An ability is pooled, so this array is created a handful of times
     * for the life of the app and never during a cast — I3 holds.
     */
    this.borrowed = [];

    this.createShaders();
    this.createParticles();
  }

  /** Live settings block for this element. */
  get config() {
    return settings[this.element];
  }

  get isActive() {
    return this.phase !== AbilityPhase.IDLE && this.phase !== AbilityPhase.DONE;
  }

  get isFinished() {
    return this.phase === AbilityPhase.DONE;
  }

  /** Instanced geometry this cast is currently drawing. HUD readout only. */
  get instanceCount() {
    return 0;
  }

  /* ------------------------------------------------------------------ */
  /* Subclass hooks                                                      */
  /* ------------------------------------------------------------------ */

  /** Build materials/meshes once, at construction. */
  createShaders() {}

  /** Register the shared particle systems this element needs. */
  createParticles() {}

  /** Called at the start of every cast, after the base state was reset. */
  onSpawn() {}

  /** Per-frame while the front is still travelling. */
  onTravel(_dt) {}

  /** One-shot when the front reaches the end of the line. */
  onImpact() {}

  /**
   * Per-frame after the impact.
   * @param {number} t 0..1 through the impact phase, then 1..2 through the fade.
   */
  onFade(_dt, _t) {}

  /** Release any per-cast resources. */
  onDestroy() {}

  /** How long the impact and fade phases last. Overridable per element. */
  get impactDuration() {
    return 1.1;
  }

  get fadeDuration() {
    return 1.2;
  }

  /**
   * Per-frame multiplier on the dynamic light's intensity.
   *
   * The default is a slow shimmer rather than a flicker: ice glints, it does not
   * gutter. Elements that *should* gutter override this.
   */
  lightShimmer() {
    return 0.9 + 0.1 * Math.sin(this.age * 9.3) * Math.sin(this.age * 3.7);
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Begin a cast.
   *
   * @param {THREE.Vector3} origin     on the floor
   * @param {THREE.Vector3} direction  unit, flat
   * @param {number} distance          metres
   */
  spawn(origin, direction, distance) {
    this.origin.set(origin.x, 0, origin.z);
    this.direction.copy(direction).setY(0).normalize();
    this.side.crossVectors(this.direction, _up).normalize();
    this.length = Math.max(0.1, distance);

    this.front = 0;
    this.u = 0;
    this.age = 0;
    this.impactTime = 0;
    this.fadeTime = 0;
    this.lightBoost = 0;
    this.phase = AbilityPhase.TRAVEL;

    this.position.copy(this.origin);
    this.light = this.ctx.lights.acquire();

    this.group.visible = true;
    this.onSpawn();
  }

  /** A point on the cast line. `s` is 0..1 along it. */
  pointAt(s, out) {
    return out.copy(this.origin).addScaledVector(this.direction, s * this.length);
  }

  /**
   * Advance the front. Delta-time driven, so the eruption travels at a constant
   * metres-per-second regardless of frame rate or how long the cast is.
   *
   * @returns {boolean} true on the frame the front reaches the end
   */
  advance(dt) {
    const speed = this.config.speed * settings.global.speed;
    // Ease off the standstill so the front has weight. Keyed off elapsed time
    // rather than progress: keying it off `u` would multiply the very first step
    // by zero and the front could never leave the caster.
    const easeIn = Easing.outQuad(saturate(this.age / 0.08));

    this.front += speed * easeIn * dt;
    const previousU = this.u;
    this.u = saturate(this.front / this.length);
    this.pointAt(this.u, this.position);

    return this.u >= 1 && previousU < 1;
  }

  update(dt) {
    if (!this.isActive) return;
    this.age += dt;

    switch (this.phase) {
      case AbilityPhase.TRAVEL: {
        const reachedEnd = this.advance(dt);
        this.onTravel(dt);
        this._updateLight(dt, 1);
        if (reachedEnd) {
          this.phase = AbilityPhase.IMPACT;
          this.impactTime = 0;
          this.onImpact();
        }
        break;
      }

      case AbilityPhase.IMPACT: {
        this.impactTime += dt;
        const t = saturate(this.impactTime / this.impactDuration);
        this.onFade(dt, t);
        this._updateLight(dt, 1 - Easing.inQuad(t) * 0.45);
        if (t >= 1) {
          this.phase = AbilityPhase.FADE;
          this.fadeTime = 0;
        }
        break;
      }

      case AbilityPhase.FADE: {
        this.fadeTime += dt;
        const t = saturate(this.fadeTime / this.fadeDuration);
        this.onFade(dt, 1 + t);
        this._updateLight(dt, (1 - t) * 0.35);
        if (t >= 1) this.phase = AbilityPhase.DONE;
        break;
      }

      default:
        break;
    }
  }

  _updateLight(dt, scale) {
    if (!this.light) return;
    const cfg = this.config;
    this.lightColor.copy(getColor(cfg.lightColor));
    const shimmer = this.lightShimmer();
    this.ctx.lights.set(
      this.light,
      this.position,
      this.lightColor,
      cfg.lightIntensity * scale * shimmer + this.lightBoost,
      cfg.lightRadius * (1 + this.lightBoost * 0.02),
      dt
    );
    this.lightBoost = Math.max(0, this.lightBoost - this.lightBoost * 4.5 * dt - 0.5 * dt);
  }

  /**
   * Register a borrowed global handle so `destroy()` gives it back.
   *
   * ```js
   * this.region = this.borrow(timeField.acquire());              // may be null
   * this.grade  = this.borrow(sceneHooks.acquire(Hook.GRADE, this));
   * ```
   *
   * This exists because a cast can end in four different ways and only one of
   * them is the ability's idea. It finishes normally; the player presses **C**
   * and `AbilityManager#clear()` destroys it mid-flight; a fifth cast pushes it
   * off the front of the concurrency cap; the app tears down. `onDestroy()` is
   * called on all four, so an ability that releases there is already correct —
   * and every one of the fifty is. The net is here for the same reason
   * `ctx.lights.release(this.light)` is on the line below it rather than in
   * fifty `onDestroy()` bodies: a light that leaks costs the next cast its
   * light, but a **scene hook** that leaks holds the sun, the grade or the
   * floor's material wrong for the rest of the session, and a leaked **time
   * region** stops a sphere of the world permanently. Those are not failures
   * anybody would trace back to the ability that caused them.
   *
   * `SceneHooks` does carry an eight-frame lease sweep as a second net, but it
   * recovers with a console warning several frames late; this recovers exactly,
   * on the frame, silently. `TimeField` has no sweep at all — it cannot have
   * one, because nothing ticks it — so for time regions this *is* the net.
   *
   * Nothing is imported to make it work: every such handle knows its own pool
   * (`token.hooks`, `region._field`) and every `release()` in the project is
   * idempotent, so releasing here and again in `onDestroy()` is harmless and
   * the order does not matter.
   *
   * @template T
   * @param {T} handle anything with a `release()`; `null` passes through
   * @returns {T} the same handle, so this wraps the acquisition inline
   */
  borrow(handle) {
    if (handle) this.borrowed.push(handle);
    return handle;
  }

  /** Return to the pool. Must leave the instance reusable. */
  destroy() {
    this.onDestroy();
    this.ctx.lights.release(this.light);
    this.light = null;
    // Backwards: a handle released inside onDestroy() is already inert, and
    // popping from the end keeps this allocation-free.
    for (let i = this.borrowed.length - 1; i >= 0; i--) this.borrowed[i]?.release?.();
    this.borrowed.length = 0;
    this.group.visible = false;
    this.phase = AbilityPhase.IDLE;
  }

  /** Free GPU resources (app teardown only — not part of pooling). */
  dispose() {
    this.group.parent?.remove(this.group);
  }
}
