import { Mesh, Vector3 } from 'three';
import { Ability } from '../Ability.js';
import {
  createPhotonBeamGeometry,
  createPhotonBeamMaterial,
  photonBeamCount,
  MAX_PHOTON_BEAMS
} from '../../materials/PhotonBeamMaterial.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing } from '../../utils/math.js';

/**
 * Hard ceiling on nodes per axis. Five cubed is 75 beams against a buffer
 * allocated for `MAX_PHOTON_BEAMS`; six would be 108 and would silently drop a
 * third of the lattice, which is exactly the sort of failure that looks like a
 * shader bug for an hour.
 */
const MAX_NODES = 5;

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ */
/* Scratch — module scope (I3)                                         */
/* ------------------------------------------------------------------ */

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _up = new Vector3(0, 1, 0);

/**
 * PHOTON LATTICE — a grid of thin beams hanging over the circle.
 *
 * **THE TRICK IS THAT NOTHING IS DRAWN AT THE NODES.** Three families of beams
 * — one running across the cast, one up, one downrange — cross at `gridX ×
 * gridY × gridZ` points, and every one of those points is a bright node for
 * exactly one reason: two beams are being added there. There is no node sprite
 * in this file, no billboard, no second pass over the crossings, and no slider
 * anywhere in `settings.photonlattice` that lights them. Search the block for
 * "node" and you will find the word only in comments.
 *
 * That is easy to claim and hard to earn, and two things had to be true for it
 * to work at all:
 *
 * 1. **A beam has to be an integral, not a surface.** Drawing each beam as a
 *    thin cylinder with a radial gradient gives you two gradients overlapping
 *    at a crossing, which sums to a slightly brighter *lozenge* and reads as a
 *    join in a pipe. What is drawn instead is the closed-form line integral of
 *    a gaussian tube along the view ray — see `materials/PhotonBeamMaterial.js`
 *    for the algebra and for the marched version that came first and why it was
 *    thrown away. An integral has a sharp maximum on the axis, and two sharp
 *    maxima coinciding is what the eye reads as a point of light.
 * 2. **Alpha has to be one.** With `AdditiveBlending` the destination gets
 *    `rgb × alpha` added, so writing a luminance into alpha squares everything
 *    and a node becomes four times a beam instead of twice. Four times looks
 *    better in a still and is a lie, and it falls apart the moment three beams
 *    meet at a corner and the corner is sixteen times a beam.
 *
 * The one rule for tuning it follows directly: **if the nodes are not bright
 * enough, the beams are too dim.** `density`, `coreGain` and `intensity`.
 * Nothing else, ever.
 *
 * `beamRadius` is the other slider worth the visit. Small — four or five
 * centimetres of gaussian sigma — is what gives the maximum its sharpness. Drag
 * it up with the clock paused and the nodes dissolve into a fog cube with lumps
 * in it, which is a live demonstration of why the previous paragraph is true.
 *
 * Everything else follows from beams that are honestly the length they claim:
 * they grow from their own **midpoints outward**, so the crossings near the
 * middle of the volume light before the corners, and the fade retracts them the
 * same way so the corners go out first. Neither of those was authored; they are
 * what happens when the drawn extent is the integration limit.
 *
 * **One draw call** for the whole lattice — one instanced hull, every beam
 * placed by the vertex shader from three node counts. One particle system,
 * `photonlattice.mote`, seeded through the box: the motes are not node markers
 * and nothing samples the lattice to place them; the ones that drift near a
 * beam simply brighten, in the frame buffer, because both are additive.
 *
 * **The rule that makes the editor work.** A cast captures one number, `_seed`,
 * which decorrelates the per-beam stagger and breath. Not one metre, and not
 * even the beam count: `gridX`, `gridY` and `gridZ` are read every frame and
 * the vertex shader re-derives which family each instance index belongs to, so
 * dragging `gridY` on a paused, standing lattice moves beams between families
 * in front of you.
 */
export class PhotonLatticeAbility extends Ability {
  constructor(context) {
    super('photonlattice', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.geometry = createPhotonBeamGeometry(MAX_PHOTON_BEAMS, 6);
    this.material = createPhotonBeamMaterial();

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.layers.set(LAYER.VFX);
    // Above the ground decals and below the HUD-space flare layers. Additive
    // and depth-test-off, so the order between VFX only decides who is added
    // first, which for a commutative blend is a tidiness choice.
    this.mesh.renderOrder = 12;
    this.mesh.visible = false;
    this.group.add(this.mesh);

    /** Re-rolled per cast. The only state a cast captures. */
    this._seed = 0;
    /** Beams drawn this frame — the HUD readout, and one draw call regardless. */
    this._live = 0;
  }

  createParticles() {
    // Small, and not a node marker. These hang in the box and drift; a mote
    // that happens to pass close to a beam brightens because the frame buffer
    // adds them together, which is the same mechanism the nodes use and the
    // reason it is the right particle system for this ability rather than a
    // sparkle pinned to each crossing.
    this.motes = this.ctx.particles.get('photonlattice.mote', {
      capacity: 640,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.5;
    this.motes.uniforms.uEndSize.value = 0.3;
    this.motes.uniforms.uSizeIn.value = 0.14;
    this.motes.uniforms.uFadeIn.value = 0.2;
    this.motes.uniforms.uFadeOut.value = 0.4;

    this.moteEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** Beams drawn this frame. One draw call for all of them. */
  get instanceCount() {
    return this._live;
  }

  /** The locked grid is the ability; the assemble is how you get to it. */
  get impactDuration() {
    return Math.max(0.05, settings.photonlattice.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.photonlattice.fadeTime);
  }

  /**
   * A slow swell, not a flicker.
   *
   * The per-beam breath in the shader already carries whatever restlessness
   * this ability wants, and at `flickerSpeed` 1.25 Hz across forty-eight beams
   * with decorrelated phases it averages out to something very steady. The
   * dynamic light therefore gets one slow sine of its own rather than the base
   * class's two-sine glint, which would beat against the beams and read as a
   * loose connection.
   */
  lightShimmer() {
    const c = settings.photonlattice;
    return 1 + c.lightSway * Math.sin(this.age * c.lightSwaySpeed * TAU);
  }

  /* ------------------------------------------------------------------ */
  /* The frame — every metre resolved from live settings                  */
  /* ------------------------------------------------------------------ */

  /** Where the grid hangs. The circle the indicator drew is the promise. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /**
   * @param {number} fade     0..1 master
   * @param {number} assemble 0..1 how much of each beam is drawn
   * @param {number} locked   0..1 how much of the standing-grid behaviour is on
   */
  _sync(fade, assemble, locked) {
    const c = settings.photonlattice;
    const g = settings.global;
    const u = this.material.uniforms;

    this._centrePoint(_centre);
    u.uAnchor.value.copy(_centre);
    u.uAlong.value.copy(this.direction);
    u.uSide.value.copy(this.side);
    u.uUp.value.copy(_up);

    /* --- the grid --- */
    const gx = Math.max(1, Math.min(MAX_NODES, Math.round(c.gridX)));
    const gy = Math.max(1, Math.min(MAX_NODES, Math.round(c.gridY)));
    const gz = Math.max(1, Math.min(MAX_NODES, Math.round(c.gridZ)));
    u.uGrid.value.set(gx, gy, gz);

    // Across and downrange come off `zoneRadius`, because the circle the aim
    // indicator drew is the footprint the player was promised and a lattice
    // that overhangs it is a lattice that lands somewhere else. Height is its
    // own metre: a box is not a sphere and there is no honest way to derive one
    // from the other.
    const reach = Math.max(0.05, c.zoneRadius * c.latticeSpread);
    u.uSpan.value.set(reach, Math.max(0.05, c.latticeHeight), reach);
    u.uLift.value = c.latticeLift;
    u.uOverhang.value = Math.max(0, c.latticeOverhang);
    // `age` is a timestamp, not a dimension — capturing it is allowed and
    // resolving the *rate* against live settings every frame is what keeps the
    // spin live under a paused slider drag.
    u.uSpin.value = c.latticeSpin + this.age * c.latticeSpinSpeed;
    u.uSeed.value = this._seed;

    /* --- the beam --- */
    u.uRadius.value = Math.max(0.001, c.beamRadius);
    u.uHaloScale.value = Math.max(1, c.haloScale);
    u.uHullPad.value = Math.max(1.2, c.hullPad);
    u.uDensity.value = Math.max(0, c.density) * g.glow;
    u.uCoreGain.value = Math.max(0, c.coreGain);
    u.uHaloGain.value = Math.max(0, c.haloGain);
    u.uEndTaper.value = Math.max(0.001, c.endTaper);
    u.uEndTint.value = saturate(c.endTint);
    u.uIntensity.value = Math.max(0, c.intensity);

    u.uColorCore.value.copy(getColor(c.colorCore));
    u.uColorHalo.value.copy(getColor(c.colorHalo));
    u.uColorEnd.value.copy(getColor(c.colorEnd));

    /* --- the beats --- */
    u.uAssemble.value = saturate(assemble);
    u.uStagger.value = Math.max(0, Math.min(0.95, c.stagger));
    u.uFlicker.value = saturate(c.flicker) * g.turbulence;
    u.uFlickerSpeed.value = c.flickerSpeed * g.noiseSpeed;
    u.uFade.value = saturate(fade) * g.opacity;

    // The travelling band, and the only place the lattice looks *driven*. It is
    // held down to a third while the beams are still drawing in: a pulse racing
    // along a beam that is two thirds built has nowhere to go and reads as a
    // stutter.
    u.uPulse.value = Math.max(0, c.pulse) * lerp(0.33, 1, saturate(locked));
    u.uPulseWidth.value = Math.max(0.005, c.pulseWidth);
    const walk = this.age * c.pulseSpeed;
    u.uPulseAt.value = walk - Math.floor(walk);

    /* --- how many of them --- */
    this._live = Math.min(MAX_PHOTON_BEAMS, photonBeamCount(gx, gy, gz));
    this.geometry.instanceCount = this._live;
    this.mesh.visible = this._live > 0 && u.uFade.value > 0.0005;

    /* --- the motes --- */
    this.motes.setGradient(
      getColor(c.colorMoteA),
      getColor(c.colorMoteB),
      getColor(c.colorMoteC),
      getColor(c.colorMoteD)
    );
    this.motes.uniforms.uGravity.value.set(0, c.moteRise, 0);
    this.motes.uniforms.uSizeScale.value = c.moteSize * g.particleSize * 7;
    this.motes.uniforms.uLifeScale.value = c.moteLifetime * 0.5 * g.particleLifetime;
    // Metres per second lives on the uniform rather than on the emit, so
    // dragging `moteSpeed` with the clock stopped re-speeds the motes that are
    // already in the air instead of only the next ones out.
    this.motes.uniforms.uSpeedScale.value = c.moteSpeed * g.particleSpeed;
    this.motes.uniforms.uOpacity.value = g.opacity * fade;
    this.motes.uniforms.uGlow.value = c.intensity * 1.1 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;
  }

  /** Motes seeded through the box the lattice occupies. */
  _moteFx(dt, scale) {
    const c = settings.photonlattice;
    const g = settings.global;
    const count = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (count <= 0) return;

    this._centrePoint(_pos);
    _pos.y = c.latticeLift;

    _emit.position = _pos;
    // A ball, not a box — the corners of the lattice are the least interesting
    // part of it and seeding a cube puts a quarter of the motes outside every
    // beam. `moteSpread` scales it against the box's own half-extent.
    _emit.radius = Math.max(c.zoneRadius * c.latticeSpread, c.latticeHeight) * c.moteSpread;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 1; //  metres/second lives on uSpeedScale — see _sync()
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.7;
    _emit.life = c.moteLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(count, _emit);
  }

  /** The light hangs in the middle of the grid, which is where the light is. */
  _placeLight() {
    this._centrePoint(this.position);
    this.position.y = settings.photonlattice.latticeLift;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.photonlattice;
    const g = settings.global;

    this.moteEmitter.reset();
    this._seed = Math.random() * 100;

    this._sync(1, 0, 0);
    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this._placeLight();
  }

  onTravel(dt) {
    // The assemble front *is* the cast's progress. Nothing crosses the floor:
    // the beams draw further in the closer the cast gets to its point, which is
    // why `speed` here is a build rate wearing a travel speed's clothes.
    const assemble = Easing.outQuad(saturate(this.u));
    this._sync(1, assemble, 0);
    this._moteFx(dt, assemble * 0.5);
    this._placeLight();
  }

  onImpact() {
    const c = settings.photonlattice;
    const g = settings.global;

    this._centrePoint(_pos);

    // A thin ring on the floor and a flash, and nothing else. No burst shell:
    // a shell is a surface, this school's whole argument is that light is not
    // one, and a fireball under a lattice of beams would be the loudest thing
    // on screen for the wrong half-second. The ring is a decal, so it costs the
    // ability no draw call of its own.
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.shockRadius * g.explosionIntensity,
      life: c.shockLife,
      width: 0.04,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    this.ctx.shake.add(
      c.lockShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      24
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.lockFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  /**
   * @param {number} dt seconds
   * @param {number} t  0..1 through the lock, then 1..2 through the retract
   */
  onFade(dt, t) {
    const c = settings.photonlattice;
    const held = t <= 1;

    let assemble;
    let fade;
    if (held) {
      assemble = 1;
      fade = 1;
    } else {
      // The beams draw back into their own midpoints. Only the *extent* is
      // eased; the brightness comes off on a cubic so the last thing left is a
      // short bright stub at the centre of each beam rather than a whole
      // lattice dimmed to nothing. A lattice that only dims looks switched off.
      const gone = saturate(t - 1);
      assemble = lerp(1, 1 - saturate(c.retract), Easing.inOutQuad(gone));
      fade = 1 - Easing.inCubic(gone);
    }

    this._sync(fade, assemble, 1);
    this._moteFx(dt, fade * (held ? 1 : 0.35));
    this._placeLight();
  }

  onDestroy() {
    this._live = 0;
    this.geometry.instanceCount = 0;
    this.material.uniforms.uFade.value = 0;
    this.material.uniforms.uAssemble.value = 0;
    this.mesh.visible = false;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    super.dispose();
  }
}
