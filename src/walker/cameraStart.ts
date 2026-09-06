import type { Camera, OrthographicCamera } from "three";
import type { OrbitControlsImpl } from "./controls";
import { snapLookAt } from "./cameraPose";

export const CAMERA_STORAGE_KEY = "walker-camera-start-v2";

export type CameraStart = {
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
  up: [number, number, number];
};

export function isCameraStart(value: unknown): value is CameraStart {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.position) &&
    record.position.length === 3 &&
    record.position.every((n) => typeof n === "number") &&
    Array.isArray(record.target) &&
    record.target.length === 3 &&
    record.target.every((n) => typeof n === "number") &&
    Array.isArray(record.up) &&
    record.up.length === 3 &&
    record.up.every((n) => typeof n === "number") &&
    typeof record.zoom === "number" &&
    Number.isFinite(record.zoom)
  );
}

export function readStoredCameraStart(): CameraStart | null {
  try {
    const raw = localStorage.getItem(CAMERA_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isCameraStart(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function fetchCameraStart(url: string): Promise<CameraStart | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json") && !contentType.includes("text/json")) {
      return null;
    }
    const parsed = (await response.json()) as unknown;
    return isCameraStart(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function loadCameraStart(): Promise<CameraStart | null> {
  return (await fetchCameraStart("/api/camera-start")) ?? readStoredCameraStart();
}

export async function saveCameraStart(cameraStart: CameraStart): Promise<{ savedToFile: boolean }> {
  localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(cameraStart));

  try {
    const response = await fetch("/api/camera-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cameraStart),
    });
    if (!response.ok) return { savedToFile: false };
    return { savedToFile: true };
  } catch {
    return { savedToFile: false };
  }
}

export function captureCameraStart(
  camera: Camera,
  controls: OrbitControlsImpl,
): CameraStart {
  return {
    position: camera.position.toArray() as [number, number, number],
    target: controls.target.toArray() as [number, number, number],
    zoom: (camera as OrthographicCamera).zoom ?? 1,
    up: camera.up.toArray() as [number, number, number],
  };
}

export function applyCameraStart(
  camera: Camera,
  controls: OrbitControlsImpl,
  cameraStart: CameraStart,
) {
  const ortho = camera as OrthographicCamera;
  if (ortho.isOrthographicCamera) {
    ortho.zoom = cameraStart.zoom;
    ortho.updateProjectionMatrix();
  }
  snapLookAt(camera, controls, cameraStart.position, cameraStart.up, cameraStart.target);
}
