import { Mesh, Vector3 } from 'three';
import { Ability } from '../Ability.js';
import { Shell, ShellMode } from '../../vfx/Shell.js';
import { sceneHooks, Hook } from '../../vfx/SceneHooks.js';
import { acquireGroundQuad, releaseGroundQuad } from '../../vfx/quads.js';
import { createUmbraMaterial } from '../../materials/UmbraMaterial.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;

/**
 * How many points one frame's drain motes are split between.
 *
 * The dust is coming in off a whole *ring*, and a ring sampled at one bearing
 * per frame reads as a single thin stream orbiting the disc rather than as the
 * air closing in. Four is the fewest that reads as a circle.
 */
const DRAIN_ARCS = 4;

/* --- module-scope scratch. Nothing below allocates during a cast (I3) --- */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();

/**
 * ECLIPSE — the light goes wrong before the disc appears.
 *
 * **The trick is the order.** Every other slot in the project opens with
 * geometry; this one opens with the *frame* going quietly wrong and nothing on
 * screen to explain it. Through the whole travel phase — a deliberately slow one,
 * which is what `speed: 34` is buying — colour drains out of the picture, the
 * corners close in, the black level is crushed, and the key light cools and
 * dims. Only once that has landed does the umbra open, and by then the shot has
 * already told you something is arriving. It is the Thunderclap lesson applied
 * to light: the anticipation carries it, and the anticipation is made of two
 * scene hooks and no triangles at all.
 *
 * ### The two hooks
 *
 *  - **`Hook.GRADE`** — `saturate`, `temper`, `raise` and `darken`, blended from
 *    `settings.post` by a weight which *is* the anticipation curve. Weight, not
 *    a hand-rolled lerp: the hook already interpolates from whatever the post
 *    sliders say, so an editor that has turned saturation down keeps its own
 *    look and the ability still drains *relative to it*.
 *  - **`Hook.KEY_LIGHT`** — `tint()` and `brightness()` only. **`aim()` is never
 *    called**, and that is the whole difference between this and Dawnbreak next
 *    door: an eclipse does not move the sun, it stands in front of it, so every
 *    shadow on the stage has to stay exactly where it is and merely go cold and
 *    weak. The version that swung the light read as a second sunset, which is a
 *    completely different event.
 *
 * ### The disc, and why it takes two draw calls
 *
 * The corona is `vfx/Shell.js` in `SUNDISC`, with `fill`, `granule` and `rim` at
 * zero so the shell contributes nothing but the filaments licking off the rim.
 * The black middle cannot be the shell's: a `Shell` is additive and the darkest
 * mark additive blending can make is *nothing*. So the umbra is its own
 * `NormalBlending` quad (`materials/UmbraMaterial.js`) which genuinely removes
 * the floor underneath it, and it is sized from `corona.radius` — the shell's
 * live, eased radius, read back rather than recomputed — so the two can never
 * drift apart while a slider is being dragged.
 *
 * **Baily's beads** flash across second contact, at `beadAt` through the
 * opening: hashed bright spots pinned to the limb, unevenly spaced and unevenly
 * bright, because nine identical dots on a circle read as a dial. They are the
 * one moment the ability is bright, and they are what the corona sparks and the
 * screen flash hang off.
 *
 * ### The rule that makes the editor work
 *
 * A cast captures one dice roll (`_seed`, for the corona filaments and the bead
 * pattern) and one one-way flag (`_contact`, so a slider drag cannot re-fire
 * second contact). Not one metre, radian or second is stored: the opening is
 * `t × impactDuration / openTime` re-derived every frame, the umbra's radius is
 * the shell's, and both hooks are re-authored from `settings.eclipse` on every
 * frame including a zero-length one. Pause with **P** during totality and drag
 * `gradeVignette` and the corners of the *stopped frame* close in; drag
 * `discRadiusEnd` and the disc and its corona grow together.
 *
 * Both hooks are borrowed through `this.borrow(...)`, so they come back however
 * the cast ends. That matters more here than almost anywhere: a leaked grade
 * hook leaves the whole game desaturated for the rest of the session, with
 * nothing on screen to say why.
 */
export class EclipseAbility extends Ability {
  constructor(context) {
    super('eclipse', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * The corona. `SUNDISC` already draws domain-warped filaments in the plane
     * rather than on `atan(y, x)` — see the long note in `vfx/Shell.js` about
     * why the obvious version draws a firework — so this is configuration, not
     * a new renderer. 128 segments because the limb is a hard edge held right
     * next to the umbra's, and 96 shows facets at the radius this thing runs at.
     */
    this.corona = new Shell({
      mode: ShellMode.SUNDISC,
      prefix: 'disc',
      segments: 128,
      // Down at ground-effect order rather than the module's default 14. Both
      // halves of the disc lie on the floor, so they belong *under* every
      // particle system in the project (10 and 12) — otherwise the umbra paints
      // over the ability's own drain motes hanging in the air above it, which
      // reads as the dust being swallowed a metre early.
      renderOrder: 5
    });
    this.group.add(this.corona.group);

    /**
     * The umbra. Immediately under the corona in render order, so the filaments
     * add on top of the black rather than being covered by it.
     */
    this.umbraMaterial = createUmbraMaterial();
    this.umbra = new Mesh(acquireGroundQuad(), this.umbraMaterial);
    this.umbra.frustumCulled = false;
    this.umbra.matrixAutoUpdate = false;
    this.umbra.layers.set(LAYER.VFX);
    this.umbra.renderOrder = 4;
    this.umbra.name = 'Umbra';
    this.group.add(this.umbra);

    /** The two borrowed pieces of the world. Null outside a cast. */
    this.grade = null;
    this.key = null;

    /** The one dice roll: the corona's filaments and the bead pattern. */
    this._seed = 0;
    /** One-way: second contact has fired. A slider drag must not re-fire it. */
    this._contact = false;
    /** 0..1 bead flash, recomputed every frame; `lightShimmer()` reads it. */
    this._flare = 0;

    /** The circle, rewritten every frame from the live cast. */
    this._centre = new Vector3();

    /** Scratch state handed to the shell. One object, reused. */
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

    // The drain: dust hauled in toward the umbra while the world goes wrong.
    // Non-additive, because it is the *colour leaving* and additive dust adds
    // light — which is the opposite sentence.
    this.drain = particles.get('eclipse.drain', {
      capacity: 1100,
      shape: ParticleShape.SOFT,
      additive: false,
      curl: true,
      softFade: 0.5
    });
    this.drain.uniforms.uDrag.value = 0.9;
    this.drain.uniforms.uEndSize.value = 0.35;
    this.drain.uniforms.uSizeIn.value = 0.08;
    this.drain.uniforms.uFadeIn.value = 0.14;
    this.drain.uniforms.uFadeOut.value = 0.5;

    // The corona sparks: velocity-stretched streaks thrown off the limb.
    this.sparks = particles.get('eclipse.sparks', {
      capacity: 900,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.3
    });
    this.sparks.uniforms.uDrag.value = 1.3;
    this.sparks.uniforms.uEndSize.value = 0.2;
    this.sparks.uniforms.uSizeIn.value = 0.03;
    this.sparks.uniforms.uFadeIn.value = 0.05;
    this.sparks.uniforms.uFadeOut.value = 0.45;

    this.drainEmitter = new RateEmitter();
    this.sparkEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing — every beat re-derived from settings                        */
  /* ------------------------------------------------------------------ */

  /**
   * A beat's length in seconds, under the global lifetime knob.
   *
   * Everything that reads a clock here goes through this, `impactDuration`
   * included — scaling the phase without scaling the beats inside it leaves
   * the disc finished a second before the phase machine notices.
   */
  _span(seconds) {
    return Math.max(0.01, seconds * settings.global.lifetime);
  }

  /** The impact phase holds second contact and the whole of totality. */
  get impactDuration() {
    const c = settings.eclipse;
    return this._span(c.openTime) + this._span(c.holdTime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.eclipse.closeTime);
  }

  /** The shell's one instance, plus the umbra. HUD readout. */
  get instanceCount() {
    return 2;
  }

  /**
   * The light is the corona, so it is bright at the beads and almost gone at
   * totality — not a flicker. `_flare` is written by `_sync()` on the same frame
   * the base class reads this back.
   */
  lightShimmer() {
    return lerp(saturate(settings.eclipse.lightTotality), 1, this._flare);
  }

  /* ------------------------------------------------------------------ */
  /* Geometry and beats                                                  */
  /* ------------------------------------------------------------------ */

  /** Where the disc lands: the far end of the aimed line, on the floor. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /**
   * How far through the opening we are, 0..1.
   *
   * Derived from the phase's own normalised clock rather than from a counter,
   * so `openTime` and `holdTime` can both be dragged mid-cast and the opening
   * re-times itself against a phase whose length is changing underneath it.
   */
  _openAmount(t) {
    return saturate((Math.min(t, 1) * this.impactDuration) / this._span(settings.eclipse.openTime));
  }

  /** The bead flash, 0..1 — a window centred on `beadAt` through the opening. */
  _beadAmount(open) {
    const c = settings.eclipse;
    const d = Math.abs(open - saturate(c.beadAt)) / Math.max(1e-3, c.beadWindow);
    const k = Math.max(0, 1 - d);
    // Squared, so the flash has a point rather than a plateau.
    return k * k;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.drainEmitter.reset();
    this.sparkEmitter.reset();
    this._contact = false;
    this._flare = 0;
    this._seed = Math.random() * 100;

    // Both hooks, taken at the start of the cast rather than at second contact,
    // because the anticipation is the first beat and it starts now.
    this.grade = this.borrow(sceneHooks.acquire(Hook.GRADE, this));
    this.key = this.borrow(sceneHooks.acquire(Hook.KEY_LIGHT, this));

    this._sync(0, 0, 0);
  }

  /* ------------------------------------------------------------------ */
  /* The one frame update                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings into both hooks, the corona, the umbra and the two
   * particle systems.
   *
   * @param {number} wrong 0..1 how far the world has been driven toward totality
   * @param {number} open  0..1 how far the disc has opened
   * @param {number} fade  1 while the disc stands, ramping to 0 as it lets go
   */
  _sync(wrong, open, fade) {
    const c = settings.eclipse;
    const g = settings.global;

    this._centrePoint(this._centre);
    const drive = saturate(wrong);

    /* ---------------- the two hooks ---------------- */
    // `blend()` is the anticipation: at weight 0 both hooks are transparent and
    // the world is exactly what the environment and post sliders say.
    if (this.grade) {
      this.grade
        .saturate(c.gradeSaturation)
        .temper(c.gradeTemper)
        .raise(c.gradeLift)
        .darken(c.gradeVignette)
        .blend(drive * saturate(c.gradeWeight));
    }
    if (this.key) {
      // No aim(). The sun does not move; something gets in front of it.
      this.key.tint(getColor(c.colorCold)).brightness(c.keyDim).blend(drive * saturate(c.keyWeight));
    }

    /* ---------------- the corona ---------------- */
    const s = this._shell;
    s.origin.copy(this._centre);
    s.axis.set(0, 1, 0);
    s.side.copy(this.side);
    s.span = Math.max(0.05, c.zoneRadius);
    s.t = saturate(open);
    s.fade = fade;
    s.seed = this._seed;
    this.corona.sync(c, s);

    /* ---------------- the umbra ---------------- */
    // The shell's own eased radius, read back rather than recomputed. Two
    // copies of the easing is two discs that disagree the moment `discExpand`
    // is dragged, and the disagreement shows as a corona that has slipped off
    // its own limb.
    const radius = Math.max(0.01, this.corona.radius * c.umbraScale);
    this._flare = this._beadAmount(saturate(open)) * fade;

    const u = this.umbraMaterial.uniforms;
    u.uCentre.value.copy(this._centre);
    u.uCentre.value.y = c.umbraLift;
    u.uRadius.value = radius;
    u.uReach.value = Math.max(1.02, c.umbraReach);
    u.uSeed.value = this._seed;
    u.uFade.value = fade;
    u.uEdge.value = c.umbraEdge;
    u.uShade.value = c.umbraShade;
    u.uOpacity.value = c.umbraOpacity * g.opacity;
    u.uRim.value = c.rimGlow * g.glow;
    u.uRimWidth.value = c.rimWidth;
    u.uBead.value = this._flare * c.beadFlash;
    u.uBeadCount.value = c.beadCount;
    u.uBeadSize.value = c.beadSize;
    u.uBeadWidth.value = c.beadWidth;
    u.uBeadSpin.value = c.beadSpin;
    u.uColorUmbra.value.copy(getColor(c.colorUmbra));
    u.uColorLimb.value.copy(getColor(c.colorLimb));
    u.uColorBead.value.copy(getColor(c.colorBead));

    /* ---------------- the particles ---------------- */
    this.drain.setGradient(
      getColor(c.colorDrainA),
      getColor(c.colorDrainB),
      getColor(c.colorDrainC),
      getColor(c.colorDrainD)
    );
    this.drain.uniforms.uGravity.value.set(0, c.drainRise, 0);
    this.drain.uniforms.uSizeScale.value = c.drainSize * g.particleSize * 7;
    this.drain.uniforms.uLifeScale.value = c.drainLifetime * 0.5 * g.particleLifetime;
    this.drain.uniforms.uSpeedScale.value = g.particleSpeed;
    this.drain.uniforms.uOpacity.value = g.opacity;
    this.drain.uniforms.uTurbulence.value = c.drainTurbulence * g.turbulence;

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
    this.sparks.uniforms.uGlow.value = c.rimGlow * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;

    /* ---------------- the local light ---------------- */
    this.position.copy(this._centre);
    this.position.y = c.lightHeight;
  }

  /**
   * Dust hauled in off a ring toward the umbra.
   *
   * @param {number} dt
   * @param {number} scale 0..1 — how hard the world is being drained
   */
  _drainFx(dt, scale) {
    const c = settings.eclipse;
    const g = settings.global;
    let count = Math.round(this.drainEmitter.tick(dt, c.drainRate * scale) * g.particleCount);
    if (count <= 0) return;

    const ring = Math.max(0.2, c.zoneRadius * c.drainRadius);

    _emit.radius = c.drainJitter;
    _emit.speed = c.drainSpeed;
    _emit.speedVariance = 0.5;
    // A tight cone: these are being *pulled*, and a wide spread turns the whole
    // thing back into ordinary drifting dust.
    _emit.spread = 0.22;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.6;
    _emit.life = c.drainLifetime;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;

    const batches = Math.min(count, DRAIN_ARCS);
    const per = Math.ceil(count / batches);
    while (count > 0) {
      const angle = randRange(0, TAU);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      _pos.set(
        this._centre.x + cos * ring,
        randRange(0.05, Math.max(0.06, c.drainHeight)),
        this._centre.z + sin * ring
      );
      _emit.position = _pos;
      _emit.direction = _dir.set(-cos, 0, -sin).normalize();
      this.drain.emit(Math.min(per, count), _emit);
      count -= per;
    }
  }

  /**
   * Sparks off the limb.
   *
   * @param {number} count how many
   * @param {number} speedScale × `sparkSpeed`
   */
  _sparkFx(count, speedScale) {
    if (count <= 0) return;
    const c = settings.eclipse;
    const radius = Math.max(0.01, this.corona.radius * c.umbraScale);

    _emit.radius = radius * 0.06;
    _emit.speed = c.sparkSpeed * speedScale;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.55;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;

    // Spread round the limb rather than fired from one bearing: the beads are
    // all over the circle and a single origin makes them one firework.
    const batches = Math.min(count, DRAIN_ARCS);
    const per = Math.ceil(count / batches);
    let left = count;
    while (left > 0) {
      const angle = randRange(0, TAU);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      _pos.set(
        this._centre.x + cos * radius,
        c.umbraLift + radius * 0.04,
        this._centre.z + sin * radius
      );
      _emit.position = _pos;
      // Outward along the limb and slightly up — a prominence, not a fountain.
      _emit.direction = _dir.set(cos, 0.55, sin).normalize();
      this.sparks.emit(Math.min(per, left), _emit);
      left -= per;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.eclipse;
    // The anticipation. `wrongCurve` above 1 holds the world normal for most of
    // the reach and then commits, which is what makes the drain read as
    // something arriving rather than as a slow dissolve.
    const wrong =
      Math.pow(saturate(this.u), Math.max(0.05, c.wrongCurve)) * saturate(c.anticipateWeight);
    this._sync(wrong, 0, 0);
    this._drainFx(dt, wrong);
  }

  onImpact() {
    // Nothing fires here. Second contact is `beadAt` through the *opening*, not
    // the instant the front lands — the disc has to be most of the way open
    // before the beads mean anything.
    this._sync(settings.eclipse.anticipateWeight, 0, 0);
  }

  onFade(dt, t) {
    const c = settings.eclipse;
    const g = settings.global;
    const open = this._openAmount(t);
    const letGo = t <= 1 ? 1 : 1 - Easing.inOutQuad(saturate(t - 1));

    // The world keeps going wrong through the opening: the anticipation only
    // spent `anticipateWeight` of the drain, and the rest is spent here.
    const wrong = lerp(saturate(c.anticipateWeight), 1, open) * letGo;
    this._sync(wrong, open, letGo);

    if (!this._contact && open >= saturate(c.beadAt)) {
      this._contact = true;
      this._sparkFx(Math.round(c.sparkBurst * g.particleCount), 1.6);
      this.ctx.flash.trigger(getColor(c.colorFlash), c.contactFlash * g.explosionIntensity);
      this.lightBoost = c.lightIntensity * 0.9 * g.explosionIntensity;
    }

    // Totality still throws the odd prominence, and the drain thins out but
    // never quite stops until the disc lets go.
    this._sparkFx(Math.round(this.sparkEmitter.tick(dt, c.sparkRate * open * letGo) * g.particleCount), 1);
    this._drainFx(dt, wrong * 0.45);
  }

  onDestroy() {
    // Explicit as well as borrowed. A leaked grade hook leaves the whole game
    // desaturated with nothing on screen to explain it, and both releases are
    // idempotent, so belt and braces costs nothing.
    this.grade?.release();
    this.key?.release();
    this.grade = null;
    this.key = null;
    this._contact = false;
    this._flare = 0;
    this.umbraMaterial.uniforms.uFade.value = 0;
    this.corona.material.uniforms.uFade.value = 0;
  }

  dispose() {
    this.corona.dispose();
    this.umbraMaterial.dispose();
    // The quad is refcounted and shared with every other ground effect.
    releaseGroundQuad();
    super.dispose();
  }
}
