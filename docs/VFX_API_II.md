# The VFX tech library, part II — the twelve modules added for schools X–XV

Read alongside `docs/VFX_API.md` (the original fourteen). Signatures below were read back off the
source by the integration pass, not taken from the authoring agents' reports.

FINAL AUTHORITATIVE API SUMMARY — the ten new modules

Read back off the source and mechanically verified. Full text in `docs/VFX_API.md` and `src/vfx/README.md` § API reference.

### `src/vfx/SceneHooks.js` — 0 draw calls (2 while `HOLE` is held) · singleton · tokens
```js
import { sceneHooks, Hook, disruptUniforms, disruptGLSL, gravityUniforms, gravityGLSL,
         patchAgeMaterial } from '../../vfx/SceneHooks.js';
Hook = { KEY_LIGHT:'keyLight', GRADE:'grade', AGE:'age', HOLE:'hole', GRAVITY:'gravity', DISRUPT:'disrupt' }
sceneHooks.acquire(hook, owner) -> token          // never null for a real hook; owner is `this`
sceneHooks.isHeld(h) · driver(h) · heldCount · reclaim(owner) · releaseAll() · observe(material)
sceneHooks.gravityAt(x,y,z) · disruptAt(x,y,z) · ageAt(x,z)      // CPU mirrors of the GLSL
token.blend(0..1) · hold() · release() · token.driving/active
KEY_LIGHT t.aim(az,el)·tint(c)·brightness(i)   GRADE t.saturate·temper·raise·darken
AGE  t.at|atPoint · field(radius,edge,amount,inner=0) · wear(rust,dust,moss,pit,bleach) · scale(m) · colours(r,d,m)
HOLE t.at|atPoint · size(radius,squash=1)      GRAVITY t.at|atPoint · well(r,edge=.25) · scale(inside,outside=1)
DISRUPT t.at|atPoint · region(r,edge=.35) · power(drain,fracture,dim) · shardSize(px)
// opt in: sharedUniforms({ ...disruptUniforms() }) + ${disruptGLSL};
//   VS: vDisrupt = disruptAt(worldPos);  FS: disruptShade(colour, alpha, vDisrupt, gl_FragCoord.xy);
```
**The one rule:** `this.borrow(sceneHooks.acquire(hook, this))`. One token per (hook, owner) — re-acquiring renews. Two owners resolve LIFO. Never call `install`/`apply`/`uninstall`; they are `App`'s.

### `src/vfx/TimeControl.js` — 0 (the field) / 1 per ghost · pool + parent · canonical
```js
import { timeField, TimeRegion, MAX_TIME_REGIONS, timeRegionParams, TimeRecorder, recorderParams,
         MAX_TRACK_SAMPLES, MAX_TRACK_BONES, GhostRig, createGhostMaterial, ghostLook,
         applyGhostLook, findCaster, TimeWarpClock, RewindGate, reverseTime, reverseRate,
         reverseParams } from '../../vfx/TimeControl.js';
import { timeWarpGLSL } from '../../shaders/lib/timewarp.glsl.js';
timeField.acquire(now?) -> TimeRegion | null      // NULL when all four slots are taken
timeField.release(r) · reset() · liveCount · clockAt(clock,v3) · weightAt(v3)
region.lock(now?) · place(v3) · placeXYZ · sync(p) · weightAt(v3) · release() · isLive · hold
// p = { radius m, strength 0..1, core 0..1, rate }   rate 0 stasis · -1 rewind · 0.25 slow · 1 identity
// shader: ${timeWarpGLSL}  float t = warpedTime(uTime, vWorldPos) - uBirth;
//                          float held = timeRegionWeight(vWorldPos);
new TimeRecorder({ capacity=120, bones=MAX_TRACK_BONES })
  .attach(src)·detach()·clear()·sample(now,p)·trim(now,p)·transformAt(t,pos,quat)·poseAt(t,ghost)
new GhostRig(parent,{layer,renderOrder,material}) .setSource(src) /* ALLOCATES — I3 exception */
  .place(pos,heading=0)·setScale(s)·sync(look)·visible·drawCalls(1)·dispose()
new TimeWarpClock(start=0).advance(dt,rate,floor,ceiling) · emitDt · spanDt · reversing · stalled
```
**The one rule:** `acquire()` can return `null` — guard it (I6), and `this.borrow()` it. A shader whose *position* depends on its clock cannot use `warpedTime` (feedback loop); probe each slot at the position the body had when that slot locked, as `ParticleSystem` does.

### `src/vfx/Caustics.js` — 1 draw call · parent · canonical
```js
new Caustics(parent, { source=CausticSource.SCROLL, shape=CausticShape.DISC, custom='',
                       uniforms=null, additive=true, depthTest=true, layer, renderOrder=7, name })
CausticSource={SCROLL:0,WAVE:1,CUSTOM:2}  CausticShape={DISC:0,CONE:1,LANE:2}  CAUSTIC_RIPPLE_SLOTS=8
c.object3D · drawCalls(1) · boundCount · setVisible(v)
c.bindSource(liquid.uniforms, keys=CAUSTIC_BOUND_KEYS) · unbindSource()
c.ripple(u,v,strength=1,now=0) · clearRipples()    // no-ops while uRipples is bound
c.reset() · update(p) /* NO CLOCK */ · setAdditive(b) · dispose()
```
**The one rule:** `bindSource(liquid.uniforms)` and the wave and its light on the floor become one set of numbers — and `update()` then skips every bound key, because a number with two authors has none. `SCROLL` is fill-heavy (~100 hashes/px): one per screen.

### `src/vfx/LightShaft.js` — 1 draw call · parent · canonical
```js
new LightShaft(parent, { capacity=6, layout=ShaftLayout.SINGLE, sides=14, maxSteps=48,
                         layer, renderOrder=10, name })
ShaftLayout = { SINGLE:0, LINE:1, RING:2, SCATTER:3 }
s.object3D · drawCalls(1) · instanceCount · layout(get/set) · visible(get/set)
s.setPlacement(anchor, along, up) · roll(seed) · reset() · update(p) /* NO CLOCK */
s.footPoint(i,p,out) · mouthPoint(i,p,out) · irradianceAt(point,p,out=null) -> 0..1 · dispose()
```
**The one rule:** `irradianceAt()` is how the scene's own dust joins in — multiply it into your existing particles and set `mote: 0`. Second most expensive fragment in the library after `VolumeHull`; `steps` is the slider, `maxSteps` the compile-time cap.

### `src/vfx/LensFlare.js` — 1 draw call · `.object3D` · canonical
```js
new LensFlare({ ghosts=8, renderOrder=3000, layer=LAYER.VFX, name })   // ghosts = CAPACITY
FlareRole={CORE:0,STREAK:1,RING:2,GHOST:3}   MAX_FLARE_GHOSTS=8   lensFlareParams()
f.object3D · drawCalls(1) · capacity · visible(get/set)
f.setAnchor(v3) · setAnchorXYZ(x,y,z) · anchor(out?) · update(p) /* NO CLOCK */ · dispose()
```
**The one rule:** with `frame.uSceneDepth` unbound, occlusion is forced to 0 and the flare never appears — the inverse of README trap 7, and correct in the app.

### `src/vfx/Mirror.js` — 1 draw call **+ one nested `renderer.render()`** · `.object3D` · canonical
```js
new Mirror({ resolution=384, layer=LAYER.VFX, reflectLayer=LAYER.WORLD, renderOrder=4,
             doubleSided=true, depthWrite=false, name })
mirrorParams() · mirrorBudget={max:2,live,rendered,skipped,calls,triangles} · setMirrorBudget(n)
m.object3D · drawCalls(1) · resolution · visible(get/set) · priority · lastCalls · lastTriangles
m.setPlacement(anchor, normal, along) · update(p) /* NO CLOCK */ · dispose()
```
**The one rule:** the reflection is a full extra traversal of `LAYER.WORLD`, driven from the mesh's own `onBeforeRender` — **no visible mirror, no pass**. Hard cap of two rendering mirrors a frame. `renderer.info` is contaminated on a mirror frame; read `mirrorBudget`/`lastCalls` instead.

### `src/vfx/BrushStroke.js` — 1 draw call · `.object3D` · canonical
```js
new BrushStroke(parent, { strokes=6, bristles=14, samples=40, sides=6, tip=BrushTip.FLAT,
                          depthWrite=false, layer, renderOrder=7, name })
BrushTip = { FLAT:0, ROUND:1, SPLIT:2 }
b.object3D·uniforms·drawCalls(1)·count·strokeCount·tip · setStrokeCount(n)·retip(t)·reset()
b.stroke(i) -> { curve(p0,p1,p2,p3) · line(from,to,bow=0,lift=0) ·
                 pressure(entry,swell,hold,exit) · ink(load) · timing(start,span) · active · seed }
b.setPaper(normal)·setColors(a,b,c,d)·roll(seed)·update(_now, p)   // FIRST ARG IGNORED
b.pointAt·tangentAt·headOf·tipPoint·pressureOf·widthAt·dispose()
```
**The one rule:** `p.progress` is the only beat — `update()` ignores its clock (the `Swarm`/`Curtain` precedent). Every bristle spends its own ink load, so the stroke dries from the outside in.

### `src/vfx/InkDiffusion.js` — 1 draw call · `.object3D` · canonical
```js
new InkDiffusion(parent, { mode=InkMode.BLOOM, sources=4, satellites=16, layer, renderOrder=6, name })
InkMode = { BLOOM:0, SPLATTER:1, WASH:2 }          // a #define, fixed at construction
k.object3D·uniforms·drawCalls(1)·age·setVisible(v)·setPlacement(anchor,along)·roll(seed)·reset()
k.update(now, p)                                    // now = the ability's age
k.frontRadius(i=0)·sourcePoint(i,out)·satelliteSize(i)·satelliteReach(i)·satellitePoint(i,out)·satelliteAge(i)
```
**The one rule:** the **anti-glow contract** — hard linear-luminance ceiling 0.62 against the 0.88 bloom threshold, `toneMapped: true`, no `uGlobalGlow`, no additive path. Ink is the one school that must not glow, and it is enforced rather than trusted. `satellitePoint(i)` matches the shader exactly, for projectiles.

### `src/vfx/FoldMesh.js` — 1 draw call · parent · canonical
```js
new FoldMesh(parent, { pattern=FoldPattern.CRANE, layout=FoldLayout.LINE, capacity=32,
                       segments=20, segmentsV=segments, renderOrder=4, layer=LAYER.WORLD, name })
FoldPattern={FLAT:0,DART:1,CRANE:2,FAN:3,UNROLL:4}   FoldLayout={LINE:0,ZONE:1,SINGLE:2}
MAX_CREASES=12 · VALLEY=1 · MOUNTAIN=-1 · fanCreases(count=8,turns=0.5) · CREASE_PATTERNS
m.uniforms·count·drawCalls(1)·visible·layout(get/set)·setPattern(p)
m.setColors(paper,shade,transmit,ink,crease)·setBasis(origin,direction,side,length)·reset()
m.update(_now, p)   // FIRST ARG IGNORED — p.fold is the beat
m.sheetPoint(index,p,out)·spoolPoint(index,p,out)·dispose()
```
**The one rule:** nothing interpolates a position — each crease is a **rigid motion per material point**, so the paper never stretches. Crease tables are authored root-first and walked backwards; `UNROLL` places by arc length.

### `src/vfx/Dissolve.js` — 0 (patch) / 1 (heap) · parent · canonical
```js
patchDissolveMaterial(material, { mode=DissolveMode.VOXEL, space=DissolveSpace.LOCAL,
                                  uniforms=null, environment=null, vertex='', fragment='' })
dissolveUniforms(overrides={}) · syncDissolve(target, p) /* every frame */ · dissolveParams()
dissolveSchema(label='Dissolve') · DissolveMode={VOXEL:0,GRANULAR:1,EROSION:2} · DissolveSpace={LOCAL:0,WORLD:1}
new DissolveField(parent, { along=72, across=40, renderOrder=3, layer=LAYER.WORLD, name })
d.uniforms·drawCalls(1)·visible·setBasis(origin,direction,side,length)·setColors(fresh,settled,face,deep)
d.reset()·update(now, p)·frontPoint(now,p,out)·crestHeight(now,p)·dispose()
```
**The one rule:** several meshes dissolving as one event **share the uniform box by identity** — `dissolveUniforms()` once, passed to every `patchDissolveMaterial`. Cloning it gives you two events that drift. `WORLD` space never on a projectile.

### `src/vfx/Colony.js` — 1 / 2 / 1 / 1 · parent · canonical
```js
new ColonySwarm(parent, {…Swarm options})     // EXTENDS Swarm; splices its vertex shader
c.update(_now, p)  // FIRST ARG IGNORED; calls super.update() first · c.shapeCentre(out)
ColonyShape = { BALL:0, WALL:1, SPEAR:2, FIST:3, RING:4, COLUMN:5 }
new WebGraph(parent,{maxRings=8,maxSpokes=16,samples=10,filmSubdiv=2,additive=false,renderOrder=11})
w.drawCalls(2)·count·roll·reset·setPlacement(anchor,normal,up)·update(_now,p) /* IGNORED */
w.nodePoint(ring,spoke,p,out)   // ring -1 is the hub; omits the per-node jitter, deliberately
new LatticeGrowth(parent,{capacity=192,sides=6,wall=.24,recess=.62,renderOrder=2,…})
g.drawCalls(1)·count·reset·setPlacement(anchor,forward)·update(now,p)·cellPoint(i,p,out,height=1)
new PlateShell(parent,{capacity=64,renderOrder=2,castShadow=true})
s.drawCalls(1)·count·tessellate(sites,seed,jitter)·update(now,p)·progress(now,p)·plateCentre(i,p,out)
```
**The one rule:** blend the **fields**, not the points — `mix(fieldA, fieldB, k)` is a real shape at every `k`; a point crossfade's midpoint is a smear. `LatticeGrowth`/`PlateShell` take the ability's `age`; the other two ignore their clock.

### `src/vfx/HardSurface.js` — 0 draw calls (a toolkit) · no attach · canonical
```js
gearShape/pistonShape/sawbladeShape/plateShape/boltShape/anvilShape(overrides) · hardShape(kind,o)
create<Kind>Geometry(shape) · hardSurfaceGeometry(kind,shape)     // unit space, seated on y=0
gearPitchFraction(shape) · gearRootFraction(shape)
new ShapeCache({capacity=8}).get(slot,kind,shape) · changed · size · dispose()   // per ability, NEVER shared
new GearTrain({capacity=12}) .plant(count,seed)·clear()·solve(p) /* every frame, dt=0 too */
  .teethOf·pitchRadiusOf·tipRadiusOf·scaleOf(i,pitchFraction=0)·angleOf·rateOf·yawOf·positionOf·contactOf
createHardSurfaceMaterial({environment=null,flatShading=false}) · syncHardSurfaceMaterial(m,p)
hardSurfaceParams() · heatToKelvin(heat,p) · blackbodyColor(K,out?)
new GrindContact().solve(contact,normal,rimVel,p).jet(index,emit) · GrindContact.rimVelocity(out,axis,rate,point,centre)
```
**The one rule:** a **tooth count is a shape, not a transform** — gears with different `teeth` cannot share an `InstancedMesh`. A gear is ~8.7 ms to build: never speculatively, always through a `ShapeCache`. Uniforms are parked on `material.userData.uniforms` (I8).

### Plus, new and shared
`src/vfx/quads.js` — `acquireGroundQuad()` / `releaseGroundQuad()` (XZ, refcounted) and `uprightQuad()` (XY, module-lifetime). Neither carries a metre: scale the mesh.
`shaders/lib/common.glsl.js` — **`commonVertexGLSL`** for vertex stages; `commonGLSL` stays fragment-only.
`utils/color.js` — **`putColor(target, value, fallback)`** for string-or-`Color`-or-missing params.
`abilities/Ability.js` — **`this.borrow(handle)`**; `destroy()` gives every borrowed global back.