import { Mesh, Vector3, Quaternion, Object3D, Color } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { ShatterField, ShatterLayout } from '../../vfx/ShatterField.js';
import {
  HardShape,
  ShapeCache,
  plateShape,
  boltShape,
  createHardSurfaceMaterial,
  syncHardSurfaceMaterial,
  heatToKelvin,
  blackbodyColor
} from '../../vfx/HardSurface.js';
import { GroundField, GroundMode } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, Easing } from '../../utils/math.js';

/** Hard ceiling on fragments in the air. The editor's `fragCount` clamps here. */
const CAPACITY = 96;
/** Two silhouettes — a torn plate and a bolt — so two draw calls, and no more. */
const VARIANTS = 2;
/**
 * Craters the floor carries.
 *
 * One per fragment would be ninety-six `vec4`s in a fixed trip count, which is
 * the most expensive fragment shader in the project for a mark you cannot pick
 * out of a crowd. Fourteen is enough that the ring of first bounces reads as a
 * ring; the rest of the fragments bounce just as hard and simply do not sign
 * the floor.
 */
const POCK_MARKS = 14;
/** `ShapeCache` slots: the two fragment kinds and the canister. */
const SLOT_PLATE = 0;
const SLOT_BOLT = 1;
const SLOT_CANISTER = 2;

/* --- module-scope scratch: nothing below allocates on a frame (I3) --- */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _land = new Vector3();
const _contact = new Vector3();
const _outgoing = new Vector3();
const _tint = new Color();
/** Params objects, rewritten whole every frame and never cached between them. */
const _hard = {};
const _pock = { centre: new Vector3() };
const _throw = { origin: new Vector3(), direction: new Vector3(), side: new Vector3(), centre: new Vector3() };

/* --- scratch belonging to the field's own solver --- */
const _dummy = new Object3D();
const _vel = new Vector3();
const _axis = new Vector3();
const _spin = new Quaternion();
const _up = new Vector3(0, 1, 0);
const _bearing = new Vector3();
const _wild = new Vector3();

/**
 * A `ShatterField` whose fragments **bounce**.
 *
 * ### Why this is a subclass and not a params flag
 *
 * `ShatterField`'s flight is a closed form — position is a pure function of
 * `now − born` against the live params — and that is exactly right, because it
 * is what lets a paused `gravity` re-fly everything already in the air. It also
 * ends at a `Math.min` against the floor: a fragment reaches the ground, stops
 * dead, and keeps `floorSpin` of its tumble. For ice and for stone that is the
 * truth. For machined steel on flagstone it is the one thing that makes a
 * burst read as a shatter, and the roster's brief for this slot is precisely
 * that difference.
 *
 * The bounce cannot be a parameter of the existing solution, because a bounce
 * is a *piecewise* trajectory and the analytic drag form
 * `p(t) = p₀ + (v₀ − g/k)(1 − e^{−kt})/k + (g/k)t` does not survive being cut
 * into segments — the exponential has to restart at every contact, and there
 * is no closed form for the contact time once it does. So drag is dropped and
 * the flight is piecewise ballistic instead, which *is* solvable exactly:
 *
 * ```
 *   ½g·τ² + v_y·τ + (y − F) = 0      ⇒   τ = (−v_y − √(v_y² − 2g(y−F))) / g
 * ```
 *
 * with `g < 0`, `y ≥ F`, and therefore a discriminant that is never negative
 * and a root that is never non-positive. At each contact the vertical speed
 * flips and is scaled by `restitution`, the horizontal by `1 − friction`, and
 * the tumble rate by `tumbleKeep`. Past `bounces` contacts the next one is
 * treated as perfectly inelastic; below `stopSpeed` the piece settles and
 * slides out its remaining speed on an exponential `slide`.
 *
 * Everything above is re-evaluated from the live params on every frame, so
 * dragging `restitution` on a paused cast genuinely re-flies every fragment
 * through a different set of bounces — which an integrator could not do, and
 * which is the same reason the base class is written the way it is.
 *
 * ### The tumble, and why `update()` is overridden too
 *
 * The base computes the tumble as `rate · age`, with `rate` dropped to
 * `floorSpin` on any frame the fragment is touching down. With a bounce in
 * play the fragment touches down repeatedly, so that rate flickers between two
 * values and the *angle* — being the rate times the whole age — jumps by
 * several radians each time. The fragments visibly teleport their orientation
 * at every contact. So the solver accumulates its own **effective spin time**
 * (`_turns`), damped once per contact, and `update()` uses `rate · turns`,
 * which is continuous across a bounce by construction. That is the roster's
 * "a tumble that survives the bounce", and it is worth knowing it is not free.
 */
class RicochetField extends ShatterField {
  constructor(parent, options) {
    super(parent, options);
    /** Effective spin seconds for the last fragment `_flight()` solved. */
    this._turns = 0;
  }

  /** Un-shrunk body size of a fragment, metres. */
  _baseSizeOf(record, p) {
    const jitter = p.randomness ?? 1;
    return Math.max(0.001, (p.size ?? 0.25) * (1 + record.sizeRoll * (p.sizeJitter ?? 0) * jitter));
  }

  /**
   * The height a resting fragment's **centre** sits at, metres above `floor`.
   *
   * The base class applies this as a clamp after the flight, which flattens the
   * bottom of every bounce by the same amount and makes the low arcs skip
   * rather than bounce. Folding it into the solver's floor instead means the
   * contact happens where the fragment actually touches.
   */
  _seatOf(record, p) {
    return this._baseSizeOf(record, p) * (p.seat ?? 0.34);
  }

  /**
   * Launch velocity: radially outward from the burst, at `elevation`, at a
   * speed **fitted to the zone radius**.
   *
   * The base throws every fragment along the cast direction, which is what a
   * lance breaking wants. A canister does not have a direction; it has a
   * bearing per fragment, and `record.angle` is already the bearing
   * `_anchorOf` placed that fragment on. Ballistic range for a launch at `θ`
   * is `R = v²·sin(2θ)/g`, so inverting it puts the first touchdown on the
   * circle the player aimed at — see the class comment on the ability.
   */
  _velocityOf(record, p, out) {
    const jitter = p.randomness ?? 1;
    const spread = saturate(p.spread ?? 0.3);
    const elevation = clamp(p.elevation ?? 0.62, 0.03, 1.5);

    const angle = record.angle * Math.PI * 2;
    _bearing.set(Math.cos(angle), 0, Math.sin(angle));
    out.copy(_bearing).multiplyScalar(Math.cos(elevation)).addScaledVector(_up, Math.sin(elevation));

    _wild.set(record.dirX, record.dirY, record.dirZ);
    out.lerp(_wild, spread);
    if (out.lengthSq() < 1e-8) out.copy(_up);
    out.normalize();

    const g = Math.abs(p.gravity ?? -20);
    const range = Math.max(p.range ?? 4, 0.05);
    // sin(2θ) collapses at a vertical or a grazing launch; the floor keeps the
    // fitted speed finite rather than letting the sheaf reach the horizon.
    const fitted = Math.sqrt((range * g) / Math.max(Math.sin(2 * elevation), 0.06));
    const speed = fitted * (p.speedScale ?? 1) * (1 + record.speedRoll * (p.speedJitter ?? 0) * jitter);
    return out.multiplyScalar(speed);
  }

  /**
   * The piecewise ballistic with a real restitution at every contact.
   *
   * Writes `out` and, as a side effect, `this._turns` — the effective spin
   * seconds this fragment has accumulated, damped once per bounce. The side
   * channel exists because the base's contract is `_flight(record, p, t, out)`
   * and adding a fifth argument would break `positionOf()`, which the ability
   * uses to hang sparks off a contact.
   */
  _flight(record, p, t, out) {
    this._anchorOf(record, p, out);
    this._velocityOf(record, p, _vel);

    const floorY = (p.floor ?? 0) + this._seatOf(record, p);
    const g = Math.min(p.gravity ?? -20, -0.01);
    const bounce = saturate(p.restitution ?? 0.45);
    const mu = saturate(p.friction ?? 0.3);
    const keep = saturate(p.tumbleKeep ?? 0.82);
    const maxBounces = Math.max(0, Math.round(p.bounces ?? 4));
    const stop = Math.max(p.stopSpeed ?? 0.6, 0.02);
    const slide = Math.max(p.slide ?? 3, 0);
    const ground = saturate(p.groundSpin ?? 0.24);

    let x = out.x;
    let y = Math.max(out.y, floorY);
    let z = out.z;
    let vx = _vel.x;
    let vy = _vel.y;
    let vz = _vel.z;
    let remain = Math.max(0, t);
    let rate = 1;
    let turns = 0;
    let hits = 0;

    // Bounded: `maxBounces` contacts plus one dead landing plus the guard.
    for (let step = 0; step <= maxBounces + 1; step++) {
      const rel = Math.max(y - floorY, 0);
      const disc = vy * vy - 2 * g * rel;
      const hit = (-vy - Math.sqrt(Math.max(disc, 0))) / g;
      if (!(hit > 1e-6)) break; // sitting on the floor with nothing left

      if (hit >= remain) {
        x += vx * remain;
        z += vz * remain;
        y += vy * remain + 0.5 * g * remain * remain;
        turns += rate * remain;
        remain = 0;
        break;
      }

      x += vx * hit;
      z += vz * hit;
      y = floorY;
      const into = vy + g * hit; // <= 0, the speed it arrives with
      vx *= 1 - mu;
      vz *= 1 - mu;
      turns += rate * hit;
      rate *= keep;
      remain -= hit;
      hits++;

      const rebound = hits > maxBounces ? 0 : -bounce * into;
      if (rebound < stop) {
        vy = 0;
        break;
      }
      vy = rebound;
    }

    if (remain > 0) {
      // Settled: it slides out what is left of its along-floor speed. The
      // exponential is the one place drag survives, and here it is exact
      // because the segment has no contact in it.
      const decay = slide > 1e-3 ? (1 - Math.exp(-slide * remain)) / slide : remain;
      x += vx * decay;
      z += vz * decay;
      y = floorY;
      turns += rate * ground * decay;
    }

    this._turns = turns;
    return out.set(x, y, z);
  }

  /**
   * Where and when a fragment first touches, and how it leaves.
   *
   * The first segment of the loop above, lifted out so the ability can hang a
   * crater and a spark spray off the contact. Returns the time since birth, or
   * `-1` for a dead slot or a fragment that never comes down.
   *
   * @param {number} index      record index
   * @param {object} p          the same live params `update()` is given
   * @param {THREE.Vector3} outPoint  the contact, world
   * @param {THREE.Vector3} outVel    the velocity leaving it, world
   */
  firstBounce(index, p, outPoint, outVel) {
    const record = this.records[index];
    if (record.born < 0) return -1;

    this._anchorOf(record, p, outPoint);
    this._velocityOf(record, p, outVel);

    const floorY = (p.floor ?? 0) + this._seatOf(record, p);
    const g = Math.min(p.gravity ?? -20, -0.01);
    const rel = Math.max(outPoint.y - floorY, 0);
    const disc = outVel.y * outVel.y - 2 * g * rel;
    const hit = (-outVel.y - Math.sqrt(Math.max(disc, 0))) / g;
    if (!(hit > 1e-6)) return -1;

    outPoint.x += outVel.x * hit;
    outPoint.z += outVel.z * hit;
    outPoint.y = floorY;

    const into = outVel.y + g * hit;
    const mu = saturate(p.friction ?? 0.3);
    outVel.x *= 1 - mu;
    outVel.z *= 1 - mu;
    outVel.y = -saturate(p.restitution ?? 0.45) * into;
    return hit;
  }

  /**
   * The base's frame loop, with two changes: the floor clamp is gone (the
   * solver owns the floor now) and the tumble reads `_turns` instead of `age`.
   *
   * Everything else — the slot arithmetic, the parking of dead records, the
   * contiguous `mesh.count` — is deliberately identical, because it is the
   * part that has to agree with `burst()` and `clear()`.
   */
  update(now, p) {
    const variants = this.variants;
    const used = this._used;
    used.fill(0);

    const lifetime = Math.max(0.02, p.lifetime ?? 1.4);
    const jitter = p.randomness ?? 1;
    const shrink = saturate(p.shrink ?? 0);
    const shrinkPower = p.shrinkPower ?? 1.6;
    let live = 0;

    for (let i = 0; i < this.capacity; i++) {
      const record = this.records[i];
      const variant = i % variants;
      const slot = (i / variants) | 0;
      const age = record.born < 0 ? -1 : now - record.born;
      const life = age / lifetime;

      if (age < 0 || life >= 1) {
        if (record.born >= 0 && life >= 1) record.born = -1;
        _dummy.position.set(0, -999, 0);
        _dummy.quaternion.identity();
        _dummy.scale.setScalar(0.0001);
        _dummy.updateMatrix();
        this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
        this.lifeAttributes[variant].array[slot] = 1;
        used[variant] = Math.max(used[variant], slot + 1);
        continue;
      }

      const size = this._baseSizeOf(record, p) * (1 - shrink * Math.pow(life, shrinkPower));

      this._flight(record, p, age, _dummy.position);

      const rate = (p.spin ?? 0) * (1 + record.spinRoll * (p.spinJitter ?? 0) * jitter);
      _axis.set(record.axisX, record.axisY, record.axisZ);
      if (_axis.lengthSq() < 1e-8) _axis.copy(_up);
      _axis.normalize();
      _spin.setFromAxisAngle(_axis, rate * this._turns);

      _dummy.quaternion.copy(_spin);
      _dummy.scale.setScalar(Math.max(size, 0.0005));
      _dummy.updateMatrix();

      this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
      this.lifeAttributes[variant].array[slot] = life;
      used[variant] = Math.max(used[variant], slot + 1);
      live++;
    }

    for (let v = 0; v < variants; v++) {
      this.meshes[v].count = used[v];
      this.meshes[v].instanceMatrix.needsUpdate = true;
      this.lifeAttributes[v].needsUpdate = true;
    }

    this._live = live;
    return live;
  }
}

/**
 * SHRAPNEL BLOOM — a machined canister is thrown at the circle and lets go.
 *
 * **THE TRICK — ricochet.** Every other shatter in this project ends with its
 * fragments stopping dead where they land, and that is the tell: a burst and a
 * shatter look identical up to the moment of contact, and completely different
 * for the second after it. So the fragments here reflect about the floor
 * normal with a real `restitution`, lose `friction` of their along-floor speed
 * at every contact, keep `tumbleKeep` of their tumble *through* the bounce,
 * and only settle once a rebound falls under `stopSpeed`. The whole flight is
 * still closed-form and still re-flown from the live sliders every frame —
 * see `RicochetField` above for why that meant dropping the base class's drag
 * term and writing the piecewise solution instead.
 *
 * **The second half of the trick is where the bounces happen.** The throw
 * speed is not authored: for a ballistic launch at `elevation`, the range is
 * `R = v²·sin(2θ)/g`, so the ability inverts it with `R = zoneRadius` and the
 * sheaf touches down on the ring the aim indicator drew. `GroundField(POCK)`
 * then takes a crater at the first `POCK_MARKS` touchdowns, and — the part
 * that matters — the ability keeps the `Vector4`s the module handed back and
 * **recomputes their positions from the solver every frame**. Drag
 * `restitution`, `elevation`, `zoneRadius`, `gravity` or `speedScale` on a
 * paused cast and the ring of dents walks across the floor with the fragments
 * that made it. A posted crater that cannot answer a slider is a captured
 * dimension wearing a timestamp's clothes.
 *
 * Three supporting decisions worth writing down:
 *
 *  - **The canister is a real bolt.** `HardSurface`'s `createBoltGeometry`,
 *    with a helical thread and a hex head, thrown on an arc and tumbling. It
 *    is what gives the travel phase something to look at and something to
 *    resolve from settings; the first version had nothing in the air at all
 *    and the cast read as a delay before an explosion.
 *  - **The fragments are hot and they cool.** `heat = heatStart · e^(−coolRate·t)`
 *    — Newton's law with the ambient at zero — driving `HardSurface`'s
 *    blackbody ramp, so the pieces go white, orange, cherry, grey as they
 *    skitter. The sparks are tinted off the *same* temperature rather than off
 *    an authored orange, which is the school's one physical conceit.
 *  - **Nothing fades.** Steel does not become transparent. At the end of the
 *    cast the floor under the fragments drops away (`exitSink`, fed straight
 *    into the solver's `floor`) and they sink with it, because that is one
 *    slider and it is honest about what is happening.
 *
 * **The rule that makes the editor work.** A cast captures a seed, a boolean
 * (has it burst), the age it burst at, and one bit per fragment saying whether
 * its first bounce has already been signed. Every metre, radian and second —
 * including both fragment silhouettes and the canister's, which go through a
 * `ShapeCache` — is resolved from `settings.shrapnel` inside the update loop,
 * on a zero-length frame included.
 */
export class ShrapnelAbility extends Ability {
  constructor(context) {
    super('shrapnel', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* ---- the steel, shared by the canister and everything it becomes ---- */
    this.steel = createHardSurfaceMaterial({
      environment: this.ctx.environment,
      flatShading: false
    });

    /**
     * Three live shapes through one cache. Rebuilt only when a number moves —
     * a bolt with a real helix is a couple of milliseconds to lathe, and doing
     * it per frame to produce a byte-identical buffer is exactly what
     * `ShapeCache` exists to stop.
     */
    this.shapes = new ShapeCache({ capacity: 3 });
    this._plate = plateShape({ cornerSteps: 4, boltSegments: 12, boltInset: 0.2 });
    this._bolt = boltShape({ shankSegments: 14, threadSteps: 5 });
    this._canister = boltShape({ shankSegments: 18, threadSteps: 6 });

    /* ---- the fragments ---- */
    this.frags = new RicochetField(this.group, {
      geometry: (variant) => this._fragmentGeometry(variant),
      variants: VARIANTS,
      capacity: CAPACITY,
      // The hard-surface material ignores `aSeed` / `aLife` — an unused
      // attribute costs nothing — and in exchange the fragments are genuinely
      // lit, shadowed, brushed steel rather than the built-in faceted tint.
      // The price is that they cannot fade, which is why they sink instead.
      material: this.steel,
      layer: LAYER.WORLD,
      renderOrder: 2,
      castShadow: true,
      receiveShadow: true
    });

    /* ---- the canister ---- */
    this.canister = new Mesh(this.shapes.get(SLOT_CANISTER, HardShape.BOLT, this._canister), this.steel);
    this.canister.castShadow = true;
    this.canister.frustumCulled = false;
    this.canister.layers.set(LAYER.WORLD);
    this.canister.renderOrder = 2;
    this.group.add(this.canister);

    /* ---- the craters the first bounces leave ---- */
    this.pocks = new GroundField(this.group, {
      mode: GroundMode.POCK,
      marks: POCK_MARKS,
      additive: false, // a nick in the floor shades it; it never lights it
      depthTest: true,
      layer: LAYER.VFX,
      name: 'ShrapnelPocks'
    });
    this.pocks.setVisible(false);

    /** Has the canister opened. */
    this._burst = false;
    /** The age it opened at — a timestamp, which is an event. */
    this._burstAt = 0;
    /** Resting phase of the sheaf, 0..1 of a turn. The one dice roll. */
    this._seed = 0;

    /**
     * One bit per fragment: has its first contact already been signed?
     *
     * The contact time is derived, so it is re-answered every frame; the *fact
     * that it has been answered once* is an event and has to be remembered, or
     * a paused cast would post a crater and a spark spray on every frame.
     */
    this._bounced = new Uint8Array(CAPACITY);
    /** The `Vector4`s the ground field handed back, and whose fragment made them. */
    this._markSlots = new Array(POCK_MARKS).fill(null);
    this._markFragment = new Int32Array(POCK_MARKS);
    this._markCount = 0;
  }

  /**
   * One fragment silhouette. Slot 0 is a torn plate, slot 1 a bolt.
   *
   * `ShatterField` tumbles about the instance origin, and `HardSurface` seats
   * its parts on `y = 0` — so an un-centred fragment orbits a point below
   * itself and reads as being swung on a string. `center()` on the rebuild is
   * the whole fix, and it only runs when the cache actually rebuilt.
   */
  _fragmentGeometry(variant) {
    const c = settings.shrapnel;
    let geometry;
    if (variant === 0) {
      const s = this._plate;
      s.width = Math.max(c.plateWidth, 0.1);
      s.depth = Math.max(c.plateDepth, 0.1);
      s.thickness = Math.max(c.plateThickness, 0.01);
      s.bevel = Math.max(c.plateBevel, 0);
      s.corner = clamp(c.plateCorner, 0, 0.5);
      s.bolts = Math.max(0, Math.round(c.plateBolts));
      s.boltRadius = Math.max(c.plateBoltRadius, 0.005);
      geometry = this.shapes.get(SLOT_PLATE, HardShape.PLATE, s);
    } else {
      const s = this._bolt;
      s.length = Math.max(c.boltLength, 0.4);
      s.headHeight = Math.max(c.boltHead, 0.1);
      s.shankRadius = clamp(c.boltShank, 0.05, 0.48);
      s.threadTurns = Math.max(c.boltThread, 0);
      s.threadDepth = Math.max(c.boltThreadDepth, 0);
      geometry = this.shapes.get(SLOT_BOLT, HardShape.BOLT, s);
    }
    if (this.shapes.changed) geometry.center();
    return geometry;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Velocity-stretched streaks. Additive, and tinted off the steel's own
    // temperature rather than off a picker — see `_sparkTint`.
    this.sparks = particles.get('shrapnel.sparks', {
      capacity: 3000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.5;
    this.sparks.uniforms.uEndSize.value = 0.22;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.44;

    // The propellant smoke. Non-additive so it occludes the fragments crossing
    // it, which is most of what tells you they are travelling outward.
    this.smoke = particles.get('shrapnel.smoke', {
      capacity: 1200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.smoke.uniforms.uDrag.value = 1.9;
    this.smoke.uniforms.uEndSize.value = 3.0;
    this.smoke.uniforms.uSizeIn.value = 0.1;
    this.smoke.uniforms.uFadeIn.value = 0.14;
    this.smoke.uniforms.uFadeOut.value = 0.32;
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.frags.count + (this._burst ? 0 : 1);
  }

  get impactDuration() {
    const c = settings.shrapnel;
    return Math.max(0.4, (c.holdTime + c.smokeLifetime * 0.5) * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.2, settings.shrapnel.fadeTime);
  }

  /** Seconds since the canister opened. Zero before it does. */
  get sinceBurst() {
    return this._burst ? Math.max(0, this.age - this._burstAt) : 0;
  }

  /**
   * The steel's temperature right now, 0..1.
   *
   * Newton's law of cooling with the ambient at zero: `T = T₀·e^(−kt)`. It is
   * a curve rather than a ramp because that is what cooling is, and because
   * the visible difference is entirely in the first half-second — a linear
   * ramp spends far too long in the orange and the fragments read as embers.
   */
  get heatNow() {
    const c = settings.shrapnel;
    if (!this._burst) return saturate(c.heatStart);
    return saturate(c.heatStart) * Math.exp(-Math.max(c.coolRate, 0) * this.sinceBurst);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this._seed = Math.random();
    this._burst = false;
    this._burstAt = 0;
    this._markCount = 0;
    this._markSlots.fill(null);
    this._bounced.fill(0);

    this.frags.clear();
    this.pocks.clearMarks();
    this.pocks.setVisible(false);
    this.canister.visible = true;

    this._sync(1, 0);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Re-resolve everything and drive the three modules.
   *
   * @param {number} fade      1 while it is fresh, ramping to 0 as the cast goes
   * @param {number} fadePhase 0..1 through the fade only — drives the floor drop
   */
  _sync(fade, fadePhase) {
    const c = settings.shrapnel;
    const g = settings.global;

    this._landingPoint(_land);
    this._syncSteel(c, g);
    this._syncCanister(c);
    this._syncFragments(c, g, fadePhase);
    this._syncPocks(c, g, fade);
    this._syncParticles(c, g);
  }

  /** Where the canister is aimed. */
  _landingPoint(out) {
    this.pointAt(1, out);
    out.y = 0;
    return out;
  }

  /** The steel. `syncHardSurfaceMaterial` every frame, zero-length ones too. */
  _syncSteel(c, g) {
    _hard.colorMetal = c.colorMetal;
    _hard.colorDeep = c.colorDeep;
    _hard.colorScale = c.colorScale;
    _hard.colorPolish = c.colorPolish;
    _hard.colorSpec = c.colorSpec;
    _hard.roughness = c.roughness;
    _hard.metalness = c.metalness;
    _hard.envIntensity = c.envIntensity;

    _hard.brush = Math.round(clamp(c.brushMode, 0, 2));
    _hard.brushAxisX = c.brushAxisX;
    _hard.brushAxisY = c.brushAxisY;
    _hard.brushAxisZ = c.brushAxisZ;
    _hard.anisotropy = c.anisotropy;
    _hard.specular = c.specular;
    _hard.grain = c.grain;
    _hard.grainScale = c.grainScale;
    _hard.grainStretch = c.grainStretch;

    _hard.scale = c.millScale;
    _hard.scaleScale = c.millScaleSize;
    _hard.scaleSharp = c.millScaleSharp;
    _hard.pit = c.pit;
    _hard.pitScale = c.pitScale;
    _hard.wear = c.wear;
    _hard.wearGrain = c.wearGrain;

    _hard.heat = this.heatNow;
    _hard.heatCold = c.heatCold;
    _hard.heatHot = c.heatHot;
    _hard.heatRef = c.heatRef;
    _hard.heatExponent = c.heatExponent;
    _hard.heatGlow = c.heatGlow;
    _hard.heatTint = c.heatTint;
    _hard.heatEdge = c.heatEdge;

    _hard.glow = g.glow;
    _hard.shaderIntensity = g.shaderIntensity;
    _hard.noiseFrequency = g.noiseFrequency;

    syncHardSurfaceMaterial(this.steel, _hard);
  }

  /**
   * The canister on its arc.
   *
   * The arc is `apex·sin(πu)` over the cast line, which is not a ballistic —
   * it is a *throw*, and it has to arrive exactly when `advance()` says the
   * front does or the burst happens next to the thing that caused it. A real
   * parabola fitted to the same two ends and the same time is the same curve
   * to within a few centimetres at these ranges and needs two more sliders.
   */
  _syncCanister(c) {
    if (this._burst) {
      this.canister.visible = false;
      return;
    }
    const geometry = this.shapes.get(SLOT_CANISTER, HardShape.BOLT, this._syncCanisterShape(c));
    if (this.canister.geometry !== geometry) this.canister.geometry = geometry;

    const u = this.phase === AbilityPhase.TRAVEL ? saturate(this.u) : 1;
    this.pointAt(u, this.canister.position);
    this.canister.position.y = c.canisterHeight * (1 - u) + c.chargeHeight * u + c.canisterApex * Math.sin(Math.PI * u);
    this.canister.scale.setScalar(Math.max(c.canisterSize, 0.02));
    // End over end about the cast's lateral axis, plus a slow roll, so it never
    // presents the same silhouette twice on the way out.
    this.canister.rotation.set(
      c.canisterSpin * this.age,
      this._seed * Math.PI * 2,
      Math.atan2(this.direction.x, this.direction.z)
    );
    this.canister.visible = true;
  }

  /** Live shape sliders for the canister. */
  _syncCanisterShape(c) {
    const s = this._canister;
    s.length = Math.max(c.canisterLength, 0.4);
    s.headHeight = Math.max(c.canisterHead, 0.1);
    s.shankRadius = clamp(c.canisterShank, 0.05, 0.48);
    s.threadTurns = Math.max(c.canisterThread, 0);
    s.washer = Math.max(c.canisterWasher, 0);
    return s;
  }

  /** The sheaf. `_throw` is the live params object the solver reads. */
  _syncFragments(c, g, fadePhase) {
    // Both silhouettes are live sliders, so they are re-fetched every frame and
    // swapped only on a real rebuild. The instanced attributes have to be
    // carried across, because the cache hands back a fresh buffer geometry.
    for (let v = 0; v < VARIANTS; v++) {
      const geometry = this._fragmentGeometry(v);
      const mesh = this.frags.meshes[v];
      if (mesh.geometry !== geometry) {
        geometry.setAttribute('aSeed', this.frags.seedAttributes[v]);
        geometry.setAttribute('aLife', this.frags.lifeAttributes[v]);
        mesh.geometry = geometry;
      }
    }

    _throw.layout = ShatterLayout.ZONE;
    _throw.origin.copy(this.origin);
    _throw.direction.copy(this.direction);
    _throw.side.copy(this.side);
    _throw.centre.copy(_land);
    _throw.length = this.length;
    _throw.radius = c.chargeRadius;
    _throw.width = c.chargeRadius;
    _throw.spawnRadius = c.chargeRadius;
    _throw.spawnHeight = c.chargeHeight;

    /* the launch, fitted to the aim indicator */
    _throw.range = Math.max(c.zoneRadius, 0.1);
    _throw.elevation = c.elevation;
    _throw.speedScale = c.speedScale;
    _throw.speedJitter = c.speedJitter;
    _throw.spread = c.spread;
    _throw.gravity = c.gravity;

    /* the ricochet */
    _throw.restitution = c.restitution;
    _throw.friction = c.friction;
    _throw.tumbleKeep = c.tumbleKeep;
    _throw.bounces = c.bounces;
    _throw.stopSpeed = c.stopSpeed;
    _throw.slide = c.slide;
    _throw.groundSpin = c.groundSpin;
    _throw.seat = c.seat;
    // The exit: the floor itself drops away under the settled pieces. One
    // slider, and it is the truth about what is on screen — nothing dissolves.
    _throw.floor = -c.exitSink * Easing.inQuad(saturate(fadePhase));

    /* the bodies */
    _throw.size = c.fragSize;
    _throw.sizeJitter = c.fragSizeJitter;
    _throw.shrink = c.fragShrink;
    _throw.shrinkPower = c.fragShrinkPower;
    _throw.spin = c.fragSpin;
    _throw.spinJitter = c.fragSpinJitter;
    _throw.lifetime = c.fragLifetime * g.lifetime;
    _throw.randomness = g.randomness;

    // `sync()` is deliberately not called. It writes the built-in shader's
    // uniform block, and this field carries a `MeshStandardMaterial` instead —
    // `ShatterField` sets `this.uniforms = material.uniforms ?? null`, so the
    // call would be a no-op with a params object built for nothing. The fade
    // is spent on the ground field and the light; the steel does not fade, it
    // sinks (see `_throw.floor`).
    this.frags.update(this.age, _throw);
  }

  /**
   * The craters, re-derived.
   *
   * `yaw` is left at zero so the field's local axes are the world's, which is
   * what lets a contact point in world metres become a mark fraction with one
   * divide. The alternative — yawing the quad to the cast and rotating every
   * contact into it — buys nothing here, because a bloom has no downrange.
   */
  _syncPocks(c, g, fade) {
    const radius = Math.max(c.pockRadius, 0.5);

    for (let i = 0; i < this._markCount; i++) {
      const slot = this._markSlots[i];
      if (!slot) continue;
      if (this.frags.firstBounce(this._markFragment[i], _throw, _contact, _outgoing) < 0) continue;
      slot.x = (_contact.x - _land.x) / radius;
      slot.y = (_contact.z - _land.z) / radius;
      slot.w = saturate(c.pockLoad);
    }

    _pock.centre.copy(_land);
    _pock.yaw = 0;
    _pock.height = c.pockHeight;
    _pock.radius = radius;
    _pock.length = radius * 2;
    _pock.grow = 1;
    _pock.recede = 0;
    _pock.progress = 1;
    _pock.fade = fade;
    _pock.seed = this._seed * 100;

    _pock.edge = c.pockEdge;
    _pock.ragged = c.pockRagged;
    _pock.raggedScale = c.pockRaggedScale;
    _pock.warp = c.pockWarp;

    _pock.relief = c.pockRelief;
    _pock.normalStep = c.pockNormalStep;
    _pock.ambient = c.pockAmbient;
    _pock.wrap = c.pockWrap;
    _pock.specular = c.pockSpecular;
    _pock.gloss = c.pockGloss;
    _pock.parallax = c.pockParallax;

    _pock.depth = c.pockDepth;
    _pock.lift = c.pockLift;
    _pock.thickness = c.pockRimWidth;
    _pock.detail = c.pockGrain;
    _pock.speed = c.pockDig;
    _pock.markLife = c.pockLife;
    _pock.markRadius = c.pockMarkRadius;

    _pock.additive = false;
    // The scorch a fragment leaves is the fragment's own temperature, so the
    // emissive term fades with the cooling curve rather than on a clock.
    _pock.emissive = c.pockEmissive * (0.25 + 0.75 * this.heatNow);
    _pock.opacity = c.pockOpacity;
    _pock.depthFade = c.pockDepthFade;
    _pock.colorBase = c.colorPockBase;
    _pock.colorEdge = c.colorPockEdge;
    _pock.colorGlow = c.colorPockGlow;
    _pock.colorDeep = c.colorPockDeep;

    _pock.noiseStrength = g.noiseStrength;
    _pock.noiseFrequency = g.noiseFrequency;
    _pock.noiseSpeed = g.noiseSpeed;
    _pock.opacityScale = g.opacity;

    this.pocks.update(_pock);
    this.pocks.setVisible(this._markCount > 0 && fade > 0.004);
  }

  /** Colours, sizes and the globals both particle systems fold in. */
  _syncParticles(c, g) {
    this.sparks.setGradient(
      getColor(c.colorSparkA),
      getColor(c.colorSparkB),
      getColor(c.colorSparkC),
      getColor(c.colorSparkD)
    );
    this.sparks.uniforms.uGravity.value.set(0, c.sparkGravity, 0);
    this.sparks.uniforms.uSizeScale.value = c.sparkSize * g.particleSize * 7;
    this.sparks.uniforms.uLifeScale.value = c.sparkLifetime * 0.5 * g.particleLifetime;
    this.sparks.uniforms.uSpeedScale.value = g.particleSpeed;
    this.sparks.uniforms.uOpacity.value = g.opacity;
    this.sparks.uniforms.uGlow.value = 1.8 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;

    this.smoke.setGradient(
      getColor(c.colorSmokeA),
      getColor(c.colorSmokeB),
      getColor(c.colorSmokeC),
      getColor(c.colorSmokeD)
    );
    this.smoke.uniforms.uGravity.value.set(0, c.smokeRise, 0);
    this.smoke.uniforms.uSizeScale.value = c.smokeSize * g.particleSize;
    this.smoke.uniforms.uLifeScale.value = c.smokeLifetime * 0.5 * g.particleLifetime;
    this.smoke.uniforms.uSpeedScale.value = c.smokeSpeed * g.particleSpeed;
    this.smoke.uniforms.uOpacity.value = c.smokeOpacity * g.opacity;
    this.smoke.uniforms.uTurbulence.value = c.smokeTurbulence * g.turbulence;
  }

  /**
   * The tint sparks leave at: the blackbody colour of the steel that threw
   * them, blended back toward the authored birth stop by `sparkHeatTint`.
   *
   * Below about 800 K the locus is black, so a cold fragment's sparks would
   * vanish entirely — which is why the blend exists rather than the tint being
   * absolute. `HardSurface`'s own note is the argument for the physical half:
   * hard-coding an orange is how a cherry-red fragment ends up throwing
   * lemon-yellow sparks.
   */
  _sparkTint(c) {
    blackbodyColor(heatToKelvin(this.heatNow, _hard), _tint);
    return _tint.lerp(getColor(c.colorSparkA), 1 - saturate(c.sparkHeatTint));
  }

  /**
   * Sign the floor and throw sparks wherever a fragment has just touched down
   * for the first time.
   *
   * The contact *time* is derived and re-answered every frame; the fact that it
   * has been answered is an event, and `_bounced` is the one bit per fragment
   * that remembers it. Without that bit a paused cast would post a crater and
   * a spray on every single frame, which is the failure mode this whole
   * pattern exists to avoid.
   */
  _pollContacts() {
    const c = settings.shrapnel;
    const g = settings.global;
    const time = frame.uTime.value;
    const count = Math.round(c.bounceSparks * g.particleCount);

    for (let i = 0; i < CAPACITY; i++) {
      if (this._bounced[i]) continue;
      const record = this.frags.records[i];
      if (record.born < 0) continue;
      const hit = this.frags.firstBounce(i, _throw, _contact, _outgoing);
      if (hit < 0 || this.age - record.born < hit) continue;

      this._bounced[i] = 1;

      if (this._markCount < POCK_MARKS) {
        const index = this._markCount++;
        this._markFragment[index] = i;
        // Position and strength are rewritten in `_syncPocks` every frame; only
        // the timestamp survives from here. They are also written *now*, from
        // the contact this loop is already holding, because `_syncPocks` has
        // already run this frame and a crater sitting at the anchor for one
        // frame is a visible flick at the centre of the circle.
        const radius = Math.max(c.pockRadius, 0.5);
        this._markSlots[index] = this.pocks.mark(
          (_contact.x - _land.x) / radius,
          (_contact.z - _land.z) / radius,
          time,
          saturate(c.pockLoad)
        );
        this.pocks.setVisible(true);
      }

      if (count > 0) {
        _pos.copy(_contact);
        _emit.position = _pos;
        _emit.radius = 0.05;
        // Along the *outgoing* velocity: sparks struck off a ricochet leave the
        // way the fragment did, which is the cheapest possible confirmation
        // that a real reflection happened rather than a stop.
        _emit.direction = _dir.copy(_outgoing).normalize();
        _emit.speed = c.sparkSpeed * 0.55;
        _emit.speedVariance = 0.7;
        _emit.spread = 0.35;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.1;
        _emit.sizeVariance = 0.7;
        _emit.life = c.sparkLifetime * 0.7;
        _emit.lifeVariance = 0.5;
        _emit.spin = 0;
        _emit.tint = this._sparkTint(c);
        _emit.time = time;
        this.sparks.emit(count, _emit);
        _emit.tint = null;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1, 0);

    // The light rides the canister, so the hot charge lights the floor it is
    // crossing before it opens.
    this.position.copy(this.canister.position);

    this.ctx.shake.rumble(settings.shrapnel.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.shrapnel;
    const g = settings.global;
    const time = frame.uTime.value;

    this._burst = true;
    this._burstAt = this.age;
    this._landingPoint(_land);

    // `along = 1` puts every fragment at the far end of the cast — the circle's
    // centre — and `_anchorOf` then scatters them inside `chargeRadius`.
    this.frags.burst(this.age, Math.min(Math.round(c.fragCount), CAPACITY), 1, 0);
    this._sync(1, 0);

    _pos.copy(_land);
    _pos.y = c.chargeHeight;

    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.5,
      intensity: c.burstIntensity,
      opacity: 0.85,
      fresnel: 1.4,
      displace: 0.7,
      squash: 0.7,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    _emit.position = _pos;
    _emit.radius = Math.max(c.chargeRadius, 0.05);
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.sparkSpeed;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.18;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = this._sparkTint(c);
    _emit.time = time;
    this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);
    _emit.tint = null;

    _emit.speed = c.smokeSpeed;
    _emit.speedVariance = 0.75;
    _emit.spread = 0.95;
    _emit.size = 0.85;
    _emit.sizeVariance = 0.5;
    _emit.life = c.smokeLifetime;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.5;
    this.smoke.emit(Math.round(c.smokeCount * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      Math.max(c.shakeFrequency, 1)
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.2 * g.explosionIntensity;
  }

  onFade(_dt, t) {
    const c = settings.shrapnel;
    // `t` runs 0..1 while the pieces are still moving, then 1..2 while the cast
    // lets go and the floor drops out from under them.
    const fadePhase = t <= 1 ? 0 : saturate(t - 1);
    const fade = t <= 1 ? 1 : 1 - Easing.inQuad(fadePhase);

    this._sync(fade, fadePhase);
    this._pollContacts();

    this.position.copy(_land).setY(c.lightHeight);
  }

  onDestroy() {
    this._burst = false;
    this._burstAt = 0;
    this._markCount = 0;
    this._markSlots.fill(null);
    this._bounced.fill(0);
    this.frags.clear();
    this.pocks.clearMarks();
    this.pocks.setVisible(false);
    this.canister.visible = false;
  }

  dispose() {
    this.frags.dispose();
    this.pocks.dispose();
    this.shapes.dispose();
    this.steel.dispose();
    super.dispose();
  }
}
