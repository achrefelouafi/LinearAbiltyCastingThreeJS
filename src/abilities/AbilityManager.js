import { ABILITY_IDS, getAbility } from './registry.js';
import { ObjectPool } from '../utils/ObjectPool.js';

const MAX_CONCURRENT = 4;

/**
 * Spawns, updates and recycles abilities.
 *
 * Instances are pooled per id: casting fifty times constructs at most a handful
 * of objects per ability, and every one of them keeps its meshes and materials
 * for the lifetime of the app. Nothing is built during a cast.
 *
 * `MAX_CONCURRENT` is shared across ids, so mixing abilities retires the oldest
 * cast whichever one it was.
 *
 * ## Laziness
 *
 * The manager used to import all six ability classes at the top of this file
 * and build a pool for each in its constructor. At fifty that is fifty modules
 * parsed and fifty sets of meshes, materials and particle systems constructed
 * before the loading bar has finished — for the one ability the player is about
 * to press Q on.
 *
 * So a pool is now built the first time an id is **selected or cast**, from the
 * registry descriptor's `load()`. The awkward part is that an import is a
 * promise and a cast is a click: the player is not going to wait a microtask
 * for `Frost Lance` to arrive. Three things resolve that, in order of how much
 * they matter:
 *
 *  1. `App` calls `warm(id)` the moment an ability is *selected*, which is
 *     always at least one frame — usually several seconds — before the click.
 *     By the time the arrow has swept out the class is in memory and the pool
 *     is primed with a live instance.
 *  2. The constructor warms whatever is in slot one, so the very first cast of
 *     a session is ready too.
 *  3. If a cast still arrives cold, `cast()` kicks off the import and returns
 *     `null` — nothing is drawn this frame, and the next click works. It never
 *     awaits, because an `async` cast would put an ability on screen a frame
 *     after the animation that threw it, and a spell that lags its own gesture
 *     reads as broken in a way a dropped first cast does not.
 */
export class AbilityManager {
  /**
   * @param {object} context shared systems handed to every ability:
   *   { scene, camera, environment, particles, lights, decals, bursts, shake, flash }
   */
  constructor(context) {
    this.ctx = context;
    this.active = [];
    this.selected = ABILITY_IDS[0];

    /** id → ObjectPool, created on first warm. */
    this.pools = new Map();
    /** id → the loaded class, once its import has settled. */
    this._classes = new Map();
    /** id → the in-flight import, so a held key never fires two of them. */
    this._loading = new Map();

    // Slot one is armed before the player has touched anything; have it ready.
    this.warm(this.selected);
  }

  /* ------------------------------------------------------------------ */
  /* Loading                                                             */
  /* ------------------------------------------------------------------ */

  /** Whether this id can be cast on the current frame. */
  isReady(id) {
    return this.pools.has(id);
  }

  /**
   * Load an ability's class and prime its pool, off the frame loop.
   *
   * Idempotent and cheap to call every time a slot is selected: an id that is
   * already loaded resolves immediately, and an id that is mid-import returns
   * the same promise rather than starting a second one.
   *
   * Priming means constructing one instance now, which is where the meshes,
   * materials and particle systems get built — the expensive part, moved off
   * the click and onto the selection. The instance goes into the scene
   * invisible, exactly as the eager constructor used to leave it.
   *
   * @param {string} id
   * @returns {Promise<boolean>} true once the id is castable
   */
  warm(id) {
    if (this.pools.has(id)) return Promise.resolve(true);

    const existing = this._loading.get(id);
    if (existing) return existing;

    const descriptor = getAbility(id);
    if (!descriptor) return Promise.resolve(false);

    const pending = descriptor
      .load()
      .then((Type) => {
        this._classes.set(id, Type);
        // Two selections can land in the same tick; the first one to arrive
        // wins and the second finds the pool already built.
        if (!this.pools.has(id)) {
          const pool = new ObjectPool(() => {
            const ability = new Type(this.ctx);
            this.ctx.scene.add(ability.group);
            ability.group.visible = false;
            return ability;
          });
          // Prime with one, so the first cast of this id allocates nothing.
          pool.release(pool.acquire());
          this.pools.set(id, pool);
        }
        return true;
      })
      .catch((error) => {
        // A failed import must not poison the slot forever — clearing the
        // in-flight entry lets the next selection try again.
        console.error(`AbilityManager: failed to load "${id}"`, error);
        return false;
      })
      .finally(() => {
        this._loading.delete(id);
      });

    this._loading.set(id, pending);
    return pending;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Put an ability in the slot.
   *
   * Deliberately *only* state: warming is `App`'s call, made from
   * `selectAbility()` at the same moment, and keeping the two separate means
   * the spellbook can warm an ability it is merely hovering without selecting
   * it. A caller that selects and forgets to warm loses one cast and no more —
   * `cast()` self-heals.
   */
  select(id) {
    if (!getAbility(id)) return;
    this.selected = id;
  }

  /**
   * Cast the selected ability along a line.
   *
   * A far cast takes the same three arguments and simply works from the far end
   * of that line — which is why adding zone targeting needed nothing here.
   *
   * Returns `null` if the id is unknown, or if its class has not finished
   * loading; in the second case the import is kicked off and the next cast
   * works. See the class header for why this does not await.
   *
   * @param {THREE.Vector3} origin     on the floor
   * @param {THREE.Vector3} direction  unit, flat
   * @param {number} distance          metres
   * @returns {import('./Ability.js').Ability|null}
   */
  cast(origin, direction, distance, element = this.selected) {
    if (!getAbility(element)) return null;

    const pool = this.pools.get(element);
    if (!pool) {
      this.warm(element);
      return null;
    }

    // Retire the oldest cast rather than letting the scene grow without bound.
    if (this.active.length >= MAX_CONCURRENT) {
      const oldest = this.active.shift();
      oldest.destroy();
      this.pools.get(oldest.element).release(oldest);
    }

    const ability = pool.acquire();
    ability.spawn(origin, direction, distance);
    this.active.push(ability);
    return ability;
  }

  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const ability = this.active[i];
      ability.update(dt);
      if (ability.isFinished) {
        this.active.splice(i, 1);
        ability.destroy();
        this.pools.get(ability.element).release(ability);
      }
    }
  }

  /** Cancel everything currently in flight. */
  clear() {
    for (const ability of this.active) {
      ability.destroy();
      this.pools.get(ability.element).release(ability);
    }
    this.active.length = 0;
  }

  /** The most recent still-running cast — used to frame the camera. */
  get focus() {
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i].isActive) return this.active[i];
    }
    return null;
  }

  dispose() {
    this.clear();
    for (const pool of this.pools.values()) pool.dispose((ability) => ability.dispose());
    this.pools.clear();
    this._classes.clear();
    this._loading.clear();
  }
}
