import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { ShatterField, ShatterLayout, shatterParams } from '../../vfx/ShatterField.js';
import { Shell, ShellMode } from '../../vfx/Shell.js';
import { DistortionField, DistortionMode, DistortionFacing } from '../../vfx/Distortion.js';
import { sceneHooks, Hook } from '../../vfx/SceneHooks.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, clamp, Easing, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;

/**
 * Distinct pane silhouettes. Two, not three.
 *
 * `GrowthField` wants three variants because a field of one silhouette scaled
 * forty ways reads as a repeated prop. Debris does not have that problem —
 * every fragment is tumbling on its own axis at its own rate, and the eye
 * never gets a second look at the same outline. Two is enough to break the
 * repeat and it is one draw call cheaper.
 */
const PANE_VARIANTS = 2;

/** Hard ceiling on panes in the air. `paneCount` clamps here. */
const MAX_PANES = 180;

/**
 * How many points round the break annulus one frame's glints are split
 * between. A single origin makes every batch read as a starburst pinned to one
 * spot on a bell that is four metres across.
 */
const GLINT_ARCS = 5;

/* --- module-scope scratch. Nothing below allocates during a cast (I3) --- */
const _panes = shatterParams();
const _look = {};
const _push = {};
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _hit = new Vector3();

/**
 * One pane of arcane glass, in `ShatterField`'s unit space.
 *
 * A body inside a unit sphere **centred on its own origin**, because the
 * tumble rotates about that point — which is the one part of the contract that
 * differs from `GrowthField`'s base-on-`y = 0` factory, and the one that is
 * easy to get wrong. A pane built with its base at the floor tumbles about its
 * foot and reads as a flag on a stick.
 *
 * The outline is an irregular convex polygon rather than a rectangle. Real
 * glass breaks on conchoidal fractures and the tell is that no two edges are
 * parallel; a field of rectangles reads as ceramic tiles no matter what the
 * shading does. `ragged` pushes the corners off the regular n-gon in both
 * radius and bearing, and it is a slider because a low value is stained glass
 * (leaded panels, straight cames) and a high one is a windscreen.
 *
 * @param {number} variant  0..N, decorrelates the corner hash
 * @param {object} shape    `{ sides, thickness, ragged }` — live, see `_syncPanes`
 */
function createPaneGeometry(variant, shape) {
  const sides = Math.max(3, Math.round(shape.sides));
  const half = Math.max(0.004, shape.thickness) * 0.5;
  const ragged = saturate(shape.ragged);

  // A deterministic hash rather than Math.random: two casts of the same
  // ability must build the same two panes, or the rebuild-on-slider-change
  // below would reshuffle the whole field every time a number moved.
  const hash = (n) => {
    const s = Math.sin((n + variant * 37.13) * 12.9898) * 43758.5453;
    return s - Math.floor(s);
  };

  const rim = [];
  for (let i = 0; i < sides; i++) {
    const bearing = (i / sides + (hash(i * 1.7) - 0.5) * (ragged * 0.7 / sides)) * TAU;
    const reach = 0.5 * (1 - ragged * 0.55 * hash(i * 3.9 + 11));
    rim.push([Math.cos(bearing) * reach, Math.sin(bearing) * reach]);
  }

  const positions = [];
  const push = (x, y, z) => positions.push(x, y, z);

  // Two faces and a band of side quads. Non-indexed with face normals, so the
  // edge band catches the key light separately from the faces — which is what
  // makes a pane read as having thickness at all at this size.
  for (let i = 0; i < sides; i++) {
    const a = rim[i];
    const b = rim[(i + 1) % sides];
    push(0, half, 0); push(a[0], half, a[1]); push(b[0], half, b[1]);
    push(0, -half, 0); push(b[0], -half, b[1]); push(a[0], -half, a[1]);
    push(a[0], half, a[1]); push(a[0], -half, a[1]); push(b[0], half, b[1]);
    push(b[0], half, b[1]); push(a[0], -half, a[1]); push(b[0], -half, b[1]);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * SPELLBREAK — the one ability that is aware of the others.
 *
 * **The trick is that it reaches outside its own group.** Every other slot in
 * this sandbox draws into `this.group` and is done. This one borrows
 * `Hook.DISRUPT` from `vfx/SceneHooks.js` and publishes a sphere — a centre in
 * world metres, a radius, and three 0..1 powers — that **other abilities'
 * shaders read**. A bolt, a snare, a chain, a flock, any ground mark, any beam
 * and any standing field of erupted geometry that happens to be inside that
 * sphere is desaturated, dimmed, and eroded away in screen-space cells on the
 * same grain the glass is breaking on. Cast it into an empty room and it is a
 * pretty dome shattering. Cast it into a live Nova Beam and it is an
 * interaction, and there is nothing else in the project that does that.
 *
 * ## What had to be extended to make it land
 *
 * The hook shipped with three opted-in consumers — `FilamentPaths`,
 * `GroundField` and `Swarm` — and on paper that is "every bolt, every ground
 * mark and every flock", which sounds like most of the stage. It is not. Cast
 * this into a Nova Beam and **nothing happened**: a beam is a `Tube`, and a
 * tube was not on the list. Cast it at a standing frost field and nothing
 * happened either: those are `GrowthField` instances on patched
 * `MeshStandardMaterial`s, also not on the list. Between them that is most of
 * what a player actually has left standing in a zone when they reach for a
 * dispel, so both were opted in as part of this ability:
 *
 *   - `vfx/Tube.js` samples the field per vertex and shades **after** its own
 *     glow gain. Draining a rod of light before a gain of eight is applied
 *     does nothing: grey × 8 is white.
 *   - `vfx/GrowthField.js#patchGrowthMaterial` samples it per *fragment* — the
 *     opposite of the cheap route, because a growth instance is a handful of
 *     very large facets and a per-vertex sample is interpolated across half a
 *     spike — and **discards** the eroded cells rather than zeroing alpha,
 *     because an opaque material's alpha is written and then ignored. The
 *     first version zeroed alpha and a crystal field inside the zone went grey
 *     and stayed whole, which reads as a lighting change and not as a spell
 *     being torn apart.
 *
 * ## The beats
 *
 *   1. **warn** — the field is already on while the null front is still in the
 *      air, at `warnSpan` of its radius and `warnDrain` of its power. Colour
 *      goes out of the room *before* the glass arrives. This is the
 *      Thunderclap lesson: the anticipation carries the beat, and a dispel
 *      that starts at full strength on the frame it lands reads as a graphic
 *      rather than as an event.
 *   2. **seal** — the bell closes over the zone (`vfx/Shell.js`, `DOME`) and
 *      the field opens out to full radius and full drain with it.
 *   3. **break** — the bell shatters. `fracture` spikes to `fractureBite` for
 *      `fractureFall` seconds, so everything standing in the zone comes apart
 *      in cells at the same instant the glass does; a pressure ring goes out
 *      through the distortion buffer (`vfx/Distortion.js`, `SHOCK`) — that is
 *      the *push* — and the panes fly.
 *   4. **let go** — `token.blend()` falls off on `releaseCurve`, which holds
 *      the field and then drops it rather than dimming it evenly. Colour comes
 *      back to the room slightly after the glass has finished falling, which
 *      is the right order: the room recovers, it is not un-dispelled.
 *
 * ## Two things that are easy to get wrong here
 *
 * **The token can be taken.** Two live Spellbreaks resolve LIFO: the second
 * one drives, the first keeps a live token reading `driving === false` and
 * takes the field back the frame the second releases. That is the library's
 * behaviour and it is correct, but it means this ability must not assume its
 * own writes are what the world sees. It reads `driving` and takes its own
 * bell's rim down when it is not the one driving, so two overlapping casts
 * tell you which of them owns the room.
 *
 * **The hook must be given back on all four exits.** A leaked `DISRUPT` holds
 * the whole stage desaturated for the rest of the session with no cast on
 * screen to blame, so the acquisition goes through `this.borrow(...)` and the
 * base class returns it however the cast ends — including the player pressing
 * **C** mid-bell.
 *
 * **The rule that makes the editor work.** A cast captures one unitless seed,
 * one boolean (has it broken yet) and two clocks. Every metre, radian, second
 * and 0..1 power — including everything the hook publishes — is resolved
 * against `settings.spellbreak` inside the update loop, on a zero-length frame
 * included. Pause with **P** while the bell stands and drag `drain`: the
 * colour comes out of the standing beam next to it with the clock stopped.
 */
export class SpellbreakAbility extends Ability {
  constructor(context) {
    super('spellbreak', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * The bell. `DOME` rather than a bespoke mesh because the seal band where
     * a dome meets the floor is the single most useful thing `Shell` owns, and
     * a bell of glass standing on stone is exactly that read: the brightest
     * line on the whole shape is where it touches.
     */
    this.bell = new Shell({
      mode: ShellMode.DOME,
      prefix: 'glass',
      nodes: 44,
      sides: 52,
      renderOrder: 13
    });
    this.group.add(this.bell.group);

    /**
     * The overlay — an object whose prototype **is** the live settings block.
     *
     * `Shell` is a prefixed module: it reads `c[keys.radius]` off whatever
     * object it is handed. The dome's two radii are the one pair of numbers
     * this ability computes rather than authors, because a bell of glass whose
     * size does not follow the aim circle is a bell standing in the wrong
     * place. Writing them back into `settings.spellbreak` was the first
     * version and it is wrong twice over: the editor's own slider snaps back
     * every frame, and a saved preset records a metre value the user never
     * chose. So two own properties are written here every frame and every
     * other key resolves through the prototype, live, with the block itself
     * never written to. `settings.spellbreak` is mutated in place by
     * `applySettings` and by the editor — its identity never changes — so this
     * stays welded to it for the life of the process.
     *
     * The block deliberately carries no `glassRadius` / `glassRadiusEnd` at
     * all, so the panel cannot show two sliders that do nothing. `Shell`'s
     * missing-key audit walks the prototype chain, so it stays quiet.
     */
    this._glass = Object.create(settings.spellbreak);
    this._glass.glassRadius = 1;
    this._glass.glassRadiusEnd = 1;

    /**
     * The panes.
     *
     * `ShatterField`'s factory takes only a variant index — it has no
     * `syncGeometry(shape)` the way `GrowthField` does — so the ability owns
     * the rebuild hash. Three numbers describe the silhouette and a change in
     * any of them rebuilds two geometries; see `_syncPanes`.
     */
    this._paneShape = { sides: 0, thickness: 0, ragged: 0 };
    this.panes = new ShatterField(this.group, {
      geometry: (variant) => createPaneGeometry(variant, this._paneShape),
      variants: PANE_VARIANTS,
      capacity: MAX_PANES,
      renderOrder: 7
    });

    /**
     * The push. A `SHOCK` emitter writing to the distortion buffer, billboarded
     * so the front reads as a sphere of pressure rather than as a ring painted
     * on the floor — the whole point is that things *above* the floor are moved
     * too, and a `GROUND`-facing quad says the opposite.
     */
    this.push = new DistortionField({
      mode: DistortionMode.SHOCK,
      facing: DistortionFacing.BILLBOARD,
      name: 'Spellbreak:push'
    });
    this.group.add(this.push.object3D);

    /**
     * Park the hook's live state where the harness's pause probe looks.
     *
     * An ability whose principal output is a scene hook owns no uniform that
     * carries it, so without this the field's thirteen sliders read as a dead
     * bank even while they are draining the colour out of the room. Nothing in
     * any shader reads these boxes from here; they are here to be seen.
     */
    sceneHooks.observe(this.bell.material);

    /* --- what a cast captures: one dice roll, one flag, two clocks --- */
    /** Decorrelates the bell's billow and the panes' seed. Unitless. */
    this._seed = 0;
    /** One-way. A slider drag must not be able to re-break the bell. */
    this._broken = false;
    /** Seconds since the null front landed. A clock, not a dimension. */
    this._land = 0;
    /** Seconds since the bell broke. */
    this._since = 0;
    /** The borrowed hook. Null between casts. */
    this._field = null;
    /** HUD readout only. */
    this._live = 1;

    /** The zone's anchor, rewritten every frame from the live cast. */
    this._centre = new Vector3();

    /** Scratch state handed to the shell each frame. One object, reused. */
    this._state = {
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

    // Glints off the glass. Velocity-stretched, because a chip of glass
    // catching the key light is a streak and not a dot.
    this.glints = particles.get('spellbreak.glints', {
      capacity: 2600,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.28
    });
    this.glints.uniforms.uDrag.value = 1.3;
    this.glints.uniforms.uEndSize.value = 0.2;
    this.glints.uniforms.uSizeIn.value = 0.03;
    this.glints.uniforms.uFadeIn.value = 0.04;
    this.glints.uniforms.uFadeOut.value = 0.45;

    // The drained colour, leaving. Non-additive on purpose and the only
    // non-additive haze in the school: this is meant to read as *pigment*
    // coming out of the air, and a grey cloud that adds light is a grey cloud
    // that makes the room brighter, which is the opposite of the sentence.
    this.dust = particles.get('spellbreak.dust', {
      capacity: 2200,
      shape: ParticleShape.SOFT,
      additive: false,
      curl: true,
      softFade: 0.6
    });
    this.dust.uniforms.uDrag.value = 1.7;
    this.dust.uniforms.uEndSize.value = 2.2;
    this.dust.uniforms.uSizeIn.value = 0.1;
    this.dust.uniforms.uFadeIn.value = 0.15;
    this.dust.uniforms.uFadeOut.value = 0.35;

    // Glass powder off the floor under the break.
    this.grit = particles.get('spellbreak.grit', {
      capacity: 1400,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.grit.uniforms.uDrag.value = 0.3;
    this.grit.uniforms.uEndSize.value = 0.7;
    this.grit.uniforms.uFadeOut.value = 0.65;

    this.glintEmitter = new RateEmitter();
    this.dustEmitter = new RateEmitter();
    this.gritEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing — every beat re-derived from settings, every frame            */
  /* ------------------------------------------------------------------ */

  /** A beat's length in seconds, under the global lifetime knob. */
  _span(seconds) {
    return Math.max(0.01, seconds * settings.global.lifetime);
  }

  /**
   * The impact phase holds all three beats: the bell closing, the bell
   * standing, and the ring crossing the zone after it breaks. Scaling the
   * phase without scaling the beats leaves the ring still travelling when the
   * phase machine has already moved on.
   */
  get impactDuration() {
    const c = settings.spellbreak;
    return this._span(c.sealTime) + this._span(c.holdTime) + this._span(c.ringTime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.spellbreak.fadeTime);
  }

  get instanceCount() {
    return this._live;
  }

  /**
   * Glass swells; it does not gutter.
   *
   * A hard stutter here made the slot read as electrical, which is Storm's
   * sentence and not this one. What this light actually wants to say is that
   * something is being held shut under pressure.
   */
  lightShimmer() {
    const c = settings.spellbreak;
    return 1 - saturate(c.lightPulse) * 0.5 * (1 - Math.cos(this.age * c.lightPulseSpeed));
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The live footprint, metres. What the aim circle measured out. */
  get radius() {
    return Math.max(0.2, settings.spellbreak.zoneRadius);
  }

  /** Where the zone is: the far end of the aimed line, on the floor. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** 0..1 — how far the bell has closed. */
  _sealAmount() {
    return saturate(this._land / this._span(settings.spellbreak.sealTime));
  }

  /** 0..1 — how far the pressure ring has crossed the zone. */
  _ringAmount() {
    if (!this._broken) return 0;
    return saturate(this._since / this._span(settings.spellbreak.ringTime));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.glintEmitter.reset();
    this.dustEmitter.reset();
    this.gritEmitter.reset();

    this._broken = false;
    this._land = 0;
    this._since = 0;
    this.panes.clear();

    // The only thing a cast captures with no unit attached to it.
    this._seed = Math.random() * 100;

    // Borrowed through the base class so it comes back on all four exits —
    // finishing, the concurrency cap, **C**, and teardown. See the class doc.
    this._field = this.borrow(sceneHooks.acquire(Hook.DISRUPT, this));

    this._syncPanes();
    this._sync(1);
    this._castFx();
  }

  /* ------------------------------------------------------------------ */
  /* The pane silhouette                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Rebuild the two pane geometries when — and only when — one of the three
   * numbers that describes their outline has moved.
   *
   * This is `GrowthField#syncGeometry` reimplemented in the ability, because
   * `ShatterField`'s factory contract takes a variant index and nothing else.
   * It allocates, which I3 forbids *during a cast* — and it does not happen
   * during a cast: three numbers are compared and the common case is three
   * float compares and a return. It fires when somebody drags `paneSides`,
   * which is exactly the moment an allocation is affordable and exactly the
   * moment the alternative — a corner count that only takes effect on the next
   * cast — would be an I1 violation you could see.
   */
  _syncPanes() {
    const c = settings.spellbreak;
    const shape = this._paneShape;
    const sides = clamp(Math.round(c.paneSides), 3, 8);
    if (shape.sides === sides && shape.thickness === c.paneThickness && shape.ragged === c.paneRagged) {
      return false;
    }

    shape.sides = sides;
    shape.thickness = c.paneThickness;
    shape.ragged = c.paneRagged;

    for (let v = 0; v < this.panes.meshes.length; v++) {
      const mesh = this.panes.meshes[v];
      const built = createPaneGeometry(v, shape);
      // The two instanced attributes are the field's, not the geometry's — the
      // arrays outlive any rebuild and are carried across by reference.
      built.setAttribute('aSeed', this.panes.seedAttributes[v]);
      built.setAttribute('aLife', this.panes.lifeAttributes[v]);
      mesh.geometry.dispose();
      mesh.geometry = built;
    }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current cast state into the hook, the bell,
   * the panes, the pressure ring and the three particle systems.
   *
   * @param {number} fade 1 while the cast stands, ramping to 0 as it lets go
   */
  _sync(fade) {
    const c = settings.spellbreak;
    const g = settings.global;

    this._centrePoint(this._centre);
    const radius = this.radius;
    const travelling = this.phase === AbilityPhase.TRAVEL;
    const seal = travelling ? 0 : this._sealAmount();
    const ring = this._ringAmount();

    /* ---------------- 1 · the field, which is the ability -------------- */
    this._syncField(fade, travelling, seal);

    /* ---------------- 2 · the bell ------------------------------------- */
    // Written whether or not it is on screen. Syncing only the visible pieces
    // is the tempting optimisation and it breaks the paused editor: drag
    // `domeSpan` while the bell is down and it must still be the size you chose
    // when it comes up.
    const glass = this._glass;
    glass.glassRadius = Math.max(0.01, radius * c.domeStart);
    glass.glassRadiusEnd = Math.max(0.02, radius * c.domeSpan);

    const state = this._state;
    state.origin.copy(this._centre);
    state.axis.set(0, 1, 0);
    state.side.copy(this.side);
    state.span = radius * 2;
    state.t = seal;
    // The bell does not dim when it breaks, it *stops existing* — the panes are
    // what is left of it. A cubic drop over the first fifth of the ring beat
    // hands the read over cleanly; a linear fade left a ghost dome hanging over
    // a field of falling glass for a third of a second and it looked like two
    // separate effects.
    const gone = this._broken ? Easing.inCubic(saturate(this._since / (this._span(c.ringTime) * 0.2))) : 0;
    // Not driving the hook means another Spellbreak has the room. Say so on the
    // rim rather than silently writing values nobody is reading.
    const owned = this._field && !this._field.driving ? 0.45 : 1;
    state.fade = travelling ? 0 : fade * (1 - gone) * owned;
    state.seed = this._seed;
    this.bell.sync(glass, state, g);
    this.bell.visible = state.fade > 0.002;

    /* ---------------- 3 · the panes ------------------------------------ */
    this._syncPanes();

    const p = _panes;
    p.layout = ShatterLayout.ZONE;
    p.origin = this.origin;
    p.direction = this.direction;
    p.side = this.side;
    p.length = this.length;
    p.centre = this._centre;
    p.radius = radius * c.paneSpawnSpan;
    p.width = radius;

    p.spawnRadius = c.paneSpawnRadius;
    p.spawnHeight = c.paneSpawnHeight;

    p.speed = c.paneSpeed;
    p.speedJitter = c.paneSpeedJitter;
    p.spread = c.paneSpread;
    p.upBias = c.paneUp;
    p.inherit = null;
    p.inheritScale = 1;

    p.gravity = c.paneGravity;
    p.drag = c.paneDrag;

    p.size = c.paneSize;
    p.sizeJitter = c.paneSizeJitter;
    p.shrink = c.paneShrink;
    p.shrinkPower = c.paneShrinkPower;
    p.spin = c.paneSpin;
    p.spinJitter = c.paneSpinJitter;

    p.lifetime = c.paneLifetime;
    p.floor = 0;
    p.floorSpin = c.paneFloorSpin;
    p.randomness = g.randomness;

    this.panes.sync(this._paneLook());
    this._live = 1 + this.panes.update(this.age, p);

    /* ---------------- 4 · the push ------------------------------------- */
    const pushRadius = Math.max(0.05, radius * c.pushSpan);
    this.push.setAnchorXYZ(this._centre.x, c.pushLift, this._centre.z);
    _push.width = pushRadius * 2;
    _push.height = pushRadius * 2;
    _push.radius = pushRadius;
    // `wave` is where the front *is*, in metres from the anchor. It is derived
    // from the beat rather than integrated, so scrubbing `ringTime` on a paused
    // frame moves the ring rather than changing how fast it will move next.
    _push.wave = pushRadius * ring;
    _push.thickness = c.pushThickness;
    _push.compression = c.pushCompression;
    _push.rarefaction = c.pushRarefaction;
    _push.rings = c.pushRings;
    _push.ringGap = c.pushRingGap;
    _push.ringDecay = c.pushRingDecay;
    _push.window = c.pushWindow;
    _push.maxOffset = c.pushMaxOffset;
    _push.depthFade = c.pushDepthFade;
    _push.seed = this._seed;
    // NEVER multiplied by global.distortion or post.distortion — the pass
    // applies both, once, and doing it here squares them.
    _push.strength = c.pushStrength * fade;
    _push.opacity = c.pushOpacity;
    this.push.update(_push);
    this.push.visible = this._broken && ring < 0.999 && fade > 0.01;

    /* ---------------- 5 · the three particle systems ------------------- */
    this.glints.setGradient(
      getColor(c.colorGlintA),
      getColor(c.colorGlintB),
      getColor(c.colorGlintC),
      getColor(c.colorGlintD)
    );
    this.glints.uniforms.uGravity.value.set(0, c.glintGravity, 0);
    this.glints.uniforms.uSizeScale.value = c.glintSize * g.particleSize * 7;
    this.glints.uniforms.uLifeScale.value = c.glintLifetime * 0.5 * g.particleLifetime;
    this.glints.uniforms.uSpeedScale.value = g.particleSpeed;
    this.glints.uniforms.uOpacity.value = g.opacity;
    this.glints.uniforms.uGlow.value = 1.1 * g.glow;
    this.glints.uniforms.uStretch.value = c.glintStretch;
    this.glints.uniforms.uTurbulence.value = 0.22 * g.turbulence;

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
    this.dust.uniforms.uTurbulence.value = c.dustTurbulence * g.turbulence;

    this.grit.setGradient(
      getColor(c.colorGritA),
      getColor(c.colorGritB),
      getColor(c.colorGritC),
      getColor(c.colorGritD)
    );
    this.grit.uniforms.uGravity.value.set(0, c.gritGravity, 0);
    this.grit.uniforms.uSizeScale.value = c.gritSize * g.particleSize * 7;
    this.grit.uniforms.uLifeScale.value = g.particleLifetime;
    this.grit.uniforms.uSpeedScale.value = g.particleSpeed;
    this.grit.uniforms.uOpacity.value = g.opacity;
  }

  /**
   * The published region — the whole reason this ability exists.
   *
   * Three regimes on one set of sliders, and the interesting one is the first:
   * while the null front is still in the air the field is already open at
   * `warnSpan` of its radius, ramped by how far the front has travelled. The
   * room starts losing its colour before anything has arrived to take it.
   *
   * @param {number} fade       1 while the cast stands, → 0 as it lets go
   * @param {number} travelling true while the null front is still in the air
   * @param {number} seal       0..1, how far the bell has closed
   */
  _syncField(fade, travelling, seal) {
    const token = this._field;
    if (!token) return;
    const c = settings.spellbreak;

    const full = Math.max(0.05, this.radius * c.fieldSpan);
    const warn = full * saturate(c.warnSpan);

    // Where the field is measured *from*. A sphere, so the lift matters: at 0
    // a bolt at chest height is half outside a five-metre field and the top of
    // it survives the dispel, which looks like the shader is broken.
    token.atPoint(this._centre);
    token.centre.y += c.fieldLift;

    if (travelling) {
      const reach = saturate(this.u);
      token.region(lerp(full * 0.15, warn, reach), c.fieldEdge);
      token.power(c.warnDrain * reach, 0, c.warnDim * reach);
    } else {
      token.region(lerp(warn, full, seal), c.fieldEdge);

      // The bite: the frame the bell breaks, the erosion spikes and then falls
      // back to whatever the standing field is. Derived from a timestamp rather
      // than decayed by hand, so pausing and dragging `fractureFall` re-shapes
      // a decay that is already half over.
      let fracture = c.fracture * seal;
      if (this._broken) {
        const bite = 1 - saturate(this._since / Math.max(0.02, c.fractureFall));
        fracture = lerp(c.fracture, c.fractureBite, Easing.outCubic(bite));
      }
      token.power(c.drain * seal, fracture, c.dim * seal);
    }

    token.shardSize(c.shardPixels);
    token.blend(fade);
  }

  /**
   * The pane look, filled into module scratch. One object, reused —
   * `ShatterField#sync` reads it and keeps nothing.
   *
   * It takes no arguments on purpose. Naming a parameter `c` or `g` in this
   * file would make `npm run check`'s static settings-key pass treat *every*
   * `c.something` read in the whole class as advisory rather than required,
   * and that pass is the one that catches a typo before it becomes NaN
   * geometry. Cheap to re-read the two blocks; not cheap to lose the check.
   */
  _paneLook() {
    const c = settings.spellbreak;
    const g = settings.global;
    const look = _look;
    look.colorA = getColor(c.colorPaneA);
    look.colorB = getColor(c.colorPaneB);
    look.colorEdge = getColor(c.colorPaneEdge);
    look.colorScene = getColor(c.colorPaneScene);
    look.opacity = c.paneOpacity * g.opacity;
    look.glow = c.paneGlow * g.glow;
    look.rim = c.paneRim * g.fresnel;
    look.rimPower = c.paneRimPower;
    look.shade = c.paneShade;
    look.ambient = c.paneAmbient;
    look.fadeStart = c.paneFadeStart;
    look.soft = c.paneSoft;
    look.sceneMix = c.paneSceneMix;
    look.refract = c.paneRefract;
    look.saturation = c.paneSaturation;
    return look;
  }

  /** A small null flare at the hand as the front leaves it. */
  _castFx() {
    const c = settings.spellbreak;
    const g = settings.global;

    _pos.copy(this.origin).addScaledVector(this.direction, 0.6).setY(1.25);

    _emit.position = _pos;
    _emit.radius = 0.16;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.glintSpeed * 1.4;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.6;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.14;
    _emit.sizeVariance = 0.6;
    _emit.life = c.glintLifetime * 0.7;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.glints.emit(Math.round(22 * g.particleCount), _emit);

    this.lightBoost = c.lightIntensity * 0.3 * g.explosionIntensity;
  }

  /**
   * Everything the standing cast sheds.
   *
   * @param {number} dt
   * @param {number} scale 0..1 — thinned as the cast lets go
   */
  _zoneFx(dt, scale) {
    const c = settings.spellbreak;
    const g = settings.global;
    const time = frame.uTime.value;
    const radius = this.radius;
    const centre = this._centre;

    /* --- glints, round the rim of the bell --- */
    let glintCount = Math.round(this.glintEmitter.tick(dt, c.glintRate * scale) * g.particleCount);
    if (glintCount > 0) {
      _emit.speed = c.glintSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.7;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.11;
      _emit.sizeVariance = 0.7;
      _emit.life = c.glintLifetime;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      const shell = radius * Math.max(0.02, c.domeSpan);
      const per = Math.ceil(glintCount / Math.min(glintCount, GLINT_ARCS));
      while (glintCount > 0) {
        // On the dome's own surface, not inside it: a hashed bearing and a
        // hashed elevation, then the sphere's own parametrisation. Sampling a
        // disc and lifting it put every glint in the middle of the bell and the
        // shape stopped reading.
        const a = Math.random() * TAU;
        const e = Math.random() * Math.PI * 0.5;
        const ring = Math.cos(e) * shell;
        _pos.set(
          centre.x + Math.cos(a) * ring,
          Math.sin(e) * shell * Math.max(0.02, c.glassHeight),
          centre.z + Math.sin(a) * ring
        );
        _emit.position = _pos;
        _emit.radius = radius * 0.05 + 0.04;
        _emit.direction = _dir.set(Math.cos(a) * 0.5, 0.7, Math.sin(a) * 0.5).normalize();
        this.glints.emit(Math.min(per, glintCount), _emit);
        glintCount -= per;
      }
    }

    /* --- the drained colour, coming out of the whole volume --- */
    const dustCount = Math.round(this.dustEmitter.tick(dt, c.dustRate * scale) * g.particleCount);
    if (dustCount > 0) {
      const a = Math.random() * TAU;
      const r = radius * Math.sqrt(Math.random());
      _pos.set(centre.x + Math.cos(a) * r, randRange(0.1, c.fieldLift * 1.6), centre.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = radius * 0.16;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.5;
      _emit.sizeVariance = 0.55;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0.25;
      _emit.tint = null;
      _emit.time = time;
      this.dust.emit(dustCount, _emit);
    }

    /* --- grit, only once there is broken glass to make it --- */
    if (!this._broken) return;
    const gritCount = Math.round(this.gritEmitter.tick(dt, c.gritRate * scale) * g.particleCount);
    if (gritCount > 0) {
      const a = Math.random() * TAU;
      const r = radius * Math.sqrt(Math.random());
      _pos.set(centre.x + Math.cos(a) * r, 0.08, centre.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = radius * 0.12;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.gritSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.85;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.7;
      _emit.life = c.gritLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 9;
      _emit.time = time;
      this.grit.emit(gritCount, _emit);
    }
  }

  /**
   * The one-shot, tested against the live beat lengths every frame.
   *
   * The flag is one-way. Dragging `holdTime` upward after the bell has gone
   * would otherwise push the threshold back past the clock and let the break
   * fire a second time — a hundred panes out of nowhere, and one of the more
   * baffling things a paused editor can do to you.
   */
  _checkBeats() {
    const c = settings.spellbreak;
    if (this._broken) return;
    if (this._land < this._span(c.sealTime) + this._span(c.holdTime)) return;
    this._broken = true;
    this._since = 0;
    this._breakFx();
  }

  /** The bell goes: the panes, the shell of dead air, the ring, the flash. */
  _breakFx() {
    const c = settings.spellbreak;
    const g = settings.global;
    const time = frame.uTime.value;
    const radius = this.radius;

    this._centrePoint(_hit);

    /* the panes themselves */
    this.panes.burst(this.age, Math.min(MAX_PANES, Math.round(c.paneCount * g.particleCount)), 1, 0);

    /* the shell of dead air over the zone */
    _pos.copy(_hit).setY(c.fieldLift * 0.7);
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.burstSize * 0.2,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.55,
      intensity: c.burstIntensity,
      opacity: 0.7,
      fresnel: 1.8,
      displace: 0.35,
      squash: 0.8,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring on the floor, under the pressure front */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _hit, {
      radius: radius * c.shockSpan * g.explosionIntensity,
      life: 0.7,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* glints, grit and a hard slug of drained colour, all at once */
    _emit.position = _hit;
    _emit.radius = radius * 0.7;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.glintSpeed * 2.1;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.95;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.8;
    _emit.life = c.glintLifetime * 1.5;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.glints.emit(Math.round(c.glintBreak * g.particleCount), _emit);

    _emit.radius = radius * 0.55;
    _emit.speed = c.dustSpeed * 2.6;
    _emit.spread = 1.0;
    _emit.size = 0.9;
    _emit.life = c.dustLifetime * 1.2;
    _emit.spin = 0.4;
    this.dust.emit(Math.round(c.dustBreak * g.particleCount), _emit);

    _emit.radius = radius * 0.6;
    _emit.speed = c.gritSpeed * 1.8;
    _emit.spread = 0.85;
    _emit.size = 0.11;
    _emit.life = c.gritLifetime * 1.3;
    _emit.spin = 11;
    this.grit.emit(Math.round(c.gritBreak * g.particleCount), _emit);

    this.ctx.shake.add(
      c.breakShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      24
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.breakFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.4 * g.explosionIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1);

    // The light rides the null front out and then sits over the zone.
    this.pointAt(this.u, this.position).setY(settings.spellbreak.fieldLift * 0.6);

    this._zoneFx(dt, 0.35);
    this.ctx.shake.rumble(settings.spellbreak.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    // Nothing fires here. The bell's beats run on their own clock from the
    // moment the front lands, and the landing is not one of them — putting the
    // break here made a zone cast at three metres shatter before the glass had
    // finished closing.
    this._land = 0;
    this._centrePoint(this.position);
  }

  onFade(dt, t) {
    const c = settings.spellbreak;
    this._land += dt;
    if (this._broken) this._since += dt;
    this._checkBeats();

    // `t` runs 0..1 while the cast stands, then 1..2 while it lets go. The
    // let-go is `1 - out^releaseCurve` rather than a linear ramp: at 2.1 the
    // field holds nearly full strength for most of the fade and then drops,
    // so colour returns to the room *after* the last pane has landed. A linear
    // ramp gave the opposite order — the room recovering while glass was still
    // in the air — and read as the dispel wearing off rather than ending.
    const out = saturate(t - 1);
    const fade = t <= 1 ? 1 : 1 - Math.pow(out, Math.max(0.05, c.releaseCurve));

    this._sync(fade);

    this._centrePoint(this.position);
    this.position.y = c.fieldLift * (this._broken ? 0.45 : 0.9);

    this._zoneFx(dt, fade * (this._broken ? 0.55 : 1));
    this.ctx.shake.rumble(c.rumble * fade * 0.5 * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._live = 1;
    this._broken = false;
    this._land = 0;
    this._since = 0;
    this.panes.clear();
    this.bell.visible = false;
    this.push.visible = false;
    // Idempotent, and `Ability#destroy()` releases it again a line later. Doing
    // it here as well means the world is exact on the frame the cast ends
    // rather than on the frame after it.
    this._field?.release();
    this._field = null;
  }

  dispose() {
    this.bell.dispose();
    this.panes.dispose();
    this.push.dispose();
    super.dispose();
  }
}
