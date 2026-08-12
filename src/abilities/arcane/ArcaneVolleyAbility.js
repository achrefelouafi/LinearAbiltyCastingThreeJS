import {
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  Sphere,
  Vector3
} from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import {
  createVolleyTrailMaterial,
  createVolleyHeadMaterial,
  boltPointJS,
  MAX_BOLTS
} from '../../materials/VolleyMaterial.js';
import { createBoltRibbonGeometry } from '../../assets/ProceduralGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, Easing } from '../../utils/math.js';

/**
 * Samples along one trail. The ceiling on how sharp a crossing can look: a
 * Lissajous figure at three turns needs about a dozen samples per turn before
 * the ribbon stops cutting its own corners.
 */
const TRAIL_NODES = 48;

const TAU = Math.PI * 2;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _hand = new Vector3();
const _target = new Vector3();
const _n1 = new Vector3();
const _n2 = new Vector3();
const _up = new Vector3(0, 1, 0);

/**
 * The quad every bolt head is drawn on — parameter space, like the ribbon.
 *
 * Four vertices carrying `(±1, ±1)` and an instance index, and that is all: the
 * vertex shader puts the quad in the world along the view basis, so a head has
 * no model matrix, no billboard object and nothing on the CPU to keep in step
 * with the trail it belongs to.
 */
function createHeadQuadGeometry(bolts) {
  const count = Math.max(1, Math.round(bolts));
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const strands = new Float32Array(count);
  for (let i = 0; i < count; i++) strands[i] = i;

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aStrand', new InstancedBufferAttribute(strands, 1));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.instanceCount = count;
  // Placed in world space by the vertex shader; its own bounds mean nothing.
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

/**
 * ARCANE VOLLEY — seven bolts, seven paths, one hit.
 *
 * Three beats. The bolts appear at the hand and circle it while the cast winds
 * up; they leave together and weave apart, crossing each other the whole way
 * down the line; and they arrive at one point on one frame, as a single impact.
 *
 * **THE TRICK — parametric homing.** Every bolt is a Lissajous figure whose
 * amplitude is multiplied by `(1 − τ)^weaveDecay`. That factor is *identically
 * zero* at τ = 1, so however wildly a bolt has been weaving it is at the target
 * — exactly, to the float — the instant its clock runs out. Nothing steers,
 * nothing is corrected, nothing is integrated. Drag `weaveSide` with the
 * sandbox paused and all seven curves re-fly, trails included, and all seven
 * still land on the same point, because there is nowhere else for the algebra
 * to put them.
 *
 * **What makes the weave interesting rather than uniform** is a small table of
 * per-bolt frequency ratios in `materials/VolleyMaterial.js` — 1:2, 2:3, 3:2,
 * 2:1 and so on, near-coprime, so no two bolts trace the same figure and their
 * crossings never fall into step. `vfx/Projectile`'s LISSAJOUS mode carries one
 * ratio for the whole volley and separates the bodies by phase alone, which is
 * a braid: seven congruent curves, all reaching their widest point on the same
 * frame. That is the reason this ability owns its two materials instead of
 * configuring that module — the per-instance ratio is not expressible there,
 * and the ratio is the difference between a weave and a rope.
 *
 * **The wind-up is the same function.** During the charge a bolt's τ is pinned
 * at zero and its weave *phase* is rotated instead, so it traces the τ = 0
 * slice of its own figure — a small loop around the hand — and at release the
 * rotation stops and the identical offset simply starts being carried
 * downrange. The two beats are continuous by construction, which is what lets
 * one trail run through the launch without a seam in it. The first version had
 * a separate orbit for the charge and lerped between the two at release; the
 * bolts visibly jumped, because two curves that meet at a point still disagree
 * about their tangent.
 *
 * The trails are the read and the heads are small. Both are one instanced draw
 * — **two draw calls for the entire volley** — and neither records anything: a
 * trail vertex asks the same flight function where its bolt *was*, in the
 * bolt's own clock, which is why a slider can re-shape history.
 *
 * **What a cast captures.** One seed and one timestamp (when the volley
 * landed). Not a metre.
 */
export class ArcaneVolleyAbility extends Ability {
  constructor(context) {
    super('arcanevolley', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the trails: one draw call for the whole volley --- */
    this.trailGeometry = createBoltRibbonGeometry(TRAIL_NODES, MAX_BOLTS);
    this.trailMaterial = createVolleyTrailMaterial();
    this.trailMesh = new Mesh(this.trailGeometry, this.trailMaterial);
    this.trailMesh.frustumCulled = false;
    this.trailMesh.matrixAutoUpdate = false;
    this.trailMesh.layers.set(LAYER.VFX);
    this.trailMesh.renderOrder = 11;
    this.group.add(this.trailMesh);

    /* --- the heads: the other one --- */
    this.headGeometry = createHeadQuadGeometry(MAX_BOLTS);
    this.headMaterial = createVolleyHeadMaterial();
    this.headMesh = new Mesh(this.headGeometry, this.headMaterial);
    this.headMesh.frustumCulled = false;
    this.headMesh.matrixAutoUpdate = false;
    this.headMesh.layers.set(LAYER.VFX);
    this.headMesh.renderOrder = 13;
    this.group.add(this.headMesh);

    /** The one dice roll a cast makes. */
    this._seed = 0;
    /** Bolts drawn this frame — the HUD's instance count. */
    this._boltCount = 1;
    /** When the volley landed, in the cast's own clock. `-1` for "not yet". */
    this._landedAt = -1;

    /* --- scratch handed to the two materials each frame --- */
    this._state = {
      hand: new Vector3(),
      target: new Vector3(),
      side: new Vector3(),
      seed: 0,
      count: 7,
      qHead: 0,
      qTail: 0,
      fade: 1
    };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The gather. `swirl` is the one particle mode none of the shipped six use:
    // the mote orbits a travelling anchor, and a negative `uSwirlExpand` walks
    // that orbit inward as it ages, so the wind-up genuinely draws power in
    // rather than puffing it out.
    this.motes = particles.get('arcanevolley.motes', {
      capacity: 2400,
      shape: ParticleShape.SOFT,
      additive: true,
      swirl: true,
      softFade: 0.35
    });
    this.motes.uniforms.uDrag.value = 1.4;
    this.motes.uniforms.uEndSize.value = 0.1;
    this.motes.uniforms.uSizeIn.value = 0.05;
    this.motes.uniforms.uFadeIn.value = 0.08;
    this.motes.uniforms.uFadeOut.value = 0.5;

    // The combined impact.
    this.sparks = particles.get('arcanevolley.sparks', {
      capacity: 2400,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.5;
    this.sparks.uniforms.uEndSize.value = 0.25;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.45;

    // Floor dust under it. Non-additive so it occludes.
    this.dust = particles.get('arcanevolley.dust', {
      capacity: 1200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.dust.uniforms.uDrag.value = 1.8;
    this.dust.uniforms.uEndSize.value = 2.4;
    this.dust.uniforms.uSizeIn.value = 0.12;
    this.dust.uniforms.uFadeIn.value = 0.16;
    this.dust.uniforms.uFadeOut.value = 0.32;

    this.intakeEmitter = new RateEmitter();
    this.shedEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    // Two passes over the same bolts.
    return this._boltCount * 2;
  }

  get impactDuration() {
    return Math.max(0.05, settings.arcanevolley.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.arcanevolley.fadeTime);
  }

  /** How far the gather has wound up, 0..1. */
  get charge() {
    return saturate(this.age / Math.max(0.01, settings.arcanevolley.charge));
  }

  /** Seconds one bolt spends in the air, at the live speed. */
  get flightTime() {
    const c = settings.arcanevolley;
    return this.length / Math.max(0.01, c.speed * settings.global.speed);
  }

  /** A slow breath, not a stutter: these are not electrical. */
  lightShimmer() {
    const c = settings.arcanevolley;
    return 1 - c.lightPulse * (0.5 - 0.5 * Math.cos(this.age * c.lightPulseSpeed * TAU));
  }

  /**
   * Hold the volley at the hand until the gather is up to power.
   *
   * Bought exactly the way Nova Beam buys its fourth beat: the phase machine
   * still runs travel → impact → fade, and the wind-up is a refusal to let the
   * front leave the caster.
   */
  advance(dt) {
    const c = this.config;
    const charge = Math.max(0, c.charge);
    if (this.age < charge) return false;

    const speed = c.speed * settings.global.speed;
    const since = this.age - charge;
    this.front += speed * Easing.outQuad(saturate(since / 0.05)) * dt;

    const previousU = this.u;
    this.u = saturate(this.front / this.length);
    this.pointAt(this.u, this.position);
    return this.u >= 1 && previousU < 1;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                  */
  /* ------------------------------------------------------------------ */

  /** Where the bolts gather, world space. */
  _handPoint(out) {
    const c = settings.arcanevolley;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** Where all seven arrive, world space. */
  _impactPoint(out) {
    this.pointAt(1, out);
    out.y = settings.arcanevolley.endHeight;
    return out;
  }

  /**
   * The perpendicular frame the weave lives in, into the module scratch.
   *
   * A line-for-line mirror of `volleyFrame()` in `VolleyMaterial.js`: the
   * lateral reference is Gram-Schmidt'd against the flight direction, because
   * the bolts leave a hand at chest height and land lower, so `Ability#side` is
   * only approximately perpendicular to the path they actually fly.
   */
  _frame(hand, target) {
    _dir.copy(target).sub(hand);
    const span = Math.max(_dir.length(), 0.01);
    _dir.multiplyScalar(1 / span);
    _n1.copy(this.side).addScaledVector(_dir, -this.side.dot(_dir));
    if (_n1.lengthSq() > 1e-8) _n1.normalize();
    else _n1.crossVectors(_dir, _up).normalize();
    _n2.crossVectors(_dir, _n1).normalize();
  }

  /**
   * The head's place on its own clock. See `VolleyMaterial.js` for what `q`
   * means; in short, `-1` is the start of the gather, `0` is release and `1` is
   * the target.
   */
  get _q() {
    if (this.phase === AbilityPhase.TRAVEL) {
      return this.u > 0 ? this.u : -(1 - this.charge);
    }
    return 1;
  }

  /** Where bolt `index` is at `q`, in world space. The JS half of the mirror. */
  _boltPoint(index, q, out) {
    const c = settings.arcanevolley;
    this._handPoint(_hand);
    this._impactPoint(_target);
    this._frame(_hand, _target);
    return boltPointJS(c, this._seed, index, this._boltCount, q, _hand, _target, _n1, _n2, out);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.intakeEmitter.reset();
    this.shedEmitter.reset();
    this._landedAt = -1;

    // The one thing a cast captures, and it is unitless.
    this._seed = Math.random() * 100;

    this._syncUniforms(1);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push live settings and the cast state into both passes and all three
   * particle systems.
   *
   * The only arithmetic worth reading is the tail. `trailSpan` is authored in
   * *seconds*, and the shader wants a `q`, so it is divided by whichever clock
   * the bolt is currently on — the wind-up before release, the flight after.
   * Doing that conversion here rather than in the shader is what keeps the
   * whole thing live: `speed`, `charge` and `trailSpan` are all re-read on the
   * frame, so a paused volley grows a longer tail the moment you drag any of
   * them.
   *
   * @param {number} fade 1 while the volley is lit, ramping to 0 as it dies
   */
  _syncUniforms(fade) {
    const c = settings.arcanevolley;
    const g = settings.global;

    this._handPoint(_hand);
    this._impactPoint(_target);

    const state = this._state;
    state.hand.copy(_hand);
    state.target.copy(_target);
    state.side.copy(this.side);
    state.seed = this._seed;
    this._boltCount = Math.max(1, Math.min(MAX_BOLTS, Math.round(c.bolts)));
    state.count = this._boltCount;
    state.fade = fade;

    const qHead = this._q;
    state.qHead = qHead;

    // Seconds of trail, in the units of whichever clock the head is on.
    const clock = qHead <= 0 ? Math.max(0.01, c.charge) : Math.max(0.01, this.flightTime);
    let spanQ = c.trailSpan / clock;
    // Once it has landed the tail walks forward to meet a head that has
    // stopped: the ribbon *shortens* rather than dimming, which reads as
    // something that stopped being made instead of a light going out.
    if (this._landedAt >= 0) {
      const burn = saturate((this.age - this._landedAt) / Math.max(0.02, c.trailBurn));
      spanQ *= 1 - Easing.outQuad(burn);
    }
    state.qTail = clamp(qHead - spanQ, -1, 1);

    this.trailGeometry.instanceCount = this._boltCount;
    this.headGeometry.instanceCount = this._boltCount;
    this.trailMaterial.userData.sync(state);
    this.headMaterial.userData.sync(state);

    /* --- the three particle systems --- */
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
    this.motes.uniforms.uOpacity.value = g.opacity;
    this.motes.uniforms.uGlow.value = c.trailGlow * 0.5 * g.glow;
    this.motes.uniforms.uSwirl.value = c.moteSwirl * g.animationSpeed;
    this.motes.uniforms.uSwirlExpand.value = c.moteSwirlExpand;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

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
    this.sparks.uniforms.uGlow.value = c.headGlow * 0.5 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
    this.sparks.uniforms.uTurbulence.value = 0.25 * g.turbulence;

    this.dust.setGradient(
      getColor(c.colorDustA),
      getColor(c.colorDustB),
      getColor(c.colorDustC),
      getColor(c.colorDustD)
    );
    this.dust.uniforms.uGravity.value.set(0, c.dustRise, 0);
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize;
    this.dust.uniforms.uLifeScale.value = c.dustLifetime * 0.5 * g.particleLifetime;
    this.dust.uniforms.uSpeedScale.value = c.dustSpeed * g.particleSpeed;
    this.dust.uniforms.uOpacity.value = c.dustOpacity * g.opacity;
    this.dust.uniforms.uTurbulence.value = 0.3 * g.turbulence;
  }

  /** The flash at the hand as the seven let go of it. */
  _muzzleFx() {
    const c = settings.arcanevolley;
    const g = settings.global;

    this._handPoint(_pos);
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.muzzleSize * 0.2,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.34,
      intensity: c.muzzleIntensity,
      opacity: 0.85,
      fresnel: 1.7,
      displace: 0.4,
      colorA: getColor(c.colorMuzzleA),
      colorB: getColor(c.colorMuzzleB),
      colorC: getColor(c.colorMuzzleC)
    });

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  /**
   * The gather: motes falling in toward the hand on a shrinking orbit.
   *
   * `anchor` is the hand and the particle is *born on the shell*, which is what
   * the swirl mode wants — the offset between the two is the orbit radius, so
   * the shell slider is a real metre and not a speed dressed up as one.
   */
  _intakeFx(dt) {
    const c = settings.arcanevolley;
    const g = settings.global;

    const count = Math.round(this.intakeEmitter.tick(dt, c.intakeRate * this.charge) * g.particleCount);
    if (count <= 0) return;

    this._handPoint(_pos);
    _emit.position = _pos;
    _emit.radius = c.moteShell;
    // The anchor is the orbit's centre and the velocity is what *drags* that
    // centre, so the speed here is a drift and not an approach — the approach
    // is `moteSwirlExpand`, which walks the radius in as the mote ages.
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed * 0.3;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.6;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.09;
    _emit.sizeVariance = 0.6;
    _emit.life = c.moteLifetime;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(count, _emit);
  }

  /** Motes shed off the bolts in flight — one bolt per batch, chosen in turn. */
  _shedFx(dt, scale) {
    const c = settings.arcanevolley;
    const g = settings.global;

    const count = Math.round(this.shedEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (count <= 0) return;

    const q = this._q;
    const per = Math.max(1, Math.ceil(count / this._boltCount));
    for (let i = 0; i < this._boltCount; i++) {
      this._boltPoint(i, q, _pos);
      _emit.position = _pos;
      _emit.radius = 0.06;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = _pos;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.5;
      _emit.life = c.moteLifetime * 0.7;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.motes.emit(per, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.arcanevolley;
    const g = settings.global;

    this._syncUniforms(1);

    // The light rides the middle of the volley — the axis point the weave is
    // measured against — rather than the floor under it.
    this._boltPoint(0, this._q, _pos);
    this.position.copy(_pos);

    if (this.u <= 0) {
      this._intakeFx(dt);
      this.ctx.shake.rumble(c.chargeShake * this.charge * g.cameraShake, dt);
    } else {
      this._shedFx(dt, 1);
      this.ctx.shake.rumble(c.rumble * g.cameraShake, dt);
    }
  }

  onImpact() {
    const c = settings.arcanevolley;
    const g = settings.global;
    const time = frame.uTime.value;

    // The timestamp the tail's catch-up is measured from. An event, not a
    // dimension: every metre it feeds is resolved from settings afterwards.
    this._landedAt = this.age;

    this._impactPoint(_pos);
    this.pointAt(1, _target);

    /* one shell, because seven bolts landing together is one hit */
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.burstSize * 0.18,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.6,
      intensity: c.burstIntensity,
      opacity: 0.9,
      fresnel: 1.6,
      displace: 0.55,
      squash: 0.9,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _target, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.5,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });
    this.ctx.decals.spawn(DecalType.SCORCH, _target, {
      radius: c.scorchRadius * 2.2,
      life: c.scorchLife,
      intensity: c.scorchIntensity,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorEmber),
      height: 0.015
    });

    _emit.position = _pos;
    _emit.radius = 0.25;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.4).setY(0.75).normalize();
    _emit.speed = c.sparkSpeed * 2.1;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.2;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);

    _emit.position = _target;
    _emit.radius = c.scorchRadius * 2;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dustSpeed * 2.0;
    _emit.spread = 1.0;
    _emit.size = 1.3;
    _emit.life = c.dustLifetime * 1.2;
    _emit.spin = 0.4;
    this.dust.emit(Math.round(c.burstDust * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      26
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.3 * g.explosionIntensity;
  }

  onFade(dt, t) {
    // `t` runs 0..1 while the spent trails hang, then 1..2 while they blow out.
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
    this._syncUniforms(fade);

    this._impactPoint(this.position);
    this._shedFx(dt, fade * 0.25);
  }

  onDestroy() {
    this._boltCount = 1;
    this._landedAt = -1;
    this.trailGeometry.instanceCount = 1;
    this.headGeometry.instanceCount = 1;
    this.trailMaterial.uniforms.uFade.value = 0;
    this.headMaterial.uniforms.uFade.value = 0;
  }

  dispose() {
    this.trailGeometry.dispose();
    this.trailMaterial.dispose();
    this.headGeometry.dispose();
    this.headMaterial.dispose();
    super.dispose();
  }
}
