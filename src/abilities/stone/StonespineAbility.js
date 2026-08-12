import {
  BufferGeometry,
  Float32BufferAttribute,
  MeshStandardMaterial,
  Color,
  Object3D,
  Quaternion,
  Vector3
} from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { GrowthField, GrowthLayout, growthParams, patchGrowthMaterial } from '../../vfx/GrowthField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { noiseGLSL } from '../../shaders/lib/noise.glsl.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, Easing, hash11, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;

/** Hard ceiling on plates per cast. `slabCount` clamps here. */
const MAX_SLABS = 96;
/**
 * Distinct slab silhouettes. Three, for the reason `GrowthField` documents:
 * per-instance scaling buys proportion variety, only distinct geometry buys
 * *outline* variety, and a field of one plate scaled forty ways reads as a
 * repeated prop the moment the camera moves. Three draw calls is the price.
 */
const SLAB_VARIANTS = 3;

/** How many points one frame's sand is split between, so it is not a hose. */
const SAND_BATCHES = 4;

/* Module-scope scratch. Nothing in a frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _hinge = new Vector3();
const _tip = new Vector3();
const _axis = new Vector3();
const _up = new Vector3(0, 1, 0);
const _yaw = new Quaternion();
const _swing = new Quaternion();
/** Composes one plate's matrix. One object, reused for every instance. */
const _slabDummy = new Object3D();
/**
 * The transform a buried plate wears: far below the floor and all but scaled
 * out. Composed once, at module load, because it never changes — writing a
 * degenerate matrix at the origin instead leaves a speck sitting on the floor
 * for the whole of the stagger window.
 */
const _parked = new Object3D();
_parked.position.set(0, -999, 0);
_parked.scale.setScalar(0.0001);
_parked.updateMatrix();

/* ---------------------------------------------------------------------- */
/* The slab                                                                */
/* ---------------------------------------------------------------------- */

/**
 * One chunky irregular quad prism, hinged on its own origin.
 *
 * **This geometry deliberately does not use `GrowthField`'s unit space**, and
 * the departure is the trick rather than a shortcut. The library's contract is
 * "footprint inside radius 0.5 on `y = 0`, tip at `y = 1`", which is the right
 * space for something that *grows upward*. A plate does not grow upward: it
 * pivots. So the space here is
 *
 * | axis | 0 | 1 | scaled by |
 * | --- | --- | --- | --- |
 * | `x` | the hinge edge | the far edge | `reach`, metres |
 * | `y` | the torn underside | the dressed top face | `thickness`, metres |
 * | `z` | one end of the hinge | the other (`±0.5`) | `width`, metres |
 *
 * The hinge line is therefore exactly the segment `x = 0, y = 0`, which passes
 * through the instance origin — and *that* is what lets the swing be an
 * ordinary rotation in the instance's own quaternion instead of a
 * pivot-about-an-offset-point that would have to be unpicked in a shader. A
 * quaternion applied to a non-uniformly scaled body shears unless the rotation
 * comes after the scale, and `Object3D.compose` builds `T · R · S`, so it does.
 * Putting the pivot at the origin is the one decision that makes the whole
 * ability fall out of the existing matrix path.
 *
 * The second dividend is free and better than it deserves to be: `local.y`
 * now runs *through the thickness*, from the face that was underground to the
 * face that was the floor. The soil line in the fragment shader is one
 * `smoothstep` on that varying, and it needs no normal, no world-up and no
 * knowledge of how far the plate has swung.
 *
 * The hinge edge is a single straight segment because it is a *fracture*, not
 * a weathered edge — the first version sampled it with the same raggedness as
 * the other three and the plates rocked visibly on their corners as they went
 * over, which reads as a bug rather than as detail.
 *
 * @param {number} variant  which of the three silhouettes; only perturbs the seed
 * @param {object} shape    live shape sliders — see `stonespine.edgeSamples` &c.
 */
function createSlabGeometry(variant, shape) {
  const s = shape ?? {};
  const samples = Math.max(6, Math.min(22, Math.round(s.edgeSamples ?? 12)));
  const ragged = Math.max(0, s.ragged ?? 0.3);
  const chamfer = clamp(s.chamfer ?? 0.18, 0, 0.6);
  const inset = clamp(s.topInset ?? 0.16, 0, 0.5);
  const tear = clamp(s.tear ?? 0.36, 0, 0.9);
  const seed = 4.1 + variant * 19.7;

  /* --- the outline, walked from one hinge corner round to the other --- */
  const px = new Float64Array(samples);
  const pz = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    let x;
    let z;
    if (t < 0.36) {
      x = t / 0.36;
      z = -0.5;
    } else if (t < 0.64) {
      x = 1;
      z = -0.5 + (t - 0.36) / 0.28;
    } else {
      x = 1 - (t - 0.64) / 0.36;
      z = 0.5;
    }

    // Independent jitter on both axes rather than a radial push: a radial push
    // off the centroid rounds the plate into a lozenge and loses the corners,
    // and the corners are most of what says "this was broken, not cast".
    x += (hash11(seed * 3.7 + i * 5.31) - 0.5) * ragged * 0.34;
    z += (hash11(seed * 9.13 + i * 2.87) - 0.5) * ragged * 0.3;

    // The two hinge corners are pinned: the fracture is a straight line.
    if (i === 0 || i === samples - 1) x = 0;
    px[i] = Math.max(0, x);
    pz[i] = z;
  }

  let cx = 0;
  let cz = 0;
  for (let i = 0; i < samples; i++) {
    cx += px[i];
    cz += pz[i];
  }
  cx /= samples;
  cz /= samples;

  /* --- three rings: torn bottom, shoulder, inset top --- */
  const shoulderY = 1 - chamfer;
  const shrink = Math.min(0.45, inset * chamfer * 1.8);

  const bx = new Float64Array(samples);
  const bz = new Float64Array(samples);
  const by = new Float64Array(samples);
  const tx = new Float64Array(samples);
  const tz = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    bx[i] = px[i];
    bz[i] = pz[i];
    // The underside was torn out of the ground, so it is ragged — except along
    // the hinge, which has to stay flat on the floor or the plate rocks.
    const hold = Math.min(1, px[i] / 0.3);
    by[i] = tear * hash11(seed * 13.9 + i * 7.13) * hold;
    tx[i] = lerp(px[i], cx, shrink);
    tz[i] = lerp(pz[i], cz, shrink);
  }

  const positions = [];
  const push = (x, y, z) => positions.push(x, y, z);
  /**
   * Winding note, because getting it wrong costs an hour of black facets:
   * `computeVertexNormals` derives the normal from `(b−a)×(c−a)`, and the
   * outline above has a *positive* shoelace area in (x, z), which means a fan
   * taken in outline order faces **−Y**. The top face is therefore wound
   * backwards and the walls are wound `bottom → top → top → bottom`.
   */
  for (let i = 0; i < samples; i++) {
    const j = (i + 1) % samples;
    // the flank: torn underside up to the shoulder
    push(bx[i], by[i], bz[i]);
    push(bx[i], shoulderY, bz[i]);
    push(bx[j], shoulderY, bz[j]);
    push(bx[i], by[i], bz[i]);
    push(bx[j], shoulderY, bz[j]);
    push(bx[j], by[j], bz[j]);
    // the bevel: shoulder out to the inset top rim
    push(bx[i], shoulderY, bz[i]);
    push(tx[i], 1, tz[i]);
    push(tx[j], 1, tz[j]);
    push(bx[i], shoulderY, bz[i]);
    push(tx[j], 1, tz[j]);
    push(bx[j], shoulderY, bz[j]);
  }

  const bottomY = tear * 0.5;
  for (let i = 0; i < samples; i++) {
    const j = (i + 1) % samples;
    // top face — reversed, see the winding note
    push(cx, 1, cz);
    push(tx[j], 1, tz[j]);
    push(tx[i], 1, tz[i]);
    // underside
    push(cx, bottomY, cz);
    push(bx[i], by[i], bz[i]);
    push(bx[j], by[j], bz[j]);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  // Non-indexed with per-face normals: this is what keeps the facets crisp and
  // what makes a tilted plate catch the key light on one flank and not the other.
  geometry.computeVertexNormals();
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* The material                                                            */
/* ---------------------------------------------------------------------- */

/**
 * Dusty quarried stone with a dirty underside.
 *
 * A patched `MeshStandardMaterial` rather than a `ShaderMaterial`, for the
 * reason `IceMaterial` is: the plates have to take the stage's real shadows and
 * its HDR probe, because a slab of floor that does not sit in the same light as
 * the floor it came out of reads as a prop dropped into the scene.
 *
 * Three terms carry it:
 *
 *  - **the soil line** — `vGrowLocal.y` runs from the torn underside to the
 *    dressed top face, so "was this underground thirty frames ago" is one
 *    `smoothstep`. Everything below the line gets earth, deep crevice shadow
 *    and a rougher surface; everything above it stays the pale dressed floor.
 *  - **the quarry mottle** — sampled in **world** space, deliberately. The
 *    first version sampled it in local space and every plate wore the identical
 *    birthmark scaled to its own size, which reads as forty copies of one prop
 *    the instant two of them sit side by side.
 *  - **the dust film** — keyed off the *world* up-component of the resolved
 *    normal, which needs the view→world rotation because `normal` in a standard
 *    fragment shader is in view space. A plate that has gone past vertical
 *    loses its film, which is a surprisingly strong cue for how far over it is.
 */
function createSlabMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.88,
    metalness: 0.0,
    flatShading: true,
    // Opaque: stone occludes, writes depth, and lets the dust fade softly
    // against it. Transparency here would only cost sorting.
    transparent: false,
    depthWrite: true
  });

  const uniforms = {
    uColorFace: { value: new Color() },
    uColorFlank: { value: new Color() },
    uColorSoil: { value: new Color() },
    uColorSoilDeep: { value: new Color() },
    uColorDust: { value: new Color() },
    uSoilLine: { value: 0.74 },
    uSoilBlur: { value: 0.2 },
    uSoilSmear: { value: 0.3 },
    uGrain: { value: 0.55 },
    uGrainScale: { value: 3.2 },
    uSpeckle: { value: 0.5 },
    uSpeckleScale: { value: 24 },
    uDamp: { value: 0.45 },
    uDustFilm: { value: 0.4 },
    uRim: { value: 0.5 },
    uRimPower: { value: 2.6 },
    uRoughFace: { value: 0.82 },
    uRoughSoil: { value: 0.98 },
    uBirthDust: { value: 0.9 },
    uGlow: { value: 1.0 }
  };

  patchGrowthMaterial(material, {
    environment,
    uniforms,
    common: /* glsl */ `
      uniform vec3  uColorFace;
      uniform vec3  uColorFlank;
      uniform vec3  uColorSoil;
      uniform vec3  uColorSoilDeep;
      uniform vec3  uColorDust;
      uniform float uSoilLine;
      uniform float uSoilBlur;
      uniform float uSoilSmear;
      uniform float uGrain;
      uniform float uGrainScale;
      uniform float uSpeckle;
      uniform float uSpeckleScale;
      uniform float uDamp;
      uniform float uDustFilm;
      uniform float uRim;
      uniform float uRimPower;
      uniform float uRoughFace;
      uniform float uRoughSoil;
      uniform float uBirthDust;
      uniform float uGlow;
      ${noiseGLSL}
    `,
    fragment: /* glsl */ `
      vec3  N   = normalize(normal);
      float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);

      // normal is in VIEW space here. The view matrix is orthonormal in its
      // rotation block, so its transpose is its inverse and each world
      // component is a dot with one column.
      vec3 wN = normalize(vec3(
        dot(viewMatrix[0].xyz, N),
        dot(viewMatrix[1].xyz, N),
        dot(viewMatrix[2].xyz, N)
      ));

      // The soil line. Local y is 0 on the torn underside and 1 on the face
      // that was the floor, so this one term is the whole conceit.
      float blur = max(uSoilBlur, 0.002);
      float dressed = smoothstep(uSoilLine - blur, uSoilLine + blur, vGrowLocal.y);

      // Earth slopped over the hinge and onto the top face as the plate swung.
      float smear = (1.0 - smoothstep(0.0, max(uSoilSmear, 0.001), vGrowLocal.x)) *
                    smoothstep(0.3, 0.8, snoise01(vGrowLocal * 7.0 + vGrowSeed * 4.0));
      dressed *= 1.0 - clamp(smear, 0.0, 1.0);

      float mottle = fbm3(vGrowWorld * uGrainScale + vGrowSeed * 13.0) * 0.5 + 0.5;
      float crevice = smoothstep(0.6, 0.0, vGrowLocal.y) * (0.35 + 0.65 * (1.0 - mottle));

      vec3 body = mix(uColorSoil, uColorFace, dressed);
      body = mix(body, uColorFlank, (1.0 - dressed) * smoothstep(0.2, 0.85, vGrowLocal.y));
      body = mix(body, uColorSoilDeep, clamp(crevice * uDamp, 0.0, 1.0));
      body *= mix(1.0, 0.62 + 0.76 * mottle, clamp(uGrain, 0.0, 2.0));

      float sky = clamp(wN.y, 0.0, 1.0);
      body = mix(body, uColorDust, sky * sky * clamp(uDustFilm, 0.0, 1.0) * 0.6);

      diffuseColor.rgb *= body;
      roughnessFactor = mix(uRoughSoil, uRoughFace, dressed);

      float fleck = snoise01(vGrowWorld * uSpeckleScale + vGrowSeed * 29.0);
      fleck = pow(clamp(fleck, 0.0, 1.0), 16.0);

      vec3 glow = uColorDust * fleck * uSpeckle * sky;
      glow += uColorDust * pow(1.0 - ndv, uRimPower) * uRim * dressed;
      glow += uColorDust * vGrowBirth * uBirthDust;
      glow *= uGlow;
      // Reinhard ceiling, as the ice does: the three terms above all peak on the
      // silhouette and without this a corner facet sums past white and the bloom
      // pass smears the whole plate.
      glow /= 1.0 + glow * 0.3;
      totalEmissiveRadiance += glow;
    `
  });

  // I8 — the pause test reads uniforms from here, because a patched standard
  // material has no `material.uniforms` until a GL context compiles it.
  material.userData.uniforms = uniforms;

  /** Pull the palette and every shading control from the live settings. */
  material.userData.sync = () => {
    const c = settings.stonespine;
    const g = settings.global;

    uniforms.uColorFace.value.copy(getColor(c.colorFace));
    uniforms.uColorFlank.value.copy(getColor(c.colorFlank));
    uniforms.uColorSoil.value.copy(getColor(c.colorSoil));
    uniforms.uColorSoilDeep.value.copy(getColor(c.colorSoilDeep));
    uniforms.uColorDust.value.copy(getColor(c.colorDust));

    uniforms.uSoilLine.value = c.soilLine;
    uniforms.uSoilBlur.value = c.soilBlur;
    uniforms.uSoilSmear.value = c.soilSmear;
    uniforms.uGrain.value = c.grain * g.shaderIntensity;
    uniforms.uGrainScale.value = c.grainScale * g.noiseFrequency;
    uniforms.uSpeckle.value = c.speckle * g.shaderIntensity;
    uniforms.uSpeckleScale.value = c.speckleScale * g.noiseFrequency;
    uniforms.uDamp.value = c.damp;
    uniforms.uDustFilm.value = c.dustFilm;
    uniforms.uRim.value = c.rim * g.fresnel;
    uniforms.uRimPower.value = c.rimPower;
    uniforms.uRoughFace.value = c.roughFace;
    uniforms.uRoughSoil.value = c.roughSoil;
    uniforms.uBirthDust.value = c.birthDust;
    uniforms.uGlow.value = c.glow * g.glow;

    material.opacity = c.opacity * g.opacity;
    material.envMapIntensity = c.envIntensity;
  };

  material.userData.sync();
  return material;
}

/* ---------------------------------------------------------------------- */
/* SlabField — GrowthField with a hinge instead of a push                  */
/* ---------------------------------------------------------------------- */

/**
 * `GrowthField` with its emergence re-read as a **swing**.
 *
 * The library ships two emerge modes, `PUSH` (slide up out of the floor) and
 * `SCALE` (accrete in place), and neither of them is a hinge. Rather than add a
 * third mode to a file eleven other abilities are being written against, this
 * subclass keeps every line of the library that is about *bookkeeping* —
 * planting, the front trigger, the stagger, the springy overshoot, the record
 * pool, the shape-rebuild hash, the per-instance birth attribute — and replaces
 * exactly one method: `update()`, the one that decides what an instance's
 * matrix is.
 *
 * It is written entirely against the base class's **public** read-back API
 * (`positionOf` / `heightOf` / `radiusOf` / `emergenceOf`), so every dimension
 * it composes is still resolved from the live params on the frame it is drawn,
 * including a zero-length one. Nothing here caches a metre.
 *
 * The mapping from library vocabulary to plate vocabulary:
 *
 * | library | here |
 * | --- | --- |
 * | `heightOf` | `reach` — hinge to far edge, and so how tall the plate stands |
 * | `radiusOf` | half the plate's width across the hinge |
 * | `emergenceOf` | the swing, 0 → 1 with an overshoot that rocks it |
 * | `positionOf` | the plate's *site*; the hinge sits `hingeShift` reaches behind it |
 */
class SlabField extends GrowthField {
  constructor(parent, options) {
    super(parent, options);
    /** Swing of the last plate resolved, radians. Read by `sampleTop`. */
    this._theta = 0;
    /** Reach, thickness and half-width of the last plate resolved, metres. */
    this._reach = 1;
    this._thick = 0.2;
    this._half = 0.5;
  }

  /**
   * Resolve one plate's world frame into the module scratch.
   *
   * Writes `_hinge` (the world point the plate pivots about), `_tip` (the flat
   * unit bearing the far edge points along before the swing) and `_axis` (the
   * world hinge line). Returns the swing in radians.
   *
   * The bearing is the ability's one interesting dice roll: `record.yaw` is a
   * unitless 0..1 that never changes for the life of a cast, and `hingeAlign`
   * — a live slider — blends it toward the cast heading. At 0 every plate picks
   * its own way to fall over and the field reads as broken river ice; at 1 they
   * all comb downrange and it reads as a flight of stairs. Blending the two
   * *vectors* rather than the two angles matters: angles wrap at ±π and a plate
   * whose random bearing landed just the wrong side of the seam would spin the
   * long way round as the slider moved.
   */
  _resolveFrame(record, index, now, p) {
    const jitter = p.randomness ?? 1;
    const direction = p.direction ?? _up;

    const bearing = record.yaw * TAU;
    _tip.set(Math.cos(bearing), 0, Math.sin(bearing));
    const align = saturate(p.hingeAlign ?? 0);
    if (align > 0) {
      _tip.x = lerp(_tip.x, direction.x, align);
      _tip.z = lerp(_tip.z, direction.z, align);
      _tip.y = 0;
    }
    if (_tip.lengthSq() < 1e-8) _tip.copy(direction);
    _tip.normalize();

    // −(up × tip): the sign that makes a positive swing lift the far edge
    // rather than drive it into the floor. Getting it the other way round is
    // invisible on a still frame and unmistakable in motion.
    _axis.set(-_tip.z, 0, _tip.x);

    this._reach = this.heightOf(index, p);
    this._half = this.radiusOf(index, p);
    this._thick = Math.max(
      0.01,
      (p.slabThickness ?? 0.2) * (1 + record.radiusRoll * (p.slabThicknessJitter ?? 0) * jitter)
    );

    const emerge = this.emergenceOf(index, now, p);
    const settled = Math.min(1, Math.max(0, emerge));

    // The swing rides the raw emergence, overshoot included, so the plate rocks
    // past its final angle and back as it slams home. Driving it off the
    // clamped value instead gave a plate that arrived and simply stopped, which
    // is the one thing a two-tonne slab does not do.
    let theta =
      (p.hingeAngle ?? 0.9) *
      Math.max(0, emerge) *
      (1 + record.leanRoll * (p.hingeJitter ?? 0) * jitter);

    const retract = saturate(p.slabRetract ?? 0);
    if (retract > 0) theta *= 1 - saturate(retract * 1.6);

    this.positionOf(index, p, _hinge);
    _hinge.addScaledVector(_tip, -this._reach * (p.hingeShift ?? 0));
    _hinge.y +=
      (p.heave ?? 0) * Math.max(0, emerge) -
      (1 - settled) * (this._thick + (p.burial ?? 0.4));
    if (retract > 0) {
      _hinge.y -= Easing.inCubic(retract) * (this._thick + (p.sinkDepth ?? 0.4) + (p.heave ?? 0));
    }

    this._theta = Math.max(0, theta);
    return this._theta;
  }

  /**
   * A world point on a plate's top face, and the direction rubble slides in.
   *
   * `u` runs 0 at the hinge to 1 at the far edge. The slide direction is the
   * downhill tangent of the tilted face, which points *back toward the hinge* —
   * the far edge is the high one — so grit shed off a plate falls into the seam
   * it came out of rather than off the end, which is what it does in life.
   *
   * @returns {number} the plate's swing in radians, or -1 if it is still buried
   */
  sampleTop(index, u, now, p, outPoint, outSlide) {
    if (index < 0 || index >= this.count) return -1;
    if (this.emergenceOf(index, now, p) < 0) return -1;

    const theta = this._resolveFrame(this.records[index], index, now, p);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);

    // The unswung offset from the hinge is `tip · reach·u + up · thickness`;
    // the swing sends `tip → tip cosθ + up sinθ` and `up → up cosθ − tip sinθ`.
    const along = this._reach * saturate(u);
    outPoint.copy(_hinge);
    outPoint.addScaledVector(_tip, along * cos - this._thick * sin);
    outPoint.y += along * sin + this._thick * cos;

    outSlide.copy(_tip).multiplyScalar(-cos);
    outSlide.y = -sin;
    if (outSlide.lengthSq() < 1e-8) outSlide.set(0, -1, 0);
    outSlide.normalize();
    return theta;
  }

  /**
   * Rebuild every plate's matrix from the live params. Allocation-free.
   *
   * The composition is `T · R_axis(θ) · R_up(φ) · S`. Reading it right to left:
   * scale the unit prism to metres, yaw it so its local `+X` lies along the
   * plate's bearing (and so its local `+Z`, the hinge edge, lies along the hinge
   * line), swing it about that world hinge line, and put the hinge where it
   * belongs. Because `Object3D.compose` multiplies in exactly that order, the
   * non-uniform scale never sees the rotation and a metre-wide plate stays a
   * rectangle however far over it goes.
   */
  update(now, p, retract = 0) {
    const variants = this.variants;
    const used = this._used;
    used.fill(0);

    const birthFade = Math.max(0.02, p.birthFade ?? 0.18);
    p.slabRetract = retract;

    for (let i = 0; i < this.count; i++) {
      const record = this.records[i];
      const variant = i % variants;
      const slot = (i / variants) | 0;
      const emerge = this.emergenceOf(i, now, p);

      if (emerge < 0) {
        // Still buried. Parked far below rather than drawn degenerate at the
        // origin, which shows up as a speck on the floor.
        this.meshes[variant].setMatrixAt(slot, _parked.matrix);
        this.birthAttributes[variant].array[slot] = 0;
        used[variant] = Math.max(used[variant], slot + 1);
        continue;
      }

      const theta = this._resolveFrame(record, i, now, p);
      const settled = Math.min(1, emerge);
      const scale = lerp(p.birthScale ?? 0.86, 1, settled);

      _yaw.setFromAxisAngle(_up, Math.atan2(-_tip.z, _tip.x));
      _swing.setFromAxisAngle(_axis, theta);
      _swing.multiply(_yaw);

      _slabDummy.position.copy(_hinge);
      _slabDummy.quaternion.copy(_swing);
      _slabDummy.scale.set(this._reach, this._thick, this._half * 2).multiplyScalar(scale);
      _slabDummy.updateMatrix();
      this.meshes[variant].setMatrixAt(slot, _slabDummy.matrix);
      this.birthAttributes[variant].array[slot] = saturate(1 - (now - record.eruptTime) / birthFade);
      used[variant] = Math.max(used[variant], slot + 1);

      /* --- the moment the plate cracks the floor --- */
      if (!record.breached && emerge > (p.breachAt ?? 0.25)) {
        record.breached = true;
        if (this.onBreach) this.onBreach(i, _hinge, this._half, this._reach);
      }
    }

    for (let v = 0; v < variants; v++) {
      this.meshes[v].count = used[v];
      this.meshes[v].instanceMatrix.needsUpdate = true;
      this.birthAttributes[v].needsUpdate = true;
    }
  }
}

/* ---------------------------------------------------------------------- */
/* The ability                                                             */
/* ---------------------------------------------------------------------- */

/**
 * STONESPINE — plates, not spikes.
 *
 * A heave front runs the aimed line and slabs of floor tear loose behind it.
 * Each one is **hinged along a single edge**: it does not rise, it swings, so
 * the face that comes up is the one that was underground — filthy, torn, and
 * with a hard dirt line where it used to be flush with your feet. Grit that was
 * sitting on top slides off toward the hinge as the plate goes over, and a puff
 * of dust breaks out of the seam it left. The field holds, then the plates drop
 * back flat and sink.
 *
 * **THE TRICK is the hinge, and it is a matrix, not a shader.** The slab
 * geometry puts its pivot edge on the instance origin (see
 * `createSlabGeometry`), which turns "rotate this plate about a world-space
 * line" into an ordinary quaternion in the instance transform — and because
 * `Object3D.compose` builds `T · R · S`, the rotation is applied *after* the
 * non-uniform scale, so a two-metre plate a hand's width thick stays a
 * rectangle at any angle. The first attempt did the swing in the vertex shader
 * on top of `GrowthField`'s PUSH mode, and it sheared: a rotation applied
 * before a non-uniform scale turns a rectangle into a parallelogram, and the
 * plates looked like they were made of rubber.
 *
 * The hinge *bearing* is a per-instance dice roll (`record.yaw`, unitless, 0..1,
 * rolled once per cast) and the hinge *angle* is a live curve along the cast
 * (`hingeAngle` × the emergence, overshoot included). `hingeAlign` blends the
 * bearing toward the cast heading, which is the single control that takes the
 * field from broken river ice to a flight of stairs.
 *
 * **The rule that makes the editor work.** A cast captures a count, one bearing
 * roll and a handful of unitless jitters per plate, and one timestamp each.
 * Not a metre, not a radian, not a second. `hingeAngle`, `reach`, `thickness`,
 * `heave` and every colour are resolved against `settings.stonespine` inside
 * `SlabField.update()`, which runs on a zero-length frame too — so dragging the
 * swing on a field that has already finished standing swings all forty-four
 * plates with the clock stopped.
 */
export class StonespineAbility extends Ability {
  constructor(context) {
    super('stonespine', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.material = createSlabMaterial(this.ctx.environment);

    /** Live shape params for the geometry factory. Mutated, never replaced. */
    this._shape = {
      edgeSamples: 12,
      ragged: 0.3,
      chamfer: 0.18,
      topInset: 0.16,
      tear: 0.36
    };
    this._readShape();

    /** Live growth params. One object, refilled every frame — invariant I3. */
    this._growth = growthParams();
    this._growth.layout = GrowthLayout.LINE;

    this.field = new SlabField(this.group, {
      geometry: createSlabGeometry,
      material: this.material,
      shape: this._shape,
      variants: SLAB_VARIANTS,
      capacity: MAX_SLABS,
      renderOrder: 2
    });

    // Assigned once, at construction: a closure built inside the update loop is
    // an allocation per plate per frame, which is exactly what I3 forbids.
    this.field.onBreach = (index, position, half, reach) =>
      this._breachFx(index, position, half, reach);

    /** Where the last sand batch was sampled. Scratch, not state. */
    this._sandPoint = new Vector3();
    this._sandSlide = new Vector3();
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The rolling ground dust. Non-additive so it genuinely occludes — half of
    // what sells a stone effect is that you cannot see through the cloud.
    this.dust = particles.get('stonespine.dust', {
      capacity: 2600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.2
    });
    this.dust.uniforms.uDrag.value = 2.1;
    this.dust.uniforms.uEndSize.value = 3.6;
    this.dust.uniforms.uSizeIn.value = 0.12;
    this.dust.uniforms.uFadeIn.value = 0.15;
    this.dust.uniforms.uFadeOut.value = 0.32;

    // Chips thrown out of the seam. Lit, because a rock fragment that does not
    // take the key light reads as a floating decal.
    this.grit = particles.get('stonespine.grit', {
      capacity: 2000,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.grit.uniforms.uDrag.value = 0.24;
    this.grit.uniforms.uEndSize.value = 0.85;
    this.grit.uniforms.uFadeOut.value = 0.7;

    // The fine stuff that slides off the tilted top faces. Soft and small: this
    // is the particle system that does the most for the trick, because rubble
    // running downhill off a plate is only possible if the plate has a slope.
    this.sand = particles.get('stonespine.sand', {
      capacity: 2200,
      shape: ParticleShape.SOFT,
      additive: false,
      curl: true,
      softFade: 0.5
    });
    this.sand.uniforms.uDrag.value = 1.2;
    this.sand.uniforms.uEndSize.value = 0.5;
    this.sand.uniforms.uSizeIn.value = 0.06;
    this.sand.uniforms.uFadeIn.value = 0.05;
    this.sand.uniforms.uFadeOut.value = 0.45;

    this.dustEmitter = new RateEmitter();
    this.gritEmitter = new RateEmitter();
    this.sandEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.field.count;
  }

  get impactDuration() {
    return Math.max(0.2, settings.stonespine.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    const c = settings.stonespine;
    return Math.max(0.2, c.sinkDelay + c.sinkTime);
  }

  /** Stone does not gutter. A slow settle on the dust light is all it gets. */
  lightShimmer() {
    return 0.92 + 0.08 * Math.sin(this.age * 4.1);
  }

  /* ------------------------------------------------------------------ */
  /* Live resolution — every metre comes from here                        */
  /* ------------------------------------------------------------------ */

  /** Shape sliders → the geometry factory's params. Rebuilds only on a change. */
  _readShape() {
    const c = settings.stonespine;
    const s = this._shape;
    s.edgeSamples = c.edgeSamples;
    s.ragged = c.ragged;
    s.chamfer = c.chamfer;
    s.topInset = c.topInset;
    s.tear = c.tear;
    return s;
  }

  /**
   * Refill the growth params from the live block.
   *
   * Called before every `update()`, including on a paused frame. Note the two
   * renamings: the library's `height` is this ability's `reach` (the plate
   * pivots, so its "height" is the dimension that swings up) and its `radius` is
   * half a plate's width across the hinge.
   */
  _readGrowth() {
    const c = settings.stonespine;
    const g = settings.global;
    const p = this._growth;

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

    p.heightNear = c.reachNear;
    p.height = c.reach;
    p.heightCurve = c.reachCurve;
    p.heightJitter = c.reachJitter;
    p.minHeight = c.minReach;
    p.crown = c.crown;
    p.crownPower = c.crownPower;
    p.peak = c.peak;
    p.peakWidth = c.peakWidth;
    p.rubble = c.rubble;
    p.rubbleScale = c.rubbleScale;
    p.rubbleSpread = c.rubbleSpread;

    p.radiusNear = c.plateWidth;
    p.radius2 = c.plateWidthFar;
    p.radiusCurve = c.plateWidthCurve;
    p.radiusJitter = c.plateWidthJitter;
    p.minRadius = c.minWidth;

    p.riseTime = c.riseTime;
    p.riseOvershoot = c.riseOvershoot;
    p.settle = c.settle;
    p.springRate = c.springRate;
    p.birthScale = c.birthScale;
    p.birthFade = c.birthFade;
    p.breachAt = c.breachAt;
    p.sinkDepth = c.sinkDepth;
    p.randomness = g.randomness;

    /* --- the hinge: keys the library has never heard of --- */
    p.slabThickness = c.thickness;
    p.slabThicknessJitter = c.thicknessJitter;
    p.hingeAngle = c.hingeAngle;
    p.hingeJitter = c.hingeJitter;
    p.hingeAlign = c.hingeAlign;
    p.hingeShift = c.hingeShift;
    p.heave = c.heave;
    p.burial = c.burial;

    return p;
  }

  /** Push the live palette into the slab material and the three gradients. */
  _syncUniforms() {
    const c = settings.stonespine;
    const g = settings.global;

    this.material.userData.sync();
    this.field.syncGeometry(this._readShape());

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

    this.sand.setGradient(
      getColor(c.colorSandA),
      getColor(c.colorSandB),
      getColor(c.colorSandC),
      getColor(c.colorSandD)
    );
    this.sand.uniforms.uGravity.value.set(0, c.sandFall, 0);
    this.sand.uniforms.uSizeScale.value = c.sandSize * g.particleSize * 7;
    this.sand.uniforms.uLifeScale.value = c.sandLifetime * 0.5 * g.particleLifetime;
    this.sand.uniforms.uSpeedScale.value = c.sandSpeed * g.particleSpeed;
    this.sand.uniforms.uOpacity.value = g.opacity;
    this.sand.uniforms.uTurbulence.value = c.sandTurbulence * g.turbulence;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.stonespine;

    this.dustEmitter.reset();
    this.gritEmitter.reset();
    this.sandEmitter.reset();

    // The only dice roll in the ability, and the only thing a cast captures
    // beyond timestamps: which plate goes where and which way each one falls.
    this.field.plant(Math.round(c.slabCount), c.clusterShare);

    this._syncUniforms();
    this.field.update(this.age, this._readGrowth(), 0);
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * The seam opening: a puff of dust out of the crack, chips off the lip, a
   * fracture mark and a ground-hugging ring.
   *
   * Fired by `SlabField` the frame a plate passes `breachAt`, so it lands on the
   * hinge line rather than under the plate's centre — the dust comes out of the
   * gap the plate left, which is the only place it can come from.
   */
  _breachFx(index, position, half, reach) {
    const c = settings.stonespine;
    const g = settings.global;
    const time = frame.uTime.value;

    _pos.copy(position);
    _pos.y = 0.06;

    _emit.position = _pos;
    _emit.radius = half * 0.9;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.25).setY(1).normalize();
    _emit.speed = c.gritSpeed;
    _emit.speedVariance = 0.75;
    _emit.spread = 0.8;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.11;
    _emit.sizeVariance = 0.7;
    _emit.life = c.gritLifetime;
    _emit.lifeVariance = 0.45;
    _emit.spin = 8;
    _emit.tint = null;
    _emit.time = time;
    this.grit.emit(Math.round(c.breachGrit * g.particleCount), _emit);

    _emit.radius = half * 1.2;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dustSpeed;
    _emit.speedVariance = 0.7;
    _emit.spread = 1.0;
    _emit.size = 0.75;
    _emit.sizeVariance = 0.5;
    _emit.life = c.dustLifetime * 0.8;
    _emit.spin = 0.4;
    this.dust.emit(Math.round(c.breachDust * g.particleCount), _emit);

    // Only a share of the plates mark the floor. Forty fracture decals stacked
    // on one another turns the whole band into a flat black smear and buries the
    // silhouette, which is the thing worth looking at.
    if (hash11(index * 7.31 + 1.7) < 0.55) {
      this.ctx.decals.spawn(DecalType.CRACK, _pos, {
        radius: c.crackRadius * (0.7 + reach * 0.12),
        life: c.crackLife,
        width: c.crackWidth,
        intensity: c.crackIntensity,
        colorA: getColor(c.colorCrack),
        colorB: getColor(c.colorCrackEdge),
        height: 0.014
      });
    }
    if (hash11(index * 3.97 + 11.3) < 0.4) {
      this.ctx.decals.spawn(DecalType.DUSTRING, _pos, {
        radius: c.ringRadius,
        life: c.ringLife,
        intensity: 0.8,
        colorA: getColor(c.colorRingA),
        colorB: getColor(c.colorRingB),
        height: 0.018
      });
    }
  }

  /**
   * Continuous shedding: dust and chips along the travelling front, and sand
   * running downhill off the plates that are already over.
   *
   * @param {number} scale 0..1 — thinned out once the field is only standing
   */
  _fieldFx(dt, scale) {
    const c = settings.stonespine;
    const g = settings.global;
    const time = frame.uTime.value;
    const reach = this.phase === AbilityPhase.TRAVEL ? Math.max(0.02, this.u) : 1;

    const dustCount = Math.round(this.dustEmitter.tick(dt, c.dustRate * scale) * g.particleCount);
    if (dustCount > 0) {
      this.pointAt(Math.random() * reach, _pos).setY(0.12);
      _emit.position = _pos;
      _emit.radius = lerp(c.widthNear, c.width, reach) * 0.9;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.9;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.4;
      _emit.tint = null;
      _emit.time = time;
      this.dust.emit(dustCount, _emit);
    }

    const gritCount = Math.round(this.gritEmitter.tick(dt, c.gritRate * scale) * g.particleCount);
    if (gritCount > 0) {
      this.pointAt(Math.random() * reach, _pos).setY(0.08);
      _emit.position = _pos;
      _emit.radius = lerp(c.widthNear, c.width, reach) * 0.7;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.3).setY(1).normalize();
      _emit.speed = c.gritSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = 0.85;
      _emit.size = 0.1;
      _emit.life = c.gritLifetime;
      _emit.spin = 9;
      _emit.time = time;
      this.grit.emit(gritCount, _emit);
    }

    /* --- rubble sliding off the top faces --- */
    let sandCount = Math.round(this.sandEmitter.tick(dt, c.sandRate * scale) * g.particleCount);
    const live = this.field.count;
    if (sandCount > 0 && live > 0) {
      const p = this._growth;
      const batches = Math.min(sandCount, SAND_BATCHES);
      const per = Math.ceil(sandCount / batches);
      _emit.speedVariance = 0.6;
      _emit.spread = 0.45;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.6;
      _emit.life = c.sandLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      while (sandCount > 0) {
        const index = Math.floor(Math.random() * live);
        const theta = this.field.sampleTop(
          index,
          randRange(0.25, 1),
          this.age,
          p,
          this._sandPoint,
          this._sandSlide
        );
        // A plate that has barely moved has nothing to shed: the slope *is* the
        // permission. Without this gate the sand poured off flat floor plates
        // and the effect read as a leak rather than as a slide.
        if (theta > 0.12) {
          _emit.position = this._sandPoint;
          _emit.radius = 0.12;
          _emit.direction = this._sandSlide;
          _emit.speed = c.sandSpeed * (0.4 + Math.sin(Math.min(theta, Math.PI * 0.5)));
          this.sand.emit(Math.min(per, sandCount), _emit);
        }
        sandCount -= per;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.stonespine;
    this._syncUniforms();

    const p = this._readGrowth();
    this.field.triggerUpTo(this.age, this.u, c.riseStagger, c.frontBias, false);
    this.field.update(this.age, p, 0);

    this._fieldFx(dt, 1);
    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.stonespine;
    const g = settings.global;
    const time = frame.uTime.value;

    // Everything still buried goes now, the terminal ring included.
    this.field.triggerUpTo(this.age, 1, c.riseStagger, c.frontBias, true);

    this.pointAt(1, _pos).setY(0.5);

    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.burstSize * 0.3,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 1.0,
      intensity: c.burstIntensity,
      opacity: 0.9,
      fresnel: 1.1,
      displace: 0.7,
      squash: 0.7,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.pointAt(1, _pos);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.7,
      width: 0.07,
      intensity: 0.85,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });
    this.ctx.decals.spawn(DecalType.CRACK, _pos, {
      radius: c.crackRadius * 2.6,
      life: c.crackLife * 1.4,
      width: c.crackWidth,
      intensity: c.crackIntensity * 1.3,
      colorA: getColor(c.colorCrack),
      colorB: getColor(c.colorCrackEdge),
      height: 0.014
    });

    _pos.y = 0.4;
    _emit.position = _pos;
    _emit.radius = c.clusterRadius * 0.8;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.gritSpeed * 1.8;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.15;
    _emit.sizeVariance = 0.8;
    _emit.life = c.gritLifetime * 1.4;
    _emit.lifeVariance = 0.5;
    _emit.spin = 11;
    _emit.tint = null;
    _emit.time = time;
    this.grit.emit(Math.round(c.burstGrit * g.particleCount), _emit);

    _emit.speed = c.dustSpeed * 2.6;
    _emit.spread = 1.0;
    _emit.size = 1.6;
    _emit.life = c.dustLifetime * 1.4;
    _emit.spin = 0.5;
    this.dust.emit(Math.round(c.burstDust * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      15
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.4 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.stonespine;
    this._syncUniforms();

    // `t` runs 0..1 while the field stands, then 1..2 while it falls back.
    let retract = 0;
    if (this.phase === AbilityPhase.FADE) {
      retract = saturate((this.fadeTime - c.sinkDelay) / Math.max(0.05, c.sinkTime));
    }

    const p = this._readGrowth();
    this.field.update(this.age, p, retract);

    // The field keeps trickling while it stands and stops as it drops back:
    // plates that are already flat have no slope for anything to run down.
    if (retract < 0.7) this._fieldFx(dt, (t <= 1 ? 0.45 : 0.2) * (1 - retract));

    this.pointAt(1, this.position);
  }

  onDestroy() {
    this.field.clear();
  }

  dispose() {
    this.field.dispose();
    this.material.dispose();
    super.dispose();
  }
}
