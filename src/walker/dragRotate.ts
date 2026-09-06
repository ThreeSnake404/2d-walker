import {
  Box3,
  BoxGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
  type Camera,
  type Object3D,
} from "three";
import { applyJointPose, getJoint, wrapAngleDelta } from "./joints";
import { findPartName, isSelectablePart, SELECTABLE_PARTS, type PartName } from "./parts";

const _viewDir = new Vector3();
const _screenX = new Vector3();
const _screenY = new Vector3();

const _raycaster = new Raycaster();
const _ndc = new Vector2();
const _plane = new Plane();
const _hit = new Vector3();
const _joint = new Vector3();
const _offset = new Vector3();
const _box = new Box3();
const _corner = new Vector3();
const _size = new Vector3();
const _center = new Vector3();
const _meshToPart = new Matrix4();
const _inversePart = new Matrix4();
const _axisRef = new Vector3();
const _groundUp = new Vector3(0, 1, 0);
const _camDir = new Vector3();
const _planePoint = new Vector3();
const _planeNormal = new Vector3();

/** Front-view limbs are only a few pixels tall; pad clicks in screen space. */
const PICK_PAD_PX = 24;
/** Local-space minimum so hit volumes stay clickable after Base's ~0.35 scale. */
const PICK_VOLUME_MIN = 2.2;

export type LimbDrag = {
  object: Object3D;
  startPose: number;
  startPointerAngle: number;
};

export type PickedLimb = {
  part: PartName;
  object: Object3D;
};

const PICK_OFFSETS: [number, number][] = [
  [0, 0],
  [-8, 0],
  [8, 0],
  [0, -8],
  [0, 8],
  [-8, -8],
  [8, -8],
  [-8, 8],
  [8, 8],
];

export function attachPickVolumes(root: Object3D) {
  if (root.userData.pickVolumesAttached) return;
  root.updateMatrixWorld(true);

  for (const name of SELECTABLE_PARTS) {
    const object = findNamedObject(root, name);
    if (!object) continue;

    _box.makeEmpty();
    object.updateWorldMatrix(true, true);
    _inversePart.copy(object.matrixWorld).invert();

    object.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh || mesh.userData.pickVolume || findPartName(mesh) !== name) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const geometryBox = mesh.geometry.boundingBox;
      if (!geometryBox) return;
      _meshToPart.copy(_inversePart).multiply(mesh.matrixWorld);
      _box.union(geometryBox.clone().applyMatrix4(_meshToPart));
    });

    if (_box.isEmpty()) continue;

    _box.getSize(_size);
    _box.getCenter(_center);
    const helper = new Mesh(
      new BoxGeometry(
        Math.max(_size.x, PICK_VOLUME_MIN),
        Math.max(_size.y, PICK_VOLUME_MIN),
        Math.max(_size.z, PICK_VOLUME_MIN),
      ),
      new MeshBasicMaterial({
        color: "#ffcc66",
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        visible: false,
      }),
    );
    helper.position.copy(_center);
    helper.userData.pickVolume = true;
    helper.name = `${name}Hit`;
    object.add(helper);
  }

  root.userData.pickVolumesAttached = true;
}

export function setPickVolumeHighlight(root: Object3D, selected: PartName | null) {
  root.traverse((child) => {
    if (!child.userData.pickVolume) return;
    const mesh = child as Mesh;
    const material = mesh.material as MeshBasicMaterial;
    const active = findPartName(mesh) === selected;
    material.visible = active;
  });
}

function findNamedObject(root: Object3D, name: PartName): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((child) => {
    if (child.name === name) found = child;
  });
  return found;
}

function partOwnBounds(object: Object3D, name: PartName, target: Box3) {
  target.makeEmpty();
  let found = false;
  object.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || mesh.userData.pickVolume || findPartName(mesh) !== name) return;
    target.expandByObject(mesh);
    found = true;
  });
  return found && !target.isEmpty();
}

function projectBoxToScreen(box: Box3, camera: Camera, element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < 8; i += 1) {
    _corner.set(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    ).project(camera);
    const x = (_corner.x * 0.5 + 0.5) * rect.width + rect.left;
    const y = (-_corner.y * 0.5 + 0.5) * rect.height + rect.top;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY, area: Math.max(maxX - minX, 1) * Math.max(maxY - minY, 1) };
}

function distanceToRect(x: number, y: number, minX: number, minY: number, maxX: number, maxY: number) {
  const dx = x < minX ? minX - x : x > maxX ? x - maxX : 0;
  const dy = y < minY ? minY - y : y > maxY ? y - maxY : 0;
  return Math.hypot(dx, dy);
}

function pickByRaycast(
  root: Object3D,
  camera: Camera,
  clientX: number,
  clientY: number,
  element: HTMLElement,
): PickedLimb | null {
  let best: { part: PartName; object: Object3D; distance: number } | null = null;

  for (const [dx, dy] of PICK_OFFSETS) {
    pointerToNdc(clientX + dx, clientY + dy, element);
    _raycaster.setFromCamera(_ndc, camera);
    for (const hit of _raycaster.intersectObject(root, true)) {
      const part = findPartName(hit.object);
      if (!part || !isSelectablePart(part)) continue;
      const object = findNamedObject(root, part);
      if (!object) continue;
      if (!best || hit.distance < best.distance) {
        best = { part, object, distance: hit.distance };
      }
    }
  }

  return best ? { part: best.part, object: best.object } : null;
}

export function pickMovablePart(
  root: Object3D,
  camera: Camera,
  clientX: number,
  clientY: number,
  element: HTMLElement,
  preferPart?: PartName | null,
): PickedLimb | null {
  if (preferPart) {
    const preferred = hitTestPart(root, camera, clientX, clientY, element, preferPart);
    if (preferred) return preferred;
  }

  const exact = pickByRaycast(root, camera, clientX, clientY, element);
  if (exact) return exact;

  let best: { part: PartName; object: Object3D; distance: number; area: number } | null = null;

  for (const name of SELECTABLE_PARTS) {
    const object = findNamedObject(root, name);
    if (!object || !object.visible || !partOwnBounds(object, name, _box)) continue;
    const bounds = projectBoxToScreen(_box, camera, element);
    if (!bounds) continue;
    const distance = distanceToRect(clientX, clientY, bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
    if (distance > PICK_PAD_PX) continue;
    if (
      !best ||
      distance < best.distance - 0.5 ||
      (Math.abs(distance - best.distance) <= 0.5 && bounds.area < best.area)
    ) {
      best = { part: name, object, distance, area: bounds.area };
    }
  }

  return best ? { part: best.part, object: best.object } : null;
}

function hitTestPart(
  root: Object3D,
  camera: Camera,
  clientX: number,
  clientY: number,
  element: HTMLElement,
  name: PartName,
): PickedLimb | null {
  const object = findNamedObject(root, name);
  if (!object) return null;

  for (const [dx, dy] of PICK_OFFSETS) {
    pointerToNdc(clientX + dx, clientY + dy, element);
    _raycaster.setFromCamera(_ndc, camera);
    for (const hit of _raycaster.intersectObject(object, true)) {
      if (findPartName(hit.object) === name) return { part: name, object };
    }
  }

  if (!partOwnBounds(object, name, _box)) return null;
  const bounds = projectBoxToScreen(_box, camera, element);
  if (!bounds) return null;
  if (distanceToRect(clientX, clientY, bounds.minX, bounds.minY, bounds.maxX, bounds.maxY) > PICK_PAD_PX) {
    return null;
  }
  return { part: name, object };
}

function pointerToNdc(clientX: number, clientY: number, element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
}

function intersectWalkPlane(camera: Camera, clientX: number, clientY: number, element: HTMLElement, joint: Vector3) {
  pointerToNdc(clientX, clientY, element);
  _raycaster.setFromCamera(_ndc, camera);
  _plane.setFromNormalAndCoplanarPoint(_viewDir, joint);
  if (!_raycaster.ray.intersectPlane(_plane, _hit)) return null;
  return _hit;
}

function angleAroundWalkAxis(point: Vector3, joint: Vector3) {
  _offset.copy(point).sub(joint).projectOnPlane(_viewDir);
  if (_offset.lengthSq() < 1e-8) return null;
  return Math.atan2(_offset.dot(_screenY), _offset.dot(_screenX));
}

function jointDragPlane(object: Object3D) {
  const joint = getJoint(object);
  if (!joint) return null;
  const parent = object.parent;
  if (parent) {
    _viewDir.copy(joint.axisLocal).transformDirection(parent.matrixWorld).normalize();
  } else {
    _viewDir.copy(joint.axisLocal).normalize();
  }
  _screenX.crossVectors(_viewDir, _axisRef.set(0, 1, 0));
  if (_screenX.lengthSq() < 1e-8) _screenX.crossVectors(_viewDir, _axisRef.set(1, 0, 0));
  _screenX.normalize();
  _screenY.crossVectors(_viewDir, _screenX).normalize();
  return joint;
}

export function intersectGroundPlane(
  camera: Camera,
  clientX: number,
  clientY: number,
  element: HTMLElement,
  height = 0,
) {
  pointerToNdc(clientX, clientY, element);
  _raycaster.setFromCamera(_ndc, camera);
  _plane.setFromNormalAndCoplanarPoint(_groundUp, _joint.set(0, height, 0));
  if (!_raycaster.ray.intersectPlane(_plane, _hit)) return null;
  return _hit;
}

export type WalkDragPlane = {
  point: Vector3;
  normal: Vector3;
};

export function walkDragPlane(camera: Camera, origin: Vector3): WalkDragPlane {
  camera.getWorldDirection(_camDir);
  if (_camDir.lengthSq() < 1e-8) _camDir.set(0, 0, -1);
  _camDir.normalize();
  return { point: origin.clone(), normal: _camDir.clone() };
}

/** Intersect the drag plane frozen at pointer-down, then keep only ZX. */
export function intersectWalkDrag(
  camera: Camera,
  clientX: number,
  clientY: number,
  element: HTMLElement,
  dragPlane: WalkDragPlane,
) {
  pointerToNdc(clientX, clientY, element);
  _raycaster.setFromCamera(_ndc, camera);
  _planePoint.copy(dragPlane.point);
  _planeNormal.copy(dragPlane.normal);
  _plane.setFromNormalAndCoplanarPoint(_planeNormal, _planePoint);
  if (!_raycaster.ray.intersectPlane(_plane, _hit)) return null;
  _hit.y = dragPlane.point.y;
  return _hit;
}

export function beginLimbDrag(
  object: Object3D,
  camera: Camera,
  clientX: number,
  clientY: number,
  element: HTMLElement,
): LimbDrag | null {
  const joint = jointDragPlane(object);
  if (!joint) return null;
  object.getWorldPosition(_joint);
  const hit = intersectWalkPlane(camera, clientX, clientY, element, _joint);
  if (!hit) return null;
  const startPointerAngle = angleAroundWalkAxis(hit, _joint);
  if (startPointerAngle === null) return null;
  return {
    object,
    startPose: joint.pose,
    startPointerAngle,
  };
}

export function updateLimbDrag(
  drag: LimbDrag,
  camera: Camera,
  clientX: number,
  clientY: number,
  element: HTMLElement,
) {
  const joint = jointDragPlane(drag.object);
  if (!joint) return;
  drag.object.getWorldPosition(_joint);
  const hit = intersectWalkPlane(camera, clientX, clientY, element, _joint);
  if (!hit) return;
  const angle = angleAroundWalkAxis(hit, _joint);
  if (angle === null) return;
  applyJointPose(drag.object, joint, drag.startPose + wrapAngleDelta(angle - drag.startPointerAngle));
}
