# Walking quad specification

This document is the source of truth for a **four-leg walker** on the ZX ground plane. It records what was asked for, what must be preserved, and what went wrong in the current implementation (`src/walker/walkIk.ts` and friends). The present code **kind of works**. It is a stack of patches on a gait that was originally written for dragging a body around, not for a clean quadruped controller. The intended next step is to **regenerate a cleaner system** from these rules rather than keep patching the same file.

Status of this tree: four-direction walk plus in-place turning exist and are usable. Planted-foot reverse IK, recover-to-stance, and illegal-pose rejection were added later. Sideways gait, post-turn walk, and pose legality are still worse than they were before those patches. Do not treat the live code as the spec.

---

## 1. Purpose

A planar-hinge quadruped (the four corner legs of `2DWalker_v0_3.gltf`) must:

1. Stand on arched legs with soles on the ground.
2. Walk **forward, backward, left, and right** in the chassis frame.
3. **Turn** in place clockwise and counter-clockwise.
4. Keep a supporting foot **glued to one world point** until it is lifted for a real step.
5. Never skate, drag, slide sideways, or fold a leg through the chassis.

The middle pair (index 2) stays in the model and stays **hidden** until the corner gait is settled.

---

## 2. World, model, and joints

### 2.1 Coordinates

| Axis | Meaning |
| --- | --- |
| **Y** | Up |
| **ZX** | Ground plane. Walking and turning happen here. |
| Chassis **+Z** | Forward |
| Chassis **+X** | Right in authored model space; **A** walks this way (see controls) |

The ground is `y = 0`. Soles sit on that plane. The chassis rides above it on arched legs.

### 2.2 Active legs

Only the **corners** walk:

| Id | Role | Start shoulder yaw |
| --- | --- | --- |
| `Left1` | Front-left | **+40°** (out from the chassis) |
| `Right1` | Front-right | **+40°** |
| `Left3` | Back-left | **−40°** |
| `Right3` | Back-right | **−40°** |

Hidden: `Left2`, `Right2` (middle).

Each leg is a chain: **shoulder → upper → lower → foot**. Shoulders are **siblings of Chassis**, not children. Any body translate or yaw must move the four shoulders explicitly or the legs are left behind.

### 2.3 Joints (legal range)

These limits are part of the model contract. A regenerated solver must still respect them.

| Joint | Range (deg) | Notes |
| --- | --- | --- |
| Shoulder | −44 … +50 | Yaw. Front start +40, back start −40. |
| Upper | −10 … +72 | Stops short of a straight vertical bone. |
| Lower | −140 … −30 | Knee stays bent; never 180°. |
| Foot | −90 … +90 | Brick stays one piece; flatten to the ground. |

A pose that inverts the shank, puts the knee below the hip, points the lower bone skyward, or folds the leg **under / through the chassis** is **illegal**. Illegal poses must not be written onto the bones. Rank-and-pick of two bad triangles is not a solution.

### 2.4 Stance (home)

At rest, every foot sits on a **neutral plant** stored in the **chassis frame** (`restOffset`: x along chassis right, z along chassis forward). Home must travel with heading. World-space home was left behind after about a half turn: stride collapsed and a leftover drag sat in the queue.

Standing arch (current numbers, for regeneration not gospel):

- Hip-to-foot span about **0.78** of arched max reach.
- Tilt about **28°** so the shank leans ~20° off world-vertical.
- Shank must stay **off world-vertical** (a dead zone around the line; ~14° was used). On the line the Jacobian dies; a hair past it the other triangle flips the lower bone skyward (the front-leg **L-pose**).

After any turn, and whenever walk/drag **stops**, the walker must **recover**: hop each foot back onto this start stance (shoulders pointing out from the chassis) **before** a new straight walk may move the body.

---

## 3. Controls

All walk sticks are **chassis-local**. After a yaw, **W is still forward**.

| Input | Meaning |
| --- | --- |
| **W** / ArrowUp | Walk +Z (forward) |
| **S** / ArrowDown | Walk −Z (back) |
| **A** | Walk **+X** |
| **D** | Walk **−X** |
| **ArrowRight** | Turn **clockwise** from above (chassis yaw **negative**) |
| **ArrowLeft** | Turn **counter-clockwise** from above (chassis yaw **positive**) |
| Hold-drag on chassis | Walk toward the cursor on the ZX plane (same gait as a held key) |
| Limb click-drag | Manual pose (debug / poser); not the walk controller |

Hold-walk keeps a goal **ahead along the held heading** so the body does not stop while the key is down. Release must **not** leave a leftover leash: stop the chassis and recover the feet. A leftover leash kept the body creeping and left a trailing plant.

Walk intent is **queued** during turn and recover. It must not drain until recover has **finished completely**.

---

## 4. The plant rule (non-negotiable)

This is the core of the gait. Everything else is how to relocate a foot when the rule would otherwise break.

### 4.1 Reverse IK for a supporting leg

If a foot is **on the ground and not swinging**:

1. Its plant is a **fixed world (x, z)** (and a fixed sole height).
2. The solver may only change **joint angles**.
3. The sole must be pulled back to that same world point every frame after the hips move.
4. Chassis-forward and foot-backward **in the body frame** must match. If the body moves +d in world and the IK only recovers a fraction of d, the foot **drags**. That is a bug, not a style.

User wording that must stay true:

> Plant the foot, don't slide it or drag it. The IK should leave the foot in one spot if it is on the ground. Chassis forward and foot backward have to be the same to give the illusion that the foot is not moving.

### 4.2 No sideways plant motion

A planted shoulder **must not yaw as a way to move the foot**. Yawing a supporting shoulder sweeps the sole sideways on the floor.

Shoulder yaw is allowed only:

- **While the sole is airborne** (lifted off the plant), to aim the swing plane at the next footfall, or
- On a planted leg, **only** as reverse IK to keep the **existing** world plant inside the swing plane — the foot itself does not travel.

If the plant is off the current hinge plane, the leg must **step**, not skate.

### 4.3 How the body may move while feet are planted

The chassis may only translate/yaw as far as reverse IK can still hold every supporting sole. If a hip-to-plant span would leave the legal arch, the body **waits** and that leg **steps**. The body must not outrun the cycle (dragging trailing feet forward or pushing them out).

A supporting foot that cannot be held must be **lifted in an arc** and planted somewhere else. It must never slide to the new spot.

---

## 5. Stepping

### 5.1 Shape of a step

Every relocation (walk, turn, recover) is a hop:

1. **Up** off the ground.
2. **Over** (horizontal travel only while the sole is clear of the floor).
3. **Down** onto the new plant.

Horizontal travel while the sole is still on the floor is a skate. Shoulder yaw while the sole is still on the floor is a sideways skate.

Peak lift must be obvious (order of **0.18** of reach, and not less than about one unit on this model). A tiny lift plus a yawed hinge flattened hops into skates.

### 5.2 How many feet in the air

With four legs, **at most one** swing at a time is the default (roughly `floor(n/3)`). Two supporting diagonals (or three plants) keep the body. Putting two feet in the air during a crab-walk produced through-body snaps. An extra swing slot is an emergency only when the chassis is **parked** on a forward/back overstretch, not a sideways habit.

### 5.3 Landing

Aim at **neutral stance plus a lead** along the current move direction, not at the last footfall. Neutral travels with the body, so sideways error is cancelled on each step instead of accumulating into a wandering leg.

A landing that would put the foot **inboard of the hip** (through the chassis) is illegal. Push it back to the **outboard** side of that hip, along the home splay. Sideways walk toward the opposite side of the body is the usual way that inboard landing is commanded.

Do not collapse a needed step onto a few centimetres of the hip sphere when the current plant is already past the hold radius. That is how the chassis froze: hold radius spent, step refused as “too short.”

---

## 6. Four walking modes

All four are first-class. A solver that only looks good going +Z is incomplete.

### 6.1 Forward (W)

- Move the chassis +Z in its own frame.
- Trailing feet stay planted until they run out of trail, then hop **forward** onto rest + lead.
- Trailing plants must not be **pushed out** sideways or **dragged forward**. Those were observed bugs on forward walk.
- Reverse IK must pull each planted sole backward in the body frame at the same rate the chassis advances.

### 6.2 Backward (S)

Same machine as forward with move direction −Z. Plants in front of the body become the trailing set. No special-case opposite gait.

### 6.3 Sideways left (A) and right (D)

Same machine with move direction along chassis ±X.

This is the **hard** direction: the stance is already splayed sideways, so there is little extra room toward or away from the body. Requirements:

- Short, frequent hops, still with a real lift.
- The **inside** legs (the side we walk toward) fold toward the body; they must not cross under the chassis or invert.
- The **outside** legs reach; they must not go flat or skate.
- Shoulder choice has two headings that put the foot in the swing plane. **One is outboard (legal). The other is the same plane flipped through the chassis (illegal).** Always take outboard. Biasing toward shoulder pose 0 picked the through-body option on a ±40° splay.
- Do not apply an inverted L, a skyward shank, a knee below the hip, or a through-body fold “because it was the better of two illegal scores.”

Observed on A and D: random pops, folded-under legs, ridiculous poses. Those are spec violations, not an acceptable crab-walk look.

### 6.4 Turning (arrows)

In-place yaw, not a curved walk.

**Clockwise from above** (right arrow), as two halves:

1. `Right1` + `Left3` **hold** (plants stay).
2. `Left1` steps **forward**, `Right3` steps **back**, one at a time, each a real hop.
3. Every supporting plant stays; the chassis **pivots** a half step of heading.
4. Other diagonal holds: `Left1` + `Right3` hold; `Right1` back, `Left3` forward; pivot.

Counter-clockwise reverses order and step directions.

Rules:

- Never skip a turn hop because the orbit is short. Skipping fell straight through to the pivot and **dragged that sole**.
- After the last pivot of a held turn, **recover to start stance** before any W/A/S/D motion.
- Recover must finish completely. Walking during recover is how a trailing plant and a frozen chassis appeared.
- After recover, held W must walk again in the **new** forward. Freezing after a right turn, or walking a few metres then locking, are bugs.

---

## 7. Recover-to-home

Trigger:

- Turn finishes.
- Walk key or chassis drag is **released**.

Behaviour:

- Park the chassis (`pending` cleared; no leash).
- Hop the most-displaced foot onto home, one at a time, until every plant is within a small radius of rest (about **0.18** world units was used).
- Then, and only then, a held walk key may set a new goal.

Recover is a short hop, not a walking stride. Cap a badly parked foot to two partials rather than one long lunge.

---

## 8. Arch and reach band

The usable hip-to-foot span is **not** upper + lower. Knee limits keep an arch. Outside the band the knee sinks to hip level and the leg reads as flat.

| Band | Share of arched max reach (current) |
| --- | --- |
| Folded (too close) | below ~0.52 |
| Working | ~0.52 … ~0.87 |
| Stretched (must step) | above ~0.87 |

Alarms sit **just outside** the band so a full-length landing does not immediately re-step.

The shank must point **down** and stay off world-vertical. Upper bone must not point up. Knee must stay **above** the hip.

If **both** two-bone solutions are illegal, **do not write either one**. Keep the last legal pose and force a step. Calculating a ridiculous pose and applying it is how sideways gait got worse.

---

## 9. Body speed vs step cycle

The body may only move as fast as the gait can place feet.

- One stride per cycle, cycle = (leg count / swing slots) × step duration.
- Duty factor (~0.7) is headroom for an in-flight swing and a frame waiting for a slot.
- At **2×** trial speed (`WALK_SPEED = 2`) with four legs and one swing slot, the chassis **outruns** the cycle unless reverse IK and the hold radius stop it. If they stop it and the follow-up step is refused, the chassis **freezes**. A cleaner system should pick one speed the cycle can actually sustain, or more swing slots with a proven support pattern — not hope.

Step duration ~380 ms was left unchanged during the 2× speed trial.

---

## 10. Implementation notes for a rewrite

These are facts about the current model and the failed approaches, not required APIs.

### 10.1 Preserve

- Chassis-local WASD and the A/D swap (A = +X, D = −X).
- Arrow turn signs (right = clockwise from above).
- Four corners only; middle hidden.
- Start splay +40° / −40°.
- `restOffset` in **chassis** axes, not world.
- Shoulders translated and yawed with the chassis (siblings).
- Bake chassis yaw into the shoulder **rest quaternion**; a world yaw on the object is thrown away when IK rebuilds from rest × pose.
- Plant record per leg; reverse IK onto that record.
- Swing = lift then translate then drop.
- Recover after turn and on walk release.
- Hold-drag aims at a **ground point**, not accumulated pointer deltas.

### 10.2 Do not repeat

- Restoring last hip-relative joint angles on a planted leg after the body has moved (trailing-leg skate).
- `faceShoulder` chasing an **overshoot** target used to pull the sole; the shoulder winds a little more every frame until the hold radius is gone (lock “further down the road”).
- Biasing shoulder choice toward **pose 0** (through-chassis on a 40° splay).
- Pin-mode aim (`>90°` jumps) on **every** walk hop (sideways flips). Pin-mode is for recover unwind and for keeping a **fixed** plant in plane, not for ordinary steps.
- Refusing a step as too short while the body is already at the hold limit (deadlock after a turn).
- Recapturing stance after every turn pivot (bakes twisted plants as the new home; ~160° speed collapse).
- Rotating `restOffset` when the chassis yaws (double-applies heading).
- Skipping turn hops when the orbit is small (pivot skate).
- A leftover walk leash on key-up.
- Applying the better of two **illegal** IK solutions.
- Two airborne legs as the default crab-walk pattern.

### 10.3 Suggested architecture (clean rewrite)

Keep three loops, in this order, every frame:

1. **Intent** — keys/drag → chassis-local desired translation and yaw rate. Block translation while turning or recovering.
2. **Support** — for each planted leg, reverse-IK to the stored world plant. If the plant is unreachable without an illegal pose, **do not change that leg’s pose toward the illegal solution**; schedule a step and clamp body motion to zero for that frame if needed.
3. **Swing** — at most one hop; target is outboard rest + lead; shoulder yaws only while airborne; land, then store the new plant.

Turn is a scripted sequence of those hops plus a yaw of the body while the other diagonal is supporting.

Do not mix “pull the sole by overshooting the IK target” with “aim the shoulder at that overshot point.”

---

## 11. Known failures (current tree)

Recorded so a rewrite is judged against the same videos and symptoms, not against “it moved.”

| Symptom | When | What was going wrong |
| --- | --- | --- |
| Foot slides out / drags forward | Forward walk | Reverse IK stopped short; body outran the pull. Trailing legs also pushed **out**. |
| Skate on every step | Walk / turn / recover | No lift, or horizontal travel while still on the floor. |
| Front legs vertical / inverted L | Stance and front pair | Solver parked on world-vertical; other triangle flipped the shank up. |
| Slowdown after ~160° of turning | Long yaw | Home was world-fixed; hips walked off it. |
| Freeze after right turn, then W | Turn then hold W | Recover/hold radius vs refused short step. Chassis scaled to zero and no hop started. |
| Same freeze “further down the road” | Walk after a turn | Shoulder yaw ratcheted (pin chased overshoot); then hold radius spent. |
| Random / ridiculous leg poses | **A and D** | Through-chassis shoulder heading; inboard landings; illegal triangle still applied. Worse after plant-lock and pin patches than before. |
| Slide **after** a turn hop | Pivot | Hop happened; then the yaw dragged the holders. Pivot must re-solve planted soles without moving them. |

The user’s later note still stands: **there are more things wrong with the legs than there were before the plant-lock / freeze / sideways patches.** Preserve the plant rule and the four-direction-plus-turn contract. Do not preserve the patch pile.

---

## 12. Acceptance tests (rewrite)

A regenerated system is done when all of the following hold in the live app, not in a screenshot.

1. **Stand.** Four arched legs, soles on the ground, shoulders at the start splay, no inverted L.
2. **Hold W.** Chassis moves +Z. Planted pads stay on the same grid tiles until a visible hop. No outward or forward drag.
3. **Hold S.** Same, −Z.
4. **Hold A, then D.** Chassis strafes. No foot under the body, no popped joints, no through-chassis fold. Hops still lift.
5. **Right arrow, then left.** Diagonal-pair turn gait; hops then pivot; no slide during the pivot.
6. **W, then right arrow, then W.** Recovers to start splay, then walks the **new** forward without freezing then or a few metres later.
7. **Release W while moving.** Chassis stops; feet hop home; no trailing leash.
8. **Illegal pose.** No frame shows a skyward shank, a knee below the hip, or a leg through the chassis.

Until those pass, the walker only **kind of works**.

---

## 13. Code map (today)

| Path | Role |
| --- | --- |
| `src/walker/walkIk.ts` | Gait, reverse IK, turn, recover. Overgrown; rewrite candidate. |
| `src/walker/joints.ts` | Limits, rest quaternions, foot flatten. |
| `src/walker/parts.ts` | Names; active indices 1 and 3. |
| `src/components/WalkerModel.tsx` | rAF: held keys → `advanceBody` → `solveWalkGait`. |
| `src/App.tsx` | HUD, camera, chassis readouts. |
| Model | `model/2DWalker_v0_3.gltf` |

Primary loop in `WalkerModel`: `applyHeldInputs` → `advanceBody` → `solveWalkGait`.
