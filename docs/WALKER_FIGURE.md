# Walker figure: the body and how it moves

How the walker is drawn and animated, what each part is taken from, which
numbers are published and which are estimates, and what it costs. The code is
`src/render/webgpu/person/`; the renderer gets it from `createPersonVisual`
(`index.ts`). The sim (`src/sim/person/walker.ts`) decides where the walker
is and in which mode; the figure only draws it there.

Frames: the root's +X forward, +Y up, +Z right, origin at the feet point on
the ground between the heels (seated: the driver's hip point). The sim's
`PersonVisualState` and the root's movement are the only inputs.

## The body

- **Skeleton** (`skeleton.ts`): the walking plan's 27 bones, each after its
  parent: root, pelvis, three spine bones, neck, head, and per side the
  clavicle, upper arm, forearm, hand, thumb, fingers, thigh, shin, foot and
  toe.
- **Proportions** (`figureProportions.ts`): an adult man of
  `PERSON.stature` 1.76 m. Joint heights and segment lengths are Drillis and
  Contini's ratios of the stature (Winter 2009, fig. 4.1): eye 0.936 H, hip
  0.530, knee 0.285, ankle 0.039, PUBLISHED. The motion stack reads these;
  the mesh is fitted to the same joints.
- **Mesh** (`walkerBody.ts`, baked by `scripts/bake-walker-body.mts`): a
  real person's anatomy from MakeHuman's base mesh, not a likeness of anyone.
  MakeHuman's young-male macro targets for African, Asian and European
  ancestry are averaged a third each, so the face belongs to no group and no
  one; the result is scaled and fitted joint by joint onto the skeleton above
  and skinned with MakeHuman's own weights, its 160-odd bones folded onto our
  27. Its high-poly eyes go in the sockets. Over the body the bake builds the
  clothes as shells lifted off it (the skin they cover removed): an
  olive-grey soft-shell jacket with a stand-up collar, zip, hem and cuff
  bands; stone trousers; brown leather boots with laces; a short dark cut of
  hair rising off the scalp only where it is thick, its thin edge painted on
  the skin.
- **Sources**: MakeHuman's files are fetched at bake time from its GitHub
  repository at a pinned commit (`MAKEHUMAN_COMMIT` in
  `scripts/walkerBody/sources.mts`) into `node_modules/.cache/walker-body/`.
  Every asset bundled with MakeHuman is CC0 1.0 (its `LICENSE.md`, section
  C); the bake checks that text before using anything. Only the baked files
  are in the repository.
- **Levels of detail**: MEASURED 33,112 triangles, then 10,000, 3,000 and
  996, simplified with meshoptimizer keeping UV seams, normals and UVs
  (errors 0.14%, 0.62% and 3.1% of the figure's size). The figure switches
  at 10, 25 and 80 m (`FIGURE_LOD_DISTANCES`, with 1.5 m either side). Low
  tier starts at the second (`personFigureFinestLod`).
- **Maps**: one atlas in MakeHuman's UV layout, painted by the bake from
  measured surface points: albedo (skin tone and mottle, redder cheeks, nose
  and ears, stubble, lips, brows, lashes, irises; the jacket's fabric, seams
  and folds; the trousers' twill; leather with toe wear), a normal map from
  the same painters' heights (pores, creases, weave, grain, laces), and
  occlusion, roughness and metalness. The occlusion is ray-traced against the
  whole figure (32 rays a texel at half size) and also darkens the albedo a
  little. Each is baked at 2,048 texels and halved for 1,024 and 512; the
  tier picks one (`personFigureTextureSize`: Low 512, Medium and High 1,024,
  Ultra 2,048; High's memory budget has no room for the 2,048 maps' 64 MiB,
  docs/PERFORMANCE.md "The realistic walker"). The figure builds the mip chains itself, in linear light,
  renormalising the normals and widening the roughness where they spread
  (Toksvig).
- **Files** (`src/render/webgpu/person/assets/`, 2.8 MB): `walker-body.bin`
  (742 KB: the shared vertices quantised to 16 bits, four bone indices and
  weights in bytes, 16-bit triangles per level) and three JPEGs per size
  (albedo q90, normal q94 and occlusion-roughness-metal q92, 4:4:4 for the
  last two). The renderer loads only the tier's size, alongside the scene,
  and only when a car is in the scene (the walker comes with it). GPU memory
  with mips: 64 MiB at 2,048, 16 at 1,024, 4 at 512.
- **Frames and winding**: the bake's +X forward, +Y up, +Z right, feet at
  y = 0; faces wind into the solid as the repo's other meshes do.
- **Skinning** (`createFigure.ts`): every bone parentless and bound at its
  bind position, so a bone's matrix is its posed transform in the root frame.
  The matrices are computed once a frame in `update`, so the shadow passes
  read this frame's pose, and ride in each draw's uniforms: Babylon's default
  bone texture made a buffer and a submit of its own every frame.

## Draws, LODs and shadows

One mesh per LOD draws, plus its shadow in the nearest
`personShadowCascades` cascades. Babylon draws a caster into every cascade,
so where the tier asks for fewer the figure drops itself from the farther
ones' lists (`FigureShadows`). MEASURED (`tests/gpu/person-figure.test.ts`):
2 draws on Low, 3 on Medium, High and Ultra. The material compiles at 14 of
16 fragment inputs, with the cascades, cloud shadows and aerial haze, so a
clustered light container still fits.

The sun casts from back faces with a 0.035 m normal bias, which moves a back
face up to that far toward the light. The nose, lips, brow and eyelids are
thinner than that, so their far sides came out in front of the lit cheek and
striped the face with shadow. The figure casts with a bias of its own,
`FIGURE_SHADOW_NORMAL_BIAS` (5 mm), set again on each of its shadow draws;
the GPU test checks its draws use it while everything else keeps the sun's.

A camera pushed into the walker's space fades it (`setFade`): the solid mesh
keeps casting, hidden from the cameras, while a twin sharing its geometry
draws blended over a depth pre-pass. In first person (`setFirstPersonView`)
the head bone shrinks into the neck. That is in the bone matrices, so the
shadow loses its head too.

Pipelines: both materials go through the renderer's off-frame compiles and
are warmed at load by two primes (one degenerate triangle each) once their
effects are ready. The GPU test checks the first walk, fade, first person and
every LOD switch build no pipeline in their frame. Waiting for the effects
matters: a prime drawn only in the shadow map, its main effect still
compiling, ended its warm-up with only the shadow pipeline.

## The motion

`PersonMotion` (`motion.ts`) turns the state into a pose each frame. The
modes fall into families that share a body, and moving between families
cross-fades from the last drawn pose:

- **Ground** (stand, walk, run, wade): one gait whose speed, run share and
  depth vary continuously. Walking curves are Schwartz, Rozumalski and Trost
  (2008)'s normative joint angles at every 2% of the stride, five speed
  groups matched by dimensionless speed (Hof 1996), as Fourier series within
  0.6 degree. Running is Novacheck (1998)'s sagittal keys (jog 2.5 m/s, run
  4.5 m/s). Both PUBLISHED; the curves between the running keys and their
  frontal and transverse channels are ESTIMATES. Walk and run switch at the
  sim's 2.0 m/s: double support walking, a flight phase running.
- **Planted feet** (`footPlant.ts`): a stance foot holds its world point and
  the ground's height and slope; the pelvis drops so the leg reaches, and the
  heel lifts when it cannot. Slip is under 1 cm on flat ground and on 10 and
  20 degree slopes at the sim's Tobler speeds. The figure's ground is the
  drawn terrain; where the sim's feet stand more than 12 cm off it (a pontoon,
  a ledge, the colliders it does not draw) the motion stands on a flat plane
  at the root instead.
- **Air, landings, roll**: a jump's tuck and reach, a crouch after landings
  at 5 m/s or more (`PERSON.landingHardSeconds`) deepening with speed, and a
  roll at 8 m/s or more (`landingRollSeconds`). ESTIMATES.
- **Swim and dive**: breaststroke, and the crawl when the run is asked for,
  the eye held where the sim puts it (5 cm above the water at the surface);
  the dive pitched by the sim's `swimPitch`. ESTIMATES. At the sim's -0.05 m
  float depth both strokes are swum head-up, as a recreational breaststroke
  and a water-polo crawl are: the trunk inclined (24 and 13 degrees), the
  neck extended, the shoulders just under the surface and the hips 0.3 and
  0.17 m down. The breaststroke's hands stay under the water all through;
  only the crawl's recovering arm comes out. There is no breathing turn.
- **Mantle**: out of the water onto a ledge, and the land climb (a jump at a
  ledge up to `PERSON.climbHeight`, the sim's `swimPitch` at pi/2): hands on
  the top, pressed up, the left knee over and its foot planted, then the right,
  standing. The climb's height is read from the root's rise, and the hands
  are placed on the top by IK. ESTIMATES fitted to the sim's path (up over
  the first 60%, over in the last 70%).
- **Car** (`carSeat.ts`): walking to the door, stepping up, sitting and
  swinging the legs in, the reverse, and seated with the hands on the rim
  (each re-gripping a third of a turn back as the wheel turns) and the feet
  on the pedals. ESTIMATES.
- **Look**: the head and neck turn toward the camera's aim (up to 70
  degrees either way, 40 up, 45 down, the neck taking 40%); looking back past
  100 degrees eases the head to the front.

Foot strikes (count, strength, foot) go back to the renderer for the sounds.

## Cost

- CPU: MEASURED about 20 us a frame over every mode
  (`tests/render.person-motion-budget.test.ts`, the course in
  `tests/support/personMotionCourse.ts`), against the brief's 80 us.
- Garbage: no per-frame objects, arrays or closures. V8 still boxes doubles
  passed to the IK and pose helpers it does not inline: MEASURED about 190 B
  a frame (11 KB a second at 60 fps) once the code settles. The brief's
  zero-allocation rule binds the sim's step, not the figure. Measured with a
  tsx script under `--expose-gc` over five laps of the course; the same loop
  inside Vitest reads 650 to 1,050 B a frame, its transformed modules not
  being what the browser runs, so no test pins the number.
- GPU: not measured here. SwiftShader timings are not a GPU's. The walker
  shots in `npm run perf:ab` (`walk-door-chase` and the others) time it on the
  macOS runner.

## Tests

- `tests/render.person-figure.test.ts`: the skeleton; the baked body's
  levels (triangle bands, bounds, winding, skin weights to the right bones,
  normals, UVs); the maps' sizes; the mip chains.
- `tests/render.person-gait.test.ts`: cadence against the published bands,
  slip on flat ground and slopes, the walk-run switch in the feet, knee and
  pelvis ranges.
- `tests/render.person-motion.test.ts`: every mode draws a whole pose; the
  swimmer's eye; the seated hands and feet; getting in and out continuous
  with the seat; landings, the roll, the climb; first person and the look.
- `tests/render.person-motion-budget.test.ts`: the frame budget.
- `tests/gpu/person-figure.test.ts`: compile and inter-stage audit, draws
  per tier, the skin following the bones, the maps lit the way the bake
  made them (the image's top at the top, the normal map's X and Y), the
  figure's own shadow bias, and the off-frame warm-up.
