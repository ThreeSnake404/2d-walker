import { Matrix4, Vector3, type Mesh, type Object3D } from "three";

const _scale = new Vector3();
const _scaleMatrix = new Matrix4();

function isIdentityScale(scale: Vector3) {
  return Math.abs(scale.x - 1) < 1e-5 && Math.abs(scale.y - 1) < 1e-5 && Math.abs(scale.z - 1) < 1e-5;
}

/**
 * Bake each node's local scale into its mesh and children so later hinge
 * rotations stay planar. The Blender export parents legs under a
 * non-uniform shoulder scale; rotating under that scale shears the knee.
 */
export function bakeBindScale(root: Object3D) {
  root.updateMatrixWorld(true);
  bakeNodeScale(root);
  root.updateMatrixWorld(true);
}

function bakeNodeScale(object: Object3D) {
  _scale.copy(object.scale);
  if (!isIdentityScale(_scale)) {
    _scaleMatrix.makeScale(_scale.x, _scale.y, _scale.z);

    const mesh = object as Mesh;
    if (mesh.isMesh) {
      mesh.geometry = mesh.geometry.clone();
      mesh.geometry.applyMatrix4(_scaleMatrix);
      mesh.geometry.computeBoundingBox();
      mesh.geometry.computeBoundingSphere();
    }

    for (const child of object.children) {
      child.position.multiply(_scale);
      child.scale.multiply(_scale);
    }

    object.scale.set(1, 1, 1);
  }

  for (const child of object.children) bakeNodeScale(child);
}
