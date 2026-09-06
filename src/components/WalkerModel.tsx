import { useEffect, useMemo, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { Box3, Color, Vector3, type Material, type Mesh, type MeshStandardMaterial } from "three";
import type { OrbitControlsImpl } from "../walker/controls";
import {
  attachPickVolumes,
  beginLimbDrag,
  intersectWalkDrag,
  walkDragPlane,
  type WalkDragPlane,
  pickMovablePart,
  setPickVolumeHighlight,
  updateLimbDrag,
  type LimbDrag,
  type PickedLimb,
} from "../walker/dragRotate";
import { bakeBindScale } from "../walker/bindScale";
import { applyStartPose, bindJoints } from "../walker/joints";
import { findPartName, isChassisPart, MODEL_URL, type PartName } from "../walker/parts";
import {
  advanceBody,
  capturePlants,
  clearBodyDrag,
  createWalkGait,
  gaitIsBusy,
  hideCornerLegs,
  plantFeetOnGround,
  readChassisPosition,
  releaseBodyGoal,
  setBodyGoal,
  setBodyPosition,
  solveWalkGait,
  visibleBounds,
  type ChassisPosition,
  type WalkGait,
} from "../walker/walkIk";

const DRAG_PX = 12;
const _chassisOrigin = new Vector3();

export type ChassisApi = {
  setPosition: (position: ChassisPosition) => void;
};

type WalkerModelProps = {
  selectedPart: PartName | null;
  orbitControls: OrbitControlsImpl | null;
  onBounds: (box: Box3) => void;
  onSelectPart: (part: PartName | null) => void;
  onChassisMove: (position: ChassisPosition) => void;
  onChassisApi: (api: ChassisApi) => void;
};

function eachMaterial(material: Material | Material[], visit: (material: MeshStandardMaterial) => void) {
  const materials = Array.isArray(material) ? material : [material];
  for (const entry of materials) {
    const standard = entry as MeshStandardMaterial;
    if (standard.emissive) visit(standard);
  }
}

export function WalkerModel({
  selectedPart,
  orbitControls,
  onBounds,
  onSelectPart,
  onChassisMove,
  onChassisApi,
}: WalkerModelProps) {
  const { scene } = useGLTF(MODEL_URL);
  const model = useMemo(() => scene.clone(true), [scene]);
  const { camera, gl, invalidate } = useThree();
  const dragRef = useRef<LimbDrag | null>(null);
  const chassisDragRef = useRef<{
    /** Body position minus the grab point, so the chassis keeps its grip offset. */
    offsetX: number;
    offsetZ: number;
    plane: WalkDragPlane;
  } | null>(null);
  const gaitRef = useRef<WalkGait | null>(null);
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
  const onChassisMoveRef = useRef(onChassisMove);
  onChassisMoveRef.current = onChassisMove;
  modelRef.current = model;
  selectedRef.current = selectedPart;

  const publishChassis = () => {
    const gait = gaitRef.current;
    if (gait) onChassisMoveRef.current(readChassisPosition(gait));
  };

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
    bakeBindScale(model);
    bindJoints(model);
    applyStartPose(model);
    hideCornerLegs(model);
    const gait = createWalkGait(model);
    plantFeetOnGround(gait, 0);
    gaitRef.current = gait;
    attachPickVolumes(model);
    onBounds(visibleBounds(model));
    publishChassis();
  }, [model, onBounds]);

  useEffect(() => {
    onChassisApi({
      setPosition: (position) => {
        const gait = gaitRef.current;
        if (!gait) return;
        setBodyPosition(gait, position.x, position.y, position.z);
        solveWalkGait(gait);
        invalidate();
        onChassisMoveRef.current(readChassisPosition(gait));
      },
    });
  }, [invalidate, onChassisApi]);

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

  // One loop owns time: it drains queued drag at walking speed, then solves the
  // gait. Pointer handlers only queue intent, so the body can never outrun a step.
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = () => {
      const gait = gaitRef.current;
      const now = performance.now();
      if (gait && gaitIsBusy(gait)) {
        advanceBody(gait, last ? now - last : 16);
        solveWalkGait(gait, now);
        invalidate();
        onChassisMoveRef.current(readChassisPosition(gait));
      }
      last = now;
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [invalidate]);

  useEffect(() => {
    const element = gl.domElement;
    element.style.touchAction = "none";
    element.setAttribute("role", "img");
    element.setAttribute("aria-label", "Walker viewport");

    const pickAt = (clientX: number, clientY: number) =>
      pickMovablePart(modelRef.current, camera, clientX, clientY, element, selectedRef.current);

    const finishPointer = () => {
      const gait = gaitRef.current;
      if (chassisDragRef.current && gait) releaseBodyGoal(gait);
      pendingRef.current = null;
      dragRef.current = null;
      chassisDragRef.current = null;
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
      const chassisDrag = chassisDragRef.current;
      const gait = gaitRef.current;
      if (chassisDrag && gait) {
        event.preventDefault();
        const hit = intersectWalkDrag(camera, event.clientX, event.clientY, element, chassisDrag.plane);
        if (!hit) return;
        const goalX = hit.x + chassisDrag.offsetX;
        const goalZ = hit.z + chassisDrag.offsetZ;
        if (!Number.isFinite(goalX) || !Number.isFinite(goalZ)) return;
        // Aim at where the cursor is, not at how far it just moved, so holding it
        // still keeps the body walking until it arrives.
        setBodyGoal(gait, goalX, goalZ);
        return;
      }

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

        if (isChassisPart(pending.picked.part) && gaitRef.current) {
          const gait = gaitRef.current;
          gait.chassis.getWorldPosition(_chassisOrigin);
          const plane = walkDragPlane(camera, _chassisOrigin);
          const hit = intersectWalkDrag(camera, pending.x, pending.y, element, plane);
          if (!hit) return;
          capturePlants(gait);
          clearBodyDrag(gait);
          chassisDragRef.current = {
            offsetX: _chassisOrigin.x - hit.x,
            offsetZ: _chassisOrigin.z - hit.z,
            plane,
          };
          if (orbitControls) orbitControls.enabled = false;
          document.body.style.cursor = "grabbing";
          return;
        }

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
