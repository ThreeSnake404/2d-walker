import { Html } from "@react-three/drei";

type AxisLabelProps = {
  position: [number, number, number];
  label: string;
  color: string;
};

function AxisLabel({ position, label, color }: AxisLabelProps) {
  return (
    <Html position={position} center pointerEvents="none" style={{ pointerEvents: "none" }}>
      <span
        style={{
          color,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: "14px",
          fontWeight: 700,
          letterSpacing: "0.06em",
          textShadow: "0 0 6px #000",
        }}
      >
        {label}
      </span>
    </Html>
  );
}

type LabeledAxesProps = {
  size?: number;
};

export function LabeledAxes({ size = 6 }: LabeledAxesProps) {
  const labelOffset = size + 0.45;

  return (
    <group>
      <axesHelper args={[size]} />
      <AxisLabel position={[labelOffset, 0, 0]} label="X" color="#ff3653" />
      <AxisLabel position={[0, labelOffset, 0]} label="Y" color="#8adb00" />
      <AxisLabel position={[0, 0, labelOffset]} label="Z" color="#2c8fff" />
    </group>
  );
}
