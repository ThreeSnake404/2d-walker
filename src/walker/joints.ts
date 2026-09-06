import { Box3, Matrix4, Quaternion, Vector3, type Mesh, type MeshStandardMaterial, type Object3D } from "three";
import {
  isBackShoulderPart,
  isFootPart,
  isFrontShoulderPart,
  isHingePart,
  isLowerLegPart,
  isMovablePart,
  isShoulderPart,
  isUpperLegPart,
  type MovablePart,
} from "./parts";

export const SHOULDER_MIN_DEG = -44;
export const SHOULDER_MAX_DEG = 50;
/** Upper legs stop short of vertical so a leg can never stand straight up. */
export const HINGE_MIN_DEG = -10;
export const HINGE_MAX_DEG = 72;
/**
 * Knee interior angle is 180 - |lower leg pose|, so keeping the pose below -30
 * leaves at least a 30 degree bend: the lower leg never lines up with the upper.
 */
export const LOWER_LEG_MIN_DEG = -140;
export const LOWER_LEG_MAX_DEG = -30;
export const FOOT_MIN_DEG = -90;
export const FOOT_MAX_DEG = 90;
export const START_FRONT_SHOULDER_DEG = 40;
export const START_BACK_SHOULDER_DEG = -40;
export const START_UPPER_LEG_DEG = 40;
export const START_LOWER_LEG_DEG = -85;

const DEG = Math.PI / 180;
const _worldAxis = new Vector3();
const _localAxis = new Vector3();
const _limb = new Vector3();
const _joint = new Vector3();
const _child = new Vector3();
const _test = new Vector3();
const _q = new Quaternion();
const _parentInverse = new Matrix4();
const _box = new Box3();
const _size = new Vector3();
const _hingeWorld = new Vector3();
const _brickLocal = new Vector3();
const _brickWorld = new Vector3();
const _target = new Vector3();
const _projected = new Vector3();
const _cross = new Vector3();

export type JointBind = {
  part: MovablePart;
  restQuaternion: Quaternion;
  axisLocal: Vector3;
  min: number;
  max: number;
  pose: number;
};

function findNamed(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((child) => {
    if (child.name === name) found = child;
  });
  return found;
}

function limbDirection(object: Object3D, target: Vector3) {
  const child = object.children.find((entry) => !entry.userData.pickVolume);
  if (child) {
    object.getWorldPosition(_joint);
    child.getWorldPosition(_child);
    target.copy(_child).sub(_joint);
    if (target.lengthSq() > 1e-8) return target.normalize();
  }
  return target.set(1, 0, 0).transformDirection(object.matrixWorld).normalize();
}

function toParentLocalAxis(object: Object3D, worldAxis: Vector3, target: Vector3) {
  const parent = object.parent;
  if (!parent) return target.copy(worldAxis).normalize();
  parent.updateWorldMatrix(true, false);
  _parentInverse.copy(parent.matrixWorld).invert();
  return target.copy(worldAxis).transformDirection(_parentInverse).normalize();
}

export function bindJoints(root: Object3D) {
  root.updateMatrixWorld(true);
  const chassis = findNamed(root, "Chassis") ?? root;
  const chassisUp = new Vector3(0, 1, 0).transformDirection(chassis.matrixWorld).normalize();
  const chassisForward = new Vector3(0, 0, 1).transformDirection(chassis.matrixWorld).normalize();

  root.traverse((object) => {
    if (!isMovablePart(object.name)) return;
    const part = object.name;
    if (object === chassis) return;
    if (!isShoulderPart(part) && !isHingePart(part)) return;

    const restQuaternion = object.quaternion.clone();
    let min: number;
    let max: number;

    if (isShoulderPart(part)) {
      min = SHOULDER_MIN_DEG * DEG;
      max = SHOULDER_MAX_DEG * DEG;
      limbDirection(object, _limb).projectOnPlane(chassisUp);
      if (_limb.lengthSq() < 1e-8) _limb.set(1, 0, 0);
      _limb.normalize();
      _worldAxis.copy(chassisUp);
      _q.setFromAxisAngle(_worldAxis, 0.1);
      _test.copy(_limb).applyQuaternion(_q);
      if (_test.dot(chassisForward) < _limb.dot(chassisForward)) _worldAxis.negate();
      toParentLocalAxis(object, _worldAxis, _localAxis);
    } else {
      min = (isLowerLegPart(part) ? LOWER_LEG_MIN_DEG : isFootPart(part) ? FOOT_MIN_DEG : HINGE_MIN_DEG) * DEG;
      max = (isLowerLegPart(part) ? LOWER_LEG_MAX_DEG : isFootPart(part) ? FOOT_MAX_DEG : HINGE_MAX_DEG) * DEG;
      _worldAxis.copy(chassisForward);
      limbDirection(object, _limb);
      _q.setFromAxisAngle(_worldAxis, 0.1);
      _test.copy(_limb).applyQuaternion(_q);
      if (_test.dot(chassisUp) < _limb.dot(chassisUp)) _worldAxis.negate();
      toParentLocalAxis(object, _worldAxis, _localAxis);
    }

    object.userData.joint = {
      part,
      restQuaternion,
      axisLocal: _localAxis.clone(),
      min,
      max,
      pose: 0,
    } satisfies JointBind;
  });
}

export function getJoint(object: Object3D): JointBind | null {
  return (object.userData.joint as JointBind | undefined) ?? null;
}

export function applyJointPose(object: Object3D, joint: JointBind, pose: number) {
  joint.pose = Math.min(joint.max, Math.max(joint.min, pose));
  _q.setFromAxisAngle(joint.axisLocal, joint.pose);
  object.quaternion.copy(_q).multiply(joint.restQuaternion);
  object.updateMatrixWorld(true);
}

/**
 * Park a joint at its bind pose so bone directions can be measured.
 * Limits are ignored on purpose: pose 0 is the reference the solvers measure
 * against, and a range that excludes it must not shift that reference.
 */
export function setRestPose(object: Object3D, joint: JointBind) {
  joint.pose = 0;
  object.quaternion.copy(joint.restQuaternion);
  object.updateMatrixWorld(true);
}

export function applyStartPose(root: Object3D) {
  const joints: { object: Object3D; joint: JointBind }[] = [];
  root.traverse((object) => {
    const joint = getJoint(object);
    if (joint) joints.push({ object, joint });
  });

  for (const { object, joint } of joints) {
    if (isFrontShoulderPart(joint.part)) applyJointPose(object, joint, START_FRONT_SHOULDER_DEG * DEG);
    else if (isBackShoulderPart(joint.part)) applyJointPose(object, joint, START_BACK_SHOULDER_DEG * DEG);
  }
  for (const { object, joint } of joints) {
    if (isUpperLegPart(joint.part)) applyJointPose(object, joint, START_UPPER_LEG_DEG * DEG);
  }
  for (const { object, joint } of joints) {
    if (isLowerLegPart(joint.part)) applyJointPose(object, joint, START_LOWER_LEG_DEG * DEG);
  }
  for (const { object, joint } of joints) {
    if (isFootPart(joint.part)) flattenFoot(object, joint);
  }
}

function isGreyBrickMesh(mesh: Mesh) {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.some((material) => (material as MeshStandardMaterial).name === "Grey");
}

function brickThinLocalAxis(object: Object3D, target: Vector3) {
  _box.makeEmpty();
  object.updateWorldMatrix(true, true);
  _parentInverse.copy(object.matrixWorld).invert();
  object.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || mesh.userData.pickVolume || !isGreyBrickMesh(mesh)) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const geometryBox = mesh.geometry.boundingBox;
    if (!geometryBox) return;
    _box.union(geometryBox.clone().applyMatrix4(_parentInverse.clone().multiply(mesh.matrixWorld)));
  });
  if (_box.isEmpty()) return target.set(1, 0, 0);
  _box.getSize(_size);
  if (_size.x <= _size.y && _size.x <= _size.z) return target.set(1, 0, 0);
  if (_size.y <= _size.z) return target.set(0, 1, 0);
  return target.set(0, 0, 1);
}

export function flattenFoot(object: Object3D, joint: JointBind) {
  const parent = object.parent;
  if (parent) {
    _hingeWorld.copy(joint.axisLocal).transformDirection(parent.matrixWorld).normalize();
  } else {
    _hingeWorld.copy(joint.axisLocal).normalize();
  }

  let bestPose = 0;
  let bestAlign = -1;
  for (const upSign of [1, -1]) {
    setRestPose(object, joint);
    brickThinLocalAxis(object, _brickLocal);
    _brickWorld.copy(_brickLocal).transformDirection(object.matrixWorld);
    _target.set(0, upSign, 0);
    _limb.copy(_brickWorld).projectOnPlane(_hingeWorld);
    _projected.copy(_target).projectOnPlane(_hingeWorld);
    if (_limb.lengthSq() < 1e-8 || _projected.lengthSq() < 1e-8) continue;
    _limb.normalize();
    _projected.normalize();
    applyJointPose(
      object,
      joint,
      Math.atan2(_cross.crossVectors(_limb, _projected).dot(_hingeWorld), _limb.dot(_projected)),
    );
    const align = Math.abs(_brickWorld.copy(_brickLocal).transformDirection(object.matrixWorld).normalize().dot(_target));
    if (align > bestAlign) {
      bestAlign = align;
      bestPose = joint.pose;
    }
  }
  applyJointPose(object, joint, bestPose);
}

export function wrapAngleDelta(delta: number) {
  let value = delta;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}
