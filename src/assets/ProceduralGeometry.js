import {
  BufferGeometry,
  BufferAttribute,
  Float32BufferAttribute,
  IcosahedronGeometry,
  InstancedBufferGeometry,
  InstancedBufferAttribute,
  Sphere,
  Vector3
} from 'three';
import { clamp, hash11, smoothstep } from '../utils/math.js';

/**
 * CPU-side procedural geometry.
 *
 * The project ships no mesh assets beyond the character, so the ice crystals are
 * generated here. A crystal is cheap enough to rebuild — a six-sided one is 108
 * triangles — that the *shape* sliders in the editor regenerate it outright
 * instead of approximating themselves in a vertex shader. That is what lets the
 * facet count, the taper and the surface roughness stay live controls, including
 * while the simulation is paused.
 *
 * Everything is deterministic in `seed`: the same seed always yields the same
 * crystal, so a rebuild mid-cast reshapes the field without reshuffling it.
 */

const TAU = Math.PI * 2;

/**
 * Height / radius profile of a crystal, sampled at the ring heights below.
 * `t` is the fraction of the way to the tip; the returned radius is a fraction
 * of the base radius.
 */
const RING_HEIGHTS = [0, 0.22, 0.5, 0.75, 0.92];

function profileRadius(t, taper) {
  return taper + (1 - taper) * Math.pow(1 - t, 1.15);
}

/**
 * A single ice crystal: a tapered, faceted, slightly bent prism.
 *
 * Unit space — base ring on y = 0 with a circumscribed radius of 0.5, apex at
 * y = 1. An instance therefore scales footprint and height independently, and
 * `local.y` reads straight off as "how far up this crystal am I", which is what
 * the rime banding in `materials/IceMaterial.js` keys off.
 *
 * @param {object} options
 * @param {number} [options.seed]      deterministic shape seed
 * @param {number} [options.sides]     facet count around the prism (5–8 read best)
 * @param {number} [options.taper]     tip radius as a fraction of the base
 * @param {number} [options.roughness] how far facets are pushed off a clean prism
 * @param {number} [options.bend]      sideways curve from base to tip
 */
export function createCrystalGeometry({
  seed = 1,
  sides = 6,
  taper = 0.13,
  roughness = 0.28,
  bend = 0.22
} = {}) {
  const facets = Math.max(3, Math.round(sides));
  const tipRadius = Math.min(0.9, Math.max(0.01, taper));

  // One fixed bend direction per crystal, so a whole field leans convincingly
  // instead of every spike curving the same way.
  const bendAngle = hash11(seed * 1.77) * TAU;
  const bendX = Math.cos(bendAngle);
  const bendZ = Math.sin(bendAngle);

  /** Lateral drift of the crystal's axis at height `t`. */
  const axisOffset = (t) => bend * 0.5 * Math.pow(t, 1.6);

  // --- rings -------------------------------------------------------------
  // Angles are jittered once and shared by every ring, so the facets stay
  // continuous edges up the crystal rather than twisting into a screw.
  const angles = [];
  for (let i = 0; i < facets; i++) {
    const jitter = (hash11(seed * 3.13 + i * 7.7) - 0.5) * (TAU / facets) * 0.55 * roughness * 3;
    angles.push((i / facets) * TAU + jitter);
  }

  const rings = RING_HEIGHTS.map((t, ringIndex) => {
    const baseR = profileRadius(t, tipRadius) * 0.5;
    const drift = axisOffset(t);
    // Height wobble keeps the shoulder lines from stacking into clean bands.
    const y = t + (hash11(seed * 5.9 + ringIndex * 2.3) - 0.5) * 0.06 * roughness * (t > 0 ? 1 : 0);

    return angles.map((angle, i) => {
      // Irregularity grows toward the tip: a crystal is roughly round where it
      // leaves the ground and increasingly ragged where it was torn.
      const wobble = 1 + (hash11(seed * 11.1 + ringIndex * 13.7 + i * 3.9) - 0.5) * roughness * 1.3 * (0.35 + 0.65 * t);
      const r = Math.max(0.002, baseR * wobble);
      return [Math.cos(angle) * r + bendX * drift, y, Math.sin(angle) * r + bendZ * drift];
    });
  });

  // The apex is offset a little off-axis so the tip reads as chipped rather
  // than as the vertex of a cone.
  const apexDrift = axisOffset(1);
  const apex = [
    bendX * apexDrift + (hash11(seed * 17.3) - 0.5) * 0.09 * roughness,
    1,
    bendZ * apexDrift + (hash11(seed * 19.7) - 0.5) * 0.09 * roughness
  ];
  const floorCentre = [0, 0, 0];

  // --- triangles ---------------------------------------------------------
  const positions = [];
  const push = (p) => positions.push(p[0], p[1], p[2]);

  for (let ring = 0; ring < rings.length - 1; ring++) {
    const lower = rings[ring];
    const upper = rings[ring + 1];
    for (let i = 0; i < facets; i++) {
      const j = (i + 1) % facets;
      push(lower[i]); push(lower[j]); push(upper[i]);
      push(lower[j]); push(upper[j]); push(upper[i]);
    }
  }

  const top = rings[rings.length - 1];
  const base = rings[0];
  for (let i = 0; i < facets; i++) {
    const j = (i + 1) % facets;
    push(top[i]); push(top[j]); push(apex); // the point
    push(floorCentre); push(base[j]); push(base[i]); // the underside
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  // Non-indexed + per-face normals: this is what makes the facets crisp.
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A short, wide crystal shard — the ankle-height rubble that fills in around the
 * main spikes. Same unit space, so it instances through the identical path.
 */
export function createShardGeometry(seed = 5, sides = 5) {
  return createCrystalGeometry({
    seed: seed * 2.7 + 41,
    sides,
    taper: 0.22,
    roughness: 0.55,
    bend: 0.35
  });
}

/* ---------------------------------------------------------------------- */
/* Asteroid                                                                */
/* ---------------------------------------------------------------------- */

/** One lattice corner of the value noise below. */
function lattice(ix, iy, iz, seed) {
  return hash11(ix * 127.1 + iy * 311.7 + iz * 74.7 + seed * 19.19);
}

/**
 * Deterministic 3D value noise, 0..1.
 *
 * The GLSL library has simplex noise, but the asteroid is displaced on the CPU
 * (a vertex shader cannot move a shadow caster's silhouette or its normals), so
 * it needs a JS counterpart. Value noise on a smoothstepped lattice is plenty:
 * the shape is read at the silhouette, not up close, and the rock's *detail*
 * comes from the flat facets and the crack shader on top.
 */
function valueNoise3(x, y, z, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;

  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const c000 = lattice(ix, iy, iz, seed);
  const c100 = lattice(ix + 1, iy, iz, seed);
  const c010 = lattice(ix, iy + 1, iz, seed);
  const c110 = lattice(ix + 1, iy + 1, iz, seed);
  const c001 = lattice(ix, iy, iz + 1, seed);
  const c101 = lattice(ix + 1, iy, iz + 1, seed);
  const c011 = lattice(ix, iy + 1, iz + 1, seed);
  const c111 = lattice(ix + 1, iy + 1, iz + 1, seed);

  const x00 = c000 + (c100 - c000) * ux;
  const x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux;
  const x11 = c011 + (c111 - c011) * ux;

  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;

  return y0 + (y1 - y0) * uz;
}

/** Signed fbm over `valueNoise3`, roughly -1..1. */
function fbmValue(x, y, z, seed, octaves) {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * (valueNoise3(x * frequency, y * frequency, z * frequency, seed + i * 7.7) * 2 - 1);
    frequency *= 2.03;
    amplitude *= 0.5;
  }
  return value;
}

/**
 * A meteor: a fractured, cratered ball of rock.
 *
 * Unit space — an icosphere of radius 1 whose vertices are pushed in and out
 * along their own direction, so an instance scales it straight to metres and
 * `local` reads as a direction on the rock. That matters because
 * `materials/MeteorMaterial.js` samples its lava seams in exactly that space:
 * the cracks are welded to the rock and tumble with it instead of swimming
 * through it.
 *
 * Three things stack to make it read as *stone* rather than as a wobbly ball:
 *
 *  1. **fbm lumps** — the big shape, so no two directions look alike.
 *  2. **planar cuts** — the rock is sliced by a handful of random half-spaces:
 *     anything outside a plane is pushed back onto it. That leaves genuine flat
 *     faces meeting at hard edges, which is what quarried and shattered stone
 *     actually looks like, and it is the single biggest difference between this
 *     and a displaced sphere.
 *  3. **craters** — bowls with a heaped ejecta rim, punched through the lot.
 *
 * The displacement is a pure function of the vertex *direction*, which is what
 * lets the geometry be non-indexed (needed for flat facets) without splitting
 * open — duplicated vertices share a direction, so they are moved identically.
 *
 * @param {object} options
 * @param {number} [options.seed]        deterministic shape seed
 * @param {number} [options.detail]      icosphere subdivisions, 0–3
 * @param {number} [options.lumpiness]   low-frequency deformation, × the radius
 * @param {number} [options.noiseScale]  lumps per unit radius
 * @param {number} [options.roughness]   high-frequency chipping
 * @param {number} [options.cuts]        planar fracture faces sliced off it
 * @param {number} [options.cutDepth]    how far in those planes bite, × the radius
 * @param {number} [options.craters]     impact bowls punched into it
 * @param {number} [options.craterDepth] how deep those bowls go, × the radius
 * @param {number} [options.craterSize]  their angular radius, radians
 */
export function createAsteroidGeometry({
  seed = 1,
  detail = 3,
  lumpiness = 0.26,
  noiseScale = 1.5,
  roughness = 0.16,
  cuts = 7,
  cutDepth = 0.2,
  craters = 5,
  craterDepth = 0.18,
  craterSize = 0.5
} = {}) {
  // Every vertex is displaced on its own below, so shared vertices would weld
  // the cuts and craters back together — the rock has to be non-indexed. It
  // already is: `PolyhedronGeometry` expands its faces as it builds them, and
  // calling `toNonIndexed()` on that only earns a console warning, forty-five
  // of them in one harness run because Cinder Fall rebuilds its rock live when
  // a shape slider moves. Convert only if three ever starts indexing it, and
  // drop the original on the floor when we do.
  const base = new IcosahedronGeometry(1, clamp(Math.round(detail), 0, 3));
  let geometry = base;
  if (base.index) {
    geometry = base.toNonIndexed();
    base.dispose();
  }
  const array = geometry.attributes.position.array;

  /** A deterministic point on the unit sphere. */
  const direction = (a, b) => {
    const phi = Math.acos(2 * hash11(a) - 1);
    const theta = hash11(b) * TAU;
    const sinPhi = Math.sin(phi);
    return { x: sinPhi * Math.cos(theta), y: Math.cos(phi), z: sinPhi * Math.sin(theta) };
  };

  // Cuts and craters are picked once per seed and shared by every vertex, so the
  // vertex loop below stays a pure lookup.
  const planes = [];
  for (let i = 0; i < Math.max(0, Math.round(cuts)); i++) {
    const n = direction(seed * 2.3 + i * 9.1, seed * 5.7 + i * 4.3);
    // How far along its own normal the plane sits: 1 is tangent (no bite), less
    // shaves a face off. Kept above 0.55 so a cut never lops the rock in half.
    n.offset = 1 - cutDepth * (0.35 + 0.9 * hash11(seed * 13.1 + i * 6.7));
    planes.push(n);
  }

  const bowls = [];
  for (let i = 0; i < Math.max(0, Math.round(craters)); i++) {
    const c = direction(seed * 3.1 + i * 12.9, seed * 7.7 + i * 5.3);
    c.radius = Math.max(0.08, craterSize * (0.45 + 0.8 * hash11(seed * 11.3 + i * 3.7)));
    c.depth = craterDepth * (0.5 + hash11(seed * 17.9 + i * 2.1));
    bowls.push(c);
  }

  for (let i = 0; i < array.length; i += 3) {
    // IcosahedronGeometry(1) hands us unit-length vertices already.
    const x = array[i];
    const y = array[i + 1];
    const z = array[i + 2];

    /* --- 1. the lumpy body --- */
    let radius = 1;
    radius += fbmValue(x * noiseScale, y * noiseScale, z * noiseScale, seed, 3) * lumpiness;
    radius +=
      fbmValue(x * noiseScale * 4.3, y * noiseScale * 4.3, z * noiseScale * 4.3, seed + 31.7, 2) *
      roughness *
      0.5;

    /* --- 2. craters, before the cuts so a cut can shear one in half --- */
    for (const bowl of bowls) {
      const angle = Math.acos(clamp(x * bowl.x + y * bowl.y + z * bowl.z, -1, 1));
      const q = angle / bowl.radius;
      if (q >= 1.4) continue;
      radius -= bowl.depth * Math.max(0, 1 - q * q);
      radius += bowl.depth * 0.5 * smoothstep(0.72, 1.0, q) * (1 - smoothstep(1.0, 1.4, q));
    }

    radius = Math.max(0.35, radius);
    let px = x * radius;
    let py = y * radius;
    let pz = z * radius;

    /* --- 3. slice off the flat faces --- */
    for (const plane of planes) {
      const along = px * plane.x + py * plane.y + pz * plane.z;
      const over = along - plane.offset;
      if (over <= 0) continue;
      // Project back onto the plane. Every vertex outside it lands *on* it, so
      // the result is a genuinely flat facet, not a squashed curve.
      px -= plane.x * over;
      py -= plane.y * over;
      pz -= plane.z * over;
    }

    array[i] = px;
    array[i + 1] = py;
    array[i + 2] = pz;
  }

  geometry.attributes.position.needsUpdate = true;
  // Non-indexed + per-face normals: the facets stay crisp, like the crystals.
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The strip a lightning filament is drawn on — a flat ladder of quads, in
 * *parameter* space rather than world space.
 *
 * Every vertex carries `position = (t, side, 0)`, where `t` runs 0 → 1 from the
 * caster's hand to the impact point and `side` is ±1 across the ribbon. There
 * are no metres in here at all: `materials/LightningMaterial.js` turns that pair
 * into a world position every frame, so one strip serves a bolt of any length,
 * any shape and any width, and the whole path stays a live slider.
 *
 * One instance is one filament, and `aStrand` is simply its index — the shader
 * derives the filament's seed, its place in the fan and its width from it.
 *
 * @param {number} nodes   samples along the bolt; the kink detail ceiling
 * @param {number} strands instance capacity (the live count is `instanceCount`)
 */
export function createBoltRibbonGeometry(nodes = 72, strands = 24) {
  const steps = Math.max(2, Math.round(nodes));
  const count = Math.max(1, Math.round(strands));

  const positions = new Float32Array(steps * 2 * 3);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const o = i * 6;
    positions[o + 0] = t;
    positions[o + 1] = -1;
    positions[o + 3] = t;
    positions[o + 4] = 1;
  }

  const indices = new Uint16Array((steps - 1) * 6);
  for (let i = 0; i < steps - 1; i++) {
    const a = i * 2;
    const o = i * 6;
    indices[o + 0] = a;
    indices[o + 1] = a + 1;
    indices[o + 2] = a + 2;
    indices[o + 3] = a + 1;
    indices[o + 4] = a + 3;
    indices[o + 5] = a + 2;
  }

  const strandIndex = new Float32Array(count);
  for (let i = 0; i < count; i++) strandIndex[i] = i;

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aStrand', new InstancedBufferAttribute(strandIndex, 1));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.instanceCount = count;
  // The bolt is built in world space in the vertex shader, so the geometry's own
  // bounds are meaningless — cull it manually instead (the ability sets
  // `frustumCulled = false`).
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* Beam                                                                    */
/* ---------------------------------------------------------------------- */

/**
 * The column a beam is drawn on — a tube in *parameter* space.
 *
 * Same trick as the bolt ribbon, one dimension richer: every vertex carries
 * `position = (t, a, 0)`, where `t` runs 0 → 1 from the muzzle to the impact
 * point and `a` runs 0 → 1 once around the barrel. There are no metres in here
 * either; `materials/BeamMaterial.js` turns that pair into a world position
 * every frame, so one tube serves a beam of any length and any profile.
 *
 * Real tube rather than the camera-facing ribbon the bolt uses, because a beam
 * this thick has to *have* a cross-section: the silhouette has to bow correctly
 * when you orbit around it, the far wall has to add through the near one, and
 * the shock rings have to be able to hug it. A ribbon can fake none of that.
 *
 * The seam column is duplicated so `a` reaches a full 1.0 instead of wrapping
 * to 0 — the angular noise in the shader would otherwise show a hard join line
 * down the length of the beam.
 *
 * @param {number} nodes samples along the column; the profile detail ceiling
 * @param {number} sides facets around the barrel (20–32 reads clean)
 */
export function createBeamTubeGeometry(nodes = 96, sides = 26) {
  const steps = Math.max(2, Math.round(nodes));
  const facets = Math.max(3, Math.round(sides));
  const columns = facets + 1;

  const positions = new Float32Array(steps * columns * 3);
  let v = 0;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    for (let j = 0; j < columns; j++) {
      positions[v++] = t;
      positions[v++] = j / facets;
      positions[v++] = 0;
    }
  }

  const indices = new Uint16Array((steps - 1) * facets * 6);
  let k = 0;
  for (let i = 0; i < steps - 1; i++) {
    for (let j = 0; j < facets; j++) {
      const a = i * columns + j;
      const b = a + columns;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = a + 1;
      indices[k++] = b;
      indices[k++] = b + 1;
      indices[k++] = a + 1;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  // Placed in world space by the vertex shader, like the bolt — its own bounds
  // mean nothing (the ability sets `frustumCulled = false`).
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

/**
 * The shock discs that race down a beam — an instanced annulus, again in
 * parameter space: `position = (band, a, 0)` with `band` 0 at the inner lip and
 * 1 at the outer one, and `a` once around.
 *
 * One instance is one disc, and `aRing` is only its index — the shader spaces
 * the discs evenly along the column from it and slides them downrange, so the
 * whole train is a function of the clock rather than a queue on the CPU.
 *
 * @param {number} rings    instance capacity (the live count is `instanceCount`)
 * @param {number} segments facets around one disc
 */
export function createBeamRingGeometry(rings = 10, segments = 44) {
  const count = Math.max(1, Math.round(rings));
  const facets = Math.max(6, Math.round(segments));
  const columns = facets + 1;

  const positions = new Float32Array(2 * columns * 3);
  let v = 0;
  for (let band = 0; band < 2; band++) {
    for (let j = 0; j < columns; j++) {
      positions[v++] = band;
      positions[v++] = j / facets;
      positions[v++] = 0;
    }
  }

  const indices = new Uint16Array(facets * 6);
  let k = 0;
  for (let j = 0; j < facets; j++) {
    const a = j;
    const b = columns + j;
    indices[k++] = a;
    indices[k++] = b;
    indices[k++] = a + 1;
    indices[k++] = b;
    indices[k++] = b + 1;
    indices[k++] = a + 1;
  }

  const ringIndex = new Float32Array(count);
  for (let i = 0; i < count; i++) ringIndex[i] = i;

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aRing', new InstancedBufferAttribute(ringIndex, 1));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.instanceCount = count;
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}
