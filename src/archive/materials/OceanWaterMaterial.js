import { ShaderMaterial, NormalBlending, Color, Vector3, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms, frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

const _sunDir = new Vector3();

/**
 * Waterbending, raymarched as a real body of water.
 *
 * Like the fire volume, the mesh is only a camera-facing proxy hull around the
 * flight path (RibbonGeometry's `frame` option): each fragment rebuilds the
 * path's local frame from `aCenter` / `aTangent` and marches a ray from the
 * camera. Fire integrates *through* its medium because a flame is emissive gas;
 * water is not — it has a surface, and everything that makes water read as water
 * happens on it. So the march looks for the first sign change of
 *
 *   field(p) = radius(u) * (1 + swell + chop) - distanceToAxis(p)
 *
 * refines the crossing with four bisections, and shades that point:
 *
 *   normal        gradient of the same field (tetrahedron taps), so every ripple
 *                 in the density field is a real ripple in the lighting
 *   reflection    Schlick fresnel over the scene's HDR probe, plus a tight sun
 *                 glint — the two highlights that read as "wet" at any distance
 *   depth tint    Beer-Lambert over the *analytic* chord through the tube, so
 *                 the thin edges stay turquoise and the belly goes deep blue
 *   translucency  backlit glow through the thin parts of a crest, the thing that
 *                 makes an ocean wave look lit from inside
 *   foam          crest foam where the swell peaks upward, churn foam eroded by
 *                 a ridged octave, spray foam at the silhouette, all broken into
 *                 cells by a voronoi so it reads as bubbles rather than as paint
 *
 * The march is clipped by the opaque depth prepass, so the water is occluded by
 * the ground and the character and softens where it touches them. Refraction
 * itself is the separate distortion buffer's job.
 */
export class OceanWaterMaterial extends ShaderMaterial {
  constructor() {
    super({
      transparent: true,
      depthWrite: false,
      // Per-sample scene-depth clipping inside the march handles occlusion; the
      // flat proxy hull's own depth would slice the body open.
      depthTest: false,
      blending: NormalBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uEnvMap: frame.uEnvMap,
        /* shape */
        uRadius: { value: 0.62 },
        uHeadSize: { value: 2.0 },
        uCrest: { value: 1.45 },
        uStreamLength: { value: 8.0 },
        uArcLength: { value: 9.0 },
        uTailPad: { value: 0.3 },
        uTailFade: { value: 0.22 },
        /* waves */
        uWaveAmplitude: { value: 0.3 },
        uWaveFrequency: { value: 1.5 },
        uChop: { value: 0.85 },
        uFlow: { value: 1.6 },
        uNoiseFrequency: { value: 1.9 },
        uSwirl: { value: 0.8 },
        /* surface */
        uColorDeep: { value: new Color(0.015, 0.09, 0.2) },
        uColorShallow: { value: new Color(0.09, 0.62, 0.72) },
        uColorFoam: { value: new Color(0.92, 0.98, 1.0) },
        uDepthDensity: { value: 0.75 },
        uTransparency: { value: 0.72 },
        uFresnel: { value: 1.5 },
        uEnvIntensity: { value: 0.85 },
        uSpecular: { value: 1.4 },
        uTranslucency: { value: 1.2 },
        uFoam: { value: 1.0 },
        uFoamSharpness: { value: 1.6 },
        uSunDir: { value: new Vector3(-0.8, -0.55, -0.2).normalize() },
        uSunColor: { value: new Color(1, 0.95, 0.86) },
        /* detail & break-up */
        uDetail: { value: 1.0 },
        uStreamStretch: { value: 3.2 },
        uCrestSharpness: { value: 0.35 },
        uShred: { value: 0.8 },
        uShredDepth: { value: 0.5 },
        uSkyColor: { value: new Color(0.28, 0.42, 0.62) },
        uSkyIntensity: { value: 0.5 },
        /* rendering */
        uGlow: { value: 1.0 },
        uOpacity: { value: 1 },
        uSteps: { value: 24 },
        uSeed: { value: Math.random() * 20 }
      }),
      vertexShader: /* glsl */ `
        uniform float uArcLength;
        uniform float uTailPad;
        uniform float uStreamLength;
        uniform float uRadius;
        uniform float uHeadSize;

        attribute float aDist;
        attribute float aRandom;
        attribute vec3  aCenter;
        attribute vec3  aTangent;

        varying vec3  vCenter;
        varying vec3  vTangent;
        varying float vS;
        varying float vRadius;
        varying vec3  vWorld;
        varying float vRandom;

        void main() {
          vCenter = aCenter;
          vTangent = normalize(aTangent);
          // Metres from the tail of the *body* — the hull is padded at both ends
          // so its end caps are covered.
          vS = aDist * uArcLength - uTailPad;
          vRandom = aRandom;

          // Local tube radius, so the fragment sizes its march window to the
          // water actually in front of it instead of to the fattest part of the
          // body: the thin tail gets fine steps rather than mostly empty ones.
          float u = clamp(vS / max(uStreamLength, 0.01), 0.0, 1.0);
          vRadius = uRadius * (0.5 + 0.5 * pow(u, 0.6))
                  * (1.0 + (uHeadSize - 1.0) * smoothstep(0.62, 1.0, u));

          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform sampler2D uEnvMap;
        uniform float uRadius;
        uniform float uHeadSize;
        uniform float uCrest;
        uniform float uStreamLength;
        uniform float uTailFade;
        uniform float uWaveAmplitude;
        uniform float uWaveFrequency;
        uniform float uChop;
        uniform float uFlow;
        uniform float uNoiseFrequency;
        uniform float uSwirl;
        uniform vec3  uColorDeep;
        uniform vec3  uColorShallow;
        uniform vec3  uColorFoam;
        uniform float uDepthDensity;
        uniform float uTransparency;
        uniform float uFresnel;
        uniform float uEnvIntensity;
        uniform float uSpecular;
        uniform float uTranslucency;
        uniform float uFoam;
        uniform float uFoamSharpness;
        uniform vec3  uSunDir;
        uniform vec3  uSunColor;
        uniform float uDetail;
        uniform float uStreamStretch;
        uniform float uCrestSharpness;
        uniform float uShred;
        uniform float uShredDepth;
        uniform vec3  uSkyColor;
        uniform float uSkyIntensity;
        uniform float uGlow;
        uniform float uOpacity;
        uniform float uSteps;
        uniform float uSeed;
        uniform float uShaderIntensity;
        uniform float uGlobalGlow;
        uniform vec2  uResolution;
        uniform sampler2D uSceneDepth;
        uniform float uCameraNear;
        uniform float uCameraFar;

        varying vec3  vCenter;
        varying vec3  vTangent;
        varying float vS;
        varying float vRadius;
        varying vec3  vWorld;
        varying float vRandom;

        ${noiseGLSL}
        ${commonGLSL}

        /* The field is evaluated ~40 times per pixel (march + bisection +
           gradient), so it needs a cheap basis: trilinear value noise on a
           hashed lattice, about a third of the cost of the simplex noise the
           surface shaders use. */
        float vnoise(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);

          float a = hash13(i);
          float b = hash13(i + vec3(1.0, 0.0, 0.0));
          float c = hash13(i + vec3(0.0, 1.0, 0.0));
          float d = hash13(i + vec3(1.0, 1.0, 0.0));
          float e = hash13(i + vec3(0.0, 0.0, 1.0));
          float g = hash13(i + vec3(1.0, 0.0, 1.0));
          float h = hash13(i + vec3(0.0, 1.0, 1.0));
          float k = hash13(i + vec3(1.0, 1.0, 1.0));

          return mix(
            mix(mix(a, b, f.x), mix(c, d, f.x), f.y),
            mix(mix(e, g, f.x), mix(h, k, f.x), f.y),
            f.z
          );
        }

        /**
         * Rotation applied between octaves.
         *
         * Value noise is built on an axis-aligned lattice, and stacking octaves
         * that all share that alignment lines their features up into the grid:
         * the surface comes out covered in closed, roughly circular contour
         * rings that read as a topographic map. Turning the domain between
         * octaves costs nine multiplies and scatters the lattice directions so
         * the rings never form.
         */
        const mat3 OCTAVE_ROT = mat3(
           0.00,  0.80,  0.60,
          -0.80,  0.36, -0.48,
          -0.60, -0.48,  0.64
        );

        /** 4 octaves of chop, normalised to 0..1. */
        float waterFbm(vec3 p) {
          float v = 0.0;
          float a = 0.5;
          float norm = 0.0;
          for (int i = 0; i < 4; i++) {
            v += a * vnoise(p);
            norm += a;
            p = OCTAVE_ROT * p * 2.11 + vec3(7.7, 13.1, 3.9);
            a *= 0.5;
          }
          return v / norm;
        }

        /**
         * Ridged fbm: |noise| folded and inverted, so the maxima are creases
         * rather than domes.
         *
         * Plain fbm can only make a surface that swells and dips smoothly, which
         * is why the body reads as poured paint however much of it you add. Real
         * moving water is full of *edges* — the sharp lines where two sheets fold
         * into each other — and a folded basis is the cheapest way to get them.
         */
        float waterRidge(vec3 p) {
          float v = 0.0;
          float a = 0.5;
          float norm = 0.0;
          for (int i = 0; i < 3; i++) {
            float n = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
            v += a * n * n;
            norm += a;
            p = OCTAVE_ROT * p * 2.17 + vec3(3.1, 9.7, 17.3);
            a *= 0.5;
          }
          return v / norm;
        }

        // equirectUv used to be defined here. It now lives in commonGLSL, which
        // this shader already injects above, and declaring it twice is a compile
        // error — so if you revive this material, it works as-is.

        /**
         * Floor under the reflected environment.
         *
         * Water is legible almost entirely through what it reflects, so on a
         * night stage — where most of the probe is genuinely black — a straight
         * env lookup returns nothing and the surface collapses into flat holes
         * of body colour. A cheap sky gradient underneath the probe keeps every
         * facet reflecting *something*, which is what restores the shape.
         */
        vec3 skyFloor(vec3 dir) {
          float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
          return mix(uSkyColor * 0.25, uSkyColor, pow(h, 0.65)) * uSkyIntensity;
        }

        /** Radius of the water tube at normalised body position u. */
        float tubeRadius(float u) {
          float r = uRadius * (0.5 + 0.5 * pow(u, 0.6));
          r *= 1.0 + (uHeadSize - 1.0) * smoothstep(0.62, 1.0, u);
          // The tail thins to a point instead of ending in a flat cap.
          return r * smoothstep(0.0, max(uTailFade, 0.01), u);
        }

        /**
         * Noise coordinate for a point on the tube's surface, from the angle
         * around the axis and the distance along it.
         *
         * Sampling the noise at the *world* offset instead (the obvious thing)
         * traces a small circle through the lattice as you go round the tube, so
         * the detail barely changes across the surface and what you get is
         * marbling: broad smooth swirls with visible iso-contours. Mapping the
         * angle onto a full circle of radius "scale" gives isotropic detail all
         * the way round, and keeps it seamless at ±pi where a flat (angle, s)
         * parameterisation would show a hard line.
         *
         * The lattice is stretched along the axis by uStreamStretch, and this
         * is the single thing that decides whether the surface reads as water or
         * as porridge. Isotropic noise gives isotropic features — closed blobs
         * and concentric contour rings, evenly in all directions, which is what
         * a brain or a lava lamp looks like. Water that is *moving* has its
         * detail drawn out along the direction of travel: long filaments,
         * streaks and creases that all run the same way. Dividing the axial
         * coordinate is what turns one into the other.
         */
        vec3 tubeCoord(float ang, float s, float scale) {
          return vec3(cos(ang), sin(ang), s / max(uStreamStretch, 0.05)) * scale;
        }

        /**
         * Signed field of the water body: positive inside, zero on the surface.
         * "info" reports where the sample sits — (u, angle around the axis,
         * metres along it) — and "wave" the displacement that shaped it.
         *
         * The waves displace the surface radially and do not vary with depth, so
         * the field stays monotonic along any outward ray: one clean crossing,
         * which is what keeps the body a body instead of a cloud of islands.
         */
        float waterField(vec3 p, out vec3 info, out float wave) {
          vec3 rel = p - vCenter;
          float ax = dot(rel, vTangent);
          vec3 perp = rel - vTangent * ax;

          float s = vS + ax;                                 // metres from the tail
          float u = clamp(s / max(uStreamLength, 0.01), 0.0, 1.0);

          float radius = tubeRadius(u);

          // Squash the upper half only: the cross-section is a swell riding high
          // over a rounded belly, not a symmetric pipe.
          float shapedY = perp.y > 0.0 ? perp.y / max(uCrest, 0.05) : perp.y;
          float rad = length(vec3(perp.x, shapedY, perp.z));

          // Fold the axial overshoot past either end into the radius: a capsule,
          // so the body ends in round caps rather than being sliced flat.
          float over = s - clamp(s, 0.0, uStreamLength);
          rad = sqrt(rad * rad + over * over);

          // Angle in a frame attached to the axis, rolling slowly, so the water
          // carries its own surface instead of swimming through the world.
          vec3 nAxis = normalize(cross(vTangent, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
          vec3 bAxis = cross(nAxis, vTangent);
          float ang = atan(dot(perp, bAxis), dot(perp, nAxis))
                    + s * uSwirl * 0.3 + uTime * uFlow * 0.25 + uSeed;
          info = vec3(u, ang, s);

          // Two swells travelling backwards down the body, wrapped around it by
          // integer harmonics of the angle so they stay continuous at ±pi.
          float phase = s * uWaveFrequency - uTime * uFlow * 2.0;
          float swell = sin(phase + ang * 2.0) * 0.6 + sin(phase * 1.9 - ang * 3.0 + 1.7) * 0.28;

          // Chop, in two bands only.
          //
          // Everything finer than this lives in the detail normal at the hit
          // point instead, and that split is not a shortcut — it is what makes
          // the march survivable. The claim above (radial displacement, one
          // clean crossing) holds for a ray travelling straight out from the
          // axis, but a camera ray sweeps through s and the angle as it goes, so
          // the displacement varies *along* it. Once the displacement has
          // features finer than a march step, the field crosses zero several
          // times between samples, the bisection latches onto whichever crossing
          // it happens to straddle, and the body fills with dropped-out speckle.
          // Fine displacement and a robust surface are simply not compatible at
          // 32 steps; fine *shading* is free.
          float chop = waterFbm(tubeCoord(ang, s - uTime * uFlow * 0.8, uNoiseFrequency)) * 2.0 - 1.0;
          float ripple = waterFbm(tubeCoord(ang, s - uTime * uFlow * 1.5, uNoiseFrequency * 2.4)) * 2.0 - 1.0;

          // Folded crests: the sharp lines where sheets of water meet. Biased to
          // zero mean so it creases the surface rather than inflating it.
          float ridge = waterRidge(tubeCoord(ang, s - uTime * uFlow * 1.1, uNoiseFrequency * 1.9)) - 0.45;

          wave = swell * 0.6
               + (chop * 0.7 + ripple * 0.26) * uChop
               + ridge * uCrestSharpness;

          // Floor the displaced radius well above zero. Summing this many
          // octaves easily drives (1 + wave) negative, and where it goes
          // negative the tube pinches shut and re-opens: the surface closes into
          // rings and tunnels and the body reads as coral rather than water. The
          // clamp costs a little crest depth and buys back the silhouette.
          float scale = max(0.34, 1.0 + wave * uWaveAmplitude);
          return radius * scale - rad;
        }

        void main() {
          vec3 ro = cameraPosition;
          vec3 rd = normalize(vWorld - ro);

          // The hull is a camera-facing strip through the axis, so the body sits
          // in a slab around the ray's closest approach to it. Looking down the
          // barrel of the stream needs a deeper slab.
          float maxRadius = max(vRadius * max(uCrest, 1.0) * (1.0 + uWaveAmplitude), uRadius * 0.25);
          float axial = abs(dot(rd, vTangent));
          float halfWindow = maxRadius * (1.3 + 2.5 * axial * axial);
          float tc = dot(vCenter - ro, rd);
          float t0 = max(tc - halfWindow, 0.02);
          float t1 = tc + halfWindow;

          // Clip on the opaque scene: correct occlusion by the ground and the
          // character, for free.
          float dzdt = (viewMatrix * vec4(rd, 0.0)).z;
          float packed = unpackRGBAToDepth(texture2D(uSceneDepth, gl_FragCoord.xy / uResolution));
          float sceneViewZ = perspectiveDepthToViewZ(packed, uCameraNear, uCameraFar);
          float tScene = dzdt < -1e-5 ? sceneViewZ / dzdt : 1e6;
          t1 = min(t1, tScene);
          if (t1 <= t0) discard;

          float steps = clamp(uSteps, 8.0, 64.0);
          float stepSize = (t1 - t0) / steps;
          // Dither the entry point: a fixed start turns the crossings into
          // visible contour bands, a per-pixel offset turns them into grain.
          float t = t0 + stepSize * hash13(vec3(gl_FragCoord.xy, fract(uTime) * 64.0));

          vec3 info;
          float wave;
          float previous = t;
          float field = waterField(ro + rd * t, info, wave);
          bool hit = field > 0.0;                            // camera inside the water

          for (int i = 0; i < 64; i++) {
            if (hit || float(i) >= steps) break;
            previous = t;
            t += stepSize;
            field = waterField(ro + rd * t, info, wave);
            if (field > 0.0) {
              // Bisect the crossing: four halvings put the surface well inside a
              // pixel, which is what keeps the silhouette from crawling.
              float a = previous;
              float b = t;
              for (int k = 0; k < 4; k++) {
                float m = 0.5 * (a + b);
                if (waterField(ro + rd * m, info, wave) > 0.0) b = m; else a = m;
              }
              t = b;
              hit = true;
            }
          }
          if (!hit) discard;

          vec3 P = ro + rd * t;
          field = waterField(P, info, wave);
          float u = info.x;
          float ang = info.y;
          float s = info.z;

          /* ---- normal: gradient of the same field ------------------------ */
          float radius = tubeRadius(u);
          // Tight enough to resolve the finest displacement octave — a coarser
          // epsilon averages that detail straight back out of the normal and the
          // extra octaves buy nothing.
          float eps = max(0.006, radius * 0.02);
          vec3 dInfo;
          float dw;
          vec2 k = vec2(1.0, -1.0) * 0.5 * eps;
          vec3 grad =
            k.xyy * waterField(P + k.xyy, dInfo, dw) +
            k.yyx * waterField(P + k.yyx, dInfo, dw) +
            k.yxy * waterField(P + k.yxy, dInfo, dw) +
            k.xxx * waterField(P + k.xxx, dInfo, dw);
          // The field grows inward, so the outward normal is the negated gradient.
          vec3 N = -normalize(grad + 1e-6);

          /* ---- detail normal --------------------------------------------- */
          // The ripples the march is not allowed to carry, added to the normal
          // at the hit point where they cost three noise taps instead of forty
          // and cannot punch holes in anything. This is what turns a smooth
          // isosurface into something that scatters the sun into hundreds of
          // small moving highlights — the texture the eye actually reads as
          // "water" long before it reads the silhouette.
          if (uDetail > 0.001) {
            float df = uNoiseFrequency * 4.5;
            float dts = uTime * uFlow * 2.2;
            const float de = 0.05;
            float n0 = waterFbm(tubeCoord(ang, s - dts, df));
            float na = waterFbm(tubeCoord(ang + de, s - dts, df));
            float nb = waterFbm(tubeCoord(ang, s + de - dts, df));
            // Surface frame: T runs around the tube, B along it.
            vec3 T = normalize(cross(N, vTangent) + vec3(1e-5));
            vec3 B = cross(N, T);
            N = normalize(N - (T * (na - n0) + B * (nb - n0)) * uDetail * 14.0);
          }

          vec3 V = -rd;

          /* ---- how much water the ray has to cross ----------------------- */
          // Analytic chord through the tube: cheaper and far steadier than
          // marching on to find the exit, and the error is invisible under foam.
          //
          // Deliberately taken against the *undisplaced* radius. Feeding the
          // wave in at full strength makes the thickness — and therefore the
          // depth tint — a noise field, and the body comes out mottled like
          // marbled paper instead of shaded like something solid. Thickness has
          // to vary with position across the cross-section (thin at the
          // silhouette, deep through the middle); that gradient is the entire
          // volume cue. The wave is left in at a fraction so crests still read
          // as slightly deeper.
          float R = radius * (1.0 + wave * uWaveAmplitude * 0.25);
          vec3 across = cross(rd, vTangent);
          float sinA = length(across);
          float offAxis = sinA > 1e-4
            ? abs(dot(vCenter - ro, across / sinA))
            : length(cross(vCenter - ro, vTangent));
          float chord = 2.0 * sqrt(max(R * R - offAxis * offAxis, 0.0)) / max(sinA, 0.2);

          /* ---- surface shading ------------------------------------------- */
          float ndv = max(dot(N, V), 0.0);
          float fres = clamp((0.02 + 0.98 * pow(1.0 - ndv, 5.0)) * uFresnel, 0.0, 1.0);

          vec3 refl = reflect(-V, N);
          vec3 env = texture2D(uEnvMap, equirectUv(refl)).rgb * uEnvIntensity;
          env = max(env, skyFloor(refl));

          // Two lobes: a tight one for the mirror glint and a broad one for the
          // sheen off the rougher chop. The tight lobe is clamped because the
          // body is not tone mapped and feeds the bloom pass — left unbounded it
          // is what turns every crest into a white hole.
          float sunDot = max(dot(refl, -uSunDir), 0.0);
          float glint = min(pow(sunDot, 220.0) * uSpecular, 3.0)
                      + pow(sunDot, 18.0) * uSpecular * 0.12;

          // Beer-Lambert through the chord: turquoise at the thin edges, deep
          // blue through the belly.
          float depth = 1.0 - exp(-chord * uDepthDensity);
          // Wrapped diffuse plus a sky term on the upward faces. Without it the
          // body is a flat two-colour gradient and reads as poured plastic: this
          // is what gives every swell a lit side and a shaded side.
          float ndl = dot(N, -uSunDir);
          float lit = 0.45 + 0.55 * clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
          vec3 body = mix(uColorShallow, uColorDeep, depth) * lit;
          body += uColorShallow * 0.2 * pow(clamp(N.y, 0.0, 1.0), 2.0);

          // Backlit translucency: light coming through the thin part of a crest.
          float through = pow(clamp(dot(V, -normalize(uSunDir + N * 0.5)), 0.0, 1.0), 3.0);
          vec3 sss = uColorShallow * uSunColor * through * exp(-chord * 0.6) * uTranslucency;

          /* ---- foam ------------------------------------------------------- */
          // Foam has to be a *speckle that breaks out* where the water is
          // breaking — a fine noise whose threshold the crest pushes down.
          //
          // Shading it as any smooth function of the wave instead (the obvious
          // "white where the swell is high") paints the iso-contours of that
          // field straight onto the surface, and the body comes out looking like
          // a topographic map. Only the *density* of the speckle may vary
          // smoothly; the speckle itself has to be high frequency.
          float speckle = waterFbm(tubeCoord(ang, s - uTime * uFlow * 1.6, uNoiseFrequency * 4.5)) * 0.72
                        + waterFbm(tubeCoord(ang, s - uTime * uFlow * 2.4, uNoiseFrequency * 11.0)) * 0.28;

          float crest = smoothstep(0.1, 0.8, wave) * smoothstep(-0.25, 0.55, N.y);
          float lip = smoothstep(0.55, 1.0, u);              // the leading edge churns
          float bias = clamp((crest * 0.9 + lip * 0.4) * uFoam, 0.0, 1.4);

          float threshold = mix(0.96, 0.4, clamp(bias, 0.0, 1.0));
          float foam = smoothstep(threshold, threshold + 0.16, speckle);
          foam = pow(foam, max(uFoamSharpness, 0.2)) * clamp(bias * 1.5, 0.0, 1.0);
          foam = clamp(foam, 0.0, 0.94);

          /* ---- break-up ---------------------------------------------------- */
          // A body of water in the air is not a closed surface: where it gets
          // thin it loses to surface tension and tears into strands, sheets with
          // holes, and beads. That break-up is most of what separates a
          // photograph of thrown water from a rendered blob.
          //
          // It is done on *alpha*, not on the field. Cutting holes in the field
          // would put sign changes inside the body, the march would start hitting
          // interior walls, and the result is the black speckle the flat version
          // of this shader had. Alpha erosion costs nothing and cannot break the
          // march.
          float thin = 1.0 - smoothstep(0.0, max(uShredDepth, 0.02), chord);
          float shred = waterFbm(tubeCoord(ang, s - uTime * uFlow * 1.9, uNoiseFrequency * 8.0));
          float torn = thin * uShred * smoothstep(0.34, 0.62, 1.0 - shred);

          /* ---- composite --------------------------------------------------- */
          vec3 color = mix(body, env + uSunColor * glint, fres);
          color += sss;
          color = mix(color, uColorFoam * mix(0.55, 1.0, lit), foam);
          color *= uGlow * uGlobalGlow * mix(0.7, 1.0, uShaderIntensity);

          float alpha = clamp(depth * uTransparency + fres * 0.45 + foam * 0.9, 0.0, 1.0) * uOpacity;
          alpha *= clamp(1.0 - torn, 0.0, 1.0);
          // Soften the waterline where the body meets the floor or the caster.
          //
          // Scaled off the *local* tube radius and capped, not off the march's
          // slab half-width. The slab is deliberately much larger than the body
          // (it has to contain the crest stretch and the waves, and it grows
          // again when you look down the barrel), so using it here fades the
          // water out up to a metre and a half from anything opaque — and a
          // stream flying a metre over the floor is within that of the floor
          // along its whole length. The result is big soft holes punched through
          // the body wherever the ground happens to be behind it.
          float contactFade = clamp(min(radius * 0.5, 0.3), 0.02, 0.3);
          alpha *= clamp((tScene - t) / contactFade, 0.0, 1.0);
          if (alpha < 0.004) discard;

          gl_FragColor = vec4(color, alpha);
        }
      `
    });
  }

  /** Pull live editor values (called once per frame by the ability). */
  sync() {
    const c = settings.water;
    const g = settings.global;
    const e = settings.environment;
    const u = this.uniforms;

    u.uRadius.value = c.radius;
    u.uHeadSize.value = c.headSize;
    u.uCrest.value = c.crest;

    u.uWaveAmplitude.value = c.waveAmplitude * g.noiseStrength;
    u.uWaveFrequency.value = c.waveFrequency * g.noiseFrequency;
    u.uChop.value = c.chop * g.turbulence;
    u.uFlow.value = c.flowSpeed * g.noiseSpeed;
    u.uNoiseFrequency.value = c.noiseFrequency * g.noiseFrequency;
    u.uSwirl.value = c.swirl * g.turbulence;

    u.uColorDeep.value.copy(getColor(c.colorDeep));
    u.uColorShallow.value.copy(getColor(c.colorShallow));
    u.uColorFoam.value.copy(getColor(c.colorFoam));
    u.uDepthDensity.value = c.depthDensity;
    u.uTransparency.value = c.transparency;
    u.uFresnel.value = c.fresnel * g.fresnel;
    u.uEnvIntensity.value = c.envIntensity;
    u.uSpecular.value = c.specular;
    u.uTranslucency.value = c.translucency;
    u.uFoam.value = c.foam;
    u.uFoamSharpness.value = c.foamSharpness;

    u.uDetail.value = c.detail * g.noiseStrength;
    u.uStreamStretch.value = c.streamStretch;
    u.uCrestSharpness.value = c.crestSharpness * g.turbulence;
    u.uShred.value = c.shred;
    u.uShredDepth.value = c.shredDepth;
    // The sky floor stands in for the parts of the probe the stage leaves black,
    // so it has to be the stage's own sky, not an invented blue.
    u.uSkyColor.value.copy(getColor(e.hemiSkyColor));
    u.uSkyIntensity.value = c.skyReflection * e.hemiIntensity * 2.0;

    // The glint and the backlight have to agree with the stage's key light, or
    // the water looks lit from somewhere the rest of the scene is not.
    const cosE = Math.cos(e.sunElevation);
    _sunDir
      .set(-Math.cos(e.sunAzimuth) * cosE, -Math.sin(e.sunElevation), -Math.sin(e.sunAzimuth) * cosE)
      .normalize();
    u.uSunDir.value.copy(_sunDir);
    u.uSunColor.value.copy(getColor(e.sunColor)).multiplyScalar(Math.min(1.6, e.sunIntensity * 0.4));

    u.uGlow.value = c.glow;
    u.uOpacity.value = c.opacity * g.opacity;
    u.uSteps.value = c.volumeSteps;
  }
}
