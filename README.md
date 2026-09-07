# 2D Walker

A React + Three.js **four-leg walker** on the `2DWalker_v0_3` model (middle pair hidden). This tree **kind of works**: four-direction walk and in-place turning are in, planted-foot reverse IK is in, and several failure modes are still open. The intended gait is specified in [docs/walking-quad-specification.md](docs/walking-quad-specification.md) so a cleaner controller can be regenerated from the rules instead of more patches.

## Run the latest version

### In the browser

**[Open 2D Walker](https://threesnake404.github.io/2d-walker/)**

That GitHub Pages build is this repo’s current `main` (the “kind of works” snapshot), not the older poser-only deploy.

### Locally

```bash
git clone https://github.com/ThreeSnake404/2d-walker.git
cd 2d-walker
npm install
npm run dev
```

Open the URL Vite prints, usually http://localhost:5173/.

```bash
npm run build
npm run preview
```

builds the same static app Pages serves.

## Controls

| Input | Action |
| --- | --- |
| **WASD** | Walk in the chassis frame. **W** forward (+Z), **S** back, **A** +X, **D** −X. |
| **Arrow keys** | **Up/Down** same as W/S. **Right** turns clockwise from above, **Left** counter-clockwise. |
| Drag the chassis | Walk toward the cursor on the ZX ground plane. |
| Click a limb | Select; drag to pose (manual IK). Click empty space to orbit. |
| Front / Top / Right | Camera presets. Orthographic / Perspective toggles projection. |

Y is up. Walking and turning are on the ZX plane.

## Spec

[docs/walking-quad-specification.md](docs/walking-quad-specification.md) records:

- Reverse IK so a **planted** foot stays on one world point (no slide, drag, or sideways sweep).
- Four-leg walk: forward, back, left, right, and the diagonal-pair turn.
- Recover to the start stance after a turn and when walk stops.
- What to preserve vs what the current `walkIk.ts` pile got wrong (freezes after a right turn, bad sideways poses, and so on).
