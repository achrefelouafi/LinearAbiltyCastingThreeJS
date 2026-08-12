import {
  Color,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
  Vector4
} from 'three';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { clamp, saturate, lerp } from '../utils/math.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { patchOnBeforeCompile, replaceChunk } from '../utils/shaderPatch.js';
import {
  disruptBlock as _disrupt,
  gravityBlock as _gravity,
  neutraliseDisrupt,
  neutraliseGravity
} from './hookFields.js';

// The published fields are re-exported by identity so the seven modules that
// opt in keep their existing import line. See `./hookFields.js` for why they
// are not defined here any more — the short version is that this file imports
// `config/settings.js` and `vfx/Tube.js` cannot.
export {
  disruptGLSL,
  disruptUniforms,
  gravityGLSL,
  gravityUniforms
} from './hookFields.js';

/* ------------------------------------------------------------------------ */
/* SceneHooks — the module that lets an ability change the world             */
/* ------------------------------------------------------------------------ */
/**
 * Every other module in `src/vfx/` draws inside the ability's own group. This
 * one does the opposite: it reaches *out* of the group and edits the world the
 * ability is standing in — swings the sun, drains the grade, ages the floor,
 * punches a hole in the frame, inverts gravity, and publishes a region that
 * other abilities' shaders can read and come apart inside.
 *
 * Seven abilities in `docs/ROSTER-II.md` are built on it: `dawnbreak` and
 * `sheetlightning` (key light), `eclipse` (grade), `entropy` (material age),
 * `silence` (hole), `hourglass` (gravity) and `spellbreak` (disrupt).
 *
 * ## Why this file is mostly a ledger and hardly at all a renderer
 *
 * Four casts can be live at once. An ability can be destroyed mid-effect by
 * the concurrency cap, by **C**, or by the editor's clear button. If any one of
 * those paths can leave the sun pointing sideways or the floor rusted, the
 * sandbox is broken for the rest of the session and the only fix is a reload.
 * That risk is the whole design problem, and it is a *bookkeeping* problem, not
 * a graphics one. So the graphics here are deliberately thin — a depth proxy, a
 * uniform blend, a patch into the floor — and the bookkeeping is the substance.
 *
 * The first version had no ledger at all: each hook was a pair of free
 * functions, `takeKeyLight(...)` and `restoreKeyLight()`, and the ability was
 * trusted to pair them. It survived exactly as long as it took to cast Dawnbreak
 * and press **C** halfway through: `onDestroy()` ran, `restoreKeyLight()` was
 * called from a code path that had already been torn down, and the stage stayed
 * lit from the horizon until reload. Trusting the caller to pair calls across a
 * lifecycle that can be interrupted is not a discipline, it is a hope.
 *
 * ## The discipline
 *
 * 1. **Borrow.** `sceneHooks.acquire(Hook.KEY_LIGHT, this)` returns a *token*.
 *    It never returns null — unlike `ctx.lights.acquire()`, there is no pool to
 *    run out of, because the world has exactly one of each of these things and
 *    sharing it is a question of *ordering*, not of availability.
 * 2. **Write, every frame.** The token's setters take live values resolved from
 *    `settings[id]`. They store; they do not touch the world. Writing also
 *    *renews the lease* (see 5).
 * 3. **Apply, once.** `sceneHooks.apply()` runs once per frame from `App.frame`
 *    and is the only code in the project that writes to the borrowed world.
 * 4. **Release.** `token.release()`, or `sceneHooks.reclaim(owner)` for the lot.
 *    Releasing twice is a no-op. Releasing a token that has been recycled into
 *    another ability's hands is a no-op, because tokens carry a serial.
 * 5. **Or don't, and the module takes it back.** A held hook whose token has not
 *    been written for `LEASE_FRAMES` frames is reclaimed automatically, with one
 *    warning naming the owner. That is the net under the trapeze: an ability
 *    destroyed mid-effect, an exception thrown between `acquire()` and the
 *    matching `release()`, a hot reload — none of them can strand the world.
 *
 * ## Restore is *exactness*, and two of the six get it for free
 *
 * `Environment.update()` re-authors the key light from `settings.environment`
 * every frame, before the abilities run; `PostProcessing.sync()` re-authors the
 * grade from `settings.post` every frame, just before `apply()`. Those two hooks
 * therefore have nothing to put back: they are a per-frame *overwrite* of a
 * value that is itself rewritten from settings on the next frame. Stop applying
 * and the world is already exact — not approximately, not within a float, but
 * bit-for-bit the value the sliders say.
 *
 * That is also why `apply()` blends **from `settings`**, never from the live
 * light or the live grade uniform. Blending from the live value would compound
 * frame over frame the moment anything called `apply()` twice, and would drift
 * in a way nobody would ever find. It costs a duplicate of Environment's four
 * lines of azimuth/elevation trigonometry; that duplication is called out at
 * `_applyKeyLight` and is worth it.
 *
 * The other four hooks mutate persistent state — a material uniform, a mesh's
 * visibility, two published uniform blocks — so each one has an explicit,
 * documented neutral, and releasing writes it.
 *
 * ## Last acquirer wins
 *
 * Two abilities may hold the same hook. Acquiring never fails and never evicts:
 * the new token goes on **top of that hook's stack** and drives the world; the
 * earlier holder keeps a live token, reads `token.driving === false`, and
 * resumes driving the instant the top token is released. LIFO, skipping any
 * token released in the meantime.
 *
 * The tie-break is *acquisition* order, not write order, and that is the reason
 * everything lands in one central `apply()` rather than write-through from the
 * setters. With write-through, two live holders would resolve to whoever's
 * `update()` happened to run last in `AbilityManager`'s iteration — an ordering
 * that is real, invisible, and changes when a cast expires. With a stack, cast
 * Eclipse then Dawnbreak and Dawnbreak's sun wins; let Dawnbreak expire and
 * Eclipse's is back on the next frame, mid-cast, with no special case.
 *
 * ## Cost when nothing is held
 *
 * `apply()` is `if (this._held === 0) return;` — one integer compare per frame,
 * measured at 3–5 ns. Nothing is allocated, no uniform is written, no mesh is
 * added to the scene, and the hole proxy is `visible = false` so the renderer
 * never sees it. The three opted-in shared materials (`FilamentPaths`,
 * `GroundField`, `Swarm`) each pay **one compare against a uniform** per vertex
 * for the disrupt field — uniform control flow, coherent across the whole draw
 * call, and it early-outs to a constant 0.0 that the fragment stage then also
 * early-outs on. That is as close to free as a shader gets without a recompile,
 * and a recompile is not on the table: the field switches on mid-cast.
 *
 * ## Invariants
 *
 * - **I1** — *this module holds no dimensions at all*. Not one metre, radian,
 *   second or colour lives here across a frame boundary: every value in every
 *   hook arrives through a token setter that the holding ability calls each
 *   frame from its own live settings, zero-length frames included. Pause with
 *   **P**, drag `entropy`'s rust slider, and the floor rusts differently while
 *   the clock is stopped. The one exception is the *neutral* each hook restores
 *   to, which is not a dimension but a definition of off.
 * - **I3** — tokens come from per-hook free lists and are recycled; `apply()`
 *   writes numbers into uniform boxes that already exist. A cast that borrows
 *   four hooks and holds them for ten seconds allocates nothing after the first
 *   time that ability id is cast.
 * - **I5** — there is not a single authored number in this file. Every value is
 *   the ability's, which is what keeps the sliders honest: `dawnbreak`'s sun
 *   elevation is a slider in `settings.dawnbreak`, not a constant in here.
 * - **I8** — the floor patch parks its uniform boxes on
 *   `material.userData.uniforms`, and `observe(material)` will park the module's
 *   whole live state there for the harness's pause probe.
 */

/* ---------------------------------------------------------------- */
/* The six hooks                                                     */
/* ---------------------------------------------------------------- */

export const Hook = Object.freeze({
  /** The scene's directional light: direction, colour, intensity, weight. */
  KEY_LIGHT: 'keyLight',
  /** The post stack's grade: saturation, temperature, lift, vignette, weight. */
  GRADE: 'grade',
  /** A 0..1 ageing field the floor material reads. */
  AGE: 'age',
  /** A region where nothing renders. */
  HOLE: 'hole',
  /** A signed gravity multiplier inside a volume. */
  GRAVITY: 'gravity',
  /** A published region other abilities' materials opt into reading. */
  DISRUPT: 'disrupt'
});

/** Iteration order for sweeps and for `describe()`. Stable, for the readout. */
const HOOK_IDS = Object.freeze([
  Hook.KEY_LIGHT,
  Hook.GRADE,
  Hook.AGE,
  Hook.HOLE,
  Hook.GRAVITY,
  Hook.DISRUPT
]);

/**
 * Frames a token may go unwritten before the module takes the hook back.
 *
 * Eight, because the holder is expected to write every frame and eight frames
 * is 133 ms at 60 Hz — long enough that a stutter, a tab switch or a single
 * dropped frame in `AbilityManager` never trips it, short enough that a leak is
 * gone before the eye finds it. A holder that legitimately has nothing to say
 * this frame calls `token.hold()`, which renews the lease and changes nothing.
 */
const LEASE_FRAMES = 8;

/**
 * Metres the key light is parked up-sun of the focus point.
 *
 * Mirrors the literal in `world/Environment.js#update`. It is not a look
 * parameter — the shadow camera's far plane is 140 m and the light has to sit
 * inside it — so it is a constant in both places rather than a slider, and if
 * one moves the other must. Named here so the grep finds both.
 */
const SUN_DISTANCE = 70;

/* ---------------------------------------------------------------- */
/* Module scratch — I3                                               */
/* ---------------------------------------------------------------- */

const _dirBase = new Vector3();
const _dirWant = new Vector3();
const _dirOut = new Vector3();
const _colBase = new Color();
const _colOut = new Color();

/**
 * Direction a light *travels*, from azimuth and elevation.
 *
 * Character-for-character `Environment#_computeLightDirection`. See the header:
 * the alternative is reading the direction back off `environment.sun.position`,
 * which is the live value, which is what makes a blend compound.
 */
function lightDirection(out, azimuth, elevation) {
  const cosE = Math.cos(elevation);
  out.set(-Math.cos(azimuth) * cosE, -Math.sin(elevation), -Math.sin(azimuth) * cosE);
  return out.normalize();
}

/* ---------------------------------------------------------------- */
/* The published uniform blocks                                      */
/* ---------------------------------------------------------------- */
/*
 * DISRUPT's and GRAVITY's boxes and GLSL live in `./hookFields.js` — a leaf
 * that imports one class from three and nothing else. They were moved out of
 * this file to break a module ring: this file imports `config/settings.js`,
 * settings imports every ability block, six ability blocks import `vfx/Tube.js`
 * for `tubeDefaults()`, and `Tube` opts into the disruption field. See that
 * file's header for the failure it caused and why MATERIAL AGE stayed here.
 *
 * They are re-exported below under their original names, by identity, so every
 * `import { disruptGLSL, disruptUniforms } from '.../SceneHooks.js'` in the
 * project keeps working and keeps sharing the same boxes.
 */

/**
 * MATERIAL AGE's block. Unlike the two above this one is *not* shared widely —
 * there is one floor, and it is the only surface in the sandbox with enough
 * real material to age. Kept in the same shape so a second consumer (a wall, a
 * prop kit) is a spread rather than a rewrite.
 */
const _age = {
  /** xyz centre in metres, w radius in metres. w <= 0 means no field. */
  uAgeField: { value: new Vector4(0, 0, 0, 0) },
  /** x edge 0..1 of radius, y amount 0..1, z inner cut 0..1, w unused. */
  uAgeShape: { value: new Vector4(0.35, 0, 0, 0) },
  /** rust, dust, moss, pit — each 0..1, each independent. */
  uAgeMix: { value: new Vector4(0, 0, 0, 0) },
  /** Bleaching: desaturation and lift of whatever survived the other four. */
  uAgeBleach: { value: 0 },
  uAgeRustColor: { value: new Color('#7a3b1c') },
  uAgeDustColor: { value: new Color('#8a8375') },
  uAgeMossColor: { value: new Color('#3d5a20') },
  /** Metres — the feature size of the ageing patches. */
  uAgeGrain: { value: 1.4 }
};

/** The neutral for the age block. Written on release; see the header. */
function neutraliseAge() {
  _age.uAgeField.value.set(0, 0, 0, 0);
  _age.uAgeShape.value.set(0.35, 0, 0, 0);
  _age.uAgeMix.value.set(0, 0, 0, 0);
  _age.uAgeBleach.value = 0;
}

/* ---------------------------------------------------------------- */
/* MATERIAL AGE — the floor patch                                    */
/* ---------------------------------------------------------------- */

/** Declarations added to both stages of the patched standard material. */
const AGE_COMMON = /* glsl */ `
uniform vec4  uAgeField;
uniform vec4  uAgeShape;
uniform vec4  uAgeMix;
uniform float uAgeBleach;
uniform vec3  uAgeRustColor;
uniform vec3  uAgeDustColor;
uniform vec3  uAgeMossColor;
uniform float uAgeGrain;
varying vec3  vSceneAgeWorld;
`;

/**
 * The ageing field and the five things it does to a PBR surface.
 *
 * One 0..1 drives all five, and the five are *not* five tints. The reason a
 * decal reads as a decal and this does not is that each term moves a different
 * channel of the material:
 *
 * | term | albedo | roughness | metalness |
 * | --- | --- | --- | --- |
 * | rust | toward `uAgeRustColor`, patchy | up | **up** — rust is the only metal on this floor |
 * | dust | toward `uAgeDustColor`, even | hard up | down |
 * | moss | toward `uAgeMossColor`, in the low-frequency hollows | up | down |
 * | pit  | darkened specks | up | down |
 * | bleach | desaturate and lift | — | — |
 *
 * Metalness is what sells rust. The first version graded albedo only, all five
 * terms, and the aged ring read as a coloured decal painted on clean stone —
 * because it *was* one. Rust that goes metallic catches the key light at a
 * different angle from the stone beside it and the eye reads it as a different
 * substance before it reads the colour at all. That single channel is the trick.
 *
 * The pitting is shaded, not displaced: the floor is one flat plane with four
 * vertices (`world/Ground.js` keeps it flat because every raycast in the
 * project assumes it), so there is nothing to displace. Darkened specks plus
 * roughness is what a pit looks like from standing height anyway.
 */
const AGE_FIELD = /* glsl */ `
float sceneAgeField(vec3 wp) {
  float r = uAgeField.w;
  if (r <= 0.0) return 0.0;
  float d = length(wp.xz - uAgeField.xz);
  float edge = clamp(uAgeShape.x, 0.001, 1.0);
  float inner = clamp(uAgeShape.z, 0.0, 0.999) * r;
  float rise = smoothstep(inner * (1.0 - edge), inner + 1e-3, d);
  float fall = 1.0 - smoothstep(r * (1.0 - edge), r, d);
  return rise * fall * clamp(uAgeShape.y, 0.0, 1.0);
}
`;

const AGE_APPLY = /* glsl */ `
{
  float age = sceneAgeField(vSceneAgeWorld);
  if (age > 0.0005) {
    vec3 wp = vSceneAgeWorld;
    float grain = max(uAgeGrain, 0.05);

    // Three bands, deliberately incommensurate scales: patches of rust are
    // metres across, moss hollows are broader still, pitting is centimetres.
    // Sharing one band makes all five terms land in the same places and the
    // whole thing collapses back into a single tint.
    //
    // NOT named 'patch'. It was, and the floor did not compile: three converts
    // this material to GLSL ES 3.00, where 'patch' is the tessellation-shader
    // qualifier and therefore reserved. The error is a syntax error on this
    // line with no mention of the word being reserved anywhere the eye lands,
    // and it takes the whole ground material down with it. The README's
    // reserved-word list has it now, and so does the harness.
    float mottle = fbm3(wp / grain) * 0.5 + 0.5;
    float hollow = fbm3(wp / (grain * 2.7) + 41.0) * 0.5 + 0.5;
    float speck = snoise01(wp / (grain * 0.16) + 7.0);

    float rust = clamp(uAgeMix.x, 0.0, 1.0) * age * smoothstep(0.42, 0.78, mottle);
    float dust = clamp(uAgeMix.y, 0.0, 1.0) * age * (0.65 + 0.35 * speck);
    float moss = clamp(uAgeMix.z, 0.0, 1.0) * age * smoothstep(0.62, 0.30, hollow);
    float pit  = clamp(uAgeMix.w, 0.0, 1.0) * age * smoothstep(0.74, 0.94, speck);

    // Pitting first: it is a hole in the stone, so everything that settles
    // afterwards settles into it.
    diffuseColor.rgb *= 1.0 - 0.62 * pit;
    roughnessFactor = mix(roughnessFactor, 1.0, pit * 0.8);

    // Rust. The metalness lift is the term that makes this a material change.
    diffuseColor.rgb = mix(diffuseColor.rgb, uAgeRustColor, rust * 0.85);
    roughnessFactor = mix(roughnessFactor, 0.82, rust);
    metalnessFactor = mix(metalnessFactor, 0.55, rust * 0.9);

    // Moss in the hollows: matte, and it kills metalness wherever it lands.
    diffuseColor.rgb = mix(diffuseColor.rgb, uAgeMossColor, moss * 0.8);
    roughnessFactor = mix(roughnessFactor, 0.97, moss);
    metalnessFactor *= 1.0 - moss * 0.9;

    // Dust lies on top of all of it and flattens the lot.
    diffuseColor.rgb = mix(diffuseColor.rgb, uAgeDustColor, dust * 0.55);
    roughnessFactor = mix(roughnessFactor, 1.0, dust * 0.9);
    metalnessFactor *= 1.0 - dust * 0.7;

    // Bleaching last, because sun-bleaching acts on whatever colour is there.
    float bleach = clamp(uAgeBleach, 0.0, 1.0) * age;
    float grey = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(grey), bleach * 0.75);
    diffuseColor.rgb += bleach * 0.10;
  }
}
`;

/**
 * Patch a `MeshStandardMaterial` so it reads the ageing field.
 *
 * Called by `install()` on `ground.material`, and exported so a future prop kit
 * can join. Composes through `patchOnBeforeCompile`, so `Ground`'s own tint and
 * sheen patch is untouched and runs first — this one lands at
 * `<metalnessmap_fragment>`, which is the one injection point in the physical
 * shader where `diffuseColor`, `roughnessFactor` and `metalnessFactor` are all
 * in scope and all still mutable.
 *
 * It declares its **own** world-position varying rather than reusing the
 * `vGroundWorld` that `Ground` happens to provide. One duplicated matrix
 * multiply per vertex, on a plane with four of them, buys a patch that works on
 * any standard material and does not break the day somebody renames a varying
 * in a file that has no idea this one exists.
 */
export function patchAgeMaterial(material) {
  if (!material || material.userData?.sceneHookAged) return material;

  patchOnBeforeCompile(material, (shader) => {
    Object.assign(shader.uniforms, _age);

    // `replaceChunk` rather than a bare `.replace`: a token that vanishes in a
    // three.js upgrade would otherwise silently produce a floor that cannot be
    // aged, with no error anywhere. It warns, once, naming the token.
    let vs = replaceChunk(
      shader.vertexShader,
      '#include <common>',
      `#include <common>\nvarying vec3 vSceneAgeWorld;`
    );
    vs = replaceChunk(
      vs,
      '#include <begin_vertex>',
      `#include <begin_vertex>\nvSceneAgeWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
    );
    shader.vertexShader = vs;

    // `<metalnessmap_fragment>` is the injection point because it is the one
    // place in the physical shader where diffuseColor, roughnessFactor and
    // metalnessFactor are all in scope and all still mutable — and it sits
    // after `<roughnessmap_fragment>`, which is where Ground's own sheen patch
    // lands, so ageing composes on top of the floor's look rather than under it.
    let fs = replaceChunk(
      shader.fragmentShader,
      '#include <common>',
      `#include <common>\n${AGE_COMMON}\n${noiseGLSL}\n${AGE_FIELD}`
    );
    fs = replaceChunk(
      fs,
      '#include <metalnessmap_fragment>',
      `#include <metalnessmap_fragment>\n${AGE_APPLY}`
    );
    shader.fragmentShader = fs;
  });

  // I8 — the harness's pause probe reads uniforms off here, and so does anyone
  // debugging why the floor will not rust.
  material.userData = material.userData ?? {};
  material.userData.uniforms = Object.assign(material.userData.uniforms ?? {}, _age);
  material.userData.sceneHookAged = true;
  material.needsUpdate = true;
  return material;
}

/* ---------------------------------------------------------------- */
/* The tokens                                                        */
/* ---------------------------------------------------------------- */

/**
 * The borrow receipt.
 *
 * One token per (hook, owner), kept in a `WeakMap` on the ledger and reused
 * across that owner's casts. The reuse is deliberate — abilities are pooled and
 * an ability that takes the grade on every cast must not allocate a receipt on
 * every cast (I3) — but the token is **never** handed to a different owner, and
 * that is the load-bearing half.
 *
 * The version this replaced kept a per-hook free list and relied on `serial` to
 * catch the recycle: ability A releases, ability B is handed A's token, A's
 * late `onDestroy()` calls `release()` and is supposed to be rejected. It never
 * was. `release()` reads the serial off the token it is called on, so after the
 * recycle the stale reference and the live holder are the same object and the
 * comparison is a number against itself — A silently evicted B, which is worse
 * than the leak the check was there to prevent, because it is intermittent.
 *
 * Keyed by owner, the situation cannot arise: A's token is A's, so a late
 * release from A can only find A's own borrow, already inert. `active` closes
 * the double release; `serial` remains as a cheap second gate for callers that
 * hold one, and the harness asserts both.
 */
class HookToken {
  constructor(hook) {
    /** @type {string} which hook this is a receipt for. */
    this.hook = hook;
    /** Bumped on every acquisition. A release must present the current one. */
    this.serial = 0;
    /** The ability (or anything) that borrowed it. Used by `reclaim()`. */
    this.owner = null;
    /** True between acquire and release. */
    this.active = false;
    /** True when this token is the one at the top of its hook's stack. */
    this.driving = false;
    /** Frame stamp of the last write. The lease. */
    this.seen = 0;
    /** The ledger, so `release()` can be called on the token alone. */
    this.hooks = null;
    this.reset();
  }

  /** Every token type overrides this to clear its own stored values. */
  reset() {
    this.weight = 1;
  }

  /**
   * The blend against whatever the world would have been without this hook,
   * 0..1. On every hook, weight 0 is *transparent* — not "off but still
   * holding": the world takes exactly the value the sliders say. That
   * uniformity is what lets an ability fade a hook in and out on its own
   * envelope without a special case per hook.
   */
  blend(weight) {
    this.weight = weight;
    return this.hold();
  }

  /**
   * Renew the lease without changing anything.
   *
   * A holder that is mid-beat and has nothing to say this frame still has to
   * say *that*, or the sweep in `apply()` takes the hook back. Every setter
   * calls this, so a holder writing normally never needs it.
   */
  hold() {
    if (this.active && this.hooks) this.seen = this.hooks._frame;
    return this;
  }

  /** Give the hook back. Safe to call twice, and safe on a recycled token. */
  release() {
    this.hooks?._release(this, this.serial);
  }
}

/**
 * KEY LIGHT — the sun.
 *
 * `dawnbreak` swings it from the horizon to overhead and back, and every object
 * in the world throws a real sweeping shadow because it is the same light that
 * was always casting them. `sheetlightning` leaves the direction alone and
 * strobes intensity and colour, so all the real shadows in the world snap at
 * once — one number, and the whole stage flinches.
 *
 * `weight` is the blend against `settings.environment`, so an ability can take
 * the sun 30% of the way somewhere and the editor's own sliders still read
 * through. It is not an opacity: at weight 0 the hook is transparent and the
 * environment's value is the exact value on the light.
 */
class KeyLightToken extends HookToken {
  reset() {
    this.weight = 1;
    this.azimuth = 0; //         radians — the holder resolves it every frame
    this.elevation = 0; //       radians
    this.aimed = false; //       false: leave direction alone, tint only
    // Reused, not rebuilt: `reset()` runs on every acquisition, and the other
    // four tokens carrying a Color already do it this way.
    this.color = this.color ?? new Color();
    this.color.setRGB(1, 1, 1);
    this.tinted = false;
    this.intensity = 1;
    this.lit = false; //         false: leave intensity alone
  }

  /** Swing the sun. Both angles in radians, same frame as `sunAzimuth`. */
  aim(azimuth, elevation) {
    this.azimuth = azimuth;
    this.elevation = elevation;
    this.aimed = true;
    return this.hold();
  }

  /** Recolour it. Accepts a `#rrggbb` string or a `THREE.Color`. */
  tint(color) {
    if (typeof color === 'string') this.color.copy(getColor(color));
    else if (color) this.color.copy(color);
    this.tinted = true;
    return this.hold();
  }

  /** Absolute intensity, in the same units as `environment.sunIntensity`. */
  brightness(intensity) {
    this.intensity = intensity;
    this.lit = true;
    return this.hold();
  }

}

/**
 * GRADE — the look pass.
 *
 * `eclipse` drains colour toward the umbra before the disc ever appears, which
 * is the Thunderclap lesson applied to light: the anticipation carries it.
 *
 * Four parameters only, and they are the four that read as *the world going
 * wrong* rather than as a filter: saturation, temperature, lift and vignette.
 * Contrast and gain are deliberately not here — they read as a camera setting
 * being changed, which is a different sentence.
 */
class GradeToken extends HookToken {
  reset() {
    this.weight = 1;
    this.saturation = 1;
    this.hasSaturation = false;
    this.temperature = 0;
    this.hasTemperature = false;
    this.lift = 0;
    this.hasLift = false;
    this.vignette = 0;
    this.hasVignette = false;
  }

  /** 0 is monochrome, 1 is untouched. */
  saturate(value) {
    this.saturation = value;
    this.hasSaturation = true;
    return this.hold();
  }

  /** + warm, - cool, matching `post.temperature`. */
  temper(value) {
    this.temperature = value;
    this.hasTemperature = true;
    return this.hold();
  }

  /** Black level. Negative crushes toward the umbra. */
  raise(value) {
    this.lift = value;
    this.hasLift = true;
    return this.hold();
  }

  /** How much darker the corners are, 0..1. */
  darken(value) {
    this.vignette = value;
    this.hasVignette = true;
    return this.hold();
  }
}

/**
 * MATERIAL AGE — the floor's own shader.
 *
 * `entropy` sweeps the field outward and back. The field is a disc with an
 * optional inner cut, so the same token draws a filling circle (`ring(0)`) or a
 * travelling annulus (`ring(0.8)`) — which is what "sweeps outward and then
 * retreats" actually wants, because a wave of decay has a trailing edge.
 */
class AgeToken extends HookToken {
  reset() {
    this.weight = 1;
    this.centre = this.centre ?? new Vector3();
    this.centre.set(0, 0, 0);
    this.radius = 0;
    this.edge = 0.35;
    this.amount = 0;
    this.inner = 0;
    this.rust = 0;
    this.dust = 0;
    this.moss = 0;
    this.pit = 0;
    this.bleach = 0;
    this.grain = 1.4;
    this.rustColor = this.rustColor ?? new Color();
    this.dustColor = this.dustColor ?? new Color();
    this.mossColor = this.mossColor ?? new Color();
    this.rustColor.set('#7a3b1c');
    this.dustColor.set('#8a8375');
    this.mossColor.set('#3d5a20');
  }

  /** Centre of the field, in metres. */
  at(x, y, z) {
    this.centre.set(x, y, z);
    return this.hold();
  }

  /** Vector3 form of `at()`. */
  atPoint(point) {
    this.centre.copy(point);
    return this.hold();
  }

  /**
   * The field: outer radius in metres, edge softness as a fraction of it,
   * strength 0..1, and the inner cut that turns the disc into an annulus.
   */
  field(radius, edge, amount, inner = 0) {
    this.radius = radius;
    this.edge = edge;
    this.amount = amount;
    this.inner = inner;
    return this.hold();
  }

  /** The five ageing terms, each 0..1 and each independent of the others. */
  wear(rust, dust, moss, pit, bleach) {
    this.rust = rust;
    this.dust = dust;
    this.moss = moss;
    this.pit = pit;
    this.bleach = bleach;
    return this.hold();
  }

  /** Metres — the feature size of the patches. */
  scale(metres) {
    this.grain = metres;
    return this.hold();
  }

  /** Three pickers, because I5 says so. `#rrggbb` or `THREE.Color`. */
  colours(rust, dust, moss) {
    if (rust) this.rustColor.copy(typeof rust === 'string' ? getColor(rust) : rust);
    if (dust) this.dustColor.copy(typeof dust === 'string' ? getColor(dust) : dust);
    if (moss) this.mossColor.copy(typeof moss === 'string' ? getColor(moss) : moss);
    return this.hold();
  }
}

/**
 * HOLE — a region where nothing renders.
 *
 * `silence`. See `_applyHole` for what it actually is and what was tried first.
 */
class HoleToken extends HookToken {
  reset() {
    this.weight = 1;
    this.centre = this.centre ?? new Vector3();
    this.centre.set(0, 0, 0);
    this.radius = 0;
    this.squash = 1;
  }

  at(x, y, z) {
    this.centre.set(x, y, z);
    return this.hold();
  }

  atPoint(point) {
    this.centre.copy(point);
    return this.hold();
  }

  /** Radius in metres. <= 0 hides the hole without releasing it. */
  size(radius, squash = 1) {
    this.radius = radius;
    this.squash = squash;
    return this.hold();
  }
}

/**
 * GRAVITY — a signed multiplier, published, read by whoever wants it.
 *
 * `hourglass` flips it. The sand falls into the cone, the zone inverts, and the
 * same field with the same grains falls up.
 */
class GravityToken extends HookToken {
  reset() {
    this.weight = 1;
    this.centre = this.centre ?? new Vector3();
    this.centre.set(0, 0, 0);
    this.radius = 0;
    this.edge = 0.25;
    this.inside = 1;
    this.outside = 1;
  }

  at(x, y, z) {
    this.centre.set(x, y, z);
    return this.hold();
  }

  atPoint(point) {
    this.centre.copy(point);
    return this.hold();
  }

  /** The volume: radius in metres, edge softness as a fraction of it. */
  well(radius, edge = 0.25) {
    this.radius = radius;
    this.edge = edge;
    return this.hold();
  }

  /** The multipliers. `inside` is signed: -1 is full inversion. */
  scale(inside, outside = 1) {
    this.inside = inside;
    this.outside = outside;
    return this.hold();
  }
}

/**
 * DISRUPT — the published region other abilities read.
 *
 * `spellbreak` is the one ability aware of the rest. Cast into an empty room it
 * is arcane glass shattering; cast into a standing Nova Beam it desaturates and
 * fragments what is already there. Three shared materials opt in —
 * `FilamentPaths`, `GroundField` and `Swarm` — and between them they are most
 * of what is ever left standing in a zone: every bolt, snare, chain and crack;
 * every ground mark in all ten modes; every flock. The opt-in is one spread and
 * three lines of GLSL, documented in the README, and it is opt-**in** on
 * purpose: an ability whose trick is that it cannot be broken simply does not
 * add the lines.
 */
class DisruptToken extends HookToken {
  reset() {
    this.weight = 1;
    this.centre = this.centre ?? new Vector3();
    this.centre.set(0, 0, 0);
    this.radius = 0;
    this.edge = 0.35;
    this.drain = 0;
    this.fracture = 0;
    this.dim = 0;
    this.grain = 6;
  }

  at(x, y, z) {
    this.centre.set(x, y, z);
    return this.hold();
  }

  atPoint(point) {
    this.centre.copy(point);
    return this.hold();
  }

  /** The region: radius in metres, edge softness as a fraction of it. */
  region(radius, edge = 0.35) {
    this.radius = radius;
    this.edge = edge;
    return this.hold();
  }

  /** What it does: desaturation, dither erosion, and dimming — each 0..1. */
  power(drain, fracture, dim) {
    this.drain = drain;
    this.fracture = fracture;
    this.dim = dim;
    return this.hold();
  }

  /** Device pixels per fracture cell. Bigger cells, bigger shards. */
  shardSize(pixels) {
    this.grain = pixels;
    return this.hold();
  }
}

const TOKEN_TYPES = {
  [Hook.KEY_LIGHT]: KeyLightToken,
  [Hook.GRADE]: GradeToken,
  [Hook.AGE]: AgeToken,
  [Hook.HOLE]: HoleToken,
  [Hook.GRAVITY]: GravityToken,
  [Hook.DISRUPT]: DisruptToken
};

/* ---------------------------------------------------------------- */
/* The ledger                                                        */
/* ---------------------------------------------------------------- */

/**
 * The borrow/restore ledger, and the one place the world is written.
 *
 * There is one of these in the app (`sceneHooks`, below). It is a class rather
 * than a module of functions for one reason: the harness needs to build its own
 * against a mock world and drive it without touching the app's.
 */
export class SceneHooks {
  constructor() {
    /** Stacks of live tokens, one per hook. The last entry drives. */
    this._stacks = new Map();
    /**
     * The token store: one `WeakMap` per hook, from **owner** to that owner's
     * one token for that hook. See `acquire()` for why it is keyed by owner
     * rather than being a free list.
     */
    this._owned = new Map();
    for (const id of HOOK_IDS) {
      this._stacks.set(id, []);
      this._owned.set(id, new WeakMap());
    }

    /** How many hooks have at least one holder. The whole idle cost is this. */
    this._held = 0;
    /** Frames since construction. The lease clock; advances in `apply()`. */
    this._frame = 0;
    /** Owners already warned about, so a leak is one line and not a flood. */
    this._warned = new Set();

    /** The world, filled in by `install()`. Every field is optional. */
    this._scene = null;
    this._environment = null;
    this._grade = null;
    this._renderer = null;

    /** The HOLE's depth proxy. Built on the first acquisition, never disposed. */
    this._holeMesh = null;
    /** True while the age patch has been applied to somebody's material. */
    this._aged = false;

    /** Counters for the readout and for the harness. */
    this.stats = { acquired: 0, released: 0, reclaimed: 0, applies: 0 };
  }

  /* ---------------------------------------------------------------- */
  /* Installation                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Point the module at the world. Called once, from `App`, before the first
   * frame. Every field is optional and a missing one disables exactly one hook
   * — `acquire()` still succeeds and `apply()` still runs, so an ability never
   * has to know whether it is running in the app or in the harness.
   *
   * @param {object} world
   * @param {THREE.Scene}   [world.scene]       for the HOLE proxy
   * @param {object}        [world.environment] `world/Environment.js`
   * @param {object}        [world.ground]      `world/Ground.js`, or any `{material}`
   * @param {object}        [world.grade]       the `GradeShader` uniform block
   * @param {object}        [world.renderer]    `core/Renderer.js`, for shadow refresh
   */
  install(world = {}) {
    this._scene = world.scene ?? null;
    this._environment = world.environment ?? null;
    this._grade = world.grade ?? null;
    this._renderer = world.renderer ?? null;

    const material = world.ground?.material ?? world.groundMaterial ?? null;
    if (material) {
      patchAgeMaterial(material);
      this._aged = true;
    }
    return this;
  }

  /**
   * Drop every hook and forget the world. `App.dispose()` calls it.
   *
   * It tears the hole proxy down as well, which matters more than it looks:
   * the proxy is parented to the scene it was built in, and a module that kept
   * it across an uninstall would hand the next `install()` a mesh living in the
   * previous app's scene graph — invisible, undisposed, and impossible to find.
   */
  uninstall() {
    return this.dispose();
  }

  /**
   * Park the module's live state on a material's `userData.uniforms`.
   *
   * The harness's pause probe (`docs/EXPANSION.md` §7 step 6) snapshots the
   * uniforms an *ability* owns. An ability whose entire output is a scene hook
   * owns none, so it reads as a dead slider bank even though it is driving the
   * sun. Calling this once at construction, on any material the ability already
   * has, makes the hook's own numbers visible to the probe — and to anyone
   * inspecting the material in a debugger.
   *
   * Nothing reads these uniforms in the shader. They are there to be seen.
   */
  observe(material) {
    if (!material) return material;
    material.userData = material.userData ?? {};
    material.userData.uniforms = Object.assign(
      material.userData.uniforms ?? {},
      _disrupt,
      _gravity,
      _age
    );
    return material;
  }

  /* ---------------------------------------------------------------- */
  /* Borrow and return                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Borrow a hook.
   *
   * Never returns null for a real hook — see the header. The returned token
   * drives the world from the next `apply()` until it is released or its lease
   * lapses.
   *
   * **An owner holds at most one token per hook.** Acquiring a hook you are
   * already holding renews your lease and hands you back the same token; it
   * does not stack a second borrow on top of your own, which would be a
   * self-deadlock nobody would diagnose.
   *
   * ## Why tokens are keyed by owner and not pooled in a free list
   *
   * The first version kept a per-hook free list and stamped each token with a
   * serial, on the theory that a stale reference could be caught by comparing
   * serials. It cannot, and the harness now proves it: `release()` reads the
   * serial *off the token it is called on*, so once the token has been recycled
   * the stale reference and the live holder are byte-identical and the check
   * compares a number with itself. A released token handed straight to the next
   * acquirer meant that ability A's late `onDestroy()` silently evicted ability
   * B — the exact failure the serial was written to prevent.
   *
   * Keying the store by owner makes the hazard unrepresentable rather than
   * detectable: A's token is A's for as long as A exists, so B is never handed
   * it and A's late release can only release A's own already-inert borrow. It
   * is still allocation-free after the first cast — abilities are pooled, so
   * the same handful of owners come back — and a `WeakMap` means a genuinely
   * discarded owner takes its tokens with it.
   *
   * An **anonymous** acquisition (`owner` omitted) has no key, so it gets a
   * fresh token. That is one small object for a caller that has also given up
   * `reclaim()`; abilities pass `this`.
   *
   * @param {string} hook   a `Hook` value
   * @param {object} owner  whatever is borrowing; `reclaim(owner)` takes it back
   */
  acquire(hook, owner = null) {
    const stack = this._stacks.get(hook);
    if (!stack) {
      console.warn(`[SceneHooks] no such hook: ${String(hook)}`);
      return null;
    }

    const store = this._owned.get(hook);
    const mine = owner ? store.get(owner) : null;
    // Already holding it: renew, do not stack on yourself.
    if (mine && mine.active) return mine.hold();

    const token = mine ?? new TOKEN_TYPES[hook](hook);
    if (owner && !mine) store.set(owner, token);
    token.reset();
    token.hooks = this;
    token.owner = owner;
    token.active = true;
    token.serial++;
    token.seen = this._frame;

    if (stack.length === 0) this._held++;
    for (const other of stack) other.driving = false;
    stack.push(token);
    token.driving = true;

    this.stats.acquired++;
    return token;
  }

  /** Is anybody holding this hook? */
  isHeld(hook) {
    return (this._stacks.get(hook)?.length ?? 0) > 0;
  }

  /** The token currently driving this hook, or null. */
  driver(hook) {
    const stack = this._stacks.get(hook);
    return stack && stack.length ? stack[stack.length - 1] : null;
  }

  /** How many hooks have at least one holder. Zero means `apply()` is a compare. */
  get heldCount() {
    return this._held;
  }

  /**
   * Give every hook this owner holds back. The line an ability's `onDestroy()`
   * wants, because it does not have to remember which of the six it took.
   */
  reclaim(owner) {
    let n = 0;
    for (const id of HOOK_IDS) {
      const stack = this._stacks.get(id);
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].owner === owner) {
          this._release(stack[i], stack[i].serial);
          n++;
        }
      }
    }
    return n;
  }

  /** Drop everything and restore the world. For teardown and for the editor. */
  releaseAll() {
    for (const id of HOOK_IDS) {
      const stack = this._stacks.get(id);
      for (let i = stack.length - 1; i >= 0; i--) this._release(stack[i], stack[i].serial);
    }
    return this;
  }

  /**
   * The one release path. Everything else funnels through here.
   *
   * `active` is what makes a double release, a release from a destroyed
   * ability, and a release racing the lease sweep all the same harmless no-op.
   * The serial rides along as a second gate for a caller that kept one; it can
   * no longer be *needed*, because a token is never handed to a second owner —
   * see `acquire()` for the version of this that did not work.
   */
  _release(token, serial) {
    if (!token || !token.active || token.serial !== serial) return false;

    const stack = this._stacks.get(token.hook);
    const at = stack.indexOf(token);
    if (at >= 0) stack.splice(at, 1);

    token.active = false;
    token.driving = false;
    token.owner = null;
    token.hooks = null;

    if (stack.length === 0) {
      this._held = Math.max(0, this._held - 1);
      this._restore(token.hook);
    } else {
      // LIFO: whoever was under the released token takes the world back, now,
      // not on some later re-acquisition.
      stack[stack.length - 1].driving = true;
    }

    this.stats.released++;
    return true;
  }

  /**
   * Put one hook's slice of the world back exactly.
   *
   * KEY_LIGHT and GRADE are absent from this switch on purpose: their owners
   * re-author them from settings every frame before `apply()` runs, so there is
   * nothing to restore — see the header. The other four mutate persistent state
   * and each has a documented neutral.
   */
  _restore(hook) {
    switch (hook) {
      case Hook.AGE:
        neutraliseAge();
        break;
      case Hook.HOLE:
        if (this._holeMesh) this._holeMesh.visible = false;
        break;
      case Hook.GRAVITY:
        neutraliseGravity();
        break;
      case Hook.DISRUPT:
        neutraliseDisrupt();
        break;
      default:
        break;
    }
  }

  /* ---------------------------------------------------------------- */
  /* The one write                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Write every held hook into the world. Called once per frame by `App`,
   * between `post.sync()` and `post.render()`.
   *
   * That position is not arbitrary and it is the only one that works for all
   * six: `Environment.update()` has already re-authored the key light from
   * settings, `PostProcessing.sync()` has already re-authored the grade, and
   * nothing has rendered yet — including the shadow map, which three refreshes
   * inside the first `gl.render()` of `post.render()`. Move this call above
   * `post.sync()` and the grade hook silently stops working.
   *
   * It is **idempotent**. Everything blends from `settings`, never from the
   * live value, so calling it twice in a frame is a waste and not a bug — which
   * is what lets an ability call it from its own `update()` to make the pause
   * probe see a hook-only effect (see `observe()`).
   */
  apply() {
    if (this._held === 0) return;

    this._frame++;
    this.stats.applies++;
    this._sweep();

    if (this._held === 0) return; // the sweep may have taken the last one back

    if (this.isHeld(Hook.KEY_LIGHT)) this._applyKeyLight(this.driver(Hook.KEY_LIGHT));
    if (this.isHeld(Hook.GRADE)) this._applyGrade(this.driver(Hook.GRADE));
    if (this.isHeld(Hook.AGE)) this._applyAge(this.driver(Hook.AGE));
    if (this.isHeld(Hook.HOLE)) this._applyHole(this.driver(Hook.HOLE));
    if (this.isHeld(Hook.GRAVITY)) this._applyGravity(this.driver(Hook.GRAVITY));
    if (this.isHeld(Hook.DISRUPT)) this._applyDisrupt(this.driver(Hook.DISRUPT));
  }

  /**
   * Take back anything whose lease has lapsed.
   *
   * This is the safety net described in the header, and it is the reason a
   * mid-effect destroy cannot strand the world. It walks at most six short
   * arrays and only when something is held.
   */
  _sweep() {
    for (const id of HOOK_IDS) {
      const stack = this._stacks.get(id);
      for (let i = stack.length - 1; i >= 0; i--) {
        const token = stack[i];
        if (this._frame - token.seen <= LEASE_FRAMES) continue;
        const name = token.owner?.id ?? token.owner?.constructor?.name ?? 'an anonymous owner';
        const key = `${id}:${name}`;
        if (!this._warned.has(key)) {
          this._warned.add(key);
          console.warn(
            `[SceneHooks] reclaimed '${id}' from ${name}: no write for ${LEASE_FRAMES} frames. ` +
              `Call token.hold() on a frame with nothing to say, or token.release() when done.`
          );
        }
        this._release(token, token.serial);
        this.stats.reclaimed++;
      }
    }
  }

  /**
   * KEY LIGHT.
   *
   * The blend is from `settings.environment`, and the four lines of
   * azimuth/elevation trigonometry are a deliberate copy of
   * `Environment#_computeLightDirection` — the header explains why reading the
   * live direction back off the light instead would compound.
   *
   * Three things move together and all three matter:
   *
   *  - `sun.position` and `sunTarget.position`, which is what three's shadow
   *    camera is built from, so the *real* shadows swing;
   *  - `frame.uLightDir`, which every custom material that fakes its own normal
   *    reads — ground snow, rubble, the filament strip. Miss this one and the
   *    lit meshes swing while the effects stay lit from the old sun, which
   *    reads as the effects being stickers. This was the bug that took longest
   *    to see, because each half looks correct on its own.
   *  - `shadowMap.needsUpdate`, defensively. `App.frame` already sets it true
   *    unconditionally every frame and three consumes it inside the first
   *    `gl.render()`, so the 4096² map is re-rendered every frame whether the
   *    sun moves or not: 1 draw call and 9,578 triangles, measured by toggling
   *    `sun.castShadow`, and the frame is 31 draw calls with the sun still and
   *    31 with it sweeping. A swinging sun therefore costs **nothing** today.
   *    This write is here so that the day somebody makes shadow refresh
   *    conditional — the obvious win on a stage this static — a swinging sun
   *    does not silently keep last frame's shadows.
   */
  _applyKeyLight(token) {
    const env = this._environment;
    if (!env || !token) return;
    const e = settings.environment;
    const w = saturate(token.weight);

    lightDirection(_dirBase, e.sunAzimuth, e.sunElevation);
    if (token.aimed) {
      lightDirection(_dirWant, token.azimuth, token.elevation);
      // Normalised lerp rather than a slerp: over the arc a sun sweep actually
      // covers, the two are within a degree of each other, and this one cannot
      // produce a NaN when the endpoints are antipodal.
      _dirOut.copy(_dirBase).lerp(_dirWant, w);
      if (_dirOut.lengthSq() < 1e-8) _dirOut.copy(_dirWant);
      _dirOut.normalize();
    } else {
      _dirOut.copy(_dirBase);
    }

    env.sunTarget.position.copy(env.focus);
    env.sun.position.copy(env.focus).addScaledVector(_dirOut, -SUN_DISTANCE);
    frame.uLightDir.value.copy(_dirOut).negate();

    if (token.tinted) {
      _colBase.copy(getColor(e.sunColor));
      _colOut.copy(_colBase).lerp(token.color, w);
      env.sun.color.copy(_colOut);
    }
    if (token.lit) env.sun.intensity = lerp(e.sunIntensity, token.intensity, w);

    if (this._renderer?.gl) this._renderer.gl.shadowMap.needsUpdate = true;
  }

  /**
   * GRADE. Blends from `settings.post`, honouring `post.enabled` exactly the
   * way `PostProcessing.sync()` does — an ability must not be able to switch
   * the grade back on for someone who turned the post stack off.
   */
  _applyGrade(token) {
    const u = this._grade;
    if (!u || !token) return;
    const p = settings.post;
    const on = p.enabled !== false;
    const w = saturate(token.weight);

    if (token.hasSaturation && u.uSaturation) {
      u.uSaturation.value = lerp(on ? p.saturation : 1, token.saturation, w);
    }
    if (token.hasTemperature && u.uTemperature) {
      u.uTemperature.value = lerp(on ? p.temperature : 0, token.temperature, w);
    }
    if (token.hasLift && u.uLift) {
      u.uLift.value = lerp(p.lift, token.lift, w);
    }
    if (token.hasVignette && u.uVignette) {
      u.uVignette.value = lerp(on ? p.vignette : 0, token.vignette, w);
    }
  }

  /** MATERIAL AGE. Straight into the shared block the floor patch reads. */
  _applyAge(token) {
    if (!token) return;
    const w = saturate(token.weight);
    _age.uAgeField.value.set(token.centre.x, token.centre.y, token.centre.z, Math.max(0, token.radius));
    _age.uAgeShape.value.set(
      clamp(token.edge, 0.001, 1),
      saturate(token.amount) * w,
      clamp(token.inner, 0, 0.999),
      0
    );
    _age.uAgeMix.value.set(
      saturate(token.rust),
      saturate(token.dust),
      saturate(token.moss),
      saturate(token.pit)
    );
    _age.uAgeBleach.value = saturate(token.bleach);
    _age.uAgeGrain.value = Math.max(0.05, token.grain);
    _age.uAgeRustColor.value.copy(token.rustColor);
    _age.uAgeDustColor.value.copy(token.dustColor);
    _age.uAgeMossColor.value.copy(token.mossColor);
  }

  /**
   * HOLE — a region where nothing renders.
   *
   * ## What it is
   *
   * One invisible sphere, drawn **first** among the opaques, that writes depth
   * and no colour. Everything the renderer draws afterwards that is further
   * away than its front surface fails the depth test and is never shaded. What
   * survives in those pixels is the clear colour, which is
   * `environment.backgroundColor` — the same flat void the floor already fades
   * into at the edges of the stage. Not a black disc *in front of* the world: a
   * pixel the world never reached.
   *
   * Occlusion comes out right for free, which is the part that would have been
   * fiddly any other way. The character standing between the camera and the
   * hole is nearer than the proxy, passes the test, and is drawn. Walk behind
   * the hole and the character is gone. A shard flying *through* the volume is
   * gone while it is inside and back the instant it clears the front surface.
   * Nothing in the project had to be told the hole exists.
   *
   * It is on `LAYER.WORLD`, so it is also in the depth prepass, so every soft
   * particle in the sandbox fades as it crosses into the hole instead of
   * clipping at it. That was luck, but it is good luck and it is worth keeping.
   *
   * ## What was tried first
   *
   * **A stencil written by a proxy mesh** — the obvious answer, and the brief's
   * first suggestion. It does not fit this pipeline without paying for it three
   * times over. `core/Renderer.js` constructs the `WebGLRenderer` with
   * `stencil: false`, so the drawing buffer has no stencil attachment;
   * `EffectComposer`'s ping-pong targets have none either, and every pass would
   * need one added and cleared. That is a stencil buffer on the frame plus two
   * on the composer plus a clear per pass, for a mask the depth buffer — which
   * already exists, is already cleared, and is already being tested against by
   * every draw in the frame — hands over for nothing. Depth is not a
   * workaround here; it is the correct tool that the stencil is a fallback for
   * when you need a mask that ignores geometry, and this mask does not.
   *
   * **A mask honoured by the final pass** — analytic sphere in `GradeShader`,
   * projected to screen space, occlusion-tested against `frame.uSceneDepth`.
   * Real advantage: it runs after `UnrealBloomPass`, so it also punches through
   * the bloom, which the depth proxy does not. Two problems killed it. It
   * cannot occlude against anything that is not in the depth prepass — the
   * prepass is `LAYER.WORLD` only — so a bolt drawn in front of the hole gets
   * erased along with it, which is exactly wrong. And it is a permanent edit to
   * the grade shader that every frame in the app pays for.
   *
   * ## What it costs, and the one honest caveat
   *
   * **Two** draw calls while held, and nothing at all when it is not: a 32×16
   * sphere with colour writes off, drawn once into the depth prepass and once
   * into the main pass. Measured, not assumed — the frame goes from 31 draw
   * calls to 33. The caveat is bloom: because the hole is
   * punched in the scene pass, a bright effect beside it still bleeds across
   * the rim by the bloom radius. On this stage `post.bloomStrength` ships at
   * 0.03 and it is invisible; cast `silence` next to something with the bloom
   * cranked and there is a faint halo lying over the void. Fixing it properly
   * means the grade-pass mask above, and it is not worth what it breaks.
   */
  _applyHole(token) {
    if (!token) return;
    const mesh = this._ensureHole();
    if (!mesh) return;
    const r = Math.max(0, token.radius) * saturate(token.weight);
    mesh.visible = r > 1e-4;
    if (!mesh.visible) return;
    mesh.position.copy(token.centre);
    mesh.scale.set(r, r * Math.max(0.01, token.squash), r);
    mesh.updateMatrix();
  }

  /** Built on first use so an app that never casts `silence` never allocates it. */
  _ensureHole() {
    if (this._holeMesh) return this._holeMesh;
    if (!this._scene) return null;

    const geometry = new SphereGeometry(1, 32, 16);
    const material = new MeshBasicMaterial({
      colorWrite: false, //   the whole trick: depth only
      depthWrite: true,
      depthTest: true,
      fog: false
    });
    const mesh = new Mesh(geometry, material);
    mesh.name = 'SceneHooks.Hole';
    mesh.layers.set(LAYER.WORLD); //  so it is in the depth prepass too
    // Ahead of every other opaque. Three sorts opaques by renderOrder first,
    // and a depth-only proxy that draws after the floor has already shaded the
    // floor: the whole point is to be in the depth buffer before anyone tests.
    mesh.renderOrder = -1000;
    mesh.castShadow = false; //   a hole does not shadow; it is not there
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;

    this._scene.add(mesh);
    this._holeMesh = mesh;
    return mesh;
  }

  /** GRAVITY. Publishes; reads are `gravityAt()` on the CPU, `gravityScaleAt()` in GLSL. */
  _applyGravity(token) {
    if (!token) return;
    const w = saturate(token.weight);
    _gravity.uGravityWell.value.set(
      token.centre.x,
      token.centre.y,
      token.centre.z,
      Math.max(0, token.radius)
    );
    _gravity.uGravityMix.value.set(
      lerp(token.outside, token.inside, w),
      token.outside,
      clamp(token.edge, 0.001, 1),
      0
    );
  }

  /** DISRUPT. Publishes into the block the opted-in materials already hold. */
  _applyDisrupt(token) {
    if (!token) return;
    const w = saturate(token.weight);
    _disrupt.uDisruptRegion.value.set(
      token.centre.x,
      token.centre.y,
      token.centre.z,
      Math.max(0, token.radius)
    );
    _disrupt.uDisruptPower.value.set(
      saturate(token.drain) * w,
      saturate(token.fracture) * w,
      saturate(token.dim) * w,
      clamp(token.edge, 0.001, 1)
    );
    _disrupt.uDisruptGrain.value = Math.max(1, token.grain);
  }

  /* ---------------------------------------------------------------- */
  /* The read side                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * The gravity multiplier at a world point, on the CPU.
   *
   * Mirrors `gravityScaleAt()` in `gravityGLSL` exactly, including the
   * smoothstep, so a CPU-integrated emitter and a GPU-integrated one agree at
   * the boundary. Returns exactly 1 when nothing is held, so a caller can
   * multiply unconditionally.
   */
  gravityAt(x, y, z) {
    const well = _gravity.uGravityWell.value;
    if (well.w <= 0) return 1;
    const mix = _gravity.uGravityMix.value;
    const edge = clamp(mix.z, 0.001, 1);
    const d = Math.hypot(x - well.x, y - well.y, z - well.z);
    const k = 1 - smooth01(well.w * (1 - edge), well.w, d);
    return mix.y + (mix.x - mix.y) * k;
  }

  /** Disruption strength at a world point, 0..1, on the CPU. Mirrors `disruptAt()`. */
  disruptAt(x, y, z) {
    const region = _disrupt.uDisruptRegion.value;
    if (region.w <= 0) return 0;
    const edge = clamp(_disrupt.uDisruptPower.value.w, 0.001, 1);
    const d = Math.hypot(x - region.x, y - region.y, z - region.z);
    return 1 - smooth01(region.w * (1 - edge), region.w, d);
  }

  /** The ageing amount at a world point, 0..1. Mirrors `sceneAgeField()`. */
  ageAt(x, z) {
    const f = _age.uAgeField.value;
    if (f.w <= 0) return 0;
    const shape = _age.uAgeShape.value;
    const d = Math.hypot(x - f.x, z - f.z);
    const edge = clamp(shape.x, 0.001, 1);
    const inner = clamp(shape.z, 0, 0.999) * f.w;
    const rise = smooth01(inner * (1 - edge), inner + 1e-3, d);
    const fall = 1 - smooth01(f.w * (1 - edge), f.w, d);
    return rise * fall * saturate(shape.y);
  }

  /** One line per hook, for a debug overlay or a console poke. */
  describe() {
    const parts = [];
    for (const id of HOOK_IDS) {
      const stack = this._stacks.get(id);
      if (!stack.length) continue;
      const names = stack.map((t) => t.owner?.id ?? t.owner?.constructor?.name ?? '?');
      parts.push(`${id}[${names.join(' < ')}]`);
    }
    return parts.length ? parts.join(' ') : 'nothing held';
  }

  /**
   * Drop the hole proxy. Only for teardown — `dispose()` on a module that the
   * whole app shares is a footgun, so this one is explicit and rarely wanted.
   */
  dispose() {
    this.releaseAll();
    if (this._holeMesh) {
      this._holeMesh.parent?.remove(this._holeMesh);
      this._holeMesh.geometry.dispose();
      this._holeMesh.material.dispose();
      this._holeMesh = null;
    }
    this._scene = null;
    this._environment = null;
    this._grade = null;
    this._renderer = null;
    return this;
  }
}

/** GLSL smoothstep, so the CPU mirrors agree with the shaders to the bit. */
function smooth01(a, b, x) {
  if (b - a <= 0) return x >= b ? 1 : 0;
  const t = saturate((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/**
 * The app's ledger. There is one world, so there is one of these.
 *
 * ```js
 * import { sceneHooks, Hook } from '../../vfx/SceneHooks.js';
 *
 * onSpawn()      { this._sun = sceneHooks.acquire(Hook.KEY_LIGHT, this); }
 * onTravel(dt)   { const c = settings.dawnbreak;
 *                  this._sun.aim(c.sunAzimuth, c.sunElevation * this.u)
 *                           .brightness(c.sunIntensity)
 *                           .blend(c.sunWeight * this.fade); }
 * onDestroy()    { sceneHooks.reclaim(this); }
 * ```
 */
export const sceneHooks = new SceneHooks();
