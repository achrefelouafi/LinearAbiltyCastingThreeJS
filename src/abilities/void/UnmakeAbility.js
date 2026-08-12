import { BufferAttribute, BufferGeometry, Color, MeshStandardMaterial, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { GrowthField, GrowthEmerge, GrowthLayout, patchGrowthMaterial } from '../../vfx/GrowthField.js';
import { GroundField, GroundMode } from '../../vfx/GroundField.js';
import {
  DissolveMode,
  DissolveSpace,
  MAX_RUNGS,
  dissolveParams,
  dissolveUniforms,
  patchDissolveMaterial,
  syncDissolve
} from '../../vfx/Dissolve.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp } from '../../utils/math.js';

/** Hard ceiling on blocks per cast. The `blockCount` slider clamps here. */
const MAX_BLOCKS = 160;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();

/**
 * Live parameter objects for the three shared modules.
 *
 * Filled from `settings.unmake` every frame and handed straight over. Module
 * scope rather than per-instance because four concurrent casts each fill and
 * consume them inside their own `update()` and never across one — the
 * `UmbralSpearsAbility` precedent.
 */
const _growth = {};
const _shape = {};
const _trench = {};
const _dissolve = dissolveParams();

/* ---------------------------------------------------------------------- */
/* One block                                                               */
/* ---------------------------------------------------------------------- */
/**
 * A quarried cube, in `GrowthField`'s unit space: footprint inside a circle of
 * radius 0.5 on `y = 0`, top at `y = 1`.
 *
 * It is a **subdivided** cube, and the subdivision is the whole reason this
 * function is not four lines. The voxel ladder claims *vertices*, not faces: a
 * lattice cell with no vertex inside it cannot become a cube, it can only
 * stretch the triangle that happens to cross it. So the segment count and
 * `cellSize` are a pair, and the block header in `config/abilities/unmake.js`
 * says which way round to move them. Twelve segments against a cell of 0.2
 * puts two and a half vertices along each cell edge, which is the cheapest grid
 * that still lets a chunk carry a whole face away with it.
 *
 * Two deformations turn the grid into stone, and both are pure functions of the
 * rest position — which matters more than it looks. The six faces are built
 * independently and their shared edges are *duplicate* vertices, so anything
 * that displaced them by index, or by face, or by a per-vertex die, would tear
 * the block open along all twelve edges. A function of position alone gives
 * coincident vertices identical answers and the block stays watertight.
 *
 *  - **`round`** blends the cube toward the sphere of the same radius. At 0.22
 *    it is a chamfer: the corners come in, the faces bulge a little, and the
 *    silhouette stops being a programmer's cube.
 *  - **`chip`** knocks the corners off, displacing along the outward direction
 *    by a hash of a *coarse lattice cell* rather than per vertex. Per-vertex
 *    noise was the first version and it read as a crumpled paper bag; a hashed
 *    lattice moves whole patches of the surface together, which is what a
 *    chisel does.
 *
 * @param {number} variant which of the three silhouettes
 * @param {object} shape   `{ segments, round, chip, chipScale }`, live
 */
function createBlockGeometry(variant, shape) {
  const n = Math.max(3, Math.min(18, Math.round(shape?.segments ?? 12)));
  const roundness = Math.max(0, Math.min(1, shape?.round ?? 0.22));
  const chip = Math.max(0, Math.min(1, shape?.chip ?? 0.3));
  const chipScale = Math.max(0.2, shape?.chipScale ?? 3.2);
  const seed = 5.7 + variant * 31.3;

  const hash3 = (x, y, z) => {
    const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed) * 43758.5453;
    return s - Math.floor(s);
  };

  // (normal, U, V) per face, chosen so U × V points outward — the winding below
  // depends on it and `computeVertexNormals` would otherwise light the block
  // from inside.
  const FACES = [
    [1, 0, 0, 0, 0, -1, 0, 1, 0],
    [-1, 0, 0, 0, 0, 1, 0, 1, 0],
    [0, 1, 0, 1, 0, 0, 0, 0, -1],
    [0, -1, 0, 1, 0, 0, 0, 0, 1],
    [0, 0, 1, 1, 0, 0, 0, 1, 0],
    [0, 0, -1, -1, 0, 0, 0, 1, 0]
  ];

  const side = n + 1;
  const perFace = side * side;
  const positions = new Float32Array(perFace * FACES.length * 3);
  const indices = new Uint16Array(n * n * 6 * FACES.length);

  let write = 0;
  let index = 0;
  for (let f = 0; f < FACES.length; f++) {
    const [nx, ny, nz, ux, uy, uz, vx, vy, vz] = FACES[f];
    const base = f * perFace;

    for (let j = 0; j <= n; j++) {
      const v = j / n - 0.5;
      for (let i = 0; i <= n; i++) {
        const u = i / n - 0.5;
        let x = nx * 0.5 + ux * u + vx * v;
        let y = ny * 0.5 + uy * u + vy * v;
        let z = nz * 0.5 + uz * u + vz * v;

        // Round: blend toward the sphere of radius 0.5 through the same point.
        const len = Math.max(1e-5, Math.hypot(x, y, z));
        x = lerp(x, (x / len) * 0.5, roundness);
        y = lerp(y, (y / len) * 0.5, roundness);
        z = lerp(z, (z / len) * 0.5, roundness);

        // Chip: one hash per coarse cell, pushed along the outward direction.
        const cx = Math.floor(x * chipScale);
        const cy = Math.floor(y * chipScale);
        const cz = Math.floor(z * chipScale);
        const knock = (hash3(cx, cy, cz) - 0.62) * chip * 0.16;
        const out = Math.max(1e-5, Math.hypot(x, y, z));
        x += (x / out) * knock;
        y += (y / out) * knock;
        z += (z / out) * knock;

        positions[write++] = x;
        // Unit space seats the block on the floor: y = 0 at the base, 1 at the top.
        positions[write++] = y + 0.5;
        positions[write++] = z;
      }
    }

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = base + j * side + i;
        indices[index++] = k;
        indices[index++] = k + 1;
        indices[index++] = k + side + 1;
        indices[index++] = k;
        indices[index++] = k + side + 1;
        indices[index++] = k + side;
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* The matter                                                              */
/* ---------------------------------------------------------------------- */
/**
 * Dark quarried stone with **the lattice printed on it**.
 *
 * The seams are drawn in the block's own object space on exactly the cell size
 * the voxel ladder's first rung uses, so what you are looking at before
 * anything moves is a map of where the block is about to come apart. That
 * agreement is not decoration: it is the only warning the ability gives, and it
 * is why the first cube letting go reads as the block *doing what it was going
 * to do* rather than as geometry glitching. Drag `cellSize` on a standing lane
 * and the printing re-rules itself, still in step with the dissolve.
 *
 * The first version drew the seams in **world** space, on the theory that
 * neighbouring blocks should look quarried out of one grid. They did — and then
 * every cube that let go slid through the printing on its way out, because a
 * world-space pattern is nailed to the room and the chunk is not. Object space,
 * and the seam travels with the piece it belongs to.
 *
 * ## The one ordering that is load-bearing
 *
 * `patchOnBeforeCompile` composes in **registration** order, and both patches
 * here replace `#include <begin_vertex>` — so whichever registers *second*
 * lands its code between the include and the first one's. Dissolve is
 * registered first on purpose, which puts `patchGrowthMaterial`'s
 * `vGrowLocal = transformed` **before** the displacement and hands this shader
 * the block's rest position. The other way round, `vGrowLocal` is the drifting
 * chunk's position and the seams crawl across the surface as it goes.
 *
 * `flatShading` rather than smooth normals, and it earns its keep twice: a
 * chamfered cube reads as cut stone with hard facets, and three derives the
 * normal from screen-space derivatives, so a chunk that has tumbled away is lit
 * correctly with no help from anybody. `dissolveNormal()` still compiles and
 * still runs; under flat shading it simply has nothing left to fix.
 */
function createMatterMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0x191521,
    roughness: 0.85,
    metalness: 0.06,
    flatShading: true,
    transparent: false,
    depthWrite: true
  });

  // Registered FIRST. See the doc comment — this decides what `vGrowLocal` is.
  const dissolve = dissolveUniforms({
    voxel: 1,
    erode: 0,
    space: DissolveSpace.LOCAL
  });
  patchDissolveMaterial(material, {
    mode: DissolveMode.VOXEL,
    space: DissolveSpace.LOCAL,
    uniforms: dissolve,
    environment
  });

  const uniforms = {
    uColorStone: { value: new Color() },
    uColorSeam: { value: new Color() },
    uColorBirth: { value: new Color() },
    /** The lattice pitch. Shared with `uDisCell` by design, not by accident. */
    uSeamCell: { value: 0.18 },
    uSeamWidth: { value: 0.06 },
    uSeamGlow: { value: 0.85 },
    uSeamCeiling: { value: 0.8 },
    uSeamFade: { value: 0.7 },
    uSeamGrain: { value: 0.35 },
    uGrainScale: { value: 5.5 },
    uBirthFlash: { value: 1.1 },
    uStoneRoughness: { value: 0.85 },
    uStoneMetalness: { value: 0.06 }
  };

  patchGrowthMaterial(material, {
    environment,
    uniforms,
    // Declarations only. This chunk lands *above* the noise library that the
    // dissolve patch injected, so nothing in here may call `fbm3` — the
    // fragment block below can, because it runs inside main().
    common: /* glsl */ `
      uniform vec3  uColorStone;
      uniform vec3  uColorSeam;
      uniform vec3  uColorBirth;
      uniform float uSeamCell;
      uniform float uSeamWidth;
      uniform float uSeamGlow;
      uniform float uSeamCeiling;
      uniform float uSeamFade;
      uniform float uSeamGrain;
      uniform float uGrainScale;
      uniform float uBirthFlash;
      uniform float uStoneRoughness;
      uniform float uStoneMetalness;
    `,
    fragment: /* glsl */ `
      // Distance to the nearest lattice plane, on all three axes at once. The
      // obvious fract() - 0.5 gives distance to the cell CENTRE; the seam is
      // the boundary, so it is the complement.
      vec3 cellQ = vGrowLocal / max(uSeamCell, 1e-3);
      vec3 toPlane = 0.5 - abs(fract(cellQ) - 0.5);
      float nearest = min(min(toPlane.x, toPlane.y), toPlane.z);
      float seam = 1.0 - smoothstep(0.0, max(uSeamWidth, 1e-4), nearest);

      // Grain in WORLD space, so neighbouring blocks look cut out of one bed of
      // stone rather than each carrying an identical copy of the same mottling.
      float bed = fbm3(vGrowWorld * uGrainScale) * 0.5 + 0.5;
      seam *= mix(1.0, bed, uSeamGrain);

      // A cube that is already moving has stopped being part of a lattice.
      seam *= 1.0 - clamp(vDisK, 0.0, 1.0) * uSeamFade;

      vec3 lit = uColorSeam * seam * uSeamGlow;
      lit += uColorBirth * vGrowBirth * uBirthFlash * (0.3 + 0.7 * seam);

      // THE BLOOM GUARD, on the UmbralSpears pattern. Reinhard with its
      // asymptote at uSeamCeiling: the seams provably cannot reach
      // post.bloomThreshold, so a lattice of thin bright lines never smears
      // into a glowing box, and the bottom of the gain slider is untouched.
      lit = lit / (1.0 + lit / max(uSeamCeiling, 1e-3));

      diffuseColor.rgb = uColorStone * (0.75 + 0.5 * bed);
      roughnessFactor = uStoneRoughness;
      metalnessFactor = uStoneMetalness;
      totalEmissiveRadiance += lit;
    `
  });

  // I8, and the merge is not optional: `patchDissolveMaterial` has already
  // parked its own twenty-six boxes here, and assigning over the top would
  // hide every one of them from the harness's pause probe.
  material.userData.uniforms = Object.assign(material.userData.uniforms ?? {}, uniforms);
  material.userData.dissolve = dissolve;

  /** Pull the palette and the lattice from the live settings. */
  material.userData.sync = () => {
    const c = settings.unmake;
    const g = settings.global;

    uniforms.uColorStone.value.copy(getColor(c.colorStone));
    uniforms.uColorSeam.value.copy(getColor(c.colorSeam));
    uniforms.uColorBirth.value.copy(getColor(c.colorBirth));

    // The one shared number in the material, and the sharing is the design:
    // the printed seam and the first rung of the ladder are the same lattice.
    uniforms.uSeamCell.value = Math.max(0.01, c.cellSize);
    uniforms.uSeamWidth.value = c.seamWidth;
    uniforms.uSeamGlow.value = c.seamGlow * g.glow;
    uniforms.uSeamCeiling.value = c.seamCeiling;
    uniforms.uSeamFade.value = c.seamFade;
    uniforms.uSeamGrain.value = c.grain * g.shaderIntensity;
    uniforms.uGrainScale.value = c.grainScale * g.noiseFrequency;
    uniforms.uBirthFlash.value = c.birthFlash;
    uniforms.uStoneRoughness.value = c.stoneRoughness;
    uniforms.uStoneMetalness.value = c.stoneMetalness;
  };

  material.userData.sync();
  return material;
}

/* ---------------------------------------------------------------------- */
/* The ability                                                             */
/* ---------------------------------------------------------------------- */

/**
 * UNMAKE — a lane of matter that stops existing.
 *
 * Two beats. A heave front runs the aimed line at `speed` and near-cubic blocks
 * of the room's own substance punch out of the floor behind it, leaving a
 * gouged trench; the lane stands whole for `standTime`; and then it is
 * **unmade**, over `unmakeTime`, into cubes that tumble, drift and wink out.
 *
 * **THE TRICK — the cubes get bigger as it goes.** This is `DissolveMode.VOXEL`
 * from `vfx/Dissolve.js` and the entire acceleration is a **power-of-two ladder
 * walked once per vertex in the vertex shader**. Rung 0 claims `take` of the
 * cells at `cellSize`; whatever it did not claim is offered to rung 1 at twice
 * the size, and rung 2 at twice that, up to `rungs`. Every vertex is claimed
 * exactly once, by the finest rung that wants it, from nothing but its rest
 * position and a hash — so the partition never changes, never re-shuffles, and
 * needs no state on either side of the bus. There is **no CPU rebuild**: the
 * geometry the blocks were drawn with at the start is the geometry they are
 * drawn with at the end.
 *
 * The reason that reads as *acceleration* rather than as scale is stated in the
 * module it came from and is worth repeating: losing eight small cubes and
 * losing one cube eight times the size are the same volume, but the eye counts
 * events, not litres. Drop `rungs` to 1 with the clock stopped mid-dissolve and
 * the lane goes back to a uniform crumble; that comparison is the ability.
 *
 * **What the CPU does about it.** Two things, and both are agreements rather
 * than duplications. The material prints the lattice on the stone at the same
 * `cellSize`, so you can see the grid before it is used. And the chips thrown
 * off are sized by the ladder's *current rung* — `chipSize × 2^(rung ×
 * chipRungGain)` — so the particles get coarser at exactly the moments the
 * geometry does. The first version emitted one chip size throughout and the
 * dissolve visibly disagreed with its own debris; the debris won, and the
 * acceleration disappeared.
 *
 * **Why one progress for the whole lane and not a travelling front.** Tempting,
 * and wrong. `Dissolve.js` argues it directly: a dissolve driven per material
 * with per-material progress does not look like one thing being unmade, it
 * looks like several things being unmade near each other. All three of
 * `GrowthField`'s variant meshes share **one material and one uniform box by
 * identity**, so a single `syncDissolve()` drives every block in the cast and
 * the lane goes as one event. The direction the cast has is carried by the
 * heave, which does travel, and by `driftUp` leaning the chunks off the floor.
 *
 * **The rule that makes the editor work.** A `GrowthField` record is dice rolls
 * and one timestamp; this ability adds exactly one number of its own, `_seed`,
 * plus the timestamps the phase machine already keeps. Every metre, radian and
 * second lands in `_growth`, `_trench` and `_dissolve` from `settings.unmake`
 * inside the update loop, on a zero-length frame included. Pause mid-dissolve
 * and drag `drift`, `tumble` or `hold` and the standing cloud of cubes
 * re-arranges itself around the same partition.
 */
export class UnmakeAbility extends Ability {
  constructor(context) {
    super('unmake', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.material = createMatterMaterial(this.ctx.environment);
    /** The shared box every block dissolves out of. One event, one write. */
    this.dissolveBox = this.material.userData.dissolve;

    this._fillShape();
    this.field = new GrowthField(this.group, {
      geometry: createBlockGeometry,
      material: this.material,
      shape: _shape,
      variants: 3,
      capacity: MAX_BLOCKS,
      layer: LAYER.WORLD,
      renderOrder: 2,
      // The blocks are real matter for as long as they exist, so they take the
      // stage's key light and throw a real shadow — and the shadow dissolves
      // with them, because `patchDissolveMaterial` was handed the environment
      // and registered the same displacement on the depth material.
      castShadow: true,
      receiveShadow: true
    });
    // Assigned once, here, and never rebuilt: a closure created inside the
    // update loop is an allocation per instance per frame (I3).
    this.field.onBreach = (index, position, radius, height) =>
      this._onBreach(index, position, radius, height);

    /**
     * The trench the matter came out of.
     *
     * RUT rather than a disc mode, for the reason `UmbralSpears` gives: RUT is
     * the one mode with a *length*, a half-width and a `progress` that follows
     * the front, which is the shape a line cast actually has. It outlives the
     * blocks on purpose — the matter is gone, the hole it came out of is not,
     * and a floor that forgets is a floor nothing happened to.
     */
    this.trench = new GroundField(this.group, {
      mode: GroundMode.RUT,
      marks: 16,
      additive: false,
      depthTest: true,
      name: 'UnmakeTrench'
    });

    /** A dice roll, so two casts do not partition their blocks identically. */
    this._seed = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The cubes too small to be geometry. Lit and non-additive: they are still
    // stone right up until they are not, and an additive chip is an ember.
    this.chips = particles.get('unmake.chips', {
      capacity: 2200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.chips.uniforms.uDrag.value = 0.3;
    this.chips.uniforms.uEndSize.value = 0.7;
    this.chips.uniforms.uFadeOut.value = 0.62;

    // What is left in the space the matter used to occupy. Non-additive, so it
    // genuinely occludes rather than brightening the hole.
    this.gloom = particles.get('unmake.gloom', {
      capacity: 1800,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.15
    });
    this.gloom.uniforms.uDrag.value = 2.1;
    this.gloom.uniforms.uEndSize.value = 2.6;
    this.gloom.uniforms.uSizeIn.value = 0.14;
    this.gloom.uniforms.uFadeIn.value = 0.2;
    this.gloom.uniforms.uFadeOut.value = 0.36;

    // The flare a cube throws as it stops existing — the particle half of the
    // ember the dissolve patch already adds to the geometry.
    this.motes = particles.get('unmake.motes', {
      capacity: 1600,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.7;
    this.motes.uniforms.uEndSize.value = 0.12;
    this.motes.uniforms.uSizeIn.value = 0.05;
    this.motes.uniforms.uFadeIn.value = 0.07;
    this.motes.uniforms.uFadeOut.value = 0.45;

    this.chipEmitter = new RateEmitter();
    this.gloomEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.field.count;
  }

  /** The lane stands whole. */
  get impactDuration() {
    return Math.max(0.1, settings.unmake.standTime * settings.global.lifetime);
  }

  /** Then it is unmade, and then the last of it clears. */
  get fadeDuration() {
    const c = settings.unmake;
    return Math.max(0.1, c.unmakeTime + c.settleTime);
  }

  /** Matter does not gutter. The light steadies and then loses its subject. */
  lightShimmer() {
    return 1;
  }

  /* ------------------------------------------------------------------ */
  /* The beats — unitless, resolved against live durations                */
  /* ------------------------------------------------------------------ */

  /**
   * The one number the whole dissolve runs on: 0 intact, 1 gone.
   *
   * A pure function of the phase clock against the *live* `unmakeTime`, so
   * dragging that slider on a paused lane re-times a dissolve that is already
   * half done rather than restarting it.
   */
  _progress() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    return saturate(this.fadeTime / Math.max(0.05, settings.unmake.unmakeTime));
  }

  /**
   * Which rung of the ladder is letting go right now, 0..rungs-1.
   *
   * The shader walks the ladder per vertex and never tells anybody; this is the
   * CPU's copy of the same arithmetic, and it exists so the chips can be the
   * size of the cubes they came off. Mirror, so if one changes the other must —
   * the claim time in `dissolveResolve()` is `(rung + hash) / rungs`.
   */
  _rung() {
    const c = settings.unmake;
    const rungs = Math.max(1, Math.min(MAX_RUNGS, Math.round(c.rungs)));
    return Math.min(rungs - 1, Math.floor(this._progress() * rungs));
  }

  /** Metres, the size of a chip coming off right now. Grows with the ladder. */
  _chipSize() {
    const c = settings.unmake;
    return c.chipSize * Math.pow(2, this._rung() * saturate(c.chipRungGain));
  }

  /* ------------------------------------------------------------------ */
  /* Live parameters                                                     */
  /* ------------------------------------------------------------------ */

  /** The geometry factory's shape controls. Handed to `syncGeometry`. */
  _fillShape() {
    const c = settings.unmake;
    _shape.segments = c.blockSegments;
    _shape.round = c.blockRound;
    _shape.chip = c.blockChip;
    _shape.chipScale = c.blockChipScale;
    return _shape;
  }

  /**
   * Everything `GrowthField` needs, re-resolved. Note that `heightNear` and
   * `radiusNear` are fed from **one** slider, and so are `height` and
   * `radius2`: the lattice is object space, so a block that is not a cube comes
   * apart into things that are not cubes.
   */
  _fillGrowth() {
    const c = settings.unmake;
    const g = settings.global;
    const p = _growth;

    p.layout = GrowthLayout.LINE;
    p.emerge = GrowthEmerge.PUSH;
    p.origin = this.origin;
    p.direction = this.direction;
    p.side = this.side;
    p.length = this.length;

    p.widthNear = c.widthNear;
    p.width = c.width;
    p.widthCurve = c.widthCurve;
    p.frontBias = c.frontBias;
    p.clumping = c.clumping;
    p.scatter = c.scatter;
    p.clusterRadius = c.clusterRadius;

    p.heightNear = c.blockNear;
    p.height = c.blockFar;
    p.heightCurve = c.blockCurve;
    p.heightJitter = c.blockJitter;
    p.crown = c.crown;
    p.crownPower = c.crownPower;
    p.peak = c.peak;
    p.peakWidth = c.peakWidth;
    p.rubble = c.rubble;
    p.rubbleScale = c.rubbleScale;
    p.rubbleSpread = c.rubbleSpread;
    p.minHeight = c.minBlock;

    p.radiusNear = c.blockNear;
    p.radius2 = c.blockFar;
    p.radiusCurve = c.blockCurve;
    p.radiusJitter = c.blockJitter;
    p.minRadius = c.minBlock;

    p.lean = c.lean;
    p.leanJitter = c.leanJitter;
    p.leanRamp = c.leanRamp;
    p.leanForward = c.leanForward;
    p.leanOutward = c.leanOutward;
    p.twist = c.twist;
    p.tilt = c.tilt;

    p.baseHeight = 0;
    p.baseJitter = 0;

    p.riseTime = c.riseTime;
    p.riseOvershoot = c.riseOvershoot;
    p.settle = c.settle;
    p.springRate = c.springRate;
    p.emergeSink = c.emergeSink;
    p.birthScale = c.birthScale;
    p.birthFade = c.birthFade;
    p.breachAt = c.breachAt;
    // Nothing withdraws: the blocks are not taken back into the floor, they
    // stop existing. `retract` is passed as 0 for the whole cast.
    p.sinkDepth = 0;

    p.randomness = g.randomness;
    return p;
  }

  /**
   * The `VOXEL` half of the dissolve patch, re-resolved.
   *
   * `drift`, `lift`, `gravity` and `wobble` are applied in the block's own
   * object space and then carried through the instance scale, so they are
   * *block units* rather than metres: at the shipped `blockFar` of about a
   * metre the two coincide, and on a lane of half-metre blocks everything
   * halves with them. That is the right behaviour — a small cube should not
   * travel as far as a big one — and it is why they are not named in metres.
   */
  _fillDissolve() {
    const c = settings.unmake;
    const g = settings.global;
    const p = _dissolve;

    p.progress = this._progress();
    p.seed = this._seed;
    p.space = DissolveSpace.LOCAL;

    p.voxel = 1;
    p.cell = c.cellSize;
    p.rungs = c.rungs;
    p.take = c.take;
    p.span = c.span;
    p.block = c.blockiness;
    p.facet = c.facet;
    p.hold = c.hold;
    p.drift = c.drift;
    p.driftBiasX = 0;
    p.driftBiasY = c.driftUp;
    p.driftBiasZ = 0;
    p.lift = c.lift;
    p.gravity = c.gravity;
    p.tumble = c.tumble;
    p.wobble = c.wobble;
    p.wobbleRate = c.wobbleRate;

    p.erode = c.erode;
    p.noiseScale = c.noiseScale;
    p.warp = c.warp;
    p.edge = c.edgeWidth;
    p.biasX = 0;
    p.biasY = 0;
    p.biasZ = 0;
    p.biasAmount = 0;

    p.colorEdge = c.colorEdge;
    p.colorEmber = c.colorEmber;
    p.glow = c.unmakeGlow * g.glow;
    return p;
  }

  /**
   * The trench. `progress` chases the heave front; `fade` follows the lane down
   * only at the very end, because the gouge is the one thing that stays.
   */
  _fillTrench(front, fade) {
    const c = settings.unmake;
    const g = settings.global;
    const p = _trench;

    p.centre = this.origin;
    p.yaw = Math.atan2(this.direction.x, this.direction.z);
    p.height = c.trenchHeight;
    p.length = this.length;
    // RUT does not cover with its radius, but it does pad the quad with it, so
    // it has to be the track's half-width and not the cast's length.
    p.radius = c.trenchWidth * 2.2;
    p.width = c.trenchWidth;
    p.progress = front;
    p.grow = 1;
    p.recede = 0;
    p.fade = fade;
    p.seed = this._seed;

    p.edge = c.trenchEdge;
    p.ragged = c.trenchRagged;
    p.raggedScale = c.trenchRaggedScale;
    p.warp = c.trenchWarp;

    p.relief = c.trenchRelief;
    p.normalStep = 0.07;
    p.ambient = c.trenchAmbient;
    p.wrap = 0.5;
    p.specular = 0.2;
    p.gloss = 20;
    p.parallax = 0.25;

    p.depth = c.trenchDepth;
    p.lift = c.trenchLift;
    p.thickness = c.trenchThickness;
    p.seam = 1.2;
    p.cell = 1;
    p.sharp = c.trenchSharp;
    p.detail = c.trenchDetail;
    p.swirl = 0.2;
    p.speed = 1;
    p.flow = 0;
    p.windAngle = 0;

    p.markLife = c.trenchMarkLife;
    p.markRadius = c.trenchWidth;

    p.additive = false;
    p.emissive = c.trenchEmissive * g.glow;
    p.opacity = c.trenchOpacity;
    p.depthFade = 0.4;
    p.colorBase = c.colorTrench;
    p.colorDeep = c.colorTrenchDeep;
    p.colorEdge = c.colorTrenchEdge;
    p.colorGlow = c.colorTrenchGlow;

    p.noiseStrength = g.noiseStrength;
    p.noiseFrequency = g.noiseFrequency;
    p.noiseSpeed = g.noiseSpeed;
    p.opacityScale = g.opacity;
    return p;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.unmake;

    this.chipEmitter.reset();
    this.gloomEmitter.reset();
    this.moteEmitter.reset();

    // The one thing this cast captures, besides its own timestamps.
    this._seed = Math.random() * 100;

    this.trench.clearMarks();
    this.trench.setVisible(true);
    this.field.plant(Math.min(MAX_BLOCKS, Math.max(1, Math.round(c.blockCount))), c.clusterShare);

    this._sync(0, 1);
  }

  /** Chips and a deepening of the trench where a block breaks the surface. */
  _onBreach(index, position, radius, height) {
    const c = settings.unmake;
    const g = settings.global;

    const s = saturate(_pos.copy(position).sub(this.origin).dot(this.direction) / this.length);
    // Unitless: `s` is how far along the track this block is and `strength` is
    // how big it was against the lane's own far size, so the pooling re-places
    // *and* re-scales itself when `blockFar` or the cast length moves.
    this.trench.mark(0, s, this.age, saturate(0.35 + height / Math.max(0.1, c.blockFar)));

    _emit.position = _pos.copy(position).setY(0.05);
    _emit.radius = radius * 1.3;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.25).setY(1).normalize();
    _emit.speed = c.chipSpeed;
    _emit.speedVariance = 0.75;
    _emit.spread = 0.8;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.chipSize;
    _emit.sizeVariance = 0.7;
    _emit.life = c.chipLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 8;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.chips.emit(Math.round(c.breachChips * g.particleCount), _emit);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Re-resolve everything.
   * @param {number} front 0..1, how far the heave front has travelled
   * @param {number} fade  0..1 on the trench
   */
  _sync(front, fade) {
    this.material.userData.sync();
    syncDissolve(this.dissolveBox, this._fillDissolve());

    this.field.syncGeometry(this._fillShape());
    this.field.update(this.age, this._fillGrowth(), 0);
    this.trench.update(this._fillTrench(front, fade));

    this._syncParticles();
  }

  _syncParticles() {
    const c = settings.unmake;
    const g = settings.global;

    this.chips.setGradient(
      getColor(c.colorChipA),
      getColor(c.colorChipB),
      getColor(c.colorChipC),
      getColor(c.colorChipD)
    );
    this.chips.uniforms.uGravity.value.set(0, c.chipGravity, 0);
    // The `× 7` is the CHIP shape's own convention, shared with every other
    // chip system in the project; the ladder's growth rides on top of it.
    this.chips.uniforms.uSizeScale.value = g.particleSize * 7;
    this.chips.uniforms.uLifeScale.value = g.particleLifetime;
    this.chips.uniforms.uSpeedScale.value = g.particleSpeed;
    this.chips.uniforms.uOpacity.value = g.opacity;

    this.gloom.setGradient(
      getColor(c.colorGloomA),
      getColor(c.colorGloomB),
      getColor(c.colorGloomC),
      getColor(c.colorGloomD)
    );
    this.gloom.uniforms.uGravity.value.set(0, c.gloomRise, 0);
    this.gloom.uniforms.uSizeScale.value = c.gloomSize * g.particleSize;
    this.gloom.uniforms.uLifeScale.value = c.gloomLifetime * 0.5 * g.particleLifetime;
    this.gloom.uniforms.uSpeedScale.value = c.gloomSpeed * g.particleSpeed;
    this.gloom.uniforms.uOpacity.value = c.gloomOpacity * g.opacity;
    this.gloom.uniforms.uTurbulence.value = 0.4 * g.turbulence;

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
    this.motes.uniforms.uGlow.value = c.unmakeGlow * 0.7 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;
  }

  /** Haze rolling off whatever part of the lane exists. */
  _gloomFx(dt, reach, scale) {
    const c = settings.unmake;
    const g = settings.global;
    const count = Math.round(this.gloomEmitter.tick(dt, c.gloomRate * scale) * g.particleCount);
    if (count <= 0) return;

    const s = Math.random() * Math.max(0.02, reach);
    this.pointAt(s, _pos).setY(lerp(c.blockNear, c.blockFar, s) * 0.5);

    _emit.position = _pos;
    _emit.radius = lerp(c.widthNear, c.width, s);
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.gloomSpeed;
    _emit.speedVariance = 0.7;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.85;
    _emit.sizeVariance = 0.5;
    _emit.life = c.gloomLifetime;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.35;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.gloom.emit(count, _emit);
  }

  /**
   * The debris of the unmaking: chips at the ladder's current cube size, and
   * the flare that goes with them.
   *
   * Both are gated on the dissolve actually running, and the chip *size* is
   * where the trick reaches the particle engine — see `_chipSize()`.
   *
   * @param {number} scale 0..1 on the rate
   */
  _unmakeFx(dt, scale) {
    const c = settings.unmake;
    const g = settings.global;
    const time = frame.uTime.value;

    const chipCount = Math.round(this.chipEmitter.tick(dt, c.chipRate * scale) * g.particleCount);
    if (chipCount > 0) {
      const s = Math.random();
      this.pointAt(s, _pos);
      const size = lerp(c.blockNear, c.blockFar, s);
      _pos.y = size * 0.55;

      _emit.position = _pos;
      _emit.radius = lerp(c.widthNear, c.width, s);
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.chipSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = this._chipSize();
      _emit.sizeVariance = 0.5;
      _emit.life = c.chipLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 9;
      _emit.tint = null;
      _emit.time = time;
      this.chips.emit(chipCount, _emit);
    }

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      const s = Math.random();
      this.pointAt(s, _pos);
      _pos.y = lerp(c.blockNear, c.blockFar, s) * 0.6;

      _emit.position = _pos;
      _emit.radius = lerp(c.widthNear, c.width, s) * 1.1;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.moteSize;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.unmake;
    this.field.triggerUpTo(this.age, this.u, c.riseStagger, c.frontBias, false);
    this._sync(this.u, 1);

    // The light rides the heave front, lifted onto the top of the blocks it is
    // pushing up rather than left on the floor under them.
    this.pointAt(this.u, this.position);
    this.position.y = lerp(c.blockNear, c.blockFar, this.u) * 0.7;

    this._gloomFx(dt, this.u, 0.7);
    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.unmake;
    const g = settings.global;

    // Everything still buried comes up now, the far pile included.
    this.field.triggerUpTo(this.age, 1, c.riseStagger, c.frontBias, true);

    this.pointAt(1, _pos).setY(c.blockFar * 0.4);
    _emit.position = _pos;
    _emit.radius = c.width * 0.9;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.3).setY(1).normalize();
    _emit.speed = c.chipSpeed * 1.8;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.chipSize * 1.4;
    _emit.sizeVariance = 0.75;
    _emit.life = c.chipLifetime * 1.3;
    _emit.lifeVariance = 0.5;
    _emit.spin = 11;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.chips.emit(Math.round(c.impactChips * g.particleCount), _emit);

    this.ctx.shake.add(
      c.heaveShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      19
    );
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  onFade(dt, _t) {
    const c = settings.unmake;
    const progress = this._progress();
    // The gouge only starts to go once the last cube has, and even then it
    // takes the whole settle to do it.
    const fade = 1 - saturate((this.fadeTime - c.unmakeTime) / Math.max(0.05, c.settleTime)) * 0.85;

    this._sync(1, fade);

    // The light sits over the middle of the lane, where the loss is, and drops
    // toward the floor as there is less and less left to light.
    this.pointAt(0.6, this.position);
    this.position.y = c.blockFar * (0.7 - 0.5 * progress);

    // Emission ramps with the dissolve: the ladder is taking more volume per
    // second as it climbs, and the debris has to say so.
    const running = this.phase === AbilityPhase.FADE && progress < 1 ? 0.4 + 0.6 * progress : 0;
    this._unmakeFx(dt, running);
    this._gloomFx(dt, 1, 0.35 + 0.65 * running);

    this.ctx.shake.rumble(
      (running > 0 ? c.unmakeRumble : c.rumble) * settings.global.cameraShake,
      dt
    );
  }

  onDestroy() {
    this.field.clear();
    this.trench.clearMarks();
    this.trench.setVisible(false);
    // Leave the box intact and the lane whole, or the next cast out of this
    // pooled instance draws one frame of a finished dissolve before its own
    // `onSpawn` runs.
    this.dissolveBox.uDisProgress.value = 0;
  }

  dispose() {
    this.field.dispose();
    this.trench.dispose();
    this.material.dispose();
    super.dispose();
  }
}
