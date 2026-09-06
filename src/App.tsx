import { useCallback, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import type { Camera } from "three";
import type { OrbitControlsImpl } from "./walker/controls";
import { CameraPoseControls } from "./components/CameraPoseControls";
import { WalkerScene } from "./components/WalkerScene";
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
import { AxisFields, type AxisVec3 } from "./components/AxisFields";
import type { ChassisApi } from "./components/WalkerModel";
import type { ChassisPosition } from "./walker/walkIk";
import "./App.css";

export default function App() {
  const cameraRef = useRef<Camera | null>(null);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const frameRef = useRef<FrameInfo | null>(null);
  const poseRef = useRef<CameraPose>({ x: 0, y: 0, z: 0 });
  const [cameraPose, setCameraPose] = useState<CameraPose>({ x: 0, y: 0, z: 0 });
  const [orthographic, setOrthographic] = useState(true);
  const [selectedPart, setSelectedPart] = useState<PartName | null>(null);
  const [chassisPosition, setChassisPosition] = useState<ChassisPosition>({ x: 0, y: 0, z: 0 });
  const [panelOpen, setPanelOpen] = useState(false);
  const chassisApiRef = useRef<ChassisApi | null>(null);

  const handleChassisApi = useCallback((api: ChassisApi) => {
    chassisApiRef.current = api;
  }, []);

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

  const handleViewPreset = useCallback((preset: ViewPreset) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const frame = frameRef.current;
    if (!camera || !controls || !frame) return;
    applyViewPreset(camera, controls, preset, frame);
    poseRef.current = VIEW_PRESETS[preset];
    setCameraPose(VIEW_PRESETS[preset]);
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
          onChassisMove={setChassisPosition}
          onChassisApi={handleChassisApi}
        />
      </Canvas>

      <div className="hud hud-view">
        <button type="button" onClick={() => handleViewPreset("front")}>
          Front
        </button>
        <button type="button" onClick={() => handleViewPreset("top")}>
          Top
        </button>
        <button type="button" onClick={() => handleViewPreset("right")}>
          Right
        </button>
        <button
          type="button"
          className="view-button-projection"
          onClick={() => setOrthographic((current) => !current)}
        >
          {orthographic ? "Perspective" : "Orthographic"}
        </button>
      </div>

      <aside className={`hud-panel ${panelOpen ? "is-open" : ""}`}>
        <div id="controls-panel" className="hud-panel-body">
          <CameraPoseControls value={cameraPose} onCommit={handlePoseCommit} />
          <div className="camera-pose">
            <span className="hud-label">Chassis position</span>
            <AxisFields
              value={chassisPosition}
              step={0.1}
              digits={2}
              onCommit={(next: AxisVec3) => chassisApiRef.current?.setPosition(next)}
            />
            <p className="chassis-pos-hint">Walk drag is on the ZX ground plane. Type 0, 0, 0 to return home.</p>
          </div>
        </div>
        <button
          type="button"
          className="hud-panel-toggle"
          aria-expanded={panelOpen}
          aria-controls="controls-panel"
          onClick={() => setPanelOpen((current) => !current)}
        >
          {panelOpen ? "Hide" : "Controls"}
        </button>
      </aside>

      <div className="hud hud-bottom">
        <span className="hud-label">Selected segment</span>
        <strong>{selectedPart ?? "Click the chassis to walk, or a limb to pose"}</strong>
      </div>
    </div>
  );
}
