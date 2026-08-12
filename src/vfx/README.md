# `src/vfx` — the tech library

**Twenty-six shared modules** — twenty-four renderers and toolkits plus two files of shared
plumbing — that exist so an ability is *configuration plus beats* rather than a new renderer. They
are a floor, not a ceiling: an ability may still write a bespoke material when its trick genuinely
needs one — that is how the first six were built and it is why they are good.

This file was written by ten agents at once and then reconciled, twice. Every signature in the
**[API reference](#api-reference)** below has been read back off the source, not copied from a
report; where a section further down disagrees with the reference, the reference is right.

**Every module in here obeys the invariants in `docs/EXPANSION.md` §0.** In particular:

- **I1** — a module never snapshots a dimension. It is handed a **live settings or params object**
  every frame and re-resolves every metre, radian and second from it, including on a zero-length
  frame. The test is always the same: pause with **P**, drag a slider, and the standing effect must
  change.
- **I3** — nothing in a frame path allocates. Module-scope scratch at the top of each file.
- **I4** — draw calls are counted, and the index table below states every module's cost.

---

## The three conventions

Three things vary between modules, and knowing which is which up front saves reading the source.
None of them is an accident, and none of them is going to be unified — the reasons are given.

### 1 · How you attach it

**Parent-first** — `new X(parent, options)`. The module builds its meshes and adds them to `parent`
itself, and may own several. You never see the meshes.

> `GrowthField` · `ShatterField` · `GroundField` · `FilamentPaths` · `ArcNetwork` · `Projectile` ·
> `Swarm` · `Caustics` · `LightShaft` · `BrushStroke` · `InkDiffusion` · `FoldMesh` ·
> `DissolveField` · `GhostRig` · `ColonySwarm` · `WebGraph` · `LatticeGrowth` · `PlateShell`

**Options-only** — `new X(options)`, then you add its node to your group yourself. These are the
modules that own exactly one visible thing and hand it to you.

> `Tube` (`.group`) · `Shell` (`.group`) · `VolumeHull` (`.mesh`) · `DistortionField` (`.object3D`)
> · `Portal` (`.object3D`) · `LiquidSurface` (`.object3D`) · `Curtain` (`.object3D`) ·
> `LensFlare` (`.object3D`) · `Mirror` (`.object3D`)

**Neither** — three modules attach nothing. `HardSurface` is a toolkit of generators and solvers,
`Dissolve`'s two patch modes compose into a material you already own, and `SceneHooks` is a
singleton ledger over the scene itself. `quads.js` and `prefixedBlock.js` are shared plumbing.

### 2 · How it reads settings

**Canonical names.** The module is handed a params object each frame and reads `p.someName ??
default`. Fill a scratch object from `settings[id]` (needed when you fold in `settings.global`
multipliers), or — if your block happens to use the canonical names — pass the settings block
itself, which makes breaking I1 impossible. Each of these modules exports a `xxxParams()` returning
every canonical key with its default and a unit comment; that function is the key list.

> `GrowthField` · `ShatterField` · `GroundField` · `FilamentPaths` · `ArcNetwork` · `Projectile` ·
> `Swarm` · `LiquidSurface` · `Curtain` · `DistortionField` · `Portal` · `Caustics` ·
> `LightShaft` · `LensFlare` · `Mirror` · `BrushStroke` · `InkDiffusion` · `FoldMesh` ·
> `Dissolve` · `TimeControl` · `HardSurface` · `Colony`

`SceneHooks` is the one module with neither convention: it is driven by **method calls on a
borrowed token** rather than by a params bag, because a hook is held over several frames by one
owner and a bag has nowhere to put "who is asking".

**Prefixed names.** The module is handed `settings[id]` and reads `c[keys.radius]` where
`keys.radius` is `'tubeRadius'`. Uglier, and it exists because these three are the modules an
ability plausibly wants **two** of: Pyroclasm carries an ash hull and a flame hull, and bare names
collide silently the moment it does — the second hull just quietly drives the first one's radius.
Each exports `xxxDefaults(prefix, mode, overrides)` to spread into the block and
`xxxSchema(prefix, mode)` to spread into the editor schema, and warns once naming every missing key.

> `Tube` · `Shell` · `VolumeHull`  — shared plumbing in [`prefixedBlock.js`](#prefixedblockjs)

### 3 · What its clock argument means

Most `update()` methods take `now` — **the ability's `age` in seconds**, the same clock the
records' timestamps are in. A handful take something else, and the harness will not catch you
getting it wrong:

| module | first argument | note |
| --- | --- | --- |
| `ArcNetwork.update(dt, …)` | **`dt`**, not `now` | it integrates a cursor along the graph |
| `Swarm.update(_now, …)` | ignored | the flock is driven by `frame.uTime` in the shader |
| `Curtain.update(_now, …)` | ignored | same |
| `ColonySwarm.update(_now, …)` | ignored | inherits `Swarm`'s; calls `super.update()` first |
| `WebGraph.update(_now, …)` | ignored | same reason |
| `BrushStroke.update(_now, p)` | ignored | `p.progress` is the only beat a stroke has |
| `FoldMesh.update(_now, p)` | ignored | `p.fold` is the beat |
| `Caustics.update(p)` | **no clock** | takes params only; reads `frame.uTime` itself |
| `LightShaft.update(p)` | **no clock** | same |
| `LensFlare.update(p)` / `Mirror.update(p)` | **no clock** | same |
| `Tube.sync` / `Shell.sync` | no clock | time arrives on the `state` object as `state.time` |
| `VolumeHull.sync(c, g)` | no clock | reads `frame.uTime` itself |
| `LatticeGrowth` · `PlateShell` · `InkDiffusion` · `DissolveField` | `now` = the ability's age | the ordinary case, listed because their siblings are not |

---

## Index

| module | what it is | draw calls | attach | settings |
| --- | --- | --- | --- | --- |
| [`GrowthField.js`](#growthfieldjs) | Instanced procedural geometry erupting along a line or across a zone. Generalises `IceAbility`'s crystal field. | `variants` (3) | parent | canonical |
| [`ShatterField.js`](#shatterfieldjs) | Instanced fragments that inherit a velocity and tumble, with an optional screen-space scene sample. | `variants` (2) | parent | canonical |
| [`GroundField.js`](#groundfieldjs) | A ground quad whose fragment shader works in metres from the anchor. Ten modes. | 1 | parent | canonical |
| [`FilamentPaths.js`](#filamentpathsjs) | Instanced ribbon strip with pluggable parametric paths. Generalises `LightningMaterial` + `SnareMaterial`. | 2 | parent | canonical |
| [`ArcNetwork.js`](#arcnetworkjs) | Node graph + segment lighting for chained discharges. | 0–2 (shares a strip) | parent | canonical |
| [`Projectile.js`](#projectilejs) | One or many travelling bodies on a parametric flight, each optionally carrying a trail. | 2 (1 without trail) | parent | canonical |
| [`Swarm.js`](#swarmjs) | Instanced agents on a shader-evaluated flock. | 1 | parent | canonical |
| [`Tube.js`](#tubejs) | The parametric tube. Generalises `BeamMaterial`. | 3 | `.group` | prefixed |
| [`Shell.js`](#shelljs) | Expanding shells, domes, cones and ring trains. Extends `BurstSphere`. | 1 | `.group` | prefixed |
| [`VolumeHull.js`](#volumehulljs) | Raymarched volume inside a proxy hull. Generalises `VolumetricFireMaterial`. | 1 | `.mesh` | prefixed |
| [`Distortion.js`](#distortionjs) | Writes to the distortion buffer. `HEAT`, `LENS`, `SHOCK`, `BLADE`, `REFRACT`. | 1 per emitter | `.object3D` | canonical |
| [`Portal.js`](#portaljs) | A disc/slit with a parallax interior, a fracture rim and a depth-correct edge. | 1 | `.object3D` | canonical |
| [`LiquidSurface.js`](#liquidsurfacejs) | A live heightfield plane with flow-mapped crust. | 1 | `.object3D` | canonical |
| [`Curtain.js`](#curtainjs) | Vertical sheets with a travelling vertex ripple and a height-dependent emission curve. | 1 (2 with `floor`) | `.object3D` | canonical |
| [`Caustics.js`](#causticsjs--the-net-of-light-a-surface-throws-on-the-floor) | A caustic net on the floor, folded out of a pluggable height field. `SCROLL` / `WAVE` / `CUSTOM`. | 1 | parent | canonical |
| [`LightShaft.js`](#lightshaftjs--light-in-air-integrated-along-the-view-ray) | Volumetric shafts with a real phase function, a depth-clamped integral and the ground band it implies. | 1 | parent | canonical |
| [`LensFlare.js`](#lensflarejs--the-artefact-that-belongs-to-the-camera) | A screen-space flare — core, starburst, anamorphic streak, iris ring, eight ghosts — occlusion-tested against the depth prepass in the vertex shader. | 1 | `.object3D` | canonical |
| [`Mirror.js`](#mirrorjs--a-planar-surface-that-reflects-the-real-scene) | A planar reflector: an oblique-frustum render of `LAYER.WORLD` into its own target, with a roughness blur and a per-frame budget. | 1 + one nested `render()` | `.object3D` | canonical |
| [`BrushStroke.js`](#brushstrokejs--a-loaded-brush-not-a-ribbon-with-a-noise-mask) | Swept-ellipse strokes laid by bristles that each carry their own ink load and run dry from the outside in. | 1 | `.object3D` | canonical |
| [`InkDiffusion.js`](#inkdiffusionjs--ink-spreading-on-the-floor-unstably) | Ink blooming on the floor: five noise octaves admitted as the front passes them, plus bounded-Pareto satellites. `BLOOM` / `SPLATTER` / `WASH`. | 1 | `.object3D` | canonical |
| [`FoldMesh.js`](#foldmeshjs--paper-that-folds-without-stretching) | A creased sheet folded from one slider by a product of rigid motions, plus a scroll unrolling off a spool. | 1 | parent | canonical |
| [`Dissolve.js`](#dissolvejs--three-ways-for-matter-to-stop-being-there) | `VOXEL` and `EROSION` as a material patch; `GRANULAR` — a heap at its angle of repose — as a mesh. | 0 (patch) / 1 (heap) | parent | canonical |
| [`TimeControl.js`](#timecontroljs--recording-the-caster-and-bending-everyone-elses-clock) | The shared time-region field (stasis / rewind / slow), a skeletal recorder and ghost rig, and the reversible-clock helpers. | 0 (field) / 1 per ghost | pool + parent | canonical |
| [`SceneHooks.js`](#scenehooksjs--the-module-that-changes-the-world) | The borrow/restore ledger for the six pieces of the **world** an ability may edit: key light, grade, floor ageing, hole, gravity, disrupt. | 0 (2 with `HOLE`) | singleton | tokens |
| [`HardSurface.js`](#hardsurfacejs--the-machined-half-of-the-material-vocabulary) | Six machined geometry generators (involute gear, piston, sawblade, plate, bolt, anvil), brushed anisotropic steel with a blackbody ramp, and the gear-train and grinding-spark solvers. | 0 (a toolkit) | — | canonical |
| [`Colony.js`](#colonyjs--many-small-things-behaving-as-one) | Four Hive renderers: an SDF-targeted swarm (extends `Swarm`), a web graph with its membrane, hex lattice growth, and a Voronoi plate dome. | 1 / 2 / 1 / 1 | parent | canonical |
| [`quads.js`](#quadsjs) | The two unit quads — flat and upright — that every quad-backed module in the library draws on. No renderer. | — | — | — |
| [`prefixedBlock.js`](#prefixedblockjs) | The shared plumbing behind prefixed settings blocks. No renderer. | — | — | — |

### Contents

1. [The three conventions](#the-three-conventions)
2. [Index](#index)
3. [API reference](#api-reference) — every signature, verified against source
4. [Budgeting a cast](#budgeting-a-cast)
5. [Verifying your module](#verifying-your-module)
6. [Traps that have already cost someone a day](#traps-that-have-already-cost-someone-a-day)
7. The long-form section for each module, in index order — what it draws, why it is built the way
   it is, and **the one rule** for using it well:
   [GrowthField](#growthfieldjs--things-that-come-out-of-the-ground) ·
   [ShatterField](#shatterfieldjs--things-that-come-apart) ·
   [GroundField](#groundfieldjs--one-quad-that-thinks-in-metres) ·
   [FilamentPaths](#filamentpathsjs--every-filament-in-the-project) ·
   [ArcNetwork](#arcnetworkjs--a-discharge-that-hops-instead-of-travelling) ·
   [Projectile](#projectilejs--things-that-travel) ·
   [Swarm](#swarmjs--things-that-flock) ·
   [Tube](#tubejs--the-parametric-tube) ·
   [Shell](#shelljs--the-standing-half-of-the-burst-vocabulary) ·
   [the distortion pass](#how-the-distortion-pass-works-now) ·
   [Distortion](#distortionjs--the-pass-that-used-to-do-nothing) ·
   [Portal](#portaljs--a-hole-not-a-decal) ·
   [VolumeHull](#volumehulljs--a-raymarched-volume-inside-a-proxy-hull) ·
   [LiquidSurface](#liquidsurfacejs--a-heightfield-that-knows-how-fast-it-is-moving) ·
   [Curtain](#curtainjs--vertical-sheets-of-light-in-air) ·
   [SceneHooks](#scenehooksjs--the-module-that-changes-the-world) ·
   [LensFlare](#lensflarejs--the-artefact-that-belongs-to-the-camera) ·
   [Mirror](#mirrorjs--a-planar-surface-that-reflects-the-real-scene) ·
   [Caustics](#causticsjs--the-net-of-light-a-surface-throws-on-the-floor) ·
   [LightShaft](#lightshaftjs--light-in-air-integrated-along-the-view-ray) ·
   [FoldMesh](#foldmeshjs--paper-that-folds-without-stretching) ·
   [Dissolve](#dissolvejs--three-ways-for-matter-to-stop-being-there) ·
   [TimeControl](#timecontroljs--recording-the-caster-and-bending-everyone-elses-clock) ·
   [Colony](#colonyjs--many-small-things-behaving-as-one) ·
   [BrushStroke](#brushstrokejs--a-loaded-brush-not-a-ribbon-with-a-noise-mask) ·
   [InkDiffusion](#inkdiffusionjs--ink-spreading-on-the-floor-unstably) ·
   [the anti-glow contract](#the-anti-glow-contract) ·
   [HardSurface](#hardsurfacejs--the-machined-half-of-the-material-vocabulary)

---

## API reference

Read back off the source. Defaults shown are the real ones. `v3` is a `THREE.Vector3`; `out` is
always a caller-supplied `Vector3` that is written into and returned, so nothing here allocates.

### `GrowthField.js`

```js
import { GrowthField, GrowthLayout, GrowthEmerge, growthParams, patchGrowthMaterial }
  from '../../vfx/GrowthField.js';

GrowthLayout = { LINE: 0, ZONE: 1 }
GrowthEmerge = { PUSH: 0, SCALE: 1 }
growthParams() -> object                        // every canonical key, default + unit comment

new GrowthField(parent, { geometry, material, shape = null, variants = 3, capacity = 288,
                          layer = LAYER.WORLD, renderOrder = 2,
                          castShadow = true, receiveShadow = true })
  // `geometry` is a FACTORY: (variant, shape) => BufferGeometry, unit-space —
  // footprint r <= 0.5 on y = 0, tip at y = 1. Throws if it is not a function.
  // `material` is required and is the ABILITY'S; dispose() does not touch it.

field.count            field.drawCalls        // === variants
field.meshes           field.records          field.material     field.factory
field.onBreach = (index, position, radius, height) => {}   // assign ONCE at construction (I3)
field.isFullyTriggered

field.plant(count, clusterShare = 0) -> number          // the only dice roll
field.clear()
field.syncGeometry(shape) -> boolean                    // Float64Array hash; rebuilds on change
field.triggerUpTo(now, limit, stagger, frontBias = 1, includeCluster = false)
field.triggerRadial(now, limit, stagger, invert = false, includeCluster = true)
field.triggerAll(now, stagger)
field.triggerIndex(now, index, delay = 0)
field.update(now, p, retract = 0)
field.positionOf(index, p, out) -> v3     field.tipOf(index, p, out) -> v3
field.heightOf(index, p) -> metres        field.radiusOf(index, p) -> metres
field.emergenceOf(index, now, p) -> 0..1
field.dispose()                                         // geometry only; material is yours

patchGrowthMaterial(material, { environment, uniforms, common, vertex, fragment }) -> material
  // varyings the patch provides: vGrowLocal, vGrowWorld, vGrowSeed, vGrowBirth
  // per-instance attributes: aSeed, aBirth
```

There is **no `object3D`** — the field owns `variants` meshes and adds them to `parent` itself.

### `ShatterField.js`

```js
import { ShatterField, ShatterLayout, shatterParams } from '../../vfx/ShatterField.js';

ShatterLayout                                   // re-export of GrowthLayout
shatterParams() -> object

new ShatterField(parent, { geometry, variants = 2, capacity = 192, material = null,
                           additive = false, depthWrite = true, layer = LAYER.VFX,
                           renderOrder = 6, castShadow = false, receiveShadow = false })
  // `geometry` is a FACTORY, as above. Throws if it is not a function.
  // Owns a ShaderMaterial unless you pass one; yours must consume aSeed / aLife.

shatter.count          shatter.drawCalls       // === variants
shatter.uniforms       shatter.material

shatter.burst(now, count, along = 1, lateral = 0) -> number
shatter.clear()
shatter.sync(look)                              // look/colour block, separate from update()
shatter.setSceneTexture(texture | null)
shatter.update(now, p) -> live count
shatter.positionOf(index, now, p, out) -> v3
shatter.dispose()
```

### `GroundField.js`

```js
import { GroundField, GroundMode, GROUND_MODE_NAMES, groundFieldParams }
  from '../../vfx/GroundField.js';

GroundMode = { PLATE:0, RUNE:1, POCK:2, RUT:3, WET:4,
               PUSTULE:5, FUNNEL:6, SCOUR:7, LATTICE:8, POOL:9 }
GROUND_MODE_NAMES : string[10]
groundFieldParams() -> object

new GroundField(parent, { mode = GroundMode.PLATE, marks = 12, additive = false,
                          depthTest = true, layer = LAYER.VFX,
                          renderOrder = null, name = null })
  // `mode` is a #define — it cannot change after construction. `additive` can, every frame.

field.object3D -> Mesh    field.drawCalls // === 1
field.mode                field.marks     field.markCount
field.setVisible(visible)
field.setAdditive(additive)                     // blend state only, no recompile
field.mark(x, z, time, strength = 1) -> Vector4 // x,z are FRACTIONS of the radius, never metres
field.clearMarks()
field.update(p)
field.dispose()
```

### `FilamentPaths.js`

```js
import { FilamentPaths, PathMode, FilamentPass, filamentLook,
         MAX_FILAMENT_ROLES, MAX_CHAIN_NODES } from '../../vfx/FilamentPaths.js';

PathMode = { LINE:0, HELIX:1, ORBIT:2, MEANDER:3, RIM:4,
             CHAIN:5, LINK:6, SPIRAL_IN:7, CRACK:8 }
FilamentPass = { CORE: 0, GLOW: 1 }
MAX_FILAMENT_ROLES = 4       MAX_CHAIN_NODES = 12
filamentLook() -> object                        // canonical look keys + defaults

new FilamentPaths(parent, { samples = 72, capacity = 48, renderOrder = 11, layer = LAYER.VFX })

paths.object3D    paths.drawCalls // === 2      paths.liveCount    paths.visible (get/set)
paths.role(i) -> Role                           // i in 0..3
paths.setNodeCount(n)     paths.nodeCount
paths.setNode(i, along, lateral, lift)          // unitless fractions
paths.nodePoint(roleIndex, i, out) -> v3
paths.sync(look, fade = 1, seed = 0)            // OVERWRITES uCount — set counts every frame
paths.clear()     paths.dispose()

// Role — every setter is positional and returns nothing; all of it is per-frame.
role.count = n                                  role.retire()
role.style(kink, width, dim, groundDamp)
role.ends(fadeStart, fadeEnd, taperStart, taperEnd)
role.draw(progress, tipLength, floorY, tipGlow) // progress defaults to 2 == "drawn whole"
role.line(from, to, sag, spreadNear, spread, spreadCurve, twist, twistSpeed, converge)
role.helix(from, to, radius, radiusEnd, turns, spin, sag, phaseSpread, taperCurve)
role.orbit(centre, pole, radius, arc, spin, wobble, tilt, tiltSpread, radiusJitter)
role.meander(centre, up, inner, reach, curve, wander, arch, hug, spin)
role.rim(centre, up, radius, span, speed, lift, jitter, hug, phase)
role.chain(from, to, scatter, lift, sag, bow, lit, hold, overlap, tip)
role.link(from, to, slack, curve, swing, swingSpeed, taut, spread)
role.spiralIn(from, to, radius, radiusEnd, turns, spin, curve, phaseSpread, wobble)
role.crack(from, to, angle, lengthFrac, depthFalloff, spread, start, sag, forkBias)
```

### `ArcNetwork.js`

```js
import { ArcNetwork, arcNetworkParams } from '../../vfx/ArcNetwork.js';

arcNetworkParams() -> object                    // graph + hops + clock; also carries filamentLook()

new ArcNetwork(parent, { paths = null, role = 0, samples = 96, capacity = 24,
                         renderOrder, layer })
  // pass { paths: existing, role: n } to share another FilamentPaths strip —
  // chain + spikes + rim then cost two draw calls in total, not six.

net.from   net.to                               // Vector3; the caller writes these each frame
net.onNode = (index, position, count) => {}
net.reset(seed)      net.reseed(seed)
net.update(dt, p, fade = 1)                     // NOTE: dt, not now
net.nodePoint(i, out) -> v3
net.clear()          net.dispose()
net.paths  net.object3D  net.drawCalls  net.nodeCount  net.segments
net.progress  net.arrived  net.firedCount  net.cursor
```

### `Projectile.js`

```js
import { Projectile, FlightMode, Stagger, spatialStagger, projectileParams }
  from '../../vfx/Projectile.js';

FlightMode = { LINE, ARC, ROLL, FALL, HOMING, LISSAJOUS, VOLLEY }   // string enum
Stagger    = { AUTO, NONE, RIPPLE, HASH }                           // string enum
spatialStagger(x, z, cell, seed) -> 0..1
projectileParams() -> object

new Projectile(parent, { geometry, material, shapeKey = null, capacity = 48, trail = true,
                         trailNodes = 28, trailAdditive = true, layer = LAYER.WORLD,
                         renderOrder = 2, castShadow = false })
  // The options object has NO default — `new Projectile(parent)` throws.
  // `geometry` may be a factory (preferred: the module owns and dresses it) or a geometry.

body.count   body.drawCalls // 2, or 1 with trail:false   body.trailUniforms
body.arrivals : Int32Array   body.arrivalCount            // crossed tau = 1 THIS frame
body.contact : Vector3       body.contactLoad             // ROLL -> GroundField(RUT)
body.roll(seed = Math.random() * 100)     body.reset()
body.setBasis(origin, direction, side, length)
body.setTrailColors(a, b, c, d)           body.syncGeometry()
body.update(now, params)
body.landPoint(index, out)   body.pointAt(index, tau, out)
body.headingAt(index, tau, out)           body.slotPosition(slot, out)
body.dispose()
```

Read `arrivals` / `arrivalCount` **immediately** after `update()`: the flag clears again if a
slider puts a body back in the air, which is what makes a paused drag re-fire it correctly.

### `Swarm.js`

```js
import { Swarm, Silhouette, LeadPath, swarmParams } from '../../vfx/Swarm.js';

Silhouette = { BIRD:0, LEAF:1, CARD:2, DROPLET:3, MOTE:4 }
LeadPath   = { POINT:0, LINE:1, ORBIT:2 }
swarmParams() -> object

new Swarm(parent, { capacity = 256, silhouette = Silhouette.BIRD,
                    additive = true, renderOrder = 12 })

swarm.count   swarm.drawCalls // === 1   swarm.uniforms
swarm.roll(seed = Math.random() * 100)   swarm.reset()
swarm.setBasis(origin, direction, side, length)
swarm.setColors(a, b, c, d)              // '#rrggbb' or THREE.Color; memoised, no per-frame alloc
swarm.update(_now, params)               // first argument is IGNORED
swarm.leadPoint(out) -> v3
swarm.dispose()
```

### `Tube.js`

```js
import { Tube, TubePath, TubeLayer, TUBE_PATH_NAMES,
         tubeDefaults, tubeKeys, tubeSchema, createTubeMaterial } from '../../vfx/Tube.js';

TubePath  = { STRAIGHT:0, WHIP:1, FUNNEL:2, VINE:3, ARC:4 }
TubeLayer = { CORE:0, SHEATH:1, HALO:2 }
TUBE_PATH_NAMES : string[5]
tubeDefaults(prefix = 'tube', path = TubePath.STRAIGHT, overrides = {}) -> 79-key fragment
tubeKeys(prefix = 'tube')       tubeSchema(prefix, path)
createTubeMaterial(layer = TubeLayer.CORE, path = TubePath.STRAIGHT)

new Tube({ path = TubePath.STRAIGHT, prefix = 'tube', nodes = 96, sides = 26, renderOrder = 11 })
  // WHIP and ARC facet visibly below ~80 nodes; a straight column is fine at 48.

tube.group   tube.materials{core,sheath,halo}   tube.meshes{...}   tube.keys   tube.geometry
tube.drawCalls // === 3      tube.visible (get/set)
tube.sync(c, state, g = settings.global)
  // state = { origin, target, side, progress, fade, widthFade, seed, time, grow, snapAge }
tube.radiusAt(t) -> metres   // THE profile fn — a dust skirt or scour uses this, never its own maths
tube.pointAt(t, out) -> v3   tube.tangentAt(t, out) -> v3
tube.span    tube.skirtRadius    tube.mouthRadius
tube.tipPoint : Vector3      tube.tipSpeed : m/s     tube.waveSpeed : m/s
tube.crack = { fired, point, speed, at }    // recomputed by sync(); poll immediately after
tube.dispose()
```

### `Shell.js`

```js
import { Shell, ShellMode, SHELL_MODE_NAMES, shellDefaults, shellKeys, shellSchema,
         createShellMaterial, BurstMode, BurstSystem } from '../../vfx/Shell.js';
         // BurstMode / BurstSystem are re-exports of ../effects/BurstSphere.js

ShellMode = { DOME:0, CONE:1, RING_TRAIN:2, SUNDISC:3, PRESSURE:4 }
SHELL_MODE_NAMES : string[5]
shellDefaults(prefix = 'shell', mode = ShellMode.DOME, overrides = {}) -> 44-key fragment
shellKeys(prefix = 'shell')     shellSchema(prefix, mode)     createShellMaterial(mode)

new Shell({ mode = ShellMode.DOME, prefix = 'shell', nodes = 48, sides = 48,
            rings = 24, segments = 96, renderOrder = 14 })

shell.group   shell.mesh   shell.material   shell.keys   shell.geometry
shell.drawCalls // === 1     shell.visible (get/set)     shell.instanceCount
shell.sync(c, state, g = settings.global)
  // state = { origin, axis, side, span, t, fade, seed }
shell.radius    shell.span    shell.nodeSpacing    shell.nodeCount
shell.standingAt(s)      shell.nodePosition(i, out)      shell.resonantSpacing(n)
shell.dispose()
```

### `VolumeHull.js`

```js
import { VolumeHull, HullShape, Medium, HULL_NAMES, MEDIUM_NAMES, VOLUME_HULL_KEYS,
         VOLUME_SAMPLE_BUDGET, volumeHullDefaults, volumeHullSchema,
         disposeVolumeHullGeometry } from '../../vfx/VolumeHull.js';

HullShape = { BOX:0, CYLINDER:1, CONE:2, DOME:3, SPHERE:4 }
Medium    = { FLAME:0, SMOKE:1, ASH:2, SPORE:3, SAND:4, MIST:5, GAS_BOIL:6, VOID:7 }
VOLUME_SAMPLE_BUDGET = 20e6
volumeHullDefaults(prefix, medium = Medium.SMOKE, overrides = {}) -> prefixed sub-block
volumeHullSchema(prefix, { label, only })       disposeVolumeHullGeometry()  // app teardown

new VolumeHull({ hull, medium, prefix = 'volume', maxSteps = 48, shadow,
                 additive = false, renderOrder = 12, seed })

hull.mesh   hull.material   hull.steps   hull.shadowTaps   hull.hull   hull.medium   hull.prefix
hull.place(position, direction = null) -> this   // yaw only; hull local +Z is the heading
hull.setSize(x, y = x, z = x) -> this            // HALF-EXTENTS in metres, every frame
hull.setFade(k) -> this                          // 0 hides the mesh
hull.sync(c, g) -> this                          // c = settings[id], g = settings.global
hull.cost(coveredPixels) -> field samples/frame
hull.dispose()
```

Scale with `setSize()` and **never** `mesh.scale`, or the march's `t` stops meaning metres. Reads
`settings.global.volumeQuality` (defaults to 1 if absent) to scale steps and shadow taps.

### `Distortion.js`

```js
import { DistortionField, DistortionMode, DistortionFacing } from '../../vfx/Distortion.js';

DistortionMode   = { HEAT:0, LENS:1, SHOCK:2, BLADE:3, REFRACT:4 }
DistortionFacing = { BILLBOARD, UPRIGHT, GROUND, WORLD }

new DistortionField({ mode = DistortionMode.HEAT, facing, geometry = null,
                      edge = false, renderOrder = 0, name })

field.object3D -> Mesh          field.visible (get/set)   // retains/releases the writer counter
field.setAnchor(v3)             field.setAnchorXYZ(x, y, z)
field.setBasis(along, up)       // WORLD facing; no matrix is touched
field.update(p)                 // every key falls back, so update({}) is legal
field.dispose()
```

Magnitudes are **screen fractions, not metres** (`perspective`/`perspectiveRef` is the opt-out).
Never multiply `global.distortion` or `post.distortion` into `strength` — the pass applies both,
once. Toggle `field.visible` rather than hiding the parent group, or the pass runs all session.

### `Portal.js`

```js
import { Portal } from '../../vfx/Portal.js';

new Portal({ billboard = false, writeDepth = false, renderOrder = 6, name = 'Portal' })

portal.object3D   portal.visible (get/set)
portal.setPlacement(anchor, along, up)
portal.update(p)                                // every key falls back
portal.dispose()
```

### `LiquidSurface.js`

```js
import { LiquidSurface, LiquidMode, liquidParams } from '../../vfx/LiquidSurface.js';

LiquidMode = { POOL: 0, WAVE: 1 }
liquidParams() -> object

new LiquidSurface({ segments = 96, mode = LiquidMode.POOL, depthWrite = true,
                    doubleSide = true, renderOrder = 3, name = 'LiquidSurface' })

s.object3D   s.uniforms   s.drawCalls // === 1   s.visible (get/set)   s.mode (get/set)
s.setPlacement(anchor, along, up)
s.ripple(u, v, strength = 1, now?) -> slot          // u,v are FRACTIONS in -1..1
s.rippleAtWorld(position, strength = 1, now?) -> slot  // call AFTER update() this frame
s.clearRipples()    s.reset()
s.update(now, p)
s.lipPosition(p, out, across = 0) -> v3      s.lipHeight(p, across = 0) -> metres
s.dispose()
```

Eight ripple slots; `ripple()` evicts the oldest. Records are `(u, v, born, strength)` — fractions
and a timestamp, nothing else. Fill-heavy: one per screen.

### `Curtain.js`

```js
import { Curtain, CurtainMode, CurtainLayout, curtainParams } from '../../vfx/Curtain.js';

CurtainMode   = { RAIN: 0, AURORA: 1, SHAFT: 2 }
CurtainLayout = { LINE: 0, RING: 1, SCATTER: 2 }
curtainParams() -> object

new Curtain({ capacity = 16, segmentsX = 32, segmentsY = 16, mode = CurtainMode.AURORA,
              layout = CurtainLayout.LINE, floor = false, renderOrder = 8, name = 'Curtain' })

c.object3D -> Group    c.uniforms    c.drawCalls // 1, or 2 with floor    c.instanceCount
c.visible (get/set)    c.mode (get/set)    c.layout (get/set)
c.setPlacement(anchor, along, up)
c.roll(seed = Math.random() * 100)    c.reset()
c.update(_now, p)                     // first argument is IGNORED
c.sheetPoint(index, p, out, across = 0, height = 0) -> v3
c.dispose()
```

`alphaCurve` must differ from `emissionCurve` (defaults 2.4 vs 0.7) or it is a hanging ribbon.
`stormwall` passes the cast's **side** vector as `along`; shafts pass a negated `frame.uLightDir`
as `up`.

### `SceneHooks.js`

```js
/* SceneHooks.js ─ a ledger, 0 draw calls (2 while HOLE is held) ─ singleton ─ tokens */
import { sceneHooks, Hook, disruptUniforms, disruptGLSL, gravityUniforms, gravityGLSL,
         patchAgeMaterial } from '../../vfx/SceneHooks.js';

Hook = { KEY_LIGHT:'keyLight', GRADE:'grade', AGE:'age', HOLE:'hole',
         GRAVITY:'gravity', DISRUPT:'disrupt' }

sceneHooks.acquire(hook, owner) -> token   // never null for a real hook; owner is `this`
sceneHooks.isHeld(hook) · driver(hook) · heldCount
sceneHooks.reclaim(owner) -> n   ·   releaseAll()
sceneHooks.gravityAt(x,y,z) -> multiplier (1 when free)   // CPU mirrors of the GLSL
sceneHooks.disruptAt(x,y,z) -> 0..1        sceneHooks.ageAt(x,z) -> 0..1
sceneHooks.observe(material) -> material   // park the live state where the pause probe looks
sceneHooks.describe() -> string            // readout only
// install() / uninstall() / apply() belong to App. Do not call them from an ability.

/* every token */                token.blend(0..1) · hold() · release()
                                 token.driving · active · owner · hook
KEY_LIGHT   t.aim(azimuth, elevation) · tint('#rrggbb'|Color) · brightness(intensity)
GRADE       t.saturate(v) · temper(v) · raise(v) · darken(v)
AGE         t.at(x,y,z) | atPoint(v3) · field(radius, edge, amount, inner = 0)
            t.wear(rust, dust, moss, pit, bleach) · scale(metres) · colours(rust, dust, moss)
HOLE        t.at(x,y,z) | atPoint(v3) · size(radius, squash = 1)
GRAVITY     t.at(x,y,z) | atPoint(v3) · well(radius, edge = 0.25) · scale(inside, outside = 1)
DISRUPT     t.at(x,y,z) | atPoint(v3) · region(radius, edge = 0.35)
            t.power(drain, fracture, dim) · shardSize(pixels)

/* opting a material into the published fields */
uniforms: sharedUniforms({ ...disruptUniforms(), ...gravityUniforms() })   // shared boxes, never cloned
vertex:   ${disruptGLSL}   vDisrupt = disruptAt(worldPos);
fragment: ${disruptGLSL}   disruptShade(colour, alpha, vDisrupt, gl_FragCoord.xy);
          ${gravityGLSL}   float g = gravityScaleAt(worldPos);   // exactly 1.0 when nothing is held
patchAgeMaterial(material)      // any MeshStandardMaterial; App does the floor
```

Acquire through **`this.borrow(sceneHooks.acquire(hook, this))`** and `Ability#destroy()` gives it
back however the cast ends. An owner holds **at most one token per hook** — re-acquiring renews.
Two owners on one hook resolve **LIFO**: the last acquirer drives, the earlier one stays live with
`driving === false` and resumes the frame the top one releases.

### `LensFlare.js`

```js
/* LensFlare.js ─ 1 draw call ─ .object3D ─ canonical */
import { LensFlare, FlareRole, MAX_FLARE_GHOSTS, lensFlareParams } from '../../vfx/LensFlare.js';

FlareRole = { CORE:0, STREAK:1, RING:2, GHOST:3 }        MAX_FLARE_GHOSTS = 8
lensFlareParams() -> object                              // 48 sliders, 9 pickers

new LensFlare({ ghosts = 8, renderOrder = 3000, layer = LAYER.VFX, name })
  // `ghosts` is the CAPACITY; params.ghosts is how many draw this frame.

f.object3D -> Mesh    f.drawCalls // 1    f.capacity    f.visible (get/set)
f.setAnchor(v3)   f.setAnchorXYZ(x, y, z)   f.anchor(out?) -> v3
f.update(p)       f.dispose()
```

### `Mirror.js`

```js
/* Mirror.js ─ 1 draw call + ONE nested renderer.render() per rendering mirror ─ .object3D */
import { Mirror, mirrorParams, mirrorBudget, setMirrorBudget } from '../../vfx/Mirror.js';

mirrorParams() -> object                    // 20 sliders, 2 pickers
mirrorBudget = { max: 2, live, rendered, skipped, calls, triangles }   // read-only readout
setMirrorBudget(n)

new Mirror({ resolution = 384, layer = LAYER.VFX, reflectLayer = LAYER.WORLD, renderOrder = 4,
             doubleSided = true, depthWrite = false, name })

m.object3D -> Mesh    m.drawCalls // 1    m.resolution    m.visible (get/set)
m.priority            m.lastCalls        m.lastTriangles   // measured, not estimated
m.setPlacement(anchor, normal, along)
m.update(p)           m.dispose()
```

### `Caustics.js`

```js
/* Caustics.js ─ 1 draw call ─ parent ─ canonical */
import { Caustics, CausticSource, CausticShape, CAUSTIC_SOURCE_NAMES, CAUSTIC_SHAPE_NAMES,
         CAUSTIC_RIPPLE_SLOTS, CAUSTIC_BOUND_KEYS, causticsParams } from '../../vfx/Caustics.js';

CausticSource = { SCROLL:0, WAVE:1, CUSTOM:2 }     CausticShape = { DISC:0, CONE:1, LANE:2 }
CAUSTIC_RIPPLE_SLOTS = 8      // === LiquidSurface.RIPPLE_SLOTS; they move together or not at all
causticsParams() -> object

new Caustics(parent, { source = CausticSource.SCROLL, shape = CausticShape.DISC, custom = '',
                       uniforms = null, additive = true, depthTest = true,
                       layer = LAYER.VFX, renderOrder = 7, name = null })
  // CUSTOM throws without `custom`: a chunk defining
  //   float causticHeight(vec2 xz)  and  float causticRidge(vec2 xz)

c.object3D -> Mesh    c.drawCalls // 1    c.boundCount    c.setVisible(v)
c.bindSource(liquid.uniforms, keys = CAUSTIC_BOUND_KEYS)   c.unbindSource()
c.ripple(u, v, strength = 1, now = 0)     c.clearRipples()   // no-ops while uRipples is bound
c.reset()   c.update(p)   c.setAdditive(bool)   c.dispose()
```

### `LightShaft.js`

```js
/* LightShaft.js ─ 1 draw call ─ parent ─ canonical */
import { LightShaft, ShaftLayout, SHAFT_LAYOUT_NAMES, lightShaftParams }
  from '../../vfx/LightShaft.js';

ShaftLayout = { SINGLE:0, LINE:1, RING:2, SCATTER:3 }
lightShaftParams() -> object

new LightShaft(parent, { capacity = 6, layout = ShaftLayout.SINGLE, sides = 14, maxSteps = 48,
                         layer = LAYER.VFX, renderOrder = 10, name = null })
  // `maxSteps` is the compile-time cap; `p.steps` is the slider inside it.

s.object3D -> Mesh    s.drawCalls // 1    s.instanceCount    s.layout (get/set)   s.visible (get/set)
s.setPlacement(anchor, along, up)   s.roll(seed = Math.random() * 100)   s.reset()
s.update(p)
s.footPoint(index, p, out) -> v3     s.mouthPoint(index, p, out) -> v3
s.irradianceAt(point, p, out = null) -> 0..1   // multiply into your own motes
s.dispose()
```

### `BrushStroke.js`

```js
/* BrushStroke.js ─ 1 draw call ─ .object3D ─ canonical */
import { BrushStroke, BrushTip, BRUSH_TIP_NAMES, brushStrokeParams }
  from '../../vfx/BrushStroke.js';

BrushTip = { FLAT:0, ROUND:1, SPLIT:2 }
brushStrokeParams() -> object

new BrushStroke(parent, { strokes = 6, bristles = 14, samples = 40, sides = 6,
                          tip = BrushTip.FLAT, depthWrite = false,
                          layer = LAYER.VFX, renderOrder = 7, name = null })

b.object3D · b.uniforms · b.drawCalls // 1 · b.count · b.strokeCount · b.tip
b.setStrokeCount(n)   b.stroke(i) -> Stroke   b.retip(tip)   b.reset()
b.setPaper(normal)    b.setColors(a, b, c, d)   b.roll(seed = Math.random() * 100)
b.update(_now, p)     // FIRST ARGUMENT IGNORED — p.progress is the only beat
b.pointAt(i, t, out) · tangentAt(i, t, out) · headOf(i) · tipPoint(i, out)
b.pressureOf(i, t) · widthAt(i, t) · dispose()

/* one stroke */
stroke.curve(p0, p1, p2, p3) · line(from, to, bow = 0, lift = 0)
stroke.pressure(entry, swell, hold, exit) · ink(load) · timing(start, span)
stroke.active · seed · index
```

### `InkDiffusion.js`

```js
/* InkDiffusion.js ─ 1 draw call ─ .object3D ─ canonical */
import { InkDiffusion, InkMode, INK_MODE_NAMES, inkDiffusionParams }
  from '../../vfx/InkDiffusion.js';

InkMode = { BLOOM:0, SPLATTER:1, WASH:2 }        // a #define, fixed at construction
inkDiffusionParams() -> object

new InkDiffusion(parent, { mode = InkMode.BLOOM, sources = 4, satellites = 16,
                           layer = LAYER.VFX, renderOrder = 6, name = null })

k.object3D · k.uniforms · k.drawCalls // 1 · k.age · k.setVisible(v)
k.setPlacement(anchor, along)   k.roll(seed = Math.random() * 100)   k.reset()
k.update(now, p)
k.frontRadius(i = 0) -> metres · sourcePoint(i, out) -> v3
k.satelliteSize(i) · satelliteReach(i) · satellitePoint(i, out) · satelliteAge(i)
k.dispose()
```

### `FoldMesh.js`

```js
/* FoldMesh.js ─ 1 draw call ─ parent ─ canonical */
import { FoldMesh, FoldPattern, FoldLayout, CREASE_PATTERNS, MAX_CREASES, VALLEY, MOUNTAIN,
         fanCreases, foldMeshParams, foldMeshSchema } from '../../vfx/FoldMesh.js';

FoldPattern = { FLAT:0, DART:1, CRANE:2, FAN:3, UNROLL:4 }
FoldLayout  = { LINE:0, ZONE:1, SINGLE:2 }
MAX_CREASES = 12    VALLEY = 1    MOUNTAIN = -1
fanCreases(count = 8, turns = 0.5) -> crease table     // the -2θ/+2θ alternation
foldMeshParams() -> object      foldMeshSchema(label = 'Paper') -> editor schema

new FoldMesh(parent, { pattern = FoldPattern.CRANE, layout = FoldLayout.LINE, capacity = 32,
                       segments = 20, segmentsV = segments, renderOrder = 4,
                       layer = LAYER.WORLD, name = 'FoldMesh' })

m.uniforms · m.count · m.drawCalls // 1 · m.visible (get/set) · m.layout (get/set)
m.setPattern(pattern)   m.setColors(paper, shade, transmit, ink, crease)
m.setBasis(origin, direction, side, length)   m.reset()
m.update(_now, p)       // FIRST ARGUMENT IGNORED — p.fold is the beat
m.sheetPoint(index, p, out) -> v3    m.spoolPoint(index, p, out) -> v3
m.dispose()
```

### `Dissolve.js`

```js
/* Dissolve.js ─ 0 draw calls (patch) / 1 (heap) ─ parent ─ canonical */
import { patchDissolveMaterial, dissolveUniforms, syncDissolve, dissolveParams, dissolveSchema,
         DissolveMode, DissolveSpace, DISSOLVE_GLSL, MAX_RUNGS,
         DissolveField, heapParams, MAX_LOBES } from '../../vfx/Dissolve.js';

DissolveMode = { VOXEL:0, GRANULAR:1, EROSION:2 }   DissolveSpace = { LOCAL:0, WORLD:1 }
MAX_RUNGS = 6    MAX_LOBES = 24
dissolveParams() -> object      dissolveSchema(label = 'Dissolve') -> editor schema

/* the patch — free, no draw call of its own */
patchDissolveMaterial(material, { mode = DissolveMode.VOXEL, space = DissolveSpace.LOCAL,
                                  uniforms = null, environment = null,
                                  vertex = '', fragment = '' }) -> material
dissolveUniforms(overrides = {}) -> uniform block     // share by IDENTITY across materials
syncDissolve(target, p)                               // every frame; target is the block or a material

/* the heap — GRANULAR */
new DissolveField(parent, { along = 72, across = 40, renderOrder = 3,
                            layer = LAYER.WORLD, name = 'DissolveField' })
d.uniforms · d.drawCalls // 1 · d.visible (get/set)
d.setBasis(origin, direction, side, length)   d.setColors(fresh, settled, face, deep)   d.reset()
d.update(now, p)
d.frontPoint(now, p, out) -> v3    d.crestHeight(now, p) -> metres
d.dispose()
```

### `TimeControl.js`

```js
/* TimeControl.js ─ the field costs 0 draw calls; a ghost costs 1 ─ pool + parent ─ canonical */
import { timeField, TimeField, TimeRegion, MAX_TIME_REGIONS, timeRegionParams,
         TimeRecorder, MAX_TRACK_SAMPLES, MAX_TRACK_BONES, recorderParams,
         GhostRig, createGhostMaterial, ghostLook, applyGhostLook, findCaster,
         TimeWarpClock, RewindGate, reverseTime, reverseRate, reverseParams }
  from '../../vfx/TimeControl.js';
import { timeWarpGLSL } from '../../shaders/lib/timewarp.glsl.js';

/* 1 · the field — four slots, shared by every shader that injects the chunk */
MAX_TIME_REGIONS = 4        timeRegionParams() -> { radius, strength, core, rate }
timeField.acquire(now = frame.uTime.value) -> TimeRegion | null   // NULL when all four are taken
timeField.release(region) · reset() · liveCount
timeField.clockAt(clock, worldPos) -> seconds     timeField.weightAt(worldPos) -> 0..1
region.lock(now?) · place(v3) · placeXYZ(x,y,z) · sync(p) · weightAt(v3) · release()
region.isLive · region.hold
// in any shader:  ${timeWarpGLSL}   float t = warpedTime(uTime, vWorldPos) - uBirth;
//                                   float held = timeRegionWeight(vWorldPos);

/* 2 · the recorder + the ghosts */
new TimeRecorder({ capacity = 120, bones = MAX_TRACK_BONES })
rec.attach(source) · detach() · clear() · sample(now, p) · trim(now, p)
rec.transformAt(t, outPosition, outQuaternion) · poseAt(t, ghost)
rec.boneCount · sampleCount · newest · oldest · span
new GhostRig(parent, { layer = LAYER.VFX, renderOrder = 4, material = null })
g.setSource(source)   // ALLOCATES — a documented I3 exception; call it from createShaders()
g.place(position, heading = 0) · setScale(s) · sync(look) · visible (get/set)
g.drawCalls // 1 per ghost · boneCount · hasSource · dispose()
createGhostMaterial(source = null) · ghostLook() · applyGhostLook(uniforms, look)
findCaster(scene) -> Object3D | null    // scene.getObjectByName('Character')

/* 3 · the reversible clock */
new TimeWarpClock(start = 0)
clk.reset(start = 0) · advance(dt, rate = 1, floor = -Infinity, ceiling = Infinity)
clk.direction · reversing · stalled · emitDt · spanDt
new RewindGate();  gate.reset() · gate.past · gate.poll(time, mark)
reverseTime(age, p) · reverseRate(age, p) · reverseParams()
```

### `Colony.js`

```js
/* Colony.js ─ 4 classes ─ 1/2/1/1 draw calls ─ parent ─ canonical */
ColonyShape={BALL:0,WALL:1,SPEAR:2,FIST:3,RING:4,COLUMN:5}; COLONY_SHAPE_NAMES:string[6]
colonySwarmParams() · webGraphParams() · latticeGrowthParams() · plateShellParams()

new ColonySwarm(parent, {…Swarm options})        // EXTENDS Swarm; splices its vertex shader
c.update(_now,params)   // FIRST ARGUMENT IGNORED; calls super.update() first
c.shapeCentre(out)      // CPU mirror of the shape's centre
  // inherited: count · drawCalls(1) · uniforms · roll · reset · setBasis · setColors · leadPoint
  // colonySwarmParams() = swarmParams() + shapeA/B · shapeBlend · condense ·
  //   shapeWidth/Height/Depth · shapeForward/Side/Up · shapeSpin · shapeFill ·
  //   shapeSteps · shapeSlack · shapeRough · waveAmp/Length/Speed/Along ·
  //   cling · floorY · crawlHeight

new WebGraph(parent,{maxRings=8,maxSpokes=16,samples=10,filmSubdiv=2,additive=false,
                     renderOrder=11})
w.drawCalls(2) · count · strands · faces · seed
w.roll(seed) · reset() · setPlacement(anchor,normal,up)   // normal is OUT of the plane
w.update(_now,params)                                     // FIRST ARGUMENT IGNORED
w.nodePoint(ring,spoke,p,out)   // ring -1 is the hub; omits the per-node jitter
w.dispose()
  // rings/spokes are LIVE but structural: changing either rewrites both index buffers

new LatticeGrowth(parent,{capacity=192,sides=6,wall=0.24,recess=0.62,renderOrder=2,
                          castShadow=true,receiveShadow=true})
g.drawCalls(1) · count · cells · capacity
g.reset() · setPlacement(anchor,forward) · update(now,params)   // now = ability age
g.cellPoint(index,p,out,height=1) · dispose()
  // cells/seed/drift/refuse/climb/outward/layers are structural — they regrow in update()

new PlateShell(parent,{capacity=64,renderOrder=2,castShadow=true})
s.drawCalls(1) · count · plates · capacity
s.reset() · setPlacement(anchor,forward) · update(now,params)   // now = ability age
s.tessellate(sites,seed,jitter)->plates   // update() calls it when sites/seed/jitter change
s.progress(now,p)->0..1 · plateCentre(index,p,out) · dispose()
  // MAX_PLATE_SIDES=12 internally; sites is clamped to 12..capacity
```

### `HardSurface.js`

```js
/* HardSurface.js ─ a toolkit, 0 draw calls ─ no attach ─ canonical */
HardShape={GEAR:0,PISTON:1,SAWBLADE:2,PLATE:3,BOLT:4,ANVIL:5}; HARD_SHAPE_NAMES:string[6]
HardAxis={Y:0,X:1,Z:2}; BrushMode={LINEAR:0,CIRCUMFERENTIAL:1,RADIAL:2}; BRUSH_MODE_NAMES:string[3]
gearShape/pistonShape/sawbladeShape/plateShape/boltShape/anvilShape(overrides)->object
hardShape(kind,overrides)->object          // every field is a NUMBER — no metres, ever

create<Kind>Geometry(shape)->BufferGeometry   // position, normal, aEdge; indexed
hardSurfaceGeometry(kind,shape)->BufferGeometry
  // unit space: max(footprint diameter, height) == 1, sits on y=0, axis centred.
  // 0.8-9 ms to build. NEVER call it speculatively — see ShapeCache.
gearPitchFraction(shape)->0..1 · gearRootFraction(shape)->0..1   // vs the ACTUAL outer radius

new ShapeCache({capacity=8})
cache.get(slot,kind,shape)->BufferGeometry  // rebuild only when a number moved; cache owns it
cache.changed · size · dispose()
  // per ability, never shared. Feeding GrowthField? Hand it the raw generator instead.

new GearTrain({capacity=12}); gearTrainParams()->object
train.plant(count,seed)->number · clear() · solve(p)      // solve() every frame, dt=0 included
train.count · teethOf(i) · pitchRadiusOf(i) · tipRadiusOf(i) · angleOf(i) · rateOf(i)
train.scaleOf(i,pitchFraction=0)->metres · yawOf(i)->radians
train.positionOf(i,p,out) · contactOf(i,p,out)            // contact is the PITCH point
  // p.teeth is a live list of unitless counts; p.module is METRES of pitch diameter per tooth

createHardSurfaceMaterial({environment=null,flatShading=false})->MeshStandardMaterial
syncHardSurfaceMaterial(material,p)->material   // == material.userData.sync(p); EVERY frame
hardSurfaceParams()->object · heatToKelvin(heat,p)->K · blackbodyColor(K,out?)->Color
  // attributes: aEdge (from the generators) · aHeat (yours, instanced, an OFFSET not an absolute)
  // uniforms parked on material.userData.uniforms — the pause test looks there

new GrindContact(); grindParams()->object
GrindContact.rimVelocity(out,axis,rate,point,centre)->out      // v = omega x r
grind.solve(contact,normal,rimVelocity,p)->this
grind.jet(index,emit)->emit    // position/direction/speed/spread/speedVariance/inherit
grind.jets · speed · rimSpeed · origin · direction · normal · binormal
  // emit's vectors are the solver's scratch: ParticleSystem#emit reads and never retains
```

### `quads.js`

Not a renderer — the two unit quads the library draws on, refcounted once instead of five times.

```js
import { acquireGroundQuad, releaseGroundQuad, groundQuadRefs, uprightQuad, disposeQuads }
  from '../../vfx/quads.js';

acquireGroundQuad() -> PlaneGeometry   // 1x1 in XZ, normal +Y. Refcounted: release in dispose().
releaseGroundQuad()                    // the last release disposes it
groundQuadRefs() -> number             // readout only
uprightQuad() -> PlaneGeometry         // 1x1 in XY, normal +Z. NOT refcounted, never disposed.
disposeQuads()                         // teardown only; a live mesh is left holding a dead buffer
```

Neither quad carries a metre. Scale the mesh; a quad built at the effect's radius is a dimension
captured in a buffer, which is the one thing I1 exists to prevent.

### `prefixedBlock.js`

Not a renderer — the shared plumbing behind the prefixed-key convention, extracted after `Tube`,
`Shell` and `VolumeHull` each independently wrote the same eight lines. You only need it if you are
writing a **new** module that wants two instances per ability.

```js
import { num, str, prefixed, buildKeys, buildDefaults, auditBlock }
  from '../../vfx/prefixedBlock.js';

num(value, fallback) -> number          // finite-or-default; the NaN test is the point
str(value, fallback) -> string
prefixed(prefix, name) -> string        // ('tube','radius') -> 'tubeRadius'; '' passes through
buildKeys(fieldNames, prefix) -> { name: prefixedKey }
buildDefaults(fieldNames, fields, tuning, prefix, overrides = {}) -> settings fragment
auditBlock(label, keys, fieldNames, block, remedy) -> string[]   // warns once, names every gap
```

---

## Budgeting a cast

`docs/EXPANSION.md` §0 I7: **≤ 12 draw calls, ≤ 1500 live particles, ≤ 1 dynamic light** per cast,
and the manager caps at four concurrent casts. Every module's `drawCalls` getter reports its real
cost, and `npm run check` fails any single module that exceeds the whole-ability budget on its own.

Some combinations that fit, for calibration:

| cast | modules | draw calls |
| --- | --- | --- |
| a beam | `Tube(STRAIGHT)` | 3 |
| a tornado | `Tube(FUNNEL)` + `GroundField(SCOUR)` + `Swarm(LEAF)` | 5 |
| a shockwave | `Shell(PRESSURE)` + `DistortionField(SHOCK)` + `GroundField(POCK)` | 3 |
| a chained bolt | `FilamentPaths` + `ArcNetwork` sharing its strip | 2 |
| an ice field | `GrowthField` (3 variants) + `ShatterField` (2) + `GroundField(PLATE)` | 6 |
| a portal | `Portal` + `DistortionField(LENS)` + `Curtain(AURORA, floor)` | 4 |
| a flooded lane | `LiquidSurface(WAVE)` + `Caustics(WAVE)` bound to it + `GroundField(WET)` | 3 |
| a shaft of light | `LightShaft(LINE)` + `LensFlare` + one particle system read through `irradianceAt` | 2 |
| a forge strike | `GrowthField` (2 variants, `HardSurface` gears) + `Shell(RING)` + sparks | 4 |
| a stasis bubble | `timeField` (0) + `Shell(DOME)` + `DistortionField(LENS)` | 2 |
| a sealscript | `BrushStroke` + `InkDiffusion(BLOOM)` + `GroundField(RUNE)` | 3 |
| a hive dome | `PlateShell` + `ColonySwarm` + `WebGraph` | 4 |

Three costs are not draw calls and are easy to miss. A **`Mirror`** adds one nested
`renderer.render()` of `LAYER.WORLD` per frame it is visible — capped at two mirrors a frame by
`mirrorBudget`, and it reports what it actually cost. A **`Caustics(SCROLL)`** is fill-bound at
around a hundred hashes a pixel; treat it like `LiquidSurface`, one per screen (`WAVE` is much
cheaper). A **`GhostRig`** is one draw call but roughly seventy `Object3D`s of skeleton, and N
poses genuinely cannot be one draw call.

`ArcNetwork` costs **nothing** if you hand it a `FilamentPaths` you already have and a spare role
index — that is the single cheapest saving in the library, and there are only four role slots.

## Verifying your module

`npm run check` covers `src/vfx/` in its own stage (§10 of `scripts/check.mjs`). It constructs every
exported class with reasonable defaults, sweeps every mode enum, drives each for six frames plus a
zero-length one, scans every transform, instance attribute and uniform for NaN, checks the draw-call
budget, and calls `dispose()`.

**This is the only thing that compiles these files at all.** `npm run build` bundles from
`index.html`, and until an ability imports a module nothing in `src/vfx/` is in the graph — a syntax
error in an unimported module builds perfectly and passes every ability test. Two modules were
sitting broken exactly that way when this stage was added.

The coverage rule at the end of the stage is deliberate: **every exported class in every file under
`src/vfx/` must have a case**. Add a module without a case and the check fails, naming it.

Two sweeps run alongside it and cover the ground a case cannot:

- **The GLSL reserved-word sweep** reads every `/* glsl */` block under `src/` as text and fails on
  an identifier that is reserved at `#version 300 es`. It is a text sweep rather than a walk over
  constructed materials because the two failures it exists to catch both live in source no
  constructed material carries — a `patchOnBeforeCompile` body, which needs a renderer before it is
  ever assembled, and a shader behind a `#define` the run's options did not select. See trap 2.
- **The borrowed-globals check** fails an ability whose `destroy()` left a scene hook held or a time
  region live. See trap 10.

```
npm run check                # everything, including the vfx stage
npm run check -- --only ice  # one ability; skips the vfx stage
npm run check -- --only ice --vfx   # ...and puts it back
```

## Traps that have already cost someone a day

Every one of these was a real bug in this library, found by hand or by the harness.

1. **A backtick inside a GLSL comment ends the template literal.** It reports as
   `SyntaxError: Unexpected identifier` pointing into the middle of your shader. Cost two agents a
   round-trip each, including the one who had just written the warning about it.
2. **Reserved words — and the list is the GLSL ES 3.00 one, not the 1.00 one.** This is worth
   getting right because the advice here used to be wrong in both directions, and the wrong half
   cost the whole ground material.

   three's `WebGLProgram` prepends `#version 300 es` to **everything that is not a
   `RawShaderMaterial`** — every built-in material and every plain `ShaderMaterial` in this
   project — and `#define`s `varying`, `attribute` and `texture2D` so that source written in the
   1.00 dialect still compiles. Two consequences, both counter-intuitive:

   - `packed` is illegal in ESSL 1.00 and **legal** in 3.00. `VolumetricFireMaterial` has had a
     `float packed` in it since the beginning and it compiles.
   - `patch` is legal in 1.00 and **reserved** in 3.00. A `float patch` in the floor's ageing
     patch took the entire ground material out of the frame — no floor, no shadow, one console
     error deep in a two-thousand-line generated shader that says `syntax error` and never says
     *why* the word is special.

   The list is now **checked in `npm run check`**, over every `/* glsl */` block under `src/`, so
   this cannot happen a third time. It was built by compiling every candidate at `#version 300 es`
   on a real driver as a local, a parameter and a function name, and keeping only the words that
   failed all three. In practice the ones you will reach for are `patch`, `sample`, `filter`,
   `input`, `output`, `flat`, `smooth`, `layout`, `common`, `active`, `this`, `interface`.

   Shadowing a built-in *function* with a local is fine — `float round = …` compiles — but
   **defining** a function with a built-in's name does not, whatever its signature.
3. **Uniform arrays may be indexed only by a loop counter** — the obvious `uFrom[role]` does not
   compile on ANGLE. `FilamentPaths` loops with `if (float(i) == role)` for exactly that reason; do
   not "simplify" it. (`cosh` is present in 3.00 and the old warning about it is stale, but the
   `coshf` helpers already written against it are harmless and stay.)
4. **Value noise piles up at 0.5**, so a ridged octave `1 - |2n - 1|` piles up at 1 and your embers
   cover the whole cloud. `VolumeHull` uses a hashed-lattice `speck()` instead.
5. **A patched `MeshStandardMaterial` must park its uniform boxes on `material.userData.uniforms`**
   (the `IceMaterial` / `MeteorMaterial` convention) or the harness's pause test cannot see them and
   will report thirty working sliders as dead.
6. **`frame.uSceneColor` does not exist yet.** `ShatterField.sync()` polls for it and degrades by
   `#define`, not by branch. Whoever adds a scene-colour copy to `core/FrameUniforms.js` gets
   refraction in every `ShatterField` for free — but must not point it at the composer's write
   target, which is a feedback loop.
7. **The fragment `softFade`s against `frame.uSceneDepth`.** With nothing bound it discards
   everything: fine in the app, a trap in a bespoke test harness that renders one mesh.
8. **`frame.uEnvMap` is `null` until `App` sets `environment.equirect`.** `LiquidSurface` and
   `Curtain` sample it unconditionally, as `GlacierMaterial` does.
9. **`commonGLSL` does not compile in a vertex shader.** It carries `aastep`, which calls `fwidth`,
   and derivative functions do not exist there; the program fails on a line you are not using.
   Inject **`commonVertexGLSL`** instead — the same chunk minus `aastep` and `softFade`, with its
   own include guard, so a material that wants both stages can spread both.
10. **A global borrowed in `onSpawn()` must be given back in `onDestroy()`** — a scene hook, a time
    region, anything with an `acquire()`. Wrap the acquisition in `this.borrow(...)` and the base
    class returns it however the cast ends, including the three ways that are not the ability's
    idea (the player pressing **C**, a fifth cast pushing it off the concurrency cap, teardown).
    `npm run check` fails an ability that leaves one held.

---


## `GrowthField.js` — things that come out of the ground

`IceAbility`'s crystal field with the ice taken out of it. N instanced copies of a caller-supplied
procedural geometry, placed along a **LINE** band or across a **ZONE** annulus, each erupting on its
own staggered clock with an overshoot, a settle and a birth flash.

**It does not own a material.** The ability supplies the geometry factory *and* the material, which
is why rime plates, thorns, bone spears, heaved slabs and petals can share every line of the file
and look nothing like each other.

### Draw-call cost

`variants` — one `InstancedMesh` per silhouette. **3 by default, and 3 is the recommended number**:
per-instance scaling buys proportion variety, but only distinct geometry buys *facet* variety, and a
field of one shape scaled forty ways reads as a repeated prop the moment the camera moves. Drop to
`variants: 1` for anything that is genuinely a single object.

### Signatures

```js
import {
  GrowthField, GrowthLayout, GrowthEmerge, growthParams, patchGrowthMaterial
} from '../vfx/GrowthField.js';

GrowthLayout = { LINE: 0, ZONE: 1 }        // where the field is laid out
GrowthEmerge = { PUSH: 0, SCALE: 1 }       // punches out of the floor / accretes in place

new GrowthField(parent, {
  geometry,                 // (variant: number, shape: object) => BufferGeometry   REQUIRED
  material,                 // THREE.Material, owned by the ability                REQUIRED
  shape        = null,      // first shape params; also primes the rebuild hash
  variants     = 3,
  capacity     = 288,       // hard ceiling on instances per cast
  layer        = LAYER.WORLD,
  renderOrder  = 2,
  castShadow   = true,
  receiveShadow = true
})

field.onBreach = (index, position, radius, height) => {}   // assign ONCE, never per frame
field.count            // instances planted   → Ability#instanceCount
field.drawCalls        // === variants

field.plant(count, clusterShare = 0) → number      // onSpawn(); the only dice roll
field.clear()                                      // onDestroy()
field.syncGeometry(shape) → boolean                // rebuilds only when a number moved

field.triggerUpTo(now, limit, stagger, frontBias = 1, includeCluster = false)   // LINE front
field.triggerRadial(now, limit, stagger, invert = false, includeCluster = true) // ZONE front
field.triggerAll(now, stagger)
field.triggerIndex(now, index, delay = 0)
field.isFullyTriggered   // boolean

field.update(now, params, retract = 0)             // rebuild every matrix, allocation-free

field.positionOf(index, params, out) → Vector3     // live read-back, for threading things between
field.tipOf(index, params, out) → Vector3          //   instances (Thornwake's interlacing vines)
field.heightOf(index, params) → metres
field.radiusOf(index, params) → metres
field.emergenceOf(index, now, params) → 0..1+, negative while buried

field.dispose()          // geometry + meshes; the material is yours

growthParams() → object  // every canonical key with its default and a unit comment
patchGrowthMaterial(material, { environment, uniforms, common, vertex, fragment }) → material
```

`now` is always the ability's `age` in seconds. `params` is read fresh on every call; see
`growthParams()` in the source for the full key list — footprint (`widthNear`/`width`/`widthCurve`/
`clumping`/`scatter`/`frontBias`, or `radius`/`innerRadius`/`radialCurve` in ZONE), silhouette
(`heightNear`/`height`/`heightCurve`/`crown`/`peak`/`rubble`), the individual body (`radiusNear`/
`radius2`/`lean`/`twist`/`tilt`/`baseHeight`) and the eruption (`riseTime`/`riseOvershoot`/`settle`/
`birthFade`/`emergeSink`).

### The geometry factory contract

`factory(variant, shape)` must return geometry in **unit space**: footprint inside a circle of
radius 0.5 on `y = 0`, tip at `y = 1`. An instance then scales footprint and height independently,
and `local.y` reads straight off in the fragment shader as "how far up this thing am I" — which is
what every base-to-tip gradient keys off. `assets/ProceduralGeometry.js#createCrystalGeometry` is
the reference implementation.

### The material helper

`patchGrowthMaterial()` is `materials/IceMaterial.js`'s patch reduced to its skeleton. Pass
`environment` and it routes through `registerShadowCasterWithPatch`, so CSM's own patch is not
clobbered. Your fragment snippet is injected after `<emissivemap_fragment>` — it *must* go there,
because with `flatShading` there is no `vNormal` varying and the face normal only exists after that
include. Available varyings:

| varying | meaning |
| --- | --- |
| `vGrowLocal` | unit-space position — `.y` is 0 at the base, 1 at the tip |
| `vGrowWorld` | world position, for detail that must keep a fixed physical size |
| `vGrowSeed` | per-instance seed, 0..10 |
| `vGrowBirth` | per-instance birth flash, 1 → 0 over `birthFade` |

Picking the wrong space is the usual bug: cracks and grain belong in **world** space so neighbouring
instances look quarried from the same block; anything that runs base-to-tip belongs in **local**
space so it follows each instance's own axis however it is scaled and leaned.

### The one rule

**Fill the params from `settings[id]` every frame and never keep a resolved metre between frames.**
The records hold dice and one timestamp; that is the whole reason a paused field re-grows under the
slider. `frontBias` is a live exponent here rather than baked into the placement roll the way
`IceAbility` bakes it, so dragging it moves a field that is already standing — the one place this
module improves on the thing it came from.

---

## `ShatterField.js` — things that come apart

Instanced fragments that inherit a velocity and tumble under gravity, fading and shrinking. Fragment
geometry is caller-supplied (shards, panes, prism chips). Optional **screen-space scene sample**: a
shard that shows a distorted, desaturated copy of what is behind it.

Nothing here integrates. A fragment's position is a closed-form function of `now − born` evaluated
against the live params — with drag, `p(t) = p₀ + (v₀ − g/k)(1 − e^{−kt})/k + (g/k)·t`, falling back
to the ballistic form below `k ≈ 0`. That is not a micro-optimisation, it is invariant I1: an Euler
integrator has already spent the old gravity and physically cannot re-fly a fragment when you drag
the slider with the clock stopped.

### Draw-call cost

`variants` — one `InstancedMesh` per fragment shape. **2 by default**; one is fine, three is
usually indulgent for debris that is on screen for a second.

### Signatures

```js
import { ShatterField, ShatterLayout, shatterParams } from '../vfx/ShatterField.js';

ShatterLayout = GrowthLayout    // { LINE: 0, ZONE: 1 }, re-exported so you need one import

new ShatterField(parent, {
  geometry,                // (variant: number) => BufferGeometry     REQUIRED
  variants    = 2,
  capacity    = 192,       // hard ceiling on live fragments (ring-allocated)
  material    = null,      // supply one to bypass the built-in shader entirely;
                           //   it must consume `aSeed` and `aLife` itself
  additive    = false,
  depthWrite  = true,
  layer       = LAYER.VFX,
  renderOrder = 6,
  castShadow  = false,     // a shadow per fragment costs more than it reads
  receiveShadow = false
})

shatter.count        // live fragments  → Ability#instanceCount
shatter.drawCalls    // === variants
shatter.uniforms     // the built-in material's uniforms, if you did not supply your own

shatter.burst(now, count, along = 1, lateral = 0) → number   // the only dice roll
shatter.clear()
shatter.sync(look)                                  // colours + shading, from live settings
shatter.setSceneTexture(texture | null)             // bind/unbind the screen-space sample
shatter.update(now, params) → live count            // re-fly everything, allocation-free
shatter.positionOf(index, now, params, out) → Vector3
shatter.dispose()

shatterParams() → object   // every canonical key with its default and a unit comment
```

`params` covers the basis (`origin`/`direction`/`side`/`length`, or `centre`/`radius` in ZONE), the
throw (`speed`/`speedJitter`/`spread`/`upBias`/`inherit`/`inheritScale`), the flight
(`gravity`/`drag`), the body (`size`/`sizeJitter`/`shrink`/`shrinkPower`/`spin`/`spinJitter`), the
clock (`lifetime`) and the floor (`floor`/`floorSpin`).

`look` for `sync()` is `colorA`, `colorB`, `colorEdge`, `colorScene` (THREE.Color — four independent
pickers, none derived from another, per I5) plus `opacity`, `glow`, `rim`, `rimPower`, `shade`,
`ambient`, `fadeStart`, `soft`, `sceneMix`, `refract`, `saturation`.

### The screen-space sample, and how it degrades

The repo **does not currently expose a read buffer**: `PostProcessing` runs an `EffectComposer`
whose ping-pong targets are internal, and sampling the target you are drawing into is a feedback
loop, not a refraction. So:

- with no texture bound, `SHATTER_SCENE` is undefined and the sampler is not in the compiled shader
  at all — the shard is its solid tint, and nothing renders black;
- `sync()` polls `frame.uSceneColor` (which does not exist today) so the day someone adds a scene
  copy to `core/FrameUniforms.js`, every ShatterField starts refracting with no change here;
- `setSceneTexture(tex)` binds one by hand and takes precedence over that poll.

Either way the define flips **once**, on the transition, and the material recompiles then — never
per frame.

### The one rule

**Fragments are debris, so give them somewhere to have come from.** Pass the live velocity of
whatever broke as `inherit` and keep `spread` low. A burst at `spread: 1` is a firework; a burst at
`spread: 0.35` with an inherited velocity is a thing that shattered.

---

## `GroundField.js` — one quad that thinks in metres

The snare's burnt field and the two targeting indicators, generalised into ten substances. One
ground quad, anchored at a point, whose fragment shader remaps UV into **metres from that anchor**,
so every control below is a real measurement: the meniscus on a pool stays 4 cm wide whether the
pool is 1 m or 6 m across, and a seal three metres wider carries *more* runes rather than bigger
ones.

It exists because of one sentence in `GroundDecals.js`: `spawn()` writes `uRadius` **once**. A
pooled decal captures its radius the moment it lands, so a crater already on the floor cannot hear a
slider move — which is fine for a scorch mark that lives for two seconds and wrong for anything an
ability is still holding. Everything here is re-resolved from the live params on every `update()`,
including a zero-length frame. Pause, drag `radius`, and the mark, its grain, its relief and its
growth front all re-scale together. That is invariant **I1**, and it is the whole reason the module
is a mesh rather than a decal type.

### Draw-call cost

**One.** Always one, in every mode, at any radius, with any number of craters in it. The mode is a
`#define`, so a program only ever carries the branch it needs and the RUNE alphabet is not compiled
into the other nine.

### The modes

Ten, and none of them is another one recoloured:

| mode | the substance |
| --- | --- |
| `PLATE` | interlocking sheet-ice plates, each lifting and curling along whichever edge is downwind |
| `RUNE` | a whole inscribed seal: nested counter-rotating rings of signed-distance **glyphs** — strokes, terminals and counters — plus a chord armature, a tick collar and a central rosette sigil, all inking themselves stroke by stroke and igniting from the inside out |
| `POCK` | impact craters accumulating from a list of unitless hits, bowls unioned and rims summed |
| `RUT` | a gouged track behind a rolling body, depth following the contact force it posted |
| `WET` | darkened, reflective stone that dries from the edges in |
| `PUSTULE` | cellular blisters that inflate and burst on individual timers |
| `FUNNEL` | an inverted cone read as depth off a faked normal and a parallax offset — the sinkhole |
| `SCOUR` | log-spiral scour grooves under a vortex |
| `LATTICE` | a hex lattice that propagates **along its own edges**, cell by cell |
| `POOL` | standing liquid with a meniscus rim and a slow flow-warped surface |

### Signatures

```js
import { GroundField, GroundMode, GROUND_MODE_NAMES, groundFieldParams } from '../../vfx/GroundField.js';

new GroundField(parent, {
  mode: GroundMode.RUNE,   // fixed for the lifetime — it is a #define
  marks: 12,               // POCK / RUT: how many events the shader carries
  additive: false,         // initial blend; params.additive drives it after
  depthTest: true,         // false lets the soft fade do all the occlusion
  layer, renderOrder, name
});

field.object3D                                  // the Mesh
field.drawCalls                                 // 1
field.markCount
field.setVisible(visible)
field.setAdditive(additive)                     // free — blend state, not a program
field.mark(x, z, time, strength = 1) → Vector4  // a dice roll and a timestamp, nothing else
field.clearMarks()
field.update(params)                            // re-resolve everything, allocation-free
field.dispose()

groundFieldParams() → object   // every canonical key with its default and a unit comment
```

`mark()` is the only place a cast records anything, and it records **unitless** data: `x`/`z` are
fractions of the radius in the anchor's frame (for `RUT`, `z` is 0..1 along the track), `time` is
the timestamp the event fired at, and `strength` is 0..1. Nothing carries a metre, so the craters
re-place *and* re-scale themselves when the radius slider moves. Past `marks` events the list
recycles oldest-first out of a ring buffer that was allocated in the constructor.

`params` covers the anchor (`centre`/`yaw`/`height`/`radius`/`length`), the beats
(`grow`/`recede`/`progress`/`inscribe`/`ignite`/`fade`/`seed` — all unitless, all resolved by the
ability's own clock), the front (`edge`/`ragged`/`raggedScale`/`warp`), the lighting
(`relief`/`normalStep`/`ambient`/`wrap`/`specular`/`gloss`/`parallax`), the shape vocabulary below,
the seal (`rings`/`ringInner`/`glyphSize`/`glyphStroke`/`glyphGap`/`spin`/`spinFalloff`/`rule`, plus
the armature, collar and sigil groups described below), the
events (`markLife`/`markRadius`) and the output (`additive`/`emissive`/`opacity`/`depthFade` plus
four colour pickers, none derived from another, per I5).

### The shared shape vocabulary

Ten modes with private parameter names would be four hundred uniforms. There is one vocabulary of
measurements instead, and each mode says what it does with each of them — the full table is in the
doc comment on `groundFieldParams()`. The short version: `cell` is a pitch in metres, `seam` a gap,
`thickness`/`lift`/`depth` are how thick, how far proud and how far down, `width` is a track's
half-width, `swirl`/`arms` shape rotational marks, and `speed`/`flow`/`windAngle` are the clocks and
the direction things drift in.

### The three things every mode shares

**A ragged front, warped in the plane.** The growth boundary is a noise field sampled in 2D and
domain warped, never on `atan(y, x)`. An angular lookup hands every radius along a bearing the same
value, which draws dead-straight spokes out of the centre — a firework, not a spreading substance.
The main README documents that mistake twice, on the bolt's ground burn and on the snare's field,
because it was made twice. There are exactly two deliberate angular samples in the file: the SCOUR
spiral, whose marks genuinely *are* rotational, and the compass sweep that draws the rune circles —
a compass is an angular instrument.

**A fake normal off a real height field.** Each mode publishes metres of relief; the shared path
takes two forward differences and lights the result with `frame.uLightDir`, the same key direction
the lit meshes use, rotated into the quad's frame in the vertex shader so a yawed anchor is not lit
from a different side of the room. Without it every one of these is a sticker. `RUNE` skips the
taps entirely: a signed distance field already knows which way is out, so `gfSeg`/`gfArc` hand back
the gradient of the winning stroke and the incision is bevelled and lit off **one** evaluation —
three taps through twenty-four strokes, four rings, an armature and a sigil would have been the most
expensive fragment in the project by a wide margin.

### The seal, and what `runeseal` added to it

`RUNE` shipped as rings of glyphs. `runeseal` — the roster's showpiece ground shader, and the one
slot whose brief is "it must survive being paused and stared at" — needed more than rings, so the
mode grew three pieces of furniture, a longer alphabet and a burn-down. All of it is **off by
default**: a caller who asks for `RUNE` and sets nothing gets exactly the rings it always drew.

- **Twenty-four strokes, twenty-four marks** (was eighteen and sixteen). Three families were
  missing, and all three are things a script has that a set of runes usually does not: asymmetric
  arms, so a mark can be left- or right-handed rather than always balanced; barbs, so a terminal can
  flick rather than stop; and off-centre counters, so an enclosed space can sit above or below the
  waist. At sixteen marks a slow orbit of a five-metre seal walks you past the same letterform five
  times. **Twenty-four is a ceiling, not a round number**: a stroke set is a bit field in a float, a
  highp float holds integers exactly to 2²⁴, and a twenty-fifth stroke does not fail to compile — it
  silently drops on some hardware and not others. A twenty-fifth stroke needs a second code word.
- **The armature** (`armStart`/`armRadius`/`armSides`/`armTangent`/`armStroke`/`armPhase`/`armSpin`)
  — chords whose ends land on a circle and which pass at a chosen distance from the anchor. One
  parameterisation, two figures: at `armTangent = cos(PI / sides)` the chords close into an
  inscribed polygon, below that they cross into a star, and at *any* value they are simultaneously
  tangents to the inner circle of that radius. The fragment sweeps seven candidate chords rather
  than folding to the nearest one, because folding truncates a star to disconnected stubs; measured
  by walking each chord's centre line, seven holds the figure whole down to `armTangent = 0` at up
  to twelve chords, and needs about 0.2 at sixteen.
- **The tick collar** (`tickCount`/`tickRadius`/`tickLength`/`tickStroke`/`tickMajor`/`tickMajorLen`)
  — the difference between a magic circle and an instrument. Division is what makes a drawing look
  measured out rather than decorated. One segment per fragment: ticks are radial and short, so the
  nearest bearing really is the nearest tick.
- **The central sigil** (`sigilStart`/`sigilRadius`/`sigilSize`/`sigilArms`/`sigilStroke`/
  `sigilRing`/`sigilSpin`) — one glyph at its own em box, folded into N-fold rotational symmetry
  about the anchor and ruled inside a circle. The fold is the economy: one evaluation of the
  alphabet buys every arm. Its gradient needs rotating twice on the way out — out of the em box and
  out of the sector — and skipping the second lights one arm correctly and the rest from the wrong
  side.
- **`scorch`** — 0..1, takes the fire back out of the ink and leaves the writing as a scar, so a
  seal can burn down rather than fade out.

`inscribe` is still one clock, and `armStart`/`sigilStart` cut it into three movements: rings, then
armature and collar, then sigil — which is how the biggest mark on the floor ends up being the last
thing you watch finish. **A slice of zero length is the off switch**, which is why both default
to 1. `runeseal` sets them to 0.5 and 0.72.

Two things worth knowing before editing this branch:

- **The stroke ink is antialiased with `aastep` fed a distance in *pixels*, not metres**, so the edge
  resolves in about one pixel at any zoom — which is the entire requirement. It is handed
  `clamp(sd / pxp, -6, 6)`, and the clamp is load-bearing: the ring loop skips bands with
  `continue`, two fragments of one 2×2 quad can leave it holding `1e4` and `0.01`, and `fwidth` of
  that spreads `aastep`'s transition across the whole range and paints a bright grey pixel along
  every band boundary — a fault that only ever shows up when somebody pauses and stares. `pxp` is
  `fwidth(p)`, the metric **in the plane**, taken before the first discard. The radial `fwidth(d)`
  the other modes use is the wrong measure for a stroke that points at the anchor, where `d` barely
  changes: those strokes, and only those, came out with a hard crawling edge.
- **`packed` was a local in the depth fade** and is a future-reserved word in GLSL ES, so every mode
  of this shader would have failed to compile on ANGLE. `commonGLSL#softFade` made the same mistake
  and renamed to `depthBits`; so has this. It survived because the reserved-word scanner in
  `scripts/` only audits `Distortion` and `Portal`, and nothing had put a `GroundField` in front of a
  browser yet.

**Both blend modes.** The main README's rough-edges list ends on "both the targeting circle and the
snare's field are additive, so the footprint brightens the floor rather than shading it". This
closes that: `additive: false` alpha-blends, so wet flagstones, a hole and a pool of blood come out
genuinely *darker* than the floor they lie on. `WET` is the argument for the option existing — a
soaked stone that adds light is a lit stone. Blend state is not compiled into the program, so
`additive` is a live checkbox rather than a construction decision.

There is a fourth, quieter one: the soft depth fade. The depth prepass is half resolution, so its
silhouettes are a pixel or two soft, and that is exactly the band worth feathering where the
character's legs meet the mark. Turn `depthTest` off at construction and the same term does all the
occlusion instead of a hard z-test.

### The glyph alphabet is authored in JavaScript

`GLYPH_STROKES` is an eighteen-stroke skeleton — six half-uprights, three bars, two stem halves,
four diagonals, two bowls, a left and a right bowl and a counter — and `GLYPH_ALPHABET` is sixteen
bit-sets over it. Both are plain data at the top of the file, and the GLSL that walks them is
**generated at module load** as straight-line code.

That is not a shortcut, it is the only portable way to do it: GLSL ES 1.00 forbids indexing an array
with anything but a constant expression, so the obvious `STROKES[glyph * 18 + i]` table will not
compile on half the targets three supports. Unrolling removes the array and the dynamic index, and
leaves the alphabet readable where it is data instead of smeared through a shader as magic numbers.
Adding a seventeenth rune is one line of JavaScript.

Sixteen letterforms is enough that three rings of a 5 m seal read as "a script I do not know"
rather than as a pattern repeating. Stroke width swells toward the middle and tapers into the ends,
which is what gives them terminals instead of sawn-off tubes; several have counters, because a
stroke-only alphabet with no enclosed space reads as scaffolding. The inking clock divides evenly
over the strokes a glyph actually has, so a three-stroke mark and a five-stroke mark finish
together, and glyphs are inked ring by ring outward and slot by slot around each ring.

### The one rule

**Never cache the radius.** Fill a module-scope params object from `settings[id]` every frame and
hand it to `update()`; an object literal per frame is the allocation I3 forbids, and a metre kept
between frames is the invariant I1 forbids. If a mark on your floor stops responding to its slider,
you have written down a dimension somewhere — and the module you wanted instead was
`DecalSystem.spawn()`, which is allowed to, and does.

---

## `FilamentPaths.js` — every filament in the project

`LightningMaterial` proved the shape of the idea: a vertex arrives as `(t, side)` — how far along
its filament it is and which edge of the ribbon it is on — and leaves as a world position, so *no
path exists on the CPU to go stale*. `SnareMaterial` proved the generalisation: a filament's
**role** is decided in the vertex shader by testing its instance index against a set of live
counts, and the role picks which parametric path it is threaded along, so one strip draws a whip, a
pillar, a crawl of tendrils and a ring of travelling arcs at once — and setting a count to zero
retires that role outright, which is how the snare's leash vanishes on the frame the ring takes
over.

This is that second idea with the snare taken out of it. Nine path modes, four role slots, one
`InstancedBufferGeometry` (`createBoltRibbonGeometry`, the same strip the bolt and the beam's coils
are drawn on), and every metre re-read from the caller's params each frame.

### Draw-call cost

**2. Always.** Four roles or one, forty filaments or three. The strip is drawn twice — a wide soft
halo underneath and the hot core on top — because drawing the glow as *real ribbon* rather than
leaving it to bloom is what keeps it attached to every kink, and it is most of why the original
bolt reads at any distance. Both passes share every uniform box by identity except `uWidthScale`
and `uPassOpacity`, so they cannot disagree about where a filament is.

The budget that shaped the module is the uniform one: the per-role blocks and the chain node table
come to roughly 90 of the **128 vertex uniform vectors WebGL guarantees**. That is why there are
four role slots and twelve chain nodes and not eight and thirty-two. If you need a fifth role you
want a second `FilamentPaths` — two more draw calls — not a wider array.

### Signatures

```js
import {
  FilamentPaths, PathMode, FilamentPass, filamentLook,
  MAX_FILAMENT_ROLES, MAX_CHAIN_NODES
} from '../vfx/FilamentPaths.js';

PathMode = { LINE: 0, HELIX: 1, ORBIT: 2, MEANDER: 3, RIM: 4,
             CHAIN: 5, LINK: 6, SPIRAL_IN: 7, CRACK: 8 }
MAX_FILAMENT_ROLES = 4
MAX_CHAIN_NODES    = 12

new FilamentPaths(parent, {
  samples     = 72,        // nodes along one filament — the ceiling on kink detail
  capacity    = 48,        // hard ceiling on filaments across all roles
  renderOrder = 11,        // halo here, core at +2
  layer       = LAYER.VFX
})

paths.role(i) → FilamentRole     // i in 0..3
paths.object3D                   // the Group holding both meshes
paths.drawCalls                  // === 2
paths.liveCount                  // filaments drawn this frame → Ability#instanceCount
paths.visible                    // get/set

paths.setNodeCount(n) → n        // CHAIN only, clamped 2..MAX_CHAIN_NODES
paths.setNode(i, along, lateral, lift)          // UNITLESS fractions only
paths.nodePoint(roleIndex, i, out) → Vector3    // where the shader will actually put node i

paths.sync(look, fade = 1, seed = 0)   // every frame, including a zero-length one
paths.clear()                          // onDestroy(); leaves it reusable
paths.dispose()

filamentLook() → object    // every canonical key with its default and a unit comment
```

A role, whose setters are all positional and all write straight into the uniform vectors — there is
no options object anywhere in the frame path, because an object literal per role per frame is
exactly the allocation **I3** forbids:

```js
role.count = n                     // 0 retires the role
role.retire()

role.style(kink, width, dim, groundDamp)          // per-role modifiers on the shared look
role.ends(fadeStart, fadeEnd, taperStart, taperEnd)   // 0 square, 1 tapered to nothing
role.draw(progress, tipLength, floorY, tipGlow)       // the travelling front and the floor

role.line(from, to, sag, spreadNear, spread, spreadCurve, twist, twistSpeed, converge)
role.helix(from, to, radius, radiusEnd, turns, spin, sag, phaseSpread, taperCurve)
role.orbit(centre, pole, radius, arc, spin, wobble, tilt, tiltSpread, radiusJitter)
role.meander(centre, up, inner, reach, curve, wander, arch, hug, spin)
role.rim(centre, up, radius, span, speed, lift, jitter, hug, phase)
role.chain(from, to, scatter, lift, sag, bow, lit, hold, overlap, tip)
role.link(from, to, slack, curve, swing, swingSpeed, taut, spread)
role.spiralIn(from, to, radius, radiusEnd, turns, spin, curve, phaseSpread, wobble)
role.crack(from, to, angle, lengthFrac, depthFalloff, spread, start, sag, forkBias)
```

Every one of those returns the role, so `role.line(…).ends(0, 1, 0, 1).draw(u, 0.08, -1e4, 2)`
chains. Argument order is the order of the two `vec4`s the mode fills; the vertex shader carries
the same list beside each branch.

### The modes

| mode | the path, and what it is for |
| --- | --- |
| `LINE` | the bolt — straight axis bowed by `sag`, a fan opening from `spreadNear` to `spread` and rolling with `twist`. The only mode with a loose far end (`converge < 1`) |
| `HELIX` | a coil wound around the axis between two points. Railcoil's barrel, wound rope, a beam's collar |
| `ORBIT` | great slow loops around a point, each on its own inclined plane with its own ascending node. The caged orb — filaments that *circle* rather than radiate |
| `MEANDER` | the snare's tendril: a committed veer running outward, whose curve is a per-filament constant rather than noise, because a discharge that has chosen a direction keeps going that way |
| `RIM` | an arc travelling around a boundary, hopping over it at mid-span |
| `CHAIN` | a polyline through the nodes, **linear between them** and lit hop by hop. Drive it with `ArcNetwork` |
| `LINK` | a real catenary, not a parabola — the difference is all at the anchors, where a hanging chain leaves much steeper, and that steepness is most of what says "heavy". `taut` pulls the sag out for the snap |
| `SPIRAL_IN` | a spiral collapsing from one radius to another as it travels |
| `CRACK` | a branching fracture, three generations walked forward rather than recursed. Filament 0 is always the trunk, so it still reads with the count wound down to one |

### The three stages, which never change

1. **the path** — the role's centreline, `pathAt(t)`. The only part that knows the cast's geometry.
2. **the frame** — a tangent by finite difference on that path and two normals off it. Every offset
   lives in this frame, which is what lets one kink function serve a vertical pillar and a filament
   crawling flat across the floor.
3. **the kinks** — octaves of *linearly* interpolated value noise. Linear on purpose: `smoothstep`
   would round the corners off, and the corners are the entire reason it reads as lightning rather
   than as a wobbly tube. Every mode gets them; set `kink` to 0 on a role that wants a clean curve.

Two clocks run the flicker, both inherited: `restrike` snaps every filament onto a new shape N times
a second, and `crawl` slides the kinks continuously in between.

### Ground-hugging roles

A kink with a free `y` buries half of every filament that runs flat, and the effect reads as a
broken dotted line — the snare learnt this the hard way. Two knobs, both per role: `groundDamp` (the
fourth argument to `style()`) scales the world-`y` component of the kink, 0.3 being the snare's
value, and `floorY` (the third to `draw()`) clamps the result above the floor. Set them on
`MEANDER`, `RIM` and any `CHAIN` that skims the ground; leave them at `1` and `-1e4` in the air.

### Two shader notes worth not re-learning

Uniform arrays are only ever indexed by a **loop counter**. GLSL ES 1.00 guarantees array indexing
only by a constant-index-expression — a for-loop index qualifies, a value derived from an attribute
does not — so the role lookup and the chain-node lookup are both a fixed loop with an `if` inside
rather than the `uFrom[role]` they would obviously like to be. The direct version fails on ANGLE.

ESSL 1.00 also has no hyperbolics, which is why `LINK` carries its own two-line `coshf`.

### The one rule

**Fill the role from `settings[id]` every frame; never keep a metre between frames.** A role's
setters take resolved metres and radians, so the call belongs in `onTravel`/`onFade` next to the
settings read that produced it — never in `onSpawn`. Pause with **P**, drag `spread`, and the
standing bundle must re-fan.

---

## `ArcNetwork.js` — a discharge that hops instead of travelling

Everything else in the project that crosses a distance *travels*: a front moves at metres per second
and the effect is drawn behind it. Chain lightning does not do that. It picks a handful of points,
and then it is at the first one, and then it is at the second one, and the space between them was
never crossed so much as **skipped**. That discontinuity is the whole read, and it is why this is a
module and not a `progress` uniform.

It owns three things and deliberately nothing else — a scatter, a clock and two hooks. It draws
through `FilamentPaths` in `CHAIN` mode; there is no second ribbon renderer here.

### Draw-call cost

**2**, and they are shared: the chain takes one role slot, so the other three are still free.
Hand an existing `FilamentPaths` in as `options.paths` and a chained ability's earthing spikes, rim
ring and chain all come out of the same two calls.

### Signatures

```js
import { ArcNetwork, arcNetworkParams } from '../vfx/ArcNetwork.js';

new ArcNetwork(parent, {
  paths       = null,      // draw through an existing FilamentPaths instead of building one
  role        = 0,         // which of its four role slots to take
  samples     = 96,        // nodes along one filament — higher than the bolt's 72 on purpose
  capacity    = 24,
  renderOrder, layer
})

net.from, net.to        // Vector3 anchors — the caller WRITES these every frame
net.onNode = (index, position, count) => {}   // assign ONCE; `position` is scratch, read it now
net.paths               // the FilamentPaths, for the other three roles
net.object3D
net.drawCalls           // === 2

net.reset(seed)         // onSpawn(): re-roll, rewind the clock, un-fire every hook
net.reseed(seed)        // re-route mid-flight WITHOUT restarting the discharge
net.update(dt, params, fade = 1)              // the whole frame: clock, graph, hooks, sync
net.nodePoint(i, out) → Vector3               // metres — the shader's arithmetic, mirrored
net.clear()             // onDestroy()
net.dispose()

net.nodeCount  net.segments  net.progress  net.arrived  net.firedCount  net.cursor

arcNetworkParams() → object   // the graph, the hops and the clock; also carries filamentLook()
```

The params object doubles as the look — it is handed straight to `FilamentPaths.sync()` — so a
chained ability keeps one scratch, not two.

### The scatter

`nodes` points between the two anchors, stored as **unitless fractions only** (`along`, `lateral`,
`lift`) rolled once per cast from one seed. Not one metre is captured. The metres arrive when the
shader resolves a node against the role's live `scatter` and `lift`, so dragging either re-routes a
chain that is already in the air, and `reseed()` re-routes it outright — which is the trick the
roster asks Chain Arc for.

Two details that are not obvious and are the difference between a chain and a wobbly bolt:

- **the sides alternate.** Two consecutive nodes scattered onto the same side draw a curve, and a
  curve is a bolt. Magnitude still varies, so it does not read as a zip either.
- **the ends are not scattered.** Node 0 is the hand and the last node is the thing that was aimed
  at. Scattering those makes the cast look like it missed.

`along` is derived per frame from the live node count rather than stored, because the count is a
slider: dropping seven nodes to four has to re-space the survivors, not leave a gap where the last
three were.

### The clock

The cursor advances in **hops**, not seconds (`dt / hopTime`), so changing the hop time mid-flight
changes what happens next instead of rewriting what already happened. A hop is dark until the cursor
reaches it, holds at full for `hold` hops, then decays over `overlap` hops:

- `hold 0, overlap 0.6` — a single spark running the chain, one hop lit at a time.
- `hold 8` — the whole chain lights and stays lit; the hops just arrive in order.
- `tip` smears the front *within* the hop it is crossing, so a hop is not a light switch.

`onNode` fires exactly once per node, on the frame the cursor reaches it, with the node's resolved
world position — that is where the burst, the light punch and the decal go. The last node arrives
with `index === count - 1`, which is the ability's cue to move to `IMPACT`.

### The one rule

**Write `from` and `to` every frame, then call `update()` with params filled that frame.** The
network holds dice rolls and a hop counter; it holds no geometry. If you catch yourself caching a
node position between frames, call `nodePoint()` instead — it re-derives it with the same arithmetic
the vertex shader uses, which is the only reason a burst lands *on* a node rather than near it.

---

## `Projectile.js` — things that travel

One to a few hundred bodies leaving the hand (or the sky) and arriving somewhere else: rocks,
needles, hailstones, stars, blobs of magma. The body is caller-supplied geometry on a caller-supplied
material; the flight, the tumble, the arrival clock and the optional trail belong to the module.

Nothing here integrates either. A body's position is a closed-form function of its own τ evaluated
against the live params, so dragging `apex` re-lofts a rock that is already in the air, with the
clock stopped — which an Euler step physically cannot do, because it has already spent the old
gravity.

### Draw-call cost

**2** — one `InstancedMesh` for every body, one instanced strip for every trail. Both are
unconditional; a cast with nothing in the air draws nothing because the counts fall to zero, not
because the meshes were removed. Pass `trail: false` for **1**.

### Signatures

```js
import {
  Projectile, FlightMode, Stagger, projectileParams, spatialStagger
} from '../vfx/Projectile.js';

FlightMode = { LINE, ARC, ROLL, FALL, HOMING, LISSAJOUS, VOLLEY }   // string enum
Stagger    = { AUTO, NONE, RIPPLE, HASH }                           // string enum

new Projectile(parent, {
  geometry,                  // BufferGeometry | (() => BufferGeometry)      REQUIRED
  material,                  // THREE.Material, owned by the ability         REQUIRED
  shapeKey      = null,      // () => string; a change rebuilds the geometry
  capacity      = 48,        // hard ceiling on bodies
  trail         = true,      // build the instanced multi-trail
  trailNodes    = 28,        // samples along one trail
  trailAdditive = true,
  layer         = LAYER.WORLD,
  renderOrder   = 2,
  castShadow    = false
})

field.count          // bodies drawn  → Ability#instanceCount
field.drawCalls      // 2, or 1 without trails
field.trailUniforms  // the trail material's uniforms, for anything params does not cover

field.roll(seed = Math.random() * 100)      // onSpawn(); the only dice roll
field.reset()                               // onDestroy()
field.setBasis(origin, direction, side, length)   // the cast's frame, every frame
field.setTrailColors(a, b, c, d)            // THREE.Color or '#rrggbb'
field.syncGeometry()                        // rebuilds only when shapeKey() moves

field.update(now, params)                   // re-fly everything, allocation-free

field.arrivals        // Int32Array of body indices that landed on THIS frame
field.arrivalCount    // how many of them — consume immediately after update()
field.contact         // ROLL: the contact point on the floor
field.contactLoad     // ROLL: 0..1, what a GroundField(RUT) wants for its depth

field.landPoint(index, out) → Vector3       // where body `index` lands, metres
field.pointAt(index, tau, out) → Vector3    // where it is at τ
field.headingAt(index, tau, out) → Vector3  // unit heading there
field.slotPosition(slot, out) → Vector3     // a *drawn* body, 0 .. count-1
field.dispose()                             // geometry, trail, mesh; the material is yours

projectileParams() → object   // every canonical key with its default and a unit comment
spatialStagger(x, z, cell, seed) → 0..1     // the fill-order hash, exported on its own
```

`now` is the ability's `age` in seconds. Per-instance attributes `aSeed`, `aFlight` (τ) and `aFlash`
(the birth pop) are added to whatever geometry you hand over — the module takes ownership of it and
disposes it, so pass a factory rather than a geometry you are also drawing elsewhere.

### One curve, seven modes

The seven flight modes are not seven integrators. They are seven ways of choosing **two endpoints**;
the curve between them is one formula:

```
p(τ) = mix(launch, land, τ^pathCurve)
     + up   · apex      · sin(πτ)^apexCurve
     + side · weaveSide · (1−τ)^weaveDecay · sin(2π·weaveTurns·τ   + φ)
     + up   · weaveUp   · (1−τ)^weaveDecay · sin(2π·weaveTurnsUp·τ + φ + ψ)
```

A lob is `apex > 0`. A homing bolt is `weave > 0` with a decay that pulls the weave to *exactly*
zero at τ = 1 — which is why seven Lissajous bolts weave apart, cross, and then arrive at one point
on one frame with nothing simulated and nothing corrected. A fall is a launch point shared by every
body, high and behind the caster, so the trails converge in the sky and diverge on the ground; that
parallax is the entire reason the sky feels like it is above you. A roll is two endpoints at
`y = radius` with the rotation taken from **distance over radius** and nothing else, so the body
cannot skate — get that wrong by any factor at all and it is the first thing anyone notices.

That collapse is what makes the trail possible. The alternative — a `switch` on the mode in the
vertex shader — means the GPU needs a second copy of every mode and the two drift apart the first
time someone edits one. Here the GPU needs the *coefficients*, which are uniforms, and the two
endpoints, which are per-instance attributes the CPU has already resolved.

### The trail is one draw call, and it is not a recording

`RibbonTrail` per body would be forty draw calls, forty ring buffers of history, and — fatally — a
trail that cannot be reshaped by a slider, because a history is a record of metres. Instead one
instanced strip carries `(v, side)` per vertex and `(launch, land, timing, dice)` per instance, and
the vertex shader samples the *same parametric flight backwards in the body's own clock*:

```
τ_head = min((now − launchDelay) / flightTime, 1)
τ(v)   = mix(τ_head − trailSpan/flightTime, τ_head, v)
```

After the body lands the tail catches the head up over `trailBurn` rather than the ribbon fading
uniformly: a trail that dims reads as a light going out, one that shortens reads as something that
stopped being made. `pathAt()` in `TRAIL_VERTEX` is a line-for-line mirror of `_pathPoint()` in the
JavaScript — the pair is called out in both files, and it is the one place in this module where
editing half the code silently breaks the other half.

### Staggered arrival is a property of the floor

A zone fill wants forty arrivals spread over a second, and the obvious `i / count` fills the circle
in whatever order the dice handed out — which, because the same dice place the stones, correlates
the fill order with the layout and lets you *see* the loop. `spatialStagger()` hashes the **landing
point** instead, quantised onto a `hashCell` lattice, mixed with a per-cast seed:

- `fillBias` orders by radius: **+1** fills outward from the centre, **−1** inward from the
  boundary, 0 hands the decision to the hash entirely;
- `fillScatter` blends between that clean radial order and the hash;
- `hashCell` decides how the hash clumps. Near zero it is confetti; at about a body's spacing the
  circle fills in *patches* that spread, which is much closer to how weather actually arrives; wider
  than the zone and the whole circle lands as one sheet.

Because the key is a property of the floor and of the seed, the circle fills deterministically for a
given seed and never twice in the same order. `Stagger.AUTO` picks the hash for `FALL`, an index
ripple for `VOLLEY`, and nothing for the rest.

### Arrivals

`update()` re-derives, rather than remembers, whether each body has landed: it raises `arrivals` on
the frame a body crosses τ = 1, and *clears* the flag again if a slider puts that body back in the
air. Consume the list straight after `update()` — that is where the pock, the chip burst and the
bounce go.

### The one rule

**A dice roll is unitless.** `roll()` captures a seed, a bearing fraction, a radius fraction and a
handful of jitters — not one metre, radian or second. Everything with a unit is resolved inside
`update()` from the params, including on a zero-length frame. If you catch yourself wanting to
remember where a body was, ask `pointAt()` again with a smaller τ.

---

## `Swarm.js` — things that flock

Up to a few hundred instanced agents on a shader-evaluated flock: ember birds carrying trails,
leaves stripped off a vine, a blizzard of glyph cards, blood droplets, drifting motes. Five
silhouettes, all signed-distance fields in the fragment shader — no atlas, no alpha map, nothing
loaded.

### Draw-call cost

**1.** However many agents. Two flocks that must differ in *silhouette* are two `Swarm`s and two
draw calls, which is the only reason to build a second one.

### Signatures

```js
import { Swarm, Silhouette, LeadPath, swarmParams } from '../vfx/Swarm.js';

Silhouette = { BIRD: 0, LEAF: 1, CARD: 2, DROPLET: 3, MOTE: 4 }
LeadPath   = { POINT: 0, LINE: 1, ORBIT: 2 }

new Swarm(parent, {
  capacity    = 256,               // hard ceiling on agents
  silhouette  = Silhouette.BIRD,   // initial shape; live afterwards via params
  additive    = true,              // embers add, leaves do not
  renderOrder = 12
})

swarm.count       // agents drawn  → Ability#instanceCount
swarm.drawCalls   // 1
swarm.uniforms    // the material's uniforms

swarm.roll(seed = Math.random() * 100)            // onSpawn(); re-seeds and shifts the lattice
swarm.reset()                                     // onDestroy()
swarm.setBasis(origin, direction, side, length)   // the cast's frame, every frame
swarm.setColors(a, b, c, d)                       // THREE.Color or '#rrggbb'
swarm.update(_now, params)                        // push the live params, allocation-free
                                                  // NB: the clock argument is IGNORED — the flock
                                                  // is driven by frame.uTime inside the shader
swarm.leadPoint(out) → Vector3                    // CPU mirror of leadAt(), for lights and emitters
swarm.dispose()

swarmParams() → object   // every canonical key with its default and a unit comment
```

### Three boid behaviours, none of them simulated

**Cohesion is a lag.** An agent's home is the lead point as it was `lag` seconds ago. Because the
lead is parametric — a point, the cast line, or an orbit — that is one evaluation rather than a
history buffer, and the flock strings out behind the lead and pours round its corners a beat late,
which is most of what cohesion looks like from outside.

**Separation is a lattice.** Each agent owns one cell of an `latticeX × latticeY × latticeZ` grid,
decoded from its instance index and shifted per cast by a wrap-around offset — a bijection, so two
agents cannot claim the same cell. Separation is normally the n² term in a boid solver; here it is
free, and the price is that spacing is authored rather than emergent. **The third lattice axis is
not a distance, it is the lag**, so the formation is genuinely three-dimensional and the guarantee
survives: agents that could collide are the ones in the same rank, and they are the ones on distinct
`(x, y)` cells. A long thin skein is `4 × 2 × 16`; a wall of glyphs coming at you is `14 × 10 × 2`.
The product is the number of *distinct* slots, and asking for more agents than that is the one way
the guarantee breaks.

**Banking is the second derivative.** Position is sampled at t, t−h and t−2h, giving a velocity and
an acceleration; the lateral component of that acceleration rolls the agent's card about its own
heading. This is the one that matters. A bird that turns without banking reads as a leaf, and a leaf
that banks reads as a bird — the roll *is* the species. `h` is a fixed fraction of a second rather
than the frame delta, because the bank must not change when the frame rate does.

The first version separated agents with per-agent noise instead of the lattice. It gave a cloud, not
a flock: independent offsets let agents drift through one another and the whole thing read as smoke
with wings.

### The card, the fold and the edge-on flicker

The base geometry is **three columns by two rows** — six vertices, four triangles. The middle column
is the point: a four-vertex quad can only ever be flat, and a flat bird does not flap, it strobes.
`dihedral` swings the wing columns out of the plane on a per-agent flap phase, so the bird genuinely
goes edge-on at the top of its stroke; `curl` bends the same columns quadratically, which is a leaf.

`billboard` blends the card's basis between the agent's own frame (wing axis, heading, lift) and the
camera's. At 0 a `CARD` is a plate in the world that vanishes as it turns; at 1 it is a sprite that
never does. The interesting value is in between, and it is what the roster asks Glyphstorm for: a
storm that flickers between a wall of symbols and a scatter of bright lines. Two sliders keep the
line legible — `edgeStretch` grows the card as it turns so it never falls under a pixel, and
`edgeGain` lifts its emission, because a collapsing card that does not get brighter reads as a gap
rather than as an edge.

`CARD`'s glyph is a walk of up to six strokes between points of a 3 × 5 lattice, plus a terminal
dot, seeded off the agent. The lattice is what makes the marks read as *writing*: an unconstrained
random walk gives scribble, while snapping the endpoints to a coarse grid makes every card in the
storm share terminals and angles, and a few hundred of those look like an alphabet nobody has taught
you. (For a *legible* alphabet — a seal you can pause and stare at — use `GroundField`'s `RUNE`,
which authors sixteen real letterforms. This one is deliberately cheaper: it is weather.)

### The one rule

**An agent carries a seed and an index, and nothing else.** Every metre — cell spacing, lag, size,
wander — is a uniform resolved from the params each frame, which is why a paused flock re-forms
under the slider. If you catch yourself wanting to store an agent's velocity, the answer is another
`agentAt()` evaluation at `−h`; the flock is a closed-form function of time and that is the only
reason it is free.

---

## `Tube.js` — the parametric tube

`BeamMaterial` with the beam taken out of it. One `(t, a)` grid —
`createBeamTubeGeometry`, the same one Nova Beam is drawn on — placed in world space by a vertex
shader and drawn **three times at three radii**, along one of five parametric paths.

Nothing about the shape touches the CPU, so a tube of any length, any profile and any path costs
the same, and `nodes`/`sides` are the only two numbers that decide how much geometry there is.

It follows the `VolumeHull` half of the params convention rather than the `growthParams()` half:
keys are **prefixed** (`tubeRadius`, `tubeWaveAmp`…) and read straight off the ability's settings
block, so `sync()` can be handed `settings[id]` directly and breaking I1 is not expressible. Two
tubes on one ability — a parent beam and its children — simply take two prefixes.

### Draw-call cost

**3.** Always, whatever the path and however long the column is. Coils, discs and charge orbs are
`FilamentPaths` and `Shell`; this module stops at the column deliberately, so the count stays a
number you can hold in your head.

### The three layers, and why the middle one is inverted

Lifted wholesale from `materials/BeamMaterial.js`, because it is the single best idea in that file:

- **halo** — widest, nothing but a rim term. The atmosphere the tube is shoving out of the way.
- **sheath** — rim-weighted, so it reads as *hollow* and its silhouette edges are its brightest part.
- **core** — narrow, and weighted the **opposite** way: brightest where the view ray runs down the
  barrel and its path through the tube is longest.

Rim-weighted outside, axis-weighted inside, both faces adding: that is a volume integral, cheaply,
and the inversion is the entire reason the middle reads as a solid rod of light rather than as a lit
pipe. Widen `tubeCoreWidth` or push `tubeCoreFill` and the three collapse into one white tube — the
sheath is only legible because the core leaves it room. (`SHELL` became `SHEATH` here only so it
does not collide with the sibling module `vfx/Shell.js`.)

### Signatures

```js
import {
  Tube, TubePath, TubeLayer, TUBE_PATH_NAMES,
  tubeDefaults, tubeKeys, tubeSchema, createTubeMaterial
} from '../vfx/Tube.js';

TubePath  = { STRAIGHT: 0, WHIP: 1, FUNNEL: 2, VINE: 3, ARC: 4 }
TubeLayer = { CORE: 0, SHEATH: 1, HALO: 2 }

new Tube({
  path        = TubePath.STRAIGHT,   // compile-time — one path per tube
  prefix      = 'tube',              // settings-key prefix
  nodes       = 96,                  // samples along the column (WHIP/ARC want them)
  sides       = 26,                  // facets around the barrel
  renderOrder = 11                   // halo; sheath +1, core +2
})

tube.group          // add to ability.group
tube.materials      // { core, sheath, halo }
tube.meshes         // { core, sheath, halo }
tube.keys           // unprefixed → prefixed key map
tube.visible        // get/set
tube.drawCalls      // === 3

tube.sync(c, state, g = settings.global)   // EVERY frame, zero-length included

tube.radiusAt(t) → metres            // THE profile function — place everything against this
tube.pointAt(t, out) → Vector3       // the mean axis
tube.tangentAt(t, out) → Vector3
tube.span                            // metres, origin → target
tube.skirtRadius / tube.mouthRadius  // sugar for radiusAt(0) / radiusAt(1)

tube.tipPoint       // Vector3, live — do not keep the reference
tube.tipSpeed       // m/s, differentiated from the curve, correct at dt = 0
tube.waveSpeed      // m/s the curvature wave itself travels at
tube.crack          // { fired, point, speed, at } — poll it right after sync()

tube.dispose()      // geometry + the three materials

tubeDefaults(prefix = 'tube', path = TubePath.STRAIGHT, overrides = {}) → settings fragment
tubeKeys(prefix)          → { radius: 'tubeRadius', … }
tubeSchema(prefix, path)  → editor folders, path-specific ones included
createTubeMaterial(layer, path) → ShaderMaterial    // if you would rather place the layers yourself
```

`state` carries dice rolls and timestamps **only**:

| field | meaning |
| --- | --- |
| `origin` / `target` | the two ends, world space |
| `side` | lateral reference for the cross-section seam |
| `progress` | 0..1 of the column that exists yet (VINE overrides this with `grow`) |
| `fade` / `widthFade` | master alpha, and the collapse to a thread |
| `seed` | the cast's unitless dice roll |
| `time` | seconds since this path's own beat began — drives WHIP |
| `grow` | VINE: the front, 0..1 |
| `snapAge` | VINE: seconds since the recoil was triggered, `< 0` for not yet |

79 keys; see `TUBE_FIELDS` in the source for the full list with units — the profile
(`radius`/`radiusNear`/`radiusCurve`/`flare`/`flareWidth`/`throb*`), the axis (`wander*`), the
surface (`ripple*`/`streak*`/`flowSpeed`/`bands*`/`spin*`), the three layers
(`coreWidth`/`coreFill`/`coreSharp`/`edgePower`/`sheath*`/`halo*`), the ends
(`muzzle*`/`tip*`), four colours, and the per-path groups below.

### WHIP, and why the crack is not on a timer

A bullwhip cracks because the loop travelling down it carries a fixed energy through a decreasing
mass per length: the loop tightens, and the tip briefly goes supersonic. Two terms reproduce that,
and both of them are **in the geometry**:

1. **the lobe** — a Gaussian bump of lateral offset centred on the travelling wave phase, whose
   amplitude grows as the phase approaches the tip (`tubeWaveGain`);
2. **arc-length conservation** — a whip does not stretch, so the length the lobe eats comes out of
   the axial extent. To first order that excess is `½∫(dy/ds)² ds`, which for a Gaussian has the
   closed form `½·√(π/2)·A²/w ≈ 0.6267·A²/w`, distributed along the whip by the cumulative of the
   same bump.

So while the loop is mid-whip the tip is pulled **back**, and as the loop runs off the end the
lateral offset collapses and the axial extent returns — both at once. That is a speed spike, and it
is a property of the curve rather than of a clock.

`tipSpeed` is that curve differentiated with respect to its own driver — a central difference on the
wave phase, times the phase rate — so it is correct on a **zero-length frame**. Pause the sandbox,
drag `tubeWaveWidth`, and the reported speed changes because the shape did. `waveSpeed` is
`span × tubeWaveRate`, the speed the loop itself travels at. When the first crosses the second times
`tubeCrackRatio`, `tube.crack.fired` is true for exactly that frame and `tube.crack.point` is where
the tip was standing:

```js
this.lash.sync(c, this._state);
if (this.lash.crack.fired) {
  this.shock.reset(this.lash.crack.point);        // the shock ring, at the frame and the place
  this.ctx.shake?.(c.crackShake * this.lash.crack.speed / this.lash.waveSpeed);
}
```

At the shipped defaults the tip peaks around **90 m/s** against a **16 m/s** wave on a 12 m cast, and
cracks exactly once per pass. Tighten `tubeWaveWidth` and it cracks harder; drop `tubeWaveAmp` below
about `0.6 × waveWidth` and it stops cracking at all, which is correct — a slack whip does not bang.

### FUNNEL, and the one function

`radiusAt(t)` **is** the vortex profile — `throat + skirt(t) + mouth(t)`, a tight waist with a skirt
flaring to the floor and a mouth flaring to the top:

```js
const skirtR = funnel.skirtRadius;              // radiusAt(0) — the dust skirt, the ground scour
const debrisR = funnel.radiusAt(u);             // where a debris ribbon rides at height u
const mouthR = funnel.mouthRadius;              // radiusAt(1) — the intake at the top
```

The debris, the dust skirt and the ground scour all read that one function, so dragging
`tubeSkirtFlare` moves every one of them together. The first version of this had the skirt as its
own slider on the ability and the scour as another; they were never the same number twice.

The funnel also leans and precesses (`tubeSway*`), weighted to the top so the foot stays planted on
the scour it is standing in, and the surface spins by rotating the *noise lookup* rather than the
mesh — a circular cross-section rotated about its own centre is a no-op.

### VINE

The front is the length: `state.grow` renormalises `t`, and the radius is
`radius × (1 − s)^tipTaper`, so it genuinely tapers to nothing at the tip rather than being clipped
there. `state.snapAge` starts a damped-cosine spring (`tubeRecoilAmp`/`Freq`/`Damp`) that hauls the
whole curve back and lets it overshoot — a cosine rather than an exponential, because a vine that
only eases back is a vine on a lift. `tipSpeed` reports the snap-back speed, which is what strips
the leaves off.

### The JS mirror, and what is *not* in it

`radiusAt()` / `pointAt()` are a deliberate duplication of `tubeRadius()` / `tubeAxis()` in the
vertex shader. The alternative — reading the shape back off the GPU — is a pipeline stall per query,
and the queries happen several times a frame.

What is **not** mirrored is the `wander` noise: the JS side returns the *mean* axis. A skirt placed
on the noisy axis jitters against the tube it is supposed to hug, and the wobble is centimetres.

### The one rule

**Place everything else against `radiusAt()` and `pointAt()`, never against your own copy of the
numbers.** A funnel whose skirt was sized from `settings.cyclone.tubeThroat * 3` at spawn is a funnel
that comes apart the first time somebody touches a slider.

---

## `Shell.js` — the standing half of the burst vocabulary

`effects/BurstSphere.js` stays exactly as it is and the six shipped abilities go on using it. It is
a **fire-and-forget pool**: you hand `spawn()` a start radius and an end radius in metres and it runs
its own clock to death. That is a captured dimension — the thing I1 exists to forbid — and it is
completely fine there, because a burst lives 900 ms and nobody can drag a slider inside 900 ms.
Retrofitting live re-resolution onto a pool whose whole contract is "spawn and forget" would have
meant every existing caller passing a settings object it does not have.

What the roster needs instead is shells that **stand**: a thunderclap dome that holds while three
pressure fronts cross it, a resonant chord's ring train running for two seconds, a sun disc lying on
the floor while you tune the corona licking off its rim. Those are owned by the ability, live in its
group, and re-resolve every metre from settings on every frame.

So **`BurstSystem` owns the transient vocabulary and `Shell` owns the standing one**, and both are
re-exported from `Shell.js`, because from an ability's point of view they are one vocabulary with two
lifetimes and having to remember which file a hemisphere lives in is exactly the friction the tech
library exists to remove.

### Draw-call cost

**1 per shell.** Two geometry kinds cover all five modes, and that economy is the good idea in the
file:

- **the `(t, a)` surface grid** (`createBeamTubeGeometry`, the same grid the beam and `Tube.js` use)
  — map `t` to a quarter polar sweep and it is a dome, a half sweep and it is a sphere, distance
  along an axis with a rising radius and it is a cone. One grid, three silhouettes, no new geometry
  builders;
- **the instanced annulus** (`createBeamRingGeometry`) — one instance is one ring. That is the ring
  train, and with a single instance and an inner radius of zero it is also the sun disc.

### Signatures

```js
import {
  Shell, ShellMode, SHELL_MODE_NAMES,
  shellDefaults, shellKeys, shellSchema, createShellMaterial,
  BurstSystem, BurstMode            // re-exported: the transient half
} from '../vfx/Shell.js';

ShellMode = { DOME: 0, CONE: 1, RING_TRAIN: 2, SUNDISC: 3, PRESSURE: 4 }

new Shell({
  mode        = ShellMode.DOME,   // compile-time
  prefix      = 'shell',
  nodes       = 48, sides = 48,   // surface-grid tessellation
  rings       = 24,               // RING_TRAIN instance capacity
  segments    = 96,               // facets around one ring / the disc
  renderOrder = 14
})

shell.group / shell.mesh / shell.material / shell.keys / shell.visible
shell.drawCalls        // === 1
shell.instanceCount    // rings drawn → Ability#instanceCount

shell.sync(c, state, g = settings.global)   // EVERY frame

shell.radius           // metres, live — what the rim is standing on
shell.span             // metres — the cone's length, the train's line

// RING_TRAIN only:
shell.standingAt(s) → 0..1          // the standing-wave amplitude s metres along
shell.nodeSpacing                   // metres between nodes (half a wavelength)
shell.nodeCount
shell.nodePosition(i, out) → Vector3   // node 0 is the reflecting far end
shell.resonantSpacing(n) → metres      // the λ that fits exactly n half-waves

shell.dispose()

shellDefaults(prefix = 'shell', mode = ShellMode.DOME, overrides = {}) → settings fragment
shellKeys(prefix) / shellSchema(prefix, mode) / createShellMaterial(mode)
```

`state` is `{ origin, axis, side, span, t, fade, seed }` — `axis` defaults to world up, `span`
overrides the settings value with the cast's own length, and `t` is the ability's normalised life.
44 keys: the expansion (`radius`/`radiusEnd`/`expand`/`height`/`lift`), the surface
(`displace`/`noise*`/`turbulence`), the shading (`fill`/`rim`/`rimPower`/`dissolve` plus the
mode-specific `seal*`, `edge*`, `coneCurve`), the ring train, the sun disc, and four colours.

`shellDefaults()` tunes itself per mode, because a pressure front and a sun disc want opposite
numbers out of the same block — one is 95% rim, the other is a solid face with filaments coming off
it.

### RING_TRAIN, and the standing wave

Resonant Chord's whole trick, so it is worth being exact.

Rings launch at the origin `shellSpacing` metres apart and travel out at `shellRingSpeed`. At the
far end they **fold** — `s = span − |d − span|` on a `2·span` cycle — so a ring runs out, turns
round and comes back. Outbound and returning rings cross, and where they cross they add.

The interference is not faked. Superposing the outbound wave with its reflection off a fixed end,

```
sin(ks − ωt) − sin(k(2L − s) − ωt)  =  2·cos(kL − ωt)·sin(k(s − L))
```

— a spatial envelope `|sin(k(s − L))|` with a node at the far end and every half-wavelength back
from it, times a temporal term that pulses the whole line together. That identity is three lines of
GLSL. Each ring reads the envelope at its own position: at a node it pinches to the axis and goes
dark, at an antinode it blooms and swells by `shellSwell`. The nodes are visible because they are
actually there.

`shellReflect` fades between a plain travelling train (rings die at the far end) and full
reflection, which is what a lossy end does. `resonantSpacing(n)` is how you make the nodes stand
still instead of drifting:

```js
c.chordSpacing = this.chord.resonantSpacing(c.chordHalfWaves);   // an integer slider
this.chord.sync(c, this._state);
for (let i = 0; i < this.chord.nodeCount; i++) {
  this.chord.nodePosition(i, _pos);                              // put the dust where the air is still
}
```

### SUNDISC, and the spokes it does not draw

The corona is ridged noise sampled **in the plane** and domain-warped, then masked to the annulus
just outside the rim. The obvious implementation — sampling on `atan(y, x)` — hands every radius
along a given bearing the same value and draws dead-straight spokes out of the centre: a firework,
not a corona. The bolt's ground burns learnt this the hard way, and the lesson applies to anything
radial.

`shellCoronaReach` is how far past the rim the geometry is drawn and `shellCoronaLength` how far the
filaments actually reach, so the second can be tuned without re-tessellating anything.

### The one rule

**Drive it with a normalised life `t`, never with a captured radius.** The shell interpolates
`radius → radiusEnd` itself on a live easing exponent, so an ability hands it `t = age / duration`
and gets an expansion that reshapes under the sliders while it is standing. An ability that computes
its own metres and pokes them in has thrown away the only reason this module exists.

---

## How the distortion pass works now

Read this before you write an ability that refracts anything. It is the one part of the tech
library that reaches outside `src/vfx/`, and the README's "Known rough edges" used to say the pass
existed but that nothing wrote to it.

**The chain, end to end.**

1. A `DistortionField` puts a mesh on `LAYER.DISTORTION`. That layer is *not* enabled on the main
   camera — `CameraRig` enables `WORLD` and `VFX` and nothing else — so the mesh is invisible to
   the ordinary render.
2. `PostProcessing._renderDistortion()` swaps the camera's layer mask for `DISTORTION`, clears a
   HalfFloat target to `(0.5, 0.5, 0, 0)` — "no offset, no coverage" — draws the layer into it, and
   puts the mask back.
3. `DistortionShader` runs as a composer pass between the scene and bloom, and resamples the frame
   at `vUv + offset`.

**What a fragment writes.**

```
R,G  a unit screen-space direction, encoded as d * 0.5 + 0.5
B    the magnitude, in screen widths at uScale = 1
A    coverage — the blend weight between overlapping emitters
```

and what the pass applies is

```
offset = (rg - 0.5) * 2 * b * settings.post.distortion * settings.global.distortion
```

**Six things that will bite you if you do not know them.**

- **Magnitudes are screen fractions, not metres.** `strength = 1` on a fragment shifts the frame
  under it by a full `post.distortion` of screen *width*, at any distance. That is deliberate: an
  authored strength then means the same thing on every cast, and the thing that genuinely should
  shrink with distance — the *area* being warped — already does, because the emitter is real
  geometry. `perspective` (0..1, with `perspectiveRef` in metres) is the opt-out.
- **Never multiply `settings.global.distortion` or `settings.post.distortion` into your own
  strength.** The pass applies both, once. Folding them in at the writing end means one ability
  applies them twice and the next one not at all.
- **Coverage is `a²`, not `a`.** The buffer is normal-blended, so an emitter at coverage `a` writes
  `rg` *and* `b` already scaled by `a`, and the decode multiplies them together. The pass used to
  multiply by `a` a third time; that is fixed, but the square remains and it is the honest price of
  expressing "who wins where two distorters overlap" in one blend mode. Author your masks knowing
  the feather is squared.
- **Later `renderOrder` wins.** Overlapping emitters blend by coverage, so the one drawn last with
  near-full coverage takes the direction. A lens over a heat plume needs the higher order.
- **The pass self-skips.** `core/Layers.js#distortionWriters` counts the meshes currently *visible*
  on the layer; at zero, `PostProcessing` skips the clear, the draw and the resample. Toggle
  `field.visible` — do not just hide the parent group and leave the counter retained, and do not
  add a raw mesh to the layer without retaining. An emitter that is never released keeps the pass
  running for the rest of the session.
- **Occlusion is the depth prepass, not a depth buffer.** The offset target has no depth
  attachment. Emitters reject fragments behind opaque geometry by sampling `frame.uSceneDepth`
  themselves — that is `depthReject` / `depthFade`. It only knows about `LAYER.WORLD`, so the floor
  and the character occlude the warp and other VFX do not.

**Turning it off.** `settings.post.distortionEnabled` kills the pass outright, and
`settings.post.distortionScale` (0.25 … 1, default 0.5) sets the offset buffer's resolution as a
fraction of the frame. Both are in the editor under **Post processing**. 0.25 is still perfectly
smooth, because nothing written into this buffer has an edge sharper than a metre.

---

## `Distortion.js` — the pass that used to do nothing

**What it draws.** Nothing you can see. It writes screen-space UV offsets into the half-resolution
refraction buffer, and what you see is the rest of the frame moving.

**Cost.** One draw call per emitter, at `post.distortionScale` of the frame, into a buffer nothing
else reads. A `BLADE` with `edge: true` is two, because the bright hairline is emissive geometry on
`LAYER.VFX` and an offset buffer has no colour channel to put it in.

**Reads from settings.** Nothing directly, with one exception: `update()` mirrors
`post.distortion × global.distortion` into `uPostScale` so the lens's non-inversion guard can be
exact. Everything else arrives in the params object.

**The one rule.** Author the *mask* and the *strength* separately. Every mode already has a shape
term that dies at its own boundary; `strength` is the amplitude and nothing else. Emitters that
carry their falloff in the strength cannot be faded out without changing their silhouette.

### The five modes

| mode | facing default | what it is |
| --- | --- | --- |
| `HEAT` | `UPRIGHT` | rising shimmer above a hot region, advected upward **in world space**, biased hard toward the base |
| `LENS` | `BILLBOARD` | radial displacement going as 1/r² inside a falloff — a gravity well that bends the floor, the character and every particle behind it |
| `SHOCK` | `BILLBOARD` | a travelling ring of compression then rarefaction, up to four concentric fronts |
| `BLADE` | `WORLD` | a razor-thin plane of pure refraction with a hairline at its cutting edge |
| `REFRACT` | `WORLD` (hull) | a generic hull that refracts along its own normal — water, glass, prisms, panes of frozen time |

`DistortionFacing` decides how the quad is oriented, and everything except `WORLD` is built in the
vertex shader from `uAnchor` and the view matrix — the mesh's own transform stays identity, so
moving an emitter is a uniform write:

- `BILLBOARD` — squarely at the camera.
- `UPRIGHT` — local +Y is world up, local +X is camera-right flattened against it. Heat rises
  vertically whatever the camera is doing; a full billboard makes a plume lean over when you orbit,
  which reads as wind.
- `GROUND` — flat on the floor, local +X/+Y along world +X/+Z. Shock rings and ground lensing.
- `WORLD` — placed by `setBasis(along, up)`. Blades and panes.

### API

```js
import { DistortionField, DistortionMode, DistortionFacing } from '../../vfx/Distortion.js';

new DistortionField({ mode, facing?, geometry?, edge?, renderOrder?, name? })
  .object3D                       // add to the ability's group
  .visible = true|false           // retains / releases the pass's writer counter
  .setAnchor(v3) / .setAnchorXYZ(x, y, z)
  .setBasis(alongV3, upV3)        // WORLD facing, re-orthogonalised
  .update(params)                 // every frame, zero-length ones included
  .dispose()
```

Supplying `geometry` switches the emitter to hull mode: it uses the mesh's own matrix and normals,
`object3D` becomes something you position and scale in the ordinary way, and `REFRACT` is the only
mode that means anything.

### Params

Everything is optional and falls back to a visible-but-neutral default. **Anything you leave out is
a value the editor cannot reach**, which is an I1 violation waiting to be filed as a bug.

*shared* — `width` `height` (metres, the quad), `strength` (screen widths at `post.distortion = 1`),
`opacity`, `seed`, `depthReject` (0..1), `depthFade` (metres), `perspective` (0..1),
`perspectiveRef` (metres).

*`LENS` + `SHOCK`* — `radius` (metres, the falloff edge), `window` (0..1 of radius where the falloff
starts), `maxOffset` (hard ceiling).

*`LENS`* — `core` (0..1 of radius, the 1/r² clamp), `invert`, `fold`, `swirl`.

*`SHOCK`* — `wave` (metres, the wavefront), `thickness` (metres), `compression`, `rarefaction`,
`rings` (1..4), `ringGap` (metres), `ringDecay`.

*`HEAT`* — `frequency` (cycles/m), `speed` (m/s), `sourceBias` (exponent), `spread`, `vertical`,
`flicker`.

*`BLADE`* — `cut` (0..1 along its length), `grazing` (exponent), `edge` (0..1 of the height),
`edgeGain`, `wake` (0..1 of the height), plus `edgeColor` and `edgeGlow` with `edge: true`.

*`BLADE` + `REFRACT`* — `ripple`, `rippleScale` (cycles/m), `rippleSpeed` (m/s).

*`REFRACT`* — `power` (rim exponent; 0 flattens it to a uniform pane).

### The tricks worth knowing

**The constant varying.** A radial emitter needs, per fragment, the screen-space direction pointing
away from its centre. Interpolating a per-vertex "direction from the centre" across the quad is
correct at the four corners and visibly wrong everywhere in between. But a varying whose value is
*identical at every vertex* interpolates to exactly that value, perspective correction or not — so
the vertex shader projects the anchor once, hands the constant down, and the fragment differences it
against its own clip position. Exact everywhere, for one extra matrix multiply. `vAxX` / `vAxY` are
the same trick applied to the screen image of one metre along each axis, which is what lets a
plane-space wobble come out pointing the right way on screen.

**The lens does not invert unless you ask.** Sampling *outward* from the centre — the default —
pulls distant imagery in toward the well and can only ever run off the edge of the frame. Sampling
inward (`invert: 1`) runs the sample point through the centre and out the other side, which flips
the image. Real, occasionally wanted, never by accident: with `fold: 0` the magnitude is clamped to
exactly the screen distance back to the centre, using the post pass's own gain, so the core packs
down to a point and stops. `core` clamps the 1/r² denominator so the middle is a finite smear rather
than a NaN; below about 0.08 it samples far enough out to read as a mirror, which is also a look.

**The shock profile is one expression.** `d·exp(0.5 − d²)`, the derivative of a Gaussian: ±1 at
`d = ∓1/√2` and crossing zero exactly on the wavefront. Compression just inside, rarefaction just
outside, no seam between them. The first build used two smoothsteps back to back and the join was
visible as a stationary ring inside a moving one.

**Heat is sampled in world space.** The noise is advected upward through a column that stands still,
so orbiting the camera does not drag the pattern along — the tell that gives a screen-space heat
haze away instantly. The column widens with height rather than being a rectangle of wobble, because
hot air entrains cold air, and `sourceBias` pushes the amplitude hard toward the base because the
whole read is "this is coming off *that*". A plume of even strength top to bottom looks like fog.

**A blade is visible because you are never looking squarely at it.** A razor-thin slab shifts what is
behind it along its own surface normal, and the shift goes up as the view runs along the slab
because that is where the path through it is longest — so the whole effect is
`normal projected to screen × (1 − |N·V|)^grazing`. `cut` extends the blade along its own length
rather than scaling it, so the wake it has already opened stays where it was.

### Using it

```js
const _p = new Vector3();
const _d = {};                                   // module scope — I3

createShaders() {
  this.haze = new DistortionField({ mode: DistortionMode.HEAT, name: 'sunspear.haze' });
  this.group.add(this.haze.object3D);
}

onSpawn() {
  this._seed = Math.random() * 10;               // a unitless dice roll — allowed
  this.haze.visible = true;
}

onTravel(dt) {
  const c = settings.sunspear;                   // every metre, this frame
  this.haze.setAnchor(this.pointAt(this.u, _p));
  _d.width = c.hazeWidth;
  _d.height = c.hazeHeight;
  _d.strength = c.hazeStrength * (1 - this.u * c.hazeDecay);
  _d.frequency = c.hazeFrequency * settings.global.noiseFrequency;
  _d.speed = c.hazeSpeed * settings.global.noiseSpeed;
  _d.seed = this._seed;
  this.haze.update(_d);
}

onDestroy() { this.haze.visible = false; }       // releases the writer counter
dispose()   { this.haze.dispose(); super.dispose(); }
```

---

## `Portal.js` — a hole, not a decal

**What it draws.** A disc or a slit with a different world behind it: a parallax starfield and
nebula, a white-hot fracture rim, a crown of radial cracks, and an opening progress that tears
rather than scales.

**Cost.** One draw call, one material, no textures — the starfield is a hashed lattice and the
nebula is fbm, both evaluated in the shell's own tangent plane.

**Reads from settings.** Nothing. Everything arrives in the params object.

**The one rule.** `parallax` is the single most important number in the module and it must not be 1.
See below.

### Three things make it read as a hole

**1 — It occludes.** Everything else in this sandbox is additive light laid over the stage; a portal
has to *remove* the stage. The material uses premultiplied-alpha custom blending
(`ONE, ONE_MINUS_SRC_ALPHA`), which is the whole reason this is one draw call instead of two.
Premultiplied output lets a single fragment be both *opaque black* (`rgb ≈ 0, a = 1` — the void
genuinely covers the floor) and *pure additive glow* (`rgb = hot, a = 0` — the fracture rim adds over
whatever is behind it) depending only on what it writes. A normal-blended pass cannot express the
second and an additive pass cannot express the first, so the naive build is two meshes fighting over
the same SDF.

**2 — The interior parallaxes, at the wrong rate.** For each of three star shells the view ray is
continued *through* the portal plane to a depth in metres behind it, and the starfield is sampled
where it lands. That alone is geometrically correct parallax — and geometrically correct parallax
looks like a window. `parallax` then scales the lateral part of that shift away from 1, so the
interior slides against the camera faster than the geometry says it should, and *that mismatch is
the illusion*. Set it to 1 and the portal collapses into a hole in a wall; set it to 1.6 and it
becomes a hole in space. The lateral shift is scaled rather than the depth on purpose: scaling the
depth would also change how big the stars are, which is a different lie and a worse one.

**3 — It tears.** `open` does not scale the aperture. The aperture is always full size; what `open`
sweeps is a **threshold on a field**, and that field is the normalised distance to the seam
multiplied by a noise sampled *in metres* — so the crack grain is a fixed physical size, a two-metre
rift and a six-metre rift tear with the same size of shard. Different bearings therefore open at
different rates, the boundary is ragged, and it is ragged in the *same places* on the way closed. A
portal that scales is a sprite growing; a portal that tears is something being forced.

`seam` picks which bearings go first: 0 unzips from the centre (a disc), 1 from the long centreline
(a slit, which is what makes it read as a wound rather than as an iris).

### Depth at the edge

`depthTest` on, `depthWrite` off — the correct pair for a transparent that must be hidden by nearer
opaque geometry. Walk the character in front of a rift and the rift is behind them. What it will
*not* do is hide transparents drawn after it, because they are not tested against something that
never wrote depth. If an ability needs the void to swallow its own particles, construct with
`writeDepth: true` and accept that the aperture then punches a hole in the transparent queue with a
hard alpha-tested edge — and that the additive crown is dropped, or every crack would punch a
rectangle out of the queue with it.

### API

```js
import { Portal } from '../../vfx/Portal.js';

new Portal({ billboard?, writeDepth?, renderOrder?, name? })
  .object3D
  .visible = true|false
  .setPlacement(anchorV3, alongV3, upV3)   // normal comes out as along × up
  .update(params)                          // every frame
  .dispose()
```

### Params

*shape* — `radiusX` `radiusY` (metres, half-extents; equal makes a disc, unequal a slit), `margin`
(0..1 of extra quad so the cracks have somewhere to go), `seed`, `opacity`.

*the tear* — `open` (0..1, **not** a scale), `seam` (0 centre, 1 long centreline), `tearJag` (0..1),
`tearScale` (cycles per metre of crack grain), `tearCrawl` (Hz), `edgeSoft` (0..1 of the field).

*the fracture* — `rim` / `rimGlow` / `colorRim`, `core` / `coreGlow` / `colorCore` (the white-hot
line inside the band), `throat` / `throatGlow` / `colorThroat` (the soft inner glow), `crackCount` /
`crackWidth` / `crackLength` / `crackGlow` / `colorCrack`.

*the interior* — `parallax`, `swirl` (rad/s), `interiorFade`, `colorVoid`; three star shells as
`starScaleA/B/C` (stars per metre), `starDepthA/B/C` (metres behind the plane), `starDriftA/B/C`
(rad/s) and `colorStarA/B/C`, plus the shared `starSize`, `starTwinkle`, `starGain`; and the nebula
as `nebulaScale`, `nebulaSpeed`, `nebulaGain`, `nebulaDepth`, `colorNebulaA`, `colorNebulaB`.

Ten colour pickers, and not one is derived from another.

### A note on the crack crown

The radial fractures are gated to *strictly outside* the aperture boundary. The first build
multiplied by `step(0.0, outside)`, which is 1 at `outside == 0` and therefore 1 across the entire
interior — every crack ran unbroken to the centre of the hole. Dead-straight spokes out of a middle:
a firework, not a fracture. The same lesson `ThunderAbility`'s ground burns teach, arrived at from
the other direction. The angular distance also wraps, or a crack whose bearing lands near a cell
boundary is sliced in half and the crown grows a seam you cannot unsee.

### Pairing it

`Portal` deliberately writes no screen-space offsets, because an ability that wants a hole does not
always want the frame warped around it. For the ring of bent floor at the edge — Void Rift's read —
put a `DistortionField` in `LENS` mode at the same anchor with a radius a little past `radiusX` and
a low `strength`. Two draw calls, and the floor bends into the hole.

### A trap that cost an hour

Both of these modules keep their GLSL in tagged template literals, and **a backtick inside a shader
comment terminates the string**. It fails as `SyntaxError: Unexpected identifier` pointing at a line
in the middle of the shader, which is not an obvious read. Do not write `` `uSourceBias` `` inside a
GLSL comment; write `uSourceBias`. Backticks in the *JSDoc* above the template are fine.

---

## `VolumeHull.js` — a raymarched volume inside a proxy hull

`VolumetricFireMaterial` with the fire taken out of it, and a hull enum bolted on. One mesh — a unit
BOX, CYLINDER, CONE, DOME or SPHERE — whose fragment shader fires a ray from the camera, intersects
the hull **analytically in the hull's own frame**, and integrates a procedural density field front
to back, compositing with premultiplied "over" and clipping every sample against the opaque depth
prepass so the volume fades into the floor and the character instead of cutting a line across them.

Nothing is a texture. The field is trilinear value noise, a domain-warped fbm, and — for `GAS_BOIL`
— a cellular lattice of bubbles on individual timers.

This is the most expensive thing in the expansion. The cost section below is not decoration.

### Draw-call cost

**One.** Always one, whatever the hull and whatever the medium. The eight media are `#define`d
variants of a single fragment shader rather than eight shaders, because a raymarcher is expensive
enough to *compile* that eight copies of the identical four hundred lines would be a visible hitch
the first time a school is opened.

### It reads settings through a key prefix, not by bare name

The convention at the top of this file — a params object read as `p.someName ?? default` — is
deliberately **not** what this module does. It takes a settings block and a **prefix**:

```js
hull.sync(settings.plaguebloom, settings.global);   // reads boilDensity, boilSteps, boilColorCore…
```

The reason is that a volume is rarely alone. Sanguine Pact wants a mist column *and* a pool; Plague
Bloom wants a boiling cloud over a floor of pustules; Pyroclasm wants ash and, later, smoke. Bare
names collide the moment an ability carries two hulls, and the fix — two params objects with two
different fill functions — is worse than a prefix. Prefixing also means you hand the module
`settings[id]` directly, which is the same I1 guarantee the params convention is after: there is no
intermediate object to forget to refill.

The prefixed key strings are built **once**, when the hull is constructed, and cached per prefix
module-wide. Concatenating forty short strings per hull per frame is exactly the kind of thing I3
exists to stop.

You do not write the block by hand:

```js
export const plaguebloom = {
  range: 20, minRange: 4, speed: 26, cooldown: 1.4, castAnim: 'cast2',
  zoneRadius: 5.0,
  ...volumeHullDefaults('boil', Medium.GAS_BOIL, { boilSteps: 42, boilRise: 0.8 })
};

export const plaguebloomSchema = {
  'The cast': ['range', 'minRange', 'speed', 'cooldown', 'castAnim'],
  ...volumeHullSchema('boil', { label: 'Gas', only: ['march', 'shape', 'field', 'flow', 'optics', 'boil', 'colour'] })
};
```

`volumeHullDefaults` starts from the medium's own tuning — including the palette its ROSTER entry
asks for — so an ash dome starts as ash rather than as grey, and you tune from there.

### Signatures

```js
import {
  VolumeHull, HullShape, Medium,
  volumeHullDefaults, volumeHullSchema,
  VOLUME_HULL_KEYS, VOLUME_SAMPLE_BUDGET,
  HULL_NAMES, MEDIUM_NAMES, disposeVolumeHullGeometry
} from '../../vfx/VolumeHull.js';

HullShape = { BOX: 0, CYLINDER: 1, CONE: 2, DOME: 3, SPHERE: 4 }
Medium    = { FLAME: 0, SMOKE: 1, ASH: 2, SPORE: 3, SAND: 4, MIST: 5, GAS_BOIL: 6, VOID: 7 }

new VolumeHull({
  hull        = HullShape.SPHERE,   // HullShape.*
  medium      = Medium.SMOKE,       // Medium.*
  prefix      = 'volume',           // settings-key prefix
  maxSteps    = 48,                 // compile-time loop cap; uSteps clamps to it
  shadow      = <true unless FLAME | SPORE | VOID>,   // compile the self-shadow tap at all
  additive    = false,              // AdditiveBlending instead of premultiplied "over"
  renderOrder = 12,
  seed        = Math.random() * 97  // unitless dice roll
})

hull.mesh                       // THREE.Mesh — add to the ability's group once
hull.material                   // THREE.ShaderMaterial

hull.place(position, direction = null)   // world anchor; direction is flattened, yaw only  → this
hull.setSize(x, y = x, z = x)            // half-extents in METRES — see the table              → this
hull.setFade(k)                          // 0..1 from the phase clock; 0 hides the mesh          → this
hull.sync(c, g)                          // c = settings[id], g = settings.global                → this

hull.steps                      // steps actually marched last frame, after global.volumeQuality
hull.shadowTaps                 // taps actually taken last frame
hull.cost(coveredPixels)        // field samples/frame; compare with VOLUME_SAMPLE_BUDGET
hull.dispose()                  // material only — the unit hulls are shared

volumeHullDefaults(prefix, medium, overrides)     // → a settings sub-block, prefixed keys
volumeHullSchema(prefix, { label, only })         // → editor folders, ready to spread
VOLUME_HULL_KEYS                                  // bare suffixes, in table order
VOLUME_SAMPLE_BUDGET                              // 20e6
disposeVolumeHullGeometry()                       // app teardown only
```

Per frame, from `onTravel` / `onFade`, **including on a zero-length frame**:

```js
const c = settings.pyroclasm;
const r = c.zoneRadius * c.ashSpread;             // metres, re-resolved here, not captured
this.dome.place(this.position)
         .setSize(r, r * 0.55, r)
         .setFade(1 - t)
         .sync(c, settings.global);
```

### The hulls, and what `setSize` means for each

Local axes in metres, after the vertex stage has applied the size uniform:

| hull | x | y | z | sits on |
| --- | --- | --- | --- | --- |
| `BOX` | ±Sx | 0 → Sy | ±Sz | the floor |
| `CYLINDER` | elliptic radius Sx | 0 → Sy | elliptic radius Sz | the floor |
| `CONE` | mouth radius Sx | mouth radius Sy | apex at 0 → mouth at Sz | nothing — it aims |
| `DOME` | radius Sx | radius Sy (y ≥ 0) | radius Sz | the floor |
| `SPHERE` | radius Sx | radius Sy | radius Sz | nothing |

`CONE` points down **+Z** because +Z is the cast heading everywhere else in the project
(`Ability.direction`). The others stand up +Y because they sit on the ground and gravity does not
care which way the caster is facing. `place()` therefore only ever applies **yaw**: a dome that
pitched with an aim line would lift off the floor at one edge and bury itself at the other.

**The hull does not own its own footprint, on purpose.** In every ability that wants a volume the
footprint already belongs to something else — `zoneRadius`, the cast length, the cone's reach — and
giving the hull its own radius slider would produce two numbers that have to agree and one bug
report per ability when they do not. `setSize()` writes a uniform and rebuilds nothing, so calling
it every frame with metres you have just re-read is free.

That is also why the hull is resized **in the vertex shader** rather than by `mesh.scale` or by
rebuilding geometry: a paused sim (**P**) still has to re-size when a slider moves, and a CPU-side
rebuild cannot happen on a zero-length frame.

### The media

| medium | absorbs | emits | the point of it |
| --- | --- | --- | --- |
| `FLAME` | a little | a lot | the cheap cousin of `VolumetricFireMaterial`. No black-body fit, no vortex roll-up. Use the real one when the flame *is* the ability. |
| `SMOKE` | hard | no | lit entirely by the self-shadow tap. Without the tap smoke is a flat grey blob. |
| `ASH` | hard | embers | smoke plus sparse embers on a hashed lattice, and a downward drift because ash falls. |
| `SPORE` | barely | glints | discrete points drifting in a dim cloud, not the cloud lit up. |
| `SAND` | hard | no | the fbm hard-thresholded, so it reads as a curtain of grains rather than a cloud tinted brown. |
| `MIST` | barely | no | near-uniform, strongly forward-scattering. It is the anisotropy that makes it mist rather than fog. |
| `GAS_BOIL` | hard | pop flashes | see below. |
| `VOID` | very hard | stars only | see below. |

### World space or local space, and which is which

Both are available at every sample for free, because the ray is parameterised once and transformed
twice — see the note about affine maps in `main()`.

- **The silhouette is local.** It *is* the hull. Sampled in world space it would slide out of its own
  proxy the instant the ability moved the anchor, and get sliced along the hull's wall.
- **`FLAME`'s turbulence is local.** A jet's turbulence belongs to the jet; a cone that yaws with the
  caster must take its tongues of flame with it. `Jet` pushes the noise domain along the hull's own
  axis (+Z for a cone, +Y for anything standing up) and `Swirl` rotates it about that same axis.
- **Everything else is world.** A medium sampled in world space keeps a fixed physical grain, which
  is the whole of Pyroclasm's implosion: a dome that contracts reveals *more* grain rather than
  magnifying the same grain, and magnifying the same grain reads as a zoom, not a collapse. It is
  also why two casts landing beside each other do not look like the same cloud printed twice.
- **Embers, glints and stars are world.** They belong to the room, not to the hull.

`Flatten` (0..1) does not squash anything — it **stretches** the noise domain's Y, which makes every
eddy short and wide. Sporefall's cloud pours across the floor because its eddies are pancakes;
squashing the hull alone gives you a low cloud made of round blobs, which reads as a cloud someone
sat on.

### `GAS_BOIL`, which is the interesting one

The density is driven by a cellular field whose cells inflate and pop on **individual timers**, so
the cloud has internal events rather than drifting noise. Each cell's clock is
`fract(t · rate · jitter + offset)`: inflate to 0.55, hold to 0.80, then swell and thin — the pop.

The first version was a 3×3×3 Worley field, which is the textbook answer and is unaffordable here:
twenty-seven hashed cells inside a forty-step march is eleven hundred hashes a pixel before the fbm
has been touched. So each bubble is **confined to its own lattice cell**: jitter the centre by at
most `(1 - size)/2`, cap the radius at `size/2`, and a bubble provably cannot leave its cell — which
makes the containing cell the only cell that can contribute. One hash, no neighbourhood loop, exact.

The price is that bubbles never overlap and the lattice would be plainly visible. One octave of
value noise bending the domain first (`BoilWarp`) buys that back for a single extra tap. Two taps
total, against twenty-seven. Note the radius is **clamped**, not merely scaled, by `BoilPop`: the
containment argument depends on it and the burst swell would otherwise push straight through.

### `VOID` needs no special blend mode, and that surprises people

Premultiplied "over" with a near-black premultiplied colour **is** subtraction. The destination is
multiplied by `(1 - alpha)` and almost nothing is added back, so the dome genuinely darkens what is
behind it. `VoidBite` lets it occlude harder than its own density would, and it works on the *final*
alpha — after the emission has been gathered — which is the only reason the stars survive.

That last point is worth stating as a rule, because it bit: absorption high enough to black the dome
out on its own kills the transmittance in the first half-metre, so every star behind that is
integrated at `T ≈ 0` and never appears. Nightfall's absorption is therefore modest and `VoidBite`
does the blacking-out.

### Cost, which is the whole reason to read this section

```
samples per frame = coveredPixels × steps × (1 + shadowTaps)
```

A "sample" is one field evaluation: an fbm at `Octaves` octaves, each octave eight hashes, so four
octaves is around three hundred ALU ops. The budget for **all** volumes on screen combined:

**`VOLUME_SAMPLE_BUDGET` = 20 000 000 field samples per frame**, roughly four milliseconds on a
mid-range discrete GPU at 1080p — which is what this sandbox has spare once the bloom chain is paid
for. It is a budget, not a measurement; `hull.cost(pixels)` does the arithmetic so you can check it.

| coverage @1080p | steps | taps | samples | verdict |
| --- | --- | --- | --- | --- |
| 10 % (210 k px) | 32 | 0 | 6.6 M | comfortable |
| 25 % (520 k px) | 36 | 0 | 18.7 M | the working limit for a hero volume |
| 25 % | 36 | 1 | 37 M | only if it is the only VFX on screen |
| 50 % | 48 | 1 | 100 M | will not hold 60 fps anywhere |

There is no half-resolution VFX pass in this renderer, so a volume pays full fragment cost. The two
levers, in order of effect, are **coverage** (shrink the hull, or frame it further away) and **taps**
(emissive media need none — `FLAME`, `SPORE` and `VOID` compile the branch out entirely). Dropping
steps is the *last* resort, because it is the one that shows.

Three cost controls are already wired:

- `settings.global.volumeQuality` (defaults to 1 when the key is absent) multiplies the step count
  and the tap count, so the whole expansion's raymarching moves on one slider.
- `setFade(0)` hides the mesh outright. `frustumCulled` is off — the geometry is unit-sized and
  stretched in the vertex shader, so three's bounding sphere describes a one-metre ball that has
  nothing to do with where the volume is — and an invisible-but-drawn hull would keep paying full
  fill rate for a volume nobody can see.
- The march coasts through empty space at a coarser stride and drops back to the fine one the
  instant it hits anything, which buys back most of the cost of the headroom the silhouette needs.

### The one rule

**The hull must be the smallest shape that still contains the field.**

Both failures are ugly and both are common. Too small and the volume is sliced off along a dead
straight line where it meets the proxy — unmistakable, and the single most obvious way this
technique fails. Too big and every ray spends its step budget crossing vacuum, so the volume costs
more *and* resolves less.

The knob that reconciles them is `<prefix>Margin`: it holds the medium's nominal surface that
fraction of the hull inside the wall, leaving the erosion somewhere to push into. Erosion is what
escapes, so the pair to watch is `Margin` against `NoiseStrength` — turn one up and you owe the
other. If you see a straight edge, that is the pair, every time.

### Four traps worth not re-learning

**A backtick inside a GLSL comment terminates the template literal.** Same trap `Portal.js`
documents; this file hit it twice. Write `uMargin`, not the quoted form.

**`packed` is a future-reserved word in GLSL ES.** `commonGLSL`'s `softFade` used it as a local, and
ANGLE rejects it outright — every material that injects the chunk failed to compile on macOS Chrome.
Renamed to `depthBits` there and never used here. If you write a new depth-sampling shader, do not
reach for the obvious name.

**A ridged term built on value noise is bright almost everywhere.** Value noise is a *smoothed*
hash, so its values pile up around 0.5 and `1 - |2n - 1|` therefore piles up around **one**. Embers
taken off a ridged octave came out as red television static covering the whole cloud, and no
threshold fixes a distribution that is wrong at the shape level. Sparse points want a hashed lattice
(`speck()`), which is uniform by construction — `density` then means exactly what it says.

**A medium is only as bright as its scatter-to-absorption ratio.** The integral gathers
`albedo × scatter` and loses transmittance at `absorption`, so a medium whose scatter is a third of
its absorption renders a third as dark as its own palette. Slate-grey smoke came out as a black
hole. If a medium looks too dark, that ratio is the first place to look, not the colour pickers —
and `Ambient`, which stands in for multiple scattering, is what keeps the unlit side grey rather
than absent.

---

## `LiquidSurface.js` — a heightfield that knows how fast it is moving

Lava, blood and water on one displaced plane. The archived `OceanWaterMaterial` raymarched a *body*
of water because a thrown stream has no top and bottom; a pool is the opposite problem — gravity has
already decided where the one surface is, and everything you read off it is a property of that sheet.
So this is a real subdivided plane with a displaced vertex shader, and it costs a fortieth of what
the march did. It is still worth reading `src/archive/materials/OceanWaterMaterial.js`: the sky
floor under the env probe, the two-band displacement rule and the "foam must be a speckle whose
*density* varies, never a smooth function of the wave" rule all came from it unchanged.

### Draw-call cost

**One.** `segments²·2` triangles, no textures. It is *fill*-heavy, not vertex-heavy: the shading
normal is four evaluations of the entire heightfield, and the crust adds a flow field plus two
advected fbm phases on top. Both expensive blocks sit behind `uCrust`/`uFoamSpeed` gates, so water
and blood pay for neither. **Do not stack two of these over the same pixels**, and keep `sizeX` /
`sizeZ` honest — a pool the size of the stage is a full-screen shader.

### Signatures

```js
import { LiquidSurface, LiquidMode, liquidParams } from '../vfx/LiquidSurface.js';

LiquidMode = { POOL: 0, WAVE: 1 }    // WAVE adds one travelling crest that curls and breaks

new LiquidSurface({
  segments    = 96,      // grid per side. <48 facets the Gerstner cusps; >160 is wasted
  mode        = LiquidMode.POOL,
  depthWrite  = true,    // a heightfield is a solid — its crests must hide its far side
  doubleSide  = true,    // required once `crestCurl` folds the sheet over itself
  renderOrder = 3,
  name        = 'LiquidSurface'
})

surface.object3D                       // add to the ability's group
surface.uniforms
surface.drawCalls                      // === 1
surface.visible                        // get/set
surface.mode                           // get/set — a uniform branch, no recompile

surface.setPlacement(anchor, along, up)          // along = the direction a WAVE travels

surface.ripple(u, v, strength = 1, now?) → slot  // u,v are −1..1 FRACTIONS of the half-extents
surface.rippleAtWorld(position, strength = 1, now?) → slot
surface.clearRipples()
surface.reset()                                  // onDestroy(); leaves it reusable

surface.update(now, params)                      // re-resolves every metre, allocation-free

surface.lipPosition(params, out, across = 0) → Vector3   // world point of the breaking lip
surface.lipHeight(params, across = 0) → metres

surface.dispose()

liquidParams() → object   // every canonical key with its default and a unit comment
```

`now` is the ability's `age` in seconds — it is the ripple clock, so it must be the same clock the
ripples were stamped with. `params` is read fresh on every call.

### The four things it does

**1 — Surface speed is a real quantity.** The fragment shader computes an honest 2-D flow in metres
per second: a bulk drift (`flowAngle`/`flowSpeed`), a radial outflow that dies with distance
(`flowRadial`/`flowRadialFall`), eddies taken as the **curl of a scalar noise field** so they swirl
without any point acting as a source or a sink, and **downhill gravity** read straight off the
shading normal (`n.xz / n.y`, free — the normal is already there).

That last term is the one that pays for itself. A ripple from an impact steepens the local slope;
the slope feeds the flow; the flow pushes the surface past `crustBreak`; and the black skin **cracks
open along the ripple front and glows**, healing behind it. Nothing in the code says "crack when
hit". The coupling is real, which is why it reads.

**2 — The crust is a flow map, not a texture.** Coverage is `1 − smoothstep(crustForm, crustBreak,
speed)`. The crack pattern is the **zero crossing of a signed fbm** — continuous, branching,
one-number width, none of which a threshold on `|noise|` gives you — evaluated in a frame built from
the flow direction and squashed along it by `crackStretch`, so the seams run *with* the pour like
pahoehoe rather than crazing like pottery. It is advected by the two-phase cross-fade (sample at
`fract(t/T)` and `fract(t/T + 0.5)`, weight `|1 − 2·fract(t/T)|`), because a single advected layer
smears without bound after a few seconds and that is exactly what makes hand-rolled flow maps look
like melting plastic.

The honest limitation, stated once: a fragment cannot remember when it was last moving fast, so
"the crust re-forms where it is slow" is instantaneous in space and lagged in time only by the
global `crustFormTime` ramp. Real skin has hysteresis. Fixing it needs a ping-pong buffer, which is
a texture, which is **I2**.

**3 — Ripples are analytic and unitless.** A slot holds `(u, v, born, strength)`: a position
*fraction*, a timestamp and a dimensionless strength. Never a metre — **I1**. The shader multiplies
the fraction by this frame's half-extents, so dragging `sizeX` moves standing ripples with the pool,
which is the observable proof the rule is being kept. Each packet is a gaussian-enveloped cosine
riding out at `rippleSpeed`, decaying as `e^{−age/rippleDecay}` and thinning as
`1/(1 + r/rippleSpread)` — the exponential alone kills small pools' ripples in the middle, the
spread alone never kills them at all, and you need both. Eight slots; `ripple()` evicts the *oldest*,
because the newest is the one the player is looking at.

**4 — WAVE mode curls.** The crest is a profile in metres from a front at `waveFront` (a 0..1
fraction the ability drives): a long exponential back against a short exponential face, and that
ratio does more for the silhouette than any noise on top of it. The overhang is Gerstner pushed hard
— horizontal throw proportional to *height* (`crestCurl · h`), so the top of the crest outruns its
foot and the sheet genuinely folds over itself. Where it has folded, the shader thins alpha and adds
a backlight, which is what makes the front face read as lit from inside. `lipPosition(p, out,
across)` hands you the world point of that lip; roll `across` per droplet and emit there.

`lipPosition()` deliberately ignores chop and ripples. You want droplets leaving a clean moving
line; sampling the full field jitters every emitter by the finest octave in it, which reads as a
fault in the emitter rather than as detail in the wave.

### Params

`liquidParams()` in the source is the full list with units. The groups are: the sheet
(`sizeX`/`sizeZ`/`fill`/`round`/`edgeSoft`/`edgeNoise`/`edgeScale`/`seed`/`opacity`/`contactFade`),
the swell (`waveAmpA..D`, `waveLengthA..D`, `waveSpeedA..D`, `waveAngleA..D`, `steepness`), chop
(`chop`/`chopScale`/`chopSpeed` plus the fragment-only `detail`/`detailScale`/`detailSpeed`),
ripples, the flow field, the crust, foam, the travelling wave, and shading — including eight pickers
`colorDeep`, `colorShallow`, `colorCrust`, `colorSeam`, `colorHot`, `colorFoam`, `colorSpec`,
`colorSky`, none derived from another.

`detail` is deliberately invisible to the vertex stage. Displacing by something smaller than a quad
is aliasing, not detail; in the *normal* that same octave is the difference between a wobbling sheet
and a surface. Same split the ocean material documents, same reason.

### The one rule

**Give the surface somewhere to flow.** Every interesting thing the crust does is a function of
`speed`, and a pool with `flowSpeed`, `flowRadial` and `flowEddy` all near zero has a speed of zero
everywhere: uniform unbroken skin, no seams, no heat. Lava wants a radial outflow from where it is
being fed and enough `flowGravity` that a passing ripple can tear the crust. Water and blood want
`crust: 0` and pay for none of it.

---

## `Curtain.js` — vertical sheets of light in air

Instanced sheets with a travelling vertex ripple. Rain, aurora, light shafts.

### The mismatch is the effect

A hanging ribbon and a curtain of aurora are the same geometry. The one thing that separates them is
that on a ribbon **coverage and brightness fall off together** — where the cloth thins it both stops
hiding things and stops being bright. Light in air does not do that. A column of excited gas keeps
emitting long after it has stopped occluding anything, so the top of a real aurora is pure radiance
over a visible sky: bright and transparent at once.

So alpha and emission ride two independent curves —

```
alpha    = mix(alphaTop,    alphaBase,    pow(1 − h, alphaCurve))
emission = mix(emissionTop, emissionBase, pow(1 − h, emissionCurve))
```

— and **they are meant to disagree**. `alphaCurve` well above `emissionCurve` and the sheet stops
covering things halfway up while still throwing light out of its head: that is the aurora. Set them
equal once, look at it, and you will see the hanging ribbon you were trying not to make. For a light
shaft, put `emissionTop` above `emissionBase` so the shaft is brightest where it enters the canopy.

That only works because the output is **premultiplied alpha** (`ONE, ONE_MINUS_SRC_ALPHA`), the same
trick `Portal` uses. One pass writes `rgb = colorBody·α + emissive`, `a = α`, so it can be an
occluding sheet (rain), pure additive light (aurora), or a *darkening* (the wet floor) with no change
but the numbers. `body` is how much α the sheet is allowed at all; set it to 0 for light with no
substance.

### The other thing that matters

A sheet has no thickness, so a ray crossing it face-on passes through nothing and a ray crossing it
edge-on travels the length of a fold. Both alpha and emission are scaled by `1/|N·V|`, clamped at
`grazeFloor`. Without it a curtain is a flat decal identical from every angle; with it the folds
flare as you orbit and the sheet reads as a volume. Two lines, most of the effect.

### Draw-call cost

**One** for any number of sheets — one `InstancedBufferGeometry`, every sheet placed by the vertex
shader. **Two** with the floor companion.

### Signatures

```js
import { Curtain, CurtainMode, CurtainLayout, curtainParams } from '../vfx/Curtain.js';

CurtainMode   = { RAIN: 0, AURORA: 1, SHAFT: 2 }
CurtainLayout = { LINE: 0, RING: 1, SCATTER: 2 }

new Curtain({
  capacity    = 16,      // hard ceiling on sheets
  segmentsX   = 32,      // quads ACROSS a sheet — the ripple lives here, this is the one that matters
  segmentsY   = 16,
  mode        = CurtainMode.AURORA,
  layout      = CurtainLayout.LINE,
  floor       = false,   // build the wet / lit ground companion (+1 draw call)
  renderOrder = 8,
  name        = 'Curtain'
})

curtain.object3D                        // a Group: sheets + optional floor
curtain.uniforms
curtain.drawCalls                       // 1, or 2 with the floor
curtain.instanceCount                   // sheets drawn  → Ability#instanceCount
curtain.visible                         // get/set
curtain.mode                            // get/set — uniform branch, no recompile
curtain.layout                          // get/set — shared BY IDENTITY with the floor

curtain.setPlacement(anchor, along, up) // `up` may be tilted: pass a negated frame.uLightDir
                                        //  and the shafts slant with the stage's own sun
curtain.roll(seed?)                     // onSpawn(); the only dice roll
curtain.reset()                         // onDestroy(); leaves it reusable
curtain.update(_now, params)            // re-resolves every metre, allocation-free
                                        // NB: the clock argument is IGNORED — the sheets are
                                        // driven by frame.uTime inside the shader

curtain.sheetPoint(index, params, out, across = 0, height = 0) → Vector3
curtain.dispose()

curtainParams() → object   // every canonical key with its default and a unit comment
```

For a **wall across the cast** (`stormwall`) pass the cast's *side* vector as `along`, not its
direction — the line you aim is the wall's normal, and that is the whole trick of the slot.

### The modes

- **RAIN** — hashed streak lanes scrolling down the face, each lane with its own speed and duty, and
  the antialias floor out of the archived `WindMaterial`: widen a lane to at least a pixel, then fade
  what is left into the lane's own average once the pitch stops resolving. Without the second half a
  distant curtain is a beating stipple of dots instead of haze.
- **AURORA** — vertical rays from an fbm sampled on the sheet's **length alone**. Feed the height in
  as well (the obvious thing) and the striations break into blotches, because a ray is by definition
  a field that does not vary along a field line. Then a slow three-way hue band, and a distinct
  **hem** of a fourth colour along the bottom edge. Real aurora has that hem; leaving it out is why
  most attempts read as a green rag with a straight cut.
- **SHAFT** — a gaussian core across the sheet (not a smoothstep: a shaft has a falloff, not an edge,
  and a smoothstep draws the plane it is standing in), a fixed per-shaft noise gate along it so each
  one has its own silhouette of leaf gaps, dust motes on a hashed world-space lattice, and `taper`
  below 1.

### The floor companion

One extra quad that walks the **same `sheetFrame()`** the sheets do — the layout uniforms are shared
by identity and the per-sheet dice are mirrored into a uniform array, so a pool cannot drift out from
under its sheet. Three terms, all premultiplied so one pass can darken and add: a Schlick fresnel over
`frame.uEnvMap` on an fbm-perturbed normal (this is what "wet" is — it is the *grazing* reflection
that says so, which is why the fresnel matters more than the reflection does), a falloff around each
sheet's footprint treated as a **segment** so a two-metre sheet gets a two-metre puddle rather than a
circle, and expanding impact rings on a hashed lattice where each cell holds its own phase.

For `SHAFT` the same "pool" term is the disc of light the shaft lands in, which is the reason a shaft
reads as reaching the ground at all.

### Params

`curtainParams()` in the source is the full list with units. Groups: the layout
(`count`/`spacing`/`radius`/`scatter`/`seed`), the sheet
(`width`/`height`/`base`/`taper`/`lean`/`rise`/`riseSpread` and their jitters), the ripple
(`rippleAmp`/`rippleLength`/`rippleSpeed`/`rippleCurve`, the slower `fold*`, the `rippleNoise*` slop,
`phaseSpread`), **the two curves**, the envelope (`body`/`footFade`/`headFade`/`edgeFade`/`graze`/
`grazeFloor`/`softFade`/`opacity`/`glow`/`tintSpread`), the three mode blocks, seven pickers
(`colorA`, `colorB`, `colorC`, `colorHem`, `colorCore`, `colorMote`, `colorBody`) and the floor's own
block including three more (`colorWet`, `colorPool`, `colorRing`). None derived from another.

Per-sheet state is nine **dice** — two for the scatter disc, one for bearing, four for
jitter/width/height/lean, one for phase — and `roll()` is the only place they are written. Every
metre they turn into is resolved in `update()` each frame, which is why a paused curtain re-lays
itself under `spacing` and `radius`. `sheetPoint()` reads the same floats the vertex shader reads, so
a CPU emitter lands exactly on its sheet; it leaves the travelling ripple out for the same reason
`LiquidSurface#lipPosition()` leaves out the chop.

### The one rule

**Make the two curves disagree, and never let a sheet face the camera square-on for long.** The
module has exactly two ideas in it — the emission/alpha mismatch and the grazing path term — and both
of them only show themselves when the curtain is folded and the camera is moving. A flat rank of
sheets seen head-on will look like wallpaper however good the numbers are: give it `lean`,
`rippleAmp` and a `scatter` of half a metre, and put the caster somewhere they will orbit it.

---


## `SceneHooks.js` — the module that changes the world

Every other module in this library draws inside the ability's own group. This one reaches **out** of
it and edits the scene the ability is standing in: it swings the sun, drains the grade, ages the
floor, punches a hole in the frame, inverts gravity, and publishes a region that other abilities'
shaders read and come apart inside.

Seven abilities in `docs/ROSTER-II.md` are built on it — `dawnbreak` and `sheetlightning` (key
light), `eclipse` (grade), `entropy` (material age), `silence` (hole), `hourglass` (gravity) and
`spellbreak` (disrupt).

It is also the only module in `src/vfx/` that is dangerous. Four casts can be live at once, an
ability can be destroyed mid-effect by the concurrency cap or by **C**, and if any one of those
paths can leave the sun pointing sideways or the floor rusted then the sandbox is broken for the
rest of the session and the only fix is a reload. So the graphics in here are deliberately thin — a
depth proxy, a uniform blend, a patch into the floor — and the substance is the **borrow/restore
ledger** underneath them.

### Draw-call cost

Measured in the running app (`gl.info.render.calls`, averaged over 30 frames, empty stage):

| held | draw calls | notes |
| --- | --- | --- |
| nothing | 31 | the baseline frame |
| `KEY_LIGHT`, sun swinging every frame | **31** | *identical* — see below |
| `GRADE` / `AGE` / `GRAVITY` / `DISRUPT` | **31** | uniform writes into things that were already being drawn |
| `HOLE` | **33** | +2: the depth proxy in the depth prepass, and again in the main pass |

The hole's two draws shade nothing — `colorWrite` is off and it is a 32×16 sphere — but they are two
real draws and they are counted here rather than in a footnote.

On the CPU, `apply()` with nothing held is **~1 ns**; with one hook held and written it is **138 ns**,
and with all six it is **≈400 ns**, measured in Node over two million frames. This is not on the
per-frame budget in any meaningful sense.

### Signatures

```js
Hook = { KEY_LIGHT:'keyLight', GRADE:'grade', AGE:'age',
         HOLE:'hole', GRAVITY:'gravity', DISRUPT:'disrupt' }

sceneHooks                                  // the app's singleton — this is what you import
new SceneHooks()                            // your own, for a test harness

hooks.install({scene, environment, ground, grade, renderer})  // App does this once, at boot
hooks.uninstall() · hooks.dispose()
hooks.observe(material)                     // park the live state on userData.uniforms (see below)

hooks.acquire(hook, owner) -> token         // NEVER null
hooks.reclaim(owner) -> number              // the line onDestroy() wants
hooks.releaseAll() · hooks.isHeld(hook) · hooks.driver(hook) · hooks.heldCount
hooks.apply()                               // App calls this once per frame; idempotent
hooks.describe() -> 'keyLight[eclipse < dawnbreak] hole[silence]'

hooks.gravityAt(x,y,z) -> number            // exactly 1 when nothing is held
hooks.disruptAt(x,y,z) -> 0..1 · hooks.ageAt(x,z) -> 0..1

token.hold() · token.release() · token.blend(weight) · token.driving · token.active
  KEY_LIGHT  .aim(azimuth, elevation) · .tint('#rrggbb'|Color) · .brightness(intensity)
  GRADE      .saturate(v) · .temper(v) · .raise(lift) · .darken(vignette)
  AGE        .at(x,y,z)|.atPoint(v3) · .field(radius, edge, amount, inner=0)
             .wear(rust, dust, moss, pit, bleach) · .scale(metres) · .colours(rust, dust, moss)
  HOLE       .at(x,y,z)|.atPoint(v3) · .size(radius, squash=1)
  GRAVITY    .at(x,y,z)|.atPoint(v3) · .well(radius, edge=0.25) · .scale(inside, outside=1)
  DISRUPT    .at(x,y,z)|.atPoint(v3) · .region(radius, edge=0.35)
             .power(drain, fracture, dim) · .shardSize(pixels)

// for a material that wants to read the published fields
disruptUniforms() · gravityUniforms()       // the SHARED boxes — do not clone them
disruptGLSL · gravityGLSL                   // the chunks
patchAgeMaterial(material)                  // any MeshStandardMaterial can be aged
```

Every setter returns the token, so a frame's worth of writing is one chained expression. Every
setter also **renews the lease** — see below.

### The discipline

1. **Borrow.** `sceneHooks.acquire(Hook.KEY_LIGHT, this)` returns a token. Unlike
   `ctx.lights.acquire()` it never returns null: there is no pool to run out of, because the world
   has exactly one of each of these things and sharing it is a question of *ordering*, not of
   availability.
2. **Write, every frame,** from live settings. The setters store on the token; they do not touch the
   world. That is invariant I1 with no room to cheat — the module holds no metre, radian, second or
   colour across a frame boundary, so a paused slider drag reshapes a standing hook.
3. **Apply, once.** `sceneHooks.apply()` runs from `App.frame`, between `post.sync()` and
   `post.render()`, and is the only code in the project that writes to the borrowed world.
4. **Release.** `token.release()`, or `sceneHooks.reclaim(this)` for the lot. Releasing twice is a
   no-op; so is releasing a token that has since been recycled into somebody else's hands, because
   tokens carry a serial and a release has to present the current one.
5. **Or don't, and the module takes it back.** A hook whose token has not been written for **eight
   frames** is reclaimed automatically, with one warning naming the owner.

Step 5 is the net under the trapeze and it is why this is a discipline rather than a hope. The first
version had no ledger: `takeKeyLight()` / `restoreKeyLight()`, paired by the caller. It survived
exactly as long as it took to cast Dawnbreak and press **C** halfway through — `onDestroy()` ran,
`restoreKeyLight()` was called from a path that had already been torn down, and the stage stayed lit
from the horizon until reload.

A holder that legitimately has nothing to say on a frame calls `token.hold()`. Eight frames is 133 ms
at 60 Hz: long enough that a stutter or a dropped frame never trips it, short enough that a leak is
gone before the eye finds it.

### Restore, and why two of the six get it free

`Environment.update()` re-authors the key light from `settings.environment` every frame *before* the
abilities run. `PostProcessing.sync()` re-authors the grade from `settings.post` every frame, just
before `apply()`. Those two hooks are therefore a per-frame **overwrite** of a value that is itself
rewritten from settings on the next frame — stop applying and the world is already exact, not
approximately but bit-for-bit the value the sliders say. `npm run check` asserts precisely that, to
1e-9, after a `reclaim()`.

This is also why `apply()` blends **from `settings`**, never from the live light or the live grade
uniform. Blending from the live value compounds the moment anything calls `apply()` twice, and drifts
in a way nobody would ever find. It costs a duplicate of Environment's four lines of
azimuth/elevation trigonometry, called out in `_applyKeyLight`, and it buys an `apply()` that is
idempotent.

The other four hooks mutate persistent state — a material uniform block, a mesh's visibility, two
published uniform blocks — so each has an explicit neutral (`radius = 0`, `amount = 0`,
`visible = false`, `scale = 1`) and releasing the last holder writes it.

### Last acquirer wins

Two abilities may hold the same hook. Acquiring never fails and never evicts: the new token goes on
**top of that hook's stack** and drives the world, the earlier holder keeps a live token and reads
`token.driving === false`, and it resumes driving the instant the top token is released. LIFO,
skipping anything released in the meantime.

The tie-break is **acquisition order, not write order**, and that is the whole reason everything
lands in one central `apply()` instead of writing through from the setters. With write-through, two
live holders would resolve to whichever ability's `update()` happened to run last in
`AbilityManager`'s iteration — an ordering that is real, invisible, and changes when an unrelated
cast expires. With a stack: cast Eclipse, then Dawnbreak, and Dawnbreak's sun wins; let Dawnbreak
expire and Eclipse's is back on the next frame, mid-cast, with no special case anywhere.

### 1 · `KEY_LIGHT` — the ability moves the sun

```js
onSpawn()    { this._sun = sceneHooks.acquire(Hook.KEY_LIGHT, this); }
onTravel(dt) { const c = settings.dawnbreak;
               this._sun.aim(c.sunAzimuth, c.sunElevation * this.u)
                        .brightness(c.sunIntensity)
                        .blend(c.sunWeight * this.fade); }
onDestroy()  { sceneHooks.reclaim(this); }
```

`weight` is the blend against `settings.environment`, so an ability can take the sun 30% of the way
somewhere and the editor's own sliders still read through. At weight 0 the hook is transparent.

Three things move together and all three matter:

- **`sun.position` and `sunTarget.position`** — what three builds the shadow camera from, so the real
  shadows swing. This is the whole ability: the character, the crystals of a Frost Lance still
  standing, and the floor's own relief all throw a real sweeping shadow.
- **`frame.uLightDir`** — every custom material that fakes its own normal reads this. Miss it and the
  lit meshes swing while the effects stay lit from the old sun, which reads as the effects being
  stickers. This was the bug that took longest to see, because each half looks correct on its own.
- **`shadowMap.needsUpdate`**, defensively. See below.

**What the moved shadow costs: nothing, today, and it was measured rather than assumed.**
`App.frame` already sets `gl.shadowMap.needsUpdate = true` unconditionally on every frame
(`shadowMap.autoUpdate` is off, and the frame renders the scene four times, so the flag exists to
stop the map being rebuilt for each of them). Reading the flag back straight after a frame returns
`false` — three consumed it — so the 4096² directional map is re-rendered **every single frame**
whether the sun moves or not.

Toggling `sun.castShadow` puts a number on what that render is: **1 draw call and 9,578 triangles**,
rasterised into 16.8 M depth texels. Swinging the sun changes what lands in those texels and nothing
else: 31 draw calls idle, 31 with the sun sweeping 90° over thirty frames. **Zero added cost.**

The hook sets `needsUpdate` again anyway, because making shadow refresh conditional is the obvious
win on a stage this static — one static 4096² map, re-rendered sixty times a second, for a scene
where usually nothing has moved — and the day somebody takes it, a swinging sun must not silently
keep last frame's shadows.

The cost that *is* real is a look cost: the shadow map's contents now change every frame, so PCF's
temporal stability goes and a shadow edge that was rock-steady crawls slightly while the sun sweeps.
Slow the sweep, or raise `environment.shadowRadius` for the duration, and it reads as softness.

`sheetlightning` uses the same hook and never calls `aim()` — `brightness()` and `tint()` alone, on a
strobe. One number, and every real shadow in the world snaps at once.

### 2 · `GRADE` — the light goes wrong before anything appears

Four parameters, and they are the four that read as *the world going wrong* rather than as a filter:
saturation, temperature, lift, vignette. Contrast and gain are deliberately absent — they read as a
camera setting being changed, which is a different sentence. The hook honours `post.enabled` exactly
the way `PostProcessing.sync()` does, so an ability cannot switch the grade back on for somebody who
turned the post stack off.

`eclipse` drains colour toward the umbra before the disc ever opens. It is the Thunderclap lesson
applied to light: the anticipation carries it.

### 3 · `AGE` — one parameter ages a real material

A 0..1 field (centre, radius, edge, amount, and an optional inner cut) that `world/Ground.js`'s
`MeshStandardMaterial` reads through a patch. `entropy` sweeps it outward and back — set `inner` and
the disc becomes a travelling annulus, which is what a wave of decay actually wants, because it has a
trailing edge.

Five terms come off that one number, and the reason it does not read as a decal is that each one
moves a **different channel of the material**:

| term | albedo | roughness | metalness |
| --- | --- | --- | --- |
| rust | toward `rustColor`, patchy | up | **up** — the only metal on this floor |
| dust | toward `dustColor`, even | hard up | down |
| moss | toward `mossColor`, in the low-frequency hollows | up | down |
| pit | darkened specks | up | down |
| bleach | desaturate and lift | — | — |

Metalness is what sells rust. The first version graded albedo only, all five terms, and the aged ring
read as a coloured decal painted on clean stone — because that is what it was. Rust that goes
metallic catches the key light at a different angle from the stone beside it, and the eye reads it as
a different substance before it reads the colour at all. That one channel is the trick.

Three noise bands at deliberately incommensurate scales (patch, hollow, speck) keep the five terms
from landing in the same places; sharing one band collapses the whole thing back into a tint. Pitting
is shaded rather than displaced, because the floor is one flat plane with four vertices and stays
that way — every raycast in the project assumes it.

The patch lands at `#include <metalnessmap_fragment>`, the one point in the physical shader where
`diffuseColor`, `roughnessFactor` and `metalnessFactor` are all in scope and still mutable, and it
composes through `patchOnBeforeCompile` so `Ground`'s own tint and sheen patch runs first and is
untouched. It declares its **own** world-position varying rather than reusing `Ground`'s
`vGroundWorld`: one duplicated matrix multiply per vertex, on a plane with four of them, for a patch
that works on any standard material and does not break the day somebody renames a varying in a file
that has never heard of this one.

### 4 · `HOLE` — not black, absent

One invisible sphere, drawn **first** among the opaques, that writes depth and no colour. Everything
drawn afterwards that is further away than its front surface fails the depth test and is never
shaded. What survives in those pixels is the clear colour — `environment.backgroundColor`, the same
flat void the floor already fades into at the edge of the stage. Not a black disc in front of the
world: a pixel the world never reached.

Occlusion comes out right for free, which is the part that would have been fiddly any other way. The
character standing between the camera and the hole is nearer than the proxy, passes the test, and is
drawn. Walk them behind it and they are gone. A shard flying through the volume disappears while it
is inside and is back the instant it clears the front surface. Nothing in the project had to be told
the hole exists.

It sits on `LAYER.WORLD`, so it is in the depth prepass too, so every soft particle in the sandbox
*fades* as it crosses into the hole rather than clipping at it. That was luck, but it is good luck —
and it is also why the hole costs **two** draw calls and not one: it is drawn once into the prepass
and once into the main pass, and both were counted.

**A stencil written by a proxy mesh** was the first design and it does not fit this pipeline without
paying three times. `core/Renderer.js` builds the `WebGLRenderer` with `stencil: false`, so the
drawing buffer has no stencil attachment; `EffectComposer`'s ping-pong targets have none either, and
each would need one added and cleared per pass. That is a stencil buffer on the frame plus two on the
composer plus a clear per pass, for a mask that the depth buffer — which already exists, is already
cleared, and is already being tested against by every draw in the frame — hands over for nothing.
Depth is not a workaround here. A stencil is the tool for a mask that has to *ignore* geometry, and
this mask must not.

**A mask honoured by the final pass** was the second: an analytic sphere in `GradeShader`, projected
to screen space, occlusion-tested against `frame.uSceneDepth`. It has one real advantage — it runs
after `UnrealBloomPass`, so it punches through the bloom as well. Two things killed it. The prepass is
`LAYER.WORLD` only, so it cannot occlude against anything on `LAYER.VFX`: a bolt drawn in *front* of
the hole gets erased along with it, which is exactly wrong. And it is a permanent edit to a shader
every frame in the app runs, to serve one ability.

The caveat that remains, stated plainly: because the hole is punched in the scene pass, a bright
effect beside it still bleeds across the rim by the bloom radius. At the shipped
`post.bloomStrength` of 0.03 it is invisible; crank bloom and cast `silence` next to something hot
and there is a faint halo lying over the void.

### 5 · `GRAVITY` — a signed multiplier, published

```js
this._g.at(x, y, z).well(c.zoneRadius, c.gravityEdge).scale(c.gravitySign, 1);
...
_emit.gravity = c.emberGravity * sceneHooks.gravityAt(x, y, z);   // exactly 1 when unheld
```

A multiplier rather than a replacement vector, on purpose. Everything that falls in this project
already owns a gravity in metres/second² that is a slider on its own block — `ShatterField`'s
`gravity`, a particle system's `uGravity` — and I1 says that number stays the ability's. Handing out
a replacement takes the slider away from whoever is falling; handing out a signed scale leaves it
where it was and lets `hourglass` flip the sign of everything in the zone with one number.

`gravityAt()` on the CPU and `gravityScaleAt()` in `gravityGLSL` are the same falloff, smoothstep for
smoothstep, so an emitter integrated on the CPU and one integrated on the GPU agree at the boundary.

### 6 · `DISRUPT` — the opt-in other abilities join

`spellbreak` is the one ability aware of the rest. Cast into an empty room it is arcane glass
shattering; cast into a standing Nova Beam it desaturates and fragments what is already there.

**Three shared materials already opt in** — `FilamentPaths`, `GroundField` and `Swarm` — and between
them that is most of what is ever left standing in a zone: every bolt, snare, chain and crack; every
ground mark in all ten modes; every flock. No ability file was edited to get there, and none needs to
be.

Joining is one spread and three lines of GLSL:

```js
import { disruptGLSL, disruptUniforms } from './SceneHooks.js';

uniforms: sharedUniforms({ ...disruptUniforms(), /* yours */ })   // the SHARED boxes, not copies
```

```glsl
/* vertex */                         /* fragment */
${disruptGLSL}                       ${disruptGLSL}
varying float vDisrupt;              varying float vDisrupt;
  ...                                  ...
vDisrupt = disruptAt(worldPos);      disruptShade(colour, alpha, vDisrupt, gl_FragCoord.xy);
```

Sample it in the **vertex** stage. The field is smooth over metres, so a varying costs one
interpolant instead of a world position and a distance in every fragment — on a filament strip that
is the difference between free and not.

**Cost when nothing is disrupting:** `disruptAt()` opens with `if (uDisruptRegion.w <= 0.0) return
0.0;`. That is one compare against a uniform, uniform control flow, the same answer for every vertex
in the draw call, and the fragment stage early-outs again on the interpolated 0. It is as close to
free as a shader gets without a recompile, and a recompile is not on the table because the field
switches on mid-cast.

The fracture is a screen-space **cell** dither, not a per-pixel one and not a displacement. There is
no shared vertex stage to push geometry apart in — a ribbon strip, a four-vertex quad and an
instanced flock have nothing in common — so the erosion has to happen in the fragment stage.
Quantising `gl_FragCoord` into cells and erasing whole cells reads as the effect *breaking up*;
the first version dithered per pixel and read as dissolve-into-static, indistinguishable from a fade
at any distance. `shardSize()` is the cell size and it is the slider that matters.

Opting **out** is a design choice, not an oversight: an ability whose trick is that it cannot be
broken simply does not add the lines.

### The pause test, and hook-only abilities

The harness's I1 probe (`docs/EXPANSION.md` §7 step 6) snapshots the uniforms an *ability* owns. An
ability whose entire output is a scene hook owns none, so thirty working sliders read as dead. The
remedy is `sceneHooks.observe(material)` — call it once at construction on any material the ability
already has, and the module's live state is parked on that material's `userData.uniforms` where the
probe can see it. Nothing in any shader reads those uniforms; they are there to be seen. `apply()` is
idempotent, so an ability may also call it at the end of its own `update()` without disturbing the
one that lands the grade.

### The one rule

**Acquire in `onSpawn`, write every frame, and put `sceneHooks.reclaim(this)` in `onDestroy` — then
forget about it.** Everything else in the module exists to make the frame where you *don't* do that
survivable, and none of it is a substitute for the one line. The world is shared; four casts can be
holding pieces of it; and the only version of this that stays correct is the one where returning it
is a reflex.

---


## `LensFlare.js` — the artefact that belongs to the camera

Every other module in here draws something that is *there*. This one draws something that is not:
ghosts bouncing between the elements of a lens, a starburst thrown by the iris blades, and the
horizontal smear a cylindrical anamorphic element puts under a highlight. None of it exists in the
world, all of it exists on the glass, and that one fact decides every line of the file.

Serves `solarlens` (lumen) — *"an occlusion-tested flare … a flare that ignores occlusion is a
sticker on the lens"* — and anything else that wants a bright point to feel bright.

### Draw-call cost

**One.** Up to eleven elements are instances of a single quad: instance 0 is the core and its
starburst, 1 the anamorphic streak, 2 the iris ring, 3..10 the ghost train. The vertex shader places
each one directly in NDC from the projected anchor, so the mesh matrix is identity for its whole life
and moving the flare is a `Vector3` copy into a uniform.

It is fill-heavy rather than draw-heavy — the streak alone is a third of the frame wide — but the
per-fragment work is a handful of `pow`s and no texture fetch at all.

### Signatures

```js
/* LensFlare.js ─ 1 draw call ─ .object3D ─ canonical */
FlareRole={CORE:0,STREAK:1,RING:2,GHOST:3}; MAX_FLARE_GHOSTS=8; lensFlareParams()->object
new LensFlare({ghosts=MAX_FLARE_GHOSTS, renderOrder=3000, layer=LAYER.VFX, name})
f.object3D · drawCalls(1) · capacity · visible(get/set)
f.setAnchor(v3) · setAnchorXYZ(x,y,z) · anchor(out?)->Vector3
f.update(p) · dispose()
  // `ghosts` in the constructor is the CAPACITY; params.ghosts is how many draw.
  // sizes are fractions of the frame HEIGHT — except streakLength, which is a
  // fraction of the frame WIDTH. Occlusion is disabled automatically when
  // frame.uSceneDepth is null (see the traps).
```

### The occlusion test is the module

A flare lives on the lens, so it is drawn after the scene with `depthTest: false` — a ghost that
disappears behind a pillar is a decal, not a lens artefact. But switching the depth test off throws
away the only occlusion the renderer gives you free, and a flare that survives the character walking
in front of the lamp is the tell that has made cheap flares look cheap for twenty years.

So the module buys it back. `frame.uSceneDepth` — the half-res packed-depth prepass of the opaque
`WORLD` layer, already rendered every frame for the soft particles — is sampled at the source's own
screen position **in the vertex shader**, with a small area-uniform disc kernel, and the whole flare
is scaled by the average.

Two things about that kernel are not decoration:

- **One tap does not work.** The first version sampled the source's exact pixel and the flare does
  not dim as the character crosses it, it *switches off*, on one frame, when the silhouette edge
  crosses that pixel — and switches back on the same way. Eleven elements covering a third of the
  screen popping in and out is more distracting than no occlusion at all.
- **The prepass is half resolution and linearly filtered**, and interpolating *packed* depth between
  two texels yields a number that is not a depth. Every `softFade` in the project already lives with
  that; spreading taps over the source's apparent size makes the nonsense a minority of the average
  rather than the whole answer.

The kernel is a golden-angle spiral with `sqrt` on the radius so it covers area evenly. It is
deliberately **unweighted**: a Gaussian puts most of the answer back on the centre tap and brings the
popping straight back. What comes out is an estimate of the *fraction of the source's disc that is
showing*, which is the physically meaningful quantity.

Cost of doing it per-vertex rather than per-fragment: seven taps × four vertices × eleven instances
is 308 depth fetches for the whole flare. Per-fragment it would be of the order of a million.

### Why the ghosts share one blade count

`ghostBlades` is one slider. The ghosts are all images of the same iris, so they all have the same
number of sides; a hexagon next to a pentagon next to an octagon is the most common way a drawn flare
announces itself. What each ghost *does* get is its own size (`ghostSize` × `ghostSizeStep^n`, with a
hashed scatter), its own spin (`ghostSpin` × n), its own roundness (`ghostRound` + `ghostRoundStep`
× n — the far ones defocus into discs) and its own tint off the four-stop `colorGhostA..D` gradient.
Alternate ghosts also invert: bright rim and hollow middle, then the other way about, because they
come off the far surface of the doublet. Turn that off and the train reads as one sprite scaled.

The series is generated from sliders rather than an array of per-ghost records for two reasons. **I1**
— an array of metres is a dimension living somewhere other than a settings block; and a uniform array
may be indexed only by a loop counter in ESSL 1.00, so per-ghost lookups would need the
`if (i == slot)` unrolled loop `FilamentPaths` uses, for values a base, a stride and a hash describe
better anyway.

Two more details that are correct rather than convenient. An **even**-bladed iris throws as many
spikes as it has blades; an **odd** one throws twice as many, because opposite edges stop being
parallel — a five-bladed lens has ten spikes. And every chromatic effect in the module is **the same
shape evaluated at three radii**, one per channel, not a hue rotation of one evaluation: dispersion
is geometry, and a hue rotation gives you a rainbow that slides around as the ghost moves.

### Tone mapping, and the shoulder

The material is `toneMapped: false` at `renderOrder` 3000 with the depth test off, so it is the last
thing in the scene pass and the renderer never puts a curve on it directly. But inside the composer
everything is linear HDR until `OutputPass`, and ACES will take an authored deep-blue streak at 8×
and hand back a white bar — hue clipped, which is the one failure this module cannot have, because
the colour of the streak is the reason it is there.

So the fragment ends with a hue-preserving shoulder: Reinhard applied to the **largest channel**,
all three scaled by the same ratio. `headroom` is the linear value the peak asymptotes to and it is a
slider. The version before it applied Reinhard per channel — textbook, and it desaturates toward
white exactly as hard as the tone curve we were trying to get out from under.

Related: the fragment writes `alpha = 1` and puts everything in `rgb`. three's `AdditiveBlending` is
`(SRC_ALPHA, ONE)`, so writing coverage into alpha as well squares it and quietly darkens every soft
edge in the flare.

### The trap that cost this module an hour

**Never inject `commonGLSL` into a vertex stage.** It carries `aastep`, which calls `fwidth`, and
derivative functions do not exist in a vertex shader; the whole program fails to compile with an
error pointing at a helper you are not using. `LensFlare`'s vertex stage needs exactly two things out
of that chunk — the packed-depth fade and the four-stop gradient — so it restates them locally
against the same `#include <packing>`, eleven lines, and
`scripts/check-vfx-lensflare-mirror.mjs` asserts nobody tidies that back into an injection.

### The one rule

**Give it a source that is actually bright, and let the occlusion do the acting.** The flare is a
consequence, not a light: anchor it to something the scene already lights — a lit projectile, a
`Tube` mouth, a `VolumeHull`'s hot core — and drive `intensity` from that thing's own falloff. A
flare hanging in empty air with nothing under it reads as a UI element, and the moment the character
walks in front of the source and it does not dim, everything else stops working too.


## `Mirror.js` — a planar surface that reflects the real scene

A camera mirrored about the surface's plane renders the `WORLD` layer into a small target, and the
surface samples that target projectively. Serves `blackice` (frost) — *"the only true reflective
surface in the sandbox"* — and `refractcascade` (lumen), whose roster line is blunt about the
alternative: fake it with an environment map and it reads as chrome; do it properly and it reads as
glass.

The reason is **parallax**. An env-map reflection does not slide across the surface as the camera
orbits, and the brain files a static reflection as painted-on shine within about half a second of
movement. That is the whole feature; everything below is the cost of it.

### Draw-call cost

`drawCalls` is **1** — the surface. The reflection is not a draw call, it is a whole extra
`renderer.render()` of the `WORLD` layer: a scene traversal, a render list, a sort and every opaque
draw in the world, again, per rendering mirror per frame.

What it is *not* is a whole frame. No post stack, no depth prepass, no distortion pass, no VFX layer,
and no shadow-map update — the nested render turns `shadowMap.autoUpdate` off and reuses the maps the
main pass already built, which is both cheaper and correct, since the shadows in a reflection are the
same shadows.

**Measured, not estimated.** `mirrorBudget.calls` / `.triangles` and each mirror's `lastCalls` /
`lastTriangles` are read straight out of `renderer.info` immediately after the nested render, so a
mirror reports what it actually cost on your machine in this scene. The arithmetic parts: at the
default 384² a reflection is 147,456 pixels — 16% of a 720p frame, 7% of 1080p — and the target is
384 × 384 × RGBA16F ≈ 1.13 MB of colour plus a depth attachment, so about 1.7 MB per live mirror.
Halving `resolution` quarters the fill and changes the draw count not at all.

Two caveats in writing:

- **`renderer.info` is contaminated on a mirror frame.** `render()` resets the counters at the top of
  every call, so a nested render wipes what the outer frame had accumulated. Anything reading
  `info.render.calls` for a HUD under-reports on frames where a mirror rendered — which is precisely
  why this module publishes its own numbers.
- A mirror that misses its budget slot shows **last frame's** reflection.

### Signatures

```js
/* Mirror.js ─ 1 draw call + one WORLD render per rendering mirror ─ .object3D ─ canonical */
mirrorParams()->object
mirrorBudget = {max:2, live, rendered, skipped, calls, triangles}   // live tally
setMirrorBudget(n)->n            // 0..8; 0 freezes every reflection
new Mirror({resolution=384, layer=LAYER.VFX, reflectLayer=LAYER.WORLD, renderOrder=4,
            doubleSided=true, depthWrite=false, name})
m.object3D · drawCalls(1) · resolution · visible(get/set) · priority
m.lastCalls · lastTriangles      // measured off renderer.info, last reflection
m.setPlacement(anchor, normal, along)   // along is re-orthogonalised; call EVERY frame
m.update(p) · dispose()
  // no renderer handle anywhere: the pass runs from the mesh's own onBeforeRender.
```

### No wiring, and no pass when nothing is visible

`core/Layers.js#distortionWriters` counts the meshes visible on the distortion layer so
`PostProcessing` can skip that pass — clear included — when nothing is writing to it. The lesson is
that a pass which runs with nothing to do is worse than no pass, and this module inherits it twice.

**Structurally**: a reflection is rendered from the mesh's own `onBeforeRender`, which the renderer
calls only for a mesh that is visible and in the render list. No visible mirror, no pass — there is
nothing to skip because there is nothing to run. It is also why this module needs no wiring into
`App` or `PostProcessing`: `onBeforeRender` is handed the renderer, the scene and the camera, which
is everything a reflection needs, and no module under `src/vfx/` has to be given a renderer handle it
has no other use for.

**By cap**: `mirrorBudget.max` mirrors may re-render in one frame, **two** by default.
`refractcascade` puts a line of panes down the cast, and five extra scene renders a frame is not a
cast, it is a slideshow. At the top of each frame every live mirror is scored

```
priority × apparent size × (1 + frames since it last rendered)
```

and the best few get the slots. Apparent size is the bounding radius over the distance to the eye —
near and large beats far and small, which is the order the eye notices a stale reflection in. The
starvation term is what stops the nearest pane hogging the budget forever, and it is unbounded upward
so a mirror that has **never** rendered outranks everything; until it has, `uHasReflection` is 0 and
the surface shows `colorBase` alone rather than an uninitialised target.

At 60 Hz with five panes and two slots each pane updates every 2–3 frames — a 30–50 ms old
reflection, invisible on a slow orbit and a slight lag if you whip the camera. Against 5× the cost
that is the right trade, and `setMirrorBudget()` is there for whoever disagrees.

Selection is a repeated max-scan rather than a `sort`, because a comparator is a closure in the
per-frame path (**I3**), and the live list is never more than a handful of entries.

### The frame token, which is not `info.render.frame`

The scheduler has to know when a new frame has started, and the obvious token is wrong.
`renderer.info.render.frame` increments inside *every* `render()` call — the depth prepass, the
distortion pass, and each of our own nested reflection renders. The second mirror in a frame would
therefore see a different value from the first, conclude a new frame had begun, reset the budget and
render — and so would the third. Every mirror renders every frame, which is exactly the failure the
budget exists to prevent, and it would never show up as anything but "mirrors are expensive".

The module subtracts the nested renders it has itself issued back out of the counter, which makes the
token constant across one traversal. That is all it has to be.

### The oblique near plane

The mirrored camera can see things **behind** the mirror, and they must not appear in it — a floating
pane would show the wall it is hanging in front of, welded to its own face. The near plane is
therefore skewed onto the mirror's plane (Lengyel's oblique projection, following `three/addons`'
`Reflector`, which is the reference implementation in this ecosystem), so everything behind the
surface is clipped in hardware for free. A user clipping plane would do the same thing at the cost of
a `gl_ClipDistance` in every shader in the scene, because three implements those by patching every
material.

A small difference from `Reflector`: this one **flips the plane's normal toward the eye** each frame
rather than skipping a mirror that faces away, so a pane you can walk around works from both sides.
Set `doubleSided: false` for a floor sheet you never see from underneath and get the cull back.

### Roughness, and how it degrades

The lookup is blurred by a jittered golden-angle disc of radius `roughness × blurRadius`, taps
1..12 — so `blackice` starts as a scuffed frozen puddle and sharpens into a black mirror by moving
one slider to 0. Two non-obvious things:

- The jitter hash is on `gl_FragCoord` **and nothing else**. Adding `uTime`, which is the obvious way
  to break up the banding, turns a soft reflection into boiling static: there is no temporal filter
  in this pipeline to resolve it against.
- The kernel is **stretched** along the screen-space direction of the surface normal
  (`roughStretch`). A rough plane does not blur its reflection isotropically; at a grazing angle the
  lobe smears along the view-vertical, which is why a wet road pulls headlights into a vertical
  streak rather than a disc. The stretch direction is a constant-across-the-quad varying, projected
  once in the vertex shader — the same trick `Distortion.js` documents.

The blur radius is also divided by the frame aspect on x, because a wide frame is squashed into a
square target and a circular kernel in that UV space is an ellipse on screen.

`ripple` / `rippleScale` / `rippleSpeed` perturb the lookup with `fbm3` sampled in **world** metres
and scrolled in world metres, so orbiting the camera does not drag the disturbance across the
surface.

### Two guards worth knowing about

- **The depth prepass draws `LAYER.WORLD` with `scene.overrideMaterial` set.** A mirror placed on
  that layer would otherwise render its entire reflection from inside the prepass, into a target the
  prepass then throws away. `scene.overrideMaterial !== null` is the tell and it is the guard.
- **A mirror inside another mirror's reflection is refused, not resolved.** `reflectLayer` defaults
  to `LAYER.WORLD` and mirrors default to `LAYER.VFX`, so it cannot normally arise; if you point a
  mirror at the VFX layer, the second bounce simply does not render.

### Params

`mirrorParams()` in the source is the full list with units. Groups: the surface
(`width`/`height`/`opacity`/`edgeFade`/`corner` — 0 rectangle, 1 ellipse — and `seed`), the reflection
(`resolution` in pixels, `reflectivity`, `fresnel`, `fresnelPower`), roughness
(`roughness`/`blurRadius`/`blurTaps`/`roughStretch`), the disturbance
(`ripple`/`rippleScale`/`rippleSpeed`), `priority`, and two pickers: `colorTint` multiplies the
reflection, `colorBase` is what shows where it does not reflect. Neither is derived from the other.

`resolution` is the only key with a side effect beyond a uniform write — it reallocates the render
target — and it is gated on the value actually moving, so dragging the slider costs one reallocation
per distinct value and nothing on the frames between.

### The one rule

**Put something worth reflecting in front of it, and never let it be the only thing on screen.**
A mirror is only convincing when the thing it shows moves relative to it: the character crossing
behind the camera, a `Tube` beam sweeping past, the floor's own relief sliding as you orbit. And keep
the count honest — five panes at 384² with a budget of two is a cast; five panes with the budget
lifted to five is four extra scene renders a frame, and `npm run check` will not save you from that
one because it costs nothing on the CPU.


---

## `Caustics.js` — the net of light a surface throws on the floor

An animated caustic net projected onto the ground plane. It is the effect a scene with a floor gets
for nothing and this one did not have.

### A caustic is an image of a surface, not a pattern

The reason to build this as a module rather than an ability's own material is the same reason
`GroundField` exists rather than a decal: the interesting thing is not the drawing, it is that the
drawing and something else in the scene are **the same object seen twice**. `tiderush`'s trick is
that you read the wave's thickness off the floor *ahead of* the wave. If the floor is running its
own unrelated loop of squiggles the two never agree, and every viewer works that out in about a
second without being able to say why.

So the pattern is computed from a **height field**, and the height field is pluggable:

| `CausticSource` | the height field |
| --- | --- |
| `SCROLL` | two counter-drifting worley lattices, differenced — the procedural fallback |
| `WAVE` | the Gerstner swell, breaking crest and ripple packets `LiquidSurface` is drawing, **using its uniform boxes** |
| `CUSTOM` | a GLSL chunk you supply, defining `float causticHeight(vec2 xz)` and `float causticRidge(vec2 xz)` |

`bindSource(liquid.uniforms)` is the whole hook. It swaps our boxes for the surface's, by identity,
for every key in `CAUSTIC_BOUND_KEYS` — and `update()` then **skips writing any key that is bound**,
because a number with two authors has none. After one call there is literally one set of numbers
driving the wave and the light under it. Pause, drag `crestHeight`, and both answer, because there
is nothing to keep in step.

### The pattern, and the version that failed

The received recipe is *the difference of two scrolling worley fields, raised to a power*. The first
version here was exactly that, and it is wrong in a way that is hard to unsee once noticed: raising a
cell distance to a power gives you **blobs with soft shoulders**, because a worley field is smooth
everywhere except at its cell walls. Real caustics are the opposite — hairline highlights an order of
magnitude brighter than anything near them, with genuinely black water between. No exponent fixes
that, because the quantity being sharpened is the wrong one.

What is actually happening is a *fold*. Light entering at `xz` refracts and lands at

```
A(xz) = xz − k·D·∇h(xz)          k = 1 − 1/ior,  D = depth in metres
```

and the brightness at the arrival point is the reciprocal of how much that map stretched the patch it
came from: `1/|det J|`, `J = ∂A/∂xz`. Where the map folds, `det J` crosses zero and the brightness
diverges. That singular set is a **curve**, which is why the filament comes out thin without being
told to be; everywhere else `det J ≈ 1` and the floor is black. Both halves of the look come out of
one term.

```
J     = I − a·H(h)                                    a = k·D,  H = the Hessian
det J = (1 − a·hxx)(1 − a·hzz) − (a·hxz)²
```

Six height taps give the Hessian by finite differences. That moves the worley difference **one
derivative earlier** — it is still what `SCROLL`'s height field is made of, but the folds of a
worley-difference surface are the sharp veins along its cell walls rather than the walls themselves.

Two things worth not re-learning:

- **The diagonal tap is not optional.** Drop `hxz` and every fold that is not aligned with the quad's
  own axes disappears, which shows up as a net made of plus signs.
- **The fragment-only detail chop must stay out of the height field.** It is a normal-map wrinkle
  worth a few millimetres and its second derivative is enormous; feed it in and the floor fills with
  a fizzing static of sub-pixel folds that aliases the moment the camera moves. `WAVE` deliberately
  reads `uChop` and not `uDetail`.

### Chromatic dispersion is free, and it is real

Three channels refract at slightly different `ior`, so `a` differs per channel, so the curve
`det J = 0` sits in a *different place* for red than for blue. The fringes are therefore three
filaments a few centimetres apart, not one filament with a hue gradient painted along it — which is
the difference between water and a decal with a rainbow on it. One extra `det` per channel, no extra
taps. `dispersion` is the slider; `0.06` is water and `0.25` is a gemstone.

### Reading the water's thickness off the floor

`absorb` attenuates the net by `exp(−absorb · (depth + h))`, where `h` is the same height the fold
came from. It is one line and it is the term that makes `tiderush` work: the net dims under the body
of the crest and flares in the thin water on its face, with no input beyond the height field that was
already there.

### The projector

Intensity is shaped by the projector's own falloff, never by the pattern:

- **`DISC`** — radial, `penumbra` as a fraction of `radius`.
- **`CONE`** — an apex `projectorHeight` metres up `lightAxis`, half-angle `coneAngle`. Because the
  test is the cosine against the axis, a slanted axis gives a correct **ellipse** on the floor for
  free — which is the whole reason the axis is a parameter and not hard-wired to `+Y`.
- **`LANE`** — a band `laneWidth` either side of local `+Z`, windowed to `spanBack` metres behind and
  `spanFront` metres ahead of `front`. A `LINE` cast's caustics live in a band ahead of the wave; a
  disc there is a spotlight.

### Depth

The quad lies in the ground plane with the depth test on, so the character occludes it. That is not
enough on its own — a floor quad and the floor are within millimetres of each other and a planted
foot gets a hard bright line up its ankle — so the fragment also fades against `frame.uSceneDepth`
over `depthFade` metres, exactly as `GroundField` does. The net dies out as it approaches anything
standing on the floor instead of climbing it.

Output is **premultiplied** (`ONE`, and `ONE`/`ONE_MINUS_SRC_ALPHA` on the destination), the way
`Portal` and `Curtain` are. `AdditiveBlending` was the first version and it is wrong here: it is
`(SrcAlpha, One)`, so it multiplies the colour by an alpha *derived from the colour*, squaring
everything dim. A caustic is nine-tenths dim. `additive: false` then gives a genuine darkening, for
oil and ink.

### Draw-call cost

**One.** No textures.

It is *fill*-bound, and `SCROLL` is the expensive source: six taps × two lattices × nine cells is a
hundred-odd hashes a pixel. `WAVE` is far cheaper (four sines, an fbm and the live ripple packets per
tap). Treat it like `LiquidSurface`: one per screen, and keep `radius` honest, because the quad is
sized from it every frame.

### Signatures

```js
import {
  Caustics, CausticSource, CausticShape, causticsParams,
  CAUSTIC_BOUND_KEYS, CAUSTIC_RIPPLE_SLOTS
} from '../vfx/Caustics.js';

CausticSource = { SCROLL: 0, WAVE: 1, CUSTOM: 2 }    // a #define, fixed for the lifetime
CausticShape  = { DISC: 0, CONE: 1, LANE: 2 }        // ditto
CAUSTIC_RIPPLE_SLOTS = 8      // NOT configurable — it must match LiquidSurface's

new Caustics(parent, {
  source      = CausticSource.SCROLL,
  shape       = CausticShape.DISC,
  custom      = '',        // required GLSL for CUSTOM; throws without it
  uniforms    = null,      // extra boxes merged in, shared by identity
  additive    = true,
  depthTest   = true,
  layer       = LAYER.VFX,
  renderOrder = 7,
  name        = null
})

net.object3D    net.drawCalls   // 1     net.boundCount   // 0 means procedural
net.setVisible(v)   net.setAdditive(v)
net.bindSource(uniforms, keys = CAUSTIC_BOUND_KEYS) -> number   // boxes taken
net.unbindSource()
net.ripple(u, v, strength = 1, now = 0) -> Vector4|null   // u,v are FRACTIONS of `half`
net.clearRipples()   net.reset()
net.update(p)        // NO clock argument — see below
net.dispose()

causticsParams() -> object    // every canonical key with its default and its unit
```

`update(p)` takes **no clock**, for the reason `GroundField.update(p)` takes none: every beat arrives
as a unitless `0..1` on `p` and the animation clock is `frame.uTime`, read by the shader itself. The
one timestamp the module needs is `p.now`, the ripple epoch — a timestamp, not a duration.

### Params

`causticsParams()` in the source is the full list with units. Groups: placement
(`centre`/`lightAxis`/`yaw`/`height`/`radius`/`length`), the beats (`fade`/`front`/`now`/`seed`),
refraction (`depth`/`ior`/`dispersion`/`sampleStep`/`absorb`), the fold
(`foldFloor`/`threshold`/`gain`/`sharpness`/`rolloff`), the `SCROLL` lattice
(`sourceAmp`/`cellScale`/`cellRatio`/`cellJitter`/`driftAngle`/`driftSpeed`/`boil`, and
`ridgeMix`/`ridgeScale`/`ridgePower` — the received recipe, kept low by default so the fold has
something to sit on in shallow water), the `WAVE` block (all of it overridden by `bindSource`), the
projector, and the output including three pickers — `colorNet` for the filaments, `colorFringe` for
the very top of a fold, `colorWash` for the general light in the pool. None derived from another.

### The one rule

**Bind it to the surface that is supposed to be making it, or turn `depth` down until you can see
that you have not.** The fold term is driven by `depth × (ior − 1)`; at `depth = 0` there is nothing
to fold and you are looking at `ridgeMix` alone, which is the mottle this module was written to stop
shipping. If there is no surface above the floor to bind, there is probably no reason for caustics
to be on the floor.


---

## `LightShaft.js` — light in air, integrated along the view ray

Volumetric shafts: a real in-scattering integral through a cone of lit air, clamped by the depth
buffer, landing in a bright band on the ground that is produced by the same integral rather than
decalled on afterwards.

### Why this is not `Curtain(SHAFT)`

`Curtain` already has a `SHAFT` mode. It is good and it stays. It is also a **sheet**, and three of
the four things this module has to do are not expressible on one. That was checked before the file
was written, not asserted after:

1. **Anisotropy.** The single thing that makes light in air read as light in air is that a shaft seen
   nearly end-on is several times brighter than the same shaft seen across. That is the
   Henyey–Greenstein phase function of the angle between the view ray and the **shaft's axis**. A
   sheet's only angular term is `1/|N·V|` against the **sheet's normal** — a proxy for path length
   through a fold, pointing the wrong way: it peaks when you look *along the sheet*, not when you
   look *along the beam*. Curtain's own section is honest about what that term is for.
2. **A path length that is a path length.** A sheet has no thickness, so its brightness is a function
   of where you hit it. Here the ray genuinely enters and leaves a cone and the segment between them
   is integrated. Move the camera toward the axis and the segment lengthens on its own; no term had
   to be written to make that happen.
3. **A soft floor intersection.** A sheet meeting the ground gives a straight cut, which is why
   Curtain has `footFade`. Here the far end of the integral **is** the depth buffer, feathered over
   `contact` metres, so the shaft dies into whatever it actually meets — floor, character, a rock —
   at the right distance and with the right shape.
4. **The band on the ground.** Curtain's floor companion is a second quad with its own pool term, and
   its section says so. Here the band *is* the shaft: the view ray terminates somewhere, we know
   where, and the shaft's own radial falloff, its own canopy gaps and its own axial extinction are
   evaluated at that point. Drag `gobo` and the leaf-gaps on the floor change with the gaps in the
   air, because there is one field and not two.

Extending `Curtain` would have meant a second geometry, a second placement path, a second integral
and a mode sharing nothing with the other two but the file. `Curtain(SHAFT)` is still the right
answer for a rank of cheap god-rays behind something; this is the right answer when the shaft is the
subject.

### How it is rendered, and why every part of that is deliberate

The hull is an instanced capped cylinder that the vertex shader bends into each shaft's own truncated
cone. It carries **no lighting at all**: the fragment gets five varyings describing the *primitive* —
mouth, axis, length, the two radii — and solves against those, not against the triangles. `sides` can
be twelve; a coarser bound only means a few more fragments that immediately find no intersection and
discard.

- **Back faces.** Every view ray that enters the hull then has exactly one fragment to do its
  integral in, whether the camera is inside the hull or outside it.
- **Caps on.** Open-ended, a ray straight down the axis finds no back face and punches a hole through
  the middle of the shaft — which reads as a ring of light with a dead centre, exactly wrong.
- **Depth test off.** Occlusion is *part of the integral*. A shaft behind a wall must be dark because
  its light never reached you, not because a test threw the fragment away, and the difference shows
  the moment a character's shoulder is halfway into it. The far limit comes from `frame.uSceneDepth`,
  converted to a distance along our own ray by the third row of `viewMatrix` — no inverse projection
  needed.
- **Alpha 1.** With `AdditiveBlending` (`SrcAlpha`, `One`) the destination gets `rgb` exactly once.
  Writing the luminance into alpha instead — the obvious thing — makes the blend square it, so every
  dim part of the shaft vanishes and only the core survives. Light adds; it does not add in
  proportion to how bright it already is.

Inside the march: a **gaussian** radial falloff, not a smoothstep — a shaft has a falloff, not an
edge, and a smoothstep draws the surface of the cone you were trying not to have (the same lesson
`Curtain(SHAFT)` learnt). A fixed per-shaft `gobo` sampled on the *cross-section only*, so a gap is a
gap all the way down rather than a dent in the middle. `exp(−extinct · a)` down the axis so the beam
loses energy on the way to the floor. And `axialMouth` is a floor on the axial curve, not tidiness:
a bare `pow(k, curve)` is exactly zero at the mouth, which puts a hard flat disc of nothing where the
shaft enters and reads as the shaft having been cut off with scissors.

### The scene's own dust

`irradianceAt(point, params) → 0..1` is the answer to "the dust in the shaft must be the scene's own
dust motes, brightened as they pass through it, not a second system". The module cannot reach into
`ParticleEngine`, but it can tell an ability exactly how lit a world point is, and the ability can
multiply that into its own particles' brightness — one shared field, two consumers, which is the same
shape as `Caustics#bindSource()`. It mirrors the radial gaussian, the axial curve and the extinction,
and deliberately leaves out the gobo, for the reason `LiquidSurface#lipPosition()` leaves out the
chop: a caller wants a smooth envelope to multiply into a particle, not a field that flickers as a
mote crosses a leaf edge at four metres a second.

The in-shader `mote` lattice is still there for the shafts' own sparkle and is free to switch off
(`mote: 0`) once the ability is feeding real particles through `irradianceAt`.

### Draw-call cost

**One**, for any number of shafts — one `InstancedBufferGeometry`, every shaft placed by the vertex
shader. No textures.

The fragment is the expensive one in the library after `VolumeHull`: `steps` samples, each with a
`snoise` for the canopy and optionally a hashed lattice for the motes. `steps` is a slider and
`maxSteps` is the compile-time cap; 28 of a possible 48 is the default and 16 is fine for a shaft
that is never looked at end-on.

### Signatures

```js
import { LightShaft, ShaftLayout, lightShaftParams, SHAFT_LAYOUT_NAMES } from '../vfx/LightShaft.js';

ShaftLayout = { SINGLE: 0, LINE: 1, RING: 2, SCATTER: 3 }   // a uniform — live, no recompile

new LightShaft(parent, {
  capacity    = 6,                      // hard ceiling on shafts
  layout      = ShaftLayout.SINGLE,
  sides       = 14,                     // hull tessellation. It is only a bound
  maxSteps    = 48,                     // compile-time cap on the march
  layer       = LAYER.VFX,
  renderOrder = 10,
  name        = null
})

shafts.object3D    shafts.drawCalls // 1    shafts.instanceCount   // → Ability#instanceCount
shafts.visible (get/set)   shafts.layout (get/set)
shafts.setPlacement(anchor, along, up)    // `up` may be tilted: pass -frame.uLightDir
shafts.roll(seed = Math.random() * 100)   // onSpawn(); the only dice roll
shafts.reset()                            // onDestroy(); leaves it reusable
shafts.update(p)                          // no clock argument
shafts.footPoint(index, p, out) -> v3
shafts.mouthPoint(index, p, out) -> v3
shafts.irradianceAt(point, p) -> 0..1
shafts.dispose()

lightShaftParams() -> object
```

`anchor` is on the **floor**: the foot of every shaft sits there and the mouth is `length` metres up
`up`. Hand it `-frame.uLightDir` and the shafts slant with the stage's own sun, which is the
difference between "there is a spotlight here" and "the light in this room is coming through
something".

### Params

`lightShaftParams()` in the source is the full list with units. Groups: the rank
(`layout`/`count`/`spacing`/`ring`/`scatter`/`seed`), the shaft
(`length`/`radiusMouth`/`radiusFoot` — a cone if the radii differ, a cylinder if they do not — plus
their jitters and `hullPad`), the medium
(`steps`/`jitter`/`density`/`extinct`/`soft`/`axialCurve`/`axialMouth`/**`anisotropy`**/`contact`),
the canopy (`gobo`/`goboScale`/`goboBias`/`goboDrift`), dust
(`mote`/`moteScale`/`moteSize`/`moteFall`), the ground (`bounce`/`poolSoft`/`landBand`), the beats
(`fade`/`sweep`/`sweepWidth` — a lit window travelling down the rank, which is how a shaft *sweeps*
along a `LINE` cast), and four pickers: `colorMouth`, `colorFoot`, `colorMote`, `colorPool`. None
derived from another.

Per-shaft state is four **dice** and an index. Every metre they turn into is resolved in the vertex
shader from live uniforms each frame, which is why a paused rank re-lays itself under `spacing`.

### The one rule

**Put the camera somewhere it will look down the axis.** `anisotropy` is the module and it is
invisible from side-on: a shaft seen across is a soft cone and any of five cheaper things would have
drawn it. Aim the cast so the player ends up looking up the beam — or give the rank a `sweep`, so
each shaft passes through end-on as the window crosses it — and the eight-to-one swing in brightness
does the work nothing else in the library can do.

---


## `FoldMesh.js` — paper that folds without stretching

A flat sheet with a **crease pattern**, folded from one number, instanced into a flock.

`origami` throws cranes downrange that *unfold* into flat sheets in the air. `scrollward` stands a
ring of scrolls up and pays them out into a wall of text. Both are the same object: a rectangle of
paper being told, by a single `progress` slider, how far along a sequence of rigid motions it
currently is.

### The one rule

**Paper does not stretch.** That is the module. Everything below is in service of it, and if you
change a line in the vertex shader, change it so that this stays true.

The first version did the obvious thing — author the flat sheet, author the folded sheet, `mix()` on
`progress`. Four lines, and wrong in a way you cannot un-see. A vertex travelling in a straight line
between two positions that are *rotated* apart cuts the chord instead of walking the arc, so every
span across a fold **shortens** on the way over: a 180° fold at halfway has lost `1 − cos(θ/2)`,
thirty per cent, of its width. The crane deflates as it closes and re-inflates as it opens. It reads
as rubber, and no amount of shading rescues it.

So nothing here interpolates positions. Every vertex is moved by a **product of rigid motions**, one
per crease, and a product of rigid motions preserves every distance on the sheet by construction —
at every intermediate value of `progress`, not just at the ends. The isometry is not a quality
setting; it is a consequence of the representation.

### A crease

A line in **sheet space** — the unfolded material, `-0.5 .. 0.5` on both axes, which never changes
whatever the paper is doing — plus a signed angle.

- The **moving flap** is the half-plane you reach by turning right from the crease's direction:
  `n = (dir.y, −dir.x)` in sheet coordinates, which is `cross(up, dir)` in three dimensions.
  Material at `d ≤ 0` is held; material at `d > 0` moves.
- A **positive** angle lifts the flap toward `+y` (a *valley* seen from above); negative drives it
  down (a *mountain*). The tables use the exported `VALLEY` / `MOUNTAIN` constants, because a crease
  pattern read six months later is a list of signs and nothing else.
- A crease is **not a knife edge**. Over a band `hinge` metres wide the flap rolls onto a cylinder
  tangent to the sheet, and only past the band is it rigidly rotated. Real paper does exactly this,
  and it costs nothing: a cylindrical roll parameterised **by arc length** is itself isometric. The
  band is also where the crease highlight lives, so a fold catches light along its length with no
  extra geometry.

The per-crease operator is, in the crease's own frame, a rotation by `φ = clamp(d/w, 0, 1)·θ` about
the hinge axis followed by a slide of `−min(d, w)` along the rotated in-plane direction. That is a
rigid motion **for each material point**, which is why it composes with the others, and
differentiating it along `n` gives exactly 1, which is the proof the band does not stretch either.
Both halves of that sentence were worth the afternoon they took: the naive "rotate the flap about the
axis" form is rigid but has a knife crease, and the naive "roll it onto a cylinder" form is smooth
but is not a rigid motion of the *point*, so it silently threw away every fold applied before it.

### The hierarchy

Real folding is a tree: the head is folded, then the neck the head is on, then the body the neck is
on, and the earlier folds ride along. Tables are authored **root first**, the way you would describe
the model out loud, and the shader walks them **backwards** so the deepest fold reaches the vertex
first and everything above it carries the result. Crease lines stay in flat sheet space — a parent's
rotation transports its children automatically.

Two consequences:

- the side test is against the vertex's **unfolded** position, never its current one. Which side of
  a crease material is on is decided by the paper, not by where the paper is pointing;
- the loop runs `MAX_CREASES` times and skips empty slots, because `uCreaseLine[i]` may only be
  indexed by something built out of constants and the loop counter. `MAX_CREASES - 1 - k` qualifies;
  `uCreaseCount - 1 - k` does not, and does not compile on ANGLE.

### The patterns, and how they are stylised

`FLAT` (a sheet of paper, and not a lesser thing — it is what a crane becomes), `DART` (six creases),
`CRANE` (seven), `FAN` (an accordion, generated by `fanCreases(count, turns)`) and `UNROLL`.

The honest statement of the stylisation: a real crease pattern limits a crease to a *region*, and a
half-plane fold cannot. Where a pattern needs one — the crane's neck and tail are strips, not halves
— the crease carries a **gate**, a slab through its own origin outside which the fold does not apply.
A gate is a **cut, not a crease**: the sheet separates along it. Use one only where the real pattern
already has a crease there, keep `hinge` small enough that the seam is a line rather than a gap, and
do not go looking for a paper aeroplane you can fly.

`CRANE` also wants a **square**. `aspect` away from 1 stretches the crease pattern, the fold angles
stop meeting and the tips open. That is not a bug in the fold; it is the pattern being asked to do
something paper cannot. `DART` tolerates a rectangle. `FAN` does not care.

`fanCreases()` is the clearest demonstration of the hierarchy in the module: the first crease turns
the sheet by θ and every crease after it turns by **−2θ, +2θ, −2θ…**, because each one has to undo
its parent and go the same distance again the other way. Author them as ±θ each and you get a spiral,
not a fan — which is how the sign convention got tested.

Staging is authored per crease as a `[t0, t1]` window on `progress`, so a bird assembles in the order
you would fold it. Run `progress` backwards and it comes apart in the order you would unfold it,
which is `origami`'s whole beat.

### `UNROLL`, and why arc length is the only correct parameterisation

A scroll is not a crease pattern; it is one continuous bend. The sheet is placed **by arc length from
the free end**:

- the paid-out run is an arc of constant curvature `curl` — the paper remembers the roll — using
  `sin(κa)/κ` and `(1−cos(κa))/κ`, which is a cylindrical bend and therefore isometric. Below a
  hundredth of a curvature unit it falls back to the straight-line limit rather than dividing by
  nothing;
- the wound part is an **Archimedean spiral**, `r(w) = √(r₀² + wt/π)` — the exact relation between
  wound length and radius for paper of thickness `t` on a core of radius `r₀`. It **tightens toward
  the spool** because that is what the square root does, and the turn `θ = 2π(r_outer − r)/t` is its
  integral. Arc length along it comes back as `√(1 + (t/2πr)²)`: the residual stretch is five parts
  in a million at a millimetre of paper on a 30 mm core, a thousand times under a pixel.

Place by *fraction of the sheet* instead and you have declared that a tight inner turn and a flat
metre of paper are the same amount of material — the marks bunch at the spool and stretch on the run.
Because every mark the module draws (grain, laid lines, ink) is a function of the sheet coordinate
and nothing else, the **foreshortening is free and correct**: the shader never learns it is on a
curve, and the writing compresses coming off the roll because the paper it is printed on genuinely is
compressed there in screen space.

`spoolClimb` picks which end is pinned: 0 holds the tangent point and lets the sheet grow downward, 1
holds the free end on the floor and the spool climbs — the wall rising out of nothing that
`scrollward` is after.

### The shading: it has to be paper

Five pickers, none derived from another: the sheet, its shaded side, the colour of light coming
*through* it, the ink, the crease.

- **Translucency is the tell.** A sheet with light behind it glows, and it glows *less where the ink
  is*, because ink is opaque and paper is not. That one multiply is the difference between paper and
  painted card.
- **The grain is anisotropic and lives in sheet space.** Fibres lie along the machine direction; the
  noise is stretched `grainAniso` times along `grainAngle` and does not move when the sheet folds,
  because it is printed on the material rather than projected onto it.
- **Laid lines** — the faint regular ribbing of a laid sheet, a fine period plus chain lines every
  few centimetres. Free, and it is what stops a big flat scroll reading as a polygon.
- **The crease highlight** is the hinge band, brightened on the mountain side and darkened on the
  valley side, scaled by how far the fold has gone. It appears as the paper folds and vanishes when
  it opens, which is what a crease does.
- **The writing** is hashed bars inside a grid of cells in sheet space — four strokes per cell reads
  as script at any distance a viewer will be at; the fifth costs the same and reads as noise.

This is the only material in `src/vfx/` with `toneMapped: true`. It is paper, not light: left out of
the tone map a white sheet is the brightest thing on screen and blooms, and the ink school forbids
bloom.

### Draw-call cost

**One**, for the whole flock — one `InstancedBufferGeometry`, every sheet placed, folded and lit by
the vertex shader. No textures.

The vertex cost is `segments² × MAX_CREASES` rotations per sheet and it is the number to watch: 24
segments and 12 creases is 7k rotations a sheet. `segments` and `segmentsV` are separate constructor
options because a crane wants resolution on both axes and a scroll spends almost all of it on one.
The crease is only as sharp as the grid can resolve — a `hinge` narrower than one cell quantises into
a kink.

### Signatures

```js
import { FoldMesh, FoldPattern, FoldLayout, foldMeshParams, foldMeshSchema,
         fanCreases, CREASE_PATTERNS, MAX_CREASES, VALLEY, MOUNTAIN } from '../../vfx/FoldMesh.js';

FoldPattern = { FLAT: 0, DART: 1, CRANE: 2, FAN: 3, UNROLL: 4 }
FoldLayout  = { LINE: 0, ZONE: 1, SINGLE: 2 }
MAX_CREASES = 12;  VALLEY = 1;  MOUNTAIN = -1
CREASE_PATTERNS      // frozen, keyed by FoldPattern
fanCreases(count = 8, turns = 0.5) -> Crease[]

new FoldMesh(parent, { pattern = FoldPattern.CRANE, layout = FoldLayout.LINE, capacity = 32,
                       segments = 20, segmentsV = segments, renderOrder = 4,
                       layer = LAYER.WORLD, name = 'FoldMesh' })
f.count · drawCalls (1) · uniforms · visible (get/set) · layout (get/set) · pattern · capacity
f.setPattern(FoldPattern.* | Crease[])          // no recompile, no allocation
f.setBasis(origin, direction, side, length)
f.setColors(paper, shade, transmit, ink, crease)
f.roll(seed = Math.random() * 100) · reset()
f.update(_now, params)                           // FIRST ARGUMENT IGNORED
f.sheetPoint(index, params, out) · spoolPoint(index, params, out) · dispose()

// a crease, all of it unitless — fractions of the sheet and multiples of PI
{ o: [u, v], dir: [du, dv], turns, t0, t1, hinge, gate: [gu, gv], span: [min, max] }
```

`update()`'s clock argument is **ignored**, like `Swarm` and `Curtain`: the bob runs on the shared
`uTime` because a sheet in the air is a standing motion, and the fold runs on `progress` because the
staging is the ability's, not the module's.

### Params

`foldMeshParams()` is the key list. The sheet (`sheetWidth`/`sheetLength`/`aspect`/`sizeJitter`/
`thickness`), the fold (`progress`/`foldGain`/`hinge`/`stageEase`/`foldStagger`), the roll
(`payout`/`core`/`paper`/`curl`/`spoolClimb`/`spin`), the flock (`count`/`travel`/`spread`/`stretch`/
`lift`/`liftJitter`/`radius`/`radiusJitter`/`arc`/`arcPhase`), attitude (`pitch`/`yaw`/`yawJitter`/
`roll`/`rollJitter`/`bob`/`bobRate`/`tumble`), appearing (`reveal`/`revealSpread`), the surface
(`grain`/`grainScale`/`grainAngle`/`grainAniso`/`fleck`/`laid`/`laidPitch`/`chainPitch`/
`creaseGlow`/`creaseDark`/`creaseSharp`/`transmit`/`transmitPower`/`wrap`/`sheen`/`gloss`/`edge`),
the writing (`ink`/`inkRows`/`inkCols`/`inkFill`/`inkWeight`/`inkMargin`/`inkSeed`/`inkGhost`), and
five pickers. `foldMeshSchema(label)` spreads the lot into an ability's editor schema.

Per-sheet state is **eight dice** and nothing else. Every metre they turn into is resolved in the
vertex shader from live uniforms each frame, which is why a paused flock re-lays itself under
`spread` and re-folds under `progress`.

### `thickness`, which is not decoration

`DART`'s nose folds lie flat onto the sheet beneath them, and two coplanar surfaces fight for the
same depth along their whole shared face. Every vertex is pushed out along the final normal by
`thickness` per fold it is downstream of. It is the cheapest possible depth-fight fix and it is also
physically what paper is doing.

---


## `Dissolve.js` — three ways for matter to stop being there

`unmake` takes a thing apart into cubes. `avalanche` buries the floor under a heap of snow that keeps
collapsing over itself. `entropy` ages a surface until it is gone. Three abilities, one idea —
**something is being lost and the loss has a shape** — and three shapes that could not be less alike.

### Why this module has two entry points and not one

`VOXEL` and `EROSION` are ways of *taking away* something that already exists. The geometry is not
this module's, the material is not this module's, and the ability reaching for them already has both
— so they are a **patch**. `GRANULAR` is the opposite: nothing in the scene is heap-shaped, so the
heap has to be **drawn**, and that is a class with a mesh in it.

```js
patchDissolveMaterial(material, { mode: DissolveMode.VOXEL })   // and/or EROSION
new DissolveField(parent, { along, across })                    // GRANULAR
```

One class doing both meant either an object owning a mesh half its callers threw away, or a patch
that had to invent a surface out of nothing. The seam is here because the two halves genuinely
differ.

### VOXEL — the cube size grows, which is why it reads as *accelerating*

Matter comes apart into cubes that drift and wink out, and **the cubes get bigger as it goes**.
That is the ability: losing eight small cubes and losing one cube eight times the size are the same
volume, but the second looks faster, because the eye counts events and not litres.

Entirely in the vertex shader, against a lattice whose cell size is a uniform. **No CPU rebuild** —
the geometry is untouched and the mesh is the one the ability was already drawing.

The first version slid the cell size up continuously, and it does not work: a lattice with a sliding
cell size re-partitions the mesh *every frame*, so a chunk drifting away as part of one cell is
suddenly half of two others and the whole surface visibly reshuffles, twice a second, like a bad
mosaic filter.

The fix is a **power-of-two ladder walked once per vertex**:

```
for rung r = 0 … rungs-1:
    s  = cell · 2^r                     // this rung's cell size
    id = floor(p / s)                   // which of its cells this vertex is in
    if hash(id, r) < take  or  r is last:
        this vertex belongs to THIS cell, for ever. Stop.
        it lets go at t = (r + hash2(id, r)) / rungs
```

Every vertex is claimed exactly once, by the *finest* rung that wants it, and the claim depends only
on the rest position and the hashes — so it never changes, never re-partitions and needs no state.
Material rung 0 did not claim is still there when rung 1 comes round and is taken away in pieces
twice the size, and twice that again on rung 2. **The acceleration is not animated; it falls out of
the ladder.** The last rung claims whatever is left, or unlucky material would survive the dissolve
and hang in the air for ever.

A claimed cell then snaps its vertices toward a sub-lattice (`block`, which is what makes the chunk
*cubic* rather than merely detached), tumbles about its own centre, drifts on `k`, falls on `k²` —
one is a push and the other is gravity, and giving them the same curve is why an early version looked
like the cubes were on strings — and finally scales to nothing **about the cell centre**, so it
disappears whole instead of collapsing into a spray of stretched triangles crossing the model.

**The voxel lattice is always object space**, and that is not the same choice as the erosion field's
`space`: the displacement it produces is added to `transformed`, which is object space, and a
world-space lattice would hand a rotating mesh a drift direction that swings round with it. So `cell`
is metres *in the mesh's own units* (a non-unit scale scales the cubes with it), and every instance
of an `InstancedMesh` comes apart identically — usually what you want from a field of one thing, and
otherwise a per-instance `seed`.

### EROSION, and the world/local question, which has a real answer

A threshold on a warped fbm with a bright band above it. One warp octave, because an unwarped
threshold gives round holes and round holes read as a texture.

`dissolveMask()` in `shaders/lib/common.glsl.js` does exactly this and is deliberately **not** used
here: that chunk pulls in `<packing>`, and injecting it into a built-in material defines the depth
helpers twice. The two lines are re-stated locally.

The field is sampled in **local** or **world** space and it matters:

- **LOCAL (default)** — glued to the object. A thing being consumed keeps its burn on the same part
  of itself however it moves, which is what you want when the *object* is the event. Use it for
  anything that travels, spins, or is instanced and scattered.
- **WORLD** — glued to the room. Several separate meshes handed the same uniform box dissolve as
  **one event**: the front crosses all of them consistently and the seams between them stop existing,
  which is the only way `unmake` can eat a standing ice field that is nine draw calls. The cost is
  that a moving mesh *slides through* the pattern, so the burn crawls over its surface. On something
  slow that reads as the room eating it; on something fast it reads as a bad projection. **Do not use
  world space on a projectile.**

`biasDirection` × `biasAmount` adds `dot(p, dir)·amount` to the threshold, which turns the noise into
a **front** sweeping a chosen way rather than a rash breaking out everywhere at once.

### GRANULAR — a heap, not a wave

The roster's line for `avalanche` is "the front is not a wave; it is a heap that keeps collapsing
forward over itself", and a heightfield with a sine in it will never be that. What makes a heap a
heap is the **angle of repose**: granular material piles until its surface reaches a critical slope
and then refuses to get steeper, so it grows sideways instead of upward.

So the surface is the **upper envelope of a train of collapsing cones**:

- a *lobe* is released every `1/rate` seconds at the front, which is at `frontSpeed · t`. Its
  identity is its release **ordinal**, not its slot in the loop — the version that hashed the slot
  index gave every lobe a new size and place each time the window shifted, and the heap boiled;
- it is born **over-steep** (`repose + excess`) and relaxes toward repose at `slump` per second,
  which is what wet snow and dry sand both do. With its volume held, that alone makes it get shorter
  and wider: `H = ∛(3V·tan²φ/π)`, `radius = H/tanφ`. One exponential and a cube root, and the lobe
  collapses on its own;
- the surface is the **max** of the lobes, not the sum. Heaps merge by taking the upper envelope —
  that is what a repose surface *is* — and summing them gives a smooth mound with no ridges, which is
  a pudding. The creases where two lobes meet are the whole texture of the thing;
- each lobe's centroid creeps forward at `creep` while it collapses, so new lobes land **on top of**
  older ones and slide over them. That is "collapsing forward over itself", and it is one term.

Behind the train, `bed` leaves a settled deposit; without it the tail vanishes as lobes age out of
the window and the avalanche is a comet.

Nothing is integrated and nothing is stored. Every lobe is a closed-form function of `now − birth`,
so a paused heap re-slumps under a dragged slider — pull `repose` down with the clock stopped and the
whole avalanche flattens and spreads, which is worth doing once just to watch.

The normal is a **forward difference** at the grid's own scale rather than an analytic gradient,
because the envelope is not differentiable at its ridges — and that is not an artefact. A heap has
ridges, and the difference shades one as the crease it is instead of rounding it away. The price is
three evaluations of the lobe loop per vertex, which is the module's real cost and the reason `lobes`
is a slider.

### Draw-call cost

The patch is **free** — it is the caller's mesh. The heap is **one**. No textures anywhere.

### Signatures

```js
import { DissolveMode, DissolveSpace, DissolveField, dissolveParams, heapParams,
         dissolveUniforms, syncDissolve, patchDissolveMaterial, dissolveSchema,
         DISSOLVE_GLSL, MAX_RUNGS, MAX_LOBES } from '../../vfx/Dissolve.js';

DissolveMode  = { VOXEL: 0, GRANULAR: 1, EROSION: 2 }
DissolveSpace = { LOCAL: 0, WORLD: 1 }
MAX_RUNGS = 6;  MAX_LOBES = 24

dissolveUniforms(overrides = {}) -> uniform box       // SHARE IT BY IDENTITY
syncDissolve(boxOrMaterial, params) -> the target     // every frame
patchDissolveMaterial(material, { mode = DissolveMode.VOXEL, space = DissolveSpace.LOCAL,
                                  uniforms = null, environment = null,
                                  vertex = '', fragment = '' }) -> material
  // parks its box on material.userData.uniforms (I8) and on .userData.dissolve
  // composes through patchOnBeforeCompile — does not clobber a shadow patch or CSM
  // <beginnormal_vertex> and <emissivemap_fragment> are used when the material has
  // them and skipped when it does not: a basic material still cuts and still drifts,
  // it just does not turn the normal or add the ember
DISSOLVE_GLSL = { uniforms, vertex, fragment }        // inject noiseGLSL FIRST

new DissolveField(parent, { along = 72, across = 40, renderOrder = 3,
                            layer = LAYER.WORLD, name = 'DissolveField' })
h.drawCalls (1) · uniforms · visible (get/set)
h.setBasis(origin, direction, side, length) · setColors(fresh, settled, face, deep)
h.roll(seed = Math.random() * 100) · reset()
h.update(now, params)                                 // now IS used — the train is an event
h.frontPoint(now, params, out) · crestHeight(now, params) -> metres · dispose()
```

### Params

`dissolveParams()` for the patch: `progress`/`seed`/`space`, the cubes (`voxel`/`cell`/`rungs`/
`take`/`span`/`block`/`facet`/`hold`/`drift`/`driftBias{X,Y,Z}`/`lift`/`gravity`/`tumble`/`wobble`/
`wobbleRate`), the threshold (`erode`/`noiseScale`/`warp`/`edge`/`bias{X,Y,Z}`/`biasAmount`), and two
pickers plus `glow`. `heapParams()` for the heap: the footprint (`halfWidth`/`floor`/`heightGain`),
the train (`lobes`/`rate`/`frontSpeed`/`volume`/`volumeJitter`/`repose`/`excess`/`slump`/`creep`/
`scatter`/`widen`), the deposit (`bed`/`bedRamp`/`bedWidth`/`bedCurve`), and the snow
(`ambient`/`wrap`/`fresh`/`grain`/`grainScale`/`glint`/`toe`/`opacity`) with four pickers.
`dissolveSchema(label)` returns all four folders.

The heap's defaults are a snow avalanche: 33° of repose (dry snow sits between 30° and 38°),
over-steep by 12°, relaxing inside half a second, released five times a second at 7 m/s.

### The one rule

**Share the uniform box.** `dissolveUniforms()` is a separate function for exactly one reason: hand
the same box to every material that should come apart as one event and a single `syncDissolve()`
drives all of them, because three stores uniforms as `{ value }` boxes and one write moves every
material holding that box. A dissolve applied per-material with per-material progress does not look
like one thing being unmade; it looks like several things being unmade near each other, which is the
difference between `unmake` and a screen wipe.

---

## `TimeControl.js` — recording the caster, and bending everyone else's clock

The most architecturally invasive module in the library, and the one that draws the least. Two of
its three capabilities draw **nothing at all**: they are a shared uniform block, a GLSL chunk and
some arithmetic, and the read is entirely in what the rest of the frame does differently.

It serves the whole **chrono** school — `echostep`, `stasisfield`, `rewind`, `hourglass`,
`afterimage`, `entropy` — and the two extension abilities that want a paused world (`spellbreak`
wants `timeRegionWeight` to disrupt what is standing inside it; `mirage` wants a `GhostRig` with the
bleach turned off and the alpha driven from distortion instead).

It is the only module in `src/vfx/` that touches shared infrastructure. Three files outside it moved:

| file | change | why |
| --- | --- | --- |
| `core/FrameUniforms.js` | `MAX_TIME_REGIONS`, three uniform boxes, three lines in `sharedUniforms()` | the field has to be readable by `core/` and `particles/` without either importing a VFX module and dragging its shader source into the boot bundle — the same argument that put `distortionWriters` in `core/Layers.js` |
| `shaders/lib/timewarp.glsl.js` | **new**, no renderer | the chunk any shader injects to read the field |
| `particles/ParticleSystem.js` | the vertex path became a function; a stasis loop and one varying | so particles hold mid-air, which is `stasisfield`'s entire ability |

### Draw-call cost

`TimeField` **0** · `TimeRecorder` **0** · `GhostRig` **1 per skinned mesh in the source rig** (one,
for the character in this project). Three ghosts is three draw calls and leaves nine of I7's twelve.

### Signatures

```js
/* TimeControl.js ─ 0 draw calls (GhostRig: 1 per source mesh) ─ mixed ─ canonical */
MAX_TIME_REGIONS = 4       // re-exported from core/FrameUniforms.js
MAX_TRACK_SAMPLES = 240 · MAX_TRACK_BONES = 128

/* --- the field: a pool, a singleton, no renderer --- */
timeRegionParams() -> { radius, core, strength, rate }
export const timeField = new TimeField()
field.acquire(now = frame.uTime.value) -> TimeRegion | null    // NULL when all four are gone — I6
field.release(region) -> null · field.reset() · field.liveCount
field.clockAt(clock, worldPos) -> seconds    // CPU mirror of warpedTime()
field.weightAt(worldPos)       -> 0..1       // CPU mirror of timeRegionWeight()

region.centre : Vector3        // the caller writes it every frame
region.index · isLive · hold
region.lock(now = frame.uTime.value)   // stamp the instant the region snapped shut
region.place(v3) · placeXYZ(x, y, z)
region.sync(p)                 // p = timeRegionParams(); EVERY frame, from live settings
region.weightAt(worldPos) -> 0..1
region.release() -> null

/* --- the recorder --- */
recorderParams() -> { rate, window }
new TimeRecorder({ capacity = 120, bones = MAX_TRACK_BONES })
r.attach(source) · detach() · clear()
r.bones · boneCount · sampleCount · oldest · newest · span
r.sample(now, p) -> boolean    // false if not due, or if `now` went backwards
r.trim(now, p)
r.transformAt(t, outPosition, outQuaternion) -> boolean   // false = off the end of the track
r.poseAt(t, ghostRig)                        -> boolean   // same

/* --- the ghosts --- */
ghostLook() -> 16 keys: tint/deep/rimColor/bleach, fade/facing/rim/rimPower,
               glow/bandScale/bandSpeed, erode/erodeScale/edge/edgeGlow/seed
createGhostMaterial(sourceMaterial | null) -> MeshStandardMaterial  // userData.uniforms + .sync
applyGhostLook(uniforms, look)
findCaster(scene) -> Object3D | null        // scene.getObjectByName('Character'); call it ONCE

new GhostRig(parent, { source = null, material = null, layer = LAYER.VFX, renderOrder = 4 })
g.object3D · drawCalls · boneCount · bones · meshes · hasSource · visible (get/set) · material
g.setSource(source) -> boolean      // THE ONLY ALLOCATING CALL. Idempotent. createShaders().
g.place(position, headingRadians | Quaternion) · setScale(k) · sync(look) · dispose()

/* --- reverse --- */
reverseParams() -> { rate, turnAt, hold, back, floor }
reverseTime(age, p) -> seconds      // the closed form. PREFER THIS.
reverseRate(age, p) -> signed ×     // +rate, 0 at the top and at the floor, -back
new TimeWarpClock(start = 0)        // the integrating alternative
c.now · step · rate · direction · turned · reversing · stalled · emitDt · spanDt
c.reset(start) · advance(dt, rate = 1, floor = -Infinity, ceiling = Infinity) -> signed step
new RewindGate()
gate.poll(time, mark) -> +1 forward | -1 backward | 0 · reset() · past · crossings
```

### The field, in one line of GLSL

Up to four spheres, each carrying a centre, an outer radius, a soft core, a strength, a **hold
timestamp** and a **rate**. A shader that injects `timeWarpGLSL` sees, inside a region:

```glsl
bent = mix(clock, hold + (clock - hold) * rate, weight);
```

and that line is all three chrono capabilities at once:

| `rate` | what the region does |
| --- | --- |
| `0` | **stasis** — the clock stops dead at `hold`. Nothing inside advances. |
| `-1` | **rewind** — the clock is mirrored about `hold` and runs backwards. |
| `0.25` | slow motion at a quarter speed, still anchored at `hold`. |
| `1` | identity, whatever the weight. |

`weight` is `strength × (1 - smoothstep(core × radius, radius, distance))`, so the derivative of the
bent clock with respect to the real one is `mix(1, rate, weight)` — the shell of a region is a
**time-dilation gradient**, and things at the rim crawl while things at the centre are stopped. That
gradient is why a stasis field reads as a field instead of as a hard sphere of frozen sprites, and it
falls out of the `mix` for free.

The chunk exposes four functions. `warpedTime(clock, worldPos)` and `timeRegionWeight(worldPos)` are
the two an ordinary consumer wants; `timeRegionFalloff(worldPos, region, warp)` and
`timeRegionClock(clock, warp, weight)` take the already-fetched `vec4`s and exist because a function
**cannot index a uniform array by its own argument** in ESSL 1.00 — the caller has to be a loop, and
the loop has to do the fetch. That is the same rule that makes `FilamentPaths` compare
`float(i) == role` instead of writing `uFrom[role]`.

### Why an instant and a rate, and not a time scale

The first version published a per-region `timeScale` and expected each consumer to integrate it —
`myClock += dt * scaleAtMyPosition`. That works exactly once and then falls apart, because **every
effect in this project is a closed-form function of time with nowhere to keep an accumulator.** A
particle is `f(uTime - aSpawn)`, evaluated fresh in the vertex shader every frame from nine
attributes; there is no `myClock` to advance and no per-particle memory to advance it in. Publishing
the instant the region locked turns the field into a closed form too, which is also what makes it
survive the only test that matters here: pause with **P**, drag the radius, and particles that were
outside the sphere snap to their held pose while the rest keep theirs. A frame of zero length changes
the picture.

### The probe, and the freeze that thawed itself

A shader whose position does **not** depend on its own clock — a ground field, a growth field, a tube
— calls `warpedTime(uTime, vWorldPos)` and is finished. A particle cannot, and the reason is worth
writing down because the wrong version looks right for exactly one frame.

Probe the field at the particle's *current* position and the freeze thaws itself: the particle stops,
the world clock runs on, and the next frame the probe is asking about a place the particle only
occupies **because** it is held; one step later the answer has drifted and it lets go. There is no
fixed point in that formulation.

So the particle shader writes its own loop and probes each slot at the position the body had **on the
frame that slot locked** — `particlePath(clamp(hold - aSpawn, 0, min(rawAge, life)))`. That *is* a
fixed point, it costs one extra evaluation of the trajectory per live region, and it is also the
right fiction: a bubble of stopped time holds whatever was inside it when it snapped shut. The clamp
handles three cases without a branch — a particle born after the lock probes its own spawn point (an
emitter firing into a standing field has its output frozen on arrival), a particle that died before
the lock probes its last position and is then killed by the ordinary `t > 1.0` test, and a dead ring
slot probes age 0 rather than evaluating curl noise ten thousand seconds out.

Because the kill test runs on the *bent* age, a region with a negative rate **un-spawns** particles
properly: they fly backwards into their emitter, reach age 0, and stop existing there. That is the
only path in the project by which particles genuinely reverse.

### What it costs when no chrono ability is standing

`uTimeRegionCount` is `0` until somebody calls `acquire()`. Every entry point opens on it, so the
whole mechanism costs **one uniform float compare and a branch every fragment in the draw takes the
same way**. The uniform boxes are in `sharedUniforms()`, but three only uploads uniforms the compiled
program declares, so a material that never injects the chunk uploads none of the eight `vec4`s.

Measured rather than asserted: the shipped particle shader was rendered against the pre-change one
across **eleven `SHAPE` × flag permutations at five timestamps**, with `Math.random` seeded so both
systems got byte-identical spawn attributes, reading back a 128×128 framebuffer each time. Ten of the
eleven are **pixel-for-pixel identical**. The eleventh — `STREAK` with `USE_STRETCH` — differs by
**one pixel at one 8-bit level**, a single-ULP rounding difference at an antialiased silhouette edge
from the driver inlining across the new function boundary.

### The recorder, and full skeletal ghosting

`TimeRecorder` is a ring of timestamps, the source's world transform, and every tracked bone's
**local position and rotation**. `GhostRig` is a real clone of the caster's skinned meshes on its own
`Skeleton`, which the recorder drives to any instant on the track.

**Full skeletal ghosting is feasible here and this module ships it** rather than a silhouette proxy,
because the `echostep` roster entry is explicit that "They are the character, not a proxy; that is
what makes it unsettling". The trade-offs are real and are stated rather than hidden:

- **N poses cost N skeletons.** Skinning reads a per-skeleton matrix palette, so two ghosts showing
  two instants need two palettes, therefore two sets of `Bone` objects for `Skeleton.update()` to
  read. There is no arrangement in which N poses of one rig cost one draw call. Each ghost is about
  seventy `Object3D`s and one draw call; geometry and the skin map are shared with the character.
- **`setSource()` allocates, and it is the only thing here that does.** That is a documented
  exception to I3 with an unavoidable cause: the character is an asynchronous FBX load that finishes
  *after* ability pools can be warmed, so there is no earlier moment at which the source rig exists.
  Call it from `createShaders()` — by the time a chrono ability is warmed on selection the character
  is long loaded — and the cast itself allocates nothing. It is idempotent, so calling it again from
  `onSpawn()` as a fallback is free after the first cast.
- **Scale is not recorded.** Mixamo clips carry no scale tracks, so a third of the buffer and a third
  of the per-frame write would replay a constant. Bone scale comes from the bind pose at clone time.
  A future rig that animates scale gets ghosts that are stiff, not broken.
- **Rotation is slerped, not lerped.** Element-wise lerping the *matrices* was the first version. At
  30 Hz it is almost right, and then a wrist crosses ninety degrees between two samples and the hand
  collapses into the forearm for two frames.
- **No new context plumbing.** `findCaster(scene)` is `scene.getObjectByName('Character')`, and
  `ctx.scene` is already in the context every ability is constructed against. Nothing in
  `AbilityManager` or `App` had to change, and the character's async load stops being an ordering
  problem. Call it once and keep the result; it is a full traversal.

The property that makes this an effect rather than a feature: sampling is driven by timestamps, so a
zero-length frame writes nothing — but **playback is a function of the delay, and the delay is a
slider**. Pause mid-cast and drag `ghostDelay`, and three ghosts walk backwards and forwards through
the recording while the world stands still.

### The ghost material, and the coloured blob it is not

`createGhostMaterial()` returns a patched **`MeshStandardMaterial`**, not a `ShaderMaterial`. The
first version was a `ShaderMaterial` — a fresnel ramp over a flat colour on the cloned geometry — and
it looked like a mannequin. What makes a person recognisable at ten metres is not the silhouette, it
is the shading: the normal map across the shoulders, the probe sitting on the top of the head, the
terminator down the side of the ribcage. All of that arrives free from the standard material and
costs a re-implementation otherwise.

Three things happen on the way out. The skin is **bleached by its own luminance** toward `deep →
tint`, so the map's light and shade survive and only its hue is replaced — multiplying by a tint
instead, which is the obvious version, turns a dark jacket into black and the whole figure into
exactly the coloured blob the roster entry warns about. A fresnel term drives both the rim emission
and the alpha, so the ghost is thinner head-on than edge-on and reads as a volume of air. And the
banding and the dissolve are both measured in **world metres**, not UV, so the bands stay put as the
figure moves through them and two ghosts a metre apart erode differently without either owning a
seed attribute.

The ghost shares the character's diffuse map. That is not a new **I2** exception; it is the same one,
reused, and the moment the caster's skin changes so does every echo of it. Uniform boxes are parked
on `material.userData.uniforms` — **I8**, or the pause test reports sixteen live sliders as dead.

### Reverse, and the guard rails

`reverseTime(age, p)` is three legs: forward at `rate` until `turnAt`, held for `hold`, then backwards
at `back` until it hits `floor`. Hand the result to any module's `now` and that module runs the beat.
The hold is not decoration — a reversal with no pause at the top reads as a glitch, because the eye
needs the moment where nothing moves to understand that what follows is the same motion inverted
rather than a different motion.

**Prefer the closed form to `TimeWarpClock`.** It is the version that survives the pause test: freeze
the sandbox mid-rewind, drag `back`, and the whole reversal re-times itself retroactively because
nothing was accumulated. The integrator exists for a rate that genuinely is not a slider, and it is
honest about what it gives up — an accumulated clock cannot be re-derived, so a paused drag has no
retroactive effect on it. It earns its place with the two things a closed form cannot own: `turned`,
the frame the direction flipped, and `emitDt`, the guard rail below.

**Reverses cleanly** — anything whose clock is an argument: `GrowthField.update(now, p)` (crystals
retract into the floor), `ShatterField.update(now, p)` (fragments reassemble), `FilamentPaths` via
`role.draw(progress, …)`, `Projectile.update(now, p)`, `Tube`/`Shell` via `state.time` / `state.t`,
`GroundField` (marks carry their own timestamps), `LiquidSurface` (the surface does; injected ripples
do not).

**Does not reverse, and what to do instead:**

| | |
| --- | --- |
| **the particle ring buffer** | A spawn is a log entry, not a state. A negative `dt` into a `RateEmitter` drives its fractional accumulator the wrong way, emits nothing, and banks credit that dumps on the first forward frame. Use `clock.emitDt`. The only genuine particle reversal is a time region with a negative rate. |
| **decals, fissures, bursts** | One-shot systems on the app's forward clock; nothing can un-spawn one. Lay them on the forward leg and let them expire. Do not spawn during a reverse leg. |
| `ArcNetwork.update(dt, …)` | Integrates a hop cursor and fires `onNode` once per node; `_fired` never counts down. Feed it `clock.emitDt` and `reset(seed)` on the turn. |
| `Swarm` · `Curtain` · `VolumeHull` | Their motion lives in `frame.uTime` inside the shader — the first argument to `Swarm.update` and `Curtain.update` is ignored by design. An ability clock cannot reach them. A **time region** can, if they are taught to inject the chunk; none of them has been, and that is the obvious next piece of work in this module. |
| `Ability.advance(dt)` | The base class's front and phase machine are monotone and are not yours to reverse. Let the phases run forward and let the bent clock feed only the modules — `rewind` is a LINE cast whose travel still travels. |
| `ctx.lights` | `LightPool.set(…, dt)` smooths toward a target; a negative `dt` is not meaningful. Pass `clock.spanDt`. |

`RewindGate` is the guard rail for every beat fired at an instant. On a monotone clock those are a
boolean; on a clock that can reverse they are a **crossing**, and the difference is that the same beat
has to be able to fire again — or be undone — when the clock comes back through it. `mark` is passed
to `poll()` rather than held, so it stays a live slider and drags under your cursor while paused.

### The one rule

**`region.sync(p)` every frame from live settings, and `region.release()` in `onDestroy()`.** The
pool is four slots wide and `acquire()` returns `null` when they are gone, on exactly the
`ctx.lights.acquire()` contract — guard it, and an ability that wants two regions must read
acceptably with one. A region that is never released is invisible and freezes a piece of the world
for the rest of the session, which is the most alarming bug this library can produce.

```js
/* stasisfield, in full */
createShaders() { this._region = null; this._warp = timeRegionParams(); }
onSpawn()       { this._region = timeField.acquire(); this._region?.lock(); }
onTravel(dt) {
  const c = settings.stasisfield;
  const region = this._region;
  if (!region) return;                                   // I6
  region.centre.copy(this.origin).setY(c.domeHeight);
  this._warp.radius   = c.zoneRadius * settings.global.scale;
  this._warp.core     = c.holdCore;
  this._warp.strength = c.holdStrength;
  this._warp.rate     = 0;                               // stasis
  region.sync(this._warp);
}
onDestroy() { this._region = this._region?.release() ?? null; }
```

---

## `Colony.js` — many small things behaving as one

The Hive school's four tricks, in one file: a flock that condenses into a **silhouette**, a web that
is strands **plus the film between them**, a comb that grows on a lattice **its own neighbours
defined**, and a dome of plates cut from **one tessellation** so it closes exactly.

Four independent classes. They share a file because they share a chitin lighting chunk and a
skeleton — *roll a unitless structure, rebuild it only when its shape hash changes, resolve every
metre in the vertex shader* — and splitting them produced either a fifth module nobody could name or
four copies of the same drift.

| class | what it draws | draw calls | serves |
| --- | --- | --- | --- |
| `ColonySwarm` | a `Swarm` that condenses onto a signed distance field | 1 | `locusttide`, `waspfunnel`, `broodburst` |
| `WebGraph` | sagging strands **and** the membrane in their faces | 2 | `webline` |
| `LatticeGrowth` | hexagonal comb cells budding outward, overlaps refused | 1 | `hivecolumn` |
| `PlateShell` | a spherical Voronoi dome of interlocking plates | 1 | `carapace` |

All four are **parent-first** and **canonical**. `LatticeGrowth.update(now, …)` and
`PlateShell.update(now, …)` take the ability's `age`; `ColonySwarm.update(_now, …)` and
`WebGraph.update(_now, …)` **ignore** it, as `Swarm` and `Curtain` do.

### Signatures

```js
import {
  ColonySwarm, ColonyShape, COLONY_SHAPE_NAMES, colonySwarmParams,
  WebGraph, webGraphParams,
  LatticeGrowth, latticeGrowthParams,
  PlateShell, plateShellParams
} from '../vfx/Colony.js';

ColonyShape = { BALL:0, WALL:1, SPEAR:2, FIST:3, RING:4, COLUMN:5 }
COLONY_SHAPE_NAMES : string[6]

/* ColonySwarm extends Swarm — every Swarm option, method and param still applies */
new ColonySwarm(parent, { capacity = 256, silhouette, additive, renderOrder })
s.update(_now, params)          // FIRST ARGUMENT IGNORED; super.update() runs first
s.shapeCentre(out) -> Vector3   // CPU mirror of the shape's centre, for a light
// inherited: count · drawCalls(1) · uniforms · roll() · reset() · setBasis() ·
//            setColors() · leadPoint()
colonySwarmParams() -> swarmParams() + { shapeA, shapeB, shapeBlend, condense,
  shapeWidth/Height/Depth, shapeForward/Side/Up, shapeSpin, shapeFill, shapeSteps,
  shapeSlack, shapeRough, waveAmp, waveLength, waveSpeed, waveAlong,
  cling, floorY, crawlHeight }

new WebGraph(parent, { maxRings = 8, maxSpokes = 16, samples = 10,
                       filmSubdiv = 2, additive = false, renderOrder = 11 })
w.drawCalls(2) · count · strands · faces · seed
w.roll(seed = Math.random()*100) · reset()
w.setPlacement(anchor, normal, up)      // `normal` is OUT of the web's plane
w.update(_now, params)                  // FIRST ARGUMENT IGNORED
w.nodePoint(ring, spoke, p, out)        // ring -1 is the hub; NO per-node jitter
w.dispose()

new LatticeGrowth(parent, { capacity = 192, sides = 6, wall = 0.24, recess = 0.62,
                            renderOrder = 2, castShadow = true, receiveShadow = true })
g.drawCalls(1) · count · cells · capacity
g.reset() · setPlacement(anchor, forward) · update(now, params)
g.cellPoint(index, p, out, height = 1) · dispose()

new PlateShell(parent, { capacity = 64, renderOrder = 2, castShadow = true })
s.drawCalls(1) · count · plates · capacity
s.reset() · setPlacement(anchor, forward) · update(now, params)
s.tessellate(sites, seed, jitter) -> plates    // update() calls it when needed
s.progress(now, p) -> 0..1                     // how much of the dome has locked
s.plateCentre(index, p, out) · dispose()
```

### `ColonySwarm` — extending the flock, not rebuilding it

`Swarm`'s flock is a closed-form function inside its vertex shader. There is no per-agent state on
the CPU to intercept, and no way to hand each agent a different target without a texture (**I2**) or
a uniform array indexed by something other than a loop counter (which does not compile on ANGLE).
Composition can therefore only move the *lead* — which moves every agent together and cannot make a
shape.

So `ColonySwarm extends Swarm` and **splices two blocks into the vertex shader its superclass
built**: the field library before `main`, and a target blend just before the finite difference. Both
anchors are asserted in the constructor and it throws, naming them, if either stops matching. The
alternative was a second flock, and the moment somebody fixed the bank in one of them the two would
have disagreed about what a flock is.

**Sampling is rejection-free and stable, and it has to be both.** Rejection sampling has no
expressible form in a shader — there is no unbounded loop — and even given one, the number of draws
an agent needed would depend on the shape, so an agent's place would change identity the instant the
shape morphed and the whole cloud would boil. Instead every agent draws **one** point from its own
dice, once, and walks it onto the isosurface by three steps of gradient descent (tetrahedron taps,
four evaluations a gradient). The dice never change, so an agent keeps its own place in the shape and
*flows* across a morph.

**The blend is between the fields, not the points.** `mix(pointInA, pointInB, k)` is a crossfade and
its midpoint is a smear with no shape in it. `mix(fieldA, fieldB, k)` is a morph: the blended field
is a real field at every `k`, so a fist grows a point and a wall draws itself into a spear.
Locusttide's trick is the transition, so the transition had to be a real object. The cost is that
both shapes are evaluated at every tap; the branch on `condense` is uniform flow, so a *dispersed*
`ColonySwarm` costs exactly what a `Swarm` costs.

**Interior fill is an isolevel, not a second scatter.** Every agent targets `d = −fill · dice`
instead of `d = 0`, so it lands on its own private isosurface somewhere inside. Same descent, same
cost, and `fill` slides from a skin of insects to a packed body.

Two extras earn their place because named abilities need them: a **longitudinal density wave**
(`waveAmp`/`waveLength`/`waveSpeed`/`waveAlong`) that crowds agents at its zero crossings — a real
surge up a funnel, for `waspfunnel` — and a **crawl** (`cling`/`floorY`/`crawlHeight`) that pins
agents to the floor, which is what separates `broodburst`'s hatchlings from every other swarm in the
sandbox. The wave modulates *position*, not opacity; the first version brightened agents on a sine
and looked like a gradient painted over a static swarm, because density you can see is agents
arriving.

The target is evaluated once per vertex and mixed into all three time samples, so a condensed swarm's
finite-difference velocity — and therefore its bank — falls to zero. That is correct: an agent
holding station in a shape is not turning.

### `WebGraph` — the membrane is the part everybody forgets

A node is **two integers**, `(ring, spoke)`, and nothing else. Ring −1 is the hub and needs no
special case: every per-node jitter is multiplied by the radius fraction, which is zero there, so all
the spokes of ring −1 land on the same point however the dice fell. Every metre — rim radius, squash,
out-of-plane scatter, sag, breeze — is a uniform, so a paused `radius` drag re-spans the whole web,
film included.

**Sag is a fraction of a strand's own span, not a fixed drop.** That is the difference between a web
and a net: a short chord near the hub hangs almost straight while a two-metre outer chord bellies,
and that gradient is what the eye reads as tension. An absolute sag in metres made the inner rings
look slack and the whole thing read as knitting.

**The film is a Coons patch over its face's four strands.** Bilinear interpolation of the four
*nodes* gives a flat quad whose edges cut straight across the sag of the threads bounding it, and the
film visibly floats off its own frame at every belly. A Coons patch interpolates four boundary
*curves* exactly, so the film meets each strand along its whole length by construction. Its normal
comes from central differences of the patch itself — four extra evaluations — because a flat normal
on a bellied film kills the grazing term precisely where the film is most visible.

**The two meshes cannot disagree.** They are compiled from one source chunk (`WEB_FIELD_GLSL`) and
hold the same uniform boxes *by identity*, and both roll the per-strand sag dice through
`webEdgeDice()` with the endpoints in an order the CPU builder and both shaders agree on. A film
whose sag drifts a millimetre from its threads' does not look slightly wrong, it looks like cling
film hovering nearby, so the drift was made unrepresentable rather than merely avoided.

**Alpha is a pure grazing term with no constant part.** A real film is invisible head-on and flares
at glancing angles; adding even a small ambient floor turned the web into a frosted disc and took the
whole trick with it. Colour comes from the same angle — thin-film interference shifts hue with path
length, so walking the four-stop gradient with the grazing term gives oil-slick banding for nothing,
and the per-face dice keeps neighbouring panels out of step. Strands are shaded **Kajiya–Kay**,
because a thread has a tangent rather than a normal and the band of light running across a web
perpendicular to its threads cannot be faked with a fresnel.

`nodePoint()` deliberately omits the per-node jitter: the jitter is a `fract`-chain hash evaluated at
`highp`, and a JS mirror at double precision produces a *completely different* number rather than an
approximately right one, because that is what hashes do. Same decision, same reason, as
`Curtain#sheetPoint()` leaving out the ripple.

### `LatticeGrowth` — the refusal is the design

A global hex grid has one lattice and a cell either exists or it does not, so everything you can do
with it is a mask — and every mask reads as *a shape cut out of a honeycomb*, because the honeycomb
was there first.

Here each cell carries **its own lattice frame**, inherited from its parent and turned by up to
`drift` of a turn. A child buds one lattice unit along one of its parent's six directions, so locally
the packing is perfectly hexagonal and three cells in a row look *built* — but two branches that left
the seed around opposite sides of a void arrive back at each other out of register, the candidate
lands within `refuse` of something already placed, and it is **thrown away**. That refusal puts a
seam where two fronts met, a hole where three did, and a perimeter whose raggedness follows the
history of the growth rather than a noise function. `drift = 0.16` with `refuse = 0.94` is the
starting point; at `drift = 0` the refusal never fires and you have the hex grid the roster says not
to build.

Two things that were bugs and are worth not re-learning:

1. **The frontier must be breadth-first.** The first version took the parent as `cursor % n` with
   `cursor` advancing once per attempt. That reads like a sweep and is not one — `n` grows on every
   success, so `cursor` and `n` advance in lockstep and the parent is always the cell placed last.
   What grows is a single chain: a hundred and sixty cells laid end to end over a hundred and twenty
   lattice units, one cell wide. A head pointer that advances only when its parent is exhausted keeps
   the frontier a ring, and three children per parent leaves the lobes in.
2. **Refusal is a spatial hash, not a scan.** A fixed open-addressed head/next pair of `Int32Array`s
   allocated at construction, nine buckets per candidate. The O(n²) version cost several milliseconds
   per regrow at 256 cells — and a regrow happens on every frame of a slider drag, which is exactly
   the interaction this has to survive.

The cell geometry is not a prism. A prism gives a tiled floor and the eye stops at *mosaic*; what
says hive is the **rim and the hole** — a wall with thickness, a shadowed recess, a floor down there
catching light. Only the recess glows (`coreGlow`), and the read comes entirely from the rim being
dark against it.

### `PlateShell` — why the dome closes exactly

Two points on a unit sphere are equidistant from a third exactly when that third lies on the plane
through the **origin** whose normal is their difference — the `|x|²` terms cancel because both sites
are unit vectors. So a spherical Voronoi cell is an intersection of half-spaces through the origin
and can be built by ordinary polygon clipping: start each cell as a wide octagon in the tangent plane
at its site, Sutherland–Hodgman it by one plane per other site, project the survivors back onto the
sphere.

Exactness follows for free. The edge cell *i* gets from the bisector of *i* and *j* lies in the *same
plane* cell *j* gets from bisecting *j* and *i*, and the endpoints of that edge are where a third
bisector cuts it — the same third bisector for both. Adjacent plates share their boundary vertices to
the last bit of the arithmetic that produced them. Measured on a 70-plate dome: **393 polygon
vertices, zero of them unshared, worst coincidence error 1.03 × 10⁻⁷** (float32 storage), and the
summed plate area is within 0.9 % of `2π` — the chord deficit of flat polygons under a sphere, and
nothing else. That is the difference between this and scattering plates and hoping: a
noise-perturbed layout leaves slivers of daylight and the eye finds every one the moment something
bright is behind the dome.

The equator needs no special case — it is one more plane through the origin (`y ≥ 0`), so the plates
meeting the floor meet it in a straight line rather than a fringe.

**Nothing the fly-in does can leave a plate off the tessellation.** Every term — the outward offset,
the spin about the plate's own axis, the swing off the dome — is multiplied by `k = 1 − ease`, which
is exactly zero when the plate has landed. No easing curve or overshoot can be tuned into a gap.

Sites are a **jittered Fibonacci hemisphere**, not a random scatter: the *i*-th of *n* points sits at
height `(i + 0.5) / n`, which distributes area uniformly because a sphere's area is uniform in
height. Random points clump, and a clumped Voronoi gives one plate the size of four, which reads as
damage rather than as armour.

The vertex layout is fixed at `2 + 6·12` slots per plate whatever its real side count — padding slots
collapse onto the last real vertex and draw as zero-area triangles — which is what lets the index
buffer be written once at construction and never touched again. `tessellate()` is O(n²) clips (46
sites ≈ 0.2 ms), runs only when `sites`, `seed` or `jitter` change, and allocates nothing: the
clipper ping-pongs between two scratch arrays sized in the constructor.

### The one rule, per class

- **`ColonySwarm`** — *drive `condense` and `shapeBlend` from the beats and leave the rest alone.*
  The module has two ideas and both are transitions. Parked at `condense = 1` it is a mesh with a bad
  silhouette; arriving as a cloud, closing into a fist over three tenths of a second and opening into
  a spear is the ability.
- **`WebGraph`** — *put the caster somewhere they will move, and never let `filmFill` reach 1.* The
  membrane does not exist head-on, and if every face carries it the panels that flare have nothing to
  flare against.
- **`LatticeGrowth`** — *`drift` and `refuse` are one control, and they are the ability.*
- **`PlateShell`** — *let it finish, and keep `seam` small.* Everything the module is worth happens in
  the last tenth of a second, when the final plates drop into holes that are exactly their own shape.
  A dome held half-built is a scatter of debris, and that is what `ShatterField` is for.

---

## `BrushStroke.js` — a loaded brush, not a ribbon with a noise mask

The Ink school's mark-maker. A brush stroke with real brush dynamics: width from an authored
pressure curve, ink that pools where the brush slows or turns, an edge that wicks into the paper,
and a dry tail that comes apart into separate bristle streaks because the bristles are separately
modelled and separately run out.

It serves `sumistroke` (one enormous stroke down the line, running dry) and `sealscript` (a column
of characters written in the air, top to bottom, one stroke at a time), and both of those are the
same file with different numbers.

**Everything in it is matte.** See [The anti-glow contract](#the-anti-glow-contract) below, which
applies to this module and `InkDiffusion.js` equally and is not optional.

### Draw-call cost

**One.** For every stroke and every bristle: `strokes × bristles` instances of one strip. Two
brushes that must differ in *tip layout* are two `BrushStroke`s and two draw calls; two that differ
only in width, pressure, colour or paper plane are one.

### Signatures

```js
BrushTip = { FLAT: 0, ROUND: 1, SPLIT: 2 }; BRUSH_TIP_NAMES: string[3]
brushStrokeParams() -> object                       // canonical key list with units

new BrushStroke(parent, { strokes = 6, bristles = 14, samples = 40, sides = 6,
                          tip = BrushTip.FLAT, depthWrite = false,
                          layer = LAYER.VFX, renderOrder = 7, name = null })
b.object3D · mesh · material · uniforms · geometry · drawCalls(1) · count · strokeCount · tip
b.capacity · strokes · bristles · samples · sides · seed
b.stroke(i) -> Stroke        // built at construction; out of range clamps
b.setStrokeCount(n) · setPaper(normal) · setColors(a, b, c, d) · roll(seed) · retip(tip) · reset()
b.update(_now, params)       // FIRST ARGUMENT IGNORED
b.pointAt(i, t, out) · tangentAt(i, t, out) · headOf(i) · tipPoint(i, out)
b.pressureOf(i, t) · widthAt(i, t) -> metres · dispose()

stroke.curve(p0, p1, p2, p3)                 // world-space cubic Bezier, the spine
stroke.line(from, to, bow = 0, lift = 0)     // sugar: an arc, bowed in the paper plane
stroke.pressure(entry, swell, hold, exit)    // cubic Bernstein; entry and exit are hit exactly
stroke.ink(load) · timing(start, span) · active · seed · head
```

### The clock

`update()` **ignores its first argument**, like `Swarm` and `Curtain`. A brush mark is not an
animation; it is a standing object whose only temporal parameter is `progress`, and the ability owns
that beat. Taking a clock as well would mean two sources of truth for where the head is, and they
would disagree the first time anything paused.

### The bristle model, and the noise mask that came before it

The first version drew one even ribbon and multiplied its alpha by a noise field to fake the dry
tail. It is the obvious thing and it is wrong in a way you can see from across the room. A mask
makes *holes in a stroke*; dry brush is not a stroke with holes in it, it is four or five separate
marks that used to be one mark, each ending at its own place, each its own width, with clean paper
between them. The mask also breaks up uniformly across the width, because the noise does not know
where the middle of the brush is — and a real brush holds ink in its core long after the outside
bristles have given up.

Instancing the bristles gets all of that for one draw call:

- each bristle carries its own **ink load**, jittered per bristle and starved toward the rim of the
  ferrule by `edgeStarve`, so the stroke goes dry **from the outside in**;
- ink is **spent** by integrating the deposition along the spine — `inkSpent(t)`, a 13-point
  trapezoid — so a stroke that presses hard runs out sooner than one that skims;
- once a bristle's load runs low it makes **intermittent contact**, gated per bristle by a value
  noise along its own arclength. That is the fray, and it happens at a different place for every
  bristle because every bristle started with a different amount of ink.

`skipContrast` exists because of README trap 4: value noise piles up at 0.5, and the contact test
compares it against a dryness in 0..1. Without the contrast curve every bristle on the brush lets go
within a few millimetres of the same place and the stroke ends in a clean horizontal cut — the exact
failure the module was written to avoid, reintroduced by the noise's own distribution.

### Pooling comes out of the deposition, not out of a slider

Deposition has two causes: **area swept**, which scales with the distance covered, and **time in
contact**, which does not. `pigmentAt()` is `pressure * (flowLength + flowDwell * speedRef / speed)`
where `speed` is `|B'(t)|` in metres per unit of the Bézier parameter. Where the spine's control
points bunch, the brush dwells, the second term blows up, and the ink pools — and the *same*
expression, integrated, is what spends the ferrule. That is the reason a hook pools **and** the
tail after the hook is bone dry: one model, two readings.

Curvature adds to it (`poolCurve`), because a tight turn is a pivot on the tip and can still be
quick.

The analytic alternative — integrating only the pressure cubic, which has a closed form — was tried
first. It ignores speed, so a stroke with a hairpin in it never runs dry early, and the hairpin is
where a calligrapher's brush actually empties.

### Why it is a prism and not a billboard

The cross-section is an ellipse of half-width `bw` (the bristle's ink width) and half-depth `depth`
in metres through the paper normal, swept along the spine. Seal script hangs a column of characters
in the air and the camera orbits it: a billboard turned edge-on is thinner than a pixel and the
whole column blinks out of existence. A prism seen edge-on is a solid bar of ink `2 * depth` wide
and the writing stays writing. Face-on the depth is invisible and the mark reads flat, which is what
sumi wants — one geometry serves both because the ellipse is degenerate in exactly one axis.

`setPaper(normal)` is that axis. Sumi lays a stroke on the floor and passes world up; seal script
passes the horizontal direction the column faces.

### The tips

| tip | layout | what it is for |
| --- | --- | --- |
| `FLAT` | one rank across the width | the sumi brush; a dry tail of clean parallel streaks |
| `ROUND` | golden-angle disc fill | streaks separate through the paper normal too; needs `ferruleDepth` |
| `SPLIT` | three tufts with paper between | a brush somebody has already ruined |

`SPLIT`'s tufts are deliberately much narrower than their share of the ferrule. At the first value
they touched, and the mark came back out as a solid stroke — a split brush is defined by the gaps,
not by the clumps.

### Parking, and why a stroke is never compacted

`stroke.active = false` **parks** a stroke: its draw window is pushed past the end of the clock, so
its head resolves to zero and the vertex shader collapses it. It is not skipped and the live strokes
are not shuffled down. The bristle dice live in the instance slot, so compacting would slide every
later character into a different slot and silently re-write it.

### The one rule

**Let the pressure curve spend the ink.** The tail frays where `inkLoad` runs out against what
`pressure()` and the spine's own speed have already spent, so a heavy stroke should fray early and a
skimming one should not fray at all. The way to move the fray is to change how hard the brush is
pressing — not to reach for `dryBand`. If you are tuning the dry parameters to put the fray in a
particular place, the pressure curve is wrong.

---

## `InkDiffusion.js` — ink spreading on the floor, unstably

One ground quad working in **metres from the anchor**, like `GroundField`, carrying ink that spreads
through a real fingering instability: glossy at the wet leading edge, matte behind it, and with a
`SPLATTER` mode that adds a directional mass, a crown of rim teeth and a power-law scatter of
satellite droplets down the travel vector.

It serves `inkbloom` (`BLOOM`) and `splatterbrand` (`SPLATTER` plus `Projectile`), and `WASH` is
there as the cheap flat underlay the other two sit on.

### Draw-call cost

**One.** Always one, whatever the mode, however many satellites.

### Signatures

```js
InkMode = { BLOOM: 0, SPLATTER: 1, WASH: 2 }; INK_MODE_NAMES: string[3]
inkDiffusionParams() -> object                      // canonical key list with units

new InkDiffusion(parent, { mode = InkMode.BLOOM, sources = 4, satellites = 16,
                           layer = LAYER.VFX, renderOrder = 6, name = null })
  // mode, sources and satellites are #defines / array sizes — fixed for the lifetime
f.object3D · mesh · material · uniforms · geometry · drawCalls(1) · mode · age
f.sources · satellites · seed
f.setPlacement(anchor, along)   // `along` is projected flat; it becomes local +z
f.setVisible(v) · roll(seed) · reset() · update(now, params)     // `now` = the ability's age
f.frontRadius(i = 0) -> metres
f.sourcePoint(i, out) · satellitePoint(i, out) · satelliteSize(i) · satelliteReach(i)
f.satelliteAge(i) · dispose()
  // the mirrors read the last-synced params and age: call them AFTER update() on the same frame
```

### The instability, and two versions of it that were wrong

The interface between a thin fluid pushing into a thick one is unstable — a bulge sees a steeper
gradient, moves faster, and becomes a finger. The part that has to be *modelled*, though, is not
that the front is rough. It is the **order the scales arrive in**. A lobe two metres across cannot
exist on a blob that is not yet two metres across, so the coarse modes are inadmissible until the
front has grown into them. A young bloom is a small crinkled disc; a mature one is a handful of
enormous branching lobes with that same crinkle riding on their tips.

`fingers()` is five octaves at wavelengths `coarse`, `coarse/2`, … Octave *k* is **admitted** once
the front radius passes `onset * L_k`, then grows like `exp(growth * travel / L_k)` and **saturates**
at `growthMax`, so a mature mode settles at roughly its own wavelength.

Two earlier versions, both instructive:

1. `r + amplitude * fbm(atan(p.y, p.x))`. Sampling on the **bearing** hands every radius along a
   bearing the same value, so the fingers were dead-straight radial spokes of constant width from
   the centre to the rim — a firework, not a bloom. No number of octaves fixes it: the error is in
   the domain, not the spectrum. The noise here is sampled in two-dimensional metres, so a finger
   can bend and two fingers born at different radii do not line up.
2. All five octaves live from `t = 0` at fixed amplitudes. That is an fbm ring, and the giveaway is
   that it is *the same shape at every size* — you can see that the blob is being scaled rather than
   grown. Admitting the octaves by radius is the whole of the difference and it costs one `max()`
   per octave.

Saturation matters as much as admission: without `growthMax` the first octave to mature eats
everything and the bloom is two lobes for ever.

**`coarse` is the only knob that changes what the pattern *is*.** Everything else changes how much of
it you get. Set it against the field radius first — 3 m of `coarse` on a 4 m field gives two fat
lobes, 0.8 m gives lace — and only then reach for `finger` and `growth`.

### Why the crown *is* allowed to be spokes

In `SPLATTER` the leading edge grows a crown of teeth, and those **are** bearing-indexed. A crown is
a Rayleigh–Plateau breakup of an expanding rim: it genuinely is periodic in bearing, its teeth
genuinely are radial, and its tooth count genuinely does rise with the rim's radius
(`teeth = 2πr / crownSpacing`). The rule was never "never index on bearing", it was "do not index on
bearing when the physics is areal".

The crown is allowed to move the **silhouette and nothing else**, which is why it has its own
distance (`dShade` keeps the pre-crown value). Subtracting it from `d` outright gets the teeth right
and grows a fan of radial spokes reaching all the way to the impact point, because the film's
thickness term reads the same `d` and the crown is periodic in bearing at *every* radius. A rim
instability is a property of the rim.

### The satellites are the readable half

A flung blob does not make a circle. It makes a directional main mass (anisotropy in the **metric**,
never in a bearing-indexed radius, or the mass grows flat facets down its flanks), a crown, and
satellite droplets thrown further along the travel vector.

- **Sizes are a bounded Pareto**, inverse-CDF sampled with exponent `satAlpha` (2–3 is what
  fragmenting sheets actually do). A uniform draw gives a dozen same-sized dots and the eye files it
  as a stencil.
- **Small droplets fly furthest** — they detach last, from the fastest part of the sheet, with the
  least drag per unit mass. `reach` is driven off the *same* draw as `size`, so the far field is fine
  and the near field is coarse.
- **Each droplet is a teardrop**, a bead tapering down a tail that points back toward the throw. A
  droplet that lands moving forward does not make a circle, and the tails are the direction cue that
  turns twelve scattered dots into one thrown handful.
- **Each lands on its own clock**, further meaning later, so the far field arrives after the mass.

The dice are **uploaded as uniform arrays**, not hashed in the shader, so `satellitePoint(i, out)`
agrees with the fragment shader exactly — `splatterbrand` throws a `Projectile` at each satellite
and it has to land *in* the droplet, not near it. A JS mirror of a GLSL hash is a mirror of float32
rounding and it drifts. The arrays are indexed only by the loop counter, which is the one form of
uniform-array indexing ESSL 1.00 allows.

### Wet and dry, with no history

A fragment's ink arrived when the front radius equalled its distance. `r = spread * t^spreadPower`
inverts in closed form, so `arrivalOf(d)` is exact, `age - arrival` is the age of the film at every
point, and the gloss is `exp(-age / dryTime)`. No buffer, no per-fragment state, and the whole
drying pattern re-resolves when a paused author drags `dryTime`.

The gloss itself tips the film's normal outward at the meniscus — a Gaussian on the signed distance
to the interface — and rotates that tilt into world space with the field's own axes, which is why
`setPlacement` uploads `uAxisAlong` / `uAxisAcross`.

### `radius` is a boundary, not a hint

The mass is clipped to `radius` over a soft `clipSoft` band, measured from the **anchor** rather than
from a nucleus, because a zone belongs to the ability and not to the blob. That clip is also what
keeps the quad bounded: a front left running for ten seconds would otherwise grow a canvas the size
of the level. Satellites are exempt — they are thrown out of the zone on purpose — so a `SPLATTER`'s
quad is sized from `throwFar` plus the furthest droplet's tail. Get *that* wrong and the far field is
cut off by a straight edge with a corner on it, which looks worse than having no satellites.

### The one rule

**Set `coarse` against the field radius before you touch anything else.** It is the wavelength of
the largest lobe the bloom can ever grow, and it decides whether the cast reads as a bloom, a puddle
or a bath sponge. Authors who start with `finger` end up with a wobbly disc turned up loud.

---

## The anti-glow contract

Ink is the school with no bloom in it, and that premise is one careless line away from being lost.
Both modules hold to the same four rules, and `scripts/check-vfx-ink.mjs` asserts every one of them
so that losing it fails a check rather than a screenshot.

1. **A luminance ceiling in the fragment stage.** `UnrealBloomPass` runs on linear scene colour
   *before* the tone map — the chain is `RenderPass → distortion → bloom → OutputPass` — so
   `settings.post.bloomThreshold` (0.88 as shipped) is a **linear** luminance. Both materials
   hard-clamp their output luminance to `ceiling`, 0.62 by default. That makes it *impossible* for
   ink to feed bloom, whatever it is standing next to and whatever the pickers are set to, which is
   stronger than "pick dark colours" — one careless picker away from a glowing brushstroke.
2. **Never multiply by `uGlobalGlow`.** Every other VFX material in this library does, because every
   other one is emissive. Ink is not, and the global glow slider must not be able to light it.
3. **`toneMapped: true`,** unlike every other module here. It is inert as things stand — the composer
   always renders to a target, where three switches materials to `NoToneMapping` and `OutputPass`
   grades the composite once for everything — but the flag is a statement about what the material
   *is*. Ink is pigment and belongs under the same grade as the floor it is lying on. Copying
   `toneMapped: false` off an emissive module into a matte one is exactly the mistake this school
   exists to avoid.
4. **No additive path, and no specular except one.** Neither module can be switched to
   `AdditiveBlending`; "ink that adds light" is the school's failure mode. The single specular term
   is the gloss on `InkDiffusion`'s wet leading edge, and it is inside the ceiling — a reflection
   that cannot exceed the bloom threshold is an observation about a wet surface, not an emission.

### Verifying these two

```
node scripts/check-vfx-ink.mjs     # ~950 assertions, ink-specific
npm run check                      # the shared vfx stage, plus every ability
```

The bench covers what the shared stage cannot: static shader sanity (balance, reserved words,
backticks, undeclared uniforms, varyings, `fwidth` in a vertex stage), the anti-glow contract above,
the bristle layouts and the parking path, the admission order of the instability's octaves, the
shape of the satellites' power law, and the placement mirrors that `splatterbrand` aims with.

---


## `HardSurface.js` — the machined half of the material vocabulary

Gears, pistons, sawblades, plates, bolts and anvils, in brushed steel that can be brought up to
forging heat and back down again.

Everything in this sandbox before Forge was **grown, quarried or bled** — crystal, rock, bone, vine,
ash, blood. All of it soft-edged, all of it noise-driven, all of it made by nature. A machined
object reads differently for three reasons, and none of them is the silhouette:

1. **Its edges are deliberate.** A chamfer is a decision. Nature does not put a 0.4 mm bevel round
   the top of a hole, and no shader can fake one — the geometry has to have it. That is why this
   module generates geometry at all rather than shipping a material and letting abilities bring
   their own boxes.
2. **Its highlight is directional.** Brushed and turned metal has a grain and the specular smears
   *across* it into a line. An isotropic GGX lobe on a cylinder is a plastic bottle; an anisotropic
   lobe whose tangent runs round the axis is a lathe-turned collar — same silhouette, same albedo.
3. **Its colour is a temperature, not a palette.** Steel above about 900 K stops taking its colour
   from the room and starts making its own, along one curve every foundry photograph agrees on.
   Authoring that curve as a four-stop gradient is the tell.

### Attach convention, and draw calls

**Neither.** This is a toolkit, like `prefixedBlock.js`, not a system: it owns no meshes, adds
nothing to a parent and has no `update()`. **Zero draw calls of its own** — whatever you hang the
geometry on pays. In practice that is `GrowthField` (which wants a factory and a material and owns
the instancing), `Projectile`, or a plain `Mesh`.

### Settings convention

**Canonical.** `hardSurfaceParams()`, `gearTrainParams()` and `grindParams()` are the three key
lists, all re-read on every call. The *shapes* are the interesting exception.

### Signatures

```js
import {
  HardShape, HARD_SHAPE_NAMES, HardAxis, BrushMode, BRUSH_MODE_NAMES,
  gearShape, pistonShape, sawbladeShape, plateShape, boltShape, anvilShape, hardShape,
  createGearGeometry, createPistonGeometry, createSawbladeGeometry,
  createPlateGeometry, createBoltGeometry, createAnvilGeometry, hardSurfaceGeometry,
  gearPitchFraction, gearRootFraction, ShapeCache,
  GearTrain, gearTrainParams,
  createHardSurfaceMaterial, syncHardSurfaceMaterial, hardSurfaceParams,
  blackbodyColor, heatToKelvin,
  GrindContact, grindParams
} from '../vfx/HardSurface.js';

HardShape = { GEAR: 0, PISTON: 1, SAWBLADE: 2, PLATE: 3, BOLT: 4, ANVIL: 5 }
HardAxis  = { Y: 0, X: 1, Z: 2 }          // which way the part's own axis points once seated
BrushMode = { LINEAR: 0, CIRCUMFERENTIAL: 1, RADIAL: 2 }

<kind>Shape(overrides) → object            // all-numeric; every field is a slider
hardShape(kind, overrides) → object        // the dispatcher form
hardSurfaceGeometry(kind, shape) → BufferGeometry     // position, normal, aEdge, indexed
create<Kind>Geometry(shape) → BufferGeometry          // same thing, named

gearPitchFraction(shape) → 0..1            // pitch radius / actual outer radius
gearRootFraction(shape)  → 0..1

new ShapeCache({ capacity = 8 })
cache.get(slot, kind, shape) → BufferGeometry   // rebuilds only when a number moved
cache.changed · size · dispose()

new GearTrain({ capacity = 12 })
train.plant(count, seed) → number           // onSpawn; the only dice roll
train.solve(p)                              // every frame, dt = 0 included
train.count · teethOf(i) · pitchRadiusOf(i) · tipRadiusOf(i) · angleOf(i) · rateOf(i)
train.scaleOf(i, pitchFraction = 0) → metres          // uniform instance scale
train.yawOf(i) → radians                              // write into mesh.rotation.y
train.positionOf(i, p, out) · contactOf(i, p, out)    // world; contact is the pitch point
train.clear()

createHardSurfaceMaterial({ environment = null, flatShading = false })
  → MeshStandardMaterial with .userData.uniforms and .userData.sync(p)
syncHardSurfaceMaterial(material, p) → material       // call EVERY frame
blackbodyColor(kelvin, out?) → THREE.Color            // the same locus, on the CPU
heatToKelvin(heat, p) → kelvin

new GrindContact()
GrindContact.rimVelocity(out, axis, rate, point, centre) → out     // v = ω × r
grind.solve(contact, normal, rimVelocity, p) → this
grind.jet(index, emit) → emit                         // fills position/direction/speed/…
grind.jets · speed · rimSpeed · origin · direction · normal · binormal
```

### Shapes are unitless, and that is what keeps I1 honest

A shape object holds **no metres**. Every generator emits geometry normalised into the unit box:
the largest extent — footprint diameter or height, whichever binds — is exactly 1, the body sits on
`y = 0`, and the axis is centred. The footprint therefore always fits the circle of radius 0.5 that
`GrowthField`'s factory contract asks for, and the instance transform is the only place a metre
appears.

So a shape field is a **proportion**: `gearShape().thickness = 0.22` means "0.22 of the gear's own
diameter", and a gear scaled to 1.4 m across is 0.31 m thick. The one place it bites back is a field
that controls the *dominant* dimension — push a piston's `length` past its diameter and `length`
stops changing the silhouette and starts changing what the other proportions mean, because the
normalisation divides it straight back out. The alternative, normalising each axis separately, makes
every proportion slider inert and turns a gear into a drum the moment you touch its thickness.

The good consequence: a gear's **module** — metres of pitch diameter per tooth, the number that
decides whether two gears mesh — is a metre, so it is *not in `gearShape()` at all*. It lives in
`GearTrain`'s params. Drag it and the whole train re-spaces and re-phases without one vertex being
rebuilt.

### Build cost, and where to spend it

Measured on an M-series, cold:

| shape | vertices | triangles | build |
| --- | --- | --- | --- |
| `GEAR` (14 teeth, `flankSteps: 6`) | 3,948 | 4,200 | 8.7 ms |
| `SAWBLADE` (22 teeth, 4 slots) | 3,778 | 3,522 | 4.4 ms |
| `BOLT` (9 thread turns) | 1,625 | 2,228 | 1.3 ms |
| `PISTON` | 1,178 | 1,248 | 1.1 ms |
| `ANVIL` | 595 | 1,084 | 1.2 ms |
| `PLATE` | 760 | 924 | 0.8 ms |

Nine milliseconds is a dropped frame, so **nothing here may be rebuilt speculatively** — that is
what `ShapeCache` is for, and what `GrowthField#syncGeometry` is already for one level up. For a
*field* of gears rather than a hero one, drop `flankSteps` to 3 and `tipSteps`/`rootSteps` to 1: the
tooth count is the silhouette and the flank samples are not, and it costs a third of the vertices.

### The involute, and why it is not decoration

`gearlock`'s trick is that the teeth genuinely mesh, and they only mesh if the profile is right.
Two things do that work.

**The curve.** The flank is a real involute of the base circle: half the angular tooth thickness at
radius *x* is `ψ(x) = ψ_p + inv(α) − inv(α_x)` with `cos α_x = r_b / x` and `inv(α) = tan α − α`. At
the pitch circle `α_x = α` and it collapses to `ψ_p`, which is the identity to check when you change
anything in there. Involute flanks transmit motion at a constant ratio *regardless of centre
distance*, which no other tooth curve does, and which is what lets an ability drag the module and
stay meshed instead of needing a new profile.

**The phase.** Rate alone is not enough, and this is the failure everybody ships. Two gears turning
at the perfect ratio still interpenetrate unless a tooth of one is aimed at a *gap* of the other
along the line of centres, and that is a constraint on the absolute angles, not their derivatives:

```
θ₂ = β + π + (z₁/z₂)(β − θ₁) − π/z₂
```

Differentiate it and `ω₂ = −(z₁/z₂)ω₁` falls out, which is the check that it is the right
constraint. The first version of `GearTrain` set the rates from the tooth counts and left the phases
at zero: the train counter-rotated correctly and the teeth ground straight through one another,
which is a bug you can watch for a full minute before you see it.

Both are verified numerically rather than by eye. Sweeping a full turn of five tooth pairs with
`backlash: 0`, the flanks stay in contact to within **0.02–0.4 mm on gears two metres across** and
nothing crosses; drop the `−π/z₂` term and 70+ points per frame are inside the other gear. The
default `backlash: 0.04` opens that to a ~9.5 mm clearance that never varies by more than a
millimetre over the sweep, which is conjugate action doing exactly what it promises.

The other numbers a train needs are equally unforgiving: the centre distance is `m(z₁ + z₂)/2`,
which is the sum of the **pitch** radii — not the tip radii, the tempting wrong answer that leaves a
gap of one whole tooth height.

**A tooth count is a shape, not a transform.** Gears with different `teeth` cannot share an
`InstancedMesh`. Keep a train to two or three distinct counts and it stays at two or three draw
calls; give every gear its own count and you have bought a draw call each.

### Profiles are clamped, because Earcut does not throw

Every field in these shapes is a live slider, so every combination of them is reachable, and a
self-intersecting outline does not raise anything — `ShapeUtils.triangulateShape` answers it with a
fan of inverted triangles and the part renders inside out. A sweep of 1,080 gear profiles and 2,160
blade profiles across the editor's whole range found three separate ways in, all now closed:

- **A pointed tooth** (high addendum, low tooth count) has a real answer — the tip circle moves down
  to the radius where the flanks meet, found by bisection. Clamping the half-angle at zero instead
  leaves every sample above that radius on the centreline and the flanks walk through each other.
- **A tooth wider than its own pitch** happens on a fine, high-pressure-angle gear whose half-angle
  passes `π/z` before the flank reaches the base circle. The flank now starts at whichever radius
  comes first and the fillet covers a little more of the root.
- **A blade's rake and clearance** are clamped *two-sided*. Only the upper bound was guarded at
  first — the case where a deep hook and a deep relief eat the whole tooth pitch — and a strongly
  negative rake then swung the cutting face back past the clearance face of its own tooth. The
  condition is one number either way: the sum `(tan rake + tan clearance)·ln(r_tip/r_gullet)` has to
  stay inside `(−2·land, pitch − 2·land)`.

Both working faces of a saw tooth are **logarithmic spirals**, incidentally, and that is not a
flourish: a face at a constant angle β off the radial satisfies `dθ/dr = −tan β / r`, whose integral
is `θ(r) = θ_tip ± tan β · ln(r_tip/r)`. Straight chords look right at 24 teeth and visibly wrong at
8, where the rake at the gullet ends up nothing like the rake at the tip.

### `aEdge`, and why only a generator can produce it

The generators emit positions and topology only, welded; a single pass afterwards splits creases
(the standard smoothing-group algorithm), computes normals, and hands back `aEdge` — a per-vertex
value marking where the machinist's file would have been. A material handed somebody else's mesh has
no way to know that, which is the whole argument for generating geometry here.

The first version marked every crease and was useless: **every** ring of a chamfered extrusion is a
crease, so 84% of a gear's vertices came back marked, `aEdge` was 1 almost everywhere, and edge wear
just brightened the part. What the material wants is the *lip* — the outermost ring of a chamfer,
falling to zero across the band, which is a thin bright line rather than a wash. So the generators
author that ring directly and an unhinted crease is worth only `CREASE_WEAR` (0.22), enough to catch
a bore rim and not enough to lose a face.

Degenerate triangles are dropped rather than skipped: a gear's root fillet collapses to a sliver
when `rootFillet` winds down, and a zero-area triangle contributes a NaN normal that poisons the
whole vertex.

### The material

A patched `MeshStandardMaterial`, so it takes CSM's real shadows and the HDR probe, in the
`IceMaterial` tradition. Uniform boxes are parked on `material.userData.uniforms`.

| term | roughness | metalness | albedo | emissive |
| --- | --- | --- | --- | --- |
| grain | ± streaks along the brush | — | — | modulates the lobe |
| pitting | up | — | toward `colorDeep` | — |
| mill scale | up | **down** | toward `colorScale` | kills the lobe |
| edge wear | down | — | toward `colorPolish` | lifts the lobe |
| heat | — | — | toward the blackbody colour | `(T/T_ref)⁴` |

The metalness drop under mill scale earns its line: scale is an oxide, oxides are not conductors,
and a scaled patch that keeps `metalness = 0.94` reads as a dirty mirror instead of a crust.

**The anisotropy is hand-rolled, and it had to be.** `MeshPhysicalMaterial` has had native
anisotropy since r155 and it is better than this. It is also unreachable: it reads its direction
from the tangent frame, which three only switches on (`USE_TANGENT`) alongside a **normal map** —
and a normal map is a texture, which **I2** forbids. Supplying a `tangent` attribute without the map
leaves the define off and the anisotropy silently isotropic, which is the failure that cost the
afternoon — the material compiled, `material.anisotropy = 0.8` was set, and nothing changed. So the
lobe is a **Ward** anisotropic specular against `frame.uLightDir`, added to
`totalEmissiveRadiance`. It is not shadowed (the injection point is before the light loop, where the
shadow factor does not exist yet) and it is one light. Neither has ever been visible on a spinning
gear.

The tangent is transformed by `mat3(modelViewMatrix)`, **not** `normalMatrix`. A tangent lies along
the surface and transforms like a position difference; the inverse-transpose is for normals. It
matters more than usual here because `GrowthField` scales footprint and height independently, so a
squat gear is genuinely non-uniformly scaled and the two matrices visibly disagree.

`hardBrushDir()` is shared verbatim between the two stages. It has to be: the vertex stage needs the
tangent in view space for the lobe and the fragment stage needs the same direction in local space to
squash the grain noise along. Two copies of the maths gives you a highlight running at a slight
angle to the streaks it is supposed to be lying in, which looks like a bug in the noise and is not.

### The blackbody ramp — `quench`'s whole trick

One `heat` uniform in 0..1 maps to kelvin between two sliders (300 K cold workshop, 2000 K welding
heat by default), and the colour comes off the **Planckian locus**: Kim et al.'s cubic for CIE `x`,
a second cubic for `y`, then `xyY → XYZ → linear sRGB`. Emission is `(T/T_ref)^n` with `n = 4` from
Stefan–Boltzmann, so hot metal genuinely glows and cool metal genuinely does not — 900 K is 0.27 of
the reference and 1800 K is 4.3.

Two things about it are worth knowing before anybody edits it.

**Kim's fit stops at 1667 K and every temperature this material cares about is below it.** 1667 K
is bright orange; forging heat is 1450 K, first visible red is 900 K, and a quench spends its whole
life under the fit. Clamping there — the first version — gave one flat orange across the entire ramp
that simply dimmed, and a quench that dims is not a quench. Extrapolating the cubic instead is
worse and is spectacular: below ~1200 K `x` runs off past the spectral locus, `y` collapses, and the
metal cools through cherry into *magenta* and then into a colour that does not exist. So the low end
gets its own fit, a quadratic in `1000/T` through the published locus points at 1667 K, 1000 K and
800 K, landing within 0.005 of the true chromaticity at 1200 K. The `y` cubic needs no such
treatment — it is a fit in `x`, not in `T`, and it tracks the locus to within 0.004 all the way
down.

What comes out, and it is a cooling curve rather than a gradient:

| K | 900 | 1000 | 1100 | 1200 | 1450 | 1600 | 1800 | 2000 | 2400 | 3000 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hue | `#ff0000` | `#ff1200` | `#ff3300` | `#ff4600` | `#ff6400` | `#ff7000` | `#ff7e00` | `#ff8b16` | `#ffa042` | `#ffb86d` |

**Edges run cooler.** A chamfer has more surface per unit of steel behind it, so `heatEdge` subtracts
`aEdge` from the temperature: the machined edges are the first thing to go black in a quench and the
last thing to come up in a fire.

`blackbodyColor(kelvin, out)` is the same locus on the CPU, for a light colour or a particle tint.
Use it: sparks off hot steel are the same temperature as the steel, and hard-coding an orange for
them is how a quench ends up with cherry-red metal throwing lemon-yellow sparks.

### `GrindContact` — `sawline`'s whole trick

A saw that throws sparks radially is a firework. Real grinding sparks leave at the **contact
tangent** — they are lumps of the workpiece that were travelling with the tooth when it let go of
them, so they carry off the tooth's velocity, and the tooth's velocity at the rim is tangential by
definition. Point them along the radius and you have drawn a dandelion; point them along `ω × r` and
you have drawn an angle grinder, from the same particle system with the same colours.

Two corrections sit on top. A tooth at the contact is usually driving *into* the workpiece, so part
of `ω × r` points below the surface — sparks do not tunnel, so that component is reflected back out
with a restitution (`bounce`), and `rise` tilts the whole sheaf away from the floor, which is what
makes the arc every photograph of a grinder shows. The ratio between them is the difference between
a cut-off wheel and a bench grinder, so both are sliders.

The fan sweeps in the plane containing the normal, which means its flattest jet can still end up
pointing into the workpiece — the harness caught exactly that — so each jet is lifted back to a
grazing angle (`graze`) if it goes under. A spark emitted into the floor is a spark you never see,
and it reads as the stream thinning on one side for no reason.

The jets are spread deterministically across the fan and only the particles inside them are random.
A random fan re-rolls its shape every frame and the stream shimmers; a fixed fan with random
particles reads as one continuous sheaf.

```js
GrindContact.rimVelocity(_vel, _axis, spinRate, _contact, _centre);
this.grind.solve(_contact, _normal, _vel, this._grindParams);
for (let j = 0; j < this.grind.jets; j++) {
  this.grind.jet(j, _emit);
  _emit.time = this.age;
  _emit.tint = blackbodyColor(1900);
  this.sparks.emit(count, _emit);
}
```

`jet()` writes the caller's emit object and points its vectors at the solver's own scratch;
`ParticleSystem#emit` reads and never retains, which is the contract that makes it allocation-free.
Do not keep the object.

### Composing with `GrowthField`

`createHardSurfaceMaterial()` does not carry `GrowthField`'s per-instance varyings, but the two
patches **compose** — both route through `patchOnBeforeCompile` and both re-emit the
`#include <common>` they replace — so `patchGrowthMaterial(metal, {})` over the top gives a gear the
birth flash and the stagger as well. Hand `GrowthField` the raw generator as its factory, not a
`ShapeCache`: it already runs the same change test one level up, and it disposes the geometry it is
handed the moment its own hash moves, which would free a gear another ability was still drawing.

### The one rule, per part

- **The shapes** — *author proportions, never sizes, and let the instance carry the metre.* The
  moment a shape field means millimetres, `syncGeometry` starts firing on a slider that should have
  been a transform, and a nine-millisecond rebuild lands in the middle of a cast.
- **`GearTrain`** — *place gears by `positionOf` and `scaleOf`, never by hand.* The centre distance
  is the sum of the pitch radii and the phase has a `−π/z₂` in it; both are easy to nearly get
  right, and nearly right is teeth passing through teeth.
- **The material** — *drive `heat` and leave the palette alone.* There is no `colorHot` picker and
  there should not be one. The whole value of the term is that nobody gets to place the yellow.
- **`GrindContact`** — *hand it `ω × r`, not a direction you liked the look of.*
