import type { CameraPose } from "../walker/cameraPose";
import { AxisFields } from "./AxisFields";

type CameraPoseControlsProps = {
  value: CameraPose;
  onCommit: (next: CameraPose) => void;
};

export function CameraPoseControls({ value, onCommit }: CameraPoseControlsProps) {
  return (
    <div className="camera-pose">
      <span className="hud-label">Rotation (degrees)</span>
      <AxisFields value={value} step={1} digits={1} unit="°" onCommit={onCommit} />
    </div>
  );
}
