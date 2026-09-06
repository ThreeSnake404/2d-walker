import { useCallback, useEffect, useRef, useState } from "react";
import { OrbitControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { Box3, DoubleSide, type Camera } from "three";
import type { OrbitControlsImpl } from "../walker/controls";
import { poseFromCamera, type CameraPose, type FrameInfo } from "../walker/cameraPose";
import { frameDefaultView } from "../walker/frameView";
import type { PartName } from "../walker/parts";
import { LabeledAxes } from "./LabeledAxes";
import { WalkerModel, type ChassisApi } from "./WalkerModel";
import type { ChassisPosition } from "../walker/walkIk";

type WalkerSceneProps = {
  selectedPart: PartName | null;
  onSelectPart: (part: PartName | null) => void;
  onReady: (camera: Camera, controls: OrbitControlsImpl, frame: FrameInfo) => void;
  onCameraMove: (pose: CameraPose) => void;
  onChassisMove: (position: ChassisPosition) => void;
  onChassisApi: (api: ChassisApi) => void;
};

export function WalkerScene({
  selectedPart,
  onSelectPart,
  onReady,
  onCameraMove,
  onChassisMove,
  onChassisApi,
}: WalkerSceneProps) {
  const camera = useThree((state) => state.camera);
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const [orbitControls, setOrbitControls] = useState<OrbitControlsImpl | null>(null);
  const groundY = 0;
  const framedRef = useRef(false);
  const { size } = useThree();

  const publishPose = useCallback(() => {
    onCameraMove(poseFromCamera(camera));
  }, [camera, onCameraMove]);

  const handleBounds = useCallback(
    (box: Box3) => {
      const controls = controlsRef.current;
      if (!controls || framedRef.current) return;

      const frame = frameDefaultView(camera, controls, box, size.width, size.height);
      framedRef.current = true;
      onReady(camera, controls, frame);
      publishPose();
    },
    [camera, onReady, publishPose, size.height, size.width],
  );

  useEffect(() => {
    const controls = controlsRef.current;
    if (camera && controls && framedRef.current) {
      onReady(camera, controls, {
        center: controls.target.toArray() as [number, number, number],
        distance: camera.position.distanceTo(controls.target),
        zoom: camera.zoom,
      });
    }
  }, [camera, onReady]);

  return (
    <>
      <OrbitControls
        ref={(node) => {
          controlsRef.current = node;
          setOrbitControls(node);
        }}
        makeDefault
        enableRotate
        enablePan
        enableZoom
        enableDamping={false}
        minPolarAngle={0}
        maxPolarAngle={Math.PI}
        onChange={publishPose}
      />

      <color attach="background" args={["#1b2028"]} />
      <hemisphereLight args={["#f4f1ea", "#2b3340", 1.1]} />
      <directionalLight position={[8, 14, 18]} intensity={1.35} />
      <ambientLight intensity={0.28} />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, groundY, 0]} receiveShadow>
        <planeGeometry args={[64, 64]} />
        <meshBasicMaterial color="#6fc45a" side={DoubleSide} />
      </mesh>
      <gridHelper args={[64, 32, "#8ee07a", "#57a348"]} position={[0, groundY, 0]} />
      <LabeledAxes size={8} />
      <WalkerModel
        selectedPart={selectedPart}
        orbitControls={orbitControls}
        onBounds={handleBounds}
        onSelectPart={onSelectPart}
        onChassisMove={onChassisMove}
        onChassisApi={onChassisApi}
      />
    </>
  );
}
