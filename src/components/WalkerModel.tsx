import { useEffect, useMemo, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { Box3, Color, type Material, type Mesh, type MeshStandardMaterial } from "three";
import type { OrbitControlsImpl } from "../walker/controls";
import {
  attachPickVolumes,
  beginLimbDrag,
  pickMovablePart,
  setPickVolumeHighlight,
  updateLimbDrag,
  type LimbDrag,
  type PickedLimb,
} from "../walker/dragRotate";
import { findPartName, MODEL_URL, type PartName } from "../walker/parts";

const DRAG_PX = 12;

type WalkerModelProps = {
  selectedPart: PartName | null;
  orbitControls: OrbitControlsImpl | null;
  onBounds: (box: Box3) => void;
  onSelectPart: (part: PartName | null) => void;
};

function eachMaterial(material: Material | Material[], visit: (material: MeshStandardMaterial) => void) {
  const materials = Array.isArray(material) ? material : [material];
  for (const entry of materials) {
    const standard = entry as MeshStandardMaterial;
    if (standard.emissive) visit(standard);
  }
}

export function WalkerModel({ selectedPart, orbitControls, onBounds, onSelectPart }: WalkerModelProps) {
  const { scene } = useGLTF(MODEL_URL);
  const model = useMemo(() => scene.clone(true), [scene]);
  const { camera, gl, invalidate } = useThree();
  const dragRef = useRef<LimbDrag | null>(null);
  const modelRef = useRef(model);
  const selectedRef = useRef(selectedPart);
  const pendingRef = useRef<{
    x: number;
    y: number;
    picked: PickedLimb;
    selectedOnDown: PartName | null;
    moved: boolean;
  } | null>(null);
  const ignoreClickRef = useRef(false);
  modelRef.current = model;
  selectedRef.current = selectedPart;

  useEffect(() => {
    model.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh || mesh.userData.pickVolume) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((material) => material.clone())
        : mesh.material.clone();
    });
    onBounds(new Box3().setFromObject(model));
    attachPickVolumes(model);
  }, [model, onBounds]);

  useEffect(() => {
    model.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh || mesh.userData.pickVolume) return;
      const part = findPartName(mesh);
      const active = part !== null && part === selectedPart;
      eachMaterial(mesh.material, (material) => {
        material.emissive = new Color(active ? "#ffcc66" : "#000000");
        material.emissiveIntensity = active ? 0.85 : 0;
      });
    });
    setPickVolumeHighlight(model, selectedPart);
  }, [model, selectedPart]);

  useEffect(() => {
    const element = gl.domElement;
    element.style.touchAction = "none";
    element.setAttribute("role", "img");
    element.setAttribute("aria-label", "Walker viewport");

    const pickAt = (clientX: number, clientY: number) =>
      pickMovablePart(modelRef.current, camera, clientX, clientY, element, selectedRef.current);

    const finishPointer = () => {
      pendingRef.current = null;
      dragRef.current = null;
      if (orbitControls) orbitControls.enabled = true;
      document.body.style.cursor = "auto";
    };

    const setHoverCursor = (clientX: number, clientY: number) => {
      const hovered = pickAt(clientX, clientY);
      if (!hovered) {
        document.body.style.cursor = "auto";
        return;
      }
      document.body.style.cursor = hovered.part === selectedRef.current ? "grab" : "pointer";
    };

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      ignoreClickRef.current = false;
      const picked = pickAt(event.clientX, event.clientY);
      if (!picked) return;

      pendingRef.current = {
        x: event.clientX,
        y: event.clientY,
        picked,
        selectedOnDown: selectedRef.current,
        moved: false,
      };

      if (selectedRef.current !== picked.part) return;

      event.stopImmediatePropagation();
      if (orbitControls) orbitControls.enabled = false;
    };

    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag) {
        event.preventDefault();
        updateLimbDrag(drag, camera, event.clientX, event.clientY, element);
        invalidate();
        return;
      }

      const pending = pendingRef.current;
      if (pending) {
        const distance = Math.hypot(event.clientX - pending.x, event.clientY - pending.y);
        if (distance < DRAG_PX) return;
        pending.moved = true;
        if (pending.selectedOnDown !== pending.picked.part) return;

        const nextDrag = beginLimbDrag(pending.picked.object, camera, pending.x, pending.y, element);
        if (!nextDrag) return;
        dragRef.current = nextDrag;
        if (orbitControls) orbitControls.enabled = false;
        document.body.style.cursor = "grabbing";
        updateLimbDrag(nextDrag, camera, event.clientX, event.clientY, element);
        invalidate();
        return;
      }

      setHoverCursor(event.clientX, event.clientY);
    };

    const onUp = (event: PointerEvent) => {
      const pending = pendingRef.current;
      const dragged = dragRef.current;
      finishPointer();
      if (!pending || dragged) return;

      const distance = Math.hypot(event.clientX - pending.x, event.clientY - pending.y);
      if (distance >= DRAG_PX) return;

      ignoreClickRef.current = true;
      onSelectPart(pending.selectedOnDown === pending.picked.part ? null : pending.picked.part);
    };

    const onClick = (event: MouseEvent) => {
      if (ignoreClickRef.current) {
        ignoreClickRef.current = false;
        return;
      }
      if (event.button !== 0) return;
      const picked = pickAt(event.clientX, event.clientY);
      if (!picked) return;
      event.stopImmediatePropagation();
      onSelectPart(picked.part === selectedRef.current ? null : picked.part);
    };

    element.addEventListener("pointerdown", onDown, true);
    element.addEventListener("pointerup", onUp, true);
    element.addEventListener("pointercancel", finishPointer, true);
    element.addEventListener("click", onClick, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      element.removeEventListener("pointerdown", onDown, true);
      element.removeEventListener("pointerup", onUp, true);
      element.removeEventListener("pointercancel", finishPointer, true);
      element.removeEventListener("click", onClick, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [camera, gl, invalidate, onSelectPart, orbitControls]);

  return <primitive object={model} />;
}

useGLTF.preload(MODEL_URL);
