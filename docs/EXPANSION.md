# Expansion — engineering contracts

How the sandbox grows from six abilities to fifty without any file becoming unmaintainable.

Read this before touching anything. Then read `docs/ROSTER.md` for what the forty-four new
abilities actually are.

---

## 0 · The invariants (non-negotiable)

These are the rules the original six were built under. Every new ability obeys them.

**I1 — No dimensions on the CPU.** A cast may capture *unitless dice rolls* (`0..1` fractions,
signs, seeds) and *timestamps* (the moment an event fired). It may not capture a metre, a radian,
a second, or a colour. Everything with a unit is resolved against `settings[id]` inside the update
loop, every frame, including a zero-length frame. The test: pause with **P** mid-cast, drag a
slider, and the standing effect must change.

**I2 — Nothing is a texture.** No sprite sheets, no gradient ramps, no decal images. SDFs, noise,
parametric paths and procedural geometry only. The two exceptions already in the repo (the floor
material and the character's diffuse map) stay exceptions.

**I3 — Nothing allocates during a cast.** `spawn()` must fully reset state; `destroy()` must leave
the instance reusable. Per-frame code uses module-scope scratch objects (`const _pos = new
Vector3()` at the top of the file, reused). No `new`, no array literals, no object literals, no
closures created inside `onTravel` / `onFade` / `update`.

**I4 — Draw calls are counted.** An ability draws in single digits. Instancing, not iteration: if
you need forty of something, that is one `InstancedMesh` with per-instance attributes, or one
instanced strip whose vertex shader places every copy.

**I5 — Every value is authored.** Every dimension is a slider, every colour is a picker, and no
colour is derived from another. A particle system gets a four-stop lifetime gradient
(`colorXA/B/C/D`). The only values that may be shared are ones where the sharing *is* the design
(`zoneRadius` driving five consumers at once).

**I6 — Guard the light pool.** `ctx.lights.acquire()` returns `null` when the six dynamic lights
are spoken for. Every use of the handle is guarded. An ability that wants two lights must work
with one.

**I7 — Budget.** A single cast targets ≤ 12 draw calls, ≤ 1500 live particles, ≤ 1 dynamic light
(2 only if the ability genuinely cannot read without it). The manager caps at 4 concurrent casts.

---

## 1 · Registry — abilities are data

`src/abilities/registry.js` is the single place an ability is declared. Nothing else in the
project enumerates abilities.

```js
export const ABILITIES = [
  {
    id: 'rime',                       // settings key, particle-system prefix, glyph key
    label: 'Rimewalker',              // shown in the HUD and the editor folder
    school: 'frost',                  // groups the spellbook and the editor
    accent: '#7ecbe0',                // slot colour
    cast: CastShape.LINE,             // or CastShape.ZONE
    blurb: 'Sheet ice glazes the floor and peels up behind the front.',
    load: () => import('./frost/RimeAbility.js').then((m) => m.RimeAbility),
    settings: () => import('../config/abilities/rime.js').then((m) => m.rime)
  },
  ...
];
```

- **`load` is lazy.** Fifty ability classes are not constructed at boot. `AbilityManager` builds a
  pool for an id the first time that id is selected or cast, and warms its shaders then.
- **`settings` is not lazy.** Every settings block is registered at module load, because the
  editor, the preset system and the aim controller all need the full tree up front. Settings
  modules are pure data with no imports beyond constants — they must stay cheap.
- `ELEMENTS` and `ELEMENT_META` remain exported from `config/settings.js` as **derived views** over
  this registry so existing code keeps working.

**Schools** are declared once:

```js
export const SCHOOLS = [
  { id: 'frost',   label: 'Frost',   accent: '#7ecbe0' },
  { id: 'flame',   label: 'Flame',   accent: '#ff8a3c' },
  { id: 'storm',   label: 'Storm',   accent: '#7fb4ff' },
  { id: 'stone',   label: 'Stone',   accent: '#a89880' },
  { id: 'verdant', label: 'Verdant', accent: '#7fc85f' },
  { id: 'void',    label: 'Void',    accent: '#a98bff' },
  { id: 'arcane',  label: 'Arcane',  accent: '#ffd27a' },
  { id: 'blood',   label: 'Blood',   accent: '#e04a5a' },
  { id: 'aether',  label: 'Aether',  accent: '#8fe8d8' }
];
```

The six that shipped keep their ids (`ice`, `thunder`, `meteor`, `beam`, `snare`, `glacier`) and
join schools `frost`, `storm`, `flame`, `arcane`, `storm`, `frost` respectively.

---

## 2 · Settings — one module per ability

`config/settings.js` stays the source of truth for `global`, `aim`, `zone`, `environment`, `post`,
`camera`, `character` — and stops holding ability blocks. Each ability owns
`src/config/abilities/<id>.js`:

```js
/** Rimewalker — sheet ice. */
export const rime = {
  /* --- the cast --- */
  range: 18, minRange: 2, speed: 26, cooldown: 0.9, castAnim: 'cast3',
  ...
};

/** Editor layout: which folders exist and what goes in them. */
export const rimeSchema = {
  'The cast':        ['range', 'minRange', 'speed', 'cooldown', 'castAnim'],
  'The plates':      [['plateSize', 0.1, 3, 0.01, 'plate size'], ...],
  ...
};
```

`settings.js` imports every module and composes the tree, so `settings.rime` works exactly as
`settings.ice` does today and `applySettings` / `snapshotSettings` / presets need no change.

**Schema entries** are either a bare key (the editor infers a sensible range from the default and
the key name) or a tuple `[key, min, max, step, label]`. Colours are detected by value (`#rrggbb`)
and get a colour picker. A key ending `A`/`B`/`C`/`D` on a common prefix is offered as a gradient
group. Keys not mentioned in the schema still appear, in a trailing "More" folder — so a schema
is never wrong, only incomplete.

---

## 3 · Editor — schema-driven

`ui/Editor.js` keeps its hand-written folders for `Global`, `Aim`, `Zone`, `Environment`, `Post`,
`Camera`, `Character` and drops the six per-ability `_buildX()` methods. In their place:

- one top-level folder per **school**, containing one folder per ability, built from the schema;
- a **search box** that filters controllers by label across the whole tree;
- a **"jump to selected ability"** button, because scrolling past fifty folders is not a UI.

`Editor.range()`, `Editor.gradient()` and `Editor.castAnimation()` stay as the building blocks the
generic builder calls.

---

## 4 · HUD — the spellbook

Fifty abilities do not fit on a bar and do not fit on a keyboard.

- **Loadout bar** — eight slots bound to `Q W E R F V X C`… (the existing six keep their letters:
  `Q` ice, `E` thunder, `R` meteor, `F` beam, `V` snare, `X` glacier). Digits `1..8` mirror them.
- **Spellbook** — `Tab` (or `B`) opens a full-screen grid: nine school columns, every ability as a
  card with its sigil, name, cast shape and blurb. Click a card to **cast-select** it immediately;
  drag it (or shift-click) onto a loadout slot to bind it. Type to filter.
- **Loadout persistence** — the binding is saved to `localStorage` alongside presets.
- The spellbook is DOM, like the rest of the HUD. No framework.

`ui/glyphs.js` grows to fifty sigils, split into `ui/glyphs/<school>.js` modules re-exported from
one index. Same contract: a 100×100 stroke-only SVG inheriting `currentColor`.

---

## 5 · The tech library

Fourteen shared modules under `src/vfx/`. They exist so an ability is *configuration plus beats*
rather than a new renderer. Each ships with a doc comment stating: what it draws, its draw-call
cost, what it reads from settings, and the one rule for using it well.

Every one of them obeys **I1** — they take a live settings object and re-resolve from it each
frame; they never snapshot.

| module | what it is |
| --- | --- |
| `vfx/GrowthField.js` | Instanced procedural geometry erupting along a line or across a zone, with per-instance birth flash, stagger, height curve, lean, clumping. Generalises `IceAbility`'s crystal field. Takes a geometry *factory* + a material, hashes its shape params and rebuilds when they change. |
| `vfx/FilamentPaths.js` | The instanced ribbon strip with pluggable parametric paths, generalising `LightningMaterial` + `SnareMaterial`. Built-in path modes: `LINE`, `HELIX`, `ORBIT`, `MEANDER`, `RIM`, `CHAIN`, `LINK`, `SPIRAL_IN`, `CRACK`. Roles are selected in the vertex shader by instance index against live counts. |
| `vfx/VolumeHull.js` | Raymarched volume inside a proxy hull, generalising `VolumetricFireMaterial`. Hulls: `BOX`, `CYLINDER`, `CONE`, `DOME`, `SPHERE`. Media presets: `FLAME`, `SMOKE`, `ASH`, `SPORE`, `SAND`, `MIST`, `GAS_BOIL`, `VOID`. Step count, jitter and density curve are sliders. |
| `vfx/GroundField.js` | A ground quad whose fragment shader works in **metres from the anchor**, with a mode enum. Generalises the snare's field and the aim/zone indicators. Modes: `PLATE`, `RUNE`, `POCK`, `RUT`, `WET`, `PUSTULE`, `FUNNEL`, `SCOUR`, `LATTICE`, `POOL`. Re-scales live; never captures its radius. |
| `vfx/Tube.js` | The parametric tube, generalising `BeamMaterial`. Path modes `STRAIGHT`, `WHIP`, `FUNNEL`, `VINE`, `ARC`. Three-layer core/sheath/halo weighting is kept — it is the reason the beam reads as solid. |
| `vfx/Shell.js` | Expanding shells, domes, cones and ring trains. Extends `BurstSphere` with new modes rather than replacing it. |
| `vfx/Projectile.js` | One or many travelling bodies with position/orientation from a parametric flight (`LINE`, `ARC`, `ROLL`, `FALL`, `HOMING`, `LISSAJOUS`), each optionally carrying a `RibbonTrail`. Staggered arrival times come from a spatial hash so a zone fills deterministically per seed. |
| `vfx/Distortion.js` | **Writes to the distortion buffer, which nothing currently uses.** Emitters: `HEAT`, `LENS` (radial 1/r² gravity lens), `SHOCK` (travelling ring), `BLADE` (thin plane), `REFRACT`. This closes a documented rough edge and is the single biggest new capability in the expansion — several abilities are mostly made of it. |
| `vfx/ShatterField.js` | Instanced fragments that inherit a velocity and tumble, with an optional screen-space sample so a shard can show the scene behind it. Used for breaking ice, glass, prisms and time. |
| `vfx/Swarm.js` | Instanced agents on a shader-evaluated flock: cohere to a moving lead, separate on a hash lattice, bank into turns. Silhouettes: `BIRD`, `LEAF`, `CARD`, `DROPLET`, `MOTE`. |
| `vfx/ArcNetwork.js` | Node graph + segment lighting for chained discharges. Nodes are unitless scatter fractions; every metre resolves per frame. |
| `vfx/Portal.js` | A disc/slit with a parallax interior, a fracture rim and a depth-correct edge. |
| `vfx/LiquidSurface.js` | A live heightfield plane with flow-mapped crust, used for lava, blood and water. Ripples are injected by impacts and decay analytically. |
| `vfx/Curtain.js` | Vertical sheets with a travelling vertex ripple and a height-dependent emission curve. Rain, aurora, light shafts. |

An ability may still write a bespoke material when its trick genuinely needs one — that is how the
first six were built and it is why they are good. The library is a floor, not a ceiling.

---

## 6 · The ability template

```js
import { Vector3 } from 'three';
import { Ability } from '../Ability.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { frame } from '../../core/FrameUniforms.js';

const _pos = new Vector3();          // module-scope scratch — I3
const _emit = {};

export class RimeAbility extends Ability {
  constructor(context) { super('rime', context); }

  createShaders() { /* build meshes + materials once */ }
  createParticles() { /* ctx.particles.get('rime.mist', {...}) */ }

  get impactDuration() { return settings.rime.lifetime * settings.global.lifetime; }
  get fadeDuration()   { return settings.rime.fadeTime; }
  get instanceCount()  { return this._live; }

  onSpawn()          { /* reset emitters, roll the seed, sync once */ }
  onTravel(dt)       { /* resolve everything from settings, emit, sync */ }
  onImpact()         { /* the one-shot */ }
  onFade(dt, t)      { /* t: 0..1 hold, 1..2 blow-out */ }
  onDestroy()        { /* release; leave reusable */ }
  dispose()          { /* geometry + material dispose; super.dispose() */ }
}
```

Particle system names are namespaced `"<id>.<role>"` so systems are shared per ability across
pooled instances and never collide.

---

## 7 · Verification — the headless harness

`npm run check` runs `scripts/check.mjs` in Node. It does not need WebGL: three.js constructs
geometry, materials and scene graphs on the CPU, and every VFX system in this project defers GL to
render time.

The harness:

1. imports the registry and **every** settings module and ability class;
2. asserts each block has `range`, `minRange`, `speed`, `cooldown`, `castAnim`, plus `zoneRadius`
   for `CastShape.ZONE`;
3. **statically cross-checks every `settings.<id>.<key>` / `c.<key>` reference in an ability file
   against its settings block** — the single most common failure mode when writing these, and the
   one that produces silent `NaN` geometry rather than an error;
4. constructs each ability against a mock context (real `ParticleEngine`, `DecalSystem`,
   `BurstSystem`, `FissureSystem`, `LightPool` on a bare `Scene`; stub `shake` / `flash`);
5. spawns it, ticks 240 frames at 1/60 across all phases, and fails on any exception, any `NaN` in
   a written attribute, any position beyond a sanity radius, and any allocation-shaped mistake it
   can see;
6. re-runs the tick loop **with `dt = 0`** after mutating a random slider, and fails if nothing in
   the ability's uniforms changed — a direct test of invariant **I1**;
7. checks the glyph map and the editor schema cover every registered id.

`npm run check` must pass before any ability is considered done. `npm run build` must also pass.

---

## 8 · Performance at fifty

- Ability classes and their pools are **lazy** — nothing is constructed until an id is selected.
- `renderer.compileAsync()` at boot only sees what is in the scene; selecting an ability for the
  first time warms it asynchronously behind the HUD's cooldown sweep.
- Particle systems are created on first use by `ParticleEngine.get()` and shared. Fifty abilities
  × four systems each would be two hundred instanced meshes if they were all built at boot; they
  are not, and abilities should reuse a shared system (`shared.smoke`, `shared.dust`,
  `shared.sparks`) wherever the look does not need its own gradient.
- The 4-cast concurrency cap and the 6-light pool are unchanged.

---

## 9 · Definition of done, per ability

1. `src/abilities/<school>/<Name>Ability.js` — the class, with a doc comment that explains **the
   trick** the way the existing six do.
2. `src/config/abilities/<id>.js` — settings block + editor schema.
3. A sigil in `src/ui/glyphs/<school>.js`.
4. A registry entry.
5. `npm run check` passes, including the paused-slider test.
6. The README's roster table has a row for it.

An ability that renders but violates **I1** is not done. An ability that looks like another slot
with different colours is not done either — see the "THE TRICK" line in its roster entry.
