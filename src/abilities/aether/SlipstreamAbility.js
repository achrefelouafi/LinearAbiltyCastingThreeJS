import { Vector3 } from 'three';
import { Ability } from '../Ability.js';
import { DistortionField, DistortionMode, DistortionFacing } from '../../vfx/Distortion.js';
import { Tube, TubePath } from '../../vfx/Tube.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, Easing, randRange } from '../../utils/math.js';

/* ------------------------------------------------------------------ */
/* Module-scope scratch — I3. Nothing below allocates in a frame.      */
/* ------------------------------------------------------------------ */

const _up = new Vector3(0, 1, 0);
const _from = new Vector3();
const _to = new Vector3();
const _axis = new Vector3();
const _normal = new Vector3();
const _plane = new Vector3();
const _anchor = new Vector3();
const _pos = new Vector3();
const _dir = new Vector3();
/** Refilled and handed to `DistortionField#update` on the same line. */
const _warp = {};
/** Refilled and handed to `ParticleSystem#emit` on the same line. */
const _emit = {};

/**
 * SLIPSTREAM — a blade of vacuum drawn along the aimed line.
 *
 * **THE TRICK: almost nothing is drawn.** Every other slot in this sandbox
 * makes its mark by *adding* light — a bolt, a crystal, a shell, a burn. This
 * one adds a thread 1.4 cm across and otherwise emits no photons at all. What
 * you see is the world behind the blade sliding sideways: one
 * `DistortionField(BLADE)` writing a screen-space UV offset into the
 * refraction buffer, and the floor grid, the character and every particle
 * behind the plane shearing along the blade's own surface normal. Take the
 * distortion pass away and this ability is a white line. That is the point of
 * it: it is the proof that the pass works, and it is the only slot whose
 * silhouette is made of the *scene* rather than of itself.
 *
 * ### Why a plane of nothing is visible at all
 *
 * A razor-thin slab of a different refractive index shifts what is behind it
 * along its own normal, and the shift grows as the view ray runs *along* the
 * slab, because that is where the path through it is longest —
 * `normal projected to screen × (1 − |N·V|)^grazing`, all of it inside
 * `Distortion.js`. So the blade is invisible when you look squarely at its
 * face and strongest when you are almost edge-on to it, which is exactly how a
 * pane of glass behaves and exactly why you can never quite decide where its
 * surface is. The sandbox's default camera sits behind the caster looking
 * downrange, which is nearly edge-on to a blade drawn along the cast line —
 * so the shipped view is the strong one, on purpose.
 *
 * ### The beats
 *
 * 1. **Travel.** `uCut` extends along the blade's own length rather than
 *    scaling it, so the sheet the front has already opened stays exactly where
 *    it was opened while the front runs on. The hairline thread is drawn to
 *    the same fraction. Fast: 88 m/s, a fifth of a second on a full-range
 *    cast.
 * 2. **The cut.** For `lifetime` seconds the refraction spikes by
 *    `refractCut` and decays on `refractCutSharp`. This is the whole payoff
 *    beat and it is *shorter* than it feels — 180 ms — because a peak you can
 *    stare at reads as a bug in the render rather than as an event.
 * 3. **The heal.** Strength, coverage, wake depth and the thread's radius all
 *    run down together over `fadeTime`, leaving a line of dust hanging in the
 *    air where the air used to be cut.
 *
 * ### What was tried and thrown away
 *
 * The first pass gave the blade its own bright hairline via
 * `DistortionField({ edge: true })` *and* ran the `Tube` along the same line.
 * Two coincident hairlines at slightly different widths do not read as one
 * bright line; they read as a double exposure, and every time the camera moved
 * one slid a pixel against the other. The blade's edge pass is off and the
 * `Tube` is the only bright thing in the ability.
 *
 * The second pass drove the wake with `strength` instead of `wake`, which is
 * the mistake `Distortion.js` warns about in its one rule: an emitter that
 * carries its falloff in its amplitude cannot be faded out without changing
 * its silhouette. Healing it made the blade get *shorter* from the bottom in
 * lockstep with getting weaker, which looked like the sheet was being wound in
 * on a reel. Mask and amplitude are separate here.
 *
 * ### Invariants
 *
 * A cast captures exactly one number — `_seed`, a unitless dice roll that
 * decorrelates the surface ripple — plus the phase timestamps the base class
 * already keeps. Every metre, every screen fraction and every colour is
 * re-resolved from `settings.slipstream` inside `_sync()`, which runs on every
 * frame including a zero-length one. Pause with **P** mid-cut and drag
 * `bladeHeight`: the sheet gets deeper while the hairline stays exactly where
 * it is, because the hairline is authored in metres and divided by the height
 * here rather than being a fraction the module scales for you.
 */
export class SlipstreamAbility extends Ability {
  constructor(context) {
    super('slipstream', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * The blade. `WORLD` facing, because the plane is placed by the cast's own
     * basis and not by the camera; `edge: false`, because the thread below is
     * the hairline and two of them fight (see the class comment).
     *
     * `renderOrder` matters more than it looks: emitters blend into the offset
     * buffer by coverage and the last one drawn at near-full coverage takes the
     * direction. Nothing else in this ability writes to the buffer, but a
     * concurrent cast might, and a blade should lose to a lens rather than
     * win — so it sits low.
     */
    this.blade = new DistortionField({
      mode: DistortionMode.BLADE,
      facing: DistortionFacing.WORLD,
      edge: false,
      renderOrder: 2,
      name: 'slipstream.blade'
    });
    this.group.add(this.blade.object3D);

    /**
     * The hairline. `nodes`/`sides` are well below the module defaults (96/26)
     * and that is a real saving rather than a cheat: a straight tube 1.6 cm
     * across needs no tessellation along its length that a 48-node grid does
     * not already give it, and eight facets around a barrel whose silhouette is
     * under two pixels wide is more than the rasteriser can tell apart. Twelve
     * thousand triangles down to about eight hundred, for no visible change.
     */
    this.thread = new Tube({
      path: TubePath.STRAIGHT,
      prefix: 'thread',
      nodes: 48,
      sides: 8,
      renderOrder: 12
    });
    this.group.add(this.thread.group);

    /** The one thing a cast captures. Unitless. */
    this._seed = 0;

    /**
     * The tube's state bag. Instance-scope rather than module-scope because
     * four casts can be standing at once and they do not take turns.
     */
    this._state = {
      origin: new Vector3(),
      target: new Vector3(),
      side: new Vector3(),
      progress: 0,
      fade: 1,
      widthFade: 1,
      seed: 0,
      time: 0
    };
  }

  createParticles() {
    /**
     * One system, and it is nearly empty by design. Air that has been opened
     * pulls dust *into* the seam rather than blowing it away, so these are slow,
     * small, non-additive and emitted in a hairline column along the part of
     * the line already cut. A full cast lands under a hundred live particles
     * against the 1500 budget — the restraint is the look.
     */
    this.dust = this.ctx.particles.get('slipstream.dust', {
      capacity: 900,
      shape: ParticleShape.SOFT,
      additive: false,
      curl: true,
      softFade: 0.5
    });
    this.dust.uniforms.uDrag.value = 2.2;
    this.dust.uniforms.uEndSize.value = 1.6;
    this.dust.uniforms.uSizeIn.value = 0.1;
    this.dust.uniforms.uFadeIn.value = 0.12;
    this.dust.uniforms.uFadeOut.value = 0.55;

    this.dustEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** The cut holds wide open for this long. Deliberately short. */
  get impactDuration() {
    return Math.max(0.02, settings.slipstream.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.slipstream.fadeTime);
  }

  /**
   * Nothing here is instanced: the whole ability is one quad on the distortion
   * layer and three barrels of a hairline tube. Reporting zero is honest, and
   * the HUD readout says what it should — that this slot costs nothing.
   */
  get instanceCount() {
    return 0;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry of the cut — every metre resolved from live settings        */
  /* ------------------------------------------------------------------ */

  /**
   * A point on the **cutting edge** at `s` along the cast, 0..1.
   *
   * The edge is the thing the player is aiming; the sheet of disturbed air
   * hangs below it. It leaves the hand at `cutHeight` and arrives at
   * `endHeight`, so a blade that drops as it travels is two sliders rather than
   * a rotation nobody can reason about.
   */
  _edgePoint(s, out) {
    const c = settings.slipstream;
    const t = saturate(s);
    out
      .copy(this.origin)
      .addScaledVector(this.direction, lerp(c.bladeLead, this.length, t))
      .addScaledVector(this.side, c.bladeSide);
    out.y = lerp(c.cutHeight, c.endHeight, t);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.dustEmitter.reset();
    this._seed = Math.random() * 100;

    this.blade.visible = true;
    this.thread.visible = true;

    // Sync once before the first frame is drawn, or the blade stands at last
    // cast's length for one frame — which on a 22 m cast is very visible.
    this._sync(0, 0, 0);
  }

  /* ------------------------------------------------------------------ */
  /* The one sync                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current beat into the blade, the thread and
   * the dust. Everything with a unit is read here and nowhere else.
   *
   * @param {number} cut   0..1 of the blade's length that has been opened
   * @param {number} spike 0..1 of the cut beat's extra refraction
   * @param {number} heal  0..1 of the way back to undisturbed air
   */
  _sync(cut, spike, heal) {
    const c = settings.slipstream;
    const g = settings.global;

    /* --- the plane, in world space --- */
    this._edgePoint(0, _from);
    this._edgePoint(1, _to);

    _axis.subVectors(_to, _from);
    const span = Math.max(0.05, _axis.length());
    _axis.multiplyScalar(1 / span);

    // The same two crosses `DistortionField#setBasis` performs, done here as
    // well because the anchor has to sit half a blade *below* the cutting edge
    // and only the caller knows which way "below" ended up pointing once the
    // plane was re-orthogonalised against a tilted axis.
    _normal.crossVectors(_axis, _up);
    if (_normal.lengthSq() < 1e-8) _normal.set(1, 0, 0);
    else _normal.normalize();
    _plane.crossVectors(_normal, _axis).normalize();

    const height = Math.max(0.05, c.bladeHeight);
    _anchor.copy(_from).addScaledVector(_plane, -height * 0.5);

    this.blade.setBasis(_axis, _up);
    this.blade.setAnchor(_anchor);

    /* --- the refraction --- */
    // Amplitude and mask are separate terms. `strength` is the amplitude and
    // nothing else; the silhouette lives in `cut`, `wake` and `opacity`.
    const open = 1 - Easing.inQuad(heal);
    _warp.width = span;
    _warp.height = height;
    _warp.cut = clamp(cut, 0.001, 1);
    _warp.strength = c.refractStrength * open + c.refractCut * spike;
    // Metres in the settings, fractions of the height in the module — see the
    // block comment on the settings module for why this division is here and
    // not in the block.
    _warp.edge = clamp(c.refractEdgeWidth / height, 0.002, 1);
    _warp.edgeGain = c.refractEdgeGain;
    _warp.wake = clamp((c.refractWakeDepth / height) * (1 - heal * 0.8), 0.02, 1);
    _warp.grazing = Math.max(0.05, c.refractGrazing);
    _warp.ripple = c.refractRipple;
    _warp.rippleScale = c.refractRippleScale * g.noiseFrequency;
    _warp.rippleSpeed = c.refractRippleSpeed * g.noiseSpeed;
    _warp.opacity = c.refractOpacity * open;
    _warp.depthReject = c.refractDepthReject;
    _warp.depthFade = c.refractDepthFade;
    _warp.perspective = c.refractPerspective;
    _warp.perspectiveRef = c.refractPerspectiveRef;
    _warp.seed = this._seed;
    this.blade.update(_warp);

    /* --- the hairline --- */
    const state = this._state;
    state.origin.copy(_from);
    state.target.copy(_to);
    state.side.copy(this.side);
    state.progress = cut;
    state.fade = 1 - Easing.inCubic(heal);
    // The thread collapses to a filament before it goes out, rather than just
    // dimming: a cut closing is the two faces meeting, not a lamp on a rheostat.
    state.widthFade = 1 - Easing.outQuad(heal) * 0.92;
    state.seed = this._seed;
    state.time = this.age;
    this.thread.sync(c, state, g);

    /* --- the dust --- */
    this.dust.setGradient(
      getColor(c.colorDustA),
      getColor(c.colorDustB),
      getColor(c.colorDustC),
      getColor(c.colorDustD)
    );
    this.dust.uniforms.uGravity.value.set(0, c.dustRise, 0);
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize * 7;
    this.dust.uniforms.uLifeScale.value = c.dustLifetime * 0.5 * g.particleLifetime;
    this.dust.uniforms.uSpeedScale.value = g.particleSpeed;
    this.dust.uniforms.uOpacity.value = g.opacity;
    this.dust.uniforms.uTurbulence.value = c.dustTurbulence * g.turbulence;
  }

  /**
   * Motes drawn into the seam behind the front.
   * @param {number} cut 0..1 of the line that has been opened
   * @param {number} scale thinning multiplier as the cut heals
   */
  _dustFx(dt, cut, scale) {
    const c = settings.slipstream;
    const g = settings.global;
    const count = Math.round(this.dustEmitter.tick(dt, c.dustRate * scale) * g.particleCount);
    if (count <= 0) return;

    this._edgePoint(randRange(0.04, 1) * Math.max(0.04, cut), _pos);
    _emit.position = _pos;
    _emit.radius = c.dustSpread;
    // Toward the seam, not away from it — the sign here is the whole reason
    // this reads as a low-pressure line rather than as a smoke trail.
    _emit.direction = _dir.copy(this.side).multiplyScalar(-0.25).setY(0.9).normalize();
    _emit.speed = c.dustSpeed;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.09;
    _emit.sizeVariance = 0.6;
    _emit.life = c.dustLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.dust.emit(count, _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(this.u, 0, 0);

    // The light rides the cutting edge, not the floor beneath it.
    this._edgePoint(this.u, this.position);

    this._dustFx(dt, this.u, 1);
    this.ctx.shake.rumble(settings.slipstream.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.slipstream;
    const g = settings.global;

    // No shell, no burn, no shockwave decal. The event is a spike in the
    // refraction — handled in `_sync` — plus the smallest possible amount of
    // corroboration: a breath of dust, a flick of the camera, a flash you would
    // not notice if you were not looking for it.
    this._edgePoint(0.85, _pos);
    _emit.position = _pos;
    _emit.radius = this.length * 0.32;
    _emit.direction = _dir.copy(this.side).multiplyScalar(-0.2).setY(1).normalize();
    _emit.speed = c.dustSpeed * 2.4;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.11;
    _emit.sizeVariance = 0.7;
    _emit.life = c.dustLifetime * 1.3;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.dust.emit(Math.round(c.dustCut * g.particleCount), _emit);

    this.ctx.shake.add(
      c.cutShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.05, c.shakeDuration),
      34
    );
    this.ctx.flash.trigger(getColor(c.colorCutFlash), c.cutFlash * g.explosionIntensity);
  }

  onFade(dt, t) {
    const c = settings.slipstream;

    // `t` runs 0..1 through the cut and 1..2 through the heal.
    const held = saturate(t);
    const heal = saturate(t - 1);
    // The spike decays over the hold on its own exponent. Authored rather than
    // eased so it can be dragged into a slam (0.4) or a sigh (6) while paused.
    const spike = t <= 1 ? Math.pow(1 - held, Math.max(0.05, c.refractCutSharp)) : 0;

    this._sync(1, spike, heal);
    this._edgePoint(1, this.position);

    this._dustFx(dt, 1, (1 - heal) * 0.45);
  }

  onDestroy() {
    // Releases the pass's writer counter. Hiding the parent group instead would
    // leave the count retained and `PostProcessing` clearing and resampling a
    // half-resolution buffer for the rest of the session over nothing.
    this.blade.visible = false;
    this.thread.visible = false;
  }

  dispose() {
    this.blade.dispose();
    this.thread.dispose();
    super.dispose();
  }
}
