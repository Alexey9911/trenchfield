import * as THREE from 'three';
import { PropsKit } from '../world/PropsKit';
import { TILE, type BlockAtlas } from '../world/BlockAtlas';

export type PickupKind = 'medkit' | 'ammo';

interface Pickup {
  kind: PickupKind;
  mesh: THREE.Group;
  basePos: THREE.Vector3;
  active: boolean;
  respawnTimer: number;
}

const RESPAWN_TIME = 22;

/** Spinning field pickups: medkits + ammo caches with beacon glow. */
export class Pickups {
  private items: Pickup[] = [];
  readonly group = new THREE.Group();

  constructor(scene: THREE.Scene, atlas: BlockAtlas, spots: THREE.Vector3[]) {
    this.group.name = 'pickups';
    const mat = new THREE.MeshStandardMaterial({
      map: atlas.texture,
      roughness: 0.75,
      metalness: 0.1,
    });
    const medGeo = PropsKit.tiledBox(atlas, 0.55, 0.4, 0.55, TILE.medkit, TILE.medkit);
    const ammoGeo = PropsKit.tiledBox(atlas, 0.6, 0.42, 0.6, TILE.ammo, TILE.ammo);

    spots.forEach((spot, i) => {
      const kind: PickupKind = i % 2 === 0 ? 'medkit' : 'ammo';
      const mesh = new THREE.Group();
      const box = new THREE.Mesh(kind === 'medkit' ? medGeo : ammoGeo, mat);
      box.castShadow = true;
      box.position.y = 0.5;
      mesh.add(box);

      const beaconColor = kind === 'medkit' ? 0xe8dcc3 : 0xe8963f;
      const beacon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.16, 1.4, 6, 1, true),
        new THREE.MeshBasicMaterial({
          color: beaconColor,
          transparent: true,
          opacity: 0.16,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      beacon.position.y = 1.0;
      mesh.add(beacon);

      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(0.55, 16),
        new THREE.MeshBasicMaterial({
          color: beaconColor,
          transparent: true,
          opacity: 0.22,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.06;
      mesh.add(disc);

      mesh.position.copy(spot);
      this.group.add(mesh);
      this.items.push({ kind, mesh, basePos: spot.clone(), active: true, respawnTimer: 0 });
    });

    scene.add(this.group);
  }

  update(dt: number, elapsed: number, playerPos: THREE.Vector3): PickupKind | null {
    let collected: PickupKind | null = null;
    for (const item of this.items) {
      if (!item.active) {
        item.respawnTimer -= dt;
        if (item.respawnTimer <= 0) {
          item.active = true;
          item.mesh.visible = true;
        }
        continue;
      }
      item.mesh.rotation.y = elapsed * 1.4;
      item.mesh.position.y = item.basePos.y + Math.sin(elapsed * 2.2 + item.basePos.x) * 0.08;

      const d = playerPos.distanceTo(item.mesh.position);
      if (d < 1.15 && collected === null) {
        collected = item.kind;
        item.active = false;
        item.mesh.visible = false;
        item.respawnTimer = RESPAWN_TIME;
      }
    }
    return collected;
  }
}
