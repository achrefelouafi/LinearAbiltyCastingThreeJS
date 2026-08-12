import {
  BufferAttribute,
  BufferGeometry,
  Color,
  MeshStandardMaterial,
  ShapeUtils,
  Vector2,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { patchOnBeforeCompile, replaceChunk } from '../utils/shaderPatch.js';
import { frame } from '../core/FrameUniforms.js';
import { getColor } from '../utils/color.js';
import { clamp, saturate, smoothstep, hash11 } from '../utils/math.js';

/* ---------------------------------------------------------------------- */
/* HardSurface — the machined half of the material vocabulary              */
/* ---------------------------------------------------------------------- */

/**
 * Gears, pistons, sawblades, plates, bolts and anvils, in brushed steel that
 * can be brought up to forging heat and back down again.
 *
 * Everything in this sandbox before Forge was **grown, quarried or bled**:
 * crystal, rock, bone, vine, ash, blood. All of it is soft-edged, all of it is
 * noise-driven, and all of it looks *made by nature*. A machined object reads
 * differently for three reasons, none of which is the silhouette:
 *
 *  1. **Its edges are deliberate.** A chamfer is a decision. Nature does not
 *     put a 0.4 mm bevel round the top of a hole, and a shader cannot fake one
 *     — the geometry has to have it, which is why this module generates
 *     geometry at all rather than shipping a material and letting abilities
 *     bring their own boxes.
 *  2. **Its highlight is directional.** Brushed and turned metal has a grain,
 *     and the specular smears *across* that grain into a line. An isotropic
 *     GGX lobe on a cylinder gives you a plastic bottle; an anisotropic lobe
 *     whose tangent runs round the axis gives you a lathe-turned collar, from
 *     the same silhouette and the same albedo.
 *  3. **Its colour is a temperature, not a palette.** Steel above about 900 K
 *     stops taking its colour from the light in the room and starts making its
 *     own, along one fixed curve that every foundry photograph in the world
 *     agrees on. Authoring that curve as a four-stop gradient is the tell; the
 *     stops always land slightly wrong and the metal looks lit rather than hot.
 *
 * So this module is three things bolted together, and it is deliberately *not*
 * a renderer: it owns no meshes, adds nothing to a parent and has no `update`.
 *
 * | part | what it gives you |
 * | --- | --- |
 * | six geometry generators | unit-space `BufferGeometry`, for `GrowthField` / `Projectile` / a plain `Mesh` |
 * | `createHardSurfaceMaterial()` | a patched `MeshStandardMaterial`: anisotropic brushing, blackbody heat, scale, pitting, edge wear |
 * | `GearTrain` + `GrindContact` | the two solvers whose output the abilities cannot compute for themselves |
 *
 * ## Attach convention
 *
 * **Neither.** `HardSurface` is a toolkit, like `prefixedBlock.js`, not a
 * system. You get geometry and a material and you put them wherever you like —
 * usually into `GrowthField` (which wants a factory and a material and owns
 * the instancing) or `Projectile` (same). Its draw-call cost is zero of its
 * own; whatever you hang it on pays.
 *
 * ## Settings convention
 *
 * **Canonical.** `hardSurfaceParams()` is the key list for the material;
 * `gearTrainParams()` and `grindParams()` for the two solvers. Every one of
 * them is re-read on every call, so a paused gear train re-meshes under the
 * `module` slider and a paused ingot cools under the `heat` slider. The
 * *shapes* are the exception and they are the interesting exception — see
 * "Shapes are unitless" below.
 *
 * ## Shapes are unitless, and that is what keeps I1 honest
 *
 * A shape object (`gearShape()`, `anvilShape()`, …) holds **no metres**. Every
 * generator emits geometry normalised into the unit box: the largest extent —
 * horizontal diameter or height, whichever binds — is exactly 1, the body sits
 * on `y = 0`, and the axis is centred. The footprint therefore always fits
 * inside the circle of radius 0.5 that `GrowthField`'s factory contract asks
 * for, and the instance transform is the only place a metre ever appears.
 *
 * The consequence worth internalising: a shape field is a **proportion**, not
 * a size. `gearShape().thickness = 0.24` means "0.24 of the gear's own
 * diameter", so a gear scaled to 1.4 m across is 0.34 m thick and the slider
 * still bites while paused. The one place this bites back is a field that
 * controls the *dominant* dimension — push a piston's `length` past its
 * diameter and `length` stops changing the silhouette and starts changing what
 * the other proportions mean, because the normalisation immediately divides it
 * back out. That is stated here rather than defended: the alternative,
 * normalising each axis separately, makes every proportion slider inert and
 * turns a gear into a drum the moment you touch its thickness.
 *
 * The other consequence is the good one. A gear's *module* — millimetres of
 * pitch diameter per tooth, the number that decides whether two gears mesh —
 * is a metre, so it is **not in `gearShape()` at all**. It lives in
 * `GearTrain`'s params and is resolved every frame. Drag it and the whole
 * train re-spaces and re-phases without a single vertex being rebuilt.
 *
 * ## What it is for
 *
 * The Forge school, all six of it:
 *
 * | ability | what it takes from here |
 * | --- | --- |
 * | `anvilfall` | `createAnvilGeometry` — the fillets are why it reads as forged rather than as a box |
 * | `sawline`   | `createSawbladeGeometry` + `GrindContact` — sparks leave at the contact tangent |
 * | `pistondrive` | `createPistonGeometry` — the cam curve is the ability's; the collar and head are here |
 * | `gearlock`  | `createGearGeometry` + `GearTrain` — involute flanks that genuinely interlock |
 * | `quench`    | the blackbody ramp — white → yellow → orange → cherry → black on the Planckian locus |
 * | `shrapnel`  | `createPlateGeometry` / `createBoltGeometry` as `ShatterField` fragment stock |
 *
 * @example
 *   // gearlock: three tooth counts, three InstancedMeshes, one material.
 *   this.metal = createHardSurfaceMaterial({ environment: ctx.environment });
 *   this.cache = new ShapeCache();
 *   this.train = new GearTrain({ capacity: 12 });
 *   // spawn
 *   this.train.plant(c.gearCount, this._seed);
 *   // every frame
 *   this._fillTrain();                       // metres, from settings.gearlock
 *   this.train.solve(this._trainParams);
 *   for (let i = 0; i < this.train.count; i++) {
 *     const d = this.train.tipRadiusOf(i) * 2;
 *     this.train.positionOf(i, this._trainParams, _pos);
 *     _dummy.position.copy(_pos);
 *     _dummy.rotation.set(0, this.train.yawOf(i), 0);
 *     _dummy.scale.setScalar(d);
 *     ...
 *   }
 *   syncHardSurfaceMaterial(this.metal, this._look);
 */

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/* Module-scope scratch — invariant I3. Nothing in a frame path allocates.
   The geometry generators are exempt and say so: they run on a slider change,
   not on a frame, and building a gear out of pooled Vector2s would be an
   unreadable false economy. */
const _v3a = new Vector3();
const _v3b = new Vector3();
const _v3c = new Vector3();
const _v3d = new Vector3();
const _colorScratch = new Color();

/* ====================================================================== */
/* §1 · Shapes                                                            */
/* ====================================================================== */

/**
 * Which way the part's own axis points once it has been seated.
 *
 * The generators all build in a canonical frame — profile in XY, axis along
 * +Z — and this rotates the finished mesh. It is a mode, not a dimension, so
 * it is safe to capture and safe to bake into a geometry hash.
 */
export const HardAxis = Object.freeze({
  /** Axis up. A gear lies flat, a piston stands on end, a bolt points at the sky. */
  Y: 0,
  /** Axis lateral. A sawblade stands on its rim in the plane of the cast line. */
  X: 1,
  /** Axis along the cast. A piston drives forward, a gear faces the caster. */
  Z: 2
});

/** The six parts. Used by `hardSurfaceGeometry()` and `ShapeCache`. */
export const HardShape = Object.freeze({
  GEAR: 0,
  PISTON: 1,
  SAWBLADE: 2,
  PLATE: 3,
  BOLT: 4,
  ANVIL: 5
});

export const HARD_SHAPE_NAMES = Object.freeze(['GEAR', 'PISTON', 'SAWBLADE', 'PLATE', 'BOLT', 'ANVIL']);

/**
 * A spur gear with a true involute tooth profile.
 *
 * Note what is *not* here: `module`. See the file header — the module is
 * millimetres of pitch diameter per tooth, which is a metre, which means it
 * belongs to `GearTrain` and is resolved every frame. In unit space the only
 * things that decide what a gear looks like are the tooth count and the
 * coefficients, because normalisation divides the module straight back out.
 *
 * Radial fields are fractions of the **outer radius** — the radius the
 * profile actually reaches, which is 0.5 after seating and which is not the
 * nominal `pitch + addendum` once a tooth has gone pointed. Axial fields are
 * in unit-space lengths, i.e. fractions of the outer *diameter*.
 */
export function gearShape(overrides) {
  return {
    teeth: 14, // tooth count — an integer; 4 is the floor, below that the flanks cross
    pressureAngle: 20, // degrees; 20 is the modern standard, 14.5 the old one
    addendum: 1.0, // × module, tooth height above the pitch circle
    dedendum: 1.25, // × module, tooth depth below it — the extra 0.25 is the root clearance
    backlash: 0.04, // 0..1 of the tooth thickness, taken off both flanks
    rootFillet: 0.45, // 0..1 of the available root gap, blended into the flank
    flankSteps: 6, // involute samples per flank; 3 is visibly polygonal, 10 is free
    tipSteps: 2, // arc samples across the tooth tip
    rootSteps: 2, // arc samples along the root circle between teeth
    thickness: 0.22, // unit lengths, face to face
    chamfer: 0.018, // unit lengths, 45° break on both faces — this is the highlight catcher
    bore: 0.3, // fraction of the outer radius; 0 for a solid blank
    boreSegments: 28, // facets round the bore
    boreChamfer: 0.014, // unit lengths, countersink on the bore
    lightenHoles: 0, // count of lightening holes; 0, or 4..8 for a spoked look
    lightenRadius: 0.14, // fraction of the outer radius
    lightenRing: 0.58, // fraction of the outer radius, the circle they sit on
    lightenSegments: 16,
    creaseAngle: 30, // degrees; above this a joint shades hard and counts as an edge
    axis: HardAxis.Y,
    ...overrides
  };
}

/** A driven piston: base flange, rod, collar, ringed head. */
export function pistonShape(overrides) {
  return {
    length: 2.4, // × head diameter, base to crown — the dominant dimension
    segments: 24, // facets round the axis
    baseRadius: 0.46, // fractions of the head diameter throughout
    baseHeight: 0.16,
    baseChamfer: 0.05,
    rodRadius: 0.17,
    collarAt: 0.46, // 0..1 up the length
    collarRadius: 0.3,
    collarHeight: 0.13,
    collarChamfer: 0.045,
    headAt: 0.7, // 0..1 up the length, where the head begins
    headRadius: 0.5,
    headChamfer: 0.07,
    rings: 2, // machined grooves round the head — the detail that says "engine"
    ringDepth: 0.035,
    ringHeight: 0.05,
    faceRecess: 0.05, // dished crown; 0 for a flat punch
    creaseAngle: 26,
    axis: HardAxis.Y,
    ...overrides
  };
}

/**
 * A circular saw blade: raked teeth, gullets, expansion slots, arbor bore.
 *
 * `rake` and `clearance` are angles off the radial, and the faces they cut are
 * logarithmic spirals rather than straight lines, because a constant rake
 * angle *is* a logarithmic spiral — see `sawOutline`.
 */
export function sawbladeShape(overrides) {
  return {
    teeth: 22, // tooth count
    rake: 14, // degrees of hook on the cutting face; negative for a scraping tooth
    clearance: 26, // degrees of relief behind the tip
    gullet: 0.16, // fraction of the tip radius, depth to the gullet floor
    gulletSteps: 4, // arc samples round the gullet floor
    flankSteps: 3, // samples along each spiral face; 1 makes them straight chords
    tipLand: 0.35, // 0..1 of the tooth pitch spent flat on the tip
    thickness: 0.05, // unit lengths — a blade is a plate, keep it thin
    chamfer: 0.012, // unit lengths, the bevel that catches the light on the rim
    arbor: 0.16, // fraction of the tip radius
    arborSegments: 20,
    slots: 4, // expansion slots; 0 for a plain plate
    slotDepth: 0.3, // fraction of the tip radius, inward from the gullet floor
    slotWidth: 0.035, // fraction of the tip radius
    slotSteps: 3,
    creaseAngle: 30,
    axis: HardAxis.X,
    ...overrides
  };
}

/** A bevelled plate with countersunk bolt holes. */
export function plateShape(overrides) {
  return {
    width: 1.0, // the two in-plane extents, relative to each other
    depth: 0.7,
    thickness: 0.12, // unit lengths
    corner: 0.1, // fraction of the short side, corner radius
    cornerSteps: 4,
    bevel: 0.03, // unit lengths, 45° break round the whole outline
    bolts: 4, // 0, 2, 4 or 6 — laid out on the corners
    boltRadius: 0.055, // fraction of the short side
    boltInset: 0.16, // fraction of the short side, in from each corner
    boltSegments: 14,
    counterSink: 0.03, // fraction of the short side, radial flare at the face
    counterDepth: 0.035, // unit lengths, how deep the flare cuts
    creaseAngle: 34,
    axis: HardAxis.Y,
    ...overrides
  };
}

/** A hex-head bolt with a real helical thread. */
export function boltShape(overrides) {
  return {
    length: 2.2, // × head width across flats — the dominant dimension
    headHeight: 0.62, // fractions of the head width throughout
    headChamfer: 0.09,
    washer: 0.06, // flange under the head; 0 for none
    washerRadius: 0.62,
    shankRadius: 0.29,
    shankSegments: 18,
    threadTurns: 9, // full turns over the threaded length
    threadDepth: 0.035, // radial, fraction of the head width
    threadFrom: 0.28, // 0..1 up the shank where the thread starts
    threadSteps: 6, // z samples per turn; below 4 the helix aliases into rings
    tipTaper: 0.1, // 0..1 of the shank spent tapering to the point
    creaseAngle: 28,
    axis: HardAxis.Y,
    ...overrides
  };
}

/**
 * A blacksmith's anvil: horn, face, waist, base.
 *
 * The fillets are the whole job. An anvil built from boxes reads as a prop
 * even with a perfect material on it, because every real one was upset and
 * drawn out under a hammer and there is no sharp interior corner anywhere on
 * it. See `smoothProfile` for how they are made, and why they are not arcs.
 */
export function anvilShape(overrides) {
  return {
    height: 0.66, // × overall length — the anvil is longer than it is tall
    faceWidth: 0.5, // fractions of the overall length throughout
    faceDepth: 0.42,
    faceHeight: 0.14, // the working slab, top down to the underside flare
    waistWidth: 0.24,
    waistDepth: 0.22,
    waistHeight: 0.28,
    baseWidth: 0.52,
    baseDepth: 0.44,
    baseHeight: 0.12,
    corner: 0.11, // 0..1 of the half-width, the rounding on every cross-section
    cornerSteps: 3,
    fillet: 0.62, // 0..1 smoothing weight on the silhouette — the forged look
    filletPasses: 4, // how many times the smoothing runs
    sections: 26, // silhouette samples up the body
    horn: 0.46, // × overall length, how far the horn reaches past the face
    hornRadius: 0.3, // fraction of the face depth at its root
    hornDroop: 0.06, // × overall length, how far the tip falls
    hornSections: 10,
    hornSteps: 12, // facets round the horn
    creaseAngle: 34,
    axis: HardAxis.Y,
    ...overrides
  };
}

const SHAPE_FACTORIES = [gearShape, pistonShape, sawbladeShape, plateShape, boltShape, anvilShape];

/** `hardShape(HardShape.GEAR, { teeth: 9 })` — the dispatcher form. */
export function hardShape(kind, overrides) {
  const factory = SHAPE_FACTORIES[kind];
  if (!factory) throw new Error(`HardSurface: unknown shape kind ${kind}`);
  return factory(overrides);
}

/* ====================================================================== */
/* §2 · The surface builder                                               */
/* ====================================================================== */

/**
 * A welded triangle soup with no normals.
 *
 * Every generator emits positions and topology only, sharing a vertex wherever
 * two bands meet, and `finishSurface()` decides afterwards which of those
 * shared vertices are creases and splits them. That ordering is the reason
 * this file is a third of the length it was on the first attempt: the first
 * version had every generator emit its own normals and duplicate its own
 * hard edges, which meant a chamfer band was fourteen lines of bookkeeping in
 * six different places and the sawblade's gullet was smooth in exactly one of
 * them.
 *
 * The split pass also hands back something no generator could easily compute:
 * `aEdge`, one per vertex, marking every joint that ended up hard. That
 * attribute is what the material's edge-wear term keys off, and it exists only
 * because we make the geometry. A material handed somebody else's mesh has no
 * way to know where the machinist's file would have been.
 */
class Surface {
  constructor() {
    this.pos = [];
    this.tri = [];
    /** Per-vertex authored wear hint, used when a vertex turns out *not* to be a crease. */
    this.hint = [];
  }

  vertex(x, y, z, hint = 0) {
    this.pos.push(x, y, z);
    this.hint.push(hint);
    return this.hint.length - 1;
  }

  face(a, b, c) {
    this.tri.push(a, b, c);
  }

  /** Wound so that `a → b → c → d` runs anticlockwise seen from outside. */
  quad(a, b, c, d) {
    this.tri.push(a, b, c, a, c, d);
  }

  get vertexCount() {
    return this.hint.length;
  }
}

/**
 * Split creases, compute normals, seat into the unit box, hand back geometry.
 *
 * The crease pass is the standard smoothing-group algorithm: every triangle
 * contributes its area-weighted face normal to one of several *groups* at each
 * of its corners, joining an existing group only if the group's running average
 * is within `creaseAngle` of the face. A vertex that ends with one group is
 * smooth; a vertex that ends with three is the corner of a chamfer where three
 * planes meet, and it becomes three vertices.
 *
 * Two details that are not obvious:
 *
 *  - **Degenerate triangles are dropped, not skipped.** A gear root fillet
 *    collapses to a sliver when `rootFillet` is wound down, and a zero-area
 *    triangle contributes a NaN normal that poisons the whole vertex. The
 *    harness scans for exactly that.
 *  - **A crease is not the same thing as a machined edge**, and the first
 *    version conflated them. Every ring of a chamfered extrusion is a crease —
 *    the cap meets the chamfer, the chamfer meets the wall — so 84% of a
 *    gear's vertices came back marked, `aEdge` was 1 almost everywhere, and
 *    the wear term just brightened the whole part. What the material actually
 *    wants is the *lip*: the outermost ring of a chamfer, falling off to
 *    nothing across the band. So the generators author that ring's `hint`
 *    directly and an unhinted crease is only worth `CREASE_WEAR`, which is
 *    enough to catch a bore rim and not enough to wash out a face.
 *  - **The crease's contribution is scaled by how outward-facing it is**,
 *    using the dot of the averaged normal against the direction from the mesh
 *    centroid. A heuristic, and these parts are all roughly star-shaped, so it
 *    holds. The honest version — signing the curvature across each crease edge
 *    — needs an edge-adjacency map for a term that ends up multiplied by a
 *    slider anyway.
 */

/** What an unhinted crease is worth in `aEdge`. An authored lip is worth 1. */
const CREASE_WEAR = 0.22;
function finishSurface(surface, options = {}) {
  const { creaseAngle = 30, axis = HardAxis.Y } = options;
  const creaseCos = Math.cos(clamp(creaseAngle, 1, 179) * DEG);
  const pos = surface.pos;
  const src = surface.tri;
  const vertexCount = surface.vertexCount;

  /* --- centroid, for the outward-facing test --- */
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < vertexCount; i++) {
    cx += pos[i * 3];
    cy += pos[i * 3 + 1];
    cz += pos[i * 3 + 2];
  }
  if (vertexCount > 0) {
    cx /= vertexCount;
    cy /= vertexCount;
    cz /= vertexCount;
  }

  /* --- accumulate face normals into per-vertex smoothing groups --- */
  const groups = new Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) groups[i] = [];

  const kept = [];
  const cornerGroup = [];

  for (let t = 0; t < src.length; t += 3) {
    const a = src[t];
    const b = src[t + 1];
    const c = src[t + 2];
    const ax = pos[a * 3];
    const ay = pos[a * 3 + 1];
    const az = pos[a * 3 + 2];
    const ux = pos[b * 3] - ax;
    const uy = pos[b * 3 + 1] - ay;
    const uz = pos[b * 3 + 2] - az;
    const vx = pos[c * 3] - ax;
    const vy = pos[c * 3 + 1] - ay;
    const vz = pos[c * 3 + 2] - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const area2 = Math.hypot(nx, ny, nz);
    // A sliver contributes nothing but a division by zero.
    if (!(area2 > 1e-12)) continue;
    const inv = 1 / area2;
    const fx = nx * inv;
    const fy = ny * inv;
    const fz = nz * inv;

    kept.push(a, b, c);
    for (const v of [a, b, c]) {
      const list = groups[v];
      let picked = -1;
      for (let g = 0; g < list.length; g++) {
        const group = list[g];
        const len = Math.hypot(group[0], group[1], group[2]);
        if (len <= 1e-12) continue;
        if ((group[0] * fx + group[1] * fy + group[2] * fz) / len >= creaseCos) {
          picked = g;
          break;
        }
      }
      if (picked < 0) {
        picked = list.length;
        list.push([0, 0, 0]);
      }
      const group = list[picked];
      // Area weighting: a chamfer band is a sliver next to the face it breaks,
      // and an unweighted average lets it drag the face's normal off true.
      group[0] += nx;
      group[1] += ny;
      group[2] += nz;
      cornerGroup.push(picked);
    }
  }

  /* --- emit one vertex per (vertex, group) pair --- */
  const outPos = [];
  const outNormal = [];
  const outEdge = [];
  const base = new Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const list = groups[v];
    base[v] = outEdge.length;
    const px = pos[v * 3];
    const py = pos[v * 3 + 1];
    const pz = pos[v * 3 + 2];
    for (let g = 0; g < list.length; g++) {
      const group = list[g];
      const len = Math.hypot(group[0], group[1], group[2]) || 1;
      const nx = group[0] / len;
      const ny = group[1] / len;
      const nz = group[2] / len;
      outPos.push(px, py, pz);
      outNormal.push(nx, ny, nz);

      let edge = surface.hint[v];
      if (list.length > 1) {
        const dx = px - cx;
        const dy = py - cy;
        const dz = pz - cz;
        const dlen = Math.hypot(dx, dy, dz) || 1;
        const outward = (nx * dx + ny * dy + nz * dz) / dlen;
        edge = Math.max(edge, CREASE_WEAR * smoothstep(-0.25, 0.35, outward));
      }
      outEdge.push(saturate(edge));
    }
  }

  const index = new Array(kept.length);
  for (let i = 0; i < kept.length; i++) index[i] = base[kept[i]] + cornerGroup[i];

  /* --- axis, then seat into the unit box --- */
  seatUnit(outPos, outNormal, axis);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(outPos), 3));
  geometry.setAttribute('normal', new BufferAttribute(Float32Array.from(outNormal), 3));
  geometry.setAttribute('aEdge', new BufferAttribute(Float32Array.from(outEdge), 1));
  geometry.setIndex(
    outEdge.length > 65535 ? new BufferAttribute(Uint32Array.from(index), 1) : new BufferAttribute(Uint16Array.from(index), 1)
  );
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Rotate the canonical frame onto the requested axis, then fit the unit box.
 *
 * The fit is one uniform scale against `max(footprint diameter, height)`,
 * where the footprint diameter is measured as a real radius about the axis
 * rather than as a bounding-box width — `GrowthField`'s contract asks for a
 * *circle* of radius 0.5, and a square plate measured by its width would poke
 * its corners out of it by 41%.
 */
function seatUnit(pos, normal, axis) {
  const count = pos.length / 3;
  if (!count) return;

  // Canonical frame is profile-in-XY, axis along +Z.
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    const nx = normal[i * 3];
    const ny = normal[i * 3 + 1];
    const nz = normal[i * 3 + 2];
    if (axis === HardAxis.Y) {
      // +Z → +Y (rotate −90° about X)
      pos[i * 3 + 1] = z;
      pos[i * 3 + 2] = -y;
      normal[i * 3 + 1] = nz;
      normal[i * 3 + 2] = -ny;
    } else if (axis === HardAxis.X) {
      // +Z → +X (rotate +90° about Y)
      pos[i * 3] = z;
      pos[i * 3 + 2] = -x;
      normal[i * 3] = nz;
      normal[i * 3 + 2] = -nx;
    }
    // HardAxis.Z is the canonical frame already.
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  const midX = (minX + maxX) * 0.5;
  const midZ = (minZ + maxZ) * 0.5;
  let radius = 0;
  for (let i = 0; i < count; i++) {
    const dx = pos[i * 3] - midX;
    const dz = pos[i * 3 + 2] - midZ;
    const r = Math.hypot(dx, dz);
    if (r > radius) radius = r;
  }

  const span = Math.max(radius * 2, maxY - minY, 1e-4);
  const scale = 1 / span;
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (pos[i * 3] - midX) * scale;
    pos[i * 3 + 1] = (pos[i * 3 + 1] - minY) * scale;
    pos[i * 3 + 2] = (pos[i * 3 + 2] - midZ) * scale;
  }
}

/* ---------------------------------------------------------------------- */
/* 2D contour helpers                                                      */
/* ---------------------------------------------------------------------- */

/**
 * Miter-offset a closed contour by `inset`, positive meaning **into the
 * material** for both windings.
 *
 * The winding does the work: the inward normal of an edge is `(-dy, dx)`,
 * which for an anticlockwise outline points into the part and for a clockwise
 * hole points into the wall of the hole — so one positive number chamfers an
 * outline and countersinks a bore with no special case.
 *
 * The miter is clamped at `MITER_MIN`. A gear tooth tip is a 20° corner whose
 * true miter is nine times the inset, and an unclamped offset there swings the
 * chamfer ring right through the neighbouring tooth; the clamp blunts the very
 * sharpest tips by a fraction of a millimetre instead, which nobody has ever
 * noticed and which is why the tip does not disappear.
 */
const MITER_MIN = 0.34;

function insetContour(points, inset) {
  const n = points.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];

    let ax = p.x - prev.x;
    let ay = p.y - prev.y;
    let al = Math.hypot(ax, ay) || 1;
    ax /= al;
    ay /= al;
    let bx = next.x - p.x;
    let by = next.y - p.y;
    let bl = Math.hypot(bx, by) || 1;
    bx /= bl;
    by /= bl;

    // Inward normals of the two edges meeting at this corner.
    const n1x = -ay;
    const n1y = ax;
    const n2x = -by;
    const n2y = bx;

    let mx = n1x + n2x;
    let my = n1y + n2y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) {
      mx = n2x;
      my = n2y;
    } else {
      mx /= ml;
      my /= ml;
    }
    const cos = Math.max(mx * n2x + my * n2y, MITER_MIN);
    const scale = inset / cos;
    out[i] = new Vector2(p.x + mx * scale, p.y + my * scale);
  }
  return out;
}

/** A circle as a contour. `winding` −1 gives the clockwise form a hole wants. */
function circleContour(cx, cy, radius, segments, winding = 1) {
  const out = [];
  const n = Math.max(3, Math.round(segments));
  for (let i = 0; i < n; i++) {
    const a = (winding * i * TAU) / n;
    out.push(new Vector2(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius));
  }
  return out;
}

/**
 * Extrude a contour with holes from `z0` to `z1`, with a chamfer at each face
 * and an independent countersink on the holes.
 *
 * Cap triangulation is `ShapeUtils.triangulateShape`, three's own Earcut. It
 * is the one part of this file that is not hand-rolled and it stays that way:
 * a gear blank with a bore and six lightening holes is a 400-point outline
 * with seven holes in it, and writing another ear-clipper to avoid the import
 * would be pure vanity.
 */
function extrudeContour(surface, spec) {
  const {
    outline,
    holes = [],
    z0 = 0,
    z1 = 1,
    chamfer = 0,
    chamferDepth = null,
    holeChamfer = 0,
    holeChamferDepth = null,
    hint = 0
  } = spec;

  const height = z1 - z0;
  const cDepth = Math.min(chamferDepth ?? chamfer, height * 0.45);
  const hDepth = Math.min(holeChamferDepth ?? holeChamfer, height * 0.45);

  /* Ring heights, then each contour's inset evaluated *independently* at each
     of them.
     The first version carried one `(z, outlineInset, holeInset)` triple per
     level and set both insets to zero at the foot of the outline's chamfer —
     so a countersink deeper than the plate's bevel silently got the bevel's
     depth instead, and `counterDepth` was a slider that did nothing beyond a
     threshold. Insets are two independent ramps in z and are now written as
     two independent ramps in z. */
  const heights = [z0, z0 + cDepth, z0 + hDepth, z1 - hDepth, z1 - cDepth, z1]
    .sort((a, b) => a - b)
    .filter((z, i, list) => i === 0 || z - list[i - 1] > 1e-7);

  /** A 45°-or-not chamfer ramp: full inset at the face, zero at `depth` in. */
  const rampAt = (z, inset, depth) => {
    if (inset <= 1e-7) return 0;
    const fromBottom = depth > 1e-7 ? saturate((z - z0) / depth) : 1;
    const fromTop = depth > 1e-7 ? saturate((z1 - z) / depth) : 1;
    return inset * (1 - Math.min(fromBottom, fromTop));
  };
  const levels = heights.map((z) => ({
    z,
    oi: rampAt(z, chamfer, cDepth),
    hi: rampAt(z, holeChamfer, hDepth)
  }));

  const contours = [outline, ...holes];
  /** rings[level][contour] = array of vertex indices */
  const rings = [];

  for (const level of levels) {
    const row = [];
    for (let c = 0; c < contours.length; c++) {
      const inset = c === 0 ? level.oi : level.hi;
      const full = c === 0 ? chamfer : holeChamfer;
      const pts = inset > 1e-7 ? insetContour(contours[c], inset) : contours[c];
      const ids = new Array(pts.length);
      // `aEdge` rides the chamfer ramp itself: 1 at the lip, 0 at the foot of
      // the band. Marking every inset ring as 1 instead — which is what the
      // countersink fix accidentally did — puts the whole band at full wear
      // and the thin bright line a file leaves becomes a stripe.
      const wear = full > 1e-7 ? Math.max(hint, inset / full) : hint;
      for (let i = 0; i < pts.length; i++) ids[i] = surface.vertex(pts[i].x, pts[i].y, level.z, wear);
      row.push({ ids, pts });
    }
    rings.push(row);
  }

  /* Walls. */
  for (let l = 0; l < rings.length - 1; l++) {
    for (let c = 0; c < contours.length; c++) {
      const lower = rings[l][c].ids;
      const upper = rings[l + 1][c].ids;
      const n = lower.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        surface.quad(lower[i], lower[j], upper[j], upper[i]);
      }
    }
  }

  /* Caps, from the extreme rings so the chamfer is what the face sits on. */
  capContourRing(surface, rings[0], false);
  capContourRing(surface, rings[rings.length - 1], true);
}

/** Triangulate one ring row into a flat cap. `up` picks the winding. */
function capContourRing(surface, row, up) {
  const outline = row[0];
  const holes = row.slice(1);
  const faces = ShapeUtils.triangulateShape(
    outline.pts,
    holes.map((h) => h.pts)
  );
  const flat = [...outline.ids];
  for (const hole of holes) flat.push(...hole.ids);
  for (const face of faces) {
    const a = flat[face[0]];
    const b = flat[face[1]];
    const c = flat[face[2]];
    if (a === undefined || b === undefined || c === undefined) continue;
    if (up) surface.face(a, b, c);
    else surface.face(a, c, b);
  }
}

/**
 * Surface of revolution about +Z.
 *
 * `stations` are `{ r, z }` in profile order; a station with `r ≈ 0` becomes a
 * single pole vertex rather than a ring of coincident ones, which is what
 * keeps the bolt's point from being a fan of degenerate slivers. `radial` is
 * an optional `(z, theta, r) => r` used by exactly one caller — the bolt's
 * thread, which is the only place in this file where the radius depends on the
 * angle as well as the height.
 */
function revolveProfile(surface, spec) {
  const { stations, segments = 24, radial = null, capBottom = true, capTop = true, hint = 0 } = spec;
  const n = Math.max(3, Math.round(segments));
  const rings = [];

  for (const station of stations) {
    const r = Math.max(station.r, 0);
    const wear = station.hint ?? hint;
    if (r < 1e-5) {
      rings.push({ pole: true, ids: [surface.vertex(0, 0, station.z, wear)] });
      continue;
    }
    const ids = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i * TAU) / n;
      const rr = radial ? radial(station.z, a, r) : r;
      ids[i] = surface.vertex(Math.cos(a) * rr, Math.sin(a) * rr, station.z, wear);
    }
    rings.push({ pole: false, ids });
  }

  for (let s = 0; s < rings.length - 1; s++) {
    const lower = rings[s];
    const upper = rings[s + 1];
    if (lower.pole && upper.pole) continue;
    if (lower.pole) {
      for (let i = 0; i < n; i++) surface.face(lower.ids[0], upper.ids[i], upper.ids[(i + 1) % n]);
    } else if (upper.pole) {
      for (let i = 0; i < n; i++) surface.face(upper.ids[0], lower.ids[(i + 1) % n], lower.ids[i]);
    } else {
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        surface.quad(lower.ids[i], lower.ids[j], upper.ids[j], upper.ids[i]);
      }
    }
  }

  const first = rings[0];
  const last = rings[rings.length - 1];
  if (capBottom && !first.pole) {
    const centre = surface.vertex(0, 0, stations[0].z, hint);
    for (let i = 0; i < n; i++) surface.face(centre, first.ids[(i + 1) % n], first.ids[i]);
  }
  if (capTop && !last.pole) {
    const centre = surface.vertex(0, 0, stations[stations.length - 1].z, hint);
    for (let i = 0; i < n; i++) surface.face(centre, last.ids[i], last.ids[(i + 1) % n]);
  }
}

/**
 * Loft equal-count convex cross-sections along a travel direction.
 *
 * Sections must be wound right-handed about the direction of travel — for the
 * anvil's body that is anticlockwise in XY going up, for its horn it is the
 * same relation about +X. Caps are centroid fans, which is legitimate here and
 * only here: every section this module lofts is convex by construction.
 */
function loftSections(surface, sections, options = {}) {
  const { capFirst = true, capLast = true, hint = 0, hints = null } = options;
  const rings = sections.map((section, s) => {
    const ids = new Array(section.length);
    const wear = hints?.[s] ?? hint;
    for (let i = 0; i < section.length; i++) {
      const p = section[i];
      ids[i] = surface.vertex(p.x, p.y, p.z, wear);
    }
    return ids;
  });

  for (let s = 0; s < rings.length - 1; s++) {
    const lower = rings[s];
    const upper = rings[s + 1];
    const n = lower.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      surface.quad(lower[i], lower[j], upper[j], upper[i]);
    }
  }

  const fan = (ring, section, forward) => {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of section) {
      cx += p.x;
      cy += p.y;
      cz += p.z;
    }
    const inv = 1 / Math.max(1, section.length);
    const centre = surface.vertex(cx * inv, cy * inv, cz * inv, hint);
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (forward) surface.face(centre, ring[i], ring[j]);
      else surface.face(centre, ring[j], ring[i]);
    }
  };

  if (capFirst) fan(rings[0], sections[0], false);
  if (capLast) fan(rings[rings.length - 1], sections[sections.length - 1], true);
}

/** A rounded rectangle, anticlockwise, in the XY plane at height `z`. */
function roundedRect(halfWidth, halfDepth, corner, steps, z) {
  const r = Math.min(corner, halfWidth * 0.99, halfDepth * 0.99);
  const x = Math.max(halfWidth - r, 0);
  const y = Math.max(halfDepth - r, 0);
  const n = Math.max(1, Math.round(steps));
  const out = [];
  const arc = (ox, oy, from) => {
    for (let i = 0; i <= n; i++) {
      const a = from + (i / n) * (Math.PI / 2);
      out.push(new Vector3(ox + Math.cos(a) * r, oy + Math.sin(a) * r, z));
    }
  };
  arc(x, y, 0);
  arc(-x, y, Math.PI / 2);
  arc(-x, -y, Math.PI);
  arc(x, -y, Math.PI * 1.5);
  return out;
}

/**
 * Laplacian smoothing over a resampled silhouette — the fillet machinery.
 *
 * An anvil has nine slope changes between the base and the face and every one
 * of them is filleted on a real one. Authoring nine tangent arcs means solving
 * nine tangency conditions and re-solving all of them whenever a proportion
 * slider moves, and the first version of this function did exactly that and
 * produced a self-intersecting waist the moment `waistWidth` went below a
 * third. Resampling the silhouette evenly and then running a handful of
 * three-tap averaging passes rounds every corner at once, cannot self-
 * intersect, degrades to the sharp original at `fillet = 0`, and is nine
 * lines. The endpoints are pinned so the base stays flat on the floor and the
 * working face stays flat.
 */
function smoothProfile(keys, samples, weight, passes) {
  const count = Math.max(3, Math.round(samples));
  const out = [];
  // Resample the piecewise-linear key list on the vertical.
  const zFirst = keys[0].z;
  const zLast = keys[keys.length - 1].z;
  for (let i = 0; i < count; i++) {
    const z = zFirst + ((zLast - zFirst) * i) / (count - 1);
    let k = 0;
    while (k < keys.length - 2 && keys[k + 1].z < z) k++;
    const a = keys[k];
    const b = keys[k + 1];
    const t = b.z - a.z > 1e-9 ? clamp((z - a.z) / (b.z - a.z), 0, 1) : 0;
    out.push({ z, w: a.w + (b.w - a.w) * t, d: a.d + (b.d - a.d) * t });
  }

  const k = saturate(weight);
  for (let pass = 0; pass < Math.max(0, Math.round(passes)); pass++) {
    const copy = out.map((s) => ({ ...s }));
    for (let i = 1; i < out.length - 1; i++) {
      out[i].w = copy[i].w + ((copy[i - 1].w + copy[i + 1].w) * 0.5 - copy[i].w) * k;
      out[i].d = copy[i].d + ((copy[i - 1].d + copy[i + 1].d) * 0.5 - copy[i].d) * k;
      out[i].z = copy[i].z + ((copy[i - 1].z + copy[i + 1].z) * 0.5 - copy[i].z) * k;
    }
  }
  return out;
}

/* ====================================================================== */
/* §3 · The involute gear                                                 */
/* ====================================================================== */

/**
 * The involute function, `inv(α) = tan α − α`.
 *
 * This is the whole reason gears mesh. Two involute flanks in contact
 * transmit motion at a constant ratio *regardless of how far apart their
 * centres are* — the property no other tooth curve has, and the property that
 * makes `gearlock`'s trick possible: the ability can drag the module, the
 * centres move, and the train stays meshed rather than needing a new profile.
 */
function involute(alpha) {
  return Math.tan(alpha) - alpha;
}

/**
 * Half the angular tooth thickness at radius `x`, measured from the tooth's
 * own centreline.
 *
 * `ψ(x) = ψ_p + inv(α) − inv(α_x)` where `cos α_x = r_b / x`. At the pitch
 * circle `α_x = α` and this collapses to `ψ_p`, which is the identity worth
 * checking when you change anything in here.
 */
function toothHalfAngle(x, baseRadius, psiPitch, invAlpha) {
  const cosAx = clamp(baseRadius / Math.max(x, 1e-6), -1, 1);
  const alphaX = Math.acos(cosAx);
  return psiPitch + invAlpha - involute(alphaX);
}

/**
 * The gear's radii, in *profile* units where the tip radius is exactly 0.5.
 *
 * Everything about the gear that the rest of the file needs comes out of here,
 * including the pitch radius the ability wants for spacing. Fixing the tip at
 * 0.5 means the seating pass is a no-op for a flat gear and the numbers you
 * read here are the numbers the mesh has.
 */
function gearRadii(shape) {
  const teeth = Math.max(4, Math.round(shape.teeth));
  const addendum = Math.max(shape.addendum, 0.05);
  const dedendum = Math.max(shape.dedendum, addendum * 0.2);
  // Choose the module so that the nominal tip diameter is exactly 1.
  const module = 1 / (teeth + 2 * addendum);
  const pitch = (module * teeth) / 2;
  const alpha = clamp(shape.pressureAngle, 5, 35) * DEG;
  const base = pitch * Math.cos(alpha);
  const tip = pitch + addendum * module;
  const root = Math.max(pitch - dedendum * module, module * 0.15);

  const psiPitch = (Math.PI / (2 * teeth)) * (1 - clamp(shape.backlash, 0, 0.5));
  const invAlpha = involute(alpha);

  /* Where the flank starts. The involute exists only outside the base circle
     and below that the fillet takes over — but there is a second bound that
     the obvious `max(base, root)` misses. The tooth's half-angle grows as the
     radius falls, and on a fine, high-pressure-angle gear it passes `π/z`
     before the flank reaches the base circle: the tooth is then wider than
     the pitch it has to live in and every tooth overlaps its neighbour. Six
     of the editor's slider combinations reach it (31 teeth, dedendum 1.8,
     30°) and the symptom is one crossing per tooth, all the way round. So the
     flank starts at whichever radius comes first, and the fillet covers a
     little more of the root than it otherwise would. */
  const capAngle = (Math.PI / teeth) * 0.92;
  let flankStart = Math.max(base, root) + 1e-5;
  if (toothHalfAngle(flankStart, base, psiPitch, invAlpha) > capAngle) {
    let lo = flankStart;
    let hi = tip;
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) * 0.5;
      if (toothHalfAngle(mid, base, psiPitch, invAlpha) > capAngle) lo = mid;
      else hi = mid;
    }
    flankStart = hi;
  }

  /* A pointed tooth is a real failure of high addendum on a low tooth count,
     and it has a real answer: the tip circle moves down to the radius where
     the two flanks meet. Clamping the half-angle at zero instead — the first
     version — leaves every sample above that radius sitting on the centreline
     and the two flanks walk straight through each other; a sweep of the
     editor's whole range found it in 31 of 1080 profiles, all reachable with
     two sliders. Bisection because ψ(r) = 0 has no closed form; twenty-eight
     steps is exact to the last float and it runs once per rebuild. */
  let outer = tip;
  if (toothHalfAngle(tip, base, psiPitch, invAlpha) <= 1e-4) {
    let lo = flankStart;
    let hi = tip;
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) * 0.5;
      if (toothHalfAngle(mid, base, psiPitch, invAlpha) > 1e-4) lo = mid;
      else hi = mid;
    }
    outer = Math.max(lo, flankStart * 1.02);
  }

  return {
    teeth,
    module,
    alpha,
    pitch,
    base,
    tip, //  the NOMINAL tip: pitch + addendum
    outer, //  what the profile actually reaches — lower on a pointed tooth
    root,
    psiPitch,
    invAlpha,
    capAngle,
    flankStart,
    halfAtStart: clamp(toothHalfAngle(flankStart, base, psiPitch, invAlpha), 1e-4, capAngle),
    halfAtTip: Math.max(toothHalfAngle(outer, base, psiPitch, invAlpha), 0),
    pointed: outer < tip - 1e-6
  };
}

/**
 * The pitch radius as a fraction of the gear's actual outer radius.
 *
 * After seating, that outer radius **is** half the instance's footprint, so
 * `pitchRadiusMetres = 0.5 · instanceScale · gearPitchFraction(shape)` and,
 * going the other way, `instanceScale = 2 · pitchRadiusMetres /
 * gearPitchFraction(shape)`.
 *
 * It is measured against the *actual* outer radius rather than the nominal
 * one for a reason that only shows up in one place and shows up badly: a
 * pointed tooth's profile stops short of `pitch + addendum`, the seating pass
 * scales the point out to 0.5 regardless, and a gear placed by the nominal
 * radius is then drawn slightly too large — with its pitch circle outside
 * where its neighbour thinks it is, which is interpenetration. Passing this
 * number to `GearTrain#scaleOf` is what keeps that exact.
 */
export function gearPitchFraction(shape) {
  const r = gearRadii(gearShape(shape));
  return r.pitch / r.outer;
}

/** The root radius as a fraction of the outer radius — where a gullet bottoms out. */
export function gearRootFraction(shape) {
  const r = gearRadii(gearShape(shape));
  return r.root / r.outer;
}

/**
 * The involute tooth outline, anticlockwise, starting in a root gap.
 *
 * Per tooth, in strictly increasing angle so the polygon cannot fold:
 *
 *   root arc → fillet → trailing flank out → tip arc → leading flank in → fillet
 *
 * The fillet is a quadratic blend from the root circle up to the base of the
 * flank, standing in for the trochoid a hob would actually cut. The trochoid
 * depends on the cutter's tip radius, which is a parameter nobody wants and
 * nobody can see at this scale; the blend is tangent-ish at both ends and is
 * the difference between a tooth that looks machined and a tooth that looks
 * stamped out of card.
 *
 * A tooth whose half-angle reaches zero before the tip radius has *pointed* —
 * a real failure mode of high addendum on a low tooth count — and the profile
 * clamps to the point rather than crossing itself.
 */
function gearOutline(shape) {
  const {
    teeth,
    base,
    root,
    psiPitch,
    invAlpha,
    flankStart,
    halfAtStart,
    halfAtTip,
    outer: tipRadius,
    pointed
  } = gearRadii(shape);
  const flankSteps = Math.max(2, Math.round(shape.flankSteps));
  const tipSteps = Math.max(1, Math.round(shape.tipSteps));
  const rootSteps = Math.max(1, Math.round(shape.rootSteps));

  // How much of the root gap the fillet may eat, leaving the gap itself open.
  const gapHalf = Math.PI / teeth - halfAtStart;
  const filletSpan = clamp(shape.rootFillet, 0, 1) * Math.max(gapHalf, 0) * 0.8;

  const points = [];
  const at = (radius, angle) => points.push(new Vector2(Math.cos(angle) * radius, Math.sin(angle) * radius));

  for (let k = 0; k < teeth; k++) {
    const centre = (k * TAU) / teeth;

    /* Root arc, from the previous tooth's fillet exit to this one's entry. */
    const gapFrom = centre - Math.PI / teeth + filletSpan;
    const gapTo = centre - halfAtStart - filletSpan;
    for (let i = 0; i < rootSteps; i++) {
      at(root, gapFrom + ((gapTo - gapFrom) * i) / rootSteps);
    }

    /* Trailing fillet: quadratic from the root circle to the flank base. */
    const fx0 = Math.cos(gapTo) * root;
    const fy0 = Math.sin(gapTo) * root;
    const cxT = Math.cos(centre - halfAtStart) * root;
    const cyT = Math.sin(centre - halfAtStart) * root;
    const fx1 = Math.cos(centre - halfAtStart) * flankStart;
    const fy1 = Math.sin(centre - halfAtStart) * flankStart;
    for (let i = 0; i < 3; i++) {
      const t = i / 3;
      const u = 1 - t;
      points.push(
        new Vector2(u * u * fx0 + 2 * u * t * cxT + t * t * fx1, u * u * fy0 + 2 * u * t * cyT + t * t * fy1)
      );
    }

    /* Trailing flank, out to the tip. */
    for (let i = 0; i < flankSteps; i++) {
      const x = flankStart + ((tipRadius - flankStart) * i) / flankSteps;
      at(x, centre - Math.max(toothHalfAngle(x, base, psiPitch, invAlpha), halfAtTip));
    }

    /* Tip: an arc, or the single point a pointed tooth has instead. */
    if (pointed) {
      at(tipRadius, centre);
    } else {
      for (let i = 0; i <= tipSteps; i++) {
        at(tipRadius, centre - halfAtTip + ((2 * halfAtTip) * i) / tipSteps);
      }
    }

    /* Leading flank, back down. */
    for (let i = flankSteps - 1; i >= 0; i--) {
      const x = flankStart + ((tipRadius - flankStart) * i) / flankSteps;
      at(x, centre + Math.max(toothHalfAngle(x, base, psiPitch, invAlpha), halfAtTip));
    }

    /* Leading fillet, back to the root circle. */
    const gx0 = Math.cos(centre + halfAtStart) * flankStart;
    const gy0 = Math.sin(centre + halfAtStart) * flankStart;
    const cxL = Math.cos(centre + halfAtStart) * root;
    const cyL = Math.sin(centre + halfAtStart) * root;
    const gx1 = Math.cos(centre + halfAtStart + filletSpan) * root;
    const gy1 = Math.sin(centre + halfAtStart + filletSpan) * root;
    for (let i = 1; i <= 3; i++) {
      const t = i / 3;
      const u = 1 - t;
      points.push(
        new Vector2(u * u * gx0 + 2 * u * t * cxL + t * t * gx1, u * u * gy0 + 2 * u * t * cyL + t * t * gy1)
      );
    }
  }

  // Guard against the degenerate case where every point landed on top of the
  // last: Earcut answers a fold with inverted triangles, not an error.
  return dedupeContour(points);
}

/** Drop points a hair apart — Earcut folds on them and the crease pass NaNs. */
function dedupeContour(points, epsilon = 1e-6) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < epsilon && Math.abs(last.y - p.y) < epsilon) continue;
    out.push(p);
  }
  while (out.length > 3) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(first.x - last.x) < epsilon && Math.abs(first.y - last.y) < epsilon) out.pop();
    else break;
  }
  return out;
}

/** An involute spur gear: bore, optional lightening holes, chamfered faces. */
export function createGearGeometry(shape = gearShape()) {
  const s = gearShape(shape);
  const radii = gearRadii(s);
  const surface = new Surface();

  const holes = [];
  const bore = clamp(s.bore, 0, 0.85) * radii.outer;
  if (bore > 1e-3) holes.push(circleContour(0, 0, bore, s.boreSegments, -1));

  const lighten = Math.max(0, Math.round(s.lightenHoles));
  if (lighten > 0) {
    const ring = clamp(s.lightenRing, 0, 0.92) * radii.outer;
    const r = Math.max(clamp(s.lightenRadius, 0, 0.4) * radii.outer, 1e-3);
    for (let i = 0; i < lighten; i++) {
      const a = (i * TAU) / lighten;
      holes.push(circleContour(Math.cos(a) * ring, Math.sin(a) * ring, r, s.lightenSegments, -1));
    }
  }

  const thickness = Math.max(s.thickness, 0.01);
  extrudeContour(surface, {
    outline: gearOutline(s),
    holes,
    z0: 0,
    z1: thickness,
    chamfer: Math.min(s.chamfer, thickness * 0.4),
    holeChamfer: Math.min(s.boreChamfer, thickness * 0.4)
  });

  return finishSurface(surface, { creaseAngle: s.creaseAngle, axis: s.axis });
}

/* ====================================================================== */
/* §4 · The other five                                                    */
/* ====================================================================== */

/**
 * The saw tooth outline.
 *
 * Both working faces are **logarithmic spirals**, and that is not a
 * flourish: a face held at a constant angle `β` off the radial satisfies
 * `dθ/dr = −tan β / r`, whose integral is `θ(r) = θ_tip ± tan β · ln(r_tip/r)`.
 * Straight chords look right at 24 teeth and visibly wrong at 8, where the
 * rake angle at the gullet ends up nothing like the rake angle at the tip.
 *
 * The rake and clearance are scaled back together if the two faces would meet
 * before the gullet floor does. A self-intersecting outline does not throw —
 * Earcut hands back a fan of inverted triangles and the blade renders inside
 * out, which is a twenty-minute bug to find and a one-line clamp to avoid.
 */
function sawOutline(shape) {
  const teeth = Math.max(3, Math.round(shape.teeth));
  const tip = 0.5;
  const gulletRadius = Math.max(tip * (1 - clamp(shape.gullet, 0.02, 0.6)), tip * 0.2);
  const pitchAngle = TAU / teeth;
  const land = clamp(shape.tipLand, 0.02, 0.7) * pitchAngle * 0.5;
  const logDepth = Math.log(tip / gulletRadius);

  let tanRake = Math.tan(clamp(shape.rake, -35, 45) * DEG);
  let tanClear = Math.tan(clamp(shape.clearance, 0, 60) * DEG);

  /* Both faces are clamped together, and the bound is **two-sided**. The
     first version only guarded the top of it — the case where a deep hook and
     a deep relief eat the whole tooth pitch — and left the bottom open, so a
     strongly negative rake on a coarse blade swung the cutting face back past
     the clearance face of its own tooth. The condition is one number either
     way: at the gullet floor the rake face sits at `+land + tanRake·L` and
     the clearance face at `−land − tanClear·L`, so the sum has to stay inside
     `(−2·land, pitch − 2·land)` for the outline to be simple. 195 of 2160
     profiles in a sweep of the editor's range failed the lower half of it. */
  const sum = (tanRake + tanClear) * logDepth;
  const upper = (pitchAngle - 2 * land) * 0.82;
  const lower = -2 * land * 0.82;
  let k = 1;
  if (sum > upper && sum > 1e-9) k = upper / sum;
  else if (sum < lower && sum < -1e-9) k = lower / sum;
  tanRake *= k;
  tanClear *= k;

  const steps = Math.max(1, Math.round(shape.flankSteps));
  const gulletSteps = Math.max(1, Math.round(shape.gulletSteps));
  const points = [];
  const at = (radius, angle) => points.push(new Vector2(Math.cos(angle) * radius, Math.sin(angle) * radius));

  for (let k = 0; k < teeth; k++) {
    const centre = k * pitchAngle;

    /* Clearance face, climbing from the gullet floor to the trailing tip corner. */
    for (let i = 0; i <= steps; i++) {
      const r = gulletRadius + ((tip - gulletRadius) * i) / steps;
      at(r, centre - land - tanClear * Math.log(tip / r));
    }
    /* The land across the tip. */
    at(tip, centre + land);
    /* Rake face, dropping forward into the next gullet. */
    for (let i = 1; i <= steps; i++) {
      const r = tip - ((tip - gulletRadius) * i) / steps;
      at(r, centre + land + tanRake * Math.log(tip / r));
    }
    /* Gullet floor: an arc on to the next tooth's clearance face. */
    const from = centre + land + tanRake * logDepth;
    const to = centre + pitchAngle - land - tanClear * logDepth;
    for (let i = 1; i < gulletSteps; i++) {
      at(gulletRadius, from + ((to - from) * i) / gulletSteps);
    }
  }

  return dedupeContour(points);
}

/** A radial expansion slot: a rounded slit cut inward from the gullet floor. */
function slotContour(angle, from, to, halfWidth, steps) {
  const points = [];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const perpX = -sin;
  const perpY = cos;
  const n = Math.max(1, Math.round(steps));
  const cap = (radius, sign) => {
    for (let i = 0; i <= n; i++) {
      const a = (Math.PI * i) / n;
      const w = Math.cos(a) * halfWidth * sign;
      const d = Math.sin(a) * halfWidth * sign;
      points.push(new Vector2(cos * (radius + d) + perpX * w, sin * (radius + d) + perpY * w));
    }
  };
  cap(to, 1);
  cap(from, -1);
  // Clockwise for a hole.
  points.reverse();
  return dedupeContour(points);
}

/** A circular saw blade. */
export function createSawbladeGeometry(shape = sawbladeShape()) {
  const s = sawbladeShape(shape);
  const surface = new Surface();
  const tip = 0.5;

  const holes = [];
  const arbor = clamp(s.arbor, 0, 0.6) * tip;
  if (arbor > 1e-3) holes.push(circleContour(0, 0, arbor, s.arborSegments, -1));

  const slots = Math.max(0, Math.round(s.slots));
  if (slots > 0) {
    const gulletRadius = tip * (1 - clamp(s.gullet, 0.02, 0.6));
    const to = gulletRadius - tip * 0.03;
    const from = Math.max(to - clamp(s.slotDepth, 0.02, 0.7) * tip, arbor + tip * 0.06);
    const halfWidth = Math.max(clamp(s.slotWidth, 0.005, 0.2) * tip, 1e-3);
    if (to - from > halfWidth * 2.2) {
      for (let i = 0; i < slots; i++) {
        holes.push(slotContour((i * TAU) / slots + Math.PI / slots, from, to, halfWidth, s.slotSteps));
      }
    }
  }

  const thickness = Math.max(s.thickness, 0.006);
  extrudeContour(surface, {
    outline: sawOutline(s),
    holes,
    z0: 0,
    z1: thickness,
    chamfer: Math.min(s.chamfer, thickness * 0.4),
    holeChamfer: Math.min(s.chamfer * 0.6, thickness * 0.3)
  });

  return finishSurface(surface, { creaseAngle: s.creaseAngle, axis: s.axis });
}

/** A bevelled plate with countersunk bolt holes. */
export function createPlateGeometry(shape = plateShape()) {
  const s = plateShape(shape);
  const surface = new Surface();

  const halfW = Math.max(s.width, 0.05) * 0.5;
  const halfD = Math.max(s.depth, 0.05) * 0.5;
  const short = Math.min(halfW, halfD) * 2;
  const corner = clamp(s.corner, 0, 0.5) * short;

  const outline = roundedRect(halfW, halfD, corner, s.cornerSteps, 0).map((p) => new Vector2(p.x, p.y));

  const bolts = Math.max(0, Math.round(s.bolts));
  const holes = [];
  if (bolts > 0) {
    const inset = clamp(s.boltInset, 0.05, 0.45) * short;
    const r = Math.max(clamp(s.boltRadius, 0.005, 0.25) * short, 1e-3);
    const x = Math.max(halfW - inset, 0);
    const y = Math.max(halfD - inset, 0);
    // Corners first, then the mid-span pair a six-bolt pattern adds.
    const spots = [
      [x, y],
      [-x, y],
      [-x, -y],
      [x, -y],
      [0, y],
      [0, -y],
      [x, 0],
      [-x, 0]
    ];
    for (let i = 0; i < Math.min(bolts, spots.length); i++) {
      holes.push(circleContour(spots[i][0], spots[i][1], r, s.boltSegments, -1));
    }
  }

  const thickness = Math.max(s.thickness, 0.01);
  extrudeContour(surface, {
    outline,
    holes,
    z0: 0,
    z1: thickness,
    chamfer: Math.min(s.bevel, thickness * 0.4),
    // The countersink is the one chamfer here that is not 45°: a flare wider
    // than it is deep is what a real countersink bit leaves, and it is what
    // makes the hole read as machined rather than as drilled and abandoned.
    holeChamfer: clamp(s.counterSink, 0, 0.3) * short,
    holeChamferDepth: Math.min(s.counterDepth, thickness * 0.45)
  });

  return finishSurface(surface, { creaseAngle: s.creaseAngle, axis: s.axis });
}

/** A driven piston: base flange, rod, collar, ringed head. */
export function createPistonGeometry(shape = pistonShape()) {
  const s = pistonShape(shape);
  const surface = new Surface();
  const length = Math.max(s.length, 0.2);

  const stations = [];
  const add = (r, z, hint = 0) => stations.push({ r: Math.max(r, 0), z, hint });

  const baseR = Math.max(s.baseRadius, 0.02);
  const rodR = clamp(s.rodRadius, 0.01, baseR);
  const baseH = Math.max(s.baseHeight, 0.01) * length * 0.25;
  const baseC = Math.min(s.baseChamfer, baseH * 0.45, baseR * 0.45);

  /* Base flange. One hint per chamfer — see `finishSurface`. */
  add(0, 0);
  add(baseR - baseC, 0, 1);
  add(baseR, baseC);
  add(baseR, baseH - baseC);
  add(baseR - baseC, baseH, 1);
  add(rodR, baseH + baseC * 0.4);

  /* Collar. */
  const collarZ = clamp(s.collarAt, 0.05, 0.95) * length;
  const collarR = clamp(s.collarRadius, rodR, baseR * 1.2);
  const collarH = Math.max(s.collarHeight, 0.01) * length * 0.5;
  const collarC = Math.min(s.collarChamfer, collarH * 0.45, (collarR - rodR) * 0.9 + 1e-4);
  add(rodR, Math.max(collarZ - collarH * 0.5 - collarC, baseH + baseC));
  add(collarR - collarC, collarZ - collarH * 0.5, 1);
  add(collarR, collarZ - collarH * 0.5 + collarC);
  add(collarR, collarZ + collarH * 0.5 - collarC);
  add(collarR - collarC, collarZ + collarH * 0.5, 1);
  add(rodR, collarZ + collarH * 0.5 + collarC);

  /* Head, with its machined rings. */
  const headZ = clamp(s.headAt, 0.2, 0.98) * length;
  const headR = Math.max(s.headRadius, collarR);
  const headC = Math.min(s.headChamfer, headR * 0.4, (length - headZ) * 0.4);
  add(rodR, Math.max(headZ - headC, collarZ + collarH * 0.5 + collarC * 1.5));
  add(headR - headC, headZ, 1);
  add(headR, headZ + headC);

  const rings = Math.max(0, Math.round(s.rings));
  const crown = length;
  const ringSpan = crown - headC - (headZ + headC);
  if (rings > 0 && ringSpan > 0) {
    const depth = Math.min(s.ringDepth, headR * 0.5);
    const height = Math.min(s.ringHeight * length * 0.4, ringSpan / (rings * 2.4));
    for (let i = 0; i < rings; i++) {
      const z = headZ + headC + (ringSpan * (i + 0.7)) / (rings + 0.4);
      add(headR, z - height, 1);
      add(headR - depth, z - height * 0.35);
      add(headR - depth, z + height * 0.35);
      add(headR, z + height, 1);
    }
  }

  /* Crown: a chamfer and an optional dish. */
  add(headR, crown - headC);
  const recess = clamp(s.faceRecess, 0, 0.4);
  add(headR - headC, crown, 1);
  if (recess > 1e-4) {
    add(headR * 0.72, crown, 1);
    add(headR * 0.6, crown - recess * headR * 0.5);
    add(0, crown - recess * headR * 0.55);
  } else {
    add(0, crown);
  }

  // Monotone in z, or the lathe folds through itself.
  for (let i = 1; i < stations.length; i++) {
    if (stations[i].z < stations[i - 1].z) stations[i].z = stations[i - 1].z;
  }

  revolveProfile(surface, {
    stations,
    segments: s.segments,
    capBottom: stations[0].r > 1e-5,
    capTop: stations[stations.length - 1].r > 1e-5
  });

  return finishSurface(surface, { creaseAngle: s.creaseAngle, axis: s.axis });
}

/**
 * A hex-head bolt with a real helical thread.
 *
 * The thread is a sawtooth on the shank radius keyed on `z·turns + θ/2π`,
 * which is a genuine helix rather than a stack of rings: drop `threadSteps`
 * below about four and you can watch it degenerate into rings, which is a
 * useful way to see that it was never rings to begin with.
 */
export function createBoltGeometry(shape = boltShape()) {
  const s = boltShape(shape);
  const surface = new Surface();
  const length = Math.max(s.length, 0.3);

  /* Head: a hexagonal prism, chamfered on both faces. Across the flats is 1. */
  const headHeight = Math.max(s.headHeight, 0.05);
  const acrossFlats = 0.5;
  const acrossCorners = acrossFlats / Math.cos(Math.PI / 6);
  const hex = [];
  for (let i = 0; i < 6; i++) {
    const a = (i * TAU) / 6 + Math.PI / 6;
    hex.push(new Vector2(Math.cos(a) * acrossCorners, Math.sin(a) * acrossCorners));
  }
  extrudeContour(surface, {
    outline: hex,
    z0: length - headHeight,
    z1: length,
    chamfer: Math.min(s.headChamfer, headHeight * 0.4, acrossFlats * 0.4)
  });

  /* Shank, washer flange and point. */
  const shankR = clamp(s.shankRadius, 0.02, acrossFlats * 0.95);
  const washer = Math.max(s.washer, 0);
  const washerR = Math.max(s.washerRadius * 0.5, shankR);
  const shankTop = length - headHeight;
  const stations = [];
  const add = (r, z, hint = 0) => stations.push({ r: Math.max(r, 0), z, hint });

  const taper = clamp(s.tipTaper, 0, 0.5) * length;
  add(0, 0);
  add(shankR * 0.45, 0, 1);
  if (taper > 1e-3) add(shankR, taper);
  else add(shankR, 0);

  const threadFrom = clamp(s.threadFrom, 0, 0.9) * shankTop;
  const threadTo = Math.max(threadFrom, shankTop - washer * 1.2);
  const turns = Math.max(0, Math.round(s.threadTurns));
  const depth = clamp(s.threadDepth, 0, shankR * 0.6);
  const threaded = turns > 0 && depth > 1e-4 && threadTo - threadFrom > 1e-3;

  if (threaded) {
    const steps = Math.max(3, Math.round(s.threadSteps)) * turns;
    for (let i = 0; i <= steps; i++) {
      add(shankR, threadFrom + ((threadTo - threadFrom) * i) / steps);
    }
  } else {
    add(shankR, threadTo);
  }

  if (washer > 1e-4) {
    add(shankR, shankTop - washer);
    add(washerR, shankTop - washer, 1);
    add(washerR, shankTop, 1);
  } else {
    add(shankR, shankTop);
  }
  add(0, shankTop);

  for (let i = 1; i < stations.length; i++) {
    if (stations[i].z < stations[i - 1].z) stations[i].z = stations[i - 1].z;
  }

  const pitch = threaded ? (threadTo - threadFrom) / turns : 1;
  revolveProfile(surface, {
    stations,
    segments: s.shankSegments,
    capBottom: false,
    capTop: false,
    radial: threaded
      ? (z, theta, r) => {
          if (z < threadFrom - 1e-6 || z > threadTo + 1e-6 || r < shankR - 1e-6) return r;
          // One sawtooth per turn, advanced by the angle: a helix, not a ring.
          const phase = (z - threadFrom) / pitch - theta / TAU;
          const f = phase - Math.floor(phase);
          return r - depth * (1 - Math.abs(f * 2 - 1));
        }
      : null
  });

  return finishSurface(surface, { creaseAngle: s.creaseAngle, axis: s.axis });
}

/**
 * A blacksmith's anvil — horn, face, waist, base.
 *
 * Two lofts that interpenetrate: a body lofted up +Z through smoothed
 * rounded-rectangle sections, and a horn lofted along +X through circles that
 * shrink and droop. They are not booleaned together, because two closed solids
 * sharing an interior read exactly like one solid from every angle a camera in
 * this project can reach, and a CSG kernel for one prop is not a trade anybody
 * should make.
 *
 * Everything that makes it read as forged is in `smoothProfile`: the fillet
 * under the face, the hollow of the waist and the flare into the base are one
 * smoothing pass over one silhouette, and turning `fillet` to zero gives you
 * back the stack of boxes it would otherwise have been.
 */
export function createAnvilGeometry(shape = anvilShape()) {
  const s = anvilShape(shape);
  const surface = new Surface();

  const height = Math.max(s.height, 0.15);
  const baseH = Math.max(s.baseHeight, 0.02) * height;
  const waistH = Math.max(s.waistHeight, 0.02) * height;
  const faceH = Math.max(s.faceHeight, 0.02) * height;
  const total = baseH + waistH + faceH;
  const k = total > 1e-4 ? height / total : 1;

  const zBase = baseH * k;
  const zWaist = zBase + waistH * k;
  const zTop = zWaist + faceH * k;

  /* Key silhouette. Half-extents, so the numbers read as radii. */
  const keys = [
    { z: 0, w: s.baseWidth * 0.5, d: s.baseDepth * 0.5 },
    { z: zBase * 0.55, w: s.baseWidth * 0.5, d: s.baseDepth * 0.5 },
    { z: zBase, w: s.waistWidth * 0.62, d: s.waistDepth * 0.62 },
    { z: zBase + (zWaist - zBase) * 0.45, w: s.waistWidth * 0.5, d: s.waistDepth * 0.5 },
    { z: zWaist, w: s.waistWidth * 0.62, d: s.waistDepth * 0.62 },
    { z: zWaist + (zTop - zWaist) * 0.42, w: s.faceWidth * 0.5, d: s.faceDepth * 0.5 },
    { z: zTop, w: s.faceWidth * 0.5, d: s.faceDepth * 0.5 }
  ];

  const profile = smoothProfile(keys, s.sections, s.fillet, s.filletPasses);
  const sections = profile.map((station) => {
    const half = Math.min(station.w, station.d);
    return roundedRect(
      Math.max(station.w, 1e-3),
      Math.max(station.d, 1e-3),
      clamp(s.corner, 0, 0.9) * half,
      s.cornerSteps,
      station.z
    );
  });
  // The face perimeter is the one part of an anvil that is genuinely polished,
  // by a century of hot steel sliding over it, and the loft has no chamfer to
  // hang that on — so the top two sections are hinted by hand.
  const bodyHints = sections.map((_, i) => (i === sections.length - 1 ? 1 : i === sections.length - 2 ? 0.45 : 0));
  loftSections(surface, sections, { capFirst: true, capLast: true, hints: bodyHints });

  /* The horn. Sections in the YZ plane, marching along +X so the loft's
     right-handed winding rule still holds. */
  const reach = Math.max(s.horn, 0) * 1;
  if (reach > 1e-3) {
    const rootX = Math.max(s.faceWidth, 0.05) * 0.5 - 1e-3;
    const rootR = Math.max(clamp(s.hornRadius, 0.05, 1) * s.faceDepth * 0.5, 1e-3);
    const centreZ = zTop - Math.min(rootR, faceH * k * 0.9);
    const steps = Math.max(3, Math.round(s.hornSteps));
    const count = Math.max(3, Math.round(s.hornSections));
    const hornSections = [];
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const x = rootX + reach * t;
      // Cubic taper: a horn that tapers linearly reads as a traffic cone.
      const r = Math.max(rootR * (1 - t * t * (3 - 2 * t)) * (1 - t * 0.15) + rootR * 0.06 * (1 - t), 1e-3);
      const droop = s.hornDroop * t * t;
      const ring = [];
      for (let j = 0; j < steps; j++) {
        const a = (j * TAU) / steps;
        ring.push(new Vector3(x, Math.cos(a) * r, centreZ - droop + Math.sin(a) * r));
      }
      hornSections.push(ring);
    }
    loftSections(surface, hornSections, { capFirst: false, capLast: true });
  }

  return finishSurface(surface, { creaseAngle: s.creaseAngle, axis: s.axis });
}

const GEOMETRY_FACTORIES = [
  createGearGeometry,
  createPistonGeometry,
  createSawbladeGeometry,
  createPlateGeometry,
  createBoltGeometry,
  createAnvilGeometry
];

/** `hardSurfaceGeometry(HardShape.ANVIL, shape)` — the dispatcher form. */
export function hardSurfaceGeometry(kind, shape) {
  const factory = GEOMETRY_FACTORIES[kind];
  if (!factory) throw new Error(`HardSurface: unknown shape kind ${kind}`);
  return factory(shape);
}

/* ====================================================================== */
/* §5 · The shape cache                                                   */
/* ====================================================================== */

/**
 * Rebuild geometry only when a number in the shape actually moved.
 *
 * The same trick `GrowthField#syncGeometry` uses, and for the same reason: an
 * anvil is a live slider panel, the panel is polled every frame, and building
 * it every frame would be four milliseconds of lathe work per frame for
 * nothing. The change test compares a `Float64Array` rather than composing a
 * key string, because at fifty abilities a template literal per shape per
 * frame is fifty strings a frame for the collector to sweep up.
 *
 * **This cache is yours, not global.** One `ShapeCache` per ability, disposed
 * with it. A shared cache would have to reference-count, and the first thing
 * that would happen is `GrowthField` — which disposes the geometry it is
 * handed the moment its own hash moves — quietly freeing a gear another
 * ability was still drawing. If you are feeding `GrowthField`, do not use this
 * at all: hand it `createGearGeometry` directly as its factory and let it own
 * the rebuild, because it is already doing exactly this test one level up.
 *
 * @example
 *   this.cache = new ShapeCache();
 *   // every frame — resolves live, rebuilds on change only
 *   this.mesh.geometry = this.cache.get(0, HardShape.GEAR, this._gearShape);
 */
export class ShapeCache {
  constructor(options = {}) {
    const { capacity = 8 } = options;
    this.capacity = Math.max(1, Math.round(capacity));
    this._slots = new Map();
    /** True if the last `get()` rebuilt. Poll it to re-upload derived data. */
    this.changed = false;
  }

  /** How many distinct geometries this cache is holding. */
  get size() {
    return this._slots.size;
  }

  /**
   * @param {number|string} slot  caller's own key — a variant index, usually
   * @param {number} kind         a `HardShape`
   * @param {object} shape        a shape object; every value must be a number
   * @returns {THREE.BufferGeometry} owned by the cache; never dispose it yourself
   */
  get(slot, kind, shape) {
    let entry = this._slots.get(slot);
    if (!entry) {
      if (this._slots.size >= this.capacity) {
        throw new Error(`HardSurface: ShapeCache is full at ${this.capacity} slots — raise capacity`);
      }
      entry = { kind: -1, keys: null, values: null, geometry: null };
      this._slots.set(slot, entry);
    }

    const keys = entry.keys ?? Object.keys(shape);
    let changed = entry.geometry === null || entry.kind !== kind || entry.keys === null;
    if (!changed) {
      for (let i = 0; i < keys.length; i++) {
        if (+shape[keys[i]] !== entry.values[i]) {
          changed = true;
          break;
        }
      }
    }

    this.changed = changed;
    if (!changed) return entry.geometry;

    if (entry.keys === null) {
      entry.keys = keys;
      entry.values = new Float64Array(keys.length);
    }
    for (let i = 0; i < keys.length; i++) entry.values[i] = +shape[keys[i]];
    entry.kind = kind;
    entry.geometry?.dispose();
    entry.geometry = hardSurfaceGeometry(kind, shape);
    return entry.geometry;
  }

  dispose() {
    for (const entry of this._slots.values()) entry.geometry?.dispose();
    this._slots.clear();
  }
}

/* ====================================================================== */
/* §6 · GearTrain — the solver that makes the teeth mesh                  */
/* ====================================================================== */

/**
 * Canonical parameters for a gear train. Read fresh on every `solve()`.
 *
 * `teeth` is the interesting one: it is a *list of unitless counts* the nodes
 * draw from, and each node stored a 0..1 pick at plant time rather than a
 * count. Edit the list — with the clock stopped — and every gear re-teeths,
 * re-sizes, re-spaces and re-phases in the same frame, still meshed. That is
 * the roster's "stays interlocked when you drag the ratios", and it only works
 * because nothing about a node is resolved until this object is read.
 */
export function gearTrainParams() {
  return {
    origin: null, // Vector3 on the floor — the first gear's centre
    direction: null, // Vector3, unit, flat: bearing zero
    side: null, // Vector3, unit, lateral
    module: 0.16, // METRES of pitch diameter per tooth — the mesh condition
    addendum: 1.0, // × module; must match the gear shape's `addendum`
    teeth: null, // number[] of unitless tooth counts; defaults to [10, 14, 18]
    spin: 1.6, // radians/second of the root gear
    time: 0, // seconds — the ability's age
    phase: 0, // 0..1 turns of the root gear at time zero
    bearingSpread: 0.13, // ± turns each link may wander off the previous bearing
    bearingBias: 0, // turns added to every link — curls the train
    lift: 0.02, // metres the gears float above the floor
    reverse: false // run the whole train backwards; a mode, not a dimension
  };
}

const DEFAULT_TEETH = [10, 14, 18];

/**
 * A chain of meshing spur gears.
 *
 * The two pieces of arithmetic worth stating, because getting either wrong is
 * the failure everybody ships — teeth that pass straight through each other:
 *
 * **Spacing.** Two involute gears of the same module mesh at the standard
 * centre distance `d = m(z₁ + z₂)/2`, which is exactly the sum of their pitch
 * radii. Not their tip radii, which is the tempting wrong answer and leaves a
 * visible gap of one whole tooth height.
 *
 * **Phase.** Rate alone is not enough. Two gears turning at the perfect
 * ratio still interpenetrate unless a tooth of one is aimed at a *gap* of the
 * other along the line of centres, and that is a constraint on the absolute
 * angles, not on their derivatives. Number the teeth of gear *i* from its body
 * angle: a tooth points along bearing `β` when `zᵢ(β − θᵢ)/2π` is an integer.
 * Requiring gear 1's tooth index along `β` and gear 2's along `β + π` to sum
 * to a half-integer gives
 *
 *     θ₂ = β + π + (z₁/z₂)(β − θ₁) − π/z₂
 *
 * and differentiating it recovers `ω₂ = −(z₁/z₂)ω₁` for free — which is the
 * check that the constraint is the right one. The first version of this class
 * set the rates from the tooth counts and left the phases at zero, and it was
 * *nearly* right: the train counter-rotated correctly and the teeth ground
 * straight through one another, which is a bug you can watch for a full minute
 * before you see it.
 *
 * Because the phase is solved rather than integrated, a paused train re-phases
 * under the sliders and a train started at `time = 0` is identical every cast.
 *
 * @example
 *   const train = new GearTrain({ capacity: 10 });
 *   train.plant(6, seed);          // onSpawn — the only dice roll
 *   train.solve(params);           // every frame, including dt = 0
 */
export class GearTrain {
  constructor(options = {}) {
    const { capacity = 12 } = options;
    this.capacity = Math.max(1, Math.round(capacity));

    /** Dice only. A metre in here would be invariant I1 broken in one line. */
    this._nodes = [];
    for (let i = 0; i < this.capacity; i++) {
      this._nodes.push({
        teethRoll: 0, // 0..1 pick into the live `teeth` list
        bearingRoll: 0 // -1..1 of the live `bearingSpread`
      });
    }

    this._count = 0;
    // Resolved every solve(): parallel arrays, never reallocated.
    this._teeth = new Int32Array(this.capacity);
    this._pitch = new Float64Array(this.capacity);
    this._tip = new Float64Array(this.capacity);
    this._angle = new Float64Array(this.capacity);
    this._rate = new Float64Array(this.capacity);
    this._u = new Float64Array(this.capacity); // 2D position along `direction`
    this._v = new Float64Array(this.capacity); // 2D position along `side`
    this._bearing = new Float64Array(this.capacity);
    this._handed = -1;
    this._lift = 0;
  }

  /** Gears currently in the train. */
  get count() {
    return this._count;
  }

  /**
   * Roll a fresh train. Call from `onSpawn()`. The only dice in the class.
   *
   * @param {number} count  gears, clamped to capacity
   * @param {number} seed   any number; the same seed gives the same train
   */
  plant(count, seed = Math.random() * 100) {
    this._count = clamp(Math.round(count), 0, this.capacity);
    for (let i = 0; i < this._count; i++) {
      const node = this._nodes[i];
      node.teethRoll = hash11(seed * 7.13 + i * 3.77);
      node.bearingRoll = hash11(seed * 2.91 + i * 9.41) * 2 - 1;
    }
    return this._count;
  }

  /** Forget the train; leaves the instance reusable. */
  clear() {
    this._count = 0;
  }

  /**
   * Resolve every metre, radian and second from `p`. Call every frame.
   *
   * @param {object} p  see `gearTrainParams()`
   */
  solve(p) {
    const teethList = Array.isArray(p.teeth) && p.teeth.length ? p.teeth : DEFAULT_TEETH;
    const module = Math.max(p.module ?? 0.16, 1e-4);
    const addendum = p.addendum ?? 1;
    const spread = (p.bearingSpread ?? 0.13) * TAU;
    const bias = (p.bearingBias ?? 0) * TAU;
    const spin = (p.spin ?? 1.6) * (p.reverse ? -1 : 1);
    const time = p.time ?? 0;
    this._lift = p.lift ?? 0;

    const direction = p.direction;
    const side = p.side;
    // Handedness of the caller's basis decides the sign of the yaw we hand
    // back; the 2D solve itself is blind to it. See `yawOf`.
    this._handed =
      direction && side ? Math.sign(direction.z * side.x - direction.x * side.z) || -1 : -1;

    let bearing = 0;
    for (let i = 0; i < this._count; i++) {
      const node = this._nodes[i];
      const pick = clamp(Math.floor(node.teethRoll * teethList.length), 0, teethList.length - 1);
      const teeth = Math.max(4, Math.round(teethList[pick]));
      this._teeth[i] = teeth;
      this._pitch[i] = (module * teeth) / 2;
      this._tip[i] = this._pitch[i] + addendum * module;

      if (i === 0) {
        this._u[0] = 0;
        this._v[0] = 0;
        this._bearing[0] = 0;
        this._angle[0] = (p.phase ?? 0) * TAU + spin * time;
        this._rate[0] = spin;
        continue;
      }

      bearing += bias + node.bearingRoll * spread;
      this._bearing[i] = bearing;

      // Standard centre distance: the sum of the PITCH radii.
      const distance = this._pitch[i - 1] + this._pitch[i];
      this._u[i] = this._u[i - 1] + Math.cos(bearing) * distance;
      this._v[i] = this._v[i - 1] + Math.sin(bearing) * distance;

      const zPrev = this._teeth[i - 1];
      const ratio = zPrev / teeth;
      this._angle[i] = bearing + Math.PI + ratio * (bearing - this._angle[i - 1]) - Math.PI / teeth;
      this._rate[i] = -ratio * this._rate[i - 1];
    }
  }

  /** Tooth count of gear `i`, resolved this frame. */
  teethOf(i) {
    return this._teeth[i];
  }

  /** Pitch radius in metres. Two meshing gears sit exactly this far apart, summed. */
  pitchRadiusOf(i) {
    return this._pitch[i];
  }

  /** Tip radius in metres — half the footprint the instance scale must produce. */
  tipRadiusOf(i) {
    return this._tip[i];
  }

  /**
   * Uniform instance scale for a unit-space gear, in metres.
   *
   * Pass `gearPitchFraction(shape)` and it is exact for any profile,
   * including one whose teeth have gone pointed and whose outer radius is
   * therefore short of `pitch + addendum`. Pass nothing and you get the
   * nominal tip diameter, which is right for every profile that has not.
   */
  scaleOf(i, pitchFraction = 0) {
    if (pitchFraction > 1e-6) return (this._pitch[i] * 2) / pitchFraction;
    return this._tip[i] * 2;
  }

  /** Body angle in the solver's own 2D frame, radians. */
  angleOf(i) {
    return this._angle[i];
  }

  /** Angular rate in radians/second — signed, and alternating down the train. */
  rateOf(i) {
    return this._rate[i];
  }

  /**
   * The Y rotation to write into the instance, radians.
   *
   * The 2D solve measures angles from `direction` toward `side`; whether that
   * is a positive rotation about world +Y depends on which way round the
   * ability built its basis, so the sign is recovered from the basis itself
   * every frame rather than assumed. An involute tooth is symmetric about its
   * own centreline, so the mirrored train still meshes — only the sign of the
   * spin would have been visible, and it would have been visible as gears
   * turning the wrong way against a floor scour that turned the right way.
   */
  yawOf(i) {
    return this._handed * this._angle[i];
  }

  /** World centre of gear `i`. Writes and returns `out`. */
  positionOf(i, p, out) {
    out.set(0, 0, 0);
    if (p.origin) out.copy(p.origin);
    if (p.direction) out.addScaledVector(p.direction, this._u[i]);
    if (p.side) out.addScaledVector(p.side, this._v[i]);
    out.y += this._lift;
    return out;
  }

  /**
   * The pitch point between gear `i` and gear `i − 1` — where the teeth
   * actually touch, and therefore where sparks, dust and a light belong.
   *
   * It is *not* the midpoint unless the two gears are the same size: it
   * divides the centre distance in the ratio of the pitch radii.
   */
  contactOf(i, p, out) {
    if (i <= 0) return this.positionOf(0, p, out);
    const a = this._pitch[i - 1];
    const b = this._pitch[i];
    const t = a + b > 1e-9 ? a / (a + b) : 0.5;
    this.positionOf(i - 1, p, out);
    this.positionOf(i, p, _v3a);
    return out.lerp(_v3a, t);
  }
}

/* ====================================================================== */
/* §7 · The material                                                      */
/* ====================================================================== */

/** Which way the brushing runs. A mode, safe to capture. */
export const BrushMode = Object.freeze({
  /** Straight, along `brushAxis`. Plates, blades, anything rolled or ground flat. */
  LINEAR: 0,
  /** Round the axis. Gears, collars, anything that came off a lathe. */
  CIRCUMFERENTIAL: 1,
  /** Out from the axis. Fly-cut faces, the top of an anvil. */
  RADIAL: 2
});

export const BRUSH_MODE_NAMES = Object.freeze(['LINEAR', 'CIRCUMFERENTIAL', 'RADIAL']);

/**
 * Canonical parameters for the material. Every one is read on every `sync()`.
 *
 * Temperatures are in **kelvin** and they are real: 300 K is a cold workshop,
 * 900 K is the first visible red in a dark room, 1150 K is cherry, 1450 K is
 * forging heat, 1700 K is where steel starts to throw sparks and burn. The
 * ramp between them is not authored (see `blackbodyGLSL`), which is why there
 * is no `colorHot` picker here and why there should not be one — the whole
 * value of the term is that nobody gets to place the yellow.
 */
export function hardSurfaceParams() {
  return {
    /* --- the metal --- */
    colorMetal: '#9aa1a9', // clean steel
    colorDeep: '#3d4248', // the bottom of a pit
    colorScale: '#2b2723', // mill scale, the blue-black oxide off the forge
    colorPolish: '#e6edf5', // a worn edge, where the file has been
    colorSpec: '#fff3e2', // the anisotropic highlight's own colour
    roughness: 0.36, // base, before grain / pitting / wear
    metalness: 0.94,
    envIntensity: 1.0, // HDR probe gain

    /* --- brushing --- */
    brush: BrushMode.CIRCUMFERENTIAL,
    brushAxisX: 0, // the part's own axis in LOCAL space; unit-space geometry
    brushAxisY: 1, //   is seated with its axis along +Y, so this is the default
    brushAxisZ: 0,
    anisotropy: 0.78, // 0 round highlight, 1 fully smeared along the grain
    specular: 1.5, // gain on the anisotropic lobe
    grain: 0.55, // how hard the brushing cuts into roughness
    grainScale: 90, // grain frequency, cycles per unit of local space
    grainStretch: 24, // how far a streak runs along the brush direction

    /* --- surface history --- */
    scale: 0.3, // mill scale coverage, 0..1
    scaleScale: 6.5, // its patch size
    scaleSharp: 0.55, // 0 a smear, 1 a hard flake edge
    pit: 0.35, // casting pits and corrosion
    pitScale: 55,
    wear: 0.6, // how bright the machined edges come up
    wearGrain: 0.4, // how much the grain breaks the wear up

    /* --- heat --- */
    heat: 0, // 0..1 — the ONE control quench drives
    heatCold: 300, // kelvin at heat = 0 — a cold workshop
    heatHot: 2000, // kelvin at heat = 1 — welding heat, past the point steel burns
    heatRef: 1250, // kelvin at which the emission term reaches 1
    heatExponent: 4, // Stefan-Boltzmann; 4 is the physical value
    heatGlow: 2.4, // gain on the emission
    heatTint: 0.8, // how far the albedo washes toward the hot colour
    heatEdge: 0.22, // how much cooler an edge is — thin sections radiate faster

    /* --- globals, folded in by the ability --- */
    glow: 1, // settings.global.glow
    shaderIntensity: 1, // settings.global.shaderIntensity
    noiseFrequency: 1 // settings.global.noiseFrequency
  };
}

/**
 * The brushing tangent, in local space. Shared by both shader stages.
 *
 * It has to be shared: the vertex stage needs the tangent to transform into
 * view space for the specular lobe, and the fragment stage needs the same
 * direction in local space to squash the grain noise along. Computing them
 * from two copies of the maths is how you get a highlight that runs at a
 * slight angle to the streaks it is supposed to be lying in, which looks like
 * a bug in the noise and is not.
 */
const brushGLSL = /* glsl */ `
uniform float uBrushMode;
uniform vec3  uBrushAxis;

vec3 hardBrushDir(vec3 localPos) {
  vec3 axis = uBrushAxis;
  float len = length(axis);
  axis = len > 1e-5 ? axis / len : vec3(0.0, 1.0, 0.0);
  vec3 t;
  if (uBrushMode < 0.5) {
    t = axis;
  } else if (uBrushMode < 1.5) {
    t = cross(axis, localPos);
  } else {
    t = localPos - axis * dot(localPos, axis);
  }
  // On the axis itself both of the derived modes collapse. Any consistent
  // direction will do there, because there is no surface there either.
  float tl = length(t);
  return tl > 1e-5 ? t / tl : normalize(cross(axis, vec3(0.371, 0.629, 0.812)));
}
`;

/**
 * Blackbody colour on the Planckian locus, and the emission that goes with it.
 *
 * Kim et al. (2002)'s cubic fit gives CIE `x` from the temperature and a
 * second cubic gives `y` from `x`; `xyY → XYZ → linear sRGB` finishes the job.
 * That is a real locus rather than four authored stops, and the difference is
 * visible in one specific place: the yellow. An authored white→orange gradient
 * passes through a yellow that is too saturated and slightly green, because
 * the straight line in RGB between white and orange does not follow the curve
 * the locus takes. Steel cooling through 1400 K goes pale straw, not lemon.
 *
 * **Kim's fit stops at 1667 K and every temperature this material cares about
 * is below it**, which is the trap. 1667 K is bright orange; forging heat is
 * 1450 K, the first visible red is 900 K, and a quench spends its whole life
 * under the fit. Clamping there — the first version — gave one flat orange
 * across the entire ramp that simply dimmed, and a quench that dims is not a
 * quench.
 *
 * Extrapolating the cubic instead is worse and is spectacular: below about
 * 1200 K `x` runs off past the spectral locus, `y` collapses, and the metal
 * cools through cherry into *magenta* and then into a colour that does not
 * exist. So the low end gets its own fit — a quadratic in `1000/T` through
 * the published locus points at 1667 K, 1000 K and 800 K, which lands within
 * 0.005 of the true chromaticity at 1200 K. The `y` cubic needs no such
 * treatment: it is a fit in `x` rather than in `T` and it tracks the locus to
 * within 0.004 all the way down, which is worth knowing before anybody
 * "fixes" it.
 *
 * The quadratic turns over at its vertex, 693 K, so the whole thing is clamped
 * at 700 K. There is nothing down there: the `T⁴` term is 0.001 of the
 * reference and the metal is black, which is exactly what the eye and a long
 * exposure both report.
 *
 * The emission is `(T / T_ref)^n` with `n = 4` from Stefan-Boltzmann. It is a
 * slider because the *visible* fraction rises faster than the total does —
 * Wien's peak is still deep in the infrared at forging heat, so the visible
 * tail grows more like `T⁶` over this range — and a director who wants the
 * quench to snap out faster should be able to say so.
 */
const blackbodyGLSL = /* glsl */ `
vec3 hardBlackbody(float kelvin) {
  float t = clamp(kelvin, 700.0, 25000.0);
  float i1 = 1.0 / t;
  float i2 = i1 * i1;
  float i3 = i2 * i1;

  float x;
  if (t < 1667.0) {
    // Below Kim's range: the low-temperature locus, fitted in 1000/T.
    float u = 1000.0 * i1;
    x = 0.32933 + 0.495206 * u - 0.171736 * u * u;
  } else if (t < 4000.0) {
    x = -0.2661239e9 * i3 - 0.2343589e6 * i2 + 0.8776956e3 * i1 + 0.179910;
  } else {
    x = -3.0258469e9 * i3 + 2.1070379e6 * i2 + 0.2226347e3 * i1 + 0.240390;
  }

  float x2 = x * x;
  float x3 = x2 * x;
  float y;
  // Kim's y is a fit in x, not in T, and it holds well past the end of the
  // x fit it was published with — which is why the low branch above only had
  // to replace x.
  if (t < 2222.0) {
    y = -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683;
  } else if (t < 4000.0) {
    y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  } else {
    y = 3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483;
  }

  y = max(y, 1e-3);
  float bigY = 1.0;
  float bigX = (x / y) * bigY;
  float bigZ = ((1.0 - x - y) / y) * bigY;

  vec3 rgb = vec3(
     3.2404542 * bigX - 1.5371385 * bigY - 0.4985314 * bigZ,
    -0.9692660 * bigX + 1.8760108 * bigY + 0.0415560 * bigZ,
     0.0556434 * bigX - 0.2040259 * bigY + 1.0572252 * bigZ
  );
  rgb = max(rgb, vec3(0.0));
  // Normalise the hue; the brightness is the T^4 term's job, not the locus's.
  return rgb / max(max(rgb.r, max(rgb.g, rgb.b)), 1e-4);
}
`;

/**
 * The same locus on the CPU, for a light colour or a particle tint.
 *
 * Sparks off hot steel are the same temperature as the steel, so the one
 * number that drives the metal should drive them too — hard-coding an orange
 * for the sparks is how a quench ends up with cherry-red metal throwing
 * lemon-yellow sparks.
 *
 * @param {number} kelvin
 * @param {THREE.Color} [out]
 */
export function blackbodyColor(kelvin, out = _colorScratch) {
  const t = clamp(kelvin, 700, 25000);
  const i1 = 1 / t;
  const i2 = i1 * i1;
  const i3 = i2 * i1;
  let x;
  if (t < 1667) {
    const u = 1000 * i1;
    x = 0.32933 + 0.495206 * u - 0.171736 * u * u;
  } else if (t < 4000) {
    x = -0.2661239e9 * i3 - 0.2343589e6 * i2 + 0.8776956e3 * i1 + 0.17991;
  } else {
    x = -3.0258469e9 * i3 + 2.1070379e6 * i2 + 0.2226347e3 * i1 + 0.24039;
  }
  const x2 = x * x;
  const x3 = x2 * x;
  let y;
  if (t < 2222) y = -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683;
  else if (t < 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  else y = 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  y = Math.max(y, 1e-3);

  const bigX = x / y;
  const bigZ = (1 - x - y) / y;
  let r = 3.2404542 * bigX - 1.5371385 - 0.4985314 * bigZ;
  let g = -0.969266 * bigX + 1.8760108 + 0.041556 * bigZ;
  let b = 0.0556434 * bigX - 0.2040259 + 1.0572252 * bigZ;
  r = Math.max(r, 0);
  g = Math.max(g, 0);
  b = Math.max(b, 0);
  const peak = Math.max(r, g, b, 1e-4);
  out.setRGB(r / peak, g / peak, b / peak);
  return out;
}

/**
 * Temperature in kelvin for a 0..1 heat, matching the shader exactly.
 *
 * Use it when you need the *same* number the metal is using — a light's
 * colour, a spark's tint, the emissive strength of a decal underneath.
 */
export function heatToKelvin(heat, p) {
  const cold = p?.heatCold ?? 300;
  const hot = p?.heatHot ?? 2000;
  return cold + (hot - cold) * saturate(heat);
}

/**
 * Brushed anisotropic steel with a blackbody ramp, on a real
 * `MeshStandardMaterial`.
 *
 * ### Why the anisotropy is hand-rolled
 *
 * `MeshPhysicalMaterial` has had native anisotropy since r155 and it is
 * better than this one. It is also unreachable here: it reads its direction
 * from the tangent frame, which three only switches on (`USE_TANGENT`)
 * alongside a **normal map** — and a normal map is a texture, which invariant
 * I2 forbids outright. Supplying a `tangent` attribute without the map leaves
 * the define off and the anisotropy silently isotropic, which is exactly the
 * failure that cost the afternoon: the material compiled, `material.anisotropy
 * = 0.8` was set, and nothing whatsoever changed on screen.
 *
 * So the lobe is a **Ward** anisotropic specular, evaluated against the
 * stage's key light (`frame.uLightDir`) with the tangent carried through from
 * the vertex stage, and added to `totalEmissiveRadiance`. Two honest
 * consequences, neither worth fixing:
 *
 *  - it is not shadowed, because the injection point is before the light loop
 *    and the shadow factor does not exist yet. On a spinning gear at forge
 *    temperature nobody has ever noticed;
 *  - it is one light. The stage has one key light and the rest is probe.
 *
 * The tangent is transformed by `mat3(modelViewMatrix)`, **not** by
 * `normalMatrix`. A tangent is a direction *along* the surface and transforms
 * like a position difference; the inverse-transpose is for normals. It matters
 * here more than usual because `GrowthField` scales footprint and height
 * independently, so a squat gear is genuinely non-uniformly scaled and the two
 * matrices disagree by a visible amount.
 *
 * ### What each surface term is doing
 *
 * | term | roughness | metalness | albedo | emissive |
 * | --- | --- | --- | --- | --- |
 * | grain | ± streaks along the brush | — | — | modulates the lobe |
 * | pitting | up | — | toward `colorDeep` | — |
 * | mill scale | up | **down** — oxide is a dielectric | toward `colorScale` | kills the lobe |
 * | edge wear | down | — | toward `colorPolish` | lifts the lobe |
 * | heat | — | — | toward the blackbody colour | `(T/T_ref)⁴` |
 *
 * The metalness drop under mill scale is the one that earns its line: scale is
 * an oxide, oxides are not conductors, and a scaled patch that keeps
 * `metalness = 0.94` reads as a dirty mirror instead of as a crust.
 *
 * ### Attributes it reads
 *
 * | attribute | source | meaning |
 * | --- | --- | --- |
 * | `aEdge` | this module's generators | 1 on a machined edge, 0 on a face |
 * | `aHeat` | yours, instanced, optional | added to `heat` per instance |
 *
 * Both default to zero when absent, which is why `aHeat` is an **offset**
 * rather than an absolute: an unset attribute reads as 0 in WebGL, and an
 * absolute would mean every mesh without one was ice cold.
 *
 * @param {object} [options]
 * @param {object} [options.environment] `world/Environment.js`; routes through
 *        `registerShadowCasterWithPatch` so CSM's own patch is not clobbered
 * @param {boolean} [options.flatShading=false]
 * @returns {THREE.MeshStandardMaterial} with `userData.uniforms` and `userData.sync`
 */
export function createHardSurfaceMaterial(options = {}) {
  const { environment = null, flatShading = false } = options;

  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.36,
    metalness: 0.94,
    flatShading
  });

  const uniforms = {
    uTime: frame.uTime,
    uLightDir: frame.uLightDir,
    uColorMetal: { value: new Color('#9aa1a9') },
    uColorDeep: { value: new Color('#3d4248') },
    uColorScale: { value: new Color('#2b2723') },
    uColorPolish: { value: new Color('#e6edf5') },
    uColorSpec: { value: new Color('#fff3e2') },
    uBrushMode: { value: BrushMode.CIRCUMFERENTIAL },
    uBrushAxis: { value: new Vector3(0, 1, 0) },
    uAniso: { value: 0.78 },
    uSpecular: { value: 1.5 },
    uGrain: { value: 0.55 },
    uGrainScale: { value: 90 },
    uGrainStretch: { value: 24 },
    uScale: { value: 0.3 },
    uScaleScale: { value: 6.5 },
    uScaleSharp: { value: 0.55 },
    uPit: { value: 0.35 },
    uPitScale: { value: 55 },
    uWear: { value: 0.6 },
    uWearGrain: { value: 0.4 },
    uHeat: { value: 0 },
    uHeatCold: { value: 300 },
    uHeatHot: { value: 2000 },
    uHeatRef: { value: 1250 },
    uHeatExponent: { value: 4 },
    uHeatGlow: { value: 2.4 },
    uHeatTint: { value: 0.8 },
    uHeatEdge: { value: 0.22 }
  };

  const patch = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = replaceChunk(
      shader.vertexShader,
      '#include <common>',
      `#include <common>
       attribute float aEdge;
       attribute float aHeat;
       varying vec3  vHardLocal;
       varying vec3  vHardTangent;
       varying float vHardEdge;
       varying float vHardHeat;
       ${brushGLSL}`
    );

    shader.vertexShader = replaceChunk(
      shader.vertexShader,
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vHardLocal = transformed;
       vHardEdge  = aEdge;
       vHardHeat  = aHeat;
       {
         vec3 hardT = hardBrushDir(transformed);
         #ifdef USE_INSTANCING
           hardT = mat3(instanceMatrix) * hardT;
         #endif
         // modelViewMatrix, NOT normalMatrix — see the header.
         vHardTangent = mat3(modelViewMatrix) * hardT;
       }`
    );

    shader.fragmentShader = replaceChunk(
      shader.fragmentShader,
      '#include <common>',
      `#include <common>
       uniform vec3  uColorMetal;
       uniform vec3  uColorDeep;
       uniform vec3  uColorScale;
       uniform vec3  uColorPolish;
       uniform vec3  uColorSpec;
       uniform vec3  uLightDir;
       uniform float uAniso;
       uniform float uSpecular;
       uniform float uGrain;
       uniform float uGrainScale;
       uniform float uGrainStretch;
       uniform float uScale;
       uniform float uScaleScale;
       uniform float uScaleSharp;
       uniform float uPit;
       uniform float uPitScale;
       uniform float uWear;
       uniform float uWearGrain;
       uniform float uHeat;
       uniform float uHeatCold;
       uniform float uHeatHot;
       uniform float uHeatRef;
       uniform float uHeatExponent;
       uniform float uHeatGlow;
       uniform float uHeatTint;
       uniform float uHeatEdge;
       varying vec3  vHardLocal;
       varying vec3  vHardTangent;
       varying float vHardEdge;
       varying float vHardHeat;
       ${noiseGLSL}
       ${brushGLSL}
       ${blackbodyGLSL}

       /* Filled once per fragment by hardResolve(), read by three chunks.
          Globals rather than a struct returned three times over: the grain is
          four octaves of noise and paying for it in <roughnessmap_fragment>,
          again in <metalnessmap_fragment> and again after
          <emissivemap_fragment> was measurably the most expensive line in the
          material. */
       float hardGrainV;
       float hardPitV;
       float hardScaleV;
       float hardWearV;

       void hardResolve() {
         vec3 t = hardBrushDir(vHardLocal);
         vec3 q = vHardLocal * uGrainScale;
         // Squash the sample along the brush so the noise draws streaks that
         // run WITH the grain. The first version scaled the whole coordinate
         // and produced a uniform sandblast: correct roughness statistics,
         // no direction, and therefore no read at all.
         float stretch = max(uGrainStretch, 1.0);
         q += t * dot(q, t) * (1.0 / stretch - 1.0);
         hardGrainV = fbm3(q);

         hardPitV = smoothstep(0.42, 0.95, ridged(vHardLocal * uPitScale, 4));

         float flake = fbm3(vHardLocal * uScaleScale + 17.3) * 0.5 + 0.5;
         float edgeW = mix(0.34, 0.03, clamp(uScaleSharp, 0.0, 1.0));
         hardScaleV = smoothstep(0.5 - edgeW, 0.5 + edgeW, flake);

         // The grain breaks the wear up so a chamfer is a broken glint rather
         // than a drawn line, which is the tell of a bevel modifier.
         hardWearV = clamp(vHardEdge * (1.0 - clamp(uWearGrain, 0.0, 1.0) * (hardGrainV * 0.5 + 0.5)), 0.0, 1.0);
       }`
    );

    shader.fragmentShader = replaceChunk(
      shader.fragmentShader,
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
       hardResolve();
       roughnessFactor = clamp(
         roughnessFactor
           + hardGrainV * uGrain * 0.22
           + hardPitV * uPit * 0.4
           + hardScaleV * uScale * 0.4
           - hardWearV * uWear * 0.28,
         0.035, 1.0);`
    );

    shader.fragmentShader = replaceChunk(
      shader.fragmentShader,
      '#include <metalnessmap_fragment>',
      `#include <metalnessmap_fragment>
       metalnessFactor = clamp(metalnessFactor - hardScaleV * uScale * 0.6, 0.0, 1.0);`
    );

    shader.fragmentShader = replaceChunk(
      shader.fragmentShader,
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       {
         vec3 body = uColorMetal;
         body = mix(body, uColorDeep, hardPitV * clamp(uPit, 0.0, 1.0));
         body = mix(body, uColorScale, hardScaleV * clamp(uScale, 0.0, 1.0));
         body = mix(body, uColorPolish, hardWearV * clamp(uWear, 0.0, 1.0) * 0.7);

         /* --- anisotropic specular, Ward, one key light --- */
         vec3 N = normalize(normal);
         vec3 V = normalize(vViewPosition);
         vec3 L = normalize((viewMatrix * vec4(uLightDir, 0.0)).xyz);
         vec3 X = vHardTangent - N * dot(vHardTangent, N);
         float xl = length(X);
         X = xl > 1e-4 ? X / xl : normalize(cross(N, vec3(0.0, 0.0, 1.0)) + vec3(1e-4));
         vec3 B = cross(N, X);

         float ndl = dot(N, L);
         float ward = 0.0;
         if (ndl > 0.0) {
           vec3 H = normalize(L + V);
           float ndv = max(dot(N, V), 1e-3);
           float ndh = max(dot(N, H), 1e-3);
           float rough = clamp(roughnessFactor, 0.03, 1.0);
           float alpha = rough * rough;
           float aspect = sqrt(1.0 - 0.9 * clamp(uAniso, 0.0, 1.0));
           float ax = max(alpha / max(aspect, 1e-3), 2e-3);
           float ay = max(alpha * aspect, 2e-3);
           float hx = dot(H, X) / ax;
           float hy = dot(H, B) / ay;
           ward = exp(-(hx * hx + hy * hy) / (ndh * ndh)) /
                  (4.0 * PI * ax * ay * sqrt(max(ndl * ndv, 1e-4)));
           // Ward has no shadowing term and goes to infinity at grazing.
           ward = min(ward, 24.0) * ndl;
         }
         ward *= (1.0 - hardScaleV * clamp(uScale, 0.0, 1.0) * 0.85);
         ward *= 1.0 + hardWearV * clamp(uWear, 0.0, 1.0) * 0.6;

         /* --- blackbody --- */
         // Edges run cooler: a chamfer has more surface per unit of steel
         // behind it, so it is the first thing to go black in a quench and the
         // last thing to come up in a fire.
         float heat = clamp(uHeat + vHardHeat - vHardEdge * uHeatEdge, 0.0, 1.0);
         float kelvin = mix(uHeatCold, uHeatHot, heat);
         vec3 hot = hardBlackbody(kelvin);
         float emit = pow(max(kelvin, 1.0) / max(uHeatRef, 1.0), max(uHeatExponent, 0.1));

         body = mix(body, hot, clamp(emit * uHeatTint, 0.0, 1.0));
         diffuseColor.rgb *= body;

         vec3 glow = hot * emit * uHeatGlow;
         glow += uColorSpec * ward * uSpecular;
         // Reinhard ceiling, as in IceMaterial: forging heat and a specular
         // hit land on the same pixel constantly and the sum runs past 30.
         glow /= 1.0 + glow * 0.2;

         totalEmissiveRadiance += glow;
       }`
    );
  };

  if (environment) environment.registerShadowCasterWithPatch(material, patch);
  else patchOnBeforeCompile(material, patch);

  // The convention the harness's pause test looks for. Without this, thirty
  // working sliders are reported as dead.
  material.userData.uniforms = uniforms;
  material.userData.sync = (p) => syncHardSurfaceMaterial(material, p);
  return material;
}

/** Memoised colour writes — `getColor` caches, this avoids even the map hit. */
function writeColor(uniform, hex, cacheKey, cache) {
  if (cache[cacheKey] === hex) return;
  cache[cacheKey] = hex;
  uniform.value.copy(getColor(hex));
}

/**
 * Push a params object into a material built by `createHardSurfaceMaterial`.
 *
 * Call it **every frame**, including a zero-length one. Nothing here is
 * cached against time, so a paused ingot cools under the `heat` slider and a
 * paused gear re-brushes under `grainScale`.
 */
export function syncHardSurfaceMaterial(material, p = {}) {
  const u = material.userData.uniforms;
  if (!u) return material;
  const cache = (material.userData.colorCache ??= {});

  const glow = p.glow ?? 1;
  const intensity = p.shaderIntensity ?? 1;
  const frequency = p.noiseFrequency ?? 1;

  writeColor(u.uColorMetal, p.colorMetal ?? '#9aa1a9', 'metal', cache);
  writeColor(u.uColorDeep, p.colorDeep ?? '#3d4248', 'deep', cache);
  writeColor(u.uColorScale, p.colorScale ?? '#2b2723', 'scale', cache);
  writeColor(u.uColorPolish, p.colorPolish ?? '#e6edf5', 'polish', cache);
  writeColor(u.uColorSpec, p.colorSpec ?? '#fff3e2', 'spec', cache);

  u.uBrushMode.value = p.brush ?? BrushMode.CIRCUMFERENTIAL;
  u.uBrushAxis.value.set(p.brushAxisX ?? 0, p.brushAxisY ?? 1, p.brushAxisZ ?? 0);
  u.uAniso.value = saturate(p.anisotropy ?? 0.78);
  u.uSpecular.value = (p.specular ?? 1.5) * intensity;
  u.uGrain.value = (p.grain ?? 0.55) * intensity;
  u.uGrainScale.value = (p.grainScale ?? 90) * frequency;
  u.uGrainStretch.value = Math.max(p.grainStretch ?? 24, 1);
  u.uScale.value = saturate(p.scale ?? 0.3);
  u.uScaleScale.value = (p.scaleScale ?? 6.5) * frequency;
  u.uScaleSharp.value = saturate(p.scaleSharp ?? 0.55);
  u.uPit.value = saturate(p.pit ?? 0.35);
  u.uPitScale.value = (p.pitScale ?? 55) * frequency;
  u.uWear.value = saturate(p.wear ?? 0.6);
  u.uWearGrain.value = saturate(p.wearGrain ?? 0.4);

  u.uHeat.value = saturate(p.heat ?? 0);
  u.uHeatCold.value = Math.max(p.heatCold ?? 300, 1);
  u.uHeatHot.value = Math.max(p.heatHot ?? 2000, u.uHeatCold.value + 1);
  u.uHeatRef.value = Math.max(p.heatRef ?? 1250, 1);
  u.uHeatExponent.value = Math.max(p.heatExponent ?? 4, 0.1);
  u.uHeatGlow.value = (p.heatGlow ?? 2.4) * glow;
  u.uHeatTint.value = saturate(p.heatTint ?? 0.8);
  u.uHeatEdge.value = saturate(p.heatEdge ?? 0.22);

  material.roughness = clamp(p.roughness ?? 0.36, 0.02, 1);
  material.metalness = saturate(p.metalness ?? 0.94);
  material.envMapIntensity = p.envIntensity ?? 1;
  return material;
}

/* ====================================================================== */
/* §8 · GrindContact — sparks that leave at the tangent                   */
/* ====================================================================== */

/**
 * Canonical parameters for the grinding-spark solver.
 *
 * The speeds are the only awkward ones: they are metres per second, and they
 * are *derived* from the rim velocity the caller hands in, which is itself
 * derived from a live radius and a live spin rate. That chain never touches
 * the CPU's memory between frames, so it is I1-clean — the moment you cache a
 * rim speed at spawn it is not.
 */
export function grindParams() {
  return {
    lift: 0.05, // metres the jets start off the surface, along the normal
    bounce: 0.55, // 0..1 of the into-surface velocity that comes back out
    rise: 0.3, // 0..1 extra tilt away from the surface — the rooster tail
    speedGain: 0.55, // spark speed as a fraction of the rim speed
    speedFloor: 1.2, // metres/second, so a stalled blade still throws something
    speedCeiling: 26, // metres/second
    fan: 0.6, // radians the jets fan through, in the tangent/normal plane
    swing: 0.22, // radians of fan across it
    graze: 0.04, // sine of the shallowest angle a jet may leave the surface at
    jets: 5, // sub-directions per emission; each is one emit() call
    spread: 0.1, // handed straight to the particle system, per jet
    speedVariance: 0.5, // ditto
    drift: 0.12 // fraction of the rim velocity added as `inherit`
  };
}

/**
 * Turn a contact into spark emission parameters.
 *
 * ### The whole point
 *
 * A saw that throws sparks radially is a firework. Real grinding sparks leave
 * at the **contact tangent** — they are lumps of the workpiece that were
 * travelling with the tooth when it let go of them, so they carry off the
 * tooth's velocity, and the tooth's velocity at the rim is tangential by
 * definition. Point them along the wheel's radius and you have drawn a
 * dandelion; point them along `ω × r` and you have drawn an angle grinder,
 * from the same particle system with the same colours.
 *
 * The one correction on top of that: a tooth at the contact is usually driving
 * *into* the workpiece, so part of `ω × r` points below the surface. Sparks do
 * not tunnel. The component into the surface is reflected back out with a
 * restitution (`bounce`), and a little extra `rise` tilts the whole sheaf away
 * from the floor, which is what produces the arc every photograph of a grinder
 * shows. Both are sliders because the ratio between them is the difference
 * between a cut-off wheel and a bench grinder.
 *
 * ### Using it
 *
 * ```js
 * // once, at construction
 * this.grind = new GrindContact();
 * // every frame, after you know where the blade is touching
 * GrindContact.rimVelocity(_vel, _axis, spinRate, _contact, _centre);
 * this.grind.solve(_contact, _normal, _vel, this._grindParams);
 * for (let j = 0; j < this.grind.jets; j++) {
 *   this.grind.jet(j, _emit);
 *   _emit.time = this.age;
 *   _emit.tint = blackbodyColor(1900);
 *   this.sparks.emit(count, _emit);
 * }
 * ```
 *
 * `jet()` writes the caller's emit object and points its vectors at the
 * solver's own scratch. `ParticleSystem#emit` reads and never retains, which
 * is the contract that makes this allocation-free; do not keep the object.
 */
export class GrindContact {
  constructor() {
    this.origin = new Vector3();
    /** The deflected contact tangent — the sheaf's centreline. */
    this.direction = new Vector3();
    /** Unit surface normal, as handed in. */
    this.normal = new Vector3(0, 1, 0);
    /** Perpendicular to both — the axis the fan swings about. */
    this.binormal = new Vector3(1, 0, 0);
    /** Metres/second at the rim, before `speedGain`. */
    this.rimSpeed = 0;
    /** Metres/second the sparks actually leave at. */
    this.speed = 0;
    /** How many `jet()` calls this solve wants. */
    this.jets = 1;

    this._inherit = new Vector3();
    this._jet = new Vector3();
    this._spread = 0.1;
    this._variance = 0.5;
    this._fan = 0.6;
    this._swing = 0.22;
    this._graze = 0.04;
  }

  /**
   * The velocity of a point on a spinning rim: `v = ω × r`.
   *
   * Static because it is the caller's job to know where the blade is; this is
   * only the cross product, kept here so nobody writes it with the operands
   * the other way round, which produces sparks leaving backwards and looks
   * almost right.
   *
   * @param {THREE.Vector3} out
   * @param {THREE.Vector3} axis     spin axis, unit
   * @param {number} rate            radians/second, signed
   * @param {THREE.Vector3} point    the contact, world
   * @param {THREE.Vector3} centre   the hub, world
   */
  static rimVelocity(out, axis, rate, point, centre) {
    _v3a.copy(axis).normalize().multiplyScalar(rate);
    _v3b.copy(point).sub(centre);
    return out.copy(_v3a).cross(_v3b);
  }

  /**
   * Resolve one contact. Every metre and second comes out of `p`, every frame.
   *
   * @param {THREE.Vector3} contact  the touch point, world
   * @param {THREE.Vector3} normal   the *workpiece's* surface normal, world
   * @param {THREE.Vector3} rimVel   the tooth's velocity there, world, m/s
   * @param {object} p               see `grindParams()`
   */
  solve(contact, normal, rimVel, p = {}) {
    const lift = p.lift ?? 0.05;
    const bounce = saturate(p.bounce ?? 0.55);
    const rise = saturate(p.rise ?? 0.3);

    this.normal.copy(normal);
    if (this.normal.lengthSq() < 1e-8) this.normal.set(0, 1, 0);
    this.normal.normalize();

    this.rimSpeed = rimVel.length();
    this.origin.copy(contact).addScaledVector(this.normal, lift);

    // The tangent, with whatever was heading into the workpiece bounced back
    // out of it. `into` is negative when the tooth is driving downward.
    _v3c.copy(rimVel);
    const into = _v3c.dot(this.normal);
    if (into < 0) _v3c.addScaledVector(this.normal, -(1 + bounce) * into);
    if (_v3c.lengthSq() < 1e-10) _v3c.copy(this.normal);
    _v3c.normalize();
    // The rooster tail: tilt the whole sheaf off the surface.
    _v3c.addScaledVector(this.normal, rise).normalize();
    this.direction.copy(_v3c);

    _v3d.copy(this.normal).cross(this.direction);
    if (_v3d.lengthSq() < 1e-10) {
      // Sparks leaving straight along the normal have no preferred fan plane.
      _v3d.set(this.normal.y, this.normal.z, this.normal.x).cross(this.normal);
    }
    this.binormal.copy(_v3d).normalize();

    const gain = p.speedGain ?? 0.55;
    const floor = p.speedFloor ?? 1.2;
    const ceiling = p.speedCeiling ?? 26;
    this.speed = clamp(this.rimSpeed * gain, floor, Math.max(ceiling, floor));

    this._inherit.copy(rimVel).multiplyScalar(p.drift ?? 0.12);
    this.jets = Math.max(1, Math.round(p.jets ?? 5));
    this._fan = p.fan ?? 0.6;
    this._swing = p.swing ?? 0.22;
    this._graze = Math.max(p.graze ?? 0.04, 0);
    this._spread = p.spread ?? 0.1;
    this._variance = p.speedVariance ?? 0.5;
    return this;
  }

  /**
   * Fill an emit object for jet `index` of `this.jets`.
   *
   * The jets are spread deterministically across the fan rather than
   * randomly: a random fan re-rolls its shape every frame and the stream
   * shimmers, where a fixed fan with random *particles* inside it reads as one
   * continuous sheaf, which is what a grinder throws.
   */
  jet(index, emit) {
    const t = this.jets > 1 ? index / (this.jets - 1) - 0.5 : 0;
    const angle = t * this._fan;
    // Swing is hashed off the index so the sheaf is not a flat fan; it is the
    // same number every frame, so the sheaf itself does not flicker.
    const swing = (hash11(index * 12.9898 + 4.1) * 2 - 1) * this._swing;

    this._jet.copy(this.direction).applyAxisAngle(this.binormal, angle);
    this._jet.applyAxisAngle(this.normal, swing).normalize();

    // The fan sweeps in the plane containing the normal, so its flattest jet
    // can end up pointing *into* the workpiece — and a spark emitted into the
    // floor is a spark you never see, which reads as the stream thinning out
    // on one side for no reason. Lifting it back to a grazing angle is what
    // the surface would have done to it anyway.
    const under = this._graze - this._jet.dot(this.normal);
    if (under > 0) this._jet.addScaledVector(this.normal, under).normalize();

    emit.position = this.origin;
    emit.direction = this._jet;
    emit.speed = this.speed;
    emit.spread = this._spread;
    emit.speedVariance = this._variance;
    emit.inherit = this._inherit;
    return emit;
  }
}
