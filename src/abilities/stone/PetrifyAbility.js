import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3
} from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { patchGrowthMaterial } from '../../vfx/GrowthField.js';
import { HullShape, Medium, VolumeHull } from '../../vfx/VolumeHull.js';
import { noiseGLSL } from '../../shaders/lib/noise.glsl.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../../utils/math.js';

/** Hard ceiling on plates in one column. The `facetCount` slider clamps here. */
const MAX_FACETS = 264;
/**
 * Distinct plate silhouettes. Three, for the reason `IceAbility` gives: scaling
 * one shape forty ways buys proportion variety and not *facet* variety, and a
 * column of forty copies of the same chip reads as a repeated prop the moment
 * the camera swings round it.
 */
const VARIANTS = 3;
const SLOTS = Math.ceil(MAX_FACETS / VARIANTS);
const TAU = Math.PI * 2;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _radial = new Vector3();
const _centre = new Vector3();
const _up = new Vector3(0, 1, 0);
const _dummy = new Object3D();
const _quat = new Quaternion();
const _roll = new Quaternion();

/** Deterministic 0..1 hash, so a rebuilt plate is the *same* plate. */
function hash1(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

/* ---------------------------------------------------------------------- */
/* One facet                                                               */
/* ---------------------------------------------------------------------- */
/**
 * A single stone plate: an irregular prism with three rings and two caps.
 *
 * Unit space, the same convention `GrowthField` uses — footprint inside a
 * circle of radius 0.5 on `y = 0`, far face at `y = 1` — so an instance scales
 * the plate's radius and its thickness independently and `vGrowLocal.y` reads
 * straight off in the fragment shader as "how far *out* of the column am I".
 *
 * The plate's own +Y is its **normal**, not its length. That is the whole
 * reason this is not `createCrystalGeometry` with different numbers: a crystal
 * grows along +Y out of the ground, and a facet of a column lies flat against
 * a surface with +Y pointing away from it. Orienting the two the same way and
 * fixing it with a rotation was the first attempt, and it made every scale
 * slider shear the plate, because the instance scale is applied after the
 * rotation and `(radius, thickness, radius)` is not uniform.
 *
 * The shoulder ring is what keeps it from being a plain frustum: real broken
 * stone is widest a little way off the face it was quarried from, and the two
 * hard edges that gives you are most of what the flat-shaded normals have to
 * work with.
 *
 * @param {number} seed      deterministic shape seed
 * @param {object} shape     `{ sides, taper, rough, shoulder }`, live from settings
 */
function createFacetGeometry(seed, shape) {
  const sides = Math.max(4, Math.min(9, Math.round(shape?.sides ?? 6)));
  const taper = Math.max(0.05, Math.min(1.6, shape?.taper ?? 0.66));
  const rough = Math.max(0, Math.min(1, shape?.rough ?? 0.44));
  const shoulder = Math.max(0.05, Math.min(0.95, shape?.shoulder ?? 0.62));

  // One jittered set of bearings, shared by all three rings, so the side faces
  // stay continuous planes up the plate rather than twisting into a screw.
  const angles = [];
  for (let i = 0; i < sides; i++) {
    const wobble = (hash1(seed * 3.13 + i * 7.7) - 0.5) * (TAU / sides) * 0.6 * rough * 2;
    angles.push((i / sides) * TAU + wobble);
  }

  const ringY = [0, shoulder, 1];
  const ringR = [0.5 * lerp(0.78, 1, taper * 0.5), 0.5, 0.5 * taper];

  const rings = ringY.map((y, ring) =>
    angles.map((angle, i) => {
      const chip = 1 + (hash1(seed * 11.1 + ring * 13.7 + i * 3.9) - 0.5) * rough * 1.15;
      const r = Math.max(0.004, ringR[ring] * chip);
      return [Math.cos(angle) * r, y, Math.sin(angle) * r];
    })
  );

  const positions = [];
  const push = (p) => positions.push(p[0], p[1], p[2]);

  for (let ring = 0; ring < rings.length - 1; ring++) {
    const lower = rings[ring];
    const upper = rings[ring + 1];
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      push(lower[i]); push(lower[j]); push(upper[i]);
      push(lower[j]); push(upper[j]); push(upper[i]);
    }
  }

  // Both caps are fans off their own centre. The outer one is nudged off-axis
  // so the face that catches the light is never perfectly flat.
  const inner = [0, 0, 0];
  const outer = [
    (hash1(seed * 17.3) - 0.5) * 0.12 * rough,
    1,
    (hash1(seed * 19.7) - 0.5) * 0.12 * rough
  ];
  const base = rings[0];
  const top = rings[2];
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    push(inner); push(base[j]); push(base[i]);
    push(top[i]); push(top[j]); push(outer);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  // Non-indexed + per-face normals: this is what makes the facets crisp, and a
  // facet that is not crisp is a pebble.
  geometry.computeVertexNormals();
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* The stone                                                               */
/* ---------------------------------------------------------------------- */
/**
 * Grey stone, shaded to be *quiet*.
 *
 * Built on `MeshStandardMaterial` through `patchGrowthMaterial` so the plates
 * take the stage's real shadows and its probe. Everything injected on top is
 * subtractive in spirit: a key-facing term that darkens the faces turned away,
 * world-space grain so neighbouring plates look quarried from one block, a rim
 * darkening in local space so each plate keeps its own edge, and a pale dust
 * film on a plate that has just landed.
 *
 * The one emissive term is `uEmission`, which ships at 0.06 and is mixed almost
 * entirely into the arrival flash. There is no fresnel rim here at all. Every
 * other slot in this sandbox is fighting the bloom pass for headroom; this one
 * is trying not to be noticed, and taking the rim out was the single change
 * that made it read as rock instead of as ceramic.
 */
function createPetrifyMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.88,
    metalness: 0.0,
    flatShading: true,
    transparent: true,
    depthWrite: true
  });

  const uniforms = {
    uLightDir: frame.uLightDir,
    uColorStone: { value: new Color() },
    uColorShade: { value: new Color() },
    uColorSeam: { value: new Color() },
    uColorPale: { value: new Color() },
    uGrain: { value: 0.75 },
    uGrainScale: { value: 5.5 },
    uSeamDepth: { value: 0.6 },
    uFacetSharp: { value: 0.6 },
    uBirthPale: { value: 0.55 },
    uEmission: { value: 0.06 }
  };

  patchGrowthMaterial(material, {
    environment,
    uniforms,
    common: /* glsl */ `
      uniform vec3  uLightDir;
      uniform vec3  uColorStone;
      uniform vec3  uColorShade;
      uniform vec3  uColorSeam;
      uniform vec3  uColorPale;
      uniform float uGrain;
      uniform float uGrainScale;
      uniform float uSeamDepth;
      uniform float uFacetSharp;
      uniform float uBirthPale;
      uniform float uEmission;
      ${noiseGLSL}
    `,
    fragment: /* glsl */ `
      vec3  N   = normalize(normal);
      float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);

      // The same key direction the lit meshes are using. A fake shading term
      // that disagrees with the real sun reads as a sticker, every time.
      float key = clamp(dot(N, uLightDir) * 0.5 + 0.5, 0.0, 1.0);
      vec3  body = mix(uColorShade, uColorStone, key);

      // Grain in WORLD space, so two plates that ended up beside each other
      // look cut from one block. In local space each plate carries its own
      // copy of the same speckle and the column reads as forty identical
      // pebbles glued together, which is exactly what the first pass looked
      // like.
      float grain = fbm3(vGrowWorld * uGrainScale + vGrowSeed * 13.0) * 0.5 + 0.5;
      body = mix(body, uColorShade, (1.0 - grain) * uGrain * 0.55);

      // The seam runs in LOCAL space: it is this plate's own rim, and it has to
      // follow it however the plate is scaled.
      float rim = smoothstep(0.30, 0.5, length(vGrowLocal.xz));
      body = mix(body, uColorSeam, clamp(rim * uSeamDepth, 0.0, 1.0));

      // Lift the faces pointing at the camera so the column reads as a bundle
      // of planes rather than one smooth log.
      body *= mix(1.0, 0.58 + 0.85 * ndv, uFacetSharp);

      // Rock dust on a plate that has just arrived — albedo, not emission.
      body = mix(body, uColorPale, clamp(vGrowBirth * uBirthPale, 0.0, 1.0));

      diffuseColor.rgb *= body;

      // The only light this ability makes. Deliberately tiny, and weighted onto
      // the arrival so a standing column emits essentially nothing.
      totalEmissiveRadiance += uColorPale * uEmission * (0.2 + 0.8 * vGrowBirth);
    `
  });

  material.userData.uniforms = uniforms;

  /** Pull the palette and every shading control from the live settings. */
  material.userData.sync = () => {
    const c = settings.petrify;
    const g = settings.global;

    uniforms.uColorStone.value.copy(getColor(c.colorStone));
    uniforms.uColorShade.value.copy(getColor(c.colorShade));
    uniforms.uColorSeam.value.copy(getColor(c.colorSeam));
    uniforms.uColorPale.value.copy(getColor(c.colorPale));

    uniforms.uGrain.value = c.grain * g.shaderIntensity;
    uniforms.uGrainScale.value = c.grainScale * g.noiseFrequency;
    uniforms.uSeamDepth.value = c.seamDepth;
    uniforms.uFacetSharp.value = c.facetSharp;
    uniforms.uBirthPale.value = c.birthPale;
    uniforms.uEmission.value = c.emission * g.glow;

    material.roughness = c.stoneRoughness;
    material.envMapIntensity = c.envIntensity;
    material.opacity = c.opacity * g.opacity;
  };

  material.userData.sync();
  return material;
}

/* ---------------------------------------------------------------------- */
/* The ability                                                             */
/* ---------------------------------------------------------------------- */

/**
 * PETRIFY — a column of stone that gathers out of the air and then lets go.
 *
 * Three beats. The gaze runs the aimed line at `speed`; behind it grey plates
 * appear out of nothing on a **cylindrical shell** around the cast axis and
 * converge inward until they lock against the column's surface. The column
 * stands for `holdTime`. Then it crumbles from the caster's end forward — the
 * plates shrink to nothing while, in the same volume, a raymarched fall of sand
 * takes over.
 *
 * **THE TRICK — accretion, then collapse, with an overlap in the middle.**
 *
 * *Accretion* is the placement, not the scaling. Each facet's world position is
 * `axis(s) + radial(θ) · r`, and `r` is a live lerp from `shellRadius` down to
 * the column's own surface radius driven by that facet's personal arrival
 * clock. Everything else about the approach exists to stop it being a straight
 * radial slide: `swirl` sweeps the bearing round the axis on the way in,
 * `tumble` rolls the plate about its own normal, `shellDrift` lets it wander
 * along the axis while it is still out there, and a damped spring carries it
 * `overshoot` past the surface so it arrives with a knock. The first version
 * just scaled the plates up where they would end up, and it read as a row of
 * props fading in — no amount of colour fixed it, because the missing thing was
 * motion toward a place.
 *
 * *Collapse* is a handoff, and the handoff is the part that can visibly break.
 * `crumbleTime` shrinks the plates on a front that runs the line; the sand
 * volume's clock starts `sandLead` seconds **earlier**, during the tail of the
 * hold, so the sand is already at density before the first plate has finished
 * going. Get that number to zero and there is one frame where the column is
 * simply not there.
 *
 * **Why this field is written out longhand rather than handed to
 * `GrowthField`.** It was tried first, and it cannot express the trick. That
 * module places every instance in a horizontal *band* around the cast line and
 * re-derives the position from global params only — there is no per-instance
 * bearing about the axis and no way for an instance's own emergence clock to
 * move it, so neither the shell nor the convergence survives the port. What did
 * come across is the discipline: a record here holds dice rolls and one
 * timestamp, `patchGrowthMaterial` does the shader wiring, and the plates carry
 * the same `aSeed` / `aBirth` attributes every other growth field in the
 * project uses. The module's material helper is doing real work; its placement
 * simply is not the shape of this ability.
 *
 * **The rule that makes the editor work.** A facet record holds an along-line
 * fraction, a bearing fraction, five signed jitters and one timestamp. Not one
 * metre, radian or second is captured. `shellRadius`, `columnRadius`, `swirl`
 * and `axisSag` are all resolved against `settings.petrify` inside the update
 * loop, on a zero-length frame included — so pausing mid-accretion and dragging
 * `shellRadius` re-throws the plates that are still in flight *and* re-seats the
 * ones that have already landed.
 */
export class PetrifyAbility extends Ability {
  constructor(context) {
    super('petrify', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.material = createPetrifyMaterial(this.ctx.environment);

    /**
     * Numeric signature of the last geometry build, compared value by value.
     * `IceAbility` composes a template literal for this every frame; at one
     * ability that is invisible and at fifty it is fifty strings a frame for
     * the collector to sweep up for nothing.
     */
    this._shapeSignature = new Float64Array(4).fill(NaN);
    this._shape = { sides: 6, taper: 0.66, rough: 0.44, shoulder: 0.62 };

    this.meshes = [];
    this.seedAttributes = [];
    this.birthAttributes = [];

    for (let v = 0; v < VARIANTS; v++) {
      const seeds = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      const births = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      for (let i = 0; i < SLOTS; i++) seeds.array[i] = Math.random() * 10;

      const geometry = createFacetGeometry(4.7 + v * 19.3, this._shape);
      geometry.setAttribute('aSeed', seeds);
      geometry.setAttribute('aBirth', births);

      const mesh = new InstancedMesh(geometry, this.material, SLOTS);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      // Solid world geometry: it belongs in the depth prepass, which is what
      // lets the dust and the sand volume fade softly where they meet it.
      mesh.layers.set(LAYER.WORLD);
      mesh.renderOrder = 2;
      this.group.add(mesh);

      this.meshes.push(mesh);
      this.seedAttributes.push(seeds);
      this.birthAttributes.push(births);
    }

    /**
     * The sand that replaces the column.
     *
     * BOX rather than CYLINDER, and the reason is that the column is horizontal
     * and the sand is not: the volume the grains occupy is the column's
     * footprint extruded straight *down* to the floor, which a box contains
     * tightly and a cylinder standing on +Y does not contain at all. `maxSteps`
     * is low because this hull is long and the camera sees a lot of it —
     * coverage is the expensive axis, not resolution.
     */
    this.sand = new VolumeHull({
      hull: HullShape.BOX,
      medium: Medium.SAND,
      prefix: 'sand',
      maxSteps: 32,
      renderOrder: 12
    });
    this.group.add(this.sand.mesh);

    /**
     * Fixed-size record pool. Dice and one timestamp — see the class comment.
     */
    this.records = [];
    for (let i = 0; i < MAX_FACETS; i++) {
      this.records.push({
        along: 0, // 0..1 down the cast line
        angle: 0, // 0..1 of a turn about the cast axis
        roll: 0, // 0..1 of a turn about the plate's own normal
        shellRoll: 0, // -1..1, how far out this one starts
        driftRoll: 0, // -1..1, along-axis wander while it is still out there
        sizeRoll: 0, // -1..1
        swirlSign: 1, // ±1, which way round the axis it comes in
        stagger: 0, // 0..1 of `accreteStagger`
        accreteAt: -1, // absolute age it was released at, or -1
        landed: false // has its arrival puff fired
      });
    }

    this._activeCount = 0;
    /** Metres of crumble front already paid out in ground marks. */
    this._duneDistance = 0;
  }

  /**
   * Rebuild the plates when a *shape* control moves.
   *
   * Facet count, taper, roughness and shoulder cannot be expressed as a
   * per-instance transform, so they are baked in — and one plate is under a
   * hundred triangles, cheap enough to rebuild outright rather than approximate
   * in a vertex shader. That is what keeps them live sliders with the clock
   * stopped.
   */
  _syncGeometry() {
    const c = settings.petrify;
    const shape = this._shape;
    shape.sides = c.facetSides;
    shape.taper = c.facetTaper;
    shape.rough = c.facetRough;
    shape.shoulder = c.facetShoulder;

    const signature = this._shapeSignature;
    let changed = false;
    if (signature[0] !== shape.sides) { signature[0] = shape.sides; changed = true; }
    if (signature[1] !== shape.taper) { signature[1] = shape.taper; changed = true; }
    if (signature[2] !== shape.rough) { signature[2] = shape.rough; changed = true; }
    if (signature[3] !== shape.shoulder) { signature[3] = shape.shoulder; changed = true; }
    if (!changed) return;

    for (let v = 0; v < VARIANTS; v++) {
      const mesh = this.meshes[v];
      const previous = mesh.geometry;
      const geometry = createFacetGeometry(4.7 + v * 19.3, shape);
      // The per-instance attributes are state, not shape — carry them over.
      geometry.setAttribute('aSeed', this.seedAttributes[v]);
      geometry.setAttribute('aBirth', this.birthAttributes[v]);
      mesh.geometry = geometry;
      previous.dispose();
    }
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Rock dust hanging around the column. Non-additive so it genuinely
    // occludes: an additive haze on a grey ability lifts the whole thing off
    // the floor and undoes the restraint.
    this.dust = particles.get('petrify.dust', {
      capacity: 2200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.dust.uniforms.uDrag.value = 2.1;
    this.dust.uniforms.uEndSize.value = 3.0;
    this.dust.uniforms.uSizeIn.value = 0.12;
    this.dust.uniforms.uFadeIn.value = 0.18;
    this.dust.uniforms.uFadeOut.value = 0.32;

    // Chips flicked off as a plate knocks into the column.
    this.grit = particles.get('petrify.grit', {
      capacity: 1600,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.grit.uniforms.uDrag.value = 0.3;
    this.grit.uniforms.uEndSize.value = 0.75;
    this.grit.uniforms.uFadeOut.value = 0.7;

    // The fall of sand, as discrete grains. Stretched along the velocity,
    // which at these speeds is a two-centimetre smear — just enough that the
    // fall reads as a fall rather than as a cloud of dots.
    this.grains = particles.get('petrify.grains', {
      capacity: 3000,
      shape: ParticleShape.STREAK,
      additive: false,
      stretch: true,
      softFade: 0.3
    });
    this.grains.uniforms.uDrag.value = 0.9;
    this.grains.uniforms.uEndSize.value = 0.5;
    this.grains.uniforms.uSizeIn.value = 0.04;
    this.grains.uniforms.uFadeIn.value = 0.06;
    this.grains.uniforms.uFadeOut.value = 0.45;

    this.dustEmitter = new RateEmitter();
    this.gritEmitter = new RateEmitter();
    this.grainEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._activeCount;
  }

  /** The column stands for `holdTime`, then the fade crumbles it. */
  get impactDuration() {
    return Math.max(0.1, settings.petrify.holdTime * settings.global.lifetime);
  }

  /**
   * The crumble, plus the tail the sand keeps falling for once every plate has
   * gone. Splitting the two is what lets the sand outlive the stone, which is
   * how a collapse actually ends.
   */
  get fadeDuration() {
    const c = settings.petrify;
    return Math.max(0.1, c.crumbleTime + c.sandTail);
  }

  /** Stone does not gutter and it does not glint. It sits there. */
  lightShimmer() {
    return 1;
  }

  /* ------------------------------------------------------------------ */
  /* The axis — every metre resolved from live settings                  */
  /* ------------------------------------------------------------------ */

  /** Metres of column between the caster and the target, always positive. */
  _span() {
    return Math.max(0.2, this.length - settings.petrify.axisForward);
  }

  /**
   * A point on the column's *axis* at `s` along it, 0..1.
   *
   * The sag is a half-sine rather than a parabola for one reason: it has to be
   * exactly zero at both ends, or the column detaches from the caster's hand at
   * one end and hangs below the impact point at the other.
   */
  _axisPoint(s, out) {
    const c = settings.petrify;
    const t = saturate(s);
    out.copy(this.origin).addScaledVector(this.direction, c.axisForward + t * this._span());
    out.y = lerp(c.axisHeight, c.endHeight, t) - c.axisSag * Math.sin(t * Math.PI);
    return out;
  }

  /** The column's surface radius at `s`, metres. */
  _surfaceRadius(s) {
    const c = settings.petrify;
    return lerp(c.columnRadiusNear, c.columnRadius, Math.pow(saturate(s), Math.max(0.05, c.columnCurve)));
  }

  /* ------------------------------------------------------------------ */
  /* The clocks                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * How far one facet is through its arrival: 0 → 1 with a damped overshoot
   * past 1, negative while it has not been released yet.
   */
  _arrival(record) {
    if (record.accreteAt < 0) return -1;
    const c = settings.petrify;
    const elapsed = this.age - record.accreteAt;
    if (elapsed < 0) return -1;

    const time = Math.max(0.02, c.accreteTime);
    if (elapsed <= time) return Easing.outQuint(saturate(elapsed / time));

    // Past the surface and back: the knock that says the plate hit something.
    const after = elapsed - time;
    const spring = Math.sin(after * c.springRate) * Math.exp(-after / Math.max(0.05, c.settle));
    return 1 + c.overshoot * spring;
  }

  /**
   * How far one facet is through its own collapse, 0..1.
   *
   * The front runs the line: `crumbleStagger` is how much of the crumble is
   * spent travelling rather than collapsing, and `crumbleSpan` is how long one
   * plate takes once its turn comes. Both are fractions of `crumbleTime`, so
   * dragging that one slider re-times the whole collapse and the two shape
   * controls keep meaning what they say.
   */
  _crumbleOf(record) {
    if (this.phase !== AbilityPhase.FADE) return 0;
    const c = settings.petrify;
    const k = saturate(this.fadeTime / Math.max(0.05, c.crumbleTime));
    const stagger = saturate(c.crumbleStagger);
    const span = Math.max(0.05, c.crumbleSpan);
    return saturate((k * (1 + stagger) - record.along * stagger) / span);
  }

  /** Where the crumble front has reached, 0..1 along the line. */
  _crumbleFront() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    const c = settings.petrify;
    const k = saturate(this.fadeTime / Math.max(0.05, c.crumbleTime));
    const stagger = saturate(c.crumbleStagger);
    return stagger > 1e-3 ? saturate((k * (1 + stagger)) / stagger) : k;
  }

  /**
   * Seconds the sand has been falling for — and the whole reason the handoff
   * has no hole in it.
   *
   * It runs `sandLead` seconds ahead of the crumble by borrowing the tail of
   * the hold: while the column is still standing and `sandLead` seconds remain
   * on the impact clock, the sand has already started. Everything else about
   * the collapse keys off `fadeTime`; this is the one clock that does not.
   */
  _sandAge() {
    const c = settings.petrify;
    if (this.phase === AbilityPhase.FADE) return c.sandLead + this.fadeTime;
    if (this.phase === AbilityPhase.IMPACT) {
      return Math.max(0, c.sandLead - (this.impactDuration - this.impactTime));
    }
    return 0;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.petrify;

    this.dustEmitter.reset();
    this.gritEmitter.reset();
    this.grainEmitter.reset();
    this._duneDistance = 0;

    const wanted = Math.min(MAX_FACETS, Math.max(1, Math.round(c.facetCount)));
    this._activeCount = wanted;

    for (let i = 0; i < wanted; i++) {
      const record = this.records[i];
      record.accreteAt = -1;
      record.landed = false;
      // Stratified along the line rather than uniform, so a sparse column still
      // covers its whole length instead of leaving a gap somebody has to see.
      record.along = (i + Math.random()) / wanted;
      record.angle = Math.random();
      record.roll = Math.random();
      record.shellRoll = randRange(-1, 1);
      record.driftRoll = randRange(-1, 1);
      record.sizeRoll = randRange(-1, 1);
      record.swirlSign = Math.random() < 0.5 ? -1 : 1;
      record.stagger = Math.random();
    }

    for (let i = wanted; i < MAX_FACETS; i++) this.records[i].accreteAt = -1;
    for (let v = 0; v < VARIANTS; v++) this.meshes[v].count = 0;

    this._sync(0);
  }

  /** Release every facet the gaze has now reached. `limit` is 0..1. */
  _triggerUpTo(limit) {
    const c = settings.petrify;
    for (let i = 0; i < this._activeCount; i++) {
      const record = this.records[i];
      if (record.accreteAt >= 0) continue;
      if (record.along > limit) continue;
      record.accreteAt = this.age + record.stagger * c.accreteStagger;
    }
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Rebuild every plate's matrix from the live settings, and re-place the sand.
   * Allocation-free, and correct on a zero-length frame.
   */
  _sync(dt) {
    const c = settings.petrify;
    const g = settings.global;

    this._syncGeometry();
    this.material.userData.sync();
    this._syncParticles(c, g);

    const birthFade = Math.max(0.02, c.birthFade);
    const jitter = g.randomness;
    let used0 = 0;
    let used1 = 0;
    let used2 = 0;

    for (let i = 0; i < this._activeCount; i++) {
      const record = this.records[i];
      const variant = i % VARIANTS;
      const slot = (i / VARIANTS) | 0;
      const arrival = this._arrival(record);

      if (arrival < 0) {
        // Not released yet. Park it out of the view rather than drawing a
        // degenerate matrix at the origin, which shows as a speck on the floor.
        _dummy.position.set(0, -999, 0);
        _dummy.quaternion.identity();
        _dummy.scale.setScalar(0.0001);
        _dummy.updateMatrix();
        this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
        this.birthAttributes[variant].array[slot] = 0;
        if (variant === 0) used0 = Math.max(used0, slot + 1);
        else if (variant === 1) used1 = Math.max(used1, slot + 1);
        else used2 = Math.max(used2, slot + 1);
        continue;
      }

      const lock = Math.max(0, Math.min(1.3, arrival));
      const crumble = this._crumbleOf(record);
      const s = record.along;

      /* --- where it is: a point on the shell, sliding onto the surface --- */
      const shell = c.shellRadius * (1 + record.shellRoll * c.shellJitter * jitter);
      const radius = lerp(shell, this._surfaceRadius(s), lock);
      const theta = record.angle * TAU + c.swirl * (1 - lock) * record.swirlSign;

      _radial.copy(this.side).multiplyScalar(Math.cos(theta));
      _radial.addScaledVector(_up, Math.sin(theta));

      this._axisPoint(s, _dummy.position);
      _dummy.position.addScaledVector(_radial, radius);
      _dummy.position.addScaledVector(
        this.direction,
        c.shellDrift * record.driftRoll * (1 - lock) * jitter
      );
      // It falls as it goes to pieces, quadratically, because it is falling.
      if (crumble > 0) _dummy.position.y -= c.crumbleDrop * crumble * crumble;

      /* --- the arrival puff, once, as it touches the column --- */
      if (!record.landed && arrival > 0.82) {
        record.landed = true;
        this._landFx(c, g, _dummy.position);
      }

      /* --- which way it faces: +Y is the plate's normal --- */
      _quat.setFromUnitVectors(_up, _radial);
      _roll.setFromAxisAngle(
        _up,
        record.roll * TAU + c.tumble * (1 - lock) * record.swirlSign + c.crumbleSpin * crumble
      );
      _quat.multiply(_roll);

      /* --- how big --- */
      const plate =
        lerp(c.facetSizeNear, c.facetSize, s) * (1 + record.sizeRoll * c.facetSizeJitter * jitter);
      const grow = Math.min(1, arrival) * (1 - crumble);

      _dummy.quaternion.copy(_quat);
      _dummy.scale.set(plate, Math.max(0.004, plate * c.facetThickness), plate);
      _dummy.scale.multiplyScalar(Math.max(0.0001, grow));
      _dummy.updateMatrix();

      this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
      this.birthAttributes[variant].array[slot] = saturate(
        1 - (this.age - record.accreteAt) / birthFade
      );
      if (variant === 0) used0 = Math.max(used0, slot + 1);
      else if (variant === 1) used1 = Math.max(used1, slot + 1);
      else used2 = Math.max(used2, slot + 1);
    }

    this.meshes[0].count = used0;
    this.meshes[1].count = used1;
    this.meshes[2].count = used2;
    for (let v = 0; v < VARIANTS; v++) {
      this.meshes[v].instanceMatrix.needsUpdate = true;
      this.birthAttributes[v].needsUpdate = true;
    }

    this._syncSand(c, g);
    if (dt > 0) this._grainFx(dt, c, g);
  }

  /**
   * Place, size and thin the sand.
   *
   * The box is the column's footprint extruded to the floor: half-width from
   * the column radius, height from the axis plus a plate's worth of headroom,
   * half-length from the span. `VolumeHull`'s one rule is that the hull must be
   * the smallest shape that still contains the field — too small and the sand
   * is sliced off along a dead straight line, too big and every ray spends its
   * step budget crossing vacuum. `sandGirth` and `sandHead` are the two knobs
   * that let you find that edge with the clock stopped.
   */
  _syncSand(c, g) {
    const age = this._sandAge();

    let fade = Easing.outQuad(saturate(age / Math.max(0.05, c.sandOnset)));
    if (this.phase === AbilityPhase.FADE) {
      fade *= 1 - Easing.inQuad(saturate((this.fadeTime - c.crumbleTime) / Math.max(0.05, c.sandTail)));
    }
    fade = saturate(fade * c.sandDust);

    const span = this._span();
    this._axisPoint(0.5, _centre);
    // BOX stands *on* the floor, so the anchor is the midpoint's ground shadow
    // and the height is measured up from there.
    _centre.y = 0;

    const half = Math.max(c.columnRadius, c.columnRadiusNear) * c.sandGirth;
    const top = Math.max(c.axisHeight, c.endHeight) + c.columnRadius + c.sandHead;

    this.sand
      .place(_centre, this.direction)
      .setSize(half, top, span * 0.5)
      .setFade(fade)
      .sync(c, g);
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  _syncParticles(c, g) {
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
    this.dust.uniforms.uTurbulence.value = 0.3 * g.turbulence;

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

    this.grains.setGradient(
      getColor(c.colorGrainA),
      getColor(c.colorGrainB),
      getColor(c.colorGrainC),
      getColor(c.colorGrainD)
    );
    this.grains.uniforms.uGravity.value.set(0, c.grainGravity, 0);
    this.grains.uniforms.uSizeScale.value = c.grainSize * g.particleSize * 7;
    this.grains.uniforms.uLifeScale.value = c.grainLifetime * 0.5 * g.particleLifetime;
    this.grains.uniforms.uSpeedScale.value = g.particleSpeed;
    this.grains.uniforms.uOpacity.value = c.grainOpacity * g.opacity;
    this.grains.uniforms.uStretch.value = c.grainStretch;
  }

  /** A few chips and a breath of dust as a plate knocks into the column. */
  _landFx(c, g, position) {
    // Only some plates throw anything. Two hundred puffs at once buries the
    // column in haze and hides the silhouette, which is the whole ability.
    if (Math.random() > 0.35) return;
    const time = frame.uTime.value;

    _emit.position = _pos.copy(position);
    _emit.radius = c.columnRadius * 0.5;
    _emit.direction = _dir.copy(_radial);
    _emit.speed = c.gritSpeed;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.08;
    _emit.sizeVariance = 0.7;
    _emit.life = c.gritLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 6;
    _emit.tint = null;
    _emit.time = time;
    this.grit.emit(Math.round(3 * g.particleCount), _emit);
  }

  /** The haze the accretion sheds, along whatever part of the column exists. */
  _dustFx(dt, reach) {
    const c = settings.petrify;
    const g = settings.global;
    const count = Math.round(this.dustEmitter.tick(dt, c.dustRate) * g.particleCount);
    if (count <= 0) return;

    const s = Math.random() * Math.max(0.02, reach);
    this._axisPoint(s, _pos);
    _emit.position = _pos;
    _emit.radius = c.shellRadius * 0.4;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dustSpeed;
    _emit.speedVariance = 0.7;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.7;
    _emit.sizeVariance = 0.5;
    _emit.life = c.dustLifetime;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.3;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.dust.emit(count, _emit);
  }

  /**
   * The grains, and the dust rings where they land.
   *
   * Both are keyed off the crumble *front* rather than off the whole column, so
   * the fall travels the line exactly as the collapse does. Emitting over the
   * whole span instead was the obvious first version and it dropped the entire
   * column's worth of sand on frame one.
   */
  _grainFx(dt, c, g) {
    if (this.phase !== AbilityPhase.FADE) return;
    const front = this._crumbleFront();
    if (front <= 0) return;

    const count = Math.round(this.grainEmitter.tick(dt, c.grainRate) * g.particleCount);
    if (count > 0) {
      const s = Math.random() * front;
      this._axisPoint(s, _pos);
      _emit.position = _pos;
      _emit.radius = this._surfaceRadius(s) * 1.1;
      _emit.direction = _dir.set(0, -1, 0);
      _emit.speed = c.grainSpeed;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.35;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.6;
      _emit.life = c.grainLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.grains.emit(count, _emit);
    }

    // Chunks as well as grains: a column does not dissolve, it sheds lumps and
    // *then* dissolves. Without these the fall is uniformly fine and reads as
    // a smoke effect that happens to be brown.
    const chips = Math.round(this.gritEmitter.tick(dt, c.gritRate) * g.particleCount);
    if (chips > 0) {
      const s = Math.random() * front;
      this._axisPoint(s, _pos);
      _emit.position = _pos;
      _emit.radius = this._surfaceRadius(s);
      _emit.direction = _dir.set(0, -1, 0);
      _emit.speed = c.gritSpeed * 0.5;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.5;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.7;
      _emit.life = c.gritLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 5;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.grit.emit(chips, _emit);
    }

    /* the dust rings the fall leaves on the floor */
    const step = 1 / Math.max(0.05, c.duneRate);
    const reached = front * this._span();
    while (reached - this._duneDistance >= step) {
      this._duneDistance += step;
      const s = saturate(this._duneDistance / this._span());
      this._axisPoint(s, _pos);
      _pos.y = 0;
      _pos.x += this.side.x * randRange(-0.5, 0.5) * c.columnRadius;
      _pos.z += this.side.z * randRange(-0.5, 0.5) * c.columnRadius;

      this.ctx.decals.spawn(DecalType.DUSTRING, _pos, {
        radius: c.duneRadius * randRange(0.7, 1.3),
        life: c.duneLife,
        intensity: c.duneIntensity,
        colorA: getColor(c.colorDune),
        colorB: getColor(c.colorDuneEdge),
        height: 0.014
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._triggerUpTo(this.u);
    this._sync(dt);
    this._dustFx(dt, this.u);

    // The light rides the front, on the axis rather than on the floor.
    this._axisPoint(this.u, this.position);

    this.ctx.shake.rumble(settings.petrify.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.petrify;
    const g = settings.global;

    // Everything still waiting goes now: the far end of the column closes.
    this._triggerUpTo(1);

    this._axisPoint(1, _pos);

    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.burstSize * 0.35,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.9,
      intensity: c.burstIntensity,
      opacity: 0.7,
      fresnel: 0.9,
      displace: 0.5,
      squash: 0.85,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the floor under the far end takes the weight */
    this.pointAt(1, _pos);
    this.ctx.decals.spawn(DecalType.CRACK, _pos, {
      radius: c.crackRadius,
      life: c.crackLife,
      width: 0.5,
      intensity: c.crackIntensity,
      colorA: getColor(c.colorCrack),
      colorB: getColor(c.colorCrackEdge)
    });

    _emit.position = _pos;
    _emit.radius = c.crackRadius * 0.6;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.gritSpeed * 1.8;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.85;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.11;
    _emit.sizeVariance = 0.7;
    _emit.life = c.gritLifetime * 1.3;
    _emit.lifeVariance = 0.5;
    _emit.spin = 8;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.grit.emit(Math.round(c.burstGrit * g.particleCount), _emit);

    this.ctx.shake.add(
      c.lockShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      14
    );
    this.lightBoost = c.lightIntensity * 0.6 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.petrify;
    this._sync(dt);

    // The light sits on the middle of the column while it stands, and follows
    // the collapse down the line once it lets go.
    if (this.phase === AbilityPhase.FADE) this._axisPoint(this._crumbleFront(), this.position);
    else this._axisPoint(0.5, this.position);

    // The column keeps shedding while it stands; the crumble is the loud part,
    // and "loud" here is a fifth of what the storm slots do.
    this._dustFx(dt, 1);

    if (this.phase === AbilityPhase.FADE && t < 1.4) {
      this.ctx.shake.rumble(c.crumbleShake * settings.global.cameraShake * 0.3, dt);
    }
  }

  onDestroy() {
    this._activeCount = 0;
    for (let v = 0; v < VARIANTS; v++) this.meshes[v].count = 0;
    this.sand.setFade(0);
  }

  dispose() {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.material.dispose();
    this.sand.dispose();
    super.dispose();
  }
}
