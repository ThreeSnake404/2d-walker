import { Box3, Vector3, type Mesh, type Object3D } from "three";
import { applyJointPose, flattenFoot, getJoint, setRestPose, wrapAngleDelta } from "./joints";
import {
  ACTIVE_FOOT_PARTS,
  ACTIVE_LOWER_LEG_PARTS,
  ACTIVE_SHOULDER_PARTS,
  ACTIVE_UPPER_LEG_PARTS,
  CORNER_SHOULDER_PARTS,
} from "./parts";

/**
 * Working band, as a share of the arch-limited reach. Outside it the knee sinks
 * to hip level and the leg reads as flat rather than load-bearing, at both ends
 * and long before the joint limits would object, so a leg past either edge has
 * to step even though its pose is still legal.
 *
 * The far edge is set so a leading leg swings its lower segment about 20 degrees
 * past vertical, which is as much ground as one step can cover while the knee
 * still stays above the hip.
 */
const STRETCH = 0.87;
const FOLD = 0.52;
/**
 * Alarm thresholds, held just outside the band. A full-length step lands right
 * on an edge by design, so alarms set exactly at the edges would fire on the
 * pose the leg just landed in and send it straight back into another step,
 * burning every swing slot while its partner starves.
 */
const STRETCH_ALARM = STRETCH + 0.02;
const FOLD_ALARM = FOLD - 0.02;
const CRITICAL = 0.93;
const STEP_TRIGGER = 0.18;
const STEP_DURATION_MS = 380;
const STEP_HEIGHT = 0.08;
/**
 * Sanity ceilings on one step, as a share of leg reach. The arch band is what
 * really sets stride length, per direction and per leg; these only catch
 * degenerate geometry. Held tight they instead throttle whichever direction has
 * the most room, which is fore/aft: swinging a foot forward barely changes how
 * far it sits from the hip, so a leg has nearly twice the fore/aft travel it
 * has sideways and used to spend less than half of it.
 */
const STRIDE = 1;
const MIN_STEP = 0.35;
const MAX_STEP = 1;
/** How far the body may still travel after a drag ends, as a share of reach. */
const LEASH = 0.5;
const MAX_FRAME_MS = 64;
/**
 * How far a shoulder may yaw off its neutral aim over a stride. The joint
 * itself allows 44 degrees the tighter way, but a stride that spends the last
 * few degrees leaves the shoulder nothing for the yaw it also needs to cancel
 * sideways error, and a clipped shoulder aims the swing plane off the footfall
 * so the foot lands short and scuffs.
 */
const MAX_SWEEP = 40 * (Math.PI / 180);
/** Standing arch: hip-to-foot span, and how far the foot sits below the hip. */
const STAND_REACH = 0.72;
const STAND_TILT = 38 * (Math.PI / 180);

function maxActiveSteps(legCount: number) {
  return Math.max(1, Math.floor(legCount / 3) || 1);
}

const _hip = new Vector3();
const _knee = new Vector3();
const _target = new Vector3();
const _hinge = new Vector3();
const _toTarget = new Vector3();
const _upperDir = new Vector3();
const _toFoot = new Vector3();
const _restBone = new Vector3();
const _boneA = new Vector3();
const _boneB = new Vector3();
const _planeA = new Vector3();
const _planeB = new Vector3();
const _cross = new Vector3();
const _offset = new Vector3();
const _dir = new Vector3();
const _from = new Vector3();
const _to = new Vector3();
const _kneeA = new Vector3();
const _kneeB = new Vector3();
const _upperA = new Vector3();
const _upperB = new Vector3();
const _soleProbe = new Vector3();
const _stance = new Vector3();
const _spanHip = new Vector3();
const _spanBody = new Vector3();
const _bodyNow = new Vector3();
const _stanceErr = { along: 0, sideways: 0 };
const _meshBox = new Box3();

export type LegChain = {
  id: string;
  shoulder: Object3D;
  upper: Object3D;
  lower: Object3D;
  foot: Object3D;
  upperLen: number;
  lowerLen: number;
  /** Hip-to-foot distances the knee limits can actually reach, so the leg keeps an arch. */
  reachMin: number;
  reachMax: number;
  /** Fixed foot offset along the hinge, which no joint rotation can undo. */
  sideOffset: number;
  restOffset: Vector3;
  plant: Vector3;
  airMs: number;
  step: { from: Vector3; to: Vector3; start: number; duration: number } | null;
};

export type WalkGait = {
  root: Object3D;
  chassis: Object3D;
  legs: LegChain[];
  moveDir: Vector3;
  moved: boolean;
  /** Drag distance the body still owes the pointer, drained at walking speed. */
  pending: Vector3;
  /**
   * Ground point a held drag is steering toward. Tracking a destination rather
   * than accumulating pointer deltas is what lets the body keep walking while
   * the cursor is held still away from the chassis: there is still ground to
   * cover, even though no new pointer movement is arriving.
   */
  goal: Vector3;
  goalActive: boolean;
};

function findNamed(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((child) => {
    if (child.name === name) found = child;
  });
  return found;
}

export function hideCornerLegs(root: Object3D) {
  for (const name of CORNER_SHOULDER_PARTS) {
    const shoulder = findNamed(root, name);
    if (shoulder) shoulder.visible = false;
  }
}

function isWorldVisible(object: Object3D) {
  let current: Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

export function visibleBounds(root: Object3D, target = new Box3()) {
  target.makeEmpty();
  root.updateMatrixWorld(true);
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || mesh.userData.pickVolume || !isWorldVisible(mesh)) return;
    _meshBox.setFromObject(mesh);
    if (!_meshBox.isEmpty()) target.union(_meshBox);
  });
  return target;
}

export function footSoleY(foot: Object3D) {
  let minY = Infinity;
  foot.updateWorldMatrix(true, true);
  foot.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || mesh.userData.pickVolume || !isWorldVisible(mesh)) return;
    _meshBox.setFromObject(mesh);
    if (!_meshBox.isEmpty()) minY = Math.min(minY, _meshBox.min.y);
  });
  return minY;
}

export function recaptureStance(gait: WalkGait) {
  gait.chassis.getWorldPosition(_from);
  for (const leg of gait.legs) {
    leg.foot.getWorldPosition(leg.plant);
    leg.restOffset.set(leg.plant.x - _from.x, 0, leg.plant.z - _from.z);
  }
}

/** Height of the foot origin above its own sole, at the current pose. */
function soleOffset(leg: LegChain) {
  leg.foot.getWorldPosition(_soleProbe);
  const sole = footSoleY(leg.foot);
  return Number.isFinite(sole) ? _soleProbe.y - sole : 0;
}

function liftBody(gait: WalkGait, dy: number) {
  if (Math.abs(dy) < 1e-6) return;
  gait.chassis.position.y += dy;
  for (const leg of gait.legs) {
    leg.shoulder.position.y += dy;
  }
  gait.root.updateMatrixWorld(true);
}

/**
 * Stand the walker on arched legs.
 *
 * The authored spread puts each foot nearly a full leg-length out sideways, which
 * only reaches the floor with a straight leg. So the stance is derived from the
 * arch instead: every foot sits one arched span out along its own direction, and
 * the body rides high enough that the soles still touch.
 */
export function plantFeetOnGround(gait: WalkGait, floorY: number) {
  gait.root.updateMatrixWorld(true);
  if (!gait.legs.length) return;

  let lift = 0;
  for (const leg of gait.legs) {
    lift += Math.sin(STAND_TILT) * leg.reachMax * STAND_REACH + soleOffset(leg);
  }
  lift /= gait.legs.length;

  // The hip sits a fixed distance above the chassis, so one shift sets the height.
  gait.legs[0].upper.getWorldPosition(_hip);
  liftBody(gait, floorY + lift - _hip.y);

  gait.chassis.getWorldPosition(_stance);
  for (const leg of gait.legs) {
    // Park the shoulder square to the chassis and stand the leg in the plane it
    // already swings in, so nothing has to yaw to reach the starting stance.
    const shoulderJoint = getJoint(leg.shoulder);
    if (shoulderJoint) setRestPose(leg.shoulder, shoulderJoint);
    hingeWorld(leg.upper, _hinge);
    leg.upper.getWorldPosition(_hip);
    leg.foot.getWorldPosition(_from);

    _dir.set(_hinge.z, 0, -_hinge.x);
    if (_dir.lengthSq() < 1e-8) _dir.set(_hip.x >= 0 ? 1 : -1, 0, 0);
    _dir.normalize();
    if (_dir.x * (_hip.x - _stance.x) + _dir.z * (_hip.z - _stance.z) < 0) _dir.negate();

    // The foot's offset along the hinge is built into the model and no rotation
    // can change it, so keep it rather than yawing the shoulder to chase it.
    const sideways = (_from.x - _hip.x) * _hinge.x + (_from.z - _hip.z) * _hinge.z;
    leg.sideOffset = sideways;
    const out = Math.cos(STAND_TILT) * leg.reachMax * STAND_REACH;
    _target.set(
      _hip.x + _dir.x * out + _hinge.x * sideways,
      floorY + soleOffset(leg),
      _hip.z + _dir.z * out + _hinge.z * sideways,
    );
    solveReach(leg, _target, true);
  }

  // Settle each sole onto the floor. This only moves the foot vertically, which
  // stays inside the swing plane, so the shoulders keep their square pose.
  for (const leg of gait.legs) {
    leg.foot.getWorldPosition(_from);
    const keepX = _from.x;
    const keepZ = _from.z;
    for (let i = 0; i < 8; i += 1) {
      const sole = footSoleY(leg.foot);
      if (!Number.isFinite(sole)) break;
      const error = sole - floorY;
      if (Math.abs(error) < 0.002) break;
      leg.foot.getWorldPosition(_from);
      _target.set(keepX, _from.y - error * 1.25, keepZ);
      solveReach(leg, _target, true);
    }
  }

  let highestSole = -Infinity;
  for (const leg of gait.legs) {
    const sole = footSoleY(leg.foot);
    if (Number.isFinite(sole)) highestSole = Math.max(highestSole, sole);
  }
  if (highestSole - floorY > 0.002) liftBody(gait, floorY - highestSole);

  recaptureStance(gait);
  gait.moved = false;
  clearBodyDrag(gait);
}

function hingeWorld(object: Object3D, target: Vector3) {
  const joint = getJoint(object);
  if (!joint) return target.set(0, 0, 1);
  const parent = object.parent;
  if (parent) return target.copy(joint.axisLocal).transformDirection(parent.matrixWorld).normalize();
  return target.copy(joint.axisLocal).normalize();
}

function boneVector(from: Object3D, to: Object3D, target: Vector3) {
  from.getWorldPosition(_boneA);
  to.getWorldPosition(_boneB);
  return target.copy(_boneB).sub(_boneA);
}

function signedAngle(from: Vector3, to: Vector3, axis: Vector3) {
  _planeA.copy(from).projectOnPlane(axis);
  _planeB.copy(to).projectOnPlane(axis);
  if (_planeA.lengthSq() < 1e-8 || _planeB.lengthSq() < 1e-8) return null;
  _planeA.normalize();
  _planeB.normalize();
  return Math.atan2(_cross.crossVectors(_planeA, _planeB).dot(axis), _planeA.dot(_planeB));
}

function poseToward(object: Object3D, restDir: Vector3, desiredDir: Vector3, hinge: Vector3) {
  const joint = getJoint(object);
  if (!joint) return;
  const angle = signedAngle(restDir, desiredDir, hinge);
  if (angle === null) return;
  applyJointPose(object, joint, angle);
}

function measureBone(from: Object3D, to: Object3D) {
  from.getWorldPosition(_from);
  to.getWorldPosition(_to);
  return _from.distanceTo(_to);
}

/**
 * Hip-to-foot span the knee can actually cover, read straight off the lower-leg
 * limits. The knee interior angle is PI - |pose|, so a pose range that excludes
 * zero keeps the leg arched and shortens the usable reach below upper + lower.
 */
function reachBand(upperLen: number, lowerLen: number, lower: Object3D) {
  const span = (knee: number) =>
    Math.sqrt(Math.max(0, upperLen * upperLen + lowerLen * lowerLen - 2 * upperLen * lowerLen * Math.cos(knee)));
  const joint = getJoint(lower);
  if (!joint) return { reachMin: Math.abs(upperLen - lowerLen), reachMax: upperLen + lowerLen };

  const kneeAt = (pose: number) => Math.min(Math.PI, Math.max(0, Math.PI - Math.abs(pose)));
  const ends = [kneeAt(joint.min), kneeAt(joint.max)];
  const straightAllowed = joint.min <= 0 && joint.max >= 0;
  const kneeMax = straightAllowed ? Math.PI : Math.max(...ends);
  return { reachMin: span(Math.min(...ends)), reachMax: span(kneeMax) };
}

export function createWalkGait(root: Object3D): WalkGait {
  root.updateMatrixWorld(true);
  const chassis = findNamed(root, "Chassis");
  if (!chassis) throw new Error("Chassis is missing.");

  const chassisPos = new Vector3();
  chassis.getWorldPosition(chassisPos);
  const legs: LegChain[] = [];

  for (let i = 0; i < ACTIVE_SHOULDER_PARTS.length; i += 1) {
    const shoulder = findNamed(root, ACTIVE_SHOULDER_PARTS[i]);
    const upper = findNamed(root, ACTIVE_UPPER_LEG_PARTS[i]);
    const lower = findNamed(root, ACTIVE_LOWER_LEG_PARTS[i]);
    const foot = findNamed(root, ACTIVE_FOOT_PARTS[i]);
    if (!shoulder || !upper || !lower || !foot) continue;

    foot.getWorldPosition(_to);
    const plant = _to.clone();
    const upperLen = measureBone(upper, lower);
    const lowerLen = measureBone(lower, foot);
    legs.push({
      id: ACTIVE_SHOULDER_PARTS[i].replace("Shoulder", ""),
      shoulder,
      upper,
      lower,
      foot,
      upperLen,
      lowerLen,
      ...reachBand(upperLen, lowerLen, lower),
      sideOffset: 0,
      restOffset: new Vector3(plant.x - chassisPos.x, 0, plant.z - chassisPos.z),
      plant,
      airMs: 0,
      step: null,
    });
  }

  return {
    root,
    chassis,
    legs,
    moveDir: new Vector3(0, 0, 1),
    moved: false,
    pending: new Vector3(),
    goal: new Vector3(),
    goalActive: false,
  };
}

export type ChassisPosition = {
  x: number;
  y: number;
  z: number;
};

export function readChassisPosition(gait: WalkGait): ChassisPosition {
  return {
    x: gait.chassis.position.x,
    y: gait.chassis.position.y,
    z: gait.chassis.position.z,
  };
}

export function setBodyPosition(gait: WalkGait, x: number, y: number, z: number) {
  const dx = x - gait.chassis.position.x;
  const dy = y - gait.chassis.position.y;
  const dz = z - gait.chassis.position.z;
  gait.chassis.position.set(x, y, z);
  for (const leg of gait.legs) {
    leg.shoulder.position.x += dx;
    leg.shoulder.position.y += dy;
    leg.shoulder.position.z += dz;
  }
  gait.root.updateMatrixWorld(true);
  gait.moved = true;
}

export function translateBody(gait: WalkGait, dx: number, dz: number) {
  gait.chassis.position.x += dx;
  gait.chassis.position.z += dz;
  for (const leg of gait.legs) {
    leg.shoulder.position.x += dx;
    leg.shoulder.position.z += dz;
  }
  gait.root.updateMatrixWorld(true);
  gait.moved = true;
}

function legReach(gait: WalkGait) {
  let reach = 0;
  for (const leg of gait.legs) reach = Math.max(reach, leg.reachMax);
  return reach;
}

/**
 * How far a leg may swing either side of neutral along a direction, measured in
 * how far the foot travels before the leg leaves the arch.
 *
 * A foot parked out to the side has lots of fore/aft room but much less
 * sideways room, so a crab-walk takes shorter steps than a forward walk.
 * Solving that per direction is what lets the walker go any way it likes
 * without a leg either over-reaching or folding up under the body.
 *
 * Lead and trail come back separately because they are rarely equal: neutral
 * sits wherever the stance put it, not at the middle of the reachable band, and
 * a symmetric stride would throw away whichever side has the extra room.
 */
function strideSpan(gait: WalkGait, leg: LegChain, dirX: number, dirZ: number) {
  leg.upper.getWorldPosition(_spanHip);
  gait.chassis.getWorldPosition(_spanBody);
  const nx = _spanBody.x + leg.restOffset.x - _spanHip.x;
  const nz = _spanBody.z + leg.restOffset.z - _spanHip.z;
  const drop = _spanHip.y - leg.plant.y;
  const far = leg.reachMax * STRETCH;
  const near = leg.reachMax * FOLD;
  // Horizontal reach limits: the hip rides at a fixed height, so the drop eats
  // into the band before any of it is available for stepping.
  const farSq = Math.max(0.01, far * far - drop * drop);
  const nearSq = Math.max(0, near * near - drop * drop);

  // Offset u along dir from neutral puts the foot |n + u*dir| from the hip, so
  // the legal u are where that parabola sits inside the band.
  const nSq = nx * nx + nz * nz;
  const p = nx * dirX + nz * dirZ;
  const outer = Math.sqrt(Math.max(0, p * p + farSq - nSq));
  let lo = -p - outer;
  let hi = -p + outer;

  // Folding too close to the hip is out of bounds, which can carve a hole out
  // of the middle of that interval. Keep the piece neutral itself lives in.
  const innerSq = p * p + nearSq - nSq;
  if (innerSq > 0) {
    const inner = Math.sqrt(innerSq);
    if (-p + inner <= 0) lo = Math.max(lo, -p + inner);
    else if (-p - inner >= 0) hi = Math.min(hi, -p - inner);
    else return { lead: leg.reachMax * 0.06, trail: leg.reachMax * 0.06 };
  }

  // The shoulder has to yaw to aim the swing plane at each footfall, so a
  // stride runs out when either the knee or the shoulder does. Walking straight
  // ahead barely troubles the knee but swings the shoulder through its whole
  // range, so without this the fore/aft stride would be the one that clips.
  const perp = Math.sqrt(Math.max(0, nSq - p * p));
  if (perp > 1e-4) {
    const aim = Math.atan2(p, perp);
    const square = Math.PI / 2 - 1e-3;
    hi = Math.min(hi, perp * Math.tan(Math.min(square, aim + MAX_SWEEP)) - p);
    lo = Math.max(lo, perp * Math.tan(Math.max(-square, aim - MAX_SWEEP)) - p);
  }

  let lead = Math.max(leg.reachMax * 0.06, hi);
  let trail = Math.max(leg.reachMax * 0.06, -lo);
  // Cap the whole stride rather than each half, so a lopsided band keeps its
  // long side instead of being trimmed down to its short one.
  const cap = leg.reachMax * STRIDE;
  if (lead + trail > cap) {
    const scale = cap / (lead + trail);
    lead *= scale;
    trail *= scale;
  }
  return { lead, trail };
}

/**
 * Sustainable body speed: one stride per gait cycle, where a cycle is however
 * long it takes every leg to get a swing slot. More legs means a slower body,
 * and so does a direction the legs can only take short steps in.
 *
 * DUTY is the headroom. Spending the whole stride on the whole cycle is the
 * theoretical maximum, which leaves nothing for the swing a leg has already
 * begun or for the frame or two a step waits on a slot; at that speed a leg
 * that slips behind never catches up and gets dragged out of the arch.
 */
const DUTY = 0.7;

function bodySpeed(gait: WalkGait) {
  const slots = maxActiveSteps(gait.legs.length);
  const cycleMs = (Math.max(1, gait.legs.length) / slots) * STEP_DURATION_MS;
  const len = Math.hypot(gait.moveDir.x, gait.moveDir.z) || 1;
  let stride = Infinity;
  for (const leg of gait.legs) {
    const span = strideSpan(gait, leg, gait.moveDir.x / len, gait.moveDir.z / len);
    stride = Math.min(stride, span.lead + span.trail);
  }
  if (!Number.isFinite(stride)) stride = legReach(gait) * STRIDE;
  return (stride * DUTY) / (cycleMs / 1000);
}

/** Restate the debt as the ground still between the body and the drag goal. */
function oweDistanceToGoal(gait: WalkGait) {
  gait.chassis.getWorldPosition(_bodyNow);
  gait.pending.set(gait.goal.x - _bodyNow.x, 0, gait.goal.z - _bodyNow.z);
  setMoveDirection(gait, gait.pending.x, gait.pending.z);
}

/** Steer toward a ground point instead of teleporting the body to the cursor. */
export function setBodyGoal(gait: WalkGait, x: number, z: number) {
  gait.goal.set(x, 0, z);
  gait.goalActive = true;
  oweDistanceToGoal(gait);
}

/**
 * Pointer released: stop steering, but keep a short debt so the walk finishes
 * the stride it is in and squares its legs up rather than freezing mid-step.
 * The body is always somewhere behind the cursor, so without the leash it would
 * carry on walking the whole way there long after the drag ended.
 */
export function releaseBodyGoal(gait: WalkGait) {
  gait.goalActive = false;
  const leash = legReach(gait) * LEASH;
  const owed = Math.hypot(gait.pending.x, gait.pending.z);
  if (owed > leash && owed > 1e-8) {
    gait.pending.x *= leash / owed;
    gait.pending.z *= leash / owed;
  }
}

export function clearBodyDrag(gait: WalkGait) {
  gait.pending.set(0, 0, 0);
  gait.goalActive = false;
}

/** Drain the queued drag at walking speed so the gait always has time to step. */
export function advanceBody(gait: WalkGait, dtMs: number) {
  if (gait.goalActive) oweDistanceToGoal(gait);
  const owed = Math.hypot(gait.pending.x, gait.pending.z);
  if (owed < 1e-6) return false;
  const budget = bodySpeed(gait) * (Math.min(MAX_FRAME_MS, Math.max(0, dtMs)) / 1000);
  const scale = budget >= owed ? 1 : budget / owed;
  const dx = gait.pending.x * scale;
  const dz = gait.pending.z * scale;
  gait.pending.x -= dx;
  gait.pending.z -= dz;
  translateBody(gait, dx, dz);
  return true;
}

export function capturePlants(gait: WalkGait) {
  for (const leg of gait.legs) {
    if (leg.step) continue;
    leg.foot.getWorldPosition(leg.plant);
  }
}

function faceShoulder(leg: LegChain, target: Vector3) {
  const joint = getJoint(leg.shoulder);
  if (!joint) return;

  applyJointPose(leg.shoulder, joint, 0);
  hingeWorld(leg.upper, _hinge);
  const restHinge = Math.atan2(_hinge.x, _hinge.z);
  applyJointPose(leg.shoulder, joint, 0.12);
  hingeWorld(leg.upper, _hinge);
  const sign = wrapAngleDelta(Math.atan2(_hinge.x, _hinge.z) - restHinge) >= 0 ? 1 : -1;

  let pose = joint.pose;
  for (let i = 0; i < 3; i += 1) {
    applyJointPose(leg.shoulder, joint, pose);
    hingeWorld(leg.upper, _hinge);
    leg.upper.getWorldPosition(_hip);
    _offset.copy(target).sub(_hip);
    const ox = _offset.x;
    const oz = _offset.z;
    if (ox * ox + oz * oz < 1e-8) break;
    // The foot rides a fixed distance to one side of the hip, so the reachable
    // plane is offset from the hip rather than through it. Aiming the hinge dead
    // perpendicular therefore misses by that offset; open the angle to suit.
    const span = Math.hypot(ox, oz);
    const spread = Math.acos(Math.min(1, Math.max(-1, leg.sideOffset / span)));
    const toTarget = Math.atan2(ox, oz);
    const optionA = wrapAngleDelta(toTarget - spread);
    const optionB = wrapAngleDelta(toTarget + spread);
    const current = Math.atan2(_hinge.x, _hinge.z);
    const desired =
      Math.abs(wrapAngleDelta(optionA - current)) <= Math.abs(wrapAngleDelta(optionB - current))
        ? optionA
        : optionB;
    pose = sign * wrapAngleDelta(desired - restHinge);
  }
  applyJointPose(leg.shoulder, joint, pose);
}

function solveReach(leg: LegChain, target: Vector3, keepGround = false) {
  const upperJoint = getJoint(leg.upper);
  const lowerJoint = getJoint(leg.lower);
  const footJoint = getJoint(leg.foot);
  if (!upperJoint || !lowerJoint) return { stretched: false, folded: false };

  setRestPose(leg.upper, upperJoint);
  setRestPose(leg.lower, lowerJoint);
  hingeWorld(leg.upper, _hinge);
  leg.upper.getWorldPosition(_hip);
  _offset.copy(target).sub(_hip);
  if (!keepGround) _offset.projectOnPlane(_hinge);
  const reach = _offset.length();
  const stretched = reach > leg.reachMax * STRETCH_ALARM;
  const folded = reach < leg.reachMax * FOLD_ALARM;

  // Solve the triangle inside the arch band. A planted leg keeps aiming down the
  // true line to its plant, so an over-reach bends the knee further instead of
  // sliding or lifting the sole. A swinging foot has no plant to honour, so it
  // is held out past the folded zone and keeps its arch through the whole arc.
  const floor = keepGround ? leg.reachMin : leg.reachMax * FOLD;
  const d = Math.min(leg.reachMax, Math.max(floor, reach));
  if (d < 1e-5) return { stretched, folded };
  if (!keepGround) _offset.multiplyScalar(d / reach);

  const cosHip = (leg.upperLen * leg.upperLen + d * d - leg.lowerLen * leg.lowerLen) / (2 * leg.upperLen * d);
  const usedBend = Math.acos(Math.min(1, Math.max(-1, cosHip)));
  _toTarget.copy(_offset).normalize();
  _upperA.copy(_toTarget).applyAxisAngle(_hinge, usedBend);
  _upperB.copy(_toTarget).applyAxisAngle(_hinge, -usedBend);
  _kneeA.copy(_hip).addScaledVector(_upperA, leg.upperLen);
  _kneeB.copy(_hip).addScaledVector(_upperB, leg.upperLen);
  // Always take the knee-up solution. Which of the two the +/- bend produces
  // depends on the hinge direction, so remembering a side across frames lets the
  // arch invert when that flips; deciding from the geometry every time cannot.
  _upperDir.copy(_kneeA.y >= _kneeB.y ? _upperA : _upperB);

  boneVector(leg.upper, leg.lower, _restBone);
  poseToward(leg.upper, _restBone, _upperDir, _hinge);

  _to.copy(_hip).add(_offset);
  leg.lower.getWorldPosition(_knee);
  _toFoot.copy(_to).sub(_knee);
  setRestPose(leg.lower, lowerJoint);
  hingeWorld(leg.lower, _hinge);
  boneVector(leg.lower, leg.foot, _restBone);
  poseToward(leg.lower, _restBone, _toFoot, _hinge);

  if (footJoint) flattenFoot(leg.foot, footJoint);
  return { stretched, folded };
}

function landing(gait: WalkGait, leg: LegChain) {
  _dir.copy(gait.moveDir).setY(0);
  if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, 1);
  _dir.normalize();

  const reachMax = leg.reachMax;
  const span = strideSpan(gait, leg, _dir.x, _dir.z);
  const stride = span.lead + span.trail;

  // Lead the neutral point only as far as there is still travel to cover. While
  // cruising that is the full lead; as the drag runs out it fades to zero, so
  // the walker squares up on neutral instead of stopping mid-stride with its
  // legs left splayed.
  const owed = Math.hypot(gait.pending.x, gait.pending.z);
  const lead = span.lead * Math.min(1, owed / Math.max(1e-6, stride));

  // Aim at the leg's neutral stance point rather than at its last footfall.
  // Neutral travels with the body, so sideways error is zeroed on every step
  // instead of accumulating into a wandering leg.
  gait.chassis.getWorldPosition(_stance);
  _to.set(
    _stance.x + leg.restOffset.x + _dir.x * lead,
    leg.plant.y,
    _stance.z + leg.restOffset.z + _dir.z * lead,
  );

  leg.upper.getWorldPosition(_hip);
  _offset.set(_to.x - _hip.x, _to.y - _hip.y, _to.z - _hip.z);
  // Safety net only: the span already lands inside the arch, so this uses the
  // same far edge rather than a tighter one that would undo the lead.
  const comfortable = reachMax * STRETCH;
  if (_offset.length() > comfortable && _offset.length() > 1e-6) {
    _offset.multiplyScalar(comfortable / _offset.length());
    _to.set(_hip.x + _offset.x, leg.plant.y, _hip.z + _offset.z);
  }

  // Cap how far one step travels, scaling the whole step so the correction back
  // to neutral survives the clamp.
  _offset.set(_to.x - leg.plant.x, 0, _to.z - leg.plant.z);
  const along = _offset.dot(_dir);
  const maxAlong = reachMax * MAX_STEP;
  if (along > maxAlong) {
    _offset.multiplyScalar(maxAlong / along);
    _to.set(leg.plant.x + _offset.x, leg.plant.y, leg.plant.z + _offset.z);
  }

  return _to.clone();
}

type StepNeed = {
  leg: LegChain;
  stretched: boolean;
  folded: boolean;
  displaced: boolean;
  critical: boolean;
  /** Share of this leg's own travel budget already spent; 1 means out of room. */
  urgency: number;
};

/**
 * How badly a plant has left its neutral stance point. Trailing counts only when
 * the leg is behind neutral, but sideways error counts either way, since a step
 * always cancels it. Being ahead of neutral is left alone so a step can never
 * chase a leg further forward.
 */
function stanceError(gait: WalkGait, leg: LegChain) {
  _dir.copy(gait.moveDir).setY(0);
  if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, 1);
  _dir.normalize();
  gait.chassis.getWorldPosition(_from);
  const dx = _from.x + leg.restOffset.x - leg.plant.x;
  const dz = _from.z + leg.restOffset.z - leg.plant.z;
  _stanceErr.along = dx * _dir.x + dz * _dir.z;
  _stanceErr.sideways = Math.abs(dz * _dir.x - dx * _dir.z);
  return _stanceErr;
}

function reachNeed(gait: WalkGait, leg: LegChain, plant: Vector3): Omit<StepNeed, "leg"> {
  faceShoulder(leg, plant);
  leg.upper.getWorldPosition(_hip);
  const reach = _hip.distanceTo(plant);
  const frac = leg.reachMax > 1e-6 ? reach / leg.reachMax : 0;

  // Let a trailing leg ride out its whole trail before stepping, so the stride
  // is set by how far the leg can actually travel rather than by a fixed
  // trigger distance that would cut every step short. Sideways error still
  // trips on a small threshold, since none of it is ever useful.
  const err = stanceError(gait, leg);
  const span = strideSpan(gait, leg, _dir.x, _dir.z);
  const stretched = frac > STRETCH_ALARM;
  const folded = frac < FOLD_ALARM;

  // Measure need as a share of this leg's own budget. Legs on opposite sides of
  // the body get mirrored trails when walking sideways, so an absolute distance
  // would make the short-trailed leg look permanently the more desperate of the
  // two and let it take every swing slot while its partner is dragged flat.
  const urgency = Math.max(
    err.along / Math.max(1e-6, span.trail),
    err.sideways / (leg.reachMax * STEP_TRIGGER),
    stretched || folded ? 1 : 0,
  );
  return { stretched, folded, displaced: urgency > 0.9, critical: frac > CRITICAL, urgency };
}

function finishStep(leg: LegChain, now: number, landedAt: Vector3, target: Vector3) {
  const elapsed = leg.step ? Math.min(now - leg.step.start, leg.step.duration) : 0;
  leg.airMs += Math.max(0, elapsed);
  leg.plant.copy(landedAt);
  leg.plant.y = landedAt.y;
  leg.step = null;
  target.copy(leg.plant);
}

function beginStep(gait: WalkGait, leg: LegChain, now: number) {
  const active = gait.legs.filter((entry) => entry.step).length;
  if (leg.step || active >= maxActiveSteps(gait.legs.length)) return;
  const from = leg.plant.clone();
  const to = landing(gait, leg);
  if (from.distanceTo(to) < leg.reachMax * MIN_STEP * 0.5) return;
  to.y = from.y;
  leg.step = { from, to, start: now, duration: STEP_DURATION_MS };
}

function stepTarget(leg: LegChain, now: number, target: Vector3) {
  const step = leg.step;
  if (!step) return target.copy(leg.plant);
  const t = Math.min(1, Math.max(0, (now - step.start) / step.duration));
  target.lerpVectors(step.from, step.to, t);
  target.y = step.from.y + Math.sin(t * Math.PI) * leg.reachMax * STEP_HEIGHT;
  if (t >= 1) {
    target.copy(step.to);
    target.y = step.from.y;
    finishStep(leg, now, target, target);
  }
  return target;
}

function pickNextStepper(gait: WalkGait, needs: StepNeed[]) {
  const slots = maxActiveSteps(gait.legs.length) - gait.legs.filter((leg) => leg.step).length;
  if (slots <= 0) return null;
  const needy = needs.filter((need) => !need.leg.step && (need.stretched || need.folded || need.displaced));
  if (!needy.length) return null;
  const critical = needy.filter((need) => need.critical);
  const pool = critical.length ? critical : needy;
  // Whoever has least room left goes first, measured against its own budget so
  // the comparison is fair between legs with different amounts of room.
  pool.sort((a, b) => {
    if (a.critical !== b.critical) return a.critical ? -1 : 1;
    if (Math.abs(a.urgency - b.urgency) > 0.02) return b.urgency - a.urgency;
    if (a.leg.airMs !== b.leg.airMs) return a.leg.airMs - b.leg.airMs;
    return a.leg.id.localeCompare(b.leg.id);
  });
  return pool[0]?.leg ?? null;
}

function solvePlanted(gait: WalkGait, leg: LegChain, plant: Vector3) {
  const need = reachNeed(gait, leg, plant);
  solveReach(leg, plant, true);
  return need;
}

export function solveWalkGait(gait: WalkGait, now = performance.now()) {
  gait.root.updateMatrixWorld(true);
  const moving = gait.moved;
  gait.moved = false;
  const needs: StepNeed[] = [];
  for (const leg of gait.legs) {
    stepTarget(leg, now, _target);
    if (leg.step) {
      faceShoulder(leg, _target);
      solveReach(leg, _target);
      continue;
    }
    const need = solvePlanted(gait, leg, _target);
    needs.push({ leg, ...need });
  }
  if (!moving) return;
  const next = pickNextStepper(gait, needs);
  if (next) beginStep(gait, next, now);
}

export function gaitHasSteps(gait: WalkGait) {
  return gait.legs.some((leg) => leg.step);
}

export function gaitIsBusy(gait: WalkGait) {
  return gaitHasSteps(gait) || Math.hypot(gait.pending.x, gait.pending.z) > 1e-6;
}

export function setMoveDirection(gait: WalkGait, dx: number, dz: number) {
  if (dx * dx + dz * dz < 1e-10) return;
  gait.moveDir.set(dx, 0, dz);
}
