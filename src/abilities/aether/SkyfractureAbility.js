import { Vector3 } from 'three';
import { Ability } from '../Ability.js';
import { FilamentPaths } from '../../vfx/FilamentPaths.js';
import { GroundField, GroundMode } from '../../vfx/GroundField.js';
import { Shell, ShellMode } from '../../vfx/Shell.js';
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
const _mid = new Vector3();
const _pos = new Vector3();
const _dir = new Vector3();

/**
 * The two `filamentLook()`-shaped bags, refilled and handed to `sync()`.
 * Two rather than one because reading `_look` twice with different colours in
 * it is the kind of thing that is correct today and wrong after one edit.
 */
const _skyLook = {};
const _floorLook = {};
/** `GroundField#update` params. */
const _wet = {};
/** `ParticleSystem#emit` params. */
const _emit = {};

/**
 * SKYFRACTURE — the effect arrives before the cause.
 *
 * **THE TRICK: reverse-ordered cause and effect.** A white fracture pattern
 * inks itself across the floor along the cast line with *nothing above it* —
 * no sound, no shake, no dust, no light in the sky. Four tenths of a second
 * later the sky splits along the same shape. Three tenths after that the
 * pressure finally arrives. You read the shadow, then the thing that casts it,
 * then what it does to you, which is the wrong order and is the entire
 * ability. `skyGap` and `pressureGap` are the two sliders that own it and they
 * are the first two controls in the editor folder.
 *
 * ### The floor pattern and the sky pattern are the same pattern
 *
 * Not "similar", not "seeded alike" — the same one, in plan view, to the
 * pixel. `FilamentPaths`' `CRACK` mode builds each branch as a pure function
 * of the seed and the trunk's `from → to`: it takes the trunk direction, makes
 * a frame off it, and rolls each fork's angle and roll out of `hash11(seed)`.
 * Feed two instances the identical seed, the identical eight branch
 * parameters and two trunks that are *parallel and the same length*, and they
 * produce byte-identical geometry, one translated in y.
 *
 * The floor copy is then flattened, and the flattening is the part worth
 * reading twice. `FilamentRole#draw`'s third argument clamps every vertex
 * **above** a floor height — `world.y = max(world.y, floorY)`. Clamping does
 * nothing to x or z. So if the whole copy is placed far *below* the floor, low
 * enough that not one branch of it can reach back up, the clamp collapses
 * every vertex onto exactly `groundHeight` and leaves the horizontal
 * coordinates untouched. That is not an approximation of an orthographic
 * projection; it *is* one, evaluated in the vertex shader for free.
 *
 * `_sinkDepth()` computes how far below is far enough, live, from the branch
 * parameters — see the comment there. The first version used a fixed −50 m and
 * broke the moment somebody dragged `crackLengthFrac` past 1: half the twigs
 * came back through the floor and stood up out of it like weeds.
 *
 * ### Why two `FilamentPaths` and not two roles of one
 *
 * Two roles on one instance would have cost two draw calls instead of four,
 * and it was the first thing tried. It draws two *different* fractures. The
 * per-filament hash is `hash11(aStrand * 7.13 + uSeed + strike * 3.77)` and
 * `aStrand` is the **global** instance index, not the index within the role —
 * so role 1's filaments start at aStrand = count and every branch angle in the
 * floor copy comes out different from the sky's. Two instances put both
 * copies at aStrand 0..N−1 with the same `uSeed`, which is the only
 * arrangement that makes them match. It also buys each copy its own four
 * colour pickers, which a reflection wants anyway: it should be colder and
 * dimmer than the thing it reflects.
 *
 * ### The shared parameters are shared on purpose
 *
 * Everything under **The fracture** in the settings block feeds both copies
 * from one slider. That is the `snare.zoneRadius` exemption in
 * `docs/EXPANSION.md` I5 — the sharing *is* the design. A second `crackAngle`
 * would let the floor advertise a shape the sky never makes.
 *
 * ### Budget
 *
 * Six draw calls: two `FilamentPaths` at two each, one `GroundField(WET)`, one
 * `Shell(PRESSURE)`. Two particle systems, both throttled by their own beat, so
 * nothing is emitted at all until the beat that owns it has started.
 */
export class SkyfractureAbility extends Ability {
  constructor(context) {
    super('skyfracture', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * The floor copy is built first and drawn first: it is beat one, and
     * `renderOrder` should agree with the fiction as well as with the depth
     * sort. Both instances get the same `samples` and the same `capacity`, so
     * a filament index means the same thing in both — which is what keeps the
     * seeds lined up.
     */
    this.floorPaths = new FilamentPaths(this.group, {
      samples: 96,
      capacity: 24,
      renderOrder: 8
    });
    this.skyPaths = new FilamentPaths(this.group, {
      samples: 96,
      capacity: 24,
      renderOrder: 12
    });

    /**
     * The wet stone. Alpha-blended, not additive: the floor under the fracture
     * has to go *darker* and glossier, because the white filaments only read as
     * a reflection if they are lying in something. An additive patch brightens
     * the floor and the filaments turn into chalk on it.
     */
    this.wet = new GroundField(this.group, {
      mode: GroundMode.WET,
      additive: false,
      name: 'skyfracture.wet'
    });

    /** Beat three. A near-invisible fresnel shell, centred above the line. */
    this.wave = new Shell({
      mode: ShellMode.PRESSURE,
      prefix: 'wave',
      renderOrder: 14
    });
    this.group.add(this.wave.group);

    /** The one thing a cast captures, besides timestamps. Unitless. */
    this._seed = 0;
    /** `this.age` at the moment the front landed. A timestamp — allowed. */
    this._landedAt = 0;
    /** Latched so the sky's one-shot fires on exactly one frame. */
    this._tore = false;
    /** ... and the pressure's. */
    this._burst = false;
    /** Filaments currently drawn, for the HUD readout. */
    this._live = 0;

    /** The shell's state bag. Instance-scope: four casts do not take turns. */
    this._shell = {
      origin: new Vector3(),
      axis: new Vector3(0, 1, 0),
      side: new Vector3(1, 0, 0),
      span: 0,
      t: 0,
      fade: 1,
      seed: 0
    };
  }

  createParticles() {
    const particles = this.ctx.particles;

    /** Beat three, and only beat three. Nothing is emitted before it. */
    this.dust = particles.get('skyfracture.dust', {
      capacity: 2000,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.dust.uniforms.uDrag.value = 1.7;
    this.dust.uniforms.uEndSize.value = 3.4;
    this.dust.uniforms.uSizeIn.value = 0.1;
    this.dust.uniforms.uFadeIn.value = 0.14;
    this.dust.uniforms.uFadeOut.value = 0.35;

    /** Beat two: what falls out of a hole in the sky. */
    this.glint = particles.get('skyfracture.glint', {
      capacity: 1400,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.glint.uniforms.uDrag.value = 0.9;
    this.glint.uniforms.uEndSize.value = 0.2;
    this.glint.uniforms.uSizeIn.value = 0.05;
    this.glint.uniforms.uFadeIn.value = 0.05;
    this.glint.uniforms.uFadeOut.value = 0.5;

    this.dustEmitter = new RateEmitter();
    this.glintEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing — the impact phase has to be long enough to hold all three   */
  /* ------------------------------------------------------------------ */

  /**
   * The whole reversed sequence happens inside the impact phase, so the phase
   * has to be at least as long as the sequence. Resolved from the live gaps
   * every frame, which means dragging `skyGap` on a standing cast lengthens the
   * phase under it rather than truncating the sky.
   */
  get impactDuration() {
    const c = settings.skyfracture;
    const total = c.skyGap + c.skyDraw + c.pressureGap + c.pressureRise + c.lifetime;
    return Math.max(0.05, total * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.skyfracture.fadeTime);
  }

  get instanceCount() {
    // Both copies, both passes.
    return this._live * 4;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                  */
  /* ------------------------------------------------------------------ */

  /** The trunk's start in plan, on the floor. */
  _planFrom(out) {
    return out.copy(this.origin).addScaledVector(this.direction, settings.skyfracture.crackLead);
  }

  /** The trunk's end in plan, on the floor. */
  _planTo(out) {
    return this.pointAt(1, out);
  }

  /**
   * How far below the floor the flattened copy has to sit for the clamp in
   * `FilamentRole#draw` to be an exact orthographic projection.
   *
   * `CRACK` walks two generations. Generation 0 puts a branch tip at
   * `root + nd·len·lengthFrac`; generation 1 at
   * `root + nd·(len·lengthFrac)·lengthFrac·depthFalloff`. `nd` is a unit
   * vector, so the worst case in y is the sum of those two lengths, and `sag`
   * adds one more bow on top. Anything below that and a twig pokes back up
   * through the floor and stands there — which is exactly what the first
   * version, with a hard-coded −50 m, did the first time `crackLengthFrac` went
   * past 1.
   *
   * The kink cannot contribute: the floor copy runs with `groundDamp = 0`, so
   * its kink offset has no y component at all.
   */
  _sinkDepth() {
    const c = settings.skyfracture;
    const span = Math.max(0.1, this.length);
    const f = Math.max(0, c.crackLengthFrac);
    const reach = span * (f + f * f * Math.max(0, c.crackDepthFalloff));
    return reach + Math.abs(c.skySag) + Math.max(0, c.groundClearance);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.dustEmitter.reset();
    this.glintEmitter.reset();

    // Unitless. Both copies read the *same* one, and that is the ability.
    this._seed = Math.random() * 100;
    this._landedAt = 0;
    this._tore = false;
    this._burst = false;
    this._live = 0;

    this.wet.setVisible(true);
    this.wave.visible = true;
    this.floorPaths.visible = true;
    this.skyPaths.visible = true;

    this._sync(0, 0, 0, 0);
  }

  /* ------------------------------------------------------------------ */
  /* The one sync                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the three beats into everything.
   *
   * @param {number} floorT 0..1 — how much of the floor pattern has inked
   * @param {number} skyT   0..1 — how much of the sky fracture has torn open
   * @param {number} waveT  0..1 — the pressure front's own life
   * @param {number} heal   0..1 — the way back to an undisturbed room
   */
  _sync(floorT, skyT, waveT, heal) {
    const c = settings.skyfracture;
    const g = settings.global;

    const count = Math.max(1, Math.round(c.crackCount));
    this._live = count;
    const master = 1 - Easing.inCubic(heal);

    this._planFrom(_from);
    this._planTo(_to);
    _mid.addVectors(_from, _to).multiplyScalar(0.5);

    /* ---------------------------------------------------------------- */
    /* Beat one — the floor copy                                         */
    /* ---------------------------------------------------------------- */
    // Sunk, then clamped. See `_sinkDepth()`; this pair of lines is the trick.
    const sink = c.groundHeight - this._sinkDepth();
    _from.y = sink;
    _to.y = sink;

    const floorRole = this.floorPaths.role(0);
    floorRole.count = count;
    floorRole
      .crack(
        _from,
        _to,
        c.crackAngle,
        c.crackLengthFrac,
        c.crackDepthFalloff,
        c.crackSpread,
        c.crackStart,
        // No bow on the floor copy. `sag` only moves y, so it could not change
        // the plan view even if it wanted to — but a bow that is then clamped
        // flat is two lines of shader doing nothing, so it is zero here.
        0,
        c.crackForkBias
      )
      // groundDamp 0: the kink keeps its plan-view offset and loses its y, which
      // is what makes the two copies agree kink for kink as well as fork for
      // fork.
      .style(1, 1, 0, 0)
      .ends(0, 1, 0, 1)
      .draw(floorT * (1 + c.floorTipLength * 2), c.floorTipLength, c.groundHeight, c.floorTipGlow);

    this._fillLook(_floorLook, g, {
      width: c.floorWidth,
      glowWidth: c.floorGlowWidth,
      glowOpacity: c.floorGlowOpacity,
      flicker: c.floorFlicker,
      flickerSpeed: c.floorFlickerSpeed,
      strandFlash: c.floorStrandFlash,
      coreSharp: c.floorCoreSharp,
      glowFalloff: c.floorGlowFalloff,
      softFade: c.floorSoftFade,
      opacity: c.floorOpacity,
      // The reflection brightens when there is finally something to reflect.
      // Beat one is a shadow; from beat two on it is a mirror.
      glow: c.floorGlow + c.floorSkyBoost * skyT,
      colorCore: c.colorFloorCore,
      colorInner: c.colorFloorInner,
      colorOuter: c.colorFloorOuter,
      colorHalo: c.colorFloorHalo
    });
    this.floorPaths.sync(_floorLook, master, this._seed);

    /* ---------------------------------------------------------------- */
    /* Beat two — the sky copy, the same crack, lifted                    */
    /* ---------------------------------------------------------------- */
    // One height, both ends. A tilted trunk would give `CRACK` a different
    // frame to branch off and the floor would stop showing this shape.
    _from.y = c.skyHeight;
    _to.y = c.skyHeight;

    const skyRole = this.skyPaths.role(0);
    skyRole.count = count;
    skyRole
      .crack(
        _from,
        _to,
        c.crackAngle,
        c.crackLengthFrac,
        c.crackDepthFalloff,
        c.crackSpread,
        c.crackStart,
        c.skySag,
        c.crackForkBias
      )
      .style(1, 1, 0, 1)
      .ends(0, 1, 0, 1)
      .draw(skyT * (1 + c.skyTipLength * 2), c.skyTipLength, -1e4, c.skyTipGlow);

    this._fillLook(_skyLook, g, {
      width: c.skyWidth,
      glowWidth: c.skyGlowWidth,
      glowOpacity: c.skyGlowOpacity,
      flicker: c.skyFlicker,
      flickerSpeed: c.skyFlickerSpeed,
      strandFlash: c.skyStrandFlash,
      coreSharp: c.skyCoreSharp,
      glowFalloff: c.skyGlowFalloff,
      softFade: c.skySoftFade,
      opacity: c.skyOpacity,
      glow: c.skyGlow,
      colorCore: c.colorSkyCore,
      colorInner: c.colorSkyInner,
      colorOuter: c.colorSkyOuter,
      colorHalo: c.colorSkyHalo
    });
    // Nothing above the floor until the gap has run out: `skyT` gates the
    // *draw*, and this gates the whole strip so its halo is not sitting in the
    // sky at zero length giving the game away.
    this.skyPaths.sync(_skyLook, master * (skyT > 0 ? 1 : 0), this._seed);

    /* ---------------------------------------------------------------- */
    /* The wet stone under all of it                                     */
    /* ---------------------------------------------------------------- */
    _mid.y = 0;
    _wet.centre = _mid;
    // GroundField's local +Z is downrange, so the yaw is the cast's bearing.
    _wet.yaw = Math.atan2(this.direction.x, this.direction.z);
    _wet.height = c.groundHeight * 0.5;
    _wet.radius = Math.max(0.5, this.length * 0.5 * c.wetSpan + c.wetMargin);
    _wet.grow = floorT;
    _wet.recede = heal;
    _wet.fade = master;
    _wet.seed = this._seed;
    _wet.edge = c.wetEdge;
    _wet.ragged = c.wetRagged;
    _wet.raggedScale = c.wetRaggedScale;
    _wet.warp = c.wetWarp;
    _wet.relief = c.wetRelief;
    _wet.normalStep = c.wetNormalStep;
    _wet.ambient = c.wetAmbient;
    _wet.wrap = c.wetWrap;
    _wet.specular = c.wetSpecular;
    _wet.gloss = c.wetGloss;
    _wet.parallax = c.wetParallax;
    _wet.cell = c.wetCell;
    _wet.lift = c.wetLift;
    _wet.depth = c.wetDepth;
    _wet.detail = c.wetDetail;
    _wet.speed = c.wetSpeed;
    _wet.flow = c.wetFlow;
    _wet.windAngle = c.wetWind;
    _wet.additive = false;
    _wet.emissive = c.wetEmissive;
    _wet.opacity = c.wetOpacity;
    _wet.depthFade = c.wetDepthFade;
    _wet.colorBase = c.colorWetBase;
    _wet.colorEdge = c.colorWetEdge;
    _wet.colorGlow = c.colorWetGlow;
    _wet.colorDeep = c.colorWetDeep;
    _wet.noiseStrength = g.noiseStrength;
    _wet.noiseFrequency = g.noiseFrequency;
    _wet.noiseSpeed = g.noiseSpeed;
    _wet.opacityScale = g.opacity;
    this.wet.update(_wet);

    /* ---------------------------------------------------------------- */
    /* Beat three — the pressure front                                   */
    /* ---------------------------------------------------------------- */
    const shell = this._shell;
    shell.origin.copy(_mid);
    shell.axis.copy(_up);
    shell.side.copy(this.side);
    shell.span = this.length;
    shell.t = waveT;
    shell.fade = master * (waveT > 0 ? 1 : 0);
    shell.seed = this._seed;
    this.wave.sync(c, shell, g);

    /* ---------------------------------------------------------------- */
    /* Particle uniforms                                                 */
    /* ---------------------------------------------------------------- */
    this.dust.setGradient(
      getColor(c.colorDustA),
      getColor(c.colorDustB),
      getColor(c.colorDustC),
      getColor(c.colorDustD)
    );
    this.dust.uniforms.uGravity.value.set(0, c.dustRise, 0);
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize;
    this.dust.uniforms.uLifeScale.value = c.dustLifetime * 0.5 * g.particleLifetime;
    this.dust.uniforms.uSpeedScale.value = g.particleSpeed;
    this.dust.uniforms.uOpacity.value = c.dustOpacity * g.opacity;
    this.dust.uniforms.uTurbulence.value = 0.4 * g.turbulence;

    this.glint.setGradient(
      getColor(c.colorGlintA),
      getColor(c.colorGlintB),
      getColor(c.colorGlintC),
      getColor(c.colorGlintD)
    );
    this.glint.uniforms.uGravity.value.set(0, c.glintFall, 0);
    this.glint.uniforms.uSizeScale.value = c.glintSize * g.particleSize * 7;
    this.glint.uniforms.uLifeScale.value = c.glintLifetime * 0.5 * g.particleLifetime;
    this.glint.uniforms.uSpeedScale.value = g.particleSpeed;
    this.glint.uniforms.uOpacity.value = g.opacity;
    this.glint.uniforms.uGlow.value = 1.4 * g.glow;
    this.glint.uniforms.uTurbulence.value = c.glintTurbulence * g.turbulence;
  }

  /**
   * Fill one `filamentLook()`-shaped bag.
   *
   * The kink group and the restrike clock are written here, from the *shared*
   * settings, for both copies — that is not laziness, it is the constraint. The
   * kink frame's first normal is horizontal and its second is vertical for a
   * horizontal path, so `groundDamp = 0` on the floor copy throws away exactly
   * the vertical half and leaves the plan-view kink identical to the sky's.
   * Give the two copies different `jitterScale` values and that stops being
   * true within one frame.
   *
   * @param {object} look the module-scope bag to fill
   * @param {object} g    `settings.global`
   * @param {object} own  the per-copy values, already resolved by the caller
   */
  _fillLook(look, g, own) {
    const c = settings.skyfracture;

    look.jitter = c.crackJitter;
    look.jitterScale = c.crackJitterScale;
    look.octaves = c.crackOctaves;
    look.jitterFalloff = c.crackJitterFalloff;
    look.crawl = c.crackCrawl;
    look.pinch = c.crackPinch;
    look.restrike = c.crackRestrike;

    look.width = own.width;
    look.glowWidth = own.glowWidth;
    look.glowOpacity = own.glowOpacity;
    look.flicker = own.flicker;
    look.flickerSpeed = own.flickerSpeed;
    look.strandFlash = own.strandFlash;
    look.coreSharp = own.coreSharp;
    look.glowFalloff = own.glowFalloff;
    look.softFade = own.softFade;
    look.opacity = own.opacity;
    look.glow = own.glow;
    look.colorCore = own.colorCore;
    look.colorInner = own.colorInner;
    look.colorOuter = own.colorOuter;
    look.colorHalo = own.colorHalo;

    look.randomness = g.randomness;
    look.noiseStrength = g.noiseStrength;
    look.noiseFrequency = g.noiseFrequency;
    look.noiseSpeed = g.noiseSpeed;
    look.opacityScale = g.opacity;
    look.glowScale = g.glow;
  }

  /* ------------------------------------------------------------------ */
  /* Beats                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Seconds since the floor pattern finished inking.
   *
   * `_landedAt` is a timestamp — the moment an event fired — which is the one
   * kind of number a cast is allowed to keep. Everything measured against it is
   * a live setting, so the gaps re-resolve on a paused frame and dragging
   * `skyGap` moves a fracture that is standing.
   */
  get _sinceLanding() {
    return Math.max(0, this.age - this._landedAt);
  }

  onTravel(dt) {
    const c = settings.skyfracture;

    // Beat one, and nothing else. No shake, no dust, no light in the sky.
    this._sync(this.u, 0, 0, 0);

    this.position.copy(this.pointAt(this.u, _pos));
    this.position.y = c.groundHeight;

    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    // The only thing that happens when the front lands is that a clock starts.
    // Everything an impact normally does — flash, shake, burst — belongs to
    // beats two and three, seconds later.
    this._landedAt = this.age;
  }

  onFade(dt, t) {
    const c = settings.skyfracture;
    const g = settings.global;

    const since = this._sinceLanding;
    const heal = saturate(t - 1);

    const skyT = saturate((since - c.skyGap) / Math.max(0.01, c.skyDraw));
    const waveT = saturate(
      (since - c.skyGap - c.skyDraw - c.pressureGap) / Math.max(0.01, c.pressureRise)
    );

    this._sync(1, skyT, waveT, heal);

    /* --- the light climbs to the fracture as it opens --- */
    this.pointAt(0.5, this.position);
    this.position.y = lerp(c.groundHeight, c.skyHeight * 0.75, Easing.outQuad(skyT));

    /* --- beat two's one-shot --- */
    if (!this._tore && skyT > 0) {
      this._tore = true;
      this.ctx.flash.trigger(getColor(c.colorSkyFlash), c.skyFlash * g.explosionIntensity);
      this.lightBoost = c.lightIntensity * 0.9 * g.explosionIntensity;
      this._glintBurst(Math.round(c.glintBurst * g.particleCount));
    }

    /* --- beat three's one-shot --- */
    if (!this._burst && waveT > 0) {
      this._burst = true;
      this.ctx.shake.add(
        c.pressureShake * g.explosionIntensity * g.cameraShake,
        1 / Math.max(0.05, c.shakeDuration),
        22
      );
      this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
    }

    /* --- the two continuous emitters, each gated by its own beat --- */
    if (skyT > 0) this._glintFx(dt, skyT * (1 - heal));
    if (waveT > 0) this._dustFx(dt, waveT, (1 - waveT * 0.4) * (1 - heal));
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** Motes shaken loose along the sky fracture and falling out of it. */
  _glintFx(dt, scale) {
    const c = settings.skyfracture;
    const g = settings.global;
    const count = Math.round(this.glintEmitter.tick(dt, c.glintRate * scale) * g.particleCount);
    if (count <= 0) return;

    this.pointAt(randRange(0.02, 1), _pos);
    _pos.y = c.skyHeight;
    _emit.position = _pos;
    _emit.radius = this.length * 0.22;
    _emit.direction = _dir.set(0, -1, 0);
    _emit.speed = c.glintSpeed;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.7;
    _emit.life = c.glintLifetime;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.glint.emit(count, _emit);
  }

  /** The one-shot on the frame the sky opens. */
  _glintBurst(count) {
    if (count <= 0) return;
    const c = settings.skyfracture;

    this.pointAt(0.5, _pos);
    _pos.y = c.skyHeight;
    _emit.position = _pos;
    _emit.radius = this.length * 0.45;
    _emit.direction = _dir.set(0, -1, 0);
    _emit.speed = c.glintSpeed * 1.8;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.13;
    _emit.sizeVariance = 0.8;
    _emit.life = c.glintLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.glint.emit(count, _emit);
  }

  /**
   * Dust lifted off the floor by the pressure front.
   *
   * Emitted at the radius the shell has actually reached rather than at a
   * captured distance, so the dust wave rides the front and dragging
   * `waveRadiusEnd` while paused moves both of them together.
   */
  _dustFx(dt, waveT, scale) {
    const c = settings.skyfracture;
    const g = settings.global;
    const count = Math.round(this.dustEmitter.tick(dt, c.dustRate * scale) * g.particleCount);
    if (count <= 0) return;

    const radius = this.wave.radius;
    // Around the ring, not inside it: a front that lifts dust from its own
    // centre reads as a bonfire.
    const theta = randRange(0, Math.PI * 2);
    const r = radius * randRange(0.82, 1.0);
    this.pointAt(0.5, _pos);
    _pos.x += Math.cos(theta) * r;
    _pos.z += Math.sin(theta) * r;
    _pos.y = 0.1;

    _emit.position = _pos;
    _emit.radius = clamp(radius * 0.1, 0.2, 2.5);
    _emit.direction = _dir.set(Math.cos(theta) * 0.6, 1, Math.sin(theta) * 0.6).normalize();
    _emit.speed = c.dustSpeed * (1 - waveT * 0.5);
    _emit.speedVariance = 0.75;
    _emit.spread = 0.7;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 1.1;
    _emit.sizeVariance = 0.5;
    _emit.life = c.dustLifetime;
    _emit.lifeVariance = 0.45;
    _emit.spin = 0.35;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.dust.emit(count, _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Teardown                                                            */
  /* ------------------------------------------------------------------ */

  onDestroy() {
    this._live = 0;
    this.floorPaths.clear();
    this.skyPaths.clear();
    this.wet.setVisible(false);
    this.wave.visible = false;
  }

  dispose() {
    this.floorPaths.dispose();
    this.skyPaths.dispose();
    this.wet.dispose();
    this.wave.dispose();
    super.dispose();
  }
}
