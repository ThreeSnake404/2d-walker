import { Euler, Vector3, type Camera, type OrthographicCamera } from "three";
import type { OrbitControlsImpl } from "./controls";

export const EULER_ORDER = "XYZ";

export type CameraPose = {
  x: number;
  y: number;
  z: number;
};

export type ViewPreset = "front" | "top" | "right";

export type FrameInfo = {
  center: [number, number, number];
  distance: number;
  zoom: number;
};

export const VIEW_PRESETS: Record<ViewPreset, CameraPose> = {
  front: { x: 0, y: 0, z: 0 },
  top: { x: -90, y: 0, z: 0 },
  right: { x: 0, y: 90, z: 0 },
};

const _offset = new Vector3();
const _position = new Vector3();
const _target = new Vector3();
const _up = new Vector3();
const _euler = new Euler();

function degToRad(degrees: number) {
  return (degrees * Math.PI) / 180;
}

function radToDeg(radians: number) {
  return (radians * 180) / Math.PI;
}

export function wrapDegrees(value: number) {
  const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
  return Math.round(wrapped * 10) / 10;
}

function setCameraZoom(camera: Camera, zoom: number) {
  const ortho = camera as OrthographicCamera;
  if (!ortho.isOrthographicCamera) return;
  ortho.zoom = zoom;
  ortho.updateProjectionMatrix();
}

export function poseFromCamera(camera: Camera): CameraPose {
  _euler.setFromQuaternion(camera.quaternion, EULER_ORDER);
  return {
    x: wrapDegrees(radToDeg(_euler.x)),
    y: wrapDegrees(radToDeg(_euler.y)),
    z: wrapDegrees(radToDeg(_euler.z)),
  };
}

function snapCamera(
  camera: Camera,
  controls: OrbitControlsImpl,
  position: Vector3,
  up: Vector3,
  target: Vector3,
) {
  const wasDamping = controls.enableDamping;
  controls.enableDamping = false;
  controls.target.copy(target);
  camera.up.copy(up);
  camera.position.copy(position);
  camera.lookAt(target);
  controls.update();
  controls.target.copy(target);
  camera.up.copy(up);
  camera.position.copy(position);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  controls.update();
  camera.up.copy(up);
  camera.position.copy(position);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  controls.enableDamping = wasDamping;
}

export function applyCameraPose(
  camera: Camera,
  controls: OrbitControlsImpl,
  pose: CameraPose,
  frame?: Partial<FrameInfo>,
) {
  const distance = frame?.distance ?? Math.max(camera.position.distanceTo(controls.target), 1);

  if (frame?.center) controls.target.fromArray(frame.center);
  if (frame?.zoom != null) setCameraZoom(camera, frame.zoom);

  _target.copy(controls.target);
  _euler.set(degToRad(pose.x), degToRad(pose.y), degToRad(pose.z), EULER_ORDER);
  _offset.set(0, 0, distance).applyEuler(_euler);
  _position.copy(_target).add(_offset);
  _up.set(0, 1, 0).applyEuler(_euler).normalize();
  snapCamera(camera, controls, _position, _up, _target);
  camera.quaternion.setFromEuler(_euler);
  camera.updateMatrixWorld();
}

export function snapLookAt(
  camera: Camera,
  controls: OrbitControlsImpl,
  position: [number, number, number],
  up: [number, number, number],
  target: [number, number, number],
) {
  _position.fromArray(position);
  _up.fromArray(up);
  if (_up.lengthSq() < 1e-8) _up.set(0, 1, 0);
  _target.fromArray(target);
  snapCamera(camera, controls, _position, _up, _target);
}

export function applyViewPreset(
  camera: Camera,
  controls: OrbitControlsImpl,
  preset: ViewPreset,
  frame: FrameInfo,
) {
  _target.fromArray(frame.center);
  setCameraZoom(camera, frame.zoom);

  if (preset === "front") {
    _position.set(_target.x, _target.y, _target.z + frame.distance);
    _up.set(0, 1, 0);
  } else if (preset === "top") {
    _position.set(_target.x, _target.y + frame.distance, _target.z);
    _up.set(0, 0, -1);
  } else {
    _position.set(_target.x + frame.distance, _target.y, _target.z);
    _up.set(0, 1, 0);
  }

  snapCamera(camera, controls, _position, _up, _target);
  const pose = VIEW_PRESETS[preset];
  camera.quaternion.setFromEuler(_euler.set(degToRad(pose.x), degToRad(pose.y), degToRad(pose.z), EULER_ORDER));
  camera.updateMatrixWorld();
}
