import { useEffect, useState } from "react";
import type { CameraPose, ViewPreset } from "../walker/cameraPose";

type Axis = keyof CameraPose;

const AXES: { axis: Axis; color: string }[] = [
  { axis: "x", color: "#ff3653" },
  { axis: "y", color: "#8adb00" },
  { axis: "z", color: "#2c8fff" },
];

function formatAxis(value: number) {
  return value.toFixed(1);
}

type CameraPoseControlsProps = {
  value: CameraPose;
  orthographic: boolean;
  onCommit: (next: CameraPose) => void;
  onViewPreset: (preset: ViewPreset) => void;
  onLoadOrientation: () => void;
  onToggleProjection: () => void;
};

export function CameraPoseControls({
  value,
  orthographic,
  onCommit,
  onViewPreset,
  onLoadOrientation,
  onToggleProjection,
}: CameraPoseControlsProps) {
  const [draft, setDraft] = useState({
    x: formatAxis(value.x),
    y: formatAxis(value.y),
    z: formatAxis(value.z),
  });
  const [focused, setFocused] = useState<Axis | null>(null);

  useEffect(() => {
    setDraft((current) => ({
      x: focused === "x" ? current.x : formatAxis(value.x),
      y: focused === "y" ? current.y : formatAxis(value.y),
      z: focused === "z" ? current.z : formatAxis(value.z),
    }));
  }, [focused, value]);

  const commitAxis = (axis: Axis) => {
    const parsed = Number(draft[axis]);
    if (!Number.isFinite(parsed)) {
      setDraft((current) => ({ ...current, [axis]: formatAxis(value[axis]) }));
      return;
    }
    onCommit({ ...value, [axis]: parsed });
  };

  return (
    <div className="camera-pose">
      <span className="hud-label">Rotation (degrees)</span>
      <div className="camera-pose-fields">
        {AXES.map(({ axis, color }) => (
          <label key={axis} className="camera-pose-field" style={{ borderColor: color }}>
            <span style={{ color }}>{axis.toUpperCase()}</span>
            <input
              type="number"
              step="1"
              value={draft[axis]}
              onFocus={() => setFocused(axis)}
              onChange={(event) => {
                const nextValue = event.target.value;
                setDraft((current) => ({ ...current, [axis]: nextValue }));
                const parsed = Number(nextValue);
                if (Number.isFinite(parsed)) onCommit({ ...value, [axis]: parsed });
              }}
              onBlur={() => {
                commitAxis(axis);
                setFocused(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitAxis(axis);
                  event.currentTarget.blur();
                }
              }}
            />
            <span className="camera-pose-unit">°</span>
          </label>
        ))}
      </div>
      <div className="view-buttons">
        <button type="button" onClick={() => onViewPreset("front")}>
          Front
        </button>
        <button type="button" onClick={() => onViewPreset("top")}>
          Top
        </button>
        <button type="button" onClick={() => onViewPreset("right")}>
          Right
        </button>
        <button type="button" className="view-button-projection" onClick={onToggleProjection}>
          {orthographic ? "Perspective" : "Orthographic"}
        </button>
        <button type="button" className="view-button-load" onClick={onLoadOrientation}>
          Load Orientation
        </button>
      </div>
    </div>
  );
}
