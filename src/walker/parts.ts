export const MODEL_URL = `${import.meta.env.BASE_URL}model/2DWalker_v0_1.gltf`;

export const PART_NAMES = [
  "Base",
  "UpperLegLeft",
  "LowerLegLeft",
  "FootLeft",
  "UpperLegRight",
  "LowerLegRight",
  "FootRight",
] as const;

export type PartName = (typeof PART_NAMES)[number];

export const LEFT_LEG_PARTS = ["UpperLegLeft", "LowerLegLeft", "FootLeft"] as const;
export const RIGHT_LEG_PARTS = ["UpperLegRight", "LowerLegRight", "FootRight"] as const;
export const MOVABLE_PARTS = [...LEFT_LEG_PARTS, ...RIGHT_LEG_PARTS] as const;

export function isPartName(name: string): name is PartName {
  return (PART_NAMES as readonly string[]).includes(name);
}

export function isLeftLegPart(name: string): boolean {
  return (LEFT_LEG_PARTS as readonly string[]).includes(name);
}

export function isMovablePart(name: string): name is PartName {
  return (MOVABLE_PARTS as readonly string[]).includes(name);
}

export function findPartName(object: { name: string; parent: unknown }): PartName | null {
  let current: { name: string; parent: unknown } | null = object;
  while (current) {
    if (isPartName(current.name)) return current.name;
    current = current.parent as { name: string; parent: unknown } | null;
  }
  return null;
}
