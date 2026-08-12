import { Color, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { FilamentPaths, filamentLook } from '../../vfx/FilamentPaths.js';
import { HullShape, Medium, VolumeHull } from '../../vfx/VolumeHull.js';
import { Hook, sceneHooks } from '../../vfx/SceneHooks.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp } from '../../utils/math.js';

/**
 * Filaments this ability may draw at once, across all three roles.
 *
 * `FilamentPaths` hard-caps at its `capacity`, and the three sliders together
 * can ask for more than that, so the roles are filled in priority order and the
 * last one takes whatever is left. The trunk always gets its share: a sheet with
 * no main fracture is nothing, a sheet with no feelers is still a sheet.
 */
const CAPACITY = 48;

/** Nodes along one filament. The ceiling on how fine a kink can be. */
const SAMPLES = 72;

/**
 * Points across the zone one frame's motes are split between.
 *
 * The same lesson `ThunderclapAbility` writes down about its ring: emit a whole
 * frame's batch from one point and it reads as a hose, not as air.
 */
const MOTE_BATCHES = 4;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _from = new Vector3();
const _to = new Vector3();
const _tint = new Color();
const _look = filamentLook();

/** Deterministic 0..1 hash. A pulse must look the same every time it is drawn. */
function hash1(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * SHEET LIGHTNING — a far cast whose whole output is somebody else's lighting.
 *
 * **THE TRICK — the shadows strobe.** The pulse train is written to the scene's
 * *key light* through `SceneHooks`' `KEY_LIGHT` hook, so it is not this
 * ability's shader that flashes: it is the sun. The character's shadow, the
 * relief on the floor, the crystals of a Frost Lance still standing from the
 * previous cast — every real shadow on the stage snaps out and back on the same
 * clock, five times in three-quarters of a second, and the ability itself draws
 * almost nothing. It is the cheapest effect in the project by a distance and the
 * first time it fires it is startling, which is the only review that matters.
 *
 * **What it deliberately does not do.**
 *
 *  - **It never calls `token.aim()`.** Swinging the sun is Dawnbreak's sentence
 *    — a *travelling* light, shadows sweeping across the stage. Sheet lightning
 *    is diffuse: a whole cloud base lights at once and the shadows keep their
 *    bearings and change only their depth. `brightness()` and `tint()`, nothing
 *    else. Aiming it was tried and it read as a searchlight, which is a
 *    completely different weather event.
 *  - **There is no `ctx.flash.trigger()` anywhere in this file.** A white
 *    full-screen overlay is what everybody reaches for when they draw lightning
 *    and it is the single thing that would hide the trick, because it washes out
 *    the shadows at exactly the frame they snap. The screen goes bright here
 *    only because the *world* got bright.
 *  - **Nothing lands on the floor.** No scorch, no arc decal, no debris. This is
 *    intracloud lightning; the discharge stays in the mist and the feelers stop
 *    well above head height. The floor's contribution is the character's shadow
 *    lying on it, and a burn mark drawn on top of that competes with the read.
 *
 * **The three beats.**
 *
 *  1. **Charge** (`TRAVEL`). The front runs out to the zone and the sun is
 *     pulled *down* toward `keyCharge`, blending in over `armTime`. The stage
 *     dims before anything appears. That is the Thunderclap lesson — the
 *     anticipation carries it — and without it the first pulse has no cause.
 *  2. **The train** (`IMPACT`). `flashes` pulses at `strobeRate`, each with a
 *     hashed amplitude and width and a coin-flip second stroke at
 *     `doubleGap` widths. Real lightning strokes come in trains and no two are
 *     the same brightness; an even train is a fluorescent tube failing.
 *  3. **Afterglow** (the tail of `IMPACT`, then `FADE`). One dim decay, no more
 *     snaps, and the hook blends back to `settings.environment` over
 *     `releaseTime` — to zero weight, which is *exactly* the environment again
 *     rather than approximately, because `SceneHooks.apply()` blends from
 *     settings and not from the live light.
 *
 * **What a cast captures.** One unitless seed and the timestamps the base class
 * already keeps. The pulse train is re-derived from `settings.sheetlightning`
 * on every frame, zero-length ones included: pause mid-train with **P**, drag
 * `strobeRate`, and the pulse boundaries move underneath the standing cast — the
 * world goes light or dark with the clock stopped. Drag `keyFlash` and the
 * frozen flash gets brighter. That is invariant I1 with the ability's entire
 * output on the far side of it.
 *
 * **A note on the pause harness.** The probe snapshots the uniforms an ability
 * *owns*, and the sun is not one of them — a hook-only slot reads as thirty dead
 * sliders even while it is driving the world. `SceneHooks.observe()` exists for
 * exactly this and covers the four published fields; the key light is not among
 * them, so this ability parks its own mirror of what it wrote to the sun on the
 * cloud material's `userData.uniforms`. Nothing in any shader reads those five
 * numbers. They are there to be seen.
 */
export class SheetLightningAbility extends Ability {
  constructor(context) {
    super('sheetlightning', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the discharge: three roles, two draw calls, always --- */
    this.paths = new FilamentPaths(this.group, {
      samples: SAMPLES,
      capacity: CAPACITY,
      renderOrder: 11
    });

    /* --- the slab of mist it is buried in --- */
    // CYLINDER rather than BOX because a cloud base has a round footprint and
    // the zone indicator drew a circle; the hull's y runs 0..Sy from where it is
    // placed, so it is seated at the underside of the slab rather than at its
    // centre. MIST because it is the one medium in the library that scatters
    // more than it absorbs, which is what lets a light inside it read *through*
    // it — and the light inside it is the whole ability.
    this.cloud = new VolumeHull({
      hull: HullShape.CYLINDER,
      medium: Medium.MIST,
      prefix: 'cloud',
      maxSteps: 32,
      additive: false,
      renderOrder: 12
    });
    this.group.add(this.cloud.mesh);

    /**
     * A live *view* of the settings block, made once.
     *
     * `VolumeHull.sync(c, g)` reads its forty keys straight off the block, which
     * is exactly right for forty sliders and no use at all for the one key this
     * ability has to modulate per frame — the cloud's emission *is* the sheet,
     * so it has to carry the pulse. The two obvious alternatives are both worse:
     * writing `settings.sheetlightning.cloudEmission` back would have the
     * ability fighting the editor for a number the user owns (and a preset saved
     * mid-cast would keep whatever the strobe happened to be doing), and copying
     * forty keys into a scratch object every frame is forty property reads to
     * avoid one.
     *
     * A prototype view costs one object for the life of the instance. Reads of
     * the other thirty-nine keys fall through to the live block, so every one of
     * them stays a live slider; `cloudEmission` is shadowed on the view and
     * recomputed from the live block value each frame, so it stays live too.
     */
    this._cloudView = Object.create(settings.sheetlightning);

    /**
     * What this ability last told the sun, mirrored where the pause probe can
     * see it. See the class comment. Parked on the cloud material because that
     * is a material this ability already owns; nothing samples them.
     */
    this._probe = {
      uKeyBrightness: { value: 0 },
      uKeyWeight: { value: 0 },
      uKeyTint: { value: new Color() },
      uPulse: { value: 0 },
      uCharge: { value: 0 }
    };
    const material = this.cloud.material;
    material.userData = material.userData ?? {};
    material.userData.uniforms = Object.assign(material.userData.uniforms ?? {}, this._probe);
    sceneHooks.observe(material);

    /** The token driving the world's key light, or null between casts. */
    this._sun = null;
    /** Re-rolled per cast so two storms do not strobe the identical train. */
    this._seed = 0;
    /** Latched once, so the opening jolt fires on the frame the sheet does. */
    this._opened = false;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The aerosol the flash catches. Additive and short-lived: between pulses
    // the air has nothing in it, because between pulses there is no light to
    // find anything with.
    this.motes = particles.get('sheetlightning.motes', {
      capacity: 1600,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.5
    });
    this.motes.uniforms.uDrag.value = 1.9;
    this.motes.uniforms.uEndSize.value = 0.2;
    this.motes.uniforms.uSizeIn.value = 0.06;
    this.motes.uniforms.uFadeIn.value = 0.05;
    this.motes.uniforms.uFadeOut.value = 0.45;

    // The cloud's ragged underside. Non-additive so it genuinely occludes —
    // a cloud that adds light is a fire.
    this.haze = particles.get('sheetlightning.haze', {
      capacity: 900,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.3
    });
    this.haze.uniforms.uDrag.value = 1.4;
    this.haze.uniforms.uEndSize.value = 2.6;
    this.haze.uniforms.uSizeIn.value = 0.16;
    this.haze.uniforms.uFadeIn.value = 0.2;
    this.haze.uniforms.uFadeOut.value = 0.4;

    this.moteEmitter = new RateEmitter();
    this.hazeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing — every span re-resolved, every frame                        */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.paths.liveCount;
  }

  /** Seconds between pulses. */
  _period() {
    return 1 / Math.max(0.5, settings.sheetlightning.strobeRate);
  }

  /** Pulses in this train, clamped to something a slider can reach. */
  _flashCount() {
    return Math.max(1, Math.round(settings.sheetlightning.flashes));
  }

  /**
   * The strobe train plus its tail.
   *
   * Derived rather than authored, so `flashes` and `strobeRate` move the length
   * of the impact phase itself. Drag either while paused and the beat boundaries
   * move under the standing cast — which is the point, and is why there is no
   * `holdTime` slider in the block.
   */
  get impactDuration() {
    const c = settings.sheetlightning;
    const train = this._flashCount() * this._period();
    return Math.max(0.05, (train + Math.max(0.01, c.afterglow)) * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.sheetlightning.fadeTime);
  }

  /**
   * Seconds since the sheet fired, negative while it is still charging.
   *
   * Rebuilt from `impactTime` and the live `impactDuration` rather than taken
   * from the `t` the base class hands `onFade`, for the reason Thunderclap gives:
   * that `t` was divided by a duration one frame ago and this ability's duration
   * is two sliders that may move underneath it.
   */
  _clock() {
    if (this.phase === AbilityPhase.FADE) return this.impactDuration + this.fadeTime;
    if (this.phase === AbilityPhase.IMPACT) return this.impactTime;
    return -1;
  }

  /* ------------------------------------------------------------------ */
  /* The strobe                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * One pulse of the train, 0..1.
   *
   * Hard attack, `flashDecay` fall. The attack is a discontinuity on purpose:
   * every eased version of this reads as a lamp coming up, and the thing that
   * says *lightning* is that the world is simply already bright on the next
   * frame. `hash1` off the pulse index and the cast seed gives each stroke its
   * own amplitude and width, and a coin flip against `doubleChance` gives it a
   * second stroke — real flashes come in strokes down the same channel, which is
   * the flicker everybody has seen and nobody draws.
   *
   * @param {number} index which pulse of the train
   * @param {number} local seconds since that pulse began
   */
  _pulseAt(index, local) {
    const c = settings.sheetlightning;
    const decay = Math.max(0.2, c.flashDecay);
    const amp = 1 - saturate(c.flashVary) * hash1(index * 3.7 + this._seed);
    const width = Math.max(0.005, c.flashWidth) * (0.55 + 0.9 * hash1(index * 7.1 + this._seed + 4.3));

    let env = local >= 0 && local < width ? Math.pow(1 - local / width, decay) : 0;

    if (hash1(index * 11.9 + this._seed + 9.7) < saturate(c.doubleChance)) {
      const at = local - width * Math.max(0.2, c.doubleGap);
      if (at >= 0 && at < width) {
        env = Math.max(env, Math.pow(1 - at / width, decay) * Math.max(0, c.doubleLevel));
      }
    }
    return env * amp;
  }

  /**
   * How lit the world is right now, 0..1.
   *
   * @param {number} t seconds since the sheet fired; negative is the charge
   */
  _pulse(t) {
    if (t < 0) return 0;
    const c = settings.sheetlightning;
    const period = this._period();
    const flashes = this._flashCount();
    const index = Math.floor(t / period);

    if (index >= flashes) {
      // The tail. One decay, no more snaps: a train that keeps stuttering as it
      // dies reads as a fault rather than as a storm moving away.
      const over = t - flashes * period;
      const tail = Math.max(0.01, c.afterglow);
      const k = saturate(1 - over / tail);
      return k * k * Math.max(0, c.afterglowLevel);
    }
    return this._pulseAt(index, t - index * period);
  }

  /** The pooled point light rides the same envelope as the sun. */
  lightShimmer() {
    const c = settings.sheetlightning;
    const t = this._clock();
    if (t < 0) return saturate(c.keyCharge / Math.max(0.01, c.keyFlash));
    return Math.max(saturate(c.sheetIdle), this._pulse(t));
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The zone centre, on the floor. What the circle indicator measured out. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** The live footprint, metres. */
  get radius() {
    return Math.max(0.1, settings.sheetlightning.zoneRadius);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this.hazeEmitter.reset();
    this._opened = false;

    // The one thing a cast captures, and it is unitless.
    this._seed = Math.random() * 100;

    // The world's sun, borrowed. `borrow()` is what gives it back on the three
    // paths that are not this ability's idea — the player pressing C, a fifth
    // cast pushing this one off the concurrency cap, and teardown. Leaving the
    // stage lit from a lightning flash for the rest of the session is the exact
    // failure `SceneHooks` was written around.
    this._sun = this.borrow(sceneHooks.acquire(Hook.KEY_LIGHT, this));

    this.paths.visible = true;
    this.cloud.setFade(0);
    this._sync(0, 0);
  }

  /* ------------------------------------------------------------------ */
  /* The one sync                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current beat into everything.
   *
   * @param {number} env    0..1 how lit this frame is
   * @param {number} master 0..1 the cast's own life — 1 while it is up, 0 gone
   */
  _sync(env, master) {
    const c = settings.sheetlightning;
    const g = settings.global;

    this._centrePoint(_centre);
    const R = this.radius;
    const span = R * Math.max(0.05, c.sheetSpan);

    /* ---------------------------------------------------------------- */
    /* The world's key light — the ability                               */
    /* ---------------------------------------------------------------- */
    this._syncKey(env, master);

    /* ---------------------------------------------------------------- */
    /* The discharge                                                     */
    /* ---------------------------------------------------------------- */
    // Every role is `draw(2, …)` — "drawn whole". There is no travelling front
    // anywhere in this ability, and that is not a shortcut: a leader racing
    // along the channel is what a *bolt* does, and drawing one here would make
    // this a very slow ground strike. A sheet is already everywhere by the time
    // you see it.
    const main = Math.min(20, Math.max(0, Math.round(c.strands)));
    const cross = Math.min(CAPACITY - main, Math.max(0, Math.round(c.crossStrands)));
    const feelers = Math.min(CAPACITY - main - cross, Math.max(0, Math.round(c.feelerCount)));

    /* the main fracture, running downrange through the cloud */
    _from.copy(_centre).addScaledVector(this.direction, -span);
    _to.copy(_centre).addScaledVector(this.direction, span);
    _from.y = c.sheetHeight;
    _to.y = c.sheetHeight;
    this.paths
      .role(0)
      .crack(_from, _to, c.crackAngle, c.crackLength, c.crackFalloff, c.crackSpread,
        c.crackStart, c.sheetSag, c.crackForkBias)
      .style(1, 1, 1, 1)
      .ends(0, 1, 0.35, 0.35)
      .draw(2, 0.08, -1e4, 0);
    this.paths.role(0).count = main;

    /* and the same fracture across it, lower down */
    // Across the *side* vector, not at some rolled bearing: two cuts at right
    // angles is what turns a line of light into a sheet, and rolling the second
    // one produced a pair of crossing bolts instead — the eye reads two objects
    // as soon as they are not obviously the same event seen twice.
    _from.copy(_centre).addScaledVector(this.side, -span);
    _to.copy(_centre).addScaledVector(this.side, span);
    _from.y = c.sheetHeight - c.sheetDrop;
    _to.y = c.sheetHeight - c.sheetDrop;
    this.paths
      .role(1)
      .crack(_from, _to, c.crackAngle, c.crackLength, c.crackFalloff, c.crackSpread,
        c.crackStart, c.sheetSag * 0.6, c.crackForkBias)
      .style(1, 0.85, 1, 1)
      .ends(0, 1, 0.35, 0.35)
      .draw(2, 0.08, -1e4, 0);
    this.paths.role(1).count = cross;

    /* the feelers hanging out of the belly */
    // `floorY` is `feelerFloor` rather than the ground, which is the whole
    // reason these read as reaching *into* the haze rather than as a strike that
    // missed: a filament clamped at 5 m looks like it lost itself in cloud, and
    // one clamped at 0 m looks like it hit the stage and did nothing.
    _from.copy(_centre);
    _from.y = c.sheetHeight - c.sheetDrop * 0.5;
    _to.copy(_centre);
    _to.y = Math.max(c.feelerFloor, c.sheetHeight - c.feelerDrop);
    this.paths
      .role(2)
      .crack(_from, _to, c.crackAngle * 1.35, c.crackLength, c.crackFalloff, c.crackSpread * 1.4,
        c.crackStart, c.feelerSag, c.crackForkBias)
      .style(1, 0.7, 0.55, 1)
      .ends(0.1, 1, 0.2, 0.9)
      .draw(2, 0.1, c.feelerFloor, 0);
    this.paths.role(2).count = feelers;

    // The fourth slot is retired every frame. `sync()` overwrites `uCount`, so a
    // role that is not written is a role that keeps whatever the last ability to
    // use this strip left in it.
    this.paths.role(3).count = 0;

    this._fillLook(env, g);
    this.paths.sync(_look, master, this._seed);

    /* ---------------------------------------------------------------- */
    /* The cloud it is buried in                                         */
    /* ---------------------------------------------------------------- */
    const thickness = Math.max(0.1, c.cloudThickness);
    const view = this._cloudView;
    // Cheap insurance: if a preset load ever swapped the block object out from
    // under us the view would silently freeze at the old numbers, which is the
    // sort of bug that is only ever found by someone else.
    if (Object.getPrototypeOf(view) !== c) Object.setPrototypeOf(view, c);
    // The emission is the sheet. Between pulses it sits at `cloudIdle` rather
    // than zero, because ionised air keeps glowing for a moment and because a
    // cloud that goes completely flat between strokes reads as a prop being
    // switched off.
    const idle = saturate(c.cloudIdle);
    view.cloudEmission = c.cloudEmission * (idle + (1 - idle) * env);

    _pos.copy(_centre);
    _pos.y = Math.max(0.2, c.cloudLift) - thickness * 0.5;
    this.cloud
      .place(_pos, this.direction)
      .setSize(R * Math.max(0.1, c.cloudSpan), thickness, R * Math.max(0.1, c.cloudSpan))
      .setFade(master)
      .sync(view, g);

    /* ---------------------------------------------------------------- */
    /* Particles                                                         */
    /* ---------------------------------------------------------------- */
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
    this.motes.uniforms.uGlow.value = c.sheetGlow * 0.5 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

    this.haze.setGradient(
      getColor(c.colorHazeA),
      getColor(c.colorHazeB),
      getColor(c.colorHazeC),
      getColor(c.colorHazeD)
    );
    this.haze.uniforms.uGravity.value.set(0, c.hazeRise, 0);
    this.haze.uniforms.uSizeScale.value = c.hazeSize * g.particleSize;
    this.haze.uniforms.uLifeScale.value = c.hazeLifetime * 0.5 * g.particleLifetime;
    this.haze.uniforms.uSpeedScale.value = c.hazeSpeed * g.particleSpeed;
    this.haze.uniforms.uOpacity.value = c.hazeOpacity * g.opacity * master;
    this.haze.uniforms.uTurbulence.value = 0.5 * g.turbulence;
  }

  /**
   * Write the sun.
   *
   * Four calls and one of them is the whole ability. `brightness()` is an
   * absolute intensity in `environment.sunIntensity`'s units, `tint()` decides
   * whether the flash is the blue-white of a real stroke or the sodium orange of
   * a storm over a town, and `blend()` decides how much of the environment's own
   * sun is still showing through. `aim()` is conspicuously absent — see the
   * class comment.
   *
   * The mirror written at the bottom is for the pause harness, not for a shader.
   */
  _syncKey(env, master) {
    const c = settings.sheetlightning;
    const charging = this.phase === AbilityPhase.TRAVEL;

    // The charge ramps the *weight* in rather than the intensity: at weight 0
    // the environment's sun is untouched, so the dim arrives as the world's own
    // light being taken away rather than as a grey wash being added over it.
    const arm = saturate(this.age / Math.max(0.02, c.armTime));
    const level = charging ? Math.max(0, c.keyCharge) : lerp(Math.max(0, c.keyDark), Math.max(0, c.keyFlash), env);
    const weight = saturate(c.keyWeight) * (charging ? arm : master);

    _tint.copy(getColor(c.colorKeyDark)).lerp(getColor(c.colorKeyFlash), env);

    if (this._sun) this._sun.brightness(level).tint(_tint).blend(weight);

    const probe = this._probe;
    probe.uKeyBrightness.value = level;
    probe.uKeyWeight.value = weight;
    probe.uKeyTint.value.copy(_tint);
    probe.uPulse.value = env;
    probe.uCharge.value = charging ? arm : 0;
  }

  /**
   * The filament look, filled from the block every frame.
   *
   * `glow` is the only term the pulse touches, and it carries `sheetIdle` as its
   * floor for the same reason the cloud's emission does. Everything else is
   * constant across the train: a fracture that changed *shape* with the
   * brightness would read as a different bolt each stroke, and real strokes go
   * down the same channel — which is precisely why they flicker instead of
   * moving.
   */
  _fillLook(env, g) {
    const c = settings.sheetlightning;
    const idle = saturate(c.sheetIdle);

    _look.width = c.sheetWidth;
    _look.glowWidth = c.sheetGlowWidth;
    _look.glowOpacity = c.sheetGlowOpacity;

    _look.jitter = c.sheetJitter;
    _look.jitterScale = c.sheetJitterScale;
    _look.octaves = c.sheetOctaves;
    _look.jitterFalloff = c.sheetJitterFalloff;
    _look.crawl = c.sheetCrawl;
    _look.pinch = c.sheetPinch;
    _look.restrike = c.sheetRestrike;

    _look.flicker = c.sheetFlicker;
    _look.flickerSpeed = c.sheetFlickerSpeed;
    _look.strandFlash = c.sheetStrandFlash;

    _look.coreSharp = c.sheetCoreSharp;
    _look.glowFalloff = c.sheetGlowFalloff;
    _look.softFade = c.sheetSoftFade;

    _look.opacity = c.sheetOpacity;
    _look.glow = c.sheetGlow * (idle + (1 - idle) * env);
    _look.colorCore = c.colorSheetCore;
    _look.colorInner = c.colorSheetInner;
    _look.colorOuter = c.colorSheetOuter;
    _look.colorHalo = c.colorSheetHalo;

    _look.randomness = g.randomness;
    _look.noiseStrength = g.noiseStrength;
    _look.noiseFrequency = g.noiseFrequency;
    _look.noiseSpeed = g.noiseSpeed;
    _look.opacityScale = g.opacity;
    _look.glowScale = g.glow;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Motes and haze.
   *
   * The mote rate is multiplied by the pulse, so the air is only ever seeded
   * while there is light to find it with. The first version seeded continuously
   * and the motes hung there between strokes as a haze of glowing dots, which
   * says "magic" rather than "a flash went off in fog".
   */
  _airFx(dt, env, master) {
    const c = settings.sheetlightning;
    const g = settings.global;
    const time = frame.uTime.value;
    const R = this.radius;

    this._centrePoint(_centre);

    let moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * env) * g.particleCount);
    if (moteCount > 0) {
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.7;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      const batches = Math.min(moteCount, MOTE_BATCHES);
      const per = Math.ceil(moteCount / batches);
      while (moteCount > 0) {
        // Seeded through the whole column of air under the cloud rather than in
        // a shell at its base: the flash lights the volume, and a shell reads as
        // a ring of sparks hanging at one altitude.
        _pos.copy(_centre);
        _pos.y = Math.max(0.4, c.cloudLift) * (0.15 + 0.75 * Math.random());
        _emit.position = _pos;
        _emit.radius = R * 0.9;
        this.motes.emit(Math.min(per, moteCount), _emit);
        moteCount -= per;
      }
    }

    const hazeCount = Math.round(this.hazeEmitter.tick(dt, c.hazeRate * master) * g.particleCount);
    if (hazeCount > 0) {
      _pos.copy(_centre);
      _pos.y = Math.max(0.2, c.cloudLift) - Math.max(0.1, c.cloudThickness) * 0.5;
      _emit.position = _pos;
      _emit.radius = R * Math.max(0.1, c.cloudSpan) * 0.8;
      _emit.direction = _dir.set(0, -1, 0);
      _emit.speed = c.hazeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 1.0;
      _emit.size = 1.4;
      _emit.sizeVariance = 0.6;
      _emit.life = c.hazeLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0.25;
      _emit.time = time;
      this.haze.emit(hazeCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.sheetlightning;

    // The cloud fades in with the charge; the fracture stays dark. There is
    // nothing to see yet and that is the beat.
    const arm = saturate(this.age / Math.max(0.02, c.armTime));
    this._sync(0, arm);

    // The pooled light sits at the sheet's own height from the first frame, so
    // when the train fires it rakes down rather than lighting the floor flat.
    this._centrePoint(this.position);
    this.position.y = Math.max(0.2, c.sheetHeight);

    this._airFx(dt, 0, arm);
  }

  onImpact() {
    // Nothing here fires the flash — the train is derived from `impactTime` and
    // is already running on the next frame. This is only the jolt, and it is
    // small: a sheet is felt as a roll arriving late, not as a punch.
    this._opened = false;
  }

  onFade(dt, _t) {
    const c = settings.sheetlightning;

    const t = this._clock();
    const env = this._pulse(t);
    // The hook and the cloud let go together over `releaseTime`, measured from
    // the end of the impact phase rather than from the base class's `t`, so the
    // release is its own slider and not a fraction of `fadeTime`.
    const master =
      this.phase === AbilityPhase.FADE
        ? 1 - saturate(this.fadeTime / Math.max(0.05, c.releaseTime))
        : 1;

    if (!this._opened && t >= 0) {
      this._opened = true;
      this.ctx.shake.add(
        c.openShake * settings.global.explosionIntensity,
        1 / Math.max(0.05, c.openShakeTime),
        14
      );
    }

    this._sync(env, master);

    this._centrePoint(this.position);
    this.position.y = Math.max(0.2, c.sheetHeight);

    this._airFx(dt, env * master, master);
    // A low roll rather than a crack: the shake is weighted by the pulse but
    // never punched, because the sound of sheet lightning arrives from a long
    // way off and everybody knows what that feels like.
    this.ctx.shake.rumble(c.rollRumble * env * master, dt);
  }

  onDestroy() {
    // The one line in `SceneHooks`' "one rule". `borrow()` in `onSpawn` is the
    // net; this is the reflex, and it runs first, on the frame, silently.
    sceneHooks.reclaim(this);
    this._sun = null;
    this._opened = false;
    this.paths.clear();
    this.paths.visible = false;
    this.cloud.setFade(0);
  }

  dispose() {
    this.paths.dispose();
    this.cloud.dispose();
    super.dispose();
  }
}
