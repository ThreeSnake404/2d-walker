import {
  Box3,
  BoxGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Plane,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
  type Camera,
  type Object3D,
} from "three";
import { findPartName, isMovablePart, MOVABLE_PARTS, type PartName } from "./parts";

/** Fallback when the camera direction is unavailable. */
export const WALK_PLANE_NORMAL = new Vector3(0, 0, 1);

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
const _qAxis = new Quaternion();
const _qWorld = new Quaternion();
const _qParent = new Quaternion();

/** Front-view limbs are only a few pixels tall; pad clicks in screen space. */
const PICK_PAD_PX = 24;
/** Local-space minimum so hit volumes stay clickable after Base's ~0.35 scale. */
const PICK_VOLUME_MIN = 2.2;

export type LimbDrag = {
  object: Object3D;
  startQuaternion: Quaternion;
  startAngle: number;
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

  for (const name of MOVABLE_PARTS) {
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
      if (!part || !isMovablePart(part)) continue;
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

  for (const name of MOVABLE_PARTS) {
    const object = findNamedObject(root, name);
    if (!object || !partOwnBounds(object, name, _box)) continue;
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

function viewAxes(camera: Camera) {
  camera.getWorldDirection(_viewDir);
  if (_viewDir.lengthSq() < 1e-10) _viewDir.copy(WALK_PLANE_NORMAL);
  _viewDir.normalize();
  _screenX.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  _screenY.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
}

function intersectWalkPlane(camera: Camera, clientX: number, clientY: number, element: HTMLElement, joint: Vector3) {
  viewAxes(camera);
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

export function beginLimbDrag(
  object: Object3D,
  camera: Camera,
  clientX: number,
  clientY: number,
  element: HTMLElement,
): LimbDrag | null {
  object.getWorldPosition(_joint);
  const hit = intersectWalkPlane(camera, clientX, clientY, element, _joint);
  if (!hit) return null;
  const startAngle = angleAroundWalkAxis(hit, _joint) ?? 0;
  return {
    object,
    startQuaternion: object.quaternion.clone(),
    startAngle,
  };
}

export function updateLimbDrag(
  drag: LimbDrag,
  camera: Camera,
  clientX: number,
  clientY: number,
  element: HTMLElement,
) {
  drag.object.getWorldPosition(_joint);
  const hit = intersectWalkPlane(camera, clientX, clientY, element, _joint);
  if (!hit) return;
  const angle = angleAroundWalkAxis(hit, _joint);
  if (angle === null) return;

  const delta = angle - drag.startAngle;
  viewAxes(camera);
  applyWorldAxisRotation(drag.object, _viewDir, -delta, drag.startQuaternion);
}

function applyWorldAxisRotation(
  object: Object3D,
  axis: Vector3,
  angle: number,
  startLocal: Quaternion,
) {
  object.quaternion.copy(startLocal);
  object.updateMatrixWorld(true);
  object.getWorldQuaternion(_qWorld);
  _qAxis.setFromAxisAngle(axis, angle);
  _qWorld.premultiply(_qAxis);

  if (object.parent) {
    object.parent.getWorldQuaternion(_qParent);
    object.quaternion.copy(_qParent.invert().multiply(_qWorld));
  } else {
    object.quaternion.copy(_qWorld);
  }
  object.updateMatrixWorld(true);
}
