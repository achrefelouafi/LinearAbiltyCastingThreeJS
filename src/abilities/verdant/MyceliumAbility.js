import { Mesh, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { createMyceliumSeepMaterial } from '../../materials/MyceliumSeepMaterial.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { acquireGroundQuad, releaseGroundQuad } from '../../vfx/quads.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../../utils/math.js';

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _mid = new Vector3();
const _far = new Vector3();
const _hand = new Vector3();

/**
 * MYCELIAL WEB — the ability that is under the floor.
 *
 * **THE TRICK: nothing here draws a network.** A fungal mat runs out beneath
 * the flagstones and the only thing on screen is light *escaping* — through the
 * mortar courses, through the open pores, and nowhere else. The visible pattern
 * belongs to the stone. The mycelium only decides how brightly each part of the
 * stone is lit from underneath.
 *
 * That inversion is the whole slot, and it is one multiply:
 *
 * ```
 *   alpha = cover * openness * lit * slotted;
 * ```
 *
 * `lit` is the buried network's radiance and `openness` is a mask built out of
 * `world/Ground.js`'s **own expressions** — its `fbm3(wp * 0.018)` macro
 * variation, its `fbm3(wp * 0.06 + 3.0)` sheen patches, its `snoise01(wp * 0.7)`
 * grain, at those frequencies and those phase offsets. The mortar course is the
 * *level set* of the first field, measured into metres by dividing the contour
 * distance by the field's own gradient; the polished patches close the light
 * off entirely, because polished stone is sound stone.
 *
 * The first version did not do that. It drew its own perfectly respectable
 * crack field — a ridged fbm at about two cycles a metre — and it was wrong in
 * a way that took a long time to name: the cracks did not line up with
 * anything. The floor has structure, the glow had *different* structure, and
 * two uncorrelated patterns on one surface read as two surfaces. That is a
 * decal on a floor, which is precisely what the brief forbids. Sharing the
 * floor's actual numbers is a real coupling — change the floor's macro
 * frequency and someone has to come back here — and it is worth having, because
 * the alternative is the decal.
 *
 * The second thing that sells "under" is **depth**, and it is three terms, all
 * physical and all sliders: a strand buried deeper is blurred wider
 * (`webCore + depth * webSpread`), dimmer (`exp(-depth * webAbsorb)`), and
 * **parallaxed** — sampled at `lane - viewXZ * depth / viewY`, so the web
 * slides against the cracks it is seen through as the camera orbits. Take
 * `webParallax` to zero and the whole cast flattens into a sticker on the
 * frame; it is the cheapest convincing term in the file.
 *
 * ## The beats
 *
 *  1. **run** — the growth front travels the line. The lane behind it lights.
 *  2. **knot** — impact. The network keeps creeping past the target for
 *     `creepTime`, reaching `creepReach` further than the cast did, and a patch
 *     of stone at the far end goes visibly damp: a `GroundField(WET)`, which is
 *     alpha-blended and therefore genuinely *darker* than the floor. The glow
 *     quad cannot do that — one mesh cannot both add and subtract — and the
 *     split is why the wet stone reads as wet instead of as lit.
 *  3. **rot** — the fade. The mat is abandoned from the caster outward, so the
 *     near end goes dark first and the far end lingers, and the damp patch
 *     dries from its rim inward. The two fronts run in opposite directions,
 *     which is what stops the aftermath reading as one dimmer switch.
 *
 * ## What a cast captures
 *
 * One seed and one timestamp. Not one metre: the lane's half-width, the hyphal
 * pitch, every burial depth, the pore frequency and the mortar width are all
 * resolved from `settings.mycelium` inside the update loop, on a zero-length
 * frame included. Pause mid-cast and drag `seamWidth` and the mortar the light
 * comes out of gets wider under a standing effect.
 *
 * **Two draw calls** — the seep quad and the damp — plus two shared particle
 * systems.
 */
export class MyceliumAbility extends Ability {
  constructor(context) {
    super('mycelium', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * The seep quad. One mesh, one draw call, and the only thing in the cast
     * that carries the trick.
     *
     * It is `LAYER.VFX` and `renderOrder` under the damp deliberately: the wet
     * stone is a shaded mark and has to be composited before light is added on
     * top of it, or the glow gets multiplied down by the very stain it caused.
     */
    this.seepGeometry = acquireGroundQuad();
    this.seepMaterial = createMyceliumSeepMaterial();
    this.seep = new Mesh(this.seepGeometry, this.seepMaterial);
    this.seep.name = 'MyceliumSeep';
    this.seep.layers.set(LAYER.VFX);
    this.seep.renderOrder = 8;
    this.seep.frustumCulled = false;
    this.group.add(this.seep);

    /**
     * The damp. A disc rather than a lane, and that is a decision rather than a
     * limitation of the module: the network is a lane, but the *water* it
     * pushes ahead of itself pools where the network stops. A soaked stripe the
     * whole length of the cast made the ability read as a spill; a soaked patch
     * at the far end reads as something arriving.
     */
    this.damp = new GroundField(this.group, {
      mode: GroundMode.WET,
      additive: false,
      depthTest: true,
      layer: LAYER.VFX,
      renderOrder: 6,
      name: 'MyceliumDamp'
    });
    /** Live params, allocated once and refilled every frame — I1. */
    this.dampParams = groundFieldParams();
    this.dampParams.centre = new Vector3();

    /** Handed to the seep material every frame. One object, reused. */
    this._state = {
      length: 1,
      grow: 0,
      retreat: 0,
      fade: 1,
      seed: 0
    };

    /** Re-rolled per cast so two mats do not partition the floor the same way. */
    this._seed = 0;
    /** Seconds since the front landed. Drives the creep and nothing else. */
    this._knotTime = 0;
    /** Metres of front travel already paid out in spore puffs. */
    this._puffDistance = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    /**
     * Spores. Additive and curled, emitted at the floor and drifting up out of
     * the seams — the only part of the ability that is above the stone, and
     * kept deliberately sparse so it reads as *leakage* rather than as a plume.
     */
    this.spores = particles.get('mycelium.spores', {
      capacity: 1400,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.35
    });
    this.spores.uniforms.uEndSize.value = 0.4;
    this.spores.uniforms.uSizeIn.value = 0.18;
    this.spores.uniforms.uFadeIn.value = 0.22;
    this.spores.uniforms.uFadeOut.value = 0.5;

    /**
     * Vapour off the damp stone. Non-additive so it genuinely occludes, and
     * heavy — this is cold air over a wet flag, not smoke off a fire.
     */
    this.vapour = particles.get('mycelium.vapour', {
      capacity: 900,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.2
    });
    this.vapour.uniforms.uDrag.value = 2.6;
    this.vapour.uniforms.uEndSize.value = 2.8;
    this.vapour.uniforms.uSizeIn.value = 0.2;
    this.vapour.uniforms.uFadeIn.value = 0.25;
    this.vapour.uniforms.uFadeOut.value = 0.35;

    this.sporeEmitter = new RateEmitter();
    this.vapourEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    // Two meshes, neither instanced. The HUD readout is honest about it.
    return 2;
  }

  get impactDuration() {
    const c = settings.mycelium;
    return Math.max(0.2, (c.creepTime + c.holdTime) * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.2, settings.mycelium.rotTime);
  }

  /**
   * A slow breathe, not a flicker.
   *
   * The light this ability owns is under the floor as far as the fiction is
   * concerned, so it has no business snapping: anything above about a hertz
   * reads as electrical, and this is the one school where that is wrong.
   */
  lightShimmer() {
    const c = settings.mycelium;
    return 1 - saturate(c.lightBreathe) * 0.5 * (1 - Math.cos(this.age * c.lightBreatheRate * Math.PI * 2));
  }

  /* ------------------------------------------------------------------ */
  /* The clocks — pure functions of live settings                        */
  /* ------------------------------------------------------------------ */

  /** Where the cast leaves the caster. */
  _handPoint(out) {
    const c = settings.mycelium;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** How far past the target the mat has crept, 0..1. */
  _creep() {
    const c = settings.mycelium;
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    return Easing.outCubic(saturate(this._knotTime / Math.max(0.05, c.creepTime)));
  }

  /** The mat's full length in metres, creep included. Never stored. */
  _reach() {
    const c = settings.mycelium;
    return this.length * (1 + Math.max(0, c.creepReach) * this._creep());
  }

  /**
   * Half-width of the lane at `s` along it, metres.
   *
   * Mirrors the shader's taper exactly, so the spores the CPU seeds land inside
   * the band the GPU is drawing rather than near it.
   */
  _laneHalf(s) {
    const c = settings.mycelium;
    return Math.max(0.02, c.laneHalfWidth * (1 - saturate(c.laneTaper) * saturate(s)));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.sporeEmitter.reset();
    this.vapourEmitter.reset();
    this._knotTime = 0;
    this._puffDistance = 0;

    // The one thing a cast captures, besides the timestamp the front landed on.
    this._seed = Math.random() * 100;

    this.damp.clearMarks();
    this.damp.setVisible(false);
    this.seep.visible = true;

    this._sync(0, 1);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings into the seep quad, the damp and both particle
   * systems.
   *
   * @param {number} retreat 0..1 — how far the mat has been abandoned from the
   *   caster outward
   * @param {number} fade    0..1 — the master dim
   */
  _sync(retreat, fade) {
    const c = settings.mycelium;
    const g = settings.global;
    const creep = this._creep();
    const reach = this._reach();

    /* --- the seep quad -------------------------------------------------- */
    const state = this._state;
    state.length = reach;
    // Divided by the creep, so the *drawn* front sits at the same world point
    // during travel however far the mat is eventually going to reach.
    state.grow =
      this.phase === AbilityPhase.TRAVEL ? saturate((this.u * this.length) / Math.max(reach, 0.01)) : 1;
    state.retreat = retreat;
    state.fade = fade;
    state.seed = this._seed;

    const quad = this.seepMaterial.userData.sync(state);

    // The quad is centred on the middle of the mat and yawed onto the heading —
    // both re-derived here, because `reach` grows while the mat creeps and a
    // captured centre would leave the far end outside the canvas.
    this.pointAt(0.5 * (reach / Math.max(this.length, 0.01)), _mid);
    this.seep.position.set(_mid.x, c.seepHeight, _mid.z);
    this.seep.rotation.set(0, Math.atan2(this.direction.x, this.direction.z), 0);
    this.seep.scale.set(quad.x, 1, quad.y);
    this.seep.visible = fade > 0.004;

    /* --- the damp ------------------------------------------------------- */
    this.pointAt(1, _far);
    const p = this.dampParams;
    p.centre.copy(_far);
    p.yaw = 0;
    p.height = c.dampHeight;
    p.radius = Math.max(0.1, c.dampRadius);
    p.grow = creep;
    // Dries from the rim inward while the glow dies back from the caster
    // outward. Two fronts in opposite directions; one dimmer switch is what it
    // looks like without that.
    p.recede = retreat;
    p.fade = fade;
    p.seed = this._seed;

    p.edge = c.dampEdge;
    p.ragged = c.dampRagged;
    p.raggedScale = c.dampRaggedScale;
    p.warp = c.dampWarp;
    p.relief = c.dampRelief;
    p.ambient = c.dampAmbient;
    p.specular = c.dampSpecular;
    p.gloss = c.dampGloss;
    p.cell = c.dampCell;
    p.lift = c.dampLift;
    p.depth = c.dampDepth;
    p.flow = c.dampFlow;
    p.detail = c.dampDetail;
    p.speed = c.dampSpeed;
    p.windAngle = c.dampWindAngle;
    p.emissive = c.dampEmissive * g.glow;
    p.opacity = c.dampOpacity;
    p.depthFade = c.dampDepthFade;
    p.colorBase = c.colorDampBase;
    p.colorEdge = c.colorDampEdge;
    p.colorGlow = c.colorDampGlow;
    p.colorDeep = c.colorDampDeep;
    p.noiseStrength = g.noiseStrength;
    p.noiseFrequency = g.noiseFrequency;
    p.noiseSpeed = g.noiseSpeed;
    p.opacityScale = g.opacity;

    this.damp.setVisible(creep > 0.001 && fade > 0.004);
    this.damp.update(p);

    /* --- the two particle systems --------------------------------------- */
    this.spores.setGradient(
      getColor(c.colorSporeA),
      getColor(c.colorSporeB),
      getColor(c.colorSporeC),
      getColor(c.colorSporeD)
    );
    this.spores.uniforms.uGravity.value.set(0, c.sporeSag, 0);
    this.spores.uniforms.uDrag.value = Math.max(0.05, c.sporeDrag);
    this.spores.uniforms.uSizeScale.value = c.sporeSize * g.particleSize * 7;
    this.spores.uniforms.uLifeScale.value = c.sporeLifetime * 0.5 * g.particleLifetime;
    this.spores.uniforms.uSpeedScale.value = c.sporeRise * g.particleSpeed;
    this.spores.uniforms.uOpacity.value = g.opacity;
    this.spores.uniforms.uGlow.value = c.sporeGlow * g.glow;
    this.spores.uniforms.uTurbulence.value = c.sporeTurbulence * g.turbulence;

    this.vapour.setGradient(
      getColor(c.colorVapourA),
      getColor(c.colorVapourB),
      getColor(c.colorVapourC),
      getColor(c.colorVapourD)
    );
    this.vapour.uniforms.uGravity.value.set(0, c.vapourRise, 0);
    this.vapour.uniforms.uSizeScale.value = c.vapourSize * g.particleSize;
    this.vapour.uniforms.uLifeScale.value = c.vapourLifetime * 0.5 * g.particleLifetime;
    this.vapour.uniforms.uSpeedScale.value = c.vapourSpeed * g.particleSpeed;
    this.vapour.uniforms.uOpacity.value = c.vapourOpacity * g.opacity;
    this.vapour.uniforms.uTurbulence.value = 0.25 * g.turbulence;
  }

  /** The cough of spores at the hand as the mat is put into the ground. */
  _muzzleFx() {
    const c = settings.mycelium;
    const g = settings.global;

    this._handPoint(_hand);

    this.ctx.bursts.spawn(BurstMode.EARTH, _hand, {
      radius: c.muzzleSize * 0.3,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.55,
      intensity: c.muzzleIntensity,
      opacity: 0.35,
      fresnel: 1.2,
      displace: 0.4,
      squash: 0.7,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this._emitSpores(Math.round(14 * g.particleCount), _hand, 0.2);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.35 * g.explosionIntensity;
  }

  /** Release `count` spores in a ball of `spread` metres about `at`. */
  _emitSpores(count, at, spread) {
    if (count <= 0) return;
    const c = settings.mycelium;

    _emit.position = at;
    _emit.radius = spread;
    _emit.direction = _dir.set(0, 1, 0);
    // Unit speed: the metres per second live in `uSpeedScale`, rewritten every
    // frame, which is what keeps `sporeRise` a live slider on standing spores.
    _emit.speed = 1;
    _emit.speedVariance = c.sporeSpeedVariance;
    _emit.spread = c.sporeSpread;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.07;
    _emit.sizeVariance = 0.65;
    _emit.life = 1;
    _emit.lifeVariance = 0.45;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.spores.emit(count, _emit);
  }

  /**
   * Spores leaking out along the lit part of the mat.
   *
   * @param {number} scale 0..1 — thinned out once the mat is only holding
   */
  _laneFx(dt, scale) {
    const c = settings.mycelium;
    const g = settings.global;
    const reach = this.phase === AbilityPhase.TRAVEL ? Math.max(0.02, this.u) : 1;

    const sporeCount = Math.round(this.sporeEmitter.tick(dt, c.sporeRate * scale) * g.particleCount);
    if (sporeCount > 0) {
      const s = Math.random() * reach;
      this.pointAt(s, _pos);
      // Off the spine by a real fraction of the lane, so the leak follows the
      // band rather than dribbling down the centre line.
      const half = this._laneHalf(s);
      _pos.addScaledVector(this.side, randRange(-half, half));
      _pos.y = c.sporeBirthHeight;
      this._emitSpores(sporeCount, _pos, half * 0.25 + 0.05);
    }

    const vapourCount = Math.round(this.vapourEmitter.tick(dt, c.vapourRate * scale) * g.particleCount);
    if (vapourCount > 0) {
      // Vapour comes off the *damp*, which only exists once the front has
      // landed; before that it trickles off the growth front instead.
      const at = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
      this.pointAt(at, _pos);
      const bearing = Math.random() * Math.PI * 2;
      const spill = Math.max(0.1, c.dampRadius) * 0.75 * Math.sqrt(Math.random());
      _pos.x += Math.cos(bearing) * spill;
      _pos.z += Math.sin(bearing) * spill;
      _pos.y = c.vapourBirthHeight;

      _emit.position = _pos;
      _emit.radius = Math.max(0.1, c.dampRadius) * 0.2;
      _emit.direction = _dir.set(Math.cos(bearing) * 0.4, 1, Math.sin(bearing) * 0.4).normalize();
      _emit.speed = 1;
      _emit.speedVariance = 0.55;
      _emit.spread = 0.5;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.7;
      _emit.sizeVariance = 0.5;
      _emit.life = 1;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.2;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.vapour.emit(vapourCount, _emit);
    }
  }

  /**
   * A puff of spores every `puffRate` metres of front travel.
   *
   * Distance-driven rather than time-driven, so the trail of puffs is evenly
   * spaced along the floor whatever `speed` is set to. The bolt's ground burns
   * use the same accumulator for the same reason.
   */
  _frontFx() {
    const c = settings.mycelium;
    const g = settings.global;
    const step = 1 / Math.max(0.05, c.puffRate);

    while (this.front - this._puffDistance >= step) {
      this._puffDistance += step;
      const s = saturate(this._puffDistance / this.length);
      this.pointAt(s, _pos);
      const half = this._laneHalf(s);
      _pos.addScaledVector(this.side, randRange(-half, half));
      _pos.y = c.sporeBirthHeight;
      this._emitSpores(Math.round(c.puffSpores * g.particleCount), _pos, half * 0.3 + 0.06);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.mycelium;

    this._sync(0, 1);

    // The light rides the growth front, and it rides it *low* — this is light
    // coming out of the floor, so a lamp at chest height would give the whole
    // thing away.
    this.position.y = c.lightHeight;

    this._frontFx();
    this._laneFx(dt, 1);
    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.mycelium;
    const g = settings.global;

    this._knotTime = 0;
    this.pointAt(1, _far);

    /* the mat knotting up — a low, wide, almost transparent shell */
    _pos.copy(_far).setY(c.dampHeight + 0.05);
    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 1.0,
      intensity: c.burstIntensity,
      opacity: 0.3,
      fresnel: 1.3,
      displace: 0.45,
      squash: 0.22,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    _pos.copy(_far).setY(c.sporeBirthHeight);
    this._emitSpores(Math.round(c.burstSpores * g.particleCount), _pos, Math.max(0.1, c.dampRadius) * 0.6);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      9
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.mycelium;

    if (t <= 1) this._knotTime += dt;

    // `t` runs 0..1 while the mat holds, then 1..2 while it rots. The die-back
    // is eased *out* and the dim eased *in*: the mat lets go of the near end
    // straight away and then hangs on to whatever is left, which is what a
    // living thing being starved looks like and a linear ramp is not.
    const rot = t <= 1 ? 0 : saturate(t - 1);
    const retreat = Easing.outQuad(rot) * saturate(c.dieBack);
    const fade = 1 - Easing.inQuad(rot);

    this._sync(retreat, fade);

    // The light settles into the knot at the far end and sinks with it.
    this.pointAt(lerp(1, 1 + Math.max(0, c.creepReach) * 0.5, this._creep()), this.position);
    this.position.y = c.lightHeight * (1 - 0.5 * rot);

    this._laneFx(dt, fade * (t <= 1 ? 0.7 : 0.3));
  }

  onDestroy() {
    this._knotTime = 0;
    this._puffDistance = 0;
    this.seep.visible = false;
    this.seepMaterial.uniforms.uFade.value = 0;
    this.damp.setVisible(false);
    this.damp.clearMarks();
  }

  dispose() {
    this.seepMaterial.dispose();
    releaseGroundQuad();
    this.seepGeometry = null;
    this.damp.dispose();
    super.dispose();
  }
}
