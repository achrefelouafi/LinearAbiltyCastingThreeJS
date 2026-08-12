import { Vector3 } from 'three';
import { Ability } from '../Ability.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { Tube, TubePath } from '../../vfx/Tube.js';
import { Shell, ShellMode } from '../../vfx/Shell.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;

/**
 * How many points one frame's embers are split between. A single origin makes
 * every batch read as a starburst pinned to one spot on the rim; the ignition
 * front is a *circle*, and a circle has to be sampled round.
 */
const EMBER_ARCS = 5;

/* --- module-scope scratch. Nothing below allocates during a cast (I3) --- */
const _seal = groundFieldParams();
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _hit = new Vector3();

/**
 * RUNESEAL — a seal inscribed on the floor, which then goes off.
 *
 * **The trick is that the writing is real.** Every mark on the floor is a
 * signed-distance field evaluated in metres by one fragment shader — the
 * `RUNE` mode of `vfx/GroundField.js`, which this ability extended to carry it.
 * Three nested rings of *letterforms*, not decoration: strokes with swelling
 * middles and tapered terminals, bowls, and closed counters, drawn from an
 * alphabet of twenty-four stroke skeletons authored in JavaScript and unrolled
 * into straight-line GLSL at module load. Between the rings, a chord armature
 * whose seven lines are simultaneously an inscribed star and a set of tangents
 * to an inner circle. Round the outside, a collar of sixty-four ticks with
 * every eighth one long. In the middle, a five-fold rosette of the same
 * alphabet at a larger em box, ruled inside its own circle, and **drawn last**.
 *
 * All of it inks itself stroke by stroke on one clock. `uInscribe` runs 0 → 1
 * and the seal spends it in three movements — the rings, then the armature and
 * its collar, then the sigil — so the biggest mark on the floor is always the
 * thing you are still watching when the drawing finishes. The rings
 * counter-rotate at falling rates while they do it, because two rings turning
 * the same way are one wheel and two turning against each other are machinery.
 *
 * Four beats:
 *
 *   1. **inscribe** — a scribe line of ink motes runs out to the point and the
 *      seal writes itself, ring by ring, glyph by glyph, stroke by stroke.
 *   2. **ignite** — a front crosses the seal from the middle outward. The
 *      sigil catches first, then each ring in turn. Embers come off the front
 *      itself, so the fire is *where the front is* rather than everywhere.
 *   3. **discharge** — a column of light stands up out of the writing
 *      (`vfx/Tube.js`, straight) and a pressure ring goes out across the floor
 *      (`vfx/Shell.js`), with a shell, a shockwave and a burn at the foot.
 *   4. **burn out** — the fire comes back out of the ink, the strokes char to
 *      `colorChar`, and what is left on the floor is a scar in the shape of the
 *      writing plus a scorch decal that outlives the cast.
 *
 * **The rule that makes the editor work.** A cast captures two numbers — a seed
 * so no two seals draw the same letters, and a dice roll for the armature's
 * starting bearing — plus the timestamps of the beats it has already fired.
 * Not one metre, radian or second is recorded. The em box, the nib width, the
 * chord circle, the tick length, the sigil's arms and the depth of the incision
 * are all resolved against `settings.runeseal` inside the update loop, on a
 * zero-length frame included. Pause with **P** mid-inscription and drag
 * `glyphSize`: the ring recomputes its slot count from its own circumference
 * and fills with *more, smaller runes* rather than scaling the ones already
 * there. That is the difference between working in metres and working in UV,
 * and it is the reason this slot is the showpiece.
 */
export class RunesealAbility extends Ability {
  constructor(context) {
    super('runeseal', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * The seal. Shaded rather than additive: the incision has to be genuinely
     * *darker* than the floor it is cut into, and an additive mark can only ever
     * brighten. The fire on top of it is the `emit` term, which adds anyway.
     */
    this.field = new GroundField(this.group, {
      mode: GroundMode.RUNE,
      additive: false,
      name: 'RunicSeal'
    });

    /**
     * The discharge column. A straight tube rather than a bespoke shaft,
     * because the three-layer core/sheath/halo weighting is the whole reason
     * the Nova Beam reads as solid instead of as a bright fog, and a column
     * standing on a seal has exactly the same problem to solve.
     */
    this.column = new Tube({
      path: TubePath.STRAIGHT,
      prefix: 'column',
      nodes: 72,
      sides: 26,
      renderOrder: 12
    });
    this.group.add(this.column.group);

    /**
     * The ring. A pressure shell squashed flat — `waveHeight` is a multiple of
     * the radius, and at 0.22 the hemisphere is low enough that what you see is
     * its rim travelling across the floor. A dome at full height put a glass
     * bubble over the whole seal and hid the writing at the moment the writing
     * was doing its most interesting thing.
     */
    this.wave = new Shell({
      mode: ShellMode.PRESSURE,
      prefix: 'wave',
      nodes: 40,
      sides: 48,
      renderOrder: 13
    });
    this.group.add(this.wave.group);

    /* --- what a cast captures: two dice rolls and some timestamps --- */
    /** Decorrelates the glyph choice, so two seals do not read the same. */
    this._seed = 0;
    /** 0..1. Resolved into the armature's starting bearing every frame. */
    this._armRoll = 0;
    /** Beats already fired. One-way, so a slider drag cannot re-fire them. */
    this._ignited = false;
    this._discharged = false;
    /** Seconds since the discharge went off. A clock, not a dimension. */
    this._dischargeAge = 0;
    /** Metres of scribe travel already paid out in ink motes. */
    this._scribeDistance = 0;
    /** HUD readout only. */
    this._live = 1;

    /** The seal's anchor, rewritten every frame from the live cast. */
    this._centre = new Vector3();

    // Scratch state handed to the tube and the shell. Two objects, reused.
    this._tube = {
      origin: new Vector3(),
      target: new Vector3(),
      side: new Vector3(),
      progress: 1,
      fade: 0,
      widthFade: 1,
      seed: 0,
      time: 0
    };
    this._shell = {
      origin: new Vector3(),
      axis: new Vector3(0, 1, 0),
      side: new Vector3(1, 0, 0),
      span: 1,
      t: 0,
      fade: 0,
      seed: 0
    };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Embers off the ignition front. Velocity-stretched so a rising ember reads
    // as a streak of burning ink rather than as a dot.
    this.embers = particles.get('runeseal.embers', {
      capacity: 3200,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.3
    });
    this.embers.uniforms.uDrag.value = 1.1;
    this.embers.uniforms.uEndSize.value = 0.2;
    this.embers.uniforms.uSizeIn.value = 0.04;
    this.embers.uniforms.uFadeIn.value = 0.05;
    this.embers.uniforms.uFadeOut.value = 0.5;

    // The slow gold motes: the ink itself, lifting off the writing. Also the
    // scribe line on the way out, which is the same substance arriving.
    this.motes = particles.get('runeseal.motes', {
      capacity: 2400,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.45
    });
    this.motes.uniforms.uDrag.value = 1.5;
    this.motes.uniforms.uEndSize.value = 0.18;
    this.motes.uniforms.uSizeIn.value = 0.07;
    this.motes.uniforms.uFadeIn.value = 0.1;
    this.motes.uniforms.uFadeOut.value = 0.42;

    // Char smoke off the scar. Non-additive so it genuinely occludes the
    // writing it is coming off — smoke that adds light reads as more fire.
    this.smoke = particles.get('runeseal.smoke', {
      capacity: 1800,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.smoke.uniforms.uDrag.value = 1.9;
    this.smoke.uniforms.uEndSize.value = 3.2;
    this.smoke.uniforms.uSizeIn.value = 0.14;
    this.smoke.uniforms.uFadeIn.value = 0.2;
    this.smoke.uniforms.uFadeOut.value = 0.3;

    this.emberEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing — all four beats resolved from settings, every frame          */
  /* ------------------------------------------------------------------ */

  /**
   * A beat's length in seconds, under the global lifetime knob.
   *
   * Everything that reads a clock in this file goes through here, including
   * `impactDuration`. Scaling the phase and not the beats — which is the
   * obvious mistake, and the one the first version made — leaves the seal
   * finishing its discharge a second before the phase machine notices, so
   * `global.lifetime` above 1 buys nothing but a longer stare at a dead seal.
   */
  _span(seconds) {
    return Math.max(0.01, seconds * settings.global.lifetime);
  }

  /** The impact phase holds all four beats. Re-derived, never stored. */
  get impactDuration() {
    const c = settings.runeseal;
    return (
      this._span(c.inscribeTime) +
      this._span(c.igniteTime) +
      this._span(c.dischargeTime) +
      this._span(c.holdTime)
    );
  }

  get fadeDuration() {
    return Math.max(0.05, settings.runeseal.fadeTime);
  }

  get instanceCount() {
    return this._live;
  }

  /**
   * A seal swells rather than gutters.
   *
   * Lightning stutters because an arc genuinely is on and off; burning ink is
   * continuous and only breathes. A hard flicker here made the whole slot look
   * electrical, which is the wrong school.
   */
  lightShimmer() {
    const c = settings.runeseal;
    return 1 - saturate(c.lightPulse) * 0.5 * (1 - Math.cos(this.age * c.lightPulseSpeed));
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The live footprint, metres. What the aim circle measured out. */
  get radius() {
    return Math.max(0.2, settings.runeseal.zoneRadius);
  }

  /** Where the seal is: the far end of the aimed line, on the floor. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** Where the scribe line leaves the caster. */
  _handPoint(out) {
    const c = settings.runeseal;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /**
   * A point on the scribe line at `s` along it, 0..1.
   *
   * The line drops from the hand to just above the floor at the seal, so the
   * motes arrive lying down rather than falling in from head height.
   */
  _scribePoint(s, out) {
    const c = settings.runeseal;
    const t = saturate(s);
    out
      .copy(this.origin)
      .addScaledVector(this.direction, lerp(c.handForward, this.length, t))
      .addScaledVector(this.side, c.handSide * (1 - t));
    out.y = lerp(c.handHeight, c.scribeLift, t);
    return out;
  }

  /** 0..1 — how much of the seal has been inked. */
  _inscribeAmount() {
    return saturate(this.age / this._span(settings.runeseal.inscribeTime));
  }

  /** 0..1 — the ignition front, measured outward from the middle. */
  _igniteAmount() {
    const c = settings.runeseal;
    return saturate((this.age - this._span(c.inscribeTime)) / this._span(c.igniteTime));
  }

  /** 0..1 — how far through the discharge the column and the ring are. */
  _dischargeAmount() {
    return saturate(this._dischargeAge / this._span(settings.runeseal.dischargeTime));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.emberEmitter.reset();
    this.moteEmitter.reset();
    this.smokeEmitter.reset();

    this._ignited = false;
    this._discharged = false;
    this._dischargeAge = 0;
    this._scribeDistance = 0;

    // The only two things a cast captures. Both unitless.
    this._seed = Math.random() * 100;
    this._armRoll = Math.random();

    this.field.setVisible(true);
    this._sync(1, 0);
    this._castFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current cast state into the seal, the
   * column, the ring and the three particle systems.
   *
   * @param {number} fade   1 while the seal stands, ramping to 0 as it burns down
   * @param {number} scorch 0..1 how far the fire has come back out of the ink
   */
  _sync(fade, scorch) {
    const c = settings.runeseal;
    const g = settings.global;

    this._centrePoint(this._centre);
    const radius = this.radius;
    const inscribe = this._inscribeAmount();
    const ignite = this._igniteAmount();

    /* ---------------- the seal ---------------- */
    const s = _seal;
    s.centre = this._centre;
    // The quad carries the caster's heading, so "downrange" and "the aim
    // direction" are the same axis and the relief lights from the right side.
    s.yaw = Math.atan2(this.direction.x, this.direction.z);
    s.height = c.sealHeight;
    s.radius = radius;

    s.grow = 1;
    s.recede = 0;
    s.inscribe = inscribe;
    s.ignite = ignite;
    s.scorch = scorch;
    s.fade = fade;
    s.seed = this._seed;

    s.edge = c.sealEdge;
    s.ragged = c.sealRagged;
    s.raggedScale = c.sealRaggedScale;
    s.warp = c.sealWarp;

    s.relief = c.relief;
    s.ambient = c.ambient;
    s.wrap = c.wrap;
    s.specular = c.specular;
    s.gloss = c.gloss;

    // In RUNE the shared vocabulary means: depth is how far the nib cuts,
    // thickness is the bevel on the walls of that cut. Nothing else is read.
    s.depth = c.incision;
    s.thickness = c.incisionWidth;

    s.rings = c.rings;
    s.ringInner = c.ringInner;
    s.glyphSize = c.glyphSize;
    s.glyphStroke = c.glyphStroke;
    s.glyphGap = c.glyphGap;
    s.spin = c.spin;
    s.spinFalloff = c.spinFalloff;
    s.rule = c.rule;

    s.armStart = c.armStart;
    s.armRadius = c.armRadius;
    s.armSides = c.armSides;
    s.armTangent = c.armTangent;
    s.armStroke = c.armStroke;
    // The dice roll becomes a radian here and only here.
    s.armPhase = c.armPhase + this._armRoll * TAU;
    s.armSpin = c.armSpin;

    s.tickCount = c.tickCount;
    s.tickRadius = c.tickRadius;
    s.tickLength = c.tickLength;
    s.tickStroke = c.tickStroke;
    s.tickMajor = c.tickMajor;
    s.tickMajorLen = c.tickMajorLen;

    s.sigilStart = c.sigilStart;
    s.sigilRadius = c.sigilRadius;
    s.sigilSize = c.sigilSize;
    s.sigilArms = c.sigilArms;
    s.sigilStroke = c.sigilStroke;
    s.sigilRing = c.sigilRing;
    s.sigilSpin = c.sigilSpin;

    s.additive = false;
    s.emissive = c.sealEmissive * g.shaderIntensity;
    s.opacity = c.sealOpacity;
    s.depthFade = c.sealDepthFade;
    s.colorBase = c.colorInk;
    s.colorEdge = c.colorRule;
    s.colorGlow = c.colorFire;
    s.colorDeep = c.colorChar;

    s.noiseStrength = g.noiseStrength;
    s.noiseFrequency = g.noiseFrequency;
    s.noiseSpeed = g.noiseSpeed;
    s.opacityScale = g.opacity;

    this.field.update(s);

    /* ---------------- the column ---------------- */
    // Re-resolved whether or not it is on screen. Syncing only the visible
    // pieces is the tempting optimisation and it breaks the paused editor:
    // drag `columnRadius` while the column is down and it must still be the
    // width you chose when it comes up.
    const dis = this._dischargeAmount();
    const rise = Easing.outCubic(saturate(this._dischargeAge / Math.max(0.01, c.columnRise)));
    const collapse = 1 - Math.pow(dis, Math.max(0.2, c.columnCollapse));

    const t = this._tube;
    t.origin.copy(this._centre);
    t.origin.y = c.sealHeight;
    t.target.copy(this._centre);
    t.target.y = c.sealHeight + Math.max(0.05, c.columnHeight) * rise;
    t.side.copy(this.side);
    t.progress = 1;
    t.fade = this._discharged ? fade * collapse : 0;
    // The column does not dim out, it thins out: the shaft narrows to a thread
    // and lets go. Dimming a solid column reads as a lighting change.
    t.widthFade = 1 - Math.pow(dis, 1.6) * 0.85;
    t.seed = this._seed;
    t.time = this._dischargeAge;
    this.column.sync(c, t, g);
    this.column.visible = t.fade > 0.002;

    /* ---------------- the ring ---------------- */
    const w = this._shell;
    w.origin.copy(this._centre);
    w.origin.y = c.sealHeight;
    w.axis.set(0, 1, 0);
    w.side.copy(this.side);
    w.span = radius * 2;
    w.t = dis;
    w.fade = this._discharged ? fade : 0;
    w.seed = this._seed;
    this.wave.sync(c, w, g);
    this.wave.visible = w.fade > 0.002 && dis < 0.999;

    this._live = 1 + (this.column.visible ? 3 : 0) + (this.wave.visible ? 1 : 0);

    /* ---------------- the three particle systems ---------------- */
    this.embers.setGradient(
      getColor(c.colorEmberA),
      getColor(c.colorEmberB),
      getColor(c.colorEmberC),
      getColor(c.colorEmberD)
    );
    // Positive gravity: burning ink lifts off the floor, it does not fall onto it.
    this.embers.uniforms.uGravity.value.set(0, c.emberRise, 0);
    this.embers.uniforms.uSizeScale.value = c.emberSize * g.particleSize * 7;
    this.embers.uniforms.uLifeScale.value = c.emberLifetime * 0.5 * g.particleLifetime;
    this.embers.uniforms.uSpeedScale.value = g.particleSpeed;
    this.embers.uniforms.uOpacity.value = g.opacity;
    this.embers.uniforms.uGlow.value = 1.2 * g.glow;
    this.embers.uniforms.uStretch.value = c.emberStretch;
    this.embers.uniforms.uTurbulence.value = 0.3 * g.turbulence;

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
    this.motes.uniforms.uGlow.value = 0.95 * g.glow;
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
    this.smoke.uniforms.uTurbulence.value = 0.4 * g.turbulence;
  }

  /** A small flare at the hand as the scribe line leaves it. */
  _castFx() {
    const c = settings.runeseal;
    const g = settings.global;

    this._handPoint(_pos);

    _emit.position = _pos;
    _emit.radius = 0.14;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.moteSpeed * 3.5;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.55;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.6;
    _emit.life = c.moteLifetime * 0.7;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(Math.round(26 * g.particleCount), _emit);

    this.lightBoost = c.lightIntensity * 0.35 * g.explosionIntensity;
  }

  /**
   * Ink motes paid out per metre of scribe travel, so the line arrives at the
   * same density whether the seal was planted at four metres or at twenty.
   * Keyed off distance rather than off time for exactly that reason.
   */
  _scribeFx() {
    const c = settings.runeseal;
    const step = 1 / Math.max(0.05, c.scribeRate);
    const time = frame.uTime.value;

    while (this.front - this._scribeDistance >= step) {
      this._scribeDistance += step;
      const s = saturate(this._scribeDistance / this.length);
      this._scribePoint(s, _pos);

      _emit.position = _pos;
      _emit.radius = 0.1;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.8;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime * 0.55;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(2, _emit);
    }
  }

  /**
   * Everything the standing seal sheds.
   *
   * @param {number} dt
   * @param {number} scale  0..1 — thinned as the seal burns down
   * @param {number} ignite 0..1 — where the ignition front is
   */
  _sealFx(dt, scale, ignite) {
    const c = settings.runeseal;
    const g = settings.global;
    const time = frame.uTime.value;
    const radius = this.radius;
    const centre = this._centre;

    /* --- embers, thrown off the ignition front itself --- */
    const rate = this._discharged ? c.emberDischargeRate : c.emberRate;
    let emberCount = Math.round(
      this.emberEmitter.tick(dt, rate * scale * ignite) * g.particleCount
    );
    if (emberCount > 0) {
      _emit.speed = c.emberSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.75;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.13;
      _emit.sizeVariance = 0.7;
      _emit.life = c.emberLifetime;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      // The front is an annulus at `ignite × radius`, held a little inside the
      // rim so the last of the fire does not fly off the edge of the drawing.
      // Once the front has crossed, the whole seal is alight and the band opens
      // out to cover it.
      const inset = 1 - saturate(c.emberInset);
      const band = lerp(0.14, 0.9, ignite) * radius;
      const front = ignite * radius * inset;

      const per = Math.ceil(emberCount / Math.min(emberCount, EMBER_ARCS));
      while (emberCount > 0) {
        const a = Math.random() * TAU;
        const r = Math.max(0, front + randRange(-band, band) * 0.5);
        _pos.set(centre.x + Math.cos(a) * r, 0.04, centre.z + Math.sin(a) * r);
        _emit.position = _pos;
        _emit.radius = radius * 0.06 + 0.05;
        // Up and slightly outward: ink coming off a cut lifts along the bevel.
        _emit.direction = _dir.set(Math.cos(a) * 0.3, 1, Math.sin(a) * 0.3).normalize();
        this.embers.emit(Math.min(per, emberCount), _emit);
        emberCount -= per;
      }
    }

    /* --- the gold motes hanging over the writing --- */
    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      const a = Math.random() * TAU;
      const r = radius * Math.sqrt(Math.random());
      _pos.set(centre.x + Math.cos(a) * r, randRange(0.05, 0.4), centre.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = radius * 0.12;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.06;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    /* --- char smoke, only once there is char to make it --- */
    const smokeCount = Math.round(
      this.smokeEmitter.tick(dt, c.smokeRate * scale * ignite) * g.particleCount
    );
    if (smokeCount > 0) {
      const a = Math.random() * TAU;
      const r = radius * Math.sqrt(Math.random());
      _pos.set(centre.x + Math.cos(a) * r, 0.12, centre.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = radius * 0.2;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.9;
      _emit.size = 0.9;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.35;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }
  }

  /**
   * The two one-shots, tested against the live beat lengths every frame.
   *
   * Both flags are one-way. Dragging `inscribeTime` upward after the seal has
   * caught would otherwise push the threshold back past the clock and let the
   * ignition fire a second time, which is a burst of embers out of nowhere and
   * one of the more baffling things a paused editor can do to you.
   */
  _checkBeats() {
    const c = settings.runeseal;

    if (!this._ignited && this.age >= this._span(c.inscribeTime)) {
      this._ignited = true;
      this._igniteFx();
    }

    if (
      !this._discharged &&
      this.age >= this._span(c.inscribeTime) + this._span(c.igniteTime)
    ) {
      this._discharged = true;
      this._dischargeAge = 0;
      this._dischargeFx();
    }
  }

  /** The seal catches. Quiet — the loud part is two beats away. */
  _igniteFx() {
    const c = settings.runeseal;
    const g = settings.global;

    this.ctx.flash.trigger(getColor(c.colorIgniteFlash), c.igniteFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.6 * g.explosionIntensity;
  }

  /** The seal goes off: the shell, the shockwave, the burn and the embers. */
  _dischargeFx() {
    const c = settings.runeseal;
    const g = settings.global;
    const time = frame.uTime.value;
    const radius = this.radius;

    this._centrePoint(_hit);

    /* the shell of hot air over the writing */
    _pos.copy(_hit).setY(c.sealHeight + 0.2);
    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: c.burstSize * 0.2,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.6,
      intensity: c.burstIntensity,
      opacity: 0.75,
      fresnel: 1.5,
      displace: 0.5,
      squash: 0.7,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring that snaps out across the floor, under the pressure shell */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _hit, {
      radius: radius * 2.1 * g.explosionIntensity,
      life: 0.65,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorBurstB),
      colorB: getColor(c.colorBurstC)
    });

    /* the burn the seal is standing in, which outlives the cast */
    this.ctx.decals.spawn(DecalType.SCORCH, _hit, {
      radius: c.scorchRadius,
      life: c.scorchLife,
      intensity: c.scorchIntensity,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorSoot),
      height: 0.012
    });

    /* embers blown up out of every stroke at once */
    _emit.position = _hit;
    _emit.radius = radius * 0.75;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.emberSpeed * 2.4;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.5;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.18;
    _emit.sizeVariance = 0.8;
    _emit.life = c.emberLifetime * 1.6;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.embers.emit(Math.round(c.burstEmbers * g.particleCount), _emit);

    _emit.radius = radius * 0.55;
    _emit.speed = c.smokeSpeed * 2.4;
    _emit.spread = 1.0;
    _emit.size = 1.5;
    _emit.life = c.smokeLifetime * 1.2;
    _emit.spin = 0.5;
    this.smoke.emit(Math.round(c.burstSmoke * g.particleCount), _emit);

    this.ctx.shake.add(
      c.dischargeShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      22
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.dischargeFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.6 * g.explosionIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1, 0);
    // The beats run on the cast's own age, which starts at the muzzle — so a
    // short cast can already be igniting while the front is still in the air.
    this._checkBeats();

    // The light rides the scribe line out to the point, then sits on the seal.
    this._scribePoint(this.u, this.position);

    this._scribeFx();
    this._sealFx(dt, 1, this._igniteAmount());
    this.ctx.shake.rumble(settings.runeseal.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    // Nothing fires here. The seal's beats are on its own clock and the arrival
    // of the scribe line is not one of them — putting the ignition here made a
    // seal cast at four metres catch before it had finished being written.
    this._centrePoint(this.position);
  }

  onFade(dt, t) {
    const c = settings.runeseal;
    if (this._discharged) this._dischargeAge += dt;
    this._checkBeats();

    // `t` runs 0..1 while the seal stands, then 1..2 while it burns down. The
    // burn-down is two things at once: the fire coming out of the ink (`scorch`,
    // which is what leaves the scar) and the quad going out (`fade`, cubic, so
    // the seal hangs on and then lets go rather than dimming evenly).
    const out = saturate(t - 1);
    // Charring is keyed to the discharge, not to the phase: the fire leaves the
    // ink over the back half of the column's life, so by the time the quad
    // starts to go the writing is already a scar and the fade is only taking
    // away what is left of the glow.
    const scorch = saturate(this._dischargeAmount() * 2 - 1);
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(out);

    this._sync(fade, scorch);

    // The light climbs into the column while it is up and settles back onto the
    // scar when it has gone.
    this._centrePoint(this.position);
    this.position.y =
      c.sealHeight +
      Math.max(0.05, c.columnHeight) *
        saturate(c.lightHeight) *
        (this._discharged ? 1 - this._dischargeAmount() * 0.6 : 0);

    this._sealFx(dt, fade * (t <= 1 ? 1 : 0.45), this._igniteAmount());
    this.ctx.shake.rumble(c.rumble * fade * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._live = 1;
    this._ignited = false;
    this._discharged = false;
    this._dischargeAge = 0;
    this.field.setVisible(false);
    this.column.visible = false;
    this.wave.visible = false;
  }

  dispose() {
    this.field.dispose();
    this.column.dispose();
    this.wave.dispose();
    super.dispose();
  }
}
