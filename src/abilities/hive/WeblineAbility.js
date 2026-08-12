import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { WebGraph, webGraphParams } from '../../vfx/Colony.js';
import { FilamentPaths, filamentLook, MAX_FILAMENT_ROLES } from '../../vfx/FilamentPaths.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, clamp, Easing } from '../../utils/math.js';

/**
 * Guy-lines the web can hang from. One `FilamentPaths` role each, because a
 * role carries one pair of anchors and these four go to four different places
 * on the floor. Four is also the ceiling on roles, which is the reason the
 * slider stops there rather than at some number chosen for taste.
 */
const MAX_GUYS = MAX_FILAMENT_ROLES;

/* --- module-scope scratch. Nothing below allocates during a cast (I3) --- */
const _web = webGraphParams();
const _look = filamentLook();
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _hub = new Vector3();
const _node = new Vector3();
const _anchor = new Vector3();
const _normal = new Vector3();
const _up = new Vector3(0, 1, 0);

/**
 * WEB LINE — a drag-line thrown down the lane, and an orb web spun across it.
 *
 * **THE TRICK — the membrane.** A web is not strands. It is strands *plus the
 * thin film between them*, and that film is the whole ability: it is invisible
 * head-on, because a film a fraction of a micron thick transmits almost
 * everything at normal incidence, and it flares at grazing angles where the
 * path through it lengthens and the Fresnel reflectance climbs. So the alpha on
 * a panel here has **no constant part at all** — it is a pure grazing term —
 * and its colour walks a four-stop gradient with the same angle, which is what
 * thin-film interference does with path length. Orbit the caster and panels of
 * the web appear and vanish one at a time. Stand square-on and the web is
 * thread and nothing else.
 *
 * The first version of this slot had `filmFill` at 1 with a small ambient floor
 * on the alpha, on the reasonable-sounding grounds that a film you cannot see
 * at all is a film nobody authored. It was a frosted disc. Every panel was lit
 * at once, so nothing flared against anything, and the effect stopped being a
 * web and started being a lampshade. `filmFill` now defaults to 0.76 and the
 * ambient floor is gone; the holes are what say the thing was built by
 * something and then walked through.
 *
 * **Sag is a fraction of a strand's own span**, not a fixed drop — a short
 * chord near the hub hangs almost straight while a two-metre outer chord
 * bellies, and that gradient is what the eye reads as tension. An absolute sag
 * in metres made the inner rings look slack and the whole disc read as
 * knitting.
 *
 * Four beats:
 *
 *   1. **pay out** — a drag-line of silk motes runs from the caster's hand to
 *      the hub point, at `speed`.
 *   2. **bite** — the line catches. Four guy-lines snap out to floor anchors as
 *      real catenaries (`vfx/FilamentPaths.js`, `LINK`), and the disc begins to
 *      spin: radials from the hub outward first, then the spiral from the rim
 *      inward, which is the order the animal works in. Film fills in behind the
 *      threads that bound it.
 *   3. **hang** — the web shivers from the catch (`snapSway`, decaying on
 *      `snapDecay`) and then breathes on `sway`. The shiver is worth the
 *      slider: it changes the grazing angle across the *whole* membrane at
 *      once, so the panels flash in sequence as the wave crosses them.
 *   4. **tear** — the film goes first and from the rim inward (`tearBias`), the
 *      threads go slack (`tearSlack`), the guys let go (`guyTaut` → 0) and the
 *      whole disc sinks by `tearDroop` on its way out.
 *
 * **The rule that makes the editor work.** A node in this web is the pair of
 * integers `(ring, spoke)` and nothing else — ring −1 is the hub, and it needs
 * no special case because every per-node jitter is multiplied by the radius
 * fraction, which is zero there. Every metre is a uniform. A cast captures one
 * number, `_seed`, plus the timestamps of the beats it has already fired. Pause
 * with **P** mid-spin and drag `radius`: the whole web re-spans, film included,
 * because the film is a Coons patch over the same four strand curves the strand
 * mesh draws and the two meshes hold the same uniform boxes by identity.
 *
 * Four draw calls: the strands, the film, and the guys' halo and core.
 */
export class WeblineAbility extends Ability {
  constructor(context) {
    super('webline', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * The web: two draw calls, the strands and the membrane.
     *
     * `samples: 12` rather than the default ten because the sag on an outer
     * chord at this radius is a genuine curve and ten segments show the chords
     * on it; `filmSubdiv: 2` because a Coons patch drawn as two flat triangles
     * cuts straight across its own belly and loses exactly the dish the grazing
     * term is looking for.
     */
    this.web = new WebGraph(this.group, {
      maxRings: 8,
      maxSpokes: 16,
      samples: 12,
      filmSubdiv: 2,
      renderOrder: 11
    });

    /**
     * The guy-lines. `LINK` is a real catenary rather than a parabola, and the
     * difference is all at the anchors, where a hanging thread leaves much
     * steeper — which is most of what says the far end is *pinned* rather than
     * merely ending there.
     */
    this.anchors = new FilamentPaths(this.group, {
      samples: 48,
      capacity: MAX_GUYS * 4,
      renderOrder: 12
    });

    /* --- what a cast captures: one dice roll and some timestamps --- */
    /** Decorrelates the node jitter, so two webs are not the same web. */
    this._seed = 0;
    /** One-way. A slider drag must not be able to re-fire a beat. */
    this._caught = false;
    this._torn = false;
    /** Metres of drag-line travel already paid out in motes. */
    this._dragDistance = 0;
    /** HUD readout only. */
    this._live = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Silk: the drag-line on the way out, then loose fibre lifting off the
    // finished web. Additive and soft, because what you are seeing is thread
    // too fine to resolve catching the key light rather than anything glowing.
    this.silk = particles.get('webline.silk', {
      capacity: 2200,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.silk.uniforms.uDrag.value = 1.7;
    this.silk.uniforms.uEndSize.value = 0.2;
    this.silk.uniforms.uSizeIn.value = 0.07;
    this.silk.uniforms.uFadeIn.value = 0.1;
    this.silk.uniforms.uFadeOut.value = 0.42;

    // Dust the web has already caught, shaken out of it. Non-additive so it
    // genuinely occludes the film behind it — dust that adds light reads as
    // more web, which is the opposite of the point.
    this.dust = particles.get('webline.dust', {
      capacity: 1400,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.dust.uniforms.uDrag.value = 2.1;
    this.dust.uniforms.uEndSize.value = 2.4;
    this.dust.uniforms.uSizeIn.value = 0.16;
    this.dust.uniforms.uFadeIn.value = 0.22;
    this.dust.uniforms.uFadeOut.value = 0.3;

    // Torn fibre. `LEAF` rather than `CHIP`: a broken thread curls, and the
    // tapered silhouette tumbling under a light gravity is the read. Lit, not
    // additive — the tear is the one moment the web stops being luminous.
    this.chaff = particles.get('webline.chaff', {
      capacity: 1200,
      shape: ParticleShape.LEAF,
      additive: false,
      lit: true,
      softFade: 0.3
    });
    this.chaff.uniforms.uDrag.value = 1.3;
    this.chaff.uniforms.uEndSize.value = 0.7;
    this.chaff.uniforms.uFadeIn.value = 0.06;
    this.chaff.uniforms.uFadeOut.value = 0.5;

    this.silkEmitter = new RateEmitter();
    this.dustEmitter = new RateEmitter();
    this.chaffEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing — every beat resolved from settings, every frame              */
  /* ------------------------------------------------------------------ */

  /** A beat's length in seconds, under the global lifetime knob. */
  _span(seconds) {
    return Math.max(0.01, seconds * settings.global.lifetime);
  }

  /** The impact phase holds the spin and the hang. Re-derived, never stored. */
  get impactDuration() {
    const c = settings.webline;
    return this._span(c.spinTime) + this._span(c.holdTime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.webline.fadeTime);
  }

  get instanceCount() {
    return this._live;
  }

  /**
   * Silk breathes; it does not gutter.
   *
   * The bolt's quantised stutter was the first thing tried here and it made the
   * web look electrified, which is a different school entirely. A slow cosine
   * reads as the light moving across a surface that is barely there.
   */
  lightShimmer() {
    const c = settings.webline;
    return 1 - saturate(c.lightPulse) * 0.5 * (1 - Math.cos(this.age * c.lightPulseSpeed));
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** Where the drag-line leaves the caster, in world space. */
  _handPoint(out) {
    const c = settings.webline;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /**
   * The hub, in world space.
   *
   * Held `hubShort` metres this side of the aim point so the web stands *in*
   * the lane rather than on top of whatever was aimed at — a web flush with its
   * target reads as a decal on it.
   */
  _hubPoint(out) {
    const c = settings.webline;
    this.pointAt(1, out).addScaledVector(this.direction, -c.hubShort);
    out.y = c.hubHeight;
    return out;
  }

  /** A point on the drag-line at `s` along it, 0..1. */
  _dragPoint(s, out) {
    const c = settings.webline;
    const t = saturate(s);
    out
      .copy(this.origin)
      .addScaledVector(this.direction, lerp(c.handForward, this.length - c.hubShort, t))
      .addScaledVector(this.side, c.handSide * (1 - t));
    out.y = lerp(c.handHeight, c.hubHeight, t);
    return out;
  }

  /**
   * The web's plane normal: the cast direction, tipped back by `lean`.
   *
   * A web hung exactly upright is the one orientation where the membrane is
   * least interesting, because the caster's own camera sits near its axis and
   * the grazing term is at its weakest everywhere at once. Tipping it a fifth
   * of a radian costs nothing and puts a band of flaring panels across the disc
   * from the first frame.
   */
  _webNormal(out) {
    const c = settings.webline;
    return out.copy(this.direction).multiplyScalar(Math.cos(c.lean)).setY(Math.sin(c.lean));
  }

  /** Seconds since the drag-line bit. Zero while it is still in the air. */
  _sinceCatch() {
    return this.phase === AbilityPhase.TRAVEL ? 0 : this.impactTime + this.fadeTime;
  }

  /** 0..1 — how much of the web has been spun. */
  _grow() {
    return saturate(this._sinceCatch() / this._span(settings.webline.spinTime));
  }

  /**
   * 0..1 — the shiver envelope after the catch.
   *
   * A decaying exponential of a *timestamp*, with the rate resolved from
   * settings, so dragging `snapDecay` on a paused frame re-shapes a shiver that
   * is already happening rather than leaving the old one running.
   */
  _shiver() {
    const c = settings.webline;
    if (!this._caught) return 0;
    return Math.exp(-this._sinceCatch() * Math.max(0.01, c.snapDecay));
  }

  /** Live rings and spokes, clamped exactly as `WebGraph` clamps them. */
  _ringCount() {
    return clamp(Math.round(settings.webline.rings), 1, this.web.maxRings);
  }

  _spokeCount() {
    return clamp(Math.round(settings.webline.spokes), 3, this.web.maxSpokes);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.silkEmitter.reset();
    this.dustEmitter.reset();
    this.chaffEmitter.reset();

    this._caught = false;
    this._torn = false;
    this._dragDistance = 0;

    // The only thing a cast captures. Unitless, and it only feeds hashes.
    this._seed = Math.random() * 100;
    this.web.roll(this._seed);

    this._sync(1, 0);
    this._castFx();
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve the web, its guys and the three particle systems from live
   * settings.
   *
   * Everything with a unit is read here, every frame, on a zero-length frame
   * included — and the web is synced whether or not it is drawn yet, because
   * syncing only what is visible is the tempting optimisation that breaks the
   * paused editor: drag `radius` while the web is still being carried out and
   * it must be that radius when it arrives.
   *
   * @param {number} fade 1 while the web hangs, ramping to 0 as it comes down
   * @param {number} tear 0..1 how far through letting go it is
   */
  _sync(fade, tear) {
    const c = settings.webline;
    const g = settings.global;
    const p = _web;

    const grow = this._grow();
    const shiver = this._shiver();
    // The film is gone by `tearFilm` of the way through the tear, well before
    // the threads are: a real web loses its sheets first and hangs on as a
    // frame, and reversing that order makes the whole thing read as a curtain.
    const filmGone = saturate(tear / Math.max(0.01, c.tearFilm));

    this._hubPoint(_hub);
    this._webNormal(_normal);

    /* ---------------- the graph ---------------- */
    p.rings = c.rings;
    p.spokes = c.spokes;
    p.radius = c.radius;
    p.squash = c.squash;
    p.ringCurve = c.ringCurve;
    p.ringJitter = c.ringJitter * g.randomness;
    p.spokeJitter = c.spokeJitter * g.randomness;
    p.twist = c.twist;
    // The disc sinks as it lets go. Added here rather than by moving the hub,
    // so the rim comes down and the hub does not — which is what a web tearing
    // off its anchors actually does.
    p.droop = c.droop + c.tearDroop * tear;
    p.depth = c.depth;

    /* ---------------- the strands ---------------- */
    p.slack = c.slack + c.tearSlack * tear;
    // One number carries both the breeze and the catch: the shiver is a wider,
    // faster version of the same standing wave, so the transition between them
    // is a lerp rather than a hand-off and nothing pops at the crossover.
    p.sway = (c.sway + c.snapSway * shiver) * g.turbulence;
    p.swayRate = lerp(c.swayRate, c.snapRate, shiver);
    p.strandWidth = c.strandWidth;
    p.widthJitter = c.widthJitter * g.randomness;
    p.chordWidth = c.chordWidth;
    p.strandOpacity = c.strandOpacity * fade * g.opacity;
    p.strandGlow = c.strandGlow * g.glow;
    p.silkPower = c.silkPower;
    p.silkGain = c.silkGain;
    p.coreBias = c.coreBias;
    p.strandColor = c.colorStrand;
    p.silkColor = c.colorSilk;

    /* ---------------- the membrane ---------------- */
    p.dish = c.dish;
    p.grazePower = c.grazePower;
    p.filmOpacity = c.filmOpacity * fade * g.opacity;
    p.filmBands = c.filmBands;
    p.filmShift = c.filmShift;
    p.filmSheen = c.filmSheen;
    p.filmSheenPower = c.filmSheenPower;
    p.filmFill = c.filmFill * (1 - filmGone);
    p.tearBias = c.tearBias;
    // The shiver flexes the whole sheet at once, so it flashes at once.
    p.filmGlow = c.filmGlow * g.glow * (1 + c.snapFlash * shiver);
    p.filmA = c.colorFilmA;
    p.filmB = c.colorFilmB;
    p.filmC = c.colorFilmC;
    p.filmD = c.colorFilmD;

    /* ---------------- the spinning ---------------- */
    p.grow = grow;
    p.growFeather = c.growFeather;
    p.orderScatter = c.orderScatter;

    this.web.setPlacement(_hub, _normal, _up);
    // The clock argument is ignored by design: the breeze runs on the shared
    // `uTime`, so a web four seconds old does not restart its sway on a re-cast.
    this.web.update(this.age, p);

    this._syncGuys(fade, tear, grow);
    this._syncParticles();

    this._live = this.web.count + this.anchors.liveCount;
  }

  /**
   * The guy-lines.
   *
   * One role per guy, because a role owns one pair of anchors and these go to
   * four different places. The **from** end is a real rim node read back out of
   * the web — not a point computed alongside it — so a guy stays attached
   * through every slider that moves the rim. The **to** end is that node's own
   * horizontal offset from the hub, pushed `guyReach` further out and dropped
   * to the floor, with alternate guys splayed fore and aft: unitless index
   * arithmetic on one side, live metres on the other.
   *
   * The first version anchored every guy at a bearing computed from `i / guys`
   * and a radius of its own. It looked almost right and was wrong in the way
   * that survives review: the anchors did not move when `squash` or `twist`
   * did, so the guys crossed their own rim at anything but the default.
   */
  _syncGuys(fade, tear, grow) {
    const c = settings.webline;
    const g = settings.global;

    const count = clamp(Math.round(c.guys), 0, MAX_GUYS);
    const threads = Math.max(1, Math.round(c.guyThreads));
    const rim = this._ringCount() - 1;
    const spokes = this._spokeCount();
    // The guys are the frame threads and a frame goes up first, so they are
    // drawn over the leading `guyLead` of the spin rather than alongside it.
    const drawn = saturate(grow / Math.max(0.05, c.guyLead));

    for (let i = 0; i < MAX_GUYS; i++) {
      const role = this.anchors.role(i);
      if (i >= count) {
        role.retire();
        continue;
      }

      const spoke = Math.round((spokes * (i + 0.5)) / count) % spokes;
      this.web.nodePoint(rim, spoke, _web, _node);

      // Where it is pinned. The node's own horizontal reach from the hub is
      // what decides how far out the anchor goes, so a squashed web pins its
      // anchors closer in — which is the behaviour anybody dragging `squash`
      // expects, and the reason this is not a bearing and a radius.
      _anchor.set(_node.x - _hub.x, 0, _node.z - _hub.z);
      _anchor.multiplyScalar(1 + c.guyReach).add(_node);
      // Alternate guys go fore and aft. `sign` is index parity — unitless.
      const sign = i % 2 === 0 ? 1 : -1;
      _anchor.addScaledVector(this.direction, c.guySplay * sign);
      _anchor.y = c.guyFloor;

      role.link(
        _node,
        _anchor,
        c.guySlack,
        c.guyCurve,
        c.guySwing * g.turbulence,
        c.guySwingSpeed,
        // Taut once the web is up, slack again as it lets go.
        c.guyTaut * grow * (1 - tear),
        c.guySpread
      );
      // Tapered at the rim end and square at the floor: a thread arriving at an
      // anchor does not fade out, it stops.
      role.style(1, 1, c.guyDim, 1).ends(1, 0, 1, 0).draw(drawn, 0.1, c.guyFloor, 0);
      role.count = threads;
    }

    _look.width = c.guyWidth;
    _look.glowWidth = c.guyGlowWidth;
    _look.glowOpacity = c.guyGlowOpacity;
    _look.jitter = c.guyJitter;
    _look.jitterScale = c.guyJitterScale;
    _look.octaves = c.guyOctaves;
    _look.jitterFalloff = c.guyJitterFalloff;
    _look.crawl = c.guyCrawl;
    _look.pinch = c.guyPinch;
    _look.restrike = c.guyRestrike;
    _look.flicker = c.guyFlicker;
    _look.flickerSpeed = c.guyFlickerSpeed;
    _look.strandFlash = c.guyStrandFlash;
    _look.coreSharp = c.guyCoreSharp;
    _look.glowFalloff = c.guyGlowFalloff;
    _look.softFade = c.guySoftFade;
    _look.opacity = c.guyOpacity;
    _look.glow = c.guyGlow;
    _look.colorCore = c.colorGuyCore;
    _look.colorInner = c.colorGuyInner;
    _look.colorOuter = c.colorGuyOuter;
    _look.colorHalo = c.colorGuyHalo;
    _look.randomness = g.randomness;
    _look.noiseStrength = g.noiseStrength;
    _look.noiseFrequency = g.noiseFrequency;
    _look.noiseSpeed = g.noiseSpeed;
    _look.opacityScale = g.opacity;
    _look.glowScale = g.glow;
    this.anchors.sync(_look, fade, this._seed);
    this.anchors.visible = count > 0 && drawn > 0.002 && fade > 0.002;
  }

  /** The three particle systems, re-coloured and re-scaled every frame. */
  _syncParticles() {
    const c = settings.webline;
    const g = settings.global;

    this.silk.setGradient(
      getColor(c.colorSilkA),
      getColor(c.colorSilkB),
      getColor(c.colorSilkC),
      getColor(c.colorSilkD)
    );
    this.silk.uniforms.uGravity.value.set(0, c.silkRise, 0);
    this.silk.uniforms.uSizeScale.value = c.silkSize * g.particleSize * 7;
    this.silk.uniforms.uLifeScale.value = c.silkLifetime * 0.5 * g.particleLifetime;
    this.silk.uniforms.uSpeedScale.value = g.particleSpeed;
    this.silk.uniforms.uOpacity.value = g.opacity;
    this.silk.uniforms.uGlow.value = 0.85 * g.glow;
    this.silk.uniforms.uTurbulence.value = c.silkTurbulence * g.turbulence;

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
    this.dust.uniforms.uTurbulence.value = 0.35 * g.turbulence;

    this.chaff.setGradient(
      getColor(c.colorChaffA),
      getColor(c.colorChaffB),
      getColor(c.colorChaffC),
      getColor(c.colorChaffD)
    );
    this.chaff.uniforms.uGravity.value.set(0, c.chaffGravity, 0);
    this.chaff.uniforms.uSizeScale.value = c.chaffSize * g.particleSize * 7;
    this.chaff.uniforms.uLifeScale.value = c.chaffLifetime * 0.5 * g.particleLifetime;
    this.chaff.uniforms.uSpeedScale.value = g.particleSpeed;
    this.chaff.uniforms.uOpacity.value = g.opacity;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** A small puff of silk at the hand as the line leaves it. */
  _castFx() {
    const c = settings.webline;
    const g = settings.global;

    this._handPoint(_pos);

    _emit.position = _pos;
    _emit.radius = 0.12;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.silkSpeed * 4;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.5;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.6;
    _emit.life = c.silkLifetime * 0.6;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.silk.emit(Math.round(18 * g.particleCount), _emit);

    this.lightBoost = c.lightIntensity * 0.25 * g.explosionIntensity;
  }

  /**
   * Motes paid out per *metre* of drag-line travel, so the line arrives at the
   * same density whether the web was thrown at five metres or at twenty. Keyed
   * off distance rather than off time for exactly that reason.
   */
  _dragFx() {
    const c = settings.webline;
    const step = 1 / Math.max(0.05, c.dragRate);
    const time = frame.uTime.value;

    while (this.front - this._dragDistance >= step) {
      this._dragDistance += step;
      this._dragPoint(saturate(this._dragDistance / this.length), _pos);

      _emit.position = _pos;
      _emit.radius = 0.06;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.silkSpeed * 0.4;
      _emit.speedVariance = 0.6;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.05;
      _emit.sizeVariance = 0.6;
      _emit.life = c.silkLifetime * 0.7;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.silk.emit(2, _emit);
    }
  }

  /**
   * What the standing web sheds.
   *
   * Every emitter picks a **real node** of the graph to fire from rather than a
   * point on a disc of the right radius. It costs one call and it means the
   * silk comes off the threads and the dust falls out of the panels, which
   * survives every slider that reshapes the web — including the ones that make
   * it an ellipse.
   *
   * @param {number} dt
   * @param {number} scale 0..1 — thinned as the web comes down
   * @param {number} tear  0..1 — no fibre comes off a web that is not tearing
   */
  _webFx(dt, scale, tear) {
    const c = settings.webline;
    const g = settings.global;
    const time = frame.uTime.value;
    const rings = this._ringCount();
    const spokes = this._spokeCount();

    const silkCount = Math.round(this.silkEmitter.tick(dt, c.silkRate * scale) * g.particleCount);
    if (silkCount > 0) {
      this.web.nodePoint(
        Math.floor(Math.random() * rings),
        Math.floor(Math.random() * spokes),
        _web,
        _pos
      );
      _emit.position = _pos;
      _emit.radius = c.radius * 0.12;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.silkSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.05;
      _emit.sizeVariance = 0.6;
      _emit.life = c.silkLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.silk.emit(silkCount, _emit);
    }

    const dustCount = Math.round(this.dustEmitter.tick(dt, c.dustRate * scale) * g.particleCount);
    if (dustCount > 0) {
      this.web.nodePoint(
        Math.floor(Math.random() * rings),
        Math.floor(Math.random() * spokes),
        _web,
        _pos
      );
      _emit.position = _pos;
      _emit.radius = c.radius * 0.25;
      // Down and slightly downrange: this is dirt letting go of a thread, not
      // smoke, and it has to fall or it reads as a haze round the web.
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.2).setY(-1).normalize();
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.8;
      _emit.size = 0.7;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.25;
      _emit.time = time;
      this.dust.emit(dustCount, _emit);
    }

    const chaffCount = Math.round(
      this.chaffEmitter.tick(dt, c.chaffRate * tear) * g.particleCount
    );
    if (chaffCount > 0) {
      this.web.nodePoint(
        Math.floor(Math.random() * rings),
        Math.floor(Math.random() * spokes),
        _web,
        _pos
      );
      _emit.position = _pos;
      _emit.radius = c.radius * 0.3;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.chaffSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 1.0;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.7;
      _emit.life = c.chaffLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 5;
      _emit.time = time;
      this.chaff.emit(chaffCount, _emit);
    }
  }

  /** The line bites: a puff of air, dust off the floor, and the shiver. */
  _catchFx() {
    const c = settings.webline;
    const g = settings.global;
    const time = frame.uTime.value;

    this._hubPoint(_hub);

    this.ctx.bursts.spawn(BurstMode.AIR, _hub, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.45,
      intensity: c.burstIntensity,
      opacity: 0.55,
      fresnel: 1.8,
      displace: 0.35,
      squash: 0.85,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    // On the floor under the hub, where the guys are about to be pinned.
    _pos.set(_hub.x, 0, _hub.z);
    this.ctx.decals.spawn(DecalType.DUSTRING, _pos, {
      radius: c.dustRingRadius * g.explosionIntensity,
      life: c.dustRingLife,
      intensity: c.dustRingIntensity,
      colorA: getColor(c.colorDustRingA),
      colorB: getColor(c.colorDustRingB)
    });

    _emit.position = _hub;
    _emit.radius = 0.25;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.3).setY(0.6).normalize();
    _emit.speed = c.silkSpeed * 3;
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.08;
    _emit.sizeVariance = 0.7;
    _emit.life = c.silkLifetime * 1.2;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.silk.emit(Math.round(30 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this.ctx.flash.trigger(getColor(c.colorCatchFlash), c.catchFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.7 * g.explosionIntensity;
  }

  /** The web lets go: one throw of fibre off the whole disc at once. */
  _tearFx() {
    const c = settings.webline;
    const g = settings.global;
    const time = frame.uTime.value;

    this._hubPoint(_hub);

    _emit.position = _hub;
    _emit.radius = c.radius * 0.75;
    _emit.direction = _dir.set(0, -1, 0);
    _emit.speed = c.chaffSpeed * 1.4;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.11;
    _emit.sizeVariance = 0.8;
    _emit.life = c.chaffLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = 7;
    _emit.tint = null;
    _emit.time = time;
    this.chaff.emit(Math.round(c.chaffTear * g.particleCount), _emit);

    _emit.radius = c.radius * 0.6;
    _emit.direction = _dir.set(0, -1, 0);
    _emit.speed = c.dustSpeed * 2.2;
    _emit.spread = 0.9;
    _emit.size = 0.9;
    _emit.life = c.dustLifetime;
    _emit.spin = 0.4;
    this.dust.emit(Math.round(28 * g.particleCount), _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1, 0);

    // The light rides the drag-line out to the hub.
    this._dragPoint(this.u, this.position);

    this._dragFx();
    this.ctx.shake.rumble(settings.webline.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    this._caught = true;
    this._catchFx();
    this._hubPoint(this.position);
  }

  onFade(dt, t) {
    // `t` runs 0..1 through the spin and the hang, then 1..2 as it comes down.
    const tear = saturate(t - 1);
    // Cubic, so the last threads hang on and then go rather than dimming evenly.
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(tear);

    if (!this._torn && tear > 0) {
      this._torn = true;
      this._tearFx();
    }

    this._sync(fade, tear);

    // The light sits at the hub and comes down with the disc.
    this._hubPoint(this.position);
    this.position.y -= settings.webline.tearDroop * tear * 0.5;

    this._webFx(dt, fade, tear);
  }

  onDestroy() {
    this._caught = false;
    this._torn = false;
    this._dragDistance = 0;
    this._live = 0;
    this.web.reset();
    this.anchors.clear();
    this.anchors.visible = false;
  }

  dispose() {
    this.web.dispose();
    this.anchors.dispose();
    super.dispose();
  }
}
