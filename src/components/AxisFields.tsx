import { useEffect, useState } from "react";

export type AxisVec3 = {
  x: number;
  y: number;
  z: number;
};

type Axis = keyof AxisVec3;

const AXES: { axis: Axis; color: string }[] = [
  { axis: "x", color: "#ff3653" },
  { axis: "y", color: "#8adb00" },
  { axis: "z", color: "#2c8fff" },
];

type AxisFieldsProps = {
  value: AxisVec3;
  step?: number;
  digits?: number;
  unit?: string;
  onCommit: (next: AxisVec3) => void;
};

export function formatAxisValue(value: number, digits: number) {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

export function AxisFields({ value, step = 1, digits = 1, unit, onCommit }: AxisFieldsProps) {
  const [draft, setDraft] = useState({
    x: formatAxisValue(value.x, digits),
    y: formatAxisValue(value.y, digits),
    z: formatAxisValue(value.z, digits),
  });
  const [focused, setFocused] = useState<Axis | null>(null);

  useEffect(() => {
    setDraft((current) => ({
      x: focused === "x" ? current.x : formatAxisValue(value.x, digits),
      y: focused === "y" ? current.y : formatAxisValue(value.y, digits),
      z: focused === "z" ? current.z : formatAxisValue(value.z, digits),
    }));
  }, [digits, focused, value]);

  const commitAxis = (axis: Axis) => {
    const parsed = Number(draft[axis]);
    if (!Number.isFinite(parsed)) {
      setDraft((current) => ({ ...current, [axis]: formatAxisValue(value[axis], digits) }));
      return;
    }
    onCommit({ ...value, [axis]: parsed });
  };

  return (
    <div className="camera-pose-fields">
      {AXES.map(({ axis, color }) => (
        <label key={axis} className="camera-pose-field" style={{ borderColor: color }}>
          <span style={{ color }}>{axis.toUpperCase()}</span>
          <input
            type="number"
            step={step}
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
          {unit ? <span className="camera-pose-unit">{unit}</span> : null}
        </label>
      ))}
    </div>
  );
}
