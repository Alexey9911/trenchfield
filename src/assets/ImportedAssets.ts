import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export interface ImportDiagnostics {
  name: string;
  triangles: number;
  materials: number;
  loaded: boolean;
}

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

export const importDiagnostics: ImportDiagnostics[] = [];

async function loadGlb(url: string): Promise<THREE.Group | null> {
  try {
    const gltf = await loader.loadAsync(url);
    return gltf.scene;
  } catch {
    return null;
  }
}

function countDiagnostics(name: string, root: THREE.Object3D | null): void {
  let triangles = 0;
  const mats = new Set<THREE.Material>();
  root?.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      const geo = mesh.geometry;
      triangles += geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
      const m = mesh.material;
      if (Array.isArray(m)) m.forEach((x) => mats.add(x));
      else if (m) mats.add(m);
    }
  });
  importDiagnostics.push({
    name,
    triangles: Math.round(triangles),
    materials: mats.size,
    loaded: root !== null,
  });
}

/**
 * Normalize a Meshy weapon GLB into a viewmodel: longest axis aligned to -Z
 * (barrel forward), scaled to targetLength, centered on the grip area.
 */
export async function loadWeaponModel(
  url: string,
  name: string,
  targetLength: number,
): Promise<THREE.Group | null> {
  const scene = await loadGlb(url);
  countDiagnostics(name, scene);
  if (!scene) return null;

  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const wrapper = new THREE.Group();
  wrapper.name = `${name}_imported`;
  const inner = new THREE.Group();
  inner.add(scene);
  wrapper.add(inner);

  // center the mesh
  scene.position.sub(center);

  // Meshy side-profile weapons usually extend along X. Rotate longest axis to Z.
  let length = size.z;
  if (size.x >= size.y && size.x >= size.z) {
    inner.rotation.y = Math.PI / 2;
    length = size.x;
  } else if (size.y >= size.x && size.y >= size.z) {
    inner.rotation.x = Math.PI / 2;
    length = size.y;
  }
  // Meshy profiles come out muzzle-toward-camera: flip so the barrel points -Z (downrange)
  inner.rotation.y += Math.PI;

  const s = targetLength / Math.max(length, 0.001);
  wrapper.scale.setScalar(s);

  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const m = mesh.material as THREE.MeshStandardMaterial;
      if (m && 'roughness' in m) m.roughness = Math.min(m.roughness ?? 1, 0.85);
    }
  });
  return wrapper;
}

/** Normalize the tank wreck: sit on ground, target footprint width. */
export async function loadTankModel(
  url: string,
  targetWidth: number,
): Promise<THREE.Group | null> {
  const scene = await loadGlb(url);
  countDiagnostics('tank', scene);
  if (!scene) return null;

  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const wrapper = new THREE.Group();
  wrapper.name = 'tank_imported';
  wrapper.add(scene);
  scene.position.sub(center);

  const footprint = Math.max(size.x, size.z);
  const s = targetWidth / Math.max(footprint, 0.001);
  wrapper.scale.setScalar(s);
  // lift so the bottom rests at y=0 of the wrapper
  scene.position.y += size.y / 2;

  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });
  return wrapper;
}
