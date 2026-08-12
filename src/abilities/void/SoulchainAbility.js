import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Vector3
} from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { FilamentPaths } from '../../vfx/FilamentPaths.js';
import { createGhostIronMaterial } from '../../materials/GhostIronMaterial.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, Easing, hash11, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;

/** Hard ceiling on the links. The live count clamps here. */
const MAX_LINKS = 56;
/**
 * Samples in the arc-length table. Forty-eight over a twenty-metre catenary is
 * a station every 40 cm, and the links are re-spaced by linear interpolation
 * between two samples, so the error in a link's position is well under a
 * millimetre — far below the width of the bar it is made of.
 */
const ARC_SAMPLES = 48;
/** Steps around one link's stadium centreline. */
const LINK_RINGS = 44;
/** Facets around the bar the link is bent from. */
const LINK_SIDES = 8;
/** Iron fragments a break may throw in one frame, whatever the sliders say. */
const MAX_BREAKS_PER_FRAME = 8;

const _emit = {};
const _pos = new Vector3();
const _prev = new Vector3();
const _dir = new Vector3();
const _from = new Vector3();
const _to = new Vector3();
const _n1 = new Vector3();
const _n2 = new Vector3();
const _sa = new Vector3();
const _sb = new Vector3();
const _tan = new Vector3();
const _ax = new Vector3();
const _ay = new Vector3();
const _az = new Vector3();
const _axis = new Vector3();
const _mat = new Matrix4();
const _rot = new Matrix4();
const _frayA = new Vector3();
const _frayB = new Vector3();

/**
 * SOULCHAIN — a tether of discrete iron links thrown down the line.
 *
 * **The trick is that the chain is not a filament.** Every other line cast that
 * hangs something between two points in this sandbox draws a ribbon and calls
 * it done; this one threads *objects* along a curve, and the objects have to
 * agree with the curve exactly or the illusion is gone on the first frame.
 *
 * The curve is `FilamentPaths`' `LINK` path — a real catenary,
 * `y −= slack · (cosh k − cosh(k(2t−1))) / (cosh k − 1)`, not a parabola. The
 * difference is entirely at the anchors, where a hanging chain leaves much
 * steeper than a parabola does, and that steepness is most of what says
 * "heavy". `_chainPoint()` is a deliberate JS mirror of that branch of the
 * vertex shader, the same duplication `Tube` makes for `pointAt()` and for the
 * same reason: reading the shape back off the GPU is a pipeline stall, and it
 * happens fifty-odd times a frame here.
 *
 * ### Spacing comes from the arc length, and that is the whole ability
 *
 * A link sits at a fixed number of **metres** along the chain, not at a fixed
 * fraction of it. So every frame the curve is walked with `ARC_SAMPLES`
 * samples, its length is accumulated, and the link count falls straight out of
 * `floor(arcLength / spacing)`. Drag `chainSag` with the clock stopped and the
 * chain visibly *grows more links* as the droop deepens, because a deeper droop
 * is a longer chain. Nothing else in this project responds to a slider by
 * changing how many of something there are.
 *
 * The first version placed links at even `t` and it was subtly, permanently
 * wrong: a catenary's `t` is not arc length, so links bunched up at the bottom
 * of the sag and stretched apart at the anchors — which is precisely backwards
 * from a real chain, and reads as the links sliding along a wire.
 *
 * Each link is rotated 90° (`linkTwist`) from its neighbour about the chain's
 * own tangent, because that is how chain is made. It matters more than it
 * sounds: with every link coplanar the chain reads as a strip of cut-outs, and
 * the alternation is the only thing that makes it look forged.
 *
 * ### The beats
 *
 * | beat | what moves |
 * | --- | --- |
 * | throw | the far anchor travels; the sag scales with the span, so the chain pays out |
 * | snap  | `chainSag → chainSagHeld` on `Easing.outBack`, which **overshoots** — the sag passes its target and the chain bows briefly *upward* before settling. An ease that only converged looked like a winch |
 * | hold  | a per-link shiver, `rattleAmp · e^(−rattleDecay·τ) · sin(rattleRate·t + phase)`, on a per-link dice phase so no two links jangle together |
 * | break | links part one at a time from the far end back at `breakRate`, and a freed link flies on a **closed form** of the time since it broke |
 *
 * Nothing integrates. A freed link's position is
 * `base + v₀·τ + ½gτ²` evaluated against live sliders, so pausing mid-collapse
 * and dragging `breakGravity` re-flies every link that has already let go —
 * which an Euler integrator physically cannot do, having already spent the old
 * gravity. `ShatterField` makes the same argument at greater length.
 *
 * A cast captures a seed, four unitless dice per link slot, and two timestamps
 * (the frame it went taut, the frame it began to break). No metres, no radians,
 * no seconds of duration.
 */
export class SoulchainAbility extends Ability {
  constructor(context) {
    super('soulchain', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the spirit thread and the fray, two roles on one strip --- */
    this.paths = new FilamentPaths(this.group, {
      samples: 80,
      capacity: 24,
      renderOrder: 11
    });

    /* --- the links --- */
    this.linkMaterial = createGhostIronMaterial(this.ctx.environment);

    // Per-instance state. These attribute objects outlive every geometry
    // rebuild and are re-attached to the new one, so the buffers are uploaded
    // once per frame however often the link *shape* changes.
    this._aStation = new InstancedBufferAttribute(new Float32Array(MAX_LINKS), 1);
    this._aSeed = new InstancedBufferAttribute(new Float32Array(MAX_LINKS), 1);
    this._aBreak = new InstancedBufferAttribute(new Float32Array(MAX_LINKS), 1);
    this._aStation.setUsage(DynamicDrawUsage);
    this._aBreak.setUsage(DynamicDrawUsage);

    /** The shape the current link geometry was built at. See `_syncLinkGeometry`. */
    this._builtLength = -1;
    this._builtWidth = -1;
    this._builtBar = -1;

    this.linkGeometry = this._buildLinkGeometry();
    this.links = new InstancedMesh(this.linkGeometry, this.linkMaterial, MAX_LINKS);
    this.links.instanceMatrix.setUsage(DynamicDrawUsage);
    this.links.count = 0;
    this.links.castShadow = true;
    this.links.receiveShadow = true;
    this.links.frustumCulled = false;
    this.links.matrixAutoUpdate = false;
    this.links.layers.set(LAYER.WORLD);
    this.links.renderOrder = 2;
    this.links.visible = false;
    this.group.add(this.links);

    /* --- per-cast state: dice rolls and timestamps only --- */
    this._seed = 0;
    /** Four unitless dice per link slot: throw bearing, pitch, spin axis, phase. */
    this._dice = new Float32Array(MAX_LINKS * 4);
    /** `age` at which the chain went taut, or −1. */
    this._tautAt = -1;
    /** `age` at which links began to part, or −1. */
    this._breakAt = -1;
    /** How many breaks have already thrown their shards. An event counter. */
    this._brokenSeen = 0;
    /** Links standing this frame, and how many of them have let go. */
    this._count = 0;
    this._broken = 0;
    /** Metres of sag resolved this frame — read by both the CPU and the strip. */
    this._sag = 0;

    /** Cumulative arc length at each sample. Rewritten every frame. */
    this._arc = new Float32Array(ARC_SAMPLES + 1);

    // The look handed to the strip. One object, reused; `FilamentPaths` reads
    // canonical names, so this is the scratch the prefixed settings fill.
    this._look = {
      width: 0.024,
      glowWidth: 6,
      glowOpacity: 0.42,
      jitter: 0.11,
      jitterScale: 1.1,
      octaves: 3,
      jitterFalloff: 0.5,
      crawl: 1.1,
      pinch: 0.12,
      restrike: 13,
      flicker: 0.18,
      flickerSpeed: 22,
      strandFlash: 0.4,
      coreSharp: 4.2,
      glowFalloff: 2.2,
      softFade: 0.6,
      opacity: 0.9,
      glow: 2.1,
      colorCore: '#ffffff',
      colorInner: '#c8fff0',
      colorOuter: '#4ec8a8',
      colorHalo: '#0d3a48',
      randomness: 1,
      noiseStrength: 1,
      noiseFrequency: 1,
      noiseSpeed: 1,
      opacityScale: 1,
      glowScale: 1
    };
  }

  /**
   * One link, swept in metres.
   *
   * The centreline is a **stadium** — two straights joined by two semicircular
   * caps — rather than an ellipse. An ellipse is one line of code shorter and
   * looks like a washer: real chain links have parallel flanks, and the
   * parallel flanks are what let two of them slide against each other, which is
   * the shape the eye is checking for.
   *
   * Sized so `linkLength` and `linkWidth` are the link's **outer** extents,
   * which is what anyone dragging a slider called "link length" means. The bar
   * radius is subtracted out of the centreline to get there.
   *
   * `aLinkSection` — the cosine and sine of each vertex's angle around the bar,
   * with the cosine measured against the ring's outward in-plane direction — is
   * how `GhostIronMaterial` finds the inside of the hole. See its header.
   */
  _buildLinkGeometry() {
    const c = settings.soulchain;
    const length = Math.max(0.02, c.linkLength);
    const width = clamp(c.linkWidth, 0.01, length * 0.98);
    const bar = clamp(c.linkThickness, 0.002, width * 0.9);

    this._builtLength = length;
    this._builtWidth = width;
    this._builtBar = bar;

    const cap = Math.max(0.002, (width - bar) * 0.5); // cap radius on the centreline
    const straight = Math.max(0, (length - width) * 0.5); // half-length of one flank
    const bore = bar * 0.5; // the swept tube's radius
    const perimeter = 4 * straight + TAU * cap;

    const vertices = LINK_RINGS * LINK_SIDES;
    const position = new Float32Array(vertices * 3);
    const normal = new Float32Array(vertices * 3);
    const section = new Float32Array(vertices * 2);

    for (let i = 0; i < LINK_RINGS; i++) {
      const s = (i / LINK_RINGS) * perimeter;

      // Walked counter-clockwise from the bottom-left of the bottom flank, so
      // (t.y, −t.x) is the outward in-plane normal the whole way round.
      let cx;
      let cy;
      let tx;
      let ty;
      if (s < 2 * straight) {
        cx = -straight + s;
        cy = -cap;
        tx = 1;
        ty = 0;
      } else if (s < 2 * straight + Math.PI * cap) {
        const phi = -Math.PI * 0.5 + (s - 2 * straight) / cap;
        cx = straight + cap * Math.cos(phi);
        cy = cap * Math.sin(phi);
        tx = -Math.sin(phi);
        ty = Math.cos(phi);
      } else if (s < 4 * straight + Math.PI * cap) {
        cx = straight - (s - 2 * straight - Math.PI * cap);
        cy = cap;
        tx = -1;
        ty = 0;
      } else {
        const phi = Math.PI * 0.5 + (s - 4 * straight - Math.PI * cap) / cap;
        cx = -straight + cap * Math.cos(phi);
        cy = cap * Math.sin(phi);
        tx = -Math.sin(phi);
        ty = Math.cos(phi);
      }

      const ox = ty;
      const oy = -tx;

      for (let j = 0; j < LINK_SIDES; j++) {
        const k = i * LINK_SIDES + j;
        const alpha = (j / LINK_SIDES) * TAU;
        const ca = Math.cos(alpha);
        const sn = Math.sin(alpha);

        position[k * 3] = cx + ox * ca * bore;
        position[k * 3 + 1] = cy + oy * ca * bore;
        position[k * 3 + 2] = sn * bore;
        normal[k * 3] = ox * ca;
        normal[k * 3 + 1] = oy * ca;
        normal[k * 3 + 2] = sn;
        section[k * 2] = ca;
        section[k * 2 + 1] = sn;
      }
    }

    // Closed in both directions. Winding derived rather than guessed:
    // cross(d/di, d/dj) works out to +N with (v00, v10, v01), which is why the
    // second triangle is (v01, v10, v11) and not the obvious (v01, v11, v10).
    const index = new Uint16Array(LINK_RINGS * LINK_SIDES * 6);
    let w = 0;
    for (let i = 0; i < LINK_RINGS; i++) {
      const iNext = (i + 1) % LINK_RINGS;
      for (let j = 0; j < LINK_SIDES; j++) {
        const jNext = (j + 1) % LINK_SIDES;
        const v00 = i * LINK_SIDES + j;
        const v01 = i * LINK_SIDES + jNext;
        const v10 = iNext * LINK_SIDES + j;
        const v11 = iNext * LINK_SIDES + jNext;
        index[w++] = v00;
        index[w++] = v10;
        index[w++] = v01;
        index[w++] = v01;
        index[w++] = v10;
        index[w++] = v11;
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(position, 3));
    geometry.setAttribute('normal', new BufferAttribute(normal, 3));
    geometry.setAttribute('aLinkSection', new BufferAttribute(section, 2));
    geometry.setAttribute('aLinkStation', this._aStation);
    geometry.setAttribute('aLinkSeed', this._aSeed);
    geometry.setAttribute('aLinkBreak', this._aBreak);
    geometry.setIndex(new BufferAttribute(index, 1));
    return geometry;
  }

  /**
   * Rebuild the link if one of its three dimensions has moved.
   *
   * `GrowthField#syncGeometry` sets the precedent: a shape that is authored in
   * metres cannot be a uniform on a shared geometry, so it is rebuilt when — and
   * only when — a number moves. The guard is what keeps it off the frame path;
   * the rebuild is what makes `linkLength` live under a paused drag.
   */
  _syncLinkGeometry() {
    const c = settings.soulchain;
    const length = Math.max(0.02, c.linkLength);
    const width = clamp(c.linkWidth, 0.01, length * 0.98);
    const bar = clamp(c.linkThickness, 0.002, width * 0.9);

    if (
      Math.abs(length - this._builtLength) < 1e-5 &&
      Math.abs(width - this._builtWidth) < 1e-5 &&
      Math.abs(bar - this._builtBar) < 1e-6
    ) {
      return false;
    }

    const old = this.linkGeometry;
    this.linkGeometry = this._buildLinkGeometry();
    this.links.geometry = this.linkGeometry;
    old.dispose();
    return true;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Iron off a parting link.
    this.shards = particles.get('soulchain.shards', {
      capacity: 900,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.shards.uniforms.uDrag.value = 0.7;
    this.shards.uniforms.uEndSize.value = 0.6;
    this.shards.uniforms.uFadeOut.value = 0.55;

    // What was bound in the iron, leaving it.
    this.motes = particles.get('soulchain.motes', {
      capacity: 1200,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.7;
    this.motes.uniforms.uEndSize.value = 0.18;
    this.motes.uniforms.uSizeIn.value = 0.07;
    this.motes.uniforms.uFadeIn.value = 0.09;
    this.motes.uniforms.uFadeOut.value = 0.42;

    // Cold breath sinking off the chain. Non-additive so it genuinely occludes
    // the links behind it — an additive haze around grey iron only ever makes
    // the iron paler.
    this.haze = particles.get('soulchain.haze', {
      capacity: 900,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.haze.uniforms.uDrag.value = 2.1;
    this.haze.uniforms.uEndSize.value = 2.4;
    this.haze.uniforms.uSizeIn.value = 0.14;
    this.haze.uniforms.uFadeIn.value = 0.2;
    this.haze.uniforms.uFadeOut.value = 0.35;

    this.moteEmitter = new RateEmitter();
    this.hazeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._count + this.paths.liveCount;
  }

  get impactDuration() {
    return Math.max(0.05, settings.soulchain.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.soulchain.fadeTime);
  }

  /**
   * The soul light does not flicker like fire; it *breathes*, on the same clock
   * as the pulse running along the links, so the light and the iron agree about
   * where the soul currently is.
   */
  lightShimmer() {
    const c = settings.soulchain;
    return 0.78 + 0.22 * Math.sin(this.age * c.soulPulseSpeed * Math.PI);
  }

  /* ------------------------------------------------------------------ */
  /* The catenary — the JS mirror of FilamentPaths' LINK branch          */
  /* ------------------------------------------------------------------ */

  /** Where the chain leaves the caster's hand. */
  _handPoint(out) {
    const c = settings.soulchain;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** How much of the throw has been paid out, 0..1. */
  get _throw() {
    return this.phase === AbilityPhase.TRAVEL ? Math.max(0.001, this.u) : 1;
  }

  /**
   * Resolve both anchors, the chain's own frame and this frame's sag.
   *
   * The sag is where the snap lives. `Easing.outBack` runs 0 → ~1.1 → 1, so
   * interpolating `chainSag → chainSagHeld` with it takes the droop *past* its
   * resting value and lets it come back: for a few frames the chain is tauter
   * than taut and bows upward. `role.link()`'s own `taut` argument is clamped
   * to 0..1 in the vertex shader and could not express that, which is why this
   * drives the `slack` metres directly and passes `taut = 0` — the strip and
   * the links then read the same number and cannot disagree.
   */
  _resolveChain() {
    const c = settings.soulchain;
    const paid = this._throw;

    this._handPoint(_from);
    this.pointAt(paid, _to);
    _to.y = lerp(c.handHeight, c.endHeight, paid);

    // The frame `FilamentPaths#axisFrame` builds, mirrored exactly: world up
    // unless the chord is near-vertical, which a thrown chain never is but a
    // paused drag on `endHeight` can make it.
    _dir.subVectors(_to, _from);
    const span = Math.max(_dir.length(), 1e-4);
    _dir.multiplyScalar(1 / span);
    if (Math.abs(_dir.y) > 0.9) _n1.set(1, 0, 0);
    else _n1.set(0, 1, 0);
    _n1.crossVectors(_dir, _n1).normalize();
    _n2.crossVectors(_dir, _n1).normalize();

    const taut = this._tautAt < 0 ? 0 : Easing.outBack(saturate((this.age - this._tautAt) / Math.max(0.02, c.tautTime)));
    // Scaled by the throw so a chain that is one metre out does not droop two
    // and a half. The droop is a property of how much chain is in the air.
    this._sag = paid * (c.chainSag + (c.chainSagHeld - c.chainSag) * taut);
  }

  /**
   * A point on the chain at `t`, 0 at the hand and 1 at the far anchor.
   *
   * `_resolveChain()` must have run this frame. Mirrors the `LINK` branch of
   * the vertex shader term for term, including the sway, so a link and the
   * filament threaded through it are never a centimetre apart.
   */
  _chainPoint(t, out) {
    const c = settings.soulchain;
    out.lerpVectors(_from, _to, t);

    const k = Math.max(c.chainCurve, 0.01);
    const ck = Math.cosh(k);
    const bow = (ck - Math.cosh(k * (2 * t - 1))) / Math.max(ck - 1, 1e-4);
    out.y -= this._sag * bow;

    const sway =
      Math.sin(frame.uTime.value * c.chainSwingSpeed + this._seed) * c.chainSwing * Math.sin(t * Math.PI);
    return out.addScaledVector(_n1, sway);
  }

  /** Unit tangent at `t`. Central difference on the same curve. */
  _chainTangent(t, out) {
    const h = 0.004;
    this._chainPoint(clamp(t - h, 0, 1), _sa);
    this._chainPoint(clamp(t + h, 0, 1), _sb);
    out.subVectors(_sb, _sa);
    return out.lengthSq() > 1e-12 ? out.normalize() : out.copy(_dir);
  }

  /** Walk the curve and fill the arc-length table. Returns its total, metres. */
  _measureChain() {
    const arc = this._arc;
    this._chainPoint(0, _prev);
    arc[0] = 0;
    for (let i = 1; i <= ARC_SAMPLES; i++) {
      this._chainPoint(i / ARC_SAMPLES, _pos);
      arc[i] = arc[i - 1] + _pos.distanceTo(_prev);
      _prev.copy(_pos);
    }
    return arc[ARC_SAMPLES];
  }

  /**
   * The curve parameter at `s` metres along the chain.
   *
   * A linear scan rather than a bisection: the table is forty-eight entries and
   * the caller walks `s` upward, so the scan is a handful of comparisons and
   * the bisection would be more code than it saves.
   */
  _tAtArc(s) {
    const arc = this._arc;
    const total = arc[ARC_SAMPLES];
    if (!(s > 0) || !(total > 1e-5)) return 0;
    if (s >= total) return 1;
    let i = 1;
    while (i < ARC_SAMPLES && arc[i] < s) i++;
    const lo = arc[i - 1];
    const hi = arc[i];
    const f = hi > lo ? (s - lo) / (hi - lo) : 0;
    return (i - 1 + f) / ARC_SAMPLES;
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame sync                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Thread the links along the curve.
   *
   * @param {number} fade master alpha
   * @returns {number} metres of chain, for whoever wants to place something else
   */
  _syncLinks(fade) {
    const c = settings.soulchain;
    const g = settings.global;

    this._syncLinkGeometry();
    const arcLength = this._measureChain();

    // The one derivation the ability is built on. `linkOverlap` is clamped
    // because the pause test scales every slider by 1.37 at once and an overlap
    // above 1 would make the spacing negative and the count meaningless.
    const spacing = Math.max(0.02, this._builtLength * (1 - clamp(c.linkOverlap, 0, 0.9)));
    const count = clamp(Math.floor(arcLength / spacing), 1, MAX_LINKS);
    this._count = count;

    const breakAge = this._breakAt < 0 ? -1 : Math.max(0, this.age - this._breakAt);
    const breakStep = 1 / Math.max(0.1, c.breakRate);
    this._broken = breakAge < 0 ? 0 : clamp(Math.floor(breakAge / breakStep), 0, count);

    // The rattle dies away once the chain is hanging still. Full while it is
    // still being thrown, because a chain in flight is not settled.
    const settled = this._tautAt < 0 ? 0 : Math.max(0, this.age - this._tautAt);
    const jangle = this._tautAt < 0 ? 1 : Math.exp(-c.rattleDecay * settled);
    const rattle = c.rattleAmp * jangle * g.randomness;
    const shiver = c.rattleSway * jangle * g.randomness;

    const time = frame.uTime.value;
    const dice = this._dice;
    const station = this._aStation.array;
    const broke = this._aBreak.array;
    const life = Math.max(0.05, c.breakLife);

    for (let i = 0; i < count; i++) {
      const s = (i + 0.5) * spacing;
      const t = this._tAtArc(s);
      this._chainPoint(t, _pos);
      this._chainTangent(t, _tan);

      // The section frame, Gram-Schmidted off the chain's own n1 so the twist
      // sequence keeps its phase as the curve bends.
      _ax.copy(_n1).addScaledVector(_tan, -_n1.dot(_tan));
      if (_ax.lengthSq() > 1e-8) _ax.normalize();
      else _ax.set(0, 1, 0).cross(_tan).normalize();
      _ay.crossVectors(_tan, _ax).normalize();

      const phase = dice[i * 4 + 3] * TAU;
      const roll = i * c.linkTwist + rattle * Math.sin(time * c.rattleRate + phase);

      // z is the hole's normal, x is the long axis lying along the chain, and y
      // closes the basis right-handed. Getting x and z the other way round
      // threads every link side-on and the chain reads as a row of coins.
      _az.copy(_ax).multiplyScalar(Math.cos(roll)).addScaledVector(_ay, Math.sin(roll));
      _ax.copy(_tan);
      _ay.crossVectors(_az, _ax).normalize();

      _pos.addScaledVector(_az, shiver * Math.sin(time * c.rattleRate * 0.63 + phase * 1.7));

      const j = count - 1 - i; // 0 is the far end: the first to let go
      const freeFor = breakAge < 0 ? -1 : breakAge - j * breakStep;

      if (freeFor <= 0) {
        broke[i] = -1;
        _mat.makeBasis(_ax, _ay, _az);
        _mat.setPosition(_pos);
      } else if (freeFor >= life) {
        // Gone. A zero basis collapses the instance to a point rather than
        // shuffling the live links down, which would restripe every station.
        broke[i] = 1;
        _mat.makeScale(0, 0, 0);
        _mat.setPosition(_pos);
      } else {
        broke[i] = freeFor / life;

        // Closed form, evaluated against live sliders — see the class header.
        const bearing = dice[i * 4] * TAU;
        const pitch = (dice[i * 4 + 1] - 0.5) * c.breakSpread;
        _axis
          .copy(_az)
          .multiplyScalar(Math.cos(bearing))
          .addScaledVector(_ay, Math.sin(bearing))
          .addScaledVector(_ax, pitch);
        if (_axis.lengthSq() > 1e-8) _axis.normalize();
        else _axis.copy(_az);

        _pos.addScaledVector(_axis, c.breakSpeed * freeFor);
        _pos.y += 0.5 * c.breakGravity * freeFor * freeFor;

        _rot.makeRotationAxis(_axis, c.breakSpin * freeFor);
        _mat.makeBasis(_ax, _ay, _az);
        _mat.premultiply(_rot);
        _mat.setPosition(_pos);
      }

      station[i] = count > 1 ? i / (count - 1) : 0;
      this.links.setMatrixAt(i, _mat);
    }

    this.links.count = count;
    this.links.instanceMatrix.needsUpdate = true;
    this._aStation.needsUpdate = true;
    this._aBreak.needsUpdate = true;

    this.linkMaterial.userData.sync();
    this.linkMaterial.opacity = saturate(c.linkOpacity * fade * g.opacity);
    this.links.visible = fade > 0.02 && c.linkOpacity > 0.001;

    return arcLength;
  }

  /**
   * The spirit thread the links are strung on, and the fray at the broken end.
   *
   * Two roles, one strip, two draw calls total — the cheapest saving in the
   * library and the reason the whole ability draws in three.
   *
   * @param {number} fade master alpha
   */
  _syncTether(fade) {
    const c = settings.soulchain;
    const g = settings.global;
    const look = this._look;

    look.width = c.tetherWidth;
    look.glowWidth = c.tetherGlowWidth;
    look.glowOpacity = c.tetherGlowOpacity;
    look.jitter = c.tetherJitter;
    look.jitterScale = c.tetherJitterScale;
    look.octaves = c.tetherOctaves;
    look.jitterFalloff = c.tetherJitterFalloff;
    look.crawl = c.tetherCrawl;
    look.pinch = c.tetherPinch;
    look.restrike = c.tetherRestrike;
    look.flicker = c.tetherFlicker;
    look.flickerSpeed = c.tetherFlickerSpeed;
    look.strandFlash = c.tetherStrandFlash;
    look.coreSharp = c.tetherCoreSharp;
    look.glowFalloff = c.tetherGlowFalloff;
    look.softFade = c.tetherSoftFade;
    look.opacity = c.tetherOpacity;
    look.glow = c.tetherGlow;
    look.colorCore = c.colorTetherCore;
    look.colorInner = c.colorTetherInner;
    look.colorOuter = c.colorTetherOuter;
    look.colorHalo = c.colorTetherHalo;
    look.randomness = g.randomness;
    look.noiseStrength = g.noiseStrength;
    look.noiseFrequency = g.noiseFrequency;
    look.noiseSpeed = g.noiseSpeed;
    look.opacityScale = g.opacity;
    look.glowScale = g.glow;

    // How much of the chain still has iron on it. The thread retracts with the
    // links rather than hanging on past them, which is what makes the break-up
    // read as the chain coming apart instead of the links falling off a wire.
    const remaining = this._count > 0 ? saturate((this._count - this._broken) / this._count) : 0;

    const tether = this.paths.role(0);
    tether.count = Math.max(0, Math.round(c.tetherCount));
    tether.style(c.tetherKink, 1, 1, 1);
    tether.ends(0.02, 0.04, 0.12, 0.12);
    // `taut` is 0 on purpose: the collapse is already inside `this._sag`.
    tether.link(_from, _to, this._sag, c.chainCurve, c.chainSwing, c.chainSwingSpeed, 0, c.tetherSpread);
    tether.draw(remaining, c.tetherTipLength, -1e4, c.tetherTipGlow);

    const fray = this.paths.role(1);
    if (this._broken > 0 && remaining > 0.001) {
      const t = this._tAtArc(this._arc[ARC_SAMPLES] * remaining);
      this._chainPoint(t, _frayA);
      this._chainTangent(t, _frayB);
      _frayB.multiplyScalar(c.frayReach).add(_frayA);

      fray.count = Math.max(1, Math.round(c.frayCount));
      fray.style(c.frayKink, c.frayWidth, c.frayDim, 1);
      fray.ends(0.02, 0.6, 0.05, 0.9);
      fray.crack(
        _frayA,
        _frayB,
        c.frayAngle,
        c.frayLength,
        c.frayFalloff,
        c.fraySpread,
        c.frayStart,
        c.fraySag,
        c.frayForkBias
      );
      fray.draw(2, c.tetherTipLength, -1e4, c.tetherTipGlow);
    } else {
      fray.retire();
    }

    this.paths.sync(look, fade, this._seed);
  }

  /** Push the live gradients and scales into the three particle systems. */
  _syncParticles() {
    const c = settings.soulchain;
    const g = settings.global;

    this.shards.setGradient(
      getColor(c.colorShardA),
      getColor(c.colorShardB),
      getColor(c.colorShardC),
      getColor(c.colorShardD)
    );
    this.shards.uniforms.uGravity.value.set(0, c.shardGravity, 0);
    this.shards.uniforms.uSizeScale.value = c.shardSize * g.particleSize * 7;
    this.shards.uniforms.uLifeScale.value = g.particleLifetime;
    this.shards.uniforms.uSpeedScale.value = g.particleSpeed;
    this.shards.uniforms.uOpacity.value = g.opacity;

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
    this.motes.uniforms.uGlow.value = 1.2 * g.glow;
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
    this.haze.uniforms.uOpacity.value = c.hazeOpacity * g.opacity;
    this.haze.uniforms.uTurbulence.value = 0.3 * g.turbulence;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** Soul motes off the length of the chain, and cold haze under it. */
  _chainFx(dt, scale) {
    const c = settings.soulchain;
    const g = settings.global;
    const time = frame.uTime.value;

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      this._chainPoint(Math.random(), _pos);
      _emit.position = _pos;
      _emit.radius = this._builtWidth * 1.5 + 0.05;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    const hazeCount = Math.round(this.hazeEmitter.tick(dt, c.hazeRate * scale) * g.particleCount);
    if (hazeCount > 0) {
      this._chainPoint(Math.random(), _pos);
      _emit.position = _pos;
      _emit.radius = this._builtLength * 2 + 0.2;
      _emit.direction = _dir.set(0, -1, 0);
      _emit.speed = c.hazeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.95;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.9;
      _emit.sizeVariance = 0.5;
      _emit.life = c.hazeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.tint = null;
      _emit.time = time;
      this.haze.emit(hazeCount, _emit);
    }
  }

  /**
   * Shards and a mote burst for every link that has parted since last frame.
   *
   * `_brokenSeen` is an event counter, not a dimension: it records how many
   * breaks have already been paid for, so a paused drag on `breakRate` that
   * suddenly declares six more links broken pays out six bursts at once rather
   * than silently swallowing them.
   */
  _breakFx() {
    const c = settings.soulchain;
    const g = settings.global;
    if (this._broken <= this._brokenSeen) return;

    let budget = MAX_BREAKS_PER_FRAME;
    while (this._brokenSeen < this._broken && budget-- > 0) {
      const index = Math.max(0, this._count - 1 - this._brokenSeen);
      this._brokenSeen++;

      const s = (index + 0.5) * Math.max(0.02, this._builtLength * (1 - clamp(c.linkOverlap, 0, 0.9)));
      this._chainPoint(this._tAtArc(s), _pos);

      _emit.position = _pos;
      _emit.radius = this._builtWidth * 0.6;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.2).setY(0.8).normalize();
      _emit.speed = c.shardSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.12;
      _emit.sizeVariance = 0.7;
      _emit.life = c.shardLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 11;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.shards.emit(Math.round(c.shardPerBreak * g.particleCount), _emit);

      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed * 3;
      _emit.size = 0.11;
      _emit.life = c.moteLifetime;
      _emit.spin = 0;
      this.motes.emit(Math.round(6 * g.particleCount), _emit);
    }
    this._brokenSeen = Math.min(this._brokenSeen, this._count);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this.hazeEmitter.reset();
    this._tautAt = -1;
    this._breakAt = -1;
    this._brokenSeen = 0;
    this._broken = 0;

    // The dice. Unitless, one set per link slot, so a link's throw bearing and
    // its jangle phase are stable for the whole cast however many links the
    // sag decides there are.
    this._seed = Math.random() * 100;
    for (let i = 0; i < MAX_LINKS; i++) {
      this._dice[i * 4] = Math.random();
      this._dice[i * 4 + 1] = Math.random();
      this._dice[i * 4 + 2] = Math.random();
      this._dice[i * 4 + 3] = Math.random();
      this._aSeed.array[i] = hash11(this._seed + i * 3.77);
    }
    this._aSeed.needsUpdate = true;

    this.paths.visible = true;
    this._resolveChain();
    this._syncLinks(1);
    this._syncTether(1);
    this._syncParticles();
  }

  onTravel(dt) {
    const c = settings.soulchain;
    this._resolveChain();
    this._syncLinks(1);
    this._syncTether(1);
    this._syncParticles();
    this._chainFx(dt, 1);

    // The light rides the travelling end, which is the thing the eye follows.
    this.position.copy(_to);
    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.soulchain;
    const g = settings.global;

    // Timestamp one of two. Everything the snap does is a function of
    // `age − tautAt` against live sliders, so dragging `tautTime` with the
    // clock stopped re-times a collapse that has already happened.
    this._tautAt = this.age;
    this._resolveChain();

    this.pointAt(1, _pos);
    _pos.y = c.endHeight;

    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.burstSize * 0.2,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.55,
      intensity: c.burstIntensity,
      opacity: 0.8,
      fresnel: 1.8,
      displace: 0.4,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.pointAt(1, _dir);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _dir, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.55,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    // The jangle: every link is thrown a mote at the instant the slack goes.
    this._chainPoint(randRange(0.3, 0.9), _pos);
    _emit.position = _pos;
    _emit.radius = Math.max(0.5, this.length * 0.28);
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed * 4;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.7;
    _emit.life = c.moteLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(Math.round(70 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.snapShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      28
    );
    this.ctx.flash.trigger(getColor(c.colorSnapFlash), c.snapFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.8 * g.explosionIntensity;
  }

  onFade(dt, t) {
    // `t` runs 0..1 while the chain hangs taut and rattles, then 1..2 while it
    // comes apart. The second timestamp is taken on the frame the break-up
    // begins; everything after is a function of `age − breakAt`.
    if (t > 1 && this._breakAt < 0) this._breakAt = this.age;

    const dying = saturate(t - 1);
    // The chain does not dim while it is breaking — the *links* leave, one at a
    // time, and that is the effect. Only the last fifth is a fade, and it is
    // there to catch whatever the break front did not reach.
    const fade = 1 - Easing.inCubic(saturate((dying - 0.8) / 0.2));

    this._resolveChain();
    this._syncLinks(fade);
    this._syncTether(fade);
    this._syncParticles();
    this._breakFx();
    this._chainFx(dt, fade * (t <= 1 ? 0.7 : 0.35));

    this.position.copy(_to);
  }

  onDestroy() {
    this.links.count = 0;
    this.links.visible = false;
    this.paths.clear();
    this.paths.visible = false;
    this._count = 0;
    this._broken = 0;
    this._brokenSeen = 0;
    this._tautAt = -1;
    this._breakAt = -1;
  }

  dispose() {
    this.paths.dispose();
    this.linkGeometry.dispose();
    this.linkMaterial.dispose();
    this.links.dispose();
    super.dispose();
  }
}
