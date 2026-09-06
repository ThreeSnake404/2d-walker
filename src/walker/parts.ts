export const MODEL_URL = `${import.meta.env.BASE_URL}model/2DWalker_v0_3.gltf`;

const SIDES = ["Left", "Right"] as const;
const INDICES = [1, 2, 3] as const;

function segmentNames(prefix: "Shoulder" | "UpperLeg" | "LowerLeg" | "Foot") {
  return SIDES.flatMap((side) => INDICES.map((index) => `${prefix}${side}${index}` as const));
}

export const SHOULDER_PARTS = segmentNames("Shoulder");
export const UPPER_LEG_PARTS = segmentNames("UpperLeg");
export const LOWER_LEG_PARTS = segmentNames("LowerLeg");
export const FOOT_PARTS = segmentNames("Foot");
export const HINGE_PARTS = [...UPPER_LEG_PARTS, ...LOWER_LEG_PARTS, ...FOOT_PARTS] as const;
export const MOVABLE_PARTS = [...SHOULDER_PARTS, ...HINGE_PARTS] as const;

/**
 * Index 1 is the front pair, 3 the back pair, 2 the middle. Only the four
 * corners walk: their diagonal splay puts each foot well off both axes, which
 * is what gives a turn any leverage, and diagonally opposite corners can hold
 * the body while the other two step. The middle pair stays in the model but is
 * hidden until the corner gait is settled.
 */
export const ACTIVE_LEG_INDICES = ["1", "3"] as const;
export const MIDDLE_LEG_INDEX = "2";

function isActiveIndex(name: string) {
  return ACTIVE_LEG_INDICES.some((index) => name.endsWith(index));
}

export const MIDDLE_SHOULDER_PARTS = SHOULDER_PARTS.filter((name) => name.endsWith(MIDDLE_LEG_INDEX));
export const ACTIVE_SHOULDER_PARTS = SHOULDER_PARTS.filter(isActiveIndex);
export const ACTIVE_UPPER_LEG_PARTS = UPPER_LEG_PARTS.filter(isActiveIndex);
export const ACTIVE_LOWER_LEG_PARTS = LOWER_LEG_PARTS.filter(isActiveIndex);
export const ACTIVE_FOOT_PARTS = FOOT_PARTS.filter(isActiveIndex);
export const ACTIVE_MOVABLE_PARTS = MOVABLE_PARTS.filter(isActiveIndex);
export const SELECTABLE_PARTS = ["Chassis", ...ACTIVE_MOVABLE_PARTS] as const;

export const PART_NAMES = ["Chassis", ...MOVABLE_PARTS] as const;

export type PartName = (typeof PART_NAMES)[number];
export type MovablePart = (typeof MOVABLE_PARTS)[number];

export function isPartName(name: string): name is PartName {
  return (PART_NAMES as readonly string[]).includes(name);
}

export function isMovablePart(name: string): name is MovablePart {
  return (MOVABLE_PARTS as readonly string[]).includes(name);
}

export function isSelectablePart(name: string): name is PartName {
  return (SELECTABLE_PARTS as readonly string[]).includes(name);
}

export function isChassisPart(name: string): name is "Chassis" {
  return name === "Chassis";
}

export function isShoulderPart(name: string): name is (typeof SHOULDER_PARTS)[number] {
  return (SHOULDER_PARTS as readonly string[]).includes(name);
}

export function isHingePart(name: string): name is (typeof HINGE_PARTS)[number] {
  return (HINGE_PARTS as readonly string[]).includes(name);
}

export function isLowerLegPart(name: string): name is (typeof LOWER_LEG_PARTS)[number] {
  return (LOWER_LEG_PARTS as readonly string[]).includes(name);
}

export function isFootPart(name: string): name is (typeof FOOT_PARTS)[number] {
  return (FOOT_PARTS as readonly string[]).includes(name);
}

export function isUpperLegPart(name: string): name is (typeof UPPER_LEG_PARTS)[number] {
  return (UPPER_LEG_PARTS as readonly string[]).includes(name);
}

export function isActiveLimbPart(name: string): boolean {
  return isMovablePart(name) && isActiveIndex(name);
}

export function isFrontShoulderPart(name: string): boolean {
  return isShoulderPart(name) && name.endsWith("1");
}

export function isBackShoulderPart(name: string): boolean {
  return isShoulderPart(name) && name.endsWith("3");
}

export function findPartName(object: { name: string; parent: unknown }): PartName | null {
  let current: { name: string; parent: unknown } | null = object;
  while (current) {
    if (isPartName(current.name)) return current.name;
    current = current.parent as { name: string; parent: unknown } | null;
  }
  return null;
}
