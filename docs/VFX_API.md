# The VFX tech library — API reference

Condensed from `src/vfx/README.md` (which is long, and worth reading for the *why*). Every
signature below was read back off the source by the integration pass.

**Twenty-six modules under `src/vfx/`** — twenty-four renderers and toolkits plus `quads.js` and
`prefixedBlock.js`, which are shared plumbing. They exist so an ability is **configuration plus
beats** rather than a new renderer. An ability may still write a bespoke material when its trick
genuinely needs one — the library is a floor, not a ceiling.

Every signature below was **read back off the source**, not taken from a report. The same text is in `src/vfx/README.md` under **API reference**.

## Conventions — get these wrong and nothing renders

**Attach.** *Parent-first* `new X(parent, opts)` — module adds its own meshes: `GrowthField`, `ShatterField`, `GroundField`, `FilamentPaths`, `ArcNetwork`, `Projectile`, `Swarm`, `Caustics`, `LightShaft`, `BrushStroke`, `InkDiffusion`, `FoldMesh`, `DissolveField`, `GhostRig`, `ColonySwarm`, `WebGraph`, `LatticeGrowth`, `PlateShell`. *Options-only* `new X(opts)` — you add its node: `Tube`(`.group`), `Shell`(`.group`), `VolumeHull`(`.mesh`), `DistortionField`/`Portal`/`LiquidSurface`/`Curtain`/`LensFlare`/`Mirror`(`.object3D`). *Neither*: `HardSurface` (a toolkit), `Dissolve`'s two patch modes (they compose into your material), `SceneHooks` (a singleton ledger), `timeField` (a singleton pool).

**Settings.** *Canonical* (`p.key ?? default`, key list from `xxxParams()`): all except — *Prefixed* (`c[keys.x]`, spread `xxxDefaults(prefix,…)`): `Tube`, `Shell`, `VolumeHull`. `SceneHooks` is neither: it is driven by method calls on a borrowed token, because a hook is held across frames by one owner and a params bag has nowhere to put *who is asking*.

**Clock.** `now` = the ability's `age` in seconds. Exceptions: `ArcNetwork.update(**dt**,…)`; `Swarm`, `Curtain`, `ColonySwarm`, `WebGraph`, `BrushStroke` and `FoldMesh` take `_now` and **ignore it**; `Caustics`, `LightShaft`, `LensFlare` and `Mirror` take **`update(p)`** with no clock at all; `Tube`/`Shell` take time on `state.time`; `VolumeHull.sync(c,g)` reads `frame.uTime` itself.

**Borrowed globals.** Anything from `sceneHooks.acquire()` or `timeField.acquire()` is a piece of the *world*, not of your group. Take it through **`this.borrow(...)`** and `Ability#destroy()` gives it back however the cast ends. `npm run check` fails an ability that leaks one.

```js
/* GrowthField.js ─ variants draw calls (3) ─ parent ─ canonical */
GrowthLayout={LINE:0,ZONE:1}; GrowthEmerge={PUSH:0,SCALE:1}; growthParams()->object
new GrowthField(parent,{geometry,material,shape=null,variants=3,capacity=288,
                        layer=LAYER.WORLD,renderOrder=2,castShadow=true,receiveShadow=true})
  // geometry is a FACTORY (variant,shape)=>BufferGeometry, unit-space: footprint r<=0.5 at y=0,
  // tip y=1. Throws if not a function. material is REQUIRED and yours; dispose() won't touch it.
field.count · drawCalls · meshes · records · material · factory · isFullyTriggered
field.onBreach = (index,position,radius,height)=>{}      // assign ONCE at construction (I3)
field.plant(count, clusterShare=0)->number               // the only dice roll
field.clear() · syncGeometry(shape)->boolean
field.triggerUpTo(now,limit,stagger,frontBias=1,includeCluster=false)
field.triggerRadial(now,limit,stagger,invert=false,includeCluster=true)
field.triggerAll(now,stagger) · triggerIndex(now,index,delay=0)
field.update(now,p,retract=0)
field.positionOf(index,p,out) · tipOf(index,p,out) · heightOf(index,p) · radiusOf(index,p)
field.emergenceOf(index,now,p) · dispose()
patchGrowthMaterial(material,{environment,uniforms,common,vertex,fragment})->material
  // varyings: vGrowLocal, vGrowWorld, vGrowSeed, vGrowBirth · attributes: aSeed, aBirth
  // NOTE: there is NO .object3D — it owns `variants` meshes and adds them to parent itself.

/* ShatterField.js ─ variants draw calls (2) ─ parent ─ canonical */
ShatterLayout (=GrowthLayout); shatterParams()->object
new ShatterField(parent,{geometry,variants=2,capacity=192,material=null,additive=false,
                         depthWrite=true,layer=LAYER.VFX,renderOrder=6,
                         castShadow=false,receiveShadow=false})   // geometry is a FACTORY
s.count · drawCalls · uniforms · material
s.burst(now,count,along=1,lateral=0)->number · clear() · sync(look) · setSceneTexture(tex|null)
s.update(now,p)->live count · positionOf(index,now,p,out) · dispose()

/* GroundField.js ─ 1 draw call ─ parent ─ canonical */
GroundMode={PLATE:0,RUNE:1,POCK:2,RUT:3,WET:4,PUSTULE:5,FUNNEL:6,SCOUR:7,LATTICE:8,POOL:9}
GROUND_MODE_NAMES:string[10]; groundFieldParams()->object
new GroundField(parent,{mode=GroundMode.PLATE,marks=12,additive=false,depthTest=true,
                        layer=LAYER.VFX,renderOrder=null,name=null})   // mode is a #define
f.object3D · drawCalls · mode · marks · markCount
f.setVisible(v) · setAdditive(v) · clearMarks() · update(p) · dispose()
f.mark(x,z,time,strength=1)->Vector4   // x,z are FRACTIONS of the radius, NEVER metres

/* FilamentPaths.js ─ 2 draw calls ─ parent ─ canonical */
PathMode={LINE:0,HELIX:1,ORBIT:2,MEANDER:3,RIM:4,CHAIN:5,LINK:6,SPIRAL_IN:7,CRACK:8}
FilamentPass={CORE:0,GLOW:1}; MAX_FILAMENT_ROLES=4; MAX_CHAIN_NODES=12; filamentLook()->object
new FilamentPaths(parent,{samples=72,capacity=48,renderOrder=11,layer=LAYER.VFX})
p.object3D · drawCalls · liveCount · visible(get/set) · nodeCount
p.role(i)->Role   // i in 0..3
p.setNodeCount(n) · setNode(i,along,lateral,lift) · nodePoint(roleIndex,i,out)
p.sync(look,fade=1,seed=0)   // OVERWRITES uCount — set counts EVERY frame
p.clear() · dispose()
role.count=n · retire() · style(kink,width,dim,groundDamp)
role.ends(fadeStart,fadeEnd,taperStart,taperEnd)
role.draw(progress,tipLength,floorY,tipGlow)          // progress default 2 == "drawn whole"
role.line(from,to,sag,spreadNear,spread,spreadCurve,twist,twistSpeed,converge)
role.helix(from,to,radius,radiusEnd,turns,spin,sag,phaseSpread,taperCurve)
role.orbit(centre,pole,radius,arc,spin,wobble,tilt,tiltSpread,radiusJitter)
role.meander(centre,up,inner,reach,curve,wander,arch,hug,spin)
role.rim(centre,up,radius,span,speed,lift,jitter,hug,phase)
role.chain(from,to,scatter,lift,sag,bow,lit,hold,overlap,tip)
role.link(from,to,slack,curve,swing,swingSpeed,taut,spread)
role.spiralIn(from,to,radius,radiusEnd,turns,spin,curve,phaseSpread,wobble)
role.crack(from,to,angle,lengthFrac,depthFalloff,spread,start,sag,forkBias)

/* ArcNetwork.js ─ 0 extra draw calls when sharing a strip ─ parent ─ canonical */
arcNetworkParams()->object                 // graph + hops + clock; also carries filamentLook()
new ArcNetwork(parent,{paths=null,role=0,samples=96,capacity=24,renderOrder,layer})
  // pass {paths: existing, role: n} → chain+spikes+rim total TWO draw calls, not six
n.from · n.to (Vector3, caller writes each frame) · n.onNode=(index,position,count)=>{}
n.reset(seed) · reseed(seed) · update(dt,p,fade=1)   // dt, NOT now
n.nodePoint(i,out) · clear() · dispose()
n.paths · object3D · drawCalls · nodeCount · segments · progress · arrived · firedCount · cursor

/* Projectile.js ─ 2 draw calls (1 without trail) ─ parent ─ canonical */
FlightMode={LINE,ARC,ROLL,FALL,HOMING,LISSAJOUS,VOLLEY}   // string enum
Stagger={AUTO,NONE,RIPPLE,HASH}; spatialStagger(x,z,cell,seed)->0..1; projectileParams()->object
new Projectile(parent,{geometry,material,shapeKey=null,capacity=48,trail=true,trailNodes=28,
                       trailAdditive=true,layer=LAYER.WORLD,renderOrder=2,castShadow=false})
  // the options object has NO default — `new Projectile(parent)` THROWS
b.count · drawCalls · trailUniforms
b.arrivals:Int32Array · b.arrivalCount     // crossed tau=1 THIS frame — read straight after update()
b.contact:Vector3 · b.contactLoad          // ROLL -> GroundField(RUT)
b.roll(seed=Math.random()*100) · reset() · setBasis(origin,direction,side,length)
b.setTrailColors(a,b,c,d) · syncGeometry() · update(now,params)
b.landPoint(i,out) · pointAt(i,tau,out) · headingAt(i,tau,out) · slotPosition(slot,out) · dispose()

/* Swarm.js ─ 1 draw call ─ parent ─ canonical */
Silhouette={BIRD:0,LEAF:1,CARD:2,DROPLET:3,MOTE:4}; LeadPath={POINT:0,LINE:1,ORBIT:2}
swarmParams()->object
new Swarm(parent,{capacity=256,silhouette=Silhouette.BIRD,additive=true,renderOrder=12})
s.count · drawCalls · uniforms
s.roll(seed=Math.random()*100) · reset() · setBasis(origin,direction,side,length)
s.setColors(a,b,c,d)            // '#rrggbb' or THREE.Color, memoised
s.update(_now,params)           // FIRST ARGUMENT IGNORED
s.leadPoint(out) · dispose()

/* Tube.js ─ 3 draw calls ─ .group ─ PREFIXED */
TubePath={STRAIGHT:0,WHIP:1,FUNNEL:2,VINE:3,ARC:4}; TubeLayer={CORE:0,SHEATH:1,HALO:2}
TUBE_PATH_NAMES:string[5]
tubeDefaults(prefix='tube',path=TubePath.STRAIGHT,overrides={})->79-key fragment
tubeKeys(prefix) · tubeSchema(prefix,path) · createTubeMaterial(layer,path)
new Tube({path=TubePath.STRAIGHT,prefix='tube',nodes=96,sides=26,renderOrder=11})
t.group · materials{core,sheath,halo} · meshes · keys · geometry · drawCalls · visible(get/set)
t.sync(c, state, g=settings.global)
  // state={origin,target,side,progress,fade,widthFade,seed,time,grow,snapAge}
t.radiusAt(tau)->metres    // THE profile fn — dust skirts/scour use this, never their own maths
t.pointAt(t,out) · tangentAt(t,out) · span · skirtRadius · mouthRadius
t.tipPoint:Vector3 · tipSpeed:m/s · waveSpeed:m/s
t.crack={fired,point,speed,at}    // recomputed by sync(); poll IMMEDIATELY after
t.dispose()

/* Shell.js ─ 1 draw call ─ .group ─ PREFIXED */
ShellMode={DOME:0,CONE:1,RING_TRAIN:2,SUNDISC:3,PRESSURE:4}; SHELL_MODE_NAMES:string[5]
shellDefaults(prefix='shell',mode=ShellMode.DOME,overrides={})->44-key fragment
shellKeys(prefix) · shellSchema(prefix,mode) · createShellMaterial(mode)
export { BurstMode, BurstSystem } from '../effects/BurstSphere.js'   // re-exports
new Shell({mode=ShellMode.DOME,prefix='shell',nodes=48,sides=48,rings=24,segments=96,
           renderOrder=14})
s.group · mesh · material · keys · geometry · drawCalls · visible(get/set) · instanceCount
s.sync(c, state, g=settings.global)          // state={origin,axis,side,span,t,fade,seed}
s.radius · span · nodeSpacing · nodeCount
s.standingAt(u) · nodePosition(i,out) · resonantSpacing(n) · dispose()

/* VolumeHull.js ─ 1 draw call ─ .mesh ─ PREFIXED */
HullShape={BOX:0,CYLINDER:1,CONE:2,DOME:3,SPHERE:4}
Medium={FLAME:0,SMOKE:1,ASH:2,SPORE:3,SAND:4,MIST:5,GAS_BOIL:6,VOID:7}
HULL_NAMES · MEDIUM_NAMES · VOLUME_HULL_KEYS · VOLUME_SAMPLE_BUDGET=20e6
volumeHullDefaults(prefix,medium=Medium.SMOKE,overrides={}) · volumeHullSchema(prefix,{label,only})
disposeVolumeHullGeometry()                  // app teardown; unit hulls are shared
new VolumeHull({hull,medium,prefix='volume',maxSteps=48,shadow,additive=false,
                renderOrder=12,seed})
h.mesh · material · steps · shadowTaps · hull · medium · prefix
h.place(position,direction=null)->this       // yaw only; hull local +Z is the heading
h.setSize(x,y=x,z=x)->this                   // HALF-EXTENTS in metres, EVERY frame
h.setFade(k)->this                           // 0 hides the mesh
h.sync(c,g)->this · cost(coveredPixels) · dispose()
  // scale with setSize(), NEVER mesh.scale, or the march's t stops meaning metres
  // reads settings.global.volumeQuality (defaults to 1 if absent)

/* Distortion.js ─ 1 draw call per emitter ─ .object3D ─ canonical */
DistortionMode={HEAT:0,LENS:1,SHOCK:2,BLADE:3,REFRACT:4}
DistortionFacing={BILLBOARD,UPRIGHT,GROUND,WORLD}
new DistortionField({mode=DistortionMode.HEAT,facing,geometry=null,edge=false,
                     renderOrder=0,name})
d.object3D · visible(get/set)                // retains/releases the writer counter
d.setAnchor(v3) · setAnchorXYZ(x,y,z) · setBasis(along,up) · update(p) · dispose()
  // magnitudes are SCREEN FRACTIONS, not metres. NEVER multiply global.distortion or
  // post.distortion into strength — the pass applies both, once.
  // Toggle field.visible; hiding the parent group leaks the writer for the session.

/* Portal.js ─ 1 draw call ─ .object3D ─ canonical */
new Portal({billboard=false,writeDepth=false,renderOrder=6,name='Portal'})
p.object3D · visible(get/set) · setPlacement(anchor,along,up) · update(p) · dispose()

/* LiquidSurface.js ─ 1 draw call ─ .object3D ─ canonical */
LiquidMode={POOL:0,WAVE:1}; liquidParams()->object
new LiquidSurface({segments=96,mode=LiquidMode.POOL,depthWrite=true,doubleSide=true,
                   renderOrder=3,name='LiquidSurface'})
s.object3D · uniforms · drawCalls · visible(get/set) · mode(get/set)
s.setPlacement(anchor,along,up)
s.ripple(u,v,strength=1,now?)->slot            // u,v are FRACTIONS in -1..1
s.rippleAtWorld(position,strength=1,now?)->slot // call AFTER update() on that frame
s.clearRipples() · reset() · update(now,p)
s.lipPosition(p,out,across=0) · lipHeight(p,across=0) · dispose()
  // 8 ripple slots, oldest evicted. Fill-heavy: one per screen.

/* Curtain.js ─ 1 draw call (2 with floor) ─ .object3D ─ canonical */
CurtainMode={RAIN:0,AURORA:1,SHAFT:2}; CurtainLayout={LINE:0,RING:1,SCATTER:2}
curtainParams()->object
new Curtain({capacity=16,segmentsX=32,segmentsY=16,mode=CurtainMode.AURORA,
             layout=CurtainLayout.LINE,floor=false,renderOrder=8,name='Curtain'})
c.object3D(Group) · uniforms · drawCalls · instanceCount
c.visible(get/set) · mode(get/set) · layout(get/set)
c.setPlacement(anchor,along,up) · roll(seed=Math.random()*100) · reset()
c.update(_now,p)                               // FIRST ARGUMENT IGNORED
c.sheetPoint(index,p,out,across=0,height=0) · dispose()
  // alphaCurve must differ from emissionCurve (2.4 vs 0.7) or it is a hanging ribbon
  // stormwall passes the cast's SIDE vector as `along`; shafts pass -frame.uLightDir as `up`

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

/* LensFlare.js ─ 1 draw call ─ .object3D ─ canonical */
import { LensFlare, FlareRole, MAX_FLARE_GHOSTS, lensFlareParams } from '../../vfx/LensFlare.js';

FlareRole = { CORE:0, STREAK:1, RING:2, GHOST:3 }        MAX_FLARE_GHOSTS = 8
lensFlareParams() -> object                              // 48 sliders, 9 pickers

new LensFlare({ ghosts = 8, renderOrder = 3000, layer = LAYER.VFX, name })
  // `ghosts` is the CAPACITY; params.ghosts is how many draw this frame.

f.object3D -> Mesh    f.drawCalls // 1    f.capacity    f.visible (get/set)
f.setAnchor(v3)   f.setAnchorXYZ(x, y, z)   f.anchor(out?) -> v3
f.update(p)       f.dispose()

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

/* quads.js ─ no renderer ─ the two unit quads every quad-backed module draws on */
acquireGroundQuad()->PlaneGeometry   // 1x1 in XZ, normal +Y. Refcounted; releaseGroundQuad() in dispose()
releaseGroundQuad() · groundQuadRefs()
uprightQuad()->PlaneGeometry         // 1x1 in XY, normal +Z. NOT refcounted, never disposed
disposeQuads()                       // teardown only
  // neither carries a metre — scale the mesh, never the buffer

/* prefixedBlock.js ─ NEW, no renderer ─ only needed for a new two-instance module */
num(value,fallback) · str(value,fallback) · prefixed(prefix,name)
buildKeys(fieldNames,prefix) · buildDefaults(fieldNames,fields,tuning,prefix,overrides={})
auditBlock(label,keys,fieldNames,block,remedy)->string[]
```

## What the ability agents must know

1. **`npm run check` is the only gate that compiles `src/vfx/`.** A green `npm run build` says nothing about these modules — until an ability imports one, it is not in the bundle graph and a syntax error in it builds perfectly.
2. **Add a case to `VFX_CASES` in `scripts/check.mjs` if you add a class to `src/vfx/`** — the coverage rule fails the check otherwise.
3. **No backticks in GLSL comments.** This has now bitten four agents.
4. **Reserved words are the GLSL ES 3.00 list, not the 1.00 one.** three prepends `#version 300 es` to every non-`RawShaderMaterial`, so: `packed` is **fine** (illegal in 1.00, legal in 3.00) and `patch` is **fatal** (the reverse) — a `float patch` took the whole ground material out of the frame this pass. The ones you will actually reach for: `patch`, `sample`, `filter`, `input`, `output`, `flat`, `smooth`, `layout`, `common`, `active`, `this`, `interface`. Shadowing a built-in *function* with a local is fine (`float round = …`); defining a function with a built-in's name is not. **`npm run check` now sweeps every `/* glsl */` block for this.** Uniform arrays are still indexable only by a loop counter.
5. **`commonGLSL` does not compile in a vertex shader** — it carries `aastep`, which calls `fwidth`. Inject **`commonVertexGLSL`** from `shaders/lib/common.glsl.js` instead: the same chunk minus `aastep` and `softFade`, separate include guard, safe to spread alongside `commonGLSL` in the other stage.
6. **Patched `MeshStandardMaterial`s must park uniforms on `material.userData.uniforms`** (I8) or the pause test reports your working sliders as dead.
7. **Give borrowed globals back.** `sceneHooks.acquire()` and `timeField.acquire()` take a piece of the world. Wrap them in `this.borrow(...)` and the base class returns them on every path a cast can end by — including the player pressing **C**, a fifth cast pushing yours off the concurrency cap, and teardown. `timeField.acquire()` **returns `null`** when all four slots are taken, on exactly the `ctx.lights.acquire()` contract: guard it, and read acceptably with none.
8. Budget guide (I7 ≤ 12): beam `Tube` = 3 · tornado `Tube(FUNNEL)+GroundField(SCOUR)+Swarm` = 5 · chained bolt `FilamentPaths+ArcNetwork` sharing a strip = **2** · flooded lane `LiquidSurface+Caustics` bound to it `+GroundField(WET)` = 3 · hive dome `PlateShell+ColonySwarm+WebGraph` = 4. Three costs are not draw calls: a **`Mirror`** is one extra nested `renderer.render()` of `LAYER.WORLD` (capped at two a frame by `mirrorBudget`), a **`Caustics(SCROLL)`** is fill-bound at ~100 hashes a pixel, and a **`GhostRig`** is ~70 `Object3D`s of skeleton per ghost.
9. **Two shared quads, not five.** `vfx/quads.js` owns them. A new flat effect calls `acquireGroundQuad()`/`releaseGroundQuad()`; a new upright one calls `uprightQuad()`.
10. Still open, and not owned by anyone: `settings.global.volumeQuality` is read by `VolumeHull` but has no slider; `frame.uSceneColor` does not exist yet (adding it gives every `ShatterField` refraction for free — but must not point at the composer's write target, which is a feedback loop); bloom still bleeds across a `Hook.HOLE` rim; and the three modules that read `frame.uTime` in-shader (`Swarm`, `Curtain`, `VolumeHull`) are not reachable by a time region until one of them injects `timeWarpGLSL`.
