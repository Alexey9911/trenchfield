import * as THREE from 'three';
import type { BotArchetype } from '../game/constants';

export interface BotBody {
  root: THREE.Group;
  joints: {
    head: THREE.Group;
    armL: THREE.Group;
    armR: THREE.Group;
    legL: THREE.Group;
    legR: THREE.Group;
    torso: THREE.Group;
  };
  flashables: THREE.MeshStandardMaterial[];
  nameSprite: THREE.Sprite;
  height: number;
}

const S = 1.9 / 32; // one "pixel" in world units for a ~1.9m tall soldier

function box(
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w * S, h * S, d * S), mat);
  m.position.set(x * S, y * S, z * S);
  m.castShadow = true;
  return m;
}

function faceTexture(skin: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 8;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = skin;
    ctx.fillRect(0, 0, 8, 8);
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(1, 3, 2, 1); // eyes
    ctx.fillRect(5, 3, 2, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(3, 5, 2, 1); // mouth shadow
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function nameTexture(name: string, color: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 48;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, 256, 48);
    ctx.font = 'bold 26px "Barlow Semi Condensed", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(12,12,16,0.55)';
    const w = ctx.measureText(name).width + 22;
    ctx.beginPath();
    ctx.roundRect(128 - w / 2, 6, w, 34, 6);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(name, 128, 24);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createBotBody(archetype: BotArchetype, name: string): BotBody {
  const root = new THREE.Group();
  root.name = `bot_${name}`;

  const cloth = new THREE.MeshStandardMaterial({ color: archetype.cloth, roughness: 0.92 });
  const clothDark = new THREE.MeshStandardMaterial({ color: archetype.clothDark, roughness: 0.94 });
  const helmetMat = new THREE.MeshStandardMaterial({
    color: archetype.helmet,
    roughness: 0.55,
    metalness: 0.35,
  });
  const skinHex = `#${archetype.skin.toString(16).padStart(6, '0')}`;
  const skin = new THREE.MeshStandardMaterial({ color: archetype.skin, roughness: 0.85 });
  const face = new THREE.MeshStandardMaterial({
    map: faceTexture(skinHex),
    roughness: 0.85,
  });
  const gunMetal = new THREE.MeshStandardMaterial({
    color: 0x2e2e33,
    roughness: 0.5,
    metalness: 0.55,
  });
  const gunWood = new THREE.MeshStandardMaterial({ color: 0x5c4128, roughness: 0.8 });
  const leather = new THREE.MeshStandardMaterial({ color: 0x3f3226, roughness: 0.9 });

  const flashables = [cloth, clothDark, helmetMat, skin, face];

  // --- legs (pivot at hip, y=12px) ---
  const legL = new THREE.Group();
  legL.position.set(-2 * S, 12 * S, 0);
  legL.add(box(4, 12, 4, clothDark, 0, -6, 0));
  const bootL = box(4, 2, 5, leather, 0, -11, 0.5);
  legL.add(bootL);

  const legR = new THREE.Group();
  legR.position.set(2 * S, 12 * S, 0);
  legR.add(box(4, 12, 4, clothDark, 0, -6, 0));
  legR.add(box(4, 2, 5, leather, 0, -11, 0.5));

  // --- torso group (pivot at hip) ---
  const torso = new THREE.Group();
  torso.position.set(0, 12 * S, 0);

  torso.add(box(8, 12, 4, cloth, 0, 6, 0));
  // webbing straps + belt
  torso.add(box(8.4, 1.6, 4.4, leather, 0, 1.2, 0));
  torso.add(box(2, 10, 4.6, leather, -2.4, 6.4, 0));
  // backpack
  torso.add(box(6, 7, 3, clothDark, 0, 7, -3.4));

  if (archetype.id === 'shock') {
    // armor chest plate
    torso.add(box(8.6, 6, 4.8, helmetMat, 0, 8, 0.2));
  }
  if (archetype.id === 'scout') {
    // bedroll on the pack
    torso.add(box(8.5, 2.4, 2.4, cloth, 0, 11.4, -3.4));
  }

  // --- head (pivot at neck, y=24px) ---
  const head = new THREE.Group();
  head.position.set(0, 24 * S, 0);
  const skull = new THREE.Mesh(new THREE.BoxGeometry(8 * S, 8 * S, 8 * S), [
    skin, skin, skin, skin, face, skin,
  ]);
  skull.position.y = 4 * S;
  skull.castShadow = true;
  head.add(skull);

  if (archetype.id === 'shock') {
    // stahlhelm: dome + neck skirt
    head.add(box(9.4, 3.4, 9.4, helmetMat, 0, 8.4, 0));
    head.add(box(10.4, 2, 10.4, helmetMat, 0, 6.6, -0.4));
  } else if (archetype.id === 'scout') {
    // soft cap
    head.add(box(8.8, 2.2, 8.8, cloth, 0, 8.6, 0));
    head.add(box(3.4, 1, 9.8, cloth, 0, 7.8, 1));
  } else {
    // brodie: shallow dome + wide brim
    head.add(box(8.8, 2.6, 8.8, helmetMat, 0, 9, 0));
    head.add(box(11.4, 1, 11.4, helmetMat, 0, 7.8, 0));
  }

  // --- arms (pivot at shoulder, y=22px) ---
  const armL = new THREE.Group();
  armL.position.set(-6 * S, 22 * S, 0);
  armL.add(box(4, 12, 4, cloth, 0, -5, 0));
  armL.add(box(3.4, 3, 3.4, skin, 0, -10.6, 0));

  const armR = new THREE.Group();
  armR.position.set(6 * S, 22 * S, 0);
  armR.add(box(4, 12, 4, cloth, 0, -5, 0));
  armR.add(box(3.4, 3, 3.4, skin, 0, -10.6, 0));

  // rifle in right hand
  const gun = new THREE.Group();
  const barrel = box(1.6, 1.6, 14, gunMetal, 0, 0, -6);
  const stock = box(2, 3, 6, gunWood, 0, -0.6, 3);
  const mag = box(1.8, 3.4, 2, gunMetal, 0, -2.4, -1);
  gun.add(barrel, stock, mag);
  gun.position.set(0, -10.5 * S, -2 * S);
  if (archetype.id === 'shock') {
    // wider scattergun
    barrel.scale.set(1.6, 1.6, 0.8);
    stock.scale.set(1.3, 1.2, 1);
  }
  armR.add(gun);

  root.add(legL, legR, torso, head, armL, armR);

  // name tag
  const archColor =
    archetype.id === 'shock' ? '#e08a5a' : archetype.id === 'scout' ? '#d8c690' : '#c9cf9a';
  const nameSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: nameTexture(name, archColor), depthWrite: false }),
  );
  nameSprite.scale.set(1.6, 0.3, 1);
  nameSprite.position.y = 34 * S;
  root.add(nameSprite);

  return {
    root,
    joints: { head, armL, armR, legL, legR, torso },
    flashables,
    nameSprite,
    height: 32 * S,
  };
}
