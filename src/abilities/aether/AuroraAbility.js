import { Vector3 } from 'three';
import { Ability } from '../Ability.js';
import { Curtain, CurtainMode, CurtainLayout, curtainParams } from '../../vfx/Curtain.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, Easing } from '../../utils/math.js';

/**
 * Hard ceiling on sheets. The editor's `veilCount` slider clamps here, and the
 * instanced buffer is allocated once at this size — `Curtain` places every copy
 * in its vertex shader, so twelve sheets and one sheet are the same draw call
 * and the same buffer.
 */
const MAX_SHEETS = 12;

/**
 * Quads *across* a sheet. This is the one geometry number that matters: the
 * travelling ripple is a vertex displacement along the sheet's length, so its
 * shortest resolvable wavelength is two of these. At 48 a four-metre crest on a
 * five-metre sheet is smooth; at the module's default of 32 the same crest has
 * visible facets on its shoulders once `rippleAmp` goes past about a metre.
 */
const SEGMENTS_X = 48;
/** Quads up a sheet. Cheaper — nothing displaces vertically except the lean. */
const SEGMENTS_Y = 20;

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ */
/* Scratch — module scope (I3)                                         */
/* ------------------------------------------------------------------ */

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _up = new Vector3(0, 1, 0);

/** Filled from `settings.aurora` every frame; never held between frames. */
const _veil = curtainParams();

/**
 * AURORA VEIL — sheets of light standing in the circle.
 *
 * **The trick is that two curves disagree.** A hanging ribbon and a curtain of
 * aurora are the same geometry. What separates them is that on cloth, coverage
 * and brightness die together — where the cloth thins it both stops hiding
 * things and stops being bright. Light in air does not: a column of excited gas
 * keeps radiating long after it has stopped occluding anything, which is why
 * the head of a real aurora is bright *and* transparent at once.
 *
 * So the alpha and the emission ride independent exponents up the sheet:
 *
 * ```
 * alpha    = mix(alphaTop,    alphaBase,    pow(1 - h, alphaCurve))
 * emission = mix(emissionTop, emissionBase, pow(1 - h, emissionCurve))
 * ```
 *
 * `settings.aurora.alphaCurve` and `settings.aurora.emissionCurve` are **both
 * sliders**, they are re-read every frame, and they are supposed to be
 * different numbers. `Curtain`'s own defaults are 2.4 against 0.7; this ability
 * ships 2.6 against 0.55, pushed further apart because the bloom chain here is
 * generous enough that the top of the sheet can be almost pure radiance over a
 * visible floor. Drag them together with the clock paused and the aurora turns
 * into a rag hanging on a line, in real time — which is the single most
 * convincing demonstration of the technique in the project.
 *
 * The second half of the read is `veilGraze`. A sheet has no thickness, so a
 * ray crossing it face-on passes through nothing while a ray crossing it edge-on
 * travels the length of a fold; both curves are therefore scaled by `1/|N·V|`,
 * clamped at `veilGrazeFloor`. That is two lines in the library and most of the
 * volume in the effect — and it only ever shows itself on a *folded* sheet seen
 * from a *moving* camera, which is why `veilLean`, `rippleAmp` and
 * `veilScatter` all ship well above zero.
 *
 * **Nothing in this ability hits anything.** There is no impact burst, no
 * shockwave, no screen flash, no camera shake and no decal; `onImpact()` is
 * empty on purpose and the floor companion's expanding-ring term — which is an
 * impact term — is held at zero. It is the only slot in the sandbox with no
 * violence in it and it should be a relief to cast.
 *
 * Three beats, all slow:
 *
 *  1. **rise** (travel) — `rise` follows the front out to the point, and
 *     `veilRiseSpread` staggers the sheets so the ring comes up as a wave
 *     rather than as a wall.
 *  2. **ripple** (impact, `lifetime` long) — it just stands there. Two folds at
 *     different wavelengths and speeds, a third of fbm slop, and a three-way
 *     hue band drifting along the sheets at 0.03 Hz.
 *  3. **fade** — the feet leave the floor and climb `fadeLift` metres while the
 *     substance drains out of the sheets. It does not sink and it does not
 *     blink out; it goes *up*, which is the only exit that does not read as the
 *     ability being switched off.
 *
 * Two draw calls: one instanced sheet mesh, one floor companion. The companion
 * walks the same `sheetFrame()` the sheets do, sharing the layout uniforms by
 * identity, so the coloured light on the floor cannot drift out from under the
 * sheet casting it.
 *
 * **The rule that makes the editor work.** A cast captures one dice roll per
 * sheet — nine unitless numbers apiece, rolled in `Curtain#roll()` and nowhere
 * else — and the phase clock. Not one metre. Pause with **P** mid-hold and drag
 * `veilSpread`: the ring re-lays itself around you with the clock stopped.
 */
export class AuroraAbility extends Ability {
  constructor(context) {
    super('aurora', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    // RING rather than LINE, because this is a far cast and the circle the
    // indicator drew is the promise: the sheets stand *on* that boundary and
    // you can walk into the middle of them. `layout` is a live uniform, though,
    // so `veilLayout` can put them in a rank or scatter them across the disc
    // without a recompile — that is the module's doing, not a special case.
    this.veil = new Curtain({
      capacity: MAX_SHEETS,
      segmentsX: SEGMENTS_X,
      segmentsY: SEGMENTS_Y,
      mode: CurtainMode.AURORA,
      layout: CurtainLayout.RING,
      floor: true,
      renderOrder: 9,
      name: 'Aurora:Veil'
    });
    this.group.add(this.veil.object3D);

    /** The one number a cast rolls for the layout as a whole. */
    this._seed = 0;
  }

  createParticles() {
    // One system, and a small one. The veil is already light in air; motes are
    // there to give the empty space between the sheets something to measure it
    // by, and a cloud of them would be doing the curtain's job badly.
    this.drift = this.ctx.particles.get('aurora.drift', {
      capacity: 260,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.7
    });
    this.drift.uniforms.uDrag.value = 1.2;
    this.drift.uniforms.uEndSize.value = 0.5;
    this.drift.uniforms.uSizeIn.value = 0.22;
    this.drift.uniforms.uFadeIn.value = 0.28;
    this.drift.uniforms.uFadeOut.value = 0.4;

    this.driftEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** Sheets drawn this frame. One draw call regardless. */
  get instanceCount() {
    return this.veil.instanceCount;
  }

  /** The hold is the ability. Everything else is getting into and out of it. */
  get impactDuration() {
    return Math.max(0.05, settings.aurora.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.aurora.fadeTime);
  }

  /**
   * A very slow swell.
   *
   * The base class's default shimmer beats at 9.3 Hz against 3.7 Hz, which is a
   * glint — right for ice and completely wrong here. One sine at
   * `lightSwaySpeed` (a fifth of a hertz by default) is the veil breathing, and
   * it is slow enough that you notice it only when you stop looking at it.
   */
  lightShimmer() {
    const c = settings.aurora;
    return 1 + c.lightSway * Math.sin(this.age * c.lightSwaySpeed * TAU);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.driftEmitter.reset();

    this._seed = Math.random() * 100;
    // `reset()` is the pooling contract — it zeroes the instance count and
    // hides the group — so the visibility has to come back on here, before the
    // first `update()`. Rolling after resetting, because the roll writes the
    // dice the very first frame reads.
    this.veil.reset();
    this.veil.roll(this._seed);
    this.veil.visible = true;

    this._sync(0, 0);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Re-resolve every metre in the curtain from live settings.
   *
   * @param {number} rise 0..1 how far the sheets have come up
   * @param {number} gone 0..1 how far through the climb-away they are
   */
  _sync(rise, gone) {
    const c = settings.aurora;
    const g = settings.global;

    this.pointAt(1, _centre);
    // `along` is the layout's local +X. For a ring it only decides where sheet
    // zero starts, but it has to be *something* stable, and the cast heading is
    // the only frame the player has any intuition about.
    this.veil.setPlacement(_centre, this.direction, _up);
    this.veil.layout = Math.round(c.veilLayout);

    /* --- the layout --- */
    _veil.count = Math.min(MAX_SHEETS, Math.round(c.veilCount));
    _veil.spacing = c.veilSpacing;
    _veil.radius = c.zoneRadius * c.veilSpread;
    _veil.scatter = c.veilScatter;
    _veil.seed = this._seed;

    /* --- the sheet --- */
    _veil.width = c.veilWidth;
    _veil.widthJitter = c.veilWidthJitter;
    _veil.height = c.veilHeight;
    _veil.heightJitter = c.veilHeightJitter;
    // The exit. The feet climb rather than the heads sinking, because a curtain
    // whose top edge comes down reads as a blind being drawn — the wrong idea
    // entirely for something that is supposed to be leaving the room.
    _veil.base = c.veilBase + c.fadeLift * gone;
    _veil.taper = c.veilTaper;
    _veil.lean = c.veilLean;
    _veil.leanJitter = c.veilLeanJitter;
    _veil.rise = rise;
    _veil.riseSpread = c.veilRiseSpread;

    /* --- the ripple. Metres per second, so global.noiseSpeed belongs here. --- */
    const speed = g.noiseSpeed;
    _veil.rippleAmp = c.rippleAmp * g.turbulence;
    _veil.rippleLength = c.rippleLength;
    _veil.rippleSpeed = c.rippleSpeed * speed;
    _veil.rippleCurve = c.rippleCurve;
    _veil.foldAmp = c.foldAmp * g.turbulence;
    _veil.foldLength = c.foldLength;
    _veil.foldSpeed = c.foldSpeed * speed;
    _veil.rippleNoise = c.rippleNoise * g.noiseStrength;
    _veil.rippleNoiseScale = c.rippleNoiseScale * g.noiseFrequency;
    _veil.rippleNoiseSpeed = c.rippleNoiseSpeed * speed;
    _veil.phaseSpread = c.phaseSpread;

    /* --- the two curves. Read the class header before touching these. --- */
    _veil.alphaBase = c.alphaBase;
    _veil.alphaTop = c.alphaTop;
    _veil.alphaCurve = c.alphaCurve;
    _veil.emissionBase = c.emissionBase;
    _veil.emissionTop = c.emissionTop;
    _veil.emissionCurve = c.emissionCurve;

    /* --- the envelope --- */
    // The substance drains before the light does, which is the same idea as the
    // two curves applied to the fade rather than to the height: a cloud of gas
    // stops blocking the floor well before it stops glowing.
    _veil.body = c.veilBody * (1 - Easing.inQuad(gone));
    _veil.footFade = c.veilFootFade;
    _veil.headFade = c.veilHeadFade;
    _veil.edgeFade = c.veilEdgeFade;
    _veil.graze = c.veilGraze;
    _veil.grazeFloor = c.veilGrazeFloor;
    _veil.softFade = c.veilSoftFade;
    _veil.opacity = c.veilOpacity * g.opacity * (1 - gone);
    _veil.glow = c.veilGlow * g.glow;
    _veil.tintSpread = c.veilTintSpread;

    /* --- the aurora --- */
    _veil.rayScale = c.rayScale * g.noiseFrequency;
    _veil.raySpeed = c.raySpeed * speed;
    _veil.raySharp = c.raySharp;
    _veil.bandScale = c.bandScale * g.noiseFrequency;
    _veil.bandSpeed = c.bandSpeed * speed;
    _veil.hem = c.hem;
    _veil.colorA = c.colorA;
    _veil.colorB = c.colorB;
    _veil.colorC = c.colorC;
    _veil.colorHem = c.colorHem;
    _veil.colorBody = c.colorBody;

    /* --- the wash on the floor --- */
    _veil.floorSize = c.zoneRadius * c.washSpread;
    _veil.floorFade = c.washFade;
    _veil.wet = c.washWet;
    _veil.wetDark = c.washDark;
    _veil.sheen = c.washSheen;
    _veil.sheenRough = c.washSheenRough * g.noiseFrequency;
    _veil.sheenSpeed = c.washSheenSpeed * speed;
    _veil.floorFresnel = c.washFresnel * g.fresnel;
    _veil.pool = c.washPool * rise;
    _veil.poolWidth = c.washPoolWidth;
    _veil.poolLength = c.washPoolLength;
    _veil.poolSoft = c.washPoolSoft;
    // Zero, and not a slider. The companion's ring term draws expanding impact
    // rings on a hashed lattice — it is an impact effect, and this ability does
    // not have an impact. Exposing it would be exposing a knob whose only
    // setting is "spoil the one thing the slot is for".
    _veil.rings = 0;
    _veil.floorOpacity = c.washOpacity * g.opacity * (1 - gone);
    _veil.colorWet = c.colorWash;
    _veil.colorPool = c.colorPool;
    _veil.colorRing = c.colorRing;

    // The clock argument is ignored — the sheets are driven by `frame.uTime`
    // inside the shader — but it is passed honestly rather than as a zero, so a
    // future version of the module that wants it gets the right number.
    this.veil.update(this.age, _veil);

    /* --- the motes --- */
    this.drift.setGradient(
      getColor(c.colorDriftA),
      getColor(c.colorDriftB),
      getColor(c.colorDriftC),
      getColor(c.colorDriftD)
    );
    this.drift.uniforms.uGravity.value.set(0, c.driftRise, 0);
    this.drift.uniforms.uSizeScale.value = c.driftSize * g.particleSize * 7;
    this.drift.uniforms.uLifeScale.value = c.driftLifetime * 0.5 * g.particleLifetime;
    // Metres per second lives on the uniform rather than on the emit, so that
    // dragging `driftSpeed` with the clock stopped re-speeds the motes that are
    // already drifting instead of only the next ones out.
    this.drift.uniforms.uSpeedScale.value = c.driftSpeed * g.particleSpeed;
    this.drift.uniforms.uOpacity.value = g.opacity;
    this.drift.uniforms.uGlow.value = c.veilGlow * g.glow;
    this.drift.uniforms.uTurbulence.value = c.driftTurbulence * g.turbulence;
  }

  /** Motes seeded through the volume the ring encloses. */
  _driftFx(dt, rise) {
    const c = settings.aurora;
    const g = settings.global;
    const count = Math.round(this.driftEmitter.tick(dt, c.driftRate * rise) * g.particleCount);
    if (count <= 0) return;

    this.pointAt(1, _centre);
    _pos.set(_centre.x, c.veilHeight * c.driftCeiling * 0.5, _centre.z);

    _emit.position = _pos;
    _emit.radius = c.zoneRadius * c.veilSpread * c.driftSpread;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 1; //  metres/second live on uSpeedScale — see _sync()
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.75;
    _emit.life = c.driftLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.drift.emit(count, _emit);
  }

  /** The light hangs over the ring rather than riding the floor under it. */
  _placeLight() {
    const c = settings.aurora;
    this.pointAt(1, this.position);
    this.position.y = c.lightHeight;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    // The rise front *is* the cast's progress. Nothing crosses the floor — the
    // sheets simply come up further the closer the cast gets to its point,
    // which is why `speed` here is a rise rate dressed as a travel speed and is
    // set slow enough to watch.
    const rise = saturate(this.u);
    this._sync(rise, 0);
    this._driftFx(dt, rise * 0.4);
    this._placeLight();
  }

  onImpact() {
    // Deliberately empty. No burst, no ring, no flash, no shake, no decal. The
    // veil finishes rising and that is the whole event; anything louder here
    // and this stops being the one slot you cast to calm down.
  }

  /**
   * @param {number} dt seconds
   * @param {number} t  0..1 through the hold, then 1..2 through the climb-away
   */
  onFade(dt, t) {
    const held = t <= 1;
    // Cubic out on the way away: the veil hangs on almost to the end and then
    // lets go quickly, which is how a light in air actually leaves — a linear
    // ramp reads as a dimmer being turned down by hand.
    const gone = held ? 0 : Easing.inCubic(saturate(t - 1));

    this._sync(1, gone);
    this._driftFx(dt, 1 - gone);
    this._placeLight();
  }

  onDestroy() {
    this.veil.reset();
  }

  dispose() {
    this.veil.dispose();
    super.dispose();
  }
}
