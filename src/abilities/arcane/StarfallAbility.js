import {
  AdditiveBlending,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  ShaderMaterial,
  Vector3
} from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { FlightMode, Projectile, Stagger, projectileParams } from '../../vfx/Projectile.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { noiseGLSL } from '../../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../../shaders/lib/common.glsl.js';
import { frame, sharedUniforms } from '../../core/FrameUniforms.js';
import { LAYER } from '../../core/Layers.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, hash11, Easing } from '../../utils/math.js';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Hard ceiling on stars in one call. The `stars` slider clamps here. */
const MAX_STARS = 40;
/**
 * How many impacts the floor quad carries at once.
 *
 * `GroundField(POCK)` walks this list five times per fragment — three height
 * taps for the fake normal, plus the cover and heat masks — so the number is a
 * real fill cost and not a capacity to be generous with. Sixteen holds every
 * ring that is still visibly warm at the shipped `ringLife`; past that the ring
 * buffer recycles oldest-first, which is exactly the mark you want to lose.
 */
const FLOOR_MARKS = 16;
/** Facets around the body. Five reads as a shard; eight reads as a pill. */
const STAR_SIDES = 5;

/* ------------------------------------------------------------------ */
/* Scratch — module scope, reused, never allocated in a frame (I3)     */
/* ------------------------------------------------------------------ */

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _hand = new Vector3();
/** Filled from `settings.starfall` every frame and handed to the modules. */
const _flight = projectileParams();
const _ground = groundFieldParams();

/* ------------------------------------------------------------------ */
/* The body                                                            */
/* ------------------------------------------------------------------ */

/**
 * One star: a faceted spindle in unit space, nose at `y = +1`, tail at `y = -1`,
 * circumscribed radius 1 across.
 *
 * `Projectile` scales an instance `(radius, radius × stretch, radius)` and — at
 * `align = 1` — lays local **+Y** along the heading, so this orientation is the
 * contract, not a preference: the nose is the end that arrives first. The widest
 * ring sits just *behind* the nose rather than in the middle, because a
 * symmetrical bipyramid reads as a diamond tumbling and an asymmetric one reads
 * as something moving in a direction.
 *
 * The first version of this was an icosahedron, on the theory that a star is a
 * point of light and the silhouette does not matter. At 0.13 m with a bright
 * additive shader it read as a *bead*, and twenty beads on strings is a curtain,
 * not a fall. The spindle is what puts a direction into the body itself, which
 * matters most in the frame before the impact, when the trail is behind the
 * camera and the body is all you have.
 */
function createStarGeometry() {
  const sides = STAR_SIDES;
  // Waist heights and radii. Non-uniform on purpose — see above.
  const rings = [
    [-1.0, 0.0],
    [-0.55, 0.42],
    [0.1, 1.0],
    [0.45, 0.78],
    [1.0, 0.0]
  ];

  const angles = [];
  for (let i = 0; i < sides; i++) {
    // Jittered once and shared by every ring, so the facets stay continuous
    // edges down the body instead of twisting into a screw.
    const jitter = (hash11(i * 7.31 + 3.7) - 0.5) * (Math.PI * 2 / sides) * 0.4;
    angles.push((i / sides) * Math.PI * 2 + jitter);
  }

  const ringPoints = rings.map(([y, r], ringIndex) =>
    angles.map((angle, i) => {
      const wobble = 1 + (hash11(ringIndex * 13.9 + i * 5.1) - 0.5) * 0.22;
      const rr = r * wobble;
      return [Math.cos(angle) * rr, y, Math.sin(angle) * rr];
    })
  );

  const positions = [];
  const push = (p) => positions.push(p[0], p[1], p[2]);
  for (let ring = 0; ring < ringPoints.length - 1; ring++) {
    const lower = ringPoints[ring];
    const upper = ringPoints[ring + 1];
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      push(lower[i]); push(lower[j]); push(upper[i]);
      push(lower[j]); push(upper[j]); push(upper[i]);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  // Non-indexed with per-face normals: this is what makes the facets crisp.
  geometry.computeVertexNormals();
  return geometry;
}

/* ------------------------------------------------------------------ */
/* The body's material                                                 */
/* ------------------------------------------------------------------ */

const STAR_VERTEX = /* glsl */ `
  attribute float aSeed;
  attribute float aFlight;
  attribute float aFlash;

  varying float vSeed;
  varying float vFlight;
  varying float vFlash;
  varying vec3  vLocal;
  varying vec3  vNormalW;
  varying vec3  vViewDir;

  void main() {
    vSeed = aSeed;
    vFlight = aFlight;
    vFlash = aFlash;
    vLocal = position;

    mat4 im = mat4(1.0);
    #ifdef USE_INSTANCING
      im = instanceMatrix;
    #endif

    // The body is scaled (r, r * stretch, r), which is anisotropic: pushing a
    // normal straight through the instance matrix tips every one of them toward
    // the long axis and the whole star lights as though it were a rod. Dividing
    // by the squared column lengths is the inverse-transpose three itself uses.
    mat3 rot = mat3(im);
    vec3 sq = vec3(dot(rot[0], rot[0]), dot(rot[1], rot[1]), dot(rot[2], rot[2]));
    vec3 objectNormal = rot * (normal / max(sq, vec3(1e-6)));

    vec4 world = modelMatrix * im * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * objectNormal);
    vViewDir = cameraPosition - world.xyz;

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const STAR_FRAGMENT = /* glsl */ `
  uniform vec3  uColorCore;
  uniform vec3  uColorEdge;
  uniform vec3  uColorDeep;
  uniform float uGlow;
  uniform float uOpacity;
  uniform float uRim;
  uniform float uHeat;
  uniform float uFacet;
  uniform float uFacetScale;
  uniform float uGlobalGlow;
  uniform float uShaderIntensity;

  varying float vSeed;
  varying float vFlight;
  varying float vFlash;
  varying vec3  vLocal;
  varying vec3  vNormalW;
  varying vec3  vViewDir;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    float fres = fresnelTerm(vViewDir, vNormalW, uRim, 1.0);

    // The facet grain is sampled in the body's OWN space, not the world's.
    // A world-space sample was the first thing tried and it is wrong for a
    // reason worth writing down: a star crosses forty metres in half a second,
    // so a world-space field slides across it far faster than the body moves
    // and the grain reads as noise on the lens rather than as facets on the
    // object. Local space nails the pattern to the star; the seed keeps two
    // stars from wearing the same one.
    float grain = snoise(vec3(vLocal * uFacetScale + vSeed * 37.0)) * 0.5 + 0.5;
    float facet = mix(1.0, grain, clamp(uFacet, 0.0, 1.0));

    // A star brightens as it comes down: the flight parameter is the only clock
    // in here and it runs 0 at the vanishing point to 1 at the floor.
    float heat = uHeat * pow(clamp(vFlight, 0.0, 1.0), 2.5) + vFlash * 2.0;

    vec3 body = mix(uColorDeep, uColorEdge, facet);
    vec3 color = mix(body, uColorCore, clamp(fres * 0.8 + heat * 0.35, 0.0, 1.0));
    color *= uGlow * uGlobalGlow * uShaderIntensity * (1.0 + heat);

    float alpha = clamp(uOpacity * (0.45 + 0.55 * fres + heat * 0.25), 0.0, 1.0);
    gl_FragColor = vec4(color, alpha);
  }
`;

function createStarMaterial() {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uColorCore: { value: getColor('#ffffff').clone() },
      uColorEdge: { value: getColor('#c0d8ff').clone() },
      uColorDeep: { value: getColor('#3a5fd0').clone() },
      uGlow: { value: 2.6 },
      uOpacity: { value: 1 },
      uRim: { value: 2.2 },
      uHeat: { value: 1.6 },
      uFacet: { value: 0.55 },
      uFacetScale: { value: 9 }
    }),
    vertexShader: STAR_VERTEX,
    fragmentShader: STAR_FRAGMENT
  });
}

/* ------------------------------------------------------------------ */
/* The ability                                                         */
/* ------------------------------------------------------------------ */

/**
 * STARFALL — a rain of cold light called onto a far circle.
 *
 * Three beats: the **call** sweeps out to the circle at `speed` and inscribes
 * it on the floor; the **rain** drops stars into it on staggered timers; the
 * **fade** lets the last rings weather off the stone.
 *
 * **THE TRICK — one vanishing point.** Every star in the call leaves the *same
 * place*: `skyBack` metres behind the caster and `skyHeight` metres up. Nothing
 * else in the ability is shared. They land all over the disc, so their trails
 * radiate out of a single knot in the sky and fan apart on the way down, and
 * that fan is a genuine perspective cue — the eye reads a common vanishing
 * point as *depth above the camera*, which is the one thing a rain of parallel
 * streaks can never say. Hailwrath drops stones straight down and reads as
 * weather; this reads as sky.
 *
 * It was built the other way first, with each star given its own launch point
 * scattered across a wide patch overhead, because a shared origin sounded like
 * a fountain played backwards. What it actually looked like was twenty parallel
 * white lines: with no common point there is nothing for the eye to converge
 * on, and the whole thing flattened onto the screen. `skyScatter` is the
 * survivor of that version — a few tens of centimetres of slop so the sky end
 * is a small bright knot instead of a mathematical singularity, and past about
 * a metre the read starts to go again.
 *
 * **The envelope.** The arrival rate ramps, peaks and tails, and nothing
 * schedules it. `Projectile` derives a star's launch delay two ways — a radial
 * ordering of the disc and a spatial hash of the floor — and `fillScatter`
 * mixes them. The sum of two differently shaped random variables is a hump, so
 * a mid-range mix gives few stars early, a crowd through the middle and a
 * thinning tail, deterministically per seed and never twice in the same order.
 * Dragging `fillScatter` on a standing cast re-times every star that has not
 * landed yet.
 *
 * **What a cast captures.** One seed and a boolean ("has the first star landed
 * yet"), plus one timestamp per impact posted into the floor quad's ring buffer.
 * That is all. Every metre — the height of the vanishing point, the radius of
 * the disc, the size of a star, the radius of a ring on the floor — is resolved
 * from `settings.starfall` inside `_sync`, on a zero-length frame included.
 * Pause mid-rain and drag `skyHeight`: the stars still in the air re-fly from
 * the new point, the trails re-draw behind them, and the ones already down stay
 * where they landed, because a landing is an event and a height is not.
 *
 * **Draw calls.** Three of its own — the instanced bodies, the one instanced
 * strip that carries every trail, and the single ground quad that carries every
 * ring — plus the three shared particle systems and a handful of pooled shells.
 */
export class StarfallAbility extends Ability {
  constructor(context) {
    super('starfall', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.starMaterial = createStarMaterial();

    // `geometry` is a factory, which is what `Projectile` wants: it takes
    // ownership of the buffer and disposes it, so handing it one we also drew
    // with elsewhere would be a double free.
    this.stars = new Projectile(this.group, {
      geometry: createStarGeometry,
      material: this.starMaterial,
      capacity: MAX_STARS,
      trail: true,
      trailNodes: 32,
      trailAdditive: true,
      layer: LAYER.VFX,
      renderOrder: 12
    });

    // Every impact ring in one quad. Additive, because a star leaves light on
    // the floor rather than a stain — the same mode Hemorrhage runs shaded to
    // leave pools, which is most of why the two do not look alike.
    this.floor = new GroundField(this.group, {
      mode: GroundMode.POCK,
      marks: FLOOR_MARKS,
      additive: true,
      depthTest: true,
      name: 'Starfall:floor'
    });

    // The params object the ground quad reads is filled per frame; only the
    // anchor is a reference, and it is bound once so no frame allocates.
    _ground.centre = _centre;

    /** Re-rolled per cast so two calls never fill the circle in one order. */
    this._seed = 0;
    /** Has any star landed yet? The screen flash fires once, on the first. */
    this._struck = false;
    /** Stars drawn on the last sync — the HUD's instance readout. */
    this._live = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Chips of light thrown out of an impact. Velocity-stretched under gravity,
    // which is what stops them reading as a spherical pop.
    this.sparks = particles.get('starfall.sparks', {
      capacity: 1400,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.3;
    this.sparks.uniforms.uEndSize.value = 0.2;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.45;

    // Slow cold motes: released by an impact, and shed continuously by every
    // star still in the air, which is where the falling glitter comes from.
    this.motes = particles.get('starfall.motes', {
      capacity: 1400,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.5;
    this.motes.uniforms.uEndSize.value = 0.18;
    this.motes.uniforms.uSizeIn.value = 0.05;
    this.motes.uniforms.uFadeIn.value = 0.07;
    this.motes.uniforms.uFadeOut.value = 0.42;

    // Floor dust. Non-additive so it genuinely occludes — the one thing in the
    // palette that is grey rather than blue, and the reason the impacts read as
    // hitting stone instead of hanging over it.
    this.dust = particles.get('starfall.dust', {
      capacity: 900,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.dust.uniforms.uDrag.value = 2.0;
    this.dust.uniforms.uEndSize.value = 2.6;
    this.dust.uniforms.uSizeIn.value = 0.12;
    this.dust.uniforms.uFadeIn.value = 0.18;
    this.dust.uniforms.uFadeOut.value = 0.34;

    this.sparkleEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._live;
  }

  /** The rain holds for `lifetime`; every arrival should land inside it. */
  get impactDuration() {
    return Math.max(0.05, settings.starfall.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.starfall.fadeTime);
  }

  /**
   * A cold twinkle rather than a gutter.
   *
   * Two sines at incommensurate rates so the pattern does not repeat on a beat
   * you can hear; the product keeps it mostly near full and occasionally dips,
   * which is what a starlit floor does and a flickering torch does not.
   */
  lightShimmer() {
    const c = settings.starfall;
    const rate = Math.max(0.05, c.lightTwinkleSpeed);
    const wave = Math.sin(this.age * rate * 2.399) * Math.sin(this.age * rate * 1.111);
    return 1 - saturate(c.lightTwinkle) * 0.5 * (1 - wave);
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                  */
  /* ------------------------------------------------------------------ */

  /** The centre of the circle the stars fall into. */
  _zoneCentre(out) {
    return this.pointAt(1, out);
  }

  /** Where the call leaves the caster, in world space. */
  _handPoint(out) {
    const c = settings.starfall;
    out.copy(this.origin).addScaledVector(this.direction, c.callForward);
    out.y = c.callHeight;
    return out;
  }

  /**
   * The floor quad's yaw: local **+Z** runs downrange, which is the frame
   * `mark()` records its unitless hits in.
   */
  _yaw() {
    return Math.atan2(this.direction.x, this.direction.z);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.sparkleEmitter.reset();
    this.floor.clearMarks();
    this._struck = false;
    this._live = 0;

    // The two things a cast is allowed to capture: a dice roll and, later,
    // timestamps. Neither is a dimension.
    this._seed = Math.random() * 100;
    this.stars.roll(this._seed);

    this._sync(1);
    this._callFx();
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Fill the flight params from the live block.
   *
   * Every key `Projectile` understands is written, including the ones this
   * ability does not use: the object is module scope and shared, and a stale
   * `apex` left in it from some other read of the file would loft a star that
   * is supposed to fall straight.
   */
  _fillFlight(fade) {
    const c = settings.starfall;
    const g = settings.global;
    const p = _flight;
    const clock = Math.max(0.05, g.speed);

    p.mode = FlightMode.FALL;
    // Named rather than left on AUTO. AUTO picks HASH for a FALL today; naming
    // it means a change to that default cannot silently un-stagger this cast.
    p.stagger = Stagger.HASH;
    p.count = Math.max(0, Math.min(MAX_STARS, Math.round(c.stars)));
    p.radius = c.starSize;
    p.sizeJitter = c.starSizeJitter;
    p.stretch = c.starStretch;
    p.align = c.starAlign;
    p.spin = c.starSpin;
    p.flash = c.starFlash;

    /* the launch — FALL uses only the three sky keys, but the hand keys are
       written anyway so a mode change in the editor cannot read stale metres */
    p.handForward = c.callForward;
    p.handSide = 0;
    p.handHeight = c.callHeight;
    p.fanWidth = 0;
    p.skyBack = c.skyBack;
    p.skyHeight = c.skyHeight;
    p.skyScatter = c.skyScatter;

    /* the landing */
    p.landHeight = c.spreadHeight;
    p.spreadSide = 0;
    p.spreadForward = 0;
    p.landInZone = true;
    p.zoneRadius = c.zoneRadius;
    p.zoneBias = c.zoneBias;

    /* the curve — a star falls, it does not arc or weave */
    p.pathCurve = c.fallCurve;
    p.apex = 0;
    p.apexCurve = 1;
    p.weaveSide = 0;
    p.weaveUp = 0;
    p.weaveTurns = 1;
    p.weaveTurnsUp = 1;
    p.weavePhase = 0;
    p.weaveDecay = 1;

    /* the clock — divided by the global speed so the rain keeps pace with the
       front, which is driven by the same multiplier inside `advance()` */
    p.flightTime = Math.max(0.02, c.fallTime / clock);
    p.speedJitter = c.fallJitter;
    p.lead = Math.max(0, c.starLead / clock);
    p.window = Math.max(0.01, c.starWindow / clock);
    p.fillBias = c.fillBias;
    p.fillScatter = c.fillScatter;
    p.hashCell = c.hashCell;
    p.linger = 0;
    p.sink = 0;
    p.load = 0;

    /* the trail */
    p.trailSpan = c.trailSpan;
    p.trailBurn = c.trailBurn;
    p.trailWidth = c.trailWidth;
    p.trailTaper = c.trailTaper;
    p.trailLift = c.trailLift;
    p.trailOpacity = c.trailOpacity * fade * g.opacity;
    p.trailGlow = c.trailGlow * g.glow;
    p.trailCore = c.trailCore;
    p.trailHeadBias = c.trailHeadBias;
    p.trailNoise = c.trailNoise * g.noiseStrength;
    p.trailNoiseScale = c.trailNoiseScale * g.noiseFrequency;
    p.trailNoiseSpeed = c.trailNoiseSpeed * g.noiseSpeed;
    p.trailSoftFade = c.trailSoftFade;
    return p;
  }

  /** Fill the floor quad's params from the live block. */
  _fillGround(fade) {
    const c = settings.starfall;
    const g = settings.global;
    const p = _ground;

    p.centre = _centre;
    p.yaw = this._yaw();
    p.height = c.fieldHeight;
    p.radius = c.zoneRadius;
    p.length = c.zoneRadius * 2;

    // The circle inscribes itself as the call sweeps out to it, then holds.
    p.grow = this.phase === AbilityPhase.TRAVEL ? saturate(this.u) : 1;
    p.recede = 0;
    p.progress = 1;
    p.inscribe = 1;
    p.ignite = 0;
    p.fade = fade;
    p.seed = this._seed;

    p.edge = c.fieldEdge;
    p.ragged = c.fieldRagged;
    p.raggedScale = c.fieldRaggedScale;
    p.warp = c.fieldWarp;

    p.relief = c.fieldRelief;
    p.normalStep = 0.05;
    p.ambient = 0.3;
    p.wrap = 0.45;
    p.specular = c.fieldSpecular;
    p.gloss = c.fieldGloss;
    p.parallax = 0.2;

    p.cell = 0.5;
    p.cellJitter = 0.8;
    p.seam = 0.05;
    p.thickness = c.ringThickness;
    p.lift = c.ringRim;
    p.depth = c.ringDepth;
    p.width = 0.5;
    p.sharp = 0.5;
    p.detail = c.ringDetail;
    p.swirl = 0;
    p.arms = 5;
    // POCK reads `speed` as how fast a crater digs itself in — which, run slow,
    // is a rim travelling outward. That is the ring.
    p.speed = c.ringDig;
    p.flow = 0;
    p.windAngle = 0;

    p.markLife = c.ringLife;
    p.markRadius = c.ringRadius;

    p.additive = true;
    p.emissive = c.fieldEmissive * g.glow;
    p.opacity = c.fieldOpacity;
    p.depthFade = 0.4;
    p.colorBase = c.colorFieldBase;
    p.colorEdge = c.colorFieldEdge;
    p.colorGlow = c.colorFieldGlow;
    p.colorDeep = c.colorFieldDeep;

    p.noiseStrength = g.noiseStrength;
    p.noiseFrequency = g.noiseFrequency;
    p.noiseSpeed = g.noiseSpeed;
    p.opacityScale = g.opacity;
    return p;
  }

  /** Push the live block into the star material and the three particle systems. */
  _syncLook(fade) {
    const c = settings.starfall;
    const g = settings.global;
    const u = this.starMaterial.uniforms;

    u.uColorCore.value.copy(getColor(c.colorStarCore));
    u.uColorEdge.value.copy(getColor(c.colorStarEdge));
    u.uColorDeep.value.copy(getColor(c.colorStarDeep));
    u.uGlow.value = c.starGlow * g.glow;
    u.uOpacity.value = c.starOpacity * fade * g.opacity;
    u.uRim.value = Math.max(0.05, c.starRim);
    u.uHeat.value = c.starHeat;
    u.uFacet.value = c.starFacet;
    u.uFacetScale.value = c.starFacets;

    this.stars.setTrailColors(c.colorTrailA, c.colorTrailB, c.colorTrailC, c.colorTrailD);

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
    this.sparks.uniforms.uGlow.value = c.starGlow * 0.5 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
    this.sparks.uniforms.uTurbulence.value = 0.2 * g.turbulence;

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
    this.motes.uniforms.uGlow.value = 0.9 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

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
  }

  /**
   * One frame of the whole ability.
   *
   * Order matters in exactly one place: `arrivals` is raised by `update()` and
   * not re-raised, so it is consumed on the line after.
   *
   * @param {number} fade 1 while the rain is lit, ramping to 0 as it lets go
   */
  _sync(fade) {
    const c = settings.starfall;

    this._zoneCentre(_centre);
    this._syncLook(fade);

    this.stars.setBasis(this.origin, this.direction, this.side, this.length);
    this.stars.update(this.age, this._fillFlight(fade));
    this._live = this.stars.count;

    for (let i = 0; i < this.stars.arrivalCount; i++) this._starImpact(this.stars.arrivals[i]);

    this.floor.update(this._fillGround(fade));

    // The light sits over the circle until the first star lands, and then rides
    // whichever one landed most recently — which is a cheat, and the reason the
    // floor lights unevenly instead of glowing like a lamp.
    if (!this._struck) {
      this.position.copy(_centre);
      this.position.y = Math.min(2, c.zoneRadius * 0.35);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  /** The flash at the caster's hand as the call goes up. */
  _callFx() {
    const c = settings.starfall;
    const g = settings.global;

    this._handPoint(_hand);

    this.ctx.bursts.spawn(BurstMode.AIR, _hand, {
      radius: c.callSize * 0.25,
      endRadius: c.callSize * g.explosionIntensity,
      life: 0.4,
      intensity: c.callIntensity,
      opacity: 0.85,
      fresnel: 1.7,
      displace: 0.4,
      colorA: getColor(c.colorCallA),
      colorB: getColor(c.colorCallB),
      colorC: getColor(c.colorCallC)
    });

    _emit.position = _hand;
    _emit.radius = 0.16;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed * 2.2;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.09;
    _emit.sizeVariance = 0.6;
    _emit.life = c.moteLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(Math.round(26 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
  }

  /**
   * One star has landed.
   *
   * Everything here is resolved from the live block at the moment of the event
   * — an impact is allowed to *read* a dimension, it is just not allowed to
   * write one down. The single thing recorded is the timestamp, which goes into
   * the floor quad's ring buffer alongside two unitless fractions.
   */
  _starImpact(index) {
    const c = settings.starfall;
    const g = settings.global;
    const time = frame.uTime.value;

    this.stars.landPoint(index, _pos);

    /* --- the ring on the floor --- */
    // World offset from the anchor, rotated into the quad's own frame and
    // divided by the radius: a hit is recorded as a fraction, never a metre, so
    // dragging `zoneRadius` afterwards moves the rings out with the circle.
    const yaw = this._yaw();
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const ox = _pos.x - _centre.x;
    const oz = _pos.z - _centre.z;
    const radius = Math.max(0.05, c.zoneRadius);
    const strength = 0.7 + 0.3 * hash11(this._seed + index * 3.77);
    this.floor.mark((cos * ox - sin * oz) / radius, (sin * ox + cos * oz) / radius, time, strength);

    /* --- the shell --- */
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.shellSize * 0.2,
      endRadius: c.shellSize * g.explosionIntensity,
      life: Math.max(0.05, c.shellLife),
      intensity: c.shellIntensity,
      opacity: 0.8,
      fresnel: 1.8,
      displace: 0.35,
      squash: 0.72,
      colorA: getColor(c.colorShellA),
      colorB: getColor(c.colorShellB),
      colorC: getColor(c.colorShellC)
    });

    /* --- sparks, motes and dust --- */
    _emit.position = _pos;
    _emit.radius = 0.1;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.sparkSpeed;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.95;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.sparkBurst * g.particleCount), _emit);

    _emit.radius = 0.24;
    _emit.speed = c.moteSpeed;
    _emit.spread = 1.0;
    _emit.size = 0.09;
    _emit.life = c.moteLifetime;
    _emit.spin = 0;
    this.motes.emit(Math.round(c.moteBurst * g.particleCount), _emit);

    _emit.radius = c.ringRadius * 0.8;
    _emit.speed = c.dustSpeed;
    _emit.spread = 0.85;
    _emit.size = 0.7;
    _emit.life = c.dustLifetime;
    _emit.spin = 0.35;
    this.dust.emit(Math.round(c.dustBurst * g.particleCount), _emit);

    /* --- the room --- */
    this.position.copy(_pos);
    this.lightBoost = Math.min(60, this.lightBoost + c.lightPunch * g.explosionIntensity);
    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.05, c.shakeDuration),
      24
    );

    // The screen flash fires once, for the first star. Twenty-two of them is a
    // strobe, and a strobe is not a rain.
    if (!this._struck) {
      this._struck = true;
      this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    }
  }

  /** Glitter shed by the stars that are still falling. */
  _sparkleFx(dt) {
    const c = settings.starfall;
    const g = settings.global;
    if (this._live <= 0) return;

    // Rate per *star in the air*, so the glitter density is the arrival
    // envelope: it ramps as the call fills the sky and tails as it empties. No
    // second curve, and nothing to keep in step with the first.
    const rate = c.sparkleRate * this._live;
    const count = Math.round(this.sparkleEmitter.tick(dt, rate) * g.particleCount);
    if (count <= 0) return;

    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed * 0.4;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.06;
    _emit.sizeVariance = 0.7;
    _emit.life = c.moteLifetime * 0.7;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;

    for (let i = 0; i < count; i++) {
      const slot = Math.floor(Math.random() * this._live);
      this.stars.slotPosition(slot, _pos);
      _emit.position = _pos;
      _emit.radius = c.starSize * 1.4;
      this.motes.emit(1, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1);
    this._sparkleFx(dt);
    this.ctx.shake.rumble(settings.starfall.rumble * settings.global.cameraShake * 0.4, dt);
  }

  onImpact() {
    // Deliberately empty. The call arriving is not an event on the floor — the
    // stars are already falling and each one brings its own impact. Putting a
    // bang here was the first thing tried and it stole the read from the first
    // star, which is the beat the whole ability is built around.
  }

  onFade(dt, t) {
    // `t` runs 0..1 while the rain holds, then 1..2 while the light lets go.
    // Cubic, so the last rings hang on and then go rather than dimming evenly.
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
    this._sync(fade);
    this._sparkleFx(dt);
    this.ctx.shake.rumble(
      settings.starfall.rumble * settings.global.cameraShake * (t <= 1 ? 1 : 0),
      dt
    );
  }

  onDestroy() {
    this.stars.reset();
    this.floor.clearMarks();
    this._live = 0;
    this._struck = false;
  }

  dispose() {
    this.stars.dispose();
    this.floor.dispose();
    this.starMaterial.dispose();
    super.dispose();
  }
}
