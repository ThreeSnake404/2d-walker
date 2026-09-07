import { Box3, Quaternion, Vector3, type Mesh, type Object3D } from "three";
import { applyJointPose, flattenFoot, getJoint, setRestPose, wrapAngleDelta } from "./joints";
import {
  ACTIVE_FOOT_PARTS,
  ACTIVE_LOWER_LEG_PARTS,
  ACTIVE_SHOULDER_PARTS,
  ACTIVE_UPPER_LEG_PARTS,
  MIDDLE_SHOULDER_PARTS,
} from "./parts";

/**
 * Working band, as a share of the arch-limited reach. Outside it the knee sinks
 * to hip level and the leg reads as flat rather than load-bearing, at both ends
 * and long before the joint limits would object, so a leg past either edge has
 * to step even though its pose is still legal.
 *
 * The far edge is the longest hip-to-foot span that still keeps the knee above
 * the hip. Crossing world-vertical is not part of that: the shank locks and
 * the other triangle solution flips the lower bone skyward.
 */
const STRETCH = 0.87;
/** Standing shanks sit about 9° off world-vertical. Stay outside a dead zone
 *  around that line so the solver never parks on it or tunnels through it. */
const MIN_OFF_VERTICAL = 14 * (Math.PI / 180);
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
/** Peak sole lift on a swing, as a share of reach. Too small and a yawed
 *  hinge plus the arch reject flattened the hop into a skate. */
const STEP_HEIGHT = 0.18;
/** How close a plant must sit to home before recover is done and the chassis
 *  may move again. Looser than this left a trailing foot when W was held. */
const RECOVER_HOME = 0.18;
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
const MAX_FRAME_MS = 64;
/**
 * How far a shoulder may yaw off its neutral aim over a stride. The joint
 * itself allows 44 degrees the tighter way, but a stride that spends the last
 * few degrees leaves the shoulder nothing for the yaw it also needs to cancel
 * sideways error, and a clipped shoulder aims the swing plane off the footfall
 * so the foot lands short and scuffs.
 */
const MAX_SWEEP = 40 * (Math.PI / 180);
/** Standing arch: hip-to-foot span, and how far the foot sits below the hip.
 *  38° / 0.72 parked the shank 9° off world-vertical — the L-pose the front
 *  legs then locked into. A flatter, slightly longer stand keeps ~20° of lean. */
const STAND_REACH = 0.78;
const STAND_TILT = 28 * (Math.PI / 180);
/**
 * How far a turning foot travels along the chassis before the body yaws.
 * Half that arc, at the stance radius, is the "half a step" the chassis then
 * rotates, so two pivots in a cycle cover about one step of heading.
 */
const TURN_STEP = 0.3;
const TURN_YAW_RATE = 0.7;

function maxActiveSteps(legCount: number) {
  return Math.max(1, Math.floor(legCount / 3) || 1);
}

/** Extra swing slot only while a plant is already past the hold radius, so
 *  two long legs can hop together instead of parking the chassis for two
 *  full step times after a turn. */
function stepSlots(gait: WalkGait) {
  const normal = maxActiveSteps(gait.legs.length);
  const travel = gait.pending.x * gait.pending.x + gait.pending.z * gait.pending.z;
  if (travel < 1e-8 || plantedTravelScale(gait, gait.pending.x, gait.pending.z) > 1e-4) {
    return normal;
  }
  chassisAxes(gait);
  const side = gait.pending.x * _right.x + gait.pending.z * _right.z;
  const along = gait.pending.x * _fwd.x + gait.pending.z * _fwd.z;
  // Crab-walk lives on the hold edge. A second airborne leg there is the
  // through-body snap; only double up when a forward/back park needs it.
  if (Math.abs(side) >= Math.abs(along)) return normal;
  return Math.min(2, Math.max(normal, gait.legs.length - 2));
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
const _fwd = new Vector3();
const _right = new Vector3();
const _yawAxis = new Vector3(0, 1, 0);
const _qYaw = new Quaternion();
const _restWorld = new Vector3();
const _pinWant = new Vector3();
const _stanceErr = { along: 0, sideways: 0 };
const _meshBox = new Box3();

type TurnStepSpec = { id: string; along: number };
type TurnHalf = { steps: TurnStepSpec[] };
type TurnCycle = {
  sign: number;
  half: number;
  stage: number;
  pivotLeft: number;
};

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
  /**
   * Neutral foot, in the chassis frame: x along right, z along forward.
   * World-space offsets were left behind when the body yawed, so after about a
   * half turn the hips had moved on and the "home" had not — stride collapsed
   * and a huge leftover drag sat in the queue.
   */
  restOffset: Vector3;
  /** Shoulder pose at the start stance — the outboard heading. Biasing toward
   *  pose 0 picked the through-chassis swing when crab-walking. */
  homePose: number;
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
  /** Chassis-local walk stick: +X is right, +Z is forward. */
  walkHeld: Vector3;
  walkDriving: boolean;
  /** Held turn: -1 clockwise from above, +1 counter-clockwise, 0 idle. */
  turnHeld: number;
  turn: TurnCycle | null;
  /**
   * After a turn the plants sit fore/aft of home. The first thing back to a
   * straight walk is a short step onto the start stance, so the shoulders can
   * point out from the chassis again before any new stride.
   */
  recovering: boolean;
};

function findNamed(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((child) => {
    if (child.name === name) found = child;
  });
  return found;
}

export function hideMiddleLegs(root: Object3D) {
  for (const name of MIDDLE_SHOULDER_PARTS) {
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

function restWorld(gait: WalkGait, leg: LegChain, target: Vector3) {
  chassisAxes(gait);
  gait.chassis.getWorldPosition(_stance);
  return target.set(
    _stance.x + _right.x * leg.restOffset.x + _fwd.x * leg.restOffset.z,
    0,
    _stance.z + _right.z * leg.restOffset.x + _fwd.z * leg.restOffset.z,
  );
}

function captureRest(gait: WalkGait, leg: LegChain, worldX: number, worldZ: number) {
  chassisAxes(gait);
  gait.chassis.getWorldPosition(_stance);
  const dx = worldX - _stance.x;
  const dz = worldZ - _stance.z;
  leg.restOffset.set(dx * _right.x + dz * _right.z, 0, dx * _fwd.x + dz * _fwd.z);
  const joint = getJoint(leg.shoulder);
  if (joint) leg.homePose = joint.pose;
}

/**
 * Keep a commanded foot on the outboard side of its hip. A sideways landing
 * on the far side of the chassis is what folded a leg under the body.
 */
function legalizeFootXZ(gait: WalkGait, leg: LegChain, point: Vector3) {
  restWorld(gait, leg, _restWorld);
  leg.upper.getWorldPosition(_spanHip);
  let ox = _restWorld.x - _spanHip.x;
  let oz = _restWorld.z - _spanHip.z;
  const home = Math.hypot(ox, oz);
  if (home < 1e-5) return point;
  ox /= home;
  oz /= home;
  const px = point.x - _spanHip.x;
  const pz = point.z - _spanHip.z;
  const along = px * ox + pz * oz;
  const perpx = px - along * ox;
  const perpz = pz - along * oz;
  const minOut = leg.reachMax * FOLD;
  const use = along < minOut ? minOut : along;
  point.x = _spanHip.x + ox * use + perpx;
  point.z = _spanHip.z + oz * use + perpz;
  const hx = point.x - _spanHip.x;
  const hz = point.z - _spanHip.z;
  const horiz = Math.hypot(hx, hz);
  const maxH = leg.reachMax * STRETCH;
  if (horiz > maxH && horiz > 1e-6) {
    point.x = _spanHip.x + hx * (maxH / horiz);
    point.z = _spanHip.z + hz * (maxH / horiz);
  }
  return point;
}

export function recaptureStance(gait: WalkGait) {
  for (const leg of gait.legs) {
    leg.foot.getWorldPosition(leg.plant);
    captureRest(gait, leg, leg.plant.x, leg.plant.z);
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
    // Keep the start yaw (front +40, back -40) so the corners already sit on a
    // diagonal. Squaring them here would spend the shoulder's range before the
    // first turn, which is the whole reason those four legs are showing.
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
  gait.recovering = false;
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
      restOffset: new Vector3(),
      homePose: 0,
      plant,
      airMs: 0,
      step: null,
    });
  }

  const gaitDraft = {
    root,
    chassis,
    legs,
    moveDir: new Vector3(0, 0, 1),
    moved: false,
    pending: new Vector3(),
    goal: new Vector3(),
    goalActive: false,
    walkHeld: new Vector3(),
    walkDriving: false,
    turnHeld: 0,
    turn: null,
    recovering: false,
  } as WalkGait;
  for (const leg of gaitDraft.legs) captureRest(gaitDraft, leg, leg.plant.x, leg.plant.z);
  return gaitDraft;
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
  holdPlantedFeet(gait);
  gait.moved = true;
}

function chassisAxes(gait: WalkGait) {
  gait.chassis.updateMatrixWorld(true);
  _fwd.set(0, 0, 1).transformDirection(gait.chassis.matrixWorld).setY(0);
  if (_fwd.lengthSq() < 1e-8) _fwd.set(0, 0, 1);
  _fwd.normalize();
  _right.set(1, 0, 0).transformDirection(gait.chassis.matrixWorld).setY(0);
  if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
  _right.normalize();
}

/**
 * Yaw the chassis on the spot. Shoulders are siblings of the body, not children,
 * so they have to orbit and yaw with it or the legs would be left behind.
 */
function rotateBody(gait: WalkGait, yaw: number) {
  if (Math.abs(yaw) < 1e-8) return;
  const cx = gait.chassis.position.x;
  const cz = gait.chassis.position.z;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  gait.chassis.rotateOnWorldAxis(_yawAxis, yaw);
  _qYaw.setFromAxisAngle(_yawAxis, yaw);
  for (const leg of gait.legs) {
    const dx = leg.shoulder.position.x - cx;
    const dz = leg.shoulder.position.z - cz;
    leg.shoulder.position.x = cx + dx * c + dz * s;
    leg.shoulder.position.z = cz - dx * s + dz * c;
    // IK rebuilds the shoulder from rest * pose every frame, so a world yaw on
    // the object itself is thrown away. Bake the heading into the rest pose
    // instead: pose 0 stays "square to the chassis", and the solver never has
    // to unwind a growing world-space error through the body.
    const joint = getJoint(leg.shoulder);
    if (joint) {
      joint.restQuaternion.premultiply(_qYaw);
      applyJointPose(leg.shoulder, joint, joint.pose);
    }
  }
  gait.root.updateMatrixWorld(true);
  holdPlantedFeet(gait);
  gait.moved = true;
}

/** Re-solve every planted sole back to its world plant after the hips moved. */
function holdPlantedFeet(gait: WalkGait) {
  for (const leg of gait.legs) {
    if (leg.step) continue;
    solvePinnedFoot(leg, leg.plant);
  }
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
  restWorld(gait, leg, _restWorld);
  const nx = _restWorld.x - _spanHip.x;
  const nz = _restWorld.z - _spanHip.z;
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
/** Trial multiplier on chassis speed. Step duration is unchanged, so this is
 *  how we find out whether the existing cycle can keep the feet under the body. */
const WALK_SPEED = 2;

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
  return (stride * DUTY * WALK_SPEED) / (cycleMs / 1000);
}

/** Restate the debt as the ground still between the body and the drag goal. */
function oweDistanceToGoal(gait: WalkGait) {
  gait.chassis.getWorldPosition(_bodyNow);
  gait.pending.set(gait.goal.x - _bodyNow.x, 0, gait.goal.z - _bodyNow.z);
  setMoveDirection(gait, gait.pending.x, gait.pending.z);
}

/** Steer toward a ground point instead of teleporting the body to the cursor. */
export function setBodyGoal(gait: WalkGait, x: number, z: number) {
  if (gait.recovering || gait.turn || gait.turnHeld) return;
  gait.goal.set(x, 0, z);
  gait.goalActive = true;
  oweDistanceToGoal(gait);
}

function stanceNeedsRecover(gait: WalkGait) {
  if (gaitHasSteps(gait)) return true;
  return gait.legs.some((leg) => plantAwayFromHome(gait, leg) > RECOVER_HOME);
}

/**
 * Park the chassis and step every foot back to the start stance. Walk and drag
 * stay queued as held intent; they do not drain until recover is finished.
 */
function startRecover(gait: WalkGait) {
  if (gait.turn || gait.turnHeld) return;
  clearBodyDrag(gait);
  if (!stanceNeedsRecover(gait)) return;
  gait.recovering = true;
}

/**
 * Pointer or key released: stop the chassis and square the feet. A leftover
 * leash would keep the body creeping and leave a trailing plant behind.
 */
export function releaseBodyGoal(gait: WalkGait) {
  gait.goalActive = false;
  if (gait.turn || gait.turnHeld) {
    gait.pending.set(0, 0, 0);
    gait.walkDriving = false;
    return;
  }
  startRecover(gait);
}

export function clearBodyDrag(gait: WalkGait) {
  gait.pending.set(0, 0, 0);
  gait.goalActive = false;
  gait.walkDriving = false;
}

export function setWalkHeld(gait: WalkGait, x: number, z: number) {
  gait.walkHeld.set(x, 0, z);
}

export function setTurnHeld(gait: WalkGait, sign: number) {
  gait.turnHeld = sign < 0 ? -1 : sign > 0 ? 1 : 0;
}

/**
 * Keyboard walk: keep a goal far along the held heading so the body does not
 * stop while the key is down, the same way a held drag keeps walking. WASD is
 * chassis-local, so W stays "forward" after a turn.
 */
function applyHeldWalk(gait: WalkGait) {
  if (gait.turn || gait.turnHeld || gait.recovering) {
    if (gait.walkDriving) {
      gait.walkDriving = false;
      gait.goalActive = false;
      gait.pending.set(0, 0, 0);
    }
    return;
  }
  const hx = gait.walkHeld.x;
  const hz = gait.walkHeld.z;
  if (hx * hx + hz * hz < 1e-8) {
    if (gait.walkDriving || Math.hypot(gait.pending.x, gait.pending.z) > 1e-6) {
      startRecover(gait);
    }
    return;
  }
  chassisAxes(gait);
  gait.chassis.getWorldPosition(_bodyNow);
  const reach = Math.max(4, legReach(gait) * 2);
  setBodyGoal(
    gait,
    _bodyNow.x + _right.x * hx * reach + _fwd.x * hz * reach,
    _bodyNow.z + _right.z * hx * reach + _fwd.z * hz * reach,
  );
  gait.walkDriving = true;
}

function findLeg(gait: WalkGait, id: string) {
  return gait.legs.find((leg) => leg.id === id) ?? null;
}

/**
 * One clockwise cycle from above, as two halves. Diagonally opposite corners
 * hold while the other pair steps one at a time, then every planted shoulder
 * yaws together and the chassis turns a half step.
 *
 * Clockwise:
 *   Right1+Left3 hold; Left1 forward, Right3 back; pivot;
 *   Left1+Right3 hold; Right1 back, Left3 forward; pivot.
 * Counter-clockwise reverses both the order and the step directions.
 */
function turnHalves(sign: number): TurnHalf[] {
  const cw: TurnHalf[] = [
    {
      steps: [
        { id: "Left1", along: 1 },
        { id: "Right3", along: -1 },
      ],
    },
    {
      steps: [
        { id: "Right1", along: -1 },
        { id: "Left3", along: 1 },
      ],
    },
  ];
  if (sign < 0) return cw;
  return [
    { steps: cw[1].steps.map((step) => ({ id: step.id, along: -step.along })).reverse() },
    { steps: cw[0].steps.map((step) => ({ id: step.id, along: -step.along })).reverse() },
  ];
}

function beginTurnStep(gait: WalkGait, spec: TurnStepSpec, now: number) {
  const leg = findLeg(gait, spec.id);
  if (!leg || leg.step) return;
  chassisAxes(gait);
  gait.chassis.getWorldPosition(_stance);
  const px = leg.plant.x - _stance.x;
  const pz = leg.plant.z - _stance.z;
  const before = px * _fwd.x + pz * _fwd.z;
  const angle = halfStepYaw(gait) * 2;
  // Orbit the plant around the body so the step cannot collapse when the foot
  // is already at the far edge of the arch. Pick the sign that moves the foot
  // forward or back along the chassis, which is what "step forward" means here.
  let bestX = leg.plant.x;
  let bestZ = leg.plant.z;
  let bestScore = -Infinity;
  for (const sign of [1, -1]) {
    const a = angle * sign;
    const ox = px * Math.cos(a) + pz * Math.sin(a);
    const oz = -px * Math.sin(a) + pz * Math.cos(a);
    const along = ox * _fwd.x + oz * _fwd.z - before;
    const score = along * spec.along;
    if (score > bestScore) {
      bestScore = score;
      bestX = _stance.x + ox;
      bestZ = _stance.z + oz;
    }
  }
  _to.set(bestX, leg.plant.y, bestZ);
  legalizeFootXZ(gait, leg, _to);
  const from = leg.plant.clone();
  // Always hop, even when the orbit is short. Skipping the step used to fall
  // straight through to the pivot, which then dragged that sole on the floor.
  leg.step = { from, to: _to.clone(), start: now, duration: STEP_DURATION_MS };
}

function stanceRadius(gait: WalkGait) {
  let radius = 0;
  for (const leg of gait.legs) radius += Math.hypot(leg.restOffset.x, leg.restOffset.z);
  return gait.legs.length ? radius / gait.legs.length : 1;
}

function halfStepYaw(gait: WalkGait) {
  const radius = Math.max(1, stanceRadius(gait));
  return Math.max(0.08, Math.min(0.28, (legReach(gait) * TURN_STEP * 0.5) / radius));
}

function plantAwayFromHome(gait: WalkGait, leg: LegChain) {
  restWorld(gait, leg, _restWorld);
  return Math.hypot(_restWorld.x - leg.plant.x, _restWorld.z - leg.plant.z);
}

/** Horizontal hip-to-plant, the same span `plantedTravelScale` refuses to grow. */
function hipPlantHoriz(leg: LegChain, plant: Vector3) {
  leg.upper.getWorldPosition(_hip);
  return Math.hypot(_hip.x - plant.x, _hip.z - plant.z);
}

function overHold(leg: LegChain, plant: Vector3 = leg.plant) {
  return hipPlantHoriz(leg, plant) > leg.reachMax * STRETCH;
}

function beginRecoverStep(gait: WalkGait, leg: LegChain, now: number) {
  if (leg.step) return false;
  restWorld(gait, leg, _restWorld);
  const from = leg.plant.clone();
  const to = _restWorld.clone();
  to.y = from.y;
  const span = from.distanceTo(to);
  if (span <= RECOVER_HOME) return false;
  // A recover is a short hop onto home, not a walking stride: cap the travel
  // so a badly parked foot takes two partials instead of one long lunge.
  const cap = Math.max(0.8, leg.reachMax * 0.4);
  if (span > cap) {
    to.sub(from).multiplyScalar(cap / span).add(from);
    to.y = from.y;
  }
  legalizeFootXZ(gait, leg, to);
  to.y = from.y;
  leg.step = { from, to, start: now, duration: STEP_DURATION_MS * 0.65 };
  return true;
}

function beginNextRecoverStep(gait: WalkGait, now: number) {
  if (gaitHasSteps(gait)) return;
  let next: LegChain | null = null;
  let worst = RECOVER_HOME;
  for (const leg of gait.legs) {
    const away = plantAwayFromHome(gait, leg);
    if (away > worst) {
      worst = away;
      next = leg;
    }
  }
  if (!next) {
    gait.recovering = false;
    return;
  }
  if (!beginRecoverStep(gait, next, now)) gait.recovering = false;
}

function finishTurn(gait: WalkGait) {
  gait.turn = null;
  startRecover(gait);
}

function advanceTurn(gait: WalkGait, dtMs: number, now: number) {
  if (gait.turnHeld && !gait.turn) {
    gait.recovering = false;
    clearBodyDrag(gait);
    gait.turn = { sign: gait.turnHeld, half: 0, stage: 0, pivotLeft: 0 };
  }
  if (!gait.turn) return false;
  if (gaitHasSteps(gait)) return true;

  const halves = turnHalves(gait.turn.sign);
  const half = halves[gait.turn.half];

  if (gait.turn.stage < half.steps.length) {
    beginTurnStep(gait, half.steps[gait.turn.stage], now);
    gait.turn.stage += 1;
    return true;
  }

  if (gait.turn.stage === half.steps.length) {
    gait.turn.pivotLeft = halfStepYaw(gait) * gait.turn.sign;
    gait.turn.stage += 1;
  }
  if (Math.abs(gait.turn.pivotLeft) > 1e-4) {
    const rate = TURN_YAW_RATE * (Math.min(MAX_FRAME_MS, Math.max(0, dtMs)) / 1000);
    const step = Math.max(-rate, Math.min(rate, gait.turn.pivotLeft));
    rotateBody(gait, step);
    gait.turn.pivotLeft -= step;
    return true;
  }

  if (gait.turnHeld === gait.turn.sign) {
    gait.turn.half = gait.turn.half === 0 ? 1 : 0;
    gait.turn.stage = 0;
    gait.turn.pivotLeft = 0;
  } else if (gait.turnHeld === 0) {
    finishTurn(gait);
  } else {
    gait.turn = { sign: gait.turnHeld, half: 0, stage: 0, pivotLeft: 0 };
  }
  return true;
}

export function applyHeldInputs(gait: WalkGait, dtMs: number, now: number) {
  applyHeldWalk(gait);
  advanceTurn(gait, dtMs, now);
}

/** Drain the queued drag at walking speed so the gait always has time to step. */
export function advanceBody(gait: WalkGait, dtMs: number) {
  if (gait.recovering || gait.turn) return false;
  if (gait.goalActive) oweDistanceToGoal(gait);
  const owed = Math.hypot(gait.pending.x, gait.pending.z);
  if (owed < 1e-6) return false;
  const budget = bodySpeed(gait) * (Math.min(MAX_FRAME_MS, Math.max(0, dtMs)) / 1000);
  const scale = budget >= owed ? 1 : budget / owed;
  let dx = gait.pending.x * scale;
  let dz = gait.pending.z * scale;
  const hold = plantedTravelScale(gait, dx, dz);
  dx *= hold;
  dz *= hold;
  if (hold < 0.999) gait.moved = true;
  if (Math.hypot(dx, dz) < 1e-8) return hold < 0.999;
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

function faceShoulder(leg: LegChain, target: Vector3, pin = false) {
  const joint = getJoint(leg.shoulder);
  if (!joint) return;

  const held = joint.pose;
  applyJointPose(leg.shoulder, joint, 0);
  hingeWorld(leg.upper, _hinge);
  const restHinge = Math.atan2(_hinge.x, _hinge.z);
  applyJointPose(leg.shoulder, joint, 0.12);
  hingeWorld(leg.upper, _hinge);
  const sign = wrapAngleDelta(Math.atan2(_hinge.x, _hinge.z) - restHinge) >= 0 ? 1 : -1;

  let pose = held;
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
    // Closer than the built-in side offset means the foot has crossed under the
    // hip. There is no legal swing plane through that point; keep the last pose
    // rather than snapping to the through-the-body heading.
    if (span < Math.abs(leg.sideOffset) + 0.05) break;
    const spread = Math.acos(Math.min(1, Math.max(-1, leg.sideOffset / span)));
    const toTarget = Math.atan2(ox, oz);
    const optionA = wrapAngleDelta(toTarget - spread);
    const optionB = wrapAngleDelta(toTarget + spread);
    const poseA = sign * wrapAngleDelta(optionA - restHinge);
    const poseB = sign * wrapAngleDelta(optionB - restHinge);
    // Two headings aim the hinge at the foot. One keeps the leg outboard; the
    // other is the same plane flipped through the chassis. Take the pose nearer
    // the current one, and refuse a jump past a right angle.
    const cost = (candidate: number) => {
      const jump = Math.abs(wrapAngleDelta(candidate - held));
      const clip = candidate < joint.min ? joint.min - candidate : candidate > joint.max ? candidate - joint.max : 0;
      const fromHome = Math.abs(wrapAngleDelta(candidate - leg.homePose));
      // Past the start-stance sweep the heading is the through-chassis fold.
      if (fromHome > MAX_SWEEP + 0.12) return 1e6;
      return jump + clip * 4 + fromHome * 0.45 + (jump > Math.PI * 0.5 ? 8 : 0);
    };
    const next = cost(poseA) <= cost(poseB) ? poseA : poseB;
    if (cost(next) >= 1e6) break;
    const jump = Math.abs(wrapAngleDelta(next - pose));
    if (!pin && jump > Math.PI * 0.5) break;
    pose = next;
  }
  applyJointPose(leg.shoulder, joint, pose);
}

/**
 * Reverse IK: the sole stays at `plant` in world space. Shoulder yaw only
 * exists here to keep that point in the swing plane; the foot itself does
 * not travel. Hip-relative "restore" is how trailing legs were skating out.
 */
function solvePinnedFoot(leg: LegChain, plant: Vector3) {
  const wantX = plant.x;
  const wantY = plant.y;
  const wantZ = plant.z;
  _pinWant.set(wantX, wantY, wantZ);
  let solved = { stretched: false, folded: false, illegal: false };
  // The chassis already moved the hip. Each pass must pull the sole the
  // rest of the way back to the same world point; stopping short is a drag.
  // Aim the shoulder at the real plant only. Chasing the overshoot target
  // wound the yaw a little more every frame until the hold radius ran out.
  for (let i = 0; i < 10; i += 1) {
    faceShoulder(leg, plant, true);
    solved = solveReach(leg, _pinWant, true);
    leg.foot.getWorldPosition(_from);
    const ex = wantX - _from.x;
    const ez = wantZ - _from.z;
    if (Math.hypot(ex, ez) < 0.02) return solved;
    _pinWant.set(wantX + ex, wantY, wantZ + ez);
  }
  leg.foot.getWorldPosition(_from);
  const slip = Math.hypot(_from.x - wantX, _from.z - wantZ);
  return { ...solved, stretched: slip > 0.05, illegal: slip > 0.05 };
}

/**
 * How far the chassis may still travel this frame before a planted sole
 * would be pulled off its world point. Zero means a step has to happen first.
 */
function plantedTravelScale(gait: WalkGait, dx: number, dz: number) {
  const travel = dx * dx + dz * dz;
  if (travel < 1e-12) return 1;
  let scale = 1;
  for (const leg of gait.legs) {
    if (leg.step) continue;
    leg.upper.getWorldPosition(_hip);
    const ox = _hip.x - leg.plant.x;
    const oz = _hip.z - leg.plant.z;
    const maxR = leg.reachMax * STRETCH;
    const a = travel;
    const b = 2 * (ox * dx + oz * dz);
    const c = ox * ox + oz * oz - maxR * maxR;
    if (c > 0) {
      // Already past the hold radius. Walking further away is a drag; the
      // chassis has to wait for a step. Closing the span is still legal, so a
      // turn that left one hip long does not zero every heading.
      if (b >= -1e-9) return 0;
      const sClose = Math.min(1, -b / a);
      if (sClose < scale) scale = Math.max(0, sClose);
      continue;
    }
    const disc = b * b - 4 * a * c;
    if (disc < 0) continue;
    const sMax = (-b + Math.sqrt(disc)) / (2 * a);
    if (sMax < scale) scale = Math.max(0, sMax);
  }
  return scale;
}

/**
 * Rank a two-bone solution. The shank must point down and stay off world
 * vertical: at the line itself the Jacobian dies, and a hair past it the other
 * triangle answer is the inverted lower-leg the front pair was locking into.
 */
function stepClearance(leg: LegChain) {
  return Math.max(1.15, leg.reachMax * STEP_HEIGHT);
}

function scoreArch(upperDir: Vector3, knee: Vector3, target: Vector3) {
  _toFoot.copy(target).sub(knee);
  const len = _toFoot.length();
  if (len < 1e-6) return Number.NEGATIVE_INFINITY;
  const lowerY = _toFoot.y / len;
  const fromVert = Math.acos(Math.min(1, Math.abs(lowerY)));
  if (lowerY >= 0) return -1e6 + fromVert;
  if (fromVert < MIN_OFF_VERTICAL) return -1e5 + fromVert;
  if (upperDir.y > 0.25) return -1e4 - upperDir.y;
  if (knee.y < _hip.y - 0.02) return -2e6 + (knee.y - _hip.y);
  return knee.y - _hip.y + fromVert;
}

function solveReach(leg: LegChain, target: Vector3, keepGround = false) {
  const upperJoint = getJoint(leg.upper);
  const lowerJoint = getJoint(leg.lower);
  const footJoint = getJoint(leg.foot);
  if (!upperJoint || !lowerJoint) return { stretched: false, folded: false, illegal: false };

  const upperHeld = upperJoint.pose;
  const lowerHeld = lowerJoint.pose;
  const footHeld = footJoint?.pose ?? 0;

  setRestPose(leg.upper, upperJoint);
  setRestPose(leg.lower, lowerJoint);
  hingeWorld(leg.upper, _hinge);
  leg.upper.getWorldPosition(_hip);
  const wantY = target.y;
  _offset.copy(target).sub(_hip);
  if (!keepGround) {
    _offset.projectOnPlane(_hinge);
    // A shoulder that has yawed can stand the hinge up. Projecting onto that
    // plane throws away world-Y, so the swing target collapses onto the floor
    // and the foot skates. Put the arc height back after the aim is planar.
    _offset.y = wantY - _hip.y;
  }
  const reach = _offset.length();
  const stretched = reach > leg.reachMax * STRETCH_ALARM;
  const folded = reach < leg.reachMax * FOLD_ALARM;

  // Solve the triangle inside the arch band. A planted leg keeps aiming down the
  // true line to its plant, so an over-reach bends the knee further instead of
  // sliding or lifting the sole. A swinging foot has no plant to honour, so it
  // is held out past the folded zone and keeps its arch through the whole arc.
  const floor = keepGround ? leg.reachMin : leg.reachMax * FOLD;
  const d = Math.min(leg.reachMax, Math.max(floor, reach));
  if (d < 1e-5) return { stretched, folded, illegal: false };
  if (!keepGround) {
    _offset.multiplyScalar(d / reach);
    _offset.y = wantY - _hip.y;
  }

  const cosHip = (leg.upperLen * leg.upperLen + d * d - leg.lowerLen * leg.lowerLen) / (2 * leg.upperLen * d);
  const usedBend = Math.acos(Math.min(1, Math.max(-1, cosHip)));
  _toTarget.copy(_offset).normalize();
  _upperA.copy(_toTarget).applyAxisAngle(_hinge, usedBend);
  _upperB.copy(_toTarget).applyAxisAngle(_hinge, -usedBend);
  _kneeA.copy(_hip).addScaledVector(_upperA, leg.upperLen);
  _kneeB.copy(_hip).addScaledVector(_upperB, leg.upperLen);
  _to.copy(_hip).add(_offset);
  const scoreA = scoreArch(_upperA, _kneeA, _to);
  const scoreB = scoreArch(_upperB, _kneeB, _to);
  if (Math.max(scoreA, scoreB) < 0) {
    applyJointPose(leg.upper, upperJoint, upperHeld);
    applyJointPose(leg.lower, lowerJoint, lowerHeld);
    if (footJoint) applyJointPose(leg.foot, footJoint, footHeld);
    return { stretched, folded, illegal: true };
  }
  _upperDir.copy(scoreA >= scoreB ? _upperA : _upperB);

  boneVector(leg.upper, leg.lower, _restBone);
  poseToward(leg.upper, _restBone, _upperDir, _hinge);

  leg.lower.getWorldPosition(_knee);
  _toFoot.copy(_to).sub(_knee);
  setRestPose(leg.lower, lowerJoint);
  hingeWorld(leg.lower, _hinge);
  boneVector(leg.lower, leg.foot, _restBone);
  poseToward(leg.lower, _restBone, _toFoot, _hinge);

  if (footJoint) flattenFoot(leg.foot, footJoint);

  let illegal = keepGround && scoreA < 0 && scoreB < 0;
  if (keepGround) {
    boneVector(leg.lower, leg.foot, _toFoot);
    if (_toFoot.lengthSq() > 1e-8) {
      _toFoot.normalize();
      const fromVert = Math.acos(Math.min(1, Math.abs(_toFoot.y)));
      if (_toFoot.y >= 0 || fromVert < MIN_OFF_VERTICAL) illegal = true;
    }
  }
  return { stretched, folded, illegal };
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
  restWorld(gait, leg, _restWorld);
  _to.set(
    _restWorld.x + _dir.x * lead,
    leg.plant.y,
    _restWorld.z + _dir.z * lead,
  );

  leg.upper.getWorldPosition(_hip);
  _offset.set(_to.x - _hip.x, _to.y - _hip.y, _to.z - _hip.z);
  // Safety net only: the span already lands inside the arch, so this uses the
  // same far edge rather than a tighter one that would undo the lead. Skip it
  // when the current plant is already past that edge — collapsing the target
  // onto the hip sphere then lands a few centimeters away, beginStep refuses
  // the "short" hop, and the chassis stays locked.
  const comfortable = reachMax * STRETCH;
  const plantHoriz = Math.hypot(leg.plant.x - _hip.x, leg.plant.z - _hip.z);
  if (_offset.length() > comfortable && plantHoriz < comfortable - 1e-3 && _offset.length() > 1e-6) {
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

  legalizeFootXZ(gait, leg, _to);
  _to.y = leg.plant.y;
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
  restWorld(gait, leg, _restWorld);
  const dx = _restWorld.x - leg.plant.x;
  const dz = _restWorld.z - leg.plant.z;
  _stanceErr.along = dx * _dir.x + dz * _dir.z;
  _stanceErr.sideways = Math.abs(dz * _dir.x - dx * _dir.z);
  return _stanceErr;
}

function reachNeed(gait: WalkGait, leg: LegChain, plant: Vector3): Omit<StepNeed, "leg"> {
  // A planted shoulder must not yaw: that sweeps the sole sideways on the
  // floor. Aiming is for an airborne swing only.
  leg.upper.getWorldPosition(_hip);
  const reach = _hip.distanceTo(plant);
  const frac = leg.reachMax > 1e-6 ? reach / leg.reachMax : 0;
  hingeWorld(leg.upper, _hinge);
  const offPlane = Math.abs(_offset.copy(plant).sub(_hip).dot(_hinge));
  const planeSlip = offPlane > 0.4;

  // Let a trailing leg ride out its whole trail before stepping, so the stride
  // is set by how far the leg can actually travel rather than by a fixed
  // trigger distance that would cut every step short. Sideways error still
  // trips on a small threshold, since none of it is ever useful.
  const err = stanceError(gait, leg);
  const span = strideSpan(gait, leg, _dir.x, _dir.z);
  const away = plantAwayFromHome(gait, leg);
  const starved = away > leg.reachMax * 0.85;
  const stretched = frac > STRETCH_ALARM || overHold(leg, plant);
  const folded = frac < FOLD_ALARM;

  // Measure need as a share of this leg's own budget. Legs on opposite sides of
  // the body get mirrored trails when walking sideways, so an absolute distance
  // would make the short-trailed leg look permanently the more desperate of the
  // two and let it take every swing slot while its partner is dragged flat.
  const urgency = Math.max(
    err.along / Math.max(1e-6, span.trail),
    err.sideways / (leg.reachMax * STEP_TRIGGER),
    stretched || folded || planeSlip || starved ? 1 : 0,
  );
  return {
    stretched,
    folded,
    displaced: urgency > 0.9 || planeSlip || overHold(leg, plant) || starved,
    critical: frac > CRITICAL || planeSlip || overHold(leg, plant) || starved,
    urgency,
  };
}

function finishStep(leg: LegChain, now: number, landedAt: Vector3, target: Vector3) {
  const elapsed = leg.step ? Math.min(now - leg.step.start, leg.step.duration) : 0;
  leg.airMs += Math.max(0, elapsed);
  leg.plant.copy(landedAt);
  leg.plant.y = landedAt.y;
  leg.step = null;
  target.copy(leg.plant);
}

function anyOverHold(gait: WalkGait) {
  return gait.legs.some((leg) => !leg.step && overHold(leg));
}

function beginStep(gait: WalkGait, leg: LegChain, now: number) {
  const active = gait.legs.filter((entry) => entry.step).length;
  if (leg.step || active >= stepSlots(gait)) return;
  const from = leg.plant.clone();
  const to = landing(gait, leg);
  const minSpan = leg.reachMax * MIN_STEP * 0.5;
  if (from.distanceTo(to) < minSpan) {
    // After a turn, strideSpan often collapses. Refusing that hop freezes W
    // once any planted hip is past the hold radius — sometimes a few metres
    // later, once leftover yaw has used the last of the band.
    if (!overHold(leg) && !anyOverHold(gait)) return;
    restWorld(gait, leg, _restWorld);
    _dir.copy(gait.moveDir).setY(0);
    if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, 1);
    _dir.normalize();
    const lead = Math.max(minSpan, strideSpan(gait, leg, _dir.x, _dir.z).lead);
    to.set(_restWorld.x + _dir.x * lead, from.y, _restWorld.z + _dir.z * lead);
    if (from.distanceTo(to) < 0.05) {
      to.copy(_restWorld);
      to.y = from.y;
    }
  }
  to.y = from.y;
  legalizeFootXZ(gait, leg, to);
  to.y = from.y;
  leg.step = { from, to, start: now, duration: STEP_DURATION_MS };
}

/**
 * Up, over, down. Horizontal travel only while the sole is clear of the
 * floor — otherwise a shoulder yaw or a recover hop skates the foot.
 */
function swingPhase(t: number) {
  const lift = Math.sin(Math.min(1, Math.max(0, t)) * Math.PI);
  let along = 0;
  if (t >= 0.82) along = 1;
  else if (t > 0.18) along = (t - 0.18) / 0.64;
  return { lift, along };
}

function stepTarget(gait: WalkGait, leg: LegChain, now: number, target: Vector3) {
  const step = leg.step;
  if (!step) return target.copy(leg.plant);
  const t = Math.min(1, Math.max(0, (now - step.start) / step.duration));
  const { lift, along } = swingPhase(t);
  target.lerpVectors(step.from, step.to, along);
  const hoist = step.from.y + lift * stepClearance(leg);
  legalizeFootXZ(gait, leg, target);
  target.y = hoist;
  if (t >= 1) {
    target.copy(step.to);
    target.y = step.from.y;
    finishStep(leg, now, target, target);
  }
  return target;
}

function solvePlanted(gait: WalkGait, leg: LegChain, plant: Vector3) {
  const solved = solvePinnedFoot(leg, plant);
  const need = reachNeed(gait, leg, plant);
  if (!solved.illegal) return need;
  return { ...need, stretched: true, critical: true, urgency: 1 };
}

export function solveWalkGait(gait: WalkGait, now = performance.now()) {
  gait.root.updateMatrixWorld(true);
  const moving = gait.moved;
  gait.moved = false;
  const needs: StepNeed[] = [];
  for (const leg of gait.legs) {
    stepTarget(gait, leg, now, _target);
    if (leg.step) {
      // Yaw only while the sole is off the floor. Waiting for XZ travel meant
      // an in-place recover hop never squared the shoulder, so the hip stayed
      // past the hold radius and the next walk locked.
      const airborne = _target.y - leg.step.from.y > 0.12;
      if (airborne) faceShoulder(leg, _target, gait.recovering);
      solveReach(leg, _target);
      continue;
    }
    const need = solvePlanted(gait, leg, _target);
    needs.push({ leg, ...need });
  }
  if (gait.turn) return;
  if (gait.recovering) {
    if (!gaitHasSteps(gait)) beginNextRecoverStep(gait, now);
    return;
  }
  const locked = anyOverHold(gait);
  const mustStep = locked || needs.some((need) => need.critical);
  if (!moving && !mustStep) return;
  const queue = needs.filter((need) => !need.leg.step && (need.stretched || need.folded || need.displaced || locked));
  queue.sort((a, b) => {
    const aHold = overHold(a.leg) ? 1 : 0;
    const bHold = overHold(b.leg) ? 1 : 0;
    if (aHold !== bHold) return bHold - aHold;
    if (a.critical !== b.critical) return a.critical ? -1 : 1;
    if (Math.abs(a.urgency - b.urgency) > 0.02) return b.urgency - a.urgency;
    if (a.leg.airMs !== b.leg.airMs) return a.leg.airMs - b.leg.airMs;
    return a.leg.id.localeCompare(b.leg.id);
  });
  for (const need of queue) beginStep(gait, need.leg, now);
}

export function gaitHasSteps(gait: WalkGait) {
  return gait.legs.some((leg) => leg.step);
}

export function gaitIsBusy(gait: WalkGait) {
  return (
    !!gait.turn ||
    gait.turnHeld !== 0 ||
    gait.recovering ||
    gait.walkDriving ||
    gait.walkHeld.lengthSq() > 1e-8 ||
    gaitHasSteps(gait) ||
    Math.hypot(gait.pending.x, gait.pending.z) > 1e-6
  );
}

export function setMoveDirection(gait: WalkGait, dx: number, dz: number) {
  if (dx * dx + dz * dz < 1e-10) return;
  gait.moveDir.set(dx, 0, dz);
}
