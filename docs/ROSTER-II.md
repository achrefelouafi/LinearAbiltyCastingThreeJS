# The Roster, part II — 50 more abilities, six new schools

The sandbox has fifty. This document specifies fifty more, taking it to **one hundred abilities
across fifteen schools**.

The rules from `docs/ROSTER.md` still hold, unchanged — no dimensions on the CPU, nothing is a
texture, one trick per ability, every value a slider. What changes is the *territory*. The first
ninety-odd tricks were built out of geometry, noise and parametric paths. These six new schools
were chosen because each one forces a rendering technique the sandbox has never had to do.

| school | the territory it forces open |
| --- | --- |
| **Tide** | **Caustics.** A scene with a floor and no caustics is leaving the best free effect in graphics on the table. Water here lights the ground *through* itself. |
| **Forge** | **Hard surface.** Everything in the sandbox so far is crystal, rock or organic. Nothing is *machined* — no involute gear teeth, no brushed anisotropic specular, no blackbody cooling curve. |
| **Lumen** | **Light that behaves like light.** Volumetric shafts with lit dust inside them, occlusion-tested anamorphic flares, and — the big one — abilities that *move the scene's key light*, so every object in the world swings a real shadow. |
| **Ink** | **The anti-glow school.** Flat, matte, high-contrast black and vermilion, no bloom anywhere. Brush dynamics, wet diffusion with a real fingering instability, and paper that folds. In a sandbox this addicted to emission, restraint is the novelty. |
| **Chrono** | **Time as a driver.** Recording and replaying the caster, clamping other systems' clocks inside a radius, and running the same shaders with a negative time step. |
| **Hive** | **Emergence.** Swarms that resolve into silhouettes because their agents target positions sampled from a signed distance field, and structures that grow on a real lattice. |

Fourteen more abilities extend the nine existing schools, chosen only where they bring a technique
the school does not already have.

---

# X · TIDE
*Deep teal through aqua. Wet, heavy, and lit from below.*

## `tiderush` · Tiderush
    tide · LINE · LiquidSurface(WAVE) + Caustics
    THE TRICK — caustics. Light refracted through the wave's body plays on the floor *ahead of the
    wave*, so you read the water's thickness from the pattern on the ground rather than from the
    surface. The caustic net has to be driven by the same heightfield that draws the wave, or it is
    a decal and everyone can tell.

## `undertow` · Undertow
    tide · ZONE · LiquidSurface + Caustics + Swarm(debris)
    THE TRICK — one flow field, three consumers. A real logarithmic spiral drives the surface, the
    caustics and the debris together; drag the swirl and all three answer. Debris orbits inward and
    is pulled under, not deleted — it goes *below* the surface and is seen through it.

## `brinelock` · Brinelock
    tide · LINE · LiquidSurface → GrowthField(splash)
    THE TRICK — the state change. A splash crown is thrown up as real water and then *stops*,
    mid-air, as glass-clear ice in exactly the silhouette the water had. The handover has to
    preserve the shape frame-for-frame; if the ice is a different splash the whole idea collapses.

## `geyser` · Geyser
    tide · ZONE · Tube(FUNNEL, inverted) + Projectile(FALL)
    THE TRICK — the column becomes the rain. The water that went up is the water that comes down:
    droplets are seeded from the column's own surface at the moment it loses pressure, inherit its
    velocity, and each one lands with its own small splash and ripple into the pool below.

## `bubblecage` · Abyssal Cage
    tide · ZONE · Shell + thin-film interference
    THE TRICK — thin-film interference. Soap-film colour is a real optical effect: the hue comes
    from the film's *thickness* against the view angle, not from a gradient. Implement the actual
    interference term. Nothing else in the sandbox derives colour from physics, and it looks
    unmistakably different from everything that fakes iridescence with a fresnel ramp.

## `torrent` · Torrent
    tide · LINE · Tube + deflection spray
    THE TRICK — deflection. The jet hits the floor and the spray fans out *along the surface*, in
    the plane of the impact, at the reflected angle — not as a radial puff. A cutting jet reads as
    pressure only if the spray knows which way the surface is facing.

---

# XI · FORGE
*Steel, scale and heat. Orange on grey.*

## `anvilfall` · Anvilfall
    forge · ZONE · HardSurface + Shell
    THE TRICK — mass. A machined anvil — bevels, fillets, a flat working face, brushed anisotropic
    specular — falls, and everything about the impact is about weight: the floor dishes under it,
    the shock is low and slow rather than bright and fast, and it *stays there* after.

## `sawline` · Sawline
    forge · LINE · HardSurface(blade) + Projectile
    THE TRICK — grinding sparks. Sparks leave at the blade's contact tangent, in the direction the
    tooth was travelling, at a speed derived from the rim velocity. A saw that throws sparks
    radially is a firework; the tangent is the whole read.

## `pistondrive` · Piston Drive
    forge · LINE · HardSurface(piston) + GroundField
    THE TRICK — a cam curve. Pistons do not ease. They dwell, snap, and dwell again: the motion
    profile is a real cam, exposed as an editable curve, and the sequence down the line is a phase
    offset on it. Smooth easing here would make them read as rising rock.

## `gearlock` · Gearlock
    forge · ZONE · HardSurface(involute gear)
    THE TRICK — the teeth actually mesh. Involute tooth profiles, and each gear's angular rate is
    derived from its tooth count against its neighbour's, so the train genuinely interlocks and
    stays interlocked when you drag the ratios. Teeth that pass through each other is the failure
    everybody ships.

## `quench` · Quench
    forge · ZONE · HardSurface + VolumeHull(steam) + blackbody ramp
    THE TRICK — the cooling curve is physical. White → yellow → orange → cherry → black along a real
    blackbody locus rather than an authored gradient, so the metal cools the way metal cools. The
    steam is the loud part; the colour ramp is why it is convincing.

## `shrapnel` · Shrapnel Bloom
    forge · ZONE · ShatterField + ricochet
    THE TRICK — ricochet. Machined fragments hit the floor and *bounce*, reflecting about the
    surface normal with a restitution slider and a tumble that survives the bounce. Fragments that
    stop dead on contact is the tell that separates a shatter from a burst.

---

# XII · LUMEN
*Warm white and gold. The school where light is the object.*

## `godspear` · Godspear
    lumen · LINE · LightShaft + Caustics
    THE TRICK — real in-scattering. A volumetric shaft with dust genuinely lit inside it, sweeping
    down the line, throwing a moving bright band on the floor where it lands. The dust in the shaft
    must be the scene's own dust motes, brightened as they pass through it — not a second system.

## `solarlens` · Solar Lens
    lumen · ZONE · LensFlare + Caustics(focus)
    THE TRICK — an occlusion-tested flare. A floating lens focuses light to a burning point that
    walks across the floor; the anamorphic flare anchored to it is depth-tested against the scene,
    so it dims when the character passes in front of it. A flare that ignores occlusion is a
    sticker on the lens.

## `refractcascade` · Refraction Cascade
    lumen · LINE · Mirror + Tube
    THE TRICK — the mirrors reflect the actual scene. A beam bounces between floating mirrors down
    the line, and each mirror shows a real reflection of what is behind the camera. Fake it with an
    environment map and it reads as chrome; do it properly and the mirrors read as glass.

## `dawnbreak` · Dawnbreak
    lumen · ZONE · SceneHooks(key light)
    THE TRICK — the ability moves the sun. It takes hold of the scene's directional light and
    swings it from the horizon to overhead and back, so *every object in the world* — the character,
    the crystals of a Frost Lance still standing, the floor's own relief — throws a real shadow that
    sweeps across the ground. No other ability changes the world; this one does, and it must put it
    back exactly.

## `eclipse` · Eclipse
    lumen · ZONE · Shell + SceneHooks(grade)
    THE TRICK — the light goes wrong before the disc appears. Colour drains toward the umbra, the
    key light cools and dims, and only then does a black disc with a corona of filaments open. It is
    the Thunderclap lesson applied to light: the anticipation carries it.

## `photonlattice` · Photon Lattice
    lumen · ZONE · Tube(instanced grid)
    THE TRICK — the nodes are bright because they overlap. A three-dimensional grid of thin beams
    with additive blending; the intersections are brighter for the only honest reason, which is that
    two beams are being added there. Nothing is drawn at the nodes at all.

---

# XIII · INK
*Black, bone-white and vermilion. Matte. No bloom anywhere in this school.*

## `sumistroke` · Sumi Stroke
    ink · LINE · BrushStroke
    THE TRICK — dry brush. One enormous brushstroke down the line, with real brush dynamics: it
    loads heavy, thins under pressure, and *runs out* — breaking into separated fibre streaks at the
    end of the stroke. The ragged tail is the whole ability, and it must come from a bristle model,
    not from a noise mask over an even stroke.

## `inkbloom` · Ink Bloom
    ink · ZONE · InkDiffusion
    THE TRICK — a fingering instability. Ink spreading in water does not grow as a disc; it grows
    as branching fingers, because the interface is unstable. Implement the instability (a
    Saffman–Taylor-ish threshold on a diffusing field) and the pattern generates itself, differently
    every cast, from one seed.

## `origami` · Paper Storm
    ink · LINE · FoldMesh + Swarm
    THE TRICK — real folding. Cranes fly downrange and *unfold* into flat sheets: a creased mesh
    whose fold angles are driven from one parameter, so the whole flock opens on one slider. Paper
    must never stretch — the creases have to be isometric or it reads as rubber.

## `sealscript` · Seal Script
    ink · ZONE · BrushStroke(vertical)
    THE TRICK — legible brush weight in three dimensions. A column of characters written
    top-to-bottom in the air, each stroke with a real entry, body and exit, and each one drawn in
    sequence. It has to still read as writing when you orbit it, which means the strokes need
    thickness in the view direction — a flat billboard disappears edge-on and the column vanishes.

## `splatterbrand` · Splatterbrand
    ink · LINE · InkDiffusion + Projectile
    THE TRICK — splatter morphology. A flung blob does not make a circle. It makes a directional
    main mass, a crown of spikes on the leading edge, and satellite droplets thrown further along
    the travel vector, sized by a power law. Get the satellites right and it is unmistakable.

## `scrollward` · Scrollward
    ink · ZONE · FoldMesh(unroll)
    THE TRICK — cylindrical unrolling. Scrolls unroll into a standing wall of text; the paper's
    curvature is real, tightest at the roll and flattening as it pays out, and the text on it is
    correctly foreshortened by that curve as it comes off the spool.

---

# XIV · CHRONO
*Pale amber and bone. Quiet, and slightly wrong.*

## `echostep` · Echo Step
    chrono · LINE · Recorder
    THE TRICK — the caster's own recorded motion. Three ghosts of the character run the line,
    replaying a transform track captured from the real caster, each delayed further and each fainter.
    They are the character, not a proxy; that is what makes it unsettling.

## `stasisfield` · Stasis Field
    chrono · ZONE · TimeControl(clamp)
    THE TRICK — it stops *other* effects. Particles inside the radius hold mid-air, another
    ability's standing crystals stop growing, a bolt in flight stops guttering. Implemented by
    clamping age inside a region rather than by drawing anything, which means the ability is almost
    entirely invisible and reads entirely through what it does to everything else.

## `rewind` · Rewind
    chrono · LINE · TimeControl(reverse)
    THE TRICK — a negative time step through the same shaders. Debris flies back up, cracks close,
    dust gathers. Nothing bespoke is drawn: the ability runs the ordinary vocabulary backwards, and
    the reason it works is that every effect in this project is a closed-form function of time.

## `hourglass` · Hourglass
    chrono · ZONE · VolumeHull(SAND) + SceneHooks(gravity)
    THE TRICK — the inversion. Sand falls into a cone, the zone flips, and it falls *up* — the same
    field, the same grains, one sign changed. The flip has to happen on a beat you can see coming.

## `afterimage` · Afterimage
    chrono · LINE · Recorder(snapshots)
    THE TRICK — N frozen copies, all still live. The cast leaves snapshots of itself at intervals,
    each held at the age it was taken, and each one still re-resolves from the sliders — so pausing
    and dragging reshapes all six frozen moments at once. It is invariant I1 turned into an effect.

## `entropy` · Entropy Wave
    chrono · ZONE · SceneHooks(material aging)
    THE TRICK — one parameter ages a material. Rust, dust, moss, pitting and bleaching all driven
    from a single 0..1 that sweeps outward across the floor and then retreats. The floor is a real
    PBR material, so this is a patch into its shader rather than a decal over it.

---

# XV · HIVE
*Chitin amber and a sick green. Many small things behaving as one.*

## `locusttide` · Locust Tide
    hive · LINE · Colony(SDF-targeted swarm)
    THE TRICK — the swarm forms shapes. Agents target positions sampled from a signed distance
    field, so the cloud condenses into a fist, a wall and a spear as it travels, then disperses.
    The silhouette is emergent — nothing is drawn but insects.

## `webline` · Web Line
    hive · LINE · Colony(graph + membrane)
    THE TRICK — the membrane. A web is not just strands: it is strands plus the thin film between
    them, which catches light at grazing angles and is invisible head-on. Strands sag under their
    own tension against real anchor points, and the film is built from the graph's faces.

## `hivecolumn` · Hive Column
    hive · ZONE · Colony(hex lattice growth)
    THE TRICK — growth on a real lattice. Hexagonal cells build outward from a seed, each one
    snapping to the lattice its neighbours defined, so the structure is legibly *constructed* rather
    than grown. Cells that would overlap are refused, which is what gives it its irregular edge.

## `waspfunnel` · Wasp Funnel
    hive · ZONE · Colony + Tube(FUNNEL)
    THE TRICK — density waves. The funnel pulses — bands of higher agent density travel up it, the
    way a real swarm surges. The wingbeat is per-agent and out of phase, so the mass shimmers
    without anything being animated globally.

## `carapace` · Carapace
    hive · ZONE · Colony(shell tessellation)
    THE TRICK — plates that interlock. A Voronoi tessellation on a hemisphere, each cell a chitin
    plate that flies in and locks against its neighbours' edges. Because the cells come from one
    tessellation, the seams are exact — the dome closes with no gaps and no overlaps.

## `broodburst` · Broodburst
    hive · ZONE · GrowthField + Colony
    THE TRICK — swell, then burst, per egg. Each egg has its own timer: it inflates, goes
    translucent as it stretches, and splits along a seam. The crawlers that come out follow the
    floor rather than flying, which separates this from every other swarm in the sandbox.

---

# Extensions to the nine existing schools

## `avalanche` · Avalanche — *frost*, LINE
    THE TRICK — granular flow. Snow piles, slumps and finds its angle of repose. The front is not a
    wave; it is a heap that keeps collapsing forward over itself.

## `blackice` · Black Ice — *frost*, ZONE
    THE TRICK — a planar reflection. A mirror-smooth sheet that reflects the real scene, sharpening
    as it freezes. The only true reflective surface in the sandbox.

## `firewalk` · Firewalk — *flame*, LINE
    THE TRICK — footprints. Actual footprint shapes ignite in sequence down the line, each throwing
    a short pillar. A recognisable silhouette in a school made entirely of formless heat.

## `wildfire` · Wildfire — *flame*, ZONE
    THE TRICK — propagation as a cellular automaton. Fire spreads cell to cell across the floor,
    jumps gaps, leaves unburnt islands and burns back on itself. Not a growing circle: a *front*.

## `sheetlightning` · Sheet Lightning — *storm*, ZONE
    THE TRICK — the shadows strobe. The flash is applied to the scene's key light, so every real
    shadow in the world snaps with it. Cheap to do, and the first time it fires it is startling.

## `obsidian` · Obsidian Bloom — *stone*, ZONE
    THE TRICK — conchoidal fracture. Volcanic glass breaks in smooth curved shells, not flat facets.
    Generate the geometry that way and it reads as glass at a glance, before the specular even
    lands.

## `mycelium` · Mycelial Web — *verdant*, LINE
    THE TRICK — it is under the floor. A fungal network spreads *beneath* the surface and is visible
    only as a glow coming up through the stone's own cracks and pores.

## `unmake` · Unmake — *void*, LINE
    THE TRICK — voxel dissolve. Matter comes apart into cubes that drift and wink out, the cube size
    growing as the dissolve progresses so the loss accelerates visibly.

## `silence` · Silence — *void*, ZONE
    THE TRICK — a hole in the frame. Inside the zone, nothing renders at all — not black, *absent*.
    The most aggressive thing in the sandbox, and it is achieved by drawing less than anything else.

## `spellbreak` · Spellbreak — *arcane*, ZONE
    THE TRICK — it reacts to other casts. The one ability aware of the rest: arcane glass shatters
    and any other effect currently standing inside the zone is visibly disrupted — desaturated,
    fragmented, and pushed. Cast it into an empty room and it is pretty; cast it into a Nova Beam
    and it is an interaction.

## `astralgate` · Astral Gate — *arcane*, ZONE
    THE TRICK — geometry emerging *through* a plane. A ring gate that objects pour out of, correctly
    clipped by the portal plane so nothing is ever seen on the wrong side of it. The clip is the
    ability; without it, things pop into existence in front of a decal.

## `bonecage` · Bone Cage — *blood*, ZONE
    THE TRICK — a different material entirely. Ribs of dry bone close over the zone: warm
    subsurface scatter, chalky micro-roughness, no wetness and no glow. Standing next to Crimson
    Tide's viscous red, the contrast is the point.

## `featherfall` · Featherfall — *aether*, ZONE
    THE TRICK — flutter dynamics. Feathers do not fall; they stall, slip sideways, catch, and glide.
    A real tumbling model with lift, so no two descend the same way.

## `mirage` · Mirage — *aether*, LINE
    THE TRICK — a silhouette made only of refraction. A duplicate of the caster runs the line, drawn
    with nothing but distortion — you see it because the world bends into a human shape, and the
    moment it stops moving you lose it.

---

## Totals

| | schools | abilities |
| --- | --- | --- |
| shipped | 1 (mixed) | 6 |
| roster I | 9 | 44 |
| roster II — new schools | +6 | 36 |
| roster II — extensions | — | 14 |
| **total** | **15** | **100** |
