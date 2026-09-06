import { Box3, Vector3, type Camera } from "three";
import type { OrbitControlsImpl } from "./controls";
import { applyViewPreset, type FrameInfo } from "./cameraPose";

const _size = new Vector3();
const _center = new Vector3();

/**
 * Standard Three.js front view: camera on +Z looking toward -Z.
 * X points right, Y points up, Z points toward the viewer.
 * The XZ ground grid collapses to a single horizontal line.
 */
export function frameDefaultView(
  camera: Camera,
  controls: OrbitControlsImpl,
  box: Box3,
  viewWidth: number,
  viewHeight: number,
  padding = 1.35,
): FrameInfo {
  box.getSize(_size);
  box.getCenter(_center);

  const viewSize = Math.max(_size.x, _size.y, 1) * padding;
  const distance = Math.max(_size.z * 2, viewSize, 8);
  const frame: FrameInfo = {
    center: [_center.x, _center.y, _center.z],
    distance,
    zoom: Math.min(viewWidth, viewHeight) / viewSize,
  };

  applyViewPreset(camera, controls, "front", frame);
  return frame;
}
