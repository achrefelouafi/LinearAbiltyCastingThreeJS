import { Mesh, Vector3 } from 'three';
import { Ability } from '../Ability.js';
import { createFeatherGeometry, createFeatherMaterial } from '../../materials/FeatherMaterial.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, Easing } from '../../utils/math.js';

/**
 * Hard ceiling on feathers in one cast. The `count` slider clamps here.
 *
 * 256 is not a budget number, it is a legibility one: the flock covers a disc
 * about ten metres across, and past roughly two hundred the individual
 * descents stop being separable and the whole thing reads as snow. The trick
 * of this ability is that you can pick one feather and watch it, so the cap is
 * set where that is still true.
 */
const MAX_FEATHERS = 256;

const TAU = Math.PI * 2;

/* Module-scope scratch — I3. Nothing in the frame path allocates. */
const _centre = new Vector3();
const _pos = new Vector3();
const _dir = new Vector3();
const _emit = {};

/**
 * FEATHERFALL — a slow rain of feathers over the circle.
 *
 * **THE TRICK: they do not fall, they *fly badly*.** A thin plate dropped
 * through air is aerodynamically unstable, and it is unstable in two distinct
 * ways: it either **flutters** — glide, stall, flip, glide back — or it
 * **tumbles**, end over end, drifting steadily to the side it is rotating
 * toward. Both regimes are implemented as real closed-form flight models in
 * `materials/FeatherMaterial.js`, both are in the air at once, and which one a
 * feather is in is a per-instance dice roll against `tumbleShare`. On top of
 * that every feather gets exactly one **catch** — a gust, at its own moment,
 * that lifts it and lets it go again. That is what "no two descend the same
 * way" has to mean to be worth saying: not noise on one motion, two motions
 * and an event.
 *
 * The physics that matters is one line, and it is the reason this looks
 * different from anything else in the sandbox that falls: vertical speed is
 * `sink · (1 − lift · cos²φ)`, where `cos φ` is the horizontal velocity of the
 * glide. A plate makes lift when it is moving sideways, so it falls *slowest*
 * in the middle of a glide and *fastest* at the stall where the sideways
 * motion reverses. Watch one feather and it hesitates twice a second. Take
 * `lift` to zero and the same feather drops like a wet leaflet, on the same
 * path.
 *
 * ### Why this is not `Swarm(LEAF)`
 *
 * `vfx/Swarm.js` was the obvious answer and it is the wrong shape of thing.
 * A swarm coheres to a moving lead, separates on a hash lattice and banks into
 * its turns — it is a *flocking* model, and flocking is agents reacting to
 * each other. Feathers do not react to each other. Every one of these is
 * alone in the air with its own aerodynamics, and the interesting structure
 * comes out of the fact that two identical feathers released a metre apart
 * land four metres apart. Building that on top of a flock would mean turning
 * off cohesion, separation and banking and then adding a flight model to what
 * was left, which is a different module wearing a `Swarm`.
 *
 * ### There is no impact
 *
 * The base class still runs a front out to the circle, because that is what a
 * zone cast does and it is what the aim indicator has promised. But nothing
 * happens when it arrives: no burst, no decal, no shake, no flash, not even a
 * change of rate. The feathers were already coming down before the front got
 * there and they go on coming down for another eight seconds. This is the
 * longest cast in the sandbox and the quietest, and both of those are the
 * point.
 *
 * ### Invariants
 *
 * One draw call for the whole flock — one `InstancedBufferGeometry`, 190
 * instances, every vertex placed by the vertex shader. A cast captures exactly
 * `count × 4` unitless dice and nothing else: not a metre, not a radian, not a
 * second. Position is a closed-form function of `(age − release, seed)`
 * against live uniforms, so pausing with **P** and dragging `lift`, `swing` or
 * `cup` re-flies and re-shapes two hundred feathers that are already halfway
 * down. An Euler integrator physically could not.
 */
export class FeatherfallAbility extends Ability {
  constructor(context) {
    super('featherfall', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.geometry = createFeatherGeometry(MAX_FEATHERS);
    this.material = createFeatherMaterial(this.ctx.environment);

    this.mesh = new Mesh(this.geometry, this.material);
    // Both the mesh and the ability's group are held at identity, because the
    // vertex shader authors world positions directly off `uOrigin`. Moving
    // either one would move the flock twice.
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.WORLD);
    this.mesh.renderOrder = 4;
    this.mesh.receiveShadow = true;
    // No shadow casting. The depth pass draws the *unpatched* geometry — a
    // flat unit sheet sitting at the world origin — so a shadow-casting flock
    // is two hundred coincident squares of darkness under the caster's feet.
    // Fixing that means patching the depth material too, and the feathers are
    // thin, backlit and translucent: they have very little shadow to give.
    this.mesh.castShadow = false;
    this.group.add(this.mesh);

    /** The dice. `count × 4` unitless numbers, rolled once per cast. */
    this._seeds = this.geometry.getAttribute('aSeed');
    this._live = 0;
  }

  createParticles() {
    /**
     * Down. Not feathers, and not many: the specks that come off a feather in
     * the air. Non-additive, because nothing in this ability glows, and drawn
     * with a slight *negative* rise so they sink alongside the flock rather
     * than smoking up out of it.
     */
    this.down = this.ctx.particles.get('featherfall.down', {
      capacity: 900,
      shape: ParticleShape.SOFT,
      additive: false,
      curl: true,
      softFade: 0.5
    });
    this.down.uniforms.uDrag.value = 2.6;
    this.down.uniforms.uEndSize.value = 1.1;
    this.down.uniforms.uSizeIn.value = 0.12;
    this.down.uniforms.uFadeIn.value = 0.2;
    this.down.uniforms.uFadeOut.value = 0.55;

    this.downEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * The descent window. This is the one duration in the sandbox that is
   * *derived from a physical model* rather than authored to taste — see the
   * arithmetic in the settings block. Too short and feathers wink out in
   * mid-air, which is the only way to break this slot.
   */
  get impactDuration() {
    return Math.max(0.1, settings.featherfall.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.1, settings.featherfall.fadeTime);
  }

  get instanceCount() {
    return this._live;
  }

  /** Nothing here burns. A slow breath, well under the ice glint. */
  lightShimmer() {
    return 0.92 + 0.08 * Math.sin(this.age * 1.7);
  }

  /* ------------------------------------------------------------------ */
  /* Geometry of the flock — every metre resolved from live settings      */
  /* ------------------------------------------------------------------ */

  /** The centre of the circle the flock comes down over. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /**
   * Seconds since the flock was released.
   *
   * The clock starts at the cast, not at the arrival of the front: the first
   * feathers are already in the air over the circle while the cast is still
   * travelling, which is what stops the zone reading as "something appeared".
   */
  get _fallAge() {
    return this.age;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.downEmitter.reset();

    const count = Math.max(1, Math.min(MAX_FEATHERS, Math.round(settings.featherfall.count)));
    this._live = count;

    // The only dice the cast rolls, and the only thing it captures. Four per
    // feather; the shader hashes four more out of them, which is cheaper than
    // uploading eight and just as decorrelated.
    const seeds = this._seeds.array;
    for (let i = 0; i < count * 4; i++) seeds[i] = Math.random();
    this._seeds.needsUpdate = true;
    this.geometry.instanceCount = count;

    // Sync before the first frame is drawn, or the flock stands for one frame
    // over last cast's circle.
    this._sync(1);
  }

  /* ------------------------------------------------------------------ */
  /* The one sync                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the descent clock into the flock and the down.
   * Everything with a unit is read here and nowhere else.
   *
   * @param {number} fade 1 while the feathers are lit, ramping to 0 at the end
   */
  _sync(fade) {
    const c = settings.featherfall;
    const g = settings.global;

    this._centrePoint(_centre);
    this.material.userData.sync(_centre, this._fallAge, fade);

    // Clamped every frame rather than at spawn, so dragging `count` down while
    // paused thins a flock that is already falling. Dragging it *up* cannot add
    // feathers mid-cast — their dice were never rolled — so the cap here is the
    // number that was.
    const live = Math.max(1, Math.min(this._live, Math.round(c.count)));
    this.geometry.instanceCount = live;

    this.down.setGradient(
      getColor(c.colorDownA),
      getColor(c.colorDownB),
      getColor(c.colorDownC),
      getColor(c.colorDownD)
    );
    this.down.uniforms.uGravity.value.set(0, c.downRise, 0);
    this.down.uniforms.uSizeScale.value = c.downSize * g.particleSize * 7;
    this.down.uniforms.uLifeScale.value = c.downLifetime * 0.5 * g.particleLifetime;
    this.down.uniforms.uSpeedScale.value = g.particleSpeed;
    this.down.uniforms.uOpacity.value = c.opacity * g.opacity;
    this.down.uniforms.uTurbulence.value = c.downTurbulence * g.turbulence;
  }

  /**
   * Specks shed into the column the flock is coming down through.
   * @param {number} scale thinning multiplier as the cast ends
   */
  _downFx(dt, scale) {
    const c = settings.featherfall;
    const g = settings.global;
    const count = Math.round(this.downEmitter.tick(dt, c.downRate * scale) * g.particleCount);
    if (count <= 0) return;

    this._centrePoint(_centre);
    // Anywhere in the cylinder the feathers occupy: sqrt on the radius so the
    // specks are uniform over the *area*, matching the flock's own placement.
    const bearing = Math.random() * TAU;
    const radius = c.zoneRadius * Math.sqrt(Math.random());
    _pos.set(
      _centre.x + Math.cos(bearing) * radius,
      c.floorHeight + Math.random() * c.ceiling,
      _centre.z + Math.sin(bearing) * radius
    );

    _emit.position = _pos;
    _emit.radius = c.featherSize;
    _emit.direction = _dir.set(0, -1, 0);
    _emit.speed = c.downSpeed;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.06;
    _emit.sizeVariance = 0.7;
    _emit.life = c.downLifetime;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.down.emit(count, _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1);
    // The light sits over the middle of the circle at half the release height
    // for the whole cast — it is lighting a volume, not following a front.
    this._lightPoint();
    this._downFx(dt, 1);
  }

  onImpact() {
    // Nothing. There is no impact — see the class comment. The front reaching
    // the circle is not an event in this ability and it deliberately does not
    // become one.
  }

  onFade(dt, t) {
    // `t` runs 0..1 through the descent and 1..2 while the settled feathers go.
    // The blow-out is quadratic rather than cubic: feathers on the floor should
    // thin away, not snap out, and a cubic curve holds them at full opacity for
    // most of the fade and then drops them.
    const fade = t <= 1 ? 1 : 1 - Easing.inQuad(saturate(t - 1));
    this._sync(fade);
    this._lightPoint();

    // The down thins as the last feathers land: there is nothing left in the
    // air to shed it.
    this._downFx(dt, fade * (t <= 1 ? 0.8 : 0.2));
  }

  /** Park the dynamic light in the middle of the falling column. */
  _lightPoint() {
    const c = settings.featherfall;
    this._centrePoint(this.position);
    this.position.y = c.ceiling * 0.45;
  }

  onDestroy() {
    this._live = 0;
    this.geometry.instanceCount = 0;
    this.material.userData.uniforms.uFade.value = 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    super.dispose();
  }
}
