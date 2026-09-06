export const MODEL_URL = "/model/2DWalker_v0_1.gltf";

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

export function isPartName(name: string): name is PartName {
  return (PART_NAMES as readonly string[]).includes(name);
}

export function isLeftLegPart(name: string): boolean {
  return (LEFT_LEG_PARTS as readonly string[]).includes(name);
}
