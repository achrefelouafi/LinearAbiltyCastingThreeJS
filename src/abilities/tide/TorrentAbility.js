import { Mesh, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { createDeflectionSheetMaterial } from '../../materials/DeflectionSheetMaterial.js';
import { createBeamTubeGeometry } from '../../assets/ProceduralGeometry.js';
import { Tube, TubePath } from '../../vfx/Tube.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;

/**
 * Tessellation of the sheet. `SHEET_RINGS` is out from the contact point and
 * `SHEET_BEARINGS` is around it — and the second one is the number that
 * matters, because the outline is a function of azimuth and 32 bearings puts a
 * visible polygon on the rim of a wide fan. 72 is where it stops showing.
 */
const SHEET_RINGS = 22;
const SHEET_BEARINGS = 72;

/**
 * How many bearings one frame's spray is split between.
 *
 * The first version drew a single bearing per frame for the whole batch, and a
 * fan emitted that way is a hose sweeping back and forth rather than a sheet
 * shedding along its whole edge. Five is enough that the rim reads as
 * continuous at any sane rate.
 */
const SPRAY_BATCHES = 5;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _mouth = new Vector3();
const _contact = new Vector3();
const _normal = new Vector3();
const _axis = new Vector3();
const _binormal = new Vector3();
const _reflect = new Vector3();
const _jet = new Vector3();
const _up = new Vector3(0, 1, 0);
const _ground = groundFieldParams();

/**
 * TORRENT — a cutting jet, and the sheet it throws when it lands.
 *
 * ## THE TRICK — deflection
 *
 * The spray knows which way the surface is facing.
 *
 * A jet arriving at a plane does not splash radially. It splits, and the split
 * is decided by one vector identity: reflect the jet's direction about the
 * surface normal, `r = d − 2(d·n)n`, and notice that the reflection leaves the
 * component **in** the surface untouched and reverses the component **along the
 * normal**. So
 *
 *  - the in-plane part of `r` is the axis the sheet runs down, and
 *  - the reversed normal part is the only thing that can lift a crown.
 *
 * The flux is then spread around the azimuth by the Poisson kernel — the
 * unique distribution on a circle that conserves mass and in-plane momentum and
 * contains nothing else — and `materials/DeflectionSheetMaterial.js` derives it
 * properly. The sheet draws that density; the droplets are drawn from it by its
 * exact inverse CDF, because the Poisson kernel *is* the wrapped Cauchy and a
 * wrapped Cauchy can be sampled in one line with no rejection loop. One uniform
 * random number in, one correctly-distributed bearing out.
 *
 * That the two agree is not a coincidence to be maintained by hand — they are
 * the same three lines of algebra read from opposite ends, which is why
 * dragging `surfaceTilt` swings the sheet, the crown and every droplet
 * together.
 *
 * ## Why the contact point walks
 *
 * The cast is a LINE, so the jet's contact point travels down it. That is not
 * decoration: as the contact walks away from the caster the incidence angle
 * goes from steep to grazing, so **you watch the fan narrow and lie down** over
 * the length of one cast. It is the clearest demonstration of the trick the
 * ability can give without anybody touching a slider, and it is free — the only
 * thing the CPU does is aim the tube at `pointAt(u)` instead of `pointAt(1)`.
 *
 * ## What is drawing
 *
 * `vfx/Tube.js` on the `STRAIGHT` path is the column (3 draw calls); one
 * instanced-free `(s, φ)` grid carries the sheet (1); `vfx/GroundField.js` in
 * `WET` mode is the soak (1). Five for the cast.
 *
 * ## What a cast captures
 *
 * One seed and the timestamps. Not the normal, not the reflection, not the
 * concentration, not a metre of reach — the whole surface frame is rebuilt from
 * `settings.torrent` every frame, on a zero-length frame included, which is the
 * only reason a paused `surfaceRoll` drag does anything at all.
 */
export class TorrentAbility extends Ability {
  constructor(context) {
    super('torrent', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the column --- */
    this.jet = new Tube({ path: TubePath.STRAIGHT, prefix: 'jet', nodes: 72, sides: 22 });
    this.group.add(this.jet.group);

    /* --- the sheet --- */
    // The beam tube's (t, a) grid, reinterpreted: t is distance out from the
    // contact point as a fraction of that bearing's own reach, a is the bearing.
    // Reusing it rather than building a fan on the CPU is not tidiness — the
    // outline moves every frame as the fan swings, and a CPU fan would be a
    // buffer upload per frame and a captured metre besides.
    this.sheetGeometry = createBeamTubeGeometry(SHEET_RINGS, SHEET_BEARINGS);
    this.sheetMaterial = createDeflectionSheetMaterial();
    this.sheetMesh = new Mesh(this.sheetGeometry, this.sheetMaterial);
    this.sheetMesh.frustumCulled = false;
    this.sheetMesh.matrixAutoUpdate = false;
    this.sheetMesh.layers.set(LAYER.VFX);
    this.sheetMesh.renderOrder = 9;
    this.group.add(this.sheetMesh);

    /* --- the stone it is soaking --- */
    this.wet = new GroundField(this.group, {
      mode: GroundMode.WET,
      depthTest: true,
      name: 'torrent.wet'
    });

    /** Re-rolled per cast. */
    this._seed = 0;
    /** Metres of contact-point travel already paid out in foam marks. */
    this._markDistance = 0;
    /** Seconds since the jet first touched down. Re-derived, never integrated. */
    this._contactAge = 0;
    /** The in-plane momentum fraction this frame, 0..0.985. Readout for the fx. */
    this._k = 0;
    /** The reversed normal momentum this frame, 0..1. */
    this._crown = 0;

    this._tubeState = {
      origin: new Vector3(),
      target: new Vector3(),
      side: new Vector3(),
      progress: 1,
      fade: 1,
      widthFade: 1,
      seed: 0,
      time: 0
    };
    this._sheetState = {
      contact: new Vector3(),
      normal: new Vector3(0, 1, 0),
      axis: new Vector3(0, 0, 1),
      binormal: new Vector3(1, 0, 0),
      k: 0,
      crown: 0,
      open: 0,
      age: 0,
      seed: 0,
      fade: 1
    };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Spray: velocity-stretched streaks. Lit rather than additive — water is
    // not a light source, and the moment the spray glows the jet reads as a
    // plasma cutter, which is a different and much more common effect.
    this.spray = particles.get('torrent.spray', {
      capacity: 4000,
      shape: ParticleShape.STREAK,
      additive: false,
      lit: true,
      stretch: true,
      softFade: 0.2
    });
    this.spray.uniforms.uDrag.value = 1.9;
    this.spray.uniforms.uEndSize.value = 0.4;
    this.spray.uniforms.uSizeIn.value = 0.02;
    this.spray.uniforms.uFadeIn.value = 0.03;
    this.spray.uniforms.uFadeOut.value = 0.45;

    // The heavy drops that survive the rim and arc away.
    this.drops = particles.get('torrent.drops', {
      capacity: 1600,
      shape: ParticleShape.SOFT,
      additive: false,
      lit: true,
      softFade: 0.2
    });
    this.drops.uniforms.uDrag.value = 0.6;
    this.drops.uniforms.uEndSize.value = 0.7;
    this.drops.uniforms.uSizeIn.value = 0.05;
    this.drops.uniforms.uFadeOut.value = 0.55;

    // The atomised haze standing over the contact point.
    this.mist = particles.get('torrent.mist', {
      capacity: 1800,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.9
    });
    this.mist.uniforms.uDrag.value = 2.6;
    this.mist.uniforms.uEndSize.value = 2.4;
    this.mist.uniforms.uSizeIn.value = 0.1;
    this.mist.uniforms.uFadeIn.value = 0.14;
    this.mist.uniforms.uFadeOut.value = 0.35;

    this.sprayEmitter = new RateEmitter();
    this.dropEmitter = new RateEmitter();
    this.mistEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get impactDuration() {
    return Math.max(0.05, settings.torrent.holdTime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.torrent.fadeTime);
  }

  get instanceCount() {
    // Three tube layers plus the sheet, when the sheet is up.
    return this.jet.drawCalls + (this._contactAge > 0 ? 1 : 0);
  }

  /**
   * A pressure hum rather than a flicker: a pump does not gutter. Two
   * incommensurate rates so it never settles into a visible beat.
   */
  lightShimmer() {
    const c = settings.torrent;
    return 0.88 + 0.12 * Math.sin(this.age * c.jetThrobSpeed * TAU) * Math.sin(this.age * 3.1);
  }

  /* ------------------------------------------------------------------ */
  /* The surface frame — rebuilt every frame, captured never              */
  /* ------------------------------------------------------------------ */

  /** Where the jet leaves the caster, world space. */
  _mouthPoint(out) {
    const c = settings.torrent;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** Where the column is currently landing, on the floor. */
  _contactPoint(out) {
    const s = this.phase === AbilityPhase.TRAVEL ? Math.max(0.04, this.u) : 1;
    this.pointAt(s, out);
    out.y = settings.torrent.surfaceHeight;
    return out;
  }

  /**
   * The impact surface's unit normal.
   *
   * Tilted off vertical by `surfaceTilt` in the bearing `surfaceRoll`, measured
   * in the cast's own flat frame so the two sliders mean the same thing however
   * the player is facing. Default is dead vertical, i.e. the floor — the whole
   * point of the sliders is to be able to *move* it and watch everything else
   * answer.
   */
  _surfaceNormal(out) {
    const c = settings.torrent;
    const tilt = c.surfaceTilt;
    const roll = c.surfaceRoll;
    const lean = Math.sin(tilt);
    out
      .copy(_up)
      .multiplyScalar(Math.cos(tilt))
      .addScaledVector(this.direction, lean * Math.cos(roll))
      .addScaledVector(this.side, lean * Math.sin(roll));
    return out.normalize();
  }

  /**
   * Build the whole deflection frame into the module scratch.
   *
   * Writes `_contact`, `_normal`, `_axis`, `_binormal`, `_k` and `_crown`, and
   * this is the one place in the ability where the trick actually happens:
   *
   * ```
   *   r = d − 2(d·n)n
   *   axis  = normalise(r − (r·n)n)      // in-plane: the fan's heading
   *   crown = |r·n|                       // reversed normal: the bell's height
   *   k     = |d − (d·n)n| · concentration
   * ```
   *
   * Two degenerate cases have to be handled or the fan NaNs the frame it is
   * pointed straight down. If the jet is normal to the surface the in-plane
   * component is zero and the axis is undefined — it falls back to the cast's
   * own heading, and `k = 0` makes the choice irrelevant because the
   * distribution is uniform there anyway, which is correct: a jet straight down
   * really does splash in a ring.
   */
  _frame() {
    const c = settings.torrent;

    this._mouthPoint(_mouth);
    this._contactPoint(_contact);
    this._surfaceNormal(_normal);

    _jet.copy(_contact).sub(_mouth);
    if (_jet.lengthSq() < 1e-8) _jet.copy(this.direction);
    _jet.normalize();

    const along = _jet.dot(_normal);
    // The reflection. Everything below is one of its two halves.
    _reflect.copy(_jet).addScaledVector(_normal, -2 * along);

    // In-plane part of the reflection. (It is also the in-plane part of the
    // incoming jet — the reflection does not touch it — which is exactly the
    // statement that the sheet carries on the way the jet was going.)
    _axis.copy(_reflect).addScaledVector(_normal, -_reflect.dot(_normal));
    const inPlane = _axis.length();
    if (inPlane < 1e-4) {
      // Straight down the normal: no preferred bearing exists. Any in-plane
      // vector will do, and k is about to be zero anyway.
      _axis.copy(this.direction).addScaledVector(_normal, -this.direction.dot(_normal));
      if (_axis.lengthSq() < 1e-8) _axis.copy(this.side);
    }
    _axis.normalize();
    _binormal.crossVectors(_normal, _axis).normalize();

    this._k = Math.min(0.985, Math.max(0, inPlane * saturate(c.fanConcentration)));
    this._crown = Math.abs(along);
  }

  /**
   * A bearing drawn from the fan, in radians from the axis.
   *
   * The exact inverse CDF of the wrapped Cauchy — which is the same function
   * the sheet's vertex shader is drawing as a density. One uniform in, one
   * correctly-distributed bearing out, no rejection loop, no table, and no
   * possibility of the particles and the mesh disagreeing about where the water
   * went.
   *
   * @param {number} u uniform 0..1
   */
  _fanBearing(u) {
    const k = this._k;
    if (k < 1e-4) return (u - 0.5) * TAU; //  uniform: a ring, and correctly so
    return 2 * Math.atan(((1 - k) / (1 + k)) * Math.tan(Math.PI * (u - 0.5)));
  }

  /**
   * The mean reach of the fan, metres. The sheet's own outline is this times
   * the density raised to `fanPower`; this is the number everything else is
   * placed against so nothing can drift from the mesh.
   */
  _fanReach() {
    return Math.max(0.05, settings.torrent.fanReach);
  }

  /** Reach along one bearing, metres — the same expression the shader uses. */
  _reachAt(phi) {
    const c = settings.torrent;
    const k = this._k;
    const q = (1 - k * k) / Math.max(1 + k * k - 2 * k * Math.cos(phi), 1e-4);
    return this._fanReach() * Math.pow(Math.max(q, 1e-4), c.fanPower);
  }

  /**
   * A launch direction for one droplet: in the surface plane at `phi`, plus
   * whatever fraction of the reversed normal momentum `sprayLift` lets it keep.
   *
   * `sprayLift` at 0 puts the whole spray on the deck, which is the wall-jet
   * answer; at 1 it is a specular reflection, which is what a jet does off
   * glass. Neither extreme is right for stone and the slider is between them.
   */
  _fanDirection(phi, out) {
    const c = settings.torrent;
    out
      .copy(_axis)
      .multiplyScalar(Math.cos(phi))
      .addScaledVector(_binormal, Math.sin(phi))
      .addScaledVector(_normal, this._crown * saturate(c.sprayLift));
    return out.normalize();
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.sprayEmitter.reset();
    this.dropEmitter.reset();
    this.mistEmitter.reset();
    this._markDistance = 0;
    this._contactAge = 0;

    // The one thing a cast captures, and it is unitless.
    this._seed = Math.random() * 100;

    this.jet.visible = true;
    this.wet.setVisible(true);
    this._sync(1, 1);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current surface frame into all three
   * renderers.
   *
   * @param {number} fade      0..1 master alpha
   * @param {number} widthFade 0..1 the column's collapse to a thread
   */
  _sync(fade, widthFade) {
    const c = settings.torrent;
    const g = settings.global;

    this._frame();

    /* --- the column --- */
    const state = this._tubeState;
    state.origin.copy(_mouth);
    state.target.copy(_contact);
    state.side.copy(this.side);
    // A jet is not a bolt: the whole column exists from the first frame,
    // because the water is already leaving the nozzle. What travels is where it
    // *lands*, and that is carried by `target`.
    state.progress = 1;
    state.fade = fade;
    state.widthFade = widthFade;
    state.seed = this._seed;
    state.time = this.age;
    this.jet.sync(c, state, g);

    /* --- the sheet --- */
    const sheet = this._sheetState;
    sheet.contact.copy(_contact);
    sheet.normal.copy(_normal);
    sheet.axis.copy(_axis);
    sheet.binormal.copy(_binormal);
    sheet.k = this._k;
    sheet.crown = this._crown;
    sheet.open = saturate(this._contactAge / Math.max(0.01, c.openTime)) * widthFade;
    sheet.age = this.age;
    sheet.seed = this._seed;
    sheet.fade = fade;
    this.sheetMaterial.userData.sync(sheet);

    /* --- the wet stone --- */
    // Centred downstream along the fan axis rather than on the contact point:
    // water soaks into stone the same way in every direction, so the *shape*
    // stays a disc, but where the disc sits is not arbitrary — it sits where
    // the water actually went.
    const reach = this._fanReach();
    _pos.copy(_contact).addScaledVector(_axis, reach * c.wetBias);
    _pos.y = 0;
    _ground.centre = _pos;
    _ground.yaw = Math.atan2(_axis.x, _axis.z);
    _ground.height = c.wetHeight;
    _ground.radius = Math.max(0.05, reach * c.wetRadius);
    _ground.grow = saturate(this._contactAge / Math.max(0.02, c.wetGrow));
    _ground.recede = this.phase === AbilityPhase.FADE
      ? saturate(this.fadeTime / this.fadeDuration) * saturate(c.wetDry)
      : 0;
    _ground.fade = fade;
    _ground.seed = this._seed;
    _ground.edge = c.wetEdge;
    _ground.ragged = c.wetRagged;
    _ground.raggedScale = c.wetRaggedScale * g.noiseFrequency;
    _ground.warp = c.wetWarp * g.noiseStrength;
    _ground.relief = c.wetRelief;
    _ground.normalStep = c.wetNormalStep;
    _ground.ambient = c.wetAmbient;
    _ground.wrap = c.wetWrap;
    _ground.specular = c.wetSpecular;
    _ground.gloss = c.wetGloss;
    _ground.cell = c.wetCell * g.noiseFrequency;
    _ground.depth = c.wetDepth;
    _ground.lift = c.wetLift;
    _ground.detail = c.wetDetail;
    _ground.flow = c.wetFlow;
    _ground.speed = c.wetSpeed * g.noiseSpeed;
    _ground.windAngle = 0;
    _ground.emissive = c.wetEmissive;
    _ground.opacity = c.wetOpacity;
    _ground.opacityScale = g.opacity;
    _ground.noiseStrength = g.noiseStrength;
    _ground.noiseFrequency = g.noiseFrequency;
    _ground.noiseSpeed = g.noiseSpeed;
    _ground.colorBase = c.colorWetBase;
    _ground.colorEdge = c.colorWetEdge;
    _ground.colorGlow = c.colorWetGlow;
    _ground.colorDeep = c.colorWetDeep;
    this.wet.update(_ground);

    /* --- the three particle systems --- */
    this.spray.setGradient(
      getColor(c.colorSprayA),
      getColor(c.colorSprayB),
      getColor(c.colorSprayC),
      getColor(c.colorSprayD)
    );
    this.spray.uniforms.uGravity.value.set(0, c.sprayGravity, 0);
    this.spray.uniforms.uSizeScale.value = c.spraySize * g.particleSize * 7;
    this.spray.uniforms.uLifeScale.value = c.sprayLifetime * 0.5 * g.particleLifetime;
    this.spray.uniforms.uSpeedScale.value = g.particleSpeed;
    this.spray.uniforms.uOpacity.value = g.opacity;
    this.spray.uniforms.uStretch.value = c.sprayStretch;
    this.spray.uniforms.uTurbulence.value = 0.2 * g.turbulence;

    this.drops.setGradient(
      getColor(c.colorDropA),
      getColor(c.colorDropB),
      getColor(c.colorDropC),
      getColor(c.colorDropD)
    );
    this.drops.uniforms.uGravity.value.set(0, c.dropGravity, 0);
    this.drops.uniforms.uSizeScale.value = c.dropSize * g.particleSize * 7;
    this.drops.uniforms.uLifeScale.value = c.dropLifetime * 0.5 * g.particleLifetime;
    this.drops.uniforms.uSpeedScale.value = g.particleSpeed;
    this.drops.uniforms.uOpacity.value = g.opacity;

    this.mist.setGradient(
      getColor(c.colorMistA),
      getColor(c.colorMistB),
      getColor(c.colorMistC),
      getColor(c.colorMistD)
    );
    this.mist.uniforms.uGravity.value.set(0, c.mistRise, 0);
    this.mist.uniforms.uSizeScale.value = c.mistSize * g.particleSize;
    this.mist.uniforms.uLifeScale.value = c.mistLifetime * 0.5 * g.particleLifetime;
    this.mist.uniforms.uSpeedScale.value = c.mistSpeed * g.particleSpeed;
    this.mist.uniforms.uOpacity.value = c.mistOpacity * g.opacity;
    this.mist.uniforms.uTurbulence.value = 0.35 * g.turbulence;
  }

  /* ------------------------------------------------------------------ */
  /* What comes off the sheet                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Spray, drops and mist, all emitted **into the fan**.
   *
   * Every bearing here comes out of `_fanBearing()`, which is the sheet's own
   * density inverted, so the particle field and the mesh are the same
   * distribution. Placing them on the rim rather than at the contact point
   * matters as much: a sheet sheds from its unstable edge, and spraying from
   * the middle puts the droplets *inside* the water they are supposed to be
   * leaving.
   *
   * @param {number} scale 0..1 — thinned as the pressure drops
   */
  _fanFx(dt, scale) {
    const c = settings.torrent;
    const g = settings.global;
    const time = frame.uTime.value;

    let sprayCount = Math.round(this.sprayEmitter.tick(dt, c.sprayRate * scale) * g.particleCount);
    if (sprayCount > 0) {
      _emit.speed = c.spraySpeed;
      _emit.speedVariance = c.spraySpeedVariance;
      _emit.spread = 0.18;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.65;
      _emit.life = c.sprayLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      const batches = Math.min(sprayCount, SPRAY_BATCHES);
      const per = Math.ceil(sprayCount / batches);
      while (sprayCount > 0) {
        const phi = this._fanBearing(Math.random()) + randRange(-c.sprayJitter, c.sprayJitter);
        // Somewhere along that bearing, biased outward — the sheet is thinnest
        // and least stable near the rim, which is where it comes apart.
        const along = Math.sqrt(Math.random());
        this._fanDirection(phi, _dir);
        _pos
          .copy(_contact)
          .addScaledVector(_axis, Math.cos(phi) * this._reachAt(phi) * along)
          .addScaledVector(_binormal, Math.sin(phi) * this._reachAt(phi) * along);
        _emit.position = _pos;
        _emit.radius = 0.06;
        _emit.direction = _dir;
        this.spray.emit(Math.min(per, sprayCount), _emit);
        sprayCount -= per;
      }
    }

    const dropCount = Math.round(this.dropEmitter.tick(dt, c.dropRate * scale) * g.particleCount);
    if (dropCount > 0) {
      const phi = this._fanBearing(Math.random());
      const reach = this._reachAt(phi);
      this._fanDirection(phi, _dir);
      _pos
        .copy(_contact)
        .addScaledVector(_axis, Math.cos(phi) * reach)
        .addScaledVector(_binormal, Math.sin(phi) * reach);
      _emit.position = _pos;
      _emit.radius = 0.12;
      _emit.direction = _dir;
      _emit.speed = c.dropSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.3;
      _emit.size = 0.16;
      _emit.sizeVariance = 0.7;
      _emit.life = c.dropLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.drops.emit(dropCount, _emit);
    }

    const mistCount = Math.round(this.mistEmitter.tick(dt, c.mistRate * scale) * g.particleCount);
    if (mistCount > 0) {
      // The haze does not care which way it was thrown — it is what is left
      // after the droplets have lost their momentum, so it stands over the
      // contact point and rises.
      _emit.position = _pos.copy(_contact).addScaledVector(_axis, this._fanReach() * 0.35);
      _emit.radius = this._fanReach() * 0.5;
      _emit.direction = _dir.copy(_normal);
      _emit.speed = c.mistSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = 0.9;
      _emit.size = 0.6;
      _emit.sizeVariance = 0.55;
      _emit.life = c.mistLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0.25;
      _emit.time = time;
      this.mist.emit(mistCount, _emit);
    }
  }

  /**
   * Foam left on the stone, paid out per metre of contact travel rather than
   * per second, so the trail stays evenly spaced whether the jet is walking out
   * in a fifth of a second or crawling.
   */
  _markFx() {
    const c = settings.torrent;
    const step = 1 / Math.max(0.05, c.foamRate);
    let guard = 24;

    while (this.front - this._markDistance >= step && guard-- > 0) {
      this._markDistance += step;
      const s = saturate(this._markDistance / this.length);
      this.pointAt(s, _pos);
      // Offset downstream along the fan, and jittered across it, so the trail
      // is the wash rather than a dotted centre line.
      _pos.addScaledVector(_axis, this._fanReach() * randRange(0.1, 0.6));
      _pos.addScaledVector(_binormal, randRange(-0.5, 0.5) * this._fanReach() * 0.35);

      this.ctx.decals.spawn(DecalType.FOAM, _pos, {
        radius: c.foamRadius * randRange(0.7, 1.35),
        life: c.foamLife,
        intensity: c.foamIntensity,
        colorA: getColor(c.colorFoamA),
        colorB: getColor(c.colorFoamB)
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.torrent;

    // The contact age is the age, because the jet is touching down from the
    // first frame — it is where it touches that travels.
    this._contactAge = this.age;
    this._sync(1, 1);

    // The dynamic light rides the contact point, not the front on the floor:
    // the fan is what is lit.
    this.position.copy(_contact);

    this._fanFx(dt, 1);
    this._markFx();
    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.torrent;
    const g = settings.global;
    const time = frame.uTime.value;

    this._frame();

    this.ctx.bursts.spawn(BurstMode.WATER, _contact, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.5,
      intensity: c.burstIntensity,
      opacity: 0.85,
      fresnel: 2.2,
      displace: 0.45,
      squash: 0.6,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    // A hard slug of spray, still into the fan and not around it.
    _emit.speed = c.spraySpeed * 1.6;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.22;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.13;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sprayLifetime * 1.3;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    for (let i = 0; i < SPRAY_BATCHES; i++) {
      const phi = this._fanBearing(Math.random());
      const reach = this._reachAt(phi) * 0.6;
      this._fanDirection(phi, _dir);
      _pos
        .copy(_contact)
        .addScaledVector(_axis, Math.cos(phi) * reach)
        .addScaledVector(_binormal, Math.sin(phi) * reach);
      _emit.position = _pos;
      _emit.radius = 0.08;
      _emit.direction = _dir;
      this.spray.emit(Math.round((c.sprayRate * 0.12) * g.particleCount), _emit);
    }

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity,
      1 / Math.max(0.05, c.shakeDuration),
      22
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.9 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.torrent;

    this._contactAge = this.age;

    // `t` runs 0..1 while the jet holds at full pressure, then 1..2 as the pump
    // dies. The column collapses to a thread before it dims — a jet that fades
    // evenly reads as a light being turned down, and a jet that necks first
    // reads as pressure being lost, which is the thing that is happening.
    const dying = saturate(t - 1);
    const width = 1 - dying * dying;
    const fade = 1 - dying * dying * dying;

    this._sync(fade, width);
    this.position.copy(_contact);

    this._fanFx(dt, fade * width);
    this.ctx.shake.rumble(c.rumble * fade * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this.jet.visible = false;
    this.wet.setVisible(false);
    this._contactAge = 0;
    this._markDistance = 0;
    this._k = 0;
    this._crown = 0;
    this.sheetMaterial.uniforms.uOpen.value = 0;
  }

  dispose() {
    this.jet.dispose();
    this.wet.dispose();
    this.sheetGeometry.dispose();
    this.sheetMaterial.dispose();
    super.dispose();
  }
}
