import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { Shell, ShellMode, shellKeys, BurstMode } from '../../vfx/Shell.js';
import { DistortionField, DistortionMode } from '../../vfx/Distortion.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, Easing, randRange } from '../../utils/math.js';

/**
 * Distortion emitters built at construction. Four is the useful number: the
 * pockets are placed on every `stride`-th antinode, so four of them span an
 * eight-antinode line, and a fifth costs a draw call to sit somewhere a
 * neighbour is already shaking.
 */
const MAX_POCKETS = 4;

/** Instance capacity of the ring train. `chordRings` clamps here. */
const RING_CAPACITY = 24;

/* Module-scope scratch — I3. Nothing below allocates on a frame. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _node = new Vector3();
const _next = new Vector3();
const _far = new Vector3();
/** The params object every pocket is driven through, refilled per emitter. */
const _shock = {};

/**
 * RESONANCE — a chord struck down the aimed line.
 *
 * Three beats, one per phase:
 *
 *   1. **strike** — a front runs out from the caster's hand and a train of
 *      compression rings follows it. The reflecting end of the run *is* the
 *      front, so the train shortens and stiffens as the line is drawn: there is
 *      nothing to interfere with yet, and `reflect` is held at zero, which is
 *      simply the truth — no wave has come back.
 *   2. **ring** — the long hold. The moment the front lands, a wavefront
 *      leaving the hand starts its journey to the far end; `establishTrips`
 *      crossings later the standing pattern is fully formed, and it builds over
 *      exactly that time rather than over a number somebody typed.
 *   3. **decay** — the reflection damps. `reflect` falls to zero, so the
 *      envelope's grip on the train loosens and the nodes smear back into a
 *      plain outbound line before the whole thing goes out.
 *
 * **THE TRICK — the nodes are real.** `vfx/Shell.js#RING_TRAIN` folds each ring
 * off the far end and multiplies it by the analytic superposition of the
 * outbound wave with its reflection, `|sin(k(s − L))| · |cos(ωt − kL)|`. A ring
 * standing on a node pinches to the axis and goes dark; a ring on an antinode
 * blooms and swells. Nothing in this file draws a node marker. What it does
 * instead is *ask*:
 *
 *   - `nodePosition(i)` — where the still places are, so a pocket can be put
 *     halfway between two of them and nowhere near either;
 *   - `standingAt(s)` — how hard the air is being worked at that metre, which
 *     is the pockets' strength, the dust's emission rate and the light's pulse;
 *   - `resonantSpacing(n)` — the wavelength that fits `halfWaves` half-waves on
 *     *this* cast, fed straight back into the shell so the pattern stands still
 *     instead of sliding along the line.
 *
 * That last one is the difference between "some of the rings are dimmer" and
 * "this line is resonating", and it is worth watching the `lockSpacing` slider
 * to see it: at 0 the wavelength is whatever `chordSpacing` says and the whole
 * pattern crawls; at 1 it snaps to the mode and the dark bands nail themselves
 * to the floor.
 *
 * **The overlay.** Two of the shell's keys are computed rather than authored —
 * the locked wavelength and the ring count that tiles it — and one is beaten by
 * the ability's clock (`reflect`). The first version did what the library's own
 * example does and wrote them straight back into `settings.resonance`; the
 * editor's `chordSpacing` slider then snapped back on every frame and a saved
 * preset recorded a number the user had never chosen. So the ability keeps one
 * object whose prototype **is** the live settings block and writes only those
 * three keys onto it: every other key resolves through the prototype, live, and
 * the block itself is never written to.
 *
 * A cast captures a unitless seed and two timestamps (when the front landed,
 * when the reflection arrived). Nothing with a unit survives a frame.
 */
export class ResonanceAbility extends Ability {
  constructor(context) {
    super('resonance', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the train: 1 draw call, however many rings --- */
    this.chord = new Shell({
      mode: ShellMode.RING_TRAIN,
      prefix: 'chord',
      rings: RING_CAPACITY,
      // A compression ring is read entirely from its silhouette, so the facet
      // count around it is the only tessellation that matters.
      segments: 108,
      renderOrder: 14
    });
    this.group.add(this.chord.group);

    /** The shell's unprefixed → prefixed key map, built once. */
    this.keys = shellKeys('chord');

    /* --- the pockets: 1 draw call each, and nothing visible of their own --- */
    this.pockets = [];
    for (let i = 0; i < MAX_POCKETS; i++) {
      const field = new DistortionField({
        mode: DistortionMode.SHOCK,
        name: `resonance.pocket${i}`
      });
      field.visible = false;
      this.group.add(field.object3D);
      this.pockets.push(field);
    }

    /**
     * The overlay: an object whose prototype is the live settings block.
     *
     * `settings.resonance` is mutated in place by `applySettings` and by the
     * editor — its identity never changes — so this stays welded to it for the
     * life of the process, and the three own properties below are the only
     * values the shell sees that the panel did not author directly.
     */
    this._tuned = Object.create(settings.resonance);

    /** Scratch state handed to the shell each frame. One object, reused. */
    this._state = {
      origin: new Vector3(),
      axis: new Vector3(0, 0, 1),
      side: new Vector3(1, 0, 0),
      span: 1,
      t: 0,
      fade: 1,
      seed: 0
    };

    /** The one dice roll a cast keeps. */
    this._seed = 0;
    /** Timestamps: seconds into the cast. Events, not dimensions. */
    this._struckAt = -1;
    this._reflectedAt = -1;
    /** Derived every frame and read by `lightShimmer()`; never carried over. */
    this._breath = 1;
    this._establish = 0;
    this._liveSpan = 1;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The motes lifted where the air is being compressed. Additive: this is
    // charged air catching the light of the chord, not smoke.
    this.dust = particles.get('resonance.dust', {
      capacity: 2000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.dust.uniforms.uDrag.value = 1.5;
    this.dust.uniforms.uEndSize.value = 0.2;
    this.dust.uniforms.uSizeIn.value = 0.05;
    this.dust.uniforms.uFadeIn.value = 0.08;
    this.dust.uniforms.uFadeOut.value = 0.4;

    // Grit hopping off the floor under an antinode. Non-additive and lit — the
    // read is "the ground is being shaken here and not two metres along".
    this.grit = particles.get('resonance.grit', {
      capacity: 1200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.grit.uniforms.uDrag.value = 0.3;
    this.grit.uniforms.uEndSize.value = 0.7;
    this.grit.uniforms.uFadeOut.value = 0.7;

    // Sparks for the two events, and for anyone who turns `sparkRate` up.
    this.sparks = particles.get('resonance.sparks', {
      capacity: 2000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.3;
    this.sparks.uniforms.uEndSize.value = 0.25;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.45;

    this.dustEmitter = new RateEmitter();
    this.gritEmitter = new RateEmitter();
    this.sparkEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.chord.instanceCount;
  }

  /** It rings for `lifetime`, then damps over `fadeTime`. */
  get impactDuration() {
    return Math.max(0.05, settings.resonance.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.resonance.fadeTime);
  }

  /**
   * The light rides the standing wave's own temporal term.
   *
   * `_breath` is `standingAt()` sampled on an antinode, which is
   * `|cos(ωt − kL)|` — the part of the superposition that pulses the whole line
   * together. So the room brightens and darkens *in time with the pattern*
   * rather than on a shimmer of its own, and that agreement is most of what
   * sells the effect as one physical thing.
   */
  lightShimmer() {
    const c = settings.resonance;
    return 1 - c.lightPulse + c.lightPulse * this._breath;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** Where the chord is struck: at the hand, on the aimed line. */
  _strikePoint(out) {
    const c = settings.resonance;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.originForward)
      .addScaledVector(this.side, c.originSide);
    out.y = c.lineHeight;
    return out;
  }

  /**
   * The antinode `i` half-wavelengths back from the reflecting end.
   *
   * Deliberately built out of two `nodePosition()` calls rather than out of
   * arithmetic on `span` and `spacing`: an antinode is *by definition* halfway
   * between two nodes, and asking the module where the nodes are means the
   * pockets cannot drift away from the dark bands the shader is drawing.
   */
  _antinodePoint(i, out) {
    this.chord.nodePosition(i, out);
    this.chord.nodePosition(i + 1, _next);
    return out.lerp(_next, 0.5);
  }

  /** How many antinodes the run currently holds — one fewer than the nodes. */
  get antinodeCount() {
    return Math.max(1, this.chord.nodeCount - 1);
  }

  /** Which antinode the `i`-th pocket sits on, so four of them span the line. */
  _pocketIndex(i, want) {
    const stride = Math.max(1, Math.floor(this.antinodeCount / Math.max(1, want)));
    return Math.min(i * stride, this.antinodeCount - 1);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.dustEmitter.reset();
    this.gritEmitter.reset();
    this.sparkEmitter.reset();

    this._seed = Math.random() * 100;
    this._struckAt = -1;
    this._reflectedAt = -1;
    this._breath = 1;
    this._establish = 0;

    this.chord.visible = true;
    this._sync(1);
    this._strikeFx();
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Re-resolve everything and push it into the shell, the four pockets and the
   * three particle systems.
   *
   * The shell is synced **first**, because `standingAt`, `nodePosition` and
   * `nodeCount` all read the dimensions that sync resolved. Query before
   * syncing and every pocket is placed on last frame's pattern — which is
   * invisible until a slider moves, and then very visible indeed.
   *
   * @param {number} fade 1 while the chord rings, ramping to 0 as it damps
   */
  _sync(fade) {
    const c = settings.resonance;
    const g = settings.global;
    const K = this.keys;
    const state = this._state;
    const travelling = this.phase === AbilityPhase.TRAVEL;

    /* --- 1 · the run ---------------------------------------------------- */
    this._strikePoint(state.origin);
    state.axis.copy(this.direction);
    state.side.copy(this.side);
    // While the front is still going out it *is* the reflecting end, so the
    // run is only as long as the line that has been drawn.
    const reach = (travelling ? this.u : 1) * this.length - c.originForward;
    state.span = Math.max(0.3, reach);
    this._liveSpan = state.span;
    state.seed = this._seed;
    state.fade = fade;

    /* --- 2 · how far the pattern has got ------------------------------- */
    // Metres a wavefront leaving the hand at the moment of the strike has
    // covered. A live rate against a timestamp — no distance is integrated,
    // so dragging the ring speed while paused re-answers the question.
    const sinceStrike = this._struckAt >= 0 ? this.age - this._struckAt : 0;
    const travelled = sinceStrike * c.chordRingSpeed * g.speed;
    const trips = Math.max(0.05, c.establishTrips);
    this._establish = travelling ? 0 : saturate(travelled / (state.span * trips));
    const decay = this.phase === AbilityPhase.FADE ? saturate(this.fadeTime / this.fadeDuration) : 0;
    state.t = this._establish;

    /* --- 3 · the overlay: the three keys the ability computes ---------- */
    const tuned = this._tuned;
    const lock = saturate(c.lockSpacing);
    // `resonantSpacing` reads the span the shell was last given, so on the one
    // frame the span changes the lock is a frame behind. That is only true
    // while the front is travelling — and while it is travelling `reflect` is
    // zero and there is no pattern to be behind on.
    tuned[K.spacing] = lerp(c.chordSpacing, this.chord.resonantSpacing(c.halfWaves), lock);
    // A wavelength that fits `n` half-waves needs exactly `n` rings to tile the
    // 2L cycle it folds on. Fewer leaves gaps in the train, more stacks two
    // rings on the same metre and reads as one bright one.
    tuned[K.rings] = lerp(c.chordRings, Math.round(c.halfWaves), lock);
    tuned[K.reflect] = c.chordReflect * this._establish * (1 - Easing.inQuad(decay));
    this.chord.sync(tuned, state, g);

    /* --- 4 · the pockets, on the antinodes and nowhere else ------------ */
    const want = clamp(Math.round(c.pockets), 0, MAX_POCKETS);
    // A pocket is a *standing* compression, so it does not exist until there is
    // a standing wave for it to stand in. Before the reflection the envelope is
    // flat at 1 along the whole run — the honest answer for a travelling train,
    // and exactly the wrong thing to hang four pockets of shaking air on. The
    // first build did that, and the strike beat looked like the ring beat with
    // the rings turned down.
    const established = this._establish;
    // The breath — the temporal half of the superposition, sampled on the first
    // antinode. Read by `lightShimmer()` and by the rumble, and computed here
    // whether or not a single pocket is drawn, so turning `pockets` down to
    // zero does not stop the room pulsing.
    this._antinodePoint(0, _pos);
    this._breath = saturate(this.chord.standingAt(_pos.distanceTo(state.origin)));

    for (let i = 0; i < MAX_POCKETS; i++) {
      const field = this.pockets[i];
      // Pocket 0 is the exception: it rides the strike front while the wave is
      // still outbound, so the beat before the pattern exists is a *travelling*
      // compression, which is the truth. It then glides onto its antinode as
      // the reflection establishes.
      const riding = i === 0;
      if (i >= want || fade <= 0.01 || (established <= 0.02 && !riding)) {
        // Toggling the field itself, never the parent: hiding the group would
        // leak the pass's writer counter for the rest of the session.
        field.visible = false;
        continue;
      }

      // Metres along the run — measured off the point the module placed, not
      // recomputed from the spacing, so the two can never disagree.
      this._antinodePoint(this._pocketIndex(i, want), _node);
      let amp = saturate(this.chord.standingAt(_node.distanceTo(state.origin)));

      if (riding) {
        // One continuous crossfade rather than a switch: position *and*
        // amplitude are interpolated on `established`, because a pocket that
        // pops from the wavefront onto a node is a cut, and the ear — well,
        // the eye — hears it.
        _pos.copy(state.origin).addScaledVector(state.axis, state.span).lerp(_node, established);
        amp = lerp(1, amp, established);
      } else {
        _pos.copy(_node);
        amp *= established;
      }

      field.visible = true;
      field.setAnchor(_pos);
      _shock.width = c.pocketWidth;
      _shock.height = c.pocketHeight;
      _shock.radius = c.pocketRadius;
      _shock.window = c.pocketWindow;
      _shock.wave = c.pocketWave;
      _shock.thickness = c.pocketThickness;
      _shock.compression = c.pocketCompression;
      _shock.rarefaction = c.pocketRarefaction;
      _shock.rings = c.pocketRings;
      _shock.ringGap = c.pocketRingGap;
      _shock.ringDecay = c.pocketRingDecay;
      // The amplitude is the superposition and nothing else. The mask is the
      // radius falloff, which the module already owns — authoring the two
      // separately is that file's one rule.
      _shock.strength = c.pocketStrength * amp * fade;
      _shock.maxOffset = c.pocketMaxOffset;
      _shock.opacity = c.pocketOpacity;
      _shock.depthReject = c.pocketDepthReject;
      _shock.depthFade = c.pocketDepthFade;
      _shock.perspective = c.pocketPerspective;
      _shock.perspectiveRef = c.pocketPerspectiveRef;
      _shock.seed = this._seed + i;
      field.update(_shock);
    }

    /* --- 5 · the particle systems -------------------------------------- */
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
    this.dust.uniforms.uGlow.value = 1.1 * g.glow;
    this.dust.uniforms.uTurbulence.value = c.dustTurbulence * g.turbulence;

    this.grit.setGradient(
      getColor(c.colorGritA),
      getColor(c.colorGritB),
      getColor(c.colorGritC),
      getColor(c.colorGritD)
    );
    this.grit.uniforms.uGravity.value.set(0, c.gritGravity, 0);
    this.grit.uniforms.uSizeScale.value = c.gritSize * g.particleSize * 7;
    this.grit.uniforms.uLifeScale.value = c.gritLifetime * 0.5 * g.particleLifetime;
    this.grit.uniforms.uSpeedScale.value = g.particleSpeed;
    this.grit.uniforms.uOpacity.value = g.opacity;

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
    this.sparks.uniforms.uGlow.value = 1.4 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
  }

  /**
   * Dust and grit, emitted at the antinodes with a count proportional to how
   * hard the air is working there — so the nodes get literally nothing and the
   * pattern is legible in the particles alone, with the rings turned off.
   *
   * @param {number} dt
   * @param {number} scale 0..1 — how much of the pattern has established
   */
  _antinodeFx(dt, scale) {
    const c = settings.resonance;
    const g = settings.global;
    const time = frame.uTime.value;
    const count = this.antinodeCount;
    const origin = this._state.origin;

    let dustBudget = Math.round(this.dustEmitter.tick(dt, c.dustRate * scale) * g.particleCount);
    let gritBudget = Math.round(this.gritEmitter.tick(dt, c.gritRate * scale) * g.particleCount);
    const sparkBudget = Math.round(this.sparkEmitter.tick(dt, c.sparkRate * scale) * g.particleCount);
    if (dustBudget <= 0 && gritBudget <= 0 && sparkBudget <= 0) return;

    // The budget is shared out over the antinodes, not multiplied by them: an
    // eight-mode chord and a two-mode chord shed the same amount of air.
    const perDust = Math.max(1, Math.round(dustBudget / count));
    const perGrit = Math.max(1, Math.round(gritBudget / count));

    for (let i = 0; i < count; i++) {
      if (dustBudget <= 0 && gritBudget <= 0) break;
      this._antinodePoint(i, _pos);
      const amp = saturate(this.chord.standingAt(_pos.distanceTo(origin)));
      // Below a whisper the antinode is indistinguishable from a node and the
      // dust would be the only thing telling them apart, wrongly.
      if (amp < 0.15) continue;

      if (dustBudget > 0) {
        const n = Math.min(dustBudget, Math.round(perDust * amp));
        if (n > 0) {
          _emit.position = _pos;
          _emit.radius = this.chord.radius * 0.85;
          _emit.anchor = null;
          _emit.inherit = null;
          // Off the axis, not along it: the air is being squeezed sideways out
          // of the compression, which is the direction that reads.
          _emit.direction = _dir.copy(this.side).multiplyScalar(randRange(-1, 1)).setY(0.75).normalize();
          _emit.speed = c.dustSpeed * amp;
          _emit.speedVariance = 0.7;
          _emit.spread = 0.9;
          _emit.size = 1;
          _emit.sizeVariance = 0.6;
          _emit.life = c.dustLifetime;
          _emit.lifeVariance = 0.45;
          _emit.spin = 0;
          _emit.tint = null;
          _emit.time = time;
          this.dust.emit(n, _emit);
          dustBudget -= n;
        }
      }

      if (gritBudget > 0) {
        const n = Math.min(gritBudget, Math.round(perGrit * amp));
        if (n > 0) {
          _pos.y = 0.05;
          _emit.position = _pos;
          _emit.radius = this.chord.radius * 0.7;
          _emit.anchor = null;
          _emit.inherit = null;
          _emit.direction = _dir.set(0, 1, 0);
          _emit.speed = c.gritSpeed * amp;
          _emit.speedVariance = 0.6;
          _emit.spread = 0.55;
          _emit.size = 1;
          _emit.sizeVariance = 0.7;
          _emit.life = c.gritLifetime;
          _emit.lifeVariance = 0.5;
          _emit.spin = 7;
          _emit.tint = null;
          _emit.time = time;
          this.grit.emit(n, _emit);
          gritBudget -= n;
        }
      }
    }

    if (sparkBudget > 0) {
      this._antinodePoint(Math.floor(Math.random() * count), _pos);
      _emit.position = _pos;
      _emit.radius = this.chord.radius;
      _emit.anchor = null;
      _emit.inherit = null;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.sparkSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 1;
      _emit.size = 1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.sparks.emit(sparkBudget, _emit);
    }
  }

  /** The strike at the caster's hand. */
  _strikeFx() {
    const c = settings.resonance;
    const g = settings.global;

    this._strikePoint(_pos);
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.strikeSize * 0.25,
      endRadius: c.strikeSize * g.explosionIntensity,
      life: 0.45,
      intensity: c.strikeIntensity,
      opacity: 0.8,
      fresnel: 2.0,
      displace: 0.3,
      colorA: getColor(c.colorStrikeA),
      colorB: getColor(c.colorStrikeB),
      colorC: getColor(c.colorStrikeC)
    });

    _emit.position = _pos;
    _emit.radius = 0.16;
    _emit.anchor = null;
    _emit.inherit = null;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.sparkSpeed * 1.3;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.7;
    _emit.size = 1;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(c.strikeSparks * g.particleCount), _emit);

    this.ctx.shake.add(
      c.strikeShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      30
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.strikeFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.6 * g.explosionIntensity;
  }

  /**
   * The reflection, fired at the far end on the frame a wavefront that left the
   * hand at the strike first gets there.
   *
   * This is an *event*, not a schedule: the predicate is re-evaluated every
   * frame from the live ring speed and the live span, exactly as `Tube`'s whip
   * crack is, so slowing the chord down while it is in flight moves the bang.
   */
  _reflectFx() {
    const c = settings.resonance;
    const g = settings.global;

    this.pointAt(1, _far).setY(c.lineHeight);
    this.ctx.bursts.spawn(BurstMode.AIR, _far, {
      radius: c.reflectSize * 0.2,
      endRadius: c.reflectSize * g.explosionIntensity,
      life: 0.6,
      intensity: c.reflectIntensity,
      opacity: 0.85,
      fresnel: 2.2,
      displace: 0.35,
      squash: 0.7,
      colorA: getColor(c.colorStrikeA),
      colorB: getColor(c.colorStrikeB),
      colorC: getColor(c.colorStrikeC)
    });

    _emit.position = _far;
    _emit.radius = this.chord.radius * 0.8;
    _emit.anchor = null;
    _emit.inherit = null;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.6).setY(0.55).normalize();
    _emit.speed = c.sparkSpeed * 1.8;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.9;
    _emit.size = 1;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(c.reflectSparks * g.particleCount), _emit);

    this.ctx.shake.add(
      c.reflectShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      24
    );
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1);
    // The train exists behind the front, so the antinodes do too — but there is
    // no reflection yet and the pattern is a travelling one, so the dust is
    // thinned right down until the chord has something to stand on.
    this._antinodeFx(dt, 0.25);
  }

  onImpact() {
    // The only timestamp the strike beat leaves behind. Everything the ring
    // phase does is a live function of the seconds since it.
    this._struckAt = this.age;
    this._sync(1);
  }

  onFade(dt, t) {
    const c = settings.resonance;
    const decay = t <= 1 ? 0 : saturate(t - 1);
    this._sync(1 - Easing.inCubic(decay));

    // The reflection: the frame a wavefront that left the hand at the strike
    // reaches the far end. Polled, never scheduled.
    if (this._reflectedAt < 0 && this._struckAt >= 0) {
      const travelled = (this.age - this._struckAt) * c.chordRingSpeed * settings.global.speed;
      if (travelled >= this._liveSpan) {
        this._reflectedAt = this.age;
        this._reflectFx();
      }
    }

    // The light stands on the antinode nearest the middle of the run, which is
    // where the pattern is strongest and where the eye already is.
    this._antinodePoint(Math.floor(this.antinodeCount / 2), this.position);

    this._antinodeFx(dt, this._establish * (1 - decay));
    this.ctx.shake.rumble(
      c.rumble * settings.global.cameraShake * this._establish * this._breath * (1 - decay),
      dt
    );
  }

  onDestroy() {
    for (let i = 0; i < this.pockets.length; i++) this.pockets[i].visible = false;
    this.chord.visible = false;
    this._struckAt = -1;
    this._reflectedAt = -1;
  }

  dispose() {
    this.chord.dispose();
    for (let i = 0; i < this.pockets.length; i++) this.pockets[i].dispose();
    super.dispose();
  }
}
