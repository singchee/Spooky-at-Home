import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MODEL_HEIGHT, bakeModel, boneRegion, loadCharacterModels, materialRegion } from '../src/render/characterModels';
import { ModelBatch, clipRows } from '../src/render/modelShader';

/** A two-bone "leg" standing 2 units tall that swings at the hip, with a looping walk and a death that tips it over. */
function tinyRig() {
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

describe('baked character models (vertex animation textures)', () => {
  const m = bakeModel('tiny', tinyRig(), ['walk', 'idle']);

  it('one texture row per frame: loops wrap, the death clip holds its last frame', () => {
    expect(m.clips.walk.frames).toBe(30);
    expect(m.clips.death.frames).toBe(16); // 0.5 s at 30 fps, both ends
    expect(m.pos.image.height).toBe(m.clips.walk.frames + m.clips.idle.frames + m.clips.death.frames);
    expect(m.pos.image.width).toBe(m.vertices + 2); // + head-top and chest points
    expect(m.pos.type).toBe(THREE.HalfFloatType);
  });

  it('is scaled to real human height, feet on the ground, centred', () => {
    const P = m.points;
    const r = m.clips.idle.row;
    expect(P[r * 6 + 1]).toBeCloseTo(MODEL_HEIGHT / 2 + 0.12, 3); // the head point: 0.12 m above the head bone (mid-height in this rig)
    const bind = m.geometry.attributes.position;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < bind.count; i++) {
      lo = Math.min(lo, bind.getY(i));
      hi = Math.max(hi, bind.getY(i));
    }
    expect(lo).toBeCloseTo(0, 5);
    expect(hi).toBeCloseTo(MODEL_HEIGHT, 5);
  });

  it('knows which way the death clip falls (here: toward -z, backward)', () => {
    expect(Math.cos(m.deathDir)).toBeLessThan(-0.9);
  });

  it('heat weights come from the bones: head is the hot core, the rest cooler', () => {
    const w = m.geometry.attributes.aHeatW;
    const vals = new Set(Array.from(w.array as Float32Array));
    expect(vals.has(0)).toBe(true); // head
    expect(Math.max(...vals)).toBeGreaterThan(0.5); // hips/body
  });

  it('draws as one instanced batch, and survivors get the 4-corner cold ID panel', () => {
    const z = new ModelBatch(m, 'zombie', 300);
    const s = new ModelBatch(m, 'survivor', 32);
    expect(s.cost.vertices).toBe(z.cost.vertices + 4);
    expect(s.cost.triangles).toBe(z.cost.triangles + 2);
    expect(z.mesh.geometry.getAttribute('iA')).toBeInstanceOf(THREE.InstancedBufferAttribute);
    z.dispose();
    s.dispose();
  });

  it('clipRows: loops wrap around, one-shot clips clamp at their last frame', () => {
    const loop = { row: 10, frames: 30, duration: 1, loop: true, fps: 30 };
    expect(clipRows(loop, 0)).toEqual([10, 11, 0]);
    expect(clipRows(loop, 1.0)[0]).toBe(10);
    const [a, b] = clipRows(loop, 29.5 / 30);
    expect([a, b]).toEqual([39, 10]);
    const once = { row: 0, frames: 16, duration: 0.5, loop: false, fps: 30 };
    expect(clipRows(once, 99)).toEqual([15, 15, 0]);
  });
});

describe('regions for heat and night vision', () => {
  it('bones: head hottest, hands and feet coolest', () => {
    expect(boneRegion('Head').heatW).toBe(0);
    expect(boneRegion('Torso').heatW).toBeLessThan(boneRegion('LowerArm.L').heatW);
    expect(boneRegion('Foot.R').heatW).toBe(1);
    expect(boneRegion('Index2.L').region).toBe(0); // hands are skin
  });
  it('material names: skin, clothes, hair', () => {
    expect(materialRegion('Skin')).toBe(0);
    expect(materialRegion('Shirt')).toBe(1);
    expect(materialRegion('Pants')).toBe(2);
    expect(materialRegion('Socks')).toBe(3);
    expect(materialRegion('Hair')).toBe(4);
    expect(materialRegion('Atlas')).toBeNull();
  });
});

describe('loading', () => {
  it('with no browser (tests, headless sim) it resolves to null: the procedural figures stay', async () => {
    expect(await loadCharacterModels()).toBeNull();
  });
});
