# Logical Unit Renderer (prototype)

A renderer where every screen position is a **unit** with one color and exactly **one vector**
(an `Int32` pointing at the region that decides its color). Above the units sit pure function
**nodes** arranged in **levels**; nodes with two or more inputs are **connectors**. Input travels
up a unit's vector, changes flow down the graph, and only the units a change reaches are recomputed.

The engine core (`src/core.js`) has no 3D in it: no xyz, no camera, no matrices, no physics.
The only geometry it knows is the 2D coverage of a screen position.

## Run it

| What | Command |
|---|---|
| Open the interactive page | open `dist/index.html` in a browser (no server needed) |
| Behaviour checks (19) | `npm test` |
| Benchmark, incremental vs full redraw | `npm run bench` |
| Race against the browser's Canvas 2D rasterizer | `npm install` once, then `npx playwright install chromium`, then `npm run race` |
| Rebuild the single-file page | `npm run build` |
| Render PNG snapshots without a browser | `npm run snapshots` |

Only `race` needs a dependency (Playwright). Everything else is plain Node, no packages.

## Files

- `src/core.js`: units, vectors, nodes, connectors, levels, 16×16 unit groups, dirty marking,
  early cutoff, per-unit compositor, hit testing and provenance. Knows nothing about the scene.
  Runs anywhere JavaScript runs: no DOM, no canvas, no WebGL inside.
- `src/backend-canvas2d.js`: draws the same L1 primitives with the browser's native 2D
  rasterizer instead of the per-unit loop. Used for the race.
- `src/scene.js`: the demo scene (cube, light, floor, shadow, debris, two buttons) built from
  L1 regions, L2 objects and L3 rules, plus the benchmark scenarios.
- `src/app.js`, `src/page.html`: the page (views, readouts, vector graph, trace, benchmark).

## Levels in the demo

| Level | Nodes |
|---|---|
| L3 rules | Input, Highlight, Light drag, Spin, Gravity, Explode, Debris motion, Clock |
| L2 objects | Cube, Light, Debris, UI (state); Cube shape, Lighting (pure functions) |
| L1 regions | Sky, Floor, Light handle, Shadow, Debris shadows, Cube sides ×4, Cube top, Debris pieces, BOOM, JUMP |
| L0 units | one color + one vector per screen position |

## Measured (single thread, best of several runs)

| Scenario | 800×500 units / ratio | 1920×1080 units / ratio |
|---|---|---|
| Nothing changes | 0% / no work | 0% / no work |
| Cube rotating | 8.5% / 5.5× | 6.5% / 8.3× |
| Cube jumping | 13.1% / 4.6× | 10.5% / 6.4× |
| Explosion, 96 moving regions | 19.8% / 2.8× | 13.5% / 4.2× |
| Light moves sideways | 19.2% / 3.9× | 15.8% / 4.5× |
| Light moves up and down (global) | 100% / 1.0× | 100% / 1.0× |

Ratio = full-redraw time ÷ incremental time on the same engine. Both modes produce identical
images (checked by `tools/test.js`). Changed units cost more than average ones, because change
happens where the scene is busy, so the speed-up is smaller than the share alone suggests.

### Race: same scene, same graph, two rasterizers (`tools/race.js`)

Headless Chromium on the same CPU, no GPU in the measuring machine (its WebGL is SwiftShader,
a software emulator, so PixiJS and three.js were not measured). Milliseconds per frame to
produce the pixels, best of 3 × 60 frames.

| 800×500 | changed | deciding what to recompute | LPU full | LPU incremental | Canvas 2D full | Canvas 2D incremental |
|---|---|---|---|---|---|---|
| Cube rotating | 8.4% | 0.04 | 12.07 | 2.19 | 1.79 | 0.62 |
| Explosion | 19.8% | 0.29 | 14.37 | 4.96 | 2.21 | 2.09 |
| Light up/down | 100% | 0.09 | 12.44 | 12.43 | 1.92 | 4.50 |

| 1920×1080 | changed | deciding | LPU full | LPU incremental | Canvas 2D full | Canvas 2D incremental |
|---|---|---|---|---|---|---|
| Cube rotating | 6.5% | 0.04 | 62.78 | 7.80 | 5.31 | 1.85 |
| Explosion | 13.5% | 0.34 | 69.30 | 15.11 | 5.96 | 4.69 |
| Light up/down | 100% | 0.18 | 60.77 | 65.34 | 5.33 | 18.05 |

Readings:
- Deciding what to recompute is nearly free (0.04 to 0.34 ms).
- Filling the pixels is the cost. The per-unit JavaScript loop is 6 to 12 times slower than the
  browser's native rasterizer on the same CPU, and the incremental trick helps Canvas 2D too.
- Clipping Canvas 2D to many small groups costs more than it saves when much of the screen
  changes; the LPU's groups have no such penalty.
- Next step for speed: keep the graph and groups, run the per-unit programs on the GPU (one
  16×16 group = one compute workgroup) or in WASM SIMD across workers, then race PixiJS and
  three.js on a machine with a real GPU.

## What the prototype does not settle

- **Shape information.** `Cube shape` is four corners on an ellipse plus copies shifted down:
  an orthographic projection written in 2D. It works because the cube turns around one axis
  under a fixed view. Free rotation of a complex model needs its shape computed, stored or learned.
- **Global changes.** When a change reaches every unit (camera motion, a light that recolors
  the sky), incremental work equals full redraw plus bookkeeping.
- **GPU throughput.** This is CPU JavaScript; the ratio between the modes is the result, not the ms.

## Plan

1. **Spec the model** (done in code, needs writing down): one out-vector per unit; vectors carry
   data only; nodes are pure; state changes only inside rules at tick boundaries; the graph is
   acyclic within a tick (cycles only through state across ticks); early cutoff; determinism.
2. **CPU prototype** (this repo).
3. **Break-even curve.** Sweep the share of changed units from 0 to 100% and measure incremental
   vs full, plus bytes per unit of bookkeeping. Gate: if incremental loses below ~30% change on
   typical scenes, target only low-change uses.
4. **Authoring.** A small DSL or node editor for regions, objects and rules, with the provenance
   inspector built in. Writing rules is the real bottleneck, not compute.
5. **Throughput.** Move the per-unit loop to WebGPU compute or WASM SIMD; keep the graph and
   dirty tracking on the CPU. Compare incremental-on-GPU against full-on-GPU.
6. **Hard cases.** Freely rotating complex model (the soldier): try the three places shape can
   live (projection node, stored views, small neural node) as interchangeable nodes and score
   them against a reference render (PSNR/SSIM) and cost. Light shafts through trees: rule-based
   approximation vs reference.
7. **Choose the niche from the numbers.** Likely fits: UIs and dashboards, editors and CAD
   viewers, 2D/2.5D and board games, maps, signage and e-ink, remote rendering that sends only
   changed units, deterministic replays and debugging.
