import * as THREE from 'three';

/** A two-bone "leg" standing 2 units tall that swings at the hip, with a looping walk and a death that tips it over. */
export function tinyRig() {
  const root = new THREE.Bone();
  root.name = 'Hips';
  const head = new THREE.Bone();
  head.name = 'Head';
  head.position.set(0, 1, 0);
  root.add(head);
  const geo = new THREE.BoxGeometry(0.4, 2, 0.4, 1, 2, 1).translate(0, 1, 0);
  const n = geo.attributes.position.count;
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const top = geo.attributes.position.getY(i) > 1.5;
    si[i * 4] = top ? 1 : 0;
    sw[i * 4] = 1;
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
  mesh.add(root);
  mesh.bind(new THREE.Skeleton([root, head]));
  const scene = new THREE.Group();
  scene.add(mesh);
  const q = (x: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), x).toArray();
  const walk = new THREE.AnimationClip('walk', 1, [new THREE.QuaternionKeyframeTrack('Head.quaternion', [0, 0.5, 1], [...q(0.3), ...q(-0.3), ...q(0.3)])]);
  const idle = new THREE.AnimationClip('idle', 1, [new THREE.QuaternionKeyframeTrack('Head.quaternion', [0, 1], [...q(0), ...q(0)])]);
  const death = new THREE.AnimationClip('death', 0.5, [new THREE.QuaternionKeyframeTrack('Hips.quaternion', [0, 0.5], [...q(0), ...q(-Math.PI / 2)])]);
  return { scene, animations: [walk, idle, death] };
}

