import {
  InstancedMesh,
  InstancedBufferAttribute,
  ShaderMaterial,
  DoubleSide,
  NormalBlending,
  AdditiveBlending,
  Object3D,
  Vector3,
  Quaternion,
  Color
} from 'three';
import { frame, sharedUniforms } from '../core/FrameUniforms.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { LAYER } from '../core/Layers.js';
import { saturate } from '../utils/math.js';
import { GrowthLayout } from './GrowthField.js';

/* ---------------------------------------------------------------------- */
/* ShatterField — things that come apart                                   */
/* ---------------------------------------------------------------------- */

/**
 * Instanced fragments that inherit a velocity and tumble under gravity.
 *
 * Ice breaking, glass breaking, a prism splitting, a pane of frozen time coming
 * down: the same system every time, and the fragment geometry is the only part
 * that differs. So the geometry is the caller's (a shard, a pane, a prism chip
 * from `assets/ProceduralGeometry.js` or the ability's own), and this module
 * owns the flight, the tumble, the fade and the draw.
 *
 * ## The flight is solved, not stepped
 *
 * Nothing here integrates. A fragment's position is a closed-form function of
 * `now − born` evaluated against the **live** params, so:
 *
 *   - pausing and dragging `gravity` re-flies every fragment in the air — which
 *     an Euler integrator physically cannot do, because it has already spent the
 *     old gravity and has nowhere to put the new one (invariant I1);
 *   - a zero-length frame is not a special case, it is just the same evaluation
 *     again;
 *   - a fragment stores nothing but dice and one timestamp.
 *
 * With drag, `dv/dt = −k·v + g` integrates to
 * `p(t) = p₀ + (v₀ − g/k)(1 − e^{−kt})/k + (g/k)·t`, which is what the loop
 * evaluates; below `k ≈ 0` it falls back to the ballistic form rather than
 * dividing by nothing.
 *
 * ## The screen-space sample
 *
 * A shard of glass that is a flat tint is a shard of plastic. Given a texture of
 * the scene, the fragment shader samples it at its own screen position, offset
 * by the surface normal (cheap refraction), desaturated and tinted — so the
 * shard shows a cold, displaced copy of what is behind it. That is the whole
 * trick behind Chronofracture's panes.
 *
 * **The repo does not currently expose a read buffer.** `PostProcessing` runs an
 * `EffectComposer` whose ping-pong targets are internal, and sampling the target
 * you are drawing into is a feedback loop, not a refraction. So this degrades:
 * with no texture bound the shader compiles without the sample at all and the
 * shard is its solid tint. When a colour buffer does appear — either
 * `frame.uSceneColor`, which is polled here so a later agent can add it with no
 * change to this file, or one handed over via `setSceneTexture()` — the define
 * flips and the material recompiles once. Never per frame.
 *
 * ## The rule for using it well
 *
 * Fragments are *debris*, so give them somewhere to have come from: pass the
 * live velocity of whatever broke as `inherit`, and set `spread` low. A burst of
 * fragments with `spread: 1` is a firework; a burst with `spread: 0.35` and an
 * inherited velocity is a thing that shattered.
 *
 * @example
 *   this.shards = new ShatterField(this.group, {
 *     geometry: (v) => createShardGeometry(3.1 + v * 9.7),
 *     capacity: 200,
 *     variants: 2
 *   });
 *   // impact
 *   this.shards.burst(this.age, c.fragmentCount, 1);
 *   // every frame, travel and fade alike
 *   this.shards.sync(this._look);
 *   this.shards.update(this.age, this._params);
 */

/* Module-scope scratch — invariant I3. */
const _dummy = new Object3D();
const _v = new Vector3();
const _rand = new Vector3();
const _anchor = new Vector3();
const _axis = new Vector3();
const _spin = new Quaternion();
const _up = new Vector3(0, 1, 0);
const _zero = new Vector3();
const _forward = new Vector3(0, 0, 1);
const _right = new Vector3(1, 0, 0);

/** Re-exported so an ability can spell the layout without importing GrowthField. */
export { GrowthLayout as ShatterLayout };

const SHATTER_VERTEX = /* glsl */ `
  attribute float aSeed;
  attribute float aLife;

  varying float vSeed;
  varying float vLife;
  varying vec3  vLocal;
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;

  void main() {
    vSeed  = aSeed;
    vLife  = aLife;
    vLocal = position;

    mat4 im = mat4(1.0);
    #ifdef USE_INSTANCING
      im = instanceMatrix;
    #endif

    vec4 world = modelMatrix * im * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * mat3(im) * normal);
    vViewDir = cameraPosition - world.xyz;

    vec4 mv = viewMatrix * world;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const SHATTER_FRAGMENT = /* glsl */ `
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uColorEdge;
  uniform vec3  uColorScene;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uRim;
  uniform float uRimPower;
  uniform float uShade;
  uniform float uAmbient;
  uniform float uFadeStart;
  uniform float uSoft;
  uniform float uSceneMix;
  uniform float uRefract;
  uniform float uSaturation;

  uniform vec3      uLightDir;
  uniform vec2      uResolution;
  uniform sampler2D uSceneDepth;
  uniform float     uCameraNear;
  uniform float     uCameraFar;
  uniform float     uGlobalGlow;
  uniform float     uShaderIntensity;

  #ifdef SHATTER_SCENE
    uniform sampler2D uScene;
  #endif

  varying float vSeed;
  varying float vLife;
  varying vec3  vLocal;
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;

  ${commonGLSL}

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDir);

    // Faceted debris, lit off the same key direction the stage uses so the
    // fragments do not read as stickers against the shadowed floor. Two-sided:
    // a shard is thin enough that you see its back face constantly.
    float lambert = max(dot(N, uLightDir), 0.0);
    if (dot(N, V) < 0.0) lambert = max(dot(-N, uLightDir), 0.0);
    float shade = mix(1.0, uAmbient + (1.0 - uAmbient) * lambert, uShade);

    float fres = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), uRimPower);

    vec3 body = mix(uColorA, uColorB, clamp(vLife, 0.0, 1.0)) * shade;

    #ifdef SHATTER_SCENE
      // Screen-space refraction: push the lookup along the surface normal, so a
      // fragment turned edge-on to the camera displaces what is behind it most.
      // The sample is deliberately *not* depth-corrected — it is a shard, not a
      // window, and paying for a correct parallax would buy nothing you can see.
      vec2 uv = gl_FragCoord.xy / uResolution + N.xy * uRefract;
      vec3 behind = texture2D(uScene, clamp(uv, vec2(0.002), vec2(0.998))).rgb;
      float grey = dot(behind, vec3(0.2126, 0.7152, 0.0722));
      behind = mix(vec3(grey), behind, uSaturation) * uColorScene;
      body = mix(body, behind, clamp(uSceneMix, 0.0, 1.0));
    #endif

    // The rim is the only emissive term. Scaling the *body* by the global glow
    // would brighten a lump of debris along with the sparks, and debris that
    // glows is the single fastest way to make a shatter read as confetti.
    vec3 color = body;
    color += uColorEdge * fres * uRim * uGlow * uGlobalGlow * mix(0.7, 1.0, uShaderIntensity);

    float alpha = uOpacity * (1.0 - smoothstep(uFadeStart, 1.0, clamp(vLife, 0.0, 1.0)));

    if (uSoft > 0.0) {
      vec2 screenUV = gl_FragCoord.xy / uResolution;
      alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoft);
    }

    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * Canonical parameter names with their defaults, in the units the field wants.
 * Read fresh on every `update()`; a missing field falls back to the default.
 */
export function shatterParams() {
  return {
    /* --- basis (the ability's own vectors; never copied) --- */
    layout: GrowthLayout.LINE,
    origin: null, // Vector3, on the floor
    direction: null, // Vector3, unit, flat — also the default throw direction
    side: null, // Vector3, unit, lateral
    length: 10, // metres down the line
    centre: null, // Vector3 for ZONE; defaults to the far end of the line
    radius: 4, // metres, ZONE footprint the fragments start inside
    width: 1, // metres, LINE half-width the `lateral` dice is measured against

    /* --- where a fragment starts --- */
    spawnRadius: 0.5, // metres of scatter about its anchor point
    spawnHeight: 0.4, // metres the anchor sits above the floor

    /* --- how it leaves --- */
    speed: 6, // metres/second
    speedJitter: 0.6, // ± fraction
    spread: 0.45, // 0 throws every fragment along `direction`, 1 is fully random
    upBias: 0.5, // how much +Y is folded into the throw direction, 0..1
    inherit: null, // Vector3, metres/second, the velocity of whatever broke
    inheritScale: 1, // multiplier on that

    /* --- the flight --- */
    gravity: -18, // metres/second², signed
    drag: 0.8, // 1/second; 0 is pure ballistics

    /* --- the body --- */
    size: 0.28, // metres, the unit geometry's scale
    sizeJitter: 0.55, // ± fraction
    shrink: 0.7, // 0..1 of its size lost by the end of life
    shrinkPower: 1.6, // how late that shrink bites
    spin: 9, // radians/second of tumble
    spinJitter: 0.8, // ± fraction

    /* --- the clock --- */
    lifetime: 1.4, // seconds a fragment lives

    /* --- the floor --- */
    floor: 0.0, // metres; fragments never sink below floor + their own half-size
    floorSpin: 0.25, // fraction of the tumble rate kept once grounded

    /* --- globals --- */
    randomness: 1 // multiplies every *Jitter above (settings.global.randomness)
  };
}

export class ShatterField {
  /**
   * @param {THREE.Object3D} parent  the ability's group
   * @param {object} options
   * @param {(variant: number) => THREE.BufferGeometry} options.geometry
   *        unit-space fragment factory — a body inside a unit sphere, centred on
   *        its own origin, because the tumble rotates about that point
   * @param {number} [options.variants=2]   distinct fragment shapes = draw calls
   * @param {number} [options.capacity=192] hard ceiling on live fragments
   * @param {THREE.Material} [options.material] supply one to bypass the built-in
   *        shader entirely; it must consume `aSeed` and `aLife` itself
   * @param {boolean} [options.additive=false] additive blending for glowing debris
   * @param {boolean} [options.depthWrite=true]
   * @param {number} [options.layer=LAYER.VFX]
   * @param {number} [options.renderOrder=6]
   * @param {boolean} [options.castShadow=false] fragments are small and numerous;
   *        a shadow per fragment costs more than it reads
   */
  constructor(parent, options = {}) {
    const {
      geometry,
      variants = 2,
      capacity = 192,
      material = null,
      additive = false,
      depthWrite = true,
      layer = LAYER.VFX,
      renderOrder = 6,
      castShadow = false,
      receiveShadow = false
    } = options;

    if (typeof geometry !== 'function') throw new Error('ShatterField: options.geometry must be a factory');

    this.parent = parent;
    this.factory = geometry;
    this.variants = Math.max(1, Math.round(variants));
    this.capacity = Math.max(1, Math.round(capacity));
    this.slots = Math.ceil(this.capacity / this.variants);

    /** True when the material is ours to dispose. */
    this._ownsMaterial = !material;
    this.material = material ?? this._createMaterial(additive, depthWrite);
    this.uniforms = this.material.uniforms ?? null;

    this.meshes = [];
    this.seedAttributes = [];
    this.lifeAttributes = [];

    for (let v = 0; v < this.variants; v++) {
      const seeds = new InstancedBufferAttribute(new Float32Array(this.slots), 1);
      const lives = new InstancedBufferAttribute(new Float32Array(this.slots), 1);

      const geo = this.factory(v);
      geo.setAttribute('aSeed', seeds);
      geo.setAttribute('aLife', lives);

      const mesh = new InstancedMesh(geo, this.material, this.slots);
      mesh.frustumCulled = false;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      mesh.count = 0;
      mesh.layers.set(layer);
      mesh.renderOrder = renderOrder;
      parent.add(mesh);

      this.meshes.push(mesh);
      this.seedAttributes.push(seeds);
      this.lifeAttributes.push(lives);
    }

    /**
     * Fixed-size record pool. Dice and one timestamp — see the class header.
     */
    this.records = [];
    for (let i = 0; i < this.capacity; i++) {
      this.records.push({
        born: -1, // absolute age it was thrown at, or -1 for a dead slot
        along: 1, // 0..1 down the cast line it came off
        lateral: 0, // -1..1 across the band
        angle: 0, // 0..1 of a turn — ZONE bearing
        radial: 0, // 0..1 sqrt-uniform — ZONE distance
        offX: 0, // unit-sphere scatter about the anchor
        offY: 0,
        offZ: 0,
        dirX: 0, // unit-sphere throw dice
        dirY: 1,
        dirZ: 0,
        axisX: 0, // unit tumble axis
        axisY: 1,
        axisZ: 0,
        speedRoll: 0, // -1..1
        sizeRoll: 0, // -1..1
        spinRoll: 0, // -1..1
        seed: 0 // 0..10, mirrored into aSeed
      });
    }

    this._cursor = 0;
    this._live = 0;
    this._used = new Int32Array(this.variants);
    this._hasScene = false;
    /** True once the ability bound a texture by hand; stops `sync` overriding it. */
    this._sceneOverride = false;
  }

  /** Live fragments this frame. Feed into `Ability#instanceCount`. */
  get count() {
    return this._live;
  }

  /** Draw calls while anything is in the air. */
  get drawCalls() {
    return this.variants;
  }

  /* ------------------------------------------------------------------ */
  /* Material                                                            */
  /* ------------------------------------------------------------------ */

  _createMaterial(additive, depthWrite) {
    return new ShaderMaterial({
      transparent: true,
      depthWrite,
      depthTest: true,
      // A fragment is a solid seen from both sides as it tumbles; culling the
      // back face makes a thin pane vanish for half of every rotation.
      side: DoubleSide,
      blending: additive ? AdditiveBlending : NormalBlending,
      toneMapped: false,
      defines: {},
      uniforms: sharedUniforms({
        uColorA: { value: new Color(1, 1, 1) },
        uColorB: { value: new Color(0.4, 0.6, 0.8) },
        uColorEdge: { value: new Color(1, 1, 1) },
        uColorScene: { value: new Color(1, 1, 1) },
        uOpacity: { value: 1 },
        uGlow: { value: 1 },
        uRim: { value: 0.8 },
        uRimPower: { value: 2.4 },
        uShade: { value: 1 },
        uAmbient: { value: 0.35 },
        uFadeStart: { value: 0.6 },
        uSoft: { value: 0 },
        uSceneMix: { value: 0.75 },
        uRefract: { value: 0.05 },
        uSaturation: { value: 0.3 },
        uScene: { value: null }
      }),
      vertexShader: SHATTER_VERTEX,
      fragmentShader: SHATTER_FRAGMENT
    });
  }

  /**
   * Bind (or unbind) the colour buffer the fragments sample.
   *
   * Recompiles the material on the transition only — the define is what removes
   * the sampler from the shader entirely when there is nothing to sample, which
   * is the difference between "degrades gracefully" and "renders black".
   *
   * @param {THREE.Texture|null} texture
   */
  setSceneTexture(texture) {
    this._sceneOverride = !!texture;
    this._bindScene(texture ?? null);
  }

  /** The binding itself, without claiming ownership of the choice. */
  _bindScene(texture) {
    if (!this.uniforms) return;
    const has = !!texture;
    this.uniforms.uScene.value = texture ?? null;
    if (has === this._hasScene) return;
    this._hasScene = has;
    if (has) this.material.defines.SHATTER_SCENE = '';
    else delete this.material.defines.SHATTER_SCENE;
    this.material.needsUpdate = true;
  }

  /**
   * Push the look from live settings. Every colour is its own picker (I5); the
   * three body/edge colours are never derived from one another.
   *
   * @param {object} look colorA, colorB, colorEdge, colorScene (THREE.Color),
   *   opacity, glow, rim, rimPower, shade, ambient, fadeStart, soft,
   *   sceneMix, refract, saturation
   */
  sync(look) {
    const u = this.uniforms;
    if (!u) return;

    if (look.colorA) u.uColorA.value.copy(look.colorA);
    if (look.colorB) u.uColorB.value.copy(look.colorB);
    if (look.colorEdge) u.uColorEdge.value.copy(look.colorEdge);
    if (look.colorScene) u.uColorScene.value.copy(look.colorScene);

    u.uOpacity.value = look.opacity ?? 1;
    u.uGlow.value = look.glow ?? 1;
    u.uRim.value = look.rim ?? 0.8;
    u.uRimPower.value = look.rimPower ?? 2.4;
    u.uShade.value = look.shade ?? 1;
    u.uAmbient.value = look.ambient ?? 0.35;
    u.uFadeStart.value = look.fadeStart ?? 0.6;
    u.uSoft.value = look.soft ?? 0;
    u.uSceneMix.value = look.sceneMix ?? 0.75;
    u.uRefract.value = look.refract ?? 0.05;
    u.uSaturation.value = look.saturation ?? 0.3;

    // A colour buffer the app grows *later* costs nothing to pick up here, and
    // nothing to not find: `frame.uSceneColor` does not exist in the repo today,
    // so this reads as null and the shard stays a solid tint. The day someone
    // wires a scene copy into `FrameUniforms`, every ShatterField starts
    // refracting without a line changing in this file.
    if (!this._sceneOverride) {
      const shared = frame.uSceneColor ? frame.uSceneColor.value : null;
      if (shared !== u.uScene.value) this._bindScene(shared);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Bursting — the only place the dice are rolled                       */
  /* ------------------------------------------------------------------ */

  /**
   * Throw `count` fragments. Call from an impact or a break beat.
   *
   * Everything captured here is unitless: where along the cast the break
   * happened as a fraction, a unit throw direction, a unit tumble axis and a
   * handful of ± rolls. The metres arrive in `update()`.
   *
   * @param {number} now    the ability's `age`, seconds
   * @param {number} count  fragments to throw, clamped to the free capacity
   * @param {number} [along] 0..1 down the cast line (LINE), or the radial
   *                 fraction of the zone (ZONE) the break happened at
   * @param {number} [lateral] -1..1 across the band, for a break off the axis
   * @returns {number} fragments actually thrown
   */
  burst(now, count, along = 1, lateral = 0) {
    const wanted = Math.max(0, Math.round(count));
    let thrown = 0;

    for (let n = 0; n < wanted; n++) {
      const index = this._cursor;
      this._cursor = (this._cursor + 1) % this.capacity;

      const record = this.records[index];
      record.born = now;
      record.along = saturate(along);
      record.lateral = lateral;
      record.angle = Math.random();
      record.radial = Math.sqrt(Math.random());
      record.seed = Math.random() * 10;
      record.speedRoll = Math.random() * 2 - 1;
      record.sizeRoll = Math.random() * 2 - 1;
      record.spinRoll = Math.random() * 2 - 1;

      randomUnit(_rand);
      record.offX = _rand.x;
      record.offY = _rand.y;
      record.offZ = _rand.z;

      randomUnit(_rand);
      record.dirX = _rand.x;
      record.dirY = _rand.y;
      record.dirZ = _rand.z;

      randomUnit(_rand);
      record.axisX = _rand.x;
      record.axisY = _rand.y;
      record.axisZ = _rand.z;

      // The seed attribute is per *slot*, and a slot is shared by the record
      // that owns it, so it is written here rather than once at construction.
      const variant = index % this.variants;
      const slot = (index / this.variants) | 0;
      this.seedAttributes[variant].array[slot] = record.seed;
      this.seedAttributes[variant].needsUpdate = true;

      thrown++;
    }

    return thrown;
  }

  /** Kill everything in the air. `onDestroy()`. */
  clear() {
    for (let i = 0; i < this.capacity; i++) this.records[i].born = -1;
    this._live = 0;
    this._cursor = 0;
    for (let v = 0; v < this.variants; v++) this.meshes[v].count = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Resolving                                                           */
  /* ------------------------------------------------------------------ */

  /** Where a fragment was thrown from, at the live footprint. Writes `out`. */
  _anchorOf(record, p, out) {
    const layout = p.layout ?? GrowthLayout.LINE;
    const origin = p.origin ?? _zero;
    const direction = p.direction ?? _forward;
    const side = p.side ?? _right; // only used in LINE, where the caller supplies it

    if (layout === GrowthLayout.ZONE) {
      const centre = p.centre;
      if (centre) out.copy(centre);
      else out.copy(origin).addScaledVector(direction, p.length ?? 0);
      const angle = record.angle * Math.PI * 2;
      const r = (p.radius ?? 0) * record.radial * saturate(record.along);
      out.x += Math.cos(angle) * r;
      out.z += Math.sin(angle) * r;
    } else {
      out.copy(origin).addScaledVector(direction, record.along * (p.length ?? 0));
      out.addScaledVector(side, record.lateral * (p.width ?? 0));
    }

    out.y += p.spawnHeight ?? 0;
    const scatter = p.spawnRadius ?? 0;
    out.x += record.offX * scatter;
    out.y += record.offY * scatter;
    out.z += record.offZ * scatter;
    return out;
  }

  /** Initial velocity of a fragment, metres/second. Writes `out`. */
  _velocityOf(record, p, out) {
    const jitter = p.randomness ?? 1;
    const spread = saturate(p.spread ?? 0.45);

    _rand.set(record.dirX, record.dirY, record.dirZ);
    out.copy(p.direction ?? _forward);
    out.addScaledVector(_up, p.upBias ?? 0);
    if (out.lengthSq() < 1e-8) out.copy(_up);
    out.normalize().lerp(_rand, spread);
    if (out.lengthSq() < 1e-8) out.copy(_rand);
    out.normalize();

    const speed = (p.speed ?? 0) * (1 + record.speedRoll * (p.speedJitter ?? 0) * jitter);
    out.multiplyScalar(speed);
    if (p.inherit) out.addScaledVector(p.inherit, p.inheritScale ?? 1);
    return out;
  }

  /**
   * World position of a fragment `t` seconds after it was thrown.
   *
   * The analytic drag solution; see the class header for why this is not an
   * integrator. Returns `out`.
   */
  _flight(record, p, t, out) {
    this._anchorOf(record, p, out);
    this._velocityOf(record, p, _v);

    const g = p.gravity ?? 0;
    const k = p.drag ?? 0;

    if (k > 1e-3) {
      const e = Math.exp(-k * t);
      const decay = (1 - e) / k;
      const terminal = g / k; // the fall speed drag settles at, m/s
      out.x += _v.x * decay;
      out.z += _v.z * decay;
      out.y += (_v.y - terminal) * decay + terminal * t;
    } else {
      out.x += _v.x * t;
      out.z += _v.z * t;
      out.y += _v.y * t + 0.5 * g * t * t;
    }
    return out;
  }

  /** World position of fragment `i`, live. Trails and lights hang off this. */
  positionOf(index, now, p, out) {
    const record = this.records[index];
    if (record.born < 0) return out.set(0, -999, 0);
    return this._flight(record, p, Math.max(0, now - record.born), out);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Re-fly every fragment from the live params. Allocation-free.
   *
   * @param {number} now the ability's `age`, seconds
   * @param {object} p   live params — see `shatterParams()`
   * @returns {number} live fragments
   */
  update(now, p) {
    const variants = this.variants;
    const used = this._used;
    used.fill(0);

    const lifetime = Math.max(0.02, p.lifetime ?? 1.4);
    const jitter = p.randomness ?? 1;
    const floor = p.floor ?? 0;
    const shrink = saturate(p.shrink ?? 0);
    const shrinkPower = p.shrinkPower ?? 1.6;
    let live = 0;

    for (let i = 0; i < this.capacity; i++) {
      const record = this.records[i];
      const variant = i % variants;
      const slot = (i / variants) | 0;
      const age = record.born < 0 ? -1 : now - record.born;
      const life = age / lifetime;

      if (age < 0 || life >= 1) {
        // Dead or unborn: park it, keep the slot contiguous.
        if (record.born >= 0 && life >= 1) record.born = -1;
        _dummy.position.set(0, -999, 0);
        _dummy.quaternion.identity();
        _dummy.scale.setScalar(0.0001);
        _dummy.updateMatrix();
        this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
        this.lifeAttributes[variant].array[slot] = 1;
        used[variant] = Math.max(used[variant], slot + 1);
        continue;
      }

      /* --- size, before the flight: the floor clamp needs the half-height --- */
      const size =
        Math.max(0.001, (p.size ?? 0.25) * (1 + record.sizeRoll * (p.sizeJitter ?? 0) * jitter)) *
        (1 - shrink * Math.pow(life, shrinkPower));

      /* --- the flight --- */
      this._flight(record, p, age, _dummy.position);

      const rest = floor + size * 0.35;
      let grounded = false;
      if (_dummy.position.y < rest) {
        _dummy.position.y = rest;
        grounded = true;
      }

      /* --- the tumble --- */
      // A grounded fragment keeps `floorSpin` of its rate rather than stopping
      // dead. Solving for the contact time to stop it properly is a quadratic
      // with no closed form once drag is in play, and at the size these read at
      // nobody has ever noticed the difference.
      const rate =
        (p.spin ?? 0) *
        (1 + record.spinRoll * (p.spinJitter ?? 0) * jitter) *
        (grounded ? saturate(p.floorSpin ?? 0.25) : 1);
      _axis.set(record.axisX, record.axisY, record.axisZ);
      if (_axis.lengthSq() < 1e-8) _axis.copy(_up);
      _axis.normalize();
      _spin.setFromAxisAngle(_axis, rate * age);

      _dummy.quaternion.copy(_spin);
      _dummy.scale.setScalar(size);
      _dummy.updateMatrix();

      this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
      this.lifeAttributes[variant].array[slot] = life;
      used[variant] = Math.max(used[variant], slot + 1);
      live++;
    }

    for (let v = 0; v < variants; v++) {
      this.meshes[v].count = used[v];
      this.meshes[v].instanceMatrix.needsUpdate = true;
      this.lifeAttributes[v].needsUpdate = true;
    }

    this._live = live;
    return live;
  }

  dispose() {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
      mesh.parent?.remove(mesh);
    }
    this.meshes.length = 0;
    if (this._ownsMaterial) this.material.dispose();
  }
}

/* ---------------------------------------------------------------------- */
/* Helpers                                                                 */
/* ---------------------------------------------------------------------- */

/**
 * A uniformly distributed point on the unit sphere, written into `out`.
 *
 * Rejection sampling inside the cube is the textbook version and it is wrong
 * here for a mundane reason: it loops an unbounded number of times, and a burst
 * rolls three of these per fragment. The z-then-angle construction is exact,
 * branch-free and constant time.
 */
function randomUnit(out) {
  const z = Math.random() * 2 - 1;
  const angle = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return out.set(Math.cos(angle) * r, z, Math.sin(angle) * r);
}
