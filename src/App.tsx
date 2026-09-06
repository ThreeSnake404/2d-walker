import { useCallback, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import type { Camera } from "three";
import type { OrbitControlsImpl } from "./walker/controls";
import { CameraPoseControls } from "./components/CameraPoseControls";
import { WalkerScene } from "./components/WalkerScene";
import {
  applyCameraStart,
  captureCameraStart,
  loadCameraStart,
  readStoredCameraStart,
  saveCameraStart,
} from "./walker/cameraStart";
import {
  applyCameraPose,
  applyViewPreset,
  poseFromCamera,
  VIEW_PRESETS,
  type CameraPose,
  type FrameInfo,
  type ViewPreset,
} from "./walker/cameraPose";
import type { PartName } from "./walker/parts";
import "./App.css";

export default function App() {
  const cameraRef = useRef<Camera | null>(null);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const frameRef = useRef<FrameInfo | null>(null);
  const poseRef = useRef<CameraPose>({ x: 0, y: 0, z: 0 });
  const [cameraPose, setCameraPose] = useState<CameraPose>({ x: 0, y: 0, z: 0 });
  const [orthographic, setOrthographic] = useState(true);
  const [selectedPart, setSelectedPart] = useState<PartName | null>(null);
  const [saveStatus, setSaveStatus] = useState("Save this view as the next startup orientation.");

  const syncPose = useCallback((camera: Camera) => {
    const pose = poseFromCamera(camera);
    poseRef.current = pose;
    setCameraPose(pose);
  }, []);

  const handleReady = useCallback(
    (camera: Camera, controls: OrbitControlsImpl, frame: FrameInfo) => {
      cameraRef.current = camera;
      controlsRef.current = controls;
      frameRef.current = frame;
      applyCameraPose(camera, controls, poseRef.current, frame);
      syncPose(camera);
    },
    [syncPose],
  );

  const handleCameraMove = useCallback((pose: CameraPose) => {
    poseRef.current = pose;
    setCameraPose(pose);
  }, []);

  const handlePoseCommit = useCallback((pose: CameraPose) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    applyCameraPose(camera, controls, pose);
    syncPose(camera);
  }, [syncPose]);

  const handleViewPreset = useCallback(
    (preset: ViewPreset) => {
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      const frame = frameRef.current;
      if (!camera || !controls || !frame) return;
      applyViewPreset(camera, controls, preset, frame);
      poseRef.current = VIEW_PRESETS[preset];
      setCameraPose(VIEW_PRESETS[preset]);
    },
    [syncPose],
  );

  const handleLoadOrientation = useCallback(async () => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) {
      setSaveStatus("The viewport is still loading.");
      return;
    }

    const stored = (await loadCameraStart()) ?? readStoredCameraStart();
    if (!stored) {
      setSaveStatus("No saved orientation yet. Use Save starting view first.");
      return;
    }

    applyCameraStart(camera, controls, stored);
    syncPose(camera);
    setSaveStatus("Loaded the saved starting view.");
  }, [syncPose]);

  const handleSaveView = useCallback(async () => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) {
      setSaveStatus("The viewport is still loading.");
      return;
    }

    const nextStart = captureCameraStart(camera, controls);
    const result = await saveCameraStart(nextStart);
    setSaveStatus(
      result.savedToFile
        ? "Saved to public/camera-start.json. Load Orientation will restore this view."
        : "Saved in this browser. The file endpoint was unavailable.",
    );
  }, []);

  return (
    <div className="app">
      <Canvas
        key={orthographic ? "ortho" : "persp"}
        orthographic={orthographic}
        camera={
          orthographic
            ? { position: [0, 2, 40], zoom: 20, near: 0.1, far: 2000, up: [0, 1, 0] }
            : { position: [0, 2, 40], fov: 45, near: 0.1, far: 2000, up: [0, 1, 0] }
        }
        frameloop="always"
        gl={{ antialias: true }}
        dpr={[1, 2]}
      >
        <WalkerScene
          selectedPart={selectedPart}
          onSelectPart={setSelectedPart}
          onReady={handleReady}
          onCameraMove={handleCameraMove}
        />
      </Canvas>

      <div className="hud hud-top">
        <div>
          <h1>2D Walker</h1>
          <p>Click a shoulder, leg, or foot to select · click again to deselect · drag to rotate within joint limits</p>
        </div>
        <button type="button" onClick={handleSaveView}>
          Save starting view
        </button>
      </div>

      <div className="hud hud-pose">
        <CameraPoseControls
          value={cameraPose}
          orthographic={orthographic}
          onCommit={handlePoseCommit}
          onViewPreset={handleViewPreset}
          onLoadOrientation={handleLoadOrientation}
          onToggleProjection={() => setOrthographic((current) => !current)}
        />
      </div>

      <p className="hud-save-status">{saveStatus}</p>

      <div className="hud hud-bottom">
        <span className="hud-label">Selected segment</span>
        <strong>{selectedPart ?? "Click a shoulder, leg, or foot to select"}</strong>
      </div>
    </div>
  );
}
