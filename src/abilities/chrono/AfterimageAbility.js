import { Mesh, Vector3 } from 'three';
import { Ability } from '../Ability.js';
import {
  createAfterimageGeometry,
  createAfterimageMaterial,
  MAX_FINS,
  MAX_SNAPS
} from '../../materials/AfterimageMaterial.js';
import { timeField, timeRegionParams } from '../../vfx/TimeControl.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, Easing } from '../../utils/math.js';

const _pos = new Vector3();
const _dir = new Vector3();
const _hold = new Vector3();
const _emit = {};

/**
 * AFTERIMAGE — N frozen copies of one cast, every one of them still live.
 *
 * **THE TRICK.** A fan of blades flies down the line, opening as it goes. Every
 * `snapGap` seconds it sheds a copy of itself, which stops where it was and
 * holds the shape it had at that instant. Behind the body there is then a row
 * of frozen moments — a strobe photograph of a single flight, standing in the
 * room. And *none of them is a photograph*: each copy is the same closed-form
 * body evaluated at a different age, so pausing the sandbox with **P** and
 * dragging `bladeLength`, `splay`, `speed` or `snapGap` reshapes and re-places
 * all six frozen moments at once, on a frame of zero length. The roster entry
 * calls it "invariant I1 turned into an effect", and that is exactly what it
 * is: this ability has no content beyond the fact that nothing was captured.
 *
 * ### How the freeze is expressed
 *
 * Not as a stored timestamp. Copy `k`'s instant is `k × snapGap` — a **slider**
 * — and the shader shows `min(age, k × snapGap)`, so a copy travels with the
 * body until its instant arrives and holds thereafter. Nothing is written to a
 * buffer during a cast, nothing is captured, and every frozen moment
 * re-derives itself from scratch every frame. The version that stamped
 * `frame.uTime.value` into an instance attribute at the moment of the freeze
 * rendered identically and failed the only test that matters — a paused drag
 * on `snapGap` moved nothing, because a captured second is a captured second
 * however cheap it was.
 *
 * ### What a cast does capture
 *
 * `_seed` (a unitless dice roll for the flight's lateral wander), the count of
 * copies that have already crossed their instant (so the shutter-click effects
 * fire once each), and one borrowed `TimeRegion`. Nothing else.
 *
 * ### The stasis bubble
 *
 * The newest frozen copy carries a `timeField` region at rate 0, so the motes
 * the body shed as it passed **stop in the air** around it. That is the only
 * part of the ability that is not the ability: a frozen copy that nothing else
 * in the frame reacts to reads as a decal of a spell, and one bubble of
 * genuinely stopped particles around it is the cheapest possible proof that it
 * is a piece of held time. `acquire()` returns `null` when all four slots are
 * spoken for (**I6**), so every use of the handle is guarded, and it is taken
 * through `this.borrow()` so the base class gives it back however the cast ends
 * (**I9**).
 *
 * ### Draw calls
 *
 * **One.** Seven copies × four blades is twenty-eight instances of a
 * 176-vertex sliver in a single draw, plus two shared particle systems and a
 * pooled burst. Against I7's twelve, this is the cheapest slot in the school.
 */
export class AfterimageAbility extends Ability {
  constructor(context) {
    super('afterimage', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.geometry = createAfterimageGeometry();
    this.material = createAfterimageMaterial();

    this.mesh = new Mesh(this.geometry, this.material);
    // Every instance is placed by the vertex shader from world-space uniforms,
    // so the mesh's own transform is meaningless and its bounds are a lie. A
    // frustum test against them culls the entire row the moment the camera
    // looks past the origin.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.renderOrder = 12;
    this.group.add(this.mesh);

    /* --- scratch, allocated once (I3) --- */
    this._state = {
      origin: new Vector3(),
      dir: new Vector3(0, 0, 1),
      side: new Vector3(1, 0, 0),
      length: 1,
      age: 0,
      seed: 0,
      fade: 1
    };
    this._region = null;
    this._regionParams = timeRegionParams();
    /** Copies whose instant has already passed. Counts shutter clicks, nothing else. */
    this._frozen = 0;
    /** Copies drawn this frame, live head included — the HUD's readout. */
    this._live = 1;
    this._seed = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // What the body sheds as it flies. These are the particles the stasis
    // bubble catches, so they are slow and long-lived on purpose: a spark that
    // is gone in 200 ms cannot be seen to stop.
    this.motes = particles.get('afterimage.motes', {
      capacity: 1800,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.45
    });
    this.motes.uniforms.uDrag.value = 1.5;
    this.motes.uniforms.uEndSize.value = 0.2;
    this.motes.uniforms.uSizeIn.value = 0.08;
    this.motes.uniforms.uFadeIn.value = 0.1;
    this.motes.uniforms.uFadeOut.value = 0.5;

    // The shutter click: a thin ring of stretched streaks thrown sideways at
    // the instant a copy detaches. Perpendicular to travel, because the copy is
    // being *left behind* and anything thrown forward reads as exhaust.
    this.shear = particles.get('afterimage.shear', {
      capacity: 1400,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.3
    });
    this.shear.uniforms.uDrag.value = 2.6;
    this.shear.uniforms.uEndSize.value = 0.15;
    this.shear.uniforms.uSizeIn.value = 0.02;
    this.shear.uniforms.uFadeIn.value = 0.02;
    this.shear.uniforms.uFadeOut.value = 0.5;

    this.moteEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._live;
  }

  get impactDuration() {
    return Math.max(0.05, settings.afterimage.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.afterimage.fadeTime);
  }

  /** A held light. It steps rather than swells — one level per copy shed. */
  lightShimmer() {
    const c = settings.afterimage;
    const step = this._frozen % Math.max(1, Math.round(c.lightSteps));
    return 1 - c.lightStagger * (step / Math.max(1, Math.round(c.lightSteps)));
  }

  /* ------------------------------------------------------------------ */
  /* The flight — the CPU's mirror of the vertex shader                  */
  /* ------------------------------------------------------------------ */

  /**
   * How far down the line the body had travelled at `age` seconds.
   *
   * This is the same closed form the vertex shader evaluates, written twice on
   * purpose: the GPU needs it per instance per vertex, and the CPU needs it to
   * put the light, the stasis bubble and the particle emitters *on* the copies
   * rather than near them. `ThunderAbility#_axisPoint` is the precedent. If one
   * of the two is ever edited, the other has to move with it — the tell is
   * motes that trail half a metre behind the body they came off.
   */
  _progressAt(age) {
    const c = settings.afterimage;
    const speed = Math.max(0.01, c.speed * settings.global.speed);
    const travel = Math.max(this.length / speed, 1e-4);
    return Math.pow(saturate(age / travel), Math.max(0.05, c.flightCurve));
  }

  /** The instant copy `k` is showing. `k = 0` is the live body. */
  _shownAgeOf(k) {
    const c = settings.afterimage;
    return k <= 0 ? this.age : Math.min(this.age, k * c.snapGap);
  }

  /**
   * Where copy `k` is, in world space. Returns its progress along the line.
   *
   * Mirrors the vertex shader's `centre` exactly, sway, bow and settling
   * included.
   */
  _bodyPoint(k, out) {
    const c = settings.afterimage;
    const shown = this._shownAgeOf(k);
    const held = Math.max(this.age - shown, 0);
    const s = this._progressAt(shown);

    this.pointAt(s, out);
    out.addScaledVector(this.side, Math.sin((s * c.swayWaves + this._seed) * Math.PI * 2) * c.sway);
    out.y += lerp(c.liftNear, c.lift, s) + c.arc * Math.sin(s * Math.PI) - held * c.holdSink;
    return s;
  }

  /** Copies currently standing behind the body, 0..MAX_SNAPS. */
  _snapCount() {
    return clamp(Math.round(settings.afterimage.snaps), 0, MAX_SNAPS);
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the cast's frame and clock into the shader, and re-count the row.
   *
   * Everything with a unit is resolved inside `material.userData.sync` from
   * `settings.afterimage`; this hands over the frame, the age, the dice and the
   * fade, and nothing else.
   */
  _syncBody(fade) {
    const state = this._state;
    state.origin.copy(this.origin);
    state.dir.copy(this.direction);
    state.side.copy(this.side);
    state.length = this.length;
    state.age = this.age;
    state.seed = this._seed;
    state.fade = fade;
    this.material.userData.sync(state);

    // Copy-major layout, so lowering `snaps` drops the oldest copies rather
    // than half of the newest one's fan.
    const copies = this._snapCount();
    this._live = copies + 1;
    this.geometry.instanceCount = this._live * MAX_FINS;
  }

  /** The stasis bubble, re-placed and re-resolved every frame. */
  _syncRegion() {
    const region = this._region;
    if (!region) return; //  I6 — the four slots may all be spoken for
    const c = settings.afterimage;
    const p = this._regionParams;

    // On the newest copy that has actually frozen; on the body itself before
    // any has. A bubble parked on a copy that does not exist yet would hold a
    // patch of empty floor.
    this._bodyPoint(Math.min(this._frozen, this._snapCount()), _hold);
    region.place(_hold);

    p.radius = c.holdRadius;
    p.core = c.holdCore;
    p.strength = c.holdStrength;
    p.rate = c.holdRate;
    region.sync(p);
  }

  _syncParticles(dt, fade) {
    const c = settings.afterimage;
    const g = settings.global;

    this.motes.setGradient(
      getColor(c.colorMoteA),
      getColor(c.colorMoteB),
      getColor(c.colorMoteC),
      getColor(c.colorMoteD)
    );
    this.motes.uniforms.uGravity.value.set(0, c.moteRise, 0);
    this.motes.uniforms.uSizeScale.value = c.moteSize * g.particleSize * 7;
    this.motes.uniforms.uLifeScale.value = c.moteLifetime * 0.5 * g.particleLifetime;
    this.motes.uniforms.uSpeedScale.value = g.particleSpeed;
    this.motes.uniforms.uOpacity.value = c.moteOpacity * g.opacity;
    this.motes.uniforms.uGlow.value = c.moteGlow * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

    this.shear.setGradient(
      getColor(c.colorShearA),
      getColor(c.colorShearB),
      getColor(c.colorShearC),
      getColor(c.colorShearD)
    );
    this.shear.uniforms.uGravity.value.set(0, c.shearGravity, 0);
    this.shear.uniforms.uSizeScale.value = c.shearSize * g.particleSize * 7;
    this.shear.uniforms.uLifeScale.value = c.shearLifetime * 0.5 * g.particleLifetime;
    this.shear.uniforms.uSpeedScale.value = g.particleSpeed;
    this.shear.uniforms.uOpacity.value = g.opacity;
    this.shear.uniforms.uGlow.value = c.shearGlow * g.glow;
    this.shear.uniforms.uStretch.value = c.shearStretch;

    if (dt <= 0) return;
    const count = Math.round(this.moteEmitter.tick(dt, c.moteRate * fade) * g.particleCount);
    if (count <= 0) return;

    this._bodyPoint(0, _pos);
    _emit.position = _pos;
    _emit.radius = c.moteSpread;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.4).setY(0.35).normalize();
    _emit.speed = c.moteSpeed;
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.11;
    _emit.sizeVariance = 0.7;
    _emit.life = c.moteLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(count, _emit);
  }

  /**
   * Fire the shutter for every copy whose instant has just passed.
   *
   * Gated on a real frame. A freeze is an *event*, and a zero-length frame has
   * no events in it — without the gate, dragging `snapGap` down while paused
   * would walk the crossing index up and dump six rings of sparks under the
   * cursor. The index is monotone within a cast for the same reason: dragging
   * `snapGap` back up does not un-fire a click that already happened.
   */
  _pollFreezes(dt) {
    if (dt <= 0) return;
    const c = settings.afterimage;
    const gap = Math.max(1e-3, c.snapGap);
    const due = Math.min(this._snapCount(), Math.floor(this.age / gap));
    while (this._frozen < due) {
      this._frozen++;
      this._freezeFx(this._frozen);
    }
  }

  /** The click: a ring of shear, a mark on the floor, and the bubble re-locking. */
  _freezeFx(copy) {
    const c = settings.afterimage;
    const g = settings.global;
    const now = frame.uTime.value;

    this._bodyPoint(copy, _pos);

    // Thrown sideways, in the plane the copy is being left behind through.
    _emit.position = _pos;
    _emit.radius = c.shearSpread;
    _emit.direction = _dir.copy(this.side);
    _emit.speed = c.shearSpeed;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.17;
    _emit.sizeVariance = 0.8;
    _emit.life = c.shearLifetime;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = now;
    this.shear.emit(Math.round(c.shearPerSnap * g.particleCount), _emit);

    // A thin ring on the floor under the copy. A decal is the right tool here
    // and not the wrong one: this mark is a *record of an instant* that is
    // supposed to expire, unlike the copy above it, which is not.
    _pos.y = 0;
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.snapRingRadius,
      life: c.snapRingLife,
      width: c.snapRingWidth,
      intensity: c.snapRingIntensity,
      colorA: getColor(c.colorSnapRingA),
      colorB: getColor(c.colorSnapRingB)
    });

    // The bubble follows the newest held moment, and re-stamps the instant it
    // is holding — otherwise it would keep clamping everything to the first
    // copy's clock long after that copy stopped being the interesting one.
    this._region?.lock(now);
    this.lightBoost = c.lightIntensity * c.snapPunch * g.explosionIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this._frozen = 0;
    this._live = 1;
    this._seed = Math.random() * 10;

    // I6/I9: may be null, and is given back by the base class however the cast
    // ends. `lock()` stamps the instant the bubble snapped shut, which is what
    // every consumer of the field clamps to.
    this._region = this.borrow(timeField.acquire());
    this._region?.lock(frame.uTime.value);

    this._syncBody(1);
    this._syncRegion();
    this._syncParticles(0, 1);
  }

  onTravel(dt) {
    this._pollFreezes(dt);
    this._syncBody(1);
    this._syncRegion();
    this._syncParticles(dt, 1);

    // The light rides the live body, which is above the floor — `advance()` has
    // already put `position` on the ground line, so lift it onto the flight.
    this._bodyPoint(0, this.position);
    this.ctx.shake.rumble(settings.afterimage.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.afterimage;
    const g = settings.global;

    this._bodyPoint(0, _pos);

    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.arrivalSize * 0.25,
      endRadius: c.arrivalSize * g.explosionIntensity,
      life: 0.8,
      intensity: c.arrivalIntensity,
      opacity: 0.6,
      fresnel: 2.0,
      displace: 0.3,
      squash: 0.9,
      colorA: getColor(c.colorArrivalA),
      colorB: getColor(c.colorArrivalB),
      colorC: getColor(c.colorArrivalC)
    });

    _emit.position = _pos;
    _emit.radius = c.shearSpread * 1.6;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.3).setY(0.5).normalize();
    _emit.speed = c.shearSpeed * 1.7;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.2;
    _emit.sizeVariance = 0.8;
    _emit.life = c.shearLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.shear.emit(Math.round(c.arrivalShear * g.particleCount), _emit);

    this.ctx.shake.add(
      c.arrivalShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      22
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.arrivalFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.2 * g.explosionIntensity;
  }

  onFade(dt, t) {
    // The row holds through `t <= 1` and then lets go. Cubic, so the frozen
    // moments hang on and then vanish together rather than dimming: a
    // photograph does not dim, it is taken away.
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));

    this._pollFreezes(dt);
    this._syncBody(fade);
    this._syncRegion();
    this._syncParticles(dt, fade * 0.35);

    this._bodyPoint(0, this.position);
  }

  onDestroy() {
    // Idempotent — the base class releases every borrowed handle too. Doing it
    // here as well means the slot is free on the frame the cast ends rather
    // than at the end of `destroy()`, and a leaked time region stops a sphere
    // of the world for the rest of the session.
    this._region?.release();
    this._region = null;
    this._frozen = 0;
    this._live = 1;
    this.geometry.instanceCount = MAX_FINS;
    this.material.uniforms.uFade.value = 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    super.dispose();
  }
}
