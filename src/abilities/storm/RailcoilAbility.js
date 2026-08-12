import { Vector3 } from 'three';
import { Ability } from '../Ability.js';
import { Tube, TubePath } from '../../vfx/Tube.js';
import { FilamentPaths } from '../../vfx/FilamentPaths.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, hash11, Easing, randRange } from '../../utils/math.js';

/** Samples along one filament. A 26 m segment at 80 nodes is a node every 32 cm. */
const FILAMENT_SAMPLES = 80;
/** Ceiling on filaments across all four roles. 4 coils × 3 + 4 ring-down = 16 at worst. */
const FILAMENT_CAPACITY = 40;
/** Role 0 is the coil that survives the shot; roles 1..3 are channel segments. */
const RINGDOWN_ROLE = 0;
/** How many roles are left for the break-up. `segments` clamps against this. */
const MAX_SEGMENTS = 3;

const _pos = new Vector3();
const _dir = new Vector3();
const _from = new Vector3();
const _to = new Vector3();
const _emit = {};

/**
 * The canonical look handed to `FilamentPaths#sync` — filled from
 * `settings.railcoil` every frame, never kept. Module scope because an object
 * literal per frame is exactly the allocation I3 forbids.
 */
const _look = {};

/**
 * RAILCOIL — the shot that is already there.
 *
 * **THE TRICK — zero travel time.** Every other line cast in the sandbox is a
 * front racing down the aim line; this one refuses to have a front at all.
 * `advance()` is overridden to hold `u` at 0 for the whole wind-up while four
 * helical coils collapse inward along the barrel, and on the frame they meet it
 * writes `u = 1` in a single step. There is no interpolation, no ease, and
 * `dt` is never read — a 26 m channel exists in the frame after a 0 m one, and
 * the eye reads that as a railgun rather than as a fast beam. Everything after
 * that is **decay**.
 *
 * The decay is the other half of the slot, and it is three things at once over
 * about a second and a half:
 *
 *  1. **cooling** — the hot palette on the tube and the filaments is blended
 *     toward a cold one on `coolCurve`, white → blue → nothing. Both consumers
 *     read the *same* blend, deliberately: they are one channel drawn as a core
 *     and its threads, and letting them cool at different rates immediately
 *     reads as two effects that happen to overlap;
 *  2. **sagging** — the channel droops under its own weight. The segments are
 *     placed on the sagged curve rather than each sagging locally, so the break
 *     stays part of one line;
 *  3. **breaking** — the tube's width collapses early, leaving the filaments,
 *     and those are drawn as up to three *disconnected* `LINE` roles spanning
 *     consecutive thirds of the span. Each one is eaten from one end by its own
 *     `draw(progress)` on a clock offset by a noise sample taken at its own
 *     position along `t`, so the channel comes apart in a different order every
 *     cast and always in an order that reads as physical rather than as a
 *     sequence. The eaten end flips with the same noise, so segments do not all
 *     retreat the same way.
 *
 * The first version dissolved the channel with a single global alpha and a
 * fading tube. It looked like somebody turning a dimmer down. The disconnection
 * is what makes it read as *ionisation recombining*, and getting it needed
 * nothing new in the tech library: `role.draw()` already carries a front and
 * `role.style()` already carries a per-role dim, and three roles is enough,
 * because the eye counts "broken" long before it counts "into how many".
 *
 * **What a cast captures.** One seed, and two booleans that mark events (the
 * shot has been fired; the front has been handed to the impact phase). Not one
 * metre and not one second: the decay clock is
 * `(age − windUp − flashHold) / (lifetime + fadeTime)`, re-derived every frame,
 * so dragging `windUp` while paused slides the entire decay through itself.
 */
export class RailcoilAbility extends Ability {
  constructor(context) {
    super('railcoil', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    // The channel: three draw calls, and the only part of the ability with a
    // solid silhouette. STRAIGHT because a rail shot is a chord and nothing
    // else; the sag lives on the filaments, which is where it can be seen.
    this.channel = new Tube({
      path: TubePath.STRAIGHT,
      prefix: 'channel',
      nodes: 72,
      sides: 18,
      renderOrder: 11
    });
    this.group.add(this.channel.group);
    // Built once so the cooling pass does not walk an object every frame.
    this._channelLayers = [
      this.channel.materials.core,
      this.channel.materials.sheath,
      this.channel.materials.halo
    ];

    // Two more draw calls, and both beats live in them: four collapsing coils
    // during the wind-up, then one ring-down coil and three channel segments.
    // The role slots are re-filled every frame, so the same four uniform blocks
    // are a helix in one beat and a broken line in the next — which is the
    // whole reason this module has roles rather than instances.
    this.paths = new FilamentPaths(this.group, {
      samples: FILAMENT_SAMPLES,
      capacity: FILAMENT_CAPACITY,
      renderOrder: 12
    });

    /* --- what a cast captures: one dice roll and two event flags --- */
    /** Re-rolled per cast so two shots do not break up in the same order. */
    this._seed = 0;
    /** The one-shot at the muzzle has run. */
    this._fired = false;
    /** `advance()` has handed the front to the impact phase. */
    this._handedOver = false;

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
    const particles = this.ctx.particles;

    // Sparks: rail metal, thrown out of the muzzle and shed off the channel
    // while it is still hot enough to be doing damage to itself.
    this.sparks = particles.get('railcoil.sparks', {
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
    this.sparks.uniforms.uFadeOut.value = 0.45;

    // The ionised air the channel leaves behind. These outlive the channel by
    // design: what is left when the filaments have gone is a corridor of motes,
    // which is the only evidence that anything was there.
    this.motes = particles.get('railcoil.motes', {
      capacity: 2600,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.7;
    this.motes.uniforms.uEndSize.value = 0.18;
    this.motes.uniforms.uSizeIn.value = 0.05;
    this.motes.uniforms.uFadeIn.value = 0.07;
    this.motes.uniforms.uFadeOut.value = 0.4;

    this.smoke = particles.get('railcoil.smoke', {
      capacity: 1400,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.smoke.uniforms.uDrag.value = 1.8;
    this.smoke.uniforms.uEndSize.value = 3.0;
    this.smoke.uniforms.uSizeIn.value = 0.12;
    this.smoke.uniforms.uFadeIn.value = 0.18;
    this.smoke.uniforms.uFadeOut.value = 0.32;

    this.sparkEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing — every one of these is derived, none of it is stored         */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    // Filaments are drawn twice (halo and core); the channel is three layers.
    return this.paths.liveCount * 2 + this.channel.drawCalls;
  }

  get impactDuration() {
    return Math.max(0.05, settings.railcoil.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.railcoil.fadeTime);
  }

  /** Seconds the coils take to close. */
  get windUp() {
    return Math.max(0.01, settings.railcoil.windUp);
  }

  /** How far the coils have collapsed, 0..1. */
  get charge() {
    return saturate(this.age / this.windUp);
  }

  /** True once the coils have met and the shot exists. */
  get armed() {
    return this.age >= this.windUp;
  }

  /**
   * How far through the decay the channel is, 0..1.
   *
   * Derived from the live sliders and the age, with no timestamp anywhere in
   * it: the shot begins when the coils meet (`windUp`), stands at full white
   * for `flashHold`, and then dies over `lifetime + fadeTime` — the same two
   * numbers that set the phase durations, so the ramp and the phases can never
   * drift apart. Drag `windUp` with the clock stopped and the whole decay
   * slides, which is as direct a demonstration of I1 as this project has.
   */
  get decay() {
    const c = settings.railcoil;
    const span = Math.max(0.05, c.lifetime * settings.global.lifetime + c.fadeTime);
    return saturate((this.age - this.windUp - Math.max(0, c.flashHold)) / span);
  }

  /**
   * The channel gutters harder the deader it is. A steady light over a cooling
   * plasma reads as a lamp somebody left on.
   */
  lightShimmer() {
    const c = settings.railcoil;
    const depth = saturate(c.lightFlicker) * (0.3 + 0.7 * this.decay);
    const step = Math.floor(this.age * Math.max(1, c.lightFlickerSpeed));
    const noise = hash11(step * 1.7 + 3.1);
    return 1 - depth * noise;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The breech, at the caster's hip. */
  _breechPoint(out) {
    const c = settings.railcoil;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** The muzzle — the far end of the barrel, and where the coils meet. */
  _muzzlePoint(out) {
    const c = settings.railcoil;
    this._breechPoint(out);
    return out.addScaledVector(this.direction, c.barrelLength);
  }

  /** A point `f` of the way along the barrel, 0 = breech, 1 = muzzle. */
  _barrelPoint(f, out) {
    const c = settings.railcoil;
    this._breechPoint(out);
    return out.addScaledVector(this.direction, c.barrelLength * f);
  }

  /**
   * A point `s` of the way along the shot itself, muzzle → target, with the
   * sag applied.
   *
   * The droop is one arch over the whole span rather than one per segment: a
   * segment that sags in isolation is a sausage, and three of them in a row are
   * a string of sausages. Placing the endpoints on the shared curve and giving
   * each role only the *chord deviation* of its own stretch keeps the break-up
   * part of a single sagging line.
   */
  _shotPoint(s, droop, out) {
    const c = settings.railcoil;
    const t = saturate(s);
    this._muzzlePoint(out);
    // The far end of the shot is the end of the cast line, not the end of the
    // barrel, so the axis is muzzle → target and `t` runs across that.
    _dir.copy(this.origin).addScaledVector(this.direction, this.length).sub(out);
    _dir.y = c.endHeight - out.y;
    out.addScaledVector(_dir, t);
    out.y += droop * Math.sin(t * Math.PI);
    return out;
  }

  /** Metres the dead channel has drooped by, at this point in the decay. */
  _droop() {
    const c = settings.railcoil;
    return -c.channelSag * Math.pow(this.decay, Math.max(0.05, c.channelSagCurve));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The trick, in nine lines: **`dt` is not read.**
   *
   * The front is at the caster or at the target, with nothing in between and no
   * frame in which it is anywhere else. The hand-over to the impact phase is
   * held back by `flashHold` so the full-length shot gets one beat of TRAVEL to
   * itself at full white before the decay begins — and because the hand-over is
   * a pure function of `age` rather than an accumulated step, a zero-length
   * frame cannot advance it. That matters more than it sounds: the pause test
   * drives this ability with `dt = 0` for hundreds of frames, and an edge
   * detector fed by `dt` would fire the impact somewhere inside that.
   */
  advance(_dt) {
    const c = this.config;
    const armed = this.age >= Math.max(0.01, c.windUp);

    this.front = armed ? this.length : 0;
    this.u = armed ? 1 : 0;
    this.pointAt(this.u, this.position);

    const done = this.age >= Math.max(0.01, c.windUp) + Math.max(0, c.flashHold);
    const handOver = done && !this._handedOver;
    this._handedOver = done;
    return handOver;
  }

  onSpawn() {
    this.sparkEmitter.reset();
    this.moteEmitter.reset();
    this.smokeEmitter.reset();

    this._seed = Math.random() * 100;
    this._fired = false;
    this._handedOver = false;

    this.paths.clear();
    this._sync(1);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Everything the ability draws, re-resolved and pushed. One entry point, so
   * the wind-up and the decay cannot get out of step with each other.
   *
   * @param {number} phaseFade 1 while the cast is lit, ramping to 0 at the end
   */
  _sync(phaseFade) {
    const c = settings.railcoil;
    const g = settings.global;
    const decay = this.decay;
    // The cooling ramp. One number, read by the tube and the filaments alike.
    const cool = Math.pow(decay, Math.max(0.05, c.coolCurve));

    this._syncChannel(c, g, phaseFade, decay, cool);
    this._syncFilaments(c, g, phaseFade, decay, cool);
    this._syncParticleLook(c, g);
  }

  /** The tube: drawn only once the shot exists, and collapsing as it dies. */
  _syncChannel(c, g, phaseFade, decay, cool) {
    const state = this._state;

    this._muzzlePoint(state.origin);
    // The tube is straight, so its far end goes on the *sagged* curve at t = 1;
    // by the time the sag is deep enough to matter the tube is a thread.
    this._shotPoint(1, this._droop(), state.target);
    state.side.copy(this.side);
    state.progress = this.armed ? 1 : 0;
    state.widthFade = lerp(1, 0.08, saturate(decay / Math.max(0.02, c.channelCollapse)));
    state.fade = phaseFade * (1 - Easing.inQuad(decay));
    state.seed = this._seed;
    state.time = this.age;

    this.channel.sync(c, state, g);
    for (const material of this._channelLayers) this._cool(material.uniforms, c, cool);
  }

  /**
   * Blend a set of four colour uniforms from the hot palette toward the cold
   * one, in place, immediately after whoever owns them wrote the hot values.
   *
   * The obvious alternative — hand `sync()` a proxy settings object carrying
   * pre-blended colours — needs a `#rrggbb` string per layer per frame, and
   * `getColor()` memoises by string, so a fresh string every frame allocates a
   * `Color` *and* leaks it into a cache that never shrinks. Two allocations per
   * frame per layer to avoid four `Color.lerp` calls is the wrong trade, and
   * the cache leak took a while to spot the first time.
   */
  _cool(uniforms, c, k) {
    uniforms.uColorCore.value.lerp(getColor(c.colorCoolCore), k);
    uniforms.uColorInner.value.lerp(getColor(c.colorCoolInner), k);
    uniforms.uColorOuter.value.lerp(getColor(c.colorCoolOuter), k);
    uniforms.uColorHalo.value.lerp(getColor(c.colorCoolHalo), k);
  }

  /** Fill the canonical look the shared strip reads. Never kept. */
  _fillLook(c, g) {
    _look.width = c.width;
    _look.glowWidth = c.glowWidth;
    _look.glowOpacity = c.glowOpacity;
    _look.jitter = c.jitter;
    _look.jitterScale = c.jitterScale;
    _look.octaves = c.octaves;
    _look.jitterFalloff = c.jitterFalloff;
    _look.crawl = c.crawl;
    _look.pinch = c.pinch;
    _look.restrike = c.restrike;
    _look.flicker = c.flicker;
    _look.flickerSpeed = c.flickerSpeed;
    _look.strandFlash = c.strandFlash;
    _look.coreSharp = c.coreSharp;
    _look.glowFalloff = c.glowFalloff;
    _look.softFade = c.softFade;
    _look.opacity = c.opacity;
    _look.glow = c.glow;
    // The hot palette. The cold end is applied to the uniforms afterwards, for
    // the reason given on `_cool`.
    _look.colorCore = c.channelColorCore;
    _look.colorInner = c.channelColorInner;
    _look.colorOuter = c.channelColorOuter;
    _look.colorHalo = c.channelColorHalo;
    _look.randomness = g.randomness;
    _look.noiseStrength = g.noiseStrength;
    _look.noiseFrequency = g.noiseFrequency;
    _look.noiseSpeed = g.noiseSpeed;
    _look.opacityScale = g.opacity;
    _look.glowScale = g.glow;
  }

  /**
   * The four role slots — coils before the shot, the ring-down and the broken
   * channel after it.
   */
  _syncFilaments(c, g, phaseFade, decay, cool) {
    if (this.armed) this._layDecay(c, decay);
    else this._layCoils(c);

    this._fillLook(c, g);
    this.paths.sync(_look, phaseFade, this._seed);
    this._cool(this.paths.uniforms, c, cool);
  }

  /**
   * The wind-up: `coilCount` helices collapsing inward along the barrel.
   *
   * Each coil is a role, each role is a short helix, and the collapse is one
   * number — `gather` — driving three things at once: the coils' centres slide
   * to the muzzle, their spans shorten to nothing, and their radii close. When
   * `gather` reaches 1 all of them are zero-length rings sitting on the same
   * point, which is what "they meet" looks like, and the frame after that the
   * shot is out.
   *
   * The first version moved the centres and left the radii alone. Four coils
   * of the same diameter converging on a point read as a concertina rather
   * than as a charge; it is the *closing* that says energy is being forced
   * somewhere smaller.
   */
  _layCoils(c) {
    const count = clamp(Math.round(c.coilCount), 1, 4);
    const gather = Math.pow(this.charge, Math.max(0.05, c.coilGather));
    const radius = lerp(c.coilRadius, c.coilRadiusEnd, gather);
    // The coils brighten as they close — the only cue that the wind-up is
    // going somewhere, since nothing about it moves toward the target.
    const bright = c.coilDim * (0.3 + 0.7 * this.charge);
    const half = Math.max(0.5 * c.coilSpan * (1 - gather), 0.004);

    for (let i = 0; i < 4; i++) {
      const role = this.paths.role(i);
      if (i >= count) {
        role.retire();
        continue;
      }
      const base = (i + 0.5) / count;
      const centre = lerp(base, 1, gather);
      this._barrelPoint(saturate(centre - half), _from);
      this._barrelPoint(saturate(centre + half), _to);

      role.count = Math.max(1, Math.round(c.coilFilaments));
      role
        .helix(
          _from,
          _to,
          radius,
          radius * 0.82,
          c.coilTurns,
          c.coilSpin,
          c.coilLift,
          c.coilSpread,
          c.coilTaper
        )
        .style(c.coilKink, c.coilWidth, bright, 1)
        .ends(0.7, 0.7, 0.85, 0.85)
        .draw(2, 0.08, -1e4, 0);
    }
  }

  /**
   * The decay: one ring-down coil, and the channel broken into segments.
   *
   * Role 0 keeps being a coil — the current in the rail does not stop the
   * instant the shot leaves — and it deliberately re-reads `coilRadiusEnd`,
   * `coilKink`, `coilWidth`, `coilSpread` and `coilTaper` rather than owning
   * copies of them. That sharing *is* the design: it is the same coil, so it
   * has to answer to the same sliders, and it is also the only reason those
   * five stay live once the wind-up is over.
   */
  _layDecay(c, decay) {
    /* --- role 0: the coil that survives --- */
    const alive = saturate(1 - decay / Math.max(0.02, c.ringdownLife));
    const ring = this.paths.role(RINGDOWN_ROLE);
    const filaments = Math.round(c.ringdownFilaments);
    if (alive <= 0 || filaments <= 0) {
      ring.retire();
    } else {
      const droop = this._droop();
      this._shotPoint(0, droop, _from);
      this._shotPoint(1, droop, _to);
      ring.count = filaments;
      ring
        .helix(
          _from,
          _to,
          // It starts at the radius the coils closed to and blooms outward as
          // it unwinds, which is what a collapsing field does on the way out.
          lerp(c.coilRadiusEnd, c.ringdownRadius, 1 - alive),
          lerp(c.coilRadiusEnd, c.ringdownRadius, 1 - alive) * 0.6,
          c.ringdownTurns,
          c.ringdownSpin,
          0,
          c.coilSpread,
          c.coilTaper
        )
        .style(c.coilKink, c.coilWidth, c.ringdownDim * alive, 1)
        .ends(0.8, 0.8, 0.9, 0.9)
        .draw(2, 0.1, -1e4, 0);
    }

    /* --- roles 1..3: the channel, coming apart --- */
    const segments = clamp(Math.round(c.segments), 1, MAX_SEGMENTS);
    const droop = this._droop();
    const gap = Math.max(0, c.segmentGap) * 0.5;
    const tip = Math.max(0.01, c.dissolveTip);
    const stagger = clamp(c.dissolveStagger, 0, 0.95);
    const spread = Math.max(0, c.segmentSpread);

    for (let i = 0; i < MAX_SEGMENTS; i++) {
      const role = this.paths.role(i + 1);
      if (i >= segments) {
        role.retire();
        continue;
      }

      const a = saturate(i / segments + gap);
      const b = saturate((i + 1) / segments - gap);
      const mid = (a + b) * 0.5;

      // The dissolve clock, sampled *along t* rather than off the index: the
      // noise is a property of the position on the channel, so widening
      // `dissolveNoise` re-shuffles which part of it dies first, and doing it
      // this way means the order never depends on how many segments there are.
      const noise = hash11(mid * c.dissolveNoise + this._seed * 0.137);
      const k = saturate((decay - noise * stagger) / Math.max(0.05, 1 - stagger));
      if (k >= 1) {
        role.retire();
        continue;
      }

      this._shotPoint(a, droop, _from);
      this._shotPoint(b, droop, _to);
      // Half of them are eaten from the far end. `draw()` only ever clips from
      // the top of `t`, so the flip is done by swapping the anchors — which
      // costs nothing and is the difference between a channel dissolving and a
      // channel being wiped by an invisible cursor.
      const reverse = noise > 0.5;
      const from = reverse ? _to : _from;
      const to = reverse ? _from : _to;

      // The chord deviation of this stretch of the shared sag arch — see
      // `_shotPoint`. Positive `sag` bows the path up in the shader, and the
      // droop is already negative, so this comes out the right way round.
      const localSag =
        droop * (Math.sin(mid * Math.PI) - 0.5 * (Math.sin(a * Math.PI) + Math.sin(b * Math.PI)));

      role.count = Math.max(1, Math.round(c.segmentFilaments));
      role
        .line(from, to, localSag, spread * 0.35, spread, 1.0, 0.2, 0.25, 1)
        // It frays as it goes: a dying segment kinks harder and thins out, so
        // the last thing on screen is a thread with a lot of noise in it.
        .style(c.segmentKink * (1 + k * c.segmentFray), c.segmentWidth * (1 - 0.55 * k), 1 - k, 1)
        .ends(0.7, 0.7, 0.9, 0.9)
        .draw((1 + tip) - k * (1 + 2 * tip), tip, -1e4, 0.5);
    }
  }

  /** The three particle systems, re-resolved every frame. */
  _syncParticleLook(c, g) {
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
    this.sparks.uniforms.uGlow.value = 0.7 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
    this.sparks.uniforms.uTurbulence.value = 0.25 * g.turbulence;

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
    this.motes.uniforms.uGlow.value = 0.9 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

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
    this.smoke.uniforms.uTurbulence.value = 0.3 * g.turbulence;
  }

  /* ------------------------------------------------------------------ */
  /* One-shots                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * The shot. Fired on the frame the coils meet, from `onTravel`, because that
   * is the frame `advance()` wrote `u = 1` on — the impact phase does not start
   * until `flashHold` later and this cannot wait for it.
   */
  _fire() {
    const c = settings.railcoil;
    const g = settings.global;
    const time = frame.uTime.value;

    this._muzzlePoint(_pos);

    this.ctx.bursts.spawn(BurstMode.STORM, _pos, {
      radius: c.muzzleSize * 0.15,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.4,
      intensity: c.muzzleIntensity,
      opacity: 0.9,
      fresnel: 1.6,
      displace: 0.5,
      squash: 0.7,
      colorA: getColor(c.colorMuzzleA),
      colorB: getColor(c.colorMuzzleB),
      colorC: getColor(c.colorMuzzleC)
    });

    _emit.position = _pos;
    _emit.radius = 0.18;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.sparkSpeed * 2.4;
    _emit.speedVariance = 0.7;
    // Tight: this is metal coming off a rail, not a firework. A wide cone here
    // was the single thing that most made the shot read as an explosion.
    _emit.spread = 0.32;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.24;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.fireSparks * g.particleCount), _emit);

    /* --- the scorch line, laid whole because the shot arrived whole --- */
    const marks = Math.max(0, Math.round(c.scorchMarks));
    for (let i = 0; i < marks; i++) {
      const s = marks > 1 ? i / (marks - 1) : 0.5;
      this._shotPoint(s, 0, _pos);
      _pos.y = 0.012;
      _pos.addScaledVector(this.side, randRange(-c.scorchJitter, c.scorchJitter));
      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: c.scorchRadius * randRange(0.75, 1.3),
        life: c.scorchLife,
        intensity: c.scorchIntensity,
        colorA: getColor(c.colorScorch),
        colorB: getColor(c.colorScorchEmber),
        height: 0.012
      });
    }

    this.ctx.shake.add(
      c.recoilShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.05, c.recoilTime),
      c.recoilFreq
    );
    this.ctx.flash.trigger(getColor(c.colorFireFlash), c.fireFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * c.fireLight * g.explosionIntensity;
  }

  /** Sparks, motes and haze off the channel while it dies. */
  _channelFx(dt) {
    const c = settings.railcoil;
    const g = settings.global;
    const time = frame.uTime.value;
    const decay = this.decay;
    const droop = this._droop();
    // Sparks only while it is hot; motes all the way, and hardest at the end,
    // because recombination is what makes them.
    const hot = 1 - saturate(decay / Math.max(0.02, c.channelCollapse));

    const sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate * hot) * g.particleCount);
    if (sparkCount > 0) {
      this._shotPoint(Math.random(), droop, _pos);
      _emit.position = _pos;
      _emit.radius = 0.14;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.sparkSpeed * 0.5;
      _emit.speedVariance = 0.8;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.14;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.sparks.emit(sparkCount, _emit);
    }

    const moteCount = Math.round(
      this.moteEmitter.tick(dt, c.moteRate * (0.35 + 0.65 * decay)) * g.particleCount
    );
    if (moteCount > 0) {
      this._shotPoint(Math.random(), droop, _pos);
      _emit.position = _pos;
      _emit.radius = 0.3;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 1.0;
      _emit.size = 0.08;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate) * g.particleCount);
    if (smokeCount > 0) {
      this._shotPoint(Math.random(), droop, _pos);
      _emit.position = _pos;
      _emit.radius = 0.4;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.9;
      _emit.size = 0.8;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }
  }

  /** Sparks spat out of the barrel while the coils close. */
  _chargeFx(dt) {
    const c = settings.railcoil;
    const g = settings.global;
    const charge = this.charge;

    const count = Math.round(
      this.sparkEmitter.tick(dt, c.sparkRate * 0.35 * charge) * g.particleCount
    );
    if (count <= 0) return;

    this._barrelPoint(randRange(0.2, 1), _pos);
    _emit.position = _pos;
    _emit.radius = c.coilRadius * (1 - charge) + 0.06;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.4).setY(0.5).normalize();
    _emit.speed = c.sparkSpeed * 0.5;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime * 0.7;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(count, _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.railcoil;
    const g = settings.global;

    // The one-shot goes on the frame the front jumped, not on the phase change:
    // the impact phase is `flashHold` behind, and the bang belongs to the jump.
    if (this.armed && !this._fired) {
      this._fired = true;
      this._fire();
    }

    this._sync(1);

    if (this.armed) {
      this._lightAt();
      this._channelFx(dt);
    } else {
      this._muzzlePoint(this.position);
      this._chargeFx(dt);
      this.ctx.shake.rumble(c.chargeShake * this.charge * g.cameraShake, dt);
    }
  }

  /** Nothing loud here — the shot already happened, `flashHold` ago. */
  onImpact() {
    this._lightAt();
  }

  onFade(dt, t) {
    // `t` runs 0..1 through the hot half and 1..2 through the cold one, but the
    // look is driven by `decay`, which spans both — so all this does is take
    // the last of it off at the very end, where the phase clock and the decay
    // clock agree anyway.
    const fade = t <= 1 ? 1 : 1 - Easing.inQuad(saturate(t - 1));
    this._sync(fade);
    this._lightAt();
    this._channelFx(dt);
  }

  /**
   * Put the light on the channel rather than on the floor at the far end.
   *
   * It starts near the muzzle and drifts downrange as the channel cools, which
   * is roughly where the brightest surviving section is once the near end has
   * dissolved — and, more practically, it stops a 26 m shot being lit entirely
   * from behind the camera.
   */
  _lightAt() {
    this._shotPoint(lerp(0.15, 0.5, this.decay), this._droop(), this.position);
  }

  onDestroy() {
    this.paths.clear();
    this._fired = false;
    this._handedOver = false;
  }

  dispose() {
    this.channel.dispose();
    this.paths.dispose();
    super.dispose();
  }
}
