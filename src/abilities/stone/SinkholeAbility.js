import {
  AlwaysDepth,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  ShaderMaterial,
  Vector3
} from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { Projectile, FlightMode, Stagger, projectileParams } from '../../vfx/Projectile.js';
import { createAsteroidGeometry } from '../../assets/ProceduralGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { noiseGLSL } from '../../shaders/lib/noise.glsl.js';
import { sharedUniforms, frame } from '../../core/FrameUniforms.js';
import { LAYER } from '../../core/Layers.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, Easing } from '../../utils/math.js';

const TAU = Math.PI * 2;

/** Hard ceiling on calving chunks. `debrisCount` clamps here. */
const MAX_CHUNKS = 48;

/* Module-scope scratch. Nothing in a frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();

/* ---------------------------------------------------------------------- */
/* The funnel                                                              */
/* ---------------------------------------------------------------------- */

/**
 * A radial parameter grid. **There are no metres in this buffer.**
 *
 * `position` carries `(angleFraction, radialFraction, 0)` and nothing else; the
 * vertex shader turns that pair into a world point every frame off the live
 * uniforms. That is the whole reason `depth`, `wallCurve`, `lip` and `calve`
 * remain sliders on a hole that has already finished opening — there is no
 * baked shape anywhere to go stale. The only thing `spokes` and `rings` decide
 * is how finely the profile is sampled, which is why moving *those* two is the
 * one change that has to rebuild the buffer.
 *
 * Ring 0 is a full ring of vertices that all resolve to the same point at the
 * throat. That is deliberately wasteful — a proper fan would save 55 vertices —
 * and it buys a uniform grid the finite-difference normal can walk without a
 * special case at the centre, which is worth more than 55 vertices.
 */
function createFunnelGeometry(spokes, rings) {
  const cols = spokes + 1;
  const positions = new Float32Array((rings + 1) * cols * 3);
  let o = 0;
  for (let r = 0; r <= rings; r++) {
    const u = r / rings;
    for (let s = 0; s <= spokes; s++) {
      positions[o++] = s / spokes;
      positions[o++] = u;
      positions[o++] = 0;
    }
  }

  // Uint16 is deliberate: the grid is capped at 64 rings x 96 spokes = 6305
  // vertices, comfortably inside 16 bits, and a 32-bit index buffer needs an
  // extension on WebGL1 that this project has no other reason to require.
  const indices = new Uint16Array(rings * spokes * 6);
  let i = 0;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < spokes; s++) {
      // Named for their corner, not `a b c d`: a bare `const c` in this file
      // would look like a settings alias to the harness's static cross-check
      // and blind it to every real `c.<key>` read in the class below it.
      const inner0 = r * cols + s;
      const inner1 = inner0 + 1;
      const outer0 = inner0 + cols;
      const outer1 = outer0 + 1;
      indices[i++] = inner0;
      indices[i++] = outer0;
      indices[i++] = outer1;
      indices[i++] = inner0;
      indices[i++] = outer1;
      indices[i++] = inner1;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}

/**
 * The profile, evaluated in the vertex shader, in metres.
 *
 * Shared between the position and the two finite-difference taps that build the
 * normal, so the shading can never disagree with the silhouette however hard
 * the sliders are pulled. Writing the normal out by hand instead was the first
 * attempt and it survived about ten minutes: every one of `wallCurve`, `lip`,
 * `calveDrop` and `rough` contributes a term, and a hand-differentiated version
 * quietly stops matching the moment any of them is touched.
 */
const FUNNEL_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  uniform vec3  uCentre;
  uniform float uRadius;
  uniform float uApron;
  uniform float uDepth;
  uniform float uDrop;
  uniform float uWallCurve;
  uniform float uLip;
  uniform float uRough;
  uniform float uRoughScale;
  uniform float uCalve;
  uniform float uCalveCells;
  uniform float uCalveDrop;
  uniform float uSpokes;
  uniform float uRings;
  uniform float uSeed;

  varying vec3  vWorld;
  varying vec3  vNrm;
  varying float vRadial;
  varying float vDrop;

  float holeHeight(float r, float ang) {
    float x = r / max(uRadius, 0.05);

    // The bowl. One exponent takes it from a saucer to a bell-mouthed shaft.
    float bowl = pow(max(0.0, 1.0 - min(x, 1.0)), max(uWallCurve, 0.05));
    float h = -uDepth * bowl;

    // Wedges. The rim does not break on a circle: it breaks into blocks, and
    // each block waits for its own threshold before it goes.
    float wedge = floor(ang / TAU * max(uCalveCells, 1.0) + uSeed * 7.0);
    float roll = hash11(wedge * 1.37 + uSeed);

    // Spoil heaped just outside the rim, in the same blocks.
    float apronBand = smoothstep(1.0, 1.1, x) * (1.0 - smoothstep(1.1, 1.55, x));
    h += uLip * apronBand * (0.45 + 1.1 * roll);

    float band = smoothstep(1.12, 0.86, x) * smoothstep(0.5, 0.82, x);
    h -= uCalveDrop * band * (0.4 + 0.9 * roll) *
         smoothstep(roll * 0.7, roll * 0.7 + 0.3, uCalve);

    // Scree grain, sampled in the plane and not on the bearing: an angular
    // lookup hands every radius along a bearing the same value and draws
    // dead-straight gullies from the rim to the throat, which is a firework
    // rather than a landslide.
    vec2 q = vec2(cos(ang), sin(ang)) * r;
    h += snoise(vec3(q * uRoughScale, uSeed * 3.1)) * uRough * uDepth * 0.075 *
         (1.0 - min(x, 1.0));

    return h * uDrop;
  }

  vec3 holePoint(float u, float angFrac) {
    float ang = angFrac * TAU;
    float r = uRadius * uApron * clamp(u, 0.0, 1.0);
    return vec3(cos(ang) * r, holeHeight(r, ang), sin(ang) * r);
  }

  void main() {
    float u = position.y;
    float a = position.x;

    vec3 p = holePoint(u, a);

    float du = 1.2 / max(uRings, 2.0);
    float da = 1.2 / max(uSpokes, 3.0);
    float uu = max(u, du);
    vec3 p0 = holePoint(uu, a);
    vec3 pa = holePoint(uu, a + da);
    vec3 pu = holePoint(uu + du, a);
    // cross(tangential, radial-outward) is +Y on flat ground, which is the
    // orientation the fragment stage assumes for the lip catch.
    vec3 n = cross(pa - p0, pu - p0);
    vNrm = vec3(0.0, 1.0, 0.0);
    if (dot(n, n) > 1e-10) vNrm = normalize(n);

    vec4 world = modelMatrix * vec4(p + uCentre, 1.0);
    vWorld = world.xyz;
    vRadial = length(p.xz) / max(uRadius, 0.05);
    vDrop = -p.y;

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FUNNEL_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586

  uniform vec3  uLightDir;
  uniform vec3  uColorGround;
  uniform vec3  uColorWall;
  uniform vec3  uColorDeep;
  uniform vec3  uColorVoid;
  uniform vec3  uColorLip;
  uniform float uAmbient;
  uniform float uWrap;
  uniform float uSpecular;
  uniform float uGloss;
  uniform float uDepthTint;
  uniform float uStrata;
  uniform float uStrataScale;
  uniform float uGrit;
  uniform float uGritScale;
  uniform float uThroat;
  uniform float uRimLight;
  uniform float uOpacity;
  uniform float uFade;
  uniform float uApron;
  uniform float uApronFade;
  uniform float uDepth;
  uniform float uSeed;

  varying vec3  vWorld;
  varying vec3  vNrm;
  varying float vRadial;
  varying float vDrop;

  void main() {
    vec3 N = normalize(vNrm);
    vec3 L = normalize(uLightDir);

    // Wrapped diffuse. A hole is mostly surfaces facing away from the key, and
    // an unwrapped lambert puts three quarters of the interior at pure ambient,
    // which flattens the one thing the mesh exists to show.
    float ndl = dot(N, L);
    float shade = uAmbient + (1.0 - uAmbient) *
                  clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0);

    vec3 V = normalize(cameraPosition - vWorld);
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), max(uGloss, 1.0)) * uSpecular * step(0.0, ndl);

    float deep = clamp(vDrop / max(uDepth, 0.05), 0.0, 1.0);

    // Bedding runs level, because these walls are a cut through ground that is
    // level, so the bands belong in WORLD y and nowhere else. The first version
    // sampled them on the wall's own parameter; they followed the profile and
    // the hole looked turned on a lathe.
    float bed = 0.5 + 0.5 * sin(vWorld.y * uStrataScale * TAU +
                                snoise(vec3(vWorld.xz * 0.35, uSeed)) * 1.6);
    float scree = snoise01(vec3(vWorld.xz * uGritScale, vWorld.y * uGritScale * 0.5 + uSeed));

    vec3 body = mix(uColorGround, uColorWall, smoothstep(0.0, 0.18, deep));
    body = mix(body, uColorDeep, pow(deep, max(uDepthTint, 0.05)));
    body *= mix(1.0, 0.72 + 0.56 * bed, clamp(uStrata, 0.0, 1.0));
    body *= mix(1.0, 0.7 + 0.6 * scree, clamp(uGrit, 0.0, 2.0));

    vec3 col = body * shade + uColorLip * spec;

    // The broken lip is the only bright thing in the frame: stone standing
    // proud of the floor with the key running along its edge.
    float lipBand = smoothstep(1.14, 0.94, vRadial) * smoothstep(0.7, 0.95, vRadial);
    col += uColorLip * uRimLight * lipBand * clamp(N.y, 0.0, 1.0);

    // The throat. Not shaded, not lit, not grained. The point is that there is
    // nothing down there to measure a distance against, and every term above
    // would give the eye one.
    col = mix(col, uColorVoid, smoothstep(uThroat * 1.8, uThroat * 0.25, vRadial));

    float alpha = uOpacity * uFade *
                  (1.0 - smoothstep(uApronFade, max(uApron, uApronFade + 0.01), vRadial));
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

/* ---------------------------------------------------------------------- */
/* The ability                                                             */
/* ---------------------------------------------------------------------- */

/**
 * SINKHOLE — the ground goes down.
 *
 * Fractures spread across the circle, the floor inside them lets go and drops
 * into a funnel, the lip calves inward in blocks that fall and are never seen
 * to land, a ring of dust blows out over the rim, and then a long settle in
 * which pebbles are still trickling in off the walls.
 *
 * **THE TRICK is that the funnel is real geometry displaced in the vertex
 * shader.** `GroundField` ships a `FUNNEL` mode and it is a good mode, but it
 * is a *flat quad* that fakes depth off a height field and a parallax offset —
 * and a flat fake survives exactly one camera orbit. So the library's FUNNEL is
 * used here for the job it is genuinely right for, the cracked apron of spoil
 * and fracture lines on the ground *outside* the rim, which really is flat; and
 * the pit itself is a radial mesh whose every vertex is placed in metres by
 * `holeHeight()` and whose normal comes from two finite differences on that
 * same function. Orbit it and the near wall goes dark while the far wall lights
 * up, which is the entire read.
 *
 * **The floor of the hole is never drawn.** The mesh converges on one vertex at
 * the throat and the last fraction of the radius is flat `colorVoid` with no
 * shading, no bedding and no grain, so there is no surface down there to judge
 * a distance against. The chunks fall to a point well below the throat and the
 * near wall eats them on the way past.
 *
 * **How a hole is painted onto a solid floor.** The stage floor is one opaque
 * plane at `y = 0` and there is no stencil budget here, so a mesh below it
 * would simply be occluded. The funnel is therefore drawn with `depthFunc:
 * AlwaysDepth` — the depth *test* stays enabled, which is what lets it keep
 * writing depth (a disabled depth test disables the write with it, which cost
 * an hour), but it always passes, so the hole paints over the floor and then
 * re-establishes the depth buffer for the chunks and the dust drawn after it.
 * The cost is honest and small: something between the camera and the rim would
 * be painted over, and the hole is always downrange of the caster.
 *
 * **The rule that makes the editor work.** A cast captures one seed, the
 * chunks' unitless dice and a handful of timestamps. Not a metre: `depth`,
 * `zoneRadius`, `wallCurve`, `calveDrop` and every colour are uniforms
 * refilled from `settings.sinkhole` on the frame they are drawn, a zero-length
 * frame included. Drag `depth` on a hole that has already opened and it opens
 * further, with the clock stopped.
 */
export class SinkholeAbility extends Ability {
  constructor(context) {
    super('sinkhole', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.funnelUniforms = sharedUniforms({
      uCentre: { value: new Vector3() },
      uRadius: { value: 5 },
      uApron: { value: 1.45 },
      uApronFade: { value: 1.08 },
      uDepth: { value: 6.5 },
      uDrop: { value: 0 },
      uWallCurve: { value: 2.4 },
      uLip: { value: 0.3 },
      uRough: { value: 0.75 },
      uRoughScale: { value: 1.1 },
      uCalve: { value: 0 },
      uCalveCells: { value: 14 },
      uCalveDrop: { value: 0.95 },
      uSpokes: { value: 56 },
      uRings: { value: 36 },
      uSeed: { value: 0 },
      uColorGround: { value: new Color() },
      uColorWall: { value: new Color() },
      uColorDeep: { value: new Color() },
      uColorVoid: { value: new Color() },
      uColorLip: { value: new Color() },
      uAmbient: { value: 0.28 },
      uWrap: { value: 0.42 },
      uSpecular: { value: 0.25 },
      uGloss: { value: 18 },
      uDepthTint: { value: 1.4 },
      uStrata: { value: 0.5 },
      uStrataScale: { value: 1.4 },
      uGrit: { value: 0.5 },
      uGritScale: { value: 9 },
      uThroat: { value: 0.16 },
      uRimLight: { value: 0.6 },
      uOpacity: { value: 1 },
      uFade: { value: 0 }
    });

    this.funnelMaterial = new ShaderMaterial({
      transparent: true,
      // See the class comment: the test stays on (AlwaysDepth) precisely so the
      // write stays on. `depthTest: false` would silently disable the write and
      // the chunks would fall straight through the near wall.
      depthTest: true,
      depthFunc: AlwaysDepth,
      depthWrite: true,
      // The camera can end up below the rim plane looking along a wall; culling
      // there costs nothing to keep and shows a hole in the hole when it goes.
      side: DoubleSide,
      toneMapped: false,
      uniforms: this.funnelUniforms,
      vertexShader: `${noiseGLSL}\n${FUNNEL_VERTEX}`,
      fragmentShader: `${noiseGLSL}\n${FUNNEL_FRAGMENT}`
    });

    /** Mesh resolution the buffer was last built at. See `_syncMesh`. */
    this._spokes = 0;
    this._rings = 0;
    this.funnelGeometry = createFunnelGeometry(56, 36);
    this._spokes = 56;
    this._rings = 36;

    this.funnel = new Mesh(this.funnelGeometry, this.funnelMaterial);
    this.funnel.name = 'SinkholeFunnel';
    this.funnel.frustumCulled = false;
    this.funnel.matrixAutoUpdate = false;
    this.funnel.layers.set(LAYER.VFX);
    // After the apron (6) so the pit paints over its interior, before the dust
    // (10) and the chunks (12) so both of them test against the walls.
    this.funnel.renderOrder = 9;
    this.funnel.visible = false;
    this.group.add(this.funnel);

    /* --- the cracked apron on the ground that has not fallen --- */
    this.apron = new GroundField(this.group, {
      mode: GroundMode.FUNNEL,
      additive: false,
      name: 'SinkholeApron'
    });
    this._apronParams = groundFieldParams();
    this._apronParams.centre = _centre;

    /* --- the chunks --- */
    this.chunkMaterial = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.95,
      metalness: 0,
      flatShading: true,
      // Transparent so it sorts *after* the funnel and is occluded by the wall
      // it falls behind. Opaque geometry is drawn before every transparent, and
      // the funnel would then paint over every chunk on the frame it is drawn.
      transparent: true,
      depthWrite: true
    });

    this.chunks = new Projectile(this.group, {
      geometry: createAsteroidGeometry({
        seed: 12.7,
        detail: 1,
        lumpiness: 0.34,
        noiseScale: 1.8,
        roughness: 0.22,
        cuts: 8,
        cutDepth: 0.3,
        craters: 3,
        craterDepth: 0.14,
        craterSize: 0.45
      }),
      material: this.chunkMaterial,
      capacity: MAX_CHUNKS,
      trail: false,
      layer: LAYER.VFX,
      renderOrder: 12,
      castShadow: false
    });
    this._chunkParams = projectileParams();
    this._chunkParams.mode = FlightMode.FALL;
    this._chunkParams.stagger = Stagger.HASH;

    /** Re-rolled per cast so no two holes break the same way. Unitless. */
    this._seed = 0;
    /** Set on the frame the floor lets go, so the blast fires exactly once. */
    this._blown = false;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The dust. Non-additive: the ring blowing out over the rim has to occlude
    // the apron behind it or the hole reads as a decal with smoke over it.
    this.dust = particles.get('sinkhole.dust', {
      capacity: 3000,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.3
    });
    this.dust.uniforms.uDrag.value = 2.0;
    this.dust.uniforms.uEndSize.value = 4.0;
    this.dust.uniforms.uSizeIn.value = 0.1;
    this.dust.uniforms.uFadeIn.value = 0.12;
    this.dust.uniforms.uFadeOut.value = 0.34;

    // Pebbles running off the walls. Lit, and deliberately short-lived: they
    // have to be gone before they reach anything that could read as a bottom.
    this.pebbles = particles.get('sinkhole.pebbles', {
      capacity: 1400,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.2
    });
    this.pebbles.uniforms.uDrag.value = 0.2;
    this.pebbles.uniforms.uEndSize.value = 0.7;
    this.pebbles.uniforms.uFadeOut.value = 0.55;

    this.dustEmitter = new RateEmitter();
    this.pebbleEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.chunks.count;
  }

  /** Cracking, then the drop, then the settle — all one phase. */
  get impactDuration() {
    const c = settings.sinkhole;
    return Math.max(0.2, (c.crackTime + c.dropTime + c.lifetime) * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.2, settings.sinkhole.sinkTime);
  }

  /** A hole does not flicker. The light is a dust glow and it only breathes. */
  lightShimmer() {
    return 0.9 + 0.1 * Math.sin(this.age * 2.7);
  }

  /** The centre of the circle, on the floor. One number drives everything. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /* ------------------------------------------------------------------ */
  /* Live resolution — every metre comes from here                        */
  /* ------------------------------------------------------------------ */

  /**
   * Rebuild the parameter grid when the resolution sliders move.
   *
   * The buffer carries no metres, so nothing else in the ability cares that it
   * changed — which is exactly why `spokes` and `rings` can be live controls at
   * all rather than boot-time constants.
   */
  _syncMesh() {
    const c = settings.sinkhole;
    const spokes = Math.max(12, Math.min(96, Math.round(c.spokes)));
    const rings = Math.max(8, Math.min(64, Math.round(c.rings)));
    if (spokes === this._spokes && rings === this._rings) return;

    const previous = this.funnelGeometry;
    this.funnelGeometry = createFunnelGeometry(spokes, rings);
    this.funnel.geometry = this.funnelGeometry;
    previous.dispose();
    this._spokes = spokes;
    this._rings = rings;
  }

  /**
   * Push the whole live block into the funnel, the apron and the two gradients.
   *
   * @param {number} drop  0..1 how far the floor has fallen
   * @param {number} calve 0..1 how far the lip has broken inward
   * @param {number} fade  0..1 master opacity on the pit
   */
  _syncUniforms(drop, calve, fade) {
    const c = settings.sinkhole;
    const g = settings.global;
    const u = this.funnelUniforms;

    this._syncMesh();
    this._centrePoint(_centre);

    u.uCentre.value.copy(_centre);
    u.uRadius.value = Math.max(0.2, c.zoneRadius);
    u.uApron.value = c.apron;
    u.uApronFade.value = c.apronFade;
    u.uDepth.value = c.depth;
    u.uDrop.value = drop;
    u.uWallCurve.value = c.wallCurve;
    u.uLip.value = c.lip;
    u.uRough.value = c.rough * g.shaderIntensity;
    u.uRoughScale.value = c.roughScale * g.noiseFrequency;
    u.uCalve.value = calve;
    u.uCalveCells.value = Math.max(3, Math.round(c.calveCells));
    u.uCalveDrop.value = c.calveDrop;
    u.uSpokes.value = this._spokes;
    u.uRings.value = this._rings;
    u.uSeed.value = this._seed;

    u.uColorGround.value.copy(getColor(c.colorGround));
    u.uColorWall.value.copy(getColor(c.colorWall));
    u.uColorDeep.value.copy(getColor(c.colorDeep));
    u.uColorVoid.value.copy(getColor(c.colorVoid));
    u.uColorLip.value.copy(getColor(c.colorLip));
    u.uAmbient.value = c.ambient;
    u.uWrap.value = c.wrap;
    u.uSpecular.value = c.specular;
    u.uGloss.value = c.gloss;
    u.uDepthTint.value = c.depthTint;
    u.uStrata.value = c.strata * g.shaderIntensity;
    u.uStrataScale.value = c.strataScale * g.noiseFrequency;
    u.uGrit.value = c.grit * g.shaderIntensity;
    u.uGritScale.value = c.gritScale * g.noiseFrequency;
    u.uThroat.value = c.throat;
    u.uRimLight.value = c.rimLight * g.glow;
    u.uOpacity.value = c.opacity * g.opacity;
    u.uFade.value = fade;

    this.funnel.visible = fade > 0.003;

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

    this.pebbles.setGradient(
      getColor(c.colorPebbleA),
      getColor(c.colorPebbleB),
      getColor(c.colorPebbleC),
      getColor(c.colorPebbleD)
    );
    this.pebbles.uniforms.uGravity.value.set(0, c.pebbleGravity, 0);
    this.pebbles.uniforms.uSizeScale.value = c.pebbleSize * g.particleSize * 7;
    this.pebbles.uniforms.uLifeScale.value = c.pebbleLifetime * 0.5 * g.particleLifetime;
    this.pebbles.uniforms.uSpeedScale.value = c.pebbleSpeed * g.particleSpeed;
    this.pebbles.uniforms.uOpacity.value = g.opacity;

    this.chunkMaterial.color.copy(getColor(c.colorDebris));
    this.chunkMaterial.roughness = c.debrisRoughness;
  }

  /**
   * The apron: fracture lines and spoil on the ground that has *not* fallen.
   *
   * `GroundField` re-resolves every metre from this object on the frame it is
   * drawn, so the object is refilled here and never cached — including the
   * radius, because re-scaling live is the whole reason the module exists.
   *
   * @param {number} grow 0..1 the fracture front spreading outward
   * @param {number} fade 0..1
   */
  _syncApron(grow, fade) {
    const c = settings.sinkhole;
    const g = settings.global;
    const p = this._apronParams;

    this._centrePoint(_centre);
    p.centre = _centre;
    p.yaw = Math.atan2(this.direction.x, this.direction.z);
    p.height = 0.02;
    p.radius = Math.max(0.2, c.zoneRadius);
    p.grow = grow;
    p.fade = fade;
    p.seed = this._seed;

    p.edge = c.fieldEdge;
    p.ragged = c.fieldRagged;
    p.raggedScale = c.fieldRaggedScale;
    p.warp = c.fieldWarp;
    p.relief = c.fieldRelief;
    p.cell = c.fieldCell;
    p.cellJitter = c.fieldCellJitter;
    p.seam = c.fieldSeam;
    p.thickness = c.fieldThickness;
    p.lift = c.fieldLift;
    p.depth = c.fieldDepth;
    p.sharp = c.fieldSharp;
    p.detail = c.fieldDetail;
    p.parallax = c.fieldParallax;
    p.opacity = c.fieldOpacity;
    p.colorBase = c.colorFieldBase;
    p.colorEdge = c.colorFieldEdge;
    p.colorGlow = c.colorFieldGlow;
    p.colorDeep = c.colorFieldDeep;

    p.noiseStrength = g.noiseStrength;
    p.noiseFrequency = g.noiseFrequency;
    p.noiseSpeed = g.noiseSpeed;
    p.opacityScale = g.opacity;

    this.apron.update(p);
  }

  /**
   * The chunks. FALL, used upside down.
   *
   * `FlightMode.FALL` exists to bring hail out of one shared vanishing point in
   * the sky; every metre of it is a slider, so putting that point *on the rim
   * plane* and the landing point *below the floor* turns the same mode into a
   * shared sink. What is actually being borrowed is the part that matters — the
   * launch order is a spatial hash of the *landing* point, so the lip calves in
   * spreading patches rather than in the order the dice happened to fall, and
   * `fillBias` at -1 starts that spread at the rim and works inward.
   */
  _syncChunks() {
    const c = settings.sinkhole;
    const g = settings.global;
    const p = this._chunkParams;

    this.chunks.setBasis(this.origin, this.direction, this.side, this.length);

    p.mode = FlightMode.FALL;
    p.stagger = Stagger.HASH;
    p.count = Math.min(MAX_CHUNKS, Math.round(c.debrisCount * g.particleCount));
    p.radius = c.debrisRadius;
    p.sizeJitter = c.debrisSizeJitter;
    p.spin = c.debrisSpin;
    p.align = 0;
    p.stretch = 1;
    p.flash = c.debrisFlash;

    // The "sky" point is dropped onto the rim plane and pushed downrange to the
    // centre of the circle: `skyBack` is measured backward along the heading, so
    // negating the cast length puts it exactly where the hole is.
    p.skyBack = c.debrisBack - this.length;
    p.skyHeight = c.debrisLaunchHeight;
    p.skyScatter = c.debrisSpread * c.zoneRadius;

    p.zoneRadius = c.debrisSinkSpread * c.zoneRadius;
    p.zoneBias = 0.5;
    p.landHeight = -c.debrisSinkDepth;
    p.landInZone = true;
    p.pathCurve = c.debrisPathCurve;
    p.apex = 0;
    p.weaveSide = 0;
    p.weaveUp = 0;

    p.flightTime = c.debrisFlightTime;
    p.speedJitter = c.debrisSpeedJitter;
    p.lead = c.debrisLead;
    p.window = c.debrisWindow;
    p.fillBias = c.debrisFillBias;
    p.fillScatter = c.debrisFillScatter;
    p.hashCell = c.debrisHashCell;
    p.linger = 0;
    p.sink = 0;

    this.chunks.update(this.age, p);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.dustEmitter.reset();
    this.pebbleEmitter.reset();
    this._blown = false;

    // The one thing a cast captures beyond timestamps: which wedge of the rim
    // breaks first and which way the grain runs.
    this._seed = Math.random() * 100;
    this.chunks.roll(this._seed);
    this.chunks.reset();
    this.apron.setVisible(true);

    this._syncUniforms(0, 0, 0);
    this._syncApron(0, 1);
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** The ring of dust that blows out over the rim as the floor lets go. */
  _blast() {
    const c = settings.sinkhole;
    const g = settings.global;
    const time = frame.uTime.value;

    this._centrePoint(_pos);
    _pos.y = 0.35;

    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.burstSize * 0.3,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 1.2,
      intensity: c.burstIntensity,
      opacity: 0.85,
      fresnel: 1.0,
      displace: 0.75,
      squash: 0.45,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this._centrePoint(_pos);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.8,
      width: 0.06,
      intensity: 0.8,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    // Emitted in a shell the size of the rim rather than from the middle: the
    // dust does not come out of the hole, it is shoved off the lip by the air
    // the falling floor displaced, so it starts at the edge and goes outward.
    _pos.y = 0.25;
    _emit.position = _pos;
    _emit.radius = c.zoneRadius * 0.95;
    _emit.direction = _dir.set(0, saturate(c.blastLift), 0);
    _emit.speed = c.blastSpeed;
    _emit.speedVariance = 0.7;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 1.5;
    _emit.sizeVariance = 0.6;
    _emit.life = c.dustLifetime * 1.4;
    _emit.lifeVariance = 0.45;
    _emit.spin = 0.5;
    _emit.tint = null;
    _emit.time = time;
    this.dust.emit(Math.round(c.blastDust * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      12
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.6 * g.explosionIntensity;
  }

  /**
   * The settle: an updraft of dust out of the mouth, and pebbles letting go of
   * the walls just inside the rim and running down out of sight.
   *
   * @param {number} scale 0..1
   * @param {number} drop  0..1, so nothing is shed off a hole that is not open
   */
  _settleFx(dt, scale, drop) {
    const c = settings.sinkhole;
    const g = settings.global;
    const time = frame.uTime.value;
    if (drop < 0.05) return;

    this._centrePoint(_centre);

    const dustCount = Math.round(this.dustEmitter.tick(dt, c.dustRate * scale) * g.particleCount);
    if (dustCount > 0) {
      _pos.copy(_centre);
      _pos.y = 0.2;
      _emit.position = _pos;
      _emit.radius = c.zoneRadius * 0.8;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 1.1;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.35;
      _emit.tint = null;
      _emit.time = time;
      this.dust.emit(dustCount, _emit);
    }

    const pebbleCount = Math.round(
      this.pebbleEmitter.tick(dt, c.pebbleRate * scale) * g.particleCount
    );
    if (pebbleCount > 0) {
      // Just inside the lip, on the wall, aimed down the slope. The band is a
      // fraction of the radius rather than a metre so it stays on the wall when
      // `zoneRadius` moves.
      const band = 1 - saturate(c.pebbleBand) * Math.random();
      const angle = Math.random() * TAU;
      const r = c.zoneRadius * band;
      _pos.set(_centre.x + Math.cos(angle) * r, 0, _centre.z + Math.sin(angle) * r);
      // The wall at that radius, off the same profile the shader uses.
      _pos.y = -c.depth * Math.pow(Math.max(0, 1 - band), Math.max(0.05, c.wallCurve)) * drop;
      _emit.position = _pos;
      _emit.radius = c.zoneRadius * 0.06;
      _emit.direction = _dir
        .set(_centre.x - _pos.x, 0, _centre.z - _pos.z)
        .normalize()
        .multiplyScalar(0.45)
        .setY(-1)
        .normalize();
      _emit.speed = c.pebbleSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.4;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.7;
      _emit.life = c.pebbleLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 9;
      _emit.time = time;
      this.pebbles.emit(pebbleCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.sinkhole;

    // Nothing has fallen yet. The fractures run out across an intact floor,
    // which is exactly the case the library's flat FUNNEL mark is right for.
    this._syncUniforms(0, 0, 0);
    this._syncApron(this.u * 0.75, 1);
    this._syncChunks();

    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
    this._centrePoint(this.position);
  }

  onImpact() {
    // The drop is a curve through the impact phase, not a one-shot; all this
    // does is put the light where the hole is. `_blast` fires from `onFade` on
    // the frame the floor actually lets go, `crackTime` seconds from now.
    this._centrePoint(this.position);
  }

  onFade(dt, t) {
    const c = settings.sinkhole;

    /* --- where we are in the four beats --- */
    const crackTime = Math.max(0.02, c.crackTime);
    const dropTime = Math.max(0.02, c.dropTime);
    const held = this.phase === AbilityPhase.IMPACT ? this.impactTime : this.impactDuration;

    const crack = saturate(held / crackTime);
    // inOutCubic, so the floor hesitates, goes, and stops. outQuint made it
    // snap open on frame one, which reads as a trapdoor rather than a collapse.
    const drop = Easing.inOutCubic(saturate((held - crackTime) / dropTime));
    // `calve` is the *ceiling* on how far the wedges come in, not the clock:
    // at 0 the rim stays a clean circle and the hole reads as bored rather than
    // collapsed, which is worth being able to dial all the way out.
    const calve = saturate(c.calve) * saturate((held - crackTime * 0.55) / (dropTime * 1.5));

    let fade = 1;
    let open = drop;
    if (this.phase === AbilityPhase.FADE) {
      // The sandbox has to give the floor back. The hole eases shut first and
      // only then goes translucent — fading a full-depth pit out in place looks
      // like the renderer lost it.
      const shut = saturate(this.fadeTime / Math.max(0.05, c.sinkTime));
      open = drop * (1 - Easing.inCubic(shut));
      fade = 1 - Easing.inQuad(saturate((shut - 0.55) / 0.45));
    }

    this._syncUniforms(open, calve, fade);
    this._syncApron(1, fade);
    this._syncChunks();

    if (!this._blown && drop > 0.06) {
      this._blown = true;
      this._blast();
    }

    // Cracking gets a rising rumble; the settle gets a low one that dies out.
    const shake = this.phase === AbilityPhase.IMPACT ? c.settleShake : c.settleShake * (2 - t);
    this.ctx.shake.rumble(
      shake * (0.4 + 0.6 * crack) * open * settings.global.cameraShake,
      dt
    );

    this._settleFx(dt, fade * (t <= 1 ? 1 : 0.35), open);
    this._centrePoint(this.position);
  }

  onDestroy() {
    this.chunks.reset();
    this.apron.setVisible(false);
    this.funnel.visible = false;
    this.funnelUniforms.uFade.value = 0;
    this._blown = false;
  }

  dispose() {
    this.funnelGeometry.dispose();
    this.funnelMaterial.dispose();
    this.apron.dispose();
    this.chunks.dispose();
    this.chunkMaterial.dispose();
    super.dispose();
  }
}
