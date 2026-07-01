import * as THREE from 'three';
import { BlockAtlas, TILE } from './BlockAtlas';
import type { MapLayout } from './MapBuilder';

/**
 * Instanced world dressing: supply crates, fuel barrels, barbed-wire posts.
 * All share the block atlas so the kit reads as one material language.
 */
export class PropsKit {
  readonly group = new THREE.Group();
  private disposables: Array<{ dispose(): void }> = [];

  constructor(atlas: BlockAtlas, layout: MapLayout) {
    this.group.name = 'props';

    const atlasMat = new THREE.MeshStandardMaterial({
      map: atlas.texture,
      roughness: 0.9,
      metalness: 0.05,
    });
    this.disposables.push(atlasMat);

    // --- crates -------------------------------------------------------------
    const crateGeo = PropsKit.tiledBox(atlas, 0.92, 0.92, 0.92, TILE.crate, TILE.crateTop);
    const crates = new THREE.InstancedMesh(crateGeo, atlasMat, layout.crates.length);
    crates.name = 'crates';
    PropsKit.fill(crates, layout.crates, 0.46);
    crates.castShadow = true;
    crates.receiveShadow = true;
    this.group.add(crates);
    this.disposables.push(crateGeo);

    // --- barrels --------------------------------------------------------------
    const barrelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.86, 10);
    PropsKit.projectCylinderUVs(barrelGeo, atlas, TILE.barrel, TILE.barrelTop);
    const barrels = new THREE.InstancedMesh(barrelGeo, atlasMat, layout.barrels.length);
    barrels.name = 'barrels';
    PropsKit.fill(barrels, layout.barrels, 0.43);
    barrels.castShadow = true;
    barrels.receiveShadow = true;
    this.group.add(barrels);
    this.disposables.push(barrelGeo);

    // --- barbed-wire posts ------------------------------------------------------
    const postGroupGeo = PropsKit.wirePostGeometry();
    const postMat = new THREE.MeshStandardMaterial({ color: 0x4a3a28, roughness: 0.95 });
    const posts = new THREE.InstancedMesh(postGroupGeo, postMat, layout.wirePosts.length);
    posts.name = 'wirePosts';
    PropsKit.fill(posts, layout.wirePosts, 0.55);
    posts.castShadow = true;
    this.group.add(posts);
    this.disposables.push(postGroupGeo, postMat);

    // wire strands between nearby posts
    const wireMat = new THREE.LineBasicMaterial({ color: 0x2c2c30 });
    const wirePts: THREE.Vector3[] = [];
    const placements = layout.wirePosts;
    for (let i = 0; i < placements.length; i++) {
      for (let j = i + 1; j < placements.length; j++) {
        const a = placements[i].position;
        const b = placements[j].position;
        if (a.distanceTo(b) < 7) {
          const mid = a.clone().lerp(b, 0.5);
          mid.y = Math.min(a.y, b.y) + 0.55;
          wirePts.push(
            a.clone().add(new THREE.Vector3(0, 0.9, 0)),
            mid.clone().add(new THREE.Vector3(0, 0.25, 0)),
            mid.clone().add(new THREE.Vector3(0, 0.25, 0)),
            b.clone().add(new THREE.Vector3(0, 0.9, 0)),
            a.clone().add(new THREE.Vector3(0, 0.45, 0)),
            b.clone().add(new THREE.Vector3(0, 0.45, 0)),
          );
        }
      }
    }
    if (wirePts.length > 0) {
      const wireGeo = new THREE.BufferGeometry().setFromPoints(wirePts);
      const wires = new THREE.LineSegments(wireGeo, wireMat);
      wires.name = 'barbedWire';
      this.group.add(wires);
      this.disposables.push(wireGeo, wireMat);
    }
  }

  private static fill(
    mesh: THREE.InstancedMesh,
    placements: MapLayout['crates'],
    yOffset: number,
  ): void {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const s = new THREE.Vector3();
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      q.setFromAxisAngle(up, p.rotationY);
      const scale = p.scale ?? 1;
      s.setScalar(scale);
      m.compose(
        new THREE.Vector3(p.position.x, p.position.y + yOffset * scale - 0.5 + 0.5, p.position.z),
        q,
        s,
      );
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Box with atlas tiles: sides one tile, top/bottom another. */
  static tiledBox(
    atlas: BlockAtlas,
    w: number,
    h: number,
    d: number,
    sideTile: number,
    topTile: number,
  ): THREE.BoxGeometry {
    const geo = new THREE.BoxGeometry(w, h, d);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const side = atlas.uv(sideTile as never);
    const top = atlas.uv(topTile as never);
    // BoxGeometry face order: px nx py ny pz nz — 4 uvs each
    for (let f = 0; f < 6; f++) {
      const t = f === 2 || f === 3 ? top : side;
      const coords: Array<[number, number]> = [
        [t.u0, t.v1],
        [t.u1, t.v1],
        [t.u0, t.v0],
        [t.u1, t.v0],
      ];
      for (let v = 0; v < 4; v++) {
        uv.setXY(f * 4 + v, coords[v][0], coords[v][1]);
      }
    }
    uv.needsUpdate = true;
    return geo;
  }

  private static projectCylinderUVs(
    geo: THREE.CylinderGeometry,
    atlas: BlockAtlas,
    sideTile: number,
    capTile: number,
  ): void {
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const side = atlas.uv(sideTile as never);
    const cap = atlas.uv(capTile as never);
    const normal = geo.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      const ny = normal.getY(i);
      const t = Math.abs(ny) > 0.9 ? cap : side;
      const u = uv.getX(i);
      const v = uv.getY(i);
      uv.setXY(i, t.u0 + (t.u1 - t.u0) * u, t.v0 + (t.v1 - t.v0) * v);
    }
    uv.needsUpdate = true;
  }

  private static wirePostGeometry(): THREE.BufferGeometry {
    // X-shaped cross post
    const a = new THREE.BoxGeometry(0.09, 1.5, 0.09);
    const b = new THREE.BoxGeometry(0.09, 1.5, 0.09);
    a.rotateZ(0.42);
    b.rotateZ(-0.42);
    a.translate(0, 0.6, 0);
    b.translate(0, 0.6, 0);
    const merged = PropsKit.mergeGeometries([a, b]);
    a.dispose();
    b.dispose();
    return merged;
  }

  private static mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
    // minimal merge for identical attribute layouts
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    let offset = 0;
    for (const g of geos) {
      const p = g.attributes.position;
      const n = g.attributes.normal;
      const u = g.attributes.uv;
      for (let i = 0; i < p.count; i++) {
        positions.push(p.getX(i), p.getY(i), p.getZ(i));
        normals.push(n.getX(i), n.getY(i), n.getZ(i));
        if (u) uvs.push(u.getX(i), u.getY(i));
      }
      const idx = g.index;
      if (idx) {
        for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + offset);
      }
      offset += p.count;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    if (uvs.length) out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    out.setIndex(indices);
    return out;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
