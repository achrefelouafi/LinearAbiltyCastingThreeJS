import {
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  MeshStandardMaterial,
  PlaneGeometry,
  Sphere,
  Vector2,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Feathers that actually know how to fall — the material behind Featherfall.
 *
 * ## The trick lives here, not in the ability
 *
 * A feather does not sink. It **stalls, slips sideways, catches and glides**,
 * and it does all of that because a thin plate falling through air is
 * aerodynamically unstable in two distinct ways. Real flat-plate descent has
 * two regimes — *fluttering*, a side-to-side oscillation with a stall at each
 * extreme, and *tumbling*, a continuous end-over-end rotation that drifts
 * steadily to one side — and which one a given plate falls into depends on its
 * aspect ratio and its Reynolds number. Both are implemented, both are in the
 * air at once, and which one a feather picks is a per-instance dice roll
 * against `tumbleShare`. That is what "no two descend the same way" means: not
 * jitter on one motion, two different motions.
 *
 * The flutter is written as one closed form and it is worth stating, because
 * everything else follows from it:
 *
 * ```
 *   lateral(τ) = (swing / ω) · (sin φ − sin φ₀)          φ = ωτ + φ₀
 *   v_y(τ)     = sink · (1 − lift · cos²φ)
 *   drop(τ)    = sink·(1 − lift/2)·τ  −  sink·lift·(sin 2φ − sin 2φ₀) / 4ω
 * ```
 *
 * `cos φ` is the horizontal velocity, so `cos²φ` is largest exactly where the
 * feather is moving fastest sideways — which is where a plate generates lift
 * and where it therefore falls *slowest*. At `cos φ = 0` the horizontal motion
 * reverses, the lift vanishes and the feather drops at its full sink rate.
 * That is the stall, twice a cycle, and it is the single detail that separates
 * this from a sine wave applied to a falling sprite. The vertical drop is the
 * analytic integral of the vertical velocity, so the two are exactly
 * consistent and the descent cannot drift out of step with the swing.
 *
 * ## Nothing integrates, so everything is a live slider
 *
 * Position is a **closed-form function of `(age − release, seed)`** evaluated
 * in the vertex shader against the live uniforms. There is no CPU state, no
 * Euler step and no per-feather record: an integrator has already spent the
 * old `lift` and physically cannot re-fly a feather that is halfway down when
 * you drag the slider with the clock stopped. This can, and does — pause with
 * **P** and take `lift` to zero and two hundred feathers stop gliding and drop
 * where they hang.
 *
 * It also means the *shape* of the feather is built in the vertex shader from
 * `uv` alone, so vane width, taper, cup, arch and the barb ripple are uniforms
 * rather than baked geometry. The first version baked the outline and had to
 * rebuild it whenever a proportion moved, which is a hash, a comparison and an
 * allocation on a frame where a slider changed — all avoidable, since a
 * parametric outline costs the vertex shader about eight instructions.
 *
 * `flatShading` is on, which is what makes that legal: with no `vNormal`
 * varying, every view-dependent term reads the face normal that
 * `<normal_fragment_begin>` derives from screen derivatives, so a mesh
 * deformed entirely in the vertex stage gets correct normals for free. The
 * same argument `PetalMaterial` makes, for the same reason.
 *
 * ## The landing
 *
 * A closed-form fall has no collision, so the landing is solved instead. The
 * *mean* sink rate is known in advance — `sink·(1 − lift/2)` for a flutterer,
 * `tumbleSink` for a tumbler — so the time at which a feather has used up its
 * release height is one divide, and the whole model is evaluated at
 * `min(τ, τ_land)`. Everything freezes together: swing, drop, pitch and spin,
 * all on the same frame, which is what makes it read as coming to rest rather
 * than as being switched off. Over the last `settleTime` seconds the attitude
 * blends to the nearest flat orientation, so the feather lies down instead of
 * standing on its edge. The residual few centimetres of oscillation left over
 * by the mean-rate approximation are absorbed by a clamp against the floor.
 */

/**
 * The feather's geometry: a parametric sheet, and nothing else.
 *
 * `position` is thrown away by the vertex shader — the only attribute that
 * matters is `uv`, which carries `(across 0..1, along 0..1)`. That is the
 * whole point: the outline is a function of two parameters and a dozen live
 * uniforms, so there is no geometry to rebuild when a proportion changes.
 *
 * The plane's own attributes are handed to the instanced geometry by
 * reference and the plane is deliberately **not** disposed: `dispose()` would
 * fire a teardown for the very buffers being kept. It has never been uploaded,
 * so letting it fall out of scope costs nothing.
 *
 * @param {number} capacity  hard ceiling on feathers in one cast
 * @param {number} across    quads across the vane; 5 is enough for a cupped
 *                           cross-section and the sixth is invisible
 * @param {number} along     quads up the rachis; the barb ripple is the
 *                           highest-frequency thing on the outline and 14
 *                           samples it about twice per wave
 */
export function createFeatherGeometry(capacity, across = 5, along = 14) {
  const sheet = new PlaneGeometry(1, 1, across, along);

  const geometry = new InstancedBufferGeometry();
  geometry.index = sheet.index;
  geometry.setAttribute('position', sheet.getAttribute('position'));
  geometry.setAttribute('normal', sheet.getAttribute('normal'));
  geometry.setAttribute('uv', sheet.getAttribute('uv'));

  // Four unitless dice per feather. Everything else the shader needs is
  // hashed out of these, so a cast writes 4N floats once and never again.
  const seeds = new Float32Array(capacity * 4);
  geometry.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 4));

  geometry.instanceCount = 0;
  // Every vertex is placed by the shader, so the real bounds are unknowable
  // here. The mesh is `frustumCulled = false`; this only stops three from
  // computing a bounding sphere of NaN off the unit sheet.
  geometry.boundingSphere = new Sphere(new Vector3(), 1);
  return geometry;
}

/**
 * The material.
 *
 * @param {object} environment the app's `Environment`, for the shadow/CSM patch
 */
export function createFeatherMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.74,
    metalness: 0.0,
    flatShading: true,
    transparent: true,
    // A feather has two faces and you see both of them in one descent, twice a
    // second. Culling either one makes the tumble blink.
    side: DoubleSide,
    depthWrite: true
  });

  const uniforms = {
    /* --- the clock. The ability's own age, not the global one: the descent
     *     has to freeze when the sandbox is paused and resume where it was. --- */
    uAge: { value: 0 },
    uFade: { value: 1 },
    uLightDir: frame.uLightDir,

    /* --- where the flock is released, metres --- */
    uOrigin: { value: new Vector3() },
    uRadius: { value: 5 },
    uCeiling: { value: 4.6 },
    uCeilingVary: { value: 0.4 },
    uStagger: { value: 1.9 },
    uFloor: { value: 0.012 },
    uWind: { value: new Vector2() },

    /* --- the feather itself, in units of its own length --- */
    uSize: { value: 0.26 },
    uSizeVary: { value: 0.45 },
    uVaneWidth: { value: 0.19 },
    uWidthBias: { value: 0.85 },
    uTaper: { value: 0.65 },
    uLeadFrac: { value: 0.62 },
    uQuill: { value: 0.16 },
    uCup: { value: 0.55 },
    uArch: { value: 0.1 },
    uBarb: { value: 0.06 },
    uBarbFreq: { value: 22 },
    uPivot: { value: 0.42 },

    /* --- the flutter regime --- */
    uSink: { value: 1.05 },
    uLift: { value: 0.6 },
    uSwing: { value: 0.95 },
    uFlutterRate: { value: 4.2 },
    uFlutterVary: { value: 0.55 },
    uPitch: { value: 0.95 },
    uSpin: { value: 0.35 },

    /* --- the tumbling regime --- */
    uTumbleShare: { value: 0.28 },
    uTumbleRate: { value: 7.5 },
    uTumbleDrift: { value: 0.55 },
    uTumbleSink: { value: 1.15 },
    uTumbleBob: { value: 0.06 },

    /* --- the catch --- */
    uCatchGain: { value: 0.55 },
    uCatchWidth: { value: 0.55 },
    uCatchWindow: { value: 3.2 },

    /* --- the ends of the descent --- */
    uBirthFade: { value: 0.35 },
    uSettleTime: { value: 0.9 },

    /* --- shading --- */
    uColorQuill: { value: new Color() },
    uColorVane: { value: new Color() },
    uColorTip: { value: new Color() },
    uColorGlow: { value: new Color() },
    uRachis: { value: 0.55 },
    uBarbLines: { value: 0.35 },
    uBarbCount: { value: 26 },
    uGrain: { value: 0.18 },
    uGrainScale: { value: 6 },
    uFresnel: { value: 0.7 },
    uFresnelPower: { value: 2.4 },
    uTranslucency: { value: 1.6 },
    uTranslucencyPower: { value: 3.2 },
    uGlow: { value: 0.8 },
    uOpacity: { value: 1 }
  };

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec4 aSeed;     // four unitless dice, per feather
         uniform float uAge;
         uniform float uFade;
         uniform vec3  uOrigin;
         uniform float uRadius;
         uniform float uCeiling;
         uniform float uCeilingVary;
         uniform float uStagger;
         uniform float uFloor;
         uniform vec2  uWind;
         uniform float uSize;
         uniform float uSizeVary;
         uniform float uVaneWidth;
         uniform float uWidthBias;
         uniform float uTaper;
         uniform float uLeadFrac;
         uniform float uQuill;
         uniform float uCup;
         uniform float uArch;
         uniform float uBarb;
         uniform float uBarbFreq;
         uniform float uPivot;
         uniform float uSink;
         uniform float uLift;
         uniform float uSwing;
         uniform float uFlutterRate;
         uniform float uFlutterVary;
         uniform float uPitch;
         uniform float uSpin;
         uniform float uTumbleShare;
         uniform float uTumbleRate;
         uniform float uTumbleDrift;
         uniform float uTumbleSink;
         uniform float uTumbleBob;
         uniform float uCatchGain;
         uniform float uCatchWidth;
         uniform float uCatchWindow;
         uniform float uBirthFade;
         uniform float uSettleTime;
         varying float vAlong;
         varying float vAcross;
         varying float vDice;
         varying float vRest;
         varying float vAlpha;
         varying vec3  vFeatherWorld;

         /* Decorrelated randoms out of the four dice. Deliberately not a noise
          * function: this is called six times per vertex and every one of them
          * wants a different, stable, unitless number rather than a field. */
         float featherRand(vec2 p) {
           return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
         }`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           /* No turn constant is declared here, and that is not an oversight.
            *
            * This is a patched MeshStandardMaterial, so three's
            * <common> chunk is already above us and it does
            *
            *     #define PI2 6.283185307179586
            *
            * A local "const float PI2 = ..." is therefore not a shadowed
            * declaration, it is a macro expansion: the preprocessor rewrites it
            * to "const float 6.283185307179586 = 6.28318530718;" and the whole
            * vertex shader fails to compile with a syntax error pointing at a
            * number that appears nowhere in this file. The feathers then do not
            * draw at all — and nothing catches it, because npm run check
            * compiles no GLSL and the reserved-word sweep only looks for GLSL ES
            * 3.00 keywords, not for three's own macros. It took a live GL
            * context to find.
            *
            * PI2 below is three's, same quantity, more digits. The names to
            * avoid in any patched standard material are PI, PI2, PI_HALF,
            * RECIPROCAL_PI, RECIPROCAL_PI2, EPSILON and LOG2 — see
            * three/src/renderers/shaders/ShaderChunk/common.glsl.js. */

           float r1 = aSeed.x;
           float r2 = aSeed.y;
           float r3 = aSeed.z;
           float r4 = aSeed.w;
           float r5 = featherRand(aSeed.xy);
           float r6 = featherRand(aSeed.yz + 3.71);
           float r7 = featherRand(aSeed.zw + 11.37);
           float r8 = featherRand(aSeed.xw + 5.13);

           /* ---- where and when this one was let go ---- */
           // sqrt on the radial roll, or the flock crowds the middle of the
           // circle: uniform in r gives uniform in *radius*, not in area.
           float bearing = PI2 * r1;
           float radius = uRadius * sqrt(r2);
           vec3 base = uOrigin + vec3(cos(bearing) * radius, 0.0, sin(bearing) * radius);

           float y0 = uCeiling * (1.0 - uCeilingVary * r3);
           float release = uStagger * r4;
           float tau = max(0.0, uAge - release);

           /* ---- which regime ---- */
           // Not a blend of two motions: a per-feather choice between them.
           float mode = step(r5, uTumbleShare);   // 1 = tumbling, 0 = fluttering

           /* ---- the landing time, from the mean sink rate of that regime ---- */
           float meanFlutter = max(0.02, uSink * (1.0 - 0.5 * uLift));
           float meanSink = mix(meanFlutter, max(0.02, uTumbleSink), mode);
           float land = max(0.05, (y0 - uFloor) / meanSink);
           float te = min(tau, land);

           /* ---- FLUTTER: stall, sideslip, glide ---- */
           float omega = max(0.15, uFlutterRate * (1.0 - 0.5 * uFlutterVary + uFlutterVary * r6));
           float phi0 = PI2 * r7;
           float phi = omega * te + phi0;
           float slipF = (uSwing / omega) * (sin(phi) - sin(phi0));
           float dropF = uSink * (1.0 - 0.5 * uLift) * te
                       - uSink * uLift * (sin(2.0 * phi) - sin(2.0 * phi0)) / (4.0 * omega);
           // The plate's attitude tracks its horizontal velocity, so it flips
           // sign at every stall. That flip is the whole silhouette of a
           // falling leaf and it costs one cosine.
           float angleF = uPitch * cos(phi);

           /* ---- TUMBLE: end over end, and it drifts ---- */
           float spinDir = r6 < 0.5 ? -1.0 : 1.0;
           float rate = uTumbleRate * (0.7 + 0.6 * r7) * spinDir;
           float slipT = uTumbleDrift * spinDir * te;
           float dropT = uTumbleSink * te + uTumbleBob * (sin(rate * te + phi0) - sin(phi0));
           float angleT = rate * te;

           float slip = mix(slipF, slipT, mode);
           float drop = mix(dropF, dropT, mode);
           float angle = mix(angleF, angleT, mode);

           /* ---- the catch: one gust, at its own moment, for each feather ---- */
           // A Gaussian bump subtracted from the drop, so the feather rises,
           // hangs, and resumes. Doing it as a bump on *position* rather than
           // on velocity is what keeps the landing time honest — the integral
           // of the bump over the whole descent is finite and small.
           float when = uCatchWindow * r8;
           float gust = exp(-pow((te - when) / max(0.05, uCatchWidth), 2.0));
           drop -= uCatchGain * gust * (0.35 + 0.65 * r5);

           /* ---- settle: the last second before it is down ---- */
           float rest = smoothstep(land - max(0.02, uSettleTime), land, tau);
           // Snap toward the nearest face-up-or-face-down attitude rather than
           // toward zero: a tumbler that unwinds three revolutions on the way
           // to the floor reads as rewinding, which is the one thing a feather
           // never does.
           float lying = floor(angle / PI + 0.5) * PI;
           angle = mix(angle, lying, rest);

           /* ---- assemble ---- */
           vec3 heading = vec3(cos(bearing), 0.0, sin(bearing));
           vec3 pos = base
                    + heading * slip
                    + vec3(uWind.x, 0.0, uWind.y) * te
                    + vec3(0.0, max(uFloor, y0 - drop), 0.0);

           // The feather's own frame: long axis, face normal, and the vane
           // across. Rotating the pair about the horizontal perpendicular by
           // angle is exactly "pitch"; at angle 0 the feather lies flat.
           float ca = cos(angle);
           float sa = sin(angle);
           vec3 axis = heading * ca + vec3(0.0, sa, 0.0);
           vec3 face = heading * -sa + vec3(0.0, ca, 0.0);
           vec3 vane = normalize(cross(face, axis));

           // A slow roll about the rachis, frozen with everything else once it
           // is down. Small: a feather that spins like a propeller is a seed.
           float roll = uSpin * te * (r8 * 2.0 - 1.0) * (1.0 - rest);
           float cr = cos(roll);
           float sr = sin(roll);
           vec3 faceR = face * cr + vane * sr;
           vec3 vaneR = vane * cr - face * sr;

           /* ---- the outline, from uv and nothing else ---- */
           float along = uv.y;
           float across = uv.x * 2.0 - 1.0;

           float bare = smoothstep(uQuill, uQuill + 0.09, along);
           float prof = pow(max(sin(PI * pow(clamp(along, 0.0, 1.0), uWidthBias)), 0.0), uTaper);
           // The barb ripple runs *diagonally*: the phase is swept by across
           // as well as along, because barbs leave the rachis swept back. A
           // ripple in along alone gives a scalloped edge on both vanes at
           // the same height, which reads as a serrated leaf.
           float ripple = 1.0 + uBarb * sin(along * uBarbFreq * PI2 + across * 2.7);
           float halfW = uVaneWidth * prof * bare * ripple;
           float wide = across < 0.0 ? uLeadFrac : 1.0;

           float lx = across * halfW * wide;
           float ly = along - uPivot;
           // The cup curls the outer edge of each vane toward the underside;
           // the arch bows the whole feather along its length. Two marks, and
           // the cup is the one that makes it catch air.
           float lz = -uCup * halfW * across * across + uArch * (along - uPivot) * (along - uPivot);

           float span = uSize * (1.0 + uSizeVary * (r3 - 0.5));

           // Authored in world space. The mesh and its group are both held at
           // identity by the ability, so object space *is* world space here —
           // the same contract the bolt ribbon works under, and the reason
           // uOrigin can be a world point rather than a local one.
           transformed = pos + (vaneR * lx + axis * ly + faceR * lz) * span;

           /* ---- what the fragment stage needs ---- */
           vAlong = along;
           vAcross = across;
           vDice = r5;
           vRest = rest;
           vAlpha = uFade * smoothstep(0.0, max(0.02, uBirthFade), tau);
           vFeatherWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
         }`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform vec3  uLightDir;
         uniform vec3  uColorQuill;
         uniform vec3  uColorVane;
         uniform vec3  uColorTip;
         uniform vec3  uColorGlow;
         uniform float uRachis;
         uniform float uBarbLines;
         uniform float uBarbCount;
         uniform float uGrain;
         uniform float uGrainScale;
         uniform float uFresnel;
         uniform float uFresnelPower;
         uniform float uTranslucency;
         uniform float uTranslucencyPower;
         uniform float uGlow;
         uniform float uOpacity;
         varying float vAlong;
         varying float vAcross;
         varying float vDice;
         varying float vRest;
         varying float vAlpha;
         varying vec3  vFeatherWorld;
         ${noiseGLSL}`
      )
      // Injected once the normal is resolved: with flatShading there is no
      // vNormal varying, so every view-dependent term below has to read the
      // face normal <normal_fragment_begin> derives from derivatives.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           vec3  N = normalize(normal);
           vec3  V = normalize(vViewPosition);
           float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), uFresnelPower);
           float side = abs(vAcross);

           vec3 body = mix(uColorQuill, uColorVane, smoothstep(0.05, 0.45, vAlong));
           body = mix(body, uColorTip, smoothstep(0.5, 1.0, vAlong));

           // The rachis, and the barbs leaving it. The barb phase is swept by
           // vAlong for the same reason the outline ripple is: barbs are not
           // perpendicular to the shaft, they rake back toward the tip, and a
           // comb of parallel lines is the tell that it was drawn rather than
           // grown.
           float shaft = pow(1.0 - side, 9.0);
           float comb = cos(side * uBarbCount * PI - vAlong * 5.5);
           float barbs = smoothstep(0.55, 1.0, abs(comb)) * (1.0 - side * 0.6);
           body *= 1.0 - uBarbLines * barbs * 0.5;
           body = mix(body, uColorQuill, clamp(shaft * uRachis, 0.0, 1.0));

           // Grain in world space, so a flock does not read as one feather
           // stamped two hundred times.
           body *= 1.0 + uGrain * (fbm3(vFeatherWorld * uGrainScale + vDice * 17.0) - 0.5);

           diffuseColor.rgb *= body;

           // A feather is one cell thick at the edge and the read of a flock
           // against a low sun is almost entirely the light coming through it.
           float through = pow(clamp(dot(V, -uLightDir), 0.0, 1.0), uTranslucencyPower);
           vec3 glow = uColorGlow * through * uTranslucency * (0.3 + 0.7 * vAlong);
           glow += uColorTip * rim * uFresnel;
           glow *= uGlow;
           // Soft ceiling: both terms above peak at a grazing angle and they
           // stack, and a flock on the silhouette otherwise sums past white and
           // smears the bloom pass across the whole zone.
           glow /= 1.0 + glow * 0.35;
           totalEmissiveRadiance += glow;

           // The outer barbs separate rather than ending in a clean curve, and
           // the ones that have landed press flat and lose a little of it.
           float split = smoothstep(0.72, 1.0, side) * (0.35 + 0.65 * abs(comb));
           float alpha = vAlpha * uOpacity * (1.0 - split * 0.55 * (1.0 - vRest * 0.5));
           diffuseColor.a = clamp(diffuseColor.a * alpha, 0.0, 1.0);
         }`
      );
  });

  material.userData.uniforms = uniforms;

  /**
   * Pull the whole flutter model, the outline and the palette from live
   * settings. Called every frame, zero-length frames included — see **I1**.
   *
   * @param {THREE.Vector3} origin the zone centre, world space
   * @param {number} age    seconds since the flock was released
   * @param {number} fade   1 while the feathers are lit, ramping to 0 at the end
   */
  material.userData.sync = (origin, age, fade) => {
    const c = settings.featherfall;
    const g = settings.global;

    uniforms.uAge.value = age;
    uniforms.uFade.value = fade;
    uniforms.uOrigin.value.copy(origin);

    uniforms.uRadius.value = c.zoneRadius;
    uniforms.uCeiling.value = c.ceiling;
    uniforms.uCeilingVary.value = c.ceilingVary;
    uniforms.uStagger.value = c.stagger;
    uniforms.uFloor.value = c.floorHeight;
    uniforms.uWind.value.set(c.windX, c.windZ);

    uniforms.uSize.value = c.featherSize;
    uniforms.uSizeVary.value = c.featherSizeVary;
    uniforms.uVaneWidth.value = c.vaneWidth;
    uniforms.uWidthBias.value = c.widthBias;
    uniforms.uTaper.value = c.taper;
    uniforms.uLeadFrac.value = c.leadFrac;
    uniforms.uQuill.value = c.quill;
    uniforms.uCup.value = c.cup;
    uniforms.uArch.value = c.arch;
    uniforms.uBarb.value = c.barb;
    uniforms.uBarbFreq.value = c.barbFreq;
    uniforms.uPivot.value = c.pivot;

    // `global.speed` is the sandbox's master rate control and the descent is
    // the only thing in this ability that has a rate, so it lands here rather
    // than on the phase clock: scaling the clock would also scale the stagger
    // and the release window, which are event times, not speeds.
    uniforms.uSink.value = c.sink * g.speed;
    uniforms.uLift.value = c.lift;
    uniforms.uSwing.value = c.swing * g.speed;
    uniforms.uFlutterRate.value = c.flutterRate;
    uniforms.uFlutterVary.value = c.flutterVary;
    uniforms.uPitch.value = c.pitch;
    uniforms.uSpin.value = c.spin;

    uniforms.uTumbleShare.value = c.tumbleShare;
    uniforms.uTumbleRate.value = c.tumbleRate;
    uniforms.uTumbleDrift.value = c.tumbleDrift * g.speed;
    uniforms.uTumbleSink.value = c.tumbleSink * g.speed;
    uniforms.uTumbleBob.value = c.tumbleBob;

    uniforms.uCatchGain.value = c.catchGain;
    uniforms.uCatchWidth.value = c.catchWidth;
    uniforms.uCatchWindow.value = c.catchWindow;

    uniforms.uBirthFade.value = c.birthFade;
    uniforms.uSettleTime.value = c.settleTime;

    uniforms.uColorQuill.value.copy(getColor(c.colorQuill));
    uniforms.uColorVane.value.copy(getColor(c.colorVane));
    uniforms.uColorTip.value.copy(getColor(c.colorTip));
    uniforms.uColorGlow.value.copy(getColor(c.colorGlow));
    uniforms.uRachis.value = c.rachis;
    uniforms.uBarbLines.value = c.barbLines;
    uniforms.uBarbCount.value = c.barbCount;
    uniforms.uGrain.value = c.grain;
    uniforms.uGrainScale.value = c.grainScale * g.noiseFrequency;
    uniforms.uFresnel.value = c.fresnel;
    uniforms.uFresnelPower.value = c.fresnelPower;
    uniforms.uTranslucency.value = c.translucency;
    uniforms.uTranslucencyPower.value = c.translucencyPower;
    uniforms.uGlow.value = c.glow * g.glow;
    uniforms.uOpacity.value = c.opacity * g.opacity;
  };

  return material;
}
