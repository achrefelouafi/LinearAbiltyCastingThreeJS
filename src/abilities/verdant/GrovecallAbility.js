import {
  BufferGeometry,
  Float32BufferAttribute,
  MeshStandardMaterial,
  DoubleSide,
  Color,
  Vector3
} from 'three';
import { Ability } from '../Ability.js';
import { GrowthField, GrowthLayout, GrowthEmerge, patchGrowthMaterial } from '../../vfx/GrowthField.js';
import { Curtain, CurtainMode, CurtainLayout } from '../../vfx/Curtain.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, hash11, Easing, randRange } from '../../utils/math.js';

/* ---------------------------------------------------------------------- */
/* Constants                                                               */
/* ---------------------------------------------------------------------- */

const TAU = Math.PI * 2;

/** Hard ceiling on trunks per cast. The editor's `trees` slider clamps here. */
const MAX_TREES = 12;

/** Distinct tree silhouettes — one InstancedMesh each. Three draw calls. */
const VARIANTS = 3;

/** Hard ceiling on light shafts. The `shafts` slider clamps here. */
const MAX_SHAFTS = 16;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _up = new Vector3(0, 1, 0);
const _shaftUp = new Vector3();
const _shaftAlong = new Vector3();
const _shaftAnchor = new Vector3();

/** The curtain's live params. One object, refilled — never rebuilt. */
const _shaft = {};

/* ---------------------------------------------------------------------- */
/* The tree                                                                */
/* ---------------------------------------------------------------------- */

/** Ring heights up the trunk, as fractions of the trunk's own length. */
const TRUNK_T = [0, 0.2, 0.42, 0.66, 0.86, 1];

/** Facets around one canopy disc. Seven is ragged; eight reads as a wheel. */
const DISC_SIDES = 7;

/**
 * A tree in `GrowthField`'s unit space: footprint inside a circle of radius 0.5
 * on `y = 0`, tip at `y = 1`.
 *
 * The brief for this geometry was "cheap, readable in silhouette", and those two
 * pull in opposite directions until you give up on the canopy being a *volume*.
 * A sphere of leaves is the obvious answer and it is wrong twice: it costs
 * hundreds of triangles, and it reads as a lollipop, because a smooth outline is
 * exactly what a tree does not have. What is here instead is **five shallow
 * cones at random bearings** — `canopyDiscs` fans of `DISC_SIDES` triangles,
 * each with a jittered rim and a lifted middle, scattered off the axis by
 * `canopySpread`. Ninety triangles, and the outline is ragged from every angle
 * because no two discs present the same edge.
 *
 * The discs are single-sided fans drawn with a `DoubleSide` material, which is
 * the cheap half of the trick: from below you see the underside of the crown lit
 * by the backlight term rather than a hole.
 *
 * The trunk is the same swept n-gon the thorn uses, taper reversed — thick at
 * the ground, narrowing into the crown — with `branchStubs` short pyramids
 * angled out of it. The stubs are load-bearing for the read: without them the
 * crown floats, and the eye reads a mushroom.
 */
function createTreeGeometry({
  seed = 1,
  sides = 5,
  trunkTaper = 0.55,
  trunkBase = 0.19,
  trunkLean = 0.14,
  canopyBase = 0.52,
  branchStubs = 4,
  branchLength = 0.3,
  branchTilt = 0.45,
  canopyDiscs = 5,
  canopyRadius = 0.34,
  canopySpread = 0.16,
  canopyDome = 0.16,
  rough = 0.4
} = {}) {
  const faces = Math.max(3, Math.min(8, Math.round(sides)));
  const stubs = Math.max(0, Math.min(6, Math.round(branchStubs)));
  const discs = Math.max(1, Math.min(8, Math.round(canopyDiscs)));

  // The trunk runs a little way into the crown so the two are never seen to be
  // separate objects, which is the failure a canopy sitting on a pole has.
  const trunkTop = Math.min(0.96, canopyBase + 0.28);
  const bendAngle = hash11(seed * 1.77) * TAU;
  const bendX = Math.cos(bendAngle);
  const bendZ = Math.sin(bendAngle);

  const trunkRadius = (u) => Math.max(0.006, trunkBase * Math.pow(Math.max(0.02, 1 - u * 0.9), trunkTaper));
  const drift = (u) => trunkLean * Math.pow(u, 1.4);

  const positions = [];
  const push = (p) => positions.push(p[0], p[1], p[2]);

  /* --- the trunk ---------------------------------------------------- */
  const angles = [];
  for (let i = 0; i < faces; i++) {
    const jitter = (hash11(seed * 3.13 + i * 7.7) - 0.5) * (TAU / faces) * 0.5 * rough;
    angles.push((i / faces) * TAU + jitter);
  }

  const rings = TRUNK_T.map((u, ringIndex) => {
    const r0 = trunkRadius(u);
    const dx = bendX * drift(u);
    const dz = bendZ * drift(u);
    const y = u * trunkTop;
    return angles.map((angle, i) => {
      const wobble = 1 + (hash11(seed * 11.1 + ringIndex * 13.7 + i * 3.9) - 0.5) * rough * 0.9;
      const r = Math.max(0.004, r0 * wobble);
      return [Math.cos(angle) * r + dx, y, Math.sin(angle) * r + dz];
    });
  });

  for (let ring = 0; ring < rings.length - 1; ring++) {
    const lower = rings[ring];
    const upper = rings[ring + 1];
    for (let i = 0; i < faces; i++) {
      const j = (i + 1) % faces;
      push(lower[i]); push(lower[j]); push(upper[i]);
      push(lower[j]); push(upper[j]); push(upper[i]);
    }
  }

  // Cap both ends: the top is buried in the crown but an open tube shows as a
  // black notch the moment a shaft passes behind it.
  const top = rings[rings.length - 1];
  const base = rings[0];
  const topCentre = [bendX * drift(1), trunkTop, bendZ * drift(1)];
  const floorCentre = [0, 0, 0];
  for (let i = 0; i < faces; i++) {
    const j = (i + 1) % faces;
    push(top[i]); push(top[j]); push(topCentre);
    push(floorCentre); push(base[j]); push(base[i]);
  }

  /* --- the branch stubs --------------------------------------------- */
  for (let k = 0; k < stubs; k++) {
    const roll = hash11(seed * 23.7 + k * 5.13);
    const u = 0.45 + 0.45 * ((k + 0.4 * roll) / Math.max(1, stubs));
    const bearing = (k * 0.61803 + 0.35 * hash11(seed * 31.1 + k * 9.7)) * TAU;
    const cos = Math.cos(bearing);
    const sin = Math.sin(bearing);

    const r = trunkRadius(u);
    const cx = bendX * drift(u) + cos * r * 0.7;
    const cy = u * trunkTop;
    const cz = bendZ * drift(u) + sin * r * 0.7;

    let dxx = cos;
    let dyy = branchTilt;
    let dzz = sin;
    const dl = Math.hypot(dxx, dyy, dzz) || 1;
    dxx /= dl; dyy /= dl; dzz /= dl;

    const length = branchLength * (0.7 + 0.6 * hash11(seed * 41.3 + k * 3.7));
    const tip = [cx + dxx * length, cy + dyy * length, cz + dzz * length];

    let ux = -dzz;
    let uy = 0;
    let uz = dxx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = dyy * uz - dzz * uy;
    const vy = dzz * ux - dxx * uz;
    const vz = dxx * uy - dyy * ux;

    const root = Math.max(0.01, r * 0.5);
    const ring = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + roll * TAU;
      const ca = Math.cos(a) * root;
      const sa = Math.sin(a) * root;
      ring.push([cx + ux * ca + vx * sa, cy + uy * ca + vy * sa, cz + uz * ca + vz * sa]);
    }
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      push(ring[i]); push(ring[j]); push(tip);
    }
  }

  /* --- the canopy ---------------------------------------------------- */
  for (let k = 0; k < discs; k++) {
    const h1 = hash11(seed * 53.1 + k * 7.9);
    const h2 = hash11(seed * 61.7 + k * 11.3);
    const h3 = hash11(seed * 71.9 + k * 13.1);

    const offAngle = h1 * TAU;
    const offR = canopySpread * Math.sqrt(h2);
    let radius = canopyRadius * (0.7 + 0.6 * h3);
    // Keep the crown inside the unit footprint: an instance is scaled by its
    // own radius, and a disc poking outside 0.5 makes that radius a lie for
    // every consumer that reads it back (the leaf emitter, the shafts).
    radius = Math.min(radius, Math.max(0.06, 0.5 - offR));

    const cx = bendX * drift(1) + Math.cos(offAngle) * offR;
    const cy = lerp(canopyBase, 0.99, hash11(seed * 83.3 + k * 3.3));
    const cz = bendZ * drift(1) + Math.sin(offAngle) * offR;

    // A normal mostly up but tipped, so no two discs present the same edge.
    const tipBearing = hash11(seed * 97.1 + k * 5.7) * TAU;
    const tipAngle = (0.15 + 0.45 * hash11(seed * 101.3 + k * 2.9)) * (0.3 + 0.7 * rough);
    const nx = Math.cos(tipBearing) * Math.sin(tipAngle);
    const ny = Math.cos(tipAngle);
    const nz = Math.sin(tipBearing) * Math.sin(tipAngle);

    let ux = -nz;
    let uy = 0;
    let uz = nx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = ny * uz - nz * uy;
    const vy = nz * ux - nx * uz;
    const vz = nx * uy - ny * ux;

    const apex = [cx + nx * canopyDome, cy + ny * canopyDome, cz + nz * canopyDome];
    const rim = [];
    for (let i = 0; i < DISC_SIDES; i++) {
      const a = (i / DISC_SIDES) * TAU + h1 * TAU;
      const rr = radius * (1 + (hash11(seed * 113.7 + k * 17.3 + i * 4.1) - 0.5) * rough * 0.8);
      const ca = Math.cos(a) * rr;
      const sa = Math.sin(a) * rr;
      rim.push([cx + ux * ca + vx * sa, cy + uy * ca + vy * sa, cz + uz * ca + vz * sa]);
    }
    for (let i = 0; i < DISC_SIDES; i++) {
      const j = (i + 1) % DISC_SIDES;
      push(apex); push(rim[i]); push(rim[j]);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* Bark and leaf                                                           */
/* ---------------------------------------------------------------------- */

/**
 * One material for the whole tree, split by height.
 *
 * Two materials would mean two `GrowthField`s over the same records, which is
 * six draw calls for one grove. Instead `canopySplit` is a threshold on
 * `vGrowLocal.y`: below it the fragment shades furrowed bark, above it mottled
 * leaf. The branch stubs sit under the line and come out as bark, which is
 * correct by accident and is why the line defaults just under `canopyBase`.
 *
 * The term that pays for the ability is **backlight**. A leaf is thin enough to
 * transmit, so a canopy with the sun behind it is brighter than a canopy with
 * the sun in front of it, and that inversion is most of what says "leaves"
 * rather than "green plastic". It is `pow(max(dot(−N, L), 0), backlightSharp)`
 * against the stage's own `frame.uLightDir` — the same vector the shafts are
 * hung from, so the two effects agree about where the sun is without either of
 * them being told.
 */
function createGroveMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.82,
    metalness: 0.0,
    flatShading: true,
    // The canopy discs are single-sided fans; without this the crown is hollow
    // from underneath, which is the one angle a three-metre tree is seen from.
    side: DoubleSide,
    transparent: true,
    depthWrite: true
  });

  const uniforms = {
    uTime: frame.uTime,
    uLightDir: frame.uLightDir,
    uColorBark: { value: new Color() },
    uColorBarkDeep: { value: new Color() },
    uColorLeaf: { value: new Color() },
    uColorLeafDeep: { value: new Color() },
    uColorLeafGlow: { value: new Color() },
    uColorSap: { value: new Color() },
    uSplit: { value: 0.5 },
    uSplitSoft: { value: 0.06 },
    uBarkGrain: { value: 0.6 },
    uBarkScale: { value: 7.0 },
    uLeafMottle: { value: 0.65 },
    uLeafScale: { value: 3.4 },
    uBacklight: { value: 1.6 },
    uBacklightSharp: { value: 2.4 },
    uSapGlow: { value: 2.2 },
    uGlow: { value: 1.0 }
  };

  patchGrowthMaterial(material, {
    environment,
    uniforms,
    common: /* glsl */ `
      uniform float uTime;
      uniform vec3  uLightDir;
      uniform vec3  uColorBark;
      uniform vec3  uColorBarkDeep;
      uniform vec3  uColorLeaf;
      uniform vec3  uColorLeafDeep;
      uniform vec3  uColorLeafGlow;
      uniform vec3  uColorSap;
      uniform float uSplit;
      uniform float uSplitSoft;
      uniform float uBarkGrain;
      uniform float uBarkScale;
      uniform float uLeafMottle;
      uniform float uLeafScale;
      uniform float uBacklight;
      uniform float uBacklightSharp;
      uniform float uSapGlow;
      uniform float uGlow;
    `,
    fragment: /* glsl */ `
      vec3  N   = normalize(normal);
      float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);
      float y   = clamp(vGrowLocal.y, 0.0, 1.0);

      float leafy = smoothstep(uSplit - max(uSplitSoft, 1e-3),
                               uSplit + max(uSplitSoft, 1e-3), y);

      // Bark furrows run *up* the trunk, so the noise is squashed hard in y and
      // sampled in world space: two trunks side by side then look cut from the
      // same wood instead of each carrying its own copy of the pattern.
      float furrow = fbm3(vec3(vGrowWorld.xz * uBarkScale, vGrowWorld.y * uBarkScale * 0.18)
                          + vGrowSeed * 3.0);
      furrow = furrow * 0.5 + 0.5;
      vec3 bark = mix(uColorBarkDeep, uColorBark, mix(1.0, furrow, uBarkGrain));

      // Local space for the canopy mottle, so it follows each crown's own axis
      // however the instance is scaled and tipped.
      float clump = fbm3(vGrowLocal * uLeafScale * 3.0 + vGrowSeed * 17.0) * 0.5 + 0.5;
      vec3 leaf = mix(uColorLeafDeep, uColorLeaf, mix(1.0, smoothstep(0.3, 0.85, clump), uLeafMottle));

      vec3 body = mix(bark, leaf, leafy);
      body *= 0.66 + 0.5 * ndv;
      diffuseColor.rgb *= body;

      // Transmission through a leaf: the canopy is brighter with the sun behind
      // it than in front of it, which is most of what says 'leaf'.
      float through = pow(clamp(dot(-N, normalize(uLightDir)), 0.0, 1.0),
                          max(uBacklightSharp, 0.05));
      vec3 glow = uColorLeafGlow * through * uBacklight * leafy;
      glow += uColorSap * vGrowBirth * uSapGlow;
      glow *= uGlow;
      glow /= 1.0 + glow * 0.35;

      totalEmissiveRadiance += glow;
    `
  });

  // Where the harness's pause test looks for a patched standard material's
  // live boxes — `material.uniforms` does not exist without a GL context.
  material.userData.uniforms = uniforms;
  return material;
}

/* ---------------------------------------------------------------------- */
/* The ability                                                             */
/* ---------------------------------------------------------------------- */

/**
 * GROVECALL — a far cast that answers the circle with six trees.
 *
 * The call runs out along the floor to the aimed point, cracking roots as it
 * goes. When it lands, a wave runs around the ring and six trunks come up out of
 * the ground — three metres in half a second, canopies unfolding at the top of
 * the climb. Light comes through them onto the floor, leaves shed for as long as
 * the grove stands, and then it sinks back and takes the light with it.
 *
 * **THE TRICK — scale contrast, and the shafts are real geometry.**
 *
 * *Scale.* Everything else in this sandbox is knee-high or made of light. Six
 * three-metre trunks arriving in half a second is the only moment in the set
 * where the stage suddenly has something in it taller than the caster, and the
 * whole ability is tuned around that read: `growTime` at 0.5 s so the climb is
 * fast enough to be violent, `sweepTime` at 0.55 s so they arrive as a wave
 * rather than a pop, `riseOvershoot` low because three metres of tree does not
 * bounce the way an ice spike does, and the leaves deliberately small so the
 * canopy has a sense of distance.
 *
 * *The shafts.* Not a post-process, not a billboard: a `Curtain` in SHAFT mode,
 * anchored at `shaftTop` metres above the circle with **`-frame.uLightDir` as
 * its up axis**, so each sheet is a tapered translucent volume running down the
 * stage's real sun direction and ending by intersecting the floor. Two details
 * make that work rather than nearly work:
 *
 *  1. The `along` axis handed to `setPlacement` is `lightDir × up`, not the
 *     cast direction. `setPlacement` re-orthogonalises the up axis against
 *     `along`, so handing it the cast's heading silently projects the light
 *     direction into a plane and the shafts come out about 25° off the sun.
 *     Passing an `along` that is already perpendicular to the light makes the
 *     orthogonalisation a no-op and the sheets slant *exactly* with the key.
 *  2. The length is `shaftTop / lightDir.y`, times `shaftOvershoot`. That is the
 *     geometric drop to the floor, resolved every frame from the live light — so
 *     the shafts reach the ground and stop by intersecting it, at any sun angle,
 *     with no floor decal faking the pool. Wind `shaftOvershoot` under 1 and you
 *     can watch them hang in the air, which is the version this replaced.
 *
 * A cast captures the field's record dice, the curtain's per-sheet dice, one
 * seed, and two timestamps — the moment the call landed and, per tree, the
 * moment the bearing wave released it. Every metre, radian and second is
 * re-resolved from `settings.grovecall` inside the update loop, on zero-length
 * frames included: drag `zoneRadius` and the grove re-seats, drag `treeHeight`
 * and the trunks grow while the clock is stopped, drag `shaftTop` and the light
 * re-hangs itself from the new canopy line.
 *
 * **Cost.** Three instanced tree meshes + one curtain sheet mesh = **4 draw
 * calls**, three shared particle systems, one dynamic light.
 */
export class GrovecallAbility extends Ability {
  constructor(context) {
    super('grovecall', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const environment = this.ctx.environment;
    this.material = createGroveMaterial(environment);

    /** Geometry controls, compared each frame by `syncGeometry`. */
    this._shape = {
      sides: 5,
      trunkTaper: 0.55,
      trunkBase: 0.19,
      trunkLean: 0.14,
      canopyBase: 0.52,
      branchStubs: 4,
      branchLength: 0.3,
      branchTilt: 0.45,
      canopyDiscs: 5,
      canopyRadius: 0.34,
      canopySpread: 0.16,
      canopyDome: 0.16,
      rough: 0.4
    };
    this._fillShape();

    this.field = new GrowthField(this.group, {
      geometry: (variant, shape) => createTreeGeometry({ seed: 11.3 + variant * 27.1, ...shape }),
      material: this.material,
      shape: this._shape,
      variants: VARIANTS,
      capacity: MAX_TREES,
      renderOrder: 2
    });
    this.field.onBreach = (index, position, radius, height) =>
      this._onBreach(index, position, radius, height);

    this.curtain = new Curtain({
      capacity: MAX_SHAFTS,
      segmentsX: 20,
      segmentsY: 10,
      mode: CurtainMode.SHAFT,
      layout: CurtainLayout.SCATTER,
      floor: false,
      renderOrder: 9,
      name: 'Grovecall:shafts'
    });
    this.group.add(this.curtain.object3D);

    /** The centre of the circle. A Vector3 the field holds by reference. */
    this._centre = new Vector3();

    /** Live params handed to the field every frame. */
    this._params = {
      layout: GrowthLayout.ZONE,
      emerge: GrowthEmerge.PUSH,
      origin: this.origin,
      direction: this.direction,
      side: this.side,
      centre: this._centre,
      length: 1
    };

    /* --- the cast's dice and timestamps --- */
    this._seed = 0;
    /** Age the call landed at. −1 until it does. */
    this._callTime = -1;
    /** Metres of the run-out already paid out in root cracks. */
    this._callDistance = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Leaves. Lit and non-additive, because a leaf falling through a shaft has
    // to be *lit by* the shaft rather than added on top of it — the whole point
    // of the light being real is that things can be in it.
    this.leaves = particles.get('grovecall.leaves', {
      capacity: 2400,
      shape: ParticleShape.LEAF,
      additive: false,
      lit: true,
      curl: true,
      softFade: 0.3
    });
    this.leaves.uniforms.uDrag.value = 2.4;
    this.leaves.uniforms.uEndSize.value = 0.95;
    this.leaves.uniforms.uSizeIn.value = 0.03;
    this.leaves.uniforms.uFadeIn.value = 0.05;
    this.leaves.uniforms.uFadeOut.value = 0.35;

    // Pollen hanging in the beams. Additive: this one *is* light.
    this.pollen = particles.get('grovecall.pollen', {
      capacity: 1600,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.5
    });
    this.pollen.uniforms.uDrag.value = 1.7;
    this.pollen.uniforms.uEndSize.value = 0.25;
    this.pollen.uniforms.uSizeIn.value = 0.1;
    this.pollen.uniforms.uFadeIn.value = 0.2;
    this.pollen.uniforms.uFadeOut.value = 0.55;

    // Soil off the roots.
    this.soil = particles.get('grovecall.soil', {
      capacity: 1400,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.soil.uniforms.uDrag.value = 0.4;
    this.soil.uniforms.uEndSize.value = 0.7;
    this.soil.uniforms.uFadeOut.value = 0.6;

    this.leafEmitter = new RateEmitter();
    this.pollenEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.field.count + this.curtain.instanceCount;
  }

  get impactDuration() {
    return Math.max(0.2, settings.grovecall.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.2, settings.grovecall.fadeTime);
  }

  /** The live footprint, metres. What the circle indicator measured out. */
  get radius() {
    return Math.max(0.1, settings.grovecall.zoneRadius);
  }

  /** Dappled, not flickering: a slow two-rate breath, like light through leaves. */
  lightShimmer() {
    return 0.86 + 0.14 * Math.sin(this.age * 2.6) * Math.sin(this.age * 5.9);
  }

  /* ------------------------------------------------------------------ */
  /* Resolving — every metre comes from here, every frame                */
  /* ------------------------------------------------------------------ */

  _fillShape() {
    const c = settings.grovecall;
    const s = this._shape;
    s.sides = c.treeSides;
    s.trunkTaper = c.trunkTaper;
    s.trunkBase = c.trunkBase;
    s.trunkLean = c.trunkLean;
    s.canopyBase = c.canopyBase;
    s.branchStubs = c.branchStubs;
    s.branchLength = c.branchLength;
    s.branchTilt = c.branchTilt;
    s.canopyDiscs = c.canopyDiscs;
    s.canopyRadius = c.canopyRadius;
    s.canopySpread = c.canopySpread;
    s.canopyDome = c.canopyDome;
    s.rough = c.treeRough;
  }

  _fillParams() {
    const c = settings.grovecall;
    const p = this._params;
    const R = this.radius;

    this.pointAt(1, this._centre).setY(0);
    p.origin = this.origin;
    p.direction = this.direction;
    p.side = this.side;
    p.length = this.length;
    p.centre = this._centre;

    // The band the trunks stand in, both ends driven off the one radius the
    // indicator drew — that sharing *is* the design (invariant I5's exception).
    p.radius = R * c.ringOuter;
    p.innerRadius = Math.min(R * c.ringOuter, R * c.ringInner);
    p.radialCurve = c.radialCurve;
    p.radialJitter = c.radialJitter;
    p.angleJitter = c.angleJitter;

    p.heightNear = c.heightNear;
    p.height = c.treeHeight;
    p.heightCurve = c.heightCurve;
    p.heightJitter = c.heightJitter;
    p.crown = 0;
    p.peak = 1;
    p.rubble = 0;

    p.radiusNear = c.treeRadius;
    p.radius2 = c.treeRadius2;
    p.radiusCurve = c.radiusCurve;
    p.radiusJitter = c.radiusJitter;

    p.lean = c.lean;
    p.leanJitter = c.leanJitter;
    p.leanRamp = 1;
    p.leanForward = c.leanForward;
    p.leanOutward = c.leanOutward;
    p.twist = c.twist;
    p.tilt = c.tilt;

    p.riseTime = c.growTime;
    p.riseOvershoot = c.riseOvershoot;
    p.settle = c.settle;
    p.springRate = c.springRate;
    p.emergeSink = c.emergeSink;
    p.birthScale = c.birthScale;
    p.birthFade = c.birthFade;
    p.breachAt = c.breachAt;
    p.sinkDepth = c.sinkDepth;

    p.randomness = settings.global.randomness;
    return p;
  }

  /** Push the palette and every shading control into the bark and leaf. */
  _syncMaterial() {
    const c = settings.grovecall;
    const g = settings.global;
    const u = this.material.userData.uniforms;

    u.uColorBark.value.copy(getColor(c.colorBark));
    u.uColorBarkDeep.value.copy(getColor(c.colorBarkDeep));
    u.uColorLeaf.value.copy(getColor(c.colorLeaf));
    u.uColorLeafDeep.value.copy(getColor(c.colorLeafDeep));
    u.uColorLeafGlow.value.copy(getColor(c.colorLeafGlow));
    u.uColorSap.value.copy(getColor(c.colorSap));

    u.uSplit.value = c.canopySplit;
    u.uSplitSoft.value = c.canopySoft;
    u.uBarkGrain.value = c.barkGrain * g.shaderIntensity;
    u.uBarkScale.value = c.barkScale * g.noiseFrequency;
    u.uLeafMottle.value = c.leafMottle * g.shaderIntensity;
    u.uLeafScale.value = c.leafScale * g.noiseFrequency;
    u.uBacklight.value = c.backlight * g.shaderIntensity;
    u.uBacklightSharp.value = c.backlightSharp;
    u.uSapGlow.value = c.sapGlow;
    u.uGlow.value = c.groveGlow * g.glow;

    this.material.roughness = c.leafRough;
    this.material.opacity = c.groveOpacity * g.opacity;
  }

  /**
   * How far the grove has arrived, 0..1 — the clock the shafts ride.
   *
   * Measured from the call, over the wave plus one tree's climb, so the light is
   * fully up the moment the last canopy finishes opening rather than a beat
   * before or a second after.
   */
  _grown() {
    if (this._callTime < 0) return 0;
    const c = settings.grovecall;
    const span = Math.max(0.05, c.sweepTime + c.growTime);
    return saturate((this.age - this._callTime) / span);
  }

  /**
   * Hang the shafts off the stage's own sun and re-resolve every metre.
   *
   * See the class header for why `along` is `lightDir × up` rather than the cast
   * heading, and why the length is a geometric drop rather than a slider.
   *
   * @param {number} rise 0..1 how far the shafts have come in
   * @param {number} fade 0..1 master, taken to zero as the grove sinks
   */
  _syncShafts(rise, fade) {
    const c = settings.grovecall;
    const g = settings.global;

    _shaftUp.copy(frame.uLightDir.value).normalize();
    const vertical = Math.max(0.25, _shaftUp.y);
    // Down the light, not up it: the sheet grows from its anchor along this.
    _shaftUp.negate();

    // Perpendicular to the light by construction, so `setPlacement`'s
    // re-orthogonalisation leaves the up axis exactly on the sun.
    _shaftAlong.crossVectors(_shaftUp, _up);
    if (_shaftAlong.lengthSq() < 1e-6) _shaftAlong.copy(this.direction);
    _shaftAlong.normalize();

    _shaftAnchor.copy(this._centre);
    _shaftAnchor.y = c.shaftTop;
    this.curtain.setPlacement(_shaftAnchor, _shaftAlong, _shaftUp);

    const drop = (c.shaftTop / vertical) * c.shaftOvershoot;

    _shaft.count = fade > 0.002 ? Math.min(MAX_SHAFTS, Math.round(c.shafts)) : 0;
    _shaft.radius = this.radius * c.shaftSpread;
    _shaft.scatter = c.shaftScatter;

    _shaft.width = c.shaftWidth;
    _shaft.widthJitter = c.shaftWidthJitter;
    _shaft.height = drop;
    _shaft.heightJitter = c.shaftHeightJitter;
    _shaft.base = 0;
    _shaft.taper = c.shaftTaper;
    _shaft.lean = c.shaftLean;
    _shaft.leanJitter = c.shaftLeanJitter;
    _shaft.rise = rise;
    _shaft.riseSpread = c.shaftRiseSpread;

    _shaft.rippleAmp = c.shaftRipple;
    _shaft.rippleLength = c.shaftRippleLength;
    _shaft.rippleSpeed = c.shaftRippleSpeed * g.noiseSpeed;
    _shaft.rippleCurve = 1.0;
    _shaft.foldAmp = c.shaftFold;
    _shaft.foldLength = c.shaftFoldLength;
    _shaft.foldSpeed = c.shaftFoldSpeed * g.noiseSpeed;
    _shaft.rippleNoise = 0;
    _shaft.phaseSpread = 1;

    _shaft.alphaBase = c.shaftAlphaBase;
    _shaft.alphaTop = c.shaftAlphaTop;
    _shaft.alphaCurve = c.shaftAlphaCurve;
    _shaft.emissionBase = c.shaftEmissionBase;
    _shaft.emissionTop = c.shaftEmissionTop;
    _shaft.emissionCurve = c.shaftEmissionCurve;

    _shaft.body = c.shaftBody;
    _shaft.footFade = c.shaftFootFade;
    _shaft.headFade = c.shaftHeadFade;
    _shaft.edgeFade = c.shaftEdgeFade;
    _shaft.graze = c.shaftGraze;
    _shaft.grazeFloor = c.shaftGrazeFloor;
    _shaft.softFade = c.shaftSoftFade;
    _shaft.tintSpread = c.shaftTintSpread;
    _shaft.opacity = c.shaftOpacity * fade * g.opacity;
    _shaft.glow = c.shaftGlow * g.glow;

    _shaft.coreWidth = c.shaftCore;
    _shaft.canopy = c.shaftCanopy;
    _shaft.canopySoft = c.shaftCanopySoft;
    _shaft.canopyScale = c.shaftCanopyScale * g.noiseFrequency;
    _shaft.mote = c.shaftMote;
    _shaft.moteScale = c.shaftMoteScale;
    _shaft.moteSize = c.shaftMoteSize;
    _shaft.moteDrift = c.shaftMoteDrift * g.noiseSpeed;

    _shaft.colorCore = c.colorShaft;
    _shaft.colorA = c.colorShaftEdge;
    _shaft.colorMote = c.colorShaftMote;
    _shaft.colorBody = c.colorShaftBody;

    this.curtain.update(this.age, _shaft);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.grovecall;

    this.leafEmitter.reset();
    this.pollenEmitter.reset();
    this._seed = Math.random() * 100;
    this._callTime = -1;
    this._callDistance = 0;

    this.field.plant(c.trees, 0);
    this.curtain.roll(this._seed);
    this.curtain.visible = true;

    this._fillShape();
    this.field.syncGeometry(this._shape);
    this._syncMaterial();
    this.field.update(this.age, this._fillParams(), 0);
    this._syncShafts(0, 0);
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** One trunk breaking the surface: roots split the floor and soil goes up. */
  _onBreach(index, position, radius, _height) {
    const c = settings.grovecall;
    const g = settings.global;
    const time = frame.uTime.value;

    _emit.position = position;
    _emit.radius = radius * 1.2;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.soilSpeed;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.75;
    _emit.life = c.soilLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 10;
    _emit.tint = null;
    _emit.time = time;
    this.soil.emit(Math.round(c.soilBreach * g.particleCount), _emit);

    this.ctx.decals.spawn(DecalType.CRACK, position, {
      radius: c.rootRadius * randRange(0.8, 1.25),
      life: c.rootLife,
      width: c.rootWidth,
      intensity: c.rootIntensity,
      colorA: getColor(c.colorRootA),
      colorB: getColor(c.colorRootB)
    });
    this.ctx.decals.spawn(DecalType.DUSTRING, position, {
      radius: c.duffRadius * randRange(0.8, 1.2),
      life: c.duffLife,
      intensity: c.duffIntensity,
      colorA: getColor(c.colorDuffA),
      colorB: getColor(c.colorDuffB)
    });

    // The canopy opening throws its own litter, from the crown rather than the
    // roots — so the two events read as one tree rather than as a floor effect
    // and a separate leaf effect.
    _pos.copy(position);
    _pos.y += this.field.heightOf(index, this._params) * 0.8;
    _emit.position = _pos;
    _emit.radius = this.field.radiusOf(index, this._params) * 1.1;
    _emit.direction = _dir.set(0, -0.2, 0);
    _emit.speed = c.leafSpeed * 1.6;
    _emit.spread = 1.0;
    _emit.size = 0.16;
    _emit.life = c.leafLifetime;
    _emit.spin = c.leafSpin;
    this.leaves.emit(Math.round(c.leafBurst * g.particleCount), _emit);
  }

  /** Root cracks laid along the floor as the call runs out to the circle. */
  _callFx() {
    const c = settings.grovecall;
    const step = 1 / Math.max(0.05, c.callRate);

    while (this.front - this._callDistance >= step) {
      this._callDistance += step;
      const s = saturate(this._callDistance / this.length);
      this.pointAt(s, _pos);
      const wander = 0.4 + s * 0.6;
      _pos.x += this.side.x * randRange(-wander, wander);
      _pos.z += this.side.z * randRange(-wander, wander);

      this.ctx.decals.spawn(DecalType.CRACK, _pos, {
        radius: c.callRadius * randRange(0.7, 1.4),
        life: c.callLife,
        width: c.rootWidth,
        intensity: c.rootIntensity * 0.7,
        colorA: getColor(c.colorRootA),
        colorB: getColor(c.colorRootB)
      });
    }
  }

  /** Leaves shedding off the canopies and pollen hanging in the beams. */
  _groveFx(dt, scale) {
    const c = settings.grovecall;
    const g = settings.global;
    const time = frame.uTime.value;
    const count = this.field.count;
    if (count < 1) return;

    const leafCount = Math.round(this.leafEmitter.tick(dt, c.leafRate * scale) * g.particleCount);
    if (leafCount > 0) {
      // Off a canopy, not off the ring: a leaf that starts at ground level and
      // rises is a spark, and the read collapses.
      const i = Math.min(count - 1, (Math.random() * count) | 0);
      const emerge = this.field.emergenceOf(i, this.age, this._params);
      if (emerge > 0.4) {
        this.field.positionOf(i, this._params, _pos);
        _pos.y += this.field.heightOf(i, this._params) * randRange(0.62, 0.98);
        _emit.position = _pos;
        _emit.radius = this.field.radiusOf(i, this._params);
        _emit.direction = _dir.set(0, -0.4, 0);
        _emit.speed = c.leafSpeed;
        _emit.speedVariance = 0.8;
        _emit.spread = 1.0;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.15;
        _emit.sizeVariance = 0.7;
        _emit.life = c.leafLifetime;
        _emit.lifeVariance = 0.45;
        _emit.spin = c.leafSpin;
        _emit.tint = null;
        _emit.time = time;
        this.leaves.emit(leafCount, _emit);
      }
    }

    const pollenCount = Math.round(this.pollenEmitter.tick(dt, c.pollenRate * scale) * g.particleCount);
    if (pollenCount > 0) {
      const angle = Math.random() * TAU;
      const r = this.radius * c.shaftSpread * Math.sqrt(Math.random());
      _pos.copy(this._centre);
      _pos.x += Math.cos(angle) * r;
      _pos.z += Math.sin(angle) * r;
      _pos.y = c.shaftTop * randRange(0.15, 0.85);
      _emit.position = _pos;
      _emit.radius = c.shaftWidth * 0.5;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.pollenSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 1.0;
      _emit.size = 0.08;
      _emit.sizeVariance = 0.6;
      _emit.life = c.pollenLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.pollen.emit(pollenCount, _emit);
    }
  }

  _syncParticles() {
    const c = settings.grovecall;
    const g = settings.global;

    this.leaves.setGradient(
      getColor(c.colorLeafA),
      getColor(c.colorLeafB),
      getColor(c.colorLeafC),
      getColor(c.colorLeafD)
    );
    this.leaves.uniforms.uGravity.value.set(0, c.leafGravity, 0);
    this.leaves.uniforms.uSizeScale.value = c.leafSize * g.particleSize * 7;
    this.leaves.uniforms.uLifeScale.value = c.leafLifetime * 0.5 * g.particleLifetime;
    this.leaves.uniforms.uSpeedScale.value = g.particleSpeed;
    this.leaves.uniforms.uOpacity.value = g.opacity;
    this.leaves.uniforms.uTurbulence.value = c.leafDrift * g.turbulence;

    this.pollen.setGradient(
      getColor(c.colorPollenA),
      getColor(c.colorPollenB),
      getColor(c.colorPollenC),
      getColor(c.colorPollenD)
    );
    this.pollen.uniforms.uGravity.value.set(0, c.pollenRise, 0);
    this.pollen.uniforms.uSizeScale.value = c.pollenSize * g.particleSize * 7;
    this.pollen.uniforms.uLifeScale.value = c.pollenLifetime * 0.5 * g.particleLifetime;
    this.pollen.uniforms.uSpeedScale.value = g.particleSpeed;
    this.pollen.uniforms.uOpacity.value = g.opacity;
    this.pollen.uniforms.uGlow.value = 0.9 * g.glow;
    this.pollen.uniforms.uTurbulence.value = c.pollenTurbulence * g.turbulence;

    this.soil.setGradient(
      getColor(c.colorSoilA),
      getColor(c.colorSoilB),
      getColor(c.colorSoilC),
      getColor(c.colorSoilD)
    );
    this.soil.uniforms.uGravity.value.set(0, c.soilGravity, 0);
    this.soil.uniforms.uSizeScale.value = c.soilSize * g.particleSize * 7;
    this.soil.uniforms.uLifeScale.value = g.particleLifetime;
    this.soil.uniforms.uSpeedScale.value = g.particleSpeed;
    this.soil.uniforms.uOpacity.value = g.opacity;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.grovecall;
    const p = this._fillParams();

    this._fillShape();
    this.field.syncGeometry(this._shape);
    this._syncMaterial();
    this._syncParticles();

    // Nothing is triggered yet; the field is entirely below the floor and its
    // matrices are parked. It is still updated every frame so a slider dragged
    // during the run-out reshapes what is about to arrive.
    this.field.update(this.age, p, 0);
    this._syncShafts(0, 0);

    this._callFx();
    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  /**
   * The call lands: a wave runs around the ring and releases the trunks.
   *
   * The bearing is taken from each tree's **live** position rather than from its
   * record's angle die, so the wave starts on the side of the ring nearest the
   * caster whatever `angleJitter` and `radialJitter` did to the layout. The
   * delays are stamped once, here, because they are events — after this frame
   * `sweepTime` no longer moves a wave that has already been dealt.
   */
  onImpact() {
    const c = settings.grovecall;
    const g = settings.global;
    const time = frame.uTime.value;
    const p = this._fillParams();

    this._callTime = this.age;

    const count = this.field.count;
    for (let i = 0; i < count; i++) {
      this.field.positionOf(i, p, _pos);
      // Bearing measured against the heading, so 0 is the far side and the
      // near side is half a turn away; the wave then breaks toward the camera.
      const bearing = Math.atan2(_pos.x - this._centre.x, _pos.z - this._centre.z);
      const heading = Math.atan2(this.direction.x, this.direction.z);
      let turn = (bearing - heading) / TAU;
      turn -= Math.floor(turn); // 0..1
      const delay = turn * c.sweepTime + hash11(i * 7.31 + this._seed) * c.sweepStagger;
      this.field.triggerIndex(this.age, i, delay);
    }

    _centre.copy(this._centre);
    _pos.copy(this._centre).setY(c.treeHeight * 0.35);

    this.ctx.bursts.spawn(BurstMode.STORM, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.8,
      intensity: c.burstIntensity,
      opacity: 0.8,
      fresnel: 1.4,
      displace: 0.6,
      squash: 0.7,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    _emit.position = _pos;
    _emit.radius = this.radius * 0.9;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.leafSpeed * 2.4;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.18;
    _emit.sizeVariance = 0.8;
    _emit.life = c.leafLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = c.leafSpin * 1.5;
    _emit.tint = null;
    _emit.time = time;
    this.leaves.emit(Math.round(c.burstLeaves * g.particleCount), _emit);

    _emit.position = _centre;
    _emit.radius = this.radius * 0.7;
    _emit.speed = c.soilSpeed * 1.5;
    _emit.size = 0.13;
    _emit.life = c.soilLifetime * 1.2;
    _emit.spin = 12;
    this.soil.emit(Math.round(c.burstSoil * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      16
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const p = this._fillParams();

    this._fillShape();
    this.field.syncGeometry(this._shape);
    this._syncMaterial();
    this._syncParticles();

    const retract = t <= 1 ? 0 : saturate(t - 1);
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(retract);

    this.field.update(this.age, p, retract);
    // The shafts hold at full while the grove stands and die with the canopies
    // that were gating them — a beam that outlives its tree reads as a bug.
    this._syncShafts(this._grown(), fade);

    this._groveFx(dt, fade * (t <= 1 ? 1 : 0.35));

    // The light sits in the middle of the grove once it has arrived.
    this.position.copy(this._centre).setY(settings.grovecall.treeHeight * 0.45);
  }

  onDestroy() {
    this.field.clear();
    this.curtain.reset();
    this._callTime = -1;
  }

  dispose() {
    this.field.dispose();
    this.curtain.dispose();
    this.material.dispose();
    super.dispose();
  }
}
