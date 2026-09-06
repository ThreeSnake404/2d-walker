import { useEffect, useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { Box3, Color, type Material, type Mesh, type MeshStandardMaterial, type Object3D } from "three";
import { isLeftLegPart, isPartName, MODEL_URL, type PartName } from "../walker/parts";

type WalkerModelProps = {
  selectedPart: PartName | null;
  onBounds: (box: Box3) => void;
  onSelectPart: (part: PartName | null) => void;
};

function findPartName(object: Object3D): PartName | null {
  let current: Object3D | null = object;
  while (current) {
    if (isPartName(current.name)) return current.name;
    current = current.parent;
  }
  return null;
}

function eachMaterial(material: Material | Material[], visit: (material: MeshStandardMaterial) => void) {
  const materials = Array.isArray(material) ? material : [material];
  for (const entry of materials) {
    const standard = entry as MeshStandardMaterial;
    if (standard.emissive) visit(standard);
  }
}

export function WalkerModel({ selectedPart, onBounds, onSelectPart }: WalkerModelProps) {
  const { scene } = useGLTF(MODEL_URL);
  const model = useMemo(() => scene.clone(true), [scene]);

  useEffect(() => {
    model.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((material) => material.clone())
        : mesh.material.clone();
    });
  }, [model]);

  useEffect(() => {
    onBounds(new Box3().setFromObject(model));
  }, [model, onBounds]);

  useEffect(() => {
    model.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      const part = findPartName(mesh);
      const active = part !== null && part === selectedPart;
      eachMaterial(mesh.material, (material) => {
        material.emissive = new Color(active ? "#ffcc66" : "#000000");
        material.emissiveIntensity = active ? 0.85 : 0;
      });
    });
  }, [model, selectedPart]);

  return (
    <primitive
      object={model}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        const part = findPartName(event.object);
        onSelectPart(part && isLeftLegPart(part) ? part : null);
      }}
      onPointerOver={(event: ThreeEvent<PointerEvent>) => {
        const part = findPartName(event.object);
        if (part && isLeftLegPart(part)) {
          event.stopPropagation();
          document.body.style.cursor = "pointer";
        }
      }}
      onPointerOut={() => {
        document.body.style.cursor = "auto";
      }}
    />
  );
}

useGLTF.preload(MODEL_URL);
